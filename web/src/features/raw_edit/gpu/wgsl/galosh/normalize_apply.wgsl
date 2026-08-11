// Phase 1(d): the GAT frame scaled to unit noise, in place.
//
// `o32_normalize_apply.comp`. The dead per-CFA read-modify-writes the reference still binds
// are dropped, as in `gat_forward_full`.

@group(0) @binding(0) var<storage, read_write> in_gat_full: array<f32>;
@group(0) @binding(5) var<storage, read> params: array<f32>;

struct Push {
  width: i32,
  height: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(16, 16)
fn normalize_apply(@builtin(global_invocation_id) id: vec3u) {
  let fx = i32(id.x);
  let fy = i32(id.y);
  if (fx >= pc.width || fy >= pc.height) { return; }
  in_gat_full[fy * pc.width + fx] *= params[P_INV_SG];
}
