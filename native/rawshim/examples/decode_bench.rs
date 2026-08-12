//! What a decode costs, on whichever path `BOWERBIRD_DECODER` selects.
//!
//! ```text
//! decode_bench <raw>...
//! ```
//!
//! Repeats each file and reports the best time rather than the first, because the first pays for
//! page cache, GPU pipeline creation and the allocator warming up, and none of those are what a
//! server decoding its thousandth photograph experiences.
//!
//! Megapixels per second as well as milliseconds, so a 61MP frame and a 24MP one can be compared
//! without doing the arithmetic in your head.

/// Enough to get past the first-run costs without making the whole run take minutes on a 61MP file.
const ROUNDS: usize = 3;

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("decode_bench <raw>...");
        return;
    }

    let which = std::env::var("BOWERBIRD_DECODER").unwrap_or_else(|_| "libraw".into());
    println!("decoder: {which}");
    println!("{:>30}  {:>9}  {:>8}  {:>8}  {:>9}  {}", "file", "pixels", "first", "best", "MP/s", "checksum");

    let mut total_pixels = 0f64;
    let mut total_best = 0f64;
    for path in &files {
        let started = std::time::Instant::now();
        let Some(frame) = rawshim::decode_frame_denoised(path, 16, true, 0, Default::default()) else {
            println!("{path}: declined");
            continue;
        };
        let first = started.elapsed().as_secs_f64();
        let megapixels = (frame.width * frame.height) as f64 / 1e6;
        // Answers "did the decode change" without a reference image, and answers it exactly, which
        // a mean does not: two runs agreeing here agree on every sample.
        let checksum = match &frame.pixels {
            rawshim::frame::Pixels::Sixteen(p) => p.iter().map(|s| u64::from(*s)).sum::<u64>(),
            rawshim::frame::Pixels::Eight(p) => p.iter().map(|s| u64::from(*s)).sum::<u64>(),
        };
        drop(frame);

        let mut best = first;
        for _ in 1..ROUNDS {
            let round = std::time::Instant::now();
            let frame = rawshim::decode_frame_denoised(path, 16, true, 0, Default::default());
            let taken = round.elapsed().as_secs_f64();
            if frame.is_some() && taken < best {
                best = taken;
            }
        }

        let name = std::path::Path::new(path)
            .file_name()
            .map_or_else(|| path.clone(), |s| s.to_string_lossy().into_owned());
        println!(
            "{name:>30}  {megapixels:>6.2}MP  {:>6.0}ms  {:>6.0}ms  {:>9.1}  {checksum}",
            first * 1000.0,
            best * 1000.0,
            megapixels / best,
        );
        total_pixels += megapixels;
        total_best += best;
    }

    if total_best > 0.0 {
        println!(
            "{:>30}  {total_pixels:>6.2}MP  {:>8}  {:>6.0}ms  {:>9.1}",
            "total", "", total_best * 1000.0, total_pixels / total_best
        );
    }
}
