// Phase 1(b), second half: one channel's histogram out of its slices, and the median of it.
//
// `sigma_per_cfa` is a band of workgroups per CFA channel rather than one, because one fills a
// two-core integrated part and leaves 64 of a 68-core discrete one with nothing to do. How wide
// the band is comes off the device (`Gpu::reduction_slices`), and this adds up whatever it chose.
//
// Counts are integers, so the sum is exact in any order and at any width - the median bin, and so
// the sigma, is the one a single workgroup would have reached.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<int> partial;
[vk::binding(1, 0)] RWStructuredBuffer<float> params;

struct Push {
    int slices;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

static const int WG = 256;

groupshared int hist[SIGMA_BINS];
groupshared int total;

[shader("compute")]
[numthreads(256, 1, 1)]
void sigma_per_cfa_merge(uint3 group: SV_GroupID, uint3 local: SV_GroupThreadID)
{
    let ch = int(group.x);
    let lid = int(local.x);
    let stride = SIGMA_BINS + 1;

    for (int i = lid; i < SIGMA_BINS; i += WG) {
        var sum = 0;
        for (int s = 0; s < pc.slices; s++) {
            sum += partial[(ch * pc.slices + s) * stride + i];
        }
        hist[i] = sum;
    }
    if (lid == 0) {
        var counted = 0;
        for (int s = 0; s < pc.slices; s++) {
            counted += partial[(ch * pc.slices + s) * stride + SIGMA_BINS];
        }
        total = counted;
    }
    GroupMemoryBarrierWithGroupSync();

    if (lid == 0) {
        let median_target = total / 2;
        var cum = 0;
        var median_bin = 0;
        for (int i = 0; i < SIGMA_BINS; i++) {
            cum += hist[i];
            if (cum >= median_target) { median_bin = i; break; }
        }
        let bin_scale = float(SIGMA_BINS) / SIGMA_LAP_MAX;
        let mad = (float(median_bin) + 0.5) / bin_scale;
        // A three-tap Laplacian on iid noise has variance 6σ², so σ = MAD / (0.6745·√6).
        params[P_SIGMA_CH0 + ch] = max(mad / 1.6521, 0.01);
    }
}
