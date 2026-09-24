export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const PhotosPresenterStrings = {
  refreshedMetadata: (updated: number) => `Updated details for ${plural(updated, 'photo', 'photos')}.`,
  movedIntoShoot: (count: number) => `Moved ${plural(count, 'photo', 'photos')} into the shoot.`,
  addedToAlbum: (count: number) => `Added ${plural(count, 'photo', 'photos')} to the album.`,
  movedBackToLibraryRoot: (count: number) => `Moved ${plural(count, 'photo', 'photos')} to the library root.`,
  removedFromAlbum: (count: number) => `Removed ${plural(count, 'photo', 'photos')} from the album.`,
  restored: (count: number) => `Restored ${plural(count, 'photo', 'photos')}.`,
  hidden: (count: number) => `Hid ${plural(count, 'photo', 'photos')}.`,
  unhidden: (count: number) => `Unhid ${plural(count, 'photo', 'photos')}.`,
  shootThumbnailSet: () => 'Shoot thumbnail updated.',
  albumThumbnailSet: () => 'Album thumbnail updated.',
  rebuiltThumbnails: (queued: number) => `Queued ${plural(queued, 'thumbnail', 'thumbnails')} to rebuild.`,
  movedToBin: (deleted: number) => `Moved ${plural(deleted, 'photo', 'photos')} to the Bin.`,
  preparingShare: () => 'Preparing to share…',
  shareFailed: () => "We couldn't prepare this photo to share. Try again.",
  openWithFailed: () => "We couldn't open this photo in another app. Try again.",
  revealFailed: () => "We couldn't open this photo's folder. Check the file is on this device.",
  // What the merge is doing right now, so a minute of nothing visible is a minute the reader can
  // read. The phases are the picture being assembled, not the machinery: nobody merging a
  // panorama wants to be told about strips.
  mergingToPanorama: (phase: 'aligning' | 'tile' | 'picture') => {
    if (phase === 'aligning') return 'Merging panorama… finding how the frames overlap';
    if (phase === 'tile') return 'Merging panorama… building the thumbnail';
    return 'Merging panorama… rendering the photo';
  },
};
