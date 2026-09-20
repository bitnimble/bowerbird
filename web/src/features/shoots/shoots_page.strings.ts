export const ShootsPageStrings = {
  viewFlat: () => 'Flat',
  viewTree: () => 'Tree',
  viewAllFolders: () => 'All folders',

  /** Names the collection wherever it is met: this page and the sidebar. */
  shoots: () => 'Shoots',
  howToShowFolders: () => 'How to show folders',

  libraryRoot: () => 'Library root',
  addToLibraryRoot: () => 'Add to the library root',
  createShootInSubfolder: () => 'Create shoot in subfolder',

  readingFolders: () => 'Reading folders…',
  noShootsYet: () => 'No shoots yet',
  nothingHereHint: () => 'Scan the library or create a shoot.',

  addAsShoot: () => 'Add as shoot',

  // Hiding takes the whole subtree, and nothing on disk moves, so neither word says "delete".
  hideShoot: () => 'Hide shoot',
  unhideShoot: () => 'Unhide shoot',
  showHiddenShoots: () => 'Show hidden shoots',
  /** Distinct from the grid's "Grid options", the two being different pages' menus. */
  shootOptions: () => 'Shoot options',

  /** How many photographs a shoot's deletion is about. */
  photoCount: (count: number) => `${count} ${count === 1 ? 'photo' : 'photos'}`,
};
