//! A DNG's own default rendering, as dng_sdk's `dng_render` draws it: the camera match's colour for
//! a DNG with no embedded JPEG to fit one against.

use colour::matched::{BINS, HdrColour, TRUST_CEILING};
use rawler::tags::DngTag;
use units::light::{Light, Stops};

/// What a DNG states about drawing itself.
#[derive(Clone, Debug, PartialEq)]
pub struct Stated {
    exposure: Stops,
    shadows: bool,
    curve: Curve,
}

#[derive(Clone, Debug, PartialEq)]
enum Curve {
    Acr3,
    Profile {
        points: Vec<[f64; 2]>,
        slopes: Vec<f64>,
    },
    /// An output-referred file with no profile curve.
    Identity,
}

/// `dng_render`'s Shadows of 5 against its scale of a thousandth.
const DEFAULT_BLACK: f64 = 0.005;
const BLACK_RENDER_NONE: f32 = 1.0;

impl Stated {
    /// None for anything but a DNG.
    pub fn of_source(source: &rawler::rawsource::RawSource) -> Option<Stated> {
        Stated::of(rawler::get_decoder(source).ok()?.as_ref())
    }

    fn of(decoder: &dyn rawler::decoders::Decoder) -> Option<Stated> {
        if decoder.format_hint() != rawler::decoders::FormatHint::DNG {
            return None;
        }
        let root = decoder
            .ifd(rawler::decoders::WellKnownIFD::Root)
            .ok()
            .flatten()?;
        let entry = |tag: DngTag| root.get_entry(tag).filter(|entry| entry.count() > 0);
        let first = |tag: DngTag| entry(tag).map(|entry| entry.force_f32(0));
        let exposure = f64::from(first(DngTag::BaselineExposure).unwrap_or(0.0))
            + f64::from(first(DngTag::BaselineExposureOffset).unwrap_or(0.0));
        let scene_referred = first(DngTag::ColorimetricReference).is_none_or(|kind| kind == 0.0);
        let profile = entry(DngTag::ProfileToneCurve)
            .map(|entry| {
                (0..entry.count() as usize / 2)
                    .map(|at| {
                        [
                            f64::from(entry.force_f32(at * 2)),
                            f64::from(entry.force_f32(at * 2 + 1)),
                        ]
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|points| {
                points.len() >= 2 && points.windows(2).all(|pair| pair[0][0] < pair[1][0])
            });
        Some(Stated {
            exposure: Stops::measured(exposure),
            shadows: scene_referred && first(DngTag::DefaultBlackRender) != Some(BLACK_RENDER_NONE),
            curve: match (profile, scene_referred) {
                (Some(points), _) => Curve::Profile {
                    slopes: spline_slopes(&points),
                    points,
                },
                (None, true) => Curve::Acr3,
                (None, false) => Curve::Identity,
            },
        })
    }

    /// The camera match's colour over a frame anchored at `levels` whose neutral clips at
    /// `neutral_ceiling` of full scale.
    pub async fn colour(
        &self,
        gpu: &'static gpu::Gpu,
        levels: &colour::tone::Levels,
        neutral_ceiling: f32,
    ) -> Option<HdrColour> {
        let clip = Light::measured(f64::from(neutral_ceiling) * colour::transfer::FULL_SCALE);
        let share = (levels.white / clip).raw();
        if !(share.is_finite() && share > 0.0) {
            return None;
        }
        let response: Vec<f64> = (0..BINS)
            .map(|bin| self.response(bin as f64 / (BINS - 1) as f64 * TRUST_CEILING * share))
            .collect();
        let mut colour = HdrColour {
            anchor: colour::matched::chroma_anchor(&response, TRUST_CEILING),
            curves: [response.clone(), response.clone(), response],
            chroma: Some(colour::lattice::ChromaMap::identity().stored()),
            stated: true,
            ..HdrColour::identity()
        };
        let (exposure, curve, _) = crate::hdr_fit::camera_curve(gpu, &colour).await?;
        colour.exposure = exposure;
        colour.curve = curve;
        Some(colour)
    }

    /// What the display shows for a neutral at `x` of the sensor's clip: linear, 1 at its white.
    fn response(&self, x: f64) -> f64 {
        let exposure = self.exposure.raw();
        let white = (-exposure.max(0.0)).exp2();
        let black = match self.shadows {
            true => DEFAULT_BLACK.min(0.99 * white),
            false => 0.0,
        };
        let toned = exposure_tone(ramp(x, white, black), exposure).clamp(0.0, 1.0);
        match &self.curve {
            Curve::Acr3 => acr3(toned),
            Curve::Profile { points, slopes } => spline_at(points, slopes, toned),
            Curve::Identity => toned,
        }
    }
}

/// `dng_function_exposure_ramp` with its toe as wide as `dng_render` asks for.
fn ramp(x: f64, white: f64, black: f64) -> f64 {
    let slope = 1.0 / (white - black);
    let radius = (0.5 * black).min(1.0 / 16.0 / slope);
    if x <= black - radius {
        return 0.0;
    }
    if x >= black + radius {
        return ((x - black) * slope).min(1.0);
    }
    let y = x - (black - radius);
    slope / (4.0 * radius) * y * y
}

/// `dng_function_exposure_tone`: a negative exposure darkens all but the top two stops, and
/// still takes white to white.
fn exposure_tone(x: f64, exposure: f64) -> f64 {
    if exposure >= 0.0 {
        return x;
    }
    let slope = exposure.exp2();
    let a = 16.0 / 9.0 * (1.0 - slope);
    let b = slope - 0.5 * a;
    let c = 1.0 - a - b;
    match x <= 0.25 {
        true => x * slope,
        false => (a * x + b) * x + c,
    }
}

fn acr3(x: f64) -> f64 {
    let table = &crate::acr3::ACR3;
    let y = x * (table.len() - 1) as f64;
    let index = (y as usize).min(table.len() - 2);
    let fract = y - index as f64;
    f64::from(table[index]) * (1.0 - fract) + f64::from(table[index + 1]) * fract
}

/// `dng_spline_solver::Solve`: C2 through every point, its second derivative zero at both ends.
fn spline_slopes(points: &[[f64; 2]]) -> Vec<f64> {
    let count = points.len();
    let (x, y) = (|j: usize| points[j][0], |j: usize| points[j][1]);
    let mut slopes = vec![0.0; count];
    let mut a = x(1) - x(0);
    let mut b = (y(1) - y(0)) / a;
    slopes[0] = b;
    for j in 2..count {
        let c = x(j) - x(j - 1);
        let d = (y(j) - y(j - 1)) / c;
        slopes[j - 1] = (b * c + d * a) / (a + c);
        a = c;
        b = d;
    }
    slopes[count - 1] = 2.0 * b - slopes[count - 2];
    slopes[0] = 2.0 * slopes[0] - slopes[1];
    if count == 2 {
        return slopes;
    }
    let (mut e, mut f, mut g) = (vec![0.0; count], vec![0.0; count], vec![0.0; count]);
    f[0] = 0.5;
    e[count - 1] = 0.5;
    g[0] = 0.75 * (slopes[0] + slopes[1]);
    g[count - 1] = 0.75 * (slopes[count - 2] + slopes[count - 1]);
    for j in 1..count - 1 {
        let span = (x(j + 1) - x(j - 1)) * 2.0;
        e[j] = (x(j + 1) - x(j)) / span;
        f[j] = (x(j) - x(j - 1)) / span;
        g[j] = 1.5 * slopes[j];
    }
    for j in 1..count {
        let pivot = 1.0 - f[j - 1] * e[j];
        if j != count - 1 {
            f[j] /= pivot;
        }
        g[j] = (g[j] - g[j - 1] * e[j]) / pivot;
    }
    for j in (0..count - 1).rev() {
        g[j] -= f[j] * g[j + 1];
    }
    g
}

/// `dng_spline_solver::Evaluate`: held at the end points, a cubic Hermite segment between them.
fn spline_at(points: &[[f64; 2]], slopes: &[f64], x: f64) -> f64 {
    let last = points.len() - 1;
    if x <= points[0][0] {
        return points[0][1];
    }
    if x >= points[last][0] {
        return points[last][1];
    }
    let j = points.partition_point(|point| point[0] < x).max(1);
    let ([x0, y0], [x1, y1]) = (points[j - 1], points[j]);
    let span = x1 - x0;
    let t = (x - x0) / span;
    let u = 1.0 - t;
    (y0 * (1.0 + 2.0 * t) + slopes[j - 1] * span * t) * u * u
        + (y1 * (3.0 - 2.0 * t) - slopes[j] * span * u) * t * t
}

#[cfg(test)]
mod tests {
    use super::{Curve, Stated};
    use units::light::Stops;

    fn stated(exposure: f64, curve: Curve) -> Stated {
        Stated {
            exposure: Stops::measured(exposure),
            shadows: true,
            curve,
        }
    }

    /// dng_sdk's own figures: black under its 0.005 Shadows, the table's sample at a quarter of the
    /// clip, and white at the clip.
    #[test]
    fn the_default_rendering_is_dng_sdks() {
        let acr3 = stated(0.0, Curve::Acr3);
        assert_eq!(acr3.response(0.002), 0.0);
        assert_eq!(acr3.response(1.0), 1.0);
        let quarter = 0.25 * (1.0 - 0.005) + 0.005;
        assert!((acr3.response(quarter) - f64::from(crate::acr3::ACR3[256])).abs() < 1e-6);
    }

    /// A stop of BaselineExposure renders half the clip at white, and a stop under keeps white
    /// where it was while darkening the middle by a stop.
    #[test]
    fn baseline_exposure_moves_the_ramp() {
        let identity = |exposure| stated(exposure, Curve::Identity);
        assert!((identity(1.0).response(0.5) - 1.0).abs() < 1e-9);
        assert!((identity(-1.0).response(1.0) - 1.0).abs() < 1e-9);
        let middle = identity(0.0).response(0.2);
        assert!((identity(-1.0).response(0.2) - middle / 2.0).abs() < 1e-9);
    }

    /// A frame whose white sits two stops under its neutral clip, drawn a stop up, rests a stop
    /// under the quantile's white.
    #[test]
    fn the_camera_exposure_is_the_clip_less_the_baseline() {
        let Some(gpu) = gpu::device() else {
            return;
        };
        let neutral_ceiling = 0.5;
        let white = 0.25 * neutral_ceiling as f64 * colour::transfer::FULL_SCALE;
        let levels = colour::tone::Levels {
            white: units::light::Light::measured(white),
            peak: units::light::Light::measured(white * 4.0),
            floor: Some(units::light::Light::measured(0.0)),
        };
        let mut drawn = stated(1.0, Curve::Identity);
        drawn.shadows = false;
        let colour =
            pollster::block_on(drawn.colour(gpu, &levels, neutral_ceiling)).expect("a colour");
        assert!(colour.stated);
        assert!(
            (colour.exposure.raw() + 1.0).abs() < 0.011,
            "{:?}",
            colour.exposure
        );
    }

    /// What `dng_spline_solver` promises: through its own points, C2 at every one inside, a second
    /// derivative of zero at both ends, and the straight line a two-point curve is.
    #[test]
    fn a_profile_curve_is_dng_sdks_spline() {
        let points = vec![[0.0, 0.0], [0.25, 0.4], [0.6, 0.8], [1.0, 1.0]];
        let slopes = super::spline_slopes(&points);
        let at = |x: f64| super::spline_at(&points, &slopes, x);
        for [x, y] in &points {
            assert!((at(*x) - y).abs() < 1e-12);
        }
        let h = 1e-4;
        let bend_after = |x: f64| (at(x) - 2.0 * at(x + h) + at(x + 2.0 * h)) / (h * h);
        let bend_before = |x: f64| (at(x) - 2.0 * at(x - h) + at(x - 2.0 * h)) / (h * h);
        assert!(bend_after(0.0).abs() < 1e-2, "{}", bend_after(0.0));
        assert!(bend_before(1.0).abs() < 1e-2, "{}", bend_before(1.0));
        for x in [0.25, 0.6] {
            assert!(
                (bend_after(x) - bend_before(x)).abs() < 1e-2,
                "at {x}: {} against {}",
                bend_before(x),
                bend_after(x)
            );
        }
        assert!(
            bend_after(0.25).abs() > 0.1,
            "a straight line would pass the rest"
        );
        let straight = vec![[0.0, 0.0], [1.0, 1.0]];
        let slopes = super::spline_slopes(&straight);
        assert!((super::spline_at(&straight, &slopes, 0.3) - 0.3).abs() < 1e-12);
    }
}
