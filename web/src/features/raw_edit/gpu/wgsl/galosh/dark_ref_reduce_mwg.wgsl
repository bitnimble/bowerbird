// Phase 2(a): the weighted sums the dark reference is fitted from, one workgroup's share.
//
// `o32_dark_ref_reduce_mwg.comp`. Only 2x2 blocks whose four GAT samples sit inside the
// achromatic range count, and each contributes a Tukey-bisquare weight off its own raw
// level - so what the fit sees is the near-black, near-neutral part of the frame, which is
// where a per-slot offset is visible at all.

@group(0) @binding(0) var<storage, read> in_gat_full: array<f32>;
@group(0) @binding(1) var<storage, read> raw: array<f32>;
@group(0) @binding(2) var<storage, read> params: array<f32>;
@group(0) @binding(3) var<storage, read_write> partial_buf: array<f32>;

struct Push {
  width: i32,
  height: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const ACHROMATIC_RANGE: f32 = 4.0;
const WGSIZE: i32 = 256;

var<workgroup> lds_s: array<f32, 1280>;
var<workgroup> lds_c: array<f32, 1280>;

@compute @workgroup_size(256)
fn dark_ref_reduce_mwg(
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

  let n_block_rows = pc.height / 2;
  let n_block_cols = pc.width / 2;
  let total_blocks = n_block_rows * n_block_cols;

  var sw_s = 0.0;
  var sw_c = 0.0;
  var sw0_s = 0.0;
  var sw0_c = 0.0;
  var sw1_s = 0.0;
  var sw1_c = 0.0;
  var sw2_s = 0.0;
  var sw2_c = 0.0;
  var sw3_s = 0.0;
  var sw3_c = 0.0;

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
    kacc(&sw_s, &sw_c, w);
    kacc(&sw0_s, &sw0_c, w * g0);
    kacc(&sw1_s, &sw1_c, w * g1);
    kacc(&sw2_s, &sw2_c, w * g2);
    kacc(&sw3_s, &sw3_c, w * g3);
  }

  lds_s[lid * 5 + 0] = sw_s;
  lds_c[lid * 5 + 0] = sw_c;
  lds_s[lid * 5 + 1] = sw0_s;
  lds_c[lid * 5 + 1] = sw0_c;
  lds_s[lid * 5 + 2] = sw1_s;
  lds_c[lid * 5 + 2] = sw1_c;
  lds_s[lid * 5 + 3] = sw2_s;
  lds_c[lid * 5 + 3] = sw2_c;
  lds_s[lid * 5 + 4] = sw3_s;
  lds_c[lid * 5 + 4] = sw3_c;
  workgroupBarrier();

  for (var s = WGSIZE / 2; s > 0; s >>= 1u) {
    if (lid < s) {
      for (var q = 0; q < 5; q++) {
        var as_ = lds_s[lid * 5 + q];
        var ac = lds_c[lid * 5 + q];
        kcombine(&as_, &ac, lds_s[(lid + s) * 5 + q], lds_c[(lid + s) * 5 + q]);
        lds_s[lid * 5 + q] = as_;
        lds_c[lid * 5 + q] = ac;
      }
    }
    workgroupBarrier();
  }

  if (lid == 0) {
    // Pairs, not collapsed sums: the finalize combines the 64 of them compensated, and
    // adding `comp` in here would throw away what the scheme exists for.
    for (var q = 0; q < 5; q++) {
      partial_buf[wgid * 10 + q * 2 + 0] = lds_s[q];
      partial_buf[wgid * 10 + q * 2 + 1] = lds_c[q];
    }
  }
}
