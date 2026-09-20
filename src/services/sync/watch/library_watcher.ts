import { statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../../errors';
import { Logger } from '../../../logger';
import type { Library } from '../../../schemas/libraries';
import { mountFsType, reportsFileEvents } from '../../../utils/fstype';
import { importsFormat } from '../../../utils/scan';
import { isDirInScope, isPathAllowed, type LibraryScope } from '../../../utils/scope';
import { getBinPath } from '../../../utils/paths';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { LibraryLifecycleListener } from '../../libraries/libraries_service';
import type { ScanService } from '../scan/scan_service';
import { subscribe, type Subscription } from './watch_backend';

type Timer = ReturnType<typeof setTimeout>;

const log = new Logger('watcher');

// Above this many distinct changed paths in one debounce window, a scoped scan's
// IN(...) clause and per-path work stop being cheaper than a full walk (a bulk
// import), so fall back to a full scan.
const MAX_SCOPE = 256;

// Ceiling for the watch-retry backoff (§9.8): long enough that a permanently
// absent root costs nothing, short enough to pick a returning drive up promptly.
const MAX_RETRY_MS = 5 * 60 * 1000;

// How many paths a log line names before it just says how many there were.
const SAMPLE = 5;

// Watches each library root and triggers a debounced scan when its files change
// on disk. Reactive counterpart to the on-demand POST /sync (DESIGN §9). Change
// detection stays with scan; the watcher only decides *when* to run it, and for
// which paths.
//
// Who does the watching is `watch_backend.ts`'s question, not this file's.
//
// A library on a filesystem that delivers no events is polled instead (§9.8), and
// the two never both run for one library: which it gets is decided per library
// from what its root is mounted on.
export class LibraryWatcher implements LibraryLifecycleListener {
  private readonly watchers = new Map<string, Subscription>();
  private readonly timers = new Map<string, Timer>();
  private readonly retryTimers = new Map<string, Timer>();
  private readonly retryDelays = new Map<string, number>();
  private readonly scanning = new Set<string>();
  private readonly dirty = new Set<string>();
  // Changed relative paths accumulated per library during the debounce window; the
  // next run() reconciles just these (scoped scan) instead of the whole library.
  private readonly pending = new Map<string, Set<string>>();
  // The same, for a polled library, whose unit is the folder: a poll sees that a
  // folder's contents moved and cannot see which of them.
  private readonly pendingDirs = new Map<string, Set<string>>();
  // Establishing a watch reads the tree, so it settles a moment after start().
  // Held so a caller (and the tests) can wait for it rather than sleeping. A
  // polled library settles once its first pass has a baseline to compare against.
  private readonly ready = new Map<string, Promise<void>>();
  // What each library was watched with, so a settings change only re-establishes
  // the watch when it actually changed what the library contains.
  private readonly watchedScopes = new Map<string, string>();
  // The polled libraries and the scope each is walked with. This rather than the
  // timer decides whether one is polled: the timer is absent for the length of
  // every pass, and a start() landing in that gap would otherwise start a second.
  //
  // The scope object's *identity* is the loop's generation, which is what a pass
  // resuming from an await tests before it does anything. Membership alone is not
  // enough: onLibraryUpdated drops the loop and starts a new one synchronously, so
  // by the time the dropped pass resumes the library is polled again - by someone
  // else - and a pass that read presence would clobber the new baseline and re-arm
  // a second timer that nothing can reach to cancel.
  private readonly polled = new Map<string, LibraryScope>();
  private readonly pollTimers = new Map<string, Timer>();
  private readonly dirMtimes = new Map<string, Map<string, number>>();
  private stopped = false;

  constructor(
    private readonly libraries: LibrariesRepository,
    private readonly scan: ScanService,
    private debounceMs: number,
    private pollIntervalMs: number,
    private readonly fsTypeOf: (absPath: string) => string | null = mountFsType,
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
  configure(enabled: boolean, debounceMs: number, pollIntervalMs: number): void {
    this.debounceMs = debounceMs;
    this.pollIntervalMs = pollIntervalMs;
    if (enabled) this.start();
    else this.stop();
  }

  stop(): void {
    // Set before clearing so an in-flight run()'s finally can't reschedule a scan
    // (or a retry timer fire and re-establish a watcher) after teardown.
    this.stopped = true;
    for (const [id, sub] of this.watchers) void this.close(id, sub);
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    for (const timer of this.pollTimers.values()) clearTimeout(timer);
    this.watchers.clear();
    this.ready.clear();
    this.watchedScopes.clear();
    this.timers.clear();
    this.retryTimers.clear();
    this.retryDelays.clear();
    this.pending.clear();
    this.pendingDirs.clear();
    this.polled.clear();
    this.pollTimers.clear();
    this.dirMtimes.clear();
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
    this.scanning.delete(libraryId);
    this.dirty.delete(libraryId);
    this.pending.delete(libraryId);
    this.pendingDirs.delete(libraryId);
  }

  // Re-establishing a watch re-reads the whole tree, so it is done only when the
  // settings that decide what is watched actually moved. Every other library
  // setting (a name, an ordering, what renditions to build) leaves it alone.
  onLibraryUpdated(library: Library): void {
    if (!this.watchers.has(library.id) && !this.ready.has(library.id) && !this.polled.has(library.id)) return;
    if (this.watchedScopes.get(library.id) === scopeKey(this.scan.scopeFor(library))) return;
    this.dropWatcher(library.id);
    this.watchLibrary(library);
  }

  private watchLibrary(asked: Library): void {
    if (this.stopped || this.watchers.has(asked.id) || this.ready.has(asked.id) || this.polled.has(asked.id)) return;
    // A queued watch-error retry can land after the library was deleted; without
    // this, watchLibrary would re-create a live watcher (leaked inotify handles +
    // spurious syncs) that onLibraryDeleted can never tear down again.
    //
    // And the row is *used* rather than only tested, because a retry carries the
    // library as it was when the watch dropped. While one is pending this library
    // is in neither `watchers` nor `ready`, so `onLibraryUpdated` returns early
    // and a settings change made in that window is dropped - after which the
    // retry re-establishes the old scope and it stays wrong until a restart.
    const library = this.libraries.getById(asked.id);
    if (library == null) return;
    const scope = this.scan.scopeFor(library);
    this.watchedScopes.set(library.id, scopeKey(scope));

    const fsType = this.fsTypeOf(library.root_path);
    if (fsType != null && !reportsFileEvents(fsType)) {
      this.pollLibrary(library, scope, fsType);
      return;
    }

    const establishing = subscribe(
      library.root_path,
      (err, events) => {
        if (err != null) {
          // A watch error (e.g. inotify ENOSPC) kills this watch; drop it and
          // try to re-establish after a delay, else auto-scan stops for good.
          log.error('watch dropped; will re-attempt', { library: library.id, err });
          this.scheduleRetry(library);
          return;
        }
        let recorded = 0;
        for (const event of events) {
          const relPath = path.relative(library.root_path, event.path).split(path.sep).join('/');
          if (relPath === '' || relPath.startsWith('..')) continue;
          if (!this.inScope(scope, relPath)) continue;
          if (this.isIgnorableFile(scope, event.path, relPath)) continue;
          this.record(library.id, relPath);
          recorded++;
        }
        // Nothing the library contains moved, so nothing is owed a scan. Scheduling
        // regardless is what made a scan's own lock file at the root wake the very
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
      .then((sub: Subscription) => {
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

  // A library whose root is on a filesystem that answers no watch (§9.8): every
  // pass reads the mtime of each folder it contains and hands the ones that moved
  // to a scoped scan. Only folders, never files - a folder's mtime moves when
  // something is added to it, removed from it or renamed in it, so the whole tree
  // is one stat and one readdir per folder rather than a stat per photograph, and
  // the difference is a hundredfold on a real library.
  //
  // What this cannot see is a file rewritten in place under an unchanged name,
  // which moves no folder's mtime. The daily full reconcile is what catches those,
  // as it is for the events a watch drops.
  private pollLibrary(library: Library, scope: LibraryScope, fsType: string): void {
    log.info('polling; this filesystem reports no file events', {
      library: library.id,
      root: library.root_path,
      fs: fsType,
      everyMs: this.pollIntervalMs,
    });
    this.polled.set(library.id, scope);
    this.dirMtimes.delete(library.id);
    // The first pass only records what is there, so `whenReady` settling means the
    // next change is one this can see rather than one it will report as the whole
    // library having appeared at once.
    const baseline = this.poll(library.id, scope).finally(() => {
      this.ready.delete(library.id);
    });
    this.ready.set(library.id, baseline);
  }

  private schedulePoll(libraryId: string, scope: LibraryScope): void {
    if (this.stopped) return;
    this.pollTimers.set(
      libraryId,
      setTimeout(() => void this.poll(libraryId, scope), this.pollIntervalMs),
    );
  }

  // Re-armed at the end of each pass rather than on an interval, so a walk slower
  // than the interval - or a scan that follows it - is never overlapped by the
  // next one.
  private async poll(libraryId: string, scope: LibraryScope): Promise<void> {
    this.pollTimers.delete(libraryId);
    try {
      const seen = await this.folderMtimes(scope);
      if (this.stopped || this.polled.get(libraryId) !== scope) return;
      const previous = this.dirMtimes.get(libraryId);
      this.dirMtimes.set(libraryId, seen);
      for (const relDir of changedFolders(previous, seen)) this.recordDir(libraryId, relDir);
      // Anything left over from a pass whose scan lost the lock is in here too, so
      // this is what re-attempts it rather than a timer of its own.
      const pending = this.pendingDirs.get(libraryId);
      if (pending == null || pending.size === 0) return;
      log.info('folders changed on disk; starting scan', {
        library: libraryId,
        changed: pending.size,
        folders: [...pending].slice(0, SAMPLE),
      });
      await this.run(libraryId);
    } catch (err) {
      log.error('a poll pass failed', { library: libraryId, err });
    } finally {
      if (!this.stopped && this.polled.get(libraryId) === scope) this.schedulePoll(libraryId, scope);
    }
  }

  // Every folder the library contains, and when each last changed. Skipped
  // subtrees are never descended into, which is the same trade the watch's ignore
  // list makes: an excluded folder costs nothing rather than costing a stat per
  // folder inside it.
  private async folderMtimes(scope: LibraryScope): Promise<Map<string, number>> {
    const mtimes = new Map<string, number>();
    const queue = [''];
    while (queue.length > 0) {
      const relDir = queue.pop() as string;
      const absDir = path.join(scope.rootPath, relDir);
      const stats = await stat(absDir).catch(() => null);
      if (stats == null) continue;
      mtimes.set(relDir, stats.mtimeMs);
      const entries = await readdir(absDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        if (isDirInScope(scope, child)) queue.push(child);
      }
    }
    return mtimes;
  }

  // Absolute paths kept out of the walk entirely. The per-event check below is
  // what makes the rules hold; this is what makes them cheap.
  private ignoredPaths(library: Library, scope: LibraryScope): string[] {
    // The bin belongs here for the same reason an excluded folder does, and more
    // so: it is one known path (DESIGN §12.3) that only ever grows, mirroring the
    // whole folder tree as photographs are binned. Not because nothing in it
    // matters - the nightly full scan walks it (DESIGN §9.1.1) - but because
    // watching a tree that only grows costs an inotify handle per directory to
    // learn what that walk is going to read anyway.
    // A library with no bin has nothing to ignore there (§4.1).
    //
    // `.bowerbird` is a *legacy* tree, not the data directory: generated files
    // live outside the root now (§6). The per-event check skips it as a dotfolder
    // either way, so this only keeps an old rendition tree - as many directories
    // as the library has folders - from costing an inotify handle apiece to watch
    // and then discard.
    const bin = getBinPath(library);
    const ignored = [path.join(library.root_path, '.bowerbird'), ...(bin == null ? [] : [bin])];
    for (const folder of scope.excluded) ignored.push(path.join(library.root_path, folder));
    return ignored;
  }

  // A path may name a file or a folder and the event does not say which, so this
  // asks only what holds either way (§9.1). The one rule that does need to know
  // is applied to files alone: a root-only library has no interest in anything
  // below its root, and a stray folder path costs nothing downstream because the
  // scoped scan tests it with `isDirInScope` before reading it.
  private inScope(scope: LibraryScope, relPath: string): boolean {
    if (!isPathAllowed(scope, relPath)) return false;
    return scope.includeSubfolders || !relPath.includes('/');
  }

  // A file the library will never hold: a text file, a sidecar, a JPEG export
  // saved beside the raws. Reconciling it costs a whole directory read (the scoped
  // scan has to find the far half of a possible move) to conclude it was never a
  // photograph, so the question is settled here instead, where one stat answers it.
  //
  // Only asked of paths whose extension is not one of ours, so a bulk import stats
  // nothing extra. A folder always passes: an empty one's rename reports no other
  // event at all, and dropping it would lose the shoot relocation (§9.4.1). So does
  // a path that is already gone, which is a deletion and could have been either.
  private isIgnorableFile(scope: LibraryScope, absPath: string, relPath: string): boolean {
    if (importsFormat(scope, relPath)) return false;
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
    const poll = this.pollTimers.get(libraryId);
    if (poll) clearTimeout(poll);
    this.pollTimers.delete(libraryId);
    // Dropped before the in-flight pass finishes: `polled` is what its finally
    // re-arms on, and what a fresh watchLibrary tests before starting a second.
    this.polled.delete(libraryId);
    this.dirMtimes.delete(libraryId);
  }

  private async close(libraryId: string, sub: Subscription): Promise<void> {
    try {
      await sub.unsubscribe();
    } catch (err) {
      log.warn('could not release a watch', { library: libraryId, err });
    }
  }

  private record(libraryId: string, relPath: string): void {
    add(this.pending, libraryId, relPath);
  }

  private recordDir(libraryId: string, relDir: string): void {
    add(this.pendingDirs, libraryId, relDir);
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
    if (this.scanning.has(libraryId)) {
      this.dirty.add(libraryId); // change arrived mid-scan: re-run afterwards (pending keeps accumulating)
      return;
    }
    // Consume the accumulated paths. A large batch (bulk import) or an empty set
    // (a dirty re-run that raced its own consume) falls back to a full scan.
    const paths = this.pending.get(libraryId) ?? new Set<string>();
    const dirs = this.pendingDirs.get(libraryId) ?? new Set<string>();
    this.pending.delete(libraryId);
    this.pendingDirs.delete(libraryId);
    const changed = paths.size + dirs.size;
    const scope = changed > 0 && changed <= MAX_SCOPE ? { paths: [...paths], dirs: [...dirs] } : undefined;

    this.scanning.add(libraryId);
    log.info('changes on disk; starting scan', {
      library: libraryId,
      changed,
      mode: scope == null ? 'full' : 'scoped',
      paths: [...paths, ...dirs].slice(0, SAMPLE),
    });
    try {
      await this.scan.scanLibrary(libraryId, scope, 'watcher');
    } catch (err) {
      const code = err instanceof AppError ? err.code : null;
      // Lost the lock race to an external/manual scan whose scan may predate our
      // change: re-queue the paths and re-arm so the change isn't dropped (and stays
      // scoped) once the lock frees.
      if (code === 'SYNC_IN_PROGRESS') {
        for (const p of paths) this.record(libraryId, p);
        for (const d of dirs) this.recordDir(libraryId, d);
        this.dirty.add(libraryId);
        log.debug('another scan holds the lock; re-queued', { library: libraryId, changed });
      }
      // NOT_FOUND = library deleted mid-flight (benign, no retry). Anything else is real.
      else if (code !== 'NOT_FOUND') log.error('auto-scan failed', { library: libraryId, err });
    } finally {
      this.scanning.delete(libraryId);
      // A polled library re-arms in its own pass, which still holds the folders
      // this run re-queued; a debounce timer on top of that would fire with
      // nothing left to reconcile and take the full-scan fallback.
      if (this.dirty.delete(libraryId) && !this.polled.has(libraryId)) this.schedule(libraryId);
    }
  }
}

function add(pending: Map<string, Set<string>>, libraryId: string, value: string): void {
  let set = pending.get(libraryId);
  if (set == null) {
    set = new Set();
    pending.set(libraryId, set);
  }
  set.add(value);
}

// A folder is changed if its mtime moved, if it was not there last time, or if it
// is not there now - the last being the only trace a deleted folder leaves, and
// what the scan needs in order to read its photographs as removed.
function changedFolders(previous: ReadonlyMap<string, number> | undefined, seen: ReadonlyMap<string, number>): string[] {
  if (previous == null) return [];
  const changed: string[] = [];
  for (const [relDir, mtime] of seen) if (previous.get(relDir) !== mtime) changed.push(relDir);
  for (const relDir of previous.keys()) if (!seen.has(relDir)) changed.push(relDir);
  return changed;
}

// A bulk import delivers thousands of events at once, and a log line per path
// would bury the counts beside it. The sample is what makes an unexplained scan
// explainable; the count is what says how big it was.
function describe(events: readonly { type: string; path: string }[], rootPath: string): string[] {
  return events.slice(0, SAMPLE).map((e) => `${e.type} ${path.relative(rootPath, e.path)}`);
}

// What the watch was established with, so a settings change can be compared
// against it. Only the parts that decide which paths are watched.
// Every field a live watcher's decisions read, because this is the only thing that tells one its
// scope has moved: a field left out here is a setting the user can change and the watcher will go
// on ignoring until the process restarts.
function scopeKey(scope: LibraryScope): string {
  return [
    scope.includeSubfolders ? 1 : 0,
    scope.includeNonRaw ? 1 : 0,
    scope.binName,
    [...scope.excluded].sort().join(','),
  ].join('|');
}
