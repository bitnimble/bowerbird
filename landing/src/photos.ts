export type Scene = 'rapids' | 'sunset' | 'arches';

export const SCENES: readonly Scene[] = ['rapids', 'sunset', 'arches'];

// Each `new URL` is a literal so Vite bundles the committed file rather than a second copy of it.
export const PHOTOS: Record<Scene, { sdr: string; hdr: string }> = {
  rapids: {
    sdr: new URL('../../web/public/hdr/rapids-sdr.avif', import.meta.url).href,
    hdr: new URL('../../web/public/hdr/rapids-hdr.avif', import.meta.url).href,
  },
  sunset: {
    sdr: new URL('../../web/public/hdr/sunset-sdr.avif', import.meta.url).href,
    hdr: new URL('../../web/public/hdr/sunset-hdr.avif', import.meta.url).href,
  },
  arches: {
    sdr: new URL('../../web/public/hdr/arches-sdr.avif', import.meta.url).href,
    hdr: new URL('../../web/public/hdr/arches-hdr.avif', import.meta.url).href,
  },
};
