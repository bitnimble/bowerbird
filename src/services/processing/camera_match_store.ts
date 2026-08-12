import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '../../logger';
import { cameraMatchPathFor } from '../../utils/paths';

const log = new Logger('processing');

/**
 * One photograph's fitted camera match, kept on disk so nothing fits it twice.
 *
 * Fitting costs about half a second and depends on nothing but the RAW file - not on any edit -
 * so a rendition, a rebuild, an editor open and every loupe tile were all paying for the same
 * answer. Measured on a 24MP CR3: a 400px tile is 660ms fitting it and 105ms handed one.
 *
 * About 5KB a photo (`native/rawshim/src/camera_match.rs` says what is in it and why the chroma
 * lattice is `f16`), against a RAW that is fifty megabytes.
 *
 * **Neither read nor write is allowed to fail a render.** A missing match is the ordinary state
 * of a photo nobody has rendered yet, and a match that cannot be written is a slow next render
 * rather than a lost photograph - so both swallow, and the fit simply happens again.
 */
export function readCameraMatch(dataPath: string, photoId: string): Uint8Array | undefined {
  try {
    return readFileSync(cameraMatchPathFor(dataPath, photoId));
  } catch {
    return undefined;
  }
}

export function writeCameraMatch(dataPath: string, photoId: string, match: Uint8Array): void {
  const at = cameraMatchPathFor(dataPath, photoId);
  try {
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, match);
  } catch (error) {
    // Worth a line rather than silence: every render of this photograph is half a second
    // slower until it succeeds, which is the kind of thing that otherwise gets blamed on the
    // decoder.
    log.warn('could not keep the camera match; it will be fitted again', { photoId, error });
  }
}
