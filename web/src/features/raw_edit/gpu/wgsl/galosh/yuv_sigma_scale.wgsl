// The stabilised luma scaled to unit noise, and back again.
//
// `yuv_sigma_norm.comp` and `yuv_sigma_denorm.comp`, which differ only in which way the
// multiply goes - the shrinkage's thresholds are stated in units of one sigma, so the plane
// has to arrive at exactly that scale and leave at the one the inverse table was built for.
//
// **One sigma for the frame, and it has to be one.** A frame's noise really does depend on
// level - in PQ it falls by orders of magnitude from the low midtones to white - and an earlier
// version of this divided by a curve indexed on each pixel's own level, which is worse than
// useless: the divisor's spatial variation *is* the image's gradient, and writing it into the
// plane whose local deviation `pass12` then measures inflates `mad_sigma_y_sq`, inflates
// `sigma_x_sq` with it, and collapses lambda. Measured on an ISO 25600 frame at full strength,
// one sigma leaves a roughness of 1.43 where a per-level curve of the same magnitude leaves
// 3.89, having barely denoised at all.
//
// A per-level threshold is still the better answer. It has to reach `pass12` as a threshold
// chosen per block, against an unscaled plane, rather than as a scaling of its input.
//
// The sigma itself is measured where the frame is built (`native/rawshim/src/noise.rs`), binned
// by level and collapsed by how many blocks each bin holds, so it is the noise of a typical
// block of this photograph rather than a quantile of whatever its histogram happened to be.

@group(0) @binding(0) var<storage, read_write> plane: array<f32>;
@group(0) @binding(1) var<storage, read> params: array<f32>;

struct Push {
  npix: i32,
  sigma_slot: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(256)
fn yuv_sigma_norm(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let i = flat_index(id, groups, 256u);
  if (i >= pc.npix) { return; }
  plane[i] /= max(params[pc.sigma_slot], 1e-6);
}

@compute @workgroup_size(256)
fn yuv_sigma_denorm(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let i = flat_index(id, groups, 256u);
  if (i >= pc.npix) { return; }
  plane[i] *= max(params[pc.sigma_slot], 1e-6);
}
