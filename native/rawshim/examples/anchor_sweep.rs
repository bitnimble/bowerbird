//! What anchoring on the body's own white costs or buys, frame by frame, as the fit's own deltaE.
//!
//! ```text
//! anchor_sweep <raw>...
//! ```
//!
//! **The camera match is the judge, and it is not a circular one.** The match fits the body's tone,
//! matrix and chroma against the body's own rendering, and reports the deltaE it could not remove.
//! The anchor is upstream of all three: it decides the domain the curves are fitted over, so an
//! anchor several stops from where the body put white leaves the curve absorbing the difference
//! instead of describing the body's shape. If reading the anchor off the body lowers that residual
//! across a library, the curve had been spending itself on the anchor; if it raises it, the
//! quantile was nearer the truth than the preview's ranks are.
//!
//! Both arms run in one process against one decode, so nothing between them differs - not the
//! denoise, not the defringe, not the adapter, not the build.

use rawshim::galosh::{Detail, Fit};

/// How much of the curve's shadow range is spent before it has climbed anywhere: its output at a
/// near-black input, over its output at the top of the toe.
///
/// **A pedestal is what a lifted black looks like in the model.** The curve maps our level to the
/// body's, and every body puts zero at zero, so a curve that already answers a large share of its
/// toe at an input of a thousandth is saying near-black renders as grey. Measured that way the
/// church interior reads 0.55 where a healthy frame reads a few hundredths, and the difference is
/// visible as flat milky shadows with no separation in them.
fn toe(gpu: &'static rawshim::gpu::Gpu, matched: &rawshim::hdr_fit::HdrMatch) -> f64 {
    let colour = matched.colour.as_ref().expect("colour");
    let bins: Vec<[f32; 4]> = [1.0f64, 15.0]
        .iter()
        .map(|at| {
            let x = (colour.ceiling * at / 255.0) as f32;
            [x, x, x, 0.0]
        })
        .collect();
    let Some(read) = pollster::block_on(rawshim::hdr_fit::evaluated(
        gpu,
        colour,
        &bins,
        rawshim::hdr_fit::Stage::Tone,
    )) else {
        return f64::NAN;
    };
    f64::from(read[0][1]) / f64::from(read[1][1]).max(1e-9)
}

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    assert!(!paths.is_empty(), "anchor_sweep <raw>...");
    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");

    println!(
        "{:<16} {:>8} {:>8} {:>7} {:>8} {:>8} {:>7} {:>7} {:>7} {:>7}",
        "frame", "whiteQ", "whiteB", "stops", "deltaEQ", "deltaEB", "better", "toe", "peak/w",
        "noise/bin",
    );
    let mut deltas: Vec<f64> = Vec::new();
    let mut moved: Vec<f64> = Vec::new();
    let mut toes: Vec<f64> = Vec::new();
    for path in &paths {
        let name = std::path::Path::new(path)
            .file_name()
            .map_or_else(String::new, |s| s.to_string_lossy().into_owned());
        let Some(frame) = rawshim::decode_frame_denoised(path, 0, Detail::at(0.0, 0.0), Fit::Only)
        else {
            println!("{name:<16} would not decode");
            continue;
        };
        let Some(resident) = frame.on_device(gpu) else {
            println!("{name:<16} would not upload");
            continue;
        };

        let fitted = |body: bool| {
            rawshim::tone::use_body_anchor(body);
            rawshim::fit_hdr_measured(&resident, path, 0.9, rawshim::hdr_fit::CameraMatch::LensAndColour).map(|(matched, levels)| {
                (
                    matched.colour.as_ref().expect("colour").delta_e,
                    levels.white.raw(),
                    toe(gpu, &matched),
                    levels.peak.raw() / levels.white.raw().max(1.0),
                    matched.colour.as_ref().expect("colour").ceiling,
                )
            })
        };
        let (configured, body) = (fitted(false), fitted(true));
        rawshim::tone::use_body_anchor(false);

        let (Some((delta_q, white_q, toe_q, over, ceiling)), Some((delta_b, white_b, ..))) =
            (configured, body)
        else {
            println!("{name:<16} no match on one arm or both");
            continue;
        };
        // **A bin narrower than the frame's own noise cannot rank a pixel.** The curve's domain is
        // `ceiling` multiples of white over 256 bins, so a bin is that wide in the units the mosaic
        // was conditioned into - and where the read noise is wider, which bin a dark pixel lands in
        // is decided by the noise rather than by the light. Every bin under that then returns the
        // same population mean, which is a flat toe and a lifted black.
        let noise = frame.noise.map(|fit| f64::from(fit.sigma_sq).max(0.0).sqrt());
        let bin = ceiling * (white_q / f64::from(u16::MAX)) / 256.0;
        let ratio = noise.map_or(f64::NAN, |sigma| sigma / bin.max(1e-12));

        println!(
            "{name:<16} {white_q:>8.0} {white_b:>8.0} {:>7.2} {delta_q:>8.2} {delta_b:>8.2} {:>7} \
             {toe_q:>7.3} {over:>7.2} {ratio:>7.2}",
            (white_b / white_q).log2(),
            match delta_b < delta_q {
                true => "body",
                false => "quantile",
            },
        );
        deltas.push(delta_b - delta_q);
        moved.push((white_b / white_q).log2());
        toes.push(toe_q);
    }

    let summarise = |what: &str, mut of: Vec<f64>| {
        if of.is_empty() {
            return;
        }
        of.sort_by(f64::total_cmp);
        let at = |q: f64| of[((of.len() - 1) as f64 * q).round() as usize];
        let mean: f64 = of.iter().sum::<f64>() / of.len() as f64;
        println!(
            "{what}: {} frames, mean {mean:+.3}, median {:+.3}, quartiles {:+.3} / {:+.3}, \
             range {:+.3} to {:+.3}",
            of.len(),
            at(0.5),
            at(0.25),
            at(0.75),
            of[0],
            of[of.len() - 1],
        );
    };
    println!();
    let wins = deltas.iter().filter(|d| **d < 0.0).count();
    println!("the body's anchor lowers the residual on {wins} of {} frames", deltas.len());
    summarise("deltaE, body minus quantile", deltas);
    summarise("anchor moved, in stops", moved);
    summarise("the curve's pedestal, at the configured anchor", toes);
}
