export const TileMenuStrings = {
  menu: () => 'Photo actions',
  open: () => 'Open',
  copyEdits: () => 'Copy edits',
  pasteEdits: (count: number) => (count === 1 ? 'Paste edits' : `Paste edits to ${count} photos`),
  nothingCopied: () => 'Copy the edits of a photo first.',
};
