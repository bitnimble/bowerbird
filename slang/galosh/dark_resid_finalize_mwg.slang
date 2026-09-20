// Phase 2(a): the next IRLS scale, held inside the bounds `irls_seed` set from α and σ².
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> partial_resid_buf;
[vk::binding(1, 0)] RWStructuredBuffer<float> params;

struct Push {
    int n_wg;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(256, 1, 1)]
void dark_resid_finalize_mwg(uint3 id : SV_DispatchThreadID)
{
    if (id.x != 0) { return; }

    var swr = tally();
    var sww = tally();
    for (int i = 0; i < pc.n_wg; i++) {
        tally_push(swr, partial_resid_buf[i * 2 + 0]);
        tally_push(sww, partial_resid_buf[i * 2 + 1]);
    }

    let inv_sw2 = 1.0 / max(tally_sum(sww), 1e-20);
    let measured_std = sqrt(max(tally_sum(swr) * inv_sw2, 1e-20));
    let ratio = 1.0 / measured_std;
    params[P_S_SCALE] = clamp(params[P_S_SCALE] * sqrt(ratio), params[P_S_MIN], params[P_S_MAX]);
}
