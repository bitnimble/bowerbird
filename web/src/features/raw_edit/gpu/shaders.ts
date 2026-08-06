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
//   colour    prelude and tick; declares bindings 1-4 and 7
//   frame     all three; declares bindings 5-6 and 9
//   peak      prelude, tick, colour; declares bindings 5-6 and 8
//   reduce    tick; declares bindings 1-3, on a layout of its own
//
// Numbers that both sides need are declared in the `.wgsl` and pinned to the host's copy by a
// test, rather than substituted into the source, so the files stay valid WGSL on their own. A
// pipeline-overridable constant only where the value actually differs between pipelines.

import colour from './wgsl/colour.wgsl?raw';
import frame from './wgsl/frame.wgsl?raw';
import peak from './wgsl/peak.wgsl?raw';
import prelude from './wgsl/prelude.wgsl?raw';
import reduceSource from './wgsl/reduce.wgsl?raw';
import tick from './wgsl/tick.wgsl?raw';

const compose = (...parts: string[]): string => parts.join('\n');

/** Sensor levels to a canvas, and the same frame as a rendition would hold it. */
export const FRAME = compose(prelude, tick, colour, frame);

/** The scene peak: a histogram over the whole frame, and the scan that reads it. */
export const PEAK = compose(prelude, tick, colour, peak);

/** The pyramid the draw averages with, built once at the open. */
export const REDUCE = compose(tick, reduceSource);

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
  ['pad0', 'u32'],
  ['matched', 'u32'],
  ['saturation', 'f32'],
  ['has_chroma', 'u32'],
  ['curve_bins', 'u32'],
  ['trust_ceiling', 'f32'],
  ['chroma_count', 'u32'],
  ['level_count', 'u32'],
  ['chroma_low', 'f32'],
  ['chroma_scale', 'f32'],
  ['level_scale', 'f32'],
  ['sdr_white', 'f32'],
  ['row_stride', 'u32'],
  ['peak_samples', 'u32'],
  ['region_origin', 'vec2f'],
  ['region_size', 'vec2f'],
  ['canvas_size', 'vec2f'],
  ['max_lod', 'u32'],
  ['pad', 'u32'],
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
 * Bins in the peak's histogram, and the buffer that holds them.
 *
 * `peak.wgsl` declares the same number, and `tests/peak_constants.test.ts` holds the two
 * together - the shader cannot take it as a pipeline constant (see the `const` there).
 */
export const PEAK_BINS = 8192;

/** `tone::QUANTILE_SAMPLES`, which is what the quantile is taken over. */
export const PEAK_SAMPLES = 1 << 20;

/**
 * How many of the brightest sampled pixels the tick re-measures.
 *
 * The quantile wants rank 100 of a million. Keeping 16,384 of them leaves room for 163
 * places of rank shuffling as the slider moves, which is far more than the exposure gain
 * varies by across the levels a highlight can hold - measured as no disagreement at all
 * against a full sample across ±5 EV, and none at 512 either.
 */
export const PEAK_CANDIDATES = 16384;
