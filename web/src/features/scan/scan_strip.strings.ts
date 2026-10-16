function originals(count: number): string {
  return `${count} ${count === 1 ? 'original' : 'originals'}`;
}

export const ScanStripStrings = {
  scanning: (counted: boolean) => (counted ? 'reading files for changes' : 'looking for files'),
  stopping: () => 'stopping after the current batch',
  cellsLabel: (done: number, total: number) => `${done} of ${total} files`,
  count: (done: number, total: number) => ` · ${done}/${total} files`,
  rate: (perSecond: string) => ` · ${perSecond} files/s`,

  syncing: () => 'syncing',
  fetching: () => 'fetching',
  thumbnails: (count: number) =>
    `building thumbnails for ${count} ${count === 1 ? 'photo' : 'photos'}`,
  reading: (count: number) => `reading ${count} ${count === 1 ? 'photo' : 'photos'}`,
  rendering: (count: number) => `rendering ${count} ${count === 1 ? 'photo' : 'photos'}`,
  sending: (count: number) => `sending ${originals(count)}`,
};
