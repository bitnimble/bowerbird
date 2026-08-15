//! What the editor shows and what a rendition ships, from the same RAW, without a browser.
//!
//! ```text
//! renders <raw> <out-dir> [--detail N] [--crop x,y,side]...
//! ```
//!
//! Both are render specifications and nothing else - a decode, a set of edits, a size - so both
//! belong here rather than in Playwright. The editor's tick is the one that looks like it needs a
//! browser and does not: `gpu.rs` runs the same grade shaders the client does, and
//! `galosh_srgb.rs` runs the same denoise kernels, so this renders the picture the reader would
//! be looking at.
//!
//! The two differ in exactly one place, which is the thing worth comparing: a rendition denoises
//! the **mosaic** before demosaicing (`galosh.rs`), and the editor denoises the **prepared
//! frame** afterwards (`galosh_srgb.rs`). Everything downstream - the fit, the warp, the grade -
//! is shared code on one host.
//!
//! With no `--crop` it writes each render whole, reduced to 1600 on the long edge, which is where
//! to start when looking for somewhere worth cutting. Crops are in the frame's own pixels and are
//! written at 1:1, because noise and texture are invisible in a downscale.

use rawshim::hdr::{self, Grade, Source};
use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::image::Strengths;

/// The grade both paths are rendered through. The library's own defaults, so neither render is
/// answering a question about settings.
fn grade() -> Grade {
    Grade { peak_nits: 1000.0, reference_white_nits: 203.0, white_quantile: 0.995 }
}

fn strengths() -> Strengths {
    Strengths { sharpen: 1.0, defringe: 1.0 }
}

fn options() -> EncodeOptions {
    EncodeOptions {
        still_chroma: Chroma::Yuv444,
        output_path: String::new(),
        grade: grade(),
        crf: 26,
        preset: 6,
        strengths: strengths(),
        // No reduction: a crop at 1:1 is the point, and the editor is not reducing either.
        max_edge: 100_000.0,
    }
}

/// The rendition path: denoised inside the decode, on the mosaic, then fitted and graded.
///
/// `job::Base::build` in miniature, at the sensor's own size.
fn rendition(path: &str, detail: f64, _sigma_scale: f32) -> (Vec<u8>, usize, usize) {
    let amounts = rawshim::galosh::Amounts::from_sliders(detail, detail);
    let frame = rawshim::decode_frame_denoised(path, 16, true, 0, amounts).expect("decode");
    let samples = frame.samples16().expect("16-bit").to_vec();
    graded(path, &frame, &samples)
}

/// The editor path: prepared undenoised, denoised on the prepared frame, then graded.
///
/// The measurement is `crate::noise`'s, exactly as `edit::prepare_bytes` attaches it, because the tick
/// is handed a sigma rather than measuring one.
fn editor(path: &str, detail: f64, sigma_scale: f32) -> (Vec<u8>, usize, usize) {
    let frame = rawshim::decode_frame(path, 16, true, 0).expect("decode");
    let samples = frame.samples16().expect("16-bit");
    let source = Source { samples, width: frame.width, height: frame.height };
    // `edit::open`'s own sequence, so the only thing left differing from the rendition is which
    // denoiser ran: code, filter, warp, sharpen. Skipping the warp here would compare two
    // crops of two geometries.
    //
    // **The levels and the scene are `graded_as`'s, to the letter.** They are what the grade
    // divides by, so measuring them a little differently here - unfloored levels, or the
    // camera's illuminant where that path deliberately passes none - is a brightness and a cast
    // between the two renders, and it reads exactly like a denoiser difference.
    let matched = rawshim::fit_hdr_for(&frame, path, 0.995, None, strengths());
    let levels = rawshim::tone::levels(source.samples, grade().white_quantile).anchored();
    let mut prepared = hdr::prepare_with(&source, None, *levels);
    rawshim::tone::encode_base(&mut prepared.samples, levels, grade().reference_white_nits);
    let filter = |prepared: &mut hdr::Prepared, strengths: Strengths| {
        hdr::filter_base(&mut prepared.samples, prepared.width, prepared.height, strengths);
    };
    filter(&mut prepared, strengths().before_the_fit());
    if let Some(colour) = matched.as_ref() {
        if let Some(warped) = rawshim::hdr_fit::apply_lens(
            &prepared.samples,
            prepared.width,
            prepared.height,
            colour,
        ) {
            prepared.samples = warped;
        }
    }
    filter(&mut prepared, Strengths { sharpen: strengths().sharpen, ..Default::default() });

    // Handed a sigma rather than measuring one, which is what `edit::prepare_bytes` attaches.
    //
    // `--sigma-scale` multiplies it, which is how the two paths were calibrated against each
    // other: the slider is a fraction *of this*, so what a position means depends entirely on
    // it being right, and the way to find out what right is was to sweep it against the
    // rendition rather than to reason about the estimator.
    let mut noise = rawshim::noise::measure(&prepared.samples, prepared.width, prepared.height);
    noise.stabilised *= sigma_scale;
    let gpu = rawshim::gpu::device().expect("an adapter");
    let chain = rawshim::galosh_srgb::device(gpu).expect("this adapter runs the editor's denoise");
    rawshim::galosh_srgb::denoise(
        gpu,
        chain,
        &mut prepared.samples,
        prepared.width,
        prepared.height,
        &noise,
        rawshim::galosh_srgb::Amounts::for_editor(detail, detail),
    );
    eprintln!("  sigma {:.4}, alpha {:.5}", noise.stabilised, noise.alpha);

    // `encode` and not `graded_as`: the frame is coded and warped already, which is the state a
    // tick works from. `graded_as` measures levels and codes for itself, so handing it this
    // would code a coded frame - a flat, lifted picture that is not what anybody sees.
    //
    // The scene it grades through is assembled the way `graded_as` assembles its own, including
    // the missing illuminant: as the camera rendered it, with nothing to balance away from.
    let scene = rawshim::tone::SceneGrade::new(
        matched.as_ref().map(|m| &m.colour),
        levels,
        grade().reference_white_nits,
        1.0,
        rawshim::gpu::Adjust::none(),
        None,
    );
    let coded = gpu.encode(
        &prepared.samples,
        &scene.gpu_grade(
            prepared.width,
            prepared.height,
            grade().peak_nits,
            rawshim::gpu::Output::Srgb,
        ),
    );
    (coded.iter().map(|v| *v as u8).collect(), prepared.width, prepared.height)
}

/// The rendition's tail: fit the camera match off the frame, then grade to sRGB.
fn graded(path: &str, frame: &rawshim::frame::Frame, samples: &[u16]) -> (Vec<u8>, usize, usize) {
    let source = Source { samples, width: frame.width, height: frame.height };
    let matched = rawshim::fit_hdr_for(frame, path, 0.995, None, strengths());
    let (coded, width, height) =
        hdr::graded_as(&source, &options(), matched.as_ref(), rawshim::gpu::Output::Srgb);
    (coded.iter().map(|v| *v as u8).collect(), width, height)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("a raw path");
    let out = args.next().expect("an output directory");
    let mut detail = 40.0;
    let mut sigma_scale = 1.0f32;
    let mut crops: Vec<(usize, usize, usize)> = Vec::new();
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--detail" => detail = args.next().expect("a number").parse().expect("a number"),
            "--sigma-scale" => {
                sigma_scale = args.next().expect("a number").parse().expect("a number");
            }
            "--crop" => {
                let spec = args.next().expect("x,y,side");
                let n: Vec<usize> =
                    spec.split(',').map(|v| v.parse().expect("a number")).collect();
                crops.push((n[0], n[1], n[2]));
            }
            other => panic!("unknown flag {other}"),
        }
    }
    std::fs::create_dir_all(&out).expect("the output directory");

    for (name, render) in [
        ("rendition", rendition as fn(&str, f64, f32) -> (Vec<u8>, usize, usize)),
        ("editor", editor),
    ] {
        eprintln!("{name} at detail {detail}:");
        let started = std::time::Instant::now();
        let (data, width, height) = render(&path, detail, sigma_scale);
        eprintln!("  {width}x{height} in {}ms", started.elapsed().as_millis());
        let whole = rawshim::rgb::RgbRef { width, height, data: &data };

        if crops.is_empty() {
            let small = rawshim::image::resize_to_fit(whole, 1600);
            write(&format!("{out}/{name}.avif"), small.as_ref());
            continue;
        }
        for (x, y, side) in &crops {
            let cut = cut(whole, *x, *y, *side);
            // The mean beside the roughness, because the two renders are only comparable while
            // they are graded alike - and a grade that has drifted reads as a denoiser that has.
            // A pair whose means differ is a harness bug, not a finding.
            eprintln!(
                "    {x},{y} roughness {:.2} mean {:.1}",
                roughness(cut.as_ref()),
                mean(cut.as_ref()),
            );
            write(&format!("{out}/{name}-{x}-{y}.avif"), cut.as_ref());
        }
    }
}

fn cut(image: rawshim::rgb::RgbRef<'_>, x: usize, y: usize, side: usize) -> rawshim::rgb::Rgb {
    let x = x.min(image.width.saturating_sub(side));
    let y = y.min(image.height.saturating_sub(side));
    let mut data = vec![0u8; side * side * 3];
    for row in 0..side {
        let from = ((y + row) * image.width + x) * 3;
        data[row * side * 3..(row + 1) * side * 3]
            .copy_from_slice(&image.data[from..from + side * 3]);
    }
    rawshim::rgb::Rgb { width: side, height: side, data }
}

/// Median absolute three-tap Laplacian over luma - the estimator the rest of the pipeline reads
/// noise with. Comparable between two renderings of the same subject at the same scale, and
/// meaningless across subjects.
fn roughness(image: rawshim::rgb::RgbRef<'_>) -> f64 {
    let luma = |i: usize| {
        0.2126 * f64::from(image.data[i * 3])
            + 0.7152 * f64::from(image.data[i * 3 + 1])
            + 0.0722 * f64::from(image.data[i * 3 + 2])
    };
    let mut laps: Vec<f64> = Vec::new();
    for row in 0..image.height {
        for col in 0..image.width - 2 {
            let at = row * image.width + col;
            laps.push((luma(at) - 2.0 * luma(at + 1) + luma(at + 2)).abs());
        }
    }
    let mid = laps.len() / 2;
    laps.select_nth_unstable_by(mid, f64::total_cmp);
    laps[mid] / 1.6521
}

/// Near-lossless, because the whole point of a crop here is to look at grain: an encoder that
/// smoothed it would be answering the question the harness was opened to ask.
const CROP_QUANTIZER: i32 = 4;

/// Fastest. These are written to be looked at once and deleted.
const CROP_SPEED: i32 = 10;

/// Mean luma, which says whether two renders were graded alike.
fn mean(image: rawshim::rgb::RgbRef<'_>) -> f64 {
    let sum: f64 = (0..image.width * image.height)
        .map(|i| {
            0.2126 * f64::from(image.data[i * 3])
                + 0.7152 * f64::from(image.data[i * 3 + 1])
                + 0.0722 * f64::from(image.data[i * 3 + 2])
        })
        .sum();
    sum / (image.width * image.height) as f64
}

fn write(path: &str, image: rawshim::rgb::RgbRef<'_>) {
    rawshim::avif::encode_rendition(
        std::borrow::Cow::Borrowed(image.data),
        image.width,
        image.height,
        CROP_QUANTIZER,
        CROP_SPEED,
        true,
        path,
    )
    .expect("the crop encodes");
    eprintln!("    wrote {path}");
}
