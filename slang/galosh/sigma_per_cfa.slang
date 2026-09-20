// Phase 1(b): σ in the GAT domain, a band of workgroups per CFA channel.
//
// A histogram-MAD of the three-tap horizontal Laplacian inside each half-res view. The
// channel-to-offset encoding is transposed against `ne_block_stats` - `dy0` off the low bit
// here, off the high bit there - and is left alone: both are self-consistent, and each
// channel's σ is unified away in the next dispatch anyway.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> in_gat_full;
[vk::binding(1, 0)] RWStructuredBuffer<int> partial;

struct Push {
    int width;
    int height;
    /// How many workgroups share a channel. The host reads it off the device
    /// (`Gpu::reduction_slices`); nothing here assumes a value, and every value gives the same
    /// histogram.
    int slices;
    /// The CFA's period. A channel is one position of it, and the sub-lattice that position owns
    /// has this stride - two and four channels on a Bayer sensor, six and thirty-six on X-Trans.
    ///
    /// **The stride is what keeps the Laplacian on one colour.** Three taps spanning colours
    /// measure the scene's own colour differences and report them as noise.
    int period_w;
    int period_h;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

static const int WG = 256;

groupshared Atomic<int> hist[SIGMA_BINS];
groupshared Atomic<int> total_count;

[shader("compute")]
[numthreads(256, 1, 1)]
void sigma_per_cfa(uint3 group: SV_GroupID, uint3 local: SV_GroupThreadID)
{
    let ch = int(group.x) / pc.slices;
    let slice = int(group.x) - ch * pc.slices;
    let lid = int(local.x);

    // The channel-to-offset encoding is transposed against `ne_block_stats`: the
    // row offset off the low digit here, off the high one there. Both are self-consistent and each
    // channel's sigma is unified away next, so the transposition is left alone.
    let dy0 = ch % pc.period_h;
    let dx0 = (ch / pc.period_h) % pc.period_w;
    let hw = (pc.width - dx0 + pc.period_w - 1) / pc.period_w;
    let hh = (pc.height - dy0 + pc.period_h - 1) / pc.period_h;

    for (int i = lid; i < SIGMA_BINS; i += WG) { hist[i].store(0); }
    if (lid == 0) { total_count.store(0); }
    GroupMemoryBarrierWithGroupSync();

    let bin_scale = float(SIGMA_BINS) / SIGMA_LAP_MAX;
    var my_count = 0;
    // Rows dealt out across the channel's slices as well as its lanes, so between them the slices
    // visit every row exactly once and the multiset of Laplacians is one workgroup's.
    for (int hr = slice * WG + lid; hr < hh; hr += pc.slices * WG) {
        let fr = pc.period_h * hr + dy0;
        if (fr >= pc.height) { continue; }
        for (int hc = 0; hc < hw - 2; hc += 3) {
            let fc0 = pc.period_w * hc + dx0;
            let fc1 = pc.period_w * (hc + 1) + dx0;
            let fc2 = pc.period_w * (hc + 2) + dx0;
            if (fc2 >= pc.width) { break; }
            let a = in_gat_full[fr * pc.width + fc0];
            let b = in_gat_full[fr * pc.width + fc1];
            let c = in_gat_full[fr * pc.width + fc2];
            let lap = abs(a - 2.0 * b + c);
            var bin = int(lap * bin_scale);
            if (bin >= SIGMA_BINS) { bin = SIGMA_BINS - 1; }
            hist[bin].add(1);
            my_count++;
        }
    }
    total_count.add(my_count);
    GroupMemoryBarrierWithGroupSync();

    // **Written out whole rather than merged with atomics.** Counts are integers, so any order
    // sums to the same histogram - but merging into one shared histogram costs an atomic per
    // non-empty bin per slice, and those collide on the handful of low bins nearly every Laplacian
    // lands in. Measured, that collision cost more than slicing the sample loop won.
    let base = int(group.x) * (SIGMA_BINS + 1);
    for (int i = lid; i < SIGMA_BINS; i += WG) { partial[base + i] = hist[i].load(); }
    if (lid == 0) { partial[base + SIGMA_BINS] = total_count.load(); }
}
