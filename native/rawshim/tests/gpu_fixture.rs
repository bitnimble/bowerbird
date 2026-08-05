//! The parity fixture the GPU tick is checked against, and the check that it is still current.
//!
//! The client runs a second implementation of the grade (`docs/raw-edit-gpu.md` §6.3), and a
//! second implementation of a picture is exactly the divergence DESIGN §21.1 exists to
//! prevent. So the shaders are held to this: the same prepared samples, the same settings,
//! and the frame the CPU produces from them, stage by stage.
//!
//! **This is a test rather than an example because of what the arrangement leaves unchecked
//! otherwise.** `web/e2e/gpu_parity.spec.ts` asserts the shaders reproduce
//! `web/e2e/fixtures/gpu/*.expected.bin`, which are committed bytes; it does not assert those
//! bytes are what the CPU produces *now*. Written as an example run by hand, nothing did.
//! Change `tone::eetf`'s knee or anything in `hdr::grade_prepared`, update the Rust pins that
//! move with it, forget to regenerate, and every suite stays green while the two
//! implementations quietly disagree - the pin the whole conversion rests on comparing the
//! shaders against a CPU that no longer exists.
//!
//! So the bytes are rebuilt here and compared, in the suite that already runs on every edit.
//! Regenerate deliberately, after reading why they moved:
//!
//!   BOWERBIRD_WRITE_FIXTURES=1 cargo test --release --manifest-path native/rawshim/Cargo.toml --test gpu_fixture
//!
//! Synthetic rather than a real RAW on purpose. The open path is the same code either way,
//! and a fixture that decodes a 25MB file cannot live in the repo or run in a second.

use rawshim::hdr::{self, Prepared};
use rawshim::hdr_fit::{ChromaMap, HdrColour, TRUST_CEILING};
use rawshim::image::{self, Strengths};
use rawshim::tone;

const WIDTH: usize = 96;
const HEIGHT: usize = 64;

/// Where the browser harness fetches them from, which is what makes them a fixture at all.
fn fixture_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/e2e/fixtures/gpu")
}

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

/// A camera match with something in every part of it.
///
/// This arm used to be `HdrColour::identity()` - three copies of a straight ramp, an
/// identity matrix, saturation 1 and no chroma map at all. So the matched fixtures asked
/// the shaders for a transform that returns its input, and the three curves, the matrix,
/// the saturation and the entire chroma lattice were all no-ops the pin could not tell
/// from a correct implementation or from a missing one. Six fixtures, and the camera match
/// - which is the editor's whole reason to exist - was pinned by none of them.
///
/// Every field here is off the identity, and the lattice varies per node rather than
/// repeating one saturation, so a reader that swapped the chroma axes or mis-scaled the
/// level axis lands on the wrong node and fails.
fn matched() -> HdrColour {
    let mut colour = HdrColour::identity();
    for (channel, curve) in colour.curves.iter_mut().enumerate() {
        let gain = 1.0 + 0.06 * (channel as f64 - 1.0);
        // A shoulder, which a fitted curve has and a straight ramp does not. It is what
        // makes this fixture able to say anything about the peak: the exposure is a gain on
        // the scene, but the curve compresses what the gain produces, so the measured peak
        // rises more slowly than the slider does. A near-linear curve hides every way of
        // getting the peak's histogram wrong, because there the two rise together.
        let bend = 2.2 + 0.4 * channel as f64;
        let last = (curve.len() - 1) as f64;
        let full = 1.0 - (-bend).exp();
        for (bin, value) in curve.iter_mut().enumerate() {
            let x = bin as f64 / last;
            *value = TRUST_CEILING * gain * (1.0 - (-bend * x).exp()) / full;
        }
    }
    colour.matrix = [[0.92, 0.06, 0.02], [0.05, 0.90, 0.05], [0.01, 0.07, 0.92]];
    colour.saturation = 1.08;
    colour.chroma = Some(ChromaMap::from_nodes(|x, y, z| {
        let scale = 1.04 + 0.03 * x as f64 - 0.02 * y as f64 + 0.05 * z as f64;
        let skew = 0.02 * (x as f64 - y as f64);
        [scale, skew, -skew, scale * 0.98]
    }));
    colour
}

/// One case, as the three files the harness fetches for it.
struct Case {
    stem: String,
    header: String,
    input: Vec<u8>,
    expected: Vec<u8>,
}

fn cases() -> Vec<Case> {
    let grade = hdr::Grade { peak_nits: 1000.0, reference_white_nits: 203.0, white_quantile: 0.995 };
    let strengths = Strengths { luma: 1.0, chroma: 1.0, sharpen: 1.0, defringe: 1.0 };
    let samples = scene();
    let levels = tone::levels(&samples, grade.white_quantile);

    let mut out = Vec::new();
    // Both arms, because they are different code on both sides: a file whose fit declined
    // grades one shared curve, and a file whose fit landed grades three and a matrix.
    for (name, colour) in [("neutral", None), ("matched", Some(matched()))] {
        for ev in [0.0f32, 1.0, -1.5] {
            let mut prepared = Prepared {
                samples: samples.clone(),
                width: WIDTH,
                height: HEIGHT,
                levels,
            };
            // Filtered once, in the perceptual domain the open uses, so the fixture's
            // input is the frame the client is actually handed.
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

            out.push(Case {
                stem: format!("tick-{name}-ev{ev}"),
                header: header.to_string(),
                input: le(&prepared.samples),
                expected: le(&expected),
            });
        }
    }
    out
}

/// One tick on the CPU: the grade and the PQ encode, and nothing else. This is the answer
/// the shaders owe, which is what makes it the fixture.
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
        let nits = tone::pq_inv(f64::from(*filtered));
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

#[test]
fn the_committed_fixture_is_what_the_cpu_produces_now() {
    let dir = fixture_dir();
    let rewrite = std::env::var("BOWERBIRD_WRITE_FIXTURES").is_ok();
    if rewrite {
        std::fs::create_dir_all(&dir).expect("the fixture directory");
    }

    for case in cases() {
        let files: [(&str, Vec<u8>); 3] = [
            ("json", case.header.into_bytes()),
            ("input.bin", case.input),
            ("expected.bin", case.expected),
        ];
        for (suffix, built) in files {
            let path = dir.join(format!("{}.{suffix}", case.stem));
            if rewrite {
                std::fs::write(&path, &built).expect("writing the fixture");
                continue;
            }
            let committed = std::fs::read(&path).unwrap_or_else(|e| {
                panic!("{}: {e}. BOWERBIRD_WRITE_FIXTURES=1 writes it", path.display())
            });
            // Length first: a whole-frame diff of 36,864 bytes says nothing a reader can use,
            // where "this many bytes, this many differ, first at index n" says which stage.
            assert_eq!(
                committed.len(),
                built.len(),
                "{} is {} bytes and the CPU now produces {}",
                path.display(),
                committed.len(),
                built.len(),
            );
            let differing = committed.iter().zip(built.iter()).filter(|(a, b)| a != b).count();
            let first = committed.iter().zip(built.iter()).position(|(a, b)| a != b);
            assert_eq!(
                differing,
                0,
                "{} no longer matches the CPU: {differing} of {} bytes differ, first at {:?}. \
                 Either the grade changed and the fixture needs regenerating \
                 (BOWERBIRD_WRITE_FIXTURES=1), or it changed by accident",
                path.display(),
                committed.len(),
                first,
            );
        }
    }
}
