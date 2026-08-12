//! What stopping the CRX decode early is worth, which is what a loupe crop can actually save.
//!
//! A crop cannot be seeked to - see `CodecParams::decode_rows` - so the saving is whatever lies
//! below the crop's last row. This decodes the same file to a series of depths and reports both
//! the cost and the samples, so a partial decode is held to matching the whole one over the rows
//! it claims to have decoded.

use rawler::decompressors::crx::{decompress_crx_image, decompress_crx_image_rows};
use rawler::formats::bmff::ext_cr3::cmp1::Cmp1Box;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("crx_rows <raw.CR3>");
        return;
    };

    let (mdat, cmp1) = match mdat_and_cmp1(&path) {
        Some(found) => found,
        None => {
            eprintln!("{path}: no CRX image found");
            return;
        }
    };

    let started = std::time::Instant::now();
    let whole = decompress_crx_image(&mdat, &cmp1).expect("whole decode");
    let whole_ms = started.elapsed().as_millis();
    let (width, height) = (cmp1.f_width as usize, cmp1.f_height as usize);
    println!("{width}x{height}, whole decode {whole_ms}ms");
    println!("{:>10}  {:>8}  {:>8}  {:>7}  {}", "last row", "of frame", "decode", "saved", "matches whole");

    for (num, den) in [(1, 16), (1, 4), (1, 2), (3, 4), (1, 1)] {
        // Inclusive and 0-based, as `decompress_crx_image_rows` takes it, so the whole frame is
        // `height - 1` rather than `height`.
        let last_row = ((height * num) / den).saturating_sub(1);

        let started = std::time::Instant::now();
        let part = decompress_crx_image_rows(&mdat, &cmp1, last_row).expect("partial decode");
        let ms = started.elapsed().as_millis();

        // Every row the partial decode claims has to be the whole decode's row, sample for
        // sample: stopping early must not change what came before it.
        let claimed = (last_row + 1).min(height);
        let agrees = whole[..claimed * width] == part[..claimed * width];

        println!(
            "{last_row:>10}  {:>7.0}%  {ms:>6}ms  {:>6.0}%  {}",
            100.0 * claimed as f64 / height as f64,
            100.0 - 100.0 * ms as f64 / whole_ms as f64,
            if agrees { "yes" } else { "NO" },
        );
    }
}

/// The CR3's MDAT bytes and the CMP1 box describing them.
fn mdat_and_cmp1(path: &str) -> Option<(Vec<u8>, Cmp1Box)> {
    use rawler::formats::bmff::Bmff;
    let file = std::fs::File::open(path).ok()?;
    let bmff = Bmff::new(&mut std::io::BufReader::new(&file)).ok()?;
    // The largest, because a CR3 carries several CRX tracks - a thumbnail and a preview before
    // the frame anybody wants to measure.
    let cr3 = bmff
        .filebox
        .moov
        .traks
        .iter()
        .filter_map(|trak| {
            let cmp1 = trak.mdia.minf.stbl.stsd.craw.as_ref()?.cmp1.clone()?;
            Some((trak.mdia.minf.stbl.co64.as_ref()?.entries[0], trak.mdia.minf.stbl.stsz.sample_sizes[0], cmp1))
        })
        .max_by_key(|(_, _, cmp1)| cmp1.f_width as u64 * cmp1.f_height as u64)?;
    let (offset, size, cmp1) = cr3;
    let mut bytes = vec![0u8; size as usize];
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    file.read_exact(&mut bytes).ok()?;
    Some((bytes, cmp1))
}
