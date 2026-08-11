// The table's own ends, once every entry has been written.
//
// `o32_lut_finalize.comp`. Its own dispatch because `build_inv_lut` fills the entries in
// parallel and no invocation there can see both ends.

@group(0) @binding(0) var<storage, read> lut_d: array<f32>;
@group(0) @binding(1) var<storage, read_write> lut_params: array<f32>;

const LUT_SIZE: i32 = 4096;

@compute @workgroup_size(256)
fn lut_finalize(@builtin(global_invocation_id) id: vec3u) {
  if (id.x != 0u) { return; }
  lut_params[0] = lut_d[0];
  lut_params[1] = lut_d[LUT_SIZE - 1];
}
