import { existsSync } from 'node:fs';
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
  // Per-scope in-flight batch. A concurrent call returns the SAME promise (so an
  // awaiter genuinely waits for completion) and flags a rerun so work queued
  // during the batch is drained before the promise resolves.
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly rerun = new Set<string>();

  constructor(
    private readonly photos: PhotosRepository,
    private readonly config: Config,
  ) {}

  processUnprocessed(libraryId?: string): Promise<void> {
    const key = libraryId ?? '*';
    const existing = this.inFlight.get(key);
    if (existing) {
      this.rerun.add(key); // pick up work added since the running batch started
      return existing;
    }
    const run = this.drain(libraryId, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  private async drain(libraryId: string | undefined, key: string): Promise<void> {
    for (;;) {
      this.rerun.delete(key);
      const jobs = this.photos.listPendingProcessing(libraryId).map((p) => this.toJob(p));
      if (jobs.length > 0) await this.runPool(jobs);
      if (!this.rerun.has(key)) return; // no new work requested during this pass
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

  private applyResult(result: ProcessingResult, job: ProcessingJob): void {
    // Never throw: this runs inside a worker's onmessage/onerror, and a throw here
    // would skip the pool's assignNext/terminate/live-- bookkeeping and hang the
    // batch forever. On a DB write failure, log and leave needs_processing=1.
    try {
      if (result.success) {
        this.photos.markProcessed(result.photoId, new Date().toISOString());
        return;
      }
      // If the source file moved/was deleted since the job was queued (a move that
      // landed before the worker ran), don't burn it as a terminal failure: leave
      // needs_processing=1 so a later sync reprocesses it at its current path.
      if (!existsSync(job.rawFilePath)) return;
      this.photos.markProcessingFailed(result.photoId, result.error);
    } catch (err) {
      console.error(`applyResult failed for photo ${result.photoId}: ${(err as Error).message}`);
    }
  }

  private runPool(jobs: ProcessingJob[]): Promise<void> {
    const poolSize = Math.min(this.config.processingConcurrency, jobs.length);
    return new Promise((resolve) => {
      let next = 0;
      let live = 0;

      // Returns false if the worker couldn't be spawned (e.g. OS thread
      // exhaustion when several libraries process at once). Callers leave the
      // unstarted jobs pending (needs_processing stays 1) for the next sync.
      const launch = (): boolean => {
        let worker: Worker;
        try {
          worker = new Worker(WORKER_URL);
        } catch (err) {
          console.error(`could not spawn processing worker: ${(err as Error).message}`);
          return false;
        }
        live++;
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
          if (current != null) this.applyResult(event.data, current);
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
            this.applyResult({ photoId: current.photoId, success: false, error: `worker crashed: ${event.message}` }, current);
          }
          worker.terminate();
          live--;
          if (next < jobs.length && launch()) return; // replacement running
          if (live === 0) resolve();
        };

        assignNext();
        return true;
      };

      if (!(poolSize > 0)) {
        resolve(); // no jobs, or a non-positive/NaN concurrency slipped through
        return;
      }
      let started = 0;
      for (let i = 0; i < poolSize; i++) if (launch()) started++;
      if (started === 0) resolve(); // nothing could spawn; jobs stay pending
    });
  }
}
