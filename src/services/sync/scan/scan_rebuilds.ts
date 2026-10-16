import { AppError } from '../../../errors';
import { Logger } from '../../../logger';
import type { LibraryScanStatus } from '../../../schemas/libraries';
import type { ProcessingScope } from '../../processing/pipeline/processing_service';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import type { ScanLeases } from './scan_leases';
import { idleScanStatus, type ScanStatus } from './scan_status';

const log = new Logger('scan');

export interface ProcessingTrigger {
  processUnprocessed(scope?: ProcessingScope, stopped?: () => boolean): void | Promise<void>;
  getProcessingCount?(libraryId: string): number;
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
        "this library serves the camera's JPEG in the viewer; there are no renders to rebuild",
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
        processing_work: this.photoProcessing.pendingWork(libraryId),
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
        log.info('processing settled', {
          library: libraryId,
          processed,
          stillPending,
          ms: Date.now() - startedAt,
        });
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
