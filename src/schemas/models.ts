import { z } from 'zod';

/** The reflection remover's files are this name with `.json` and `.bin`. */
export const REFLECTION_MODEL = 'dereflect';

export const ModelVersionSchema = z.object({
  /** The Hugging Face commit the files are from. */
  revision: z.string(),
  committed_at: z.string(),
});
export type ModelVersion = z.infer<typeof ModelVersionSchema>;

/** The models on this server, and newer ones where Hugging Face has them. */
export const ModelsStatusSchema = z.object({
  /**
   * `downloaded` is false where they are the models this build carries, and `files` are those in
   * use: a model the build does not carry is there only once downloaded.
   */
  current: ModelVersionSchema.extend({ downloaded: z.boolean(), files: z.array(z.string()) }),
  available: ModelVersionSchema.extend({ bytes: z.number() }).nullable(),
  downloading: z.boolean(),
  checked_at: z.string().nullable(),
  error: z.string().nullable(),
});
export type ModelsStatus = z.infer<typeof ModelsStatusSchema>;
