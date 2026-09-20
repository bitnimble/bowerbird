//! What a dust correction looks like when it is wrong, side by side with what it was given.
//!
//! ```text
//! dust_evidence <raw> <out-dir> [--sensitivity 0..1] [--spot N] [--side N] [--list]
//! ```
//!
//! **The gates cannot be argued about in the abstract.** `dust.rs` says the true and false
//! populations overlap - that a dark round dust-sized patch of rock *is* a dark round dust-sized
//! patch - and that the confidence bar is what confines the answer to where it is trustworthy. That
//! is a claim about pictures, so this writes the picture: the frame as it was, with a ring around
//! what the search decided was a particle, beside the same frame with that particle divided out.
//!
//! `--list` prints every candidate with its confidence and depth, which is how to find one worth
//! looking at. A spot the resting bar of about 6.0 would keep is a spot the reader will actually
//! see corrected; anything under 4.0 is in the band where a mistake lives.

use rawshim::hdr::{self, Grade, Source};
use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::image::Strengths;
use rawshim::light::Light;

fn grade() -> Grade {
    Grade {
        peak_nits: Light::exactly(1000.0),
        reference_white_nits: Light::exactly(203.0),
        white_quantile: 0.9,
    }
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
        // The fixed default: what this example varies is the glass, and a sigma measured off one
        // frame and not the other would put a second difference in the pair it is evidence for.
        sharpen_sigma: None,
        max_edge: 100_000.0,
    }
}

/// The photograph as a rendition would ship it, with whatever the caller asked done about dust.
///
/// Through `decode_fitted` rather than `decode_frame_denoised`, because that one takes the glass off
/// the request deliberately - a fixture with a spot removed no longer pins what it was written to.
/// This example is the one caller that wants the opposite.
fn rendered(path: &str, glass: rawshim::dust::Wanted<'_>) -> (Vec<u8>, usize, usize) {
    let detail = rawshim::galosh::Detail::at(40.0, 40.0);
    let frame =
        rawshim::decode_rawler::decode_fitted(
            path,
            detail,
            0,
            Default::default(),
            Default::default(),
            glass,
        )
            .expect("decode");
    let frame = pollster::block_on(frame.to_host()).expect("the frame reads back");
    let samples = frame.samples16().expect("16-bit").to_vec();
    let source = Source { samples: &samples, width: frame.width, height: frame.height };
    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    let resident = frame.on_device(gpu).expect("the frame reaches the device");
    let matched = rawshim::fit_hdr_for(&resident, path, 0.995);
    let (coded, width, height) =
        hdr::graded_as(&source, &options(), matched.as_ref(), rawshim::gpu::Output::Srgb);
    (coded.iter().map(|v| *v as u8).collect(), width, height)
}

/// Every candidate the frame offers, with no reader's gate applied.
fn candidates(path: &str) -> Vec<rawshim::dust::Spot> {
    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    let bytes = std::fs::read(path).expect("the file");
    let held = pollster::block_on(rawshim::decode_rawler::hold_bytes(&bytes)).expect("a decoder");
    let sensor = held.glass();
    eprintln!("  f/{}  {}x{}", sensor.aperture, sensor.width, sensor.height);
    pollster::block_on(rawshim::dust::detect(gpu, held.device_mosaic(), &sensor))
        .unwrap_or_default()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("a raw path");
    let out = args.next().expect("an output directory");
    let mut sensitivity = 1.0f64;
    let mut which = 0usize;
    let mut side = 420usize;
    let mut list = false;
    let mut whole = false;
    let mut zoom = 1usize;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--sensitivity" => {
                sensitivity = args.next().expect("a number").parse().expect("a number");
            }
            "--spot" => which = args.next().expect("a number").parse().expect("a number"),
            "--side" => side = args.next().expect("a number").parse().expect("a number"),
            "--list" => list = true,
            // The photograph itself, reduced, with every candidate ringed - which is how to tell
            // whether a frame's candidates are on sky or on something with a texture of its own.
            "--whole" => whole = true,
            // At least one, because zero is a request for an image with no pixels in it, and every
            // encoder below would rather be told than be handed one.
            "--zoom" => {
                zoom = args.next().expect("a number").parse::<usize>().expect("a number").max(1);
            }
            other => panic!("unknown flag {other}"),
        }
    }
    std::fs::create_dir_all(&out).expect("the output directory");

    eprintln!("{path}");
    let spots = candidates(&path);
    if spots.is_empty() {
        eprintln!("  nothing on the glass this frame could hold");
        return;
    }
    // The confidence a reader would have to ask for to see each one.
    let bar = |snr: f32| {
        (0..=100)
            .find(|hundredths| {
                let at = rawshim::dust::Removal {
                    sensitivity: f64::from(*hundredths) / 100.0,
                    intensity: 1.0,
                };
                at.min_snr() <= snr
            })
            .unwrap_or(100)
    };
    for (at, spot) in spots.iter().enumerate() {
        eprintln!(
            "  [{at:3}] ({:6.0},{:6.0})  snr {:5.2}  depth {:.4}  radius {:5.1}  \
             visible from sensitivity {}",
            spot.x * 2.0,
            spot.y * 2.0,
            spot.snr,
            spot.profile[0],
            spot.scale,
            bar(spot.snr),
        );
    }
    if list {
        return;
    }

    if whole {
        let (frame, width, height) = rendered(&path, rawshim::dust::Wanted::Off);
        let small = rawshim::image::resize_to_fit(
            rawshim::rgb::RgbRef { width, height, data: &frame },
            1400,
        );
        let mut data = small.data.clone();
        let scale = small.width as f32 / width as f32;
        for spot in &spots {
            circle(
                &mut data,
                small.width,
                (spot.x * 2.0 * scale, spot.y * 2.0 * scale),
                (spot.scale * 2.0 * 2.5 * scale).max(9.0),
            );
        }
        let name = format!("{out}/dust-whole.avif");
        write(&name, rawshim::rgb::RgbRef { width: small.width, height: small.height, data: &data });
        eprintln!("  wrote {name}");
        return;
    }

    let spot = spots.get(which).expect("a spot at that index").clone();
    eprintln!(
        "\n  correcting [{which}] at ({:.0},{:.0}), snr {:.2}, at sensitivity {sensitivity}",
        spot.x * 2.0,
        spot.y * 2.0,
        spot.snr,
    );
    let removal = rawshim::dust::Removal { sensitivity, intensity: 1.0 };
    assert!(
        spot.snr >= removal.min_snr(),
        "sensitivity {sensitivity} asks for {:.2} and this spot is {:.2} - it would not be touched",
        removal.min_snr(),
        spot.snr,
    );

    let (before, width, height) = rendered(&path, rawshim::dust::Wanted::Off);
    let held = [spot.clone()];
    let (after, _, _) = rendered(&path, rawshim::dust::Wanted::Given(&held, removal));

    // A spot's coordinates are the sensor's quad grid, so twice them is photosites - which is the
    // render's own grid, both frames here being the sensor's full size with no reduction asked for.
    let at = (spot.x * 2.0, spot.y * 2.0);
    let ring = spot.scale * 2.0 * 2.5;
    // A crop cannot be larger than the picture it is taken from: `--side` is a request, and a body
    // narrower than the one asked for would otherwise read off the end of the last row.
    let side = side.clamp(1, width.min(height));
    let cut = |image: &[u8], mark: bool| {
        let left = (at.0 as usize).saturating_sub(side / 2).min(width.saturating_sub(side));
        let top = (at.1 as usize).saturating_sub(side / 2).min(height.saturating_sub(side));
        let mut data = vec![0u8; side * side * 3];
        for row in 0..side {
            let from = ((top + row) * width + left) * 3;
            data[row * side * 3..(row + 1) * side * 3]
                .copy_from_slice(&image[from..from + side * 3]);
        }
        if mark {
            circle(&mut data, side, (at.0 - left as f32, at.1 - top as f32), ring);
        }
        data
    };

    let pair = beside(&magnified(&cut(&before, true), side, zoom), &magnified(&cut(&after, false), side, zoom), side * zoom);
    let side = side * zoom;
    let name = format!("{out}/dust-{}-{}.avif", at.0 as usize, at.1 as usize);
    write(&name, rawshim::rgb::RgbRef { width: side * 2 + GAP, height: side, data: &pair });
    eprintln!("  wrote {name}");
}

/// Pixels of background between the two halves, so an eye can tell where one stops.
const GAP: usize = 16;

/// Nearest neighbour, deliberately: a smooth magnification would soften exactly the edge the pair
/// exists to show, and a correction that looks fine because the resampler blurred it is not an
/// answer to anything.
fn magnified(image: &[u8], side: usize, zoom: usize) -> Vec<u8> {
    if zoom == 1 {
        return image.to_vec();
    }
    let wide = side * zoom;
    let mut out = vec![0u8; wide * wide * 3];
    for y in 0..wide {
        for x in 0..wide {
            let from = ((y / zoom) * side + x / zoom) * 3;
            let into = (y * wide + x) * 3;
            out[into..into + 3].copy_from_slice(&image[from..from + 3]);
        }
    }
    out
}

fn beside(left: &[u8], right: &[u8], side: usize) -> Vec<u8> {
    let width = side * 2 + GAP;
    let mut out = vec![24u8; width * side * 3];
    for row in 0..side {
        let into = row * width * 3;
        out[into..into + side * 3].copy_from_slice(&left[row * side * 3..(row + 1) * side * 3]);
        let second = into + (side + GAP) * 3;
        out[second..second + side * 3]
            .copy_from_slice(&right[row * side * 3..(row + 1) * side * 3]);
    }
    out
}

/// A ring at the footprint the correction reaches to, drawn over the frame it was measured from.
///
/// Two pixels wide and magenta, which is the one hue a photograph of rock or sky does not offer, so
/// the mark is never mistaken for the thing it is pointing at.
fn circle(data: &mut [u8], width: usize, centre: (f32, f32), radius: f32) {
    if width == 0 {
        return;
    }
    let height = data.len() / (width * 3);
    for y in 0..height {
        for x in 0..width {
            let away = ((x as f32 - centre.0).powi(2) + (y as f32 - centre.1).powi(2)).sqrt();
            if (away - radius).abs() < 1.5 {
                let at = (y * width + x) * 3;
                data[at..at + 3].copy_from_slice(&[255, 0, 220]);
            }
        }
    }
}

/// Lossless, because the whole point of the pair is a correction that moves a few hundred pixels by
/// a few percent, and a quantizer that smoothed them would be answering a different question.
fn write(path: &str, image: rawshim::rgb::RgbRef<'_>) {
    rawshim::avif::encode_rendition(
        std::borrow::Cow::Borrowed(image.data),
        image.width,
        image.height,
        0,
        10,
        true,
        path,
    )
    .expect("the pair encodes");
}
