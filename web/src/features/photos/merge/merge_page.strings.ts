import type { CaptureSequenceKind } from '../../../../../src/schemas/capture_sequence';
import { MERGE_MAX_FRAMES } from '../photos_store';

export const MergePageStrings = {
  mergePhotos: () => 'Merge photos',
  toPanorama: () => 'To panorama',
  takeBestParts: () => 'Take best parts',
  bracket: (kind: CaptureSequenceKind | null) => {
    if (kind === 'pixelShift') return 'Pixel shift';
    if (kind === 'exposureBracket') return 'Exposure bracket';
    return 'Bracket';
  },
  selectABracketStack: () => 'Select one bracket stack.',

  selectAtLeastTwo: () => 'Select at least 2 photos.',
  selectTwelveOrFewer: () => `Select up to ${MERGE_MAX_FRAMES} photos.`,
  selectOneLibrary: () => 'Select photos from 1 library.',
  cannotMergeAComposite: () => "You can't merge a merged photo again.",
  loadTheSelectionFirst: () => 'Scroll to the selected photos first.',

  analysing: (progress: number) => `Analysing photos… ${Math.round(progress * 100)}%`,
  // Both the way out of a finished merge and the way out of the carve that precedes it: the
  // reader is leaving without a photograph either way, and the carve is what they are leaving.
  cancel: () => 'Cancel',
  couldNotAnalyse: () => "We couldn't analyse these photos. Try again.",
  couldNotOpen: () => "We couldn't open this merge. Return to the library and try again.",
  toggleTileLines: () => 'Show or hide tile lines',
  removeObjects: () => 'Remove objects',
  blend: () => 'Blend',
  unaligned: () => 'These photos do not line up. Try another set for a clearer merge.',
  blendPercent: (percent: number) => `${percent}% of the long edge`,
  undo: () => 'Undo',
  redo: () => 'Redo',
  readOnlyMissingSources: (missing: string[]) =>
    missing.length === 1 ?
      'A frame is missing. Restore it before merging.'
    : 'Frames are missing. Restore them before merging.',
  tileLabel: (tile: number) => `Tile ${tile + 1}`,

  pickSwatch: (index: number) => `Choose frame ${index + 1}`,
  swatchAlt: (index: number) => `Frame ${index + 1} over this tile`,
  searching: () => 'Finding the best parts of each frame…',
  save: () => 'Save',
};
