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

static const uint WAVES = 32;
static const float WAVE_TAU = 6.283185307179586;

/// The gradient of a sum of cosines in hashed directions and phases, spread evenly in log frequency
/// over three octaves from 0.3 cycles a unit, with slope falling as the root of frequency; scaled to
/// an RMS of one along either axis. One band of frequencies reads as a woven pattern, and value
/// noise's cells as squares, once a magnified sheet puts either across many pixels.
public float2 wave_noise_gradient(float2 at)
{
    var gradient = float2(0.0);
    var power = 0.0;
    // Unrolled so every wave's hashes, direction and slope fold to constants, leaving one sine a wave.
    [ForceUnroll]
    for (uint wave = 0; wave < WAVES; wave += 1) {
        let angle = 0.5 * WAVE_TAU * cell_value(int2(int(wave), 1));
        let octaves = 3.0 * (float(wave) + 0.5 * (cell_value(int2(int(wave), 2)) + 1.0)) / float(WAVES);
        let frequency = WAVE_TAU * 0.3 * exp2(octaves);
        let slope = rsqrt(frequency);
        let direction = frequency * float2(cos(angle), sin(angle));
        let phase = WAVE_TAU * cell_value(int2(int(wave), 3));
        gradient -= slope * normalize(direction) * sin(dot(direction, at) + phase);
        power += slope * slope;
    }
    return gradient / sqrt(0.25 * power);
}
