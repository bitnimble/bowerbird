// Phase 3: the plane the shrinkage reads, with the colour filter array taken out of it.
//
// Every buffer here is f32. FP16 storage would save bandwidth on a phone, and costs 0.1-0.7 dB.
//
// On Bayer this is the luma term of the 2x2 Walsh-Hadamard transform at stride 1 - every pixel
// begins a block, so the denoise below sees all sixteen phases of it and `lpixel_lh_den_fused`
// averages them back.
//
// **On any other pattern it is a subtraction instead, and the result is a better plane.** The 2x2
// transform's luma only *is* a luma where every site holds one of each colour; on X-Trans a site
// can be four greens, and then the term is a green and the plane carries the pattern's own period
// as a maze the shrinkage then preserves. Taking each photosite's colour offset off it
// (`chroma_weights`) leaves the same luma at a red, a green and a blue - at full resolution,
// where the 2x2 arm gives up a box - and the inverse puts the offset back.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> in_gat_full;
[vk::binding(1, 0)] RWStructuredBuffer<float> l_cs;
[vk::binding(2, 0)] StructuredBuffer<float> c1_h;
[vk::binding(3, 0)] StructuredBuffer<float> c2_h;

struct Push {
    int width;
    int height;
    int halfwidth;
    int period_w;
    int period_h;
    uint packed0;
    uint packed1;
    uint packed2;
    float gain_c1;
    float gain_c2;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(16, 16, 1)]
void forward_l_stride1(uint3 id : SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }

    if (pc.period_w == 2 && pc.period_h == 2) {
        var yb = y + 1;
        if (yb >= pc.height) { yb = pc.height - 2; }
        if (yb < 0) { yb = 0; }
        var xb = x + 1;
        if (xb >= pc.width) { xb = pc.width - 2; }
        if (xb < 0) { xb = 0; }

        let a = in_gat_full[y * pc.width + x];
        let b = in_gat_full[yb * pc.width + x];
        let cc = in_gat_full[y * pc.width + xb];
        let d = in_gat_full[yb * pc.width + xb];
        l_cs[y * pc.width + x] = 0.5 * (a + b + cc + d);
        return;
    }

    Pattern pat = { pc.period_w, pc.period_h, pc.packed0, pc.packed1, pc.packed2 };
    // The site's own chroma, which is the value `k16_inverse_fused` will add back at this pixel -
    // so with nothing shrunk and nothing smoothed the pair is the identity.
    let site = (y >> 1) * pc.halfwidth + (x >> 1);
    let w = chroma_weights(cfa_colour(pat, y, x));
    // The axes arrive normalised to one photosite's sigma, so the offset is taken at their own
    // scale - the same undoing `k16_inverse_fused` applies when it puts the offset back.
    l_cs[y * pc.width + x] = in_gat_full[y * pc.width + x]
        - (w.x * c1_h[site] * pc.gain_c1 + w.y * c2_h[site] * pc.gain_c2);
}
