//! One region of a photograph, rendered exactly as the loupe renders it, stitched beside the
//! camera's own preview of the same region.
//!
//! ```text
//! loupe <raw> <x> <y> <side> <out.jpg>
//! ```
//!
//! The fast way to look at a crop: `renders` decodes, fits and grades the whole frame to write
//! one, where the tile path decodes and grades the window alone. The fit still needs the whole
//! frame and dominates what is left - but a crop that took a whole-frame render now takes the
//! fit and a loupe tile, and the camera's rendering of the same region sits beside it for the
//! comparison every camera-match question ends at. The held-out score and the fitted domain are
//! printed for the same reason.

mod support;

use rawshim::photo_analysis::{FromRaw, PhotoAnalysis};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [raw, x, y, side, out] = &args[..] else {
        panic!("loupe <raw> <x> <y> <side> <out.jpg>");
    };
    let (x, y, side): (usize, usize, usize) = (
        x.parse().unwrap(),
        y.parse().unwrap(),
        side.parse().unwrap(),
    );

    let gpu = rawshim::gpu::device().expect("a Vulkan adapter, since the grade is a shader");
    let open_started = std::time::Instant::now();
    let support::Opened { frame, measured } = support::Open::shipped(raw, 0).run().expect("decode");
    let open_seconds = open_started.elapsed().as_secs_f64();
    assert_eq!(
        frame.reduced, 1,
        "tile coordinates assume the sensor's own grid"
    );
    let matched = measured.matched.expect("a fit");
    let colour = matched.colour.as_ref().expect("colour");
    eprintln!(
        "fit: delta_e {:.3} ceiling {:.3} saturation {:.3} lattice {}",
        colour.delta_e,
        colour.ceiling,
        colour.saturation,
        match colour.chroma.is_some() {
            true => "accepted",
            false => "declined",
        },
    );

    let sensor = frame.width;
    let defocus = match measured.defringe {
        // `Done` was this open's buffer; the tile decodes its own, which still carries the fringe.
        rawshim::base::Defringe::Done(pair) | rawshim::base::Defringe::Take(pair) => {
            rawshim::base::Defringe::Take(pair)
        }
        rawshim::base::Defringe::Measure => rawshim::base::Defringe::Measure,
    };
    let analysis = PhotoAnalysis {
        from_raw: FromRaw {
            matched: Some(matched),
            noise: frame.noise,
            dust: frame.dust.clone(),
            capture_sigma: measured.blur,
            ..Default::default()
        },
        ..Default::default()
    };
    let sidecar = rawshim::photo_analysis::encode(&analysis);
    let request = rawshim::tile::TileRequest {
        tile: [x, y, side, side],
        frame: [frame.width, frame.height],
        grade: support::GRADE,
        strengths: support::STRENGTHS,
        denoise_luminance: None,
        denoise_colour: None,
        denoiser: rawshim::galosh::Denoiser::Galosh,
        highlight_recovery: None,
        dust: Default::default(),
        adjust: rawshim::gpu::Adjust::none(),
        levels: Some(measured.levels),
        noise_fit: frame.noise,
        capture_sigma: measured.blur,
        sensor_long: None,
        defocus,
        photo_analysis: Some(sidecar.clone()),
        scale: Default::default(),
        repairs: Vec::new(),
        drawn: None,
    };
    let sidecar_bytes = sidecar.len();
    drop(frame);
    let window =
        rawshim::tile::prepared(rawshim::tile::Source::Path(raw), &request).expect("a tile");
    let scene = window.scene(None, rawshim::gpu::Adjust::none());
    // Diffuse white as the peak, because this writes sRGB: the same reasoning as `renders`.
    let grade = window.grade(
        &scene,
        rawshim::light::Light::at_diffuse_white(request.grade.reference_white_nits),
        rawshim::gpu::Output::Srgb,
    );
    let width = window.width;
    let uploaded = gpu.upload(&window.samples, &grade, &gpu.scene_peak());
    let coded = uploaded.encode(&grade);
    // The tick the editor would pay for this tile, best of five.
    let mut tick = f64::INFINITY;
    for _ in 0..5 {
        let started = std::time::Instant::now();
        let _ = uploaded.encode(&grade);
        tick = tick.min(started.elapsed().as_secs_f64());
    }
    eprintln!(
        "timing: open {open_seconds:.2}s, sidecar {sidecar_bytes} bytes, tile {}x{} encode {:.1}ms",
        window.width,
        window.height,
        tick * 1000.0
    );
    let [kl, kt, kw, kh] = window.keep;
    let mut ours = Vec::with_capacity(kw * kh * 3);
    for row in 0..kh {
        let from = ((kt + row) * width + kl) * 3;
        ours.extend(coded[from..from + kw * 3].iter().map(|v| *v as u8));
    }

    // The camera's preview of the same rectangle, nearest-upscaled to the render's size.
    let cam = rawshim::decode_embedded_rgb(raw, 100_000).expect("an embedded preview");
    let scale = sensor as f64 / cam.width as f64;
    let edge = kh;
    let row = edge * 2 + 8;
    let mut stitched = vec![0u8; row * edge * 3];
    for oy in 0..edge {
        for ox in 0..edge {
            let px = ((x as f64 + ox as f64 / edge as f64 * side as f64) / scale) as usize;
            let py = ((y as f64 + oy as f64 / edge as f64 * side as f64) / scale) as usize;
            let (px, py) = (px.min(cam.width - 1), py.min(cam.height - 1));
            let s = (py * cam.width + px) * 3;
            let d = (oy * row + ox) * 3;
            stitched[d..d + 3].copy_from_slice(&cam.data[s..s + 3]);
        }
        for ox in 0..edge.min(kw) {
            let s = (oy * kw + ox) * 3;
            let d = (oy * row + edge + 8 + ox) * 3;
            stitched[d..d + 3].copy_from_slice(&ours[s..s + 3]);
        }
    }
    let image = rawshim::rgb::Rgb {
        width: row,
        height: edge,
        data: stitched,
    };
    std::fs::write(out, rawshim::jpeg::encode(image.as_ref(), 95).unwrap()).unwrap();
    // Lossless twin beside it: the comparison tooling reads this one, since a JPEG's
    // subsampled chroma rings at exactly the scale the diffs are amplified to.
    let ppm = format!("{out}.ppm");
    let mut bytes = format!("P6\n{} {}\n255\n", image.width, image.height).into_bytes();
    bytes.extend_from_slice(&image.data);
    std::fs::write(&ppm, bytes).unwrap();
    eprintln!("wrote {out} and {ppm}");
}
