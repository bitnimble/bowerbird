// Phases 9 and 10 in one pass: the final chroma upsample, straight into the inverse.
//
// Fused for memory rather than speed: materialising `C1/C2/C3_aligned` costs three
// *full-resolution* planes, which at 61MP is 720MB of them for values every one of which is
// consumed by the next dispatch at the same coordinate. Fused, the whole denoise holds three full-res planes instead of six.
//
// The upsample half is `k16_jbu_3p`, which carries the notes on why the hull clamp and the
// sign-preserving weight floor matter; the inverse half ends in `prelude`'s `gat_inv_lut`.
import prelude;
import k16;

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
    float bw;
    int period_w;
    int period_h;
    uint packed0;
    uint packed1;
    uint packed2;
    float gain_c1;
    float gain_c2;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

// The inverse 2x2 WHT's signs are the slot's own two bits: the first follows `sub_y`, the second
// `sub_x`, the third their product. Taken off the CFA slot directly and not remapped through a
// sub-pixel index.

[shader("compute")]
[numthreads(16, 16, 1)]
void k16_inverse_fused(uint3 id : SV_DispatchThreadID)
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

    let p = fy * out_w + fx;
    let l_c = l_pixel[p];
    let inv_2bw_sq = 1.0 / (2.0 * pc.bw * pc.bw);

    // **The site's own chroma, not a three-by-three interpolation of its neighbours'.**
    //
    // Resampling the half-resolution chroma onto the luma's stride-1 grid before the inverse is a
    // two-pixel operation applied to every frame that reaches this kernel, whatever the sliders
    // say. Measured at a shrinkage threshold of 0.016 sigma - an
    // amount that removes nothing - rebuilding that way took a quarter of the frame's noise out,
    // cut the transitions a sharpness probe can find from 883 to 185, and left the residual's
    // autocorrelation at two photosites at +0.14, where both the sensor and the body's own JPEG of
    // the frame sit at -0.02. That is the whole of why this pipeline's grain read as two-pixel
    // lumps where a camera's reads as film.
    //
    // **A site's four pixels do not share a value, so nothing here is blockier for the loss.** The
    // inverse 2x2 WHT below gives each of them a different combination of the same three chroma
    // terms through `s1`, `s2` and `s3` - it is the exact inverse of what Phase 4 extracted, and
    // an interpolation can only move it away from that. Measured at the same amount, the eight-band
    // profile goes from `+0.53 +0.16 -0.07` to `+0.46 -0.02 -0.21` against the body's
    // `+0.52 -0.01 -0.16`, and the sharpest decile from 1.43px to 0.85px.
    // **The site's own terms, bounded by its neighbours' range but never averaged with them.**
    //
    // The inverse below multiplies each of these by a sign that flips with the sub-pixel, so a
    // chroma term that varies *slowly* across sites is painted into the picture as a two-pixel
    // checkerboard of its own amplitude - a weave. Upsampling is exactly what makes it vary slowly.
    // The site's own value is the exact inverse of what Phase 4 extracted and carries no such
    // pattern: on DSC00982's out-of-focus background the residual's autocorrelation at two
    // photosites goes from +0.16 to -0.01, against the sensor's own -0.02.
    //
    // **Bounded by the eight neighbours and not by the nine**, which is the whole of whether this
    // works. A site whose own term is an impulse is by definition outside the range its neighbours
    // span, so excluding it is what lets the bound bite; including it - as the upsample's own hull
    // does, since `(0, 0)` satisfies its condition - makes the clamp a no-op on precisely the
    // values it is for, and the picture comes back speckled with isolated dots. Nothing else in the
    // chain removes them: the chroma regression is a smooth fit, and an impulse survives one.
    var nmin = float3(1e30);
    var nmax = float3(-1e30);
    for (int ny = -1; ny <= 1; ny++) {
        let hyi = clamp(hy + ny, 0, pc.in_h - 1);
        for (int nx = -1; nx <= 1; nx++) {
            if (ny == 0 && nx == 0) { continue; }
            let hxi = clamp(hx + nx, 0, pc.in_w - 1);
            let hi = hyi * pc.in_w + hxi;
            let nv = float3(c1_in[hi], c2_in[hi], c3_in[hi]);
            nmin = min(nmin, nv);
            nmax = max(nmax, nv);
        }
    }
    let site = hy * pc.in_w + hx;
    let c = clamp(float3(c1_in[site], c2_in[site], c3_in[site]), nmin, nmax);

    let slot = (fy & 1) | ((fx & 1) << 1);
    var val = 0.0;
    if (pc.period_w == 2 && pc.period_h == 2) {
        let s1 = select(sub_y != 0, -1.0, 1.0);
        let s2 = select(sub_x != 0, -1.0, 1.0);
        let s3 = s1 * s2;
        val = 0.5 * (l_c + s1 * c.x + s2 * c.y + s3 * c.z) + params[P_DARK_REF0 + slot];
    } else {
        // Phase 3 subtracted this photosite's colour offset rather than blocking the frame, so the
        // inverse is that subtraction undone - and the dark reference is not in it, `run` leaving
        // the slots zero wherever a 2x2 parity class is not a colour.
        Pattern pat = { pc.period_w, pc.period_h, pc.packed0, pc.packed1, pc.packed2 };
        let w = chroma_weights(cfa_colour(pat, fy, fx));
        // The normalisation the extraction applied, undone, so the pair is still its own inverse.
        val = l_c + w.x * c.x * pc.gain_c1 + w.y * c.y * pc.gain_c2;
    }

    // No floor at black: one here keeps the upper half of the residual noise and lifts every dark
    // channel, which the white balance then turns into a cast.
    out_raw[p] = min(gat_inv_lut(lut_d, lut_x, lut_params, val * params[P_UNIFIED_SIGMA], uint(LUT_SIZE)), 1.0);
}
