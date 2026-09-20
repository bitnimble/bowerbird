import { AppError } from '../../../errors';
import { Logger } from '../../../logger';
import type { Library, LibraryScanStatus } from '../../../schemas/libraries';
import { libraryScope, type LibraryScope } from '../../../utils/scope';
import type { AlbumsRepository } from '../../albums/albums_repository';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { LibraryLifecycleListener } from '../../libraries/libraries_service';
import type { PhotoMetadataRepository } from '../../photos/metadata/photo_metadata_repository';
import type { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import type { PhotoScanRepository } from '../../photos/scan/photo_scan_repository';
import type { FolderRulesRepository } from '../../shoots/folder_rules_repository';
import type { ShootsRepository } from '../../shoots/shoots_repository';
import { extractMetadata } from '../../processing/analysis/metadata';
import { ScanReconciler } from './scan_reconciler';
import { ScanFileReader, type MetadataExtractor } from './scan_file_reader';
import { LEASE_MS, type SyncLocksRepository } from '../coordination/sync_locks_repository';
import { ScanLeases } from './scan_leases';
import { ScanRebuilds, type ProcessingTrigger } from './scan_rebuilds';
import { ScanStatus } from './scan_status';
import { ScanRunner, type ScanTrigger } from './scan_run';
import type { ScanScope } from './scan_evidence';
import type { SidecarImporter } from './scan_batch';

// Unwinds a stopped scan whose partial result cannot be applied, which is any
// run that had rows to reconcile against (§9.10). Never leaves this module:
// scanLibrary turns it back into an idle status, because that run applied nothing.
const log = new Logger('scan');

export class ScanService implements LibraryLifecycleListener {
  private readonly runner: ScanRunner;
  private readonly leases: ScanLeases;
  private readonly status: ScanStatus;
  private readonly rebuilds: ScanRebuilds;

  constructor(
    private readonly photoScan: PhotoScanRepository,
    private readonly photoPaths: PhotoPathsRepository,
    private readonly photoMetadata: PhotoMetadataRepository,
    private readonly photoProcessing: PhotoProcessingRepository,
    private readonly libraries: LibrariesRepository,
    private readonly albums: AlbumsRepository,
    private readonly shoots: ShootsRepository,
    private readonly folderRules: FolderRulesRepository,
    syncLocks: SyncLocksRepository,
    private readonly processing: ProcessingTrigger,
    private readonly extract: MetadataExtractor = extractMetadata,
    private readonly sidecars: SidecarImporter = { importFor: () => 0 },
    // Read per scan rather than held, so a change on the settings page lands on the
    // next scan. One, unless something says otherwise: an `extract` that reads on this
    // thread gains nothing from being asked for several files at once.
    private readonly scanConcurrency: () => number = () => 1,
    /**
     * Merged moves this peer has not made on disk yet (docs/replication.md §7.4).
     *
     * A seam rather than the runner, and defaulted, because a scan test must not
     * also be a replication test - the same shape `extract` and `sidecars` take.
     */
    private readonly materialise: (libraryId: string) => Promise<number> = () => Promise.resolve(0),
    /**
     * The merged moves the drain above could not make. Whatever is still listed
     * here is a photograph whose row and whose file disagree *on purpose*, so this
     * run must not read either as evidence (§7.4).
     */
    private readonly pendingMoves: (libraryId: string) => readonly { photoId: string; wasAt: string }[] = () => [],
  ) {
    const reconciler = new ScanReconciler(photoPaths, photoMetadata, photoScan, libraries, shoots, folderRules);
    const fileReader = new ScanFileReader(extract, scanConcurrency);
    this.leases = new ScanLeases(photoScan, syncLocks);
    this.status = new ScanStatus(photoProcessing, libraries);
    this.rebuilds = new ScanRebuilds(photoProcessing, libraries, this.leases, this.status, processing);
    this.runner = new ScanRunner(
      photoScan,
      photoPaths,
      photoMetadata,
      photoProcessing,
      libraries,
      albums,
      shoots,
      folderRules,
      processing,
      sidecars,
      materialise,
      pendingMoves,
      reconciler,
      fileReader,
      this.leases,
      this.status,
      this.rebuilds,
    );
  }

  // What this library contains, in the form the scan and the watcher both read
  // (§9.1). Built per run: a folder rule set between two scans takes effect on
  // the next one without anything having to invalidate a cache.
  scopeFor(library: Library): LibraryScope {
    return libraryScope(library, this.folderRules.pathsWithRule(library.id, 'excluded'));
  }

  // A library that has just been added holds nothing until something walks its
  // tree, and the answer to "where are my photographs" cannot be a second button
  // (§9.8). Not awaited: the create request answers as soon as the row exists,
  // while the import - minutes on a first run - reports through the status
  // endpoint like any other scan. The status is set before the first await, so a
  // client that polls the moment its create returns sees the run, not 'idle'.
  onLibraryCreated(library: Library): void {
    void this.scanLibrary(library.id, undefined, 'created').catch((err: unknown) => {
      log.error('the first scan of a new library failed', { library: library.id, err });
    });
  }

  // Drop the deleted library's in-memory status/generation so those maps don't
  // grow unbounded across create/delete cycles (mirrors the watcher's teardown).
  onLibraryDeleted(libraryId: string): void {
    this.leases.clear(libraryId);
    this.status.clear(libraryId);
  }

  async scanAll(): Promise<void> {
    // Reclaim is by expiry now (§9.7), so a container killed and restarted within
    // seconds finds its own dead run still holding the lease. Skipping silently
    // would drop that library until tomorrow, so the ones that were locked are
    // re-attempted at the end of the loop.
    const skipped: string[] = [];
    for (const library of this.libraries.list()) {
      if (!(await this.scanOne(library.id))) skipped.push(library.id);
    }
    if (skipped.length === 0) return;

    // **Waited out, not retried straight away.** The lease that refused these is
    // reclaimable at a stated instant, and a retry before it is refused for
    // exactly the reason the first attempt was - which made the re-attempt a
    // no-op in the one case it exists for, a dead process whose row has not
    // expired yet. Bounded by one lease, and skipped entirely when the loop
    // already took that long or the holder has since released.
    const reclaimable = skipped
      .map((libraryId) => this.leases.expiresAt(libraryId)?.getTime())
      .filter((at): at is number => at != null);
    const waitFor = Math.min(reclaimable.length === 0 ? 0 : Math.max(...reclaimable) - Date.now(), LEASE_MS);
    if (waitFor > 0) {
      log.info('waiting for a held scan lease before re-attempting', { libraries: skipped.length, ms: waitFor });
      await Bun.sleep(waitFor);
    }
    for (const libraryId of skipped) await this.scanOne(libraryId);
  }

  /** False when the library was locked; every other failure is logged and swallowed. */
  private async scanOne(libraryId: string): Promise<boolean> {
    try {
      await this.scanLibrary(libraryId, undefined, 'daily');
      return true;
    } catch (err) {
      // Never let one library abort the batch (§9.7).
      if (err instanceof AppError && err.code === 'SYNC_IN_PROGRESS') return false;
      log.error('library failed during scanAll', { library: libraryId, err });
      return true;
    }
  }

  // Stops the library's current run, wherever it has got to. A scan abandons its
  // work (nothing is applied), and processing stops handing out jobs, leaving the
  // photos it never reached pending for the next scan to pick up. Both settle
  // back to idle on their own; there is nothing to wait for here.
  cancelScan(libraryId: string): void {
    if (!this.libraries.getById(libraryId)) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    log.info('stop requested', { library: libraryId });
    this.leases.abort(libraryId);
  }
  onSettled(listener: (libraryId: string, changed: boolean) => void): void {
    return this.status.onSettled(listener);
  }

  onLibraryChanged(listener: (library: Library) => void): void {
    return this.status.onLibraryChanged(listener);
  }

  rebuildTiles(libraryId: string): LibraryScanStatus {
    return this.rebuilds.rebuildTiles(libraryId);
  }

  rebuildRenditions(libraryId: string): LibraryScanStatus {
    return this.rebuilds.rebuildRenditions(libraryId);
  }

  getScanStatus(libraryId: string): LibraryScanStatus {
    return this.status.getScanStatus(libraryId);
  }

  async scanLibrary(
    libraryId: string,
    changedScope?: ScanScope,
    trigger: ScanTrigger = 'api',
  ): Promise<LibraryScanStatus> {
    return this.runner.run(libraryId, changedScope, trigger);
  }

}
