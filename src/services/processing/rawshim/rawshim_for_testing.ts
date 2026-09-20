// What a test can ask about pixels, for tests and pins alone.
//
// This replaces a module that read samples back into a `Buffer`, and the difference
// is the point: that meant the native side had to hand out an address and keep it
// valid across calls. Everything the pins actually assert - that a grade is stable,
// that a decode is scene-referred - is a digest or a statistic, and both are cheaper
// to compute where the pixels already are.
//
// Lint keeps this out of `src/**`. Nothing here hands samples over, including the one
// call that reads individual pixels: four triples is a summary like any other.
import { ptr } from 'bun:ffi';
import { z } from 'zod';
import { shim } from './rawshim';

const ChannelStatsSchema = z.object({ min: z.number(), max: z.number(), mean: z.number() });
export type ChannelStats = z.infer<typeof ChannelStatsSchema>;

const DecodeSummarySchema = z.object({
  width: z.number(),
  height: z.number(),
  depth: z.number(),
  /** Samples, not bytes: a 16-bit frame has half as many as it has bytes. */
  samples: z.number(),
  bytes: z.number(),
  halved: z.boolean(),
  sha1: z.string(),
  channels: z.array(ChannelStatsSchema),
});
export type DecodeSummary = z.infer<typeof DecodeSummarySchema>;

const AgainstPreviewSchema = z.object({
  /** One mean CIEDE2000 per image, in the order asked for. */
  meanDeltaE: z.array(z.number()),
  counted: z.number(),
  sizes: z.array(z.tuple([z.number(), z.number()])),
  preview: z.tuple([z.number(), z.number()]),
});
export type AgainstPreview = z.infer<typeof AgainstPreviewSchema>;

const DebugReplySchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  reply: z
    .object({ summary: DecodeSummarySchema.optional(), againstPreview: AgainstPreviewSchema.optional() })
    .optional(),
});
type DebugReply = z.infer<typeof DebugReplySchema>;

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
  const parsed = DebugReplySchema.parse(JSON.parse(new TextDecoder().decode(out.subarray(0, written))));
  if (!parsed.ok) throw new Error(parsed.error ?? 'rawshim could not answer the debug command');
  return parsed.reply;
}

/** A decode, described rather than returned. */
export function _for_testing_decodeSummary(path: string, atLeastLongEdge = 0): DecodeSummary {
  const reply = ask({ kind: 'decodeSummary', path, atLeastLongEdge });
  if (reply?.summary == null) throw new Error(`no summary for ${path}`);
  return reply.summary;
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
  /**
   * The render's sharpen and defringe (§10.9). Absent means neither, which is what the
   * pins want; a test that needs the HDR half of that stage exercised passes them.
   */
  sharpen?: number;
  defringe?: number;
}

function gradeArgs(grade: GradeSpec): Record<string, unknown> {
  return { ...grade, maxEdge: Number.isFinite(grade.maxEdge) ? grade.maxEdge : null };
}

/**
 * One HDR rendition, encoded to `grade.outputPath`.
 *
 * `decodeSize` bounds the decode before the grade. 0 takes the whole frame, which the
 * pins want and the encode tests cannot afford.
 */
export function _for_testing_encodeHdr(
  path: string,
  grade: GradeSpec,
  options: { withMatch?: boolean; decodeSize?: number } = {},
): void {
  ask({
    kind: 'encodeHdr',
    path,
    withMatch: options.withMatch ?? false,
    grade: gradeArgs(grade),
    decodeSize: options.decodeSize ?? 0,
  });
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

/** The same crop of several renditions, tiled into one JPEG for looking at. */
export function _for_testing_tileCrops(
  imagePaths: string[],
  outputPath: string,
  window: number,
  scale: number,
): void {
  ask({ kind: 'tileCrops', imagePaths, outputPath, window, scale });
}

