// A demosaiced frame at twice the photo's resolution back to the photo's own, through Lanczos-3:
// what Sharpen's Quality hands the coding after the upscaler and RCD ran at 2x.
//
// In the demosaic's linear light, so a highlight weighs what it is. The kernel is Lanczos-3
// stretched by 2: twelve taps each way centred between the two source pixels an output pixel
// covers, mirrored at the frame's edges.

import lanes;
import packed;
import px;

struct Halving {
    uint2 source;
    uint2 size;
};

[vk::binding(0, 0)] ConstantBuffer<Halving> halving;
[vk::binding(1, 0)] StructuredBuffer<uint> frame;
[vk::binding(2, 0)] RWStructuredBuffer<uint> smaller;

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
    let pixel = wide_at<Drawn>(uint(mirrored(x, int(halving.source.x))), uint(mirrored(y, int(halving.source.y))),
        measured<Drawn>(halving.source.x));
    let first = pixel * 3;
    return float3(
        float(half_of(frame[first / 2], first)),
        float(half_of(frame[(first + 1) / 2], first + 1)),
        float(half_of(frame[(first + 2) / 2], first + 2)));
}

float3 halved(uint2 at)
{
    float weights[2 * REACH];
    float total = 0.0;
    [ForceUnroll]
    for (int k = 0; k < 2 * REACH; k++) {
        weights[k] = lanczos3((float(k - REACH) + 0.5) / 2.0);
        total += weights[k];
    }
    let left = int(at.x) * 2 - REACH + 1;
    let top = int(at.y) * 2 - REACH + 1;
    var sum = float3(0.0);
    for (int j = 0; j < 2 * REACH; j++) {
        var row = float3(0.0);
        for (int i = 0; i < 2 * REACH; i++) {
            row += weights[i] * light_at(left + i, top + j);
        }
        sum += weights[j] * row;
    }
    return sum / (total * total);
}

uint3 codes(float3 light)
{
    return uint3(clamp(round(light), float3(0.0), float3(65535.0)));
}

[shader("compute")]
[numthreads(64, 1, 1)]
void halve_lanczos(uint3 id : SV_DispatchThreadID)
{
    let pair = linear(id);
    let pixels = halving.size.x * halving.size.y;
    let first = pair * 2;
    if (first >= pixels) { return; }
    let a = halved(uint2(first % halving.size.x, first / halving.size.x));
    let paired = first + 1 < pixels;
    var b = float3(0.0);
    if (paired) { b = halved(uint2((first + 1) % halving.size.x, (first + 1) / halving.size.x)); }
    store_pair(smaller, wide<Drawn>(first), codes(a), codes(b), paired, false);
}
