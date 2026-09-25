//! Light that knows which domain it is a quantity in, and whether it is a quantity or a ratio.
//!
//! **Twelve domains, all of them `f64` until now.** A photograph is read off the sensor as
//! scene-linear counts, assembled as a fraction of full scale, anchored to nits against its own
//! diffuse white, divided into scene-relative units where white is 1, run through the camera's
//! own rendering, normalised again against whatever *that* made of white, taken back to nits at
//! the display, normalised against the display's peak, taken into a gamut and coded for it - and
//! every one of those was a bare `f64`, freely assignable to any other. The failures this module
//! exists for are all the same sentence written with the wrong noun:
//!
//! - The render harness handed the grade `peak_nits` - 1000 - while coding sRGB, where the peak is
//!   diffuse white at 203. Every crop it wrote squeezed five stops of highlight into an 8-bit
//!   container instead of rolling off into white, and came out lifted, flat and desaturated.
//! - `exposure` is stops and `2^EV` is a gain, and `job.rs` carried a guard refusing a
//!   non-positive gain because "a caller sent stops where a multiplier belongs" was reachable.
//! - `covered` averages the taps a canvas pixel spans, and the buffer's codes are not linear in
//!   light. A mean of them is not the mean of anything.
//!
//! None of them is visible in a diff; each is a picture that comes out wrong somewhere a test was
//! not looking.
//!
//! **And a quantity is not a ratio.** An exposure, a saturation, the roll-off's give-back and the
//! camera's own white are all multipliers, and every one of them was an `f64` beside the lights
//! they multiply. [`Light`] and [`Gain`] are the pair: two lights in one domain make a gain, a
//! light and a gain make a light, and a light plus a gain is not anything. [`Stops`] is that gain
//! in the log units the pipeline actually reasons in, so the `exp2` between them is a conversion
//! with a name rather than a habit.
//!
//! **A domain alone does not make two numbers commensurable.** Naming the domain says what a
//! number is a number of; it does not say what one of it *is*:
//!
//! - A domain whose unit a standard fixes is [`Standard`], and a constant of it can be written
//!   down - [`Light::exactly`] takes one. 203 nits is 203 nits on every photograph.
//! - A domain anchored on something measured is not. [`Rendered`] is anchored on what the camera
//!   made of diffuse white, which is a different level on every photograph - two stops apart
//!   across two frames of this repo's fixtures. [`Signal`] is anchored on the *output's* peak,
//!   which is 203 on an SDR target and 1000 on an HDR one, so a constant in it is two brightnesses
//!   depending on which rendition is being written. Neither gets constants; a number enters them
//!   through [`Light::measured`] at the boundary that measured it.
//!
//! Where 1.0 *is* diffuse white the domain is [`WhiteAtOne`], which is what lets the reader's
//! sliders be written once and run over the scene on the neutral arm and over the camera's
//! rendering on the matched one.
//!
//! **Light adds; a code does not.** [`Linear`] is the domains where a weighted sum is the light
//! the samples carry, and it is the only place `+` and a [`Gain`] are defined. A mean of PQ codes
//! or of sRGB is a number with no photographic meaning, which is why the pyramid decodes per tap.
//!
//! Nothing here costs a byte - the markers are uninhabited and the phantom is a function pointer -
//! and nothing becomes a light by accident. A number enters at a boundary that names the domain,
//! and stops being one at [`Light::raw`], which is deliberately ugly to read and easy to grep.

use std::marker::PhantomData;

/// The decode's own scene-linear counts, before the coding: what `fit_scan` reports.
///
/// **Counts, not a fraction of them.** [`Light::COUNT`] is one of them, and `Levels` floors on it.
/// What `assemble.slang` holds on the way to writing one is [`Assembled`].
///
/// **Not [`Standard`], and that is the pipeline's opening argument.** The decode scales sensor
/// saturation to full range whatever the photographer metered, so a level is a fraction of a
/// container rather than a brightness - measured over eight bodies, declaring 1.0 to be a
/// display's peak gave means from 33 to 321 nits for the same subject.
pub enum Level {}

/// `assemble.slang`'s working colour: Rec.2020, scene-linear, as a fraction of full scale.
///
/// A [`Level`] divided by the container it is about to be multiplied back into, which is a
/// different number for the same light - so `within(colour, 1.0)` there means full scale where
/// the grade's means a display's peak.
pub enum Assembled {}

/// Scene-linear nits: a level taken through the photograph's own diffuse white to the reference,
/// so every photograph's white lands at the same number.
pub enum SceneNits {}

/// [`SceneNits`] over the reference, where diffuse white is 1 and middle grey is 0.18.
///
/// What the camera match's curves are fitted over and what their domain (`HdrColour::ceiling`) is
/// named in, and the arm the neutral grade adjusts in.
pub enum Scene {}

/// The camera's own rendering: past its tone curve, its matrix and its chroma lattice.
///
/// **Anchored on nothing a constant can name.** The fit's target is the body's own JPEG, so
/// diffuse white comes out wherever that body put it - the match measures it per frame, and across
/// two fixtures of this repo it is two stops apart.
pub enum Rendered {}

/// [`Rendered`] over that measured white, where diffuse white is 1 again.
///
/// The matched arm's half of [`WhiteAtOne`]: the reader's sliders are placed against 1.0, so
/// running them here rather than in [`Rendered`] is what makes one set of controls mean one thing
/// whether or not the fit landed.
pub enum Graded {}

/// Absolute nits at the display, past the roll-off and bounded by the target's peak.
pub enum DisplayNits {}

pub enum Illuminance {}

/// [`DisplayNits`] over that peak, in 0..1, still Rec.2020 and still linear.
///
/// **Not [`Standard`]: this is where SDR and HDR part.** `job::peak_nits` gives an sRGB target its
/// peak at diffuse white and a PQ target the mastering peak, so 1.0 here is 203 nits or 1000
/// depending on which rendition is being written.
pub enum Signal {}

/// [`Signal`] through `R2020_TO_SRGB`: sRGB primaries, still linear, still at the target's peak.
pub enum SrgbLinear {}

/// [`DisplayNits`] through `R2020_TO_P3` over the browser's 203, which is what a canvas takes.
pub enum P3Linear {}

/// ST 2084 over [`DisplayNits`], in 0..1. Absolute, which is the whole of what PQ is for.
pub enum Pq {}

/// The sRGB transfer over [`SrgbLinear`], in 0..1: what an SDR rendition holds.
pub enum Srgb {}

/// A domain where a weighted sum of samples is the light they carry.
///
/// The coded domains are not: averaging PQ or sRGB gives a number no photograph has, which is why
/// `frame.slang`'s pyramid decodes each tap before it weighs it.
pub trait Linear {}
impl Linear for Level {}
impl Linear for Assembled {}
impl Linear for SceneNits {}
impl Linear for Scene {}
impl Linear for Rendered {}
impl Linear for Graded {}
impl Linear for DisplayNits {}
impl Linear for Illuminance {}
impl Linear for Signal {}
impl Linear for SrgbLinear {}
impl Linear for P3Linear {}

/// A domain whose unit a standard fixes, so a constant in it means one thing on every photograph
/// and at every output.
///
/// [`Level`], [`Rendered`] and [`Signal`] are anchored on something measured - the shot's
/// exposure, the body's rendering, the rendition's peak - and [`SrgbLinear`] and [`Srgb`] inherit
/// `Signal`'s. A number written into one of them is a different brightness every time it is read,
/// so they get no constants: a number reaches them through [`Light::measured`], at the boundary
/// that measured it.
pub trait Standard {}
impl Standard for Assembled {}
impl Standard for SceneNits {}
impl Standard for Scene {}
impl Standard for Graded {}
impl Standard for DisplayNits {}
impl Standard for Illuminance {}
impl Standard for P3Linear {}
impl Standard for Pq {}

/// A domain where 1.0 is diffuse white.
///
/// **What lets the reader's sliders be written once.** The tone zones are placed in stops under
/// white and the contrast turns about middle grey, so both arms of the grade normalise into one of
/// these before `adjust.slang` runs - the neutral arm into [`Scene`] and the matched arm into
/// [`Graded`]. Middle grey is not the same number in the two, which is why the pivot is passed in
/// rather than assumed.
pub trait WhiteAtOne: Standard + Linear {}
impl WhiteAtOne for Scene {}
impl WhiteAtOne for Graded {}

/// A domain measured in absolute nits, which is the only thing ST 2084 codes.
///
/// **Two of them, and [`crate::tone::pq_inv`] cannot tell which it is handing back.** The curve is
/// absolute, so what comes out of it is real nits either way - but whether those are the scene's,
/// as `decode.slang`'s table means them, or the display's, as the roll-off means them, is the
/// caller's to name. So it names one, and the compiler holds it to that afterwards.
pub trait Nits: Linear + Standard {}
impl Nits for SceneNits {}
impl Nits for DisplayNits {}

/// A quantity of light, in the units of `D`.
pub struct Light<D>(f64, PhantomData<fn() -> D>);

/// A ratio of two lights in one domain: an exposure, a saturation, what a roll-off gave back.
///
/// Belonging to no domain, because it left with the units: multiplying a light by one is the one
/// operation that can cross a whole stage and still be the same picture.
#[derive(Clone, Copy, PartialEq, PartialOrd, Debug, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct Gain(f64);

/// A [`Gain`] in log units, which is where the pipeline reasons about light.
///
/// The photographer's exposure, the tone zones' reach, how far a neighbourhood may move a pixel:
/// all of them are added rather than multiplied, and all of them were `f64` beside the gains they
/// become. [`Gain::of`] and [`Stops`]'s own [`Stops::of`] are the `exp2` and the `log2` with a
/// name on them.
#[derive(
    Clone, Copy, PartialEq, PartialOrd, Debug, Default, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct Stops(f64);

pub const CURVE_TOP: Stops = Stops::exactly(3.0);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CurveCode(f64);

impl CurveCode {
    pub fn from_raw(code: f64) -> Self {
        Self(code)
    }

    pub fn of_white_ratio(ratio: f64) -> Self {
        Self(ratio.max(0.0).cbrt() / CURVE_TOP.raw().exp2().cbrt())
    }

    pub fn white_ratio(self) -> f64 {
        (self.0 * CURVE_TOP.raw().exp2().cbrt()).powi(3)
    }

    pub fn raw(self) -> f64 {
        self.0
    }
}

/// 2 to 16 finite points inside the unit square, rising in x and never falling in y.
pub fn curve_is_valid(points: &[[f64; 2]]) -> bool {
    (2..=16).contains(&points.len())
        && points.iter().all(|p| p.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)))
        && points.windows(2).all(|p| p[0][0] < p[1][0] && p[0][1] <= p[1][1])
}

pub fn curve_tangents(points: &[[f64; 2]]) -> Vec<f64> {
    let secants: Vec<f64> = points
        .windows(2)
        .map(|p| (p[1][1] - p[0][1]) / (p[1][0] - p[0][0]))
        .collect();
    let mut tangents = vec![0.0; points.len()];
    tangents[0] = secants[0];
    tangents[points.len() - 1] = secants[secants.len() - 1];
    for i in 1..points.len() - 1 {
        let before = secants[i - 1];
        let after = secants[i];
        if before * after <= 0.0 {
            continue;
        }
        let left = points[i][0] - points[i - 1][0];
        let right = points[i + 1][0] - points[i][0];
        let w1 = 2.0 * right + left;
        let w2 = right + 2.0 * left;
        tangents[i] = (w1 + w2) / (w1 / before + w2 / after);
    }
    tangents
}

pub fn curve_at(points: &[[f64; 2]], tangents: &[f64], x: f64) -> f64 {
    if x <= points[0][0] {
        return points[0][1];
    }
    let last = points.len() - 1;
    if x >= points[last][0] {
        return points[last][1] + (x - points[last][0]) * tangents[last];
    }
    let i = points.partition_point(|point| point[0] < x) - 1;
    let width = points[i + 1][0] - points[i][0];
    let t = (x - points[i][0]) / width;
    let a = (2.0 * t.powi(3) - 3.0 * t.powi(2) + 1.0) * points[i][1];
    let b = (t.powi(3) - 2.0 * t.powi(2) + t) * width * tangents[i];
    let c = (-2.0 * t.powi(3) + 3.0 * t.powi(2)) * points[i + 1][1];
    let d = (t.powi(3) - t.powi(2)) * width * tangents[i + 1];
    a + b + c + d
}

impl Gain {
    pub const ONE: Gain = Gain(1.0);

    pub const fn of_ratio(ratio: f64) -> Gain {
        Gain(ratio)
    }

    /// `2^stops`, stated once here rather than by each host for itself.
    pub fn of(stops: Stops) -> Gain {
        Gain(stops.0.exp2())
    }

    pub const fn raw(self) -> f64 {
        self.0
    }
}

impl std::ops::Mul for Gain {
    type Output = Gain;
    fn mul(self, and: Gain) -> Gain {
        Gain(self.0 * and.0)
    }
}

impl Stops {
    pub const ZERO: Stops = Stops(0.0);

    pub const fn exactly(stops: f64) -> Stops {
        Stops(stops)
    }

    /// The stops a document or a reader named. See [`Light::measured`].
    pub const fn measured(stops: f64) -> Stops {
        Stops(stops)
    }

    /// `log2`, floored where a caller has a black to keep out of it.
    pub fn of(gain: Gain) -> Stops {
        Stops(gain.0.log2())
    }

    pub const fn raw(self) -> f64 {
        self.0
    }

    /// How far this is from no change at all, which is what a gate on a *disagreement* wants: a
    /// frame half a stop under the consensus disagrees with it exactly as much as one half a stop
    /// over.
    pub fn magnitude(self) -> Stops {
        Stops(self.0.abs())
    }

    /// The nearer and the further of two, in stops. Named rather than reached through `raw`, so a
    /// gate cannot be capped by a number that was never a ratio of lights.
    pub fn min(self, other: Stops) -> Stops {
        Stops(self.0.min(other.0))
    }

    pub fn max(self, other: Stops) -> Stops {
        Stops(self.0.max(other.0))
    }
}

impl std::ops::Add for Stops {
    type Output = Stops;
    fn add(self, and: Stops) -> Stops {
        Stops(self.0 + and.0)
    }
}

impl std::ops::Sub for Stops {
    type Output = Stops;
    fn sub(self, less: Stops) -> Stops {
        Stops(self.0 - less.0)
    }
}

impl std::ops::Neg for Stops {
    type Output = Stops;
    fn neg(self) -> Stops {
        Stops(-self.0)
    }
}

impl<D: Standard> Light<D> {
    /// A number entering a domain a standard fixes the unit of.
    ///
    /// Only there. Elsewhere a number is not a light until something has measured it, and this is
    /// the compile error that says so.
    pub const fn exactly(value: f64) -> Self {
        Light(value, PhantomData)
    }
}

impl<D> Light<D> {
    pub const ZERO: Light<D> = Light(0.0, PhantomData);

    /// A frame, a display or a document that exists, measured.
    ///
    /// **Rare and greppable, as [`Light::raw`] is.** It belongs where a quantile is taken, where a
    /// panel reports its peak, or where a request arrives across the API - and nowhere else,
    /// because everything downstream can be derived. A second one in the same function is two
    /// anchors being described, which is the mistake this module exists to make visible.
    pub const fn measured(value: f64) -> Self {
        Light(value, PhantomData)
    }

    /// The number again, for a uniform, an FFI or a table index.
    ///
    /// Named to be greppable: every call is a place where the type stops helping.
    pub const fn raw(self) -> f64 {
        self.0
    }

    pub fn is_finite(self) -> bool {
        self.0.is_finite()
    }

    pub fn min(self, other: Self) -> Self {
        Light(self.0.min(other.0), PhantomData)
    }

    pub fn max(self, other: Self) -> Self {
        Light(self.0.max(other.0), PhantomData)
    }

    pub fn clamp(self, low: Self, high: Self) -> Self {
        Light(self.0.clamp(low.0, high.0), PhantomData)
    }
}

// Written out rather than derived: `derive` would bound every impl on `D`, and the markers are
// uninhabited on purpose so that nothing can hold one.
impl<D> Clone for Light<D> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<D> Copy for Light<D> {}
impl<D> PartialEq for Light<D> {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}
impl<D> PartialOrd for Light<D> {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.0.partial_cmp(&other.0)
    }
}
impl<D> Default for Light<D> {
    fn default() -> Self {
        Light(0.0, PhantomData)
    }
}
impl<D> std::fmt::Debug for Light<D> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "{}", self.0)
    }
}

/// Transparently the number, so a document and an API request read and write what they always did.
impl<D> serde::Serialize for Light<D> {
    fn serialize<S: serde::Serializer>(&self, into: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(into)
    }
}

/// The boundary [`Light::measured`] describes, reached from a client rather than from arithmetic.
impl<'de, D> serde::Deserialize<'de> for Light<D> {
    fn deserialize<De: serde::Deserializer<'de>>(from: De) -> Result<Self, De::Error> {
        f64::deserialize(from).map(Light::measured)
    }
}

impl<D: Linear> std::ops::Add for Light<D> {
    type Output = Light<D>;
    fn add(self, and: Light<D>) -> Light<D> {
        Light(self.0 + and.0, PhantomData)
    }
}

impl<D: Linear> std::ops::Sub for Light<D> {
    type Output = Light<D>;
    fn sub(self, less: Light<D>) -> Light<D> {
        Light(self.0 - less.0, PhantomData)
    }
}

impl<D: Linear> std::ops::Mul<Gain> for Light<D> {
    type Output = Light<D>;
    fn mul(self, by: Gain) -> Light<D> {
        Light(self.0 * by.0, PhantomData)
    }
}

impl<D: Linear> std::ops::Div<Gain> for Light<D> {
    type Output = Light<D>;
    fn div(self, by: Gain) -> Light<D> {
        Light(self.0 / by.0, PhantomData)
    }
}

/// Two lights in one domain make a ratio, which is the only way out of a domain that keeps its
/// meaning.
impl<D: Linear> std::ops::Div for Light<D> {
    type Output = Gain;
    fn div(self, by: Light<D>) -> Gain {
        Gain(self.0 / by.0)
    }
}

impl Light<Level> {
    /// One count, which is the container's own floor rather than a brightness.
    ///
    /// The one constant this domain has, and it is here rather than at its callers because a
    /// number written into [`Level`] is otherwise exactly what `exactly` refuses.
    pub const COUNT: Light<Level> = Light(1.0, PhantomData);
}

impl Light<DisplayNits> {
    /// Where a rendition's highlights roll into, given what its transfer can hold.
    ///
    /// **The one crossing between the scene's anchor and the display's, and it is deliberate.** An
    /// SDR target is the same grade with its peak at diffuse white, so everything above rolls into
    /// white through BT.2390 rather than clipping there - which is a claim about the container and
    /// not a unit conversion, so it is spelled rather than implied.
    pub fn at_diffuse_white(reference: Light<SceneNits>) -> Self {
        Light::measured(reference.raw())
    }

    /// Whether this is a scene peak to roll against rather than one to measure again.
    ///
    /// The floor `peak.slang` writes, in one place because three callers take it: a peak of zero
    /// puts the roll-off in a division by it, and every pixel in the frame clamped to nothing.
    pub fn is_a_peak(self) -> bool {
        self.is_finite() && self >= Light::exactly(1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Serialize, serde::Deserialize)]
    struct CurveCase {
        name: String,
        points: Vec<[f64; 2]>,
        tangents: Vec<f64>,
        samples: Vec<[f64; 2]>,
    }

    #[test]
    fn tone_curve_table_matches_the_editor() {
        let examples = [
            ("identity", vec![[0.0, 0.0], [1.0, 1.0]]),
            ("s-curve", vec![[0.0, 0.0], [0.2, 0.1], [0.5, 0.5], [0.8, 0.9], [1.0, 1.0]]),
            ("crushed black", vec![[0.1, 0.0], [0.35, 0.25], [1.0, 1.0]]),
            ("lifted black and pulled white", vec![[0.0, 0.08], [0.3, 0.38], [0.7, 0.72], [1.0, 0.9]]),
            ("flat segment", vec![[0.0, 0.0], [0.25, 0.2], [0.5, 0.2], [0.75, 0.65], [1.0, 1.0]]),
            (
                "Sony DSC06597 camera",
                vec![
                    [0.0, 0.0899774882813756],
                    [0.14249426855959219, 0.0899774882813756],
                    [0.2329343261724477, 0.20955503567478162],
                    [0.42051370492503687, 0.4476790758148771],
                    [0.5411004484088442, 0.5396001907623454],
                    [1.0, 0.9987467523543998],
                ],
            ),
        ];
        let axes = std::iter::once(-0.1)
            .chain((0..=32).map(|step| step as f64 / 32.0))
            .chain(std::iter::once(1.1));
        let axes: Vec<f64> = axes.collect();
        let built: Vec<CurveCase> = examples
            .into_iter()
            .map(|(name, points)| {
                let tangents = curve_tangents(&points);
                let samples = axes.iter().map(|&x| [x, curve_at(&points, &tangents, x)]).collect();
                CurveCase { name: name.to_string(), points, tangents, samples }
            })
            .collect();
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/tables/tone-curve.json");
        if std::env::var("BOWERBIRD_WRITE_FIXTURES").is_ok_and(|value| value == "1") {
            std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&built).unwrap()))
                .expect("tone curve table writes");
            return;
        }
        let stored: Vec<CurveCase> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored.len(), built.len());
        for (actual, expected) in stored.iter().zip(&built) {
            assert_eq!(actual.name, expected.name);
            assert_eq!(actual.points.len(), expected.points.len());
            assert_eq!(actual.tangents.len(), expected.tangents.len());
            assert_eq!(actual.samples.len(), expected.samples.len());
            for (left, right) in actual.points.iter().zip(&expected.points) {
                assert!(left.iter().zip(right).all(|(a, b)| (a - b).abs() <= 1e-9), "{} points", actual.name);
            }
            for (left, right) in actual.tangents.iter().zip(&expected.tangents) {
                assert!((left - right).abs() <= 1e-9, "{} tangents", actual.name);
            }
            for (left, right) in actual.samples.iter().zip(&expected.samples) {
                assert!(left.iter().zip(right).all(|(a, b)| (a - b).abs() <= 1e-9), "{} samples", actual.name);
            }
        }
    }

    #[test]
    fn curve_code_and_monotone_tangents_match_the_shader_contract() {
        assert!(include_str!("../../../slang/light.slang")
            .contains("public static const Stops CURVE_TOP = { 3.0 };"));
        assert_eq!(CURVE_TOP, Stops::exactly(3.0));
        assert_eq!(CurveCode::of_white_ratio(1.0).raw(), 0.5);
        assert_eq!(CurveCode::of_white_ratio(8.0).raw(), 1.0);
        assert_eq!(CurveCode::from_raw(1.0).white_ratio(), 8.0);
        let points = [[0.0, 0.1], [0.3, 0.1], [0.6, 0.8], [1.0, 1.0]];
        let tangents = curve_tangents(&points);
        assert_eq!(tangents[1], 0.0);
        let values: Vec<f64> =
            (0..=100).map(|i| curve_at(&points, &tangents, i as f64 / 100.0)).collect();
        assert!(values.windows(2).all(|pair| pair[0] <= pair[1] + 1e-12));
        assert_eq!(curve_at(&points, &tangents, -1.0), 0.1);
        assert!(curve_at(&points, &tangents, 1.2) > 1.0);
    }

    /// The algebra a bare `f64` had nothing to say about.
    #[test]
    fn lights_and_gains_compose_the_way_an_exposure_does() {
        let white: Light<SceneNits> = Light::exactly(203.0);
        let peak: Light<SceneNits> = Light::measured(812.0);

        assert_eq!(peak / white, Gain::of_ratio(4.0), "two lights are a ratio");
        assert_eq!(
            white * Gain::of(Stops::exactly(2.0)),
            peak,
            "a light and a ratio are a light"
        );
        assert_eq!(
            Stops::of(peak / white),
            Stops::exactly(2.0),
            "and a ratio is a number of stops"
        );
    }

    /// The conversion each host was making for itself, in one place with a name.
    #[test]
    fn stops_and_gains_are_one_conversion_apart() {
        assert_eq!(Gain::of(Stops::ZERO), Gain::ONE);
        assert_eq!(Gain::of(Stops::exactly(-1.0)).raw(), 0.5);
        assert_eq!(
            Stops::exactly(1.5) + Stops::exactly(0.5),
            Stops::exactly(2.0)
        );
    }

    /// A level is a fraction of the sensor's container; the anchor is what makes it a brightness.
    ///
    /// `base::coding_curve`'s arithmetic, held against what the two domains claim: whatever the
    /// frame metered, its own diffuse white codes at the reference and a stop over it at twice.
    #[test]
    fn anchoring_puts_every_photographs_white_at_the_reference() {
        let reference = Light::<SceneNits>::exactly(203.0);
        let anchoring = |level: f64, white: f64| {
            reference * (Light::<Level>::measured(level) / Light::measured(white))
        };
        for white in [4000.0, 36_000.0] {
            assert_eq!(
                anchoring(white, white),
                reference,
                "white anchors at the reference"
            );
        }
        assert_eq!(
            Stops::of(anchoring(8000.0, 4000.0) / reference),
            Stops::exactly(1.0)
        );
    }

    /// An SDR rendition rolls into diffuse white, and that crossing has to be spelled.
    #[test]
    fn an_sdr_target_takes_its_peak_from_the_reference() {
        let reference = Light::<SceneNits>::exactly(203.0);
        assert_eq!(
            Light::<DisplayNits>::at_diffuse_white(reference),
            Light::exactly(203.0),
            "the harness that passed 1000 here wrote five stops into eight bits",
        );
    }

    /// **The whole point, and it cannot be written as a test.**
    ///
    /// Every line below is a compile error, which is why they are in a comment rather than in the
    /// body: there is no way to assert that something does not build from inside the thing that
    /// would not build. `trybuild` would say it, at the cost of a dependency and a second corpus
    /// of fixture files for a rule the type system already refuses to break.
    ///
    /// ```ignore
    /// let nits: Light<SceneNits> = Light::exactly(203.0);
    /// let display: Light<DisplayNits> = Light::exactly(1000.0);
    /// let _ = nits + display;                     // two domains
    /// let _: Light<DisplayNits> = nits;           // two domains
    /// let _ = nits * nits;                        // two lights are not a light
    /// let _ = nits + Gain::ONE;                   // a light and a ratio are not a sum
    /// let _: Light<Level> = Light::exactly(4000.0);   // a level is not a brightness
    /// let _: Light<Signal> = Light::exactly(1.0);     // 1.0 is 203 nits or 1000
    /// let _: Light<Rendered> = Light::exactly(1.0);   // the camera put white somewhere else
    /// let _ = Light::<Pq>::exactly(0.5) + Light::<Pq>::exactly(0.25);  // a code is not a light
    /// ```
    #[test]
    fn the_domains_do_not_mix() {
        // What the doc above cannot: that the two are distinct types holding the same number, so
        // nothing about the representation is what keeps them apart.
        let nits: Light<SceneNits> = Light::exactly(203.0);
        let display: Light<DisplayNits> = Light::exactly(203.0);
        assert_eq!(nits.raw(), display.raw());
        assert_eq!(
            std::mem::size_of::<Light<SceneNits>>(),
            std::mem::size_of::<f64>()
        );
        assert_eq!(std::mem::size_of::<Light<Pq>>(), std::mem::size_of::<f64>());
    }
}
