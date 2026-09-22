import print_scene;
import print_parameters;
import print_geometry;
import print_material;
import print_light;
import px;

struct Probe { float4 material; float4 position; };
[vk::binding(0, 0)] StructuredBuffer<Probe> probes;
[vk::binding(1, 0)] RWStructuredBuffer<float4> results;
groupshared float4 partial[64];

[shader("compute")]
[numthreads(1, 1, 1)]
void emitter(uint3 group : SV_GroupID)
{
    let at = probes[group.x].material.xy;
    let distance = exactly<PrintUnit>(print.surface.x);
    let half_width = exactly<PrintUnit>(print.surface.y);
    let direction = normalize(float3(at.x * half_width.d, at.y * half_width.d / SOFTBOX_ASPECT, distance.d));
    let hit = softbox_hit(float3(0.0), direction, float3(1.0, 0.0, 0.0), float3(0.0, 1.0, 0.0), distance, half_width);
    let radiance = print.illumination.x * print_light_calibration[0];
    results[group.x * 2] = float4(radiance * softbox_profile(at), softbox_profile(hit.yz), hit.x, radiance);
    results[group.x * 2 + 1] = float4(0.0);
}

[shader("compute")]
[numthreads(64, 1, 1)]
void material(uint3 group : SV_GroupID, uint lane : SV_GroupIndex)
{
    let probe = probes[group.x].material;
    let roughness = probe.x;
    let cosine = probe.y;
    let view = float3(sqrt(1.0 - cosine * cosine), 0.0, cosine);
    var sum = float4(0.0, 0.0, 0.0, 1.0);
    for (uint i = lane; i < 262144; i += 64) {
        let z = (float(i / 512) + 0.5) / 512.0;
        let phi = (float(i % 512) + 0.5) * (2.0 * PRINT_PI / 512.0);
        let r = sqrt(1.0 - z * z);
        let incident = float3(r * cos(phi), r * sin(phi), z);
        let brdf = paper_brdf(float3(probe.z), view, incident, roughness).x;
        let reversed = paper_brdf(float3(probe.z), incident, view, roughness).x;
        let specular = specular_brdf(view, incident, roughness * roughness, print.material.w);
        sum.x += specular * z * (2.0 * PRINT_PI / 262144.0);
        sum.y += (brdf - specular) * z * (2.0 * PRINT_PI / 262144.0);
        sum.z = max(sum.z, abs(brdf - reversed) / max(brdf, 1e-6));
        sum.w = min(sum.w, brdf);
    }
    partial[lane] = sum;
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = 32; stride > 0; stride /= 2) {
        if (lane < stride) {
            partial[lane].xy += partial[lane + stride].xy;
            partial[lane].z = max(partial[lane].z, partial[lane + stride].z);
            partial[lane].w = min(partial[lane].w, partial[lane + stride].w);
        }
        GroupMemoryBarrierWithGroupSync();
    }
    if (lane == 0) {
        results[group.x * 2] = partial[0];
        results[group.x * 2 + 1] = float4(dielectric_fresnel(cosine, print.material.w),
            paper_albedo(cosine, roughness), paper_average_albedo(roughness),
            directional_albedo(cosine, roughness, print.material.w, 32768));
    }
}

[shader("compute")]
[numthreads(1, 1, 1)]
void lighting(uint3 group : SV_GroupID)
{
    let probe = probes[group.x];
    PrintHit hit;
    hit.hit = true;
    hit.coverage = 1.0;
    hit.normal = float3(0.0, 0.0, 1.0);
    hit.view = normalize(float3(probe.material.y, 0.0, 1.0));
    hit.position = probe.position.xyz;
    hit.uv = float2(0.5);
    hit.material = PHOTO;
    hit.half = float2(1.0);
    let value = reflected_print_samples(float3(probe.material.z), hit, probe.material.x, uint(probe.material.w));
    let distance = exactly<PrintUnit>(print.surface.x);
    let half_width = exactly<PrintUnit>(print.surface.y);
    let emitter = softbox_hit(hit.position, float3(0.0, 0.0, 1.0),
        float3(1.0, 0.0, 0.0), float3(0.0, 1.0, 0.0), distance, half_width);
    results[group.x * 2] = float4(value.v, emitter.x);
    results[group.x * 2 + 1] = float4(paper_roughness(hit.position, float2(0.0)),
        paper_roughness(hit.position, float2(1.0)),
        paper_hit(float2(64.0, 48.0), float2(128.0, 96.0), float2(300.0, 200.0)).position.z * print.surface.z, 0.0);
}
