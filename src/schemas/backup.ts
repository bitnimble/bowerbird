import { z } from 'zod';
import { IdSchema } from './common';
import { PeerIdSchema } from './replication';

// Backing a library's originals up to a folder that is not a Bowerbird device
// (docs/replication.md §14): the passive peer, what it holds, and the ceiling the cull works to.

/**
 * The file that says whose backup a directory is.
 *
 * Written at the root of the mirror, and read before anything is written into it: a path on a
 * removable drive or a share resolves to *something* whether or not the drive is mounted, and
 * without this an unmounted NAS is an empty directory that reads as a backup with nothing in it
 * yet - which is a second copy of the library written onto the machine's own disk.
 */
export const BackupMarkerSchema = z.object({
  library_id: IdSchema,
  library_name: z.string(),
  peer_id: PeerIdSchema,
});
export type BackupMarker = z.infer<typeof BackupMarkerSchema>;

export const SetBackupRequestSchema = z.object({
  library_id: IdSchema,
  /** Absolute, because a relative one resolves against wherever the server happens to be started. */
  path: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
});
export type SetBackupRequest = z.infer<typeof SetBackupRequestSchema>;

export const SetLocalBudgetRequestSchema = z.object({
  /** Null is no ceiling: every original stays on this device (§14.5). */
  local_budget_bytes: z.number().int().positive().nullable(),
});

export const BackupStatusSchema = z.object({
  library_id: IdSchema,
  peer_id: PeerIdSchema,
  name: z.string(),
  path: z.string(),
  /** Whether the folder is readable right now, which is what a fetch and the cull both need. */
  available: z.boolean(),
  /** Originals this device holds that the backup does not, which is what the next pass will copy. */
  owed: z.number().int(),
  backed_up: z.number().int(),
  /** What this library's originals take up on this device, against the ceiling the cull works to. */
  local_bytes: z.number().int(),
  local_budget_bytes: z.number().int().nullable(),
  /** Originals this device has given back, and which the backup is now the only copy of. */
  offloaded: z.number().int(),
  last_run_at: z.string().nullable(),
  last_error: z.string().nullable(),
});
export type BackupStatus = z.infer<typeof BackupStatusSchema>;

export const BackupStatusesSchema = z.object({ backups: z.array(BackupStatusSchema) });

export const BackupRunResponseSchema = z.object({
  /**
   * Photographs the backup holds at the end of the pass and did not at the start - not what was
   * sent. A push that fails is marked failed and retried next pass, and a reader told a number
   * that counted it would be told their photographs are safe when they are not.
   */
  copied: z.number().int(),
  moved: z.number().int(),
  /** What the cull gave back, where a ceiling is set and the pass reached it. */
  offloaded: z.number().int(),
});
export type BackupRunResponse = z.infer<typeof BackupRunResponseSchema>;
