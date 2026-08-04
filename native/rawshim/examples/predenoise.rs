//! Denoising before the grade instead of after it, measured and rendered.
//!
//! `image::finish` runs on display-referred PQ samples today, which is why a slider tick
//! has to re-run it: the exposure changes what it filters. Denoising the *scene-linear*
//! frame once at open would make the tick grade alone - about 16ms against 645ms on the
//! GPU - and would let a rendition reuse the same denoised base for every size it cuts.
//!
//! The question is whether it looks the same, and it cannot be answered by argument.
//! `image.rs` is explicit that the transfer is a constraint on the caller, because a
//! difference taken in linear light is proportional to absolute luminance and so treats a
//! highlight and a shadow completely differently. This renders both and says how far apart
//! they are, per brightness band, and writes the two frames out to be looked at.
//!
//! cargo run --release --example predenoise -- <raw> [out-dir] [ev]

use rawshim::hdr::{self, Prepared};
use rawshim::image::{self, Strengths};
use rawshim::tone;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: predenoise <raw> [out-dir] [ev]");
    let out = args.next().unwrap_or_else(|| ".".to_string());
    let ev: f32 = args.next().map_or(0.0, |v| v.parse().expect("ev"));

    let grade = hdr::Grade { peak_nits: 1000.0, reference_white_nits: 203.0, white_quantile: 0.995 };
    let strengths = Strengths { luma: 1.0, chroma: 1.0, sharpen: 1.0, defringe: 1.0 };
    let request = rawshim::edit::EditRequest {
        raw_file_path: path,
        long_edge: 3840,
        grade,
        strengths,
    };

    let prepared = rawshim::edit::prepare(&request).expect("the RAW should open");
    let header = &prepared.header;
    println!("{}x{}, matched {}", header.width, header.height, header.matched);

    // The match has to be rebuilt from the payload, since `prepare` hands back the frame
    // rather than the fit. Both arms then grade through exactly the same colour.
    let source = Prepared {
        samples: prepared.samples.clone(),
        width: header.width,
        height: header.height,
        levels: tone::Levels { white: header.white, peak: header.peak },
    };
    let exposure = 2f64.powf(f64::from(ev));

    let after = after_the_grade(&source, &grade, strengths, exposure);
    let arms = [
        ("linear", before_the_grade(&source, &grade, strengths, exposure)),
        ("perceptual", in_a_perceptual_domain(&source, &grade, strengths, exposure)),
    ];

    for (name, arm) in &arms {
        println!();
        println!("=== pre-denoised in {name}, against the frame that ships");
        report(&after, arm);
    }
    // "Different" does not say which is better. What is left of the grain does: the residual
    // against a one-pixel mean is what these filters exist to remove, so an arm with more of
    // it left in a band denoised that band less, and one with far less over-smoothed it.
    println!();
    let grain = |frame: &[u16]| residual(frame, header.width, header.height);
    let residuals: Vec<(&str, Vec<f32>)> = std::iter::once(("ships", grain(&after)))
        .chain(arms.iter().map(|(name, arm)| (*name, grain(arm))))
        .collect();
    println!("{:>10}  {:>12}  {:>12}  {:>12}", "band", "ships", "linear", "perceptual");
    for (name, low, high) in [("shadow", 0.0, 0.1), ("mid", 0.1, 0.9), ("highlight", 0.9, 1.001)] {
        let mean = |residual: &[f32]| {
            let (mut total, mut count) = (0.0f64, 0u64);
            for (i, r) in residual.iter().enumerate() {
                let level = f64::from(after[i * 3]) / 65535.0;
                if level >= low && level < high {
                    total += f64::from(*r);
                    count += 1;
                }
            }
            match count {
                0 => 0.0,
                _ => total / count as f64 * 65535.0,
            }
        };
        println!(
            "{name:>10}  {:>12.1}  {:>12.1}  {:>12.1}",
            mean(&residuals[0].1),
            mean(&residuals[1].1),
            mean(&residuals[2].1),
        );
    }
    write(&format!("{out}/predenoise-ships.avif"), &after, header.width, header.height);
    for (name, arm) in &arms {
        write(&format!("{out}/predenoise-{name}.avif"), arm, header.width, header.height);
    }
    println!();
    println!("wrote {out}/predenoise-ships.avif, -linear.avif, -perceptual.avif");
}

/// What ships today: grade, PQ, then filter the display-referred frame.
fn after_the_grade(source: &Prepared, grade: &hdr::Grade, strengths: Strengths, exposure: f64) -> Vec<u16> {
    let mut working = source.samples.clone();
    hdr::grade_prepared(&mut working, grade, None, source.levels, exposure);
    tone::encode_pq(&mut working, grade.peak_nits);
    image::finish(&mut working, source.width, source.height, strengths);
    working
}

/// The proposal: filter the scene-linear frame once, then grade whatever exposure asks for.
///
/// The measurements come off the linear frame here rather than a graded one, which is the
/// honest form of the idea: if the filter runs before the grade then so must everything
/// that calibrates it.
fn before_the_grade(source: &Prepared, grade: &hdr::Grade, strengths: Strengths, exposure: f64) -> Vec<u16> {
    let mut working = source.samples.clone();
    let (sigma, defocus) = image::measurements(&working, source.width, source.height, strengths);
    image::finish_with(&mut working, source.width, source.height, strengths, sigma, defocus);
    hdr::grade_prepared(&mut working, grade, None, source.levels, exposure);
    tone::encode_pq(&mut working, grade.peak_nits);
    working
}

/// The proposal, in a domain the filter can actually work in.
///
/// Linear is the wrong place to denoise, and that is a fact about the eye rather than about
/// this code: a difference of a given size means something quite different at the bottom of
/// the range than at the top. But the filter does not need the *grade's* output - it needs
/// a perceptual domain, and PQ over the scene's own levels is one that has nothing to do
/// with the exposure. So: map linear to PQ against a fixed anchor, filter there, map back,
/// and grade whatever the slider then asks for.
///
/// Exposure-independent by construction, which is the whole point: filter once at open, and
/// let every tick be the grade alone.
fn in_a_perceptual_domain(
    source: &Prepared,
    grade: &hdr::Grade,
    strengths: Strengths,
    exposure: f64,
) -> Vec<u16> {
    // The scene's own diffuse white at the library's reference, so the mapping is fixed for
    // this frame and does not move with the slider.
    let scale = grade.reference_white_nits / source.levels.white;
    let mut working: Vec<u16> = source
        .samples
        .iter()
        .map(|s| (tone::pq(f64::from(*s) * scale) * 65535.0).round() as u16)
        .collect();

    let (sigma, defocus) = image::measurements(&working, source.width, source.height, strengths);
    image::finish_with(&mut working, source.width, source.height, strengths, sigma, defocus);

    // Back to scene-linear, where the grade expects to find it.
    let mut linear: Vec<u16> = working
        .iter()
        .map(|s| {
            let nits = tone::pq_inv_for_testing(f64::from(*s) / 65535.0);
            (nits / scale).clamp(0.0, 65535.0).round() as u16
        })
        .collect();

    hdr::grade_prepared(&mut linear, grade, None, source.levels, exposure);
    tone::encode_pq(&mut linear, grade.peak_nits);
    linear
}

/// How far apart, in the counts the parity pins use, and where in the range.
fn report(after: &[u16], before: &[u16]) {
    let bands = [("shadow", 0.0, 0.1), ("mid", 0.1, 0.9), ("highlight", 0.9, 1.001)];
    println!("{:>10}  {:>8}  {:>8}  {:>10}", "band", "worst", "mean", "samples");
    for (name, low, high) in bands {
        let mut worst = 0u32;
        let mut total = 0u64;
        let mut count = 0u64;
        for (a, b) in after.iter().zip(before.iter()) {
            let level = f64::from(*a) / 65535.0;
            if level < low || level >= high {
                continue;
            }
            let delta = u32::from(a.abs_diff(*b));
            worst = worst.max(delta);
            total += u64::from(delta);
            count += 1;
        }
        let mean = match count {
            0 => 0.0,
            _ => total as f64 / count as f64,
        };
        println!("{name:>10}  {worst:>8}  {mean:>8.2}  {count:>10}");
    }
}

/// What a one-pixel mean does not explain: the grain both denoises exist to remove.
fn residual(frame: &[u16], width: usize, height: usize) -> Vec<f32> {
    let luma: Vec<f32> = (0..width * height)
        .map(|i| {
            let at = i * 3;
            (image::LUMA[0] * f32::from(frame[at])
                + image::LUMA[1] * f32::from(frame[at + 1])
                + image::LUMA[2] * f32::from(frame[at + 2]))
                / 65535.0
        })
        .collect();
    let smooth = image::box_mean_for_testing(&luma, width, height, 1);
    luma.iter().zip(smooth.iter()).map(|(l, s)| (l - s).abs()).collect()
}

fn write(path: &str, frame: &[u16], width: usize, height: usize) {
    let (primaries, transfer, matrix) = rawshim::hdr_args::cicp();
    rawshim::avif::save_still(
        std::borrow::Cow::Borrowed(frame),
        width,
        height,
        &rawshim::avif::StillOptions {
            cicp: rawshim::avif::Cicp { primaries, transfer, matrix },
            format: rawshim::hdr_args::Chroma::Yuv444.avif_format(),
            quantizer: 12,
            speed: 6,
        },
        path,
    )
    .expect("the frame should encode");
}
