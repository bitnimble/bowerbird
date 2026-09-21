// Capture sharpening: Richardson-Lucy deconvolution of the resample's blur, on the frame
// where it already is.
//
// The estimate converges towards the image that, blurred by the given Gaussian, would have
// produced the frame in hand - so an edge comes back steeper rather than merely higher
// contrast. The update is RL's own: divide the observation by the current estimate re-blurred,
// blur that ratio, and scale the estimate by it. A Gaussian is symmetric, so the adjoint
// convolution is the same one.
//
// Luma only: the blur being undone is achromatic, so the estimate is a luma plane and the
// apply pass translates each pixel's chroma differences to the new luma unchanged. The host
// drives one iteration as four dispatches (blur H, blur V + ratio, blur H, blur V + multiply)
// over ping-pong planes; the iteration count is the host's `image::DECONVOLVE_ITERATIONS`.
import lanes;
import light;
import packed;
import px;

struct Params {
    uint width;
    uint height;
    /// How much of the deconvolution to blend in, 1.0 being it exactly as computed.
    ///
    /// The host has already taken the reader's slider through `image::SHARPEN_GAIN`, so this
    /// arrives above 1 for the top half of that track and the blend is an extrapolation past the
    /// estimate rather than towards it, bounded by `limited`.
    float amount;
    /// A sample's range: 65535 for the `u16` frame.
    float full;
    /// Normalised Gaussian half-kernel for the sigma this frame wants, centre outwards.
    ///
    /// Built by the host (`image::gaussian`) so both hosts hand the same three numbers to the
    /// same file; the sigma varies per photograph now that it is estimated rather than assumed.
    ///
    /// `capture` and `resample` sit in the two `float3` tails rather than after them - the
    /// layout the host writes byte for byte, with no hole for a scalar to slide into.
    float3 taps;
    /// The capture blur at this frame's scale before the warp stretched it; with `resample`,
    /// the pair the per-pixel sigma is composed from when `spatial` is on.
    float capture;
    /// `image::LUMA` - BT.709, the frame-side rule, not `prelude.slang`'s BT.2020 grading one.
    float3 luma;
    float resample;
    /// Whether the warp handed over a Jacobian to vary the sigma by; off, `taps` rule alone.
    uint spatial;
    /// `image::SHARPEN_OVERSHOOT`.
    float overshoot;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] RWStructuredBuffer<uint> frame;
[vk::binding(2, 0)] RWStructuredBuffer<float> observed;
[vk::binding(3, 0)] RWStructuredBuffer<float> estimate;
[vk::binding(4, 0)] RWStructuredBuffer<float> blurred;
[vk::binding(5, 0)] RWStructuredBuffer<float> ratio;
/// The warp's own: output pixels per source pixel, `(x, y)` packed `f16`, per pixel.
[vk::binding(6, 0)] RWStructuredBuffer<uint> jacobian;
[vk::binding(7, 0)] StructuredBuffer<float> light_of_code;
[vk::binding(8, 0)] StructuredBuffer<float> noise;

/// Away from zero, since the update divides by the estimate's own blur. A frame in 0..1 with
/// true blacks would otherwise produce infinities on the first pass.
static const float FLOOR = 1e-4;

/// Half-width of the point spread and of the anti-ringing window, in taps: what `row_taps` and
/// `column_taps` span.
///
/// **Taps and not pixels**, which is the distinction the unit is carrying: this is how many
/// samples the stencil reads, and what decides how much picture they span is the sigma, which
/// `image::deconvolve_split` composes per scale and clamps to what five taps are honest for.
/// `image::DECONVOLVE_RADIUS`'s value; a test holds the two together.
static const Span<Tap> RADIUS = { 2 };
static const float SUPPORT_SIGMAS = 6.0;
static const uint NOISE_SENSITIVITY = 0;
static const uint NOISE_SHOT = 9;
static const uint NOISE_READ = 12;
static const uint NOISE_WORDS = 15;

float sample_at(uint at)
{
    return float(half_of(frame[at / 2], at));
}

uint3 level_of(float3 value)
{
    return uint3(round(clamp(value, 0.0, params.full)));
}

/// The five-tap stencils, edges clamped: a border pixel reads itself for the neighbour it does
/// not have. Indices rather than pointer-to-plane
/// helpers because a storage pointer as a function parameter is a WGSL extension the browser
/// is not promised to have.
uint4 row_taps(uint x, uint y)
{
    let row = y * params.width;
    return uint4(
        row + max(x, 1) - 1,
        row + min(x + 1, params.width - 1),
        row + max(x, 2) - 2,
        row + min(x + 2, params.width - 1));
}

uint4 column_taps(uint x, uint y)
{
    return uint4(
        (max(y, 1) - 1) * params.width + x,
        min(y + 1, params.height - 1) * params.width + x,
        (max(y, 2) - 2) * params.width + x,
        min(y + 2, params.height - 1) * params.width + x);
}

/// `image::gaussian` for radius 2, at whatever variance this pixel composed: the outer tap's
/// exponent is four times the inner's, so one `exp` serves both.
float3 taps_for(float variance)
{
    let t1 = exp(-0.5 / variance);
    let t1_2 = t1 * t1;
    let t2 = t1_2 * t1_2;
    return float3(1.0, t1, t2) / (1.0 + 2.0 * (t1 + t2));
}

/// The kernel one pixel's row or column pass reads with.
///
/// Uniform where the warp handed nothing over; otherwise the capture term is stretched by
/// the warp's local derivative on this axis - blur is uniform in the *source*, so a corner
/// the correction stretched carries proportionally wider blur - and recomposed with the
/// resample's own spread. Clamped to the range the five taps are honest for, as the host
/// clamps its own composition.
float3 axis_taps(uint pixel, uint axis)
{
    if (params.spatial == 0) {
        return params.taps;
    }
    let j = unpackHalf2x16ToFloat(jacobian[pixel]);
    let capture = params.capture * select(axis == 0, j.x, j.y);
    // The sigma's clamp to 0.3..0.84, squared.
    return taps_for(clamp(capture * capture + params.resample * params.resample, 0.09, 0.7056));
}

/// Luma into a plane of its own, and the estimate's floor.
[shader("compute")]
[numthreads(64, 1, 1)]
void sharpen_luma(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= params.width * params.height) { return; }
    let p = at * 3;
    let rgb = float3(sample_at(p), sample_at(p + 1), sample_at(p + 2));
    let l = dot(params.luma, rgb) / params.full;
    observed[at] = l;
    estimate[at] = max(l, FLOOR);
}

/// First half of `blurred = G (x) estimate`.
[shader("compute")]
[numthreads(64, 1, 1)]
void sharpen_spread(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= params.width * params.height) { return; }
    let taps = row_taps(at % params.width, at / params.width);
    let k = axis_taps(at, 0);
    blurred[at] = k.x * estimate[at]
        + k.y * (estimate[taps.x] + estimate[taps.y])
        + k.z * (estimate[taps.z] + estimate[taps.w]);
}

/// Second half of the blur, and the RL ratio against it in the same breath.
[shader("compute")]
[numthreads(64, 1, 1)]
void sharpen_ratio(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= params.width * params.height) { return; }
    let taps = column_taps(at % params.width, at / params.width);
    let k = axis_taps(at, 1);
    let spread = k.x * blurred[at]
        + k.y * (blurred[taps.x] + blurred[taps.y])
        + k.z * (blurred[taps.z] + blurred[taps.w]);
    ratio[at] = max(observed[at], FLOOR) / max(spread, FLOOR);
}

/// First half of the correction blur, over the ratio.
[shader("compute")]
[numthreads(64, 1, 1)]
void sharpen_gather(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= params.width * params.height) { return; }
    let taps = row_taps(at % params.width, at / params.width);
    let k = axis_taps(at, 0);
    blurred[at] = k.x * ratio[at]
        + k.y * (ratio[taps.x] + ratio[taps.y])
        + k.z * (ratio[taps.z] + ratio[taps.w]);
}

/// Second half of the correction, scaling the estimate in place.
///
/// **The correction is squared, which is two Richardson-Lucy steps in one.** RL's step is a ratio
/// and its exponent compounds, so taking it twice takes the same walk two iterations would -
/// against a known blur, N iterations squared recover what 2N unsquared do, amplifying a noise
/// field by the same factor to three decimals. A cube does not converge: on a blurred step edge
/// it reads 0.494 of the step at ten iterations, 1.000 at twenty and 0.494 again at eighty, an
/// estimate oscillating rather than settling.
///
/// Written as a multiply rather than `pow`, which slangc emits as a call the driver lowers to an
/// exp2/log2 pair - two transcendentals per pixel per iteration to save one multiply, and inexact
/// where this is exact.
[shader("compute")]
[numthreads(64, 1, 1)]
void sharpen_correct(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= params.width * params.height) { return; }
    let taps = column_taps(at % params.width, at / params.width);
    let k = axis_taps(at, 1);
    let c = k.x * blurred[at]
        + k.y * (blurred[taps.x] + blurred[taps.y])
        + k.z * (blurred[taps.z] + blurred[taps.w]);
    estimate[at] = estimate[at] * c * c;
}

/// The row half of each pixel's neighbourhood range, into the two planes the iterations are done
/// with: a box's minimum is its rows' minima's minimum, so the apply reads a column of these
/// rather than the whole window.
[shader("compute")]
[numthreads(64, 1, 1)]
void sharpen_range(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= params.width * params.height) { return; }
    let taps = row_taps(at % params.width, at / params.width);
    let o = observed[at];
    let a = observed[taps.x];
    let b = observed[taps.y];
    let c = observed[taps.z];
    let d = observed[taps.w];
    blurred[at] = min(o, min(min(a, b), min(c, d)));
    ratio[at] = max(o, max(max(a, b), max(c, d)));
}

/// A sharpened luma held near the range its neighbourhood spanned.
///
/// **Compressed past the range rather than cut at it.** The blend runs past the estimate, so on
/// texture many pixels leave their neighbourhood's range, and a hard clamp pins every one of them
/// to its window's minimum or maximum: skin comes back as two-level patches with hard borders,
/// which reads as a painting. A monotone knee keeps their order, so nothing flattens, while a halo
/// still cannot grow past `overshoot` of the local range.
float limited(float value, float low, float high)
{
    if (params.overshoot <= 0.0) { return clamp(value, low, high); }
    let room = params.overshoot * (high - low) + 1e-6;
    if (value > high) { return high + room * tanh((value - high) / room); }
    if (value < low) { return low - room * tanh((low - value) / room); }
    return value;
}

float code_slope(uint code)
{
    let lo = code > 0 ? code - 1 : 0;
    let hi = min(lo + 1, uint(params.full));
    return (float(hi - lo) / params.full)
        / max(light_of_code[hi] - light_of_code[lo], 1e-12);
}

float noise_at(float3 rgb)
{
    if (noise[NOISE_SHOT] + noise[NOISE_SHOT + 1] + noise[NOISE_SHOT + 2]
            + noise[NOISE_READ] + noise[NOISE_READ + 1] + noise[NOISE_READ + 2] <= 0.0) {
        return 0.0;
    }
    let codes = level_of(rgb);
    let light = float3(
        light_of_code[codes.r],
        light_of_code[codes.g],
        light_of_code[codes.b]);
    let slopes = float3(code_slope(codes.r), code_slope(codes.g), code_slope(codes.b));
    let brightest = max(light.r, max(light.g, light.b));

    float sigma = 0.0;
    [ForceUnroll]
    for (uint camera = 0; camera < 3; camera = camera + 1) {
        let at = NOISE_SENSITIVITY + camera * 3;
        let sensitivity = abs(dot(float3(noise[at], noise[at + 1], noise[at + 2]), slopes));
        let variance = noise[NOISE_SHOT + camera] * brightest + noise[NOISE_READ + camera];
        // Sum, not root-sum-square: demosaic channels share photosites.
        sigma = sigma + sensitivity * sqrt(max(variance, 0.0));
    }
    return sigma;
}

Gain detail_support(float3 rgb, float low, float high)
{
    let sigma = noise_at(rgb);
    if (sigma <= 0.0) { return gain(1.0); }
    let spread = high - low;
    let total = spread * spread;
    let noise_span = SUPPORT_SIGMAS * sigma;
    return gain(max(total - noise_span * noise_span, 0.0) / max(total, 1e-12));
}

/// One pixel's three samples at the sharpened luma.
///
/// **The limit is not optional.** RL converges on the maximum-likelihood inverse, and for a
/// band-limited kernel against a hard edge that solution rings.
float3 sharpened(uint pixel)
{
    let x = pixel % params.width;
    let y = pixel / params.width;

    let column = column_taps(x, y);
    let low = min(blurred[pixel], min(
        min(blurred[column.x], blurred[column.y]),
        min(blurred[column.z], blurred[column.w])));
    let high = max(ratio[pixel], max(
        max(ratio[column.x], ratio[column.y]),
        max(ratio[column.z], ratio[column.w])));

    let p = pixel * 3;
    let rgb = float3(sample_at(p), sample_at(p + 1), sample_at(p + 2));
    let l = observed[pixel];
    let sharp = limited(
        l + params.amount * detail_support(rgb, low, high).g * (estimate[pixel] - l),
        low,
        high);

    // Chroma rides through: the differences are held while luma moves, and green is solved from
    // the luma equation so the recombination cannot move brightness on its own.
    let dr = rgb.r / params.full - l;
    let db = rgb.b / params.full - l;
    let dg = -(params.luma.r * dr + params.luma.b * db) / params.luma.g;
    return (float3(dr, dg, db) + sharp) * params.full;
}

/// The write, a pair of pixels at a time: six samples are exactly three words, owned by nobody
/// else, where one pixel's three would share its last word with a neighbour and race on it.
[shader("compute")]
[numthreads(64, 1, 1)]
void sharpen_apply(uint3 id : SV_DispatchThreadID)
{
    let pair = linear(id);
    let pixels = params.width * params.height;
    let first = pair * 2;
    if (first >= pixels) { return; }

    let a = sharpened(first);
    float3 b = float3(0.0);
    let paired = first + 1 < pixels;
    if (paired) {
        b = sharpened(first + 1);
    }

    store_pair(frame, pair, level_of(a), level_of(b), paired, true);
}
