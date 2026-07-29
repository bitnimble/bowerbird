// Reading samples back out of Rust. Tests only, and lint enforces it
// (`.oxlintrc.json` bans this module from `src/**`).
//
// Pixel work belongs in `native/rawshim`. Everything crossing the boundary in
// production is either a handle, which is an opaque pointer, or an encoded file
// on its way to the client; nothing in `src/` turns an image into numbers it
// then does arithmetic on. That is not a style preference: a per-pixel loop in
// TypeScript is both far slower than the same loop in Rust and a second place
// for the colour model to live, and the last time image maths was split across
// the boundary it meant reaching into LibRaw's params struct from JavaScript.
//
// What is left here is the one thing the rule cannot cover: assertions. The
// integration tests pin real pixel-level behaviour - that a written AVIF matches
// the decode it came from, that a JPEG-matched render differs from a plain one,
// that HDR grading is stable frame to frame - and an assertion has to see the
// samples to make it. Hence: available, copied, and only ever in a test.

import { ptr, toArrayBuffer } from 'bun:ffi';
import { shim } from './rawshim';
import type { OutputSpace } from './raw_decoder';
import {
  IMAGE,
  decodeRawImage,
  freeImage,
  handleOf,
  hdrOptionsBuffer,
  takeBuffer,
  type HdrMatchHandle,
  type HdrOptions,
  type ImageHandle,
} from './rawshim_ops';

/** The samples, copied into JS. */
export function pixels(image: ImageHandle): Buffer {
  const head = new DataView(toArrayBuffer(image.pointer, 0, IMAGE.size));
  const address = Number(head.getBigUint64(IMAGE.data, true));
  const length = Number(head.getBigUint64(IMAGE.len, true));
  return Buffer.from(new Uint8Array(toArrayBuffer(address as never, 0, length)));
}

export interface DecodedImage {
  width: number;
  height: number;
  /** 8 for renditions, 16 for a full-depth export. */
  depth: 8 | 16;
  /** Interleaved RGB, already rotated to display orientation. */
  data: Buffer;
}

/**
 * Decodes a RAW and copies the samples out, releasing the handle.
 *
 * `atLeastLongEdge` is the longest edge the caller needs; where halving the frame
 * still clears it the decode runs at half size. 0 decodes the whole frame.
 *
 * Production decodes with `decodeRawImage` and keeps the handle. This is the
 * form a test wants when it is going to assert on what came back.
 */
export function decodeRaw(
  filePath: string,
  depth: 8 | 16 = 8,
  space: OutputSpace = 'srgb',
  options: { atLeastLongEdge?: number } = {},
): DecodedImage {
  const image = decodeRawImage(filePath, depth, space, options.atLeastLongEdge ?? 0);
  try {
    return { width: image.width, height: image.height, depth, data: pixels(image) };
  } finally {
    freeImage(image);
  }
}

/**
 * A handle over a copy of RGB pixels JS already holds.
 *
 * The one direction that copies on purpose. It exists so a test can construct a
 * target - a deliberately distorted frame, say - and hand it over in the form a
 * decode would have produced.
 */
export function imageFromRgb(data: Buffer, width: number, height: number): ImageHandle {
  return handleOf(shim().bb_image_from_rgb(data, width, height), 'take those pixels');
}

/**
 * The graded 16-bit samples the HDR encode would hand to ffmpeg.
 *
 * For the pin that holds this against the TypeScript it replaced. It copies the
 * whole frame, which is what the production path exists to avoid.
 */
export function hdrGradedSamples(
  linear: ImageHandle,
  matched: HdrMatchHandle | null,
  options: HdrOptions,
): { width: number; height: number; data: Buffer } {
  const size = new Uint32Array(2);
  const data = takeBuffer(
    shim().bb_hdr_graded(
      linear.pointer,
      matched == null ? null : matched.pointer,
      ptr(hdrOptionsBuffer(options)),
      ptr(size),
    ),
  );
  if (data == null) throw new Error('rawshim could not grade that decode');
  return { width: size[0]!, height: size[1]!, data };
}
