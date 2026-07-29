// Pixel maths libvips has no operation for.
//
// Everything libvips does do - resize, blur, encode - goes through `vips`, so this
// is only the radial warp and the spline it follows.

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
