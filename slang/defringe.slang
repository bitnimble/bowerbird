// Longitudinal chromatic aberration, taken off the frame where it already is.
//
// `image::defringe` subtracts a multiple of luma's curvature from the two chroma differences, and
// `recombine` solves the luma equation for green so the correction cannot move brightness. Both
// of those are per-pixel, so composing them algebraically leaves one add per channel:
//
//   R -= k_red  * lap * FULL
//   B -= k_blue * lap * FULL
//   G += (LUMA.r * k_red + LUMA.b * k_blue) / LUMA.g * lap * FULL
//
// which is the whole stage. What the CPU spends its time on is not this arithmetic - it is
// splitting an interleaved frame into three `f32` planes, filtering them in strips with a halo
// each, and interleaving them back. A shader reads the frame where it lies, so none of that
// exists here: no planes, no strips, no carry, no seam to get wrong.
//
// `LUMA` arrives as a uniform rather than being written out again. It is one rule and the host
// already holds it; a second copy here is the kind that stays right until somebody retunes one.
import lanes;
import packed;

struct Params {
    uint width;
    uint height;
    float k_red;
    float k_blue;
    /// `image::LUMA`, and `full` is what a sample's range is - 65535 for the `u16` frame.
    float3 luma;
    float full;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] RWStructuredBuffer<uint> frame;
[vk::binding(2, 0)] RWStructuredBuffer<float> luma;

float sample_at(uint at)
{
    return float(half_of(frame[at / 2], at));
}

uint3 level_of(float3 value)
{
    return uint3(round(clamp(value, 0.0, params.full)));
}

/// Phase 1: luma, into a plane of its own.
///
/// **Its own pass, and its own plane, because the correction reads neighbours.** The transform is
/// luma-preserving in exact arithmetic, so reading luma back out of a half-written frame would
/// almost work - but the frame is `u16` and every write rounds, so the curvature would be taken
/// from a mixture of rounded and unrounded neighbours and the answer would depend on which
/// invocation ran first. The CPU takes every Laplacian from one unmodified plane; so does this.
[shader("compute")]
[numthreads(64, 1, 1)]
void defringe_luma(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= params.width * params.height) { return; }
    let p = at * 3;
    let rgb = float3(sample_at(p), sample_at(p + 1), sample_at(p + 2));
    luma[at] = dot(params.luma, rgb) / params.full;
}

/// One pixel's three samples, corrected.
///
/// The stencil clamps at the frame's edge, as `image::laplacian` does with its saturating
/// indices - a border pixel reads itself for the neighbour it does not have, which makes the
/// second difference zero there rather than a step.
float3 corrected(uint pixel)
{
    let x = pixel % params.width;
    let y = pixel / params.width;

    let here = luma[pixel];
    let left = luma[y * params.width + max(x, 1) - 1];
    let right = luma[y * params.width + min(x + 1, params.width - 1)];
    let up = luma[(max(y, 1) - 1) * params.width + x];
    let down = luma[min(y + 1, params.height - 1) * params.width + x];
    let curvature = left + right + up + down - 4.0 * here;

    // Green moves the other way, and by the amount that holds luma still: `recombine` solves
    // `LUMA . (dr, dg, db) = 0` for green, so whatever the other two lose it takes on.
    let green = (params.luma.r * params.k_red + params.luma.b * params.k_blue) / params.luma.g;
    let shift = float3(-params.k_red, green, -params.k_blue) * curvature * params.full;

    let p = pixel * 3;
    return float3(sample_at(p), sample_at(p + 1), sample_at(p + 2)) + shift;
}

/// Phase 2: the correction, a pair of pixels at a time.
///
/// **A pair, because three samples do not fill a whole number of words and two pixels do.** A
/// sample is sixteen bits and the smallest thing a shader can address is thirty-two, so a
/// per-pixel invocation would have to read a word, replace one half and write it back - and the
/// word holding a pixel's last sample also holds its neighbour's first. Two invocations would
/// race on it, and the loser's correction would be dropped. Six samples are exactly three words,
/// owned by nobody else.
[shader("compute")]
[numthreads(64, 1, 1)]
void defringe_apply(uint3 id : SV_DispatchThreadID)
{
    let pair = linear(id);
    let pixels = params.width * params.height;
    let first = pair * 2;
    if (first >= pixels) { return; }

    let a = corrected(first);
    // The odd tail: a frame with an odd pixel count leaves the last pair half empty, and the three
    // samples that are not there must not be written over the ones that are.
    float3 b = float3(0.0);
    let paired = first + 1 < pixels;
    if (paired) {
        b = corrected(first + 1);
    }

    store_pair(frame, pair, level_of(a), level_of(b), paired, true);
}
