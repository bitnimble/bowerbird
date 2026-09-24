import { z } from 'zod';
import { CanvasSchema, OpenAskSchema, OpenStageSchema, PairSchema } from '../features/raw_edit/local_decode/local_open';
import { TonemapSchema } from '../features/raw_edit/print/print_scene';

// `typeof` first: bun's test runtime has neither.
const FrameSchema = z.custom<VideoFrame>((value) => typeof VideoFrame === 'function' && value instanceof VideoFrame);
const BitmapSchema = z.custom<ImageBitmap>(
  (value) => typeof ImageBitmap === 'function' && value instanceof ImageBitmap,
);

const RegionSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

/**
 * One of the page's canvases, by the number `stage_canvas.ts` gave it, and its backing store's
 * size. `handed` is the element's control on its first paint, and null on every later one.
 */
const CanvasFields = {
  canvas: z.number(),
  handed: CanvasSchema.nullable(),
  width: z.number(),
  height: z.number(),
};

/** What the viewer's canvases ask the GPU worker for (`stage_gpu.ts`). */
export const StageAskSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('paint'),
    ...CanvasFields,
    picture: z.union([FrameSchema, BitmapSchema]),
    region: RegionSchema.nullable(),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    proof: TonemapSchema.nullable(),
    headroom: z.number(),
    sourcePeak: z.number(),
  }),
  z.object({
    kind: z.literal('paintMasked'),
    ...CanvasFields,
    base: FrameSchema,
    layers: z.array(z.object({ picture: FrameSchema, mask: BitmapSchema, shift: PairSchema, gain: z.number() })),
    headroom: z.number(),
  }),
  z.object({ kind: z.literal('releaseCanvas'), canvas: z.number() }),
]);
export type StageAsk = z.infer<typeof StageAskSchema>;

/** How a paint ended: drawn, or on a canvas that took a WebGPU context and cannot be drawn into. */
export const PaintedSchema = z.enum(['drawn', 'declined', 'lost']);
export type Painted = z.infer<typeof PaintedSchema>;

/** Every message the GPU worker takes, each with the id its answer carries back. */
export const MessageSchema = z.discriminatedUnion('to', [
  z.object({ id: z.number(), to: z.literal('open'), session: z.number(), ask: OpenAskSchema }),
  z.object({ id: z.number(), to: z.literal('close'), session: z.number() }),
  z.object({ id: z.number(), to: z.literal('stage'), ask: StageAskSchema }),
]);
export type Message = z.infer<typeof MessageSchema>;
export type Addressed = DistributiveOmit<Message, 'id'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const AnswerSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.number(), ok: z.literal(true), value: z.unknown() }),
  z.object({ id: z.number(), ok: z.literal(false), error: z.string() }),
]);

/** A stage the message `id` asked for has begun, sent any number of times before its answer. */
export const ProgressSchema = z.object({ id: z.number(), stage: OpenStageSchema });

export const ReplySchema = z.union([ProgressSchema, AnswerSchema]);
