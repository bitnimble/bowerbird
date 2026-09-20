// Phase 0(c): where "dark" starts, as a histogram of the mosaic's own levels.
//
// Sub-sampled at stride 3 per CFA channel; the finalize takes the 10th percentile off it.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> raw;
[vk::binding(1, 0)] RWStructuredBuffer<Atomic<int> > dark_thresh_hist;

struct Push {
    int width;
    int height;
    /// The CFA's period, so the sub-sampling visits every filter position rather than the four a
    /// 2x2 stride would reach - on a 6x6 those four are one corner of the pattern, and a
    /// percentile taken off them is a percentile of that corner's colours.
    int period_w;
    int period_h;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(16, 16, 1)]
void ne_dark_thresh_hist(uint3 id : SV_DispatchThreadID)
{
    let gid_x = int(id.x);
    let gid_y = int(id.y);
    let halfwidth = (pc.width + pc.period_w - 1) / pc.period_w;
    let halfheight = (pc.height + pc.period_h - 1) / pc.period_h;
    if (gid_x * 3 >= halfwidth || gid_y * 3 >= halfheight) { return; }

    let scale = float(DARK_HIST_BINS);
    for (int ch = 0; ch < pc.period_w * pc.period_h; ch++) {
        let dy0 = ch / pc.period_w;
        let dx0 = ch % pc.period_w;
        let hr = gid_y * 3;
        let hc = gid_x * 3;
        if (hr >= halfheight || hc >= halfwidth) { continue; }
        let fr = pc.period_h * hr + dy0;
        let fc = pc.period_w * hc + dx0;
        if (fr >= pc.height || fc >= pc.width) { continue; }
        let v = raw[fr * pc.width + fc];
        let bin = clamp(int(v * scale), 0, DARK_HIST_BINS - 1);
        dark_thresh_hist[bin].add(1);
    }
}
