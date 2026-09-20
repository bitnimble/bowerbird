// Phase 0(b): the blind α, from the block statistics.
//
// One workgroup of 256, eight of them to each of the 32 mean bins: a bin keeps the
// 5th-to-20th percentile of its own variance histogram - the envelope, which is what a bin's
// *noise* is once its textured blocks are excluded - and a Huber-weighted least squares over
// the 32 (mean, variance) pairs gives the slope. σ² is a placeholder here and comes from
// `ne_dark_finalize`.
//
// No early return on a degenerate range: WGSL will not admit a workgroup barrier past a branch
// on workgroup memory, and falling through lands on the fallback anyway, because a range that
// small leaves every bin under the 20-block floor and the `n_valid < 4` arm writes it.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> blk_mean;
[vk::binding(1, 0)] StructuredBuffer<float> blk_var;
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

groupshared float bin_mean_arr[32];
groupshared float bin_var_arr[32];
groupshared int bin_cnt_arr[32];
groupshared int bin_valid[32];
groupshared float global_min;
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
        var gmin = FLT_MAX;
        var gmax = 0.0;
        var nv = 0;
        for (int i = lid; i < pc.total_blocks; i += WG) {
            let bm = blk_mean[i];
            let bv = blk_var[i];
            if (bm > BLOCK_MEAN_FLOOR && bm < BLOCK_MEAN_CEILING && bv < 1e9) {
                gmin = min(gmin, bm);
                gmax = max(gmax, bm);
                nv++;
            }
        }
        r_b[lid] = gmin;
        r_c[lid] = gmax;
        r_cnt[lid] = nv;
        GroupMemoryBarrierWithGroupSync();
        for (int s = WG >> 1; s > 0; s >>= 1) {
            if (lid < s) {
                r_b[lid] = min(r_b[lid], r_b[lid + s]);
                r_c[lid] = max(r_c[lid], r_c[lid + s]);
                r_cnt[lid] += r_cnt[lid + s];
            }
            GroupMemoryBarrierWithGroupSync();
        }
        if (lid == 0) {
            global_min = r_b[0];
            global_max = r_c[0];
        }
        GroupMemoryBarrierWithGroupSync();
    }

    let bw = (global_max - global_min) / float(NBINS);
    let bin_lo = global_min + float(bin) * bw;
    let bin_hi = bin_lo + bw;

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
                if (bm >= bin_lo && bm < bin_hi && bm > BLOCK_MEAN_FLOOR && bm < BLOCK_MEAN_CEILING && bv < 1e9) {
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
    let vmin = l_vmin[bin];
    let vmax = l_vmax[bin];
    let vrange = max(vmax - vmin, 1e-12);
    let vscale = float(VAR_BINS) / vrange;

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
        if (cnt >= 20) {
            let span = min(WG, pc.total_blocks - c);
            for (int k = sub; k < span; k += tpb) {
                let bm = st_mean[k];
                let bv = st_var[k];
                if (bm >= bin_lo && bm < bin_hi && bm > BLOCK_MEAN_FLOOR && bm < BLOCK_MEAN_CEILING && bv < 1e9) {
                    var vbin = int((bv - vmin) * vscale);
                    vbin = clamp(vbin, 0, VAR_BINS - 1);
                    lds_var_hist[bin * VAR_BINS + vbin].add(1);
                }
            }
        }
        GroupMemoryBarrierWithGroupSync();
    }

    if (sub == 0) {
        if (cnt < 20) {
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
                let bin_center = vmin + (float(i) + 0.5) / vscale;
                let n = lds_var_hist[bin * VAR_BINS + i].load();
                vsum += bin_center * float(n);
                vcnt += n;
            }
            bin_var_arr[bin] = select(vcnt > 0, vsum / float(vcnt), vmin + 0.5 / vscale);
            bin_mean_arr[bin] = msum / float(cnt);
            bin_cnt_arr[bin] = max(vcnt, 1);
            bin_valid[bin] = 1;
        }
    }
    GroupMemoryBarrierWithGroupSync();

    if (lid != 0) { return; }

    var n_valid = 0;
    for (int b = 0; b < NBINS; b++) {
        if (bin_valid[b] != 0) { n_valid++; }
    }
    if (n_valid < 4) {
        params[P_ALPHA] = 1e-4;
        params[P_SIGMA_SQ] = 1e-6;
        return;
    }

    var alpha_est = 0.01;
    var sigma_sq_est = 0.0;
    for (int iter = 0; iter < 5; iter++) {
        var huber_k = 1e10;
        if (iter > 0) {
            float resids[32];
            var nr = 0;
            for (int b = 0; b < NBINS; b++) {
                if (bin_valid[b] == 0) { continue; }
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
            if (bin_valid[b] == 0) { continue; }
            var w = float(bin_cnt_arr[b]);
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
            if (new_alpha > 0.0) { alpha_est = new_alpha; }
            if (new_sq >= 0.0) { sigma_sq_est = new_sq; }
        }
    }

    params[P_ALPHA] = max(alpha_est, ALPHA_MIN);
    params[P_SIGMA_SQ] = 0.0;
}
