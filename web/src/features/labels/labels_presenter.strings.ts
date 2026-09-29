import { plural } from '../photos/photos_presenter.strings';

export const LabelsPresenterStrings = {
  couldNotLoadLabels: () => "We couldn't load your labels.",
  couldNotCreateLabel: () => "We couldn't create that label.",
  couldNotSaveLabels: () => "We couldn't save your labels. Try again in a moment.",
  couldNotChangeLabels: () => "We couldn't change the labels. Try again in a moment.",
  labelled: (count: number, label: string) =>
    `Added ${label} to ${plural(count, 'photo', 'photos')}.`,
};
