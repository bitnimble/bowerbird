import { action, runInAction } from 'mobx';
import { api } from '../../api/client';
import type { PhotoSummary, Triage } from '../../api/client';
import type { PhotosPresenter } from './photos_presenter';
import type { StackTriageStore } from './stack_triage_store';
import { type Verdict, applyVerdict, keepers, losersOf, openSession, stop } from './stack_triage';
import {
  type HistoryEntry,
  type TriageMode,
  clearOutcome,
  clearSession,
  loadOutcome,
  loadSession,
  saveMode,
  saveOutcome,
  saveSession,
} from './triage_storage';

// The only writer of StackTriageStore (DESIGN §20).
//
// Every triage write goes through PhotosPresenter rather than into PhotosStore,
// so the gallery behind the session keeps its rows correct and the single-writer
// rule holds across the domain boundary.
export class StackTriagePresenter {
  constructor(
    private readonly store: StackTriageStore,
    private readonly photos: PhotosPresenter,
  ) {}

  // --- opening ---

  async open(stackId: string, entryPhotoId: string | null): Promise<void> {
    // Already running this one: navigating back to the viewer and forward again
    // must reuse the live session rather than reloading a copy of it and
    // discarding the history in memory.
    if (this.store.stackId === stackId && this.store.session != null) return;

    runInAction(() => {
      this.store.stackId = stackId;
      this.store.session = null;
      this.store.history = [];
      this.store.failed = new Set();
      this.store.loadError = null;
      this.store.members = new Map();
      if (entryPhotoId != null) this.store.entryPhotoId = entryPhotoId;
    });

    let members: PhotoSummary[];
    try {
      members = await api.listStackPhotos(stackId);
    } catch (err) {
      runInAction(() => (this.store.loadError = err instanceof Error ? err.message : String(err)));
      return;
    }
    // A double mount, or a quick switch to another stack, must not let the
    // earlier answer overwrite the session that has since been set up. One
    // comparison rather than a generation counter: nothing here moves under the
    // fetch the way a collection's rows do.
    if (this.store.stackId !== stackId) return;

    // Deleted members are excluded server-side; missing ones are dropped here,
    // and before the count that decides `too-few` - a stack of two with one
    // missing is nothing to compare, not a tournament of one.
    const usable = members.filter((photo) => !photo.is_missing);
    const stored = loadSession(stackId);

    runInAction(() => {
      this.store.members = new Map(usable.map((photo) => [photo.id, photo]));
      this.store.baseline =
        stored == null
          ? new Map(usable.map((photo) => [photo.id, photo.triage]))
          : // Never re-read from the rows: a rehydrate re-fetches them and they
            // carry this session's own rejections, so restoring against them
            // would put a photo back in the pool and mark it rejected at once.
            new Map(Object.entries(stored.baseline) as [string, Triage][]);
      this.store.entryPhotoId = entryPhotoId ?? stored?.entryPhotoId ?? null;

      if (stored == null) {
        this.store.session = openSession(usable.map((photo) => photo.id));
        this.store.history = [];
        return;
      }

      // Pruned, never re-derived. Re-deriving the pool from the member list would
      // return every eliminated photo to contention having already lost. `seen`
      // is deliberately left alone: a pair naming a photo that has gone can never
      // be offered again, and dropping it would demote a considered keeper out of
      // the closing `picked` write.
      const live = new Set(usable.map((photo) => photo.id));
      this.store.session = { ...stored.session, alive: stored.session.alive.filter((id) => live.has(id)) };
      this.store.history = stored.history;
    });
    this.persist();
  }

  // --- verdicts ---

  @action.bound
  setShowing(showing: 'a' | 'b'): void {
    this.store.showing = showing;
  }

  @action.bound
  setMode(mode: TriageMode): void {
    this.store.mode = mode;
    saveMode(mode);
  }

  @action.bound
  setSplitBox(width: number, height: number): void {
    this.store.splitWidth = width;
    this.store.splitHeight = height;
  }

  async judge(verdict: Verdict): Promise<void> {
    const session = this.store.session;
    const round = this.store.round;
    if (session == null || round == null || this.store.busy) return;

    const before: HistoryEntry = { session, showing: this.store.showing, choice: verdict, changed: [] };
    const next = applyVerdict(session, round, verdict);

    runInAction(() => {
      this.store.busy = true;
      this.store.session = next;
      this.store.history = [...this.store.history, before];
      // The slot is kept when slot A holds the same photo it just held, and reset
      // to A when it does not: voting while looking at the challenger opens the
      // next round still on the challenger, which is the one photo of the two not
      // yet seen.
      const after = this.store.round;
      if (after == null || after.a !== round.a) this.store.showing = 'a';
    });

    await this.writeAll(losersOf(round, verdict), 'rejected');
    await this.settleIfOver();
    runInAction(() => (this.store.busy = false));
    this.persist();
  }

  async keepTheRest(): Promise<void> {
    const session = this.store.session;
    if (session == null || session.stopped || this.store.busy) return;
    const before: HistoryEntry = { session, showing: this.store.showing, choice: 'stopped', changed: [] };

    runInAction(() => {
      this.store.busy = true;
      this.store.session = stop(session);
      this.store.history = [...this.store.history, before];
    });

    await this.settleIfOver();
    runInAction(() => (this.store.busy = false));
    this.persist();
  }

  // The closing writes belong to the action that ended the session, not to an
  // entry of their own: a natural end changes no field of the session, so its own
  // entry would restore a state for which there is still no round, and undo from
  // the summary would land back on the summary it was pressed from.
  private async settleIfOver(): Promise<void> {
    const session = this.store.session;
    if (session == null || this.store.round != null) return;
    // Only survivors that appear in some judged pair. One that never reached the
    // screen - which Keep the rest can leave, and `Neither` can leave by emptying
    // the pool around it - is left exactly as it was, rather than claimed as a
    // considered keeper.
    await this.writeAll(keepers(session), 'picked');

    const stackId = this.store.stackId;
    if (stackId == null) return;
    const outcome = this.store.outcome;
    saveOutcome(stackId, {
      kept: outcome.kept.map((photo) => photo.id),
      rejected: outcome.rejected.map((photo) => photo.id),
      unsaved: outcome.unsaved.map((photo) => photo.id),
    });
    // Only once every closing write has landed, or a reload would find no session
    // and start a fresh tournament over photographs it had just judged.
    clearSession(stackId);
    // The gallery behind the session filters on triage, so it is one re-read on
    // the way out rather than one per verdict.
    void this.photos.reload();
  }

  // --- undo, and the queue ---

  /**
   * Put the session back as it stood before entry `i`, and forget everything
   * after it.
   *
   * Truncating is not bookkeeping. Without it the abandoned branch stays
   * reachable: rewind to round 0, judge it differently, then undo twice, and the
   * second undo restores a pool from the branch that was thrown away, with photos
   * missing from it that no write ever rejected. It is safe because the writes
   * below have already put every one of those photos back.
   */
  async rewindTo(index: number): Promise<void> {
    const history = this.store.history;
    if (index < 0 || index >= history.length || this.store.busy) return;
    const entry = history[index];
    if (entry == null) return;

    // Deduplicated, so a photo written by three of the entries being undone is
    // restored once - and to a value that does not depend on which entry named
    // it, since every restore targets the same baseline.
    const touched = new Set(history.slice(index).flatMap((held) => held.changed));

    runInAction(() => {
      this.store.busy = true;
      this.store.session = entry.session;
      this.store.showing = entry.showing;
      this.store.history = history.slice(0, index);
      // The failures being undone are no longer anything to report.
      this.store.failed = new Set([...this.store.failed].filter((id) => !touched.has(id)));
    });

    for (const photoId of touched) {
      const target = this.store.baseline.get(photoId);
      if (target != null) await this.writeOne(photoId, target);
    }

    const stackId = this.store.stackId;
    if (stackId != null) clearOutcome(stackId);
    runInAction(() => (this.store.busy = false));
    this.persist();
  }

  undo(): Promise<void> {
    return this.rewindTo(this.store.history.length - 1);
  }

  /** Try the writes that did not land, without touching the tournament. */
  async retryFailed(): Promise<void> {
    const session = this.store.session;
    if (session == null || this.store.busy) return;
    const alive = new Set(session.alive);
    const kept = new Set(keepers(session));

    runInAction(() => (this.store.busy = true));
    for (const photoId of this.store.failed) {
      // What the session says this photo should be, which is what the write that
      // failed was trying to say.
      const target: Triage = !alive.has(photoId) ? 'rejected' : kept.has(photoId) ? 'picked' : (this.store.baseline.get(photoId) ?? 'untriaged');
      await this.writeOne(photoId, target);
    }
    runInAction(() => (this.store.busy = false));
    this.persist();
  }

  // --- writes ---

  // Recorded in the entry at *issue* time rather than on landing: undo pressed on
  // the summary while a closing `picked` is still in flight would otherwise build
  // its restore list without that photo, and the write would land after the
  // rewind, into a session that had resumed.
  private async writeAll(photoIds: string[], triage: Triage): Promise<void> {
    if (photoIds.length === 0) return;
    runInAction(() => {
      const history = [...this.store.history];
      const last = history[history.length - 1];
      if (last != null) {
        history[history.length - 1] = { ...last, changed: [...last.changed, ...photoIds] };
        this.store.history = history;
      }
    });
    for (const photoId of photoIds) await this.writeOne(photoId, triage);
  }

  // A failure is reported, never compensated. Both directions are already safe -
  // a failed `rejected` leaves the photo untriaged, which destroys nothing, and a
  // failed restore is self-healing - where rewinding would discard every verdict
  // after the failed round to make up for a write that under-applied, and the
  // compensating write would travel the same failing path.
  private async writeOne(photoId: string, triage: Triage): Promise<void> {
    const landed = await this.photos.setTriage(photoId, triage, { quiet: true });
    runInAction(() => {
      const failed = new Set(this.store.failed);
      if (landed) failed.delete(photoId);
      else failed.add(photoId);
      this.store.failed = failed;
    });
  }

  // --- storage ---

  private persist(): void {
    const stackId = this.store.stackId;
    const session = this.store.session;
    if (stackId == null || session == null) return;
    // A finished session is stored as its outcome instead, by `settleIfOver`.
    if (this.store.round == null) return;
    saveSession(stackId, {
      session,
      history: this.store.history,
      baseline: Object.fromEntries(this.store.baseline),
      entryPhotoId: this.store.entryPhotoId,
    });
  }

  /** What a finished session left behind, for a reload that lands on the summary. */
  storedOutcome(stackId: string): ReturnType<typeof loadOutcome> {
    return loadOutcome(stackId);
  }
}
