import { computed, observable } from 'mobx';
import { type LibraryScanStatus } from '../../../../src/schemas/libraries';

/** Which of a run's two phases the progress pair is counting through. */
export type ScanCounting = 'files' | 'renditions';

export class ScanStore {
  @observable accessor status: LibraryScanStatus | null = null;
  @observable accessor libraryId: string | null = null;
  @observable accessor error: string | null = null;
  // What the current phase is getting through, in `progress.counting` per second. Null
  // until there is enough to measure it over.
  @observable accessor rate: number | null = null;

  @computed get isBusy(): boolean {
    return this.status != null && this.status.status !== 'idle';
  }

  @computed get secondsLeft(): number | null {
    const p = this.progress;
    if (p == null || this.rate == null || this.rate <= 0) return null;
    const left = p.total - p.done;
    return left <= 0 ? null : left / this.rate;
  }

  // What the run's current phase is counting through: the files the scan is
  // walking, then the renditions it queued. Null when there is nothing to count,
  // so the UI can hide the bar rather than render a meaningless 100%.
  @computed get progress(): { done: number; total: number; counting: ScanCounting } | null {
    const s = this.status;
    if (s == null) return null;
    // An idle library still reports what it owes - a killed import leaves its
    // flags in the rows - but a bar beside the word "idle" reads as a run that
    // has stalled rather than one nothing is doing. The count is worth saying,
    // the progress is not.
    if (s.status === 'idle') return null;
    const walking = s.status === 'processing';
    const done = walking ? s.photos_scanned : s.photos_processed;
    const total = walking ? s.photos_to_scan : s.photos_processing + s.photos_processed;
    return total === 0 ? null : { done, total, counting: walking ? 'files' : 'renditions' };
  }
}
