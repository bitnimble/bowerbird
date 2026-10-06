import type { JobAdjust } from './jobs';
import {
  IDENTITY_TONE_CURVE,
  sameEditValue,
  TEMPERATURE_KELVIN,
  TINT,
  type CameraTone,
  type EditDoc,
} from './photo_edits';

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
    cameraBalance: doc.awaitsCameraMatch,
    colourProfile: doc.colourProfile,
    colourNodes: doc.colourNodes,
  };
}

/** `doc` with the camera match filled in: a photo's first document, or one a merge wrote. */
export function withCameraMatch(doc: EditDoc, tone: CameraTone): EditDoc {
  return { ...doc, ...asEdits(tone), awaitsCameraMatch: false };
}

const CAMERA_MATCH_FIELDS = [
  'exposure',
  'saturation',
  'toneCurve',
  'whiteBalanceMode',
  'temperature',
  'tint',
  'colourProfile',
] as const;

export function cameraMatchReset(
  tone: CameraTone,
): Pick<EditDoc, (typeof CAMERA_MATCH_FIELDS)[number]> {
  return { ...asEdits(tone), colourProfile: 'matched' };
}

export function atCameraMatch(doc: EditDoc, tone: CameraTone): boolean {
  const reset = cameraMatchReset(tone);
  return CAMERA_MATCH_FIELDS.every((field) => sameEditValue(doc[field], reset[field]));
}

function asEdits(
  tone: CameraTone,
): Pick<
  EditDoc,
  'exposure' | 'saturation' | 'toneCurve' | 'whiteBalanceMode' | 'temperature' | 'tint'
> {
  const balance = tone.balance;
  return {
    exposure: clamped(tone.exposure, { min: -5, max: 5 }),
    saturation: clamped(Math.round(tone.saturation), { min: -100, max: 100 }),
    toneCurve: tone.toneCurve,
    ...(balance == null
      ? { whiteBalanceMode: 'As Shot', temperature: null, tint: null }
      : {
          whiteBalanceMode: 'Custom',
          temperature: clamped(Math.round(balance.temperature), TEMPERATURE_KELVIN),
          tint: clamped(Math.round(balance.tint), TINT),
        }),
  };
}

function clamped(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, value));
}
