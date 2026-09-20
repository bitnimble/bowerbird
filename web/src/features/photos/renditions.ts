import { type RenditionSource } from '../../../../src/schemas/common';
import { type ViewerRendition } from '../../../../src/schemas/settings';
import type { Option } from '../../ui/option';
import { RenditionsStrings } from './renditions.strings';

// What each rendition is called wherever the user meets one: the viewer's
// picker, the download menu, the panel naming what is on screen, and the setting
// deciding which a photo opens at. One function so those four cannot drift into
// four names for the same file (§10.2).
export function renditionLabel(rendition: ViewerRendition): string {
  if (rendition === 'embedded') return RenditionsStrings.embeddedJpeg();
  return rendition === 'full' ? RenditionsStrings.renderedRaw() : RenditionsStrings.renderedRawMaxQuality();
}

// Named as the viewer names the rendition each one produces, so the setting and
// the picker are visibly the same two choices. Offered both when a library is
// added and in its settings afterwards.
export const RENDITION_SOURCES: Option<RenditionSource>[] = [
  { value: 'embedded', label: renditionLabel('embedded') },
  { value: 'render', label: renditionLabel('full') },
];
