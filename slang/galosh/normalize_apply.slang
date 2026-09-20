// Phase 1(d): the GAT frame scaled to unit noise, in place.
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
void normalize_apply(uint3 id : SV_DispatchThreadID)
{
    let fx = int(id.x);
    let fy = int(id.y);
    if (fx >= pc.width || fy >= pc.height) { return; }
    in_gat_full[fy * pc.width + fx] *= params[P_INV_SG];
}
