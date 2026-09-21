import { z } from 'zod';

/**
 * What a render of a photograph does to it, in the order it does them (§10.1).
 *
 * Deliberately coarser than `bench_stages`' list, which is keyed on what a dispatch costs rather
 * than on what a reader would recognise: the file read, the tag walk and the unpack are one `read`
 * here, and the coding, the resize, the warp and the roll-off are one `grade`.
 */
export const RENDER_STAGES = [
  'read',
  'dust',
  'denoise',
  'demosaic',
  'match',
  'defringe',
  'sharpen',
  'grade',
  'encode',
] as const;
export const RenderStageSchema = z.enum(RENDER_STAGES);
export type RenderStage = z.infer<typeof RenderStageSchema>;

/**
 * The stages a library may leave out of a rendition, and the only ones it may store.
 *
 * These five because these five are the ones the renderer is already gated on, so turning one off
 * is a job field rather than a second path through the pipeline (`services/.../render_stages.ts`).
 */
export const OPTIONAL_STAGES = ['dust', 'denoise', 'match', 'defringe', 'sharpen'] as const;
export const OptionalStageSchema = z.enum(OPTIONAL_STAGES);
export type OptionalStage = z.infer<typeof OptionalStageSchema>;

export const OptionalStagesSchema = z.array(OptionalStageSchema);

export function isOptional(stage: RenderStage): stage is OptionalStage {
  return (OPTIONAL_STAGES as readonly string[]).includes(stage);
}

/** The renditions a library states stages for: the two it renders (§10.1). */
export const RENDERED_RENDITIONS = ['full', 'max'] as const;
export const RenderedRenditionSchema = z.enum(RENDERED_RENDITIONS);
export type RenderedRendition = z.infer<typeof RenderedRenditionSchema>;

/**
 * What the whole render cost and what each stage saved, in milliseconds.
 *
 * A stage's figure is what leaving it out *saves* rather than what a lap inside it read (§10.1).
 */
export const RenderTimingSchema = z.object({
  total: z.number(),
  stages: z.partialRecord(RenderStageSchema, z.number()),
  measured_at: z.string(),
});
export type RenderTiming = z.infer<typeof RenderTimingSchema>;

/** What a benchmark has measured on this machine, by rendition. Absent is nothing measured yet. */
export const RenderTimingsSchema = z.partialRecord(RenderedRenditionSchema, RenderTimingSchema);
export type RenderTimings = z.infer<typeof RenderTimingsSchema>;

/** The frame every figure here is expressed against: 6000x4000, a common full-frame mirrorless. */
export const REFERENCE_PIXELS = 6000 * 4000;

/**
 * A measurement of a frame of `pixels` as the same render of {@link REFERENCE_PIXELS} would read.
 *
 * One machine has one answer, so what a stage costs cannot also depend on which photograph the
 * benchmark happened to find. A stage is a pass over the frame, so its cost goes with the frame's
 * area - true of the decode, the denoise, the demosaic and the encode, and roughest on the camera
 * match, whose fit is over a fixed number of pairs however large the sensor.
 */
export function scaledToReference(timing: RenderTiming, pixels: number): RenderTiming {
  const scale = REFERENCE_PIXELS / pixels;
  return {
    ...timing,
    total: Math.round(timing.total * scale),
    stages: Object.fromEntries(Object.entries(timing.stages).map(([stage, ms]) => [stage, Math.round(ms * scale)])),
  };
}

/**
 * What a stage costs before anybody has measured one here: `bench.budget.json`'s DSC02981 on the
 * discrete adapter, the optional rows from a `full` benchmark of that frame - which is 6000x4000,
 * so these are already on {@link REFERENCE_PIXELS} and a measurement replaces them like for like.
 *
 * Wrong on any machine but that one, which is what the Measure button exists to fix, so a number
 * here is worth no more than the one it replaces. `dust` and `sharpen` read as nothing on that
 * frame and carry a small figure rather than a zero that would read as a free row.
 */
export const ESTIMATED_MS: Record<RenderedRendition, Record<RenderStage, number>> = {
  full: { read: 14, dust: 10, denoise: 20, demosaic: 20, match: 430, defringe: 64, sharpen: 5, grade: 24, encode: 164 },
  max: { read: 14, dust: 10, denoise: 20, demosaic: 20, match: 430, defringe: 64, sharpen: 12, grade: 58, encode: 640 },
};

/** What this rendition's stages cost here, preferring what was measured to what was estimated. */
export function stageMs(rendition: RenderedRendition, measured: RenderTiming | undefined): Record<RenderStage, number> {
  const estimated = ESTIMATED_MS[rendition];
  if (measured == null) return estimated;
  return Object.fromEntries(
    RENDER_STAGES.map((stage) => [stage, measured.stages[stage] ?? estimated[stage]]),
  ) as Record<RenderStage, number>;
}
