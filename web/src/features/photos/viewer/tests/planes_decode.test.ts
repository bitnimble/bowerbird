// Safari's decode of a PQ AVIF: no WebCodecs, so its planes come from our own decoder.
import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import type { PlanarPicture } from '../../../../avif/avif_planes';

const TEXTURE_EDGE = 16384;
let file = { width: 0, height: 0 };
const planes: PlanarPicture = {
  samples: new Uint8Array(0),
  layout: { width: 0, height: 0, bits: 10, subsampled: true, planes: [] },
};
const bitmaps: unknown[] = [];

void mock.module('../../../../avif/avif_planes', () => ({
  canDecodeAvifPlanes: () => true,
  decodeAvifPlanes: async () => planes,
}));

const saved = {
  fetch: globalThis.fetch,
  Image: (globalThis as { Image?: unknown }).Image,
  createImageBitmap: (globalThis as { createImageBitmap?: unknown }).createImageBitmap,
  gpu: Object.getOwnPropertyDescriptor(navigator, 'gpu'),
};

beforeAll(() => {
  globalThis.fetch = (async () =>
    new Response(new Blob(['avif'], { type: 'image/avif' }))) as unknown as typeof fetch;
  Object.defineProperty(navigator, 'gpu', {
    value: {
      requestAdapter: async () => ({ limits: { maxTextureDimension2D: TEXTURE_EDGE } }),
    },
    configurable: true,
  });
  Object.assign(globalThis, {
    Image: class {
      naturalWidth = 0;
      naturalHeight = 0;
      onload: (() => void) | null = null;
      set src(_: string) {
        queueMicrotask(() => {
          this.naturalWidth = file.width;
          this.naturalHeight = file.height;
          this.onload?.();
        });
      }
    },
    createImageBitmap: async (...args: unknown[]) => {
      bitmaps.push(args);
      return { width: file.width, height: file.height, close: () => undefined };
    },
  });
});

beforeEach(() => {
  bitmaps.length = 0;
});

afterAll(() => {
  globalThis.fetch = saved.fetch;
  if (saved.gpu == null) Reflect.deleteProperty(navigator, 'gpu');
  else Object.defineProperty(navigator, 'gpu', saved.gpu);
  Object.assign(globalThis, { Image: saved.Image, createImageBitmap: saved.createImageBitmap });
});

// By a specifier of its own, as in `detail_decode.test.ts`, and not that file's: this one's
// `avif_planes` is mocked.
const real: string = '../stage_bitmaps.ts?planes';
const { decodeFrame, releaseHolder, keepOnly }: typeof import('../stage_bitmaps') = await import(
  real
);

test('a native-resolution 61MP rendition is decoded as planes, not tone mapped to a bitmap', async () => {
  file = { width: 9504, height: 6336 };
  const source = '/image/p1/renditions/max';
  keepOnly('stage', [source]);
  const frame = await decodeFrame(source);
  expect(frame.picture).toBe(planes);
  expect(frame.flat).toBeInstanceOf(Blob);
  expect(bitmaps).toHaveLength(0);
  releaseHolder('stage');
});

test('a panorama past the texture limit is decoded as a bitmap, not as planes nothing can draw', async () => {
  file = { width: 33804, height: 4000 };
  const source = '/image/p2/renditions/max';
  keepOnly('stage', [source]);
  const frame = await decodeFrame(source);
  expect(frame.picture).not.toBe(planes);
  expect(bitmaps).toHaveLength(1);
  releaseHolder('stage');
});
