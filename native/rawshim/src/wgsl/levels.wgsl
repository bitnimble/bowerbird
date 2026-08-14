// The frame's own diffuse white and peak, counted where the frame already is.
//
// `tone::levels` bins the brightest component of a fixed number of sampled pixels into 65536
// levels and then walks up them. Only the binning is here: the walk is `tone::scan`'s, on the
// host, and `base::levels` says why the line is there.
//
// **Global atomics, with no per-workgroup copy.** 65536 bins is 256KB against a workgroup's 16KB,
// so the usual staging - bin into shared memory, merge once per group - has nowhere to put the
// staged copy. What makes contending on the global bins affordable is that the work is the sample
// count and not the frame: 2^20 increments whether the photograph is 24MP or 61.

/// `tone::QUANTILE_SAMPLES`, as the shift that divides by it. The host asserts the two agree.
const SAMPLE_SHIFT: u32 = 20u;

struct Params {
  /// `pixels.min(QUANTILE_SAMPLES)`, and one invocation per sample of it.
  counted: u32,
  /// `pixels / counted` and `pixels % counted`, taken on the host where 52 bits are available.
  whole: u32,
  rest: u32,
  pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> frame: array<u32>;
@group(0) @binding(2) var<storage, read_write> histogram: array<atomic<u32>>;

fn sample_at(at: u32) -> u32 {
  let word = frame[at / 2u];
  return select(word >> 16u, word & 0xffffu, (at & 1u) == 0u);
}

/// `tone::sample_at`, which is `k * pixels / counted` - 52 bits at 61MP, where WGSL has no `u64`.
///
/// Split as `k * whole + (k * rest) / counted` so only the second term needs the width, then `k`
/// split at bit 10 so that term's two products stay under 2^30: with `A = (k >> 10) * rest` and
/// `B = (k & 1023) * rest`, `(k * rest) >> 20` is `(A >> 10) + ((((A & 1023) << 10) + B) >> 20)`.
///
/// The shift *is* the divide only because `counted` is either 2^20 or the whole frame - and in
/// the second case `pixels == counted`, so `rest` is 0 and the term being shifted is 0 with it.
/// A `counted` that was neither would silently divide by the wrong number here.
fn pixel_at(k: u32) -> u32 {
  let high = (k >> 10u) * params.rest;
  let low = (k & 1023u) * params.rest;
  return k * params.whole + (high >> 10u) + ((((high & 1023u) << 10u) + low) >> SAMPLE_SHIFT);
}

/// One sampled pixel's brightest component, into the bin the host reads the quantiles off.
@compute @workgroup_size(64)
fn levels(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let k = linear(id, groups);
  if (k >= params.counted) { return; }
  let p = pixel_at(k) * 3u;
  let brightest = max(max(sample_at(p), sample_at(p + 1u)), sample_at(p + 2u));
  atomicAdd(&histogram[brightest], 1u);
}
