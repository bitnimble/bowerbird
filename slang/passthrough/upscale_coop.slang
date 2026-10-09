// The upscaler's 3x3 layers on a cooperative-matrix multiply, beside `slang/upscale.slang`'s WGSL,
// which runs every other step of the network for every arm.
//
// A 3x3 layer over an NHWC tensor is nine multiplies: for each tap, `A` is a run of pixels by the
// input channels, read where it lies with the channel count as its stride, `B` is that tap's
// weights, input channels by output channels, and every tap accumulates into the same pixels by
// output channels. No patch is gathered: a tap is the same run read a pixel or a row further on.
//
// `FRAGMENT` is the instruction's shape, 16 on Vulkan and 8 on Metal, as in `pmrid_coop.slang`.

import "../times.slang";

using namespace linalg;

/// `Step` in `slang/upscale.slang`, field for field as far as this reads it.
struct Step {
    uint width;
    uint height;
    int left;
    int top;
    uint frame_width;
    uint frame_height;
    /// Where the layer's weight fragments start in `blocks`, in halves.
    uint weights_at;
    uint bias_at;
    uint slope_at;
};

[vk::push_constant] ConstantBuffer<Step> step;
/// Each layer's taps a fragment at a time: output slice, tap, input fragment, output fragment.
[vk::binding(0, 0)] StructuredBuffer<half> blocks;
[vk::binding(1, 0)] StructuredBuffer<half> given;
[vk::binding(2, 0)] RWStructuredBuffer<vector<half, 4>> made;
/// The WGSL pass's weights, read here for the biases and slopes.
[vk::binding(3, 0)] StructuredBuffer<float> weights;

#ifndef FRAGMENT
#define FRAGMENT 16
#endif

static const uint FRAG = FRAGMENT;
static const uint LANES = 32;
static const uint GANGS = 4;
static const uint THREADS = LANES * GANGS;
/// A workgroup's tile is `WIDE` pixels by `TALL`, each subgroup a run of one row of it.
static const uint WIDE = 64;
static const uint TALL = 4;
/// The output channels one workgroup carries; a wider layer is dispatched a slice at a time.
static const uint OUT_MOST = 48;
static const uint RUN = WIDE * TALL / GANGS;

typealias FragA = CoopMat<half, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixA>;
typealias FragB = CoopMat<half, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixB>;
typealias Narrow = CoopMat<half, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator>;

groupshared half answers[WIDE * TALL * OUT_MOST];

/// One 3x3 layer, `IN` channels to `OUT`, accumulated in `half`, with its bias and, unless
/// `LINEAR`, its PReLU: the slice of `OUT_MOST` output channels `group.z` names. Dispatched over the
/// region's width in `WIDE` and its height in `TALL`.
void conv<let IN : uint, let OUT : uint, let LINEAR : bool>(uint3 group, uint slot)
{
    const uint SLICE = OUT < OUT_MOST ? OUT : OUT_MOST;
    const uint FRAGS = RUN / FRAG;
    const uint DEEP = IN / FRAG;
    const uint ACROSS = SLICE / FRAG;
    const uint HELD = FRAGS * ACROSS;
    var sums: Narrow[HELD];
    [ForceUnroll]
    for (uint i = 0; i < HELD; i++) { sums[i] = Narrow(half(0)); }

    let gang = slot / LANES;
    let runs_a_row = WIDE / RUN;
    let run_x = (gang % runs_a_row) * RUN;
    let run_y = gang / runs_a_row;
    let left = group.x * WIDE + run_x;
    let top = group.y * TALL + run_y;
    let span = step.width + 2;
    let slice_at = step.weights_at + group.z * (9 * DEEP * ACROSS * FRAG * FRAG);

    [ForceUnroll]
    for (uint tap = 0; tap < 9; tap++) {
        // The ring puts the tap a pixel up and left of the output at the tensor's own origin.
        let origin = (top + tap / 3) * span + left + tap % 3;
        [ForceUnroll]
        for (uint d = 0; d < DEEP; d++) {
            FragA a[FRAGS];
            [ForceUnroll]
            for (uint f = 0; f < FRAGS; f++) {
                a[f] = FragA.Load<CoopMatMatrixLayout.RowMajor>(given, times(origin + f * FRAG, IN) + d * FRAG, IN);
            }
            FragB b[ACROSS];
            [ForceUnroll]
            for (uint n = 0; n < ACROSS; n++) {
                b[n] = FragB.Load<CoopMatMatrixLayout.RowMajor>(
                    blocks, slice_at + ((tap * DEEP + d) * ACROSS + n) * FRAG * FRAG, FRAG);
            }
            [ForceUnroll]
            for (uint f = 0; f < FRAGS; f++) {
                [ForceUnroll]
                for (uint n = 0; n < ACROSS; n++) {
                    sums[f * ACROSS + n] = coopMatMulAdd<half, false>(a[f], b[n], sums[f * ACROSS + n]);
                }
            }
        }
    }

    let answered = (run_y * WIDE + run_x) * SLICE;
    [ForceUnroll]
    for (uint i = 0; i < HELD; i++) {
        let at = answered + (i / ACROSS) * FRAG * SLICE + (i % ACROSS) * FRAG;
        sums[i].Store<CoopMatMatrixLayout.RowMajor>(answers, at, SLICE);
    }
    GroupMemoryBarrierWithGroupSync();

    const uint QUADS = SLICE / 4;
    let first_channel = group.z * SLICE;
    let tile_left = group.x * WIDE;
    let tile_top = group.y * TALL;
    for (uint i = slot; i < WIDE * TALL * QUADS; i += THREADS) {
        let pixel = i / QUADS;
        let channel = (i % QUADS) * 4;
        let x = tile_left + pixel % WIDE;
        let y = tile_top + pixel / WIDE;
        if (x >= step.width || y >= step.height) { continue; }
        let fx = int(x) + step.left;
        let fy = int(y) + step.top;
        let inside = fx >= 0 && fy >= 0 && fx < int(step.frame_width) && fy < int(step.frame_height);
        var quad = vector<half, 4>(0.0);
        if (inside) {
            [ForceUnroll]
            for (uint k = 0; k < 4; k++) {
                let at = first_channel + channel + k;
                var value = float(answers[pixel * SLICE + channel + k]) + weights[step.bias_at + at];
                if (!LINEAR) { value = value >= 0.0 ? value : value * weights[step.slope_at + at]; }
                quad[k] = half(value);
            }
        }
        made[times((y + 1) * span + x + 1, OUT / 4) + (first_channel + channel) / 4] = quad;
    }
}

#define CONV(name, in, out, linear)                                               \
    [shader("compute")]                                                           \
    [numthreads(THREADS, 1, 1)]                                                   \
    void name(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)                \
    {                                                                             \
        conv<in, out, linear>(group, slot);                                       \
    }

CONV(coop_16_48, 16, 48, false)
CONV(coop_48_48, 48, 48, false)
CONV(coop_48_96, 48, 96, false)
CONV(coop_96_96, 96, 96, false)
CONV(coop_96_192, 96, 192, false)
CONV(coop_192_192, 192, 192, false)
CONV(coop_48_16, 48, 16, true)
