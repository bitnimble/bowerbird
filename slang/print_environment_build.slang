// An environment's `.hdr` onto the map the print reads, then its mip chain.
import print_environment;
import primaries;

struct Build
{
    /// The level written, and how many texels the map is turned by.
    uint4 size;
    /// Where the lamp is on the source map, and the cosine of the cone it is taken from.
    float4 lamp;
    /// The radiance above which a texel in that cone is the lamp, and the scale the map is stored at.
    float4 levels;
};

[vk::binding(0, 0)] ConstantBuffer<Build> build;
[vk::binding(1, 0)] StructuredBuffer<uint> rgbe;
[vk::binding(2, 0)] [format("rgba16f")] WTexture2D<float4> written;
[vk::binding(3, 0)] Texture2D<float4> finer;

/// f16's largest finite value, rounded down, so an unclipped light stays a light rather than
/// becoming an infinity every lobe that reads it inherits.
static const float HALF_MAX = 65000.0;

[shader("compute")]
[numthreads(8, 8, 1)]
void unpack(uint3 id : SV_DispatchThreadID)
{
    if (any(id.xy >= build.size.xy)) { return; }
    let source = uint2((id.x + build.size.z) % build.size.x, id.y);
    let direction = environment_direction((float2(source) + 0.5) / float2(build.size.xy));
    // The lamp is drawn by the direct term, so the map keeps only what it leaves of the room.
    let colour = without_lamp(rgbe_radiance(rgbe[source.y * build.size.x + source.x]), direction,
        environment_direction(build.lamp.xy), build.lamp.z, build.levels.x);
    written.Store(id.xy, float4(min(mul(SRGB_TO_R2020, colour) * build.levels.y, float3(HALF_MAX)), 1.0));
}

[shader("compute")]
[numthreads(8, 8, 1)]
void shrink(uint3 id : SV_DispatchThreadID)
{
    if (any(id.xy >= build.size.xy)) { return; }
    uint width;
    uint height;
    finer.GetDimensions(width, height);
    let last = int2(int(width), int(height)) - 1;
    let at = int2(id.xy) * 2;
    var sum = float4(0.0);
    for (uint corner = 0; corner < 4; corner += 1) {
        sum += finer.Load(int3(min(at + int2(int(corner & 1u), int(corner >> 1)), last), 0));
    }
    written.Store(id.xy, sum * 0.25);
}
