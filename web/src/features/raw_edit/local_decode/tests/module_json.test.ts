// The page's half of the tick's wire shape, against the sample the module reads.
//
// `native/rawshim/tests/module_json.rs` deserialises this same file into `gpu::Region`,
// `gpu::Adjust` and `image::Geometry`, and says why both halves exist. What this side adds is
// that a *typed* value produces exactly those keys: the literals below are annotated, so a field
// renamed in `edits.ts` stops compiling here, and one added or dropped fails the comparison.
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { EditAdjust, EditGeometry, Region } from '../../edits';
import { DEFAULT_PRINT_SCENE, PrintSceneSchema } from '../../print/print_scene';

// Typed as what it is meant to be so the comparisons below read straight. It is the *literals*
// that carry the annotation this pin rests on; the file is the other host's answer.
const sample = (await Bun.file(
  new URL('../../../../../../test/fixtures/tables/module-json.json', import.meta.url).pathname,
).json()) as { region: Region; adjust: EditAdjust; geometry: EditGeometry };

describe('what a tick carries', () => {
  test('names the print scene as the module reads it', async () => {
    const wire: unknown = await Bun.file(
      new URL('../../../../../../test/fixtures/tables/module-json.json', import.meta.url).pathname,
    ).json();
    expect(z.object({ print: PrintSceneSchema }).parse(wire).print).toEqual(DEFAULT_PRINT_SCENE);
  });
  test('names the region as the module reads it', () => {
    const region: Region = { x: 12.5, y: 34.25, width: 640, height: 480 };
    expect(region).toEqual(sample.region);
  });

  test('names every slider as the module reads it', () => {
    const adjust: EditAdjust = {
      contrast: 11,
      highlights: -22,
      shadows: 33,
      whites: -44,
      blacks: 55,
      vibrance: -66,
      saturation: 77,
      texture: -88,
      clarity: 99,
      dehaze: -12.5,
      temperature: 4800,
      tint: null,
      colourProfile: 'none',
    };
    expect(adjust).toEqual(sample.adjust);
  });

  test('names the geometry as the module reads it', () => {
    const geometry: EditGeometry = {
      crop: [0.1, 0.2, 0.8, 0.9],
      angleDegrees: 6.5,
      rotate: 90,
      keystone: [1.01, 0.02, -0.03, 0.04, 1.05, -0.06, 0.07, -0.08],
    };
    expect(geometry).toEqual(sample.geometry);
  });
});
