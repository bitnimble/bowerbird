// The page's half of the tick's wire shape, against the sample the module reads.
//
// `native/rawshim/tests/module_json.rs` deserialises this same file into `gpu::Region`,
// `gpu::Adjust` and `image::Geometry`, and says why both halves exist. What this side adds is
// that a *typed* value produces exactly those keys: the literals below are annotated, so a field
// renamed in `edits.ts` stops compiling here, and one added or dropped fails the comparison.
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { TONE_CURVE_KIND } from '../../../../../../src/schemas/photo_edits';
import type { EditAdjust, EditGeometry, Region } from '../../edits';
import { DEFAULT_PRINT_SCENE, PrintSceneSchema } from '../../print/print_scene';
import { OpenAskSchema } from '../local_open';

// Typed as what it is meant to be so the comparisons below read straight. It is the *literals*
// that carry the annotation this pin rests on; the file is the other host's answer.
const sample = (await Bun.file(
  new URL('../../../../../../test/fixtures/tables/module-json.json', import.meta.url).pathname,
).json()) as {
  region: Region;
  adjust: EditAdjust;
  geometry: EditGeometry;
};

describe('what a tick carries', () => {
  test('names the print scene as the module reads it', async () => {
    const wire: unknown = await Bun.file(
      new URL('../../../../../../test/fixtures/tables/module-json.json', import.meta.url).pathname,
    ).json();
    expect(z.object({ print: PrintSceneSchema }).parse(wire).print).toEqual({
      ...DEFAULT_PRINT_SCENE,
      framed: true,
      renderingIntent: 'relativeColorimetric',
      blackPointCompensation: false,
      ink: 'pigment',
      printResolutionPpi: 300,
      inkSpreadMicrons: 45,
      lightAcross: -0.6,
      zoom: 2.5,
      panX: -0.125,
      panY: 0.25,
    });
  });
  test('names the region as the module reads it', () => {
    const region: Region = { x: 12.5, y: 34.25, width: 640, height: 480 };
    expect(region).toEqual(sample.region);
  });

  test('carries the camera exposure and an explicit override', () => {
    for (const ev of [null, 1.75]) {
      expect(OpenAskSchema.parse({
        kind: 'tick', ev, drawStage: true, region: null, loupe: null, adjust: null,
        geometry: null, proof: null, print: null, stage: null,
      })).toMatchObject({ kind: 'tick', ev });
    }
  });

  test('names every slider as the module reads it', () => {
    const adjust: EditAdjust = {
      contrast: 11,
      highlights: -22,
      shadows: 33,
      whites: -44,
      blacks: 55,
      toneCurve: { kind: TONE_CURVE_KIND, points: [[0, 0.04], [0.35, 0.3], [0.7, 0.78], [1, 1]] },
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
