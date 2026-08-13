// Phase 8: the chroma strength, as a walk along three anchors.
//
// `o32_smoothstep_blend_3p.comp`. The slider runs 0..2 across noisy, the LOESS baseline at half
// res, and the quarter-res level upsampled - so its unit is *how far the colour is allowed to be
// smoothed*, in scales, rather than an amount of anything. The smoothstep is what keeps the
// crossings from showing as the slider moves.
//
// **The reference walks a fourth anchor at eighth resolution and this does not.** `from_sliders`
// has always mapped the Colour slider onto 0..2, so that leg was unreachable - while the whole
// eighth-resolution branch that fed it ran on every photograph, ~10 dispatches and a quarter of a
// gigabyte at 61MP, to produce a plane multiplied by zero. Restoring it means widening the slider,
// and that wants more than a scale: the eighth level's reach composes to ~88 sensor pixels through
// the two upsamples, against the 64 `TILE_HALO` gives a loupe tile.

// The answer is written back over the second anchor rather than into a fourth set of
// half-resolution planes: this is the last thing that reads the regression, and three more
// planes at 61MP is 90MB spent moving values between two addresses.
@group(0) @binding(0) var<storage, read> c1_h: array<f32>;
@group(0) @binding(1) var<storage, read> c2_h: array<f32>;
@group(0) @binding(2) var<storage, read> c3_h: array<f32>;
@group(0) @binding(3) var<storage, read_write> c1_loess_h: array<f32>;
@group(0) @binding(4) var<storage, read_write> c2_loess_h: array<f32>;
@group(0) @binding(5) var<storage, read_write> c3_loess_h: array<f32>;
@group(0) @binding(6) var<storage, read> c1_q_up: array<f32>;
@group(0) @binding(7) var<storage, read> c2_q_up: array<f32>;
@group(0) @binding(8) var<storage, read> c3_q_up: array<f32>;

struct Push {
  width: i32,
  height: i32,
  slider: f32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(16, 16)
fn smoothstep_blend_3p(@builtin(global_invocation_id) id: vec3u) {
  let x = i32(id.x);
  let y = i32(id.y);
  if (x >= pc.width || y >= pc.height) { return; }

  let p = y * pc.width + x;
  let a = vec3f(c1_h[p], c2_h[p], c3_h[p]);
  let b = vec3f(c1_loess_h[p], c2_loess_h[p], c3_loess_h[p]);
  let c = vec3f(c1_q_up[p], c2_q_up[p], c3_q_up[p]);

  var blended: vec3f;
  if (pc.slider <= 0.0) {
    blended = a;
  } else if (pc.slider >= 2.0) {
    blended = c;
  } else {
    var lo: vec3f;
    var hi: vec3f;
    var t_raw: f32;
    if (pc.slider <= 1.0) {
      t_raw = pc.slider;
      lo = a;
      hi = b;
    } else {
      t_raw = pc.slider - 1.0;
      lo = b;
      hi = c;
    }
    let t = t_raw * t_raw * (3.0 - 2.0 * t_raw);
    blended = (1.0 - t) * lo + t * hi;
  }

  c1_loess_h[p] = blended.x;
  c2_loess_h[p] = blended.y;
  c3_loess_h[p] = blended.z;
}
