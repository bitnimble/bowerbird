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
  includeEditsHint: () => 'Turn off to export the photo as your camera rendered it.',

  halfSize: () => 'Half-size RAW',
  halfSizeHint: () => 'Exports with 25% of the pixels at about twice the speed',

  exportHdr: () => 'Export as HDR',
  exportHdrHint: () => 'Keeps highlights brighter than white',
  exportHdrUnavailable: (format: string) => `${format} can't store HDR. Choose another file type.`,
  exportHdrNeedsGainMap: (format: string) => `${format} needs a gain map for HDR. Add one below.`,

  gainMap: () => 'Add a gain map for SDR compatibility',
  gainMapHint: () => 'Shows HDR on supported displays and SDR elsewhere in a file about a third larger',

  estimate: (size: string) => `About ${size}`,
  estimateUnknown: () => 'Size unknown',

  done: (count: number) => (count === 1 ? 'Photo exported.' : `Exported ${count} photos.`),
  someFailed: (failed: number, done: number, reason: string | null) =>
    `We couldn't export ${failed} ${failed === 1 ? 'photo' : 'photos'}. ${done} ${done === 1 ? 'photo was' : 'photos were'} exported` +
    (reason == null ? '. Try again.' : `. ${reason.endsWith('.') ? reason : `${reason}.`}`),

  couldNotStart: () => "We couldn't start this export. Check your selection and try again.",
  unnamedExport: () => "We couldn't export this photo because it has no filename. Try again.",
  unknownFolderAnswer: () => "We couldn't find the export folder. Choose it again.",
};
