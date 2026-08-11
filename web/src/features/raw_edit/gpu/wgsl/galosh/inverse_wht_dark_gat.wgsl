// Phase 10: the mosaic put back together and taken out of the GAT domain.
//
// `o32_inverse_wht_dark_gat.comp`. The inverse 2x2 transform per CFA slot, the dark
// reference added back, the unit-noise scaling undone, and the exact unbiased inverse read
// off the table `build_inv_lut` filled.

@group(0) @binding(0) var<storage, read> l_pixel: array<f32>;
@group(0) @binding(1) var<storage, read> c1_aligned: array<f32>;
@group(0) @binding(2) var<storage, read> c2_aligned: array<f32>;
@group(0) @binding(3) var<storage, read> c3_aligned: array<f32>;
@group(0) @binding(4) var<storage, read_write> out_raw: array<f32>;
@group(0) @binding(5) var<storage, read> lut_d: array<f32>;
@group(0) @binding(6) var<storage, read> lut_x: array<f32>;
@group(0) @binding(7) var<storage, read> lut_params: array<f32>;
@group(0) @binding(8) var<storage, read> params: array<f32>;

struct Push {
  width: i32,
  height: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const LUT_SIZE: i32 = 4096;

// Inverse 2x2 WHT signs in (R, Gb, Gr, B) order, indexed by CFA slot directly - the slot is
// not remapped through a sub-pixel index, which is a fix the reference carries and a port
// can silently undo.
const SIGNS = array<f32, 12>(
  1.0, 1.0, 1.0,
  -1.0, 1.0, -1.0,
  1.0, -1.0, -1.0,
  -1.0, -1.0, 1.0,
);

fn gat_inv_lut(d: f32, d_min: f32, d_max: f32, y_break: f32, t_break: f32, sigma_raw: f32) -> f32 {
  if (d <= d_min) { return y_break + sigma_raw * (d - t_break); }
  if (d >= d_max) { return 1.0; }

  var lo = 0;
  var hi = LUT_SIZE - 1;
  while (lo + 1 < hi) {
    let mid = (lo + hi) >> 1u;
    if (lut_d[mid] <= d) { lo = mid; } else { hi = mid; }
  }
  let d0 = lut_d[lo];
  let d1 = lut_d[lo + 1];
  let t = (d - d0) / max(d1 - d0, 1e-10);
  return lut_x[lo] + t * (lut_x[lo + 1] - lut_x[lo]);
}

@compute @workgroup_size(16, 16)
fn inverse_wht_dark_gat(@builtin(global_invocation_id) id: vec3u) {
  let fx = i32(id.x);
  let fy = i32(id.y);
  if (fx >= pc.width || fy >= pc.height) { return; }

  let slot = (fy & 1) | ((fx & 1) << 1u);
  let p = fy * pc.width + fx;

  let l = l_pixel[p];
  let c1 = c1_aligned[p];
  let c2 = c2_aligned[p];
  let c3 = c3_aligned[p];
  let s1 = SIGNS[slot * 3 + 0];
  let s2 = SIGNS[slot * 3 + 1];
  let s3 = SIGNS[slot * 3 + 2];

  let val = 0.5 * (l + s1 * c1 + s2 * c2 + s3 * c3) + params[P_DARK_REF0 + slot];
  let d = val * params[P_UNIFIED_SIGMA];
  out_raw[p] = clamp(
    gat_inv_lut(d, lut_params[0], lut_params[1], lut_params[2], lut_params[3], lut_params[4]),
    0.0,
    1.0,
  );
}
