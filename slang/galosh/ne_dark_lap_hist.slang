// Phase 0(e): Laplacians of the dark pixels only, histogrammed.
//
// A triplet counts only where all three samples are dark, so what the median of this measures is the noise where shot noise is at its smallest.
//
// The gate includes the frame's tenth percentile plus two percent of full scale, leaving enough
// dark triplets for a stable median. `suggested_amount` is calibrated against this measurement.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> raw;
[vk::binding(1, 0)] StructuredBuffer<float> params;
[vk::binding(2, 0)] RWStructuredBuffer<Atomic<int> > dark_lap_hist;

struct Push {
    int width;
    int height;
    int dark_thresh_slot;
    /// The CFA's period, which is the stride each channel's own sub-lattice has.
    int period_w;
    int period_h;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(16, 16, 1)]
void ne_dark_lap_hist(uint3 id : SV_DispatchThreadID)
{
    let gid_x = int(id.x);
    let gid_y = int(id.y);
    // The pattern's own sub-lattice rather than a half-res one, for `sigma_per_cfa`'s reason: three
    // taps spanning colours measure the scene rather than the sensor.
    let halfwidth = (pc.width + pc.period_w - 1) / pc.period_w;
    let halfheight = (pc.height + pc.period_h - 1) / pc.period_h;
    if (gid_x >= halfwidth || gid_y >= halfheight) { return; }

    let dark_max = params[pc.dark_thresh_slot] + 0.02;
    let scale = float(DARK_HIST_BINS) / DARK_LAP_MAX;

    for (int ch = 0; ch < pc.period_w * pc.period_h; ch++) {
        let dy0 = ch / pc.period_w;
        let dx0 = ch % pc.period_w;
        let hr = gid_y;
        let hc = gid_x;
        if (hc < halfwidth - 2) {
            let fr = pc.period_h * hr + dy0;
            if (fr < pc.height) {
                let row = fr * pc.width;
                let v0 = raw[row + (pc.period_w * hc + dx0)];
                let v1 = raw[row + (pc.period_w * (hc + 1) + dx0)];
                let v2 = raw[row + (pc.period_w * (hc + 2) + dx0)];
                if (!(v0 > dark_max || v1 > dark_max || v2 > dark_max)) {
                    let bin = clamp(int(abs(v0 - 2.0 * v1 + v2) * scale), 0, DARK_HIST_BINS - 1);
                    dark_lap_hist[bin].add(1);
                }
            }
        }
        if (hr < halfheight - 2) {
            let fc = pc.period_w * hc + dx0;
            if (fc < pc.width) {
                let v0 = raw[(pc.period_h * hr + dy0) * pc.width + fc];
                let v1 = raw[(pc.period_h * (hr + 1) + dy0) * pc.width + fc];
                let v2 = raw[(pc.period_h * (hr + 2) + dy0) * pc.width + fc];
                if (!(v0 > dark_max || v1 > dark_max || v2 > dark_max)) {
                    let bin = clamp(int(abs(v0 - 2.0 * v1 + v2) * scale), 0, DARK_HIST_BINS - 1);
                    dark_lap_hist[bin].add(1);
                }
            }
        }
    }
}
