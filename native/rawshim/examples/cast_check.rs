//! How far the render's grey is from the camera's own, per channel.
//!
//! ```text
//! cast_check <raw>...
//! ```
//!
//! The camera's embedded JPEG is the one white balance nobody can argue with: the body applied its
//! own multipliers and its own matrix to the same photons. So the render's channel means, divided
//! by the JPEG's and taken relative to green, say whether the colour transform is leaving a
//! per-channel gain behind - which is what a matrix normalised in the wrong space does, and what no
//! amount of looking at a saturated subject makes obvious.
//!
//! Linearised before averaging, because a mean of gamma-encoded samples is not a mean of light and
//! the two render's tone curves are not the same curve.

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("cast_check <raw>...");
        return;
    }

    println!("{:>16}  {:>8}  {:>8}  {:>8}", "file", "R/G", "B/G", "deltaE");
    let (mut reds, mut blues, mut deltas) = (Vec::new(), Vec::new(), Vec::new());
    for path in files {
        let name = std::path::Path::new(&path)
            .file_stem()
            .map_or_else(|| path.clone(), |s| s.to_string_lossy().into_owned());
        let Some(frame) = rawshim::decode_frame(&path, 8, false, 400) else {
            println!("{name:>16}  declined");
            continue;
        };
        let Some(render) = frame.rgb8() else {
            println!("{name:>16}  not an 8-bit decode");
            continue;
        };
        let render = rawshim::image::resize_to_fit(render, 400);
        let Some(camera) = rawshim::decode_embedded_frame(&path, 400) else {
            println!("{name:>16}  no embedded preview");
            continue;
        };
        let Some(camera) = camera.rgb8() else {
            println!("{name:>16}  the preview is not 8-bit");
            continue;
        };

        let ours = linear_means(render.as_ref());
        let theirs = linear_means(camera);
        let ratio: Vec<f64> = (0..3).map(|c| (ours[c] / theirs[c]) / (ours[1] / theirs[1])).collect();
        reds.push(ratio[0]);
        blues.push(ratio[2]);

        let delta = mean_delta_e(render.as_ref(), camera);
        deltas.push(delta);
        println!("{name:>16}  {:8.4}  {:8.4}  {delta:8.2}", ratio[0], ratio[2]);
    }

    let mean = |v: &[f64]| {
        let live: Vec<f64> = v.iter().copied().filter(|x| x.is_finite()).collect();
        live.iter().sum::<f64>() / live.len() as f64
    };
    println!(
        "\n{:>16}  {:8.4}  {:8.4}  {:8.2}",
        "mean",
        mean(&reds),
        mean(&blues),
        mean(&deltas),
    );
}

/// Sampled on a shared relative grid rather than pixel against pixel: the render is the
/// manufacturer's recommended crop and the camera's own JPEG is very slightly wider, so at 400 the
/// two round to different widths and a per-pixel walk would compare a sheared pair.
fn mean_delta_e(ours: rawshim::rgb::RgbRef<'_>, theirs: rawshim::rgb::RgbRef<'_>) -> f64 {
    const GRID: usize = 200;
    let at = |image: &rawshim::rgb::RgbRef<'_>, u: f64, v: f64| {
        let x = ((u * image.width as f64) as usize).min(image.width - 1);
        let y = ((v * image.height as f64) as usize).min(image.height - 1);
        let i = (y * image.width + x) * 3;
        [
            f64::from(image.data[i]),
            f64::from(image.data[i + 1]),
            f64::from(image.data[i + 2]),
        ]
    };

    let mut total = 0f64;
    for row in 0..GRID {
        let v = (row as f64 + 0.5) / GRID as f64;
        for col in 0..GRID {
            let u = (col as f64 + 0.5) / GRID as f64;
            total += rawshim::fit::delta_e76(&at(&ours, u, v), &at(&theirs, u, v));
        }
    }
    total / (GRID * GRID) as f64
}

fn linear_means(image: rawshim::rgb::RgbRef<'_>) -> [f64; 3] {
    let mut totals = [0f64; 3];
    for pixel in image.data.chunks_exact(3) {
        for (channel, total) in totals.iter_mut().enumerate() {
            let coded = f64::from(pixel[channel]) / 255.0;
            *total += match coded <= 0.04045 {
                true => coded / 12.92,
                false => ((coded + 0.055) / 1.055).powf(2.4),
            };
        }
    }
    let count = (image.data.len() / 3) as f64;
    [totals[0] / count, totals[1] / count, totals[2] / count]
}
