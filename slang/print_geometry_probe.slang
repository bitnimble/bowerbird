import print_geometry;

struct Probe { float4 pixel; float4 shape; };
[vk::binding(0, 0)] StructuredBuffer<Probe> probes;
[vk::binding(1, 0)] RWStructuredBuffer<float4> results;

[shader("compute")]
[numthreads(1, 1, 1)]
void main(uint3 group : SV_GroupID)
{
    let probe = probes[group.x];
    let pixel = probe.pixel.xy;
    let canvas = probe.pixel.zw;
    let shape = probe.shape.xy;
    let hit = paper_hit(pixel, canvas, shape);
    let covered = paper_covered(pixel, canvas, shape);
    let dx = paper_uv(pixel + float2(1.0, 0.0), canvas, shape, hit) - hit.uv;
    let dy = paper_uv(pixel + float2(0.0, 1.0), canvas, shape, hit) - hit.uv;
    results[group.x * 4] = float4(hit.position, float(hit.hit));
    results[group.x * 4 + 1] = float4(hit.normal, covered.coverage);
    results[group.x * 4 + 2] = float4(hit.uv, dx);
    results[group.x * 4 + 3] = float4(dy, float(covered.hit), dot(hit.view, hit.normal));
}
