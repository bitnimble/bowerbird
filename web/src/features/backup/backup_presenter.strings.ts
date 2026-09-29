import type { BackupReport } from '../../../../src/schemas/backup';

export const BackupPresenterStrings = {
  couldNotSetFolder: () => "Couldn't use that backup folder.",
  couldNotStop: () => "Couldn't remove the backup.",
  couldNotSetLimit: () => "Couldn't set the storage limit.",
  couldNotBackUp: () => "Couldn't back up the originals.",
  couldNotOpenFolder: () => "Couldn't open the backup folder.",
  retryAdvice: () => 'Check the connection and backup folder, then retry.',
  chooseFolder: () => 'Choose a backup folder to back up the originals.',
  failure: (title: string, detail: string) => `${title} ${detail}`,
  unfinished: (outcome: BackupReport['outcome']) => outcome === 'partial' ? 'The backup completed with unresolved issues.'
    : outcome === 'blocked' ? "The backup couldn't complete." : 'The backup still has work remaining.',
  completed: (copied: number, moved: number, offloaded: number) => {
    if (copied > 0 && offloaded > 0) return `Backed up ${copied} originals and removed ${offloaded} checked local copies.`;
    if (copied > 0) return `Backed up ${copied} ${copied === 1 ? 'original' : 'originals'}.`;
    if (moved > 0) return `Updated ${moved} backup ${moved === 1 ? 'location' : 'locations'}.`;
    if (offloaded > 0) return `Removed ${offloaded} local ${offloaded === 1 ? 'copy' : 'copies'} after checking the backup.`;
    return 'No originals are waiting to back up.';
  },
};
