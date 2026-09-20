import { z } from 'zod';

// What a reader takes a photograph away as (§10.5).
//
// **One photograph and one set of options**, and a selection is that request repeated, because
// only the client knows where each file lands: a directory handle, the browser's downloads, a
// folder the desktop shell picked. A route answering with a zip would decide that for it.

/**
 * The containers an export can be written to, and what each one can carry.
 *
 * `hdr` is whether the format has a way to *signal* high dynamic range that a viewer honours,
 * which is not the same question as bit depth: TIFF stores 16-bit and 32-bit float happily and
 * has no signalling anything reads, so it is an interchange format rather than a display one.
 * PNG earned its yes in the Third Edition, whose `cICP` chunk states BT.2100 PQ in four bytes.
 *
 * `gainMap` is narrower still: a container needs somewhere to put the second image *and* its
 * terms. JPEG carries both spellings at once - ISO 21496-1 in an `APP2` segment for Apple, and
 * Google's `hdrgm:` XMP for older Android and the sharing pipelines that never moved.
 */
// `encoder` and `gainMapEncoder` are whether this build can write the format and its map, which
// are not properties of the format and are the two fields here that will go once every encoder
// exists. They are in the table rather than in the dialog so that the control a reader sees and
// the route that would refuse them cannot disagree - the same rule the rest of this file follows.
export const EXPORT_FORMATS = {
  jpeg: { extension: 'jpg', mediaType: 'image/jpeg', hdr: false, gainMap: true, lossless: false, encoder: true, gainMapEncoder: true },
  avif: { extension: 'avif', mediaType: 'image/avif', hdr: true, gainMap: true, lossless: false, encoder: true, gainMapEncoder: true },
  jxl: { extension: 'jxl', mediaType: 'image/jxl', hdr: true, gainMap: true, lossless: false, encoder: true, gainMapEncoder: false },
  png: { extension: 'png', mediaType: 'image/png', hdr: true, gainMap: false, lossless: true, encoder: true, gainMapEncoder: false },
  tiff: { extension: 'tif', mediaType: 'image/tiff', hdr: false, gainMap: false, lossless: true, encoder: true, gainMapEncoder: false },
} as const;

export type ExportFormat = keyof typeof EXPORT_FORMATS;
export const ExportFormatSchema = z.enum(['jpeg', 'avif', 'jxl', 'png', 'tiff']);

export const ExportOptionsSchema = z.object({
  format: ExportFormatSchema.default('jpeg'),
  /** Longest edge in pixels, or 0 for the frame at the size it was shot. */
  longEdge: z.number().int().min(0).default(0),
  /** Perceived quality, 0-100 (`processing/quality.ts`). Ignored by the lossless formats. */
  quality: z.number().int().min(0).max(100).default(88),
  includeEdits: z.boolean().default(true),
  /**
   * Collapse each Bayer quad into one pixel instead of interpolating.
   *
   * Roughly halves the decode, and halves the frame with it, so it is off by default: an
   * export is the one path where a reader has asked for the best the file holds.
   */
  halfSize: z.boolean().default(false),
  exportHdr: z.boolean().default(true),
  /**
   * Carry an SDR rendition beside the HDR one, for viewers that cannot show the HDR.
   *
   * Only meaningful with `exportHdr`, and only in a format that can hold both. The base stays
   * 8-bit here **because compatibility is the whole reason to ask for it**: a reader that
   * ignores the gain map has to see a correct ordinary picture, which is the opposite of the
   * trade the renditions make (they keep a PQ base so nothing that already works regresses).
   */
  gainMap: z.boolean().default(false),
});
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;

export const ExportRequestSchema = z.object({
  photoId: z.string().min(1),
  options: ExportOptionsSchema,
  /**
   * Which run to remember this export under (§10.5.2), or absent to render and remember
   * nothing. Named here rather than reported afterwards because the history's tile is a second
   * size off this render: asked for at the same moment or not at all.
   */
  runId: z.string().min(1).optional(),
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

/**
 * The options as the picked format can actually honour them.
 *
 * One answer for the dialog, which greys a control out, and for the route, which must not
 * trust that it did. Asking the format rather than restating its table keeps a control that
 * says "unavailable" and a file that ignores the setting from ever disagreeing.
 */
export function honoured(options: ExportOptions): ExportOptions {
  const format = EXPORT_FORMATS[options.format];
  // A gain map with no HDR to reconstruct is a second copy of the base image.
  const gainMap = options.gainMap && options.exportHdr && format.gainMap && format.gainMapEncoder;
  return {
    ...options,
    // **A gain map is the second way a format holds HDR**, and the one JPEG has: its primary
    // image is an ordinary eight-bit picture, and the range lives in the map beside it. So a
    // container that cannot signal HDR itself still renders an HDR alternate to build one from.
    exportHdr: options.exportHdr && (format.hdr || gainMap),
    gainMap,
  };
}

/** What this export lands under, given the original's name. */
export function exportFilename(originalPath: string, format: ExportFormat): string {
  const name = originalPath.split('/').pop() ?? 'photo';
  return `${name.replace(/\.[^.]+$/, '')}.${EXPORT_FORMATS[format].extension}`;
}
