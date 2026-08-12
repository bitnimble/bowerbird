//! How good is our demosaic, in a number.
//!
//! ```text
//! demosaic_psnr <image.avif|jpg>...
//! ```
//!
//! Takes a full-colour image as ground truth, throws away two of every three samples to make a
//! Bayer mosaic of it, reconstructs, and reports how close the reconstruction is. This is the
//! standard way the literature measures a demosaicer and it is the only way to get an answer that
//! is not a matter of opinion: against a real sensor there is no ground truth to compare with.
//!
//! Reported per channel and overall, in dB. Ten dB is a factor of ten in mean squared error, so
//! differences of a dB are meaningful and differences of five are large.
//!
//! The interior is measured, not the border: every demosaicer degrades at the frame edge where
//! there is nothing to read, that margin is filled by a different method in every implementation,
//! and including it would measure the fill rather than the algorithm.

/// Ignored on every side, comfortably more than the algorithm's own margin.
const EDGE: usize = 16;

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("demosaic_psnr <image>...");
        return;
    }

    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("no GPU adapter");
        return;
    };
    let Some(rcd) = rawshim::demosaic::device(gpu) else {
        eprintln!("the demosaic would not build");
        return;
    };

    println!("{:>28}  {:>11}  {:>7}  {:>7}  {:>7}  {:>7}", "image", "pixels", "R dB", "G dB", "B dB", "all dB");

    let mut totals = Vec::new();
    for path in &files {
        // A synthetic frequency sweep, for when the question is whether the direction decision
        // works at all rather than how it does on a photograph. Bilinear cannot survive this:
        // beyond half the sampling rate it turns fine detail into coloured moire, which is exactly
        // the failure a directional method exists to avoid. If a demosaicer does not win here by a
        // wide margin, it is not steering.
        let full = if path == "chirp" {
            chirp(512)
        } else {
            let Ok(bytes) = std::fs::read(path) else {
                eprintln!("{path}: unreadable");
                continue;
            };
            let Ok(decoded) = rawshim::image::decode(&bytes, 0) else {
                eprintln!("{path}: would not decode");
                continue;
            };
            decoded
        };
        // **Halved first, and this is not incidental.** The only ground truth available here is a
        // frame that has already been demosaiced, so its neighbouring pixels were interpolated
        // from each other and its channels are correlated at exactly the frequencies a demosaicer
        // is judged on. Re-mosaicking that measures how well a method undoes a subsample of
        // something already smooth, which flatters simple averaging and penalises directional
        // methods for the sharpening they are for. Halving decorrelates the neighbours and puts
        // real detail back at the sampling grid's own scale. It is why the McMaster set exists in
        // the form it does rather than being used at native resolution.
        // The sweep is already at the scale it is meant to be tested at.
        let truth = if path == "chirp" { full } else { halve(&full) };
        let (w, h) = (truth.width, truth.height);
        if w < 64 || h < 64 {
            continue;
        }

        // RGGB, which is what the majority of the library's sensors use. The algorithm is
        // phase-agnostic, so the choice only decides which samples survive.
        let cfa = [0u32, 1, 1, 2];
        let colour_at = |r: usize, c: usize| cfa[(r & 1) * 2 + (c & 1)] as usize;

        let mut mosaic = vec![0f32; w * h];
        for r in 0..h {
            for c in 0..w {
                let at = (r * w + c) * 3;
                mosaic[r * w + c] = f32::from(truth.data[at + colour_at(r, c)]) / 255.0;
            }
        }

        let started = std::time::Instant::now();
        let Some(out) = rawshim::demosaic::demosaic_with(gpu, rcd, &mosaic, w, h, cfa, |rgb| {
            rgb.chunks_exact(4).map(|b| f32::from_ne_bytes([b[0], b[1], b[2], b[3]])).collect::<Vec<f32>>()
        }) else {
            eprintln!("{path}: demosaic declined");
            continue;
        };
        let ms = started.elapsed().as_millis();

        let name = std::path::Path::new(path)
            .file_stem()
            .map_or_else(|| path.clone(), |s| s.to_string_lossy().into_owned());
        let db = psnr(&truth, &out, w, h);
        // Bilinear on the same mosaic, as a floor. It is not what we are replacing - that is PPG,
        // which needs a real sensor file and is compared against in the pipeline A/B - but it does
        // establish that the measurement discriminates, and by how much.
        let flat = bilinear(&mosaic, w, h, cfa);
        let floor = psnr(&truth, &flat, w, h);
        println!(
            "{name:>28}  {:>8.2}MP  {:>7.2}  {:>7.2}  {:>7.2}  {:>7.2}   {ms}ms   (bilinear R {:>5.2} G {:>5.2} B {:>5.2} all {:>5.2})",
            (w * h) as f64 / 1e6,
            db[0], db[1], db[2], db[3], floor[0], floor[1], floor[2], floor[3],
        );
        totals.push(db);
    }

    if totals.len() > 1 {
        let mean = |i: usize| totals.iter().map(|d| d[i]).sum::<f64>() / totals.len() as f64;
        println!(
            "{:>28}  {:>11}  {:>7.2}  {:>7.2}  {:>7.2}  {:>7.2}",
            "mean", "", mean(0), mean(1), mean(2), mean(3)
        );
    }
}

/// A radial frequency sweep: spatial frequency rises with distance from the centre, so one image
/// covers everything from flat to beyond the sampling limit. Grey, deliberately - every channel
/// carries the same signal, so any colour in the reconstruction is an artefact of the demosaic and
/// nothing else.
fn chirp(side: usize) -> rawshim::rgb::Rgb {
    let mut data = vec![0u8; side * side * 3];
    let centre = side as f64 / 2.0;
    for r in 0..side {
        for c in 0..side {
            let dy = r as f64 - centre;
            let dx = c as f64 - centre;
            let radius = (dx * dx + dy * dy).sqrt();
            // Phase grows with the square of radius, so instantaneous frequency grows linearly.
            let value = 0.5 + 0.45 * (radius * radius * 0.006).sin();
            let level = (value * 255.0).clamp(0.0, 255.0) as u8;
            for ch in 0..3 {
                data[(r * side + c) * 3 + ch] = level;
            }
        }
    }
    rawshim::rgb::Rgb { width: side, height: side, data }
}

/// Box-downsamples by two. See the call site for why the measurement depends on it.
fn halve(image: &rawshim::rgb::Rgb) -> rawshim::rgb::Rgb {
    let (w, h) = (image.width / 2, image.height / 2);
    let mut data = vec![0u8; w * h * 3];
    for r in 0..h {
        for c in 0..w {
            for ch in 0..3 {
                let mut total = 0u32;
                for dr in 0..2 {
                    for dc in 0..2 {
                        total += u32::from(image.data[((r * 2 + dr) * image.width + c * 2 + dc) * 3 + ch]);
                    }
                }
                data[(r * w + c) * 3 + ch] = (total / 4) as u8;
            }
        }
    }
    rawshim::rgb::Rgb { width: w, height: h, data }
}

/// The simplest thing that works: each missing sample is the mean of its neighbours of that
/// colour. No direction decision at all, which is exactly what makes it a useful floor.
fn bilinear(mosaic: &[f32], w: usize, h: usize, cfa: [u32; 4]) -> Vec<f32> {
    let colour_at = |r: usize, c: usize| cfa[(r & 1) * 2 + (c & 1)] as usize;
    let mut out = vec![0f32; w * h * 3];
    for r in 0..h {
        for c in 0..w {
            let here = colour_at(r, c);
            let mut sums = [0f64; 3];
            let mut counts = [0u32; 3];
            for dr in -1i32..=1 {
                for dc in -1i32..=1 {
                    let rr = r as i32 + dr;
                    let cc = c as i32 + dc;
                    if rr < 0 || cc < 0 || rr >= h as i32 || cc >= w as i32 {
                        continue;
                    }
                    let ch = colour_at(rr as usize, cc as usize);
                    sums[ch] += f64::from(mosaic[rr as usize * w + cc as usize]);
                    counts[ch] += 1;
                }
            }
            for ch in 0..3 {
                out[(r * w + c) * 3 + ch] = if ch == here {
                    mosaic[r * w + c]
                } else if counts[ch] > 0 {
                    (sums[ch] / f64::from(counts[ch])) as f32
                } else {
                    0.0
                };
            }
        }
    }
    out
}

/// Per-channel and overall PSNR against the ground truth, over the interior only.
fn psnr(truth: &rawshim::rgb::Rgb, got: &[f32], w: usize, h: usize) -> [f64; 4] {
    let mut sse = [0f64; 3];
    let mut count = 0u64;
    for r in EDGE..h.saturating_sub(EDGE) {
        for c in EDGE..w.saturating_sub(EDGE) {
            let at = r * w + c;
            for ch in 0..3 {
                let want = f64::from(truth.data[at * 3 + ch]);
                // The reconstruction is in the unit interval; the truth is in 8-bit counts.
                let have = (f64::from(got[at * 3 + ch]) * 255.0).clamp(0.0, 255.0);
                let diff = want - have;
                sse[ch] += diff * diff;
            }
            count += 1;
        }
    }
    if count == 0 {
        return [0.0; 4];
    }
    let db = |sum: f64, n: f64| {
        let mse = sum / n;
        if mse <= 0.0 { 99.0 } else { 10.0 * (255.0f64 * 255.0 / mse).log10() }
    };
    let n = count as f64;
    [
        db(sse[0], n),
        db(sse[1], n),
        db(sse[2], n),
        db(sse[0] + sse[1] + sse[2], n * 3.0),
    ]
}
