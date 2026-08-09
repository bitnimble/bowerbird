// The scene's own top end, as a histogram and a scan. **The only implementation of it.**
//
// The CPU took a quantile of a million sampled pixels by partial sort, through its own copy
// of the colour transform; that copy is gone and both hosts run this. A shader cannot sort a
// million values cheaply, so this bins them and reads the quantile off the cumulative count,
// which is the same statistic at the bin's resolution. No readback on the editor's path: the
// scan writes the peak into a buffer the draw reads next.
//
// Per tick rather than at open because it is not a property of the sensor: it measures
// *after* the colour transform and after the exposure, and `toned` reads the slider. Move
// it to the open and raising exposure pushes highlights past a knee placed for a frame
// that was never exposed, which is a clip. Everything upstream of the slider - `white`,
// `source_level`, the curves, the chroma map - is at the open already.
//
// Whole frame, always, and this is load-bearing rather than incidental. It is the one
// measurement that must not follow the display: sample the visible crop instead and the
// highlight roll-off shifts as the reader pans from a dark region to a bright one, which
// is the most visible failure this pipeline could have. Same reason the stride is fixed
// and unjittered - the sample set has to be the same pixels every tick, or the knee
// shimmers between frames. Its cost does not scale with the frame either, since the count
// is fixed.

@group(0) @binding(5) var<storage, read_write> histogram: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> peak_out: array<f32>;
// [0] counts what cleared the threshold - which may be more than were kept - and the
// levels follow from 4, four to a candidate.
@group(0) @binding(8) var<storage, read_write> candidates: array<atomic<u32>>;

// The host needs the same two numbers to size the buffers; `tests/peak_constants.test.ts`
// holds `shaders.ts` to these.
//
// `const` rather than `override`, and load-bearing: WebKit refuses a pipeline handed a constant
// its entry point does not statically reference, and of the four here `measure` never reads
// CANDIDATES while `collect` never reads BINS. Passing both to all four was every RAW refusing
// to open on Safari with "Compute library failed creation" and nothing else said. Only a value
// that genuinely differs between pipelines built from one entry point may be an `override`
// - `FROM_FRAME` in `frame.wgsl` is the one - since that is the only kind an entry point
// cannot stop using.
const BINS: u32 = 8192u;
const CANDIDATES: u32 = 16384u;

// The histogram is logarithmic, in stops either side of reference white.
//
// Linear bins cannot hold this, and both ways of sizing them are wrong. Fixed at a few
// times diffuse white, they saturate: `measured` is taken *after* the exposure, so the
// slider carries it up with the gain, and a couple of stops up every real highlight lands
// in the last bin - the quantile reads the peak as the top of the range whatever the frame
// holds, and the highlights hard-clip.
//
// Growing the top with the gain instead is worse, because `measured` does not grow with the
// gain: the tone curve compresses highlights, so it rises more slowly, and a range that
// rose linearly left the candidates collapsing towards the first bin. There the quantile
// reads a peak of nearly nothing, the roll-off clamps the whole frame to it, and the
// picture goes dark and flat - at particular slider positions, on the photographs whose
// curves compress hardest.
//
// In stops both problems disappear, because relative resolution is what a peak needs: 8192
// bins over 28 stops is 0.0034 of a stop each, and the range covers anything a sensor and a
// slider can produce between them.
const LOG_LOW: f32 = -14.0;
const LOG_HIGH: f32 = 14.0;
const LOG_SPAN: f32 = LOG_HIGH - LOG_LOW;

/// Which bin a value in units of reference white falls in.
fn bin_of(v: f32) -> u32 {
  // Below the range is the bottom bin rather than an error: a black pixel is a real sample
  // and `log2(0)` is not a number to clamp.
  let stops = log2(max(v, 1e-9));
  let t = (stops - LOG_LOW) / LOG_SPAN;
  return min(u32(max(t, 0.0) * f32(BINS)), BINS - 1u);
}

/// The value at a bin's own centre, in units of reference white.
fn bin_centre(bin: u32) -> f32 {
  return exp2(LOG_LOW + ((f32(bin) + 0.5) / f32(BINS)) * LOG_SPAN);
}

/// And at its lower edge, which is the form a threshold wants.
fn bin_floor(bin: u32) -> f32 {
  return exp2(LOG_LOW + (f32(bin) / f32(BINS)) * LOG_SPAN);
}

/// `tone::PEAK_QUANTILE`.
const QUANTILE: f32 = 0.9999;

/// What the quantile is taken of: the post-colour peak channel, in units of reference.
fn measured(nits: vec3f, uv: vec2f) -> f32 {
  let coloured = matched_nits(nits, uv) / tick.reference;
  return max(coloured.r, max(coloured.g, coloured.b));
}

/// A pixel's own place in the frame, normalised, which the presence sliders read the blur at.
fn uv_of(x: u32, y: u32) -> vec2f {
  return (vec2f(f32(x), f32(y)) + vec2f(0.5)) / vec2f(f32(tick.width), f32(tick.height));
}

fn count_in(v: f32) {
  atomicAdd(&histogram[bin_of(v)], 1u);
}

/// The sampled row of the frame this invocation covers, or nothing.
fn sampled(id: vec3u) -> vec2u {
  let y = id.y * tick.row_stride;
  if (id.x >= tick.width || y >= tick.height) { return vec2u(0u, 0xffffffffu); }
  return vec2u(id.x, y);
}

/// About a million pixels, as whole rows. Runs at the open, not per tick.
///
/// Three shapes, and the reasoning matters more than the code. Reading every pixel was
/// first, on the grounds that a shader has no reason to subsample - but this pass runs the
/// same colour transform the grade does, so at full frame it costs what the grade costs.
/// Measured at 12.5ms against the grade's 12.8, and the atomics are not what dominates it.
/// The CPU never read every pixel either: `tone::QUANTILE_SAMPLES` caps it at a million.
///
/// Copying the CPU's stride exactly was second, and it barely helped: `k * pixels /
/// counted` scatters consecutive lanes about ten pixels apart, so every one of them takes
/// its own cache line and the pass is back to fetching the whole frame to read a tenth of
/// it. Whole rows, every nth, samples just as evenly - the count is what the quantile cares
/// about, and `tone::levels` says so - while consecutive lanes stay adjacent.
@compute @workgroup_size(64)
fn measure(@builtin(global_invocation_id) id: vec3u) {
  let at = sampled(id);
  if (at.y == 0xffffffffu) { return; }
  count_in(measured(nits_at(at.x, at.y), uv_of(at.x, at.y)));
}

/// The brightest of those million, kept so the tick does not have to find them again.
///
/// Runs once, after a full `measure` and the `quantile` that turns it into a threshold.
/// What makes this sound is that the exposure cannot reorder the frame much: `toned`
/// returns `base(level) * gain`, where the base colour is fixed at the open and only the
/// gain moves with the slider, so a pixel's rank changes only by how differently the tone
/// curve compresses its luma from its neighbours' - and among highlights, which sit in the
/// same compressed stretch of the curve, hardly at all. Where it does not hold, it does
/// not matter: ranks shuffle freely only when the values are close together, and then any
/// of them is the same answer.
///
/// The presence sliders are the one gain that is *not* smooth in the pixel's own value - a
/// clarity lift is worth more at an edge than a stop away from one - so a frame graded with
/// them measures its peak off pixels chosen without them. What that costs is a knee placed
/// against a slightly different set of highlights, which moves the roll-off rather than
/// clipping anything: `display_nits` clamps whatever the curve leaves above the display.
@compute @workgroup_size(64)
fn collect(@builtin(global_invocation_id) id: vec3u) {
  let at = sampled(id);
  if (at.y == 0xffffffffu) { return; }
  // The codes rather than the nits, because that is what a candidate is kept as: `remeasure`
  // decodes them again at the tick's own exposure.
  let level = level_at(at.x, at.y);
  if (measured(nits_of(level), uv_of(at.x, at.y)) < peak_out[1]) { return; }

  // Counted past the cap rather than clamped, so the caller can tell that more qualified
  // than were kept and stop reading them. A blown sky puts far more than `CANDIDATES` in one
  // bin; what is kept then is the top of the frame, since these arrive in dispatch order.
  let slot = atomicAdd(&candidates[0], 1u);
  if (slot >= CANDIDATES) { return; }
  let base = 4u + slot * 4u;
  atomicStore(&candidates[base], u32(level.r));
  atomicStore(&candidates[base + 1u], u32(level.g));
  atomicStore(&candidates[base + 2u], u32(level.b));
  // The fourth word was padding, keeping the stride a power of two. It carries the raster
  // index now, because `remeasure` grades these pixels again and the presence sliders need
  // to know where each one was - a candidate with no position would be graded against the
  // blur at the frame's top-left corner, so a strong clarity would move the roll-off knee
  // by however hazy that corner happened to be.
  atomicStore(&candidates[base + 3u], at.y * tick.width + at.x);
}

/// The tick's whole measurement: the kept candidates, at this exposure.
@compute @workgroup_size(64)
fn remeasure(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= min(atomicLoad(&candidates[0]), CANDIDATES)) { return; }
  let base = 4u + id.x * 4u;
  let pixel = atomicLoad(&candidates[base + 3u]);
  count_in(measured(
    nits_of(vec3f(
      f32(atomicLoad(&candidates[base])),
      f32(atomicLoad(&candidates[base + 1u])),
      f32(atomicLoad(&candidates[base + 2u])),
    )),
    uv_of(pixel % tick.width, pixel / tick.width),
  ));
}

/// The quantile off the cumulative count, searched from the bright end.
///
/// From the top rather than the bottom because that is the end the answer is at, and
/// because it is the only form that reads the same whether the histogram holds the whole
/// sample or only its brightest: rank 100-from-the-top is rank 100-from-the-top either
/// way, where rank 999,900-from-the-bottom is not.
///
/// One invocation walking every bin was fine at 1024 and is not at 8192: that is 16,384
/// dependent iterations on a single lane, each waiting on a global load, and it measured as
/// most of what the peak pass costs. So the bins are summed in parallel first - a lane per
/// chunk - and only the search across 256 partials and then within one chunk stays serial,
/// which is 288 steps rather than 16,384.
const CHUNKS: u32 = 256u;
var<workgroup> partial: array<u32, 256>;

fn bin_value(bin: u32) -> f32 {
  return bin_centre(bin) * tick.reference;
}

@compute @workgroup_size(256)
fn quantile(@builtin(local_invocation_id) local: vec3u) {
  let width = BINS / CHUNKS;
  let first = local.x * width;

  var sum = 0u;
  for (var b = first; b < first + width; b = b + 1u) { sum = sum + atomicLoad(&histogram[b]); }
  partial[local.x] = sum;
  workgroupBarrier();

  if (local.x != 0u) { return; }

  // How far down from the brightest the answer sits, over the sample the CPU would have
  // taken. The same rank whether the histogram holds the whole sample or only the candidates,
  // because the candidates are read only when they are every pixel that cleared the
  // threshold - the caller checks the count and reads the frame instead when they are not.
  //
  // There was a rescale here, by the share of qualifying pixels kept. It read that share as a
  // fair sample and it is not one: `collect` keeps whichever arrive first, in dispatch order,
  // so an overflow keeps the top rows of the frame rather than a spread of it - and the peak
  // it measures is that region's rather than the picture's.
  let want = u32(max(1.0, (1.0 - QUANTILE) * f32(tick.peak_samples)));

  // The chunk the quantile falls in, then the bin inside it, both from the top.
  var seen = 0u;
  var chunk = 0u;
  for (var c = CHUNKS; c > 0u; c = c - 1u) {
    if (seen + partial[c - 1u] >= want) { chunk = c - 1u; break; }
    seen = seen + partial[c - 1u];
  }
  var found = 0u;
  for (var b = (chunk + 1u) * width; b > chunk * width; b = b - 1u) {
    seen = seen + atomicLoad(&histogram[b - 1u]);
    if (seen >= want) { found = b - 1u; break; }
  }

  // The bin's centre, and never zero: a scene peak of zero would put the roll-off in a
  // division by it, which is the same guard `scene_peak_nits` applies by returning None.
  peak_out[0] = max(bin_value(found), 1.0);

  // And the threshold `collect` keeps a pixel above, which is the same search at a much
  // shallower rank. Only on the open's run: it walks every bin rather than stopping near
  // the top, which measured at 0.7ms - most of what the tick's peak now costs at all.
  //
  // Asked as "has anything been collected yet", which is what the open's run actually is:
  // `collect` runs after this and in the same submit, so the count is zero here and only
  // here. It used to ask whether the tick was reading the candidates, which meant the same
  // thing right up until a tick could stop reading them - a frame whose candidates overflowed
  // falls back to reading the whole frame, and every one of those ticks was then re-walking
  // all 8192 bins for a threshold nothing would read again.
  if (atomicLoad(&candidates[0]) != 0u) { return; }
  seen = 0u;
  var edge = 0u;
  for (var b = BINS; b > 0u; b = b - 1u) {
    seen = seen + atomicLoad(&histogram[b - 1u]);
    if (seen >= CANDIDATES / 2u) { edge = b - 1u; break; }
  }
  // The bin's lower edge, and in what `measured` returns rather than in nits: `collect`
  // compares against this before the reference has been multiplied back in.
  peak_out[1] = bin_floor(edge);
}
