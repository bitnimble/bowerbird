// How much of each channel's colour is the curvature of luma, measured where the frame already is.
//
// `image::measure_defocus` reads two whole-frame reductions and then fits six numbers. The two
// reductions are here - the radial sums the slope is fitted from, and the residual histograms each
// channel's noise sigma is a median of - and nothing else is. `base::measure_defocus` says where
// the line is and why it is there.
//
// **The measurement is the reason the chain cannot stay resident without it.** The coefficients are
// read off the *coded* frame, so a caller that wants `prepare` to do the coding has nowhere to run
// this but here.

/// `image::DEFOCUS_BINS`, `DEFOCUS_STRIDE` and `NOISE_BINS`. The host asserts all three, because a
/// frame binned one way and fitted another has no error that shows.
const BINS: u32 = 6u;
const STRIDE: u32 = 3u;
const NOISE_BINS: u32 = 1024u;

/// Sampled points one invocation sums before it hands its partials to the host.
///
/// **The frame's sums are `f64` on the CPU and there is no such thing in WGSL**, so the widening
/// happens one level up: an invocation sums 64 samples in `f32`, the host adds the partials in
/// `f64`. Long enough that the readback is megabytes rather than hundreds, short enough that the
/// `f32` run is shorter than the row the CPU accumulates in one go.
const PER_SEGMENT: u32 = 64u;

struct Params {
  width: u32,
  height: u32,
  samples_x: u32,
  rows: u32,
  segments: u32,
  cx: f32,
  cy: f32,
  half_squared: f32,
  /// `image::LUMA`, and `noise_max` lands in the padding `vec3f` leaves behind - the same layout
  /// the host writes, and not a coincidence worth relying on silently.
  luma: vec3f,
  noise_max: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> frame: array<u32>;
/// Per segment, per bin: the two cross sums, the curvature energy, and the count.
@group(0) @binding(2) var<storage, read_write> partials: array<vec4f>;
/// The three channels' residual histograms, end to end.
@group(0) @binding(3) var<storage, read_write> residuals: array<atomic<u32>>;

fn sample_at(at: u32) -> f32 {
  let word = frame[at / 2u];
  return f32(select(word >> 16u, word & 0xffffu, (at & 1u) == 0u));
}

/// `image::luma_of`, normalised the same way round: the weights sum first and the divide comes
/// after, or the response and the regressor round differently from the CPU's.
fn luma_at(x: u32, y: u32) -> f32 {
  let p = (y * params.width + x) * 3u;
  return dot(params.luma, vec3f(sample_at(p), sample_at(p + 1u), sample_at(p + 2u))) / 65535.0;
}

/// One segment of one sampled row, binned by radius.
///
/// The stride is the CPU's: rows and columns from 1, every third, and the frame's border left out
/// because the stencil has no room there.
@compute @workgroup_size(64)
fn defocus_bins(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let segment = linear(id, groups);
  if (segment >= params.rows * params.segments) { return; }
  let y = 1u + (segment / params.segments) * STRIDE;
  let dy = f32(y) - params.cy;

  var cross_red: array<f32, BINS>;
  var cross_blue: array<f32, BINS>;
  var square: array<f32, BINS>;
  var counted: array<f32, BINS>;

  let first = (segment % params.segments) * PER_SEGMENT;
  let last = min(first + PER_SEGMENT, params.samples_x);
  for (var s = first; s < last; s++) {
    let x = 1u + s * STRIDE;
    let here = luma_at(x, y);
    let curvature = luma_at(x - 1u, y) + luma_at(x + 1u, y) + luma_at(x, y - 1u)
      + luma_at(x, y + 1u) - 4.0 * here;
    let p = (y * params.width + x) * 3u;
    // Against luma rather than against green, as the correction is applied.
    let red = sample_at(p) / 65535.0 - here;
    let blue = sample_at(p + 2u) / 65535.0 - here;
    let dx = f32(x) - params.cx;
    let bin = min(u32((dx * dx + dy * dy) / params.half_squared * f32(BINS)), BINS - 1u);
    cross_red[bin] += curvature * red;
    cross_blue[bin] += curvature * blue;
    square[bin] += curvature * curvature;
    counted[bin] += 1.0;
  }

  for (var bin = 0u; bin < BINS; bin++) {
    partials[segment * BINS + bin] =
      vec4f(cross_red[bin], cross_blue[bin], square[bin], counted[bin]);
  }
}

/// Each channel's high-pass residual, into the histogram the host takes a median off.
///
/// **The 3x3 mean is summed directly where `image::box_mean` sweeps it separably.** The horizontal
/// window clips at the same two columns for every row of the vertical one, so the separable answer
/// is the mean over the same clipped rectangle - nine taps a pixel is more arithmetic than a
/// sliding sum and less than a second whole-frame buffer to hold the intermediate in.
@compute @workgroup_size(64)
fn defocus_residuals(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let at = linear(id, groups);
  if (at >= params.width * params.height) { return; }
  let x = at % params.width;
  let y = at / params.width;
  let x0 = max(x, 1u) - 1u;
  let x1 = min(x + 1u, params.width - 1u);
  let y0 = max(y, 1u) - 1u;
  let y1 = min(y + 1u, params.height - 1u);
  let window = f32((x1 - x0 + 1u) * (y1 - y0 + 1u));

  for (var channel = 0u; channel < 3u; channel++) {
    var sum = 0.0;
    for (var yy = y0; yy <= y1; yy++) {
      for (var xx = x0; xx <= x1; xx++) {
        sum += sample_at((yy * params.width + xx) * 3u + channel) / 65535.0;
      }
    }
    let residual = abs(sample_at(at * 3u + channel) / 65535.0 - sum / window);
    let slot = min(u32(residual / params.noise_max * f32(NOISE_BINS)), NOISE_BINS - 1u);
    atomicAdd(&residuals[channel * NOISE_BINS + slot], 1u);
  }
}
