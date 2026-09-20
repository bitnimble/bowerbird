// The frame's own edge spread, which is the blur the deconvolution is asked to invert.
//
// A step edge imaged through a Gaussian point spread comes back as its integral, and the distance
// between the 10% and the 90% of that is 2.563 sigma - so the sharpest edges in a photograph
// measure the optics directly, a scene edge being able to be softer than the point spread but
// never harder. Every near-vertical transition that rises without pause over at most eight
// samples votes its 10-90 distance into a histogram; the host takes the sharpest decile rather
// than the narrowest, which one noise spike would own.
//
// **In linear light, and after the demosaic**, which is what makes the number mean something. The
// 10-90 of an integrated Gaussian is 2.563 sigma in *intensity*; a coded frame's curve moves both
// crossings and the constant stops holding. And the interpolation is part of the blur the sharpen
// meets, so measuring on the mosaic - where the green lattice is two pixels apart and a 1.8 pixel
// rise cannot be resolved at all - would answer a different question badly.
import packed;

/// Widths span 0 to SPAN_CEIL pixels across BINS even bins; the host mirrors both to turn a bin
/// back into a sigma.
static const uint BINS = 256;
static const float SPAN_CEIL = 8.0;

/// How far a run may climb before it stops being one edge. The stencil either side of it is what
/// keeps the border out of the dispatch.
static const uint RUN = 8;

/// What a transition has to be before its shape is the optics rather than the grain: a fraction of
/// the level it climbs to, and a floor under that so a black frame's noise votes nothing.
static const float CONTRAST = 0.3;
static const float FLOOR = 0.02;

/// How far the samples behind a run may stray from its foot, as a fraction of the step it climbs.
///
/// **A rise has to be entered at its foot or its width is measured short.** Rejecting only a
/// *descending* approach is not enough: a start partway up the rise has a lower sample behind it
/// and is accepted, and it then measures a truncated slice of the same edge. Those votes are
/// narrower than the truth, and since the host reads the *sharpest* decile they are exactly the
/// ones the answer comes from - measured on a step blurred at 0.7, admitting them reads 0.591.
static const float SETTLED = 0.05;

struct Params {
    uint width;
    uint height;
    float3 luma;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] RWStructuredBuffer<uint> frame;
[vk::binding(2, 0)] RWStructuredBuffer<Atomic<uint> > histogram;

float sample_at(uint at)
{
    return float(half_of(frame[at / 2], at));
}

/// `image::luma709`, normalised the same way round: the weights sum first and the divide comes
/// after, or this and the CPU round differently.
float luma_at(uint x, uint y)
{
    let p = (y * params.width + x) * 3;
    return dot(params.luma, float3(sample_at(p), sample_at(p + 1), sample_at(p + 2))) / 65535.0;
}

/// Where the profile first crosses a level, in samples from `x`, or -1 where it does not.
float crossing(uint x, uint y, uint end, float want)
{
    for (uint n = 0; n < end; n++) {
        let a = luma_at(x + n, y);
        let b = luma_at(x + n + 1, y);
        if (a <= want && want <= b) { return float(n) + (want - a) / max(b - a, 1e-9); }
    }
    return -1.0;
}

[shader("compute")]
[numthreads(16, 16, 1)]
void edge_spread(uint3 id : SV_DispatchThreadID)
{
    let x = id.x + 2;
    let y = id.y;
    if (y >= params.height || x + RUN + 2 >= params.width) { return; }

    // A run that climbs without pause, with a settled level behind it - so one side of a ridge is
    // not read as an edge, and the rise that is measured is the whole of it.
    uint end = 0;
    for (uint n = 1; n <= RUN; n++) {
        if (luma_at(x + n + 1, y) <= luma_at(x + n, y)) { end = n; break; }
    }
    if (end < 2) { return; }

    let low = luma_at(x, y);
    let high = luma_at(x + end, y);
    let step = high - low;
    if (step < FLOOR || step < CONTRAST * high) { return; }
    // Flat behind the foot, not merely not-descending: see `SETTLED`.
    let behind = luma_at(x - 1, y);
    if (abs(behind - low) > SETTLED * step) { return; }
    if (abs(luma_at(x - 2, y) - behind) > SETTLED * step) { return; }

    let lo = crossing(x, y, end, low + step * 0.1);
    let hi = crossing(x, y, end, low + step * 0.9);
    if (lo < 0.0 || hi < lo) { return; }

    let bin = uint(clamp((hi - lo) * float(BINS) / SPAN_CEIL, 0.0, float(BINS) - 1.0));
    histogram[bin].add(1);
}
