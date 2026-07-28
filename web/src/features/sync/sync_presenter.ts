import { action, runInAction } from 'mobx';
import { ApiError, api } from '../../api/client';
import type { LibrariesPresenter } from '../libraries/libraries_presenter';
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
  // The library whose run we asked for and the server has not answered for yet.
  // Until then an 'idle' report of it is a run not yet recorded, not the truth.
  private starting: string | null = null;

  constructor(
    private readonly store: SyncStore,
    private readonly photos: PhotosPresenter,
    private readonly libraries: LibrariesPresenter,
  ) {}

  // Poll while a sync/processing run is in flight so the grid fills in as
  // thumbnails land, then stop: an idle library needs no traffic.
  async watch(libraryId: string): Promise<void> {
    this.stop();
    this.setLibrary(libraryId);
    await this.poll();
  }

  // Polls alongside the request rather than after it. POST /sync only answers once
  // the scan has finished, which on a library's first import is minutes of opening
  // and hashing every file - the whole time the run is already under way and the
  // status endpoint has been reporting it.
  async trigger(libraryId: string): Promise<void> {
    this.stop(); // one poll loop, whether or not a view is already watching
    this.setLibrary(libraryId);
    this.starting = libraryId;
    const run = api.syncLibrary(libraryId).then(
      (status) => runInAction(() => (this.store.status = status)),
      (err) => {
        // A 409 means someone else is already syncing, which is not a failure
        // worth showing: the poll reports that run's progress.
        if (!(err instanceof ApiError && err.code === 'SYNC_IN_PROGRESS')) {
          runInAction(() => (this.store.error = message(err)));
        }
      },
    );
    void run.finally(() => {
      if (this.starting === libraryId) this.starting = null;
    });
    await this.poll();
    await run;
  }

  // Stops whatever the library is doing. The run settles back to idle on its own,
  // which the poll already in flight picks up like any other transition.
  async cancel(libraryId: string): Promise<void> {
    try {
      await api.cancelSync(libraryId);
    } catch (err) {
      runInAction(() => (this.store.error = message(err)));
    }
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
    let scanning = false;
    try {
      const status = await api.getSyncStatus(libraryId);
      const running = status.status !== 'idle';
      const unanswered = this.starting === libraryId;
      if (running || !unanswered) runInAction(() => (this.store.status = status));
      wasBusy = running || unanswered;
      scanning = status.status === 'scanning';
    } catch (err) {
      runInAction(() => (this.store.error = message(err)));
      return;
    }

    // The grid is re-read for the rows a scan inserts, and once more on the tick
    // that finds the run finished. Not through the processing phase, which is the
    // long one: the row set is settled by then and thumbnails arrive by
    // announcement (§18.6), so a list request per second would answer with the
    // page the grid already has - unless the view is filtering on what processing
    // changes, which is the one thing a refetch is still the only way to learn.
    const finished = this.busy && !wasBusy;
    if (scanning || finished || (wasBusy && this.photos.tracksProcessing)) await this.photos.reload();
    // The library's photo count and "synced 3m ago" come off the library list,
    // which nothing else re-reads while the settings page stays open.
    if (finished) await this.libraries.load();
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
