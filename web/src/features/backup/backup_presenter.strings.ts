export const BackupPresenterStrings = {
  couldNotReadBackups: () => "Couldn't read the backup settings",
  couldNotSetFolder: () => "Couldn't use that folder",
  couldNotStop: () => "Couldn't stop backing up",
  couldNotSetLimit: () => "Couldn't set the storage limit",
  couldNotBackUp: () => "Couldn't back up",
  upToDate: () => 'The backup is up to date.',
  copied: (photos: number) => `Copied ${photos} ${photos === 1 ? 'photo' : 'photos'} to the backup.`,
  removedLocalCopies: (removed: number) =>
    `Removed ${removed} local ${removed === 1 ? 'copy' : 'copies'} kept on the backup.`,
  copiedAndRemoved: (photos: number, removed: number) =>
    `Copied ${photos} ${photos === 1 ? 'photo' : 'photos'}, and removed ${removed} local ${removed === 1 ? 'copy' : 'copies'}.`,
};
