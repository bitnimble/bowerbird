//! What a crop of a Sony ARW costs, against decoding the whole frame.
//!
//! Sony's lossless compression is tiled in two dimensions with one file offset per tile, so unlike
//! Canon's CRX - a single tile with prediction running down it - a crop can be reached directly.
//! This decodes a loupe-sized region at a few positions and checks that every sample inside the
//! tiles it touched matches the whole-frame decode.

use rawler::RawImageData;
use rawler::imgop::{Dim2, Point, Rect};

/// What the loupe asks for, in sensor pixels.
const CROP: usize = 400;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("arw_region <raw.ARW>");
        return;
    };

    // Opened once and reused, which is how a loupe uses it: many crops of one photograph. Timing
    // `decode_file_region` instead would charge every crop for re-reading the whole file.
    let source = rawler::rawsource::RawSource::new(std::path::Path::new(&path)).expect("opens");
    let decoder = rawler::get_decoder(&source).expect("a decoder");
    let params = rawler::decoders::RawDecodeParams::default();

    let started = std::time::Instant::now();
    let whole = decoder.raw_image(&source, &params, false).expect("whole decode");
    let whole_ms = started.elapsed().as_millis();
    let (width, height) = (whole.width, whole.height);
    let whole = samples(&whole);
    println!("{width}x{height}, whole decode {whole_ms}ms");
    println!("{:>14}  {:>8}  {:>7}  {}", "crop at", "decode", "saved", "matches whole");

    for (x, y) in [(0, 0), (width / 2, height / 2), (width - CROP, height - CROP), (width / 4, height / 3)] {
        let region = Rect::new(Point::new(x, y), Dim2::new(CROP, CROP));
        let started = std::time::Instant::now();
        let part = decoder.raw_image_region(&source, &params, region, false).expect("region decode");
        let ms = started.elapsed().as_millis();
        let part = samples(&part);

        // Every sample of the requested crop has to be the whole decode's, sample for sample.
        // Outside it the frame is zero, which is why only the crop is compared.
        let mut agrees = true;
        for row in y..(y + CROP).min(height) {
            let at = row * width + x;
            let to = at + CROP.min(width - x);
            if whole[at..to] != part[at..to] {
                agrees = false;
                break;
            }
        }

        println!(
            "{:>14}  {ms:>5}ms  {:>6.0}%  {}",
            format!("{x},{y}"),
            100.0 - 100.0 * ms as f64 / whole_ms as f64,
            if agrees { "yes" } else { "NO" },
        );
    }
}

fn samples(image: &rawler::RawImage) -> Vec<u16> {
    match &image.data {
        RawImageData::Integer(data) => data.clone(),
        RawImageData::Float(_) => panic!("expected an integer sensor image"),
    }
}
