import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../../config';
import type { Library } from '../../schemas/libraries';
import { deleteGeneratedFile } from '../../utils/deletions';
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
/** One photo's import, as the two passes a batch runs it in. */
interface StagedPhoto {
  photoId: string;
  rawFilePath: string;
  dataPath: string;
  /** The grid tile, from the fastest source there is. Always present. */
  tile: RenditionJob;
  /** The photo viewer's renditions. Null when the library serves the camera's JPEG. */
  renditions: RenditionJob | null;
}

export class ProcessingService {
  // Per-scope in-flight batch. A concurrent call returns the SAME promise (so an
  // awaiter genuinely waits for completion) and flags a rerun so work queued
  // during the batch is drained before the promise resolves.
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly rerun = new Set<string>();
  private readonly processed = new Set<(photoId: string, version: string) => void>();

  constructor(
    private readonly photos: PhotosRepository,
    private readonly config: Config,
  ) {}

  /** Called with each photo whose renditions have just been written, and when. */
  onProcessed(listener: (photoId: string, version: string) => void): void {
    this.processed.add(listener);
  }

  // Announced from the two places that write a rendition - the queue's result
  // handler and the one-off run - rather than from the queue alone: an on-demand
  // build is a file changing behind a URL exactly as much as a queued one is, and
  // the grid tile repaired on a detail read (§18.6) has no other way to be told.
  private announce(photoId: string, version: string): void {
    for (const listener of this.processed) listener(photoId, version);
  }

  // Rebuilds thumbnails for specific photos from the given source. Returns how
  // many were queued; ids that are missing or binned have no file to read.
  async reprocess(photoIds: string[], source: ThumbnailSource): Promise<number> {
    const queued = this.photos.queueReprocess(photoIds, source);
    if (queued > 0) await this.processUnprocessed();
    return queued;
  }

  // One rendition, on demand: the detail view asking for a size or a range it
  // does not have yet. The photo view's own renditions are always renders, never
  // the embedded JPEG, which is served as itself rather than built (§10.2); a grid
  // tile rebuilt here passes 'embedded', matching what the import builds.
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
      // The HDR diagnostics write their own files under their own names and no
      // view reads them off a rendition URL, so only a rendition is worth saying.
      if (job.kind === 'rendition') {
        const version = new Date().toISOString();
        this.photos.touchReprocessed(job.photoId, version);
        this.announce(job.photoId, version);
      }
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
      const staged = this.photos.listPendingProcessing(libraryId).map((p) => this.toStages(p));
      if (staged.length > 0) await this.runStaged(staged);
      if (!this.rerun.has(key)) return; // no new work requested during this pass
    }
  }

  // Every grid tile first, then every rendition.
  //
  // Both passes cover the same photos, so this is purely an ordering choice, and it
  // is the whole point of splitting them: a tile is ~125ms against ~1.5s for a
  // render, so a shoot's grid is browsable in about a minute instead of after the
  // renders finish. `needs_processing` is not cleared until the renditions land, so
  // a crash between the passes redoes the tile too - 125ms, against the alternative
  // of a second column to track half-done photos.
  private async runStaged(staged: StagedPhoto[]): Promise<void> {
    const tiled = new Set<string>();
    const byId = new Map(staged.map((photo) => [photo.photoId, photo]));

    // A photo whose tile failed is not carried into the second pass: the failure is
    // the file, not the stage, so a render would fail the same way.
    await this.runPool(
      staged.map((photo) => photo.tile),
      (result, job) => {
        const photo = byId.get(result.photoId) ?? null;
        if (!result.success) {
          this.recordFailure(result, job, photo);
          return;
        }
        tiled.add(result.photoId);
        // Nothing more to build: this library serves the camera's JPEG in the
        // viewer, so the tile was the whole import.
        if (photo?.renditions == null) this.markDone(photo, result.photoId);
      },
    );

    const pending = staged.filter((photo) => photo.renditions != null && tiled.has(photo.photoId));
    if (pending.length === 0) return;

    await this.runPool(
      pending.map((photo) => photo.renditions as RenditionJob),
      (result, job) => {
        const photo = byId.get(result.photoId) ?? null;
        if (!result.success) {
          this.recordFailure(result, job, photo);
          return;
        }
        this.markDone(photo, result.photoId);
      },
    );
  }

  // Clears the pending flag once every stage of a photo has landed, and sweeps the
  // renditions this import did not itself rewrite.
  private markDone(photo: StagedPhoto | null, photoId: string): void {
    try {
      // What the photo viewer will be served, which is the only thing this column is
      // read back for. Not the tile's own source: the tile is always the embedded
      // JPEG whatever the library says, so recording that would tell the next import
      // there are no renditions to build - and `dropStaleRenditions` would then
      // delete the ones there are, with nothing to ever rebuild them.
      const source: ThumbnailSource = photo == null || photo.renditions != null ? 'render' : 'embedded';
      const version = new Date().toISOString();
      this.photos.markProcessed(photoId, version, source);
      if (photo != null) this.dropStaleRenditions(photo);
      // After the writes, so a client told the photo is ready cannot ask for it
      // before the row and the files say so. The same stamp the row took, or the
      // URL a client builds from the event would not be the one the next list
      // read hands it.
      this.announce(photoId, version);
    } catch (err) {
      // Never throw: this runs inside a worker's onmessage/onerror, and a throw here
      // would skip the pool's assignNext/terminate/live-- bookkeeping and hang the
      // batch forever. On a DB write failure, log and leave needs_processing=1.
      console.error(`markDone failed for photo ${photoId}: ${(err as Error).message}`);
    }
  }

  // A photo is only reprocessed because its pixels changed: the sync saw a new
  // stat, or the user asked for a rebuild. Every derived copy is then of the old
  // file, and the ones this job does not itself rewrite - the other dynamic
  // range, the max-resolution export - would be served forever with nothing to
  // notice. Cheaper to clear the lot and let them be rebuilt on request.
  private dropStaleRenditions(photo: StagedPhoto): void {
    // Both stages' outputs, not one stage's: sweeping after the tile alone would
    // delete the very renditions the second stage is about to write.
    const targets = [...photo.tile.targets, ...(photo.renditions?.targets ?? [])];
    this.sweepRenditions(
      photo,
      new Set(
        targets.flatMap((t) => (t.videoOutputPath == null ? [t.outputPath] : [t.outputPath, t.videoOutputPath])),
      ),
    );
  }

  /** Deletes every rendition of `photo` except the ones named in `keep`. */
  private sweepRenditions(photo: StagedPhoto, keep: Set<string>): void {
    for (const { dir, extension } of renditionDirs()) {
      const file = path.join(photo.dataPath, 'renditions', dir, `${photo.photoId}${extension}`);
      if (keep.has(file)) continue;
      void deleteGeneratedFile(photo.dataPath, file).catch(() => {});
    }
  }

  // One photo's import, split into the two stages it is worth running separately.
  //
  // The grid tile is always the camera's embedded JPEG, which is what makes the
  // split pay: it is ~125ms where a render is ~1.5s, so doing every tile first
  // fills the whole grid of a 2000-frame shoot in about a minute rather than the
  // eleven the renders take. A body that embeds no JPEG falls back to a render
  // inside the worker, so this is "the fastest source there is" rather than
  // "always the JPEG".
  //
  // The renditions are the photo viewer's, and only exist when the library renders
  // for it: a library set to the camera's JPEG serves that JPEG directly, so there
  // is nothing to build (§10.2).
  private toStages(pending: PendingPhoto): StagedPhoto {
    const dataPath = dataPathFor(pending.root_path, pending.data_path);
    // NULL for rows queued before the setting existed, and for anything the sync
    // inserted without naming one; the library's default answers both.
    const source = pending.rendition_source ?? pending.preview_source;
    const hdrVideo = pending.preview_hdr_video === 1;
    const photoId = pending.photo_id;
    const rawFilePath = path.join(pending.root_path, pending.file_path);
    const common = {
      kind: 'rendition',
      photoId,
      rawFilePath,
      dataPath,
      grade: this.grade(),
      matchEmbeddedJpeg: this.config.matchEmbeddedJpeg,
    } as const;

    const tile: RenditionJob = {
      ...common,
      targets: [this.target(dataPath, hdrVideo, photoId, 'grid', false, 'embedded')],
    };
    const renditions: RenditionJob | null =
      source === 'render'
        ? {
            ...common,
            targets: [this.target(dataPath, hdrVideo, photoId, 'full', pending.preview_hdr === 1, 'render')],
          }
        : null;

    return { photoId, rawFilePath, dataPath, tile, renditions };
  }

  private recordFailure(
    result: Extract<ProcessingResult, { success: false }>,
    job: RenditionJob,
    photo: StagedPhoto | null,
  ): void {
    // Never throw: this runs inside a worker's onmessage/onerror, and a throw here
    // would skip the pool's assignNext/terminate/live-- bookkeeping and hang the
    // batch forever. On a DB write failure, log and leave needs_processing=1.
    try {
      // If the source file moved/was deleted since the job was queued (a move that
      // landed before the worker ran), don't burn it as a terminal failure: leave
      // needs_processing=1 so a later sync reprocesses it at its current path.
      if (!existsSync(job.rawFilePath)) return;
      this.photos.markProcessingFailed(result.photoId, result.error);
      // Every derivative, not just the stage that failed. A photo is only being
      // reprocessed because its pixels changed, so the ones this run did not reach -
      // the renditions, when it was the tile that crashed - are of the old file and
      // would be served forever with nothing to notice.
      if (photo != null) this.sweepRenditions(photo, new Set());
    } catch (err) {
      console.error(`recordFailure failed for photo ${result.photoId}: ${(err as Error).message}`);
    }
  }

  private runPool(
    jobs: RenditionJob[],
    onResult: (result: ProcessingResult, job: RenditionJob) => void,
  ): Promise<void> {
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
          if (current != null) onResult(event.data, current);
          assignNext();
        };
        // Bun kills the worker thread after onerror fires, so the worker can't be
        // reused. A native crash (segfault in LibRaw/libvips) skips the worker's own
        // catch, so clean up the in-flight job's partial/stale output here too,
        // record the failure, drop this worker, and launch a replacement.
        worker.onerror = (event: ErrorEvent) => {
          if (current != null) {
            for (const target of current.targets) {
              void deleteGeneratedFile(current.dataPath, target.outputPath).catch(() => {});
              if (target.videoOutputPath != null) {
                void deleteGeneratedFile(current.dataPath, target.videoOutputPath).catch(() => {});
              }
            }
            onResult({ photoId: current.photoId, success: false, error: `worker crashed: ${event.message}` }, current);
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
