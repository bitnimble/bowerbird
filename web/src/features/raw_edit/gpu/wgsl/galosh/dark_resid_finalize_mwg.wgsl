// Phase 2(a): the next IRLS scale, held inside the bounds the host set from α and σ².
//
// `o32_dark_resid_finalize_mwg.comp`.

@group(0) @binding(0) var<storage, read> partial_resid_buf: array<f32>;
@group(0) @binding(1) var<storage, read_write> params: array<f32>;

struct Push {
  n_wg: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(256)
fn dark_resid_finalize_mwg(@builtin(global_invocation_id) id: vec3u) {
  if (id.x != 0u) { return; }

  var swr_s = 0.0;
  var swr_c = 0.0;
  var sww_s = 0.0;
  var sww_c = 0.0;
  for (var i = 0; i < pc.n_wg; i++) {
    kcombine(&swr_s, &swr_c, partial_resid_buf[i * 4 + 0], partial_resid_buf[i * 4 + 1]);
    kcombine(&sww_s, &sww_c, partial_resid_buf[i * 4 + 2], partial_resid_buf[i * 4 + 3]);
  }

  let inv_sw2 = 1.0 / max(sww_s + sww_c, 1e-20);
  let measured_std = sqrt(max((swr_s + swr_c) * inv_sw2, 1e-20));
  let ratio = 1.0 / measured_std;
  params[P_S_SCALE] = clamp(params[P_S_SCALE] * sqrt(ratio), params[P_S_MIN], params[P_S_MAX]);
}
