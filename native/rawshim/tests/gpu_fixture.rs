//! The parity fixture the GPU tick is checked against, and the check that it is still current.
//!
//! The client runs a second implementation of the grade (`docs/raw-edit-gpu.md` §6.3), and a
//! second implementation of a picture is exactly the divergence DESIGN §21.1 exists to
//! prevent. So the shaders are held to this: the same prepared samples, the same settings,
//! and the frame the CPU produces from them, stage by stage.
//!
//! **This is a test rather than an example so that the browser's fixtures cannot go stale.**
//! `web/e2e/gpu_parity.spec.ts` asserts the shaders reproduce
//! `web/e2e/fixtures/gpu/*.expected.bin`, which are committed bytes; it does not assert those
//! bytes are still what the grade produces. Written as an example run by hand, nothing did:
//! change the BT.2390 knee in `colour.wgsl` or anything else the grade shaders do, forget to
//! regenerate, and
//! every suite stays green against an answer nothing produces any more.
//!
//! So the bytes are rebuilt here and compared, in the suite that already runs on every edit.
//!
//! **On a machine with an adapter.** The three tests that check the graded answers return
//! silently where no Vulkan of any kind answers, so on such a machine the `.expected`,
//! `.rolled` and `.srgb` files are unchecked and the guarantee above is only as good as CI
//! having a GPU. The inputs and the header are CPU work and are checked everywhere.
//!
//! Regenerate deliberately, after reading why they moved:
//!
//!   BOWERBIRD_WRITE_FIXTURES=1 cargo test --release --manifest-path native/rawshim/Cargo.toml --test gpu_fixture
//!
//! Synthetic rather than a real RAW on purpose. The open path is the same code either way,
//! and a fixture that decodes a 25MB file cannot live in the repo or run in a second.

use rawshim::hdr::{self, Prepared};
use rawshim::hdr_fit::{ChromaMap, HdrColour, TRUST_CEILING};
use rawshim::image::Strengths;
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
        // The lightness gain, off 1 at every node and varying on every axis, so a reader
        // that dropped it or packed it in the wrong slot cannot answer correctly.
        //
        // Weakly on the level axis, unlike the 2x2 above. A gain that varies with level
        // makes the measured peak stop tracking the exposure - the pixel lands on a
        // different node as the slider moves - and the sweep below bounds that at 2%. The
        // level axis is pinned by the 2x2 regardless, both volumes being read at one
        // shared coordinate, so what this one is here to pin is the chroma axes. At 0.02
        // a level the peak came out 4.6% off its gain, which is the model behaving as
        // asked rather than a fault, on a variation no fit produces: measured, the gains
        // run 0.9685 to 1.0123 across a whole frame and mostly across chroma.
        let lift = 1.0 + 0.015 * (x as f64 - 2.0) - 0.01 * (y as f64 - 2.0) + 0.004 * z as f64;
        // The two luma-to-chroma terms, small and of both signs, so a reader that dropped
        // them or packed them in the wrong slot renders a tint on the neutrals rather than
        // matching. They are the only part of a node that acts at `d = 0`.
        let tint = 0.004 * (x as f64 - 2.0);
        [scale, skew, -skew, scale * 0.98, tint, -0.003 * (y as f64 - 2.0), lift,
         // The chroma-to-lightness pair, off zero at every node so a reader that dropped
         // either or packed them in the wrong slot cannot answer correctly.
         0.05 * (x as f64 - 2.0), -0.04 * (y as f64 - 2.0)]
    }));
    colour
}

/// One case, as the files the harness fetches for it.
///
/// `expected` and its two siblings are the graded answer, held as data rather than as a
/// second implementation - one sitting in the source is one a future change edits, and then
/// the two agree because somebody made them agree. `baseline` has what they check and what
/// they no longer do.
struct Case {
    stem: String,
    header: String,
    input: Vec<u8>,
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
            });
        }
    }
    out
}

/// A committed answer, as `u16`.
///
/// **These began as the CPU implementation and are now a regression baseline.** The CPU
/// grade was deleted once the shader reproduced it, which left these unregenerable by
/// design: a second implementation living in the source is one a later change edits, and
/// then the two agree because somebody made them agree.
///
/// That cost more than it bought. Every deliberate model change needed a copy of the
/// deleted implementation resurrected to re-freeze against, and that copy lived outside the
/// repository - one `/tmp` clear from these fixtures becoming unmaintainable. They are
/// regenerated from the shader now, and what they check is narrower and honest: that the
/// grade has not moved since somebody last said it should.
///
/// The bytes carry their provenance. They were captured while the shader still agreed with
/// the CPU, at 0.25 counts of `u16` PQ on the matched arm against a bound of 0.5, 0.0002 on
/// the rolled arm, and 0.001 of an 8-bit count on sRGB. Regenerating does not re-establish
/// that agreement, so `BOWERBIRD_WRITE_FIXTURES=1` is a claim the grade should have changed
/// and the new bytes want looking at rather than trusting.
fn baseline(stem: &str, suffix: &str, got: &[u8]) -> Option<Vec<u8>> {
    let path = fixture_dir().join(format!("{stem}.{suffix}"));
    if std::env::var("BOWERBIRD_WRITE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::write(&path, got).expect("writing the answer");
        return None;
    }
    Some(std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
}

/// What `edit::open` codes and filters with, in the same order: the base coded once, then
/// everything but the sharpen ahead of the warp, then the sharpen after it.
///
/// This scene has no lens to warp through, so the two halves land back to back - which is
/// exactly what the editor does for a file whose fit found no geometry, and the frame the
/// client is handed either way.
fn filter_once(prepared: &mut Prepared, grade: &hdr::Grade, strengths: Strengths) {
    tone::encode_base(&mut prepared.samples, prepared.levels.white, grade.reference_white_nits);
    for half in [strengths.before_the_fit(), Strengths { sharpen: strengths.sharpen, ..Default::default() }] {
        hdr::filter_base(&mut prepared.samples, prepared.width, prepared.height, half);
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
            "chromaLow": shape.chroma_low[0],
            "chromaLowBy": shape.chroma_low[1],
            "chromaScaleBy": shape.chroma_scale[1],
            "chromaScale": shape.chroma_scale[0],
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
        // The inputs only. The three answers beside them are `baseline()`'s, and this is
        // not the test that guards them - it guards that the *frame the client is handed*
        // is still what the prepare and the filters produce, which is CPU work either way
        // and so is checked on every machine.
        let files: [(&str, Vec<u8>); 2] =
            [("json", case.header.into_bytes()), ("input.bin", case.input)];
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

/// The editor's `encode` pass against the frame the CPU grades, on a real GPU.
///
/// The same comparison `web/e2e/gpu_parity.spec.ts` makes, without the browser: it runs
/// here in milliseconds where that costs a server, a Vite build and a Chromium, which is
/// the difference between a loop you can work in and one you run before merging. That
/// suite stays - it drives the real `TickPipeline` and gets its payload from the running
/// server, so it is the only thing that can catch the native library and the client
/// disagreeing about the model. This links the crate directly and never would.
///
/// `peak_out[0]` is an *input* to the grade, and `SceneGrade::new` fills it from `measure`
/// and `quantile` - the same two passes the editor's open runs. What this pins is the grade;
/// that the peak tracks the exposure across the slider's range is the browser suite's sweep.
#[test]
fn the_encode_pass_reproduces_the_cpu_frame() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so `encode` was not run against the CPU.");
        return;
    };

    let grade =
        hdr::Grade { peak_nits: 1000.0, reference_white_nits: 203.0, white_quantile: 0.995 };
    let strengths = Strengths { luma: 1.0, chroma: 1.0, sharpen: 1.0, defringe: 1.0 };
    let samples = scene();
    let levels = tone::levels(&samples, grade.white_quantile);

    for (name, colour) in [("neutral", None), ("matched", Some(matched()))] {
        for ev in [0.0f32, 1.0, -1.5] {
            let exposure = 2f64.powf(f64::from(ev));
            let mut prepared =
                Prepared { samples: samples.clone(), width: WIDTH, height: HEIGHT, levels };
            filter_once(&mut prepared, &grade, strengths);

            // The peak the grade runs through, off the frame as it stands here - which is
            // what `tone::SceneGrade::new` measures, and so what `peak_out[0]` stands in for.
            let scene = tone::SceneGrade::new(
                gpu,
                &prepared.samples,
                colour.as_ref(),
                levels,
                grade.reference_white_nits,
                exposure,
            )
            .expect("the fixture grades");
            let got = gpu.encode(
                &prepared.samples,
                &rawshim::gpu::Grade {
                    width: prepared.width,
                    height: prepared.height,
                    colour: colour.as_ref(),
                    white: levels.white,
                    source_level: levels.peak,
                    reference_nits: grade.reference_white_nits,
                    peak_nits: grade.peak_nits,
                    exposure,
                    scene_peak: scene.scene_peak_nits(),
                    // The fixture is the HDR still, which is what `run` above encodes.
                    output: rawshim::gpu::Output::Pq,
                },
            );

            let Some(want) = baseline(&format!("tick-{name}-ev{ev}"), "expected.bin", &le(&got))
            else {
                continue;
            };
            let want: Vec<u16> =
                want.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
            let mut worst = 0i64;
            let mut total = 0i64;
            for (a, b) in got.iter().zip(want.iter()) {
                let error = i64::from(*a) - i64::from(*b);
                total += error.abs();
                worst = worst.max(error.abs());
            }
            let mean = total as f64 / want.len() as f64;
            // In `u16` counts of PQ, which is what both sides write, and the browser
            // suite's bound for the same stage: the grade must land, where `finish` is a
            // denoise the two accumulate differently and this fixture is already past it.
            assert!(
                mean <= 0.5,
                "tick-{name}-ev{ev}: the shader's frame is {mean:.4} counts from the CPU's on \
                 average, worst {worst}",
            );
        }
    }
}

/// The rolled arm, against the frame `hdr::graded_with` leaves behind.
///
/// This is the one that lets the CPU grade go. Every rendition path passes the rolled
/// frame around and encodes it itself, so a GPU output that stops in the same place is a
/// drop-in for `SceneGrade::apply` - no caller has to learn about transfers, and the two
/// encoders stay where they are until fusing them is worth doing on its own merits.
#[test]
fn the_rolled_arm_reproduces_the_cpu_grade() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the rolled arm was not run against the CPU.");
        return;
    };

    let grade =
        hdr::Grade { peak_nits: 1000.0, reference_white_nits: 203.0, white_quantile: 0.995 };
    let strengths = Strengths { luma: 1.0, chroma: 1.0, sharpen: 1.0, defringe: 1.0 };
    let samples = scene();
    let levels = tone::levels(&samples, grade.white_quantile);

    for (name, colour) in [("neutral", None), ("matched", Some(matched()))] {
        for ev in [0.0f32, 1.0, -1.5] {
            let exposure = 2f64.powf(f64::from(ev));
            let mut prepared =
                Prepared { samples: samples.clone(), width: WIDTH, height: HEIGHT, levels };
            filter_once(&mut prepared, &grade, strengths);

            let scene = tone::SceneGrade::new(
                gpu,
                &prepared.samples,
                colour.as_ref(),
                levels,
                grade.reference_white_nits,
                exposure,
            )
            .expect("the fixture grades");
            let got = gpu.encode(
                &prepared.samples,
                &rawshim::gpu::Grade {
                    width: prepared.width,
                    height: prepared.height,
                    colour: colour.as_ref(),
                    white: levels.white,
                    source_level: levels.peak,
                    reference_nits: grade.reference_white_nits,
                    peak_nits: grade.peak_nits,
                    exposure,
                    scene_peak: scene.scene_peak_nits(),
                    output: rawshim::gpu::Output::Rolled,
                },
            );

            let Some(want) = baseline(&format!("tick-{name}-ev{ev}"), "rolled.bin", &le(&got))
            else {
                continue;
            };
            let want: Vec<u16> =
                want.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
            let mut worst = 0i64;
            let mut total = 0i64;
            for (a, b) in got.iter().zip(want.iter()) {
                let error = i64::from(*a) - i64::from(*b);
                total += error.abs();
                worst = worst.max(error.abs());
            }
            let mean = total as f64 / want.len() as f64;
            // In the `u16` both sides write, before any transfer. Tighter than the PQ arm's
            // bound because PQ compresses: an error here is worth less afterwards, not more.
            assert!(
                mean <= 0.5,
                "rolled-{name}-ev{ev}: the shader's frame is {mean:.4} counts from the CPU's \
                 on average, worst {worst}",
            );
        }
    }
}

/// The same dispatch's SDR arm, against its committed answer.
///
/// An SDR rendition is not a second pipeline - `job::peak_nits` puts its peak at diffuse
/// white and the same grade rolls the highlights into it - so what needs checking is only
/// the end: the sRGB primaries and transfer at 8 bits, where the still writes PQ at 16.
/// Its own test because the peak differs, and with it every value in the frame.
#[test]
fn the_encode_pass_reproduces_the_cpu_sdr_frame() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the sRGB arm was not run against the CPU.");
        return;
    };

    // `peak_nits` at the reference white, which is the whole of what `job::peak_nits` does
    // for an SDR target.
    let grade =
        hdr::Grade { peak_nits: 203.0, reference_white_nits: 203.0, white_quantile: 0.995 };
    let strengths = Strengths { luma: 1.0, chroma: 1.0, sharpen: 1.0, defringe: 1.0 };
    let samples = scene();
    let levels = tone::levels(&samples, grade.white_quantile);

    for (name, colour) in [("neutral", None), ("matched", Some(matched()))] {
        let mut prepared =
            Prepared { samples: samples.clone(), width: WIDTH, height: HEIGHT, levels };
        filter_once(&mut prepared, &grade, strengths);

        let scene = tone::SceneGrade::new(
            gpu,
            &prepared.samples,
            colour.as_ref(),
            levels,
            grade.reference_white_nits,
            1.0,
        )
        .expect("the fixture grades");
        let got = gpu.encode(
            &prepared.samples,
            &rawshim::gpu::Grade {
                width: prepared.width,
                height: prepared.height,
                colour: colour.as_ref(),
                white: levels.white,
                source_level: levels.peak,
                reference_nits: grade.reference_white_nits,
                peak_nits: grade.peak_nits,
                exposure: 1.0,
                scene_peak: scene.scene_peak_nits(),
                output: rawshim::gpu::Output::Srgb,
            },
        );

        // The sRGB arm writes 8-bit in the low byte of each `u16`, so the committed answer is
        // bytes and this is the one place the two differ in width.
        let got: Vec<u8> = got.iter().map(|v| *v as u8).collect();
        let Some(want) = baseline(&format!("tick-{name}-ev0"), "srgb.bin", &got) else {
            continue;
        };
        let mut worst = 0i64;
        let mut total = 0i64;
        for (a, b) in got.iter().zip(want.iter()) {
            let error = i64::from(*a) - i64::from(*b);
            total += error.abs();
            worst = worst.max(error.abs());
        }
        let mean = total as f64 / want.len() as f64;
        // In 8-bit counts, so a tenth of one is far tighter than the PQ arm's half of a
        // 16-bit count - which is what it should be: this is the output a viewer looks at
        // directly, and one count is visible on a gradient.
        assert!(
            mean <= 0.1 && worst <= 2,
            "sdr-{name}: the shader's frame is {mean:.4} counts from the CPU's on average, \
             worst {worst}",
        );
    }
}
