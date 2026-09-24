import { z } from 'zod';

/** How a picture is brought inside what an sRGB file or a print can show (`gpu::Intent`). */
export const RenderingIntentSchema = z.enum(['perceptual', 'relativeColorimetric']);
export type RenderingIntent = z.infer<typeof RenderingIntentSchema>;
