import { z } from 'zod';
import { JobGradeSchema, NoiseFitSchema } from './jobs';
import { CameraMatchSchema } from './render_stages';
import { ToneCurveSchema } from './photo_edits';

const PairSchema = z.tuple([z.number(), z.number()]);

/** The illuminant the camera balanced a frame for. */
export const AsShotSchema = z.object({ temperature: z.number(), tint: z.number() });
export type AsShot = z.infer<typeof AsShotSchema>;

/**
 * What an open answers with (`edit::PreparedHeader`), which is everything about the photograph the
 * page shows or hands back - and nothing about its pixels, which never leave the worker.
 */
export const PreparedHeaderSchema = z.object({
  width: z.number(),
  height: z.number(),
  asShot: AsShotSchema.nullable(),
  white: z.number(),
  peak: z.number(),
  /** Null where the picture was prepared without a histogram walk behind it. */
  floor: z.number().nullable(),
  grade: JobGradeSchema,
  strengths: z.object({ sharpen: z.number(), defringe: z.number() }),
  cameraMatch: CameraMatchSchema,
  matched: z.boolean(),
  /**
   * Whether this photograph has a sensor mosaic behind it.
   *
   * False for a JPEG, a PNG, a HEIC or an AVIF. The denoise is fitted to a photosite's own noise
   * on the colour filter array and the dust search reads the same lattice, so on a picture
   * somebody else's camera has already demosaiced there is nothing for either to act on - and a
   * slider that silently does nothing is worse than one that is not offered.
   */
  mosaic: z.boolean(),
  /**
   * The two Detail positions this open actually filtered at, 0 to 100.
   *
   * What the panel shows where the document has left a slider unset: the ramp from a noise fit to
   * a position lives in the module (`galosh::NoiseModel::suggested_amounts`), so the decode that
   * used it reports it rather than the page deriving a second copy that would drift.
   */
  detail: PairSchema,
  /** The camera match's curve, or null where nothing was matched. */
  cameraCurve: ToneCurveSchema.nullable(),
  /**
   * The mosaic's noise, as the open fitted it.
   *
   * Handed back on the loupe's tile requests: a tile is a crop, its own whole-region fit is not
   * the photograph's, and nothing that renders one has a frame to measure. Absent where the
   * decoding machine had no adapter.
   */
  noiseFit: NoiseFitSchema.optional(),
  /**
   * The longitudinal aberration the open's defringe took off, for the loupe's tiles for the same
   * reason as the fit above: it is read over the whole frame, and a tile fitting its own is
   * corrected by whatever its window's edges say, differently from the tiles beside it.
   */
  defocus: PairSchema,
  /**
   * What this open measured that nothing had kept.
   *
   * Held for the loupe's tiles, which cannot fit their own match: `fit_all` resamples the whole
   * embedded JPEG to the frame it is given, so a 400px crop would be matched against a squashed
   * picture of the entire scene and every tile position would grade differently.
   */
  photoAnalysis: z.array(z.number()).optional(),
  /**
   * Where these samples sit in the picture, where they are a rectangle of a larger one.
   *
   * **Absent means the samples *are* the picture at their level**, which a tab's own open and a
   * whole level both hand over. Present past the coarsest level of a canvas, where there is no
   * whole level a device will hold. `canvas` is at the level served, which is the space the
   * samples and `origin` are in and so what the draw indexes by.
   */
  window: z.object({ canvas: PairSchema, origin: PairSchema }).optional(),
  /**
   * The photograph these samples are of, at scale 1.
   *
   * The size that does not move when a level does, so it is what this page states the reader's own
   * things against - the crop fractions, the region a zoom moves. A page measuring the level
   * instead would throw their zoom away each time a finer window of the same picture arrived.
   * Absent for an open that holds the photograph itself.
   */
  picture: PairSchema.optional(),
  /**
   * Which halving of the picture these samples are.
   *
   * Named back when asking for the tiles of a level that are missing. Not derivable from `canvas`
   * against `picture` without a second copy of the library's own rounding, in the one place a
   * disagreement would put a reader's tiles at the wrong scale.
   */
  level: z.number().optional(),
  /**
   * Whether these samples are the photograph's own pixels, with no finer level to ask for.
   *
   * Stated by the side that knows how many halvings the picture has, because this one cannot work
   * it out: a client guessing either keeps asking for a picture it already holds, once per pan for
   * the life of the open, or stops asking on a picture that had a finer level all along.
   */
  finest: z.boolean().optional(),
});
export type PreparedHeader = z.infer<typeof PreparedHeaderSchema>;

/** A prepared picture's framed header: the open's, or why there is none. */
export const PreparedReplyHeaderSchema = z.union([z.object({ error: z.string() }), PreparedHeaderSchema]);
export type PreparedReplyHeader = z.infer<typeof PreparedReplyHeaderSchema>;

/** A header the module answered as JSON text, read. */
export function readPreparedHeader(text: string): PreparedHeader {
  return PreparedHeaderSchema.parse(JSON.parse(text));
}
