import { rename } from 'node:fs/promises';
import type { ProcessingStage } from '../../../schemas/common';
import type { AssemblyRecipe } from '../../../schemas/assembly';
import type { ExportOptions } from '../../../schemas/export';
import type { Job } from '../../../schemas/jobs';
import type { Library } from '../../../schemas/libraries';
import type { PrepareDevelop } from '../../../schemas/prepare_develop';
import { renditionPathFor, stagedDescriptorPath } from '../../../utils/paths';
import type { PhotoListingRepository } from '../../photos/listing/photo_listing_repository';
import type { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import type { SettingsRepository } from '../../settings/settings_repository';
import { encoderQuality } from '../analysis/quality';
import type { TileEncoding } from '../analysis/metadata';
import type { Rendition } from '../renditions/renditions';
import type { CompositeWorker } from '../workers/composite_worker';
import type { Missing, Shown } from '../workers/prepare_pool';
import type {
  CompositeJob,
  CompositeJobSource,
  RenditionJob,
  RenditionSource,
  RenditionWritten,
} from '../workers/processing_types';
import type { RenderTiming, RenderedRendition } from '../../../schemas/render_stages';
import type { RenderTimingsFile } from '../renditions/render_timings_file';
import { RenderTargets } from './render_targets';
import { RenderBenchmark } from './render_benchmark';
import { CompositeRenderer } from './composite_renderer';
import { PrepareRenderer } from './prepare_renderer';
import { SinglePhotoRenderer } from './single_photo_renderer';
import { ExportRenderer } from './export_renderer';

export abstract class RenderService {
  protected readonly targets: RenderTargets;
  private readonly composites: CompositeRenderer;
  private readonly prepareRenderer: PrepareRenderer;
  private readonly singlePhoto: SinglePhotoRenderer;
  private readonly exports: ExportRenderer;
  private readonly benchmark: RenderBenchmark;
  private readonly processed = new Set<(photoId: string, written: RenditionWritten) => void>();
  protected readonly described = new Set<(photoId: string, descriptor: Uint8Array) => void>();

  constructor(
    protected readonly photoProcessing: PhotoProcessingRepository,
    photoPaths: PhotoPathsRepository,
    photoListing: PhotoListingRepository,
    protected readonly settings: SettingsRepository,
    protected readonly editsFor: (photoId: string) => { doc: string; stamp: string | null } | null,
    protected readonly libraryOf: (libraryId: string) => Library | null,
    protected readonly compositeOf: (
      photoId: string,
    ) => { kind: 'panorama' | 'assembly'; recipe: unknown; sources: CompositeJobSource[] } | null,
  ) {
    this.targets = new RenderTargets(settings);
    this.composites = new CompositeRenderer(photoProcessing, editsFor, compositeOf, this.targets, (photoId, written) =>
      this.announce(photoId, written),
    );
    this.prepareRenderer = new PrepareRenderer(photoPaths, photoListing, settings, editsFor, libraryOf, compositeOf, this.targets);
    this.singlePhoto = new SinglePhotoRenderer(
      photoProcessing,
      settings,
      editsFor,
      this.targets,
      (photoId, written) => this.announce(photoId, written),
      (photoId, descriptor) => {
        for (const listener of this.described) listener(photoId, descriptor);
      },
    );
    this.exports = new ExportRenderer(settings, editsFor, this.targets, this.singlePhoto, this.composites);
    this.benchmark = new RenderBenchmark(photoPaths, libraryOf, this.singlePhoto);
  }

  /** What a render's stages cost on this machine, measured now and filed in `into`. */
  async benchmarkRender(rendition: RenderedRendition, into: RenderTimingsFile): Promise<RenderTiming> {
    return this.benchmark.run(rendition, into);
  }

  protected abstract stageDone(
    photo: null,
    photoId: string,
    stage: ProcessingStage,
    descriptor?: Uint8Array,
  ): void;


  /**
   * How a grid tile is encoded, for the scan to build one while it holds the RAW open (§10.4).
   *
   * The same two settings `target` reads, so a tile built by the scan and one built here are
   * the same picture. The scan's own encoder settings are not a thing that exists.
   */
  tileEncoding(): TileEncoding {
    const settings = this.settings.get();
    return {
      size: settings.grid_rendition_size,
      quantizer: encoderQuality('avif-sdr', settings.grid_rendition_quality),
    };
  }


  /**
   * Takes on a grid tile the scan built, now that the photo it belongs to has an id (§10.4).
   *
   * A rename inside `grid/`, which is atomic and cannot cross a filesystem, and then exactly
   * the bookkeeping the tile pass does when it builds one: the flag, the stamp the client
   * versions its URL off, and the stacking descriptor. So a tile whose pixels came from the
   * scan is indistinguishable from one the rendition pass built.
   *
   * False where there was nothing to take on - a body that embeds no JPEG, a scan that failed,
   * a run that died before it got here - and the photo then keeps `needs_tile`, so the
   * rendition pass builds it the way it always did.
   */
  async adoptScannedTile(photoId: string, dataPath: string, staged: string): Promise<boolean> {
    const descriptorPath = stagedDescriptorPath(staged);
    try {
      // Read before the rename, because the descriptor is only meaningful while it still
      // describes a file that is there to be adopted.
      const descriptor = await Bun.file(descriptorPath).bytes().catch(() => undefined);
      await rename(staged, renditionPathFor(dataPath, photoId, 'grid', false));
      await Bun.file(descriptorPath).delete().catch(() => {});
      this.stageDone(null, photoId, 'tile', descriptor);
      return true;
    } catch {
      // Both halves, or the sweep would carry a descriptor for a tile that never landed.
      await Bun.file(staged).delete().catch(() => {});
      await Bun.file(descriptorPath).delete().catch(() => {});
      return false;
    }
  }


  /** Drops a scanned tile no photo took on: the file turned out to be a move, or the run stopped. */
  async discardScannedTile(staged: string): Promise<void> {
    await Bun.file(staged).delete().catch(() => {});
    await Bun.file(stagedDescriptorPath(staged)).delete().catch(() => {});
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
  ): Promise<string> {
    return this.composites.alignComposite(libraryId, sources, library, on);
  }

  async analyseAssembly(
    libraryId: string,
    sources: CompositeJobSource[],
    library: Library,
    on: CompositeWorker,
    volumePath: string,
  ): Promise<string> {
    return this.composites.analyseAssembly(libraryId, sources, library, on, volumePath);
  }

  async solveSeams(recipe: AssemblyRecipe, picks: number[][], volumePath: string, library: Library): Promise<string> {
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

  async buildComposite(photoId: string, library: Library, rendition: Rendition, hdr: boolean): Promise<boolean> {
    return this.composites.buildComposite(photoId, library, rendition, hdr);
  }

  async buildCompositeRendition(
    photoId: string,
    sources: CompositeJobSource[],
    recipe: unknown,
    kind: 'panorama' | 'assembly',
    library: Library,
    rendition: Rendition,
    hdr: boolean,
    source: RenditionSource,
    on: CompositeWorker,
    /** Whether a merge is watching this render's progress. */
    watched = false,
  ): Promise<void> {
    return this.composites.buildCompositeRendition(photoId, sources, recipe, kind, library, rendition, hdr, source, on, watched);
  }

  openComposite(): CompositeWorker {
    return this.composites.openComposite();
  }

  private async runComposite(job: CompositeJob): Promise<string | undefined> {
    return this.composites.runComposite(job);
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
    return this.singlePhoto.renderOne(rawFilePath, photoId, library, rendition, hdr, source, remeasure);
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
    return this.singlePhoto.keepRendered(photoId, library, rendition, hdr, builtFrom, rendered);
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

  private async runOneOff(job: RenditionJob, builtFrom: string | null): Promise<void> {
    return this.singlePhoto.runOneOff(job, builtFrom);
  }

  private async runDetached(job: RenditionJob): Promise<Uint8Array | undefined> {
    return this.singlePhoto.runDetached(job);
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
  ): Promise<void> {
    return this.exports.renderExport(rawFilePath, photoId, library, outputPath, options, thumbnailPath);
  }

  async renderSdrRoll(rendered: string, photoId: string, scratch: string, outputPath: string, quality: number): Promise<void> {
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
  ): Promise<void> {
    return this.exports.renderCompositeExport(photoId, sources, recipe, library, outputPath, options, thumbnailPath);
  }

}
