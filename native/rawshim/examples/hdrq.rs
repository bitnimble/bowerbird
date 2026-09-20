//! What actually limits an HDR still, once the quantizer is not the answer.
//!
//! ```text
//! hdrq <raw> [edge]
//! ```
//!
//! Three questions, one render each:
//!
//! - how much of the code range each transfer's picture occupies, which is what makes one
//!   libaom quantizer mean two different pictures on the two paths;
//! - what the quantizer buys on each;
//! - what 4:2:0 costs at a quantizer low enough that nothing else is in the way.

use rawshim::avif;
use rawshim::hdr::{self, Source};
use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::image::Strengths;
use rawshim::light::{DisplayNits, Gain, Light};

/// The library's shipped grade.
fn grade(peak: Light<DisplayNits>) -> hdr::Grade {
    hdr::Grade {
        peak_nits: peak,
        reference_white_nits: Light::exactly(203.0),
        white_quantile: 0.9,
    }
}

fn options(edge: usize, peak: Light<DisplayNits>) -> EncodeOptions {
    EncodeOptions {
        still_chroma: Chroma::Yuv420,
        output_path: String::new(),
        grade: grade(peak),
        crf: 10,
        preset: 8,
        strengths: Strengths { sharpen: 1.0, defringe: 1.0 },
        sharpen_sigma: None,
        max_edge: edge as f64,
    }
}

/// Where the picture's code values actually sit, as fractions of the container.
fn span(values: &[u16], full: f64) -> String {
    let mut sorted: Vec<u16> = values.to_vec();
    sorted.sort_unstable();
    let at = |q: f64| f64::from(sorted[((sorted.len() - 1) as f64 * q) as usize]) / full;
    format!(
        "p0.1 {:.3}  p1 {:.3}  p50 {:.3}  p99 {:.3}  p99.9 {:.3}  used {:.3}",
        at(0.001),
        at(0.01),
        at(0.5),
        at(0.99),
        at(0.999),
        at(0.999) - at(0.001),
    )
}

fn mean_abs(a: &[u8], b: &[u8]) -> (f64, u8) {
    let mut sum = 0u64;
    let mut worst = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        let d = x.abs_diff(*y);
        sum += u64::from(d);
        worst = worst.max(d);
    }
    (sum as f64 / a.len() as f64, worst)
}

/// The one domain the two paths can be compared in: absolute light, coded by the curve built to
/// be perceptually uniform over it.
///
/// A code value means a different amount of light on each path - PQ's 255 readback levels span
/// 10000 nits where sRGB's span diffuse white - so an error measured in each path's own codes
/// says nothing about which picture looks worse. Both sides are taken to nits and back through
/// ST 2084, and the error is reported in 10-bit PQ steps, which are JNDs to within the curve's
/// own design tolerance.
fn sdr_to_pq(code: u16, full: f64) -> f64 {
    let v = f64::from(code) / full;
    let linear = match v <= 0.04045 {
        true => v / 12.92,
        false => ((v + 0.055) / 1.055).powf(2.4),
    };
    // An SDR file's 1.0 is diffuse white, which is where its codes land on the absolute curve.
    rawshim::tone::pq(
        Light::<DisplayNits>::exactly(203.0) * Gain::of_ratio(linear),
    )
    .raw()
}

/// The blacks a comparison is run at, in nits, below which it treats the picture as one level.
///
/// **A sweep rather than a constant, because the answer has to survive it.** PQ carries a
/// dark-adapted observer's JNDs all the way to zero, so it expands enormously down there: one
/// sRGB code step off black is 0.06 nits, which is some 60 PQ steps. Left unfloored, a dark
/// frame's shadows dominate the sum and the SDR column reports its own 8-bit quantization at
/// every quantizer. Two renditions of one photograph do not have the same black point either -
/// the PQ render bottoms out near 2 nits where the sRGB one reaches a tenth of that - so a floor
/// that binds one and not the other is comparing exposures. A crossing that moves as this rises
/// is measuring the shadows; one that settles is measuring the encoder.
const BLACK_NITS: [f64; 5] = [0.1, 0.5, 1.0, 2.0, 5.0];

/// The SDR quantizer whose quality the HDR one is being asked to match.
const TARGET_SDR: i32 = 10;

fn rmse_in_pq(a: &[u16], b: &[u16], full: f64, sdr: bool, black: f64) -> f64 {
    let floor =
        rawshim::tone::pq(Light::<DisplayNits>::measured(black)).raw();
    let signal = |c: u16| {
        match sdr {
            true => sdr_to_pq(c, full),
            false => f64::from(c) / full,
        }
        .max(floor)
    };
    let sum: f64 =
        a.iter().zip(b.iter()).map(|(x, y)| (signal(*x) - signal(*y)).powi(2)).sum();
    (sum / a.len() as f64).sqrt() * 1023.0
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("a raw path");
    let edge: usize = args.next().map_or(3840, |e| e.parse().expect("a number"));
    let luma: f64 = args.next().map_or(20.0, |v| v.parse().expect("a number"));
    let colour: f64 = args.next().map_or(30.0, |v| v.parse().expect("a number"));

    // The document's shipped defaults, so this is the picture the library actually writes.
    let detail = rawshim::galosh::Detail::at(luma, colour);
    let frame = rawshim::decode_frame_denoised(&path, 0, detail, Default::default())
        .expect("decode");
    let samples = frame.samples16().expect("16-bit").to_vec();
    let source = Source { samples: &samples, width: frame.width, height: frame.height };
    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    let resident = frame.on_device(gpu).expect("the frame reaches the device");
    let matched = rawshim::fit_hdr_for(&resident, &path, 0.9);

    // `job::peak_nits`: an SDR target rolls into diffuse white where an HDR one rolls into the
    // display peak, which is the whole of what a rendition's dynamic range reaches.
    let nits = Light::exactly;
    let (pq, w, h) = hdr::graded_as(
        &source,
        &options(edge, nits(1000.0)),
        matched.as_ref(),
        rawshim::gpu::Output::Pq,
    );
    let (srgb, _, _) = hdr::graded_as(
        &source,
        &options(edge, nits(203.0)),
        matched.as_ref(),
        rawshim::gpu::Output::Srgb,
    );
    let srgb8: Vec<u8> = srgb.iter().map(|v| *v as u8).collect();

    println!("{w}x{h}");
    println!("  pq   {}", span(&pq, 65535.0));
    println!("  srgb {}", span(&srgb, 255.0));

    let (primaries, transfer, matrix) = rawshim::hdr_args::cicp();
    let still = |q: i32, chroma: Chroma| {
        avif::encode_still(
            std::borrow::Cow::Borrowed(&pq),
            w,
            h,
            &avif::StillOptions {
                cicp: avif::Cicp { primaries, transfer, matrix },
                format: chroma.avif_format(),
                quantizer: q,
                speed: 8,
            },
        )
        .expect("the still")
    };

    // **Each path against its own uncompressed frame, never against the other's.** The two are
    // different pictures - one rolls into the display peak where the other rolls into diffuse
    // white - so the only thing they can be held to is the distortion each encode adds.
    //
    // The HDR side is read back at 16 bits. At 8 the readback is the floor: a step of a PQ signal
    // there is four of the ten the file carries, which is more error than any shipping quantizer
    // introduces, so every HDR row would report the same number and it would be this harness's.
    let srgb16: Vec<u16> = srgb8.iter().map(|v| u16::from(*v)).collect();

    const QUANTIZERS: [i32; 15] = [0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 13, 16, 20, 26, 32];
    let mut hdr_scores: Vec<Vec<f64>> = Vec::new();
    let mut sdr_scores: Vec<Vec<f64>> = Vec::new();
    let mut sizes: Vec<(f64, f64)> = Vec::new();
    for q in QUANTIZERS {
        let hdr_bytes = still(q, Chroma::Yuv420);
        let sdr_bytes = avif::encode_rgb8(std::borrow::Cow::Borrowed(&srgb8), w, h, q, 10, false)
            .expect("the rendition");
        let (hdr_back, _, _) = avif::decode_at(&hdr_bytes, 16).expect("the still decodes");
        let (sdr_back, _, _) = avif::decode_at(&sdr_bytes, 8).expect("the rendition decodes");
        hdr_scores
            .push(BLACK_NITS.iter().map(|b| rmse_in_pq(&pq, &hdr_back, 65535.0, false, *b)).collect());
        sdr_scores
            .push(BLACK_NITS.iter().map(|b| rmse_in_pq(&srgb16, &sdr_back, 255.0, true, *b)).collect());
        sizes.push((hdr_bytes.len() as f64 / 1024.0, sdr_bytes.len() as f64 / 1024.0));
    }

    println!("\nsize and distortion by quantizer, 4:2:0 as shipped, black at {} nits", BLACK_NITS[0]);
    println!("       hdr                             sdr");
    for (i, q) in QUANTIZERS.iter().enumerate() {
        println!(
            "  q {q:2}  {:8.1} kB  pq {:5.2}       {:8.1} kB  pq {:5.2}",
            sizes[i].0, hdr_scores[i][0], sizes[i].1, sdr_scores[i][0],
        );
    }

    // **The crossing, swept over the black it is measured against.** Two renditions of one
    // photograph are two pictures rather than one picture twice, so a crossing between their
    // columns is only the encoder's if it survives the shadows, where the two differ most and
    // the metric is most sensitive. Settling as the floor rises is what says it has.
    println!("\nthe hdr quantizer matching sdr q{TARGET_SDR}, by the black it is measured against");
    for (b, black) in BLACK_NITS.iter().enumerate() {
        let row = QUANTIZERS.iter().position(|q| *q == TARGET_SDR).expect("the target");
        let target = sdr_scores[row][b];
        let (i, _) = hdr_scores
            .iter()
            .enumerate()
            .min_by(|(_, x), (_, y)| (x[b] - target).abs().total_cmp(&(y[b] - target).abs()))
            .expect("a quantizer");
        println!(
            "  black {black:>4} nits   sdr q{TARGET_SDR} is {target:5.2}   nearest hdr is q{:<3} at {:5.2}  ({:.0} kB)",
            QUANTIZERS[i], hdr_scores[i][b], sizes[i].0,
        );
    }

    // **The control the two columns above are not.** They encode different pictures - one rolls
    // into the display peak where the other rolls into diffuse white, and their black points are
    // a factor of sixteen apart in nits - measured with a metric that is at its most sensitive
    // near black. So a difference between them is not attributable to the container.
    //
    // This is: one picture, the SDR render, encoded both ways against one reference. If a PQ
    // container really bought accuracy per byte, sending every SDR photograph through it would
    // be free quality, and it is the shape of that claim that says to test it directly.
    let sdr_as_pq: Vec<u16> = srgb8
        .iter()
        .map(|c| (sdr_to_pq(u16::from(*c), 255.0) * 65535.0).round() as u16)
        .collect();
    println!("\none picture both ways: the SDR render, against one reference");
    println!("       as pq, 10-bit                   as srgb, 8-bit");
    for q in [0, 4, 8, 13, 20] {
        let as_pq = avif::encode_still(
            std::borrow::Cow::Borrowed(&sdr_as_pq),
            w,
            h,
            &avif::StillOptions {
                cicp: avif::Cicp { primaries, transfer, matrix },
                format: Chroma::Yuv420.avif_format(),
                quantizer: q,
                speed: 8,
            },
        )
        .expect("the still");
        let as_srgb = avif::encode_rgb8(std::borrow::Cow::Borrowed(&srgb8), w, h, q, 10, false)
            .expect("the rendition");
        let (pq_back, _, _) = avif::decode_at(&as_pq, 16).expect("the still decodes");
        let (srgb_back, _, _) = avif::decode_at(&as_srgb, 8).expect("the rendition decodes");
        println!(
            "  q {q:2}  {:8.1} kB  pq {:5.2}       {:8.1} kB  pq {:5.2}",
            as_pq.len() as f64 / 1024.0,
            rmse_in_pq(&sdr_as_pq, &pq_back, 65535.0, false, BLACK_NITS[0]),
            as_srgb.len() as f64 / 1024.0,
            rmse_in_pq(&srgb16, &srgb_back, 255.0, true, BLACK_NITS[0]),
        );
    }

    println!("\nwhat 4:2:0 costs at q0, where the quantizer is not in the way");
    let sub = still(0, Chroma::Yuv420);
    let full = still(0, Chroma::Yuv444);
    println!("  4:2:0 {:.1} kB    4:4:4 {:.1} kB", sub.len() as f64 / 1024.0, full.len() as f64 / 1024.0);
    let a = avif::decode(&sub).expect("the 4:2:0 decode");
    let b = avif::decode(&full).expect("the 4:4:4 decode");
    let (mean, worst) = mean_abs(&a.data, &b.data);
    println!("  4:2:0 against 4:4:4, both at q0: mean {mean:.3} of 255, worst {worst}");
}
