//! A finished picture through the whole editor open, which is the claim the feature actually
//! makes: everything below the mosaic runs on one unchanged.
//!
//! `gpu_linearise.rs` pins the kernel and `rendered_decode.rs` pins the readers. What neither can
//! say is whether the *chain* takes what they produce - the correction, the levels, the coding,
//! the defringe, the gather and the sharpen are written against a frame a demosaic left, and a
//! decode with no mosaic behind it reaches them with `as_shot`, `noise` and `matrix` all absent.
//! Each of those is an `Option` the RAWs also leave empty in some case, which is exactly the kind
//! of agreement that holds until it does not.

use rawshim::edit::EditRequest;

fn request(long_edge: u32) -> EditRequest {
    serde_json::from_str(&format!(
        r#"{{"longEdge":{long_edge},
            "grade":{{"peakNits":1000,"referenceWhiteNits":203,"whiteQuantile":0.9}},
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
        writer.write_image_data(&scene(width, height)).expect("the pixels write");
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
    let opened = rawshim::edit::prepare_bytes(&png(width, height), &request(0), 30.0)
        .expect("a PNG opens");
    let header = &opened.header;

    assert_eq!((header.width, header.height), (width, height));
    assert_eq!(opened.samples.len(), width * height * 3);
    // A finished picture has no second rendering of itself to be matched against, and no
    // illuminant the samples were divided by: both are the neutral arm rather than an error.
    assert!(!header.matched);
    assert!(header.as_shot.is_none());
    assert!(!header.mosaic, "so the panel closes the Detail pair and the Dust group");
    assert!(header.noise_fit.is_none(), "and there is no mosaic to have fitted one off");

    // The levels are the photograph's, measured off the frame the chain coded: an sRGB picture
    // whose brightest pixels are white puts diffuse white at the top of the scale.
    assert!(header.white.raw() > 40000.0, "diffuse white came back at {}", header.white.raw());
    assert!(header.peak >= header.white);
    // And the frame is a picture rather than a flat buffer, which is what a decode that lost its
    // pixels somewhere in the chain would leave. These are normalised PQ, not the linear samples
    // the levels above are in (`tone::encode_base`), so what is asked of them is the spread.
    let brightest = opened.samples.iter().copied().max().unwrap_or(0);
    let darkest = opened.samples.iter().copied().min().unwrap_or(0);
    assert!(brightest - darkest > 20000, "the coded frame runs {darkest}..{brightest}");
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
        r#"{"longEdge":0,"grade":{"peakNits":1000,"referenceWhiteNits":203,"whiteQuantile":0.9},
            "defringe":0.5,"denoiseLuminance":0,"denoiseColour":0}"#,
    )
    .expect("the request parses");

    let none = rawshim::edit::prepare_bytes(&file, &quiet, 30.0).expect("a PNG opens");
    let loud = rawshim::edit::prepare_bytes(&file, &request(0), 30.0).expect("a PNG opens");
    assert_eq!(none.samples, loud.samples);
}
