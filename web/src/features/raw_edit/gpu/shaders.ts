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
fn eetf(nits: f32, source_peak: f32, peak: f32) -> f32 {
  let lw = pq(source_peak);
  let max_lum = pq(peak) / lw;
  if (max_lum >= 1.0) { return nits; }
  let ks = max(1.5 * max_lum - 0.5, 0.0);
  let e1 = pq(nits) / lw;
  if (e1 < ks) { return nits; }
  let t = (e1 - ks) / (1.0 - ks);
  let t2 = t * t;
  let t3 = t2 * t;
  let e2 = (2.0 * t3 - 3.0 * t2 + 1.0) * ks
    + (t3 - 2.0 * t2 + t) * (1.0 - ks)
    + (-2.0 * t3 + 3.0 * t2) * max_lum;
  return pq_inv(e2 * lw);
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
fn sample_curve(channel: u32, x: f32) -> f32 {
  let bins = tick.curve_bins;
  let t = clamp(x / tick.trust_ceiling, 0.0, 1.0) * f32(bins - 1u);
  let below = min(u32(t), bins - 2u);
  let frac = t - f32(below);
  let base = channel * bins + below;
  return mix(curves[base], curves[base + 1u], frac);
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

/// 'ChromaMap::axis'.
fn axis(value: f32, nodes: u32, low: f32, scale: f32) -> vec2f {
  let t = min(max((value - low) * scale, 0.0), f32(nodes - 1u));
  let below = min(u32(t), nodes - 2u);
  return vec2f(f32(below), t - f32(below));
}

fn node(index: u32, component: u32) -> f32 { return chroma_nodes[index * 4u + component]; }

/// 'ChromaMap::correct', trilinear over the same eight corners.
fn correct(level: f32, d0: f32, d2: f32) -> vec2f {
  let count = tick.chroma_count;
  let ax = axis(d0, count, tick.chroma_low, tick.chroma_scale);
  let ay = axis(d2, count, tick.chroma_low, tick.chroma_scale);
  let az = axis(sqrt(max(level, 0.0)), tick.level_count, 0.0, tick.level_scale);
  let area = count * count;
  let base = u32(az.x) * area + u32(ay.x) * count + u32(ax.x);

  var cell = vec4f(0.0);
  for (var c = 0u; c < 4u; c = c + 1u) {
    let n00 = node(base, c);
    let n01 = node(base + 1u, c);
    let n10 = node(base + count, c);
    let n11 = node(base + count + 1u, c);
    let near = mix(mix(n00, n01, ax.y), mix(n10, n11, ax.y), ay.y);
    let f00 = node(base + area, c);
    let f01 = node(base + area + 1u, c);
    let f10 = node(base + area + count, c);
    let f11 = node(base + area + count + 1u, c);
    let far = mix(mix(f00, f01, ax.y), mix(f10, f11, ax.y), ay.y);
    cell[c] = mix(near, far, az.y);
  }
  return vec2f(cell[0] * d0 + cell[1] * d2, cell[2] * d0 + cell[3] * d2);
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
  return vec3f(
    eetf((level.r / white) * tick.reference, source_peak, tick.peak),
    eetf((level.g / white) * tick.reference, source_peak, tick.peak),
    eetf((level.b / white) * tick.reference, source_peak, tick.peak),
  );
}
`;

/** The bindings 'COLOUR' reads, identical in both shaders that use it. */
const COLOUR_BINDINGS = /* wgsl */ `
@group(0) @binding(1) var source: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> curves: array<f32>;
@group(0) @binding(3) var<storage, read> chroma_nodes: array<f32>;
@group(0) @binding(4) var<storage, read> matrix: array<f32>;
`;

export const GRADE = /* wgsl */ `
${PRELUDE}
${TICK}
${COLOUR_BINDINGS}
@group(0) @binding(5) var graded: texture_storage_2d<rgba32float, write>;
@group(0) @binding(6) var<storage, read> peak_out: array<f32>;
${COLOUR}

@compute @workgroup_size(8, 8)
fn grade(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let code = textureLoad(source, vec2i(i32(id.x), i32(id.y)), 0);
  let level = vec3f(f32(code.r), f32(code.g), f32(code.b));

  var nits: vec3f;
  if (tick.matched == 1u) {
    let scene_peak = peak_out[0];
    // Clamped to the scene peak before the roll-off, because the CPU's roll table spans
    // 0..scene_peak and reads the top bin for anything past it. Without the clamp the
    // brightest pixels get a curve the CPU never evaluates.
    let coloured = min(max(matched_nits(level), vec3f(0.0)), vec3f(scene_peak));
    nits = vec3f(
      eetf(coloured.r, scene_peak, tick.peak),
      eetf(coloured.g, scene_peak, tick.peak),
      eetf(coloured.b, scene_peak, tick.peak),
    );
  } else {
    nits = neutral_nits(level);
  }

  // 'grade' leaves display-referred linear where full range is the display's peak, and
  // 'encode_pq' takes it from there. Fused, since the pixel is already in a register - but
  // *through* the u16 the CPU writes between them. The quantisation is not incidental: the
  // PQ stage is a 65536-entry lookup keyed by that integer, so a shader that carried full
  // precision across the join would be grading a frame the renditions never see.
  let scaled = min(max(nits, vec3f(0.0)) / tick.peak, vec3f(1.0));
  let quantised = round(scaled * 65535.0) / 65535.0;
  let coded = round(vec3f(
    pq(quantised.r * tick.peak),
    pq(quantised.g * tick.peak),
    pq(quantised.b * tick.peak),
  ) * 65535.0) / 65535.0;

  // One interleaved write rather than three planes. The split existed for 'image::finish',
  // which works a plane at a time and does not run here any more; without it, luma and its
  // two chroma differences were being computed, scattered across three buffers, and
  // recombined by the next pass for nothing.
  textureStore(graded, vec2i(i32(id.x), i32(id.y)), vec4f(coded, 1.0));
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

@compute @workgroup_size(64)
fn clear(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < BINS) { atomicStore(&histogram[id.x], 0u); }
}

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

/**
 * The planes back to a picture, and the picture to the canvas.
 *
 * The display transform is the one stage with no CPU counterpart: a rendition is tagged
 * Rec.2020 PQ and handed to a compositor, where a canvas has neither Rec.2020 nor absolute
 * luminance, so what the media path declares this has to compute (§7.1, §7.2).
 */
export const PRESENT = /* wgsl */ `
${PRELUDE}
${TICK}
@group(0) @binding(1) var graded: texture_2d<f32>;

// Rec.2020 to Display P3, both D65, applied in linear light. Rows sum to 1.
const R2020_TO_P3 = mat3x3f(
  vec3f( 1.343354, -0.065295,  0.002821),
  vec3f(-0.282219,  1.075589, -0.019598),
  vec3f(-0.061397, -0.010491,  1.016761),
);

/// The sRGB transfer with the sign carried, so an out-of-P3 component survives as a
/// negative rather than folding back over zero.
fn encode(v: f32) -> f32 {
  let a = abs(v);
  let e = select(1.055 * pow(a, 1.0 / 2.4) - 0.055, a * 12.92, a <= 0.0031308);
  return sign(v) * e;
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[i], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let x = min(i32(pos.x), i32(tick.width) - 1);
  let y = min(i32(pos.y), i32(tick.height) - 1);
  let coded = textureLoad(graded, vec2i(x, y), 0).rgb;

  let nits = vec3f(pq_inv(coded.r), pq_inv(coded.g), pq_inv(coded.b));
  let p3 = (R2020_TO_P3 * nits) / tick.sdr_white;
  return vec4f(encode(p3.r), encode(p3.g), encode(p3.b), 1.0);
}
`;
