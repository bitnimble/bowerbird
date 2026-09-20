// The tone curve's evidence: every usable (pixel, channel) of the two fit planes binned twice -
// once by level, for the weighting that stops a frame's dominant brightness deciding the curve, and
// once by the curve's own input, for the weighted mean each of its bins is drawn through.
//
// What crosses back is two sets of partials, not two histograms. A device float add is not
// associative and an atomic one lands in whatever order the lanes did, so two fits of one
// photograph would draw different curves; instead each thread owns a contiguous run of pixels,
// accumulates it serially into a slice of its own, and the host folds the threads in order and in
// f64. `fit_score::folded` records the same trade.
//
// The solve stays on the host. It is `pool_violators`, a knot fit and a monotone pass over 256 bins
// - arithmetic, not arithmetic over pixels - and it wants f64.

import prelude;

struct Params {
    int pixels;
    /// Pixels one thread walks, and how many threads that makes.
    int block;
    int blocks;
    int bins;
    int level_bins;
    /// The top of the curve's domain, which both binnings are fractions of.
    float ceiling;
    /// `LEVEL_BALANCE_LIMIT`: how far parity may push one level's weight, either way.
    float level_limit;
    /// Whether the camera's rendering has the fitted matrix undone from it first, so what the
    /// curve is asked to reproduce is only the part a tone curve can.
    int inverted;
    /// Where `fit_pairs.slang` put the censused hue in the same word as the mask.
    int hue_shift;
    /// A row to a `float4`, which is what std140 gives a `float3x3` anyway.
    float4 inverse[3];
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Our own render, interleaved f32 RGB, in multiples of diffuse white.
[vk::binding(0, 0)] StructuredBuffer<float> render;
/// The camera's rendering of the same pixel, in the same primaries.
[vk::binding(1, 0)] StructuredBuffer<float> jpeg;
/// The mask each pixel earned in the low three bits, and the hue it was censused into above them.
[vk::binding(2, 0)] StructuredBuffer<uint> bits;
/// What a pixel counts for, by the hue bucket it was censused into: `hdr_fit::hue_balance`.
[vk::binding(3, 0)] StructuredBuffer<float> hue_weights;
/// `blocks * level_bins`: each thread's weight per level.
[vk::binding(4, 0)] RWStructuredBuffer<float> levels;
/// `level_bins`: what each level's weight is scaled by, once every thread has counted.
[vk::binding(5, 0)] RWStructuredBuffer<float> weights;
/// `blocks * bins * 3`: each thread's coded sum, weight and count per curve bin.
[vk::binding(6, 0)] RWStructuredBuffer<float> partials;

/// Which channels a pixel is usable for at all.
static const uint CHANNELS = 7;

int2 span_of(int b)
{
    let first = b * pc.block;
    return int2(first, min(first + pc.block, pc.pixels));
}

/// What the curve is asked to reproduce at this pixel: the camera's rendering, with the fitted
/// matrix undone from it where there is one.
///
/// Clamped, because inverting a matrix out of a colour near the edge of what the camera can print
/// can ask for a negative amount of a channel.
float3 target_at(int p)
{
    let v = float3(jpeg[p * 3], jpeg[p * 3 + 1], jpeg[p * 3 + 2]);
    if (pc.inverted == 0) { return v; }
    return max(float3(
        dot(pc.inverse[0].xyz, v),
        dot(pc.inverse[1].xyz, v),
        dot(pc.inverse[2].xyz, v)), float3(0.0));
}

/// Which level band an input falls in, on the square root the lattice's own level axis uses.
int level_of(float x)
{
    let t = sqrt(max(x, 0.0) / max(pc.ceiling, 1e-9));
    return min(int(t * float(pc.level_bins)), pc.level_bins - 1);
}

/// Each thread's weight per level, over the run it owns.
[shader("compute")]
[numthreads(64, 1, 1)]
void fit_curve_levels(uint3 id: SV_DispatchThreadID)
{
    let b = int(id.x);
    if (b >= pc.blocks) { return; }
    let span = span_of(b);
    let base = b * pc.level_bins;
    for (int p = span.x; p < span.y; p++) {
        let mask = bits[p];
        if ((mask & CHANNELS) == 0) { continue; }
        let w = hue_weights[mask >> uint(pc.hue_shift)];
        for (int c = 0; c < 3; c++) {
            if ((mask & (1u << uint(c))) == 0) { continue; }
            levels[base + level_of(render[p * 3 + c])] += w;
        }
    }
}

/// What each level's weight is scaled by, so the shadows are not fitted at whatever slope the
/// bright end leaves them.
///
/// One invocation, folding the threads in their own order: the sum has to be the same one twice.
/// Bounded like the hue weighting and for the same reason, a level reached by a handful of pairs
/// being noise rather than a measurement.
[shader("compute")]
[numthreads(1, 1, 1)]
void fit_curve_weights()
{
    var total = 0.0;
    var occupied = 0;
    for (int bin = 0; bin < pc.level_bins; bin++) {
        var counted = 0.0;
        for (int b = 0; b < pc.blocks; b++) {
            counted += levels[b * pc.level_bins + bin];
        }
        weights[bin] = counted;
        total += counted;
        if (counted > 0.0) { occupied++; }
    }
    let parity = total / float(max(occupied, 1));
    for (int bin = 0; bin < pc.level_bins; bin++) {
        let counted = weights[bin];
        weights[bin] = counted > 0.0
            ? clamp(parity / counted, 1.0 / pc.level_limit, pc.level_limit)
            : 1.0;
    }
}

/// Each thread's coded sum, weight and count per curve bin, over the run it owns.
///
/// Averaged through the transfer a viewer sees, not in light. Within a bin every pair sits at
/// nearly the same input, so the spread is all in the camera's answer - and a mean in light is
/// pulled by the brightest members of it, which is not where the middle of what a reader sees lies.
[shader("compute")]
[numthreads(64, 1, 1)]
void fit_curve_bins(uint3 id: SV_DispatchThreadID)
{
    let b = int(id.x);
    if (b >= pc.blocks) { return; }
    let span = span_of(b);
    let base = b * pc.bins;
    for (int p = span.x; p < span.y; p++) {
        let mask = bits[p];
        if ((mask & CHANNELS) == 0) { continue; }
        let want = target_at(p);
        for (int c = 0; c < 3; c++) {
            if ((mask & (1u << uint(c))) == 0) { continue; }
            let x = render[p * 3 + c];
            let w = hue_weights[mask >> uint(pc.hue_shift)] * weights[level_of(x)];
            let bin = clamp(int(round(x / pc.ceiling * float(pc.bins - 1))), 0, pc.bins - 1);
            let at = (base + bin) * 3;
            partials[at] += srgb_oetf(clamp(want[c], 0.0, 1.0)) * w;
            partials[at + 1] += w;
            partials[at + 2] += 1.0;
        }
    }
}
