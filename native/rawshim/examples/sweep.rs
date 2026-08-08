//! Fits every RAW in a directory and reports how far its neutrals drifted from the camera's.
//!
//! usage: sweep <dir> [limit]
//!
//! **Asked on the camera's own near-neutral pixels, not on a synthetic grey.** Feeding the
//! model a pure grey walks the lattice into nodes a frame never populated, where it is
//! extrapolating - measured on IMG_9808 that reads +20 counts of blue where the picture's
//! actual shingle and snow are off by 4. So the question here is put to the pixels the camera
//! rendered neutral, which is the content a cast is visible on.
//!
//! A cast is signed and a scatter is not, so the two are reported apart: `drift` is the mean
//! signed difference between our chroma and the camera's on those pixels, and it is the number
//! that reads as a tint. Averaging its magnitude instead would let a green cast on one frame
//! and a warm one on the next cancel into a clean-looking set.

use rawshim::hdr::{self, Grade, Source};
use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::image::Strengths;
use std::env;

/// How close to grey the camera has to render a pixel for it to count, as a fraction of its
/// own brightest channel. Loose enough to find neutrals in a frame that has few.
const NEUTRAL: f64 = 0.04;

/// The lightness band asked about, in 8-bit counts. Below this is noise and above it is on the
/// way to clipping, and a cast in the mid-tones is what the eye reads.
const BAND: (u8, u8) = (60, 210);

fn main() {
    let dir = env::args().nth(1).expect("a directory of RAWs");
    let limit: usize = env::args().nth(2).and_then(|v| v.parse().ok()).unwrap_or(usize::MAX);

    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .expect("the directory reads")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                matches!(e.to_ascii_uppercase().as_str(), "CR3" | "CR2" | "ARW" | "NEF" | "RAF")
            })
        })
        .collect();
    paths.sort();
    paths.truncate(limit);

    println!("{:<18} {:>7} {:>4} {:>8} {:>9} {:>9}", "frame", "deltaE", "map", "neutrals", "drift g-r", "drift b-r");
    let mut worst: Vec<(f64, String)> = Vec::new();
    for path in &paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string();
        match measure(path.to_str().expect("a utf-8 path")) {
            None => println!("{name:<18} {:>7} {:>4}", "declined", "-"),
            Some(r) => {
                println!(
                    "{name:<18} {:>7.3} {:>4} {:>8} {:>+9.1} {:>+9.1}",
                    r.delta_e,
                    match r.map {
                        true => "yes",
                        false => "no",
                    },
                    r.neutrals,
                    r.drift_gr,
                    r.drift_br,
                );
                worst.push((r.drift_gr.hypot(r.drift_br), name));
            }
        }
    }

    worst.sort_by(|a, b| b.0.total_cmp(&a.0));
    println!("\nworst neutral drift:");
    for (size, name) in worst.iter().take(6) {
        println!("  {name:<18} {size:.1} counts");
    }
    let n = worst.len().max(1) as f64;
    println!("  {:<18} {:.2} counts", "mean over set", worst.iter().map(|w| w.0).sum::<f64>() / n);
}

struct Report {
    delta_e: f64,
    map: bool,
    neutrals: usize,
    drift_gr: f64,
    drift_br: f64,
}

fn measure(path: &str) -> Option<Report> {
    let frame = rawshim::decode_frame(path, 16, true, 0)?;
    let samples = frame.samples16()?;
    let source = Source { samples, width: frame.width, height: frame.height };

    let render = rawshim::decode_frame(path, 8, false, 0)?;
    let profile = rawshim::fit_profile_for(&render, path)?;
    let matched = rawshim::fit_hdr_for(&frame, path, 0.99, Some(&profile), Strengths::default())?;

    let options = EncodeOptions {
        still_chroma: Chroma::Yuv444,
        output_path: String::new(),
        grade: Grade { peak_nits: 203.0, reference_white_nits: 203.0, white_quantile: 0.99 },
        crf: 26,
        preset: 6,
        strengths: Strengths::default(),
        max_edge: 100_000.0,
    };
    let (rolled, width, height) = hdr::graded(&source, &options, Some(&matched));
    let ours = rawshim::tone::encode_srgb8(&rolled);
    let camera = rawshim::decode_embedded_rgb(path, 0)?;

    // Sampled on a stride rather than every pixel: a 24MP frame has millions of neutrals and
    // the mean of a hundred thousand of them is the same number.
    let (mut count, mut gr, mut br) = (0usize, 0.0f64, 0.0f64);
    let scale = camera.width as f64 / width as f64;
    for y in (0..height).step_by(7) {
        let cy = (y as f64 * scale) as usize;
        if cy >= camera.height {
            continue;
        }
        for x in (0..width).step_by(7) {
            let cx = (x as f64 * scale) as usize;
            if cx >= camera.width {
                continue;
            }
            let c = (cy * camera.width + cx) * 3;
            let t = [
                f64::from(camera.data[c]),
                f64::from(camera.data[c + 1]),
                f64::from(camera.data[c + 2]),
            ];
            let high = t[0].max(t[1]).max(t[2]);
            let low = t[0].min(t[1]).min(t[2]);
            if high < f64::from(BAND.0) || high > f64::from(BAND.1) || (high - low) / high > NEUTRAL
            {
                continue;
            }
            let o = (y * width + x) * 3;
            let v = [f64::from(ours[o]), f64::from(ours[o + 1]), f64::from(ours[o + 2])];
            // Ours against the camera's on the same pixel, so the camera's own tint on its
            // neutrals is not counted against us.
            gr += (v[1] - v[0]) - (t[1] - t[0]);
            br += (v[2] - v[0]) - (t[2] - t[0]);
            count += 1;
        }
    }

    let n = count.max(1) as f64;
    Some(Report {
        delta_e: matched.colour.delta_e,
        map: matched.colour.chroma.is_some(),
        neutrals: count,
        drift_gr: gr / n,
        drift_br: br / n,
    })
}
