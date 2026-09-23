// Where a pixel shift's frames disagree - the scene moved between them - the reference frame's own
// demosaic in place of the merge.
//
// **A site's two greens are the test.** They come from two different frames, and with the sensor
// where the burst says it was they read one scene point, so they differ by noise alone. Beyond it
// the scene moved, and a merge there interleaves two pictures into a checkerboard.

struct Params {
    /// The RCD tile being settled, and where it sits in the merged region.
    uint width;
    uint height;
    uint left;
    uint top;
    uint region_width;
    uint region_height;
    /// The reference's noise, `galosh::NoiseModel`: a photosite at `x` varies by `alpha * x + sigma_sq`.
    float alpha;
    float sigma_sq;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<float> merged;
[vk::binding(2, 0)] StructuredBuffer<float> disagreement;
[vk::binding(3, 0)] RWStructuredBuffer<float> rgb;

/// Photosites past a disagreeing one that also fall back, so a moving edge takes its fringe with it.
static const int REACH = 2;
/// The disagreement, in its own noise's deviations, where a site starts and finishes falling back.
static const float MOVED_FROM = 4.0;
static const float MOVED_AT = 8.0;
/// How far two greens of one still scene point may differ as a share of their level: the sensor's
/// travel is never exactly one photosite, and on a hard edge that alone is more than the noise.
static const float REGISTRATION = 0.03;

float moved_at(int r, int c)
{
    let site = uint(r) * params.region_width + uint(c);
    let green = max(merged[site * 3 + 1], 0.0);
    let spread = sqrt(2.0 * max(params.alpha * green + params.sigma_sq, 0.0)) + REGISTRATION * green + 1e-6;
    return smoothstep(MOVED_FROM, MOVED_AT, abs(disagreement[site]) / spread);
}

[shader("compute")]
[numthreads(8, 8, 1)]
void settle(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.width || gid.y >= params.height) { return; }
    let r = int(params.top + gid.y);
    let c = int(params.left + gid.x);
    float moved = 0.0;
    for (int dy = -REACH; dy <= REACH; dy++) {
        for (int dx = -REACH; dx <= REACH; dx++) {
            let rr = clamp(r + dy, 0, int(params.region_height) - 1);
            let cc = clamp(c + dx, 0, int(params.region_width) - 1);
            moved = max(moved, moved_at(rr, cc));
        }
    }
    let here = (gid.y * params.width + gid.x) * 3;
    let from = (uint(r) * params.region_width + uint(c)) * 3;
    for (uint channel = 0; channel < 3; channel++) {
        rgb[here + channel] = lerp(merged[from + channel], rgb[here + channel], moved);
    }
}
