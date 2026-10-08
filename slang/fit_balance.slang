// A fit plane as the camera match's balance lights it, through the grade's own `lit_by_reader`, so
// what the fit is taught on is what the grade hands the match.
import colour;
import lanes;
import light;
import px;

struct Params {
    int pixels;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Interleaved f32 RGB, in and out.
[vk::binding(5, 0)] StructuredBuffer<float> plane;
[vk::binding(6, 0)] RWStructuredBuffer<float> lit;

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_balance(uint3 id: SV_DispatchThreadID)
{
    let p = linear(id);
    if (p >= uint(pc.pixels)) { return; }
    let i = wide<FitPlane>(int(p)) * 3;
    let v = lit_by_reader(measured<SceneNits>(float3(plane[i], plane[i + 1], plane[i + 2]))).v;
    lit[i] = v.r;
    lit[i + 1] = v.g;
    lit[i + 2] = v.b;
}
