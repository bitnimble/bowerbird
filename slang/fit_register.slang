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
import prelude;

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
    let i = (y * pc.wide_width + x) * 3;
    return float3(plane[i], plane[i + 1], plane[i + 2]);
}

/// A colour read at a matched location: the box mean around it.
float3 sample_at(StructuredBuffer<float> plane, int x, int y)
{
    var sum = float3(0.0);
    for (int dy = -pc.sample; dy <= pc.sample; dy++) {
        for (int dx = -pc.sample; dx <= pc.sample; dx++) {
            sum += rgb_at(plane, x + dx, y + dy);
        }
    }
    let side = float(2 * pc.sample + 1);
    return sum / (side * side);
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
    var mine = sample_at(ours, x, y);
    // The falloff is not in the wide render, and it has to be on before the sample is compared with
    // the camera's: a corner read without it is dark by however much the lens cost, and the fit
    // would take that darkness for a colour.
    if (pc.falloff != 0) {
        let dx = float(x) - float(pc.wide_width) * 0.5;
        let dy = float(y) - float(pc.wide_height) * 0.5;
        mine *= gains[int(min(sqrt(dx * dx + dy * dy) / pc.half * 255.0, 255.0))];
    }
    // Rounded, the offsets being sub-pixel since `correspond.slang` reads the peak between whole
    // ones: this takes a sample rather than resampling, and the nearest is the one it means.
    let target = sample_at(theirs, x + int(round(found[4 * p])), y + int(round(found[4 * p + 1])));

    render[p * 3] = mine.x;
    render[p * 3 + 1] = mine.y;
    render[p * 3 + 2] = mine.z;
    jpeg[p * 3] = target.x;
    jpeg[p * 3 + 1] = target.y;
    jpeg[p * 3 + 2] = target.z;
}
