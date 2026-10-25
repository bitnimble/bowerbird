// The sites fused with the level below them and taken back to photosites: the site transform
// undone, the dark reference added back, and out of the GAT.
import prelude;
import pyramid;
import "../times.slang";

[vk::binding(0, 0)] StructuredBuffer<float> sites;
[vk::binding(1, 0)] StructuredBuffer<float> boxed;
[vk::binding(2, 0)] StructuredBuffer<float> below;
[vk::binding(4, 0)] RWStructuredBuffer<float> out_raw;
[vk::binding(5, 0)] StructuredBuffer<float> lut_d;
[vk::binding(6, 0)] StructuredBuffer<float> lut_x;
[vk::binding(7, 0)] StructuredBuffer<float> lut_params;
[vk::binding(8, 0)] StructuredBuffer<float> params;
[vk::binding(9, 0)] StructuredBuffer<float> transform;

[vk::binding(20, 0)] ConstantBuffer<Sites> pc;

void restore<let SIDE : int>(int x, int y)
{
    float site[MAX_PLANES];
    [ForceUnroll]
    for (int p = 0; p < SIDE * SIDE; p++) {
        site[p] = sites[at_plane(p, x, y, pc.w0, pc.h0)]
            + upsampled_difference(below, boxed, p, x, y, pc.w1, pc.h1);
    }
    let rows = transform_at(x, y, pc.across, pc.down);
    [ForceUnroll]
    for (int k = 0; k < SIDE * SIDE; k++) {
        let px = times(x, SIDE) + k % SIDE;
        let py = times(y, SIDE) + k / SIDE;
        if (px >= pc.width || py >= pc.height) { continue; }
        var coded = 0.0;
        [ForceUnroll]
        for (int p = 0; p < SIDE * SIDE; p++) {
            coded += transform[rows + p * MAX_PLANES + k] * site[p];
        }
        // `dark_sub_full`'s slots: row parity in the low bit, column parity above it.
        let slot = (py & 1) | ((px & 1) << 1);
        let value = (coded + params[P_DARK_REF0 + slot]) * params[P_UNIFIED_SIGMA];
        out_raw[py * pc.width + px] = min(gat_inv_lut(lut_d, lut_x, lut_params, value, uint(LUT_SIZE)), 1.0);
    }
}

[shader("compute")]
[numthreads(16, 16, 1)]
void pyr_restore(uint3 id : SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.w0 || y >= pc.h0) { return; }
    // Unrolled per side, so every array index is a constant and the arrays stay in registers.
    if (pc.side == 2) {
        restore<2>(x, y);
    } else {
        restore<3>(x, y);
    }
}
