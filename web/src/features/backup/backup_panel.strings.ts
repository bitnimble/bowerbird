function photos(count: number): string {
  return `${count} ${count === 1 ? 'photo' : 'photos'}`;
}

export const BackupStrings = {
  heading: () => 'Backup',
  noFolder: () => 'Copy every original to a folder, drive, or share.',
  chooseFolder: () => 'Choose folder',
  folderLabel: () => 'Backup folder',
  folderPlaceholder: () => '/Volumes/NAS/Photos',
  backingUp: () => 'Backing up…',
  remove: () => 'Remove backup',
  removeTitle: (name: string) => `Remove backup folder "${name}"?`,
  removeKeepsFiles: () => 'Every file already on the backup stays there.',
  removeStrandsPhotos: (offloaded: number) =>
    `${photos(offloaded)} ${offloaded === 1 ? 'has' : 'have'} no local copy. Fetch ${offloaded === 1 ? 'it' : 'them'} to this device first, or ${offloaded === 1 ? 'it' : 'they'} can't be opened until you choose this folder again.`,
  fetchAndRemove: () => 'Fetch and remove',
  removeWithoutFetching: () => 'Remove without fetching',
  fetching: () => 'Fetching…',
  preparingFetch: () => 'Finding photos to fetch…',
  fetchedOf: (done: number, total: number) => `${done} of ${photos(total)} fetched`,
  fetchingFile: (path: string, percent: number) => `${path} · ${percent}%`,
  unavailable: () => "Can't reach this folder. Connect it, then back up again.",
  summary: (status: {
    backedUp: number;
    owed: number;
    used: string;
    limit: string | null;
    offloaded: number;
    path: string;
  }) =>
    [
      `${photos(status.backedUp)} backed up`,
      ...(status.owed > 0 ? [`${status.owed} to copy`] : []),
      status.limit == null ? `using ${status.used} GB` : `using ${status.used} of ${status.limit} GB`,
      ...(status.offloaded > 0 ? [`${status.offloaded} with no local copy`] : []),
      status.path,
    ].join(' · '),
  storageLimit: () => 'Local storage limit',
  gigabytes: () => 'GB',
  /** Why the field exists, said once under it: the limit is what the removal follows from. */
  storageLimitHint: () => "Above this, we'll remove the local copies you've used least recently. They stay on the backup.",
  storageLimitReadOnly: () => 'Read-only libraries cannot remove local originals.',
};
