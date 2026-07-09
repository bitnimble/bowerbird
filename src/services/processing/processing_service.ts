import { rm } from 'node:fs/promises';
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
    const poolSize = Math.min(this.config.processingConcurrency, jobs.length);
    return new Promise((resolve) => {
      let next = 0;
      let live = 0;

      const launch = (): void => {
        live++;
        const worker = new Worker(WORKER_URL);
        let current: ProcessingJob | undefined;

        const assignNext = (): void => {
          if (next >= jobs.length) {
            worker.terminate();
            live--;
            if (live === 0) resolve();
            return;
          }
          current = jobs[next++];
          worker.postMessage(current);
        };

        worker.onmessage = (event: MessageEvent<ProcessingResult>) => {
          this.applyResult(event.data);
          assignNext();
        };
        // Bun kills the worker thread after onerror fires, so the worker can't be
        // reused. A native crash (segfault in LibRaw/sharp) skips the worker's own
        // catch, so clean up the in-flight job's partial/stale output here too,
        // record the failure, drop this worker, and launch a replacement.
        worker.onerror = (event: ErrorEvent) => {
          if (current != null) {
            void rm(current.smallOutputPath, { force: true }).catch(() => {});
            void rm(current.fullOutputPath, { force: true }).catch(() => {});
            this.applyResult({ photoId: current.photoId, success: false, error: `worker crashed: ${event.message}` });
          }
          worker.terminate();
          live--;
          if (next < jobs.length) launch();
          else if (live === 0) resolve();
        };

        assignNext();
      };

      if (!(poolSize > 0)) {
        resolve(); // no jobs, or a non-positive/NaN concurrency slipped through
        return;
      }
      for (let i = 0; i < poolSize; i++) launch();
    });
  }
}
