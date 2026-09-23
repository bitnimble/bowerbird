import { z } from 'zod';
import { IdSchema } from './common';
import { ViewerRenditionSchema } from './settings';

export const FrameTvSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
});
export type FrameTv = z.infer<typeof FrameTvSchema>;

export const FrameTvListSchema = z.object({ tvs: z.array(FrameTvSchema) });
export type FrameTvList = z.infer<typeof FrameTvListSchema>;

export const SendToFrameTvRequestSchema = z.object({
  tv_id: z.string(),
  photo_id: IdSchema,
  /** The rendition on screen, or null for the best one already built. */
  rendition: ViewerRenditionSchema.nullable(),
  /** Whether the TV switches to this photo once it has it. */
  show: z.boolean(),
});
export type SendToFrameTvRequest = z.infer<typeof SendToFrameTvRequestSchema>;
