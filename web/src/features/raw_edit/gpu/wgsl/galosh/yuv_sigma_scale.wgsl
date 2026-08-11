// The stabilised luma scaled to unit noise, and back again.
//
// `yuv_sigma_norm.comp` and `yuv_sigma_denorm.comp`, which differ only in which way the
// multiply goes - the shrinkage's thresholds are stated in units of one sigma, so the plane
// has to arrive at exactly that scale and leave at the one the inverse table was built for.

@group(0) @binding(0) var<storage, read_write> plane: array<f32>;
@group(0) @binding(1) var<storage, read> params: array<f32>;

struct Push {
  npix: i32,
  sigma_slot: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(256)
fn yuv_sigma_norm(@builtin(global_invocation_id) id: vec3u) {
  let i = i32(id.x);
  if (i >= pc.npix) { return; }
  plane[i] /= max(params[pc.sigma_slot], 1e-6);
}

@compute @workgroup_size(256)
fn yuv_sigma_denorm(@builtin(global_invocation_id) id: vec3u) {
  let i = i32(id.x);
  if (i >= pc.npix) { return; }
  plane[i] *= params[pc.sigma_slot];
}
