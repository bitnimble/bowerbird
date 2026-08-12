//! Renders a set of photographs and records what came out, so a pipeline change can be held
//! against it afterwards.
//!
//! ```text
//! baseline <out-dir> <raw>...
//! ```
//!
//! Writes one AVIF per photograph at a reduced size, a 1:1 crop from the centre, and a JSON line
//! per photograph carrying the numbers a comparison actually turns on: the per-channel means, the
//! mean luma, and the luma roughness of the crop. Run it before a change and after, and diff.
//!
//! The renders go through `hdr::graded_as` exactly as a rendition does, so what is recorded is the
//! product's own output and not a harness's approximation of it.

use rawler::imgop::{Dim2, Point, Rect};
use rawshim::hdr::{self, Grade, Source};
use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::image::Strengths;

/// Long edge of the whole-frame record. Small enough to keep the directory manageable, large
/// enough that a colour shift is visible by eye.
const OVERVIEW: usize = 1600;

/// Side of the 1:1 crop, taken from the centre of the frame.
const CROP: usize = 512;

fn grade() -> Grade {
    Grade { peak_nits: 1000.0, reference_white_nits: 203.0, white_quantile: 0.995 }
}

fn options() -> EncodeOptions {
    EncodeOptions {
        still_chroma: Chroma::Yuv444,
        output_path: String::new(),
        grade: grade(),
        crf: 26,
        preset: 6,
        strengths: Strengths { sharpen: 1.0, defringe: 1.0 },
        // No reduction: the crop is taken at 1:1 and a resize would hide exactly the differences
        // this harness exists to measure.
        max_edge: 100_000.0,
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(out) = args.next() else {
        eprintln!("baseline <out-dir> <raw>...");
        return;
    };
    std::fs::create_dir_all(&out).expect("the output directory");

    for path in args {
        let name = std::path::Path::new(&path)
            .file_stem()
            .map_or_else(|| path.clone(), |s| s.to_string_lossy().into_owned());

        let started = std::time::Instant::now();
        let Some(frame) = rawshim::decode_frame_denoised(&path, 16, true, 0, Default::default()) else {
            println!("{{\"file\":\"{name}\",\"error\":\"decode failed\"}}");
            continue;
        };
        let decode_ms = started.elapsed().as_millis();
        let (width, height) = (frame.width, frame.height);

        let Some(samples) = frame.samples16() else {
            println!("{{\"file\":\"{name}\",\"error\":\"not a 16-bit decode\"}}");
            continue;
        };
        let source = Source { samples, width, height };
        let matched = rawshim::fit_hdr_for(&frame, &path, grade().white_quantile, None, Strengths { sharpen: 1.0, defringe: 1.0 });

        let graded = std::time::Instant::now();
        let (rgb, out_w, out_h) = hdr::graded_as(&source, &options(), matched.as_ref(), rawshim::gpu::Output::Srgb);
        let grade_ms = graded.elapsed().as_millis();
        let bytes: Vec<u8> = rgb.iter().map(|v| *v as u8).collect();
        let whole = rawshim::rgb::RgbRef { width: out_w, height: out_h, data: &bytes };

        let small = rawshim::image::resize_to_fit(whole, OVERVIEW);
        write(&format!("{out}/{name}.avif"), small.as_ref());

        let cx = out_w.saturating_sub(CROP) / 2;
        let cy = out_h.saturating_sub(CROP) / 2;
        let cut = crop(whole, cx, cy, CROP);
        write(&format!("{out}/{name}-crop.avif"), cut.as_ref());

        let (mr, mg, mb) = channel_means(whole);
        println!(
            "{{\"file\":\"{name}\",\"w\":{out_w},\"h\":{out_h},\"decode_ms\":{decode_ms},\"grade_ms\":{grade_ms},\
             \"mean_r\":{mr:.4},\"mean_g\":{mg:.4},\"mean_b\":{mb:.4},\"mean_luma\":{:.4},\
             \"crop_at\":[{cx},{cy}],\"crop_roughness\":{:.4},\"matched\":{}}}",
            0.2126 * mr + 0.7152 * mg + 0.0722 * mb,
            roughness(cut.as_ref()),
            matched.is_some(),
        );
    }
}

/// Mean of each channel over the whole frame. A colour shift shows here before it shows anywhere
/// else, and it is invariant to where a crop was taken.
fn channel_means(image: rawshim::rgb::RgbRef<'_>) -> (f64, f64, f64) {
    let n = (image.width * image.height) as f64;
    let mut sums = [0f64; 3];
    for pixel in image.data.chunks_exact(3) {
        sums[0] += f64::from(pixel[0]);
        sums[1] += f64::from(pixel[1]);
        sums[2] += f64::from(pixel[2]);
    }
    (sums[0] / n, sums[1] / n, sums[2] / n)
}

/// Mean absolute Laplacian of luma: how much fine structure survived. A demosaic that smears
/// detail drops this; one that adds zipper artefacts raises it.
fn roughness(image: rawshim::rgb::RgbRef<'_>) -> f64 {
    let luma = |x: usize, y: usize| -> f64 {
        let at = (y * image.width + x) * 3;
        0.2126 * f64::from(image.data[at]) + 0.7152 * f64::from(image.data[at + 1]) + 0.0722 * f64::from(image.data[at + 2])
    };
    let mut total = 0.0;
    let mut count = 0u64;
    for y in 1..image.height.saturating_sub(1) {
        for x in 1..image.width.saturating_sub(1) {
            let centre = 4.0 * luma(x, y);
            let ring = luma(x - 1, y) + luma(x + 1, y) + luma(x, y - 1) + luma(x, y + 1);
            total += (centre - ring).abs();
            count += 1;
        }
    }
    if count == 0 { 0.0 } else { total / count as f64 }
}

fn crop(image: rawshim::rgb::RgbRef<'_>, x: usize, y: usize, side: usize) -> rawshim::rgb::Rgb {
    let w = side.min(image.width.saturating_sub(x));
    let h = side.min(image.height.saturating_sub(y));
    let mut data = vec![0u8; w * h * 3];
    for row in 0..h {
        let from = ((y + row) * image.width + x) * 3;
        data[row * w * 3..(row + 1) * w * 3].copy_from_slice(&image.data[from..from + w * 3]);
    }
    rawshim::rgb::Rgb { width: w, height: h, data }
}

fn write(path: &str, image: rawshim::rgb::RgbRef<'_>) {
    rawshim::avif::encode_rendition(std::borrow::Cow::Borrowed(image.data), image.width, image.height, 4, 10, true, path)
        .expect("the record encodes");
}

/// Silences the unused-import warning for the region type, which this harness does not need but
/// which keeps the import list identical to the comparison harness beside it.
#[allow(dead_code)]
fn _unused(_: Rect, _: Point, _: Dim2) {}
