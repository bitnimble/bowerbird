// Phase 0(g): the exact unbiased inverse GAT, tabulated, one invocation per entry.
//
// `o32_build_inv_lut.comp`. A Poisson sum over photon counts, each term integrated against
// the read noise by 10-point Gauss-Hermite. The table depends on nothing but (α, σ²), so its
// cost is the same at any resolution.
//
// Every running sum is Neumaier-compensated, which is not decoration: the reference used
// f64 here and the compensated f32 is what replaced it. `log` of zero is undefined in WGSL
// rather than -inf, so λ = 0 goes through a finite sentinel that `exp_s` floors to zero -
// the same term-by-term result, without relying on infinity arithmetic.

@group(0) @binding(0) var<storage, read> params: array<f32>;
@group(0) @binding(1) var<storage, read_write> lut_d: array<f32>;
@group(0) @binding(2) var<storage, read_write> lut_x: array<f32>;
@group(0) @binding(3) var<storage, read_write> lut_params: array<f32>;

const LUT_SIZE: i32 = 4096;

const GH_NODES = array<f32, 10>(
  -3.436159, -2.532732, -1.756684, -1.036611, -0.342901,
  0.342901, 1.036611, 1.756684, 2.532732, 3.436159,
);
const GH_WEIGHTS = array<f32, 10>(
  7.640432855232641e-06, 1.343645746781232e-03, 3.387439445548111e-02,
  2.401386110823147e-01, 6.108626337353258e-01,
  6.108626337353258e-01, 2.401386110823147e-01, 3.387439445548111e-02,
  1.343645746781232e-03, 7.640432855232641e-06,
);

const LOG_ZERO_SENTINEL: f32 = -1e30;

fn log_s(x: f32) -> f32 {
  if (x <= 0.0) { return LOG_ZERO_SENTINEL; }
  return log(x);
}

fn exp_s(x: f32) -> f32 {
  // f32 `exp` underflows below about -87.3, so everything under -87 - the sentinel chain
  // included - is a hard zero rather than a denormal that differs by vendor.
  if (x < -87.0) { return 0.0; }
  return exp(x);
}

@compute @workgroup_size(256)
fn build_inv_lut(@builtin(global_invocation_id) id: vec3u) {
  let i = i32(id.x);
  if (i >= LUT_SIZE) { return; }

  let a = params[P_ALPHA];
  let sq = params[P_SIGMA_SQ];
  let sig = sqrt(max(sq, 1e-20));
  let y_break = -0.375 * a;
  let t_break = 2.0 * sig / a;

  let x_val = f32(i) / f32(LUT_SIZE - 1);
  let lambda = x_val / a;

  var exg_s = 0.0;
  var exg_c = 0.0;
  let k_max = i32(lambda + 8.0 * sqrt(max(lambda, 1.0))) + 20;
  var lp_s = -lambda;
  var lp_c = 0.0;
  let log_lambda = log_s(lambda);

  for (var k = 0; k <= k_max; k++) {
    if (k > 0) { kacc(&lp_s, &lp_c, log_lambda - log(f32(k))); }
    let prob = exp_s(lp_s + lp_c);
    if (prob < 1e-15 && k > i32(lambda) + 1) { break; }

    var eg_s = 0.0;
    var eg_c = 0.0;
    for (var g = 0; g < 10; g++) {
      let z = 1.4142135623730951 * sig * GH_NODES[g];
      let noisy_y = f32(k) * a + z;
      var t: f32;
      if (noisy_y >= y_break) {
        let arg = a * noisy_y + 0.375 * a * a + sq;
        t = (2.0 / a) * sqrt(max(arg, 0.0));
      } else {
        t = t_break + (noisy_y - y_break) / sig;
      }
      kacc(&eg_s, &eg_c, GH_WEIGHTS[g] * t);
    }
    // 1 / sqrt(pi), the Gauss-Hermite normalisation.
    let eg = (eg_s + eg_c) * 0.5641895835477563;
    kacc(&exg_s, &exg_c, prob * eg);
  }

  lut_d[i] = exg_s + exg_c;
  lut_x[i] = x_val;

  if (i == 0) {
    lut_params[2] = y_break;
    lut_params[3] = t_break;
    lut_params[4] = sig;
    lut_params[5] = a;
    lut_params[6] = sq;
  }
}
