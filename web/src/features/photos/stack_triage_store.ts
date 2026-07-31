import { computed, observable } from 'mobx';
import type { Ordering, PhotoSummary, Triage, ViewerRendition } from '../../api/client';
import { viewerUrl } from '../../api/client';
import type { AppSettingsStore } from '../settings/app_settings_store';
import type { LibrariesStore } from '../libraries/libraries_store';
import { renditionVersion } from './photos_store';
import {
  type Placed,
  type Round,
  type Session,
  applyVerdict,
  arrangement,
  keepers,
  nextRound,
  remainingPairs,
  upcomingRounds,
} from './stack_triage';
import type { HistoryEntry, TriageMode } from './triage_storage';

/** How many members are warmed at all. A fetch cap, for a manual stack of a thousand. */
export const WARM_LIMIT = 10;

type TriageStatus = 'loading' | 'error' | 'too-few' | 'running' | 'ended';

/** What a finished session decided, as the summary draws it. */
interface Outcome {
  kept: PhotoSummary[];
  rejected: PhotoSummary[];
  unsaved: PhotoSummary[];
}

// Observables and computeds only. Every mutation is on StackTriagePresenter.
export class StackTriageStore {
  // Read-only peers. The rendition a session is judged at is a property of the
  // *library* its members belong to, plus the app setting - and `PhotosStore`
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

  // The tournament, as one immutable value: restoring a snapshot is one
  // assignment, and cannot leave the pool, the judged pairs and the stopped flag
  // disagreeing.
  @observable.ref accessor session: Session | null = null;
  // Shallow, like `session`: an entry holds an immutable snapshot, and deep
  // observability would turn its pool into an ObservableArray and its judged
  // pairs into an ObservableSet inside a module whose whole premise is that they
  // are values.
  @observable.shallow accessor history: HistoryEntry[] = [];

  @observable accessor showing: 'a' | 'b' = 'a';
  // Seeded by the presenter, which is the only thing that reads storage.
  @observable accessor mode: TriageMode = 'flip';
  /** Where to go back to. Recorded on entry and stored, so a reload still knows. */
  @observable accessor entryPhotoId: string | null = null;
  /** Photos whose triage write did not land. Reported rather than compensated (§20.2). */
  @observable accessor failed = new Set<string>();
  @observable accessor loadError: string | null = null;
  /** True while a verdict's writes are in flight, so a second cannot be cast over them. */
  @observable accessor busy = false;

  // The space the two stages have between the bars, written by the presenter from
  // a ResizeObserver. The one input `arrangement` cannot get from a store it
  // already has, and the one that must never be read back out of the DOM.
  @observable accessor splitWidth = 0;
  @observable accessor splitHeight = 0;

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
  // `status` field would leave the photographer on a summary for a tournament
  // that had just resumed underneath them.
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
   * The rendition the whole session is judged at.
   *
   * Off a member's own library rather than the viewer's answer: `showing`,
   * `preferredRendition` and `defaultRendition` are every one of them a function
   * of `PhotosStore.openPhoto`, which nothing clears when the viewer unmounts. On
   * this route that is either the entry photo - pinning one photo's remembered
   * choice onto every member - or nothing at all, where the library lookup misses
   * and the answer silently becomes the camera's JPEG.
   *
   * Only a rendition every member is certain to have: one built on request is a
   * 404 until something builds it, and a tournament cannot wait a build per round.
   */
  @computed get rendition(): ViewerRendition {
    const first = this.members.values().next().value;
    const library = this.libraries.byId.get(first?.library_id ?? '');
    const built: ViewerRendition = library?.rendition_source === 'render' ? 'full' : 'embedded';
    const mode = this.settings.viewerRenditionMode;
    // `remember_per_photo` has no answer here: the session is judged at one
    // rendition, so one photo's remembered choice is not a claim about the rest.
    const preferred = mode === 'remember' ? this.settings.lastViewerRendition : mode === 'remember_per_photo' ? null : mode;
    return preferred != null && (preferred === 'embedded' || preferred === built) ? preferred : built;
  }

  srcOf(photoId: string): string {
    const photo = this.members.get(photoId);
    return viewerUrl(photoId, this.rendition, renditionVersion(photo, this.rendition));
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

  @computed get placement(): Placed | null {
    const pair = this.pair;
    if (pair == null) return null;
    const [a, b] = pair;
    return arrangement(a.width / a.height, b.width / b.height, this.splitWidth, this.splitHeight);
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

  @computed get outcome(): Outcome {
    const session = this.session;
    if (session == null) return { kept: [], rejected: [], unsaved: [] };
    const alive = new Set(session.alive);
    const rows = (ids: Iterable<string>): PhotoSummary[] =>
      [...ids].flatMap((id) => {
        const photo = this.members.get(id);
        return photo == null ? [] : [photo];
      });
    return {
      // Kept is every survivor, not only the judged ones: Keep the rest leaves
      // photos in the pool that were never on screen, and they are kept. The
      // screen marks them rather than hiding them, because §20.2 goes to trouble
      // to keep that distinction in the data.
      kept: rows(session.alive),
      // Off the members this session started with, which is what `baseline` is,
      // rather than off the members now: a photo added to the stack mid-session,
      // or one that was missing at open and is back, was never in the pool and
      // nothing rejected it.
      rejected: rows([...this.baseline.keys()].filter((id) => !alive.has(id))),
      unsaved: rows(this.failed),
    };
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

  /**
   * The photograph to come back to when the session is over: the survivor that
   * sorts **last** in the collection's own order.
   *
   * Last, so that stepping on from it steps past the whole stack rather than back
   * through the members that also survived - which is what the viewer walking
   * every member (§19.5.3) makes possible and makes necessary. Which end that is
   * depends on the ordering, so it is passed in rather than assumed.
   *
   * Null when nothing survived, which `Neither` on everything can do.
   */
  keeperFor(ordering: Ordering | null): PhotoSummary | null {
    // Undated sorts last in the listing's own ordering, so it sorts last here.
    const key = (photo: PhotoSummary): string => photo.ordering_date ?? '￿';
    // Which end of the collection's order is "after the stack". The viewer walks
    // members now (§19.5.3), so landing on the wrong end would step back through
    // the other keepers before leaving the stack.
    const descending = ordering === 'taken_desc' || ordering === 'added_desc';
    let last: PhotoSummary | null = null;
    for (const id of this.session?.alive ?? []) {
      const photo = this.members.get(id);
      if (photo == null) continue;
      if (last == null) {
        last = photo;
        continue;
      }
      const after = key(photo) === key(last) ? photo.id > last.id : key(photo) > key(last);
      if (after !== descending) last = photo;
    }
    return last;
  }

  /** Survivors that were never compared with anything, so nothing is claimed of them. */
  @computed get unjudged(): Set<string> {
    const session = this.session;
    if (session == null) return new Set();
    const judged = new Set(keepers(session));
    return new Set(session.alive.filter((id) => !judged.has(id)));
  }
}
