// Phase 7: the crop undone, by replicating the last row and column.
//
// `o32_pad_2d_edge.comp`.

@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;

struct Push {
  sw: i32,
  sh: i32,
  dw: i32,
  dh: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(16, 16)
fn pad_2d_edge(@builtin(global_invocation_id) id: vec3u) {
  let dx = i32(id.x);
  let dy = i32(id.y);
  if (dx >= pc.dw || dy >= pc.dh) { return; }
  let sx = min(dx, pc.sw - 1);
  let sy = min(dy, pc.sh - 1);
  dst[dy * pc.dw + dx] = src[sy * pc.sw + sx];
}
