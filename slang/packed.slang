// Two sixteen-bit samples to a word, low half first: half floats in a scene-linear frame, PQ codes
// in a coded one.
//
// A sample is sixteen bits and the smallest thing a shader can address is thirty-two, so widening
// it would double a 361MB frame at 61MP for arithmetic that rounds back to sixteen bits anyway.
module packed;

import prelude;
import px;

/// The half of `word` that sample `at` occupies.
///
/// **The only statement of which half is which, and that is the reason it is a module.** The
/// predicate reads correctly written either way round - `(at & 1) == 0` picking the low half, or
/// `(at & 1) == 1` picking the high one - so a copy that inverted it would still look right, and a
/// frame read at the wrong parity is every sample swapped with its neighbour rather than a failure.
public uint half_of(uint word, uint at)
{
    return select((at & 1) == 0, word & 0xffff, word >> 16);
}

/// A scene-linear sample's level, in counts of the sensor's full scale, off its half.
///
/// **A half float of the level over full scale, not a count**, so light past the clip that the
/// highlight reconstruction recovers has somewhere to go. A coded frame's halves are PQ codes and
/// never come through here. `resident::level_of_bits` is the host's.
public float level_of(uint bits)
{
    return f16tof32(bits) * FULL_SCALE;
}

/// Saturating at the largest finite half, so light past it is stored bright rather than infinite.
public uint bits_of(float level)
{
    return half_bits(min(level / FULL_SCALE, LARGEST_HALF));
}

/// `value` as a half, rounded to nearest even, the same on every adapter.
///
/// **Never `f32tof16` or `packHalf2x16`.** Vulkan leaves their rounding and their denormals to the
/// driver: radv truncates (AMD's `v_cvt_pkrtz`), so a stored frame comes back up to a whole half
/// step darker there than on NVIDIA.
public uint half_bits(float value)
{
    let bits = asuint(value);
    let sign = (bits >> 16) & 0x8000;
    let magnitude = bits & 0x7fffffff;
    if (magnitude > 0x7f800000) { return sign | 0x7e00; }
    // 65520 and up, infinity included, round past the largest finite half.
    if (magnitude >= 0x477ff000) { return sign | 0x7c00; }
    let exponent = magnitude >> 23;
    if (exponent >= 113) {
        let rebased = magnitude - (112u << 23);
        return sign | ((rebased + 0xfff + ((rebased >> 13) & 1)) >> 13);
    }
    if (exponent < 102) { return sign; }
    let mantissa = (magnitude & 0x7fffff) | 0x800000;
    let shift = 126 - exponent;
    return sign | ((mantissa + (1u << (shift - 1)) - 1 + ((mantissa >> shift) & 1)) >> shift);
}

/// Two halves to a word, low first, through [`half_bits`].
public uint pack_halves(float2 value)
{
    return half_bits(value.x) | (half_bits(value.y) << 16);
}

static const float LARGEST_HALF = 65504.0;

/// The sensor's full scale, in the levels a scene-linear sample is counted in.
public static const float FULL_SCALE = 65535.0;

public uint3 bits_of(float3 level)
{
    return uint3(bits_of(level.r), bits_of(level.g), bits_of(level.b));
}

/// The pixel pair starting at even pixel `first` of a frame three codes to a pixel: its three words,
/// of which only the first one and a half exist where `b` would fall past the end of an odd-sized
/// frame.
///
/// `keep_padding` is for a frame written in place, whose last half-word is not this pass's to
/// clear.
public void store_pair(
    RWStructuredBuffer<uint> words, Wide<Drawn> first, uint3 a, uint3 b, bool paired, bool keep_padding)
{
    let word = first * 3 / 2;
    words[word] = a.r | (a.g << 16);
    if (paired) {
        words[word + 1] = a.b | (b.r << 16);
        words[word + 2] = b.g | (b.b << 16);
        return;
    }
    var padding = 0u;
    if (keep_padding) { padding = words[word + 1] & 0xffff0000; }
    words[word + 1] = padding | a.b;
}

/// The nearest PQ code to a quantity of light, in `Base::light_of_code`'s table.
///
/// **Not ST 2084 evaluated here: the round trip has to be an identity.** A `f32` PQ against the
/// table the host built in `f64` disagrees by a count on about a fifth of a frame. The curve only
/// says where to start; the table decides, so a pixel every tap agreed on comes back as its own code.
public uint code_of_pq_light(StructuredBuffer<float> light_of_code, float light)
{
    var near = 0u;
    if (light == light) {
        let y = pow(clamp(light, 0.0, 1.0), PQ_M1);
        let signal = pow((PQ_C1 + PQ_C2 * y) / (1.0 + PQ_C3 * y), PQ_M2);
        near = uint(clamp(round(signal * 65535.0), 0.0, 65535.0));
    }
    return nearest_from(light_of_code, light, near);
}

/// The same in `Base::light_of_level`'s table, whose codes are half floats of the light itself.
public uint code_of_level_light(StructuredBuffer<float> light_of_level, float light)
{
    // Masked rather than signed: a negative zero would start the walk in the negative halves.
    let near = light == light ? half_bits(max(light, 0.0)) & 0x7fff : 0u;
    return nearest_from(light_of_level, light, near);
}

public uint3 codes_of_pq_light(StructuredBuffer<float> light_of_code, float3 light)
{
    return uint3(
        code_of_pq_light(light_of_code, light.r),
        code_of_pq_light(light_of_code, light.g),
        code_of_pq_light(light_of_code, light.b));
}

public uint3 codes_of_level_light(StructuredBuffer<float> light_of_level, float3 light)
{
    return uint3(
        code_of_level_light(light_of_level, light.r),
        code_of_level_light(light_of_level, light.g),
        code_of_level_light(light_of_level, light.b));
}

static const uint NEAR = 2;

/// The first code at or above `light` in the ascending table, or its predecessor where that is
/// nearer, searched within `NEAR` of `near` when the answer lies there and the whole table otherwise.
uint nearest_from(StructuredBuffer<float> table, float light, uint near)
{
    var lo = near - min(near, NEAR);
    var hi = min(near + NEAR, 65535u);
    if ((lo > 0 && !(table[lo - 1] < light)) || (hi < 65535 && table[hi] < light)) {
        lo = 0;
        hi = 65535;
    }
    while (lo < hi) {
        let mid = (lo + hi) / 2;
        if (table[mid] < light) { lo = mid + 1; } else { hi = mid; }
    }
    if (lo > 0 && light - table[lo - 1] < table[lo] - light) {
        return lo - 1;
    }
    return lo;
}
