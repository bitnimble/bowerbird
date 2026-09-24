// Which frames reach the shader that keeps an HDR rendition's headroom, on what scale, and with
// how much chroma.
//
// A silent failure every way, which is why it is pinned. Refusing a frame that should have
// been drawn as planes sends it to the import, which tone maps it; accepting one at the wrong
// scale hands the shader samples four times too large and blows the picture to white; reading a
// full-chroma frame at half its chroma shows the top-left quarter's colour over the whole of it.
import { expect, test } from 'bun:test';
import { planarLayout } from '../planar_layout';
import { storedRegion } from '../stage_gpu';

function frame(over: Partial<Record<string, unknown>> = {}): VideoFrame {
  return {
    format: 'I420P12',
    codedWidth: 2560,
    codedHeight: 3840,
    displayWidth: 2560,
    displayHeight: 3840,
    colorSpace: { transfer: 'pq', fullRange: false },
    ...over,
  } as unknown as VideoFrame;
}

test('a twelve-bit rendition is drawn as planes, scaled onto the ten-bit ranges', () => {
  expect(planarLayout(frame())).toEqual({ depth: 4, chroma: 0.5 });
});

// The depth a library holds from before `AVIF_DEPTH` moved, which still has to draw.
test('a ten-bit rendition is drawn as planes, unscaled', () => {
  expect(planarLayout(frame({ format: 'I420P10' }))).toEqual({ depth: 1, chroma: 0.5 });
});

// What a still with a measured chroma leak is written as, and the one the import was flattening.
test.each([
  ['twelve-bit', 'I444P12', 4],
  ['ten-bit', 'I444P10', 1],
])('a %s full-chroma rendition is drawn as planes at full chroma', (_name, format, depth) => {
  expect(planarLayout(frame({ format }))).toEqual({ depth, chroma: 1 });
});

test.each([
  ['eight-bit', { format: 'I420' }],
  ['full-range', { colorSpace: { transfer: 'pq', fullRange: true } }],
  ['not PQ', { colorSpace: { transfer: 'srgb', fullRange: false } }],
  // A camera JPEG the body turned: a region would be read against the stored pixels rather
  // than the shown ones, so it takes the import, which samples in displayed space.
  ['turned', { codedWidth: 3840, codedHeight: 2560 }],
])('%s takes the import instead', (_name, over) => {
  expect(planarLayout(frame(over))).toBeNull();
});

test('rotated HDR rendition keeps planar path and reads corresponding stored region', () => {
  const portrait = frame({ codedWidth: 100, codedHeight: 80, displayWidth: 80, displayHeight: 100 });
  expect(planarLayout(portrait, 90)).toEqual({ depth: 4, chroma: 0.5 });
  expect(planarLayout(portrait, 0)).toBeNull();

  const region = { x: 10, y: 20, width: 30, height: 40 };
  expect(storedRegion(region, 90, 100, 80)).toEqual({ x: 20, y: 40, width: 40, height: 30 });
  expect(storedRegion(region, 180, 100, 80)).toEqual({ x: 60, y: 20, width: 30, height: 40 });
  expect(storedRegion(region, 270, 100, 80)).toEqual({ x: 40, y: 10, width: 40, height: 30 });
});
