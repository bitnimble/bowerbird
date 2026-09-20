// §5.2's two bands. `composite_blend` accumulates one weighted light and resolves once, and cannot
// carry two accumulators in another space - so the coverage average stays there and the band mix is
// this.
//
// **In log2 light, because an exposure difference is a ratio.** There it is a constant offset the
// low band removes uniformly over `2 * W_low`. In light the residual grows with luminance - invisible
// in shadow and large in highlight; in PQ a gain is a multiply in `(Y/10000)^m1` and not an offset
// either. And a high band in a linear space is signal-proportional, which is a dark halo on the
// bright side of every luminance step.
import lanes;
import packed;
import seam_weight;

/// `composite_gather.slang`'s: a pixel the source's own frame does not cover.
static const float NOT_REACHED = -1e30;

/// Under this, light is the coding's own floor and its log is not a number worth taking.
static const float LIGHT_FLOOR = 1e-9;

struct Params {
    uint2 size;
    uint pixels;
    /// §5.2's high band, in this render's own pixels.
    float w_high;
    /// The lowpass's grid, and where this window sits on it.
    uint2 lowpass_size;
    float2 lowpass_at;
    float2 lowpass_per_pixel;
    float2 pad;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<uint> layer;
/// §5.2's signed distance for this source, as `composite_gather` wrote it.
[vk::binding(2, 0)] StructuredBuffer<float> weight;
/// §5.2's `W(x)`, one float a pixel, the same for every source and so the same on both sides of a
/// seam - which is what makes two meeting unions sum to one.
[vk::binding(3, 0)] StructuredBuffer<float> width;
/// This source's lowpass over the whole crop, on the split's own grid.
[vk::binding(4, 0)] StructuredBuffer<uint> lowpass;
/// Eight floats an output pixel: the low band's weighted sum and its weight, then the high band's.
[vk::binding(5, 0)] RWStructuredBuffer<float> acc;
[vk::binding(6, 0)] RWStructuredBuffer<uint> out_;
[vk::binding(7, 0)] StructuredBuffer<float> light_of_code;

float3 light_at(StructuredBuffer<uint> from, uint index)
{
    let base = index * 3;
    return float3(
        light_of_code[half_of(from[base / 2], base)],
        light_of_code[half_of(from[(base + 1) / 2], base + 1)],
        light_of_code[half_of(from[(base + 2) / 2], base + 2)]);
}

/// The lowpass under an output pixel, bilinear on the split's grid.
float3 lowpass_under(uint pixel)
{
    let u = params.lowpass_at.x + float(pixel % params.size.x) * params.lowpass_per_pixel.x;
    let v = params.lowpass_at.y + float(pixel / params.size.x) * params.lowpass_per_pixel.y;
    let x0 = uint(clamp(floor(u), 0.0, float(params.lowpass_size.x - 1)));
    let y0 = uint(clamp(floor(v), 0.0, float(params.lowpass_size.y - 1)));
    let x1 = min(x0 + 1, params.lowpass_size.x - 1);
    let y1 = min(y0 + 1, params.lowpass_size.y - 1);
    let fx = clamp(u - float(x0), 0.0, 1.0);
    let fy = clamp(v - float(y0), 0.0, 1.0);
    let a = lerp(light_at(lowpass, y0 * params.lowpass_size.x + x0),
                 light_at(lowpass, y0 * params.lowpass_size.x + x1), fx);
    let b = lerp(light_at(lowpass, y1 * params.lowpass_size.x + x0),
                 light_at(lowpass, y1 * params.lowpass_size.x + x1), fx);
    return lerp(a, b, fy);
}

[shader("compute")]
[numthreads(64, 1, 1)]
void assembly_add(uint3 id : SV_DispatchThreadID)
{
    let pixel = linear(id);
    if (pixel >= params.pixels) { return; }
    let signed_ = weight[pixel];
    // Not `<= 0`: a zero is a pixel *on* the seam, which is half weight. Only the sentinel is
    // absence, and `composite_gather` writes it at both the places it decides a weight.
    if (signed_ <= NOT_REACHED * 0.5) { return; }

    let w_low = smooth_between(width[pixel], signed_);
    let w_high = smooth_between(params.w_high, signed_);
    if (w_low <= 0.0 && w_high <= 0.0) { return; }

    let l = log2(max(light_at(layer, pixel), LIGHT_FLOOR));
    let low = log2(max(lowpass_under(pixel), LIGHT_FLOOR));
    let at = pixel * 8;
    for (uint c = 0; c < 3; c = c + 1) {
        acc[at + c] = acc[at + c] + w_low * low[c];
        acc[at + 4 + c] = acc[at + 4 + c] + w_high * (l[c] - low[c]);
    }
    acc[at + 3] = acc[at + 3] + w_low;
    acc[at + 7] = acc[at + 7] + w_high;
}

float3 resolved(uint pixel)
{
    let at = pixel * 8;
    let low_total = acc[at + 3];
    if (low_total <= 0.0) { return float3(0.0); }
    let high_total = acc[at + 7];
    var l = float3(acc[at], acc[at + 1], acc[at + 2]) / low_total;
    if (high_total > 0.0) {
        l = l + float3(acc[at + 4], acc[at + 5], acc[at + 6]) / high_total;
    }
    return exp2(l);
}

/// A pair of output pixels at a time, for `warp.slang`'s reason.
[shader("compute")]
[numthreads(64, 1, 1)]
void assembly_resolve(uint3 id : SV_DispatchThreadID)
{
    let pair = linear(id);
    let first = pair * 2;
    if (first >= params.pixels) { return; }
    let a = resolved(first);
    var b = float3(0.0);
    let paired = first + 1 < params.pixels;
    if (paired) { b = resolved(first + 1); }

    store_pair(
        out_, pair, codes_of_light(light_of_code, a), codes_of_light(light_of_code, b), paired, false);
}
