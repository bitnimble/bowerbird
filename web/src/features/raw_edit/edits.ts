// What a tick tells the module: the window to draw and the reader's document over it.
//
// The shapes only, because the rules are the module's - what a stop means, which uniform slot a
// slider lands in, what a null half of the balance does. These cross as JSON and are read by
// `gpu::Region`, `gpu::Adjust` and `image::Geometry`, so a name that drifts is `missing field` at
// the first tick: a black stage and a `failed` panel. `tests/module_json.test.ts` is the pin.

import { z } from 'zod';
import type { ColourProfile, ToneCurve } from '../../../../src/schemas/photo_edits';
import { RenderingIntentSchema } from '../../../../src/schemas/rendering_intent';

/** The window on the output a tick draws, in output pixels: what pan and zoom move. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Every slider, on Camera Raw's own scales, as the document holds them - `gpu::Adjust`.
 *
 * A null white balance half is resolved by `white_balance.slang`. A null tone curve or saturation
 * uses the camera match's.
 */
export interface EditAdjust {
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  toneCurve: ToneCurve | null;
  vibrance: number;
  saturation: number | null;
  texture: number;
  clarity: number;
  dehaze: number;
  temperature: number | null;
  tint: number | null;
  colourProfile: ColourProfile;
}

/**
 * The reader's crop, straighten and turn - `image::Geometry`, field for field.
 *
 * The picture they produce is *not* here, and that is the point: the module works the output's
 * size out from these (`hdr::cropped_size`), so a shape sent alongside them would be a second
 * answer to a question the shader has already indexed its output grid by. The page reads its own
 * through `displaySize`, which is the server's function rather than a copy of it.
 */
export interface EditGeometry {
  /** Left, top, right, bottom, as fractions of the straightened frame. */
  crop: [number, number, number, number];
  angleDegrees: number;
  rotate: number;
  /** The perspective correction, or null where nobody corrected one. Eight, row-major. */
  keystone: readonly number[] | null;
}

/**
 * Which rendition a tick draws the picture as - the names `wasm::set_proof` reads - the operator
 * an sRGB one fits its highlights under diffuse white with, and whether the display shows anything
 * past SDR white at all.
 *
 * `hdr` is what a library serves by default and so what the editor opens at; sRGB is what a reader
 * opts into to see where that render rolls its highlights off and clips its colours.
 */
export const ProofSchema = z.object({ output: z.enum(['hdr', 'srgb']), intent: RenderingIntentSchema, displayHdr: z.boolean() });
export type Proof = z.infer<typeof ProofSchema>;

/** The whole frame, upright, which is what a photo nobody has cropped shows. */
export function wholeFrameGeometry(): EditGeometry {
  return { crop: [0, 0, 1, 1], angleDegrees: 0, rotate: 0, keystone: null };
}
