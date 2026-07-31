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

/// A nudge towards identity, which costs nothing where the data is strong and keeps
/// the matrix from inventing a cross-channel term out of whatever the frame happens
/// not to contain.
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
                if jpeg.data[i + c] < 0.94 && render.data[i + c] < TRUST_CEILING {
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
fn fit_curve(xs: &[f64], ys: &[f64], n: usize) -> (Vec<f64>, isize) {
    let mut sum = vec![0.0f64; BINS];
    let mut count = vec![0usize; BINS];
    for i in 0..n {
        let bin = (((xs[i] / TRUST_CEILING) * (BINS - 1) as f64).round() as isize)
            .clamp(0, BINS as isize - 1) as usize;
        sum[bin] += ys[i];
        count[bin] += 1;
    }

    let mut curve = vec![0.0f64; BINS];
    let mut last: isize = -1;
    for b in 0..BINS {
        if count[b] < MIN_BIN_SAMPLES {
            continue;
        }
        let value = sum[b] / count[b] as f64;
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

/// Extends a curve past its data on another channel's shape, scaled to meet it where
/// its own data stopped.
fn extend_from(curve: &mut [f64], last: usize, reference: &[f64]) {
    if !(reference[last] > 0.0) {
        return extend_alone(curve, last);
    }
    let scale = curve[last] / reference[last];
    for b in last + 1..BINS {
        curve[b] = reference[b] * scale;
    }
    make_monotone(curve);
}

/// Fills in each channel above the point its pairs ran out, off the channel that got
/// furthest.
///
/// Every channel extending on its own last slope is what turned this frame's sky green
/// (DSC05469): the fit domain does not end where the camera's rendering does, it ends
/// where the JPEG clips *that* channel, and on a warm sky that is render 0.18 for green
/// and 0.66 for red. Three straight lines from three different places diverge, and by
/// diffuse white green was reading 2.19 against red's 1.15 - a cast that grows with
/// brightness, on pixels well inside the trusted domain.
///
/// The channels agree on shape wherever they overlap (within 1% at render 0.1 on that
/// frame), which is what makes borrowing it sound: what a short channel is missing is
/// reach, not a rendering of its own. Scaled rather than offset, so the join keeps the
/// ratio the data ended on and the extension stays a gain rather than a tint.
fn extend_curves(mut fitted: [(Vec<f64>, isize); 3]) -> [Vec<f64>; 3] {
    let furthest = (0..3).max_by_key(|c| fitted[*c].1).unwrap_or(0);
    let Ok(last) = usize::try_from(fitted[furthest].1) else {
        // No channel had a single filled bin; every curve is still zeroes.
        return fitted.map(|(curve, _)| curve);
    };
    extend_alone(&mut fitted[furthest].0, last);

    let reference = fitted[furthest].0.clone();
    for c in 0..3 {
        if c == furthest {
            continue;
        }
        if let Ok(last) = usize::try_from(fitted[c].1) {
            extend_from(&mut fitted[c].0, last, &reference);
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

fn to_srgb8(r: f64, g: f64, b: f64) -> [f64; 3] {
    // Back to sRGB primaries first; the fit works in Rec.2020.
    let v = apply3(&rec2020_to_srgb(), r, g, b);
    [0, 1, 2].map(|c| (255.0 * srgb_oetf(v[c])).round())
}

fn measure(colour: &HdrColour, render: &Plane, jpeg: &Plane, bits: &[u8]) -> (f64, f64) {
    let mut sum = 0.0;
    let mut ours = 0.0;
    let mut theirs = 0.0;
    let mut n = 0usize;
    for p in 0..bits.len() {
        if bits[p] & ALL == 0 {
            continue;
        }
        let i = p * 3;
        let v = apply_hdr_colour(colour, render.data[i], render.data[i + 1], render.data[i + 2]);
        let a = to_srgb8(v[0], v[1], v[2]);
        let t = to_srgb8(jpeg.data[i], jpeg.data[i + 1], jpeg.data[i + 2]);
        sum += crate::fit::delta_e76(&a, &t);

        let our_l = LUMA[0] * v[0] + LUMA[1] * v[1] + LUMA[2] * v[2];
        let their_l = luma(&jpeg.data, i);
        ours += ((v[0] - our_l).powi(2) + (v[1] - our_l).powi(2) + (v[2] - our_l).powi(2)).sqrt();
        theirs += ((jpeg.data[i] - their_l).powi(2)
            + (jpeg.data[i + 1] - their_l).powi(2)
            + (jpeg.data[i + 2] - their_l).powi(2))
        .sqrt();
        n += 1;
    }
    (sum / n.max(1) as f64, ours / theirs.max(1e-9))
}

fn fit_colour(render: &Plane, jpeg: &Plane) -> Option<HdrColour> {
    let bits = mask(render, jpeg);
    let all = bits.iter().filter(|v| *v & ALL != 0).count();
    if all < MIN_PAIRS {
        return None;
    }

    let curves = extend_curves(std::array::from_fn(|c| {
        let mut xs = vec![0.0f64; bits.len()];
        let mut ys = vec![0.0f64; bits.len()];
        let mut k = 0usize;
        for p in 0..bits.len() {
            if bits[p] & (1 << c) == 0 {
                continue;
            }
            xs[k] = render.data[p * 3 + c];
            ys[k] = jpeg.data[p * 3 + c];
            k += 1;
        }
        fit_curve(&xs, &ys, k)
    }));

    let mut colour =
        HdrColour { curves, matrix: IDENTITY, saturation: 1.0, delta_e: f64::INFINITY };

    // Weighted least squares, and the weighting is not a detail. Unweighted in linear
    // light the brightest pixels dominate - on a frame that is half sky, the sky *is*
    // the fit - and the matrix it lands on oversaturates everything darker: measured
    // at 1.093x the camera's mean chroma, which reads exactly as "slightly too
    // saturated". The weight is d(cbrt)/dv, so a sample counts for its perceptual
    // size rather than its photometric one.
    let mut ata = [[0.0f64; 3]; 3];
    let mut atb = [[0.0f64; 3]; 3];
    for p in 0..bits.len() {
        if bits[p] & ALL == 0 {
            continue;
        }
        let i = p * 3;
        let v = tone(&colour, render.data[i], render.data[i + 1], render.data[i + 2]);
        let w = 1.0 / (luma(&jpeg.data, i).cbrt().powi(2) + 1e-3);
        for a in 0..3 {
            for b in 0..3 {
                ata[a][b] += w * v[a] * v[b];
            }
            for o in 0..3 {
                atb[o][a] += w * v[a] * jpeg.data[i + o];
            }
        }
    }
    let scale = ata[0][0] + ata[1][1] + ata[2][2];
    for i in 0..3 {
        ata[i][i] += MATRIX_RIDGE * scale;
        atb[i][i] += MATRIX_RIDGE * scale;
    }
    for o in 0..3 {
        colour.matrix[o] = solve_row(&ata, &atb[o]).unwrap_or(IDENTITY[o]);
    }

    // One scalar on top, because a 3x3 cannot express a saturation that varies with
    // level and the camera's does: the weighting above takes the excess chroma from
    // 9.3% to 4.2% and then stops. Chroma is linear in this blend, so it solves
    // rather than searches.
    let (_, chroma) = measure(&colour, render, jpeg, &bits);
    colour.saturation = if chroma > 1e-6 { 1.0 / chroma } else { 1.0 };
    colour.delta_e = measure(&colour, render, jpeg, &bits).0;
    Some(colour)
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
    data.par_chunks_mut(3).zip(plane.data.par_chunks(3)).for_each(|(out, px)| {
        let v = to_srgb8(px[0] / white, px[1] / white, px[2] / white);
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
        fit_curve(&xs, &ys, xs.len())
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
    fn a_borrowed_tail_keeps_the_channel_its_own_gain() {
        // Borrowing reach must not borrow level: a channel the camera renders 20%
        // hotter stays 20% hotter above the join rather than snapping onto the
        // reference.
        let shape = |x: f64| x.powf(0.45) * 0.9;
        let curves = extend_curves([
            curve_of(0.66, shape),
            curve_of(0.18, |x| shape(x) * 1.2),
            curve_of(0.66, shape),
        ]);

        let (hot, plain) = (sample_curve(&curves[1], 0.7), sample_curve(&curves[0], 0.7));
        assert!((hot / plain - 1.2).abs() < 0.02, "gain lost: {hot} against {plain}");
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
        let out = to_srgb8(0.5, 0.5, 0.5);
        assert!((out[0] - out[1]).abs() <= 1.0 && (out[1] - out[2]).abs() <= 1.0, "{out:?}");
        assert!(out[0] > 150.0 && out[0] < 200.0, "mid grey, got {}", out[0]);
    }
}
