// The layers of a canvas window, mixed into one picture.
//
// **One layer a dispatch, into an accumulator.** WGSL has no array of buffers, so a kernel taking N
// layers at once would fix N in the shader; a panorama of eleven frames would then need an eleventh
// pipeline. Adding one layer at a time costs a dispatch each over a window - nothing beside the
// gather that produced it - and the count stops mattering.
//
// **Mixed in light, not in codes.** A code is quasi-logarithmic, so averaging two of them weights
// the brighter tap as though it were far darker than it is: `reduce.slang` measured 427 nits where
// the light gives 1150. So each layer is decoded through the table the coding built, mixed there,
// and the sum is searched back through the same table - which is what makes a window covered by one
// source come back the samples that source arrived with.
import lanes;
import light;
import packed;
import prelude;

struct Params {
    uint pixels;
    /// The layer's worth against the others, where it clips, whether it is compared against the
    /// anchor, and its noise in the blend's own units: `composite_tile::Merit`.
    float merit;
    float clip;
    uint deghosts;
    /// A pixel at light `l` varies by `noise_slope * l + noise_floor`.
    float noise_slope;
    float noise_floor;
};

/// `composite_tile::UNANCHORED`: a pixel no layer has vouched for yet. A pair of half NaNs, which
/// no anchor packs to.
static const uint UNANCHORED = 0xFFFFFFFFu;

/// A light below which two are not told apart, in the blend's own units: a nit.
static const float DARK = 1e-4;

/// What two frames of one still scene may still differ by once their noise is allowed for: the
/// headers' exposure arithmetic, whose nominal shutters and apertures miss by up to a sixth of a
/// stop, and what the demosaic and the lens leave between two exposures.
static const float EXPOSURE_ALLOWANCE = 0.3;
/// The combined noise, in its own deviations, a disagreement has to pass before it is a ghost.
static const float GHOST_DEVIATIONS = 3.0;

/// Where below its clip a layer starts giving way, as a share of the clip: far enough down that
/// a channel near saturation has already lost its linearity before it counts for nothing.
static const float ROLL_OFF_FROM = 0.8;

/// How much of a layer's light to trust at a pixel: all of it well below its clip, none at it.
float unclipped(float3 light)
{
    if (params.clip <= 0.0) { return 1.0; }
    let brightest = max(light.r, max(light.g, light.b));
    return 1.0 - smoothstep(ROLL_OFF_FROM * params.clip, params.clip, brightest);
}

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<uint> layer;
/// The layer's own feather, as `composite_gather.slang` wrote it: zero where the source does not reach.
[vk::binding(2, 0)] StructuredBuffer<float> weight;
/// Four floats an output pixel: the weighted light so far, and the weight it was taken over.
[vk::binding(3, 0)] RWStructuredBuffer<float> acc;
[vk::binding(4, 0)] RWStructuredBuffer<uint> out_;
/// One word an output pixel, 255 where anything covered it.
[vk::binding(5, 0)] RWStructuredBuffer<uint> alpha;
/// The frame's coding undone: light, normalised so that the largest code is one, per code.
[vk::binding(6, 0)] StructuredBuffer<float> light_of_code;
/// The luma a pixel's anchor read and its relative deviation there, as half floats, or
/// `UNANCHORED`. The anchor is the first layer that could vouch for the pixel: the reference, and
/// where it clipped, the next frame in exposure (`composite_tile::order_of`).
[vk::binding(7, 0)] RWStructuredBuffer<uint> anchor;

/// A light's deviation as a share of it: what it is in stops, but for the `ln 2`.
float relative_deviation(float luma)
{
    let level = luma + DARK;
    return sqrt(max(params.noise_slope * luma + params.noise_floor, 0.0)) / level;
}

/// How much of a layer to trust where the scene may have moved since the anchor was taken: all of
/// it within its and the anchor's noise of the anchor's light, none at twice that.
float consistent(float mine, float2 anchored)
{
    let apart = abs(stops_of(gain((mine + DARK) / (anchored.x + DARK))).s);
    let spread = length(float2(relative_deviation(mine), anchored.y)) / log(2.0);
    let tolerance = EXPOSURE_ALLOWANCE + GHOST_DEVIATIONS * spread;
    return 1.0 - smoothstep(tolerance, 2.0 * tolerance, apart);
}

/// What a deghosted layer is worth at a pixel against its anchor, claiming the anchor where no
/// layer has yet and this one is sound enough to.
float anchored_at(uint pixel, float mine, float sound)
{
    let held = anchor[pixel];
    if (held != UNANCHORED) { return consistent(mine, unpackHalf2x16ToFloat(held)); }
    // Half-clipped is past vouching for: a shorter frame is what the pixel is short of there.
    if (sound > 0.5) { anchor[pixel] = packHalf2x16(float2(mine, relative_deviation(mine))); }
    return 1.0;
}

uint code_at(uint index)
{
    return half_of(layer[index / 2], index);
}

[shader("compute")]
[numthreads(64, 1, 1)]
void composite_add(uint3 id : SV_DispatchThreadID)
{
    let pixel = linear(id);
    if (pixel >= params.pixels) { return; }
    let reach = weight[pixel];
    if (reach <= 0.0) { return; }

    let base = pixel * 3;
    let light = float3(
        light_of_code[code_at(base)],
        light_of_code[code_at(base + 1)],
        light_of_code[code_at(base + 2)]);
    let sound = unclipped(light);
    let trusted = params.deghosts != 0u ? anchored_at(pixel, dot(LUMA, max(light, float3(0.0))), sound) : 1.0;
    let w = reach * params.merit * sound * trusted;
    if (w <= 0.0) { return; }
    let at = pixel * 4;
    acc[at] = acc[at] + w * light.r;
    acc[at + 1] = acc[at + 1] + w * light.g;
    acc[at + 2] = acc[at + 2] + w * light.b;
    acc[at + 3] = acc[at + 3] + w;
}

/// What the accumulator holds, as a coded pixel again.
float3 resolved(uint pixel)
{
    let at = pixel * 4;
    let total = acc[at + 3];
    if (total <= 0.0) {
        alpha[pixel] = 0;
        return float3(0.0);
    }
    alpha[pixel] = 255;
    return float3(acc[at], acc[at + 1], acc[at + 2]) / total;
}

/// A pair of output pixels at a time, for `warp.slang`'s reason: three samples do not fill a whole
/// number of words and two pixels do.
[shader("compute")]
[numthreads(64, 1, 1)]
void composite_resolve(uint3 id : SV_DispatchThreadID)
{
    let pair = linear(id);
    let first = pair * 2;
    if (first >= params.pixels) { return; }

    let a = resolved(first);
    var b = float3(0.0);
    let paired = first + 1 < params.pixels;
    if (paired) {
        b = resolved(first + 1);
    }

    store_pair(
        out_, pair, codes_of_light(light_of_code, a), codes_of_light(light_of_code, b), paired, false);
}
