// Phase 0(a): one invocation per 8x8 half-res block, its mean and its Laplacian variance.
//
// The blocks are CFA-aware - stride 2 in both axes off the channel's own offset - so each of the four filter positions is measured on its own.
//
// **A workgroup takes a block at a time, together, rather than a thread taking one alone.** The
// median is over 96 values, which is far more than a thread can hold in registers when the index
// is one the compiler cannot fold - so held per thread it goes to scratch, and a selection sort
// reads it some four thousand times per block. Spread across the workgroup's lanes the same 96
// values are 512 bytes of workgroup storage, sorted in 28 barriers, and the arithmetic is the same
// arithmetic: an exact order statistic of the same multiset either way.
//
// The network beats counting each value's rank against the other 95, which needs three barriers
// rather than 28 and is half again slower: those 96 comparisons are a dependent chain on one lane,
// where the network's are 64 lanes wide.

import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> raw;
[vk::binding(1, 0)] RWStructuredBuffer<float> blk_mean;
[vk::binding(2, 0)] RWStructuredBuffer<float> blk_var;

struct Push {
    int width;
    int height;
    int n_bx;
    int n_by;
    /// How many blocks of a channel this run measures, which is the strided count rather than the
    /// grid's own - the outputs stay dense in sampled index, so `ne_finalize` needs no notion of it.
    int n_blocks_per_ch;
    int stride;
    /// The CFA's period: how many channels there are, and the stride each one's sub-lattice has.
    int period_w;
    int period_h;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

static const int BLOCK = 8;
static const int THREADS = 64;

// 48 horizontal and 48 vertical three-tap Laplacians, rounded up to the power of two a bitonic
// network needs. The tail sorts above every real value and so cannot reach the rank read below.
static const int LAPS = 96;
static const int SLOTS = 128;
static const float ABOVE_ANY_LAPLACIAN = 1e30;

groupshared float sorted[SLOTS];

/// The block's own 64 samples, staged once.
///
/// **A block touches 64 samples, and fetching them where they are read costs 352 loads.** Every
/// Laplacian takes its three from `raw` - 288 for the 96 - and the mean then walks the same 64
/// again on lane 0 alone, which is 64 dependent scalar loads sitting in front of a barrier the
/// whole workgroup waits at. Staged, the block is one coalesced load per lane and everything reads
/// storage.
///
/// 256 bytes a workgroup, four a thread: holding the 96 Laplacians per thread instead costs 388
/// bytes a thread and most of the occupancy.
groupshared float blk[BLOCK * BLOCK];

/// The `i`th Laplacian of the staged block.
float laplacian_at(int i)
{
    if (i < 48) {
        let y = i / 6;
        let x = i % 6;
        let row = y * BLOCK;
        return abs(blk[row + x] - 2.0 * blk[row + x + 1] + blk[row + x + 2]);
    }
    let y = (i - 48) / 8;
    let x = (i - 48) % 8;
    return abs(
        blk[y * BLOCK + x] - 2.0 * blk[(y + 1) * BLOCK + x] + blk[(y + 2) * BLOCK + x]);
}

[shader("compute")]
[numthreads(64, 1, 1)]
void ne_block_stats(uint3 group : SV_GroupID, uint3 local : SV_GroupThreadID)
{
    let tid = int(local.x);
    let total_blocks = pc.period_w * pc.period_h * pc.n_blocks_per_ch;
    let first = int(group.x) * THREADS;

    for (int b = 0; b < THREADS; b++) {
        // Uniform across the workgroup, which is what lets the barriers below sit inside the loop.
        let bi_global = first + b;
        if (bi_global >= total_blocks) { break; }

        // The sampled index within the channel, walked onto the grid by the host's stride. That
        // stride is coprime to `n_bx`, so this visits every column and precesses each row rather
        // than combing a fixed subset of them - `block_stride` has why that is the whole of it.
        let ch = bi_global / pc.n_blocks_per_ch;
        let bi_in_ch = (bi_global - ch * pc.n_blocks_per_ch) * pc.stride;
        let by = bi_in_ch / pc.n_bx;
        let bx = bi_in_ch - by * pc.n_bx;
        let dy0 = ch / pc.period_w;
        let dx0 = ch % pc.period_w;
        let y0 = by * BLOCK;
        let x0 = bx * BLOCK;

        // One sample a lane, coalesced along the row, and every Laplacian below reads workgroup
        // storage rather than going back to `raw`.
        let ly = tid / BLOCK;
        let lx = tid - ly * BLOCK;
        blk[tid] = raw[(pc.period_h * (y0 + ly) + dy0) * pc.width + (pc.period_w * (x0 + lx) + dx0)];
        GroupMemoryBarrierWithGroupSync();

        // **On every lane, and off `raw` rather than off `blk`, which is what keeps the skip below
        // workgroup-uniform.** WGSL calls any value read from workgroup storage non-uniform however
        // plainly every lane computed the same one, so a mean summed from `blk` puts every barrier
        // past this point in non-uniform control flow and Chrome refuses the module outright, where
        // naga compiles it. The 64 samples were pulled in by the line above, so these are cache
        // hits, and every lane sums them in the same y-major order.
        var sum = 0.0;
        for (int y = 0; y < BLOCK; y++) {
            for (int x = 0; x < BLOCK; x++) {
                sum += raw[(pc.period_h * (y0 + y) + dy0) * pc.width + (pc.period_w * (x0 + x) + dx0)];
            }
        }
        let mean = sum / float(BLOCK * BLOCK);

        // **A block the envelope fit will not read needs no median.** Every read of `blk_var` in
        // `ne_finalize` is gated on the mean falling inside this range, so sorting one that does not
        // is 28 barriers and a bitonic network spent on a number nothing consumes. The variance
        // still gets written, above the `1e9` that same guard rejects, so a reader that ever did
        // reach it would be refused rather than handed a stale slot.
        let usable = mean > BLOCK_MEAN_FLOOR && mean < BLOCK_MEAN_CEILING;
        if (!usable) {
            if (tid == 0) {
                blk_mean[bi_global] = mean;
                blk_var[bi_global] = FLT_MAX;
            }
            GroupMemoryBarrierWithGroupSync();
            continue;
        }

        for (int i = tid; i < SLOTS; i += THREADS) {
            sorted[i] = i < LAPS ? laplacian_at(i) : ABOVE_ANY_LAPLACIAN;
        }
        GroupMemoryBarrierWithGroupSync();

        for (int k = 2; k <= SLOTS; k <<= 1) {
            for (int j = k >> 1; j > 0; j >>= 1) {
                for (int i = tid; i < SLOTS; i += THREADS) {
                    let partner = i ^ j;
                    if (partner > i) {
                        let ascending = (i & k) == 0;
                        let lo = sorted[i];
                        let hi = sorted[partner];
                        if ((lo > hi) == ascending) {
                            sorted[i] = hi;
                            sorted[partner] = lo;
                        }
                    }
                }
                GroupMemoryBarrierWithGroupSync();
            }
        }

        if (tid == 0) {
            // MAD to a sigma, then the variance a three-tap Laplacian has on iid noise: 6 sigma².
            let sigma_lap = sorted[LAPS / 2] / 0.6745;
            blk_var[bi_global] = (sigma_lap * sigma_lap) / 6.0;
            blk_mean[bi_global] = mean;
        }
        GroupMemoryBarrierWithGroupSync();
    }
}
