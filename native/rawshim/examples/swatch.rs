//! What colour a region of a picture actually is, in light rather than in codes.
//!
//! ```text
//! swatch <image> [left,top,right,bottom in fractions]
//! ```
//!
//! A cast is the one thing an eye judges worst and a number settles at once. The comparison has to
//! happen in light: a ratio of sRGB codes is a ratio of two numbers on a curve that is steepest near
//! black, so the same colour reads as a different cast depending only on how bright it is. Every
//! sample here is decoded through `hdr_fit::srgb_eotf` first, and what is printed is the
//! chromaticity of the light - `r / (r+g+b)` and `b / (r+g+b)` - which is what "more yellow" means.
//!
//! The brightest tenth is reported separately because a cast on a cloud is a cast on the highlights,
//! and averaging it with the sky it sits in is what hides it.

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("swatch <image> [left,top,right,bottom]");
    let region: [f64; 4] = match args.next() {
        Some(text) => {
            let parts: Vec<f64> = text.split(',').filter_map(|v| v.trim().parse().ok()).collect();
            <[f64; 4]>::try_from(parts).expect("left,top,right,bottom")
        }
        None => [0.0, 0.0, 1.0, 1.0],
    };

    let bytes = std::fs::read(&path).expect("a readable image");
    let picture = rawshim::image::decode(&bytes, 0).expect("a JPEG or an AVIF");
    let (wide, tall) = (picture.width, picture.height);
    let left = (region[0] * wide as f64) as usize;
    let top = (region[1] * tall as f64) as usize;
    let right = ((region[2] * wide as f64) as usize).min(wide);
    let bottom = ((region[3] * tall as f64) as usize).min(tall);

    let mut light: Vec<[f64; 3]> = Vec::new();
    for y in top..bottom {
        for x in left..right {
            let at = (y * wide + x) * 3;
            light.push([
                rawshim::hdr_fit::srgb_eotf(picture.data[at]),
                rawshim::hdr_fit::srgb_eotf(picture.data[at + 1]),
                rawshim::hdr_fit::srgb_eotf(picture.data[at + 2]),
            ]);
        }
    }
    if light.is_empty() {
        println!("{path}: nothing in that region");
        return;
    }

    println!("{path}: {wide}x{tall}, region {left},{top} to {right},{bottom}");
    report("all", &light);
    let mut ranked = light.clone();
    ranked.sort_by(|a, b| luminance(b).total_cmp(&luminance(a)));
    ranked.truncate((ranked.len() / 10).max(1));
    report("brightest tenth", &ranked);
}

fn luminance(rgb: &[f64; 3]) -> f64 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

fn report(what: &str, light: &[[f64; 3]]) {
    let n = light.len() as f64;
    let mean = |c: usize| light.iter().map(|p| p[c]).sum::<f64>() / n;
    let (r, g, b) = (mean(0), mean(1), mean(2));
    let sum = (r + g + b).max(1e-12);
    // Neutral is a third each. Yellow is red and green up together with blue down, so the blue
    // share falling is the half of it that a warm cast and a yellow one do not share.
    println!(
        "  {what:<16} light {r:.4} {g:.4} {b:.4}   chromaticity r {:.4} g {:.4} b {:.4}",
        r / sum,
        g / sum,
        b / sum,
    );
}
