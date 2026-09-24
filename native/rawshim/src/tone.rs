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
use crate::light::{DisplayNits, Gain, Level, Light, Nits, Pq, SceneNits, Stops};

const MAX: usize = 65535;

/// One bin per level a `u16` sample can take, which is what `fit_source` sizes its buffer to.
pub(crate) const LEVEL_BINS: usize = MAX + 1;

// SMPTE ST 2084.
const M1: f64 = 2610.0 / 16384.0;
const M2: f64 = (2523.0 / 4096.0) * 128.0;
const C1: f64 = 3424.0 / 4096.0;
const C2: f64 = (2413.0 / 4096.0) * 32.0;
const C3: f64 = (2392.0 / 4096.0) * 32.0;
const PQ_MAX_NITS: f64 = 10000.0;

/// SMPTE ST 2084, forward.
///
/// **The curve, not the stage.** Coding a frame with it is `base.slang`'s `encode_base` and only
/// that; what this is for is the callers that need the transfer at a point rather than over a
/// buffer - the roll-off reasoning about where a level lands, and the test that holds the shader
/// to ST 2084. The *grade's* transfer is `frame.slang`'s, not this one.
///
/// PQ's range ends at 10000 nits, so a level past 49x the frame's own diffuse white saturates
/// rather than being carried. That is BT.2408's own headroom above a 203-nit white, and five and a
/// half stops above diffuse white is far past where the roll-off has compressed everything into
/// the display's peak anyway.
///
/// **The domain is the caller's to name**, as it is in `prelude.slang`: the curve is absolute, so
/// `base::coding_curve` codes the *scene's* nits with it and the roll-off compresses the
/// *display's*, and nothing about ST 2084 can tell those apart.
pub fn pq<D: Nits>(nits: Light<D>) -> Light<Pq> {
    let y = (nits.raw() / PQ_MAX_NITS).clamp(0.0, 1.0).powf(M1);
    Light::measured(((C1 + C2 * y) / (1.0 + C3 * y)).powf(M2))
}

/// ST 2084 the other way: a signal back to the nits it was coded from.
///
/// **The grade does not call this.** The frame goes into PQ once ([`encode_base`]) and comes
/// back out on the GPU, through a table `decode.slang` fills with the WGSL `pq_inv`. What does
/// is `base::light_of_code`, the table `reduce.slang` averages light behind, and the tests that
/// have to read a coded sample back in the units it was coded from.
pub fn pq_inv<D: Nits>(signal: Light<Pq>) -> Light<D> {
    let e = signal.raw().clamp(0.0, 1.0).powf(1.0 / M2);
    Light::measured(PQ_MAX_NITS * ((e - C1).max(0.0) / (C2 - C3 * e)).powf(1.0 / M1))
}

/// `g^m1`, the constant `warp.slang`'s `lift_in_pq` multiplies by, for a gain of `g` in light.
///
/// **The correction is still a multiplication of light** - vignetting is an optical
/// attenuation and its inverse is multiplicative in nits, which is not a convention to be
/// relabelled. What the shader exploits is that PQ's own intermediate already carries it:
///
/// ```text
/// s = ((c1 + c2·y) / (1 + c3·y))^m2      where  y = (Y/10000)^m1
/// Y' = g·Y   =>   y' = (g·Y/10000)^m1 = g^m1 · y
/// ```
///
/// So a gain in light is a plain multiply in `y`, and the `^m1` / `^(1/m1)` pair that
/// `pq_inv` and `pq` would evaluate cancels outright. The round trip is four `pow`; the fold
/// is two, and this is the constant it multiplies by, precomputed per radius.
pub fn gain_in_y(gain: Gain) -> f64 {
    gain.raw().max(0.0).powf(M1)
}

/// How many pixels `fit_source.slang`'s `fit_levels` reads. A quantile does not need every
/// pixel of a 60MP frame, and it must not read a number of them that depends on how big the
/// frame is.
///
/// A fixed *count* rather than a fixed stride, which is the whole point. `peak` is the
/// maximum over whatever was sampled, so sampling four times as many pixels finds a
/// brighter one - and the same photo decoded at two sizes then anchors differently.
/// Measured on the 24MP fixture with a stride: a full decode read 1.51M pixels and a
/// halved one 379K, and the halved frame's peak came back 0.76% higher for no reason
/// but the count.
pub const QUANTILE_SAMPLES: usize = 1 << 20;

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

/// Where the frame's bottom end is read, for the low tone zones to be placed against.
///
/// Fifty times as generous as the peak's `0.0001` at the other end, and the asymmetry is the
/// histogram's rather than a preference. What sits above the peak's mark is speculars, which are
/// in the picture; what piles up at the very bottom is read noise, a black-level residual and the
/// handful of dead photosites every sensor has, none of which is. Five thousand samples of a
/// million is past all of that and still the bottom half-percent of the picture.
const FLOOR_QUANTILE: f64 = 0.005;

/// The coded level the body's own rendering is taken to call diffuse white.
///
/// **Not from the standard, because no body obeys it here.** ISO 12232's saturation-based speed
/// puts a metered 100% reflector at `(100/18) * (10/78)`, about 0.71 of saturation, and measured
/// over this library every body keeps two stops and more of headroom past that - so the standard's
/// arithmetic cannot supply this constant and the bodies' own rendering has to.
const BODY_WHITE_CODE: u8 = 237;

/// Rank is carried across, so a share of exactly one would anchor on the frame's brightest sample
/// and a share of zero on its darkest. Neither is a picture; both are a preview that is not of this
/// frame, and the bounds are wide enough that no real one meets them.
const BODY_WHITE_SHARE: std::ops::RangeInclusive<f64> = 0.02..=0.9995;

/// The quantile of the frame's own histogram that its diffuse white sits at, read off the body's
/// rendering of the same scene.
///
/// **Diffuse white is the one level nothing in the frame identifies.** Black is a pedestal and
/// saturation is a clip - both are measurements in counts - but a scene-referred frame carries no
/// exposure in its pixels, since doubling the shutter doubles every code with the scene unchanged.
/// So a fixed quantile is not a measurement of the anchor, it is an assumption about the scene's
/// reflectance distribution, and it fails where that assumption does.
///
/// The body already decided, and its decision is in the file. Carried across by **rank rather than
/// by pairing pixels**: both pictures are the same scene and the camera's rendering is monotone in
/// scene light, so the level at rank `q` of one is the level at rank `q` of the other. That needs
/// no registration, no lens model and no colour transform - unlike the colour fit's pairs, which
/// exist to compare colours at a point and not ranks.
///
/// Set by the comparison harness so that both anchors can be rendered from one process, which is
/// the only way to measure what the choice costs across a library without rebuilding between arms.
///
/// Off while the rule is unproven: the levels a library already holds were measured under the
/// configured quantile, and a default that moved would re-grade every photograph in it.
static BODY_ANCHOR: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn use_body_anchor(on: bool) {
    BODY_ANCHOR.store(on, std::sync::atomic::Ordering::Relaxed);
}

pub fn body_anchor_wanted() -> bool {
    BODY_ANCHOR.load(std::sync::atomic::Ordering::Relaxed)
}

/// None where the body never reached [`BODY_WHITE_CODE`], which is the body saying there is no
/// white in this picture. The caller's configured quantile answers then.
pub fn body_white_quantile(preview: crate::rgb::RgbRef<'_>) -> Option<f64> {
    if !body_anchor_wanted() {
        return None;
    }
    // The brightest channel, because that is what `fit_source.slang`'s `fit_scan` histograms on the
    // other side. A rank only carries a level across if both sides rank the same quantity: read as
    // luma here and as a maximum there, the same rank lands on a higher level, and the anchor comes
    // back further above white the more saturated the picture is.
    let mut coded: Vec<u8> =
        preview.data.chunks_exact(3).map(|rgb| rgb[0].max(rgb[1]).max(rgb[2])).collect();
    if coded.is_empty() {
        return None;
    }
    coded.sort_unstable();
    let below = coded.partition_point(|level| *level < BODY_WHITE_CODE);
    if below >= coded.len() {
        return None;
    }
    let share = below as f64 / coded.len() as f64;
    BODY_WHITE_SHARE.contains(&share).then_some(share)
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct Levels {
    pub white: Light<Level>,
    pub peak: Light<Level>,
    /// Where the picture's own darkest end sits, which is what `adjust.slang` places Blacks and
    /// Shadows against.
    ///
    /// **None is "nobody measured one", and it is not the same as zero.** A frame with real black
    /// in it reads a floor of zero, and that is the answer; a caller that never walked a histogram
    /// has no answer, and the two must not collapse - the first places the pair at their deepest
    /// because the picture reaches there, the second because there is nothing to say otherwise.
    /// [`usable`] refuses the second, so a set of levels handed across the API without one is
    /// measured again rather than grading the low half against a guess.
    ///
    /// [`usable`]: Levels::usable
    #[serde(default)]
    pub floor: Option<Light<Level>>,
}

impl Levels {
    /// Whether these are levels to be handed rather than ones to refuse and measure again.
    ///
    /// For the callers that do not measure their own - a loupe tile and a band of a re-prepare,
    /// whose crops are not the photograph these describe - so they arrive across the API from a
    /// client rather than out of the decode's own arithmetic. Wide on purpose: a white below one
    /// is what [`anchored`] floors anyway, and a peak under it would roll the highlights the
    /// wrong way.
    ///
    /// [`anchored`]: Levels::anchored
    pub fn usable(&self) -> bool {
        self.white.is_finite()
            && self.peak.is_finite()
            && self.white >= Light::COUNT
            && self.peak >= self.white
            && self.floor.is_some_and(|floor| floor.is_finite() && floor <= self.white)
    }

    /// These levels with diffuse white where the file says it is, for a picture shown as it was
    /// encoded rather than graded again.
    pub fn at_stated_white(self, white: Light<Level>) -> Levels {
        Levels { white, peak: self.peak.max(white), ..self }
    }

    /// The same levels with a white the pipeline can divide by.
    ///
    /// **One floor, in one place.** Both the coding and the grade divide by diffuse white, and
    /// `fit_scan` reports zero for a frame whose quantile lands on level 0 - a lens cap, a
    /// failed exposure. A rendition floors rather than refusing: at a white of 1 it still
    /// renders, all but black, where declining would fail a photograph that imported before.
    ///
    /// **The type is what carries the invariant**, rather than each of the three places that
    /// grade flooring for itself: `edit.white` has to be the white the frame was *coded* against,
    /// and spread over four sites that is an invariant checked at none. [`encode_base`] and
    /// [`SceneGrade::new`] take only this, so a caller cannot reach either with a raw quantile.
    ///
    /// The editor does not come through here. It refuses a frame this dark outright, because
    /// `white` crosses to the client and a reader would get a flat white canvas reporting
    /// itself live rather than a picture (`edit::open`).
    pub fn anchored(self) -> Anchored {
        Anchored(Levels {
            white: self.white.max(Light::COUNT),
            peak: self.peak.max(Light::COUNT),
            // Not floored with them: zero is a real black and the grade divides nothing by this.
            floor: self.floor,
        })
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

/// The three running counts `fit_source.slang`'s `fit_scan` marks its levels at, over a histogram
/// of `counted` samples: the floor, diffuse white and the frame's top end, in that order.
///
/// Whole samples rather than the quantile itself, so the shader compares integers: over an
/// integer count `seen >= counted * quantile` is exactly `seen >= ceil(counted * quantile)`, and
/// a mark carried across as an f32 could otherwise round to the far side of the count that
/// crosses it here.
pub(crate) fn marks(counted: usize, quantile: f64) -> (u32, u32, u32) {
    let mark = |q: f64| (counted as f64 * q).ceil().max(1.0) as u32;
    (mark(FLOOR_QUANTILE), mark(quantile), mark(PEAK_QUANTILE))
}

/// The furthest below the scene's top end diffuse white may be read: three stops.
pub(crate) const WHITE_FLOOR_UNDER_PEAK: Gain = Gain::of_ratio(8.0);

/// Everything the grade settles for one photo, before any rendition's size or display.
///
/// The matched arm's three curve tables are 65536 entries each, read by `colour.slang`'s
/// `curves_at`, and the scene peak is a quantile taken through the whole colour
/// transform over a million pixels. Neither depends on the size a rendition is cut at or on the
/// peak it targets, so both are settled once here rather than per rendition.
///
/// Sharing the scene peak is a correctness fix as much as a saving: it is what every pixel
/// is rolled off against, and two renditions of one photo measuring it off two differently
/// sized frames were compressing their highlights by different amounts. This is the same
/// argument [`QUANTILE_SAMPLES`] already makes about the anchor, and it is settled the same
/// way - once, on the photo.
///
/// None where there is no exposure to read: `white` at zero, or a non-positive exposure, or
/// a matched frame whose peak comes back zero. The caller ships the frame as it arrived,
/// which beats dividing by zero.
pub struct SceneGrade<'a> {
    levels: Levels,
    reference: Light<SceneNits>,
    exposure: Stops,
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
    /// Infallible, and [`Anchored`] is what makes that true rather than assumed: a white of zero
    /// cannot reach here, because every caller has to floor it before coding the frame with it.
    pub fn new(
        colour: Option<&'a HdrColour>,
        levels: Anchored,
        reference: Light<SceneNits>,
        exposure: Stops,
        adjust: crate::gpu::Adjust,
        as_shot: Option<crate::white_balance::AsShot>,
    ) -> Self {
        assert!(exposure.raw().is_finite(), "an exposure is a number of stops: {exposure:?}");
        SceneGrade {
            levels: *levels,
            reference,
            exposure,
            adjust,
            as_shot,
            matched: adjust.colour(colour),
        }
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
        peak_nits: Light<DisplayNits>,
        output: crate::gpu::Output,
    ) -> crate::gpu::Grade<'a> {
        crate::gpu::Grade {
            colour: self.matched,
            exposure: self.exposure,
            adjust: self.adjust,
            as_shot: self.as_shot,
            output,
            ..crate::gpu::Grade::new(width, height, self.levels, self.reference, peak_nits)
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
    /// The transfer itself is `frame.slang`'s now, applied in the same dispatch as the grade
    /// and pinned by the GPU fixtures. What is left here is the curve those two share: this
    /// `pq` is what the shader's `pq` has to agree with.
    #[test]
    fn the_display_peak_lands_where_pq_puts_it_rather_than_at_full_scale() {
        let coded = |nits: f64| pq(Light::<DisplayNits>::measured(nits)).raw();
        // At the code the shader writes, not on the raw curve: `pq(0)` is `C1^m2`, about
        // 7.3e-7, which is black only once it is quantised.
        assert_eq!((coded(0.0) * 65535.0).round(), 0.0, "black must stay black");
        let peak = coded(1000.0);
        assert!((0.74..0.76).contains(&peak), "{peak}");
        let mut previous = -1.0;
        for step in 0..=255 {
            let at = coded((f64::from(step) / 255.0) * 10000.0);
            assert!(at >= previous, "not monotone at {step}");
            previous = at;
        }
    }

    #[test]
    fn pq_round_trips_through_its_inverse() {
        for nits in [0.0, 1.0, 100.0, 203.0, 1000.0, 4000.0, 10000.0] {
            let back = pq_inv::<DisplayNits>(pq(Light::<DisplayNits>::measured(nits))).raw();
            assert!((back - nits).abs() < 0.01, "{nits} came back {back}");
        }
    }

    // The BT.2390 roll-off is `frame.slang`'s and is asserted where it runs: `gpu_fixture` pins
    // the rolled arm across a low peak (203, where the whole knee is in play) and a high one
    // (1000, where the source already fits and the curve returns early).

    /// A frame of one pixel per level asked for, grey, one row tall. `fit_levels` samples a fixed
    /// count and this is shorter than that count, so every pixel is read exactly once and the
    /// histogram it counts is these levels themselves.
    fn frame(levels: impl IntoIterator<Item = usize>) -> Vec<u16> {
        levels.into_iter().flat_map(|level| [level as u16; 3]).collect()
    }

    fn scanned(gpu: &'static crate::gpu::Gpu, samples: &[u16], quantile: f64) -> Levels {
        let resident = crate::resident::Resident::upload(gpu, samples, samples.len() / 3, 1);
        pollster::block_on(crate::fit_source::levels(gpu, &resident, quantile))
            .expect("the device read the levels off the frame")
    }

    #[test]
    fn the_peak_is_read_above_diffuse_white() {
        let Some(gpu) = crate::gpu::device() else { return };
        let out = scanned(gpu, &frame((0..3000).map(|i| i * 20)), 0.9);
        assert!(out.peak > out.white, "the peak must sit above diffuse white");
        assert!(out.white > Light::ZERO);
    }

    /// A night frame: nine pixels in ten near black, the rest lit. The quantile lands on the
    /// dark ground and the anchor is held to three stops under the lights instead.
    #[test]
    fn diffuse_white_is_read_no_lower_than_three_stops_under_the_peak() {
        let Some(gpu) = crate::gpu::device() else { return };
        let night = frame((0..10_000).map(|i| if i % 10 == 0 { 40_000 } else { 400 }));
        let out = scanned(gpu, &night, 0.9);
        let lit = Light::<Level>::measured(40_000.0);
        assert_eq!(out.peak, lit);
        assert_eq!(out.white, lit / WHITE_FLOOR_UNDER_PEAK);

        // Where the quantile already sits within reach of the peak the floor does nothing.
        let out = scanned(gpu, &frame((0..10_000).map(|i| i * 4)), 0.9);
        assert!(out.white > out.peak / WHITE_FLOOR_UNDER_PEAK);
        let apart = (out.white - Light::measured(36_000.0)).raw();
        assert!(apart.abs() < 100.0, "the quantile itself, got {:?}", out.white);
    }

    /// The bin count is on both sides - the host sizes the buffer with it, the walk bounds itself
    /// with it - and the generated WGSL cannot be read for the shader's: a `static const` is folded
    /// into its use sites before emission, so only the Slang still says the number.
    #[test]
    fn the_shader_walks_the_bins_the_host_allocates() {
        const SOURCE: &str = include_str!("../../../slang/fit_source.slang");
        let line = format!("static const uint LEVEL_BINS = {LEVEL_BINS};");
        assert!(SOURCE.contains(&line), "slang/fit_source.slang does not say `{line}`");
    }
}
