function originals(count: number): string {
  return `${count} ${count === 1 ? 'original' : 'originals'}`;
}

function photos(count: number): string {
  return `${count} ${count === 1 ? 'photo' : 'photos'}`;
}

export const ScanStripStrings = {
  scanning: (counted: boolean) => (counted ? 'reading files for changes' : 'looking for files'),
  stopping: () => 'stopping after the current batch',
  cellsLabel: (done: number, total: number) => `${done} of ${total} files`,
  count: (done: number, total: number) => ` · ${done}/${total} files`,
  rate: (perSecond: string) => ` · ${perSecond} files/s`,

  syncing: () => 'syncing',
  fetching: () => 'fetching',
  thumbnails: (count: number) => `building thumbnails for ${photos(count)}`,
  reading: (count: number) => `reading ${photos(count)}`,
  rendering: (count: number) => `rendering ${photos(count)}`,
  thumbnailsQueued: (count: number) => `waiting to build thumbnails for ${photos(count)}`,
  readingQueued: (count: number) => `waiting to read ${photos(count)}`,
  renderingQueued: (count: number) => `waiting to render ${photos(count)}`,
  sending: (count: number) => `sending ${originals(count)}`,
};
