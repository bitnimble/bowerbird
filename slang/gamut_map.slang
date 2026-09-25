// How a picture is brought inside what its target can show - an sRGB file, or a printer's ink on
// its paper - from an HDR grade as well as an SDR one. The intents are ICC's and keep ICC's promises:
// perceptual compresses the whole range so gradients survive, relative colorimetric leaves every
// colour the target can show exactly where it is and clips the rest.
module gamut_map;

import prelude;
import light;
import primaries;

public static const uint INTENT_PERCEPTUAL = 0;
public static const uint INTENT_RELATIVE = 1;

static const float CHROMA_KNEE = 0.9;

/// Where a target's gamut ends.
public interface IGamut
{
    /// How many times `chroma` a colour of `luma` can carry and stay inside; zero where only grey can.
    public float limit(float luma, float3 chroma);
}

/// An sRGB file's gamut, which is a cube in its own primaries.
public struct SrgbCube : IGamut
{
    public float limit(float luma, float3 chroma)
    {
        let towards = mul(R2020_TO_SRGB, chroma);
        var limit = 1e30;
        for (uint channel = 0; channel < 3; channel += 1) {
            let step = towards[channel];
            if (step > 0.0) { limit = min(limit, (1.0 - luma) / step); }
            if (step < 0.0) { limit = min(limit, -luma / step); }
        }
        return max(limit, 0.0);
    }
};

/// `graded` as a share of `white`: rolled under it for perceptual, and left for relative
/// colorimetric, which clips at the gamut instead. `scene_peak` is the brightest `graded` reaches.
public float3 toned(Colour<DisplayNits> graded, Light<DisplayNits> scene_peak, Light<DisplayNits> white, uint intent)
{
    if (intent == INTENT_PERCEPTUAL) { return within(rolled(graded, rolloff(scene_peak, white, white)), white).v / white.v; }
    return max(graded.v, float3(0.0)) / white.v;
}

/// `colour`, a share of the target's white, brought inside `gamut` at its own luma and hue.
public float3 mapped<G : IGamut>(float3 colour, G gamut, uint intent)
{
    let luma = dot(LUMA, colour);
    if (luma <= 0.0) { return float3(0.0); }
    if (luma >= 1.0) { return float3(1.0); }
    let chroma = colour - luma;
    let limit = gamut.limit(luma, chroma);
    if (limit <= 0.0) { return float3(luma); }
    let reach = 1.0 / limit;
    if (intent != INTENT_PERCEPTUAL) { return reach <= 1.0 ? colour : luma + chroma / reach; }
    if (reach <= CHROMA_KNEE) { return colour; }
    let compressed = CHROMA_KNEE + (1.0 - CHROMA_KNEE) * (reach - CHROMA_KNEE) / (reach + 1.0 - 2.0 * CHROMA_KNEE);
    return luma + chroma * (compressed / reach);
}

/// `colour` over a target whose darkest is `black`, both shares of its white: lifted onto it with
/// every step kept where `compensated`, and floored at it otherwise.
public float3 onto_black(float3 colour, float3 black, bool compensated)
{
    return compensated ? black + (1.0 - black) * colour : max(colour, black);
}
