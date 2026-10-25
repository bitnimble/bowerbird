// The stabilised mosaic as the pyramid's first two levels: every site through its transform, and
// the 2x2 box of those sites beside it.
import pyramid;
import prelude;
import "../light.slang";
import "../times.slang";

/// The stabilised mosaic, or with `FROM_RAW` the conditioned one, stabilised here.
[vk::binding(0, 0)] StructuredBuffer<float> mosaic;
[vk::binding(1, 0)] RWStructuredBuffer<float> sites;
[vk::binding(2, 0)] RWStructuredBuffer<float> below;
[vk::binding(3, 0)] StructuredBuffer<float> params;
[vk::binding(9, 0)] StructuredBuffer<float> transform;

[vk::binding(20, 0)] ConstantBuffer<Sites> pc;

/// Whether `mosaic` is the conditioned mosaic, stabilised here.
[vk::constant_id(0)]
const int FROM_RAW = 0;

float stabilised(int x, int y)
{
    let value = mosaic[min(y, pc.height - 1) * pc.width + min(x, pc.width - 1)];
    if (FROM_RAW == 0) { return value; }
    Gain sample;
    sample.g = value;
    let slot = (y & 1) | ((x & 1) << 1);
    return gat_forward(sample, params[P_ALPHA], params[P_SIGMA_SQ]) / params[P_UNIFIED_SIGMA]
        - params[P_DARK_REF0 + slot];
}

void site_at<let SIDE : int>(int x, int y, out float site[MAX_PLANES])
{
    float photosites[MAX_PLANES];
    [ForceUnroll]
    for (int k = 0; k < SIDE * SIDE; k++) {
        photosites[k] = stabilised(times(x, SIDE) + k % SIDE, times(y, SIDE) + k / SIDE);
    }
    let rows = transform_at(x, y, pc.across, pc.down);
    [ForceUnroll]
    for (int p = 0; p < SIDE * SIDE; p++) {
        var sum = 0.0;
        [ForceUnroll]
        for (int k = 0; k < SIDE * SIDE; k++) {
            sum += transform[rows + p * MAX_PLANES + k] * photosites[k];
        }
        site[p] = sum;
    }
}

void pack<let SIDE : int>(int cx, int cy)
{
    float mean[MAX_PLANES];
    [ForceUnroll]
    for (int p = 0; p < SIDE * SIDE; p++) { mean[p] = 0.0; }
    [ForceUnroll]
    for (int j = 0; j < 2; j++) {
        [ForceUnroll]
        for (int i = 0; i < 2; i++) {
            let x = 2 * cx + i;
            let y = 2 * cy + j;
            float site[MAX_PLANES];
            site_at<SIDE>(min(x, pc.w0 - 1), min(y, pc.h0 - 1), site);
            [ForceUnroll]
            for (int p = 0; p < SIDE * SIDE; p++) { mean[p] += site[p]; }
            if (x < pc.w0 && y < pc.h0) {
                [ForceUnroll]
                for (int p = 0; p < SIDE * SIDE; p++) {
                    sites[at_plane(p, x, y, pc.w0, pc.h0)] = site[p];
                }
            }
        }
    }
    [ForceUnroll]
    for (int p = 0; p < SIDE * SIDE; p++) {
        below[at_plane(p, cx, cy, pc.w1, pc.h1)] = 0.25 * mean[p];
    }
}

[shader("compute")]
[numthreads(16, 16, 1)]
void pyr_pack(uint3 id : SV_DispatchThreadID)
{
    let cx = int(id.x);
    let cy = int(id.y);
    if (cx >= pc.w1 || cy >= pc.h1) { return; }
    // Unrolled per side, so every array index is a constant and the arrays stay in registers.
    if (pc.side == 2) {
        pack<2>(cx, cy);
    } else {
        pack<3>(cx, cy);
    }
}
