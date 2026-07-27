import { describe, expect, test } from 'bun:test';
import { resizeRgb, type DecodedImage } from '../raw_decoder';

function image(width: number, height: number, fill: (x: number, y: number, c: number) => number): DecodedImage {
  const data = Buffer.allocUnsafe(width * height * 3 * 2);
  const view = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 3; c += 1) view[(y * width + x) * 3 + c] = fill(x, y, c);
    }
  }
  return { width, height, channels: 3, depth: 16, data };
}

function at(img: DecodedImage, x: number, y: number, c: number): number {
  const view = new Uint16Array(img.data.buffer, img.data.byteOffset, img.data.byteLength / 2);
  return view[(y * img.width + x) * 3 + c]!;
}

describe('resizeRgb', () => {
  test('averages the block each output pixel covers', () => {
    // 4x4 of distinct values; halving means each output is the mean of a 2x2.
    const src = image(4, 4, (x, y) => (y * 4 + x) * 1000);
    const out = resizeRgb(src, 2, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    // Top-left block covers 0, 1000, 4000, 5000.
    expect(at(out, 0, 0, 0)).toBe(2500);
    // Bottom-right covers 10000, 11000, 14000, 15000.
    expect(at(out, 1, 1, 0)).toBe(12500);
  });

  test('keeps a flat field flat, so a downscale cannot shift exposure', () => {
    const src = image(64, 40, () => 30000);
    const out = resizeRgb(src, 9, 6);
    const view = new Uint16Array(out.data.buffer, out.data.byteOffset, out.data.byteLength / 2);
    for (const v of view) expect(v).toBe(30000);
  });

  test('returns the image untouched rather than enlarging it', () => {
    const src = image(8, 8, () => 1234);
    expect(resizeRgb(src, 16, 16)).toBe(src);
    expect(resizeRgb(src, 8, 8)).toBe(src);
  });

  test('handles 8-bit as well, since the same helper serves both depths', () => {
    const data = Buffer.alloc(4 * 4 * 3, 200);
    const src: DecodedImage = { width: 4, height: 4, channels: 3, depth: 8, data };
    const out = resizeRgb(src, 2, 2);
    expect(out.depth).toBe(8);
    expect(out.data.length).toBe(2 * 2 * 3);
    for (const v of out.data) expect(v).toBe(200);
  });
});
