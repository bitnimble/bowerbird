import { type ProcessingStage, RENDITION_SOURCES, type RenditionSource } from '../../../schemas/common';
import type { DustSettings } from '../../../schemas/dust_settings';
import type { CompositeWant, JobAdjust, JobGeometry } from '../../../schemas/jobs';
import type { Denoiser, Repair } from '../../../schemas/photo_edits';
import type { CameraMatch } from '../../../schemas/render_stages';
import type { FileRenderingIntent } from '../../../schemas/rendering_intent';
import type { Rendition } from '../renditions/renditions';

export type { RenditionSource };

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
  /** How an SDR target reaches sRGB's gamut; perceptual where absent. */
  intent?: FileRenderingIntent;
}

/**
 * What was done to the picture, as `developed` reads it off an `EditDoc` and every renderer takes
 * it.
 *
 * One shape rather than one per kind of job: a panorama is graded, straightened and cropped by the
 * same document a photograph is, and a field that reached one job and not the other is a picture
 * that comes out differently depending on which route rendered it.
 */
export interface Developed {
  /**
   * Noise reduction and output sharpening for the render (§10.9), the same for every
   * target: they describe the picture this renders to, so the grid tile and the full view
   * cannot disagree.
   *
   * The denoise pair and the sharpen are the Detail panel's slider positions, 0 to 100 in
   * the document and fractions here; the defringe is a library setting. A null of the pair is
   * the document not having said, resolved against the frame's own fit inside the decode.
   */
  denoiseLuminance: number | null;
  denoiseColour: number | null;
  /** Which filter the pair above drives (`galosh::Denoiser`). */
  denoiser: Denoiser;
  /** The dust panel's switch and pair, already scaled to the fractions the module reads. */
  dust: DustSettings;
  /** The reader's repairs, as the document holds them (`crate::repair`). */
  repairs: Repair[];
  sharpen: number;
  defringe: number;
  /**
   * The photographer's own exposure, as a gain on the scene rather than in stops.
   *
   * A gain because that is what the shader's uniform carries, and the conversion from the
   * stored document's EV happens once on the way in rather than in two places that could
   * disagree about the base. 1 is the scene as metered, which is what an unedited photo gets.
   */
  exposure: number;
  /**
   * The rest of the reader's sliders, on Camera Raw's -100..100 scales. All zero is the
   * picture as the camera rendered it.
   */
  adjust: JobAdjust;
  /** The reader's crop, straighten and quarter turn. */
  geometry: JobGeometry;
}

export interface RenditionJob extends Developed {
  kind: 'rendition';
  observe?: true;
  photoId: string;
  rawFilePath: string;
  /** The library's generated-data directory, which the targets sit under. */
  dataPath: string;
  targets: RenditionTarget[];
  grade: HdrGrade;
  cameraMatch: CameraMatch;
  preserveSourceOrientation?: boolean;
  /**
   * Collapse each Bayer quad into one pixel rather than interpolating it (§10.5).
   *
   * Only an export sets it. A rendition asks for a size and lets the decode halve where that
   * still serves; this is a reader choosing the trade itself, which a size cannot express - on
   * a frame the floor would never have halved, asking for a smaller one resamples a full
   * demosaic instead of skipping one.
   */
  halfSize?: boolean;
  /**
   * Measure this photograph again rather than reading what is on file: the camera match,
   * the noise fit, the particles, the levels, the aberration - everything `photo_analysis`
   * keeps. The fresh answers are written back over it.
   */
  remeasure?: boolean;
  /**
   * Measure this photograph and write nothing: no target, no picture, no file.
   *
   * What is wanted is the camera match, which is fitted inside the base a render builds and
   * nowhere else - so a library that serves the cameras' pictures has none, and a panorama of
   * those frames has no lens to reach their sensors through (`measureCameraMatch`).
   */
  measure?: boolean;
  /**
   * `rawFilePath` is this photograph's own rendition, shown as it was encoded (`Job.statedWhite`).
   *
   * Nothing measured of it describes the photograph, so no analysis is read for it or filed from it.
   */
  statedWhite?: boolean;
  /**
   * Count the job's steps where another thread can read them (`jobProgress`).
   *
   * Only what a reader is watching asks - an export, and a merge's own jobs: there is one counter
   * for the process, so a pool of four building tiles would report over it.
   */
  reportProgress?: boolean;
  /**
   * The one target's picture, already rendered by a client (`job::render_bytes`), so the worker
   * encodes and writes it rather than rendering (`writeRendered`).
   */
  rendered?: Uint8Array<ArrayBuffer>;
}

/**
 * One photograph a panorama is made of. The analysis travels as a path rather than as bytes for
 * `toCommand`'s reason: the worker reads it, so a job crossing `postMessage` carries none of it.
 */
export interface CompositeJobSource {
  photoId: string;
  rawFilePath: string;
  /**
   * A picture to run the *search* on instead of lifting the camera's preview out of the RAW.
   *
   * Only ever a grid tile that was itself built from that JPEG, so the plane is the same picture
   * at a smaller size and the recipe still means what it means (`CompositesService.searchable`).
   * Absent, the align opens the RAW, which is what it has always done.
   */
  previewPath?: string;
}

/**
 * A panorama's own work: search a set of photographs for a recipe, or composite the one it has.
 *
 * Keyed by the photograph the recipe belongs to, which for an align does not exist yet - the whole
 * point of an align is to find out what to write on one - so that arm carries the library instead.
 * Everything else here is a rendition job's - the same targets, the same grade, the same settings -
 * because what a composite produces is a frame, and a frame's renditions are cut as they always were.
 */
export type CompositeJob = CompositeJobBase & CompositeWant;

interface CompositeJobBase extends Developed {
  kind: 'composite';
  cameraMatch: CameraMatch;
  /** The composite being rendered, or the library being searched where there is no row yet. */
  photoId: string;
  sources: CompositeJobSource[];
  /** `RenditionJob.reportProgress`, for a job a merge is watching. */
  reportProgress?: boolean;
  dataPath: string;
  targets: RenditionTarget[];
  grade: HdrGrade;
}

export type WorkerJob = RenditionJob | CompositeJob;

export interface ProcessingStarted {
  kind: 'started';
  photoId: string;
  analysisCache: 'supplied' | 'missing' | 'refresh';
}

export type ProcessingMessage = ProcessingStarted | ProcessingResult;

export type ProcessingResult =
  // `descriptor` rides back with the grid tile that produced it (§19.3). Computed
  // in the worker, off the pixels it is already holding, because the alternative
  // - reading the written tile back on the main thread - put a ~20ms synchronous
  // decode per photo inside the pool's result handler, where it both stalls every
  // HTTP request and idles the worker that is waiting to be handed its next job.
  // `photoId` is the job's own key, which for a panorama is its stack's id: the pool matches a
  // result to the job it answers, and a panorama is not one of the photographs behind it.
  | { photoId: string; success: true; descriptor?: Uint8Array; composite?: string }
  | { photoId: string; success: false; error: string };
