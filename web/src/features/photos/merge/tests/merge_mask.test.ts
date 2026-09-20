import { expect, test } from 'bun:test';
import { fillLoops, swatchRegion, type MaskContext, type MaskStep } from '../merge_mask';

// jsdom has no 2D backend at all (`getContext('2d')` answers null), so what a mask *looks* like is
// Playwright's. What is answerable here is the order of the fills: every run of outlines is traced
// into one path and filled once, white where the layer takes it and black where it is covered.

const taken = (...loops: MaskStep['loop'][]): MaskStep[] => loops.map((loop) => ({ loop, taken: true }));
function recording(): { ctx: MaskContext; calls: string[] } {
  const calls: string[] = [];
  const ctx: MaskContext = {
    fillStyle: '',
    filter: '',
    clearRect: (x, y, w, h) => calls.push(`clear ${x},${y},${w},${h}`),
    // The style and the filter as they stand when each fill happens, which is what the two of them
    // are for: a background painted through the blur, or white painted without it, is no mask.
    fillRect: (x, y, w, h) => calls.push(`rect ${x},${y},${w},${h} ${String(ctx.fillStyle)} ${ctx.filter}`),
    beginPath: () => calls.push('begin'),
    moveTo: (x, y) => calls.push(`move ${x},${y}`),
    lineTo: (x, y) => calls.push(`line ${x},${y}`),
    closePath: () => calls.push('close'),
    fill: () => calls.push('fill'),
  };
  return { ctx, calls };
}

test('one loop is cleared, backed in black, traced and filled white', () => {
  const { ctx, calls } = recording();
  fillLoops(
    ctx,
    10,
    10,
    taken([
      [0, 0],
      [5, 0],
      [5, 5],
      [0, 5],
    ]),
  );
  expect(ctx.fillStyle).toBe('white');
  expect(ctx.filter).toBe('none');
  expect(calls).toEqual([
    'clear 0,0,10,10',
    'rect 0,0,10,10 black none',
    'begin',
    'move 0,0',
    'line 5,0',
    'line 5,5',
    'line 0,5',
    'close',
    'fill',
  ]);
});

// The bug this shape exists for, and it is invisible from inside the module: the mask lands in an
// `r8unorm` texture through `copyExternalImageToTexture`, whose default is *unpremultiplied*, so
// what crosses is the red channel and the alpha is dropped. Blurred over nothing, white stays white
// wherever it reaches and every tile arrives a blur radius too big with no blend at all - so the
// background has to be painted, and painted *before* the filter is set.
test('the background is opaque and unblurred, so the ramp is in the channel that crosses', () => {
  const { ctx, calls } = recording();
  fillLoops(
    ctx,
    8,
    8,
    taken([
      [0, 0],
      [4, 0],
      [4, 4],
    ]),
    6,
  );
  expect(calls).toContain('rect 0,0,8,8 black none');
  expect(ctx.filter).toBe('blur(3.00px)');
});

// §5.2's feather, and the whole of what makes the seam a blend rather than a step: the alpha ramps
// across the band, and `src + dst * (1 - a)` is then a cross-fade between the two frames over it.
// Half the width, because a blur reaches both ways from the edge it is given.
test('a feather is half its width of blur on the mask, and none at zero', () => {
  const square = taken([
    [0, 0],
    [5, 0],
    [5, 5],
  ]);
  const wide = recording();
  fillLoops(wide.ctx, 10, 10, square, 9);
  expect(wide.ctx.filter).toBe('blur(4.50px)');

  const none = recording();
  fillLoops(none.ctx, 10, 10, square, 0);
  expect(none.ctx.filter).toBe('none');
});

test('two loops share one path and one fill, so their union is what lands', () => {
  const { ctx, calls } = recording();
  fillLoops(
    ctx,
    4,
    4,
    taken(
      [
        [0, 0],
        [2, 0],
        [2, 4],
        [0, 4],
      ],
      [
        [2, 0],
        [4, 0],
        [4, 4],
        [2, 4],
      ],
    ),
  );
  expect(calls.filter((call) => call === 'begin')).toHaveLength(1);
  expect(calls.filter((call) => call === 'fill')).toHaveLength(1);
  expect(calls.filter((call) => call === 'close')).toHaveLength(2);
  expect(calls.at(-1)).toBe('fill');
});

// A piece of another frame inside this layer's own is drawn after it, and so is cut back out.
test('an outline covered by a later piece is filled black after the white under it', () => {
  const calls: string[] = [];
  const { ctx } = recording();
  ctx.fill = () => calls.push(`fill ${String(ctx.fillStyle)}`);
  fillLoops(ctx, 4, 4, [
    {
      loop: [
        [0, 0],
        [4, 0],
        [4, 4],
      ],
      taken: true,
    },
    {
      loop: [
        [1, 1],
        [2, 1],
        [2, 2],
      ],
      taken: false,
    },
  ]);
  expect(calls).toEqual(['fill white', 'fill black']);
});

/**
 * A swatch draws the tile's own box out of the layer, so the clip is the outline relative to that
 * box's corner, scaled with it. Left where it sits in the layer, it clips somewhere else.
 */
test('a tile fills the swatch box, drawn from its own box and clipped to its outline there', () => {
  const swatch = swatchRegion(
    [
      [200, 100],
      [400, 100],
      [300, 200],
    ],
    { width: 1000, height: 800 },
    100,
  );

  // 200 layer pixels across into a 100-pixel box: half size, the height following.
  expect(swatch.region).toEqual({ x: 200, y: 100, width: 200, height: 100 });
  expect([swatch.width, swatch.height]).toEqual([100, 50]);
  expect(swatch.clipPath).toBe('polygon(0.0px 0.0px, 100.0px 0.0px, 50.0px 50.0px)');
});

test('a tile running off the layer is drawn from the part of it that is there', () => {
  const swatch = swatchRegion(
    [
      [-10, 700],
      [120, 700],
      [120, 900],
    ],
    { width: 1000, height: 800 },
    100,
  );

  expect(swatch.region).toEqual({ x: 0, y: 700, width: 120, height: 100 });
});

test('an empty loop is skipped rather than moved to nowhere', () => {
  const { ctx, calls } = recording();
  fillLoops(ctx, 4, 4, taken([], [[1, 1]]));
  expect(calls.filter((call) => call.startsWith('move'))).toEqual(['move 1,1']);
});
