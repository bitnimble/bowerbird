// Averaging a frame down, stated once so both hosts do it the same way.
//
// **A destination pixel's footprint is a fractional interval, and its ends are weighted.** At a
// ratio of 3.75 an output pixel covers source `[3.75, 7.5)`: a quarter of pixel 3, all of 4, 5 and
// 6, half of 7. Taking `floor` of each end and averaging whole pixels equally - reading 3, 4, 5, 6
// at equal weight and not reading 7 at all - is on a ramp a *bias* rather than noise, every output
// pixel pulled towards the start of its own footprint. It measured 625 counts of 65535 at exactly
// the ratio a 6000px sensor takes to a 1600px rendition.
//
// **The fractional ends are also what unlocks a window from a grid.** A footprint snapped to whole
// source pixels can only be cut at whole source pixels, so a rectangle resized on its own had to
// start where the whole frame's partition happened to have a boundary - a lattice of
// `sw / gcd(sw, dw)` pixels. Weighted ends have no such boundaries: the interval is real-valued and
// any sub-rectangle of it is too.
//
// **A pyramid level is that footprint at a ratio of exactly two**, where every interval lands on
// whole source pixels and each of the four weights is one. The arithmetic is `covers` and `overlap`,
// shared by all three entry points, and `every_pyramid_level_is_a_mean_of_the_four_above_it` holds
// the levels to it.
//
// **Where the three differ is the space they accumulate in, and that is the one deliberate split.**
// `resize` cuts a rendition, which is a file: it decodes each tap through `light_of_code` and
// averages light, because a mean of PQ codes is not a mean of light and PQ is quasi-logarithmic - on
// a 4000-nit specular against a 200-nit surround at 2x, averaging codes gives 427 nits where the
// light gives 1150. `halve` and `reduce` build the pyramid a canvas reads and stay in the frame's own
// coding, for the reason recorded below.
//
// Beyond that they differ only in where a sample comes from and where the answer goes: the frame's
// buffer or a coarser level, into a buffer or into the level below. The loops that walk the footprint
// sit next to each other, to be edited in pairs.
//
// **Why a pyramid exists at all, given one pass can do any ratio.** Total work here is the *source*:
// each source pixel falls in exactly one output footprint per axis, so a single pass reads the frame
// once however deep the reduction, because the output shrinks as the ratio grows and the two cancel.
// That is a rendition, where the output size is the ratio. A canvas is *fixed-size*, so the taps per
// output pixel grow with the zoom and the total grows with it - measured at 9ms for one tap against
// 71ms for sixteen on a 61MP frame, scattered gathers being latency rather than bandwidth. The
// pyramid moves that work to the open, one linear pass over 1.33 frames, and leaves every draw
// sampling a level where four taps is the whole answer.
//
// It starts at half resolution, so the frame itself is not stored twice: a third of half a frame
// rather than a third of a whole one - 160MB against 481 at 61MP - and the level it leaves out is
// the one the draw reads straight from the buffer anyway.
//
// Levels hold the frame's own coding rather than light, which is a deliberate approximation rather
// than the property the draw's own taps hold. Decoding here would mean an `rgba32float` pyramid -
// twice the 160MB - to average a level the reader only ever sees zoomed far enough out that four
// source pixels are inside one canvas one. Measured against a decoded reduce over the parity
// fixtures, the worst canvas pixel moves under a count of 255; `covered`'s own taps decode first, so
// a 1:1 view is exact.
import lanes;
import packed;

struct Reduction {
    uint2 source;
    uint2 size;
    /// Source pixels per output pixel, per axis. Given rather than derived from the two sizes above:
    /// a pyramid level is a *floored* half, so at an odd width the ratio it wants is two and the
    /// quotient of the sizes is not.
    float2 scale;
};

[vk::binding(0, 0)] ConstantBuffer<Reduction> reduction;
[vk::binding(1, 0)] StructuredBuffer<uint> frame;
[vk::binding(2, 0)] Texture2D<uint4> coarser;
[vk::binding(3, 0)] [format("rgba16ui")] WTexture2D<uint4> finer;
[vk::binding(4, 0)] RWStructuredBuffer<uint> smaller;
/// The frame's coding undone: light, normalised so that the largest code is one, per code.
///
/// Bound by `resize` alone. Its layout is its own (`base.rs` builds one per entry point), so the
/// pyramid's two kernels neither carry this nor pay for it.
[vk::binding(5, 0)] StructuredBuffer<float> light_of_code;

/// Where an output pixel of a flat list sits in the grid the list is of.
float2 placed(uint pixel, uint width)
{
    return float2(float(pixel % width), float(pixel / width));
}

/// The source interval an output pixel covers, as `(start, end)` per axis.
float4 covers(float2 at, float2 scale)
{
    // Each end scaled from its own coordinate rather than the far one stepped on from the near one:
    // `(x + 1) * s` and `x * s + s` differ by an ulp at some ratios, which is a weight moving and a
    // fixture with it. `from`/`to` would read better and `from` is a WGSL reserved word.
    return float4(at * scale, (at + float2(1.0)) * scale);
}

/// How much of one source pixel that interval holds: one in the interior, a fraction at each end.
float overlap(float lo, float hi, uint at)
{
    return min(float(at + 1), hi) - max(float(at), lo);
}

float sample_at(uint index)
{
    return float(half_of(frame[index / 2], index));
}

uint level_of(float value)
{
    // Rounded, where the gather truncates: this is an average rather than a resample, so there is no
    // second pass to inherit the bias and a flat field must come back the value it went in as.
    return uint(clamp(value + 0.5, 0.0, 65535.0));
}

/// The code at one sample, as the index the tables are keyed by.
uint code_at(uint index)
{
    return half_of(frame[index / 2], index);
}

/// One output pixel, integrated in light over the frame buffer it covers.
///
/// **The average a lower-resolution sensor would have made.** A copy of the loop below differing in
/// its fetch - WGSL has nothing to parameterise one by - and the difference is the whole point: a
/// mean of PQ codes is not a mean of light, and PQ is quasi-logarithmic, so a specular tap is
/// weighted as though it were far darker than it is. On a 4000-nit highlight against a 200-nit
/// surround at 2x, averaging codes gives 427 nits where the light gives 1150.
float3 averaged_light(float2 at, float2 scale, uint2 source)
{
    let box = covers(at, scale);
    let first = uint2(box.xy);
    let last = uint2(min(ceil(box.zw), float2(source)));

    float3 acc = float3(0.0);
    float total = 0.0;
    for (uint sy = first.y; sy < last.y; sy = sy + 1) {
        let wy = overlap(box.y, box.w, sy);
        if (wy <= 0.0) { continue; }
        for (uint sx = first.x; sx < last.x; sx = sx + 1) {
            let weight = overlap(box.x, box.z, sx) * wy;
            if (weight <= 0.0) { continue; }
            let base = ((sy * source.x) + sx) * 3;
            acc = acc + weight * float3(
                light_of_code[code_at(base)],
                light_of_code[code_at(base + 1)],
                light_of_code[code_at(base + 2)]);
            total = total + weight;
        }
    }
    return acc / max(total, 1e-6);
}

/// One output pixel, integrated over the frame buffer it covers, in the frame's own coding.
///
/// What the pyramid is built with. This file's header says why that stays in codes where the
/// resize above does not: a level is only ever read zoomed far enough out that four source pixels
/// are inside one canvas one, and decoding here would double the pyramid's 160MB.
float3 averaged(float2 at, float2 scale, uint2 source)
{
    let box = covers(at, scale);
    let first = uint2(box.xy);
    let last = uint2(min(ceil(box.zw), float2(source)));

    float3 acc = float3(0.0);
    float total = 0.0;
    for (uint sy = first.y; sy < last.y; sy = sy + 1) {
        let wy = overlap(box.y, box.w, sy);
        if (wy <= 0.0) { continue; }
        for (uint sx = first.x; sx < last.x; sx = sx + 1) {
            let weight = overlap(box.x, box.z, sx) * wy;
            if (weight <= 0.0) { continue; }
            let base = ((sy * source.x) + sx) * 3;
            acc = acc + weight * float3(sample_at(base), sample_at(base + 1), sample_at(base + 2));
            total = total + weight;
        }
    }
    return acc / max(total, 1e-6);
}

/// The same over a coarser pyramid level, which is a texture rather than the frame's buffer.
///
/// A copy of the loop above, differing in its fetch, because WGSL has nothing to parameterise one by
/// - and an entry point that named both bindings would need both in its layout, which for the first
/// level means binding the texture being written. So the arithmetic that can be wrong is shared
/// (`covers`, `overlap`) and the walk over it sits adjacent, to be edited in pairs.
float3 averaged_coarser(float2 at, float2 scale, uint2 source)
{
    let box = covers(at, scale);
    let first = uint2(box.xy);
    let last = uint2(min(ceil(box.zw), float2(source)));

    float3 acc = float3(0.0);
    float total = 0.0;
    for (uint sy = first.y; sy < last.y; sy = sy + 1) {
        let wy = overlap(box.y, box.w, sy);
        if (wy <= 0.0) { continue; }
        for (uint sx = first.x; sx < last.x; sx = sx + 1) {
            let weight = overlap(box.x, box.z, sx) * wy;
            if (weight <= 0.0) { continue; }
            acc = acc + weight * float3(coarser.Load(int3(int(sx), int(sy), 0)).rgb);
            total = total + weight;
        }
    }
    return acc / max(total, 1e-6);
}

/// A frame to a smaller frame, at whatever ratio the caller asked for. What a rendition is cut with.
///
/// A pair of output pixels at a time, for `warp_lens`'s reason: three samples do not fill a whole
/// number of words and two pixels do, so a per-pixel invocation would share its last word with its
/// neighbour's first and one of the two writes would be lost.
[shader("compute")]
[numthreads(64, 1, 1)]
void resize(uint3 id : SV_DispatchThreadID)
{
    let pair = linear(id);
    let pixels = reduction.size.x * reduction.size.y;
    let first = pair * 2;
    if (first >= pixels) { return; }

    let a = averaged_light(placed(first, reduction.size.x), reduction.scale, reduction.source);
    float3 b = float3(0.0);
    let paired = first + 1 < pixels;
    if (paired) {
        b = averaged_light(placed(first + 1, reduction.size.x), reduction.scale, reduction.source);
    }

    store_pair(
        smaller,
        pair,
        codes_of_light(light_of_code, a),
        codes_of_light(light_of_code, b),
        paired,
        false);
}

/// The pyramid's own first level, from the frame's buffer.
[shader("compute")]
[numthreads(8, 8, 1)]
void halve(uint3 id : SV_DispatchThreadID)
{
    uint2 size;
    finer.GetDimensions(size.x, size.y);
    if (id.x >= size.x || id.y >= size.y) { return; }
    let level = averaged(float2(id.xy), float2(2.0), reduction.source);
    finer.Store(
        int2(int(id.x), int(id.y)),
        uint4(level_of(level.r), level_of(level.g), level_of(level.b), 65535));
}

/// Every level after it, from the one above.
///
/// No uniform read: the dimensions of the two views say which level this is, so the pass is the
/// same code however deep the chain goes.
[shader("compute")]
[numthreads(8, 8, 1)]
void reduce(uint3 id : SV_DispatchThreadID)
{
    uint2 size;
    finer.GetDimensions(size.x, size.y);
    if (id.x >= size.x || id.y >= size.y) { return; }
    uint2 above;
    coarser.GetDimensions(above.x, above.y);
    let level = averaged_coarser(float2(id.xy), float2(2.0), above);
    finer.Store(
        int2(int(id.x), int(id.y)),
        uint4(level_of(level.r), level_of(level.g), level_of(level.b), 65535));
}
