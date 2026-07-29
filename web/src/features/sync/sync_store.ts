import { computed, observable } from 'mobx';
import type { LibrarySyncStatus } from '../../api/client';

export class SyncStore {
  @observable accessor status: LibrarySyncStatus | null = null;
  @observable accessor libraryId: string | null = null;
  @observable accessor error: string | null = null;

  @computed get isBusy(): boolean {
    return this.status != null && this.status.status !== 'idle';
  }

  @computed get label(): string {
    if (this.status == null) return 'idle';
    return this.status.status;
  }

  // What the run's current phase is counting through: the files the scan is
  // walking, then the renditions it queued. Null when there is nothing to count,
  // so the UI can hide the bar rather than render a meaningless 100%.
  @computed get progress(): { done: number; total: number; noun: string } | null {
    const s = this.status;
    if (s == null) return null;
    // An idle library still reports what it owes - a killed import leaves its
    // flags in the rows - but a bar beside the word "idle" reads as a run that
    // has stalled rather than one nothing is doing. The count is worth saying,
    // the progress is not.
    if (s.status === 'idle') return null;
    const scanning = s.status === 'scanning';
    const done = scanning ? s.photos_scanned : s.photos_processed;
    const total = scanning ? s.photos_to_scan : s.photos_processing + s.photos_processed;
    return total === 0 ? null : { done, total, noun: scanning ? 'files' : 'renditions' };
  }
}
