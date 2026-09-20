export const AlbumsPageStrings = {
  /** Names the collection wherever it is met: this page, the sidebar, the metadata row. */
  albums: () => 'Albums',
  albumName: () => 'Album name',
  createAlbum: () => 'Create album',
  noAlbumsYet: () => 'No albums yet',
  noAlbumsHint: () => 'Create an album to collect photos from any shoot or library.',
  deleteWarning: (albumName: string, memberships: number) =>
    `Delete the album "${albumName}"?\n\nYour ${memberships} ${memberships === 1 ? 'photo stays' : 'photos stay'} in their libraries. You can't recover this album.`,
};
