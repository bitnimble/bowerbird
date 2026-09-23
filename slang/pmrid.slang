// PMRID's forward pass, one dispatch a layer, over a flat arena of NCHW planes.
//
// The network is four kinds of layer and nothing else (`models/net_torch.py`): a dense
// convolution, a depthwise one, a transposed 2x2 upsample, and a residual add. Each entry point
// here is one of those, and `Params` says where its input, weights and output sit.

struct Params {
    uint in_width;
    uint in_height;
    uint in_channels;
    uint out_width;
    uint out_height;
    uint out_channels;
    uint kernel;
    uint stride;
    /// Zero padding, as `nn.Conv2d` pads: the same count on every side.
    uint pad;
    /// 1 to follow the layer with a ReLU.
    uint relu;
    /// Where each of the four arrays starts, in floats.
    uint input_at;
    uint output_at;
    uint weights_at;
    uint bias_at;
    /// The residual's other side, for `add`.
    uint skip_at;
    /// 1 to add `skip_at`'s sample to this layer's own before the ReLU, which is the residual a
    /// separate dispatch would otherwise read both tensors back to do.
    uint fused;
};

[vk::binding(20, 0)] ConstantBuffer<Params> pc;
[vk::binding(0, 0)] StructuredBuffer<Cell> weights;
/// What the weights and every accumulation are.
///
/// **`half` works, and costs, which is why this says `float`.** With the 1x1 layers running as a
/// matrix multiply and [`depthwise`] therefore the most expensive kind, the frame goes from 359ms
/// to 410 and the depthwise layers alone from 131 to 406 - but that measured the arithmetic, the
/// weights, the staging in shared memory *and* the arena all going to `half` at once, so it says
/// nothing about the traffic on its own. [`Stored`] is the traffic alone.
typealias Cell = float;

/// What an arena cell is held in, apart from what it is computed in.
///
/// **`float` unless the build says `half`, and it says so for the tensor arm alone.** `build.rs`
/// compiles this a second time with `STORED` defined, which is the module a device with the
/// cooperative-matrix kernels takes, since those read and write the arena in place and a matrix
/// unit's operands are `half`. Everywhere else - a page, and the software adapter - keeps `float`,
/// because `half` would ask every one of them for `shader-f16`, and the WGSL pass alone does not
/// move for it on an RTX 3080, since it waits on its loads' latency rather than their size.
#ifndef STORED
#define STORED float
#endif
typealias Stored = STORED;

[vk::binding(1, 0)] RWStructuredBuffer<Stored> arena;

Cell fetch(uint at)
{
    return Cell(arena[at]);
}

void put(uint at, Cell value)
{
    arena[at] = Stored(value);
}

/// A plane's sample, or zero outside it, which is what a zero-padded convolution reads.
Cell sample(uint channel, int y, int x)
{
    if (x < 0 || y < 0 || x >= int(pc.in_width) || y >= int(pc.in_height)) { return Cell(0.0); }
    let plane = pc.in_width * pc.in_height;
    return fetch(pc.input_at + channel * plane + uint(y) * pc.in_width + uint(x));
}

void store(uint channel, uint2 xy, Cell value)
{
    let plane = pc.out_width * pc.out_height;
    let at = channel * plane + xy.y * pc.out_width + xy.x;
    let sum = pc.fused != 0 ? value + fetch(pc.skip_at + at) : value;
    put(pc.output_at + at, pc.relu != 0 ? max(sum, Cell(0.0)) : sum);
}

void write(uint3 id, Cell value)
{
    store(id.z, id.xy, value);
}

bool outside(uint3 id)
{
    return id.x >= pc.out_width || id.y >= pc.out_height || id.z >= pc.out_channels;
}

/// One workgroup's shape, in output pixels. 256 threads is the most a workgroup may have.
///
/// **What it trades.** The weights a workgroup stages are read once however many threads it has, so
/// a wider group spreads that read further - and the patch the depthwise stages overlaps more of
/// itself. Against that, a group is scheduled whole, so an edge tile wastes more of one. Measured
/// again after the unrolling, in case the staging had stopped paying for it: 128 threads is 429ms
/// over the frame against this shape's 421, and the shape at a fixed count does not matter (32x8
/// measured the same as 16x16).
static const uint WIDE = 16;
static const uint TALL = 16;
static const uint THREADS = WIDE * TALL;

/// The two spatial convolutions there are: the first layer's 4 in and 16 out, and the last's 16 in
/// and 4 out. `SPATIAL_WIDEST` bounds either side.
static const uint SPATIAL_WIDEST = 16;
static const uint SPATIAL_TAPS = SPATIAL_WIDEST * 4 * 9;
static const uint SPATIAL_K = 3;
static const uint SPATIAL_SPAN_WIDE = WIDE + SPATIAL_K - 1;
static const uint SPATIAL_SPAN_TALL = TALL + SPATIAL_K - 1;
static const uint SPATIAL_PATCH = SPATIAL_SPAN_WIDE * SPATIAL_SPAN_TALL;
/// Input channels staged between two barriers, which both layers' inputs divide by.
static const uint SPATIAL_AT_ONCE = 4;
static const uint SPATIAL_CARRIED = (SPATIAL_AT_ONCE * SPATIAL_PATCH + THREADS - 1) / THREADS;

/// The weights as `[in][3][3][OUT]`, four output channels a vector: the one each tap multiplies
/// into four accumulators with a single read.
groupshared float4 spatial_weights[SPATIAL_TAPS];
groupshared Cell spatial_patch[SPATIAL_AT_ONCE * SPATIAL_PATCH];

/// `nn.Conv2d(IN, OUT, 3, stride=1, pad=1)`, weights `[out][in][3][3]`: every output channel of
/// one pixel a thread.
///
/// **Only two layers, but they are the full-size planes at either end, and the arithmetic is what
/// they cost.** A thread's taps are `IN * 9 * OUT` multiplies, each wanting a weight out of shared
/// memory: read one at a time from an index a uniform `in_channels` has to be multiplied into,
/// that is a read and an address for every multiply. With both sides constants every index is,
/// and held tap-major the weights for four outputs are one vector read.
void spatial<let OUT : uint, let IN : uint>(uint3 id, uint3 group, uint3 local, uint slot)
{
    const uint TAPS = IN * SPATIAL_K * SPATIAL_K;
    for (uint i = slot; i < OUT * TAPS; i += THREADS) {
        let o = i / TAPS;
        spatial_weights[(i % TAPS) * (OUT / 4) + o / 4][o % 4] = weights[pc.weights_at + i];
    }
    var sums: Cell[OUT];
    [ForceUnroll]
    for (uint o = 0; o < OUT; o++) { sums[o] = weights[pc.bias_at + o]; }

    let origin = int2(int(group.x * WIDE) - 1, int(group.y * TALL) - 1);
    [ForceUnroll]
    for (uint first = 0; first < IN; first += SPATIAL_AT_ONCE) {
        // Every load asked for before any is stored: stored as each arrives, each waits out the
        // one before it.
        Cell held[SPATIAL_CARRIED];
        [ForceUnroll]
        for (uint j = 0; j < SPATIAL_CARRIED; j++) {
            let i = j * THREADS + slot;
            let within = i % SPATIAL_PATCH;
            held[j] = Cell(0.0);
            if (i < SPATIAL_AT_ONCE * SPATIAL_PATCH) {
                held[j] = sample(
                    first + i / SPATIAL_PATCH,
                    origin.y + int(within / SPATIAL_SPAN_WIDE),
                    origin.x + int(within % SPATIAL_SPAN_WIDE));
            }
        }
        // Held until every thread has read the last round's patch, and on the first, until the
        // weights are staged.
        GroupMemoryBarrierWithGroupSync();
        [ForceUnroll]
        for (uint j = 0; j < SPATIAL_CARRIED; j++) {
            let i = j * THREADS + slot;
            if (i < SPATIAL_AT_ONCE * SPATIAL_PATCH) { spatial_patch[i] = held[j]; }
        }
        GroupMemoryBarrierWithGroupSync();
        [ForceUnroll]
        for (uint c = 0; c < SPATIAL_AT_ONCE; c++) {
            [ForceUnroll]
            for (uint ky = 0; ky < SPATIAL_K; ky++) {
                [ForceUnroll]
                for (uint kx = 0; kx < SPATIAL_K; kx++) {
                    let value = spatial_patch[
                        c * SPATIAL_PATCH + (local.y + ky) * SPATIAL_SPAN_WIDE + local.x + kx];
                    let tap = ((first + c) * SPATIAL_K + ky) * SPATIAL_K + kx;
                    [ForceUnroll]
                    for (uint q = 0; q < OUT / 4; q++) {
                        let four = spatial_weights[tap * (OUT / 4) + q];
                        sums[q * 4] += value * four.x;
                        sums[q * 4 + 1] += value * four.y;
                        sums[q * 4 + 2] += value * four.z;
                        sums[q * 4 + 3] += value * four.w;
                    }
                }
            }
        }
    }
    // Every thread has to reach every barrier above, so one outside the plane leaves only here.
    if (id.x >= pc.out_width || id.y >= pc.out_height) { return; }
    [ForceUnroll]
    for (uint o = 0; o < OUT; o++) { store(o, id.xy, sums[o]); }
}

/// [`spatial`] for each of the network's two, named by what they write and dispatched with z of 1.
#define SPATIAL(name, out, in)                                      \
    [shader("compute")]                                             \
    [numthreads(WIDE, TALL, 1)]                                     \
    void name(                                                      \
        uint3 id : SV_DispatchThreadID,                             \
        uint3 group : SV_GroupID,                                   \
        uint3 local : SV_GroupThreadID,                             \
        uint slot : SV_GroupIndex)                                  \
    {                                                               \
        spatial<out, in>(id, group, local, slot);                   \
    }

SPATIAL(spatial_16, 16, 4)
SPATIAL(spatial_4, 4, 16)

/// Input channels a step, which is what both of [`tiled`]'s staged tiles are one step deep in, and
/// the largest tile any of its shapes asks for, which is what they are sized by.
///
/// **Every shape stages into these same two arrays, so no shape may be larger than this**, and what
/// that costs is measured rather than assumed. A workgroup reserves what the widest shape needs
/// whichever shape it is, and the reservation is how many workgroups an SM can hold: adding a tile
/// 64 channels tall takes the reservation from 10KB to 12 and the 32-channel shapes with it, which
/// measured 290 to 309ms over the frame where the same shape at 10KB measures 283.
static const uint STEP = 16;
static const uint WIDEST_TILE_ROWS = 32;
static const uint WIDEST_TILE_COLS = 128;

groupshared Cell tile_weights[WIDEST_TILE_ROWS * STEP];
groupshared Cell tile_samples[STEP * WIDEST_TILE_COLS];

void store_flat(uint channel, uint at_in_plane, Cell value)
{
    let at = channel * (pc.out_width * pc.out_height) + at_in_plane;
    let sum = pc.fused != 0 ? value + fetch(pc.skip_at + at) : value;
    put(pc.output_at + at, pc.relu != 0 ? max(sum, Cell(0.0)) : sum);
}

/// A 1x1 convolution as what it is: `out = W * X`, `out_channels` by pixels accumulated over
/// `in_channels`, with both operands staged and a tile of the answer held in registers.
///
/// **Shaped like the matrix multiply it is.** Each sample is read once for `MICRO_ROWS` channels
/// and each weight once for `MICRO_COLS` pixels, out of shared memory, so the same traffic carries
/// `MICRO_ROWS * MICRO_COLS` multiplies, where a thread a pixel would run at what memory can feed
/// it.
///
/// **A shape per layer, because the network's planes differ by 256x.** Half of these convolutions
/// are at the two deepest levels, where a plane is 1024 or 4096 pixels: a tile 128 pixels wide
/// leaves eight of them across, and a workgroup count in the low hundreds is a card two thirds
/// idle. The shapes below are the same tile cut narrower for those, and the host times all of them
/// against each layer rather than deciding from the shape - 246ms over the frame's 1x1 layers where
/// the best single shape is 264.
void tiled<
    let MICRO_ROWS : uint,
    let MICRO_COLS : uint,
    let GEMM_WIDE : uint,
    let GEMM_TALL : uint>(uint3 group, uint3 local, uint slot)
{
    const uint TILE_ROWS = GEMM_TALL * MICRO_ROWS;
    const uint TILE_COLS = GEMM_WIDE * MICRO_COLS;
    const uint THREADS_HERE = GEMM_WIDE * GEMM_TALL;
    let plane = pc.out_width * pc.out_height;
    let first_row = group.y * TILE_ROWS;
    let first_col = group.x * TILE_COLS;

    var sums: Cell[MICRO_ROWS * MICRO_COLS];
    [ForceUnroll]
    for (uint r = 0; r < MICRO_ROWS; r++) {
        let row = first_row + local.y * MICRO_ROWS + r;
        let bias = row < pc.out_channels ? weights[pc.bias_at + row] : Cell(0.0);
        [ForceUnroll]
        for (uint n = 0; n < MICRO_COLS; n++) { sums[r * MICRO_COLS + n] = bias; }
    }

    for (uint c = 0; c < pc.in_channels; c += STEP) {
        for (uint i = slot; i < TILE_ROWS * STEP; i += THREADS_HERE) {
            let row = first_row + i / STEP;
            tile_weights[i] = row < pc.out_channels
                ? weights[pc.weights_at + row * pc.in_channels + c + i % STEP]
                : Cell(0.0);
        }
        for (uint i = slot; i < STEP * TILE_COLS; i += THREADS_HERE) {
            let column = first_col + i % TILE_COLS;
            tile_samples[i] = column < plane
                ? fetch(pc.input_at + (c + i / TILE_COLS) * plane + column)
                : Cell(0.0);
        }
        GroupMemoryBarrierWithGroupSync();

        [ForceUnroll]
        for (uint k = 0; k < STEP; k++) {
            Cell a[MICRO_ROWS];
            [ForceUnroll]
            for (uint r = 0; r < MICRO_ROWS; r++) {
                a[r] = tile_weights[(local.y * MICRO_ROWS + r) * STEP + k];
            }
            Cell b[MICRO_COLS];
            [ForceUnroll]
            for (uint n = 0; n < MICRO_COLS; n++) {
                // A thread's columns are `GEMM_WIDE` apart rather than adjacent, so that a warp
                // reads one straight run of shared memory here and one of the picture at the store,
                // neither of them across a bank the thread beside it wants.
                b[n] = tile_samples[k * TILE_COLS + n * GEMM_WIDE + local.x];
            }
            [ForceUnroll]
            for (uint r = 0; r < MICRO_ROWS; r++) {
                [ForceUnroll]
                for (uint n = 0; n < MICRO_COLS; n++) { sums[r * MICRO_COLS + n] += a[r] * b[n]; }
            }
        }
        // Held off until every thread has finished reading what the next step overwrites.
        GroupMemoryBarrierWithGroupSync();
    }

    [ForceUnroll]
    for (uint r = 0; r < MICRO_ROWS; r++) {
        let row = first_row + local.y * MICRO_ROWS + r;
        if (row >= pc.out_channels) { break; }
        [ForceUnroll]
        for (uint n = 0; n < MICRO_COLS; n++) {
            let column = first_col + n * GEMM_WIDE + local.x;
            if (column < plane) { store_flat(row, column, sums[r * MICRO_COLS + n]); }
        }
    }
}

/// A tile of [`tiled`], dispatched over `pixels / (wide * cols)` in x and
/// `out_channels / (tall * rows)` in y, which the host has to match, and only where `in_channels`
/// is a multiple of `STEP`.
///
/// **These five differ in the tile, not in what a thread carries.** Sixteen accumulators is where
/// the thread stops paying: thirty-two of them over the same 32x128 tile - as 128 threads of 4x8,
/// and as 128 of 8x4 - were measured fastest for one of the 43 layers and for none of them, and
/// left the frame where it was.
#define POINTWISE(name, rows, cols, wide, tall)                       \
    [shader("compute")]                                               \
    [numthreads(wide, tall, 1)]                                       \
    void name(                                                        \
        uint3 group : SV_GroupID,                                     \
        uint3 local : SV_GroupThreadID,                               \
        uint slot : SV_GroupIndex)                                    \
    {                                                                 \
        tiled<rows, cols, wide, tall>(group, local, slot);            \
    }

POINTWISE(pointwise, 4, 4, 32, 8)
POINTWISE(pointwise_narrow, 2, 4, 32, 8)
POINTWISE(pointwise_short, 4, 2, 32, 8)
POINTWISE(pointwise_stub, 4, 1, 32, 8)
POINTWISE(pointwise_small, 2, 2, 32, 8)

/// The input patch one workgroup of [`depthwise`] reads, which its threads overlap almost entirely:
/// at stride 2 and a 5x5 kernel that is 36x36 samples for 256 outputs, where reading them a thread
/// at a time is 25 each.
static const uint PATCH_WIDE = WIDE * 2 + 4;
static const uint PATCH_TALL = TALL * 2 + 4;
groupshared Cell patch[PATCH_WIDE * PATCH_TALL];

/// `nn.Conv2d(in, in, k, stride, pad, groups=in, bias=False)`, weights `[in][1][k][k]`.
///
/// **The network only ever asks for a kernel of three or five at a stride of one or two**, and
/// each is its own instantiation of [`depthwise_as`]: with the size and stride uniforms, the taps
/// keep their counters and index arithmetic and the staging divides by a uniform span, where as
/// constants the one is a straight line of multiplies and the other a multiply and a shift.
[shader("compute")]
[numthreads(WIDE, TALL, 1)]
void depthwise(
    uint3 id : SV_DispatchThreadID,
    uint3 group : SV_GroupID,
    uint3 local : SV_GroupThreadID,
    uint slot : SV_GroupIndex)
{
    switch (pc.kernel * 10 + pc.stride) {
    case 52: depthwise_as<5, 2>(id, group, local, slot); break;
    case 51: depthwise_as<5, 1>(id, group, local, slot); break;
    case 32: depthwise_as<3, 2>(id, group, local, slot); break;
    default: depthwise_as<3, 1>(id, group, local, slot); break;
    }
}

void depthwise_as<let K : uint, let S : uint>(uint3 id, uint3 group, uint3 local, uint slot)
{
    const uint SPAN = WIDE * S + K - 1;
    const uint ROWS = TALL * S + K - 1;
    // Where the workgroup's own patch starts, which every thread's window is inside.
    let origin = int2(int(group.x * WIDE * S) - int(K / 2), int(group.y * TALL * S) - int(K / 2));
    for (uint i = slot; i < SPAN * ROWS; i += THREADS) {
        patch[i] = sample(id.z, origin.y + int(i / SPAN), origin.x + int(i % SPAN));
    }
    GroupMemoryBarrierWithGroupSync();
    if (outside(id)) { return; }

    let taps = pc.weights_at + id.z * K * K;
    var sum = Cell(0.0);
    [ForceUnroll]
    for (uint ky = 0; ky < K; ky++) {
        [ForceUnroll]
        for (uint kx = 0; kx < K; kx++) {
            let value = patch[(local.y * S + ky) * SPAN + local.x * S + kx];
            sum += value * weights[taps + ky * K + kx];
        }
    }
    write(id, sum);
}

/// `nn.ConvTranspose2d(in, out, kernel_size=2, stride=2)`, weights `[in][out][2][2]`.
///
/// At this kernel and stride the transpose is a gather rather than a scatter: an output sample
/// takes the one input sample above it and the tap its own parity picks.
///
/// **A thread takes the whole 2x2, which is what makes the gather worth doing.** All four of those
/// outputs read the same input sample and differ only in which tap they take, so a thread each
/// read the picture four times over. Dispatched over the *input's* pixels for that reason, which
/// the host has to match.
[shader("compute")]
[numthreads(WIDE, TALL, 1)]
void upsample(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= pc.in_width || id.y >= pc.in_height || id.z >= pc.out_channels) { return; }
    let plane = pc.in_width * pc.in_height;
    let from = pc.input_at + id.y * pc.in_width + id.x;
    let bias = weights[pc.bias_at + id.z];
    var s0 = bias; var s1 = bias; var s2 = bias; var s3 = bias;
    // Four channels a step: what the loop waits on is the load, and the next one cannot start
    // until it is asked for.
    var c = 0u;
    for (; c + 4 <= pc.in_channels; c += 4) {
        let a0 = fetch(from + c * plane);
        let a1 = fetch(from + (c + 1) * plane);
        let a2 = fetch(from + (c + 2) * plane);
        let a3 = fetch(from + (c + 3) * plane);
        let taps = pc.weights_at + (c * pc.out_channels + id.z) * 4;
        let step = pc.out_channels * 4;
        s0 += a0 * weights[taps] + a1 * weights[taps + step]
            + a2 * weights[taps + 2 * step] + a3 * weights[taps + 3 * step];
        s1 += a0 * weights[taps + 1] + a1 * weights[taps + step + 1]
            + a2 * weights[taps + 2 * step + 1] + a3 * weights[taps + 3 * step + 1];
        s2 += a0 * weights[taps + 2] + a1 * weights[taps + step + 2]
            + a2 * weights[taps + 2 * step + 2] + a3 * weights[taps + 3 * step + 2];
        s3 += a0 * weights[taps + 3] + a1 * weights[taps + step + 3]
            + a2 * weights[taps + 2 * step + 3] + a3 * weights[taps + 3 * step + 3];
    }
    for (; c < pc.in_channels; c++) {
        let value = fetch(from + c * plane);
        let taps = pc.weights_at + (c * pc.out_channels + id.z) * 4;
        s0 += value * weights[taps];
        s1 += value * weights[taps + 1];
        s2 += value * weights[taps + 2];
        s3 += value * weights[taps + 3];
    }
    let corner = uint2(id.x * 2, id.y * 2);
    if (corner.x < pc.out_width && corner.y < pc.out_height) { store(id.z, corner, s0); }
    if (corner.x + 1 < pc.out_width && corner.y < pc.out_height) {
        store(id.z, corner + uint2(1, 0), s1);
    }
    if (corner.x < pc.out_width && corner.y + 1 < pc.out_height) {
        store(id.z, corner + uint2(0, 1), s2);
    }
    if (corner.x + 1 < pc.out_width && corner.y + 1 < pc.out_height) {
        store(id.z, corner + uint2(1, 1), s3);
    }
}

[shader("compute")]
[numthreads(WIDE, TALL, 1)]
void add(uint3 id : SV_DispatchThreadID)
{
    if (outside(id)) { return; }
    let plane = pc.out_width * pc.out_height;
    let at = id.z * plane + id.y * pc.out_width + id.x;
    write(id, fetch(pc.input_at + at) + fetch(pc.skip_at + at));
}

/// What the photograph has to become before the network will read it, and what its answer has to
/// become before the pipeline will.
///
/// **The network was trained on another sensor's photosites, and this is the whole of the
/// distance.** Three transforms, in this order, all of them undone again on the way out: the
/// conditioning's white balance divided back out, because the gains were applied to a reading the
/// network expects raw; the 2x2 CFA site split into four planes, which is the shape its four
/// channels are; and the k-sigma transform of its own calibration, which maps this frame's fitted
/// noise onto the variance its weights were trained at.
/// **The two vectors are first so that this lays out with no padding at all.** A uniform block
/// aligns a `uint4` to sixteen bytes, so a run of scalars ahead of one leaves a hole the host would
/// have to know about; leading with the vectors and following with an exact sixteen scalars is 96
/// bytes either side, field for field.
struct Edges {
    /// Where each of the four planes sits in the 2x2 as `(y % 2) * 2 + x % 2`, and the conditioning
    /// gain that position carries. By plane rather than by position so that every index into a
    /// thread's own four values is a constant and they stay in registers.
    uint4 position_at;
    float4 gain_at;
    /// The whole mosaic's stride, and where in it this window starts. Both of the origin's
    /// coordinates are even, so the window's 2x2 sites are the frame's own.
    uint stride;
    uint origin_x;
    uint origin_y;
    /// The window, whose width and height are both even.
    uint width;
    uint height;
    /// The part of the window [`reap`] writes back, in window pixels. The rest is the halo a tile
    /// is grown by: the network's receptive field reaches far enough that a tile denoised without
    /// one disagrees with its neighbour along the seam.
    uint keep_x;
    uint keep_y;
    uint keep_width;
    uint keep_height;
    /// Where in the arena the network's input and its prediction sit, in cells.
    uint input_at;
    uint predicted_at;
    /// The k-sigma transform onto the network's own anchor, and the range it was trained over.
    float cvt_k;
    float cvt_b;
    float scale;
    /// How much of what the network found to keep, split into the light a site agrees on and the
    /// colour it does not.
    float luma;
    float colour;
};

[vk::binding(21, 0)] ConstantBuffer<Edges> edges;
[vk::binding(2, 0)] StructuredBuffer<float> mosaic;
/// Where [`reap`] writes, which is never what [`sow`] reads: a window's halo reaches into the tiles
/// either side of its own, and read back from a plane already denoised, the network would be handed
/// a neighbour's answer as though it were the photograph.
[vk::binding(3, 0)] RWStructuredBuffer<float> filtered;

/// The mosaic as four stabilised planes, which is what [`spatial`] reads on the first layer.
[shader("compute")]
[numthreads(WIDE, TALL, 1)]
void sow(uint3 id : SV_DispatchThreadID)
{
    let wide = edges.width / 2;
    let tall = edges.height / 2;
    if (id.x >= wide || id.y >= tall) { return; }
    let site = wide * tall;
    [ForceUnroll]
    for (uint plane = 0; plane < 4; plane++) {
        let position = edges.position_at[plane];
        let read = (edges.origin_y + id.y * 2 + position / 2) * edges.stride
            + edges.origin_x + id.x * 2 + position % 2;
        // The conditioning divided every photosite by the largest coefficient and multiplied it by
        // its own, so dividing that back out is what the sensor read, up to the black level.
        let raw = clamp(mosaic[read] / edges.gain_at[plane], 0.0, 1.0);
        let at = plane * site + id.y * wide + id.x;
        put(edges.input_at + at, (raw * edges.cvt_k + edges.cvt_b) * edges.scale);
    }
}

/// The prediction back over the photograph, at the strength the two sliders ask for.
///
/// **What the network found is a residual, and its two halves are not equally good.** `pred = inp +
/// x`, so subtracting the input recovers what it did; and of that, what the four photosites of a
/// site agree on is its reading of the light, where what they disagree on is its reading of the
/// colour. The colour half survives every strength. The light half is what melts a twig, so the two
/// answer to separate sliders rather than to one.
[shader("compute")]
[numthreads(WIDE, TALL, 1)]
void reap(uint3 id : SV_DispatchThreadID)
{
    let wide = edges.width / 2;
    let tall = edges.height / 2;
    if (id.x >= wide || id.y >= tall) { return; }
    // Only this tile's own interior: the halo either side of it was denoised so that the interior
    // had context, and the neighbouring tile writes that ground itself.
    let inside = id.x * 2 >= edges.keep_x && id.x * 2 < edges.keep_x + edges.keep_width
        && id.y * 2 >= edges.keep_y && id.y * 2 < edges.keep_y + edges.keep_height;
    if (!inside) { return; }
    let site = wide * tall;
    let at = id.y * wide + id.x;

    float found[4];
    float was[4];
    var light = 0.0;
    [ForceUnroll]
    for (uint plane = 0; plane < 4; plane++) {
        was[plane] = fetch(edges.input_at + plane * site + at);
        found[plane] = fetch(edges.predicted_at + plane * site + at) - was[plane];
        light += found[plane] * 0.25;
    }

    [ForceUnroll]
    for (uint plane = 0; plane < 4; plane++) {
        let kept = was[plane] + light * edges.luma + (found[plane] - light) * edges.colour;
        let raw = (kept / edges.scale - edges.cvt_b) / edges.cvt_k;
        let position = edges.position_at[plane];
        let write = (edges.origin_y + id.y * 2 + position / 2) * edges.stride
            + edges.origin_x + id.x * 2 + position % 2;
        filtered[write] = raw * edges.gain_at[plane];
    }
}
