// Phase 0(f): σ², from the median of the dark Laplacians.
//
// Too few dark triplets and it writes nothing, which leaves the α-only σ² of zero
// `ne_finalize` put there.
//
// `alpha` is fit across the full tonal range, so its product with a guessed dark mean cannot
// reliably isolate shot variance here. σ² therefore includes dark shot noise and bounds the read
// floor from above; subtracting an overestimate would make the GAT and IRLS under-denoise shadows.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<int> dark_lap_hist;
[vk::binding(1, 0)] RWStructuredBuffer<float> params;

struct Push {
    int dark_thresh_slot;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(256, 1, 1)]
void ne_dark_finalize(uint3 id : SV_DispatchThreadID)
{
    if (id.x != 0) { return; }

    var total = 0;
    for (int i = 0; i < DARK_HIST_BINS; i++) { total += dark_lap_hist[i]; }
    if (total < 100) { return; }

    let rank = total / 2;
    var cum = 0;
    var med_bin = 0;
    for (int i = 0; i < DARK_HIST_BINS; i++) {
        cum += dark_lap_hist[i];
        if (cum >= rank) { med_bin = i; break; }
    }

    let mad = (float(med_bin) + 0.5) / (float(DARK_HIST_BINS) / DARK_LAP_MAX);
    let sigma_lap = mad / 0.6745;
    // The variance a three-tap Laplacian has on iid noise is six times a sample's.
    params[P_SIGMA_SQ] = (sigma_lap * sigma_lap) / 6.0;
}
