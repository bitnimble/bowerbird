// RCD's plane of an upscale back to the photo's own resolution, through Lanczos-3: what the colour
// pass reads in place of a demosaic when the upscaler made the mosaic.
//
// In the demosaic's linear light, so a highlight weighs what it is. The kernel is Lanczos-3
// stretched by 2: twelve taps each way centred between the two source pixels an output pixel
// covers, mirrored at the plane's edges, which only a tile's halo reaches.

import lanes;
import px;

struct Halving {
    uint2 source;
    uint2 size;
};

[vk::binding(0, 0)] ConstantBuffer<Halving> halving;
[vk::binding(1, 0)] StructuredBuffer<float> plane;
[vk::binding(2, 0)] RWStructuredBuffer<float> smaller;

static const int REACH = 6;
static const float PI = 3.14159265358979;

float lanczos3(float x)
{
    if (abs(x) < 1e-6) { return 1.0; }
    if (abs(x) >= 3.0) { return 0.0; }
    let px = PI * x;
    return 3.0 * sin(px) * sin(px / 3.0) / (px * px);
}

int mirrored(int at, int extent)
{
    let reflected = at < 0 ? -at - 1 : at;
    return reflected >= extent ? 2 * extent - reflected - 1 : reflected;
}

float3 light_at(int x, int y)
{
    let first = wide_at<Sensor>(uint(mirrored(x, int(halving.source.x))), uint(mirrored(y, int(halving.source.y))),
        measured<Sensor>(halving.source.x)) * 3;
    return float3(plane[first], plane[first + 1], plane[first + 2]);
}

[shader("compute")]
[numthreads(64, 1, 1)]
void halve_lanczos(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= halving.size.x * halving.size.y) { return; }
    let x = at % halving.size.x;
    let y = at / halving.size.x;
    float weights[2 * REACH];
    float total = 0.0;
    [ForceUnroll]
    for (int k = 0; k < 2 * REACH; k++) {
        weights[k] = lanczos3((float(k - REACH) + 0.5) / 2.0);
        total += weights[k];
    }
    let left = int(x) * 2 - REACH + 1;
    let top = int(y) * 2 - REACH + 1;
    var sum = float3(0.0);
    for (int j = 0; j < 2 * REACH; j++) {
        var row = float3(0.0);
        for (int i = 0; i < 2 * REACH; i++) {
            row += weights[i] * light_at(left + i, top + j);
        }
        sum += weights[j] * row;
    }
    let light = sum / (total * total);
    let out = wide_at<Sensor>(x, y, measured<Sensor>(halving.size.x)) * 3;
    smaller[out] = light.x;
    smaller[out + 1] = light.y;
    smaller[out + 2] = light.z;
}
