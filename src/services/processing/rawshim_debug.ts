// What a test can ask about pixels, for tests and pins alone.
//
// This replaces `rawshim_pixels.ts`, and the difference is the point: that module
// read samples back into a `Buffer`, which meant the native side had to hand out an
// address and keep it valid across calls. Everything the pins actually assert - that
// two decode routes agree, that a grade is stable, that a decode is scene-referred -
// is a digest or a statistic, and both are cheaper to compute where the pixels
// already are.
//
// Lint keeps this out of `src/**`. It is not a production API and the one door in it
// that does hand bytes over, `dumpDecode`, goes through a file and says so in the log.
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

interface DebugReply {
  ok: boolean;
  error?: string;
  reply?: { summary?: DecodeSummary; written?: number };
}

// Comfortably past any reply: a summary is a few hundred bytes.
const CAPACITY = 64 * 1024;

function ask(command: Record<string, unknown>): DebugReply['reply'] {
  const bytes = Buffer.from(JSON.stringify(command), 'utf8');
  let out = new Uint8Array(CAPACITY);
  let written = Number(shim().bb_debug(bytes, bytes.byteLength, ptr(out), out.byteLength));
  if (written > out.byteLength) {
    out = new Uint8Array(written);
    written = Number(shim().bb_debug(bytes, bytes.byteLength, ptr(out), out.byteLength));
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
export function decodeSummary(path: string, request: DecodeRequest = {}): DecodeSummary {
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
 * A decode's samples, written to `outPath`, plus its summary.
 *
 * The only way to get pixels out, and it goes through the filesystem on purpose:
 * opening a buffer path for the one test that needs bytes would reopen the thing
 * this whole boundary exists to close. The native side logs a warning every time,
 * so a production call shows up in the logs rather than in a review that did not
 * happen.
 */
export function dumpDecode(path: string, outPath: string, request: DecodeRequest = {}): DecodeSummary {
  const reply = ask({
    kind: 'dumpDecode',
    path,
    depth: request.depth ?? 8,
    rec2020Linear: request.space === 'rec2020-linear',
    atLeastLongEdge: request.atLeastLongEdge ?? 0,
    outPath,
  });
  if (reply?.summary == null) throw new Error(`no summary for ${path}`);
  return reply.summary;
}
