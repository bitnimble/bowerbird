//! Each channel's own point spread, measured off the mosaic from same-colour neighbours.
//!
//! ```text
//! channel_psf <raw>...
//! ```
//!
//! For a Gaussian point spread, two samples `d` apart straddling a point of light differ by at
//! most `exp(d^2 / 2.sigma^2)`, so a frame's extreme ratio inverts to a sigma. Red and blue each
//! sit on their own square lattice and green on a diagonal one, so the same measurement runs on
//! all three, and three sigmas are a longitudinal aberration read directly - in sensor
//! coordinates, before a demosaic, with no Laplacian model standing in for it and no lateral
//! aberration able to masquerade as one.
//!
//! **Green is measured twice, and that is the point.** Once at its own `sqrt(2)` diagonal spacing
//! and once at a spacing of two along its sub-lattice, which is the geometry red and blue are
//! stuck with. Where those two disagree, the wider spacing is the thing that failed rather than
//! the channel, and the red and blue figures beside them are not worth reading.
//!
//! **A difference between channels, and not an absolute blur.** The bound is reached only by a
//! true point of light, so what any one number here reports is as much the scene as the optics -
//! which is why the sharpen reads an edge spread off the frame instead (`edge_spread.slang`).

/// How many noise sigmas above black both samples of a pair must sit before the ratio is believed:
/// a maximum is exactly what noise wins.
const GUARD: f32 = 6.0;

/// The tail of the ratio distribution taken as the optics, as a fraction of the pairs that voted.
/// The largest ratio belongs to whichever hot pixel survived; a tail of hundreds is the lens.
const TAIL: f64 = 1e-5;

/// Pairs a channel must offer before its sigma is reported at all.
const MIN_PAIRS: u64 = 200_000;

/// What a lens does. Outside this the measurement is reporting something else.
const PLAUSIBLE: std::ops::RangeInclusive<f32> = 0.2..=2.5;

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("channel_psf <raw>...");
        std::process::exit(2);
    }
    println!(
        "{:>28}  {:>9}  {:>9}  {:>9}  {:>9}  {:>15}  {:>15}",
        "file", "green@1.41", "green@2", "red@2", "blue@2", "predicted k", "measure_defocus"
    );
    for path in paths {
        match measure(&path) {
            Err(why) => println!("{:>28}  {why}", short(&path)),
            Ok(found) => {
                // The production estimate fits `channel - luma = k.laplacian(luma)`, and one step
                // of the heat equation blurs a channel by `k` in exactly that model - so a pair of
                // Gaussian spreads predicts `k = (sigma_c^2 - sigma_g^2) / 2` and the two routes
                // are comparable in the estimator's own units rather than in pixels.
                let predicted = match (found.green_wide, found.red, found.blue) {
                    (Some(green), Some(red), Some(blue)) => {
                        let k = |sigma: f32| (sigma * sigma - green * green) / 2.0;
                        format!("{:+.3} {:+.3}", k(red), k(blue))
                    }
                    _ => "-".to_string(),
                };
                println!(
                    "{:>28}  {:>9}  {:>9}  {:>9}  {:>9}  {:>15}  {:>15}",
                    short(&path),
                    show(found.green_near),
                    show(found.green_wide),
                    show(found.red),
                    show(found.blue),
                    predicted,
                    fitted(&path),
                );
            }
        }
    }
}

/// What the shipping estimate makes of the same frame, off the pipeline's own decode.
fn fitted(path: &str) -> String {
    let Some(gpu) = rawshim::gpu::device() else { return "no adapter".to_string() };
    let Some(base) = rawshim::base::device(gpu) else { return "no pipelines".to_string() };
    let Ok(bytes) = std::fs::read(path) else { return "unreadable".to_string() };
    // Scene-linear and undenoised, which is the frame `base::prepare` measures on. `Fit::Only`
    // rather than `Measure`: this decode asks for no denoise, and `Measure` fits nothing where
    // there are no amounts, which would leave the fitted ceiling below unexercised.
    let Some(frame) =
        rawshim::decode_frame_bytes(&bytes, 0, rawshim::galosh::Fit::Only)
    else {
        return "no decode".to_string();
    };
    let rawshim::frame::Pixels::Sixteen(samples) = &frame.pixels else {
        return "not 16-bit".to_string();
    };
    match pollster::block_on(rawshim::base::measure_defocus(
        gpu,
        base,
        samples,
        frame.width,
        frame.height,
        frame.noise,
        frame.matrix,
    )) {
        None => "declined".to_string(),
        Some((red, blue)) => format!("{red:+.3} {blue:+.3}"),
    }
}

fn short(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

fn show(sigma: Option<f32>) -> String {
    sigma.map_or("-".to_string(), |value| format!("{value:.3}"))
}

struct Found {
    /// Green across the site diagonal, `d^2 = 2` - the closest spacing the CFA offers.
    green_near: Option<f32>,
    /// Green along its own sub-lattice, `d^2 = 4` - the control for the spacing red and blue use.
    green_wide: Option<f32>,
    red: Option<f32>,
    blue: Option<f32>,
}

fn measure(path: &str) -> Result<Found, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{e}"))?;
    let noise = rawshim::decode_frame_bytes(&bytes, 0, rawshim::galosh::Fit::Only)
        .and_then(|frame| frame.noise)
        .ok_or("the frame did not fit its noise")?;

    let source = rawler::rawsource::RawSource::new(std::path::Path::new(path))
        .map_err(|e| format!("{e}"))?;
    let decoder = rawler::get_decoder(&source).map_err(|e| format!("{e}"))?;
    let params = rawler::decoders::RawDecodeParams::default();
    let image = decoder.raw_image(&source, &params, false).map_err(|e| format!("{e}"))?;
    let plane = match &image.data {
        rawler::rawimage::RawImageData::Integer(values) => values,
        _ => return Err("not an integer plane".to_string()),
    };
    let (width, height) = (image.width, image.height);
    let white = image.whitelevel.0.first().copied().unwrap_or(u32::from(u16::MAX)) as f32;
    let black =
        image.blacklevel.levels.first().map_or(0.0, |level| level.n as f32 / level.d as f32);
    let range = (white - black).max(1.0);
    let floor = |counts: f32| {
        let level = ((counts - black) / range).clamp(0.0, 1.0);
        let sigma = ((noise.alpha * level + noise.sigma_sq).max(0.0)).sqrt() * range;
        black + GUARD * sigma
    };

    let colour = |r: usize, c: usize| image.camera.cfa.color_at(r % 2, c % 2);
    let at = |r: usize, c: usize| f32::from(plane[r * width + c]);
    // A pair is believed only where neither sample is into the shoulder: a clipped highlight caps
    // the brighter one and reports a ratio the optics never produced. A 3x3 rather than the pair
    // alone - a sample beside a clipped one has had light bled into it by the very spread being
    // measured, so the pair is no longer a clean sample of it.
    let ceiling = white - 1.0;
    let near_clipping = |r: usize, c: usize| {
        (r.saturating_sub(1)..=(r + 1).min(height - 1))
            .any(|rr| (c.saturating_sub(1)..=(c + 1).min(width - 1)).any(|cc| at(rr, cc) >= ceiling))
    };

    let voted = |offsets: &[(usize, usize)], want: usize| -> Option<f32> {
        let mut tally = Tally::default();
        for r in 0..height {
            for c in 0..width {
                if colour(r, c) != want {
                    continue;
                }
                let here = at(r, c);
                for &(dr, dc) in offsets {
                    let (rr, cc) = (r + dr, c + dc);
                    if rr >= height || cc >= width {
                        continue;
                    }
                    let there = at(rr, cc);
                    let (low, high) = (here.min(there), here.max(there));
                    if low <= floor(low) || near_clipping(r, c) || near_clipping(rr, cc) {
                        continue;
                    }
                    tally.vote((high - black) / (low - black));
                }
            }
        }
        let spacing = offsets.first().map(|&(dr, dc)| (dr * dr + dc * dc) as f32)?;
        tally.sigma(spacing)
    };

    // `(1, 1)` lands on a green from any green in every Bayer arrangement - the two greens of a
    // site sit at opposite parities of both row and column - so the near pair needs no branch on
    // which diagonal this sensor puts them on.
    Ok(Found {
        green_near: voted(&[(1, 1)], 1),
        green_wide: voted(&[(0, 2), (2, 0)], 1),
        red: voted(&[(0, 2), (2, 0)], 0),
        blue: voted(&[(0, 2), (2, 0)], 2),
    })
}

/// A log-spaced histogram of one channel's neighbour ratios, and the sigma its tail implies.
struct Tally {
    bins: Vec<u64>,
}

impl Default for Tally {
    fn default() -> Tally {
        Tally { bins: vec![0; Tally::BINS] }
    }
}

impl Tally {
    const BINS: usize = 512;
    /// The widest `ln(ratio)` a bin can hold. `ln(64)` would do for the diagonal spacing, but a
    /// spacing of two puts the same sigma at twice the exponent and would saturate every sharp
    /// lens at `d^2 = 4`.
    const CEIL_LN: f32 = 12.0;

    fn vote(&mut self, ratio: f32) {
        if !(ratio > 1.0) {
            return;
        }
        let slot = (ratio.ln() / Tally::CEIL_LN * Tally::BINS as f32) as usize;
        self.bins[slot.min(Tally::BINS - 1)] += 1;
    }

    fn sigma(&self, spacing: f32) -> Option<f32> {
        let total: u64 = self.bins.iter().sum();
        if total < MIN_PAIRS {
            return None;
        }
        let tail = ((total as f64 * TAIL) as u64).max(32);
        let mut seen = 0u64;
        for bin in (0..Tally::BINS).rev() {
            seen += self.bins[bin];
            if seen < tail {
                continue;
            }
            // The bin's lower edge, which rounds the ratio down and so the sigma up: overshooting
            // is a blur read as worse than it is, undershooting is a lens read as perfect.
            let ln_ratio = bin as f32 / Tally::BINS as f32 * Tally::CEIL_LN;
            if ln_ratio <= 0.0 {
                return None;
            }
            let sigma = (spacing / (2.0 * ln_ratio)).sqrt();
            return PLAUSIBLE.contains(&sigma).then_some(sigma);
        }
        None
    }
}
