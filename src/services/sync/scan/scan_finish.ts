import { Logger } from '../../../logger';
import type { LibraryScanStatus } from '../../../schemas/libraries';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import type { AppliedCounts } from './scan_apply';
import type { ScanBatch } from './scan_batch';
import type { ClassifiedScan } from './scan_classification';
import type { CollectedEvidence } from './scan_evidence';
import type { ScanReconciler } from './scan_reconciler';
import type { ScanStatus } from './scan_status';
import type { ScanTiles } from './scan_tiles';

const log = new Logger('scan');

export interface CompletedScan {
  status: LibraryScanStatus;
  processingIds: readonly string[] | null;
}



  export async function finishScan(
  dependencies: {
    libraries: LibrariesRepository;
    statusStore: ScanStatus;
    reconciler: ScanReconciler;
    photoProcessing: PhotoProcessingRepository;
  },
  input: {
    libraryId: string;
    scopePaths: readonly string[] | null;
    startedAt: number;
    tiles: ScanTiles;
    batch: ScanBatch;
    evidence: CollectedEvidence;
    classified: ClassifiedScan;
    counts: AppliedCounts;
  },
): Promise<CompletedScan> {
  const { libraries, statusStore, reconciler, photoProcessing } = dependencies;
  const { libraryId, scopePaths, startedAt, tiles, batch, evidence, classified, counts } = input;

    const library = batch.library;
    const { scope, dirs, followed } = evidence;
    const { present, livePresent, diff, relocations, nowUtc } = classified;
    const { removed, moved, modified } = counts;


    batch.importSidecars();

    // Outside the transaction and after it commits, for the reason the sidecars above are:
    // this is a rename per photo, and the rows now hold the ids to rename to. What no row
    // claimed goes with it, so a run leaves nothing of its own behind (§10.4).
    await tiles.settle(true);

    // Outside the transaction, so a listener cannot hold the write lock, and
    // only once it has committed: the watcher would otherwise re-arm against a
    // name this run may still roll back.
    if (followed.rename != null) {
      const renamed = libraries.getById(libraryId);
      if (renamed != null) {
        statusStore.notifyLibraryChanged(renamed);
      }
    }

    // After the photos are written, so the folders' contents are settled: which
    // folders hold photographs is the whole question mirroring answers. The
    // live half only - the bin mirrors the folder tree inside itself, and a
    // shoot per bin folder is not a thing anyone asked for.
    const mirrored = reconciler.reconcileShootFolders(library, scope, dirs, livePresent, scopePaths == null);

    // Survives a restart, unlike the in-memory status, so the UI can always say
    // how stale the catalogue is (§9.6).
    libraries.setLastScannedAt(libraryId, nowUtc);

    // A scoped run answers for the files it reconciled and nothing else: the
    // watcher fires on one changed file, and draining the library's whole
    // backlog off the back of that is not what the change asked for. A full run
    // is the one that does clear the backlog, which is how work a killed
    // process left behind gets picked up (§9.5).
    const processingIds = batch.touched;

    // Read after the transaction commits, so rows this scan inserted/modified
    // are counted (§9.6). This is the denominator for processing progress.
    const queued = photoProcessing.countPendingProcessing(libraryId, processingIds ?? undefined);
    statusStore.setBatch(libraryId, queued, processingIds);

    const status: LibraryScanStatus = {
      library_id: libraryId,
      status: 'rendition',
      photos_to_scan: present.size,
      photos_scanned: present.size,
      photos_added: batch.added,
      photos_removed: removed,
      photos_moved: moved,
      photos_modified: modified,
      photos_processing: queued,
      photos_processed: 0,
      // The renditions are a different kind of work at a different rate, and the
      // scan's figure is not one the client should carry into them.
      photos_per_second: null,
    };
    statusStore.set(libraryId, status);
    log.info('scan done', {
      library: libraryId,
      added: batch.added,
      removed,
      moved,
      relocatedShoots: relocations.length,
      mirroredShoots: mirrored,
      modified,
      reappeared: diff.reappeared.length,
      sidecarsImported: batch.importedEdits,
      queuedForProcessing: queued,
      ms: Date.now() - startedAt,
    });
    return { status, processingIds };
  
}
