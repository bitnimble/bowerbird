//! The pass that turns a finished picture into the frame the pipeline reads, held against the
//! host arithmetic it is a table of.
//!
//! **What this is watching for is not a crash.** `linearise.slang` undoes a transfer, applies a
//! gain map, converts primaries, crops, halves and turns, and every one of those is a picture that
//! renders either way: a transposed matrix row is a colour cast, a turn read backwards is a
//! photograph that is upside down at one size and not another, and a halving that averages code
//! values rather than light darkens every edge. So each is asked here, in one dispatch, against
//! the answer `transfer.rs` computes on the host.
//!
//! Skipped loudly where no adapter answers, for `gpu_dust.rs`'s reason.

use rawshim::light::{Light, SceneNits};
use rawshim::linearise::{GainMap, Picture, Reconstruction};
use rawshim::px::{At, Photograph, Rect, Size};
use rawshim::transfer::{Coding, Curve, Primaries};
use rawshim::view::Scale;
use rawler::decoders::Orientation;

/// The samples a window comes back as, on the host.
fn linearised(
    picture: &Picture,
    window: Rect<Photograph>,
    scale: Scale,
) -> Option<(Vec<u16>, usize, usize)> {
    let gpu = rawshim::gpu::device()?;
    let frame = picture.window(gpu, rawshim::linearise::device(gpu), window, scale)?;
    let (width, height) = (frame.width, frame.height);
    let samples = pollster::block_on(frame.into_host())?;
    Some((samples, width, height))
}

fn whole(picture: &Picture) -> Option<(Vec<u16>, usize, usize)> {
    let size = picture.upright_size();
    linearised(picture, Rect { at: At::ORIGIN, size }, Scale::Full)
}

/// A picture whose every pixel is a different code, so a reader that indexed the table or the
/// raster wrongly cannot answer correctly.
fn ramp(width: usize, height: usize, depth: u32) -> Vec<u16> {
    let last = (1u32 << depth) - 1;
    (0..width * height)
        .flat_map(|at| {
            let base = (at as u32 * 7) % (last + 1);
            [base as u16, ((base + last / 3) % (last + 1)) as u16, ((base + 2 * last / 3) % (last + 1)) as u16]
        })
        .collect()
}

#[test]
fn the_kernel_undoes_the_transfer_the_table_states() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the linearise kernel was not run.");
        return;
    };
    // Rec.2020 in and Rec.2020 out, so the matrix is the identity and what is left is the curve and
    // the gamut floor the ramp's saturated pixels land under.
    let coding = Coding::of(Primaries::REC2020, Curve::Srgb, 8);
    let (width, height) = (16usize, 9);
    let codes = ramp(width, height, 8);
    let picture =
        Picture::upload(gpu, &codes, width, height, coding, Orientation::Normal, None).unwrap();
    let (samples, out_w, out_h) = whole(&picture).expect("the pass runs");
    assert_eq!((out_w, out_h), (width, height));

    let table = coding.table();
    let white = coding.white_level(false);
    for (at, sample) in samples.iter().enumerate() {
        let pixel = at / 3;
        let colour: [f64; 3] = std::array::from_fn(|channel| {
            f64::from(table[usize::from(codes[pixel * 3 + channel]) * 3 + channel]) * white
        });
        let want = rawshim::hdr_fit::in_gamut(colour)[at % 3].clamp(0.0, 65535.0);
        assert!(
            (f64::from(*sample) - want).abs() <= 1.0,
            "sample {at}: code {} became {sample}, and the host says {want}",
            codes[at],
        );
    }
}

/// A 10-bit PQ picture puts diffuse white a fixed distance below the top and carries highlights
/// above it, which is the whole reason the scale is not 65535 for one.
#[test]
fn a_pq_picture_keeps_its_headroom() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the PQ scale was not run.");
        return;
    };
    let coding = Coding::of(Primaries::REC2020, Curve::Pq, 10);
    // Reference white, then something far above it.
    let coded = |nits: f64| {
        let light: Light<SceneNits> = Light::exactly(nits);
        (rawshim::tone::pq(light).raw() * 1023.0).round() as u16
    };
    let white_code = coded(203.0);
    let bright_code = coded(1000.0);
    let codes: Vec<u16> = [white_code, bright_code].iter().flat_map(|c| [*c, *c, *c]).collect();
    let picture = Picture::upload(gpu, &codes, 2, 1, coding, Orientation::Normal, None).unwrap();
    let (samples, _, _) = whole(&picture).expect("the pass runs");

    let white = 65535.0 / rawshim::transfer::HDR_HEADROOM;
    assert!((f64::from(samples[0]) - white).abs() < 60.0, "white landed at {}", samples[0]);
    // 1000 nits is a little under five times 203, and the headroom is eight, so it is carried
    // rather than clipped.
    let ratio = f64::from(samples[3]) / f64::from(samples[0]);
    assert!((ratio - 1000.0 / 203.0).abs() < 0.05, "1000 nits came back at {ratio}x white");
    assert!(samples[3] < 65535, "and it did not reach the ceiling");
}

/// The primaries conversion, which is the failure that renders: a transposed row is a colour
/// cast, and nothing about the picture says so.
#[test]
fn the_primaries_conversion_is_the_hosts() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the matrix was not run.");
        return;
    };
    let coding = Coding::of(Primaries::REC709, Curve::Linear, 8);
    // Pure red, green, blue and white, which is where a swapped row shows most.
    let codes: Vec<u16> = vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
    let picture = Picture::upload(gpu, &codes, 4, 1, coding, Orientation::Normal, None).unwrap();
    let (samples, _, _) = whole(&picture).expect("the pass runs");

    let matrix = Primaries::REC709.to_rec2020();
    for pixel in 0..4 {
        let source = [
            f64::from(codes[pixel * 3]) / 255.0,
            f64::from(codes[pixel * 3 + 1]) / 255.0,
            f64::from(codes[pixel * 3 + 2]) / 255.0,
        ];
        for channel in 0..3 {
            let row = matrix[channel];
            let want = (f64::from(row[0]) * source[0]
                + f64::from(row[1]) * source[1]
                + f64::from(row[2]) * source[2])
                .clamp(0.0, 1.0)
                * 65535.0;
            let got = f64::from(samples[pixel * 3 + channel]);
            assert!((got - want).abs() <= 2.0, "pixel {pixel} channel {channel}: {got} vs {want}");
        }
    }
    // Rec.709 white is Rec.2020 white, which is the identity a primaries conversion has to hold.
    for channel in 0..3 {
        assert!(samples[9 + channel] > 65000, "white came back at {}", samples[9 + channel]);
    }
}

/// A window is named where a reader sees it and read where the bytes are, which under a quarter
/// turn is neither the same corner nor the same axes.
#[test]
fn a_turned_picture_is_windowed_in_the_readers_coordinates() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the turn was not run.");
        return;
    };
    let coding = Coding::of(Primaries::REC2020, Curve::Linear, 16);
    let (width, height) = (7usize, 4);
    // Every pixel names where it is in the stored raster.
    let codes: Vec<u16> =
        (0..width * height).flat_map(|at| [at as u16 * 100, 0, 0]).collect();

    for turn in [
        Orientation::Normal,
        Orientation::HorizontalFlip,
        Orientation::Rotate180,
        Orientation::VerticalFlip,
        Orientation::Transpose,
        Orientation::Rotate90,
        Orientation::Transverse,
        Orientation::Rotate270,
    ] {
        let picture = Picture::upload(gpu, &codes, width, height, coding, turn, None).unwrap();
        let upright = picture.upright_size();
        let (whole_samples, out_w, out_h) = whole(&picture).expect("the pass runs");
        assert_eq!((out_w, out_h), upright.raw(), "{turn:?} answered the wrong shape");

        // One pixel of the upright picture, asked for on its own: a window has to land on the
        // same sample the whole frame put there.
        let (x, y) = (2usize, 1);
        let one = Rect { at: At::exact(x, y), size: Size::exact(1, 1) };
        let (windowed, _, _) = linearised(&picture, one, Scale::Full).expect("the window runs");
        assert_eq!(
            windowed[0],
            whole_samples[(y * out_w + x) * 3],
            "{turn:?}: a window of one pixel is not the pixel the whole frame has there",
        );
    }
}

/// Halving averages light, not code values. Averaging the codes of a black and a white pixel
/// through an sRGB curve gives 0.216 of the light the two actually carry, which is a picture with
/// every edge darkened and nothing to say why.
#[test]
fn halving_averages_light_rather_than_code_values() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the halving was not run.");
        return;
    };
    let coding = Coding::of(Primaries::REC2020, Curve::Srgb, 8);
    // One 2x2 site: black, white, black, white.
    let codes: Vec<u16> = vec![0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255];
    let picture = Picture::upload(gpu, &codes, 2, 2, coding, Orientation::Normal, None).unwrap();
    let (samples, out_w, out_h) =
        linearised(&picture, Rect { at: At::ORIGIN, size: Size::exact(2, 2) }, Scale::Half)
            .expect("the pass runs");
    assert_eq!((out_w, out_h), (1, 1));

    let want = 0.5 * 65535.0;
    assert!(
        (f64::from(samples[0]) - want).abs() < 200.0,
        "half black and half white is {} where averaging light gives {want}",
        samples[0],
    );
    // What averaging the codes would have given, so the test names the failure it is preventing.
    let wrong = f64::from(Curve::Srgb.light(0.5).raw() as f32) * 65535.0;
    assert!((f64::from(samples[0]) - wrong).abs() > 5000.0);
}

/// **A turn and a halving together, which is where the two arithmetics meet.** The window is
/// mapped back through the turn and then truncated to whole steps; taken in that order the
/// discard comes off the *stored* raster's far edge, which under a flip is the upright picture's
/// near one - so the frame arrives shifted a pixel and missing the wrong column, at one size and
/// not the other.
#[test]
fn a_halved_picture_drops_the_same_edge_whichever_way_up_it_is() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the turned halving was not run.");
        return;
    };
    let coding = Coding::of(Primaries::REC2020, Curve::Linear, 16);
    // Five columns of distinct values, so a one-pixel shift is visible; an odd width is what
    // makes the truncation happen at all.
    let (width, height) = (5usize, 2);
    let codes: Vec<u16> =
        (0..width * height).flat_map(|at| [(at % width) as u16 * 1000, 0, 0]).collect();

    for turn in [Orientation::Normal, Orientation::HorizontalFlip, Orientation::Rotate180] {
        let picture =
            Picture::upload(gpu, &codes, width, height, coding, turn, None).unwrap();
        let upright = picture.upright_size();
        let (samples, out_w, _) =
            linearised(&picture, picture_window(upright), Scale::Half).expect("the pass runs");
        assert_eq!(out_w, upright.width.raw() / 2, "{turn:?}");

        // The upright picture's first two columns, averaged, are what output pixel 0 must be -
        // whatever the file's turn is. Column 4 is the one with nowhere to go.
        let whole = whole(&picture).expect("the pass runs");
        let expected = (u32::from(whole.0[0]) + u32::from(whole.0[3])) / 2;
        assert!(
            u32::from(samples[0]).abs_diff(expected) < 600,
            "{turn:?}: halved pixel 0 is {} where columns 0 and 1 average {expected}",
            samples[0],
        );
    }
}

fn picture_window(size: Size<Photograph>) -> Rect<Photograph> {
    Rect { at: At::ORIGIN, size }
}

/// ISO's terms for two stops at full recovery, which is the shape most of these tests want.
fn two_stops() -> Reconstruction {
    Reconstruction::Iso {
        min: [0.0; 3],
        max: [2.0; 3],
        gamma: [1.0; 3],
        offset_base: [0.0; 3],
        offset_alternate: [0.0; 3],
    }
}

/// The gain map, at the terms ISO 21496-1 states: two stops of gain where the map reads full,
/// none where it reads zero.
#[test]
fn a_gain_map_lifts_the_base_by_what_its_terms_say() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the gain map was not run.");
        return;
    };
    let coding = Coding::of(Primaries::REC2020, Curve::Linear, 8);
    // Two pixels of the same mid grey, one under a map that reads nothing and one under a map
    // that reads full.
    let codes: Vec<u16> = vec![128, 128, 128, 128, 128, 128];
    let map = GainMap {
        samples: vec![0, 0, 0, 65535, 65535, 65535],
        width: 2,
        height: 1,
        last: 65535.0,
        terms: two_stops(),
    };
    let picture =
        Picture::upload(gpu, &codes, 2, 1, coding, Orientation::Normal, Some(map)).unwrap();
    let (samples, _, _) = whole(&picture).expect("the pass runs");

    // A gain-mapped base is put on the HDR scale, so the unlifted pixel sits at its own light
    // times that scale rather than at 65535.
    let base = 128.0 / 255.0 * (65535.0 / rawshim::transfer::HDR_HEADROOM);
    assert!((f64::from(samples[0]) - base).abs() < 60.0, "the unlifted pixel is {}", samples[0]);
    let ratio = f64::from(samples[3]) / f64::from(samples[0]);
    assert!((ratio - 4.0).abs() < 0.05, "two stops of gain came back as {ratio}x");
}

/// A map coded at eight bits says what the same map coded at sixteen says.
///
/// The map carries its own depth, which is not the picture's: a HEIC's base is routinely 10-bit
/// with an 8-bit `tmap` beside it. Read at the wrong full scale, a map that says "lift this by two
/// stops" says "lift it by nothing" - 255 out of 65535 is a recovery of 0.004.
#[test]
fn a_gain_map_is_read_at_its_own_depth_rather_than_the_pictures() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the gain map depth was not run.");
        return;
    };
    let coding = Coding::of(Primaries::REC2020, Curve::Linear, 8);
    let codes: Vec<u16> = vec![128, 128, 128, 128, 128, 128];
    let at_depth = |samples: Vec<u16>, last: f32| {
        let map = GainMap {
            samples,
            width: 2,
            height: 1,
            last,
            terms: two_stops(),
        };
        let picture =
            Picture::upload(gpu, &codes, 2, 1, coding, Orientation::Normal, Some(map)).unwrap();
        whole(&picture).expect("the pass runs").0
    };

    let wide = at_depth(vec![0, 0, 0, 65535, 65535, 65535], 65535.0);
    let narrow = at_depth(vec![0, 0, 0, 255, 255, 255], 255.0);
    assert_eq!(wide[3], narrow[3], "the lifted pixel differs by the map's depth alone");
    let ratio = f64::from(narrow[3]) / f64::from(narrow[0]);
    assert!((ratio - 4.0).abs() < 0.05, "two stops off an 8-bit map came back as {ratio}x");
}

/// Apple's reconstruction is a straight line to its headroom, which ISO's curve is not.
///
/// **The two agree at both ends and nowhere between**, so a test at full recovery alone would pass
/// with the arms swapped. At half recovery under a headroom of 4, Apple gives 2.5x and ISO gives
/// 2x - and reading an Apple file through ISO's arm is every midtone in the highlights a fifth of a
/// stop dark, which is the sort of wrong that looks like a grade rather than a bug.
#[test]
fn apples_gain_is_linear_in_the_recovery_where_isos_is_exponential() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so Apple's arm was not run.");
        return;
    };
    let coding = Coding::of(Primaries::REC2020, Curve::Linear, 8);
    // One pixel, and a map reading exactly half way up.
    let codes: Vec<u16> = vec![64; 3];
    let lifted = |terms: Reconstruction| {
        let map =
            GainMap { samples: vec![32768; 3], width: 1, height: 1, last: 65535.0, terms };
        let picture =
            Picture::upload(gpu, &codes, 1, 1, coding, Orientation::Normal, Some(map)).unwrap();
        f64::from(whole(&picture).expect("the pass runs").0[0])
    };

    // The same headroom of four, stated each way: Apple's as the multiplier, ISO's as its log.
    let apple = lifted(Reconstruction::Apple { headroom: 4.0 });
    let iso = lifted(Reconstruction::Iso {
        min: [0.0; 3],
        max: [2.0; 3],
        gamma: [1.0; 3],
        offset_base: [0.0; 3],
        offset_alternate: [0.0; 3],
    });

    // `1 + (4 - 1) * 0.5` against `2^(0 + 2 * 0.5)`.
    assert!((apple / iso - 2.5 / 2.0).abs() < 0.01, "Apple {apple} against ISO {iso}");
    let base = 64.0 / 255.0 * (65535.0 / rawshim::transfer::HDR_HEADROOM);
    assert!((apple / base - 2.5).abs() < 0.02, "Apple's half recovery came back at {}x", apple / base);
}

/// **The terms that the test above cannot see.** With `gamma` at 1 and recovery at exactly 0 or
/// 1, `pow(r, 1/g)` and `pow(r, g)` are the same number and both offsets are zero - so the
/// exponent could be inverted, or either offset read from the wrong uniform slot, and the suite
/// would still be green. This drives a mid recovery through a non-unit gamma with two offsets
/// that differ from each other.
#[test]
fn a_gain_maps_gamma_and_offsets_are_the_ones_the_terms_state() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the gain map terms were not run.");
        return;
    };
    let coding = Coding::of(Primaries::REC2020, Curve::Linear, 16);
    // One mid-grey pixel, and a map that reads exactly half way up.
    let base_code = 16384u16;
    let codes: Vec<u16> = vec![base_code; 3];
    let (min, max, gamma) = (-1.0f32, 3.0f32, 2.0f32);
    let (offset_base, offset_alternate) = (0.05f32, 0.02f32);
    let map = GainMap {
        samples: vec![32768; 3],
        width: 1,
        height: 1,
        last: 65535.0,
        terms: Reconstruction::Iso {
            min: [min; 3],
            max: [max; 3],
            gamma: [gamma; 3],
            offset_base: [offset_base; 3],
            offset_alternate: [offset_alternate; 3],
        },
    };
    let picture =
        Picture::upload(gpu, &codes, 1, 1, coding, Orientation::Normal, Some(map)).unwrap();
    let (samples, _, _) = whole(&picture).expect("the pass runs");

    // ISO 21496-1, evaluated here: the recovery through 1/gamma, lerped between min and max in
    // log2, then the base lifted through it with the two offsets on their own sides.
    let recovery = 32768.0f64 / 65535.0;
    let log_gain = f64::from(min)
        + (f64::from(max) - f64::from(min)) * recovery.powf(1.0 / f64::from(gamma));
    let base = f64::from(base_code) / 65535.0;
    let want = ((base + f64::from(offset_base)) * log_gain.exp2() - f64::from(offset_alternate))
        * (65535.0 / rawshim::transfer::HDR_HEADROOM);
    assert!(
        (f64::from(samples[0]) - want).abs() < 40.0,
        "the lifted pixel is {} where the terms give {want}",
        samples[0],
    );
    // And the two failures this is guarding against, named so the tolerance cannot swallow them:
    // an inverted gamma, and the offsets swapped.
    let inverted = f64::from(min)
        + (f64::from(max) - f64::from(min)) * recovery.powf(f64::from(gamma));
    let wrong = ((base + f64::from(offset_base)) * inverted.exp2() - f64::from(offset_alternate))
        * (65535.0 / rawshim::transfer::HDR_HEADROOM);
    assert!((want - wrong).abs() > 400.0, "the test cannot tell an inverted gamma apart");
    let swapped = ((base + f64::from(offset_alternate)) * log_gain.exp2()
        - f64::from(offset_base))
        * (65535.0 / rawshim::transfer::HDR_HEADROOM);
    assert!((want - swapped).abs() > 100.0, "the test cannot tell swapped offsets apart");
}
