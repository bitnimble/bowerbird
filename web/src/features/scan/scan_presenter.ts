import { action, runInAction } from 'mobx';
import { type LibraryScanStatus } from '../../../../src/schemas/libraries';
import { librariesApi } from '../../api/libraries';
import { ApiError } from '../../api/request';
import type { LibrariesPresenter } from '../libraries/libraries_presenter';
import type { PhotosPresenter } from '../photos/photos_presenter';
import type { ScanStore } from './scan_store';

const POLL_MS = 1000;
const RATE_WINDOW_MS = 5000;

// All a poll asks of the two presenters it drives.
type GridToRefresh = Pick<PhotosPresenter, 'reload'>;
type ListToRefresh = Pick<LibrariesPresenter, 'load'>;

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

export class ScanPresenter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Whether the previous tick saw a run in flight, so the tick that finds it
  // finished still re-reads the grid once.
  private busy = false;
  // The library whose run we asked for and the server has not answered for yet.
  // Until then an 'idle' report of it is a run not yet recorded, not the truth.
  private starting: string | null = null;
  // The counts the last RATE_WINDOW_MS of polls reported, oldest first, which the
  // rate is measured across.
  private samples: { status: string; at: number; done: number }[] = [];

  constructor(
    private readonly store: ScanStore,
    private readonly photos: GridToRefresh,
    private readonly libraries: ListToRefresh,
  ) {}

  // Poll while a scan/processing run is in flight so the grid fills in as
  // renditions land, then stop: an idle library needs no traffic.
  async watch(libraryId: string): Promise<void> {
    this.stop();
    this.setLibrary(libraryId);
    await this.poll();
  }

  // Polls alongside the request rather than after it. POST /sync only answers once
  // the scan has finished, which on a library's first import is minutes of opening
  // and hashing every file - the whole time the run is already under way and the
  // status endpoint has been reporting it.
  async scanLibrary(libraryId: string): Promise<void> {
    await this.start(libraryId, () => librariesApi.scan(libraryId));
  }

  // One stage of a scan, without walking the tree: every grid tile, or every
  // viewer render. Same strip and Stop as Scan library.
  async rebuildTiles(libraryId: string): Promise<void> {
    await this.start(libraryId, () => librariesApi.rebuildTiles(libraryId));
  }

  async rebuildRenditions(libraryId: string): Promise<void> {
    await this.start(libraryId, () => librariesApi.rebuildRenditions(libraryId));
  }

  private async start(libraryId: string, run: () => Promise<LibraryScanStatus>): Promise<void> {
    this.stop(); // one poll loop, whether or not a view is already watching
    this.setLibrary(libraryId);
    this.starting = libraryId;
    const pending = run().then(
      (status) => runInAction(() => (this.store.status = status)),
      (err) => {
        // A 409 means someone else is already scanning, which is not a failure
        // worth showing: the poll reports that run's progress.
        if (!(err instanceof ApiError && err.code === 'SYNC_IN_PROGRESS')) {
          runInAction(() => (this.store.error = message(err)));
        }
      },
    );
    void pending.finally(() => {
      if (this.starting === libraryId) this.starting = null;
    });
    await this.poll();
    await pending;
  }

  // Stops whatever the library is doing. The run settles back to idle on its own,
  // which the poll already in flight picks up like any other transition.
  async cancel(libraryId: string): Promise<void> {
    try {
      await librariesApi.cancelScan(libraryId);
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
    let placingRows = false;
    try {
      const status = await librariesApi.scanStatus(libraryId);
      const running = status.status !== 'idle';
      const unanswered = this.starting === libraryId;
      if (running || !unanswered) runInAction(() => (this.store.status = status));
      this.sample();
      wasBusy = running || unanswered;
      placingRows = status.status === 'processing';
    } catch (err) {
      runInAction(() => (this.store.error = message(err)));
      return;
    }

    // The grid is re-read for the rows a scan inserts, and once more on the tick
    // that finds the run finished. Not through the rendition phase, which is the
    // long one: the row set is settled by then and renditions arrive by
    // announcement (§18.6), so a list request per second would answer with the
    // page the grid already has.
    const finished = this.busy && !wasBusy;
    if (placingRows || finished) await this.photos.reload();
    // The library's photo count and "scanned 3 min ago" come off the library list,
    // which nothing else re-reads while the settings page stays open. Read
    // through the scan as well as at the end: the rows are inserted as the walk
    // finds them, so the sidebar counts a first import up as it goes rather than
    // sitting at zero through the hour of renditions that follows.
    if (placingRows || finished) await this.libraries.load();
    this.busy = wasBusy;

    if (wasBusy && this.store.libraryId === libraryId) {
      this.timer = setTimeout(() => void this.poll(), POLL_MS);
    }
  }

  // The scan's own figure, over the batch of rows it last wrote down, wherever the
  // server has one. Counting polls is the fallback for a phase it does not time,
  // over a window rather than between two of them: a per-poll figure swings by a
  // factor of several as the workers land in bursts.
  @action.bound
  private sample(): void {
    const status = this.store.status;
    const progress = this.store.progress;
    if (status == null || progress == null) {
      this.samples.length = 0;
      this.store.rate = null;
      return;
    }
    const now = Date.now();
    const first = this.samples[0];
    // A count that went backwards is a new run reusing the phase name.
    if (first != null && (first.status !== status.status || progress.done < first.done)) this.samples.length = 0;
    this.samples.push({ status: status.status, at: now, done: progress.done });
    // Strictly the window, even where that leaves one sample and nothing to measure
    // over: polls are a second apart while a run is in flight, so the only way to
    // hold a sample older than this is a gap in the watching, and pairing what a
    // library was doing before the gap with what it is doing now is not a rate.
    this.samples = this.samples.filter((s) => now - s.at <= RATE_WINDOW_MS);
    const oldest = this.samples[0] ?? { at: now, done: progress.done };
    const done = progress.done - oldest.done;
    const seconds = (now - oldest.at) / 1000;
    const counted = done > 0 && seconds > 0 ? done / seconds : null;
    this.store.rate = status.photos_per_second ?? counted;
  }

  @action.bound
  private setLibrary(libraryId: string): void {
    // One presenter serves every library, so another library's counts are still in
    // hand here. Both phases carry the same names on all of them, and the new
    // library's count is as likely to be higher as lower, so nothing downstream
    // would notice them.
    if (this.store.libraryId !== libraryId) {
      this.samples.length = 0;
      this.store.rate = null;
    }
    this.store.libraryId = libraryId;
    this.store.error = null;
  }
}
