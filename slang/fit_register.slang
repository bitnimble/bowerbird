// The two fit-grid planes resampled onto found correspondence rather than assumed alignment.
//
// Same grid and same indices as the prefiltered planes it replaces, so every stage that reads a pair
// keeps reading it the same way. What changes is that pixel `p` now holds two views of one point in
// the *scene* rather than two views of one coordinate; `hdr_fit::registered` has why that is worth a
// pass of its own.
//
// A position the search could not act on is left alone, the caller having filled both planes with
// the prefiltered ones first: blur is a poor answer to misregistration but it is a bounded one,
// where a sharp read at an unverified location is not.
import block_split;
import prelude;
import px;

struct Params {
    int width;
    int height;
    /// The wide planes both samples are read from, `scale` times the grid across.
    int wide_width;
    int wide_height;
    int scale;
    /// Taps either side of a sample's centre.
    int sample;
    /// Zero where the lens has no falloff; otherwise `gains` holds one per radius bucket.
    int falloff;
    /// Half the wide plane's diagonal, which the radius bucket is a fraction of.
    float half;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// The warped render at the wide grid, interleaved f32 RGB, without its falloff.
[vk::binding(0, 0)] StructuredBuffer<float> ours;
/// The camera's preview, linearised, at the same grid.
[vk::binding(1, 0)] StructuredBuffer<float> theirs;
/// Four floats a grid position: dx, dy, peak, and which of the three outcomes the search reached.
[vk::binding(2, 0)] StructuredBuffer<float> found;
/// `fit::Gain::at` per radius bucket, 256 of them.
[vk::binding(3, 0)] StructuredBuffer<float> gains;
[vk::binding(4, 0)] RWStructuredBuffer<float> render;
[vk::binding(5, 0)] RWStructuredBuffer<float> jpeg;

float3 rgb_at(StructuredBuffer<float> plane, int x, int y)
{
    let i = wide_at<FitPlane>(x, y, measured<FitPlane>(pc.wide_width)) * 3;
    return float3(plane[i], plane[i + 1], plane[i + 2]);
}

/// Our tap at `(dx, dy)` about `(x, y)`, where the split reads it.
float3 split_at(int x, int y, int dx, int dy)
{
    return split_space(rgb_at(ours, x + dx, y + dy), 1.0);
}

/// A matched location's two colours, ours about `(x, y)` and the camera's about `(cx, cy)`.
///
/// The box mean around it, or, where our taps hold two colours (`block_split.slang`), the mean of
/// the half the centre belongs to. The camera's taps are split where ours are, tap for tap, so the
/// pair stays one population on both sides: a pair across an edge teaches the colour on its
/// centre's side of it, which is the colour the render reads that side's pixels at, rather than a
/// mix of the two that the frame does not hold.
void sample_at(int x, int y, int cx, int cy, out float3 mine, out float3 target)
{
    let taps = float((2 * pc.sample + 1) * (2 * pc.sample + 1));
    Seeds seeds;
    seeds_begin(seeds);
    for (int dy = -pc.sample; dy <= pc.sample; dy++) {
        for (int dx = -pc.sample; dx <= pc.sample; dx++) {
            seeds_add(seeds, split_at(x, y, dx, dy));
        }
    }
    float3 first;
    float3 second;
    seeds_pick(seeds, first, second);

    var ours_by_half = float3x3(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    var theirs_by_half = float3x3(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    var counts = float2(0.0);
    var scatter = 0.0;
    for (int round = 0; round <= SETTLE; round++) {
        var into_first = float4(0.0);
        var into_second = float4(0.0);
        ours_by_half = float3x3(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        theirs_by_half = float3x3(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        scatter = 0.0;
        for (int dy = -pc.sample; dy <= pc.sample; dy++) {
            for (int dx = -pc.sample; dx <= pc.sample; dx++) {
                let v = split_at(x, y, dx, dy);
                let to_first = length(v - first);
                let to_second = length(v - second);
                let half = to_first <= to_second ? 0 : 1;
                if (half == 0) {
                    into_first += float4(v, 1.0);
                    scatter += to_first * to_first;
                } else {
                    into_second += float4(v, 1.0);
                    scatter += to_second * to_second;
                }
                ours_by_half[half] += rgb_at(ours, x + dx, y + dy);
                theirs_by_half[half] += rgb_at(theirs, cx + dx, cy + dy);
            }
        }
        counts = float2(into_first.a, into_second.a);
        if (round == SETTLE) { break; }
        let next_first = into_first.a > 0.0 ? into_first.rgb / into_first.a : first;
        let next_second = into_second.a > 0.0 ? into_second.rgb / into_second.a : second;
        // Settled: every later round would repeat this one exactly.
        if (all(next_first == first) && all(next_second == second)) { break; }
        first = next_first;
        second = next_second;
    }

    mine = (ours_by_half[0] + ours_by_half[1]) / taps;
    target = (theirs_by_half[0] + theirs_by_half[1]) / taps;
    if (counts.x <= 0.0 || counts.y <= 0.0) { return; }
    let trusted = split_weight(
        length(first - second), sqrt(scatter / taps), min(counts.x, counts.y),
        float(2 * pc.sample + 1));
    let axis = second - first;
    let along = dot(split_at(x, y, 0, 0) - first, axis) / max(dot(axis, axis), 1e-6);
    let own = smoothstep(0.25, 0.75, along);
    mine = lerp(mine, lerp(ours_by_half[0] / counts.x, ours_by_half[1] / counts.y, own), trusted);
    target = lerp(
        target, lerp(theirs_by_half[0] / counts.x, theirs_by_half[1] / counts.y, own), trusted);
}

[shader("compute")]
[numthreads(16, 16, 1)]
void fit_register(uint3 id: SV_DispatchThreadID)
{
    let gx = int(id.x);
    let gy = int(id.y);
    if (gx >= pc.width || gy >= pc.height) { return; }
    let p = gy * pc.width + gx;
    if (found[4 * p + 3] < 0.0) { return; }

    let x = gx * pc.scale;
    let y = gy * pc.scale;
    // Rounded, the offsets being sub-pixel since `correspond.slang` reads the peak between whole
    // ones: this takes a sample rather than resampling, and the nearest is the one it means.
    float3 mine;
    float3 target;
    sample_at(x, y, x + int(round(found[4 * p])), y + int(round(found[4 * p + 1])), mine, target);
    // The falloff is not in the wide render, and it has to be on before the sample is compared with
    // the camera's: a corner read without it is dark by however much the lens cost, and the fit
    // would take that darkness for a colour.
    if (pc.falloff != 0) {
        let dx = float(x) - float(pc.wide_width) * 0.5;
        let dy = float(y) - float(pc.wide_height) * 0.5;
        mine *= gains[int(min(sqrt(dx * dx + dy * dy) / pc.half * 255.0, 255.0))];
    }

    let i = wide<FitPlane>(p) * 3;
    render[i] = mine.x;
    render[i + 1] = mine.y;
    render[i + 2] = mine.z;
    jpeg[i] = target.x;
    jpeg[i + 1] = target.y;
    jpeg[i + 2] = target.z;
}
