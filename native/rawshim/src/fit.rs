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

use crate::image::{polynomial_knots, warp};
use crate::vips::{self, Rgb, RgbRef};
use rayon::prelude::*;

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

/// Crop and k1 lie along a diagonal valley, so the grid only has to land in the
/// valley and the joint refine walks down it.
const FALLBACK_K1_SCAN: [f64; 7] = [-0.06, -0.04, -0.02, 0.0, 0.02, 0.04, 0.06];
const FALLBACK_CROP_SCAN: [f64; 3] = [0.97, 1.0, 1.03];

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

#[derive(Clone)]
pub struct ColourTransform {
    pub curves: [[u8; 256]; 3],
    pub matrix: [[f64; 3]; 3],
}

impl ColourTransform {
    /// A fit always produces a real transform; this is for the self-test and the
    /// tests, both of which need a known-good profile rather than a fitted one.
    pub fn identity() -> Self {
        let mut curves = [[0u8; 256]; 3];
        for curve in &mut curves {
            for (level, slot) in curve.iter_mut().enumerate() {
                *slot = level as u8;
            }
        }
        ColourTransform { curves, matrix: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]] }
    }
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
}

impl Lens {
    /// A lens that did nothing, for a caller with no fit to hand.
    pub fn none() -> Self {
        Lens { distortion: None, crop: 1.0, falloff: None }
    }

    /// Whether applying this would change any pixel.
    pub fn is_identity(&self) -> bool {
        self.distortion.is_none() && self.falloff.is_none()
    }
}

pub struct Profile {
    pub knots: Option<Vec<f64>>,
    /// The falloff the camera corrected and the render did not, or None where the
    /// frame is better off without one.
    pub gain: Option<Gain>,
    pub crop: f64,
    /// 0 none, or one of the `SOURCE_` codes. Reported so a rendition can be
    /// re-cut when the cascade changes under it, and so the fit can be judged by
    /// where its geometry came from.
    pub source: u32,
    pub delta_e: f64,
    pub colour: ColourTransform,
}

impl Profile {
    /// Everything §10.8.1 lifts, in one piece so it cannot lift half.
    pub fn lens(&self) -> Lens {
        Lens {
            distortion: self.knots.clone(),
            crop: self.crop,
            falloff: self.gain.as_ref().map(Gain::coefficients),
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

/// One channel's tone curve, as the mean target for each input level. Gaps are
/// interpolated, the ends extend at the last known slope rather than flattening
/// (which would crush every highlight the frame happened not to sample), and the
/// result is made monotone so a thinly-populated bin cannot invert it.
fn fit_curve(pairs: &Pairs, phase: Phase, gain: Option<&Gain>, channel: usize) -> [u8; 256] {
    let mut sum = [0.0f64; 256];
    let mut count = [0.0f64; 256];
    let mut p = phase as usize;
    while p < pairs.count {
        let o = p * PAIR_STRIDE;
        let level = Gain::of(gain, pairs.data[o + RADIUS], pairs.data[o + channel]) as usize;
        sum[level] += pairs.data[o + 3 + channel] as f64;
        count[level] += 1.0;
        p += 2;
    }
    curve_from_bins(sum, count)
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

/// Gauss-Jordan on a 3x3. None rather than garbage when singular.
fn solve3(matrix: [[f64; 3]; 3], rhs: [f64; 3]) -> Option<[f64; 3]> {
    let mut m = [[0.0f64; 4]; 3];
    for i in 0..3 {
        m[i][..3].copy_from_slice(&matrix[i]);
        m[i][3] = rhs[i];
    }
    for col in 0..3 {
        let mut pivot = col;
        for row in col + 1..3 {
            if m[row][col].abs() > m[pivot][col].abs() {
                pivot = row;
            }
        }
        m.swap(col, pivot);
        if m[col][col].abs() < 1e-9 {
            return None;
        }
        for row in 0..3 {
            if row == col {
                continue;
            }
            let factor = m[row][col] / m[col][col];
            for k in col..4 {
                m[row][k] -= factor * m[col][k];
            }
        }
    }
    Some([m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]])
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
    #[cfg(test)]
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

/// The gain the pairs ask for, given a colour transform fitted under the current one.
///
/// Run backwards rather than searched, which is one pass where a search over candidate
/// gains would be one pass each (10.8).
///
/// The answer is absolute, not an increment on the gain already in hand - the
/// inverted target lands in gained-source levels and the pair's own source is
/// ungained, so their ratio is the whole of what the gain has to supply. An
/// increment would have to compose, and two of these do not compose into one.
fn refit_gain(pairs: &Pairs, phase: Phase, colour: &ColourTransform) -> Option<(f64, f64)> {
    let inverse = invert3(colour.matrix)?;
    let back: Vec<[u8; 256]> = (0..3).map(|c| invert_curve(&colour.curves[c])).collect();
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
        let t = [
            pairs.data[o + 3] as f64,
            pairs.data[o + 4] as f64,
            pairs.data[o + 5] as f64,
        ];
        // A level the curve never reached inverts to a clamp rather than a mapping,
        // so those are dropped rather than believed.
        let mut source = [0u8; 3];
        let mut usable = true;
        for c in 0..3 {
            let mixed = inverse[c][0] * t[0] + inverse[c][1] * t[1] + inverse[c][2] * t[2];
            if !(2.0..=253.0).contains(&mixed) {
                usable = false;
                break;
            }
            source[c] = back[c][mixed.round() as usize];
            if source[c] <= 1 || source[c] >= 254 {
                usable = false;
                break;
            }
        }
        if !usable {
            continue;
        }
        let luma = |v: [f64; 3]| 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
        let want = luma([
            linear[source[0] as usize],
            linear[source[1] as usize],
            linear[source[2] as usize],
        ]);
        let is = luma([
            linear[pairs.data[o] as usize],
            linear[pairs.data[o + 1] as usize],
            linear[pairs.data[o + 2] as usize],
        ]);
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

fn invert3(m: [[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-9 {
        return None;
    }
    let mut out = [[0.0f64; 3]; 3];
    for row in 0..3 {
        for col in 0..3 {
            let (r0, r1) = ((col + 1) % 3, (col + 2) % 3);
            let (c0, c1) = ((row + 1) % 3, (row + 2) % 3);
            out[row][col] = (m[r0][c0] * m[r1][c1] - m[r0][c1] * m[r1][c0]) / det;
        }
    }
    Some(out)
}

/// The gain and the colour transform together, alternating: neither can be fitted
/// without the other, since a falloff looks like a tone difference to a curve and a
/// tone difference looks like falloff to a gain.
///
/// The gain is None where the frame is better off without one, which is the point of
/// the gate: a body that corrected no falloff would otherwise have two free
/// parameters fitted to its noise. Judged on the pairs the round was not fitted on,
/// for exactly that reason - extra free parameters can only ever look better on their
/// own. The returned deltaE is that same held-out score, so the caller does not pay a
/// second pass to learn what this already measured.
fn fit_gain_and_colour(pairs: &Pairs, phase: Phase) -> (Option<Gain>, ColourTransform, f64) {
    let held = phase.held_out();
    let mut colour = fit_colour(pairs, phase, None);
    let mut best = score(pairs, held, None, &colour);
    let mut gain: Option<Gain> = None;
    // Three, because the first round's curves were fitted with the falloff still in
    // them and so partly absorb it - measured on an injected 0.65 corner, one round
    // recovers 0.78 and the next two land it.
    for _ in 0..3 {
        let Some((a, b)) = refit_gain(pairs, phase, &colour) else { break };
        let candidate = Gain::from_poly(a, b);
        let fitted = fit_colour(pairs, phase, Some(&candidate));
        let delta = score(pairs, held, Some(&candidate), &fitted);
        if delta >= best {
            break;
        }
        best = delta;
        gain = Some(candidate);
        colour = fitted;
    }
    (gain, colour, best)
}

/// Per-channel curves then a 3x3 mix. Deliberately not a 3D LUT: measured against
/// one, 777 coefficients beat a 17^3 LUT and tie a 33^3 one, because the vendor
/// transform is close enough to separable that the extra dimensions only fit noise
/// in the cells a single frame never populates.
fn fit_colour(pairs: &Pairs, phase: Phase, gain: Option<&Gain>) -> ColourTransform {
    let curves = [
        fit_curve(pairs, phase, gain, 0),
        fit_curve(pairs, phase, gain, 1),
        fit_curve(pairs, phase, gain, 2),
    ];

    // A'A is symmetric, so only the upper triangle is accumulated.
    let (mut a00, mut a01, mut a02, mut a11, mut a12, mut a22) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    let mut b = [[0.0f64; 3]; 3];
    let mut p = phase as usize;
    while p < pairs.count {
        let o = p * PAIR_STRIDE;
        let radius = pairs.data[o + RADIUS];
        let s0 = curves[0][Gain::of(gain, radius, pairs.data[o]) as usize] as f64;
        let s1 = curves[1][Gain::of(gain, radius, pairs.data[o + 1]) as usize] as f64;
        let s2 = curves[2][Gain::of(gain, radius, pairs.data[o + 2]) as usize] as f64;
        a00 += s0 * s0;
        a01 += s0 * s1;
        a02 += s0 * s2;
        a11 += s1 * s1;
        a12 += s1 * s2;
        a22 += s2 * s2;
        for out in 0..3 {
            let target = pairs.data[o + 3 + out] as f64;
            b[out][0] += s0 * target;
            b[out][1] += s1 * target;
            b[out][2] += s2 * target;
        }
        p += 2;
    }

    let ata = [[a00, a01, a02], [a01, a11, a12], [a02, a12, a22]];
    let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut matrix = [[0.0f64; 3]; 3];
    for out in 0..3 {
        matrix[out] = solve3(ata, b[out]).unwrap_or(identity[out]);
    }
    ColourTransform { curves, matrix }
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

pub(crate) fn lab_from_levels(table: &[f64; 256], r: u8, g: u8, b: u8) -> [f64; 3] {
    let (rr, gg, bb) = (table[r as usize], table[g as usize], table[b as usize]);
    let x = (0.4124 * rr + 0.3576 * gg + 0.1805 * bb) / 0.95047;
    let y = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
    let z = (0.0193 * rr + 0.1192 * gg + 0.9505 * bb) / 1.08883;
    let f = |t: f64| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    let fy = f(y);
    [116.0 * fy - 16.0, 500.0 * (f(x) - fy), 200.0 * (fy - f(z))]
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
    let lab = |v: &[f64; 3]| {
        let f = |value: f64| to_linear(value.clamp(0.0, 255.0));
        let (r, g, bl) = (f(v[0]), f(v[1]), f(v[2]));
        let x = (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047;
        let y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        let z = (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883;
        let t = |v: f64| if v > 0.008856 { v.cbrt() } else { 7.787 * v + 16.0 / 116.0 };
        let fy = t(y);
        [116.0 * fy - 16.0, 500.0 * (t(x) - fy), 200.0 * (fy - t(z))]
    };
    let (p, q) = (lab(a), lab(b));
    ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
}

/// Mean deltaE over pairs the transform was not fitted on. Every number this
/// module reports is held out: a curve with 256 free parameters will always look
/// better on its own training pairs.
fn score(pairs: &Pairs, phase: Phase, gain: Option<&Gain>, transform: &ColourTransform) -> f64 {
    let table = linear_table();
    let m = &transform.matrix;
    let curves = &transform.curves;
    let mut total = 0.0;
    let mut counted = 0usize;
    let mut p = phase as usize;
    while p < pairs.count {
        let o = p * PAIR_STRIDE;
        let radius = pairs.data[o + RADIUS];
        let r = curves[0][Gain::of(gain, radius, pairs.data[o]) as usize] as f64;
        let g = curves[1][Gain::of(gain, radius, pairs.data[o + 1]) as usize] as f64;
        let b = curves[2][Gain::of(gain, radius, pairs.data[o + 2]) as usize] as f64;
        // Rounded to the level that would actually be written to the rendition,
        // which is also what makes the lookup exact rather than an approximation.
        let out0 = clamp8((m[0][0] * r + m[0][1] * g + m[0][2] * b).round()) as u8;
        let out1 = clamp8((m[1][0] * r + m[1][1] * g + m[1][2] * b).round()) as u8;
        let out2 = clamp8((m[2][0] * r + m[2][1] * g + m[2][2] * b).round()) as u8;
        let a = lab_from_levels(&table, out0, out1, out2);
        let t = lab_from_levels(&table, pairs.data[o + 3], pairs.data[o + 4], pairs.data[o + 5]);
        let (dl, da, db) = (a[0] - t[0], a[1] - t[1], a[2] - t[2]);
        total += (dl * dl + da * da + db * db).sqrt();
        counted += 1;
        p += 2;
    }
    if counted == 0 { f64::INFINITY } else { total / counted as f64 }
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
    let curve = fit_luma_curve(&all, Phase::Train);
    Some(score_luma(&all, Phase::Test, &curve))
}

/// BT.709 luma of a display-referred triple, in the same 8-bit levels the pair holds.
///
/// Taken on the encoded values rather than in linear light, which is what Y' means and
/// what makes it free: the tone curve fitted over it absorbs any transfer difference
/// between the two images anyway.
#[inline]
fn luma8(r: u8, g: u8, b: u8) -> u8 {
    (0.2126 * r as f64 + 0.7152 * g as f64 + 0.0722 * b as f64).round() as u8
}

fn fit_luma_curve(pairs: &Pairs, phase: Phase) -> [u8; 256] {
    let mut sum = [0.0f64; 256];
    let mut count = [0.0f64; 256];
    let mut p = phase as usize;
    while p < pairs.count {
        let o = p * PAIR_STRIDE;
        let level = luma8(pairs.data[o], pairs.data[o + 1], pairs.data[o + 2]) as usize;
        sum[level] += luma8(pairs.data[o + 3], pairs.data[o + 4], pairs.data[o + 5]) as f64;
        count[level] += 1.0;
        p += 2;
    }
    curve_from_bins(sum, count)
}

/// Mean luma error over held-out pairs, scaled into L*-sized units so `REFINE_MARGIN`
/// and `REFINE_FLOOR` mean what they meant when this was scored in deltaE.
fn score_luma(pairs: &Pairs, phase: Phase, curve: &[u8; 256]) -> f64 {
    let mut total = 0.0;
    let mut counted = 0usize;
    let mut p = phase as usize;
    while p < pairs.count {
        let o = p * PAIR_STRIDE;
        let source = curve[luma8(pairs.data[o], pairs.data[o + 1], pairs.data[o + 2]) as usize];
        let target = luma8(pairs.data[o + 3], pairs.data[o + 4], pairs.data[o + 5]);
        total += (source as f64 - target as f64).abs();
        counted += 1;
        p += 2;
    }
    if counted == 0 { f64::INFINITY } else { total / counted as f64 * (100.0 / 255.0) }
}

fn corresponding(grid: &Grid, knots: &[f64], crop: f64) -> Option<Pairs> {
    // No libvips in here, deliberately. Both planes were blurred once when the grid
    // was built, so a candidate is a warp and a pair pass over one buffer - where
    // blurring per candidate meant converting to a VipsImage and materialising back
    // twice each time, which cost more than the blur.
    //
    // Blurring before the warp rather than after is the same picture for this
    // purpose: the filter exists to remove detail neither image can be trusted on,
    // and a Gaussian commutes with a near-identity resample closely enough that the
    // fitted deltaE does not move.
    let warped = warp(grid.source.as_ref(), grid.jpeg.width, grid.jpeg.height, knots, crop);
    let all = pairs(&warped, &grid.jpeg);
    (all.count >= MIN_PAIRS).then_some(all)
}

/// `residual_for` plus the falloff, for the geometry that won.
///
/// Kept out of the search itself: the gain costs a second colour fit per candidate
/// and the search only needs candidates ranked against each other, which a falloff
/// common to all of them does not change.
fn residual_with_gain(grid: &Grid, knots: &[f64], crop: f64) -> Option<(f64, ColourTransform, Option<Gain>)> {
    let all = corresponding(grid, knots, crop)?;
    let (gain, colour, delta) = fit_gain_and_colour(&all, Phase::Train);
    Some((delta, colour, gain))
}

/// Where to start looking for the crop that accompanies a known spline.
///
/// A pincushion correction pulls the corner inward, so the camera scales by
/// roughly the reciprocal of the corner displacement to keep the frame full - and
/// measured against a fitted crop that prediction was exact. For barrel the camera
/// is more conservative than tightest-fill, so this is a starting point, never the
/// answer: a scan around it still runs.
fn estimate_crop(knots: &[f64]) -> f64 {
    let corner = knots.last().copied().unwrap_or(0.0);
    if corner > 0.0 { 1.0 / (1.0 + corner / crate::image::SPLINE_UNIT) } else { 1.0 }
}

fn scan_around(centre: f64, step: f64, count: i32) -> Vec<f64> {
    (-count..=count).map(|i| centre + i as f64 * step).collect()
}

/// Evaluates candidates across cores. They share only their inputs, which makes
/// the scan the one genuinely parallel part of a fit; the refine that follows is
/// sequential by nature, each step depending on the last.
fn scan<T: Send + Sync + Copy>(grid: &Grid, candidates: &[T], knots_of: impl Fn(T) -> Vec<f64> + Sync, crop_of: impl Fn(T) -> f64 + Sync) -> Option<(T, f64)> {
    candidates
        .par_iter()
        .filter_map(|candidate| {
            residual_for(grid, &knots_of(*candidate), crop_of(*candidate)).map(|delta| (*candidate, delta))
        })
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
}

/// Coarse scan on the search grid, then refine at full size.
///
/// The scan only has to land in the right valley, which a quarter of the pixels
/// answers just as well. The refine compares neighbours a fraction of a percent
/// apart, and at half resolution those differences fall below the improvement
/// threshold, so it halts early and leaves the geometry short - an injected 3%
/// distortion came back as 1.3% when the refine also ran coarse.
fn fit_crop(grids: &Grids, knots: &[f64], coarse: &[f64]) -> Option<(f64, f64)> {
    let (mut crop, _) = scan(&grids.search, coarse, |_| knots.to_vec(), |c| c)?;
    let mut delta = residual_for(&grids.full, knots, crop)?;

    let mut step = coarse.get(1).copied().unwrap_or(1.0) - coarse.first().copied().unwrap_or(0.0);
    while step > REFINE_FLOOR {
        let mut improved = false;
        for sign in [1.0, -1.0] {
            let trial = crop + sign * step;
            if let Some(candidate) = residual_for(&grids.full, knots, trial) {
                if candidate < delta - REFINE_MARGIN {
                    crop = trial;
                    delta = candidate;
                    improved = true;
                }
            }
        }
        if !improved {
            step /= 2.0;
        }
    }
    Some((crop, delta))
}

/// A curve someone else already knows, kept only if it corresponds better than
/// leaving the frame alone.
///
/// Losing means correcting nothing rather than falling through to the search, which
/// reads like a missing cascade and is not: a curve that cannot beat the identity is
/// saying this JPEG was not corrected, and a fitted polynomial agrees. Over the 58
/// sampled frames where this fired before the uncorrected flag caught most of them,
/// forcing the search through improved 3 by a median of 0.07 deltaE and declined on
/// half.
fn with_curve(grids: &Grids, knots: Vec<f64>, baseline: f64, source: u32) -> (Option<Vec<f64>>, f64, u32) {
    match fit_crop(grids, &knots, &scan_around(estimate_crop(&knots), 0.01, 3)) {
        Some((crop, delta)) if delta < baseline => (Some(knots), crop, source),
        _ => (None, 1.0, 0),
    }
}

/// Radial polynomial plus crop, for bodies that record no correction of their own -
/// every Canon, and anything old enough not to have written one. Two parameters
/// reach the same residual as a camera's spline, but it is the expensive way there:
/// fitting the same frames both ways is 1643ms against 360ms on an RX100M3 and
/// 1216ms against 589ms on an ILCE-7CR.
fn fit_polynomial(grids: &Grids) -> Option<(f64, f64, f64)> {
    let candidates: Vec<(f64, f64)> = FALLBACK_K1_SCAN
        .iter()
        .flat_map(|k1| FALLBACK_CROP_SCAN.iter().map(move |crop| (*k1, *crop)))
        .collect();
    let ((mut k1, mut crop), _) =
        scan(&grids.search, &candidates, |(k1, _)| polynomial_knots(k1, 0.0, 16), |(_, crop)| crop)?;
    let mut delta = residual_for(&grids.full, &polynomial_knots(k1, 0.0, 16), crop)?;

    let (mut step_k1, mut step_crop) = (0.01, 0.01);
    while step_crop > REFINE_FLOOR {
        let mut improved = false;
        for axis in 0..2 {
            for sign in [1.0, -1.0] {
                let trial_k1 = if axis == 0 { k1 + sign * step_k1 } else { k1 };
                let trial_crop = if axis == 1 { crop + sign * step_crop } else { crop };
                if let Some(candidate) =
                    residual_for(&grids.full, &polynomial_knots(trial_k1, 0.0, 16), trial_crop)
                {
                    if candidate < delta - REFINE_MARGIN {
                        k1 = trial_k1;
                        crop = trial_crop;
                        delta = candidate;
                        improved = true;
                    }
                }
            }
        }
        if !improved {
            step_k1 /= 2.0;
            step_crop /= 2.0;
        }
    }
    Some((k1, crop, delta))
}

/// Fits the transform taking `render` to `jpeg_bytes`.
pub fn fit(render: RgbRef<'_>, jpeg_bytes: &[u8], geometry: Geometry) -> Result<Option<Profile>, String> {
    // One libvips graph each, evaluated once. Decode, orient, resize and blur fuse
    // into a single streamed pass rather than four buffers handed between four
    // calls.
    let jpeg_full = vips::Pipeline::decode_upright(jpeg_bytes)?
        .resize_to_fit(FIT_LONG_EDGE)?
        .blur(FIT_BLUR_SIGMA)?
        .finish()?;
    // The gate is on the colour, so it belongs on the route that applies the colour.
    // A fit this far from the camera is more likely wrong than the camera is unusual,
    // and an SDR render is better off untransformed than transformed by it.
    Ok(fit_against(render, jpeg_full, geometry)?
        .filter(|p| p.delta_e.is_finite() && p.delta_e <= MAX_ACCEPTABLE_DELTA_E))
}

/// `fit`, without the colour gate, for a caller that wants the geometry.
///
/// `MAX_ACCEPTABLE_DELTA_E` decides whether an SDR render should wear a colour transform
/// at all. `fit_all` asks the same call for geometry and gives up where there is no
/// profile, so on the one route an HDR rendition takes, a refused *SDR colour* also
/// refuses the HDR match - a different fit, in a different domain, against a different
/// reference, which was never asked whether it would have worked.
///
/// No frame of the 35-frame set trips it: the worst SDR fit there is 4.1 against a limit
/// of 6. It is reachable rather than observed, and it was reached by accident - feeding
/// the geometry fit a cheaper preview took IMG_9887's SDR fit to 10.4 and silently cost
/// that frame its camera colour entirely. Geometry is judged on its own terms anyway: a
/// candidate has to beat the undistorted baseline before it is chosen.
pub fn fit_ungated(
    render: RgbRef<'_>,
    jpeg_bytes: &[u8],
    geometry: Geometry,
) -> Result<Option<Profile>, String> {
    let jpeg_full = vips::Pipeline::decode_upright(jpeg_bytes)?
        .resize_to_fit(FIT_LONG_EDGE)?
        .blur(FIT_BLUR_SIGMA)?
        .finish()?;
    fit_against(render, jpeg_full, geometry)
}

fn fit_against(
    render: RgbRef<'_>,
    jpeg_full: Rgb,
    geometry: Geometry,
) -> Result<Option<Profile>, String> {
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
        source: vips::Pipeline::from_rgb(render)?
            .resize_exact(source_width, source_height.max(1))?
            .blur(source_sigma)?
            .finish()?,
        jpeg: jpeg_full,
    };
    let search = Grid {
        source: vips::Pipeline::from_rgb(full.source.as_ref())?
            .resize_exact(full.source.width / 2, full.source.height / 2)?
            .finish()?,
        jpeg: vips::Pipeline::from_rgb(full.jpeg.as_ref())?
            .resize_exact(full.jpeg.width / 2, full.jpeg.height / 2)?
            .finish()?,
    };
    let grids = Grids { full, search };

    let baseline_delta = residual_for(&grids.full, &[], 1.0).unwrap_or(f64::INFINITY);

    // Decided entirely on the search grid; the winner is re-fitted at full size
    // below, so nothing reported was measured coarse.
    let chosen: (Option<Vec<f64>>, f64, u32) = match geometry {
        // Taken at its word, and it is worth taking: the search is 55-70% of a fit,
        // and on a frame the body says it left alone it lands on the identity
        // anyway. Skipping it took an ILCE-7CM2 fit from ~500ms to ~200ms with the
        // deltaE unchanged to two decimals on all 16 frames measured.
        Geometry::Uncorrected => (None, 1.0, 0),
        Geometry::Recorded(knots) => with_curve(&grids, knots, baseline_delta, SOURCE_CAMERA),
        Geometry::Profiled(knots) => with_curve(&grids, knots, baseline_delta, SOURCE_LENSFUN),
        Geometry::Unstated => match fit_polynomial(&grids) {
            Some((k1, crop, delta)) if delta < baseline_delta => {
                (Some(polynomial_knots(k1, 0.0, 16)), crop, SOURCE_FITTED)
            }
            _ => (None, 1.0, 0),
        },
    };

    let knots = chosen.0.clone().unwrap_or_default();
    let Some((delta_e, colour, gain)) = residual_with_gain(&grids.full, &knots, chosen.1) else {
        return Ok(None);
    };
    Ok(Some(Profile { knots: chosen.0, gain, crop: chosen.1, source: chosen.2, delta_e, colour }))
}

/// The curves and the matrix collapsed into nine 256-entry tables, one per
/// (output, input) channel pair, so applying the transform to a pixel is nine
/// lookups and six adds rather than three lookups, nine multiplies and six adds.
/// Exact, not an approximation: the matrix is linear in each curve's output.
fn fold(transform: &ColourTransform) -> [[f64; 256]; 9] {
    let mut folded = [[0.0f64; 256]; 9];
    for out in 0..3 {
        for channel in 0..3 {
            let coefficient = transform.matrix[out][channel];
            for level in 0..256 {
                folded[out * 3 + channel][level] = coefficient * transform.curves[channel][level] as f64;
            }
        }
    }
    folded
}

/// Applies a fitted profile to a render.
///
/// Warps in place of a copy where there is a geometry to apply, and grades into
/// the warp's own buffer, so a 60MP frame is moved once rather than three times.
pub fn apply(image: RgbRef<'_>, profile: &Profile) -> Rgb {
    let mut out = match &profile.knots {
        Some(knots) => warp(image, image.width, image.height, knots, profile.crop),
        None => Rgb { width: image.width, height: image.height, data: image.data.to_vec() },
    };
    let folded = fold(&profile.colour);
    let (cx, cy) = (out.width as f64 / 2.0, out.height as f64 / 2.0);
    let half = (cx * cx + cy * cy).sqrt().max(1.0);
    // Row-major rather than one flat index, so the falloff's radius comes off the
    // loop counters rather than a divide per pixel.
    for (y, row) in out.data.chunks_mut(out.width * 3).enumerate() {
        let dy = y as f64 - cy;
        for (x, pixel) in row.chunks_mut(3).enumerate() {
            let (mut r, mut g, mut b) = (pixel[0] as usize, pixel[1] as usize, pixel[2] as usize);
            if let Some(gain) = &profile.gain {
                let radius = Gain::radius(x as f64 - cx, dy, half);
                r = Gain::of(Some(gain), radius, pixel[0]) as usize;
                g = Gain::of(Some(gain), radius, pixel[1]) as usize;
                b = Gain::of(Some(gain), radius, pixel[2]) as usize;
            }
            pixel[0] = clamp8(folded[0][r] + folded[1][g] + folded[2][b]) as u8;
            pixel[1] = clamp8(folded[3][r] + folded[4][g] + folded[5][b]) as u8;
            pixel[2] = clamp8(folded[6][r] + folded[7][g] + folded[8][b]) as u8;
        }
    }
    out
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

    #[test]
    fn identity_colour_leaves_a_render_alone() {
        let source = scene(32, 24);
        let profile = Profile {
            knots: None,
            gain: None,
            crop: 1.0,
            source: 0,
            delta_e: 0.0,
            colour: ColourTransform::identity(),
        };
        let out = apply(source.as_ref(), &profile);
        assert_eq!(out.data, source.data);
    }

    #[test]
    fn folding_matches_applying_curves_then_matrix() {
        let mut colour = ColourTransform::identity();
        colour.matrix = [[0.9, 0.05, 0.05], [0.1, 0.8, 0.1], [0.0, 0.02, 0.98]];
        for level in 0..256 {
            colour.curves[0][level] = (level as f64 * 0.9) as u8;
        }
        let folded = fold(&colour);
        for level in [0usize, 37, 128, 255] {
            let r = colour.curves[0][level] as f64;
            let g = colour.curves[1][level] as f64;
            let b = colour.curves[2][level] as f64;
            let direct = colour.matrix[0][0] * r + colour.matrix[0][1] * g + colour.matrix[0][2] * b;
            let via_table = folded[0][level] + folded[1][level] + folded[2][level];
            assert!((direct - via_table).abs() < 1e-9, "level {level}");
        }
    }

    #[test]
    fn a_curve_recovers_a_known_tone_mapping() {
        // Build pairs where the target is a fixed function of the source, and check
        // the fitted curve reproduces it.
        let mut data = Vec::new();
        let mut count = 0;
        for level in 0..=255u8 {
            let target = (level as f64 * 0.75 + 20.0).min(255.0) as u8;
            // 20 copies, because the train phase reads every other pair: fewer
            // than 16 leaves each bin under MIN_BIN_SAMPLES and the curve
            // correctly falls back to identity, which passes a monotonicity
            // check without testing anything.
            for _ in 0..20 {
                data.extend_from_slice(&[level, level, level, target, target, target, 0]);
                count += 1;
            }
        }
        let pairs = Pairs { data, count };
        let curve = fit_curve(&pairs, Phase::Train, None, 0);
        for level in [10usize, 80, 200] {
            let expected = (level as f64 * 0.75 + 20.0).min(255.0);
            assert!((curve[level] as f64 - expected).abs() <= 1.5, "level {level}: {} vs {expected}", curve[level]);
        }
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
        let curve = fit_luma_curve(&Pairs { data, count }, Phase::Train);
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
        let curve = fit_luma_curve(&pairs, Phase::Train);
        // One level of rounding is 100/255 of a unit, so anything under that is exact.
        assert!(score_luma(&pairs, Phase::Test, &curve) < 100.0 / 255.0);

        let identity = ColourTransform::identity().curves[0];
        assert!(score_luma(&pairs, Phase::Test, &identity) > 5.0, "an unfitted curve must score badly");
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
        let curve = fit_curve(&Pairs { data, count }, Phase::Train, None, 0);
        for level in 1..256 {
            assert!(curve[level] >= curve[level - 1], "curve dipped at {level}");
        }
    }

    #[test]
    fn solve3_reports_a_singular_system() {
        let singular = [[1.0, 2.0, 3.0], [2.0, 4.0, 6.0], [3.0, 6.0, 9.0]];
        assert!(solve3(singular, [1.0, 2.0, 3.0]).is_none());
    }

    #[test]
    fn solve3_recovers_a_known_solution() {
        let a = [[2.0, 1.0, 0.0], [1.0, 3.0, 1.0], [0.0, 1.0, 2.0]];
        let x = [1.0, 2.0, 3.0];
        let rhs = [
            a[0][0] * x[0] + a[0][1] * x[1] + a[0][2] * x[2],
            a[1][0] * x[0] + a[1][1] * x[1] + a[1][2] * x[2],
            a[2][0] * x[0] + a[2][1] * x[1] + a[2][2] * x[2],
        ];
        let got = solve3(a, rhs).expect("system is not singular");
        for i in 0..3 {
            assert!((got[i] - x[i]).abs() < 1e-9);
        }
    }
}
