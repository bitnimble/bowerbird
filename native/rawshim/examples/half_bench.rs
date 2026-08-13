//! What a bounded rendition costs, against the frame it is cut down from.
//!
//! ```text
//! half_bench <raw>...
//! ```
//!
//! LibRaw could unpack at half resolution when the caller only wanted a small rendition, and this
//! is the measurement of what replacing it cost: the same request, served by decoding the whole
//! frame and fitting afterwards.

/// The long edge a full rendition asks for, which is what makes a 61MP frame a candidate for
/// halving and a 24MP one not.
const FULL_RENDITION: u32 = 3840;

fn main() {
    for path in std::env::args().skip(1) {
        let name = std::path::Path::new(&path)
            .file_name()
            .map_or_else(String::new, |s| s.to_string_lossy().into_owned());

        // The mean of each, because a half-size frame that is the right size and the wrong pixels
        // is the failure this can actually have: a site combined off an odd origin reads the
        // colours next door, and comes out plausible, sharp and green.
        let mean = |frame: &rawshim::frame::Frame| -> f64 {
            frame.samples16().map_or(0.0, |s| {
                s.iter().map(|v| f64::from(*v)).sum::<f64>() / s.len() as f64
            })
        };

        let started = std::time::Instant::now();
        let Some(whole) = rawshim::decode_frame(&path, 16, true, 0) else {
            println!("{name}: declined");
            continue;
        };
        let full_ms = started.elapsed().as_millis();
        let (w, h) = (whole.width, whole.height);
        let full_mean = mean(&whole);
        drop(whole);

        let started = std::time::Instant::now();
        let bounded = rawshim::decode_frame(&path, 16, true, FULL_RENDITION);
        let bounded_ms = started.elapsed().as_millis();
        let halved = bounded.as_ref().is_some_and(|f| f.halved);
        let small_mean = bounded.as_ref().map_or(0.0, mean);
        let (bw, bh) = bounded.map_or((0, 0), |f| (f.width, f.height));

        println!(
            "{name:>16}  {w}x{h} in {full_ms:>5}ms   asked {FULL_RENDITION}: {bw}x{bh} in {bounded_ms:>5}ms  halved {halved}",
        );
        println!(
            "                  mean {full_mean:.1} vs {small_mean:.1}  ({:+.2}%)",
            (small_mean - full_mean) / full_mean * 100.0
        );
    }
}
