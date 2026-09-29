import { z } from 'zod';
import { ProcessingStageSchema, RenditionSchema } from './common';
import { CompositeProgressSchema } from './composition';
import { ExportProgressSchema } from './exports';

/** A photo's derived file has been rewritten, with the stamp its row now carries. */
export const RenditionEventSchema = z.object({
  id: z.string(),
  stage: ProcessingStageSchema,
  version: z.string(),
});
export type RenditionEvent = z.infer<typeof RenditionEventSchema>;

export const RenditionFetchPhaseSchema = z.enum(['fetching', 'rendering']);
export type RenditionFetchPhase = z.infer<typeof RenditionFetchPhaseSchema>;

/** A rendition this device is waiting on a peer for, and what the peer is doing; null once it has settled. */
export const RenditionFetchEventSchema = z.object({
  id: z.string(),
  rendition: RenditionSchema,
  phase: RenditionFetchPhaseSchema.nullable(),
});
export type RenditionFetchEvent = z.infer<typeof RenditionFetchEventSchema>;

/** A library's peers changed underneath the session. */
export const ReplicationEventSchema = z.object({ library_id: z.string() });
export type ReplicationEvent = z.infer<typeof ReplicationEventSchema>;
export const BackupEventSchema = z.object({ library_id: z.string() });

export const LibraryEventSchemas = {
  rendition: RenditionEventSchema,
  rendition_fetch: RenditionFetchEventSchema,
  replication: ReplicationEventSchema,
  backup: BackupEventSchema,
  composite: CompositeProgressSchema,
  export: ExportProgressSchema,
};
export type LibraryEventKind = keyof typeof LibraryEventSchemas;
export type LibraryEventPayload<K extends LibraryEventKind> = z.input<
  (typeof LibraryEventSchemas)[K]
>;
