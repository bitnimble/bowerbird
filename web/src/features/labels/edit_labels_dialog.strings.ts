import { plural } from '../photos/photos_presenter.strings';

export const EditLabelsStrings = {
  open: () => 'Edit labels…',
  title: () => 'Edit labels',
  library: () => 'Library',
  switchLibraryQuestion: () => 'Switch library?',
  discardWarning: () => "Your changes to this one won't be saved.",
  switchLibrary: () => 'Switch',
  labelName: () => 'Label name',
  colourFor: (label: string) => `Colour for ${label}`,
  reorder: (label: string) => `Move ${label}`,
  delete: (label: string) => `Delete ${label}`,
  deleteQuestion: (label: string) => `Delete ${label}?`,
  deleteWarning: (count: number) => `It's on ${plural(count, 'photo', 'photos')}.`,
  confirmDelete: () => 'Delete',
  duplicate: () => 'You already have a label with this name.',
  // Makes a new label, where the photo viewer's "Add label" puts one on a photo.
  newLabel: () => 'Add label',
  noLabels: () => 'No labels yet.',
  save: () => 'Save',
};
