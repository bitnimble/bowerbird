import { type Ordering } from '../../../../../src/schemas/common';
import { plural } from '../photos_presenter.strings';

export const GridControlsStrings = {
  ordering: (ordering: Ordering) =>
    ({
      taken_desc: 'Newest first',
      taken_asc: 'Oldest first',
      added_desc: 'Recently added',
      added_asc: 'First added',
    })[ordering],

  viewActive: () => 'Active',
  viewUntriaged: () => 'Untriaged',
  viewPicks: () => 'Picks',
  viewRejects: () => 'Rejects',
  viewAll: () => 'All',

  sectionTriageStatus: () => 'Triage status',
  sectionCamera: () => 'Camera',
  sectionShotDate: () => 'Shot date',

  customUnrated: () => 'Unrated',
  customRated: () => 'Rated',
  customMissingFile: () => 'Missing file',
  customHidden: () => 'Hidden',

  findByFilename: () => 'Find by filename',
  filenamePlaceholder: () => 'Filename',

  anyDate: () => 'Any date',
  /** Names the two selects the calendar's caption is, each of which shows its own value. */
  calendarMonth: () => 'Month',
  calendarYear: () => 'Year',
  /** The calendar's arrows are a glyph apiece, and say neither for themselves. */
  previousMonth: () => 'Previous month',
  nextMonth: () => 'Next month',

  resetFilters: () => 'Reset all filters',

  filterCameraBody: () => 'Camera body',
  filterLens: () => 'Lens',

  filters: () => 'Filters',
  filtersWithCount: (count: number) => `Filters (${count})`,

  thumbnailSize: () => 'Thumbnail size',
  /** How many photographs the collection holds, as the readout beside the controls. */
  photoCount: (photos: number) => plural(photos, 'photo', 'photos'),

  modeGrid: () => 'Grid',
  modeMasonry: () => 'Masonry',
  modeList: () => 'List',
  /** The control's own name to a screen reader; `sectionView` is the heading it sits under. */
  viewMode: () => 'View mode',
  sectionView: () => 'View',

  // Distinct from the bulk bar's "More actions", the two sitting a row apart.
  gridOptions: () => 'Grid options',
  showFilenames: () => 'Show filenames',
  showTriageBadges: () => 'Show triage badges',
  showRatingBadges: () => 'Show rating badges',
  sectionSelection: () => 'Selection',
  selectAll: () => 'Select all',
  selectVisible: () => 'Select visible',

  filterPhotos: () => 'Filter photos',
  /** The whole name of the sort control, which is an icon and so says neither half for itself. */
  sortedBy: (ordering: string) => `Sort photos: ${ordering}`,
  expandAllStacks: () => 'Expand all stacks',
};
