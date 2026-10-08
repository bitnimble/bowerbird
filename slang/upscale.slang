// The 2x mosaic upscaler's forward pass (`models/upscaler`): a stack of 3x3 convolutions over the
// mosaic's packed RGGB planes, each followed by a PReLU, whose last layer's 16 channels are the
// four planes at twice the size, added to the input's own planes and unstabilised.
//
// Every tensor is NHWC over a region of the frame with a ring of zeros around it, so a tap off the
// region reads zero without a branch. Positions outside the frame are written zero too, which is
// `nn.Conv2d`'s own padding at the frame's edge.

import times;

struct Step {
    /// The region a layer computes, in packed pixels, and where its corner sits in the frame.
    uint width;
    uint height;
    int left;
    int top;
    uint frame_width;
    uint frame_height;
    /// Where the layer's taps, biases and PReLU slopes start in `weights`, in floats.
    uint weights_at;
    uint bias_at;
    uint slope_at;
    /// Channels a pixel of `planes` holds: the input's four, and zeros after them.
    uint planes_channels;
    /// The region's interior, which [`leave`] writes, in region pixels.
    uint inner_left;
    uint inner_top;
    uint inner_width;
    uint inner_height;
};

/// What the network reads a plane `c` of light `x` as: (sqrt(x + floors[c]) - roots[c]) * scales[c],
/// `models/training`'s `Stabiliser`.
struct Stabilising {
    float4 floors;
    float4 roots;
    float4 scales;
};

#ifndef STORED
#define STORED float
#endif
typealias Stored = STORED;

[vk::binding(0, 0)] StructuredBuffer<float> weights;
[vk::binding(1, 0)] StructuredBuffer<Stored> given;
[vk::binding(2, 0)] RWStructuredBuffer<Stored> made;
/// What [`pack`] wrote through `made`, read back by the first layer as `given` and by [`leave`].
[vk::binding(3, 0)] StructuredBuffer<Stored> planes;
[vk::binding(4, 0)] StructuredBuffer<float> mosaic;
[vk::binding(5, 0)] RWStructuredBuffer<float> upscaled;
[vk::binding(6, 0)] ConstantBuffer<Step> step;
[vk::binding(7, 0)] ConstantBuffer<Stabilising> stabilising;

/// A region pixel's place in a tensor, past the ring.
uint ringed(uint x, uint y)
{
    return (y + 1) * (step.width + 2) + x + 1;
}

bool in_frame(uint x, uint y)
{
    let fx = int(x) + step.left;
    let fy = int(y) + step.top;
    return fx >= 0 && fy >= 0 && fx < int(step.frame_width) && fy < int(step.frame_height);
}

/// The input mosaic's planes, variance-stabilised as the network was trained on them.
[shader("compute")]
[numthreads(16, 8, 1)]
void pack(uint3 at : SV_DispatchThreadID)
{
    if (at.x >= step.width || at.y >= step.height) { return; }
    let cell = times(ringed(at.x, at.y), step.planes_channels);
    for (uint c = 0; c < step.planes_channels; c++) {
        var value = 0.0;
        if (c < 4 && in_frame(at.x, at.y)) {
            let mx = uint(int(at.x) + step.left) * 2 + c % 2;
            let my = uint(int(at.y) + step.top) * 2 + c / 2;
            let light = mosaic[my * step.frame_width * 2 + mx];
            value = (sqrt(max(light + stabilising.floors[c], 0.0)) - stabilising.roots[c]) * stabilising.scales[c];
        }
        made[cell + c] = Stored(value);
    }
}

static const uint TILE_TALL = 8;
static const uint THREADS = 128;
static const uint OUT_MOST = 48;

/// What a layer computes in: the tensors' own type, so `half` math where they are held in `half`.
typealias Cell = Stored;
typealias Cell4 = vector<Cell, 4>;

// Sized for both tiles, together under the 16KB of workgroup memory every WebGPU device offers.
static const uint STAGED_PATCH = 1360 * 4 / sizeof(Cell);
static const uint STAGED_TAPS = 648 * 4 / sizeof(Cell);
groupshared Cell patch[STAGED_PATCH];
groupshared Cell4 taps[STAGED_TAPS];

/// One 3x3 layer, `IN` channels to `OUT`, with its bias and, unless `LINEAR`, its PReLU.
///
/// A workgroup is a `4 * PIXELS` by 8 tile of the region. Each thread holds `PIXELS` pixels along a
/// row by a quarter of the output channels, so a staged tap is read once for every `PIXELS` pixels
/// and a weight once for every `OUT / 4` channels. The input and the taps are staged `CHUNK`
/// channels at a time, as many as fit.
void conv<let IN : uint, let OUT : uint, let LINEAR : bool, let PIXELS : uint>(uint3 group, uint slot)
{
    const uint TILE_WIDE = 4 * PIXELS;
    const uint PATCH_WIDE = TILE_WIDE + 2;
    const uint PATCH = PATCH_WIDE * (TILE_TALL + 2);
    const uint FIT_PATCH = STAGED_PATCH / PATCH;
    const uint FIT_TAPS = STAGED_TAPS * 4 / (9 * OUT_MOST);
    const uint FIT = FIT_PATCH < FIT_TAPS ? FIT_PATCH : FIT_TAPS;
    // A divisor of every layer's channels.
    const uint CHUNK_MOST = FIT >= 12 ? 12 : FIT >= 8 ? 8 : FIT >= 6 ? 6 : 4;
    const uint CHUNK = IN < CHUNK_MOST ? IN : CHUNK_MOST;
    const uint SHARE = OUT / 4;
    const uint SHARE4 = SHARE / 4;
    const uint ROW4 = OUT / 4;
    const uint RUNS = PIXELS / 4;
    let pixels = slot % (THREADS / 4);
    let quarter = slot / (THREADS / 4);
    let row = pixels / 4;
    let first = (pixels % 4) * PIXELS;
    let left = group.x * TILE_WIDE;
    let top = group.y * TILE_TALL;

    // A channel each, across 4 of the thread's pixels.
    Cell4 sums[SHARE * RUNS];
    [ForceUnroll]
    for (uint n = 0; n < SHARE * RUNS; n++) { sums[n] = Cell4(Cell(0)); }

    for (uint from = 0; from < IN; from += CHUNK) {
        for (uint i = slot; i < CHUNK * PATCH; i += THREADS) {
            let p = i / CHUNK;
            let c = i % CHUNK;
            // The patch starts a pixel up and left of the tile, which is the ringed tensor's own
            // origin for that tile.
            let cell = (top + p / PATCH_WIDE) * (step.width + 2) + left + p % PATCH_WIDE;
            patch[c * PATCH + p] = Cell(given[times(cell, IN) + from + c]);
        }
        for (uint i = slot; i < 9 * CHUNK * ROW4; i += THREADS) {
            let n = i % ROW4;
            let row_of = i / ROW4;
            let at = step.weights_at + ((row_of / CHUNK) * IN + from + row_of % CHUNK) * OUT + n * 4;
            taps[i] = Cell4(float4(weights[at], weights[at + 1], weights[at + 2], weights[at + 3]));
        }
        GroupMemoryBarrierWithGroupSync();

        for (uint tap = 0; tap < 9; tap++) {
            let base = (row + tap / 3) * PATCH_WIDE + first + tap % 3;
            for (uint c = 0; c < CHUNK; c++) {
                Cell4 seen[RUNS];
                [ForceUnroll]
                for (uint r = 0; r < RUNS; r++) {
                    let at = c * PATCH + base + r * 4;
                    seen[r] = Cell4(patch[at], patch[at + 1], patch[at + 2], patch[at + 3]);
                }
                [ForceUnroll]
                for (uint n = 0; n < SHARE4; n++) {
                    let w = taps[(tap * CHUNK + c) * ROW4 + times(quarter, SHARE4) + n];
                    [ForceUnroll]
                    for (uint r = 0; r < RUNS; r++) {
                        let s = r * SHARE + n * 4;
                        sums[s] += seen[r] * w.x;
                        sums[s + 1] += seen[r] * w.y;
                        sums[s + 2] += seen[r] * w.z;
                        sums[s + 3] += seen[r] * w.w;
                    }
                }
            }
        }
        GroupMemoryBarrierWithGroupSync();
    }

    let y = top + row;
    [ForceUnroll]
    for (uint i = 0; i < PIXELS; i++) {
        let x = left + first + i;
        if (x >= step.width || y >= step.height) { continue; }
        let inside = in_frame(x, y);
        let cell = times(ringed(x, y), OUT) + quarter * SHARE;
        [ForceUnroll]
        for (uint n = 0; n < SHARE; n++) {
            let channel = quarter * SHARE + n;
            var value = float(sums[(i / 4) * SHARE + n][i % 4]) + weights[step.bias_at + channel];
            if (!LINEAR) { value = value >= 0.0 ? value : value * weights[step.slope_at + channel]; }
            made[cell + n] = Stored(inside ? value : 0.0);
        }
    }
}

#define LAYERS(pixels)                                                                              \
    [shader("compute")]                                                                             \
    [numthreads(THREADS, 1, 1)]                                                                     \
    void conv_4_48_##pixels(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)                    \
    {                                                                                               \
        conv<4, 48, false, pixels>(group, slot);                                                    \
    }                                                                                               \
    [shader("compute")]                                                                             \
    [numthreads(THREADS, 1, 1)]                                                                     \
    void conv_48_48_##pixels(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)                   \
    {                                                                                               \
        conv<48, 48, false, pixels>(group, slot);                                                   \
    }                                                                                               \
    [shader("compute")]                                                                             \
    [numthreads(THREADS, 1, 1)]                                                                     \
    void conv_48_16_##pixels(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)                   \
    {                                                                                               \
        conv<48, 16, true, pixels>(group, slot);                                                    \
    }

LAYERS(4)
LAYERS(8)

/// The last layer's 16 channels as the four planes at twice the size, added to the input's planes
/// and unstabilised, into the upscaled mosaic: the region's interior only, one thread a packed
/// pixel.
[shader("compute")]
[numthreads(16, 8, 1)]
void leave(uint3 at : SV_DispatchThreadID)
{
    if (at.x >= step.inner_width || at.y >= step.inner_height) { return; }
    let x = at.x + step.inner_left;
    let y = at.y + step.inner_top;
    let cell = ringed(x, y);
    let fx = uint(int(x) + step.left);
    let fy = uint(int(y) + step.top);
    let out_width = step.frame_width * 4;
    for (uint c = 0; c < 4; c++) {
        let plane = float(planes[times(cell, step.planes_channels) + c]);
        for (uint sub = 0; sub < 4; sub++) {
            let stabilised = float(given[cell * 16 + c * 4 + sub]) + plane;
            let root = max(stabilised / stabilising.scales[c] + stabilising.roots[c], 0.0);
            let light = root * root - stabilising.floors[c];
            let px = (fx * 2 + sub % 2) * 2 + c % 2;
            let py = (fy * 2 + sub / 2) * 2 + c / 2;
            upscaled[py * out_width + px] = light;
        }
    }
}
