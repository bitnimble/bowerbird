// Fitting the transform that takes a RAW render to the camera's own JPEG.
//
// Ported from TypeScript so the whole search runs in one place: it evaluates tens
// of candidate geometries, each of which warps, blurs, pairs and fits, and doing
// that across an FFI boundary meant a crossing per candidate.
//
// Order matters and is not negotiable: geometry first, colour second. A colour
// transform is fitted from pixel pairs, and a pair means nothing unless both
// pixels show the same point in the scene. On a frame whose JPEG is
// distortion-corrected, fitting colour first plateaus at deltaE 16 however much
// capacity the colour model is given - a 33^3 LUT included - because no tone curve
// can map a pixel onto a different pixel's colour.

use crate::image::{polynomial_knots, resize, resize_to_fit, warp};
use crate::parallel::*;
use crate::rgb::{Rgb, RgbRef};

/// Long edge the fit runs at. Fitting small and applying at full resolution costs
/// nothing measurable, and every candidate warp is O(pixels), so this is the
/// biggest lever on how long a fit takes. 640 still leaves well over a hundred
/// thousand usable pairs, far more than 256-bin curves need.
const FIT_LONG_EDGE: usize = 640;

/// Both images are blurred before pairing. The camera's sharpening and noise
/// reduction are not reproducible and must not leak into the colour fit, and a
/// little residual misregistration stops mattering once neither image has detail
/// at that scale. Only the fit sees this; the output never does.
const FIT_BLUR_SIGMA: f64 = 3.0;

/// A pair from a steep gradient is worthless: a fraction of a pixel of
/// misalignment there swamps the colour difference being measured.
const MAX_PAIR_GRADIENT: i32 = 24;

const MIN_PAIRS: usize = 2000;
const MIN_BIN_SAMPLES: f64 = 8.0;
const PAIR_STRIDE: usize = 7;
/// Where the radius sits inside a pair, after the two RGB triples.
const RADIUS: usize = 6;

/// Beyond this the match is not trustworthy, so the render ships untransformed.
pub const MAX_ACCEPTABLE_DELTA_E: f64 = 6.0;

const REFINE_FLOOR: f64 = 0.0005;
const REFINE_MARGIN: f64 = 0.002;

/// The crop axis of every search, as slack below the tightest crop that fills the
/// frame rather than an absolute scale. Crop and curve otherwise lie along a diagonal
/// valley; expressed this way a step along the curve carries its crop with it, and
/// the grid only has to land in the valley for the joint refine to walk down it.
const SLACK_SCAN: [f64; 3] = [-0.06, -0.03, 0.0];
const SLACK_STEP: f64 = 0.01;

/// The radial coefficient, where the curve has to be fitted from nothing.
const K1_SCAN: [f64; 7] = [-0.06, -0.04, -0.02, 0.0, 0.02, 0.04, 0.06];
const K1_STEP: f64 = 0.01;

/// How strongly a known curve is applied, as a multiplier on its knots.
///
/// Fitted rather than trusted at 1.0, because a profile is one average of every copy
/// of a lens and measurably not what this body did: over 32 EOS R8 frames the ones
/// lensfun calls barrel wanted more than it states while the pincushion ones wanted
/// about 0.4 of it, worth a mean 0.08 deltaE76 and up to 0.46. 0 is in the grid on
/// purpose - it is the rescale-with-no-curve candidate, which several frames turn out
/// to want outright, and having it here is why a curve losing no longer means the
/// scale is lost with it.
const GAIN_SCAN: [f64; 4] = [0.0, 0.5, 1.0, 1.5];
const GAIN_STEP: f64 = 0.25;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Train = 0,
    Test = 1,
}

impl Phase {
    fn held_out(self) -> Phase {
        match self {
            Phase::Train => Phase::Test,
            Phase::Test => Phase::Train,
        }
    }
}

/// Corresponding samples: source RGB, target RGB, then the radius the falloff is
/// indexed by. Flat rather than a vector of structs because a candidate produces
/// ~180k of them and every candidate rebuilds the set.
struct Pairs {
    data: Vec<u8>,
    count: usize,
}

/// What is known about the geometry before any searching.
pub enum Geometry {
    /// The body states it applied no correction, so its preview needs none undone.
    Uncorrected,
    /// The spline the body recorded for this shot.
    Recorded(Vec<f64>),
    /// The lensfun database's profile for the lens, where the body recorded none.
    Profiled(Vec<f64>),
    /// Nothing knows this lens, so the geometry has to be fitted.
    Unstated,
}

pub const SOURCE_CAMERA: u32 = 1;
pub const SOURCE_FITTED: u32 = 2;
pub const SOURCE_LENSFUN: u32 = 3;

/// What the lens did to the frame, as this fit resolved it: the halves that depend on
/// where a pixel sits rather than what colour it is.
///
/// One struct because §10.8.1 lifts all of it into the HDR grade together and nothing
/// may lift a subset. Passed as three loose arguments first, and `fit_all` promptly
/// forgot the falloff on one of the two routes with every test still green.
#[derive(Clone)]
pub struct Lens {
    /// Radial knots in `SPLINE_UNIT`s, or None where no correction is needed.
    pub distortion: Option<Vec<f64>>,
    /// Overall rescale accompanying the distortion.
    pub crop: f64,
    /// The falloff's two coefficients, in the currency `Gain::at` reads.
    pub falloff: Option<(f64, f64)>,
    /// Red and blue's radial correction against green, where the lens imaged them at
    /// different magnifications (`tca.rs`). Knots rather than a scalar because a
    /// database curve is radius-dependent and a measured scale is the flat case of one.
    pub tca: Option<[Vec<f64>; 2]>,
}

impl Lens {
    /// A lens that did nothing, for a caller with no fit to hand.
    pub fn none() -> Self {
        Lens { distortion: None, crop: 1.0, falloff: None, tca: None }
    }

    /// The radius each channel is read at, relative to green's.
    ///
    /// The warp folds these into its own ratio, so the lateral aberration is undone by
    /// the resample that undoes the distortion rather than by a pass of its own.
    pub fn channels(&self) -> crate::image::Channels {
        match &self.tca {
            Some([red, blue]) => [red.clone(), Vec::new(), blue.clone()],
            None => crate::image::registered(),
        }
    }

    /// Whether applying this would change any pixel.
    ///
    /// The crop counts. It is a geometry on its own - a rescale - so a lens with no
    /// curve beside it is not an identity, and reading only `distortion` drops the
    /// scale a fit measured for a frame whose curve it declined.
    pub fn is_identity(&self) -> bool {
        !crate::image::moves_pixels(self.distortion.as_deref(), self.crop)
            && self.falloff.is_none()
            && !self.corrects_channels()
    }

    /// Whether any channel is read at its own radius.
    pub fn corrects_channels(&self) -> bool {
        !crate::image::is_registered(&self.channels())
    }
}

pub struct Profile {
    pub knots: Option<Vec<f64>>,
    /// The falloff the camera corrected and the render did not, or None where the
    /// frame is better off without one.
    pub gain: Option<Gain>,
    /// Red and blue's radial correction against green, or None where the lens
    /// registered them well enough that correcting would only resample for nothing.
    pub tca: Option<[Vec<f64>; 2]>,
    pub crop: f64,
    /// 0 none, or one of the `SOURCE_` codes. Reported so a rendition can be
    /// re-cut when the cascade changes under it, and so the fit can be judged by
    /// where its geometry came from.
    pub source: u32,
    /// The camera's colour treatment, or None where the lens was resolved but the colour
    /// was refused - too few pairs to fit from, or a fit too far from the camera to
    /// trust. The render then ships with its geometry corrected and its colour its own.
    pub colour: Option<crate::hdr_fit::HdrColour>,
}

impl Profile {
    /// Everything §10.8.1 lifts, in one piece so it cannot lift half.
    pub fn lens(&self) -> Lens {
        Lens {
            distortion: self.knots.clone(),
            crop: self.crop,
            falloff: self.gain.as_ref().map(Gain::coefficients),
            tca: self.tca.clone(),
        }
    }
}

/// The render and the camera's JPEG on one common grid.
struct Grid {
    source: Rgb,
    jpeg: Rgb,
}

/// Both resolutions a fit works at: cheap for scanning, full for refining.
struct Grids {
    full: Grid,
    search: Grid,
}

// ------------------------------------------------------------------ colour model

fn pairs(render: &Rgb, jpeg: &Rgb) -> Pairs {
    let (width, height) = (jpeg.width, jpeg.height);
    let mut data = vec![0u8; width * height * PAIR_STRIDE];
    let mut count = 0usize;
    let (cx, cy) = (width as f64 / 2.0, height as f64 / 2.0);
    let half = (cx * cx + cy * cy).sqrt().max(1.0);
    for y in 1..height.saturating_sub(1) {
        for x in 1..width.saturating_sub(1) {
            let i = (y * width + x) * 3;
            let (s0, s1, s2) = (render.data[i], render.data[i + 1], render.data[i + 2]);
            let (d0, d1, d2) = (jpeg.data[i], jpeg.data[i + 1], jpeg.data[i + 2]);
            // Clipped samples carry no mapping: everything above the knee landed on
            // the same value, so they would drag the top of the curve down.
            if d0.min(d1).min(d2) <= 2 || d0.max(d1).max(d2) >= 253 {
                continue;
            }
            if s0.min(s1).min(s2) <= 1 || s0.max(s1).max(s2) >= 254 {
                continue;
            }
            let gx = (jpeg.data[i + 3] as i32 - jpeg.data[i - 3] as i32).abs();
            let gy = (jpeg.data[i + width * 3] as i32 - jpeg.data[i - width * 3] as i32).abs();
            if gx + gy > MAX_PAIR_GRADIENT {
                continue;
            }
            // A black warp margin is not scene content.
            if s0 == 0 && s1 == 0 && s2 == 0 {
                continue;
            }
            let o = count * PAIR_STRIDE;
            data[o] = s0;
            data[o + 1] = s1;
            data[o + 2] = s2;
            data[o + 3] = d0;
            data[o + 4] = d1;
            data[o + 5] = d2;
            data[o + RADIUS] = Gain::radius(x as f64 - cx, y as f64 - cy, half);
            count += 1;
        }
    }
    Pairs { data, count }
}

/// The shared tail of every curve fit: gaps interpolated, ends extended, monotone.
fn curve_from_bins(sum: [f64; 256], count: [f64; 256]) -> [u8; 256] {
    let mut curve = [f64::NAN; 256];
    for level in 0..256 {
        if count[level] >= MIN_BIN_SAMPLES {
            curve[level] = sum[level] / count[level];
        }
    }
    let known: Vec<usize> = (0..256).filter(|l| curve[*l].is_finite()).collect();
    if known.len() < 2 {
        let mut identity = [0u8; 256];
        for (level, slot) in identity.iter_mut().enumerate() {
            *slot = level as u8;
        }
        return identity;
    }

    let first = known[0];
    let last = known[known.len() - 1];
    let prev = known[known.len() - 2];
    let tail_slope = (curve[last] - curve[prev]) / (last - prev) as f64;
    let mut cursor = 0usize;
    for level in 0..256 {
        if curve[level].is_finite() {
            continue;
        }
        if level < first {
            curve[level] = curve[first] * level as f64 / first.max(1) as f64;
            continue;
        }
        if level > last {
            curve[level] = curve[last] + tail_slope * (level - last) as f64;
            continue;
        }
        while cursor < known.len() - 1 && known[cursor + 1] < level {
            cursor += 1;
        }
        let (lo, hi) = (known[cursor], known[cursor + 1]);
        curve[level] = curve[lo] + (curve[hi] - curve[lo]) * (level - lo) as f64 / (hi - lo) as f64;
    }

    let mut out = [0u8; 256];
    let mut ceiling = 0.0f64;
    for level in 0..256 {
        ceiling = ceiling.max(curve[level]);
        out[level] = ceiling.min(255.0).round() as u8;
    }
    out
}

/// A radial brightness gain, as a level-in/level-out table per quantised radius.
///
/// The camera corrects its lens's falloff and the render does not, and that is a
/// gain that varies over the frame - which per-channel curves and a 3x3 cannot
/// express at all, since both are position-independent. Modelled as `1 + a r^2 +
/// b r^4` in linear light, the shape falloff actually has, so two coefficients
/// carry it and a thin radius bin cannot bend it on its own.
///
/// **Achromatic**: one scalar for all three channels, fitted from luma. Falloff does
/// carry a slight cast on real glass, which this cannot express and does not try to -
/// what the 3x3 absorbs globally it absorbs, and the rest stays in the residual.
pub struct Gain {
    lut: Vec<u8>,
    coefficients: (f64, f64),
}

impl Gain {
    /// Bounded because these are two free parameters fitted to one frame, and a
    /// degenerate solve should distort the corners rather than black them out or
    /// blow them away: no lens falls off by four stops, and none gains.
    const LIMIT: (f64, f64) = (0.25, 4.0);

    /// Tabulated rather than left to be evaluated, because the 8-bit path applies it
    /// per pixel of a 60MP frame and evaluating it is a `powf` for the transfer.
    pub(crate) fn from_poly(a: f64, b: f64) -> Self {
        let linear = linear_table();
        let mut lut = vec![0u8; 256 * 256];
        for radius in 0..256 {
            for level in 0..256 {
                lut[radius * 256 + level] = to_srgb8(linear[level] * Gain::at(a, b, radius as u8));
            }
        }
        Gain { lut, coefficients: (a, b) }
    }

    /// The multiplier itself, in linear light, at a quantised radius.
    ///
    /// Kept separate from the table so a caller working in linear light already can
    /// evaluate it rather than round-trip through 8 bits (`hdr_fit`).
    #[inline]
    pub(crate) fn at(a: f64, b: f64, radius: u8) -> f64 {
        let r2 = (f64::from(radius) / 255.0).powi(2);
        (1.0 + a * r2 + b * r2 * r2).clamp(Self::LIMIT.0, Self::LIMIT.1)
    }

    /// The two coefficients, for the HDR fit to reuse.
    ///
    /// A falloff correction is a multiplication in linear light, so unlike the curves
    /// - whose domain stops at display white - it means the same thing in any linear
    /// domain and lifts to the grade exactly as the geometry does (10.8.1).
    pub(crate) fn coefficients(&self) -> (f64, f64) {
        self.coefficients
    }

    /// The level `level` becomes at this radius. Free where there is no gain, which
    /// is the geometry search's whole life: it scores tens of candidates and none of
    /// them has one, so an identity table would put a cache-hostile 64KB lookup on
    /// the hottest loop in the module to return its own argument.
    #[inline]
    fn of(gain: Option<&Gain>, radius: u8, level: u8) -> u8 {
        match gain {
            None => level,
            Some(g) => g.lut[radius as usize * 256 + level as usize],
        }
    }

    /// What this gain does to a corner pixel of mid grey, as a ratio - the one number
    /// that says how much falloff was corrected, and the one the tests assert on
    /// because `(a, b)` trade off against each other and it does not.
    #[cfg(all(test, feature = "fixtures"))]
    pub(crate) fn corner(&self) -> f64 {
        let linear = linear_table();
        linear[Gain::of(Some(self), 255, 128) as usize] / linear[128]
    }

    /// The radius byte `of` and `at` expect, for a pixel of a frame this size.
    #[inline]
    pub(crate) fn radius(dx: f64, dy: f64, half: f64) -> u8 {
        (((dx * dx + dy * dy).sqrt() / half) * 255.0).min(255.0) as u8
    }
}

fn to_srgb8(linear: f64) -> u8 {
    (crate::hdr_fit::srgb_oetf(linear.clamp(0.0, 1.0)) * 255.0).round() as u8
}

/// The gain the pairs ask for, given a luma curve fitted under the current one.
///
/// Run backwards rather than searched, which is one pass where a search over candidate
/// gains would be one pass each (10.8).
///
/// The answer is absolute, not an increment on the gain already in hand - the
/// inverted target lands in gained-source levels and the pair's own source is
/// ungained, so their ratio is the whole of what the gain has to supply. An
/// increment would have to compose, and two of these do not compose into one.
///
/// Against luma rather than a colour transform, for the reason the geometry search
/// scores luma: `Gain` is one achromatic scalar per radius and cannot express a cast, so
/// all the transform was ever doing here was undoing the tone difference between the two
/// images, which one curve does. Measured against the camera's own falloff on the two
/// frames the arms disagreed most about, the two land within a few percent of each other
/// and both far inside no correction at all.
fn refit_gain(pairs: &Pairs, phase: Phase, curve: &[u8; 256]) -> Option<(f64, f64)> {
    let back = invert_curve(curve);
    let linear = linear_table();

    const BINS: usize = 12;
    /// A bin backed by a handful of pixels states a ratio, not a measurement, and the
    /// bins most likely to be that thin are the outer ones - `pairs` drops near-black
    /// samples, and the corners of a frame that needs this correction are exactly
    /// where the render is darkest. Left unguarded, one such bin sets the end of the
    /// curve and the held-out gate cannot object, its own half being thin in the same
    /// place. The same floor `fit_curve` puts on a tone bin, for the same reason.
    const MIN_BIN_PAIRS: u32 = 64;

    let (mut wanted, mut had) = ([0.0f64; BINS], [0.0f64; BINS]);
    let mut counted = [0u32; BINS];
    let mut p = phase as usize;
    while p < pairs.count {
        let o = p * PAIR_STRIDE;
        p += 2;
        let radius = pairs.data[o + RADIUS];
        let bin = (radius as usize * BINS / 256).min(BINS - 1);
        // A level the curve never reached inverts to a clamp rather than a mapping,
        // so those are dropped rather than believed.
        let target = luma8(pairs.data[o + 3], pairs.data[o + 4], pairs.data[o + 5]);
        let source = back[target as usize];
        if source <= 1 || source >= 254 {
            continue;
        }
        // Both sides linearised the same way, since what the bin wants is a ratio of
        // light: `Gain` multiplies in linear light and these levels are sRGB-encoded.
        let want = linear[source as usize];
        let is = linear[source_luma(pairs, o) as usize];
        if is < 0.002 || want < 0.002 {
            continue;
        }
        // Summed, then divided once per bin: a ratio taken pair by pair would let a
        // near-black pixel carry as much as the sky.
        wanted[bin] += want;
        had[bin] += is;
        counted[bin] += 1;
    }

    // Least squares of `g - 1 = a r^2 + b r^4` over the bins that got samples,
    // weighted by how many linear units each carries so a dark bin cannot swing it.
    let (mut a11, mut a12, mut a22, mut b1, mut b2) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let mut bins = 0usize;
    for bin in 0..BINS {
        if counted[bin] < MIN_BIN_PAIRS || had[bin] <= 0.0 {
            continue;
        }
        let r2 = ((bin as f64 + 0.5) / BINS as f64).powi(2);
        let (x1, x2) = (r2, r2 * r2);
        let y = wanted[bin] / had[bin] - 1.0;
        let w = had[bin];
        a11 += w * x1 * x1;
        a12 += w * x1 * x2;
        a22 += w * x2 * x2;
        b1 += w * x1 * y;
        b2 += w * x2 * y;
        bins += 1;
    }
    if bins < 4 {
        return None;
    }
    let det = a11 * a22 - a12 * a12;
    if det.abs() < 1e-12 {
        return None;
    }
    Some(((b1 * a22 - b2 * a12) / det, (b2 * a11 - b1 * a12) / det))
}

/// `curve` maps a source level to a target level; this maps back. Monotone by
/// construction, so one forward walk fills it.
fn invert_curve(curve: &[u8; 256]) -> [u8; 256] {
    let mut back = [0u8; 256];
    let mut source = 0usize;
    for target in 0..256 {
        while source < 255 && (curve[source] as usize) < target {
            source += 1;
        }
        back[target] = source as u8;
    }
    back
}


/// How much the first falloff has to buy before it is believed at all.
///
/// Two free parameters fitted to one frame will always find something, and a plain
/// improvement gate is not enough to stop them: over the 35-frame set the falloffs that
/// are really there buy at least 6.3% of the held-out luma score on their first round,
/// where the three frames that invented one bought 0.2%, 0.4% and 2.5%. Nothing lands
/// between, so this sits in the gap.
const GAIN_MARGIN: f64 = 0.04;

/// The gain and a luma curve together, alternating: neither can be fitted without the
/// other, since a falloff looks like a tone difference to a curve and a tone difference
/// looks like falloff to a gain.
///
/// The gain is None where the frame is better off without one, which is the point of
/// the gate: a body that corrected no falloff would otherwise have two free
/// parameters fitted to its noise. Judged on the pairs the round was not fitted on,
/// for exactly that reason - extra free parameters can only ever look better on their
/// own.
///
/// The margin applies only to the first round, which is the one deciding whether this
/// frame has a falloff at all. The rounds after it are refining a falloff already
/// believed in, and asking each of them for another 4% would stop the refinement that
/// exists because the first round's curve still had some of the falloff in it.
fn fit_gain(pairs: &Pairs, phase: Phase) -> Option<Gain> {
    let held = phase.held_out();
    let mut curve = fit_luma_curve(pairs, phase, None);
    let mut best = score_luma(pairs, held, None, &curve);
    let mut gain: Option<Gain> = None;
    // Three, because the first round's curve was fitted with the falloff still in it
    // and so partly absorbs it - measured on an injected 0.65 corner, one round
    // recovers 0.78 and the next two land it.
    for _ in 0..3 {
        let Some((a, b)) = refit_gain(pairs, phase, &curve) else { break };
        let candidate = Gain::from_poly(a, b);
        let fitted = fit_luma_curve(pairs, phase, Some(&candidate));
        let delta = score_luma(pairs, held, Some(&candidate), &fitted);
        let bar = match gain {
            None => best * (1.0 - GAIN_MARGIN),
            Some(_) => best,
        };
        if !(delta < bar) {
            break;
        }
        best = delta;
        gain = Some(candidate);
        curve = fitted;
    }
    gain
}

// ------------------------------------------------------------------------ deltaE

fn to_linear(value: f64) -> f64 {
    let s = value / 255.0;
    if s <= 0.04045 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
}

/// The scoring loop only ever linearises 8-bit levels, and the transfer's pow() is
/// the most expensive arithmetic in the fit.
pub(crate) fn linear_table() -> [f64; 256] {
    let mut table = [0.0f64; 256];
    for (level, slot) in table.iter_mut().enumerate() {
        *slot = to_linear(level as f64);
    }
    table
}

/// CIE L\*a\*b\* of a linear-light sRGB triple, D65.
///
/// The one place the matrix and the cube root live. Both callers below used to carry
/// their own copy of it, differing only in where the linear values came from.
fn lab_from_linear(rr: f64, gg: f64, bb: f64) -> [f64; 3] {
    let x = (0.4124 * rr + 0.3576 * gg + 0.1805 * bb) / 0.95047;
    let y = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
    let z = (0.0193 * rr + 0.1192 * gg + 0.9505 * bb) / 1.08883;
    let f = |t: f64| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    let fy = f(y);
    [116.0 * fy - 16.0, 500.0 * (f(x) - fy), 200.0 * (fy - f(z))]
}

pub(crate) fn lab_from_levels(table: &[f64; 256], r: u8, g: u8, b: u8) -> [f64; 3] {
    lab_from_linear(table[r as usize], table[g as usize], table[b as usize])
}

fn clamp8(value: f64) -> f64 {
    value.clamp(0.0, 255.0)
}

/// Lab distance between two 8-bit sRGB triples.
///
/// The HDR fit reports in this same measure, so the two are comparable - 8-bit sRGB is
/// the only space they both land in - but it reaches it through `lab_from_levels`
/// rather than through here: its inner loop runs a hundred times per photo and this
/// derives both ends from scratch, where one of that pair never moves.
pub fn delta_e76(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    // Linearised here rather than through `linear_table`, which builds 256 entries per
    // call and this is an inner loop.
    let lab = |v: &[f64; 3]| {
        let f = |value: f64| to_linear(value.clamp(0.0, 255.0));
        lab_from_linear(f(v[0]), f(v[1]), f(v[2]))
    };
    let (p, q) = (lab(a), lab(b));
    ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
}

// ------------------------------------------------------------------------ fitting

/// How well the pair corresponds under a candidate geometry, measured as the luma
/// residual one tone curve can still not explain.
///
/// Using a residual as the geometry objective is what makes this robust: a wrong warp
/// cannot be rescued by any tone curve, so a good score means genuine correspondence.
/// Feature matching was tried first, in four variants, and every one produced a
/// confident wrong answer on repetitive texture; this cannot, and it needs no band
/// selection, subpixel interpolation or outlier rejection.
///
/// Luma rather than deltaE, which is one curve instead of three plus a 3x3 and drops
/// six cbrt per pair. Every question this stage asks is about correspondence - which
/// warp aligns the two frames, and whether any of them beats leaving the frame alone -
/// and none of them needs to know what colour the pixels are. Measured over 204 frames
/// the two rank candidates equally well: recovering an injected distortion, luma is out
/// by a mean 0.0119 and deltaE by 0.0134, on an identical median. Luma is ~45% faster.
fn residual_for(grid: &Grid, knots: &[f64], crop: f64) -> Option<f64> {
    let all = corresponding(grid, knots, crop)?;
    let curve = fit_luma_curve(&all, Phase::Train, None);
    Some(score_luma(&all, Phase::Test, None, &curve))
}

/// BT.709 luma of a display-referred triple, in the same 8-bit levels the pair holds.
///
/// Taken on the encoded values rather than in linear light, which is what Y' means and
/// what makes it free: the tone curve fitted over it absorbs any transfer difference
/// between the two images anyway.
#[inline]
fn luma8(r: u8, g: u8, b: u8) -> u8 {
    crate::image::luma709(f64::from(r), f64::from(g), f64::from(b)).round() as u8
}

/// The render's luma, before any falloff is put back into it.
#[inline]
fn source_luma(pairs: &Pairs, o: usize) -> u8 {
    luma8(pairs.data[o], pairs.data[o + 1], pairs.data[o + 2])
}

fn fit_luma_curve(pairs: &Pairs, phase: Phase, gain: Option<&Gain>) -> [u8; 256] {
    let mut sum = [0.0f64; 256];
    let mut count = [0.0f64; 256];
    let mut p = phase as usize;
    while p < pairs.count {
        let o = p * PAIR_STRIDE;
        let level = Gain::of(gain, pairs.data[o + RADIUS], source_luma(pairs, o)) as usize;
        sum[level] += luma8(pairs.data[o + 3], pairs.data[o + 4], pairs.data[o + 5]) as f64;
        count[level] += 1.0;
        p += 2;
    }
    curve_from_bins(sum, count)
}

/// Mean luma error over held-out pairs, scaled into L*-sized units so `REFINE_MARGIN`
/// and `REFINE_FLOOR` mean what they meant when this was scored in deltaE.
fn score_luma(pairs: &Pairs, phase: Phase, gain: Option<&Gain>, curve: &[u8; 256]) -> f64 {
    let mut total = 0.0;
    let mut counted = 0usize;
    let mut p = phase as usize;
    while p < pairs.count {
        let o = p * PAIR_STRIDE;
        let level = Gain::of(gain, pairs.data[o + RADIUS], source_luma(pairs, o)) as usize;
        let target = luma8(pairs.data[o + 3], pairs.data[o + 4], pairs.data[o + 5]);
        total += (curve[level] as f64 - target as f64).abs();
        counted += 1;
        p += 2;
    }
    if counted == 0 { f64::INFINITY } else { total / counted as f64 * (100.0 / 255.0) }
}

fn corresponding(grid: &Grid, knots: &[f64], crop: f64) -> Option<Pairs> {
    // Nothing is filtered in here. Both planes were blurred once when the grid was
    // built, so a candidate is a warp and a pair pass over one buffer; blurring per
    // candidate cost more than every other part of the search put together.
    //
    // Blurring before the warp rather than after is the same picture for this
    // purpose: the filter exists to remove detail neither image can be trusted on,
    // and a Gaussian commutes with a near-identity resample closely enough that the
    // fitted deltaE does not move.
    let warped = warp(grid.source.as_ref(), grid.jpeg.width, grid.jpeg.height, knots, crop);
    let all = pairs(&warped, &grid.jpeg);
    (all.count >= MIN_PAIRS).then_some(all)
}

/// Evaluates candidates across cores. They share only their inputs, which makes
/// the scan the one genuinely parallel part of a fit; the refine that follows is
/// sequential by nature, each step depending on the last.
///
/// Ties break on position, not on whichever branch of the reduction happened to hold
/// them. A frame with no distortion to find scores several candidates identically -
/// `min_by` alone then returns whichever the work-stealing tree paired last, so the same
/// build fits IMG_5360 two different ways depending on how many cores were free.
fn scan<T: Send + Sync + Copy>(grid: &Grid, candidates: &[T], knots_of: impl Fn(T) -> Vec<f64> + Sync, crop_of: impl Fn(T) -> f64 + Sync) -> Option<(T, f64)> {
    candidates
        .par_iter()
        .enumerate()
        .filter_map(|(i, candidate)| {
            residual_for(grid, &knots_of(*candidate), crop_of(*candidate))
                .map(|delta| (delta, i, *candidate))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)))
        .map(|(delta, _, candidate)| (candidate, delta))
}

/// A one-parameter family of curves and the crop that goes with it, searched jointly:
/// a coarse grid on the search grid, then a refine at full size.
///
/// The scan only has to land in the right valley, which a quarter of the pixels
/// answers just as well. The refine compares neighbours a fraction of a percent
/// apart, and at half resolution those differences fall below the improvement
/// threshold, so it halts early and leaves the geometry short - an injected 3%
/// distortion came back as 1.3% when the refine also ran coarse.
///
/// Returns the winning knots, its crop and the residual it left.
fn fit_family(
    grids: &Grids,
    family: impl Fn(f64) -> Vec<f64> + Sync,
    coarse: &[f64],
    mut step: f64,
) -> Option<(Vec<f64>, f64, f64)> {
    let (width, height) = (grids.full.jpeg.width, grids.full.jpeg.height);
    let fill = |parameter: f64| crate::image::fill_crop(&family(parameter), width, height);
    let candidates: Vec<(f64, f64)> = coarse
        .iter()
        .flat_map(|parameter| SLACK_SCAN.iter().map(move |slack| (*parameter, *slack)))
        .collect();
    let ((mut parameter, mut slack), _) = scan(
        &grids.search,
        &candidates,
        |(parameter, _)| family(parameter),
        |(parameter, slack)| fill(parameter) + slack,
    )?;
    let mut delta = residual_for(&grids.full, &family(parameter), fill(parameter) + slack)?;

    let mut step_slack = SLACK_STEP;
    while step_slack > REFINE_FLOOR {
        let mut improved = false;
        for axis in 0..2 {
            // A zero step is a family of one - a bare scale - whose curve axis would
            // otherwise be re-scored at the same point on every round of the refine.
            if axis == 0 && step <= 0.0 {
                continue;
            }
            for sign in [1.0, -1.0] {
                let trial_parameter = if axis == 0 { parameter + sign * step } else { parameter };
                // Slack above zero is a crop that does not fill, which no camera ships.
                let trial_slack = if axis == 1 { slack + sign * step_slack } else { slack };
                if trial_slack > 0.0 {
                    continue;
                }
                let trial_knots = family(trial_parameter);
                let trial_crop = fill(trial_parameter) + trial_slack;
                if let Some(candidate) = residual_for(&grids.full, &trial_knots, trial_crop) {
                    if candidate < delta - REFINE_MARGIN {
                        parameter = trial_parameter;
                        slack = trial_slack;
                        delta = candidate;
                        improved = true;
                    }
                }
            }
        }
        if !improved {
            step /= 2.0;
            step_slack /= 2.0;
        }
    }
    Some((family(parameter), fill(parameter) + slack, delta))
}

/// The scale alone, where the body states there is no curve to undo.
///
/// It is not nothing: the ~0.4-0.5% rescale between a render and the camera's own JPEG
/// shows up on bodies with unrelated optics - ILCE-6300 frames land on crop 0.996 and
/// EOS R8 frames on 0.995 - which is what makes it look like framing rather than a lens.
fn fit_scale(grids: &Grids) -> Option<(Vec<f64>, f64, f64)> {
    fit_family(grids, |_| Vec::new(), &[0.0], 0.0)
}

/// A curve someone else already knows, applied at a fitted strength.
///
/// The gain is what keeps a wrong profile from being all-or-nothing. Before it, a curve
/// that could not beat leaving the frame alone was dropped along with the crop that
/// came with it - so a frame whose lens lensfun overstates shipped with no geometry at
/// all, when the scale on its own was worth 0.22 deltaE76. Gain 0 is exactly that
/// candidate, so the search now contains the fallback rather than falling back to it.
fn with_curve(grids: &Grids, knots: Vec<f64>, baseline: f64, source: u32) -> (Option<Vec<f64>>, f64, u32) {
    let scaled = |gain: f64| knots.iter().map(|knot| knot * gain).collect::<Vec<f64>>();
    chosen(fit_family(grids, scaled, &GAIN_SCAN, GAIN_STEP), baseline, source)
}

/// What a search settled on, as the cascade reports it.
///
/// Every family contains the curve that does nothing - gain 0, k1 0, and the bare scale
/// is only that - so a winner can carry a crop and no curve at all. That is a geometry
/// and its crop has to survive, but the tier did not supply a curve for it and must not
/// be credited with one: reporting it as a fitted or database geometry is how a tier's
/// own numbers come to disagree with what it actually did.
fn chosen(found: Option<(Vec<f64>, f64, f64)>, baseline: f64, source: u32) -> (Option<Vec<f64>>, f64, u32) {
    match found {
        Some((knots, crop, delta)) if delta < baseline => match knots.iter().any(|knot| *knot != 0.0) {
            true => (Some(knots), crop, source),
            false => (None, crop, 0),
        },
        _ => (None, 1.0, 0),
    }
}

/// Fits the transform taking `render` to `jpeg_bytes`: the lens, and then the colour.
pub fn fit(render: RgbRef<'_>, jpeg_bytes: &[u8], geometry: Geometry) -> Result<Option<Profile>, String> {
    let preview = crate::jpeg::decode(jpeg_bytes, crate::hdr_fit::sample_long_edge())?;
    let Some(mut profile) = fit_from_preview(render, preview.as_ref(), geometry)? else {
        return Ok(None);
    };

    // The render on the colour fit's own grid. Resized rather than warped here - the
    // fit warps it itself, through the lens this same profile just resolved, because a
    // pair means nothing unless both pixels show the same point in the scene.
    //
    // Exact dimensions, not a long edge: the two planes have to land on one grid or the
    // fit's wide pass compares them by size, finds them different and skips itself. Asked
    // for `resize_to_fit(preview.width)` a portrait frame is handed its *short* edge, so
    // the render arrived at 571x855 against an 855x1280 preview and the pass that exists
    // to see small saturated objects silently never ran - on every portrait frame, and on
    // both fixtures, which is why no test noticed.
    let sampled = resize(render, preview.width, preview.height);
    profile.colour = crate::hdr_fit::fit_display(&sampled, &preview, &profile.lens());

    // The gate is on the colour, so it belongs on the route that applies the colour. A
    // fit this far from the camera is more likely wrong than the camera is unusual, and
    // a render is better off untransformed than transformed by it.
    if profile.colour.as_ref().is_none_or(|c| !(c.delta_e <= MAX_ACCEPTABLE_DELTA_E)) {
        profile.colour = None;
    }
    Ok(Some(profile))
}

/// `fit`, without the colour gate, against a preview the caller has already decoded.
///
/// **Ungated**, because `MAX_ACCEPTABLE_DELTA_E` decides whether an *SDR render* should
/// wear a colour transform. `fit_all` asks this same call for geometry and gives up where
/// there is no profile, so a refused SDR colour refused the HDR match too - a different
/// fit, in a different domain, against a different reference, never asked whether it
/// would have worked. Reachable rather than observed: the worst SDR fit over the 35-frame
/// set is 4.1 against a limit of 6, and it was only reached by feeding the geometry fit a
/// cheaper preview, which took one frame to 10.4 and silently cost it its colour.
/// Nothing downstream then bounds the HDR fit's own error, which is the standing gap
/// here. Geometry is judged on its own terms (a candidate has to beat the undistorted
/// baseline) and `hdr_fit` refuses a frame with too few pairs, but neither is a deltaE
/// bound on the colour that actually ships.
///
/// **Off the caller's preview**, because both halves of an HDR fit want the same picture
/// from the same embedded JPEG. Decoding it here as well meant a 6000x4000 preview
/// decoded in full, resized to 640 and dropped, beside the copy the colour fit was
/// already holding.
///
/// Sharing was tried once before and rejected, on a preview DCT-shrunk almost to the fit
/// grid: that arrives barely filtered and cost the 35-frame set 1.654 to 1.774 mean
/// deltaE. What is shared now is not that. The colour fit needs twice the grid, so the
/// preview is DCT-shrunk only to 1500 and brought to 1280 by a real reduce, leaving this
/// a properly filtered resize down to its own 640 rather than a DCT approximation of one.
pub fn fit_from_preview(
    render: RgbRef<'_>,
    preview: RgbRef<'_>,
    geometry: Geometry,
) -> Result<Option<Profile>, String> {
    let jpeg_full = blur(&resize_to_fit(preview, FIT_LONG_EDGE), FIT_BLUR_SIGMA);

    // Twice the fit grid, so the warp resamples from prefiltered pixels: warping
    // straight from 60MP with bilinear taps would alias, and resizing after the
    // warp would blur the geometry being measured.
    let source_width = jpeg_full.width * 2;
    let source_height = ((render.height as f64 / render.width as f64) * source_width as f64).round() as usize;
    // Blurred here, once, rather than per candidate. Both sides of the comparison
    // have to end up filtered the same way, and the source is held at twice the
    // grid so the warp can resample from prefiltered pixels - so its sigma is
    // scaled to match, or it arrives at the grid half as filtered as the JPEG and
    // the residual is measuring the difference in blur rather than in colour.
    let source_sigma = FIT_BLUR_SIGMA * (source_width as f64 / jpeg_full.width as f64);
    let full = Grid {
        source: blur(&resize(render, source_width, source_height.max(1)), source_sigma),
        jpeg: jpeg_full,
    };
    let search = Grid {
        source: resize(full.source.as_ref(), full.source.width / 2, full.source.height / 2),
        jpeg: resize(full.jpeg.as_ref(), full.jpeg.width / 2, full.jpeg.height / 2),
    };
    fit_grids(Grids { full, search }, geometry)
}

fn fit_grids(grids: Grids, geometry: Geometry) -> Result<Option<Profile>, String> {

    let baseline_delta = residual_for(&grids.full, &[], 1.0).unwrap_or(f64::INFINITY);

    // Decided entirely on the search grid; the winner is re-fitted at full size
    // below, so nothing reported was measured coarse.
    let settled: (Option<Vec<f64>>, f64, u32) = match geometry {
        // Taken at its word for the curve, which is most of what a search costs. The
        // scale still has to be fitted: the body is saying it undistorted nothing, not
        // that it framed the JPEG exactly as LibRaw frames the render.
        Geometry::Uncorrected => chosen(fit_scale(&grids), baseline_delta, 0),
        Geometry::Recorded(knots) => with_curve(&grids, knots, baseline_delta, SOURCE_CAMERA),
        Geometry::Profiled(knots) => with_curve(&grids, knots, baseline_delta, SOURCE_LENSFUN),
        // Two parameters reach the same residual as a camera's spline, but it is the
        // expensive way there: fitting the same frames both ways is 1643ms against
        // 360ms on an RX100M3 and 1216ms against 589ms on an ILCE-7CR.
        Geometry::Unstated => chosen(
            fit_family(&grids, |k1| polynomial_knots(k1, 0.0, 16), &K1_SCAN, K1_STEP),
            baseline_delta,
            SOURCE_FITTED,
        ),
    };

    let knots = settled.0.clone().unwrap_or_default();
    let Some(all) = corresponding(&grids.full, &knots, settled.1) else {
        return Ok(None);
    };
    let gain = fit_gain(&all, Phase::Train);

    // Measured off the render itself rather than against the JPEG, and at full size
    // rather than on the fit grid. It is its own effect - the JPEG has none of it left
    // to compare against - and a 5px corner shift is a tenth of a pixel by the time the
    // grid has been reduced to 640px and blurred at sigma 3, which is where three
    // earlier attempts to fit it through the search went wrong (`tca.rs`).
    //
    Ok(Some(Profile {
        knots: settled.0,
        gain,
        tca: None,
        crop: settled.1,
        source: settled.2,
        colour: None,
    }))
}

/// Stack blur, the fit's prefilter on both planes of every grid.
///
/// Not a Gaussian, and it does not need to be: both planes of a grid are filtered the same
/// way, so the prefilter only has to suppress noise and detail the residual should not be
/// measuring. What it does need is to land where the vips `gaussblur` it replaces landed,
/// or the pins move, and it does - closer than the separable f64 convolution that stood in
/// for it on wasm (mean 0.60 against 0.95 of 255 at sigma 6), for a 190th of the CPU:
/// 1.75ms against 338ms on a 1280x853 plane, and 6.5ms for vips itself. The f64 version
/// cost more CPU than the whole rest of the fit.
///
/// Single-threaded deliberately. At a few milliseconds there is nothing to win by
/// spreading it, and the fit's own parallelism is already saturating the pool.
fn blur(source: &Rgb, sigma: f64) -> Rgb {
    // **Do not build wasm32 with `+simd128` while this call exists.** libblur 0.24 swaps in a
    // hand-written wasm kernel under that feature which packs float bits as integers, so most
    // of the blurred plane comes back black; the fit then finds too few pairs and declines,
    // and a browser edit silently grades on the neutral arm (DESIGN 21.1). Nothing native
    // touches that kernel, so the e2e camera-match assertion is the only thing that catches it.
    // Swept against vips at both sigmas the fit uses: sigma 3 wants radius 5 and sigma 6
    // wants 11, so a stack blur's support is twice a Gaussian's standard deviation.
    let radius = (2.0 * sigma - 1.0).round().max(1.0) as u32;
    let mut data = source.data.clone();
    let mut image = libblur::BlurImageMut::borrow(
        &mut data,
        source.width as u32,
        source.height as u32,
        libblur::FastBlurChannels::Channels3,
    );
    libblur::stack_blur(
        &mut image,
        libblur::AnisotropicRadius::new(radius),
        libblur::ThreadingPolicy::Single,
    )
    .expect("a stack blur over a 3-channel plane it was handed the dimensions of");
    Rgb { width: source.width, height: source.height, data }
}

/// Resolves the lateral aberration and folds it into the profile.
///
/// **Separate from the fit, because it does not use the JPEG.** Everything in `fit` is
/// render-against-preview; this is measured off the render alone - the camera's JPEG has
/// no lateral fringe left in it to compare against - so it needs neither the reference nor
/// the search, and threading the body's recorded curve through both of them only to reach
/// the last three lines was plumbing a value past the function that was supposed to use it.
///
/// The cascade: the curve the body recorded for this shot, then the fringe measured off
/// the frame's own point sources, then a regression. The order is the point - the
/// regression reads a slope off the whole frame at a quarter resolution, which is where
/// point sources go, so it ends up fitting scene edges that carry no radial signal. Every
/// tier is verified against the frame afterwards regardless (`tca::improves`).
///
/// A 5px corner shift is a tenth of a pixel by the time the fit grid has been reduced to
/// 640px and blurred at sigma 3, which is where three earlier attempts to fit this through
/// the search went wrong (`tca.rs`). So it is read at full size, here.
pub fn with_lateral(profile: &mut Profile, render: RgbRef<'_>, recorded: Option<[Vec<f64>; 2]>) {
    profile.tca = match recorded {
        Some(curve) => crate::tca::supplied_curve(render, curve),
        None => crate::tca::measure(render).or_else(|| crate::tca::estimate(render)),
    };
    // A channel read further out than green needs the room to be there, so the crop
    // tightens by however much the widest one reaches past it. At the scales a real lens
    // shows this is under a fifth of a percent.
    profile.crop /= crate::tca::widest(profile.tca.as_ref());
}

/// Applies a fitted profile to a render: the geometry, the falloff and the colour, in one
/// sweep.
///
/// One sweep rather than a warp that materialises a whole frame for a second pass to read
/// back. Nothing between them needs a neighbourhood - the warp gathers, and everything
/// after it is pointwise on what the gather returned - so the intermediate existed only to
/// be handed along, and on a 60MP frame that is 180MB written and read for nothing. It
/// also leaves the warp running across cores, where alone it was a plain row loop.
pub fn apply(image: RgbRef<'_>, profile: &Profile) -> Rgb {
    let (width, height) = (image.width, image.height);
    // Gated on what would actually move a pixel, not on the knots being present: a crop is
    // a geometry of its own, and so is a lateral correction that reads red and blue at
    // their own radius. Keying on `knots` alone ships both of those unapplied.
    let knots = profile.knots.as_deref();
    let channels = profile.lens().channels();
    let moves = crate::image::moves_pixels(knots, profile.crop)
        || !crate::image::is_registered(&channels);
    let warp = moves.then(|| {
        crate::image::Warp::new(
            image,
            width,
            height,
            knots.unwrap_or_default(),
            profile.crop,
            &channels,
            // The output goes through the cubic: bilinear's softening is radial here, and
            // it costs a mean 25% of the edge gradient (DESIGN 10.8).
            crate::image::Sampling::Bicubic,
        )
    });
    let mut out = Rgb { width, height, data: vec![0u8; width * height * 3] };

    let (cx, cy) = (width as f64 / 2.0, height as f64 / 2.0);
    let half = (cx * cx + cy * cy).sqrt().max(1.0);
    // Row-major rather than one flat index, so the falloff's radius comes off the
    // loop counters rather than a divide per pixel.
    let folded = profile.colour.as_ref().map(fold);
    out.data.par_chunks_mut(width * 3).enumerate().for_each(|(y, row)| {
        let dy = y as f64 - cy;
        for (x, pixel) in row.chunks_mut(3).enumerate() {
            let source = match &warp {
                // Outside the source frame the warp contributes nothing, and a black
                // margin is what the separate pass left there too.
                Some(warp) => match warp.at(image, x, y) {
                    Some(got) => got,
                    None => continue,
                },
                None => {
                    let i = (y * width + x) * 3;
                    [image.data[i], image.data[i + 1], image.data[i + 2]]
                }
            };
            let (mut r, mut g, mut b) = (source[0], source[1], source[2]);
            if let Some(gain) = &profile.gain {
                let radius = Gain::radius(x as f64 - cx, dy, half);
                r = Gain::of(Some(gain), radius, r);
                g = Gain::of(Some(gain), radius, g);
                b = Gain::of(Some(gain), radius, b);
            }
            let (Some(colour), Some(folded)) = (&profile.colour, &folded) else {
                (pixel[0], pixel[1], pixel[2]) = (r, g, b);
                continue;
            };
            let (ri, gi, bi) = (r as usize, g as usize, b as usize);
            let mixed = match r.max(g).max(b) <= SEPARABLE_LEVEL {
                true => [
                    folded[0][ri] + folded[1][gi] + folded[2][bi],
                    folded[3][ri] + folded[4][gi] + folded[5][bi],
                    folded[6][ri] + folded[7][gi] + folded[8][bi],
                ],
                // Above the ceiling the tone stage scales the whole pixel by its own
                // brightest channel, so it stops being three independent curves and no
                // table can carry it.
                false => {
                    let scale = 1.0 / 255.0;
                    let toned = crate::hdr_fit::tone(
                        colour,
                        f64::from(r) * scale,
                        f64::from(g) * scale,
                        f64::from(b) * scale,
                    );
                    let m = &colour.matrix;
                    [
                        m[0][0] * toned[0] + m[0][1] * toned[1] + m[0][2] * toned[2],
                        m[1][0] * toned[0] + m[1][1] * toned[1] + m[1][2] * toned[2],
                        m[2][0] * toned[0] + m[2][1] * toned[1] + m[2][2] * toned[2],
                    ]
                }
            };
            let v = crate::hdr_fit::finish_chroma(colour, mixed);
            for c in 0..3 {
                pixel[c] = clamp8(v[c] * 255.0) as u8;
            }
        }
    });
    out
}

/// The highest 8-bit level the tone stage still treats one channel at a time.
///
/// `TRUST_CEILING` is where it starts scaling the whole pixel by its brightest channel
/// to keep a bright colour's hue, which couples the three and takes them out of any
/// per-channel table. 0.9 of 255 lands between 229 and 230.
const SEPARABLE_LEVEL: u8 = (crate::hdr_fit::TRUST_CEILING * 255.0) as u8;

/// The curves and the matrix collapsed into nine 256-entry tables, one per
/// (output, input) channel pair, so the separable part of the transform is nine lookups
/// and six adds rather than three curve samples, nine multiplies and six adds.
///
/// Exact rather than an approximation, and only because the input is 8-bit: the curves
/// are then asked for 256 values each and the matrix is linear in what they return. It
/// is worth the trouble - unfolded, this pass ran 5x longer per pixel, which on a 24MP
/// frame is most of a second.
fn fold(colour: &crate::hdr_fit::HdrColour) -> [[f64; 256]; 9] {
    let mut folded = [[0.0f64; 256]; 9];
    for level in 0..=255usize {
        let v = level as f64 / 255.0;
        let toned: Vec<f64> = (0..3).map(|c| crate::hdr_fit::tone_channel(colour, c, v)).collect();
        for out in 0..3 {
            for input in 0..3 {
                folded[out * 3 + input][level] = colour.matrix[out][input] * toned[input];
            }
        }
    }
    folded
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene(width: usize, height: usize) -> Rgb {
        // Smooth, low-gradient content: the pair gate rejects steep edges, so a
        // noise field would leave nothing to fit.
        let mut data = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                data[i] = (60.0 + 120.0 * (x as f64 / width as f64)) as u8;
                data[i + 1] = (50.0 + 130.0 * (y as f64 / height as f64)) as u8;
                data[i + 2] = (90.0 + 60.0 * ((x + y) as f64 / (width + height) as f64)) as u8;
            }
        }
        Rgb { width, height, data }
    }

    /// Noise, hard edges and a gradient: content a blur has something to flatten.
    fn textured(width: usize, height: usize) -> Rgb {
        let mut data = vec![0u8; width * height * 3];
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        for y in 0..height {
            for x in 0..width {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                let noise = ((seed >> 40) & 0x3F) as f64 - 32.0;
                let edge = if (x / 37 + y / 41) % 2 == 0 { 45.0 } else { 0.0 };
                let i = (y * width + x) * 3;
                for (c, base) in [70.0, 110.0, 150.0].into_iter().enumerate() {
                    let v = base + edge + noise + 40.0 * ((x + c * 37) as f64 / width as f64);
                    data[i + c] = v.clamp(0.0, 255.0) as u8;
                }
            }
        }
        Rgb { width, height, data }
    }

    #[test]
    fn blur_flattens_detail_without_shifting_the_average() {
        let source = textured(64, 64);
        let out = blur(&source, 3.0);
        assert_eq!((out.width, out.height), (64, 64));
        let mean = |d: &[u8]| d.iter().map(|v| u64::from(*v)).sum::<u64>() / d.len() as u64;
        assert!(
            (mean(&source.data) as i64 - mean(&out.data) as i64).abs() < 3,
            "a blur should not move the overall level"
        );
        let spread = |d: &[u8]| {
            let (lo, hi) = d.iter().fold((255u8, 0u8), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
            hi - lo
        };
        assert!(spread(&out.data) < spread(&source.data), "a blur should flatten detail");
    }

    #[test]
    fn identity_colour_leaves_a_render_alone() {
        let source = scene(32, 24);
        let profile = Profile {
            knots: None,
            gain: None,
            tca: None,
            crop: 1.0,
            source: 0,
            colour: Some(crate::hdr_fit::HdrColour::identity()),
        };
        let out = apply(source.as_ref(), &profile);
        // Within a level rather than exactly: the curves are sampled and interpolated
        // rather than tabulated per 8-bit level, so an identity round-trips through
        // 8 bits to itself only up to that sampling.
        for (got, want) in out.data.iter().zip(&source.data) {
            assert!(got.abs_diff(*want) <= 1, "{got} against {want}");
        }
    }

    #[test]
    fn a_profile_with_no_curve_still_applies_its_rescale() {
        // A crop is a geometry even with no knots beside it, and deciding on
        // `knots.is_none()` alone threw away the scale the fit had just measured -
        // which on frames where the curve loses is the whole of the geometry.
        let source = scene(64, 48);
        let profile =
            Profile { knots: None, gain: None, tca: None, crop: 0.99, source: 0, colour: None };
        assert_ne!(apply(source.as_ref(), &profile).data, source.data);
    }

    #[test]
    fn a_profile_with_only_a_lateral_scale_still_warps() {
        // No curve, no crop, no falloff - and still a geometry, because red and blue
        // are being read at a different radius from green. Gating the warp on the
        // distortion alone would drop it and leave the fringe in.
        let source = scene(64, 48);
        let profile = Profile {
            knots: None,
            gain: None,
            tca: Some(crate::tca::flat(1.002, 0.998)),
            crop: 1.0,
            source: 0,
            colour: None,
        };
        assert!(!profile.lens().is_identity());
        assert_ne!(apply(source.as_ref(), &profile).data, source.data);
    }

    #[test]
    fn a_recorded_curve_reaches_the_profile_and_takes_its_crop_room_with_it() {
        // **The cascade had no coverage through this function at all.** Stubbing the body
        // of `with_lateral` to `profile.tca = None` left the whole suite green, and so did
        // deleting the crop division - so neither the curve reaching the profile nor the
        // room the widest channel needs was pinned anywhere.
        let render = scene(96, 72);
        let mut profile =
            Profile { knots: None, gain: None, tca: None, crop: 1.0, source: 0, colour: None };
        // 0.6% outward on red: over `MIN_SHIFT`'s quarter-pixel floor at this frame size
        // and well under `MAX_SCALE`, so `plausible` accepts it, and `improves` cannot
        // refuse it on a frame with no point sources to check against.
        let recorded = crate::tca::flat(1.006, 1.0);
        with_lateral(&mut profile, render.as_ref(), Some(recorded));

        let tca = profile.tca.as_ref().expect("a recorded curve reaches the profile");
        let widest = crate::tca::widest(Some(tca));
        assert!(widest > 1.0, "red reads past green, so the widest reach is over 1: {widest}");
        // The crop has to tighten by exactly that reach, or the channel read furthest out
        // samples past the edge of the frame it was cropped to.
        assert!(
            (profile.crop - 1.0 / widest).abs() < 1e-12,
            "crop {} against the {widest} of room the curve needs",
            profile.crop,
        );
    }

    /// The geometry search minimises this and nothing else, so a luma curve that does
    /// not track the tone difference between the two frames would leave the search
    /// ranking candidates on the difference in exposure rather than in alignment.
    #[test]
    fn a_luma_curve_recovers_a_known_tone_mapping() {
        let mut data = Vec::new();
        let mut count = 0;
        for level in 0..=255u8 {
            let target = (level as f64 * 0.75 + 20.0).min(255.0) as u8;
            // Grey, so luma is the level itself and the mapping under test is the only
            // thing the curve can be reading.
            for _ in 0..20 {
                data.extend_from_slice(&[level, level, level, target, target, target, 0]);
                count += 1;
            }
        }
        let curve = fit_luma_curve(&Pairs { data, count }, Phase::Train, None);
        for level in [10usize, 80, 200] {
            let expected = (level as f64 * 0.75 + 20.0).min(255.0);
            assert!(
                (curve[level] as f64 - expected).abs() <= 1.5,
                "level {level}: {} vs {expected}",
                curve[level],
            );
        }
    }

    /// Held-out pairs the curve maps exactly must score at the floor, or every candidate
    /// carries a constant the comparison then has to see past.
    #[test]
    fn a_luma_score_bottoms_out_when_the_curve_maps_every_pair() {
        let mut data = Vec::new();
        let mut count = 0;
        for level in 0..=255u8 {
            let target = (level as f64 * 0.75 + 20.0).min(255.0) as u8;
            for _ in 0..20 {
                data.extend_from_slice(&[level, level, level, target, target, target, 0]);
                count += 1;
            }
        }
        let pairs = Pairs { data, count };
        let curve = fit_luma_curve(&pairs, Phase::Train, None);
        // One level of rounding is 100/255 of a unit, so anything under that is exact.
        assert!(score_luma(&pairs, Phase::Test, None, &curve) < 100.0 / 255.0);

        let mut identity = [0u8; 256];
        for (level, slot) in identity.iter_mut().enumerate() {
            *slot = level as u8;
        }
        assert!(score_luma(&pairs, Phase::Test, None, &identity) > 5.0, "an unfitted curve must score badly");
    }

    /// BT.709, not an average: a frame's green carries most of its luma, and getting
    /// these weights wrong would be invisible on the grey pairs above.
    #[test]
    fn luma_weights_green_the_most_and_blue_the_least() {
        assert_eq!(luma8(255, 255, 255), 255);
        assert_eq!(luma8(0, 255, 0), 182);
        assert_eq!(luma8(255, 0, 0), 54);
        assert_eq!(luma8(0, 0, 255), 18);
    }

    #[test]
    fn a_curve_is_monotone_even_from_noisy_bins() {
        let mut data = Vec::new();
        let mut count = 0;
        for level in 0..=255u8 {
            // A target that jumps around: the fit must still not invert.
            let target = if level % 2 == 0 { level.saturating_sub(30) } else { level.saturating_add(30) };
            for _ in 0..20 {
                data.extend_from_slice(&[level, level, level, target, target, target, 0]);
                count += 1;
            }
        }
        let curve = fit_luma_curve(&Pairs { data, count }, Phase::Train, None);
        for level in 1..256 {
            assert!(curve[level] >= curve[level - 1], "curve dipped at {level}");
        }
    }

    #[test]
    fn every_crop_candidate_fills_the_frame() {
        // Slack is measured down from the tightest fill, so a positive entry here would
        // put a black margin back in the search - which the residual cannot see, the
        // pair gate skipping black, and so would score as well as the crop that fills.
        assert!(SLACK_SCAN.iter().all(|slack| *slack <= 0.0), "{SLACK_SCAN:?}");
        assert!(SLACK_SCAN.contains(&0.0), "the tightest fill has to be a candidate");
    }
}
