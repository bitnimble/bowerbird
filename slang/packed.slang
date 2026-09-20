// Two `u16` to a word, low half first, which is how every frame buffer in this pipeline is held.
//
// The frame stays packed from the coding to the draw: a sample is sixteen bits and the smallest
// thing a shader can address is thirty-two, so widening it would double a 361MB frame at 61MP for
// arithmetic that rounds back into `u16` anyway.
module packed;

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

/// Pixel pair `pair` of a frame three codes to a pixel: its three words, of which only the first
/// one and a half exist where `b` would fall past the end of an odd-sized frame.
///
/// `keep_padding` is for a frame written in place, whose last half-word is not this pass's to
/// clear.
public void store_pair(RWStructuredBuffer<uint> words, uint pair, uint3 a, uint3 b, bool paired, bool keep_padding)
{
    let word = pair * 3;
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

/// The nearest code to a quantity of light, by searching the table the codes decode through.
///
/// **Not ST 2084 evaluated here: the round trip has to be an identity.** A `f32` PQ against the
/// table the host built in `f64` disagrees by a count on about a fifth of a frame; a search of the
/// same table cannot, so a pixel every tap agreed on comes back as its own code.
public uint code_of_light(StructuredBuffer<float> light_of_code, float light)
{
    uint lo = 0;
    uint hi = 65535;
    while (lo < hi) {
        let mid = (lo + hi) / 2;
        if (light_of_code[mid] < light) { lo = mid + 1; } else { hi = mid; }
    }
    // The first code at or above the target; its predecessor may be the nearer of the two.
    if (lo > 0 && light - light_of_code[lo - 1] < light_of_code[lo] - light) {
        return lo - 1;
    }
    return lo;
}

public uint3 codes_of_light(StructuredBuffer<float> light_of_code, float3 light)
{
    return uint3(
        code_of_light(light_of_code, light.r),
        code_of_light(light_of_code, light.g),
        code_of_light(light_of_code, light.b));
}
