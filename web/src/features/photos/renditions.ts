import { type ViewerRendition } from '../../../../src/schemas/settings';
import { RenditionsStrings } from './renditions.strings';

// What each rendition is called wherever the user meets one: the viewer's
// picker, the download menu, the panel naming what is on screen, and the setting
// deciding which a photo opens at. One function so those four cannot drift into
// four names for the same file (§10.2).
export function renditionLabel(rendition: ViewerRendition): string {
  if (rendition === 'embedded') return RenditionsStrings.embeddedJpeg();
  return rendition === 'full'
    ? RenditionsStrings.renderedRaw()
    : RenditionsStrings.renderedRawMaxQuality();
}
