//! The same patch of a scene from several pictures, side by side at one height.
//!
//! ```text
//! montage <out.jpg> <height> <image>,<left>,<top>,<right>,<bottom> [more...]
//! ```
//!
//! Comparing a rendering against the picture it came from is the only way to tell a fault from the
//! scene, and doing it by opening two files and looking away from one is how a warm cloud gets
//! mistaken for a broken one. Regions are fractions of each image, so the same patch can be named
//! in pictures of different sizes.

fn main() {
    let mut args = std::env::args().skip(1);
    let out = args.next().expect("montage <out.jpg> <height> <image>,l,t,r,b ...");
    let height: usize = args.next().expect("a height").parse().expect("a height");

    const GAP: usize = 12;
    let panels: Vec<rawshim::rgb::Rgb> = args
        .map(|spec| {
            let mut parts = spec.split(',');
            let path = parts.next().expect("an image path").to_string();
            let region: Vec<f64> = parts.filter_map(|v| v.trim().parse().ok()).collect();
            let region = <[f64; 4]>::try_from(region).expect("l,t,r,b");
            let bytes = std::fs::read(&path).expect("a readable image");
            let picture = rawshim::image::decode(&bytes, 0).expect("a JPEG or an AVIF");
            cropped(&picture, region, height)
        })
        .collect();
    assert!(!panels.is_empty(), "montage wants at least one panel");

    let wide = panels.iter().map(|p| p.width).sum::<usize>() + GAP * (panels.len() - 1);
    let mut data = vec![32u8; wide * height * 3];
    let mut at = 0;
    for panel in &panels {
        for y in 0..panel.height.min(height) {
            let from = y * panel.width * 3;
            let into = (y * wide + at) * 3;
            data[into..into + panel.width * 3]
                .copy_from_slice(&panel.data[from..from + panel.width * 3]);
        }
        at += panel.width + GAP;
    }

    let sheet = rawshim::rgb::RgbRef { data: &data, width: wide, height };
    let jpeg = rawshim::jpeg::encode(sheet, 94).expect("a jpeg");
    std::fs::write(&out, jpeg).expect("a writable path");
    println!("wrote {out} ({wide}x{height}, {} panels)", panels.len());
}

/// That region of `picture`, scaled to `height` and keeping its shape.
fn cropped(
    picture: &rawshim::rgb::Rgb,
    region: [f64; 4],
    height: usize,
) -> rawshim::rgb::Rgb {
    let left = (region[0] * picture.width as f64) as usize;
    let top = (region[1] * picture.height as f64) as usize;
    let right = ((region[2] * picture.width as f64) as usize).min(picture.width).max(left + 1);
    let bottom = ((region[3] * picture.height as f64) as usize).min(picture.height).max(top + 1);
    let (span, deep) = (right - left, bottom - top);
    let wide = (span * height / deep).max(1);

    let mut patch = vec![0u8; span * deep * 3];
    for y in 0..deep {
        let from = ((top + y) * picture.width + left) * 3;
        patch[y * span * 3..(y + 1) * span * 3].copy_from_slice(&picture.data[from..from + span * 3]);
    }
    // A panel is a few thousand pixels down to a few hundred, which two taps an axis alias badly
    // enough to look like the rendering fault the comparison is meant to find.
    rawshim::image::resize(rawshim::rgb::RgbRef { data: &patch, width: span, height: deep }, wide, height)
}
