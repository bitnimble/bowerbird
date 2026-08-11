// The IRLS scale and the bounds it is held inside, seeded from the blind fit.
//
// The reference does this on the host, which costs it a mid-frame readback and a second
// submission: the CPU reads α and σ² back, divides, and passes the two bounds as kernel
// arguments to every `dark_resid_finalize_mwg`. Three divisions are not worth a pipeline
// stall, so they happen here and the bounds go in the two params slots the o32 path leaves
// free - which is what lets the whole denoise be one command buffer and one readback.

@group(0) @binding(0) var<storage, read_write> params: array<f32>;

@compute @workgroup_size(256)
fn irls_seed(@builtin(global_invocation_id) id: vec3u) {
  if (id.x != 0u) { return; }
  let s_init = params[P_SIGMA_SQ] / max(params[P_ALPHA], 1e-12);
  params[P_S_SCALE] = s_init;
  params[P_S_MIN] = 0.05 * s_init;
  params[P_S_MAX] = 50.0 * s_init;
}
