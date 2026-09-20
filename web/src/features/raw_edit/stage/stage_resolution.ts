// What the page still decides about the picture, now that the module draws it.
//
// The tick is `rawshim`'s: it holds the frame, builds the uniform and draws onto the canvas this
// thread hands it (`wasm.rs`). Two things cannot move there, because both are the *page's* to
// know - the header the open answers with, which is what the panel reads, and how large a backing
// store the reader's box is worth, which needs a layout box and a device pixel ratio.

import type { Region } from '../edits';

/**
 * Canvas pixels per device pixel.
 *
 * The draw point-samples the region it shows, and a photograph's edges are exactly where
 * that reads as a jagged line rather than a soft one. Rendering half again as wide and
 * letting the compositor's own downscale do the smoothing is the cheap version of an
 * antialiased draw, and it is cheap because the cost is per canvas pixel: 1.5 costs 2.25x a
 * pass that does not scale with the frame at all.
 */
export const SUPERSAMPLE = 1.5;

/**
 * The backing store to give the canvas, for a CSS box and the region it is showing.
 *
 * The shape is the region's, not the box's. The element is laid out `object-fit: contain`
 * and the draw fills whatever canvas it is given, so a backing store of a different aspect
 * ratio is a stretched photograph. Fitting here rather than letterboxing in the shader
 * also means no canvas pixel is ever drawn and then thrown away.
 *
 * Then the two multipliers and the two clamps. `devicePixelRatio` is how many device
 * pixels a CSS pixel is, so without it a Retina panel shows a half-resolution picture, and
 * `SUPERSAMPLE` is on top of that. The clamps stop them compounding into nonsense: there is
 * nothing to supersample once the region is being magnified, since the frame has no detail
 * above 1:1 to resolve, and past `maxTextureDimension2D` there is no canvas.
 *
 * **The floor of one device pixel per canvas pixel is what keeps a magnified sky smooth.**
 * Clamped at the region's own resolution instead, a zoomed-in draw hands the compositor a
 * canvas a fraction of the box - eight times under it per axis at 4x on a 2x panel - and its
 * upscale filter runs over the extended-range values on the way to the display. That averages
 * away the per-pixel variation dithering the panel's own quantisation, and a gradient lands on
 * flat plateaus. Magnifying here instead costs no more than the zoomed-out draw already pays,
 * and `covered`'s point sample is what the reader wants of a magnifier anyway.
 *
 * **All of it is one scale, applied to both axes.** Clamped per axis instead, a limit that
 * binds on the long edge alone leaves the short one where it was, and the backing store stops
 * being the region's shape - which is the one thing this function is for. A 61MP frame on an
 * adapter capped at 8192 is exactly that case: 9504 clamps and 6336 does not, and the
 * photograph came out sixteen percent tall.
 *
 * The size is asked for here and applied in the worker: the canvas belongs to the module once it
 * has been transferred, so its width and height are the surface's configuration rather than
 * properties this thread can assign.
 */
export function stageResolution(
  css: { width: number; height: number },
  region: Region,
  maxTexture: number,
): { width: number; height: number } {
  const dpr = globalThis.devicePixelRatio || 1;
  const contain = Math.min(css.width / region.width, css.height / region.height);
  const scale = Math.min(
    contain * dpr * SUPERSAMPLE,
    Math.max(contain * dpr, 1),
    maxTexture / region.width,
    maxTexture / region.height,
  );
  return {
    width: Math.max(1, Math.round(region.width * scale)),
    height: Math.max(1, Math.round(region.height * scale)),
  };
}
