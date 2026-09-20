import { EXPORT_FORMATS, honoured, type ExportOptions } from '../../../schemas/export';

// About how large an export will be, for the dialog to say so before it runs (§10.5).
//
// **Coarse on purpose, and labelled that way where it is shown.** The honest answer needs the
// encoder, and the encoder needs the frame - a flat sky and a forest at the same setting differ
// by several times - so anything cheap enough to recompute as a reader drags a slider is a
// model rather than a measurement. What this is for is the decision it actually informs: "is
// this going to be 2MB or 200MB", which a model gets right.
//
// Like the quality anchors, the table is data and the arithmetic knows nothing about it, so
// re-measuring is an edit to one row.

/**
 * Bits per output pixel at quality 80, the shipping default.
 *
 * The compressed formats are anchored on §10.1 and §10.7's own measurements at 3840 and 4:2:0.
 * The lossless two are not from this codebase - neither has an encoder here yet - and are the
 * usual range for a photograph rather than a synthetic image, which compresses far better.
 */
const BITS_PER_PIXEL: Record<string, number> = {
  'jpeg-sdr': 1.2,
  'avif-sdr': 0.45,
  'avif-hdr': 0.6,
  'jxl-sdr': 0.35,
  'jxl-hdr': 0.5,
  // Lossless, so quality does not move these and depth does: 8 bits a channel against 16.
  'png-sdr': 10,
  'png-hdr': 18,
  'tiff-sdr': 20,
  'tiff-hdr': 40,
};

/**
 * How fast the file grows with quality: bytes roughly double every 15 points near the top.
 *
 * A rate rather than a curve per format, because the anchors above are one point each and a
 * shape fitted through one point is invention. It is right where it matters - around the
 * default - and increasingly approximate towards either end.
 */
const DOUBLES_EVERY = 15;

/** What a gain map adds: a second image, smooth and small, plus its terms. */
const GAIN_MAP_OVERHEAD = 1.3;

/**
 * Rough bytes for one photograph exported with these options.
 *
 * `sourcePixels` is the frame the export starts from, so a caller that knows the photograph's
 * own dimensions gets an answer scaled to it. Null where the format has no model, which is
 * the dialog's cue to say nothing rather than to guess.
 */
export function estimateExportBytes(
  requested: ExportOptions,
  source: { width: number; height: number } | null,
): number | null {
  if (source == null || source.width <= 0 || source.height <= 0) return null;
  // Asked for here rather than trusted from the caller: a JPEG cannot be HDR, and an estimate
  // that took `exportHdr` at its word would look up a combination that has no row.
  const options = honoured(requested);

  const longest = Math.max(source.width, source.height);
  // 0 means "as shot", and a request for more pixels than the frame holds does not invent any.
  const scale = options.longEdge === 0 ? 1 : Math.min(options.longEdge / longest, 1);
  const halved = options.halfSize ? 0.5 : 1;
  const pixels = source.width * source.height * scale * scale * halved * halved;

  // What the *primary image* costs, which is the eight-bit one wherever a gain map carries the
  // range: an Ultra HDR JPEG is a JPEG plus a map, not a JPEG that got larger per pixel.
  const hdr = options.exportHdr && EXPORT_FORMATS[options.format].hdr;
  const bpp = BITS_PER_PIXEL[`${options.format}-${hdr ? 'hdr' : 'sdr'}`];
  if (bpp == null) return null;

  const lossless = EXPORT_FORMATS[options.format].lossless;
  const scaled = lossless ? bpp : bpp * Math.pow(2, (options.quality - 80) / DOUBLES_EVERY);
  const bytes = (pixels * scaled) / 8;
  return Math.round(options.gainMap ? bytes * GAIN_MAP_OVERHEAD : bytes);
}
