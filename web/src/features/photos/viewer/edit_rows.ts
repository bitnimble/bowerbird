import type { ReactNode } from 'react';
import type { EditDoc } from '../../../../../src/schemas/photo_edits';
import { displaySize } from '../../../../../src/schemas/display_size';
import { aspectLabel } from '../../raw_edit/crop/crop_aspect';
import { EditToolsStrings } from '../../raw_edit/edit_tools.strings';
import { DUST, EDIT_SLIDERS, reading, type SliderSpec } from '../../raw_edit/edit_sliders';
import { RawEditPanelStrings } from '../../raw_edit/raw_edit_panel.strings';
import { PhotoDetailStrings } from './photo_detail_page.strings';
import type { Size } from './zoom_pan';

export type Row = [label: string, value: ReactNode];

// The Detail and Dust sliders are named by their group heading in the editor, which a flat
// list has none of. Keyed by `EditDoc` field, so a slider renamed there stops compiling
// here rather than quietly falling back to a label that reads as its neighbour's - "Colour"
// beside "Vibrance" and "Saturation" is the ambiguity this map exists to remove.
const EDIT_LABELS: Partial<Record<keyof EditDoc, () => string>> = {
  luminanceNoise: PhotoDetailStrings.luminanceNoise,
  colourNoise: PhotoDetailStrings.colourNoise,
  dustSensitivity: PhotoDetailStrings.dustSensitivity,
  dustIntensity: PhotoDetailStrings.dustIntensity,
};

/**
 * Only what the reader moved, read against the same `neutral` the editor's reset arrow goes
 * back to - so a slider sitting at its default is not an edit here either.
 *
 * Its own module for its own test: it is a pure `EditDoc -> Row[]` over two dozen attributes,
 * and the failure that actually happens - a neutral drifting from the schema's default, a
 * field renamed, an attribute silently dropped - is invisible to anything that counts panels.
 *
 * `frame` is the file's own size, without which a crop has no aspect ratio to state.
 */
export function editRows(doc: EditDoc, frame: Size | null): Row[] {
  const rows: Row[] = [];
  const slider = (spec: SliderSpec): void => {
    const value = doc[spec.key];
    if (typeof value !== 'number') return;
    // A slider the photograph answers for itself has no default to compare against: null is
    // untouched, and any number at all is the reader having overridden a measurement.
    if (spec.measured == null && value === (spec.neutral ?? 0)) return;
    const label = EDIT_LABELS[spec.key]?.() ?? spec.label;
    rows.push([label, RawEditPanelStrings.valueWithUnit(reading(value, spec), spec.unit ?? '')]);
  };

  EDIT_SLIDERS.forEach(slider);

  // Only with the Kelvins that carry it: a sidecar names the camera's own mode ("Daylight")
  // beside no temperature at all, and the render then uses the as-shot multipliers - so the
  // name alone is a row about a photograph no pixel of which was changed, which the editor's
  // own reset offers nothing to undo.
  if (doc.whiteBalanceMode !== 'As Shot' && doc.temperature != null) {
    rows.push([RawEditPanelStrings.groupWhiteBalance(), doc.whiteBalanceMode]);
  }
  if (doc.temperature != null) {
    rows.push([RawEditPanelStrings.temperature(), RawEditPanelStrings.kelvin(doc.temperature)]);
  }
  if (doc.tint != null) rows.push([RawEditPanelStrings.tint(), reading(doc.tint, { min: -150, step: 1 })]);

  // The pair below it correct nothing while the switch is off, so a document that turned it
  // off says that and stops.
  if (!doc.dustRemoval) rows.push([RawEditPanelStrings.groupDustRemoval(), PhotoDetailStrings.dustRemovalOff()]);
  else DUST.forEach(slider);

  if (doc.cropAngle !== 0) {
    rows.push([
      RawEditPanelStrings.straighten(),
      RawEditPanelStrings.degrees(reading(doc.cropAngle, { min: -45, step: 0.05 })),
    ]);
  }
  if (doc.rotate !== 0) rows.push([PhotoDetailStrings.rotate(), RawEditPanelStrings.degrees(String(doc.rotate))]);
  // Rounded before the comparison, not after: a rectangle fitted out of a straighten comes
  // back a hair under the full frame, and an unrounded test calls that a crop of 100%.
  const width = percent(doc.cropRight - doc.cropLeft);
  const height = percent(doc.cropBottom - doc.cropTop);
  if (width < 100 || height < 100) {
    const shown = frame == null ? null : displaySize(frame.width, frame.height, doc);
    const aspect = shown == null ? null : aspectLabel(shown.width / shown.height);
    rows.push([EditToolsStrings.crop(), PhotoDetailStrings.cropOfFrame(width, height, aspect)]);
  }
  if (doc.keystone != null) {
    rows.push([EditToolsStrings.perspective(), PhotoDetailStrings.perspectiveCorrected()]);
  }
  if (doc.repairs.length > 0) {
    rows.push([EditToolsStrings.repair(), PhotoDetailStrings.removals(doc.repairs.length)]);
  }

  return rows;
}

const percent = (fraction: number): number => Math.round(fraction * 100);
