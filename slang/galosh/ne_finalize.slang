// Phase 0(b): green's α and σ², from the block statistics.
//
// One workgroup of 256, eight of them to each of the 32 mean bins, spaced on the square root of
// the mean so that a night frame's few codes above black get most of them: a bin keeps the
// 5th-to-20th percentile of its own variance histogram - the envelope, which is what a bin's
// *noise* is once its textured blocks are excluded - and a Huber-weighted least squares over
// the (mean, variance) pairs gives the slope and the intercept.
//
// **The intercept is no less than what a field under black measures.** A line's intercept is an
// extrapolation, and a block variance is a high-pass: where a sensor's dark noise is not white the
// blocks read almost none of it and the line lands on zero. The photosites under black are that
// noise observed directly (`under_black_reduce`).
//
// No early return on a degenerate range: WGSL will not admit a workgroup barrier past a branch
// on workgroup memory, and falling through lands on the fallback anyway, because a range that
// small leaves every bin under the 20-block floor and the `n_valid < 4` arm writes it.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> blk_mean;
[vk::binding(1, 0)] StructuredBuffer<float> blk_var;
[vk::binding(2, 0)] StructuredBuffer<float> under_black;
[vk::binding(3, 0)] RWStructuredBuffer<float> params;

struct Push {
    int width;
    int height;
    int total_blocks;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

static const int NBINS = 32;
static const int VAR_BINS = 128;
static const int WG = 256;

/// The 5th to 20th percentile of block variances over the variance the photosites have, which is
/// what that low a slice of a block estimate's own scatter reads on noise alone.
static const float ENVELOPE_RATIO = 0.71;

/// Blocks to a bin before it is read. A field under black that would fill as many counts for half.
static const int BIN_BLOCKS = 20;

/// `ne_block_stats`'s 8x8.
static const float BLOCK_SAMPLES = 64.0;

/// The read variance the photosites under black measure, weighed by how much of a field they are.
///
/// A zero-mean normal's lower half has a mean depth of `sigma * sqrt(2 / pi)`. Green's where any
/// green is under black; the other colours' otherwise, which carry their gain and so read high.
///
/// **Only a field at black is that lower half.** A defect, or the tail of a field that is lit, is
/// under black too and measures neither, so the reading counts by how many bins its paired
/// photosites would fill: all of it over a masked border, none of it for a lone photosite.
float read_variance_under_black()
{
    UnderBlack levels[BLACK_LEVELS];
    for (int l = 0; l < BLACK_LEVELS; l++) { under_black_none(levels[l]); }
    for (int i = 0; i < DR_WORKGROUPS; i++) {
        for (int l = 0; l < BLACK_LEVELS; l++) {
            UnderBlack partial;
            under_black_at(under_black, i, l, partial);
            under_black_merge(levels[l], partial);
        }
    }
    // `black_level_of` puts green's two first.
    var first = 0;
    if (levels[0].count + levels[1].count == 0.0) { first = 2; }
    let depth = levels[first].depth + levels[first + 1].depth;
    let count = levels[first].count + levels[first + 1].count;
    if (count == 0.0) { return 0.0; }
    let sigma = depth / count * 1.2533141;
    let field = (levels[first].paired + levels[first + 1].paired) / BLOCK_SAMPLES;
    return sigma * sigma * field / (field + float(BIN_BLOCKS));
}

float axis(float mean)
{
    return sqrt(max(mean, 0.0));
}

/// Under the ceiling and not flat: a block whose Laplacians are mostly zero is a masked border or a
/// clipped patch, and at zero variance its inverse weight would be every other bin's many times.
bool usable(float mean, float variance)
{
    return mean < BLOCK_MEAN_CEILING && variance > 0.0 && variance < 1e9;
}

/// Which of the 32 bins a block's mean falls in, bins `bw` wide along [`axis`].
int bin_of(float mean, float bw)
{
    return min(int(axis(mean) / bw), NBINS - 1);
}

groupshared float bin_mean_arr[32];
groupshared float bin_var_arr[32];
groupshared int bin_cnt_arr[32];
groupshared int bin_valid[32];
groupshared float global_max;
groupshared Atomic<int> lds_var_hist[4096];
groupshared float l_msum[32];
groupshared float l_vmin[32];
groupshared float l_vmax[32];
groupshared int l_cnt[32];
groupshared int r_cnt[256];
groupshared float r_a[256];
groupshared float r_b[256];
groupshared float r_c[256];

/// The blocks the two binned passes are walking, a workgroup's worth at a time.
///
/// **Each of the 32 bin groups reads every block, and there is only one workgroup.** Eight threads
/// share a bin and stride the whole array by 8, so the two passes below pull 2 x 32 x 940,896
/// pairs - about 480MB - and a wave has only eight distinct addresses live at once, so it takes 32
/// bytes of every 128-byte line. Staged, the array is read twice in total and each read is `lid`
/// consecutive; the 32-fold repeat moves to workgroup storage, where it is a broadcast.
///
/// **The chunk has to be a multiple of `tpb`.** Thread `sub` visits chunk-local `sub, sub+8, ...`
/// in order and the chunks ascend, so at 256 the global sequence is exactly the `sub, sub+8, ...`
/// it was - which is what keeps `msum`, an f32 sum, associating the way it did.
groupshared float st_mean[256];
groupshared float st_var[256];

[shader("compute")]
[numthreads(256, 1, 1)]
void ne_finalize(uint3 local : SV_GroupThreadID)
{
    let lid = int(local.x);
    let tpb = WG / NBINS;
    let bin = lid / tpb;
    let sub = lid % tpb;

    {
        var gmax = 0.0;
        for (int i = lid; i < pc.total_blocks; i += WG) {
            if (usable(blk_mean[i], blk_var[i])) { gmax = max(gmax, axis(blk_mean[i])); }
        }
        r_c[lid] = gmax;
        GroupMemoryBarrierWithGroupSync();
        for (int s = WG >> 1; s > 0; s >>= 1) {
            if (lid < s) { r_c[lid] = max(r_c[lid], r_c[lid + s]); }
            GroupMemoryBarrierWithGroupSync();
        }
        if (lid == 0) { global_max = r_c[0]; }
        GroupMemoryBarrierWithGroupSync();
    }

    let bw = max(global_max, 1e-12) / float(NBINS);

    {
        var msum = 0.0;
        var vmin = FLT_MAX;
        var vmax = 0.0;
        var cnt = 0;
        for (int c = 0; c < pc.total_blocks; c += WG) {
            let at = c + lid;
            st_mean[lid] = at < pc.total_blocks ? blk_mean[at] : 0.0;
            st_var[lid] = at < pc.total_blocks ? blk_var[at] : 0.0;
            GroupMemoryBarrierWithGroupSync();
            let span = min(WG, pc.total_blocks - c);
            for (int k = sub; k < span; k += tpb) {
                let bm = st_mean[k];
                let bv = st_var[k];
                if (usable(bm, bv) && bin_of(bm, bw) == bin) {
                    msum += bm;
                    cnt++;
                    vmin = min(vmin, bv);
                    vmax = max(vmax, bv);
                }
            }
            GroupMemoryBarrierWithGroupSync();
        }
        r_cnt[lid] = cnt;
        r_a[lid] = msum;
        r_b[lid] = vmin;
        r_c[lid] = vmax;
        GroupMemoryBarrierWithGroupSync();
        for (int s = tpb >> 1; s > 0; s >>= 1) {
            if (sub < s) {
                let o = lid + s;
                r_cnt[lid] += r_cnt[o];
                r_a[lid] += r_a[o];
                r_b[lid] = min(r_b[lid], r_b[o]);
                r_c[lid] = max(r_c[lid], r_c[o]);
            }
            GroupMemoryBarrierWithGroupSync();
        }
        if (sub == 0) {
            l_cnt[bin] = r_cnt[lid];
            l_msum[bin] = r_a[lid];
            l_vmin[bin] = r_b[lid];
            l_vmax[bin] = r_c[lid];
        }
        GroupMemoryBarrierWithGroupSync();
    }

    let cnt = l_cnt[bin];
    let msum = l_msum[bin];
    // **Log-spaced**: a bin's variances run from its noise to its texture, several decades, and in
    // linear steps across that the whole envelope lands in the first step, read as its centre.
    let vmin = max(l_vmin[bin], 1e-14);
    let vmax = max(l_vmax[bin], vmin);
    let vscale = float(VAR_BINS) / max(log(vmax / vmin), 1e-6);

    for (int i = sub; i < VAR_BINS; i += tpb) {
        lds_var_hist[bin * VAR_BINS + i].store(0);
    }
    GroupMemoryBarrierWithGroupSync();

    // The staging is outside the `cnt >= 20` and the barriers with it: that test is per-bin and so
    // not workgroup-uniform, and a barrier inside it would be reached by some bins and not others.
    for (int c = 0; c < pc.total_blocks; c += WG) {
        let at = c + lid;
        st_mean[lid] = at < pc.total_blocks ? blk_mean[at] : 0.0;
        st_var[lid] = at < pc.total_blocks ? blk_var[at] : 0.0;
        GroupMemoryBarrierWithGroupSync();
        if (cnt >= BIN_BLOCKS) {
            let span = min(WG, pc.total_blocks - c);
            for (int k = sub; k < span; k += tpb) {
                let bm = st_mean[k];
                let bv = st_var[k];
                if (usable(bm, bv) && bin_of(bm, bw) == bin) {
                    var vbin = int(log(max(bv, vmin) / vmin) * vscale);
                    vbin = clamp(vbin, 0, VAR_BINS - 1);
                    lds_var_hist[bin * VAR_BINS + vbin].add(1);
                }
            }
        }
        GroupMemoryBarrierWithGroupSync();
    }

    if (sub == 0) {
        if (cnt < BIN_BLOCKS) {
            bin_valid[bin] = 0;
        } else {
            let p5_target = cnt / 20;
            let p20_target = cnt / 5;
            var cum = 0;
            var p5_bin = 0;
            var p20_bin = VAR_BINS - 1;
            var found_p5 = false;
            for (int i = 0; i < VAR_BINS; i++) {
                cum += lds_var_hist[bin * VAR_BINS + i].load();
                if (!found_p5 && cum >= p5_target) { p5_bin = i; found_p5 = true; }
                if (cum >= p20_target) { p20_bin = i; break; }
            }
            var vsum = 0.0;
            var vcnt = 0;
            for (int i = p5_bin; i <= p20_bin; i++) {
                let bin_center = vmin * exp((float(i) + 0.5) / vscale);
                let n = lds_var_hist[bin * VAR_BINS + i].load();
                vsum += bin_center * float(n);
                vcnt += n;
            }
            let envelope = select(vcnt > 0, vsum / float(vcnt), vmin * exp(0.5 / vscale));
            bin_var_arr[bin] = envelope / ENVELOPE_RATIO;
            bin_mean_arr[bin] = msum / float(cnt);
            bin_cnt_arr[bin] = max(vcnt, 1);
            bin_valid[bin] = 1;
        }
    }
    GroupMemoryBarrierWithGroupSync();

    if (lid != 0) { return; }

    float weight[32];
    for (int b = 0; b < NBINS; b++) { weight[b] = 0.0; }
    var n_valid = 0;
    var most = 0.0;
    var least = FLT_MAX;
    for (int b = 0; b < NBINS; b++) {
        if (bin_valid[b] == 0 || bin_var_arr[b] <= 0.0) { continue; }
        // Noise never falls as light rises: a collapse is clipping, and past it the slope flattens.
        if (bin_var_arr[b] < 0.5 * most) { break; }
        most = max(most, bin_var_arr[b]);
        least = min(least, bin_var_arr[b]);
        weight[b] = float(bin_cnt_arr[b]);
        n_valid++;
    }
    if (n_valid < 4) {
        params[P_ALPHA] = 1e-4;
        params[P_SIGMA_SQ] = 1e-6;
        return;
    }

    var alpha_est = 0.01;
    var sigma_sq_est = 0.0;
    var fitted = false;
    for (int iter = 0; iter < 8; iter++) {
        var huber_k = 1e10;
        // By count first, then by the inverse of the variance the line predicts there: texture only
        // adds variance, and by count the few bright, busy bins set the slope. The prediction
        // rather than the bin's own reading, which on a clean frame is quantised low and would
        // hand the darkest bins everything.
        float relative[32];
        var heaviest = 0.0;
        for (int b = 0; b < NBINS; b++) {
            relative[b] = weight[b];
            if (iter > 0 && weight[b] > 0.0) {
                let pred = max(alpha_est * bin_mean_arr[b] + sigma_sq_est, least);
                relative[b] = weight[b] / (pred * pred);
            }
            heaviest = max(heaviest, relative[b]);
        }
        // Relative, so the sums below stay inside what f32 holds: a clean frame's variances are 1e-9.
        for (int b = 0; b < NBINS; b++) { relative[b] /= heaviest; }
        if (iter > 0) {
            float resids[32];
            var nr = 0;
            for (int b = 0; b < NBINS; b++) {
                if (weight[b] == 0.0) { continue; }
                resids[nr] = abs(bin_var_arr[b] - (alpha_est * bin_mean_arr[b] + sigma_sq_est));
                nr++;
            }
            let target_r = nr / 2;
            for (int k = 0; k <= target_r; k++) {
                var min_idx = k;
                var min_val = resids[k];
                for (int j = k + 1; j < nr; j++) {
                    if (resids[j] < min_val) { min_val = resids[j]; min_idx = j; }
                }
                resids[min_idx] = resids[k];
                resids[k] = min_val;
            }
            let resid_mad = resids[target_r] / 0.6745;
            huber_k = 1.345 * max(resid_mad, 1e-12);
        }

        var sw = 0.0;
        var sx = 0.0;
        var sy = 0.0;
        var sxx = 0.0;
        var sxy = 0.0;
        for (int b = 0; b < NBINS; b++) {
            if (weight[b] == 0.0) { continue; }
            var w = relative[b];
            if (iter > 0) {
                let pred = alpha_est * bin_mean_arr[b] + sigma_sq_est;
                let resid = abs(bin_var_arr[b] - pred);
                if (resid > huber_k) { w *= huber_k / resid; }
            }
            let x = bin_mean_arr[b];
            let y = bin_var_arr[b];
            sw += w;
            sx += w * x;
            sy += w * y;
            sxx += w * x * x;
            sxy += w * x * y;
        }
        let det = sw * sxx - sx * sx;
        if (abs(det) > 1e-30) {
            let new_alpha = (sw * sxy - sx * sy) / det;
            let new_sq = (sxx * sy - sx * sxy) / det;
            if (new_alpha > 0.0) {
                alpha_est = new_alpha;
                sigma_sq_est = max(new_sq, 0.0);
                fitted = true;
            }
        }
    }
    if (!fitted) {
        params[P_ALPHA] = 1e-4;
        params[P_SIGMA_SQ] = 1e-6;
        return;
    }

    // The darkest bin is the read noise measured nearly directly, where the intercept is only
    // extrapolated to, and on a clean frame's quantised envelope extrapolated below zero.
    var darkest = 0;
    while (weight[darkest] == 0.0) { darkest++; }
    let read_floor = bin_var_arr[darkest] - alpha_est * max(bin_mean_arr[darkest], 0.0);

    params[P_ALPHA] = max(alpha_est, ALPHA_MIN);
    params[P_SIGMA_SQ] = max(max(sigma_sq_est, read_floor), read_variance_under_black());
}
