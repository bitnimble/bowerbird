// Phase 1(c): the four channel sigmas, unified by RMS.
//
// `o32_unified_sigma.comp`. Everything downstream works in units of this one number, and
// `inverse_wht_dark_gat` multiplies it back at the end.

@group(0) @binding(0) var<storage, read_write> params: array<f32>;

@compute @workgroup_size(256)
fn unified_sigma(@builtin(global_invocation_id) id: vec3u) {
  if (id.x != 0u) { return; }
  let s0 = params[P_SIGMA_CH0];
  let s1 = params[P_SIGMA_CH0 + 1];
  let s2 = params[P_SIGMA_CH0 + 2];
  let s3 = params[P_SIGMA_CH0 + 3];
  let mean_var = 0.25 * (s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3);
  let unified = sqrt(max(mean_var, 1e-12));
  params[P_UNIFIED_SIGMA] = unified;
  params[P_INV_SG] = 1.0 / unified;
}
