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
use crate::image::PlanarWarp;
use crate::parallel::*;

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

/// SMPTE ST 2084, forward. Public because the encoders apply the same transfer the
/// roll-off is computed in, rather than handing the frame to `zscale` to do it in
/// another process (`encode_pq`).
pub fn pq(nits: f64) -> f64 {
    let y = (nits / PQ_MAX_NITS).clamp(0.0, 1.0).powf(M1);
    ((C1 + C2 * y) / (1.0 + C3 * y)).powf(M2)
}

/// PQ-encodes a graded frame in place, at 16 bits.
///
/// `grade` leaves display-referred linear where full range is the display's peak,
/// which is what `zscale` was being told through `npl` and `tin=linear`. Only the
/// transfer is left: PQ's output gamut is Rec.2020, which is the space the grade
/// already works in, so nothing has to move between primaries.
///
/// Both media take it here rather than one each. It used to be the still's alone -
/// libavif's, in `avif.rs`, with the video's done by a `zscale` in ffmpeg - which
/// meant the two encoders were handed frames in different domains and nothing that
/// had to sit between the grade and the transfer could be written once.
pub fn encode_pq(frame: &mut [u16], peak_nits: f64) {
    // One curve covers all 65536 inputs, so the per-sample work is a lookup rather
    // than a pow(): a 24MP frame is 30M samples and a 60MP one 180M.
    let full = f64::from(u16::MAX);
    let lut: Vec<u16> = (0..=u16::MAX)
        .map(|level| (pq((f64::from(level) / full) * peak_nits) * full).round() as u16)
        .collect();
    frame.par_iter_mut().for_each(|s| *s = lut[*s as usize]);
}

/// ST 2084 the other way: a signal back to the nits it was coded from.
///
/// Public because the open goes through it: `edit::filter_once` puts the frame into PQ to
/// filter it in a perceptual domain and brings it back. That began as an experiment, and
/// this was called `pq_inv_for_testing` long after the experiment became the shipped path.
pub fn pq_inv(signal: f64) -> f64 {
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

/// How many pixels the quantile reads. A quantile does not need every pixel of a 60MP
/// frame, and it must not read a number of them that depends on how big the frame is.
///
/// A fixed *count* rather than a fixed stride, which is the whole point. `peak` is the
/// maximum over whatever was sampled, so sampling four times as many pixels finds a
/// brighter one - and the same photo decoded at two sizes then anchors differently.
/// Measured on the 24MP fixture before this: a full decode read 1.51M pixels and a
/// halved one 379K, and the halved frame's peak came back 0.76% higher for no reason
/// but the count. Roughly what the old stride read at 24MP, so the sampling density is
/// unchanged on a typical frame.
const QUANTILE_SAMPLES: usize = 1 << 20;

fn sample_at(k: usize, pixels: usize, counted: usize) -> usize {
    let at = (k as u64 * pixels as u64 / counted as u64) * 3;
    usize::try_from(at).expect("a sample offset must fit the frame's address space")
}

/// Where the frame's top end is read, for the roll-off to compress into the display.
///
/// A quantile rather than the maximum, and that is a correctness fix rather than a
/// tuning choice. A maximum is a property of one sample, so it moves with how many
/// pixels were read *and* with which demosaic produced them - measured across a full
/// decode, a half-size one and a box-resized one of the same frame, the maximum spread
/// **22.7%** while this quantile spread **0.29%**. Two renditions of one photo were
/// therefore rolling their highlights differently for no reason a viewer would accept.
///
/// 0.9999 rather than higher: over `QUANTILE_SAMPLES` it is the top ~105 samples, which
/// is enough to estimate. 0.99999 is the top ten, near enough a maximum again, and
/// measured less stable for exactly that reason.
///
/// It clips what sits above it, which is the behaviour the matched arm already had -
/// it clamps to whatever its subsample happened to find, and DESIGN 10.7.1 records
/// that as "a handful of specular samples the roll-off was compressing into the peak
/// anyway". This makes that threshold explicit and repeatable instead of accidental.
const PEAK_QUANTILE: f64 = 0.9999;

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
///
/// **Read at a fixed sample count, at proportional positions**, so that the same photo
/// decoded at two different sizes lands on the same anchor. Not exactly the same - two
/// decodes of one frame are not two views of one buffer - but close enough that the
/// renditions agree, which a stride cannot manage at all (10.7.1).
pub fn levels(samples: &[u16], quantile: f64) -> Levels {
    let pixels = samples.len() / 3;
    if pixels == 0 {
        return Levels { white: 0.0, peak: 0.0 };
    }
    let counted = pixels.min(QUANTILE_SAMPLES);
    let mut histogram = vec![0u32; MAX + 1];
    for k in 0..counted {
        // Spread by fraction rather than by step: sample k lands at the same place in
        // the frame whatever the frame's resolution, which is what makes two decodes of
        // one photo agree.
        let i = sample_at(k, pixels, counted);
        let brightest = samples[i].max(samples[i + 1]).max(samples[i + 2]);
        histogram[brightest as usize] += 1;
    }

    let mut highest = 0usize;
    let mut peak: isize = -1;
    let mut white: isize = -1;
    let mut seen = 0u64;
    let white_at = counted as f64 * quantile;
    let peak_at = counted as f64 * PEAK_QUANTILE;
    for level in 0..=MAX {
        let count = histogram[level];
        if count == 0 {
            continue;
        }
        highest = level;
        seen += u64::from(count);
        if white < 0 && seen as f64 >= white_at {
            white = level as isize;
        }
        if peak < 0 && seen as f64 >= peak_at {
            peak = level as isize;
        }
    }
    // A frame with too few distinct levels to reach either mark falls back to the
    // brightest one there is, which is what both meant on such a frame anyway.
    let peak = if peak < 0 { highest as f64 } else { peak as f64 };
    Levels { white: if white < 0 { peak } else { white as f64 }, peak }
}

pub struct GradeOptions<'a> {
    /// Nits diffuse white maps to. 203 is BT.2408 HDR Reference White.
    pub reference_white_nits: f64,
    /// Display peak the roll-off targets. Equal to the reference for an SDR render.
    pub peak_nits: f64,
    /// The camera's own colour treatment, fitted from its embedded JPEG (10.8.1).
    /// None keeps LibRaw's neutral rendering.
    pub match_colour: Option<&'a HdrColour>,
    /// When set, [`grade_owned`] peaks the unwarped source then gather+colours through
    /// this. [`grade`] ignores it - the editor grades a frame it has already warped.
    pub lens: Option<&'a PlanarWarp>,
    /// Where diffuse white and the scene peak sit.
    ///
    /// Read at a fixed sample count and as quantiles at both ends, which is what lets
    /// the decode arrive already fitted to the rendition's size: the answers no longer
    /// depend on how many pixels the frame has, so the full-size rendition and the
    /// max-resolution one grade to the same brightness without one of them having to
    /// carry the other's resolution around to be measured at.
    ///
    /// These are the frame's own levels, *before* exposure. Pre-dividing them and leaving
    /// `exposure` at 1 is not the same grade - see `exposure`.
    pub levels: Levels,
    /// Stops of exposure as a multiplier on the scene, 1.0 for none.
    ///
    /// Separate from `levels` rather than folded into them, because the matched arm needs
    /// both the exposed scene and the unexposed one. Its three per-channel curves have
    /// three different shapes, so sliding a pixel along them lands each channel somewhere
    /// its neighbours did not go and the ratios between them - the colour - come out
    /// different. Measured on a real frame: half a stop moved chromaticity by 14/1000
    /// mean and 59/1000 at the 99th percentile, where the neutral arm moved 0.27.
    ///
    /// So the exposure is taken from the curve's *brightness* response and the channel
    /// ratios are held at the unexposed pixel's, which is the camera's colour for that
    /// colour rather than for that brightness. At 1.0 the two evaluations coincide and
    /// this is arithmetically the old path, which is what leaves renditions untouched.
    pub exposure: f64,
}

/// The roll-off is a function of nits alone, so it is a lookup whichever path produced
/// them. Resolution is in nits rather than input level because the matched path has no
/// single input level to key on.
const ROLL_BINS: usize = 4096;

/// Grades a frame that may still need its lens.
///
/// Peak is measured on the *unwarped* source (cheap `u16` reads), then gather and colour
/// share one sweep. Falloff can move that peak versus the warped frame; we take the
/// cheap measurement anyway.
pub fn grade_owned(frame: &mut Vec<u16>, options: &GradeOptions<'_>) -> bool {
    let Some(lens) = options.lens else {
        return grade(frame, options);
    };
    let Levels { white, peak: source_level } = options.levels;
    if white == 0.0 {
        return false;
    }
    let reference = options.reference_white_nits;
    let peak = options.peak_nits;
    let exposure = match options.exposure > 0.0 {
        true => options.exposure,
        false => return false,
    };
    let src = std::mem::take(frame);

    let Some(colour) = options.match_colour else {
        let (white, source_level) = (white / exposure, source_level / exposure);
        let source_peak_nits = (source_level / white) * reference;
        let mut lut = vec![0u16; MAX + 1];
        for level in 0..=MAX {
            let nits = eetf((level as f64 / white) * reference, source_peak_nits, peak);
            lut[level] = ((nits / peak).min(1.0) * MAX as f64).round() as u16;
        }
        *frame = lens.map_u16(&src, |r, g, b| [lut[r as usize], lut[g as usize], lut[b as usize]]);
        return true;
    };

    let matched = MatchedGrade::new(colour, white, exposure, reference, peak);
    let Some(scene_peak) = matched.scene_peak_nits(&src) else {
        *frame = src;
        return false;
    };
    let roll = matched.roll_table(scene_peak);
    *frame = lens.map_u16(&src, |r, g, b| matched.pixel(scene_peak, &roll, r, g, b));
    true
}

/// Grades scene-linear 16-bit samples to display-referred linear in place, where full
/// range is `peak_nits` - which is what zscale's `npl` then ties to absolute brightness.
///
/// In place because the caller owns the frame by the time it gets here - it is the
/// warp's output, or the resize's - and every stage is sample-for-sample at the same
/// index, so there is nothing a second buffer would protect. It was allocating one the
/// size of the frame, 366MB on a 61MP export.
///
/// False when the frame has no exposure to read, leaving it untouched: shipping it as it
/// arrived beats dividing by zero.
pub fn grade(frame: &mut [u16], options: &GradeOptions<'_>) -> bool {
    let Levels { white, peak: source_level } = options.levels;
    if white == 0.0 {
        return false;
    }
    let reference = options.reference_white_nits;
    let peak = options.peak_nits;
    let exposure = match options.exposure > 0.0 {
        true => options.exposure,
        false => return false,
    };

    let Some(colour) = options.match_colour else {
        // One shared curve, so the channel ratios survive it whatever the input: the
        // neutral arm is hue-preserving already and exposure is just where the anchor
        // sits. Both levels move together - the roll-off reads the scene out of their
        // ratio, and scaling one alone rewrites how hard the highlights compress.
        let (white, source_level) = (white / exposure, source_level / exposure);
        let source_peak_nits = (source_level / white) * reference;
        // One curve covers all 65536 possible inputs, so the per-sample work is a
        // lookup. A 60MP frame is 180M samples, and pow() that many times is not free.
        let mut lut = vec![0u16; MAX + 1];
        for level in 0..=MAX {
            let nits = eetf((level as f64 / white) * reference, source_peak_nits, peak);
            lut[level] = ((nits / peak).min(1.0) * MAX as f64).round() as u16;
        }
        frame.par_iter_mut().for_each(|s| *s = lut[*s as usize]);
        return true;
    };

    // Matched: the transform is cross-channel, so there is no per-input-level table to
    // build and the scene peak has to be measured after it rather than read off the
    // input's histogram. The editor path peaks the (already warped) frame in place;
    // the encode peaks the unwarped source inside [`grade_owned`] and gathers+colours
    // in one sweep.
    let matched = MatchedGrade::new(colour, white, exposure, reference, peak);
    let Some(scene_peak) = matched.scene_peak_nits(frame) else {
        return false;
    };
    let roll = matched.roll_table(scene_peak);
    frame.par_chunks_exact_mut(3).for_each(|px| {
        let graded = matched.pixel(scene_peak, &roll, px[0], px[1], px[2]);
        px.copy_from_slice(&graded);
    });
    true
}

/// Matched colour + roll-off, shared by the in-place editor path and the fused encode.
struct MatchedGrade<'a> {
    colour: &'a HdrColour,
    white: f64,
    exposure: f64,
    reference: f64,
    peak: f64,
    ceiling: f64,
    curve_lut: [Vec<f32>; 3],
    exposed_lut: Option<[Vec<f32>; 3]>,
}

impl<'a> MatchedGrade<'a> {
    fn new(
        colour: &'a HdrColour,
        white: f64,
        exposure: f64,
        reference: f64,
        peak: f64,
    ) -> Self {
        // Below the ceiling the shared gain is 1 and the tone stage is separable, so it
        // is a lookup on the input level. That is nearly every pixel of a photograph;
        // only the highlights take the general path, where the gain depends on all three
        // channels at once. Interpolating a curve per channel per pixel instead cost
        // about seven seconds on a 60MP frame, twice per HDR rendition.
        let curve_lut: [Vec<f32>; 3] = std::array::from_fn(|c| {
            (0..=MAX)
                .map(|level| hdr_fit::tone_channel(colour, c, level as f64 / white) as f32)
                .collect()
        });
        // The same table read at the exposed scene. Built rather than indexed at `level *
        // exposure`, because that index leaves the table wherever the exposure is positive.
        let exposed_lut = (exposure != 1.0).then(|| {
            std::array::from_fn(|c| {
                (0..=MAX)
                    .map(|level| {
                        hdr_fit::tone_channel(colour, c, level as f64 * exposure / white) as f32
                    })
                    .collect()
            })
        });
        Self {
            colour,
            white,
            exposure,
            reference,
            peak,
            ceiling: hdr_fit::TRUST_CEILING * white,
            curve_lut,
            exposed_lut,
        }
    }

    /// Post-colour scene peak in nits, from a strided subsample of `frame`.
    fn scene_peak_nits(&self, frame: &[u16]) -> Option<f64> {
        let pixels = frame.len() / 3;
        let counted = pixels.min(QUANTILE_SAMPLES).max(1);
        let mut sampled: Vec<f32> = (0..counted)
            .into_par_iter()
            .map(|k| {
                let i = sample_at(k, pixels, counted);
                let t = self.toned(None, None, frame[i], frame[i + 1], frame[i + 2]);
                let v = hdr_fit::finish_colour(self.colour, t[0], t[1], t[2]);
                v[0].max(v[1]).max(v[2]) as f32
            })
            .collect();
        // The same quantile as the neutral arm, which needs the sampled values kept
        // rather than reduced away. Only the subsample is kept - 4MB at this count -
        // where holding every pixel's nits would be 720MB on a 60MP frame.
        let nth = ((counted as f64 * PEAK_QUANTILE) as usize).min(counted - 1);
        let (_, at, _) = sampled.select_nth_unstable_by(nth, |a, b| a.total_cmp(b));
        let scene_peak = f64::from(*at) * self.reference;
        (scene_peak > 0.0).then_some(scene_peak)
    }

    fn roll_table(&self, scene_peak: f64) -> Vec<f64> {
        let mut table = vec![0.0f64; ROLL_BINS];
        for (i, slot) in table.iter_mut().enumerate() {
            *slot = eetf(
                (i as f64 / (ROLL_BINS - 1) as f64) * scene_peak,
                scene_peak,
                self.peak,
            );
        }
        table
    }

    #[inline]
    fn pixel(&self, scene_peak: f64, table: &[f64], r: u16, g: u16, b: u16) -> [u16; 3] {
        let [tr, tg, tb] = self.toned(Some(&self.curve_lut), self.exposed_lut.as_ref(), r, g, b);
        let m = &self.colour.matrix;
        let sat = self.colour.saturation;
        let mut or = m[0][0] * tr + m[0][1] * tg + m[0][2] * tb;
        let mut og = m[1][0] * tr + m[1][1] * tg + m[1][2] * tb;
        let mut ob = m[2][0] * tr + m[2][1] * tg + m[2][2] * tb;
        match &self.colour.chroma {
            // Handed the matrix's output rather than its input: `finish_colour` would
            // multiply by the same 3x3 a second time, once per pixel of a 60MP frame.
            Some(_) => {
                let out = hdr_fit::finish_chroma(self.colour, [or, og, ob]);
                (or, og, ob) = (out[0], out[1], out[2]);
            }
            None if sat != 1.0 => {
                let l = LUMA[0] * or + LUMA[1] * og + LUMA[2] * ob;
                or = l + (or - l) * sat;
                og = l + (og - l) * sat;
                ob = l + (ob - l) * sat;
            }
            None => {}
        }

        let scale = (ROLL_BINS - 1) as f64 / scene_peak;
        let mut out = [0u16; 3];
        for (c, raw) in [or, og, ob].into_iter().enumerate() {
            let nits = scene_peak.min(if raw > 0.0 { raw * self.reference } else { 0.0 });
            let t = nits * scale;
            let lo = (t.floor() as usize).min(ROLL_BINS - 2);
            let rolled = table[lo] + (table[lo + 1] - table[lo]) * (t - lo as f64);
            out[c] = ((rolled / self.peak).min(1.0) * MAX as f64).round() as u16;
        }
        out
    }

    /// `lut` absent means read the curve itself. The peak subsample does, because it is
    /// 65536 reads against a table built for millions and because rounding the curve to
    /// f32 there would move `scene_peak`, which every pixel is then rolled off against.
    #[inline]
    fn curves(
        &self,
        lut: Option<&[Vec<f32>; 3]>,
        scene: f64,
        r: u16,
        g: u16,
        b: u16,
    ) -> [f64; 3] {
        let ceiling = self.ceiling / scene;
        let separable =
            f64::from(r) <= ceiling && f64::from(g) <= ceiling && f64::from(b) <= ceiling;
        match lut.filter(|_| separable) {
            Some(lut) => [
                f64::from(lut[0][r as usize]),
                f64::from(lut[1][g as usize]),
                f64::from(lut[2][b as usize]),
            ],
            None => hdr_fit::tone(
                self.colour,
                f64::from(r) * scene / self.white,
                f64::from(g) * scene / self.white,
                f64::from(b) * scene / self.white,
            ),
        }
    }

    /// The camera's colour at the pixel's own brightness, moved to the exposed one by
    /// the curve's luma response alone. See `GradeOptions::exposure`.
    #[inline]
    fn toned(
        &self,
        lut: Option<&[Vec<f32>; 3]>,
        exposed: Option<&[Vec<f32>; 3]>,
        r: u16,
        g: u16,
        b: u16,
    ) -> [f64; 3] {
        let base = self.curves(lut, 1.0, r, g, b);
        if self.exposure == 1.0 {
            return base;
        }
        let lit = self.curves(exposed, self.exposure, r, g, b);
        let luma = |v: &[f64; 3]| LUMA[0] * v[0] + LUMA[1] * v[1] + LUMA[2] * v[2];
        let (from, to) = (luma(&base), luma(&lit));
        // Black has no ratios to hold, and the two lumas vanish together, so the
        // quotient there is noise over noise. The exposed pixel is already the right
        // answer.
        match from > 0.0 {
            true => base.map(|v| v * to / from),
            false => lit,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_transfer_matches_the_curve_the_grade_rolls_highlights_with() {
        // The PQ pass replaces zscale's, so it has to be the same curve - and it is the
        // one the roll-off already uses, which is what makes that checkable at all.
        //
        // Against input *levels* rather than a list of nits: PQ is near-vertical at the
        // bottom, so rounding a nits value to a level and back moves the answer by tens
        // of counts at 1 nit, and a test written that way measures the quantisation
        // rather than the curve.
        let levels: [u16; 6] = [0, 1, 66, 13303, 32768, u16::MAX];
        let mut out = levels;
        encode_pq(&mut out, 1000.0);
        for (i, level) in levels.iter().enumerate() {
            let nits = (f64::from(*level) / f64::from(u16::MAX)) * 1000.0;
            let want = (pq(nits) * f64::from(u16::MAX)).round() as u16;
            assert_eq!(out[i], want, "level {level}");
        }
    }

    #[test]
    fn the_display_peak_lands_where_pq_puts_it_rather_than_at_full_scale() {
        // PQ is absolute and its range runs to 10000 nits, so a 1000-nit peak encodes
        // at about 0.752 of the code range and *must not* be stretched to fill it.
        // Normalising it to full scale would be the mistake `npl` exists to prevent:
        // the file would then claim its diffuse white is 10000 nits.
        let mut out: Vec<u16> = (0..=255).map(|i| i * 257).collect();
        encode_pq(&mut out, 1000.0);
        assert_eq!(out[0], 0, "black must stay black");
        let peak = *out.last().expect("a last sample");
        assert_eq!(peak, (pq(1000.0) * f64::from(u16::MAX)).round() as u16);
        assert!((0.74..0.76).contains(&(f64::from(peak) / f64::from(u16::MAX))), "{peak}");
        for i in 1..out.len() {
            assert!(out[i] >= out[i - 1], "not monotone at {i}");
        }
    }

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
    fn sample_positions_survive_a_thirty_two_bit_index() {
        let (pixels, counted) = (9_830_400usize, QUANTILE_SAMPLES);
        assert_eq!(sample_at(0, pixels, counted), 0);
        assert_eq!(sample_at(counted - 1, pixels, counted), (pixels - 10) * 3);
        let mut previous = 0;
        for k in 0..counted {
            let at = sample_at(k, pixels, counted);
            assert!(at >= previous && at < pixels * 3, "sample {k} landed at {at}");
            previous = at;
        }
    }

    #[test]
    fn a_frame_with_no_exposure_is_left_alone_rather_than_divided_by() {
        let mut flat = vec![0u16; 300];
        let options = GradeOptions {
            reference_white_nits: 203.0,
            peak_nits: 1000.0,
            match_colour: None,
            lens: None,
            levels: levels(&flat, 0.9),
            exposure: 1.0,
        };
        assert!(!grade(&mut flat, &options));
        // Left as it arrived, which is the half an in-place grade could get wrong: a
        // declined grade that had already written some of the frame would ship a
        // half-transformed picture rather than the untouched one.
        assert!(flat.iter().all(|s| *s == 0));
    }

    /// The matched arm's three curves have three different shapes, so a pixel slid along
    /// them by exposure lands each channel somewhere its neighbours did not go and the
    /// colour comes out different. Measured on a real frame before this held: half a stop
    /// moved chromaticity by 14/1000 mean and 59/1000 at p99, where the neutral arm - one
    /// shared curve, so hue-preserving by construction - moved 0.27.
    #[test]
    fn exposure_moves_brightness_without_moving_colour() {
        let mut colour = crate::hdr_fit::HdrColour::identity();
        let bins = colour.curves[0].len();
        // Deliberately three shapes rather than one. With identical curves this passes
        // however exposure is applied, and tests nothing.
        for (channel, gamma) in [0.75f64, 1.0, 1.4].into_iter().enumerate() {
            colour.curves[channel] = (0..bins)
                .map(|i| {
                    let u = i as f64 / (bins - 1) as f64;
                    u.powf(gamma) * crate::hdr_fit::TRUST_CEILING
                })
                .collect();
        }

        // Spread across hue and across level, the last of them above the trust ceiling
        // once exposed, so the cross-channel arm is covered as well as the lookup.
        let white = 20000.0;
        let base: Vec<u16> = [
            [6000u16, 3000, 1500],
            [3000, 6000, 2000],
            [1500, 2500, 7000],
            [4000, 4000, 4000],
            [12000, 8000, 9000],
        ]
        .concat();

        let graded = |levels: Levels, exposure: f64| {
            let mut frame = base.clone();
            let options = GradeOptions {
                reference_white_nits: 203.0,
                peak_nits: 1000.0,
                match_colour: Some(&colour),
                lens: None,
                levels,
                exposure,
            };
            assert!(grade(&mut frame, &options));
            frame
        };
        let own = Levels { white, peak: white * 4.0 };
        let dim = graded(own, 1.0);
        let bright = graded(own, 2.0);
        // The same stop taken by moving the anchor instead, which is what this used to
        // do. Asserted against below, so the tolerance cannot quietly become vacuous.
        let by_levels = graded(Levels { white: white / 2.0, peak: white * 2.0 }, 1.0);

        let luma = |p: &[u16]| LUMA[0] * f64::from(p[0]) + LUMA[1] * f64::from(p[1]) + LUMA[2] * f64::from(p[2]);
        let chromaticity = |p: &[u16]| {
            let sum = f64::from(p[0]) + f64::from(p[1]) + f64::from(p[2]);
            (f64::from(p[0]) / sum, f64::from(p[2]) / sum)
        };
        let shift = |a: &[u16], b: &[u16]| {
            let ((ar, ab), (br, bb)) = (chromaticity(a), chromaticity(b));
            ((ar - br).powi(2) + (ab - bb).powi(2)).sqrt()
        };

        let mut worst_by_levels = 0.0f64;
        for (i, (a, b)) in dim.chunks_exact(3).zip(bright.chunks_exact(3)).enumerate() {
            assert!(luma(b) > luma(a), "pixel {i} did not brighten: {a:?} -> {b:?}");
            let moved = shift(a, b);
            assert!(moved < 0.005, "pixel {i} changed colour by {moved:.4}: {a:?} -> {b:?}");
        }
        for (a, c) in dim.chunks_exact(3).zip(by_levels.chunks_exact(3)) {
            worst_by_levels = worst_by_levels.max(shift(a, c));
        }
        assert!(
            worst_by_levels > 0.02,
            "moving the anchor should visibly rotate hue, or this frame proves nothing: {worst_by_levels:.4}",
        );
    }

    #[test]
    fn the_neutral_grade_is_monotone_in_its_input() {
        let mut out: Vec<u16> = (0..900u16).flat_map(|i| [i * 70, i * 70, i * 70]).collect();
        let options = GradeOptions {
            reference_white_nits: 203.0,
            peak_nits: 1000.0,
            match_colour: None,
            lens: None,
            levels: levels(&out, 0.9),
            exposure: 1.0,
        };
        assert!(grade(&mut out, &options));
        for i in 3..out.len() {
            if i % 3 == 0 {
                assert!(out[i] >= out[i - 3], "not monotone at {i}");
            }
        }
    }
}
