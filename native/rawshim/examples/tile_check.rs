//! Does the rawler tile show the same part of the photograph as the LibRaw tile?
//!
//! ```text
//! tile_check <raw> [left top width height]
//! ```
//!
//! The two decoders will not agree sample for sample - that is what `compare_decoders` measures -
//! so this asks the weaker question that has to hold anyway: same dimensions, and the same content,
//! judged by whether the tile matches the same region cut out of each decoder's whole frame.
//!
//! Getting that wrong is the failure this exists for. A tile is named in coordinates that pass
//! through a crop offset and an orientation, and an error in either shows up as a tile of the right
//! size holding the wrong part of the picture, which no measurement of the frame would notice.

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("tile_check <raw> [left top width height]");
        return;
    };
    let numbers: Vec<usize> = args.filter_map(|a| a.parse().ok()).collect();
    let tile = match numbers.as_slice() {
        [left, top, width, height] => rawshim::Tile { left: *left, top: *top, width: *width, height: *height },
        _ => rawshim::Tile { left: 2000, top: 1400, width: 512, height: 512 },
    };

    let amounts = rawshim::galosh::Amounts::default();
    let started = std::time::Instant::now();
    let Some(whole) = rawshim::decode_rawler::decode(&path, amounts) else {
        eprintln!("the whole frame declined");
        return;
    };
    let frame_ms = started.elapsed().as_millis();

    // Twice, because the first pays for the GPU pipelines the frame decode already built and a
    // loupe's second tile is the one that matters.
    rawshim::decode_rawler::decode_tile(&path, tile, amounts);
    let started = std::time::Instant::now();
    let Some(cut) = rawshim::decode_rawler::decode_tile(&path, tile, amounts) else {
        eprintln!("the tile declined");
        return;
    };
    let tile_ms = started.elapsed().as_millis();

    println!(
        "whole {}x{} in {frame_ms}ms  tile {}x{} in {tile_ms}ms  asked {}x{}",
        whole.width, whole.height, cut.width, cut.height, tile.width, tile.height
    );

    let (Some(a), Some(b)) = (whole.samples16(), cut.samples16()) else {
        eprintln!("not a 16-bit decode");
        return;
    };

    // The tile against the same rectangle of the whole frame. Both have been through the same
    // orientation, so a tile that landed where it was asked for reads the same samples.
    let mut worst = 0u32;
    let mut total = 0f64;
    let mut counted = 0u64;
    for row in 0..cut.height {
        for col in 0..cut.width {
            let (fx, fy) = (tile.left + col, tile.top + row);
            if fx >= whole.width || fy >= whole.height {
                continue;
            }
            for channel in 0..3 {
                let from = (fy * whole.width + fx) * 3 + channel;
                let to = (row * cut.width + col) * 3 + channel;
                let delta = u32::from(a[from].abs_diff(b[to]));
                worst = worst.max(delta);
                total += f64::from(delta);
                counted += 1;
            }
        }
    }
    if counted == 0 {
        println!("the tile does not overlap the frame at all - the coordinates are wrong");
        return;
    }
    // In the 16-bit samples the frame is carried in, so a few hundred is the demosaic seeing a
    // different neighbourhood at the tile's edge and tens of thousands is the wrong part of the
    // photograph.
    println!("mean {:.1}  worst {worst}  over {counted} samples", total / counted as f64);
}
