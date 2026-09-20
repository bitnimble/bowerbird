// Phase 8: the chroma strength, as a walk along four anchors.
//
// The slider runs 0..3 across noisy, the LOESS baseline at half res, the quarter-res level
// upsampled, and the eighth - so its unit is *how far the colour is allowed to be smoothed*, in
// scales, rather than an amount of anything. The smoothstep is what keeps the crossings from
// showing as the slider moves.
//
// **Bound with only the anchors the slider can reach**, which is two sets of three planes beside
// the regression: all four is twelve storage buffers, and an Apple GPU offers a stage ten
// (`gpu::MOST_STORAGE_BUFFERS`). The slider is one number for the whole dispatch, so the host knows
// which two. The green difference is weighed after, by `weigh_green_difference`.

// The answer is written back over the second anchor rather than into a fourth set of
// half-resolution planes: this is the last thing that reads the regression, and three more
// planes at 61MP is 90MB spent moving values between two addresses.
//
// `near` is the anchor on the far side of the regression from the one the slider ends at: the
// noisy chroma up to one, the quarter level past it. `far` is the eighth, read only past two.
[vk::binding(0, 0)] StructuredBuffer<float> c1_near;
[vk::binding(1, 0)] StructuredBuffer<float> c2_near;
[vk::binding(2, 0)] StructuredBuffer<float> c3_near;
[vk::binding(3, 0)] RWStructuredBuffer<float> c1_loess_h;
[vk::binding(4, 0)] RWStructuredBuffer<float> c2_loess_h;
[vk::binding(5, 0)] RWStructuredBuffer<float> c3_loess_h;
[vk::binding(6, 0)] StructuredBuffer<float> c1_far;
[vk::binding(7, 0)] StructuredBuffer<float> c2_far;
[vk::binding(8, 0)] StructuredBuffer<float> c3_far;

struct Push {
    int width;
    int height;
    float slider;
    /// `galosh::LEVEL_REACH`.
    float reach;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

/// A coarser level's chroma, let move the finer one's by about the noise and no further.
///
/// **A coarse level cannot see an edge its box downsample already averaged across**, and the
/// guided upsample only clamps to those mixed samples, so taken whole it spreads a colour step
/// by its own sample size: a saturated square on grey came back sixteen pixels wide off the
/// eighth. What the level is for is mottle, which is residual noise and moves the chroma by less
/// than one sigma, so gating the move on its own size keeps that and bounds any edge's bleed near
/// `0.6 * reach` sigma of the GAT, whatever the mix.
float3 reached(float3 fine, float3 coarse)
{
    let d = coarse - fine;
    return fine + exp(-dot(d, d) / (6.0 * pc.reach * pc.reach)) * d;
}

/// `t_raw` of the way from `lo` to `hi`, eased.
float3 walked(float3 lo, float3 hi, float t_raw)
{
    let t = t_raw * t_raw * (3.0 - 2.0 * t_raw);
    return (1.0 - t) * lo + t * hi;
}

[shader("compute")]
[numthreads(16, 16, 1)]
void smoothstep_blend_3p(uint3 id : SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }

    let p = y * pc.width + x;
    let near = float3(c1_near[p], c2_near[p], c3_near[p]);
    let b = float3(c1_loess_h[p], c2_loess_h[p], c3_loess_h[p]);

    float3 blended;
    if (pc.slider <= 0.0) {
        blended = near;
    } else if (pc.slider <= 1.0) {
        blended = walked(near, b, pc.slider);
    } else {
        let c = reached(b, near);
        if (pc.slider <= 2.0) {
            blended = walked(b, c, pc.slider - 1.0);
        } else {
            let d = reached(c, float3(c1_far[p], c2_far[p], c3_far[p]));
            blended = pc.slider >= 3.0 ? d : walked(c, d, pc.slider - 2.0);
        }
    }
    c1_loess_h[p] = blended.x;
    c2_loess_h[p] = blended.y;
    c3_loess_h[p] = blended.z;
}
