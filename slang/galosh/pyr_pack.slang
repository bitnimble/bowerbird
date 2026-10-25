// The stabilised mosaic as the pyramid's first two levels: every 2x2 site through the
// Walsh-Hadamard transform, and the 2x2 box of those sites beside it.
import pyramid;
import prelude;
import "../light.slang";

/// The stabilised mosaic, or with `FROM_RAW` the conditioned one, stabilised here.
[vk::binding(0, 0)] StructuredBuffer<float> mosaic;
[vk::binding(1, 0)] RWStructuredBuffer<float> sites;
[vk::binding(2, 0)] RWStructuredBuffer<float> below;
[vk::binding(3, 0)] StructuredBuffer<float> params;

struct Push {
    int width;
    int height;
    int w0;
    int h0;
    int w1;
    int h1;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

/// Whether `mosaic` is the conditioned mosaic, stabilised here.
[vk::constant_id(0)]
const int FROM_RAW = 0;

float stabilised(int x, int y)
{
    let value = mosaic[y * pc.width + x];
    if (FROM_RAW == 0) { return value; }
    Gain sample;
    sample.g = value;
    let slot = (y & 1) | ((x & 1) << 1);
    return gat_forward(sample, params[P_ALPHA], params[P_SIGMA_SQ]) * params[P_INV_SG]
        - params[P_DARK_REF0 + slot];
}

float4 site_at(int x, int y)
{
    let a = stabilised(2 * x, 2 * y);
    let b = stabilised(2 * x + 1, 2 * y);
    let c = stabilised(2 * x, 2 * y + 1);
    let d = stabilised(2 * x + 1, 2 * y + 1);
    return 0.5 * float4(a + b + c + d, a - b + c - d, a + b - c - d, a - b - c + d);
}

[shader("compute")]
[numthreads(16, 16, 1)]
void pyr_pack(uint3 id : SV_DispatchThreadID)
{
    let cx = int(id.x);
    let cy = int(id.y);
    if (cx >= pc.w1 || cy >= pc.h1) { return; }

    var mean = float4(0.0);
    for (int j = 0; j < 2; j++) {
        for (int i = 0; i < 2; i++) {
            let x = 2 * cx + i;
            let y = 2 * cy + j;
            let site = site_at(min(x, pc.w0 - 1), min(y, pc.h0 - 1));
            mean += site;
            if (x < pc.w0 && y < pc.h0) {
                for (int p = 0; p < PLANES; p++) {
                    sites[at_plane(p, x, y, pc.w0, pc.h0)] = site[p];
                }
            }
        }
    }
    for (int p = 0; p < PLANES; p++) {
        below[at_plane(p, cx, cy, pc.w1, pc.h1)] = 0.25 * mean[p];
    }
}
