import type {
  BackupIssues,
  BackupReport,
  ConfiguredBackupStatus,
} from '../../../../../src/schemas/backup';

export const noIssues: BackupIssues = { total: 0, counts: [], samples: [] };

export function backupStatus(
  overrides: Partial<ConfiguredBackupStatus> = {},
): ConfiguredBackupStatus {
  return {
    library_id: 'lib',
    configured: true,
    peer_id: 'backup',
    name: 'Backup',
    path: '/backup',
    status: 'current',
    access: 'ready',
    activity: null,
    coverage: {
      originals: 12,
      backed_up: 12,
      pending: 0,
      offloaded: 0,
      missing: 0,
      changed: 0,
      missing_originals: 0,
    },
    issues: noIssues,
    transfers: { queued: 0, active: 0, paused: 0, failed: 0, cancelled: 0 },
    local_bytes: 3_000_000_000,
    local_budget_bytes: null,
    budget_unmet: false,
    last_backup_report: null,
    last_restore_report: null,
    ...overrides,
  };
}

export function backupReport(overrides: Partial<BackupReport> = {}): BackupReport {
  return {
    operation: 'backup',
    started_at: '2026-09-01T00:00:00Z',
    finished_at: '2026-09-01T00:01:00Z',
    outcome: 'complete',
    copied: 0,
    moved: 0,
    offloaded: 0,
    restored: 0,
    issues: noIssues,
    ...overrides,
  };
}
