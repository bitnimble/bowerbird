import { z } from 'zod';
import { ProcessingStageSchema } from './common';
import { CompositeProgressSchema } from './composition';
import { ExportProgressSchema } from './exports';

/** A photo's derived file has been rewritten, with the stamp its row now carries. */
export const RenditionEventSchema = z.object({
  id: z.string(),
  stage: ProcessingStageSchema,
  version: z.string(),
});
export type RenditionEvent = z.infer<typeof RenditionEventSchema>;

/** A library's peers changed underneath the session. */
export const ReplicationEventSchema = z.object({ library_id: z.string() });
export type ReplicationEvent = z.infer<typeof ReplicationEventSchema>;

export const LibraryEventSchemas = {
  rendition: RenditionEventSchema,
  replication: ReplicationEventSchema,
  composite: CompositeProgressSchema,
  export: ExportProgressSchema,
};
export type LibraryEventKind = keyof typeof LibraryEventSchemas;
export type LibraryEventPayload<K extends LibraryEventKind> = z.input<(typeof LibraryEventSchemas)[K]>;
