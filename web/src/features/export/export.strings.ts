export const ExportStrings = {
  title: () => 'Export',
  titleMany: (count: number) => `Export ${count} photos`,

  format: () => 'File type',
  formatJpeg: () => 'JPEG',
  formatAvif: () => 'AVIF',
  formatJxl: () => 'JPEG XL',
  formatPng: () => 'PNG',
  formatTiff: () => 'TIFF',

  resolution: () => 'Resolution',
  resolutionFull: () => 'Full size',
  resolutionLongEdge: (pixels: number) => `${pixels} px long edge`,

  quality: () => 'Quality',
  qualityValue: (quality: number) => `${quality}`,

  includeEdits: () => 'Include edits',

  halfSize: () => 'Half-size RAW',

  exportHdr: () => 'Export as HDR',
  exportHdrUnavailable: (format: string) => `${format} can't store HDR. Choose another file type.`,
  exportHdrNeedsGainMap: (format: string) => `${format} needs a gain map for HDR. Add one below.`,

  gainMap: () => 'Enable gain map',
  gainMapHint: () =>
    'Gain maps allow a photo to be rendered as HDR on HDR-compatible displays, and fall back to SDR on SDR displays. This increases the file size by approximately 30%.',

  estimate: (size: string) => `About ${size}`,
  estimateUnknown: () => 'Size unknown',

  done: (count: number) => (count === 1 ? 'Photo exported.' : `Exported ${count} photos.`),
  someFailed: (failed: number, done: number, reason: string | null) =>
    `We couldn't export ${failed} ${failed === 1 ? 'photo' : 'photos'}. ${done} ${done === 1 ? 'photo was' : 'photos were'} exported` +
    (reason == null ? '. Try again.' : `. ${reason.endsWith('.') ? reason : `${reason}.`}`),

  couldNotStart: () => "We couldn't start this export. Check your selection and try again.",
  unnamedExport: () => "We couldn't export this photo because it has no filename. Try again.",
};
