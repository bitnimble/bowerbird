import type { HdrMedium, HdrVariant } from './hdr_media';
import type { Rendition } from './renditions';

// Where a rendition's pixels come from. 'embedded' lifts the camera's own JPEG
// out of the RAW: no demosaic, so it is much faster and carries the maker's
// colour treatment, but it is only as large as the body chose to embed (anything
// from 640x480 to full sensor). 'render' demosaics the RAW at full resolution.
export const THUMBNAIL_SOURCES = ['embedded', 'render'] as const;
export type ThumbnailSource = (typeof THUMBNAIL_SOURCES)[number];

export function isThumbnailSource(value: string): value is ThumbnailSource {
  return (THUMBNAIL_SOURCES as readonly string[]).includes(value);
}

// How a scene-linear decode is graded to display-referred (§10.7). The three
// travel together because none of them means anything alone: the quantile picks
// diffuse white, the reference says what it is worth in nits, and the peak is
// where the roll-off above it lands.
export interface HdrGrade {
  peakNits: number;
  referenceWhiteNits: number;
  whiteQuantile: number;
}

// One rendition to write. Building the grid and the full-size copy at import, or
// either of them plus the max-resolution one on demand, is the same work at
// different settings, so it is one shape rather than three job types that
// differed mostly in what they called their output path.
export interface RenditionTarget {
  rendition: Rendition;
  hdr: boolean;
  outputPath: string;
  /** The one-frame AV1 twin, for Firefox (§10.7). Null when it is not wanted. */
  videoOutputPath: string | null;
  /** Longest edge, or 0 for native resolution. */
  size: number;
  // Which pixels to start from. Only the grid is ever built from the camera's
  // JPEG, and only because a 9504px preview cannot be a 800px tile; everywhere
  // else the embedded JPEG is served as itself rather than rendered into a
  // rendition (§10.2).
  source: ThumbnailSource;
  /** AVIF quality, 1-100, for the SDR path. */
  quality: number;
  /** avifenc max quantizer, 0-63 and lower is better, for the HDR path. */
  quantizer: number;
  /** AVIF effort, 0-9. See config: the default of 4 is a pure loss. */
  effort: number;
  /** Encoder speed for the HDR path. */
  preset: number;
}

export interface RenditionJob {
  kind: 'rendition';
  photoId: string;
  rawFilePath: string;
  /** The library's generated-data directory, which the targets sit under. */
  dataPath: string;
  targets: RenditionTarget[];
  grade: HdrGrade;
  /**
   * Fit the camera's own colour treatment and lens correction off the embedded
   * JPEG and apply them to this job's SDR renders (DESIGN §10.8).
   *
   * On the job rather than the target because the fit is a property of the photo:
   * one fit feeds every rendition in the job, so the grid and the full view cannot
   * disagree about colour, and the expensive part happens once.
   */
  matchEmbeddedJpeg: boolean;
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
  grade: HdrGrade;
  crf: number;
  preset: number;
  maxEdge: number;
}

export type WorkerJob = RenditionJob | HdrJob;

export type ProcessingResult =
  | { photoId: string; success: true }
  | { photoId: string; success: false; error: string };
