// PMRID's forward pass, one dispatch a layer, over a flat arena of NCHW planes.
//
// A prototype: what a published learned denoiser does to our photographs, before anything is
// designed around one. Nothing in the pipeline dispatches this - `native/rawshim/examples/pmrid.rs`
// does, over weights `bun run get:pmrid` unpacks. The question it was written to answer is what the
// picture looks like; what it costs is the second question, and the constants below carry what each
// answer measured over a 61MP frame.
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
/// What the weights, the arena and every accumulation are. `PMRID_CELL` in `examples/pmrid.rs` is
/// the host's half of this and has to agree.
///
/// **`half` works, and costs, which is why this says `float`.** Halving the traffic gains nothing
/// because these kernels are not bandwidth-bound: what they wait on is the latency of the dependent
/// loads in the channel loop, and `half` does not shorten that. It is worth measuring again after
/// any change to their shape, and it has been - with the 1x1 layers running as a matrix multiply and
/// [`depthwise`] therefore the most expensive kind, which is when halving its reads should have paid
/// most, the frame goes from 359ms to 410 and the depthwise layers alone from 131 to 406. The
/// picture is the same either way, a mean of 0.12 codes of 255 apart and 5 at the worst pixel.
typealias Cell = float;

[vk::binding(1, 0)] RWStructuredBuffer<Cell> arena;

/// A plane's sample, or zero outside it, which is what a zero-padded convolution reads.
Cell sample(uint channel, int y, int x)
{
    if (x < 0 || y < 0 || x >= int(pc.in_width) || y >= int(pc.in_height)) { return Cell(0.0); }
    let plane = pc.in_width * pc.in_height;
    return arena[pc.input_at + channel * plane + uint(y) * pc.in_width + uint(x)];
}

void store(uint channel, uint2 xy, Cell value)
{
    let plane = pc.out_width * pc.out_height;
    let at = channel * plane + xy.y * pc.out_width + xy.x;
    let sum = pc.fused != 0 ? value + arena[pc.skip_at + at] : value;
    arena[pc.output_at + at] = pc.relu != 0 ? max(sum, Cell(0.0)) : sum;
}

void write(uint3 id, Cell value)
{
    store(id.z, id.xy, value);
}

bool outside(uint3 id)
{
    return id.x >= pc.out_width || id.y >= pc.out_height || id.z >= pc.out_channels;
}

/// How many output channels one thread of [`dense`] carries.
///
/// **What makes this the lever.** Every one of these convolutions reads its input sample once and
/// uses it once, and the channel loop's loads depend on nothing but the loop, so the kernel spends
/// its time waiting on them rather than on arithmetic - which is what `half` failing to buy
/// anything established. Carrying four output channels reads that sample once for all four, so the
/// loads fall to a quarter and four accumulators advance independently while each is outstanding.
/// The weights it reads instead are the same for every pixel in the workgroup, so they come from
/// cache rather than from memory.
///
/// **Blocking the other way round loses, and it says what the ceiling is.** A thread takes one
/// pixel. Carrying two would halve the shared reads - the loop spends one on every multiply, and
/// every thread in the workgroup reads the *same* weight - and it measured 319ms against 311 over
/// the frame's dense layers. Those reads were never the limit; the dependent loads' latency is, and
/// what hides that is warps in flight, which is what a second pixel's sixteen live registers take
/// away. Same reason eight channels a thread lost, and the same reason `half` bought nothing.
static const uint BLOCK = 4;

/// The widest input a 1x1 convolution here has, which is what [`staged`] is sized for.
static const uint WIDEST = 512;

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

/// The `BLOCK` rows of the weight matrix this workgroup needs, read once between its threads.
///
/// **Why the weights and not the picture.** A 1x1 convolution reads `in_channels` samples and
/// `BLOCK * in_channels` weights a thread, so the weights are the larger traffic by the blocking
/// factor - and where each thread's samples are its own, the weights are the same for every one of
/// them. Read once here, they are read from memory a `THREADS`th as often.
groupshared Cell staged[BLOCK * WIDEST];

/// `nn.Conv2d(in, out, k, stride, pad)`, weights `[out][in][k][k]`.
///
/// Dispatched over `out_channels / BLOCK` in z, which the host has to match.
[shader("compute")]
[numthreads(WIDE, TALL, 1)]
void dense(uint3 id : SV_DispatchThreadID, uint slot : SV_GroupIndex)
{
    let first = id.z * BLOCK;
    // The staging below is a whole-workgroup act, so a thread outside the frame has to reach the
    // barrier with the rest before it leaves.
    let mine = id.x < pc.out_width && id.y < pc.out_height && first < pc.out_channels;
    if (pc.kernel == 1 && pc.in_channels <= WIDEST) {
        let rows = min(BLOCK, pc.out_channels - first);
        for (uint i = slot; i < rows * pc.in_channels; i += THREADS) {
            staged[i] = weights[pc.weights_at + first * pc.in_channels + i];
        }
        GroupMemoryBarrierWithGroupSync();
        if (!mine) { return; }

        let plane = pc.in_width * pc.in_height;
        let at = pc.input_at + id.y * pc.in_width + id.x;
        var ones: Cell[BLOCK];
        for (uint o = 0; o < BLOCK; o++) { ones[o] = weights[pc.bias_at + first + o]; }
        // Eight channels a step, so the next loads are in flight while the first is waited on -
        // which is the whole of what this kernel was short of. Two measured 454ms, four 339ms,
        // eight 311ms and sixteen 307ms, which is not worth twice the unrolled loop.
        //
        // Asking for the *next* step's eight before multiplying this one's - which is what took the
        // cooperative-matrix kernel from 43ms to 37.6 - loses here, 314ms against 305: eight more
        // live registers cost more warps than the overlap buys, the same ceiling two pixels a
        // thread ran into.
        //
        // Named rather than an array of them, which is not a style: an array indexed by a loop
        // lands in scratch memory instead of in registers, and the version that did read 779ms
        // against this one's 454.
        var c = 0u;
        for (; c + 8 <= pc.in_channels; c += 8) {
            let a0 = arena[at + c * plane];
            let a1 = arena[at + (c + 1) * plane];
            let a2 = arena[at + (c + 2) * plane];
            let a3 = arena[at + (c + 3) * plane];
            let a4 = arena[at + (c + 4) * plane];
            let a5 = arena[at + (c + 5) * plane];
            let a6 = arena[at + (c + 6) * plane];
            let a7 = arena[at + (c + 7) * plane];
            for (uint o = 0; o < BLOCK; o++) {
                let row = o * pc.in_channels + c;
                ones[o] += a0 * staged[row] + a1 * staged[row + 1]
                    + a2 * staged[row + 2] + a3 * staged[row + 3]
                    + a4 * staged[row + 4] + a5 * staged[row + 5]
                    + a6 * staged[row + 6] + a7 * staged[row + 7];
            }
        }
        for (; c < pc.in_channels; c++) {
            let value = arena[at + c * plane];
            for (uint o = 0; o < BLOCK; o++) {
                ones[o] += value * staged[o * pc.in_channels + c];
            }
        }
        for (uint o = 0; o < BLOCK; o++) {
            if (first + o >= pc.out_channels) { break; }
            store(first + o, id.xy, ones[o]);
        }
        return;
    }
    if (!mine) { return; }
    let top = int(id.y * pc.stride) - int(pc.pad);
    let left = int(id.x * pc.stride) - int(pc.pad);

    var sums: Cell[BLOCK];
    for (uint o = 0; o < BLOCK; o++) {
        sums[o] = weights[pc.bias_at + first + o];
    }
    let taps = pc.kernel * pc.kernel;

    for (uint c = 0; c < pc.in_channels; c++) {
        for (uint ky = 0; ky < pc.kernel; ky++) {
            for (uint kx = 0; kx < pc.kernel; kx++) {
                let value = sample(c, top + int(ky), left + int(kx));
                let tap = ky * pc.kernel + kx;
                for (uint o = 0; o < BLOCK; o++) {
                    sums[o] += value
                        * weights[pc.weights_at + ((first + o) * pc.in_channels + c) * taps + tap];
                }
            }
        }
    }

    for (uint o = 0; o < BLOCK; o++) {
        if (first + o >= pc.out_channels) { break; }
        store(first + o, id.xy, sums[o]);
    }
}

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
    let sum = pc.fused != 0 ? value + arena[pc.skip_at + at] : value;
    arena[pc.output_at + at] = pc.relu != 0 ? max(sum, Cell(0.0)) : sum;
}

/// A 1x1 convolution as what it is: `out = W * X`, `out_channels` by pixels accumulated over
/// `in_channels`, with both operands staged and a tile of the answer held in registers.
///
/// **Why this exists beside [`dense`]'s own 1x1 path.** That one is a matrix-vector product a
/// thread: one pixel, `BLOCK` channels, so every sample it reads pays for `BLOCK` multiplies and the
/// kernel runs at what memory can feed it. This reads each sample once for `MICRO_ROWS` channels
/// *and* each weight once for `MICRO_COLS` pixels, out of shared memory, so the same traffic carries
/// `MICRO_ROWS * MICRO_COLS` of them. The layer is a matrix multiply either way; only this one is
/// shaped like one.
///
/// **A shape per layer, because the network's planes differ by 256x.** Half of these convolutions
/// are at the two deepest levels, where a plane is 1024 or 4096 pixels: a tile 128 pixels wide
/// leaves eight of them across, and a workgroup count in the low hundreds is a card two thirds
/// idle. The shapes below are the same tile cut narrower for those, and the host times all of them
/// against each layer rather than deciding from the shape - 246ms over the frame's 1x1 layers where
/// the best single shape is 264 and `dense` is 305.
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
                ? arena[pc.input_at + (c + i / TILE_COLS) * plane + column]
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

/// One thread's window over the staged patch, with the kernel's size known at compile time.
///
/// **The size has to be a constant for the taps to be a straight line of multiplies.** `pc.kernel`
/// is a uniform, so a loop bounded by it keeps its counters, its compare and its index arithmetic
/// for all twenty-five taps - and the caller below knows the network only ever asks for three or
/// five.
Cell tapped<let K : uint>(uint top, uint left, uint span, uint taps)
{
    var sum = Cell(0.0);
    [ForceUnroll]
    for (uint ky = 0; ky < K; ky++) {
        [ForceUnroll]
        for (uint kx = 0; kx < K; kx++) {
            sum += patch[(top + ky) * span + left + kx] * weights[taps + ky * K + kx];
        }
    }
    return sum;
}

/// `nn.Conv2d(in, in, k, stride, pad, groups=in, bias=False)`, weights `[in][1][k][k]`.
[shader("compute")]
[numthreads(WIDE, TALL, 1)]
void depthwise(
    uint3 id : SV_DispatchThreadID,
    uint3 group : SV_GroupID,
    uint3 local : SV_GroupThreadID,
    uint slot : SV_GroupIndex)
{
    // Where the workgroup's own patch starts, which every thread's window is inside.
    let origin = int2(
        int(group.x * WIDE * pc.stride) - int(pc.pad),
        int(group.y * TALL * pc.stride) - int(pc.pad));
    let span = WIDE * pc.stride + pc.kernel - 1;
    let rows = TALL * pc.stride + pc.kernel - 1;
    // A flat run over the threads, which divides by a span that is not a constant. Walking the
    // patch as a rectangle instead removes those divisions and is slower - 431ms against 423 - since
    // the patch is wider than a workgroup and a row of it then takes three partly masked passes
    // where the flat run reads a straight line.
    for (uint i = slot; i < span * rows; i += THREADS) {
        patch[i] = sample(id.z, origin.y + int(i / span), origin.x + int(i % span));
    }
    GroupMemoryBarrierWithGroupSync();
    if (outside(id)) { return; }

    let top = local.y * pc.stride;
    let left = local.x * pc.stride;
    let taps = pc.weights_at + id.z * pc.kernel * pc.kernel;
    switch (pc.kernel) {
    case 5:
        write(id, tapped<5>(top, left, span, taps));
        break;
    case 3:
        write(id, tapped<3>(top, left, span, taps));
        break;
    default:
        var sum = Cell(0.0);
        for (uint ky = 0; ky < pc.kernel; ky++) {
            for (uint kx = 0; kx < pc.kernel; kx++) {
                sum += patch[(top + ky) * span + left + kx] * weights[taps + ky * pc.kernel + kx];
            }
        }
        write(id, sum);
        break;
    }
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
    // Four channels a step, for the reason `dense` takes eight: what the loop waits on is the
    // load, and the next one cannot start until it is asked for.
    var c = 0u;
    for (; c + 4 <= pc.in_channels; c += 4) {
        let a0 = arena[from + c * plane];
        let a1 = arena[from + (c + 1) * plane];
        let a2 = arena[from + (c + 2) * plane];
        let a3 = arena[from + (c + 3) * plane];
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
        let value = arena[from + c * plane];
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
    write(id, arena[pc.input_at + at] + arena[pc.skip_at + at]);
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
[vk::binding(2, 0)] RWStructuredBuffer<float> mosaic;

/// The mosaic as four stabilised planes, which is what [`dense`] reads on the first layer.
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
        arena[edges.input_at + at] = Cell((raw * edges.cvt_k + edges.cvt_b) * edges.scale);
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
        was[plane] = float(arena[edges.input_at + plane * site + at]);
        found[plane] = float(arena[edges.predicted_at + plane * site + at]) - was[plane];
        light += found[plane] * 0.25;
    }

    [ForceUnroll]
    for (uint plane = 0; plane < 4; plane++) {
        let kept = was[plane] + light * edges.luma + (found[plane] - light) * edges.colour;
        let raw = (kept / edges.scale - edges.cvt_b) / edges.cvt_k;
        let position = edges.position_at[plane];
        let write = (edges.origin_y + id.y * 2 + position / 2) * edges.stride
            + edges.origin_x + id.x * 2 + position % 2;
        mosaic[write] = raw * edges.gain_at[plane];
    }
}
