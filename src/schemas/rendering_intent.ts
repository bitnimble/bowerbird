import { z } from 'zod';

/** How a picture is brought inside what an sRGB file or a print can show (`gpu::Intent`). */
export const RenderingIntentSchema = z.enum(['perceptual', 'relativeColorimetric', 'absoluteColorimetric']);
export type RenderingIntent = z.infer<typeof RenderingIntentSchema>;

/** The intents a file can take: absolute keeps a paper's own white, and a file has no paper. */
export const FileRenderingIntentSchema = RenderingIntentSchema.exclude(['absoluteColorimetric']);
export type FileRenderingIntent = z.infer<typeof FileRenderingIntentSchema>;

/** An intent as a file takes it, absolute being relative where there is no paper. */
export function fileIntentOf(intent: RenderingIntent): FileRenderingIntent {
  return intent === 'absoluteColorimetric' ? 'relativeColorimetric' : intent;
}
