//! A ridge-shaped edge through the whole denoise, watched at the mosaic.
//!
//! ```text
//! edge_probe <out-dir> [luminance] [colour]
//! ```
//!
//! Writes the noisy input, the denoised output, and the residual against the clean scene
//! (amplified) as PGMs, plus a per-slot residual so a CFA-slot imbalance shows as such.

use rawshim::condition::Mosaic;
use rawshim::galosh::{Amounts, denoise};

const WIDTH: usize = 1024;
const HEIGHT: usize = 768;

/// Blue-ish sky over a near-black neutral hill, at the dark levels a sunset actually decodes
/// to, with the low noise of a long exposure. RGGB slot order: R, Gb, Gr, B by (row, col) parity.
fn scene_at(x: usize, y: usize, slot: usize) -> f32 {
    let ridge = HEIGHT as f32 * 0.45 + 40.0 * (x as f32 / 97.0).sin();
    if (y as f32) < ridge {
        [0.08, 0.11, 0.11, 0.16][slot]
    } else {
        0.002
    }
}

fn frames() -> (Vec<f32>, Vec<f32>) {
    let mut seed = 0x853c_49e6_748f_ea9bu64;
    let mut uniform = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 40) as f32 / 16777216.0
    };
    let mut clean = Vec::with_capacity(WIDTH * HEIGHT);
    let mut noisy = Vec::with_capacity(WIDTH * HEIGHT);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let slot = ((y & 1) << 1) | (x & 1);
            let level = scene_at(x, y, slot).clamp(0.0, 1.0);
            let sigma = 0.0005 + 0.01 * level.sqrt();
            let noise = (uniform() + uniform() + uniform() - 1.5) * sigma;
            clean.push(level);
            noisy.push((level + noise).clamp(0.0, 1.0));
        }
    }
    (clean, noisy)
}

fn pgm(path: &str, values: &[f32], width: usize, height: usize) {
    let mut bytes = format!("P5\n{width} {height}\n255\n").into_bytes();
    bytes.extend(values.iter().map(|v| (v.clamp(0.0, 1.0) * 255.0) as u8));
    std::fs::write(path, bytes).expect("wrote");
    eprintln!("wrote {path}");
}

/// The residual against the clean scene, amplified and centred on 0.5.
fn residual(out: &[f32], clean: &[f32]) -> Vec<f32> {
    out.iter().zip(clean).map(|(o, c)| 0.5 + (o - c) * 20.0).collect()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let out = args.next().expect("an output directory");
    let luminance: f64 = args.next().map_or(40.0, |v| v.parse().expect("a number"));
    let colour: f64 = args.next().map_or(40.0, |v| v.parse().expect("a number"));
    std::fs::create_dir_all(&out).expect("the output directory");

    let (clean, noisy) = frames();
    let gpu = rawshim::gpu::device().expect("an adapter");
    let galosh = rawshim::galosh::device(gpu).expect("the kernels built");
    let uploaded = Mosaic::upload(gpu, &noisy, WIDTH, HEIGHT);
    let fit = pollster::block_on(denoise(
        gpu,
        galosh,
        &uploaded,
        &rawshim::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB is a pattern"),
        Amounts::from_sliders(luminance, colour),
    ));
    eprintln!("fit: {fit:?}");
    let ours = pollster::block_on(uploaded.read(gpu)).expect("the mosaic reads back");

    let psnr = |a: &[f32], b: &[f32]| {
        let mse = a.iter().zip(b).map(|(x, y)| f64::from(x - y).powi(2)).sum::<f64>()
            / a.len() as f64;
        10.0 * (1.0 / mse).log10()
    };
    eprintln!(
        "psnr vs clean: noisy {:.2} dB, denoised {:.2} dB",
        psnr(&noisy, &clean),
        psnr(&ours, &clean),
    );

    pgm(&format!("{out}/noisy.pgm"), &noisy, WIDTH, HEIGHT);
    pgm(&format!("{out}/denoised.pgm"), &ours, WIDTH, HEIGHT);
    pgm(&format!("{out}/residual.pgm"), &residual(&ours, &clean), WIDTH, HEIGHT);

    // What the filter changed against its own input, by row and slot, worst rows first.
    let mut rows: Vec<(usize, [f32; 4])> = Vec::new();
    for row in 0..HEIGHT {
        let mut sum = [0.0f64; 4];
        let mut count = [0usize; 4];
        for col in 0..WIDTH {
            let at = row * WIDTH + col;
            let slot = ((row & 1) << 1) | (col & 1);
            sum[slot] += f64::from(ours[at] - noisy[at]);
            count[slot] += 1;
        }
        let mut means = [0.0f32; 4];
        for slot in 0..4 {
            means[slot] = (sum[slot] / count[slot].max(1) as f64) as f32;
        }
        rows.push((row, means));
    }
    let peak = |m: &[f32; 4]| m.iter().fold(0.0f32, |acc, v| acc.max(v.abs()));
    rows.sort_by(|a, b| peak(&b.1).total_cmp(&peak(&a.1)));
    eprintln!("worst rows by mean change (row: slot0 slot1 slot2 slot3):");
    for (row, means) in rows.iter().take(10) {
        eprintln!(
            "  {row:4}: {:+.5} {:+.5} {:+.5} {:+.5}",
            means[0], means[1], means[2], means[3]
        );
    }

    // Each CFA slot on its own half-res grid, so a slot-correlated error reads as one.
    for slot in 0..4 {
        let (sy, sx) = ((slot >> 1) & 1, slot & 1);
        let (hw, hh) = (WIDTH / 2, HEIGHT / 2);
        let mut plane = Vec::with_capacity(hw * hh);
        for y in 0..hh {
            for x in 0..hw {
                let at = (y * 2 + sy) * WIDTH + x * 2 + sx;
                plane.push(0.5 + (ours[at] - clean[at]) * 20.0);
            }
        }
        pgm(&format!("{out}/residual-slot{slot}.pgm"), &plane, hw, hh);
    }
}
