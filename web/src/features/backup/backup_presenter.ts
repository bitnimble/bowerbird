import { action } from 'mobx';
import { type BackupStatus, type FetchBackProgress } from '../../../../src/schemas/backup';
import { backupApi } from '../../api/backup';
import { ApiError } from '../../api/request';
import { openFolder } from '../../api/transport';
import type { PhotosPresenter } from '../photos/photos_presenter';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import { BackupPresenterStrings } from './backup_presenter.strings';
import type { BackupStore } from './backup_store';

type Feedback = Pick<ToastsPresenter, 'show' | 'showError'>;

const FETCH_BACK_POLL_MS = 500;
type GridToRefresh = Pick<PhotosPresenter, 'reload'>;

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

// A whole sentence per outcome rather than two halves joined: a pass that copied and culled is one
// thing that happened, and the two counts do not inflect independently in every language.
function told(copied: number, removed: number): string {
  if (copied > 0 && removed > 0) return BackupPresenterStrings.copiedAndRemoved(copied, removed);
  if (copied > 0) return BackupPresenterStrings.copied(copied);
  if (removed > 0) return BackupPresenterStrings.removedLocalCopies(removed);
  return BackupPresenterStrings.upToDate();
}

export class BackupPresenter {
  private watching = false;
  private nextRead: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: BackupStore,
    private readonly photos: GridToRefresh,
    private readonly toasts: Feedback,
  ) {}

  async load(): Promise<void> {
    try {
      this.putAll((await backupApi.list()).backups);
    } catch (err) {
      this.toasts.showError(BackupPresenterStrings.couldNotReadBackups(), message(err));
    }
  }

  async setFolder(libraryId: string, path: string): Promise<boolean> {
    try {
      this.put(await backupApi.setFolder(libraryId, path));
      return true;
    } catch (err) {
      this.toasts.showError(BackupPresenterStrings.couldNotSetFolder(), message(err));
      return false;
    }
  }

  /** @param fetchFirst brings every original only the backup holds back to this device first. */
  async remove(libraryId: string, fetchFirst: boolean): Promise<void> {
    if (fetchFirst) {
      this.fetchingBack(libraryId);
      this.watchFetchBack(libraryId);
    }
    try {
      await backupApi.remove(libraryId, fetchFirst);
      this.forget(libraryId);
    } catch (err) {
      this.toasts.showError(BackupPresenterStrings.couldNotStop(), message(err));
      // Whatever did come back is on this device now, stopped or not.
      if (fetchFirst) await this.load();
    } finally {
      if (fetchFirst) {
        this.stopWatching();
        this.fetchingBack(null);
        await this.photos.reload();
      }
    }
  }

  async openFolder(path: string): Promise<void> {
    try {
      await openFolder(path);
    } catch (err) {
      this.toasts.showError(BackupPresenterStrings.couldNotOpenFolder(), message(err));
    }
  }

  async setBudget(libraryId: string, bytes: number | null): Promise<void> {
    try {
      this.put(await backupApi.setBudget(libraryId, bytes));
    } catch (err) {
      this.toasts.showError(BackupPresenterStrings.couldNotSetLimit(), message(err));
    }
  }

  /**
   * Copies what the folder is owed, then gives back whatever does not fit the limit.
   *
   * The grid is re-read afterwards, because a pass that culled anything has changed which
   * photographs are on this device and every tile of one says so (§14.5).
   */
  async runNow(libraryId: string): Promise<void> {
    if (this.store.running != null) return;
    this.starting(libraryId);
    try {
      const run = await backupApi.run(libraryId);
      this.toasts.show(told(run.copied, run.offloaded));
      if (run.offloaded > 0) await this.photos.reload();
    } catch (err) {
      this.toasts.showError(BackupPresenterStrings.couldNotBackUp(), message(err));
    } finally {
      this.starting(null);
      await this.load();
    }
  }

  @action.bound
  private starting(libraryId: string | null): void {
    this.store.running = libraryId;
  }

  private watchFetchBack(libraryId: string): void {
    this.watching = true;
    void this.readFetchBack(libraryId);
  }

  private async readFetchBack(libraryId: string): Promise<void> {
    try {
      const progress = await backupApi.fetchBackProgress(libraryId);
      if (!this.watching) return;
      this.putProgress(progress);
    } catch {
      // A missed read is the next read's to make up.
    }
    if (!this.watching) return;
    this.nextRead = setTimeout(() => void this.readFetchBack(libraryId), FETCH_BACK_POLL_MS);
  }

  private stopWatching(): void {
    this.watching = false;
    if (this.nextRead != null) clearTimeout(this.nextRead);
    this.nextRead = null;
  }

  @action.bound
  private fetchingBack(libraryId: string | null): void {
    this.store.fetchingBack = libraryId;
    this.store.fetchBackProgress = null;
  }

  @action.bound
  private putProgress(progress: FetchBackProgress | null): void {
    this.store.fetchBackProgress = progress;
  }

  @action.bound
  private put(status: BackupStatus): void {
    this.store.byLibrary = new Map(this.store.byLibrary).set(status.library_id, status);
  }

  @action.bound
  private putAll(statuses: BackupStatus[]): void {
    this.store.byLibrary = new Map(statuses.map((status) => [status.library_id, status]));
  }

  @action.bound
  private forget(libraryId: string): void {
    const next = new Map(this.store.byLibrary);
    next.delete(libraryId);
    this.store.byLibrary = next;
  }
}
