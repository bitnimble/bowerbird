// Where a thumbnail's pixels come from. 'embedded' lifts the camera's own JPEG
// out of the RAW: no demosaic, so it is much faster and carries the maker's
// colour treatment, but it is only as large as the body chose to embed (anything
// from 640x480 to full sensor). 'render' demosaics the RAW at full resolution.
export const THUMBNAIL_SOURCES = ['embedded', 'render'] as const;
export type ThumbnailSource = (typeof THUMBNAIL_SOURCES)[number];

export interface ProcessingJob {
  kind: 'thumbnails';
  photoId: string;
  rawFilePath: string;
  smallOutputPath: string;
  fullOutputPath: string;
  smallSize: number;
  fullSize: number;
  smallQuality: number;
  fullQuality: number;
  source: ThumbnailSource;
}

// A full-resolution, 16-bit, losslessly compressed render of one photo, produced
// only when the user explicitly asks for it: the output runs to hundreds of
// megabytes, so it is never part of routine processing.
export interface LosslessJob {
  kind: 'lossless';
  photoId: string;
  rawFilePath: string;
  outputPath: string;
}

export type WorkerJob = ProcessingJob | LosslessJob;

export type ProcessingResult =
  // `source` is what was actually used: an embedded request falls back to a
  // render when the file has no JPEG preview.
  | { photoId: string; success: true; source: ThumbnailSource }
  | { photoId: string; success: false; error: string };

export type LosslessResult = { photoId: string; success: true } | { photoId: string; success: false; error: string };
