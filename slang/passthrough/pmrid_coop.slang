// PMRID's separable convolutions on a cooperative-matrix multiply, which is what reaches a tensor
// core.
//
// **Why this is not in `pmrid.slang` and not WGSL.** A 1x1 convolution over an NCHW arena is a
// matrix multiply already: the weights are `[out][in]` row-major, an activation plane is `[in]`
// rows of `pixels` columns, and the output is `[out]` rows of the same - so `C = A * B` with no
// gather and no reshape. Saying that to the hardware wants `OpCooperativeMatrixMulAddKHR`, which
// WGSL has no spelling for, so this compiles to SPIR-V and is handed to the driver as it stands.
//
// **Two hosts dispatch it, and only one of them is a picture.** `native/rawshim/src/pmrid.rs` runs
// [`separable`] or [`pointwise`] for each 1x1 layer of a rendition, on the device wgpu already
// opened and over the `half` arena the WGSL beside it holds, where a browser has neither the
// instruction nor a way to pass a driver its own language and takes the WGSL pass instead.
// `native/rawshim/examples/coopmat.rs` is the measurement the multiply's shapes at the bottom were
// swept by, on a Vulkan device of its own, over the same layer list.
//
// **Two languages out of it, because a cooperative matrix is reached through the driver's own.**
// `build.rs` compiles this to SPIR-V for Vulkan and to MSL for Metal, where the same op spells
// `simdgroup_matrix`. What differs is `FRAGMENT`: Vulkan's multiply is 16x16 on the parts the sweep
// ran on, and Metal has 8x8 and nothing else, so the fragment is a define the build sets and the
// host holds a copy of.
//
// **The Metal arm is a weaker trade than the Vulkan one, and the reason is the hardware under the
// instruction.** An Ampere `OpCooperativeMatrixMulAddKHR` reaches a pipe the lanes cannot, which is
// why it is worth holding the arena in `half` to get at. Through M4 an Apple GPU has no such pipe:
// `simdgroup_matrix` runs on the same FP16 ALUs the rest of the shader does, and what it buys is
// the blocked loads and the thirty-two lanes sharing operands rather than a throughput multiple.
// What these kernels spend is almost all around the multiply rather than in it (the end of this
// header), and that is the same work on both, so on Apple the arm can lose. **Measure it before
// trusting it**, and where it loses, the answer is `passthrough` answering `None` for Metal.
//
// **Nothing here reaches a neural accelerator of any kind, and no shader does.** The ANE is
// CoreML's alone - it takes a compiled graph rather than a kernel, and a frame would have to leave
// the device this pipeline holds it on. M5 put matrix hardware in the GPU's own cores, but it is
// reached through Metal 4's tensor ops, which is neither a shader nor anything wgpu exposes;
// nothing says this instruction lowers onto it.
//
// The host refuses a device whose reported configurations do not include the shape it asks for.
//
// The entry points after the rendition's are one multiply in every shape worth trying - how many
// fragments of rows and of columns a subgroup carries, and how many subgroups share a workgroup -
// because which of them is fastest is a measurement rather than a derivation, and the sweep times
// them all.
//
// **What this kernel is short of, measured rather than argued.** Two of those entry points are the
// ends of a roofline: `bound_wide_math` is the best shape with its loads hoisted out of the depth
// loop, and `bound_load` is the same loads with no multiplies. Over the frame's pointwise layers the
// whole thing is 54ms, the multiplies alone are 40ms and the loads alone 19ms - and those loads run
// at 1.8TB/s, which is past what this card's memory can do and therefore mostly cache.
//
// So it is the multiplies, and `bound_wide_math4` says which kind: twice the arithmetic in the same
// steps costs 8% more time, so the matrix units are idle waiting rather than saturated. What they
// wait on is the accumulator - each multiply into one depends on the multiply before it - so what
// buys anything here is *independent* chains. Eight of them: two fragments of rows by two of
// columns over two steps of the depth accumulated apart, two subgroups to a workgroup, is 29.0ms
// where the same tile with one chain in it is 34.7. Sixteen is too many - four fragments of rows by
// four of columns is 40.8 - which is the register ceiling arriving, since a chain is an accumulator
// and a loop that reads ahead holds two sets of fragments besides.
//
// **A shape that cannot take every layer is measured with another behind it, and which one that is
// decides the ranking.** Eight of this network's 43 pointwise layers are too shallow or too narrow
// for a tile that reads two steps of the depth at once, so they run on the shallowest shape that
// fits. With the *slowest* such shape behind them every deep arm reported 43 to 46ms and the small
// tiles appeared to win; with the fastest, the deep arms win by four milliseconds. The host picks
// the fastest, and those eight layers are a fifth of the network - which is how much of a
// measurement the arm that is not being measured can be.
//
// **What did get past it was none of those: it was how the matrices are stored.** A 16x16 fragment
// of a plane thousands of columns wide is sixteen rows of 32 bytes, each in a line of its own, so
// every fragment load asks for 512 bytes as sixteen scattered pieces. Held a fragment at a time
// instead - `blocked_multiply` below - the same load is four lines, and the frame's pointwise
// layers go from 54ms to 43, which is within 7% of what the multiplies cost with no memory at all.
// The `half` arms gain most, because they were the ones with the least arithmetic to hide it
// behind: 65ms to 43, which all but closes the gap to the `float` ones.
//
// **The two ways out that were named first both close on this hardware, and both were checked
// rather than assumed.** More work per multiply would want a larger fragment: the host prints every
// configuration the device offers, and the largest `f16` one is the 16x16x16 used here - a deeper
// instruction exists only for `u8`/`i8` at 16x16x32, which the network would have to be quantised
// for. Nothing wider is available because the driver has `VK_KHR_cooperative_matrix` and
// `VK_NV_cooperative_matrix` but not `VK_NV_cooperative_matrix2`, whose dimensions are the
// device's to choose.
//
// An accumulator in `half` is the instruction's own loss and the kernel's gain, which reads as a
// contradiction until the registers are counted. `bound_half_math` against `bound_wide_math` is the
// same loads and the same count of multiplies with only the accumulator's type between them, and it
// is 47.7ms against 40.0 - the emitted SPIR-V is two `OpCooperativeMatrixMulAddKHR` over all-`half`
// types with no conversion anywhere near them, so the instruction is simply slower on this driver.
// In a loop that reads ahead it wins anyway, 29.8ms against 41.2 for the same shape in `float`,
// because such a loop holds two sets of fragments live and a `half` accumulator is half the
// registers - which is the same trade the tile size makes, from the other side.
//
// **Two levers with an arithmetic case for them, both measured and both refused.** Tiles batched
// into one dispatch: a layer's columns are pixels and its weights are the same for every tile, so
// seven tiles are one multiply seven times as wide, and it takes the dispatch floor from 5.6ms to
// 0.8. The arms get *slower* - 33.7ms to 34.8 - so that floor was never additive; the dispatches of
// a run with work in them overlap the work. The host keeps the knob (`coopmat <tiles> <batch>`)
// because it is what showed `bound_load` to be dispatch-bound: the loads alone are 10.6ms batched,
// not the 19 an unbatched run reports.
//
// And one shape for the whole network is not a constraint a host has. Every layer timed against
// every shape it divides by, fastest kept, is 26.7ms - two below the best single shape, over seven
// tiles. What the same layers cost a rendition either way is at the end of this header.
//
// **Where the sweep stops.** At a tile of two fragments by two over two steps of the depth,
// everything the loop can be arranged as lands within a millisecond: blocked and not pipelined is
// 29.9ms, pipelined with the two steps folded into one chain is 30.0, pipelined with them apart is
// 29.9, and a second subgroup in the workgroup is 29.1. Four subgroups, eight, and four fragments
// of rows are all 29 to 32. So whatever the remaining time is, it is not the shape of this loop,
// and a row added to the table below is worth adding only if it is a different question.
//
// One of those was asked and answered: a workgroup's subgroups sit on columns, so each reads its
// own slice of the picture, and `DOWN` puts them on rows instead, where they all read the same
// fragments of it. 30.6ms at best against 29.0, and a workgroup that is four fragments tall cannot
// take a 32-channel layer, so more of the network falls back as well. What the subgroups share is
// not what this kernel is waiting on.
//
// **What it is worth in a rendition, which has little to do with the multiply.** On an RTX 3080,
// by `examples/pmrid.rs <raw> <out> whole`: a 24MP frame is 6 tiles and the whole denoise is 55ms
// with these kernels against 131 on the WGSL pass, and a 61MP frame is 12 tiles, 143ms against
// 311. With every separable layer on [`separable`], they were 66ms of a 91ms frame, and with the
// multiplies in them left out 65: the matrix units are all but idle, and what the layers cost is
// feeding them - staging the patch, the depthwise, the barriers between the two, and writing the
// answer back, in roughly equal parts. That is what [`separable`] is shaped around. A tenth of the
// frame is not a layer at all: allocating the 384MB arena is 5.5ms and freeing it about 4, which a
// queue of renders pays once rather than a frame (`pmrid::hold_arenas`).
//
// **And the feeding is bound by how many workgroups a multiprocessor holds, from both sides at
// once.** `coopmat registers` reads what the driver compiled: `separable_64` is 79 registers a
// thread and 15KB of shared memory, and on Ampere either alone allows six workgroups. So shrinking
// one moves nothing - a smaller `reach` and answer, 7KB of shared memory rather than 15, measured
// the same - where growing either costs straight away (`spread`). The registers are the
// compiler's budget more than the kernel's need: a depthwise of half the run, or on `half2` two
// channels at a time, still compiled to 80, and only no depthwise at all came in under it (61).
// Fewer barriers a channel measured the same, and so did workgroups of 128 or 256 rows
// ([`COOP_ROWS`] in `pmrid.rs`), sixteen loads in flight rather than eight (slower), and tiles
// 16 pixels by 4, whose rows are whole sectors.

using namespace linalg;

struct Shape {
    /// `out_channels`, `pixels` and `in_channels` of the layer, which are M, N and K.
    uint rows;
    uint columns;
    uint depth;
    /// Where each matrix starts in its buffer, in elements.
    uint weights_at;
    uint samples_at;
    uint out_at;
    /// The arena tensors a layer reads and writes, and the one a residual adds.
    uint plane_at;
    uint into_at;
    uint skip_at;
    uint bias_at;
    /// 1 rectifies what [`answer`] writes, 2 adds `skip_at` to it first.
    uint after;
    /// The depthwise half of a [`separable`] layer: its input plane's size, the output's width
    /// (`columns` over it is the height), its kernel and stride, and where its taps are in
    /// `biases`.
    uint in_width;
    uint in_height;
    uint out_width;
    uint kernel;
    uint stride;
    uint spread_at;
};

[vk::push_constant] ConstantBuffer<Shape> pc;
[vk::binding(0, 0)] StructuredBuffer<half> weights;
/// `Stored` in `slang/pmrid.slang`, as the module this arm runs beside is compiled.
typealias Stored = half;

/// The forward pass's own arena, where a layer's input comes from and its answer goes back to.
[vk::binding(1, 0)] RWStructuredBuffer<Stored> arena;
/// The network's weights as the host stores them, read here for the depthwise taps and the biases.
[vk::binding(2, 0)] StructuredBuffer<float> biases;
/// The sweep's own matrices, which a rendition never binds.
///
/// **After the rendition's bindings, never among them.** wgpu's Metal backend numbers buffers by
/// their place in the layout and slangc by their binding, so a rendition's layout with a gap in it
/// would bind every buffer after the gap one slot off.
[vk::binding(3, 0)] RWStructuredBuffer<half> samples;
[vk::binding(4, 0)] RWStructuredBuffer<half> predicted;
[vk::binding(5, 0)] RWStructuredBuffer<float> predicted_wide;

#ifndef FRAGMENT
#define FRAGMENT 16
#endif

static const uint FRAG = FRAGMENT;
static const uint LANES = 32;

typealias FragA = CoopMat<half, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixA>;
typealias FragB = CoopMat<half, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixB>;

/// The whole multiply, for an accumulator of type `T` written into `into`.
///
/// A subgroup carries `TALL` fragments of output rows by `SPAN` of columns, and `GANGS` subgroups
/// side by side make up the workgroup - so a workgroup covers `TALL * FRAG` rows and
/// `GANGS * SPAN * FRAG` columns, which is what the host dispatches over.
///
/// **What the shape trades.** Every accumulator is live across the whole `depth` loop, so
/// `TALL * SPAN` of them is the register cost; against that, `TALL` divides how many times the
/// activation plane is read (a layer reads it `rows / (TALL * FRAG)` times over) and `SPAN`
/// divides how often a row of the weights is. Both also shrink the dispatch, and this network's
/// deepest layers are 1024 pixels wide, where there is not much of one to lose.
/// **`DEEP` is how many steps of the depth are read before any of them is multiplied**, which is
/// the same lever the WGSL pass needed: what a step waits on is its loads, and the next one cannot
/// start until it is asked for. A layer's in-channels have to divide by `DEEP` fragments, which the
/// host checks.
void multiply<
    T : __BuiltinFloatingPointType,
    let TALL : uint,
    let SPAN : uint,
    let GANGS : uint,
    let DEEP : uint>(uint3 group, uint slot, RWStructuredBuffer<T> into)
{
    typealias Acc = CoopMat<T, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator>;

    let gang = slot / LANES;
    let row = group.y * (TALL * FRAG);
    let column = group.x * (GANGS * SPAN * FRAG) + gang * (SPAN * FRAG);

    var sums: Acc[TALL * SPAN];
    [ForceUnroll]
    for (uint i = 0; i < TALL * SPAN; i++) { sums[i] = Acc(T(0)); }

    for (uint k = 0; k < pc.depth; k += DEEP * FRAG) {
        FragA a[DEEP * TALL];
        FragB b[DEEP * SPAN];
        [ForceUnroll]
        for (uint d = 0; d < DEEP; d++) {
            [ForceUnroll]
            for (uint t = 0; t < TALL; t++) {
                a[d * TALL + t] = FragA.Load<CoopMatMatrixLayout.RowMajor>(
                    weights,
                    pc.weights_at + (row + t * FRAG) * pc.depth + k + d * FRAG,
                    pc.depth);
            }
            [ForceUnroll]
            for (uint w = 0; w < SPAN; w++) {
                b[d * SPAN + w] = FragB.Load<CoopMatMatrixLayout.RowMajor>(
                    samples,
                    pc.samples_at + (k + d * FRAG) * pc.columns + column + w * FRAG,
                    pc.columns);
            }
        }
        [ForceUnroll]
        for (uint d = 0; d < DEEP; d++) {
            [ForceUnroll]
            for (uint t = 0; t < TALL; t++) {
                [ForceUnroll]
                for (uint w = 0; w < SPAN; w++) {
                    sums[t * SPAN + w] =
                        coopMatMulAdd<T, false>(a[d * TALL + t], b[d * SPAN + w], sums[t * SPAN + w]);
                }
            }
        }
    }

    [ForceUnroll]
    for (uint t = 0; t < TALL; t++) {
        [ForceUnroll]
        for (uint w = 0; w < SPAN; w++) {
            sums[t * SPAN + w].Store<CoopMatMatrixLayout.RowMajor>(
                into, pc.out_at + (row + t * FRAG) * pc.columns + column + w * FRAG, pc.columns);
        }
    }
}

/// Where the fragment holding `(row, column)` starts when a matrix is stored a fragment at a time.
///
/// **Row-major is what makes a fragment load sixteen transactions.** A 16x16 fragment of a plane
/// that is thousands of columns wide is sixteen rows of 32 bytes, each in its own line - so the
/// load asks for 512 bytes and moves at whatever a scattered read costs. Stored this way the same
/// fragment is 512 contiguous bytes, and the load is four lines.
uint fragment_at(uint row, uint column, uint columns)
{
    return ((row / FRAG) * (columns / FRAG) + column / FRAG) * (FRAG * FRAG);
}

static const uint SEPARABLE_GANGS = 4;
static const uint SEPARABLE_THREADS = LANES * SEPARABLE_GANGS;
static const uint PIXELS_WIDE = 8;
static const uint PIXELS_TALL = 8;
static const uint PIXELS = PIXELS_WIDE * PIXELS_TALL;
static const uint SPANS = PIXELS / FRAG;
/// The input a tile of the depthwise reads at the network's widest reach, stride 2 and 5x5.
static const uint REACH_WIDE = PIXELS_WIDE * 2 + 4;
static const uint REACH_TALL = PIXELS_TALL * 2 + 4;
/// The most rows of an answer a workgroup has, which `reach` holds for [`settle`].
static const uint ROWS_MOST = 64;
/// A row of `spread` and of the answer, padded so a fragment's rows do not share banks.
static const uint PADDED = PIXELS + 8;
static const uint IN_FLIGHT = 8;

static const uint REACHED_MOST = FRAG * REACH_WIDE * REACH_TALL;
static const uint ANSWERED_MOST = ROWS_MOST * PADDED;
groupshared half reach[REACHED_MOST > ANSWERED_MOST ? REACHED_MOST : ANSWERED_MOST];
/// One step of `FRAG` input channels' depthwise, which is all a pass between two barriers holds.
///
/// **Not more, though the barriers would halve.** Two steps a pass measured the same work in the
/// same time, and the second step's room here cost a workgroup a multiprocessor: 81ms a 24MP frame
/// with one step's room, 87 with two, 89 with four, on an RTX 3080 whatever the steps taken.
groupshared half spread[FRAG * PADDED];

/// Output pixels of one row a thread of the depthwise carries, and how many of those make a row.
static const uint RUN = FRAG * PIXELS / SEPARABLE_THREADS;
static const uint RUNS = PIXELS / RUN;

/// One thread's run of the depthwise, from `reach` into `spread`.
///
/// **A run of one channel rather than a pixel of any**, so the taps are read once into registers
/// and a row of `reach` once for all `RUN` pixels it reaches, where a thread a pixel reads both
/// again for every output.
void depthwise<let K : uint, let S : uint>(uint slot, uint reached, uint span, uint taps)
{
    let channel = slot / RUNS;
    let first = (slot % RUNS) * RUN;
    float tap[K * K];
    [ForceUnroll]
    for (uint i = 0; i < K * K; i++) { tap[i] = biases[taps + channel * K * K + i]; }
    float sums[RUN];
    [ForceUnroll]
    for (uint p = 0; p < RUN; p++) { sums[p] = 0.0; }
    [ForceUnroll]
    for (uint ky = 0; ky < K; ky++) {
        let at = channel * reached + ((first / PIXELS_WIDE) * S + ky) * span
            + (first % PIXELS_WIDE) * S;
        float line[(RUN - 1) * S + K];
        [ForceUnroll]
        for (uint i = 0; i < (RUN - 1) * S + K; i++) { line[i] = float(reach[at + i]); }
        [ForceUnroll]
        for (uint kx = 0; kx < K; kx++) {
            [ForceUnroll]
            for (uint p = 0; p < RUN; p++) { sums[p] += line[p * S + kx] * tap[ky * K + kx]; }
        }
    }
    [ForceUnroll]
    for (uint p = 0; p < RUN; p++) { spread[channel * PADDED + first + p] = half(sums[p]); }
}

/// The bias of the multiply's row `row`: `UP` says the rows are a 2x2 transposed convolution's,
/// `out_channels * 4` of them in `(channel, tap)` order over the *input's* pixels, rather than a
/// 1x1's output channels.
uint biased<let UP : bool>(uint row)
{
    return UP ? row / 4 : row;
}

/// Where the multiply's answer for row `row` at `(x, y)` lands in the output tensor.
///
/// An upsample's row is a channel and one of the four taps, and its `x` a pixel of the input, which
/// is an output pixel `(2x + tap % 2, 2y + tap / 2)` of a plane twice the input's size.
uint landing<let UP : bool>(uint row, uint x, uint y, uint out_width)
{
    if (!UP) { return row * pc.columns + y * out_width + x; }
    let wide = pc.in_width * 2;
    let across = (x % pc.in_width) * 2 + row % 2;
    let down = (x / pc.in_width) * 2 + (row % 4) / 2;
    return (row / 4) * wide * pc.in_height * 2 + down * wide + across;
}

/// The multiply's answer, held in `reach` a row of `PADDED` an output channel, into the arena with
/// the bias, the residual and the rectifier: `ROWS` channels from `row` over a tile `WIDE` pixels
/// across whose corner is `(left, top)` in a plane `out_width` by `out_height`.
///
/// **The residual is read `IN_FLIGHT` cells at a time before any is added**, for the reason
/// [`separable_as`] stages that way.
void answer<let ROWS : uint, let WIDE : uint, let UP : bool>(
    uint slot, uint row, uint left, uint top, uint out_width, uint out_height)
{
    let skipping = (pc.after & 2) != 0;
    for (uint from = 0; from < ROWS * PIXELS; from += IN_FLIGHT * SEPARABLE_THREADS) {
        float skipped[IN_FLIGHT];
        [ForceUnroll]
        for (uint j = 0; j < IN_FLIGHT; j++) {
            let i = from + j * SEPARABLE_THREADS + slot;
            let pixel = i % PIXELS;
            let x = left + pixel % WIDE;
            let y = top + pixel / WIDE;
            skipped[j] = 0.0;
            if (skipping && i < ROWS * PIXELS && x < out_width && y < out_height) {
                let cell = landing<UP>(row + i / PIXELS, x, y, out_width);
                skipped[j] = float(arena[pc.skip_at + cell]);
            }
        }
        [ForceUnroll]
        for (uint j = 0; j < IN_FLIGHT; j++) {
            let i = from + j * SEPARABLE_THREADS + slot;
            let pixel = i % PIXELS;
            let x = left + pixel % WIDE;
            let y = top + pixel / WIDE;
            if (i >= ROWS * PIXELS || x >= out_width || y >= out_height) { continue; }
            let channel = row + i / PIXELS;
            var value = float(reach[(i / PIXELS) * PADDED + pixel])
                + biases[pc.bias_at + biased<UP>(channel)] + skipped[j];
            if ((pc.after & 1) != 0) {
                value = max(value, 0.0);
            }
            arena[pc.into_at + landing<UP>(channel, x, y, out_width)] = Stored(value);
        }
    }
}

/// A whole separable convolution, the depthwise and the 1x1 after it, in one dispatch.
///
/// A workgroup is `ROWS` output channels over a tile of `PIXELS` output pixels. The depthwise is
/// computed a fragment of channels at a time straight into shared memory, where it is the
/// multiply's `B` operand as it stands: the plane between the two layers never reaches the arena.
/// Dispatched over tiles across in x, `rows / ROWS` in y and tiles down in z.
void separable<let ROWS : uint>(uint3 group, uint slot)
{
    switch (pc.kernel * 10 + pc.stride) {
    case 52: separable_as<ROWS, 5, 2>(group, slot); break;
    case 51: separable_as<ROWS, 5, 1>(group, slot); break;
    case 32: separable_as<ROWS, 3, 2>(group, slot); break;
    default: separable_as<ROWS, 3, 1>(group, slot); break;
    }
}

/// What this thread stages of the patch one step of `FRAG` input channels from `k` reaches: cell
/// `slot + j * SEPARABLE_THREADS`, zero outside the plane.
half gathered<let K : uint, let S : uint>(
    uint j, uint k, uint slot, int reach_x, int reach_y, uint plane)
{
    const uint span = PIXELS_WIDE * S + K - 1;
    const uint reached = span * (PIXELS_TALL * S + K - 1);
    let i = j * SEPARABLE_THREADS + slot;
    let within = i % reached;
    let y = reach_y + int(within / span);
    let x = reach_x + int(within % span);
    let inside = i < FRAG * reached && x >= 0 && y >= 0 && x < int(pc.in_width)
        && y < int(pc.in_height);
    if (!inside) { return half(0); }
    return arena[pc.plane_at + (k + i / reached) * plane + uint(y) * pc.in_width + uint(x)];
}

/// [`separable`] for one kernel and stride, which are constants so that the staging's walk over
/// `reach` divides by a constant rather than by a uniform.
void separable_as<let ROWS : uint, let K : uint, let S : uint>(uint3 group, uint slot)
{
    typealias Acc = CoopMat<half, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator>;
    const uint HELD = (ROWS / FRAG) * SPANS / SEPARABLE_GANGS;
    const uint HELD_ROWS = HELD > SPANS ? HELD / SPANS : 1;
    const uint HELD_SPANS = HELD / HELD_ROWS;
    const uint span = PIXELS_WIDE * S + K - 1;
    const uint reached = span * (PIXELS_TALL * S + K - 1);

    let gang = slot / LANES;
    let first_row = gang * HELD / SPANS;
    let first_span = gang * HELD % SPANS;
    let left = group.x * PIXELS_WIDE;
    let top = group.z * PIXELS_TALL;
    let row = group.y * ROWS;
    let reach_x = int(left * S) - int(K / 2);
    let reach_y = int(top * S) - int(K / 2);
    let plane = pc.in_width * pc.in_height;

    var sums: Acc[HELD];
    [ForceUnroll]
    for (uint i = 0; i < HELD; i++) { sums[i] = Acc(half(0)); }

    for (uint k = 0; k < pc.depth; k += FRAG) {
        // Asked for before the staging, so their latency is spent under it rather than after it.
        FragA a[HELD_ROWS];
        [ForceUnroll]
        for (uint r = 0; r < HELD_ROWS; r++) {
            a[r] = FragA.Load<CoopMatMatrixLayout.RowMajor>(
                weights,
                pc.weights_at + fragment_at(row + (first_row + r) * FRAG, k, pc.depth),
                FRAG);
        }
        // `IN_FLIGHT` loads asked for before any is stored: stored as each arrives, every load
        // waits out the one before it, and the staging costs the kernel half again.
        for (uint from = 0; from < FRAG * reached; from += IN_FLIGHT * SEPARABLE_THREADS) {
            half held[IN_FLIGHT];
            [ForceUnroll]
            for (uint j = 0; j < IN_FLIGHT; j++) {
                let cell = from / SEPARABLE_THREADS + j;
                held[j] = gathered<K, S>(cell, k, slot, reach_x, reach_y, plane);
            }
            [ForceUnroll]
            for (uint j = 0; j < IN_FLIGHT; j++) {
                let i = from + j * SEPARABLE_THREADS + slot;
                if (i < FRAG * reached) { reach[i] = held[j]; }
            }
        }
        GroupMemoryBarrierWithGroupSync();
        depthwise<K, S>(slot, reached, span, pc.spread_at + k * K * K);
        GroupMemoryBarrierWithGroupSync();
        [ForceUnroll]
        for (uint r = 0; r < HELD_ROWS; r++) {
            [ForceUnroll]
            for (uint s = 0; s < HELD_SPANS; s++) {
                let b = FragB.Load<CoopMatMatrixLayout.RowMajor>(
                    spread, (first_span + s) * FRAG, PADDED);
                sums[r * HELD_SPANS + s] =
                    coopMatMulAdd<half, false>(a[r], b, sums[r * HELD_SPANS + s]);
            }
        }
    }

    // `reach` is free once the last step's depthwise has read it, and holding the answer there
    // rather than beside it is a smaller workgroup and more of them on a multiprocessor.
    settle<ROWS, PIXELS_WIDE, HELD, false>(
        sums, slot, row, left, top, pc.out_width, pc.columns / pc.out_width);
}

/// A 1x1 convolution whose input is already in the arena, read as the multiply's `B` where it lies.
///
/// A workgroup is `ROWS` output channels over `PIXELS` consecutive pixels of the plane, which has
/// to divide by them. Dispatched over `columns / PIXELS` in x and `rows / ROWS` in y.
void pointwise<let ROWS : uint, let UP : bool>(uint3 group, uint slot)
{
    typealias Acc = CoopMat<half, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator>;
    const uint HELD = (ROWS / FRAG) * SPANS / SEPARABLE_GANGS;
    const uint HELD_ROWS = HELD > SPANS ? HELD / SPANS : 1;
    const uint HELD_SPANS = HELD / HELD_ROWS;

    let gang = slot / LANES;
    let first_row = gang * HELD / SPANS;
    let first_span = gang * HELD % SPANS;
    let column = group.x * PIXELS;
    let row = group.y * ROWS;

    var sums: Acc[HELD];
    [ForceUnroll]
    for (uint i = 0; i < HELD; i++) { sums[i] = Acc(half(0)); }

    for (uint k = 0; k < pc.depth; k += FRAG) {
        FragA a[HELD_ROWS];
        [ForceUnroll]
        for (uint r = 0; r < HELD_ROWS; r++) {
            a[r] = FragA.Load<CoopMatMatrixLayout.RowMajor>(
                weights,
                pc.weights_at + fragment_at(row + (first_row + r) * FRAG, k, pc.depth),
                FRAG);
        }
        FragB b[HELD_SPANS];
        [ForceUnroll]
        for (uint s = 0; s < HELD_SPANS; s++) {
            b[s] = FragB.Load<CoopMatMatrixLayout.RowMajor>(
                arena, pc.plane_at + k * pc.columns + column + (first_span + s) * FRAG, pc.columns);
        }
        [ForceUnroll]
        for (uint r = 0; r < HELD_ROWS; r++) {
            [ForceUnroll]
            for (uint s = 0; s < HELD_SPANS; s++) {
                sums[r * HELD_SPANS + s] =
                    coopMatMulAdd<half, false>(a[r], b[s], sums[r * HELD_SPANS + s]);
            }
        }
    }

    settle<ROWS, PIXELS, HELD, UP>(sums, slot, row, column, 0, pc.columns, 1);
}

/// A workgroup's accumulators through `reach` into the arena: [`answer`], over the tile it
/// describes.
void settle<let ROWS : uint, let WIDE : uint, let HELD : uint, let UP : bool>(
    CoopMat<half, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator> sums[HELD],
    uint slot, uint row, uint left, uint top, uint out_width, uint out_height)
{
    const uint HELD_ROWS = HELD > SPANS ? HELD / SPANS : 1;
    const uint HELD_SPANS = HELD / HELD_ROWS;
    let gang = slot / LANES;
    let first_row = gang * HELD / SPANS;
    let first_span = gang * HELD % SPANS;
    [ForceUnroll]
    for (uint r = 0; r < HELD_ROWS; r++) {
        [ForceUnroll]
        for (uint s = 0; s < HELD_SPANS; s++) {
            sums[r * HELD_SPANS + s].Store<CoopMatMatrixLayout.RowMajor>(
                reach, (first_row + r) * FRAG * PADDED + (first_span + s) * FRAG, PADDED);
        }
    }
    GroupMemoryBarrierWithGroupSync();
    answer<ROWS, WIDE, UP>(slot, row, left, top, out_width, out_height);
}

/// The kernels a rendition dispatches, [`separable`] and [`pointwise`] for a workgroup of `rows`
/// output channels, which is what the Metal artefact is compiled to hold.
///
/// **Metal has no object file here: `newLibraryWithSource` compiles the string it is handed when
/// the device opens**, so every entry point in the file is a kernel compiled on the way to the six
/// that run, and the sweep below is fifty of them. `build.rs` reads the names off these lines.
#define DISPATCHED(rows)                                                           \
    [shader("compute")]                                                            \
    [numthreads(SEPARABLE_THREADS, 1, 1)]                                          \
    void separable_##rows(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)     \
    {                                                                              \
        separable<rows>(group, slot);                                              \
    }                                                                              \
    [shader("compute")]                                                            \
    [numthreads(SEPARABLE_THREADS, 1, 1)]                                          \
    void pointwise_##rows(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)     \
    {                                                                              \
        pointwise<rows, false>(group, slot);                                       \
    }                                                                              \
    [shader("compute")]                                                            \
    [numthreads(SEPARABLE_THREADS, 1, 1)]                                          \
    void upsample_##rows(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)      \
    {                                                                              \
        pointwise<rows, true>(group, slot);                                        \
    }

DISPATCHED(16)
DISPATCHED(32)
DISPATCHED(64)

/// [`multiply`] over matrices held a fragment at a time rather than row by row.
void blocked_multiply<
    T : __BuiltinFloatingPointType,
    let TALL : uint,
    let SPAN : uint,
    let GANGS : uint,
    let DEEP : uint>(uint3 group, uint slot, RWStructuredBuffer<T> into)
{
    typealias Acc = CoopMat<T, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator>;

    let gang = slot / LANES;
    let row = group.y * (TALL * FRAG);
    let column = group.x * (GANGS * SPAN * FRAG) + gang * (SPAN * FRAG);

    var sums: Acc[TALL * SPAN];
    [ForceUnroll]
    for (uint i = 0; i < TALL * SPAN; i++) { sums[i] = Acc(T(0)); }

    for (uint k = 0; k < pc.depth; k += DEEP * FRAG) {
        [ForceUnroll]
        for (uint d = 0; d < DEEP; d++) {
            [ForceUnroll]
            for (uint t = 0; t < TALL; t++) {
                let a = FragA.Load<CoopMatMatrixLayout.RowMajor>(
                    weights,
                    pc.weights_at + fragment_at(row + t * FRAG, k + d * FRAG, pc.depth),
                    FRAG);
                [ForceUnroll]
                for (uint w = 0; w < SPAN; w++) {
                    let b = FragB.Load<CoopMatMatrixLayout.RowMajor>(
                        samples,
                        pc.samples_at
                            + fragment_at(k + d * FRAG, column + w * FRAG, pc.columns),
                        FRAG);
                    sums[t * SPAN + w] = coopMatMulAdd<T, false>(a, b, sums[t * SPAN + w]);
                }
            }
        }
    }

    [ForceUnroll]
    for (uint t = 0; t < TALL; t++) {
        [ForceUnroll]
        for (uint w = 0; w < SPAN; w++) {
            sums[t * SPAN + w].Store<CoopMatMatrixLayout.RowMajor>(
                into,
                pc.out_at + fragment_at(row + t * FRAG, column + w * FRAG, pc.columns),
                FRAG);
        }
    }
}

/// [`blocked_multiply`] with the next step's fragments fetched before this step is multiplied.
///
/// **Why this exists: nothing in the other arms overlaps.** A blocked arm costs about what its
/// multiplies cost plus what its loads cost, one after the other - and the loads alone are as
/// expensive blocked as row-major, so what blocking bought was not cheaper loads but less
/// interference. The reason they cannot overlap is the loop's own shape: every fragment is
/// multiplied on the instruction after it is loaded, so the warp stalls on the load with nothing
/// else to issue. Reading a step ahead gives each load a whole step of multiplies to land behind.
/// `DEEP` steps of the depth are carried at once. With `SPLIT` each step gets its own accumulators,
/// so the chains are `DEEP * TALL * SPAN` where the tile is only `TALL * SPAN` wide; without it the
/// steps fold into one chain and what the extra registers buy is loads in flight rather than chains.
void pipelined_multiply<
    T : __BuiltinFloatingPointType,
    let TALL : uint,
    let SPAN : uint,
    let GANGS : uint,
    let DEEP : uint,
    let SPLIT : uint,
    let DOWN : uint>(uint3 group, uint slot, RWStructuredBuffer<T> into)
{
    typealias Acc = CoopMat<T, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator>;

    let gang = slot / LANES;
    // `DOWN` puts the subgroups of a workgroup on rows rather than on columns, which is the one
    // choice that changes what they load rather than how much: on rows they all read the same
    // fragments of the picture, on columns a slice each.
    let row = group.y * ((DOWN == 1 ? GANGS : 1) * TALL * FRAG) + (DOWN == 1 ? gang * TALL * FRAG : 0);
    let column = group.x * ((DOWN == 1 ? 1 : GANGS) * SPAN * FRAG) + (DOWN == 1 ? 0 : gang * SPAN * FRAG);
    let step = DEEP * FRAG;
    static const uint CHAINS = (SPLIT == 1 ? DEEP : 1) * TALL * SPAN;

    var sums: Acc[CHAINS];
    [ForceUnroll]
    for (uint i = 0; i < CHAINS; i++) { sums[i] = Acc(T(0)); }

    FragA a[DEEP * TALL];
    FragB b[DEEP * SPAN];
    [ForceUnroll]
    for (uint d = 0; d < DEEP; d++) {
        [ForceUnroll]
        for (uint t = 0; t < TALL; t++) {
            a[d * TALL + t] = FragA.Load<CoopMatMatrixLayout.RowMajor>(
                weights,
                pc.weights_at + fragment_at(row + t * FRAG, d * FRAG, pc.depth),
                FRAG);
        }
        [ForceUnroll]
        for (uint w = 0; w < SPAN; w++) {
            b[d * SPAN + w] = FragB.Load<CoopMatMatrixLayout.RowMajor>(
                samples,
                pc.samples_at + fragment_at(d * FRAG, column + w * FRAG, pc.columns),
                FRAG);
        }
    }

    for (uint k = 0; k < pc.depth; k += step) {
        // Asked for first, and waited on only by the multiplies of the step after this one.
        FragA ahead_a[DEEP * TALL];
        FragB ahead_b[DEEP * SPAN];
        let ahead = min(k + step, pc.depth - step);
        [ForceUnroll]
        for (uint d = 0; d < DEEP; d++) {
            [ForceUnroll]
            for (uint t = 0; t < TALL; t++) {
                ahead_a[d * TALL + t] = FragA.Load<CoopMatMatrixLayout.RowMajor>(
                    weights,
                    pc.weights_at + fragment_at(row + t * FRAG, ahead + d * FRAG, pc.depth),
                    FRAG);
            }
            [ForceUnroll]
            for (uint w = 0; w < SPAN; w++) {
                ahead_b[d * SPAN + w] = FragB.Load<CoopMatMatrixLayout.RowMajor>(
                    samples,
                    pc.samples_at + fragment_at(ahead + d * FRAG, column + w * FRAG, pc.columns),
                    FRAG);
            }
        }

        [ForceUnroll]
        for (uint d = 0; d < DEEP; d++) {
            [ForceUnroll]
            for (uint t = 0; t < TALL; t++) {
                [ForceUnroll]
                for (uint w = 0; w < SPAN; w++) {
                    let at = (SPLIT == 1 ? d * TALL * SPAN : 0) + t * SPAN + w;
                    sums[at] = coopMatMulAdd<T, false>(a[d * TALL + t], b[d * SPAN + w], sums[at]);
                }
            }
        }

        [ForceUnroll]
        for (uint i = 0; i < DEEP * TALL; i++) { a[i] = ahead_a[i]; }
        [ForceUnroll]
        for (uint i = 0; i < DEEP * SPAN; i++) { b[i] = ahead_b[i]; }
    }

    [ForceUnroll]
    for (uint t = 0; t < TALL; t++) {
        [ForceUnroll]
        for (uint w = 0; w < SPAN; w++) {
            var total = sums[t * SPAN + w];
            [ForceUnroll]
            for (uint d = 1; d * TALL * SPAN < CHAINS; d++) {
                total = total + sums[d * TALL * SPAN + t * SPAN + w];
            }
            total.Store<CoopMatMatrixLayout.RowMajor>(
                into,
                pc.out_at + fragment_at(row + t * FRAG, column + w * FRAG, pc.columns),
                FRAG);
        }
    }
}

/// A pipelined shape, named `<accumulator>f_<tall>x<span>x<gangs>_<deep>`, each step of the depth
/// accumulated apart.
#define AHEAD(name, T, into, tall, span, gangs, deep)                              \
    [shader("compute")]                                                            \
    [numthreads(LANES * gangs, 1, 1)]                                              \
    void name(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)                 \
    {                                                                              \
        pipelined_multiply<T, tall, span, gangs, deep, 1, 0>(group, slot, into);   \
    }

/// The same shape with its subgroups on rows instead of columns, named
/// `<accumulator>d_<tall>x<span>x<gangs>_<deep>`.
#define DOWNWARD(name, T, into, tall, span, gangs, deep)                           \
    [shader("compute")]                                                            \
    [numthreads(LANES * gangs, 1, 1)]                                              \
    void name(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)                 \
    {                                                                              \
        pipelined_multiply<T, tall, span, gangs, deep, 1, 1>(group, slot, into);   \
    }

/// The same shape with its `deep` steps folded into one chain, named
/// `<accumulator>u_<tall>x<span>x<gangs>_<deep>`.
#define UNROLLED(name, T, into, tall, span, gangs, deep)                        \
    [shader("compute")]                                                         \
    [numthreads(LANES * gangs, 1, 1)]                                           \
    void name(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)              \
    {                                                                           \
        pipelined_multiply<T, tall, span, gangs, deep, 0, 0>(group, slot, into);   \
    }

AHEAD(widef_1x2x1, float, predicted_wide, 1, 2, 1, 1)
AHEAD(widef_2x2x1, float, predicted_wide, 2, 2, 1, 1)
AHEAD(widef_2x4x1, float, predicted_wide, 2, 4, 1, 1)
AHEAD(widef_1x4x1, float, predicted_wide, 1, 4, 1, 1)
AHEAD(widef_2x2x1_2, float, predicted_wide, 2, 2, 1, 2)
AHEAD(halff_2x2x2_2, half, predicted, 2, 2, 2, 2)
AHEAD(halff_1x2x1, half, predicted, 1, 2, 1, 1)
AHEAD(halff_2x2x1, half, predicted, 2, 2, 1, 1)
AHEAD(halff_2x4x1, half, predicted, 2, 4, 1, 1)
AHEAD(halff_4x2x1, half, predicted, 4, 2, 1, 1)
AHEAD(halff_2x2x1_2, half, predicted, 2, 2, 1, 2)
AHEAD(halff_1x2x1_2, half, predicted, 1, 2, 1, 2)
AHEAD(halff_2x4x1_2, half, predicted, 2, 4, 1, 2)
AHEAD(halff_2x2x2, half, predicted, 2, 2, 2, 1)
AHEAD(halff_1x1x1, half, predicted, 1, 1, 1, 1)
AHEAD(halff_1x4x1, half, predicted, 1, 4, 1, 1)
AHEAD(halff_1x2x2, half, predicted, 1, 2, 2, 1)
AHEAD(halff_1x2x4, half, predicted, 1, 2, 4, 1)
AHEAD(halff_1x2x8, half, predicted, 1, 2, 8, 1)
AHEAD(halff_1x2x16, half, predicted, 1, 2, 16, 1)
AHEAD(halff_1x4x2, half, predicted, 1, 4, 2, 1)
AHEAD(halff_1x4x4, half, predicted, 1, 4, 4, 1)
AHEAD(halff_1x4x8, half, predicted, 1, 4, 8, 1)
AHEAD(halff_1x8x2, half, predicted, 1, 8, 2, 1)
AHEAD(halff_2x2x4, half, predicted, 2, 2, 4, 1)
AHEAD(halff_2x2x1_4, half, predicted, 2, 2, 1, 4)
AHEAD(halff_4x2x1_2, half, predicted, 4, 2, 1, 2)
AHEAD(halff_2x4x2_2, half, predicted, 2, 4, 2, 2)
AHEAD(halff_4x4x1_2, half, predicted, 4, 4, 1, 2)
AHEAD(halff_2x2x4_2, half, predicted, 2, 2, 4, 2)
AHEAD(halff_2x2x8_2, half, predicted, 2, 2, 8, 2)
AHEAD(halff_2x2x2_4, half, predicted, 2, 2, 2, 4)
AHEAD(halff_4x2x2_2, half, predicted, 4, 2, 2, 2)
AHEAD(halff_1x2x2_2, half, predicted, 1, 2, 2, 2)
AHEAD(widef_2x2x2_2, float, predicted_wide, 2, 2, 2, 2)
DOWNWARD(halfd_2x2x2_2, half, predicted, 2, 2, 2, 2)
DOWNWARD(halfd_2x2x4_2, half, predicted, 2, 2, 4, 2)
DOWNWARD(halfd_1x2x2_2, half, predicted, 1, 2, 2, 2)
DOWNWARD(halfd_2x2x2, half, predicted, 2, 2, 2, 1)
DOWNWARD(halfd_1x2x4, half, predicted, 1, 2, 4, 1)
UNROLLED(halfu_1x2x2_2, half, predicted, 1, 2, 2, 2)
UNROLLED(halfu_1x2x2_4, half, predicted, 1, 2, 2, 4)
UNROLLED(halfu_2x2x1_2, half, predicted, 2, 2, 1, 2)

/// [`bound_load`] over the blocked layout: the loads a blocked arm makes, with no multiplies.
[shader("compute")]
[numthreads(LANES, 1, 1)]
void bound_blocked_load(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)
{
    let row = group.y * FRAG;
    let column = group.x * (2 * FRAG);
    var sum = 0.0;
    for (uint k = 0; k < pc.depth; k += FRAG) {
        let a = FragA.Load<CoopMatMatrixLayout.RowMajor>(
            weights, pc.weights_at + fragment_at(row, k, pc.depth), FRAG);
        let b0 = FragB.Load<CoopMatMatrixLayout.RowMajor>(
            samples, pc.samples_at + fragment_at(k, column, pc.columns), FRAG);
        let b1 = FragB.Load<CoopMatMatrixLayout.RowMajor>(
            samples, pc.samples_at + fragment_at(k, column + FRAG, pc.columns), FRAG);
        sum += float(a[0]) + float(b0[0]) + float(b1[0]);
    }
    predicted_wide[pc.out_at + row * pc.columns + column + slot] = sum;
}

/// A blocked shape, named `<accumulator>b_<tall>x<span>x<gangs>_<deep>`: the same tile over
/// matrices stored a fragment at a time.
#define BLOCKED(name, T, into, tall, span, gangs, deep)                  \
    [shader("compute")]                                                  \
    [numthreads(LANES * gangs, 1, 1)]                                    \
    void name(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)       \
    {                                                                    \
        blocked_multiply<T, tall, span, gangs, deep>(group, slot, into); \
    }

BLOCKED(wideb_1x2x1_1, float, predicted_wide, 1, 2, 1, 1)
BLOCKED(wideb_1x2x1_2, float, predicted_wide, 1, 2, 1, 2)
BLOCKED(wideb_2x2x1_2, float, predicted_wide, 2, 2, 1, 2)
BLOCKED(wideb_1x4x1_2, float, predicted_wide, 1, 4, 1, 2)
BLOCKED(wideb_2x2x1_4, float, predicted_wide, 2, 2, 1, 4)
BLOCKED(wideb_2x2x1_1, float, predicted_wide, 2, 2, 1, 1)
BLOCKED(wideb_2x4x1_2, float, predicted_wide, 2, 4, 1, 2)
BLOCKED(wideb_1x2x2_2, float, predicted_wide, 1, 2, 2, 2)
BLOCKED(wideb_1x1x1_2, float, predicted_wide, 1, 1, 1, 2)
BLOCKED(wideb_4x2x1_2, float, predicted_wide, 4, 2, 1, 2)
BLOCKED(wideb_4x4x1_2, float, predicted_wide, 4, 4, 1, 2)
BLOCKED(wideb_2x4x1_1, float, predicted_wide, 2, 4, 1, 1)
BLOCKED(halfb_1x2x1_2, half, predicted, 1, 2, 1, 2)
BLOCKED(halfb_2x2x1_2, half, predicted, 2, 2, 1, 2)
BLOCKED(halfb_2x2x1_4, half, predicted, 2, 2, 1, 4)
BLOCKED(halfb_2x4x1_2, half, predicted, 2, 4, 1, 2)
BLOCKED(halfb_4x4x1_2, half, predicted, 4, 4, 1, 2)
BLOCKED(halfb_4x2x1_2, half, predicted, 4, 2, 1, 2)

/// A split shape, named `<accumulator>p_<tall>x<span>x<gangs>_<deep>`: the same tile as an `ARM` of
/// those numbers, with each of its `deep` steps of the depth accumulated apart.
#define SPLIT(name, T, into, tall, span, gangs, deep)                        \
    [shader("compute")]                                                      \
    [numthreads(LANES * gangs, 1, 1)]                                        \
    void name(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)           \
    {                                                                        \
        split_multiply<T, tall, span, gangs, deep>(group, slot, into);       \
    }

SPLIT(widep_1x2x1_2, float, predicted_wide, 1, 2, 1, 2)
SPLIT(widep_1x2x1_4, float, predicted_wide, 1, 2, 1, 4)
SPLIT(widep_2x2x1_2, float, predicted_wide, 2, 2, 1, 2)
SPLIT(widep_1x1x1_2, float, predicted_wide, 1, 1, 1, 2)
SPLIT(widep_1x1x1_4, float, predicted_wide, 1, 1, 1, 4)
SPLIT(halfp_1x2x1_2, half, predicted, 1, 2, 1, 2)
SPLIT(halfp_1x2x1_4, half, predicted, 1, 2, 1, 4)

/// The largest tile the staged arms below hold, in `half`: 64 rows by 32 of depth for A, and 32 by
/// 64 columns for B, which is 8KB together.
///
/// **Every staged entry point pays for the largest of them, which is why they are this small.** The
/// arrays are module scope, so a shape that wants a 32x32 tile still reserves whatever the widest
/// one declared - and workgroup memory is what decides how many workgroups a multiprocessor holds.
/// Sized for the widest shape tried first, the small ones measured against a handicap they do not
/// have: 6KB here rather than 12.
static const uint STAGED_A = 64 * 32;
static const uint STAGED_B = 32 * 64;
groupshared half staged_a[STAGED_A];
groupshared half staged_b[STAGED_B];

/// The same multiply with both operands read into workgroup memory first.
///
/// **What staging is for, and it is not the same thing as carrying more fragments.** The subgroups
/// of [`multiply`] sit side by side across the columns, so each holds its own rows of A and its own
/// columns of B, and every one of them reads its own A from memory - the sharing is one-dimensional
/// and the traffic is what it was. Here they are a `DOWN` by `ACROSS` grid: the workgroup reads
/// `BM` rows of A and `BN` columns of B once per step of the depth, and each is then used by
/// `ACROSS` and `DOWN` subgroups out of workgroup memory. A layer's B traffic falls from
/// `rows / (TALL * FRAG)` passes over the activation plane to `rows / BM` of them.
///
/// The cost is two barriers a step and the staging itself, which is why this is a measurement
/// beside the other arms rather than instead of them.
///
/// **And it does not win, which is the finding.** At matched workgroup memory the best staged shape
/// is 56ms over the frame's pointwise layers against 55 for the register-blocked arm above, and
/// asking for more reuse makes it worse rather than better: 32 rows a workgroup is 56ms, 64 rows -
/// twice the reuse, one accumulator a subgroup, so nothing given up in registers - is 60ms. So what
/// this kernel is short of is not the traffic staging removes. These matrices are small enough that
/// what it re-reads was being answered by cache at about what workgroup memory costs, and the
/// barriers are paid either way.
void staged_multiply<
    T : __BuiltinFloatingPointType,
    let TALL : uint,
    let SPAN : uint,
    let DOWN : uint,
    let ACROSS : uint,
    let DEEP : uint>(uint3 group, uint slot, RWStructuredBuffer<T> into)
{
    typealias Acc = CoopMat<T, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator>;

    let bm = DOWN * TALL * FRAG;
    let bn = ACROSS * SPAN * FRAG;
    let bk = DEEP * FRAG;
    let threads = DOWN * ACROSS * LANES;

    let gang = slot / LANES;
    let down = gang / ACROSS;
    let across = gang % ACROSS;
    let row = group.y * bm;
    let column = group.x * bn;

    var sums: Acc[TALL * SPAN];
    [ForceUnroll]
    for (uint i = 0; i < TALL * SPAN; i++) { sums[i] = Acc(T(0)); }

    for (uint k = 0; k < pc.depth; k += bk) {
        // Both tiles read straight across their rows, so the threads of a step read a line of
        // memory between them rather than a column each.
        for (uint i = slot; i < bm * bk; i += threads) {
            staged_a[i] = weights[pc.weights_at + (row + i / bk) * pc.depth + k + i % bk];
        }
        for (uint i = slot; i < bk * bn; i += threads) {
            staged_b[i] = samples[pc.samples_at + (k + i / bn) * pc.columns + column + i % bn];
        }
        GroupMemoryBarrierWithGroupSync();

        [ForceUnroll]
        for (uint d = 0; d < DEEP; d++) {
            [ForceUnroll]
            for (uint t = 0; t < TALL; t++) {
                let a = FragA.Load<CoopMatMatrixLayout.RowMajor>(
                    staged_a, ((down * TALL + t) * FRAG) * bk + d * FRAG, bk);
                [ForceUnroll]
                for (uint w = 0; w < SPAN; w++) {
                    let b = FragB.Load<CoopMatMatrixLayout.RowMajor>(
                        staged_b, (d * FRAG) * bn + (across * SPAN + w) * FRAG, bn);
                    sums[t * SPAN + w] = coopMatMulAdd<T, false>(a, b, sums[t * SPAN + w]);
                }
            }
        }
        // The next step overwrites what these fragments were read from.
        GroupMemoryBarrierWithGroupSync();
    }

    [ForceUnroll]
    for (uint t = 0; t < TALL; t++) {
        [ForceUnroll]
        for (uint w = 0; w < SPAN; w++) {
            let at = row + (down * TALL + t) * FRAG;
            let by = column + (across * SPAN + w) * FRAG;
            sums[t * SPAN + w].Store<CoopMatMatrixLayout.RowMajor>(
                into, pc.out_at + at * pc.columns + by, pc.columns);
        }
    }
}

/// [`multiply`] with a separate accumulator for each step of the depth it reads at once, summed at
/// the end.
///
/// **This is the one thing the roofline asks for that the shape parameters cannot give.** `DEEP`
/// above puts several steps of the depth in flight, but every one of them multiplies into the same
/// accumulator, so they are one dependent chain however many loads are outstanding - and a
/// dependent chain is what the matrix units are waiting on. Giving each step its own accumulator
/// makes them `DEEP` independent chains over exactly the same loads and the same multiplies; what
/// it costs is `DEEP` times the accumulators live, and one addition each at the end.
void split_multiply<
    T : __BuiltinFloatingPointType,
    let TALL : uint,
    let SPAN : uint,
    let GANGS : uint,
    let DEEP : uint>(uint3 group, uint slot, RWStructuredBuffer<T> into)
{
    typealias Acc = CoopMat<T, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator>;

    let gang = slot / LANES;
    let row = group.y * (TALL * FRAG);
    let column = group.x * (GANGS * SPAN * FRAG) + gang * (SPAN * FRAG);

    var sums: Acc[DEEP * TALL * SPAN];
    [ForceUnroll]
    for (uint i = 0; i < DEEP * TALL * SPAN; i++) { sums[i] = Acc(T(0)); }

    for (uint k = 0; k < pc.depth; k += DEEP * FRAG) {
        [ForceUnroll]
        for (uint d = 0; d < DEEP; d++) {
            [ForceUnroll]
            for (uint t = 0; t < TALL; t++) {
                let a = FragA.Load<CoopMatMatrixLayout.RowMajor>(
                    weights, pc.weights_at + (row + t * FRAG) * pc.depth + k + d * FRAG, pc.depth);
                [ForceUnroll]
                for (uint w = 0; w < SPAN; w++) {
                    let b = FragB.Load<CoopMatMatrixLayout.RowMajor>(
                        samples,
                        pc.samples_at + (k + d * FRAG) * pc.columns + column + w * FRAG,
                        pc.columns);
                    let at = (d * TALL + t) * SPAN + w;
                    sums[at] = coopMatMulAdd<T, false>(a, b, sums[at]);
                }
            }
        }
    }

    [ForceUnroll]
    for (uint t = 0; t < TALL; t++) {
        [ForceUnroll]
        for (uint w = 0; w < SPAN; w++) {
            var total = sums[t * SPAN + w];
            [ForceUnroll]
            for (uint d = 1; d < DEEP; d++) { total = total + sums[(d * TALL + t) * SPAN + w]; }
            total.Store<CoopMatMatrixLayout.RowMajor>(
                into,
                pc.out_at + (row + t * FRAG) * pc.columns + column + w * FRAG,
                pc.columns);
        }
    }
}

/// The shapes the host times, named `<accumulator>_<tall>x<span>x<gangs>`.
///
/// **The `half` arm is the one a pipeline could use; the `float` arms are the rate.** Coming back
/// down to `half` for the next layer to read is a cooperative-matrix conversion, which is an `NV`
/// extension rather than the KHR core, so a `float` accumulator here stores what it accumulated and
/// a chain built on it would owe a pass.
#define ARM(name, T, into, tall, span, gangs, deep)                \
    [shader("compute")]                                            \
    [numthreads(LANES * gangs, 1, 1)]                              \
    void name(uint3 group : SV_GroupID, uint slot : SV_GroupIndex) \
    {                                                              \
        multiply<T, tall, span, gangs, deep>(group, slot, into);   \
    }

ARM(half_1x4x4, half, predicted, 1, 4, 4, 1)
ARM(half_1x2x4, half, predicted, 1, 2, 4, 1)
ARM(half_1x8x4, half, predicted, 1, 8, 4, 1)
ARM(half_2x4x4, half, predicted, 2, 4, 4, 1)
ARM(half_1x4x2, half, predicted, 1, 4, 2, 1)
ARM(half_1x4x8, half, predicted, 1, 4, 8, 1)
ARM(half_1x1x4, half, predicted, 1, 1, 4, 1)
ARM(half_1x1x2, half, predicted, 1, 1, 2, 1)
ARM(half_1x2x2, half, predicted, 1, 2, 2, 1)
ARM(half_1x2x8, half, predicted, 1, 2, 8, 1)
ARM(half_1x1x1, half, predicted, 1, 1, 1, 1)
ARM(half_1x2x1, half, predicted, 1, 2, 1, 1)
ARM(half_1x4x1, half, predicted, 1, 4, 1, 1)
ARM(half_2x2x1, half, predicted, 2, 2, 1, 1)
ARM(half_2x2x1_2, half, predicted, 2, 2, 1, 2)
ARM(half_1x2x1_2, half, predicted, 1, 2, 1, 2)
ARM(half_1x2x1_4, half, predicted, 1, 2, 1, 4)
ARM(half_1x1x1_2, half, predicted, 1, 1, 1, 2)

ARM(wide_1x4x4, float, predicted_wide, 1, 4, 4, 1)
ARM(wide_1x2x4, float, predicted_wide, 1, 2, 4, 1)
ARM(wide_1x8x4, float, predicted_wide, 1, 8, 4, 1)
ARM(wide_2x4x4, float, predicted_wide, 2, 4, 4, 1)
ARM(wide_1x4x2, float, predicted_wide, 1, 4, 2, 1)
ARM(wide_1x4x8, float, predicted_wide, 1, 4, 8, 1)
ARM(wide_1x1x4, float, predicted_wide, 1, 1, 4, 1)
ARM(wide_1x1x2, float, predicted_wide, 1, 1, 2, 1)
ARM(wide_1x2x2, float, predicted_wide, 1, 2, 2, 1)
ARM(wide_1x2x8, float, predicted_wide, 1, 2, 8, 1)
ARM(wide_1x1x1, float, predicted_wide, 1, 1, 1, 1)
ARM(wide_1x2x1, float, predicted_wide, 1, 2, 1, 1)
ARM(wide_1x4x1, float, predicted_wide, 1, 4, 1, 1)
ARM(wide_2x2x1, float, predicted_wide, 2, 2, 1, 1)
ARM(wide_2x2x1_2, float, predicted_wide, 2, 2, 1, 2)
ARM(wide_2x4x1, float, predicted_wide, 2, 4, 1, 1)
ARM(wide_1x2x1_2, float, predicted_wide, 1, 2, 1, 2)
ARM(wide_1x2x1_4, float, predicted_wide, 1, 2, 1, 4)
ARM(wide_1x1x1_2, float, predicted_wide, 1, 1, 1, 2)

/// The winning shape with its loads taken out: one fragment of each is read before the loop and
/// every step multiplies those. Same multiplies, three loads.
///
/// Dispatched exactly as `wide_1x2x1` is, so its time is that arm's with the memory removed - which
/// is the end of the roofline the matrix units are on.
[shader("compute")]
[numthreads(LANES, 1, 1)]
void bound_wide_math(uint3 group : SV_GroupID)
{
    typealias Acc = CoopMat<float, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator>;
    let row = group.y * FRAG;
    let column = group.x * (2 * FRAG);
    let a = FragA.Load<CoopMatMatrixLayout.RowMajor>(
        weights, pc.weights_at + row * pc.depth, pc.depth);
    let b0 = FragB.Load<CoopMatMatrixLayout.RowMajor>(
        samples, pc.samples_at + column, pc.columns);
    let b1 = FragB.Load<CoopMatMatrixLayout.RowMajor>(
        samples, pc.samples_at + column + FRAG, pc.columns);

    var s0 = Acc(0.0);
    var s1 = Acc(0.0);
    for (uint k = 0; k < pc.depth; k += FRAG) {
        s0 = coopMatMulAdd<float, false>(a, b0, s0);
        s1 = coopMatMulAdd<float, false>(a, b1, s1);
    }
    s0.Store<CoopMatMatrixLayout.RowMajor>(
        predicted_wide, pc.out_at + row * pc.columns + column, pc.columns);
    s1.Store<CoopMatMatrixLayout.RowMajor>(
        predicted_wide, pc.out_at + row * pc.columns + column + FRAG, pc.columns);
}

/// [`bound_wide_math`] with four accumulators instead of two, which is twice the arithmetic in the same
/// number of steps.
///
/// **This is the one that says which kind of limit the multiplies are.** Two accumulators are two
/// dependent chains: each multiply waits on the one before it into the same accumulator. If the
/// tensor units were saturated this would take twice as long; if they are waiting, it takes the
/// same time and the rate has doubled.
[shader("compute")]
[numthreads(LANES, 1, 1)]
void bound_wide_math4(uint3 group : SV_GroupID)
{
    typealias Acc = CoopMat<float, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator>;
    let row = group.y * FRAG;
    let column = group.x * (2 * FRAG);
    let a = FragA.Load<CoopMatMatrixLayout.RowMajor>(
        weights, pc.weights_at + row * pc.depth, pc.depth);
    let b0 = FragB.Load<CoopMatMatrixLayout.RowMajor>(
        samples, pc.samples_at + column, pc.columns);
    let b1 = FragB.Load<CoopMatMatrixLayout.RowMajor>(
        samples, pc.samples_at + column + FRAG, pc.columns);

    var s0 = Acc(0.0);
    var s1 = Acc(0.0);
    var s2 = Acc(0.0);
    var s3 = Acc(0.0);
    for (uint k = 0; k < pc.depth; k += FRAG) {
        s0 = coopMatMulAdd<float, false>(a, b0, s0);
        s1 = coopMatMulAdd<float, false>(a, b1, s1);
        s2 = coopMatMulAdd<float, false>(a, b0, s2);
        s3 = coopMatMulAdd<float, false>(a, b1, s3);
    }
    (s0 + s2).Store<CoopMatMatrixLayout.RowMajor>(
        predicted_wide, pc.out_at + row * pc.columns + column, pc.columns);
    (s1 + s3).Store<CoopMatMatrixLayout.RowMajor>(
        predicted_wide, pc.out_at + row * pc.columns + column + FRAG, pc.columns);
}

/// [`bound_wide_math`] accumulating in `half`, which is half the registers an accumulator takes.
///
/// **The `half` arms are slower than the `float` ones all through this file, and this says where
/// that comes from**: if the multiply itself is the same rate, the difference is in what surrounds
/// it, and if it is not, a `half` accumulator is simply the slower instruction here whatever it
/// saves in registers.
[shader("compute")]
[numthreads(LANES, 1, 1)]
void bound_half_math(uint3 group : SV_GroupID)
{
    typealias Acc = CoopMat<half, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator>;
    let row = group.y * FRAG;
    let column = group.x * (2 * FRAG);
    let a = FragA.Load<CoopMatMatrixLayout.RowMajor>(
        weights, pc.weights_at + row * pc.depth, pc.depth);
    let b0 = FragB.Load<CoopMatMatrixLayout.RowMajor>(
        samples, pc.samples_at + column, pc.columns);
    let b1 = FragB.Load<CoopMatMatrixLayout.RowMajor>(
        samples, pc.samples_at + column + FRAG, pc.columns);

    var s0 = Acc(half(0.0));
    var s1 = Acc(half(0.0));
    for (uint k = 0; k < pc.depth; k += FRAG) {
        s0 = coopMatMulAdd<half, false>(a, b0, s0);
        s1 = coopMatMulAdd<half, false>(a, b1, s1);
    }
    s0.Store<CoopMatMatrixLayout.RowMajor>(
        predicted, pc.out_at + row * pc.columns + column, pc.columns);
    s1.Store<CoopMatMatrixLayout.RowMajor>(
        predicted, pc.out_at + row * pc.columns + column + FRAG, pc.columns);
}

/// [`bound_wide_math`] with eight chains, which is where the curve of them is asked to stop.
///
/// Two accumulators reach 9.2 TFLOP/s and four reach 17, against the 59.5 this card is quoted at
/// dense - so the question this answers is whether the multiplies were ever near a rate limit or
/// merely short of independent work all along.
[shader("compute")]
[numthreads(LANES, 1, 1)]
void bound_wide_math8(uint3 group : SV_GroupID)
{
    typealias Acc = CoopMat<float, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator>;
    let row = group.y * FRAG;
    let column = group.x * (2 * FRAG);
    let a = FragA.Load<CoopMatMatrixLayout.RowMajor>(
        weights, pc.weights_at + row * pc.depth, pc.depth);
    let b0 = FragB.Load<CoopMatMatrixLayout.RowMajor>(
        samples, pc.samples_at + column, pc.columns);
    let b1 = FragB.Load<CoopMatMatrixLayout.RowMajor>(
        samples, pc.samples_at + column + FRAG, pc.columns);

    var sums: Acc[8];
    [ForceUnroll]
    for (uint i = 0; i < 8; i++) { sums[i] = Acc(0.0); }
    for (uint k = 0; k < pc.depth; k += FRAG) {
        [ForceUnroll]
        for (uint i = 0; i < 8; i++) {
            sums[i] = coopMatMulAdd<float, false>(a, i % 2 == 0 ? b0 : b1, sums[i]);
        }
    }

    var left = sums[0];
    var right = sums[1];
    [ForceUnroll]
    for (uint i = 2; i < 8; i += 2) {
        left = left + sums[i];
        right = right + sums[i + 1];
    }
    left.Store<CoopMatMatrixLayout.RowMajor>(
        predicted_wide, pc.out_at + row * pc.columns + column, pc.columns);
    right.Store<CoopMatMatrixLayout.RowMajor>(
        predicted_wide, pc.out_at + row * pc.columns + column + FRAG, pc.columns);
}

/// The same shape with its multiplies taken out: every fragment is read and one element of each is
/// summed, which is the least that keeps the loads alive. The other end of the roofline.
[shader("compute")]
[numthreads(LANES, 1, 1)]
void bound_load(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)
{
    let row = group.y * FRAG;
    let column = group.x * (2 * FRAG);
    var sum = 0.0;
    for (uint k = 0; k < pc.depth; k += FRAG) {
        let a = FragA.Load<CoopMatMatrixLayout.RowMajor>(
            weights, pc.weights_at + row * pc.depth + k, pc.depth);
        let b0 = FragB.Load<CoopMatMatrixLayout.RowMajor>(
            samples, pc.samples_at + k * pc.columns + column, pc.columns);
        let b1 = FragB.Load<CoopMatMatrixLayout.RowMajor>(
            samples, pc.samples_at + k * pc.columns + column + FRAG, pc.columns);
        sum += float(a[0]) + float(b0[0]) + float(b1[0]);
    }
    predicted_wide[pc.out_at + row * pc.columns + column + slot] = sum;
}

/// A staged shape, named `<accumulator>s_<tall>x<span>x<down>x<across>_<deep>`: `DOWN * ACROSS`
/// subgroups in a grid, each carrying `TALL` by `SPAN` fragments, over `DEEP` steps of the depth
/// held in workgroup memory at a time.
#define STAGED(name, T, into, tall, span, down, across, deep)                 \
    [shader("compute")]                                                       \
    [numthreads(LANES * down * across, 1, 1)]                                 \
    void name(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)            \
    {                                                                         \
        staged_multiply<T, tall, span, down, across, deep>(group, slot, into); \
    }

STAGED(halfs_1x1x2x2_2, half, predicted, 1, 1, 2, 2, 2)
STAGED(halfs_1x1x2x4_2, half, predicted, 1, 1, 2, 4, 2)
STAGED(halfs_1x2x2x2_2, half, predicted, 1, 2, 2, 2, 2)
STAGED(halfs_1x1x2x2_1, half, predicted, 1, 1, 2, 2, 1)
STAGED(halfs_1x1x4x2_2, half, predicted, 1, 1, 4, 2, 2)
STAGED(halfs_1x1x4x4_2, half, predicted, 1, 1, 4, 4, 2)

STAGED(wides_1x1x2x2_2, float, predicted_wide, 1, 1, 2, 2, 2)
STAGED(wides_1x1x2x4_2, float, predicted_wide, 1, 1, 2, 4, 2)
STAGED(wides_1x2x2x2_2, float, predicted_wide, 1, 2, 2, 2, 2)
STAGED(wides_1x1x2x2_1, float, predicted_wide, 1, 1, 2, 2, 1)
STAGED(wides_1x1x4x2_2, float, predicted_wide, 1, 1, 4, 2, 2)
STAGED(wides_1x1x4x4_2, float, predicted_wide, 1, 1, 4, 4, 2)
