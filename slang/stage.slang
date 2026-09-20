// The viewer's stage: a decoded frame painted onto an extended-range canvas.
//
// **This is a browser's shader and it is here anyway.** It runs nowhere but WebGPU, over planes
// `VideoFrame.copyTo` handed back, and nothing in `native/rawshim` dispatches it. What it shares
// with the rest of `slang/` is the arithmetic, and that is the whole reason it moved: the transfer,
// the roll-off and BT.2020's weights were written a second time in TypeScript, where no test on
// either side could see them disagree.
//
// The one thing it cannot say is WebGPU's `texture_external`, which Slang has no type for. That
// path is a copy - the import already converted into the canvas's primaries and left the value on
// the canvas's curve - so it stays as hand-written WGSL beside this, carrying no arithmetic.

import prelude;
import stage_shared;
import light;
import primaries;

/// Ten-bit video range. A twelve-bit frame's are four times these, so `depth` divides the sample
/// rather than a second set of constants existing to be kept in step.
static const float LUMA_FLOOR = 64.0;
static const float LUMA_SPAN = 876.0;
static const float CHROMA_MID = 512.0;

/// Ten-bit video range quantises chroma as `896 * C + 512`, and C spans +-0.5 rather than +-1.
///
/// So this is the whole span and not the half one the code range (64..960) suggests: halving it
/// doubles every chroma, which is a picture with the hues and the white intact and twice the
/// saturation. Checked against ffmpeg's decode of a real render, where 896 is exact to 0.0% on all
/// three channels and 448 is out by 15-65%.
static const float CHROMA_SPAN = 896.0;

/// BT.2020 non-constant luminance, which is what the encoder wrote.
static const float3x3 YUV_TO_RGB = float3x3(
    1.0,  0.0,          1.4746,
    1.0, -0.16455313,  -0.57135313,
    1.0,  1.8814,       0.0);

struct Colour {
    float headroom;
    float reference;
    /// Region pixels per canvas pixel. The planes hold the region, and the canvas is capped by
    /// DETAIL_PIXELS, so the two are the same size only when nothing capped it.
    float2 sample;
    /// What to divide a loaded sample by to put it on the ten-bit scale the ranges above are
    /// written against: 1 for a ten-bit frame, 4 for a twelve-bit one. The two depths differ by
    /// exactly two bits, so every one of those four constants scales by the same factor and
    /// dividing here is the whole of it - and f32 keeps the extra bits as fraction rather than
    /// throwing them away, which is the point of writing twelve in the first place.
    float depth;
    /// Chroma pixels per luma pixel: a half for 4:2:0, one for the 4:4:4 a still with a measured
    /// chroma leak is written as (`job::CHROMA_LEAK_TILE_FRACTION`).
    float chroma;
    /// Where `planar_masked` reads for a canvas pixel, relative to it, in canvas pixels: a merge
    /// piece taken from where its content went in its frame.
    float2 shift;
    /// What `planar_masked`'s light is multiplied by: a merge piece's seam balance, the `Gain`
    /// `stage_light` takes, bare in the block.
    float gain;
    float rotation;
};

[vk::binding(0, 0)] Texture2D<uint4> luma;
[vk::binding(1, 0)] Texture2D<uint4> chroma_u;
[vk::binding(2, 0)] Texture2D<uint4> chroma_v;
[vk::binding(3, 0)] ConstantBuffer<Colour> colour;

/// Alpha per canvas pixel, and read by `planar_masked` alone: the merge page draws one layer per
/// picked source over the base, and this is which pixels each of them owns. Rasterised at the
/// canvas's own size rather than the region's, unlike the planes.
[vk::binding(4, 0)] Texture2D<float> mask;

[shader("vertex")]
Drawn vertex(uint at: SV_VertexID)
{
    return drawn_at(at);
}

/// An HDR render carries highlights above diffuse white, and a display with two stops of headroom
/// clips whatever is past them into a flat sheet. So they are rolled into the headroom there is, on
/// an exponential that starts at white and never reaches the ceiling.
///
/// **Not `prelude::rolled`, and the difference is the question each answers.** That one takes a
/// scene's peak to a mastering peak, both known in nits, and is what the grade applies once. This
/// one takes an already-graded frame to whatever headroom *this display* reports, which is a
/// property of the window rather than of the picture and changes when it is dragged between
/// screens.
///
/// Below white nothing happens at all: that is most of the picture, it is already where it should
/// be, and it is what leaves an SDR photograph untouched by this path.
float3 rolled_to_headroom(float3 light, float headroom)
{
    let brightest = max(max(light.r, light.g), light.b);
    if (brightest <= 1.0) { return light; }
    // No room above white at all - an SDR screen - still scales rather than returning: left alone,
    // everything past one is clipped by the compositor a channel at a time, and a blown highlight
    // comes back mauve.
    let above = max(headroom - 1.0, 0.0);
    var fitted = 1.0;
    if (above > 0.0) {
        fitted = 1.0 + above * (1.0 - exp(-(brightest - 1.0) / above));
    }
    return light * (fitted / brightest);
}

/// One of a rendition's PQ codes back to the nits it was written with.
///
/// `DisplayNits`: these are what `frame.slang`'s `coded_at` wrote, and ST 2084 being absolute is
/// exactly why `pq_inv` makes its caller say which stage's nits it wants back.
float nits_of(float code)
{
    return pq_inv<DisplayNits>(measured<Pq>(code)).v;
}

/// What the stage shows at one canvas pixel, ready to write: the planes read, BT.2020 video range
/// undone, PQ taken back to nits, rolled into this display's headroom and rotated onto the canvas's
/// primaries. Shared so that a masked draw is the same picture with an alpha, rather than a second
/// copy of the arithmetic this file exists to hold once.
float3 stage_light(float2 position, Gain gain)
{
    // Into the planes' own pixels, which are the region's: a canvas capped below the region it
    // covers would otherwise read the region's top-left corner and stretch it over the whole tile,
    // and the tile sits over a fitted frame that is drawn correctly - so it shows as a rectangle of
    // the photograph jumping sideways as the reader crosses the zoom threshold.
    uint wide, tall;
    luma.GetDimensions(wide, tall);
    // Clamped: a merge layer's shift reads past the plane's far edge as much as its near one.
    let displayed = position * colour.sample;
    float2 stored = displayed;
    if (colour.rotation == 90.0) {
        stored = float2(displayed.y, float(tall) - displayed.x);
    } else if (colour.rotation == 180.0) {
        stored = float2(float(wide) - displayed.x, float(tall) - displayed.y);
    } else if (colour.rotation == 270.0) {
        stored = float2(float(wide) - displayed.y, displayed.x);
    }
    let at = min(uint2(stored), uint2(wide - 1, tall - 1));
    let chroma_at = uint2(float2(at) * colour.chroma);
    let y = float(luma.Load(int3(int2(at), 0)).r) / colour.depth;
    let u = float(chroma_u.Load(int3(int2(chroma_at), 0)).r) / colour.depth;
    let v = float(chroma_v.Load(int3(int2(chroma_at), 0)).r) / colour.depth;

    let level = (y - LUMA_FLOOR) / LUMA_SPAN;
    let blue = (u - CHROMA_MID) / CHROMA_SPAN;
    let red = (v - CHROMA_MID) / CHROMA_SPAN;
    let signal = clamp(mul(YUV_TO_RGB, float3(level, blue, red)), float3(0.0), float3(1.0));

    // Linear light at last, in the primaries it was authored in, against the white the renderer
    // wrote it against. `pq_inv` answers in nits, which is what `colour.reference` is stated in.
    let light = float3(nits_of(signal.r), nits_of(signal.g), nits_of(signal.b)) / colour.reference * gain.g;

    // Rolled where the renderer rolls, which is in the primaries the file was written in and
    // before they are rotated (`frame.slang`'s `display_nits`, then `R2020_TO_P3`). The two do not
    // commute: the curve keys on the largest channel, and the rotation makes a saturated red's
    // largest channel a third larger than it was - so rolling afterwards takes such a highlight
    // into the knee earlier and darkens it against a white one of the same brightness.
    let rolled = rolled_to_headroom(light, colour.headroom);
    return srgb_oetf_signed(mul(R2020_TO_P3, rolled));
}

[shader("fragment")]
float4 planar(Drawn drawn) : SV_Target
{
    return float4(stage_light(drawn.position.xy, gain(1.0)), 1.0);
}

[shader("fragment")]
float4 planar_masked(Drawn drawn) : SV_Target
{
    // The mask is the canvas's own size, unlike the planes, so it is loaded at the fragment's
    // position rather than at `colour.sample`'s.
    let alpha = mask.Load(int3(int2(drawn.position.xy), 0)).r;
    // Premultiplied: the pipeline blends `one, one-minus-src-alpha`, so an unmasked pixel has to
    // contribute nothing rather than a black fringe at full coverage's edge.
    // Floored at the origin: a negative position wraps as it becomes a texel index.
    return float4(stage_light(max(drawn.position.xy + colour.shift, float2(0.0)), gain(colour.gain)) * alpha, alpha);
}
