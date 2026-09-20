import { type CompositeKind } from '../../../../../src/schemas/photos';

export const PhotoGridStrings = {
  // A composite is named by what it is: the photograph the row happens to be drawn from is one
  // frame of several and its name says nothing about the picture on the tile.
  tile: (selected: boolean, stackSize: number | null, filename: string, composite: CompositeKind | null) =>
    `${selected ? 'selected, ' : ''}${
      stackSize == null ? `photo ${filename}`
      : composite === 'panorama' ? `panorama of ${stackSize} photos`
      : composite === 'assembly' ? `merge of ${stackSize} photos`
      : `stack of ${stackSize}, photo ${filename}`
    }`,
  pick: (filename: string) => `Select photo ${filename}`,
  /**
   * What a composite is called where a photograph would be called by its filename.
   *
   * It has none: nothing wrote a file for it, and naming it after any one of its frames would
   * name it after a third of the picture. A merge's is never drawn under its tile, only read out.
   */
  compositeName: (count: number, composite: CompositeKind) =>
    composite === 'panorama' ? `Panorama of ${count} photos` : `Merge of ${count} photos`,
  /** The chip on a composite's tile, which opens the frames it was merged from. */
  showCompositeFrames: (count: number, composite: CompositeKind) =>
    `Show the ${count} frames of this ${composite === 'panorama' ? 'panorama' : 'merge'}`,
  noDate: () => 'No date',
  notInThisShoot: () => 'Not in this shoot',
  bandLabel: (count: number) => `${count} photos in this stack`,
  /** The same band, opened off a composite's badge, which stands for frames rather than a stack. */
  frameBandLabel: (count: number, composite: CompositeKind) =>
    `${count} frames of this ${composite === 'panorama' ? 'panorama' : 'merge'}`,
  /** The badge on a tile whose stack the filter has left showing one photograph. */
  showStack: (filename: string) => `Show the stack ${filename} is in`,
  /**
   * The grid's own name to a reader. Its rows, not its photographs, which the
   * readout beside the controls says: this is what `aria-setsize` counts, and a
   * collapsed stack is one row of it standing for several.
   */
  gridLabel: (rows: number) => `${rows} photos`,

  loadingPhotos: () => 'Loading photos…',
  couldNotLoad: () => "We couldn't load these photos. Try again.",
  noPhotosMatchFilter: () => 'No photos match this filter',
  nothingHereYet: () => 'No photos here',
  tryADifferentFilter: () => 'Try another filter or select All.',
  /** What fills an album or a shoot, which is the same act from the same place. */
  addFromLibraryHint: () => 'From the library, select photos to add here.',

  filmstripSize: () => 'Filmstrip size',
  scrollbar: () => 'Scroll through photos',
  scrollbarPosition: (position: number, total: number) => `photo ${position} of ${total}`,
};
