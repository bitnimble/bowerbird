//! The `K16_W` table in `k16.slang`, regenerated - and first reproduced, which is the
//! only thing that makes the regeneration trustworthy.
//!
//! ```text
//! jinc_table            # the committed co-sited phases, to diff against the shader
//! jinc_table --centred  # the same kernel at the phases a box average actually asks for
//! ```
//!
//! **Why a second set of phases exists.** `box_downsample_2x` averages the four full-resolution
//! pixels of a 2x2, whose centroid is at full-resolution coordinate `2k + 1` when pixel `i` is
//! centred at `i + 0.5` - which is exactly where low-resolution sample `k` sits, `k + 0.5` mapping
//! to `2(k + 0.5)`. So output pixel `j` lies at low-resolution coordinate `(j + 0.5) / 2`, i.e. a
//! quarter of a sample either side of the source: the phases are -0.25 and +0.25, not 0.0 and
//! +0.5. The committed table is co-sited, which puts every upsampled chroma sample half a
//! full-resolution pixel toward +x and +y, per level.
//!
//! Held to the property that settles it: a linear ramp resampled through a normalised kernel is
//! the same ramp, and any siting error shows up as a constant displacement.

/// Bessel J1, to about 1e-7 - Abramowitz & Stegun 9.4.4 and 9.4.6.
fn bessel_j1(x: f64) -> f64 {
    let ax = x.abs();
    if ax < 8.0 {
        let y = x * x;
        let num = x
            * (72362614232.0
                + y * (-7895059235.0
                    + y * (242396853.1 + y * (-2972611.439 + y * (15704.48260 + y * -30.16036606)))));
        let den = 144725228442.0
            + y * (2300535178.0 + y * (18583304.74 + y * (99447.43394 + y * (376.9991397 + y))));
        num / den
    } else {
        let z = 8.0 / ax;
        let y = z * z;
        let xx = ax - 2.356194491;
        let p = 1.0 + y * (0.183105e-2 + y * (-0.3516396496e-4 + y * (0.2457520174e-5 + y * -0.240337019e-6)));
        let q = 0.04687499995
            + y * (-0.2002690873e-3 + y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)));
        let ans = (0.636619772 / ax).sqrt() * (xx.cos() * p - z * xx.sin() * q);
        if x < 0.0 { -ans } else { ans }
    }
}

/// `jinc(x) = 2 J1(pi x) / (pi x)`, and 1 at the origin.
fn jinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        return 1.0;
    }
    let a = std::f64::consts::PI * x;
    2.0 * bessel_j1(a) / a
}

/// One phase's 5x5 weights, in the shader's own row-major order.
fn tap_weights(oy: f64, ox: f64) -> Vec<f64> {
    let mut out = Vec::with_capacity(25);
    for dy in -2..=2 {
        for dx in -2..=2 {
            let (ry, rx) = (f64::from(dy) - oy, f64::from(dx) - ox);
            let r = 2.0 * (ry * ry + rx * rx).sqrt();
            out.push(if r < 3.0 { jinc(r) * jinc(r / 3.0) } else { 0.0 });
        }
    }
    out
}

/// What the resampled ramp is displaced by, in full-resolution pixels.
///
/// A linear field is the case a siting error cannot hide in: the kernel is normalised, so the
/// reconstruction is exact up to a shift, and the shift is the whole answer.
fn ramp_shift(phases: &[(f64, f64); 4]) -> f64 {
    let mut worst: f64 = 0.0;
    for (si, (oy, ox)) in phases.iter().enumerate() {
        let w = tap_weights(*oy, *ox);
        let sum: f64 = w.iter().sum();
        // The source sample at low-res index `k` holds the ramp's value at full-res `2k + 1`.
        // Its taps sit at `2(k + dx) + 1`, and the output pixel this phase serves is at
        // `2k + (si & 1) + 0.5`.
        let mut got = 0.0;
        for dy in -2..=2 {
            for dx in -2..=2 {
                let at = ((dy + 2) * 5 + (dx + 2)) as usize;
                got += w[at] * (2.0 * f64::from(dx) + 1.0);
            }
        }
        let want = (si & 1) as f64 + 0.5;
        println!(
            "//   si {si}: sum {sum:.6}, centroid {:.6}, want {want:.6}, off {:.6}",
            got / sum,
            got / sum - want,
        );
        worst = worst.max((got / sum - want).abs());
    }
    worst
}

fn main() {
    let centred = std::env::args().any(|a| a == "--centred");
    let phases: [(f64, f64); 4] = match centred {
        true => [(-0.25, -0.25), (-0.25, 0.25), (0.25, -0.25), (0.25, 0.25)],
        false => [(0.0, 0.0), (0.0, 0.5), (0.5, 0.0), (0.5, 0.5)],
    };

    println!("// {} phases", if centred { "centre-aligned" } else { "co-sited" });
    for (si, (oy, ox)) in phases.iter().enumerate() {
        println!("  // si = {si} (oy {oy:.2}, ox {ox:.2})");
        let w = tap_weights(*oy, *ox);
        for row in w.chunks(5) {
            let cells: Vec<String> = row
                .iter()
                .map(|v| if *v == 0.0 { "0.0".to_string() } else { format!("{v:.10e}") })
                .collect();
            println!("  {},", cells.join(", "));
        }
    }
    println!("// worst ramp displacement: {:.6} full-resolution pixels", ramp_shift(&phases));
}
