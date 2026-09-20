// Phase 0(g): the exact unbiased inverse GAT, tabulated, one invocation per entry.
//
// A Poisson sum over photon counts, each term integrated against the read noise by 10-point
// Gauss-Hermite. The table depends on nothing but (α, σ²), so its cost is the same at any
// resolution.
//
// Every running sum is compensated by a `Tally`, which is not decoration: it stands in for the
// f64 WGSL does not have. `log` of zero is undefined in WGSL rather than -inf,
// so λ = 0 goes through a finite sentinel that `exp_s` floors to zero - the same term-by-term
// result, without relying on infinity arithmetic.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> params;
[vk::binding(1, 0)] RWStructuredBuffer<float> lut_d;
[vk::binding(2, 0)] RWStructuredBuffer<float> lut_x;
[vk::binding(3, 0)] RWStructuredBuffer<float> lut_params;

static const float GH_NODES[10] = {
    -3.436159, -2.532732, -1.756684, -1.036611, -0.342901,
    0.342901, 1.036611, 1.756684, 2.532732, 3.436159
};
static const float GH_WEIGHTS[10] = {
    7.640432855232641e-06, 1.343645746781232e-03, 3.387439445548111e-02,
    2.401386110823147e-01, 6.108626337353258e-01,
    6.108626337353258e-01, 2.401386110823147e-01, 3.387439445548111e-02,
    1.343645746781232e-03, 7.640432855232641e-06
};

static const float LOG_ZERO_SENTINEL = -1e30;

float log_s(float x)
{
    if (x <= 0.0) { return LOG_ZERO_SENTINEL; }
    return log(x);
}

float exp_s(float x)
{
    // f32 `exp` underflows below about -87.3, so everything under -87 - the sentinel chain
    // included - is a hard zero rather than a denormal that differs by vendor.
    if (x < -87.0) { return 0.0; }
    return exp(x);
}

/// The most terms the sum below may ever run, whatever it is handed.
///
/// **A loop bound taken from a float is a loop with no bound.** `i32()` of a NaN or of anything
/// past the integer range is undefined in WGSL, so one bad value in the params block is a dispatch
/// that does not retire - and a dispatch that does not retire holds the whole device, because this
/// hardware preempts between dispatches and not inside one. What that looks like is not a wrong
/// picture: it is the compositor blocking on its own submit until the watchdog takes the machine
/// down. The branch below keeps the real count near 1300; this is the ceiling that holds when the
/// branch is handed something it cannot reason about.
static const int TERMS_CEILING = 4096;

/// The Poisson terms a mean of `lambda` needs: up to its peak, plus the window around it.
int terms_for(float lambda)
{
    let wanted = int(lambda + 8.0 * sqrt(max(lambda, 1.0))) + 20;
    return clamp(wanted, 0, TERMS_CEILING);
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
/// closed form is (0.0069 against 0.0146 at lambda 1223). Either side of the switch the table is
/// within 0.007 of the exact curve.
static const float LAMBDA_EXACT_MAX = 1000.0;

[shader("compute")]
[numthreads(256, 1, 1)]
void build_inv_lut(uint3 id : SV_DispatchThreadID)
{
    let i = int(id.x);
    if (i >= LUT_SIZE) { return; }

    // Floored at the read, not merely where the slot is written: everything below scales by
    // `2/alpha`, so a zero in the slot is an infinity in the table. The two GAT forwards read it
    // through the same floor, so the transform this inverts is still the one that ran.
    let a = max(params[P_ALPHA], ALPHA_MIN);
    let sq = params[P_SIGMA_SQ];
    let sig = sqrt(max(sq, 1e-20));
    let y_break = -0.375 * a;
    let t_break = 2.0 * sig / a;

    let x_val = float(i) / float(LUT_SIZE - 1);
    let lambda = x_val / a;

    float value;
    // Spelled against the sum rather than for it, so a `lambda` that is not a number takes the
    // closed form too: every comparison with NaN is false, and `lambda > LAMBDA_EXACT_MAX` would
    // send it into the sum, which is the one branch here that loops.
    if (!(lambda <= LAMBDA_EXACT_MAX)) {
        // The closed form, which is what the exact inverse has converged to by here - and the only
        // one of the two f32 can still evaluate. The same expression `gat_forward_full` applies, so
        // a level round-trips through this table exactly.
        value = (2.0 / a) * sqrt(max(a * x_val + 0.375 * a * a + sq, 0.0));
    } else {
        // Bounded by the branch above and by `TERMS_CEILING`: the sum only runs where
        // lambda is small, so it is at most a few thousand terms whatever alpha is.
        let k_max = terms_for(lambda);
        var exg = tally();
        var mass = tally();
        // Only the factorial accumulates. `k * log(lambda)` is a product, so taking it as one keeps
        // the running term to a sum of `log k` - all positive, all of a size, which is what the
        // levels want - instead of a walk that has to stay exact to be worth anything.
        var log_fact = tally();
        let log_lambda = log_s(lambda);

        for (int k = 0; k <= k_max; k++) {
            if (k > 0) { tally_push(log_fact, log(float(k))); }
            let prob = exp_s(-lambda + float(k) * log_lambda - tally_sum(log_fact));
            if (prob < 1e-15 && k > int(lambda) + 1) { break; }

            // Ten terms of one size: a plain sum is already what a `Tally` would build.
            var eg_sum = 0.0;
            for (int g = 0; g < 10; g++) {
                let z = 1.4142135623730951 * sig * GH_NODES[g];
                let noisy_y = float(k) * a + z;
                float t;
                if (noisy_y >= y_break) {
                    let arg = a * noisy_y + 0.375 * a * a + sq;
                    t = (2.0 / a) * sqrt(max(arg, 0.0));
                } else {
                    t = t_break + (noisy_y - y_break) / sig;
                }
                eg_sum = eg_sum + GH_WEIGHTS[g] * t;
            }
            // 1 / sqrt(pi), the Gauss-Hermite normalisation.
            let eg = eg_sum * 0.5641895835477563;
            tally_push(exg, prob * eg);
            tally_push(mass, prob);
        }

        // Divided by the mass actually gathered, so what the window and the early break leave out
        // cannot land in the answer as a shortfall. It is an expectation, and an expectation taken
        // over part of a distribution has to be renormalised over that part.
        let gathered = tally_sum(mass);
        let weighted = tally_sum(exg);
        value = select(gathered <= 0.0, weighted, weighted / gathered);
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
