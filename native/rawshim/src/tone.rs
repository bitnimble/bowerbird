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

/// The SDR counterpart of [`encode_pq`]: a graded frame to 8-bit sRGB.
///
/// There is no second rendering path for SDR. Everything upstream is scene-linear at 16
/// bits and the grade is already parameterised by the display it targets, so an SDR
/// rendition is the same grade with `peak_nits` at diffuse white - which leaves full scale
/// meaning sRGB 1.0 and nothing here to tone map. What is left is the primaries, since the
/// grade works in Rec.2020 and the file is tagged sRGB (`avif::encode_rendition`), and the
/// transfer.
///
/// `srgb_oetf` rather than `bt709_oetf`: the file claims transfer 13, and matching the tag
/// is the point now that the pixels are this side's rather than LibRaw's 8-bit output.
pub fn encode_srgb8(frame: &[u16]) -> Vec<u8> {
    let to_srgb = hdr_fit::rec2020_to_srgb();
    let full = f64::from(u16::MAX);
    // The transfer as a table. The primaries mix the channels, so its input is not on the
    // input's lattice - but the *output* is 8 bits, so quantising that input to 16 first
    // costs nothing a byte can hold: the steepest part of the curve is the toe, where one
    // step of 1/65535 moves the answer by 0.025 of a count. Left as a `powf` it was one per
    // channel per sample, ~30M on a 3840px rendition.
    let oetf: Vec<u8> = (0..=u16::MAX)
        .map(|code| (255.0 * hdr_fit::srgb_oetf(f64::from(code) / full)).round() as u8)
        .collect();
    let mut out = vec![0u8; frame.len()];
    out.par_chunks_exact_mut(3)
        .zip(frame.par_chunks_exact(3))
        .for_each(|(pixel, graded)| {
            let v = [0, 1, 2].map(|c| f64::from(graded[c]) / full);
            for c in 0..3 {
                let m = to_srgb[c];
                let linear = m[0] * v[0] + m[1] * v[1] + m[2] * v[2];
                // Out of gamut clamps, which is what `srgb_oetf` did with it too.
                pixel[c] = oetf[(linear.clamp(0.0, 1.0) * full).round() as usize];
            }
        });
    out
}

/// PQ over a buffer holding absolute nits, for the filters to read it perceptually.
///
/// What the sharpen runs through: it works on the frame between the colour transform and the
/// roll-off, which is display-referred nits and so linear. PQ is *absolute*, so this coding
/// says nothing about which display the frame is bound for - one sharpen serves every
/// rendition cut from that frame.
/// The way in is a table, and it can be because **an `f16` has only 65536 values**: `pq` of
/// one is a pure function of its bit pattern, so this is 65536 evaluations against one per
/// sample. A 61MP frame is 180M samples and `pq` is two `powf`. The way back cannot be -
/// it reads the filter's f32 output, which is not on any lattice.
#[derive(Clone, Copy)]
pub struct NitsPq<'a> {
    forward: &'a [f32],
}

impl<'a> NitsPq<'a> {
    /// The table [`NitsPq`] reads, indexed by an `f16`'s bits.
    pub fn table() -> Vec<f32> {
        (0..=u16::MAX)
            .map(|bits| pq(f64::from(half::f16::from_bits(bits).to_f32())) as f32)
            .collect()
    }

    pub fn new(forward: &'a [f32]) -> NitsPq<'a> {
        NitsPq { forward }
    }
}

/// PQ of every `f16` of nits, as a `u16` code: what a frame of nits becomes when stored
/// coded.
///
/// The same 65536-value argument as [`NitsPq::table`] - the input has a finite domain, so
/// the transfer is a lookup rather than two `powf`.
///
/// **`u16` out, not `f16`.** PQ already normalises to 0..1, so a float's exponent buys
/// nothing there and what is left is 11 bits of mantissa across the whole range - an ULP of
/// ~0.001 near white, which is ~87 output levels. Measured, storing the coded frame at half
/// precision cost the shared route mean 5.04 counts of 65535 against the nits it replaced.
/// A `u16` is the same width, uniform over exactly the range PQ occupies, and is what the
/// HDR encode wants anyway. `f16` earns its exponent on *nits*, which span decades; it has
/// nothing to earn it on here.
pub fn pq_of_f16() -> Vec<u16> {
    (0..=u16::MAX)
        .map(|bits| {
            let nits = f64::from(half::f16::from_bits(bits).to_f32());
            match nits.is_finite() && nits > 0.0 {
                true => (pq(nits) * MAX as f64).round() as u16,
                false => 0,
            }
        })
        .collect()
}

impl crate::image::Coding for NitsPq<'_> {
    #[inline]
    fn to_filter(&self, nits: f32) -> f32 {
        // Back to the `f16` this widened from, which is exact, and then to its index.
        self.forward[half::f16::from_f32(nits).to_bits() as usize]
    }
    #[inline]
    fn from_filter(&self, signal: f32) -> f32 {
        pq_inv(f64::from(signal)) as f32
    }
}

/// PQ over a buffer holding scene-linear levels, anchored by the frame's own diffuse white.
///
/// What the denoise and the defringe run through, on the decode, before the warp. Linear is
/// the wrong domain for a difference against a blur and the grade's output is not available
/// yet - what is left is a perceptual coding that has nothing to do with the exposure, which
/// is PQ against a fixed anchor.
///
/// The way in is a table because the input is an integer level: 65536 evaluations against one
/// per sample, and a 61MP frame is 180M of them. The way back cannot be, reading the filter's
/// f32 output rather than a level.
#[derive(Clone, Copy)]
pub struct ScenePq<'a> {
    /// `pq(level * scale)` for every level a `u16` can hold.
    forward: &'a [f32],
    /// Levels per nit: the way back, as a multiply rather than the division by nits-per-level
    /// it would otherwise be, once per sample.
    inv_scale: f64,
}

impl<'a> ScenePq<'a> {
    /// The table [`ScenePq`] reads, for a frame whose diffuse white sits at `white`.
    pub fn table(white: f64, reference_white_nits: f64) -> (Vec<f32>, f64) {
        let scale = reference_white_nits / white.max(1.0);
        let forward =
            (0..=u16::MAX).map(|level| pq(f64::from(level) * scale) as f32).collect();
        (forward, scale)
    }

    pub fn new(forward: &'a [f32], scale: f64) -> ScenePq<'a> {
        ScenePq { forward, inv_scale: 1.0 / scale }
    }
}

impl crate::image::Coding for ScenePq<'_> {
    #[inline]
    fn to_filter(&self, level: f32) -> f32 {
        self.forward[(level as usize).min(self.forward.len() - 1)]
    }
    #[inline]
    fn from_filter(&self, signal: f32) -> f32 {
        (pq_inv(f64::from(signal)) * self.inv_scale) as f32
    }
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

/// A gain in linear light, applied to a PQ signal without leaving PQ.
///
/// **The correction is still a multiplication of light** - vignetting is an optical
/// attenuation and its inverse is multiplicative in nits, which is not a convention to be
/// relabelled. What this exploits is that PQ's own intermediate already carries it:
///
/// ```text
/// s = ((c1 + c2·y) / (1 + c3·y))^m2      where  y = (Y/10000)^m1
/// Y' = g·Y   =>   y' = (g·Y/10000)^m1 = g^m1 · y
/// ```
///
/// So a gain in light is a plain multiply in `y`, and the `^m1` / `^(1/m1)` pair that
/// `pq_inv` and `pq` would evaluate cancels outright. The round trip is four `powf`; this is
/// one, and `gain_in_y` folds `g^m1` into a constant the caller precomputes per radius.
///
/// `signal` and the result are 0..1. Exact, not an approximation - the same arithmetic with
/// two of its steps cancelled.
pub fn lift_in_pq(signal: f64, gain_in_y: f64) -> f64 {
    let u = signal.clamp(0.0, 1.0).powf(1.0 / M2);
    // Bounded at 1 because `pq` bounds what it takes the exponent of - `(Y/10000).clamp()`.
    // Without it a gain pushes past 10000 nits and the curve keeps climbing where the
    // transfer saturates: at a gain of 2.8 near white the fold reads 1.108 against the round
    // trip's 1.0.
    let y = (((u - C1).max(0.0) / (C2 - C3 * u)) * gain_in_y).min(1.0);
    ((C1 + C2 * y) / (1.0 + C3 * y)).powf(M2)
}

/// `g^m1`, the constant [`lift_in_pq`] multiplies by, for a gain of `g` in light.
pub fn gain_in_y(gain: f64) -> f64 {
    gain.max(0.0).powf(M1)
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



/// Everything the grade settles for one photo, before any rendition's size or display.
///
/// The matched arm's three curve tables are 65536 entries each, built by evaluating
/// `hdr_fit::tone_channel`, and the scene peak is a quantile taken through the whole colour
/// transform over a million pixels. Neither depends on the size a rendition is cut at or on
/// the peak it targets, and both used to be redone per rendition for the same answer.
///
/// Sharing the scene peak is a correctness fix as much as a saving: it is what every pixel
/// is rolled off against, and two renditions of one photo measuring it off two differently
/// sized frames were compressing their highlights by different amounts. This is the same
/// argument [`levels`] already makes about the anchor, and it is settled the same way - once,
/// on the photo.
///
/// None where there is no exposure to read: `white` at zero, or a non-positive exposure, or
/// a matched frame whose peak comes back zero. The caller ships the frame as it arrived,
/// which beats dividing by zero.
pub struct SceneGrade<'a> {
    levels: Levels,
    reference: f64,
    exposure: f64,
    /// The matched arm's tables and the scene peak they were measured through, or None for
    /// the neutral arm.
    matched: Option<(MatchedGrade<'a>, f64)>,
}

impl<'a> SceneGrade<'a> {
    /// `frame` is the photo's own scene-linear samples, at whatever size they arrived.
    pub fn new(
        frame: &[u16],
        colour: Option<&'a HdrColour>,
        levels: Levels,
        reference: f64,
        exposure: f64,
    ) -> Option<Self> {
        if levels.white == 0.0 || !(exposure > 0.0) {
            return None;
        }
        let matched = match colour {
            None => None,
            Some(colour) => {
                let grade = MatchedGrade::new(colour, levels.white, exposure, reference);
                let scene_peak = grade.scene_peak_nits(frame)?;
                Some((grade, scene_peak))
            }
        };
        Some(SceneGrade { levels, reference, exposure, matched })
    }

    /// This scene as the shader's uniform wants it.
    ///
    /// Assembled here so the fields stay private and so the one place that knows what a
    /// scene *is* is the one place that describes it to the GPU. `colour` reaches through
    /// `MatchedGrade` rather than being stored twice.
    pub fn gpu_grade(
        &'a self,
        width: usize,
        height: usize,
        peak_nits: f64,
        output: crate::gpu::Output,
    ) -> crate::gpu::Grade<'a> {
        crate::gpu::Grade {
            width,
            height,
            colour: self.matched.as_ref().map(|(grade, _)| grade.colour),
            white: self.levels.white,
            source_level: self.levels.peak,
            reference_nits: self.reference,
            peak_nits,
            exposure: self.exposure,
            scene_peak: self.scene_peak_nits(),
            output,
        }
    }



    /// The scene's own top end, in nits, which every rendition rolls off against.
    ///
    /// Measured for the matched arm and read off the levels for the neutral one, but a
    /// property of the photograph either way - which is what makes two sizes of it compress
    /// their highlights by the same amount.
    pub fn scene_peak_nits(&self) -> f64 {
        match &self.matched {
            Some((_, peak)) => *peak,
            None => (self.levels.peak / self.levels.white) * self.reference,
        }
    }

    /// The colour transform alone, stopping short of any display - everything a rendition's
    /// peak does not change (`tone::MatchedGrade::pixel_nits`).
    ///
    /// **Stored as PQ of those nits rather than the nits**, which is what leaves the shared
    /// path with no transcendental in it at all: the sharpen then reads the frame in the
    /// domain it filters in, so its coding is the identity, and the roll-off reads a table
    /// indexed by the same signal. Storing nits instead cost a `pq` and a `pq_inv` per sample
    /// between the two.
    ///
    /// Coded rather than linear so the sharpen reads it in the domain it filters in, and
    /// `u16` rather than `f16` for the reason [`pq_of_f16`] records: a float's exponent earns
    /// nothing on a signal that is already 0..1.
    pub fn to_signal(&self, frame: &[u16], lens: Option<&PlanarWarp>) -> Vec<u16> {
        let coded = pq_of_f16();
        let signal = |r: u16, g: u16, b: u16| -> [u16; 3] {
            let nits = match &self.matched {
                Some((matched, _)) => matched.pixel_nits(r, g, b),
                None => {
                    let white = self.levels.white / self.exposure;
                    [r, g, b].map(|v| (f64::from(v) / white) * self.reference)
                }
            };
            // Through `f16` because that is what makes the transfer a lookup: nits span
            // decades, so half precision holds them to ~0.05% wherever they sit.
            nits.map(|v| coded[half::f16::from_f64(v).to_bits() as usize])
        };
        match lens {
            Some(lens) => lens.map_u16(frame, |r, g, b| signal(r, g, b)),
            None => {
                let mut out = vec![0u16; frame.len()];
                out.par_chunks_exact_mut(3).zip(frame.par_chunks_exact(3)).for_each(
                    |(slot, px)| slot.copy_from_slice(&signal(px[0], px[1], px[2])),
                );
                out
            }
        }
    }

    /// One rendition, off a frame [`Self::to_signal`] produced: the roll-off into this
    /// display's peak, and nothing else.
    ///
    /// Indexed by the signal the frame is stored in, so nothing here converts. The curve is
    /// the same BT.2390 one either way; binning it over PQ rather than over nits also puts
    /// its resolution where a photograph keeps its codes, which is the shadows.
    ///
    /// **Each arm rolls over the range it rolls over when it grades directly**, and they
    /// differ. The matched arm stops at the scene peak, that being a quantile of the
    /// post-colour subsample and the top of the domain `eetf` was given. The neutral arm's
    /// curve is defined above its own peak and its speculars depend on that, so its table
    /// spans every nit an input level can reach. Giving both the matched arm's range looked
    /// tidier and quietly clipped the neutral arm's speculars flat - 10985 counts of 65535
    /// on the Sony fixture.
    pub fn roll(&self, signal: &[u16], peak_nits: f64) -> Vec<u16> {
        let scene_peak = self.scene_peak_nits();
        // The matched arm stops at the scene peak; the neutral arm's curve carries above it.
        let ceiling = match &self.matched {
            Some(_) => scene_peak,
            None => f64::INFINITY,
        };
        // **Every value the input can take, tabulated.** The frame is `u16`, so its domain is
        // 65536 wide and the whole function fits - no interpolation, no error, one lookup a
        // sample, and no transfer evaluated per pixel anywhere on this path.
        let full = MAX as f64;
        let table: Vec<u16> = (0..=u16::MAX)
            .map(|code| {
                let nits = pq_inv(f64::from(code) / full).min(ceiling);
                let rolled = eetf(nits, scene_peak, peak_nits);
                ((rolled / peak_nits).min(1.0) * full).round() as u16
            })
            .collect();

        let mut out = vec![0u16; signal.len()];
        out.par_iter_mut()
            .zip(signal.par_iter())
            .for_each(|(slot, code)| *slot = table[*code as usize]);
        out
    }

}




/// Matched colour + roll-off, shared by the in-place editor path and the fused encode.
///
/// **The display's peak is not in here**, and that is what makes one of these serve every
/// rendition of a photo: the curves, the matrix and the chroma lattice are the camera's, and
/// only the final roll-off knows what it is rolling into. It is a parameter of
/// [`MatchedGrade::roll_table`] and [`MatchedGrade::pixel`] instead.
struct MatchedGrade<'a> {
    colour: &'a HdrColour,
    white: f64,
    exposure: f64,
    reference: f64,
    ceiling: f64,
    curve_lut: [Vec<f32>; 3],
    exposed_lut: Option<[Vec<f32>; 3]>,
}

impl<'a> MatchedGrade<'a> {
    fn new(colour: &'a HdrColour, white: f64, exposure: f64, reference: f64) -> Self {
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


    /// The camera's colour at this pixel, in nits, before any display is chosen.
    ///
    /// **Everything here is a property of the photograph rather than of the rendition**, which
    /// is what lets several renditions of one photo share the sweep that produces it: the
    /// fitted curves, the matrix, and the chroma lattice or the saturation scalar. Only
    /// [`Self::roll_pixel`] below knows what it is rolling into.
    #[inline]
    fn pixel_nits(&self, r: u16, g: u16, b: u16) -> [f64; 3] {
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
        [or, og, ob].map(|raw| if raw > 0.0 { raw * self.reference } else { 0.0 })
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

    /// The falloff's whole reason for needing linear light, cancelled.
    ///
    /// A lens correction is a multiply in nits, so applying it to a PQ frame reads as
    /// `pq(pq_inv(s) * g)` - four `powf` per sample, in the warp, which is the hottest loop
    /// in the pipeline. [`lift_in_pq`] is the same arithmetic with the `^m1` pair cancelled,
    /// so it has to agree with the round trip to the last bit that matters, and it is only
    /// worth having if it does.
    #[test]
    fn a_gain_in_light_is_a_multiply_inside_pq() {
        let mut worst = 0.0f64;
        // Past both ends of what a lens asks for: a corner needing a stop and a half back,
        // and a correction the other way.
        for gain in [0.5f64, 0.8, 1.0, 1.25, 1.5, 2.0, 2.8] {
            let k = gain_in_y(gain);
            for step in 0..=1000 {
                let signal = f64::from(step) / 1000.0;
                let direct = pq(pq_inv(signal) * gain).clamp(0.0, 1.0);
                let folded = lift_in_pq(signal, k);
                worst = worst.max((direct - folded).abs());
            }
        }
        // Of a 0..1 signal, so under a thousandth of a 16-bit code.
        assert!(worst < 1e-8, "the folded gain drifts from the round trip by {worst:e}");
    }

    /// And that it is not accidentally the identity, which would pass the test above if
    /// `pq_inv` and `pq` were both returning their input.
    #[test]
    fn the_folded_gain_actually_moves_the_signal() {
        let lit = lift_in_pq(0.5, gain_in_y(1.5));
        assert!(lit > 0.5 + 0.01, "a gain above one must raise the signal, got {lit}");
        let cut = lift_in_pq(0.5, gain_in_y(0.5));
        assert!(cut < 0.5 - 0.01, "a gain below one must lower it, got {cut}");
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



}
