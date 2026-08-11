import type { EditDoc } from './photo_edits';

/**
 * What a photo *looks* like once its geometry is applied, given the file's own dimensions.
 *
 * The grid lays out on this rather than on `photos.width`/`height`, which stay the file's:
 * a cropped photo occupies a different shape on the wall, and a tile laid out at the file's
 * aspect would be letterboxed or stretched for the life of the library. The editor sizes its
 * stage on it too, and the tick is told the answer so the shader's own turn arithmetic reads
 * the same grid the host laid out.
 *
 * Three steps, in the order the fractions are defined against (`EditDocSchema`):
 *
 *  1. the straighten, which grows the frame to the bounding box of the rotated rectangle -
 *     this is why a 1-degree straighten on a wide frame is not a no-op even uncropped;
 *  2. the crop, as fractions of *that*;
 *  3. the quarter turn, which swaps the pair.
 *
 * Rounded, and floored at one: a rendition of zero pixels is not a picture, and the crop
 * fractions are free to describe a rectangle narrower than a pixel at tile size.
 *
 * **Its own module, importing `EditDoc` as a type only.** It lived beside the schemas, which
 * import zod - and the page needs this function, where it deliberately takes only *types*
 * across that boundary rather than pulling a validation library into the bundle. Splitting it
 * out is what lets the editor share the one implementation instead of keeping a second.
 */
export function displaySize(width: number, height: number, doc: EditDoc): { width: number; height: number } {
  const radians = (Math.abs(doc.cropAngle) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const straightened = {
    width: width * cos + height * sin,
    height: width * sin + height * cos,
  };

  const cropped = {
    width: straightened.width * Math.max(doc.cropRight - doc.cropLeft, 0),
    height: straightened.height * Math.max(doc.cropBottom - doc.cropTop, 0),
  };

  const turned = doc.rotate === 90 || doc.rotate === 270;
  return {
    width: Math.max(1, Math.round(turned ? cropped.height : cropped.width)),
    height: Math.max(1, Math.round(turned ? cropped.width : cropped.height)),
  };
}
