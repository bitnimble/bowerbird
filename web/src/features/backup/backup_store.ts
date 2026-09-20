import { observable } from 'mobx';
import { type BackupStatus } from '../../../../src/schemas/backup';

// Data only: observables + computeds. Every mutation lives on BackupPresenter.
export class BackupStore {
  @observable.shallow accessor byLibrary = new Map<string, BackupStatus>();
  /** Which library's pass is running, so its panel can say so and refuse a second. */
  @observable accessor running: string | null = null;

  statusOf(libraryId: string): BackupStatus | null {
    return this.byLibrary.get(libraryId) ?? null;
  }
}
