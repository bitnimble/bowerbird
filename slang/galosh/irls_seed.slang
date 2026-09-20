// The IRLS scale and the bounds it is held inside, seeded from the blind fit.
//
// On the device rather than the host, so the whole denoise is one command buffer and one
// readback: seeding on the host would cost a mid-frame readback of α and σ² and a second
// submission, for three divisions.
import prelude;

[vk::binding(0, 0)] RWStructuredBuffer<float> params;

[shader("compute")]
[numthreads(256, 1, 1)]
void irls_seed(uint3 id : SV_DispatchThreadID)
{
    if (id.x != 0) { return; }
    // **A zero scale is not a scale, it is a stuck one.** `sigma_sq` is zero on more than the
    // degenerate path: `ne_finalize` writes it as zero outright and the dark phase fills it in
    // afterwards, so a frame whose dark statistics bail - too few samples - arrives here still at
    // zero. Both bounds would then be zero too, and every later `clamp(s, S_MIN, S_MAX)` pins the
    // IRLS scale at zero for the rest of the run: the residual weights all collapse, the dark
    // references come out equal, and the fixed-pattern offset this phase exists to remove is
    // subtracted and added back unchanged. Silent, because the picture is otherwise correct.
    //
    // The floor only decides how wide the window opens in that case; any positive value leaves the
    // iteration able to find its own scale, which is what it does from here on.
    let s_init = max(params[P_SIGMA_SQ] / max(params[P_ALPHA], 1e-12), 1e-6);
    params[P_S_SCALE] = s_init;
    params[P_S_MIN] = 0.05 * s_init;
    params[P_S_MAX] = 50.0 * s_init;
}
