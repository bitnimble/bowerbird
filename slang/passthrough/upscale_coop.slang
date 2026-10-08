// The upscaler's 3x3 layers on a cooperative-matrix multiply, beside `slang/upscale.slang`'s WGSL,
// which packs the input and writes the answer for every arm.
//
// A 3x3 layer over an NHWC tensor is nine multiplies: for each tap, `A` is a run of pixels by the
// input channels, read where it lies with the channel count as its stride, `B` is that tap's
// weights, input channels by output channels, and every tap accumulates into the same pixels by
// output channels. No patch is gathered: a tap is the same run read a pixel or a row further on.
//
// `FRAGMENT` is the instruction's shape, 16 on Vulkan and 8 on Metal, as in `pmrid_coop.slang`.

using namespace linalg;

/// `Step` in `slang/upscale.slang`, field for field.
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
    uint planes_channels;
    uint inner_left;
    uint inner_top;
    uint inner_width;
    uint inner_height;
};

[vk::push_constant] ConstantBuffer<Step> step;
/// Each layer's taps a fragment at a time: tap, then input fragment, then output fragment.
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
/// A workgroup's tile is `WIDE` pixels by a `TALL` its entry point names, each subgroup a run of
/// one row of it.
static const uint WIDE = 64;
static const uint OUT_MOST = 48;

typealias FragA = CoopMat<half, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixA>;
typealias FragB = CoopMat<half, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixB>;
typealias Wide = CoopMat<float, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator>;
typealias Narrow = CoopMat<half, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator>;

// One for each accumulator, which stores as its own type: converting one is unavailable on Metal
// and an NV-only capability on SPIR-V. `float` answers stop at 2 rows, which is Metal's 32KB.
groupshared float answers_wide[WIDE * 2 * OUT_MOST];
groupshared half answers_narrow[WIDE * 4 * OUT_MOST];

/// One 3x3 layer, `IN` channels to `OUT`, accumulated in `float`, with its bias and, unless
/// `LINEAR`, its PReLU. Dispatched over the region's width in `WIDE` and its height in `TALL`.
void conv_wide<let IN : uint, let OUT : uint, let LINEAR : bool, let TALL : uint>(uint3 group, uint slot)
{
    const uint HELD = (WIDE * TALL / GANGS) / FRAG * OUT / FRAG;
    var sums: Wide[HELD];
    [ForceUnroll]
    for (uint i = 0; i < HELD; i++) { sums[i] = Wide(0.0); }
    multiply<float, IN, OUT, TALL>(group, slot, sums);
    let at = answered_at<OUT, TALL>(slot);
    [ForceUnroll]
    for (uint i = 0; i < HELD; i++) {
        sums[i].Store<CoopMatMatrixLayout.RowMajor>(answers_wide, at + fragment_at<OUT>(i), OUT);
    }
    GroupMemoryBarrierWithGroupSync();
    answer<OUT, LINEAR, true, TALL>(group, slot);
}

/// [`conv_wide`], accumulated in `half`.
void conv_narrow<let IN : uint, let OUT : uint, let LINEAR : bool, let TALL : uint>(uint3 group, uint slot)
{
    const uint HELD = (WIDE * TALL / GANGS) / FRAG * OUT / FRAG;
    var sums: Narrow[HELD];
    [ForceUnroll]
    for (uint i = 0; i < HELD; i++) { sums[i] = Narrow(half(0)); }
    multiply<half, IN, OUT, TALL>(group, slot, sums);
    let at = answered_at<OUT, TALL>(slot);
    [ForceUnroll]
    for (uint i = 0; i < HELD; i++) {
        sums[i].Store<CoopMatMatrixLayout.RowMajor>(answers_narrow, at + fragment_at<OUT>(i), OUT);
    }
    GroupMemoryBarrierWithGroupSync();
    answer<OUT, LINEAR, false, TALL>(group, slot);
}

/// Where a subgroup's run starts in the tile, as `(x, y)`.
uint2 run_at<let TALL : uint>(uint slot)
{
    let gang = slot / LANES;
    let runs_a_row = WIDE / (WIDE * TALL / GANGS);
    return uint2((gang % runs_a_row) * (WIDE * TALL / GANGS), gang / runs_a_row);
}

/// Where a subgroup's run starts among the workgroup's answers.
uint answered_at<let OUT : uint, let TALL : uint>(uint slot)
{
    let at = run_at<TALL>(slot);
    return (at.y * WIDE + at.x) * OUT;
}

/// Where accumulator `i` of a run starts within it.
uint fragment_at<let OUT : uint>(uint i)
{
    return (i / (OUT / FRAG)) * FRAG * OUT + (i % (OUT / FRAG)) * FRAG;
}

/// Every tap of a 3x3 layer into `sums`, a subgroup's run of pixels by every output channel.
void multiply<T : __BuiltinFloatingPointType, let IN : uint, let OUT : uint, let TALL : uint>(
    uint3 group, uint slot,
    inout CoopMat<T, MemoryScope.Subgroup, FRAG, FRAG, CoopMatMatrixUse.MatrixAccumulator> sums[(WIDE * TALL / GANGS) / FRAG * OUT / FRAG])
{
    const uint FRAGS = (WIDE * TALL / GANGS) / FRAG;
    const uint DEEP = IN / FRAG;
    const uint ACROSS = OUT / FRAG;

    let at = run_at<TALL>(slot);
    let left = group.x * WIDE + at.x;
    let top = group.y * TALL + at.y;
    let span = step.width + 2;

    [ForceUnroll]
    for (uint tap = 0; tap < 9; tap++) {
        // The ring puts the tap a pixel up and left of the output at the tensor's own origin.
        let origin = (top + tap / 3) * span + left + tap % 3;
        [ForceUnroll]
        for (uint d = 0; d < DEEP; d++) {
            FragA a[FRAGS];
            [ForceUnroll]
            for (uint f = 0; f < FRAGS; f++) {
                a[f] = FragA.Load<CoopMatMatrixLayout.RowMajor>(given, (origin + f * FRAG) * IN + d * FRAG, IN);
            }
            FragB b[ACROSS];
            [ForceUnroll]
            for (uint n = 0; n < ACROSS; n++) {
                b[n] = FragB.Load<CoopMatMatrixLayout.RowMajor>(
                    blocks, step.weights_at + ((tap * DEEP + d) * ACROSS + n) * FRAG * FRAG, FRAG);
            }
            [ForceUnroll]
            for (uint f = 0; f < FRAGS; f++) {
                [ForceUnroll]
                for (uint n = 0; n < ACROSS; n++) {
                    sums[f * ACROSS + n] = coopMatMulAdd<T, false>(a[f], b[n], sums[f * ACROSS + n]);
                }
            }
        }
    }
}

/// The workgroup's answers into `made`, with the bias, the PReLU and the frame's edge, 4 channels
/// to a thread at a time.
void answer<let OUT : uint, let LINEAR : bool, let WIDE_SUMS : bool, let TALL : uint>(uint3 group, uint slot)
{
    const uint QUADS = OUT / 4;
    let left = group.x * WIDE;
    let top = group.y * TALL;
    let span = step.width + 2;
    for (uint i = slot; i < WIDE * TALL * QUADS; i += THREADS) {
        let pixel = i / QUADS;
        let channel = (i % QUADS) * 4;
        let x = left + pixel % WIDE;
        let y = top + pixel / WIDE;
        if (x >= step.width || y >= step.height) { continue; }
        let fx = int(x) + step.left;
        let fy = int(y) + step.top;
        let inside = fx >= 0 && fy >= 0 && fx < int(step.frame_width) && fy < int(step.frame_height);
        var quad = vector<half, 4>(0.0);
        if (inside) {
            [ForceUnroll]
            for (uint k = 0; k < 4; k++) {
                let cell = pixel * OUT + channel + k;
                var value = (WIDE_SUMS ? answers_wide[cell] : float(answers_narrow[cell]))
                    + weights[step.bias_at + channel + k];
                if (!LINEAR) { value = value >= 0.0 ? value : value * weights[step.slope_at + channel + k]; }
                quad[k] = half(value);
            }
        }
        made[((y + 1) * span + x + 1) * QUADS + channel / 4] = quad;
    }
}

/// Winograd's F(2x2, 3x3): each 2x2 of output from a 4x4 of input, as 16 multiplies of the
/// transformed input by the transformed taps, one for each of the 4x4's places, `B^T d B` and
/// `G g G^T` in, `A^T m A` out. 9216 multiply-adds a pixel of a 48 to 48 layer where the direct
/// layer is 20736.
///
/// A workgroup is 8 by 2 tiles, which is 16 by 4 pixels, and the 16 tiles are the multiply's rows;
/// each subgroup carries 4 of the places. The input is transformed `WINO_CHUNK` channels at a time
/// into `transformed`, and the answers, every place of every tile, are held there afterwards for
/// the transform out.
static const uint WINO_WIDE = 8;
static const uint WINO_TALL = 2;
static const uint WINO_TILES = WINO_WIDE * WINO_TALL;
static const uint WINO_CHUNK = 16;
static const uint WINO_PLACES_A_GANG = 16 / GANGS;
groupshared half transformed[16 * WINO_TILES * OUT_MOST];

void winograd<let IN : uint, let OUT : uint, let LINEAR : bool>(uint3 group, uint slot)
{
    const uint ROWS = WINO_TILES / FRAG;
    const uint ACROSS = OUT / FRAG;
    const uint DEEP = WINO_CHUNK / FRAG;
    const uint HELD = WINO_PLACES_A_GANG * ROWS * ACROSS;
    let gang = slot / LANES;
    let span = step.width + 2;
    let left = group.x * WINO_WIDE * 2;
    let top = group.y * WINO_TALL * 2;

    var sums: Narrow[HELD];
    [ForceUnroll]
    for (uint i = 0; i < HELD; i++) { sums[i] = Narrow(half(0)); }

    for (uint from = 0; from < IN; from += WINO_CHUNK) {
        for (uint i = slot; i < WINO_TILES * WINO_CHUNK; i += THREADS) {
            let channel = i % WINO_CHUNK;
            let tile = i / WINO_CHUNK;
            // The ring puts the 4x4 a pixel up and left of the tile at the tensor's own origin.
            let x = left + (tile % WINO_WIDE) * 2;
            let y = top + (tile / WINO_WIDE) * 2;
            half d[16];
            [ForceUnroll]
            for (uint k = 0; k < 16; k++) {
                d[k] = given[((y + k / 4) * span + x + k % 4) * IN + from + channel];
            }
            half t[16];
            [ForceUnroll]
            for (uint c = 0; c < 4; c++) {
                t[c] = d[c] - d[8 + c];
                t[4 + c] = d[4 + c] + d[8 + c];
                t[8 + c] = d[8 + c] - d[4 + c];
                t[12 + c] = d[4 + c] - d[12 + c];
            }
            [ForceUnroll]
            for (uint r = 0; r < 4; r++) {
                let v0 = t[r * 4] - t[r * 4 + 2];
                let v1 = t[r * 4 + 1] + t[r * 4 + 2];
                let v2 = t[r * 4 + 2] - t[r * 4 + 1];
                let v3 = t[r * 4 + 1] - t[r * 4 + 3];
                let at = tile * WINO_CHUNK + channel;
                transformed[(r * 4) * WINO_TILES * WINO_CHUNK + at] = v0;
                transformed[(r * 4 + 1) * WINO_TILES * WINO_CHUNK + at] = v1;
                transformed[(r * 4 + 2) * WINO_TILES * WINO_CHUNK + at] = v2;
                transformed[(r * 4 + 3) * WINO_TILES * WINO_CHUNK + at] = v3;
            }
        }
        GroupMemoryBarrierWithGroupSync();

        [ForceUnroll]
        for (uint p = 0; p < WINO_PLACES_A_GANG; p++) {
            let place = gang * WINO_PLACES_A_GANG + p;
            [ForceUnroll]
            for (uint d = 0; d < DEEP; d++) {
                FragA a[ROWS];
                [ForceUnroll]
                for (uint r = 0; r < ROWS; r++) {
                    a[r] = FragA.Load<CoopMatMatrixLayout.RowMajor>(
                        transformed, (place * WINO_TILES + r * FRAG) * WINO_CHUNK + d * FRAG, WINO_CHUNK);
                }
                [ForceUnroll]
                for (uint n = 0; n < ACROSS; n++) {
                    let k = (from + d * FRAG) / FRAG;
                    let b = FragB.Load<CoopMatMatrixLayout.RowMajor>(
                        blocks, step.weights_at + ((place * (IN / FRAG) + k) * ACROSS + n) * FRAG * FRAG, FRAG);
                    [ForceUnroll]
                    for (uint r = 0; r < ROWS; r++) {
                        let s = (p * ROWS + r) * ACROSS + n;
                        sums[s] = coopMatMulAdd<half, false>(a[r], b, sums[s]);
                    }
                }
            }
        }
        GroupMemoryBarrierWithGroupSync();
    }

    [ForceUnroll]
    for (uint p = 0; p < WINO_PLACES_A_GANG; p++) {
        let place = gang * WINO_PLACES_A_GANG + p;
        [ForceUnroll]
        for (uint r = 0; r < ROWS; r++) {
            [ForceUnroll]
            for (uint n = 0; n < ACROSS; n++) {
                sums[(p * ROWS + r) * ACROSS + n].Store<CoopMatMatrixLayout.RowMajor>(
                    transformed, (place * WINO_TILES + r * FRAG) * OUT + n * FRAG, OUT);
            }
        }
    }
    GroupMemoryBarrierWithGroupSync();

    const uint QUADS = OUT / 4;
    for (uint i = slot; i < WINO_TILES * QUADS; i += THREADS) {
        let tile = i / QUADS;
        let channel = (i % QUADS) * 4;
        float4 out[4];
        [ForceUnroll]
        for (uint k = 0; k < 4; k++) {
            float m[16];
            [ForceUnroll]
            for (uint place = 0; place < 16; place++) {
                m[place] = float(transformed[(place * WINO_TILES + tile) * OUT + channel + k]);
            }
            float s[8];
            [ForceUnroll]
            for (uint c = 0; c < 4; c++) {
                s[c] = m[c] + m[4 + c] + m[8 + c];
                s[4 + c] = m[4 + c] - m[8 + c] - m[12 + c];
            }
            [ForceUnroll]
            for (uint r = 0; r < 2; r++) {
                out[r * 2][k] = s[r * 4] + s[r * 4 + 1] + s[r * 4 + 2];
                out[r * 2 + 1][k] = s[r * 4 + 1] - s[r * 4 + 2] - s[r * 4 + 3];
            }
        }
        [ForceUnroll]
        for (uint q = 0; q < 4; q++) {
            let x = left + (tile % WINO_WIDE) * 2 + q % 2;
            let y = top + (tile / WINO_WIDE) * 2 + q / 2;
            if (x >= step.width || y >= step.height) { continue; }
            let fx = int(x) + step.left;
            let fy = int(y) + step.top;
            let inside = fx >= 0 && fy >= 0 && fx < int(step.frame_width) && fy < int(step.frame_height);
            var quad = vector<half, 4>(0.0);
            if (inside) {
                [ForceUnroll]
                for (uint k = 0; k < 4; k++) {
                    var value = out[q][k] + weights[step.bias_at + channel + k];
                    if (!LINEAR) { value = value >= 0.0 ? value : value * weights[step.slope_at + channel + k]; }
                    quad[k] = half(value);
                }
            }
            made[((y + 1) * span + x + 1) * QUADS + channel / 4] = quad;
        }
    }
}

#define WINOGRAD(name, in, out, linear)                                           \
    [shader("compute")]                                                           \
    [numthreads(THREADS, 1, 1)]                                                   \
    void name(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)                \
    {                                                                             \
        winograd<in, out, linear>(group, slot);                                   \
    }

WINOGRAD(wino_16_48, 16, 48, false)
WINOGRAD(wino_48_48, 48, 48, false)
WINOGRAD(wino_48_16, 48, 16, true)

#define ENTRY(name, conv, in, out, linear, tall)                                  \
    [shader("compute")]                                                           \
    [numthreads(THREADS, 1, 1)]                                                   \
    void name(uint3 group : SV_GroupID, uint slot : SV_GroupIndex)                \
    {                                                                             \
        conv<in, out, linear, tall>(group, slot);                                 \
    }

#define LAYERS(accumulated, tall)                                                            \
    ENTRY(coop_16_48_##accumulated##_##tall, conv_##accumulated, 16, 48, false, tall)        \
    ENTRY(coop_48_48_##accumulated##_##tall, conv_##accumulated, 48, 48, false, tall)        \
    ENTRY(coop_48_16_##accumulated##_##tall, conv_##accumulated, 48, 16, true, tall)

LAYERS(wide, 1)
LAYERS(wide, 2)
LAYERS(narrow, 1)
LAYERS(narrow, 2)
LAYERS(narrow, 4)
