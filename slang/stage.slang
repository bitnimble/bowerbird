// The viewer's stage: a decoded frame painted onto an extended-range canvas.
//
// A browser draws it over planes `VideoFrame.copyTo` handed back; an Android TV, whose WebView
// shows no HDR, draws it natively into a window behind the page (`gpu/surface_stage.rs`). What it
// shares with the rest of `slang/` is the arithmetic: the transfer, the roll-off, BT.2020's weights
// and a gain map's reconstruction, each written once.
//
// The one thing it cannot say is WebGPU's `texture_external`, which Slang has no type for. That
// path is a copy - the import already converted into the canvas's primaries and left the value on
// the canvas's curve - so it stays as hand-written WGSL beside this, carrying no arithmetic.

import prelude;
import stage_shared;
import light;
import primaries;
import gamut_map;
import video_range;
import gain_map;
import times;

struct Colour {
    float headroom;
    float reference;
    /// Region pixels per canvas pixel. The planes hold the region, and the canvas is capped by
    /// DETAIL_PIXELS, so the two are the same size only when nothing capped it.
    float2 sample;
    /// What to divide a loaded sample by to put it on the ten-bit scale `video_range` is written
    /// against: 1 for a ten-bit frame, 4 for a twelve-bit one. f32 keeps the extra bits as
    /// fraction rather than throwing them away, which is the point of writing twelve in the first
    /// place.
    float depth;
    /// Chroma pixels per luma pixel: a half for 4:2:0, one for the 4:4:4 a still with a measured
    /// chroma leak is written as (`job::CHROMA_LEAK_TILE_FRACTION`).
    float chroma;
    /// Where a canvas pixel reads, relative to it, in canvas pixels: a merge piece taken from where
    /// its content went in its frame, or a native window's picture drawn inside its letterbox.
    float2 shift;
    /// What `planar_masked`'s light is multiplied by: a merge piece's seam balance, the `Gain`
    /// `stage_light` takes, bare in the block.
    float gain;
    float rotation;
    /// Zero draws the frame as it is. Otherwise an sRGB proof of it, brought inside the file's gamut
    /// by the intent numbered one less (`gamut_map.slang`).
    float proof;
    /// The rendition's own peak over diffuse white, its `clli`, which is what the roll-off and a
    /// proof both fit down from.
    float source_peak;
};

/// Zero for a browser's canvas: display-p3, sRGB-encoded, extended. Otherwise linear scRGB (BT.709)
/// with SDR white at this value, for a native window whose compositor puts its white wherever the
/// display does: 1 where Android states its HDR/SDR ratio, the reader's setting elsewhere.
[vk::constant_id(0)]
const float SCRGB_WHITE = 0.0;

/// Linear BT.2020 light, against SDR white at one, as the canvas this stage draws on takes it.
float3 written(float3 light)
{
    if (SCRGB_WHITE > 0.0) {
        return mul(R2020_TO_SRGB, light) * SCRGB_WHITE;
    }
    return srgb_oetf_signed(mul(R2020_TO_P3, light));
}

[vk::binding(0, 0)] Texture2D<uint4> luma;
[vk::binding(1, 0)] Texture2D<uint4> chroma_u;
[vk::binding(2, 0)] Texture2D<uint4> chroma_v;
[vk::binding(3, 0)] ConstantBuffer<Colour> colour;

/// Alpha per canvas pixel, and read by `planar_masked` alone: the merge page draws one layer per
/// picked source over the base, and this is which pixels each of them owns. Rasterised at the
/// canvas's own size rather than the region's, unlike the planes.
[vk::binding(4, 0)] Texture2D<float> mask;

/// How a finished picture's planes become light (`heif_view.rs`), read by `finished` alone.
struct Finish {
    /// The base's linear RGB to Rec.2020, a row per vector.
    float4 row0;
    float4 row1;
    float4 row2;
    /// The base's `kr`, `kb`, full range as 0 or 1, and largest code.
    float4 signal;
    /// The uploaded region's origin in stored pixels, then the whole stored picture's size.
    float4 placed;
    /// The base's planes, then the map's: 0 for three, 1 for NV12's two with chroma interleaved in
    /// `chroma_u`, 2 for one of packed RGB codes, which a hardware decoder hands back.
    float4 arrangement;
    /// The map's `kr`, `kb`, full range and largest code.
    float4 gain_signal;
    /// The map's width and height, `GAIN_ISO` or `GAIN_APPLE` or -1 for no map, and Apple's headroom.
    float4 gain_shape;
    float4 gain_min;
    float4 gain_max;
    float4 gain_gamma;
    float4 offset_base;
    float4 offset_alternate;
};

[vk::binding(5, 0)] ConstantBuffer<Finish> finish;
/// `code * 3 + channel`, light with diffuse white at 1.0: `linearise.slang`'s table.
[vk::binding(6, 0)] StructuredBuffer<float> table;
[vk::binding(7, 0)] Texture2D<uint4> gain_luma;
[vk::binding(8, 0)] Texture2D<uint4> gain_u;
[vk::binding(9, 0)] Texture2D<uint4> gain_v;

[shader("vertex")]
Drawn vertex(uint at: SV_VertexID)
{
    return drawn_at(at);
}

/// A scene-referred render fitted to this display: the file's brightest pixel (its `clli`) rolled
/// onto the display's peak by the grade's own BT.2390, which is the curve the editor draws with.
/// A file that fits the display is left alone.
///
/// No room above white at all - an SDR screen - still rolls rather than returning: left alone,
/// everything past one is clipped by the compositor a channel at a time, and a blown highlight
/// comes back mauve.
float3 rolled_to_headroom(float3 light)
{
    let white = measured<DisplayNits>(colour.reference);
    let peak = measured<DisplayNits>(colour.headroom * white.v);
    let knee = rolloff(measured<DisplayNits>(colour.source_peak * white.v), peak, white);
    return within(rolled(measured<DisplayNits>(light * white.v), knee), peak).v / white.v;
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
    let at = stored_at(position);
    let chroma_at = uint2(float2(at) * colour.chroma);
    let signal = pq_of_video(float3(
        float(luma.Load(int3(int2(at), 0)).r),
        float(chroma_u.Load(int3(int2(chroma_at), 0)).r),
        float(chroma_v.Load(int3(int2(chroma_at), 0)).r)) / colour.depth).v;

    // Linear light at last, in the primaries it was authored in, against the white the renderer
    // wrote it against. `pq_inv` answers in nits, which is what `colour.reference` is stated in.
    return shown(float3(nits_of(signal.r), nits_of(signal.g), nits_of(signal.b)) / colour.reference * gain.g);
}

/// The planes' pixel under a canvas pixel.
uint2 stored_at(float2 position)
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
    return min(uint2(stored), uint2(wide - 1, tall - 1));
}

/// Rec.2020 light against diffuse white, as the canvas shows it.
float3 shown(float3 light)
{
    if (colour.proof > 0.0) {
        let white = measured<DisplayNits>(colour.reference);
        let intent = uint(colour.proof) - 1;
        let share = toned(measured<DisplayNits>(light * white.v), measured<DisplayNits>(colour.source_peak * white.v),
            white, intent);
        // Mapped as `frame.slang`'s `proofed` maps the editor's.
        return written(mul(SRGB_TO_R2020, saturate(mul(R2020_TO_SRGB, mapped(share, SrgbCube(), intent)))));
    }

    // Rolled where the renderer rolls, which is in the primaries the file was written in and
    // before they are rotated (`frame.slang`'s `display_nits`, then `R2020_TO_P3`). The two do not
    // commute: the curve keys on the largest channel, and the rotation makes a saturated red's
    // largest channel a third larger than it was - so rolling afterwards takes such a highlight
    // into the knee earlier and darkens it against a white one of the same brightness.
    return written(rolled_to_headroom(light));
}

/// A finished picture's Rec.2020 light at one of its planes' pixels: its own transfer and primaries
/// undone and its gain map applied, as `linearise.slang` does for a decode.
float3 finished_light(uint2 at)
{
    let codes = codes_at(luma, chroma_u, chroma_v, finish.arrangement.x, at, finish.signal);
    var light = float3(table[times(codes.r, 3)], table[times(codes.g, 3) + 1], table[times(codes.b, 3) + 2]);
    if (finish.gain_shape.z >= 0.0) {
        GainTerms terms;
        terms.mode = uint(finish.gain_shape.z);
        terms.headroom = finish.gain_shape.w;
        terms.lowest = finish.gain_min.rgb;
        terms.highest = finish.gain_max.rgb;
        terms.gamma = finish.gain_gamma.rgb;
        terms.offset_base = finish.offset_base.rgb;
        terms.offset_alternate = finish.offset_alternate.rgb;
        light = gain_mapped(light, recovery_at(at + uint2(finish.placed.xy)), terms);
    }
    return float3(dot(finish.row0.xyz, light), dot(finish.row1.xyz, light), dot(finish.row2.xyz, light));
}

/// The gain map's normalised recovery at a pixel of the whole stored picture.
float3 recovery_at(uint2 at)
{
    let map = uint2(finish.gain_shape.xy);
    GainTaps taps;
    gain_taps(at, uint2(finish.placed.zw), map, taps);
    float3 corner[4];
    for (uint k = 0; k < 4; k = k + 1) {
        let texel = uint2(taps.at[k] % map.x, taps.at[k] / map.x);
        corner[k] = float3(codes_at(gain_luma, gain_u, gain_v, finish.arrangement.y, texel, finish.gain_signal));
    }
    return blended(taps, corner) / finish.gain_signal.w;
}

/// One pixel's R'G'B' codes at the coded depth `signal` names, however its planes are arranged.
uint3 codes_at(Texture2D<uint4> y_plane, Texture2D<uint4> u_plane, Texture2D<uint4> v_plane,
               float arrangement, uint2 at, float4 signal)
{
    if (arrangement > 1.5) {
        // Eight bits whatever the stream's depth: a ten-bit HEIC's codes are spread back over its table.
        return uint3(float3(y_plane.Load(int3(int2(at), 0)).rgb) * signal.w / 255.0 + 0.5);
    }
    return codes_of(ycbcr_at(y_plane, u_plane, v_plane, arrangement > 0.5, at), signal);
}

/// One pixel's luma and its chroma, bilinear against HEVC's default siting: a luma column falls on a
/// chroma sample and a 4:2:0 luma row between two. Across the assembled picture, where
/// `hevc::chroma` clamps at each grid tile's edge, so the two differ by a quarter of a chroma step
/// at a tile seam.
float3 ycbcr_at(Texture2D<uint4> y_plane, Texture2D<uint4> u_plane, Texture2D<uint4> v_plane,
                bool interleaved, uint2 at)
{
    uint luma_wide, luma_tall, wide, tall;
    y_plane.GetDimensions(luma_wide, luma_tall);
    u_plane.GetDimensions(wide, tall);
    let halved = uint2(wide, tall) < uint2(luma_wide, luma_tall);
    let x = clamp(select(halved.x, float(at.x) / 2.0, float(at.x)), 0.0, float(wide - 1));
    let y = clamp(select(halved.y, (float(at.y) - 0.5) / 2.0, float(at.y)), 0.0, float(tall - 1));
    let x0 = uint(floor(x));
    let y0 = uint(floor(y));
    let x1 = min(x0 + 1, wide - 1);
    let y1 = min(y0 + 1, tall - 1);
    let top = lerp(chroma_pair(u_plane, v_plane, interleaved, uint2(x0, y0)),
                   chroma_pair(u_plane, v_plane, interleaved, uint2(x1, y0)), x - floor(x));
    let bottom = lerp(chroma_pair(u_plane, v_plane, interleaved, uint2(x0, y1)),
                      chroma_pair(u_plane, v_plane, interleaved, uint2(x1, y1)), x - floor(x));
    let chroma = lerp(top, bottom, y - floor(y));
    return float3(float(y_plane.Load(int3(int2(at), 0)).r), chroma);
}

float2 chroma_pair(Texture2D<uint4> u_plane, Texture2D<uint4> v_plane, bool interleaved, uint2 at)
{
    let u = u_plane.Load(int3(int2(at), 0));
    if (interleaved) { return float2(float(u.r), float(u.g)); }
    return float2(float(u.r), float(v_plane.Load(int3(int2(at), 0)).r));
}

/// A YCbCr sample's R'G'B' codes under `signal` (`Finish.signal`), rounded as `hevc::to_rgb`
/// rounds them, since the table is indexed by code.
uint3 codes_of(float3 ycbcr, float4 signal)
{
    let kr = signal.x;
    let kb = signal.y;
    let last = signal.w;
    let kg = 1.0 - kr - kb;
    // `video_range`'s are ten-bit.
    let scale = (last + 1.0) / 1024.0;
    float luma_floor = LUMA_FLOOR * scale;
    float luma_span = LUMA_SPAN * scale;
    float chroma_mid = CHROMA_MID * scale;
    float chroma_span = CHROMA_SPAN * scale;
    if (signal.z > 0.5) {
        luma_floor = 0.0;
        luma_span = last;
        chroma_mid = (last + 1.0) / 2.0;
        chroma_span = last;
    }
    let y = (ycbcr.x - luma_floor) / luma_span;
    let u = (ycbcr.y - chroma_mid) / chroma_span;
    let v = (ycbcr.z - chroma_mid) / chroma_span;
    let rgb = float3(
        y + 2.0 * (1.0 - kr) * v,
        y - (2.0 * (1.0 - kr) * kr / kg) * v - (2.0 * (1.0 - kb) * kb / kg) * u,
        y + 2.0 * (1.0 - kb) * u);
    return uint3(saturate(rgb) * last + 0.5);
}

[shader("fragment")]
float4 finished(Drawn drawn) : SV_Target
{
    return float4(shown(finished_light(stored_at(drawn.position.xy))), 1.0);
}

/// Floored at the origin: a negative position wraps as it becomes a texel index.
float2 shifted(Drawn drawn)
{
    return max(drawn.position.xy + colour.shift, float2(0.0));
}

[shader("fragment")]
float4 planar(Drawn drawn) : SV_Target
{
    return float4(stage_light(shifted(drawn), gain(1.0)), 1.0);
}

[shader("fragment")]
float4 planar_masked(Drawn drawn) : SV_Target
{
    // The mask is the canvas's own size, unlike the planes, so it is loaded at the fragment's
    // position rather than at `colour.sample`'s.
    let alpha = mask.Load(int3(int2(drawn.position.xy), 0)).r;
    // Premultiplied: the pipeline blends `one, one-minus-src-alpha`, so an unmasked pixel has to
    // contribute nothing rather than a black fringe at full coverage's edge.
    return float4(stage_light(shifted(drawn), gain(colour.gain)) * alpha, alpha);
}
