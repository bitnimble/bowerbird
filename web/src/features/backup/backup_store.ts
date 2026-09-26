import { observable } from 'mobx';
import { type BackupStatus, type FetchBackProgress } from '../../../../src/schemas/backup';

// Data only: observables + computeds. Every mutation lives on BackupPresenter.
export class BackupStore {
  @observable.shallow accessor byLibrary = new Map<string, BackupStatus>();
  /** Which library's pass is running, so its panel can say so and refuse a second. */
  @observable accessor running: string | null = null;
  /** Which library is fetching its originals back before it stops backing up. */
  @observable accessor fetchingBack: string | null = null;
  /** Null until the server has queued the fetches, and between runs. */
  @observable.ref accessor fetchBackProgress: FetchBackProgress | null = null;

  statusOf(libraryId: string): BackupStatus | null {
    return this.byLibrary.get(libraryId) ?? null;
  }
}
