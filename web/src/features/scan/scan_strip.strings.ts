function originals(count: number): string {
  return `${count} ${count === 1 ? 'original' : 'originals'}`;
}

export const ScanStripStrings = {
  scanning: (counted: boolean) =>
    counted ? 'reading files for changes'
    : 'looking for files',
  stopping: () => 'stopping after the current batch',
  cellsLabel: (done: number, total: number) => `${done} of ${total} files`,
  count: (done: number, total: number) => ` · ${done}/${total} files`,
  rate: (perSecond: string) => ` · ${perSecond} files/s`,
  eta: (duration: string) => ` · about ${duration} left`,

  syncing: () => 'syncing',
  fetching: () => 'fetching',
  rendering: (count: number) => `rendering ${count} ${count === 1 ? 'photo' : 'photos'}`,
  fetchingFromBackup: () => 'fetching originals from the backup',
  sending: (count: number) => `sending ${originals(count)}`,
  backingUp: (count: number) => `backing up ${originals(count)}`,
  backingUpNow: () => 'backing up',
};
