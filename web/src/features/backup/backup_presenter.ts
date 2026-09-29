import { action } from 'mobx';
import { type BackupStatus, type FetchBackProgress } from '../../../../src/schemas/backup';
import { backupApi } from '../../api/backup';
import { blobsApi } from '../../api/blobs';
import { ApiError } from '../../api/request';
import { openFolder } from '../../api/transport';
import type { PhotosPresenter } from '../photos/photos_presenter';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import { BackupPresenterStrings } from './backup_presenter.strings';
import { BackupStatusStrings } from './backup_status.strings';
import type { BackupStore } from './backup_store';

const FETCH_BACK_POLL_MS = 500;
const REFRESH_MS = 150;

function message(err: unknown): string {
  return err instanceof ApiError && err.code !== 'NETWORK_ERROR' ? err.message : BackupPresenterStrings.retryAdvice();
}

export class BackupPresenter {
  private revision = 0;
  private reading: Promise<void> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private disposed = false;
  private watching = false;
  private nextRead: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: BackupStore,
    private readonly photos: Pick<PhotosPresenter, 'reload'>,
    private readonly toasts: Pick<ToastsPresenter, 'show' | 'showError'>,
  ) {}

  load(): Promise<void> {
    this.disposed = false;
    if (this.reading != null) {
      this.dirty = true;
      return this.reading;
    }
    this.dirty = false;
    const revision = this.revision;
    this.reading = Promise.resolve().then(() => this.readAll(revision));
    return this.reading;
  }

  refresh(): void {
    this.revision++;
    this.dirty = true;
    if (this.refreshTimer != null || this.disposed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.reading == null) void this.load();
    }, REFRESH_MS);
  }

  async setFolder(libraryId: string, path: string): Promise<boolean> {
    if (!this.begin(libraryId)) return false;
    try {
      this.changed(await backupApi.setFolder(libraryId, path));
      return true;
    } catch (err) {
      this.fail(libraryId, BackupPresenterStrings.couldNotSetFolder(), err);
      return false;
    } finally {
      this.finished(libraryId);
      await this.load();
    }
  }

  async remove(libraryId: string, fetchFirst: boolean): Promise<boolean> {
    if (!this.begin(libraryId)) return false;
    if (fetchFirst) {
      this.fetchingBack(libraryId);
      this.watching = true;
      void this.readFetchBack(libraryId);
    }
    try {
      await backupApi.remove(libraryId, fetchFirst);
      this.changed({ library_id: libraryId, configured: false });
      return true;
    } catch (err) {
      this.fail(libraryId, BackupPresenterStrings.couldNotStop(), err);
      return false;
    } finally {
      this.stopWatching();
      this.fetchingBack(null);
      this.finished(libraryId);
      await this.load();
      if (fetchFirst) await this.photos.reload();
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
    if (!this.begin(libraryId)) return;
    try {
      this.changed(await backupApi.setBudget(libraryId, bytes));
    } catch (err) {
      this.fail(libraryId, BackupPresenterStrings.couldNotSetLimit(), err);
    } finally {
      this.finished(libraryId);
    }
  }

  async runNow(libraryId: string, resume = false): Promise<void> {
    if (!this.begin(libraryId)) return;
    try {
      const before = this.store.statusOf(libraryId);
      if (resume && before?.configured === true) {
        const transfers = await blobsApi.listTransfers(libraryId);
        for (const transfer of transfers) {
          if (transfer.library_id === libraryId && transfer.peer_id === before.peer_id && transfer.state === 'paused') {
            await blobsApi.resumeTransfer(transfer.id);
          }
        }
      }
      const { status, report } = await backupApi.run(libraryId);
      this.changed(status);
      if (report.outcome !== 'complete' || !status.configured || (status.status !== 'current' && status.status !== 'empty')) {
        this.toasts.showError(BackupPresenterStrings.unfinished(report.outcome), status.configured ? BackupStatusStrings.label(status) : BackupPresenterStrings.chooseFolder());
      } else {
        this.toasts.show(BackupPresenterStrings.completed(report.copied, report.moved, report.offloaded));
      }
      if (report.offloaded > 0) await this.photos.reload();
    } catch (err) {
      this.fail(libraryId, BackupPresenterStrings.couldNotBackUp(), err);
    } finally {
      this.finished(libraryId);
      await this.load();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.revision++;
    this.dirty = false;
    if (this.refreshTimer != null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.stopWatching();
  }

  private async readAll(revision: number): Promise<void> {
    try {
      const { backups } = await backupApi.list();
      if (revision === this.revision && !this.disposed) this.putAll(backups);
    } catch {
      if (revision === this.revision && !this.disposed) this.readFailed();
    } finally {
      this.reading = null;
      if (this.dirty && !this.disposed && this.refreshTimer == null) this.refresh();
    }
  }

  private begin(libraryId: string): boolean {
    if (this.store.busy(libraryId)) return false;
    this.revision++;
    this.dirty = true;
    this.started(libraryId);
    this.error(libraryId, null);
    return true;
  }

  private changed(status: BackupStatus): void {
    this.revision++;
    this.dirty = true;
    this.put(status);
    this.error(status.library_id, null);
  }

  private fail(libraryId: string, title: string, err: unknown): void {
    const detail = message(err);
    this.error(libraryId, BackupPresenterStrings.failure(title, detail));
    this.toasts.showError(title, detail);
  }

  @action.bound
  private started(libraryId: string): void {
    this.store.running = new Set(this.store.running).add(libraryId);
  }

  @action.bound
  private finished(libraryId: string): void {
    const running = new Set(this.store.running);
    running.delete(libraryId);
    this.store.running = running;
  }

  private async readFetchBack(libraryId: string): Promise<void> {
    try {
      const progress = await backupApi.fetchBackProgress(libraryId);
      if (this.watching) this.putProgress(progress);
    } catch {}
    if (this.watching) this.nextRead = setTimeout(() => void this.readFetchBack(libraryId), FETCH_BACK_POLL_MS);
  }

  private stopWatching(): void {
    this.watching = false;
    if (this.nextRead != null) clearTimeout(this.nextRead);
    this.nextRead = null;
  }

  @action.bound
  private fetchingBack(libraryId: string | null): void {
    this.store.fetchingBack = libraryId;
    if (libraryId != null) this.store.fetchBackProgress = null;
  }

  @action.bound
  private putProgress(progress: FetchBackProgress | null): void {
    this.store.fetchBackProgress = progress;
  }

  @action.bound
  private error(libraryId: string, error: string | null): void {
    const errors = new Map(this.store.errorsByLibrary);
    if (error == null) errors.delete(libraryId);
    else errors.set(libraryId, error);
    this.store.errorsByLibrary = errors;
  }

  @action.bound
  private readFailed(): void {
    this.store.readError = BackupStatusStrings.readFailed();
  }

  @action.bound
  private put(status: BackupStatus): void {
    this.store.byLibrary = new Map(this.store.byLibrary).set(status.library_id, status);
  }

  @action.bound
  private putAll(statuses: BackupStatus[]): void {
    this.store.byLibrary = new Map(statuses.map((status) => [status.library_id, status]));
    this.store.loaded = true;
    this.store.readError = null;
  }
}
