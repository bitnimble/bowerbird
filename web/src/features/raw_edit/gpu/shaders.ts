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

/**
 * The same shaders with their planes stored at half precision.
 *
 * A diagnostic rather than a mode. 'finish' is not bound by the arithmetic in its kernels
 * but by how many times it walks a whole plane, so halving the element size is the cheapest
 * way to ask whether the bottleneck really is memory: a tick that gets meaningfully faster
 * says it is, and one that does not says the cost is somewhere else.
 *
 * The arithmetic stays f32, and only the storage narrows. That is the shape a real
 * implementation would take too: 'variance = mean_squares - mean * mean' is catastrophic
 * cancellation, and DENOISE_EPS at 1e-4 is an order of magnitude under f16's resolution
 * near 1.0, so neither can afford to be computed there.
 */
export function withHalfPlanes(wgsl: string): string {
  // Every binding that names a working plane, including the grade's outputs: they are the
  // same buffers `finish` then reads, and leaving them f32 while the reader expects f16
  // does not fail to compile - it silently grades one format and filters another.
  const planes =
    /(var<storage, (?:read|read_write)> (?:src|dst|aux0|aux1|observed|luma|red|blue|out_luma|out_red|out_blue): array<)f32(>)/g;
  const load = /\b(src|aux0|aux1|observed|luma|red|blue)\[([^\]]+)\]/g;
  const writes = /\b(out_luma|out_red|out_blue)\[([^\]]+)\] = ([^;]+);/g;
  // A read of the output plane, which several kernels do: the two blends and the
  // deconvolution's scale read what they are about to overwrite. Told apart from a write
  // by what follows the subscript, so the store rewrite below still sees a bare `dst[...]`.
  const readBack = /\bdst\[([^\]]+)\](?!\s*=[^=])/g;
  const store = /\bdst\[([^\]]+)\] = ([^;]+);/g;
  return `enable f16;\n${wgsl}`
    .replace(planes, '$1f16$2')
    .replace(load, 'f32($1[$2])')
    .replace(readBack, 'f32(dst[$1])')
    .replace(store, 'dst[$1] = f16($2);')
    .replace(writes, '$1[$2] = f16($3);');
}

/** 'image.rs' constants, by their Rust names. */
export const FINISH = {
  denoiseEps: 1e-4,
  chromaRadii: [4, 32] as const,
  chromaCoarseLimit: 0.02,
  lumaRadius: 6,
  lumaSigmas: 1.4,
  deconvolveSigma: 0.7,
  deconvolveIterations: 10,
  deconvolveRadius: 2,
} as const;

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
  radius: u32,
  eps: f32,
  limit: f32,
  defocus_red: f32,
  defocus_blue: f32,
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
@group(0) @binding(5) var<storage, read_write> out_luma: array<f32>;
@group(0) @binding(6) var<storage, read_write> out_red: array<f32>;
@group(0) @binding(7) var<storage, read_write> out_blue: array<f32>;
@group(0) @binding(8) var<storage, read> peak_out: array<f32>;
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

  // Deinterleaved on the way out, which is the form 'finish' works in: luma, and the two
  // chroma differences from it.
  let l = dot(LUMA, coded);
  let i = at(id.x, id.y);
  out_luma[i] = l;
  out_red[i] = coded.r - l;
  out_blue[i] = coded.b - l;
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
export const PEAK_BINS = 1024;

/** 'tone::PEAK_QUANTILE'. */
export const PEAK_QUANTILE = 0.9999;

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

/// Every pixel rather than the CPU's strided million: a shader has no reason to subsample,
/// and reading all of them removes the one place the two could disagree about *which*
/// pixels were measured.
@compute @workgroup_size(8, 8)
fn measure(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let code = textureLoad(source, vec2i(i32(id.x), i32(id.y)), 0);
  let coloured = matched_nits(vec3f(f32(code.r), f32(code.g), f32(code.b))) / tick.reference;
  let v = max(coloured.r, max(coloured.g, coloured.b));
  let bin = min(u32(max(v, 0.0) / RANGE * f32(BINS)), BINS - 1u);
  atomicAdd(&histogram[bin], 1u);
}

/// The quantile off the cumulative count, in one invocation because 1024 bins is nothing
/// and a parallel scan here would be more code than the whole pass saves.
@compute @workgroup_size(1)
fn quantile() {
  var total = 0u;
  for (var b = 0u; b < BINS; b = b + 1u) { total = total + atomicLoad(&histogram[b]); }
  let want = u32(f32(total) * QUANTILE);
  var seen = 0u;
  var found = BINS - 1u;
  for (var b = 0u; b < BINS; b = b + 1u) {
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
 * Everything 'image::finish' does, one entry point per stage.
 *
 * The strip machinery does not come with it. Strips exist because the CPU cannot hold six
 * whole-frame planes inside a memory budget ('strip_interior'); the GPU holds the frame
 * resident by design, so the halo, the carry rows and the interior all fall away and what
 * is left is the arithmetic.
 */
export const FINISH_WGSL = /* wgsl */ `
${PRELUDE}
${TICK}
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<storage, read> aux0: array<f32>;
@group(0) @binding(4) var<storage, read> aux1: array<f32>;

/// 'image::box_mean', in the two shapes a GPU actually wants.
///
/// Four attempts, and the reasoning behind each is worth keeping.
///
/// The Rust slides a window along the row: O(1) in the radius, right for a core that walks
/// a row anyway. Carried across as-is it gave a 9.9MP frame 3840 threads, each running a
/// 2566-step chain of dependent adds - 3.3s a tick against the CPU's 0.9s.
///
/// Gathering the window per pixel fixed the occupancy, at 1.4s, but reads 2r+1 values per
/// output, and every one of them from global memory.
///
/// A prefix sum made it O(1) again and changed nothing, which is what showed the limit was
/// never the arithmetic. It also cannot survive half precision: a row scan reaches
/// magnitudes near a thousand where f16's ulp is about 1, and the window is recovered by
/// differencing two of those.
///
/// What is left is the access pattern, and the two axes want opposite things. Horizontally
/// a row is contiguous, so a workgroup can pull its whole span into workgroup memory in
/// coalesced reads and each lane then gathers from there - fast memory, and the sum stays
/// bounded by the window, which is what half precision needs. Vertically a column is
/// strided, so gathering it wastes a cache line per sample; instead each lane owns one
/// column and slides down a strip of rows, which makes every read coalesced across the
/// workgroup and O(1) per pixel again. Both keep the shrinking window at the border: an
/// out-of-frame sample contributes nothing and is not counted, which is the same answer
/// the Rust gets by narrowing its range.

/// Lanes per workgroup, and the span of one horizontal tile.
const SPAN: u32 = 256u;
/// Sized for a radius of 128, which is four times what the coarsest chroma pass asks for
/// at strength 1 and twice what it asks for at 2.
var<workgroup> span: array<f32, 512>;

@compute @workgroup_size(256)
fn box_h(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) local: vec3u) {
  let y = group.y;
  if (y >= tick.height) { return; }
  let radius = tick.radius;
  let row = y * tick.width;
  let x0 = group.x * SPAN;
  let width = 2u * radius + SPAN;

  // Coalesced: consecutive lanes read consecutive samples. Out of frame reads as zero,
  // which is what makes the shrinking window fall out of the count below.
  for (var i = local.x; i < width; i = i + SPAN) {
    let at = i32(x0 + i) - i32(radius);
    let inside = at >= 0 && at < i32(tick.width);
    span[i] = select(0.0, src[row + u32(max(at, 0))], inside);
  }
  workgroupBarrier();

  let x = x0 + local.x;
  if (x >= tick.width) { return; }
  let low = select(x - radius, 0u, x < radius);
  let high = min(x + radius, tick.width - 1u);

  var sum = 0.0;
  let start = local.x + radius - (x - low);
  for (var i = 0u; i <= high - low; i = i + 1u) { sum = sum + span[start + i]; }
  dst[row + x] = sum / f32(high - low + 1u);
}

/// Rows one lane carries before another workgroup takes over. Long enough that seeding the
/// window amortises, short enough that the frame still fills the device.
const STRIP: u32 = 64u;

@compute @workgroup_size(64)
fn box_v(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) local: vec3u) {
  let x = group.x * 64u + local.x;
  if (x >= tick.width) { return; }
  let radius = tick.radius;
  let width = tick.width;
  let height = tick.height;
  let y0 = group.y * STRIP;
  if (y0 >= height) { return; }

  // Seeded once for the strip's first row, then slid. Every read here is coalesced too:
  // the lanes of this workgroup are consecutive columns of one row.
  var low = select(y0 - radius, 0u, y0 < radius);
  var high = min(y0 + radius, height - 1u);
  var sum = 0.0;
  for (var y = low; y <= high; y = y + 1u) { sum = sum + src[y * width + x]; }

  let last = min(y0 + STRIP, height);
  for (var y = y0; y < last; y = y + 1u) {
    dst[y * width + x] = sum / f32(high - low + 1u);
    // The window for the next row: one in at the bottom, one out at the top, and neither
    // where the frame has run out.
    if (y + radius + 1u < height) {
      sum = sum + src[(y + radius + 1u) * width + x];
      high = y + radius + 1u;
    }
    if (y >= radius) {
      sum = sum - src[(y - radius) * width + x];
      low = y - radius + 1u;
    }
  }
}

/// A plane to another plane. Needed where a stage's output is also one of its inputs:
/// binding one buffer as both readable and writable in a single dispatch is a usage
/// conflict, so the write lands in scratch and this moves it.
@compute @workgroup_size(8, 8)
fn copy(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let i = at(id.x, id.y);
  dst[i] = src[i];
}

@compute @workgroup_size(8, 8)
fn square(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let i = at(id.x, id.y);
  dst[i] = src[i] * src[i];
}

@compute @workgroup_size(8, 8)
fn multiply(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let i = at(id.x, id.y);
  dst[i] = src[i] * aux0[i];
}

/// 'variance = mean_squares - mean * mean', and the same shape serves the covariance.
@compute @workgroup_size(8, 8)
fn subtract_product(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let i = at(id.x, id.y);
  dst[i] = src[i] - aux0[i] * aux1[i];
}

/// 'a = covariance / (variance + eps)', with the 0/0 window pinned to a slope of zero.
@compute @workgroup_size(8, 8)
fn slope(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let i = at(id.x, id.y);
  let denominator = aux0[i] + tick.eps;
  dst[i] = select(0.0, src[i] / denominator, denominator > 1.1920929e-7);
}

/// 'b = mean_input - a * guide_mean'.
@compute @workgroup_size(8, 8)
fn intercept(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let i = at(id.x, id.y);
  dst[i] = src[i] - aux0[i] * aux1[i];
}

/// 'out = mean_a * guide + mean_b', the tail of the guided filter.
@compute @workgroup_size(8, 8)
fn combine(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let i = at(id.x, id.y);
  dst[i] = src[i] * aux0[i] + aux1[i];
}

/// The coarse chroma pass's bounded move: 'fine += clamp(coarse - fine, +-limit)'.
@compute @workgroup_size(8, 8)
fn blend_limited(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let i = at(id.x, id.y);
  let fine = dst[i];
  dst[i] = fine + clamp(src[i] - fine, -tick.limit, tick.limit);
}

/// 'luma += amount * (sharpened - luma)', where 'amount' rides in on 'limit'.
@compute @workgroup_size(8, 8)
fn blend_toward(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let i = at(id.x, id.y);
  dst[i] = dst[i] + tick.limit * (src[i] - dst[i]);
}

/// 'image::laplacian', the five-point stencil the defringe regresses on.
@compute @workgroup_size(8, 8)
fn laplacian(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let x = id.x;
  let y = id.y;
  let here = src[at(x, y)];
  let left = src[at(select(x - 1u, 0u, x == 0u), y)];
  let right = src[at(min(x + 1u, tick.width - 1u), y)];
  let up = src[at(x, select(y - 1u, 0u, y == 0u))];
  let down = src[at(x, min(y + 1u, tick.height - 1u))];
  dst[at(x, y)] = left + right + up + down - 4.0 * here;
}

/// 'image::defringe': the curvature of luma, scaled per channel by the fitted defocus.
@compute @workgroup_size(8, 8)
fn defringe(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let i = at(id.x, id.y);
  let curvature = src[i];
  dst[i] = dst[i] - tick.defocus_red * curvature;
}

@compute @workgroup_size(8, 8)
fn defringe_blue(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let i = at(id.x, id.y);
  dst[i] = dst[i] - tick.defocus_blue * src[i];
}
`;

/**
 * The deconvolution and the display transform.
 *
 * Separate from the plane algebra above only because both want extra bindings: the taps
 * for one and the canvas for the other.
 */
export const SHARPEN = /* wgsl */ `
${PRELUDE}
${TICK}
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<storage, read> taps: array<f32>;
@group(0) @binding(4) var<storage, read> observed: array<f32>;

const FLOOR: f32 = 1e-4;

/// 'image::convolve', horizontal, with the clamped edges the Rust uses.
@compute @workgroup_size(8, 8)
fn convolve_h(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let radius = tick.radius;
  var acc = taps[0] * src[at(id.x, id.y)];
  for (var d = 1u; d <= radius; d = d + 1u) {
    let left = src[at(select(id.x - d, 0u, id.x < d), id.y)];
    let right = src[at(min(id.x + d, tick.width - 1u), id.y)];
    acc = acc + taps[d] * (left + right);
  }
  dst[at(id.x, id.y)] = acc;
}

@compute @workgroup_size(8, 8)
fn convolve_v(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let radius = tick.radius;
  var acc = taps[0] * src[at(id.x, id.y)];
  for (var d = 1u; d <= radius; d = d + 1u) {
    let up = src[at(id.x, select(id.y - d, 0u, id.y < d))];
    let down = src[at(id.x, min(id.y + d, tick.height - 1u))];
    acc = acc + taps[d] * (up + down);
  }
  dst[at(id.x, id.y)] = acc;
}

/// The Richardson-Lucy update's ratio: 'observed / blurred', both floored.
@compute @workgroup_size(8, 8)
fn ratio(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let i = at(id.x, id.y);
  dst[i] = max(observed[i], FLOOR) / max(src[i], FLOOR);
}

/// 'estimate *= correction'.
@compute @workgroup_size(8, 8)
fn scale_by(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let i = at(id.x, id.y);
  dst[i] = dst[i] * src[i];
}

@compute @workgroup_size(8, 8)
fn floor_at(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let i = at(id.x, id.y);
  dst[i] = max(src[i], FLOOR);
}

/// 'image::local_extrema', horizontal. Min in x, max in y, so one pass carries both.
@compute @workgroup_size(8, 8)
fn extrema_h(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let radius = tick.radius;
  let here = src[at(id.x, id.y)];
  var low = here;
  var high = here;
  for (var d = 1u; d <= radius; d = d + 1u) {
    let left = src[at(select(id.x - d, 0u, id.x < d), id.y)];
    let right = src[at(min(id.x + d, tick.width - 1u), id.y)];
    low = min(low, min(left, right));
    high = max(high, max(left, right));
  }
  let i = at(id.x, id.y);
  dst[i * 2u] = low;
  dst[i * 2u + 1u] = high;
}

/// The vertical half, then the clamp the anti-ringing exists for.
@compute @workgroup_size(8, 8)
fn extrema_v_clamp(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let radius = tick.radius;
  let i = at(id.x, id.y);
  var low = src[i * 2u];
  var high = src[i * 2u + 1u];
  for (var d = 1u; d <= radius; d = d + 1u) {
    let up = at(id.x, select(id.y - d, 0u, id.y < d)) * 2u;
    let down = at(id.x, min(id.y + d, tick.height - 1u)) * 2u;
    low = min(low, min(src[up], src[down]));
    high = max(high, max(src[up + 1u], src[down + 1u]));
  }
  dst[i] = clamp(dst[i], low, high);
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
@group(0) @binding(1) var<storage, read> luma: array<f32>;
@group(0) @binding(2) var<storage, read> red: array<f32>;
@group(0) @binding(3) var<storage, read> blue: array<f32>;

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
  let x = min(u32(pos.x), tick.width - 1u);
  let y = min(u32(pos.y), tick.height - 1u);
  let i = at(x, y);

  // 'image::recombine': green is solved from the luma equation so the recombination is
  // exactly luma-preserving.
  let l = luma[i];
  let dr = red[i];
  let db = blue[i];
  let dg = -(LUMA.r * dr + LUMA.b * db) / LUMA.g;
  let coded = vec3f(l + dr, l + dg, l + db);

  let nits = vec3f(pq_inv(coded.r), pq_inv(coded.g), pq_inv(coded.b));
  let p3 = (R2020_TO_P3 * nits) / tick.sdr_white;
  return vec4f(encode(p3.r), encode(p3.g), encode(p3.b), 1.0);
}
`;
