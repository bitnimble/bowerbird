export const PhotoStageStrings = {
  stage: () => 'Photo',
  fullscreen: () => 'Fullscreen',
  fullscreenTitle: () => 'Fullscreen (F)',
  noRenditionYet: () => 'Rendition not ready',
  onUnreachableDevice: () => 'On a synced device (unreachable)',
  loading: () => 'Loading…',
  rendering: () => 'Rendering…',
  fetching: () => 'Fetching…',
  // The reader asked for a rendition and is looking at a different one, which without this
  // is a picker that appears to do nothing.
  frameUnreadable: () => "We couldn't show this rendition. Try another one.",
  exitFullscreen: () => 'Exit fullscreen',
};
