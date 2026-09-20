import { AppError } from '../../../errors';
import { Logger } from '../../../logger';
import type { Library, LibraryScanStatus } from '../../../schemas/libraries';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';

const log = new Logger('scan');

interface ProcessingBatch {
  queued: number;
  /** The run's own photos, or null when the batch covers the whole library. */
  photoIds: readonly string[] | null;
}

type Status = LibraryScanStatus['status'];

export function idleScanStatus(libraryId: string, status: Status = 'idle'): LibraryScanStatus {
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
    photos_per_second: null,
  };
}

export class ScanStatus {
  private readonly statuses = new Map<string, LibraryScanStatus>();
  private readonly processingBatches = new Map<string, ProcessingBatch>();
  private readonly settledListeners = new Set<(libraryId: string, changed: boolean) => void>();
  private readonly libraryChangedListeners = new Set<(library: Library) => void>();

  constructor(
    private readonly photoProcessing: PhotoProcessingRepository,
    private readonly libraries: LibrariesRepository,
  ) {}

  set(libraryId: string, status: LibraryScanStatus): void {
    this.statuses.set(libraryId, status);
  }

  current(libraryId: string): LibraryScanStatus | undefined {
    return this.statuses.get(libraryId);
  }

  clear(libraryId: string): void {
    this.statuses.delete(libraryId);
    this.processingBatches.delete(libraryId);
  }

  setProcessing(libraryId: string): void {
    this.statuses.set(libraryId, idleScanStatus(libraryId, 'processing'));
  }

  setBatch(libraryId: string, queued: number, photoIds: readonly string[] | null): void {
    this.processingBatches.set(libraryId, { queued, photoIds });
  }

  /**
   * Called when a scan and the processing it queued have both finished, with
   * whether that scan actually brought anything in.
   *
   * `changed` is the guard a listener needs rather than a nicety: file watching
   * is on by default, so a save in a watched folder starts a scoped scan, and a
   * listener that walks the whole library would then do so every couple of
   * seconds while somebody is working in it.
   */
  onSettled(listener: (libraryId: string, changed: boolean) => void): void {
    this.settledListeners.add(listener);
  }

  notifySettled(libraryId: string, changed: boolean): void {
    for (const listener of this.settledListeners) {
      try {
        listener(libraryId, changed);
      } catch (err) {
        log.error('a settled listener failed', { library: libraryId, err });
      }
    }
  }

  /**
   * Called when a scan wrote a library's own row, which today means following a
   * renamed bin folder (§9.1.1). The watcher builds its ignore list from
   * `bin_name`, so without this it goes on ignoring a folder that is not there
   * and watching the one that is - after which every binning wakes a scan, and a
   * scoped scan over bin paths reads them as unclaimed live additions.
   */
  onLibraryChanged(listener: (library: Library) => void): void {
    this.libraryChangedListeners.add(listener);
  }

  notifyLibraryChanged(library: Library): void {
    for (const listener of this.libraryChangedListeners) {
      try {
        listener(library);
      } catch (err) {
        log.error('a library-changed listener failed', { library: library.id, err });
      }
    }
  }

  // While rendition building runs (detached, §9.5), counts come live from DB
  // rather than worker plumbing. With no in-memory status, persisted pending flags
  // still report backlog left by a killed process (§9.6).
  getScanStatus(libraryId: string): LibraryScanStatus {
    if (!this.libraries.getById(libraryId)) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    const status = this.statuses.get(libraryId);
    if (status == null) {
      return { ...idleScanStatus(libraryId), photos_processing: this.photoProcessing.countPendingProcessing(libraryId) };
    }
    if (status.status !== 'rendition') return status;

    const batch = this.processingBatches.get(libraryId);
    const stillPending = this.photoProcessing.countPendingProcessing(libraryId, batch?.photoIds ?? undefined);
    const queued = batch?.queued ?? stillPending;
    return { ...status, photos_processing: stillPending, photos_processed: Math.max(0, queued - stillPending) };
  }
}
