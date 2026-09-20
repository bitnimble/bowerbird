export const OpenGraphStrings = {
  siteName: () => 'Bowerbird',
  photoCount: (count: number) => (count === 1 ? '1 photo' : `${count.toLocaleString('en')} photos`),
  panorama: (frames: number) => `Panorama of ${frames} photos`,
  shutter: (seconds: number) => (seconds >= 1 ? `${seconds}s` : `1/${Math.round(1 / seconds)}s`),
  aperture: (fNumber: number) => `f/${fNumber}`,
  iso: (iso: number) => `ISO ${iso}`,
  focalLength: (mm: number) => `${mm}mm`,
};
