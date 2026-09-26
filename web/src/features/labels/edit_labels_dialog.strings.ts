import { plural } from '../photos/photos_presenter.strings';

export const EditLabelsStrings = {
  open: () => 'Edit labels…',
  title: () => 'Edit labels',
  library: () => 'Library',
  discardWarning: () => "Switch library? Your changes to this one won't be saved.",
  labelName: () => 'Label name',
  colourFor: (label: string) => `Colour for ${label}`,
  reorder: (label: string) => `Move ${label}`,
  delete: (label: string) => `Delete ${label}`,
  deleteWarning: (label: string, count: number) => `Delete ${label}? It's on ${plural(count, 'photo', 'photos')}.`,
  duplicate: () => 'You already have a label with this name.',
  // Makes a new label, where the photo viewer's "Add label" puts one on a photo.
  newLabel: () => 'Add label',
  noLabels: () => 'No labels yet.',
  save: () => 'Save',
};
