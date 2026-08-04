//! Times one slider tick on the CPU, stage by stage, at a given size.
//!
//! The number the GPU port is measured against (`docs/raw-edit-gpu.md` §3 has the figures
//! this reproduces). Synthetic pixels rather than a RAW: the tick reads a prepared frame
//! and does not care where it came from, and a fixture that decodes a 25MB file would time
//! LibRaw as well.
//!
//! cargo run --release --example tick_bench -- [width] [height] [runs]

use rawshim::hdr::{self, Prepared};
use rawshim::hdr_fit::HdrColour;
use rawshim::image::{self, Strengths};
use rawshim::tone;
use std::time::Instant;

fn main() {
    let mut args = std::env::args().skip(1);
    let width: usize = args.next().map_or(2566, |v| v.parse().expect("width"));
    let height: usize = args.next().map_or(3840, |v| v.parse().expect("height"));
    let runs: usize = args.next().map_or(3, |v| v.parse().expect("runs"));

    let grade = hdr::Grade { peak_nits: 1000.0, reference_white_nits: 203.0, white_quantile: 0.995 };
    let strengths = Strengths { luma: 1.0, chroma: 1.0, sharpen: 1.0, defringe: 1.0 };
    let colour = HdrColour::identity();

    let samples = scene(width, height);
    let levels = tone::levels(&samples, grade.white_quantile);
    let prepared = Prepared { samples, width, height, levels };

    println!("{width}x{height}, {:.1}MP, {} threads", (width * height) as f64 / 1e6, rawshim::parallel::thread_count());
    for run in 0..runs {
        let mut working = prepared.samples.clone();

        let at = Instant::now();
        hdr::grade_prepared(&mut working, &grade, Some(&colour), prepared.levels, 2f64.powf(0.5));
        let graded = at.elapsed();

        let at = Instant::now();
        tone::encode_pq(&mut working, grade.peak_nits);
        let pq = at.elapsed();

        let at = Instant::now();
        image::finish(&mut working, width, height, strengths);
        let finished = at.elapsed();

        let ms = |d: std::time::Duration| d.as_secs_f64() * 1e3;
        println!(
            "run {run}: grade {:>7.1}ms  pq {:>6.1}ms  finish {:>8.1}ms  = tick {:>8.1}ms",
            ms(graded),
            ms(pq),
            ms(finished),
            ms(graded + pq + finished),
        );
    }
}

/// The same shape `edit_fixture` uses, at whatever size: a ramp, an edge, a saturated
/// patch and per-pixel jitter, so every stage has something to find.
fn scene(width: usize, height: usize) -> Vec<u16> {
    let mut samples = vec![0u16; width * height * 3];
    for y in 0..height {
        for x in 0..width {
            let at = (y * width + x) * 3;
            let noise = (((x * 7919 + y * 104729) % 211) as f64 / 211.0 - 0.5) * 900.0;
            let ramp = (x as f64 / width as f64) * 42000.0 + 1200.0;
            let edge = match x > width / 2 {
                true => 9000.0,
                false => 0.0,
            };
            let patch = y > height * 3 / 4 && x < width / 4;
            let (r, g, b) = match patch {
                true => (ramp + edge + 12000.0, ramp * 0.35, ramp * 0.2),
                false => (ramp + edge, ramp + edge * 0.9, ramp + edge * 0.8),
            };
            let clamp = |v: f64| v.clamp(0.0, 65535.0) as u16;
            samples[at] = clamp(r + noise);
            samples[at + 1] = clamp(g + noise * 0.8);
            samples[at + 2] = clamp(b + noise * 1.1);
        }
    }
    samples
}
