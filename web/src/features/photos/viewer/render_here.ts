import { photosApi } from '../../../api/photos';
import { renditionsApi } from '../../../api/renditions';
import type { Rendition } from '../../../../../src/services/processing/renditions/renditions';
import { LocalDecoder } from '../../raw_edit/local_decode/local_decoder';

/**
 * Builds a rendition on this device's GPU and hands the server the picture to encode and keep.
 *
 * Asks the server to build it instead wherever the server has no job for a client - the copy is
 * current, or the row is one only the server can compose.
 */
export async function renderHere(photoId: string, rendition: Rendition, force: boolean): Promise<void> {
  const asked = await renditionsApi.job(photoId, rendition, force).catch((error) => {
    console.warn("could not request a local render job, so the server is building it", error);
    return null;
  });
  if (asked?.job == null) return renditionsApi.build(photoId, rendition, force);
  const decoder = new LocalDecoder();
  try {
    const rendered = await decoder.render(await photosApi.downloadRaw(photoId), asked.job);
    await renditionsApi.keep(photoId, rendition, asked.builtFrom, rendered);
  } catch (error) {
    console.warn("rendering on this device failed, so the server is building it", error);
    await renditionsApi.build(photoId, rendition, force);
  } finally {
    decoder.close();
  }
}
