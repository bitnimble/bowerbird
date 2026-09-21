// The zoom's detail decode against the stage's own, with the browser's decoders stood in for.
// No WebCodecs here, so every decode is `createImageBitmap`, which honours the size it is asked
// for the way a camera JPEG's decoder does.
import { afterAll, beforeAll, expect, jest, test } from 'bun:test';

const FILE = { width: 9504, height: 6336 };
const decodes: { resizeWidth?: number }[] = [];

const saved = {
  fetch: globalThis.fetch,
  Image: (globalThis as { Image?: unknown }).Image,
  createImageBitmap: (globalThis as { createImageBitmap?: unknown }).createImageBitmap,
};

beforeAll(() => {
  globalThis.fetch = (async () => new Response(new Blob(['jpeg'], { type: 'image/jpeg' }))) as unknown as typeof fetch;
  Object.assign(globalThis, {
    Image: class {
      naturalWidth = 0;
      naturalHeight = 0;
      onload: (() => void) | null = null;
      set src(_: string) {
        queueMicrotask(() => {
          this.naturalWidth = FILE.width;
          this.naturalHeight = FILE.height;
          this.onload?.();
        });
      }
    },
    createImageBitmap: async (_: Blob, options: { resizeWidth?: number }) => {
      decodes.push(options);
      const width = options.resizeWidth ?? FILE.width;
      return { width, height: Math.round((width * FILE.height) / FILE.width), close: () => undefined };
    },
  });
});

afterAll(() => {
  globalThis.fetch = saved.fetch;
  Object.assign(globalThis, { Image: saved.Image, createImageBitmap: saved.createImageBitmap });
});

// By a specifier of its own: `stage_frames.ts` replaces `../stage_bitmaps` in the registry every
// test file shares, and whichever file runs first decides which one a bare import gets.
const real: string = '../stage_bitmaps.ts?real';
const { decodeDetail, decodeFrame, keepOnly, releaseHolder }: typeof import('../stage_bitmaps') = await import(real);

test('a prefetched frame identifies its request as background work', async () => {
  const fetching = jest.spyOn(globalThis, 'fetch');
  try {
    await decodeFrame('/image/prefetch/renditions/full', false, 'background');
    expect(new Headers(fetching.mock.calls[0]?.[1]?.headers).get('x-bowerbird-activity')).toBe('background');
  } finally { fetching.mockRestore(); decodes.length = 0; }
});

test('a camera JPEG decoded whole for the zoom is decoded once while its photograph is open', async () => {
  const jpeg = '/image/p1/renditions/embedded';
  const render = '/image/p1/renditions/max';
  keepOnly('stage', [jpeg, render], [jpeg, render]);
  expect((await decodeFrame(jpeg)).width).toBe(4096);

  const whole = await decodeDetail(jpeg);
  expect(whole.width).toBe(FILE.width);
  // Flipped to the render and back: the stage still holds both, so the same frame answers.
  expect(await decodeDetail(jpeg)).toBe(whole);
  expect(decodes.map((each) => each.resizeWidth ?? 'whole')).toEqual([4096, 'whole']);

  // Stepped to the next photograph, which leaves this one a neighbour and nothing to zoom into.
  keepOnly('stage', [jpeg], []);
  expect(whole.closed).toBe(true);
  releaseHolder('stage');
});
