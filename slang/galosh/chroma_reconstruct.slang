import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> c1_coarse;
[vk::binding(1, 0)] StructuredBuffer<float> c2_coarse;
[vk::binding(2, 0)] StructuredBuffer<float> c3_coarse;
[vk::binding(3, 0)] StructuredBuffer<float> c1_guide;
[vk::binding(4, 0)] StructuredBuffer<float> c2_guide;
[vk::binding(5, 0)] StructuredBuffer<float> c3_guide;
[vk::binding(6, 0)] RWStructuredBuffer<float> c1_out;
[vk::binding(7, 0)] RWStructuredBuffer<float> c2_out;
[vk::binding(8, 0)] RWStructuredBuffer<float> c3_out;

struct Push {
    int fine_width;
    int fine_height;
    int coarse_width;
    int coarse_height;
    float guide_noise;
    float reach;
    float green_sign;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(16, 16, 1)]
void chroma_reconstruct(uint3 id : SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.fine_width || y >= pc.fine_height) { return; }

    let p = y * pc.fine_width + x;
    let guide = float3(c1_guide[p], c2_guide[p], c3_guide[p]);
    if (pc.coarse_width <= 0 || pc.coarse_height <= 0) {
        c1_out[p] = guide.x;
        c2_out[p] = guide.y;
        c3_out[p] = guide.z;
        return;
    }
    let at = (float2(x, y) + 0.5) * 0.5 - 0.5;
    let base = int2(floor(at));
    let fraction = at - float2(base);
    let sigma = pc.reach * pc.guide_noise / float(2 * COLOUR_GUIDE_RADIUS.n + 1);
    let inv_variance = 1.0 / max(4.0 * sigma * sigma, 1e-10);
    var correction = float3(0.0);
    for (int dy = 0; dy < 2; dy++) {
        let cy = clamp(base.y + dy, 0, pc.coarse_height - 1);
        let wy = dy == 0 ? 1.0 - fraction.y : fraction.y;
        for (int dx = 0; dx < 2; dx++) {
            let cx = clamp(base.x + dx, 0, pc.coarse_width - 1);
            let wx = dx == 0 ? 1.0 - fraction.x : fraction.x;
            let cp = cy * pc.coarse_width + cx;
            let delta = float3(c1_coarse[cp], c2_coarse[cp], c3_coarse[cp]) - guide;
            let colour = colour_axes(delta, pc.green_sign);
            let confidence = exp(-dot(colour, colour) * inv_variance);
            correction += wx * wy * confidence * delta;
        }
    }
    let result = guide + correction;
    c1_out[p] = result.x;
    c2_out[p] = result.y;
    c3_out[p] = result.z;
}
