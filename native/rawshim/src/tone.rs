// Scene-referred sensor data carries no exposure. The decode scales sensor saturation to
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

use crate::hdr_fit::HdrColour;
use crate::parallel::*;

const MAX: usize = 65535;

// SMPTE ST 2084.
const M1: f64 = 2610.0 / 16384.0;
const M2: f64 = (2523.0 / 4096.0) * 128.0;
const C1: f64 = 3424.0 / 4096.0;
const C2: f64 = (2413.0 / 4096.0) * 32.0;
const C3: f64 = (2392.0 / 4096.0) * 32.0;
const PQ_MAX_NITS: f64 = 10000.0;

/// SMPTE ST 2084, forward. Public because [`encode_base`] codes the frame with it and
/// [`lift_in_pq`] folds it; the *grade's* transfer is `frame.wgsl`'s, not this one.
pub fn pq(nits: f64) -> f64 {
    let y = (nits / PQ_MAX_NITS).clamp(0.0, 1.0).powf(M1);
    ((C1 + C2 * y) / (1.0 + C3 * y)).powf(M2)
}

/// The decode, recoded into normalised PQ: `pq(level * reference / white)` at 16 bits.
///
/// **Everything downstream of the decode is in this coding**, and that is what makes the
/// filters, the warp and the resample cost what they cost. Every stage between here and the
/// shader reads a *difference against a blur*, and a difference taken in linear light follows
/// absolute luminance rather than what the eye reads (§10.9), so each of them needed a
/// perceptual domain. They used to borrow one and give it back: `image::Coding` put a table
/// on the way in and a `pq_inv` on the way out of each pass, which is two `powf` per sample
/// per pass, and a `powf` in the loop is also what stops it vectorising. Measured on a 24MP
/// frame with two passes, that was 400ms of a 2650ms job, and it scales with the sensor.
///
/// Coded once here instead, the filters are pointwise on what the buffer already holds and
/// the shader decodes with a table (`colour.wgsl`'s `nits_of`). The `u16` also lands better:
/// linear spends its codes where the eye cannot see them, and a frame whose diffuse white
/// sits near level 6000 of 65535 has almost none left for the shadows, where normalised PQ is
/// near-uniform in what a reader can distinguish.
///
/// A table because the input is an integer level: 65536 evaluations against one per sample,
/// and a 61MP frame is 180M of them.
///
/// PQ's range ends at 10000 nits, so a level past 49x the frame's own diffuse white saturates
/// here rather than being carried. That ceiling is almost not new - the coding the filters
/// borrowed and gave back clamped at exactly the same place, so any frame that reached it was
/// already losing those levels in the denoise. It is BT.2408's own headroom above a 203-nit
/// white, and five and a half stops above diffuse white is far past where the roll-off has
/// compressed everything into the display's peak anyway. What is new is that this runs whether
/// or not a filter does, where that coding was inside a pass that returned early with every
/// strength at zero - so a very dark frame rendered with the filters off keeps its speculars
/// today and would not have before.
///
/// Across cores, because it is a whole-frame sweep: 180M gathers at 61MP, on the one path every
/// rendition takes.
pub fn encode_base(samples: &mut [u16], levels: Anchored, reference_white_nits: f64) {
    let scale = reference_white_nits / levels.white;
    let forward: Vec<u16> = (0..=u16::MAX)
        .map(|level| (pq(f64::from(level) * scale) * f64::from(u16::MAX)).round() as u16)
        .collect();
    samples.par_iter_mut().for_each(|sample| *sample = forward[*sample as usize]);
}

/// ST 2084 the other way: a signal back to the nits it was coded from.
///
/// **Nothing on the rendering path calls this.** The frame goes into PQ once
/// ([`encode_base`]) and comes back out on the GPU, through a table `decode.wgsl` fills with
/// the WGSL `pq_inv` - so this is the CPU's copy of a curve the grade does not ask it for,
/// kept for the tests that have to read a coded sample back in the units it was coded from.
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
/// two, and `gain_in_y` folds `g^m1` into a constant the caller precomputes per radius.
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

// The BT.2390 roll-off lived here as `eetf` and is `frame.wgsl`'s now, in the same dispatch
// as the colour transform it follows. A copy here would be a second implementation of the
// one thing DESIGN 21.1 records the cost of letting drift; what the CPU still needs from the
// grade is `scene_peak_nits` below, which is an input to that roll-off rather than part of
// it.

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
pub const QUANTILE_SAMPLES: usize = 1 << 20;

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

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct Levels {
    pub white: f64,
    pub peak: f64,
}

impl Levels {
    /// Whether these are levels to be handed rather than ones to refuse and measure again.
    ///
    /// For the one caller that does not measure its own - a loupe tile, whose crop is not the
    /// photograph these describe - so they arrive across the API from a client and are no longer
    /// the decode's own arithmetic. Wide on purpose: a white below one is what [`anchored`]
    /// floors anyway, and a peak under it would roll the highlights the wrong way.
    ///
    /// [`anchored`]: Levels::anchored
    pub fn usable(&self) -> bool {
        self.white.is_finite() && self.peak.is_finite() && self.white >= 1.0 && self.peak >= self.white
    }

    /// The same levels with a white the pipeline can divide by.
    ///
    /// **One floor, in one place.** Both the coding and the grade divide by diffuse white, and
    /// [`levels`] reports zero for a frame whose quantile lands on level 0 - a lens cap, a
    /// failed exposure. A rendition floors rather than refusing: at a white of 1 it still
    /// renders, all but black, where declining would fail a photograph that imported before.
    ///
    /// It used to be floored at each of the three places that grade, in two spellings, with
    /// `encode_base` flooring again internally in case one of them forgot - so the invariant
    /// that `edit.white` is the white the frame was *coded* against spanned four sites and was
    /// checked at none. The type carries it now: [`encode_base`] and [`SceneGrade::new`] take
    /// only this, so a caller cannot reach either with a raw quantile.
    ///
    /// The editor does not come through here. It refuses a frame this dark outright, because
    /// `white` crosses to the client and a reader would get a flat white canvas reporting
    /// itself live rather than a picture (`edit::open`).
    pub fn anchored(self) -> Anchored {
        Anchored(Levels { white: self.white.max(1.0), peak: self.peak.max(1.0) })
    }
}

/// [`Levels`] whose white is at least 1, so dividing by it is defined.
#[derive(Clone, Copy)]
pub struct Anchored(Levels);

impl std::ops::Deref for Anchored {
    type Target = Levels;
    fn deref(&self) -> &Levels {
        &self.0
    }
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
    // A block per thread, each with its own bins. The counts are integers, so the merge is exact
    // whatever order it runs in - unlike `image.rs`'s float reductions, this cannot drift with the
    // core count, and the answer is the serial one to the bit.
    let block = counted.div_ceil(thread_count().max(1)).max(1);
    let histogram = (0..counted)
        .into_par_iter()
        .step_by(block)
        .map(|first| {
            let mut histogram = vec![0u32; MAX + 1];
            for k in first..(first + block).min(counted) {
                // Spread by fraction rather than by step: sample k lands at the same place in
                // the frame whatever the frame's resolution, which is what makes two decodes of
                // one photo agree.
                let i = sample_at(k, pixels, counted);
                let brightest = samples[i].max(samples[i + 1]).max(samples[i + 2]);
                histogram[brightest as usize] += 1;
            }
            histogram
        })
        .reduce_parallel(
            || vec![0u32; MAX + 1],
            |mut into, from| {
                for (slot, count) in into.iter_mut().zip(&from) {
                    *slot += count;
                }
                into
            },
        );
    scan(&histogram, counted, quantile)
}

/// The walk up the bins, once something has counted them.
///
/// Split from the counting so the threaded blocks above merge into one histogram and this reads
/// it once: 65536 serial bins are microseconds, and the two marks and the fallback are the part
/// that must not be spelled twice.
pub(crate) fn scan(histogram: &[u32], counted: usize, quantile: f64) -> Levels {
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
    /// The reader's own sliders. Settled on the photo like the levels and the colour, and
    /// for the same reason: two sizes of one photograph must not be adjusted differently.
    adjust: crate::gpu::Adjust,
    /// The illuminant the decode balanced against, which the pair in `adjust` moves away from.
    /// Settled on the photo like everything else here: two sizes of it must not be balanced
    /// against two different baselines.
    as_shot: Option<crate::white_balance::AsShot>,
    /// The camera's colour, or None for the neutral arm.
    matched: Option<&'a HdrColour>,
}

impl<'a> SceneGrade<'a> {
    /// No frame and no GPU. The matched arm's peak is measured off the frame that is already
    /// uploaded, by the shader, in `gpu::Uploaded::measure_peak` - so what is left here is
    /// what the uniform carries.
    ///
    /// Infallible, where this used to return None for a white of zero. [`Anchored`] is what
    /// makes that true rather than assumed: every caller had to floor the white before coding
    /// the frame with it anyway, so the arm that handled the unfloored case was unreachable
    /// from all four of them - an error string that read as a live outcome and was not.
    pub fn new(
        colour: Option<&'a HdrColour>,
        levels: Anchored,
        reference: f64,
        exposure: f64,
        adjust: crate::gpu::Adjust,
        as_shot: Option<crate::white_balance::AsShot>,
    ) -> Self {
        assert!(exposure.is_finite(), "an exposure is a number of stops: {exposure}");
        SceneGrade { levels: *levels, reference, exposure, adjust, as_shot, matched: colour }
    }

    /// This scene as the shader's uniform wants it.
    ///
    /// Assembled here so the fields stay private and so the one place that knows what a
    /// scene *is* is the one place that describes it to the GPU.
    ///
    /// No scene peak: the matched arm's is measured on the GPU off the uploaded frame, and
    /// the neutral arm's is `source_level / white` scaled by the reference, which the shader
    /// does for itself from the two fields below.
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
            // Its own, which every whole frame's is. A tile overrides it with the photograph's.
            photograph_long: width.max(height),
            colour: self.matched,
            white: self.levels.white,
            source_level: self.levels.peak,
            reference_nits: self.reference,
            peak_nits,
            exposure: self.exposure,
            adjust: self.adjust,
            as_shot: self.as_shot,
            output,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PQ is absolute and its range runs to 10000 nits, so a 1000-nit peak encodes at about
    /// 0.752 of the code range and must not be stretched to fill it - the file would then
    /// claim its diffuse white is 10000 nits, which is the mistake `npl` existed to prevent.
    ///
    /// The transfer itself is `frame.wgsl`'s now, applied in the same dispatch as the grade
    /// and pinned by the GPU fixtures. What is left here is the curve those two share: this
    /// `pq` is what the shader's `pq` has to agree with, and what `lift_in_pq` folds.
    #[test]
    fn the_display_peak_lands_where_pq_puts_it_rather_than_at_full_scale() {
        // At the code the shader writes, not on the raw curve: `pq(0)` is `C1^m2`, about
        // 7.3e-7, which is black only once it is quantised.
        assert_eq!((pq(0.0) * 65535.0).round(), 0.0, "black must stay black");
        let peak = pq(1000.0);
        assert!((0.74..0.76).contains(&peak), "{peak}");
        let mut previous = -1.0;
        for step in 0..=255 {
            let at = pq((f64::from(step) / 255.0) * 10000.0);
            assert!(at >= previous, "not monotone at {step}");
            previous = at;
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

    // The two roll-off tests that lived here went with `eetf`. The curve is `frame.wgsl`'s
    // now and is asserted where it runs: `gpu_fixture` pins the rolled arm across a low peak
    // (203, where the whole BT.2390 knee is in play) and a high one (1000, where the source
    // already fits and the curve returns early), which is the same pair of cases.

    #[test]
    fn levels_read_the_quantile_off_the_brightest_component() {
        // A ramp where the brightest component of each pixel is its red.
        let samples: Vec<u16> = (0..3000).flat_map(|i| [i as u16 * 20, 5, 5]).collect();
        let out = levels(&samples, 0.9);
        assert!(out.peak > out.white, "the peak must sit above diffuse white");
        assert!(out.white > 0.0);
    }

    /// Every sample counted exactly once, however the blocks fall.
    ///
    /// `counted` is odd, so `div_ceil` leaves a final block shorter than the rest on any machine
    /// with more than one thread - which is the boundary a blocked split drops or double-counts a
    /// sample at, and a frame whose count divided evenly would never show it.
    #[test]
    fn levels_count_every_sample_once_however_it_is_blocked() {
        let pixels = 40_961usize;
        let samples: Vec<u16> = (0..pixels)
            .flat_map(|i| {
                let level = (i.wrapping_mul(2_654_435_761) % 60_000) as u16;
                [level, level / 2, level / 3]
            })
            .collect();

        let counted = pixels.min(QUANTILE_SAMPLES);
        let mut serial = vec![0u32; MAX + 1];
        for k in 0..counted {
            let i = sample_at(k, pixels, counted);
            serial[samples[i].max(samples[i + 1]).max(samples[i + 2]) as usize] += 1;
        }
        assert_eq!(serial.iter().sum::<u32>(), counted as u32, "the reference counted every sample");

        assert_eq!(levels(&samples, 0.995), scan(&serial, counted, 0.995));
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
