import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> c1_in;
[vk::binding(1, 0)] StructuredBuffer<float> c2_in;
[vk::binding(2, 0)] StructuredBuffer<float> c3_in;
[vk::binding(3, 0)] StructuredBuffer<float> l_pixel;
[vk::binding(4, 0)] RWStructuredBuffer<float> out_raw;
[vk::binding(5, 0)] StructuredBuffer<float> lut_d;
[vk::binding(6, 0)] StructuredBuffer<float> lut_x;
[vk::binding(7, 0)] StructuredBuffer<float> lut_params;
[vk::binding(8, 0)] StructuredBuffer<float> params;

struct Push {
    int in_w;
    int in_h;
    int period_w;
    int period_h;
    uint packed0;
    uint packed1;
    uint packed2;
    float gain_c1;
    float gain_c2;
    int reconstructed;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(16, 16, 1)]
void restore_mosaic(uint3 id : SV_DispatchThreadID)
{
    let out_w = 2 * pc.in_w;
    let out_h = 2 * pc.in_h;
    let fx = int(id.x);
    let fy = int(id.y);
    if (fx >= out_w || fy >= out_h) { return; }

    let hx = fx >> 1;
    let hy = fy >> 1;
    let p = fy * out_w + fx;
    let l_c = l_pixel[p];
    float value;
    if (pc.reconstructed != 0) {
        let slot = (fy & 1) | ((fx & 1) << 1);
        value = 0.5 * l_c + params[P_DARK_REF0 + slot];
    } else {
        var nmin = float3(1e30);
        var nmax = float3(-1e30);
        for (int ny = -1; ny <= 1; ny++) {
            let hyi = clamp(hy + ny, 0, pc.in_h - 1);
            for (int nx = -1; nx <= 1; nx++) {
                if (ny == 0 && nx == 0) { continue; }
                let hxi = clamp(hx + nx, 0, pc.in_w - 1);
                let hi = hyi * pc.in_w + hxi;
                let neighbour = float3(c1_in[hi], c2_in[hi], c3_in[hi]);
                nmin = min(nmin, neighbour);
                nmax = max(nmax, neighbour);
            }
        }
        let site = hy * pc.in_w + hx;
        let c = clamp(float3(c1_in[site], c2_in[site], c3_in[site]), nmin, nmax);
        Pattern pat = { pc.period_w, pc.period_h, pc.packed0, pc.packed1, pc.packed2 };
        let w = chroma_weights(cfa_colour(pat, fy, fx));
        value = l_c + w.x * c.x * pc.gain_c1 + w.y * c.y * pc.gain_c2;
    }

    // No floor at black: one here keeps the upper half of the residual noise and lifts every dark
    // channel, which the white balance then turns into a cast.
    out_raw[p] = min(gat_inv_lut(lut_d, lut_x, lut_params, value * params[P_UNIFIED_SIGMA], uint(LUT_SIZE)), 1.0);
}
