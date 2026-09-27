module print_environment;
import prelude;

static const float ENVIRONMENT_PI = 3.141592653589793;

/// The room a print hangs in, an equirectangular HDR map already turned to face the print
/// (`print_environment_build.slang`), in Rec.2020 of an arbitrary scale that the lamp calibration
/// takes out.
[vk::binding(4, 1)] public Texture2D<float4> print_environment_map;
[vk::binding(5, 1)] public SamplerState print_environment_sampler;

/// Where `direction` falls on the map: straight past the print, away from the reader, is the middle.
/// Where the lamp calibration's room starts: nine spherical harmonics, three channels each.
public static const uint ROOM_BANDS = 7;

public float2 environment_uv(float3 direction)
{
    return float2(0.5 + atan2(direction.x, -direction.z) / (2.0 * ENVIRONMENT_PI),
        acos(clamp(direction.y, -1.0, 1.0)) / ENVIRONMENT_PI);
}

public float3 environment_direction(float2 uv)
{
    let around = (uv.x - 0.5) * 2.0 * ENVIRONMENT_PI;
    let down = uv.y * ENVIRONMENT_PI;
    return float3(sin(down) * sin(around), cos(down), -sin(down) * cos(around));
}

/// A Radiance texel as `print::environment::decode` packs it, in linear BT.709.
public float3 rgbe_radiance(uint word)
{
    let exponent = word >> 24;
    let mantissa = float3(float(word & 0xffu), float((word >> 8) & 0xffu), float((word >> 16) & 0xffu));
    return exponent == 0u ? float3(0.0) : mantissa * exp2(float(exponent) - 136.0);
}

/// What a source texel keeps once the lamp is taken out of it: within `cone` of the lamp, nothing
/// brighter than `threshold`.
public float3 without_lamp(float3 colour, float3 direction, float3 lamp, float cone, float threshold)
{
    let luma = dot(LUMA709, colour);
    return dot(direction, lamp) > cone && luma > threshold ? colour * threshold / luma : colour;
}

/// The room's radiance along a world direction, as a lobe `spread` radians wide reads it.
public float3 environment_radiance(float3 direction, float spread)
{
    uint width;
    uint height;
    uint levels;
    print_environment_map.GetDimensions(0, width, height, levels);
    let texel = 2.0 * ENVIRONMENT_PI / float(width);
    let lod = min(log2(max(spread, texel) / texel), float(levels - 1));
    let finer = floor(lod);
    let uv = environment_uv(direction);
    let size = float2(float(width), float(height));
    let fine = cubic_at(uv, size, uint(finer));
    return lod == finer ? fine : lerp(fine, cubic_at(uv, size, uint(finer) + 1), lod - finer);
}

/// A cubic B-spline over one level, in four bilinear taps.
///
/// **Bilinear alone draws the texel grid into anything brighter than white**: the roll-off onto the
/// display flattens the top of each linear ramp, so a sunlit window reads as a staircase of squares.
float3 cubic_at(float2 uv, float2 size, uint level)
{
    let texels = max(floor(size / float(1u << level)), float2(1.0));
    let at = uv * texels - 0.5;
    let cell = floor(at);
    let f = at - cell;
    let w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
    let w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
    let w3 = f * f * f / 6.0;
    let w2 = 1.0 - w0 - w1 - w3;
    let low = w0 + w1;
    let high = w2 + w3;
    let near = (cell - 0.5 + w1 / low) / texels;
    let far = (cell + 1.5 + w3 / high) / texels;
    return low.y * (low.x * map_at(near, level) + high.x * map_at(float2(far.x, near.y), level))
        + high.y * (low.x * map_at(float2(near.x, far.y), level) + high.x * map_at(far, level));
}

float3 map_at(float2 uv, uint level)
{
    return print_environment_map.SampleLevel(print_environment_sampler, uv, float(level)).rgb;
}

static const float READER_LOW = 0.45;
static const float READER_HALF_WIDTH = 0.17;
static const float READER_RISE = 0.11;
static const float READER_DROP = 0.55;
static const float READER_EDGE = 0.05;

/// What the reader's own body leaves of the room along a direction.
///
/// **A print faced square on mirrors the reader, and the reader is not a lamp.** A body is darker
/// than the wall it stands against, which is why a gloss print looks its blackest held straight
/// rather than turned, and a band much wider than the body leaves a sheet under glass with no room
/// in it to reflect at all. Nothing here shadows the *diffuse* side: the same solid angle is worth
/// well under a percent of the illuminance, where a mirror reads one direction and little else.
///
/// **A head is not a silhouette.** Someone in front of a picture is a third of a radian across and
/// most of a radian tall, standing on the floor rather than floating at eye level, so what a pane
/// mirrors is a tall shape hanging below the direction the eye is on - which is why a framed print
/// tilted down its own height still has the reader in it, and one tilted up does not.
///
/// The silhouette washes out as the lobe reading it opens up, in the ratio the two solid angles
/// stand in, so it is a gloss sheet's reflection and barely a matte one's.
public float reader_share(float3 direction, float3 world_view, float spread)
{
    let towards = dot(direction, world_view);
    // The reader stands along the view and nowhere else: an offset across the view runs to zero
    // again for a direction pointing back past them, which would put the body in a sheet's most
    // grazing reflection - the one direction that certainly misses it.
    if (towards <= 0.0) { return 1.0; }
    let side = cross(world_view, float3(0.0, 1.0, 0.0));
    let width = length(side);
    // Looking along the room's own up, where the body has no side to stand to.
    if (width < 1e-4) { return 1.0; }
    let across = side / width;
    let raise = cross(across, world_view);
    let offset = direction / towards - world_view;
    let sideways = max(abs(dot(offset, across)) - READER_HALF_WIDTH, 0.0);
    let along = dot(offset, raise);
    let past = max(max(-along - READER_DROP, along - READER_RISE), 0.0);
    let outside = length(float2(sideways, past));
    let solid = 4.0 * READER_HALF_WIDTH * (READER_RISE + READER_DROP);
    let lobe = solid / (solid + ENVIRONMENT_PI * spread * spread);
    return lerp(1.0, READER_LOW, lobe * (1.0 - smoothstep(0.0, READER_EDGE + spread, outside)));
}
