//! The GPU grade, the composites and the tables both hosts read, held to their recorded answers.
//!
//! The pictures are snapshots (`snapshot.rs`) under `test/fixtures/snapshots/`; the tables are
//! text beside the other pins. The browser runs this crate, so what is recorded here is what the
//! editor draws too.
//!
//! **On a machine with an adapter.** Every test here returns silently where no Vulkan of any
//! kind answers, so on such a machine the fixtures are unchecked and the guarantee above is
//! only as good as CI having a GPU.
//!
//! Regenerate deliberately, after looking at why they moved (`bun run snapshots`):
//!
//!   BOWERBIRD_WRITE_FIXTURES=1 bun run test:native --test gpu_fixture
//!
//! Synthetic rather than a real RAW on purpose. The open path is the same code either way,
//! and a fixture that decodes a 25MB file cannot live in the repo or run in a second.

use rawshim::composite_tile::{CompositeRequest, From, SourceFile};
use rawshim::composition::{Composition, LensSpec};
use rawshim::hdr::{self, Prepared};
use rawshim::hdr_fit::{ChromaMap, HdrColour, TRUST_CEILING};
use rawshim::image::Strengths;
use rawshim::light::{Light, Stops};
use rawshim::px::Size;
use rawshim::resident::Resident;
use rawshim::snapshot::{Snapshot, Tolerance};
use rawshim::tone;

const WIDTH: usize = 96;
const HEIGHT: usize = 64;

/// The grade every fixture here is pinned at, which is the library's own.
const SHIPPED: hdr::Grade = hdr::Grade {
    peak_nits: Light::exactly(1000.0),
    reference_white_nits: Light::exactly(203.0),
    white_quantile: 0.995,
};

const STRENGTHS: Strengths = Strengths {
    sharpen: 0.3,
    defringe: 1.0,
};

fn fixture_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/tables")
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

fn levels(
    gpu: &'static rawshim::gpu::Gpu,
    samples: &[u16],
    width: usize,
    height: usize,
    quantile: f64,
) -> tone::Levels {
    rawshim::hdr::levels_of(gpu, samples, width, height, quantile).expect("the frame's levels")
}

/// A camera match with something in every part of it.
///
/// Every field is off the identity, and the lattice varies per node rather than repeating
/// one saturation, so a reader that swapped the chroma axes or mis-scaled the level axis
/// lands on the wrong node and fails. An identity anywhere is a no-op the pin cannot tell
/// from a correct implementation or from a missing one.
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
    // Well inside the domain, where a fitted curve's lands, and set rather than derived: an
    // exponential shoulder never expands chroma, so `chroma_anchor` would answer the ceiling
    // and leave the highlight read - the one part of `tone` that is not separable - untested.
    colour.anchor = TRUST_CEILING * 0.4;
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
        [
            scale,
            skew,
            -skew,
            scale * 0.98,
            tint,
            -0.003 * (y as f64 - 2.0),
            lift,
            // The chroma-to-lightness pair, off zero at every node so a reader that dropped
            // either or packed them in the wrong slot cannot answer correctly.
            0.05 * (x as f64 - 2.0),
            -0.04 * (y as f64 - 2.0),
        ]
    }));
    colour
}

/// The size every synthetic frame here is, in the grade's output pixels.
fn frame_size() -> Size<rawshim::px::Output> {
    Size::measured(WIDTH, HEIGHT)
}

/// What `edit::open` codes and filters with, in the same order: the base coded once, then
/// the sharpen, which follows the warp.
///
/// This scene has no lens to warp through, so the two halves land back to back - which is
/// exactly what the editor does for a file whose fit found no geometry, and the frame the
/// client is handed either way. The sharpen is `sharpen.slang` on both hosts now, driven
/// here through its host-roundtrip spelling at the fixed sigma the fixtures were frozen at.
fn filter_once(prepared: &mut Prepared, grade: &hdr::Grade, strengths: Strengths) {
    rawshim::hdr::code_base(
        &mut prepared.samples,
        prepared.levels.anchored(),
        grade.reference_white_nits,
    );
    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    let base = rawshim::base::device(gpu).expect("the base pipelines");
    pollster::block_on(rawshim::base::sharpen_base(
        gpu,
        base,
        &mut prepared.samples,
        prepared.width,
        prepared.height,
        strengths.sharpen,
        rawshim::image::DECONVOLVE_SIGMA,
    ))
    .expect("the sharpen runs");
}

/// The document's own words, slot for slot, so a rewrite of `uniform_words` says which slider
/// moved.
///
/// **A committed table rather than an assertion per field**, because what is being guarded is a
/// list of assignments and the failure is two of them exchanged. Every field is off zero and off
/// every other field, which is what makes a swap fail; a per-field assertion mirrors the list it
/// is checking and moves with it. The view is left at rest, being what a draw fills in and not
/// what a document says.
#[test]
fn the_editor_puts_each_slider_where_this_host_does() {
    let colour = HdrColour::identity();
    let at = |exposure: Stops, adjust: rawshim::gpu::Adjust| {
        rawshim::gpu::uniform_words(
            &rawshim::gpu::Grade {
                width: WIDTH,
                height: HEIGHT,
                photograph_long: rawshim::px::Span::measured(WIDTH.max(HEIGHT)),
                colour: None,
                white: Light::measured(1234.0),
                source_level: Light::measured(5678.0),
                floor: Some(Light::measured(111.0)),
                reference_nits: Light::exactly(203.0),
                peak_nits: Light::exactly(1000.0),
                exposure,
                adjust,
                as_shot: Some(rawshim::white_balance::AsShot {
                    temperature: 5500.0,
                    tint: 12.0,
                }),
                output: rawshim::gpu::Output::Pq,
                geometry: rawshim::image::Geometry::none(),
                window: None,
                surround_window: None,
                canvas: None,
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
        colour_profile: rawshim::gpu::ColourProfile::Matched,
    };
    let cases = [
        // As it arrives on a photo nobody has edited, which is also the state the frame's own
        // words are shipped in.
        ("rest", Stops::ZERO, rawshim::gpu::Adjust::none()),
        ("moved", Stops::measured(1.75), moved),
        // Half a white balance pair, which is the case the two hosts disagreed about.
        (
            "half-balance",
            Stops::measured(-2.5),
            rawshim::gpu::Adjust {
                tint: None,
                ..moved
            },
        ),
    ];

    let rows: Vec<String> = cases
        .iter()
        .map(|(name, exposure, adjust)| {
            let words: Vec<String> = at(*exposure, *adjust).iter().map(u32::to_string).collect();
            let balance = |v: Option<f64>| match v {
                Some(v) => v.to_string(),
                None => "null".to_string(),
            };
            format!(
                "{name} {} {} {} {} {} {} {} {} {} {} {} {} {} {}",
                exposure.raw(),
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
        panic!(
            "{}: {e}. BOWERBIRD_WRITE_FIXTURES=1 writes it",
            path.display()
        )
    });
    assert_eq!(committed, built, "how this host fills a Tick has moved");
}

/// The order this host runs `detail.slang` in, so a reordering has to be a deliberate one.
///
/// The guided filter is a sequence, not a kernel: dropping a pass, or running one box mean where
/// it ran two, builds a different neighbourhood from the same frame and every presence slider
/// means something else. **Nothing else can see that.** The graded fixtures beside this one are
/// pinned at every slider zero, where `adjusted` returns before it samples the texture at all, so
/// a change here moves not one committed byte.
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
        panic!(
            "{}: {e}. BOWERBIRD_WRITE_FIXTURES=1 writes it",
            path.display()
        )
    });
    assert_eq!(
        committed, built,
        "how this host builds the detail texture has moved"
    );
}

/// What a geometry does to a frame's shape, for the page and the catalogue to be held against.
///
/// **Three consumers, two implementations, and nothing between them until now.** `hdr::cropped_size`
/// decides what a rendition is written at; `displaySize` in `schemas/display_size.ts` decides what
/// shape the grid lays a tile out in *and* what the editor sizes its stage to. Its own doc says the
/// two have to agree - "a disagreement is a tile that is the wrong shape for the picture inside it" -
/// and neither side asked the other.
///
/// The angles include negatives because the two spell the absolute differently: this side takes
/// `cos().abs()` of the signed radians, the page takes the cosine of `Math.abs(degrees)`. Those
/// agree over a straighten's range and stop agreeing outside it, which is worth a row rather than an
/// argument.
///
/// Rounding is the other half. Both round and floor at one, and a crop narrow enough to land under
/// half a pixel at tile size is where a `round` against a `floor` would first show.
#[test]
fn the_page_shapes_a_geometry_the_way_this_host_does() {
    let cases: [(usize, usize, [f64; 4], f64, u16); 8] = [
        (6000, 4000, [0.0, 0.0, 1.0, 1.0], 0.0, 0),
        (6000, 4000, [0.0, 0.0, 1.0, 1.0], 1.75, 0),
        (6000, 4000, [0.0, 0.0, 1.0, 1.0], -1.75, 0),
        (6000, 4000, [0.31, 0.22, 0.68, 0.63], 1.75, 90),
        (6000, 4000, [0.31, 0.22, 0.68, 0.63], -3.5, 270),
        (4000, 6000, [0.1, 0.1, 0.9, 0.9], 0.0, 180),
        // Narrow enough that the floor at one is what answers, at a grid tile's size.
        (240, 160, [0.4, 0.4, 0.4004, 0.4004], 0.0, 0),
        (4001, 2999, [0.0, 0.0, 1.0, 1.0], 12.0, 90),
    ];
    let rows: Vec<String> = cases
        .iter()
        .map(|(width, height, crop, angle, rotate)| {
            let geometry = rawshim::image::Geometry {
                crop: *crop,
                angle_degrees: *angle,
                rotate: *rotate,
                keystone: None,
            };
            let (out_w, out_h) = rawshim::hdr::cropped_size(*width, *height, geometry);
            format!(
                "{width}x{height} {},{},{},{} {angle} {rotate} {out_w}x{out_h}",
                crop[0], crop[1], crop[2], crop[3],
            )
        })
        .collect();

    let built = format!("{}\n", rows.join("\n"));
    let path = fixture_dir().join("display-size.txt");
    if std::env::var("BOWERBIRD_WRITE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(fixture_dir()).expect("the fixture directory");
        std::fs::write(&path, &built).expect("writing the shapes");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. BOWERBIRD_WRITE_FIXTURES=1 writes it",
            path.display()
        )
    });
    assert_eq!(
        committed, built,
        "what a geometry does to a frame's shape has moved"
    );
}

/// Which level of a picture a prepare is asked for, and what shape that level is, held to the
/// other host's answer.
///
/// **Two implementations of one arithmetic, and a disagreement is not an error anywhere.** The
/// server picks the level and sizes the buffer this host writes into; this host produces the
/// picture at that level. Too small a buffer is a failure naming the size it wanted, which is at
/// least loud - too *shallow* a level is a picture no adapter will hold a texture of, four hundred
/// megabytes of it, handed to a client that then refuses it.
///
/// **And the level's own two axes, since a client now asks for a rectangle of one.** A window is
/// stated in the level's pixels and refused where it is not inside them, so a server whose idea of
/// the level is two pixels wider than this host's asks for a rectangle that runs off the picture -
/// and a reader zoomed into the right-hand end of a panorama is shown an error. Both axes, because
/// both are floored to even and the short one is not derived from the long.
///
/// The sizes are the ones the arithmetic turns on: a canvas already inside the ceiling, one a
/// pixel over it, the powers either side, a pan far past it, and one past `MAX_LONG_EDGE` - where
/// the level stops halving because a composite is never assembled larger than that.
#[test]
fn the_server_picks_the_level_this_host_produces() {
    let cases: [usize; 9] = [1, 4096, 4097, 6000, 8192, 8193, 9504, 14845, 61000];
    let shapes: [[usize; 2]; 6] = [
        [4096, 2731],
        [4097, 2732],
        [9504, 6336],
        [14845, 7069],
        [33804, 9376],
        [61000, 9000],
    ];
    let rows: Vec<String> = cases
        .iter()
        .map(|long| {
            let level = rawshim::composition::coarsest_level(*long);
            format!("{long} {level} {}", long >> level)
        })
        .chain(shapes.iter().flat_map(|canvas| {
            // Every level from the coarsest down to the picture's own pixels, which is the range a
            // ladder walks: the coarsest is what an open is served and 0 is where a reader ends up.
            let long = canvas[0].max(canvas[1]);
            (0..=rawshim::composition::coarsest_level(long))
                .rev()
                .map(move |level| {
                    let (width, height) = rawshim::composite_job::level_shape(canvas, level);
                    format!("shape {} {} {level} {width} {height}", canvas[0], canvas[1])
                })
        }))
        .collect();

    let built = format!("{}\n", rows.join("\n"));
    let path = fixture_dir().join("prepare-levels.txt");
    if std::env::var("BOWERBIRD_WRITE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(fixture_dir()).expect("the fixture directory");
        std::fs::write(&path, &built).expect("writing the levels");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. BOWERBIRD_WRITE_FIXTURES=1 writes it",
            path.display()
        )
    });
    assert_eq!(
        committed, built,
        "which level a picture is prepared at has moved"
    );
    // And the ceiling itself, since the page carries the constant rather than deriving it.
    assert_eq!(rawshim::composition::COARSEST_LONG, 4096);
}

/// How this host fills `Reduction`, so a rewrite of `base::reduction_bytes` says what moved.
///
/// **Eight words written by hand in front of a shader that is shared verbatim.** A pair transposed
/// there is a canvas sampling a pyramid level built for a different picture, which looks like a
/// photograph - and nothing downstream would notice.
///
/// The ratios are the ones actually asked for: exactly two for every pyramid level, and a fraction
/// for a rendition cut to a size the sensor does not divide into. The odd source is here because a
/// level is a floored half, which is the case that makes the ratio worth sending at all.
#[test]
fn the_editor_fills_a_reduction_the_way_this_host_does() {
    let cases: [((usize, usize), (usize, usize), (f64, f64)); 4] = [
        ((96, 64), (48, 32), (2.0, 2.0)),
        ((129, 67), (64, 33), (2.0, 2.0)),
        (
            (6000, 4000),
            (1600, 1067),
            (6000.0 / 1600.0, 4000.0 / 1067.0),
        ),
        ((1, 1), (1, 1), (1.0, 1.0)),
    ];
    let rows: Vec<String> = cases
        .iter()
        .map(|(source, out, scale)| {
            let words: Vec<String> = rawshim::base::reduction_bytes(*source, *out, *scale)
                .chunks_exact(4)
                .map(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]]).to_string())
                .collect();
            format!(
                "{},{} {},{} {} {} {}",
                source.0,
                source.1,
                out.0,
                out.1,
                scale.0,
                scale.1,
                words.join(","),
            )
        })
        .collect();

    let built = format!("{}\n", rows.join("\n"));
    let path = fixture_dir().join("reduction-words.txt");
    if std::env::var("BOWERBIRD_WRITE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(fixture_dir()).expect("the fixture directory");
        std::fs::write(&path, &built).expect("writing the words");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. BOWERBIRD_WRITE_FIXTURES=1 writes it",
            path.display()
        )
    });
    assert_eq!(
        committed, built,
        "how this host fills a Reduction has moved"
    );
}

/// Which pixels the peak reads, over sizes the pinned frames cannot reach.
///
/// **The one thing the graded fixtures are structurally unable to check.** `peak.slang` reads every
/// nth row of the frame it grades, and at this fixture's 6144 pixels the stride is 1 and it reads
/// every pixel - so a change to how it samples would agree on every committed byte here and still
/// measure a different peak on any real photograph, which moves where the roll-off knee lands.
///
/// Sizes chosen for the boundaries: under the sample count, either side of it, odd dimensions, and
/// the two sensors this is actually run on.
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
            format!(
                "{width}x{height} stride {stride} samples {}",
                *width as u32 * rows
            )
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
        panic!(
            "{}: {e}. BOWERBIRD_WRITE_FIXTURES=1 writes it",
            path.display()
        )
    });
    assert_eq!(committed, built, "how this host samples the peak has moved");
}

/// The frame the editor's open hands the grade: coded, then sharpened.
#[test]
fn the_prepare_reproduces_the_recorded_frame() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the prepare was not run against its snapshot.");
        return;
    };
    let samples = scene();
    let mut prepared = Prepared {
        samples: samples.clone(),
        width: WIDTH,
        height: HEIGHT,
        levels: levels(gpu, &samples, WIDTH, HEIGHT, SHIPPED.white_quantile),
    };
    filter_once(&mut prepared, &SHIPPED, STRENGTHS);
    Snapshot::pq(&prepared.samples, frame_size()).check("grade/prepared", UNGRADED);
}

/// The editor's `encode` pass against its recorded frame, on a real GPU.
///
/// Milliseconds rather than a browser: the editor draws through this same `encode`, so what a
/// Playwright run would add is a Chromium, not an assertion.
///
/// `peak_out[0]` is an *input* to the grade, and `SceneGrade::new` fills it from `measure`
/// and `quantile` - the same two passes the editor's open runs. What this pins is the grade;
/// that the peak tracks the exposure across the slider's range is
/// `gpu::the_kept_candidates_answer_as_the_whole_sample_does`.
#[test]
fn the_encode_pass_reproduces_the_recorded_frame() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so `encode` was not run against its fixture.");
        return;
    };

    let grade = SHIPPED;
    let strengths = Strengths {
        sharpen: 0.3,
        defringe: 1.0,
    };
    let samples = scene();
    let levels = levels(gpu, &samples, WIDTH, HEIGHT, grade.white_quantile);

    for (name, colour) in [("neutral", None), ("matched", Some(matched()))] {
        for ev in [0.0f32, 1.0, -1.5] {
            // Stops, which is what the uniform carries now: `colour.slang` raises them, so a
            // gain here would be a second conversion on top of the shader's.
            let exposure = Stops::measured(f64::from(ev));
            let mut prepared = Prepared {
                samples: samples.clone(),
                width: WIDTH,
                height: HEIGHT,
                levels,
            };
            filter_once(&mut prepared, &grade, strengths);

            // No peak is supplied. `upload` measures it off this very frame, through the two
            // passes the editor's open runs, so what the fixture pins is the whole of what the
            // shaders do with the samples beside it.
            let got = gpu.encode(
                &prepared.samples,
                &rawshim::gpu::Grade {
                    width: prepared.width,
                    height: prepared.height,
                    photograph_long: rawshim::px::Span::measured(
                        prepared.width.max(prepared.height),
                    ),
                    colour: colour.as_ref(),
                    white: levels.white,
                    source_level: levels.peak,
                    floor: levels.floor,
                    reference_nits: grade.reference_white_nits,
                    peak_nits: grade.peak_nits,
                    exposure,
                    // The fixture is the HDR still, which is what `run` above encodes.
                    // The camera's rendering, unadjusted: these fixtures pin the grade, and
                    // a slider set here would be pinning one reader's taste instead.
                    adjust: rawshim::gpu::Adjust::none(),
                    as_shot: None,
                    output: rawshim::gpu::Output::Pq,
                    geometry: rawshim::image::Geometry::none(),
                    window: None,
                    surround_window: None,
                    canvas: None,
                },
            );

            Snapshot::pq(&got, frame_size()).check(&format!("grade/{name}-ev{ev}"), GRADED);
        }
    }
}

/// The rolled arm, against its recorded frame.
///
/// Every rendition path passes the rolled frame around and encodes it itself, so this is the
/// output every encoder reads.
#[test]
fn the_rolled_arm_reproduces_the_recorded_grade() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!(
            "SKIPPED: no adapter answered, so the rolled arm was not run against its fixture."
        );
        return;
    };

    let grade = SHIPPED;
    let strengths = Strengths {
        sharpen: 0.3,
        defringe: 1.0,
    };
    let samples = scene();
    let levels = levels(gpu, &samples, WIDTH, HEIGHT, grade.white_quantile);

    for (name, colour) in [("neutral", None), ("matched", Some(matched()))] {
        for ev in [0.0f32, 1.0, -1.5] {
            // Stops, which is what the uniform carries now: `colour.slang` raises them, so a
            // gain here would be a second conversion on top of the shader's.
            let exposure = Stops::measured(f64::from(ev));
            let mut prepared = Prepared {
                samples: samples.clone(),
                width: WIDTH,
                height: HEIGHT,
                levels,
            };
            filter_once(&mut prepared, &grade, strengths);

            let got = gpu.encode(
                &prepared.samples,
                &rawshim::gpu::Grade {
                    width: prepared.width,
                    height: prepared.height,
                    photograph_long: rawshim::px::Span::measured(
                        prepared.width.max(prepared.height),
                    ),
                    colour: colour.as_ref(),
                    white: levels.white,
                    source_level: levels.peak,
                    floor: levels.floor,
                    reference_nits: grade.reference_white_nits,
                    peak_nits: grade.peak_nits,
                    exposure,
                    adjust: rawshim::gpu::Adjust::none(),
                    as_shot: None,
                    output: rawshim::gpu::Output::Rolled,
                    geometry: rawshim::image::Geometry::none(),
                    window: None,
                    surround_window: None,
                    canvas: None,
                },
            );

            Snapshot::signal(&got, frame_size(), grade.peak_nits)
                .check(&format!("grade/{name}-ev{ev}-rolled"), GRADED);
        }
    }
}

/// What a graded frame may be out by, in counts of 65535.
///
/// **The worst is loose on purpose**: near black the transfer is steep enough to turn the chroma
/// lattice's fixed-point filter weights, which vendors round differently, into tens of counts of
/// darkness no display resolves. Measured against the 3080, radv and lavapipe reach 87 on the
/// matched arm and 30 on the neutral one, which reads no lattice.
///
/// **The mean is the bound that says the grade has not moved**: a wrong matrix row or a moved knee
/// is worth hundreds of counts, where the widest an adapter costs is 3.5 - SwiftShader's filtering of
/// the lattice, on the matched arm; the hardware ones and lavapipe stay under one.
const GRADED: Tolerance = Tolerance {
    worst: 256,
    mean: 5.0,
};

/// What a frame no chroma lattice touched may be out by: measured, 1 count at worst.
const UNGRADED: Tolerance = Tolerance {
    worst: 32,
    mean: 0.1,
};

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
            // Three stops under the bright half, which is where `shadows` is rolling off
            // rather than flat. On the flat part every texel of a region takes the same weight
            // whether that weight was read off the pixel or the neighbourhood, so a ground
            // deep enough to be fully in would hide the difference this measures entirely.
            let ground = if x < BANDED / 2 { 3750.0 } else { 30000.0 };
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
    gpu: &'static rawshim::gpu::Gpu,
    haze: f64,
    adjust: rawshim::gpu::Adjust,
) -> Vec<u16> {
    graded_frame(gpu, banded(haze), BANDED, BANDED, adjust)
}

/// Clarity leaves the finest detail to texture, on a frame whose texel is not its pixel.
///
/// **Everything else here is 256 across, where a neighbourhood texel *is* a frame pixel**, so a
/// coarse reference that has collapsed onto the pixel is indistinguishable from one that has
/// not. At 2048 the step is four and the two part company: `blur.r - reference` stops being the
/// span between two blurs and becomes the fine detail with its sign flipped, so clarity turns
/// into a smoothing control - measured on a 61MP frame at that fault, +100 took the one-pixel
/// band *down* 15% and -100 put it *up* 18%, which is the slider running backwards.
///
/// The checker runs down the rows and the wave across the columns, so each band can be read
/// without the other: four rows of checker average out inside one texel, and a column mean has
/// nothing but the wave left in it.
#[test]
fn clarity_leaves_the_finest_band_to_texture() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the presence sliders were not run.");
        return;
    };
    const WIDE: usize = 2048;
    const TALL: usize = 128;
    let mut frame = vec![0u16; WIDE * TALL * 3];
    for y in 0..TALL {
        for x in 0..WIDE {
            let wave = (x as f64 * std::f64::consts::TAU / 64.0).sin();
            // A ratio, so the checker is the same number of stops wherever the wave has got to.
            let checker = 1.0 + 0.12 * ((y % 2) as f64 * 2.0 - 1.0);
            let level = (16000.0 + 6000.0 * wave) * checker;
            let at = (y * WIDE + x) * 3;
            for c in 0..3 {
                frame[at + c] = level.clamp(0.0, 65535.0) as u16;
            }
        }
    }

    let none = rawshim::gpu::Adjust::none();
    let graded = |adjust| graded_frame(gpu, frame.clone(), WIDE, TALL, adjust);
    let flat = graded(none);
    // The checker: neighbouring rows, which no texel of four can tell apart.
    let fine = |out: &[u16]| {
        let (mut total, mut count) = (0.0, 0u64);
        for y in 0..TALL - 1 {
            for x in (0..WIDE).step_by(4) {
                let at = |y: usize| f64::from(out[(y * WIDE + x) * 3]);
                total += (at(y) - at(y + 1)).abs();
                count += 1;
            }
        }
        total / count as f64
    };

    let lifted = fine(&graded(rawshim::gpu::Adjust {
        clarity: 100.0,
        ..none
    }));
    let lowered = fine(&graded(rawshim::gpu::Adjust {
        clarity: -100.0,
        ..none
    }));
    let was = fine(&flat);
    assert!(
        lifted > was * 0.95 && lowered < was * 1.05,
        "clarity took the one-pixel band from {was:.0} to {lifted:.0} at +100 and {lowered:.0} \
         at -100: it is acting on texture's band with the sign reversed, which is a coarse \
         reference evaluated against the pixel instead of against its texel",
    );
}

fn graded_frame(
    gpu: &'static rawshim::gpu::Gpu,
    frame: Vec<u16>,
    width: usize,
    height: usize,
    adjust: rawshim::gpu::Adjust,
) -> Vec<u16> {
    let grade = SHIPPED;
    let mut samples = frame;
    let levels = levels(gpu, &samples, width, height, grade.white_quantile);
    rawshim::hdr::code_base(&mut samples, levels.anchored(), grade.reference_white_nits);
    gpu.encode(
        &samples,
        &rawshim::gpu::Grade {
            width,
            height,
            photograph_long: rawshim::px::Span::measured(width.max(height)),
            colour: None,
            white: levels.white,
            source_level: levels.peak,
            floor: levels.floor,
            reference_nits: grade.reference_white_nits,
            peak_nits: grade.peak_nits,
            exposure: Stops::ZERO,
            adjust,
            // A daylight baseline, so the balance test has something to move away from. The
            // presence test leaves the pair unset, where this is not read at all.
            //
            // The tint is off zero on purpose: a camera's neutral is never exactly on the
            // Planckian locus, and a baseline that was would let a host standing a missing
            // tint up as zero pass by coincidence.
            as_shot: Some(rawshim::white_balance::AsShot {
                temperature: 5500.0,
                tint: 12.0,
            }),
            output: rawshim::gpu::Output::Rolled,
            geometry: rawshim::image::Geometry::none(),
            window: None,
            surround_window: None,
            canvas: None,
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
    let flat = graded_frame(gpu, split_ground(), BANDED, BANDED, none);
    let lifted = graded_frame(
        gpu,
        split_ground(),
        BANDED,
        BANDED,
        rawshim::gpu::Adjust {
            shadows: 100.0,
            ..none
        },
    );

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

    // Two-sided: on the roll-off's *upper* side the darker texel of each ripple takes the
    // larger weight, so a pointwise curve compresses the texture rather than stretching it.
    // Which way it goes depends on where the ground sits, and neither is what a shadows
    // control should do to a surface it is lifting.
    let (before, after) = (ripple(&flat) / was, ripple(&lifted) / now);
    assert!(
        after > before * 0.88 && after < before * 1.12,
        "shadows at +100 took the region's local contrast from {:.1}% of the mean to {:.1}%: it \
         is weighting the pixel rather than the region",
        before * 100.0,
        after * 100.0,
    );
}

/// A frame in three flat bands: blown, midtone, and dark.
///
/// **The blown band is one row, and that is the whole trick.** Diffuse white is the frame's own
/// 99.5th percentile (`fit_source.slang`'s `fit_levels`), so a band big enough to contain that percentile *is*
/// white however bright its samples are - a third of the frame at 60000 grades to zero stops,
/// not to blown, and the test below would then be comparing white against a midtone rather than
/// a blown sky against one. One row of 256 is 0.39% of the frame, which leaves the percentile
/// in the midtone band and puts this row about three stops over it.
fn three_grounds() -> Vec<u16> {
    let mut samples = vec![0u16; BANDED * BANDED * 3];
    for y in 0..BANDED {
        for x in 0..BANDED {
            // Four stops under the midtone band, which is where the trees in the scene this
            // was reported against sit.
            let level = if y == 0 {
                60000.0
            } else if y < BANDED / 2 {
                8000.0
            } else {
                500.0
            } as u16;
            let at = (y * BANDED + x) * 3;
            samples[at] = level;
            samples[at + 1] = level;
            samples[at + 2] = level;
        }
    }
    samples
}

/// Highlights must reach hardest into what is *most* blown, which a bell cannot do.
///
/// **This is the failure the shape was changed for.** A Gaussian falls away on both sides of
/// its centre, so the further above white a pixel sat, the less a highlights move did to it:
/// on this frame the blown band took a smaller share of the change than the midtone band did,
/// and pulling highlights down dimmed the subject while leaving the sky. Reported against a
/// backlit scene as "lowering highlights lowers almost everything", which is exactly what a
/// control weighted towards the midtones does.
///
/// So the claim is an ordering, not a value: the blown band moves, and it moves far more than
/// a band four stops under white - which is where the trees were. The constants in
/// `adjust.slang` are taste and are free to move under it.
///
/// The blown band is *not* compared against the midtone one, and that is not an omission. This
/// measures graded counts, and the roll-off compresses the top of the range by design, so a
/// scene gain of a stop and a half is worth fewer counts up there than it is in the middle
/// however even the tone curve's own weighting is. That difference is the roll-off doing its
/// job; the inversion this guards is in the weighting, and the dark band is where it shows.
#[test]
fn highlights_reaches_furthest_into_what_is_most_blown() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the tone group was not run.");
        return;
    };
    let none = rawshim::gpu::Adjust::none();
    let flat = graded_frame(gpu, three_grounds(), BANDED, BANDED, none);
    let pulled = graded_frame(
        gpu,
        three_grounds(),
        BANDED,
        BANDED,
        rawshim::gpu::Adjust {
            highlights: -100.0,
            ..none
        },
    );

    // The blown band is row zero; the other two are read well inside themselves.
    let band_at = |frame: &[u16], row: usize| f64::from(frame[(row * BANDED) * 3]);
    let share = |row: usize| {
        let (was, now) = (band_at(&flat, row), band_at(&pulled, row));
        (was - now) / was
    };
    let (blown, mid, dark) = (share(0), share(BANDED / 4), share(BANDED * 3 / 4));

    assert!(
        blown > 0.05,
        "highlights at -100 moved the blown band by {:.1}%, which is not a recovery",
        blown * 100.0,
    );
    assert!(
        blown > dark * 3.0,
        "highlights at -100 moved the blown band {:.1}% and a band four stops under white \
         {:.1}%: the weight is falling away above white, so the more blown a pixel is the less \
         it moves - and pulling the highlights down dims the subject instead of the sky",
        blown * 100.0,
        dark * 100.0,
    );
    assert!(
        dark < 0.05,
        "highlights at -100 moved a band four stops under white by {:.1}%, which is the \
         subject and not the highlights (the midtone band moved {:.1}%)",
        dark * 100.0,
        mid * 100.0,
    );
}

/// A frame in four flat bands at known stops under its own diffuse white: white itself, middle
/// grey, four stops down, and five and a half.
///
/// The top band is a tenth of the frame and every sample in it is equal, so the levels'
/// 99.5th percentile lands on that level exactly and the three below sit where this says they
/// sit. Each is wide enough to be read well away from a seam, which matters because the inner
/// pair weight by the neighbourhood and a neighbourhood at a seam is both bands.
fn four_grounds() -> Vec<u16> {
    let white = 32000.0;
    let mut samples = vec![0u16; BANDED * BANDED * 3];
    for y in 0..BANDED {
        for x in 0..BANDED {
            let level = if y < BANDED / 10 {
                white
            } else if y < BANDED * 2 / 5 {
                white * 0.18
            } else if y < BANDED * 7 / 10 {
                white / 16.0
            } else {
                white / 45.0
            } as u16;
            let at = (y * BANDED + x) * 3;
            samples[at] = level;
            samples[at + 1] = level;
            samples[at + 2] = level;
        }
    }
    samples
}

/// Neither of the inner pair may move the middle of the picture the way it moves its own end.
///
/// **This is what "lowering the highlights lowers the whole photograph" is, measured.** A
/// shoulder is flat past its centre and Gaussian back towards the middle, so the centre and the
/// width together decide how much of a slider named for one end lands on middle grey. Place the
/// centres against white rather than against the pivot and both inner zones are still most of the
/// way open there - which is a brightness control split across two sliders, and it leaves whites
/// and blacks looking like the pair that do what the reader wanted of the other two.
///
/// So the claim is a ratio, over both sliders at once: each moves the band it is named for
/// several times as far as it moves the middle grey one. The constants in `adjust.slang` are
/// taste and are free to move under it - five sits above what a set of centres placed against
/// white produces, which is a little over three.
#[test]
fn the_inner_pair_leave_middle_grey_to_the_exposure() {
    const REACH: f64 = 5.0;

    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the tone group was not run.");
        return;
    };
    let none = rawshim::gpu::Adjust::none();
    let graded = |adjust| graded_frame(gpu, four_grounds(), BANDED, BANDED, adjust);
    let flat = graded(none);
    let pulled = graded(rawshim::gpu::Adjust {
        highlights: -100.0,
        ..none
    });
    let lifted = graded(rawshim::gpu::Adjust {
        shadows: 100.0,
        ..none
    });

    let band_at = |frame: &[u16], row: usize| f64::from(frame[(row * BANDED) * 3]);
    let share = |frame: &[u16], row: usize| {
        let (was, now) = (band_at(&flat, row), band_at(frame, row));
        ((was - now) / was).abs()
    };
    // Rows well inside each band rather than at its edges, for the reason `four_grounds` gives.
    let (grey, deepest) = (BANDED / 4, BANDED * 17 / 20);

    let (white, middle) = (share(&pulled, BANDED / 20), share(&pulled, grey));
    assert!(
        white > middle * REACH,
        "highlights at -100 moved white {:.1}% and middle grey {:.1}%: a slider that reaches the \
         pivot like that is the exposure, and the reader has one of those already",
        white * 100.0,
        middle * 100.0,
    );

    let (deep, middle) = (share(&lifted, deepest), share(&lifted, grey));
    assert!(
        deep > middle * REACH,
        "shadows at +100 moved the deepest band {:.1}% and middle grey {:.1}%: the same inversion \
         at the bottom of the range",
        deep * 100.0,
        middle * 100.0,
    );
}

/// A photographic ladder - white, middle grey, four stops down, five and a half down - seen
/// through `haze` of airlight.
///
/// **Lifted rather than truncated, because that is what haze is and the difference is the whole
/// test.** `I = J*t + A*(1-t)` adds a constant to every pixel and scales what is left, so the
/// scene's midtone comes up with its floor: measured on the frame this models, the darkest tone
/// sits 1.36 stops under diffuse white and nothing in the picture is anywhere near 0.18 of it. A
/// frame that kept a true 18% grey and merely stopped early is a different photograph, and one
/// where the reader would be right to want Blacks to leave that grey alone.
///
/// The top band is a sixth of the frame so the white quantile lands inside it whatever the library
/// is set to, which is what puts the others a known distance under diffuse white.
fn hazed_grounds(haze: f64) -> Vec<u16> {
    let white = 40000.0;
    let lifted = |scene: f64| scene * (1.0 - haze) + white * haze;
    let mut samples = vec![0u16; BANDED * BANDED * 3];
    for y in 0..BANDED {
        for x in 0..BANDED {
            let scene = if y < BANDED / 6 {
                white
            } else if y < BANDED * 4 / 9 {
                white * 0.18
            } else if y < BANDED * 7 / 10 {
                white / 16.0
            } else {
                white / 45.0
            };
            let level = lifted(scene) as u16;
            let at = (y * BANDED + x) * 3;
            samples[at] = level;
            samples[at + 1] = level;
            samples[at + 2] = level;
        }
    }
    samples
}

/// Blacks reaches the bottom of the picture it is handed, not the bottom of a range it assumed.
///
/// **This is the haze failure, and placing the low pair against the frame's own span is the fix.**
/// A slider named for an end of the range has to find that end, and where the end is is a property
/// of the photograph: a frame shot through smog has its darkest tone a stop and a half under
/// diffuse white where a frame with shadow in it has one at five and a half. Pinned at five and a
/// half, Blacks sits below everything the hazy frame contains and is a control the reader cannot
/// find.
///
/// **What the pair of frames is for, and why the two are asked different questions.** The scaling
/// has to fix the hazy frame without loosening the clear one, and those are opposite failures: a
/// placement pinned at a constant does nothing to the hazy frame's bottom, and one that reached
/// that bottom by widening rather than scaling would take a clear frame's midtone with it. So the
/// clear frame carries the "not the exposure" half, where its midtone is a full two and a half
/// stops clear of its floor and a control has room to tell them apart.
///
/// **The hazy frame cannot carry that half, and it is worth saying why rather than asserting it
/// somewhere it does not hold.** Lifted this far, its 18% grey sits a third of a stop above its
/// floor - so *no* placement reaches the bottom of that picture without touching its middle, and
/// one that did not touch the middle would not have reached the bottom either. What is still true
/// of it, and is what "an end and not the exposure" means on a frame that narrow, is that Blacks
/// dies before diffuse white.
#[test]
fn blacks_reaches_the_bottom_of_a_hazy_frame() {
    const MOVES_ITS_OWN_END: f64 = 0.25;
    const LEAVES_WHAT_IT_IS_NOT_NAMED_FOR: f64 = 5.0;

    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the tone group was not run.");
        return;
    };
    let none = rawshim::gpu::Adjust::none();
    let pulled_over = |haze: f64| {
        let frame = hazed_grounds(haze);
        let graded = |adjust| graded_frame(gpu, frame.clone(), BANDED, BANDED, adjust);
        let flat = graded(none);
        let pulled = graded(rawshim::gpu::Adjust {
            blacks: -100.0,
            ..none
        });
        // Rows well inside each band rather than at its edges, where the neighbourhood is mixed.
        move |row: usize| {
            let at = |frame: &[u16]| f64::from(frame[(row * BANDED) * 3]);
            let (was, now) = (at(&flat), at(&pulled));
            ((was - now) / was).abs()
        }
    };
    let (white, midtone, bottom) = (BANDED / 12, BANDED / 3, BANDED * 17 / 20);

    // 0.376 of airlight, which puts this frame's floor 1.36 stops under its white - what
    // `DSC04151.ARW`, the photograph this was reported on, measures.
    let hazy = pulled_over(0.376);
    assert!(
        hazy(bottom) > MOVES_ITS_OWN_END,
        "blacks at -100 moved the bottom of a hazy frame by {:.1}%, which is a control the reader \
         cannot find",
        hazy(bottom) * 100.0,
    );
    assert!(
        hazy(bottom) > hazy(white) * LEAVES_WHAT_IT_IS_NOT_NAMED_FOR,
        "blacks at -100 moved the hazy frame's bottom {:.1}% and its diffuse white {:.1}%: a \
         slider that reaches white is the exposure however narrow the picture is",
        hazy(bottom) * 100.0,
        hazy(white) * 100.0,
    );

    let clear = pulled_over(0.0);
    assert!(
        clear(bottom) > MOVES_ITS_OWN_END,
        "blacks at -100 moved a clear frame's bottom by {:.1}%",
        clear(bottom) * 100.0,
    );
    assert!(
        clear(bottom) > clear(midtone) * LEAVES_WHAT_IT_IS_NOT_NAMED_FOR,
        "blacks at -100 moved a clear frame's bottom {:.1}% and its middle grey {:.1}%: scaling \
         the low pair onto a hazy frame must not widen them on a frame that never needed it",
        clear(bottom) * 100.0,
        clear(midtone) * 100.0,
    );
}

/// A flat field with a dark, heavily textured block down its left. The rock and the sky.
///
/// Three properties, and the artefact needs all of them:
///
///   - **Wider than `DETAIL_LONG`.** The neighbourhood is fitted at a 512px working resolution,
///     so on a frame at or under that the working texture *is* the frame and nothing is
///     upsampled at all. At 1536 across, one working texel is three frame pixels.
///   - **The dark side is textured and the bright side is not.** This is the part that is easy
///     to leave out and fatal to leave out. With both sides flat the fit reproduces its input
///     everywhere - `a` goes to one at the seam and to zero away from it, and the intercept
///     makes up the difference exactly - so there is no band to find. Texture on one side gives
///     those windows a slope of their own, and the intercept they carry is a share of the *dark*
///     mean. Averaged into the coefficients of a bright pixel nearby, that is the band.
///   - **The field sits where the tone control is rolling off.** On the flat part of a shoulder
///     every neighbourhood lands on the same weight whatever it is, so the error would be
///     invisible. One row of blown white anchors diffuse white two stops above the field.
const EDGE_WIDE: usize = 1536;
const EDGE_TALL: usize = 128;

/// The blown row that anchors diffuse white, which is also the airlight the lift below works to.
const EDGE_WHITE: f64 = 60000.0;

fn hard_edge(haze: f64) -> Vec<u16> {
    let mut samples = vec![0u16; EDGE_WIDE * EDGE_TALL * 3];
    for y in 0..EDGE_TALL {
        for x in 0..EDGE_WIDE {
            let scene = if y == 0 {
                EDGE_WHITE
            } else if x < EDGE_WIDE / 3 {
                700.0 * (1.0 + 0.5 * (((x + y) % 2) as f64 * 2.0 - 1.0))
            } else {
                15000.0
            };
            // The anchor is the fixed point either way, so the frame's white does not move and
            // `haze` is exactly how far its floor comes up.
            let level = (scene * (1.0 - haze) + EDGE_WHITE * haze) as u16;
            let at = (y * EDGE_WIDE + x) * 3;
            samples[at] = level;
            samples[at + 1] = level;
            samples[at + 2] = level;
        }
    }
    samples
}

/// A tone control must not leave a band along an edge, which is what a halo is.
///
/// **The neighbourhood is fitted small and read large, and that is where a halo comes from.**
/// The filter runs at a 512px working resolution with its coefficients averaged over about
/// eight texels of it, so the field it produces has a transition a couple of hundred frame
/// pixels wide around any strong edge. Read with a plain bilinear fetch, a pixel of the bright
/// side inside that band gets a neighbourhood part bright and part dark, so its offset from
/// that neighbourhood is non-zero where the offset further out is zero - and the two land on
/// different tone weights. A strip of sky graded differently from the rest of the sky, which is
/// exactly what was reported along a rock at highlights -100.
///
/// So: pull the highlights down hard and walk out from the edge. Every column of the bright
/// side must land where the far side of it landed. The tolerance is in counts of the graded
/// frame rather than a share, because what is being looked for is a visible band on a flat
/// field and the eye finds those at well under a percent.
#[test]
fn a_tone_control_leaves_no_band_along_an_edge() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the tone group was not run.");
        return;
    };
    let none = rawshim::gpu::Adjust::none();
    // **Both ends, and the hazy one is not decoration.** A zone's shoulder narrows with the
    // frame's span, so on a frame whose floor is most of the way up to its
    // white the inner pair read the guided filter's field through a weight several times as
    // steep - and print that field's own structure onto a flat surface. The clear frame cannot
    // catch it, because at a full span the shoulders are the width the shape was drawn for.
    for (name, frame, adjust, tolerance) in [
        (
            "highlights at -100",
            hard_edge(0.0),
            rawshim::gpu::Adjust {
                highlights: -100.0,
                ..none
            },
            0.01,
        ),
        (
            "shadows at +100 on a frame with 0.7 of a stop in it",
            hard_edge(0.6),
            rawshim::gpu::Adjust {
                shadows: 100.0,
                ..none
            },
            0.02,
        ),
    ] {
        let pulled = graded_frame(gpu, frame, EDGE_WIDE, EDGE_TALL, adjust);

        // Row zero is the strip that anchors white, so it is not part of the field being measured.
        let column = |x: usize| {
            let mut total = 0.0;
            for y in 1..EDGE_TALL {
                total += f64::from(pulled[(y * EDGE_WIDE + x) * 3]);
            }
            total / (EDGE_TALL - 1) as f64
        };
        // The far side of the bright field, which is what the rest of it should match.
        let settled = column(EDGE_WIDE - 4);
        // From a few columns clear of the seam outwards. The seam itself is left out: a working
        // texel spans several frame pixels whatever the upsample does with them, so the columns
        // adjacent to a hard edge are genuinely a mixture rather than a defect.
        //
        // **A looser bound on the hazy frame, and the frame is the reason rather than the
        // control.** Its two sides are a fifth of a stop apart and a slider on it is worth a fifth
        // of a stop, so the mixture across the filter's own transition is a real step there where
        // on a clear frame it is nothing. Measured at the sixth column: 1.22% of the field with
        // the worth taken from the reach, 3.37% with it left whole. Two sits between the two and
        // near neither, so this still fails on a shoulder whose gain did not narrow with it -
        // which is what put milky patches over the tree canopies of a 1.36-stop photograph.
        //
        // 1.22% on both a 3080 and radv, so the bound is the arithmetic's rather than one
        // adapter's - which the clear frame's own reading is not, at 0.53% against 0.56%.
        //
        // The gap is what it is because `low_reach` already widens the shoulder, so leaving the
        // worth whole oversteepens by `1/reach` rather than `1/span`. Widen the reach further and
        // this margin closes; that is the thing to re-measure if it moves.
        let mut worst = 0.0f64;
        let mut worst_at = 0usize;
        for x in (EDGE_WIDE / 3 + 6)..(EDGE_WIDE - 4) {
            let off = (column(x) - settled).abs();
            if off > worst {
                worst = off;
                worst_at = x;
            }
        }
        if worst >= settled * tolerance {
            let profile: Vec<String> = (0..24)
                .map(|i| {
                    let x = EDGE_WIDE / 3 + i * 4;
                    format!("{x}:{:.0}", column(x))
                })
                .collect();
            panic!(
                "{name} left column {worst_at} {worst:.0} counts off the {settled:.0} the rest of \
                 the flat side settled at: that is a band along the edge\n  {}",
                profile.join(" "),
            );
        }
    }
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
        graded_banded(
            gpu,
            0.0,
            rawshim::gpu::Adjust {
                temperature,
                tint,
                ..none
            },
        )
    };

    // The baseline `graded_banded` declares. Asking for it by name has to be the same picture
    // as not asking at all, to the byte: the shader solves both illuminants through the same
    // search, so anything else means the pair is not a pure ratio.
    assert_eq!(
        at(Some(5500.0), Some(12.0)),
        at(None, None),
        "as shot is not identity"
    );

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

    // And the brightness, which the renormalisation in `white_balance.slang` exists to hold.
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
/// These three read `detail.slang`'s blur rather than the pixel, and nothing above can say
/// anything about them: the fixtures are pinned at `Adjust::none`, so a blur that came back
/// empty, a coordinate that pointed at the wrong texel, or a pass that never ran would leave
/// every one of them green. What is asserted is the *direction and the band*, not a value -
/// the constants in `adjust.slang` are taste and should be free to move.
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
        (
            "texture",
            1usize,
            rawshim::gpu::Adjust {
                texture: 100.0,
                ..none
            },
            rawshim::gpu::Adjust {
                texture: -100.0,
                ..none
            },
        ),
        (
            "clarity",
            8,
            rawshim::gpu::Adjust {
                clarity: 100.0,
                ..none
            },
            rawshim::gpu::Adjust {
                clarity: -100.0,
                ..none
            },
        ),
    ] {
        let (was, lifted, lowered) = (
            band(&flat, apart),
            band(&graded(0.0, up), apart),
            band(&graded(0.0, down), apart),
        );
        assert!(
            lifted > was * 1.1,
            "{name} at +100 took the {apart}-column band from {was:.1} to {lifted:.1}",
        );
        assert!(
            lowered < was * 0.9,
            "{name} at -100 took the {apart}-column band from {was:.1} to {lowered:.1}",
        );
    }

    let coarse = band(
        &graded(
            0.0,
            rawshim::gpu::Adjust {
                texture: 100.0,
                ..none
            },
        ),
        8,
    );
    let was = band(&flat, 8);
    assert!(
        coarse < was * 1.05,
        "texture at +100 moved the coarse band from {was:.1} to {coarse:.1}, which is \
         clarity's to move",
    );

    // Dehaze on a frame that has some: the model subtracts a neutral airlight and divides by
    // what is left, so the floor drops and everything above it spreads out.
    let hazy = graded(0.45, none);
    let cleared = graded(
        0.45,
        rawshim::gpu::Adjust {
            dehaze: 100.0,
            ..none
        },
    );
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

/// Clearing the haze changes what Shadows is worth, because the span is read off the recovered scene.
///
/// **Without that, the dehaze slider cannot reach the low pair at all - not weakly, not at all.**
/// What the pair are worth and where they sit are functions of two things, the pixel's place on
/// the axis and the frame's floor, and both are measured off the frame as it arrived. Dehaze
/// changes neither, so the gain comes out the same number whatever the slider says and only the
/// luma it multiplies has moved. A reader who clears a photograph to open two stops of shadow and
/// then reaches for Shadows is grading against the veil they just removed.
///
/// **Asked of Shadows rather than Blacks, and the reason is `low_reach`.** Both are placed on the
/// recovered scene, but the outer pair keep their whole worth and only widen - and widening a
/// shoulder by the same factor its centre moved leaves the weight at a *proportional* position
/// almost where it was, so Blacks reads 0.309 against 0.310 and says nothing. Shadows takes its
/// worth from the reach, which is the square root of the span, so a frame whose span more than
/// doubles when it is cleared is a frame where Shadows is worth half as much again.
#[test]
fn clearing_the_haze_changes_what_shadows_is_worth() {
    // Measured 1.992 veiled against 2.883 cleared, 45% apart, where a frame placed as it arrived
    // reads the same number twice. A tenth is clear of both and leaves `adjust.slang`'s constants
    // the room they are meant to have.
    const MOVED: f64 = 0.10;

    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the tone group was not run.");
        return;
    };
    let none = rawshim::gpu::Adjust::none();
    let hazy = hazed_grounds(0.376);
    // The bottom band, which Shadows is flat in for at either reading - so what is being compared
    // is what the slider is worth and not where its roll-off happens to fall.
    let bottom = BANDED * 17 / 20;
    let worth_at = |dehaze: f64| {
        let at = |shadows: f64| {
            let frame = graded_frame(
                gpu,
                hazy.clone(),
                BANDED,
                BANDED,
                rawshim::gpu::Adjust {
                    shadows,
                    dehaze,
                    ..none
                },
            );
            f64::from(frame[(bottom * BANDED) * 3])
        };
        at(100.0) / at(0.0)
    };
    // Enough to open the shadows well clear of the veil, and short of where the model's floor on
    // this frame clamps everything under the airlight to black.
    let (veiled, cleared) = (worth_at(0.0), worth_at(30.0));

    assert!(
        cleared > veiled * (1.0 + MOVED),
        "shadows at +100 lifted the bottom band {veiled:.3}x with the haze left in and \
         {cleared:.3}x with it cleared: a pair the dehaze cannot move is a pair placed and sized \
         on the frame as it arrived rather than on the picture the reader is looking at",
    );
}

/// Texture is worth the same whatever the contrast, which is what running it before the curve buys.
///
/// **The ordering of the two groups has exactly one observable, and this is it.** A zone's weight
/// is read off the frame's own stops rather than off the value being carried, so all four of them
/// are gains, and gains commute with the band texture adds - reorder those and not a pixel moves.
/// The contrast is a power about the pivot and does not commute.
///
/// Write the curve as `l^p` and let texture steepen the local swing by `g`, so a pixel that was
/// `m(1±a)` leaves as `m(1±a)^(p+g)` with the bands added after the curve and `m(1±a)^(p(1+g))`
/// with them added before. Divide each by the same frame without texture, whose band goes as `p`
/// either way, and the two orders separate cleanly:
///
/// - bands last: `1 + g/p`, so texture is worth less and less as the reader raises contrast
/// - bands first: `1 + g`, flat, because the curve took the added detail along with everything
///   around it
///
/// So the assertion is that the ratio does not move with contrast, and it needs no constant from
/// `adjust.slang` to make it - which is what lets the taste in there stay free. Measured on this
/// frame it is 1.878 at every contrast; ordered the other way it would read 2.33 at -100 and 1.58
/// at +100.
#[test]
fn texture_is_worth_the_same_whatever_the_contrast() {
    // A twentieth, against ratios that would otherwise sit a quarter and a half apart.
    const FLAT: f64 = 0.05;

    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the tone group was not run.");
        return;
    };
    let none = rawshim::gpu::Adjust::none();
    // The one-column band, which is the checker that texture's own band acts on.
    let worth_at = |contrast: f64| {
        let at = |texture: f64| {
            band(
                &graded_banded(
                    gpu,
                    0.0,
                    rawshim::gpu::Adjust {
                        texture,
                        contrast,
                        ..none
                    },
                ),
                1,
            )
        };
        at(100.0) / at(0.0)
    };
    let (flat, compressed, expanded) = (worth_at(0.0), worth_at(-100.0), worth_at(100.0));

    for (name, curved) in [("-100", compressed), ("+100", expanded)] {
        assert!(
            (curved - flat).abs() < flat * FLAT,
            "texture at +100 was worth {flat:.3}x the one-column band at contrast 0 and \
             {curved:.3}x at contrast {name}: a slider whose worth moves with the contrast is one \
             whose detail the curve never went through, which is the presence group running after \
             the light group",
        );
    }
}

/// The same dispatch's SDR arm, against its committed answer.
///
/// An SDR rendition is not a second pipeline - `job::peak_nits` puts its peak at diffuse
/// white and the same grade rolls the highlights into it - so what needs checking is only
/// the end: the sRGB primaries and transfer at 8 bits, where the still writes PQ at 16.
/// Its own test because the peak differs, and with it every value in the frame.
#[test]
fn the_encode_pass_reproduces_the_recorded_sdr_frame() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the sRGB arm was not run against its fixture.");
        return;
    };

    // `peak_nits` at the reference white, which is the whole of what `job::peak_nits` does
    // for an SDR target.
    let grade = hdr::Grade {
        peak_nits: Light::exactly(203.0),
        ..SHIPPED
    };
    let strengths = Strengths {
        sharpen: 0.3,
        defringe: 1.0,
    };
    let samples = scene();
    let levels = levels(gpu, &samples, WIDTH, HEIGHT, grade.white_quantile);

    for (name, colour) in [("neutral", None), ("matched", Some(matched()))] {
        let mut prepared = Prepared {
            samples: samples.clone(),
            width: WIDTH,
            height: HEIGHT,
            levels,
        };
        filter_once(&mut prepared, &grade, strengths);

        let described = rawshim::gpu::Grade {
            width: prepared.width,
            height: prepared.height,
            photograph_long: rawshim::px::Span::measured(prepared.width.max(prepared.height)),
            colour: colour.as_ref(),
            white: levels.white,
            source_level: levels.peak,
            floor: levels.floor,
            reference_nits: grade.reference_white_nits,
            peak_nits: grade.peak_nits,
            exposure: Stops::ZERO,
            adjust: rawshim::gpu::Adjust::none(),
            as_shot: None,
            output: rawshim::gpu::Output::Srgb,
            geometry: rawshim::image::Geometry::none(),
            window: None,
            surround_window: None,
            canvas: None,
        };
        let peak = gpu.scene_peak();
        let up = gpu.upload(&prepared.samples, &described, &peak);

        // The sRGB arm writes 8-bit in the low byte of each `u16`, so the committed answer is
        // bytes and this is the one place the two differ in width. **Read as bytes off the
        // mapping**, which is what a rendition takes: reading the picture as counts and converting
        // afterwards holds both widths of it at once - 446MB beside 223MB on a 16384-wide canvas -
        // so the two routes have to be the same picture, or an SDR rendition is whatever the
        // narrower one happened to do.
        let got = up.encode_bytes(&described);
        assert_eq!(
            got,
            up.encode(&described)
                .iter()
                .map(|v| *v as u8)
                .collect::<Vec<u8>>(),
            "sdr-{name}: the bytes read back are not the counts the same pass writes",
        );
        // Two 8-bit counts at worst and a tenth of one on average, widened as a snapshot holds
        // them: this is the output a viewer looks at directly, and one count shows on a gradient.
        let sdr = Tolerance {
            worst: 2 * 257,
            mean: 0.1 * 257.0,
        };
        Snapshot::srgb(&got, frame_size()).check(&format!("grade/{name}-sdr"), sdr);
    }
}

/// A crop on a whole-pixel boundary is the rectangle it names.
///
/// **The claim a cropped export rests on**: the same route with the crop taken off. Nothing about
/// the picture inside a crop is a function of the crop - the levels, the peak and the colour all
/// belong to the photograph - so a reader who crops must get the pixels they already had, in the
/// place they already were.
///
/// **Whole-pixel on purpose.** The crop's edges are fractions and land anywhere, so a general one
/// resamples and there would be nothing exact to compare against; put on a pixel boundary,
/// `geometry_at`'s origin and stride come out integral and the Catmull-Rom weights are
/// `(0, 1, 0, 0)`. What that leaves under test is the indexing - the dispatch over the output, the
/// origin, the stride, the readback's width - which is what a crop actually changes, and which
/// fails by moving the whole rectangle rather than by a count.
#[test]
fn a_crop_on_a_pixel_boundary_is_the_rectangle_it_names() {
    let Some(gpu) = rawshim::gpu::device() else {
        return;
    };

    let (width, height) = (192usize, 128);
    let frame: Vec<u16> = (0..width * height)
        .flat_map(|at| {
            let (x, y) = (at % width, at / width);
            let value = ((x * 271 + y * 733) % 60_000 + 2_000) as u16;
            [value, value / 2, value / 3]
        })
        .collect();

    let settings = SHIPPED;
    let levels = levels(gpu, &frame, width, height, settings.white_quantile);
    let mut coded = frame.clone();
    rawshim::hdr::code_base(&mut coded, levels.anchored(), settings.reference_white_nits);

    let grading = |geometry: rawshim::image::Geometry| rawshim::gpu::Grade {
        width,
        height,
        photograph_long: rawshim::px::Span::measured(width.max(height)),
        colour: None,
        white: levels.white,
        source_level: levels.peak,
        floor: levels.floor,
        reference_nits: settings.reference_white_nits,
        peak_nits: settings.peak_nits,
        exposure: Stops::ZERO,
        adjust: rawshim::gpu::Adjust::none(),
        as_shot: None,
        output: rawshim::gpu::Output::Rolled,
        geometry,
        window: None,
        surround_window: None,
        canvas: None,
    };

    let whole = gpu.encode(&coded, &grading(rawshim::image::Geometry::none()));

    // Eighths and quarters, so every edge lands on a whole pixel of a 192x128 frame.
    for crop in [
        [0.25, 0.25, 0.75, 0.75],
        [0.0, 0.5, 0.5, 1.0],
        [0.625, 0.0, 1.0, 0.25],
    ] {
        let geometry = rawshim::image::Geometry {
            crop,
            ..rawshim::image::Geometry::none()
        };
        let grade = grading(geometry);
        let (out_width, out_height) = grade.output_size();
        let (left, top) = (
            (crop[0] * width as f64).round() as usize,
            (crop[1] * height as f64).round() as usize,
        );
        assert_eq!(
            (out_width, out_height),
            (
                ((crop[2] - crop[0]) * width as f64).round() as usize,
                ((crop[3] - crop[1]) * height as f64).round() as usize,
            ),
            "the crop {crop:?} came out the wrong size",
        );

        let cropped = gpu.encode(&coded, &grade);
        assert_eq!(
            cropped.len(),
            out_width * out_height * 3,
            "the readback is the wrong length"
        );
        let (mut differing, mut worst) = (0usize, 0u32);
        for row in 0..out_height {
            for column in 0..out_width {
                for channel in 0..3 {
                    let from = ((top + row) * width + left + column) * 3 + channel;
                    let to = (row * out_width + column) * 3 + channel;
                    let off = u32::from(cropped[to].abs_diff(whole[from]));
                    if off > 0 {
                        differing += 1;
                    }
                    worst = worst.max(off);
                }
            }
        }
        // **Placement is exact and the rounding is not, which is the whole claim.** Every sample
        // but a handful comes back identical, so the crop reads the pixels it names rather than
        // ones near them - a placement error is not a scattered count, it is every sample in the
        // rectangle. What is left is the last bit of a `round` into 65535 flipping where the two
        // dispatches reach it by slightly different arithmetic, and one count of 65535 is the
        // tolerance every GPU pin in this file already carries.
        let samples = out_width * out_height * 3;
        eprintln!("  crop {crop:?}: {differing} of {samples} differing, worst {worst}");
        assert!(
            worst <= 1,
            "crop {crop:?} is {worst} counts from the rectangle it names"
        );
        assert!(
            differing * 1000 < samples,
            "crop {crop:?} moved {differing} of {samples} samples, which is a placement error \
             rather than a rounding one",
        );
    }
}

const PANO_LEFT: usize = 120;
const PANO_TOP: usize = 80;
const PANO_WIDE: usize = 96;
const PANO_TALL: usize = 64;

/// Two synthetic 16-bit PNGs a degree apart, and the recipe that places them.
///
/// Written to a temporary directory rather than committed: a decodable source is what
/// `composite_tile::prepared` needs, and two 300x200 frames regenerate in milliseconds where two
/// files in the repo are two more things to keep current.
///
/// **PNG, not TIFF.** `rawler`'s `get_decoder` dispatches a TIFF purely by its `Make` tag or a
/// known magic (`decoders/mod.rs`), and has no fallback for a bare RGB TIFF with neither - a
/// synthetic file written by a minimal encoder would fail to decode at all, and `tiff_write.rs`
/// exports only an 8-bit `encode`. `decode_rendered::is_rendered` already treats `.png` as a
/// finished picture, which both decodes a 16-bit source outright and is what puts a
/// `From::Original` source through `Through::Corrected` at `composite_tile.rs`'s own check - the
/// geometry this fixture wants, since there is no lens to undo. `png_write::encode_hdr` already
/// writes exactly that (16-bit, `cICP`-tagged) for the HDR still export, so this needs no new
/// dependency and no TIFF writer of its own.
fn pano_of_two() -> (Composition, Vec<String>) {
    let dir = std::env::temp_dir().join("bowerbird-pano-fixture");
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    let (w, h) = (300usize, 200usize);
    let paths: Vec<String> = (0..2)
        .map(|i| {
            let path = dir.join(format!("pano-{i}.png"));
            let mut samples = vec![0u16; w * h * 3];
            for y in 0..h {
                for x in 0..w {
                    // A ramp across, a step down, and jitter, so the feather has an edge to blend
                    // and the blend has texture to double if it ever gathers twice.
                    let ramp = (x as f64 / w as f64) * 40000.0 + 2000.0;
                    let step = if y > h / 2 { 9000.0 } else { 0.0 };
                    let jitter =
                        (((x * 7919 + y * 104729 + i * 31) % 211) as f64 / 211.0 - 0.5) * 700.0;
                    let code = (ramp + step + jitter).clamp(0.0, 65535.0) as u16;
                    let at = (y * w + x) * 3;
                    samples[at] = code;
                    samples[at + 1] = code.saturating_sub(400);
                    samples[at + 2] = code.saturating_add(300).min(65535);
                }
            }
            let png = rawshim::png_write::encode_hdr(&samples, w, h).expect("a fixture source");
            std::fs::write(&path, &png).expect("writing the fixture source");
            path.to_string_lossy().into_owned()
        })
        .collect();

    let mut spec = Composition::of_one([w, h], LensSpec::none());
    let mut second = spec.sources[0].clone();
    second.rotation = turned_about_y(1.0f64.to_radians());
    spec.sources.push(second);
    // Wide enough that the window sits across the overlap, which is what the feather decides.
    spec.canvas = [w + 60, h];
    spec.centre = [(w + 60) as f64 / 2.0, h as f64 / 2.0];
    (spec, paths)
}

/// `[w, x, y, z]` for a turn of `radians` about the world's up axis.
fn turned_about_y(radians: f64) -> [f64; 4] {
    [(radians / 2.0).cos(), 0.0, (radians / 2.0).sin(), 0.0]
}

fn read_codes(frame: &Resident) -> Vec<u16> {
    pollster::block_on(frame.host()).expect("a readable window")
}

/// A window of a two-source panorama, pinned.
///
/// **Nothing else holds a panorama's pixels.** The gather, the feather and the blend are three
/// shaders a render goes through and no suite compares their output to a recorded answer, so a
/// change to any of them - the weight's source, `FEATHER_POWER`, the accumulator's order - is
/// invisible until somebody looks at a photograph. This is the answer the next change is held to.
///
/// Two sources turned a degree apart about the canvas centre, so the window holds ground only the
/// first reaches, ground only the second reaches, and an overlap the feather has to decide.
#[test]
fn a_panorama_window_reproduces_the_recorded_frame() {
    let Some(_) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the panorama window was not run.");
        return;
    };
    let (spec, paths) = pano_of_two();
    let window = rawshim::px::Rect::exact(PANO_LEFT, PANO_TOP, PANO_WIDE, PANO_TALL);
    let sources: Vec<SourceFile<'_>> = paths
        .iter()
        .map(|p| SourceFile {
            path: p,
            analysis: None,
        })
        .collect();
    let request = CompositeRequest {
        window,
        parts: &[],
        scale: 1.0,
        white_quantile: SHIPPED.white_quantile,
        levels: None,
        reference_white_nits: SHIPPED.reference_white_nits,
        strengths: Strengths {
            sharpen: 0.0,
            defringe: 0.0,
        },
        detail: rawshim::galosh::Detail::at(0.0, 0.0),
        sources: &sources,
        from: From::Original,
        mask: None,
    };
    let (window_out, _) =
        pollster::block_on(rawshim::composite_tile::prepared(&spec, &request)).expect("a window");
    let got = read_codes(&window_out);
    Snapshot::pq(&got, window.size).check("composite/panorama-window", UNGRADED);
}

/// The canvas the assembly fixture is carved on, and the window of it that is pinned.
///
/// **Wide enough that `W_MAX` of it clears the high band**: `W_MAX` is a share of the long edge and
/// `W_HIGH_PX` is render pixels, so on a canvas under 200px every corridor resolves to the same
/// number and the fixture would pin the feather's width against nothing.
const ASSEMBLY_CANVAS: (usize, usize) = (640, 384);
const ASSEMBLY_WINDOW: (usize, usize, usize, usize) = (220, 120, 160, 48);

/// Three synthetic 16-bit PNGs and the composition that places them, all on one geometry.
///
/// A different level and a different chequer offset each, so which frame a tile took is readable
/// off the bytes rather than inferrable only from their sum; one geometry, because what this pins
/// is §5's render and every source covering every pixel is what leaves the mask deciding alone.
fn assembly_of_three() -> (Composition, Vec<String>) {
    let dir = std::env::temp_dir().join("bowerbird-assembly-fixture");
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    let (w, h) = ASSEMBLY_CANVAS;
    let paths: Vec<String> = (0..3)
        .map(|i| {
            let path = dir.join(format!("assembly-{i}.png"));
            let mut samples = vec![0u16; w * h * 3];
            for y in 0..h {
                for x in 0..w {
                    let ramp = (x as f64 / w as f64) * 30000.0 + 3000.0;
                    let step = if y > h / 2 { 7000.0 } else { 0.0 };
                    let mine = 5000.0 * i as f64;
                    // 37 rather than a power of two, so no chequer edge lands on a tile's own edge:
                    // a step in the content exactly under a seam makes the two bands' answer there
                    // impossible to read by eye, which is what a fixture is looked at for.
                    let patch = match (x / 37 + y / 37) % 3 == i {
                        true => 9000.0,
                        false => 0.0,
                    };
                    let jitter =
                        (((x * 7919 + y * 104729 + i * 31) % 211) as f64 / 211.0 - 0.5) * 700.0;
                    let code = (ramp + step + mine + patch + jitter).clamp(0.0, 65535.0) as u16;
                    let at = (y * w + x) * 3;
                    samples[at] = code;
                    samples[at + 1] = code.saturating_sub(400);
                    samples[at + 2] = code.saturating_add(300).min(65535);
                }
            }
            let png = rawshim::png_write::encode_hdr(&samples, w, h).expect("a fixture source");
            std::fs::write(&path, &png).expect("writing the fixture source");
            path.to_string_lossy().into_owned()
        })
        .collect();

    let mut spec = Composition::of_one([w, h], LensSpec::none());
    let one = spec.sources[0].clone();
    spec.sources.extend(std::iter::repeat_n(one, 2));
    (spec, paths)
}

/// Two tiles over a base, each picking a different frame, built by hand.
///
/// **By hand rather than through `analyse`**: what is pinned is the render, and running the
/// analysis inside the fixture would make every change to §3 a change to §5's answer.
///
/// The two corridors are either side of `W_MAX`, so one feather is the corridor's own half-width
/// and the other is the cap - two widths rather than one number twice.
fn two_tiles_picking_two_frames(spec: Composition) -> rawshim::assembly::Drawing {
    let (w, h) = (spec.canvas[0] as f32, spec.canvas[1] as f32);
    rawshim::assembly::Drawing {
        spec,
        vertices: vec![
            [w * 0.10, h * 0.20],
            [w * 0.40, h * 0.20],
            [w * 0.40, h * 0.80],
            [w * 0.10, h * 0.80],
            [w * 0.55, h * 0.10],
            [w * 0.90, h * 0.10],
            [w * 0.90, h * 0.60],
            [w * 0.55, h * 0.60],
        ],
        tiles: vec![vec![0, 1, 2, 3], vec![4, 5, 6, 7]],
        pick: vec![1, 2],
        base: 0,
        corridor: vec![0.01, 0.5],
        // The identity, and no correction: this fixture is what the blend's own pins are recorded
        // against, so either of them here would move every pixel of it for a reason that has
        // nothing to do with §5.2.
        warp: vec![rawshim::composition::no_warp().map(|at| at as f32); 2],
        gain: vec![rawshim::light::Gain::ONE; 2],
        feather: 0.01,
    }
}

fn assembly_request<'a>(
    sources: &'a [SourceFile<'a>],
    window: rawshim::px::Rect<rawshim::px::Composite>,
) -> CompositeRequest<'a> {
    CompositeRequest {
        window,
        parts: &[],
        scale: 1.0,
        white_quantile: SHIPPED.white_quantile,
        levels: None,
        reference_white_nits: SHIPPED.reference_white_nits,
        strengths: Strengths {
            sharpen: 0.0,
            defringe: 0.0,
        },
        detail: rawshim::galosh::Detail::at(0.0, 0.0),
        sources,
        from: From::Original,
        mask: None,
    }
}

/// An assembly of three synthetic frames with fixed picks, pinned.
///
/// **What this holds that the unit tests do not** is the whole of §5 at once: the weight fields,
/// the masked gather, the two bands and the coverage average, over one recipe, as a run of bytes.
/// A change to any of them that the tests above happen not to cover is a change to these.
///
/// Three frames, so the recipe has a base and two different picks and the mask's slots are
/// exercised past the two-slot case, and a window holding both tiles' seams and ground outside
/// either.
#[test]
fn an_assembly_reproduces_the_recorded_frame() {
    let Some(_) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the assembly was not run against its fixture.");
        return;
    };
    let (spec, paths) = assembly_of_three();
    let recipe = two_tiles_picking_two_frames(spec);
    let sources: Vec<SourceFile<'_>> = paths
        .iter()
        .map(|p| SourceFile {
            path: p,
            analysis: None,
        })
        .collect();
    let (left, top, wide, tall) = ASSEMBLY_WINDOW;
    let request = assembly_request(&sources, rawshim::px::Rect::exact(left, top, wide, tall));
    let hold = pollster::block_on(rawshim::assembly_render::lowpass(&recipe, &request))
        .expect("a lowpass");
    let (out, _) = pollster::block_on(rawshim::assembly_render::prepared(&recipe, &hold, &request))
        .expect("a window");
    let got = read_codes(&out);
    Snapshot::pq(&got, Size::<rawshim::px::Composite>::exact(wide, tall))
        .check("composite/assembly-window", UNGRADED);
}
