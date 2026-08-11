// A noise model synthesised from one measured sigma.
//
// `yuv_synth_alpha.comp`. The mosaic path fits α and σ² separately, off the slope of
// variance against level and off the dark pixels' Laplacians; a frame that has already been
// demosaiced and graded has neither of those left to read, so the sRGB path measures a
// single sigma and splits it by a fixed ratio. Cruder, and the reference's own answer to
// the same problem.

@group(0) @binding(0) var<storage, read_write> params: array<f32>;

struct Push {
  sigma_slot: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(256)
fn yuv_synth_alpha(@builtin(global_invocation_id) id: vec3u) {
  if (id.x != 0u) { return; }
  let sigma_lin = params[pc.sigma_slot];
  params[P_ALPHA] = max(sigma_lin * 0.1, 1e-5);
  params[P_SIGMA_SQ] = max(sigma_lin * sigma_lin, 1e-8);
}
