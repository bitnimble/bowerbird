import { RENDITION_SOURCES, type RenditionSource } from '../../schemas/common';
import type { JobAdjust } from './rawshim_job';
import type { Rendition } from './renditions';

export type { RenditionSource };

// The two halves of an import, which land at different times and are worth
// telling apart everywhere: the grid tile the gallery shows (~125ms), then the
// photo viewer's renditions (~1.5s). See DESIGN §10.2.
export const PROCESSING_STAGES = ['tile', 'renditions'] as const;
export type ProcessingStage = (typeof PROCESSING_STAGES)[number];

/** A derived file that has just been written, and the stamp its row now carries. */
export interface RenditionWritten {
  stage: ProcessingStage;
  version: string;
}

export function isRenditionSource(value: string): value is RenditionSource {
  return (RENDITION_SOURCES as readonly string[]).includes(value);
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
  /** Longest edge, or 0 for native resolution. */
  size: number;
  // Which pixels to start from. Only the grid is ever built from the camera's
  // JPEG, and only because a 9504px embedded JPEG cannot be a 800px tile; everywhere
  // else the embedded JPEG is served as itself rather than rendered into a
  // rendition (§10.2).
  source: RenditionSource;
  /** libaom quantizer, 0-63 and lower is better, for the SDR path. */
  sdrQuantizer: number;
  /** The same scale for the HDR path, which lands at a different depth. */
  hdrQuantizer: number;
  /** Encoder speed for the HDR path. */
  preset: number;
  /** 4:4:4 rather than 4:2:0 for the HDR still (§10.7). */
  stillFullChroma: boolean;
  /** The same for the SDR renditions (§10.1). Separate setting, separate scale. */
  sdrFullChroma: boolean;
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
  /**
   * Noise reduction and output sharpening for the render (§10.9), the same for every
   * target and for the same reason as `matchEmbeddedJpeg`: they describe the picture
   * this photo renders to, so the grid tile and the full view cannot disagree.
   */
  denoiseLuma: number;
  denoiseChroma: number;
  sharpen: number;
  defringe: number;
  /**
   * The photographer's own exposure, as a gain on the scene rather than in stops.
   *
   * A gain because that is what the shader's uniform carries, and the conversion from the
   * stored document's EV happens once on the way in rather than in two places that could
   * disagree about the base. 1 is the scene as metered, which is what an unedited photo gets.
   *
   * On the job for the same reason as the strengths above: it describes the picture this
   * photo renders to, so the grid tile and the full view cannot disagree about it.
   */
  exposure: number;
  /**
   * The rest of the reader's sliders, on Camera Raw's -100..100 scales. All zero is the
   * picture as the camera rendered it.
   *
   * On the job beside `exposure` and for the same reason: they describe the picture this
   * photo renders to, so the grid tile and the full view cannot disagree about it.
   */
  adjust: JobAdjust;
}

export type WorkerJob = RenditionJob;

export type ProcessingResult =
  // `descriptor` rides back with the grid tile that produced it (§19.3). Computed
  // in the worker, off the pixels it is already holding, because the alternative
  // - reading the written tile back on the main thread - put a ~20ms synchronous
  // decode per photo inside the pool's result handler, where it both stalls every
  // HTTP request and idles the worker that is waiting to be handed its next job.
  | { photoId: string; success: true; descriptor?: Uint8Array }
  | { photoId: string; success: false; error: string };
