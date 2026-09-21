import print_light;

struct Softbox { float4 shape; };
[vk::binding(0, 0)] ConstantBuffer<Softbox> light;
[vk::binding(1, 0)] RWStructuredBuffer<float> calibration;
groupshared float2 partial[64];

[shader("compute")]
[numthreads(64, 1, 1)]
void calibrate(uint lane : SV_GroupIndex)
{
    let half_shape = float2(light.shape.x, light.shape.x / SOFTBOX_ASPECT);
    var sum = float2(0.0);
    for (uint i = lane; i < 16384; i += 64) {
        let at = (float2(i % 128, i / 128) + 0.5) / 64.0 - 1.0;
        let offset = at * half_shape;
        let distance_squared = 1.0 + dot(offset, offset);
        let weight = softbox_profile(at) / (distance_squared * distance_squared);
        let incident = max(dot(light.shape.yzw, float3(offset, 1.0)), 0.0);
        sum += weight * float2(1.0, incident);
    }
    partial[lane] = sum;
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = 32; stride > 0; stride /= 2) {
        if (lane < stride) { partial[lane] += partial[lane + stride]; }
        GroupMemoryBarrierWithGroupSync();
    }
    if (lane == 0) {
        calibration[0] = 16384.0 / (4.0 * half_shape.x * half_shape.y * partial[0].x);
        calibration[1] = partial[0].y / partial[0].x;
    }
}
