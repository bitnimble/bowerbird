import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../../config';
import { Logger } from '../../logger';
import type { Library } from '../../schemas/libraries';
import { deleteGeneratedFile } from '../../utils/deletions';
import { dataPathFor, getDataPath, renditionPathFor } from '../../utils/paths';
import type { PendingPhoto, PhotosRepository } from '../photos/photos_repository';
import type { HdrMedium, HdrVariant } from './hdr_media';
import type {
  HdrGrade,
  HdrJob,
  ProcessingResult,
  ProcessingStage,
  RenditionJob,
  RenditionTarget,
  RenditionWritten,
  ThumbnailSource,
} from './processing_types';
import { renditionDirs, type Rendition } from './renditions';

const WORKER_URL = new URL('./processing_worker.ts', import.meta.url).href;

const log = new Logger('processing');

// Orchestrates thumbnail generation across a pool of Bun workers (DESIGN §10.2).
// Workers decode + encode; the main thread owns all DB writes so bun:sqlite is
// only ever touched from one thread.
/** One photo's import, as the two passes a batch runs it in. */
interface StagedPhoto {
  photoId: string;
  rawFilePath: string;
  dataPath: string;
  /** The grid tile, from the fastest source there is. Null once it has been built. */
  tile: RenditionJob | null;
  /** The photo viewer's renditions. Null when the library serves the camera's JPEG. */
  renditions: RenditionJob | null;
  /**
   * Whether the viewer's side of this photo is this run's business at all. False
   * for a tile rebuild asked for on its own, which must neither stamp
   * `rendition_source` nor sweep the renditions it was never going to write.
   */
  owesRenditions: boolean;
}

/** Which photos a batch is for: a whole library, a named set, or everything. */
export interface ProcessingScope {
  libraryId?: string;
  /** Only these, rather than everything the library still owes work on. */
  photoIds?: readonly string[];
}

export class ProcessingService {
  // Per-key in-flight batch. A concurrent call returns the SAME promise (so an
  // awaiter genuinely waits for completion) and widens `queued` so work asked for
  // during the batch is drained before the promise resolves.
  private readonly inFlight = new Map<string, Promise<void>>();
  // What the next pass of each key's batch covers: a set of photo ids, or null
  // for everything pending. Absent means nothing more to do, which is how the
  // drain loop knows to stop.
  private readonly queued = new Map<string, Set<string> | null>();
  private readonly processed = new Set<(photoId: string, written: RenditionWritten) => void>();

  constructor(
    private readonly photos: PhotosRepository,
    private readonly config: Config,
  ) {}

  /** Called with each derived file written: which photo, which stage, and when. */
  onProcessed(listener: (photoId: string, written: RenditionWritten) => void): void {
    this.processed.add(listener);
  }

  // Announced from the two places that write a rendition - the queue's result
  // handler and the one-off run - rather than from the queue alone: an on-demand
  // build is a file changing behind a URL exactly as much as a queued one is, and
  // the grid tile repaired on a detail read (§18.6) has no other way to be told.
  private announce(photoId: string, written: RenditionWritten): void {
    for (const listener of this.processed) listener(photoId, written);
  }

  // Rebuilds the grid tile of specific photos, from the camera's JPEG an import
  // builds it from. Returns how many were queued; ids that are missing or binned
  // have no file to read.
  async rebuildTiles(photoIds: string[]): Promise<number> {
    const queued = this.photos.queueTileRebuild(photoIds);
    // Scoped to what was asked for: the caller is awaiting this, and a library
    // with a backlog would otherwise make a three-photo rebuild wait it out.
    if (queued > 0) await this.processUnprocessed({ photoIds });
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
      // Which stamp it moves follows which file it wrote: a repaired grid tile is
      // the gallery's, anything else is the viewer's.
      if (job.kind === 'rendition') {
        const stage: ProcessingStage = job.targets.every((t) => t.rendition === 'grid') ? 'tile' : 'renditions';
        const version = new Date().toISOString();
        if (stage === 'tile') this.photos.markTileBuilt(job.photoId, version);
        else this.photos.markRenditionsBuilt(job.photoId, version, 'render');
        this.announce(job.photoId, { stage, version });
      }
    } finally {
      worker.terminate();
    }
  }

  // `stopped` ends the batch between jobs (a sync the user stopped, §9.10). What is
  // already on disk stays - a tile is valid whether or not the rest of the run
  // finished - and everything unreached keeps its flags for the next sync.
  //
  // A predicate rather than an `AbortSignal`, because a batch outlives the sync
  // that started it: a later sync of the same library coalesces into this one and
  // its signal is dropped on the floor by the dedup below, so a stop aimed at that
  // newer run would never reach the batch actually doing its work. Asked each time
  // instead, the caller answers for whichever run is current.
  processUnprocessed(scope: ProcessingScope = {}, stopped?: () => boolean): Promise<void> {
    const key = scope.libraryId ?? '*';
    this.widen(key, scope.photoIds);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    return this.start(scope.libraryId, key, stopped);
  }

  // `drain` is async, so its return resolves a promise and the cleanup below runs
  // a microtask later. A call landing in that gap finds this key still in flight,
  // is handed a batch that has already settled, and leaves what it asked for in
  // `queued` with nothing running to take it. So the same check that ends a batch
  // is made again after it is out of the map, and starts the next one.
  private start(libraryId: string | undefined, key: string, stopped?: () => boolean): Promise<void> {
    const run = this.drain(libraryId, key, stopped).finally(() => {
      this.inFlight.delete(key);
      // Not while stopped: `drain` returns without consuming `queued` in that
      // case, so relaunching on it would spin.
      if (stopped?.() !== true && this.queued.has(key)) void this.start(libraryId, key, stopped);
    });
    // Before any `.finally` callback can run, since those are microtasks and this
    // is not - so the key is never deleted before it is set.
    this.inFlight.set(key, run);
    return run;
  }

  // Absorbing, so a request that covers more than the running batch always wins:
  // a full sync joining a batch a scoped one started must not come away having
  // processed only that scoped run's handful of files.
  private widen(key: string, photoIds?: readonly string[]): void {
    if (photoIds == null) {
      this.queued.set(key, null);
      return;
    }
    const current = this.queued.get(key);
    if (current === null) return; // already everything
    const set = current ?? new Set<string>();
    for (const id of photoIds) set.add(id);
    this.queued.set(key, set);
  }

  private async drain(libraryId: string | undefined, key: string, stopped?: () => boolean): Promise<void> {
    for (;;) {
      if (stopped?.() === true) return;
      const scope = this.queued.get(key);
      this.queued.delete(key);
      if (scope === undefined) return; // nothing asked for since the last pass
      const pending = this.photos.listPendingProcessing(libraryId, scope == null ? undefined : [...scope]);
      const staged = pending.map((p) => this.toStages(p));
      if (staged.length === 0) continue;
      const startedAt = Date.now();
      log.info('batch start', {
        library: libraryId,
        photos: staged.length,
        tiles: staged.filter((p) => p.tile != null).length,
        renditions: staged.filter((p) => p.renditions != null).length,
        workers: Math.min(this.config.processingConcurrency, staged.length),
      });
      await this.runStaged(staged, stopped);
      log.info('batch done', {
        library: libraryId,
        photos: staged.length,
        stopped: stopped?.() === true,
        ms: Date.now() - startedAt,
      });
    }
  }

  // Every grid tile first, then every rendition.
  //
  // Both passes cover the same photos, so this is purely an ordering choice, and it
  // is the whole point of splitting them: a tile is ~125ms against ~1.5s for a
  // render, so a shoot's grid is browsable in about a minute instead of after the
  // renders finish. Each pass clears its own flag as it lands, so a run interrupted
  // between them resumes at the second rather than repeating the first.
  private async runStaged(staged: StagedPhoto[], stopped?: () => boolean): Promise<void> {
    const byId = new Map(staged.map((photo) => [photo.photoId, photo]));
    // A photo whose tile failed is not carried into the second pass: the failure is
    // the file, not the stage, so a render would fail the same way.
    const failed = new Set<string>();

    await this.runPool(
      staged.flatMap((photo) => (photo.tile == null ? [] : [photo.tile])),
      (result, job) => {
        const photo = byId.get(result.photoId) ?? null;
        if (!result.success) {
          failed.add(result.photoId);
          this.recordFailure(result, job, photo);
          return;
        }
        // Its own stage, said as soon as it lands: the render behind it is still
        // ~1.5s away, and a grid already on screen should fill at the tile's pace
        // rather than wait for both.
        this.stageDone(photo, result.photoId, 'tile');
      },
      stopped,
    );

    const pending = staged.filter((photo) => photo.renditions != null && !failed.has(photo.photoId));
    if (pending.length === 0 || stopped?.() === true) return;

    await this.runPool(
      pending.map((photo) => photo.renditions as RenditionJob),
      (result, job) => {
        const photo = byId.get(result.photoId) ?? null;
        if (!result.success) {
          this.recordFailure(result, job, photo);
          return;
        }
        this.stageDone(photo, result.photoId, 'renditions');
      },
      stopped,
    );
  }

  // One stage of one photo has landed: clear its flag, stamp when it was written,
  // and say so. The stamp and the announcement carry the same value, because a
  // client builds its image URLs out of that column (DESIGN 13.5) - told a version
  // the row does not have, it would be walked back by the next list read.
  //
  // Per stage rather than per photo because the two files move at different times:
  // sharing one stamp re-fetched every grid tile on the page whenever any photo's
  // renditions were rebuilt, for bytes that had not changed.
  private stageDone(photo: StagedPhoto | null, photoId: string, stage: ProcessingStage): void {
    // Never throw: this runs inside a worker's onmessage/onerror, and a throw here
    // would skip the pool's assignNext/terminate/live-- bookkeeping and hang the
    // batch forever. On a DB write failure, log and leave the flag set.
    try {
      const version = new Date().toISOString();
      if (stage === 'tile') {
        this.photos.markTileBuilt(photoId, version);
        // Nothing more to build: this library serves the camera's JPEG in the
        // viewer, so the tile was the whole import. A tile rebuilt on its own owes
        // no renditions either, but there the viewer's side is already settled and
        // settling it again would sweep the copies it holds.
        if (photo != null && photo.renditions == null && photo.owesRenditions) this.finishRenditions(photo, photoId);
      } else {
        this.finishRenditions(photo, photoId);
      }
      // After the writes, so a client told the file is ready cannot ask for it
      // before the row says so.
      this.announce(photoId, { stage, version });
      log.debug('stage done', { photo: photoId, stage });
    } catch (err) {
      log.error('could not record a finished stage', { photo: photoId, stage, err });
    }
  }

  // The viewer's side is settled - either its renditions were built, or this
  // library has none to build - so the column recording what the viewer gets can
  // be written, and the renditions this import did not rewrite swept.
  private finishRenditions(photo: StagedPhoto | null, photoId: string): void {
    // What the photo viewer will be served, which is the only thing this column is
    // read back for. Not the tile's own source: the tile is always the embedded
    // JPEG whatever the library says, so recording that would tell the next import
    // there are no renditions to build - and `dropStaleRenditions` would then
    // delete the ones there are, with nothing to ever rebuild them.
    const source: ThumbnailSource = photo == null || photo.renditions != null ? 'render' : 'embedded';
    this.photos.markRenditionsBuilt(photoId, new Date().toISOString(), source);
    if (photo != null) this.dropStaleRenditions(photo);
  }


  // A photo is only reprocessed because its pixels changed: the sync saw a new
  // stat, or the user asked for a rebuild. Every derived copy is then of the old
  // file, and the ones this job does not itself rewrite - the other dynamic
  // range, the max-resolution export - would be served forever with nothing to
  // notice. Cheaper to clear the lot and let them be rebuilt on request.
  private dropStaleRenditions(photo: StagedPhoto): void {
    // Both stages' outputs, not one stage's: sweeping after the tile alone would
    // delete the very renditions the second stage is about to write.
    const targets = [...(photo.tile?.targets ?? []), ...(photo.renditions?.targets ?? [])];
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

    // Only the passes this photo still owes. A run interrupted between them - a
    // crash, a restart, a library that went away and came back - resumes at the
    // one it did not reach rather than redoing a tile already on disk.
    const owesRenditions = pending.needs_renditions === 1;
    const tile: RenditionJob | null =
      pending.needs_tile === 1
        ? { ...common, targets: [this.target(dataPath, hdrVideo, photoId, 'grid', false, 'embedded')] }
        : null;
    const renditions: RenditionJob | null =
      source === 'render' && owesRenditions
        ? {
            ...common,
            targets: [this.target(dataPath, hdrVideo, photoId, 'full', pending.preview_hdr === 1, 'render')],
          }
        : null;

    return { photoId, rawFilePath, dataPath, tile, renditions, owesRenditions };
  }

  private recordFailure(
    result: Extract<ProcessingResult, { success: false }>,
    job: RenditionJob,
    photo: StagedPhoto | null,
  ): void {
    // Never throw: this runs inside a worker's onmessage/onerror, and a throw here
    // would skip the pool's assignNext/terminate/live-- bookkeeping and hang the
    // batch forever. On a DB write failure, log and leave the flags set.
    try {
      // If the source file moved/was deleted since the job was queued (a move that
      // landed before the worker ran), don't burn it as a terminal failure: leave
      // its flags set so a later sync reprocesses it at its current path.
      if (!existsSync(job.rawFilePath)) {
        log.debug('job source vanished, left pending', { photo: result.photoId, file: job.rawFilePath });
        return;
      }
      log.warn('photo failed', { photo: result.photoId, file: job.rawFilePath, err: result.error });
      this.photos.markProcessingFailed(result.photoId, result.error);
      // Every derivative, not just the stage that failed. A photo is being
      // reprocessed because its pixels changed, so the ones this run did not reach -
      // the renditions, when it was the tile that crashed - are of the old file and
      // would be served forever with nothing to notice. Except when the run owed
      // the tile alone: nothing said the pixels changed, so the viewer's copies are
      // still of the file it has.
      if (photo != null && photo.owesRenditions) this.sweepRenditions(photo, new Set());
    } catch (err) {
      log.error('could not record a failure', { photo: result.photoId, err });
    }
  }

  private runPool(
    jobs: RenditionJob[],
    onResult: (result: ProcessingResult, job: RenditionJob) => void,
    stopped?: () => boolean,
  ): Promise<void> {
    const poolSize = Math.min(this.config.processingConcurrency, jobs.length);
    return new Promise((resolve) => {
      let next = 0;
      let live = 0;

      // Returns false if the worker couldn't be spawned (e.g. OS thread
      // exhaustion when several libraries process at once). Callers leave the
      // unstarted jobs pending (their flags stay set) for the next sync.
      const launch = (): boolean => {
        let worker: Worker;
        try {
          worker = new Worker(WORKER_URL);
        } catch (err) {
          log.error('could not spawn a worker; its jobs stay pending', { err });
          return false;
        }
        live++;
        let current: RenditionJob | undefined;

        const assignNext = (): void => {
          // A stop retires each worker as its current job lands rather than
          // killing it mid-encode, which would leave a half-written rendition.
          if (next >= jobs.length || stopped?.() === true) {
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
          if (next < jobs.length && stopped?.() !== true && launch()) return; // replacement running
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
