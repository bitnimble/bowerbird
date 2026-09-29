import { AppError, type ErrorCode } from '../../errors';
import type { BackupIssueCode } from '../../schemas/backup';
import type { Transfer } from '../../schemas/blobs';

const ERROR_CODES: Record<BackupIssueCode, ErrorCode> = {
  folder_missing: 'UNAVAILABLE',
  marker_missing: 'UNAVAILABLE',
  unreadable: 'UNAVAILABLE',
  read_only: 'READ_ONLY',
  io_error: 'IO_ERROR',
  no_space: 'IO_ERROR',
  permission_denied: 'IO_ERROR',
  marker_invalid: 'CONFLICT',
  wrong_library: 'CONFLICT',
  wrong_backup: 'CONFLICT',
  path_conflict: 'CONFLICT',
  backup_missing: 'CONFLICT',
  backup_changed: 'CONFLICT',
  local_missing: 'CONFLICT',
  local_changed: 'CONFLICT',
  transfer_failed: 'CONFLICT',
  paused: 'CONFLICT',
  cancelled: 'CONFLICT',
  budget_unmet: 'CONFLICT',
};

export class BackupError extends AppError {
  constructor(
    readonly issueCode: BackupIssueCode,
    message: string,
  ) {
    super(ERROR_CODES[issueCode], message);
  }
}

export function backupIssueCode(error: unknown): BackupIssueCode {
  if (error instanceof BackupError) return error.issueCode;
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'ENOSPC' || error.code === 'EDQUOT') return 'no_space';
    if (error.code === 'EACCES' || error.code === 'EPERM') return 'permission_denied';
    if (error.code === 'READ_ONLY' || error.code === 'EROFS') return 'read_only';
    if (error.code === 'UNAVAILABLE') return 'unreadable';
    if (error.code === 'IO_ERROR') return 'io_error';
  }
  return 'transfer_failed';
}

export function transferIssueCode(item: Transfer): BackupIssueCode {
  if (item.state === 'paused') return 'paused';
  if (item.state === 'cancelled') return 'cancelled';
  return item.error_code ?? 'transfer_failed';
}
