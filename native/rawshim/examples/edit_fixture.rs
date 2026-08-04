//! Writes the parity fixture the GPU tick is checked against.
//!
//! The client runs a second implementation of the grade (`docs/raw-edit-gpu.md` §6.3), and
//! a second implementation of a picture is exactly the divergence DESIGN §21.1 exists to
//! prevent. So the shaders are held to this: the same prepared samples, the same settings,
//! and the frame the CPU produces from them, stage by stage.
//!
//! Synthetic rather than a real RAW on purpose. The open path is the same code either way,
//! and a fixture that decodes a 25MB file cannot live in the repo or run in a second.
//!
//! cargo run --release --example edit_fixture -- <out-dir>

use rawshim::hdr::{self, Prepared};
use rawshim::hdr_fit::HdrColour;
use rawshim::image::{self, Strengths};
use rawshim::tone;

const WIDTH: usize = 96;
const HEIGHT: usize = 64;

/// A frame with something for every stage to find: a gradient for the tone curve, a hard
/// edge for the guided filters and the deconvolution, a saturated patch for the chroma
/// map, and per-pixel jitter for the denoise to have noise to measure.
fn scene() -> Vec<u16> {
    let mut samples = vec![0u16; WIDTH * HEIGHT * 3];
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let at = (y * WIDTH + x) * 3;
            // Deterministic jitter, so the fixture is reproducible without a seed crate.
            let noise = (((x * 7919 + y * 104729) % 211) as f64 / 211.0 - 0.5) * 900.0;
            let ramp = (x as f64 / WIDTH as f64) * 42000.0 + 1200.0;
            let edge = match x > WIDTH / 2 {
                true => 9000.0,
                false => 0.0,
            };
            let patch = y > HEIGHT * 3 / 4 && x < WIDTH / 4;
            let (r, g, b) = match patch {
                true => (ramp + edge + 12000.0, ramp * 0.35, ramp * 0.2),
                false => (ramp + edge, ramp + edge * 0.9, ramp + edge * 0.8),
            };
            let clamp = |v: f64| v.clamp(0.0, 65535.0) as u16;
            samples[at] = clamp(r + noise);
            samples[at + 1] = clamp(g + noise * 0.8);
            samples[at + 2] = clamp(b + noise * 1.1);
        }
    }
    samples
}

fn main() {
    let out = std::env::args().nth(1).unwrap_or_else(|| ".".to_string());
    let grade = hdr::Grade { peak_nits: 1000.0, reference_white_nits: 203.0, white_quantile: 0.995 };
    let strengths = Strengths { luma: 1.0, chroma: 1.0, sharpen: 1.0, defringe: 1.0 };
    let samples = scene();
    let levels = tone::levels(&samples, grade.white_quantile);

    // Both arms, because they are different code on both sides: a file whose fit declined
    // grades one shared curve, and a file whose fit landed grades three and a matrix.
    for (name, colour) in [("neutral", None), ("matched", Some(HdrColour::identity()))] {
        for ev in [0.0f32, 1.0, -1.5] {
            let prepared = Prepared {
                samples: samples.clone(),
                width: WIDTH,
                height: HEIGHT,
                levels,
            };
            // Filtered once, in the perceptual domain the open uses, so the fixture's
            // input is the frame the client is actually handed.
            let mut prepared = prepared;
            filter_once(&mut prepared, &grade, strengths);
            let expected = run(&prepared, colour.as_ref(), &grade, ev);

            let header = serde_json::json!({
                "width": WIDTH,
                "height": HEIGHT,
                "white": levels.white,
                "peak": levels.peak,
                "ev": ev,
                "grade": grade,
                "strengths": strengths,
                "matched": colour.is_some(),
                "colour": colour.as_ref().map(describe),
            });

            let stem = format!("{out}/tick-{name}-ev{ev}");
            std::fs::write(format!("{stem}.json"), header.to_string()).expect("header");
            std::fs::write(format!("{stem}.input.bin"), le(&prepared.samples)).expect("input");
            std::fs::write(format!("{stem}.expected.bin"), le(&expected)).expect("expected");
            println!("{stem}");
        }
    }
}

/// Exactly `wasm::Editor::grade_from` without the copy and the emit: what the shaders owe.
fn run(prepared: &Prepared, colour: Option<&HdrColour>, grade: &hdr::Grade, ev: f32) -> Vec<u16> {
    let mut working = prepared.samples.clone();
    hdr::grade_prepared(&mut working, grade, colour, prepared.levels, 2f64.powf(f64::from(ev)));
    tone::encode_pq(&mut working, grade.peak_nits);
    working
}

/// `edit::filter_once`, which is private to that module: the frame into PQ against its own
/// diffuse white, filtered, and back to scene-linear.
fn filter_once(prepared: &mut Prepared, grade: &hdr::Grade, strengths: Strengths) {
    let scale = grade.reference_white_nits / prepared.levels.white.max(1.0);
    let mut perceptual: Vec<f32> =
        prepared.samples.iter().map(|s| tone::pq(f64::from(*s) * scale) as f32).collect();
    let (sigma, defocus) =
        image::measurements(&perceptual, prepared.width, prepared.height, strengths);
    image::finish_with(&mut perceptual, prepared.width, prepared.height, strengths, sigma, defocus);
    for (sample, filtered) in prepared.samples.iter_mut().zip(perceptual.iter()) {
        let nits = tone::pq_inv_for_testing(f64::from(*filtered));
        *sample = (nits / scale).clamp(0.0, 65535.0).round() as u16;
    }
}

fn describe(colour: &HdrColour) -> serde_json::Value {
    let curve = |c: usize| colour.curves[c].iter().map(|v| *v as f32).collect::<Vec<f32>>();
    let shape = colour.chroma.as_ref().map(|m| m.shape());
    serde_json::json!({
        "curves": [curve(0), curve(1), curve(2)],
        "matrix": colour.matrix,
        "saturation": colour.saturation,
        "trustCeiling": rawshim::hdr_fit::TRUST_CEILING,
        "chroma": colour.chroma.as_ref().zip(shape).map(|(map, shape)| serde_json::json!({
            "nodes": map.nodes_flat(),
            "chromaCount": shape.chroma_count,
            "levelCount": shape.level_count,
            "chromaLow": shape.chroma_low,
            "chromaScale": shape.chroma_scale,
            "levelScale": shape.level_scale,
        })),
    })
}

fn le(samples: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}
