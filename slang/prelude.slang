// Transfer functions and the roll-off, shared by every module that grades.
//
// The constants and the names are `native/rawshim`'s, deliberately: this is a second
// implementation of one picture, which is the divergence DESIGN §21.1 warns about, so
// where a number appears here it appears with the name it has over there.
module prelude;

import light;

/// `hdr_fit::LUMA` and `tone::LUMA`, which are BT.2020's weights for a Rec.2020 frame.
///
/// Not `image::LUMA`. That one is BT.709 and belongs to the denoise, which is measuring
/// where detail is rather than what a colour weighs, and never meets this. Taking it here
/// put the wrong weights under `finish_chroma`'s grey axis, the chroma map's level axis and
/// its reconstructed middle channel, so every matched photograph was graded around the wrong luma.
public static const float3 LUMA = float3(0.2627, 0.678, 0.0593);

/// BT.709's weights, which `image::luma709` is the host's statement of.
///
/// **Beside `LUMA` rather than instead of it, and the pair is the point.** Which one a stage wants
/// follows from what it is weighing: `LUMA` for a Rec.2020 frame, this for the camera's own sRGB
/// rendering, which is what the fit's objective and its excursion are scoring against. Named here
/// because the alternative is what happened - the same triple written down in three shaders, where
/// picking the wrong one of the two is a silent regrade rather than a compile error.
public static const float3 LUMA709 = float3(0.2126, 0.7152, 0.0722);

// SMPTE ST 2084, both directions. `tone::pq` and `tone::pq_inv`.
public static const float PQ_M1 = 0.1593017578125;
public static const float PQ_M2 = 78.84375;
public static const float PQ_C1 = 0.8359375;
public static const float PQ_C2 = 18.8515625;
public static const float PQ_C3 = 18.6875;
public static const float PQ_MAX_NITS = 10000.0;

/// **The domain is the caller's to name.** ST 2084 is absolute, so what goes in and comes back out
/// is real nits whichever stage asked - `decode.slang` fills a table of the *scene's*, `roll`
/// compresses the *display's* - and the curve cannot tell them apart. Naming one at the call is
/// what stops the two meeting further down.
public Light<Pq> pq<D : INits>(Light<D> nits)
{
    let y = pow(clamp(nits.v / PQ_MAX_NITS, 0.0, 1.0), PQ_M1);
    return measured<Pq>(pow((PQ_C1 + PQ_C2 * y) / (1.0 + PQ_C3 * y), PQ_M2));
}

public Light<D> pq_inv<D : INits>(Light<Pq> signal)
{
    let e = pow(clamp(signal.v, 0.0, 1.0), 1.0 / PQ_M2);
    return measured<D>(
        PQ_MAX_NITS * pow(max(e - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * e), 1.0 / PQ_M1));
}

/// A colour's luminance, which is a light in the same domain the colour is.
///
/// BT.2020's weights, so the colour has to be in Rec.2020 for the answer to be one - which every
/// domain here is but `SrgbLinear` and `Srgb`, and neither of those is ever weighed.
public Light<D> luma_of<D : ILinear>(Colour<D> colour)
{
    return measured<D>(dot(LUMA, colour.v));
}

/// The sRGB transfer, IEC 61966-2-1, on a value already in range. `hdr_fit::srgb_oetf`.
///
/// **Four stages code against the camera's own JPEG and they have to agree exactly.** The
/// geometry search compares a render to the preview through it, the colour fit's objective
/// quantises both sides onto the 255 steps it lives on, and the render a rendition stores is
/// written through it - so a coefficient that differed between them would score a fit against
/// levels the render never produced.
public float srgb_oetf(float value)
{
    return value <= 0.0031308 ? 12.92 * value : 1.055 * pow(value, 1.0 / 2.4) - 0.055;
}

/// The curve carried past both ends with the sign kept, so an out-of-gamut component survives as a
/// negative rather than folding back over zero: what an extended-range canvas holds.
public float3 srgb_oetf_signed(float3 value)
{
    return sign(value) * float3(srgb_oetf(abs(value.r)), srgb_oetf(abs(value.g)), srgb_oetf(abs(value.b)));
}

/// The same curve back, for the stages that read a level the camera wrote. `hdr_fit::srgb_eotf`.
public float srgb_eotf(float level)
{
    return level <= 0.04045 ? level / 12.92 : pow((level + 0.055) / 1.055, 2.4);
}

/// How far under diffuse white, or a lower target peak, a roll-off may begin.
///
/// **Diffuse white and below is the picture; a target's headroom decides only what happens above
/// it** (BT.2408). BT.2390's own knee follows the ratio of the scene's peak to the target's, so
/// into an SDR white it falls to a third of white on a frame with a specular sun in it and bends
/// the camera's own shoulder a second time: a matched render that reads as the JPEG in HDR reads
/// duller and flatter than it in SDR.
public static const Stops KNEE_UNDER_WHITE = { -0.32 };

/// The roll-off: BT.2390-8 5.4.1's knee with black at zero, held no lower than
/// `KNEE_UNDER_WHITE`, and a rational shoulder above it. **The only implementation of it.**
///
/// Not BT.2390's Hermite above the knee, because its `ks = 1.5 max_lum - 0.5` is exactly the
/// highest knee that spline stays monotone from; any knee above that one overshoots the target
/// and comes back down.
///
/// Split so the knee is found once and applied three times: `pq(source_peak)` and `pq(peak)`
/// are constant over the whole dispatch, coming from the frame and the display rather than
/// from the pixel.
public struct Rolloff {
    public float lw;
    public float max_lum;
    public float ks;
    public float floor_nits;
    // Whether the scene already fits inside the display, in which case there is nothing to
    // roll off and every channel returns unchanged.
    public bool fits;
};

/// `white` is the target's diffuse white; a lower peak bounds the knee instead.
public Rolloff rolloff(Light<DisplayNits> source_peak, Light<DisplayNits> peak, Light<DisplayNits> white)
{
    let lw = pq(source_peak).v;
    let max_lum = pq(peak).v / lw;
    let floor = pq(measured<DisplayNits>(min(white.v, peak.v) * gain_of(KNEE_UNDER_WHITE).g)).v / lw;
    Rolloff knee;
    knee.lw = lw;
    knee.max_lum = max_lum;
    knee.ks = max(1.5 * max_lum - 0.5, floor);
    knee.floor_nits = min(white.v, peak.v) * gain_of(KNEE_UNDER_WHITE).g;
    knee.fits = max_lum >= 1.0;
    return knee;
}

public Light<DisplayNits> roll(Light<DisplayNits> nits, Rolloff knee)
{
    if (knee.fits || nits.v <= knee.floor_nits) { return nits; }
    let e1 = pq(nits).v / knee.lw;
    if (e1 < knee.ks) { return nits; }
    let reach = knee.max_lum - knee.ks;
    // Slope 1 at the knee, and the source peak landing on the target's exactly.
    let past = e1 - knee.ks;
    let bend = 1.0 / reach - 1.0 / (1.0 - knee.ks);
    let e2 = knee.ks + past / (1.0 + bend * past);
    return pq_inv<DisplayNits>(measured<Pq>(e2 * knee.lw));
}

/// The roll-off on the colour, as a gain rather than three separate curves.
///
/// **BT.2390 is a curve on a light, and running it per channel is what turns a blown white into
/// a coloured one.** The curve compresses hardest at the top, so the largest channel is pulled
/// down furthest and the two beneath it keep more of what they had - the cloud comes back
/// tinted by whichever channel reached the ceiling first, which is the one place a picture must
/// not be tinted.
///
/// So the curve is evaluated once, on the channel that decides whether anything rolls at all,
/// and the pixel is scaled by what that channel gave up. Ratios survive exactly.
public Colour<DisplayNits> rolled(Colour<DisplayNits> nits, Rolloff knee)
{
    let top = max(nits.v.r, max(nits.v.g, nits.v.b));
    if (knee.fits || top <= 0.0) { return nits; }
    return times(nits, gain(roll(measured<DisplayNits>(top), knee).v / top));
}

/// A colour with no negative channel, brought back by desaturating rather than by clamping.
///
/// **Two things ask for colours Rec.2020 cannot make, and clamping each channel at zero turns
/// either into a hue shift rather than a clip.**
///
/// A balance is a diagonal in cone space and the working primaries are Rec.2020, so the far ends
/// of the temperature slider land outside them. The cone gains are enormous there - a daylight
/// frame told the light was 2000K needs most of a decade of blue - and the off-diagonal terms of
/// the folded matrix take green negative long before blue runs out of range. Clamped, green is
/// pinned at nothing across the whole picture, which is a monochrome field with the hue of one
/// primary and no amount of the slider's remaining travel brings it back.
///
/// A camera matrix does it to real scene content: a narrow-band emitter is outside the primaries
/// on its own, and the green row's negative blue term is what a saturated violet meets. Measured
/// on a light-painted arc, camera (0.367, 0.176, 0.825) leaves the matrix at (+0.298, -0.125,
/// +1.028), and clipping that green is what renders a violet as a pure blue.
///
/// Pulling the colour towards its own luma instead gives up only saturation. The luma is
/// unchanged by construction - the mix is towards a grey of the same luma - so the tone group,
/// the roll-off and the peak all still see the picture they would have seen.
///
/// **A knee, not a wall.** Pulled to exactly zero, a colour the model puts *near* the floor is a
/// channel half of whose pixels are clamped and half of whose carry photosite noise - and PQ is
/// steepest at black, so that noise is thousands of codes in a still, which 4:2:0 then hands the
/// bright channel as speckle (`avif.rs`). Measured on a red hood the match had parked at the
/// Rec.2020 floor: green 49% at code zero, the rest swinging to a 99th percentile of 12952 codes.
/// So the lowest channel eases into `GAMUT_FLOOR` of its luma instead, C1 at a knee twice that
/// out: a colour inside the knee is untouched, and one the model sends however far past the floor
/// arrives *at* the floor with its noise still a small linear quantity around a positive level.
///
/// Generic over the domain because the callers are in several - `assemble` holds an `Assembled`
/// inside full scale, `lit_by_reader` holds `SceneNits` inside the primaries, the two arms hold
/// their `DisplayNits` - and what the rule is about is the gamut, which every linear domain here
/// shares.
public Colour<D> in_gamut<D : ILinear>(Colour<D> colour)
{
    let v = colour.v;
    // **The grey to mix towards is the positive part's, not the triple's.** A negative channel is
    // the whole reason this function is reached, and its `LUMA` weight is the largest of the three -
    // so taking the luma of the triple as it stands subtracts the out-of-gamut channel from the
    // in-gamut ones, and the further outside the gamut a colour is the darker the grey it is pulled
    // towards. Measured on the ISO 4000 church's deepest blue pane, camera (0.013, 0.027, 0.121):
    // the matrix leaves it at (+0.00002, -0.01056, +0.14775), whose luma is 0.0016 where its
    // positive part's is 0.0088. Five and a half times, and the picture wears all of it - the pane
    // renders at a twentieth of diffuse white where the body's own JPEG has it near white.
    //
    // The noise is the other half and the worse one. `x` divides by this luma, so a cancellation in
    // the denominator carries the photosites' own noise into the *strength* of the correction, and
    // every pixel is desaturated by a different amount. That is speckle at the pixel's own scale on
    // exactly the colours a gamut rule is for, which is how it reads as a demosaic fault.
    //
    // A strict no-op wherever no channel is negative, since `max` is then the identity and the
    // early return below is unchanged - so no colour inside Rec.2020 moves by this.
    let luma = dot(LUMA, max(v, float3(0.0)));
    // Below the achromatic axis entirely, so there is no grey of this luma to mix towards.
    if (luma <= 0.0) { return measured<D>(float3(0.0)); }
    let lowest = min(v.r, min(v.g, v.b));
    let x = lowest / luma;
    if (x >= 2.0 * GAMUT_FLOOR) { return colour; }
    // Value `2m` and slope 1 at the knee, easing to `m` as `x` falls away.
    let held = GAMUT_FLOOR * (1.0 + exp((x - 2.0 * GAMUT_FLOOR) / GAMUT_FLOOR));
    let scale = (1.0 - held) / (1.0 - x);
    let pulled = float3(luma) + (v - float3(luma)) * scale;
    // **Mixing towards a grey keeps the *triple's* weighted mean, which is not the one being kept
    // here.** The mix is linear and `LUMA` sums to one, so the result's luma comes out at
    // `luma + scale * (dot(LUMA, v) - luma)` - the target where nothing was negative, and drawn
    // back towards the triple's own the further out the colour is. Restored by a uniform scale,
    // which is a brightness and not a hue, and which cannot break the floor below: the floor is a
    // fraction of the colour's own luma, so scaling every channel leaves `lowest / luma` where it
    // was. The factor is bounded - as the colour goes further out `scale` falls away and the
    // achieved luma returns to the target - so this is at most a third of a stop anywhere.
    let achieved = dot(LUMA, pulled);
    return measured<D>(pulled * (luma / max(achieved, 1e-12)));
}

/// Where `in_gamut` holds the lowest channel, as a fraction of the colour's luma. `hdr_fit.rs`
/// states the same number for the fit's objective, and a test holds the two together.
public static const float GAMUT_FLOOR = 0.02;

/// A colour brought inside `ceiling` without turning a different colour on the way.
///
/// The same rule as `rolled` and for the same reason. Measured on IMG_0622, whose cloud tops
/// sit above the frame's own 0.9999 quantile: clamping each channel where it happened to cross
/// left a mauve patch through the brightest cloud, the two channels that had not crossed
/// keeping their heads above the one that had.
///
/// Generic for `in_gamut`'s reason: `assemble` brings an `Assembled` inside full scale where the
/// grade brings `DisplayNits` inside a display's peak, and the ceiling has to be a light of
/// whichever the colour is - which is the whole of what a bare `float` let the two confuse.
public Colour<D> within<D : ILinear>(Colour<D> nits, Light<D> ceiling)
{
    let held = max(nits.v, float3(0.0));
    let top = max(held.r, max(held.g, held.b));
    if (top <= ceiling.v) { return measured<D>(held); }
    return measured<D>(held * (ceiling.v / top));
}
