import type { BackupReport } from '../../../../src/schemas/backup';

export const BackupPresenterStrings = {
  couldNotSetFolder: () => "We couldn't use that backup folder.",
  couldNotStop: () => "We couldn't remove the backup.",
  couldNotSetLimit: () => "We couldn't set the storage limit.",
  couldNotBackUp: () => "We couldn't back up the originals.",
  couldNotOpenFolder: () => "We couldn't open the backup folder",
  retryAdvice: () => 'Check the connection and backup folder, then retry.',
  chooseFolder: () => 'Choose a backup folder to back up the originals',
  failure: (title: string, detail: string) => `${title} ${detail}`,
  unfinished: (outcome: BackupReport['outcome']) =>
    outcome === 'partial'
      ? 'The backup finished with issues'
      : outcome === 'blocked'
        ? "The backup couldn't finish"
        : "The backup isn't finished yet",
  completed: (copied: number, moved: number, offloaded: number) => {
    if (copied > 0 && offloaded > 0)
      return `Backed up ${copied} ${copied === 1 ? 'original' : 'originals'} and removed ${offloaded} checked local ${offloaded === 1 ? 'copy' : 'copies'}`;
    if (copied > 0) return `Backed up ${copied} ${copied === 1 ? 'original' : 'originals'}`;
    if (moved > 0) return `Updated ${moved} backup ${moved === 1 ? 'location' : 'locations'}`;
    if (offloaded > 0)
      return `Removed ${offloaded} local ${offloaded === 1 ? 'copy' : 'copies'} after checking the backup`;
    return 'No originals are waiting to back up';
  },
};
