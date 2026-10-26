import prelude;
import "../light.slang";

[vk::binding(0, 0)] StructuredBuffer<float> raw;
[vk::binding(1, 0)] RWStructuredBuffer<float> in_gat_full;
[vk::binding(6, 0)] StructuredBuffer<float> params;

struct Push {
    int width;
    int height;
    int period_w;
    int period_h;
    uint packed0;
    uint packed1;
    uint packed2;
    float red_to_green;
    float blue_to_green;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(16, 16, 1)]
void gat_forward_full(uint3 id : SV_DispatchThreadID)
{
    let fx = int(id.x);
    let fy = int(id.y);
    if (fx >= pc.width || fy >= pc.height) { return; }

    Pattern pat = { pc.period_w, pc.period_h, pc.packed0, pc.packed1, pc.packed2 };
    Gain sample;
    sample.g = raw[fy * pc.width + fx] * to_green(pat, pc.red_to_green, pc.blue_to_green, fy, fx);
    in_gat_full[fy * pc.width + fx] = gat_forward(sample, params[P_ALPHA], params[P_SIGMA_SQ]);
}
