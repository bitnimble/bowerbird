// `MatchedGrade::scene_peak_nits`, as a histogram and a scan.
//
// The CPU takes a quantile of a million sampled pixels by partial sort. A shader cannot
// sort a million values cheaply, so this bins them and reads the quantile off the
// cumulative count, which is the same statistic at the bin's resolution. No readback: the
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

// Overridden at pipeline creation from `shaders.ts`, which is where the host needs the
// same two numbers to size the buffers. The defaults here are what it passes.
override BINS: u32 = 8192u;
override CANDIDATES: u32 = 16384u;

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
fn measured(level: vec3f) -> f32 {
  let coloured = matched_nits(level) / tick.reference;
  return max(coloured.r, max(coloured.g, coloured.b));
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
  count_in(measured(level_at(at.x, at.y)));
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
@compute @workgroup_size(64)
fn collect(@builtin(global_invocation_id) id: vec3u) {
  let at = sampled(id);
  if (at.y == 0xffffffffu) { return; }
  let level = level_at(at.x, at.y);
  if (measured(level) < peak_out[1]) { return; }

  // Counted past the cap rather than clamped, so the quantile can tell that it is reading
  // a subsample and scale its rank to match. A blown sky puts far more than `CANDIDATES`
  // in one bin, and dropping the overflow silently would move the peak instead.
  let slot = atomicAdd(&candidates[0], 1u);
  if (slot >= CANDIDATES) { return; }
  let base = 4u + slot * 4u;
  atomicStore(&candidates[base], u32(level.r));
  atomicStore(&candidates[base + 1u], u32(level.g));
  atomicStore(&candidates[base + 2u], u32(level.b));
}

/// The tick's whole measurement: the kept candidates, at this exposure.
@compute @workgroup_size(64)
fn remeasure(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= min(atomicLoad(&candidates[0]), CANDIDATES)) { return; }
  let base = 4u + id.x * 4u;
  count_in(measured(vec3f(
    f32(atomicLoad(&candidates[base])),
    f32(atomicLoad(&candidates[base + 1u])),
    f32(atomicLoad(&candidates[base + 2u])),
  )));
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
  // taken. When the histogram holds only the candidates, that rank is scaled by the share
  // of the qualifying pixels actually kept - a subsample of a subsample is still a
  // subsample, which is the same argument `QUANTILE_SAMPLES` rests on.
  var rank = max(1.0, (1.0 - QUANTILE) * f32(tick.peak_samples));
  if (tick.from_candidates == 1u) {
    let above = max(atomicLoad(&candidates[0]), 1u);
    rank = max(1.0, rank * f32(min(above, CANDIDATES)) / f32(above));
  }
  let want = u32(rank);

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
  if (tick.from_candidates == 1u) { return; }
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
