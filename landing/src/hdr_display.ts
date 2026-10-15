import { useSyncExternalStore } from 'react';

// `video-dynamic-range` as well: Firefox answers `dynamic-range: standard` on an HDR display,
// and it is shown HDR as a video.
const HDR_DISPLAY = '(dynamic-range: high), (video-dynamic-range: high)';

function followDisplay(changed: () => void): () => void {
  const media = matchMedia(HDR_DISPLAY);
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
}

export function useHdrDisplay(): boolean {
  return useSyncExternalStore(followDisplay, () => matchMedia(HDR_DISPLAY).matches);
}
