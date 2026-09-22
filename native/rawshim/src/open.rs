//! Opening a photograph: correcting the decode, then measuring everything about it that a shader
//! cannot work out for itself.
//!
//! **One implementation, because a rendition is an open.** A job is this, then one tick, then an
//! encode; the editor is this, then a tick per slider move. They were written twice - two copies of
//! the same six steps in `job::Base::build` and `edit::from_frame` - and the copies drifted in
//! exactly the way two copies do: one of them learned to skip the readback when the photograph
//! arrived already measured and the other did not, so an open that should have cost nothing paid
//! 366MB for it.
//!
//! What genuinely differs between the two callers is here as [`Opening`], and it is three things: a
//! rendition may decline to match the camera at all, the two hosts fit that match from different
//! sources ([`Fitting`]), and a job brings its own strengths. Everything else - which stages run,
//! what is measured, what is skipped because it was handed over - is the same code for both.

use crate::resident::Resident;
use crate::hdr_fit::CameraMatch;

/// Where a camera match comes from, and whether one is wanted.
///
/// **The one real difference between the hosts, named.** Both fit the same curve against the
/// camera's own embedded JPEG; they disagree only about where the lens geometry comes from, and
/// that is a build difference rather than a choice. The editor carries neither the database nor
/// its ~3.6MB of XML, so it fits the distortion from the picture; a rendition consults the
/// database for a recorded lens as a fourth tier on top of that.
///
/// Measured over 32 Canon frames, the database is worth 0.049 luma levels of 65535 against the
/// fitted geometry, and the gap lives almost entirely in wide and superzoom glass.
pub enum Fitting<'a> {
    None,
    /// From the file's bytes, with the geometry fitted from the picture. The editor's.
    Preview(&'a [u8]),
    /// The same, with the database consulted for a recorded lens. A rendition's.
    #[cfg(feature = "renditions")]
    Profiled(&'a str),
}

impl Fitting<'_> {
    fn wanted(&self) -> bool {
        !matches!(self, Fitting::None)
    }
}

/// What a caller brings to an open that is not the photograph.
pub struct Opening<'a> {
    pub grade: crate::hdr::Grade,
    pub strengths: crate::image::Strengths,
    /// What is already known about this photograph, so an open measures only what it must.
    pub stored: &'a crate::photo_analysis::PhotoAnalysis,
    pub fitting: Fitting<'a>,
    pub camera_match: CameraMatch,
    /// The mosaic's own noise, as the decode fitted it. What bounds the defringe's per-channel
    /// estimate, which is a median over a demosaiced frame and so cannot tell texture from grain.
    pub noise: Option<crate::galosh::NoiseFit>,
    /// The matrix the demosaic multiplied the samples by, which the same estimate propagates its
    /// channel correlations through.
    pub matrix: Option<[[f32; 3]; 3]>,
}

/// Everything an open measured, in the units the stages below it read.
pub struct Measured {
    pub matched: Option<crate::hdr_fit::HdrMatch>,
    /// Unfloored, as the photograph's own: `anchored()` is what the coding takes.
    pub levels: crate::tone::Levels,
    /// What the chain below is to do about longitudinal aberration, decided here so that both
    /// callers do the same thing with the same stored analysis.
    ///
    /// **Three answers and one place to derive them.** The correction ran ahead of the fit, or it
    /// did not and the photograph's pair is on file, or neither and the chain reads its own. Left to
    /// the callers, one of them consulted the stored pair and the other measured a fresh one - which
    /// is a rendition and the tab that predicts it defringing by different amounts.
    pub defringe: crate::base::Defringe,
    /// The blur this frame carries, as a Gaussian sigma in *this frame's* pixels - so a caller
    /// whose decode halved doubles it to reach the sensor's. None where the photograph already
    /// had one on file, or where the frame offered too few edges to read one off.
    pub blur: Option<f32>,
}

/// Corrects the decoded frame in place, then measures the camera match and the levels.
///
/// **The frame stays on the device.** The correction is a shader over the buffer the demosaic
/// wrote, and what comes back is the two host computations' input - the fit, which compares linear
/// samples against the camera's JPEG, and the quantile, which is a sort. A photograph arriving with
/// both already measured makes no transfer at all, which is the saving the two copies of this
/// disagreed about.
///
/// Ahead of the coding, and ahead of the fit, for the reason `base::correct` records: the search
/// compares our render against a JPEG the camera has already defringed, so a fringe left on is a
/// difference between the two that has nothing to do with the colour being fitted.
pub async fn measure(frame: &Resident, how: &Opening<'_>) -> Result<Measured, String> {
    let mut lap = crate::clock::laps("  open ");
    let (width, height) = frame.size();
    let strengths = how.strengths.before_the_fit();
    let stored = how.stored;

    // The photograph's own where it has been read before, since the fit is whole-frame and this
    // caller's frame may not be one - and at this resolution, a coefficient being in pixels.
    let known_defocus = stored
        .from_render
        .defocus
        .and_then(|d| d.pair_for(strengths.defringe, width.max(height)));

    // Only where a match is actually going to be fitted: a photograph that has one stored skips
    // this and lets the chain's own `prepare` correct, which costs no transfer at all.
    let needs_fit = how.fitting.wanted() && how.camera_match.needs_fit(stored.from_raw.matched.as_ref());
    let defocus = match needs_fit {
        false => None,
        true => {
            let refused = || crate::base::without_a_device("the defringe before the camera match");
            let gpu = crate::gpu::device().ok_or_else(refused)?;
            let base = crate::base::device(gpu).ok_or_else(refused)?;
            crate::base::correct(
                gpu,
                base,
                frame,
                strengths,
                known_defocus,
                how.noise,
                how.matrix,
            )
            .await
        }
    };
    lap("correct");

    // What the chain is to do, decided once. `correct` ran over this buffer, or the photograph's
    // pair is on file, or neither and the chain reads its own off the frame it is given.
    let defringe = match defocus {
        Some(pair) => crate::base::Defringe::Done(pair),
        None => known_defocus.map_or(crate::base::Defringe::Measure, crate::base::Defringe::Take),
    };

    // **The blur the sharpen will be asked to invert, read off the frame that carries it.** Here
    // rather than beside the noise fit, because what a deconvolution meets is the capture *and*
    // the demosaic, and the mosaic's green lattice is two pixels apart - a 1.8 pixel rise cannot
    // be resolved on it at all. Linear and ahead of the coding, where a blurred edge's 10-90
    // distance is 2.563 sigma and a curve has not moved either crossing.
    //
    // Once per photograph, like everything else here: a window measuring its own reads whatever
    // its few hundred thousand pixels happen to contain, and a loupe that sharpens differently
    // from the export is a loupe that lies.
    let blur = match stored.from_raw.capture_sigma.is_none() {
        false => None,
        true => {
            let gpu = crate::gpu::device();
            let base = gpu.and_then(crate::base::device);
            match (gpu, base) {
                (Some(gpu), Some(base)) => {
                    crate::base::measure_edge_spread(gpu, base, frame.buffer(), width, height).await
                }
                _ => None,
            }
        }
    };
    lap("edge spread");

    let known_levels =
        stored.from_render.levels.and_then(|m| m.levels_at(how.grade.white_quantile));

    let (matched, fitted_levels) = match (&how.fitting, &stored.from_raw.matched) {
        (Fitting::None, _) => (None, None),
        _ if !needs_fit => (how.camera_match.apply(stored.from_raw.matched.clone()), None),
        (fitting, Some(matched)) => {
            complete_colour(fitting, frame, how.grade.white_quantile, matched).await
                .map_or_else(|| (Some(matched.clone()), None), |(matched, levels)| (Some(matched), Some(levels)))
        }
        (Fitting::Preview(bytes), None) => match crate::gpu::device() {
            Some(gpu) => fit_from_preview(gpu, bytes, frame, how.grade.white_quantile, how.camera_match).await,
            None => None,
        }
        .unzip(),
        #[cfg(feature = "renditions")]
        (Fitting::Profiled(path), None) => {
            crate::fit_hdr_measured(frame, path, how.grade.white_quantile, how.camera_match).unzip()
        }
    };
    lap("camera match");

    // A quantile of the frame is not moved by the Detail sliders or by anything else a caller
    // brings, and two renders of one photograph anchoring differently is exactly the drift
    // `tone::QUANTILE_SAMPLES` exists to prevent. A fit read them off this same buffer through the same
    // kernel, so an open that fitted reads them once.
    let levels = match known_levels.or(fitted_levels) {
        Some(levels) => levels,
        None => {
            let refused = || crate::base::without_a_device("the frame's own levels");
            let gpu = crate::gpu::device().ok_or_else(refused)?;
            crate::fit_source::levels(gpu, frame, how.grade.white_quantile)
                .await
                .ok_or("the frame's levels could not be measured")?
        }
    };
    lap("levels");
    Ok(Measured { matched, levels, defringe, blur })
}

async fn complete_colour(
    fitting: &Fitting<'_>,
    frame: &Resident,
    quantile: f64,
    matched: &crate::hdr_fit::HdrMatch,
) -> Option<(crate::hdr_fit::HdrMatch, crate::tone::Levels)> {
    let gpu = crate::gpu::device()?;
    let preview = match fitting {
        Fitting::None => return None,
        Fitting::Preview(bytes) => crate::hdr::match_preview_from_bytes(bytes)?,
        #[cfg(feature = "renditions")]
        Fitting::Profiled(path) => crate::hdr::match_preview(path)?,
    };
    crate::hdr::fit_match_from(gpu, frame, quantile, &preview, matched.lens.clone()).await
}

/// The camera match off the file's own embedded preview, with the geometry fitted from the picture.
///
/// Declining is not an error: `hdr::fit_all_from_preview` returns None for a file with no embedded
/// preview and for one whose fit found too few usable pairs, and the grade then takes its neutral
/// arm exactly as a rendition's does.
async fn fit_from_preview(
    gpu: &'static crate::gpu::Gpu,
    raw: &[u8],
    frame: &Resident,
    quantile: f64,
    camera_match: CameraMatch,
) -> Option<(crate::hdr_fit::HdrMatch, crate::tone::Levels)> {
    // A decode narrower than the preview cannot be paired against it: `fit_source::plane_size`
    // clamps its target to the frame's own width, so the two grids come out different sizes and
    // `pairs` asserts on it. Renditions never reach this because they decode at thousands of
    // pixels; the editor can, because the client asks for the size its stage can show
    // (`docs/raw-edit-gpu.md` §4.1).
    let (width, height) = frame.size();
    if width.max(height) < crate::hdr_fit::sample_long_edge() {
        return None;
    }
    let preview = crate::hdr::match_preview_from_bytes(raw)?;
    let recorded = crate::lens::read_distortion(raw);
    let geometry = match (recorded.applied, recorded.spline) {
        (Some(false), _) => crate::fit::Geometry::Uncorrected,
        (_, Some(knots)) => crate::fit::Geometry::Recorded(knots),
        (_, None) => crate::fit::Geometry::Unstated,
    };
    crate::hdr::fit_all_from_preview(gpu, frame, quantile, geometry, &preview, recorded.lateral, camera_match)
        .await
        .map(|(_, matched, levels)| (matched, levels))
}
