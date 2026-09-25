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

use rawshim::gpu::Intent;
use rawshim::hdr::{self, Grade, Source};
use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::image::Strengths;
use rawshim::light::Light;
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

    println!(
        "{:<18} {:>7} {:>8} {:>8} {:>4} {:>8} {:>9} {:>9}  camera curve (max u error)",
        "frame", "deltaE", "percept", "relative", "map", "neutrals", "drift g-r", "drift b-r"
    );
    let mut worst: Vec<(f64, String)> = Vec::new();
    let mut rendered: Vec<f64> = Vec::new();
    let mut rendered_relative: Vec<f64> = Vec::new();
    let mut curve_errors: Vec<f64> = Vec::new();
    for path in &paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string();
        match measure(path.to_str().expect("a utf-8 path")) {
            None => println!("{name:<18} {:>7} {:>8} {:>8} {:>4}", "declined", "-", "-", "-"),
            Some(r) => {
                println!(
                    "{name:<18} {:>7.3} {:>8.3} {:>8.3} {:>4} {:>8} {:>+9.1} {:>+9.1}  \
                     {:?} ({:.6})",
                    r.delta_e,
                    r.rendered,
                    r.rendered_relative,
                    match r.map {
                        true => "yes",
                        false => "no",
                    },
                    r.neutrals,
                    r.drift_gr,
                    r.drift_br,
                    r.curve,
                    r.curve_error,
                );
                worst.push((r.drift_gr.hypot(r.drift_br), name));
                rendered.push(r.rendered);
                rendered_relative.push(r.rendered_relative);
                curve_errors.push(r.curve_error);
            }
        }
    }

    let scored = rendered.len().max(1) as f64;
    println!(
        "\nrendered against the camera, mean over set: perceptual {:.4}, relative colorimetric {:.4}, over {} frames",
        rendered.iter().sum::<f64>() / scored,
        rendered_relative.iter().sum::<f64>() / scored,
        rendered.len(),
    );
    println!("camera curve max u error over set: {:.6}", curve_errors.into_iter().fold(0.0f64, f64::max));

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
    /// The rendered picture against the camera's own as a mean CIEDE2000, which is the claim a
    /// lattice size is actually making. `delta_e` beside it is the fit scoring itself on its own
    /// pairs.
    rendered: f64,
    rendered_relative: f64,
    map: bool,
    neutrals: usize,
    drift_gr: f64,
    drift_br: f64,
    curve: Vec<[f64; 2]>,
    curve_error: f64,
}

fn measure(path: &str) -> Option<Report> {
    let frame = rawshim::decode_frame(path, 0)?;
    let samples = frame.samples16()?;
    let source = Source { samples, width: frame.width, height: frame.height };

    let gpu = rawshim::gpu::device()?;
    let resident = frame.on_device(gpu)?;
    let matched = rawshim::fit_hdr_for(&resident, path, 0.99)?;

    let options = EncodeOptions {
        still_chroma: Chroma::Yuv444,
        output_path: String::new(),
        grade: Grade {
            peak_nits: Light::exactly(203.0),
            reference_white_nits: Light::exactly(203.0),
            white_quantile: 0.99,
        },
        crf: 26,
        preset: 6,
        strengths: Strengths::default(),
        sharpen_sigma: None,
        max_edge: 100_000.0,
    };
    let camera = rawshim::decode_embedded_rgb(path, 0)?;
    let relative = against_camera(gpu, &source, &options, &matched, &camera, Intent::RelativeColorimetric)?;
    let perceptual = against_camera(gpu, &source, &options, &matched, &camera, Intent::Perceptual)?;
    Some(Report {
        delta_e: matched.colour.as_ref()?.delta_e,
        rendered: perceptual.rendered,
        rendered_relative: relative.rendered,
        map: matched.colour.as_ref()?.chroma.is_some(),
        neutrals: perceptual.neutrals,
        drift_gr: perceptual.drift_gr,
        drift_br: perceptual.drift_br,
        curve: matched.colour.as_ref()?.curve.clone(),
        curve_error: matched.colour.as_ref()?.curve_error,
    })
}

struct Rendered {
    rendered: f64,
    neutrals: usize,
    drift_gr: f64,
    drift_br: f64,
}

fn against_camera(
    gpu: &'static rawshim::gpu::Gpu,
    source: &Source,
    options: &EncodeOptions,
    matched: &rawshim::hdr_fit::HdrMatch,
    camera: &rawshim::rgb::Rgb,
    intent: Intent,
) -> Option<Rendered> {
    // sRGB out of the same dispatch that grades, rather than a second implementation of the
    // primaries and the transfer on this side.
    let (coded, width, height) = hdr::graded_under(source, options, Some(matched), rawshim::gpu::Output::Srgb, intent);
    let ours: Vec<u8> = coded.iter().map(|v| *v as u8).collect();

    // Sampled on a stride rather than every pixel: a 24MP frame has millions of neutrals and
    // the mean of a hundred thousand of them is the same number.
    let (mut count, mut gr, mut br) = (0usize, 0.0f64, 0.0f64);
    // The rendered picture against the camera's, over every sampled pixel rather than the
    // neutral ones. **This is the only number here the fit cannot flatter itself on.** The fit's
    // own `delta_e` scores it against a sample of its own input, and no split of one photograph
    // makes that independent - the same lawn is on both sides of any partition - so a lattice
    // that memorises colours scores well on pairs it never saw. This is the output.
    let (mut ours_linear, mut camera_linear) = (Vec::new(), Vec::new());
    let linear = |v: [f64; 3]| [0, 1, 2].map(|c| rawshim::hdr_fit::srgb_eotf(v[c] as u8));
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
            let o = (y * width + x) * 3;
            let v = [f64::from(ours[o]), f64::from(ours[o + 1]), f64::from(ours[o + 2])];
            ours_linear.push((linear(v), 0.0));
            camera_linear.push(linear(t));

            let high = t[0].max(t[1]).max(t[2]);
            let low = t[0].min(t[1]).min(t[2]);
            if high < f64::from(BAND.0) || high > f64::from(BAND.1) || (high - low) / high > NEUTRAL
            {
                continue;
            }
            // Ours against the camera's on the same pixel, so the camera's own tint on its
            // neutrals is not counted against us.
            gr += (v[1] - v[0]) - (t[1] - t[0]);
            br += (v[2] - v[0]) - (t[2] - t[0]);
            count += 1;
        }
    }

    // Both sides already in sRGB, so the objective's own primaries matrix is the identity.
    let shown = camera_linear.len();
    let scoring = rawshim::fit_score::Scoring::new(
        gpu,
        rawshim::fit_score::below_buffer(gpu, &ours_linear),
        &camera_linear,
        &vec![1.0; shown],
        &[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        256,
    );
    let neutral = [rawshim::fit_score::Probe::neutral()];
    let blocks = pollster::block_on(scoring.partials(&rawshim::fit_score::Shape::Saturation, &neutral))?
        .remove(0);
    let rendered = blocks.iter().map(|b| b.flat).sum::<f64>() / shown.max(1) as f64;

    let n = count.max(1) as f64;
    Some(Rendered { rendered, neutrals: count, drift_gr: gr / n, drift_br: br / n })
}
