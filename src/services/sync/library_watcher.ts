import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../errors';
import type { Library } from '../../schemas/libraries';
import { getDataPath } from '../../utils/paths';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { LibraryLifecycleListener } from '../libraries/libraries_service';
import type { SyncService } from './sync_service';

type Timer = ReturnType<typeof setTimeout>;

// Above this many distinct changed paths in one debounce window, a scoped sync's
// IN(...) clause and per-path work stop being cheaper than a full walk (a bulk
// import), so fall back to a full sync.
const MAX_SCOPE = 256;

// Ceiling for the watch-retry backoff (§9.8): long enough that a permanently
// absent root costs nothing, short enough to pick a returning drive up promptly.
const MAX_RETRY_MS = 5 * 60 * 1000;

// Watches each library root and triggers a debounced sync when its files change
// on disk. Reactive counterpart to the on-demand POST /sync (DESIGN §9). Change
// detection stays with sync; the watcher only decides *when* to run it.
export class LibraryWatcher implements LibraryLifecycleListener {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, Timer>();
  private readonly retryTimers = new Map<string, Timer>();
  private readonly retryDelays = new Map<string, number>();
  private readonly syncing = new Set<string>();
  private readonly dirty = new Set<string>();
  // Changed relative paths accumulated per library during the debounce window; the
  // next run() reconciles just these (scoped sync) instead of the whole library.
  private readonly pending = new Map<string, Set<string>>();
  private stopped = false;

  constructor(
    private readonly libraries: LibrariesRepository,
    private readonly sync: SyncService,
    private readonly debounceMs: number,
  ) {}

  start(): void {
    this.stopped = false;
    for (const library of this.libraries.list()) this.watchLibrary(library);
  }

  stop(): void {
    // Set before clearing so an in-flight run()'s finally can't reschedule a sync
    // (or a retry timer fire and re-establish a watcher) after teardown.
    this.stopped = true;
    for (const watcher of this.watchers.values()) watcher.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.watchers.clear();
    this.timers.clear();
    this.retryTimers.clear();
    this.retryDelays.clear();
    this.pending.clear();
  }

  onLibraryCreated(library: Library): void {
    this.watchLibrary(library);
  }

  onLibraryDeleted(libraryId: string): void {
    this.dropWatcher(libraryId);
    const timer = this.timers.get(libraryId);
    if (timer) clearTimeout(timer);
    this.timers.delete(libraryId);
    const retry = this.retryTimers.get(libraryId);
    if (retry) clearTimeout(retry);
    this.retryTimers.delete(libraryId);
    this.retryDelays.delete(libraryId);
    // Clear dirty so an in-flight run()'s finally can't re-arm a debounce for a
    // library that no longer exists (which would then fail with NOT_FOUND).
    this.syncing.delete(libraryId);
    this.dirty.delete(libraryId);
    this.pending.delete(libraryId);
  }

  private watchLibrary(library: Library): void {
    if (this.stopped || this.watchers.has(library.id)) return;
    // A queued watch-error retry can land after the library was deleted; without
    // this, watchLibrary would re-create a live FSWatcher (leaked inotify handle +
    // spurious syncs) that onLibraryDeleted can never tear down again.
    if (!this.libraries.getById(library.id)) return;
    const dataDir = path.resolve(getDataPath(library));
    try {
      const watcher = watch(library.root_path, { recursive: true }, (_event, filename) => {
        if (filename == null) return;
        const relPath = filename.toString().split(path.sep).join('/');
        if (this.isRelevant(library.root_path, dataDir, relPath)) {
          this.record(library.id, relPath);
          this.schedule(library.id);
        }
      });
      watcher.on('error', (err) => {
        // A watch error (e.g. inotify ENOSPC) kills this watcher; drop it and try
        // to re-establish after a delay, else auto-sync silently stops for good.
        console.error(`watcher error for library ${library.id}: ${err.message}; will re-attempt`);
        this.scheduleRetry(library);
      });
      this.watchers.set(library.id, watcher);
      this.retryDelays.delete(library.id); // watching again: next failure starts from the short delay
    } catch (err) {
      // watch() itself failed (incl. a synchronous failure of a retry attempt);
      // keep retrying so one bad attempt doesn't stop auto-sync for good.
      console.error(`could not watch library ${library.id} (${library.root_path}): ${(err as Error).message}; will re-attempt`);
      this.scheduleRetry(library);
    }
  }

  // Backs off exponentially up to MAX_RETRY_MS. A root that is gone for good (an
  // unmounted drive) would otherwise re-attempt every debounce window forever and
  // fill the log; the cap keeps re-attaching cheap once the drive comes back.
  private scheduleRetry(library: Library): void {
    this.dropWatcher(library.id);
    const existing = this.retryTimers.get(library.id);
    if (existing) clearTimeout(existing);
    if (this.stopped) return;
    const delay = Math.min(this.retryDelays.get(library.id) ?? this.debounceMs, MAX_RETRY_MS);
    this.retryDelays.set(library.id, Math.min(delay * 2, MAX_RETRY_MS));
    const timer = setTimeout(() => {
      this.retryTimers.delete(library.id);
      this.watchLibrary(library);
    }, delay);
    this.retryTimers.set(library.id, timer);
  }

  private dropWatcher(libraryId: string): void {
    this.watchers.get(libraryId)?.close();
    this.watchers.delete(libraryId);
  }

  // Ignore the data dir (thumbnails/bin, where processing writes, so watching it
  // would loop), Bin folders, and hidden entries (incl. the sync lock file).
  private isRelevant(rootPath: string, dataDir: string, filename: string): boolean {
    const segments = filename.split(path.sep).join('/').split('/');
    if (segments.some((s) => s.startsWith('.') || s === 'Bin')) return false;
    const abs = path.resolve(rootPath, filename);
    return abs !== dataDir && !abs.startsWith(`${dataDir}${path.sep}`);
  }

  private record(libraryId: string, relPath: string): void {
    let set = this.pending.get(libraryId);
    if (set == null) {
      set = new Set();
      this.pending.set(libraryId, set);
    }
    set.add(relPath);
  }

  private schedule(libraryId: string): void {
    if (this.stopped) return;
    const existing = this.timers.get(libraryId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      libraryId,
      setTimeout(() => void this.run(libraryId), this.debounceMs),
    );
  }

  private async run(libraryId: string): Promise<void> {
    this.timers.delete(libraryId);
    if (this.syncing.has(libraryId)) {
      this.dirty.add(libraryId); // change arrived mid-sync: re-run afterwards (pending keeps accumulating)
      return;
    }
    // Consume the accumulated paths. A large batch (bulk import) or an empty set
    // (a dirty re-run that raced its own consume) falls back to a full sync.
    const paths = this.pending.get(libraryId) ?? new Set<string>();
    this.pending.delete(libraryId);
    const scope = paths.size > 0 && paths.size <= MAX_SCOPE ? [...paths] : undefined;

    this.syncing.add(libraryId);
    try {
      await this.sync.syncLibrary(libraryId, scope);
    } catch (err) {
      const code = err instanceof AppError ? err.code : null;
      // Lost the lock race to an external/manual sync whose scan may predate our
      // change: re-queue the paths and re-arm so the change isn't dropped (and stays
      // scoped) once the lock frees.
      if (code === 'SYNC_IN_PROGRESS') {
        for (const p of paths) this.record(libraryId, p);
        this.dirty.add(libraryId);
      }
      // NOT_FOUND = library deleted mid-flight (benign, no retry). Anything else is real.
      else if (code !== 'NOT_FOUND') console.error(`auto-sync failed for library ${libraryId}: ${(err as Error).message}`);
    } finally {
      this.syncing.delete(libraryId);
      if (this.dirty.delete(libraryId)) this.schedule(libraryId);
    }
  }
}
