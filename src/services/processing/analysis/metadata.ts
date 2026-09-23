import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';
import type { CaptureSequence } from '../../../schemas/capture_sequence';
import { stagedDescriptorPath } from '../../../utils/paths';
import { dustSettings } from '../../../schemas/dust_settings';
import { adjustOf } from '../../../schemas/edit_adjust';
import { neutralEdits } from '../../../schemas/photo_edits';
import { Logger } from '../../../logger';
import { readCaptureOffset } from './exif_zone';
import { readRawHeader, wallClockIso, type RawHeader } from '../rawshim/raw_decoder';
import { runJob } from '../rawshim/rawshim_job';

// Stage 1 reads every supported file with the native header parser (no pixel
// decode). See DESIGN §11.

export interface FileMetadata {
  width: number; // display/upright width (post-flip)
  height: number; // display/upright height (post-flip)
  colorSpace: string;
  orientation: number; // EXIF orientation, 1 to 8; informational + hash input only
  dateTaken: string | null; // the camera's wall clock, as a Z string (§11.1)
  // What zone that wall clock was written in, "+11:00", or null from a body that
  // recorded none. Read straight from EXIF: the header parser does not carry it.
  dateTakenOffset: string | null;
  latitude: number | null;
  longitude: number | null;
  iso: number | null;
  shutterSpeed: number | null; // seconds
  aperture: number | null; // f-number
  focalLength: number | null; // mm
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  sequence: CaptureSequence | null;
  mtime: string; // filesystem mtime, ISO datetime
  fileSize: number; // bytes
}

/**
 * Where to leave this file's grid tile, and how to encode it, for a scan that is already
 * holding the RAW open (§10.4).
 *
 * The size, quantizer and speed come from the same settings a tile built by the rendition pass
 * reads, handed over rather than looked up again: a scan that encoded to its own idea of
 * "grid" would fill a library with tiles the next settings change could not explain.
 */
export interface TileStage extends TileEncoding {
  /**
   * Where to write it, which is a name minted for this file alone and kept in scope until the
   * photo has an id to be renamed to (`scannedTilePath`).
   */
  outputPath: string;
}

/** What a grid tile is encoded to, which is the library's settings and never a scan's own idea. */
export interface TileEncoding {
  size: number;
  quantizer: number;
  speed: number;
}

const log = new Logger('scan');

/**
 * The catalogue's fields for one file, and its grid tile where `stage` says to build one.
 *
 * **The tile is built here because the file is already open.** A scan and the tile pass ask the
 * same RAW the same questions - the same open, the same decoder, the same walk of the same tags -
 * and the camera's small preview then sits in the pages that walk already faulted. Measured over
 * the two passes on a cold library, doing both here costs 0.4ms per file against the 8-10ms of
 * doing the second one later, which is about a fifth of an import (DESIGN §10.4).
 *
 * A tile that fails to build is not a scan that failed: the file is still catalogued, and the
 * rendition pass builds the tile the way it always did.
 */
export async function extractMetadata(filePath: string, stage?: TileStage): Promise<FileMetadata> {
  const stats = await stat(filePath);
  const header = stage == null ? readRawHeader(filePath) : await withTile(filePath, stage);
  // A second read of the same file, because the two answers come from different
  // places: `bb_read_header` for everything it parses, the raw EXIF for the one
  // tag it does not carry. Bounded to the header, so it costs a page or two.
  const dateTakenOffset = await readCaptureOffset(filePath);
  return fileMetadata(header, dateTakenOffset, stats);
}

/**
 * The header, off the same open that writes the tile beside it.
 *
 * Falls back to reading the header alone, so a file whose preview cannot be decoded - a body
 * that embeds a bitmap, or none - is catalogued exactly as it was before, and its tile is built
 * by the rendition pass from a render.
 */
async function withTile(filePath: string, stage: TileStage): Promise<RawHeader> {
  try {
    await mkdir(path.dirname(stage.outputPath), { recursive: true });
    const outcome = runJob({
      rawFilePath: filePath,
      scan: true,
      // None of these reach an embedded tile: `job::run` lifts the camera's own JPEG and
      // returns before anything that would read them, and `scan` above is what makes that
      // unconditional - without it, a file with no preview would render, and render with these.
      cameraMatch: 'none',
      denoiseLuminance: 0,
      denoiseColour: 0,
      denoiser: 'galosh',
      dust: dustSettings(undefined),
      sharpen: 0,
      defringe: 0,
      exposure: 0,
      adjust: adjustOf(neutralEdits()),
      geometry: { crop: [0, 0, 1, 1], angleDegrees: 0, rotate: 0, keystone: null },
      grade: { peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.9 },
      targets: [
        {
          rendition: 'grid',
          output: 'srgb',
          outputPath: stage.outputPath,
          size: stage.size,
          source: 'embedded',
          sdrQuantizer: stage.quantizer,
          // Neither reaches an SDR tile, and the chroma is the grid's own rule: its source is
          // already subsampled, so 4:4:4 would store chroma at a resolution it never had.
          hdrQuantizer: stage.quantizer,
          preset: stage.speed,
          stillFullChroma: false,
          sdrFullChroma: false,
        },
      ],
    });
    if (outcome.header == null) throw new Error('the job reported no header');
    // Beside the tile, because it is computed off those pixels and the pass that adopts the
    // tile has no way to recover it - reading it back would mean decoding the AVIF.
    if (outcome.descriptor != null) {
      await writeFile(stagedDescriptorPath(stage.outputPath), outcome.descriptor);
    }
    const fields = outcome.header;
    return {
      width: fields.width,
      height: fields.height,
      orientation: fields.orientation,
      dateTaken: fields.timestamp == null ? null : wallClockIso(fields.timestamp),
      latitude: fields.latitude,
      longitude: fields.longitude,
      iso: fields.iso,
      shutterSpeed: fields.shutterSpeed,
      aperture: fields.aperture,
      focalLength: fields.focalLength,
      cameraMake: fields.cameraMake,
      cameraModel: fields.cameraModel,
      lensModel: fields.lensModel,
      sequence: fields.sequence,
    };
  } catch (err) {
    log.debug('could not build a tile during the scan; the rendition pass will', { file: filePath, err });
    return readRawHeader(filePath);
  }
}

function fileMetadata(header: RawHeader, dateTakenOffset: string | null, stats: Stats): FileMetadata {
  return {
    width: header.width,
    height: header.height,
    // Stage 1 constant: the header parser does not carry the camera's source
    // color space, and we always decode to sRGB, so this is the sRGB output space
    // (a fixed, informational hash input; see DESIGN §9.2/§11.1).
    colorSpace: 'sRGB',
    orientation: header.orientation,
    dateTaken: header.dateTaken,
    dateTakenOffset,
    latitude: header.latitude,
    longitude: header.longitude,
    iso: header.iso,
    shutterSpeed: header.shutterSpeed,
    aperture: header.aperture,
    focalLength: header.focalLength,
    cameraMake: header.cameraMake,
    cameraModel: header.cameraModel,
    lensModel: header.lensModel,
    sequence: header.sequence,
    mtime: stats.mtime.toISOString(),
    fileSize: stats.size,
  };
}
