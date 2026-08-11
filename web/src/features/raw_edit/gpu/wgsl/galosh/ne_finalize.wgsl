// Phase 0(b): the blind α, from the block statistics.
//
// `o32_ne_finalize.comp`. One workgroup of 256, eight of them to each of the 32 mean bins:
// a bin keeps the 5th-to-20th percentile of its own variance histogram - the envelope, which
// is what a bin's *noise* is once its textured blocks are excluded - and a Huber-weighted
// least squares over the 32 (mean, variance) pairs gives the slope. σ² is a placeholder here
// and comes from `ne_dark_finalize`.
//
// The reference's early return on a degenerate range is folded away rather than transcribed:
// WGSL will not admit a workgroup barrier past a branch on workgroup memory, and falling
// through lands on the same answer anyway, because a range that small leaves every bin under
// the 20-block floor and the `n_valid < 4` arm writes exactly the pair the bail wrote.

@group(0) @binding(0) var<storage, read> blk_mean: array<f32>;
@group(0) @binding(1) var<storage, read> blk_var: array<f32>;
@group(0) @binding(3) var<storage, read_write> params: array<f32>;

struct Push {
  width: i32,
  height: i32,
  total_blocks: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const NBINS: i32 = 32;
const VAR_BINS: i32 = 128;
const WG: i32 = 256;

var<workgroup> bin_mean_arr: array<f32, 32>;
var<workgroup> bin_var_arr: array<f32, 32>;
var<workgroup> bin_cnt_arr: array<i32, 32>;
var<workgroup> bin_valid: array<i32, 32>;
var<workgroup> global_min: f32;
var<workgroup> global_max: f32;
var<workgroup> lds_var_hist: array<atomic<i32>, 4096>;
var<workgroup> l_msum: array<f32, 32>;
var<workgroup> l_vmin: array<f32, 32>;
var<workgroup> l_vmax: array<f32, 32>;
var<workgroup> l_cnt: array<i32, 32>;
var<workgroup> r_cnt: array<i32, 256>;
var<workgroup> r_a: array<f32, 256>;
var<workgroup> r_b: array<f32, 256>;
var<workgroup> r_c: array<f32, 256>;

@compute @workgroup_size(256)
fn ne_finalize(@builtin(local_invocation_id) local: vec3u) {
  let lid = i32(local.x);
  let tpb = WG / NBINS;
  let bin = lid / tpb;
  let sub = lid % tpb;

  {
    var gmin = FLT_MAX;
    var gmax = 0.0;
    var nv = 0;
    for (var i = lid; i < pc.total_blocks; i += WG) {
      let bm = blk_mean[i];
      let bv = blk_var[i];
      if (bm > 0.003 && bm < 0.97 && bv < 1e9) {
        gmin = min(gmin, bm);
        gmax = max(gmax, bm);
        nv++;
      }
    }
    r_b[lid] = gmin;
    r_c[lid] = gmax;
    r_cnt[lid] = nv;
    workgroupBarrier();
    for (var s = WG >> 1u; s > 0; s >>= 1u) {
      if (lid < s) {
        r_b[lid] = min(r_b[lid], r_b[lid + s]);
        r_c[lid] = max(r_c[lid], r_c[lid + s]);
        r_cnt[lid] += r_cnt[lid + s];
      }
      workgroupBarrier();
    }
    if (lid == 0) {
      global_min = r_b[0];
      global_max = r_c[0];
    }
    workgroupBarrier();
  }

  let bw = (global_max - global_min) / f32(NBINS);
  let bin_lo = global_min + f32(bin) * bw;
  let bin_hi = bin_lo + bw;

  {
    var msum = 0.0;
    var vmin = FLT_MAX;
    var vmax = 0.0;
    var cnt = 0;
    for (var i = sub; i < pc.total_blocks; i += tpb) {
      let bm = blk_mean[i];
      let bv = blk_var[i];
      if (bm >= bin_lo && bm < bin_hi && bm > 0.003 && bm < 0.97 && bv < 1e9) {
        msum += bm;
        cnt++;
        vmin = min(vmin, bv);
        vmax = max(vmax, bv);
      }
    }
    r_cnt[lid] = cnt;
    r_a[lid] = msum;
    r_b[lid] = vmin;
    r_c[lid] = vmax;
    workgroupBarrier();
    for (var s = tpb >> 1u; s > 0; s >>= 1u) {
      if (sub < s) {
        let o = lid + s;
        r_cnt[lid] += r_cnt[o];
        r_a[lid] += r_a[o];
        r_b[lid] = min(r_b[lid], r_b[o]);
        r_c[lid] = max(r_c[lid], r_c[o]);
      }
      workgroupBarrier();
    }
    if (sub == 0) {
      l_cnt[bin] = r_cnt[lid];
      l_msum[bin] = r_a[lid];
      l_vmin[bin] = r_b[lid];
      l_vmax[bin] = r_c[lid];
    }
    workgroupBarrier();
  }

  let cnt = l_cnt[bin];
  let msum = l_msum[bin];
  let vmin = l_vmin[bin];
  let vmax = l_vmax[bin];
  let vrange = max(vmax - vmin, 1e-12);
  let vscale = f32(VAR_BINS) / vrange;

  for (var i = sub; i < VAR_BINS; i += tpb) {
    atomicStore(&lds_var_hist[bin * VAR_BINS + i], 0);
  }
  workgroupBarrier();

  if (cnt >= 20) {
    for (var i = sub; i < pc.total_blocks; i += tpb) {
      let bm = blk_mean[i];
      let bv = blk_var[i];
      if (bm >= bin_lo && bm < bin_hi && bm > 0.003 && bm < 0.97 && bv < 1e9) {
        var vbin = i32((bv - vmin) * vscale);
        vbin = clamp(vbin, 0, VAR_BINS - 1);
        atomicAdd(&lds_var_hist[bin * VAR_BINS + vbin], 1);
      }
    }
  }
  workgroupBarrier();

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
      for (var i = 0; i < VAR_BINS; i++) {
        cum += atomicLoad(&lds_var_hist[bin * VAR_BINS + i]);
        if (!found_p5 && cum >= p5_target) { p5_bin = i; found_p5 = true; }
        if (cum >= p20_target) { p20_bin = i; break; }
      }
      var vsum = 0.0;
      var vcnt = 0;
      for (var i = p5_bin; i <= p20_bin; i++) {
        let bin_center = vmin + (f32(i) + 0.5) / vscale;
        let n = atomicLoad(&lds_var_hist[bin * VAR_BINS + i]);
        vsum += bin_center * f32(n);
        vcnt += n;
      }
      bin_var_arr[bin] = select(vmin + 0.5 / vscale, vsum / f32(vcnt), vcnt > 0);
      bin_mean_arr[bin] = msum / f32(cnt);
      bin_cnt_arr[bin] = max(vcnt, 1);
      bin_valid[bin] = 1;
    }
  }
  workgroupBarrier();

  if (lid != 0) { return; }

  var n_valid = 0;
  for (var b = 0; b < NBINS; b++) {
    if (bin_valid[b] != 0) { n_valid++; }
  }
  if (n_valid < 4) {
    params[P_ALPHA] = 1e-4;
    params[P_SIGMA_SQ] = 1e-6;
    return;
  }

  var alpha_est = 0.01;
  var sigma_sq_est = 0.0;
  for (var iter = 0; iter < 5; iter++) {
    var huber_k = 1e10;
    if (iter > 0) {
      var resids: array<f32, 32>;
      var nr = 0;
      for (var b = 0; b < NBINS; b++) {
        if (bin_valid[b] == 0) { continue; }
        resids[nr] = abs(bin_var_arr[b] - (alpha_est * bin_mean_arr[b] + sigma_sq_est));
        nr++;
      }
      let target_r = nr / 2;
      for (var k = 0; k <= target_r; k++) {
        var min_idx = k;
        var min_val = resids[k];
        for (var j = k + 1; j < nr; j++) {
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
    for (var b = 0; b < NBINS; b++) {
      if (bin_valid[b] == 0) { continue; }
      var w = f32(bin_cnt_arr[b]);
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

  params[P_ALPHA] = max(alpha_est, 1e-8);
  params[P_SIGMA_SQ] = 0.0;
}
