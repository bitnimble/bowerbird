import { z } from 'zod';
import { IdSchema } from './common';
import { PeerIdSchema } from './replication';

export const BackupMarkerSchema = z.object({
  library_id: IdSchema,
  library_name: z.string(),
  peer_id: PeerIdSchema,
});
export type BackupMarker = z.infer<typeof BackupMarkerSchema>;

export const SetBackupRequestSchema = z.object({
  library_id: IdSchema,
  path: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
});
export type SetBackupRequest = z.infer<typeof SetBackupRequestSchema>;
export const RemoveBackupQuerySchema = z.object({ fetch_first: z.enum(['1']).optional() });
export const SetLocalBudgetRequestSchema = z.object({
  local_budget_bytes: z.number().int().positive().nullable(),
});

export const BackupIssueCodeSchema = z.enum([
  'folder_missing',
  'marker_missing',
  'marker_invalid',
  'wrong_library',
  'wrong_backup',
  'unreadable',
  'path_conflict',
  'backup_missing',
  'backup_changed',
  'local_missing',
  'local_changed',
  'read_only',
  'no_space',
  'permission_denied',
  'io_error',
  'transfer_failed',
  'paused',
  'cancelled',
  'budget_unmet',
]);
export type BackupIssueCode = z.infer<typeof BackupIssueCodeSchema>;
export const BackupAccessSchema = z.enum([
  'ready',
  'folder_missing',
  'marker_missing',
  'marker_invalid',
  'wrong_library',
  'wrong_backup',
  'unreadable',
]);
export type BackupAccess = z.infer<typeof BackupAccessSchema>;
export const BackupPhaseSchema = z.enum([
  'checking',
  'moving',
  'copying',
  'offloading',
  'restoring',
  'configuring',
]);
export type BackupPhase = z.infer<typeof BackupPhaseSchema>;
const CurrentTransferSchema = z.object({
  path: z.string(),
  bytes_done: z.number().int().nonnegative(),
  bytes_total: z.number().int().nonnegative().nullable(),
});
export const BackupActivitySchema = z.object({
  phase: BackupPhaseSchema,
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  current: CurrentTransferSchema.nullable(),
});
export type BackupActivity = z.infer<typeof BackupActivitySchema>;
export const BackupIssueSchema = z.object({
  code: BackupIssueCodeSchema,
  phase: BackupPhaseSchema,
  photo_id: z.string().nullable(),
  path: z.string().nullable(),
});
export type BackupIssue = z.infer<typeof BackupIssueSchema>;
export const BackupCopyIssuesSchema = z.array(BackupIssueSchema).max(2);
export const BackupIssuesSchema = z.object({
  total: z.number().int().nonnegative(),
  counts: z.array(z.object({ code: BackupIssueCodeSchema, count: z.number().int().positive() })),
  samples: z.array(BackupIssueSchema).max(10),
});
export type BackupIssues = z.infer<typeof BackupIssuesSchema>;
export const BackupReportSchema = z.object({
  operation: z.enum(['backup', 'configure', 'restore']),
  started_at: z.string(),
  finished_at: z.string(),
  outcome: z.enum(['complete', 'partial', 'blocked']),
  copied: z.number().int().nonnegative(),
  moved: z.number().int().nonnegative(),
  offloaded: z.number().int().nonnegative(),
  restored: z.number().int().nonnegative(),
  issues: BackupIssuesSchema,
});
export type BackupReport = z.infer<typeof BackupReportSchema>;
export const BackupCoverageSchema = z.object({
  originals: z.number().int().nonnegative(),
  backed_up: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  offloaded: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  missing_originals: z.number().int().nonnegative(),
});
export type BackupCoverage = z.infer<typeof BackupCoverageSchema>;
export const ConfiguredBackupStatusSchema = z.object({
  library_id: IdSchema,
  configured: z.literal(true),
  peer_id: PeerIdSchema,
  name: z.string(),
  path: z.string(),
  status: z.enum(['unavailable', 'working', 'attention', 'paused', 'waiting', 'current', 'empty']),
  access: BackupAccessSchema,
  activity: BackupActivitySchema.nullable(),
  coverage: BackupCoverageSchema,
  issues: BackupIssuesSchema,
  transfers: z.object({
    queued: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  local_bytes: z.number().int().nonnegative(),
  local_budget_bytes: z.number().int().nullable(),
  budget_unmet: z.boolean(),
  last_backup_report: BackupReportSchema.nullable(),
  last_restore_report: BackupReportSchema.nullable(),
});
export type ConfiguredBackupStatus = z.infer<typeof ConfiguredBackupStatusSchema>;
export const BackupStatusSchema = z.discriminatedUnion('configured', [
  z.object({ library_id: IdSchema, configured: z.literal(false) }),
  ConfiguredBackupStatusSchema,
]);
export type BackupStatus = z.infer<typeof BackupStatusSchema>;
export const BackupStatusesSchema = z.object({ backups: z.array(BackupStatusSchema) });
export const BackupRunResponseSchema = z.object({
  status: BackupStatusSchema,
  report: BackupReportSchema,
});
export type BackupRunResponse = z.infer<typeof BackupRunResponseSchema>;

export const FetchBackProgressSchema = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  paused: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  current: CurrentTransferSchema.nullable(),
});
export type FetchBackProgress = z.infer<typeof FetchBackProgressSchema>;
export const FetchBackStatusSchema = z.object({ progress: FetchBackProgressSchema.nullable() });
