import print_material;

struct Material { float4 values; };
[vk::binding(0, 0)] ConstantBuffer<Material> material;
[vk::binding(1, 0)] RWStructuredBuffer<float> albedo;

[shader("compute")]
[numthreads(64, 1, 1)]
void tabulate(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= ALBEDO_VIEWS || id.y >= ALBEDO_ROUGHNESSES) { return; }
    let coordinate = float(id.x) / float(ALBEDO_VIEWS - 1);
    let cosine = max(coordinate * coordinate, 1e-5);
    let roughness = lerp(0.03, 1.0, float(id.y) / float(ALBEDO_ROUGHNESSES - 1));
    albedo[id.y * ALBEDO_STRIDE + id.x] = directional_albedo(cosine, roughness, material.values.x, 1024);
}

[shader("compute")]
[numthreads(64, 1, 1)]
void average(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= ALBEDO_ROUGHNESSES) { return; }
    var sum = 0.0;
    for (uint i = 0; i < 512; i += 1) {
        let cosine = (float(i) + 0.5) / 512.0;
        let at = sqrt(cosine) * float(ALBEDO_VIEWS - 1);
        let left = min(uint(at), ALBEDO_VIEWS - 2);
        let value = lerp(albedo[id.x * ALBEDO_STRIDE + left], albedo[id.x * ALBEDO_STRIDE + left + 1], at - float(left));
        sum += 2.0 * cosine * value / 512.0;
    }
    albedo[id.x * ALBEDO_STRIDE + ALBEDO_VIEWS] = sum;
}
