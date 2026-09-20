// The mask a masked draw samples as alpha: white where a source's tiles are, black elsewhere,
// rasterised in 2D - fine for a mask, where it would not be for the picture itself.

/** What `fillLoops` needs of a 2D context, which is what lets it be driven without a backend. */
export interface MaskContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  filter: string;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
}

/** One outline of a layer's mask, and whether the layer takes it or a piece of another covers it. */
export interface MaskStep {
  loop: readonly (readonly [number, number])[];
  taken: boolean;
}

/**
 * Every outline in painter's order - white where the layer takes it, black where another layer's
 * piece covers it - with `feather` canvas pixels of ramp at every edge.
 *
 * **In order, because pieces nest.** A solved piece is an outer loop drawn over whatever it
 * encloses, and the render gives a pixel to the last piece over it; a union of one source's loops
 * would paint over the pieces of other frames inside them. A run of steps with the same answer is
 * one path and one fill, `fill()`'s nonzero rule unioning its loops.
 *
 * **White on opaque black, not white on nothing, and the feather is the whole reason.** The texture
 * this lands in is `r8unorm` and `copyExternalImageToTexture` defaults to *unpremultiplied*, so what
 * crosses is the red channel as drawn and the alpha is thrown away. Over a transparent background a
 * blurred white fill is still white everywhere it reaches - the ramp is entirely in the alpha - so
 * the mask arrives as a hard edge *grown by the blur radius*: every tile a little bigger than its
 * own polygon, and no blend anywhere. Painting the background instead puts the ramp in the channel
 * that is actually read.
 */
export function fillLoops(
  ctx: MaskContext,
  width: number,
  height: number,
  steps: readonly MaskStep[],
  feather = 0,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.filter = 'none';
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, width, height);
  // Half, because a blur reaches both ways: a feather of `w` is `w` of ramp in total, so the seam
  // keeps `w / 2` either side of where the cut put it.
  ctx.filter = feather > 0 ? `blur(${(feather / 2).toFixed(2)}px)` : 'none';
  let at = 0;
  while (at < steps.length) {
    const taken = steps[at]!.taken;
    ctx.fillStyle = taken ? 'white' : 'black';
    ctx.beginPath();
    for (; at < steps.length && steps[at]!.taken === taken; at++) {
      const [first, ...rest] = steps[at]!.loop;
      if (first == null) continue;
      ctx.moveTo(first[0], first[1]);
      for (const [x, y] of rest) ctx.lineTo(x, y);
      ctx.closePath();
    }
    ctx.fill();
  }
}

/**
 * The part of a decoded layer one tile's swatch is drawn from, the size it is drawn at to fit a
 * `box`-sided swatch, and the tile's outline as a clip in those same pixels (§2.3).
 *
 * **Drawn from the frame the page already decoded**, never from the layer's file, which would
 * decode the whole HDR layer again for every swatch of every opened tile.
 *
 * `loop` and `frame` are the decoded layer's pixels; `box` is the swatch's, in CSS pixels.
 */
export function swatchRegion(
  loop: readonly (readonly [number, number])[],
  frame: { width: number; height: number },
  box: number,
): { region: { x: number; y: number; width: number; height: number }; width: number; height: number; clipPath: string } {
  const xs = loop.map(([x]) => x);
  const ys = loop.map(([, y]) => y);
  const x = Math.max(0, Math.floor(Math.min(...xs)));
  const y = Math.max(0, Math.floor(Math.min(...ys)));
  const across = Math.max(1, Math.min(frame.width, Math.ceil(Math.max(...xs))) - x);
  const down = Math.max(1, Math.min(frame.height, Math.ceil(Math.max(...ys))) - y);
  const scale = box / Math.max(across, down);
  const at = ([px, py]: readonly [number, number]): string =>
    `${((px - x) * scale).toFixed(1)}px ${((py - y) * scale).toFixed(1)}px`;
  return {
    region: { x, y, width: across, height: down },
    width: across * scale,
    height: down * scale,
    clipPath: `polygon(${loop.map(at).join(', ')})`,
  };
}

/** `steps` are already in the canvas's own pixels - `MergeStore.layerScale`, applied by the caller. */
export function rasteriseMask(
  width: number,
  height: number,
  steps: readonly MaskStep[],
  feather = 0,
): OffscreenCanvas | HTMLCanvasElement {
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas === 'function') {
    canvas = new OffscreenCanvas(width, height);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d') as MaskContext | null;
  if (ctx != null) fillLoops(ctx, width, height, steps, feather);
  return canvas;
}
