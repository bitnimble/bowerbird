// One photo's renditions, run end to end on this side (DESIGN 10.3).
//
// This is what `processing_worker.ts` used to orchestrate over a handle. It moved
// not because TypeScript was slow at it - it was doing almost nothing per call -
// but because orchestrating from over there required the decode to exist as a raw
// pointer JavaScript held between calls, and a pointer whose lifetime the compiler
// cannot see is a pointer whose lifetime is a comment. Here every frame is an owned
// value in a scope, dropped when that scope ends, borrowed with references the
// borrow checker actually checks.
//
// What crosses the boundary is a command and a result, both JSON: no addresses, no
// handles, nothing for the other side to free, and no way to ask for pixels.
//
// The ordering is the worker's and the reasons come with it: one decode shared by
// the fit and every rendition of its dynamic range, one grade per photo rather than
// one per rendition, and the largest size built first so smaller ones are a resize
// of it rather than their own warp of the same picture.

use crate::fit;
use crate::frame::Frame;
use crate::hdr;
use crate::hdr_args::{Chroma, EncodeOptions};
use crate::image::Strengths;
use crate::stacks;
use serde::{Deserialize, Serialize};

/// Where a rendition's pixels come from.
#[derive(Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// Demosaic the RAW.
    Render,
    /// Lift the camera's own JPEG out of it, which is what every grid tile does.
    Embedded,
}

#[derive(Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Rendition {
    Grid,
    Full,
    Max,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub rendition: Rendition,
    pub hdr: bool,
    pub output_path: String,
    /// Longest edge, or 0 for native resolution.
    pub size: u32,
    pub source: Source,
    pub sdr_quantizer: i32,
    pub hdr_quantizer: i32,
    pub preset: i32,
    pub still_full_chroma: bool,
    pub sdr_full_chroma: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub raw_file_path: String,
    pub match_embedded_jpeg: bool,
    /// The two denoise strengths and the fraction of the deconvolution to blend in
    /// (`raw_denoise_luma`, `raw_denoise_chroma`, `raw_sharpen`, §10.9). All three belong
    /// to the render rather than to one rendition of it, so every target gets the same set.
    ///
    /// None is scaled here. How much noise a frame actually has is measured off its
    /// own pixels where the filters run (`image::measure_noise`), which is why nothing on
    /// this side needs its ISO.
    pub denoise_luma: f64,
    pub denoise_chroma: f64,
    pub sharpen: f64,
    /// How hard to take the colour off a fringing edge (`raw_defringe`, §10.9). Longitudinal
    /// aberration is a focus difference rather than a magnification one, so the warp cannot
    /// reach it and this is the only stage that does.
    pub defringe: f64,
    pub grade: hdr::Grade,
    pub targets: Vec<Target>,
}

impl Job {
    /// Every stage's strength, as the library has them set.
    fn strengths(&self) -> Strengths {
        Strengths {
            luma: self.denoise_luma,
            chroma: self.denoise_chroma,
            sharpen: self.sharpen,
            defringe: self.defringe,
        }
    }
}

/// What the caller gets back. Never pixels: a stacking descriptor is a 2.6kB
/// summary, and everything else this job produces is a file on disk.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// Only from a grid tile, that being the one pass every photo makes exactly once
    /// whatever its library builds from (19.3). Bytes rather than a string, which
    /// `serde_json` renders as an array of numbers - small enough at 2.6kB, and it
    /// saves a base64 decode on the other side.
    pub descriptor: Option<Vec<u8>>,
}

/// libvips' AVIF effort, inverted into libavif's speed at the encode (10.1).
const AVIF_EFFORT: i32 = 0;

/// The largest SDR or HDR size this job asks for, or None when it asks for neither.
///
/// 0 (native) beats any bounded size, being the whole frame.
fn largest_size(targets: &[Target], hdr: bool) -> Option<u32> {
    let wanted: Vec<&Target> = targets.iter().filter(|target| target.hdr == hdr).collect();
    if wanted.is_empty() {
        return None;
    }
    match wanted.iter().any(|target| target.size == 0) {
        true => Some(0),
        false => wanted.iter().map(|target| target.size).max(),
    }
}

fn encode_options(job: &Job, target: &Target, output_path: &str) -> EncodeOptions {
    EncodeOptions {
        still_chroma: match target.still_full_chroma {
            true => Chroma::Yuv444,
            false => Chroma::Yuv420,
        },
        output_path: output_path.to_string(),
        grade: job.grade,
        crf: target.hdr_quantizer,
        preset: target.preset,
        strengths: job.strengths(),
        max_edge: match target.size {
            0 => f64::INFINITY,
            size => f64::from(size),
        },
    }
}

/// The SDR base every render-sourced rendition is written from.
///
/// Built at the largest SDR size the job asks for, with the camera match applied, so
/// a smaller rendition is a resize of this rather than its own warp and re-grade of
/// the same picture. Legitimate because the order does not change the result: the
/// colour transform is a per-pixel lookup, and the distortion and the falloff are
/// both in radii normalised to the half-diagonal, so none of the three depends on
/// resolution.
///
/// Takes the decode by value and returns the base, so the decode is dropped here the
/// moment it is no longer the thing being read. That is what the worker's explicit
/// `release` call did, and it is now what ownership does on its own.
///
/// The sharpen is last, on the frame at the size it will be encoded at. Output
/// sharpening puts back acutance the resample took off, so it belongs after the
/// resample rather than before it, and after the warp for the same reason.
///
/// "The size it will be encoded at" holds because the base is built at the *largest*
/// SDR size the job asks for and every job the service builds names one target. A job
/// naming two would write the smaller one at the larger one's size: `save_avif_frame`
/// encodes what it is handed. So a second SDR target wants a copy of the base per
/// target, each resized before this sharpen rather than after it.
///
/// **Only the sharpen runs here.** The denoise and the defringe already ran, on the decode
/// and before the fit, for the reasons recorded at that call site: the fit has to be
/// calibrated against the frame it will be applied to, or it restores none of the colour
/// the denoise removed and the lateral tier corrects a fringe the defringe removes as well.
///
/// The sharpen stays on this side of the warp because it is a Richardson-Lucy
/// deconvolution *of the resample's own blur*. Ahead of the warp it inverts a point spread
/// that has not been applied yet and is then softened by the warp applying it - measured
/// at 17.68 acutance here against 16.38 there, on a frame whose untouched acutance is
/// 17.98.
///
/// **The defringe and the lateral warp remove the same error**, which is why the order of
/// those two is not free either. Measured on IMG_8408, in fringe around point sources: the
/// raw render carries 98.48, the defringe alone takes it to 4.22, the warp alone to 20.55.
/// Whichever runs second has to be cleaning up a residual - and it is the *fit* that makes
/// that true, by measuring the finished frame and declining a correction that is no longer
/// needed. Apply a curve fitted against the raw render to a defringed frame and it
/// overshoots to 84.44. That the warp is the whole of that was checked rather than
/// assumed: with the lateral half of the match switched off the same arrangement lands at
/// 6.66, so the colour transform accounts for 4.22 to 6.66 and the warp for the rest.
fn render_base(
    mut decoded: Frame,
    profile: Option<&fit::Profile>,
    sharpen: f64,
) -> Result<Frame, String> {
    // A frame with no match asks for no new frame at all, and allocating one to answer
    // that would be a 190MB no-op - so the sharpen runs where the frame already lies.
    let Some(profile) = profile else {
        let (width, height) = (decoded.width, decoded.height);
        let data = decoded.rgb8_mut().ok_or("the SDR base needs an 8-bit decode")?;
        crate::image::finish(data, width, height, Strengths { sharpen, ..Default::default() });
        return Ok(decoded);
    };

    let source = decoded.rgb8().ok_or("the SDR base needs an 8-bit decode")?;
    let mut built = fit::apply(source, profile);
    let strengths = Strengths { sharpen, ..Default::default() };
    crate::image::finish(&mut built.data, built.width, built.height, strengths);
    Ok(Frame::new(built.width, built.height, crate::frame::Pixels::Eight(built.data)))
}

/// Writes one SDR rendition, and describes it for stacking where it is the tile.
///
/// Every grid tile arrives with `Source::Embedded` whatever the library is set to -
/// the service decides that, not the library's `rendition_source`, which governs the
/// photo viewer alone (10.1). So the embedded branch is the grid's normal path and
/// the base is its fallback, reached only by a file with no usable JPEG preview.
fn write_sdr(
    job: &Job,
    target: &Target,
    base: &mut Option<Frame>,
    make_base: &mut dyn FnMut() -> Result<Frame, String>,
    outcome: &mut Outcome,
) -> Result<(), String> {
    let describe = target.rendition == Rendition::Grid;

    if target.source == Source::Embedded {
        // Extracted, decoded and shrunk inside one call, so the preview - which is
        // full resolution on a 61MP body, 5-14MB of JPEG - is never held whole.
        if let Some(preview) = crate::decode_embedded_frame(&job.raw_file_path, target.size) {
            save_avif(&preview, target)?;
            if describe {
                outcome.descriptor = describe_for_stacking(&preview);
            }
            return Ok(());
        }
    }

    if base.is_none() {
        *base = Some(make_base()?);
    }
    let built = base.as_ref().expect("just built");
    save_avif(built, target)?;
    if describe {
        outcome.descriptor = describe_for_stacking(built);
    }
    Ok(())
}

/// Never fatal. A descriptor is what stacking would like, not what the import owes,
/// and a photo without one is simply not a candidate.
fn describe_for_stacking(image: &Frame) -> Option<Vec<u8>> {
    image.rgb8().map(stacks::describe)
}

fn save_avif(image: &Frame, target: &Target) -> Result<(), String> {
    let source = image.rgb8().ok_or("an SDR rendition needs an 8-bit frame")?;
    crate::save_avif_frame(
        source,
        target.sdr_quantizer,
        AVIF_EFFORT,
        target.sdr_full_chroma,
        &target.output_path,
    )
}

/// Everything one photo owes, in the order that shares the most work.
///
/// Ordinary Rust scoping does what the worker's `open` list and its `finally` used
/// to: a decode lives in a local, is borrowed by whatever needs it, and is dropped
/// when nothing does. There is no list to forget to add to and no `finally` to skip,
/// which were two of the three ways the old shape could leak a 366MB frame.
pub fn run(job: &Job) -> Result<Outcome, String> {
    let mut outcome = Outcome::default();

    let renders_sdr = job.targets.iter().any(|t| !t.hdr && t.source == Source::Render);
    let renders_hdr = job.targets.iter().any(|t| t.hdr);
    let sdr_size = largest_size(&job.targets, false).unwrap_or(0);
    let hdr_size = largest_size(&job.targets, true).unwrap_or(0);

    // Fitted once, before anything is written: every rendition of one photo has to
    // get the same transform, and the render has to match the camera's JPEG the grid
    // tile is made of, or a photo changes appearance when it is opened.
    //
    // Gated on a target that actually demosaics: an embedded-source grid already has
    // the camera's look, so fitting for it would decode a 60MP frame to transform
    // nothing.
    let mut profile: Option<fit::Profile> = None;
    let mut decoded: Option<Frame> = None;
    if renders_sdr {
        let decoded_frame = crate::decode_frame(&job.raw_file_path, 8, false, sdr_size)
            .ok_or("could not decode the RAW")?;
        // **Resized here, not in `render_base`, and that is load-bearing.**
        // `at_least_long_edge` only gates a single halving, so an 8-bit decode comes back
        // at whatever LibRaw produced - 6000px for a 24MP body asked for 3840. Every knob
        // below is in pixels of the frame it reads: the chroma denoise's radii of 4 and
        // 32, `DEFRINGE_RADIUS`, `DEFRINGE_SPREAD`, and `DEFRINGE_EDGE`, which is a
        // per-pixel gradient. Run them on the decode and a 24MP frame puts 2.4x the pixels
        // through both guided filters *and* rescales what every one of those constants
        // means - the coarse chroma radius exists to reach a 40-pixel blotch, and at 2.4x
        // the linear scale that blotch is 98 pixels and out of its reach again.
        let mut frame = match sdr_size > 0
            && decoded_frame.width.max(decoded_frame.height) > sdr_size as usize
        {
            false => decoded_frame,
            true => {
                let source = decoded_frame.rgb8().ok_or("the SDR base needs an 8-bit decode")?;
                let resized = crate::image::resize_to_fit(source, sdr_size as usize);
                Frame::new(resized.width, resized.height, crate::frame::Pixels::Eight(resized.data))
            }
        };
        // **The denoise and the defringe run before the fit, so the fit sees the frame it
        // will actually be applied to.** Fitted against the raw render instead, the colour
        // transform is calibrated on colour the denoise then removes and nothing puts back
        // - measured at 22% of mean chroma - and the lateral tier measures a fringe the
        // defringe then removes as well, so the two correct it twice and overshoot. Fitted
        // here, the transform is asked to restore what the denoise took, and the lateral
        // tier finds nothing left and declines on its own (§10.9).
        //
        // The sharpen is not in this pass. It is a deconvolution of the resample's own
        // blur, so it belongs after the warp that does the resampling, and it runs at the
        // end of `render_base` instead. Splitting the two is also *cheaper* than one pass:
        // run together, the sharpen has to carry the chroma denoise's radius-32 halo
        // through `strip_interior`, which cuts the strips far shorter than the
        // deconvolution alone needs. Measured on a 24MP frame, 4.99s wall and 32.4s CPU
        // together against 4.43s and 26.9s split, at the same peak memory.
        let (width, height) = (frame.width, frame.height);
        let data = frame.rgb8_mut().ok_or("the SDR base needs an 8-bit decode")?;
        crate::image::finish(data, width, height, job.strengths().before_the_fit());
        if job.match_embedded_jpeg {
            profile = crate::fit_profile_for(&frame, &job.raw_file_path);
        }
        decoded = Some(frame);
    }

    // The scene-linear decode, shared the same way: an HDR job builds a still and its
    // video twin from one of these, and the colour fit reads the same samples again.
    let mut linear: Option<Frame> = None;
    let mut matched: Option<crate::hdr_fit::HdrMatch> = None;
    if renders_hdr {
        let frame = crate::decode_frame(&job.raw_file_path, 16, true, hdr_size)
            .ok_or("could not decode the RAW scene-linear")?;
        if job.match_embedded_jpeg {
            matched = crate::fit_hdr_for(
                &frame,
                &job.raw_file_path,
                job.grade.white_quantile,
                profile.as_ref(),
                job.strengths().before_the_fit(),
            );
        }
        linear = Some(frame);
    }

    // Which rendition is each decode's last reader, so it can hand the pixels back
    // before the encode rather than after the job.
    let last_hdr = job.targets.iter().rposition(|target| target.hdr);
    let mut base: Option<Frame> = None;

    for (index, target) in job.targets.iter().enumerate() {
        if target.hdr {
            let options = encode_options(job, target, &target.output_path);
            // The last HDR rendition hands its decode over rather than lending it, so
            // 366MB of scene-linear samples go back before the encode allocates
            // anything. Anything earlier keeps it, having another rendition to write.
            let decode = match Some(index) == last_hdr {
                true => hdr::Decode::Owned(linear.take().ok_or("an HDR target with no decode")?),
                false => {
                    let frame = linear.as_ref().ok_or("an HDR target with no decode")?;
                    let samples = frame.samples16().ok_or("the HDR encode needs a 16-bit decode")?;
                    hdr::Decode::Borrowed(hdr::Source {
                        samples,
                        width: frame.width,
                        height: frame.height,
                    })
                }
            };
            hdr::encode_still(decode, &options, matched.as_ref())?;
            continue;
        }

        let mut make_base = || {
            let frame = decoded.take().ok_or("an SDR render target with no decode")?;
            // The denoise and the defringe already ran, on the decode and before the fit.
            render_base(frame, profile.as_ref(), job.sharpen)
        };
        write_sdr(job, target, &mut base, &mut make_base, &mut outcome)?;
    }

    Ok(outcome)
}
