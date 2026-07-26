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

  // Fraction of this run's thumbnailing that is done, or null when nothing was
  // queued (so the UI can hide the bar rather than render a meaningless 100%).
  @computed get processingProgress(): number | null {
    const s = this.status;
    if (s == null) return null;
    const total = s.photos_processing + s.photos_processed;
    return total === 0 ? null : s.photos_processed / total;
  }
}
