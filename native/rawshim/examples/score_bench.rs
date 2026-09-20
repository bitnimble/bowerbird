//! What one scoring call costs, split into the part that scales and the part that does not.
//!
//! ```text
//! score_bench
//! ```
//!
//! **The colour fit asks this about thirty times a photograph, and most of what it pays is not
//! arithmetic.** `fit_score` evaluates a CIEDE2000 per pair per probe, which a device does in
//! microseconds; measured through the fit, a call came back in about 2.5ms whatever it was asked.
//! A saturation search that cannot batch its probes - a golden section places each one where the
//! last one's answer says - therefore pays that nine times over for a millisecond of work.
//!
//! So this asks the two questions that separate the two costs: what does a call cost as the probe
//! count grows, and what does it cost as the pair count grows. A fixed cost shows as a non-zero
//! intercept on both.
//!
//! Synthetic pairs, because none of the shader's cost is data-dependent past the one branch
//! `delta_e2000` takes for a neutral - and the sweep below covers a realistic mix of those.
//!
//! **Exits 139 on the NVIDIA driver, after printing every number correctly.** The fault is in
//! wgpu's device teardown at static destruction, past the end of `main` - scoping the `Scoring`s so
//! they release while the device is up does not move it, and `fit_bench` and `bench_stages` share
//! every one of these calls and exit cleanly. Read the numbers; the exit code is not about them.

use rawshim::fit_score::{Probe, Scoring, Shape};

/// Calls per measurement. The first is discarded: it builds the pipeline.
const REPEATS: usize = 40;

/// `hdr_fit::SCORE_BLOCK`.
const BLOCK: usize = 256;

fn main() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("score_bench: no adapter");
        std::process::exit(2);
    };
    println!("{}", gpu.adapter);

    println!("\n  probes, over 150k pairs (median of {REPEATS}, milliseconds)");
    let held = scoring(gpu, 150_000);
    for probes in [1, 2, 4, 8, 16, 32] {
        let taken = timed(&held, probes);
        println!("    {probes:>3} probes   {taken:>7.3}   {:>7.3} each", taken / probes as f64);
    }

    println!("\n  pairs, one probe (median of {REPEATS}, milliseconds)");
    for pairs in [1_000, 10_000, 50_000, 150_000, 400_000] {
        let held = scoring(gpu, pairs);
        println!("    {pairs:>7} pairs   {:>7.3}", timed(&held, 1));
    }
}

fn scoring(gpu: &'static rawshim::gpu::Gpu, pairs: usize) -> Scoring {
    // A spread rather than a constant: the neutral arm of `delta_e2000` is a different path, and a
    // frame is a mix of the two.
    let mut state = 0x2545_f491_4f6c_dd1du64;
    let mut noise = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 40) as f64 / 16_777_216.0
    };
    let below: Vec<([f64; 3], f64)> = (0..pairs)
        .map(|k| {
            let m = match k % 8 {
                0 => [0.4, 0.4, 0.4],
                _ => [noise(), noise(), noise()],
            };
            (m, 0.2627 * m[0] + 0.678 * m[1] + 0.0593 * m[2])
        })
        .collect();
    let target: Vec<[f64; 3]> = (0..pairs)
        .map(|k| [0.2 + (k % 40) as f64 / 80.0, 0.1 + (k % 30) as f64 / 40.0, 0.3])
        .collect();
    let balance: Vec<f64> = (0..pairs).map(|k| 1.0 + (k % 5) as f64 * 0.25).collect();
    Scoring::new(
        gpu,
        rawshim::fit_score::below_buffer(gpu, &below),
        &target,
        &balance,
        &rawshim::hdr_fit::rec2020_to_srgb(),
        BLOCK,
    )
}

fn timed(scoring: &Scoring, probes: usize) -> f64 {
    let asked: Vec<Probe> = (0..probes)
        .map(|k| Probe { matrix: [[0.0; 3]; 3], saturation: 0.6 + k as f64 * 0.01 })
        .collect();
    let mut taken: Vec<f64> = Vec::with_capacity(REPEATS);
    for round in 0..=REPEATS {
        let began = std::time::Instant::now();
        let answered = pollster::block_on(scoring.partials(&Shape::Saturation, &asked));
        let ms = began.elapsed().as_secs_f64() * 1000.0;
        assert!(answered.is_some(), "the device declined a scoring call");
        if round > 0 {
            taken.push(ms);
        }
    }
    taken.sort_by(f64::total_cmp);
    taken[taken.len() / 2]
}
