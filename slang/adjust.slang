// The photographer's own adjustments, between the camera's rendering and the roll-off.
//
// **Where, and why there.** The camera match reproduces what the body would have made;
// these are what the reader then wants instead. So they sit after `finish_chroma` and
// before the roll-off - late enough that the picture being adjusted is the one on screen,
// early enough that the roll-off still maps whatever comes out into the display's range.
// `peak` measures the scene peak through the same function, so a highlight lift moves
// the knee with it rather than being clipped by a knee placed on the unadjusted frame.
//
// **Two domains, and the signature is what says which is which.** `adjusted` runs in any
// `IWhiteAtOne` - `Scene` for the neutral arm, which has it in hand before it multiplies by the
// reference, and `Graded` for the matched one, which normalises on the way in because a camera's
// rendering puts white wherever that body's JPEG had it. But *where a pixel sits* is asked of the
// frame as it arrived, through `base_luma`, and never of the colour: hence the `Light<Scene>`
// beside a `Colour<D>`. A rendering leaves middle grey about a stop under its white where the
// scene's own is nearly two and a half, so zones placed against the graded pixel are squeezed
// into a third of the room and land on top of each other. The scene's stops are the same axis on
// every photograph, which is what makes one set of constants right for all of them.
//
// **Tone acts on luma, carried onto the colour's ratios.** Scaling the three channels by a curve of
// each channel turns a saturated red into a different hue as it brightens. One curve, evaluated
// on luma, applied as a ratio, holds hue exactly.
//
// **The three presence sliders read a neighbourhood, and it arrives as a texture.** Texture,
// clarity and dehaze cannot be functions of the pixel, so `detail` blurs the frame once
// and this samples it. What that costs here is a coordinate: every caller has to say *where*
// in the frame the colour it is handing over came from, which is why `adjusted` takes an `at`
// and the two arms thread it down from their own callers.
//
// The blur is of the frame as it arrived - before the match, the exposure and every slider -
// so the difference this reads is in the base's own stops rather than the graded pixel's.
// That is deliberate and it is what makes the pass a one-off: an exposure is an additive
// constant in stops and cancels out of a difference, where a blur of the graded frame would
// have to be rebuilt on every pointer move.
module adjust;

import prelude;
import edit;
import light;

[vk::binding(13, 0)] public Texture2D<float4> detail;
// The reader's temperature and tint, already solved into one matrix by `white_balance`.
// Rows of four, and the identity where the pair is at the frame's own illuminant - so the
// check below is about skipping nine multiplies rather than about correctness.
[vk::binding(14, 0)] StructuredBuffer<float> balance;
/// Named apart from HLSL's `lerp`, which a global of that name would shadow everywhere.
[vk::binding(7, 0)] public SamplerState bilinear;

/// Stops relative to diffuse white. 0 is white, -3 is three stops under it.
///
/// Floored rather than guarded at the call site: `log2(0)` is -inf, and every weight below
/// is a Gaussian on this value, so an unfloored black would come back NaN and paint a hole.
public Stops stops_below_white(Light<Scene> luma)
{
    return stops(log2(max(luma.v, 1.0 / 65536.0)));
}

/// A zone's pull at a given exposure, as a Gaussian on stops.
///
/// Overlapping on purpose. Camera Raw's four tonal sliders do not partition the range, they
/// lean on it - which is what lets shadows and blacks both act on a dark pixel and sum to
/// something smooth, rather than meeting at a seam a gradient would show.
float zone(float at, float centre, float width)
{
    let d = (at - centre) / width;
    return exp(-d * d);
}

/// A zone that acts from its centre outwards, and rolls off towards the midtones only.
///
/// **All four of the tone group are this shape, and a Gaussian was wrong for every one of
/// them.** Each names an end of the range - highlights and whites the top, shadows and blacks
/// the bottom - and a bell falls away on *both* sides of its centre, so the further a pixel got
/// towards the end its slider is named after, the less that slider did to it. Measured on the
/// bell this replaced: a blown sky two stops over white took 3% of a highlights move, which is
/// what a tree four stops *under* white was already taking. Pulling the highlights down dimmed
/// the trees and left the sky. The same inversion at the other end left `shadows` doing
/// nothing at all to the deepest part of a photograph.
///
/// Flat past the centre fixes that: everything at or beyond the end is fully in, and what the
/// width now sets is only how far the control reaches back towards the middle - which is the
/// dial anyone actually wants, and the one that decides whether a slider touches the subject.
///
/// `away` is +1 for a zone flat above its centre and -1 for one flat below.
float shoulder(float at, float centre, float width, float away)
{
    return select((at - centre) * away >= 0.0, 1.0, zone(at, centre, width));
}

/// Middle grey in the *scene*, as a fraction of diffuse white.
///
/// The pivot contrast turns about. A pivot at white would darken everything as contrast
/// rises, because there would be nothing above the pivot to lift.
///
/// **The zones read this and the contrast does not**, which is the whole of the split below: a
/// zone asks where a pixel sits in the scene, and the scene's middle grey is 0.18 of its white on
/// every photograph. The contrast bends the value it is handed rather than weighting it, so it
/// has to turn about the middle of *that* domain - and the matched arm has run the camera's own
/// rendering by then, which leaves its middle grey nowhere near 0.18 of its white.
public static const Light<Scene> PIVOT = { 0.18 };

/// What a slider at 100 is worth, in stops at its zone's centre.
///
/// **The -100..100 range is Camera Raw's, because the document stores Camera Raw's numbers; what
/// a 100 is worth is entirely ours, and these two are it.** So they are answerable to what the
/// other program's 100 does rather than to arithmetic: at one stop, a Blacks pushed to the end
/// moved a photograph less than a nudge of the exposure did, which is not a control anybody can
/// use.
///
/// **Two stops because that is what the editors which say answer.** Only two of them do, Camera
/// Raw's tone sliders being unitless and adaptive - `docs/lightroom-xmp.md` §5.2 records that
/// `Exposure2012` is the one tag in EV and the rest map to no physical quantity:
///
///   - darktable's tone equalizer is `$MIN: -2.0 $MAX: 2.0` EV on each of nine bands, centred a
///     stop apart from -8 to 0 (`src/iop/toneequal.c`). Two stops, per band, explicitly.
///   - RawTherapee's shadows/highlights raises masked luminance to `1/pow(4, amount/100)`
///     (`rtengine/ipshadowshighlights.cc`), so its 100 is a gamma of a quarter: three quarters of
///     a stop of lift for every stop of depth, which is 2.25 at -3 and 3.75 at -5.
///
/// So two is darktable's figure exactly and short of RawTherapee's at depth, where 1.5 was under
/// both. The shoulders below reach the bottom of the histogram rather than the bottom of the
/// range, which is where the rest of the reach comes from.
static const float ZONE_STOPS = 2.0;
static const float END_STOPS = 2.0;

/// How far contrast bends the curve. 0.6 puts a slider at 100 near a 1.5x slope through the
/// pivot, which is a strong but still photographic S.
static const float CONTRAST_SLOPE = 0.6;

/// Where the outer pair sit: the ends of the range themselves, in stops under diffuse white.
///
/// **Both are measurements now.** Diffuse white is the frame's own `white_quantile`, so zero
/// already means "the top of this picture"; `edit.black_floor` is the bottom of the same
/// histogram, and `low_span` below is the distance between them.
///
/// -5.5 is the span of a photograph with real black in it, and the deepest this reads: further
/// down is into the noise, and following it there would leave Blacks doing nothing to the shadows
/// a reader can see. It is also the span every constant below is quoted at, so a frame that
/// reaches it is placed by the numbers as written and a shallower one by the same numbers scaled.
static const float WHITES_AT = 0.0;
static const float BLACKS_DEEPEST = -5.5;

/// The blacks shoulder's width at a span of [`BLACKS_DEEPEST`].
static const float BLACKS_WIDTH_DEEPEST = 1.6;

/// How far from middle grey towards its own end an inner zone's centre sits, as a share of the
/// gap between the two.
///
/// A fraction rather than a count of stops, so the pair cannot cross the ends they sit inside.
///
/// What separates an inner slider from its outer partner is this gap plus the widths below: both
/// are flat past their centres, so where the two centres sit a stop apart and the inner one rolls
/// off a stop earlier, they part company across the range between them - a fifth of a stop under
/// white against nine tenths, measured. Close the gap and the pair become one control twice over,
/// which is what a domain with no room between white and middle grey does to them.
static const float INNER_TOWARD_END = 0.6;

/// How far open an inner zone is left back at middle grey.
///
/// **A zone still open at middle grey is an exposure slider wearing another name.** This is what
/// sets each inner width, rather than a second constant that has to be kept agreeing with the
/// first: a slider at 100 is worth this share of its `ZONE_STOPS` in the middle of the picture,
/// and the whole of them at the end it is named for.
static const float INNER_OPEN_AT_PIVOT = 0.1;

/// The width that leaves a shoulder `INNER_OPEN_AT_PIVOT` open `reach` stops back from its
/// centre, `reach` being the distance from that centre to middle grey.
float inner_width(float reach)
{
    return max(reach, 1.0 / 64.0) / sqrt(-log(INNER_OPEN_AT_PIVOT));
}

/// How much of a photograph's worth of range this frame's low half actually holds, as a share of
/// [`BLACKS_DEEPEST`].
///
/// **One number, and the whole low half is that number times what it is at a full span.** Blacks
/// goes to the bottom, Shadows to its own fraction of the way there, and both widths shrink with
/// them - so a frame holding a quarter of the range gets four controls a quarter as wide instead
/// of four placed off the end of it.
///
/// Scaling rather than clamping, and the difference is the whole of the haze case. A hazy frame's
/// bottom is *above* middle grey - measured on one, 1.36 stops under white where the pivot is
/// 2.47 - so anything that placed Blacks against a fixed 0.18 of white would put it below every
/// pixel in the picture, which is a slider the reader watches do nothing.
///
/// Exactly 1.0 where the frame reaches the full span, the same expression over itself, so a
/// photograph with black in it is placed by the constants as written and to the bit.
/// **The floor is cleared before it is read, or Blacks is placed by haze the reader has removed.**
/// `edit.black_floor` is measured once on the frame as it arrived, and dehaze is a slider - so a
/// reader who clears a photograph opens two stops of shadow under a floor that still reports the
/// veil, and the pair sit where the hazy picture put them. Pushing it through the same model the
/// pixels go through is what keeps the two together.
///
/// **Its own transmission, and the approximation is named.** The model's `t` is per pixel, off the
/// blurred dark channel; the floor is a property of the whole frame and has no pixel to read one
/// at. What it does have is the observation the prior is built on - a dark region is a region with
/// little airlight in it - so the darkest patch's own dark channel is the floor itself, and that is
/// what is handed to `transmission_for` here. It is exact at both ends that matter: at no dehaze
/// the map is the identity, and on a frame whose floor is already black there is nothing to clear.
float low_span()
{
    let cleared = select(
        edit.dehaze == 0.0,
        edit.black_floor,
        recovered(edit.black_floor, transmission_for(edit.black_floor)));
    let bottom = stops_below_white(measured<Scene>(cleared)).s;
    // Floored well off zero: everything below divides the span out, and a frame flat enough to
    // reach here has no low half to grade - a sixteenth of a stop leaves the pair a hair wide
    // rather than a step, which is what a dead flat field should get.
    let span = clamp(-bottom, 1.0 / 16.0, -BLACKS_DEEPEST);
    return span / -BLACKS_DEEPEST;
}

/// How far up a compressed frame the low pair act, as a share of what they get on a full span.
///
/// **The span says where they sit; this says how much picture they are allowed.** Held at the span
/// itself the pair are a `span`-sized copy of the full-span curve - correct in shape, and far too
/// timid to use: on a frame with a quarter of a photograph's range that is a Shadows worth half a
/// stop at its end, which a reader reads as a slider that barely moves.
///
/// The square root is the geometric mean of the frame's own span and a whole one, and it buys
/// about twice the worth for about twice the width - so the slope, which is the thing that bands,
/// is untouched. What it spends is selectivity: measured on a 1.36-stop frame, Shadows goes from
/// 7% open at the picture's own midtone to 66%, and from under 1% at diffuse white to 4%. Under
/// 5% at white is what keeps it a control named for an end rather than the exposure, and that is
/// the bound worth watching if this moves again.
float low_reach(float span)
{
    return sqrt(span);
}

/// The tonal sliders as one curve on luma, with the middle pair reading the neighbourhood.
///
/// **Highlights and shadows ask how bright the *region* is; whites and blacks ask how bright
/// the pixel is.** That split is the whole shape of the four, and it is not decoration:
///
///   - A pixel does not know whether it is a shadow. A dark pixel in the shaded side of a face
///     and a dark pixel between two threads of a white shirt are the same number, and only one
///     of them is what a reader means by "the shadows". Weighting the lift by the *neighbour-
///     hood's* brightness separates them, and is why a locally adaptive shadows lifts a subject
///     out of shade without also flattening every texture in the frame - which is what the
///     pointwise version did, and what it looked like it was doing.
///   - Whites and blacks are endpoints. They say where the range ends, which is a property of a
///     value and not of a place, so they stay pointwise. Highlights and shadows then act inside
///     the range those two set, rather than being four gains that merely sum.
///
/// `scene_at` and `scene_around` are the pixel and its neighbourhood in the scene's stops under
/// diffuse white, which is the axis the zones are placed on and not the domain `luma` is in (see
/// the head of this file). The neighbourhood comes from the edge-aware blur `detail` fits, so the
/// weighting does not bleed across a hard edge - the failure that makes a locally adaptive tone
/// control halo - and equals `scene_at` where nothing asked for the texture, which is exactly the
/// pointwise curve.
///
/// `pivot` is middle grey in `luma`'s own domain, which only the contrast reads.
public float tone_adjusted(float luma, float scene_at, float scene_around, float pivot)
{
    var l = luma;

    // Contrast first, as a power about the pivot: a straight line in log space, so it cannot
    // introduce an inflection the four zone gains would then have to fight.
    if (edit.contrast != 0.0) {
        let k = pow(2.0, -edit.contrast / 100.0 * CONTRAST_SLOPE);
        l = pivot * pow(max(l, 0.0) / pivot, 1.0 / k);
    }

    // Then the four zones, summed in stops. Summed rather than applied in sequence so the
    // order among them cannot matter - four gains that compose by multiplication are four
    // that commute, and nobody has to remember which the panel lists first.
    var gain = 0.0;
    // The outer pair are the ends and are flat past them; the inner pair are crests short of
    // those ends. That difference in *shape* is what stops each pair being one control twice
    // over - a crest peaks on the range it recovers where a shoulder is simply open all the way
    // out, so highlights recovers a range at the top and whites moves the point it finishes at.
    let middle = stops_below_white(PIVOT).s;
    // The low half's own scale. The upper pair keep the scene's true middle grey: white is
    // measured for every frame already, so highlights and whites have an end that moved with the
    // photograph without anything here scaling them onto it.
    let span = low_span();
    let reach = low_reach(span);
    let low_middle = middle * span;
    let blacks_at = BLACKS_DEEPEST * span;
    let up = (WHITES_AT - middle) * INNER_TOWARD_END;
    let down = (low_middle - blacks_at) * INNER_TOWARD_END;
    gain += edit.highlights / 100.0 * ZONE_STOPS
        * shoulder(scene_around, middle + up, inner_width(up), 1.0);
    // **What the inner pair are worth and how wide they are move together, and that is what keeps
    // Shadows smooth.** Scaling where a zone sits without scaling the two of them divides the same
    // `ZONE_STOPS` by a shoulder `span` times narrower, so the gain climbs `1/span` times as fast
    // against the axis it reads. Harmless for the outer pair, which read the pixel - a steep curve
    // on a value is just contrast - and not harmless here: `scene_around` is the guided filter's
    // field, a texel of which is eighteen frame pixels on a 9504px frame, so a weight several
    // times as steep prints that field's own smooth structure onto the picture as soft-edged
    // patches over anything dark. Measured on a 1.36-stop frame at +100: milky blobs across the
    // tree canopies, in a picture with no edge there at all.
    //
    // `reach` on both, so their ratio - the slope - is the one a full-span frame gets whatever
    // the frame. The width is `inner_width` of a `down` stretched by how far the reach exceeds
    // the span, which is the same shoulder opened out rather than a second shape.
    gain += edit.shadows / 100.0 * ZONE_STOPS * reach
        * shoulder(scene_around, low_middle - down, inner_width(down * reach / span), -1.0);
    gain += edit.whites / 100.0 * END_STOPS * shoulder(scene_at, WHITES_AT, 1.0, 1.0);
    // The outer pair keep their whole worth: they read the pixel, so nothing here can band, and a
    // compressed frame is exactly where a reader wants Blacks making range rather than sharing it.
    gain += edit.blacks / 100.0 * END_STOPS
        * shoulder(scene_at, blacks_at, BLACKS_WIDTH_DEEPEST * reach, -1.0);

    return l * pow(2.0, gain);
}

/// Saturation and vibrance, about the colour's own luma.
///
/// Vibrance after saturation and weighted against what is already there: that weighting is
/// the whole difference between the two controls. A saturated colour is near its limit and
/// pushing it further only clips a channel, where a muted one has room - so vibrance lifts
/// what is flat and leaves what is vivid, which is why it is the one people reach for first.
float3 chroma_adjusted(float3 colour, float luma)
{
    var out = colour;

    if (edit.sat_adjust != 0.0) {
        // -100 lands at 0, which is grey outright, and +100 at twice the distance from it.
        let sat = 1.0 + edit.sat_adjust / 100.0;
        out = float3(luma) + (out - float3(luma)) * sat;
    }

    if (edit.vibrance != 0.0) {
        // Chroma relative to the colour's own brightness, so the weighting reads the same in a
        // shadow as in a highlight rather than treating every dark pixel as muted.
        let chroma = length(out - float3(luma)) / max(luma, 1.0 / 65536.0);
        let room = 1.0 / (1.0 + chroma * 2.0);
        out = float3(luma) + (out - float3(luma)) * (1.0 + edit.vibrance / 100.0 * room);
    }

    return out;
}

/// The frame rebalanced to the illuminant the reader asked for.
///
/// A matrix rather than three gains, because the diagonal that a balance really is lives in
/// cone space and this colour is in Rec.2020 - the two conversions either side of it are
/// constant, so they are folded in once per dispatch rather than per pixel.
public Colour<SceneNits> balanced(Colour<SceneNits> colour)
{
    let v = colour.v;
    return measured<SceneNits>(float3(
        balance[0] * v.r + balance[1] * v.g + balance[2] * v.b,
        balance[4] * v.r + balance[5] * v.g + balance[6] * v.b,
        balance[8] * v.r + balance[9] * v.g + balance[10] * v.b));
}

/// What texture at 100 is worth, in stops of its own band added back.
static const float TEXTURE_STOPS = 1.8;

/// The same for clarity, and larger, because the two bands do not hold the same amplitude: the
/// span between two blurs is a fraction of what sits above the fine one, so an equal gain
/// reaches a reader as the fainter of the two controls.
static const float CLARITY_STOPS = 3.0;

/// What the two together approach, and never reach, in stops on one pixel.
///
/// A backstop rather than a mechanism. The neighbourhood is edge-aware (`detail`), so at a hard
/// edge the reference follows the step instead of averaging across it and the difference read
/// below is the texture *in* the edge rather than the edge itself - which is what a halo is. What
/// is left to bound is the pathological case the fit cannot describe, a specular against black,
/// where an unbounded lift would solarise.
///
/// On the sum, and after the gains, because that is the quantity the hazard is about: bounding
/// each band before multiplying leaves the ceiling as whatever the gains happen to be.
static const float DETAIL_LIMIT = 2.0;

/// Texture and clarity, as one gain in stops on the pixel's own band of detail.
///
/// **Two disjoint bands, not two radii of the same operator.** Texture takes what is finer
/// than the fine blur and clarity what sits between the two blurs, so a photograph with both
/// raised is not lifted twice through the frequencies they share - which is what a pair of
/// plain unsharp masks against the same pixel would do.
///
/// **Both bands are between two *scales*, which is why this takes the smooth reference at the
/// texel and not the one the tone group weights by.** The zones ask where a pixel sits, so they
/// evaluate the fit against the pixel; a band asks what lies between two blurs, and evaluating
/// the coarse one against the pixel collapses it onto the pixel - `blur.r - around` is then the
/// fine blur minus something tracking the pixel, which is the *negative* of texture's own band.
/// Clarity comes out inverted, and on a frame whose `detail_step` is one it does not, so a
/// synthetic fixture at 256 across cannot see it.
float local_contrast(float base_stops, float smoothed, float4 blur)
{
    let fine = base_stops - blur.r;
    let coarse = blur.r - smoothed;
    let lift = (TEXTURE_STOPS * edit.texture_adjust * fine + CLARITY_STOPS * edit.clarity * coarse)
        / 100.0;
    // Held off the ends of the range. Local contrast that pushes a highlight past white or a
    // shadow under black is clipping rather than contrast, and a clipped edge is exactly what
    // the eye reads as a halo. Broad enough to leave the midtones at full strength.
    let room = zone(base_stops, -2.5, 3.5);
    // Asymptotic rather than clamped. A clamp is a corner, and a corner in a quantity that varies
    // smoothly across a slope draws a contour along wherever the slope crosses it; at these gains
    // a band of two thirds of a stop is enough to reach one, which is a rock rather than a
    // specular. This is the identity to first order, so the sliders keep their strength where the
    // picture is ordinary and lose it only approaching the end.
    return room * DETAIL_LIMIT * tanh(lift / DETAIL_LIMIT);
}

/// The airlight dehaze subtracts, in the scene-relative units this file works in.
///
/// Diffuse white, rather than a brightest pixel measured off the frame. Haze *is* the scene's
/// black point lifted towards the sky's own brightness, so white is where it sits by
/// definition - and a measured airlight would need a reduction over the frame that nothing
/// else in this pipeline wants, for a number that would then move as the reader cropped.
static const float AIRLIGHT = 1.0;

/// The dark channel's weight in the transmission estimate, at a slider of 100.
///
/// Past 1, which the literature's `omega` never is: at 1 a patch reading as wholly airlight
/// gives all of it up and no patch gives up more, and on a real frame - where the prior reads a
/// quarter to a half rather than one - that lands well short of what the slider is being asked
/// for. What bounds it is the transmission floor below, not this.
static const float DEHAZE_STRENGTH = 2.7;

/// The atmospheric scattering model, inverted: `I = J*t + A*(1 - t)` solved for `J`.
///
/// `t` is the transmission, estimated from the dark channel in the way the prior prescribes -
/// a patch whose darkest channel is bright is a patch full of airlight, so `t` falls as the
/// dark channel rises. Per channel rather than on luma, and that is not an oversight: the
/// airlight subtracted is neutral, so removing it moves a colour away from grey. Dehaze
/// looking like a saturation control is the model's own behaviour rather than a term anyone
/// added.
///
/// The negative half adds haze instead, through the same expression: a slider below zero
/// makes `t` greater than 1, and the result is a blend towards the airlight.
///
/// **The airlight is a fixed point, and everything above it is expanded rather than bounded.**
/// `I = A` comes back as `A` whatever `t` is, so the operator pulls the shadows down and
/// leaves white where it was - which is the shape haze removal should have. Above white it
/// multiplies the excess by `1/t`, and that is left unbounded: haze cannot lift a scene *past*
/// the airlight, so a pixel up there is a specular the prior does not describe, and the strong
/// end of the slider is reached only where the neighbourhood is already near white and has
/// little excess to multiply. Where the two do coincide - sun on water under a white sky - a
/// full-strength dehaze does lift the specular by a couple of stops, and what catches it is the
/// roll-off, which is the same thing that catches a bright scene. Worth knowing before reading
/// a blown highlight there as a bug in the estimate.
/// How much of the scene survives the air where the dark channel reads `dark`.
///
/// Floored well off zero: `recovered` divides by this, and the estimate is a blurred prior rather
/// than a measurement, so the last stretch towards zero is noise gain. No ceiling to go with it -
/// `dark` is clamped into the unit range, so the haze-adding half tops out at
/// `1 + DEHAZE_STRENGTH` on its own, and any number written there caps that half short.
float transmission_for(float dark)
{
    let omega = edit.dehaze / 100.0 * DEHAZE_STRENGTH;
    return max(1.0 - omega * clamp(dark / AIRLIGHT, 0.0, 1.0), 0.15);
}

/// The model on one quantity of light, which is the whole of it: an affine map with the airlight
/// as its fixed point.
///
/// **Separate from the colour so the tone zones can be placed through the same map.** Dehaze moves
/// where the picture's shadows sit, and the zones are placed against where the picture's shadows
/// sit, so the axis has to go through this as well as the pixel - otherwise a reader who clears a
/// frame and then reaches for Blacks gets Blacks placed by the haze they just removed.
float recovered(float light, float transmission)
{
    return max((light - AIRLIGHT * (1.0 - transmission)) / transmission, 0.0);
}

/// A position on the zones' axis, recovered through the same model and back into stops.
float cleared_stops(float stops, float transmission)
{
    return stops_below_white(measured<Scene>(recovered(exp2(stops), transmission))).s;
}

float3 dehazed(float3 colour, float dark_stops)
{
    let transmission = transmission_for(exp2(dark_stops));
    return float3(
        recovered(colour.r, transmission),
        recovered(colour.g, transmission),
        recovered(colour.b, transmission));
}

/// `detail`'s texel for a position in the frame's own pixels.
public float4 detail_at(float2 at)
{
    // Read at the texel the *partition* puts this pixel in, not at `uv` of the texture.
    // `SampleLevel` scales uv by the texture's own size, and that size is the frame
    // rounded up to a whole texel - so sampling by uv stretches the blur by whatever the last
    // texel is short by. For a frame and a window of it those are different amounts, which
    // slides the window's blur against the photograph's by a fraction of a texel everywhere.
    //
    // **Weighted here, off the remainder past a whole texel, and not by the sampler.** A window
    // sits a whole number of texels into the photograph, so a pixel's remainder is the same number
    // in both and subtracting whole texels is exact - where `at / step`, or the sampler's own
    // arithmetic on a UV, rounds by the magnitude of `at` and weighs a window's texels differently
    // from the frame's.
    let step = float(max(edit.detail_step, 1));
    let centred = at - 0.5 * step;
    let near = floor(centred / step);
    let weight = saturate((centred - near * step) / step);
    uint2 size;
    detail.GetDimensions(size.x, size.y);
    let last = int2(size) - int2(1);
    let lo = clamp(int2(near), int2(0), last);
    let hi = clamp(int2(near) + int2(1), int2(0), last);
    let top = lerp(detail.Load(int3(lo.x, lo.y, 0)), detail.Load(int3(hi.x, lo.y, 0)), weight.x);
    let bottom = lerp(detail.Load(int3(lo.x, hi.y, 0)), detail.Load(int3(hi.x, hi.y, 0)), weight.x);
    return lerp(top, bottom, weight.y);
}

/// The edge-aware neighbourhood of a pixel, in the base's stops under diffuse white.
public Stops stops_around(Light<Scene> base_luma, float2 at)
{
    let blur = detail_at(at);
    return stops(blur.g * stops_below_white(base_luma).s + blur.b);
}

float4 curve_point(uint index, bool camera)
{
    return camera ? edit.camera_curve[index] : edit.reader_curve[index];
}

void curve_segment(CurveCode code, float4 left, float4 right, out CurveCode result)
{
    let width = right.x - left.x;
    let t = (code.v - left.x) / width;
    let t2 = t * t;
    let t3 = t2 * t;
    result.v = (2.0 * t3 - 3.0 * t2 + 1.0) * left.y
         + (t3 - 2.0 * t2 + t) * width * left.z
         + (-2.0 * t3 + 3.0 * t2) * right.y
         + (t3 - t2) * width * right.z;
}

uint curve_count(bool camera)
{
    return camera ? edit.camera_curve_count : edit.reader_curve_count;
}

public CurveCode curve_evaluated(CurveCode code, bool camera)
{
    let count = curve_count(camera);
    let first = curve_point(0, camera);
    if (code.v <= first.x) { return CurveCode(first.y); }
    let last = curve_point(count - 1, camera);
    if (code.v >= last.x) { return CurveCode(last.y + (code.v - last.x) * last.z); }
    CurveCode value;
    for (uint i = 0; i + 1 < CURVE_POINTS; i++) {
        if (i + 1 >= count) { break; }
        let left = curve_point(i, camera);
        let right = curve_point(i + 1, camera);
        if (code.v > right.x) { continue; }
        curve_segment(code, left, right, value);
        return value;
    }
    return CurveCode(last.y);
}

static const CurveCode INVERSE_MIN_CODE = { 1e-6 };
static const float INVERSE_MIN_TANGENT = 1e-6;

CurveCode camera_curve_inverse(CurveCode code)
{
    let first = curve_point(0, true);
    if (code.v <= first.y) {
        return CurveCode(max(INVERSE_MIN_CODE.v,
            first.x + (code.v - first.y) / max(first.z, INVERSE_MIN_TANGENT)));
    }
    let last = curve_point(curve_count(true) - 1, true);
    if (code.v >= last.y && last.z > 0.0) { return CurveCode(last.x + (code.v - last.y) / last.z); }
    if (code.v >= last.y) { return CurveCode(last.x); }
    CurveCode sample;
    CurveCode value;
    for (uint i = 0; i + 1 < CURVE_POINTS; i++) {
        if (i + 1 >= curve_count(true)) { break; }
        let left = curve_point(i, true);
        let right = curve_point(i + 1, true);
        if (code.v > right.y) { continue; }
        var low = left.x;
        var high = right.x;
        for (uint step = 0; step < 24; step++) {
            let middle = (low + high) * 0.5;
            sample.v = middle;
            curve_segment(sample, left, right, value);
            if (value.v < code.v) { low = middle; }
            else { high = middle; }
        }
        sample.v = low;
        curve_segment(sample, left, right, value);
        let lower_error = abs(value.v - code.v);
        sample.v = high;
        curve_segment(sample, left, right, value);
        let upper_error = abs(value.v - code.v);
        sample.v = lower_error < upper_error ? low : high;
        return sample;
    }
    return CurveCode(last.x);
}

public Colour<D> camera_undone<D : IWhiteAtOne>(Colour<D> colour)
{
    let luma = dot(LUMA, colour.v);
    if (luma <= 0.0) { return colour; }
    let code = curve_code(gain(luma));
    let untoned = curve_light(camera_curve_inverse(code)).g / gain_of(stops(edit.camera_exposure)).g;
    return measured<D>(colour.v * (untoned / luma));
}

public Gain camera_floor_residual<D : IWhiteAtOne>(Colour<D> colour)
{
    let luma = luma_of(colour).v;
    let floor = curve_light(CurveCode(edit.camera_curve[0].y)).g;
    if (luma <= 0.0 || luma >= floor) { return gain(1.0); }
    return gain(luma / floor);
}

public bool sliders_at_rest()
{
    return edit.contrast == 0.0 && edit.highlights == 0.0 && edit.shadows == 0.0
        && edit.whites == 0.0 && edit.blacks == 0.0 && edit.vibrance == 0.0
        && edit.sat_adjust == 0.0 && edit.texture_adjust == 0.0
        && edit.clarity == 0.0 && edit.dehaze == 0.0;
}

public bool reader_curve_is_identity()
{
    return edit.reader_curve_count == 2 && edit.reader_curve[0].x == 0.0
        && edit.reader_curve[0].y == 0.0 && edit.reader_curve[1].x == 1.0
        && edit.reader_curve[1].y == 1.0;
}

public Light<Scene> tone_pivot()
{
    return measured<Scene>(PIVOT.v * gain_of(stops(edit.camera_exposure)).g);
}

/// Every adjustment, on a scene-relative colour where 1.0 is diffuse white.
///
/// `base_luma` is the *frame's* own luma at this pixel, in the same units, before the match and
/// before the exposure - the domain `detail` blurred, and the axis every zone is placed on. `at`
/// is where in the frame the colour came from, in the frame's own pixels. `colour` is the scene
/// exposed, or the camera match with its own tone taken back off (`colour::matched_nits`), which
/// is why one pivot serves both.
///
/// Returns the colour untouched where nothing is set, which is the common case: a photo with no
/// camera match, nobody's edits on it, and nothing in a library nobody has opened the editor on.
public Colour<D> adjusted<D : IWhiteAtOne>(Colour<D> colour, Light<Scene> base_luma, float2 at)
{
    // The neighbourhood is read for the middle pair of the tone group as well now, not only for
    // the presence three: `tone_adjusted` weights highlights and shadows by how bright the region
    // is rather than the pixel.
    let local = edit.texture_adjust != 0.0 || edit.clarity != 0.0 || edit.dehaze != 0.0
        || edit.highlights != 0.0 || edit.shadows != 0.0;
    if (sliders_at_rest() && reader_curve_is_identity()) {
        return colour;
    }

    // Fetched once for all of them, and only where one is set: the exposure is far commoner and
    // has no business paying for a texture read.
    //
    // One bilinear sample, and it can be: what makes the neighbourhood hold an edge is the fit
    // that produced it (`detail`), not how it is read. Upsampling it more cleverly was tried
    // and measured - a joint bilateral fetch of nine texels moved the band this leaves along an
    // edge by less than a count, because by then the error is already in the texture.
    let base_stops = stops_below_white(base_luma).s;
    let blur = local ? detail_at(at) : float4(0.0);

    // The colour arrives already lit by the illuminant the reader asked for. The balance is a
    // claim about the *scene*, so it belongs upstream of the camera's rendering rather than on
    // top of the picture that rendering made - `colour.slang`'s `lit_by_reader` puts it there.
    var out = colour.v;

    // The guided filter's line, which the texture holds as `a` and `b` for the reader to
    // evaluate (`detail.slang`'s `apply_guided`). Twice, at two scales, because the two callers
    // below want different things of it: the tone zones ask where *this pixel* sits, which is
    // what lets the neighbourhood follow an edge finer than `detail_step`, and clarity asks what
    // lies between two blurs, which needs the coarse one to stay a blur.
    let around = select(local, blur.g * base_stops + blur.b, base_stops);
    let smoothed = blur.g * blur.r + blur.b;

    // Dehaze first of the three, because it is the claim about the air rather than about the
    // subject.
    if (edit.dehaze != 0.0) { out = dehazed(out, blur.a); }

    // **The axis the zones are placed on goes through the dehaze as well, and with this pixel's
    // own `t`.** The colour leaves here as the recovered scene, so a pair of stops still
    // describing the veiled one would place every zone against a picture that is no longer on
    // screen - a reader who clears a frame and then reaches for Blacks would get Blacks where the
    // haze put it. `t` is exact rather than estimated for these two: it is the same number
    // `dehazed` just divided the colour by, where the *floor* the span is taken from has to
    // estimate its own (`low_span`).
    //
    // `base_luma` and not `luma`: a matched frame's colour has run the camera's rendering by now
    // and its stops are not the scene's (see the head of this file). The recovery is the same
    // affine map either way, so applying it to the frame's own luma keeps this axis in the
    // scene's stops, which is the only domain one set of zone constants is right for on every
    // photograph.
    //
    // **Beside `base_stops` rather than replacing it, because the two bands want the other one.**
    // `local_contrast` reads this pixel against `smoothed` and `blur.r`, which are blurs of the
    // frame as it arrived; recovering one side of a difference and not the other would put the
    // airlight it removed straight into the band.
    var zone_at = base_stops;
    var zone_around = around;
    if (edit.dehaze != 0.0) {
        let transmission = transmission_for(exp2(blur.a));
        zone_at = cleared_stops(base_stops, transmission);
        zone_around = cleared_stops(around, transmission);
    }

    let luma = dot(LUMA, out);
    if (luma <= 0.0) {
        // Black has no colour ratios; a lifted black is grey.
        let lifted = curve_light(curve_evaluated(CurveCode(0.0), false)).g;
        return measured<D>(float3(lifted));
    }

    // Texture and clarity with the dehaze, ahead of the light group rather than after it.
    //
    // **All three of the presence sliders say what the scene *is*; the light group says how to
    // render it.** Put the two bands after the tone curve and the detail a reader has just
    // recovered is the one part of the picture that curve never sees - so raising contrast
    // shapes everything except the texture, and a lift near white rides over the roll-off
    // unshaped instead of being compressed into it with its surroundings.
    //
    // Only the contrast can tell: a zone's weight is read off `scene_*` below rather than off
    // the value being carried, so the four of them are gains and gains commute with this one.
    // The contrast is a power about the pivot and does not, which is the whole of the difference
    // this ordering makes.
    var lit = luma;
    if (edit.texture_adjust != 0.0 || edit.clarity != 0.0) {
        lit = lit * exp2(local_contrast(base_stops, smoothed, blur));
    }

    // The recovered scene's own stops, which is the axis the zones are placed on. The exposure is
    // added rather than read off the graded pixel because it is a gain, so it moves a pixel along
    // this axis exactly - and the zones have to follow it, or lifting a photograph two stops would
    // leave `whites` acting on whatever used to be white.
    let scene_at = zone_at + edit.exposure;
    // The neighbourhood on that same axis. Both came off the base's stops through the same
    // recovery, so the exposure is the same constant on each and the pair stay a fixed distance
    // apart as the slider moves.
    let scene_around = zone_around + edit.exposure;

    let pivot = tone_pivot().v;
    let toned_luma = tone_adjusted(lit, scene_at, scene_around, pivot);
    let curved_luma = curve_light(curve_evaluated(curve_code(gain(toned_luma)), false)).g;
    // Against the luma this pixel arrived with, not the lit one: the ratio has to carry the whole
    // of what the two groups did, and dividing by `lit` would hand the colour the light group's
    // work alone and drop the detail back out of it.
    let held = out * (curved_luma / luma);
    return measured<D>(chroma_adjusted(held, curved_luma));
}
