import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import type { Library, LibrarySyncStatus } from '../../schemas/libraries';
import { isSupportedFile, scanLibraryTree, type ScannedDir, type ScannedFile } from '../../utils/scan';
import { isDirInScope, isFileInScope, libraryScope, type LibraryScope } from '../../utils/scope';
import { computeFileHash } from '../../utils/hash';
import { shootContains } from '../../utils/shoots';
import type { AlbumsRepository } from '../albums/albums_repository';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { LibraryLifecycleListener } from '../libraries/libraries_service';
import type { PhotosRepository, SyncDbPhoto } from '../photos/photos_repository';
import type { FolderRulesRepository } from '../shoots/folder_rules_repository';
import type { ShootsRepository } from '../shoots/shoots_repository';
import { extractMetadata, type FileMetadata } from '../processing/metadata';
import type { ProcessingScope } from '../processing/processing_service';
import {
  buildDiff,
  detectMoves,
  detectRelocationsByIdentity,
  detectShootRelocations,
  findBinByIdentity,
  type AddedEntry,
  type Crossing,
  type DiskFile,
  type MoveResult,
} from './sync_algorithm';
import { ensureBinFolder } from '../libraries/bin_folder';
import { libraryMutex } from './library_mutex';
import { LEASE_MS, type SyncLocksRepository } from './sync_locks_repository';

export interface ProcessingTrigger {
  processUnprocessed(scope?: ProcessingScope, stopped?: () => boolean): void | Promise<void>;
}

// Unwinds a stopped scan whose partial result cannot be applied, which is any
// run that had rows to reconcile against (§9.10). Never leaves this module:
// syncLibrary turns it back into an idle status, because that run applied nothing.
class SyncCancelled extends Error {}

const log = new Logger('sync');

// How many photos a first scan holds before writing them down. Small enough that
// a kill costs seconds of work rather than hours, large enough that the commit
// itself is nowhere near the cost of the decodes that filled it.
const INSERT_BATCH = 1000;

// How often a running scan says where it has got to. A 300k-frame import is
// hours of work, and a log that says nothing until it finishes is
// indistinguishable from one that has hung.
const SCAN_PROGRESS_EVERY = 500;

// How often a run refreshes its lease, driven by the work rather than by a timer:
// the scan and apply are synchronous, so a `setInterval` is starved precisely
// when the lease matters (§9.7). A third of the lease, so two missed refresh points
// still do not lose the lock.
const LEASE_REFRESH_MS = LEASE_MS / 3;

// What the detached rendition batch a run hands off covers, kept so the status
// endpoint can report progress against the same set the batch is working on.
interface ProcessingBatch {
  queued: number;
  /** The run's own photos, or null when the batch covers the whole library. */
  photoIds: readonly string[] | null;
}

export type MetadataExtractor = (absPath: string) => Promise<FileMetadata>;

/** Who asked for a run, so an unexplained sync in the log names its own cause. */
export type SyncTrigger = 'api' | 'watcher' | 'daily';

// Which shoots have to restate what they hold after mirroring made new ones, and
// in which order. A shoot's claim covers its whole subtree, so an ancestor's is a
// *superset* of its descendant's, not a duplicate of it: skipping the ancestor
// leaves the photographs sitting directly in that folder claimed by nobody, which
// nothing later repairs - the next sync has no new folders to react to. So every
// touched folder is issued, shallowest first, and the deeper claim lands last on
// the rows the two share.
//
// Only shoots at or under a newly created folder are in question at all; the rest
// of the library was already right, which is what keeps a library with nothing to
// mirror from rewriting a single row.
function claimsToRestate(created: readonly string[], byFolder: ReadonlyMap<string, string>): string[] {
  if (created.length === 0) return [];
  const isNew = new Set(created);

  // Walked by path segment rather than compared against every other folder:
  // mirroring creates as many folders as the library has, and "is any of these
  // under any of those" over both lists is quadratic in exactly the case this
  // runs in.
  const isTouched = (folder: string): boolean => {
    if (isNew.has(folder)) return true;
    let prefix = '';
    for (const segment of folder.split('/').slice(0, -1)) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      if (isNew.has(prefix)) return true;
    }
    return false;
  };

  return [...byFolder.keys()].filter(isTouched).sort((a, b) => a.split('/').length - b.split('/').length);
}

type Status = LibrarySyncStatus['status'];

function idle(libraryId: string, status: Status = 'idle'): LibrarySyncStatus {
  return {
    library_id: libraryId,
    status,
    photos_to_scan: 0,
    photos_scanned: 0,
    photos_added: 0,
    photos_removed: 0,
    photos_moved: 0,
    photos_modified: 0,
    photos_processing: 0,
    photos_processed: 0,
  };
}

export class SyncService implements LibraryLifecycleListener {
  private readonly statuses = new Map<string, LibrarySyncStatus>();
  // What this library's current run queued for rendition building. Held so
  // getSyncStatus can report processed = queued - still-pending without any
  // background bookkeeping: the live pending count comes from the DB on read.
  private readonly processingBatch = new Map<string, ProcessingBatch>();
  private readonly settledListeners = new Set<(libraryId: string, changed: boolean) => void>();
  private readonly libraryChangedListeners = new Set<(library: Library) => void>();
  // Identity token per in-flight sync generation, and the handle that stops it.
  // The lease is released before the detached processing runs, so a newer sync can
  // start while the old one's processing tail is still going; the token lets a
  // stale tail skip its status write instead of stomping the newer generation's.
  private readonly generation = new Map<string, AbortController>();

  constructor(
    private readonly photos: PhotosRepository,
    private readonly libraries: LibrariesRepository,
    private readonly albums: AlbumsRepository,
    private readonly shoots: ShootsRepository,
    private readonly folderRules: FolderRulesRepository,
    private readonly syncLocks: SyncLocksRepository,
    private readonly processing: ProcessingTrigger,
    private readonly extract: MetadataExtractor = extractMetadata,
  ) {}

  // What this library contains, in the form the scan and the watcher both read
  // (§9.1). Built per run: a folder rule set between two syncs takes effect on
  // the next one without anything having to invalidate a cache.
  scopeFor(library: Library): LibraryScope {
    return libraryScope(library, this.folderRules.pathsWithRule(library.id, 'excluded'));
  }

  onLibraryCreated(_library: Library): void {
    // No action: sync is triggered on demand (POST /sync) or by the watcher.
  }

  // Drop the deleted library's in-memory status/generation so those maps don't
  // grow unbounded across create/delete cycles (mirrors the watcher's teardown).
  onLibraryDeleted(libraryId: string): void {
    this.generation.get(libraryId)?.abort(); // its rows are cascade-gone; finish nothing
    this.statuses.delete(libraryId);
    this.generation.delete(libraryId);
    this.processingBatch.delete(libraryId);
  }

  /**
   * Called when a sync and the processing it queued have both finished, with
   * whether that sync actually brought anything in.
   *
   * `changed` is the guard a listener needs rather than a nicety: file watching
   * is on by default, so a save in a watched folder starts a scoped sync, and a
   * listener that walks the whole library would then do so every couple of
   * seconds while somebody is working in it.
   */
  onSettled(listener: (libraryId: string, changed: boolean) => void): void {
    this.settledListeners.add(listener);
  }

  /**
   * Called when a sync wrote a library's own row, which today means following a
   * renamed bin folder (§9.1.1). The watcher builds its ignore list from
   * `bin_name`, so without this it goes on ignoring a folder that is not there
   * and watching the one that is - after which every binning wakes a sync, and a
   * scoped sync over bin paths reads them as unclaimed live additions.
   */
  onLibraryChanged(listener: (library: Library) => void): void {
    this.libraryChangedListeners.add(listener);
  }

  async syncAll(): Promise<void> {
    // Reclaim is by expiry now (§9.7), so a container killed and restarted within
    // seconds finds its own dead run still holding the lease. Skipping silently
    // would drop that library until tomorrow, so the ones that were locked are
    // re-attempted at the end of the loop.
    const skipped: string[] = [];
    for (const library of this.libraries.list()) {
      if (!(await this.syncOne(library.id))) skipped.push(library.id);
    }
    if (skipped.length === 0) return;

    // **Waited out, not retried straight away.** The lease that refused these is
    // reclaimable at a stated instant, and a retry before it is refused for
    // exactly the reason the first attempt was - which made the re-attempt a
    // no-op in the one case it exists for, a dead process whose row has not
    // expired yet. Bounded by one lease, and skipped entirely when the loop
    // already took that long or the holder has since released.
    const reclaimable = skipped
      .map((libraryId) => this.syncLocks.expiresAt(libraryId)?.getTime())
      .filter((at): at is number => at != null);
    const waitFor = Math.min(reclaimable.length === 0 ? 0 : Math.max(...reclaimable) - Date.now(), LEASE_MS);
    if (waitFor > 0) {
      log.info('waiting for a held sync lease before re-attempting', { libraries: skipped.length, ms: waitFor });
      await Bun.sleep(waitFor);
    }
    for (const libraryId of skipped) await this.syncOne(libraryId);
  }

  /** False when the library was locked; every other failure is logged and swallowed. */
  private async syncOne(libraryId: string): Promise<boolean> {
    try {
      await this.syncLibrary(libraryId, undefined, 'daily');
      return true;
    } catch (err) {
      // Never let one library abort the batch (§9.7).
      if (err instanceof AppError && err.code === 'SYNC_IN_PROGRESS') return false;
      log.error('library failed during syncAll', { library: libraryId, err });
      return true;
    }
  }

  // Keeps this run's lease alive across a stretch of synchronous work, throttled
  // so a per-file call costs a clock read (§9.7).
  private leaseKeeper(libraryId: string, owner: string): () => void {
    let refreshedAt = Date.now();
    return () => {
      const now = Date.now();
      if (now - refreshedAt < LEASE_REFRESH_MS) return;
      refreshedAt = now;
      this.syncLocks.refresh(libraryId, owner, new Date(now));
    };
  }

  // The fifth blocking stretch, and the only one where a timer is the right
  // instrument: the lease is taken before `libraryMutex` (§9.9), and waiting for
  // it is genuinely idle - a bin of 20k photographs holds that mutex for minutes
  // while this run has done no work to hang a refresh off. Left uncovered, the
  // run's lease lapses in the queue, a second sync takes it, and this one throws
  // its whole completed scan away at the apply's owner check.
  private holdLeaseWhileQueued(libraryId: string, owner: string): () => void {
    const timer = setInterval(() => this.syncLocks.refresh(libraryId, owner), LEASE_REFRESH_MS);
    // Node keeps the process alive for a pending interval, and a sync must not.
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // The one stretch no refresh point can reach is the apply itself, so it re-reads
  // the owner as its first statement and rolls back on a mismatch. BEGIN IMMEDIATE
  // because a leading SELECT in a deferred transaction takes the read snapshot
  // there, and the first write would then have to upgrade - returning
  // SQLITE_BUSY_SNAPSHOT, which `busy_timeout` does not retry.
  private applyOwned<T>(libraryId: string, owner: string, fn: () => T): T {
    return this.photos.immediateTransaction(() => {
      if (this.syncLocks.ownerOf(libraryId) !== owner) {
        throw new AppError('SYNC_IN_PROGRESS', 'this sync lost its lease to a newer run');
      }
      return fn();
    });
  }

  // A full sync (scopePaths omitted) walks the whole tree. A scoped sync (from the
  // watcher) reconciles only the given changed paths against their DB rows plus the
  // already-missing move-source pool, cheap, and move-detection still resolves a
  // relocation because both the removed old path and the added new path land in one
  // debounce batch, or pair across syncs via the missing pool (§9.3). The periodic
  // full sync (syncAll) is the backstop for events the watcher dropped.
  async syncLibrary(
    libraryId: string,
    scopePaths?: readonly string[],
    trigger: SyncTrigger = 'api',
  ): Promise<LibrarySyncStatus> {
    // Only to fail fast and to name the root in the log. The row this run reads
    // its paths from is taken inside the mutex, below.
    const known = this.libraries.getById(libraryId);
    if (!known) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);

    log.info('sync start', {
      library: libraryId,
      root: known.root_path,
      trigger,
      mode: scopePaths == null ? 'full' : 'scoped',
      paths: scopePaths?.length,
    });
    const startedAt = Date.now();
    const owner = randomUUID();
    if (!this.syncLocks.acquire(libraryId, owner)) {
      throw new AppError('SYNC_IN_PROGRESS', 'a sync is already running for this library');
    }
    const keepLease = this.leaseKeeper(libraryId, owner);
    // Cleared as soon as the mutex lets this run in, and again in `finally` for
    // the paths that never get there.
    let stopHolding = this.holdLeaseWhileQueued(libraryId, owner);
    const token = new AbortController();
    this.generation.set(libraryId, token);
    // Before the first await: rebuild jobs only gate on in-memory status, and the
    // lease alone is not enough for them - they do not hold it for the whole run.
    // Leaving 'idle' until inside `libraryMutex.run` let a rebuild replace this
    // generation in the gap, after which this run's settle no-ops and the strip
    // can stick on 'processing'.
    this.statuses.set(libraryId, idle(libraryId, 'scanning'));
    let syncedStatus: LibrarySyncStatus | null = null;
    // The photos this run created or rewrote, for a scoped run to hand its
    // rendition batch. Null once the run is a full one, whose batch is the
    // library's whole backlog.
    let processingIds: readonly string[] | null = null;
    try {
      // Inside the mutex, outside the lease: the lease first keeps sync-vs-sync
      // fail-fast (409), while the mutex makes file-moving mutations queue behind
      // this scan instead of invalidating its snapshot mid-flight.
      const synced = await libraryMutex.run(libraryId, async () => {
      stopHolding();
      stopHolding = () => {};
      // Re-read here, not from the snapshot taken before the mutex: `bin_name` is
      // renameable (§4.1), and every path this run derives from it - the scope's
      // skip rule, the bin walk, the resident/in-place split - would otherwise be
      // built from a name the rename has already moved off.
      const library = this.libraries.getById(libraryId);
      if (library == null) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
      this.statuses.set(libraryId, idle(libraryId, 'scanning'));

      // The scan is the long half of an import, and the status endpoint is the
      // only thing that can say so while it runs. No generation guard: the lease
      // is not released until after the scan, so nothing newer can exist.
      const reportScan = (scanned: number, toScan: number): void => {
        keepLease();
        this.statuses.set(libraryId, { ...idle(libraryId, 'scanning'), photos_to_scan: toScan, photos_scanned: scanned });
        if (scanned > 0 && scanned % SCAN_PROGRESS_EVERY === 0) {
          log.info('scanning', { library: libraryId, scanned, of: toScan, ms: Date.now() - startedAt });
        }
      };
      // Read before the scan rather than after it: a first scan places its photos
      // as it goes, so it needs the shoots up front. The mutex holds them still
      // for the whole run (§9.9). A shoot relocation would rewrite these paths
      // mid-run, but that takes existing photos to move, and a first scan has none.
      const shoots = this.shoots.listFolders(libraryId);
      // A photo's shoot is the deepest of its ancestor folders that has one, so
      // it is a handful of map lookups rather than a walk of every shoot. With a
      // shoot per folder the walk was 20,000 comparisons per photo, which is
      // minutes of blocked event loop across a large import.
      const byFolder = new Map(shoots.map((s) => [s.folder_path, s.id]));
      const shootFor = (relPath: string): string | null => {
        const segments = relPath.split('/');
        let prefix = '';
        let deepest: string | null = null;
        for (const segment of segments.slice(0, -1)) {
          prefix = prefix === '' ? segment : `${prefix}/${segment}`;
          deepest = byFolder.get(prefix) ?? deepest;
        }
        return deepest;
      };

      // Only a scoped run collects them: a full run hands its batch the library
      // rather than a list, and a 300k-frame import has no reason to hold every
      // id it created.
      const touched: string[] | null = scopePaths != null ? [] : null;
      const insertPhoto = (entry: AddedEntry, addedAt: string): void => {
        const id = this.insertAdded(libraryId, entry, shootFor(entry.filePath), addedAt);
        touched?.push(id);
      };
      let added = 0;
      // A first scan writes its photos down in batches instead of holding the lot
      // until the end (§9.4). Its whole diff is additions - there are no rows for
      // a removal to be an absence from, and no move can pair without one - so
      // each batch is true on its own, whatever the scan goes on to find. That is
      // what makes a 300k-frame import survive a kill: it resumes at the batch it
      // reached, where a single closing transaction would have lost every hour of
      // it. Only a run with no rows qualifies; against a populated library an
      // addition can still turn out to be the far half of a move.
      const insertBatch = (batch: readonly DiskFile[]): void => {
        // Same re-check as the closing transaction: the library can be deleted
        // mid-scan, and its photos are then cascade-gone. Nothing awaits between
        // here and the (synchronous) transaction, so the delete cannot interleave.
        if (!this.libraries.getById(libraryId)) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
        keepLease();
        const batchAt = new Date().toISOString();
        // Owner-checked like the closing transaction; batches already committed
        // are not rolled back with it.
        this.applyOwned(libraryId, owner, () => {
          for (const file of batch) {
            insertPhoto({ filePath: file.filePath, fileHash: file.hash, metadata: file.metadata, channel: 'live' }, batchAt);
          }
        });
        added += batch.length;
      };

      const scope = this.scopeFor(library);
      // The rows whose paths are not the live channel's business (§9.1.1). Read on
      // every run, scoped or not: without them an in-place binned file the
      // watcher reports is an unclaimed addition and inserts a second live row
      // every time anyone touches it.
      const binned = this.photos.listBinnedForSync(libraryId);
      let dbPhotos: SyncDbPhoto[];
      let files: readonly ScannedFile[];
      // The folders this run saw, and their identities: every one of them on a
      // full walk, and on a scoped run the ones the watcher named. A folder that
      // moved is in here under its new path either way, which is what lets §9.4.1
      // recognise it (including one holding no photos, whose move nothing else
      // leaves a trace of).
      let dirs: readonly ScannedDir[];
      if (scopePaths != null) {
        // Reconcile the changed paths themselves against their rows, plus the
        // missing move-source pool. The watcher names both halves of a move
        // (§9.8), so a rename arrives as its own removal and addition; the pool is
        // what pairs them when they land in different windows.
        files = this.scopedFiles(scope, scopePaths);
        dbPhotos = this.scopedDbPhotos(libraryId, scopePaths);
        dirs = await this.scopedDirs(scope, scopePaths);
      } else {
        dbPhotos = this.photos.listForSync(libraryId);
        ({ files, dirs } = await scanLibraryTree(scope, '', keepLease));
      }

      // A hand-renamed bin folder is the worst outcome in this design if it goes
      // unnoticed: the live walk would take its files as unclaimed additions
      // whose hashes match the binned rows exactly, and every binned row would
      // pair as a crossing *out* of the bin - the whole bin restored,
      // `deleted_from_path` destroyed, every undo batch unresolvable. Detected
      // here, immediately after the walk and before `scanFiles`, or the run
      // re-hashes the whole bin and then partitions on paths that match nothing.
      const followed = this.followBinRename(library, dirs, binned);
      for (const under of followed.exclude) {
        files = files.filter((file) => !shootContains(under, file.relPath));
        // And out of `dirs` too, or a shoot folder the photographer had earlier
        // moved into the bin gets relocated into the renamed bin by identity.
        dirs = dirs.filter((dir) => dir.relPath !== under && !shootContains(under, dir.relPath));
      }

      // Whole-folder moves the inode can prove are resolved before the diff, not
      // after it: an **in-place** binned row's file sits in the live tree (§12.1) and
      // moved with the folder, so a rename would leave its recorded path stale
      // while the file at the new path read as an unclaimed live addition - one
      // duplicate per in-place binned photograph. The identity needs only `dirs`
      // and the shoots, both of which are already in hand.
      //
      // The photo-evidence fallback below cannot come this early, and does not
      // need to: it only fires when the move minted a new inode, where the binned
      // file is a genuinely new file too.
      const onDisk = (folder: string): boolean => existsSync(path.join(library.root_path, folder));
      const byIdentity = detectRelocationsByIdentity(this.shoots.listIdentities(libraryId), dirs, onDisk);
      for (const r of byIdentity) {
        for (const row of binned) {
          if (shootContains(r.oldFolderPath, row.file_path)) {
            row.file_path = r.newFolderPath + row.file_path.slice(r.oldFolderPath.length);
          }
        }
      }

      // The bin channel does not run on a scoped sync: the watcher never reports events inside
      // the bin, so a scoped run has no evidence and must not conclude
      // `is_missing` on rows it did not look at. The rename detection above is the
      // one exception - it is a `dirs` test and costs nothing.
      // Null when the bin was not walked at all, which is a different thing from
      // walking it and finding it empty: a run with no evidence must leave the
      // binned rows exactly as they are.
      const binScan = scopePaths == null && followed.root != null ? await this.scanBinTree(library, followed.root, keepLease) : null;
      const binRoot = binScan == null ? null : followed.root;
      const binFiles = binScan ?? [];
      // What the bin is called after any rename this run followed, which is what
      // decides whether a binned row is in the bin or binned in place - a
      // different question from whether the bin was walked.
      const binFolder = followed.rename?.to ?? library.bin_name;

      const { present, changed, failed } = await this.scanFiles(
        // Binned files included, so `dbByPath` covers them and the unchanged test
        // answers correctly: nothing binned is opened or hashed unless it changed.
        [...files, ...binFiles],
        [...dbPhotos, ...binned],
        token.signal,
        reportScan,
        // The resumable first-scan path inserts every file it is handed as a new
        // live photograph, which a file under the bin is not (§9.1.1). A library
        // with rows, with binned rows, or with anything already in its bin takes
        // the ordinary diff instead.
        dbPhotos.length === 0 && binned.length === 0 && binFiles.length === 0 ? insertBatch : null,
        keepLease,
      );
      log.info('scan done', {
        library: libraryId,
        files: present.size,
        rows: dbPhotos.length,
        binned: binned.length,
        // The files whose stat changed, so the scan opened and hashed them; the
        // rest cost a stat each. This is what a slow scan's time went on.
        opened: changed.length + added,
        unreadable: failed.size,
        ms: Date.now() - startedAt,
      });

      // Partitioned here rather than after the scan, which would throw away work
      // already paid for: with `dbByPath` from the live rows alone every binned
      // file looks new, and 100k binned RAWs would decode 100k RAW headers nightly.
      const binPaths = new Set(binned.map((p) => p.file_path));
      const isBinSide = (filePath: string): boolean => binPaths.has(filePath) || (binRoot != null && shootContains(binRoot, filePath));
      const livePresent = new Set([...present].filter((p) => !isBinSide(p)));
      const binPresent = new Set([...present].filter(isBinSide));
      const liveChanged = changed.filter((c) => !isBinSide(c.filePath));
      const binChanged = changed.filter((c) => isBinSide(c.filePath));

      // A row binned **in place** (§12.1) is not in the bin, so the bin's walk is not
      // the walk that answers for it - the live one is, its file being in the live
      // tree. Split rather than lumped in with the bin-resident rows: diffed
      // against the bin walk it would be absent from it every time and go
      // `is_missing`, and left out of both it would be invisible to a folder
      // rename the inode cannot follow, whose file then imports as a second, live
      // photograph.
      const inPlace = binned.filter((row) => binFolder == null || !shootContains(binFolder, row.file_path));
      const resident = binned.filter((row) => binFolder != null && shootContains(binFolder, row.file_path));
      const inPlacePaths = new Set(inPlace.map((row) => row.file_path));

      const live = buildDiff(dbPhotos, livePresent, liveChanged, failed);
      // On a scoped run both halves are discarded rather than diffed: there was no
      // walk to be an absence from.
      const empty = { removed: [], added: [], modified: [], reappeared: [] };
      const bin = binRoot == null ? empty : buildDiff(resident, binPresent, binChanged, failed, 'bin');
      // The whole `present` set, since these rows are claimed anywhere in the live
      // tree, and only their own `changed` entries: an addition from the live walk
      // is the live channel's, and handing this one the rest would make every new
      // photograph a bin-side addition.
      const loose =
        scopePaths != null
          ? empty
          : buildDiff(inPlace, present, changed.filter((c) => inPlacePaths.has(c.filePath)), failed, 'bin');
      const diff = {
        removed: [...live.removed, ...bin.removed, ...loose.removed],
        added: [...live.added, ...bin.added, ...loose.added],
        modified: [...live.modified, ...bin.modified, ...loose.modified],
        reappeared: [...live.reappeared, ...bin.reappeared, ...loose.reappeared],
      };
      const result = detectMoves(diff, (id) => this.albums.getAlbumIdsForPhoto(id).length > 0);
      // A path test beats a hash test for the crossings §9.1.1 can still see: a file
      // copied into the bin and the original deleted, or touched on the way, has a
      // different mtime and so a different hash.
      const imported = this.pairByPath(result, binRoot);

      // Whole-folder moves are resolved before anything per-photo. A shoot folder
      // renamed outside the app shows up as one move per frame it holds, and
      // relocating the shoot answers all of them at once: the photos keep their
      // position inside the folder, so their paths shift by a prefix and their
      // shoot membership does not change at all. What is left is the moves that
      // are genuinely about individual files.
      //
      // The inode answered first and exactly, above (§9.4.1); the photos answer
      // the cases it cannot see, which is any move that minted a new inode -
      // across a filesystem, or a whole library restored from a backup.
      const settled = new Set(byIdentity.map((r) => r.shootId));
      const claimed = new Set(byIdentity.map((r) => r.newFolderPath));
      const relocations = [
        ...byIdentity,
        // Two shoots cannot occupy one folder, so a guess at a folder the inode
        // has already spoken for is wrong by construction.
        ...detectShootRelocations(
          shoots.filter((s) => !settled.has(s.id)),
          result.moves,
          dbPhotos,
          onDisk,
        ).filter((r) => !claimed.has(r.newFolderPath)),
      ]
        // Deepest first, because each one rewrites its whole subtree by prefix.
        // Rename a folder and its child in one window and applying the parent
        // first would move the child's photos to a path the child's own rewrite
        // then fails to match, leaving rows pointing at a file that is not there
        // while `is_missing` still reads 0.
        .sort((a, b) => b.oldFolderPath.split('/').length - a.oldFolderPath.split('/').length);
      // Where a path the scan saw ends up once the relocations below have been
      // applied by prefix.
      const relocatedPath = (filePath: string): string => {
        const moved = relocations.find((r) => shootContains(r.oldFolderPath, filePath));
        return moved == null ? filePath : moved.newFolderPath + filePath.slice(moved.oldFolderPath.length);
      };
      const relocatedFolders = relocations.map((r) => r.oldFolderPath);
      const moves = result.moves.filter((mv) => !relocatedFolders.some((folder) => shootContains(folder, mv.oldFilePath)));

      // shootFor has to read the post-relocation paths, or every relocated photo
      // would be tested against a folder its shoot no longer claims.
      for (const r of relocations) {
        for (const shoot of shoots) {
          if (shoot.folder_path === r.oldFolderPath) shoot.folder_path = r.newFolderPath;
          else if (shootContains(r.oldFolderPath, shoot.folder_path)) {
            shoot.folder_path = r.newFolderPath + shoot.folder_path.slice(r.oldFolderPath.length);
          }
        }
      }
      if (relocations.length > 0) {
        byFolder.clear();
        for (const shoot of shoots) byFolder.set(shoot.folder_path, shoot.id);
      }
      const nowUtc = new Date().toISOString();

      let removed = 0;
      // The relocated photos moved too, they were just answered in bulk.
      let moved = result.moves.length - moves.length;
      let modified = 0;

      // The library can be deleted during the (async) scan above; its photos are
      // then cascade-gone and inserting against the dead library_id would raise an
      // FK violation. Re-check here, no await between this and the synchronous
      // transaction, so the delete can't interleave, and abort cleanly.
      if (!this.libraries.getById(libraryId)) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);

      this.applyOwned(libraryId, owner, () => {
        // **Before anything path-guarded.** `setMissing` only marks a row whose
        // `file_path` still equals the path the scan saw, and after a followed
        // rename the scan's paths are the new ones while the rows still hold the
        // old - so a `setMissing` issued first would match nothing and silently do
        // nothing, a guard designed to absorb a race quietly absorbing a correct
        // write instead (§9.1.1).
        if (followed.rename != null) {
          this.libraries.setBinName(libraryId, followed.rename.to);
          this.photos.rewriteBinnedPathPrefix(libraryId, followed.rename.from, followed.rename.to);
        }
        // First, so the per-photo work below is only ever the remainder.
        for (const r of relocations) {
          this.shoots.relocate(r.shootId, r.oldFolderPath, r.newFolderPath);
          this.photos.rewritePathPrefix(libraryId, r.oldFolderPath, r.newFolderPath);
        }
        for (const mv of moves) {
          this.photos.setFilePathAndShoot(mv.photoId, mv.newFilePath, shootFor(mv.newFilePath));
          moved++;
        }
        for (const md of result.modified) {
          this.photos.applyModification(md.photoId, {
            file_hash: md.newHash,
            width: md.metadata.width,
            height: md.metadata.height,
            orientation: md.metadata.orientation,
            date_taken: md.metadata.dateTaken,
            date_taken_offset: md.metadata.dateTakenOffset,
            date_updated: md.metadata.mtime,
            file_size: md.metadata.fileSize,
            latitude: md.metadata.latitude,
            longitude: md.metadata.longitude,
            iso: md.metadata.iso,
            shutter_speed: md.metadata.shutterSpeed,
            aperture: md.metadata.aperture,
            focal_length: md.metadata.focalLength,
            camera_make: md.metadata.cameraMake,
            camera_model: md.metadata.cameraModel,
            lens_model: md.metadata.lensModel,
          });
          touched?.push(md.photoId);
          modified++;
        }
        for (const cr of result.crossings) {
          this.applyCrossing(cr, shootFor, binFolder);
          moved++;
        }
        for (const ad of result.added) {
          if (ad.channel === 'bin') continue; // §9.1.1, below
          insertPhoto(ad, nowUtc);
          added++;
        }
        // An unclaimed file under the bin is imported as already-binned, with
        // where it would restore to read off the mirrored layout: `<bin>/A/B/c.arw`
        // came from `A/B/c.arw`, and `<bin>/c.arw` from the library root.
        for (const ad of imported) {
          this.insertAdded(libraryId, ad, null, nowUtc, { deleted_from_path: ad.filePath.slice(binRoot!.length + 1) });
          added++;
        }
        for (const photoId of diff.reappeared) {
          this.photos.clearMissing(photoId);
          // A photo that went missing before its renditions were built is skipped
          // by the queue while it is missing (§9.4 step 4), so the sync that
          // brings it back is the one that owes them. Left out of a scoped run's
          // batch it would sit there unbuilt until the daily full sync.
          touched?.push(photoId);
        }
        for (const rm of result.removed) {
          // Keyed on where the row is *now*, which a relocation applied a few
          // lines up may have moved: `setMissing` only marks a row whose
          // `file_path` still equals the path handed to it, so one keyed on the
          // pre-rename path matches nothing and silently does nothing - a guard
          // written to absorb a race quietly absorbing a correct write (§9.1.1).
          // A frame deleted out of a folder that was renamed in the same window
          // would otherwise read as present with a 404ing original.
          const at = relocatedPath(rm.filePath);
          // Skips if a concurrent rename/move relocated the photo during the scan
          // (its file_path no longer matches what we scanned); it isn't missing.
          const marked = this.photos.setMissing(rm.photoId, at);
          if (!marked || rm.wasMissing) continue; // per-sync delta only (§9.4 step 5)
          // A binned row going missing is not a photograph leaving the library,
          // which is what `photosRemoved` counts: it is a change to a row that is
          // already out of the collection (§9.1.1).
          if (rm.channel === 'bin') modified++;
          else removed++;
        }
      });

      // Outside the transaction, so a listener cannot hold the write lock, and
      // only once it has committed: the watcher would otherwise re-arm against a
      // name this run may still roll back.
      if (followed.rename != null) {
        const renamed = this.libraries.getById(libraryId);
        if (renamed != null) {
          for (const listener of this.libraryChangedListeners) {
            try {
              listener(renamed);
            } catch (err) {
              log.error('a library-changed listener failed', { library: libraryId, err });
            }
          }
        }
      }

      // After the photos are written, so the folders' contents are settled: which
      // folders hold photographs is the whole question mirroring answers. The
      // live half only - the bin mirrors the folder tree inside itself, and a
      // shoot per bin folder is not a thing anyone asked for.
      const mirrored = this.reconcileShootFolders(library, dirs, livePresent, scopePaths == null);

      // Survives a restart, unlike the in-memory status, so the UI can always say
      // how stale the catalogue is (§9.6).
      this.libraries.setLastSyncedAt(libraryId, nowUtc);

      // A scoped run answers for the files it reconciled and nothing else: the
      // watcher fires on one changed file, and draining the library's whole
      // backlog off the back of that is not what the change asked for. A full run
      // is the one that does clear the backlog, which is how work a killed
      // process left behind gets picked up (§9.5).
      processingIds = touched;

      // Read after the transaction commits, so rows this sync inserted/modified
      // are counted (§9.6). This is the denominator for processing progress.
      const queued = this.photos.countPendingProcessing(libraryId, processingIds ?? undefined);
      this.processingBatch.set(libraryId, { queued, photoIds: processingIds });

      const status: LibrarySyncStatus = {
        library_id: libraryId,
        status: 'processing',
        photos_to_scan: present.size,
        photos_scanned: present.size,
        photos_added: added,
        photos_removed: removed,
        photos_moved: moved,
        photos_modified: modified,
        photos_processing: queued,
        photos_processed: 0,
      };
      this.statuses.set(libraryId, status);
      log.info('sync done', {
        library: libraryId,
        added,
        removed,
        moved,
        relocatedShoots: relocations.length,
        mirroredShoots: mirrored,
        modified,
        reappeared: diff.reappeared.length,
        queuedForProcessing: queued,
        ms: Date.now() - startedAt,
      });
      return status;
      });
      syncedStatus = synced;
      return synced;
    } catch (err) {
      // Scan/apply threw (e.g. root unmounted, DB error): reset status so the API
      // doesn't report 'scanning' forever. Still our generation here (the lease,
      // released in finally, blocks a newer one), but guard for consistency.
      if (this.generation.get(libraryId) === token) this.statuses.set(libraryId, idle(libraryId));
      // Stopped mid-scan on a populated library, where the writes are one closing
      // transaction: nothing was applied and the library is simply idle again.
      // Not an error - the caller asked for it. syncedStatus stays null, so no
      // processing runs.
      if (err instanceof SyncCancelled) {
        log.info('sync stopped', { library: libraryId, ms: Date.now() - startedAt });
        return idle(libraryId);
      }
      // A library deleted mid-scan is a normal end for this run, not a fault.
      if (err instanceof AppError && err.code === 'NOT_FOUND') log.info('sync abandoned: library deleted', { library: libraryId });
      else log.error('sync failed', { library: libraryId, ms: Date.now() - startedAt, err });
      throw err;
    } finally {
      stopHolding();
      // Release the lease as soon as scan+apply is done. Rendition generation runs
      // detached (§9.5/§9.6: background work, client polls status), so POST /sync
      // returns promptly and re-syncs aren't blocked for the whole processing run.
      this.syncLocks.release(libraryId, owner);
      if (syncedStatus != null) {
        this.detachProcessing(libraryId, token, syncedStatus, processingIds, startedAt);
      }
    }
  }

  // Stops the library's current run, wherever it has got to. A scan abandons its
  // work (nothing is applied), and processing stops handing out jobs, leaving the
  // photos it never reached pending for the next sync to pick up. Both settle
  // back to idle on their own; there is nothing to wait for here.
  cancelSync(libraryId: string): void {
    if (!this.libraries.getById(libraryId)) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    log.info('stop requested', { library: libraryId });
    this.generation.get(libraryId)?.abort();
  }

  // Rebuild every grid tile in the library, without scanning. Same status strip
  // as a sync's processing tail, so Stop and the progress bar keep working.
  rebuildTiles(libraryId: string): LibrarySyncStatus {
    return this.rebuildStage(libraryId, 'tiles');
  }

  // Rebuild every viewer rendition in the library. Refused when the library
  // serves the camera's JPEG: there is nothing to demosaic (§10.1).
  rebuildRenditions(libraryId: string): LibrarySyncStatus {
    const library = this.libraries.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    if (library.rendition_source !== 'render') {
      throw new AppError(
        'VALIDATION_ERROR',
        'this library serves the camera\'s JPEG in the viewer; there are no renders to rebuild',
      );
    }
    return this.rebuildStage(libraryId, 'renditions');
  }

  // Queue one processing stage for the whole library and hand it to the same
  // detached batch a sync uses. The lease is held only for the claim
  // (queue + generation + status): nothing walks the tree, but without it a
  // Sync now that has the lease and not yet marked itself busy would lose its
  // generation to this and never settle.
  private rebuildStage(libraryId: string, stage: 'tiles' | 'renditions'): LibrarySyncStatus {
    const startedAt = Date.now();
    const library = this.libraries.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    const current = this.statuses.get(libraryId);
    if (current != null && current.status !== 'idle') {
      throw new AppError('SYNC_IN_PROGRESS', 'a sync is already running for this library');
    }

    const owner = randomUUID();
    if (!this.syncLocks.acquire(libraryId, owner)) {
      throw new AppError('SYNC_IN_PROGRESS', 'a sync is already running for this library');
    }
    try {
      // Sync may have claimed between the idle check and the lease.
      const claimed = this.statuses.get(libraryId);
      if (claimed != null && claimed.status !== 'idle') {
        throw new AppError('SYNC_IN_PROGRESS', 'a sync is already running for this library');
      }

      const queued =
        stage === 'tiles'
          ? this.photos.queueTileRebuildForLibrary(libraryId)
          : this.photos.queueRenditionRebuildForLibrary(libraryId);
      log.info('library rebuild queued', { library: libraryId, stage, queued });
      if (queued === 0) return idle(libraryId);

      const token = new AbortController();
      this.generation.set(libraryId, token);
      const status: LibrarySyncStatus = {
        ...idle(libraryId, 'processing'),
        photos_processing: queued,
      };
      this.processingBatch.set(libraryId, { queued, photoIds: null });
      this.statuses.set(libraryId, status);
      this.detachProcessing(libraryId, token, status, null, startedAt);
      return status;
    } finally {
      this.syncLocks.release(libraryId, owner);
    }
  }

  // Detached rendition batch: returns to the caller immediately, reports through
  // getSyncStatus, and settles the generation's status when the pool drains.
  private detachProcessing(
    libraryId: string,
    token: AbortController,
    finalStatus: LibrarySyncStatus,
    photoIds: readonly string[] | null,
    startedAt: number,
  ): void {
    // Runs on both success and failure: processing throwing must not leave the
    // status stuck at 'processing'. Skipped if a newer sync generation started
    // meanwhile, so a stale tail can't stomp the newer run's status.
    const scope: ProcessingScope = { libraryId, photoIds: photoIds ?? undefined };
    // Idempotent, because both arms of the promise below reach it: a failure
    // inside `settle` itself would otherwise run the whole of it twice,
    // including every listener - and detection is not a cheap thing to do
    // by accident.
    let settled = false;
    const settle = (): void => {
      if (settled || this.generation.get(libraryId) !== token) return;
      settled = true;
      const stillPending = this.photos.countPendingProcessing(libraryId, scope.photoIds);
      const processed = Math.max(0, finalStatus.photos_processing - stillPending);
      // Before the status goes idle, not after. A client watching for idle
      // re-reads the collection the moment it sees it, and a listener that
      // changes the collection's *shape* - stack detection groups rows into
      // one another (§19.4.1) - would land after that read and leave the
      // grid showing a library that no longer exists. "Settled" has to mean
      // settled, so this holds 'processing' for however long it takes.
      //
      // Announced here rather than when the scan finished for the same kind
      // of reason: what listens wants the *derived* files, and a sync that
      // has only scanned has imported photographs nothing can compare yet.
      const changed = finalStatus.photos_added + finalStatus.photos_modified > 0;
      for (const listener of this.settledListeners) {
        // One listener's failure is its own. Left to throw, it would take
        // the status write below with it and leave the library reading
        // 'processing' forever, which no later sync clears - a listener is
        // something this service tells, not something it depends on.
        try {
          listener(libraryId, changed);
        } catch (err) {
          log.error('a settled listener failed', { library: libraryId, err });
        }
      }

      this.statuses.set(libraryId, {
        ...finalStatus,
        status: 'idle',
        photos_processing: stillPending,
        photos_processed: processed,
      });
      // Only when there was something to build: a sync that queued nothing
      // still settles, and saying so every time the watcher fires buries the
      // runs that are doing work.
      if (finalStatus.photos_processing > 0) {
        log.info('processing settled', { library: libraryId, processed, stillPending, ms: Date.now() - startedAt });
      }
    };
    // Asks about whichever generation is current rather than about this one:
    // a batch is per library and outlives the sync that started it, so a later
    // sync coalescing into it must not leave the stop button pointing at a run
    // nothing is doing any more.
    const stopped = (): boolean => this.generation.get(libraryId)?.signal.aborted === true;
    void Promise.resolve(this.processing.processUnprocessed(scope, stopped))
      .then(settle)
      .catch((err) => {
        log.error('processing failed', { library: libraryId, err });
        settle();
      });
  }

  // While rendition building runs (detached, §9.5), the counts are computed live from the
  // DB rather than pushed from the worker pool: one COUNT per poll, no cross-thread
  // progress plumbing.
  getSyncStatus(libraryId: string): LibrarySyncStatus {
    if (!this.libraries.getById(libraryId)) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    const status = this.statuses.get(libraryId);
    // Nothing in memory: this process has not synced the library. The flags a
    // killed process left behind are still in the rows, though, so report what is
    // outstanding rather than a flat zero - the catalogue really does owe that
    // many renditions. Reading it starts nothing; a sync is still what picks the
    // work up (§9.6).
    if (status == null) {
      return { ...idle(libraryId), photos_processing: this.photos.countPendingProcessing(libraryId) };
    }
    if (status.status !== 'processing') return status;

    const batch = this.processingBatch.get(libraryId);
    const stillPending = this.photos.countPendingProcessing(libraryId, batch?.photoIds ?? undefined);
    const queued = batch?.queued ?? stillPending;
    return { ...status, photos_processing: stillPending, photos_processed: Math.max(0, queued - stillPending) };
  }

  // A file that entered or left the bin by hand (§9.1.1). The `channel` tags gave
  // the direction, so there is no position to test - which matters because an
  // in-place binned row is `is_deleted = 1` with its file outside the bin,
  // indistinguishable by position from a hand-restore.
  private applyCrossing(crossing: Crossing, shootFor: (relPath: string) => string | null, binFolder: string | null): void {
    const wasBinned = this.photos.isBinned(crossing.photoId);
    if (crossing.direction === 'in') {
      this.photos.setFilePath(crossing.photoId, crossing.newFilePath);
      // Already binned: a path update only. `markDeleted` would null
      // `deleted_batch` and drop the row out of its batch's undo. Otherwise
      // `shoot_id` is kept rather than nulled by the move's own
      // `setFilePathAndShoot`, matching what an app-driven binning does.
      if (!wasBinned) this.photos.markDeleted(crossing.photoId, crossing.oldFilePath);
      return;
    }
    if (crossing.direction === 'out') {
      if (!wasBinned) return; // it was never in the bin; nothing to restore
      // **Leaving the bin is what restores a photograph, and a row binned in
      // place was never in it** - its file has simply been moved, which is not
      // the photographer saying they want it back. Position rather than the flag,
      // because the flag is what both of these rows have in common.
      if (binFolder == null || !shootContains(binFolder, crossing.oldFilePath)) {
        this.photos.moveBinnedInPlace(crossing.photoId, crossing.newFilePath);
        return;
      }
      this.photos.markRestored(crossing.photoId, crossing.newFilePath);
      // `markRestored` does not touch `shoot_id`, and `reconcileShootFolders`
      // only restates claims under newly created folders - so without this the
      // photograph lands in the grid with no shoot for good.
      this.photos.setShoot(crossing.photoId, shootFor(crossing.newFilePath));
      return;
    }
    this.photos.setFilePath(crossing.photoId, crossing.newFilePath); // moved within the bin
  }

  // One new photo, at the shoot its path falls under. Returns its id, which the
  // run collects so a scoped one can hand the rendition batch its own photos.
  private insertAdded(
    libraryId: string,
    entry: AddedEntry,
    shootId: string | null,
    addedAt: string,
    binned?: { deleted_from_path: string },
  ): string {
    const id = randomUUID();
    this.photos.insertFromSync({
      id,
      binned,
      library_id: libraryId,
      shoot_id: shootId,
      file_hash: entry.fileHash,
      file_path: entry.filePath,
      width: entry.metadata.width,
      height: entry.metadata.height,
      orientation: entry.metadata.orientation,
      date_taken: entry.metadata.dateTaken,
      date_taken_offset: entry.metadata.dateTakenOffset,
      date_added: addedAt,
      date_updated: entry.metadata.mtime,
      file_size: entry.metadata.fileSize,
      latitude: entry.metadata.latitude,
      longitude: entry.metadata.longitude,
      iso: entry.metadata.iso,
      shutter_speed: entry.metadata.shutterSpeed,
      aperture: entry.metadata.aperture,
      focal_length: entry.metadata.focalLength,
      camera_make: entry.metadata.cameraMake,
      camera_model: entry.metadata.cameraModel,
      lens_model: entry.metadata.lensModel,
    });
    return id;
  }

  // Brings the shoots into step with the folders the scan just saw (§9.4.1).
  //
  // Runs for every library, mirroring or not, because recording where each shoot's
  // folder actually is has nothing to do with the setting: it is how the next
  // rename gets recognised, and a shoot created before the folder was ever scanned
  // has no identity until something writes one.
  private reconcileShootFolders(
    library: Library,
    dirs: readonly ScannedDir[],
    presentFiles: ReadonlySet<string>,
    fullRun: boolean,
  ): number {
    const seen = new Map(dirs.map((d) => [d.relPath, d]));
    const identities = this.shoots.listIdentities(library.id);
    const stale = identities.filter((identity) => {
      const dir = seen.get(identity.folder_path);
      return (
        dir != null &&
        (identity.folder_dev !== dir.dev || identity.folder_ino !== dir.ino || identity.folder_birthtime !== dir.birthtimeMs)
      );
    });

    const shoots = this.shoots.listFolders(library.id);
    const byPath = new Map(shoots.map((s) => [s.folder_path, s]));
    const plain = library.mirror_shoots ? this.folderRules.pathsWithRule(library.id, 'plain') : new Set<string>();

    // A folder holding photographs of its own. Pass-through folders are left out:
    // they are structure rather than a set of photographs, and the tree on screen
    // is drawn from the shoots' own paths (§18.3.2).
    const wanted: string[] = [];
    if (library.mirror_shoots) {
      const withPhotos = new Set<string>();
      for (const file of presentFiles) {
        const slash = file.lastIndexOf('/');
        if (slash > 0) withPhotos.add(file.slice(0, slash));
      }
      for (const folder of withPhotos) {
        if (!byPath.has(folder) && !plain.has(folder)) wanted.push(folder);
      }
      // Shallowest first, so each new shoot's parent already exists to be derived
      // from - the same derivation `create` uses.
      wanted.sort((a, b) => a.split('/').length - b.split('/').length);
    }

    const doomed =
      fullRun && library.mirror_shoots
        ? shoots.filter((shoot) => {
            if (seen.has(shoot.folder_path) || shoot.photo_count > 0) return false;
            // A shoot still holding a shoot is not empty, whatever its own count
            // says: `parent_id` cascades, so deleting it would take a descendant's
            // label, banner and its photos' membership with it, and those photos
            // are only "missing" in the sense that the whole subtree moved.
            return !shoots.some((other) => other.id !== shoot.id && shootContains(shoot.folder_path, other.folder_path));
          })
        : [];

    // Nothing to say: the overwhelmingly common sync. Skipped before opening a
    // transaction rather than inside one, so a quiet library costs a few map
    // lookups and no write lock at all.
    if (stale.length === 0 && wanted.length === 0 && doomed.length === 0) return 0;

    return this.shoots.transaction(() => {
      let changed = 0;
      for (const identity of stale) {
        const dir = seen.get(identity.folder_path)!;
        this.shoots.setIdentity(identity.id, dir.dev, dir.ino, dir.birthtimeMs);
      }

      // Keyed by folder so the enclosing shoot is a few lookups up the path
      // rather than a scan of every shoot per folder created, which was quadratic
      // in the folders a first mirroring sync makes.
      const byFolder = new Map(shoots.map((s) => [s.folder_path, s.id]));
      const enclosing = (folder: string): string | null => {
        const segments = folder.split('/');
        let prefix = '';
        let deepest: string | null = null;
        for (const segment of segments.slice(0, -1)) {
          prefix = prefix === '' ? segment : `${prefix}/${segment}`;
          deepest = byFolder.get(prefix) ?? deepest;
        }
        return deepest;
      };

      for (const folder of wanted) {
        const dir = seen.get(folder);
        const shoot = {
          id: randomUUID(),
          parent_id: enclosing(folder),
          library_id: library.id,
          folder_path: folder,
          name: folder.slice(folder.lastIndexOf('/') + 1),
          description: null,
          // No explicit choice was made, so the library's own answer is the
          // closest thing to one.
          ordering: library.ordering,
          folder_dev: dir?.dev ?? null,
          folder_ino: dir?.ino ?? null,
          folder_birthtime: dir?.birthtimeMs ?? null,
        };
        this.shoots.insert(shoot);
        byFolder.set(folder, shoot.id);
        changed++;
      }

      // A new shoot takes the photographs in its folder, including any a shallower
      // shoot was holding for want of a closer one.
      for (const folder of claimsToRestate(wanted, byFolder)) {
        this.photos.setShootForFolder(library.id, folder, byFolder.get(folder)!);
      }

      for (const shoot of doomed) {
        this.shoots.delete(shoot.id);
        changed++;
      }
      return changed;
    });
  }

  // The bin's own walk, over the bin alone (§9.1.1). `scanLibraryTree` with a start
  // directory rather than 45 forked lines of walk, which is also what keeps every
  // relPath library-root relative, as every path in the bin channel requires.
  //
  // A missing bin root is a **skip, not a throw**: the state §4.1 hands to §9.1.1
  // for repair is exactly one where the folder is briefly not where the columns
  // say, and a sync that dies there would make §4.1's safety argument circular.
  // Scoped to the bin, so an unreadable root still fails the run loudly rather
  // than reading as "the whole bin was deleted".
  private async scanBinTree(library: Library, binRoot: string, keepLease: () => void): Promise<ScannedFile[] | null> {
    const abs = path.join(library.root_path, binRoot);
    if (statSync(abs, { throwIfNoEntry: false })?.isDirectory() !== true) {
      log.warn('the bin folder is not there; skipping the bin channel for this run', { library: library.id, bin: binRoot });
      // The walk is the only place with enough evidence to tell "deleted" from
      // "renamed", and it has just said deleted: remake it, and record the new
      // folder's identity, so the next rename is still followable.
      //
      // Not for a read-only library, which keeps the bin it had from before the
      // flag (§4.1) and is exactly the library whose photographer may have
      // deleted that folder on purpose. Making it again is a write under a root
      // this may not write to, and on a genuinely read-mounted volume it is an
      // error logged on every sync.
      if (!library.read_only) {
        await ensureBinFolder(library, this.libraries).catch((err: unknown) =>
          log.error('could not recreate the bin folder', { library: library.id, err }),
        );
      }
      return null;
    }
    // Everything under the bin is the bin's, so the walk descends unconditionally:
    // the bin rule would skip the very tree this is walking, the bin mirrors
    // folders even in a root-only library, an excluded folder's binned frames are
    // still binned, and a bin named with a leading dot is not a dotfolder to skip.
    const inside: LibraryScope = { rootPath: library.root_path, includeSubfolders: true, binName: null, excluded: new Set() };
    const { files } = await scanLibraryTree(inside, binRoot, keepLease, () => true);
    return files;
  }

  // A photographer renaming `<root>/Bin` to `<root>/Rubbish` has done to the bin
  // what §9.4.1 already handles for a shoot, and it is answered the same way: by
  // the folder's inode identity (§9.1.1).
  //
  // The trigger is that identity turning up in `dirs`. A directory reaches `dirs`
  // only if the live walk did not skip it, and the walk skips by *name*, so a
  // directory carrying the recorded identity **is** the bin under a name that no
  // longer matches - including a case-only difference, where the recorded path
  // still resolves and no existence test would fire.
  private followBinRename(
    library: Library,
    dirs: readonly ScannedDir[],
    binned: SyncDbPhoto[],
  ): { root: string | null; rename: { from: string; to: string } | null; exclude: readonly string[] } {
    const none = { root: library.bin_name, rename: null, exclude: [] };
    const identity = this.libraries.getBinIdentity(library.id);
    if (library.bin_name == null) return none;

    const found = findBinByIdentity(dirs, identity);
    if (found.kind === 'none') return none;
    if (found.kind === 'ambiguous') {
      log.warn('the bin folder identity is ambiguous; skipping the bin channel for this run', {
        library: library.id,
        candidates: found.candidates,
      });
      // Every candidate, not just the first: each of them *is* the bin by
      // identity, and one left in the live walk is a second copy of the whole bin
      // imported as live photographs.
      return { root: null, rename: null, exclude: found.candidates };
    }
    const target = found.target;

    // Excluding is safe unconditionally; rewriting `bin_name` needs two more
    // conditions, because dropping the recorded-path absence test that
    // `detectRelocationsByIdentity` uses admits three false positives - a bind
    // mount of the bin elsewhere under the root, a hardlinked directory, and a
    // recycled inode - and following any of them would silently bin a real shoot.
    const recorded = statSync(path.join(library.root_path, library.bin_name), { throwIfNoEntry: false });
    // Not an existence test: on a case-insensitive filesystem the recorded path
    // still resolves, to the *same* inode, so a case-only rename is handled by
    // exclusion alone. Bind mounts and hardlinks die here too.
    if (recorded != null && recorded.dev === target.dev && recorded.ino === target.ino) {
      return { root: library.bin_name, rename: null, exclude: [target.relPath] };
    }
    // **The candidate has to hold one of them**, which is what tells a renamed bin
    // from a folder that merely inherited its freed inode number. Asked of the
    // candidate rather than of the rows: "does this library have anything in its
    // bin" is true of every library that has ever binned anything, and would let
    // the recycled inode through - the case this exists to refuse, and the one
    // that silently turns a real shoot into the bin.
    const from = library.bin_name;
    const claimed = binned.some(
      (row) =>
        shootContains(from, row.file_path) &&
        existsSync(path.join(library.root_path, target.relPath + row.file_path.slice(from.length))),
    );
    if (!claimed) {
      log.warn('a folder carries the bin identity but holds no binned file; not following it', {
        library: library.id,
        candidate: target.relPath,
      });
      // And **not excluded either**. Exclusion is unconditional only while the
      // candidate might be the bin; here it has just been shown not to be, and
      // dropping it from the live walk would mark a real shoot's photographs
      // missing - the same harm as following it, arrived at more quietly.
      return { root: library.bin_name, rename: null, exclude: [] };
    }

    // The in-memory rewrite is not deferred to the apply: the diff has to see
    // matched paths.
    for (const row of binned) {
      if (shootContains(from, row.file_path)) row.file_path = target.relPath + row.file_path.slice(from.length);
    }
    log.info('following a renamed bin folder', { library: library.id, from, to: target.relPath });
    return { root: target.relPath, rename: { from, to: target.relPath }, exclude: [target.relPath] };
  }

  // §9.1.1's path test, run before anything is imported: if `<bin>/A/c.arw` is
  // unclaimed and `A/c.arw` is an unpaired live removal, that **is** the crossing,
  // whatever the hashes say - the file may have been copied in and the original
  // deleted, or touched on the way. Without it that crossing produces a missing
  // live row *and* a second already-binned row for one frame.
  //
  // Returns the bin additions that are left, which are genuinely new.
  private pairByPath(result: MoveResult, binRoot: string | null): AddedEntry[] {
    const binAdditions = result.added.filter((a) => a.channel === 'bin');
    if (binRoot == null || binAdditions.length === 0) return binAdditions;

    const removedByPath = new Map(result.removed.filter((r) => r.channel === 'live').map((r) => [r.filePath, r]));
    const claimed: AddedEntry[] = [];
    for (const addition of binAdditions) {
      const cameFrom = addition.filePath.slice(binRoot.length + 1);
      const removal = removedByPath.get(cameFrom);
      if (removal == null) continue;
      result.crossings.push({
        photoId: removal.photoId,
        oldFilePath: removal.filePath,
        newFilePath: addition.filePath,
        direction: 'in',
      });
      // Out of `removed` too, or `setMissing` fires on a row that just moved.
      result.removed = result.removed.filter((r) => r !== removal);
      claimed.push(addition);
    }
    result.added = result.added.filter((a) => !claimed.includes(a));
    return binAdditions.filter((a) => !claimed.includes(a));
  }

  // The rows a scoped sync reconciles: those at the changed + discovered paths
  // (candidates for remove/modify/reappear/add) plus every already-missing row (so
  // a new file can still hash-pair into a move across syncs). Deduped by id.
  private scopedDbPhotos(libraryId: string, knownPaths: readonly string[]): SyncDbPhoto[] {
    const byId = new Map<string, SyncDbPhoto>();
    for (const p of this.photos.listForSyncByPaths(libraryId, knownPaths)) byId.set(p.id, p);
    for (const p of this.photos.listMissingForSync(libraryId)) byId.set(p.id, p);
    return [...byId.values()];
  }

  // Unique parent directories of the changed paths ('' = library root).
  private scopeDirs(scopePaths: readonly string[]): string[] {
    const dirs = new Set<string>();
    for (const p of scopePaths) {
      const slash = p.lastIndexOf('/');
      dirs.add(slash < 0 ? '' : p.slice(0, slash));
    }
    return [...dirs];
  }

  // The identities of the folders a scoped run was told about: each changed path
  // that is itself a directory, plus the directories those paths sit in. The first
  // is what a folder move reports (an empty folder's move reports nothing else at
  // all), the second is what a file's move reports.
  private async scopedDirs(scope: LibraryScope, scopePaths: readonly string[]): Promise<ScannedDir[]> {
    const candidates = new Set<string>(scopePaths);
    for (const dir of this.scopeDirs(scopePaths)) candidates.add(dir);
    const dirs: ScannedDir[] = [];
    for (const relPath of candidates) {
      if (relPath === '' || !isDirInScope(scope, relPath)) continue;
      const stats = await stat(path.join(scope.rootPath, relPath)).catch(() => null);
      if (stats?.isDirectory()) dirs.push({ relPath, dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs });
    }
    return dirs;
  }

  // The changed paths, as the files this library holds: anything of a format that
  // is not ours or that sits outside the scope (§9.1) is not one. Whether each is
  // still there is `scanFiles`' stat to make - a path that has gone yields nothing
  // there, so its row falls through to `removed`, and a path naming a directory is
  // dropped the same way.
  private scopedFiles(scope: LibraryScope, scopePaths: readonly string[]): ScannedFile[] {
    return scopePaths
      .filter((relPath) => isSupportedFile(relPath) && isFileInScope(scope, relPath))
      .map((relPath) => ({ relPath, absPath: path.join(scope.rootPath, relPath) }));
  }

  // Stats each file and opens/hashes ONLY the ones that are new or whose mtime+size
  // changed vs the stored record (§9.1). Unchanged files are never opened, so a
  // no-op sync does zero LibRaw work. Shared by the full and scoped paths.
  //
  // `onBatch`, when given, takes each run of INSERT_BATCH files as it is hashed
  // and is what makes a first scan resumable: a half-built `present` is normally
  // unusable, because absence from it is how a removal is detected, and applying
  // it would mark every file the scan had not reached as missing. With no rows
  // for it to be an absence from that cannot happen, and nothing else can either
  // - a move pairs a removal with an addition, and there are no removals - so
  // each batch says only "these files are new", which is true whether or not the
  // scan saw the rest. Those files are then handed over rather than accumulated,
  // so `changed` (and the diff built from it) stays empty.
  private async scanFiles(
    files: readonly ScannedFile[],
    dbPhotos: readonly SyncDbPhoto[],
    signal: AbortSignal,
    onProgress: (scanned: number, toScan: number) => void,
    onBatch: ((batch: readonly DiskFile[]) => void) | null,
    keepLease: () => void,
  ): Promise<{ present: Set<string>; changed: DiskFile[]; failed: Set<string> }> {
    const dbByPath = new Map(dbPhotos.map((p) => [p.file_path, p]));

    // Stat everything, collapsing hardlink pairs (same dev+ino) to a single path.
    // A concurrent non-atomic move (moveIntoDir does link() then unlink()) briefly
    // exposes both the old and new path pointing at one inode; without this, the
    // new path would be scanned as a brand-new file and insertFromSync'd as a
    // permanent duplicate row. Prefer whichever path matches an existing record.
    type Scanned = { relPath: string; absPath: string; stats: Awaited<ReturnType<typeof stat>> };
    const byInode = new Map<string, Scanned>();
    for (const file of files) {
      if (signal.aborted) break;
      // This loop reports nothing, so it is the one blocking stretch of a scan
      // with no other refresh point in it (§9.7).
      keepLease();
      let stats;
      try {
        stats = await stat(file.absPath);
      } catch {
        continue; // gone before it was looked at: treat as not present (a race, or a deletion the watcher reported)
      }
      // A scoped run is handed paths and not entries, and a folder is free to be
      // named like a photograph; the walk's own files are always files.
      if (!stats.isFile()) continue;
      const key = `${stats.dev}:${stats.ino}`;
      const existing = byInode.get(key);
      if (existing == null || (!dbByPath.has(existing.relPath) && dbByPath.has(file.relPath))) {
        byInode.set(key, { relPath: file.relPath, absPath: file.absPath, stats });
      }
    }

    const present = new Set<string>();
    const changed: DiskFile[] = [];
    const failed = new Set<string>();
    const batch: DiskFile[] = [];
    const keep = (file: DiskFile): void => {
      if (onBatch == null) {
        changed.push(file);
        return;
      }
      batch.push(file);
      if (batch.length >= INSERT_BATCH) onBatch(batch.splice(0));
    };

    // The loop below is the whole cost of a scan (the stat pass above opens
    // nothing), so it is the one worth reporting against. `present` is added to
    // once per file, so its size is how many have been dealt with.
    for (const file of byInode.values()) {
      // Between files, not inside one: this is the loop that opens and hashes, so
      // a stop lands within one file's decode rather than at the end of the scan.
      if (signal.aborted) break;
      onProgress(present.size, byInode.size);
      present.add(file.relPath);

      const record = dbByPath.get(file.relPath);
      const unchanged =
        record != null && record.date_updated === file.stats.mtime.toISOString() && record.file_size === file.stats.size;
      if (unchanged) continue;

      try {
        const metadata = await this.extract(file.absPath);
        keep({ filePath: file.relPath, hash: computeFileHash(file.absPath, metadata), metadata });
      } catch (err) {
        // Unreadable/corrupt file: record it as failed so buildDiff leaves any
        // existing record untouched (not marked missing, and not falsely reappeared).
        failed.add(file.relPath);
        log.warn('unreadable file, left as it is', { file: file.absPath, err });
      }
    }

    // The tail of a batched scan, stopped or finished: it is as applicable as
    // every batch before it.
    if (batch.length > 0) onBatch?.(batch.splice(0));
    // Nothing was written down as it went, so a stop leaves the run with nothing
    // it can apply.
    if (signal.aborted && onBatch == null) throw new SyncCancelled();
    return { present, changed, failed };
  }
}
