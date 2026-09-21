//! Renders a frame through the full pipeline to sRGB and writes 100% crops, for judging
//! colour by eye - the part no aggregate metric answers.
//!
//! usage: crops <raw> <out-dir> [<x>,<y>,<w>,<h>]...
//! With no crops given it writes the whole frame reduced to a long edge of 1600.

use rawshim::hdr::{self, Grade, Source};
use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::image::Strengths;
use rawshim::light::Light;
use std::env;

fn main() {
    let mut args = env::args().skip(1);
    let path = args.next().expect("raw path");
    let out = args.next().expect("out dir");

    let frame = rawshim::decode_frame(&path, 0).expect("decode");
    let samples = frame.samples16().expect("16-bit");
    let source = Source { samples, width: frame.width, height: frame.height };

    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    let resident = frame.on_device(gpu).expect("the frame reaches the device");
    let matched = rawshim::fit_hdr_for(&resident, &path, 0.99).expect("hdr fit");

    // SDR, which is the same grade with the peak at diffuse white and the sRGB transfer on
    // the end. `max_edge` is high enough not to reduce a 24MP frame, because a crop at 100%
    // is the whole point.
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

    let colour = matched.colour.as_ref().expect("colour");
    eprintln!(
        "chroma map {} saturation {} deltaE {}",
        colour.chroma.is_some(),
        colour.saturation,
        colour.delta_e,
    );
    // What the fitted model does to a perfectly neutral input, at every level. Anything
    // other than zero here is the model tinting a grey, which is the cast by definition.
    let no_map = rawshim::hdr_fit::HdrColour { chroma: None, ..colour.clone() };
    let levels = [0.02f32, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9];
    let greys: Vec<[f32; 4]> = levels.iter().map(|l| [*l, *l, *l, 0.0]).collect();
    let through = |colour: &rawshim::hdr_fit::HdrColour| {
        pollster::block_on(rawshim::hdr_fit::evaluated(
            gpu,
            colour,
            &greys,
            rawshim::hdr_fit::Stage::Full,
        ))
        .expect("the device evaluates the model")
    };
    for ((level, full), bare) in levels.iter().zip(through(colour)).zip(through(&no_map)) {
        let tint = |v: [f32; 4]| (f64::from(v[1] - v[0]) * 255.0, f64::from(v[2] - v[0]) * 255.0);
        let (fg, fb) = tint(full);
        let (bg, bb) = tint(bare);
        eprintln!(
            "neutral {level:.2}  whole model g-r {fg:+.1} b-r {fb:+.1}   \
             without the lattice g-r {bg:+.1} b-r {bb:+.1}",
        );
    }
    // sRGB out of the same dispatch that grades, rather than a second implementation of the
    // primaries and the transfer on this side.
    let (coded, width, height) =
        hdr::graded_as(&source, &options, Some(&matched), rawshim::gpu::Output::Srgb);
    let data: Vec<u8> = coded.iter().map(|v| *v as u8).collect();
    eprintln!("graded {width}x{height}");

    let crops: Vec<String> = args.collect();
    if crops.is_empty() {
        let full = rawshim::rgb::RgbRef { width, height, data: &data };
        let small = rawshim::image::resize_to_fit(full, 1600);
        write(&format!("{out}/full.avif"), small.as_ref());
        return;
    }

    // The camera's own rendering of the same region, which is the only way to tell a cast
    // from an object that really is that colour.
    let camera = rawshim::decode_embedded_rgb(&path, 0).expect("a preview");
    eprintln!("camera {}x{}", camera.width, camera.height);

    for spec in crops {
        let n: Vec<usize> = spec.split(',').map(|v| v.parse().expect("a number")).collect();
        let (x, y, w, h) = (n[0], n[1], n[2], n[3]);
        // The camera's preview and the graded frame need not share a size, so the region is
        // scaled into the camera's coordinates rather than assumed to land in the same place.
        let scale = camera.width as f64 / width as f64;
        let at = |v: usize| (v as f64 * scale).round() as usize;
        let mine = cut(rawshim::rgb::RgbRef { width, height, data: &data }, x, y, w, h);
        let theirs = cut(camera.as_ref(), at(x), at(y), at(w), at(h));

        write(&format!("{out}/crop-{x}-{y}.avif"), mine.as_ref());
        write(&format!("{out}/camera-{x}-{y}.avif"), theirs.as_ref());
        // And the two in one image, so they are judged under the same exposure and the same
        // JPEG rather than by flicking between files.
        write(&format!("{out}/pair-{x}-{y}.avif"), beside(mine.as_ref(), theirs.as_ref()).as_ref());

        let (a, b) = (mean(mine.as_ref()), mean(theirs.as_ref()));
        eprintln!(
            "  ours {:.0}/{:.0}/{:.0}  camera {:.0}/{:.0}/{:.0}  \
             ours b-r {:+.0} g-r {:+.0}, camera b-r {:+.0} g-r {:+.0}",
            a[0], a[1], a[2],
            b[0], b[1], b[2],
            a[2] - a[0], a[1] - a[0],
            b[2] - b[0], b[1] - b[0],
        );
    }
}

/// Two crops in one image, separated by a gap. The camera's is resampled to ours where the
/// two were cut at different scales, so the pair is the same size and the same subject.
fn beside(left: rawshim::rgb::RgbRef<'_>, right: rawshim::rgb::RgbRef<'_>) -> rawshim::rgb::Rgb {
    let gap = 12usize;
    let (w, h) = (left.width, left.height);
    let width = w * 2 + gap;
    let mut data = vec![255u8; width * h * 3];
    for (panel, image) in [left, right].into_iter().enumerate() {
        let at = panel * (w + gap);
        for row in 0..h {
            for col in 0..w {
                // Nearest, so neither side gains detail the other does not have.
                let sx = col * image.width / w;
                let sy = row * image.height / h;
                let from = (sy * image.width + sx) * 3;
                let to = (row * width + at + col) * 3;
                data[to..to + 3].copy_from_slice(&image.data[from..from + 3]);
            }
        }
    }
    rawshim::rgb::Rgb { width, height: h, data }
}

fn mean(image: rawshim::rgb::RgbRef<'_>) -> [f64; 3] {
    let mut sum = [0.0f64; 3];
    for p in 0..image.width * image.height {
        for c in 0..3 {
            sum[c] += f64::from(image.data[p * 3 + c]);
        }
    }
    let n = (image.width * image.height) as f64;
    [sum[0] / n, sum[1] / n, sum[2] / n]
}

fn cut(image: rawshim::rgb::RgbRef<'_>, x: usize, y: usize, w: usize, h: usize) -> rawshim::rgb::Rgb {
    let mut data = vec![0u8; w * h * 3];
    for row in 0..h {
        let from = ((y + row) * image.width + x) * 3;
        data[row * w * 3..(row + 1) * w * 3].copy_from_slice(&image.data[from..from + w * 3]);
    }
    rawshim::rgb::Rgb { width: w, height: h, data }
}

/// Both forms, because this exists to be looked at and AVIF does not open everywhere.
fn write(path: &str, image: rawshim::rgb::RgbRef<'_>) {
    rawshim::avif::encode_rendition(
        std::borrow::Cow::Borrowed(image.data),
        image.width,
        image.height,
        4,
        10,
        true,
        path,
    )
    .expect("the crop encodes");

    let jpeg = path.strip_suffix(".avif").map_or_else(|| format!("{path}.jpg"), |s| format!("{s}.jpg"));
    std::fs::write(&jpeg, rawshim::jpeg::encode(image, 95).expect("the crop encodes as JPEG"))
        .expect("the JPEG writes");
    eprintln!("wrote {path} and {jpeg}");
}
