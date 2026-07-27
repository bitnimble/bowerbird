import { describe, expect, test } from 'bun:test';
import type { DecodedImage } from '../raw_decoder';
import { grade } from '../tone_map';

const MAX = 65535;
const OPTIONS = { referenceWhiteNits: 203, peakNits: 1000, whiteQuantile: 0.99 };

// A ramp from black to `top`, which puts its 99th percentile just under `top`
// and its peak at it - a stand-in for a scene with a diffuse-white subject and a
// little specular above it.
function ramp(top: number, pixels = 4000): DecodedImage {
  const samples = new Uint16Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    const value = Math.round((i / (pixels - 1)) * top);
    samples[i * 3] = value;
    samples[i * 3 + 1] = value;
    samples[i * 3 + 2] = value;
  }
  const data = Buffer.from(samples.buffer);
  return { width: pixels, height: 1, channels: 3, depth: 16, data };
}

function read(image: DecodedImage): Uint16Array {
  return new Uint16Array(image.data.buffer, image.data.byteOffset, image.data.byteLength / 2);
}

describe('grade', () => {
  test('puts diffuse white at the reference, whatever the exposure', () => {
    // The same scene metered two stops apart. Both should render at the same
    // brightness, which is the whole point of anchoring rather than tying full
    // range to the display peak.
    const bright = read(grade(ramp(MAX), OPTIONS));
    const dark = read(grade(ramp(Math.round(MAX / 4)), OPTIONS));

    const white = Math.round((203 / 1000) * MAX);
    // The 99th percentile sample, which is what the anchor is measured on.
    const at99 = Math.floor(4000 * 0.99) * 3;
    expect(bright[at99]!).toBeCloseTo(white, -3);
    expect(dark[at99]!).toBeCloseTo(white, -3);
  });

  test('is linear below diffuse white', () => {
    const out = read(grade(ramp(MAX), OPTIONS));
    // Half the exposure of the 99th-percentile sample, so well under the knee.
    const half = Math.floor(4000 * 0.495) * 3;
    const at99 = Math.floor(4000 * 0.99) * 3;
    expect(out[half]! / out[at99]!).toBeCloseTo(0.5, 2);
  });

  test('rolls the highlights into the peak rather than clipping them', () => {
    // Four stops of specular above diffuse white: at 0.99 the anchor lands near
    // the top of the ramp, so nothing here reaches it. Build one that does.
    const pixels = 4000;
    const samples = new Uint16Array(pixels * 3);
    for (let i = 0; i < pixels; i += 1) {
      // 99% of the frame at a quarter range, the last 1% far above it.
      const value = i < pixels * 0.99 ? Math.round(((i / (pixels * 0.99)) * MAX) / 4) : MAX;
      samples[i * 3] = value;
      samples[i * 3 + 1] = value;
      samples[i * 3 + 2] = value;
    }
    const out = read(grade({ width: pixels, height: 1, channels: 3, depth: 16, data: Buffer.from(samples.buffer) }, OPTIONS));

    const brightest = out[(pixels - 1) * 3]!;
    // Compressed into the range rather than run past it...
    expect(brightest).toBeLessThanOrEqual(MAX);
    // ...but still distinguishable from diffuse white, which clipping would not be.
    expect(brightest).toBeGreaterThan(Math.round((203 / 1000) * MAX));
  });

  test('leaves the SDR reference with diffuse white at display white', () => {
    // Reference and peak equal is how the SDR control is graded.
    const out = read(grade(ramp(MAX), { ...OPTIONS, peakNits: 203 }));
    const at99 = Math.floor(4000 * 0.99) * 3;
    expect(out[at99]!).toBeCloseTo(MAX, -3);
  });

  test('leaves a black frame alone rather than dividing by zero', () => {
    const black = ramp(0);
    expect(grade(black, OPTIONS).data).toBe(black.data);
  });
});
