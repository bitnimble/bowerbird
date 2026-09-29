import type { JobAdjust } from './jobs';
import {
  IDENTITY_TONE_CURVE,
  sameEditValue,
  type CameraTone,
  type EditDoc,
  type EditHistory,
} from './photo_edits';

/** The exposure a grade is handed: null is the camera match's (`EditDoc.cameraMatchApplied`). */
export function exposureOf(doc: EditDoc): number | null {
  return doc.cameraMatchApplied || doc.exposure !== 0 ? doc.exposure : null;
}

export function adjustOf(doc: EditDoc): JobAdjust {
  return {
    contrast: doc.contrast,
    highlights: doc.highlights,
    shadows: doc.shadows,
    whites: doc.whites,
    blacks: doc.blacks,
    toneCurve: doc.toneCurve ?? (doc.cameraMatchApplied ? IDENTITY_TONE_CURVE : null),
    vibrance: doc.vibrance,
    saturation: doc.cameraMatchApplied || doc.saturation !== 0 ? doc.saturation : null,
    texture: doc.texture,
    clarity: doc.clarity,
    dehaze: doc.dehaze,
    temperature: doc.temperature,
    tint: doc.tint,
    colourProfile: doc.colourProfile,
  };
}

/**
 * `doc` with the camera match written in: each of the three still at its default takes the
 * camera's, so a value the reader or an imported sidecar set survives.
 */
export function cameraMatchedEdits(doc: EditDoc, tone: CameraTone): EditDoc {
  const camera = asEdits(tone);
  return {
    ...doc,
    exposure: doc.exposure === 0 ? camera.exposure : doc.exposure,
    saturation: doc.saturation === 0 ? camera.saturation : doc.saturation,
    toneCurve: doc.toneCurve ?? camera.toneCurve,
    cameraMatchApplied: true,
  };
}

/** Undo steps recorded before the match, whose defaults stood for the camera's as the document's did. */
export function cameraMatchedHistory(history: EditHistory, tone: CameraTone): EditHistory {
  const camera = asEdits(tone);
  const matched = (values: Record<string, unknown>): Record<string, unknown> => ({
    ...values,
    ...(values.exposure === 0 ? { exposure: camera.exposure } : {}),
    ...(values.saturation === 0 ? { saturation: camera.saturation } : {}),
    ...('toneCurve' in values && values.toneCurve == null ? { toneCurve: camera.toneCurve } : {}),
  });
  return history.map((step) => ({ from: matched(step.from), to: matched(step.to) }));
}

const CAMERA_MATCH_FIELDS = [
  'exposure',
  'saturation',
  'toneCurve',
  'colourProfile',
  'cameraMatchApplied',
] as const;

export function cameraMatchReset(
  tone: CameraTone,
): Pick<EditDoc, (typeof CAMERA_MATCH_FIELDS)[number]> {
  return { ...asEdits(tone), colourProfile: 'matched', cameraMatchApplied: true };
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
