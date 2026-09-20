import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '../../../logger';
import { photoAnalysisPathFor } from '../../../utils/paths';

const log = new Logger('processing');

/**
 * One photograph's measurements, kept on disk so nothing measures them twice.
 *
 * The camera match is about half a second, the noise fit a quarter of one, and the levels a
 * quantile over a million samples - and none of them depend on any edit, so a rendition, a
 * rebuild, an editor open and every loupe tile were all paying for the same answers. Measured on a
 * 24MP CR3: a 400px tile is 660ms measuring them and 105ms handed them.
 *
 * About 5KB a photo (`native/rawshim/src/photo_analysis.rs` says what is in it and why the chroma
 * lattice is `f16`), against a RAW that is fifty megabytes.
 *
 * **Neither read nor write is allowed to fail a render.** A missing file is the ordinary state of a
 * photo nobody has rendered yet, and one that cannot be written is a slow next render rather than a
 * lost photograph - so both swallow, and the measuring simply happens again.
 */
export function readPhotoAnalysis(dataPath: string, photoId: string): number[] | undefined {
  try {
    // Numbers, not the `Buffer` this reads: every caller puts it straight into a job that
    // crosses as JSON, and a `Buffer` stringifies to `{"type":"Buffer",...}` there.
    return Array.from(readFileSync(photoAnalysisPathFor(dataPath, photoId)));
  } catch {
    return undefined;
  }
}

export function writePhotoAnalysis(dataPath: string, photoId: string, analysis: Uint8Array): void {
  const at = photoAnalysisPathFor(dataPath, photoId);
  try {
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, analysis);
  } catch (error) {
    // Worth a line rather than silence: every render of this photograph is most of a second slower
    // until it succeeds, which is the kind of thing that otherwise gets blamed on the decoder.
    log.warn('could not keep the photo analysis; it will be measured again', { photoId, error });
  }
}
