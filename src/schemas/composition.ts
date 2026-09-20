import { z } from 'zod';
import { IdSchema } from './common';

// One frame of a panorama, as `composition::SourceSpec`: which photograph it is, where it points,
// and the lens the RAW gather reaches it through.
export const CompositionSourceSchema = z.object({
  photoId: IdSchema,
  size: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  focal: z.number().positive(),
  lens: z.object({
    distortion: z.array(z.number()).nullable().optional(),
    crop: z.number(),
    falloff: z.tuple([z.number(), z.number()]).nullable().optional(),
    tca: z.tuple([z.array(z.number()), z.array(z.number())]).nullable().optional(),
  }),
  gain: z.number().positive(),
});

// What a panorama composes its sources into: `composition::Panorama`, which the native side writes
// and reads and nothing here interprets beyond the canvas and the photographs it names. Held to
// the shape rather than passed through, so a recipe from a peer running a different build is
// rejected here instead of failing inside a render.
export const CompositionSchema = z.object({
  version: z.number().int().positive(),
  sources: z.array(CompositionSourceSchema).min(2),
  projection: z.enum(['rectilinear', 'cylindrical', 'equirectangular']),
  canvas: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  centre: z.tuple([z.number(), z.number()]),
  radiansPerPixel: z.number().positive(),
  // The largest rectangle of the canvas the sources actually cover, as `EditDoc`'s own crop
  // fractions. What the merge writes the composite's edits with (`framingEdits`), so everything
  // that renders one is framed by the reader's own field rather than by a rule of its own.
  //
  // Defaulted rather than required, for a recipe written before the align found one: that reads as
  // the whole canvas, which is what it rendered as.
  crop: z.tuple([z.number(), z.number(), z.number(), z.number()]).default([0, 0, 1, 1]),
  reference: z.number().int().nonnegative(),
  seamRmsPx: z.number().nullable().optional(),
});
export type Composition = z.infer<typeof CompositionSchema>;

/** The photograph a merge made, or the one an assembly was saved onto. */
export const CompositePhotoSchema = z.object({ photoId: z.string() });
export type CompositePhoto = z.infer<typeof CompositePhotoSchema>;

export const CompositePhaseSchema = z.enum(['aligning', 'tile', 'picture', 'done', 'failed']);
export type CompositePhase = z.infer<typeof CompositePhaseSchema>;

/** What a reader is told of a merge in flight. */
export const CompositeProgressSchema = z.object({
  // The photograph the merge is making, once there is one; null while it is still being aligned.
  photoId: z.string().nullable(),
  // The frames it is being made from, which are what a grid marks while it waits.
  photoIds: z.array(z.string()),
  phase: CompositePhaseSchema,
  // How much of the whole merge is behind it, 0 to 1.
  fraction: z.number(),
});
export type CompositeProgress = z.infer<typeof CompositeProgressSchema>;

/**
 * The canvas long edge to assemble at so that the *crop* comes out `want` pixels long.
 *
 * **A rendition size names the picture, and an assembly's picture is its crop.** `composite_job`'s
 * `sized` scales the canvas, and an assembly's canvas is the union of frames that were never quite
 * pointed the same way while its crop is their intersection. A burst's two are within a percent of
 * each other, but a set that only half overlaps - two frames a dozen degrees apart still carve -
 * has a crop a fraction of its canvas, and asking for 3840 handed the reader a fraction of that.
 *
 * `sized` clamps to the canvas's own long edge, so a crop can never be asked for more resolution
 * than the frames behind it hold.
 */
export function canvasLongEdgeFor(composition: Pick<Composition, 'canvas' | 'crop'>, want: number): number {
  const [width, height] = composition.canvas;
  const [left, top, right, bottom] = composition.crop;
  const crop = Math.max((right - left) * width, (bottom - top) * height);
  if (!(crop > 0)) return want;
  return Math.round((want * Math.max(width, height)) / crop);
}
