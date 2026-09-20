//! What GALOSH leaves behind when it is asked to remove nothing.
//!
//! ```text
//! galosh_residual [--side N] [--noise A] [--luma L] [--colour C] [--pool 0|1]
//! ```
//!
//! A denoise at an amount too small to shrink anything should hand back the frame it was given:
//! every stage between the GAT and its inverse is a transform, and a transform's round trip is an
//! identity or it is a pattern on every picture. This runs one over a synthetic frame - four flat
//! CFA levels, noise, one hard edge - and reports what came back minus what went in, per CFA slot
//! and by autocorrelation at the periods the kernels are built on, so a lattice names its own
//! scale rather than being eyeballed off a crop.

use rawshim::galosh::Amounts;

fn main() {
    let mut side = 1792usize;
    let mut noise = 0.05f32;
    let mut luma = 0.0f64;
    let mut colour = 0.01f64;
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args.next().expect("a value");
        match flag.as_str() {
            "--side" => side = value.parse().expect("a number"),
            "--noise" => noise = value.parse().expect("a number"),
            "--luma" => luma = value.parse().expect("a number"),
            "--colour" => colour = value.parse().expect("a number"),
            "--pool" => rawshim::galosh::force_phase_pool(value != "0"),
            other => panic!("unknown flag {other}"),
        }
    }

    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    let kernels = rawshim::galosh::device(gpu).expect("the GALOSH kernels");
    let before = frame(side, side, noise);
    let mosaic = rawshim::condition::Mosaic::upload(gpu, &before, side, side);
    // The pattern `frame` lays down: red, green, green, blue by 2x2 parity.
    let cfa = rawshim::cfa::Cfa::bayer([0, 1, 1, 2]).expect("a bayer pattern");
    let fit = pollster::block_on(rawshim::galosh::fit(gpu, kernels, &mosaic, &cfa));
    let amounts = Amounts::from_sliders(luma, colour);
    eprintln!("sliders luma {luma} colour {colour} -> amounts {amounts:?}; fit {:?}", fit.model());
    pollster::block_on(rawshim::galosh::denoise_with(
        gpu, kernels, &mosaic, &cfa, amounts, fit,
    ));
    let after = pollster::block_on(mosaic.read(gpu)).expect("the mosaic reads back");

    let residual: Vec<f32> = after.iter().zip(&before).map(|(a, b)| a - b).collect();
    let n = residual.len() as f64;
    let mean = residual.iter().map(|v| f64::from(*v)).sum::<f64>() / n;
    let rms = (residual.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / n).sqrt();
    let peak = residual.iter().fold(0f32, |m, v| m.max(v.abs()));
    eprintln!("residual over {side}x{side}: mean {mean:+.3e} rms {rms:.3e} peak {peak:.3e} (frame is 0..1, noise {noise})");

    // A 2x2 pattern shows as four slot means that disagree.
    let mut slot_sum = [0f64; 4];
    let mut slot_n = [0usize; 4];
    for (at, v) in residual.iter().enumerate() {
        let (x, y) = (at % side, at / side);
        let slot = (y & 1) | ((x & 1) << 1);
        slot_sum[slot] += f64::from(*v);
        slot_n[slot] += 1;
    }
    eprintln!(
        "per CFA slot mean: {:+.3e} {:+.3e} {:+.3e} {:+.3e}",
        slot_sum[0] / slot_n[0] as f64,
        slot_sum[1] / slot_n[1] as f64,
        slot_sum[2] / slot_n[2] as f64,
        slot_sum[3] / slot_n[3] as f64,
    );

    // The residual split into what each 2x2 site's mean carries and what varies inside a site:
    // the chroma path works per site, so a residual that is all within-site is chroma's.
    let centred: Vec<f64> = residual.iter().map(|v| f64::from(*v) - mean).collect();
    let mut site_energy = 0f64;
    let mut within_energy = 0f64;
    for sy in 0..side / 2 {
        for sx in 0..side / 2 {
            let at = |dx: usize, dy: usize| centred[(sy * 2 + dy) * side + sx * 2 + dx];
            let four = [at(0, 0), at(1, 0), at(0, 1), at(1, 1)];
            let site = four.iter().sum::<f64>() / 4.0;
            site_energy += 4.0 * site * site;
            within_energy += four.iter().map(|v| (v - site).powi(2)).sum::<f64>();
        }
    }
    let total = site_energy + within_energy;
    eprintln!(
        "residual energy (mean removed): {:.1}% in 2x2 site means, {:.1}% within sites",
        100.0 * site_energy / total,
        100.0 * within_energy / total,
    );

    // Normalised autocorrelation along x and y, mean removed, at the periods the kernels tile
    // on. A lattice at period p answers near 1 at lag p and near 0 in between; white noise
    // answers near 0 everywhere; a smoothing answers positive at 1 and decays.
    let var = centred.iter().map(|v| v * v).sum::<f64>() / n;
    eprintln!("autocorrelation of the centred residual (x / y) at lag:");
    for lag in [1usize, 2, 3, 4, 8, 14, 28, 56, 112] {
        let mut sx = 0f64;
        let mut sy = 0f64;
        let mut count = 0usize;
        for y in 0..side - lag {
            for x in 0..side - lag {
                let here = centred[y * side + x];
                sx += here * centred[y * side + x + lag];
                sy += here * centred[(y + lag) * side + x];
                count += 1;
            }
        }
        let norm = |s: f64| if var > 0.0 { s / count as f64 / var } else { 0.0 };
        eprintln!("  {lag:>3}: {:+.3} / {:+.3}", norm(sx), norm(sy));
    }

    // Where the residual lives, which is the halo question: within a few photosites of the edge at
    // side/2, or everywhere.
    let mut near = (0f64, 0usize);
    let mut far = (0f64, 0usize);
    for (at, v) in residual.iter().enumerate() {
        let x = at % side;
        let bucket = if x.abs_diff(side / 2) <= 8 { &mut near } else { &mut far };
        bucket.0 += f64::from(*v).powi(2);
        bucket.1 += 1;
    }
    eprintln!(
        "rms within 8px of the edge {:.3e}, elsewhere {:.3e}",
        (near.0 / near.1 as f64).sqrt(),
        (far.0 / far.1 as f64).sqrt(),
    );
}

/// The frame `galosh.rs`'s own tests denoise: four flat CFA levels, noise, one vertical edge.
fn frame(width: usize, height: usize, amplitude: f32) -> Vec<f32> {
    let level = |slot: usize| [0.20, 0.34, 0.34, 0.12][slot];
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut noise = || {
        let mut sum = 0.0;
        for _ in 0..2 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            sum += (seed >> 40) as f32 / 16777216.0 - 0.5;
        }
        sum * amplitude
    };
    (0..width * height)
        .map(|at| {
            let (x, y) = (at % width, at / width);
            let slot = (y & 1) | ((x & 1) << 1);
            let bright = if x > width / 2 { 0.45 } else { 0.0 };
            (level(slot) + bright + noise()).clamp(0.0, 1.0)
        })
        .collect()
}
