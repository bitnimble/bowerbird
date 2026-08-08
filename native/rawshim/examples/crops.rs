//! Renders a frame through the full pipeline to sRGB and writes 100% crops, for judging
//! colour by eye - the part no aggregate metric answers.
//!
//! usage: crops <raw> <out-dir> [<x>,<y>,<w>,<h>]...
//! With no crops given it writes the whole frame reduced to a long edge of 1600.

use rawshim::hdr::{self, Grade, Source};
use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::image::Strengths;
use std::env;

fn main() {
    let mut args = env::args().skip(1);
    let path = args.next().expect("raw path");
    let out = args.next().expect("out dir");

    let frame = rawshim::decode_frame(&path, 16, true, 0).expect("decode");
    let samples = frame.samples16().expect("16-bit");
    let source = Source { samples, width: frame.width, height: frame.height };

    let render = rawshim::decode_frame(&path, 8, false, 0).expect("sdr decode");
    let profile = rawshim::fit_profile_for(&render, &path).expect("sdr fit");
    let matched = rawshim::fit_hdr_for(&frame, &path, 0.99, Some(&profile), Strengths::default())
        .expect("hdr fit");

    // SDR, which is the same grade with the peak at diffuse white and the sRGB transfer on
    // the end. `max_edge` is high enough not to reduce a 24MP frame, because a crop at 100%
    // is the whole point.
    let options = EncodeOptions {
        still_chroma: Chroma::Yuv444,
        output_path: String::new(),
        grade: Grade { peak_nits: 203.0, reference_white_nits: 203.0, white_quantile: 0.99 },
        crf: 26,
        preset: 6,
        strengths: Strengths::default(),
        max_edge: 100_000.0,
    };

    eprintln!(
        "chroma map {} saturation {} deltaE {}",
        matched.colour.chroma.is_some(),
        matched.colour.saturation,
        matched.colour.delta_e,
    );
    // What the fitted model does to a perfectly neutral input, at every level. Anything
    // other than zero here is the model tinting a grey, which is the cast by definition.
    let no_map = rawshim::hdr_fit::HdrColour { chroma: None, ..matched.colour.clone() };
    for level in [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9] {
        let full = rawshim::hdr_fit::apply_hdr_colour(&matched.colour, level, level, level);
        let bare = rawshim::hdr_fit::apply_hdr_colour(&no_map, level, level, level);
        let tint = |v: [f64; 3]| ((v[1] - v[0]) * 255.0, (v[2] - v[0]) * 255.0);
        let (fg, fb) = tint(full);
        let (bg, bb) = tint(bare);
        eprintln!(
            "neutral {level:.2}  whole model g-r {fg:+.1} b-r {fb:+.1}   \
             without the lattice g-r {bg:+.1} b-r {bb:+.1}",
        );
    }
    // The model's answer for a deep blue, at several lightnesses. If the lattice's node for
    // this colour carries a gain and the answer here does not show it, the colour is not
    // landing on that node at grade time.
    for level in [0.03, 0.06, 0.12, 0.25] {
        let v = [level * 0.35, level * 0.30, level];
        let out = rawshim::hdr_fit::apply_hdr_colour(&matched.colour, v[0], v[1], v[2]);
        let luma = |c: [f64; 3]| 0.2627 * c[0] + 0.678 * c[1] + 0.0593 * c[2];
        eprintln!(
            "blue {level:.2} in {:.4}/{:.4}/{:.4} out {:.4}/{:.4}/{:.4} luma x{:.3}",
            v[0], v[1], v[2], out[0], out[1], out[2],
            luma(out) / luma(v).max(1e-9),
        );
    }
    let (rolled, width, height) = hdr::graded(&source, &options, Some(&matched));
    let data = rawshim::tone::encode_srgb8(&rolled);
    eprintln!("graded {width}x{height}");

    let crops: Vec<String> = args.collect();
    if crops.is_empty() {
        let full = rawshim::rgb::RgbRef { width, height, data: &data };
        let small = rawshim::image::resize_to_fit(full, 1600);
        write(&format!("{out}/full.jpg"), small.as_ref());
        return;
    }

    // The camera's own rendering of the same region, which is the only way to tell a cast
    // from an object that really is that colour.
    let camera = rawshim::decode_embedded_rgb(&path, 0).expect("a preview");
    eprintln!("camera {}x{}", camera.width, camera.height);

    for spec in crops {
        let n: Vec<usize> = spec.split(',').map(|v| v.parse().expect("a number")).collect();
        let (x, y, w, h) = (n[0], n[1], n[2], n[3]);
        let ours = rawshim::rgb::RgbRef { width, height, data: &data };
        write(&format!("{out}/crop-{x}-{y}.jpg"), cut(ours, x, y, w, h).as_ref());

        // Ours on the left, the camera's own rendering on the right, one image so the two
        // are looked at under the same exposure and the same JPEG.
        let scale_side = camera.width as f64 / width as f64;
        let s = |v: usize| (v as f64 * scale_side).round() as usize;
        let pair = beside(
            cut(ours, x, y, w, h).as_ref(),
            cut(camera.as_ref(), s(x), s(y), s(w), s(h)).as_ref(),
        );
        write(&format!("{out}/pair-{x}-{y}.jpg"), pair.as_ref());

        let mine = mean(cut(ours, x, y, w, h).as_ref());
        let scale_to_camera = camera.width as f64 / width as f64;
        let c = |v: usize| (v as f64 * scale_to_camera).round() as usize;
        let theirs = mean(cut(camera.as_ref(), c(x), c(y), c(w), c(h)).as_ref());
        eprintln!(
            "  ours {:.0}/{:.0}/{:.0}  camera {:.0}/{:.0}/{:.0}  \
             ours b-r {:+.0} g-r {:+.0}, camera b-r {:+.0} g-r {:+.0}",
            mine[0], mine[1], mine[2],
            theirs[0], theirs[1], theirs[2],
            mine[2] - mine[0], mine[1] - mine[0],
            theirs[2] - theirs[0], theirs[1] - theirs[0],
        );

        let scale = camera.width as f64 / width as f64;
        let at = |v: usize| (v as f64 * scale).round() as usize;
        write(
            &format!("{out}/camera-{x}-{y}.jpg"),
            cut(camera.as_ref(), at(x), at(y), at(w), at(h)).as_ref(),
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

fn write(path: &str, image: rawshim::rgb::RgbRef<'_>) {
    let bytes = rawshim::jpeg::encode(image, 95).expect("the crop encodes");
    std::fs::write(path, bytes).expect("the crop writes");
    eprintln!("wrote {path}");
}
