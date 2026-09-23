// Scene-linear `u16` RGB to display-referred nits.
//
// The whole grade as a function rather than a pass: the pixel is already in a register when
// the next stage wants it. The fit runs the same stages over its own samples
// (`fit_model.slang`), so the model it chooses is measured on the arithmetic that renders it.
//
// The neutral and matched arms are both here rather than specialised into two pipelines,
// because a frame whose fit declined and one whose fit landed differ by a branch on a
// uniform, which every invocation in the dispatch takes the same way.
//
// The two lookups are textures with a filtering sampler rather than storage buffers with
// the blend written out, which is the same data read the way the hardware reads it: a
// texture unit does the fetch, the weights and the blend as one instruction. The chroma map
// is the extreme case: eight corners times four components is thirty-two dependent scalar
// loads for one trilinear that `SampleLevel` performs in a single fetch, and it measured at
// 2.6ms of a 15ms edit.
//
// The tone curve does NOT take that filter, and the difference is not luck. Hardware
// filter weights carry about eight fractional bits; against a chroma correction that is
// nothing, and against a tone curve read where the PQ curve is steep it is everything -
// parity went from 6 counts to 1735 in the shadows. What saves the chroma map is that its
// corrections multiply chroma differences, which vanish exactly where PQ gets steep.
module colour;

import prelude;
import edit;
import adjust;
import packed;
import light;

// The frame stays as it arrived: interleaved RGB `u16` of normalised PQ, three to a pixel, in
// the buffer it was uploaded into. Not a texture, and not padded to four components - that
// padding is a constant 65535 costing a quarter of 481MB at 61MP, plus a second copy of the
// whole frame to write it. Nothing samples this level bilinearly, so a texture bought only
// the 2D cache and a raster scan does not need it.
[vk::binding(1, 0)] public StructuredBuffer<uint> frame;
[vk::binding(2, 0)] Texture2D<float4> curves;
[vk::binding(3, 0)] Texture3D<float4> chroma;
[vk::binding(4, 0)] StructuredBuffer<float> matrix;
// The rest of the node, past the four a single `rgba16float` texel holds. The alternatives
// to more textures all cost the hardware trilinear: packing two nodes per texel breaks
// filtering on whichever axis is doubled, and widening the volume means interpolating in the
// shader. Another volume is one more fetch and nothing else.
[vk::binding(10, 0)] Texture3D<float4> chroma_luma;
// The ninth value, in a volume of its own. Eight fill two `rgba16float` texels exactly, so
// the chroma-to-lightness pair costs one more fetch and three spare slots per node.
[vk::binding(11, 0)] Texture3D<float4> chroma_tint;
// The frame's own light at arm's length (`hdr_fit::SurroundThumb`), spanning the whole
// photograph, which is what the lattice's surround axis reads.
[vk::binding(17, 0)] Texture2D<float> surround_map;
// The frame's nits at the fit's own footprint (`mean_frame.slang`), where the lattice is
// read so the correction meets colours the fit actually taught.
[vk::binding(19, 0)] Texture2D<float4> mean_frame;
// The matched colour encoded for display and smoothed the way the camera smooths chroma
// (`chroma_smooth.slang`), a texel per `edit.chroma_shrink` pixels on a grid anchored at the
// photograph's origin, as `mean_frame` is.
[vk::binding(21, 0)] Texture2D<float4> chroma_smoothed;

/// The display encoding the camera smooths chroma under.
public static const float CHROMA_GAMMA = 2.2;

/// How far rendering a pixel through its neighbourhood's curve may move it from rendering it
/// through its own (`matched_scene`).
public static const Stops MEAN_MOVES_BY = { 0.05 };

/// How far the neighbourhood's chroma may move a pixel's own, in the encoded units
/// `matched_nits` smooths in.
public static const float CHROMA_MOVES_BY = 0.005;
// `decode` fills it, once per device. Read-only here, which is why it is filled there.
[vk::binding(12, 0)] public StructuredBuffer<float> nits_of_code;

/// One `u16` of the stream, which is half of a word. Three samples to a pixel means no
/// pixel is word-aligned, so there is no reading one as a struct.
public uint sample_at(uint index)
{
    return half_of(frame[index / 2], index);
}

/// The frame's codes at a pixel, by its index in the raster. The buffer is linear, so a
/// caller walking it in one dimension needs no `x` and `y` to get back.
public float3 level_of(uint pixel)
{
    let base = pixel * 3;
    return float3(float(sample_at(base)), float(sample_at(base + 1)), float(sample_at(base + 2)));
}

/// The frame's codes at a pixel, full resolution, as the buffer holds them.
public float3 level_at(uint x, uint y)
{
    return level_of(at(x, y));
}

// **The four fetches below are `float3` rather than `Colour<SceneNits>`, and that is the loop rule
// rather than an omission.** They run under `nits_cubic`'s stencil and under `chroma_smooth`'s
// box, where `no_struct_returns_under_a_loop` refuses a struct returned by value. Each caller
// wraps once instead, where the domain is what it is naming.

/// A code back to the nits `tone::encode_base` coded, which is `level * reference / white`.
///
/// So dividing by `edit.reference` gives the `level / white` every stage below wants, and the
/// frame's own diffuse white lands at 1.0 exactly as it did when the buffer held levels.
///
/// Rounded rather than interpolated between entries: a code is what the buffer holds, and the
/// only callers with a fractional one are averaging codes they already read through here.
public float3 nits_of(float3 code)
{
    return float3(
        nits_of_code[uint(code.r)],
        nits_of_code[uint(code.g)],
        nits_of_code[uint(code.b)]);
}

public float3 nits_at(uint x, uint y)
{
    return nits_of(level_at(x, y));
}

public float3 nits_of_index(uint pixel)
{
    return nits_of(level_of(pixel));
}

/// Linear interpolation over `curve_bins` samples spanning 0..`trust_ceiling`.
///
/// A row per channel, and the interpolation written out rather than sampled, for the
/// precision reason above.
float sample_curve(uint channel, float x)
{
    let bins = edit.curve_bins;
    let t = clamp(x / edit.trust_ceiling, 0.0, 1.0) * float(bins - 1);
    let below = min(uint(t), bins - 2);
    let row = int(channel);
    let lo = curves.Load(int3(int(below), row, 0)).r;
    let hi = curves.Load(int3(int(below) + 1, row, 0)).r;
    return lerp(lo, hi, t - float(below));
}

/// The tone stage at a given exposure scale: the camera's per-channel rendering below the
/// ceiling, its colour alone above it.
///
/// The shared gain matters: below the ceiling it is 1 and the stage is separable, which is
/// almost every pixel. Above it the pixel is divided down into the curve's domain and read
/// there, so the three channels move together, and its level comes from the scene at the
/// exposure the match holds at diffuse white. Skipping either leaves highlights wrong by
/// hundreds of counts, which is exactly where a grade is judged. Letting each channel run on
/// its own extrapolation instead is what tinted the sky magenta: the three end slopes came
/// out 0.435 / 0.206 / 0.336, so red and blue climbed at twice green's rate and the drift
/// grew with brightness.
///
/// The ratios of that read come from `edit.tone_anchor` rather than the ceiling, weighted
/// in as the pixel climbs. Read at the ceiling they are read at the camera's shoulder, and a
/// shoulder is 8-bit clipping rather than a rendering: measured, a scene colour of
/// saturation 0.80 went out at 0.92 through the midtones, 0.80 by the ceiling, and then 0.80
/// for 1x, 3x and 8x diffuse white alike - a sunset rendered flatter than the same colour in
/// the shadows, in the one range no SDR frame can hold. The level is untouched by any of it:
/// only what sits beneath the pixel's own peak moves.
public Colour<Rendered> curves_at(Colour<SceneNits> nits, Gain scale)
{
    let scene = nits.v * scale.g / edit.reference;
    let peak = max(scene.r, max(scene.g, scene.b));
    let s = max(peak / edit.trust_ceiling, 1.0);
    let toned = float3(
        sample_curve(0, scene.r / s),
        sample_curve(1, scene.g / s),
        sample_curve(2, scene.b / s));
    let top = max(toned.r, max(toned.g, toned.b));
    if (s <= 1.0 || top <= 0.0) { return measured<Rendered>(toned); }

    // The colour of a highlight, read where the camera's rendering still expands chroma
    // (`chroma_anchor`) rather than at the shoulder it clips into, and off one channel's
    // curve for all three: `grey_balance`'s gain is tapered to unity at the ceiling so a
    // blown neutral stays neutral, and read per channel at the anchor, where the taper is
    // still half-strength, it comes straight back.
    var ratios = toned / top;
    if (edit.tone_anchor < edit.trust_ceiling)
    {
        let by = peak / edit.tone_anchor;
        let shape = float3(
            sample_curve(1, scene.r / by),
            sample_curve(1, scene.g / by),
            sample_curve(1, scene.b / by));
        let shape_top = max(max(shape.r, max(shape.g, shape.b)), 1e-12);
        ratios = lerp(ratios, shape / shape_top, 1.0 - edit.trust_ceiling / peak);
    }

    // Multiplied by `s` instead, the multiplier is the curve's last value - which is the
    // camera's shoulder, so the JPEG's clipping is spent on the range that only exists
    // because the JPEG could not hold it.
    // A ratio at the highest level the domain still holds, not the curve's value at 1.0: a
    // domain stopping below diffuse white would read its own last bin, and an identity fit
    // has to stay identity at every level whatever the domain reaches.
    let read_at = min(edit.trust_ceiling, 1.0);
    let at_white =
        dot(LUMA, float3(sample_curve(0, read_at), sample_curve(1, read_at), sample_curve(2, read_at)))
        / read_at;
    return measured<Rendered>(ratios * (top + (peak - edit.trust_ceiling) * at_white));
}

/// What the exposure amounts to at this pixel: the exposed colour's luma over the base's.
///
/// A scalar rather than the exposed colour, so the ratios carried forward are the base's,
/// which is what keeps hue still as the slider moves.
///
/// Also why the peak cannot be precomputed as a curve: the exposure arrives as a gain that
/// depends on the pixel's own luma, not as a global one.
Gain exposure_gain(Colour<SceneNits> nits, Colour<Rendered> base)
{
    if (edit.exposure == 0.0) { return gain(1.0); }
    let base_luma = luma_of(base).v;
    // Black has no ratios to hold and no luma to divide by, and nothing above it is additive,
    // so it stays where it is however far the slider goes.
    if (base_luma <= 0.0) { return gain(1.0); }
    return gain(luma_of(curves_at(nits, gain_of(stops(edit.exposure)))).v / base_luma);
}

/// `ChromaMap::axis`, as a texture coordinate: the node index, at its texel centre.
float axis(float value, uint nodes, float low, float scale)
{
    let t = min(max((value - low) * scale, 0.0), float(nodes - 1));
    return (t + 0.5) / float(nodes);
}

/// The lattice's correction, trilinear: the corrected chroma pair, then the corrected
/// lightness.
///
/// Two fetches at the same coordinate, one per volume, so both halves of a node are
/// blended over the same corners with the same weights.
///
/// `at_*` say where the lattice is read; `level`, `d0` and `d2` are what the operator
/// found there acts on. The fit taught every node on a supervision block's *mean*, so the
/// read happens at the neighbourhood's colour while the correction lands on the pixel's
/// own - one coordinate for both is exact only where a pixel is its own neighbourhood.
///
/// The surround axis is packed into the volumes' depth, surround-major, and sampled one
/// slab at a time with the blend done here: the level axis clamps inside its slab, so
/// hardware filtering never blends across the seam, and the two slabs lerp over the same
/// sixteen corners the fit landed its samples on (`ChromaMap::nodes_of`).
float3 correct(
    float at_level, float surround, float at_d0, float at_d2,
    float level, float d0, float d2)
{
    let at2 = float2(
        // A span per axis. Red-green and blue-yellow are not distributed alike in a frame, and
        // one span for both leaves the narrower axis' outer nodes permanently empty.
        //
        // The chroma axes are walked in signed root space, the level axis in root space: a
        // frame's chroma masses near neutral the way its levels mass in the shadows, so the
        // nodes go where the colours are. `ChromaMap::warp` is the host's half of this.
        axis(sign(at_d0) * sqrt(abs(at_d0)), edit.chroma_count, edit.chroma_low, edit.chroma_scale),
        axis(sign(at_d2) * sqrt(abs(at_d2)), edit.chroma_count, edit.chroma_low_by, edit.chroma_scale_by));
    let tz = min(max(sqrt(max(at_level, 0.0)) * edit.level_scale, 0.0), float(edit.level_count - 1));
    let ts = min(
        max(sqrt(max(surround, 0.0)) * edit.surround_scale, 0.0),
        float(edit.surround_count - 1));
    let slab = min(uint(ts), edit.surround_count - 2);
    let fs = ts - float(slab);
    let depth = float(edit.level_count * edit.surround_count);
    let near = float3(at2, (float(slab * edit.level_count) + tz + 0.5) / depth);
    let far = float3(at2, (float((slab + 1) * edit.level_count) + tz + 0.5) / depth);

    let cell = lerp(chroma.SampleLevel(bilinear, near, 0.0),
                    chroma.SampleLevel(bilinear, far, 0.0), fs);
    // The volume holds the gain's *deviation* from 1, and the 1 is added here. Half floats
    // carry a fixed relative precision, so storing 1.02 spends it all on the 1 and leaves
    // 2^-11 of full scale on the part that matters; storing 0.02 spends it on the 0.02.
    // It is worth 16x here, and it has to be: the 2x2 above multiplies chroma differences,
    // which are small, where this multiplies luma itself. Stored as a gain the parity
    // fixtures miss by 1.33 against a bound of 0.5, all of it f16.
    // `.r` and `.g` are the luma-to-chroma pair and carry `level`, which is what lets a node
    // move a colour that arrived with no chroma at all - the only part of this that acts on a
    // neutral, and so the only part that can express a cast. They need no deviation trick:
    // zero already means no tint.
    let rest = lerp(chroma_luma.SampleLevel(bilinear, near, 0.0),
                    chroma_luma.SampleLevel(bilinear, far, 0.0), fs);
    let tint = lerp(chroma_tint.SampleLevel(bilinear, near, 0.0),
                    chroma_tint.SampleLevel(bilinear, far, 0.0), fs);
    // The third component is the corrected lightness outright, not a gain: it depends on
    // chroma as well as level, so there is no single factor to multiply by. That is what lets
    // a small saturated object take a different lightness correction from the surroundings it
    // shares a node with, where one gain per node could only give them the average.
    return float3(
        cell.x * d0 + cell.y * d2 + rest.r * level,
        cell.z * d0 + cell.w * d2 + rest.g * level,
        // **The chroma-to-lightness pair reads the chroma the fit was taught, scaled to this
        // pixel's level.** `d0` and `d2` are the colour as the reader has lit it, and a balance
        // multiplies chroma several times over - so `rest.a * d0` is a coefficient calibrated on
        // one magnitude meeting another, and the lightness it produces stops tracking the level
        // at all. Two samples of one surface then cross: measured at 2300K on a daylight frame,
        // 4.6% of lit pairs across the picture reversed. Taken off the index as a chromaticity
        // and scaled by `level` the term is proportional to what arrived, as the rest of the row is.
        (1.0 + rest.b) * level
            + (rest.a * chromaticity(at_d0, at_level, LUMA.r)
                + tint.r * chromaticity(at_d2, at_level, LUMA.b)) * level);
}

/// A chroma difference over its luma, held to what a colour with no negative channel can have:
/// `-1` where the channel is empty, `1 / weight - 1` where it is the whole luma.
///
/// The matrix hands the lattice colours past that - a saturated red at negative green with a
/// luma near nothing - and dividing by that luma is a term whose size and sign follow the noise,
/// which rendered as pink and dark speckle over one hue.
float chromaticity(float d, float at_level, float weight)
{
    if (at_level <= 0.0) { return 0.0; }
    return clamp(d / at_level, -1.0, 1.0 / weight - 1.0);
}

/// A place in the frame, in the photograph's own pixels.
///
/// **Exact on both routes, and that is the point.** `geometry_at` computes the photograph
/// position and subtracts the window's origin last, so adding that integer back recovers the
/// same float a whole render had. Every photograph-anchored texture below is indexed from this
/// rather than from a `uv`, which each route would have normalised by its own frame size.
float2 photo_at(float2 at)
{
    return at + float2(float(edit.surround_left), float(edit.surround_top));
}

/// The neighbourhood's brightness at a place in the frame, from the photograph's own
/// thumb (`hdr_fit::SurroundThumb`), in the same scene-linear units the fit read it in.
public float surround_of(float2 at)
{
    if (edit.has_surround == 0) { return 0.0; }
    let uv = photo_at(at)
        / float2(float(edit.surround_photo_width), float(edit.surround_photo_height));
    return surround_map.SampleLevel(bilinear, uv, 0.0);
}

/// One texel of a photograph-anchored cell grid, read where the pixel actually sits.
///
/// **Bilinear by hand, off the photograph's own coordinate.** Two things stop the hardware
/// doing this. Its coordinate is normalised by the texture, and a window's grid holds fewer
/// cells than the whole picture's, so the divide and the sampler's multiply do not cancel to
/// the same bits. And the obvious repair - dividing the frame-local position by the step -
/// divides a *different numerator* on each route, which rounds apart in the last place all over
/// again.
///
/// So the divide happens on the photograph position, which both routes hold exactly, and only
/// then is the window's own offset taken off - as a whole number of cells, which is exact and
/// leaves the fraction between the taps identical. Both routes then blend the same two cells by
/// the same weight; only the indices differ, and `Load` takes them as they are.
float4 cell_at(Texture2D<float4> cells, float2 at, uint step)
{
    uint wide;
    uint tall;
    cells.GetDimensions(wide, tall);
    let scaled = photo_at(at) / float(step) - float2(0.5);
    let ours = float2(float(edit.surround_left / step), float(edit.surround_top / step));
    let local = scaled - ours;
    let low = floor(local);
    let f = local - low;
    let last = int2(int(wide) - 1, int(tall) - 1);
    let a = clamp(int2(low), int2(0), last);
    let b = clamp(int2(low) + int2(1), int2(0), last);
    return lerp(
        lerp(cells.Load(int3(a, 0)), cells.Load(int3(b.x, a.y, 0)), f.x),
        lerp(cells.Load(int3(a.x, b.y, 0)), cells.Load(int3(b, 0)), f.x),
        f.y);
}

/// What happens around the grey axis, given a colour the matrix has already been through, and
/// the neighbourhood's colour through the same stages - where the lattice is read.
public Colour<Rendered> finish_chroma(Colour<Rendered> m, Colour<Rendered> at, float surround)
{
    let l = dot(LUMA, m.v);
    if (edit.has_chroma == 0) {
        if (edit.saturation == 1.0) { return m; }
        return measured<Rendered>(float3(l) + (m.v - float3(l)) * edit.saturation);
    }
    let la = dot(LUMA, at.v);
    let d = correct(la, surround, at.v.r - la, at.v.b - la, l, m.v.r - l, m.v.b - l);
    // The middle channel is not free: LUMA . d is zero by construction, so the two
    // coordinates carried through the map determine the third.
    let dg = -(LUMA.r * d.x + LUMA.b * d.y) / LUMA.g;
    // The map is read at the level the colour arrived with, so the lookup cannot depend on
    // its own output. `d.z` is the corrected lightness outright rather than a gain on `l`,
    // and is floored at zero: a chroma term large enough to go negative is a node the fit had
    // no business trusting, and black is the honest answer there rather than a wrapped colour.
    let lit = max(d.z, 0.0);
    return measured<Rendered>(float3(lit + d.x, lit + dg, lit + d.y));
}

/// The camera's own primaries into Rec.2020, which is what every weighting below `LUMA` assumes.
public Colour<Rendered> apply_matrix(Colour<Rendered> t)
{
    let v = t.v;
    return measured<Rendered>(float3(
        matrix[0] * v.r + matrix[1] * v.g + matrix[2] * v.b,
        matrix[3] * v.r + matrix[4] * v.g + matrix[5] * v.b,
        matrix[6] * v.r + matrix[7] * v.g + matrix[8] * v.b));
}

/// The scene as the illuminant the reader named would have lit it, before the camera's rendering.
///
/// **A balance is a claim about the light, so it belongs where the light is - upstream of the
/// match, not on top of the picture the match produced.** Applied afterwards it lands on values
/// the tone curve has already compressed, where there is no headroom left: a daylight frame told
/// the light was 2000K needs most of a decade of blue, and post-curve that is a channel pinned at
/// the top of the range and another floored at zero, which is a flat blue field with no way back.
///
/// The identity where the frame's camera recorded no neutral, which is a photograph with nothing
/// to balance *away from* however the sliders are set.
Colour<SceneNits> lit_by_reader(Colour<SceneNits> nits)
{
    if (edit.as_shot_temperature <= 0.0) { return nits; }
    return in_gamut(balanced(nits));
}

/// What the match makes of the frame's own diffuse white.
///
/// **The fit's target is the camera's own rendering, so this is not 1.0 and is not a constant.**
/// `curves_at` lands diffuse white wherever that body's JPEG put it, which is a different level
/// on every photograph - measured across two frames of this repo's fixtures, two stops apart.
/// Everything `adjusted` does is placed against 1.0: the four tone zones, the dehaze's airlight,
/// and the `detail` blur it compares a pixel against, which `base_luma` supplies in that domain
/// already. So the matched arm divides by this on the way in and multiplies back on the way out,
/// or the sliders are measured against a white that moves per photo - which reads as highlights
/// covering the whole picture on one frame and shadows reaching nothing on another.
///
/// **Through `lit_by_reader`, because white is white under the light being graded.** Measure it
/// on the unbalanced frame while the pixels take the balanced path and the normalisation is for
/// a different illuminant than the picture: everything `adjusted` places then sits at the wrong
/// level, and the brightest part of the frame rolls off hardest. On a daylight frame at 2000K
/// that inverted the top of the range outright - the scene's own white graded darker than a stop
/// under it, 9483 against 10299.
Light<Rendered> matched_white()
{
    let white = measured<SceneNits>(float3(edit.reference));
    return measured<Rendered>(
        max(luma_of(apply_matrix(curves_at(lit_by_reader(white), gain(1.0)))).v, 1e-6));
}

/// Middle grey after the same rendering, as a fraction of the white above.
///
/// **A camera's tone curve is mostly this number**, so it cannot be assumed: lifting the midtones
/// against diffuse white is what makes a rendering look like a photograph rather than like a
/// light meter, and it moves middle grey by upwards of a stop. What needs it is the contrast,
/// which turns the value it is handed about the middle of the picture - hand it `PIVOT` and a
/// rendered frame turns about a point well below its own midtones, darkening as it steepens.
/// Through `lit_by_reader` for the same reason white is: a grey is only middle grey under the
/// light the picture is being graded under.
Light<Graded> matched_pivot(Light<Rendered> white)
{
    let grey = measured<SceneNits>(float3(edit.reference * PIVOT.v));
    let rendered = luma_of(apply_matrix(curves_at(lit_by_reader(grey), gain(1.0)))).v;
    return measured<Graded>(clamp(rendered / white.v, 0.02, 0.9));
}

/// The frame's own luma at a pixel, scene-relative, before the match and before the exposure.
///
/// What `detail` blurred, and so the only value a difference against that blur is
/// meaningful in. Both arms hand it to `adjusted` beside the graded colour, because the
/// presence sliders act on the base's detail while everything else acts on the graded pixel.
public Light<Scene> base_luma(Colour<SceneNits> nits)
{
    return measured<Scene>(luma_of(nits).v / edit.reference);
}

/// The matched colour in nits, before any roll-off. Shared with the peak pass so the two
/// cannot measure one thing and grade another.
///
/// The reader's own adjustments go in between, while the colour is still scene-relative -
/// `finish_chroma` leaves diffuse white at 1.0, which is the space `adjusted` is written
/// against. Inside this function rather than at its callers precisely because the peak pass
/// calls it too: a highlight lift has to move the knee it will be rolled against, or the
/// roll-off would clip exactly what the slider just raised.
///
/// `uv` is where in the frame `nits` was read, which the presence sliders need and nothing
/// else does. Threaded rather than derived, because the three callers know it in three
/// different ways - a raster index, a canvas position, a kept candidate.
public Colour<DisplayNits> matched_nits(Colour<SceneNits> nits, float2 at)
{
    var matched = matched_scene(nits, at).v;
    // Own encoded luma, the neighbourhood's encoded chroma (`chroma_smooth.slang`): after the
    // whole model, so the blur flattens only what the camera flattens, and before the
    // exposure and the sliders, which the neighbourhood was encoded without.
    if (edit.has_smoothed != 0) {
        let around = cell_at(chroma_smoothed, at, max(edit.chroma_shrink, 1u)).rgb;
        let encoded = pow(max(matched, float3(0.0)), float3(1.0 / CHROMA_GAMMA));
        let luma = dot(LUMA, encoded);
        let mine = encoded - luma;
        // **The neighbourhood corrects this pixel's chroma; it does not replace it.** The texture
        // it is read from is built at `chroma_shrink`, so a floral two pixels wide is averaged
        // into the beam behind it before any of this runs and cannot be recovered downstream -
        // taking `around` whole then paints the beam's colour onto the floral. Bounded, chroma
        // noise still flattens, because noise is small: what is further from its surroundings
        // than this is painted detail, and it keeps its own colour.
        let moved = clamp(around - dot(LUMA, around) - mine,
                          float3(-CHROMA_MOVES_BY), float3(CHROMA_MOVES_BY));
        matched = pow(max(luma + mine + moved, float3(0.0)), float3(CHROMA_GAMMA));
    }
    let base = curves_at(nits, gain(1.0));
    matched *= exposure_gain(nits, base).g;

    // Into `Graded` on the way in and back out on the way out, which is the whole of why the
    // sliders read the same on a frame the fit landed on and one it declined.
    let white = matched_white();
    let graded = adjusted(
        measured<Graded>(matched / white.v), base_luma(nits), at, matched_pivot(white));
    // Last, on the colour a still will code: the matrix and the lattice are free to send a colour
    // past the floor, and this is the one place it is brought back before anything quantises it.
    return in_gamut(measured<DisplayNits>(graded.v * white.v * edit.reference));
}

/// The match, scene-relative: everything of `matched_nits` that depends on the frame and the
/// fit alone, which is what `chroma_smooth.slang` encodes.
public Colour<Rendered> matched_scene(Colour<SceneNits> nits, float2 at)
{
    // **The curve takes the light the reader asked for; the lattice is read where it was
    // fitted.** Those are two different jobs and the balance belongs on only one of them. A tone
    // curve is a target on the *light* - it has a shoulder, so a channel the balance has raised a
    // decade is compressed by it rather than running off the top of the range, which is the whole
    // reason the balance moved ahead of the match. The lattice below is a target on the *colour*,
    // indexed by it: hand it a frame just turned deep blue and it reads corrections fitted for a
    // deep blue subject and applies them to the sky, the stone and the trees alike, which is the
    // model undoing the change that was asked for.
    let lit = lit_by_reader(nits);
    let base = curves_at(lit, gain(1.0));
    // **The match before the exposure, not after it.** The lattice is read at the level the
    // colour arrives with, and the fit only ever saw the levels the camera's own rendering had -
    // so a colour handed to it already lifted lands on the outermost nodes whatever it was, and
    // takes the correction fitted for a clipping highlight. A magenta cast that grows with the
    // slider is what that looks like.
    var m = apply_matrix(base).v;
    var index = m;
    if (edit.has_mean == 0 && edit.as_shot_temperature > 0.0) {
        // Indexing the lattice with the light the reader asked for is what walks a rebalanced
        // frame onto nodes fitted for a colour the camera never saw, so the index comes off the
        // unbalanced colour - the same split the branch below makes one texel out. `m` already is
        // that on a frame nobody has rebalanced, and the branch below overwrites this.
        index = apply_matrix(curves_at(nits, gain(1.0))).v;
    }
    // The whole nonlinear front end read at the neighbourhood the fit taught, not at the
    // pixel it never saw (`mean_frame.slang`): the fit teaches on supervision-block
    // means, and at those means it is measured right - but a curve applied per pixel
    // does not average back to the curve of the mean, by its curvature times the
    // texture's own spread. That gap follows the lighting, and lands on a smooth slope
    // as broad hue bands the camera does not print. The pixel rides through as its
    // ratios against the neighbourhood, so the block's mean rendering equals the fitted
    // answer and texture passes through as light rather than through the curve's bend.
    if (edit.has_mean != 0) {
        let mean = measured<SceneNits>(cell_at(mean_frame, at, max(edit.mean_block, 1u)).rgb);
        let mean_lit = lit_by_reader(mean);
        // The index off the frame as the fit saw it, the value off the light the reader asked
        // for - the same split as above, one texel out.
        index = apply_matrix(curves_at(mean, gain(1.0))).v;
        let curved = curves_at(mean_lit, gain(1.0)).v;
        // **The ratio is a first-order expansion about the mean, and nothing here bounds how far
        // it is carried.** Over a block's own texture it is a percent or two and it is what makes
        // the block's mean rendering come out right; across a silhouette the neighbourhood is two
        // populations, its mean describes neither, and a linear term carried three stops out of a
        // compressive curve overshoots it badly - measured, the lit side of a roofline rendered
        // 9% brighter than the same sky further along, with a dark ring outside that, which is a
        // halo the camera does not print. The cap is on how far this may move a pixel from its
        // own curve, not on the spread that got it there: the correction grows with the spread
        // but so does ordinary texture, and half a frame sits past any spread small enough to
        // catch an edge. Identity at a ratio of one, which is the fit's own grid, so nothing the
        // model was taught on moves.
        let by_mean =
            apply_matrix(measured<Rendered>(curved * lit.v / max(mean_lit.v, float3(1e-6)))).v;
        let moved = log2(max(by_mean / max(m, float3(1e-6)), float3(1e-6)));
        m *= exp2(clamp(moved, float3(-MEAN_MOVES_BY.s), float3(MEAN_MOVES_BY.s)));
    }
    return finish_chroma(measured<Rendered>(m), measured<Rendered>(index), surround_of(at));
}

/// The neutral arm: one shared curve, so channel ratios survive whatever the input.
///
/// The frame arrives anchored - `tone::encode_base` divided by diffuse white and multiplied
/// by the reference before coding - so what the levels form of this divided out is already
/// done, and the exposure is what is left. It cancelled out of `neutral_peak` there and does
/// here too: the ratio of the frame's peak to its own white is what the roll-off is against,
/// and a gain moves both.
public Colour<DisplayNits> neutral_nits(Colour<SceneNits> nits, float2 at)
{
    // The floor last, as the matched arm takes it: the sliders can send a channel under it.
    return in_gamut(rolled(neutral_unrolled(nits, at), rolloff(neutral_peak(), measured<DisplayNits>(edit.peak))));
}

/// The neutral arm's top end: how far over its own diffuse white the frame's top end sits.
public Light<DisplayNits> neutral_peak()
{
    // A ratio of two levels, so the container they are counts of divides out.
    let over_white = over(measured<Level>(edit.source_level), measured<Level>(edit.white));
    return measured<DisplayNits>(over_white.g * edit.reference);
}

/// The neutral arm before its roll-off.
public Colour<DisplayNits> neutral_unrolled(Colour<SceneNits> nits, float2 at)
{
    // Adjusted in the same scene-relative space the matched arm uses, so one set of sliders
    // means one thing whether or not the fit landed.
    //
    // The knee does not move with it here, unlike the matched arm: this arm's peak comes off
    // `source_level` rather than being measured, so a highlight lift can push past it. What
    // catches that is `display_nits`' clamp - the top of the range rather than a curve into
    // it. Worth knowing before reaching for a big lift on a frame whose fit declined.
    let exposed = lit_by_reader(nits).v * gain_of(stops(edit.exposure)).g / edit.reference;
    let scene = adjusted(measured<Scene>(exposed), base_luma(nits), at, PIVOT);
    // **Scene nits taken as display nits, which is what having no tone curve means.** This arm's
    // whole rendering is `neutral_nits`' roll-off, so the reference is multiplied back in and the
    // result is handed to a display without a camera's own answer in between.
    return measured<DisplayNits>(scene.v * edit.reference);
}
