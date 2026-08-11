// Luma into the domain where the noise has one variance everywhere.
//
// `yuv_gat_fwd.comp`. The mosaic path's forward transform carries a linear continuation
// below a knee, for samples that fall under the black level; nothing here can, so this is
// the plain square root and the two are not interchangeable.

@group(0) @binding(0) var<storage, read> y_lin: array<f32>;
@group(0) @binding(1) var<storage, read_write> y_stab: array<f32>;
@group(0) @binding(2) var<storage, read> params: array<f32>;

struct Push {
  npix: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(256)
fn yuv_gat_fwd(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let i = flat_index(id, groups, 256u);
  if (i >= pc.npix) { return; }
  let a = params[P_ALPHA];
  let c = 0.375 * a * a + params[P_SIGMA_SQ];
  y_stab[i] = (2.0 / max(a, 1e-12)) * sqrt(max(a * y_lin[i] + c, 0.0));
}
