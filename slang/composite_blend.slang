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
    /// The layer's worth against the others, where it clips, how far it may stray from the anchor
    /// and whether it is the anchor: `composite_tile::Merit`.
    float merit;
    float clip;
    float ghost;
    uint anchors;
};

/// `composite_tile::UNANCHORED`: a pixel the anchor could not vouch for, which nothing is compared at.
static const float UNANCHORED = -1.0;

/// A light below which two are not told apart, in the blend's own units: a nit, where a short
/// frame's shadow is mostly noise and its ratio to the anchor would be too.
static const float DARK = 1e-4;

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
/// The anchoring layer's luma a pixel, or `UNANCHORED`.
[vk::binding(7, 0)] RWStructuredBuffer<float> anchor;

/// How much of a layer to trust where the scene may have moved since the anchor was taken: all of
/// it within `ghost` of the anchor's light, none at twice that.
float consistent(float3 light, uint pixel)
{
    if (params.ghost <= 0.0) { return 1.0; }
    let anchored = anchor[pixel];
    if (anchored == UNANCHORED) { return 1.0; }
    let mine = dot(LUMA, max(light, float3(0.0)));
    let apart = abs(stops_of(gain((mine + DARK) / (anchored + DARK))).s);
    return 1.0 - smoothstep(params.ghost, 2.0 * params.ghost, apart);
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
    if (params.anchors != 0u) {
        // Half-clipped is past vouching for: the later frames are what it is short of there.
        anchor[pixel] = sound > 0.5 ? dot(LUMA, max(light, float3(0.0))) : UNANCHORED;
    }
    let w = reach * params.merit * sound * consistent(light, pixel);
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
