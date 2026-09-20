import { AppError } from '../../../errors';
import { Logger } from '../../../logger';
import type { Library, LibraryScanStatus } from '../../../schemas/libraries';
import { libraryScope, type LibraryScope } from '../../../utils/scope';
import type { AlbumsRepository } from '../../albums/albums_repository';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { PhotoMetadataRepository } from '../../photos/metadata/photo_metadata_repository';
import type { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import type { PhotoScanRepository } from '../../photos/scan/photo_scan_repository';
import type { FolderRulesRepository } from '../../shoots/folder_rules_repository';
import type { ShootsRepository } from '../../shoots/shoots_repository';
import type { ScanReconciler } from './scan_reconciler';
import { ScanCancelled, type ScanFileReader } from './scan_file_reader';
import type { ScanLeases } from './scan_leases';
import type { ProcessingTrigger, ScanRebuilds } from './scan_rebuilds';
import { idleScanStatus, type ScanStatus } from './scan_status';
import { ScanTiles } from './scan_tiles';
import { ScanBatch, type SidecarImporter } from './scan_batch';
import { collectEvidence, type ScanScope } from './scan_evidence';
import { readAndClassify } from './scan_classification';
import { applyChanges } from './scan_apply';
import { finishScan, type CompletedScan } from './scan_finish';
import { libraryMutex } from '../coordination/library_mutex';

const log = new Logger('scan');

/** Who asked for a run, so an unexplained scan in the log names its own cause. */
export type ScanTrigger = 'api' | 'watcher' | 'daily' | 'created';


export class ScanRunner {
  constructor(
    private readonly photoScan: PhotoScanRepository,
    private readonly photoPaths: PhotoPathsRepository,
    private readonly photoMetadata: PhotoMetadataRepository,
    private readonly photoProcessing: PhotoProcessingRepository,
    private readonly libraries: LibrariesRepository,
    private readonly albums: AlbumsRepository,
    private readonly shoots: ShootsRepository,
    private readonly folderRules: FolderRulesRepository,
    private readonly processing: ProcessingTrigger,
    private readonly sidecars: SidecarImporter,
    private readonly materialise: (libraryId: string) => Promise<number>,
    private readonly pendingMoves: (libraryId: string) => readonly { photoId: string; wasAt: string }[],
    private readonly reconciler: ScanReconciler,
    private readonly fileReader: ScanFileReader,
    private readonly leases: ScanLeases,
    private readonly status: ScanStatus,
    private readonly rebuilds: ScanRebuilds,
  ) {}

  private scopeFor(library: Library): LibraryScope {
    return libraryScope(library, this.folderRules.pathsWithRule(library.id, 'excluded'));
  }


  // A full scan (`changedScope` omitted) walks the whole tree. A scoped scan (from the
  // watcher) reconciles only what changed against its DB rows plus the
  // already-missing move-source pool, cheap, and move-detection still resolves a
  // relocation because both the removed old path and the added new path land in one
  // debounce batch, or pair across scans via the missing pool (§9.3). The periodic
  // full scan (scanAll) is the backstop for events the watcher dropped.
  async run(
    libraryId: string,
    changedScope?: ScanScope,
    trigger: ScanTrigger = 'api',
  ): Promise<LibraryScanStatus> {
    // Everything downstream that only asks *whether* this run is scoped, and how
    // big it is, reads this rather than the two lists.
    const scopePaths: readonly string[] | null =
      changedScope == null ? null : [...(changedScope.paths ?? []), ...(changedScope.dirs ?? [])];
    // Only to fail fast and to name the root in the log. The row this run reads
    // its paths from is taken inside the mutex, below.
    const known = this.libraries.getById(libraryId);
    if (!known) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);

    log.info('scan start', {
      library: libraryId,
      root: known.root_path,
      trigger,
      mode: scopePaths == null ? 'full' : 'scoped',
      paths: scopePaths?.length,
    });
    const startedAt = Date.now();
    const owner = this.leases.acquire(libraryId);
    const keepLease = this.leases.keeper(libraryId, owner);
    // Cleared as soon as the mutex lets this run in, and again in `finally` for
    // the paths that never get there.
    let stopHolding = this.leases.holdWhileQueued(libraryId, owner);
    const token = this.leases.begin(libraryId);
    // Before the first await: rebuild jobs only gate on in-memory status, and the
    // lease alone is not enough for them - they do not hold it for the whole run.
    // Leaving 'idle' until inside `libraryMutex.run` let a rebuild replace this
    // generation in the gap, after which this run's settle no-ops and the strip
    // can stick on 'rendition'.
    this.status.setProcessing(libraryId);
    let scannedStatus: LibraryScanStatus | null = null;
    // The photos this run created or rewrote, for a scoped run to hand its
    // rendition batch. Null once the run is a full one, whose batch is the
    // library's whole backlog.
    let processingIds: readonly string[] | null = null;

    const tiles = new ScanTiles(libraryId, this.processing);

    try {
      // Inside the mutex, outside the lease: the lease first keeps scan-vs-scan
      // fail-fast (409), while the mutex makes file-moving mutations queue behind
      // this scan instead of invalidating its snapshot mid-flight.
      const scanned = await libraryMutex.run(libraryId, async () => {
        stopHolding();
        stopHolding = () => {};
        return this.scanLocked(libraryId, changedScope, scopePaths, owner, token, startedAt, keepLease, tiles);
      });
      scannedStatus = scanned.status;
      processingIds = scanned.processingIds;
      return scanned.status;
    } catch (err) {
      // Scan/apply threw (e.g. root unmounted, DB error): reset status so the API
      // doesn't report 'processing' forever. Still our generation here (the lease,
      // released in finally, blocks a newer one), but guard for consistency.
      if (this.leases.isCurrent(libraryId, token)) this.status.set(libraryId, idleScanStatus(libraryId));
      // Stopped mid-scan on a populated library, where the writes are one closing
      // transaction: nothing was applied and the library is simply idle again.
      // Not an error - the caller asked for it. scannedStatus stays null, so no
      // processing runs.
      if (err instanceof ScanCancelled) {
        log.info('scan stopped', { library: libraryId, ms: Date.now() - startedAt });
        return idleScanStatus(libraryId);
      }
      // A library deleted mid-scan is a normal end for this run, not a fault.
      if (err instanceof AppError && err.code === 'NOT_FOUND') log.info('scan abandoned: library deleted', { library: libraryId });
      else log.error('scan failed', { library: libraryId, ms: Date.now() - startedAt, err });
      throw err;
    } finally {
      stopHolding();
      // Whatever the run did or did not reach. A successful one has already settled, so this is
      // the stopped and the failed ones: the tiles their committed batches earned stay, and
      // everything else they built goes rather than waiting a week for the orphan sweep.
      await tiles.settle(false);
      // Release the lease as soon as scan+apply is done. Rendition generation runs
      // detached (§9.5/§9.6: background work, client polls status), so POST /sync
      // returns promptly and rescans aren't blocked for the whole processing run.
      this.leases.release(libraryId, owner);
      if (scannedStatus != null) {
        this.rebuilds.detachProcessing(libraryId, token, scannedStatus, processingIds, startedAt);
      }
    }
  }


  private async scanLocked(
    libraryId: string,
    changedScope: ScanScope | undefined,
    scopePaths: readonly string[] | null,
    owner: string,
    token: AbortController,
    startedAt: number,
    keepLease: () => void,
    tiles: ScanTiles,
  ): Promise<CompletedScan> {
    // Re-read here, not from snapshot taken before mutex: `bin_name` is renameable (§4.1), and
    // every path this run derives from it would otherwise use a name the rename moved off.
    const library = this.libraries.getById(libraryId);
    if (library == null) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    this.status.setProcessing(libraryId);

    // Before a single path is read (docs/replication.md §7.4). A merged move not yet made on disk
    // looks exactly like the user moving the file back; reading it would stamp and replicate reversal.
    await this.materialise(libraryId);

    const batch = new ScanBatch(
      libraryId,
      library,
      owner,
      scopePaths,
      startedAt,
      keepLease,
      tiles,
      this.libraries,
      this.shoots,
      this.reconciler,
      this.leases,
      this.sidecars,
      this.status,
    );
    const evidence = await collectEvidence(
      {
        photoScan: this.photoScan,
        shoots: this.shoots,
        reconciler: this.reconciler,
        pendingMoves: this.pendingMoves,
      },
      { libraryId, library, scope: this.scopeFor(library), changedScope, scopePaths, keepLease },
    );
    const classified = await readAndClassify(
      { fileReader: this.fileReader, albums: this.albums, reconciler: this.reconciler },
      { libraryId, library, scopePaths, token, startedAt, keepLease, tiles, batch, evidence },
    );
    const counts = applyChanges(
      {
        libraries: this.libraries,
        photoPaths: this.photoPaths,
        photoMetadata: this.photoMetadata,
        photoScan: this.photoScan,
        shoots: this.shoots,
        reconciler: this.reconciler,
        leases: this.leases,
      },
      { libraryId, owner, batch, tiles, evidence, classified },
    );
    return finishScan(
      {
        libraries: this.libraries,
        statusStore: this.status,
        reconciler: this.reconciler,
        photoProcessing: this.photoProcessing,
      },
      { libraryId, scopePaths, startedAt, tiles, batch, evidence, classified, counts },
    );
  }

}
