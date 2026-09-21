// PMRID's 1x1 convolutions as a cooperative-matrix multiply, which is what reaches a tensor core.
//
// **Why this is not in `pmrid.slang` and not WGSL.** A 1x1 convolution over an NCHW arena is a
// matrix multiply already: the weights are `[out][in]` row-major, an activation plane is `[in]`
// rows of `pixels` columns, and the output is `[out]` rows of the same - so `C = A * B` with no
// gather and no reshape. Saying that to the hardware wants `OpCooperativeMatrixMulAddKHR`, which
// WGSL has no spelling for, so this compiles to SPIR-V and is handed to the driver as it stands.
//
// **Two hosts dispatch it, and only one of them is a picture.** `native/rawshim/src/pmrid.rs` runs
// `stage`, one multiply and `finish` per 1x1 layer of a rendition, on the device wgpu already
// opened, where a browser has neither the instruction nor a way to pass SPIR-V through and takes
// the WGSL pass instead. `native/rawshim/examples/coopmat.rs` is the measurement the shapes below
// were chosen by, on a Vulkan device of its own, over the same layer list.
//
// Sixteen-by-sixteen fragments, which is what an Ampere subgroup's `f16` multiply is; the host
// refuses a device whose reported configurations do not include that shape.
//
// The entry points at the bottom are one multiply in every shape worth trying - how many fragments
// of rows and of columns a subgroup carries, and how many subgroups share a workgroup - because
// which of them is fastest is a measurement rather than a derivation, and the host times them all.
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
// **What it is worth in a rendition, which is less than the multiply is.** A 25MP frame is 30 tiles
// and the whole denoise is 256ms with these kernels against 285 on the WGSL pass; with the 1x1
// layers left out entirely it is 168, so the pointwise third of the network is 88ms here and 117
// there. Of those 88, the multiplies are 25 and `stage` and `finish` are 63 - the conversions
// either side of an arena that is `float` and row-major because the rest of the network is WGSL
// over it. So the instruction is no longer what this costs, and what would buy the next thirty
// milliseconds is a layer either side that could read or write the `half` itself.

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
    /// The arena tensors [`stage`] reads and [`finish`] writes, and the one a residual adds.
    uint plane_at;
    uint into_at;
    uint skip_at;
    uint bias_at;
    /// 1 rectifies what [`finish`] wrote, 2 adds `skip_at` to it first.
    uint after;
};

[vk::push_constant] ConstantBuffer<Shape> pc;
[vk::binding(0, 0)] StructuredBuffer<half> weights;
[vk::binding(1, 0)] RWStructuredBuffer<half> samples;
[vk::binding(2, 0)] RWStructuredBuffer<half> predicted;
/// The forward pass's own arena, which is `float` and is where a layer's input comes from and its
/// answer goes back to - and which a `float` accumulator can therefore multiply straight into.
[vk::binding(3, 0)] RWStructuredBuffer<float> predicted_wide;
/// The network's weights as the host stores them, read here for a layer's biases alone.
[vk::binding(4, 0)] StructuredBuffer<float> biases;

static const uint FRAG = 16;
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

/// One fragment a workgroup, which is what [`stage`] and [`finish`] are dispatched over.
///
/// **A thread a cell of the fragment, rather than a thread a cell of the row.** The `half` side of
/// both kernels is the blocked one, so a workgroup laid along the plane writes 32 bytes here and 32
/// bytes 1KB away, sixteen times over; laid on a fragment it writes the whole 512 contiguous.
static const uint CROSSING = FRAG * FRAG;

/// The layer's input, from the arena into the `half` the multiply reads.
///
/// **The two sides of this kernel are the two things a tensor core asks for that the rest of the
/// forward pass does not**: an activation plane in `half`, and it held a fragment at a time
/// ([`fragment_at`]). Both are this layer's alone - the arena stays `float` and row-major, because
/// the other three quarters of the network are WGSL over it.
[shader("compute")]
[numthreads(CROSSING, 1, 1)]
void stage(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)
{
    let row = group.y * FRAG + slot / FRAG;
    let column = group.x * FRAG + slot % FRAG;
    let into = (group.y * (pc.columns / FRAG) + group.x) * CROSSING + slot;
    samples[pc.samples_at + into] = half(predicted_wide[pc.plane_at + row * pc.columns + column]);
}

/// The multiply's answer back into the arena, with what the convolution still owed it.
///
/// The bias, the residual a block folded into this layer's store, and the rectifier: everything
/// `pmrid.slang`'s own pointwise does around its accumulator, done here because the multiply that
/// replaced it has only the accumulator.
[shader("compute")]
[numthreads(CROSSING, 1, 1)]
void finish(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)
{
    let row = group.y * FRAG + slot / FRAG;
    let column = group.x * FRAG + slot % FRAG;
    let cell = row * pc.columns + column;
    let from = (group.y * (pc.columns / FRAG) + group.x) * CROSSING + slot;
    var value = float(predicted[pc.out_at + from]) + biases[pc.bias_at + row];
    if ((pc.after & 2) != 0) {
        value += predicted_wide[pc.skip_at + cell];
    }
    if ((pc.after & 1) != 0) {
        value = max(value, 0.0);
    }
    predicted_wide[pc.into_at + cell] = value;
}

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
AHEAD(halff_2x2x1, half, predicted, 2, 2, 1, 1)
AHEAD(halff_2x4x1, half, predicted, 2, 4, 1, 1)
AHEAD(halff_1x2x1, half, predicted, 1, 2, 1, 1)
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
AHEAD(halff_2x2x2_2, half, predicted, 2, 2, 2, 2)
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
