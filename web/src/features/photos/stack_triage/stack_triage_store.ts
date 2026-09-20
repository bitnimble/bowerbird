import { computed, observable } from 'mobx';
import { type PhotoSummary, type Triage } from '../../../../../src/schemas/photos';
import { type ViewerRendition } from '../../../../../src/schemas/settings';
import { renditionsApi } from '../../../api/renditions';
import type { AppSettingsStore } from '../../settings/app_settings_store';
import type { LibrariesStore } from '../../libraries/libraries_store';
import { renditionVersion } from '../photos_store';
import {
  type Placed,
  type Round,
  type Session,
  type Shape,
  applyVerdict,
  arrangement,
  fitted,
  nextRound,
  remainingPairs,
  upcomingRounds,
} from './stack_triage';
import type { HistoryEntry, TriageMode } from './triage_storage';

/** How many members are warmed at all. A fetch cap, for a manual stack of a thousand. */
export const WARM_LIMIT = 10;

type TriageStatus = 'loading' | 'error' | 'too-few' | 'running' | 'ended';

// Observables and computeds only. Every mutation is on StackTriagePresenter.
export class StackTriageStore {
  // Read-only peers. The rendition a session is judged at is a property of the
  // *library* its members belong to, plus the app setting - and `ViewerStore`
  // cannot answer it, because every rendition member it has is a function of the
  // photo the viewer has open, which on this route is either nothing or the photo
  // the session was entered from (§20.4).
  constructor(
    private readonly settings: AppSettingsStore,
    private readonly libraries: LibrariesStore,
  ) {}

  @observable accessor stackId: string | null = null;
  // Shallow: the rows are read whole and replaced whole, so proxying every field
  // of every member buys nothing.
  /** Every usable member, by id. */
  @observable.shallow accessor members = new Map<string, PhotoSummary>();
  /** Each member's triage when the session opened: what every restore targets. */
  @observable.shallow accessor baseline = new Map<string, Triage>();
  // The shape of each member's frame as it actually decoded, which is not quite
  // the shape the catalogue records: a rendition is resized to a longest edge and
  // rounded to whole pixels, so a 2:3 photograph arrives as 1080x1616. Off by a
  // sixth of a percent, and enough to letterbox the picture inside a half sized
  // from the row (§20.4).
  @observable.shallow accessor frames = new Map<string, { width: number; height: number }>();

  // The tournament, as one immutable value: restoring a snapshot is one
  // assignment, and cannot leave the pool, the judged pairs and the stopped flag
  // disagreeing.
  @observable.ref accessor session: Session | null = null;
  // Shallow, like `session`: an entry holds an immutable snapshot, and deep
  // observability would turn its pool into an ObservableArray and its judged
  // pairs into an ObservableSet inside a module whose whole premise is that they
  // are values.
  @observable.shallow accessor history: HistoryEntry[] = [];

  /** Which of the two drawn sides flip mode has on screen. */
  @observable accessor showing: 'a' | 'b' = 'a';
  // The round drawn in the other order. Written by the presenter so that a photo
  // carried into the next round keeps the side it is already on: with both halves
  // moving, nothing on screen says which of the two was replaced.
  @observable accessor swapped = false;
  // Seeded by the presenter, which is the only thing that reads storage.
  @observable accessor mode: TriageMode = 'flip';
  /** Where to go back to. Recorded on entry and stored, so a reload still knows. */
  @observable accessor entryPhotoId: string | null = null;
  // The photographs the stack lies between in the collection the session was
  // entered from, read off the viewer's run at entry and stored with the session.
  // Handing these to a range gives the stack back in the collection's own order,
  // so nothing here has to know which end of that order is "after".
  @observable.ref accessor bounds: { from: string | null; to: string | null } = { from: null, to: null };
  /** Photos whose triage write did not land. Reported rather than compensated (§20.2). */
  @observable accessor failed = new Set<string>();
  @observable accessor loadError: string | null = null;
  /** True while a verdict's writes are in flight, so a second cannot be cast over them. */
  @observable accessor busy = false;

  // The space the presentation has between the bars, written by the presenter
  // from a ResizeObserver. The one input `arrangement` and `fitted` cannot get
  // from a store they already have, and the one that must never be read back out
  // of the DOM.
  @observable accessor stageWidth = 0;
  @observable accessor stageHeight = 0;

  /** Members in pool order, which is the order the server returned them. */
  @computed get pool(): PhotoSummary[] {
    const ids = this.session?.alive ?? [];
    return ids.flatMap((id) => {
      const photo = this.members.get(id);
      return photo == null ? [] : [photo];
    });
  }

  @computed get round(): Round | null {
    return this.session == null ? null : nextRound(this.session);
  }

  // Derived, never assigned. Undo restores a session and nothing else, so a
  // `status` field would leave the photographer on an ended screen for a
  // tournament that had just resumed underneath them.
  @computed get status(): TriageStatus {
    if (this.loadError != null) return 'error';
    if (this.session == null) return 'loading';
    if (this.members.size < 2) return 'too-few';
    return this.round == null ? 'ended' : 'running';
  }

  @computed get pair(): [PhotoSummary, PhotoSummary] | null {
    const round = this.round;
    if (round == null) return null;
    const a = this.members.get(round.a);
    const b = this.members.get(round.b);
    return a == null || b == null ? null : [a, b];
  }

  /**
   * The round's two photos in the order they are drawn, which is what A and B
   * name: the screen's own sides, so `←` is always the picture on the left.
   */
  @computed get sides(): [string, string] | null {
    const round = this.round;
    if (round == null) return null;
    return this.swapped ? [round.b, round.a] : [round.a, round.b];
  }

  @computed get shown(): [PhotoSummary, PhotoSummary] | null {
    const pair = this.pair;
    if (pair == null) return null;
    return this.swapped ? [pair[1], pair[0]] : pair;
  }

  /**
   * The rendition the whole session is judged at.
   *
   * Off a member's own library rather than the viewer's answer: `ViewerStore.showing`
   * is a function of `openPhoto`, which nothing clears when the viewer unmounts. On
   * this route that is either the entry photo - pinning one photo's remembered
   * choice onto every member - or nothing at all, where the library lookup misses
   * and the answer silently becomes the camera's JPEG.
   *
   * Only a rendition every member is certain to have: one built on request is a
   * 404 until something builds it, and a tournament cannot wait a build per round.
   *
   * Not each member's own `shown_rendition`, though every row now carries one: that is the
   * answer for one photograph, and under `remember_per_photo` or `best_available` the
   * members of one stack have different ones. A round drawn at two different renditions is
   * not a comparison, so this asks the session's question instead - which is why the two
   * per-photo modes fall through to what the library builds rather than to a member's pick.
   */
  @computed get rendition(): ViewerRendition {
    const first = this.members.values().next().value;
    const library = this.libraries.byId.get(first?.library_id ?? '');
    // **Only where every member actually has one.** The camera's JPEG is a property of the file,
    // and a stack of HEICs has none - so a round drawn at `embedded` there is a round of blank
    // tiles. A member that came from a finished picture takes the whole pool to the render, which
    // is the one file all of them are certain to have.
    const anyEmbedded = [...this.members.values()].every((member) => member.has_embedded);
    const built: ViewerRendition =
      library?.rendition_source === 'render' || !anyEmbedded ? 'full' : 'embedded';
    const mode = this.settings.viewerRenditionMode;
    // The camera's JPEG is the only thing a reader can ask for that every member is certain
    // to have; everything else - a per-photo mode, which is not a claim about the rest, a
    // remembered `max`, a `full` in a library that serves the JPEG - lands on what the
    // library builds, since that is the one file the whole pool can be drawn at.
    const chosen = mode === 'remember' ? this.settings.lastViewerRendition : mode;
    return chosen === 'embedded' && anyEmbedded ? 'embedded' : built;
  }

  srcOf(photoId: string): string {
    const photo = this.members.get(photoId);
    return renditionsApi.url(photoId, this.rendition, renditionVersion(photo, this.rendition));
  }

  /**
   * Which members can open the *next* round, so those frames are warmed at stage
   * size and the rest merely fetched.
   *
   * Every verdict is simulated rather than guessed at: there are four, each is a
   * pure call, and the alternative is a rule about queue order that would drift
   * the moment `applyVerdict` changed.
   */
  @computed get hot(): string[] {
    const session = this.session;
    const round = this.round;
    if (session == null || round == null) return [];
    const ids = new Set<string>([round.a, round.b]);
    for (const verdict of ['a', 'b', 'both', 'neither'] as const) {
      const after = nextRound(applyVerdict(session, round, verdict));
      if (after != null) {
        ids.add(after.a);
        ids.add(after.b);
      }
    }
    return [...ids];
  }

  /** Every member worth warming: the hot ones first, then the rest of the pool. */
  @computed get warm(): string[] {
    const hot = this.hot;
    const rest = (this.session?.alive ?? []).filter((id) => !hot.includes(id));
    return [...hot, ...rest].slice(0, WARM_LIMIT);
  }

  // Off the drawn order, so the two sizes belong to the halves they are applied
  // to rather than to the round's own slots.
  @computed get placement(): Placed | null {
    const shown = this.shown;
    if (shown == null) return null;
    const [a, b] = shown;
    return arrangement(this.aspectOf(a.id), this.aspectOf(b.id), this.stageWidth, this.stageHeight);
  }

  /** The largest box of this photo's shape the presentation has room for. */
  boxOf(photoId: string): Shape {
    return fitted(this.aspectOf(photoId), this.stageWidth, this.stageHeight);
  }

  // The frame's own shape once it has one, the catalogue's until then: the box is
  // laid out before a pixel decodes, and one that is a fraction off the picture
  // inside it leaves an uneven gap between the picture and its edge.
  private aspectOf(photoId: string): number {
    const photo = this.members.get(photoId);
    const frame = this.frames.get(photoId) ?? photo;
    return frame == null ? Number.NaN : frame.width / frame.height;
  }

  /** Rounds still to come, the one on screen included. Labelled "up to" (§20.4). */
  @computed get remaining(): number {
    return this.session == null ? 0 : remainingPairs(this.session);
  }

  @computed get upcoming(): Round[] {
    return this.session == null ? [] : upcomingRounds(this.session);
  }

  /** How many projected rounds the queue is not showing. */
  @computed get upcomingOverflow(): number {
    return Math.max(0, this.remaining - 1 - this.upcoming.length);
  }

  /**
   * The round a history entry judged.
   *
   * Derived rather than stored: an entry holds the session as it stood before its
   * action, and `nextRound` of that is by definition the pair it was asked. The
   * *verdict* is stored, because that one is only recoverable by diffing against
   * the following entry and the newest entry has none.
   */
  roundOfEntry(index: number): Round | null {
    const entry = this.history[index];
    return entry == null ? null : nextRound(entry.session);
  }
}
