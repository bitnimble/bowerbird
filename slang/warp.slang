// The lens correction: each output pixel read from the radius the lens moved it to, tapped four
// by four through Catmull-Rom, with the falloff lifted back in on the way out. Every output pixel
// is independent and reads only the source, which is what makes it a compute dispatch rather
// than a strip loop.
//
// **A gather cannot run in place.** `frame` and `out` are two buffers, and every neighbour a tap
// reads is the source as it arrived.
import lanes;
import packed;
import lens_gather;

struct Params {
    uint2 source;
    uint2 size;
    /// The *photograph's* centre, half a pixel back: `tap` reads a grid where an integer is a
    /// pixel's centre and the offsets below are continuous coordinates.
    ///
    /// The photograph's rather than the buffer's, with `origin` below taking the buffer's own start
    /// off afterwards, and the order is load-bearing. Folding the two together would compute a
    /// window's tap position as `(centre - origin) + travel` where a whole frame computes
    /// `centre + travel` - the same value in exact arithmetic and not in `f32`, and `level_of`
    /// truncates, so a difference of one ulp either side of an integer is a whole count. Measured on
    /// a 6000px Canon frame: 0.68% of a loupe tile's samples a count from the render it predicts,
    /// worth up to 76 counts once the grade had expanded a shadow.
    float2 centre;
    /// Where the buffer starts in the photograph, which is zero for a whole frame. An integer, so
    /// taking it off a position already computed is exact.
    float2 origin;
    /// Source pixels per output pixel, which the ratio multiplies into.
    float2 scale;
    float2 edge;
    /// Where output pixel zero sits relative to the centre the lens is defined about.
    ///
    /// **This is the whole of what makes a window a window.** A frame's own gather has the picture's
    /// centre in the middle of its output grid, so this is minus half the grid; a loupe tile is a
    /// rectangle somewhere else in the same optics, so it is the window's origin minus half the
    /// *photograph*. Everything below is then one arithmetic, and a tile is corrected at the radius
    /// the frame would have corrected it at rather than as though it were the whole picture.
    float2 bias;
    /// `1 / half^2` of the grid the lens is defined over, since the table is indexed by r^2 and
    /// never needs r.
    float inv_half2;
    float pad;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<uint> frame;
[vk::binding(2, 0)] RWStructuredBuffer<uint> out_;
[vk::binding(3, 0)] StructuredBuffer<float> ratios;
/// `tone::gain_in_y` per radius bucket, 1.0 where the falloff cannot move a 16-bit code.
[vk::binding(4, 0)] StructuredBuffer<float> lifts;
/// Output pixels per source pixel at each output pixel, `(x, y)` as two `f16` in a word.
///
/// The sharpen's, and a byproduct here because this is the one pass that knows the mapping:
/// capture blur is uniform in the *source*, so where the correction stretches a corner the
/// blur stretches with it, by exactly this factor per axis.
[vk::binding(5, 0)] RWStructuredBuffer<uint> jacobian;

uint3 level_of(float3 value)
{
    // Truncation, not `round`: the editor's materialised warp and the encode's gather are held to
    // each other by the fixtures, and both quantise this way.
    return uint3(clamp(value, 0.0, 65535.0));
}

/// Where one channel of one output position reads from, in the source buffer's pixels.
///
/// `ox`/`oy` are offsets from the lens's centre in output pixels, as `gathered` builds them.
float2 source_of(float ox, float oy, uint c)
{
    let ratio = lens_ratio(ratios, (ox * ox + oy * oy) * params.inv_half2, c);
    // In the photograph first, and only then into this buffer. `Params::centre` says why the two
    // cannot be folded.
    return float2(
        (params.centre.x + ox * ratio * params.scale.x) - params.origin.x,
        (params.centre.y + oy * ratio * params.scale.y) - params.origin.y);
}

/// One output pixel, read from where the lens put it.
float3 gathered(uint pixel)
{
    let x = pixel % params.size.x;
    let y = pixel / params.size.x;
    // Where this pixel sits relative to the centre the lens is defined about, in output pixels,
    // kept in pixels: dividing by `half` and multiplying it back by `half * scale` costs f32 an
    // error of a whole ulp at the frame's edge, which the taps below are steep enough to see.
    let ox = params.bias.x + float(x) + 0.5;
    let oy = params.bias.y + float(y) + 0.5;
    let r2 = (ox * ox + oy * oy) * params.inv_half2;

    let bucket = min(uint(min(sqrt(r2) * 255.0, 255.0)), 255);
    let gain = lifts[bucket];

    // The green channel's mapping is the geometric reference (the other two differ from it only
    // by the lateral aberration), and one source pixel of it holds this much of an output pixel.
    // Clamped to what a stills lens does: past 4x the derivative is the model misbehaving, and
    // a sigma scaled by it would deconvolve garbage confidently.
    let here = source_of(ox, oy, 1);
    let mx = abs(source_of(ox + 1.0, oy, 1).x - here.x);
    let my = abs(source_of(ox, oy + 1.0, 1).y - here.y);
    let j = clamp(float2(1.0 / max(mx, 1e-4), 1.0 / max(my, 1e-4)), float2(0.25), float2(4.0));
    jacobian[pixel] = packHalf2x16(j);

    var pixel_out = float3(0.0);
    for (uint c = 0; c < 3; c++) {
        let source = source_of(ox, oy, c);
        let px = source.x;
        let py = source.y;
        // Outside the source the pixel keeps the black it started as, which is what the pair gate
        // downstream skips. Per channel, because a lateral aberration reads each at its own radius.
        if (px < 0.0 || py < 0.0 || px > params.edge.x || py > params.edge.y) { continue; }
        var value = tap(frame, params.source, px, py, c);
        // A gain of 1 returns the tap rather than the round trip's answer to it: `lift_in_pq` is
        // `pq(pq_inv(u))` there, and that is a count out on some codes.
        if (gain != 1.0) { value = lift_in_pq(value / 65535.0, gain) * 65535.0; }
        pixel_out[c] = value;
    }
    return pixel_out;
}

/// A pair of output pixels at a time, for `defringe_apply`'s reason: three samples do not fill a
/// whole number of words and two pixels do, so a per-pixel invocation would share its last word
/// with its neighbour's first and one of the two writes would be lost.
[shader("compute")]
[numthreads(64, 1, 1)]
void warp_lens(uint3 id : SV_DispatchThreadID)
{
    let pair = linear(id);
    let pixels = params.size.x * params.size.y;
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
