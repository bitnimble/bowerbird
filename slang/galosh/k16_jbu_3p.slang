// Phases 7 and 9: chroma upsampled 2x, steered by the denoised luma.
//
// A jinc (EWA-JL3) kernel for the geometry and a bilateral term on the luma difference for the
// edges, so colour follows a boundary it cannot see itself.
//
// Two details are load-bearing and look removable. The hull clamp holds the output inside
// the nearest 2x2 source samples, which is what stops the jinc side lobes ringing into
// magenta at a high-contrast edge; and the `sum_w` floor preserves the sign, because a
// positive floor over a negative sum flips the chroma and produces exactly that spike.
//
// **The phases are co-sited, and that is a half-pixel bias this kernel cannot be talked out of.**
// A 2x2 box average's centroid is at full-resolution `2k + 1`, which is where low-resolution
// sample `k` sits, so output pixel `j` belongs at low-resolution `(j + 0.5) / 2` - a quarter of a
// sample either side, not the 0.0 and +0.5 below. Measured on a linear ramp, whose reconstruction
// through a normalised kernel is exact up to a displacement, the committed table is off by 0.5
// full-resolution pixels uniformly: a translation of chroma against luma, per level.
//
// Swapping the phases to -0.25/+0.25 makes it **worse**, which is why they are still here. The
// kernel is `r = 2*hypot` truncated at `r < 3`, so it reaches only 1.5 samples and was tuned for
// taps landing on 0 and +-1, or +-0.5 and +-1.5 at the half phase; at a quarter phase the negative
// lobes stop cancelling and the normalised centroid swings to +-1.27 pixels, alternating sign
// between the two phases - a zigzag where there was a translation. Correcting the siting means a
// wider kernel renormalised for quarter phases, not an edit to this table.
//
// `examples/jinc_table.rs` regenerates either set and reports the displacement; it reproduces
// `k16`'s table digit for digit first, which is the only reason to believe the other one.
//
// The output is always twice the input, both axes - the caller crops the guide and pads the
// result where a level is odd.
import k16;

[vk::binding(0, 0)] StructuredBuffer<float> c1_in;
[vk::binding(1, 0)] StructuredBuffer<float> c2_in;
[vk::binding(2, 0)] StructuredBuffer<float> c3_in;
[vk::binding(3, 0)] StructuredBuffer<float> l_pixel;
[vk::binding(4, 0)] RWStructuredBuffer<float> c1_out;
[vk::binding(5, 0)] RWStructuredBuffer<float> c2_out;
[vk::binding(6, 0)] RWStructuredBuffer<float> c3_out;

struct Push {
    int in_w;
    int in_h;
    float bw;
    /// `galosh::RATIO_FLOOR`.
    float ratio_floor;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

/// `loess_chroma_3p_tiled`'s, likewise.
float share_of(float luma)
{
    return pc.ratio_floor > 0.0 ? max(luma, pc.ratio_floor) : 1.0;
}

[shader("compute")]
[numthreads(16, 16, 1)]
void k16_jbu_3p(uint3 id : SV_DispatchThreadID)
{
    let out_w = 2 * pc.in_w;
    let out_h = 2 * pc.in_h;
    let fx = int(id.x);
    let fy = int(id.y);
    if (fx >= out_w || fy >= out_h) { return; }

    let hx = fx >> 1;
    let hy = fy >> 1;
    let sub_x = fx & 1;
    let sub_y = fy & 1;
    let si = sub_y * 2 + sub_x;

    let l_c = l_pixel[fy * out_w + fx];
    let inv_2bw_sq = 1.0 / (2.0 * pc.bw * pc.bw);

    var sum_w = 0.0;
    var sum_c = float3(0.0);
    var cmin = float3(1e30);
    var cmax = float3(-1e30);

    // Three by three offset by the sub-pixel: `K16_W`'s support for a given `si` is exactly
    // `dy in [sub_y - 1, 1]` by `dx in [sub_x - 1, 1]`, and `k16_inverse_fused` gathers the same
    // window from the same table for the same reason.
    for (int i = 0; i < 3; i++) {
        let dy = sub_y - 1 + i;
        let hyi = clamp(hy + dy, 0, pc.in_h - 1);
        for (int j = 0; j < 3; j++) {
            let dx = sub_x - 1 + j;
            let hxi = clamp(hx + dx, 0, pc.in_w - 1);
            let hi = hyi * pc.in_w + hxi;
            // As a share of the luma the sample was fitted against, which is the guide's 2x2 under
            // it - the level below is that box average - so the answer can be put back against
            // this pixel's own luma, as `loess_chroma_3p_tiled` does.
            let at = 2 * hyi * out_w + 2 * hxi;
            let under = 0.25 * (l_pixel[at] + l_pixel[at + 1] + l_pixel[at + out_w] + l_pixel[at + out_w + 1]);
            let iv = float3(c1_in[hi], c2_in[hi], c3_in[hi]) / share_of(under);

            if ((dy == 0 || (sub_y != 0 && dy == 1)) && (dx == 0 || (sub_x != 0 && dx == 1))) {
                cmin = min(cmin, iv);
                cmax = max(cmax, iv);
            }

            // The guide, at the full-res top-left of this half-res chroma sample.
            let dl = l_pixel[2 * hyi * out_w + 2 * hxi] - l_c;
            let w = K16_W[si * 25 + (dy + 2) * 5 + (dx + 2)] * exp(-dl * dl * inv_2bw_sq);

            sum_w += w;
            sum_c += w * iv;
        }
    }

    var safe_w = sum_w;
    if (abs(sum_w) <= 1e-6) {
        safe_w = select(sum_w < 0.0, -1e-6, 1e-6);
    }
    var upsampled = sum_c / safe_w;
    if (cmax.x >= cmin.x) { upsampled.x = clamp(upsampled.x, cmin.x, cmax.x); }
    if (cmax.y >= cmin.y) { upsampled.y = clamp(upsampled.y, cmin.y, cmax.y); }
    if (cmax.z >= cmin.z) { upsampled.z = clamp(upsampled.z, cmin.z, cmax.z); }
    upsampled *= share_of(l_c);

    let op = fy * out_w + fx;
    c1_out[op] = upsampled.x;
    c2_out[op] = upsampled.y;
    c3_out[op] = upsampled.z;
}
