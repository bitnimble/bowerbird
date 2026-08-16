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

// The Poisson terms a mean of `lambda` needs: up to its peak, plus the window around it.
fn terms_for(lambda: f32) -> i32 {
  return i32(lambda + 8.0 * sqrt(max(lambda, 1.0))) + 20;
}

/// The photon count above which this table is the forward transform, and the sum is not run.
///
/// **The unbiased correction is a photon-starved effect, and the sum is only computable there.**
/// `E[t|x]` departs from `t(x)` because a Poisson mean of a handful of photons is skewed; as the
/// count grows the two converge, and measured against an f64 evaluation the gap falls from
/// -0.0123 at zero to -0.0018 by lambda 19569, and to a part in a million by lambda 124420.
///
/// The same growth is what makes the sum impossible in f32. Its weights come from
/// `log(k!)`, which at k = 19569 is about 174000 - an f32 ulp of 0.015 there, so every
/// probability is wrong by a percent and a half however the logs are accumulated. Measured, the
/// f32 sum drifts from the exact curve by 1.86 at lambda 19569 and returns *zero* past lambda
/// 125000, which is a table whose top half reads as black and whose ends bracket nothing.
///
/// So the crossover is not a tuning knob but the point where the two errors meet: below it the
/// sum is the more accurate of the two (0.0019 against 0.0124 at lambda 306), above it the
/// closed form is (0.0069 against 0.0146 at lambda 1223). Either side of the switch this table
/// is within 0.007 of the exact curve, where it used to be out by a thousand.
const LAMBDA_EXACT_MAX: f32 = 1000.0;

@compute @workgroup_size(256)
fn build_inv_lut(@builtin(global_invocation_id) id: vec3u) {
  let i = i32(id.x);
  if (i >= LUT_SIZE) { return; }

  // Floored at the read, not merely where the slot is written: everything below scales by
  // `2/alpha`, so a zero in the slot is an infinity in the table. The two GAT forwards read it
  // through the same floor, so the transform this inverts is still the one that ran.
  let a = max(params[P_ALPHA], ALPHA_MIN);
  let sq = params[P_SIGMA_SQ];
  let sig = sqrt(max(sq, 1e-20));
  let y_break = -0.375 * a;
  let t_break = 2.0 * sig / a;

  let x_val = f32(i) / f32(LUT_SIZE - 1);
  let lambda = x_val / a;

  var value: f32;
  if (lambda > LAMBDA_EXACT_MAX) {
    // The closed form, which is what the exact inverse has converged to by here - and the only
    // one of the two f32 can still evaluate. The same expression `gat_forward_full` and
    // `yuv_gat_fwd` apply, so a level round-trips through this table exactly.
    value = (2.0 / a) * sqrt(max(a * x_val + 0.375 * a * a + sq, 0.0));
  } else {
    // Bounded by the branch above rather than by a cap of its own: the sum only runs where
    // lambda is small, so it is at most a few thousand terms whatever alpha is. That is also
    // what retired the old ceiling, which had to guess a bound and truncated real tables when
    // it guessed low.
    let k_max = terms_for(lambda);
    var exg_s = 0.0;
    var exg_c = 0.0;
    var mass_s = 0.0;
    var mass_c = 0.0;
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
      kacc(&mass_s, &mass_c, prob);
    }

    // Divided by the mass actually gathered, so what the window and the early break leave out
    // cannot land in the answer as a shortfall. It is an expectation, and an expectation taken
    // over part of a distribution has to be renormalised over that part.
    let mass = mass_s + mass_c;
    value = select((exg_s + exg_c) / mass, exg_s + exg_c, mass <= 0.0);
  }

  lut_d[i] = value;
  lut_x[i] = x_val;

  if (i == 0) {
    lut_params[2] = y_break;
    lut_params[3] = t_break;
    lut_params[4] = sig;
    lut_params[5] = a;
    lut_params[6] = sq;
  }
}
