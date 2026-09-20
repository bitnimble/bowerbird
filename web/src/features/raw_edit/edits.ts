// What a tick tells the module: the window to draw and the reader's document over it.
//
// The shapes only, because the rules are the module's - what a stop means, which uniform slot a
// slider lands in, what a null half of the balance does. These cross as JSON and are read by
// `gpu::Region`, `gpu::Adjust` and `image::Geometry`, so a name that drifts is `missing field` at
// the first tick: a black stage and a `failed` panel. `tests/module_json.test.ts` is the pin.

import { z } from 'zod';
import type { ColourProfile } from '../../../../src/schemas/photo_edits';

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
 * Nulls included: what a missing half of the white balance pair means is `white_balance.slang`'s
 * to say, so this carries the absence rather than a stand-in.
 */
export interface EditAdjust {
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  vibrance: number;
  saturation: number;
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
 * Which rendition a tick draws the picture as - the names `wasm::set_proof` reads.
 *
 * `hdr` is what a library serves by default and so what the editor opens at; sRGB is what a reader
 * opts into to see where that render rolls its highlights off and clips its colours.
 */
export const SoftProofSchema = z.enum(['hdr', 'srgb']);
export type SoftProof = z.infer<typeof SoftProofSchema>;

/** The whole frame, upright, which is what a photo nobody has cropped shows. */
export function wholeFrameGeometry(): EditGeometry {
  return { crop: [0, 0, 1, 1], angleDegrees: 0, rotate: 0, keystone: null };
}
