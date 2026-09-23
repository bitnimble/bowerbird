import { AppError } from '../../../errors';
import { isComposite } from '../../../schemas/recipes';
import type { ViewerRendition } from '../../../schemas/settings';
import { getRenditionPath } from '../../../utils/paths';
import type { Originals } from '../../blobs/originals';
import type { PhotoReadService } from '../../photos/listing/photo_read_service';
import type { PhotoRenditionService } from '../../photos/renditions/photo_rendition_service';
import { readEmbeddedJpeg } from '../rawshim/raw_decoder';
import { storedAsHdr } from '../renditions/renditions';
import type { ExportService } from './export_service';

/** A rendition as one JPEG anything can open, for a share sheet or a TV. */
export class ShareService {
  constructor(
    private readonly photoRenditions: Pick<PhotoRenditionService, 'locate'>,
    private readonly originals: Originals,
    private readonly photoRead: Pick<PhotoReadService, 'editOrientation'>,
    private readonly exports: Pick<ExportService, 'shareable'>,
  ) {}

  /**
   * The camera's own JPEG goes over unchanged. Everything else is an AVIF, transcoded, with a gain
   * map where the library's renditions are HDR. Nothing is built: a rendition not on disk is refused.
   */
  async jpeg(photoId: string, rendition: ViewerRendition): Promise<Uint8Array> {
    const { photo, library } = this.photoRenditions.locate(photoId);
    if (rendition === 'embedded' && !isComposite(photo.recipe)) {
      const originalPath = await this.originals.open(library, photo);
      if (originalPath == null) throw new AppError('NOT_FOUND', `this photograph has no file to lift a JPEG out of: ${photoId}`);
      const jpeg = readEmbeddedJpeg(originalPath, this.photoRead.editOrientation(photoId));
      if (jpeg == null) throw new AppError('NOT_FOUND', `this file has no embedded JPEG: ${photoId}`);
      return new Uint8Array(jpeg);
    }
    const renditionPath = getRenditionPath(library, photo.id, rendition, library.rendition_hdr);
    if (!(await Bun.file(renditionPath).exists())) throw new AppError('NOT_FOUND', `image not found on disk: ${photoId}`);
    return this.exports.shareable(photo.id, renditionPath, storedAsHdr(rendition, library.rendition_hdr));
  }

  /** The rendition to share where nobody is looking at one: the first already built, else the camera's JPEG. */
  async built(photoId: string): Promise<ViewerRendition> {
    const { photo, library } = this.photoRenditions.locate(photoId);
    for (const rendition of ['full', 'max'] as const) {
      if (await Bun.file(getRenditionPath(library, photo.id, rendition, library.rendition_hdr)).exists()) return rendition;
    }
    return 'embedded';
  }
}
