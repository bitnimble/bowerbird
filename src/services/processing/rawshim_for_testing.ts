// What a test can ask about pixels, for tests and pins alone.
//
// This replaces `rawshim_pixels.ts`, and the difference is the point: that module
// read samples back into a `Buffer`, which meant the native side had to hand out an
// address and keep it valid across calls. Everything the pins actually assert - that
// two decode routes agree, that a grade is stable, that a decode is scene-referred -
// is a digest or a statistic, and both are cheaper to compute where the pixels
// already are.
//
// Lint keeps this out of `src/**`. Nothing here hands samples over, including the one
// call that reads individual pixels: four triples is a summary like any other.
import { ptr } from 'bun:ffi';
import { shim } from './rawshim';

export interface ChannelStats {
  min: number;
  max: number;
  mean: number;
}

export interface DecodeSummary {
  width: number;
  height: number;
  depth: number;
  /** Samples, not bytes: a 16-bit frame has half as many as it has bytes. */
  samples: number;
  bytes: number;
  halved: boolean;
  /**
   * Whether the decode came straight out of LibRaw's processed buffer rather than
   * through `dcraw_make_mem_image` (§10.4). The differential pin checks its two arms
   * took different routes; without it a passing comparison proves nothing.
   */
  direct: boolean;
  sha1: string;
  channels: ChannelStats[];
}

export interface Comparison {
  width: number;
  height: number;
  /** Null when the two images are identical, PSNR being infinite there. */
  psnr: number | null;
}

export interface AgainstPreview {
  /** One mean deltaE76 per image, in the order asked for. */
  meanDeltaE: number[];
  counted: number;
  sizes: [number, number][];
  preview: [number, number];
}

interface DebugReply {
  ok: boolean;
  error?: string;
  reply?: {
    summary?: DecodeSummary;
    comparison?: Comparison;
    againstPreview?: AgainstPreview;
    usedAvifenc?: boolean;
  };
}

// Comfortably past any reply: a summary is a few hundred bytes.
const CAPACITY = 64 * 1024;

function ask(command: Record<string, unknown>): DebugReply['reply'] {
  const bytes = Buffer.from(JSON.stringify(command), 'utf8');
  let out = new Uint8Array(CAPACITY);
  let written = Number(shim().bb_for_testing_debug(bytes, bytes.byteLength, ptr(out), out.byteLength));
  if (written > out.byteLength) {
    out = new Uint8Array(written);
    written = Number(shim().bb_for_testing_debug(bytes, bytes.byteLength, ptr(out), out.byteLength));
  }
  if (written < 0) throw new Error('rawshim could not answer the debug command');
  const parsed = JSON.parse(new TextDecoder().decode(out.subarray(0, written))) as DebugReply;
  if (!parsed.ok) throw new Error(parsed.error ?? 'rawshim could not answer the debug command');
  return parsed.reply;
}

export interface DecodeRequest {
  depth?: 8 | 16;
  space?: 'srgb' | 'rec2020-linear';
  atLeastLongEdge?: number;
}

/** A decode, described rather than returned. */
export function _for_testing_decodeSummary(path: string, request: DecodeRequest = {}): DecodeSummary {
  const reply = ask({
    kind: 'decodeSummary',
    path,
    depth: request.depth ?? 8,
    rec2020Linear: request.space === 'rec2020-linear',
    atLeastLongEdge: request.atLeastLongEdge ?? 0,
  });
  if (reply?.summary == null) throw new Error(`no summary for ${path}`);
  return reply.summary;
}

/**
 * A written image against an 8-bit decode of the RAW it came from.
 *
 * The comparison happens where both sets of pixels already are; what comes back is
 * the number the assertion was going to reduce them to anyway.
 */
export function _for_testing_comparePsnr(imagePath: string, rawPath: string): Comparison {
  const reply = ask({ kind: 'comparePsnr', imagePath, rawPath });
  if (reply?.comparison == null) throw new Error(`no comparison for ${imagePath}`);
  return reply.comparison;
}

/** The parts of an HDR encode a pin varies. */
export interface GradeSpec {
  peakNits: number;
  referenceWhiteNits: number;
  whiteQuantile: number;
  crf: number;
  preset: number;
  /**
   * Longest edge, or `Infinity` for the frame's own size - which crosses as null,
   * `JSON.stringify` having no way to write an infinity.
   */
  maxEdge: number;
  stillFullChroma?: boolean;
  outputPath?: string;
  /** A still gets avifenc after ffmpeg; a video does not. Defaults to a still. */
  medium?: 'still' | 'video';
  /**
   * The render's denoise and sharpen (§10.9). Absent means neither, which is what the
   * pins want; a test that needs the HDR half of that stage exercised passes them.
   */
  denoise?: number;
  sharpen?: number;
}

function gradeArgs(grade: GradeSpec): Record<string, unknown> {
  return { ...grade, maxEdge: Number.isFinite(grade.maxEdge) ? grade.maxEdge : null };
}

/**
 * One HDR rendition, encoded to `grade.outputPath`, plus the video twin where one is
 * named.
 *
 * `decodeSize` bounds the decode before the grade. 0 takes the whole frame, which the
 * pins want and the encode tests cannot afford.
 *
 * Reports which route the still took, which the differential against `avifenc` asserts
 * on: the two now produce byte-identical 4:4:4 files, so nothing about the output can
 * tell a real comparison from one arm compared with itself.
 */
export function _for_testing_encodeHdr(
  path: string,
  grade: GradeSpec,
  options: { withMatch?: boolean; videoOutputPath?: string; decodeSize?: number } = {},
): { usedAvifenc: boolean } {
  const reply = ask({
    kind: 'encodeHdr',
    path,
    withMatch: options.withMatch ?? false,
    grade: gradeArgs(grade),
    videoOutputPath: options.videoOutputPath ?? '',
    decodeSize: options.decodeSize ?? 0,
  });
  return { usedAvifenc: reply?.usedAvifenc ?? false };
}

/** The camera's embedded preview, described. */
export function _for_testing_previewSummary(path: string, size = 0): DecodeSummary {
  const reply = ask({ kind: 'previewSummary', path, size });
  if (reply?.summary == null) throw new Error(`no preview for ${path}`);
  return reply.summary;
}

/** Written images against the preview of the RAW they were built from. */
export function _for_testing_deltaEToPreview(imagePaths: string[], rawPath: string): AgainstPreview {
  const reply = ask({ kind: 'deltaEToPreview', imagePaths, rawPath });
  if (reply?.againstPreview == null) throw new Error(`no comparison for ${rawPath}`);
  return reply.againstPreview;
}

