// Phase 0(d): the 10th percentile of that histogram, into the scratch slot.
//
// One invocation does the scan; the rest idle.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<int> dark_thresh_hist;
[vk::binding(1, 0)] RWStructuredBuffer<float> params;

struct Push {
    int dark_thresh_slot;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(256, 1, 1)]
void ne_dark_thresh_finalize(uint3 id : SV_DispatchThreadID)
{
    if (id.x != 0) { return; }

    var total = 0;
    for (int i = 0; i < DARK_HIST_BINS; i++) { total += dark_thresh_hist[i]; }
    if (total < 100) {
        params[pc.dark_thresh_slot] = 0.01;
        return;
    }

    let rank = total / 10;
    var cum = 0;
    var dark_bin = 0;
    for (int i = 0; i < DARK_HIST_BINS; i++) {
        cum += dark_thresh_hist[i];
        if (cum >= rank) { dark_bin = i; break; }
    }
    params[pc.dark_thresh_slot] = (float(dark_bin) + 0.5) / float(DARK_HIST_BINS);
}
