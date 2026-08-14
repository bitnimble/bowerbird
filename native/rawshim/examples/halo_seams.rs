//! What a tile's halo has to be, judged by eye at the seam.
//!
//! ```text
//! halo_seams <raw> <out-dir> [x,y,side] [halo,halo,...] [luma,colour]
//! ```
//!
//! The amounts default to the calibrated 50,50 and are worth raising to 100,100 to judge this:
//! the shrinkage scales with them, so whatever the halo does it does hardest at the top of the
//! track, and a halo that holds there holds everywhere.
//!
//! `TILE_HALO` is 64 by reasoning rather than by measurement, and it is the whole of what tiling
//! the mosaic denoise costs: a tile decodes and denoises its halo on every side and then throws it
//! away, so at a tile of 1024 the frame is 1.5x its own area. Whether 64 is needed is therefore
//! worth about a third of the denoise.
//!
//! The comparison is one region cut two ways. The reference is that region decoded as a single
//! tile, so nothing inside it is a seam; against it, the same region cut into four and reassembled
//! at each halo. Both go through `decode_tile`, so what differs between them is the tiling and
//! nothing else - the same fit, the same amounts, the same demosaic, the same orientation.
//!
//! **The frame's own fit is handed to every tile**, since a tile left to measure its own lands
//! between 0.49 and 1.51 times the frame's and that difference would swamp the halo's.
//!
//! Written out at 100%, centred on the seams: `seam-*.avif` is the picture to judge and
//! `diff-*.avif` is the same thing amplified 16x, which is there because a seam can be plainly
//! visible in a difference and invisible in the photograph, and only one of those matters.

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(path), Some(out)) = (args.next(), args.next()) else {
        eprintln!("halo_seams <raw> <out-dir> [x,y,side] [halo,halo,...]");
        std::process::exit(2);
    };
    let region = args.next().and_then(|s| triple(&s)).unwrap_or((3000, 2000, 1024));
    let halos: Vec<usize> = args
        .next()
        .map(|s| s.split(',').filter_map(|v| v.parse().ok()).collect())
        .unwrap_or_else(|| vec![0, 4, 8, 16, 32, 64, 128]);
    let sliders = args
        .next()
        .and_then(|s| {
            let parts: Vec<f64> = s.split(',').filter_map(|v| v.parse().ok()).collect();
            match parts[..] {
                [luma, colour] => Some((luma, colour)),
                _ => None,
            }
        })
        .unwrap_or((50.0, 50.0));
    let (x, y, side) = region;
    std::fs::create_dir_all(&out).expect("the output directory");

    // The frame's own noise, which every tile below is then denoised at. `Fit::Only` stops after
    // the statistics, so this is the cheap half of a decode rather than another whole one.
    let bytes = std::fs::read(&path).expect("the RAW reads");
    let frame = rawshim::decode_frame_bytes(&bytes, 16, true, 0, rawshim::galosh::Fit::Only)
        .expect("the frame decodes");
    let fit = frame.noise.expect("the frame fitted its noise");
    drop(frame);
    let amounts = rawshim::galosh::Amounts::from_sliders(sliders.0, sliders.1);
    eprintln!(
        "fit alpha {:.3e} sigma_sq {:.3e}, denoising at {},{}",
        fit.alpha, fit.sigma_sq, sliders.0, sliders.1,
    );

    let cut = |left: usize, top: usize, width: usize, height: usize| -> Vec<u8> {
        let tile = rawshim::Tile { left, top, width, height };
        let frame = rawshim::decode_tile(&path, tile, 8, false, amounts, rawshim::galosh::Fit::Given(fit))
            .unwrap_or_else(|| panic!("the {width}x{height} tile at {left},{top} declined"));
        let rawshim::frame::Pixels::Eight(pixels) = frame.pixels else {
            panic!("not an 8-bit tile")
        };
        assert_eq!((frame.width, frame.height), (width, height), "the tile came back a different size");
        pixels
    };

    // **One tile over the whole region, at a halo far past any under test.** Not the whole frame,
    // though that was tried: a tile and a frame differ by about 1.15 of 255 over the *interior*,
    // where a seam has nothing to do with anything, and that floor is three times the difference
    // the halo governs. Whatever causes it - `Fit::Given` against `Fit::Measure` is the suspect -
    // it is a separate question, and referencing against it measures that instead of this.
    //
    // A tile keeps every other thing about the path identical, so the halo is the only variable.
    const REFERENCE_HALO: usize = 512;
    rawshim::set_tile_halo(REFERENCE_HALO);
    let reference = cut(x, y, side, side);
    let half = side / 2;
    // Both seams cross at the region's middle, so one square centred there shows each of them at
    // 100% and the corner where they meet, which is where a short halo has least context of all.
    let window = (side / 2).min(512);
    let crop = |image: &[u8]| centred(image, side, window);
    write(&format!("{out}/seam-reference.avif"), &crop(&reference), window, window);

    eprintln!("region roughness {:.1} of 255, so it is texture rather than sky", roughness(&reference));
    // **The control, and the reason the table has two halves.** A tile and a frame can differ for
    // reasons that have nothing to do with a seam, and such a difference lands on every pixel
    // equally - so the interior says what this comparison's noise floor is, and only the amount by
    // which the seam exceeds it is the halo's doing.
    println!(
        "{:>6}  {:>9} {:>8}  {:>9} {:>8}",
        "halo", "seam max", "seam avg", "away max", "away avg",
    );
    for halo in &halos {
        rawshim::set_tile_halo(*halo);
        // Four quarters, reassembled. The seams are the region's own middle row and column.
        let mut assembled = vec![0u8; side * side * 3];
        for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            let quarter = cut(x + dx * half, y + dy * half, half, half);
            for row in 0..half {
                let to = ((dy * half + row) * side + dx * half) * 3;
                assembled[to..to + half * 3]
                    .copy_from_slice(&quarter[row * half * 3..(row + 1) * half * 3]);
            }
        }

        let seam = differences(&assembled, &reference, side, half, true);
        let away = differences(&assembled, &reference, side, half, false);
        println!(
            "{halo:>6}  {:>9} {:>8.3}  {:>9} {:>8.3}",
            seam.0, seam.1, away.0, away.1,
        );
        write(&format!("{out}/seam-halo{halo}.avif"), &crop(&assembled), window, window);
        let diff = crop(&amplified(&assembled, &reference));
        write(&format!("{out}/diff-halo{halo}.avif"), &diff, window, window);
    }
    rawshim::set_tile_halo(usize::MAX);
    eprintln!(
        "\nwrote {} pairs to {out}: {window}x{window} at 100%, both seams crossing in the middle",
        halos.len(),
    );
}

/// The worst and mean difference, within eight pixels of a seam or well away from one.
///
/// Both, because a tile and a frame can differ for reasons a seam has nothing to do with, and such
/// a difference falls on every pixel alike. The interior is therefore the floor this comparison
/// can resolve, and what the halo governs is only the amount by which the seam stands above it.
fn differences(mine: &[u8], reference: &[u8], side: usize, half: usize, seam: bool) -> (u8, f64) {
    let near = |at: usize| at.abs_diff(half) <= 8;
    // Well away rather than merely not-near, so the band the halo is still reaching into is in
    // neither sample.
    let far = |at: usize| at.abs_diff(half) > 192;
    let (mut worst, mut total, mut counted) = (0u8, 0f64, 0usize);
    for row in 0..side {
        for col in 0..side {
            let wanted = match seam {
                true => near(row) || near(col),
                false => far(row) && far(col),
            };
            if !wanted {
                continue;
            }
            for channel in 0..3 {
                let at = (row * side + col) * 3 + channel;
                let delta = mine[at].abs_diff(reference[at]);
                worst = worst.max(delta);
                total += f64::from(delta);
                counted += 1;
            }
        }
    }
    (worst, total / counted.max(1) as f64)
}

/// A `window`-sided square from the middle of a `side`-sided image.
fn centred(image: &[u8], side: usize, window: usize) -> Vec<u8> {
    let from = (side - window) / 2;
    let mut out = vec![0u8; window * window * 3];
    for row in 0..window {
        let at = ((from + row) * side + from) * 3;
        out[row * window * 3..(row + 1) * window * 3]
            .copy_from_slice(&image[at..at + window * 3]);
    }
    out
}

/// Mean absolute deviation of luma, which says whether the region has anything to smear.
///
/// A flat sky denoises to itself whatever the halo is, so a sweep over one would report that every
/// halo works. Printed rather than checked, since which part of a frame is worth looking at is the
/// caller's judgement.
fn roughness(image: &[u8]) -> f64 {
    let luma: Vec<f64> = image
        .chunks_exact(3)
        .map(|p| 0.2126 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[2]))
        .collect();
    let mean = luma.iter().sum::<f64>() / luma.len() as f64;
    luma.iter().map(|v| (v - mean).abs()).sum::<f64>() / luma.len() as f64
}

/// The absolute difference, 16x, so a seam nobody can see in the photograph is still visible here.
fn amplified(mine: &[u8], reference: &[u8]) -> Vec<u8> {
    mine.iter()
        .zip(reference)
        .map(|(a, b)| a.abs_diff(*b).saturating_mul(16))
        .collect()
}

fn triple(text: &str) -> Option<(usize, usize, usize)> {
    let parts: Vec<usize> = text.split(',').filter_map(|v| v.parse().ok()).collect();
    match parts[..] {
        [x, y, side] => Some((x, y, side)),
        _ => None,
    }
}

/// Lossless enough to judge a seam by: quantizer 0 and no chroma subsampling, so what survives is
/// the 8-bit YCbCr rounding rather than anything the encoder chose to discard.
fn write(path: &str, rgb: &[u8], width: usize, height: usize) {
    rawshim::avif::encode_rendition(
        std::borrow::Cow::Borrowed(rgb),
        width,
        height,
        0,
        6,
        true,
        path,
    )
    .expect("the crop encodes");
}
