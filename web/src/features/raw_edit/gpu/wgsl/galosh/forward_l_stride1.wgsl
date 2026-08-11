// Phase 3: the luma term of the 2x2 Walsh-Hadamard transform, at stride 1.
//
// `o32_forward_l_stride1.comp`, without its FP16 storage contract: every buffer here is f32,
// which is the precision the CPU reference is canonical in and the one the parity fixture
// compares against. The contract exists to save bandwidth on a phone, and costs 0.1-0.7 dB.
//
// Stride 1 rather than 2 means every pixel begins a block, so the denoise below sees all
// sixteen phases of the transform rather than one - `lpixel_overlap_avg` averages them back.

@group(0) @binding(0) var<storage, read> in_gat_full: array<f32>;
@group(0) @binding(1) var<storage, read_write> l_cs: array<f32>;

struct Push {
  width: i32,
  height: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(16, 16)
fn forward_l_stride1(@builtin(global_invocation_id) id: vec3u) {
  let x = i32(id.x);
  let y = i32(id.y);
  if (x >= pc.width || y >= pc.height) { return; }

  var yb = y + 1;
  if (yb >= pc.height) { yb = pc.height - 2; }
  if (yb < 0) { yb = 0; }
  var xb = x + 1;
  if (xb >= pc.width) { xb = pc.width - 2; }
  if (xb < 0) { xb = 0; }

  let a = in_gat_full[y * pc.width + x];
  let b = in_gat_full[yb * pc.width + x];
  let cc = in_gat_full[y * pc.width + xb];
  let d = in_gat_full[yb * pc.width + xb];
  l_cs[y * pc.width + x] = 0.5 * (a + b + cc + d);
}
