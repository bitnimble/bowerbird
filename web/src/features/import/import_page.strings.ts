import type { PhotoFormat } from '../../../../src/schemas/photos';
import { GridControlsStrings } from '../photos/grid/grid_controls.strings';
import { plural } from '../photos/photos_presenter.strings';

export const ImportPageStrings = {
  importPhotos: () => 'Import',
  addingCount: (done: number, total: number) => `Adding ${done} of ${total}`,

  source: () => 'Source',
  chooseDisk: () => 'Choose a disk',
  destination: () => 'Library',
  shoot: () => 'Shoot',
  libraryRoot: () => 'Library root',
  newShoot: () => 'New shoot',
  newShootName: () => 'Shoot name',
  scan: () => 'Scan',
  scanning: () => 'Scanning',
  noWritableLibrary: () => 'No library to add to',
  noWritableLibraryHint: () => 'Add a library you can write to first.',

  someFoldersUnread: () => "Some folders couldn't be read.",
  unlisted: (count: number) =>
    `This library only takes RAW files. ${plural(count, 'other file', 'other files')} ${count === 1 ? "isn't" : "aren't"} listed.`,
  nothingFound: () => 'No photos found',
  nothingFoundHint: () => 'This folder and the ones inside it hold no photos.',
  nothingMatches: () => 'No photos match these filters',

  selectedCount: (selected: number, total: number) => `${selected} of ${total} selected`,
  selectAll: () => 'Select all',
  selectNone: () => 'Select none',
  showPairsAsOne: () => 'Show RAW+JPEG as 1 photo',
  addToLibrary: () => 'Add to library',
  stopAdding: () => 'Stop adding',

  mergedBadge: (formats: readonly PhotoFormat[]) =>
    ['RAW', ...formats.map((format) => GridControlsStrings.fileFormat(format))].join('+'),
  alreadyInLibrary: () => 'Already in library',
  hideAlreadyInLibrary: () => 'Hide already in library',

  added: (count: number) => `Added ${plural(count, 'file', 'files')} to the library.`,
  notAllAdded: (failed: number) => `We couldn't copy ${plural(failed, 'file', 'files')}.`,
  failedNames: (failed: number, names: readonly string[]) =>
    `We couldn't copy ${plural(failed, 'file', 'files')}: ${names.join(', ')}.`,
};
