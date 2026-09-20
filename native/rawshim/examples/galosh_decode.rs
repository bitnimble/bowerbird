//! The denoise where it actually runs: inside a real decode of a real RAW.
//!
//! The kernels have unit tests; what they do not cover is the plumbing between
//! the unpack and the demosaic - the black level, the row stride, the CFA phase. This decodes one
//! file twice and reports what moved.
//!
//! ```text
//! cargo run --release --example galosh_decode -- /path/to/photo.CR3
//! ```

use rawshim::galosh::Detail;

fn main() {
    let path = std::env::args().nth(1).expect("a RAW to decode");

    let started = std::time::Instant::now();
    let plain = rawshim::decode_frame(&path, 0).expect("decoded");
    let plain_ms = started.elapsed().as_millis();

    let started = std::time::Instant::now();
    let denoised = rawshim::decode_frame_denoised(
        &path,
        0,
        Detail::at(33.0, 33.0),
        Default::default(),
    )
    .expect("decoded");
    let denoised_ms = started.elapsed().as_millis();

    assert_eq!((plain.width, plain.height), (denoised.width, denoised.height));
    let before = plain.samples16().expect("16-bit");
    let after = denoised.samples16().expect("16-bit");

    let moved = before.iter().zip(after).filter(|(a, b)| a != b).count();
    let mean = before
        .iter()
        .zip(after)
        .map(|(a, b)| f64::from(a.abs_diff(*b)))
        .sum::<f64>()
        / before.len() as f64;
    let worst = before.iter().zip(after).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
    // How many samples move by a lot, which separates "it removed speckle" from "it is
    // wrong": an isolated hot pixel is exactly what a denoise should flatten, and there
    // should be very few of them.
    let large = before.iter().zip(after).filter(|(a, b)| a.abs_diff(**b) > 6553).count();

    // The noise in a flat patch, as the mean absolute difference from a 3x3 box mean. What
    // the denoise is for is this number falling.
    let roughness = |frame: &[u16], width: usize, x0: usize, y0: usize| -> f64 {
        let at = |x: usize, y: usize| f64::from(frame[(y * width + x) * 3 + 1]);
        let mut total = 0.0;
        let mut counted = 0.0;
        for y in y0 + 1..y0 + 63 {
            for x in x0 + 1..x0 + 63 {
                let mut sum = 0.0;
                for dy in 0..3 {
                    for dx in 0..3 {
                        sum += at(x + dx - 1, y + dy - 1);
                    }
                }
                total += (at(x, y) - sum / 9.0).abs();
                counted += 1.0;
            }
        }
        total / counted
    };
    let (x0, y0) = (plain.width / 3, plain.height / 3);

    println!("{}x{}", plain.width, plain.height);
    println!("  decode           {plain_ms}ms plain, {denoised_ms}ms denoised");
    println!(
        "  samples moved    {:.1}% (mean {mean:.1} counts, worst {worst})",
        100.0 * moved as f64 / before.len() as f64,
    );
    println!(
        "  moved over 10%   {large} samples ({:.4}%)",
        100.0 * large as f64 / before.len() as f64,
    );
    println!(
        "  local roughness  {:.1} -> {:.1}",
        roughness(before, plain.width, x0, y0),
        roughness(after, plain.width, x0, y0),
    );
}
