// One source of a composite, read into a window of the canvas: the projection backwards to a ray,
// the ray backwards through the source's rotation to a pinhole coordinate, and - for a RAW - the
// lens's ratio table backwards to the sensor's own pixel.
//
// **One resample, not three.** A composite that undistorted each source, rotated it and then
// projected it would filter the picture three times over; here the whole chain is arithmetic on a
// coordinate and only the last step reads pixels, through the same Catmull-Rom stencil `warp.slang`
// gathers a lens correction with (`lens_gather`).
//
// The recipe is stated in the camera's own corrected geometry, so `THROUGH_CORRECTED` - a JPEG, a
// PNG, anything already finished - stops at the pinhole coordinate, and `THROUGH_LENS` carries on
// through the ratio table as `warp.slang` does.
import lanes;
import packed;
import lens_gather;

struct Params {
    /// The window written, in output pixels.
    uint2 out_size;
    /// The decoded region the taps read.
    uint2 region;
    /// Where the window starts, relative to the canvas's own centre, in canvas pixels. Relative
    /// rather than absolute: a 40000px canvas and an `f32` would lose the fraction that matters.
    float2 window;
    /// The source photograph's centre in the decoded frame's pixels, half a pixel back, as
    /// `warp.slang`'s `Params::centre` is.
    float2 source_centre;
    /// Where the decoded region starts in that frame.
    float2 region_origin;
    float2 edge;
    /// The source's rotation, camera to world, as `[w, x, y, z]`.
    float4 rotation;
    /// Canvas pixels per output pixel.
    float scale;
    float radians_per_pixel;
    /// The pinhole focal, in the source's full-resolution pixels.
    float focal;
    /// Decoded pixels per full-resolution pixel, which the ratio multiplies into.
    float shrink;
    /// `1 / half^2` of the full-resolution grid the lens is defined over.
    float inv_half2;
    uint projection;
    uint through;
    /// Non-zero where `mask` holds this source's weight, which is §5.2's assembly; zero for a
    /// panorama, whose weight is the feather below.
    uint masked;
    /// How many floats `mask` strides by, and which of them is this source's.
    uint mask_stride;
    uint mask_slot;
    /// Half the source's full-resolution corrected frame, which the feather measures against.
    float2 half_size;
    /// §3.7a's canvas warp, `(a, b, c, d)` of `[a b; c d]`, already carried into the centre-relative
    /// frame `canvas` is in (`composite_tile::params`). The identity for every panorama.
    float4 warp_m;
    /// That warp's translation in the same frame, which the identity makes exactly zero.
    float2 warp_t;
};

/// One tile's §3.7a correction. `assembly_weight::TileWarp`.
struct TileWarp {
    float4 m;
    float2 t;
    float gain;
    float pad;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<uint> frame;
[vk::binding(2, 0)] RWStructuredBuffer<uint> out_;
/// Three of `image::channel_ratio_table` end to end, red then green then blue.
[vk::binding(3, 0)] StructuredBuffer<float> ratios;
/// `tone::gain_in_y` per radius bucket, 1.0 where the falloff cannot move a 16-bit code.
[vk::binding(4, 0)] StructuredBuffer<float> lifts;
/// How much of this source to take at each output pixel, and zero where it does not reach.
[vk::binding(5, 0)] RWStructuredBuffer<float> weight;
/// Three floats an output pixel - the green channel's source coordinate and that same flag - which
/// is what the pin holds the host's own projection maths against.
[vk::binding(6, 0)] RWStructuredBuffer<float> probe;
/// §5.2's signed distance to the boundary of the union of tiles this source was picked for, one
/// float an output pixel a source. Read rather than computed: see `assembly_weight.slang`.
[vk::binding(7, 0)] StructuredBuffer<float> mask;
/// Which tile this source is read through at each output pixel, strided like `mask`.
[vk::binding(8, 0)] StructuredBuffer<uint> tile_of;
/// One entry a tile, in the recipe's own order.
[vk::binding(9, 0)] StructuredBuffer<TileWarp> warps;

static const uint RECTILINEAR = 0;
static const uint CYLINDRICAL = 1;
static const uint EQUIRECTANGULAR = 2;

static const uint THROUGH_CORRECTED = 0;
static const uint THROUGH_LENS = 1;

/// How sharply the feather favours the source a pixel sits deepest inside.
///
/// **A soft feather over a panorama's overlap is a ghost, and the overlap is a third of a frame.**
/// Weighting by depth alone mixes two frames half and half across that whole third, so every
/// detail in it is blended with a copy of itself displaced by whatever the alignment did not catch
/// - measured on a five-frame pan, a mountain came out as a soft dark blob with doubled edges.
/// What matters is not the depth but the *ratio* of the two depths, and a high power is what turns
/// a ratio into a decision: at the sixteenth power, one frame being a fifth deeper than the other
/// makes it 99 parts of the mixture, so the blend is a narrow band about the line where the two
/// are equally deep rather than the width of the overlap.
static const float FEATHER_POWER = 16.0;

/// What a pixel is worth where it is valid at all, so the outermost ring of a panorama is still
/// written rather than left black by a weight of exactly zero.
///
/// Far below anything the power above produces for a pixel with any depth at all - `pow(0.06, 16)`
/// - or it would be the answer everywhere and every overlap would be an even mixture again.
static const float FEATHER_FLOOR = 1e-20;

/// What a weight reads where the source's own frame does not cover the output pixel.
///
/// **Not zero, which is a distance and not an absence.** `assembly_blend` reads this buffer as
/// §5.2's signed distance to a seam, where zero means *on* the seam - half weight - so a pixel no
/// source reached would take half of a frame that has nothing there. The two places below that
/// decide a weight both have to write it.
static const float NOT_REACHED = -1e30;

/// `assembly_weight.slang`'s: an output pixel this source has no tile at, which is the canvas
/// outside every tile and takes the source's own warp - the identity, for every assembly.
static const uint NO_TILE = 0xffffffffu;

/// The correction this source is asked for at one output pixel.
///
/// **A lookup inside the pass, not a pass of its own.** Every pixel reads at most two sources and
/// each of those through one tile, so a per-tile warp is a per-pixel index into a table of affines -
/// where a warp per gather would have needed a gather, a decode and a slot of the weight field for
/// every distinct correction a carve asked for. A panorama has no table and takes `params`' own.
TileWarp correction(uint pixel)
{
    TileWarp mine;
    mine.m = params.warp_m;
    mine.t = params.warp_t;
    mine.gain = 1.0;
    mine.pad = 0.0;
    if (params.masked == 0u) { return mine; }
    let tile = tile_of[pixel * params.mask_stride + params.mask_slot];
    if (tile == NO_TILE) { return mine; }
    return warps[tile];
}

/// The ray a canvas coordinate looks along, in world coordinates. `composition::canvas_to_ray`.
float3 canvas_to_ray(float2 canvas)
{
    let u = canvas.x * params.radians_per_pixel;
    let v = canvas.y * params.radians_per_pixel;
    if (params.projection == RECTILINEAR) {
        return float3(u, v, 1.0);
    }
    if (params.projection == CYLINDRICAL) {
        return float3(sin(u), v, cos(u));
    }
    return float3(sin(u) * cos(v), sin(v), cos(u) * cos(v));
}

/// `q* v q`, which is the rotation `q` stands for run backwards.
float3 unrotate(float4 q, float3 v)
{
    let u = float3(-q.y, -q.z, -q.w);
    let uv = cross(u, v);
    let uuv = cross(u, uv);
    return v + 2.0 * (q.x * uv + uuv);
}

uint3 level_of(float3 value)
{
    return uint3(clamp(value, 0.0, 65535.0));
}

/// Where one channel of a pinhole coordinate reads from, in the decoded region's pixels.
///
/// `pinhole` is in the source's full-resolution corrected pixels, offset from its own centre.
float2 source_of(float2 pinhole, uint c)
{
    var ratio = 1.0;
    if (params.through == THROUGH_LENS) {
        ratio = lens_ratio(ratios, dot(pinhole, pinhole) * params.inv_half2, c);
    }
    return float2(
        (params.source_centre.x + pinhole.x * ratio * params.shrink) - params.region_origin.x,
        (params.source_centre.y + pinhole.y * ratio * params.shrink) - params.region_origin.y);
}

/// The pinhole coordinate an output pixel asks this source for, and whether the source is looking
/// that way at all.
bool asked_for(uint pixel, TileWarp warp, out float2 pinhole)
{
    let x = pixel % params.out_size.x;
    let y = pixel / params.out_size.x;
    let canvas = params.window + (float2(float(x), float(y)) + 0.5) * params.scale;
    // §3.7a: which canvas point this source is actually asked for. Before the ray and not after,
    // because what a tile's correction says is *where its content sits on the canvas* - the source
    // is then read through its own unchanged geometry, so the lens table and the projection are the
    // ones the recipe was solved with. `composition::warped_canvas` is the host's statement of it.
    let asked = float2(
        warp.m.x * canvas.x + warp.m.y * canvas.y + warp.t.x,
        warp.m.z * canvas.x + warp.m.w * canvas.y + warp.t.y);
    let d = unrotate(params.rotation, canvas_to_ray(asked));
    pinhole = float2(0.0);
    if (d.z <= 1e-9) { return false; }
    pinhole = float2(params.focal * d.x / d.z, params.focal * d.y / d.z);
    return true;
}

/// How much this source is worth at a pinhole coordinate: how deep inside its own frame the
/// coordinate sits, as a fraction of half the frame, sharpened by `FEATHER_POWER`.
float feather(float2 pinhole)
{
    let inside = (params.half_size - abs(pinhole)) / params.half_size;
    return max(pow(max(min(inside.x, inside.y), 0.0), FEATHER_POWER), FEATHER_FLOOR);
}

/// What this source is worth at an output pixel it does not cover.
float weightless()
{
    return params.masked != 0u ? NOT_REACHED : 0.0;
}

/// One output pixel of this layer, black and weightless where the source does not reach it.
float3 gathered(uint pixel)
{
    let warp = correction(pixel);
    float2 pinhole;
    if (!asked_for(pixel, warp, pinhole)) {
        // Site one of two. A source not looking this way has no weight here whatever the mask says.
        weight[pixel] = weightless();
        return float3(0.0);
    }

    let bucket = min(uint(min(sqrt(dot(pinhole, pinhole) * params.inv_half2) * 255.0, 255.0)), 255);
    // The falloff and §3.7a's exposure are one multiply of the light: both are a gain in linear Y,
    // and `lift_in_pq` is what applies one without leaving the coding.
    let gain = lifts[bucket] * warp.gain;

    var pixel_out = float3(0.0);
    var reached = true;
    for (uint c = 0; c < 3; c++) {
        let source = source_of(pinhole, c);
        // Whole-pixel, not per-channel: a pixel two channels of which are inside the region and one
        // outside would blend a colour that is only two thirds of a picture, and a seam is exactly
        // where that happens.
        if (source.x < 0.0 || source.y < 0.0 || source.x > params.edge.x || source.y > params.edge.y) {
            reached = false;
            continue;
        }
        var value = tap(frame, params.region, source.x, source.y, c);
        if (gain != 1.0) { value = lift_in_pq(value / 65535.0, gain) * 65535.0; }
        pixel_out[c] = value;
    }
    // Site two of two.
    if (!reached) {
        weight[pixel] = weightless();
        return float3(0.0);
    }
    weight[pixel] = params.masked != 0u
        ? mask[pixel * params.mask_stride + params.mask_slot]
        : feather(pinhole);
    return pixel_out;
}

/// A pair of output pixels at a time, for `warp.slang`'s reason: three samples do not fill a whole
/// number of words and two pixels do.
[shader("compute")]
[numthreads(64, 1, 1)]
void composite_gather(uint3 id : SV_DispatchThreadID)
{
    let pair = linear(id);
    let pixels = params.out_size.x * params.out_size.y;
    let first = pair * 2;
    if (first >= pixels) { return; }

    let a = gathered(first);
    var b = float3(0.0);
    let paired = first + 1 < pixels;
    if (paired) {
        b = gathered(first + 1);
    }

    store_pair(out_, pair, level_of(a), level_of(b), paired, false);
}

/// The coordinate the gather would tap, without tapping it: what the host's own projection maths is
/// pinned against, over every pixel of a window.
[shader("compute")]
[numthreads(64, 1, 1)]
void composite_probe(uint3 id : SV_DispatchThreadID)
{
    let pixel = linear(id);
    if (pixel >= params.out_size.x * params.out_size.y) { return; }

    float2 pinhole;
    let ahead = asked_for(pixel, correction(pixel), pinhole);
    let source = source_of(pinhole, 1);
    let inside = ahead
        && source.x >= 0.0 && source.y >= 0.0
        && source.x <= params.edge.x && source.y <= params.edge.y;
    probe[3 * pixel] = source.x;
    probe[3 * pixel + 1] = source.y;
    probe[3 * pixel + 2] = inside ? 1.0 : 0.0;
}
