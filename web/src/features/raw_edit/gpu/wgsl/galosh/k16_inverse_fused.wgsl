// Phases 9 and 10 in one pass: the final chroma upsample, straight into the inverse.
//
// The reference's `o32_k16_inverse_fused`, and the reason it exists is memory rather than
// speed: materialising `C1/C2/C3_aligned` costs three *full-resolution* planes, which at
// 61MP is 720MB of them for values every one of which is consumed by the next dispatch at
// the same coordinate. Fused, the whole denoise holds three full-res planes instead of six.
//
// The body is `k16_jbu_3p` followed by `inverse_wht_dark_gat`; both are transcribed there,
// with their own notes on why the hull clamp and the sign-preserving weight floor matter.

@group(0) @binding(0) var<storage, read> c1_in: array<f32>;
@group(0) @binding(1) var<storage, read> c2_in: array<f32>;
@group(0) @binding(2) var<storage, read> c3_in: array<f32>;
@group(0) @binding(3) var<storage, read> l_pixel: array<f32>;
@group(0) @binding(4) var<storage, read_write> out_raw: array<f32>;
@group(0) @binding(5) var<storage, read> lut_d: array<f32>;
@group(0) @binding(6) var<storage, read> lut_x: array<f32>;
@group(0) @binding(7) var<storage, read> lut_params: array<f32>;
@group(0) @binding(8) var<storage, read> params: array<f32>;

struct Push {
  in_w: i32,
  in_h: i32,
  bw: f32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const LUT_SIZE: i32 = 4096;

const K16_W = array<f32, 100>(
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 1.3804738955e-02, -3.6724216895e-02, 1.3804738955e-02, 0.0,
  0.0, -3.6724216895e-02, 1.0, -3.6724216895e-02, 0.0,
  0.0, 1.3804738955e-02, -3.6724216895e-02, 1.3804738955e-02, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 3.5811194091e-04, 3.5811194091e-04, 0.0,
  0.0, 0.0, 1.5746368940e-01, 1.5746368940e-01, 0.0,
  0.0, 0.0, 3.5811194091e-04, 3.5811194091e-04, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 3.5811194091e-04, 1.5746368940e-01, 3.5811194091e-04, 0.0,
  0.0, 3.5811194091e-04, 1.5746368940e-01, 3.5811194091e-04, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, -7.2646353170e-02, -7.2646353170e-02, 0.0,
  0.0, 0.0, -7.2646353170e-02, -7.2646353170e-02, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
);

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
fn k16_inverse_fused(@builtin(global_invocation_id) id: vec3u) {
  let out_w = 2 * pc.in_w;
  let out_h = 2 * pc.in_h;
  let fx = i32(id.x);
  let fy = i32(id.y);
  if (fx >= out_w || fy >= out_h) { return; }

  let hx = fx >> 1u;
  let hy = fy >> 1u;
  let sub_x = fx & 1;
  let sub_y = fy & 1;
  let si = sub_y * 2 + sub_x;

  let p = fy * out_w + fx;
  let l_c = l_pixel[p];
  let inv_2bw_sq = 1.0 / (2.0 * pc.bw * pc.bw);

  var sum_w = 0.0;
  var sum_c = vec3f(0.0);
  var cmin = vec3f(1e30);
  var cmax = vec3f(-1e30);

  for (var dy = -2; dy <= 2; dy++) {
    let hyi = clamp(hy + dy, 0, pc.in_h - 1);
    for (var dx = -2; dx <= 2; dx++) {
      let hxi = clamp(hx + dx, 0, pc.in_w - 1);
      let hi = hyi * pc.in_w + hxi;

      if ((dy == 0 || (sub_y != 0 && dy == 1)) && (dx == 0 || (sub_x != 0 && dx == 1))) {
        let iv = vec3f(c1_in[hi], c2_in[hi], c3_in[hi]);
        cmin = min(cmin, iv);
        cmax = max(cmax, iv);
      }

      let w_jinc = K16_W[si * 25 + (dy + 2) * 5 + (dx + 2)];
      if (w_jinc == 0.0) { continue; }

      let fri = min(2 * hyi, out_h - 1);
      let fci = min(2 * hxi, out_w - 1);
      let dl = l_pixel[fri * out_w + fci] - l_c;
      let w = w_jinc * exp(-dl * dl * inv_2bw_sq);

      sum_w += w;
      sum_c += w * vec3f(c1_in[hi], c2_in[hi], c3_in[hi]);
    }
  }

  var safe_w = sum_w;
  if (abs(sum_w) <= 1e-6) {
    safe_w = select(1e-6, -1e-6, sum_w < 0.0);
  }
  var c = sum_c / safe_w;
  if (cmax.x >= cmin.x) { c.x = clamp(c.x, cmin.x, cmax.x); }
  if (cmax.y >= cmin.y) { c.y = clamp(c.y, cmin.y, cmax.y); }
  if (cmax.z >= cmin.z) { c.z = clamp(c.z, cmin.z, cmax.z); }

  let slot = (fy & 1) | ((fx & 1) << 1u);
  let s1 = SIGNS[slot * 3 + 0];
  let s2 = SIGNS[slot * 3 + 1];
  let s3 = SIGNS[slot * 3 + 2];
  let val = 0.5 * (l_c + s1 * c.x + s2 * c.y + s3 * c.z) + params[P_DARK_REF0 + slot];

  out_raw[p] = clamp(
    gat_inv_lut(
      val * params[P_UNIFIED_SIGMA],
      lut_params[0],
      lut_params[1],
      lut_params[2],
      lut_params[3],
      lut_params[4],
    ),
    0.0,
    1.0,
  );
}
