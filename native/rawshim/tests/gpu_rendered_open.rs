//! A finished picture through the whole editor open, which is the claim the feature actually
//! makes: everything below the mosaic runs on one unchanged.
//!
//! `gpu_linearise.rs` pins the kernel and `rendered_decode.rs` pins the readers. What neither can
//! say is whether the *chain* takes what they produce - the correction, the levels, the coding,
//! the defringe, the gather and the sharpen are written against a frame a demosaic left, and a
//! decode with no mosaic behind it reaches them with `noise` and `matrix` both absent.
//! Each of those is an `Option` the RAWs also leave empty in some case, which is exactly the kind
//! of agreement that holds until it does not.

use rawshim::edit::EditRequest;

fn request(long_edge: u32) -> EditRequest {
    serde_json::from_str(&format!(
        r#"{{"longEdge":{long_edge},
            "grade":{{"referenceWhiteNits":203,"whiteQuantile":0.9}},
            "defringe":0.5,"denoiseLuminance":40,"denoiseColour":40}}"#,
    ))
    .expect("the request parses")
}

/// A picture with structure in it: a gradient with a hard edge, so the levels have something to
/// find and the sharpen something to invert.
fn scene(width: usize, height: usize) -> Vec<u8> {
    (0..width * height)
        .flat_map(|at| {
            let (x, y) = (at % width, at / width);
            let ramp = (x * 255 / width.max(1)) as u8;
            let edge = if y > height / 2 { 240u8 } else { 20 };
            [ramp, edge, ramp.wrapping_add(64)]
        })
        .collect()
}

fn png(width: usize, height: usize) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("the header writes");
        writer
            .write_image_data(&scene(width, height))
            .expect("the pixels write");
    }
    out
}

#[test]
fn a_png_opens_through_the_chain_a_raw_opens_through() {
    if rawshim::gpu::device().is_none() {
        eprintln!("SKIPPED: no adapter answered, so nothing was opened.");
        return;
    }
    let (width, height) = (320usize, 200);
    let opened =
        rawshim::edit::prepare_bytes(&png(width, height), &request(0), 30.0).expect("a PNG opens");
    let header = &opened.header;

    assert_eq!((header.width, header.height), (width, height));
    assert_eq!(opened.samples.len(), width * height * 3);
    // A finished picture has no second rendering of itself to be matched against, which is the
    // neutral arm rather than an error, and its white balance moves away from its own white.
    assert!(!header.matched);
    assert_eq!(
        header.as_shot,
        Some(rawshim::white_balance::RENDERED_WHITE)
    );
    assert!(
        !header.mosaic,
        "so the panel closes the Detail pair and the Dust group"
    );
    assert!(
        header.noise_fit.is_none(),
        "and there is no mosaic to have fitted one off"
    );

    // The levels are the photograph's, measured off the frame the chain coded: an sRGB picture
    // whose brightest pixels are white puts diffuse white at the top of the scale.
    assert!(
        header.white.raw() > 40000.0,
        "diffuse white came back at {}",
        header.white.raw()
    );
    assert!(header.peak >= header.white);
    // And the frame is a picture rather than a flat buffer, which is what a decode that lost its
    // pixels somewhere in the chain would leave. These are normalised PQ, not the linear samples
    // the levels above are in (`tone::encode_base`), so what is asked of them is the spread.
    let brightest = opened.samples.iter().copied().max().unwrap_or(0);
    let darkest = opened.samples.iter().copied().min().unwrap_or(0);
    assert!(
        brightest - darkest > 20000,
        "the coded frame runs {darkest}..{brightest}"
    );
}

/// A grey ramp, so every pixel is a neutral the balance can move off grey.
fn grey_jpeg(width: usize, height: usize) -> Vec<u8> {
    let pixels: Vec<u8> = (0..width * height)
        .flat_map(|at| {
            let level = (32 + (at % width) * 192 / width) as u8;
            [level; 3]
        })
        .collect();
    let mut file = Vec::new();
    jpeg_encoder::Encoder::new(&mut file, 95)
        .encode(
            &pixels,
            width as u16,
            height as u16,
            jpeg_encoder::ColorType::Rgb,
        )
        .expect("the JPEG encodes");
    file
}

fn graded(
    opened: &rawshim::edit::Prepared,
    as_shot: Option<rawshim::white_balance::Illuminant>,
    temperature: Option<f64>,
    tint: Option<f64>,
) -> Vec<u16> {
    let gpu = rawshim::gpu::device().expect("an adapter");
    let header = &opened.header;
    let grade = rawshim::grade::Grade {
        adjust: rawshim::grade::Adjust {
            temperature,
            tint,
            ..rawshim::grade::Adjust::none()
        },
        as_shot,
        ..rawshim::grade::Grade::new(
            header.width,
            header.height,
            rawshim::tone::Levels {
                white: header.white,
                peak: header.peak,
                floor: header.floor,
            },
            header.grade.reference_white_nits,
            rawshim::grade::Output::Pq.mastered(header.grade.reference_white_nits),
        )
    };
    rawshim::grade::device(gpu).encode(&opened.samples, &grade)
}

#[test]
fn a_jpegs_white_balance_moves_away_from_the_picture_as_it_was_rendered() {
    if rawshim::gpu::device().is_none() {
        eprintln!("SKIPPED: no adapter answered, so nothing was opened.");
        return;
    }
    let (width, height) = (64usize, 48);
    let opened = rawshim::edit::prepare_bytes(&grey_jpeg(width, height), &request(0), 30.0)
        .expect("a JPEG opens");
    let as_shot = opened.header.as_shot.expect("a JPEG has a white to balance from");

    let unbalanced = graded(&opened, None, None, None);
    for (name, at_rest) in [
        ("unset", graded(&opened, Some(as_shot), None, None)),
        (
            "set to as shot",
            graded(
                &opened,
                Some(as_shot),
                Some(as_shot.temperature),
                Some(as_shot.tint),
            ),
        ),
    ] {
        let worst = at_rest
            .iter()
            .zip(&unbalanced)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .expect("a graded frame");
        assert!(
            worst <= 1,
            "a JPEG's balance {name} moved the picture by {worst} counts"
        );
    }

    // The middle of the ramp, R against B: PQ is monotonic, so the order of the codes is the
    // order of the light.
    let middle = ((height / 2) * width + width / 2) * 3;
    let red_over_blue = |frame: &[u16]| f64::from(frame[middle]) - f64::from(frame[middle + 2]);
    let rest = red_over_blue(&unbalanced);
    let warmer = red_over_blue(&graded(&opened, Some(as_shot), Some(9000.0), Some(as_shot.tint)));
    let cooler = red_over_blue(&graded(&opened, Some(as_shot), Some(4500.0), Some(as_shot.tint)));
    assert!(
        rest.abs() <= 2.0,
        "the grey ramp is {rest} counts off grey at rest"
    );
    assert!(
        warmer > rest + 200.0 && cooler < rest - 200.0,
        "R over B is {rest} at rest, {warmer} at 9000K and {cooler} at 4500K"
    );

    let green = |frame: &[u16]| {
        f64::from(frame[middle + 1]) - (f64::from(frame[middle]) + f64::from(frame[middle + 2])) / 2.0
    };
    let magenta = green(&graded(
        &opened,
        Some(as_shot),
        Some(as_shot.temperature),
        Some(as_shot.tint + 40.0),
    ));
    assert!(
        magenta < green(&unbalanced) - 200.0,
        "tint +40 left green at {magenta} against {} at rest",
        green(&unbalanced)
    );
}

/// The Detail amounts are the mosaic's, and a picture that has none must come back the same
/// whatever they are set to - not merely "not crash", which is what a chain that quietly filtered
/// a demosaiced frame would also do.
#[test]
fn the_detail_sliders_do_nothing_to_a_picture_with_no_mosaic() {
    if rawshim::gpu::device().is_none() {
        eprintln!("SKIPPED: no adapter answered, so nothing was opened.");
        return;
    }
    let file = png(160, 120);
    let quiet: EditRequest = serde_json::from_str(
        r#"{"longEdge":0,"grade":{"referenceWhiteNits":203,"whiteQuantile":0.9},
            "defringe":0.5,"denoiseLuminance":0,"denoiseColour":0}"#,
    )
    .expect("the request parses");

    let none = rawshim::edit::prepare_bytes(&file, &quiet, 30.0).expect("a PNG opens");
    let loud = rawshim::edit::prepare_bytes(&file, &request(0), 30.0).expect("a PNG opens");
    assert_eq!(none.samples, loud.samples);
}
