//! Writes the same Rec.2020 PQ test pattern twice: as an AVIF the browser decodes, and as
//! the raw samples that produced it.
//!
//! The point is a comparison the probe page cannot make on its own (`docs/raw-edit-gpu.md`
//! §7.2): whether a PQ frame down the media path and the same pixels through an
//! extended-range WebGPU canvas land in the same place on one panel. Both outputs come from
//! one buffer, so any difference on screen belongs to the two display paths and not to the
//! content.
//!
//! Encoded by the same `avif::save_still` the renditions use, under the same CICP, at
//! quantizer 0 so the media arm is as close to the samples as the format allows.
//!
//! cargo run --release --example pq_pattern -- <out-dir>

use rawshim::{avif, hdr_args, tone};

const CELL: usize = 200;
const COLUMNS: usize = 6;
const ROWS: usize = 4;

/// Per-channel nits, which is what both paths are handed.
///
/// Row 1 is a neutral ramp inside the shipping peak. Rows 2 and 3 are Rec.2020 primaries
/// and secondaries, every one of them outside P3, at two levels. Row 4 runs past any
/// display's headroom on purpose: PQ carries absolute nits so the compositor can tone-map
/// it, while an extended-range canvas value can only clip, and that difference is the one
/// thing the canvas path cannot reproduce.
fn pattern() -> Vec<[f64; 3]> {
    let neutral = [100.0, 203.0, 300.0, 400.0, 600.0, 1000.0];
    let beyond = [1500.0, 2000.0, 3000.0, 4000.0, 6000.0, 10000.0];
    let mut cells = Vec::with_capacity(COLUMNS * ROWS);
    cells.extend(neutral.iter().map(|&n| [n, n, n]));
    for level in [203.0, 600.0] {
        cells.extend([
            [level, 0.0, 0.0],
            [0.0, level, 0.0],
            [0.0, 0.0, level],
            [level, level, 0.0],
            [0.0, level, level],
            [level, 0.0, level],
        ]);
    }
    cells.extend(beyond.iter().map(|&n| [n, n, n]));
    cells
}

fn main() {
    let out = std::env::args().nth(1).unwrap_or_else(|| ".".to_string());
    let (width, height) = (CELL * COLUMNS, CELL * ROWS);
    let cells = pattern();

    let mut samples = vec![0u16; width * height * 3];
    for y in 0..height {
        for x in 0..width {
            let cell = cells[(y / CELL) * COLUMNS + (x / CELL)];
            let at = (y * width + x) * 3;
            for channel in 0..3 {
                samples[at + channel] = (tone::pq(cell[channel]) * 65535.0).round() as u16;
            }
        }
    }

    let (primaries, transfer, matrix) = hdr_args::cicp();
    let avif_path = format!("{out}/pq-pattern.avif");
    avif::save_still(
        std::borrow::Cow::Borrowed(&samples),
        width,
        height,
        &avif::StillOptions {
            cicp: avif::Cicp { primaries, transfer, matrix },
            format: hdr_args::Chroma::Yuv444.avif_format(),
            quantizer: 0,
            speed: 4,
        },
        &avif_path,
    )
    .expect("the pattern should encode");

    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in &samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    let bin_path = format!("{out}/pq-pattern.bin");
    std::fs::write(&bin_path, &bytes).expect("the samples should write");

    println!("{width}x{height}");
    println!("{avif_path}");
    println!("{bin_path}");
}
