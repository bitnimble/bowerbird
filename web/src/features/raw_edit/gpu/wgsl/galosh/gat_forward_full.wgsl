// Phase 1(a): the generalised Anscombe transform, forward, over the whole mosaic.
//
// `o32_gat_forward_full.comp`. The per-CFA `ch0..3` stores the reference still binds are
// dropped: nothing on the o32 path reads them, and the reference proved that removal
// byte-identical (HOST_BLUEPRINT trap #7).

@group(0) @binding(0) var<storage, read> raw: array<f32>;
@group(0) @binding(1) var<storage, read_write> in_gat_full: array<f32>;
@group(0) @binding(6) var<storage, read> params: array<f32>;

struct Push {
  width: i32,
  height: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(16, 16)
fn gat_forward_full(@builtin(global_invocation_id) id: vec3u) {
  let fx = i32(id.x);
  let fy = i32(id.y);
  if (fx >= pc.width || fy >= pc.height) { return; }

  let a = params[P_ALPHA];
  let sq = params[P_SIGMA_SQ];
  let sigma_raw = sqrt(max(sq, 1e-20));
  let y_break = -0.375 * a;
  let t_break = 2.0 * sigma_raw / a;

  let x = raw[fy * pc.width + fx];
  // A NaN guard and no clamp: `x == x` is false only for NaN, which needs an ordered
  // compare, so nothing on this path may be built with fast math.
  var x_safe = x;
  if (!(x == x)) { x_safe = 0.0; }

  var t: f32;
  if (x_safe >= y_break) {
    let arg = a * x_safe + 0.375 * a * a + sq;
    t = (2.0 / a) * sqrt(max(arg, 0.0));
  } else {
    // The C¹ linear continuation below the sqrt branch's knee.
    t = t_break + (x_safe - y_break) / sigma_raw;
  }

  in_gat_full[fy * pc.width + fx] = t;
}
