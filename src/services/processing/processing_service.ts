import path from 'node:path';
import type { Config } from '../../config';
import type { PendingPhoto, PhotosRepository } from '../photos/photos_repository';
import type { ProcessingJob, ProcessingResult } from './processing_types';

const WORKER_URL = new URL('./processing_worker.ts', import.meta.url).href;

function dataDir(pending: PendingPhoto): string {
  return pending.data_path ?? path.join(pending.root_path, '.bowerbird');
}

// Orchestrates thumbnail generation across a pool of Bun workers (DESIGN §10.2).
// Workers decode + encode; the main thread owns all DB writes so bun:sqlite is
// only ever touched from one thread.
export class ProcessingService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly photos: PhotosRepository,
    private readonly config: Config,
  ) {}

  async processUnprocessed(libraryId?: string): Promise<void> {
    const key = libraryId ?? '*';
    if (this.inFlight.has(key)) return; // a batch for this scope is already running
    this.inFlight.add(key);
    try {
      const jobs = this.photos.listPendingProcessing(libraryId).map((p) => this.toJob(p));
      if (jobs.length > 0) await this.runPool(jobs);
    } finally {
      this.inFlight.delete(key);
    }
  }

  getProcessingStatus(libraryId: string): { library_id: string; pending: number } {
    return { library_id: libraryId, pending: this.photos.countPendingProcessing(libraryId) };
  }

  private toJob(pending: PendingPhoto): ProcessingJob {
    const thumbs = path.join(dataDir(pending), 'thumbnails');
    return {
      photoId: pending.photo_id,
      rawFilePath: path.join(pending.root_path, pending.file_path),
      smallOutputPath: path.join(thumbs, 'small', `${pending.photo_id}.webp`),
      fullOutputPath: path.join(thumbs, 'full', `${pending.photo_id}.webp`),
      smallSize: this.config.smallThumbnailSize,
      fullSize: this.config.fullThumbnailSize,
      smallQuality: this.config.smallThumbnailQuality,
      fullQuality: this.config.fullThumbnailQuality,
    };
  }

  private applyResult(result: ProcessingResult): void {
    if (result.success) this.photos.markProcessed(result.photoId, new Date().toISOString());
    else this.photos.markProcessingFailed(result.photoId, result.error);
  }

  private runPool(jobs: ProcessingJob[]): Promise<void> {
    return new Promise((resolve) => {
      let next = 0;
      let live = 0;

      const feed = (worker: Worker): void => {
        if (next < jobs.length) {
          worker.postMessage(jobs[next++]);
        } else {
          worker.terminate();
          if (--live === 0) resolve();
        }
      };

      const poolSize = Math.min(this.config.processingConcurrency, jobs.length);
      for (let i = 0; i < poolSize; i++) {
        const worker = new Worker(WORKER_URL);
        live++;
        worker.onmessage = (event: MessageEvent<ProcessingResult>) => {
          this.applyResult(event.data);
          feed(worker);
        };
        worker.onerror = () => feed(worker); // worker crashed: free the slot, move on
        worker.postMessage(jobs[next++]);
      }
    });
  }
}
