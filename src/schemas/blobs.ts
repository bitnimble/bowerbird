import { z } from 'zod';
import { IdSchema } from './common';
import { PhotoTargetSchema } from './photos';

// Requests and wire shapes for moving originals between peers
// (docs/replication.md §7.3-§7.6).

/**
 * What a push or pull diff covers (§7.3): an explicit selection, a shoot, or the
 * whole library, exactly one of them.
 */
// Strict arms, so a request naming two scopes is refused rather than resolved: a
// loose object matches the first arm and strips the rest, which is the silent
// precedence this union exists to remove.
export const BlobScopeSchema = z.union([
  z.object({ photo_ids: z.array(IdSchema).min(1) }).strict(),
  z.object({ shoot_id: IdSchema }).strict(),
  z.object({ library: z.literal(true) }).strict(),
]);
export type BlobScope = z.infer<typeof BlobScopeSchema>;

export const PushBlobsRequestSchema = z.object({
  library_id: IdSchema,
  peer_id: IdSchema,
  scope: BlobScopeSchema,
});
export type PushBlobsRequest = z.infer<typeof PushBlobsRequestSchema>;

export const EvictBlobsRequestSchema = z.object({
  peer_id: IdSchema,
  target: PhotoTargetSchema,
});
export type EvictBlobsRequest = z.infer<typeof EvictBlobsRequestSchema>;

export const BlobCommitRequestSchema = z.object({
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type BlobCommitRequest = z.infer<typeof BlobCommitRequestSchema>;

export const BlobQueueResponseSchema = z.object({ queued: z.number().int() });
export type BlobQueueResponse = z.infer<typeof BlobQueueResponseSchema>;

export const TransferDirectionSchema = z.enum(['push', 'pull']);
export type TransferDirection = z.infer<typeof TransferDirectionSchema>;
export const TransferStateSchema = z.enum(['queued', 'active', 'paused', 'done', 'failed', 'cancelled']);
export type TransferState = z.infer<typeof TransferStateSchema>;

export const TransferSchema = z.object({
  id: z.string(),
  library_id: z.string(),
  photo_id: z.string(),
  peer_id: z.string(),
  direction: TransferDirectionSchema,
  state: TransferStateSchema,
  bytes_done: z.number().int(),
  bytes_total: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type Transfer = z.infer<typeof TransferSchema>;

export const TransfersSchema = z.array(TransferSchema);

export const TransfersQuerySchema = z.object({ library_id: IdSchema.optional() });

export const BlobAppendQuerySchema = z.object({ offset: z.coerce.number().int().min(0).default(0) });

export const EvictResultSchema = z.object({
  evicted: z.array(z.string()),
  refused: z.array(z.object({ photo_id: z.string(), reason: z.string() })),
});
export type EvictResult = z.infer<typeof EvictResultSchema>;

export const BlobHashResponseSchema = z.object({ content_hash: z.string() });
export type BlobHashResponse = z.infer<typeof BlobHashResponseSchema>;
export const BlobAppendResponseSchema = z.object({ staged: z.number().int().min(0) });
export type BlobAppendResponse = z.infer<typeof BlobAppendResponseSchema>;
// `held` short-circuits a push whose earlier run completed but whose location
// row has not replicated back yet: the diff would re-send, and the receiver's
// own file would then read as a collision.
export const BlobStageResponseSchema = z.object({
  staged: z.number().int().min(0),
  held: z.boolean(),
});
export type BlobStageResponse = z.infer<typeof BlobStageResponseSchema>;
/** A peer's answer to "do you hold this original, right now" (§7.6). */
// A union, not a boolean beside a nullable hash: the caller deletes its own copy on
// the strength of a "yes", and what makes that safe is the hash matching what it
// recorded, so a "yes" with nothing to compare must not be sayable.
export const BlobVerifyResponseSchema = z.discriminatedUnion('held', [
  z.object({ held: z.literal(false) }),
  z.object({ held: z.literal(true), content_hash: z.string() }),
]);
export type BlobVerifyResponse = z.infer<typeof BlobVerifyResponseSchema>;
