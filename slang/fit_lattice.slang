// The chroma lattice's moments, accumulated where the pairs already are.
//
// **This one could not be a straight substitution like `fit_moments`.** A pair does not land on
// one accumulator, it lands on the sixteen corners of its cell, and there are 1323 nodes of 26
// sums. No thread can hold a private copy of that, and WGSL has no float atomic - so the pairs are
// binned by the cell they fall in first, and the fold then reads each cell once per corner it
// feeds. Every landing is visited the sixteen times it was always going to reach, rather than
// scattered into sixteen places at once.
//
// **A thread is a (node, corner), not a node.** One thread a node is 1323 of them, which leaves a
// GPU with thousands of lanes idle and made the whole fit 430ms slower than reading the samples
// back; one thread per corner of every node is 21k, each walking one cell's run. What that gives
// up is the host's summation order - a node's terms now arrive cell by cell rather than pair by
// pair - so this is a different sum from the one the old `landed_on` wrote.

import prelude;

struct Params {
    /// Pairs the lattice was given, and how many one thread of the scan walks.
    int pairs;
    int block;
    int blocks;
    /// Where the chroma axes sit for this frame: `LatticeAxes`, one low and one scale an axis.
    float low0;
    float scale0;
    float low1;
    float scale1;
    float level_scale;
    float surround_scale;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Per pair, the sample through the tone stage and the matrix, with its luma fourth.
[vk::binding(0, 0)] StructuredBuffer<float4> through;
/// Per pair, the camera's rendering in the render's own linear Rec.2020.
[vk::binding(1, 0)] StructuredBuffer<float4> target;
/// Per pair, the surround its neighbourhood carries.
[vk::binding(2, 0)] StructuredBuffer<float> surround;
/// Per pair, the weight its hue bucket earned it.
[vk::binding(3, 0)] StructuredBuffer<float> weights;
/// Per landing: the cell it fell in, then the eleven floats a node reads off it.
[vk::binding(4, 0)] RWStructuredBuffer<float> landed;
/// Landings per (block, cell), then where each block's run inside a cell starts, then each cell's
/// cumulative end.
[vk::binding(5, 0)] RWStructuredBuffer<uint> counts;
/// Each cell's landings, in pair order, as indices into `landed`.
[vk::binding(6, 0)] RWStructuredBuffer<uint> ordered;
/// Per (node, corner), `NODE_WORDS` sums, which `lat_fold` adds up.
[vk::binding(7, 0)] RWStructuredBuffer<float> corners;
/// Per node, `NODE_WORDS` sums.
[vk::binding(8, 0)] RWStructuredBuffer<float> moments;

/// `hdr_fit`'s lattice, which every index here is built from.
static const int MAP_CHROMA = 7;
static const int MAP_LEVEL = 9;
static const int MAP_SURROUND = 3;
static const int MAP_NODES = MAP_CHROMA * MAP_CHROMA * MAP_LEVEL * MAP_SURROUND;
/// Cells are one fewer than nodes on every axis: a cell is the gap between two of them.
static const int CELLS =
    (MAP_CHROMA - 1) * (MAP_CHROMA - 1) * (MAP_LEVEL - 1) * (MAP_SURROUND - 1);
/// Corners of a cell, which is how many cells a node is a corner of.
static const int CORNERS = 16;

/// Words a landing occupies: its cell, its four fractions, its input, its target, the camera's
/// luma, and its weight.
static const int LANDING_WORDS = 12;
/// Sums a node carries: `ata` 9, `atb` 6, `sx` 3, `st` 2, `btb`, `lta`, `lda` 2, `ltb`, `seen`.
static const int NODE_WORDS = 26;

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

/// Chroma to the space the axes are laid out in: signed root, so the nodes go where the colours
/// are. `colour.slang` warps identically.
float warp(float d) { return sign(d) * sqrt(abs(d)); }

/// The cell a sample falls in, and its fractions across it.
int cell_at(float level, float surround_of, float d0, float d2, out float4 fraction)
{
    int x;
    int y;
    int z;
    int s;
    axis_at(warp(d0), MAP_CHROMA, pc.low0, pc.scale0, x, fraction.x);
    // Square root rather than the level itself, so the shadows get nodes in proportion to how much
    // of a picture lives in them. The surround takes the same root for the same reason.
    axis_at(warp(d2), MAP_CHROMA, pc.low1, pc.scale1, y, fraction.y);
    axis_at(sqrt(max(level, 0.0)), MAP_LEVEL, 0.0, pc.level_scale, z, fraction.z);
    axis_at(sqrt(max(surround_of, 0.0)), MAP_SURROUND, 0.0, pc.surround_scale, s, fraction.w);
    return ((s * (MAP_LEVEL - 1) + z) * (MAP_CHROMA - 1) + y) * (MAP_CHROMA - 1) + x;
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
    let d0 = m.x - ours;
    let d2 = m.z - ours;
    float4 fraction;
    let cell = cell_at(ours, surround[k], d0, d2, fraction);

    let at = k * LANDING_WORDS;
    landed[at] = float(cell);
    landed[at + 1] = fraction.x;
    landed[at + 2] = fraction.y;
    landed[at + 3] = fraction.z;
    landed[at + 4] = fraction.w;
    landed[at + 5] = d0;
    landed[at + 6] = d2;
    landed[at + 7] = ours;
    landed[at + 8] = t.x - theirs;
    landed[at + 9] = t.z - theirs;
    landed[at + 10] = theirs;
    landed[at + 11] = weights[k];
}

/// Landings per (block, cell). One thread a block, walking its own pairs.
[shader("compute")]
[numthreads(64, 1, 1)]
void lat_count(uint3 id: SV_DispatchThreadID)
{
    let b = int(id.x);
    if (b >= pc.blocks) { return; }
    for (int c = 0; c < CELLS; c++) { counts[b * CELLS + c] = 0u; }
    let first = b * pc.block;
    let last = min(first + pc.block, pc.pairs);
    for (int k = first; k < last; k++) {
        let cell = int(landed[k * LANDING_WORDS]);
        counts[b * CELLS + cell] = counts[b * CELLS + cell] + 1u;
    }
}

/// Each cell's own total, a thread a cell.
///
/// Its own pass because the prefix below needs every one of them, and computing each cell's base
/// by re-summing the cells before it is quadratic in the lattice - measurably so, at a cell count
/// this size.
[shader("compute")]
[numthreads(64, 1, 1)]
void lat_total(uint3 id: SV_DispatchThreadID)
{
    let cell = int(id.x);
    if (cell >= CELLS) { return; }
    var total = 0u;
    for (int b = 0; b < pc.blocks; b++) {
        total += counts[b * CELLS + cell];
    }
    counts[2 * pc.blocks * CELLS + cell] = total;
}

/// Where each block's run inside each cell starts, so the compaction below keeps pair order.
///
/// A cell at a time, blocks in order: that is what makes a cell's run the pairs in the order a
/// serial walk would have met them, which is what the fold's determinism rests on. One lane,
/// because a prefix is what it is - but over the cells rather than over every pair.
[shader("compute")]
[numthreads(1, 1, 1)]
void lat_scan()
{
    var base = 0u;
    for (int cell = 0; cell < CELLS; cell++) {
        let total = counts[2 * pc.blocks * CELLS + cell];
        var seen = base;
        for (int b = 0; b < pc.blocks; b++) {
            let kept = counts[b * CELLS + cell];
            counts[pc.blocks * CELLS + b * CELLS + cell] = seen;
            seen += kept;
        }
        base += total;
        // The cell's end, which the fold reads as the run's bound.
        counts[2 * pc.blocks * CELLS + cell] = base;
    }
}

[shader("compute")]
[numthreads(64, 1, 1)]
void lat_write(uint3 id: SV_DispatchThreadID)
{
    let b = int(id.x);
    if (b >= pc.blocks) { return; }
    let first = b * pc.block;
    let last = min(first + pc.block, pc.pairs);
    for (int k = first; k < last; k++) {
        let cell = int(landed[k * LANDING_WORDS]);
        let slot = counts[pc.blocks * CELLS + b * CELLS + cell];
        ordered[int(slot)] = uint(k);
        counts[pc.blocks * CELLS + b * CELLS + cell] = slot + 1u;
    }
}

/// One corner of one node: the cell that reaches this node through that corner, summed.
///
/// Twenty-one thousand threads rather than the lattice's thirteen hundred, which is the whole
/// reason this is split by corner at all.
[shader("compute")]
[numthreads(64, 1, 1)]
void lat_gather(uint3 id: SV_DispatchThreadID)
{
    let slot = int(id.x);
    if (slot >= MAP_NODES * CORNERS) { return; }
    let node = slot / CORNERS;
    let which = slot % CORNERS;

    let nx = node % MAP_CHROMA;
    let ny = (node / MAP_CHROMA) % MAP_CHROMA;
    let nz = (node / (MAP_CHROMA * MAP_CHROMA)) % MAP_LEVEL;
    let ns = node / (MAP_CHROMA * MAP_CHROMA * MAP_LEVEL);
    // Which way this corner lies from the node, which is the cell on that side.
    let cx = nx - (which & 1);
    let cy = ny - ((which >> 1) & 1);
    let cz = nz - ((which >> 2) & 1);
    let cs = ns - ((which >> 3) & 1);

    float sums[NODE_WORDS];
    for (int i = 0; i < NODE_WORDS; i++) { sums[i] = 0.0; }

    let inside = cx >= 0 && cx < MAP_CHROMA - 1 && cy >= 0 && cy < MAP_CHROMA - 1
        && cz >= 0 && cz < MAP_LEVEL - 1 && cs >= 0 && cs < MAP_SURROUND - 1;
    if (inside) {
        let cell = ((cs * (MAP_LEVEL - 1) + cz) * (MAP_CHROMA - 1) + cy) * (MAP_CHROMA - 1) + cx;
        let from = cell == 0 ? 0u : counts[2 * pc.blocks * CELLS + cell - 1];
        let to = counts[2 * pc.blocks * CELLS + cell];
        for (uint at = from; at < to; at++) {
            let base = int(ordered[int(at)]) * LANDING_WORDS;
            let fx = landed[base + 1];
            let fy = landed[base + 2];
            let fz = landed[base + 3];
            let fs = landed[base + 4];
            // The share this corner takes, which is `nodes_of`'s weight for it.
            let wx = (which & 1) != 0 ? fx : 1.0 - fx;
            let wy = ((which >> 1) & 1) != 0 ? fy : 1.0 - fy;
            let wz = ((which >> 2) & 1) != 0 ? fz : 1.0 - fz;
            let ws = ((which >> 3) & 1) != 0 ? fs : 1.0 - fs;
            let sw = landed[base + 11] * (ws * wz * wy * wx);
            if (!(sw > 0.0)) { continue; }

            let input = float3(landed[base + 5], landed[base + 6], landed[base + 7]);
            let tgt = float2(landed[base + 8], landed[base + 9]);
            let theirs = landed[base + 10];
            let ours = input.z;

            for (int a = 0; a < 2; a++) {
                for (int b = 0; b < 3; b++) {
                    sums[9 + a * 3 + b] += sw * input[b] * tgt[a];
                }
            }
            for (int a = 0; a < 3; a++) {
                for (int b = 0; b < 3; b++) {
                    sums[a * 3 + b] += sw * input[a] * input[b];
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
        }
    }

    for (int i = 0; i < NODE_WORDS; i++) {
        corners[slot * NODE_WORDS + i] = sums[i];
    }
}

/// A node's sixteen corners added in corner order, which is what makes the answer the same on
/// every adapter.
[shader("compute")]
[numthreads(64, 1, 1)]
void lat_fold(uint3 id: SV_DispatchThreadID)
{
    let node = int(id.x);
    if (node >= MAP_NODES) { return; }
    for (int i = 0; i < NODE_WORDS; i++) {
        var total = 0.0;
        for (int c = 0; c < CORNERS; c++) {
            total += corners[(node * CORNERS + c) * NODE_WORDS + i];
        }
        moments[node * NODE_WORDS + i] = total;
    }
}
