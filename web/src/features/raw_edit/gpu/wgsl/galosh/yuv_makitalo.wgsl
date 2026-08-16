// The stabilised luma back to what it measures, through the exact unbiased inverse.
//
// `yuv_makitalo.comp`, off the same table `build_inv_lut` fills for the mosaic path. Below
// the table's first entry it takes the analytical tail rather than clamping to it, which is
// what keeps a dark frame's shadows from flattening onto one value.

@group(0) @binding(0) var<storage, read> d_stab: array<f32>;
@group(0) @binding(1) var<storage, read_write> x_out: array<f32>;
@group(0) @binding(2) var<storage, read> lut_d: array<f32>;
@group(0) @binding(3) var<storage, read> lut_x: array<f32>;
@group(0) @binding(4) var<storage, read> lut_params: array<f32>;

struct Push {
  /// One past the last pixel this dispatch owns; `start` is the first. Zero and the whole frame
  /// is what every native caller sends, so a banded browser tick is the only thing that differs.
  npix: i32,
  start: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const LUT_SIZE: i32 = 4096;

@compute @workgroup_size(256)
fn yuv_makitalo(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let i = pc.start + flat_index(id, groups, 256u);
  if (i >= pc.npix) { return; }

  let d = d_stab[i];
  let d_min = lut_params[0];
  let d_max = lut_params[1];

  if (d <= d_min) {
    x_out[i] = lut_params[2] + lut_params[4] * (d - lut_params[3]);
    return;
  }
  if (d >= d_max) {
    x_out[i] = 1.0;
    return;
  }

  var lo = 0;
  var hi = LUT_SIZE - 1;
  while (hi - lo > 1) {
    let mid = (lo + hi) >> 1u;
    if (lut_d[mid] <= d) { lo = mid; } else { hi = mid; }
  }
  let t = (d - lut_d[lo]) / max(lut_d[hi] - lut_d[lo], 1e-10);
  x_out[i] = lut_x[lo] + t * (lut_x[hi] - lut_x[lo]);
}
