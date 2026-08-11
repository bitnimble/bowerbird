//! The parity fixture the GPU grade is checked against, and the check that it is still current.
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

            // The frame's own half of the uniform, from the one thing that builds a `Edit`. The
            // browser harness drives a real `EditPipeline` off this header, so these words are
            // what it grades with - which is the whole of why parity means anything: a client
            // that rebuilt them from `colour` below could reproduce these bytes while
            // describing a different frame to itself on a photograph with a wider lattice.
            let identity = rawshim::hdr_fit::HdrColour::identity();
            let described = colour.as_ref();
            let edits = rawshim::gpu::uniform_words(
                &rawshim::gpu::Grade {
                    width: WIDTH,
                    height: HEIGHT,
                    colour: described,
                    white: levels.white,
                    source_level: levels.peak,
                    reference_nits: grade.reference_white_nits,
                    peak_nits: grade.peak_nits,
                    exposure: 0.0,
                    adjust: rawshim::gpu::Adjust::none(),
                    as_shot: None,
                    output: rawshim::gpu::Output::Pq,
                },
                described.unwrap_or(&identity),
            );

            let header = serde_json::json!({
                "width": WIDTH,
                "height": HEIGHT,
                "white": levels.white,
                "peak": levels.peak,
                "ev": ev,
                "grade": grade,
                "strengths": strengths,
                "matched": colour.is_some(),
                "asShot": serde_json::Value::Null,
                "edits": edits,
                "detail": rawshim::gpu::detail_size(WIDTH, HEIGHT),
                "colour": colour.as_ref().map(describe),
            });

            out.push(Case {
                stem: format!("edit-{name}-ev{ev}"),
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
    tone::encode_base(&mut prepared.samples, prepared.levels.anchored(), grade.reference_white_nits);
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

/// Which pixels the peak reads, over sizes the pinned frames cannot reach.
///
/// **The one thing the graded fixtures are structurally unable to check.** `peak.wgsl` reads
/// every nth row of the frame it grades, and at this fixture's 6144 pixels the stride is 1 and
/// it reads every pixel - so a change to how it samples would agree on every committed byte
/// here and still measure a different peak on any real photograph, which moves where the
/// roll-off knee lands.
///
/// The client used to hold a second copy of this rule and be held to the same table. It no
/// longer has one: the stride travels in `PreparedHeader.edits`, where the shader also reads it,
/// and `EditPipeline` sizes its dispatch off that word. What is left to guard is that *this*
/// rule has not moved. Sizes chosen for the boundaries: under the sample count, either side of
/// it, odd dimensions, and the two sensors this is actually run on.
/// The document's own words, slot for slot, against what the editor puts there.
///
/// **The last thing about a `Edit` that is still written out twice.** Every *rule* has one
/// implementation now - the frame's half of the uniform is built here and copied there, and
/// what a null or a stop means is the shader's - but which slot each slider lands in is a list
/// of assignments in `gpu::uniform_words` and another in `edits`. Transposing a pair there
/// is a photograph graded with the clarity somebody asked for as texture, on a path no parity
/// fixture crosses: those are pinned at every slider zero, where a transposition is invisible.
///
/// So every field is off zero and off every other field, which is what makes a swap fail. The
/// view is left at rest because that half is the editor's alone and this side never fills it.
///
/// `gpu/tests/edits.test.ts` reads the same file.
#[test]
fn the_editor_puts_each_slider_where_this_host_does() {
    let colour = HdrColour::identity();
    let at = |exposure: f64, adjust: rawshim::gpu::Adjust| {
        rawshim::gpu::uniform_words(
            &rawshim::gpu::Grade {
                width: WIDTH,
                height: HEIGHT,
                colour: None,
                white: 1234.0,
                source_level: 5678.0,
                reference_nits: 203.0,
                peak_nits: 1000.0,
                exposure,
                adjust,
                as_shot: Some(rawshim::white_balance::AsShot {
                    temperature: 5500.0,
                    tint: 12.0,
                }),
                output: rawshim::gpu::Output::Pq,
            },
            &colour,
        )
    };

    // Distinct and non-zero throughout, so no two fields can be exchanged unnoticed.
    let moved = rawshim::gpu::Adjust {
        contrast: 11.0,
        highlights: -22.0,
        shadows: 33.0,
        whites: -44.0,
        blacks: 55.0,
        vibrance: -66.0,
        saturation: 77.0,
        texture: -88.0,
        clarity: 99.0,
        dehaze: -12.5,
        temperature: Some(4800.0),
        tint: Some(-6.0),
    };
    let cases = [
        // As it arrives on a photo nobody has edited, which is also the state the frame's own
        // words are shipped in.
        ("rest", 0.0, rawshim::gpu::Adjust::none()),
        ("moved", 1.75, moved),
        // Half a white balance pair, which is the case the two hosts disagreed about.
        (
            "half-balance",
            -2.5,
            rawshim::gpu::Adjust { tint: None, ..moved },
        ),
    ];

    let rows: Vec<String> = cases
        .iter()
        .map(|(name, exposure, adjust)| {
            let words: Vec<String> =
                at(*exposure, *adjust).iter().map(u32::to_string).collect();
            let balance = |v: Option<f64>| match v {
                Some(v) => v.to_string(),
                None => "null".to_string(),
            };
            format!(
                "{name} {exposure} {} {} {} {} {} {} {} {} {} {} {} {} {}",
                adjust.contrast,
                adjust.highlights,
                adjust.shadows,
                adjust.whites,
                adjust.blacks,
                adjust.vibrance,
                adjust.saturation,
                adjust.texture,
                adjust.clarity,
                adjust.dehaze,
                balance(adjust.temperature),
                balance(adjust.tint),
                words.join(","),
            )
        })
        .collect();

    let built = format!("{}\n", rows.join("\n"));
    let path = fixture_dir().join("edit-words.txt");
    if std::env::var("BOWERBIRD_WRITE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(fixture_dir()).expect("the fixture directory");
        std::fs::write(&path, &built).expect("writing the words");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("{}: {e}. BOWERBIRD_WRITE_FIXTURES=1 writes it", path.display())
    });
    assert_eq!(committed, built, "how this host fills a Tick has moved");
}

/// The order this host runs `detail.wgsl` in, for the editor to be held against.
///
/// The guided filter is a sequence, not a kernel, and the two hosts run it separately. A host
/// that reordered it - or ran one box mean where the other ran two - would build a different
/// neighbourhood from the same frame, so the clarity in the editor and the clarity in the
/// rendition would be different pictures. **Nothing else can see that.** The graded fixtures
/// beside this one are pinned at every slider zero, where `adjusted` returns before it samples
/// the texture at all, so a divergence here changes not one committed byte.
#[test]
fn the_editor_filters_detail_in_the_order_this_host_does() {
    let built = format!("{}\n", rawshim::gpu::DETAIL_PASSES.join("\n"));
    let path = fixture_dir().join("detail-passes.txt");
    if std::env::var("BOWERBIRD_WRITE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(fixture_dir()).expect("the fixture directory");
        std::fs::write(&path, &built).expect("writing the passes");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("{}: {e}. BOWERBIRD_WRITE_FIXTURES=1 writes it", path.display())
    });
    assert_eq!(committed, built, "how this host builds the detail texture has moved");
}

#[test]
fn the_peak_reads_the_pixels_it_always_did() {
    let sizes: [(usize, usize); 8] = [
        (1, 1),
        (96, 64),
        (1024, 1024),
        (1449, 724),
        (3840, 2560),
        (3841, 2561),
        (6000, 4000),
        (9504, 6336),
    ];
    let rows: Vec<String> = sizes
        .iter()
        .map(|(width, height)| {
            let (stride, rows) = rawshim::gpu::sampled_rows(*width, *height);
            format!("{width}x{height} stride {stride} samples {}", *width as u32 * rows)
        })
        .collect();
    let built = format!("{}\n", rows.join("\n"));
    let path = fixture_dir().join("peak-sampling.txt");
    if std::env::var("BOWERBIRD_WRITE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(fixture_dir()).expect("the fixture directory");
        std::fs::write(&path, &built).expect("writing the sampling table");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("{}: {e}. BOWERBIRD_WRITE_FIXTURES=1 writes it", path.display())
    });
    assert_eq!(committed, built, "how this host samples the peak has moved");
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
/// suite stays - it drives the real `EditPipeline` and gets its payload from the running
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
            // Stops, which is what the uniform carries now: `colour.wgsl` raises them, so a
            // gain here would be a second conversion on top of the shader's.
            let exposure = f64::from(ev);
            let mut prepared =
                Prepared { samples: samples.clone(), width: WIDTH, height: HEIGHT, levels };
            filter_once(&mut prepared, &grade, strengths);

            // No peak is supplied. `upload` measures it off this very frame, through the two
            // passes the editor's open runs, so what the fixture pins is the whole of what the
            // shaders do with the samples beside it.
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
                    // The fixture is the HDR still, which is what `run` above encodes.
                    // The camera's rendering, unadjusted: these fixtures pin the grade, and
                    // a slider set here would be pinning one reader's taste instead.
                    adjust: rawshim::gpu::Adjust::none(),
                    as_shot: None,
                    output: rawshim::gpu::Output::Pq,
                },
            );

            let Some(want) = baseline(&format!("edit-{name}-ev{ev}"), "expected.bin", &le(&got))
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
                "edit-{name}-ev{ev}: the shader's frame is {mean:.4} counts from the CPU's on \
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
            // Stops, which is what the uniform carries now: `colour.wgsl` raises them, so a
            // gain here would be a second conversion on top of the shader's.
            let exposure = f64::from(ev);
            let mut prepared =
                Prepared { samples: samples.clone(), width: WIDTH, height: HEIGHT, levels };
            filter_once(&mut prepared, &grade, strengths);

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
                    adjust: rawshim::gpu::Adjust::none(),
                    as_shot: None,
                    output: rawshim::gpu::Output::Rolled,
                },
            );

            let Some(want) = baseline(&format!("edit-{name}-ev{ev}"), "rolled.bin", &le(&got))
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

const BANDED: usize = 256;

/// A frame built from three separable scales, so each presence slider has something of its
/// own to act on: a ramp far coarser than either blur, a sixteen-pixel wave in clarity's band,
/// and a two-pixel checker in texture's.
///
/// `haze` lifts the whole thing towards white and compresses it, which is what haze physically
/// does - the airlight adds to every pixel and the scene's own contrast survives only in what
/// is left of the range.
///
/// Neutral grey throughout, the three channels equal, so nothing measured off it depends on
/// the colour model. That is what the fixtures above are for.
fn banded(haze: f64) -> Vec<u16> {
    let mut samples = vec![0u16; BANDED * BANDED * 3];
    for y in 0..BANDED {
        for x in 0..BANDED {
            let ramp = 12000.0 + 6000.0 * (x as f64 / BANDED as f64);
            let wave = 2500.0 * (x as f64 * std::f64::consts::TAU / 16.0).sin();
            let checker = 1500.0 * (((x + y) % 2) as f64 * 2.0 - 1.0);
            let scene = (ramp + wave + checker) * (1.0 - haze) + 45000.0 * haze;
            let level = scene.clamp(0.0, 65535.0) as u16;
            let at = (y * BANDED + x) * 3;
            samples[at] = level;
            samples[at + 1] = level;
            samples[at + 2] = level;
        }
    }
    samples
}

/// How much of the frame sits at a given spacing: the mean absolute difference between two
/// pixels that many columns apart, on the red channel.
///
/// A band-pass by the crudest means there is, and enough for this. At one column the checker
/// dominates and the wave barely moves; at eight the checker cancels exactly - the two pixels
/// share its parity - leaving the wave in antiphase with itself, which is twice its amplitude.
fn band(frame: &[u16], apart: usize) -> f64 {
    let mut total = 0.0;
    let mut count = 0.0;
    for y in 0..BANDED {
        for x in 0..BANDED - apart {
            let at = |x: usize| f64::from(frame[(y * BANDED + x) * 3]);
            total += (at(x) - at(x + apart)).abs();
            count += 1.0;
        }
    }
    total / count
}

/// A frame in two halves, each with the same fine texture on a very different ground.
///
/// The left half sits deep in shadow and the right half near white, and the texture riding on
/// both is identical in *stops* - a fixed ratio, so it is the same local contrast on each.
///
/// **A tenth of a stop either side, which is texture and not an edge.** The distinction is the
/// guided filter's own and the number has to respect it: `GUIDE_EPS` calls four tenths of a
/// stop of local variation the boundary, so a ripple near that is half kept as structure and
/// the test below would be measuring the threshold rather than the locality. A surface under
/// even light varies by about this much, which is what the tone group is supposed to leave
/// alone.
fn split_ground() -> Vec<u16> {
    let mut samples = vec![0u16; BANDED * BANDED * 3];
    for y in 0..BANDED {
        for x in 0..BANDED {
            let ground = if x < BANDED / 2 { 900.0 } else { 30000.0 };
            // The same ratio either side, so the texture is the same number of stops on both.
            let ripple = 1.0 + 0.08 * (((x + y) % 2) as f64 * 2.0 - 1.0);
            let level = (ground * ripple).clamp(0.0, 65535.0) as u16;
            let at = (y * BANDED + x) * 3;
            samples[at] = level;
            samples[at + 1] = level;
            samples[at + 2] = level;
        }
    }
    samples
}

/// The banded frame graded, which is what both of the tests below measure off.
///
/// `Rolled` rather than PQ, so a difference in counts is a difference in light: the transfer
/// would compress the shadows and flatter every claim either of them makes.
fn graded_banded(
    gpu: &rawshim::gpu::Gpu,
    haze: f64,
    adjust: rawshim::gpu::Adjust,
) -> Vec<u16> {
    graded_frame(gpu, banded(haze), adjust)
}

fn graded_frame(
    gpu: &rawshim::gpu::Gpu,
    frame: Vec<u16>,
    adjust: rawshim::gpu::Adjust,
) -> Vec<u16> {
    let grade = hdr::Grade { peak_nits: 1000.0, reference_white_nits: 203.0, white_quantile: 0.995 };
    let mut samples = frame;
    let levels = tone::levels(&samples, grade.white_quantile);
    tone::encode_base(&mut samples, levels.anchored(), grade.reference_white_nits);
    gpu.encode(
        &samples,
        &rawshim::gpu::Grade {
            width: BANDED,
            height: BANDED,
            colour: None,
            white: levels.white,
            source_level: levels.peak,
            reference_nits: grade.reference_white_nits,
            peak_nits: grade.peak_nits,
            exposure: 0.0,
            adjust,
            // A daylight baseline, so the balance test has something to move away from. The
            // presence test leaves the pair unset, where this is not read at all.
            //
            // The tint is off zero on purpose: a camera's neutral is never exactly on the
            // Planckian locus, and a baseline that was would let a host standing a missing
            // tint up as zero pass by coincidence.
            as_shot: Some(rawshim::white_balance::AsShot { temperature: 5500.0, tint: 12.0 }),
            output: rawshim::gpu::Output::Rolled,
        },
    )
}

/// Shadows lifts a region without stretching the texture inside it, which is the whole of what
/// reading the neighbourhood buys.
///
/// **A pixel does not know whether it is a shadow, and a pointwise curve has to pretend it
/// does.** On the dim half of `split_ground` the texture rides a tenth of a stop either side of
/// a ground five stops under white - so a curve evaluated per pixel gives the peak of each
/// ripple a materially larger lift than the trough, the two sitting at different points on the
/// zone's falling side. Measured against this frame: about a seventh of a stop of difference
/// across a ripple two tenths of a stop wide, which is the same texture stretched by two thirds.
/// Every flat surface in a shaded part of a photograph gets that, and it is why a pointwise
/// shadows reads as scouring rather than as opening up.
///
/// Weighted by the *neighbourhood* the ripple is smaller than the guided filter's own edge
/// threshold, so it is smoothed away from the weight entirely: every texel of the region takes
/// one gain and the texture arrives at the top intact.
///
/// So the claim is scale-free on purpose - local contrast as a share of the mean, before and
/// after. The lift itself is asserted first, because a control that did nothing would hold that
/// share perfectly.
#[test]
fn shadows_lifts_a_region_without_stretching_the_texture_in_it() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the tone group was not run.");
        return;
    };
    let none = rawshim::gpu::Adjust::none();
    let flat = graded_frame(gpu, split_ground(), none);
    let lifted =
        graded_frame(gpu, split_ground(), rawshim::gpu::Adjust { shadows: 100.0, ..none });

    // Well inside the dim half, so nothing measured straddles the seam the filter is holding.
    let (from, to) = (16usize, BANDED / 2 - 16);
    let mean = |frame: &[u16]| {
        let mut total = 0.0;
        let mut count = 0.0;
        for y in 0..BANDED {
            for x in from..to {
                total += f64::from(frame[(y * BANDED + x) * 3]);
                count += 1.0;
            }
        }
        total / count
    };
    // The ripple, as the mean step between neighbouring columns - which is what it is made of.
    let ripple = |frame: &[u16]| {
        let mut total = 0.0;
        let mut count = 0.0;
        for y in 0..BANDED {
            for x in from..to - 1 {
                let at = |x: usize| f64::from(frame[(y * BANDED + x) * 3]);
                total += (at(x) - at(x + 1)).abs();
                count += 1.0;
            }
        }
        total / count
    };

    let (was, now) = (mean(&flat), mean(&lifted));
    assert!(
        now > was * 1.15,
        "shadows at +100 took the dim region from {was:.0} to {now:.0}, which is not a lift",
    );

    let (before, after) = (ripple(&flat) / was, ripple(&lifted) / now);
    assert!(
        after < before * 1.12,
        "shadows at +100 took the region's local contrast from {:.1}% of the mean to {:.1}%: it \
         is weighting the pixel rather than the region",
        before * 100.0,
        after * 100.0,
    );
}

/// The temperature and tint pair, against the direction and the anchor they promise.
///
/// Three claims, and each has been a bug in some editor. **Warmer means warmer**: raising the
/// slider says the light was bluer than the camera assumed, so more blue is divided out and
/// the picture goes yellow - the sign is a coin flip in the arithmetic and inverting it looks
/// entirely plausible until you drag it. **The as-shot value is exactly identity**, which is
/// what makes "As Shot" a position on the slider rather than a fourth mode. And **the balance
/// does not move the exposure**, or every tonal slider below it would be grading against a
/// diffuse white the reader had just shifted.
#[test]
fn the_balance_moves_colour_in_the_named_direction_and_leaves_brightness_alone() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the white balance was not run.");
        return;
    };
    let none = rawshim::gpu::Adjust::none();
    let at = |temperature: Option<f64>, tint: Option<f64>| {
        graded_banded(gpu, 0.0, rawshim::gpu::Adjust { temperature, tint, ..none })
    };

    // The baseline `graded_banded` declares. Asking for it by name has to be the same picture
    // as not asking at all, to the byte: the shader solves both illuminants through the same
    // search, so anything else means the pair is not a pure ratio.
    assert_eq!(at(Some(5500.0), Some(12.0)), at(None, None), "as shot is not identity");

    // And half a pair is the frame's own other half, not zero. The document allows one without
    // the other - a sidecar can state a Kelvin and no tint - and a host that read the gap as
    // "on the Planckian locus" would render a photograph the editor never showed.
    assert_eq!(
        at(Some(6500.0), None),
        at(Some(6500.0), Some(12.0)),
        "a temperature with no tint did not fall back to the frame's own",
    );

    let neutral = at(None, None);
    let warm = at(Some(8000.0), Some(12.0));
    let cool = at(Some(3500.0), Some(12.0));
    // Red against blue, averaged over the frame, which is what "warm" means in one number.
    let warmth = |frame: &[u16]| {
        let red: f64 = frame.iter().step_by(3).map(|v| f64::from(*v)).sum();
        let blue: f64 = frame.iter().skip(2).step_by(3).map(|v| f64::from(*v)).sum();
        red / blue.max(1.0)
    };
    assert!(
        warmth(&warm) > warmth(&neutral) && warmth(&neutral) > warmth(&cool),
        "8000K {:.3}, as shot {:.3}, 3500K {:.3} - the slider is inverted",
        warmth(&warm),
        warmth(&neutral),
        warmth(&cool),
    );

    // Green against magenta for the tint, on the same frame.
    let green = |frame: &[u16]| {
        let g: f64 = frame.iter().skip(1).step_by(3).map(|v| f64::from(*v)).sum();
        let rb: f64 = frame
            .iter()
            .enumerate()
            .filter(|(i, _)| i % 3 != 1)
            .map(|(_, v)| f64::from(*v))
            .sum();
        g / rb.max(1.0)
    };
    let magenta = at(Some(5500.0), Some(72.0));
    assert!(
        green(&magenta) < green(&neutral),
        "a positive tint went green rather than magenta: {:.4} against {:.4}",
        green(&magenta),
        green(&neutral),
    );

    // And the brightness, which the renormalisation in `white_balance.wgsl` exists to hold.
    let luma = |frame: &[u16]| {
        frame
            .chunks_exact(3)
            .map(|p| 0.2627 * f64::from(p[0]) + 0.678 * f64::from(p[1]) + 0.0593 * f64::from(p[2]))
            .sum::<f64>()
            / (frame.len() / 3) as f64
    };
    let (was, warmed) = (luma(&neutral), luma(&warm));
    assert!(
        (warmed - was).abs() < was * 0.06,
        "a 2500K move took the mean luma from {was:.0} to {warmed:.0}, which is an exposure",
    );
}

/// Texture, clarity and dehaze, each against what it claims to do.
///
/// These three read `detail.wgsl`'s blur rather than the pixel, and nothing above can say
/// anything about them: the fixtures are pinned at `Adjust::none`, so a blur that came back
/// empty, a coordinate that pointed at the wrong texel, or a pass that never ran would leave
/// every one of them green. What is asserted is the *direction and the band*, not a value -
/// the constants in `adjust.wgsl` are taste and should be free to move.
///
/// The cross-band claim is one-sided on purpose. Texture is above the fine blur and the wave
/// is nowhere near it, so lifting texture must leave the coarse band alone; clarity's band is
/// the gap between the two blurs and the checker has a real share of it, so the mirror claim
/// is not true and is not made.
#[test]
fn the_presence_sliders_act_on_the_bands_they_name() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the presence sliders were not run.");
        return;
    };
    let graded = |haze: f64, adjust: rawshim::gpu::Adjust| graded_banded(gpu, haze, adjust);
    let none = rawshim::gpu::Adjust::none();
    let flat = graded(0.0, none);

    for (name, apart, up, down) in [
        ("texture", 1usize, rawshim::gpu::Adjust { texture: 100.0, ..none },
         rawshim::gpu::Adjust { texture: -100.0, ..none }),
        ("clarity", 8, rawshim::gpu::Adjust { clarity: 100.0, ..none },
         rawshim::gpu::Adjust { clarity: -100.0, ..none }),
    ] {
        let (was, lifted, lowered) =
            (band(&flat, apart), band(&graded(0.0, up), apart), band(&graded(0.0, down), apart));
        assert!(
            lifted > was * 1.1,
            "{name} at +100 took the {apart}-column band from {was:.1} to {lifted:.1}",
        );
        assert!(
            lowered < was * 0.9,
            "{name} at -100 took the {apart}-column band from {was:.1} to {lowered:.1}",
        );
    }

    let coarse = band(&graded(0.0, rawshim::gpu::Adjust { texture: 100.0, ..none }), 8);
    let was = band(&flat, 8);
    assert!(
        coarse < was * 1.05,
        "texture at +100 moved the coarse band from {was:.1} to {coarse:.1}, which is \
         clarity's to move",
    );

    // Dehaze on a frame that has some: the model subtracts a neutral airlight and divides by
    // what is left, so the floor drops and everything above it spreads out.
    let hazy = graded(0.45, none);
    let cleared = graded(0.45, rawshim::gpu::Adjust { dehaze: 100.0, ..none });
    let floor = |frame: &[u16]| *frame.iter().step_by(3).min().expect("a frame with pixels");
    let (before, after) = (f64::from(floor(&hazy)), f64::from(floor(&cleared)));
    assert!(
        after < before * 0.75,
        "dehaze at +100 left the frame's floor at {after:.0} of {before:.0}",
    );
    let (dull, cleared) = (band(&hazy, 8), band(&cleared, 8));
    assert!(
        cleared > dull * 1.25,
        "dehaze at +100 took the coarse band from {dull:.1} to {cleared:.1}",
    );
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
                exposure: 0.0,
                adjust: rawshim::gpu::Adjust::none(),
                as_shot: None,
                output: rawshim::gpu::Output::Srgb,
            },
        );

        // The sRGB arm writes 8-bit in the low byte of each `u16`, so the committed answer is
        // bytes and this is the one place the two differ in width.
        let got: Vec<u8> = got.iter().map(|v| *v as u8).collect();
        let Some(want) = baseline(&format!("edit-{name}-ev0"), "srgb.bin", &got) else {
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
