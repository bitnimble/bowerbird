// Phase 2(b): each CFA slot's own dark reference, subtracted.
//
// `k16_inverse_fused` adds the same four numbers back.
import prelude;

[vk::binding(0, 0)] RWStructuredBuffer<float> in_gat_full;
[vk::binding(5, 0)] StructuredBuffer<float> params;

struct Push {
    int width;
    int height;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(16, 16, 1)]
void dark_sub_full(uint3 id : SV_DispatchThreadID)
{
    let fx = int(id.x);
    let fy = int(id.y);
    if (fx >= pc.width || fy >= pc.height) { return; }

    let slot = (fy & 1) | ((fx & 1) << 1);
    in_gat_full[fy * pc.width + fx] -= params[P_DARK_REF0 + slot];
}
