import print_light;
import illuminant;
import primaries;
import prelude;
import print_glass;
import print_environment;

struct Softbox { float4 shape; float4 temperature; };
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
        let xyz = xyz_of(xy_of(light.temperature.x, 0.0));
        let colour = mul(CONE_TO_R2020, mul(XYZ_TO_CONE, xyz));
        let normalized = colour / dot(LUMA, colour);
        calibration[2] = normalized.r;
        calibration[3] = normalized.g;
        calibration[4] = normalized.b;
        calibration[5] = glass_diffuse_transmittance();
        room_calibration();
    }
}

/// The room's radiance and its illuminance, per lux of ambient.
///
/// The ambient setting is the illuminance an upright print stands in, so the room is scaled to
/// deliver exactly that and its shape decides the rest. A Lambert cosine keeps three zonal bands of
/// any surround and a twenty-fourth of the fourth, so the second-order fit below *is* the
/// illuminance rather than an approximation of it.
void room_calibration()
{
    let pi = 3.141592653589793;
    var bands = float3(0.0);
    for (uint i = 0; i < 1024; i += 1) {
        let up = (float(i) + 0.5) / 512.0 - 1.0;
        let radiance = room_profile(up, 0.0) / 512.0;
        bands += radiance * float3(0.5, 1.5 * up, 2.5 * 0.5 * (3.0 * up * up - 1.0));
    }
    let lambert = float3(pi, 2.0 * pi / 3.0, pi / 4.0) * bands;
    let scale = 1.0 / (lambert.x - 0.5 * lambert.z);
    calibration[6] = scale;
    calibration[7] = scale * lambert.x;
    calibration[8] = scale * lambert.y;
    calibration[9] = scale * lambert.z;
}
