import { useMediaQuery } from '../../web/src/app/device';

// `video-dynamic-range` as well: Firefox answers `dynamic-range: standard` on an HDR display,
// and it is shown HDR as a video.
const HDR_DISPLAY = '(dynamic-range: high), (video-dynamic-range: high)';

export function useHdrDisplay(): boolean {
  return useMediaQuery(HDR_DISPLAY);
}
