//! Does a loupe tile fit the same noise the whole frame does?
//!
//! ```text
//! tile_noise <raw>...
//! ```
//!
//! Phase 0 of the denoise is a whole-*region* reduction: it bins the region's blocks by mean,
//! regresses variance against level, and hands back one alpha and one sigma. A tile is its own
//! region, so a magnified crop fits its own noise from a few hundred thousand photosites of one
//! part of one picture, where the export fits it from all of them.
//!
//! What that would mean if the two disagree: the same pixel is denoised at one strength in the
//! loupe and another in the file, and the strength moves as the reader pans - each pan being a new
//! region and a new fit. No halo can fix it; the reduction is not local.
//!
//! Reported as the noise at mid-grey, which is the number the strength is actually set from, and
//! as the ratio - a tile at 1.30 is denoised half again as hard as the frame it was cut from.

/// The fit taken on its own, against the one a whole denoise measures.
///
/// Two claims at once: that `galosh::fit` and `galosh::denoise` agree - the fit really is the
/// prefix it says it is - and that the fit does not depend on the size the caller asked the decode
/// for, which is what lets one number answer for the editor, a tile and every rendition.
fn fit_only() {
    let files: Vec<String> = std::env::args().skip(1).filter(|a| !a.starts_with("--")).collect();
    let amounts = rawshim::galosh::Amounts::from_sliders(50.0, 50.0);

    println!("{:>16}  {:>10}  {:>10}  {:>10}  {}", "file", "alpha", "sigma_sq", "unified", "from");
    for path in files {
        let name = std::path::Path::new(&path)
            .file_stem()
            .map_or_else(|| path.clone(), |s| s.to_string_lossy().into_owned());
        // The size the caller asks for must not move the fit: halving happens after the denoise,
        // so both of these see the same full-resolution mosaic.
        for long_edge in [0u32, 1000] {
            let Some(frame) = rawshim::decode_frame_denoised(&path, 16, true, long_edge, amounts)
            else {
                continue;
            };
            let Some(fit) = frame.noise else { continue };
            println!(
                "{name:>16}  {:>10.7}  {:>10.7}  {:>10.7}  denoise at {long_edge}",
                fit.alpha, fit.sigma_sq, fit.unified_sigma,
            );
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let started = std::time::Instant::now();
        let fit = rawshim::decode_frame_bytes(&bytes, 16, true, 0, rawshim::galosh::Fit::Only)
            .and_then(|frame| frame.noise);
        let Some(fit) = fit else { continue };
        println!(
            "{name:>16}  {:>10.7}  {:>10.7}  {:>10.7}  fit alone in {}ms",
            fit.alpha,
            fit.sigma_sq,
            fit.unified_sigma,
            started.elapsed().as_millis(),
        );
    }
}

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("tile_noise <raw>...");
        return;
    }

    let amounts = rawshim::galosh::Amounts::from_sliders(50.0, 50.0);
    if std::env::args().any(|a| a == "--fit") {
        fit_only();
        return;
    }
    // Four corners and the middle, because a fit varies with what the crop happens to contain -
    // sky is not grass - and one tile would not say whether the spread is the tile or the place.
    let places = [(1200usize, 900usize), (1200, 3600), (4400, 900), (4400, 3600), (2800, 2200)];

    println!("{:>16}  {:>10}  {:>10}  {:>7}  {}", "file", "frame", "tile", "ratio", "at");
    for path in files {
        let name = std::path::Path::new(&path)
            .file_stem()
            .map_or_else(|| path.clone(), |s| s.to_string_lossy().into_owned());

        let Some(frame) = rawshim::decode_frame_denoised(&path, 16, true, 0, amounts) else {
            println!("{name:>16}  declined");
            continue;
        };
        let Some(whole) = frame.noise else {
            println!("{name:>16}  the frame carries no noise model");
            continue;
        };

        for (left, top) in places {
            if left + 512 >= frame.width || top + 512 >= frame.height {
                continue;
            }
            let tile = rawshim::Tile { left, top, width: 512, height: 512 };
            let Some(cut) =
                rawshim::decode_tile(&path, tile, 16, true, amounts, rawshim::galosh::Fit::Measure, rawshim::RENDITION_TILE_HALO)
            else {
                println!("{name:>16}  the tile at {left},{top} declined");
                continue;
            };
            let Some(local) = cut.noise else { continue };
            let (a, b) = (whole.model().at_mid_grey(), local.model().at_mid_grey());
            println!(
                "{name:>16}  {a:>10.6}  {b:>10.6}  {:>7.3}  {left},{top}",
                if a > 0.0 { b / a } else { f32::NAN },
            );
        }
    }
}
