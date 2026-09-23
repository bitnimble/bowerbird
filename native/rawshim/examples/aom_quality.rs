//! What each libaom quantizer buys, as the renditions encode it: bytes, time, SSIM and PQ error.
//!
//! ```text
//! aom_quality <raw>...
//! ```
//!
//! Prints one tab-separated row per frame, path and quantizer, for comparing two encoders on the
//! same pictures: the quality anchors (`processing/analysis/quality.ts`) name quantizers, so an
//! encoder that moves has to be held against the one they were measured on.
//!
//! The paths are the shipped ones: HDR is a 12-bit PQ still at speed 8 and 3840, SDR an 8-bit
//! rendition at speed 10, at 3840 and at the grid's 800. All 4:2:0 unless `AOMQ_444`;
//! `AOMQ_SPEED` moves the still's speed and `AOMQ_HDR_ONLY` skips SDR. The last rows are a smooth
//! synthetic sky, the case the HDR anchors were set against banding in.

use std::borrow::Cow;
use std::time::Instant;

use rawshim::avif;
use rawshim::hdr::{self, Source};
use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::image::Strengths;
use rawshim::light::{DisplayNits, Gain, Light};

const HDR_QUANTIZERS: [i32; 10] = [0, 1, 2, 3, 4, 5, 6, 8, 10, 13];
const SDR_QUANTIZERS: [i32; 11] = [4, 6, 8, 10, 13, 16, 20, 24, 28, 32, 40];
const HDR_SPEED: i32 = 8;
const SDR_SPEED: i32 = 10;

fn options(edge: usize, peak: Light<DisplayNits>) -> EncodeOptions {
    EncodeOptions {
        still_chroma: Chroma::Yuv420,
        output_path: String::new(),
        grade: hdr::Grade {
            peak_nits: peak,
            reference_white_nits: Light::exactly(203.0),
            white_quantile: 0.9,
        },
        crf: 3,
        preset: HDR_SPEED,
        strengths: Strengths { sharpen: 1.0, defringe: 1.0 },
        sharpen_sigma: None,
        max_edge: edge as f64,
    }
}

/// Luma of interleaved RGB, each sample over `full`: BT.2020's weights for PQ, BT.601's for sRGB,
/// on the coded values, as the encoder's own Y' plane has it.
fn luma<T: Copy + Into<f64>>(rgb: &[T], full: f64, weights: [f64; 3]) -> Vec<f64> {
    rgb.chunks_exact(3)
        .map(|p| (weights[0] * p[0].into() + weights[1] * p[1].into() + weights[2] * p[2].into()) / full)
        .collect()
}

/// Mean SSIM over 8x8 windows at a stride of 4, as ffmpeg's `ssim` filter takes it.
fn ssim(a: &[f64], b: &[f64], width: usize, height: usize) -> f64 {
    const C1: f64 = 0.01 * 0.01;
    const C2: f64 = 0.03 * 0.03;
    let (mut sum, mut count) = (0.0, 0usize);
    for y in (0..height.saturating_sub(7)).step_by(4) {
        for x in (0..width.saturating_sub(7)).step_by(4) {
            let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for dy in 0..8 {
                let row = (y + dy) * width + x;
                for i in row..row + 8 {
                    sa += a[i];
                    sb += b[i];
                    saa += a[i] * a[i];
                    sbb += b[i] * b[i];
                    sab += a[i] * b[i];
                }
            }
            let (ma, mb) = (sa / 64.0, sb / 64.0);
            let va = saa / 64.0 - ma * ma;
            let vb = sbb / 64.0 - mb * mb;
            let cov = sab / 64.0 - ma * mb;
            sum += ((2.0 * ma * mb + C1) * (2.0 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
            count += 1;
        }
    }
    sum / count as f64
}

/// RMS error in 10-bit PQ steps, with everything below half a nit taken as one level (`hdrq`).
fn rmse_in_pq(a: &[u16], b: &[u16]) -> f64 {
    let floor = rawshim::tone::pq(Light::<DisplayNits>::measured(0.5)).raw();
    let signal = |c: u16| (f64::from(c) / 65535.0).max(floor);
    let sum: f64 = a.iter().zip(b).map(|(x, y)| (signal(*x) - signal(*y)).powi(2)).sum();
    (sum / a.len() as f64).sqrt() * 1023.0
}

/// The 99.9th percentile of each pixel's worst channel error, in 10-bit PQ steps: 4:2:0's speckle
/// is a few pixels far off, which a mean hides.
fn speckle(a: &[u16], b: &[u16]) -> f64 {
    let mut worst: Vec<u16> = a
        .chunks_exact(3)
        .zip(b.chunks_exact(3))
        .map(|(x, y)| (0..3).map(|c| x[c].abs_diff(y[c])).max().expect("3 channels"))
        .collect();
    let at = worst.len() * 999 / 1000;
    let (_, p, _) = worst.select_nth_unstable(at);
    f64::from(*p) / 65535.0 * 1023.0
}

fn still(pq: &[u16], w: usize, h: usize, q: i32) -> (Vec<u8>, f64) {
    let (primaries, transfer, matrix) = rawshim::hdr_args::cicp();
    let started = Instant::now();
    let bytes = avif::encode_still(
        Cow::Borrowed(pq),
        w,
        h,
        &avif::StillOptions {
            cicp: avif::Cicp { primaries, transfer, matrix },
            format: match std::env::var("AOMQ_444") {
                Ok(_) => Chroma::Yuv444.avif_format(),
                Err(_) => Chroma::Yuv420.avif_format(),
            },
            quantizer: q,
            speed: std::env::var("AOMQ_SPEED").map_or(HDR_SPEED, |s| s.parse().expect("a speed")),
        },
    )
    .expect("the still");
    (bytes, started.elapsed().as_secs_f64() * 1000.0)
}

fn hdr_rows(name: &str, pq: &[u16], w: usize, h: usize) {
    let reference = luma(pq, 65535.0, [0.2627, 0.6780, 0.0593]);
    for q in HDR_QUANTIZERS {
        let (bytes, ms) = still(pq, w, h, q);
        let (back, _, _) = avif::decode_at(&bytes, 16).expect("the still decodes");
        let score = ssim(&reference, &luma(&back, 65535.0, [0.2627, 0.6780, 0.0593]), w, h);
        println!(
            "{name}\thdr\t{q}\t{:.1}\t{ms:.0}\t{score:.5}\t{:.3}\t{:.2}",
            bytes.len() as f64 / 1024.0,
            rmse_in_pq(pq, &back),
            speckle(pq, &back),
        );
    }
}

fn sdr_rows(name: &str, path: &str, srgb: &[u8], w: usize, h: usize) {
    let reference = luma(srgb, 255.0, [0.299, 0.587, 0.114]);
    for q in SDR_QUANTIZERS {
        let started = Instant::now();
        let bytes = avif::encode_rgb8(Cow::Borrowed(srgb), w, h, q, SDR_SPEED, false).expect("the rendition");
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        let (back, _, _) = avif::decode_at(&bytes, 8).expect("the rendition decodes");
        let score = ssim(&reference, &luma(&back, 255.0, [0.299, 0.587, 0.114]), w, h);
        println!("{name}\t{path}\t{q}\t{:.1}\t{ms:.0}\t{score:.5}\t", bytes.len() as f64 / 1024.0);
    }
}

/// A clear sky at 3840x2160: 150 nits at the top to 400 at the horizon, with a slow lateral swell,
/// and how many of the source's distinct 12-bit levels down its middle column survive each encode.
fn sky() {
    let (w, h) = (3840usize, 2160usize);
    let mut pq = vec![0u16; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let t = y as f64 / (h - 1) as f64;
            let swell = 1.0 + 0.05 * (x as f64 / w as f64 * std::f64::consts::PI).sin();
            let nits = (150.0 + 250.0 * t) * swell;
            let tint = [0.80, 0.92, 1.0];
            for (c, gain) in tint.iter().enumerate() {
                let code = rawshim::tone::pq(Light::<DisplayNits>::measured(nits) * Gain::of_ratio(*gain)).raw();
                pq[(y * w + x) * 3 + c] = (code * 65535.0).round() as u16;
            }
        }
    }
    let column = |frame: &[u16]| -> usize {
        let mut levels: Vec<u16> = (0..h).map(|y| (frame[(y * w + w / 2) * 3 + 1] + 8) >> 4).collect();
        levels.dedup();
        levels.len()
    };
    let source = column(&pq);
    for q in HDR_QUANTIZERS {
        let (bytes, ms) = still(&pq, w, h, q);
        let (back, _, _) = avif::decode_at(&bytes, 16).expect("the sky decodes");
        println!(
            "sky\tbanding\t{q}\t{:.1}\t{ms:.0}\t{}/{source}\t{:.3}",
            bytes.len() as f64 / 1024.0,
            column(&back),
            rmse_in_pq(&pq, &back),
        );
    }
}

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    println!("frame\tpath\tq\tkB\tms\tssim\tpq_rmse\tspeckle");
    for path in &paths {
        let name = std::path::Path::new(path).file_stem().expect("a name").to_string_lossy().to_string();
        let detail = rawshim::galosh::Detail::at(20.0, 30.0);
        let frame = rawshim::decode_frame_denoised(path, 0, detail, Default::default()).expect("decode");
        let samples = frame.samples16().expect("16-bit").to_vec();
        let source = Source { samples: &samples, width: frame.width, height: frame.height };
        let resident = frame.on_device(gpu).expect("the frame reaches the device");
        let matched = rawshim::fit_hdr_for(&resident, path, 0.9);

        let (pq, w, h) =
            hdr::graded_as(&source, &options(3840, Light::exactly(1000.0)), matched.as_ref(), rawshim::gpu::Output::Pq);
        hdr_rows(&name, &pq, w, h);
        if std::env::var("AOMQ_HDR_ONLY").is_ok() {
            continue;
        }
        for (edge, label) in [(3840, "sdr3840"), (800, "sdr800")] {
            let (srgb, w, h) =
                hdr::graded_as(&source, &options(edge, Light::exactly(203.0)), matched.as_ref(), rawshim::gpu::Output::Srgb);
            let srgb8: Vec<u8> = srgb.iter().map(|v| *v as u8).collect();
            sdr_rows(&name, label, &srgb8, w, h);
        }
    }
    sky();
}
