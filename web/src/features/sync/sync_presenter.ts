import { action, runInAction } from 'mobx';
import { ApiError, api } from '../../api/client';
import type { PhotosPresenter } from '../photos/photos_presenter';
import type { SyncStore } from './sync_store';

const POLL_MS = 1000;

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

export class SyncPresenter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Whether the previous tick saw a run in flight, so the tick that finds it
  // finished still re-reads the grid once.
  private busy = false;

  constructor(
    private readonly store: SyncStore,
    private readonly photos: PhotosPresenter,
  ) {}

  // Poll while a sync/processing run is in flight so the grid fills in as
  // thumbnails land, then stop: an idle library needs no traffic.
  async watch(libraryId: string): Promise<void> {
    this.stop();
    this.setLibrary(libraryId);
    await this.poll();
  }

  async trigger(libraryId: string): Promise<void> {
    this.setLibrary(libraryId);
    try {
      const status = await api.syncLibrary(libraryId);
      runInAction(() => (this.store.status = status));
    } catch (err) {
      // A 409 means someone else is already syncing, which is not a failure
      // worth showing: polling below will report that run's progress.
      const conflict = err instanceof ApiError && err.code === 'SYNC_IN_PROGRESS';
      if (!conflict) {
        runInAction(() => (this.store.error = message(err)));
        return;
      }
    }
    await this.poll();
  }

  @action.bound
  stop(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
  }

  @action.bound
  clearError(): void {
    this.store.error = null;
  }

  private async poll(): Promise<void> {
    const libraryId = this.store.libraryId;
    if (libraryId == null) return;

    let wasBusy = false;
    try {
      const status = await api.getSyncStatus(libraryId);
      wasBusy = status.status !== 'idle';
      runInAction(() => (this.store.status = status));
    } catch (err) {
      runInAction(() => (this.store.error = message(err)));
      return;
    }

    // Refresh the grid on every tick of an active run: rows appear as the scan
    // inserts them, and thumbnails resolve as processing finishes. Only then -
    // an idle library's grid was just fetched by the page that opened it, and a
    // second list request answers with the page it already has.
    if (wasBusy || this.busy) await this.photos.reload();
    this.busy = wasBusy;

    if (wasBusy && this.store.libraryId === libraryId) {
      this.timer = setTimeout(() => void this.poll(), POLL_MS);
    }
  }

  @action.bound
  private setLibrary(libraryId: string): void {
    this.store.libraryId = libraryId;
    this.store.error = null;
  }
}
