import { z } from 'zod';
import { AssemblyRecipeSchema } from './assembly';
import { RenditionSchema, RenditionSourceSchema } from './common';
import type { DustSettings } from './dust_settings';
import { ColourProfileSchema, RepairSchema } from './photo_edits';

/** How a scene-linear decode is graded to display-referred (§10.7). */
export const JobGradeSchema = z.object({
  peakNits: z.number(),
  referenceWhiteNits: z.number(),
  whiteQuantile: z.number(),
});
export type JobGrade = z.infer<typeof JobGradeSchema>;

/**
 * Where a rendition's highlights roll into, and what codes the result.
 *
 * The only thing a rendition's dynamic range reaches inside the pipeline: everything
 * upstream is one 16-bit scene-linear render, and this picks the peak the BT.2390 roll-off
 * targets and the transfer and depth of the buffer that leaves. A job is therefore one
 * render with a list of outputs, which is what lets several renditions of a photo share
 * the decode, the fit, the filter and the colour transform (§10.3).
 */
export const JobOutputSchema = z.enum(['pq', 'srgb']);
export type JobOutput = z.infer<typeof JobOutputSchema>;

export const JobTargetSchema = z.object({
  rendition: RenditionSchema,
  output: JobOutputSchema,
  outputPath: z.string(),
  /** Longest edge, or 0 for native resolution. */
  size: z.number(),
  source: RenditionSourceSchema,
  sdrQuantizer: z.number(),
  hdrQuantizer: z.number(),
  preset: z.number(),
  stillFullChroma: z.boolean(),
  sdrFullChroma: z.boolean(),
});
export type JobTarget = z.infer<typeof JobTargetSchema>;

export const JobGeometrySchema = z.object({
  crop: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  angleDegrees: z.number(),
  rotate: z.number(),
  /**
   * The perspective correction, corrected back to source in fractions of the frame, or null.
   *
   * Under the crop and the straighten in the gather, because it corrects the camera's angle to
   * the subject rather than anything the reader chose about the framing.
   */
  keystone: z.array(z.number()).nullable(),
});
export type JobGeometry = z.infer<typeof JobGeometrySchema>;

export const JobAdjustSchema = z.object({
  contrast: z.number(),
  highlights: z.number(),
  shadows: z.number(),
  whites: z.number(),
  blacks: z.number(),
  vibrance: z.number(),
  saturation: z.number(),
  texture: z.number(),
  clarity: z.number(),
  dehaze: z.number(),
  /**
   * The illuminant the reader asked for, or null for the one the camera chose.
   *
   * Null rather than the as-shot numbers, because that is what the document stores and it has
   * to: an edit recording 5500K would mean a different picture on a frame the camera metered
   * at 3200, where "as shot" means the same thing on every one. What it is resolved against
   * comes off the decode, not off the job.
   */
  temperature: z.number().nullable(),
  tint: z.number().nullable(),
  colourProfile: ColourProfileSchema,
});
export type JobAdjust = z.infer<typeof JobAdjustSchema>;

/** `composite_job::Want`: what a composite job asks of its sources, and what that needs. */
export const CompositeWantSchema = z.discriminatedUnion('want', [
  z.object({ want: z.literal('align') }),
  /** Writes the seam volume to `volumePath`. */
  z.object({ want: z.literal('analyse'), volumePath: z.string() }),
  /** `recipe` is `Composed`, opaque to this side - tagged by its own `kind`, rather than stripped of it. */
  z.object({ want: z.literal('render'), recipe: z.unknown() }),
  /** Each of `picks` in place of `recipe`'s own, over the volume at `volumePath`. */
  z.object({
    want: z.literal('seams'),
    recipe: AssemblyRecipeSchema,
    volumePath: z.string(),
    picks: z.array(z.array(z.number())),
  }),
]);
export type CompositeWant = z.infer<typeof CompositeWantSchema>;

export const JobCompositeSourceSchema = z.object({
  photoId: z.string(),
  rawFilePath: z.string(),
  /** A picture to search instead of the RAW's own preview, where one is the same picture. */
  previewPath: z.string().optional(),
  /** As `Job.photoAnalysis` is, and for the same reason: bytes as numbers, since this is JSON. */
  photoAnalysis: z.array(z.number()).optional(),
});
export type JobCompositeSource = z.infer<typeof JobCompositeSourceSchema>;

export const JobCompositeSchema = z.intersection(
  z.object({ sources: z.array(JobCompositeSourceSchema) }),
  CompositeWantSchema,
);
export type JobComposite = z.infer<typeof JobCompositeSchema>;

export const DustSettingsSchema = z.object({
  enabled: z.boolean(),
  sensitivity: z.number(),
  intensity: z.number(),
}) satisfies z.ZodType<DustSettings>;

export const JobSchema = z.object({
  rawFilePath: z.string(),
  matchEmbeddedJpeg: z.boolean(),
  preserveSourceOrientation: z.boolean().optional(),
  /**
   * What has already been measured about this photograph, where it has been kept.
   *
   * The camera match, the noise fit and the levels: most of a second, almost none of it depending
   * on anything a job brings, so every path that has them hands them over rather than paying
   * again. A blob the library cannot read is ignored and measured afresh, so an older one is never
   * a wrong picture.
   *
   * Bytes as numbers because this whole struct crosses as JSON: a `Uint8Array` here stringifies
   * to an object of numeric keys, which the far side rejects as a malformed job.
   */
  photoAnalysis: z.array(z.number()).optional(),
  /**
   * The Detail panel's two sliders, 0 to 100, exactly as `EditDoc` stores them (§10.9).
   *
   * Positions rather than strengths, and carried unconverted for the same reason the
   * exposure below is: the denoise that reads them is on the far side, and a number
   * converted here would be in the far side's units.
   *
   * Null is the document not having said, which the decode answers with the frame's own noise
   * fit rather than with a number - so this side never resolves it (`galosh::Detail`).
   */
  denoiseLuminance: z.number().nullable(),
  denoiseColour: z.number().nullable(),
  /**
   * Collapse each Bayer quad into one pixel rather than interpolating it.
   *
   * Only an export sets it. A rendition asks for a size and lets the decode halve when that
   * still serves; this is a reader choosing the trade itself, which the size cannot express -
   * on a frame the floor would never have halved, asking for a smaller size resamples a full
   * demosaic instead of skipping one.
   */
  halfSize: z.boolean().optional(),
  /**
   * Run the base and stop: measure this photograph and write no picture at all.
   *
   * The camera match is made in there and nowhere else, and a caller that wants only the fit
   * would otherwise pay for a cut, a grade, an encode and a file it throws away.
   */
  measure: z.boolean().optional(),
  /**
   * Count this job's steps in the library's own cell, for `jobProgress` to read from this thread.
   *
   * Only an export asks: there is one cell for the process, so a job nobody is watching would
   * report over the one somebody is.
   */
  reportProgress: z.boolean().optional(),
  /**
   * The dust panel's switch and two sliders, on the job for the reason the Detail pair is: the
   * correction is on the mosaic, inside the one decode every target is cut from.
   *
   * **Fractions here, positions in the document.** Unlike the pair above these are converted on
   * the way in, because `crate::dust::Settings` is what a shader reads them as - so the scaling
   * lives in `dustSettings`, which both this side and the editor call.
   */
  dust: DustSettingsSchema,
  /** The reader's repairs, applied to the one frame every target is cut from. */
  repairs: z.array(RepairSchema).optional(),
  /**
   * How much of a deconvolution to blend into the sharpen, 0 to 1. Belongs to the render
   * rather than to a rendition, so every target shares it, and unitless - how much noise
   * the frame has is measured off its own pixels on the far side, not passed in.
   */
  sharpen: z.number(),
  defringe: z.number(),
  /**
   * The photographer's exposure **in stops**, exactly as `EditDoc` stores it. 0 is as metered.
   *
   * The document's own unit, carried to the shader untouched: `colour.slang` raises it.
   */
  exposure: z.number(),
  /**
   * Every slider but the exposure, on Camera Raw's -100..100 scales, as `adjust.slang` reads
   * them. All zero is the picture as the camera rendered it.
   *
   * Separate from `exposure` because that one is a gain the tone anchor moves against, where
   * these are terms in the grade itself - including the presence three, whose neighbourhood
   * arrives as a blur built once per frame rather than as a second grade.
   */
  adjust: JobAdjustSchema,
  /**
   * The reader's crop, straighten and quarter turn.
   *
   * `crop` is left, top, right, bottom as fractions of the *straightened* frame, which is
   * Camera Raw's definition and what `EditDocSchema` stores. Applied inside the cut's own
   * gather, so a crop costs a smaller output rather than a second copy of the frame.
   */
  geometry: JobGeometrySchema,
  grade: JobGradeSchema,
  targets: z.array(JobTargetSchema),
  /**
   * This is the import's scan: report the catalogue's fields off the source this job already
   * opens, and never demosaic.
   *
   * The refusal to render is half of what it means. A file whose embedded preview cannot be
   * lifted would otherwise fall through to a full render - 1.5s on the scan pool, for a tile
   * the rendition pass is about to build anyway, and without the library's settings to build it
   * from. Such a photo comes back with a header and no tile, which is what the scan wants.
   */
  scan: z.boolean().optional(),
  /**
   * The photographs this job is a panorama of, and what to do with them.
   *
   * Present, `rawFilePath` says nothing and the sources here are what is rendered - a composite
   * of them all, which arrives at the grade as one coded frame like any decode. Absent, which is
   * every other job, nothing about the job changes.
   */
  composite: JobCompositeSchema.optional(),
});
export type Job = z.infer<typeof JobSchema>;

/**
 * The Poisson-Gaussian fit of a sensor's noise, as `galosh::NoiseFit` measured it.
 *
 * Opaque to everything between the two ends: the editor's open produces it, the client holds it
 * for the session, and a tile hands it straight back. Nothing here reads the numbers, and the
 * far side refuses one that does not describe a sensor.
 */
export const NoiseFitSchema = z.object({
  alpha: z.number(),
  sigmaSq: z.number(),
  unifiedSigma: z.number(),
  darkRef: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});
export type NoiseFit = z.infer<typeof NoiseFitSchema>;

/**
 * A photograph's diffuse white, scene peak and black floor, as `tone::Levels` measured them over
 * the whole frame - what everything downstream is coded, graded and placed against.
 *
 * Opaque here in the same way the fit above is: the editor's open reports them, the client holds
 * them for the session, and a tile hands them back so the crop is graded as the photograph is.
 *
 * All three or none: a tile handed a set without the floor is refused and measures its own off its
 * own crop, which is a different photograph's worth of shadows.
 */
export const JobLevelsSchema = z.object({
  white: z.number(),
  peak: z.number(),
  floor: z.number(),
});
export type JobLevels = z.infer<typeof JobLevelsSchema>;

export const RawHeaderFieldsSchema = z.object({
  width: z.number(),
  height: z.number(),
  orientation: z.number(),
  /** Epoch seconds, from the camera's wall clock read as UTC, or null. */
  timestamp: z.number().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  iso: z.number().nullable(),
  shutterSpeed: z.number().nullable(),
  aperture: z.number().nullable(),
  focalLength: z.number().nullable(),
  cameraMake: z.string().nullable(),
  cameraModel: z.string().nullable(),
  lensModel: z.string().nullable(),
});
export type RawHeaderFields = z.infer<typeof RawHeaderFieldsSchema>;

/** What `bb_run_job` writes back. */
export const JobReplySchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  outcome: z
    .object({
      descriptor: z.array(z.number()).nullable(),
      photoAnalysis: z.array(z.number()).optional(),
      header: RawHeaderFieldsSchema.optional(),
      composite: z.string().optional(),
    })
    .optional(),
});
