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
import packed;

struct Params {
    uint pixels;
};

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
    let w = weight[pixel];
    if (w <= 0.0) { return; }

    let base = pixel * 3;
    let light = float3(
        light_of_code[code_at(base)],
        light_of_code[code_at(base + 1)],
        light_of_code[code_at(base + 2)]);
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
