import { type ViewerRendition } from '../../../../src/schemas/settings';
import type { PhotoSummary } from '../../../../src/schemas/photos';
import { RenditionsStrings } from './renditions.strings';

// What each rendition is called wherever the user meets one: the viewer's
// picker, the download menu, the panel naming what is on screen, and the setting
// deciding which a photo opens at. One function so those four cannot drift into
// four names for the same file (§10.2). A finished picture (`is_raw` false) is
// its original or its edit whichever file it is drawn from: one this browser
// cannot draw is shown rendered.
export function renditionLabel(
  rendition: ViewerRendition,
  photo?: (Pick<PhotoSummary, 'is_raw' | 'is_edited'> & Partial<PhotoSummary>) | null,
): string {
  if (photo?.is_raw === false)
    return photo.is_edited && rendition !== 'embedded'
      ? RenditionsStrings.edited()
      : RenditionsStrings.original();
  if (rendition === 'embedded') return RenditionsStrings.embeddedJpeg();
  if (rendition === 'camera')
    return photo?.camera_file_format === 'heif'
      ? RenditionsStrings.cameraHeic()
      : RenditionsStrings.cameraJpeg();
  return rendition === 'full'
    ? RenditionsStrings.renderedRaw()
    : RenditionsStrings.renderedRawMaxQuality();
}
