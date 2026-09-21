import prelude;
import light;
import px;

[vk::binding(0, 0)] Texture2D<float4> reference;
[vk::binding(1, 0)] Texture2D<float4> candidate;
[vk::binding(2, 0)] RWStructuredBuffer<float4> result;
groupshared float4 errors[64];
groupshared float4 levels[64];
groupshared float4 worst[64];

float3 nits(float3 coded)
{
    return sign(coded) * float3(srgb_eotf(abs(coded.r)), srgb_eotf(abs(coded.g)), srgb_eotf(abs(coded.b))) * 203.0;
}

[shader("compute")]
[numthreads(64, 1, 1)]
void compare(uint lane : SV_GroupIndex)
{
    uint width;
    uint height;
    reference.GetDimensions(width, height);
    var error = float4(0.0);
    var level = float4(0.0);
    var location = float4(0.0);
    for (uint i = lane; i < width * height; i += 64) {
        let at = int3(i % width, i / width, 0);
        Colour<DisplayNits> expected;
        expected.v = nits(reference.Load(at).rgb);
        Colour<DisplayNits> actual;
        actual.v = nits(candidate.Load(at).rgb);
        let delta = abs(actual.v - expected.v);
        let relative = delta / max(abs(expected.v), float3(203.0));
        let channel = delta.r >= delta.g && delta.r >= delta.b ? 0 : delta.g >= delta.b ? 1 : 2;
        if (delta[channel] > error.x) { location = float4(float2(at.xy), expected.v[channel], actual.v[channel]); }
        error.x = max(error.x, max(delta.x, max(delta.y, delta.z)));
        error.y = max(error.y, max(relative.x, max(relative.y, relative.z)));
        error.z += dot(relative, relative) / (3.0 * float(width * height));
        error.w += float(any(isnan(actual.v)) || any(isinf(actual.v)));
        level.x = max(level.x, max(expected.v.x, max(expected.v.y, expected.v.z)));
        level.y = max(level.y, max(actual.v.x, max(actual.v.y, actual.v.z)));
        level.z += dot(expected.v, float3(1.0)) / (3.0 * float(width * height));
        level.w += dot(actual.v, float3(1.0)) / (3.0 * float(width * height));
    }
    errors[lane] = error;
    levels[lane] = level;
    worst[lane] = location;
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = 32; stride > 0; stride /= 2) {
        if (lane < stride) {
            if (errors[lane + stride].x > errors[lane].x) { worst[lane] = worst[lane + stride]; }
            errors[lane].xy = max(errors[lane].xy, errors[lane + stride].xy);
            errors[lane].zw += errors[lane + stride].zw;
            levels[lane].xy = max(levels[lane].xy, levels[lane + stride].xy);
            levels[lane].zw += levels[lane + stride].zw;
        }
        GroupMemoryBarrierWithGroupSync();
    }
    if (lane == 0) {
        result[0] = errors[0];
        result[1] = levels[0];
        result[2] = worst[0];
    }
}
