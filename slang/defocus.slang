// How much of each channel's colour is the curvature of luma, measured where the frame already is.
//
// **A focus difference between channels is not an arbitrary colour at an edge.** With
// `sigma_R = sigma_G + d` and the heat equation `dg/dsigma = sigma.lap g`, an achromatic edge
// imaged through the two comes out as
//
//     R - G  =  L * (g_sigmaR - g_sigmaG)  ~  d.sigma . lap(G)
//
// so the fringe is the Laplacian of luma times one coefficient per frame. That predicts what is
// actually seen: the Laplacian of a sigmoid is odd, which is why a fringe reads magenta on one side
// of an edge and green on the other, and vanishes on the flats.
//
// Fitted as a least-squares slope, so a frame with no focus difference returns a coefficient of
// zero rather than needing a threshold to be told to do nothing. A genuine coloured object
// contributes a *step*, not a curvature, and objects appear at every edge polarity across a frame,
// so they add variance to this rather than slope - the same argument `tca::estimate` rests on, and
// the same failure mode: a frame *dominated* by one coloured object can still bias it, which is
// what the sign agreement in `base::measure_defocus`'s tail guards.
//
// **In linear light, because that is where the defect happened.** Convolution is linear in
// intensity, so the relation above is exactly specified on the decode and only locally true on a
// coded frame, where the curve's slope - and the effective coefficient with it - drifts with level.
// Measured on a frame carrying a known focus difference: correcting in linear takes off 96% and 97%
// of the red and blue fringe where correcting in PQ took off -9% and 26%, and the coefficient is
// flat across radius to 4% in linear against a 29% swing in PQ, on a quantity a focus difference
// cannot vary.
//
// The two whole-frame reductions are here - the radial sums the slope is fitted from, and the
// residual histograms each channel's noise sigma is a median of - and nothing else is.
// `base::measure_defocus` holds the six-number fit those feed, and says where the line is drawn.
import lanes;
import packed;

/// `image::DEFOCUS_BINS`, `DEFOCUS_STRIDE` and `NOISE_BINS`. The host asserts all three, because a
/// frame binned one way and fitted another has no error that shows.
static const uint BINS = 6;
static const uint STRIDE = 3;
static const uint NOISE_BINS = 1024;

/// Sampled points one invocation sums before it hands its partials to the host.
///
/// **The frame's sums are `f64` on the CPU and there is no such thing in WGSL**, so the widening
/// happens one level up: an invocation sums 64 samples in `f32`, the host adds the partials in
/// `f64`. Long enough that the readback is megabytes rather than hundreds, short enough that the
/// `f32` run is shorter than the row the CPU accumulates in one go.
static const uint PER_SEGMENT = 64;

struct Params {
    uint width;
    uint height;
    uint samples_x;
    uint rows;
    uint segments;
    float cx;
    float cy;
    float half_squared;
    /// `image::LUMA`, and `noise_max` lands in the padding `vec3f` leaves behind - the same layout
    /// the host writes, and not a coincidence worth relying on silently.
    float3 luma;
    float noise_max;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] RWStructuredBuffer<uint> frame;
/// Per segment, per bin: the two cross sums, the curvature energy, and the count.
[vk::binding(2, 0)] RWStructuredBuffer<float4> partials;
/// The three channels' residual histograms, end to end.
[vk::binding(3, 0)] RWStructuredBuffer<Atomic<uint> > residuals;

float sample_at(uint at)
{
    return float(half_of(frame[at / 2], at));
}

/// `image::luma_of`, normalised the same way round: the weights sum first and the divide comes
/// after, or the response and the regressor round differently from the CPU's.
float luma_at(uint x, uint y)
{
    let p = (y * params.width + x) * 3;
    return dot(params.luma, float3(sample_at(p), sample_at(p + 1), sample_at(p + 2))) / 65535.0;
}

/// One segment of one sampled row, binned by radius.
///
/// The stride is the CPU's: rows and columns from 1, every third, and the frame's border left out
/// because the stencil has no room there.
[shader("compute")]
[numthreads(64, 1, 1)]
void defocus_bins(uint3 id : SV_DispatchThreadID)
{
    let segment = linear(id);
    if (segment >= params.rows * params.segments) { return; }
    let y = 1 + (segment / params.segments) * STRIDE;
    let dy = float(y) - params.cy;

    float cross_red[BINS];
    float cross_blue[BINS];
    float square[BINS];
    float counted[BINS];
    // Slang leaves a local array uninitialised where WGSL's `var` zeroes one, and these are summed
    // into rather than assigned. Without this the partials carry whatever the stack held.
    for (uint bin = 0; bin < BINS; bin++) {
        cross_red[bin] = 0.0;
        cross_blue[bin] = 0.0;
        square[bin] = 0.0;
        counted[bin] = 0.0;
    }

    let first = (segment % params.segments) * PER_SEGMENT;
    let last = min(first + PER_SEGMENT, params.samples_x);
    for (uint s = first; s < last; s++) {
        let x = 1 + s * STRIDE;
        let here = luma_at(x, y);
        let curvature = luma_at(x - 1, y) + luma_at(x + 1, y) + luma_at(x, y - 1)
            + luma_at(x, y + 1) - 4.0 * here;
        let p = (y * params.width + x) * 3;
        // Against luma rather than against green, as the correction is applied.
        let red = sample_at(p) / 65535.0 - here;
        let blue = sample_at(p + 2) / 65535.0 - here;
        let dx = float(x) - params.cx;
        let bin = min(uint((dx * dx + dy * dy) / params.half_squared * float(BINS)), BINS - 1);
        cross_red[bin] += curvature * red;
        cross_blue[bin] += curvature * blue;
        square[bin] += curvature * curvature;
        counted[bin] += 1.0;
    }

    for (uint bin = 0; bin < BINS; bin++) {
        partials[segment * BINS + bin] =
            float4(cross_red[bin], cross_blue[bin], square[bin], counted[bin]);
    }
}

/// Each channel's high-pass residual, into the histogram the host takes a median off.
///
/// **The 3x3 mean is summed directly rather than separably.** The horizontal window clips at the
/// same two columns for every row of the vertical one, so a separable sweep would give the mean
/// over the same clipped rectangle - nine taps a pixel is more arithmetic than a sliding sum and
/// less than a second whole-frame buffer to hold the intermediate in.
[shader("compute")]
[numthreads(64, 1, 1)]
void defocus_residuals(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= params.width * params.height) { return; }
    let x = at % params.width;
    let y = at / params.width;
    let x0 = max(x, 1) - 1;
    let x1 = min(x + 1, params.width - 1);
    let y0 = max(y, 1) - 1;
    let y1 = min(y + 1, params.height - 1);
    let window = float((x1 - x0 + 1) * (y1 - y0 + 1));

    for (uint channel = 0; channel < 3; channel++) {
        float sum = 0.0;
        for (uint yy = y0; yy <= y1; yy++) {
            for (uint xx = x0; xx <= x1; xx++) {
                sum += sample_at((yy * params.width + xx) * 3 + channel) / 65535.0;
            }
        }
        let residual = abs(sample_at(at * 3 + channel) / 65535.0 - sum / window);
        let slot = min(uint(residual / params.noise_max * float(NOISE_BINS)), NOISE_BINS - 1);
        residuals[channel * NOISE_BINS + slot].add(1);
    }
}
