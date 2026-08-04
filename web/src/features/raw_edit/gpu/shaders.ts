// The tick, as WGSL.
//
// Every stage 'native/rawshim' runs per slider tick, ported so it runs as dispatches over
// a texture that never leaves the GPU ('docs/raw-edit-gpu.md' §6). The constants and the
// order are the Rust ones, deliberately: this is a second implementation of one picture,
// which is the divergence §21.1 of DESIGN warns about, so where a number appears here it
// appears with the name it has over there.
//
// Two knowing departures from the CPU, both recorded in 'docs/raw-edit-gpu.md':
//
// - the BT.2390 roll-off is evaluated per pixel rather than read from a 4096-bin table,
//   which is closer to the curve rather than further from it;
// - the noise and defocus estimates arrive with the frame instead of being re-measured
//   per tick, which is the reuse DESIGN §21.1.1 lists as an unfinished lever.

/** 'image::LUMA', BT.709 weights on a Rec.2020 frame, as the Rust side uses them. */
export const LUMA = [0.2126, 0.7152, 0.0722] as const;

const PRELUDE = /* wgsl */ `
const LUMA = vec3f(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]});

// SMPTE ST 2084, both directions. 'tone::pq' and 'tone::pq_inv'.
const PQ_M1: f32 = 0.1593017578125;
const PQ_M2: f32 = 78.84375;
const PQ_C1: f32 = 0.8359375;
const PQ_C2: f32 = 18.8515625;
const PQ_C3: f32 = 18.6875;

fn pq(nits: f32) -> f32 {
  let y = pow(clamp(nits / 10000.0, 0.0, 1.0), PQ_M1);
  return pow((PQ_C1 + PQ_C2 * y) / (1.0 + PQ_C3 * y), PQ_M2);
}

fn pq_inv(signal: f32) -> f32 {
  let e = pow(clamp(signal, 0.0, 1.0), 1.0 / PQ_M2);
  return 10000.0 * pow(max(e - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * e), 1.0 / PQ_M1);
}

/// ITU-R BT.2390-8 5.4.1 with black at zero, which is 'tone::eetf'.
///
/// Evaluated rather than tabulated: the CPU builds 4096 bins because it pays per sample in
/// scalar code, and a shader does not.
///
/// Split so the knee is found once and applied three times. Where the CPU calls 'eetf' per
/// channel and eats 'pq(source_peak)' and 'pq(peak)' each time, both are constant over the
/// whole dispatch - they come from the frame and the display, not the pixel.
struct Rolloff {
  lw: f32,
  max_lum: f32,
  ks: f32,
  // Whether the scene already fits inside the display, in which case there is nothing to
  // roll off and every channel returns unchanged.
  fits: bool,
};

fn rolloff(source_peak: f32, peak: f32) -> Rolloff {
  let lw = pq(source_peak);
  let max_lum = pq(peak) / lw;
  return Rolloff(lw, max_lum, max(1.5 * max_lum - 0.5, 0.0), max_lum >= 1.0);
}

fn roll(nits: f32, knee: Rolloff) -> f32 {
  if (knee.fits) { return nits; }
  let e1 = pq(nits) / knee.lw;
  if (e1 < knee.ks) { return nits; }
  let t = (e1 - knee.ks) / (1.0 - knee.ks);
  let t2 = t * t;
  let t3 = t2 * t;
  let e2 = (2.0 * t3 - 3.0 * t2 + 1.0) * knee.ks
    + (t3 - 2.0 * t2 + t) * (1.0 - knee.ks)
    + (-2.0 * t3 + 3.0 * t2) * knee.max_lum;
  return pq_inv(e2 * knee.lw);
}

fn rolled(nits: vec3f, knee: Rolloff) -> vec3f {
  return vec3f(roll(nits.r, knee), roll(nits.g, knee), roll(nits.b, knee));
}
`;

/**
 * What every pass is told about the frame and the tick.
 *
 * One layout for all of them so a pass can be added without a second uniform to keep in
 * step. 'std140'-ish by hand: everything is 4 bytes and the struct is padded to 16.
 */
export const TICK_UNIFORM_FLOATS = 24;

const TICK = /* wgsl */ `
struct Tick {
  width: u32,
  height: u32,
  // 'tone::Levels' divided by the exposure, which is how the grade moves the anchor
  // rather than the pixels ('tone::grade').
  white: f32,
  source_level: f32,
  reference: f32,
  peak: f32,
  exposure: f32,
  // 'hdr_fit::TRUST_CEILING * white', above which the matched path stops being separable.
  ceiling: f32,
  matched: u32,
  saturation: f32,
  has_chroma: u32,
  curve_bins: u32,
  trust_ceiling: f32,
  chroma_count: u32,
  level_count: u32,
  chroma_low: f32,
  chroma_scale: f32,
  level_scale: f32,
  sdr_white: f32,
  /// Rows apart the peak's quantile samples, so it reads about a million pixels.
  row_stride: u32,
};
@group(0) @binding(0) var<uniform> tick: Tick;

fn at(x: u32, y: u32) -> u32 { return y * tick.width + x; }
fn in_frame(id: vec3u) -> bool { return id.x < tick.width && id.y < tick.height; }
`;

/**
 * Scene-linear 'u16' RGB to display-referred nits, then PQ.
 *
 * 'hdr::grade_prepared' plus 'tone::encode_pq', fused: the CPU keeps them apart because
 * each is a pass over 30M samples and fusing them would not have made either cheaper,
 * where here the pixel is already in a register.
 *
 * The neutral and matched arms are both here rather than specialised into two pipelines,
 * because a frame whose fit declined and one whose fit landed differ by a branch on a
 * uniform, which every invocation in the dispatch takes the same way.
 */
const COLOUR = /* wgsl */ `
/// 'hdr_fit::sample_curve': linear interpolation over BINS samples spanning 0..ceiling.
///
/// A row per channel, and the row picked at its own texel centre so the filter that
/// interpolates along the curve returns that row exactly rather than a blend of two.
fn sample_curve(channel: u32, x: f32) -> f32 {
  let bins = tick.curve_bins;
  let t = clamp(x / tick.trust_ceiling, 0.0, 1.0) * f32(bins - 1u);
  let below = min(u32(t), bins - 2u);
  let row = i32(channel);
  let lo = textureLoad(curves, vec2i(i32(below), row), 0).r;
  let hi = textureLoad(curves, vec2i(i32(below) + 1, row), 0).r;
  return mix(lo, hi, t - f32(below));
}

/// 'MatchedGrade::curves', which is the per-channel tone at a given exposure scale.
///
/// The shared gain matters: below the ceiling it is 1 and the stage is separable, which is
/// almost every pixel and what the CPU's lookup table is for. Above it, 'hdr_fit::tone'
/// divides the pixel down into the curve's domain and multiplies the result back out, so
/// the three channels move together. Skipping that leaves highlights wrong by hundreds of
/// counts, which is exactly where a grade is judged.
fn curves_at(level: vec3f, scale: f32) -> vec3f {
  let scene = level * scale / tick.white;
  let s = max(max(scene.r, max(scene.g, scene.b)) / tick.trust_ceiling, 1.0);
  return vec3f(
    sample_curve(0u, scene.r / s),
    sample_curve(1u, scene.g / s),
    sample_curve(2u, scene.b / s),
  ) * s;
}

/// 'MatchedGrade::toned': the exposed colour's luma, carried onto the base colour's
/// ratios, which is what keeps hue still as the slider moves.
fn toned(level: vec3f) -> vec3f {
  let base = curves_at(level, 1.0);
  if (tick.exposure == 1.0) { return base; }
  let lit = curves_at(level, tick.exposure);
  let base_luma = dot(LUMA, base);
  let lit_luma = dot(LUMA, lit);
  // Black has no ratios to hold and the two lumas vanish together, so the quotient there
  // is noise over noise; the exposed pixel is already the right answer.
  if (base_luma <= 0.0) { return lit; }
  return base * (lit_luma / base_luma);
}

/// 'ChromaMap::axis', as a texture coordinate: the node index, at its texel centre.
fn axis(value: f32, nodes: u32, low: f32, scale: f32) -> f32 {
  let t = min(max((value - low) * scale, 0.0), f32(nodes - 1u));
  return (t + 0.5) / f32(nodes);
}

/// 'ChromaMap::correct', trilinear over the same eight corners - in one fetch, since a
/// 2x2 per node is four components and a node lattice is a volume.
fn correct(level: f32, d0: f32, d2: f32) -> vec2f {
  let cell = textureSampleLevel(chroma, lerp, vec3f(
    axis(d0, tick.chroma_count, tick.chroma_low, tick.chroma_scale),
    axis(d2, tick.chroma_count, tick.chroma_low, tick.chroma_scale),
    axis(sqrt(max(level, 0.0)), tick.level_count, 0.0, tick.level_scale),
  ), 0.0);
  return vec2f(cell.x * d0 + cell.y * d2, cell.z * d0 + cell.w * d2);
}

/// 'hdr_fit::finish_chroma', given a colour the matrix has already been through.
fn finish_chroma(m: vec3f) -> vec3f {
  let l = dot(LUMA, m);
  if (tick.has_chroma == 0u) {
    if (tick.saturation == 1.0) { return m; }
    return vec3f(l) + (m - vec3f(l)) * tick.saturation;
  }
  let d = correct(l, m.r - l, m.b - l);
  // The middle channel is not free: LUMA . d is zero by construction, so the two
  // coordinates carried through the map determine the third.
  let dg = -(LUMA.r * d.x + LUMA.b * d.y) / LUMA.g;
  return vec3f(l + d.x, l + dg, l + d.y);
}

fn apply_matrix(t: vec3f) -> vec3f {
  return vec3f(
    matrix[0] * t.r + matrix[1] * t.g + matrix[2] * t.b,
    matrix[3] * t.r + matrix[4] * t.g + matrix[5] * t.b,
    matrix[6] * t.r + matrix[7] * t.g + matrix[8] * t.b,
  );
}

/// The matched colour in nits, before any roll-off. Shared with the peak pass so the two
/// cannot measure one thing and grade another.
fn matched_nits(level: vec3f) -> vec3f {
  return finish_chroma(apply_matrix(toned(level))) * tick.reference;
}

/// The neutral arm: one shared curve, so channel ratios survive whatever the input.
fn neutral_nits(level: vec3f) -> vec3f {
  let white = tick.white / tick.exposure;
  let source_level = tick.source_level / tick.exposure;
  let source_peak = (source_level / white) * tick.reference;
  return rolled((level / white) * tick.reference, rolloff(source_peak, tick.peak));
}
`;

/**
 * The bindings 'COLOUR' reads, identical in both shaders that use it.
 *
 * The two lookups are textures with a filtering sampler rather than storage buffers with
 * the blend written out, which is the same data read the way the hardware reads it. The
 * buffer form was a transcription of `hdr_fit`'s, where an interpolation is arithmetic
 * because there is nothing else it could be; here a texture unit does the fetch, the
 * weights and the blend as one instruction. The chroma map is the extreme case: eight
 * corners times four components was thirty-two dependent scalar loads for one trilinear
 * that `textureSampleLevel` performs in a single fetch.
 *
 * What it costs is the filter weight, which GPUs carry in about eight fractional bits
 * rather than in a float. Over a 256-bin curve that is a 1/256th of a bin, and both of
 * these are smooth by construction - a tone curve and a chroma correction - so the error
 * lands under a count of 65535 rather than anywhere a grade is judged.
 */
const COLOUR_BINDINGS = /* wgsl */ `
@group(0) @binding(1) var source: texture_2d<u32>;
@group(0) @binding(2) var curves: texture_2d<f32>;
@group(0) @binding(3) var chroma: texture_3d<f32>;
@group(0) @binding(4) var<storage, read> matrix: array<f32>;
@group(0) @binding(7) var lerp: sampler;
`;

/** The colour, rolled off to what the display can show. Needs 'peak_out' bound. */
const DISPLAY_NITS = /* wgsl */ `
fn display_nits(level: vec3f) -> vec3f {
  return min(max(rolled_off(level), vec3f(0.0)), vec3f(tick.peak));
}

/// The roll-off leaves the display's peak alone when the scene already fits inside it, so
/// the clamp above is not redundant: a level past 'source_level' comes back untouched.
fn rolled_off(level: vec3f) -> vec3f {
  if (tick.matched == 0u) { return neutral_nits(level); }
  let scene_peak = peak_out[0];
  // Clamped to the scene peak before the roll-off, because the CPU's roll table spans
  // 0..scene_peak and reads the top bin for anything past it. Without the clamp the
  // brightest pixels get a curve the CPU never evaluates.
  let coloured = min(max(matched_nits(level), vec3f(0.0)), vec3f(scene_peak));
  return rolled(coloured, rolloff(scene_peak, tick.peak));
}
`;

/**
 * Sensor levels to what the canvas takes, in one pass.
 *
 * There used to be a graded frame between the two: a compute pass wrote 'rgba32float'
 * nits and the draw read them back. That is the CPU's shape, where every stage
 * materialises because the next one is a separate loop over 30M samples, and on a GPU it
 * bought nothing - the value is already in a register when the next stage wants it. What
 * it cost was 158MB written and 158MB read per tick, which measured as 5.2ms of a 15ms
 * tick with the arithmetic in it barely visible either side.
 *
 * It also PQ-coded the frame on the way out and decoded it on the way in, six 'pow' each
 * way, because a rendition is a PQ file. The display is not a file. That encoding now
 * happens only where a file is wanted, which is 'encode' below.
 *
 * The other half of the win is not on this bench: the fragment shader runs once per
 * *canvas* pixel, and a canvas is the viewport. Grading a 9.9MP frame to fill a 2MP
 * viewport used to cost 9.9MP of colour transform and now costs 2MP of it.
 */
export const FRAME = /* wgsl */ `
${PRELUDE}
${TICK}
${COLOUR_BINDINGS}
@group(0) @binding(5) var<storage, read> peak_out: array<f32>;
@group(0) @binding(6) var<storage, read_write> counts: array<u32>;
${COLOUR}
${DISPLAY_NITS}

// Rec.2020 to Display P3, both D65, applied in linear light. Rows sum to 1.
const R2020_TO_P3 = mat3x3f(
  vec3f( 1.343354, -0.065295,  0.002821),
  vec3f(-0.282219,  1.075589, -0.019598),
  vec3f(-0.061397, -0.010491,  1.016761),
);

/// The sRGB transfer with the sign carried, so an out-of-P3 component survives as a
/// negative rather than folding back over zero.
fn transfer(v: f32) -> f32 {
  let a = abs(v);
  let e = select(1.055 * pow(a, 1.0 / 2.4) - 0.055, a * 12.92, a <= 0.0031308);
  return sign(v) * e;
}

fn level_at(x: i32, y: i32) -> vec3f {
  let code = textureLoad(source, vec2i(x, y), 0);
  return vec3f(f32(code.r), f32(code.g), f32(code.b));
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[i], 0.0, 1.0);
}

/// The display transform is the one stage with no CPU counterpart: a rendition is tagged
/// Rec.2020 PQ and handed to a compositor, where a canvas has neither Rec.2020 nor
/// absolute luminance, so what the media path declares this has to compute (§7.1, §7.2).
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let x = min(i32(pos.x), i32(tick.width) - 1);
  let y = min(i32(pos.y), i32(tick.height) - 1);
  let p3 = (R2020_TO_P3 * display_nits(level_at(x, y))) / tick.sdr_white;
  return vec4f(transfer(p3.r), transfer(p3.g), transfer(p3.b), 1.0);
}

/// The same frame as a rendition would hold it: 'u16' counts of PQ.
///
/// Off the tick's path entirely - the display never wants this - and here rather than in
/// the harness that reads it so that ST 2084 keeps one implementation in this repo, and
/// so that what parity compares is the pixel 'fs' draws rather than a cousin of it.
@compute @workgroup_size(8, 8)
fn encode(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let nits = display_nits(level_at(i32(id.x), i32(id.y)));
  // Through the 'u16' the CPU writes between the grade and the PQ. Not incidental: its PQ
  // stage is a 65536-entry table keyed by that integer, so a frame that skipped the
  // quantisation would not be the frame the fixture pins.
  let quantised = round(min(nits / tick.peak, vec3f(1.0)) * 65535.0) / 65535.0;
  let coded = round(vec3f(
    pq(quantised.r * tick.peak),
    pq(quantised.g * tick.peak),
    pq(quantised.b * tick.peak),
  ) * 65535.0);

  let base = at(id.x, id.y) * 3u;
  counts[base] = u32(coded.r);
  counts[base + 1u] = u32(coded.g);
  counts[base + 2u] = u32(coded.b);
}
`;

/**
 * 'MatchedGrade::scene_peak_nits', as a histogram and a scan.
 *
 * The CPU takes a quantile of a million sampled pixels by partial sort. A shader cannot
 * sort a million values cheaply, so this bins them and reads the quantile off the
 * cumulative count, which is the same statistic at the bin's resolution. Two dispatches
 * and no readback: the scan writes the peak into a buffer the grade reads next.
 */
export const PEAK_BINS = 8192;

/** 'tone::PEAK_QUANTILE'. */
export const PEAK_QUANTILE = 0.9999;

/** 'tone::QUANTILE_SAMPLES', which is what the quantile is taken over. */
export const PEAK_SAMPLES = 1 << 20;

export const PEAK = /* wgsl */ `
${PRELUDE}
${TICK}
${COLOUR_BINDINGS}
@group(0) @binding(5) var<storage, read_write> histogram: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> peak_out: array<f32>;
${COLOUR}

const BINS: u32 = ${PEAK_BINS}u;
// The top of the histogram, as a multiple of reference white. A frame's post-colour peak
// runs to a few times diffuse white, and anything past this lands in the last bin, which
// is the clamp the CPU's own quantile applies at the top of its sample anyway.
const RANGE: f32 = 24.0;
const QUANTILE: f32 = ${PEAK_QUANTILE};

/// About a million pixels, as whole rows.
///
/// Three shapes, and the reasoning matters more than the code. Reading every pixel was
/// first, on the grounds that a shader has no reason to subsample - but this pass runs the
/// same colour transform the grade does, so at full frame it costs what the grade costs.
/// Measured at 12.5ms against the grade's 12.8, and the atomics are not what dominates it.
/// The CPU never read every pixel either: 'tone::QUANTILE_SAMPLES' caps it at a million.
///
/// Copying the CPU's stride exactly was second, and it barely helped: 'k * pixels /
/// counted' scatters consecutive lanes about ten pixels apart, so every one of them takes
/// its own cache line and the pass is back to fetching the whole frame to read a tenth of
/// it. Whole rows, every nth, samples just as evenly - the count is what the quantile cares
/// about, and 'tone::levels' says so - while consecutive lanes stay adjacent.
@compute @workgroup_size(64)
fn measure(@builtin(global_invocation_id) id: vec3u) {
  let y = id.y * tick.row_stride;
  if (id.x >= tick.width || y >= tick.height) { return; }
  let x = id.x;

  let code = textureLoad(source, vec2i(i32(x), i32(y)), 0);
  let coloured = matched_nits(vec3f(f32(code.r), f32(code.g), f32(code.b))) / tick.reference;
  let v = max(coloured.r, max(coloured.g, coloured.b));
  let bin = min(u32(max(v, 0.0) / RANGE * f32(BINS)), BINS - 1u);
  atomicAdd(&histogram[bin], 1u);
}

/// The quantile off the cumulative count.
///
/// One invocation walking every bin was fine at 1024 and is not at 8192: that is 16,384
/// dependent iterations on a single lane, each waiting on a global load, and it measured as
/// most of what the peak pass costs. So the bins are summed in parallel first - a lane per
/// chunk - and only the search across 256 partials and then within one chunk stays serial,
/// which is 288 steps rather than 16,384.
const CHUNKS: u32 = 256u;
var<workgroup> partial: array<u32, 256>;

@compute @workgroup_size(256)
fn quantile(@builtin(local_invocation_id) local: vec3u) {
  let width = BINS / CHUNKS;
  let first = local.x * width;

  var sum = 0u;
  for (var b = first; b < first + width; b = b + 1u) { sum = sum + atomicLoad(&histogram[b]); }
  partial[local.x] = sum;
  workgroupBarrier();

  if (local.x != 0u) { return; }

  var total = 0u;
  for (var c = 0u; c < CHUNKS; c = c + 1u) { total = total + partial[c]; }
  let want = u32(f32(total) * QUANTILE);

  // The chunk the quantile falls in, then the bin inside it.
  var seen = 0u;
  var chunk = CHUNKS - 1u;
  for (var c = 0u; c < CHUNKS; c = c + 1u) {
    if (seen + partial[c] >= want) { chunk = c; break; }
    seen = seen + partial[c];
  }
  var found = BINS - 1u;
  for (var b = chunk * width; b < (chunk + 1u) * width; b = b + 1u) {
    seen = seen + atomicLoad(&histogram[b]);
    if (seen >= want) { found = b; break; }
  }

  // The bin's centre, and never zero: a scene peak of zero would put the roll-off in a
  // division by it, which is the same guard 'scene_peak_nits' applies by returning None.
  let value = (f32(found) + 0.5) / f32(BINS) * RANGE * tick.reference;
  peak_out[0] = max(value, 1.0);
}
`;

