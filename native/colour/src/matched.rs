//! The camera match's colour model: what the fit produces and the grade reads.

use crate::lattice::ChromaMap;
use crate::space::IDENTITY;

/// Long edge of the grid the fit runs on. Fitting small and applying at full resolution is
/// free, and a 60MP fit is minutes of work for the same answer.
///
/// Half the 1616px preview Sony embeds, which is what every match fits against where a body
/// offers it (`decode_rawler::Preview::for_the_match`); a body that offers only its full JPEG
/// is box-averaged to the same grid in linear light by `hdr_fit::fitted_preview_size`, so the
/// grade's supervision footprint (`grade::mean_block`) is one number for every body. Measured on
/// the Canon fixture against fitting its 6000px JPEG at 1280: the fit halves, and against the
/// camera's own crops the render moves by 0.15 to 0.47 of a count in 255.
pub const FIT_LONG_EDGE: usize = 808;

/// The long edge a caller should decode the preview to.
///
/// Twice the fit grid, and the extra is not for the fit - that still runs at
/// `FIT_LONG_EDGE`, where the cost of a geometry search lives. It is for the chroma map,
/// which has to see small saturated objects that the fit grid loses: at 640 a blue pot
/// 20 pixels across has no interior the blur has not reached, and nine pairs in the whole
/// frame look like it. The render side is already built at this size on its way down.
pub fn sample_long_edge() -> usize {
    FIT_LONG_EDGE * 2
}

/// Curve resolution over the fit domain.
///
/// Spaced evenly in scene light, which under-describes the shadows: both sides of this fit are
/// linear, so the stop below diffuse white takes 128 of these and five stops down there are 8.
/// **Measured, respacing them does not help.** On the square root of the level - 19 bins five
/// stops down instead of 8 - the 32-frame library came out at a mean deltaE of 3.063 against
/// 3.059, six frames better and ten worse, and it cost the identity transform its exactness
/// (a quadratic through linearly interpolated bins lands 3e-6 out). What limits the shadows is
/// not how many bins they get but how few pairs land in them: `MIN_BIN_SAMPLES` already drops
/// the sparse ones, so finer spacing buys more empty bins. `pool_violators` is the fix that
/// worked.
pub const BINS: usize = 256;

/// The default top of the fit's domain, as a fraction of diffuse white.
///
/// Not 1.0: the last stop before an 8-bit image clips is the camera compressing
/// highlights into a range it does not have, and a curve fitted through that learns
/// the compression as though it were colour. Cut below it and the shoulder is never
/// seen.
///
/// The default and the floor, not the domain itself - that is `HdrColour::ceiling`, which the
/// selection stretches on frames whose exposure puts camera-visible content above this.
pub const TRUST_CEILING: f64 = 0.9;

/// The frame's own light at arm's length: a small luma plane of the whole photograph,
/// blurred as `neighbourhood_plane` blurs, in the render's scene-linear units.
///
/// This is what the lattice's neighbourhood axis reads at grade time. It travels with the
/// colour because the lattice is unusable without it - a map fitted against a
/// neighbourhood and read against none lands every conditioned correction on the wrong
/// slab - and because a loupe tile cannot compute it: the blur spans the photograph and
/// a tile only holds its window.
#[derive(Clone, PartialEq)]
pub struct NeighbourhoodThumb {
    pub width: usize,
    pub height: usize,
    /// `f16`-quantised at the fit, so a stored match compares equal to a fresh one.
    pub data: Vec<f64>,
}

impl NeighbourhoodThumb {
    /// No thumb, for a colour with no lattice to read one.
    pub fn none() -> NeighbourhoodThumb {
        NeighbourhoodThumb {
            width: 0,
            height: 0,
            data: Vec::new(),
        }
    }
}

/// `PartialEq` because `grade::Uploaded` owns a copy and refuses a grade describing a
/// different one; the fields are plain numbers, so the derive is the whole comparison.
#[derive(Clone, PartialEq)]
pub struct HdrColour {
    /// Per-channel, `BINS` samples spanning render values 0 to `ceiling`.
    pub curves: [Vec<f64>; 3],
    /// The top of the fit's domain, in the render's own anchored units.
    ///
    /// `TRUST_CEILING` unless the frame's exposure put what the camera can still see
    /// above it. The render is anchored on its own white quantile where the camera meters
    /// the subject, so a lit subject in a dark frame lands at 1.5 render units while the
    /// camera renders it unclipped - and a domain ending at 0.9 then censors exactly the
    /// region where the two disagree: the curves cannot learn it, its pairs are gated out
    /// of every chroma stage, and the fitted-versus-held boundary crosses the subject as
    /// a band. Sized by `fit_pairs::Selected::ceiling` so it ends where the camera's data does.
    pub ceiling: f64,
    /// Where `colour.slang`'s `curves_at` reads a highlight's colour, from `chroma_anchor`.
    ///
    /// Derived from the curve wherever a match is built or read back, never stored beside
    /// it: a sidecar carrying both could come back with an anchor its own curve does not
    /// imply, and the frame would render a colour no fit ever chose.
    pub anchor: f64,
    /// Applied after the curves; row-major, output channel by input channel.
    pub matrix: [[f64; 3]; 3],
    /// The uniform part of the whole colour fit (`global_saturation`) and the Saturation slider's
    /// default, on its step. A fitted match always carries a `chroma` map, whose nodes hold the
    /// whole chroma, so this never reaches its render: `finish_chroma` blends by it only without
    /// one.
    pub saturation: f64,
    /// The hue-dependent part, where the frame supported fitting one.
    ///
    /// None is not a failure - it is the model this had before there was a chroma axis,
    /// and a frame with too little colour to fit one is better served by it.
    pub chroma: Option<ChromaMap>,
    /// The neighbourhood the map above reads; empty whenever `chroma` is `None`.
    pub neighbourhood: NeighbourhoodThumb,
    /// The hue-balanced CIEDE2000 the fit scores itself by, on pairs it was not fitted from,
    /// with the cast term of `folded` in it.
    ///
    /// **Still not a measure of whether the render looks right**, and it has been read as one.
    /// It was a bare mean ΔE76 when IMG_8789 reported 2.47 here and rendered its bird bath
    /// and stone wall visibly green; it now carries a distance function that does not discount
    /// near-neutral error, a signed term that a cast cannot hide from, and a holdout that
    /// memorising cannot flatter. What it still cannot see is anything the fit solves rather
    /// than chooses, and it remains one number over a whole frame - so a render is what says
    /// a render is right.
    pub delta_e: f64,
    pub exposure: units::light::Stops,
    pub curve: Vec<[f64; 2]>,
    /// The white balance the camera match sets, in whole steps of both sliders: the illuminant that
    /// pulls the frame's greys onto the camera's, and the one everything above was fitted under.
    /// None where the frame had no illuminant to move from or too few greys to say where to.
    pub illuminant: Option<crate::white_balance::Illuminant>,
    /// A DNG's own default rendering rather than a fit (`dng_rendering`), so the lens beside it
    /// was never measured.
    pub stated: bool,
}

/// The level where the camera's rendering stops expanding chroma and starts compressing
/// it: the highest bin whose log-log slope still reaches one.
///
/// A tone curve steeper than proportional pulls a pixel's channels apart and one
/// flatter pushes them together, so this is the exact level the camera's shoulder
/// begins at - measured 0.40 of the domain on IMG_8584, where the slope runs 1.46 at
/// 0.30 and 0.43 by the ceiling. `colour.slang`'s `curves_at` reads a highlight's colour here.
///
/// The ceiling where no bin expands, which makes the correction a no-op rather than
/// reading a colour off the toe.
pub fn chroma_anchor(curve: &[f64], ceiling: f64) -> f64 {
    // From bin two: the first bin's backward difference is against the curve's own zero, so
    // it reads as exactly proportional whatever the curve does and every search reaches it.
    let expansive = |b: usize| curve[b] > 0.0 && (curve[b] - curve[b - 1]) * b as f64 >= curve[b];
    match (2..BINS).rev().find(|b| expansive(*b)) {
        Some(bin) => ceiling * bin as f64 / (BINS - 1) as f64,
        None => ceiling,
    }
}

impl HdrColour {
    /// A transform that returns its input.
    ///
    /// A fit always produces a real one; this is for the tests and for a caller with no fit
    /// yet, both of which need a known-good transform rather than a fitted one.
    pub fn identity() -> Self {
        let ramp: Vec<f64> = (0..BINS)
            .map(|i| (i as f64 / (BINS - 1) as f64) * TRUST_CEILING)
            .collect();
        HdrColour {
            curves: [ramp.clone(), ramp.clone(), ramp],
            ceiling: TRUST_CEILING,
            anchor: TRUST_CEILING,
            matrix: IDENTITY,
            saturation: 1.0,
            chroma: None,
            neighbourhood: NeighbourhoodThumb::none(),
            delta_e: 0.0,
            exposure: units::light::Stops::ZERO,
            curve: units::light::IDENTITY_CURVE.to_vec(),
            illuminant: None,
            stated: false,
        }
    }

    pub fn saturation_slider(&self) -> f64 {
        saturation_slider(units::light::Gain::of_ratio(self.saturation))
    }
}
/// A chroma gain on the Saturation slider's scale, where 0 leaves chroma alone and -100 is grey, in
/// the whole steps the document stores.
pub fn saturation_slider(gain: units::light::Gain) -> f64 {
    ((gain.raw() - 1.0) * 100.0).round()
}
