import { describe, expect, test } from 'bun:test';
import { applyHdrColour, applyHdrGeometry, TRUST_CEILING, type HdrColour } from '../hdr_match';
import type { DecodedImage } from '../raw_decoder';

const BINS = 256;

// Three deliberately divergent curves. The magenta bug was the three channels
// continuing past the fit domain at their own rates - measured end slopes of
// 0.435 / 0.206 / 0.336 - so a test of the highlight behaviour has to start from
// curves that would diverge if anything let them.
function profile(gains: [number, number, number], saturation = 1): HdrColour {
  const curves = gains.map((gain) => {
    const curve = new Float64Array(BINS);
    for (let b = 0; b < BINS; b += 1) curve[b] = (b / (BINS - 1)) * TRUST_CEILING * gain;
    return curve;
  }) as [Float64Array, Float64Array, Float64Array];
  return {
    curves,
    matrix: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    saturation,
    deltaE: 0,
  };
}

// A horizontal ramp with no wrap, so a value difference reads directly as a
// horizontal displacement rather than as an artefact of the pattern repeating.
function frame(width: number, height: number): DecodedImage {
  const data = Buffer.allocUnsafe(width * height * 3 * 2);
  const view = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 3; c += 1) view[(y * width + x) * 3 + c] = x * 500;
    }
  }
  return { width, height, channels: 3, depth: 16, data };
}

function sample(image: DecodedImage, x: number, y: number): number {
  const view = new Uint16Array(image.data.buffer, image.data.byteOffset, image.data.byteLength / 2);
  return view[(y * image.width + x) * 3]!;
}

// The colour was fitted from pairs that only correspond through the warp, so
// shipping one without the other gives a photo the camera's colour and LibRaw's
// shape. That is what happened: the geometry was used to build the fit and then
// never applied to the output, so the HDR rendition disagreed with its own SDR
// twin about where everything in the frame was.
describe('applyHdrGeometry', () => {
  const colour = { curves: [], matrix: [], saturation: 1, deltaE: 0 } as unknown as HdrColour;

  test('moves the pixels when the camera recorded a correction', () => {
    const image = frame(64, 48);
    const warped = applyHdrGeometry(image, { distortion: [0, 400], crop: 1.02, colour });
    expect(Buffer.compare(image.data, warped.data)).not.toBe(0);
    expect(warped.width).toBe(image.width);
    expect(warped.height).toBe(image.height);
  });

  // Even dimensions on purpose: at 65 wide the centre falls at 32.5, between
  // samples, so no pixel sits at radius zero and the claim would be about the
  // sampling grid rather than about the model.
  test('displaces nothing at the centre and most at the corner, as a radial model must', () => {
    const image = frame(64, 48);
    const warped = applyHdrGeometry(image, { distortion: [0, 400], crop: 1, colour });
    expect(sample(warped, 32, 24)).toBe(sample(image, 32, 24));
    expect(Math.abs(sample(warped, 2, 2) - sample(image, 2, 2))).toBeGreaterThan(0);
  });

  test('is the identity when nothing was recorded and nothing fitted', () => {
    const image = frame(32, 32);
    expect(applyHdrGeometry(image, { distortion: null, crop: 1, colour })).toBe(image);
  });
});

describe('applyHdrColour', () => {
  test('is the per-channel curves below diffuse white', () => {
    const colour = profile([0.5, 1, 2]);
    const [r, g, b] = applyHdrColour(colour, 0.4, 0.4, 0.4);
    expect(r).toBeCloseTo(0.2, 3);
    expect(g).toBeCloseTo(0.4, 3);
    expect(b).toBeCloseTo(0.8, 3);
  });

  // The property the shipped extrapolation exists for: above the ceiling a
  // brighter version of the same colour comes out brighter by the same factor,
  // rather than each channel drifting off on its own curve. Without it the sky
  // gained deltaA* +11.8 in the top L* band.
  test('scales proportionally above the ceiling, so highlights keep their colour', () => {
    const colour = profile([0.5, 1, 2]);
    const base = applyHdrColour(colour, TRUST_CEILING, TRUST_CEILING * 0.5, TRUST_CEILING * 0.25);
    for (const factor of [2, 4, 8]) {
      const scaled = applyHdrColour(
        colour,
        TRUST_CEILING * factor,
        TRUST_CEILING * 0.5 * factor,
        TRUST_CEILING * 0.25 * factor,
      );
      for (let c = 0; c < 3; c += 1) expect(scaled[c]!).toBeCloseTo(base[c]! * factor, 6);
    }
  });

  // Either side of the branch, not either side of a step: the input has to move
  // by far less than the tolerance or the test measures its own step size. At
  // 0.999 and 1.001 of the ceiling the two answers differ by 0.2% because the
  // *inputs* do, which says nothing about the seam.
  test('is continuous across the ceiling', () => {
    const colour = profile([0.5, 1, 2]);
    const eps = 1e-9;
    const below = applyHdrColour(colour, TRUST_CEILING - eps, TRUST_CEILING * 0.5, TRUST_CEILING * 0.25);
    const above = applyHdrColour(colour, TRUST_CEILING + eps, TRUST_CEILING * 0.5, TRUST_CEILING * 0.25);
    for (let c = 0; c < 3; c += 1) expect(above[c]!).toBeCloseTo(below[c]!, 6);
  });

  test('the saturation blend moves chroma without moving brightness', () => {
    const plain = applyHdrColour(profile([1, 1, 1]), 0.6, 0.3, 0.1);
    const damped = applyHdrColour(profile([1, 1, 1], 0.5), 0.6, 0.3, 0.1);
    const luma = (v: [number, number, number]) => 0.2627 * v[0] + 0.678 * v[1] + 0.0593 * v[2];
    expect(luma(damped)).toBeCloseTo(luma(plain), 6);
    const spread = (v: [number, number, number]) => Math.max(...v) - Math.min(...v);
    expect(spread(damped)).toBeCloseTo(spread(plain) * 0.5, 6);
  });
});
