import { z } from 'zod';

export const ModelVersionSchema = z.object({
  /** The Hugging Face commit the files are from. */
  revision: z.string(),
  committed_at: z.string(),
});
export type ModelVersion = z.infer<typeof ModelVersionSchema>;

/** The models on this server, and newer ones where Hugging Face has them. */
export const ModelsStatusSchema = z.object({
  /** `downloaded` is false where they are the models this build carries. */
  current: ModelVersionSchema.extend({ downloaded: z.boolean() }),
  available: ModelVersionSchema.extend({ bytes: z.number() }).nullable(),
  downloading: z.boolean(),
  checked_at: z.string().nullable(),
  error: z.string().nullable(),
});
export type ModelsStatus = z.infer<typeof ModelsStatusSchema>;
