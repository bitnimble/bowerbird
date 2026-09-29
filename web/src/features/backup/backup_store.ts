import { observable } from 'mobx';
import { type BackupStatus, type FetchBackProgress } from '../../../../src/schemas/backup';

export class BackupStore {
  @observable.shallow accessor byLibrary = new Map<string, BackupStatus>();
  @observable accessor loaded = false;
  @observable accessor readError: string | null = null;
  @observable.shallow accessor errorsByLibrary = new Map<string, string>();
  @observable.shallow accessor running = new Set<string>();
  @observable accessor fetchingBack: string | null = null;
  @observable.ref accessor fetchBackProgress: FetchBackProgress | null = null;

  statusOf(libraryId: string): BackupStatus | null {
    return this.byLibrary.get(libraryId) ?? null;
  }

  busy(libraryId: string): boolean {
    const status = this.statusOf(libraryId);
    return this.running.has(libraryId) || (status?.configured === true && status.activity != null);
  }
}
