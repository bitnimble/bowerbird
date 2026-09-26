import { action, runInAction } from 'mobx';
import { stacksApi } from '../../../api/stacks';
import { type Ordering, type ProcessingStage } from '../../../../../src/schemas/common';
import { type PhotoSummary, type Triage } from '../../../../../src/schemas/photos';
import type { PhotosPresenter } from '../photos_presenter';
import type { StackTriageStore } from './stack_triage_store';
import { StackTriageStrings } from './stack_triage_page.strings';
import { type Verdict, applyVerdict, keepers, losersOf, nextRound, openSession, stop } from './stack_triage';
import { type HistoryEntry, type TriageMode, clearSession, loadMode, loadSession, saveMode, saveSession } from './triage_storage';

// The only writer of StackTriageStore (DESIGN §20).
//
// Every triage write goes through PhotosPresenter rather than into the photo stores,
// so the gallery behind the session keeps its rows correct and the single-writer
// rule holds across the domain boundary.
export class StackTriagePresenter {
  constructor(
    private readonly store: StackTriageStore,
    private readonly photos: PhotosPresenter,
  ) {}

  // --- opening ---

  /**
   * Where to go when the session is over: the first of the stack's survivors in the
   * collection's own order, which is the frame the judging was towards. Not the
   * photograph the session was entered from - a decisive session usually rejects
   * it, and a rejected photo has left the gallery's filter, so the viewer could
   * say nothing about what came before or after it and both arrows would be dead.
   * Mid-session that photograph *is* the answer: leaving half-done should put the
   * reader back exactly where they were.
   *
   * Asked for as the range between the photographs the stack lies between, rather
   * than worked out here. The server already knows which end of its ordering is
   * "after"; a second answer to that on this side is one that can disagree.
   */
  async returnTarget(): Promise<string | null> {
    const session = this.store.session;
    const stackId = this.store.stackId;
    if (session == null || stackId == null) return this.store.entryPhotoId;
    // Mid-session: nothing has been concluded, so go back where you were.
    if (this.store.round != null) return this.store.entryPhotoId;

    const { from, to } = this.store.bounds;
    if (from != null || to != null) {
      try {
        const run = await this.photos.rangeBetween(from, to);
        // The first row still belonging to this stack. By stack id rather than by
        // counting in from the bound, so an open end - a stack at the very start
        // of the collection - needs no separate case.
        const first = run.find((photo) => photo.stack_id === stackId);
        if (first != null) return first.id;
      } catch {
        // Fall through to what is already in hand.
      }
    }
    // No bounds to ask with - a reload, or a stack at both ends of the collection.
    return this.store.session?.alive[0] ?? null;
  }

  /**
   * @param ordering the collection's, so the pool is seeded in the order the band the
   * session was opened from is listed in and the viewer steps through.
   * @param shootId the shoot the session is nested under, whose hiding its own members are exempt
   * from - without it, a stack on a hidden shoot's page seeds a session with none of its frames
   * (§12.4).
   */
  async open(
    stackId: string,
    entryPhotoId: string | null,
    ordering: Ordering,
    shootId: string | undefined,
    bounds?: { from: string | null; to: string | null },
  ): Promise<void> {
    // Already running this one: navigating back to the viewer and forward again
    // must reuse the live session rather than reloading a copy of it and
    // discarding the history in memory. A session with no round left is not
    // running - it is one the reader has already finished, and opening the stack
    // again is asking to judge it again.
    if (this.store.stackId === stackId && this.store.session != null && this.store.round != null) return;

    runInAction(() => {
      this.store.stackId = stackId;
      this.store.session = null;
      this.store.history = [];
      this.store.failed = new Set();
      this.store.loadError = null;
      this.store.members = new Map();
      // Or a session left mid-write by the stack before this one would swallow
      // the first verdict of this one, silently, since the keyboard has no
      // disabled state to show for it.
      this.store.busy = false;
      this.store.showing = 'a';
      this.store.swapped = false;
      this.store.frames = new Map();
      this.store.mode = loadMode();
      // Or the previous stack's ends are used for this one's jump out - and
      // `persist()` stamps them onto this session, so a reload keeps them.
      this.store.bounds = { from: null, to: null };
      if (entryPhotoId != null) this.store.entryPhotoId = entryPhotoId;
      if (bounds != null && (bounds.from != null || bounds.to != null)) this.store.bounds = bounds;
    });

    let members: PhotoSummary[];
    try {
      members = await stacksApi.listPhotos(stackId, { ordering, shootId });
    } catch {
      runInAction(() => (this.store.loadError = StackTriageStrings.couldNotOpenTheStack()));
      return;
    }
    // A double mount, or a quick switch to another stack, must not let the
    // earlier answer overwrite the session that has since been set up. One
    // comparison rather than a generation counter: nothing here moves under the
    // fetch the way a collection's rows do.
    if (this.store.stackId !== stackId) return;

    // Deleted members are excluded server-side; missing ones are dropped here (an offloaded one is
    // on its backup, not missing),
    // and before the count that decides `too-few` - a stack of two with one
    // missing is nothing to compare, not a tournament of one.
    const usable = members.filter((photo) => !photo.is_missing || photo.is_offloaded);
    const stored = loadSession(stackId);
    const live = new Set(usable.map((photo) => photo.id));
    // Pruned, never re-derived. Re-deriving the pool from the member list would
    // return every eliminated photo to contention having already lost. `seen`
    // is deliberately left alone: a pair naming a photo that has gone can never
    // be offered again, and dropping it would demote a considered keeper out of
    // the closing `picked` write.
    const resumed = stored == null ? null : { ...stored.session, alive: stored.session.alive.filter((id) => live.has(id)) };

    runInAction(() => {
      this.store.members = new Map(usable.map((photo) => [photo.id, photo]));
      this.store.entryPhotoId = entryPhotoId ?? stored?.entryPhotoId ?? null;
      if (stored?.bounds != null && this.store.bounds.from == null && this.store.bounds.to == null) {
        this.store.bounds = stored.bounds;
      }

      // A stored session with no round left is one the reader has already
      // finished - a reload caught between the closing writes and the key being
      // dropped. Restored, the screen would send them straight back out to the
      // viewer, which is a stack that can never be opened again.
      if (stored == null || resumed == null || nextRound(resumed) == null) {
        this.store.baseline = new Map(usable.map((photo) => [photo.id, photo.triage]));
        this.store.session = openSession(usable.map((photo) => photo.id));
        this.store.history = [];
        return;
      }

      // Never re-read from the rows: a rehydrate re-fetches them and they carry
      // this session's own rejections, so restoring against them would put a
      // photo back in the pool and mark it rejected at once.
      this.store.baseline = new Map(Object.entries(stored.baseline) as [string, Triage][]);
      this.store.session = resumed;
      this.store.history = stored.history;
      // Restored, not merely parsed: this is the only record that a verdict never
      // reached the server, and `persist()` at the end of this method would
      // otherwise write the empty set back over it. Pruned like the pool, because
      // a failure naming a photograph that has since left has nothing to retry.
      this.store.failed = new Set(stored.failed.filter((id) => live.has(id)));
      // A member that is gone is not a rejection, so it is not left in the
      // baseline as one: a photo that went missing mid-session would otherwise be
      // restored to a verdict the server never recorded.
      for (const id of stored.session.alive) if (!live.has(id)) this.store.baseline.delete(id);
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

  // The shape a frame actually decoded at, which both presentations lay their
  // boxes out from once they know it.
  @action.bound
  noteFrame(photoId: string, width: number, height: number): void {
    if (width === 0 || height === 0) return;
    this.store.frames.set(photoId, { width, height });
  }

  @action.bound
  setStageBox(width: number, height: number): void {
    this.store.stageWidth = width;
    this.store.stageHeight = height;
  }

  // The server has rewritten a file one of this session's members is drawn from. Its rows
  // are read once when the session opens and then held, so the stamp that moves the URL on
  // has to be written here too - the gallery's copy of the same row is a different object.
  @action.bound
  renditionsRebuilt(photoId: string, stage: ProcessingStage, version: string): void {
    const member = this.store.members.get(photoId);
    if (member == null) return;
    member[stage === 'tile' ? 'tile_built_at' : 'renditions_built_at'] = version;
    // Shallow, so the row object is not observed field by field: the map is what the frames
    // are read through, and it has to be told that one of its values moved.
    this.store.members.set(photoId, { ...member });
  }

  /** @param verdict names a *drawn* side: `a` is the photo on the left, whichever slot of the round it holds. */
  async judge(verdict: Verdict): Promise<void> {
    const session = this.store.session;
    const round = this.store.round;
    const drawn = this.store.sides;
    if (session == null || round == null || drawn == null || this.store.busy) return;

    const chose = this.slotOf(verdict);
    const before: HistoryEntry = { session, showing: this.store.showing, choice: chose, changed: [] };
    const next = applyVerdict(session, round, chose);

    runInAction(() => {
      this.store.busy = true;
      this.store.session = next;
      this.store.history = [...this.store.history, before];
      this.holdSides(drawn);
      // Kept whenever a photograph carried over, which the sides above have just
      // left where it was: the reader looking at the winner keeps looking at it,
      // and the one looking at the loser's half is shown the challenger that
      // replaced it - the one photo of the two not yet seen.
      const after = this.store.sides;
      if (after == null || !after.some((id) => drawn.includes(id))) this.store.showing = 'a';
    });

    const stackId = this.store.stackId;
    await this.writeAll(losersOf(round, chose), 'rejected');
    await this.settleIfOver();
    this.finish(stackId);
  }

  // A verdict names a side of the screen; the tournament names slots of a round,
  // and the two part company as soon as a winner holds the side it won on.
  private slotOf(verdict: Verdict): Verdict {
    if (!this.store.swapped || verdict === 'both' || verdict === 'neither') return verdict;
    return verdict === 'a' ? 'b' : 'a';
  }

  /**
   * Draws the round so that a photograph carried over from `drawn` stays where it
   * is.
   *
   * The one thing that does not change is the only cue for what did: with the
   * winner moved to the pool's front, half the decisive verdicts otherwise slid
   * the kept photograph across the screen and put the new one where it had been,
   * which reads as both halves being replaced.
   *
   * At most one photo can carry over - a pair is never offered twice - so the two
   * tests below cannot disagree.
   *
   * Nothing drawn leaves the sides as they are rather than squaring them up: a
   * session ends with no round on screen, and the sides already held are the ones
   * the round an undo brings back was drawn with.
   */
  private holdSides(drawn: [string, string] | null): void {
    const round = this.store.round;
    if (round == null || drawn == null) return;
    this.store.swapped = round.a === drawn[1] || round.b === drawn[0];
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

    const stackId = this.store.stackId;
    await this.settleIfOver();
    this.finish(stackId);
  }

  /**
   * Ends an action that may have outlived the session it belongs to.
   *
   * Every one of these awaits a write, and the photographer can leave for another
   * stack in the meantime. Without the check the tail of the old session releases
   * the new one's `busy` - swallowing its first verdict, silently, because the
   * keyboard has no disabled state to show - and stores the old session's history
   * under the new one's key.
   */
  private finish(stackId: string | null): void {
    if (this.store.stackId !== stackId) return;
    runInAction(() => (this.store.busy = false));
    // Nothing is offered any more, so there is no session to come back to: the
    // screen leaves for the viewer the moment this lands, and what a stored one
    // would do on the way back in is send the reader out again.
    if (stackId != null && this.store.round == null) clearSession(stackId);
    else this.persist();
  }

  // The closing writes belong to the action that ended the session, not to an
  // entry of their own: a natural end changes no field of the session, so its own
  // entry would restore a state for which there is still no round, and undoing it
  // would end the session again.
  private async settleIfOver(): Promise<void> {
    const session = this.store.session;
    if (session == null || this.store.round != null) return;
    // Only survivors that appear in some judged pair. One that never reached the
    // screen - which Keep the rest can leave, and `Neither` can leave by emptying
    // the pool around it - is left exactly as it was, rather than claimed as a
    // considered keeper.
    await this.writeAll(keepers(session), 'picked');
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
    const drawn = this.store.sides;

    runInAction(() => {
      this.store.busy = true;
      this.store.session = entry.session;
      this.store.showing = entry.showing;
      // A rewind puts a photograph back on screen as readily as a verdict does,
      // and it belongs on the side it is on now rather than on the side it was on
      // however many rounds ago.
      this.holdSides(drawn);
      this.store.history = history.slice(0, index);
      // The failures being undone are no longer anything to report.
      this.store.failed = new Set([...this.store.failed].filter((id) => !touched.has(id)));
    });

    const stackId = this.store.stackId;
    for (const photoId of touched) {
      const target = this.store.baseline.get(photoId);
      if (target != null) await this.writeOne(photoId, target);
    }
    this.finish(stackId);
  }

  undo(): Promise<void> {
    return this.rewindTo(this.store.history.length - 1);
  }

  /**
   * Rewinds to a particular entry rather than to whatever now sits at a position.
   *
   * For a caller that captured its entry earlier and may fire much later - the
   * Neither toast lives twelve seconds, outlives the route, and the presenter and
   * the toasts are app-lifetime, so by then the index it took may name a different
   * round of a different stack. `history` holds the entries by reference, so an
   * entry from a session that has been reloaded is correctly not found.
   */
  rewindToEntry(entry: HistoryEntry): Promise<void> {
    const index = this.store.history.indexOf(entry);
    return index < 0 ? Promise.resolve() : this.rewindTo(index);
  }

  /**
   * Try the writes that did not land, without touching the tournament.
   *
   * Against the stack it was offered for, not whatever is open now: the offer
   * outlives the route - it is a toast, raised as the session leaves for the
   * viewer - and by the time it is pressed the store may be holding another
   * stack, whose `failed` set this would otherwise walk and write into.
   */
  async retryFailed(stackId: string): Promise<void> {
    const session = this.store.session;
    if (session == null || this.store.stackId !== stackId || this.store.busy) return;
    const alive = new Set(session.alive);
    const kept = new Set(keepers(session));

    // Read before the first await, or a session opened in the meantime answers
    // for photographs this one is still writing.
    const baseline = new Map(this.store.baseline);
    runInAction(() => (this.store.busy = true));
    // The set is read once here; `writeOne` replaces it rather than mutating it,
    // so the loop walks the failures as they were when the retry started.
    for (const photoId of this.store.failed) {
      // What the session says this photo should be, which is what the write that
      // failed was trying to say.
      const target: Triage = !alive.has(photoId) ? 'rejected' : kept.has(photoId) ? 'picked' : (baseline.get(photoId) ?? 'untriaged');
      await this.writeOne(photoId, target);
    }
    this.finish(stackId);
  }

  // --- writes ---

  // Recorded in the entry at *issue* time rather than on landing: an undo pressed
  // while a closing `picked` is still in flight would otherwise build its restore
  // list without that photo, and the write would land after the rewind, into a
  // session that had resumed.
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
    saveSession(stackId, {
      session,
      history: this.store.history,
      baseline: Object.fromEntries(this.store.baseline),
      entryPhotoId: this.store.entryPhotoId,
      bounds: this.store.bounds,
      failed: [...this.store.failed],
    });
  }
}
