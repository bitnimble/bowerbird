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
// **There is one rendering pipeline, and SDR is an output stage of it.** Everything
// internal is one 16-bit base through one grade; a rendition's dynamic range reaches
// only the peak that grade rolls into and the transfer and depth of the buffer that leaves.
// There used to be a second path - an 8-bit sRGB decode, `fit::apply`, and no tone map at
// all - and it was slower and larger both: measured on a 3840px Sony rendition, 1805ms and
// 376MB against 1722ms and 341MB, because the linear path already fits during the decode
// where the 8-bit one resized afterwards.
//
// The ordering is the worker's and the reasons come with it: one decode shared by the fit
// and every rendition, one camera match and one filter pass per photo rather than one per
// rendition, and everything that does not depend on a target's size or its display settled
// before the loop over them.

use crate::hdr;
use crate::hdr_args::{self, Chroma, EncodeOptions};
use crate::image::Strengths;
use crate::stacks;
use crate::tone;
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

/// Where a rendition's highlights roll into, and what codes the result.
///
/// **The only thing a rendition's dynamic range reaches inside the pipeline.** Everything
/// upstream is one 16-bit render; this says which peak the BT.2390 roll-off
/// targets and what the buffer is coded as on the way out. Named rather than a `hdr: bool`
/// so a job reads as one render with a list of outputs, and so a third coding is additive.
#[derive(Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Output {
    /// The grade's `peak_nits`, PQ, 10-bit.
    Pq,
    /// Diffuse white, sRGB primaries and transfer, 8-bit.
    Srgb,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub rendition: Rendition,
    pub output: Output,
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

/// The largest size any of these targets asks for.
///
/// 0 (native) beats any bounded size, being the whole frame. One number rather than one per
/// dynamic range, now that one decode serves both.
fn largest_size(targets: &[&Target]) -> u32 {
    match targets.iter().any(|target| target.size == 0) {
        true => 0,
        false => targets.iter().map(|target| target.size).max().unwrap_or(0),
    }
}

/// What this target is encoded as, and at what size.
///
/// `still_chroma` reads whichever setting covers this rendition, because the sizing depends
/// on it: 4:2:0 has no odd dimensions. It is one rule for both ranges rather than the two
/// the split pipeline had - the SDR path used to size with `resize_to_fit`, which rounds
/// down without regard to what the encoder can carry.
fn encode_options(job: &Job, target: &Target, output_path: &str) -> EncodeOptions {
    let full_chroma = match target.output {
        Output::Pq => target.still_full_chroma,
        Output::Srgb => target.sdr_full_chroma,
    };
    EncodeOptions {
        still_chroma: match full_chroma {
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

/// Where the grade rolls this target's highlights into.
///
/// The only thing a rendition's dynamic range reaches inside the pipeline. An SDR render is
/// the same grade with the peak at diffuse white, so everything above it rolls off into
/// white through the same BT.2390 curve instead of clipping there.
fn peak_nits(job: &Job, target: &Target) -> f64 {
    match target.output {
        Output::Pq => job.grade.peak_nits,
        Output::Srgb => job.grade.reference_white_nits,
    }
}

/// Never fatal. A descriptor is what stacking would like, not what the import owes,
/// and a photo without one is simply not a candidate.
fn describe_if_grid(image: crate::rgb::RgbRef<'_>, target: &Target, outcome: &mut Outcome) {
    if target.rendition == Rendition::Grid {
        outcome.descriptor = Some(stacks::describe(image));
    }
}

fn save_avif(image: crate::rgb::RgbRef<'_>, target: &Target) -> Result<(), String> {
    crate::save_avif_frame(
        image,
        target.sdr_quantizer,
        AVIF_EFFORT,
        target.sdr_full_chroma,
        &target.output_path,
    )
}

/// The photo, carried as far as no rendition's size or display can take it.
///
/// Everything here is measured or fitted against the whole frame and would be the same
/// answer for every target, so it is settled once: the decode, the levels the grade anchors
/// to, the coding, the camera match, and the denoise. What is left per target is the resize,
/// the warp, and then one dispatch carrying the colour transform, the roll-off into that
/// display's peak and the transfer - followed by the encode.
struct Base {
    /// Normalised PQ Rec.2020 (`tone::encode_base`), denoised and defringed, at the largest
    /// size any target wants.
    samples: Vec<u16>,
    width: usize,
    height: usize,
    /// The frame's own diffuse white and scene peak, off the *unresized* decode.
    levels: tone::Levels,
    matched: Option<crate::hdr_fit::HdrMatch>,
}

impl Base {
    fn build(job: &Job, size: u32) -> Result<Base, String> {
        let frame = crate::decode_frame(&job.raw_file_path, 16, true, size)
            .ok_or("could not decode the RAW scene-linear")?;
        let (width, height) = (frame.width, frame.height);

        // Fitted once, before anything is written: every rendition of one photo has to get
        // the same transform, and the render has to match the camera's JPEG the grid tile is
        // made of, or a photo changes appearance when it is opened.
        //
        // Off the linear decode alone, with no geometry handed in: `fit_all` resolves both
        // halves in one pass over it, which is what an SDR fit's 431ms bought separately
        // when there was an 8-bit render to fit against. It reads the frame *before* the
        // filter below, because the geometry search runs `image::finish` on its own
        // downscaled render - calibrated at that scale, which this frame is not at.
        let matched = match job.match_embedded_jpeg {
            true => crate::fit_hdr_for(
                &frame,
                &job.raw_file_path,
                job.grade.white_quantile,
                None,
                job.strengths().before_the_fit(),
            ),
            false => None,
        };

        let mut samples = frame
            .into_samples16()
            .ok_or("the render needs a 16-bit scene-linear decode")?;
        let levels = tone::levels(&samples, job.grade.white_quantile);
        // Read off the levels and coded against them, once, here. Everything below this line
        // - the filters, the resize, the warp, the shader - reads normalised PQ rather than
        // sensor levels, and `tone::encode_base` says what that buys.
        tone::encode_base(&mut samples, levels.white, job.grade.reference_white_nits);
        // Ahead of every warp and every resize, which is where the denoise belongs and the
        // sharpen does not (`hdr::filter_base`). At the decode's size, which is the largest
        // any target asked for: the chroma denoise's radii and the defringe's constants are in
        // pixels of the frame they read, so this is the one size at which they mean what they
        // were tuned to mean.
        hdr::filter_base(&mut samples, width, height, job.strengths().before_the_fit());
        Ok(Base { samples, width, height, levels, matched })
    }
}

/// Everything one photo owes, in the order that shares the most work.
///
/// Ordinary Rust scoping does what the worker's `open` list and its `finally` used
/// to: a decode lives in a local, is borrowed by whatever needs it, and is dropped
/// when nothing does. There is no list to forget to add to and no `finally` to skip,
/// which were two of the three ways the old shape could leak a 366MB frame.
pub fn run(job: &Job) -> Result<Outcome, String> {
    let mut outcome = Outcome::default();

    // The camera's own JPEG, where a target asks for it. No decode, no fit and no grade,
    // which is where the real speed of a grid tile lives - 124ms against a render's 1.7s.
    // That is a different *source*, not a different pipeline, and it is the only thing the
    // unification left alone.
    //
    // Every grid tile arrives with `Source::Embedded` whatever the library is set to: the
    // service decides that, not the library's `rendition_source`, which governs the photo
    // viewer alone (10.1). A file with no usable preview falls through to the render below,
    // which it could not do while the decode was gated on some *other* target wanting one.
    let mut rendered: Vec<&Target> = Vec::new();
    for target in &job.targets {
        if target.source == Source::Embedded && target.output == Output::Srgb {
            // Extracted, decoded and shrunk inside one call, so the preview - which is
            // full resolution on a 61MP body, 5-14MB of JPEG - is never held whole.
            if let Some(preview) = crate::decode_embedded_frame(&job.raw_file_path, target.size) {
                let image = preview.rgb8().ok_or("an embedded preview decodes to 8-bit")?;
                save_avif(image, target)?;
                describe_if_grid(image, target, &mut outcome);
                continue;
            }
        }
        rendered.push(target);
    }
    if rendered.is_empty() {
        return Ok(outcome);
    }

    let Base { samples, width, height, levels, matched } =
        Base::build(job, largest_size(&rendered))?;
    let lens = matched.as_ref().map(|m| &m.lens);

    // Largest first, so every smaller rendition is a downscale of one already cut rather
    // than its own resize, its own warp table and its own dispatch over the colour transform.
    let mut order: Vec<(&Target, hdr_args::Size)> = rendered
        .iter()
        .map(|target| {
            let options = encode_options(job, target, &target.output_path);
            (*target, hdr_args::target_size(width as u32, height as u32, &options))
        })
        .collect();
    order.sort_by_key(|(_, size)| {
        std::cmp::Reverse(u64::from(size.width) * u64::from(size.height))
    });

    // **The grade is the shaders the editor runs, and there is nothing to fall back to.** The
    // tick has to be WGSL because it runs in a browser, so the choice was ever a second
    // implementation in Rust or this - and DESIGN 21.1 records what the second one cost: the
    // editor lost the camera match twice, silently, to two implementations drifting. A
    // machine with no adapter at all therefore builds no renditions rather than building
    // different ones. `gpu::device` asks for a software adapter where there is no hardware,
    // so that means no Vulkan whatsoever rather than merely no GPU.
    let gpu = crate::gpu::device().ok_or(
        "no GPU adapter of any kind, so the grade cannot run - the shaders are its only \
         implementation. Install a Vulkan driver; lavapipe will do, slowly",
    )?;

    // The scene, settled once: the camera's colour and the top end every rendition rolls off
    // against. An input to the grade rather than part of it, which is why the peak is
    // measured here and handed to the shader - two renditions of one photo measuring it
    // separately would compress their highlights by different amounts, the same drift
    // `tone::levels` exists to prevent at the other end of the range.
    //
    // White is floored rather than refused. A frame whose quantile lands on level 0 is a lens
    // cap or a failed exposure, and the grade divides by this; at a white of 1 it still
    // renders all but black, where refusing would fail a photograph that imported before.
    let anchored = tone::Levels { white: levels.white.max(1.0), peak: levels.peak.max(1.0) };
    let scene = tone::SceneGrade::new(
        gpu,
        &samples,
        matched.as_ref().map(|m| &m.colour),
        anchored,
        job.grade.reference_white_nits,
        1.0,
    )
    .ok_or("the frame has no exposure to grade against")?;

    // Cut once off the base, sharpened once, and the base handed back before anything is
    // encoded - 366MB of samples at 61MP, released across the longest stage of the job.
    // Nothing below reads it: a smaller rendition comes out of the cut.
    let mut cut = {
        let source = hdr::Source { samples: &samples, width, height };
        let mut built = hdr::Cut::from_base(&source, lens, order[0].1);
        built.sharpen(job.sharpen);
        built
    };
    drop(samples);

    // **The frame goes up once per size, not once per rendition.** Two outputs of one size
    // differ by two words of a uniform; uploading 59MB at 3840 - 366MB at native - and
    // rebuilding the lattice, the curves and the output pair for each of them was most of
    // what a second target cost.
    let mut uploaded: Option<crate::gpu::Uploaded<'_>> = None;
    for (index, (target, size)) in order.iter().enumerate() {
        let want = (size.width as usize, size.height as usize);
        if (cut.width, cut.height) != want {
            cut = cut.downscale(*size);
            uploaded = None;
        }
        let options = encode_options(job, target, &target.output_path);
        let output = match target.output {
            Output::Pq => crate::gpu::Output::Pq,
            Output::Srgb => crate::gpu::Output::Srgb,
        };
        let grade = scene.gpu_grade(cut.width, cut.height, peak_nits(job, target), output);
        let up = match &uploaded {
            Some(up) => up,
            None => uploaded.insert(gpu.upload(&cut.samples, &grade)),
        };
        // **The cut is handed back once it is on the GPU**, which is 366MB at native
        // resolution released across the longest stage of the job. Only two things ever read
        // it - the upload above and a smaller rendition's `downscale` - so once every target
        // left wants this same size, and the upload it is already in, nothing does. At native
        // that is one target and the whole of the cut, and it is the difference between
        // holding it beside the graded frame through the AVIF encode and not.
        if order[index + 1..].iter().all(|(_, later)| later == size) {
            cut.samples = Vec::new();
        }
        // Colour, roll-off and transfer, in one dispatch, from the frame the editor would
        // have handed the same shader.
        let frame = up.encode(&grade);
        write(frame, cut.width, cut.height, target, &options, &mut outcome)?;
    }

    Ok(outcome)
}

/// The transfer and the encode: all a rolled rendition has left.
fn write(
    frame: Vec<u16>,
    width: usize,
    height: usize,
    target: &Target,
    options: &EncodeOptions,
    outcome: &mut Outcome,
) -> Result<(), String> {
    // The transfer already ran, in the same dispatch as the grade (`frame.wgsl::encode`), so
    // there is nothing left here but handing the bytes to an encoder.
    match target.output {
        Output::Pq => {
            hdr::encode_pq_frame(frame, width, height, options)?;
        }
        Output::Srgb => {
            // Eight bits, delivered in the low byte of each count because the shader writes
            // one buffer whatever the output is.
            let data: Vec<u8> = frame.iter().map(|v| *v as u8).collect();
            drop(frame);
            let image = crate::rgb::RgbRef { width, height, data: &data };
            save_avif(image, target)?;
            describe_if_grid(image, target, outcome);
        }
    }
    Ok(())
}

