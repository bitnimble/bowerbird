import { describe, expect, test } from 'bun:test';
import { polynomialKnots, readDistortionSpline, sampleRadius, SPLINE_UNIT } from '../lens_corrections';

const TYPE_SSHORT = 8;
const TYPE_LONG = 4;

interface TagSpec {
  tag: number;
  type: number;
  values: number[];
}

/**
 * A minimal little-endian TIFF: IFD0 carries a SubIFD pointer, and the SubIFD
 * carries `tags`. Enough structure to exercise the reader's real path without
 * needing a 70MB ARW.
 */
function tiff(tags: TagSpec[]): Uint8Array {
  const HEADER = 8;
  const ifd0Entries = 1;
  const ifd0 = HEADER;
  const ifd0Size = 2 + ifd0Entries * 12 + 4;
  // A single SubIFD offset is four bytes, so it lives in the entry itself rather
  // than being pointed at - the same rule every other short TIFF value follows.
  const subIfd = ifd0 + ifd0Size;
  const subIfdSize = 2 + tags.length * 12 + 4;
  let heap = subIfd + subIfdSize;

  const layout = tags.map((spec) => {
    const size = spec.values.length * 2;
    const inline = size <= 4;
    const start = inline ? 0 : heap;
    if (!inline) heap += size;
    return { spec, inline, start };
  });

  const bytes = new Uint8Array(heap);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifd0, true);

  view.setUint16(ifd0, ifd0Entries, true);
  view.setUint16(ifd0 + 2, 0x014a, true);
  view.setUint16(ifd0 + 4, TYPE_LONG, true);
  view.setUint32(ifd0 + 6, 1, true);
  view.setUint32(ifd0 + 10, subIfd, true);
  view.setUint32(ifd0 + 2 + 12, 0, true);

  view.setUint16(subIfd, tags.length, true);
  layout.forEach(({ spec, inline, start }, index) => {
    const at = subIfd + 2 + index * 12;
    view.setUint16(at, spec.tag, true);
    view.setUint16(at + 2, spec.type, true);
    view.setUint32(at + 4, spec.values.length, true);
    if (inline) {
      spec.values.forEach((value, i) => view.setInt16(at + 8 + i * 2, value, true));
    } else {
      view.setUint32(at + 8, start, true);
      spec.values.forEach((value, i) => view.setInt16(start + i * 2, value, true));
    }
  });
  view.setUint32(subIfd + 2 + tags.length * 12, 0, true);
  return bytes;
}

/** Length-prefixed, the way the camera writes it. */
function spline(knots: number[]): number[] {
  return [knots.length, ...knots];
}

describe('readDistortionSpline', () => {
  test('reads the knots the camera recorded', () => {
    const knots = [-2, 2, 11, 25, 47, 74, 106, 147, 194, 248, 309, 377, 455, 541, 636, 740];
    expect(readDistortionSpline(tiff([{ tag: 0x7037, type: TYPE_SSHORT, values: spline(knots) }]))).toEqual(knots);
  });

  test('honours the declared count rather than assuming 16', () => {
    // The ILCE-6300 writes 11 knots and the ILCE-7CR writes 16, so a hardcoded
    // length would read a body's neighbouring data as distortion.
    const knots = [-1, -1, -2, -4, -7, -12, -17, -23, -31, -39, -47];
    const values = [...spline(knots), 999, 999, 999, 999, 999];
    expect(readDistortionSpline(tiff([{ tag: 0x7037, type: TYPE_SSHORT, values }]))).toEqual(knots);
  });

  test('is null when the body recorded no correction', () => {
    // 14 of 20 Sony bodies measured are in this position, so it is the common
    // case, not an error.
    expect(readDistortionSpline(tiff([{ tag: 0x7032, type: TYPE_SSHORT, values: spline([0, 64, 160]) }]))).toBeNull();
  });

  test('rejects an implausible correction rather than returning garbage', () => {
    // A misparse looks like a huge displacement. The largest real one measured is
    // the RX100M3's -10.5%.
    const absurd = spline(Array.from({ length: 16 }, (_, i) => i * 2000));
    expect(readDistortionSpline(tiff([{ tag: 0x7037, type: TYPE_SSHORT, values: absurd }]))).toBeNull();
  });

  test('rejects a count that does not fit the tag', () => {
    const values = [16, 1, 2, 3];
    expect(readDistortionSpline(tiff([{ tag: 0x7037, type: TYPE_SSHORT, values }]))).toBeNull();
  });

  test('is null on bytes that are not TIFF', () => {
    expect(readDistortionSpline(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
    expect(readDistortionSpline(new Uint8Array(2))).toBeNull();
  });
});

describe('sampleRadius', () => {
  test('leaves the centre alone and scales the corner by the last knot', () => {
    const knots = [0, 0, 0, SPLINE_UNIT / 10];
    expect(sampleRadius(knots, 0, 1)).toBeCloseTo(0, 6);
    expect(sampleRadius(knots, 1, 1)).toBeCloseTo(1.1, 6);
  });

  test('applies the crop on top of the spline', () => {
    // The spline is anchored at the centre and carries no rescale, so the crop is
    // what stops a pincushion correction sampling outside the frame.
    const knots = [0, 0, 0, SPLINE_UNIT * 0.0452];
    expect(sampleRadius(knots, 1, 0.9568)).toBeCloseTo(0.9568 * 1.0452, 4);
  });

  test('interpolates between knots', () => {
    const knots = [0, SPLINE_UNIT];
    expect(sampleRadius(knots, 0.5, 1)).toBeCloseTo(0.5 * 1.5, 6);
  });

  test('is the identity scaled by the crop when there are no knots', () => {
    expect(sampleRadius([], 0.7, 0.98)).toBeCloseTo(0.7 * 0.98, 6);
  });
});

describe('polynomialKnots', () => {
  test('encodes a radial polynomial in the same units as a camera spline', () => {
    const knots = polynomialKnots(0.045, 0);
    expect(knots[0]).toBe(0);
    expect(knots[knots.length - 1]! / SPLINE_UNIT).toBeCloseTo(0.045, 4);
  });

  test('round-trips through sampleRadius', () => {
    const k1 = -0.0275;
    const knots = polynomialKnots(k1, 0, 64);
    // The fitted fallback and the camera's spline have to be interchangeable
    // downstream, so a polynomial expressed as knots must behave like the
    // polynomial it came from.
    expect(sampleRadius(knots, 1, 1)).toBeCloseTo(1 + k1, 3);
    expect(sampleRadius(knots, 0.5, 1)).toBeCloseTo(0.5 * (1 + k1 * 0.25), 3);
  });
});
