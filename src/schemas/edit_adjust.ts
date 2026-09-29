import type { JobAdjust } from './jobs';
import { IDENTITY_TONE_CURVE, sameEditValue, type CameraTone, type EditDoc } from './photo_edits';

/** The exposure a grade is handed: null is the camera match's (`EditDoc.awaitsCameraMatch`). */
export function exposureOf(doc: EditDoc): number | null {
  return doc.awaitsCameraMatch && doc.exposure === 0 ? null : doc.exposure;
}

export function adjustOf(doc: EditDoc): JobAdjust {
  return {
    contrast: doc.contrast,
    highlights: doc.highlights,
    shadows: doc.shadows,
    whites: doc.whites,
    blacks: doc.blacks,
    toneCurve: doc.toneCurve ?? (doc.awaitsCameraMatch ? null : IDENTITY_TONE_CURVE),
    vibrance: doc.vibrance,
    saturation: doc.awaitsCameraMatch && doc.saturation === 0 ? null : doc.saturation,
    texture: doc.texture,
    clarity: doc.clarity,
    dehaze: doc.dehaze,
    temperature: doc.temperature,
    tint: doc.tint,
    colourProfile: doc.colourProfile,
  };
}

/** `doc` with the camera match filled in: a photo's first document, or one a merge wrote. */
export function withCameraMatch(doc: EditDoc, tone: CameraTone): EditDoc {
  return { ...doc, ...asEdits(tone), awaitsCameraMatch: false };
}

const CAMERA_MATCH_FIELDS = ['exposure', 'saturation', 'toneCurve', 'colourProfile'] as const;

export function cameraMatchReset(
  tone: CameraTone,
): Pick<EditDoc, (typeof CAMERA_MATCH_FIELDS)[number]> {
  return { ...asEdits(tone), colourProfile: 'matched' };
}

export function atCameraMatch(doc: EditDoc, tone: CameraTone): boolean {
  const reset = cameraMatchReset(tone);
  return CAMERA_MATCH_FIELDS.every((field) => sameEditValue(doc[field], reset[field]));
}

function asEdits(tone: CameraTone): Pick<EditDoc, 'exposure' | 'saturation' | 'toneCurve'> {
  return {
    exposure: Math.min(5, Math.max(-5, tone.exposure)),
    saturation: Math.min(100, Math.max(-100, Math.round(tone.saturation))),
    toneCurve: tone.toneCurve,
  };
}
