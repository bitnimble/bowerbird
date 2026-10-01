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

mod support;

use rawshim::gpu::Intent;
use rawshim::hdr_args::{Chroma, EncodeOptions};
use std::env;

/// How close to grey the camera has to render a pixel for it to count, as a fraction of its
/// own brightest channel. Loose enough to find neutrals in a frame that has few.
const NEUTRAL: f64 = 0.04;

/// The lightness band asked about, in 8-bit counts. Below this is noise and above it is on the
/// way to clipping, and a cast in the mid-tones is what the eye reads.
const BAND: (u8, u8) = (60, 210);

/// Light added to every cell of both pictures before they are compared, as a share of white: what
/// a display's own black and the eye's glare from the picture's bright regions lay over a shadow.
const VEILING_GLARE: f64 = 0.01;

/// Samples a colour class needs before its mean is one.
const MIN_CLASS_SAMPLES: f64 = 32.0;

/// The `full` rendition's long edge, which the photo viewer opens at. A lattice's cost on a
/// shadow depends on the size it is drawn at - per-pixel noise through a nonlinear map is a cast
/// once averaged - so the picture is judged at the size people see.
const VIEWED_EDGE: u32 = support::FULL_RENDITION_SIZE;

fn main() {
    let dir = env::args().nth(1).expect("a directory of RAWs");
    let limit: usize = env::args()
        .nth(2)
        .and_then(|v| v.parse().ok())
        .unwrap_or(usize::MAX);

    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .expect("the directory reads")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                matches!(
                    e.to_ascii_uppercase().as_str(),
                    "CR3" | "CR2" | "ARW" | "NEF" | "RAF"
                )
            })
        })
        .collect();
    paths.sort();
    paths.truncate(limit);

    println!(
        "{:<18} {:>7} {:>8} {:>8} {:>8} {:>8} {:>4} {:>8} {:>9} {:>9}  camera exposure, curve (max u error)",
        "frame",
        "deltaE",
        "percept",
        "plain",
        "classed",
        "relative",
        "map",
        "neutrals",
        "drift g-r",
        "drift b-r"
    );
    let mut worst: Vec<(f64, String)> = Vec::new();
    let mut rendered: Vec<f64> = Vec::new();
    let mut plain: Vec<f64> = Vec::new();
    let mut classed: Vec<f64> = Vec::new();
    let mut rendered_relative: Vec<f64> = Vec::new();
    let mut curve_errors: Vec<f64> = Vec::new();
    for path in &paths {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("?")
            .to_string();
        match measure(path.to_str().expect("a utf-8 path")) {
            None => println!(
                "{name:<18} {:>7} {:>8} {:>8} {:>4}",
                "declined", "-", "-", "-"
            ),
            Some(r) => {
                println!(
                    "{name:<18} {:>7.3} {:>8.3} {:>8.3} {:>8.3} {:>8.3} {:>4} {:>8} {:>+9.1} {:>+9.1}  \
                     {:+.3} stops, {:?} ({:.6})",
                    r.delta_e,
                    r.rendered,
                    r.plain,
                    r.classed,
                    r.rendered_relative,
                    match r.map {
                        true => "yes",
                        false => "no",
                    },
                    r.neutrals,
                    r.drift_gr,
                    r.drift_br,
                    r.exposure.raw(),
                    r.curve,
                    r.curve_error,
                );
                if env::var_os("SWEEP_CLASSES").is_some() {
                    let means: Vec<String> = r
                        .classes
                        .iter()
                        .enumerate()
                        .filter_map(|(k, mean)| mean.map(|m| format!("{k}:{m:.2}")))
                        .collect();
                    println!("  classes {}", means.join(" "));
                }
                worst.push((r.drift_gr.hypot(r.drift_br), name));
                rendered.push(r.rendered);
                plain.push(r.plain);
                classed.push(r.classed);
                rendered_relative.push(r.rendered_relative);
                curve_errors.push(r.curve_error);
            }
        }
    }

    let scored = rendered.len().max(1) as f64;
    println!(
        "\nrendered against the camera, mean over set: perceptual {:.4}, plain CIEDE2000 {:.4}, classed {:.4}, relative colorimetric {:.4}, over {} frames",
        rendered.iter().sum::<f64>() / scored,
        plain.iter().sum::<f64>() / scored,
        classed.iter().sum::<f64>() / scored,
        rendered_relative.iter().sum::<f64>() / scored,
        rendered.len(),
    );
    println!(
        "camera curve max u error over set: {:.6}",
        curve_errors.into_iter().fold(0.0f64, f64::max)
    );

    worst.sort_by(|a, b| b.0.total_cmp(&a.0));
    println!("\nworst neutral drift:");
    for (size, name) in worst.iter().take(6) {
        println!("  {name:<18} {size:.1} counts");
    }
    let n = worst.len().max(1) as f64;
    println!(
        "  {:<18} {:.2} counts",
        "mean over set",
        worst.iter().map(|w| w.0).sum::<f64>() / n
    );
}

struct Report {
    delta_e: f64,
    /// The rendered picture against the camera's own as a mean of the error the fit is scored in
    /// (`fit_score.slang`), which is the claim a lattice size is actually making. `delta_e` beside
    /// it is the fit scoring itself on its own pairs.
    rendered: f64,
    /// The same as a mean CIEDE2000.
    plain: f64,
    /// The same, with every colour class the frame holds counting once whatever its area: a mean
    /// over pixels cannot see a small red object turn purple.
    classed: f64,
    classes: Vec<Option<f64>>,
    rendered_relative: f64,
    map: bool,
    neutrals: usize,
    drift_gr: f64,
    drift_br: f64,
    exposure: rawshim::light::Stops,
    curve: Vec<[f64; 2]>,
    curve_error: f64,
}

fn measure(path: &str) -> Option<Report> {
    let opened = support::Open::shipped(path, VIEWED_EDGE).run()?;
    let gpu = rawshim::gpu::device()?;
    let matched = opened.measured.matched.as_ref()?;

    let options = EncodeOptions {
        still_chroma: Chroma::Yuv444,
        output_path: String::new(),
        grade: support::GRADE,
        crf: 26,
        preset: 6,
        strengths: support::STRENGTHS,
        sharpen_sigma: None,
        max_edge: f64::from(VIEWED_EDGE),
        content_light: None,
    };
    let camera = rawshim::decode_embedded_rgb(path, 0)?;
    let relative = against_camera(&opened, &options, &camera, Intent::RelativeColorimetric)?;
    let perceptual = against_camera(&opened, &options, &camera, Intent::Perceptual)?;
    Some(Report {
        delta_e: matched.colour.as_ref()?.delta_e,
        rendered: perceptual.rendered,
        plain: perceptual.plain,
        classed: perceptual.classed,
        classes: perceptual.classes,
        rendered_relative: relative.rendered,
        map: matched.colour.as_ref()?.chroma.is_some(),
        neutrals: perceptual.neutrals,
        drift_gr: perceptual.drift_gr,
        drift_br: perceptual.drift_br,
        exposure: matched.colour.as_ref()?.exposure,
        curve: matched.colour.as_ref()?.curve.clone(),
        curve_error: pollster::block_on(rawshim::hdr_fit::camera_curve_error(
            gpu,
            matched.colour.as_ref()?,
        ))
        .unwrap_or(0.0),
    })
}

struct Rendered {
    rendered: f64,
    plain: f64,
    classed: f64,
    classes: Vec<Option<f64>>,
    neutrals: usize,
    drift_gr: f64,
    drift_br: f64,
}

fn against_camera(
    opened: &support::Opened,
    options: &EncodeOptions,
    camera: &rawshim::rgb::Rgb,
    intent: Intent,
) -> Option<Rendered> {
    // sRGB out of the same dispatch that grades, rather than a second implementation of the
    // primaries and the transfer on this side.
    let (coded, width, height) =
        support::graded_under(opened, options, rawshim::gpu::Output::Srgb, intent);
    let gpu = rawshim::gpu::device()?;
    let ours: Vec<u8> = coded.iter().map(|v| *v as u8).collect();

    // Sampled on a stride rather than every pixel: a 24MP frame has millions of neutrals and
    // the mean of a hundred thousand of them is the same number.
    let (mut count, mut gr, mut br) = (0usize, 0.0f64, 0.0f64);
    // The rendered picture against the camera's, over every cell rather than the neutral ones.
    // **This is the only number here the fit cannot flatter itself on.** The fit's own `delta_e`
    // scores it against a sample of its own input, and no split of one photograph makes that
    // independent - the same lawn is on both sides of any partition - so a lattice that memorises
    // colours scores well on pairs it never saw. This is the output.
    //
    // Each side is the mean of its cell in light, not one pixel of it: a single pixel carries
    // both bodies' grain and sharpening, which no colour fit reproduces, and on a frame of dark
    // rock that texture outweighs the colour.
    let (mut ours_linear, mut camera_linear) = (Vec::new(), Vec::new());
    let linear = |v: [f64; 3]| [0, 1, 2].map(|c| rawshim::hdr_fit::srgb_eotf(v[c] as u8));
    let cell_mean = |data: &[u8], wide: usize, x: [usize; 2], y: [usize; 2]| -> [f64; 3] {
        let mut sum = [0.0f64; 3];
        for row in y[0]..y[1] {
            for col in x[0]..x[1] {
                let at = (row * wide + col) * 3;
                let v = linear([0, 1, 2].map(|c| f64::from(data[at + c])));
                (0..3).for_each(|c| sum[c] += v[c]);
            }
        }
        let n = ((x[1] - x[0]) * (y[1] - y[0])).max(1) as f64;
        sum.map(|s| s / n + VEILING_GLARE)
    };
    let scale = camera.width as f64 / width as f64;
    let on_camera = |v: usize, limit: usize| ((v as f64 * scale) as usize).min(limit);
    for y in (0..height).step_by(7) {
        let cy = (y as f64 * scale) as usize;
        if cy >= camera.height {
            continue;
        }
        let rows = [y, (y + 7).min(height)];
        let camera_rows = [cy, on_camera(rows[1], camera.height).max(cy + 1)];
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
            let v = [
                f64::from(ours[o]),
                f64::from(ours[o + 1]),
                f64::from(ours[o + 2]),
            ];
            let cols = [x, (x + 7).min(width)];
            let camera_cols = [cx, on_camera(cols[1], camera.width).max(cx + 1)];
            ours_linear.push((cell_mean(&ours, width, cols, rows), 0.0));
            camera_linear.push(cell_mean(
                &camera.data,
                camera.width,
                camera_cols,
                camera_rows,
            ));

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
        1,
    );
    let neutral = [rawshim::fit_score::Probe::neutral()];
    let blocks =
        pollster::block_on(scoring.partials(&rawshim::fit_score::Shape::Saturation, &neutral))?
            .remove(0);
    let rendered = blocks.iter().map(|b| b.flat).sum::<f64>() / shown.max(1) as f64;
    let plain = blocks.iter().map(|b| b.plain).sum::<f64>() / shown.max(1) as f64;
    let classes: Vec<Option<f64>> = (0..blocks.first().map_or(0, |b| b.class_seen.len()))
        .map(|k| {
            let seen: f64 = blocks.iter().map(|b| b.class_seen[k]).sum();
            let error: f64 = blocks.iter().map(|b| b.class_error[k]).sum();
            (seen >= MIN_CLASS_SAMPLES).then(|| error / seen)
        })
        .collect();
    let present: Vec<f64> = classes.iter().flatten().copied().collect();
    let classed = present.iter().sum::<f64>() / present.len().max(1) as f64;

    let n = count.max(1) as f64;
    Some(Rendered {
        rendered,
        plain,
        classed,
        classes,
        neutrals: count,
        drift_gr: gr / n,
        drift_br: br / n,
    })
}
