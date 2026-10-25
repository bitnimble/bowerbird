// A finished picture's code values into the scene-linear Rec.2020 frame every stage after a decode
// reads: the transfer undone, the gain map applied, the primaries converted, cropped, halved and
// turned upright, in one pass.
//
// **This is `condition.slang` and `assemble.slang` for a photograph that has no mosaic.** A JPEG, a
// PNG, a HEIC or an AVIF arrives already rendered, so there is no black level to subtract, no
// denoise fitted to a photosite and nothing to demosaic - what there is instead is somebody else's
// transfer and somebody else's primaries, and undoing those is the whole of the decode. Everything
// below is the same code the RAWs run.
//
// A linear DNG is the one picture here from a camera rather than a renderer: demosaiced before it
// was written, so it has no mosaic either, but its codes are sensor counts. Its table is the
// conditioning instead of a transfer - each channel's own black, saturation and white balance - and
// its matrix is the camera's. One stored as floating point has no codes to tabulate, so its
// conditioning is a scale and an offset a channel, and it keeps what it holds above white.
//
// **The transfer is a table for `condition.slang`'s reason**, and more so here: a code value has at
// most 65536 distinct answers, `pow` is not free, and a shader spelling ST 2084 itself would
// disagree with `transfer.rs` in the last bit over the frame every rendition is built from.
//
// **Indexed by destination word rather than by pixel**, exactly as `assemble.slang` is and for the
// same reason: three samples a pixel and two samples a word means adjacent pixels share a word, so
// owning the pixel would have two invocations read-modify-writing each other. Owning the word makes
// that unexpressible. A band of a picture too large to bind whole owns a run of whole rows' words,
// so a word still belongs to one dispatch and is written rather than merged.
import lanes;
import prelude;
import light;
import packed;
import orientation;
import px;
import times;
import gain_map;

struct Params {
    /// The decoded picture, in the orientation its bytes are in.
    uint src_width;
    uint src_height;
    /// The rectangle of it this pass reads, in source pixels.
    uint left;
    uint top;
    /// Source pixels per output pixel: 1, or 2 for a caller that asked for half.
    uint step;
    /// The rectangle as it comes out, before the turn. `out_width`/`out_height` swap with it.
    uint frame_width;
    uint frame_height;
    /// `rawler`'s `Orientation`, numbered as `orientation.slang` numbers it. 0 leaves the frame alone.
    uint orientation;
    uint out_width;
    uint out_height;
    /// The gain map's own size, and 0 where the file carried none. Always three channels: a
    /// single-channel map is replicated on the host, which costs a half-resolution plane and
    /// removes a branch from every pixel here.
    uint gain_width;
    uint gain_height;
    /// Nonzero where `codes` holds an `f32` a sample rather than two `u16` codes a word.
    uint float_samples;
    /// The gain map's own full-scale code, which is its coded depth rather than the picture's.
    float gain_last;
    /// `GAIN_ISO` or `GAIN_APPLE`, which are different curves and not different constants.
    uint gain_mode;
    /// `GAIN_APPLE`'s only term, and 1.0 under `GAIN_ISO`, which leaves that arm the identity.
    float gain_headroom;
    /// ISO 21496-1's per-channel gain map terms, `w` unused.
    float4 gain_min;
    float4 gain_max;
    float4 gain_gamma;
    float4 offset_base;
    float4 offset_alternate;
    /// The source's linear RGB to Rec.2020's, a row per vector. Three `float4` rather than a
    /// `float3x3` because the host writes these bytes by hand.
    float4 row0;
    float4 row1;
    float4 row2;
    /// A floating-point sample's light is `sample * sample_scale + sample_offset`, `w` unused.
    float4 sample_scale;
    float4 sample_offset;
    /// The rectangle of the raster `codes` holds, which is all of it for a picture held on the
    /// device and the rows one band reads for one held on the host.
    uint strip_left;
    uint strip_top;
    uint strip_width;
    /// The destination words this dispatch writes, so a band's neighbours are left alone.
    uint first_word;
    uint end_word;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<uint> codes;
/// Indexed `code * 3 + channel`.
[vk::binding(2, 0)] StructuredBuffer<float> table;
[vk::binding(3, 0)] StructuredBuffer<uint> gain_map;
[vk::binding(4, 0)] RWStructuredBuffer<uint> out_frame;

/// One `u16` out of a buffer packed two to a word.
uint sample_at(StructuredBuffer<uint> from, uint at)
{
    return half_of(from[at >> 1], at);
}

/// One source pixel as light, relative to diffuse white, in the source's own primaries.
float3 light_at(uint x, uint y)
{
    let row = min(y, params.src_height - 1) - params.strip_top;
    let column = min(x, params.src_width - 1) - params.strip_left;
    let base = wide_at<Drawn>(column, row, measured<Drawn>(params.strip_width)) * 3;
    if (params.float_samples != 0) {
        let stored = float3(asfloat(codes[base]), asfloat(codes[base + 1]), asfloat(codes[base + 2]));
        // A NaN would reach the final `uint()` as one, which WGSL leaves undefined.
        let sample = select(isfinite(stored), stored, float3(0.0));
        return sample * params.sample_scale.xyz + params.sample_offset.xyz;
    }
    return float3(
        table[times(sample_at(codes, base), 3)],
        table[times(sample_at(codes, base + 1), 3) + 1],
        table[times(sample_at(codes, base + 2), 3) + 2]);
}

/// The gain map at a point of the source as its three normalised recovery values.
float3 recovery_at(uint x, uint y)
{
    GainTaps taps;
    gain_taps(uint2(x, y), uint2(params.src_width, params.src_height),
              uint2(params.gain_width, params.gain_height), taps);
    float3 corner[4];
    for (uint k = 0; k < 4; k = k + 1) {
        let base = wide<Drawn>(taps.at[k]) * 3;
        corner[k] = float3(
            sample_at(gain_map, base),
            sample_at(gain_map, base + 1),
            sample_at(gain_map, base + 2));
    }
    return blended(taps, corner) / params.gain_last;
}

/// The frame this produces is scene-linear: the roll-off that meets a panel is `frame.slang`'s,
/// six stages further down.
float3 gain_mapped_at(float3 base, uint x, uint y)
{
    GainTerms terms;
    terms.mode = params.gain_mode;
    terms.headroom = params.gain_headroom;
    terms.lowest = params.gain_min.rgb;
    terms.highest = params.gain_max.rgb;
    terms.gamma = params.gain_gamma.rgb;
    terms.offset_base = params.offset_base.rgb;
    terms.offset_alternate = params.offset_alternate.rgb;
    return gain_mapped(base, recovery_at(x, y), terms);
}

/// The light one output pixel stands for, in the source's primaries.
///
/// Halving is a box average of the 2x2 the output pixel covers, taken in light. Not the same thing
/// the RAWs' halving is - there every colour of a site was measured, and here two pixels are being
/// merged - but it is the same trade at the same place, and averaging before the transfer is undone
/// would average code values and darken every edge.
float3 light_of(uint2 at)
{
    let x = params.left + at.x * params.step;
    let y = params.top + at.y * params.step;
    float3 light = float3(0.0);
    for (uint dy = 0; dy < params.step; dy = dy + 1) {
        for (uint dx = 0; dx < params.step; dx = dx + 1) {
            float3 pixel = light_at(x + dx, y + dy);
            if (params.gain_width > 0) { pixel = gain_mapped_at(pixel, x + dx, y + dy); }
            light = light + pixel;
        }
    }
    return light / float(params.step * params.step);
}

/// One destination sample: its output pixel's light, through the primaries and onto the scale.
///
/// All three rows, then the triple brought inside Rec.2020 as a whole (`in_gamut`), for a source
/// whose primaries reach outside it.
uint sample_of(uint sample)
{
    let pixel = sample / 3;
    let channel = sample % 3;
    let oy = pixel / params.out_width;
    if (oy >= params.out_height) { return 0; }
    let at = unoriented(
        uint2(pixel % params.out_width, oy),
        uint2(params.frame_width, params.frame_height),
        params.orientation);

    let light = light_of(at);
    let rec2020 = measured<Level>(float3(
        dot(params.row0.xyz, light),
        dot(params.row1.xyz, light),
        dot(params.row2.xyz, light)) * FULL_SCALE);
    let held = in_gamut(rec2020).v;
    float value = held.r;
    if (channel == 1) { value = held.g; }
    if (channel == 2) { value = held.b; }
    return bits_of(max(value, 0.0));
}

[shader("compute")]
[numthreads(64, 1, 1)]
void linearise(uint3 id : SV_DispatchThreadID)
{
    let word = params.first_word + linear(id);
    let samples = wide<Drawn>(params.out_width * params.out_height) * 3;
    if (word >= params.end_word || word * 2 >= samples) { return; }

    let low = sample_of(word * 2);
    uint high = 0;
    if (word * 2 + 1 < samples) { high = sample_of(word * 2 + 1); }
    out_frame[word] = low | (high << 16);
}
