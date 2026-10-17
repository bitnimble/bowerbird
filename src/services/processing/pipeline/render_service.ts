import type { AssemblyRecipe } from '../../../schemas/assembly';
import type { ExportOptions } from '../../../schemas/export';
import type { Job } from '../../../schemas/jobs';
import type { LibraryConfiguration as Library } from '../../../schemas/libraries';
import type { AlignShape } from '../../../schemas/jobs';
import type { CompositeKind } from '../../../schemas/photos';
import type { CameraTone, Denoiser } from '../../../schemas/photo_edits';
import type { HeaderMetadata } from '../analysis/metadata';
import type { PrepareDevelop } from '../../../schemas/prepare_develop';
import type { PhotoListingRepository } from '../../photos/listing/photo_listing_repository';
import type { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import type { SettingsRepository } from '../../settings/settings_repository';
import type { Rendition } from '../renditions/renditions';
import { renditionSkips } from '../renditions/render_stages';
import type { CompositeWorker } from '../workers/composite_worker';
import type { Missing, Shown } from '../workers/prepare_pool';
import { RenderBudget } from '../workers/render_budget';
import type {
  CompositeJobSource,
  RenditionSource,
  RenditionWritten,
} from '../workers/processing_types';
import {
  cameraMatchWithStages,
  type CameraMatch,
  type RenderTiming,
  type RenderedRendition,
} from '../../../schemas/render_stages';
import type { RenderTimingsFile } from '../renditions/render_timings_file';
import { RenderTargets } from './render_targets';
import { RenderBenchmark } from './render_benchmark';
import { CompositeRenderer } from './composite_renderer';
import { PrepareRenderer } from './prepare_renderer';
import { SinglePhotoRenderer } from './single_photo_renderer';
import { ExportRenderer } from './export_renderer';
import { LibraryActivity } from '../../activity/library_activity';

export abstract class RenderService {
  protected readonly targets: RenderTargets;
  private readonly composites: CompositeRenderer;
  private readonly prepareRenderer: PrepareRenderer;
  private readonly singlePhoto: SinglePhotoRenderer;
  protected readonly renderBudget = RenderBudget.forThisMachine();
  private readonly exports: ExportRenderer;
  private readonly benchmark: RenderBenchmark;
  private readonly processed = new Set<(photoId: string, written: RenditionWritten) => void>();
  protected readonly described = new Set<(photoId: string, descriptor: Uint8Array) => void>();
  private readonly cameraMatched = new Set<(photoId: string, tone: CameraTone) => void>();
  private readonly headerRead = new Set<(photoId: string, header: HeaderMetadata) => void>();

  constructor(
    protected readonly photoProcessing: PhotoProcessingRepository,
    photoPaths: PhotoPathsRepository,
    photoListing: PhotoListingRepository,
    protected readonly settings: SettingsRepository,
    protected readonly editsFor: (photoId: string) => { doc: string; stamp: string | null } | null,
    protected readonly libraryOf: (libraryId: string) => Library | null,
    protected readonly compositeOf: (
      photoId: string,
    ) => { kind: CompositeKind; recipe: unknown; sources: CompositeJobSource[] } | null,
    protected readonly activity: LibraryActivity = new LibraryActivity(),
  ) {
    this.targets = new RenderTargets(settings);
    this.composites = new CompositeRenderer(
      photoProcessing,
      editsFor,
      compositeOf,
      this.targets,
      settings,
      (photoId, written) => this.announce(photoId, written),
      (photoId, tone) => this.matchedCamera(photoId, tone),
    );
    this.prepareRenderer = new PrepareRenderer(
      photoPaths,
      photoListing,
      settings,
      editsFor,
      libraryOf,
      compositeOf,
      this.targets,
      activity,
    );
    this.singlePhoto = new SinglePhotoRenderer(
      photoProcessing,
      settings,
      editsFor,
      this.targets,
      (photoId, written) => this.announce(photoId, written),
      (photoId, descriptor) => {
        for (const listener of this.described) listener(photoId, descriptor);
      },
      (photoId, tone) => this.matchedCamera(photoId, tone),
      (photoId, header) => this.readHeader(photoId, header),
      this.renderBudget,
    );
    this.exports = new ExportRenderer(
      settings,
      editsFor,
      this.targets,
      this.singlePhoto,
      this.composites,
    );
    this.benchmark = new RenderBenchmark(this.singlePhoto);
  }

  /** What a render's stages cost on this machine, measured now and filed in `into`. */
  async benchmarkRender(
    rendition: RenderedRendition,
    denoiser: Denoiser,
    into: RenderTimingsFile,
  ): Promise<RenderTiming> {
    return this.activity.track(null, 'measuring', `${rendition}:${denoiser}`, () =>
      this.benchmark.run(rendition, denoiser, into),
    );
  }

  cameraMatchFor(library: Library, rendition: Rendition): CameraMatch {
    const base = this.settings.get().match_embedded_jpeg ? 'lensAndColour' : 'none';
    return cameraMatchWithStages(base, renditionSkips(library, rendition));
  }

  /** Called with the header a grid tile job read off its own open. */
  onHeaderRead(listener: (photoId: string, header: HeaderMetadata) => void): void {
    this.headerRead.add(listener);
  }

  protected readHeader(photoId: string, header: HeaderMetadata): void {
    for (const listener of this.headerRead) listener(photoId, header);
  }

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

  /** Called with the camera match a render of a photograph graded under. */
  onCameraMatched(listener: (photoId: string, tone: CameraTone) => void): void {
    this.cameraMatched.add(listener);
  }

  /** After the copies graded under `tone` are recorded, which is what lets a listener vouch for them. */
  matchedCamera(photoId: string, tone: CameraTone): void {
    for (const listener of this.cameraMatched) listener(photoId, tone);
  }

  // Announced from the two places that write a rendition - the queue's result
  // handler and the one-off run - rather than from the queue alone: an on-demand
  // build is a file changing behind a URL exactly as much as a queued one is, and
  // the grid tile repaired on a detail read (§18.6) has no other way to be told.
  protected announce(photoId: string, written: RenditionWritten): void {
    for (const listener of this.processed) listener(photoId, written);
  }
  async alignComposite(
    libraryId: string,
    sources: CompositeJobSource[],
    library: Library,
    on: CompositeWorker,
    shape: AlignShape,
    progressId: number,
  ): Promise<string> {
    return this.composites.alignComposite(libraryId, sources, library, on, shape, progressId);
  }

  async analyseAssembly(
    libraryId: string,
    sources: CompositeJobSource[],
    library: Library,
    on: CompositeWorker,
    volumePath: string,
    progressId: number,
  ): Promise<string> {
    return this.composites.analyseAssembly(libraryId, sources, library, on, volumePath, progressId);
  }

  async solveSeams(
    recipe: AssemblyRecipe,
    picks: number[][],
    volumePath: string,
    library: Library,
  ): Promise<string> {
    return this.composites.solveSeams(recipe, picks, volumePath, library);
  }

  async buildAssemblyLayer(
    sources: CompositeJobSource[],
    recipe: AssemblyRecipe,
    at: number,
    library: Library,
    outputPath: string,
    on: CompositeWorker,
  ): Promise<void> {
    return this.composites.buildAssemblyLayer(sources, recipe, at, library, outputPath, on);
  }

  async buildAssemblyPreview(
    sources: CompositeJobSource[],
    recipe: AssemblyRecipe,
    library: Library,
    outputPath: string,
    on: CompositeWorker,
  ): Promise<void> {
    return this.composites.buildAssemblyPreview(sources, recipe, library, outputPath, on);
  }

  async buildComposite(
    photoId: string,
    library: Library,
    rendition: Rendition,
    hdr: boolean,
  ): Promise<boolean> {
    return this.activity.track(library.id, 'rendering', photoId, () =>
      this.composites.buildComposite(photoId, library, rendition, hdr),
    );
  }

  async buildCompositeRendition(
    photoId: string,
    sources: CompositeJobSource[],
    recipe: unknown,
    kind: CompositeKind,
    library: Library,
    rendition: Rendition,
    hdr: boolean,
    source: RenditionSource,
    on: CompositeWorker,
    /** Where a merge watching this render reads its progress. */
    progressId?: number,
  ): Promise<CameraTone | undefined> {
    return this.composites.buildCompositeRendition(
      photoId,
      sources,
      recipe,
      kind,
      library,
      rendition,
      hdr,
      source,
      on,
      progressId,
    );
  }

  openComposite(): CompositeWorker {
    return this.composites.openComposite();
  }

  async preparePicture(
    photoId: string,
    shown?: Shown,
    missing?: Missing,
    develop?: PrepareDevelop,
  ): Promise<Uint8Array> {
    return this.prepareRenderer.preparePicture(photoId, shown, missing, develop);
  }

  async renderOne(
    rawFilePath: string,
    photoId: string,
    library: Library,
    rendition: Rendition,
    hdr: boolean,
    source: RenditionSource = 'render',
    remeasure = false,
  ): Promise<void> {
    return this.activity.track(library.id, 'rendering', photoId, () =>
      this.singlePhoto.renderOne(rawFilePath, photoId, library, rendition, hdr, source, remeasure),
    );
  }

  renditionCommand(
    photoId: string,
    library: Library,
    rendition: Rendition,
    hdr: boolean,
    remeasure: boolean,
  ): { command: Job; builtFrom: string | null } {
    return this.singlePhoto.renditionCommand(photoId, library, rendition, hdr, remeasure);
  }

  async keepRendered(
    photoId: string,
    library: Library,
    rendition: Rendition,
    hdr: boolean,
    builtFrom: string | null,
    rendered: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    return this.activity.track(library.id, 'rendering', photoId, () =>
      this.singlePhoto.keepRendered(photoId, library, rendition, hdr, builtFrom, rendered),
    );
  }

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
    return this.singlePhoto.measureCameraMatch(rawFilePath, photoId, library, on);
  }

  async renderExport(
    rawFilePath: string,
    photoId: string,
    library: Library,
    outputPath: string,
    options: ExportOptions,
    /**
     * A second size off the same decode, for the history's tile (§10.5.2).
     *
     * A target rather than a downscale of the finished export: an HDR export is a PQ frame,
     * and reading one back as if it were sRGB is a flat, dark picture. The renderer already
     * writes several sizes from one decode - it is how the grid tile and the full rendition
     * are built together - so this costs a dispatch and a small encode, not a second decode.
     */
    thumbnailPath?: string,
    /** Where the export dialog watching this render reads its progress. */
    progressId?: number,
  ): Promise<void> {
    return this.exports.renderExport(
      rawFilePath,
      photoId,
      library,
      outputPath,
      options,
      thumbnailPath,
      progressId,
    );
  }

  async renderSdrRoll(
    rendered: string,
    photoId: string,
    scratch: string,
    outputPath: string,
    quality: number,
  ): Promise<void> {
    return this.exports.renderSdrRoll(rendered, photoId, scratch, outputPath, quality);
  }

  async renderCompositeExport(
    photoId: string,
    sources: CompositeJobSource[],
    recipe: unknown,
    library: Library,
    outputPath: string,
    options: ExportOptions,
    /** A second size off the same composite, for the history's tile - `renderExport`'s reason. */
    thumbnailPath?: string,
    /** `renderExport`'s. */
    progressId?: number,
  ): Promise<void> {
    return this.exports.renderCompositeExport(
      photoId,
      sources,
      recipe,
      library,
      outputPath,
      options,
      thumbnailPath,
      progressId,
    );
  }
}
