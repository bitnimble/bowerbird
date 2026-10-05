// The chroma lattice's moments, accumulated where the pairs already are.
//
// A pair lands on the sixteen corners of its cell, and there are thousands of nodes of `NODE_WORDS`
// sums. No thread can hold a private copy of that, and WGSL has no float atomic - so the pairs are
// binned by the cell they fall in first, and the fold then reads each cell once per corner it feeds.
//
// **A thread is a (slice, corner): `SLICE` landings of one cell, fed to one of its corners.** A
// cell's run is as long as its share of the frame, and a dark frame puts most of its pairs in one
// shadow cell, so no thread walks a whole run.
//
// The grid is polar (`hdr_fit::GridShape`): hue wraps, so it has as many cells as nodes, and its
// first chroma ring is grey, which the host merges across hues before solving.

import prelude;
import times;
import light;
import index_space;

struct Params {
    /// Pairs the lattice was given, and how many one thread of the scan walks.
    int pairs;
    int block;
    int blocks;
    uint space;
    /// Nodes along hue, chroma, lightness and neighbourhood.
    int hue_nodes;
    int chroma_nodes;
    int level_nodes;
    int neighbourhood_nodes;
    /// Node gaps per unit of each lattice coordinate, and where lightness starts.
    float chroma_scale;
    float level_low;
    float level_scale;
    float neighbourhood_scale;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Per pair, what the operator acts on: the sample through the model so far, its luma fourth.
[vk::binding(0, 0)] StructuredBuffer<float4> through;
/// Per pair, the camera's rendering in the render's own linear Rec.2020.
[vk::binding(1, 0)] StructuredBuffer<float4> target;
/// Per pair, how bright its neighbourhood is.
[vk::binding(2, 0)] StructuredBuffer<float> neighbourhood;
/// Per pair, the weight its hue bucket earned it.
[vk::binding(3, 0)] StructuredBuffer<float> weights;
/// Per landing: the cell it fell in, then the eleven floats a node reads off it.
[vk::binding(4, 0)] RWStructuredBuffer<float> landed;
/// Landings per (block, cell), then where each block's run inside a cell starts, then each cell's
/// cumulative end, then each cell's cumulative end in slices.
[vk::binding(5, 0)] RWStructuredBuffer<uint> counts;
/// Each cell's landings, in pair order, as indices into `landed`.
[vk::binding(6, 0)] RWStructuredBuffer<uint> ordered;
/// Per (slice, corner), `NODE_WORDS` sums, which `lat_fold` adds up.
[vk::binding(7, 0)] RWStructuredBuffer<float> corners;
/// Per node, `NODE_WORDS` sums.
[vk::binding(8, 0)] RWStructuredBuffer<float> moments;
/// Per pair, the colour the lattice is indexed by: the sample through the tone stage and the
/// matrix. `through` itself, unless the pass fits on what an earlier lattice left.
[vk::binding(9, 0)] StructuredBuffer<float4> indexed;

/// Corners of a cell, which is how many cells a node is a corner of.
static const int CORNERS = 16;

/// Words a landing occupies: its cell, its four fractions, its input, its target, the camera's
/// luma, and its weight.
static const int LANDING_WORDS = 12;
/// Sums a node carries: `ata` 9, `atb` 6, `sx` 3, `st` 2, `btb`, `lta`, `ltb`, `lda` 2, `seen`,
/// then the residual-weighted offset from the node and its square on each of the four axes, and
/// the residual weight they were taken under.
static const int NODE_WORDS = 35;
static const int REACH_WORDS = 26;
/// Landings one gathering thread walks at most.
static const int SLICE = 256;

int nodes() { return pc.hue_nodes * pc.chroma_nodes * pc.level_nodes * pc.neighbourhood_nodes; }
int cells()
{
    return pc.hue_nodes * (pc.chroma_nodes - 1) * (pc.level_nodes - 1)
        * (pc.neighbourhood_nodes - 1);
}

/// Where the cells' ends, in landings and in slices, start in `counts`.
int ends() { return 2 * pc.blocks * cells(); }
int slice_ends() { return 2 * pc.blocks * cells() + cells(); }

/// A cell's run of landings in `ordered`.
uint2 run_of(int cell)
{
    return uint2(cell == 0 ? 0u : counts[ends() + cell - 1], counts[ends() + cell]);
}

/// A cell's run of slices.
uint2 slices_of(int cell)
{
    return uint2(cell == 0 ? 0u : counts[slice_ends() + cell - 1], counts[slice_ends() + cell]);
}

int cell_index(int h, int r, int z, int s)
{
    return ((s * (pc.level_nodes - 1) + z) * (pc.chroma_nodes - 1) + r) * pc.hue_nodes + h;
}

/// The cell a corner of a node lies across, or -1 past the lattice's edge. `which`'s bits say which
/// side on each axis, and a node is a cell's corner where the same bits are set. Hue wraps.
int cell_toward(int node, int which)
{
    let h = node % pc.hue_nodes;
    let r = (node / pc.hue_nodes) % pc.chroma_nodes;
    let z = (node / (pc.hue_nodes * pc.chroma_nodes)) % pc.level_nodes;
    let s = node / (pc.hue_nodes * pc.chroma_nodes * pc.level_nodes);
    let ch = (h - (which & 1) + pc.hue_nodes) % pc.hue_nodes;
    let cr = r - ((which >> 1) & 1);
    let cz = z - ((which >> 2) & 1);
    let cs = s - ((which >> 3) & 1);
    let inside = cr >= 0 && cr < pc.chroma_nodes - 1 && cz >= 0 && cz < pc.level_nodes - 1
        && cs >= 0 && cs < pc.neighbourhood_nodes - 1;
    return inside ? cell_index(ch, cr, cz, cs) : -1;
}

/// Where a coordinate sits on an axis running up from `low`, and how far past.
///
/// `max` then `min` rather than a clamp, as the host has it: those return whichever operand is not
/// NaN, so a NaN arriving here lands on a node instead of propagating into an index.
void axis_at(float value, int nodes, float low, float scale, out int below, out float fraction)
{
    let t = min(max((value - low) * scale, 0.0), float(nodes - 1));
    below = min(int(t), nodes - 2);
    fraction = t - float(below);
}

/// The cell a sample falls in, and its fractions across it.
int cell_at(float4 at, out float4 fraction)
{
    let turns = at.x * float(pc.hue_nodes);
    let h = min(int(turns), pc.hue_nodes - 1);
    fraction.x = turns - float(h);
    int r;
    int z;
    int s;
    axis_at(at.y, pc.chroma_nodes, 0.0, pc.chroma_scale, r, fraction.y);
    axis_at(at.z, pc.level_nodes, pc.level_low, pc.level_scale, z, fraction.z);
    axis_at(at.w, pc.neighbourhood_nodes, 0.0, pc.neighbourhood_scale, s, fraction.w);
    return cell_index(h, r, z, s);
}

/// Every pair as a landing: the cell it falls in and what it brings there.
[shader("compute")]
[numthreads(64, 1, 1)]
void lat_land(uint3 id: SV_DispatchThreadID)
{
    let k = int(id.x);
    if (k >= pc.pairs) { return; }
    let m = through[k];
    let t = target[k];
    let ours = m.w;
    let theirs = dot(LUMA, t.xyz);
    let at = lattice_at(
        opponent_of(measured<Rendered>(indexed[k].xyz), pc.space), neighbourhood[k]);
    float4 fraction;
    let cell = cell_at(at, fraction);

    let base = times(k, LANDING_WORDS);
    landed[base] = float(cell);
    landed[base + 1] = fraction.x;
    landed[base + 2] = fraction.y;
    landed[base + 3] = fraction.z;
    landed[base + 4] = fraction.w;
    landed[base + 5] = m.x - ours;
    landed[base + 6] = m.z - ours;
    landed[base + 7] = ours;
    landed[base + 8] = t.x - theirs;
    landed[base + 9] = t.z - theirs;
    landed[base + 10] = theirs;
    landed[base + 11] = weights[k];
}

/// Landings per (block, cell). One thread a block, walking its own pairs.
[shader("compute")]
[numthreads(64, 1, 1)]
void lat_count(uint3 id: SV_DispatchThreadID)
{
    let b = int(id.x);
    if (b >= pc.blocks) { return; }
    let cells = cells();
    for (int c = 0; c < cells; c++) { counts[b * cells + c] = 0u; }
    let first = b * pc.block;
    let last = min(first + pc.block, pc.pairs);
    for (int k = first; k < last; k++) {
        let cell = int(landed[times(k, LANDING_WORDS)]);
        counts[b * cells + cell] = counts[b * cells + cell] + 1u;
    }
}

/// Each cell's own total, a thread a cell.
///
/// Its own pass because the prefix below needs every one of them, and computing each cell's base
/// by re-summing the cells before it is quadratic in the lattice.
[shader("compute")]
[numthreads(64, 1, 1)]
void lat_total(uint3 id: SV_DispatchThreadID)
{
    let cell = int(id.x);
    let cells = cells();
    if (cell >= cells) { return; }
    var total = 0u;
    for (int b = 0; b < pc.blocks; b++) {
        total += counts[b * cells + cell];
    }
    counts[ends() + cell] = total;
}

/// Where each cell's run ends, in landings and in slices. One lane, because a prefix is what it
/// is - but over the cells rather than over every pair.
[shader("compute")]
[numthreads(1, 1, 1)]
void lat_scan()
{
    var base = 0u;
    var sliced = 0u;
    let cells = cells();
    for (int cell = 0; cell < cells; cell++) {
        let total = counts[ends() + cell];
        base += total;
        sliced += (total + uint(SLICE) - 1u) / uint(SLICE);
        counts[ends() + cell] = base;
        counts[slice_ends() + cell] = sliced;
    }
}

/// Where each block's run inside a cell starts, so the compaction below keeps pair order.
///
/// A thread a cell, blocks in order: that is what makes a cell's run the pairs in the order a
/// serial walk would have met them, which is what the fold's determinism rests on.
[shader("compute")]
[numthreads(64, 1, 1)]
void lat_starts(uint3 id: SV_DispatchThreadID)
{
    let cell = int(id.x);
    let cells = cells();
    if (cell >= cells) { return; }
    var seen = run_of(cell).x;
    for (int b = 0; b < pc.blocks; b++) {
        let kept = counts[b * cells + cell];
        counts[pc.blocks * cells + b * cells + cell] = seen;
        seen += kept;
    }
}

[shader("compute")]
[numthreads(64, 1, 1)]
void lat_write(uint3 id: SV_DispatchThreadID)
{
    let b = int(id.x);
    if (b >= pc.blocks) { return; }
    let cells = cells();
    let first = b * pc.block;
    let last = min(first + pc.block, pc.pairs);
    for (int k = first; k < last; k++) {
        let cell = int(landed[times(k, LANDING_WORDS)]);
        let slot = counts[pc.blocks * cells + b * cells + cell];
        ordered[int(slot)] = uint(k);
        counts[pc.blocks * cells + b * cells + cell] = slot + 1u;
    }
}

/// One slice of one cell, summed for one of its corners.
[shader("compute")]
[numthreads(64, 1, 1)]
void lat_gather(uint3 id: SV_DispatchThreadID)
{
    let which = int(id.x) % CORNERS;
    let piece = id.x / uint(CORNERS);
    let cells = cells();
    if (piece >= counts[slice_ends() + cells - 1]) { return; }
    // The first cell whose slices end past this one.
    var low = 0;
    var high = cells - 1;
    while (low < high) {
        let middle = (low + high) / 2;
        if (counts[slice_ends() + middle] > piece) { high = middle; } else { low = middle + 1; }
    }
    let run = run_of(low);
    let from = run.x + (piece - slices_of(low).x) * uint(SLICE);
    let to = min(from + uint(SLICE), run.y);
    let side = float4(
        float(which & 1), float((which >> 1) & 1), float((which >> 2) & 1), float((which >> 3) & 1));

    float sums[NODE_WORDS];
    for (int i = 0; i < NODE_WORDS; i++) { sums[i] = 0.0; }
    for (uint at = from; at < to; at++) {
        let base = times(int(ordered[int(at)]), LANDING_WORDS);
        let f = float4(landed[base + 1], landed[base + 2], landed[base + 3], landed[base + 4]);
        // The bake's smootherstep tent (`lattice_bake.slang`), so a node is solved under the
        // weights it renders with.
        let eased = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        let w = lerp(float4(1.0) - eased, eased, side);
        let sw = landed[base + 11] * (w.x * w.y * w.z * w.w);
        if (!(sw > 0.0)) { continue; }

        let input = float3(landed[base + 5], landed[base + 6], landed[base + 7]);
        let tgt = float2(landed[base + 8], landed[base + 9]);
        let theirs = landed[base + 10];
        let ours = input.z;

        for (int a = 0; a < 2; a++) {
            for (int b = 0; b < 3; b++) {
                sums[9 + times(a, 3) + b] += sw * input[b] * tgt[a];
            }
        }
        for (int a = 0; a < 3; a++) {
            for (int b = 0; b < 3; b++) {
                sums[times(a, 3) + b] += sw * input[a] * input[b];
            }
            sums[15 + a] += sw * input[a];
        }
        for (int a = 0; a < 2; a++) {
            sums[18 + a] += sw * tgt[a];
        }
        sums[20] += sw * (tgt.x * tgt.x + tgt.y * tgt.y);
        sums[21] += sw * ours * ours;
        sums[22] += sw * ours * theirs;
        sums[23] += sw * input.x * theirs;
        sums[24] += sw * input.y * theirs;
        sums[25] += sw;

        // Where what the node has left to correct sits about it, in node gaps: the kernel's reach
        // is sized off this, so a correction that only one tight colour asked for reaches no further.
        let residual = sw * (length(tgt - input.xy) + abs(theirs - ours));
        let offset = f - side;
        for (int a = 0; a < 4; a++) {
            sums[REACH_WORDS + a] += residual * offset[a];
            sums[REACH_WORDS + 4 + a] += residual * offset[a] * offset[a];
        }
        sums[REACH_WORDS + 8] += residual;
    }

    for (int i = 0; i < NODE_WORDS; i++) {
        corners[int(id.x) * NODE_WORDS + i] = sums[i];
    }
}

/// A node's sixteen corners added in corner order, each cell's slices in pair order, which is what
/// makes the answer the same on every adapter.
///
/// A thread a (node, sum): a shadow cell's run is hundreds of slices long, and one thread carrying
/// all of a node's sums down it keeps them in memory rather than in a register.
[shader("compute")]
[numthreads(64, 1, 1)]
void lat_fold(uint3 id: SV_DispatchThreadID)
{
    let node = int(id.x) / NODE_WORDS;
    let word = int(id.x) % NODE_WORDS;
    if (node >= nodes()) { return; }
    var sum = 0.0;
    for (int c = 0; c < CORNERS; c++) {
        let cell = cell_toward(node, c);
        if (cell < 0) { continue; }
        let slices = slices_of(cell);
        for (uint piece = slices.x; piece < slices.y; piece++) {
            sum += corners[(int(piece) * CORNERS + c) * NODE_WORDS + word];
        }
    }
    moments[int(id.x)] = sum;
}
