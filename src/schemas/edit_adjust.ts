import type { JobAdjust } from './jobs';
import type { EditDoc } from './photo_edits';

export function adjustOf(doc: EditDoc): JobAdjust {
  return {
    contrast: doc.contrast,
    highlights: doc.highlights,
    shadows: doc.shadows,
    whites: doc.whites,
    blacks: doc.blacks,
    vibrance: doc.vibrance,
    saturation: doc.saturation,
    texture: doc.texture,
    clarity: doc.clarity,
    dehaze: doc.dehaze,
    temperature: doc.temperature,
    tint: doc.tint,
    colourProfile: doc.colourProfile,
  };
}
