// The lamp an environment's build takes out of its source map, measured: what
// `print::environment::Environment::lighting` is held to.
import print_environment;
import prelude;
import primaries;

struct Build { uint4 size; float4 lamp; float4 levels; };
[vk::binding(0, 0)] ConstantBuffer<Build> build;
[vk::binding(1, 0)] StructuredBuffer<uint> rgbe;
[vk::binding(2, 0)] RWStructuredBuffer<float> measured;
groupshared float4 lit[64];
groupshared float3 tinted[64];

/// The lamp's luminance times solid angle along the direction it arrives from, then that luminance
/// alone, then its colour in Rec.2020 - all over the source map, unturned.
[shader("compute")]
[numthreads(64, 1, 1)]
void measure(uint lane : SV_GroupIndex)
{
    let pi = 3.141592653589793;
    let lamp = environment_direction(build.lamp.xy);
    var sum = float4(0.0);
    var tint = float3(0.0);
    for (uint i = lane; i < build.size.x * build.size.y; i += 64) {
        let uv = (float2(float(i % build.size.x), float(i / build.size.x)) + 0.5) / float2(build.size.xy);
        let direction = environment_direction(uv);
        let solid = 2.0 * pi * pi / float(build.size.x * build.size.y) * sin(pi * uv.y);
        let colour = rgbe_radiance(rgbe[i]);
        let taken = (colour - without_lamp(colour, direction, lamp, build.lamp.z, build.levels.x)) * solid;
        let luma = dot(LUMA709, taken);
        sum += float4(direction * luma, luma);
        tint += mul(SRGB_TO_R2020, taken);
    }
    lit[lane] = sum;
    tinted[lane] = tint;
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = 32; stride > 0; stride /= 2) {
        if (lane < stride) {
            lit[lane] += lit[lane + stride];
            tinted[lane] += tinted[lane + stride];
        }
        GroupMemoryBarrierWithGroupSync();
    }
    if (lane == 0) {
        for (uint at = 0; at < 4; at += 1) { measured[at] = lit[0][at]; }
        for (uint at = 0; at < 3; at += 1) { measured[4 + at] = tinted[0][at]; }
    }
}
