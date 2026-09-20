export const DeleteShootStrings = {
  title: (shootName: string) => `Delete ${shootName}?`,
  fallbackName: () => 'shoot',
  /** The folder path is a `<code>` between these two, so the sentence is in two pieces. */
  filesStayBefore: () => 'The folder ',
  filesStayAfter: () => ' and its files stay on disk',

  question: () => 'What happens to the photos?',
  keep: () => 'Keep photos in library',
  keepHint: () => 'Your photos keep their ratings and leave this shoot.',
  removeOption: () => 'Remove photos from library',
  removeHint: (photographs: string) => `Ratings, verdicts, and notes on ${photographs} will be lost. Your files stay on disk.`,

  thePhotographs: () => 'the photos',

  deleteShoot: () => 'Delete shoot',
  deleteShootAndPhotos: (photographs: string) => `Delete shoot and ${photographs}`,
};
