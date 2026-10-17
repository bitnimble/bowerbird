import { AppError } from '../../../errors';
import { isComposite } from '../../../schemas/recipes';
import type { ViewerRendition } from '../../../schemas/settings';
import { getRenditionPath } from '../../../utils/paths';
import { hasEmbeddedJpeg } from '../../../utils/scan';
import type { PhotoRenditionService } from '../../photos/renditions/photo_rendition_service';
import { storedAsHdr } from '../renditions/renditions';
import type { ExportService } from './export_service';
import { LibraryActivity } from '../../activity/library_activity';

/** A rendition as one JPEG anything can open, for a share sheet or a TV. */
export class ShareService {
  constructor(
    private readonly photoRenditions: Pick<
      PhotoRenditionService,
      'locate' | 'embeddedJpeg' | 'buildRendition'
    >,
    private readonly exports: Pick<ExportService, 'shareable'>,
    private readonly activity: LibraryActivity = new LibraryActivity(),
  ) {}

  /**
   * The camera's own JPEG goes over unchanged. Everything else is an AVIF, transcoded, with a gain
   * map where the library's renditions are HDR. A rendition not on disk is refused. A PNG, HEIC or AVIF
   * shown as its own file has no JPEG to hand over, so it is shared as its render, built here if
   * there is none.
   */
  async jpeg(photoId: string, rendition: ViewerRendition): Promise<Uint8Array> {
    const { photo, library } = this.photoRenditions.locate(photoId);
    return this.activity.track(library.id, 'sharing', photoId, async () => {
      const shared =
        rendition === 'embedded' &&
        photo.recipe.kind === 'file' &&
        !hasEmbeddedJpeg(photo.recipe.path)
          ? await this.built(photoId)
          : rendition;
      if (shared === 'embedded' && !isComposite(photo.recipe)) {
        const jpeg = await this.photoRenditions.embeddedJpeg(photoId);
        if (jpeg == null) throw new AppError('NOT_FOUND', `no camera JPEG to share for ${photoId}`);
        return jpeg;
      }
      const renditionPath = getRenditionPath(library, photo.id, shared, library.rendition_hdr);
      if (!(await Bun.file(renditionPath).exists()))
        throw new AppError('NOT_FOUND', `image not found on disk: ${photoId}`);
      return this.exports.shareable(
        photo.id,
        renditionPath,
        storedAsHdr(shared, library.rendition_hdr),
      );
    });
  }

  /**
   * The rendition to share where nobody is looking at one: the first already built, else the
   * camera's JPEG, else `full`, built here.
   */
  async built(photoId: string): Promise<ViewerRendition> {
    const { photo, library } = this.photoRenditions.locate(photoId);
    for (const rendition of ['full', 'max'] as const) {
      if (
        await Bun.file(
          getRenditionPath(library, photo.id, rendition, library.rendition_hdr),
        ).exists()
      )
        return rendition;
    }
    if (photo.recipe.kind !== 'file' || hasEmbeddedJpeg(photo.recipe.path)) return 'embedded';
    await this.photoRenditions.buildRendition(photoId, 'full');
    return 'full';
  }
}
