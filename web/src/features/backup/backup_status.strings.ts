import type {
  BackupActivity,
  BackupIssueCode,
  BackupPhase,
  BackupReport,
  ConfiguredBackupStatus,
} from '../../../../src/schemas/backup';

function originals(count: number): string {
  return `${count} ${count === 1 ? 'original' : 'originals'}`;
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

const reasons: Record<BackupIssueCode, string> = {
  folder_missing: 'Backup folder is missing.',
  marker_missing: 'Backup folder needs confirmation.',
  marker_invalid: "We can't recognise this backup folder.",
  wrong_library: 'This folder belongs to another library.',
  wrong_backup: 'This folder belongs to another backup.',
  unreadable: "We can't read the backup folder.",
  path_conflict: 'A backup location contains a different file.',
  backup_missing: 'A backup copy is missing.',
  backup_changed: 'A backup copy has changed.',
  local_missing: 'An original is missing from this device.',
  local_changed: 'A local original has changed.',
  read_only: 'A folder is read-only.',
  no_space: "There isn't enough space.",
  permission_denied: "We don't have permission to open a file.",
  io_error: "We couldn't read or write a file.",
  transfer_failed: "We couldn't copy an original.",
  paused: 'Copying an original is paused.',
  cancelled: 'Copying an original was cancelled.',
  budget_unmet: "We couldn't meet the storage limit.",
};

const advice: Record<Exclude<BackupIssueCode, 'no_space' | 'read_only'>, string> = {
  folder_missing:
    'Connect the backup drive or share, then retry. Choose its folder if it has moved.',
  marker_missing:
    'Check that this is the intended backup folder, then choose the folder to confirm it.',
  marker_invalid:
    'Check the backup folder and its identification file before choosing the folder again.',
  wrong_library: 'Choose the backup folder for this library. Keep the files in this folder.',
  wrong_backup:
    'Choose the configured backup folder. Check both folders before changing the backup.',
  unreadable:
    'Connect the backup drive or share and check that this device can read it, then retry.',
  path_conflict: 'Compare both files before choosing which to keep, move, or replace, then retry.',
  backup_missing:
    'Look for another surviving copy. If the original is on this device, retry to back it up.',
  backup_changed:
    'Compare the backup file with another surviving copy before moving or replacing either file.',
  local_missing:
    'Look for another surviving copy on the backup or a synced device, then restore the original.',
  local_changed:
    'Compare the local original with the backup before moving or replacing either file.',
  permission_denied: 'Check access permissions for the file and its folder, then retry.',
  io_error: 'Check that the drive is connected and the file can be read, then retry.',
  transfer_failed: 'Check the backup drive and access permissions, then retry.',
  paused: 'Select Resume to continue the remaining original transfers.',
  cancelled: 'Select Retry to back up the remaining originals.',
  budget_unmet: 'Resolve the backup issues or raise the local storage limit, then retry.',
};

export const BackupStatusStrings = {
  loading: () => 'Reading backup status',
  readFailed: () => "We couldn't read the backup status. Retry to check the backup.",
  viewBackup: () => 'View backup',
  backUp: () => 'Back up now',
  retry: () => 'Retry',
  resume: () => 'Resume',
  reason: (code: BackupIssueCode) => reasons[code],
  advice: (code: BackupIssueCode, phase: BackupPhase) =>
    code === 'no_space'
      ? phase === 'restoring'
        ? 'Free storage on this device, then retry restoring the originals.'
        : 'Free storage on the backup drive, then retry.'
      : code === 'read_only'
        ? phase === 'restoring' || phase === 'offloading'
          ? 'Check the library read-only setting and folder permissions on this device, then retry.'
          : 'Check that the backup drive and folder allow changes, then retry.'
        : advice[code],
  issueCount: (code: BackupIssueCode, count: number) => `${count} · ${reasons[code]}`,
  currentIssues: (count: number) => `Current backup issues (${count})`,
  moreIssues: (count: number) =>
    `${count} more ${count === 1 ? 'issue is' : 'issues are'} included in the totals.`,
  lastBackup: () => 'Last backup report',
  lastRestore: () => 'Last restore report',
  reportOutcome: (outcome: BackupReport['outcome']) =>
    outcome === 'complete'
      ? 'Completed.'
      : outcome === 'partial'
        ? 'Completed with unresolved issues.'
        : "Couldn't complete.",
  backedUp: (count: number) => `Backed up ${originals(count)}.`,
  moved: (count: number) => `Updated ${count} backup ${count === 1 ? 'location' : 'locations'}.`,
  offloaded: (count: number) =>
    `Removed local copies of ${originals(count)} after checking the backup copies.`,
  restored: (count: number) => `Restored ${originals(count)}.`,
  coverage: (status: ConfiguredBackupStatus) =>
    `${status.coverage.backed_up} of ${originals(status.coverage.originals)} were last recorded on this backup.`,
  localStorage: (used: string, limit: string | null) =>
    limit == null
      ? `This device uses ${used} GB for originals.`
      : `This device uses ${used} of ${limit} GB for originals.`,
  offloadedCoverage: (count: number) =>
    `${originals(count)} ${count === 1 ? 'has' : 'have'} no local copy on this device.`,
  missingOriginals: (count: number) =>
    `We couldn't find ${originals(count)} on this device or this backup. Look for another copy before making changes.`,
  activity: (activity: BackupActivity) => {
    const phases: Record<BackupPhase, string> = {
      checking: 'Checking backup',
      moving: 'Updating backup folders',
      copying: `Backing up ${activity.done} of ${originals(activity.total)}`,
      offloading: 'Freeing local storage',
      restoring: `Restoring ${activity.done} of ${originals(activity.total)}`,
      configuring: 'Configuring backup folder',
    };
    return phases[activity.phase];
  },
  currentFile: ({ path, bytes_done, bytes_total }: NonNullable<BackupActivity['current']>) =>
    bytes_total == null
      ? `${path} · ${megabytes(bytes_done)} MB`
      : `${path} · ${megabytes(bytes_done)} of ${megabytes(bytes_total)} MB`,
  label: (status: ConfiguredBackupStatus): string => {
    switch (status.status) {
      case 'unavailable':
        return status.access === 'ready' ? 'Backup folder is unavailable.' : reasons[status.access];
      case 'working':
        return status.activity == null
          ? 'Backing up originals'
          : BackupStatusStrings.activity(status.activity);
      case 'attention': {
        if (status.coverage.missing_originals > 0)
          return `We couldn't find ${originals(status.coverage.missing_originals)} on this device or this backup.`;
        const issue = status.issues.counts.find(({ code }) => code !== 'paused');
        return issue == null ? 'Backup needs attention.' : reasons[issue.code];
      }
      case 'paused':
        return `Backup paused with ${originals(Math.max(status.coverage.pending, status.transfers.paused))} remaining`;
      case 'waiting':
        return `Waiting to back up ${originals(status.coverage.pending)}`;
      case 'current':
        return 'No originals are waiting to back up.';
      case 'empty':
        return 'This library has no originals to back up.';
    }
  },
};
