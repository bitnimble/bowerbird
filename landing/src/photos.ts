/** The photographs the HDR demo compares, in both ranges. Built by `scripts/demo-assets.ts`. */
export type Scene = 'gamut' | 'whites' | 'sun' | 'saturated';

export const SCENES: readonly Scene[] = ['gamut', 'whites', 'sun', 'saturated'];

// Each `new URL` is a literal so Vite bundles the committed file rather than a second copy of it.
export const PHOTOS: Record<Scene, { sdr: string; hdr: string }> = {
  gamut: {
    sdr: new URL('../../web/public/hdr/gamut-sdr.avif', import.meta.url).href,
    hdr: new URL('../../web/public/hdr/gamut-hdr.avif', import.meta.url).href,
  },
  whites: {
    sdr: new URL('../../web/public/hdr/whites-sdr.avif', import.meta.url).href,
    hdr: new URL('../../web/public/hdr/whites-hdr.avif', import.meta.url).href,
  },
  sun: {
    sdr: new URL('../../web/public/hdr/sun-sdr.avif', import.meta.url).href,
    hdr: new URL('../../web/public/hdr/sun-hdr.avif', import.meta.url).href,
  },
  saturated: {
    sdr: new URL('../../web/public/hdr/saturated-sdr.avif', import.meta.url).href,
    hdr: new URL('../../web/public/hdr/saturated-hdr.avif', import.meta.url).href,
  },
};

/** Stand-in photographs for the demos that need something to show rather than a particular picture. */
export type Sample = 'rapids' | 'sunset' | 'arches';

export const SAMPLE: Record<Sample, string> = {
  rapids: `${import.meta.env.BASE_URL}samples/rapids.avif`,
  sunset: `${import.meta.env.BASE_URL}samples/sunset.avif`,
  arches: `${import.meta.env.BASE_URL}samples/arches.avif`,
};

/** Every demo photograph as one 8-bit picture, which is all a grid of thumbnails needs. */
export const DEMO_PHOTO = {
  ...SAMPLE,
  gamut: PHOTOS.gamut.sdr,
  whites: PHOTOS.whites.sdr,
  sun: PHOTOS.sun.sdr,
  saturated: PHOTOS.saturated.sdr,
  street: `${import.meta.env.BASE_URL}samples/merge-a.avif`,
};

export type DemoPhoto = keyof typeof DEMO_PHOTO;

/** The colour matching demo's pair: 1 raw rendered with the camera's colour and without it. */
export const COLOUR_PHOTO: Record<'matched' | 'none', string> = {
  matched: `${import.meta.env.BASE_URL}samples/colour-matched.avif`,
  none: `${import.meta.env.BASE_URL}samples/colour-none.avif`,
};

/** The take best parts demo's frames: one street a moment apart, with people and without. */
export const MERGE_PHOTO: Record<'people' | 'clear', string> = {
  people: `${import.meta.env.BASE_URL}samples/merge-a.avif`,
  clear: `${import.meta.env.BASE_URL}samples/merge-b.avif`,
};

/** The dust removal demo's pair: part of 1 raw, with the sensor's spots left in and taken out. */
export const DUST_PHOTO: Record<'before' | 'after', string> = {
  before: `${import.meta.env.BASE_URL}samples/dust-before.avif`,
  after: `${import.meta.env.BASE_URL}samples/dust-after.avif`,
};

/** The panorama demo's merged picture, which 1 sweep of 5 frames came out as. */
export const PANORAMA_PHOTO = `${import.meta.env.BASE_URL}samples/panorama.avif`;

/** Those 5 frames, in the order they read left to right across the merged picture. */
export const PANORAMA_FRAMES: readonly string[] = [1, 2, 3, 4, 5].map(
  (at) => `${import.meta.env.BASE_URL}samples/pano-${at}.avif`,
);
