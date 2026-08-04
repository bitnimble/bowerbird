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
// Numbers that both sides need are pipeline-overridable constants rather than string
// substitutions, so the `.wgsl` files stay valid WGSL on their own.

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
 * How many 4-byte words `Tick` occupies, padded.
 *
 * The struct is written field for field by `writeUniform`, in the order `tick.wgsl`
 * declares them; this is the buffer it is written into.
 */
export const TICK_UNIFORM_FLOATS = 32;

/**
 * Bins in the peak's histogram, and the buffer that holds them.
 *
 * Passed to the peak pipelines as an override, so the shader and the buffer cannot
 * disagree about the length.
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

/** What `peak.wgsl` declares as overridable, so its two lengths match the buffers. */
export const PEAK_CONSTANTS = { BINS: PEAK_BINS, CANDIDATES: PEAK_CANDIDATES };
