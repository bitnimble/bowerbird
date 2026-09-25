export const BulkBarStrings = {
  rebuildThumbnails: () => 'Rebuild thumbnails',
  refreshMetadata: () => 'Update photo details',
  // The ellipsis is the promise the dialog keeps: nothing is written until the
  // reader has answered the format, the size and where the files go.
  exportPhotos: () => 'Export photos…',

  /** The action, wherever it is offered or documented: this bar, the viewer's menu, the shortcut sheet. */
  moveToBin: () => 'Move to Bin',
  moveAllToBin: () => 'Move all to Bin',
  moveCountToBin: (count: number) => `Move ${count} to Bin`,

  /** Hiding keeps every file and every edit, so it says nothing about deleting. */
  hide: () => 'Hide',
  unhide: () => 'Unhide',
  hideCount: (count: number) => `Hide ${count} ${count === 1 ? 'photo' : 'photos'}`,
  unhideCount: (count: number) => `Unhide ${count} ${count === 1 ? 'photo' : 'photos'}`,

  selection: () => 'Selection',
  allSelected: () => 'all selected',
  countSelected: (count: number) => `${count} selected`,
  clear: () => 'Clear',

  stack: () => 'Stack',
  unstack: () => 'Unstack',
  removeFromStack: () => 'Remove from stack',
  triageThisStack: () => 'Triage this stack',
  // What each refusal wants instead, since the row is greyed rather than gone and
  // the reader is holding a selection that nearly works.
  selectAStack: () => 'Select a stack first',
  selectOneStack: () => 'Select 1 whole stack.',
  selectWholeStack: () => 'Select every photo in the stack.',

  setShootThumbnail: () => 'Set as shoot thumbnail',
  setAlbumThumbnail: () => 'Set as album thumbnail',
  setFirstAsShootThumbnail: () => 'Set first photo as shoot thumbnail',
  setFirstAsAlbumThumbnail: () => 'Set first photo as album thumbnail',

  /** Every action a read-only library refuses, wherever it is offered. */
  notOnReadOnlyLibrary: () => 'Turn off read-only mode to use this action.',
  restoreRefused: () => 'Turn off read-only mode to restore photos.',
  restoreToOriginalLocation: () => 'Restore to original location',

  // A shoot is a folder, so a photograph already in one leaves it.
  addToShoot: () => 'Add to shoot',
  moveToShoot: () => 'Move to another shoot',
  addToNewShoot: () => 'Add to new shoot…',
  moveToNewShoot: () => 'Move to new shoot…',
  addToAlbum: () => 'Add to album',
  addToNewAlbum: () => 'Add to new album…',
  removeFrom: (name: string) => `Remove from ${name}`,

  removeLocalCopy: () => 'Remove local copy',
  keptOn: (peerName: string) => `Kept on ${peerName}`,
  removeLocalCopyWarning: (peerName: string, count: number, allSelected: boolean) =>
    `Remove ${
      count < 2 ? 'this local copy'
      : allSelected ? 'every selected local copy'
      : `${count} local copies`
    } from this device?\n\n` +
    `${peerName} must confirm each original. Unconfirmed files stay here. Your catalogue and edits stay, and you can fetch the originals again.`,

  moreActions: () => 'More actions',
};
