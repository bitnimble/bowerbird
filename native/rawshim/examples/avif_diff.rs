//! Where two encodes of one picture disagree, as a greyscale PNG: `avif_diff <a.avif> <b.avif> <out.png> [steps]`.
//!
//! Each pixel is its worst channel's difference in 10-bit PQ steps, white at `steps` (16 unless
//! given) and past it.

use std::io::BufWriter;

fn main() {
    let mut args = std::env::args().skip(1);
    let a = args.next().expect("a.avif");
    let b = args.next().expect("b.avif");
    let out = args.next().expect("out.png");
    let white: f64 = args.next().map_or(16.0, |s| s.parse().expect("a number"));

    let read = |path: &str| rawshim::avif::decode_at(&std::fs::read(path).expect("the file"), 16).expect("an AVIF");
    let (left, w, h) = read(&a);
    let (right, w2, h2) = read(&b);
    assert_eq!((w, h), (w2, h2), "the two are different sizes");

    let steps: Vec<f64> = left
        .chunks_exact(3)
        .zip(right.chunks_exact(3))
        .map(|(x, y)| f64::from((0..3).map(|c| x[c].abs_diff(y[c])).max().expect("3 channels")) / 65535.0 * 1023.0)
        .collect();
    let grey: Vec<u8> = steps.iter().map(|s| (s / white * 255.0).round().min(255.0) as u8).collect();

    let file = std::fs::File::create(&out).expect("the output");
    let mut encoder = png::Encoder::new(BufWriter::new(file), w as u32, h as u32);
    encoder.set_color(png::ColorType::Grayscale);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().expect("the header").write_image_data(&grey).expect("the pixels");

    let mut sorted = steps.clone();
    sorted.sort_by(f64::total_cmp);
    let at = |q: f64| sorted[((sorted.len() - 1) as f64 * q) as usize];
    println!(
        "mean {:.2}  p50 {:.2}  p99 {:.2}  p99.9 {:.2}  max {:.2} PQ steps",
        steps.iter().sum::<f64>() / steps.len() as f64,
        at(0.5),
        at(0.99),
        at(0.999),
        sorted[sorted.len() - 1],
    );
}
