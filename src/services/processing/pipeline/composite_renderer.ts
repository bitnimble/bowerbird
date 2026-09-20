import { AppError } from '../../../errors';
import type { AssemblyRecipe } from '../../../schemas/assembly';
import type { Library } from '../../../schemas/libraries';
import { getDataPath } from '../../../utils/paths';
import { hasEmbeddedJpeg } from '../../../utils/scan';
import type { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import { renditionVariant, type Rendition } from '../renditions/renditions';
import { openCompositeWorker, type CompositeWorker } from '../workers/composite_worker';
import type { CompositeJob, CompositeJobSource, RenditionSource, RenditionWritten } from '../workers/processing_types';
import { developed } from './developed';
import type { RenderTargets } from './render_targets';

export class CompositeRenderer {
  private seaming: CompositeWorker | null = null;

  constructor(
    private readonly photoProcessing: PhotoProcessingRepository,
    private readonly editsFor: (photoId: string) => { doc: string; stamp: string | null } | null,
    private readonly compositeOf: (
      photoId: string,
    ) => { kind: 'panorama' | 'assembly'; recipe: unknown; sources: CompositeJobSource[] } | null,
    private readonly targets: RenderTargets,
    private readonly announce: (photoId: string, written: RenditionWritten) => void,
  ) {}



  /**
   * A panorama's sources, searched for the recipe that composites them.
   *
   * Off the pool for `runOneOff`'s reason and one more: an alignment is seconds of device work on
   * N previews, and somebody is waiting to see what they merged into. `on` is the merge's own
   * worker, which the renditions after this one go to as well.
   *
   * Keyed by the library rather than a photograph, there being no row yet: what this answers is
   * what to write on one.
   */
  async alignComposite(
    libraryId: string,
    sources: CompositeJobSource[],
    library: Library,
    on: CompositeWorker,
  ): Promise<string> {
    const recipe = await on.run({
      kind: 'composite',
      want: 'align',
      photoId: libraryId,
      sources,
      dataPath: getDataPath(library),
      reportProgress: true,
      targets: [],
      grade: this.targets.grade(),
      ...developed(null),
      ...this.targets.render(),
    });
    if (recipe == null) throw new AppError('VALIDATION_ERROR', 'these photographs did not align');
    return recipe;
  }



  /**
   * A set of frames, searched for the tiles an assembly would carve them into (§3).
   *
   * `alignComposite`'s sibling and on the same worker, for its reasons: it is seconds of device
   * work, somebody is waiting to see what they asked for, and there is no row to key it by yet.
   */
  async analyseAssembly(
    libraryId: string,
    sources: CompositeJobSource[],
    library: Library,
    on: CompositeWorker,
    volumePath: string,
  ): Promise<string> {
    const analysed = await on.run({
      kind: 'composite',
      want: 'analyse',
      photoId: libraryId,
      sources,
      volumePath,
      dataPath: getDataPath(library),
      // Also what lets a carve start after a cancelled one: only a counting job clears the cancel.
      reportProgress: true,
      targets: [],
      grade: this.targets.grade(),
      ...developed(null),
      ...this.targets.render(),
    });
    // A native refusal already arrives as a rejection carrying its own reason; this is the belt
    // for a worker that somehow answered with nothing at all.
    if (analysed == null) throw new AppError('VALIDATION_ERROR', 'this burst could not be carved into tiles');
    return analysed;
  }



  /**
   * An assembly's seams for each of `picks` in place of the recipe's own, over the volume its carve
   * wrote: a JSON array of `assembly_seams::Seams`, `null` where that set's solve was refused.
   *
   * On a worker of its own, kept open: a reader is waiting on it after every pick, and it never
   * touches the device the carve and the renders queue for.
   */
  async solveSeams(recipe: AssemblyRecipe, picks: number[][], volumePath: string, library: Library): Promise<string> {
    if (this.seaming?.crashed() === true) {
      this.seaming.close();
      this.seaming = null;
    }
    this.seaming ??= this.openComposite();
    const solved = await this.seaming.run({
      kind: 'composite',
      want: 'seams',
      photoId: '',
      sources: [],
      recipe,
      volumePath,
      picks,
      dataPath: getDataPath(library),
      targets: [],
      grade: this.targets.grade(),
      ...developed(null),
      ...this.targets.render(),
    });
    if (solved == null) throw new AppError('VALIDATION_ERROR', 'the seams could not be solved');
    return solved;
  }



  /**
   * One source's own picture of an assembly's canvas (§4.3), written where a draft's layers live.
   *
   * **The recipe untiled, based on that one frame**, which is a render like any other: the
   * geometry, the coding and the gather are the ones the finished picture takes its parts from, so
   * a layer and the finished picture cannot disagree about where a pixel is or how bright it is.
   * The set is still every frame the recipe names, because the white the canvas is coded against is
   * the set's (`whole_levels`) - a layer coded against its own frame would be a different exposure
   * from the layer beside it, which is exactly what the page composites them to compare.
   *
   * No document, so the canvas is the recipe's own rather than the framing's: the page rasterises
   * its tiles in canvas pixels, and §3.0's planes take no grade either way.
   */
  async buildAssemblyLayer(
    sources: CompositeJobSource[],
    recipe: AssemblyRecipe,
    at: number,
    library: Library,
    outputPath: string,
    on: CompositeWorker,
  ): Promise<void> {
    const dataPath = getDataPath(library);
    await on.run({
      kind: 'composite',
      want: 'render',
      // No row to key it by, as a prepare of a draft has none.
      photoId: '',
      sources,
      recipe: { ...recipe, kind: 'assembly', vertices: [], tiles: [], pick: [], base: at, seams: undefined },
      dataPath,
      targets: [
        { ...this.targets.composedTarget(dataPath, '', recipe, 'assembly', 'full', library.rendition_hdr, 'render'), outputPath },
      ],
      grade: this.targets.grade(),
      ...developed(null),
      ...this.targets.render(),
    });
  }



  /**
   * §4.2's settled preview: the picture this recipe composes, at the layers' own size.
   *
   * The render the page is promising, through the render every rendition takes - so what a reader
   * looks at while they choose and what Save writes differ in size and in nothing else.
   */
  async buildAssemblyPreview(
    sources: CompositeJobSource[],
    recipe: AssemblyRecipe,
    library: Library,
    outputPath: string,
    on: CompositeWorker,
  ): Promise<void> {
    const dataPath = getDataPath(library);
    await on.run({
      kind: 'composite',
      want: 'render',
      // No row to key it by, as a draft has none.
      photoId: '',
      sources,
      recipe: { ...recipe, kind: 'assembly' },
      dataPath,
      targets: [
        { ...this.targets.composedTarget(dataPath, '', recipe, 'assembly', 'full', library.rendition_hdr, 'render'), outputPath },
      ],
      grade: this.targets.grade(),
      ...developed(null),
      ...this.targets.render(),
    });
  }



  /**
   * A composite's rendition, built now because somebody asked for it by name.
   *
   * Neither `max` nor `embedded` is ever queued - a four-hundred-megapixel canvas at every merge
   * is minutes nobody asked for - so this is the only way one is ever made, and without it a
   * reader who zooms a panorama to full resolution is told nothing on this device can build it
   * while the frames sit right there. Answers false for a row that is not a composite, so the
   * caller can go on to its file.
   */
  async buildComposite(photoId: string, library: Library, rendition: Rendition, hdr: boolean): Promise<boolean> {
    const composite = this.compositeOf(photoId);
    if (composite == null) return false;
    const from = composite.sources.every((source) => hasEmbeddedJpeg(source.rawFilePath)) ? 'embedded' : 'render';
    // The tile may come from the cameras' own JPEGs, and the camera view is nothing but that
    // request at the viewer's size; anything else the reader asks for by name comes off the RAWs,
    // which is the whole reason they asked for it.
    const source = rendition === 'grid' || rendition === 'embedded' ? from : 'render';
    // Before the build, so a change landing during it is still owed one.
    const builtFrom = this.photoProcessing.builtFromOf(photoId);
    const on = this.openComposite();
    try {
      await this.buildCompositeRendition(photoId, composite.sources, composite.recipe, composite.kind, library, rendition, hdr, source, on);
    } finally {
      on.close();
    }
    // Recorded like any other copy, and for two reasons a canvas makes sharper than a photograph
    // does. Nothing else writes this row, so without it `stale` reads the copy as older than the
    // framing every merge writes and recomposites the canvas on every request; and the URL a
    // client asks for is versioned by the stamp this moves, so a picture built under a URL that
    // 404d is one nothing ever asks for again (`renditionVersion`).
    const version = new Date().toISOString();
    this.photoProcessing.markCopyBuilt(
      photoId,
      version,
      builtFrom,
      renditionVariant(rendition, hdr),
      { from: source, matched: false },
    );
    this.announce(photoId, { stage: rendition === 'grid' ? 'tile' : 'renditions', version });
    return true;
  }



  /**
   * One of a panorama's renditions, composited from its frames and filed under the panorama.
   *
   * The same settings a photograph's rendition is built with - and the same *paths*, a panorama
   * being a photograph: what comes out of the composite is a frame and everything after that is
   * the pipeline every rendition goes through.
   */
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
    const dataPath = getDataPath(library);
    await on.run({
      kind: 'composite',
      want: 'render',
      photoId,
      sources,
      recipe,
      dataPath,
      reportProgress: watched,
      targets: [this.targets.composedTarget(dataPath, photoId, recipe, kind, rendition, hdr, source)],
      grade: this.targets.grade(),
      // The composite's own document, which the merge wrote the align's framing into: a panorama
      // is a photograph, so what frames it is the field that frames every other one.
      ...developed(this.editsFor(photoId)?.doc ?? null),
      ...this.targets.render(),
    });
  }



  /**
   * A worker to run a panorama's jobs on, held open until the caller closes it.
   *
   * **Every job pays for the device before it does anything.** Acquiring an adapter, creating the
   * device and compiling the shader modules is ~530ms on the machine this was measured on, and a
   * merge is three jobs - the align, then a rendition each for the tile and the picture - so a
   * worker apiece spent a second and a half of a four-second merge getting ready, twice over for
   * nothing. Held open, the second and third jobs start on a device that is already there.
   *
   * Still one job at a time: the far side is one `onmessage` and one result, and the device it is
   * holding is the machine's.
   */
  openComposite(): CompositeWorker {
    return openCompositeWorker();
  }



  /** One panorama job on a worker of its own, for a caller with only the one. */
  async runComposite(job: CompositeJob): Promise<string | undefined> {
    const on = this.openComposite();
    try {
      return await on.run(job);
    } finally {
      on.close();
    }
  }
}
