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
// loads for one trilinear that `SampleLevel` performs in a single fetch.
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
import px;
import index_space;
import block_split;

// The frame stays as it arrived: interleaved RGB `u16` of normalised PQ, three to a pixel, in
// the buffer it was uploaded into. Not a texture, and not padded to four components - that
// padding is a constant 65535 costing a quarter of 481MB at 61MP, plus a second copy of the
// whole frame to write it. Nothing samples this level bilinearly, so a texture bought only
// the 2D cache and a raster scan does not need it.
[vk::binding(1, 0)] public StructuredBuffer<uint> frame;
[vk::binding(2, 0)] Texture2D<float4> curves;
/// The baked lattice (`lattice_bake.slang`): the chroma pair's 2x2, then the tint each chroma
/// axis takes from lightness and the lightness gain.
[vk::binding(3, 0)] Texture3D<float4> chroma;
[vk::binding(4, 0)] StructuredBuffer<float> matrix;
[vk::binding(10, 0)] Texture3D<float4> chroma_luma;
/// The reader's colour edits, baked as the match's lattice is (`lattice::ChromaMap::of_nodes`).
[vk::binding(11, 0)] Texture3D<float4> nodes;
[vk::binding(15, 0)] Texture3D<float4> nodes_luma;
// The frame's own light at arm's length (`hdr_fit::NeighbourhoodThumb`), spanning the whole
// photograph, which is what the lattice's neighbourhood axis reads.
[vk::binding(17, 0)] Texture2D<float> neighbourhood_map;
// The frame's nits at the fit's own footprint, two halves a block (`mean_frame.slang`), where
// the lattice is read so the correction meets colours the fit actually taught.
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
    let base = wide<Output>(pixel) * 3;
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
    // curve for all three, so a blown neutral stays neutral.
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

/// A place on one axis of the baked volumes, as a texture coordinate at its texel centre.
float texel_at(float t, uint texels)
{
    return (min(max(t, 0.0), float(texels - 1)) + 0.5) / float(texels);
}

/// How a baked lattice's volumes are laid out (`lattice::MapShape`).
struct Volumes
{
    uint hue_count;
    uint chroma_count;
    uint level_count;
    uint neighbourhood_count;
    float chroma_scale;
    float level_low;
    float level_scale;
    float neighbourhood_scale;
}

Volumes matched_volumes()
{
    Volumes v;
    v.hue_count = edit.hue_count;
    v.chroma_count = edit.chroma_count;
    v.level_count = edit.level_count;
    v.neighbourhood_count = edit.neighbourhood_count;
    v.chroma_scale = edit.chroma_scale;
    v.level_low = edit.level_low;
    v.level_scale = edit.level_scale;
    v.neighbourhood_scale = edit.neighbourhood_scale;
    return v;
}

Volumes node_volumes()
{
    Volumes v;
    v.hue_count = edit.node_hue_count;
    v.chroma_count = edit.node_chroma_count;
    v.level_count = edit.node_level_count;
    v.neighbourhood_count = edit.node_neighbourhood_count;
    v.chroma_scale = edit.node_chroma_scale;
    v.level_low = edit.node_level_low;
    v.level_scale = edit.node_level_scale;
    v.neighbourhood_scale = edit.node_neighbourhood_scale;
    return v;
}

/// A lattice's correction: the corrected chroma pair, then the corrected lightness.
///
/// `index` is where the lattice is read; `level`, `d0` and `d2` are what the operator found there
/// acts on. The fit taught every kernel on a supervision block's *mean*, so the read happens at
/// the neighbourhood's colour while the correction lands on the pixel's own.
///
/// The neighbourhood axis is packed into the volumes' depth, neighbourhood-major, and sampled one
/// slab at a time with the blend done here, so hardware filtering never blends across the seam.
float3 correct(
    Texture3D<float4> pair,
    Texture3D<float4> luma,
    Volumes shape,
    float3 index,
    float neighbourhood,
    float level,
    float d0,
    float d2)
{
    float4 cell;
    float4 rest;
    cells_at(pair, luma, shape, lattice_at(opponent_of(measured<Rendered>(index)), neighbourhood), cell, rest);
    // The lightness gain is stored as its deviation from 1: half floats carry a fixed relative
    // precision, and 1.02 spends it on the 1 where 0.02 spends it on the part that matters.
    return float3(
        cell.x * d0 + cell.y * d2 + rest.r * level,
        cell.z * d0 + cell.w * d2 + rest.g * level,
        (1.0 + rest.b) * level);
}

/// Both volumes at lattice place `at`.
void cells_at(
    Texture3D<float4> pair,
    Texture3D<float4> luma,
    Volumes shape,
    float4 at,
    out float4 cell,
    out float4 rest)
{
    // The hue axis carries a last texel that copies the first, so a turn of 1 is the same place
    // as 0 and the clamp sampler wraps without a sampler of its own.
    let tx = (at.x * float(shape.hue_count - 1) + 0.5) / float(shape.hue_count);
    let ty = texel_at(at.y * shape.chroma_scale, shape.chroma_count);
    let tz = min(max((at.z - shape.level_low) * shape.level_scale, 0.0), float(shape.level_count - 1));
    let ts = min(max(at.w * shape.neighbourhood_scale, 0.0), float(shape.neighbourhood_count - 1));
    let slab = min(uint(ts), shape.neighbourhood_count - 2);
    let fs = ts - float(slab);
    let depth = float(shape.level_count * shape.neighbourhood_count);
    let near = float3(tx, ty, (float(slab * shape.level_count) + tz + 0.5) / depth);
    let far = float3(tx, ty, (float((slab + 1) * shape.level_count) + tz + 0.5) / depth);

    cell = lerp(pair.SampleLevel(bilinear, near, 0.0), pair.SampleLevel(bilinear, far, 0.0), fs);
    rest = lerp(luma.SampleLevel(bilinear, near, 0.0), luma.SampleLevel(bilinear, far, 0.0), fs);
}

/// A place in the frame, in the photograph's own pixels.
///
/// **Exact on both routes, and that is the point.** `geometry_at` computes the photograph
/// position and subtracts the window's origin last, so adding that integer back recovers the
/// same float a whole render had. Every photograph-anchored texture below is indexed from this
/// rather than from a `uv`, which each route would have normalised by its own frame size.
float2 photo_at(float2 at)
{
    return at + float2(float(edit.neighbourhood_left), float(edit.neighbourhood_top));
}

/// The neighbourhood's brightness at a place in the frame, from the photograph's own
/// thumb (`hdr_fit::NeighbourhoodThumb`), in the same scene-linear units the fit read it in.
public float neighbourhood_of(float2 at)
{
    if (edit.has_neighbourhood == 0) { return 0.0; }
    let uv = photo_at(at)
        / float2(float(edit.neighbourhood_photo_width), float(edit.neighbourhood_photo_height));
    return neighbourhood_map.SampleLevel(bilinear, uv, 0.0);
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
    let ours = float2(float(edit.neighbourhood_left / step), float(edit.neighbourhood_top / step));
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

float3 mean_tap(int2 cell, float3 split)
{
    return mean_for(
        mean_frame.Load(int3(cell.x * 2, cell.y, 0)),
        mean_frame.Load(int3(cell.x * 2 + 1, cell.y, 0)),
        split,
        edit.reference);
}

/// `cell_at` over `mean_frame`'s two texels a block, each block's taken at the half `pixel`
/// belongs to (`block_split.slang`).
float3 mean_at(float2 at, uint step, float3 nits)
{
    let pixel = split_space(nits, edit.reference);
    uint wide;
    uint tall;
    mean_frame.GetDimensions(wide, tall);
    let scaled = photo_at(at) / float(step) - float2(0.5);
    let ours = float2(float(edit.neighbourhood_left / step), float(edit.neighbourhood_top / step));
    let local = scaled - ours;
    let low = floor(local);
    let f = local - low;
    let last = int2(int(wide / 2) - 1, int(tall) - 1);
    let a = clamp(int2(low), int2(0), last);
    let b = clamp(int2(low) + int2(1), int2(0), last);
    return lerp(
        lerp(mean_tap(a, pixel), mean_tap(int2(b.x, a.y), pixel), f.x),
        lerp(mean_tap(int2(a.x, b.y), pixel), mean_tap(b, pixel), f.x),
        f.y);
}

/// What happens around the grey axis, given a colour the matrix has already been through, and
/// the neighbourhood's colour through the same stages - where the lattice is read.
public Colour<Rendered> finish_chroma(Colour<Rendered> m, Colour<Rendered> at, float neighbourhood)
{
    let l = dot(LUMA, m.v);
    if (edit.has_chroma == 0) {
        if (edit.saturation == 1.0) { return m; }
        return measured<Rendered>(float3(l) + (m.v - float3(l)) * edit.saturation);
    }
    let shape = matched_volumes();
    return rebuilt(correct(chroma, chroma_luma, shape, at.v, neighbourhood, l, m.v.r - l, m.v.b - l));
}

/// The reader's colour edits (`lattice::ColourNode`) on `m`, keyed on `m` itself: in ZCAM's
/// opponent plane, the pair times one plus the volume's complex `(x, y)` plus its `(z, w)`, and the
/// lightness times one plus the second volume's `x`.
public Colour<Rendered> moved_by_reader(Colour<Rendered> m)
{
    if (edit.has_nodes == 0) { return m; }
    let o = opponent_of(m).v;
    float4 move;
    float4 rest;
    cells_at(nodes, nodes_luma, node_volumes(), lattice_at(exactly<Opponent>(o), 0.0), move, rest);
    // Out of every node's reach the round trip through ZCAM would still move the last bits.
    if (all(move == float4(0.0)) && rest.x == 0.0) { return m; }
    let z = o.yz;
    let turned = z + float2(move.x * z.x - move.y * z.y, move.x * z.y + move.y * z.x) + move.zw;
    return rendered_of(exactly<Opponent>(float3(o.x * (1.0 + rest.x), turned)));
}

/// The colour `moved_by_reader` is handed, on whichever arm `edit.matched` picks.
public Colour<Rendered> before_edits(Colour<SceneNits> nits, float2 at)
{
    if (edit.matched == 0) { return measured<Rendered>(lit_by_reader(nits).v / edit.reference); }
    return matched_smoothed(nits, at);
}

Colour<Rendered> rebuilt(float3 d)
{
    // The middle channel is not free: LUMA . d is zero by construction, so the two
    // coordinates carried through the map determine the third.
    let dg = -(LUMA.r * d.x + LUMA.b * d.y) / LUMA.g;
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
public Colour<SceneNits> lit_by_reader(Colour<SceneNits> nits)
{
    if (edit.as_shot_temperature <= 0.0) { return nits; }
    return in_gamut(balanced(nits));
}

/// The scene as the camera match saw it: lit by the illuminant it was fitted under.
Colour<SceneNits> lit_as_matched(Colour<SceneNits> nits)
{
    if (edit.as_shot_temperature <= 0.0) { return nits; }
    return in_gamut(match_balanced(nits));
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
/// The reader's own adjustments go in between, on the scene `camera_undone` takes the match back
/// to, which is the space `adjusted` is written against. Inside this function rather than at its callers precisely because the peak pass
/// calls it too: a highlight lift has to move the knee it will be rolled against, or the
/// roll-off would clip exactly what the slider just raised.
///
/// `uv` is where in the frame `nits` was read, which the presence sliders need and nothing
/// else does. Threaded rather than derived, because the three callers know it in three
/// different ways - a raster index, a canvas position, a kept candidate.
public Colour<DisplayNits> matched_nits(Colour<SceneNits> nits, float2 at)
{
    // After the smoothing, which would otherwise pull an edited colour back towards its
    // neighbourhood's unedited one.
    let rendered = moved_by_reader(matched_smoothed(nits, at));
    var graded = rendered.v;
    if (!sliders_at_camera()) {
        // Back to the scene and through the sliders there, which is the whole of why they read
        // the same on a frame the fit landed on and one it declined.
        Colour<Scene> untoned;
        camera_undone(rendered, untoned);
        Gain residual;
        camera_floor_residual(rendered, residual);
        Colour<Scene> adjusted_scene;
        adjusted(times(untoned, gain_of(stops(edit.exposure))), base_luma(nits), at, adjusted_scene);
        graded = adjusted_scene.v * residual.g;
    }
    // Last, on the colour a still will code: the matrix and the lattice are free to send a colour
    // past the floor, and this is the one place it is brought back before anything quantises it.
    return in_gamut(measured<DisplayNits>(graded * edit.reference));
}

/// The whole match, chroma smoothing included, before the reader's own edits.
Colour<Rendered> matched_smoothed(Colour<SceneNits> nits, float2 at)
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
    return measured<Rendered>(matched);
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
        // colour as the fit saw it - the same split the branch below makes one texel out. `m`
        // already is that where the reader is at the match's own balance, and the branch below
        // overwrites this.
        index = apply_matrix(curves_at(lit_as_matched(nits), gain(1.0))).v;
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
        let mean = measured<SceneNits>(mean_at(at, max(edit.mean_block, 1u), nits.v));
        let mean_lit = lit_by_reader(mean);
        // The index off the frame as the fit saw it, the value off the light the reader asked
        // for - the same split as above, one texel out.
        index = apply_matrix(curves_at(lit_as_matched(mean), gain(1.0))).v;
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
    return finish_chroma(measured<Rendered>(m), measured<Rendered>(index), neighbourhood_of(at));
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
    let knee = rolloff(neutral_peak(), measured<DisplayNits>(edit.peak), measured<DisplayNits>(edit.reference));
    return in_gamut(rolled(neutral_unrolled(nits, at), knee));
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
    let lit = measured<Rendered>(lit_by_reader(nits).v / edit.reference);
    let exposed = moved_by_reader(lit).v * gain_of(stops(edit.exposure)).g;
    Colour<Scene> scene;
    adjusted(measured<Scene>(exposed), base_luma(nits), at, scene);
    // **Scene nits taken as display nits, which is what having no tone curve means.** This arm's
    // whole rendering is `neutral_nits`' roll-off, so the reference is multiplied back in and the
    // result is handed to a display without a camera's own answer in between.
    return measured<DisplayNits>(scene.v * edit.reference);
}
