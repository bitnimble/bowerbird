export const BackupStrings = {
  heading: () => 'Backup',
  noFolder: () => 'Copy every original to a folder, drive, or share.',
  chooseFolder: () => 'Choose folder',
  folderLabel: () => 'Backup folder',
  folderPlaceholder: () => '/Volumes/NAS/Photos',
  backUpNow: () => 'Back up now',
  backingUp: () => 'Backing up…',
  stop: () => 'Stop backing up',
  /** What unpairing does and does not do, which is the question a reader has before pressing it. */
  stopWarning: (name: string) =>
    `Stop backing up to "${name}"?\n\nEvery file already there stays. Photos with no local copy can't be opened until you back up to this folder again.`,
  unavailable: () => "Can't reach this folder. Connect it, then back up again.",
  backedUp: (photos: number, owed: number) =>
    `${photos} ${photos === 1 ? 'photo' : 'photos'} backed up · ${owed} to copy`,
  allBackedUp: (photos: number) => `${photos} ${photos === 1 ? 'photo' : 'photos'} backed up`,
  storageLimit: () => 'Storage limit',
  gigabytes: () => 'GB',
  /** Why the field exists, said once under it: the limit is what the removal follows from. */
  storageLimitHint: () => "Above this, we'll remove the local copies you've used least recently. They stay on the backup.",
  usingOf: (used: string, limit: string) => `Using ${used} GB of ${limit} GB`,
  using: (used: string) => `Using ${used} GB`,
  onBackupOnly: (photos: number) => `${photos} ${photos === 1 ? 'photo has' : 'photos have'} no local copy`,
};
