import { ptr } from 'bun:ffi';
import { shim } from './rawshim';
import type { Job } from '../../../schemas/jobs';
import { type PreparedHeader, type PreparedReplyHeader, PreparedReplyHeaderSchema } from '../../../schemas/prepared';

/** One picture of a recipe, coded, as it came back: the header, and the samples behind it. */
export interface PreparedPicture {
  header: PreparedHeader;
  /** The framed reply, whole. A response body: the page reads the same framing the library wrote. */
  framed: Uint8Array;
}

/** Three 16-bit samples, which is a pixel of every frame the pipeline holds. */
const BYTES_PER_PIXEL = 6;

/**
 * One picture of a recipe, prepared at `level` and handed back framed.
 *
 * `width` and `height` bound the allocation rather than requesting a size: the header that comes
 * back states what was actually prepared. Sized rather than grown-and-retried, which is
 * `bb_prepare_picture`'s own rule and why.
 *
 * `window` is `[left, top, width, height]` in that level's own pixels, omitted for the whole of it.
 * `parts` are the squares inside it that were actually asked for: the library decodes each source
 * for the box bounding *that source's* own squares and never opens a source no square reaches, so
 * an L of tiles costs what the L covers rather than what its corner does.
 */
export function preparePicture(
  job: Job,
  level: number,
  width: number,
  height: number,
  window?: [number, number, number, number],
  parts?: [number, number, number, number][],
): PreparedPicture {
  const command = Buffer.from(JSON.stringify({ job, level, window, parts }), 'utf8');
  const headerCap = Number(shim().bb_prepare_header_cap());
  const reply = new Uint8Array(width * height * BYTES_PER_PIXEL + headerCap);
  const written = Number(
    shim().bb_prepare_picture(command, command.byteLength, ptr(reply), reply.byteLength),
  );

  if (written < 0) throw new Error('rawshim could not prepare the picture');
  if (written > reply.byteLength) {
    throw new Error(
      `a prepared picture of ${width}x${height} needs ${written} bytes and was given ${reply.byteLength}`,
    );
  }

  const framed = reply.subarray(0, written);
  const header = readHeader(framed);
  if ('error' in header) throw new Error(header.error);
  return { header, framed };
}

/**
 * The header out of a framed reply: a `u32` length, then that much JSON.
 *
 * The samples' offset is not computed here - `edit::samples_at` states it and the page reads the
 * same rule - because this side never looks at a sample. It passes the frame through.
 */
function readHeader(framed: Uint8Array): PreparedReplyHeader {
  if (framed.byteLength < 4) throw new Error('a prepared picture came back with no header');
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  const length = view.getUint32(0, true);
  if (4 + length > framed.byteLength) {
    throw new Error(`a prepared picture states a ${length}-byte header in ${framed.byteLength} bytes`);
  }
  return PreparedReplyHeaderSchema.parse(JSON.parse(new TextDecoder().decode(framed.subarray(4, 4 + length))));
}
