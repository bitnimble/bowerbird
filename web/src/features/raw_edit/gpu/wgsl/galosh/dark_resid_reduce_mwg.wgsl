// Phase 2(a): the weighted residual against the dark reference just fitted.
//
// `o32_dark_resid_reduce_mwg.comp`. The IRLS iteration: this measures how far the blocks sit
// from the fit, and `dark_resid_finalize_mwg` turns that into the next Tukey scale.

@group(0) @binding(0) var<storage, read> in_gat_full: array<f32>;
@group(0) @binding(1) var<storage, read> raw: array<f32>;
@group(0) @binding(2) var<storage, read> params: array<f32>;
@group(0) @binding(3) var<storage, read_write> partial_resid_buf: array<f32>;

struct Push {
  width: i32,
  height: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const ACHROMATIC_RANGE: f32 = 4.0;
const WGSIZE: i32 = 256;

var<workgroup> lds_s: array<f32, 512>;
var<workgroup> lds_c: array<f32, 512>;

@compute @workgroup_size(256)
fn dark_resid_reduce_mwg(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_id) local: vec3u,
  @builtin(workgroup_id) group: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let gid = i32(id.x);
  let lid = i32(local.x);
  let wgid = i32(group.x);
  let total_wis = i32(groups.x) * WGSIZE;

  let inv_s = 1.0 / max(params[P_S_SCALE], 1e-20);
  let dr0 = params[P_DARK_REF0 + 0];
  let dr1 = params[P_DARK_REF0 + 1];
  let dr2 = params[P_DARK_REF0 + 2];
  let dr3 = params[P_DARK_REF0 + 3];

  let n_block_rows = pc.height / 2;
  let n_block_cols = pc.width / 2;
  let total_blocks = n_block_rows * n_block_cols;

  var swr_s = 0.0;
  var swr_c = 0.0;
  var sww_s = 0.0;
  var sww_c = 0.0;

  for (var bi = gid; bi < total_blocks; bi += total_wis) {
    let br_idx = bi / n_block_cols;
    let bc_idx = bi - br_idx * n_block_cols;
    let br = 2 * br_idx;
    let bc = 2 * bc_idx;

    let g0 = in_gat_full[br * pc.width + bc];
    let g1 = in_gat_full[(br + 1) * pc.width + bc];
    let g2 = in_gat_full[br * pc.width + (bc + 1)];
    let g3 = in_gat_full[(br + 1) * pc.width + (bc + 1)];
    let ch_max = max(max(g0, g1), max(g2, g3));
    let ch_min = min(min(g0, g1), min(g2, g3));
    if (ch_max - ch_min > ACHROMATIC_RANGE) { continue; }

    let iv0 = raw[br * pc.width + bc];
    let iv1 = raw[(br + 1) * pc.width + bc];
    let iv2 = raw[br * pc.width + (bc + 1)];
    let iv3 = raw[(br + 1) * pc.width + (bc + 1)];
    let l_raw = (iv0 + iv1 + iv2 + iv3) * 0.25;
    let r = l_raw * inv_s;
    let r2 = r * r;
    let w = 1.0 / (1.0 + r2 * r2);
    let d0 = g0 - dr0;
    let d1 = g1 - dr1;
    let d2 = g2 - dr2;
    let d3 = g3 - dr3;
    let resid2 = d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
    kacc(&sww_s, &sww_c, w);
    kacc(&swr_s, &swr_c, w * resid2 * 0.25);
  }

  lds_s[lid * 2 + 0] = swr_s;
  lds_c[lid * 2 + 0] = swr_c;
  lds_s[lid * 2 + 1] = sww_s;
  lds_c[lid * 2 + 1] = sww_c;
  workgroupBarrier();

  for (var s = WGSIZE / 2; s > 0; s >>= 1u) {
    if (lid < s) {
      for (var q = 0; q < 2; q++) {
        var as_ = lds_s[lid * 2 + q];
        var ac = lds_c[lid * 2 + q];
        kcombine(&as_, &ac, lds_s[(lid + s) * 2 + q], lds_c[(lid + s) * 2 + q]);
        lds_s[lid * 2 + q] = as_;
        lds_c[lid * 2 + q] = ac;
      }
    }
    workgroupBarrier();
  }

  if (lid == 0) {
    partial_resid_buf[wgid * 4 + 0] = lds_s[0];
    partial_resid_buf[wgid * 4 + 1] = lds_c[0];
    partial_resid_buf[wgid * 4 + 2] = lds_s[1];
    partial_resid_buf[wgid * 4 + 3] = lds_c[1];
  }
}
