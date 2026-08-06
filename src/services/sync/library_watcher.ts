import watcher, { type AsyncSubscription } from '@parcel/watcher';
import { statSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import type { Library } from '../../schemas/libraries';
import { isSupportedFile } from '../../utils/scan';
import { isPathAllowed, type LibraryScope } from '../../utils/scope';
import { getBinPath } from '../../utils/paths';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { LibraryLifecycleListener } from '../libraries/libraries_service';
import type { SyncService } from './sync_service';

type Timer = ReturnType<typeof setTimeout>;

const log = new Logger('watcher');

// Above this many distinct changed paths in one debounce window, a scoped sync's
// IN(...) clause and per-path work stop being cheaper than a full walk (a bulk
// import), so fall back to a full sync.
const MAX_SCOPE = 256;

// Ceiling for the watch-retry backoff (§9.8): long enough that a permanently
// absent root costs nothing, short enough to pick a returning drive up promptly.
const MAX_RETRY_MS = 5 * 60 * 1000;

// How many paths a log line names before it just says how many there were.
const SAMPLE = 5;

// Watches each library root and triggers a debounced sync when its files change
// on disk. Reactive counterpart to the on-demand POST /sync (DESIGN §9). Change
// detection stays with sync; the watcher only decides *when* to run it, and for
// which paths.
//
// `@parcel/watcher` rather than node:fs or chokidar (§9.8), for two measured
// reasons: it names the *destination* of a move, which fs.watch never does, and
// it takes one inotify watch per directory rather than one per file, which is
// what put chokidar 40x over a real library's watch budget.
export class LibraryWatcher implements LibraryLifecycleListener {
  private readonly watchers = new Map<string, AsyncSubscription>();
  private readonly timers = new Map<string, Timer>();
  private readonly retryTimers = new Map<string, Timer>();
  private readonly retryDelays = new Map<string, number>();
  private readonly syncing = new Set<string>();
  private readonly dirty = new Set<string>();
  // Changed relative paths accumulated per library during the debounce window; the
  // next run() reconciles just these (scoped sync) instead of the whole library.
  private readonly pending = new Map<string, Set<string>>();
  // Establishing a watch reads the tree, so it settles a moment after start().
  // Held so a caller (and the tests) can wait for it rather than sleeping.
  private readonly ready = new Map<string, Promise<void>>();
  // What each library was watched with, so a settings change only re-establishes
  // the watch when it actually changed what the library contains.
  private readonly watchedScopes = new Map<string, string>();
  private stopped = false;

  constructor(
    private readonly libraries: LibrariesRepository,
    private readonly sync: SyncService,
    private debounceMs: number,
  ) {}

  start(): void {
    this.stopped = false;
    for (const library of this.libraries.list()) this.watchLibrary(library);
  }

  /** Settles once every library established at the last start() is being watched. */
  async whenReady(): Promise<void> {
    await Promise.all(this.ready.values());
  }

  /** Applies changed settings (§15) without a restart. */
  configure(enabled: boolean, debounceMs: number): void {
    this.debounceMs = debounceMs;
    if (enabled) this.start();
    else this.stop();
  }

  stop(): void {
    // Set before clearing so an in-flight run()'s finally can't reschedule a sync
    // (or a retry timer fire and re-establish a watcher) after teardown.
    this.stopped = true;
    for (const [id, sub] of this.watchers) void this.close(id, sub);
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.watchers.clear();
    this.ready.clear();
    this.watchedScopes.clear();
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

  // Re-establishing a watch re-reads the whole tree, so it is done only when the
  // settings that decide what is watched actually moved. Every other library
  // setting (a name, an ordering, what renditions to build) leaves it alone.
  onLibraryUpdated(library: Library): void {
    if (!this.watchers.has(library.id) && !this.ready.has(library.id)) return;
    if (this.watchedScopes.get(library.id) === scopeKey(this.sync.scopeFor(library))) return;
    this.dropWatcher(library.id);
    this.watchLibrary(library);
  }

  private watchLibrary(library: Library): void {
    if (this.stopped || this.watchers.has(library.id) || this.ready.has(library.id)) return;
    // A queued watch-error retry can land after the library was deleted; without
    // this, watchLibrary would re-create a live watcher (leaked inotify handles +
    // spurious syncs) that onLibraryDeleted can never tear down again.
    if (!this.libraries.getById(library.id)) return;
    const scope = this.sync.scopeFor(library);
    this.watchedScopes.set(library.id, scopeKey(scope));

    const establishing = watcher
      .subscribe(
        library.root_path,
        (err, events) => {
          if (err != null) {
            // A watch error (e.g. inotify ENOSPC) kills this watch; drop it and
            // try to re-establish after a delay, else auto-sync stops for good.
            log.error('watch dropped; will re-attempt', { library: library.id, err });
            this.scheduleRetry(library);
            return;
          }
          let recorded = 0;
          for (const event of events) {
            const relPath = path.relative(library.root_path, event.path).split(path.sep).join('/');
            if (relPath === '' || relPath.startsWith('..')) continue;
            if (!this.inScope(scope, relPath)) continue;
            if (this.isIgnorableFile(event.path, relPath)) continue;
            this.record(library.id, relPath);
            recorded++;
          }
          // Nothing the library contains moved, so nothing is owed a sync. Scheduling
          // regardless is what made a sync's own lock file at the root wake the very
          // watcher that wrote it, every debounce window, forever.
          if (recorded === 0) {
            log.debug('fs events, none in scope', { library: library.id, events: describe(events, library.root_path) });
            return;
          }
          log.info('fs events', {
            library: library.id,
            recorded,
            ignored: events.length - recorded,
            events: describe(events, library.root_path),
          });
          this.schedule(library.id);
        },
        {
          // Excluded subtrees are never watched rather than filtered afterwards,
          // which is the difference between a folder costing nothing and costing
          // an inotify watch per directory inside it. The callback still applies
          // the scan's rules (§9.1), so this is an optimisation and not the
          // correctness boundary.
          ignore: this.ignoredPaths(library, scope),
        },
      )
      .then((sub) => {
        // Torn down while the walk was in flight: nothing is holding this
        // subscription any more, so it would leak its watches.
        if (this.stopped || !this.libraries.getById(library.id)) {
          void sub.unsubscribe();
          return;
        }
        this.watchers.set(library.id, sub);
        log.info('watching', { library: library.id, root: library.root_path });
        this.retryDelays.delete(library.id); // watching again: next failure starts from the short delay
      })
      .catch((err: unknown) => {
        // Includes a root that is not there at all, which is an unmounted drive
        // rather than a permanent condition.
        log.error('could not watch; will re-attempt', { library: library.id, root: library.root_path, err });
        this.scheduleRetry(library);
      })
      .finally(() => {
        this.ready.delete(library.id);
      });

    this.ready.set(library.id, establishing);
  }

  // Absolute paths kept out of the walk entirely. The per-event check below is
  // what makes the rules hold; this is what makes them cheap.
  private ignoredPaths(library: Library, scope: LibraryScope): string[] {
    // The bin belongs here for the same reason an excluded folder does, and more
    // so: it is one known path (§12.3) that only ever grows, mirroring the whole
    // folder tree as photographs are binned, and nothing inside it is ever the
    // library's to look at.
    const ignored = [path.join(library.root_path, '.bowerbird'), getBinPath(library)];
    for (const folder of scope.excluded) ignored.push(path.join(library.root_path, folder));
    return ignored;
  }

  // A path may name a file or a folder and the event does not say which, so this
  // asks only what holds either way (§9.1). The one rule that does need to know
  // is applied to files alone: a root-only library has no interest in anything
  // below its root, and a stray folder path costs nothing downstream because the
  // scoped sync tests it with `isDirInScope` before reading it.
  private inScope(scope: LibraryScope, relPath: string): boolean {
    if (!isPathAllowed(scope, relPath)) return false;
    return scope.includeSubfolders || !relPath.includes('/');
  }

  // A file the library will never hold: a text file, a sidecar, a JPEG export
  // saved beside the raws. Reconciling it costs a whole directory read (the scoped
  // sync has to find the far half of a possible move) to conclude it was never a
  // photograph, so the question is settled here instead, where one stat answers it.
  //
  // Only asked of paths whose extension is not one of ours, so a bulk import stats
  // nothing extra. A folder always passes: an empty one's rename reports no other
  // event at all, and dropping it would lose the shoot relocation (§9.4.1). So does
  // a path that is already gone, which is a deletion and could have been either.
  private isIgnorableFile(absPath: string, relPath: string): boolean {
    if (isSupportedFile(relPath)) return false;
    return statSync(absPath, { throwIfNoEntry: false })?.isFile() === true;
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
    const sub = this.watchers.get(libraryId);
    if (sub != null) void this.close(libraryId, sub);
    this.watchers.delete(libraryId);
    this.ready.delete(libraryId);
    this.watchedScopes.delete(libraryId);
  }

  private async close(libraryId: string, sub: AsyncSubscription): Promise<void> {
    try {
      await sub.unsubscribe();
    } catch (err) {
      log.warn('could not release a watch', { library: libraryId, err });
    }
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
    log.info('files changed on disk; starting sync', {
      library: libraryId,
      changed: paths.size,
      mode: scope == null ? 'full' : 'scoped',
      paths: [...paths].slice(0, SAMPLE),
    });
    try {
      await this.sync.syncLibrary(libraryId, scope, 'watcher');
    } catch (err) {
      const code = err instanceof AppError ? err.code : null;
      // Lost the lock race to an external/manual sync whose scan may predate our
      // change: re-queue the paths and re-arm so the change isn't dropped (and stays
      // scoped) once the lock frees.
      if (code === 'SYNC_IN_PROGRESS') {
        for (const p of paths) this.record(libraryId, p);
        this.dirty.add(libraryId);
        log.debug('another sync holds the lock; re-queued', { library: libraryId, changed: paths.size });
      }
      // NOT_FOUND = library deleted mid-flight (benign, no retry). Anything else is real.
      else if (code !== 'NOT_FOUND') log.error('auto-sync failed', { library: libraryId, err });
    } finally {
      this.syncing.delete(libraryId);
      if (this.dirty.delete(libraryId)) this.schedule(libraryId);
    }
  }
}

// A bulk import delivers thousands of events at once, and a log line per path
// would bury the counts beside it. The sample is what makes an unexplained sync
// explainable; the count is what says how big it was.
function describe(events: readonly { type: string; path: string }[], rootPath: string): string[] {
  return events.slice(0, SAMPLE).map((e) => `${e.type} ${path.relative(rootPath, e.path)}`);
}

// What the watch was established with, so a settings change can be compared
// against it. Only the parts that decide which paths are watched.
function scopeKey(scope: LibraryScope): string {
  return `${scope.includeSubfolders ? 1 : 0}|${scope.binName}|${[...scope.excluded].sort().join(',')}`;
}
