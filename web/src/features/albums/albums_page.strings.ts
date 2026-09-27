export const AlbumsPageStrings = {
  /** Names the collection wherever it is met: this page, the sidebar, the metadata row. */
  albums: () => 'Albums',
  albumName: () => 'Album name',
  createAlbum: () => 'Create album',
  noAlbumsYet: () => 'No albums yet',
  noAlbumsHint: () => 'Create an album to collect photos from any shoot or library.',
  deleteQuestion: (albumName: string) => `Delete the album "${albumName}"?`,
  deleteWarning: (memberships: number) =>
    `Your ${memberships} ${memberships === 1 ? 'photo stays' : 'photos stay'} in their libraries. You can't recover this album.`,
};
