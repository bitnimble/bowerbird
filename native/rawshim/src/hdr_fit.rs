// The camera's colour treatment, fitted for the HDR path (DESIGN 10.8).
//
// The SDR fit (`fit.rs`) works entirely in 8-bit sRGB: its curves are indexed by an
// 8-bit render level and answer with an 8-bit JPEG level. That cannot be lifted to
// HDR, for two reasons that are both fatal rather than approximate. Its domain stops
// at display white, so it has nothing to say about the scene above it - which is the
// whole of what HDR adds. And 8 bits of output is coarser than the shadows of a PQ
// signal, so applying it would band.
//
// So the geometry is reused - it is a property of the lens, not of a colour space -
// and only the colour is refitted, in the domain the grade actually works in:
// Rec.2020 linear, normalised so diffuse white is 1.0. That makes the curve
// extrapolable, which is what lets the camera's rendering stop at diffuse white and
// BT.2390 take over above it (10.7.1).

use crate::image::warp_planar;
use rayon::prelude::*;

/// Long edge of the grid the fit runs on. Matching the SDR fit: fitting small and
/// applying at full resolution is free, and a 60MP fit is minutes of work for the
/// same answer.
const FIT_LONG_EDGE: usize = 640;

/// Curve resolution over the fit domain.
const BINS: usize = 256;

/// How far above diffuse white the JPEG is still believed, as a fraction of it.
///
/// Not 1.0: the last stop before an 8-bit image clips is the camera compressing
/// highlights into a range it does not have, and a curve fitted through that learns
/// the compression as though it were colour. Cut below it and the shoulder is never
/// seen.
pub const TRUST_CEILING: f64 = 0.9;

const MIN_BIN_SAMPLES: usize = 8;
const MIN_PAIRS: usize = 2000;

/// Rec.2020 luma, for the chroma blend and the sample weighting.
const LUMA: [f64; 3] = [0.2627, 0.678, 0.0593];

/// Three box passes, close enough to a Gaussian here. Both images are blurred before
/// pairing for the same reason the SDR fit does it: the camera's sharpening and noise
/// reduction are not reproducible and must not leak into the colour fit, and residual
/// misregistration stops mattering once neither image has detail at that scale.
const FIT_BLUR_RADIUS: usize = 2;

/// Where the camera's rendering stops carrying information. Above this a JPEG level is
/// on its way to flat white and says nothing about what colour was there, so a pair is
/// no use for the channel that reached it and a pixel is no use for measuring drift.
const CAMERA_CLIPPING: f64 = 0.94;

/// The damping used where a frame gives `fitted_matrix` nothing at all to choose
/// between candidates with, its moments being empty. The frame picks its own in every
/// other case; this is the value it used to be fixed at.
const MATRIX_RIDGE: f64 = 0.05;

const SRGB_TO_XYZ: [[f64; 3]; 3] = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.072175],
    [0.0193339, 0.119192, 0.9503041],
];
const XYZ_TO_REC2020: [[f64; 3]; 3] = [
    [1.7166512, -0.3556708, -0.2533663],
    [-0.6666844, 1.6164812, 0.0157685],
    [0.0176399, -0.0427706, 0.9421031],
];
const REC2020_TO_XYZ: [[f64; 3]; 3] = [
    [0.637958, 0.1446169, 0.168881],
    [0.2627002, 0.6779981, 0.0593017],
    [0.0, 0.0280727, 1.0609851],
];
const XYZ_TO_SRGB: [[f64; 3]; 3] = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.969266, 1.8760108, 0.041556],
    [0.0556434, -0.2040259, 1.0572252],
];

const IDENTITY: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

fn multiply(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

fn apply3(m: &[[f64; 3]; 3], r: f64, g: f64, b: f64) -> [f64; 3] {
    [
        m[0][0] * r + m[0][1] * g + m[0][2] * b,
        m[1][0] * r + m[1][1] * g + m[1][2] * b,
        m[2][0] * r + m[2][1] * g + m[2][2] * b,
    ]
}

fn srgb_eotf(level: u8) -> f64 {
    let c = f64::from(level) / 255.0;
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

#[derive(Clone)]
pub struct HdrColour {
    /// Per-channel, `BINS` samples spanning render values 0 to TRUST_CEILING.
    pub curves: [Vec<f64>; 3],
    /// Applied after the curves; row-major, output channel by input channel.
    pub matrix: [[f64; 3]; 3],
    /// Blend towards luma afterwards; 1 leaves chroma alone.
    ///
    /// One number, and it has to stay one number. A curve over chroma and a gain per hue
    /// each described this camera's saturation far better - it takes a brown's chroma up
    /// 36% where it takes grass's up 8% - and both had to come out again, because a gain
    /// computed per pixel from that pixel's own colour amplifies the *variation* in that
    /// colour. Across a dog's flat fur neighbouring pixels were pulled apart into red
    /// speckles beside green ones, and a wall the camera renders flat grey came out
    /// blotchy. They improved every number this fit reports and damaged the picture,
    /// which is why the numbers are not the last word. Denoising the render first does
    /// not buy them back either: the speckle is still there at the strength the render
    /// is denoised by (§10.9).
    pub saturation: f64,
    /// Held-out mean deltaE76 over the fit pairs, for reporting.
    pub delta_e: f64,
}

/// The whole transform: what the lens did, then what the camera did to its colour.
///
/// One struct rather than three arguments because they are one thing. The colour was
/// fitted from pairs that only correspond *through* the geometry, so applying the
/// colour without the warp gives a photo the camera's colour and LibRaw's shape -
/// which is what shipped first, and it made the HDR rendition disagree with its own
/// SDR twin about where everything in the frame was. The falloff joined on the same
/// terms: the curves were fitted on a render that already carried it.
#[derive(Clone)]
pub struct HdrMatch {
    /// The SDR fit's geometry and falloff, lifted as they were fitted (10.8.1).
    pub lens: crate::fit::Lens,
    pub colour: HdrColour,
}

/// Interleaved RGB, linear, 1.0 = diffuse white.
pub struct Plane {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f64>,
}

// ------------------------------------------------------------------ the pair

/// Box average, in f64 rather than through libvips because the operations there are
/// all 8-bit sRGB: routing a scene-linear plane through them left ~57 distinct levels
/// across the whole fit domain once it was normalised, and the curve fitted from that
/// staircase was visibly contrasty. Doing both sides here also means neither gets a
/// filter the other did not.
///
/// `to_f64` converts each sample on the way in, which is what keeps the decode out of
/// this in its own right: normalising a 61MP frame to diffuse white beforehand meant a
/// 1.46GB f64 copy of it, built only to be averaged down to ~1280px on the next line.
fn resample<T: Copy + Sync>(
    src: &[T],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
    to_f64: impl Fn(T) -> f64 + Sync,
) -> Vec<f64> {
    let mut out = vec![0.0f64; dw * dh * 3];
    let xs = sw as f64 / dw as f64;
    let ys = sh as f64 / dh as f64;
    out.par_chunks_mut(dw * 3).enumerate().for_each(|(dy, out_row)| {
        let y0 = (dy as f64 * ys).floor() as usize;
        let y1 = (((dy + 1) as f64 * ys).floor() as usize).max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f64 * xs).floor() as usize;
            let x1 = (((dx + 1) as f64 * xs).floor() as usize).max(x0 + 1);
            let mut acc = [0.0f64; 3];
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * sw + x) * 3;
                    for c in 0..3 {
                        acc[c] += to_f64(src[i + c]);
                    }
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f64;
            for c in 0..3 {
                out_row[dx * 3 + c] = acc[c] / n;
            }
        }
    });
    out
}

fn blur_plane(plane: &mut Plane, radius: usize) {
    if radius < 1 {
        return;
    }
    let (w, h) = (plane.width, plane.height);
    let mut tmp = vec![0.0f64; plane.data.len()];
    for _pass in 0..3 {
        for horizontal in [true, false] {
            let (span, lines) = if horizontal { (w, h) } else { (h, w) };
            for line in 0..lines {
                for i in 0..span {
                    let lo = i.saturating_sub(radius);
                    let hi = (i + radius).min(span - 1);
                    let mut acc = [0.0f64; 3];
                    for k in lo..=hi {
                        let idx = if horizontal { line * w + k } else { k * w + line } * 3;
                        let src = if horizontal { &plane.data } else { &tmp };
                        for c in 0..3 {
                            acc[c] += src[idx + c];
                        }
                    }
                    let n = (hi - lo + 1) as f64;
                    let o = if horizontal { line * w + i } else { i * w + line } * 3;
                    let dst = if horizontal { &mut tmp } else { &mut plane.data };
                    for c in 0..3 {
                        dst[o + c] = acc[c] / n;
                    }
                }
            }
        }
    }
}

fn luma(data: &[f64], i: usize) -> f64 {
    LUMA[0] * data[i] + LUMA[1] * data[i + 1] + LUMA[2] * data[i + 2]
}

// ------------------------------------------------------------------ the mask

/// Bit c is set when channel c of this pixel is usable on its own; `ALL` when all
/// three are.
///
/// The distinction is load-bearing. A per-channel curve only needs its own channel in
/// range, and requiring all three threw away most of the samples at the top of red's
/// and green's domains: in a sky it is blue that is near clipping, so every sky pixel
/// was dropped from red's curve as well. Both curves then ran out of data well below
/// the ceiling and were extrapolated from there, which tinted the upper mid-tones
/// magenta - measured at deltaA* +5.2 in the 75-89 L* band, on pixels that sit
/// *inside* the fit domain. The matrix still wants all three, being cross-channel.
const ALL: u8 = 8;

fn mask(render: &Plane, jpeg: &Plane) -> Vec<u8> {
    let (width, height) = (render.width, render.height);
    let mut out = vec![0u8; width * height];
    if width < 3 || height < 3 {
        return out;
    }
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let p = y * width + x;
            let i = p * 3;
            // A black warp margin is not scene content.
            if render.data[i] == 0.0 && render.data[i + 1] == 0.0 && render.data[i + 2] == 0.0 {
                continue;
            }

            let mut bits = 0u8;
            for c in 0..3 {
                if jpeg.data[i + c] < CAMERA_CLIPPING && render.data[i + c] < TRUST_CEILING {
                    bits |= 1 << c;
                }
            }
            if bits == 0 {
                continue;
            }
            if bits == 0b111 {
                bits |= ALL;
            }

            // Gradient on the square root of luma rather than on linear light. A
            // fixed linear threshold is not the same test at both ends - in the
            // shadows almost nothing exceeds it and in the sky almost everything
            // does - so the surviving pixels come from the dark half of the frame
            // and the curve is fitted where it has least to say.
            let at = |dx: isize, dy: isize| -> f64 {
                let yy = (y as isize + dy) as usize;
                let xx = (x as isize + dx) as usize;
                luma(&jpeg.data, (yy * width + xx) * 3).max(0.0).sqrt()
            };
            if (at(1, 0) - at(-1, 0)).abs() + (at(0, 1) - at(0, -1)).abs() > 0.03 {
                continue;
            }
            out[p] = bits;
        }
    }
    out
}

// ------------------------------------------------------------------- the model

/// Binned mean with the gaps between bins interpolated, and the highest bin the data
/// actually reached. Above that bin the curve is undefined; `extend_curves` fills it.
///
/// The mean is weighted, so a bin answers for the levels the frame holds rather than
/// for whichever colour happens to fill it (`hue_balance`). The count floor stays on
/// the pairs themselves: a bin filled by pixels the weight discounts is thin evidence,
/// not absent evidence, and dropping it would shorten the curve.
fn fit_curve(xs: &[f64], ys: &[f64], ws: &[f64], n: usize) -> (Vec<f64>, isize) {
    let mut sum = vec![0.0f64; BINS];
    let mut weight = vec![0.0f64; BINS];
    let mut count = vec![0usize; BINS];
    for i in 0..n {
        let bin = (((xs[i] / TRUST_CEILING) * (BINS - 1) as f64).round() as isize)
            .clamp(0, BINS as isize - 1) as usize;
        sum[bin] += ys[i] * ws[i];
        weight[bin] += ws[i];
        count[bin] += 1;
    }

    let mut curve = vec![0.0f64; BINS];
    let mut last: isize = -1;
    for b in 0..BINS {
        if count[b] < MIN_BIN_SAMPLES || !(weight[b] > 0.0) {
            continue;
        }
        let value = sum[b] / weight[b];
        if last < 0 {
            for k in 0..=b {
                curve[k] = value * (k as f64 / (b.max(1)) as f64);
            }
        } else {
            let lastu = last as usize;
            for k in lastu + 1..=b {
                curve[k] = curve[lastu] + (value - curve[lastu]) * (k - lastu) as f64 / (b - lastu) as f64;
            }
        }
        curve[b] = value;
        last = b as isize;
    }
    (curve, last)
}

fn make_monotone(curve: &mut [f64]) {
    for b in 1..BINS {
        if curve[b] < curve[b - 1] {
            curve[b] = curve[b - 1];
        }
    }
}

/// Extends a curve past its data at the slope it ended on.
fn extend_alone(curve: &mut [f64], last: usize) {
    let back = last.saturating_sub(16);
    let slope = if last > back {
        (curve[last] - curve[back]) / ((last - back) as f64 / (BINS - 1) as f64)
    } else {
        1.0
    };
    for b in last + 1..BINS {
        curve[b] = curve[last] + slope * (b - last) as f64 / (BINS - 1) as f64;
    }
    make_monotone(curve);
}

/// Bins of overlap the gain between two channels is read over.
///
/// Not the join bin alone, which is the least trustworthy sample the channel has: it is
/// the bin that only just cleared `MIN_BIN_SAMPLES`, so it is the thinnest average in
/// the curve, and a ratio read there is carried over the whole tail. Averaged over the
/// last 16 bins the extension landed within 1.9-2.1% of the channel's own curve on a
/// replay that truncated it at render 0.18, against 3.2-4.0% from the join bin alone.
const JOIN_WINDOW: usize = 16;

/// The gain a channel ran at against the reference where both had pairs, and where its
/// extension would land holding that gain to the top of the domain.
///
/// None when the overlap says nothing, which leaves the channel to `extend_alone`.
fn join(curve: &[f64], last: usize, reference: &[f64]) -> Option<(f64, f64)> {
    let window = last.saturating_sub(JOIN_WINDOW)..=last;
    let ours: f64 = curve[window.clone()].iter().sum();
    let theirs: f64 = reference[window].iter().sum();
    if !(theirs > 0.0) {
        return None;
    }
    let gain = ours / theirs;
    Some((gain, curve[last] + (reference[BINS - 1] - reference[last]) * gain))
}

/// Fills a channel's tail: the reference's shape at the channel's own gain near the
/// join, converging on `top` - the one level every channel ends at - by the ceiling.
///
/// The reference's *steps* rather than its levels, so the extension leaves the join
/// where the channel's own data left it: anchoring on the gain instead lands the first
/// extended bin off its neighbour, and `make_monotone` turns that into a flat band of
/// crushed contrast right where the tail starts.
///
/// Converging is what makes a neutral highlight neutral. A frame's brightest region is
/// where the fit has least to go on - on DSC05469 the sky is clipped in the sensor to
/// exactly neutral and rendered by the camera as exactly neutral - and three curves
/// each holding their own gain up there is what turned that neutral green. Converged, a
/// neutral render value maps to one number whatever channel it arrived in, while a
/// pixel whose channels differ keeps every bit of that difference: it is the input that
/// carries the colour, not the curve.
///
/// `top` must be at or above every channel's held extension, and that is not a detail.
/// Let it sit below one and that channel has to *fall* to reach it, `make_monotone`
/// clamps the fall flat, and the channel ends at its own level with the others at the
/// reference's - the per-channel gain this exists to remove, reintroduced by the guard
/// against a curve that dips. Measured on DSC05469 before that: a sky reading neutral
/// off a full decode came out 13% red off a bounded one, the two decodes disagreeing
/// about which channel reached furthest.
fn extend_onto(curve: &mut [f64], last: usize, reference: &[f64], gain: f64, top: f64) {
    let span = (BINS - 1 - last).max(1) as f64;
    let climb = reference[BINS - 1] - reference[last];
    for b in last + 1..BINS {
        let held = curve[last] + (reference[b] - reference[last]) * gain;
        // The same shape taken all the way to the shared top, which is where the two
        // agree by the ceiling however far apart they start.
        let shared = match climb > 0.0 {
            true => curve[last] + (top - curve[last]) * ((reference[b] - reference[last]) / climb),
            false => top,
        };
        let converged = (b - last) as f64 / span;
        curve[b] = held * (1.0 - converged) + shared * converged;
    }
    make_monotone(curve);
}

/// Fills in each channel above the point its pairs ran out, off the channel that got
/// furthest.
///
/// Every channel extending on its own last slope is what turned this frame's sky green
/// (DSC05469), and where each one stops is close to arbitrary. That frame is bimodal:
/// 114K of its pairs sit below render 0.2, its sky sits above 0.9 and is blown in the
/// JPEG so the mask drops it for all three channels alike, and the stretch between
/// holds a few hundred pairs per tenth, most of them rejected for lying on a gradient.
/// Whether a channel's last filled bin lands at 0.18 or 0.66 is then decided by which
/// side of `MIN_BIN_SAMPLES` a hundred-odd surviving pixels fall - red kept 113 in the
/// 0.6-0.7 band where green kept 13. Three straight lines from three arbitrary places
/// diverge, and by diffuse white green was reading 2.19 against red's 1.15: a cast that
/// grows with brightness, on pixels well inside the trusted domain.
///
/// The channels agree on shape wherever they overlap - within about 5% across the
/// domain on the fixture - which is what makes borrowing it sound: what a short channel
/// is missing is reach, not a rendering of its own. Only above its own last bin, so a
/// channel keeps every pair it measured.
fn extend_curves(mut fitted: [(Vec<f64>, isize); 3]) -> [Vec<f64>; 3] {
    let furthest = (0..3).max_by_key(|c| fitted[*c].1).unwrap_or(0);
    let Ok(last) = usize::try_from(fitted[furthest].1) else {
        // No channel had a single filled bin; every curve is still zeroes.
        return fitted.map(|(curve, _)| curve);
    };
    extend_alone(&mut fitted[furthest].0, last);
    let reference = fitted[furthest].0.clone();

    // Where each channel would land holding its own gain to the ceiling, and then the
    // one level they all end on: the highest of them, so that reaching it is a climb
    // for every channel and a fall for none.
    let held: [Option<(f64, f64)>; 3] = std::array::from_fn(|c| {
        usize::try_from(fitted[c].1).ok().and_then(|last| join(&fitted[c].0, last, &reference))
    });
    let top = held
        .iter()
        .flatten()
        .map(|(_, top)| *top)
        .fold(reference[BINS - 1], f64::max);

    // The reference goes through this too, so all three end on one level rather than
    // two of them converging on a curve the third never adopted.
    for c in 0..3 {
        let Ok(last) = usize::try_from(fitted[c].1) else { continue };
        match held[c] {
            Some((gain, _)) => extend_onto(&mut fitted[c].0, last, &reference, gain, top),
            None => extend_alone(&mut fitted[c].0, last),
        }
    }
    fitted.map(|(curve, _)| curve)
}

fn sample_curve(curve: &[f64], x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    let t = ((x / TRUST_CEILING) * (BINS - 1) as f64).min((BINS - 1) as f64);
    let lo = t.floor() as usize;
    if lo >= BINS - 1 {
        return curve[BINS - 1];
    }
    curve[lo] * (1.0 - (t - lo as f64)) + curve[lo + 1] * (t - lo as f64)
}

/// The tone stage: the camera's per-channel rendering below diffuse white, and one
/// shared gain above it.
///
/// Above the ceiling the whole pixel is scaled down until its brightest channel sits
/// at the top of the fit domain, read there, and scaled back up by the same factor.
/// So a bright orange keeps the camera's orange and only gets brighter.
///
/// Letting each channel run on its own extrapolation instead is what tinted the sky
/// magenta: the three end slopes came out 0.435 / 0.206 / 0.336, so red and blue
/// climbed at twice green's rate and the drift grew with brightness.
pub fn tone(colour: &HdrColour, r: f64, g: f64, b: f64) -> [f64; 3] {
    let s = (r.max(g).max(b) / TRUST_CEILING).max(1.0);
    [
        sample_curve(&colour.curves[0], r / s) * s,
        sample_curve(&colour.curves[1], g / s) * s,
        sample_curve(&colour.curves[2], b / s) * s,
    ]
}

/// The tone stage for one channel, valid only while every channel of the pixel is
/// below the ceiling - which is where the shared gain is 1 and the stage is
/// separable. That is almost every pixel, so a caller grading a 60MP frame builds a
/// lookup from this and takes the general path only for the highlights.
pub fn tone_channel(colour: &HdrColour, channel: usize, x: f64) -> f64 {
    sample_curve(&colour.curves[channel], x)
}

/// Everything after the tone stage: the matrix, then the chroma blend.
pub fn finish_colour(colour: &HdrColour, r: f64, g: f64, b: f64) -> [f64; 3] {
    let m = apply3(&colour.matrix, r, g, b);
    if colour.saturation == 1.0 {
        return m;
    }
    let l = LUMA[0] * m[0] + LUMA[1] * m[1] + LUMA[2] * m[2];
    [
        l + (m[0] - l) * colour.saturation,
        l + (m[1] - l) * colour.saturation,
        l + (m[2] - l) * colour.saturation,
    ]
}

pub fn apply_hdr_colour(colour: &HdrColour, r: f64, g: f64, b: f64) -> [f64; 3] {
    let v = tone(colour, r, g, b);
    finish_colour(colour, v[0], v[1], v[2])
}

/// One matrix row, least squares subject to its three terms summing to one.
///
/// The constraint enters as a Lagrange multiplier, which makes it a 4x4 solve on the
/// bordered system: `ata` with a row and column of ones, and the multiplier last.
fn neutral_row(ata: &[[f64; 3]; 3], rhs: &[f64; 3]) -> Option<[f64; 3]> {
    let mut m = [[0.0f64; 5]; 4];
    for i in 0..3 {
        m[i][..3].copy_from_slice(&ata[i]);
        m[i][3] = 1.0;
        m[i][4] = rhs[i];
    }
    m[3] = [1.0, 1.0, 1.0, 0.0, 1.0];

    for col in 0..4 {
        let pivot = (col..4).max_by(|a, b| m[*a][col].abs().total_cmp(&m[*b][col].abs()))?;
        m.swap(col, pivot);
        if m[col][col].abs() < 1e-12 {
            return None;
        }
        for row in 0..4 {
            if row == col {
                continue;
            }
            let factor = m[row][col] / m[col][col];
            for k in col..5 {
                m[row][k] -= factor * m[col][k];
            }
        }
    }
    Some([m[0][4] / m[0][0], m[1][4] / m[1][1], m[2][4] / m[2][2]])
}

/// Gauss-Jordan on a 3x3, returning None rather than garbage when singular.
fn solve_row(matrix: &[[f64; 3]; 3], rhs: &[f64; 3]) -> Option<[f64; 3]> {
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
        if m[col][col].abs() < 1e-12 {
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

/// deltaE76 wants 8-bit sRGB, which is also the only space the two fits report in
/// comparably. Values above diffuse white have nowhere to go in it, but the mask has
/// already excluded those.
/// Rec.2020 linear to sRGB linear - the primaries conversion, and nothing else.
///
/// A fixed 3x3, because the two share a white point and so there is no chromatic
/// adaptation in it. This is what `zscale`'s `pin=bt2020 ... p=bt709` was doing for the
/// SDR still (sRGB and BT.709 have the same primaries and differ only in transfer), and
/// it is here rather than there so the still's encode can stay in this process.
///
/// Returned rather than applied, so a caller converting a whole frame builds it once:
/// this used to be multiplied out per pixel inside the fit's measurement loop.
pub fn rec2020_to_srgb() -> [[f64; 3]; 3] {
    multiply(&XYZ_TO_SRGB, &REC2020_TO_XYZ)
}

/// The sRGB transfer, IEC 61966-2-1. Out-of-gamut values clamp, which is what zimg does
/// with them too - neither of us is gamut-mapping, just refusing to encode a negative.
pub fn srgb_oetf(value: f64) -> f64 {
    let c = value.clamp(0.0, 1.0);
    if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

fn to_srgb8(to_srgb: &[[f64; 3]; 3], r: f64, g: f64, b: f64) -> [f64; 3] {
    // Back to sRGB primaries first; the fit works in Rec.2020.
    let v = apply3(to_srgb, r, g, b);
    [0, 1, 2].map(|c| (255.0 * srgb_oetf(v[c])).round())
}

/// The camera's rendering as the fit will compare against it, and the weights and pair
/// list every comparison uses, worked out once.
///
/// The fit measures itself about seventy times over - six ridge candidates at each of
/// three rounds, then the saturation sweep and its refinement, for each of the two
/// models - and none of this changes between them. Recomputed inside the loop it was
/// most of the cost of the fit: the sRGB target
/// alone is three `powf`s per pixel, and `rec2020_to_srgb` was being rebuilt, a pair of
/// 3x3 multiplies, once per pixel per pass.
struct Pairs {
    at: Vec<usize>,
    target: Vec<[f64; 3]>,
    balance: Vec<f64>,
    to_srgb: [[f64; 3]; 3],
    /// The pairs the camera renders neutral, and what it renders them as. Which pixels
    /// those are is a fact about the camera's output, so it does not change as the fit
    /// moves underneath it, and neither does the sum being matched.
    greys: Vec<usize>,
    grey_target: [f64; 3],
}

impl Pairs {
    fn new(jpeg: &Plane, bits: &[u8], balance: &[f64]) -> Pairs {
        let to_srgb = rec2020_to_srgb();
        let at: Vec<usize> = (0..bits.len()).filter(|p| bits[*p] & ALL != 0).collect();

        let mut greys = Vec::new();
        let mut grey_target = [0.0f64; 3];
        for p in at.iter().copied() {
            let i = p * 3;
            let t = [jpeg.data[i], jpeg.data[i + 1], jpeg.data[i + 2]];
            let high = t[0].max(t[1]).max(t[2]);
            if !(high > 0.02) || (high - t[0].min(t[1]).min(t[2])) / high >= GREY_CHROMA {
                continue;
            }
            greys.push(p);
            for c in 0..3 {
                grey_target[c] += t[c];
            }
        }

        Pairs {
            target: at
                .iter()
                .map(|p| to_srgb8(&to_srgb, jpeg.data[p * 3], jpeg.data[p * 3 + 1], jpeg.data[p * 3 + 2]))
                .collect(),
            balance: at.iter().map(|p| balance[*p]).collect(),
            at,
            to_srgb,
            greys,
            grey_target,
        }
    }
}

/// The mean deltaE over the pairs, hue-balanced and flat.
///
/// Both, because the two answer different questions - what the camera does, and what
/// the picture will look like - the stages here disagree about which one they are
/// asking, and the one that wants both wants them for the same matrix. Separately it
/// was two passes to save one multiply-add.
fn measure(colour: &HdrColour, render: &Plane, pairs: &Pairs) -> (f64, f64) {
    // Fixed blocks summed in order, not a `reduce`. Floating point addition is not
    // associative, so a reduction whose tree depends on how rayon happened to schedule
    // the work gives a different fit from one run to the next, and the graded output is
    // pinned by hash. This way the arithmetic is the same every time and only who
    // performs it varies.
    let partial: Vec<(f64, f64, f64)> = pairs
        .at
        .par_chunks(MEASURE_BLOCK)
        .enumerate()
        .map(|(block, chunk)| {
            let mut sums = (0.0, 0.0, 0.0f64);
            for (offset, p) in chunk.iter().enumerate() {
                let k = block * MEASURE_BLOCK + offset;
                let i = p * 3;
                let v = apply_hdr_colour(colour, render.data[i], render.data[i + 1], render.data[i + 2]);
                let a = to_srgb8(&pairs.to_srgb, v[0], v[1], v[2]);
                let e = crate::fit::delta_e76(&a, &pairs.target[k]);
                sums.0 += pairs.balance[k] * e;
                sums.1 += e;
                sums.2 += pairs.balance[k];
            }
            sums
        })
        .collect();

    let (mut balanced, mut flat, mut n) = (0.0, 0.0, 0.0f64);
    for (a, b, w) in partial {
        balanced += a;
        flat += b;
        n += w;
    }
    (balanced / n.max(1e-9), flat / (pairs.at.len() as f64).max(1.0))
}

/// Pixels per block, here and in `drift`. Large enough that the per-block overhead is
/// nothing beside the work, small enough to keep every core fed on a small frame.
const MEASURE_BLOCK: usize = 4096;

/// The chromaticity grid and the levels within it that `drift` compares across, and the
/// counts below which a cell or a hue has too little in it to average.
const DRIFT_STEPS: usize = 12;
const DRIFT_LEVELS: usize = 8;
const DRIFT_MIN_CELL: u32 = 200;
const DRIFT_MIN_HUE: u32 = 2000;

/// How far the transform's colour moves with level, within one of the frame's own hues.
///
/// One material should come out the same colour in its shadows as in its highlights. The
/// curves are fitted a channel at a time from whatever content sits at each level, so a
/// frame that samples its green channel from different objects than its red lands them
/// apart level by level and that stops being true - the pale fur on IMG_8789's dogs goes
/// green while the dark fur does not. A mean deltaE cannot see it, because the error
/// averages out across levels; this is here so something can.
///
/// Per hue, so a frame merely containing dark blue and bright yellow does not read as
/// drift, and against green, so a difference in overall exposure drops out and only the
/// colour is left.
///
/// Over every pixel with something to say - the camera not clipping it, the render not
/// black there, and enough light in it to have a colour at all - rather than over the
/// pairs the fit was made from. The fit's mask drops anything the render puts above
/// `TRUST_CEILING`,
/// which is every sunlit surface in a frame, and those are where curves left free go
/// furthest wrong - `extend_curves` is extrapolating there and the shared gain in
/// `tone` is running.
///
/// Scene-linear, before the grade. The grade's roll-off runs per channel and so does
/// move colour with level, but it was tried here and moved the two frames this decides
/// between by 0.001 and by nothing at all: on a plane this size, blurred, the 0.9999
/// quantile holds no speculars, so the knee it computes never engages.
fn drift(colour: &HdrColour, render: &Plane, jpeg: &Plane) -> f64 {
    const CELLS: usize = DRIFT_STEPS * DRIFT_STEPS * DRIFT_LEVELS;
    // Blocked and summed in order, for the reason `measure` is.
    let pixels = jpeg.data.len() / 3;
    let blocks: Vec<(Vec<[f64; 3]>, Vec<u32>)> = (0..pixels.div_ceil(MEASURE_BLOCK))
        .into_par_iter()
        .map(|block| {
            let start = block * MEASURE_BLOCK;
            let mut sums = vec![[0.0f64; 3]; CELLS];
            let mut counts = vec![0u32; CELLS];
            let span = start..(start + MEASURE_BLOCK).min(pixels);
            drift_block(span, colour, render, jpeg, &mut sums, &mut counts);
            (sums, counts)
        })
        .collect();

    let mut sums = vec![[0.0f64; 3]; CELLS];
    let mut counts = vec![0u32; CELLS];
    for (block_sums, block_counts) in blocks {
        for cell in 0..CELLS {
            for c in 0..3 {
                sums[cell][c] += block_sums[cell][c];
            }
            counts[cell] += block_counts[cell];
        }
    }

    drift_of(&sums, &counts)
}

fn drift_block(
    span: std::ops::Range<usize>,
    colour: &HdrColour,
    render: &Plane,
    jpeg: &Plane,
    sums: &mut [[f64; 3]],
    counts: &mut [u32],
) {
    for p in span {
        let i = p * 3;
        let t = [jpeg.data[i], jpeg.data[i + 1], jpeg.data[i + 2]];
        if t[0].max(t[1]).max(t[2]) >= CAMERA_CLIPPING {
            continue;
        }
        if render.data[i] == 0.0 && render.data[i + 1] == 0.0 && render.data[i + 2] == 0.0 {
            continue;
        }
        let total = t[0] + t[1] + t[2];
        let their_l = luma(&t, 0);
        if total <= 1e-6 || their_l <= 0.004 {
            continue;
        }
        let v = apply_hdr_colour(colour, render.data[i], render.data[i + 1], render.data[i + 2]);
        if v[0] + v[1] + v[2] <= 1e-6 {
            continue;
        }

        let axis = |c: usize| ((t[c] / total) * DRIFT_STEPS as f64) as usize;
        let hue = axis(0).min(DRIFT_STEPS - 1) * DRIFT_STEPS + axis(1).min(DRIFT_STEPS - 1);
        let level = ((their_l.cbrt() * DRIFT_LEVELS as f64) as usize).min(DRIFT_LEVELS - 1);
        let cell = hue * DRIFT_LEVELS + level;
        for c in 0..3 {
            sums[cell][c] += (v[c].max(1e-9) / t[c].max(1e-6)).ln();
        }
        counts[cell] += 1;
    }
}

/// The spread across levels within each hue, weighted by how much of the frame that hue
/// is, from the cells `drift_block` filled.
fn drift_of(sums: &[[f64; 3]], counts: &[u32]) -> f64 {
    let (mut spread, mut weight) = (0.0, 0.0);
    for hue in 0..DRIFT_STEPS * DRIFT_STEPS {
        let cells = &counts[hue * DRIFT_LEVELS..(hue + 1) * DRIFT_LEVELS];
        let here: u32 = cells.iter().sum();
        if here < DRIFT_MIN_HUE {
            continue;
        }
        let mut range = [(f64::MAX, f64::MIN); 2];
        let mut levels = 0;
        for level in 0..DRIFT_LEVELS {
            if cells[level] < DRIFT_MIN_CELL {
                continue;
            }
            levels += 1;
            let cell = &sums[hue * DRIFT_LEVELS + level];
            let n = f64::from(cells[level]);
            for (axis, channel) in [0usize, 2].into_iter().enumerate() {
                let v = (cell[channel] - cell[1]) / n;
                range[axis] = (range[axis].0.min(v), range[axis].1.max(v));
            }
        }
        // A hue the frame only ever shows at one brightness has no levels to differ
        // between, so it says nothing about drift either way.
        if levels < 3 {
            continue;
        }
        spread += f64::from(here) * (range[0].1 - range[0].0 + range[1].1 - range[1].0) / 2.0;
        weight += f64::from(here);
    }
    if weight > 0.0 { spread / weight } else { 0.0 }
}

/// Hues the frame is divided into before its pairs are counted, plus one bucket for
/// everything too close to grey to have a hue at all.
const HUE_BINS: usize = 12;

/// How far a bin's weight may be pushed from parity, either way.
///
/// Balancing without a bound hands a frame's rarest few pixels the whole fit: forty
/// magenta pixels against forty thousand green ones would each count for a thousand,
/// and a fit driven by forty pixels is noise. Bounded, a dominant hue loses most of its
/// advantage while a rare one cannot take over.
///
/// Measured on IMG_8789: raising it to 8, 16 or 64 moves the fit by 0.1 of a level,
/// because the dominant bin is already at the cap and what is left is not the
/// weighting's to fix.
const BALANCE_LIMIT: f64 = 4.0;

/// Everything a weighted least squares needs from a set of pairs, and nothing that
/// scales with how many there were.
#[derive(Default, Clone)]
struct Moments {
    ata: [[f64; 3]; 3],
    atb: [[f64; 3]; 3],
}

impl Moments {
    fn add(&mut self, w: f64, v: &[f64; 3], y: &[f64]) {
        for a in 0..3 {
            for b in 0..3 {
                self.ata[a][b] += w * v[a] * v[b];
            }
            for o in 0..3 {
                self.atb[o][a] += w * v[a] * y[o];
            }
        }
    }

    fn trace(&self) -> f64 {
        self.ata[0][0] + self.ata[1][1] + self.ata[2][2]
    }

    /// The matrix this set asks for, damped by `ridge` towards the identity, and held
    /// to leaving a neutral neutral.
    ///
    /// Each row is solved subject to summing to one, so `(x, x, x)` maps to `(x, x, x)`
    /// however large the off-diagonals grow. That is the constraint the ridge was
    /// standing in for and the one it could not express: what a wild matrix actually
    /// does is tint the greys - and worst of all above the fit domain, where the
    /// highlights are extrapolated and no pair is there to object. Constrained, the
    /// cross-channel freedom a brown needs costs a grey nothing.
    fn solve(&self, ridge: f64) -> [[f64; 3]; 3] {
        let mut ata = self.ata;
        let mut atb = self.atb;
        let scale = self.trace();
        for i in 0..3 {
            ata[i][i] += ridge * scale;
            atb[i][i] += ridge * scale;
        }
        std::array::from_fn(|o| {
            neutral_row(&ata, &atb[o]).or_else(|| solve_row(&ata, &atb[o])).unwrap_or(IDENTITY[o])
        })
    }
}

/// The ridges tried, log-spaced around the fixed one this replaced, most damped first
/// so that a frame which cannot choose between them keeps the safe end.
const RIDGE_CANDIDATES: [f64; 6] = [0.15, 0.05, 0.02, 0.008, 0.002, 0.0005];

/// How much worse a candidate may leave the frame as a whole, against the best any
/// candidate manages, before its damping is refused however well it serves a subject.
///
/// This is the veto that stops "serve the minority hue" becoming "wreck the picture".
/// IMG_9808 is why it exists: sky and snow, no colour spread anywhere in it to pin nine
/// parameters down, and the least damped candidate came back with a row of
/// `[-0.285, -0.334, 1.619]` against `[-0.027, -0.015, 1.019]` damped. Weighted by hue
/// that matrix looks like an improvement - it is serving the frame's few coloured pixels
/// - while the hillside renders acid yellow-green and the frame's own deltaE doubles.
const FRAME_VETO: f64 = 1.03;

/// The matrix, at the least damping this frame can support.
///
/// A fixed ridge cannot serve both ends of what arrives here. Damping exists because a
/// frame whose colours all sit near the grey axis cannot constrain nine free parameters;
/// but held at the value such a frame needs, a frame that *can* constrain one does not
/// get it - IMG_8789 has saturated grass and saturated browns, its camera scales green
/// by 0.884 on the one and 0.690 on the other, only the off-diagonals can say that, and
/// damped to near-identity they cannot. The dogs come out olive however the pairs are
/// weighted.
///
/// So the frame chooses, on two scores rather than one. Which candidate is *best* is
/// asked with the same hue balance the fit uses, because that is the question the
/// balance exists to ask - an even score lets 120k pairs of lawn outvote 16k of dog and
/// picks the ridge that suits grass. Which candidates are *allowed* is asked evenly,
/// because that question is about the whole picture and a picture is seen by area.
///
/// The residual the solve itself minimises was tried for this and is close to useless:
/// it is the quantity every candidate is optimising, in a space where a wild matrix
/// looks fine, and on a near-neutral frame all of them score it identically to the last
/// bit so the choice fell to list order.
fn fitted_matrix(
    whole: &Moments,
    scored: impl Fn(&[[f64; 3]; 3]) -> (f64, f64),
) -> [[f64; 3]; 3] {
    if !(whole.trace() > 0.0) {
        return whole.solve(MATRIX_RIDGE);
    }
    let tried: Vec<([[f64; 3]; 3], f64, f64)> = RIDGE_CANDIDATES
        .iter()
        .map(|ridge| {
            let matrix = whole.solve(*ridge);
            let (balanced, evenly) = scored(&matrix);
            (matrix, balanced, evenly)
        })
        .collect();

    let floor = tried.iter().map(|(_, _, even)| *even).fold(f64::MAX, f64::min);
    let mut best: Option<(&[[f64; 3]; 3], f64)> = None;
    for (matrix, balanced_score, even_score) in &tried {
        if *even_score > floor * FRAME_VETO {
            continue;
        }
        // Strictly better, and the candidates run most damped first, so a frame that
        // cannot tell them apart keeps the safe end rather than whichever came first.
        if best.is_none_or(|(_, score)| *balanced_score < score) {
            best = Some((matrix, *balanced_score));
        }
    }
    *best.map_or(&tried[0].0, |(matrix, _)| matrix)
}

fn hue_bucket(jpeg: &Plane, i: usize) -> usize {
    let (r, g, b) = (jpeg.data[i], jpeg.data[i + 1], jpeg.data[i + 2]);
    let (high, low) = (r.max(g).max(b), r.min(g).min(b));
    if !(high > 0.0) || (high - low) / high < 0.1 {
        return HUE_BINS;
    }
    // Sixths of the hue circle, subdivided: enough to separate foliage from skin from
    // sky, few enough that a bin holds a real population.
    let span = high - low;
    let sixth = if r >= g && r >= b {
        (g - b) / span
    } else if g >= b {
        2.0 + (b - r) / span
    } else {
        4.0 + (r - g) / span
    };
    let turns = (sixth + 6.0) % 6.0 / 6.0;
    ((turns * HUE_BINS as f64) as usize).min(HUE_BINS - 1)
}

/// How much each pair counts, so that what a frame is *of* does not decide what the
/// camera is taken to do.
///
/// The fit minimises error over every pair equally, so a frame that is mostly one
/// colour is fitted to that colour: on IMG_8789, a lawn, the fit lands within ΔE 2.96
/// of the camera and still renders the two brown dogs olive, because the dogs are a
/// small enough share of the pairs that their error costs it almost nothing. The
/// held-out ΔE cannot see it either - 2.961 against 2.995 across settings that move the
/// dogs by three levels - which is why this went unnoticed while the number looked fine.
///
/// So a pair counts for the reciprocal of how common its hue is. The grass still shapes
/// the fit where the fit is about grass; it no longer shapes what happens to a dog.
/// Hue is taken from the camera's rendering rather than the render, since that is the
/// thing being matched, and low-chroma pixels share one bucket because a hue angle
/// measured on a grey is noise.
fn hue_balance(jpeg: &Plane, bits: &[u8]) -> Vec<f64> {
    let bucket = |i: usize| hue_bucket(jpeg, i);

    let mut counted = vec![0usize; HUE_BINS + 1];
    let mut total = 0usize;
    for p in 0..bits.len() {
        if bits[p] & ALL == 0 {
            continue;
        }
        counted[bucket(p * 3)] += 1;
        total += 1;
    }

    let occupied = counted.iter().filter(|n| **n > 0).count().max(1);
    let parity = total as f64 / occupied as f64;
    let weights: Vec<f64> = counted
        .iter()
        .map(|n| match *n {
            // Counted over pairs usable for all three channels, but read back per
            // channel by `fit_curves`, where a pixel needs only its own channel in
            // range. A hue that shows up only on such pixels is censused at zero, and
            // weighting it zero drops it from that channel's curve entirely rather than
            // merely declining to favour it - which is the opposite of what the
            // per-channel mask is for. Unseen means unknown here, so it counts as one.
            0 => 1.0,
            n => (parity / n as f64).clamp(1.0 / BALANCE_LIMIT, BALANCE_LIMIT),
        })
        .collect();

    (0..bits.len()).map(|p| weights[bucket(p * 3)]).collect()
}

/// How many times the curves and the matrix are fitted against each other.
///
/// Three, matching the falloff's alternation in `fit.rs`: the second round is where the
/// cross-channel part moves out of the curves and into the matrix, and the third
/// settles it.
const FIT_ROUNDS: usize = 3;

/// The three per-channel curves.
///
/// `inverse` undoes the matrix from the camera's rendering first, so what the curves
/// are asked to reproduce is only the part a per-channel curve can: on the first round
/// there is no matrix yet and the target is the rendering itself.
fn fit_curves(
    render: &Plane,
    jpeg: &Plane,
    bits: &[u8],
    balance: &[f64],
    inverse: Option<&[[f64; 3]; 3]>,
    hold: bool,
) -> [Vec<f64>; 3] {
    let target = |i: usize| -> [f64; 3] {
        let v = [jpeg.data[i], jpeg.data[i + 1], jpeg.data[i + 2]];
        match inverse {
            None => v,
            // Clamped, because inverting a matrix out of a colour near the edge of what
            // the camera can print can ask for a negative amount of a channel.
            Some(m) => apply3(m, v[0], v[1], v[2]).map(|c| c.max(0.0)),
        }
    };

    let mut fitted: [(Vec<f64>, isize); 3] = std::array::from_fn(|c| {
        let mut xs = vec![0.0f64; bits.len()];
        let mut ys = vec![0.0f64; bits.len()];
        let mut ws = vec![0.0f64; bits.len()];
        let mut k = 0usize;
        for p in 0..bits.len() {
            if bits[p] & (1 << c) == 0 {
                continue;
            }
            xs[k] = render.data[p * 3 + c];
            ys[k] = target(p * 3)[c];
            ws[k] = balance[p];
            k += 1;
        }
        fit_curve(&xs, &ys, &ws, k)
    });
    if hold {
        hold_one_shape(&mut fitted);
    }
    extend_curves(fitted)
}

/// Holds the three curves to one shape, differing only by a gain each.
///
/// Fitted freely, the ratios between the channels wander with level, and that wander is
/// a hue that changes with brightness. On IMG_8789 green ran 15% above red through the
/// mid-tones and came back to level at both ends - so a white bird bath was neutral
/// where the sun hit it and mint green down its shaded side and around its shaded top,
/// the same green on the shaded fur and on the lit edge of the brick. The grey balance
/// cannot see it: the hump averages out against the ends, so the neutral axis reads
/// correct while every neutral at the wrong level is green.
///
/// The wander is not the camera. Measured on that frame's own greys, this camera holds
/// green to red within 1% at every level from the shadows to the highlights. It is our
/// own fit: each curve is estimated from whatever the frame holds at each level, and at
/// the levels a garden's mid-tones occupy that is foliage, which pulls green's curve up
/// where nothing pulls red's.
///
/// A camera's per-channel rendering does differ in shape as well as in gain, but not by
/// anything this can measure from one frame against content that biased. What it can
/// measure is the gain - that is what the greys are for - so the curves are held to one
/// shape and left to differ by that alone. A subject then keeps its hue across its own
/// shading, which is the thing that was actually wrong.
fn hold_one_shape(fitted: &mut [(Vec<f64>, isize); 3]) {
    let Ok(measured) = usize::try_from(fitted.iter().map(|(_, last)| *last).min().unwrap_or(-1))
    else {
        return;
    };

    // Only where all three have something to say. Above the first of them to run out,
    // a curve still holding zeroes would drag the mean down and overwrite the data the
    // channels that *did* reach there measured - `extend_curves` owns that stretch.
    let shared: Vec<f64> = (0..=measured)
        .map(|b| (0..3).map(|c| fitted[c].0[b]).sum::<f64>() / 3.0)
        .collect();

    for c in 0..3 {
        let (mut top, mut bottom) = (0.0, 0.0);
        for b in 0..=measured {
            top += fitted[c].0[b] * shared[b];
            bottom += shared[b] * shared[b];
        }
        let gain = match bottom > 0.0 {
            true => top / bottom,
            false => 1.0,
        };

        // What the join moves by, so a channel that reaches further carries its own
        // measurements up from where the shared shape leaves off rather than stepping.
        let joined = match fitted[c].0[measured] > 1e-12 {
            true => shared[measured] * gain / fitted[c].0[measured],
            false => 1.0,
        };
        for b in 0..=measured {
            fitted[c].0[b] = shared[b] * gain;
        }
        for b in measured + 1..BINS {
            fitted[c].0[b] *= joined;
        }
    }
}

/// How close to grey the camera has to render a pixel for it to count as neutral, and
/// how many such pixels are needed before their average is worth acting on.
const GREY_CHROMA: f64 = 0.06;
const MIN_GREY: u64 = 200;

/// Pulls the transform's neutral axis onto the camera's.
///
/// Nothing else in the model can. The matrix's rows sum to one, so it maps a grey to a
/// grey and cannot move one that arrives already tinted; the chroma curve scales chroma
/// about the luma axis, which is a no-op on a grey. That leaves the three tone curves,
/// and they are fitted one channel at a time from whatever content sits at each level -
/// nothing ties them to each other, so a frame whose green channel is sampled from
/// different objects than its red lands them apart and every grey in the picture picks
/// up the difference. On IMG_8789 that was +2.3% green on the pixels the camera renders
/// neutral, which is the wash across the whites and the dogs' pale fur.
///
/// So the frame's own greys say what the gains should be, and the curves are scaled to
/// meet them. Bounded, because a frame with few greys should nudge this rather than
/// swing it, and skipped entirely where there are too few to average.
fn grey_balance(colour: &mut HdrColour, render: &Plane, pairs: &Pairs) {
    if (pairs.greys.len() as u64) < MIN_GREY {
        return;
    }
    let mut ours = [0.0f64; 3];
    for p in pairs.greys.iter().copied() {
        let i = p * 3;
        let v = apply_hdr_colour(colour, render.data[i], render.data[i + 1], render.data[i + 2]);
        for c in 0..3 {
            ours[c] += v[c];
        }
    }
    for c in 0..3 {
        let gain = (pairs.grey_target[c] / ours[c].max(1e-9)).clamp(0.9, 1.1);
        for level in colour.curves[c].iter_mut() {
            *level *= gain;
        }
    }
}

/// The matrix for the tone stage a colour currently carries.
fn fitted_matrix_for(
    colour: &HdrColour,
    render: &Plane,
    jpeg: &Plane,
    balance: &[f64],
    pairs: &Pairs,
) -> [[f64; 3]; 3] {
    // Blocked and summed in order, for the reason `measure` is.
    let blocks: Vec<Moments> = pairs
        .at
        .par_chunks(MEASURE_BLOCK)
        .map(|chunk| {
            let mut moments = Moments::default();
            for p in chunk.iter().copied() {
                let i = p * 3;
                let v = tone(colour, render.data[i], render.data[i + 1], render.data[i + 2]);
                let w = balance[p] / (luma(&jpeg.data, i).cbrt().powi(2) + 1e-3);
                moments.add(w, &v, &jpeg.data[i..i + 3]);
            }
            moments
        })
        .collect();

    let mut moments = Moments::default();
    for block in &blocks {
        for a in 0..3 {
            for b in 0..3 {
                moments.ata[a][b] += block.ata[a][b];
                moments.atb[a][b] += block.atb[a][b];
            }
        }
    }

    fitted_matrix(&moments, |matrix| {
        measure(&HdrColour { matrix: *matrix, ..colour.clone() }, render, pairs)
    })
}

/// A 3x3 inverse, by solving the matrix against each basis vector. None when singular.
fn invert3(m: &[[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let columns: [[f64; 3]; 3] = [
        solve_row(m, &[1.0, 0.0, 0.0])?,
        solve_row(m, &[0.0, 1.0, 0.0])?,
        solve_row(m, &[0.0, 0.0, 1.0])?,
    ];
    Some(std::array::from_fn(|r| std::array::from_fn(|c| columns[c][r])))
}

/// The widest saturation the search may return, and the resolution it stops at.
///
/// The bound is a bound, not a fit: outside it the scalar is no longer describing a
/// camera and is covering for a stage that went wrong. The resolution is below what an
/// eye resolves, so the last few iterations of the search would be spent on nothing.
const SATURATION_RANGE: (f64, f64) = (0.6, 1.5);
const SATURATION_RESOLUTION: f64 = 0.002;

/// Steps of the coarse sweep, and how much better than leaving the chroma alone the
/// result has to measure before it is used.
///
/// The sweep is fine enough to land in the right dip of a staircase whose treads are
/// hundredths wide, and coarse enough to stay cheap - each step is a pass over every
/// pair. The margin is an order above the tread the measurement showed, and two below
/// the difference a saturation that matters makes.
const SATURATION_SWEEP: usize = 18;
const NEUTRAL_MARGIN: f64 = 0.02;

/// The chroma blend, at the strength that best matches the camera.
///
/// Fitted against deltaE rather than solved for the mean chroma ratio, which is what
/// this did and is a proxy that fails exactly when the stages above it leave a residual:
/// the ratio is a mean, one scalar can always be found that makes a mean come out right,
/// and on IMG_9808 the one that did came out at 1.153 - which took hues that were
/// already within 1.3 of the camera and pushed the hillside to 11.6, acid yellow-green,
/// while the number it was solving for looked perfect. The deltaE fit lands at 0.995
/// there and leaves the frames whose chroma really is short alone.
///
/// Every pair counts the same here, unlike the curve and matrix fits. `hue_balance`
/// stops a frame's dominant colour deciding what the camera is taken to *do*, and the
/// curves and the matrix have the freedom to act on that separately per hue. This
/// scalar has none - it moves the whole picture at once - so balancing it does not
/// protect a minority hue, it hands the picture to one. IMG_9808 balanced lands at
/// 0.772 and drains its sky, 75k pairs at deltaE 9.4, to bring 1.2k red ones in.
///
/// Coarse sweep first, then a golden section inside the bracket it found - and the
/// answer has to beat leaving the chroma alone before it is taken.
///
/// A plain golden section over the whole range is wrong here twice over, and both were
/// measured rather than reasoned about. The objective is *not* unimodal: it goes through
/// `srgb_oetf` and then a round to 8 bits, so it is a staircase, and on a near-neutral
/// ramp a 0.01 sweep dips at 0.60, climbs to 0.74, dips again at 0.76 and again at 1.26.
/// Golden section walked into the wrong dip and returned 0.805 where the sweep's best is
/// 0.60. Worse, where every step of that round lands in the same place the objective is
/// *flat*, every comparison ties, and a bisection that discards a half on a tie walks to
/// whichever end it favours: an achromatic frame - fog, snow, overcast - came back with
/// 1.499, a 1.5x chroma boost, applied at full resolution to a frame that is not
/// achromatic once it is off the blurred 640px grid this was measured on.
///
/// So the sweep finds which dip to be in, the section refines inside it, and neutral is
/// the answer unless something clearly beats it. `NEUTRAL_MARGIN` is what "clearly"
/// means: below it the difference is the staircase's own tread rather than a fact about
/// the camera, and a real one is nowhere near that small - IMG_9808 moves deltaE by
/// about 2 between its fitted saturation and 1.0.
fn fitted_saturation(colour: &HdrColour, render: &Plane, pairs: &Pairs) -> f64 {
    let scored = |saturation: f64| {
        measure(&HdrColour { saturation, ..colour.clone() }, render, pairs).1
    };
    let (low, high) = SATURATION_RANGE;

    let mut at = 1.0;
    let mut best = scored(1.0);
    for step in 0..=SATURATION_SWEEP {
        let probe = low + (high - low) * step as f64 / SATURATION_SWEEP as f64;
        let here = scored(probe);
        // Strictly better, so a flat objective keeps the neutral this started from
        // instead of sliding to whichever end the comparisons happen to favour.
        if here < best {
            (at, best) = (probe, here);
        }
    }

    let coarse = (high - low) / SATURATION_SWEEP as f64;
    let (mut lo, mut hi) = ((at - coarse).max(low), (at + coarse).min(high));
    const INVERSE_PHI: f64 = 0.618_033_988_749_895;
    let (mut c, mut d) = (hi - (hi - lo) * INVERSE_PHI, lo + (hi - lo) * INVERSE_PHI);
    let (mut fc, mut fd) = (scored(c), scored(d));
    while hi - lo > SATURATION_RESOLUTION {
        if fc < fd {
            (hi, d, fd) = (d, c, fc);
            c = hi - (hi - lo) * INVERSE_PHI;
            fc = scored(c);
        } else {
            (lo, c, fc) = (c, d, fd);
            d = lo + (hi - lo) * INVERSE_PHI;
            fd = scored(d);
        }
    }

    let found = (lo + hi) / 2.0;
    match scored(found) + NEUTRAL_MARGIN < scored(1.0) {
        true => found,
        false => 1.0,
    }
}

fn fit_colour(render: &Plane, jpeg: &Plane) -> Option<HdrColour> {
    let bits = mask(render, jpeg);
    let all = bits.iter().filter(|v| *v & ALL != 0).count();
    if all < MIN_PAIRS {
        return None;
    }
    let balance = hue_balance(jpeg, &bits);

    // `hold_one_shape` is a claim about the camera - that its three channels render one
    // shape apart from a gain - and on the frames it was built from it is right, but it
    // is a claim and not every frame supports it. IMG_9808 does not: held to one shape
    // it measures 0.143 against 0.110 free - worse than making no claim at all - and its
    // hillside renders acid yellow-green. So the frame is asked. Drift is the question
    // because drift is what the constraint is for: scored on deltaE the constraint loses
    // everywhere, including on the frames whose green it removed, since what it buys is
    // consistency across level and deltaE averages exactly that away.
    //
    // Both models in full, not just both tone stages. Asking of the round one curves
    // alone is most of the cost away and it is the wrong question - what the constraint
    // does to a frame only shows once the matrix has been fitted around it and taken
    // back out of the target. Measured before that, IMG_9808 reads 0.105 held against
    // 0.110 free and keeps the constraint that ruins it. Four of the set choose
    // differently that way.
    let pairs = Pairs::new(jpeg, &bits, &balance);
    let held = fit_model(render, jpeg, &bits, &balance, &pairs, true);
    let free = fit_model(render, jpeg, &bits, &balance, &pairs, false);
    // Whichever measures less, with no margin favouring the constraint. A margin was
    // tried, on the reasoning that the constraint describes a property this camera
    // really has and so should not be given up on a near-tie - and IMG_8789 is a
    // near-tie, 0.130 free against 0.134 held. It was wrong. Held, that frame renders a
    // deep blue pot violet, its green cut from a 0.284 share to 0.151 against the
    // camera's 0.284, a 36 degree hue error on a saturated object; and the fur the
    // margin was protecting comes out 0.0008 different either way. Measured region by
    // region against the camera - the bird bath, the brick, the fur, the pot - the free
    // fit is closer on three and level on the fourth. The whole-frame number the margin
    // was justified by is dominated by lawn.
    Some(match drift(&free, render, jpeg) < drift(&held, render, jpeg) {
        true => free,
        false => held,
    })
}

fn fit_model(
    render: &Plane,
    jpeg: &Plane,
    bits: &[u8],
    balance: &[f64],
    pairs: &Pairs,
    hold: bool,
) -> HdrColour {
    let mut colour = HdrColour {
        curves: fit_curves(render, jpeg, bits, balance, None, hold),
        matrix: IDENTITY,
        saturation: 1.0,
        delta_e: f64::INFINITY,
    };

    // The least squares below is weighted twice over, and neither is a detail. By
    // `hue_balance`, so what the frame is mostly made of does not decide what the camera
    // is taken to do; and by d(cbrt)/dv, so a sample counts for its perceptual size
    // rather than its photometric one - unweighted in linear light the brightest pixels
    // dominate, and the matrix that lands on oversaturates everything darker, measured
    // at 1.093x the camera's mean chroma.
    //
    // Curves and matrix in turn, because fitted once each in order they are not fitting
    // the same thing the other is. The curves go first against the camera's rendering
    // whole, so whatever of it is cross-channel - and on this camera a good deal is,
    // green scaled 0.884 on grass and 0.690 on a brown - is booked into a per-channel
    // curve that cannot express it and cannot be corrected by the matrix afterwards.
    // Undoing the matrix from the target and refitting the curves against what is left
    // gives each stage only the part it can represent. `fit.rs` alternates its falloff
    // against the colour for the same reason, and lands within 0.1 after three rounds.
    for round in 0..FIT_ROUNDS {
        colour.matrix = fitted_matrix_for(&colour, render, jpeg, balance, pairs);
        let Some(inverse) = invert3(&colour.matrix).filter(|_| round + 1 < FIT_ROUNDS) else {
            break;
        };
        colour.curves = fit_curves(render, jpeg, bits, balance, Some(&inverse), hold);
        // Inside the alternation, not after it, and not conditional. A camera-neutral
        // rendering neutral is a property the transform should have rather than an
        // improvement it might make - it is the same kind of statement as the matrix's
        // rows summing to one - and the matrix refit at the top of the next round is
        // what lets the rest of the fit settle around it. Applied afterwards instead it
        // has no round left to settle in, and scores worse than not doing it at all.
        grey_balance(&mut colour, render, pairs);
    }

    // One scalar on top, because a 3x3 cannot express a saturation that varies with
    // level and the camera's does. It stays one number for the reason on the field itself.
    colour.saturation = fitted_saturation(&colour, render, pairs);
    colour.delta_e = measure(&colour, render, pairs).0;
    colour
}

// ------------------------------------------------------------------- the entry

/// Everything the lens did, applied to a 16-bit decode in place of the decode itself:
/// the warp, then the falloff.
///
/// Both are resolution-independent - each is in radii normalised to the half-diagonal
/// - so this is cheapest after any fit-to-size, exactly as the SDR path applies them
/// after the resize. None when the match asks for neither, which is the caller's cue
/// to grade the decode where it lies rather than copy it.
///
/// The falloff runs after the warp because that is the order it was fitted in: the
/// pairs it was measured from were taken against the warped render, so its radius
/// means a position in the corrected frame, not in LibRaw's. It brightens corners, so
/// it clips a little more of the top of the buffer - measured at 0.089% of samples to
/// 0.124% on the worst of 32 Canon frames, in corners already the brightest thing in
/// an already-clipping frame (10.8.1).
pub fn apply_lens(samples: &[u16], width: usize, height: usize, m: &HdrMatch) -> Option<Vec<u16>> {
    if m.lens.is_identity() {
        return None;
    }
    let mut out = match &m.lens.distortion {
        Some(knots) => warp_planar(
            samples,
            width,
            height,
            width,
            height,
            knots,
            m.lens.crop,
            |v| f64::from(v),
            |v| v.clamp(0.0, 65535.0) as u16,
        ),
        None => samples.to_vec(),
    };
    if let Some((a, b)) = m.lens.falloff {
        let (cx, cy) = (width as f64 / 2.0, height as f64 / 2.0);
        let half = (cx * cx + cy * cy).sqrt().max(1.0);
        out.par_chunks_mut(width * 3).enumerate().for_each(|(y, row)| {
            let dy = y as f64 - cy;
            for (x, pixel) in row.chunks_mut(3).enumerate() {
                let g = crate::fit::Gain::at(a, b, crate::fit::Gain::radius(x as f64 - cx, dy, half));
                for c in pixel {
                    *c = (f64::from(*c) * g).min(65535.0) as u16;
                }
            }
        });
    }
    Some(out)
}

/// Fits the camera's colour treatment in the HDR grade's own domain, reusing the
/// geometry the SDR fit already resolved.
///
/// `anchor` is diffuse white as a raw 16-bit level, which the grade measures the same
/// way (10.7.1); the fit is done in multiples of it so the curve means the same thing
/// whatever the exposure. None when there are too few usable pairs to fit from, in
/// which case the caller grades untransformed.
pub fn fit(
    plane: &Plane,
    anchor: f64,
    preview: &crate::vips::Rgb,
    lens: crate::fit::Lens,
) -> Option<HdrMatch> {
    if !(anchor > 0.0) {
        return None;
    }

    // Linearised before the resample: averaging gamma-encoded samples is not
    // averaging light, and at this scale factor that alone shifts the mid-tones.
    let srgb_to_rec2020 = multiply(&XYZ_TO_REC2020, &SRGB_TO_XYZ);
    let mut full = vec![0.0f64; preview.width * preview.height * 3];
    for p in 0..preview.width * preview.height {
        let i = p * 3;
        let v = apply3(
            &srgb_to_rec2020,
            srgb_eotf(preview.data[i]),
            srgb_eotf(preview.data[i + 1]),
            srgb_eotf(preview.data[i + 2]),
        );
        full[i..i + 3].copy_from_slice(&v);
    }
    let mut jpeg = Plane { width: preview.width, height: preview.height, data: full };
    blur_plane(&mut jpeg, FIT_BLUR_RADIUS);

    // Already down to twice the fit grid, and down there *before* the warp - the same
    // order the SDR fit uses. Warping 60MP with bilinear taps and resampling afterwards
    // is both slower and worse: it aliases going in, and it blurs the geometry going
    // out. Measured, warping at full resolution took the fit from under a second to 17.
    let (wide, tall) = (plane.width, plane.height);
    // Only the normalisation is per-fit, so this is a pass over ~1.1M pixels rather
    // than over the frame the plane was averaged from.
    let small: Vec<f64> = plane.data.par_iter().map(|v| v / anchor).collect();

    // Through the same geometry the SDR fit resolved, so a pair is two views of one
    // point in the scene.
    let warped = match &lens.distortion {
        Some(knots) => warp_planar(&small, wide, tall, wide, tall, knots, lens.crop, |v| v, |v| v),
        None => small,
    };

    let mut render = Plane {
        width: jpeg.width,
        height: jpeg.height,
        data: resample(&warped, wide, tall, jpeg.width, jpeg.height, |v| v),
    };
    // Before the blur and before the fit, because the grade applies it before the
    // colour too: a curve fitted against corners the falloff has not yet lifted would
    // be asked at grade time for levels it never saw.
    if let Some((a, b)) = lens.falloff {
        let (cx, cy) = (render.width as f64 / 2.0, render.height as f64 / 2.0);
        let half = (cx * cx + cy * cy).sqrt().max(1.0);
        for y in 0..render.height {
            let dy = y as f64 - cy;
            for x in 0..render.width {
                let g = crate::fit::Gain::at(a, b, crate::fit::Gain::radius(x as f64 - cx, dy, half));
                let i = (y * render.width + x) * 3;
                for c in 0..3 {
                    render.data[i + c] *= g;
                }
            }
        }
    }
    blur_plane(&mut render, FIT_BLUR_RADIUS);

    // The lens travels with the colour, never beside it: these pairs only correspond
    // through that warp and carry that falloff, so the three are one transform.
    fit_colour(&render, &jpeg).map(|colour| HdrMatch { lens, colour })
}

/// The long edge the preview is decoded to for the fit.
pub fn fit_long_edge() -> usize {
    FIT_LONG_EDGE
}

/// The decode box-averaged to the grid both fits work on, in the decode's own units.
///
/// Shared rather than built twice. The geometry search and the colour fit want exactly
/// this same average and differ only in the scalar they normalise it by, so walking a
/// 61MP frame once each was a whole extra pass over 15.8M pixels for the same answer.
/// Left unnormalised for that reason: each consumer divides by its own level.
///
/// `wide` should be twice the preview's width, which is what `fit::fit` resizes to -
/// so arriving at that size makes its own resize a no-op rather than a second resample.
pub fn fit_plane(linear: &[u16], width: usize, height: usize, wide: usize) -> Plane {
    let wide = width.min(wide).max(1);
    let tall = (((height as f64 / width as f64) * wide as f64).round() as usize).max(1);
    Plane { width: wide, height: tall, data: resample(linear, width, height, wide, tall, f64::from) }
}

/// That plane as an 8-bit sRGB render, for the geometry search.
///
/// So the geometry fit can be driven off the HDR decode rather than a second, 8-bit one
/// taken of the same file. LibRaw's sRGB path is linear, then auto-bright, then the sRGB
/// gamma, and this is the same shape.
///
/// **Normalised by diffuse white, not by the frame's peak**, and the difference is not
/// cosmetic. LibRaw's auto-bright is a percentile - it clips its brightest ~1% on
/// purpose. Dividing by the peak instead clips nothing, which sounds safer and is the
/// bug: the peak is the maximum of a strided subsample, so a single specular sample - a
/// sun, a chrome edge, a hot pixel - drags the whole render toward black by the
/// peak/white ratio, which `tone.rs` documents as varying 10x across bodies. Measured on
/// DSC02981 that took the render's mean from 88 to 51 against LibRaw's 115, about a stop
/// and a fifth, and `fit::pairs` drops any pair whose darkest channel lands on 1 or
/// below - so the shadows that error creates are not merely dark, they are discarded,
/// and a frame can fall under `MIN_PAIRS` and lose its colour match altogether.
///
/// The quantile is also what keeps this *close* across decode sizes, which the peak is
/// not - and close is the goal rather than equal. Two jobs fitting the same photo from
/// differently-sized decodes should land on the same geometry, since nothing is
/// persisted between them (10.8), but they cannot land on it exactly: a half-size
/// decode is its own demosaic rather than a downscale of the full one, so resampling
/// both to the fit grid gives slightly different planes whatever is done here. Measured
/// on the 24MP fixture, a full decode against a halved one moves the fitted matrix by
/// about 0.5%. What is worth fixing is anything that makes the gap *larger* than that
/// for no reason, which is what the peak was doing before `tone` read it as a quantile.
pub fn render_srgb8(plane: &Plane, white: f64) -> crate::vips::Rgb {
    let mut data = vec![0u8; plane.width * plane.height * 3];
    let to_srgb = rec2020_to_srgb();
    data.par_chunks_mut(3).zip(plane.data.par_chunks(3)).for_each(|(out, px)| {
        let v = to_srgb8(&to_srgb, px[0] / white, px[1] / white, px[2] / white);
        for c in 0..3 {
            out[c] = v[c] as u8;
        }
    });
    crate::vips::Rgb { width: plane.width, height: plane.height, data }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity_colour() -> HdrColour {
        // A curve that returns its input, over the trusted domain.
        let ramp: Vec<f64> = (0..BINS).map(|i| (i as f64 / (BINS - 1) as f64) * TRUST_CEILING).collect();
        HdrColour {
            curves: [ramp.clone(), ramp.clone(), ramp],
            matrix: IDENTITY,
            saturation: 1.0,
            delta_e: 0.0,
        }
    }

    #[test]
    fn an_identity_transform_returns_its_input() {
        let colour = identity_colour();
        for value in [0.0, 0.1, 0.45, 0.9] {
            let out = apply_hdr_colour(&colour, value, value, value);
            assert!((out[0] - value).abs() < 1e-9, "{value} -> {out:?}");
        }
    }

    #[test]
    fn above_the_ceiling_the_gain_is_shared_rather_than_per_channel() {
        // The magenta-sky failure: three channels extrapolating independently drift
        // apart as brightness rises. A shared gain keeps the ratio, so a bright
        // orange stays orange and only gets brighter.
        let colour = identity_colour();
        let low = apply_hdr_colour(&colour, 0.6, 0.3, 0.15);
        let high = apply_hdr_colour(&colour, 2.4, 1.2, 0.6);
        let ratio_low = low[1] / low[0];
        let ratio_high = high[1] / high[0];
        assert!((ratio_low - ratio_high).abs() < 1e-6, "hue drifted: {ratio_low} vs {ratio_high}");
    }

    #[test]
    fn saturation_below_one_pulls_towards_luma() {
        let mut colour = identity_colour();
        colour.saturation = 0.5;
        let out = finish_colour(&colour, 0.8, 0.2, 0.2);
        let l = LUMA[0] * 0.8 + LUMA[1] * 0.2 + LUMA[2] * 0.2;
        assert!((out[0] - (l + (0.8 - l) * 0.5)).abs() < 1e-9);
    }

    /// A curve fitted from pairs of `shape`, whose samples reach `reach` of the domain.
    fn curve_of(reach: f64, shape: impl Fn(f64) -> f64) -> (Vec<f64>, isize) {
        let (xs, ys): (Vec<f64>, Vec<f64>) = (0..4000)
            .map(|i| {
                let x = (i as f64 / 4000.0) * TRUST_CEILING * reach;
                (x, shape(x))
            })
            .unzip();
        fit_curve(&xs, &ys, &vec![1.0; xs.len()], xs.len())
    }

    #[test]
    fn a_curve_is_monotone_and_extends_past_its_data() {
        // Samples only up to half the domain: the tail must extend at the last slope
        // rather than flatten, or every highlight the frame did not sample is crushed.
        let (mut curve, last) = curve_of(0.5, |x| x * 0.8);
        extend_alone(&mut curve, last as usize);
        for b in 1..BINS {
            assert!(curve[b] >= curve[b - 1], "curve dipped at {b}");
        }
        assert!(curve[BINS - 1] > curve[BINS / 2], "the tail must keep climbing");
    }

    #[test]
    fn a_channel_whose_pairs_run_out_early_does_not_drift_from_the_others() {
        // The green-sky failure. All three channels see the same rendering, but the
        // JPEG clips green a quarter of the way up the domain and red not until
        // two-thirds - so green's own last slope, taken from the steep part of the
        // curve, ran it to twice red's by diffuse white.
        let shape = |x: f64| x.powf(0.45) * 0.9;
        let curves =
            extend_curves([curve_of(0.66, shape), curve_of(0.18, shape), curve_of(0.20, shape)]);

        for x in [0.3, 0.5, 0.7, TRUST_CEILING] {
            let [r, g, b] = [0, 1, 2].map(|c| sample_curve(&curves[c], x * TRUST_CEILING));
            assert!((g / r - 1.0).abs() < 0.02, "green drifted at {x}: {g} against {r}");
            assert!((b / r - 1.0).abs() < 0.02, "blue drifted at {x}: {b} against {r}");
        }
    }

    #[test]
    fn a_borrowed_tail_holds_the_gain_near_the_join_and_lets_it_go_by_the_top() {
        // Both halves of the same trade. Just above the join the channel's own
        // measurement is the best thing there is, so a camera rendering it 20% hotter
        // keeps that. By the top of the domain the gain is a claim about a level the
        // frame never measured, and holding it there is what puts a colour in a sky
        // that has none - so it fades and the channel becomes the shared curve.
        let shape = |x: f64| x.powf(0.45) * 0.9;
        let curves = extend_curves([
            curve_of(0.66, shape),
            curve_of(0.18, |x| shape(x) * 1.2),
            curve_of(0.66, shape),
        ]);

        let at = |x: f64| (sample_curve(&curves[1], x), sample_curve(&curves[0], x));
        let (hot, plain) = at(0.2);
        assert!((hot / plain - 1.2).abs() < 0.05, "gain lost at the join: {hot} vs {plain}");
        let (hot, plain) = at(TRUST_CEILING);
        assert!((hot / plain - 1.0).abs() < 0.02, "gain held to the top: {hot} vs {plain}");
    }

    #[test]
    fn a_channel_that_ends_above_the_reference_still_converges_onto_it() {
        // The corner that made a neutral sky come out 13% red off a bounded decode and
        // neutral off a full one. A channel reaching far with a strong gain ends higher
        // than the reference's extension, so converging asks it to fall, and the
        // monotone guard - which the measured part of the curve needs - clamps the whole
        // tail flat at its own level instead. It has to be the curves that move, not the
        // guard that gives way.
        let shape = |x: f64| x.powf(0.45) * 0.9;
        let curves = extend_curves([
            curve_of(0.30, shape),
            curve_of(0.85, |x| shape(x) * 1.4),
            curve_of(0.30, shape),
        ]);

        let tops = [0, 1, 2].map(|c| curves[c][BINS - 1]);
        let (high, low) = (tops.iter().cloned().fold(0.0, f64::max), tops.iter().cloned().fold(f64::MAX, f64::min));
        assert!(high / low - 1.0 < 0.01, "the channels ended apart: {tops:?}");
        // And nothing was dragged downwards to get there.
        for c in 0..3 {
            for b in 1..BINS {
                assert!(curves[c][b] >= curves[c][b - 1], "channel {c} dips at {b}");
            }
        }
    }

    #[test]
    fn one_colour_filling_a_frame_does_not_own_the_fit() {
        // IMG_8789's whole story: a lawn fills the frame, the fit minimises over every
        // pair equally, and the two brown dogs are too small a share for their error to
        // cost it anything - so they render olive while the held-out deltaE reports 2.96
        // and looks healthy. What a frame is *of* must not decide what the camera is
        // taken to do.
        let mut plane = Plane { width: 40, height: 40, data: vec![0.0; 40 * 40 * 3] };
        for p in 0..40 * 40 {
            // Nine tenths one green, one tenth a warm brown.
            let px = match p % 10 {
                0 => [0.45, 0.25, 0.12],
                _ => [0.16, 0.40, 0.10],
            };
            plane.data[p * 3..p * 3 + 3].copy_from_slice(&px);
        }
        let bits = vec![ALL | 0b111; 40 * 40];

        let balance = hue_balance(&plane, &bits);
        let share = |want: usize| -> f64 {
            (0..40 * 40).filter(|p| p % 10 == want).map(|p| balance[p]).sum()
        };
        let (brown, green) = (share(0), (1..10).map(share).sum::<f64>());
        // Nine to one by area; the weighting has to pull that much closer to parity
        // without inverting it, since the grass is still most of what there is to fit.
        assert!(green / brown < 4.0, "the dominant hue still owns it: {green} against {brown}");
        assert!(green > brown, "the rare hue took over instead: {green} against {brown}");
    }

    /// A frame holding one hue across the whole brightness range, which is what `drift`
    /// needs to have anything to compare between.
    fn ramped_planes(hue: [f64; 3]) -> (Plane, Plane) {
        let (width, height) = (64, 64);
        let mut data = vec![0.0f64; width * height * 3];
        for p in 0..width * height {
            // Enough levels of the same hue for several of the metric's bands to fill,
            // and dark enough at the bottom to stay clear of the clipping cut.
            let level = 0.05 + 0.7 * (p / width) as f64 / (height - 1) as f64;
            for c in 0..3 {
                data[p * 3 + c] = hue[c] * level;
            }
        }
        let jpeg = Plane { width, height, data };
        (Plane { width, height, data: jpeg.data.clone() }, jpeg)
    }

    #[test]
    fn a_transform_that_only_gains_each_channel_reads_as_no_drift() {
        // The point of the metric: a per-channel gain is a colour cast, not a drift.
        // It is wrong in the same direction at every level, so one material still comes
        // out one colour and this must not object to it - `grey_balance` is what a cast
        // is for. Objecting would make the metric prefer whichever fit was least tinted
        // rather than whichever was most consistent.
        let (render, jpeg) = ramped_planes([0.5, 0.35, 0.2]);
        let ramp: Vec<f64> = (0..BINS).map(|i| i as f64 / (BINS - 1) as f64).collect();
        let gains = [1.0, 1.12, 0.93];
        let cast = HdrColour {
            curves: std::array::from_fn(|c| ramp.iter().map(|v| v * gains[c]).collect()),
            matrix: IDENTITY,
            saturation: 1.0,
            delta_e: 0.0,
        };
        assert!(drift(&cast, &render, &jpeg) < 1e-6, "a flat cast read as drift");
    }

    #[test]
    fn a_channel_that_bends_away_with_level_reads_as_drift() {
        // IMG_8789's hump: green runs above red through the mid-tones and comes back to
        // level at both ends, so the pale fur goes green while the dark fur does not.
        // The neutral axis is correct at either end, which is why `grey_balance` cannot
        // see this and something else has to.
        let (render, jpeg) = ramped_planes([0.5, 0.35, 0.2]);
        let bent = HdrColour {
            curves: std::array::from_fn(|c| {
                (0..BINS)
                    .map(|i| {
                        let x = i as f64 / (BINS - 1) as f64;
                        let hump = 1.0 - (4.0 * (x - 0.4)).powi(2).min(1.0);
                        x * if c == 1 { 1.0 + 0.15 * hump } else { 1.0 }
                    })
                    .collect()
            }),
            matrix: IDENTITY,
            saturation: 1.0,
            delta_e: 0.0,
        };
        assert!(drift(&bent, &render, &jpeg) > 0.02, "a mid-tone hump went unnoticed");
    }

    #[test]
    fn a_frame_with_no_chroma_to_measure_keeps_its_saturation() {
        // Fog, snow, overcast. Every probe rounds to the same 8-bit target, so the
        // objective is flat and every comparison ties - and a search that discards half
        // its bracket on a tie walks to whichever end it favours. This returned 1.499,
        // a 1.5x chroma boost, and then applied it to a full-resolution frame that is
        // not achromatic once it is off the blurred grid the fit measured on.
        let (render, jpeg) = ramped_planes([0.4, 0.4, 0.4]);
        let bits = vec![ALL | 0b111; render.width * render.height];
        let ramp: Vec<f64> = (0..BINS).map(|i| i as f64 / (BINS - 1) as f64).collect();
        let pairs = Pairs::new(&jpeg, &bits, &vec![1.0f64; bits.len()]);
        let colour = HdrColour {
            curves: [ramp.clone(), ramp.clone(), ramp],
            matrix: IDENTITY,
            saturation: 1.0,
            delta_e: 0.0,
        };
        let found = fitted_saturation(&colour, &render, &pairs);
        assert!((found - 1.0).abs() < 1e-9, "invented a saturation out of a flat frame: {found}");
    }

    #[test]
    fn the_saturation_search_recovers_the_blend_the_camera_used() {
        // And is not solved from a mean chroma ratio, which on IMG_9808 could be made
        // to come out right by a scalar that pushed the hillside eight deltaE further
        // from the camera than it started.
        let (render, jpeg) = ramped_planes([0.5, 0.3, 0.18]);
        let bits = vec![ALL | 0b111; render.width * render.height];
        let ramp: Vec<f64> = (0..BINS).map(|i| i as f64 / (BINS - 1) as f64).collect();
        let flat = vec![1.0f64; bits.len()];

        for want in [0.85, 1.0, 1.2] {
            // The camera's rendering *is* the render pushed to `want`, so the search has
            // a right answer to find rather than a compromise to settle on.
            let applied = HdrColour {
                curves: [ramp.clone(), ramp.clone(), ramp.clone()],
                matrix: IDENTITY,
                saturation: want,
                delta_e: 0.0,
            };
            let mut target =
                Plane { width: jpeg.width, height: jpeg.height, data: jpeg.data.clone() };
            for p in 0..render.width * render.height {
                let i = p * 3;
                let v = apply_hdr_colour(&applied, render.data[i], render.data[i + 1], render.data[i + 2]);
                target.data[i..i + 3].copy_from_slice(&v);
            }

            let pairs = Pairs::new(&target, &bits, &flat);
            let neutral = HdrColour { saturation: 1.0, ..applied };
            let found = fitted_saturation(&neutral, &render, &pairs);
            assert!((found - want).abs() < 0.02, "wanted {want}, found {found}");
        }
    }

    #[test]
    fn a_neutral_highlight_comes_out_neutral_where_no_channel_has_data() {
        // The guarantee the sky needs, and the one three independently extrapolated
        // curves cannot give: DSC05469's sky is clipped in the sensor to exactly
        // neutral and rendered by the camera as exactly neutral, and it came out green.
        // Every channel converging on one curve is what makes neutral in mean neutral
        // out, rather than leaving it to three guesses that happen to agree.
        let (plane, preview) = warm_chart();
        let fitted =
            fit(&plane, 1.0, &preview, crate::fit::Lens::none()).expect("the chart is fittable");

        // Read where the grade reads a blown sky: the shared gain scales the pixel so
        // its brightest channel sits at the top of the domain.
        let out = tone(&fitted.colour, 1.0, 1.0, 1.0);
        let (high, low) = (out[0].max(out[1]).max(out[2]), out[0].min(out[1]).min(out[2]));
        assert!(high / low - 1.0 < 0.01, "a neutral highlight came out {out:?}");
    }

    #[test]
    fn converging_the_tail_does_not_flatten_a_colour_the_scene_had() {
        // Converging the curves is not desaturation: what carries a highlight's colour
        // is the pixel, not the curve, so a warm one stays warm.
        let (plane, preview) = warm_chart();
        let fitted =
            fit(&plane, 1.0, &preview, crate::fit::Lens::none()).expect("the chart is fittable");

        let out = tone(&fitted.colour, 1.2, 0.6, 0.3);
        assert!(out[0] > out[1] * 1.3, "the warm highlight went flat: {out:?}");
        assert!(out[1] > out[2] * 1.2, "the warm highlight went flat: {out:?}");
    }

    #[test]
    fn borrowing_replaces_only_the_bins_a_channel_never_measured() {
        // The channels are near enough the same shape that a tail borrowed from the
        // wrong place still looks right, so the assertions above pass just as well on
        // an extension that overwrites the measured curve too. What it must not touch
        // is the data - a channel's own pairs are the only thing here that is not an
        // assumption.
        let short = |x: f64| x.powf(0.45) * 0.9 * 1.3;
        let (measured, last) = curve_of(0.18, short);
        let curves =
            extend_curves([curve_of(0.66, |x| x.powf(0.45) * 0.9), (measured.clone(), last), curve_of(0.66, short)]);

        for b in 0..=last as usize {
            assert_eq!(curves[1][b], measured[b], "bin {b} was measured, not guessed");
        }
    }

    /// The camera's rendering of one scene-linear level, per channel. A power curve
    /// with a per-channel gain: the shape the three share, and the difference between
    /// them that a borrowed tail has to keep.
    const CAMERA_GAIN: [f64; 3] = [1.0, 1.06, 0.94];
    fn camera(channel: usize, level: f64) -> f64 {
        CAMERA_GAIN[channel] * 1.172 * level.max(0.0).powf(0.533)
    }

    /// A patch chart and the camera's rendering of it, shaped like the frame that
    /// turned green: the body of it sits in the domain all three channels share, and
    /// what reaches past that is warm, so red carries pairs to render 0.45 where green
    /// and blue stop around 0.20 and everything above is a guess.
    ///
    /// Flat patches rather than a gradient, because `mask` drops any pixel with a
    /// gradient across it - a ramp is all edge and would leave nothing to fit from.
    ///
    /// The warm patches stop where they do because an 8-bit sRGB preview cannot hold a
    /// brighter one: rendered, render 0.62 against green's 0.20 leaves the sRGB gamut,
    /// clamps, and the fit then reads a red curve the camera never wrote.
    fn warm_chart() -> (Plane, crate::vips::Rgb) {
        const COLS: usize = 10;
        const PATCHES: usize = 80;
        const PATCH: usize = 32;
        let (width, height) = (COLS * PATCH, (PATCHES / COLS) * PATCH);

        let patch = |i: usize| -> [f64; 3] {
            // Warm highlights: only red reaches past the domain the three share.
            if i >= 60 {
                let t = (i - 60) as f64 / 19.0;
                return [0.24 + t * 0.21, 0.10 + t * 0.095, 0.06 + t * 0.075];
            }
            // Everything the three channels have in common, tinted four ways so the
            // matrix has more than a grey axis to fit against.
            let level = 0.004 + (i as f64 / 59.0) * 0.196;
            let tint = [[1.0, 1.0, 1.0], [1.0, 0.85, 0.7], [0.8, 1.0, 0.9], [0.9, 0.85, 1.0]][i % 4];
            [0, 1, 2].map(|c| level * tint[c])
        };

        let mut scene = vec![0.0f64; width * height * 3 * 4];
        let mut rendered = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let colour = patch((y / PATCH) * COLS + (x / PATCH));
                let camera = [0, 1, 2].map(|c| camera(c, colour[c]));
                let srgb = to_srgb8(&rec2020_to_srgb(), camera[0], camera[1], camera[2]);
                for c in 0..3 {
                    rendered[(y * width + x) * 3 + c] = srgb[c] as u8;
                    // The plane the decode arrives on is twice the preview's width.
                    for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                        scene[(((y * 2 + dy) * width * 2) + x * 2 + dx) * 3 + c] = colour[c];
                    }
                }
            }
        }

        (
            Plane { width: width * 2, height: height * 2, data: scene },
            crate::vips::Rgb { width, height, data: rendered },
        )
    }

    #[test]
    fn a_channel_that_ran_out_of_pairs_lands_near_the_rendering_it_never_saw() {
        // The green sky, on a frame small enough to build here. Above render 0.20 the
        // green curve is guesswork whatever this does, so what is asserted is which
        // guess: the shape red measured, rather than a straight line from green's own
        // last bin - which on this chart is 8.4% hot at 0.4 and 19.2% at 0.6, climbing
        // away from red, which is the part the eye reads as a cast.
        //
        // Bounded per channel rather than by one number for all three, because the
        // chart is built with per-channel gains (1.06 on green, 0.94 on blue) and the
        // design deliberately gives them up above the join: every channel converges on
        // the *highest* held extension, so once past its own pairs the coolest channel
        // must read about its gain difference high. Asserting one tight bound across
        // all three would be asserting against the design and could only be met by
        // loosening it until it said nothing.
        let (plane, preview) = warm_chart();
        let fitted =
            fit(&plane, 1.0, &preview, crate::fit::Lens::none()).expect("the chart is fittable");

        for level in [0.4, 0.5, 0.6] {
            let at = |c: usize| sample_curve(&fitted.colour.curves[c], level) / camera(c, level) - 1.0;
            // Red measured its own pairs to 0.66, so it is held to them.
            assert!(at(0).abs() < 0.03, "red at {level}: {:+.3}", at(0));
            // Green ran out at 0.18 and converges towards a gain near its own.
            assert!(at(1).abs() < 0.04, "green at {level}: {:+.3}", at(1));
            // Blue ran out at 0.20 and is the one converging *away* from its own gain,
            // by about the 6% that separates 0.94 from the top of the three.
            assert!(at(2) > 0.0 && at(2) < 0.08, "blue at {level}: {:+.3}", at(2));
        }
    }

    #[test]
    fn two_neighbours_of_nearly_the_same_colour_are_not_pulled_apart() {
        // The rash. A stage that computes its gain from the pixel's own colour
        // amplifies whatever variation that colour has, and on a real frame most of the
        // variation across a flat surface is sensor noise the camera's JPEG has had
        // denoised away - so a dog's even fur came out red-speckled beside green and a
        // flat grey wall came out blotchy. Denoising ours first does not fix it at the
        // strength the render is denoised by, so what the transform must do instead is
        // leave neighbours as close together as it found them.
        let mut colour = identity_colour();
        colour.matrix = [[1.06, -0.04, -0.02], [-0.03, 1.05, -0.02], [-0.02, -0.05, 1.07]];
        colour.saturation = 1.08;

        for base in [[0.12, 0.10, 0.09], [0.40, 0.30, 0.22], [0.75, 0.74, 0.72]] {
            // Two pixels a hair apart, as neighbours on a flat surface are.
            let near = [base[0] + 0.004, base[1] - 0.003, base[2] + 0.002];
            let (a, b) = (apply_hdr_colour(&colour, base[0], base[1], base[2]),
                          apply_hdr_colour(&colour, near[0], near[1], near[2]));
            let apart = |x: [f64; 3], y: [f64; 3]| {
                (0..3).map(|c| (x[c] - y[c]).powi(2)).sum::<f64>().sqrt()
            };
            let (before, after) = (apart(base, near), apart(a, b));
            assert!(
                after < before * 1.5,
                "{before} apart went to {after}: {a:?} against {b:?}",
            );
        }
    }

    #[test]
    fn the_matrix_leaves_a_neutral_neutral_however_hard_it_is_pulled() {
        // The freedom browns need and the guarantee greys need, at the same time. The
        // ridge used to buy the second by denying the first: damped to near-identity
        // the matrix could not say that this camera scales green by 0.884 on grass and
        // 0.690 on a dog, so the dogs came out olive. Constrained instead, the rows may
        // go where the pairs point as long as a grey stays a grey.
        let mut m = Moments::default();
        // Pairs that want a strong cross-channel term: green pulled down hard on
        // anything red-dominant, left alone on green-dominant.
        for (v, y) in [
            ([0.5, 0.3, 0.2], [0.5, 0.18, 0.2]),
            ([0.2, 0.6, 0.1], [0.2, 0.6, 0.1]),
            ([0.4, 0.4, 0.4], [0.4, 0.4, 0.4]),
            ([0.1, 0.2, 0.6], [0.1, 0.2, 0.6]),
        ] {
            m.add(1.0, &v, &y);
        }

        let matrix = m.solve(0.0005);
        for (o, row) in matrix.iter().enumerate() {
            let sum: f64 = row.iter().sum();
            assert!((sum - 1.0).abs() < 1e-9, "row {o} sums to {sum}");
        }
        for grey in [0.05, 0.4, 0.9, 2.5] {
            let out = apply3(&matrix, grey, grey, grey);
            let (high, low) = (out[0].max(out[1]).max(out[2]), out[0].min(out[1]).min(out[2]));
            assert!(high - low < 1e-9, "grey {grey} came out {out:?}");
        }
        // And it did use the freedom rather than sitting at the identity.
        assert!(matrix[1][0].abs() > 0.05, "no cross-channel term was fitted: {matrix:?}");
    }

    #[test]
    fn solve_row_reports_a_singular_system() {
        let singular = [[1.0, 2.0, 3.0], [2.0, 4.0, 6.0], [3.0, 6.0, 9.0]];
        assert!(solve_row(&singular, &[1.0, 2.0, 3.0]).is_none());
    }

    #[test]
    fn the_rec2020_round_trip_lands_back_on_srgb() {
        // A neutral in Rec.2020 linear must come back neutral in sRGB, or the deltaE
        // this reports is measured in the wrong space.
        let out = to_srgb8(&rec2020_to_srgb(), 0.5, 0.5, 0.5);
        assert!((out[0] - out[1]).abs() <= 1.0 && (out[1] - out[2]).abs() <= 1.0, "{out:?}");
        assert!(out[0] > 150.0 && out[0] < 200.0, "mid grey, got {}", out[0]);
    }
}
