// The grade's shader modules, composed from `wgsl/`.
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
//   edit      nothing; declares `edit` at binding 0
//   adjust    prelude and edit; declares bindings 13-14, and reads `lerp` from colour
//   colour    prelude, edit and adjust; declares bindings 1-4, 7, 10-12
//   frame     all three; declares bindings 5-6 and 9
//   peak      prelude, edit, colour; declares bindings 5-6 and 8
//   reduce    edit; declares bindings 1-3, on a layout of its own
//   decode    prelude; declares binding 12 writable, on a layout of its own
//   detail    prelude and edit; declares bindings 1-3 and 12, on layouts of its own
//   balance   prelude and edit; declares binding 14 writable, on a layout of its own
//
// `adjust` naming `lerp` before `colour` declares it is legal and deliberate: a WGSL
// module-scope declaration is in scope for the whole program, so the order here is a
// dependency order for readers rather than for the compiler. Moving the sampler earlier would
// put a binding `reduce` never uses into the module it shares `edit` with.
//
// Numbers that both sides need are declared in the `.wgsl` and pinned to the host's copy by a
// test, rather than substituted into the source, so the files stay valid WGSL on their own. A
// pipeline-overridable constant only where the value actually differs between pipelines.

import adjust from './wgsl/adjust.wgsl?raw';
import colour from './wgsl/colour.wgsl?raw';
import decodeSource from './wgsl/decode.wgsl?raw';
import detailSource from './wgsl/detail.wgsl?raw';
import frame from './wgsl/frame.wgsl?raw';
import geometry from './wgsl/geometry.wgsl?raw';
import peak from './wgsl/peak.wgsl?raw';
import prelude from './wgsl/prelude.wgsl?raw';
import reduceSource from './wgsl/reduce.wgsl?raw';
import edit from './wgsl/edit.wgsl?raw';
import whiteBalance from './wgsl/white_balance.wgsl?raw';

import galoshPrelude from './wgsl/galosh/prelude.wgsl?raw';
import buildInvLut from './wgsl/galosh/build_inv_lut.wgsl?raw';
import lutFinalize from './wgsl/galosh/lut_finalize.wgsl?raw';
import pass12 from './wgsl/galosh/pass12.wgsl?raw';
import yuvGatFwd from './wgsl/galosh/yuv_gat_fwd.wgsl?raw';
import yuvJoin from './wgsl/galosh/yuv_join.wgsl?raw';
import yuvLoess from './wgsl/galosh/yuv_loess.wgsl?raw';
import yuvMakitalo from './wgsl/galosh/yuv_makitalo.wgsl?raw';
import yuvSigmaScale from './wgsl/galosh/yuv_sigma_scale.wgsl?raw';
import yuvSplit from './wgsl/galosh/yuv_split.wgsl?raw';

const compose = (...parts: string[]): string => parts.join('\n');

/** Sensor levels to a canvas, and the same frame as a rendition would hold it. */
export const FRAME = compose(prelude, edit,adjust, colour, geometry, frame);

/** The scene peak: a histogram over the whole frame, and the scan that reads it. */
export const PEAK = compose(prelude, edit,adjust, colour, peak);

/** The pyramid the draw averages with, built once at the open. */
export const REDUCE = compose(edit, reduceSource);

/** The frame's coding undone, one entry per code. The same table for every photo. */
export const DECODE = compose(prelude, decodeSource);

/** The blur the presence sliders read, built once at the open. */
export const DETAIL = compose(prelude, edit,detailSource);

/** The reader's temperature and tint, solved into one matrix. One invocation, per tick. */
export const BALANCE = compose(prelude, edit,whiteBalance);

/**
 * The denoise, a module per kernel.
 *
 * One module each rather than one composed source, because every one of them declares its
 * buffers at the binding indices the reference's dispatch table lists - which is what makes
 * the two hosts auditable against each other, and which two kernels cannot do in one module.
 *
 * Three of these are the *mosaic* denoise's own kernels, dispatched here unchanged: the
 * shrinkage and the pair that builds its inverse table do not care which domain reached
 * them. That is the reference's arrangement too (`native/rawshim/src/galosh.rs`).
 */
export const GALOSH = {
  split: compose(galoshPrelude, yuvSplit),
  gatFwd: compose(galoshPrelude, yuvGatFwd),
  sigmaScale: compose(galoshPrelude, yuvSigmaScale),
  buildInvLut: compose(galoshPrelude, buildInvLut),
  lutFinalize: compose(galoshPrelude, lutFinalize),
  pass12: compose(galoshPrelude, pass12),
  makitalo: compose(galoshPrelude, yuvMakitalo),
  loess: compose(galoshPrelude, yuvLoess),
  join: compose(galoshPrelude, yuvJoin),
} as const;

/**
 * How the Detail sliders' 0-100 reach the kernels.
 *
 * **Both are linear over the whole track, which took a rewrite to arrive at.** The first
 * version split the colour control in two - a dry/wet mix over its first third, then a
 * widening ridge - and the arithmetic of that put the entire usable range below 33: fully
 * wet at a third of the way along, with the rest of the track doing damage. Measured on an
 * ISO 25600 frame, everything past the first sixth of the track was smearing texture the
 * picture needed. One number, one behaviour, monotone.
 *
 * **The midpoint is the calibrated one, not the top.** The plane is normalised to its own
 * measured sigma before the shrinkage, so `luma` is the noise level the shrinkage *believes
 * in*, in units of what was measured - and 1.0, at slider 50, is where it believes the
 * measurement exactly. Under it noise is left behind on purpose; over it the threshold is
 * into signal, and not gently, since a block whose own deviation falls to the assumed noise
 * has its whole AC zeroed rather than shrunk.
 *
 * **The top half exists because the measurement can still be wrong.** An envelope over the
 * quietest blocks is a far better estimate than the median it replaced - which read 2.6 to
 * 4.6 times high - but it is an estimate, and a frame whose quietest tenth still holds
 * texture reads low. Rather than let that frame be under-denoised with no way out, the track
 * runs to twice the calibrated point and the reader can say so.
 *
 * The colour control has no equivalent headroom in its first half, because a dry/wet mix
 * ends at wet. Past the midpoint it widens the ridge the regression is damped by instead,
 * which drives the fitted slope towards zero and the output towards the window's mean - more
 * smoothing, by a different means, once there is no more of the estimate left to trust.
 */
export function denoiseAmounts(luminance: number, colour: number): {
  luma: number;
  blend: number;
  ridge: number;
} {
  const on = (value: number) => Math.min(Math.max(value, 0), 100) / 100;
  const past = (value: number) => Math.max(0, on(value) - 0.5) * 2;
  return {
    luma: on(luminance) * 2,
    blend: Math.min(on(colour) * 2, 1),
    ridge: 1 + past(colour) * 2,
  };
}

// The detail blur's working size used to be a rule here too, alongside `gpu::detail_size`, and
// pinned to it by `DETAIL_LONG`. It arrives on `PreparedHeader.detail` now: how large a share of
// the picture each blur covers follows from it, and two hosts rounding it differently would
// apply two different clarities to one photograph with nothing to say which was meant.

/**
 * The order `detail.wgsl`'s entry points run in, which both hosts have to agree on exactly.
 *
 * The guided filter is a sequence rather than a kernel - moments, box mean, fit, box mean,
 * evaluate - and a host that ran it in a different order, or ran one box mean where the other
 * ran two, would build a different neighbourhood from the same frame. The editor's clarity and
 * the rendition's would then be different pictures, which is the divergence DESIGN 21.1 is
 * about, and nothing in the graded fixtures could see it: those are pinned at every slider
 * zero, where `adjusted` returns before it ever samples this texture.
 *
 * So it is stated once, here, as data. The ping-pong between the two 32-bit textures is
 * *derived* from it on both sides - every pass reads what the one before it wrote - rather
 * than written out, which is the half of this that could otherwise drift silently.
 *
 * `gpu_fixture.rs` writes the native side's copy to `fixtures/gpu/detail-passes.txt` and
 * `tests/detail_passes.test.ts` holds this against it.
 */
export const DETAIL_PASSES = [
  'shrink',
  'moments_of',
  // Both means, and both bilateral: gathering the moments over a box and averaging the fitted
  // models over a box are the two ways a dark surface's statistics reach the bright pixels
  // beside it, which is a halo (`detail.wgsl`).
  'window_mean',
  'coefficients',
  'window_mean',
  'apply_guided',
] as const;

export type DetailPass = (typeof DETAIL_PASSES)[number];

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
 * `struct Edit` in `wgsl/edit.wgsl`, field for field and in its order.
 *
 * The shader is the source of truth; this is the same declaration in a form the host can
 * index by. `writeUniform` wrote bare numbers into the buffer before - `values[22] = region.x`
 * - which is the shader's field order copied out by hand into two dozen literals, with
 * nothing checking either the order or the alignment. Swapping two fields in the WGSL left
 * every suite green and drew the wrong rectangle of the frame, because the only thing that
 * reads the tail is the draw and no test looks at a drawn pixel.
 *
 * `gpu/tests/edit_uniform.test.ts` parses the struct out of the `.wgsl` and holds this
 * against it, so the two cannot drift without something saying so.
 */
export const EDIT_LAYOUT = [
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
  // The crop, the straighten and the quarter turn, and the size they produce.
  ['crop_left', 'f32'],
  ['crop_top', 'f32'],
  ['crop_right', 'f32'],
  ['crop_bottom', 'f32'],
  ['crop_angle', 'f32'],
  ['rotate', 'u32'],
  ['output_width', 'u32'],
  ['output_height', 'u32'],
  // The perspective correction, corrected back to source in fractions of the frame. Scalars
  // rather than an array or a matrix, which a uniform lays out at a 16-byte stride.
  ['keystone_0', 'f32'],
  ['keystone_1', 'f32'],
  ['keystone_2', 'f32'],
  ['keystone_3', 'f32'],
  ['keystone_4', 'f32'],
  ['keystone_5', 'f32'],
  ['keystone_6', 'f32'],
  ['keystone_7', 'f32'],
  ['has_keystone', 'u32'],
] as const;

export type EditField = (typeof EDIT_LAYOUT)[number][0];

/**
 * Where each field starts, in 4-byte words, under WGSL's uniform layout rules.
 *
 * Only two of them bite here: a `vec2f` starts on a multiple of two, and the struct as a
 * whole is rounded up to a multiple of four. Computed rather than written down, because a
 * hand-written offset is the thing that went wrong.
 */
export function editOffsets(): { at: Record<EditField, number>; floats: number } {
  const at = {} as Record<EditField, number>;
  let next = 0;
  for (const [name, type] of EDIT_LAYOUT) {
    if (type === 'vec2f') next = Math.ceil(next / 2) * 2;
    at[name] = next;
    next += type === 'vec2f' ? 2 : 1;
  }
  return { at, floats: Math.ceil(next / 4) * 4 };
}

/** How many 4-byte words `Edit` occupies, padded. The buffer `writeUniform` writes into. */
export const EDIT_UNIFORM_FLOATS = editOffsets().floats;

/**
 * Every slider, on Camera Raw's own scales, as the document holds them.
 *
 * Nulls included: what a missing half of the white balance pair means is
 * `white_balance.wgsl`'s to say, so this carries the absence rather than a stand-in.
 */
export interface EditAdjust {
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
export interface EditView {
  region: { x: number; y: number; width: number; height: number };
  canvas: { width: number; height: number };
  /** The coarsest mip the frame has, which is how far out the draw can average. */
  maxLod: number;
}

/**
 * The reader's crop, straighten and turn, and the picture they produce.
 *
 * `output` is `displaySize` - the *server's* function, imported rather than copied - because
 * the shader's turn arithmetic indexes the output grid and a third answer to its dimensions is
 * a third thing to keep in step.
 */
export interface EditGeometry {
  cropLeft: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
  cropAngle: number;
  rotate: number;
  output: { width: number; height: number };
  /** The perspective correction, or null where nobody corrected one. Eight, row-major. */
  keystone: readonly number[] | null;
}

/** The whole frame, which is what a photo nobody has cropped shows. */
export function wholeFrameGeometry(width: number, height: number): EditGeometry {
  return {
    cropLeft: 0,
    cropTop: 0,
    cropRight: 1,
    cropBottom: 1,
    cropAngle: 0,
    rotate: 0,
    output: { width, height },
    keystone: null,
  };
}

/**
 * The reader's edits as the shader takes them: the frame's own words, then the document's.
 *
 * **A pure function so it can be compared against the native writer without a GPU.** Every
 * *rule* about a document is one implementation now - the shader's - but which slot each field
 * goes in is still written out twice, once here and once in `gpu::uniform_words`, and a
 * transposed pair there is a photograph graded with the clarity somebody asked for as texture.
 * `tests/edits.test.ts` holds this against a table the native side emits, which is the
 * only thing that can see that.
 *
 * `frame` is `PreparedHeader.edits`, already carrying everything about the photograph.
 */
export function edits(
  frame: readonly number[],
  adjust: EditAdjust,
  exposure: number,
  view: EditView,
  geometry: EditGeometry,
): Float32Array<ArrayBuffer> {
  const at = editOffsets().at;
  const values = new Float32Array(new ArrayBuffer(EDIT_UNIFORM_FLOATS * 4));
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

  values[at.crop_left] = geometry.cropLeft;
  values[at.crop_top] = geometry.cropTop;
  values[at.crop_right] = geometry.cropRight;
  values[at.crop_bottom] = geometry.cropBottom;
  values[at.crop_angle] = geometry.cropAngle;
  ints[at.rotate] = geometry.rotate;
  ints[at.output_width] = geometry.output.width;
  ints[at.output_height] = geometry.output.height;

  const keystone = geometry.keystone;
  ints[at.has_keystone] = keystone == null ? 0 : 1;
  for (let element = 0; element < 8; element += 1) {
    values[at.keystone_0 + element] = keystone?.[element] ?? 0;
  }

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
// There is one rule now. The stride arrives in `PreparedHeader.edits`, where the shader also
// reads it, and `EditPipeline` sizes its dispatch off that word. Nothing on this side computes
// it, so nothing on this side can disagree about it.
