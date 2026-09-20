import { AppError } from '../../../errors';
import { Logger } from '../../../logger';
import type { LibraryScanStatus } from '../../../schemas/libraries';
import type { ProcessingScope } from '../../processing/pipeline/processing_service';
import type { TileEncoding } from '../../processing/analysis/metadata';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import type { ScanLeases } from './scan_leases';
import { idleScanStatus, type ScanStatus } from './scan_status';

const log = new Logger('scan');

export interface ProcessingTrigger {
  processUnprocessed(scope?: ProcessingScope, stopped?: () => boolean): void | Promise<void>;
  /**
   * How this library's grid tiles are encoded, for a scan to build them while it holds each
   * RAW open (§10.4), or undefined where it should leave them to the rendition pass.
   *
   * Asked of the service that owns the answer rather than read here: the size and the
   * quantizer are settings, and a scan encoding to its own idea of them would fill a library
   * with tiles that do not match the ones built any other way.
   */
  tileEncoding?(): TileEncoding;
  /**
   * Take on a tile the scan built, now that the photo has the id it was waiting for: rename it
   * into place and record it as the tile pass would have (§10.4).
   */
  adoptScannedTile?(photoId: string, dataPath: string, staged: string): Promise<boolean>;
  /** Drop one no row claimed - the file turned out to be a move, or was never written down. */
  discardScannedTile?(staged: string): Promise<void>;
}

export class ScanRebuilds {
  constructor(
    private readonly photoProcessing: PhotoProcessingRepository,
    private readonly libraries: LibrariesRepository,
    private readonly leases: ScanLeases,
    private readonly status: ScanStatus,
    private readonly processing: ProcessingTrigger,
  ) {}

  // Rebuild every grid tile in the library, without scanning. Same status strip
  // as a scan's processing tail, so Stop and progress keep working.
  rebuildTiles(libraryId: string): LibraryScanStatus {
    return this.rebuildStage(libraryId, 'tiles');
  }

  // Rebuild every viewer rendition in the library. Refused when the library
  // serves the camera's JPEG: there is nothing to demosaic (§10.1).
  rebuildRenditions(libraryId: string): LibraryScanStatus {
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
  // detached batch a scan uses. The lease covers the claim only: queue,
  // generation and status must be one ownership decision.
  private rebuildStage(libraryId: string, stage: 'tiles' | 'renditions'): LibraryScanStatus {
    const startedAt = Date.now();
    const library = this.libraries.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    const current = this.status.current(libraryId);
    if (current != null && current.status !== 'idle') {
      throw new AppError('SYNC_IN_PROGRESS', 'a scan is already running for this library');
    }

    const owner = this.leases.acquire(libraryId);
    try {
      const claimed = this.status.current(libraryId);
      if (claimed != null && claimed.status !== 'idle') {
        throw new AppError('SYNC_IN_PROGRESS', 'a scan is already running for this library');
      }

      const queued =
        stage === 'tiles'
          ? this.photoProcessing.queueTileRebuildForLibrary(libraryId)
          : this.photoProcessing.queueRenditionRebuildForLibrary(libraryId);
      log.info('library rebuild queued', { library: libraryId, stage, queued });
      if (queued === 0) return idleScanStatus(libraryId);

      const token = this.leases.begin(libraryId);
      const status: LibraryScanStatus = {
        ...idleScanStatus(libraryId, 'rendition'),
        photos_processing: queued,
      };
      this.status.setBatch(libraryId, queued, null);
      this.status.set(libraryId, status);
      this.detachProcessing(libraryId, token, status, null, startedAt);
      return status;
    } finally {
      this.leases.release(libraryId, owner);
    }
  }

  // Detached rendition batch: returns immediately, reports through status, and
  // settles this generation when the pool drains.
  detachProcessing(
    libraryId: string,
    token: AbortController,
    finalStatus: LibraryScanStatus,
    photoIds: readonly string[] | null,
    startedAt: number,
  ): void {
    const scope: ProcessingScope = { libraryId, photoIds: photoIds ?? undefined };
    // Both promise arms reach this. Idempotence prevents listener delivery twice
    // if settling itself fails.
    let settled = false;
    const settle = (): void => {
      if (settled || !this.leases.isCurrent(libraryId, token)) return;
      settled = true;
      const stillPending = this.photoProcessing.countPendingProcessing(libraryId, scope.photoIds);
      const processed = Math.max(0, finalStatus.photos_processing - stillPending);
      // Listeners run before idle becomes visible: one may change collection shape,
      // and a client re-reads as soon as it observes idle.
      const changed = finalStatus.photos_added + finalStatus.photos_modified > 0;
      this.status.notifySettled(libraryId, changed);
      this.status.set(libraryId, {
        ...finalStatus,
        status: 'idle',
        photos_processing: stillPending,
        photos_processed: processed,
      });
      if (finalStatus.photos_processing > 0) {
        log.info('processing settled', { library: libraryId, processed, stillPending, ms: Date.now() - startedAt });
      }
    };
    // Ask whichever generation is current: processing can outlive the scan that started it.
    const stopped = (): boolean => this.leases.stopped(libraryId);
    void Promise.resolve(this.processing.processUnprocessed(scope, stopped))
      .then(settle)
      .catch((err) => {
        log.error('processing failed', { library: libraryId, err });
        settle();
      });
  }
}
