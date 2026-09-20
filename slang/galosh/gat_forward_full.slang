// Phase 1(a): the generalised Anscombe transform, forward, over the whole mosaic.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> raw;
[vk::binding(1, 0)] RWStructuredBuffer<float> in_gat_full;
[vk::binding(6, 0)] StructuredBuffer<float> params;

struct Push {
    int width;
    int height;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(16, 16, 1)]
void gat_forward_full(uint3 id : SV_DispatchThreadID)
{
    let fx = int(id.x);
    let fy = int(id.y);
    if (fx >= pc.width || fy >= pc.height) { return; }

    // Through `ALPHA_MIN`, exactly as `build_inv_lut` reads it: the table undoes this transform,
    // so the two must divide by the same slope whatever reached the slot.
    let a = max(params[P_ALPHA], ALPHA_MIN);
    let sq = params[P_SIGMA_SQ];
    let sigma_raw = sqrt(max(sq, 1e-20));
    let y_break = -0.375 * a;
    let t_break = 2.0 * sigma_raw / a;

    let x = raw[fy * pc.width + fx];
    // A NaN guard and no clamp: `x == x` is false only for NaN, which needs an ordered
    // compare, so nothing on this path may be built with fast math.
    var x_safe = x;
    if (!(x == x)) { x_safe = 0.0; }

    float t;
    if (x_safe >= y_break) {
        let arg = a * x_safe + 0.375 * a * a + sq;
        t = (2.0 / a) * sqrt(max(arg, 0.0));
    } else {
        // The C¹ linear continuation below the sqrt branch's knee.
        t = t_break + (x_safe - y_break) / sigma_raw;
    }

    in_gat_full[fy * pc.width + fx] = t;
}
