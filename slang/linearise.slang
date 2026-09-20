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
// **The transfer is a table for `condition.slang`'s reason**, and more so here: a code value has at
// most 65536 distinct answers, `pow` is not free, and a shader spelling ST 2084 itself would
// disagree with `transfer.rs` in the last bit over the frame every rendition is built from.
//
// **Indexed by destination word rather than by pixel**, exactly as `assemble.slang` is and for the
// same reason: three samples a pixel and two samples a word means adjacent pixels share a word, so
// owning the pixel would have two invocations read-modify-writing each other. Owning the word makes
// that unexpressible. Unlike `assemble` there is no tiling here, so the whole output belongs to one
// dispatch and a word is written rather than merged.
import lanes;
import prelude;
import light;
import packed;
import orientation;

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
    /// Reference white's level, which is 65535 for a picture with no highlights above it and
    /// `65535 / HDR_HEADROOM` for one that has (`transfer::Coding::white_level`).
    float white_level;
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
};

/// `linearise::Picture::gain_mode`'s numbering.
static const uint GAIN_ISO = 0;
static const uint GAIN_APPLE = 1;

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<uint> codes;
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
    let base = (min(y, params.src_height - 1) * params.src_width + min(x, params.src_width - 1)) * 3;
    return float3(
        table[sample_at(codes, base)],
        table[sample_at(codes, base + 1)],
        table[sample_at(codes, base + 2)]);
}

/// The gain map at a point of the source, bilinear, as its three normalised recovery values.
///
/// Bilinear rather than nearest because the map is stored at a fraction of the picture's
/// resolution - half is usual, a quarter is legal - and a nearest read of one puts a staircase
/// along every highlight edge it brightens.
float3 recovery_at(uint x, uint y)
{
    // The pixel's centre in the map's grid, which is the sampling both sides of a gain map agree
    // on: the two rasters cover the same picture, so the centres line up rather than the corners.
    //
    // **Clamped before the floor, not after.** Outside the first and last texel centres there is
    // no pair to interpolate between, and clamping only the *index* while taking the weight from
    // the unclamped position leaves the edge reading three quarters of its neighbour: at `x = 0`
    // of a half-resolution map `u` is -0.25, so `x0` snaps to 0 while `fx` stays 0.75. Where the
    // map steps at a highlight that reaches the picture's edge, that is a bright line down it.
    let u = clamp((float(x) + 0.5) * float(params.gain_width) / float(params.src_width) - 0.5,
                  0.0, float(params.gain_width - 1));
    let v = clamp((float(y) + 0.5) * float(params.gain_height) / float(params.src_height) - 0.5,
                  0.0, float(params.gain_height - 1));
    let x0 = uint(floor(u));
    let y0 = uint(floor(v));
    let x1 = min(x0 + 1, params.gain_width - 1);
    let y1 = min(y0 + 1, params.gain_height - 1);
    let fx = u - floor(u);
    let fy = v - floor(v);

    float3 corner[4];
    let at = uint4(y0 * params.gain_width + x0, y0 * params.gain_width + x1,
                   y1 * params.gain_width + x0, y1 * params.gain_width + x1);
    for (uint k = 0; k < 4; k = k + 1) {
        let base = at[k] * 3;
        corner[k] = float3(
            sample_at(gain_map, base),
            sample_at(gain_map, base + 1),
            sample_at(gain_map, base + 2));
    }
    let top = lerp(corner[0], corner[1], fx);
    let bottom = lerp(corner[2], corner[3], fx);
    return lerp(top, bottom, fy) / params.gain_last;
}

/// ISO 21496-1's reconstruction, at full strength: the alternate rendition rather than a display's
/// share of it.
///
/// **The whole gain, always.** The standard's weight exists to meet a *display's* headroom, and
/// nothing here is a display - the frame this produces is scene-linear and the roll-off that meets
/// a panel is `frame.slang`'s, six stages further down. Applying a display weight here would bake
/// one tone map in and then run another over it.
float3 gain_mapped(float3 base, uint x, uint y)
{
    let recovery = recovery_at(x, y);
    // **A straight line to the headroom, not a power of it.** Apple's reconstruction is linear in
    // the recovery where ISO's is exponential, so the two disagree everywhere but the ends: at half
    // recovery under a headroom of 8, ISO gives 2.83x and this gives 4.5x. Monochrome by
    // construction, so one channel of the replicated map decides all three.
    if (params.gain_mode == GAIN_APPLE) {
        return base * (1.0 + (params.gain_headroom - 1.0) * recovery.r);
    }
    let power = float3(
        pow(recovery.r, 1.0 / max(params.gain_gamma.r, 1e-6)),
        pow(recovery.g, 1.0 / max(params.gain_gamma.g, 1e-6)),
        pow(recovery.b, 1.0 / max(params.gain_gamma.b, 1e-6)));
    let log_gain = lerp(params.gain_min.rgb, params.gain_max.rgb, power);
    return (base + params.offset_base.rgb) * exp2(log_gain) - params.offset_alternate.rgb;
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
            if (params.gain_width > 0) { pixel = gain_mapped(pixel, x + dx, y + dy); }
            light = light + pixel;
        }
    }
    return light / float(params.step * params.step);
}

/// One destination sample: its output pixel's light, through the primaries and onto the scale.
///
/// **All three rows, then the triple brought inside the container as a whole**, which is
/// `assemble.slang`'s `coloured` exactly and for the reason `prelude.slang` records: a channel
/// clamped where it happened to cross leaves the two that had not crossed keeping their heads
/// above it, and the highlight turns a different colour. That is not an edge case here - an HDR
/// picture's scale puts the ceiling at `HDR_HEADROOM` times diffuse white, which a gain-mapped
/// specular or a master above 1624 nits reaches routinely, and `in_gamut` is what a source whose
/// primaries reach outside Rec.2020 needs at the other end.
///
/// The cost is two dot products a sample, which is what the RAW path already pays.
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
    // Counts, because that is what this writes: `white_level` is diffuse white's own count and the
    // container's ceiling is full scale. `Level` is not `IStandard` for that reason, so both come
    // in `measured`.
    let rec2020 = measured<Level>(float3(
        dot(params.row0.xyz, light),
        dot(params.row1.xyz, light),
        dot(params.row2.xyz, light)) * params.white_level);
    let held = within(in_gamut(rec2020), measured<Level>(65535.0)).v;
    float value = held.r;
    if (channel == 1) { value = held.g; }
    if (channel == 2) { value = held.b; }
    return uint(clamp(value, 0.0, 65535.0));
}

[shader("compute")]
[numthreads(64, 1, 1)]
void linearise(uint3 id : SV_DispatchThreadID)
{
    let word = linear(id);
    let samples = params.out_width * params.out_height * 3;
    if (word * 2 >= samples) { return; }

    let low = sample_of(word * 2);
    uint high = 0;
    if (word * 2 + 1 < samples) { high = sample_of(word * 2 + 1); }
    out_frame[word] = low | (high << 16);
}
