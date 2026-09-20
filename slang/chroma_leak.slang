// Whether a 4:2:0 encode of this frame would come back with colours it never held.
//
// Chroma is stored once per 2x2 and Y' once per pixel, so a decoder reconstructs each pixel's
// channel as `c' + (dY' - dc)` in the coding's own codes, d being the pixel's departure from its
// block's mean. That is exactly the leak of a box-averaged BT.2020 non-constant-luminance YCbCr,
// and it is the shape of the leak under any chroma the encoder chooses, since four pixels' colour
// go into four lumas and two chromas whatever the choice: green's swing lands in red at two
// thirds. White sparkle on a red, or a channel the grade holds near the PQ foot, is a speckle the
// source does not have (`avif.rs`), and this is what says so before the encoder is asked.
//
// Counted per tile rather than over the frame. A subject can be a hundredth of a 61MP frame and
// wholly wrong, and a fraction of the frame would not see it.
import packed;
import prelude;

struct Params {
    uint width;
    uint height;
    /// A predicted error past this, in 16-bit codes, is a pixel the decode gets visibly wrong.
    float threshold;
    /// A block whose mean luma code is under this is too dark for its error to be seen: PQ's
    /// codes near black are a dark-adapted eye's steps, and a still is not viewed dark-adapted.
    float dark;
    /// Tile edge, in 2x2 blocks.
    uint tile;
    uint tiles_across;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] RWStructuredBuffer<uint> frame;
/// Per tile, how many of its blocks would leak.
[vk::binding(2, 0)] RWStructuredBuffer<Atomic<uint> > tiles;

/// BT.2020 non-constant luminance, matrix coefficients 9: what `hdr_args::cicp` writes the still
/// with, so the leak is measured through the matrix the decoder will actually invert.
///
/// `prelude::LUMA` is that vector, and the one place it is written down: a second copy is how the
/// wrong weights reached `finish_chroma`'s grey axis, which `prelude` records.
static const float3 LUMA_2020 = LUMA;

float3 pixel_at(uint x, uint y)
{
    let p = (y * params.width + x) * 3;
    return float3(
        float(half_of(frame[p / 2], p)),
        float(half_of(frame[(p + 1) / 2], p + 1)),
        float(half_of(frame[(p + 2) / 2], p + 2)));
}

/// The largest channel error one pixel's reconstruction carries.
float leak_of(float3 pixel, float3 mean)
{
    let d = pixel - mean;
    let e = abs(float3(dot(LUMA_2020, d)) - d);
    return max(e.r, max(e.g, e.b));
}

[shader("compute")]
[numthreads(16, 16, 1)]
void chroma_leak(uint3 id : SV_DispatchThreadID)
{
    let bx = id.x;
    let by = id.y;
    if (2 * bx + 1 >= params.width || 2 * by + 1 >= params.height) { return; }
    let a = pixel_at(2 * bx, 2 * by);
    let b = pixel_at(2 * bx + 1, 2 * by);
    let c = pixel_at(2 * bx, 2 * by + 1);
    let d = pixel_at(2 * bx + 1, 2 * by + 1);
    let mean = (a + b + c + d) * 0.25;
    if (dot(LUMA_2020, mean) < params.dark) { return; }
    let worst = max(max(leak_of(a, mean), leak_of(b, mean)), max(leak_of(c, mean), leak_of(d, mean)));
    if (worst > params.threshold) {
        tiles[(by / params.tile) * params.tiles_across + bx / params.tile].add(1);
    }
}
