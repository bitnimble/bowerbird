// The tick's shader modules, composed from `wgsl/`.
//
// WGSL has no `#include`, so the sharing happens here: each module is a concatenation of
// real `.wgsl` files, in dependency order, and a file states its own bindings. Kept as
// files rather than as template literals because a template literal cannot hold a
// backtick - which broke this build three times over - and because an editor will not
// highlight, format or check a string.
//
// What each file may assume of the ones before it:
//
//   prelude   nothing
//   tick      nothing; declares `tick` at binding 0
//   adjust    prelude and tick; declares bindings 13-14, and reads `lerp` from colour
//   colour    prelude, tick and adjust; declares bindings 1-4, 7, 10-12
//   frame     all three; declares bindings 5-6 and 9
//   peak      prelude, tick, colour; declares bindings 5-6 and 8
//   reduce    tick; declares bindings 1-3, on a layout of its own
//   decode    prelude; declares binding 12 writable, on a layout of its own
//   detail    prelude and tick; declares bindings 1-3 and 12, on layouts of its own
//   balance   prelude and tick; declares binding 14 writable, on a layout of its own
//
// `adjust` naming `lerp` before `colour` declares it is legal and deliberate: a WGSL
// module-scope declaration is in scope for the whole program, so the order here is a
// dependency order for readers rather than for the compiler. Moving the sampler earlier would
// put a binding `reduce` never uses into the module it shares `tick` with.
//
// Numbers that both sides need are declared in the `.wgsl` and pinned to the host's copy by a
// test, rather than substituted into the source, so the files stay valid WGSL on their own. A
// pipeline-overridable constant only where the value actually differs between pipelines.

import adjust from './wgsl/adjust.wgsl?raw';
import colour from './wgsl/colour.wgsl?raw';
import decodeSource from './wgsl/decode.wgsl?raw';
import detailSource from './wgsl/detail.wgsl?raw';
import frame from './wgsl/frame.wgsl?raw';
import peak from './wgsl/peak.wgsl?raw';
import prelude from './wgsl/prelude.wgsl?raw';
import reduceSource from './wgsl/reduce.wgsl?raw';
import tick from './wgsl/tick.wgsl?raw';
import whiteBalance from './wgsl/white_balance.wgsl?raw';

const compose = (...parts: string[]): string => parts.join('\n');

/** Sensor levels to a canvas, and the same frame as a rendition would hold it. */
export const FRAME = compose(prelude, tick, adjust, colour, frame);

/** The scene peak: a histogram over the whole frame, and the scan that reads it. */
export const PEAK = compose(prelude, tick, adjust, colour, peak);

/** The pyramid the draw averages with, built once at the open. */
export const REDUCE = compose(tick, reduceSource);

/** The frame's coding undone, one entry per code. The same table for every photo. */
export const DECODE = compose(prelude, decodeSource);

/** The blur the presence sliders read, built once at the open. */
export const DETAIL = compose(prelude, tick, detailSource);

/** The reader's temperature and tint, solved into one matrix. One invocation, per tick. */
export const BALANCE = compose(prelude, tick, whiteBalance);

// The detail blur's working size used to be a rule here too, alongside `gpu::detail_size`, and
// pinned to it by `DETAIL_LONG`. It arrives on `PreparedHeader.detail` now: how large a share of
// the picture each blur covers follows from it, and two hosts rounding it differently would
// apply two different clarities to one photograph with nothing to say which was meant.

/** Floats the balance pass writes: three rows of four, the fourth of each unread. */
export const BALANCE_FLOATS = 12;

/** The blur's working texture, as the native side sized it. */
export interface DetailSize {
  width: number;
  height: number;
}

/** Entries in that table, which is every `u16` a sample can hold. */
export const PQ_CODES = 65536;

/**
 * `struct Tick` in `wgsl/tick.wgsl`, field for field and in its order.
 *
 * The shader is the source of truth; this is the same declaration in a form the host can
 * index by. `writeUniform` wrote bare numbers into the buffer before - `values[22] = region.x`
 * - which is the shader's field order copied out by hand into two dozen literals, with
 * nothing checking either the order or the alignment. Swapping two fields in the WGSL left
 * every suite green and drew the wrong rectangle of the frame, because the only thing that
 * reads the tail is the draw and no test looks at a drawn pixel.
 *
 * `gpu/tests/tick_uniform.test.ts` parses the struct out of the `.wgsl` and holds this
 * against it, so the two cannot drift without something saying so.
 */
export const TICK_LAYOUT = [
  ['width', 'u32'],
  ['height', 'u32'],
  ['white', 'f32'],
  ['source_level', 'f32'],
  ['reference', 'f32'],
  ['peak', 'f32'],
  ['exposure', 'f32'],
  ['output', 'u32'],
  ['matched', 'u32'],
  ['saturation', 'f32'],
  ['has_chroma', 'u32'],
  ['curve_bins', 'u32'],
  ['trust_ceiling', 'f32'],
  ['chroma_count', 'u32'],
  ['level_count', 'u32'],
  ['chroma_low', 'f32'],
  ['chroma_scale', 'f32'],
  ['chroma_low_by', 'f32'],
  ['chroma_scale_by', 'f32'],
  ['level_scale', 'f32'],
  ['sdr_white', 'f32'],
  ['row_stride', 'u32'],
  ['peak_samples', 'u32'],
  ['region_origin', 'vec2f'],
  ['region_size', 'vec2f'],
  ['canvas_size', 'vec2f'],
  ['max_lod', 'u32'],
  ['pad', 'u32'],
  // The reader's own sliders, appended rather than placed among the scalars above: the
  // `vec2f` members need 8-byte alignment, so inserting earlier moves every field after it.
  ['contrast', 'f32'],
  ['highlights', 'f32'],
  ['shadows', 'f32'],
  ['whites', 'f32'],
  ['blacks', 'f32'],
  ['vibrance', 'f32'],
  ['sat_adjust', 'f32'],
  // The presence three, which read `detail.wgsl`'s blur rather than the pixel alone.
  ['texture_adjust', 'f32'],
  ['clarity', 'f32'],
  ['dehaze', 'f32'],
  // The illuminant the frame was balanced for, and the one asked for. Zero is as shot.
  ['as_shot_temperature', 'f32'],
  ['as_shot_tint', 'f32'],
  ['temperature', 'f32'],
  ['tint', 'f32'],
  // Which halves of the pair the document actually held. The shader resolves the rest.
  ['balance_set', 'u32'],
] as const;

export type TickField = (typeof TICK_LAYOUT)[number][0];

/**
 * Where each field starts, in 4-byte words, under WGSL's uniform layout rules.
 *
 * Only two of them bite here: a `vec2f` starts on a multiple of two, and the struct as a
 * whole is rounded up to a multiple of four. Computed rather than written down, because a
 * hand-written offset is the thing that went wrong.
 */
export function tickOffsets(): { at: Record<TickField, number>; floats: number } {
  const at = {} as Record<TickField, number>;
  let next = 0;
  for (const [name, type] of TICK_LAYOUT) {
    if (type === 'vec2f') next = Math.ceil(next / 2) * 2;
    at[name] = next;
    next += type === 'vec2f' ? 2 : 1;
  }
  return { at, floats: Math.ceil(next / 4) * 4 };
}

/** How many 4-byte words `Tick` occupies, padded. The buffer `writeUniform` writes into. */
export const TICK_UNIFORM_FLOATS = tickOffsets().floats;

/**
 * Every slider, on Camera Raw's own scales, as the document holds them.
 *
 * Nulls included: what a missing half of the white balance pair means is
 * `white_balance.wgsl`'s to say, so this carries the absence rather than a stand-in.
 */
export interface TickAdjust {
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  vibrance: number;
  saturation: number;
  texture: number;
  clarity: number;
  dehaze: number;
  temperature: number | null;
  tint: number | null;
}

/** What only the editor knows: the part of the frame on screen and the canvas showing it. */
export interface TickView {
  region: { x: number; y: number; width: number; height: number };
  canvas: { width: number; height: number };
  /** The coarsest mip the frame has, which is how far out the draw can average. */
  maxLod: number;
}

/**
 * The uniform for one tick: the frame's own words, then what a tick owns.
 *
 * **A pure function so it can be compared against the native writer without a GPU.** Every
 * *rule* about a document is one implementation now - the shader's - but which slot each field
 * goes in is still written out twice, once here and once in `gpu::uniform_words`, and a
 * transposed pair there is a photograph graded with the clarity somebody asked for as texture.
 * `tests/tick_words.test.ts` holds this against a table the native side emits, which is the
 * only thing that can see that.
 *
 * `frame` is `PreparedHeader.tick`, already carrying everything about the photograph.
 */
export function tickWords(
  frame: readonly number[],
  adjust: TickAdjust,
  exposure: number,
  view: TickView,
): Float32Array<ArrayBuffer> {
  const at = tickOffsets().at;
  const values = new Float32Array(new ArrayBuffer(TICK_UNIFORM_FLOATS * 4));
  const ints = new Uint32Array(values.buffer);
  ints.set(frame);

  // In stops, which is the document's unit: `colour.wgsl` raises it.
  values[at.exposure] = exposure;

  values[at.region_origin] = view.region.x;
  values[at.region_origin + 1] = view.region.y;
  values[at.region_size] = view.region.width;
  values[at.region_size + 1] = view.region.height;
  values[at.canvas_size] = view.canvas.width;
  values[at.canvas_size + 1] = view.canvas.height;
  ints[at.max_lod] = view.maxLod;

  values[at.contrast] = adjust.contrast;
  values[at.highlights] = adjust.highlights;
  values[at.shadows] = adjust.shadows;
  values[at.whites] = adjust.whites;
  values[at.blacks] = adjust.blacks;
  values[at.vibrance] = adjust.vibrance;
  values[at.sat_adjust] = adjust.saturation;
  values[at.texture_adjust] = adjust.texture;
  values[at.clarity] = adjust.clarity;
  values[at.dehaze] = adjust.dehaze;

  // The document verbatim, nulls and all. The frame's own illuminant is already in the words
  // copied above, and `white_balance.wgsl` is what puts one in for a half this does not hold.
  values[at.temperature] = adjust.temperature ?? 0;
  values[at.tint] = adjust.tint ?? 0;
  ints[at.balance_set] = (adjust.temperature == null ? 0 : 1) | (adjust.tint == null ? 0 : 2);

  return values;
}

/**
 * Bins in the peak's histogram, and the buffer that holds them.
 *
 * `peak.wgsl` declares the same number, and `tests/peak_constants.test.ts` holds the two
 * together - the shader cannot take it as a pipeline constant (see the `const` there).
 */
export const PEAK_BINS = 8192;

/**
 * How many of the brightest sampled pixels the tick re-measures.
 *
 * The quantile wants rank 100 of a million. Keeping 16,384 of them leaves room for 163
 * places of rank shuffling as the slider moves, which is far more than the exposure gain
 * varies by across the levels a highlight can hold - measured as no disagreement at all
 * against a full sample across ±5 EV, and none at 512 either.
 */
export const PEAK_CANDIDATES = 16384;

// Which pixels the peak reads used to be a rule here as well as in `gpu::sampled_rows`, held
// together by `e2e/fixtures/gpu/peak-sampling.txt` because two hosts measuring different pixels
// is a divergence nothing could see - the parity fixtures are 6144 pixels, where both return a
// stride of 1 and degenerate to reading every pixel.
//
// There is one rule now. The stride arrives in `PreparedHeader.tick`, where the shader also
// reads it, and `TickPipeline` sizes its dispatch off that word. Nothing on this side computes
// it, so nothing on this side can disagree about it.
