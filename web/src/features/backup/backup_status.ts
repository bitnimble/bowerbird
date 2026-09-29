import type { ConfiguredBackupStatus } from '../../../../src/schemas/backup';
import { BackupStatusStrings } from './backup_status.strings';

export function backupPresentation(status: ConfiguredBackupStatus): {
  label: string;
  tone: 'error' | undefined;
  state: 'working' | 'idle';
  action: 'backUp' | 'retry' | 'resume' | null;
} {
  return {
    label: BackupStatusStrings.label(status),
    tone: status.status === 'unavailable' || status.status === 'attention' ? 'error' : undefined,
    state: status.status === 'working' ? 'working' : 'idle',
    action:
      status.status === 'working'
        ? null
        : status.status === 'paused'
          ? 'resume'
          : status.status === 'unavailable' || status.status === 'attention'
            ? 'retry'
            : 'backUp',
  };
}
