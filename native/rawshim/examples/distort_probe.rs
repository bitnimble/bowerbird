//! How far a shipped geometry still leaves a frame from the camera's own picture.
//!
//! Mean radial displacement per radius bin, in wide-plane pixels, before and after the fit.
//! The tangential row is the noise floor to read the radial one against: nothing radial can
//! produce it, so a bin where it is large is measurement rather than geometry.
//!
//! usage: distort_probe <raw>...

use rawshim::image::resize;
use rawshim::{fit, hdr_fit};

const BINS: usize = 8;
const POINTS: usize = 6000;

fn main() {
    for path in std::env::args().skip(1) {
        match probe(&path) {
            Ok(()) => (),
            Err(e) => eprintln!("{path}: {e}"),
        }
    }
}

fn probe(path: &str) -> Result<(), String> {
    let frame = rawshim::decode_frame(path, 0).ok_or("the decode declined it")?;
    let gpu = rawshim::gpu::device().ok_or("an adapter")?;
    let resident = frame.on_device(gpu).ok_or("the frame reaches the device")?;
    let matched = rawshim::fit_hdr_for(&resident, path, 0.9).ok_or("no fit")?;

    let preview = rawshim::hdr::match_preview(path).ok_or("no preview")?;
    let (wide, _) = hdr_fit::fitted_preview_size(preview.width, preview.height);
    let prepared = pollster::block_on(rawshim::fit_source::prepared(gpu, &resident, wide, 0.9))
        .ok_or("no plane")?;
    let render = pollster::block_on(rawshim::fit_source::read_render(gpu, &prepared.rendered))
        .ok_or("no render")?;
    let (_, searched) =
        pollster::block_on(hdr_fit::preview_planes(gpu, &preview)).ok_or("no preview planes")?;
    let sampled = resize(render.as_ref(), searched.width, searched.height);

    let header = rawshim::header::read_path(path);
    let lens = header.as_ref().map_or(String::new(), |h| rawshim::header::name(&h.lens_model).to_string());
    let focal = header.as_ref().map_or(0.0, |h| h.focal);
    println!("== {path}");
    println!("   {lens} at {focal}mm, {}x{} plane", searched.width, searched.height);

    // The lateral correction is per channel and this is luma, so the geometry is asked
    // about on its own.
    let shipped = fit::Lens { tca: None, ..matched.lens };
    report("uncorrected", &sampled, &searched, &fit::Lens::none());
    report("as shipped", &sampled, &searched, &shipped);
    Ok(())
}

fn report(
    label: &str,
    render: &rawshim::rgb::Rgb,
    preview: &hdr_fit::Source,
    lens: &fit::Lens,
) {
    let stride = (((preview.width * preview.height) as f64 / POINTS as f64).sqrt() as usize).max(1);
    let gpu = rawshim::gpu::device().expect("an adapter");
    let ours = hdr_fit::Source {
        buffer: hdr_fit::levelled_source(gpu, render.as_ref()),
        width: render.width,
        height: render.height,
    };
    let settling = hdr_fit::Settling::new(gpu, &ours, preview, stride);
    let Some(measured) =
        pollster::block_on(hdr_fit::registration(gpu, &settling, lens, BINS))
    else {
        println!("   {label:<14} nothing registered");
        return;
    };
    let half = ((preview.width as f64 / 2.0).powi(2) + (preview.height as f64 / 2.0).powi(2)).sqrt();
    let row: Vec<String> = measured
        .radial
        .iter()
        .map(|v| v.map_or("  -  ".into(), |shift| format!("{:+.2}", shift * half)))
        .collect();
    println!("   {label:<14} {}   ({} matched)", row.join(" "), measured.matched);
}
