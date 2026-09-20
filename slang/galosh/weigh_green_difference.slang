// Phase 8, after `smoothstep_blend_3p`: the green difference weighed rather than walked, on a
// Bayer mosaic.
//
// **`c1 - c2` is `gr - gb`, and no hue can reach it.** `c1` is the site's top row against its
// bottom and `c2` its left column against its right (`chroma_extract_halfres`), so `c1 + c2` is
// `r - b` and `c3` is half of `(r + b) - (gr + gb)` - opponent colour, both of them - while their
// difference is two samples of the *same* filter, holding the luma gradient across the site and
// the sensor's own green imbalance. Written back as the walk left it, it is smoothed as though it
// were a hue: the guide is a plane of site means and cannot see inside a site, so the regression
// flattens the gradient and the inverse rebuilds a site whose greens disagree, which is a green
// imbalance, which a directional demosaic spreads as a maze.
//
// Neither smoothed nor held, but weighed against the noise it would be if it were noise -
// `pass12`'s Wiener gain on a band whose variance is known rather than fitted. Holding it
// outright puts the same maze over every flat surface instead, since a *random* green difference
// demosaics no better than a flattened one.
//
// Only a Bayer mosaic: off a wider pattern `c1` and `c2` are `mR - mB` and `mR - 2mG + mB`,
// opponent colour both, and this would hold a hue back from the regression on the strength of its
// own noise.

[vk::binding(0, 0)] StructuredBuffer<float> c1_h;
[vk::binding(1, 0)] StructuredBuffer<float> c2_h;
[vk::binding(3, 0)] RWStructuredBuffer<float> c1_loess_h;
[vk::binding(4, 0)] RWStructuredBuffer<float> c2_loess_h;

/// `smoothstep_blend_3p`'s, of which this reads the extent.
struct Push {
    int width;
    int height;
    float slider;
    float reach;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

/// What a green difference has to beat to be kept raw, where a GAT sample's variance is one.
///
/// **Analytically two, and measured to want more than that.** Each of the four samples contributes
/// a quarter of its own variance to `c1` and to `c2` and the two are uncorrelated, so the noise in
/// their difference carries exactly two - but a difference of *twice* the noise still passes half
/// of itself through raw, and what the demosaic does with a half-random green imbalance is the
/// weave this constant exists to prevent. Measured on DSC00982's out-of-focus background at 60/90:
/// at two the second chroma axis reads 1.51 and the surface is visibly woven at 2x, at six it
/// reads 0.87 and the weave is much reduced, and at eighteen the first axis goes the wrong way
/// (1.39 to 1.86) for no further gain on the second.
static const float GREEN_DIFFERENCE_VARIANCE = 6.0;

[shader("compute")]
[numthreads(16, 16, 1)]
void weigh_green_difference(uint3 id : SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }

    let p = y * pc.width + x;
    let blended = float2(c1_loess_h[p], c2_loess_h[p]);
    let raw_difference = c1_h[p] - c2_h[p];
    let smoothed_difference = blended.x - blended.y;
    // Noise off the observation before the ratio, as `pass12` takes it off a measured variance:
    // `g^2` alone calls a difference of exactly the noise all signal, and half of every flat field
    // would come back raw.
    let observed = raw_difference * raw_difference;
    let real = max(observed - GREEN_DIFFERENCE_VARIANCE, 0.0) / max(observed, 1e-10);
    let difference = lerp(smoothed_difference, raw_difference, real);

    let sum = blended.x + blended.y;
    c1_loess_h[p] = 0.5 * (sum + difference);
    c2_loess_h[p] = 0.5 * (sum - difference);
}
