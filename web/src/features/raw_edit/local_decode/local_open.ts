import { z } from 'zod';
import type { DustSettings } from '../../../../../src/schemas/dust_settings';
import type { Repair } from '../../../../../src/schemas/photo_edits';
import {
  DustSettingsSchema,
  type JobAdjust,
  type JobGrade,
  type JobLevels,
  type NoiseFit,
} from '../../../../../src/schemas/jobs';
import { SoftProofSchema } from '../edits';

/** `crate::edit::EditRequest`, which the module takes as JSON. */
export type LocalOpen = {
  /** Longest edge the decode is fitted to, which is the size every tick then grades. */
  longEdge: number;
  /**
   * What has already been measured about this photograph, where it has been kept.
   *
   * The camera match, the noise fit and the levels: most of a second of the open, and none of it
   * depending on anything a reader can move - so an open that has been through this before skips
   * all three.
   *
   * Bytes as numbers because this whole struct crosses as JSON: a `Uint8Array` here stringifies to
   * an object of numeric keys, which the far side rejects as a malformed request.
   */
  photoAnalysis?: number[];
  grade: JobGrade;
  /**
   * The library's defringe strength, which is the only filter an open decides.
   *
   * The sharpen is in [`LocalPrepare`] with the denoise pair, for the reason that type gives: a
   * Detail slider moves without reopening anything, so a copy here could only ever be the position
   * the photograph happened to be opened at.
   */
  defringe: number;
};

/**
 * Everything a re-prepare is a function of: the Detail panel, either side of the demosaic.
 *
 * Here rather than in [`LocalOpen`] because everything in that was decided above them - a
 * photograph is held at its mosaic and these are what re-run against it, so putting them in the
 * request would rebuild the whole open on every slider move.
 *
 * The first three belong on the mosaic for one reason each, and it is the same reason. The denoise
 * wants the noise while it is still one photosite's own, and the dust correction wants the shadow
 * while it is still one number per photosite rather than three the demosaic has interpolated
 * between - and both want to be above the sharpen, which would otherwise ring what they are trying
 * to remove. `sharpen` is that stage, at the far end of the same prepare. These are the same calls
 * a rendition makes, so the editor and the export are one pipeline rather than two that have to be
 * argued into agreeing.
 */
export type LocalPrepare = {
  /** Null is the document not having said, answered by the frame's own fit (`galosh::Detail`). */
  luminance: number | null;
  colour: number | null;
  sharpen: number;
  dust: DustSettings;
  /**
   * The reader's repairs, which come after the sharpen and so after everything above - here with
   * them because a repair moves pixels the frame on the device already holds, and a re-prepare is
   * what puts those pixels back.
   */
  repairs: Repair[];
};

/**
 * A `LocalPrepare` as it crosses to the worker: the repairs as JSON text, because on this side
 * they are the document's own observable arrays, and a proxy cannot be structured-cloned.
 */
export type PrepareCrossing = z.infer<typeof PrepareCrossingSchema>;

export function crossing(mosaic: LocalPrepare): PrepareCrossing {
  return { ...mosaic, repairs: JSON.stringify(mosaic.repairs) };
}

/** `crate::tile::TileRequest`, which the module takes as JSON. */
export type LocalTileRequest = {
  /** `[left, top, width, height]` in the photograph's own pixels, which is the frame's space. */
  tile: [number, number, number, number];
  /** The photograph the rectangle is a piece of, which only this side knows. */
  frame: [number, number];
  grade: JobGrade;
  strengths: { sharpen: number; defringe: number };
  denoiseLuminance: number | null;
  denoiseColour: number | null;
  dust: DustSettings;
  /** Read for the presence three alone: how far past the tile the guided filter reaches. */
  adjust: JobAdjust;
  /** The photograph's, measured at the open - a crop's own describe where the reader is pointing. */
  levels: JobLevels | null;
  noiseFit: NoiseFit | null;
  /** The photograph's, fitted at the open - a tile's own describes only its window's edges. */
  defocus: [number, number] | null;
  photoAnalysis?: number[];
  repairs: Repair[];
};

const PairSchema = z.tuple([z.number(), z.number()]);
export const RectSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const PointsSchema = z.array(PairSchema);
export const BytesSchema = z.custom<Uint8Array<ArrayBuffer>>(
  (value) => value instanceof Uint8Array && value.buffer instanceof ArrayBuffer,
);
// `typeof` first: bun's test runtime has no `OffscreenCanvas` at all.
const CanvasSchema = z.custom<OffscreenCanvas>(
  (value) => typeof OffscreenCanvas !== 'undefined' && value instanceof OffscreenCanvas,
);
export const BlobSchema = z.instanceof(Blob);
export const JsonSchema = z.string();
export const NothingSchema = z.null();

export const ShownSchema = z.object({ missing: z.array(RectSchema).nullable() });

/** Where a held tile's window sits, which is what the glass is positioned by. */
export const TileKeepSchema = z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() });
export type TileKeep = z.infer<typeof TileKeepSchema>;

const PrepareCrossingSchema = z.object({
  luminance: z.number().nullable(),
  colour: z.number().nullable(),
  sharpen: z.number(),
  dust: DustSettingsSchema,
  repairs: JsonSchema,
});

/** What `local_open_worker.ts` is asked for, each with the id its answer carries back. */
export const AskSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.number(), kind: z.literal('hold'), raw: BytesSchema }),
  z.object({ id: z.number(), kind: z.literal('render'), raw: BytesSchema, job: JsonSchema }),
  z.object({ id: z.number(), kind: z.literal('prepare'), request: JsonSchema, mosaic: PrepareCrossingSchema }),
  z.object({ id: z.number(), kind: z.literal('holdPicture'), framed: BytesSchema, request: JsonSchema }),
  z.object({ id: z.number(), kind: z.literal('takePicture'), framed: BytesSchema }),
  z.object({ id: z.number(), kind: z.literal('takeTiles'), framed: BytesSchema, asked: JsonSchema }),
  z.object({ id: z.number(), kind: z.literal('showTiles'), level: JsonSchema, rect: JsonSchema }),
  z.object({ id: z.number(), kind: z.literal('picturePart'), region: JsonSchema }),
  z.object({
    id: z.number(),
    kind: z.literal('attach'),
    which: z.enum(['stage', 'loupe']),
    canvas: CanvasSchema,
    width: z.number(),
    height: z.number(),
  }),
  z.object({ id: z.number(), kind: z.literal('releaseLoupe') }),
  z.object({ id: z.number(), kind: z.literal('holdTile'), request: JsonSchema }),
  z.object({ id: z.number(), kind: z.literal('releaseTile') }),
  z.object({ id: z.number(), kind: z.literal('analysis') }),
  z.object({
    id: z.number(),
    kind: z.literal('bandInto'),
    mosaic: PrepareCrossingSchema,
    top: z.number(),
    rows: z.number(),
    frame: PairSchema,
  }),
  z.object({ id: z.number(), kind: z.literal('redrawRepairs'), repairs: JsonSchema }),
  z.object({ id: z.number(), kind: z.literal('refreshDetail') }),
  z.object({
    id: z.number(),
    kind: z.literal('solveRepair'),
    drawn: JsonSchema,
    others: JsonSchema,
    grow: z.boolean(),
    without: JsonSchema.nullable(),
    donor: JsonSchema.nullable(),
  }),
  z.object({ id: z.number(), kind: z.literal('setRepairs'), repairs: JsonSchema }),
  z.object({ id: z.number(), kind: z.literal('setSearched'), drawn: JsonSchema, donor: JsonSchema.nullable() }),
  z.object({ id: z.number(), kind: z.literal('dropTiles') }),
  z.object({ id: z.number(), kind: z.literal('pictureOfOutput'), geometry: JsonSchema, points: JsonSchema }),
  z.object({ id: z.number(), kind: z.literal('outputOfPicture'), geometry: JsonSchema, points: JsonSchema }),
  z.object({
    id: z.number(),
    kind: z.literal('repairThumbnail'),
    side: z.number(),
    ev: z.number(),
    region: JsonSchema,
    repair: JsonSchema,
  }),
  z.object({
    id: z.number(),
    kind: z.literal('optionThumbnail'),
    side: z.number(),
    ev: z.number(),
    region: JsonSchema,
    showing: JsonSchema.nullable(),
    option: JsonSchema,
  }),
  z.object({
    id: z.number(),
    kind: z.literal('tick'),
    ev: z.number(),
    /** Whether the stage is drawn at all: a pointer move over the glass draws only the loupe. */
    drawStage: z.boolean(),
    /** Absent draws the cropped picture whole, which the module works out from the geometry. */
    region: JsonSchema.nullable(),
    loupe: JsonSchema.nullable(),
    adjust: JsonSchema.nullable(),
    geometry: JsonSchema.nullable(),
    proof: SoftProofSchema.nullable(),
    /**
     * The backing store the stage wants, applied before the draw that reads it.
     *
     * Carried on the tick rather than sent as its own message: the two have to land in that
     * order, and one message cannot be got out of order with itself.
     */
    stage: z.object({ width: z.number(), height: z.number() }).nullable(),
  }),
]);
export type Ask = z.infer<typeof AskSchema>;
export type Job = DistributiveOmit<Ask, 'id'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const AnswerSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.number(), ok: z.literal(true), value: z.unknown() }),
  z.object({ id: z.number(), ok: z.literal(false), error: z.string() }),
]);
export type Answer = z.infer<typeof AnswerSchema>;
