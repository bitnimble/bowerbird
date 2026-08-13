//! What rawler's unpack costs on its own, which is where the fork's work goes.
//!
//! Only the decompression to a mosaic, unlike `decode_bench`: rawler's own develop stage carries
//! the frame in f32 and nothing here uses it, the denoise and the demosaic being ours.

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("rawler_bench <raw>...");
        return;
    }
    println!("rayon threads: {}", rayon::current_num_threads());
    println!("{:>34}  {:>11}  {:>9}  {:>9}  {}", "file", "pixels", "first", "steady", "checksum");

    for path in &files {
        let started = std::time::Instant::now();
        let image = match rawler::decode_file(path) {
            Ok(image) => image,
            Err(e) => {
                println!("{path}: {e:?}");
                continue;
            }
        };
        let first = started.elapsed();
        let (width, height) = (image.width, image.height);
        // The decoded samples, so a reader rewritten underneath this is held to producing the
        // same picture rather than merely the same timings.
        let sum = match &image.data {
            rawler::RawImageData::Integer(data) => data.iter().fold(1469598103934665603u64, |h, s| {
                (h ^ u64::from(*s)).wrapping_mul(1099511628211)
            }),
            rawler::RawImageData::Float(data) => data.iter().fold(1469598103934665603u64, |h, s| {
                (h ^ u64::from(s.to_bits())).wrapping_mul(1099511628211)
            }),
        };

        let mut best = std::time::Duration::from_secs(9999);
        for _ in 0..3 {
            let round = std::time::Instant::now();
            let _ = rawler::decode_file(path).expect("decodes");
            best = best.min(round.elapsed());
        }

        let name = std::path::Path::new(path)
            .file_name()
            .map_or(path.as_str(), |n| n.to_str().unwrap_or(path.as_str()));
        println!(
            "{name:>34}  {:>8.2}MP  {:>7}ms  {:>7}ms  {sum:016x}",
            (width * height) as f64 / 1e6,
            first.as_millis(),
            best.as_millis(),
        );
    }
}
