// The half-resolution sites fused with the level below them and taken back to photosites: the
// Walsh-Hadamard transform undone, the dark reference added back, and out of the GAT.
import prelude;
import pyramid;

[vk::binding(0, 0)] StructuredBuffer<float> sites;
[vk::binding(1, 0)] StructuredBuffer<float> boxed;
[vk::binding(2, 0)] StructuredBuffer<float> below;
[vk::binding(4, 0)] RWStructuredBuffer<float> out_raw;
[vk::binding(5, 0)] StructuredBuffer<float> lut_d;
[vk::binding(6, 0)] StructuredBuffer<float> lut_x;
[vk::binding(7, 0)] StructuredBuffer<float> lut_params;
[vk::binding(8, 0)] StructuredBuffer<float> params;

struct Push {
    int width;
    int w0;
    int h0;
    int w1;
    int h1;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

float photosite(float coded, int slot)
{
    let value = (coded + params[P_DARK_REF0 + slot]) * params[P_UNIFIED_SIGMA];
    return min(gat_inv_lut(lut_d, lut_x, lut_params, value, uint(LUT_SIZE)), 1.0);
}

[shader("compute")]
[numthreads(16, 16, 1)]
void pyr_restore(uint3 id : SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.w0 || y >= pc.h0) { return; }

    float4 s;
    for (int p = 0; p < PLANES; p++) {
        s[p] = sites[at_plane(p, x, y, pc.w0, pc.h0)]
            + upsampled_difference(below, boxed, p, x, y, pc.w1, pc.h1);
    }
    let a = 0.5 * (s.x + s.y + s.z + s.w);
    let b = 0.5 * (s.x - s.y + s.z - s.w);
    let c = 0.5 * (s.x + s.y - s.z - s.w);
    let d = 0.5 * (s.x - s.y - s.z + s.w);

    // `dark_sub_full`'s slots: row parity in the low bit, column parity above it.
    let top = 2 * y * pc.width + 2 * x;
    out_raw[top] = photosite(a, 0);
    out_raw[top + 1] = photosite(b, 2);
    out_raw[top + pc.width] = photosite(c, 1);
    out_raw[top + pc.width + 1] = photosite(d, 3);
}
