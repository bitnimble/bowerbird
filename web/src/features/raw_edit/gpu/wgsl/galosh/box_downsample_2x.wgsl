// Phase 7: one level down the guide pyramid.
//
// `o32_box_downsample_2x.comp`.

@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;

struct Push {
  sw: i32,
  sh: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(16, 16)
fn box_downsample_2x(@builtin(global_invocation_id) id: vec3u) {
  let dw = pc.sw >> 1u;
  let dh = pc.sh >> 1u;
  let dx = i32(id.x);
  let dy = i32(id.y);
  if (dx >= dw || dy >= dh) { return; }

  let sx = 2 * dx;
  let sy = 2 * dy;
  let a = src[sy * pc.sw + sx];
  let b = src[sy * pc.sw + (sx + 1)];
  let c = src[(sy + 1) * pc.sw + sx];
  let d = src[(sy + 1) * pc.sw + (sx + 1)];
  dst[dy * dw + dx] = 0.25 * (a + b + c + d);
}
