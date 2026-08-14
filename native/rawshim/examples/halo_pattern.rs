//! A mosaic built to make the seam as bad as it can be, rather than hunted for in a photograph.
//!
//! ```text
//! halo_pattern <out-dir> [side] [halo,halo,...] [luma,colour]
//! ```
//!
//! Searching real frames for a worst case is only as good as the search: six kinds of subject put
//! the seam between 3 and 127 of 255, and nothing says the 127 was the worst there is. A pattern
//! can be aimed instead, at what the halo is there for.
//!
//! **What it aims at.** The halo exists for the chroma pyramid - the levels go to a quarter of the
//! frame and come back up through a joint upsample *guided by luma*. So the case that hurts is
//! chroma the guide cannot predict: structure in R-G and B-G with the luma held flat, which leaves
//! the upsample nothing to steer by and the pyramid carrying all of it. A zone plate does that at
//! every spatial frequency and every orientation at once, so whichever frequency the pyramid is
//! weakest at is somewhere in the field rather than a lucky guess.
//!
//! Three bands, because the pyramid is not the only thing with a reach:
//!
//! - a chroma zone plate on flat luma, which is the pyramid's own worst case
//! - a luma zone plate at flat chroma, for the shrinkage rather than the pyramid
//! - blown speculars against near-black, which is what the real frames' seams turned out to be
//!
//! The noise is Poisson-Gaussian and real, since a denoise calibrated to noise that is not there
//! is not the thing being measured, and the amounts default to the top of the track.

use rawshim::galosh::Amounts;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(out) = args.next() else {
        eprintln!("halo_pattern <out-dir> [side] [halo,halo,...] [luma,colour]");
        std::process::exit(2);
    };
    let side = args.next().and_then(|s| s.parse().ok()).unwrap_or(1024usize);
    let halos: Vec<usize> = args
        .next()
        .map(|s| s.split(',').filter_map(|v| v.parse().ok()).collect())
        .unwrap_or_else(|| vec![0, 8, 16, 24, 32, 64, 128]);
    let sliders: (f64, f64) = args
        .next()
        .and_then(|s| {
            let p: Vec<f64> = s.split(',').filter_map(|v| v.parse().ok()).collect();
            match p[..] {
                [l, c] => Some((l, c)),
                _ => None,
            }
        })
        .unwrap_or((100.0, 100.0));
    // How far the structure swings, and how much noise sits under it. Together rather than
    // separately: the ratio is what decides whether the denoise has anything to be unsure about.
    let swing: f32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(0.05);
    let noise: f32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(0.004);
    std::fs::create_dir_all(&out).expect("the output directory");

    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("no GPU");
        std::process::exit(1);
    };
    let Some(kernels) = rawshim::galosh::device(gpu) else {
        eprintln!("no GALOSH");
        std::process::exit(1);
    };
    let Some(rcd) = rawshim::demosaic::device(gpu) else {
        eprintln!("no RCD");
        std::process::exit(1);
    };

    let cfa = [0u32, 1, 1, 2];
    let mosaic = pattern(side, side, cfa, swing, noise);
    let amounts = Amounts::from_sliders(sliders.0, sliders.1);
    // Fitted off the pattern rather than stated, so the shrinkage is calibrated to the noise that
    // is actually in it - which is what makes the artefact the halo's rather than a mismatch's.
    let fit = rawshim::galosh::fit(gpu, kernels, &mosaic, side, side);
    eprintln!("pattern {side}x{side}, fitted alpha {:.3e} sigma_sq {:.3e}", fit.alpha, fit.sigma_sq);

    let mut reference = mosaic.clone();
    rawshim::galosh::denoise_with(gpu, kernels, &mut reference, side, side, amounts, fit);
    let shown = render(gpu, rcd, &reference, side, cfa);
    write(&format!("{out}/pattern-reference"), &shown, side, side);
    write(&format!("{out}/pattern-noisy"), &render(gpu, rcd, &mosaic, side, cfa), side, side);

    // **A square on where the two seams cross, and the difference strip is cut the same.** A
    // column carries the vertical seam and only one row of the horizontal one, so a strip made of
    // columns shows whichever seam happens to run down it and hides the other - and comparing a
    // narrow picture against a whole-frame difference is comparing two zoom levels.
    const WINDOW: usize = 256;
    let mut strip = vec![centred(&shown, side, WINDOW)];
    // The reference against itself, which is black, so the two strips have the same panels in the
    // same places and can be read one above the other.
    let mut diffs = vec![vec![0u8; WINDOW * WINDOW * 3]];

    let half = side / 2;
    println!("{:>6}  {:>9} {:>9} {:>9}", "halo", "V excess", "H excess", "baseline");
    for halo in &halos {
        let mut assembled = mosaic.clone();
        for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            let (x0, y0) = (dx * half, dy * half);
            // Grown by the halo, aligned to whole CFA sites, clamped at the frame - the same
            // arithmetic `decode_rawler::decode_tile` does, since that is what would run.
            let left = x0.saturating_sub(*halo) & !1;
            let top = y0.saturating_sub(*halo) & !1;
            let right = (x0 + half + halo).min(side);
            let bottom = (y0 + half + halo).min(side);
            let (right, bottom) = (right - ((right - left) & 1), bottom - ((bottom - top) & 1));
            let (rw, rh) = (right - left, bottom - top);

            let mut window = vec![0f32; rw * rh];
            for row in 0..rh {
                let from = (top + row) * side + left;
                window[row * rw..(row + 1) * rw].copy_from_slice(&mosaic[from..from + rw]);
            }
            rawshim::galosh::denoise_with(gpu, kernels, &mut window, rw, rh, amounts, fit);
            for row in y0..y0 + half {
                let to = row * side + x0;
                let from = (row - top) * rw + (x0 - left);
                assembled[to..to + half].copy_from_slice(&window[from..from + half]);
            }
        }

        let (v_join, v_base) = seam_line(&assembled, &reference, side, half, true);
        let (h_join, h_base) = seam_line(&assembled, &reference, side, half, false);
        println!(
            "{halo:>6}  {:>9.4} {:>9.4} {:>9.4}",
            v_join - v_base,
            h_join - h_base,
            (v_base + h_base) / 2.0,
        );
        let shown = render(gpu, rcd, &assembled, side, cfa);
        write(&format!("{out}/pattern-halo{halo}"), &shown, side, side);
        strip.push(centred(&shown, side, WINDOW));
        // Amplified hard, because the whole point of the pattern is that the seam is a fraction of
        // a count: at 64x a difference of 0.004 is mid grey, and at that gain the noise floor is
        // visible too, which is what stops the picture reading as worse than it is.
        let diff: Vec<f32> = assembled
            .iter()
            .zip(&reference)
            .map(|(a, b)| ((a - b).abs() * 64.0).min(1.0))
            .collect();
        let shown_diff = render(gpu, rcd, &diff, side, cfa);
        write(&format!("{out}/diff-halo{halo}"), &shown_diff, side, side);
        diffs.push(centred(&shown_diff, side, WINDOW));
    }
    let wide = |n: usize| n * (WINDOW + 4) - 4;
    write(
        &format!("{out}/pattern-side-by-side"),
        &alongside(&strip, WINDOW, WINDOW),
        wide(strip.len()),
        WINDOW,
    );
    // The same squares, so the picture and the difference are read at one zoom and one crop.
    write(
        &format!("{out}/diff-side-by-side"),
        &alongside(&diffs, WINDOW, WINDOW),
        wide(diffs.len()),
        WINDOW,
    );
    eprintln!("\nwrote the pattern and {} halos to {out}", halos.len());
    eprintln!(
        "pattern-side-by-side is the reference then {halos:?}; diff-side-by-side is {halos:?}",
    );
    eprintln!("both {WINDOW}px squares at 100%, on where the two seams cross");
}

/// The mosaic, one photosite at a time, in the domain `condition` leaves a real decode in.
///
/// Every band sits at the same mid level so the noise is the same everywhere and a band cannot be
/// easier merely by being darker.
fn pattern(width: usize, height: usize, cfa: [u32; 4], swing: f32, noise: f32) -> Vec<f32> {
    const BASE: f32 = 0.22;
    const BANDS: usize = 4;
    let mut rng = Rng(0x9E3779B97F4A7C15);
    let mut out = vec![0f32; width * height];

    for row in 0..height {
        for col in 0..width {
            // **Nothing in the pattern may line up with where the tiles meet.** Both seams fall at
            // the middle, so a band boundary there is a discontinuity of this file's own making
            // being read as the denoise's, and the zone plate's centre there is the one place it
            // is lowest frequency and so easiest. Measured with them aligned, the horizontal seam
            // came out 4.5x the vertical one and neither number was about the halo. The bands are
            // rolled half a band down and the plate is off-centre, so the seams cross ordinary
            // content in both directions.
            let tall = height / BANDS;
            let rolled = (row + tall / 2) % height;
            let band = (rolled / tall).min(BANDS - 1);
            let x = col as f32;
            let (cx, cy) = (width as f32 * 0.37, tall as f32 * 0.61);
            // A chirp in radius, so one ring of it sits at every frequency the pyramid has a level
            // for, and at every orientation.
            let local = (rolled % tall) as f32;
            let r2 = (x - cx) * (x - cx) + (local - cy) * (local - cy);
            let sweep = (r2 * 0.00035).cos();

            let (r, g, b) = match band {
                // Chroma the luma guide cannot predict: R and B in antiphase, green flat.
                0 => (BASE + swing * sweep, BASE, BASE - swing * sweep),
                // Luma at flat chroma, for the shrinkage rather than the pyramid.
                1 => {
                    let v = BASE + swing * sweep;
                    (v, v, v)
                }
                // **The pyramid's own scale, at random.** The chirp crosses the
                // quarter-resolution frequencies in one thin ring; this sits on them everywhere,
                // and being random there is nothing in a neighbouring tile that predicts it.
                // Flat luma again, so the guided upsample has nothing to steer by.
                2 => {
                    let (bx, by) = ((x / 12.0) as u64, (local / 12.0) as u64);
                    let mut cell = Rng(bx.wrapping_mul(0x2545F4914F6CDD1D).wrapping_add(by));
                    let c = swing * 2.0 * (cell.next() - 0.5);
                    (BASE + c, BASE, BASE - c)
                }
                // What the real frames' seams turned out to be: blown highlights against near
                // black, where the local contrast is as large as the format allows.
                _ => {
                    let v = match ((x * 0.11).sin() * (local * 0.13).sin()) > 0.72 {
                        true => 1.0,
                        false => 0.02,
                    };
                    (v, v, v)
                }
            };

            let value = match cfa[(row & 1) * 2 + (col & 1)] {
                0 => r,
                2 => b,
                _ => g,
            };
            // Poisson-Gaussian, which is the model Phase 0 fits: shot noise growing with the
            // signal, read noise flat under it. Tunable together with the swing, because what
            // decides whether the denoise has to guess is the structure *against* the noise -
            // well above it there is nothing to get wrong, and a seam is a disagreement about a
            // guess.
            let sigma = (noise * value + noise * 0.02).max(0.0).sqrt();
            out[row * width + col] = (value + sigma * rng.normal()).clamp(0.0, 1.0);
        }
    }
    out
}

/// SplitMix64, so the pattern is the same every run and a difference is never the generator's.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        ((z ^ (z >> 31)) >> 40) as f32 / (1 << 24) as f32
    }

    /// Box-Muller, with the log's argument held off zero.
    fn normal(&mut self) -> f32 {
        let u = self.next().max(1e-7);
        let v = self.next();
        (-2.0 * u.ln()).sqrt() * (std::f32::consts::TAU * v).cos()
    }
}

/// The join against its own neighbourhood, in the mosaic rather than after a demosaic.
///
/// The same statistic `halo_seams` reports and one stage earlier, so nothing downstream of the
/// denoise can add to it or hide it. Rows and columns move in pairs because a CFA row holds two
/// colours and a single one is not a sample of the frame.
fn seam_line(mine: &[f32], reference: &[f32], side: usize, half: usize, vertical: bool) -> (f64, f64) {
    let profile = |at: usize| -> f64 {
        let mut total = 0f64;
        for other in 0..side {
            let (row, col) = match vertical {
                true => (other, at),
                false => (at, other),
            };
            let i = row * side + col;
            total += f64::from((mine[i] - reference[i]).abs());
        }
        total / side as f64
    };
    let join = (profile(half - 2) + profile(half - 1) + profile(half) + profile(half + 1)) / 4.0;
    let baseline: f64 =
        (24..48).map(|d| profile(half - d) + profile(half + d)).sum::<f64>() / 48.0;
    (join, baseline)
}

/// Demosaiced and gamma-encoded, which is as far as a pattern with no camera behind it can go.
///
/// No colour matrix and no tone curve: there is no sensor for one to describe, and both would only
/// compress the artefact this exists to show.
fn render(
    gpu: &'static rawshim::gpu::Gpu,
    rcd: &'static rawshim::demosaic::Rcd,
    mosaic: &[f32],
    side: usize,
    cfa: [u32; 4],
) -> Vec<u8> {
    rawshim::demosaic::demosaic_with(gpu, rcd, mosaic, side, side, cfa, |bytes| {
        bytes
            .chunks_exact(4)
            .map(|w| {
                let linear = f32::from_ne_bytes([w[0], w[1], w[2], w[3]]).clamp(0.0, 1.0);
                (linear.powf(1.0 / 2.2) * 255.0).round() as u8
            })
            .collect::<Vec<u8>>()
    })
    .expect("the pattern demosaics")
}

fn write(stem: &str, rgb: &[u8], width: usize, height: usize) {
    let image = rawshim::rgb::RgbRef { width, height, data: rgb };
    std::fs::write(format!("{stem}.jpg"), rawshim::jpeg::encode(image, 100).expect("encodes"))
        .expect("the JPEG writes");
}

/// A `window`-sided square from the middle, which is where the two seams cross.
fn centred(rgb: &[u8], side: usize, window: usize) -> Vec<u8> {
    let from = (side - window) / 2;
    let mut out = vec![0u8; window * window * 3];
    for row in 0..window {
        let at = ((from + row) * side + from) * 3;
        out[row * window * 3..(row + 1) * window * 3]
            .copy_from_slice(&rgb[at..at + window * 3]);
    }
    out
}

/// Panels in a row, separated by a white gutter.
fn alongside(panels: &[Vec<u8>], wide: usize, tall: usize) -> Vec<u8> {
    const GUTTER: usize = 4;
    let across = panels.len() * (wide + GUTTER) - GUTTER;
    let mut out = vec![255u8; across * tall * 3];
    for (at, panel) in panels.iter().enumerate() {
        let left = at * (wide + GUTTER);
        for row in 0..tall {
            let to = (row * across + left) * 3;
            out[to..to + wide * 3].copy_from_slice(&panel[row * wide * 3..(row + 1) * wide * 3]);
        }
    }
    out
}
