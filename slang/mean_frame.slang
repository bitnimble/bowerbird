// The frame's nits, averaged to the camera match's own supervision footprint, and split in two
// where a block straddles an edge (`block_split.slang`).
//
// The colour fit teaches the chroma lattice on block means - one pair per pixel of a
// 1280-wide grid over the photograph - and at those means it is measured correct. Read per
// render pixel instead, the lattice meets colours the fit never saw: texture spreads a
// block's pixels across cells whose operators differ, and the mean of the corrected
// pixels is not the correction of the mean. On a lit skin transition that gap is a mauve
// patch the camera's own rendering does not have. `matched_nits` therefore reads the
// lattice *at* this average and applies the operator to the pixel itself, which makes the
// block means of the two renderings agree by construction.
//
// Two texels a block, side by side: the first half's mean and its share of the block, then the
// second half's mean and how far the split is trusted. One thread a block, walking its pixels in
// the same block-relative order whatever window the block is seen through, so a tile and the
// whole render split every block they share alike.
//
// Through `pq_inv_nits`, the curve the grade's `nits_of_code` is filled from (21.1), so this
// average sits where the grade's own reads sit. Not the table itself: three walks of every pixel,
// each read scattered across its 256KB, cost an integrated GPU more than the curve.
import block_split;
import packed;
import prelude;
import px;

struct Push {
    uint width;
    uint height;
    /// The supervision footprint in this frame's pixels: the photograph's long edge over
    /// the fit grid's, scaled to however much of the photograph this frame holds.
    uint block;
    /// Where the frame starts inside its photograph-anchored block, per axis: the blocks
    /// partition the *photograph*, so a window whose origin is not a block multiple opens
    /// with a partial cell. Anchored there so a tile and the whole render average the same
    /// pixels into every cell they share.
    uint phase_x;
    uint phase_y;
    /// Nits of diffuse white, which `split_space` floors against.
    float reference;
};

[vk::binding(20, 0)] ConstantBuffer<Push> pc;
[vk::binding(1, 0)] StructuredBuffer<uint> frame;
[vk::image_format("rgba16f")]
[vk::binding(19, 0)] WTexture2D<float4> mean_frame;

float3 nits_at(uint x, uint y)
{
    let base = wide_at<Drawn>(x, y, measured<Drawn>(pc.width)) * 3;
    return float3(
        pq_inv_nits(float(half_of(frame[base / 2], base)) / 65535.0),
        pq_inv_nits(float(half_of(frame[(base + 1) / 2], base + 1)) / 65535.0),
        pq_inv_nits(float(half_of(frame[(base + 2) / 2], base + 2)) / 65535.0));
}

/// A block's pixels in the frame, `lo` inclusive and `hi` exclusive.
struct Block {
    uint2 lo;
    uint2 hi;
}

Block block_of(uint2 cell)
{
    let phase = uint2(pc.phase_x, pc.phase_y);
    Block b;
    b.lo = max(cell * pc.block, phase) - phase;
    b.hi = min((cell + 1) * pc.block - phase, uint2(pc.width, pc.height));
    return b;
}

/// Each pixel given to the nearer centre: per half, its split-space sum and count, and its nits.
struct Halves {
    float4 first;
    float4 second;
    float3 lit_first;
    float3 lit_second;
    float scatter;
}

void assigned(out Halves h, Block b, float3 first, float3 second)
{
    h.first = float4(0.0);
    h.second = float4(0.0);
    h.lit_first = float3(0.0);
    h.lit_second = float3(0.0);
    h.scatter = 0.0;
    for (uint y = b.lo.y; y < b.hi.y; y++) {
        for (uint x = b.lo.x; x < b.hi.x; x++) {
            let nits = nits_at(x, y);
            let v = split_space(nits, pc.reference);
            let to_first = length(v - first);
            let to_second = length(v - second);
            if (to_first <= to_second) {
                h.first += float4(v, 1.0);
                h.lit_first += nits;
                h.scatter += to_first * to_first;
            } else {
                h.second += float4(v, 1.0);
                h.lit_second += nits;
                h.scatter += to_second * to_second;
            }
        }
    }
}

[shader("compute")]
[numthreads(8, 8, 1)]
void mean(uint3 id : SV_DispatchThreadID)
{
    let cells = (uint2(pc.width + pc.phase_x, pc.height + pc.phase_y) + pc.block - 1) / pc.block;
    if (id.x >= cells.x || id.y >= cells.y) { return; }
    let b = block_of(id.xy);

    Seeds seeds;
    seeds_begin(seeds);
    for (uint y = b.lo.y; y < b.hi.y; y++) {
        for (uint x = b.lo.x; x < b.hi.x; x++) {
            seeds_add(seeds, split_space(nits_at(x, y), pc.reference));
        }
    }
    float3 first;
    float3 second;
    seeds_pick(seeds, first, second);
    Halves h;
    assigned(h, b, first, second);
    for (int round = 0; round < SETTLE; round++) {
        let next_first = h.first.a > 0.0 ? h.first.rgb / h.first.a : first;
        let next_second = h.second.a > 0.0 ? h.second.rgb / h.second.a : second;
        // Settled: every later round would repeat this one exactly.
        if (all(next_first == first) && all(next_second == second)) { break; }
        first = next_first;
        second = next_second;
        assigned(h, b, first, second);
    }

    let total = h.first.a + h.second.a;
    let at = int2(id.x * 2, id.y);
    if (h.first.a <= 0.0 || h.second.a <= 0.0) {
        let box = (h.lit_first + h.lit_second) / max(total, 1.0);
        mean_frame.Store(at, float4(box, 1.0));
        mean_frame.Store(at + int2(1, 0), float4(box, 0.0));
        return;
    }
    let trusted = split_weight(
        length(first - second), sqrt(h.scatter / total), min(h.first.a, h.second.a), float(pc.block));
    mean_frame.Store(at, float4(h.lit_first / h.first.a, h.first.a / total));
    mean_frame.Store(at + int2(1, 0), float4(h.lit_second / h.second.a, trusted));
}
