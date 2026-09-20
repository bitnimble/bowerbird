import { expect, test } from 'bun:test';
import { onChromaGrid } from '../stage_gpu';

const FRAME = { x: 0, y: 0, width: 3949, height: 2646 };

// `copyTo` throws on a rect between two chroma samples, which a swatch over a grown piece
// starting at an odd pixel asked for - and the draw then silently kept the previous picture.
test('a region on a 4:2:0 frame grows outward to even coordinates', () => {
  expect(onChromaGrid({ x: 425, y: 911, width: 841, height: 685 }, 0.5, FRAME)).toEqual({
    x: 424,
    y: 910,
    width: 842,
    height: 686,
  });
});

test('it stops at the frame, and a 4:4:4 region is left alone', () => {
  expect(onChromaGrid({ x: 3900, y: 0, width: 49, height: 10 }, 0.5, FRAME)).toEqual({
    x: 3900,
    y: 0,
    width: 49,
    height: 10,
  });
  const region = { x: 425, y: 911, width: 841, height: 685 };
  expect(onChromaGrid(region, 1, FRAME)).toEqual(region);
});
