import { rename } from 'node:fs/promises';
import { newId } from '../../../schemas/id';
import type { Job } from '../../../schemas/jobs';
import type { Library } from '../../../schemas/libraries';
import { deleteGeneratedFile } from '../../../utils/deletions';
import { getDataPath } from '../../../utils/paths';
import type { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import type { SettingsRepository } from '../../settings/settings_repository';
import { renditionVariant, type Rendition } from '../renditions/renditions';
import { renditionSkips, withStagesOff } from '../renditions/render_stages';
import type { OptionalStage } from '../../../schemas/render_stages';
import { toCommand } from '../rawshim/worker_command';
import { workerEntry } from '../../worker_entry';
import type { CompositeWorker } from '../workers/composite_worker';
import type { ProcessingResult, RenditionJob, RenditionSource, RenditionTarget, RenditionWritten } from '../workers/processing_types';
import { developed } from './developed';
import type { RenderTargets } from './render_targets';

export class SinglePhotoRenderer {
  constructor(
    private readonly photoProcessing: PhotoProcessingRepository,
    private readonly settings: SettingsRepository,
    private readonly editsFor: (photoId: string) => { doc: string; stamp: string | null } | null,
    private readonly targets: RenderTargets,
    private readonly announce: (photoId: string, written: RenditionWritten) => void,
    private readonly describe: (photoId: string, descriptor: Uint8Array) => void,
  ) {}



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
    remeasure = false,
  ): Promise<void> {
    const { job, builtFrom } = this.oneRendition(rawFilePath, photoId, library, rendition, hdr, source, remeasure);
    return this.runOneOff(job, builtFrom);
  }



  /**
   * The job `renderOne` would run, as the native side reads it, for a client that renders it
   * itself (`job::render_bytes`) and hands the picture back to {@link keepRendered}.
   *
   * `builtFrom` is the edit stamp it renders, which the client returns with the picture: an edit
   * landing while it renders is one the picture does not include.
   */
  renditionCommand(
    photoId: string,
    library: Library,
    rendition: Rendition,
    hdr: boolean,
    remeasure: boolean,
  ): { command: Job; builtFrom: string | null } {
    const { job, builtFrom } = this.oneRendition('', photoId, library, rendition, hdr, 'render', remeasure);
    const command = toCommand(job);
    // Where the server writes it, which a client has no use for.
    return { command: { ...command, targets: command.targets.map((t) => ({ ...t, outputPath: '' })) }, builtFrom };
  }



  /** Encodes and files what a client rendered of {@link renditionCommand}'s job. */
  async keepRendered(
    photoId: string,
    library: Library,
    rendition: Rendition,
    hdr: boolean,
    builtFrom: string | null,
    rendered: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const { job } = this.oneRendition('', photoId, library, rendition, hdr, 'render', false);
    return this.runOneOff({ ...job, rendered }, builtFrom);
  }



  /**
   * The job a rendition of this photograph would run, with the stages to leave out named here
   * rather than read off the library, and writing under `dataPath` rather than under the library.
   *
   * **Both overrides are what makes a benchmark a measurement rather than an edit.** What it times
   * is one photograph rendered several ways, so it has to be able to ask for stages the library has
   * turned off; and a temporary `dataPath` keeps the rendition it writes, and the analysis the
   * render measures, off the photograph's own copies.
   *
   * **`remeasure`, and it is load-bearing rather than tidy.** A render handed the analysis on file
   * skips the camera match, the noise fit and the levels - and the first round writes that file
   * into the very directory the rest would read it from. Without this only the first round is cold
   * and the camera match measures as costing nothing.
   */
  benchmarkJob(
    rawFilePath: string,
    photoId: string,
    library: Library,
    rendition: Rendition,
    dataPath: string,
    skip: readonly OptionalStage[],
  ): RenditionJob {
    return this.oneRendition(rawFilePath, photoId, library, rendition, library.rendition_hdr, 'render', true, skip, dataPath)
      .job;
  }

  private oneRendition(
    rawFilePath: string,
    photoId: string,
    library: Library,
    rendition: Rendition,
    hdr: boolean,
    source: RenditionSource,
    remeasure: boolean,
    skip: readonly OptionalStage[] = renditionSkips(library, rendition),
    dataPath: string = getDataPath(library),
  ): { job: RenditionJob; builtFrom: string | null } {
    const edits = this.editsFor(photoId);
    return {
      job: withStagesOff(
        {
          kind: 'rendition',
          photoId,
          rawFilePath,
          dataPath,
          targets: [this.targets.target(dataPath, photoId, rendition, hdr, source)],
          grade: this.targets.grade(),
          remeasure,
          // The on-demand rendition has to agree with the ones built at import, so it
          // obeys the same settings. The fit is deterministic, so refitting here lands
          // on the same transform rather than a second opinion.
          matchEmbeddedJpeg: this.settings.get().match_embedded_jpeg,
          // And the same edits, for the same reason. This is the path a `max` export takes,
          // so without it the one rendition a reader asks for by name is the one that ignores
          // what they did to the picture.
          ...developed(edits?.doc ?? null),
          ...this.targets.render(),
        },
        skip,
      ),
      builtFrom: edits?.stamp ?? null,
    };
  }



  /**
   * Fits this photograph's lens and colour against the camera's own JPEG, and keeps the answer.
   *
   * **The fit is made inside the base a render builds**, so a library that serves the cameras'
   * pictures has never made one - and a panorama of those frames has no ratio table to reach
   * their sensors through, which is a doubled edge at every seam of the composite
   * (`composite_align::Aligned::lensless`).
   *
   * **No target, so no picture**: `Job::measure` runs the base and stops. It still pays the
   * decode, which is what the fit is measured over and most of what a render costs, but not the
   * cut, the lens gather, the grade, the encode or the file - and it writes nothing under this
   * photograph, where a rendition would have stamped a copy the library never asked for.
   *
   * The develop settings a photograph nobody has edited would render with, so the fit this keeps
   * is the one an ordinary render of it would have made rather than a second opinion.
   */
  async measureCameraMatch(
    rawFilePath: string,
    photoId: string,
    library: Library,
    /**
     * The worker to fit on, where the caller is holding one open.
     *
     * A merge is: the fit, the align, and a rendition - and each job that opens a device of its
     * own pays half a second compiling the shader modules before it starts (`openComposite`).
     * Absent, this takes a worker of its own, which is what a caller with only the one job wants.
     */
    on?: CompositeWorker,
  ): Promise<void> {
    const job: RenditionJob = {
      kind: 'rendition',
      photoId,
      rawFilePath,
      dataPath: getDataPath(library),
      targets: [],
      measure: true,
      grade: this.targets.grade(),
      matchEmbeddedJpeg: true,
      ...developed(null),
      ...this.targets.render(),
    };
    // Nothing to record either way: a job with no target writes no copy, and the analysis it
    // answers with is written by the worker that measured it.
    if (on != null) await on.run(job);
    else await this.runOneOff(job, null);
  }



  // One photo, on demand, outside the pending queue: a single explicit request
  // the user is waiting on, not background work to batch. Its own worker, so a
  // render that takes seconds cannot occupy a pool slot the rendition queue
  // needs.
  // `builtFrom` is read with the document the job renders, not after it: an edit
  // landing mid-render is one this render did not include, and recording the
  // settings as they stand at the end would retire the rebuild it is owed.
  async runOneOff(job: RenditionJob, builtFrom: string | null): Promise<void> {
    // A grid tile computes one whichever path built it, so the repair on a detail
    // read has to hand it over exactly as the queue does. Dropping it here left a
    // photo whose tile was rebuilt unable to stack, silently and for good: nothing
    // revisits a tile that is now on disk.
    let descriptor: Uint8Array | undefined;
    if (job.rendered == null) {
      descriptor = await this.runDetached(job);
    } else {
      const target = job.targets[0];
      if (target == null) throw new Error('a client rendition needs one target');
      const temporary = target.outputPath + '.' + newId() + '.tmp';
      try {
        descriptor = await this.runDetached({ ...job, targets: [{ ...target, outputPath: temporary }] });
        await rename(temporary, target.outputPath);
      } finally {
        await deleteGeneratedFile(job.dataPath, temporary).catch(() => undefined);
      }
    }
    // The HDR diagnostics write their own files under their own names and no
    // view reads them off a rendition URL, so only a rendition is worth saying.
    // Which stamps move follows which files were written. `renderOne` builds one
    // target today, so this is a list of one either way; it is written per target
    // because a one-off job is the only shape that *could* carry both - the queue
    // splits a photo into a tile job and a renditions job and this does not - and
    // asked as "are they all tiles", a grid-and-full job would read as renditions
    // alone and leave `tile_built_at` unset on a tile already on disk.
    //
    // **`max` moves the version and its own variant's stamp** (`markCopyBuilt`), where
    // `full` answers for the whole renditions stage. The version is what a client builds a
    // rendition URL from, and the page holds its decoded frames under those URLs
    // (`stage_bitmaps.ts`) rather than re-asking the server for them - so a rebuilt `max`
    // whose version stayed put is a picture that cannot be repainted by anything short of
    // a reload, whatever the response headers say.
    const wrote = (rendition: Rendition): RenditionTarget | undefined =>
      job.targets.find((t) => t.rendition === rendition);
    const version = new Date().toISOString();

    const tile = wrote('grid');
    if (tile != null) {
      this.photoProcessing.markTileBuilt(job.photoId, version, builtFrom, {
        from: tile.source,
        matched: job.matchEmbeddedJpeg,
      });
      this.announce(job.photoId, { stage: 'tile', version });
    }
    const full = wrote('full');
    const max = wrote('max');
    if (full != null || max != null) {
      if (full != null) {
        this.photoProcessing.markRenditionsBuilt(job.photoId, version, 'render', builtFrom, renditionVariant('full', full.hdr));
      } else if (max != null) {
        this.photoProcessing.markCopyBuilt(job.photoId, version, builtFrom, renditionVariant('max', max.hdr));
      }
      this.announce(job.photoId, { stage: 'renditions', version });
    }
    // After the writes, and best-effort, for the reasons `stageDone` gives.
    if (descriptor != null) this.describe(job.photoId, descriptor);
  }



  /**
   * One job on a worker of its own, with nothing recorded about it afterwards.
   *
   * For a render whose file is not one of the photograph's copies: no stamp moves, no version
   * is bumped and no listener hears about the descriptor, because none of those describe what
   * is now on disk under this photo.
   */
  async runDetached(job: RenditionJob): Promise<Uint8Array | undefined> {
    const worker = new Worker(workerEntry('processing_worker', new URL('../workers/processing_worker.ts', import.meta.url)));
    try {
      return await new Promise<Uint8Array | undefined>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<ProcessingResult>) => {
          if (event.data.success) resolve(event.data.descriptor);
          else reject(new Error(event.data.error));
        };
        worker.onerror = (event: ErrorEvent) => reject(new Error(`worker crashed: ${event.message}`));
        // Moved rather than copied: a client's `max` is hundreds of megabytes.
        worker.postMessage(job, job.kind === 'rendition' && job.rendered != null ? [job.rendered.buffer] : []);
      });
    } finally {
      worker.terminate();
    }
  }
}
