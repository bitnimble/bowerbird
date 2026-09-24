module print_noise;

float cell_value(int2 cell)
{
    var hash = uint(cell.x) * 0x8da6b343u ^ uint(cell.y) * 0xd8163841u;
    hash ^= hash >> 16;
    hash *= 0x7feb352du;
    hash ^= hash >> 15;
    return float(hash & 0x00ffffffu) / 8388607.5 - 1.0;
}

/// Smoothly interpolated value noise on `[-1, 1]`, in cells of one.
public float value_noise(float2 at)
{
    let cell = int2(floor(at));
    let fraction = frac(at);
    let blend = fraction * fraction * (3.0 - 2.0 * fraction);
    return lerp(lerp(cell_value(cell), cell_value(cell + int2(1, 0)), blend.x),
        lerp(cell_value(cell + int2(0, 1)), cell_value(cell + int2(1, 1)), blend.x), blend.y);
}

/// [`value_noise`]'s gradient, per cell, whose RMS along either axis is `VALUE_NOISE_SLOPE`.
public float2 value_noise_gradient(float2 at)
{
    let cell = int2(floor(at));
    let fraction = frac(at);
    let blend = fraction * fraction * (3.0 - 2.0 * fraction);
    let rate = 6.0 * fraction * (1.0 - fraction);
    let corner = cell_value(cell);
    let across = cell_value(cell + int2(1, 0));
    let up = cell_value(cell + int2(0, 1));
    let diagonal = cell_value(cell + int2(1, 1));
    return float2(rate.x * lerp(across - corner, diagonal - up, blend.y),
        rate.y * (lerp(up, diagonal, blend.x) - lerp(corner, across, blend.x)));
}

public static const float VALUE_NOISE_SLOPE = 0.771;
