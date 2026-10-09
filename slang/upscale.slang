// The 2x mosaic upscaler's forward pass (`models/upscaler`'s `MultiScale`): the noisy mosaic's
// packed planes through 3x3 convolutions at full, half and quarter resolution, each under a PReLU,
// joined back up by 1x1 rises, bilinear doublings and skips, whose last layer's 16 channels are the
// four planes at twice the size over the input's own, unstabilised, blended back toward the input
// as the Detail sliders say and grained.
//
// Every tensor is NHWC over a region of its level with a ring of zeros around it, so a tap off the
// region reads zero without a branch. A level's frame is the photo's planes padded to a multiple of
// 4, and positions outside it are written zero, which is `nn.Conv2d`'s own padding at its edge.
// Every region's corner is in the frame's own coordinates, so a tile computes what the whole frame
// would wherever it sits.

import times;

struct Step {
    /// The region the step writes, in its level's pixels, and where its corner sits in that level's
    /// frame.
    uint width;
    uint height;
    int left;
    int top;
    /// That level's frame, padded.
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
    /// The region of the other level a pool or a doubling reads.
    uint other_width;
    uint other_height;
    int other_left;
    int other_top;
    /// The photo's planes before the padding.
    uint real_width;
    uint real_height;
    /// Where `mosaic` lies in the photo's mosaic, and its extent.
    uint window_left;
    uint window_top;
    uint window_width;
    uint window_height;
    /// Where `upscaled` lies in the mosaic at twice the size, and its extent.
    uint out_left;
    uint out_top;
    uint out_width;
    uint out_height;
    /// A pool's, a rise's or a doubling's channels, in and out.
    uint channels;
    uint out_channels;
};

/// What the photo's planes are, in the network's order red, the green beside it, the other green,
/// blue: `models/training`'s `Stabiliser`, the conditioning's gains, where each sits in the 2x2, and
/// its fitted noise for the grain.
struct Photo {
    /// A plane `c` of light `x` is read as (sqrt(x + floors[c]) - roots[c]) * scales[c].
    float4 floors;
    float4 roots;
    float4 scales;
    float4 gains;
    uint4 positions;
    /// The fit's slope and floor over green's gain, as `noise_variance` reads them, and the share of
    /// that variance the grain adds.
    float alpha;
    float sigma_sq;
    float grain;
    /// How much of what the network found to keep, split into the light a site agrees on and the
    /// colour it does not.
    float luma;
    float colour;
    uint pad0;
    uint pad1;
    uint pad2;
};

#ifndef STORED
#define STORED float
#endif
typealias Stored = STORED;

[vk::binding(0, 0)] StructuredBuffer<float> weights;
[vk::binding(1, 0)] StructuredBuffer<Stored> given;
[vk::binding(2, 0)] RWStructuredBuffer<Stored> made;
/// [`pack`]'s planes for [`leave`], or the skip a doubling adds to.
[vk::binding(3, 0)] StructuredBuffer<Stored> aside;
[vk::binding(4, 0)] StructuredBuffer<float> mosaic;
[vk::binding(5, 0)] RWStructuredBuffer<float> upscaled;
[vk::binding(6, 0)] ConstantBuffer<Step> step;
[vk::binding(7, 0)] ConstantBuffer<Photo> photo;

/// A region pixel's place in a tensor `width` wide, past the ring.
uint ringed(uint x, uint y, uint width)
{
    return (y + 1) * (width + 2) + x + 1;
}

bool in_frame(uint x, uint y)
{
    let fx = int(x) + step.left;
    let fy = int(y) + step.top;
    return fx >= 0 && fy >= 0 && fx < int(step.frame_width) && fy < int(step.frame_height);
}

/// The input mosaic's planes, variance-stabilised as the network was trained on them. Past the
/// photo's last plane and inside the padded frame, the last plane again.
[shader("compute")]
[numthreads(16, 8, 1)]
void pack(uint3 at : SV_DispatchThreadID)
{
    if (at.x >= step.width || at.y >= step.height) { return; }
    let cell = times(ringed(at.x, at.y, step.width), step.planes_channels);
    let inside = in_frame(at.x, at.y);
    let px = min(uint(max(int(at.x) + step.left, 0)), step.real_width - 1);
    let py = min(uint(max(int(at.y) + step.top, 0)), step.real_height - 1);
    for (uint c = 0; c < step.planes_channels; c++) {
        var value = 0.0;
        if (c < 4 && inside) {
            let position = photo.positions[c];
            // Clamped to the window, which only a region's own margin reaches past.
            let mx = clamp(int(px * 2 + position % 2) - int(step.window_left), 0, int(step.window_width) - 1);
            let my = clamp(int(py * 2 + position / 2) - int(step.window_top), 0, int(step.window_height) - 1);
            let light = mosaic[times(uint(my), step.window_width) + uint(mx)];
            value = (sqrt(max(light + photo.floors[c], 0.0)) - photo.roots[c]) * photo.scales[c];
        }
        made[cell + c] = Stored(value);
    }
}

static const uint TILE_TALL = 8;
static const uint THREADS = 128;
static const uint OUT_MOST = 48;
static const uint PIXELS = 8;

/// What a layer computes in: the tensors' own type, so `half` math where they are held in `half`.
typealias Cell = Stored;
typealias Cell4 = vector<Cell, 4>;

// Sized for both tiles, together under the 16KB of workgroup memory every WebGPU device offers.
static const uint STAGED_PATCH = 1360 * 4 / sizeof(Cell);
static const uint STAGED_TAPS = 648 * 4 / sizeof(Cell);
groupshared Cell patch[STAGED_PATCH];
groupshared Cell4 taps[STAGED_TAPS];

/// One 3x3 layer, `IN` channels to `OUT`, with its bias and, unless `LINEAR`, its PReLU, the slice
/// of at most `OUT_MOST` output channels `group.z` names.
///
/// A workgroup is a `4 * PIXELS` by 8 tile of the region. Each thread holds `PIXELS` pixels along a
/// row by a quarter of the slice's channels, so a staged tap is read once for every `PIXELS` pixels
/// and a weight once for every quarter. The input and the taps are staged `CHUNK` channels at a
/// time, as many as fit.
void conv<let IN : uint, let OUT : uint, let LINEAR : bool>(uint3 group, uint slot)
{
    const uint SLICE = OUT < OUT_MOST ? OUT : OUT_MOST;
    const uint TILE_WIDE = 4 * PIXELS;
    const uint PATCH_WIDE = TILE_WIDE + 2;
    const uint PATCH = PATCH_WIDE * (TILE_TALL + 2);
    const uint FIT_PATCH = STAGED_PATCH / PATCH;
    const uint FIT_TAPS = STAGED_TAPS * 4 / (9 * OUT_MOST);
    const uint FIT = FIT_PATCH < FIT_TAPS ? FIT_PATCH : FIT_TAPS;
    // A divisor of every layer's channels.
    const uint CHUNK_MOST = FIT >= 12 ? 12 : FIT >= 8 ? 8 : FIT >= 6 ? 6 : 4;
    const uint CHUNK = IN < CHUNK_MOST ? IN : CHUNK_MOST;
    const uint SHARE = SLICE / 4;
    const uint SHARE4 = SHARE / 4;
    const uint ROW4 = SLICE / 4;
    const uint RUNS = PIXELS / 4;
    let first_channel = times(group.z, SLICE);
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
            let cell = times(top + p / PATCH_WIDE, step.width + 2) + left + p % PATCH_WIDE;
            patch[c * PATCH + p] = Cell(given[times(cell, IN) + from + c]);
        }
        for (uint i = slot; i < 9 * CHUNK * ROW4; i += THREADS) {
            let n = i % ROW4;
            let row_of = i / ROW4;
            let at = step.weights_at + times((row_of / CHUNK) * IN + from + row_of % CHUNK, OUT) + first_channel + n * 4;
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
        let cell = times(ringed(x, y, step.width), OUT) + first_channel + times(quarter, SHARE);
        [ForceUnroll]
        for (uint n = 0; n < SHARE; n++) {
            let channel = first_channel + times(quarter, SHARE) + n;
            var value = float(sums[(i / 4) * SHARE + n][i % 4]) + weights[step.bias_at + channel];
            if (!LINEAR) { value = value >= 0.0 ? value : value * weights[step.slope_at + channel]; }
            made[cell + n] = Stored(inside ? value : 0.0);
        }
    }
}

#define CONV(name, in, out, linear)                                                                 \
    [shader("compute")]                                                                             \
    [numthreads(THREADS, 1, 1)]                                                                     \
    void name(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)                                  \
    {                                                                                               \
        conv<in, out, linear>(group, slot);                                                         \
    }

CONV(conv_4_48, 4, 48, false)
CONV(conv_48_48, 48, 48, false)
CONV(conv_48_96, 48, 96, false)
CONV(conv_96_96, 96, 96, false)
CONV(conv_96_192, 96, 192, false)
CONV(conv_192_192, 192, 192, false)
CONV(conv_48_16, 48, 16, true)

/// A level at half the resolution of the one `given` holds: each pixel the mean of the 2x2 it
/// covers, four channels a thread.
[shader("compute")]
[numthreads(16, 8, 1)]
void pool(uint3 at : SV_DispatchThreadID)
{
    let quads = step.channels / 4;
    let x = at.x / quads;
    let channel = (at.x % quads) * 4;
    let y = at.y;
    if (x >= step.width || y >= step.height) { return; }
    let cell = times(ringed(x, y, step.width), step.channels) + channel;
    let inside = in_frame(x, y);
    [ForceUnroll]
    for (uint k = 0; k < 4; k++) {
        var sum = 0.0;
        [ForceUnroll]
        for (uint q = 0; q < 4; q++) {
            let fine = times(ringed(x * 2 + q % 2, y * 2 + q / 2, step.other_width), step.channels);
            sum += float(given[fine + channel + k]);
        }
        made[cell + k] = Stored(inside ? sum * 0.25 : 0.0);
    }
}

/// A 1x1 layer, `channels` to `out_channels` and linear, at the coarser of two levels: what the
/// finer one's doubling reads.
[shader("compute")]
[numthreads(16, 8, 1)]
void rise(uint3 at : SV_DispatchThreadID)
{
    let quads = step.out_channels / 4;
    let x = at.x / quads;
    let channel = (at.x % quads) * 4;
    let y = at.y;
    if (x >= step.width || y >= step.height) { return; }
    let from = times(ringed(x, y, step.width), step.channels);
    var sums = float4(
        weights[step.bias_at + channel], weights[step.bias_at + channel + 1],
        weights[step.bias_at + channel + 2], weights[step.bias_at + channel + 3]);
    for (uint i = 0; i < step.channels; i++) {
        let seen = float(given[from + i]);
        let w = step.weights_at + times(i, step.out_channels) + channel;
        sums += seen * float4(weights[w], weights[w + 1], weights[w + 2], weights[w + 3]);
    }
    let cell = times(ringed(x, y, step.width), step.out_channels) + channel;
    [ForceUnroll]
    for (uint k = 0; k < 4; k++) { made[cell + k] = Stored(sums[k]); }
}

/// One axis of `F.interpolate(scale_factor=2, mode="bilinear", align_corners=False)` from the
/// coarser level: the two coarse pixels a fine one reads and the weight of the second, clamped to
/// the coarse frame as torch clamps and then to the coarse region, which only a margin reaches past.
int2 doubled(int fine, int coarse_frame, int coarse_left, uint coarse_extent, out float second)
{
    let k = fine >> 1;
    var a = (fine & 1) == 0 ? k - 1 : k;
    var b = a + 1;
    second = (fine & 1) == 0 ? 0.75 : 0.25;
    a = clamp(a, 0, coarse_frame - 1);
    b = clamp(b, 0, coarse_frame - 1);
    let last = int(coarse_extent) - 1;
    return int2(clamp(a - coarse_left, 0, last), clamp(b - coarse_left, 0, last));
}

/// The coarser level's rise doubled, added to this level's skip, four channels a thread.
[shader("compute")]
[numthreads(16, 8, 1)]
void double_add(uint3 at : SV_DispatchThreadID)
{
    let quads = step.channels / 4;
    let x = at.x / quads;
    let channel = (at.x % quads) * 4;
    let y = at.y;
    if (x >= step.width || y >= step.height) { return; }
    let cell = times(ringed(x, y, step.width), step.channels) + channel;
    if (!in_frame(x, y)) {
        [ForceUnroll]
        for (uint k = 0; k < 4; k++) { made[cell + k] = Stored(0.0); }
        return;
    }
    float wx;
    float wy;
    let xs = doubled(int(x) + step.left, int(step.frame_width / 2), step.other_left, step.other_width, wx);
    let ys = doubled(int(y) + step.top, int(step.frame_height / 2), step.other_top, step.other_height, wy);
    let c00 = times(ringed(uint(xs.x), uint(ys.x), step.other_width), step.channels) + channel;
    let c10 = times(ringed(uint(xs.y), uint(ys.x), step.other_width), step.channels) + channel;
    let c01 = times(ringed(uint(xs.x), uint(ys.y), step.other_width), step.channels) + channel;
    let c11 = times(ringed(uint(xs.y), uint(ys.y), step.other_width), step.channels) + channel;
    [ForceUnroll]
    for (uint k = 0; k < 4; k++) {
        let top_row = float(given[c00 + k]) * (1.0 - wx) + float(given[c10 + k]) * wx;
        let bottom_row = float(given[c01 + k]) * (1.0 - wx) + float(given[c11 + k]) * wx;
        made[cell + k] = Stored(float(aside[cell + k]) + top_row * (1.0 - wy) + bottom_row * wy);
    }
}

float unstabilised(float stabilised, uint c)
{
    let root = max(stabilised / photo.scales[c] + photo.roots[c], 0.0);
    return root * root - photo.floors[c];
}

/// A standard normal for a place, the same wherever a tile puts it: two uniforms off a PCG hash of
/// the place, through Box-Muller.
float normal_at(uint x, uint y)
{
    var state = times(x, 747796405u) + times(y, 2891336453u) + 0x9e3779b9u;
    state = times(state, 747796405u) + 2891336453u;
    var word = times((state >> ((state >> 28u) + 4u)) ^ state, 277803737u);
    let a = (word >> 22u) ^ word;
    state = times(state, 747796405u) + 2891336453u;
    word = times((state >> ((state >> 28u) + 4u)) ^ state, 277803737u);
    let b = (word >> 22u) ^ word;
    let u1 = (float(a >> 8) + 0.5) / 16777216.0;
    let u2 = float(b >> 8) / 16777216.0;
    return sqrt(-2.0 * log(u1)) * cos(6.28318530718 * u2);
}

/// The last layer's 16 channels as the four planes at twice the size, added to the input's planes
/// and unstabilised, blended back toward the input, grained, into the upscaled mosaic: the region's
/// interior only, one thread a packed pixel.
///
/// The grain is one factor over each 2x2 of the upscale, which brightens or darkens it without
/// moving its colour: `models/upscaler`'s `add_luma_noise`, spread as that quad's photosites would be
/// by the photo's own noise.
[shader("compute")]
[numthreads(16, 8, 1)]
void leave(uint3 at : SV_DispatchThreadID)
{
    if (at.x >= step.inner_width || at.y >= step.inner_height) { return; }
    let x = at.x + step.inner_left;
    let y = at.y + step.inner_top;
    let fx = uint(int(x) + step.left);
    let fy = uint(int(y) + step.top);
    if (fx >= step.real_width || fy >= step.real_height) { return; }
    let cell = ringed(x, y, step.width);
    float was[4];
    [ForceUnroll]
    for (uint c = 0; c < 4; c++) {
        was[c] = float(aside[times(cell, step.planes_channels) + c]);
    }
    [ForceUnroll]
    for (uint sub = 0; sub < 4; sub++) {
        float input[4];
        float found[4];
        var light = 0.0;
        [ForceUnroll]
        for (uint c = 0; c < 4; c++) {
            input[c] = unstabilised(was[c], c);
            found[c] = unstabilised(float(given[cell * 16 + c * 4 + sub]) + was[c], c) - input[c];
            light += found[c] * 0.25;
        }
        let ux = fx * 2 + sub % 2;
        let uy = fy * 2 + sub / 2;
        float kept[4];
        var level = 0.0;
        var variance = 0.0;
        [ForceUnroll]
        for (uint c = 0; c < 4; c++) {
            kept[c] = input[c] + light * photo.luma + (found[c] - light) * photo.colour;
            let raw = kept[c] / photo.gains[c];
            level += raw * 0.25;
            variance += (photo.alpha * max(raw, 0.0) + photo.sigma_sq) * 0.25;
        }
        let spread = sqrt(photo.grain * variance * 0.25);
        let factor = 1.0 + normal_at(ux, uy) * spread / max(level, 1e-6);
        [ForceUnroll]
        for (uint c = 0; c < 4; c++) {
            let position = photo.positions[c];
            let sx = int(ux * 2 + position % 2) - int(step.out_left);
            let sy = int(uy * 2 + position / 2) - int(step.out_top);
            if (sx < 0 || sy < 0 || sx >= int(step.out_width) || sy >= int(step.out_height)) { continue; }
            upscaled[times(uint(sy), step.out_width) + uint(sx)] = kept[c] * factor;
        }
    }
}
