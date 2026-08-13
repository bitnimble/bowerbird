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
  // **A zero scale is not a scale, it is a stuck one.** `sigma_sq` is zero on more than the
  // degenerate path: `ne_finalize` writes it as zero outright and the dark phase fills it in
  // afterwards, so a frame whose dark statistics bail - too few samples - arrives here still at
  // zero. Both bounds would then be zero too, and every later `clamp(s, S_MIN, S_MAX)` pins the
  // IRLS scale at zero for the rest of the run: the residual weights all collapse, the dark
  // references come out equal, and the fixed-pattern offset this phase exists to remove is
  // subtracted and added back unchanged. Silent, because the picture is otherwise correct.
  //
  // The floor only decides how wide the window opens in that case; any positive value leaves the
  // iteration able to find its own scale, which is what it does from here on.
  let s_init = max(params[P_SIGMA_SQ] / max(params[P_ALPHA], 1e-12), 1e-6);
  params[P_S_SCALE] = s_init;
  params[P_S_MIN] = 0.05 * s_init;
  params[P_S_MAX] = 50.0 * s_init;
}
