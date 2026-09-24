import { AppError } from '../../../errors';
import type { Library } from '../../../schemas/libraries';
import type { PrepareDevelop } from '../../../schemas/prepare_develop';
import { fileRecipe, isComposite } from '../../../schemas/recipes';
import { getDataPath, getRenditionPath, originalPathOf } from '../../../utils/paths';
import { readRawHeader } from '../rawshim/raw_decoder';
import type { PhotoListingRepository } from '../../photos/listing/photo_listing_repository';
import type { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import type { SettingsRepository } from '../../settings/settings_repository';
import { openPrepareWorker, pictureLevel, type Missing, type PrepareWorker, type Shown } from '../workers/prepare_pool';
import type { CompositeJobSource, WorkerJob } from '../workers/processing_types';
import { AS_METERED, developed } from './developed';
import type { RenderTargets } from './render_targets';

export class PrepareRenderer {
  private preparing: PrepareWorker | null = null;

  constructor(
    private readonly photoPaths: PhotoPathsRepository,
    private readonly photoListing: PhotoListingRepository,
    private readonly settings: SettingsRepository,
    private readonly editsFor: (photoId: string) => { doc: string; stamp: string | null } | null,
    private readonly libraryOf: (libraryId: string) => Library | null,
    private readonly compositeOf: (
      photoId: string,
    ) => { kind: 'panorama' | 'assembly'; recipe: unknown; sources: CompositeJobSource[] } | null,
    private readonly targets: RenderTargets,
  ) {}

  /**
   * One picture of a photograph, coded, for a client that will grade it itself.
   *
   * **What makes a composite openable at all.** The editor holds one frame and grades it per tick;
   * a panorama is several photographs and hundreds of megapixels, so what crosses is the composite
   * at a level rather than the sources behind it. The same call serves an ordinary photograph,
   * which is what a device too small to hold one takes.
   *
   * **The level and the rectangle are this side's, from what the client says it can show.** With
   * nothing said, the whole picture at the coarsest level it has, which is what a reader opens on.
   * With a region and a stage, the level that puts a sample on each of the stage's pixels and the
   * window of it the region names - which is how a reader reaches a canvas's own pixels, there
   * being no whole level of a 300MP panorama a device will hold.
   *
   * Framed as `ffi::bb_prepare_picture` frames it, and the caller passes the body straight
   * through: nothing on this side reads a sample.
   *
   * Whatever the prepare measured is kept here rather than by the client, so the next open of this
   * picture reads it instead of stacking every source again - and so a reader who never opens it
   * twice still leaves the library better off.
   *
   * `develop` is what a client is previewing of the settings that run before the samples cross,
   * over the stored document, which is only the last save.
   */
  async preparePicture(
    photoId: string,
    shown?: Shown,
    missing?: Missing,
    develop?: PrepareDevelop,
  ): Promise<Uint8Array> {
    const photo = this.photoPaths.getBasicById(photoId);
    if (photo == null) throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    const library = this.libraryOf(photo.library_id);
    if (library == null) throw new AppError('NOT_FOUND', `library not found: ${photo.library_id}`);
    const dataPath = getDataPath(library);
    const detail = this.photoListing.getById(photoId);
    if (detail == null) throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);

    // **A composite whose frames this device does not hold cannot be composed here.** `renderable`
    // answers null for that as well as for a row that is not a composite at all, so the two are
    // told apart by the recipe rather than by its absence - one is "nothing to prepare from" and
    // the other is an ordinary photograph.
    const composite = this.compositeOf(photoId);
    if (composite == null && isComposite(photo.recipe)) {
      throw new AppError('NOT_FOUND', `${photoId} is composed from frames this device does not hold`);
    }
    const original = composite == null ? originalPathOf(library, photo) : null;
    if (composite == null && original == null) {
      throw new AppError('NOT_FOUND', `${photoId} has no file to prepare`);
    }

    const at = pictureLevel(photo.recipe, detail, shown, missing);
    if (at == null) {
      throw new AppError('VALIDATION_ERROR', `${photoId} has no dimensions to prepare at`);
    }
    const { level, size, window, parts } = at;

    const shared = {
      photoId,
      dataPath,
      // No targets: a prepare writes no file, and their absence is also what tells the assembly to
      // composite the photographs rather than the cameras' own pictures.
      targets: [],
      grade: this.targets.grade(),
      ...developed(this.editsFor(photoId)?.doc ?? null, develop),
      ...this.targets.render(),
    };
    const job: WorkerJob = composite == null
      ? {
          kind: 'rendition',
          rawFilePath: original ?? '',
          cameraMatch: this.settings.get().match_embedded_jpeg ? 'lensAndColour' : 'none',
          ...shared,
        }
      : {
          kind: 'composite',
          cameraMatch: this.settings.get().match_embedded_jpeg ? 'lensAndColour' : 'none',
          want: 'render',
          sources: composite.sources,
          recipe: composite.recipe,
          ...shared,
        };

    return this.prepares()
      .run({ job, level, width: size.width, height: size.height, window, parts });
  }

  /**
   * The photograph's full rendition as a picture to prepare, for a client that only shows it.
   *
   * Every edit is already in the file, so it is prepared unedited and at the white it was encoded
   * with, and the client draws it with neutral edits. The caller makes sure the file is current.
   */
  async prepareRendition(photoId: string, shown?: Shown, missing?: Missing): Promise<Uint8Array> {
    const photo = this.photoPaths.getBasicById(photoId);
    if (photo == null) throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    const library = this.libraryOf(photo.library_id);
    if (library == null) throw new AppError('NOT_FOUND', `library not found: ${photo.library_id}`);
    const path = getRenditionPath(library, photoId, 'full', library.rendition_hdr);
    // Sized off the file rather than the row: the rendition is cropped and capped in size.
    const at = pictureLevel(fileRecipe(path), readRawHeader(path), shown, missing);
    if (at == null) throw new AppError('VALIDATION_ERROR', `${photoId}'s rendition has no dimensions`);
    const { level, size, window, parts } = at;
    const job: WorkerJob = {
      kind: 'rendition',
      photoId,
      dataPath: getDataPath(library),
      rawFilePath: path,
      cameraMatch: 'none',
      statedWhite: true,
      targets: [],
      grade: this.targets.grade(),
      ...AS_METERED,
      sharpen: 0,
      defringe: 0,
    };
    return this.prepares()
      .run({ job, level, width: size.width, height: size.height, window, parts });
  }

  /**
   * The worker every prepare goes through, opened on the first one and kept.
   *
   * **Not the rendition pool's**, which is the point: a prepare is on behalf of somebody waiting
   * at a screen, and a rendition is on behalf of a queue - so sharing one would put every
   * reader's open behind whatever a library import happens to be doing.
   *
   * Kept open for the reason `openComposite` holds one across a merge's three jobs: acquiring an
   * adapter and compiling the shader modules is most of half a second.
   */
  private prepares(): PrepareWorker {
    this.preparing ??= openPrepareWorker();
    return this.preparing;
  }
}
