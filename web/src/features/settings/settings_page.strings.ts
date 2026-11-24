import type { Library } from '../../../../src/schemas/libraries';

export const SettingsStrings = {
  resetSetting: (label: string) => `Reset ${label}`,

  stop: () => 'Stop',
  stopping: () => 'Stopping…',
  scanNow: () => 'Scan library',
  openLibraryFolder: () => 'Open library folder',
  libraryActions: () => 'Library actions',
  removeLibrary: () => 'Remove library',
  remove: () => 'Remove',
  removeLibraryQuestion: (libraryName: string) => `Remove "${libraryName}" from Bowerbird?`,
  removeLibraryWarning: (photoCount: number) =>
    `Your ${photoCount} ${photoCount === 1 ? 'photo stays' : 'photos stay'} on disk. Ratings, notes, Picks, albums, and shoots can't be recovered.`,
  libraryPhotoCount: ({
    photo_count,
    missing_photo_count,
    unavailable_photo_count,
    rendered_photo_count,
  }: Pick<
    Library,
    'photo_count' | 'missing_photo_count' | 'unavailable_photo_count' | 'rendered_photo_count'
  >) =>
    `${photo_count} ${photo_count === 1 ? 'photo' : 'photos'} (${missing_photo_count} missing, ${unavailable_photo_count} unavailable, ${rendered_photo_count} rendered)`,
  /** Opens one library's settings; `settings` names the whole page. */
  openLibrarySettings: () => 'Settings',
  librarySettingsTitle: (libraryName: string) => `Settings for ${libraryName}`,
  /** What a library is called, asked for here and when one is added. */
  libraryName: () => 'Library name',

  folders: () => 'Folders',
  libraryFolder: () => 'Library folder',
  libraryFolderHint: () => "Changing this won't move any files",
  includeSubfolders: () => 'Include subfolders',
  includeNonRaw: () => 'Import JPEG, PNG, HEIC, and AVIF too',
  includeNonRawHint: () => 'Show RAW+JPEG pairs as 1 photo',
  /** The flag and its one line, here and in the add-library dialog. */
  readOnly: () => 'Read-only mode',
  readOnlyHint: () => "Don't change any photo files on disk",

  binFolderName: () => 'Bin folder name',

  foldersSetAside: () => 'Folders set aside',
  ruleExcluded: () => 'Excluded from this library',
  ruleNotAShoot: () => 'Included, but not a shoot',

  renditions: () => 'Renditions',
  preRenderImported: () => 'Automatically pre-render imported RAWs',
  buildHdrRenditions: () => 'Render photos in HDR',

  renderStages: () => 'Automatic pre-rendering',
  renderStagesHint: () =>
    'Choose which edits run when you import a RAW to balance quality and speed',
  renderStagesNeedLibrary: () => 'Add a library to change this',
  stageDenoise: () => 'Denoise',
  stageColour: () => 'Match camera colour',
  stagesOther: () => 'Other',
  stageCost: (ms: number) => (ms === 0 ? 'No measurable saving' : `~${ms} ms`),
  stagesTotal: () => 'Total',
  totalCost: (ms: number) => `~${ms} ms`,
  stagesEstimated: () => 'Estimated',
  stagesMeasured: (relative: string) => `Measured ${relative}`,
  measureStages: () => 'Measure',
  measuringStages: () => 'Measuring…',
  measureStagesBusy: () => 'A measurement is already running',

  stacks: () => 'Stacks',
  autoStack: () => 'Group similar photos automatically',
  autoStackHint: () => 'Takes effect after the next library scan',

  libraryJobs: () => 'Library jobs',
  jobBusy: () => 'A job is already running',
  run: () => 'Run',
  syncLibrary: () => 'Sync library to other devices',
  backUpOriginals: () => 'Back up originals',
  scanLibrary: () => 'Scan library',
  rebuildThumbnails: () => 'Rebuild all library thumbnails',
  rebuildRenditions: () => 'Rebuild all viewer renditions',
  noRenditionsToRebuild: () => 'This library uses embedded JPEGs. No renditions to rebuild.',
  // The job, not the setting above it, which is why this says nothing about scanning.
  groupSimilarPhotos: () => 'Group similar photos into stacks',
  autoStackOff: () => 'Automatic grouping is off for this library',

  renditionModeLastUsed: () => 'Last used',
  renditionModeLastUsedPerPhoto: () => 'Last used per photo',
  renditionModeBestAvailable: () => 'Best available',
  groupPhotoViewer: () => 'Photo viewer',
  groupFrameTv: () => 'Samsung Frame TV',
  defaultRendition: () => 'Default rendition to show',
  hideSidebarInViewer: () => 'Hide sidebar automatically in photo viewer',
  frameTvEnabled: () => 'Enable Samsung Frame TV integration',

  couldNotSaveSetting: () => "We couldn't save that setting. Try again.",
  couldNotOpenAppDataFolder: () =>
    "We couldn't open the app data folder. Try opening it in your file manager.",

  logLevelDebug: () => 'debug',
  logLevelInfo: () => 'info',
  logLevelWarn: () => 'warn',
  logLevelError: () => 'error',

  groupThisDevice: () => 'This device',
  deviceName: () => 'Device name',
  groupThisApp: () => 'This app',
  uiScale: () => 'Interface scale',
  uiScalePercent: (percent: number) => `${percent}%`,
  couldNotSetUiScale: () => "We couldn't change the interface scale. Try again.",

  renderOnThisDevice: () => 'Render on this device',

  groupWatching: () => 'File watching',
  groupSchedule: () => 'Schedule',
  watchEnabled: () => 'Watch library folders for changes',
  dailyFullScanAt: () => 'Daily full scan at',
  dailyFullScanAtPlaceholder: () => '03:00',
  dailyFullScanAtHint: () => 'Leave empty to turn it off',

  hdrOff: () => 'No library builds HDR renditions',

  groupWorkers: () => 'Workers',
  scanConcurrency: () => 'Scanning threads',
  processingConcurrency: () => 'Rendition threads',
  processingConcurrencyHint: () => 'Each thread holds 1 RAW file in memory',

  groupHdr: () => 'HDR',
  hdrReferenceWhite: () => 'HDR reference white',
  hdrReferenceWhiteHint: () => 'How bright plain white will appear',
  hdrWhiteQuantile: () => 'HDR white threshold',
  hdrWhiteQuantileHint: () => 'Lower values make photos brighter',
  displayPeakNits: () => 'Display peak brightness',
  displayPeakNitsHint: () => "Applies to this device only. Match your display's peak brightness.",
  hdrWhite: () => 'HDR brightness',
  hdrWhiteScale: (scale: number) => `${scale.toFixed(1)}×`,
  calibrateHdr: () => 'Calibrate HDR',
  measuredPeakNits: (nits: number) => `${nits} nits`,
  measuredPeakSdr: () => 'SDR',
  measuredPeakUnknown: () => 'Unknown',

  groupResolution: () => 'Resolution',
  gridRenditionSize: () => 'Grid thumbnail longest edge',
  fullRenditionSize: () => 'Viewer rendition longest edge',
  panoramaFullRenditionSize: () => 'Panorama rendition longest edge',

  groupQuality: () => 'Quality',
  gridRenditionQuality: () => 'Grid thumbnail quality',
  fullRenditionQuality: () => 'Viewer rendition quality',
  maxRenditionQuality: () => 'Full-resolution quality',

  groupEncoding: () => 'Encoding',
  sdrFullChroma: () => 'Always encode SDR in 4:4:4',
  hdrFullChroma: () => 'Always encode HDR in 4:4:4',
  hdrFullChromaHint: () => 'When off, we use 4:4:4 only if colour loss would be visible',
  avifSpeed: () => 'Encoder speed',
  avifSpeedHint: () => '10 is fastest',

  groupMaintenance: () => 'Maintenance',
  diskUsage: () => 'App disk usage',
  diskUsageHint: () => 'Excludes your originals',
  calculatingDiskUsage: () => 'Calculating…',
  couldNotMeasureDiskUsage: () => "We couldn't measure disk usage. Try again.",
  retryDiskUsage: () => 'Try again',
  diskSpaceLimit: () => 'Disk space limit',
  diskSpaceLimitHint: () => 'Delete the least recently viewed renditions above this limit',
  watchDebounce: () => 'Scan delay after a change',
  watchPollInterval: () => 'Network library scan interval',
  pruneEveryDays: () => 'Delete unused renditions every',
  backupEveryDays: () => 'Back up the catalogue every',
  /** One line under every schedule a zero disables. */
  zeroTurnsItOff: () => '0 turns it off',
  backupKeep: () => 'Backups to keep',
  backupsOff: () => 'Backups are off',
  exportHistoryLimit: () => 'Export history entries to keep',
  exportHistoryLimitHint: () => 'Your exported files stay on disk',
  appDataFolder: () => 'App data folder',
  openFolder: () => 'Open folder',

  groupServer: () => 'Server',
  logLevel: () => 'Log level',
  corsOrigins: () => 'Allowed CORS origins',
  corsOriginsPlaceholder: () => 'any origin on this host',
  corsOriginsHint: () => 'Comma-separated, or * for any',
  environmentNote: () => 'HOST, PORT, and DB_PATH are set in the environment',

  /** Names the page wherever it is met: this heading and the sidebar. */
  settings: () => 'Settings',
  settingsSections: () => 'Settings sections',
  /** The set of libraries, named here and in the sidebar. */
  libraries: () => 'Libraries',
  noLibrariesYet: () => 'No libraries yet',
  noLibrariesHint: () => 'Add a folder of RAW files to start your library',
  /** The mobile app's, which has no folder to pick. */
  noPhoneLibrariesHint: () => "Add your phone's photos, or sync a library from another device",
  groupGeneral: () => 'General',
  groupRendering: () => 'Rendering',
  groupAdvanced: () => 'Advanced',
  groupSystem: () => 'System',
};
