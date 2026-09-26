// What the Edits panel lists, which is every attribute a reader moved and nothing else. The
// panel is built out of the editor's own slider specifications so the two cannot drift, and
// what this pins is the other half of that: the neutral each attribute is judged against,
// and the handful of edits that are not sliders at all.
import { describe, expect, test } from 'bun:test';
import { neutralEdits, TONE_CURVE_KIND, type EditDoc } from '../../../../../../src/schemas/photo_edits';
import { editRows } from '../edit_rows';
import { DUST, EDIT_SLIDERS } from '../../../raw_edit/edit_sliders';

const doc = (over: Partial<EditDoc> = {}): EditDoc => ({ ...neutralEdits(), ...over }) as EditDoc;
const FRAME = { width: 6000, height: 4000 };
const rowsOf = (edits: EditDoc): ReturnType<typeof editRows> => editRows(edits, FRAME);
const labels = (over: Partial<EditDoc> = {}): string[] => rowsOf(doc(over)).map(([label]) => String(label));

test('an untouched document is not an edit', () => {
  expect(rowsOf(doc())).toEqual([]);
});

// The failure this pins: a neutral written here that is not the schema's default reports
// every photograph as edited, on a slider nobody has touched.
describe('every slider is judged against the neutral the editor resets it to', () => {
  // Dust's own sliders only list while dust removal is on, which is where the editor shows
  // them too, so that is the baseline both halves are measured from.
  const on = { dustRemoval: true } as Partial<EditDoc>;
  for (const spec of [...EDIT_SLIDERS, ...DUST]) {
    test(spec.key, () => {
      expect(rowsOf(doc(on))).toEqual([]);
      const moved = (spec.neutral ?? 0) === spec.max ? spec.min : spec.max;
      expect(rowsOf(doc({ ...on, [spec.key]: moved }))).toHaveLength(1);
    });
  }
});

test('a stored zero exposure and a stored curve are edits', () => {
  expect(labels({ exposure: null, contrast: 0 })).toEqual([]);
  expect(labels({ exposure: 0, contrast: 0 })).toEqual(['Exposure']);
  expect(rowsOf(doc({ toneCurve: { kind: TONE_CURVE_KIND, points: [[0, 0.1], [1, 1]] } }))).toContainEqual(['Tone curve', 'Edited']);
});

test('a crop is listed as what it kept, and a full frame is not a crop', () => {
  expect(labels()).not.toContain('Crop');
  // A rectangle fitted out of a straighten comes back a hair under the full frame, which is
  // not something the reader cropped.
  expect(labels({ cropRight: 0.9999 })).not.toContain('Crop');
  expect(rowsOf(doc({ cropLeft: 0.1, cropRight: 0.9 }))).toContainEqual(['Crop', '80% × 100% (1.2:1)']);
});

test('a crop names its shape on the picture the reader sees, turn and all', () => {
  // 4000 of 6000 wide by all 4000 tall is square.
  expect(rowsOf(doc({ cropRight: 2 / 3 }))).toContainEqual(['Crop', '67% × 100% (1:1)']);
  // 6000 by 2000, 3:1, turned on its side.
  expect(rowsOf(doc({ cropBottom: 0.5, rotate: 90 }))).toContainEqual(['Crop', '100% × 50% (1:3)']);
  expect(rowsOf(doc({ cropLeft: 0.25, cropRight: 0.75, cropBottom: 0.75 }))).toContainEqual([
    'Crop',
    '50% × 75% (1:1)',
  ]);
  expect(editRows(doc({ cropRight: 0.5 }), null)).toContainEqual(['Crop', '50% × 100%']);
});

test('dust removal turned off says so instead of listing its sliders', () => {
  const rows = rowsOf(doc({ dustRemoval: false }));
  expect(rows).toContainEqual(['Dust removal', 'Off']);
  expect(rows.map(([label]) => label)).not.toContain('Dust sensitivity');
});

// A sidecar names the camera's own mode with no Kelvins beside it, and the render then uses
// the as-shot multipliers: a row there describes a photograph nothing changed.
test('a white balance mode is listed only with the temperature that carries it', () => {
  expect(labels({ whiteBalanceMode: 'Daylight' })).not.toContain('White balance');
  expect(labels({ whiteBalanceMode: 'Daylight', temperature: 5500 })).toContain('White balance');
});

test('the edits that are not sliders', () => {
  expect(labels({ rotate: 90 })).toContain('Rotate');
  expect(labels({ cropAngle: 2.5 })).toContain('Straighten');
  expect(labels({ keystone: [0, 0, 1, 0, 1, 1, 0, 1] as never })).toContain('Perspective');
});
