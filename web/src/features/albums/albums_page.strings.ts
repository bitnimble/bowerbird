export const AlbumsPageStrings = {
  /** Names the collection wherever it is met: this page, the sidebar, the metadata row. */
  albums: () => 'Albums',
  albumName: () => 'Album name',
  createAlbum: () => 'Create album',
  noAlbumsYet: () => 'No albums yet',
  noAlbumsHint: () => 'Create an album to collect photos from any shoot or library.',
  deleteQuestion: (albumName: string) => `Delete the album "${albumName}"?`,
  deleteWarning: (memberships: number) =>
    memberships === 0
      ? "You can't recover this album"
      : `${memberships === 1 ? 'Your photo stays in its library' : `Your ${memberships} photos stay in their libraries`}. You can't recover this album.`,
};
