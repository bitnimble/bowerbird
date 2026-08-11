// Phase 2(b): each CFA slot's own dark reference, subtracted.
//
// `o32_dark_sub_full.comp`. `inverse_wht_dark_gat` adds the same four numbers back.

@group(0) @binding(0) var<storage, read_write> in_gat_full: array<f32>;
@group(0) @binding(5) var<storage, read> params: array<f32>;

struct Push {
  width: i32,
  height: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(16, 16)
fn dark_sub_full(@builtin(global_invocation_id) id: vec3u) {
  let fx = i32(id.x);
  let fy = i32(id.y);
  if (fx >= pc.width || fy >= pc.height) { return; }

  let slot = (fy & 1) | ((fx & 1) << 1u);
  in_gat_full[fy * pc.width + fx] -= params[P_DARK_REF0 + slot];
}
