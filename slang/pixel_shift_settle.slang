// Settle the gathered burst against the reference's RCD where frames move or coverage thins.
// Twice the weighted spread of two tripod greens is their absolute difference, so the same
// motion test also reads a handheld burst's many fractional green contributions.

import px;
import light;

static const float MOVED_FROM = 4.0;
static const float MOVED_AT = 8.0;
// Sensor travel is never exactly one photosite; on a hard edge that alone exceeds the noise.
static const float REGISTRATION = 0.03;

struct Params {
    uint width;
    uint height;
    uint left;
    uint top;
    uint region_width;
    uint region_height;
    float alpha;
    float sigma_sq;
    uint reach;
    uint pad0;
    uint pad1;
    uint pad2;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<float> sums;
[vk::binding(2, 0)] StructuredBuffer<float> weights;
[vk::binding(3, 0)] StructuredBuffer<float> greens;
[vk::binding(4, 0)] RWStructuredBuffer<float> rgb;

float moved_at(int r, int c)
{
    let site = (uint(r) * params.region_width + uint(c)) * 3;
    let weight = greens[site];
    if (weight <= 0.0) { return 0.0; }
    let mean = greens[site + 1] / weight;
    let variance = max(greens[site + 2] / weight - mean * mean, 0.0);
    let moved = 2.0 * sqrt(variance);
    let spread = sqrt(2.0 * max(params.alpha * mean + params.sigma_sq, 0.0))
        + REGISTRATION * max(mean, 0.0) + 1e-6;
    return smoothstep(MOVED_FROM, MOVED_AT, moved / spread);
}

[shader("compute")]
[numthreads(8, 8, 1)]
void settle(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.width || gid.y >= params.height) { return; }
    let r = int(params.top + gid.y);
    let c = int(params.left + gid.x);
    float moved = 0.0;
    let reach = measured<Sensor>(params.reach).n;
    for (int dy = -int(reach); dy <= int(reach); dy++) {
        for (int dx = -int(reach); dx <= int(reach); dx++) {
            let rr = clamp(r + dy, 0, int(params.region_height) - 1);
            let cc = clamp(c + dx, 0, int(params.region_width) - 1);
            moved = max(moved, moved_at(rr, cc));
        }
    }
    let here = (gid.y * params.width + gid.x) * 3;
    let from = (uint(r) * params.region_width + uint(c)) * 3;
    let covered = min(min(weights[from], weights[from + 1] * 0.5), weights[from + 2]);
    let confidence = (1.0 - moved) * clamp(covered, 0.0, 1.0);
    for (uint channel = 0; channel < 3; channel++) {
        let weight = weights[from + channel];
        let merged = measured<Level>(weight > 0.0 ? sums[from + channel] / weight : rgb[here + channel]);
        let baseline = measured<Level>(rgb[here + channel]);
        rgb[here + channel] = measured<Level>(lerp(baseline.v, merged.v, confidence)).v;
    }
}
