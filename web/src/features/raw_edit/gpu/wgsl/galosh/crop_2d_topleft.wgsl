// Phase 7: a guide cropped to the even size the upsample insists on.
//
// `o32_crop_2d_topleft.comp`. `k16_jbu_3p` writes exactly twice its input's dimensions, so an
// odd level is cropped on the way in here and edge-padded back out by `pad_2d_edge`.

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
fn crop_2d_topleft(@builtin(global_invocation_id) id: vec3u) {
  let dx = i32(id.x);
  let dy = i32(id.y);
  if (dx >= pc.dw || dy >= pc.dh) { return; }
  dst[dy * pc.dw + dx] = src[dy * pc.sw + dx];
}
