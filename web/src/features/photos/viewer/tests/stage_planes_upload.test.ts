import { expect, test } from 'bun:test';
import type { PlanarPicture } from '../../../../avif/avif_planes';
import { planesFrom } from '../stage_gpu';

Object.defineProperty(globalThis, 'GPUTextureUsage', {
  value: { TEXTURE_BINDING: 0x4, COPY_DST: 0x2 },
  configurable: true,
});

// Planes the page decoded itself are uploaded by offset into shared memory rather than copied out,
// so the region's first sample and its row length are arithmetic nothing else checks: one plane
// off and the picture is another plane's samples, which draws without a single error.
test('a region of 4:2:0 planes uploads exactly its own samples, luma and chroma alike', () => {
  const [width, height] = [6, 4];
  const [chromaWidth, chromaHeight] = [3, 2];
  const sample = (plane: number, x: number, y: number): number => plane * 1000 + y * 100 + x;
  const planes = [
    { width, height },
    { width: chromaWidth, height: chromaHeight },
    { width: chromaWidth, height: chromaHeight },
  ];
  // Offset inside its buffer, as a view of shared memory need not start at zero.
  const lead = 8;
  const values: number[] = [];
  const layout = planes.map((plane, at) => {
    const offset = values.length * 2;
    for (let y = 0; y < plane.height; y++) for (let x = 0; x < plane.width; x++) values.push(sample(at, x, y));
    return { offset, stride: plane.width * 2 };
  });
  const buffer = new ArrayBuffer(lead + values.length * 2);
  new Uint16Array(buffer, lead).set(values);
  const picture: PlanarPicture = {
    samples: new Uint8Array(buffer, lead),
    layout: { width, height, bits: 12, subsampled: true, planes: layout },
  };

  type Size = { width: number; height: number };
  const written: { data: ArrayBufferLike; layout: GPUTexelCopyBufferLayout; size: Size }[] = [];
  const device = {
    createTexture: () => ({}),
    queue: {
      writeTexture: (_: unknown, data: ArrayBufferLike, dataLayout: GPUTexelCopyBufferLayout, size: Size) =>
        written.push({ data, layout: dataLayout, size }),
    },
  } as unknown as GPUDevice;

  const region = { x: 2, y: 2, width: 4, height: 2 };
  planesFrom(device, picture, region, 0.5);

  expect(written.map((each) => each.size)).toEqual([
    { width: 4, height: 2 },
    { width: 2, height: 1 },
    { width: 2, height: 1 },
  ]);
  written.forEach(({ data, layout: copy, size }, plane) => {
    const scale = plane === 0 ? 1 : 0.5;
    const { width: columns, height: rows } = size;
    const view = new DataView(data);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const at = (copy.offset ?? 0) + row * (copy.bytesPerRow ?? 0) + column * 2;
        expect(view.getUint16(at, true)).toBe(sample(plane, region.x * scale + column, region.y * scale + row));
      }
    }
  });
});
