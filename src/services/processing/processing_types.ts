import type { HdrMedium, HdrVariant } from './hdr_media';

// Where a thumbnail's pixels come from. 'embedded' lifts the camera's own JPEG
// out of the RAW: no demosaic, so it is much faster and carries the maker's
// colour treatment, but it is only as large as the body chose to embed (anything
// from 640x480 to full sensor). 'render' demosaics the RAW at full resolution.
export const THUMBNAIL_SOURCES = ['embedded', 'render'] as const;
export type ThumbnailSource = (typeof THUMBNAIL_SOURCES)[number];

export function isThumbnailSource(value: string): value is ThumbnailSource {
  return (THUMBNAIL_SOURCES as readonly string[]).includes(value);
}

export interface ProcessingJob {
  kind: 'thumbnails';
  photoId: string;
  rawFilePath: string;
  smallOutputPath: string;
  fullOutputPath: string;
  /** The HDR video twin of the full preview, written only when hdrVideo is set. */
  videoOutputPath: string;
  smallSize: number;
  fullSize: number;
  smallQuality: number;
  fullQuality: number;
  effort: number;
  source: ThumbnailSource;
  // HDR applies to the full-size rendition only, and only when the source is a
  // render: an embedded JPEG is 8-bit SDR (§10.2).
  hdr: boolean;
  /** Also encode the HDR preview as a one-frame AV1, for Firefox (§10.7). */
  hdrVideo: boolean;
  peakNits: number;
  crf: number;
  preset: number;
}

// One full-size preview, from one source, built on demand so the detail view can
// switch renditions. Unlike a thumbnail job this never falls back: a request for
// the embedded JPEG of a file that has none is answered as such, rather than
// silently caching a render under the embedded source's name.
export interface PreviewJob {
  kind: 'preview';
  photoId: string;
  rawFilePath: string;
  outputPath: string;
  size: number;
  quality: number;
  effort: number;
  source: ThumbnailSource;
  hdr: boolean;
  /** Also write the one-frame AV1 twin, for Firefox (§10.7). */
  hdrVideo: boolean;
  videoOutputPath: string;
  peakNits: number;
  crf: number;
  preset: number;
}

// A full-resolution, 16-bit, losslessly compressed render of one photo, produced
// only when the user explicitly asks for it: the output runs to hundreds of
// megabytes, so it is never part of routine processing.
export interface LosslessJob {
  kind: 'lossless';
  photoId: string;
  rawFilePath: string;
  outputPath: string;
  /** sharp AVIF quality, 1-100, for the SDR path. */
  quality: number;
  /** sharp AVIF effort, 0-9. See config: the default of 4 is a pure loss. */
  effort: number;
  /** avifenc max quantizer, 0-63 and lower is better, for the HDR path. */
  quantizer: number;
  preset: number;
  hdr: boolean;
  /** Also write the one-frame AV1 twin, for Firefox (§10.7). */
  hdrVideo: boolean;
  videoOutputPath: string;
  peakNits: number;
}

// One HDR rendition: an AVIF still for Chrome, or a one-frame video for
// Firefox, which applies a PQ or HLG transfer to nothing else (§10.7). Same cost
// profile as the lossless export, so it is asked for explicitly too.
export interface HdrJob {
  kind: 'hdr';
  photoId: string;
  rawFilePath: string;
  outputPath: string;
  variant: HdrVariant;
  medium: HdrMedium;
  peakNits: number;
  crf: number;
  preset: number;
  maxEdge: number;
}

export type WorkerJob = ProcessingJob | PreviewJob | LosslessJob | HdrJob;

export type ProcessingResult =
  // `source` is what was actually used: an embedded request falls back to a
  // render when the file has no JPEG preview.
  | { photoId: string; success: true; source: ThumbnailSource }
  | { photoId: string; success: false; error: string };

export type LosslessResult = { photoId: string; success: true } | { photoId: string; success: false; error: string };
