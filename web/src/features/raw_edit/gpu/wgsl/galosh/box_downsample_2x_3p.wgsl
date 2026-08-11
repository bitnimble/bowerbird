// Phase 7: the same downsample over the three chroma planes at once.
//
// `o32_box_downsample_2x_3p.comp`.

@group(0) @binding(0) var<storage, read> src1: array<f32>;
@group(0) @binding(1) var<storage, read> src2: array<f32>;
@group(0) @binding(2) var<storage, read> src3: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst1: array<f32>;
@group(0) @binding(4) var<storage, read_write> dst2: array<f32>;
@group(0) @binding(5) var<storage, read_write> dst3: array<f32>;

struct Push {
  sw: i32,
  sh: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(16, 16)
fn box_downsample_2x_3p(@builtin(global_invocation_id) id: vec3u) {
  let dw = pc.sw >> 1u;
  let dh = pc.sh >> 1u;
  let dx = i32(id.x);
  let dy = i32(id.y);
  if (dx >= dw || dy >= dh) { return; }

  let sx = 2 * dx;
  let sy = 2 * dy;
  let p00 = sy * pc.sw + sx;
  let p01 = sy * pc.sw + (sx + 1);
  let p10 = (sy + 1) * pc.sw + sx;
  let p11 = (sy + 1) * pc.sw + (sx + 1);
  let dp = dy * dw + dx;
  dst1[dp] = 0.25 * (src1[p00] + src1[p01] + src1[p10] + src1[p11]);
  dst2[dp] = 0.25 * (src2[p00] + src2[p01] + src2[p10] + src2[p11]);
  dst3[dp] = 0.25 * (src3[p00] + src3[p01] + src3[p10] + src3[p11]);
}
