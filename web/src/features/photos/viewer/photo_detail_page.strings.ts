export const PhotoDetailStrings = {
  controls: () => 'Photo controls',
  details: () => 'Photo details',
  frameName: (filename: string, rendition: string) => `${filename}, ${rendition}`,
  showFilmstrip: () => 'Show filmstrip',
  hideFilmstrip: () => 'Hide filmstrip',

  pending: () => 'loading',
  notRecorded: () => 'not recorded',
  unknown: () => 'unknown',
  none: () => 'none',
  dimensions: (width: number, height: number) => `${width} × ${height}`,

  // A shutter speed, not `FormatStrings.seconds`'s elapsed duration.
  shutterSeconds: (seconds: string) => `${seconds} s`,
  shutterFraction: (denominator: number) => `1/${denominator} s`,
  body: (make: string, model: string) => `${make} ${model}`,
  aperture: (fNumber: string) => `f/${fNumber}`,
  focalLength: (millimetres: number) => `${millimetres} mm`,
  taken: (wallClock: string, offset: string) => `${wallClock} (UTC${offset})`,
  coordinates: (latitude: string, longitude: string) => `${latitude}, ${longitude}`,

  buildingGridRendition: () => ' · building the grid rendition',
  buildingViewRendition: () => ' · building this rendition',

  /** The same file, as an action rather than a heading. */
  downloadOriginal: () => 'Download original',
  openWith: () => 'Open in…',
  /** The picture on screen, into whatever else is on the device. */
  share: () => 'Share photo…',
  triageStack: () => 'Triage stack',
  /** What a photograph is in, wherever that is said: a badge on a tile, a row in this panel. */
  stateMissing: () => 'missing',
  // Drawn as a snowflake on a tile, where this is the whole of what says so to a screen reader.
  stateOnBackup: () => 'on the backup',
  /** Why an edit or an export of this photo takes longer than it used to. */
  stateOnBackupHint: () => 'No local copy. Opening this photo fetches it from the backup.',
  stateBinned: () => 'in Bin',
  // Drawn as the struck-through eye rather than the word, so it reads at the size a tile's badges
  // are - which leaves this as the whole of what says so to a screen reader.
  stateHidden: () => 'hidden',
  stateOk: () => 'available',

  edit: () => 'Edit',
  editMerge: () => 'Edit merge',
  editNeedsOriginal: () => 'Fetch original to edit',
  rebuildingRendition: () => 'Rebuilding rendition…',
  rebuildRendition: () => 'Rebuild rendition',
  renditionBehindEdits: () => 'Rendition needs your latest edits',

  finishCrop: () => 'Finish crop',
  finishPerspective: () => 'Finish perspective',
  /** The terminal affirmative: finish the grade, finish the session, close the dialog. */
  done: () => 'Done',
  /** Leave the editor with every edit from this session dropped. */
  cancel: () => 'Cancel',
  /** Reverse the last thing done - an edit, a round, a bin, a folder rule. */
  undo: () => 'Undo',
  redo: () => 'Redo',
  previousPhoto: () => 'Previous photo',
  nextPhoto: () => 'Next photo',
  hideMetadata: () => 'Hide metadata',
  showMetadata: () => 'Show metadata',
  more: () => 'More',

  sectionView: () => 'View',
  sectionRendition: () => 'Rendition',
  sectionActions: () => 'Actions',
  sectionSend: () => 'Share and download',
  sectionHelp: () => 'Help',

  rating: () => 'Rating',
  setRatingTo: (stars: number) => `Set rating to ${stars}`,

  notes: () => 'Notes',
  addANote: () => 'Add note',
  unsaved: () => 'unsaved',
  saved: () => 'saved',

  camera: () => 'Camera',
  cameraBody: () => 'Body',
  lens: () => 'Lens',
  iso: () => 'ISO',
  shutter: () => 'Shutter',
  apertureRow: () => 'Aperture',
  focalLengthRow: () => 'Focal length',
  takenRow: () => 'Taken',
  gps: () => 'GPS',

  edits: () => 'Edits',
  noEdits: () => 'No edits',
  // The editor names these inside a group heading, which this list has nothing of.
  luminanceNoise: () => 'Luminance noise',
  colourNoise: () => 'Colour noise',
  dustSensitivity: () => 'Dust sensitivity',
  dustIntensity: () => 'Dust intensity',
  dustRemovalOff: () => 'Off',
  rotate: () => 'Rotate',
  cropOfFrame: (width: number, height: number, aspect: string | null) =>
    aspect == null ? `${width}% × ${height}%` : `${width}% × ${height}% (${aspect})`,
  perspectiveCorrected: () => 'Corrected',
  removals: (count: number) => (count === 1 ? '1 removal' : `${count} removals`),

  renditionDetails: () => 'Rendition details',
  showing: () => 'Showing',
  dimensionsRow: () => 'Dimensions',
  fileSize: () => 'File size',
  format: () => 'Format',
  formatJpeg: () => 'JPEG',
  formatAvif: () => 'AVIF',
  colourSpace: () => 'Colour space',
  colourSpaceHdr: () => 'Rec.2020 PQ',
  colourSpaceSdr: () => 'sRGB',
  quality: () => 'Encoder quality',
  qualityNotApplicable: () => 'N/A',
  qualityValue: (quantizer: number) => `${quantizer}`,
  path: () => 'Path',
  embeddedPath: (path: string) => `${path} (embedded)`,

  added: () => 'Added',
  albumSeparator: () => ', ',
  state: () => 'State',
  error: () => 'Error',
  original: () => 'Original',

  fetching: () => 'fetching',
  fetchingPercent: (percent: number) => `, ${percent}%`,
  onAnotherDevice: () => 'on another device',
  tryAgain: () => 'Try again',
  fetchOriginal: () => 'Fetch original',

  photoUnavailable: () => 'Photo unavailable',
};
