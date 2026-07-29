// Scene-referred sensor data carries no exposure. LibRaw scales sensor saturation to
// full range whatever the photographer metered, so declaring linear 1.0 to be the
// display's peak makes brightness a function of how the shot was exposed rather than
// of what was in front of the lens: measured over eight bodies, the same 1000-nit
// peak gave means from 33 to 321 nits, a 10x spread. Highlights also met the peak
// with no roll-off, so a clipped frame ended flat against it.
//
// Two ITU standards close that, and neither needs a look to be invented:
//   BT.2408  diffuse white in HDR sits at 203 nits, which is what makes HDR read at
//            the same brightness as the SDR beside it.
//   BT.2390  the EETF, a Hermite roll-off applied in PQ space, compressing whatever
//            is above the display's peak into it instead of clipping.
//
// The one judgement left is which sample counts as diffuse white, which no standard
// prescribes because a camera takes it from the metered exposure. A histogram
// quantile is the same heuristic dcraw's auto-bright uses, and is the knob worth
// tuning if a library renders consistently dark or hot.

use crate::hdr_fit::{self, HdrColour};
use rayon::prelude::*;

const MAX: usize = 65535;

/// Rec.2020 luma, matching the chroma blend the match was fitted with.
const LUMA: [f64; 3] = [0.2627, 0.678, 0.0593];

// SMPTE ST 2084.
const M1: f64 = 2610.0 / 16384.0;
const M2: f64 = (2523.0 / 4096.0) * 128.0;
const C1: f64 = 3424.0 / 4096.0;
const C2: f64 = (2413.0 / 4096.0) * 32.0;
const C3: f64 = (2392.0 / 4096.0) * 32.0;
const PQ_MAX_NITS: f64 = 10000.0;

fn pq(nits: f64) -> f64 {
    let y = (nits / PQ_MAX_NITS).clamp(0.0, 1.0).powf(M1);
    ((C1 + C2 * y) / (1.0 + C3 * y)).powf(M2)
}

fn pq_inv(signal: f64) -> f64 {
    let e = signal.clamp(0.0, 1.0).powf(1.0 / M2);
    PQ_MAX_NITS * ((e - C1).max(0.0) / (C2 - C3 * e)).powf(1.0 / M1)
}

/// ITU-R BT.2390-8 5.4.1, with the black level at zero so the lift term drops out.
/// Takes and returns nits.
fn eetf(nits: f64, source_peak_nits: f64, peak_nits: f64) -> f64 {
    let lw = pq(source_peak_nits);
    let max_lum = pq(peak_nits) / lw;
    // The source already fits the display, so there is nothing to compress.
    if max_lum >= 1.0 {
        return nits;
    }
    // Only goes negative when the source is several stops brighter than the display,
    // and a negative knee would lift black, which the curve never means to do.
    let ks = (1.5 * max_lum - 0.5).max(0.0);
    let e1 = pq(nits) / lw;
    if e1 < ks {
        return nits;
    }

    let t = (e1 - ks) / (1.0 - ks);
    let t2 = t * t;
    let t3 = t2 * t;
    let e2 = (2.0 * t3 - 3.0 * t2 + 1.0) * ks
        + (t3 - 2.0 * t2 + t) * (1.0 - ks)
        + (-2.0 * t3 + 3.0 * t2) * max_lum;
    pq_inv(e2 * lw)
}

/// A quantile does not need every pixel of a 60MP frame.
const QUANTILE_STRIDE: usize = 16;

#[derive(Clone, Copy)]
pub struct Levels {
    pub white: f64,
    pub peak: f64,
}

/// The brightest component of a pixel rather than its luminance, because that is what
/// clips first: anchoring on luminance lets a saturated channel run past the top of
/// the range while the pixel still reads as mid-toned.
///
/// `peak` is the frame's own brightest sample and not sensor saturation, which is what
/// makes the grade exposure-invariant: both levels scale with exposure, so their ratio
/// - and therefore how much roll-off the highlights get - is a property of the scene.
/// Reading the peak off the sensor instead would give a frame shot two stops down four
/// times the compression for the same subject.
pub fn levels(samples: &[u16], quantile: f64) -> Levels {
    let mut histogram = vec![0u32; MAX + 1];
    let mut counted = 0usize;
    let mut i = 0usize;
    while i + 2 < samples.len() {
        let brightest = samples[i].max(samples[i + 1]).max(samples[i + 2]);
        histogram[brightest as usize] += 1;
        counted += 1;
        i += 3 * QUANTILE_STRIDE;
    }

    let mut peak = 0usize;
    let mut white: isize = -1;
    let mut seen = 0u64;
    let target = counted as f64 * quantile;
    for level in 0..=MAX {
        let count = histogram[level];
        if count == 0 {
            continue;
        }
        peak = level;
        seen += u64::from(count);
        if white < 0 && seen as f64 >= target {
            white = level as isize;
        }
    }
    Levels {
        white: if white < 0 { peak as f64 } else { white as f64 },
        peak: peak as f64,
    }
}

pub struct GradeOptions<'a> {
    /// Nits diffuse white maps to. 203 is BT.2408 HDR Reference White.
    pub reference_white_nits: f64,
    /// Display peak the roll-off targets. Equal to the reference for an SDR render.
    pub peak_nits: f64,
    /// The camera's own colour treatment, fitted from its embedded JPEG (10.8.1).
    /// None keeps LibRaw's neutral rendering.
    ///
    /// The colour half only. Its geometry is applied by the caller before this runs,
    /// since a warp is a resize concern rather than a tone one.
    pub match_colour: Option<&'a HdrColour>,
    /// Where diffuse white and the scene peak sit, measured on the decode rather than
    /// on whatever was handed here.
    ///
    /// Measured on a downscaled copy the answers drift, because averaging pulls a
    /// specular peak in, so the full-size rendition and the max-resolution one would
    /// grade to different brightnesses for the same photo.
    pub levels: Levels,
}

/// The roll-off is a function of nits alone, so it is a lookup whichever path produced
/// them. Resolution is in nits rather than input level because the matched path has no
/// single input level to key on.
const ROLL_BINS: usize = 4096;

/// Grades scene-linear 16-bit samples to display-referred linear, where full range is
/// `peak_nits` - which is what zscale's `npl` then ties to absolute brightness.
///
/// None when the frame has no exposure to read, in which case the caller ships the
/// input unchanged: leaving it alone beats dividing by zero.
pub fn grade(source: &[u16], options: &GradeOptions<'_>) -> Option<Vec<u16>> {
    let Levels { white, peak: source_level } = options.levels;
    if white == 0.0 {
        return None;
    }
    let reference = options.reference_white_nits;
    let peak = options.peak_nits;

    let mut out = vec![0u16; source.len()];

    let Some(colour) = options.match_colour else {
        let source_peak_nits = (source_level / white) * reference;
        // One curve covers all 65536 possible inputs, so the per-sample work is a
        // lookup. A 60MP frame is 180M samples, and pow() that many times is not free.
        let mut lut = vec![0u16; MAX + 1];
        for level in 0..=MAX {
            let nits = eetf((level as f64 / white) * reference, source_peak_nits, peak);
            lut[level] = ((nits / peak).min(1.0) * MAX as f64).round() as u16;
        }
        out.par_iter_mut().zip(source.par_iter()).for_each(|(o, s)| *o = lut[*s as usize]);
        return Some(out);
    };

    // Matched: the transform is cross-channel, so there is no per-input-level table to
    // build and the scene peak has to be measured after it rather than read off the
    // input's histogram.
    //
    // The peak comes from the same subsample the anchor does. Keeping every pixel's
    // nits to find the exact maximum wanted a buffer the size of the frame - 720MB on
    // a 60MP photo - to save clamping a handful of specular samples that the roll-off
    // was compressing into the peak anyway.
    let mut scene_peak = source
        .par_chunks_exact(3)
        .step_by(QUANTILE_STRIDE)
        .map(|px| {
            let v = hdr_fit::apply_hdr_colour(
                colour,
                f64::from(px[0]) / white,
                f64::from(px[1]) / white,
                f64::from(px[2]) / white,
            );
            v[0].max(v[1]).max(v[2])
        })
        .reduce(|| 0.0f64, f64::max);
    scene_peak *= reference;
    if !(scene_peak > 0.0) {
        return None;
    }

    let mut table = vec![0.0f64; ROLL_BINS];
    for (i, slot) in table.iter_mut().enumerate() {
        *slot = eetf((i as f64 / (ROLL_BINS - 1) as f64) * scene_peak, scene_peak, peak);
    }

    // Below the ceiling the shared gain is 1 and the tone stage is separable, so it is
    // a lookup on the input level. That is nearly every pixel of a photograph; only
    // the highlights take the general path, where the gain depends on all three
    // channels at once. Interpolating a curve per channel per pixel instead cost about
    // seven seconds on a 60MP frame, twice per HDR rendition.
    let ceiling = hdr_fit::TRUST_CEILING * white;
    let curve_lut: [Vec<f32>; 3] = std::array::from_fn(|c| {
        (0..=MAX).map(|level| hdr_fit::tone_channel(colour, c, level as f64 / white) as f32).collect()
    });

    // Flat and scalar on purpose. Written with the tuple-returning helpers it was
    // three allocations per pixel, 180M on a 60MP frame, and the collector cost more
    // than all the arithmetic put together.
    //
    // Across cores because every pixel is independent of every other, and this is the
    // most expensive stage of an HDR rendition: 180M pixels of matrix, lookup and
    // roll-off on a 60MP export.
    let m = &colour.matrix;
    let sat = colour.saturation;
    let scale = (ROLL_BINS - 1) as f64 / scene_peak;

    out.par_chunks_exact_mut(3).zip(source.par_chunks_exact(3)).for_each(|(out_px, px)| {
        let (r, g, b) = (px[0], px[1], px[2]);

        let (tr, tg, tb) = if f64::from(r) <= ceiling && f64::from(g) <= ceiling && f64::from(b) <= ceiling {
            (
                f64::from(curve_lut[0][r as usize]),
                f64::from(curve_lut[1][g as usize]),
                f64::from(curve_lut[2][b as usize]),
            )
        } else {
            let t = hdr_fit::tone(colour, f64::from(r) / white, f64::from(g) / white, f64::from(b) / white);
            (t[0], t[1], t[2])
        };

        let mut or = m[0][0] * tr + m[0][1] * tg + m[0][2] * tb;
        let mut og = m[1][0] * tr + m[1][1] * tg + m[1][2] * tb;
        let mut ob = m[2][0] * tr + m[2][1] * tg + m[2][2] * tb;
        if sat != 1.0 {
            let l = LUMA[0] * or + LUMA[1] * og + LUMA[2] * ob;
            or = l + (or - l) * sat;
            og = l + (og - l) * sat;
            ob = l + (ob - l) * sat;
        }

        for (c, raw) in [or, og, ob].into_iter().enumerate() {
            let nits = scene_peak.min(if raw > 0.0 { raw * reference } else { 0.0 });
            let t = nits * scale;
            let lo = (t.floor() as usize).min(ROLL_BINS - 2);
            let rolled = table[lo] + (table[lo + 1] - table[lo]) * (t - lo as f64);
            out_px[c] = ((rolled / peak).min(1.0) * MAX as f64).round() as u16;
        }
    });
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pq_round_trips_through_its_inverse() {
        for nits in [0.0, 1.0, 100.0, 203.0, 1000.0, 4000.0, 10000.0] {
            let back = pq_inv(pq(nits));
            assert!((back - nits).abs() < 0.01, "{nits} came back {back}");
        }
    }

    #[test]
    fn the_roll_off_does_nothing_when_the_source_already_fits() {
        // The early return that a pin without a low-peak case never exercised.
        for nits in [10.0, 203.0, 900.0] {
            assert_eq!(eetf(nits, 500.0, 1000.0), nits);
        }
    }

    #[test]
    fn the_roll_off_compresses_into_the_display_peak_without_clipping() {
        let (source, display) = (4000.0, 1000.0);
        let top = eetf(source, source, display);
        assert!(top <= display * 1.001, "the source peak must land on the display peak, got {top}");
        // Monotone, and the shadows are untouched.
        let mut previous = -1.0;
        for step in 0..=40 {
            let nits = (step as f64 / 40.0) * source;
            let out = eetf(nits, source, display);
            assert!(out >= previous, "not monotone at {nits}");
            previous = out;
        }
        assert_eq!(eetf(0.0, source, display), 0.0, "black stays black");
    }

    #[test]
    fn levels_read_the_quantile_off_the_brightest_component() {
        // A ramp where the brightest component of each pixel is its red.
        let samples: Vec<u16> = (0..3000).flat_map(|i| [i as u16 * 20, 5, 5]).collect();
        let out = levels(&samples, 0.9);
        assert!(out.peak > out.white, "the peak must sit above diffuse white");
        assert!(out.white > 0.0);
    }

    #[test]
    fn a_frame_with_no_exposure_is_left_alone_rather_than_divided_by() {
        let flat = vec![0u16; 300];
        let options = GradeOptions {
            reference_white_nits: 203.0,
            peak_nits: 1000.0,
            match_colour: None,
            levels: levels(&flat, 0.9),
        };
        assert!(grade(&flat, &options).is_none());
    }

    #[test]
    fn the_neutral_grade_is_monotone_in_its_input() {
        let samples: Vec<u16> = (0..900u16).flat_map(|i| [i * 70, i * 70, i * 70]).collect();
        let options = GradeOptions {
            reference_white_nits: 203.0,
            peak_nits: 1000.0,
            match_colour: None,
            levels: levels(&samples, 0.9),
        };
        let out = grade(&samples, &options).expect("a graded frame");
        for i in 3..out.len() {
            if i % 3 == 0 {
                assert!(out[i] >= out[i - 3], "not monotone at {i}");
            }
        }
    }
}
