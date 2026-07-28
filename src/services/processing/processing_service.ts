import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../../config';
import type { Library } from '../../schemas/libraries';
import { dataPathFor, getDataPath, renditionPathFor } from '../../utils/paths';
import type { PendingPhoto, PhotosRepository } from '../photos/photos_repository';
import type { HdrMedium, HdrVariant } from './hdr_media';
import type {
  HdrGrade,
  HdrJob,
  ProcessingResult,
  RenditionJob,
  RenditionTarget,
  ThumbnailSource,
} from './processing_types';
import { renditionDirs, type Rendition } from './renditions';

const WORKER_URL = new URL('./processing_worker.ts', import.meta.url).href;

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

  // Rebuilds thumbnails for specific photos from the given source. Returns how
  // many were queued; ids that are missing or binned have no file to read.
  async reprocess(photoIds: string[], source: ThumbnailSource): Promise<number> {
    const queued = this.photos.queueReprocess(photoIds, source);
    if (queued > 0) await this.processUnprocessed();
    return queued;
  }

  // One rendition, on demand: the detail view asking for a size or a range it
  // does not have yet. The photo view's own renditions are always renders, never
  // the embedded JPEG, which is served as itself rather than built (§10.2); the
  // grid tile is the exception, since it is re-encoded from whichever source the
  // library imports from.
  renderOne(
    rawFilePath: string,
    photoId: string,
    library: Library,
    rendition: Rendition,
    hdr: boolean,
    source: ThumbnailSource = 'render',
  ): Promise<void> {
    return this.runOneOff({
      kind: 'rendition',
      photoId,
      rawFilePath,
      dataPath: getDataPath(library),
      targets: [this.target(getDataPath(library), library.preview_hdr_video, photoId, rendition, hdr, source)],
      grade: this.grade(),
      reportSource: false,
      // The on-demand rendition has to agree with the ones built at import, so it
      // obeys the same setting. The fit is deterministic, so refitting here lands
      // on the same transform rather than a second opinion.
      matchEmbeddedJpeg: this.config.matchEmbeddedJpeg,
    });
  }

  // Size, quality and encoder settings for one rendition. The grid and the
  // full-size view share the thumbnail settings; the max-resolution one is native
  // size at the tighter lossless quality, because it exists to be pixel-peeped.
  private target(
    dataPath: string,
    hdrVideo: boolean,
    photoId: string,
    rendition: Rendition,
    hdr: boolean,
    source: ThumbnailSource,
  ): RenditionTarget {
    const sizes: Record<Rendition, number> = {
      grid: this.config.smallThumbnailSize,
      full: this.config.fullThumbnailSize,
      max: 0,
    };
    const qualities: Record<Rendition, number> = {
      grid: this.config.smallThumbnailQuality,
      full: this.config.fullThumbnailQuality,
      max: this.config.losslessQuality,
    };
    return {
      rendition,
      hdr,
      source,
      outputPath: renditionPathFor(dataPath, photoId, rendition, hdr),
      videoOutputPath: hdr && hdrVideo ? renditionPathFor(dataPath, photoId, rendition, hdr, true) : null,
      size: sizes[rendition],
      quality: qualities[rendition],
      quantizer: rendition === 'max' ? this.config.losslessQuantizer : this.config.hdrCrf,
      effort: this.config.thumbnailEffort,
      preset: this.config.hdrPreset,
    };
  }

  renderHdr(rawFilePath: string, outputPath: string, photoId: string, medium: HdrMedium, variant: HdrVariant): Promise<void> {
    return this.runOneOff({
      kind: 'hdr',
      photoId,
      rawFilePath,
      outputPath,
      variant,
      medium,
      grade: this.grade(),
      crf: this.config.hdrCrf,
      preset: this.config.hdrPreset,
      maxEdge: this.config.hdrMaxEdge,
    });
  }

  private grade(): HdrGrade {
    return {
      peakNits: this.config.hdrPeakNits,
      referenceWhiteNits: this.config.hdrReferenceWhiteNits,
      whiteQuantile: this.config.hdrWhiteQuantile,
    };
  }

  // One photo, on demand, outside the pending queue: a single explicit request
  // the user is waiting on, not background work to batch. Its own worker, so a
  // render that takes seconds cannot occupy a pool slot the thumbnail queue
  // needs.
  private async runOneOff(job: RenditionJob | HdrJob): Promise<void> {
    const worker = new Worker(WORKER_URL);
    try {
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<ProcessingResult>) => {
          if (event.data.success) resolve();
          else reject(new Error(event.data.error));
        };
        worker.onerror = (event: ErrorEvent) => reject(new Error(`worker crashed: ${event.message}`));
        worker.postMessage(job);
      });
    } finally {
      worker.terminate();
    }
  }

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

  // A photo is only reprocessed because its pixels changed: the sync saw a new
  // stat, or the user asked for a rebuild. Every derived copy is then of the old
  // file, and the ones this job does not itself rewrite - the other dynamic
  // range, the max-resolution export - would be served forever with nothing to
  // notice. Cheaper to clear the lot and let them be rebuilt on request.
  private dropStaleRenditions(job: RenditionJob): void {
    const fresh = new Set(
      job.targets.flatMap((t) => (t.videoOutputPath == null ? [t.outputPath] : [t.outputPath, t.videoOutputPath])),
    );
    for (const { dir, extension } of renditionDirs()) {
      const file = path.join(job.dataPath, 'renditions', dir, `${job.photoId}${extension}`);
      if (fresh.has(file)) continue;
      void rm(file, { force: true }).catch(() => {});
    }
  }

  // What an import builds: the grid tile always, and the full-size view only when
  // the library renders. A library set to the camera's JPEG serves that JPEG
  // directly for the photo view, so there is nothing to build for it (§10.2).
  private toJob(pending: PendingPhoto): RenditionJob {
    const dataPath = dataPathFor(pending.root_path, pending.data_path);
    // NULL for rows queued before the setting existed, and for anything the sync
    // inserted without naming one; the library's default answers both.
    const source = pending.rendition_source ?? pending.preview_source;
    const hdrVideo = pending.preview_hdr_video === 1;
    const photoId = pending.photo_id;
    const targets = [this.target(dataPath, hdrVideo, photoId, 'grid', false, source)];
    if (source === 'render') {
      targets.push(this.target(dataPath, hdrVideo, photoId, 'full', pending.preview_hdr === 1, 'render'));
    }
    return {
      kind: 'rendition',
      photoId,
      rawFilePath: path.join(pending.root_path, pending.file_path),
      dataPath,
      targets,
      grade: this.grade(),
      reportSource: true,
      matchEmbeddedJpeg: this.config.matchEmbeddedJpeg,
    };
  }

  private applyResult(result: ProcessingResult, job: RenditionJob): void {
    // Never throw: this runs inside a worker's onmessage/onerror, and a throw here
    // would skip the pool's assignNext/terminate/live-- bookkeeping and hang the
    // batch forever. On a DB write failure, log and leave needs_processing=1.
    try {
      if (result.success) {
        // The worker reports what it actually used, which differs from the
        // request when a file has no embedded preview to lift.
        this.photos.markProcessed(result.photoId, new Date().toISOString(), result.source ?? 'render');
        this.dropStaleRenditions(job);
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

  private runPool(jobs: RenditionJob[]): Promise<void> {
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
        let current: RenditionJob | undefined;

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
            for (const target of current.targets) {
              void rm(target.outputPath, { force: true }).catch(() => {});
              if (target.videoOutputPath != null) void rm(target.videoOutputPath, { force: true }).catch(() => {});
            }
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
