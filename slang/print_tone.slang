// How a picture's highlights are fitted under a white that cannot go higher: paper's, or an sRGB
// proof's diffuse white.
//
// The display has one answer to this and no reason to offer another: `rolled` compresses on
// whichever channel reaches the ceiling first and scales the colour by what that channel gave up,
// so a blown cloud stays neutral. Paper is not a display. A film stock reshapes the whole range
// and bleaches what it compresses, and a printer driver clipping each channel at its ink limit is
// a look people print for on purpose. All three are one curve over the frame, and a curve that
// holds grey has half a stop of paper left for the three a daylight frame keeps over its white;
// dodging region by region is the fourth, and the one that keeps a sky's texture. Which a
// photograph wants is a judgement about that photograph - and each has to differ from the others
// on a photograph whose highlights are simply blown, since that is the one a reader reaches for to
// compare them.
module print_tone;

import prelude;
import light;

public static const uint PRINT_TONE_NEUTRAL = 0;
public static const uint PRINT_TONE_FILMIC = 1;
public static const uint PRINT_TONE_CHANNEL = 2;
public static const uint PRINT_TONE_LOCAL = 3;

static const float FILMIC_CONTRAST = 1.4;
static const float FILMIC_SHOULDER = 0.977;
static const float FILMIC_GREY = 0.18;

static const float LOCAL_SHOULDER = 0.8;

/// A film stock's curve in shares of white: grey held, the scene's own peak landed on white, or
/// white held where the scene stops short of it, so a low-key frame is shaped and never lifted.
/// Lottes' two-constraint form, solved per frame for those two points.
float filmic(float share, float white)
{
    let grey = pow(FILMIC_GREY, FILMIC_CONTRAST);
    let grey_shoulder = pow(grey, FILMIC_SHOULDER);
    let top = pow(max(white, 1.0), FILMIC_CONTRAST);
    let top_shoulder = pow(top, FILMIC_SHOULDER);
    let span = (top_shoulder - grey_shoulder) * FILMIC_GREY;
    let b = (top * FILMIC_GREY - grey) / span;
    let c = (top_shoulder * grey - top * grey_shoulder * FILMIC_GREY) / span;
    let lifted = pow(max(share, 0.0), FILMIC_CONTRAST);
    return lifted / (pow(lifted, FILMIC_SHOULDER) * b + c);
}

/// White approached and never reached, so what a region's own detail carries past it still reads
/// as detail.
float shouldered(float share)
{
    if (share <= LOCAL_SHOULDER) { return share; }
    let t = (share - LOCAL_SHOULDER) / (1.0 - LOCAL_SHOULDER);
    return LOCAL_SHOULDER + (1.0 - LOCAL_SHOULDER) * t / (1.0 + t);
}

/// `graded` as a share of `white`, its highlights fitted under it by `tone`. `scene_peak` is the
/// brightest `graded` reaches. The regional operator's dodging is the caller's, since only a
/// caller holding the neighbourhood can do it; what is left of it here is the shoulder.
public float3 fitted(Colour<DisplayNits> graded, Light<DisplayNits> scene_peak, Light<DisplayNits> white, uint tone)
{
    // A clip, not a per-channel roll: on a blown highlight the three channels are equal, and one
    // curve on three equal numbers is the neutral operator exactly.
    if (tone == PRINT_TONE_CHANNEL) { return min(graded.v, float3(white.v)) / white.v; }
    if (tone == PRINT_TONE_NEUTRAL) { return within(rolled(graded, rolloff(scene_peak, white)), white).v / white.v; }
    let share = graded.v / white.v;
    let top = max(share.r, max(share.g, share.b));
    if (top <= 0.0) { return float3(0.0); }
    if (tone == PRINT_TONE_LOCAL) { return share * (shouldered(top) / top); }
    let curved = filmic(top, scene_peak.v / white.v);
    let toned = share * (curved / top);
    // Only through the shoulder: the toe darkens as well, and bleaching there would grey the
    // shadows a stock is meant to deepen.
    let bleach = top > FILMIC_GREY ? saturate(1.0 - curved / top) : 0.0;
    return min(lerp(toned, float3(dot(LUMA, toned)), bleach), float3(1.0));
}
