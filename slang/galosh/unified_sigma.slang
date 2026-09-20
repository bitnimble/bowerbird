// Phase 1(c): the four channel sigmas, unified by RMS.
//
// Everything downstream works in units of this one number, and
// `k16_inverse_fused` multiplies it back at the end.
import prelude;

[vk::binding(0, 0)] RWStructuredBuffer<float> params;

[shader("compute")]
[numthreads(256, 1, 1)]
void unified_sigma(uint3 id : SV_DispatchThreadID)
{
    if (id.x != 0) { return; }
    let s0 = params[P_SIGMA_CH0];
    let s1 = params[P_SIGMA_CH0 + 1];
    let s2 = params[P_SIGMA_CH0 + 2];
    let s3 = params[P_SIGMA_CH0 + 3];
    let mean_var = 0.25 * (s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3);
    let unified = sqrt(max(mean_var, 1e-12));
    params[P_UNIFIED_SIGMA] = unified;
    params[P_INV_SG] = 1.0 / unified;
}
