// The numbers the render's defringe and sharpen are built on: the deconvolution's spread, the edge
// and noise estimates, and the strengths each stage runs at.

/// The resample's own blur, as a Gaussian sigma in output pixels, and the whole answer
/// where no capture sigma was measured.
///
/// This is **capture sharpening's** question, not creative sharpening's: what spread did
/// the resample, the demosaic and the lens put on a point, and can it be taken back off.
/// A deep downscale to the rendition's size is most of it there; at 1:1 the capture's own
/// spread is all of it, which is what [`deconvolve_split`] interpolates between.
/// RawTherapee's equivalent defaults near this and uses a 5x5 kernel below radius 0.84,
/// which is what the tap count works out to.
pub const DECONVOLVE_SIGMA: f32 = 0.7;

/// What the Detail panel's Sharpening slider asks for at the top of its track.
///
/// The blend is a fraction of the supported recovered estimate, so the middle of the track applies
/// its accepted correction and the top extrapolates to twice that difference, with
/// [`SHARPEN_OVERSHOOT`] holding what it pushes past a neighbourhood's range.
pub const SHARPEN_GAIN: f64 = 2.0;

/// How far past its neighbourhood's range a sharpened pixel may go, as a share of that range;
/// zero is the hard clamp. `sharpen.slang`'s `limited` says what the hard clamp costs.
pub const SHARPEN_OVERSHOOT: f64 = 1.0;

/// The sigma the deconvolution should undo, at the frame it actually runs over.
///
/// `composed` is the whole answer for a flat field; where the lens warp is in the chain its
/// per-pixel Jacobian stretches the `terms` instead, since the capture's blur is uniform in
/// the *source* and a corner the correction stretched carries proportionally wider blur.
/// `terms` is None where nothing was measured, and the fixed default rules alone.
#[derive(Clone, Copy)]
pub struct SharpenSigma {
    pub composed: f32,
    /// `(capture at this scale, the resample's own spread)`, recomposed per pixel by
    /// `sharpen.slang` under the warp's local derivative.
    pub terms: Option<(f32, f32)>,
}

/// Sensor noise carried to the raster and coding capture sharpening reads.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SharpenNoise {
    pub sensitivity: [[f32; 3]; 3],
    pub shot_per_light: [f32; 3],
    pub read_variance: [f32; 3],
    pub reduction: usize,
}

impl SharpenNoise {
    pub const NONE: SharpenNoise = SharpenNoise {
        sensitivity: [[0.0; 3]; 3],
        shot_per_light: [0.0; 3],
        read_variance: [0.0; 3],
        reduction: 1,
    };

    pub fn at(
        self,
        sensor: units::px::Span<units::px::Sensor>,
        drawn: units::px::Span<units::px::Drawn>,
    ) -> SharpenNoise {
        let reduction = self.reduction.max(1);
        let decoded = sensor.raw().div_ceil(reduction).max(1);
        let linear = drawn.raw().min(decoded) as f32 / decoded as f32;
        let area = linear * linear;
        let samples = match reduction {
            2 => [1.0, 2.0, 1.0],
            3 => [1.0, 5.0, 1.0],
            _ => [1.0; 3],
        };
        SharpenNoise {
            shot_per_light: std::array::from_fn(|channel| {
                self.shot_per_light[channel] * area / samples[channel]
            }),
            read_variance: std::array::from_fn(|channel| {
                self.read_variance[channel] * area / samples[channel]
            }),
            ..self
        }
    }
}

impl Default for SharpenNoise {
    fn default() -> Self {
        SharpenNoise::NONE
    }
}

impl SharpenSigma {
    pub fn fixed(composed: f32) -> SharpenSigma {
        SharpenSigma {
            composed,
            terms: None,
        }
    }
}

/// [`SharpenSigma`] from the capture's own measurement, or the fixed default without one.
///
/// The capture's blur is measured on the mosaic in sensor pixels; a downscale by `k`
/// narrows it to `capture / k` and adds the resample kernel's own spread, which is fixed
/// in *output* pixels and vanishes as `k` reaches one. In quadrature, with the resample
/// term scaled by `(k^2 - 1) / k^2` so the composition is exact at both ends:
/// `k = 1` gives the capture sigma alone, a deep downscale gives [`DECONVOLVE_SIGMA`],
/// which is the tuned value this pipeline always sharpened deep downscales with.
///
/// Clamped to the range the 5-tap kernel is honest for; a missing measurement falls back
/// to the fixed sigma, which is yesterday's behaviour exactly.
pub fn deconvolve_split(capture: Option<f32>, sensor_long: usize, out_long: usize) -> SharpenSigma {
    let Some(capture) = capture else {
        return SharpenSigma::fixed(DECONVOLVE_SIGMA);
    };
    let k = (sensor_long.max(1) as f32 / out_long.max(1) as f32).max(1.0);
    let capture_here = capture / k;
    let resample = (DECONVOLVE_SIGMA * DECONVOLVE_SIGMA * (k * k - 1.0)).sqrt() / k;
    SharpenSigma {
        composed: (capture_here * capture_here + resample * resample)
            .sqrt()
            .clamp(0.3, 0.84),
        terms: Some((capture_here, resample)),
    }
}

/// The edge-width histogram's bins and the widest rise one can hold, in pixels. Both are
/// `edge_spread.slang`'s, pinned by a test.
pub const EDGE_SPREAD_BINS: usize = 256;
pub const EDGE_SPREAD_CEIL: f32 = 8.0;

/// How far a rise may climb before it stops being one edge. The shader's, and what decides how
/// much of the frame's border has no room to be measured.
pub const EDGE_SPREAD_RUN: usize = 8;

/// The 10-90 distance of a Gaussian's own edge, in sigmas.
pub const EDGE_SPREAD_PER_SIGMA: f32 = 2.563;

/// What fraction of a frame's edges is taken to be the optics rather than the scene.
///
/// A scene edge can be softer than the point spread and never harder, so the *sharpest* of them
/// are the measurement and everything above is a soft subject. A decile rather than the minimum:
/// the narrowest rise in sixty million belongs to whichever noise spike cleared the guards.
const EDGE_SPREAD_QUANTILE: f64 = 0.1;

/// The capture's blur, off a mapped copy of that histogram, or None where the frame offered too
/// few edges or an answer outside what a lens does.
pub fn edge_spread_sigma(mapped: &[u8]) -> Option<f32> {
    let bins: Vec<u64> = mapped
        .chunks_exact(4)
        .map(|word| u64::from(u32::from_le_bytes([word[0], word[1], word[2], word[3]])))
        .collect();
    let total: u64 = bins.iter().sum();
    // A frame with almost no edges is not a soft frame, it is an unanswered question, and the
    // fixed sigma is the better answer than a decile of noise. Low, though: a whole-frame pass
    // over a 24MP fixture of hillside and haze voted 918 times and read 0.94 against an
    // independent probe's 0.96, so a floor in the thousands would have thrown that away.
    if total < 500 {
        return None;
    }
    let want = ((total as f64 * EDGE_SPREAD_QUANTILE) as u64).max(1);
    let mut seen = 0u64;
    for (bin, count) in bins.iter().enumerate() {
        seen += count;
        if seen >= want {
            let width = (bin as f32 + 0.5) / EDGE_SPREAD_BINS as f32 * EDGE_SPREAD_CEIL;
            let sigma = width / EDGE_SPREAD_PER_SIGMA;
            return (0.2..=2.0).contains(&sigma).then_some(sigma);
        }
    }
    None
}

/// Richardson-Lucy iterations, each two steps (`sharpen_correct` squares its correction).
///
/// **Four dispatches each, so this is most of what the sharpen costs**: 400ms of a 24MP render at
/// ten, against the whole GALOSH denoise's 396ms. Fewer iterations under a larger gain is not the
/// same picture once the estimate is unregularised: the extrapolation then amplifies the whole
/// unconverged difference, grain included, where more iterations recover edges first.
///
/// It is also a halo: [`Strengths::halo`] is `2·RADIUS·this + RADIUS`, so a loupe tile grows its
/// decode window by it - a 400px tile decodes 484 square.
pub const DECONVOLVE_ITERATIONS: usize = 10;

/// Half-width of the point spread, in taps. See `gaussian`.
///
/// **Taps and not pixels**: this is how many samples the stencil reads, and what decides how much
/// picture they span is the sigma, which [`deconvolve_split`] composes per scale and clamps to
/// what five of them are honest for. `sharpen.slang` declares it in the same unit.
pub const DECONVOLVE_TAPS: units::px::Span<units::px::Tap> = units::px::Span::exact(2);

/// The same as a plain count, for the arithmetic that indexes with it.
pub const DECONVOLVE_RADIUS: usize = DECONVOLVE_TAPS.raw();

/// How far a reconstruction's per-channel noise tracks each other channel's, as Pearson
/// coefficients indexed by channel pair.
///
/// Measured on RCD by `examples/defringe_noise`; a different demosaic needs them measured again.
pub const DEMOSAIC_CHANNEL_CORRELATION: [[f64; 3]; 3] =
    [[1.0, 0.63, 0.45], [0.63, 1.0, 0.63], [0.45, 0.63, 1.0]];

/// What a five-point Laplacian of luma returns over reconstructed noise, as a multiple of luma's
/// own variance.
///
/// Not the stencil's own `1+1+1+1+16`: that holds only where no two of the five share a photosite,
/// and a demosaic builds the neighbours out of the centre's. Measured over pure reconstructed grain
/// by `examples/defringe_noise`, two Sony bodies and a Canon giving 7.46 to 7.59.
pub const NOISE_CURVATURE_PER_VARIANCE: f64 = 7.53;

/// Indexed by channel; green is never asked, its response being identically zero.
///
/// Fitted against `defocus.slang`'s summed terms, where they are applied. A per-pixel expectation of
/// the same quantity comes to about four times these and raising them to it puts blue's coefficient
/// back on the decline with grain they were fitted to remove.
pub const NOISE_RESPONSE_PER_VARIANCE: [f64; 3] = [0.045, 0.0, 0.21];

/// The reconstruction's noise covariance, from each channel's measured variance and the
/// correlations the lattice and the camera matrix between them imply.
///
/// `variance` is read off the frame the defringe sees, which is past the matrix; the correlations
/// are not, so only they are carried through it. Passing no matrix leaves the lattice's own.
pub fn noise_covariance(variance: [f64; 3], matrix: Option<[[f32; 3]; 3]>) -> [[f64; 3]; 3] {
    let correlation = matrix.map_or(DEMOSAIC_CHANNEL_CORRELATION, correlation_through);
    let mut sigma = [[0f64; 3]; 3];
    for (a, row) in sigma.iter_mut().enumerate() {
        for (b, cell) in row.iter_mut().enumerate() {
            *cell = correlation[a][b] * (variance[a] * variance[b]).sqrt();
        }
    }
    sigma
}

/// What RCD leaves each channel's noise at, relative to the loudest. Only the ratios are read.
const DEMOSAIC_CHANNEL_GAIN: [f64; 3] = [1.0, 0.903, 1.0];

/// The correlations alone, carried through a camera matrix.
///
/// Correlations only: `sigma_from`'s variances are measured past `assemble` already, and sending
/// those through too applies the matrix twice, which inflates the correction until every bin's
/// curvature energy is subtracted away.
fn correlation_through(matrix: [[f32; 3]; 3]) -> [[f64; 3]; 3] {
    let m = |r: usize, c: usize| f64::from(matrix[r][c]);
    let before = |a: usize, b: usize| {
        DEMOSAIC_CHANNEL_CORRELATION[a][b] * DEMOSAIC_CHANNEL_GAIN[a] * DEMOSAIC_CHANNEL_GAIN[b]
    };
    let after = |r: usize, c: usize| -> f64 {
        (0..3)
            .flat_map(|a| (0..3).map(move |b| (a, b)))
            .map(|(a, b)| m(r, a) * before(a, b) * m(c, b))
            .sum()
    };
    let spread: Vec<f64> = (0..3)
        .map(|c| after(c, c).max(f64::MIN_POSITIVE).sqrt())
        .collect();
    let mut out = [[0f64; 3]; 3];
    for (r, row) in out.iter_mut().enumerate() {
        for (c, cell) in row.iter_mut().enumerate() {
            *cell = (after(r, c) / (spread[r] * spread[c])).clamp(-1.0, 1.0);
        }
    }
    out
}

/// Normalised Gaussian taps for `sigma`, from the centre outwards, out to `radius`.
///
/// The radius is given rather than derived from the sigma because the point spread this
/// deconvolves is truncated on purpose: a 3-sigma tail contributes a thousandth of the
/// kernel and costs a third of every convolution, and this one runs forty times. Two is
/// the 5x5 RawTherapee uses below radius 0.84.
pub fn gaussian(sigma: f32, radius: usize) -> Vec<f32> {
    let taps: Vec<f32> = (0..=radius)
        .map(|d| (-((d * d) as f32) / (2.0 * sigma * sigma)).exp())
        .collect();
    let sum: f32 = taps[0] + 2.0 * taps[1..].iter().sum::<f32>();
    taps.into_iter().map(|t| t / sum).collect()
}

/// Bins in the noise estimate's histogram, over a high-pass magnitude of 0..`NOISE_MAX`.
pub const NOISE_BINS: usize = 1024;
pub const NOISE_MAX: f32 = 0.08;

/// Where the noise estimate stops believing itself, with no measurement to say.
///
/// A frame that is *mostly* fine detail - a wall of close stripes - has a large median
/// residual that is signal rather than noise. Sensor noise surviving a demosaic and a
/// resample does not reach 2% of full scale, so past that this is reading texture.
const NOISE_CEILING: f32 = 0.02;

/// How much larger a reconstructed channel's noise can be than the mosaic's own sigma. Measured at
/// 0.93 to 1.03 by `examples/defringe_noise`, the rest headroom for a less kind matrix.
///
/// Widening it does not make the bound safer, it makes it inert: what it holds down is a median
/// that has wandered into texture, and a few times the real ratio loses every frame past ISO 800.
const NOISE_OVER_MOSAIC: f32 = 1.25;

/// The ceiling [`sigma_from`] should hold itself to on a frame whose noise has been fitted.
pub fn noise_ceiling(fit: Option<denoise::galosh::NoiseFit>) -> f32 {
    // Not floored at `NOISE_CEILING`: a high-ISO frame carries more grain than that guess, and
    // holding a measurement down to it tells the estimate the noise is smaller than the frame
    // demonstrably has.
    fit.map_or(NOISE_CEILING, |fit| {
        fit.model().at_white() * NOISE_OVER_MOSAIC
    })
}

/// How much of a pixel's own noise survives subtracting a 3x3 mean of its neighbourhood.
///
/// A demosaic builds the eight neighbours partly out of the photosites under the centre, so the
/// mean predicts the centre better than independent grain allows and the residual keeps less of it.
/// Measured at 0.598 and 0.599 over pure reconstructed grain by `examples/defringe_noise`,
/// unchanged from a mosaic sigma of 0.005 to 0.02.
const RESIDUAL_KEEPS: f32 = 0.60;

/// A plane's noise level, off a histogram of high-pass magnitudes.
///
/// The standard estimator from wavelet shrinkage: take a high-pass residual and read its
/// **median** absolute value rather than its mean. The median is what makes it work on a
/// photograph - edges and texture are a minority of pixels and arbitrarily large, so they
/// drag a mean anywhere, while the median sits among the ordinary pixels where the only
/// signal is noise. The 1.4826 recovers a Gaussian sigma from that median.
///
/// **The median is taken over the pixels that vary at all.** A pixel whose residual is
/// *exactly* zero is not a quiet noise sample; it is a pixel with no high-frequency content
/// whatsoever - clipped sky, a black letterbox, a blown highlight - and it says nothing
/// about the noise. Counting them, a frame that is half blown sky puts the median in that
/// flat half and reports zero noise.
///
/// The denoise this was written for runs on the mosaic now and fits its own model
/// (`denoise::galosh`); what still asks is the defringe, which needs each channel's noise to
/// debias its regression.
pub fn sigma_from(bins: &[u32], ceiling: f32) -> f32 {
    // Bin 0 is a residual under 0.008% of full scale, which is below a quantisation step
    // at any depth this runs at - so it is the "did not vary at all" bin, and the median
    // is taken over everything above it.
    let varying: u32 = bins[1..].iter().sum();
    if varying == 0 {
        return 0.0;
    }
    // Floored at one, or a frame with a single varying pixel takes the first bin
    // whatever its count - returning the minimum rather than the median.
    let half = (varying / 2).max(1);
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
    (median * 1.4826 / RESIDUAL_KEEPS).min(ceiling)
}

/// Samples of real curvature the estimate needs before it will believe itself.
pub const DEFOCUS_MIN_SAMPLES: usize = 2000;

/// Every nth pixel in each direction the estimate reads.
///
/// The coefficient is one number for the whole frame, so a 24MP frame at 3 still offers a
/// million samples and reading them all buys nothing.
pub const DEFOCUS_STRIDE: usize = 3;

/// Beyond this it is not a focus difference, it is a frame the model had no business
/// being fitted on. A coefficient is a blur difference in pixels squared; the worst real
/// measurement is a small fraction of one.
pub const DEFOCUS_MAX: f32 = 0.5;

/// Below this a coefficient is indistinguishable from zero, so it neither corrects
/// anything nor gets a vote on whether the other channel is believable.
///
/// Measured against a channel that is genuinely defocused: IMG_8408's blue reads 0.148
/// where its red reads -0.011, and treating that -0.011 as a real disagreement threw the
/// whole frame away.
pub const DEFOCUS_NOISE: f32 = 0.02;

/// The five-point Laplacian of a plane, clamped at the border.
///
/// **A fixture's, now that the regressor and the correction are both `defocus.slang`'s.** What is
/// left reaching this is `defocused`, which builds a frame carrying a known softness by adding a
/// multiple of it - so the shader is asked to recover a curvature this spelled out.
#[cfg(test)]
pub fn laplacian(plane: &[f32], width: usize, height: usize) -> Vec<f32> {
    use rayon::prelude::*;
    let mut out = vec![0.0f32; width * height];
    out.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        for (x, slot) in row.iter_mut().enumerate() {
            let here = plane[y * width + x];
            let left = plane[y * width + x.saturating_sub(1)];
            let right = plane[y * width + (x + 1).min(width - 1)];
            let up = plane[y.saturating_sub(1) * width + x];
            let down = plane[(y + 1).min(height - 1) * width + x];
            *slot = left + right + up + down - 4.0 * here;
        }
    });
    out
}

/// Radial bins the defocus fit accumulates into, uniform in r^2.
///
/// Enough to fit a line through and few enough that each holds a real sample count.
pub const DEFOCUS_BINS: usize = 6;

/// Samples a bin needs before its own coefficient is believed.
pub const DEFOCUS_MIN_PER_BIN: usize = 200;

/// Bins that must resolve before the constant and the `r^2` term can be told apart. Two
/// points fit a line exactly and prove nothing about whether the profile is one.
pub const DEFOCUS_MIN_BINS: usize = 3;

/// **Longitudinal chromatic aberration, which no warp can fix.**
///
/// Lateral aberration is a magnification difference and comes out in the resample. This is
/// the other one: the lens focuses red, green and blue at different distances, so at a
/// hard edge one channel is sharp and another is not, and the difference reads as a purple
/// or green rim. There is no geometry to undo - the channels are registered, one is simply
/// blurrier.
///
/// So the correction is to subtract the part of the colour that *is* that blur difference,
/// which `measure_defocus` has already measured for the whole frame. Linear, with no mask,
/// no threshold and no notion of "enough": where the frame carries no focus difference the
/// coefficient is zero and every pixel is left exactly as it was.

/// How hard each stage works, 0 for a stage that does not run.
///
/// The denoise is not here: it runs on the mosaic (`denoise::galosh`), before anything has
/// averaged a neighbour into anything, which is the only place the noise is still what the
/// sensor made. These are the two corrections that belong after a resample.
///
/// Named rather than two positional `f64`s: the pipeline calls this twice with a different
/// one of them non-zero each time, and `0.0, sharpen` at a call site says nothing about
/// which stage that is.
#[derive(Clone, Copy, Default, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct Strengths {
    pub sharpen: f64,
    pub defringe: f64,
}

impl Strengths {
    /// What runs on the frame before the camera match is fitted against it.
    ///
    /// Everything but the sharpen, which is a deconvolution of the *resample's* blur and
    /// so has to wait until after the warp that does the resampling (`base::prepare`).
    /// A fit calibrated against a sharpened render is calibrated against a frame that
    /// will not exist by the time the transform is applied.
    pub fn before_the_fit(self) -> Strengths {
        Strengths {
            sharpen: 0.0,
            ..self
        }
    }

    /// How far past a window the sharpen actually reads.
    ///
    /// Richardson-Lucy adds the point spread once per convolution, twice per iteration, and
    /// the anti-ringing limit adds its own window on top.
    pub fn halo(&self) -> usize {
        match self.sharpen > 0.0 {
            true => 2 * DECONVOLVE_RADIUS * DECONVOLVE_ITERATIONS + DECONVOLVE_RADIUS,
            false => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The edge-width histogram's shape, against the shader that fills it.
    ///
    /// [`edge_spread_sigma`] turns a bin index back into a sigma with these numbers, so a shader
    /// edit that moved one alone reads every histogram at the wrong scale and the sharpen
    /// deconvolves a blur that means nothing. `RUN` is here too because it is what decides how
    /// much of the border the dispatch leaves out, which the host guards on.
    ///
    /// Read from the Slang rather than what it emitted: a `static const` is folded into its use
    /// sites, so the declaration is not in the generated WGSL.
    #[test]
    fn the_edge_histogram_is_the_shape_the_shader_fills() {
        const SLANG: &str = include_str!("../../../slang/edge_spread.slang");
        let declared = |name: &str| {
            let opener = format!(" {name} = ");
            let start = SLANG
                .find(&opener)
                .unwrap_or_else(|| panic!("{name} is declared"));
            let rest = &SLANG[start + opener.len()..];
            rest.split(';')
                .next()
                .expect("a terminator")
                .trim()
                .to_string()
        };
        assert_eq!(declared("BINS"), EDGE_SPREAD_BINS.to_string());
        assert_eq!(
            declared("SPAN_CEIL").parse::<f32>().expect("a number"),
            EDGE_SPREAD_CEIL
        );
        assert_eq!(declared("RUN"), EDGE_SPREAD_RUN.to_string());
    }

    /// The decile walk, on histograms whose answer is known.
    ///
    /// The soft majority is what a photograph is - most edges are the subject rather than the
    /// optics - so an estimator that read the middle would report the scene. What is pinned is
    /// that it reads the sharp tail instead, and that a handful of impossibly narrow votes does
    /// not drag it below what the lens could have done.
    #[test]
    fn the_edge_spread_reads_the_sharp_decile() {
        let bytes = |bins: &[(usize, u32)]| {
            let mut mapped = vec![0u8; EDGE_SPREAD_BINS * 4];
            for &(bin, count) in bins {
                mapped[bin * 4..bin * 4 + 4].copy_from_slice(&count.to_le_bytes());
            }
            mapped
        };
        let width_bin = |width: f32| (width / EDGE_SPREAD_CEIL * EDGE_SPREAD_BINS as f32) as usize;

        // A sigma of 0.7 is a 10-90 of 1.79 pixels; a soft majority at 3 pixels must not win, and
        // twenty spikes at half a pixel must not either.
        let mapped = bytes(&[
            (width_bin(0.5), 20),
            (width_bin(1.79), 60_000),
            (width_bin(3.0), 500_000),
        ]);
        let sigma = edge_spread_sigma(&mapped).expect("a sigma");
        assert!(
            (0.66..=0.74).contains(&sigma),
            "the decile sits near 0.7 and this read {sigma}"
        );

        // Too few edges is no answer, not a confident one.
        assert_eq!(edge_spread_sigma(&bytes(&[(width_bin(1.79), 400)])), None);
    }

    #[test]
    fn a_fitted_frame_is_held_to_its_own_noise_rather_than_a_constant() {
        // `unified_sigma` is set to what a photograph carries rather than to match `sigma_sq`: it is
        // GAT-domain and reads near 1.2 at any exposure, so a fixture agreeing with both cannot tell
        // a ceiling built from the wrong one apart.
        let fitted = |sigma: f32| denoise::galosh::NoiseFit {
            alpha: 0.0,
            sigma_sq: sigma * sigma,
            unified_sigma: 1.19,
            dark_ref: [0.0; 4],
        };
        assert_eq!(noise_ceiling(None), NOISE_CEILING);
        // A quiet frame binds far tighter than the constant, and by its own sigma.
        let quiet = noise_ceiling(Some(fitted(0.001)));
        assert!(
            quiet < NOISE_CEILING / 4.0,
            "a quiet frame is barely bounded: {quiet}"
        );
        assert!((quiet - 0.001 * NOISE_OVER_MOSAIC).abs() < 1e-6, "{quiet}");
        // And a noisy one is allowed past it, or the estimate is told its grain is smaller than
        // the frame measurably has.
        assert!(noise_ceiling(Some(fitted(0.02))) > NOISE_CEILING);
    }

    #[test]
    fn the_matrix_remixes_the_lattice_correlations() {
        let variance = [1.0, 1.0, 1.0];
        let lattice = noise_covariance(variance, None);
        for (a, row) in DEMOSAIC_CHANNEL_CORRELATION.iter().enumerate() {
            for (b, want) in row.iter().enumerate() {
                assert!(
                    (lattice[a][b] - want).abs() < 1e-9,
                    "{a}{b}: {}",
                    lattice[a][b]
                );
            }
        }

        // The identity has to change nothing, or the propagation is doing something besides
        // propagating.
        let identity = noise_covariance(
            variance,
            Some([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]),
        );
        for (a, row) in DEMOSAIC_CHANNEL_CORRELATION.iter().enumerate() {
            for (b, want) in row.iter().enumerate() {
                assert!(
                    (identity[a][b] - want).abs() < 1e-6,
                    "{a}{b}: {}",
                    identity[a][b]
                );
            }
        }

        // A real camera matrix pulls blue away from green: measured on a Sony, 0.63 falls to about
        // 0.21, which is the whole reason the propagation exists.
        let sony = [
            [1.53, -0.42, -0.11],
            [-0.09, 1.20, -0.11],
            [0.01, -0.30, 1.29],
        ];
        let remixed = noise_covariance(variance, Some(sony));
        let correlation =
            |a: usize, b: usize| remixed[a][b] / (remixed[a][a] * remixed[b][b]).sqrt();
        assert!(
            correlation(2, 1) < 0.45,
            "blue against green: {}",
            correlation(2, 1)
        );
        // Still a correlation matrix afterwards, whatever the matrix was.
        for c in 0..3 {
            assert!(remixed[c][c] > 0.0, "channel {c} has no variance");
        }
        for (a, b) in [(0, 1), (2, 1), (0, 2)] {
            assert!(
                correlation(a, b).abs() <= 1.0,
                "{a}{b} left [-1, 1]: {}",
                correlation(a, b)
            );
        }
    }

    /// A frame that is nothing but fine detail reports its own fitted noise, not the constant.
    ///
    /// The clamp is what carries the fit into the estimate, so it is asserted against a ceiling
    /// [`noise_ceiling`] built one - against the constant it would hold for the old fixed ceiling
    /// too, and pass whether or not a fit ever reached here.
    #[test]
    fn the_ceiling_is_what_bounds_a_median_that_ran_into_texture() {
        let mut bins = vec![0u32; NOISE_BINS];
        bins[NOISE_BINS - 1] = 10_000;
        let quiet = denoise::galosh::NoiseFit {
            alpha: 0.0,
            sigma_sq: 0.001 * 0.001,
            unified_sigma: 1.19,
            dark_ref: [0.0; 4],
        };
        let fitted = noise_ceiling(Some(quiet));
        assert_eq!(sigma_from(&bins, fitted), fitted);
        assert!(
            fitted < NOISE_CEILING,
            "a quiet frame should bind tighter than {NOISE_CEILING}"
        );
    }

    /// What the deconvolution undoes, at both ends of the downscale and in between.
    ///
    /// **Every picture this pipeline sharpens goes through here**, and the failure is silent: a
    /// composition off by a fifth is a photograph slightly soft or slightly crunchy, which nothing
    /// downstream can see. The graded fixtures cannot - they run at `SharpenSigma::fixed` - and
    /// the shader tests hold the *taps* against a sigma they are handed rather than against this.
    ///
    /// The two ends are what the quadrature is written to get exactly right, so they are asserted
    /// as identities rather than as numbers: at `k = 1` there is no resample and the answer is the
    /// capture's own blur; as `k` grows the capture narrows away and the answer approaches the
    /// fixed sigma this pipeline sharpened every deep downscale with before anything was measured.
    #[test]
    fn the_sigma_composes_from_the_capture_and_the_resample() {
        // No measurement is yesterday's behaviour, whatever the scale.
        assert_eq!(
            deconvolve_split(None, 6000, 1200).composed,
            DECONVOLVE_SIGMA
        );
        assert!(deconvolve_split(None, 6000, 1200).terms.is_none());

        // 1:1, so nothing was resampled and the capture stands alone.
        let full = deconvolve_split(Some(0.62), 6000, 6000);
        assert!((full.composed - 0.62).abs() < 1e-6, "{}", full.composed);
        let (capture, resample) = full.terms.expect("the two terms");
        assert!((capture - 0.62).abs() < 1e-6);
        assert_eq!(resample, 0.0);

        // A target larger than the source does not sharpen it *more*: `k` floors at one.
        assert_eq!(
            deconvolve_split(Some(0.62), 3000, 6000).composed,
            full.composed
        );

        // Halved, which is the editor's own decode: the capture narrows to half and the resample
        // is the fixed sigma's share of what the downscale added.
        let half = deconvolve_split(Some(0.62), 6000, 3000)
            .terms
            .expect("the two terms");
        assert!((half.0 - 0.31).abs() < 1e-6, "{}", half.0);
        let wanted = (DECONVOLVE_SIGMA * DECONVOLVE_SIGMA * 3.0).sqrt() / 2.0;
        assert!(
            (half.1 - wanted).abs() < 1e-6,
            "{} against {wanted}",
            half.1
        );

        // Deep, where the capture has narrowed to nothing and only the resample is left.
        let deep = deconvolve_split(Some(0.62), 9504, 400);
        assert!(
            (deep.composed - DECONVOLVE_SIGMA).abs() < 0.01,
            "{} is not {DECONVOLVE_SIGMA}",
            deep.composed,
        );

        // In between it walks from the capture's own blur to the fixed sigma and stops there,
        // whichever side it started - so the direction is the *limit's*, not downward. A capture
        // sharper than the default rises to meet it, a softer one falls to it, and neither
        // overshoots: `(k^2-1)/k^2` reaches one and no further.
        for capture in [0.35f32, 0.62, 0.80] {
            let (low, high) = (capture.min(DECONVOLVE_SIGMA), capture.max(DECONVOLVE_SIGMA));
            let mut last = capture;
            for out in [6000, 4000, 3000, 2000, 1500, 1000, 600, 400] {
                let at = deconvolve_split(Some(capture), 6000, out).composed;
                assert!((0.3..=0.84).contains(&at), "{at} at {out} from {capture}");
                assert!(
                    (low - 1e-6..=high + 1e-6).contains(&at),
                    "{at} left {low}..{high}"
                );
                let toward = (at - last) * (DECONVOLVE_SIGMA - capture);
                assert!(
                    toward >= -1e-6,
                    "{at} at {out} moved away from the fixed sigma"
                );
                last = at;
            }
            let deepest = deconvolve_split(Some(capture), 6000, 200).composed;
            assert!(
                (deepest - DECONVOLVE_SIGMA).abs() < 0.02,
                "{deepest} from {capture}"
            );
        }
    }

    #[test]
    fn sharpen_noise_follows_the_decode_and_resize_samples() {
        let noise = SharpenNoise {
            shot_per_light: [4.0; 3],
            read_variance: [8.0; 3],
            ..SharpenNoise::NONE
        };
        let sensor = units::px::Span::<units::px::Sensor>::exact(6000);
        assert_eq!(
            noise.at(sensor, units::px::Span::<units::px::Drawn>::exact(6000)),
            noise,
        );
        assert_eq!(
            noise.at(sensor, units::px::Span::<units::px::Drawn>::exact(3000)),
            SharpenNoise {
                shot_per_light: [1.0; 3],
                read_variance: [2.0; 3],
                ..noise
            },
        );

        let halved = SharpenNoise {
            reduction: 2,
            ..noise
        };
        assert_eq!(
            halved.at(sensor, units::px::Span::<units::px::Drawn>::exact(3000)),
            SharpenNoise {
                shot_per_light: [4.0, 2.0, 4.0],
                read_variance: [8.0, 4.0, 8.0],
                ..halved
            },
        );
        assert_eq!(
            halved.at(sensor, units::px::Span::<units::px::Drawn>::exact(1500)),
            SharpenNoise {
                shot_per_light: [1.0, 0.5, 1.0],
                read_variance: [2.0, 1.0, 2.0],
                ..halved
            },
        );

        let third = SharpenNoise {
            reduction: 3,
            ..noise
        };
        let cfa = mosaic::cfa::parse(mosaic::cfa::XTRANS, 6, 6);
        let mut least = [usize::MAX; 3];
        for row in 0..6 {
            for col in 0..6 {
                let mut counts = [0usize; 3];
                for dy in 0..3 {
                    for dx in 0..3 {
                        counts[usize::from(cfa.colour_at(row + dy, col + dx))] += 1;
                    }
                }
                for channel in 0..3 {
                    least[channel] = least[channel].min(counts[channel]);
                }
            }
        }
        assert_eq!(least, [1, 5, 1]);
        assert_eq!(
            third.at(sensor, units::px::Span::<units::px::Drawn>::exact(2000)),
            SharpenNoise {
                shot_per_light: [4.0, 0.8, 4.0],
                read_variance: [8.0, 1.6, 8.0],
                ..third
            },
        );
    }

    /// Dense achromatic bars.
    ///
    /// **Dense on purpose.** The estimate is a regression that wants thousands of samples
    /// carrying real second differences, and a fixture with one edge in it offers a few
    /// dozen - so it would decline for want of evidence and every assertion below would
    /// pass on the stage doing nothing.
    fn bars(width: usize, height: usize) -> Vec<u8> {
        let mut data = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                let value = if (x / 4) % 2 == 0 { 40u8 } else { 210 };
                for c in 0..3 {
                    data[i + c] = value;
                }
            }
        }
        data
    }

    /// Rescales one channel about the centre, which is what a *lateral* aberration is: a
    /// magnification difference, with every channel still perfectly in focus.
    fn scale_channel(src: &[u8], channel: usize, scale: f64) -> Vec<u8> {
        let (w, h) = (400usize, 300usize);
        let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
        let mut out = src.to_vec();
        for y in 0..h {
            for x in 0..w {
                let (sx, sy) = (cx + (x as f64 - cx) * scale, cy + (y as f64 - cy) * scale);
                if sx < 0.0 || sy < 0.0 || sx >= (w - 1) as f64 || sy >= (h - 1) as f64 {
                    continue;
                }
                let (x0, y0) = (sx as usize, sy as usize);
                let (fx, fy) = (sx - x0 as f64, sy - y0 as f64);
                let at = |xx: usize, yy: usize| f64::from(src[(yy * w + xx) * 3 + channel]);
                let value = at(x0, y0) * (1.0 - fx) * (1.0 - fy)
                    + at(x0 + 1, y0) * fx * (1.0 - fy)
                    + at(x0, y0 + 1) * (1.0 - fx) * fy
                    + at(x0 + 1, y0 + 1) * fx * fy;
                out[(y * w + x) * 3 + channel] = value.round().clamp(0.0, 255.0) as u8;
            }
        }
        out
    }

    /// Defocuses `channels` against the rest, which is what a longitudinal aberration
    /// physically is.
    ///
    /// `v + s.lap(v)` is one step of the heat equation, so it blurs - and it leaves the
    /// channel carrying exactly `s.lap(luma)` of extra colour, which is the model
    /// `measure_defocus` fits. The old fixture painted a magenta rim on by hand, which is
    /// a fringe-*coloured* frame rather than a defocused one: nothing about its shape
    /// obliged an estimator to be right about the defect.
    fn defocus_channels(
        frame: &[u8],
        width: usize,
        height: usize,
        channels: &[usize],
        softness: f32,
    ) -> Vec<u8> {
        let mut out = frame.to_vec();
        for y in 0..height {
            for x in 0..width {
                for &c in channels {
                    let at = |xx: usize, yy: usize| f32::from(frame[(yy * width + xx) * 3 + c]);
                    // Clamped at the border rather than skipped, because `laplacian` is:
                    // leave the border undefocused and the correction still runs there,
                    // inventing a fringe the fixture never injected.
                    let curvature = at(x.saturating_sub(1), y)
                        + at((x + 1).min(width - 1), y)
                        + at(x, y.saturating_sub(1))
                        + at(x, (y + 1).min(height - 1))
                        - 4.0 * at(x, y);
                    out[(y * width + x) * 3 + c] =
                        (at(x, y) + softness * curvature).clamp(0.0, 255.0).round() as u8;
                }
            }
        }
        out
    }

    /// **Noise alone must measure nothing.**
    ///
    /// The regressor and the response are built from the same pixels - the stencil's `-4c`
    /// term and the response's `-luma(c)` share one - so their noise is correlated by
    /// construction. Green's enters the two with opposite signs, which made the residue
    /// *positive for both channels*: it cleared the sign veto, which exists to catch things
    /// that flip sign, and being a ratio of variances it did not shrink as the noise did.
    /// A flat frame with independent per-channel grain fitted (0.124, 0.175) - the blue
    /// figure larger than the 0.148 measured on the worst real frame in the library.
    ///
    /// `measure_defocus` now subtracts both sums' noise terms analytically, and this is the
    /// test that says so. **Independent per-channel noise is the whole point**: every other
    /// noisy fixture here adds the *same* grain to all three channels, which cancels in
    /// `R - luma` identically and is exactly why this shipped unseen.
    /// The defocus fit, on the device, over an 8-bit fixture widened to what the shader reads.
    ///
    /// **The estimator's properties are asserted against the implementation that ships.** These
    /// fixtures are 8-bit because they were written against a CPU copy that has gone; the widening
    /// is `* 257`, which is exact and leaves every threshold in the normalised scale it is written
    /// against.
    fn fitted(frame: &[u8], width: usize, height: usize) -> Option<(f32, f32)> {
        let gpu = gpu::device()?;
        let base = crate::base::device(gpu)?;
        let wide = colour::resident::samples_of_levels(frame.iter().map(|&b| f32::from(b) * 257.0));
        pollster::block_on(crate::base::measure_defocus(
            gpu, base, &wide, width, height, None, None,
        ))
    }

    /// Whether there is a device to fit on at all, so a test can decline rather than read a
    /// missing adapter as the estimator answering `None`.
    fn fits() -> bool {
        gpu::device().and_then(crate::base::device).is_some()
    }

    #[test]
    fn independent_channel_noise_alone_is_not_a_focus_difference() {
        if !fits() {
            return;
        }
        let (w, h) = (400usize, 300usize);
        let noise = |seed: u64, base: &[u8]| {
            let mut out = base.to_vec();
            let mut state = seed;
            for slot in out.iter_mut() {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let grain = ((state >> 33) % 5) as i32 - 2;
                *slot = (i32::from(*slot) + grain).clamp(0, 255) as u8;
            }
            out
        };

        let flat = noise(0x9E37_79B9_7F4A_7C15, &vec![128u8; w * h * 3]);
        assert_eq!(
            fitted(&flat, w, h),
            None,
            "noise alone is not a focus difference"
        );

        // And the correction it does measure has to be the same with the noise as without,
        // or the subtraction has merely moved the bias rather than removed it.
        let clean = defocus_channels(&bars(w, h), w, h, &[0, 2], 0.12);
        let grainy = noise(0x2545_F491_4F6C_DD1D, &clean);
        let (clean_red, clean_blue) = fitted(&clean, w, h).expect("a coefficient");
        let (noisy_red, noisy_blue) = fitted(&grainy, w, h).expect("a coefficient");
        assert!(
            (clean_red - noisy_red).abs() < 0.01 && (clean_blue - noisy_blue).abs() < 0.01,
            "noise moved the coefficient: ({clean_red}, {clean_blue}) to ({noisy_red}, {noisy_blue})",
        );
    }

    /// **A lateral aberration is not a focus difference, and the radius is what says so.**
    ///
    /// A channel displaced by `d` expands as `G + d.grad G + (d^2/2).lap G`, and that
    /// second-order term is the very basis this fit regresses on. It carries `d^2`, so it
    /// is positive for red and blue whichever way each channel is displaced - exactly the
    /// case the sign-disagreement veto cannot catch, since that veto rejects things which
    /// flip sign. Before the radial split this fixture fitted (0.054, 0.053) with nothing
    /// out of focus anywhere, and the correction was then applied at every radius including
    /// the centre, where a magnification difference displaces nothing at all.
    ///
    /// What separates them: `d` grows with `r`, so a lateral confound's apparent
    /// coefficient grows with `r^2`, where a focus difference is flat across the field. The
    /// fit is taken per radial bin and split into a constant and an `r^2` term; only the
    /// constant survives. That leaves 0.008 here, under the noise band, so the frame
    /// declines outright.
    #[test]
    fn a_pure_lateral_aberration_is_not_read_as_a_focus_difference() {
        if !fits() {
            return;
        }
        let (w, h) = (400usize, 300usize);
        let lateral = scale_channel(&scale_channel(&bars(w, h), 0, 1.0015), 2, 0.9985);
        assert_eq!(
            fitted(&lateral, w, h),
            None,
            "a magnification difference is not a focus difference",
        );
    }

    #[test]
    fn a_focus_difference_survives_a_lateral_one_on_top_of_it() {
        if !fits() {
            return;
        }
        // The split must not simply reject everything radial: a real focus difference sits
        // in the constant term and has to come through a frame carrying both.
        let (w, h) = (400usize, 300usize);
        let defocus = defocus_channels(&bars(w, h), w, h, &[0, 2], 0.12);
        let (clean_red, _) = fitted(&defocus, w, h).expect("a coefficient");
        let both = scale_channel(&scale_channel(&defocus, 0, 1.0015), 2, 0.9985);
        let (mixed_red, mixed_blue) = fitted(&both, w, h).expect("a coefficient");
        assert!(
            mixed_red > clean_red * 0.7 && mixed_red < clean_red * 1.3,
            "the focus difference should survive the lateral one: {mixed_red} against {clean_red}",
        );
        assert!(mixed_blue > DEFOCUS_NOISE, "blue too: {mixed_blue}");
    }

    #[test]
    fn the_estimate_recovers_the_softness_that_was_injected() {
        if !fits() {
            return;
        }
        // Straight at the estimator, because the round trip above would also pass on a
        // coefficient that is merely the right sign.
        let (w, h) = (400usize, 300usize);
        for injected in [0.06f32, 0.12] {
            let frame = defocus_channels(&bars(w, h), w, h, &[0, 2], injected);
            let (red, blue) = fitted(&frame, w, h).expect("a coefficient");
            for (name, found) in [("red", red), ("blue", blue)] {
                assert!(
                    (found - injected).abs() < injected * 0.35,
                    "{name}: injected {injected}, measured {found}",
                );
            }
        }
    }

    #[test]
    fn one_channel_measuring_nothing_does_not_veto_the_other() {
        if !fits() {
            return;
        }
        // **The case that shipped broken.** IMG_8408 - the frame this project cites as its
        // worst, at 98.48 of fringe - measures blue at +0.148 and red at -0.011, and a bare
        // product veto read that -0.011 as a disagreement and threw the whole frame away.
        // A channel with nothing to say must not silence one that has.
        let (w, h) = (400usize, 300usize);
        let frame = defocus_channels(&bars(w, h), w, h, &[2], 0.15);
        let (red, blue) = fitted(&frame, w, h).expect("blue alone is still a fringe");
        assert!(blue > 0.1, "blue measured {blue}");
        assert_eq!(
            red, 0.0,
            "red had nothing to correct and must be left at zero"
        );
    }

    #[test]
    fn a_channel_measured_sharper_than_green_is_not_sharpened() {
        if !fits() {
            return;
        }
        // Subtracting a negative coefficient would add curvature to that channel's chroma,
        // inventing an edge rather than removing one.
        let (w, h) = (400usize, 300usize);
        let frame = defocus_channels(&bars(w, h), w, h, &[0], -0.15);
        match fitted(&frame, w, h) {
            None => {}
            Some((red, blue)) => {
                assert_eq!(
                    (red, blue),
                    (0.0, 0.0),
                    "a sharper channel asked for a correction"
                );
            }
        }
    }

    #[test]
    fn a_channel_softer_and_a_channel_sharper_is_declined() {
        if !fits() {
            return;
        }
        // Autofocus works on luma, so green is the focused channel and red and blue are
        // both softer than it. Coefficients on opposite sides of zero are the scene's
        // colour being read as a lens fault, which is the way this regression fails.
        let (w, h) = (400usize, 300usize);
        let softened = defocus_channels(&bars(w, h), w, h, &[0], 0.12);
        let frame = defocus_channels(&softened, w, h, &[2], -0.12);
        assert!(fitted(&frame, w, h).is_none());
    }
}
