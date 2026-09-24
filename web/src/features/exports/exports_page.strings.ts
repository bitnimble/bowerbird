export const ExportsPageStrings = {
  exports: () => 'Exports',
  // What the sidebar's entry becomes while anything is queued.
  exporting: (photos: number) => (photos === 1 ? 'Exporting 1 photo' : `Exporting ${photos} photos`),
  exportingCount: (done: number, total: number) => `Exporting ${Math.min(done + 1, total)} of ${total}`,
  inProgress: () => 'In progress',
  exportHistory: () => 'Export history',
  photographs: (photos: number) => (photos === 1 ? '1 photo' : `${photos} photos`),
  waitingToExport: (photos: number) => (photos === 1 ? '1 photo waiting' : `${photos} photos waiting`),
  stoppingExport: () => 'Stopping after this photo',
  stopExport: () => 'Stop this export',
  removeFromQueue: () => 'Remove from queue',
  nothingExported: () => 'Nothing exported yet',
  nothingExportedHint: () => 'Export photos to see their settings and destination here.',
  couldNotLoad: () => "We couldn't load your export history. Try again.",
  couldNotRemove: () => "We couldn't remove that export from history. Try again.",
  couldNotShowFile: () => "We couldn't show that export in its folder. Check if it moved.",
  exportedPhotos: (photos: number) => `Exported ${photos} ${photos === 1 ? 'photo' : 'photos'}.`,
  original: () => 'Original',
  library: () => 'Library',
  // The row outlives the photograph, and where a file went is worth keeping after the
  // catalogue has stopped holding what it came from.
  photographGone: () => 'Photo missing from catalogue',
  writtenTo: () => 'Written to',
  edits: () => 'Edits',
  // The settings this one export was written with, which are not necessarily the ones the
  // photograph carries now.
  editsInThisExport: () => 'Edits in this export',
  exportActions: () => 'Export actions',
  goToPhoto: (sourcePath: string) => `Go to ${sourcePath}`,
  removeFromHistory: () => 'Remove from history',
};
