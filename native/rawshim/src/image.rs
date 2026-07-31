// Pixel maths libvips has no operation for.
//
// Everything libvips does do - resize, blur, encode - goes through `vips`. What is left
// is the radial warp and the spline it follows, and the render's denoise and sharpen
// (§10.9): a guided filter, a Richardson-Lucy deconvolution and the box means and noise
// estimate they are built on, none of which libvips offers.

use crate::vips::{Rgb, RgbRef};
use rayon::prelude::*;

pub const SPLINE_UNIT: f64 = 16384.0;

/// Entries in the lookup the warp indexes by r^2. Radii are normalised to the
/// half-diagonal, so r^2 runs exactly 0..1 over the frame and the table needs no
/// range beyond that. 4096 puts a 16-knot spline's kinks several buckets apart,
/// well below the bilinear sampling that follows.
pub(crate) const RATIO_TABLE_LAST: usize = 4096;

pub fn sample_radius(knots: &[f64], radius: f64, crop: f64) -> f64 {
    if knots.is_empty() {
        return crop * radius;
    }
    let last = (knots.len() - 1) as f64;
    let position = (radius * last).clamp(0.0, last);
    let index = position.floor() as usize;
    let next = (index + 1).min(knots.len() - 1);
    let value = knots[index] + (knots[next] - knots[index]) * (position - index as f64);
    crop * radius * (1.0 + value / SPLINE_UNIT)
}

/// `sample_radius(r) / r` sampled over r^2, which is the form the warp wants: it
/// has dx and dy so it has r^2 for free, and the table skips a sqrt, a walk along
/// the spline and a division at every pixel.
fn ratio_table(knots: &[f64], crop: f64) -> Vec<f64> {
    (0..=RATIO_TABLE_LAST)
        .map(|slot| {
            let radius = (slot as f64 / RATIO_TABLE_LAST as f64).sqrt();
            // At the centre the ratio is the crop alone: the spline is anchored at
            // zero there, and dividing a zero radius by itself is not defined.
            if radius == 0.0 { crop } else { sample_radius(knots, radius, crop) / radius }
        })
        .collect()
}

/// Bilinear resample of `source` onto a width x height grid through a radial
/// model. Direction is unchanged by a radial model, so scaling dx and dy by the
/// ratio is the whole transform.
pub fn warp(source: RgbRef<'_>, width: usize, height: usize, knots: &[f64], crop: f64) -> Rgb {
    let mut out = vec![0u8; width * height * 3];
    let half = ((width as f64 / 2.0).powi(2) + (height as f64 / 2.0).powi(2)).sqrt();
    let ratios = ratio_table(knots, crop);
    let (sw, sh) = (source.width, source.height);
    let (scale_x, scale_y) = (sw as f64 / width as f64, sh as f64 / height as f64);
    let (centre_x, centre_y) = (sw as f64 / 2.0, sh as f64 / 2.0);
    let (step_x, step_y) = (half * scale_x, half * scale_y);
    let (edge_x, edge_y) = ((sw - 1) as f64, (sh - 1) as f64);

    for y in 0..height {
        let dy = (y as f64 - height as f64 / 2.0) / half;
        let dy2 = dy * dy;
        for x in 0..width {
            let dx = (x as f64 - width as f64 / 2.0) / half;
            let t = (dx * dx + dy2) * RATIO_TABLE_LAST as f64;
            let slot = if t < RATIO_TABLE_LAST as f64 { t as usize } else { RATIO_TABLE_LAST - 1 };
            let low = ratios[slot];
            let ratio = low + (ratios[slot + 1] - low) * (t - slot as f64);
            let px = centre_x + dx * ratio * step_x;
            let py = centre_y + dy * ratio * step_y;
            let o = (y * width + x) * 3;
            if px < 0.0 || py < 0.0 || px >= edge_x || py >= edge_y {
                continue;
            }
            let (x0, y0) = (px as usize, py as usize);
            let (fx, fy) = (px - x0 as f64, py - y0 as f64);
            let i00 = (y0 * sw + x0) * 3;
            let i01 = i00 + sw * 3;
            for c in 0..3 {
                out[o + c] = (source.data[i00 + c] as f64 * (1.0 - fx) * (1.0 - fy)
                    + source.data[i00 + 3 + c] as f64 * fx * (1.0 - fy)
                    + source.data[i01 + c] as f64 * (1.0 - fx) * fy
                    + source.data[i01 + 3 + c] as f64 * fx * fy) as u8;
            }
        }
    }
    Rgb { width, height, data: out }
}

/// `warp` over any sample type, for the HDR path.
///
/// The SDR fit is 8-bit throughout, but the HDR one works on 16-bit scene-linear
/// samples and on the f64 planes it derives from them. Two copies of a warp is two
/// places for a sign to be wrong in, so the arithmetic lives here once and the
/// caller supplies the conversions.
///
/// A row at a time across cores. `warp` deliberately is not: it runs inside the fit's
/// own candidate scan, which is already parallel.
#[allow(clippy::too_many_arguments)]
pub fn warp_planar<T: Copy + Default + Send + Sync>(
    src: &[T],
    source_width: usize,
    source_height: usize,
    width: usize,
    height: usize,
    knots: &[f64],
    crop: f64,
    to_f64: impl Fn(T) -> f64 + Sync,
    from_f64: impl Fn(f64) -> T + Sync,
) -> Vec<T> {
    let mut out = vec![T::default(); width * height * 3];
    let half = ((width as f64 / 2.0).powi(2) + (height as f64 / 2.0).powi(2)).sqrt();
    let ratios = ratio_table(knots, crop);
    let (sw, sh) = (source_width, source_height);
    let (scale_x, scale_y) = (sw as f64 / width as f64, sh as f64 / height as f64);
    let (centre_x, centre_y) = (sw as f64 / 2.0, sh as f64 / 2.0);
    let (step_x, step_y) = (half * scale_x, half * scale_y);
    let (edge_x, edge_y) = ((sw - 1) as f64, (sh - 1) as f64);

    out.par_chunks_mut(width * 3).enumerate().for_each(|(y, row)| {
        let dy = (y as f64 - height as f64 / 2.0) / half;
        let dy2 = dy * dy;
        for x in 0..width {
            let dx = (x as f64 - width as f64 / 2.0) / half;
            let t = (dx * dx + dy2) * RATIO_TABLE_LAST as f64;
            let slot = if t < RATIO_TABLE_LAST as f64 { t as usize } else { RATIO_TABLE_LAST - 1 };
            let low = ratios[slot];
            let ratio = low + (ratios[slot + 1] - low) * (t - slot as f64);
            let px = centre_x + dx * ratio * step_x;
            let py = centre_y + dy * ratio * step_y;
            if px < 0.0 || py < 0.0 || px >= edge_x || py >= edge_y {
                continue;
            }
            let (x0, y0) = (px as usize, py as usize);
            let (fx, fy) = (px - x0 as f64, py - y0 as f64);
            let i00 = (y0 * sw + x0) * 3;
            let i01 = i00 + sw * 3;
            for c in 0..3 {
                row[x * 3 + c] = from_f64(
                    to_f64(src[i00 + c]) * (1.0 - fx) * (1.0 - fy)
                        + to_f64(src[i00 + 3 + c]) * fx * (1.0 - fy)
                        + to_f64(src[i01 + c]) * (1.0 - fx) * fy
                        + to_f64(src[i01 + 3 + c]) * fx * fy,
                );
            }
        }
    });
    out
}

/// Box-average downscale of 16-bit interleaved RGB, in whatever light the samples
/// are already in.
///
/// On a scene-linear decode that means averaging light, which is the only correct way
/// to shrink one: averaging after a transfer curve has been applied averages code
/// values instead, and darkens. Every source pixel contributes exactly once, so there
/// is no ringing either.
///
/// Only downscales; asking for a larger size returns None, since this exists to avoid
/// work rather than to invent detail.
pub fn box_resize_u16(
    src: &[u16],
    sw: usize,
    sh: usize,
    width: usize,
    height: usize,
) -> Option<Vec<u16>> {
    if width >= sw || height >= sh {
        return None;
    }
    let mut out = vec![0u16; width * height * 3];
    let xs = sw as f64 / width as f64;
    let ys = sh as f64 / height as f64;
    // A row at a time across cores: this reads every sample of the decode, which on a
    // 61MP frame is 183M of them for one 3840px rendition.
    out.par_chunks_mut(width * 3).enumerate().for_each(|(dy, out_row)| {
        let y0 = (dy as f64 * ys).floor() as usize;
        let y1 = (((dy + 1) as f64 * ys).floor() as usize).max(y0 + 1);
        for dx in 0..width {
            let x0 = (dx as f64 * xs).floor() as usize;
            let x1 = (((dx + 1) as f64 * xs).floor() as usize).max(x0 + 1);
            let mut acc = [0.0f64; 3];
            for y in y0..y1 {
                let row = y * sw;
                for x in x0..x1 {
                    let i = (row + x) * 3;
                    for c in 0..3 {
                        acc[c] += f64::from(src[i + c]);
                    }
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f64;
            for c in 0..3 {
                out_row[dx * 3 + c] = (acc[c] / n).round() as u16;
            }
        }
    });
    Some(out)
}

/// An 8-bit or 16-bit sample, so one denoise and one sharpen serve the SDR renditions
/// and the HDR ones alike (§10.9).
pub trait Sample: Copy + Default + Send + Sync {
    const FULL: f32;
    fn to_f32(self) -> f32;
    fn from_f32(value: f32) -> Self;
}

impl Sample for u8 {
    const FULL: f32 = 255.0;
    fn to_f32(self) -> f32 {
        f32::from(self)
    }
    fn from_f32(value: f32) -> u8 {
        value.clamp(0.0, 255.0).round() as u8
    }
}

impl Sample for u16 {
    const FULL: f32 = 65535.0;
    fn to_f32(self) -> f32 {
        f32::from(self)
    }
    fn from_f32(value: f32) -> u16 {
        value.clamp(0.0, 65535.0).round() as u16
    }
}

/// The blur the sharpen deconvolves, as a Gaussian sigma in output pixels.
///
/// This is **capture sharpening's** question, not creative sharpening's: what spread did
/// the resample, the demosaic and the lens put on a point, and can it be taken back off.
/// A Lanczos3 downscale to the rendition's size is most of it here. RawTherapee's
/// equivalent defaults near this and uses a 5x5 kernel below radius 0.84, which is what
/// the tap count works out to.
const DECONVOLVE_SIGMA: f32 = 0.7;

/// Richardson-Lucy iterations.
///
/// The count *is* the regularisation: RL converges towards inverting the blur exactly,
/// which on a noisy frame means converging on the noise too, so it is stopped early. Ten
/// recovers most of the edge and leaves flat areas alone; past about twenty, grain starts
/// to sharpen into speckle.
const DECONVOLVE_ITERATIONS: usize = 10;

/// Half-width of the point spread, in pixels. See `gaussian`.
const DECONVOLVE_RADIUS: usize = 2;

/// BT.709's luma weights, used on a Rec.2020 frame too.
///
/// They decide how much of an edge each channel is credited with and which part of a
/// pixel counts as its colour, not what colour anything is; the two sets differ by less
/// than either knob here does.
const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];

/// Normalised Gaussian taps for `sigma`, from the centre outwards, out to `radius`.
///
/// The radius is given rather than derived from the sigma because the point spread this
/// deconvolves is truncated on purpose: a 3-sigma tail contributes a thousandth of the
/// kernel and costs a third of every convolution, and this one runs forty times. Two is
/// the 5x5 RawTherapee uses below radius 0.84.
fn gaussian(sigma: f32, radius: usize) -> Vec<f32> {
    let taps: Vec<f32> =
        (0..=radius).map(|d| (-((d * d) as f32) / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f32 = taps[0] + 2.0 * taps[1..].iter().sum::<f32>();
    taps.into_iter().map(|t| t / sum).collect()
}

/// Separable Gaussian convolution of one plane, edges clamped.
fn convolve(plane: &[f32], width: usize, height: usize, taps: &[f32]) -> Vec<f32> {
    let mut horizontal: Vec<f32> = vec![0.0; width * height];
    horizontal.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        let source = &plane[y * width..(y + 1) * width];
        for (x, out) in row.iter_mut().enumerate() {
            let mut acc = taps[0] * source[x];
            for (d, tap) in taps.iter().enumerate().skip(1) {
                acc += tap * (source[x.saturating_sub(d)] + source[(x + d).min(width - 1)]);
            }
            *out = acc;
        }
    });

    let mut out: Vec<f32> = vec![0.0; width * height];
    out.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        for (x, sample) in row.iter_mut().enumerate() {
            let mut acc = taps[0] * horizontal[y * width + x];
            for (d, tap) in taps.iter().enumerate().skip(1) {
                let up = y.saturating_sub(d) * width + x;
                let down = (y + d).min(height - 1) * width + x;
                acc += tap * (horizontal[up] + horizontal[down]);
            }
            *sample = acc;
        }
    });
    out
}

/// Richardson-Lucy deconvolution of `observed` against a Gaussian point spread.
///
/// **This is what makes the sharpen more than an unsharp mask.** A mask adds a scaled
/// copy of the high frequencies back, which raises contrast either side of an edge and
/// leaves the overshoot behind as a halo. Deconvolution asks the other question - what
/// image, blurred by this kernel, would have produced the one in hand - and iterates
/// towards the answer, so an edge comes back *steeper* rather than merely higher
/// contrast, and it does not overshoot to get there.
///
/// The update is RL's own: divide the observation by the current estimate re-blurred,
/// blur that ratio, and scale the estimate by it. A Gaussian is symmetric, so the
/// adjoint convolution is the same one.
fn deconvolve(observed: &[f32], width: usize, height: usize, taps: &[f32], iterations: usize) -> Vec<f32> {
    // Away from zero, since the update divides by the estimate's own blur. A frame in
    // 0..1 with true blacks would otherwise produce infinities on the first pass.
    const FLOOR: f32 = 1e-4;
    let mut estimate: Vec<f32> = observed.par_iter().map(|v| v.max(FLOOR)).collect();
    for _ in 0..iterations {
        let blurred = convolve(&estimate, width, height, taps);
        let ratio: Vec<f32> = blurred
            .par_iter()
            .zip(observed.par_iter())
            .map(|(b, o)| o.max(FLOOR) / b.max(FLOOR))
            .collect();
        let correction = convolve(&ratio, width, height, taps);
        estimate.par_iter_mut().zip(correction.par_iter()).for_each(|(e, c)| *e *= c);
    }

    // **Anti-ringing, and it is not optional.** RL converges on the maximum-likelihood
    // inverse, and for a band-limited kernel against a hard edge that solution rings:
    // measured on a step from 60 to 180, ten iterations undershot to 54. Clamping each
    // output to the range its own neighbourhood already spanned removes the overshoot
    // while leaving every recovery *within* that range untouched - which is all of the
    // sharpening and none of the halo.
    let (low, high) = local_extrema(observed, width, height, taps.len() - 1);
    estimate
        .par_iter_mut()
        .zip(low.par_iter().zip(high.par_iter()))
        .for_each(|(e, (l, h))| *e = e.clamp(*l, *h));
    estimate
}

/// The smallest and largest sample within `radius` of each pixel, separably.
///
/// Separable because min and max are, like a mean: the extremum of a square window is the
/// extremum over columns of the extrema over rows.
fn local_extrema(plane: &[f32], width: usize, height: usize, radius: usize) -> (Vec<f32>, Vec<f32>) {
    let sweep = |plane: &[f32], keep_low: bool| {
        let pick = |a: f32, b: f32| if keep_low { a.min(b) } else { a.max(b) };
        let mut horizontal: Vec<f32> = vec![0.0; width * height];
        horizontal.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
            let source = &plane[y * width..(y + 1) * width];
            for (x, out) in row.iter_mut().enumerate() {
                let low = x.saturating_sub(radius);
                let high = (x + radius).min(width - 1);
                *out = source[low..=high].iter().copied().fold(source[x], pick);
            }
        });
        let mut out: Vec<f32> = vec![0.0; width * height];
        out.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
            let low = y.saturating_sub(radius);
            let high = (y + radius).min(height - 1);
            for (x, sample) in row.iter_mut().enumerate() {
                let mut value = horizontal[y * width + x];
                for j in low..=high {
                    value = pick(value, horizontal[j * width + x]);
                }
                *sample = value;
            }
        });
        out
    };
    (sweep(plane, true), sweep(plane, false))
}

/// Mean over a (2r+1) square, in constant time per pixel whatever the radius.
///
/// A sliding sum rather than a convolution: each step adds the column entering the
/// window and subtracts the one leaving it, so the cost does not grow with the radius at
/// all. That is what makes the guided filter below affordable at a radius where a
/// Gaussian would not be - and it is why the filter is written against box means rather
/// than the nicer-looking Gaussian.
///
/// The window shrinks at the border rather than clamping the samples, so an edge pixel
/// is the mean of what is actually there instead of one sample counted several times.
fn box_mean(plane: &[f32], width: usize, height: usize, radius: usize) -> Vec<f32> {
    let mut horizontal: Vec<f32> = vec![0.0; width * height];
    horizontal.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        let source = &plane[y * width..(y + 1) * width];
        let mut sum: f32 = source[..=radius.min(width - 1)].iter().sum();
        for x in 0..width {
            let low = x.saturating_sub(radius);
            let high = (x + radius).min(width - 1);
            row[x] = sum / (high - low + 1) as f32;
            if x + radius + 1 < width {
                sum += source[x + radius + 1];
            }
            if x >= radius {
                sum -= source[x - radius];
            }
        }
    });

    // Vertically in bands rather than a column at a time. A column sweep strides the
    // whole row width per step and misses the cache on every one; a band walks rows in
    // order, carrying one accumulator row, and each band is independent so they still
    // run across cores. The cost is re-seeding the accumulator per band, which is
    // `radius` extra row additions.
    let band = height.div_ceil(rayon::current_num_threads().max(1)).max(1);
    let mut out: Vec<f32> = vec![0.0; width * height];
    out.par_chunks_mut(band * width).enumerate().for_each(|(index, rows)| {
        let first = index * band;
        let last = (first + rows.len() / width).min(height);
        let mut acc: Vec<f32> = vec![0.0; width];
        // The window for the band's first row, which reaches above the band.
        for y in first.saturating_sub(radius)..=(first + radius).min(height - 1) {
            for x in 0..width {
                acc[x] += horizontal[y * width + x];
            }
        }
        for y in first..last {
            let low = y.saturating_sub(radius);
            let high = (y + radius).min(height - 1);
            let count = (high - low + 1) as f32;
            let row = &mut rows[(y - first) * width..(y - first + 1) * width];
            for x in 0..width {
                row[x] = acc[x] / count;
            }
            if y + radius + 1 < height {
                for x in 0..width {
                    acc[x] += horizontal[(y + radius + 1) * width + x];
                }
            }
            if y >= radius {
                for x in 0..width {
                    acc[x] -= horizontal[(y - radius) * width + x];
                }
            }
        }
    });
    out
}

/// He, Sun and Tang's guided filter: `input` smoothed wherever `guide` is flat, left
/// alone wherever `guide` has an edge.
///
/// Every window gets the linear fit `q = a*guide + b` that best explains `input` there,
/// with `a` damped by `eps`. Where the guide varies a lot - an edge - `a` goes to 1 and
/// the output follows the guide; where it barely varies, `a` goes to 0 and the output is
/// the local mean. So the smoothing is *steered by structure* rather than by distance,
/// which is what a Gaussian cannot do and a bilateral filter pays dearly for.
///
/// Two uses here, and they are the two this module needs:
///
/// - **Guide the chroma with luma.** Colour then follows the edges the eye is actually
///   reading, so the radius can go far past where a plain blur would wash red across a
///   white window frame. It is the filter's canonical application.
/// - **Guide luma with itself** and subtract, which is an unsharp mask whose base layer
///   respects edges - so it has no halo to speak of, and `eps` doubles as the noise
///   floor: detail below that amplitude stays in the base and is never boosted.
///
/// Planes are in 0..1, so `eps` is a variance in those units and means the same thing
/// at either depth. Six box means, all O(1) in the radius.
/// The part of a guided filter that depends only on the guide.
///
/// Split out because both chroma channels are guided by the same luma, and computing
/// this twice is two box means and a whole-frame product for an answer already in hand.
struct Guide {
    mean: Vec<f32>,
    variance: Vec<f32>,
}

fn guide_stats(guide: &[f32], width: usize, height: usize, radius: usize) -> Guide {
    let pixels = width * height;
    let mean = box_mean(guide, width, height, radius);
    // Scoped so the squares and their mean are freed here rather than at the end of the
    // function. Every plane is a whole frame - 39MB at a 3840px rendition, 96MB at 24MP
    // native - and Rust holds a temporary to the end of its scope rather than to its last
    // use, so on this path scoping is most of the memory (§10.9).
    let variance = {
        let squares: Vec<f32> = (0..pixels).into_par_iter().map(|i| guide[i] * guide[i]).collect();
        let mean_squares = box_mean(&squares, width, height, radius);
        drop(squares);
        (0..pixels).into_par_iter().map(|i| mean_squares[i] - mean[i] * mean[i]).collect()
    };
    Guide { mean, variance }
}

/// Applies the local linear fit and averages it back out. The tail of `guided`, taking
/// the guide's own statistics as already computed.
fn guided_with(
    stats: &Guide,
    guide: &[f32],
    mean_input: &[f32],
    covariance: &[f32],
    width: usize,
    height: usize,
    radius: usize,
    eps: f32,
) -> Vec<f32> {
    let pixels = width * height;
    // `a` is the covariance over the variance, which is the slope of the fit, and `eps`
    // is what stops a window of pure noise producing a confident one.
    let a: Vec<f32> = (0..pixels)
        .into_par_iter()
        .map(|i| {
            // A window with no variance and no regularisation is 0/0. It happens
            // whenever a flat region meets a noise estimate of zero, which a synthetic
            // input produces immediately and a photograph never does - so it is a NaN
            // that reaches production long after it stops being findable. No variance
            // means no structure to follow, which is a slope of zero.
            let denominator = stats.variance[i] + eps;
            match denominator > f32::EPSILON {
                true => covariance[i] / denominator,
                false => 0.0,
            }
        })
        .collect();
    // Averaged again because a pixel sits in many windows and each has its own fit.
    // Scoped so the fits are freed before the output plane is built.
    let (mean_a, mean_b) = {
        let b: Vec<f32> =
            (0..pixels).into_par_iter().map(|i| mean_input[i] - a[i] * stats.mean[i]).collect();
        let mean_a = box_mean(&a, width, height, radius);
        drop(a);
        (mean_a, box_mean(&b, width, height, radius))
    };
    (0..pixels).into_par_iter().map(|i| mean_a[i] * guide[i] + mean_b[i]).collect()
}

/// One channel of `input`, smoothed under `guide`'s edges.
fn guided(
    stats: &Guide,
    guide: &[f32],
    input: &[f32],
    width: usize,
    height: usize,
    radius: usize,
    eps: f32,
) -> Vec<f32> {
    let pixels = width * height;
    let mean_input = box_mean(input, width, height, radius);
    // Scoped for the same reason as `guide_stats`: the cross product and its mean are
    // dead the moment the covariance exists, and both are whole frames.
    let covariance: Vec<f32> = {
        let cross: Vec<f32> = (0..pixels).into_par_iter().map(|i| guide[i] * input[i]).collect();
        let mean_cross = box_mean(&cross, width, height, radius);
        drop(cross);
        (0..pixels)
            .into_par_iter()
            .map(|i| mean_cross[i] - stats.mean[i] * mean_input[i])
            .collect()
    };
    guided_with(stats, guide, &mean_input, &covariance, width, height, radius, eps)
}

/// `guide` smoothed under its own edges, which is the filter's denoising form.
///
/// Half the work of the general case rather than a convenience: guided by itself, the
/// input's mean *is* the guide's mean and the covariance *is* the variance, so four of
/// the six box means collapse into two already computed.
fn self_guided(
    stats: &Guide,
    guide: &[f32],
    width: usize,
    height: usize,
    radius: usize,
    eps: f32,
) -> Vec<f32> {
    guided_with(stats, guide, &stats.mean, &stats.variance, width, height, radius, eps)
}

/// How closely the chroma is made to follow the luma's edges.
///
/// Small, because the guide is trusted: chroma genuinely has no structure of its own
/// that luma does not also have, so anywhere luma is flat the colour should be smoothed
/// as hard as the radius allows.
const DENOISE_EPS: f32 = 1e-4;

/// Radii the chroma denoise fits its local model over at `raw_denoise` 1, in pixels.
///
/// **Two scales, because chroma noise has two.** The fine one is per-pixel speckle. The
/// coarse one is low-frequency mottle - patches of green and magenta the size of a
/// window, which a demosaic spreads and an amplified read leaves behind - and a radius
/// that clears the speckle cannot touch it, because a 9-pixel window cannot average away
/// a 40-pixel blotch. The first pass took the speckle out and left exactly that.
///
/// Cascading is affordable only because the filter is O(1) in the radius: the 32 costs
/// what the 4 does. A Gaussian at that radius would be 97 taps a pixel and out of the
/// question, which is most of why the filter underneath is the one it is.
const DENOISE_CHROMA_RADII: [usize; 2] = [4, 32];

/// The most the coarse chroma pass may move a colour, as a fraction of full scale.
///
/// **The luma guide is not enough on its own at this radius**, and finding out why is
/// worth writing down: it can only protect an edge it can *see*. A red wall meeting a
/// grey roof is a large step in colour and a small one in luma, so a 65-pixel window
/// spanning both fits one linear model across the pair and pours red onto the roof.
///
/// Amplitude separates the two cases where the guide cannot. Low-frequency chroma noise
/// is a couple of percent; a wall against a roof is tens of percent. So the coarse pass
/// is allowed to remove a blotch and not to restructure a picture - the same shape of
/// guard as the deconvolution's anti-ringing clamp, and for the same reason.
const DENOISE_CHROMA_COARSE_LIMIT: f32 = 0.02;

/// Radius the luma denoise fits its local model over, in pixels.
///
/// **Set by how well the window can estimate a variance, not by how much of the picture
/// it should see.** The filter's blend is `var / (var + eps)`, so it is deciding "flat or
/// detail" from a variance measured over the window - and a variance from n samples is
/// itself uncertain by about `sqrt(2/n)`. A radius of 2 is 25 samples and 29% uncertain,
/// which lands as *patchy smoothing*: neighbouring parts of one roof come out blurred or
/// grainy depending on which way the estimate happened to fall, and that reads worse than
/// the grain it was removing. 6 is 169 samples and 11%, which is uniform.
///
/// The window being wider does not blur more. What it may not do is *resolve* detail
/// narrower than itself as detail, which is why this is not wider still.
const LUMA_DENOISE_RADIUS: usize = 6;

/// How many standard deviations of the estimated noise count as "still noise".
///
/// The luma denoise is a self-guided filter, so its `eps` is a variance and this is what
/// that variance is expressed in. A window of pure noise blends at `1 / (1 + k^2)`, so
/// this is directly how much of the grain survives: 2 leaves a fifth of it, 1.4 leaves a
/// third.
///
/// **1.4, deliberately short of what the metric would pick.** At 2 the numbers are better
/// and a dark roof at 100% has visibly lost its shingle texture along with its grain -
/// and between the two, grain is the one that reads as a photograph and smearing is the
/// one that reads as a fault. Luma is the plane where being wrong is expensive, so it is
/// tuned to be wrong in the recoverable direction.
const LUMA_DENOISE_SIGMAS: f32 = 1.4;

/// Bins in the noise estimate's histogram, over a high-pass magnitude of 0..`NOISE_MAX`.
const NOISE_BINS: usize = 1024;
const NOISE_MAX: f32 = 0.08;

/// The frame's own noise level, as a standard deviation in 0..1 luma units.
///
/// **Estimated rather than derived from the ISO**, which is the better of the two even
/// though the ISO is right there: a frame's noise depends on the exposure it was pushed
/// from and how much the grade lifted it, and by this point in the pipeline it has also
/// been through a resample that averaged some of it away. The number wanted is the noise
/// *in the frame in hand*, and the frame can be asked.
///
/// The estimator is the standard one from wavelet shrinkage: take a high-pass residual,
/// and read its **median** absolute value rather than its mean. A median is what makes it
/// work on a photograph - edges and texture are a minority of pixels and arbitrarily
/// large, so they drag a mean anywhere, while the median sits among the ordinary pixels
/// where the only signal is noise. The 1.4826 recovers a Gaussian sigma from that median.
///
/// **The median is taken over the pixels that vary at all**, not over the whole frame,
/// and that is a correctness fix rather than a refinement. A pixel whose residual is
/// *exactly* zero is not a quiet noise sample; it is a pixel with no high-frequency
/// content whatsoever - clipped sky, a black letterbox, a blown highlight - and it says
/// nothing about the noise. Counting them, a frame that is half blown sky puts the median
/// in that flat half and reports **zero noise**, which sets `eps` to zero and turns the
/// entire luma denoise into an identity. It is a cliff rather than a taper: 40% sky
/// denoises fully, 45% not at all.
///
/// Ceilinged for the opposite case. A frame that is *mostly* fine detail - a wall of
/// close stripes - has a large median residual that is signal rather than noise, and
/// without a ceiling the filter smooths luma to its local mean and takes the detail with
/// it. Sensor noise surviving a demosaic and a resample does not reach 2% of full scale,
/// so past that this is reading texture and should stop believing itself.
const NOISE_CEILING: f32 = 0.02;

#[cfg(all(test, feature = "fixtures"))]
pub fn _for_testing_measure_noise<T: Sample>(frame: &[T], width: usize, height: usize) -> f32 {
    measure_noise(frame, width, height, strip_interior(width, 0))
}

/// The estimate, off a histogram of high-pass magnitudes.
///
/// Split from the pass that fills it so the whole frame's histogram can be accumulated
/// strip by strip: the estimate has to be global or each strip would denoise by a
/// different amount and seam, but nothing about it needs the frame resident at once.
fn sigma_from(bins: &[u32]) -> f32 {
    // Bin 0 is a residual under 0.008% of full scale, which is below a quantisation step
    // at any depth this runs at - so it is the "did not vary at all" bin, and the median
    // is taken over everything above it.
    let varying: u32 = bins[1..].iter().sum();
    if varying == 0 {
        return 0.0;
    }
    let half = varying / 2;
    let mut seen = 0u32;
    let median = bins[1..]
        .iter()
        .position(|count| {
            seen += count;
            seen >= half
        })
        .map(|slot| slot + 1)
        .unwrap_or(1) as f32
        * NOISE_MAX
        / NOISE_BINS as f32;
    // The residual of a 3x3 mean keeps most of a pixel's own noise but not all of it,
    // and the median of a half-normal is 0.6745 sigma. Both are folded in here.
    (median * 1.4826 / 0.83).min(NOISE_CEILING)
}

/// The luma of one interleaved RGB pixel, in 0..1.
fn luma_of<T: Sample>(p: &[T]) -> f32 {
    (LUMA[0] * p[0].to_f32() + LUMA[1] * p[1].to_f32() + LUMA[2] * p[2].to_f32()) / T::FULL
}

/// Denoise and sharpen a rendered frame in place, at the size it will be encoded at.
///
/// Three stages over one deinterleave, in an order that is not interchangeable (§10.9):
///
/// 1. **Luma denoise**, a self-guided filter whose `eps` is the frame's own measured
///    noise. Here the guided filter is used the way round it was designed for: a window
///    that varies by less than the noise is smoothed to its mean, one holding an edge
///    keeps it. Luma was left untouched at first on the theory that grain reads as
///    texture. On a working-ISO frame it reads as dirt, and it is what remains
///    objectionable once the colour mottle is gone.
/// 2. **Chroma denoise**, guided by the luma just cleaned. Colour noise is blotchy where
///    luma noise is per-pixel, so it takes a far wider radius - and guiding it by luma is
///    what lets the radius grow without washing the red of a wall onto the white window
///    frames beside it. It is the guided filter's canonical application.
/// 3. **Sharpen**, by deconvolution, on the cleaned luma. Denoising first is not a
///    preference: Richardson-Lucy has no noise model and will happily invert grain as if
///    it were blur, so anything left in luma at this point is sharpened into speckle.
///
/// `denoise` scales the first two, `sharpen` blends the third. Both are 0 for off, and
/// the whole thing is skipped when neither is asked for.
///
/// Whatever transfer the samples are already in, and that is a constraint on the caller
/// rather than a detail: differences taken in linear light are proportional to absolute
/// luminance, so they treat a highlight and a shadow completely differently. Both callers
/// hand over display-referred samples - sRGB for a rendition, PQ for the HDR pair - which
/// is where a difference means what the eye reads.
/// The radii every stage works over, which between them decide how far a strip has to
/// reach past its own rows (§10.9).
struct Radii {
    luma: usize,
    fine: usize,
    coarse: usize,
}

impl Radii {
    fn for_strength(denoise: f64) -> Radii {
        let [fine, coarse] = DENOISE_CHROMA_RADII;
        let scaled = |base: usize| (base as f64 * denoise).round().max(1.0) as usize;
        Radii { luma: LUMA_DENOISE_RADIUS, fine: scaled(fine), coarse: scaled(coarse) }
    }

    /// Rows a strip must carry beyond its own, above and below, for its output to be
    /// what a whole-frame run would have produced.
    ///
    /// **A guided filter of radius r reaches 2r, not r**: it box-means the input and then
    /// box-means the fit, so the support is the two composed. The chroma path composes
    /// three of them - it is guided by a luma that was itself filtered, then filtered
    /// again at the coarse radius - so the reaches add. Richardson-Lucy adds the point
    /// spread once per convolution, twice per iteration, and the anti-ringing clamp adds
    /// its own window on top.
    fn halo(&self, denoise: bool, sharpen: bool) -> usize {
        let chroma = match denoise {
            true => 2 * (self.luma + self.fine + self.coarse),
            false => 0,
        };
        let deconvolve = match sharpen {
            true => 2 * DECONVOLVE_RADIUS * DECONVOLVE_ITERATIONS + DECONVOLVE_RADIUS
                + if denoise { 2 * self.luma } else { 0 },
            false => 0,
        };
        chroma.max(deconvolve)
    }
}

/// Rows of a strip that are kept, chosen to bound the scratch the stages allocate.
///
/// The stages hold on the order of a dozen `f32` planes of whatever they are handed, so
/// the only thing that bounds them is how many rows they are handed. This trades a little
/// duplicated work at the seams - each strip also computes its halo, and throws it away -
/// for a peak that does not grow with the frame.
fn strip_interior(width: usize, halo: usize) -> usize {
    // ~64MB of scratch at a dozen planes, which is small beside the encoders that follow
    // and large enough that the halo is a minority of most strips.
    const SCRATCH_BUDGET: usize = 64 * 1024 * 1024;
    const PLANES: usize = 12;
    let rows = SCRATCH_BUDGET / (width.max(1) * PLANES * std::mem::size_of::<f32>());
    // Never so thin that a strip is mostly halo, whatever the width.
    rows.max(halo).max(32)
}

pub fn finish<T: Sample>(frame: &mut [T], width: usize, height: usize, denoise: f64, sharpen: f64) {
    let halo = Radii::for_strength(denoise).halo(denoise > 0.0, sharpen > 0.0);
    finish_in_strips(frame, width, height, denoise, sharpen, strip_interior(width, halo));
}

/// `finish`, over strips of a given height.
///
/// The height is a parameter only so a test can drive the same frame through one strip
/// and through several and require the same answer - which is the property the halo
/// exists for, and cannot be checked by shrinking the frame instead, because the noise
/// estimate is global and a shorter frame is a different measurement.
fn finish_in_strips<T: Sample>(
    frame: &mut [T],
    width: usize,
    height: usize,
    denoise: f64,
    sharpen: f64,
    interior: usize,
) {
    if (denoise <= 0.0 && sharpen <= 0.0) || width < 3 || height < 3 || frame.len() < width * height * 3 {
        return;
    }
    // Bounded to what the dimensions claim, so a caller passing a longer buffer gets the
    // frame processed rather than a chunk indexed past the end of the planes.
    let frame = &mut frame[..width * height * 3];
    let radii = Radii::for_strength(denoise);
    let halo = radii.halo(denoise > 0.0, sharpen > 0.0);
    let interior = interior.max(1);

    // Measured over the whole frame before anything is filtered, because a per-strip
    // estimate would have each strip denoise by a different amount and seam.
    let sigma = match denoise > 0.0 {
        true => measure_noise(frame, width, height, interior) * denoise as f32,
        false => 0.0,
    };

    // The rows a strip overwrites are the next strip's context, so the originals of the
    // last `halo` of them are kept back before the write. Small - `halo` rows of the
    // frame, against the planes this exists to bound.
    let mut carry: Vec<T> = Vec::new();
    let mut start = 0;
    while start < height {
        let end = (start + interior).min(height);
        let top = start.saturating_sub(halo);
        let bottom = (end + halo).min(height);
        let rows = bottom - top;

        let (mut luma, mut red, mut blue) = deinterleave(frame, &carry, width, top, start, bottom);
        finish_strip(&mut luma, &mut red, &mut blue, width, rows, &radii, sigma, denoise, sharpen);

        // Before the write, since the write is what destroys them.
        carry = keep_back(frame, width, end.saturating_sub(halo), end);
        recombine(frame, &luma, &red, &blue, width, top, start, end);
        start = end;
    }
}

/// The three planes for one strip, in 0..1, with rows above `start` taken from `carry`
/// where a previous strip has already overwritten them.
fn deinterleave<T: Sample>(
    frame: &[T],
    carry: &[T],
    width: usize,
    top: usize,
    start: usize,
    bottom: usize,
) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let rows = bottom - top;
    let mut luma: Vec<f32> = vec![0.0; width * rows];
    let mut red: Vec<f32> = vec![0.0; width * rows];
    let mut blue: Vec<f32> = vec![0.0; width * rows];
    // `carry` holds the rows [start - carried, start) as they were before the previous
    // strip wrote over them.
    let carried = carry.len() / (width * 3);
    luma.par_chunks_mut(width)
        .zip(red.par_chunks_mut(width))
        .zip(blue.par_chunks_mut(width))
        .enumerate()
        .for_each(|(row, ((luma_row, red_row), blue_row))| {
            let y = top + row;
            for x in 0..width {
                let p = match y < start && carried > 0 {
                    true => &carry[((y - (start - carried)) * width + x) * 3..],
                    false => &frame[(y * width + x) * 3..],
                };
                let l = luma_of(p);
                luma_row[x] = l;
                red_row[x] = p[0].to_f32() / T::FULL - l;
                blue_row[x] = p[2].to_f32() / T::FULL - l;
            }
        });
    (luma, red, blue)
}

/// A copy of rows `[from, to)` exactly as they stand, to serve as the next strip's
/// context once this strip has written over them.
fn keep_back<T: Sample>(frame: &[T], width: usize, from: usize, to: usize) -> Vec<T> {
    frame[from * width * 3..to * width * 3].to_vec()
}

/// Writes rows `[start, end)` of a processed strip back into the frame.
fn recombine<T: Sample>(
    frame: &mut [T],
    luma: &[f32],
    red: &[f32],
    blue: &[f32],
    width: usize,
    top: usize,
    start: usize,
    end: usize,
) {
    frame[start * width * 3..end * width * 3]
        .par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(row, out)| {
            let i = (start - top + row) * width;
            for x in 0..width {
                let (l, dr, db) = (luma[i + x], red[i + x], blue[i + x]);
                // Solving the luma equation for green with the other two differences
                // known is what makes the recombination exactly luma-preserving.
                let dg = -(LUMA[0] * dr + LUMA[2] * db) / LUMA[1];
                out[x * 3] = T::from_f32((l + dr) * T::FULL);
                out[x * 3 + 1] = T::from_f32((l + dg) * T::FULL);
                out[x * 3 + 2] = T::from_f32((l + db) * T::FULL);
            }
        });
}

/// The frame's noise, measured strip by strip so the estimate costs one plane rather
/// than one per frame.
///
/// The histogram is the whole state carried between strips, and it is 4kB.
fn measure_noise<T: Sample>(frame: &[T], width: usize, height: usize, interior: usize) -> f32 {
    let mut bins = vec![0u32; NOISE_BINS];
    let mut start = 0;
    while start < height {
        // One row of context either side, which is all a radius-1 box mean reaches.
        let end = (start + interior).min(height);
        let top = start.saturating_sub(1);
        let bottom = (end + 1).min(height);
        let rows = bottom - top;
        let mut luma: Vec<f32> = vec![0.0; width * rows];
        luma.par_chunks_mut(width).enumerate().for_each(|(row, out)| {
            for x in 0..width {
                out[x] = luma_of(&frame[((top + row) * width + x) * 3..]);
            }
        });
        let smooth = box_mean(&luma, width, rows, 1);
        for y in start..end {
            let row = (y - top) * width;
            for x in 0..width {
                let residual = (luma[row + x] - smooth[row + x]).abs();
                let slot = (residual / NOISE_MAX * NOISE_BINS as f32) as usize;
                bins[slot.min(NOISE_BINS - 1)] += 1;
            }
        }
        start = end;
    }
    sigma_from(&bins)
}

/// The chain itself, over one strip's planes. `sigma` is the whole frame's, so every
/// strip denoises by the same amount.
#[allow(clippy::too_many_arguments)]
fn finish_strip(
    luma: &mut Vec<f32>,
    red: &mut Vec<f32>,
    blue: &mut Vec<f32>,
    width: usize,
    height: usize,
    radii: &Radii,
    sigma: f32,
    denoise: f64,
    sharpen: f64,
) {
    if denoise > 0.0 {
        let eps = (LUMA_DENOISE_SIGMAS * sigma).powi(2);
        let stats = guide_stats(luma, width, height, radii.luma);
        *luma = self_guided(&stats, luma, width, height, radii.luma, eps);

        // Guided by the luma just cleaned, fine scale then coarse, and both channels off
        // one set of the guide's statistics per scale: same guide, same radius, so the
        // expensive half is shared between them.
        let stats = guide_stats(luma, width, height, radii.fine);
        *red = guided(&stats, luma, red, width, height, radii.fine, DENOISE_EPS);
        *blue = guided(&stats, luma, blue, width, height, radii.fine, DENOISE_EPS);

        let stats = guide_stats(luma, width, height, radii.coarse);
        let limit = DENOISE_CHROMA_COARSE_LIMIT * denoise as f32;
        for channel in [red, blue] {
            let smoothed = guided(&stats, luma, channel, width, height, radii.coarse, DENOISE_EPS);
            channel
                .par_iter_mut()
                .zip(smoothed.par_iter())
                .for_each(|(fine, coarse)| *fine += (coarse - *fine).clamp(-limit, limit));
        }
    }

    if sharpen > 0.0 {
        let taps = gaussian(DECONVOLVE_SIGMA, DECONVOLVE_RADIUS);
        let sharpened = deconvolve(luma, width, height, &taps, DECONVOLVE_ITERATIONS);
        let amount = (sharpen as f32).min(1.0);
        luma.par_iter_mut()
            .zip(sharpened.par_iter())
            .for_each(|(l, s)| *l += amount * (s - *l));
    }
}

/// A radial polynomial as knots, so a fitted model and a camera's own spline are
/// interchangeable everywhere downstream.
pub fn polynomial_knots(k1: f64, k2: f64, count: usize) -> Vec<f64> {
    (0..count)
        .map(|i| {
            let u = i as f64 / (count - 1) as f64;
            let r2 = u * u;
            ((k1 * r2 + k2 * r2 * r2) * SPLINE_UNIT).round()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(width: usize, height: usize) -> Rgb {
        let mut data = vec![0u8; width * height * 3];
        for (i, byte) in data.iter_mut().enumerate() {
            *byte = (i % 251) as u8;
        }
        Rgb { width, height, data }
    }

    #[test]
    fn an_identity_warp_returns_the_picture() {
        let source = ramp(24, 18);
        let out = warp(source.as_ref(), 24, 18, &[], 1.0);
        // The bounds check clears the outermost ring, so compare the interior.
        for y in 2..16 {
            for x in 2..22 {
                let i = (y * 24 + x) * 3;
                assert_eq!(out.data[i], source.data[i], "pixel {x},{y}");
            }
        }
    }

    #[test]
    fn a_crop_below_one_magnifies() {
        // Sampling inside the frame means the output shows less of the scene, which
        // is what the camera's distortion crop does.
        let source = ramp(64, 64);
        let out = warp(source.as_ref(), 64, 64, &[], 0.5);
        let centre = (32 * 64 + 32) * 3;
        assert_eq!(out.data[centre], source.data[centre], "the centre is a fixed point");
        let edge = (32 * 64 + 60) * 3;
        assert_ne!(out.data[edge], source.data[edge], "but the edges must have moved");
    }

    #[test]
    fn the_box_resize_averages_rather_than_samples() {
        // Two-by-two blocks of a known value: an averaging shrink returns the value,
        // a nearest-neighbour one returns whichever corner it happened to land on.
        let (w, h) = (4usize, 4usize);
        let mut src = vec![0u16; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let block = (y / 2) * 2 + (x / 2);
                let i = (y * w + x) * 3;
                for c in 0..3 {
                    src[i + c] = (1000 * (block + 1)) as u16;
                }
            }
        }
        let out = box_resize_u16(&src, w, h, 2, 2).expect("a downscale");
        assert_eq!(out.len(), 2 * 2 * 3);
        for block in 0..4 {
            assert_eq!(out[block * 3], (1000 * (block + 1)) as u16, "block {block}");
        }
    }

    #[test]
    fn the_box_resize_refuses_to_enlarge() {
        // It exists to avoid work, not to invent detail; the caller keeps the original.
        let src = vec![7u16; 8 * 8 * 3];
        assert!(box_resize_u16(&src, 8, 8, 16, 16).is_none());
        assert!(box_resize_u16(&src, 8, 8, 8, 8).is_none(), "the same size is not a downscale");
        assert!(box_resize_u16(&src, 8, 8, 4, 4).is_some());
    }

    #[test]
    fn the_planar_warp_matches_the_8_bit_one() {
        // Two warps is two places for a sign to be wrong in, so the generic form has
        // to agree with the one the SDR fit uses.
        let source = ramp(32, 24);
        let knots = polynomial_knots(-0.03, 0.0, 16);
        let eight = warp(source.as_ref(), 32, 24, &knots, 0.98);
        let planar: Vec<u8> = warp_planar(
            &source.data,
            32,
            24,
            32,
            24,
            &knots,
            0.98,
            |v| f64::from(v),
            |v| v as u8,
        );
        assert_eq!(eight.data, planar);
    }

    /// A step edge down the middle, in grey so every channel carries it.
    fn edge<T: Sample>(width: usize, height: usize, low: f32, high: f32) -> Vec<T> {
        let mut frame = vec![T::default(); width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let value = if x < width / 2 { low } else { high };
                for c in 0..3 {
                    frame[(y * width + x) * 3 + c] = T::from_f32(value);
                }
            }
        }
        frame
    }

    /// A step edge blurred by the same point spread the sharpen deconvolves, which is
    /// what a real edge looks like after a resample.
    fn blurred_edge(width: usize, height: usize, low: f32, high: f32) -> Vec<u8> {
        let plane: Vec<f32> = (0..width * height)
            .map(|i| if i % width < width / 2 { low } else { high })
            .collect();
        let blurred = convolve(&plane, width, height, &gaussian(DECONVOLVE_SIGMA, DECONVOLVE_RADIUS));
        let mut frame = vec![0u8; width * height * 3];
        for (i, value) in blurred.iter().enumerate() {
            for c in 0..3 {
                frame[i * 3 + c] = u8::from_f32(*value);
            }
        }
        frame
    }

    #[test]
    fn the_sharpen_steepens_a_blurred_edge_towards_the_step_it_came_from() {
        // The property an unsharp mask cannot claim: this is measured against the *step*
        // the blur was applied to, so "sharper" means closer to the original rather than
        // merely higher contrast across the transition.
        let (w, h) = (64usize, 8usize);
        let (low, high) = (60.0f32, 180.0f32);
        let mut frame = blurred_edge(w, h, low, high);
        let before = frame.clone();
        finish(&mut frame, w, h, 0.0, 1.0);

        let at = |data: &[u8], x: usize| f32::from(data[(4 * w + x) * 3]);
        let ideal = |x: usize| if x < w / 2 { low } else { high };
        // Every sample across the transition moves towards where the step actually was.
        for x in 30..34 {
            let was = (at(&before, x) - ideal(x)).abs();
            let now = (at(&frame, x) - ideal(x)).abs();
            assert!(now <= was, "column {x}: {was} away, now {now}");
        }
        assert!(at(&frame, 31) < at(&before, 31), "the dark side of the edge");
        assert!(at(&frame, 32) > at(&before, 32), "the light side of the edge");
    }

    #[test]
    fn the_sharpen_does_not_overshoot_the_edge_it_recovers() {
        // What separates deconvolution from a mask. A mask pushes the dark side below
        // where the picture ever went and the light side above it, and that overshoot is
        // the halo. Nothing here may leave the range the original step occupied.
        let (w, h) = (64usize, 8usize);
        let (low, high) = (60.0f32, 180.0f32);
        let mut frame = blurred_edge(w, h, low, high);
        finish(&mut frame, w, h, 0.0, 1.0);
        for x in 24..40 {
            let value = f32::from(frame[(4 * w + x) * 3]);
            assert!(value >= low - 1.0 && value <= high + 1.0, "column {x} reached {value}");
        }
    }

    #[test]
    fn the_sharpen_leaves_a_flat_field_flat() {
        // Nothing to invert means nothing to do, whatever the amount: a converged
        // estimate of a constant is that constant, so flat areas do not gather texture.
        let (w, h) = (32usize, 32usize);
        let mut frame = vec![100u8; w * h * 3];
        let before = frame.clone();
        finish(&mut frame, w, h, 0.0, 1.0);
        assert_eq!(frame, before);
    }

    #[test]
    fn the_sharpen_is_the_same_shape_at_both_depths() {
        // One implementation serves the 8-bit renditions and the 16-bit HDR pair, so
        // the same edge has to come out the same picture at either depth. Compared as
        // fractions of full scale, since that is all the two have in common.
        let (w, h) = (32usize, 8usize);
        let mut eight: Vec<u8> = edge(w, h, 60.0, 180.0);
        let mut sixteen: Vec<u16> = edge(w, h, 60.0 * 257.0, 180.0 * 257.0);
        finish(&mut eight, w, h, 0.0, 1.0);
        finish(&mut sixteen, w, h, 0.0, 1.0);

        for x in 12..20 {
            let a = f32::from(eight[(4 * w + x) * 3]) / 255.0;
            let b = f32::from(sixteen[(4 * w + x) * 3]) / 65535.0;
            assert!((a - b).abs() < 0.006, "column {x}: {a} against {b}");
        }
    }

    /// Coloured speckle at **constant luma**, which is what sensor chroma noise is once
    /// the demosaic has spread it.
    ///
    /// Built from the colour differences rather than by nudging red and blue directly,
    /// and that distinction is the whole test: nudging them leaves a luma checkerboard
    /// behind, and a denoise guided by luma will correctly refuse to smooth colour that
    /// sits on real luma structure. The first version of this fixture did exactly that
    /// and made a working filter look broken.
    fn speckled(width: usize, height: usize) -> Vec<u8> {
        let mut frame = vec![0u8; width * height * 3];
        for i in 0..width * height {
            // Alternating, not random: randomness has no place in a test, and a
            // checkerboard is the highest frequency there is to remove.
            let swing = if (i + i / width) % 2 == 0 { 18.0f32 } else { -18.0 };
            let luma = 128.0f32;
            let (dr, db) = (swing, -swing);
            let dg = -(LUMA[0] * dr + LUMA[2] * db) / LUMA[1];
            frame[i * 3] = (luma + dr) as u8;
            frame[i * 3 + 1] = (luma + dg) as u8;
            frame[i * 3 + 2] = (luma + db) as u8;
        }
        frame
    }

    #[test]
    fn the_chroma_denoise_takes_the_colour_off_and_leaves_the_brightness() {
        let (w, h) = (32usize, 32usize);
        let mut frame = speckled(w, h);
        let luma_of = |f: &[u8], i: usize| {
            LUMA[0] * f32::from(f[i * 3]) + LUMA[1] * f32::from(f[i * 3 + 1]) + LUMA[2] * f32::from(f[i * 3 + 2])
        };
        let before: Vec<f32> = (0..w * h).map(|i| luma_of(&frame, i)).collect();
        finish(&mut frame, w, h, 1.0, 0.0);

        for i in (h / 4 * w)..(h * 3 / 4 * w) {
            // The colour swing is gone - the speckle averages to grey.
            let swing = i32::from(frame[i * 3]) - i32::from(frame[i * 3 + 2]);
            assert!(swing.abs() <= 2, "pixel {i} still swings {swing}");
            // And luma is untouched, which is the property that makes a heavy chroma
            // blur safe at all: detail lives in luma and none of it may move.
            let after = luma_of(&frame, i);
            assert!((after - before[i]).abs() < 1.0, "pixel {i}: {} to {after}", before[i]);
        }
    }

    #[test]
    fn the_chroma_denoise_keeps_a_colour_edge_where_it_is() {
        // A blur crossing a colour edge is the failure mode - measured on a real frame,
        // a red wall pouring onto the grey roof beside it. Well inside either side of the
        // edge the colour has to be the colour it was.
        //
        // **The two colours are chosen to have the same luma**, and that is the whole
        // test. The guide can only hold an edge it can see, so a pair that differs in
        // brightness is held by the guide and proves nothing about the cap; this pair
        // differs by about one part in 255 of luma and by half the chroma range, which is
        // the wall-against-roof case exactly. Remove `DENOISE_CHROMA_COARSE_LIMIT` and
        // this fails; that is what makes it a test of the cap rather than of the guide.
        //
        // Comfortably wider than the coarsest chroma radius, which is the point of the
        // size: a frame narrower than the window is one the filter fits over in its
        // entirety, and a test on that measures nothing about locality.
        let (w, h) = (256usize, 16usize);
        let mut frame = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                let (r, g, b) = if x < w / 2 { (150u8, 60, 60) } else { (60, 71, 200) };
                frame[i] = r;
                frame[i + 1] = g;
                frame[i + 2] = b;
            }
        }
        // The premise, asserted rather than trusted: if a later edit to these two
        // colours reintroduces a luma step, the guide starts doing the work and the
        // assertions below stop meaning anything.
        let luma_at = |x: usize| {
            let i = (8 * w + x) * 3;
            LUMA[0] * f32::from(frame[i]) + LUMA[1] * f32::from(frame[i + 1]) + LUMA[2] * f32::from(frame[i + 2])
        };
        assert!((luma_at(8) - luma_at(248)).abs() < 2.0, "the two colours must be iso-luminant");
        let before = frame.clone();
        finish(&mut frame, w, h, 1.0, 0.0);
        let moved = |x: usize| {
            let i = (8 * w + x) * 3;
            (0..3).map(|c| (i32::from(frame[i + c]) - i32::from(before[i + c])).abs()).max().unwrap()
        };

        // Well away from the edge nothing may move at all.
        for x in [8usize, 32, 224, 248] {
            assert!(moved(x) <= 3, "column {x} moved {} far from the edge", moved(x));
        }
        // **Beside it, bounded rather than zero, and that is the actual contract.** The
        // coarse pass fits one linear model across a 65-pixel window, so at an edge it
        // spans both colours and does want to average them - what stops that being a
        // wash of red across the roof is `DENOISE_CHROMA_COARSE_LIMIT`, which caps the
        // move at 2% of full scale however wrong the fit is. Sampling three windows
        // clear, as this once did, tests none of that: it passes over a filter with no
        // cap at all. 8 pixels out is where the cap is doing the work.
        //
        // The boundary pixels themselves are left out on purpose. A window centred on a
        // hard transition spans both colours whatever the filter does with it, so some
        // mixing there is arithmetic rather than a defect - and it is one pixel, where
        // the artefact this guards against was a wash across a whole roof.
        let cap = (DENOISE_CHROMA_COARSE_LIMIT * 255.0).ceil() as i32 + 1;
        for x in [116usize, 120, 136, 140] {
            assert!(moved(x) <= cap, "column {x} moved {} beside the edge", moved(x));
        }
    }

    /// A grainy field with `flat_rows` rows of blown white above it.
    fn grain_under_sky(width: usize, height: usize, flat_rows: usize) -> Vec<u8> {
        let mut frame = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let value = match y < flat_rows {
                    true => 255,
                    // Deterministic, and wide enough to sit well above the histogram's
                    // first bin: this is what the estimator has to find.
                    false => (100 + ((x * 31 + y * 17) % 9) as i32 - 4) as u8,
                };
                for c in 0..3 {
                    frame[(y * width + x) * 3 + c] = value;
                }
            }
        }
        frame
    }

    #[test]
    fn a_flat_majority_does_not_read_as_a_noiseless_frame() {
        // The estimator reads a median residual, and a pixel in a blown sky has a
        // residual of exactly zero. Counted, those pixels put the median at zero the
        // moment they are half the frame - reporting no noise, setting `eps` to zero and
        // turning the luma denoise into an identity. A cliff, not a taper: this is the
        // same grain either side of it, and it has to be denoised the same amount.
        let (w, h) = (128usize, 128usize);
        let denoised_by = |flat_rows: usize| {
            let before = grain_under_sky(w, h, flat_rows);
            let mut after = before.clone();
            finish(&mut after, w, h, 1.0, 0.0);
            let grain = (flat_rows * w * 3)..(w * h * 3);
            let moved: u32 = grain
                .clone()
                .map(|i| u32::from(before[i].abs_diff(after[i])))
                .sum();
            moved as f32 / grain.len() as f32
        };

        let little_sky = denoised_by(w * 30 / 100);
        let much_sky = denoised_by(w * 60 / 100);
        assert!(little_sky > 0.5, "the grain was not denoised at all: {little_sky}");
        assert!(
            (much_sky - little_sky).abs() < 0.35 * little_sky,
            "same grain, {little_sky} denoised under a small sky and {much_sky} under a large one",
        );
    }

    #[test]
    fn a_frame_that_is_mostly_detail_does_not_have_it_read_as_noise() {
        // The opposite end. Close stripes over a whole frame give a large median
        // residual that is signal, and without a ceiling on the estimate the filter
        // believes it and smooths luma to its local mean - taking the stripes with it.
        let (w, h) = (128usize, 128usize);
        let mut frame = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let value = if (x / 3) % 2 == 0 { 90u8 } else { 170 };
                for c in 0..3 {
                    frame[(y * w + x) * 3 + c] = value;
                }
            }
        }
        let before = frame.clone();
        finish(&mut frame, w, h, 1.0, 0.0);

        let span = |data: &[u8]| {
            let row = (h / 2) * w;
            let (mut low, mut high) = (255u8, 0u8);
            for x in 0..w {
                low = low.min(data[(row + x) * 3]);
                high = high.max(data[(row + x) * 3]);
            }
            u32::from(high - low)
        };
        let (was, now) = (span(&before), span(&frame));
        assert!(now * 2 > was, "stripe contrast fell from {was} to {now}");
    }

    /// A frame with something at every scale the chain looks at: fine grain, mid-scale
    /// texture and a hard edge, so a seam has plenty to show up against.
    fn busy(width: usize, height: usize) -> Vec<u8> {
        let mut frame = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                let block = if (x / 24 + y / 24) % 2 == 0 { 40i32 } else { 0 };
                let edge = if x > width / 2 { 60 } else { 0 };
                let grain = ((x * 31 + y * 17) % 11) as i32 - 5;
                let base = 90 + block + edge + grain;
                frame[i] = base.clamp(0, 255) as u8;
                frame[i + 1] = (base + ((x * 13 + y * 7) % 7) as i32 - 3).clamp(0, 255) as u8;
                frame[i + 2] = (base + ((x * 19 + y * 23) % 9) as i32 - 4).clamp(0, 255) as u8;
            }
        }
        frame
    }

    #[test]
    fn strips_produce_what_a_whole_frame_would_have() {
        // The whole point of the halo. Every stage is local with a bounded reach, so a
        // strip that carries enough context has to land on exactly what a single pass
        // over the frame would have written - and if the reach is underestimated by even
        // a row, the error shows up as a horizontal seam at every strip boundary, which
        // is both obvious on a photograph and invisible to every other test here.
        //
        // The *same* frame both ways, which is why the strip height is a parameter: a
        // shorter frame would measure its own noise differently and the two runs would
        // diverge for a reason that has nothing to do with the halo.
        let (width, height, interior) = (200usize, 500usize, 100usize);
        let source = busy(width, height);

        let run = |rows: usize| {
            let mut frame = source.clone();
            finish_in_strips(&mut frame, width, height, 1.0, 0.6, rows);
            frame
        };
        let whole = run(height);
        let striped = run(interior);

        let halo = Radii::for_strength(1.0).halo(true, true);
        assert!(halo > 0 && halo < interior, "the strips must be taller than the halo: {halo}");

        // **Within a count, not bit-for-bit**, and the distinction is the point. The box
        // mean is a running sum, so a plane of a different height splits into different
        // bands and accumulates in a different order; in f32 that moves the last bit, and
        // a sample sitting on a rounding boundary lands one count either way. What a halo
        // that is too short produces is nothing like that - it is a *band* of rows at
        // every strip boundary, wrong by as much as the filter can move a pixel - so the
        // per-row summary below is what actually catches it.
        let mut worst = 0u8;
        let mut worst_row = 0usize;
        for row in 0..height {
            let mut row_error = 0u32;
            for i in (row * width * 3)..((row + 1) * width * 3) {
                let difference = whole[i].abs_diff(striped[i]);
                worst = worst.max(difference);
                row_error += u32::from(difference);
            }
            // No row may be systematically wrong, which is what a seam is: a boundary row
            // under a short halo differs on most of its samples, not on a stray few.
            assert!(
                row_error < (width * 3) as u32 / 4,
                "row {row} differs by {row_error} across {} samples - a seam, not rounding",
                width * 3,
            );
            if row_error > 0 {
                worst_row = worst_row.max(row);
            }
        }
        assert!(worst <= 1, "a sample differs by {worst} counts, at row {worst_row}");
    }

    #[test]
    fn a_frame_with_no_noise_at_all_survives_being_denoised() {
        // The luma denoise takes its regularisation from the frame's own measured noise,
        // and a synthetic frame measures zero - which meets a flat window's zero variance
        // as 0/0 and turns the whole picture into NaN. A photograph never measures zero,
        // so this is exactly the failure that ships.
        let (w, h) = (24usize, 24usize);
        let mut frame = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                let value = if x < w / 2 { 40u8 } else { 200 };
                frame[i] = value;
                frame[i + 1] = value;
                frame[i + 2] = value;
            }
        }
        let before = frame.clone();
        finish(&mut frame, w, h, 1.0, 1.0);
        // A NaN lands as 0 or 255 once clamped back to eight bits, so the tell is that
        // every sample is still inside the two levels the picture is made of.
        for (i, sample) in frame.iter().enumerate() {
            assert!((40..=200).contains(sample), "sample {i} became {sample}");
        }
        // Away from the step there is nothing to remove and nothing to invert, so those
        // pixels come back as themselves. The transition is left out: a *perfect* step is
        // sharper than the point spread being inverted assumes, and what the sharpen does
        // with that is not this test's business.
        for y in 0..h {
            for x in (0..w).filter(|x| !(8..16).contains(x)) {
                let i = (y * w + x) * 3;
                assert!(frame[i].abs_diff(before[i]) <= 1, "pixel {x},{y}: {} became {}", before[i], frame[i]);
            }
        }
    }

    #[test]
    fn both_settings_off_is_not_an_almost_identity() {
        // Off is a common setting, and it has to mean the frame is not walked at all
        // rather than walked, deinterleaved, recombined and rounded back.
        let (w, h) = (16usize, 16usize);
        let mut frame: Vec<u16> = edge(w, h, 1000.0, 40000.0);
        let before = frame.clone();
        finish(&mut frame, w, h, 0.0, 0.0);
        assert_eq!(frame, before);
    }

    #[test]
    fn sample_radius_is_the_identity_without_knots() {
        assert!((sample_radius(&[], 0.7, 1.0) - 0.7).abs() < 1e-12);
        assert!((sample_radius(&[], 0.7, 0.5) - 0.35).abs() < 1e-12);
    }

    #[test]
    fn polynomial_knots_round_trip_through_sample_radius() {
        let k1 = -0.0275;
        let knots = polynomial_knots(k1, 0.0, 64);
        assert!((sample_radius(&knots, 1.0, 1.0) - (1.0 + k1)).abs() < 1e-3);
        assert!((sample_radius(&knots, 0.5, 1.0) - 0.5 * (1.0 + k1 * 0.25)).abs() < 1e-3);
    }
}
