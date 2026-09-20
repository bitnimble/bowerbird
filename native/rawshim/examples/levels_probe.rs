//! Where each candidate rule puts diffuse white, over as many frames as it is handed.
//!
//! ```text
//! levels_probe <raw>...
//! ```
//!
//! **The anchor is the one level nothing in the frame identifies.** Black and saturation are
//! measurements - a pedestal and a clip, both in counts - but diffuse white is a statement about
//! the exposure, and a scene-referred frame carries no exposure in its pixels: double the shutter
//! and every code doubles with the scene unchanged. So a rule that reads it off the histogram is
//! answering a different question from one that reads it off the body's own rendering, and the two
//! disagree by whatever the scene's reflectance distribution happens to be.
//!
//! Three candidates, printed per frame in stops so the disagreement is a number. The configured
//! quantile, as the pipeline anchors today. The photometric answer, from ISO 12232's
//! saturation-based speed: a metered 100% reflector lands at `(100/18) * (10/78)` of saturation,
//! about 0.71, a constant of the standard rather than of the frame. And the body's own, carried
//! from the embedded preview by rank.
//!
//! A rank only carries a level across if both sides rank the same quantity, so both sides here rank
//! the **brightest channel** - which is what `fit_source.slang`'s `fit_scan` histograms. Read as
//! luma on one side and as a maximum on the other, the same rank lands on a higher level and the
//! error grows with how saturated the picture is.

use rawshim::galosh::{Detail, Fit};

/// `H_sat / H_grey` under ISO 12232: saturation-based speed is `78/H_sat`, and the metered grey
/// sits at `10/H`, so the ratio is fixed by the standard rather than by the camera.
const GREY_UNDER_SATURATION: f64 = 78.0 / 10.0;

/// A perfect diffuse reflector against the 18% the meter is calibrated for.
const WHITE_OVER_GREY: f64 = 100.0 / 18.0;

/// The coded level the body is taken to call white, where one figure is wanted per frame.
const WHITE_CODE: u8 = 237;

/// The codes the calibration is searched over, since which one a body calls white is the one free
/// constant in the rule.
const CODES: std::ops::RangeInclusive<u8> = 170..=254;

/// A frame's levels, ranked once so that any number of candidate anchors costs a lookup.
struct Ranked {
    /// The brightest channel of every pixel, ascending, as a fraction of saturation.
    levels: Vec<f32>,
    /// How many preview pixels sit below each code, so a share is O(1) in the code.
    below: [usize; 256],
    counted: usize,
}

impl Ranked {
    fn share_at(&self, code: u8) -> Option<f64> {
        let below = self.below[usize::from(code)];
        (below < self.counted).then(|| below as f64 / self.counted as f64)
    }

    fn level_at(&self, share: f64) -> f64 {
        let index = ((self.levels.len() - 1) as f64 * share).round() as usize;
        f64::from(self.levels[index.min(self.levels.len() - 1)])
    }

    fn body_white(&self, code: u8) -> Option<f64> {
        self.share_at(code).map(|share| self.level_at(share))
    }

    /// The code this body would have to call white for the rule to land on `want`.
    fn code_for(&self, want: f64) -> Option<u8> {
        CODES.clone().find(|code| self.body_white(*code).is_some_and(|at| at >= want))
    }

    /// The coded level at a rank of the body's own rendering.
    ///
    /// **What a JPEG's darkest percentile is, is the body's black point**, and it is not always
    /// zero: a rendering with a lifted floor teaches the camera match that near-black is grey, and
    /// the match is then right to render it that way. Read here so that a lifted shadow can be laid
    /// at the body's door or taken away from it.
    fn code_at(&self, share: f64) -> u8 {
        let want = (self.counted as f64 * share) as usize;
        (0..256u16).find(|code| self.below[usize::from(*code)] > want).map_or(255, |code| code as u8)
    }
}

fn ranked(path: &str, samples: &[u16]) -> Option<Ranked> {
    let mut levels: Vec<f32> = samples
        .chunks_exact(3)
        .map(|rgb| f32::from(rgb[0].max(rgb[1]).max(rgb[2])) / f32::from(u16::MAX))
        .collect();
    levels.sort_by(f32::total_cmp);

    let preview = rawshim::decode_embedded_rgb(path, 0)?;
    let mut counts = [0usize; 256];
    for rgb in preview.data.chunks_exact(3) {
        counts[usize::from(rgb[0].max(rgb[1]).max(rgb[2]))] += 1;
    }
    let counted: usize = counts.iter().sum();
    let mut below = [0usize; 256];
    let mut running = 0usize;
    for code in 0..256 {
        below[code] = running;
        running += counts[code];
    }
    (counted > 0).then_some(Ranked { levels, below, counted })
}

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    assert!(!paths.is_empty(), "levels_probe <raw>...");
    let photometric = WHITE_OVER_GREY / GREY_UNDER_SATURATION;
    let stops = |ratio: f64| ratio.log2();

    println!("ISO 12232 puts a metered 100% reflector at {photometric:.3} of saturation");
    println!("{:<16} {:>6} {:>8} {:>8} {:>8} {:>6}", "frame", "iso", "white", "body", "stops", "code");

    let mut apart: Vec<f64> = Vec::new();
    let mut implied: Vec<f64> = Vec::new();
    for path in &paths {
        let name = std::path::Path::new(path)
            .file_name()
            .map_or_else(String::new, |s| s.to_string_lossy().into_owned());
        let Some(header) = rawshim::header::read_path(path) else {
            println!("{name:<16} unreadable header");
            continue;
        };
        let Some(frame) = rawshim::decode_frame_denoised(path, 0, Detail::at(0.0, 0.0), Fit::Only)
        else {
            println!("{name:<16} would not decode");
            continue;
        };
        let Some(samples) = frame.samples16() else {
            println!("{name:<16} not 16-bit");
            continue;
        };
        let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
        let Some(levels) = rawshim::hdr::levels_of(gpu, samples, frame.width, frame.height, 0.9)
        else {
            println!("{name:<16} no levels");
            continue;
        };
        let white = levels.white.raw() / f64::from(u16::MAX);

        let Some(ranked) = ranked(path, samples) else {
            println!("{name:<16} {:>6.0} {white:>8.4} {:>8} {:>8} {:>6}", header.iso, "-", "-", "-");
            continue;
        };
        let body = ranked.body_white(WHITE_CODE);
        let code = ranked.code_for(white);
        println!(
            "{name:<16} {:>6.0} {white:>8.4} {:>8} {:>8} {:>6}",
            header.iso,
            body.map_or_else(|| "-".to_string(), |at| format!("{at:.4}")),
            body.map_or_else(|| "-".to_string(), |at| format!("{:+.2}", stops(at / white))),
            code.map_or_else(|| "-".to_string(), |c| c.to_string()),
        );
        println!(
            "{:<16} {:>6} body floor at 0.1% {:>3}, 1% {:>3}, 5% {:>3}, median {:>3}",
            "",
            "",
            ranked.code_at(0.001),
            ranked.code_at(0.01),
            ranked.code_at(0.05),
            ranked.code_at(0.5),
        );
        if let Some(at) = body {
            apart.push(stops(at / white));
        }
        if let Some(c) = code {
            implied.push(f64::from(c));
        }
    }

    let summarise = |what: &str, mut of: Vec<f64>| {
        if of.is_empty() {
            return;
        }
        of.sort_by(f64::total_cmp);
        let at = |q: f64| of[((of.len() - 1) as f64 * q).round() as usize];
        println!(
            "{what}: {} frames, median {:.2}, quartiles {:.2} / {:.2}, range {:.2} to {:.2}",
            of.len(),
            at(0.5),
            at(0.25),
            at(0.75),
            of[0],
            of[of.len() - 1],
        );
    };
    println!();
    summarise("body minus configured, in stops", apart);
    summarise("the code that reproduces today's anchor", implied);
}
