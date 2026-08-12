import { existsSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import type { Library } from '../../schemas/libraries';
import { EditDocSchema } from '../../schemas/photo_edits';
import { deleteGeneratedFile } from '../../utils/deletions';
import { dataPathForLibraryId, getDataPath, renditionPathFor } from '../../utils/paths';
import { readCameraMatch } from './camera_match_store';
import type { PendingPhoto, PhotosRepository } from '../photos/photos_repository';
import type { SettingsRepository } from '../settings/settings_repository';
import type {
  HdrGrade,
  ProcessingResult,
  ProcessingStage,
  RenditionJob,
  RenditionTarget,
  RenditionWritten,
  RenditionSource,
} from './processing_types';
import { renderTile } from './rawshim_job';
import type { JobAdjust, JobGeometry } from './rawshim_job';
import { RENDITION_EXTENSION, renditionDirs, type Rendition } from './renditions';

const WORKER_URL = new URL('./processing_worker.ts', import.meta.url).href;

/** No exposure, no adjustment, whole frame: the picture as the camera made it. */
export const AS_METERED = {
  exposure: 0,
  // The document's own defaults rather than zero. A photo nobody has edited is denoised, as
  // it was when this was a library-wide setting; "as metered" is about the *grade*.
  denoiseLuminance: 20,
  denoiseColour: 30,
  adjust: {
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    vibrance: 0,
    saturation: 0,
    texture: 0,
    clarity: 0,
    dehaze: 0,
    temperature: null,
    tint: null,
  },
  geometry: {
    crop: [0, 0, 1, 1] as [number, number, number, number],
    angleDegrees: 0,
    rotate: 0,
    keystone: null,
  },
} as const;

/**
 * The stored develop settings as the job wants them.
 *
 * **Every field passes through unchanged, and that is the point.** `EditDoc` holds Camera Raw's
 * own scales and the shaders are written against them, so there is no constant here to get
 * wrong - not even the exposure, which used to become a `2^EV` gain on the way past. Converting
 * it here meant converting it again in the editor, which is one rule with an implementation on
 * each path; `colour.wgsl` raises the stops now, once, for both.
 *
 * An unedited photo has no row, which is the common case and reads as no adjustment. A
 * document this build cannot parse reads the same way rather than failing the batch: a
 * rendition of the picture as the camera metered it is a worse rendition than the reader
 * asked for and a far better outcome than a photo that never builds one.
 */
function developed(edits: string | null): {
  exposure: number;
  denoiseLuminance: number;
  denoiseColour: number;
  adjust: JobAdjust;
  geometry: JobGeometry;
} {
  if (edits == null) return AS_METERED;
  try {
    const parsed = EditDocSchema.safeParse(JSON.parse(edits));
    if (!parsed.success) return AS_METERED;
    const doc = parsed.data;
    return {
      exposure: doc.exposure,
      denoiseLuminance: doc.luminanceNoise,
      denoiseColour: doc.colourNoise,
      adjust: {
        contrast: doc.contrast,
        highlights: doc.highlights,
        shadows: doc.shadows,
        whites: doc.whites,
        blacks: doc.blacks,
        vibrance: doc.vibrance,
        saturation: doc.saturation,
        texture: doc.texture,
        clarity: doc.clarity,
        dehaze: doc.dehaze,
        temperature: doc.temperature,
        tint: doc.tint,
      },
      geometry: {
        crop: [doc.cropLeft, doc.cropTop, doc.cropRight, doc.cropBottom],
        angleDegrees: doc.cropAngle,
        rotate: doc.rotate,
        keystone: doc.keystone,
      },
    };
  } catch {
    return AS_METERED;
  }
}

const log = new Logger('processing');

// Orchestrates rendition generation across a pool of Bun workers (DESIGN §10.2).
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
  private readonly described = new Set<(photoId: string, descriptor: Uint8Array) => void>();

  constructor(
    private readonly photos: PhotosRepository,
    private readonly settings: SettingsRepository,
    /**
     * One photo's stored develop settings, as JSON, or null where it has none.
     *
     * A function rather than the repository, and defaulted rather than required, matching the
     * seam `PhotosService.extract` uses: the batch path reads these off the pending query's
     * own join, so this exists only for the one-off renditions a viewer asks for. A test that
     * is not about edits gets the default and renders the photo as the camera metered it,
     * which is what every one of them was already asserting.
     */
    private readonly editsFor: (photoId: string) => string | null = () => null,
  ) {}

  /** Called with each derived file written: which photo, which stage, and when. */
  onProcessed(listener: (photoId: string, written: RenditionWritten) => void): void {
    this.processed.add(listener);
  }

  /**
   * Called with the stacking descriptor a grid tile produced, as it lands.
   *
   * The worker computes it off the pixels it already holds and sends it back
   * with the result, so nothing on this side decodes anything: doing that here
   * put ~20ms of synchronous native work per photo inside the pool's result
   * handler, which both stalled every HTTP request and left the worker that had
   * just finished idling until it returned.
   */
  onDescribed(listener: (photoId: string, descriptor: Uint8Array) => void): void {
    this.described.add(listener);
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

  /**
   * Both derived stages of photos whose develop settings are newer than their renders,
   * and a drain to follow. Every photo that qualifies where `photoIds` is omitted.
   *
   * **Called when an editor closes, not when it saves.** A save happens on every slider
   * release, and there is no way to know from one whether the reader is finished or two
   * seconds into an hour: rendering then spends ~1.7s of GPU at 61MP on a frame they are
   * about to change again, over and over, and throws all of it away. Nothing about the
   * intermediate states is worth building.
   *
   * Not awaited: a 61MP render is seconds of work and the caller is a page navigation.
   * What makes that correct rather than fire-and-hope is that the flags are on the row
   * first, so a drain that never ran - or a process that died mid-render - leaves the
   * work queued for the next one. And the predicate is a *state*, not an event, so the
   * sweep at startup finds anything whose editor never got to say it had closed.
   */
  rebuildEdited(photoIds?: readonly string[]): number {
    const queued = this.photos.queueEditedSince(photoIds);
    // Reported rather than thrown past: nothing is awaiting this, so an unhandled
    // rejection is all a failure would otherwise produce.
    if (queued > 0) {
      void this.processUnprocessed({ photoIds: photoIds == null ? undefined : [...photoIds] }).catch(
        (err: unknown) => log.warn('could not rebuild after an edit', { photos: queued, err }),
      );
    }
    return queued;
  }

  // One rendition, on demand: the detail view asking for a size or a range it
  // does not have yet. The photo view's own renditions are always renders, never
  // the embedded JPEG, which is served as itself rather than built (§10.2); a grid
  // tile rebuilt here passes 'embedded', matching what the import builds.
  //
  // `async` so that building the target reports through the promise rather than
  // throwing past it. `target` rejects a request that cannot be built, and the tile
  // repair calls this fire-and-forget with a `.catch()` and a `.finally()` that
  // clears its in-flight set - a synchronous throw would miss both, leaving that
  // photo unrepairable for the life of the process and turning a GET into a 500.
  async renderOne(
    rawFilePath: string,
    photoId: string,
    library: Library,
    rendition: Rendition,
    hdr: boolean,
    source: RenditionSource = 'render',
  ): Promise<void> {
    return this.runOneOff({
      kind: 'rendition',
      photoId,
      rawFilePath,
      dataPath: getDataPath(library),
      targets: [this.target(getDataPath(library), photoId, rendition, hdr, source)],
      grade: this.grade(),
      // The on-demand rendition has to agree with the ones built at import, so it
      // obeys the same settings. The fit is deterministic, so refitting here lands
      // on the same transform rather than a second opinion.
      matchEmbeddedJpeg: this.settings.get().match_embedded_jpeg,
      // And the same edits, for the same reason. This is the path a `max` export takes,
      // so without it the one rendition a reader asks for by name is the one that ignores
      // what they did to the picture.
      ...developed(this.editsFor(photoId)),
      ...this.render(),
    });
  }

  /**
   * One tile of a photograph, at the export's own quality, as PNG bytes.
   *
   * What the loupe magnifies. The reader's edits are the ones the export would use, from the
   * same `developed` this path already reads them through, so the magnified crop is the
   * photograph they are about to have rather than a second opinion on it.
   *
   * **Nothing is kept between calls.** A crop restricts the demosaic's own work and the mosaic
   * denoise takes a window, so a tile is an unpack and two small pieces of work rather than a
   * frame; because it caches nothing, a tile is a pure function of its arguments and there is
   * no invalidation to get wrong when a slider moves.
   *
   * Synchronous, like `runJob` beside it: a tile is ~110ms where a rendition is seconds, and
   * the caller is one request rather than an import queue.
   *
   * PNG rather than AVIF: the reader is judging noise and sharpness at 1:1, which is the one
   * place a lossy encoder is answering a different question from the one being asked.
   */
  renderTile(
    rawFilePath: string,
    photoId: string,
    library: Library,
    tile: [number, number, number, number],
  ): Buffer {
    const dataPath = getDataPath(library);
    return renderTile({
      rawFilePath,
      tile,
      targets: [],
      grade: this.grade(),
      matchEmbeddedJpeg: this.settings.get().match_embedded_jpeg,
      // The kept match, which is the difference between 660ms a tile and 105ms. A photo with
      // none yet fits one and does not store it: a tile hands back an image rather than an
      // outcome, and the next render of the photograph writes it anyway.
      cameraMatch: readCameraMatch(dataPath, photoId),
      ...developed(this.editsFor(photoId)),
      ...this.render(),
    });
  }

  // Size, quality and encoder settings for one rendition. The grid and the
  // full-size view share the rendition settings; the max-resolution one is native
  // size at the tighter lossless quality, because it exists to be pixel-peeped.
  private target(
    dataPath: string,
    photoId: string,
    rendition: Rendition,
    hdr: boolean,
    source: RenditionSource,
  ): RenditionTarget {
    const settings = this.settings.get();
    const sizes: Record<Rendition, number> = {
      grid: settings.grid_rendition_size,
      full: settings.full_rendition_size,
      max: 0,
    };
    const quantizers: Record<Rendition, number> = {
      grid: settings.grid_rendition_quantizer,
      full: settings.full_rendition_quantizer,
      max: settings.lossless_sdr_quantizer,
    };

    const gridTile = rendition === 'grid';

    // **A grid tile is never HDR, and asking for one is a caller's bug rather than
    // something to quietly correct.** A wall of HDR tiles is punishing to look at,
    // and it would put a linear decode and two encoder passes on every photo in an
    // import (§10.1). `renditionDir` also refuses to give an HDR grid path, so a
    // request honoured here would encode HDR and file it as SDR - which is a
    // rendition that decodes wrong, not a rendition that is merely large.
    //
    // Thrown rather than coerced because the coercion has no way to reach whoever
    // wrote it. There is one caller today whose `hdr` this would catch:
    // `PhotosService.buildRendition` takes it from the library for any rendition,
    // and is kept off the grid only by its route refusing that path.
    if (gridTile && hdr) {
      throw new AppError('VALIDATION_ERROR', 'the grid tile is always SDR; asked for an HDR one');
    }

    return {
      rendition,
      hdr,
      source,
      outputPath: renditionPathFor(dataPath, photoId, rendition, hdr),
      size: sizes[rendition],
      sdrQuantizer: quantizers[rendition],
      hdrQuantizer: rendition === 'max' ? settings.lossless_quantizer : settings.hdr_crf,
      preset: settings.hdr_preset,
      stillFullChroma: settings.hdr_still_full_chroma,
      // Not the same shape of decision as the one above, and not a coercion either:
      // chroma is a setting this reads rather than something a caller asks for, so
      // there is no bad request to reject - only a policy about which renditions the
      // setting covers. It does not cover the grid. A tile is 800px in a wall of
      // other tiles and its usual source is the camera's embedded JPEG, already
      // subsampled (`yuvj422p` on the corpus), so 4:4:4 would store chroma at a
      // resolution the source never had - measured at 0.0003 SSIM (§10.1). True of
      // the render fallback too: what makes it pointless is the size and the wall,
      // not where the pixels came from.
      sdrFullChroma: gridTile ? false : settings.sdr_full_chroma,
    };
  }

  // What the render itself gets, before any rendition is cut from it (§10.9).
  //
  // The denoise is not here any more: it belongs to the photograph rather than to the
  // library, since a frame at 12800 and one at base ISO want different answers and a single
  // setting could only be right for one of them. It rides with the rest of the document,
  // through `developed`.
  private render(): { sharpen: number; defringe: number } {
    const settings = this.settings.get();
    return {
      sharpen: settings.raw_sharpen,
      defringe: settings.raw_defringe,
    };
  }

  private grade(): HdrGrade {
    const settings = this.settings.get();
    return {
      peakNits: settings.hdr_peak_nits,
      referenceWhiteNits: settings.hdr_reference_white_nits,
      whiteQuantile: settings.hdr_white_quantile,
    };
  }

  // One photo, on demand, outside the pending queue: a single explicit request
  // the user is waiting on, not background work to batch. Its own worker, so a
  // render that takes seconds cannot occupy a pool slot the rendition queue
  // needs.
  private async runOneOff(job: RenditionJob): Promise<void> {
    const worker = new Worker(WORKER_URL);
    // A grid tile computes one whichever path built it, so the repair on a detail
    // read has to hand it over exactly as the queue does. Dropping it here left a
    // photo whose tile was rebuilt unable to stack, silently and for good: nothing
    // revisits a tile that is now on disk.
    let descriptor: Uint8Array | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<ProcessingResult>) => {
          if (event.data.success) {
            descriptor = event.data.descriptor;
            resolve();
          } else reject(new Error(event.data.error));
        };
        worker.onerror = (event: ErrorEvent) => reject(new Error(`worker crashed: ${event.message}`));
        worker.postMessage(job);
      });
      // The HDR diagnostics write their own files under their own names and no
      // view reads them off a rendition URL, so only a rendition is worth saying.
      // Which stamps move follows which files were written. `renderOne` builds one
      // target today, so this is a list of one either way; it is written per target
      // because a one-off job is the only shape that *could* carry both - the queue
      // splits a photo into a tile job and a renditions job and this does not - and
      // asked as "are they all tiles", a grid-and-full job would read as renditions
      // alone and leave `tile_built_at` unset on a tile already on disk.
      //
      // `max` moves nothing. It is an export rather than a rendition the viewer is
      // served: `renditionsOf` finds it by stat'ing the file, no column records it, and
      // nothing queues it. Counted as the renditions stage it wrote `rendition_source`
      // and cleared `needs_renditions` - so a max export off an 'embedded' library
      // stamped the photo 'render' while the viewer was still being served the camera's
      // JPEG, and told the next sync the viewer's side was finished when a full
      // rendition might still be queued for it.
      {
        const stages: ProcessingStage[] = [];
        if (job.targets.some((t) => t.rendition === 'grid')) stages.push('tile');
        if (job.targets.some((t) => t.rendition === 'full')) stages.push('renditions');
        const version = new Date().toISOString();
        for (const stage of stages) {
          if (stage === 'tile') this.photos.markTileBuilt(job.photoId, version);
          else this.photos.markRenditionsBuilt(job.photoId, version, 'render');
          this.announce(job.photoId, { stage, version });
        }
        // After the writes, and best-effort, for the reasons `stageDone` gives.
        if (descriptor != null) for (const listener of this.described) listener(job.photoId, descriptor);
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
        workers: Math.min(this.settings.get().processing_concurrency, staged.length),
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
        this.stageDone(photo, result.photoId, 'tile', result.descriptor);
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
        // And the tile, where this job rewrote it from the render. Asked of the targets
        // rather than assumed from the pool, for the reason `runOneOff` gives: a job that
        // wrote a grid file and stamped only the renditions leaves `tile_built_at` where
        // it was, so the better tile lands on disk and no client ever asks for it.
        if (job.targets.some((target) => target.rendition === 'grid')) {
          this.stageDone(photo, result.photoId, 'tile', result.descriptor);
        }
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
  private stageDone(
    photo: StagedPhoto | null,
    photoId: string,
    stage: ProcessingStage,
    descriptor?: Uint8Array,
  ): void {
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
      // Handed over as it arrives, still inside the try above: a descriptor that
      // fails to store is a photo that will not stack, which is not worth losing
      // the rendition over.
      if (descriptor != null) for (const listener of this.described) listener(photoId, descriptor);
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
    const source: RenditionSource = photo == null || photo.renditions != null ? 'render' : 'embedded';
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
      new Set([
        // The grid tile always survives, even when this run is not writing one. A
        // run resumed at its second pass owes the renditions alone, and the tile
        // its first pass wrote is of the same file: sweeping it leaves the grid
        // blank with `needs_tile` already clear, so nothing ever rebuilds it.
        renditionPathFor(photo.dataPath, photo.photoId, 'grid', false),
        ...targets.map((t) => t.outputPath),
      ]),
    );
  }

  /** Deletes every rendition of `photo` except the ones named in `keep`. */
  private sweepRenditions(photo: StagedPhoto, keep: Set<string>): void {
    for (const dir of renditionDirs()) {
      const file = path.join(photo.dataPath, 'renditions', dir, `${photo.photoId}${RENDITION_EXTENSION}`);
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
    const dataPath = dataPathForLibraryId(pending.library_id);
    // NULL for rows queued before the setting existed, and for anything the sync
    // inserted without naming one; the library's default answers both.
    //
    // An edited photo renders whatever the library says. A library set to `embedded`
    // serves the camera's own JPEG and builds nothing, which is the right default - it
    // needs no demosaic and it is the camera's rendering that a scanned catalogue is
    // for. But the camera's JPEG cannot carry an edit, so a photo edited there would
    // show the change in the editor and nowhere else, permanently and with nothing
    // saying why. Editing one is the reader asking to see it.
    //
    // Only the photos actually edited: a library of ten thousand keeps its 125ms tiles,
    // and the handful someone worked on cost ~1.7s each.
    const edited = pending.edits != null;
    const source = edited ? 'render' : (pending.rendition_source ?? pending.library_rendition_source);
    const photoId = pending.photo_id;
    const rawFilePath = path.join(pending.root_path, pending.file_path);
    const common = {
      kind: 'rendition',
      photoId,
      rawFilePath,
      dataPath,
      grade: this.grade(),
      matchEmbeddedJpeg: this.settings.get().match_embedded_jpeg,
      ...developed(pending.edits),
      ...this.render(),
    } as const;

    // Only the passes this photo still owes. A run interrupted between them - a
    // crash, a restart, a library that went away and came back - resumes at the
    // one it did not reach rather than redoing a tile already on disk.
    const owesRenditions = pending.needs_renditions === 1;
    const tile: RenditionJob | null =
      pending.needs_tile === 1
        ? { ...common, targets: [this.target(dataPath, photoId, 'grid', false, 'embedded')] }
        : null;
    // The renditions job writes the grid tile a second time, from the render.
    //
    // The first pass takes the tile off the camera's embedded JPEG because that is
    // ~125ms against ~1.5s, and it is what fills a 2000-frame shoot's grid in a minute
    // rather than eleven. But a library set to `render` then showed a gallery of the
    // camera's rendering beside a viewer showing ours, and once a photo can be *edited*
    // the two disagree about the picture itself rather than only its treatment.
    //
    // Free, within noise: the base is decoded, fitted, filtered and cut once for the
    // whole job, so the tile is a downscale of pixels already in hand and an 800px
    // encode - measured at 3940ms for grid+full against 4139ms for the full alone on a
    // 61MP body. The grid upgrades in place as the queue reaches each photo, and
    // `tile_built_at` moving is what makes a client re-fetch it.
    const renditions: RenditionJob | null =
      source === 'render' && owesRenditions
        ? {
            ...common,
            targets: [
              this.target(dataPath, photoId, 'full', pending.rendition_hdr === 1, 'render'),
              this.target(dataPath, photoId, 'grid', false, 'render'),
            ],
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
    const poolSize = Math.min(this.settings.get().processing_concurrency, jobs.length);
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
        // reused. A native crash (segfault in LibRaw/libavif) skips the worker's own
        // catch, so clean up the in-flight job's partial/stale output here too,
        // record the failure, drop this worker, and launch a replacement.
        worker.onerror = (event: ErrorEvent) => {
          if (current != null) {
            for (const target of current.targets) {
              void deleteGeneratedFile(current.dataPath, target.outputPath).catch(() => {});
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
