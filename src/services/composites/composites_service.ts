import { createHash } from 'node:crypto';
import { z } from 'zod';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import { newId } from '../../schemas/id';
import type { Library } from '../../schemas/libraries';
import {
  AnalysedSchema,
  MOST_SOURCES,
  SolvedSeamsSchema,
  type AssemblyJob,
  type AssemblyRecipe,
  type Carved,
  type ReopenedAssembly,
  type Seams,
} from '../../schemas/assembly';
import type { CompositePhase, CompositePhoto, CompositeProgress, Composition } from '../../schemas/composition';
import { AlignedSchema, framingEdits, isComposite, type Aligned, type Composed } from '../../schemas/recipes';
import { existsSync } from 'node:fs';
import { deleteGeneratedFile } from '../../utils/deletions';
import {
  draftLayerPath,
  draftPreviewPath,
  draftVolumePath,
  getDataPath,
  originalPathOf,
  renditionPathFor,
} from '../../utils/paths';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import { deleteGeneratedFilesFor } from '../maintenance/prune_service';
import type { Originals } from '../blobs/originals';
import type { PhotoEditsRepository } from '../photo_edits/photo_edits_repository';
import type { PhotoCompositesRepository } from '../photos/composites/photo_composites_repository';
import type { PhotoMetadataRepository } from '../photos/metadata/photo_metadata_repository';
import type { BasicPhoto, PhotoPathsRepository } from '../photos/paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../photos/renditions/photo_processing_repository';
import type { ProcessingService } from '../processing/pipeline/processing_service';
import type { CompositeWorker } from '../processing/workers/composite_worker';
import { cancelJob, JOB_CANCELLED, watchingJobProgress } from '../processing/rawshim/rawshim_job';
import type { CompositeJobSource } from '../processing/workers/processing_types';
import { owedOf, renditionVariant } from '../processing/renditions/renditions';
import type { RenditionsRepository } from '../processing/renditions/renditions_repository';

const log = new Logger('panoramas');

/**
 * What a reader is told is happening, and how much of the wait each part is.
 *
 * The three are nothing like each other: the align runs over the cameras' own previews, the tile
 * composites a canvas a few thousand pixels wide, and the picture composites the same canvas at
 * sixteen thousand out of the RAWs themselves. So the shares are weighted rather than equal, or
 * the bar would sit at two thirds for the whole of the part that actually takes the time.
 */
const PHASES = [
  { phase: 'aligning', share: 0.15 },
  { phase: 'tile', share: 0.15 },
  { phase: 'picture', share: 0.7 },
] as const satisfies readonly { phase: CompositePhase; share: number }[];

/**
 * §4.4's layer key, which names the layer *files*.
 *
 * Everything the pixels are a function of and nothing else: the library's rendition setting and
 * the geometry every layer is drawn in. A layer is one frame over the whole canvas, so the tiles
 * are not in it, and neither is a frame's edit, §3.0's planes taking no grade.
 */
export function layerKeyOf(library: Library, recipe: AssemblyRecipe): string {
  const of = {
    source: library.rendition_source,
    hdr: library.rendition_hdr,
    sources: recipe.sources,
    projection: recipe.projection,
    canvas: recipe.canvas,
    centre: recipe.centre,
    radiansPerPixel: recipe.radiansPerPixel,
  };
  return createHash('sha256').update(JSON.stringify(of)).digest('hex').slice(0, 32);
}

/** Where the page fetches a draft's layers from, which is `AssembliesApi.imageRoutes`. */
function layerUrlOf(libraryId: string, layerKey: string, at: number): string {
  return `/image/drafts/${libraryId}/${layerKey}/${at}`;
}

/**
 * What a preview's *picture* is a function of, beyond the layer key its geometry already names:
 * which frame each tile takes, where the seams put them, and how far the render feathers.
 */
function pictureKeyOf(recipe: AssemblyRecipe): string {
  const of = { pick: recipe.pick, base: recipe.base, feather: recipe.feather, seams: recipe.seams };
  return createHash('sha256').update(JSON.stringify(of)).digest('hex').slice(0, 32);
}

/** Where the page fetches one of those previews from. */
function previewUrlOf(libraryId: string, layerKey: string, picture: string): string {
  return `/image/drafts/${libraryId}/${layerKey}/preview-${picture}`;
}

/** How much of a carve's bar is left once the carve has answered: the layers, a render a frame. */
const LAYERS_SHARE = 0.15;

/** Finished carves held for their pages; the oldest finished one goes past this. */
const KEPT_ASSEMBLY_JOBS = 16;

/** A carve's answer where a lens it reaches through has never been measured. */
const LenslessSchema = z.object({ lensless: z.array(z.string()) });

/**
 * Merging a selection into a panorama, and keeping the photograph that comes out rendered.
 *
 * **A panorama is a photograph.** The merge aligns the frames and writes a row whose recipe
 * composes them, and from that moment it is a photograph like any other: it is one row in the
 * listing, its copies are keyed by its own id, the viewer opens it, the bin takes it, replication
 * carries it. Nothing about it is a stack - the frames may be stacked or loose or a mixture, and
 * stacking them differently afterwards does not touch the recipe (§19.4).
 */
export class CompositesService {
  private readonly progress = new Set<(progress: CompositeProgress) => void>();
  private readonly assemblyJobs = new Map<string, AssemblyJob>();
  private readonly cancelledJobs = new Set<string>();
  /** The job whose carve is inside a native call right now, which is the only one a signal reaches. */
  private analysing: string | null = null;
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly photoComposites: PhotoCompositesRepository,
    private readonly photoPaths: PhotoPathsRepository,
    private readonly photoMetadata: PhotoMetadataRepository,
    private readonly photoProcessing: PhotoProcessingRepository,
    private readonly libraries: LibrariesRepository,
    private readonly renditions: RenditionsRepository,
    private readonly processing: ProcessingService,
    /** Where the framing the align found is written, the composite being a photograph like any other. */
    private readonly edits: PhotoEditsRepository,
    /** The way to a frame's bytes, which may be on a backup rather than on this disk (§14.4). */
    private readonly originals: Originals,
  ) {}

  /**
   * Every frame on this disk before anything opens one.
   *
   * A frame this device has given back to a backup (§14.5) has a path that resolves and no file
   * behind it, which reaches a decoder as a failure rather than as a wait. Asked once, at the top
   * of each flow that is about to read them, rather than per decode: a merge opens every frame
   * several times over, and `open` on a file that is here is a stat.
   */
  private async bringFrames(photoIds: readonly string[], library: Library): Promise<void> {
    for (const photoId of photoIds) {
      const frame = this.photoPaths.getBasicById(photoId);
      if (frame != null) await this.originals.open(library, frame);
    }
  }

  /**
   * A selection into a panorama: align it, write the photograph, build what it owes.
   *
   * The renditions are built before this answers rather than queued behind it, because what the
   * client does next is show the new row and a tile that is not there is a hole in the grid. It is
   * one composite of two sizes, not a library's worth of work.
   */
  mergePanorama(photoIds: readonly string[]): Promise<CompositePhoto> {
    return this.serially(() => this.mergeNow(photoIds));
  }

  /**
   * `work` once everything queued before it has settled. One at a time: two composites would hold
   * the device against each other for minutes, and there is one counter behind `jobProgress`, so
   * two at once report each other's progress.
   */
  private serially<T>(work: () => Promise<T>): Promise<T> {
    const queued = this.running.then(work);
    this.running = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async mergeNow(photoIds: readonly string[]): Promise<CompositePhoto> {
    const frames = this.framesOf(photoIds);
    const { library, sources } = frames;
    await this.bringFrames(photoIds, library);
    const watching = { photoId: null, photoIds: sources.map((source) => source.photoId) };
    // **One worker for the three jobs.** Each of them opens a GPU device and compiles the shader
    // modules before it can start - half a second, measured - so a worker apiece spent more of the
    // merge getting ready than aligning. Closed on every path, since it holds that device.
    const on = this.processing.openComposite();
    let photoId: string | null = null;
    try {
      const aligned = await this.watched(watching, 0, () => this.aligned(sources, library, on));
      const recipe: Composed = { ...aligned, kind: 'panorama' };

      // The row before the pixels: it is what the copies are keyed by, and what the client is
      // handed back so it can show the frame being filled in rather than a merge that answered
      // with nothing to look at.
      photoId = this.photoComposites.insertComposite({
        libraryId: library.id,
        recipe: aligned,
        kind: 'panorama',
        reference: frames.referenceOf(aligned),
      });
      // The framing on the row rather than only in the recipe, so every render of this
      // photograph - a rendition, an export, the editor's own tick - trims the wedges of nothing
      // a hand-held pan leaves at the corners, and the reader can move it like any other crop.
      this.edits.save(photoId, framingEdits(recipe), 0);
      log.info('merged a panorama', { photo: photoId, sources: recipe.sources.length });

      const made = { ...watching, photoId };
      await this.build(photoId, recipe, sources, library, made, on);
      this.report({ ...made, phase: 'done', fraction: 1 });
      return { photoId };
    } catch (err) {
      // A photograph with nothing to look at is worse than no photograph.
      if (photoId != null) {
        this.photoPaths.deleteByIds([photoId]);
        await deleteGeneratedFilesFor(library, [photoId]);
      }
      this.report({ ...watching, photoId, phase: 'failed', fraction: 1 });
      throw err;
    } finally {
      on.close();
    }
  }

  /**
   * A selection carved into tiles: §2.1's refusals, then the align and the carve.
   *
   * Answers the job's id at once; the carve itself is `assemblyJob`'s to report on. Refusals throw
   * here, before there is a job.
   *
   * Behind the same one-at-a-time promise `mergePanorama` serialises on, for its reasons: two of
   * these would hold the device against each other for minutes, and there is one progress counter
   * in the library for both to write to.
   */
  startAssembly(photoIds: readonly string[]): string {
    // The one refusal `framesOf` has no reason to know about: a panorama has no such cap, and this
    // one is on the carving rather than on the decodes (§3.9).
    if (photoIds.length > MOST_SOURCES) {
      throw new AppError('VALIDATION_ERROR', `an assembly is made of at most ${MOST_SOURCES} photographs`);
    }
    const { library, sources } = this.framesOf(photoIds);
    const job: AssemblyJob = {
      id: newId(),
      photoIds: sources.map((source) => source.photoId),
      status: 'analysing',
      fraction: 0,
    };
    this.keep(job);
    void this.serially(async () => {
      await this.bringFrames(job.photoIds, library);
      return this.analyseNow(job, sources, library);
    }).then(
      (carved) => {
        if (this.cancelledJobs.delete(job.id)) {
          job.status = 'cancelled';
          return;
        }
        job.status = 'ready';
        job.fraction = 1;
        job.carved = carved;
      },
      (err: unknown) => {
        if (job.status !== 'analysing') return;
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        log.warn('could not carve an assembly', { job: job.id, err });
      },
    );
    return job.id;
  }

  assemblyJob(id: string): AssemblyJob | null {
    return this.assemblyJobs.get(id) ?? null;
  }

  /**
   * Drops this job's carve at its next boundary.
   *
   * Marked as well as signalled: the job may not have started yet - it could still be behind
   * another in the queue - and `analyseNow` reads the mark before it runs as well as while it is.
   */
  cancelAssembly(id: string): void {
    if (this.assemblyJobs.get(id)?.status !== 'analysing') return;
    this.cancelledJobs.add(id);
    // Only the job inside a native call can hear a signal, and the next job's start clears it.
    if (this.analysing === id) cancelJob();
  }

  private keep(job: AssemblyJob): void {
    this.assemblyJobs.set(job.id, job);
    if (this.assemblyJobs.size <= KEPT_ASSEMBLY_JOBS) return;
    const oldest = [...this.assemblyJobs.values()].find((held) => held.status !== 'analysing');
    if (oldest != null) this.assemblyJobs.delete(oldest.id);
  }

  private async analyseNow(
    job: AssemblyJob,
    sources: CompositeJobSource[],
    library: Library,
  ): Promise<Carved> {
    if (this.cancelledJobs.delete(job.id)) {
      job.status = 'cancelled';
      throw new AppError('VALIDATION_ERROR', 'cancelled');
    }
    // Between native calls nothing hears the signal, so the mark is read after every wait.
    const stopIfCancelled = (): void => {
      if (this.cancelledJobs.has(job.id)) throw new AppError('VALIDATION_ERROR', 'cancelled');
    };
    const on = this.processing.openComposite();
    this.analysing = job.id;
    const drafts = path.join(getDataPath(library), 'drafts');
    // The seam volume, named for this job until the analysis answers the layer key it belongs under.
    const pendingVolume = path.join(drafts, `.volume-${newId()}.bin`);
    // Never backwards: an analysis that has to fit a lens runs twice, and the second starts from nought.
    const report = (fraction: number): void => {
      job.fraction = Math.max(job.fraction, fraction);
    };
    try {
      await mkdir(drafts, { recursive: true });
      const analysedShare = 1 - LAYERS_SHARE;
      const analyse = async (): Promise<string> => {
        const answer = await watchingJobProgress(0, analysedShare, report, () =>
          this.processing.analyseAssembly(library.id, sources, library, on, pendingVolume),
        );
        stopIfCancelled();
        return answer;
      };
      let answered = await analyse();
      // The same lens fit a panorama's align does, for the same reason: the analysis's own gather
      // reaches each RAW through that lens's ratio table, and a library that has never rendered
      // these frames has never filled one in.
      const lensless = LenslessSchema.safeParse(JSON.parse(answered));
      if (lensless.success) {
        await this.fitLensless(lensless.data.lensless, sources, library, on);
        stopIfCancelled();
        answered = await analyse();
        if (LenslessSchema.safeParse(JSON.parse(answered)).success) {
          throw new AppError('VALIDATION_ERROR', 'these photographs were taken on a lens nothing could measure');
        }
      }
      const parsed = AnalysedSchema.safeParse(JSON.parse(answered));
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', 'the analysis answered tiles this build cannot read');
      }
      const seamVolume = layerKeyOf(library, parsed.data.recipe);
      const volumePath = draftVolumePath(getDataPath(library), seamVolume);
      await mkdir(path.dirname(volumePath), { recursive: true });
      await rename(pendingVolume, volumePath);
      const analysed = { ...parsed.data, recipe: { ...parsed.data.recipe, seamVolume } };
      const layers = await this.layersFor(analysed.recipe, library, on, (share) => {
        stopIfCancelled();
        report(analysedShare + LAYERS_SHARE * share);
      });
      return { analysed, layers };
    } catch (err) {
      if (this.cancelledJobs.delete(job.id) || (err instanceof Error && err.message === JOB_CANCELLED)) {
        job.status = 'cancelled';
        throw new AppError('VALIDATION_ERROR', 'cancelled');
      }
      throw err;
    } finally {
      this.analysing = null;
      on.close();
      await deleteGeneratedFile(getDataPath(library), pendingVolume);
    }
  }

  /**
   * §4.3's layers: one picture of the canvas per source, under this recipe's layer key.
   *
   * **Built once and found by key afterwards.** The key is everything the pixels depend on
   * (`layerKeyOf`), so a file already there is this file - which is what makes §2.7's reopen of an
   * assembly whose draft is still on disk free, and what the seven-day TTL is a bound on rather
   * than a deadline.
   *
   * On the caller's worker, because it is a render a source and the device is already open.
   */
  private async layersFor(
    recipe: AssemblyRecipe,
    library: Library,
    on: CompositeWorker,
    /** Told the share of the layers behind it after each one. */
    progressed: (share: number) => void = () => undefined,
  ): Promise<string[]> {
    const sources = recipe.sources.map((source) => this.sourceOf(source.photoId, library));
    const layerKey = layerKeyOf(library, recipe);
    const dataPath = getDataPath(library);
    const layers: string[] = [];
    for (let at = 0; at < sources.length; at++) {
      const outputPath = draftLayerPath(dataPath, layerKey, at);
      if (!existsSync(outputPath)) {
        await this.processing.buildAssemblyLayer(sources, recipe, at, library, outputPath, on);
      }
      layers.push(layerUrlOf(library.id, layerKey, at));
      progressed((at + 1) / sources.length);
    }
    return layers;
  }

  /**
   * §2.7's reopen: the recipe on this row, and the layers rebuilt from it.
   *
   * No analysis re-run - the tiles, the picks, the base and the scores are all on the recipe - and
   * no draft either, a finished assembly being re-entered by its photograph rather than by the
   * frames it was carved from.
   *
   * A source deleted or binned since is what stops this: the page is told which, and gets no
   * layers, because a canvas is composed from every frame it names or from none.
   */
  async reopenAssembly(photoId: string): Promise<ReopenedAssembly> {
    const photo = this.photoPaths.getBasicById(photoId);
    if (photo?.recipe.kind !== 'assembly') {
      throw new AppError('NOT_FOUND', `${photoId} is not an assembly to open`);
    }
    const recipe = photo.recipe;
    const missingSources = recipe.sources
      .map((source) => source.photoId)
      .filter((id) => this.photoPaths.getBasicById(id) == null || this.photoMetadata.isBinned(id));
    if (missingSources.length > 0) return { recipe, layers: [], missingSources };

    const library = this.libraries.getById(photo.library_id);
    if (library == null) throw new AppError('NOT_FOUND', 'that library is gone');
    const layers = await this.serially(async () => {
      const on = this.processing.openComposite();
      try {
        return await this.layersFor(recipe, library, on);
      } finally {
        on.close();
      }
    });
    return { recipe, layers, missingSources };
  }

  /**
   * Where the frames meet for each of `picks` in place of `recipe`'s own (§2.8): an answer a set,
   * null where that set's solve was refused - or null for all of them where the volume its carve
   * left has been reaped and the tiles are the seams.
   */
  async solveSeams(recipe: AssemblyRecipe, picks: number[][]): Promise<(Seams | null)[] | null> {
    const { library } = await this.framesFor(recipe);
    return this.solved(recipe, picks, library);
  }

  /**
   * §4.2's settled preview: where the page can fetch this pick set rendered rather than masked.
   *
   * **Built once and found by name afterwards**, on the same queue and for the same reason as every
   * other render here: the reader steps between picks, and stepping back to one they have seen
   * should not hold the device again.
   */
  async previewOf(recipe: AssemblyRecipe): Promise<string> {
    const { library } = await this.framesFor(recipe);
    // The page has solved these seams already and posts them; only a set it could not solve costs
    // a solve here, which is what keeps a preview one render rather than a solve and a render.
    const held = recipe.seams;
    const ready =
      held != null && held.base === recipe.base && held.pick.every((source, tile) => source === recipe.pick[tile]) ?
        recipe
      : await this.seamed(recipe, library);
    const dataPath = getDataPath(library);
    const layerKey = layerKeyOf(library, ready);
    const outputPath = draftPreviewPath(dataPath, layerKey, pictureKeyOf(ready));
    if (!existsSync(outputPath)) {
      await this.serially(async () => {
        const on = this.processing.openComposite();
        try {
          const sources = ready.sources.map((source) => this.sourceOf(source.photoId, library));
          await this.processing.buildAssemblyPreview(sources, ready, library, outputPath, on);
        } finally {
          on.close();
        }
      });
    }
    return previewUrlOf(library.id, layerKey, pictureKeyOf(ready));
  }

  private async solved(recipe: AssemblyRecipe, picks: number[][], library: Library): Promise<(Seams | null)[] | null> {
    if (recipe.seamVolume == null) return null;
    const volumePath = draftVolumePath(getDataPath(library), recipe.seamVolume);
    if (!existsSync(volumePath)) return null;
    const answered = await this.processing.solveSeams({ ...recipe, seams: undefined }, picks, volumePath, library);
    const parsed = SolvedSeamsSchema.safeParse(JSON.parse(answered));
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'the seam solve answered pieces this build cannot read');
    }
    return parsed.data;
  }

  /**
   * The recipe with seams for its own picks: solved afresh where the volume is still on disk, the
   * ones it carries where they were solved for these same picks, and none otherwise.
   *
   * **Solved here rather than trusted from the page**, which may be holding an answer for the picks
   * before its last click. A solve that refuses - too many pieces for a recipe to hold - leaves the
   * tiles as the seams rather than failing the commit.
   */
  private async seamed(recipe: AssemblyRecipe, library: Library): Promise<AssemblyRecipe> {
    const solved = await this.solved(recipe, [recipe.pick], library).catch((err: unknown) => {
      log.warn('the seams could not be solved; the tiles are the seams', { err });
      return null;
    });
    const own = solved?.[0];
    if (own != null) return { ...recipe, seams: own };
    const held = recipe.seams;
    const current =
      held != null &&
      held.base === recipe.base &&
      held.pick.length === recipe.pick.length &&
      held.pick.every((source, tile) => source === recipe.pick[tile]);
    return current ? recipe : { ...recipe, seams: undefined };
  }

  /**
   * §2.5's Done: the photograph this recipe composes, and the copies it owes.
   *
   * `mergeNow` past its align, generalised to a kind that is not `'panorama'` and to a recipe the
   * reader made rather than one the align alone answered. Behind the same queue for its reason:
   * this composites a canvas out of every frame and holds the device while it does.
   */
  commitAssembly(recipe: AssemblyRecipe): Promise<CompositePhoto> {
    return this.serially(() => this.commitNow(recipe));
  }

  private async commitNow(asked: AssemblyRecipe): Promise<CompositePhoto> {
    const { library, sources } = await this.framesFor(asked);
    const recipe = await this.seamed(asked, library);
    const photoId = this.photoComposites.insertComposite({
      libraryId: library.id,
      recipe,
      kind: 'assembly',
      // The base is the frame the picture is mostly made of, so it is where this files itself.
      reference: recipe.sources[recipe.base]?.photoId ?? sources[0]!.photoId,
    });
    try {
      this.edits.save(photoId, framingEdits(recipe), 0);
      log.info('assembled a photograph', { photo: photoId, sources: recipe.sources.length });
      await this.assembled(photoId, recipe, sources, library);
      return { photoId };
    } catch (err) {
      // A photograph with nothing to look at is worse than no photograph.
      this.photoPaths.deleteByIds([photoId]);
      await deleteGeneratedFilesFor(library, [photoId]);
      throw err;
    }
  }

  /**
   * §2.7's reopen: this assembly's picks as they now stand, and the copies rebuilt from them.
   *
   * In place rather than a second photograph: the reader is editing the one they made, and its
   * date, its shoot, its rating and its place in every album are the row's already.
   */
  updateAssembly(photoId: string, recipe: AssemblyRecipe): Promise<CompositePhoto> {
    return this.serially(() => this.updateNow(photoId, recipe));
  }

  private async updateNow(photoId: string, asked: AssemblyRecipe): Promise<CompositePhoto> {
    const photo = this.photoPaths.getBasicById(photoId);
    if (photo?.recipe.kind !== 'assembly') {
      throw new AppError('NOT_FOUND', `${photoId} is not an assembly to update`);
    }
    const { library, sources } = await this.framesFor(asked);
    const recipe = await this.seamed(asked, library);

    this.photoComposites.updateRecipe(photoId, recipe);
    // The framing is the recipe's, and a re-edit can have moved it.
    this.edits.save(photoId, framingEdits(recipe), this.edits.get(photoId).rev);
    await this.assembled(photoId, recipe, sources, library);
    return { photoId };
  }

  /** `photoId`'s copies of `recipe`, built on a worker of their own and reported to whoever watches. */
  private async assembled(
    photoId: string,
    recipe: AssemblyRecipe,
    sources: CompositeJobSource[],
    library: Library,
  ): Promise<void> {
    const watching = { photoId, photoIds: sources.map((source) => source.photoId) };
    const on = this.processing.openComposite();
    try {
      await this.build(photoId, { ...recipe, kind: 'assembly' }, sources, library, watching, on);
      this.report({ ...watching, phase: 'done', fraction: 1 });
    } catch (err) {
      this.report({ ...watching, phase: 'failed', fraction: 1 });
      throw err;
    } finally {
      on.close();
    }
  }

  /** The library a recipe's frames are in, and the files behind them - every one re-checked. */
  private async framesFor(recipe: AssemblyRecipe): Promise<{ library: Library; sources: CompositeJobSource[] }> {
    const first = recipe.sources[0];
    if (first == null) throw new AppError('VALIDATION_ERROR', 'this recipe names no frames');
    const library = this.libraries.getById(this.frameOf(first.photoId).library_id);
    if (library == null) throw new AppError('NOT_FOUND', 'that library is gone');
    await this.bringFrames(
      recipe.sources.map((source) => source.photoId),
      library,
    );
    return { library, sources: recipe.sources.map((source) => this.sourceOf(source.photoId, library)) };
  }

  /** One frame of a draft, still where the page left it. */
  private frameOf(photoId: string): BasicPhoto {
    const frame = this.photoPaths.getBasicById(photoId);
    if (frame == null) throw new AppError('NOT_FOUND', `${photoId} is gone`);
    if (this.photoMetadata.isBinned(photoId)) throw new AppError('NOT_FOUND', `${photoId} is in the bin`);
    return frame;
  }

  private sourceOf(photoId: string, library: Library): CompositeJobSource {
    const frame = this.frameOf(photoId);
    const rawFilePath = originalPathOf(library, frame);
    if (rawFilePath == null) {
      throw new AppError('VALIDATION_ERROR', `${photoId} is composed, so it cannot be a frame of one`);
    }
    return { photoId, rawFilePath };
  }

  /**
   * The recipe these photographs make, with every lens behind it measured.
   *
   * **A recipe is stated in the camera's corrected geometry**, so a composite of the photographs
   * themselves reaches each RAW through that lens's own ratio table - and the table is the stored
   * camera match, which is fitted inside a render. A library serving the cameras' pictures never
   * renders a frame, so on one of those nothing has ever fitted the lens: the composite of the
   * JPEGs comes out perfect and the composite of the RAWs doubles every edge at every seam.
   *
   * So a lens the align could not reach for is fitted here and the set is aligned again. One
   * photograph per lens, which is what a group needs (`shared_lenses` hands its answer to every
   * member), and once ever: the fit is kept in that photograph's analysis.
   */
  private async aligned(sources: CompositeJobSource[], library: Library, on: CompositeWorker): Promise<Composition> {
    let answered = await this.processing.alignComposite(library.id, this.searchable(sources, library), library, on);
    let aligned = this.readAlignment(answered);
    if (aligned.lensless.length > 0) {
      await this.fitLensless(aligned.lensless, sources, library, on);
      answered = await this.processing.alignComposite(library.id, this.searchable(sources, library), library, on);
      aligned = this.readAlignment(answered);
    }
    for (const warning of aligned.warnings) log.warn('the alignment has something to say', { warning });
    return aligned.recipe;
  }

  /** The lenses an align says nothing has ever measured, fitted so the next one can reach them. */
  private async fitLensless(
    lensless: readonly string[],
    sources: readonly CompositeJobSource[],
    library: Library,
    on: CompositeWorker,
  ): Promise<void> {
    log.info('fitting the lenses this set was shot on', { photos: lensless });
    for (const photoId of lensless) {
      const source = sources.find((each) => each.photoId === photoId);
      if (source == null) continue;
      // Best effort: a body that embeds no JPEG has nothing to fit against, and a composite that
      // stitches without a lens is a worse picture than this one - not a failed merge.
      await this.processing
        // On the merge's own worker: the device is already open and the modules already compiled.
        .measureCameraMatch(source.rawFilePath, photoId, library, on)
        .catch((err: unknown) => log.warn('could not fit the lens this set was shot on', { photo: photoId, err }));
    }
  }

  private readAlignment(answered: string): Aligned {
    const parsed = AlignedSchema.safeParse(JSON.parse(answered));
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'the alignment answered a recipe this build cannot read');
    }
    return parsed.data;
  }

  /** Called as a merge moves, for the stream that tells the grid what it is waiting on. */
  onProgress(listener: (progress: CompositeProgress) => void): void {
    this.progress.add(listener);
  }

  /**
   * Everything a render of this panorama needs, or null where the photograph is not one.
   *
   * The frames are resolved here rather than carried on the recipe: the recipe names them by id,
   * so a frame that has been renamed or moved is still found, and one that has been deleted is
   * what makes this answer null rather than a render that fails half way.
   */
  renderable(photoId: string): { kind: 'panorama' | 'assembly'; recipe: Composed; sources: CompositeJobSource[] } | null {
    const photo = this.photoPaths.getBasicById(photoId);
    if (photo == null || !isComposite(photo.recipe)) return null;
    const library = this.libraries.getById(photo.library_id);
    if (library == null) return null;
    const recipe = photo.recipe;
    const sources: CompositeJobSource[] = [];
    for (const source of recipe.sources) {
      const frame = this.photoPaths.getBasicById(source.photoId);
      if (frame == null) return null;
      const rawFilePath = originalPathOf(library, frame);
      if (rawFilePath == null) return null;
      sources.push({ photoId: source.photoId, rawFilePath });
    }
    return { kind: recipe.kind, recipe, sources };
  }

  /**
   * Builds the copies a panorama owes, and records them.
   *
   * Only the sources the recipe actually named, in its own order: the solve may have left a frame
   * out, and the composite is indexed against the recipe rather than against the selection.
   */
  private async build(
    photoId: string,
    recipe: Composed,
    offered: readonly CompositeJobSource[],
    library: Library,
    watching: { photoId: string | null; photoIds: string[] },
    on: CompositeWorker,
  ): Promise<void> {
    const byId = new Map(offered.map((source) => [source.photoId, source]));
    const sources = recipe.sources.map((source) => {
      const frame = byId.get(source.photoId);
      if (frame == null) throw new AppError('NOT_FOUND', `${source.photoId} is not one of these photographs`);
      return frame;
    });

    // What this row owes and what each copy is built from, off the rule every recipe shares: a
    // merge is the first build of a photograph rather than a kind of work with rules of its own,
    // so it asks the same question the queue asks about anything (`renditions::owedOf`).
    const owed = owedOf({
      recipe,
      inputs: sources.map((source) => source.rawFilePath),
      // The frames' documents, which are the ones the cameras' JPEGs could not be carrying: the
      // canvas's own is the framing written a line ago, and that reaches the picture either way.
      edited: this.photoComposites.anyEdited(sources.map((source) => source.photoId)),
      photoSource: null,
      librarySource: library.rendition_source,
      hdr: library.rendition_hdr,
    });
    const builtFrom = this.photoProcessing.builtFromOf(photoId);

    for (const [at, want] of owed.entries()) {
      await this.watched(watching, at + 1, () =>
        this.processing.buildCompositeRendition(
          photoId,
          sources,
          recipe,
          recipe.kind,
          library,
          want.rendition,
          want.hdr,
          want.from,
          on,
          true,
        ),
      );
      this.renditions.markBuilt(
        photoId,
        renditionVariant(want.rendition, want.hdr),
        new Date().toISOString(),
        builtFrom,
        // A composite is never anybody's plane, so the geometry beside it is nothing's question.
        { from: want.from, matched: false },
      );
    }
    // A library that serves the cameras' pictures is shown this canvas composited from them, and
    // that is done when a reader opens it rather than now: a merge is over in seconds, and a pan
    // nobody opens costs nothing. Said here so the row stops owing a copy it will never be
    // queued for (`renditions::owedOf`).
    if (!owed.some((want) => want.rendition === 'full')) {
      this.renditions.unqueue(photoId, [renditionVariant('full', library.rendition_hdr)]);
    }
  }

  /**
   * Runs one phase of a merge, telling whoever is watching how far into it the native side is.
   *
   * The work is a blocking call in a worker, so nothing inside it can report: what moves is a
   * counter in the library, which this thread reads on a timer. A phase whose counter never
   * appears - one that finished inside a single tick - still reports its own share as it ends.
   */
  private async watched<T>(
    watching: { photoId: string | null; photoIds: string[] },
    at: number,
    run: () => Promise<T>,
  ): Promise<T> {
    const before = PHASES.slice(0, at).reduce((sum, phase) => sum + phase.share, 0);
    const { phase, share } = PHASES[at]!;
    return await watchingJobProgress(before, share, (fraction) => this.report({ ...watching, phase, fraction }), run);
  }

  private report(progress: CompositeProgress): void {
    for (const listener of this.progress) listener(progress);
  }

  /**
   * The same sources, with the grid tile named as the picture to search where every one of them
   * has a tile that is still the camera's own picture of the whole frame.
   *
   * **The recipe is stated in the camera's corrected geometry**, which is what lets the composite
   * of the cameras' JPEGs use the same rotations and the RAW gather reach them through the lens
   * table. That is a statement about the *plane*, not about where the pixels came from: a tile off
   * the camera's JPEG is that geometry to begin with, and a render is too wherever the match
   * warped it there (§10.8) - which is the default, and the whole of why a library that renders
   * its tiles can still align on them. `cameraTile` is what holds those cases apart.
   *
   * All or none, because the solve's focal is one number in the plane's pixels: planes at two
   * different scales would make it mean two different things.
   */
  private searchable(sources: CompositeJobSource[], library: Library): CompositeJobSource[] {
    const dataPath = getDataPath(library);
    const planes = sources.map((source) => {
      if (!this.renditions.cameraTile(source.photoId)) return null;
      const tile = renditionPathFor(dataPath, source.photoId, 'grid', false);
      return existsSync(tile) ? tile : null;
    });
    if (planes.some((plane) => plane == null)) return sources;
    return sources.map((source, at) => ({ ...source, previewPath: planes[at] ?? undefined }));
  }

  /**
   * The photographs offered to a merge, oldest first, which is how a pan is shot.
   *
   * Every one of them has to be a file: the gather reads a source as one prepared plane, so a
   * panorama of panoramas is refused for want of an implementation rather than of a use. They
   * also have to share a library, since what comes out is a row in one.
   */
  private framesOf(photoIds: readonly string[]): {
    library: Library;
    sources: CompositeJobSource[];
    referenceOf: (recipe: Composition) => string;
  } {
    if (photoIds.length < 2) {
      throw new AppError('VALIDATION_ERROR', 'a merge is made of at least two photographs');
    }
    for (const photoId of photoIds) this.frameOf(photoId);
    const ordered = this.photoComposites.orderedForComposite(photoIds);
    const libraries = new Set(ordered.map((photo) => photo.library_id));
    if (libraries.size !== 1) {
      throw new AppError('VALIDATION_ERROR', 'these photographs are not all in one library');
    }
    const library = this.libraries.getById([...libraries][0]!);
    if (library == null) throw new AppError('NOT_FOUND', 'that library is gone');

    const sources = ordered.map((photo) => this.sourceOf(photo.id, library));
    // Which frame the row takes its date and its shoot from: the one the solve made everything
    // else relative to, so the panorama files itself where the pan was shot.
    const referenceOf = (recipe: Composition): string =>
      recipe.sources[recipe.reference]?.photoId ?? recipe.sources[0]?.photoId ?? sources[0]!.photoId;
    return { library, sources, referenceOf };
  }
}
