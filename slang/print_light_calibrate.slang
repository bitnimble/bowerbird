import print_light;
import illuminant;
import primaries;
import prelude;
import print_glass;
import print_environment;

struct Lamp { float4 shape; float4 temperature; };
[vk::binding(0, 0)] ConstantBuffer<Lamp> light;
[vk::binding(1, 0)] RWStructuredBuffer<float> calibration;
groupshared float2 partial[64];
groupshared float3 room_partial[64 * 9];

static const uint ROOM_ACROSS = 256;
static const uint ROOM_UP = 128;

[shader("compute")]
[numthreads(64, 1, 1)]
void calibrate(uint lane : SV_GroupIndex)
{
    room_harmonics(lane);
    let radius = light.shape.x;
    var sum = float2(0.0);
    for (uint i = lane; i < 16384; i += 64) {
        let at = (float2(i % 128, i / 128) + 0.5) / 64.0 - 1.0;
        let offset = at * radius;
        let distance_squared = 1.0 + dot(offset, offset);
        let weight = lamp_profile(at) / (distance_squared * distance_squared);
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
        calibration[0] = 16384.0 / (4.0 * radius * radius * partial[0].x);
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

/// The room's radiance projected onto the nine spherical harmonics through the second band, each
/// lane a share of the sphere, summed into `room_partial`'s first nine.
void room_harmonics(uint lane)
{
    let pi = 3.141592653589793;
    float3 bands[9] = { float3(0.0), float3(0.0), float3(0.0), float3(0.0), float3(0.0), float3(0.0),
        float3(0.0), float3(0.0), float3(0.0) };
    for (uint i = lane; i < ROOM_ACROSS * ROOM_UP; i += 64) {
        let up = (float(i / ROOM_ACROSS) + 0.5) / float(ROOM_UP) * 2.0 - 1.0;
        let around = (float(i % ROOM_ACROSS) + 0.5) / float(ROOM_ACROSS) * 2.0 * pi;
        let flat = sqrt(max(1.0 - up * up, 0.0));
        let d = float3(flat * sin(around), up, flat * cos(around));
        let radiance = environment_radiance(d, 2.0 * pi / float(ROOM_ACROSS)) * 4.0 * pi / float(ROOM_ACROSS * ROOM_UP);
        bands[0] += radiance * 0.282095;
        bands[1] += radiance * 0.488603 * d.y;
        bands[2] += radiance * 0.488603 * d.z;
        bands[3] += radiance * 0.488603 * d.x;
        bands[4] += radiance * 1.092548 * d.x * d.y;
        bands[5] += radiance * 1.092548 * d.y * d.z;
        bands[6] += radiance * 0.315392 * (3.0 * d.z * d.z - 1.0);
        bands[7] += radiance * 1.092548 * d.x * d.z;
        bands[8] += radiance * 0.546274 * (d.x * d.x - d.y * d.y);
    }
    for (uint band = 0; band < 9; band += 1) { room_partial[lane * 9 + band] = bands[band]; }
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = 32; stride > 0; stride /= 2) {
        if (lane < stride) {
            for (uint band = 0; band < 9; band += 1) {
                room_partial[lane * 9 + band] += room_partial[(lane + stride) * 9 + band];
            }
        }
        GroupMemoryBarrierWithGroupSync();
    }
}

/// The room's radiance and its illuminance, per lux of ambient, band by band in `ROOM_BANDS` on.
///
/// The ambient setting is the illuminance an upright print facing the reader stands in, so the room
/// is scaled to deliver exactly that and its shape decides the rest. A Lambert cosine keeps three
/// bands of any surround and a twenty-fourth of the fourth, so the second-order fit *is* the
/// illuminance rather than an approximation of it - windows and all.
void room_calibration()
{
    let pi = 3.141592653589793;
    let lambert = float3(pi, 2.0 * pi / 3.0, pi / 4.0);
    float3 irradiance[9];
    for (uint band = 0; band < 9; band += 1) {
        irradiance[band] = room_partial[band] * (band == 0 ? lambert.x : band < 4 ? lambert.y : lambert.z);
    }
    // Facing the reader, z = 1: every band that is not zonal about z vanishes there.
    let facing = irradiance[0] * 0.282095 + irradiance[2] * 0.488603 + irradiance[6] * 0.315392 * 2.0;
    let scale = 1.0 / dot(LUMA, facing);
    calibration[6] = scale;
    for (uint band = 0; band < 9; band += 1) {
        for (uint channel = 0; channel < 3; channel += 1) {
            calibration[ROOM_BANDS + band * 3 + channel] = scale * irradiance[band][channel];
        }
    }
}
