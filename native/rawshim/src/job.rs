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
    /// One tile of the photograph rather than the whole of it: `[left, top, width, height]` in
    /// the decoded image's own pixels.
    ///
    /// **What the loupe is served with.** `params.cropbox` restricts the demosaic's own work
    /// rather than trimming its output and the mosaic denoise takes a window, so a tile costs an
    /// unpack and two small pieces of work - measured at 109ms for a 400px tile of a 24MP CR3
    /// against 3.1 seconds for the frame. Nothing is kept between requests, which is what makes
    /// a tile a pure function of this job: there is no cache to invalidate when a slider moves.
    #[serde(default)]
    pub tile: Option<[usize; 4]>,
    /// The whole frame's noise, for a tile that would otherwise measure its own.
    ///
    /// Only a tile reads it: a whole-frame decode fits the same thing itself, and better, because
    /// it has the frame. Absent means "measure it", which is what every caller but the editor's
    /// loupe wants and what a client too old to send it gets.
    #[serde(default)]
    pub noise_fit: Option<crate::galosh::NoiseFit>,
    /// The whole frame's diffuse white and scene peak, for a tile that would otherwise read its
    /// crop's.
    ///
    /// Only a tile reads it, and for the reason `noise_fit` above is here: everything downstream
    /// is coded and graded against these two numbers, and a crop's own quantile is a property of
    /// where the reader is pointing rather than of the photograph. A dark corner of the fixture
    /// reads a diffuse white a third of the frame's, so a loupe over it lifted the crop to
    /// reference white and rolled nothing.
    #[serde(default)]
    pub levels: Option<tone::Levels>,
    /// The whole frame's scene peak in nits, as the editor's tick measured it, for a tile whose
    /// crop reaches nowhere near it.
    ///
    /// The third thing only a tile is handed, and the last of the three: it is what the highlight
    /// roll-off compresses into the display, measured on the GPU through the whole colour
    /// transform, so a crop measuring its own rolls a different curve from the picture the loupe
    /// is held over. Unlike the other two it moves with the reader's edits, which is why it comes
    /// per request rather than once at the open.
    #[serde(default)]
    pub scene_peak: Option<f64>,
    /// This photograph's camera match, if the caller has one stored (`crate::camera_match`).
    ///
    /// Fitting it is half a second and depends on nothing but the file, so a caller that keeps
    /// it hands it back rather than paying again. A blob this build cannot read is ignored and
    /// the fit is done the slow way, which is what every job did before this existed.
    #[serde(default)]
    pub camera_match: Option<Vec<u8>>,
    /// The Detail panel's two sliders, 0 to 100, exactly as `EditDoc` stores them (§10.9).
    ///
    /// They drive the denoise on the *mosaic*, inside the decode (`crate::galosh`), which
    /// is why they are on the job rather than on a target: every rendition is cut from one
    /// decode, so they could not differ between targets even if a caller asked.
    ///
    /// Nothing is scaled here or on the way in. How much noise the frame has is fitted off
    /// its own photosites, which is why neither side needs its ISO.
    pub denoise_luminance: f64,
    pub denoise_colour: f64,
    /// The fraction of the deconvolution to blend in (`raw_sharpen`, §10.9).
    pub sharpen: f64,
    /// How hard to take the colour off a fringing edge (`raw_defringe`, §10.9). Longitudinal
    /// aberration is a focus difference rather than a magnification one, so the warp cannot
    /// reach it and this is the only stage that does.
    pub defringe: f64,
    /// The photographer's own exposure, **in stops**, exactly as `EditDoc` stores it.
    ///
    /// The document's own unit, carried to the shader untouched. It used to be the `2^EV` gain,
    /// converted on the way in here and again in the editor's `writeUniform` - one rule with an
    /// implementation on each path, and the kind that fails silently because both answers are
    /// plausible exposures. `colour.wgsl` raises it now, once, for both.
    ///
    /// Defaults to 0 - no change - so a photo nobody has edited grades exactly as it did, and a
    /// caller that knows nothing about edits can leave the field out entirely.
    #[serde(default)]
    pub exposure: f64,
    /// The reader's tonal and colour sliders, on Camera Raw's -100..100 scales.
    ///
    /// Defaulted whole, so a caller that knows nothing about edits sends no field and gets
    /// the picture as the camera rendered it.
    #[serde(default)]
    pub adjust: crate::gpu::Adjust,
    /// The reader's crop, straighten and quarter turn.
    ///
    /// Applied in the cut's own gather rather than as a pass of its own, so a crop costs a
    /// smaller output instead of a second copy of the frame.
    #[serde(default = "upright")]
    pub geometry: crate::image::Geometry,
    pub grade: hdr::Grade,
    pub targets: Vec<Target>,
}


/// Serde's default for [`Job::geometry`]: the whole frame, as the camera framed it.
fn upright() -> crate::image::Geometry {
    crate::image::Geometry::none()
}

impl Job {
    /// The denoise, in the units its kernels read.
    fn amounts(&self) -> crate::galosh::Amounts {
        crate::galosh::Amounts::from_sliders(self.denoise_luminance, self.denoise_colour)
    }

    /// Every stage's strength, as the library has them set.
    fn strengths(&self) -> Strengths {
        Strengths {
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
    /// The camera match this job fitted, where it had to fit one.
    ///
    /// Absent when the caller supplied a usable one, so its presence means "this is new, keep
    /// it" rather than "here it is again". Bytes for the same reason the descriptor beside it
    /// is: `serde_json` renders them as numbers, and 5kB saves a base64 decode on the far side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_match: Option<Vec<u8>>,
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
pub(crate) struct Base {
    /// Normalised PQ Rec.2020 (`tone::encode_base`), denoised and defringed, at the largest
    /// size any target wants.
    pub(crate) samples: Vec<u16>,
    pub(crate) width: usize,
    pub(crate) height: usize,
    /// The frame's own diffuse white and scene peak, off the *unresized* decode, and the pair
    /// the samples above were coded against.
    pub(crate) levels: tone::Anchored,
    pub(crate) matched: Option<crate::hdr_fit::HdrMatch>,
    /// The match this build had to fit, for the caller to keep. None where it supplied one.
    pub(crate) fitted_now: Option<Vec<u8>>,
    /// The illuminant the decode balanced against, which the stored temperature and tint move
    /// away from. Read off the processor and carried, because the decode is the only place it
    /// exists.
    pub(crate) as_shot: Option<crate::white_balance::AsShot>,
    /// For a tile, where the rectangle asked for sits inside the larger one decoded for it.
    asked: Option<Grown>,
}

impl Base {
    pub(crate) fn build(job: &Job, size: u32) -> Result<Base, String> {
        // Denoised inside the decode, on the mosaic, which is the only place the noise is
        // still one photosite's own (`crate::galosh`).
        //
        // A tile takes the same route with the demosaic and the denoise both restricted to it,
        // and at the sensor's own scale: a loupe is magnifying, so fitting the tile to a size
        // would throw away the pixels it exists to show.
        // Refused rather than falling through to the whole frame: a tile that cannot be placed in
        // its photograph is a magnifier of nothing, and decoding 24 megapixels to answer a request
        // for a few hundred thousand is the one mistake this route exists to avoid.
        let asked = job.tile.map(|tile| grown(job, tile)).transpose()?;
        let frame = match &asked {
            // `job.noise_fit` is the frame's, measured at the editor's open and handed back with
            // the request: a tile that fits its own is denoised at its own crop's strength rather
            // than the photograph's, which is a loupe that disagrees with the export it exists to
            // predict and changes as the reader pans. Refused rather than trusted where it does
            // not describe a sensor, since it crosses the API from a client.
            Some(grown) => crate::decode_tile(
                &job.raw_file_path,
                grown.decode,
                16,
                true,
                job.amounts(),
                job.noise_fit
                    .filter(crate::galosh::NoiseFit::usable)
                    .map_or(crate::galosh::Fit::Measure, crate::galosh::Fit::Given),
                // The rendition's, not the editor's, though a loupe is an editor feature: what it
                // is for is showing what the export will be, and a magnifier denoised to a
                // different standard from the export is one that lies.
                crate::RENDITION_TILE_HALO,
            ),
            None => {
                crate::decode_frame_denoised(&job.raw_file_path, 16, true, size, job.amounts())
            }
        }
        .ok_or("could not decode the RAW scene-linear")?;
        let (width, height) = (frame.width, frame.height);
        // What came back is the rectangle that was asked for, or nothing is: `decode_tile` trims
        // its region to whole CFA sites and takes the trim off the *far* edge, so a region flush
        // against the sensor's own can come back a pixel short - and everything below is sized
        // from the window rather than from this, down to the buffer the GPU is handed. Refused
        // rather than corrected, because a tile one pixel narrower than the reader asked for is
        // not the rectangle the glass is drawing.
        if let Some(grown) = &asked {
            if (width, height) != (grown.decode.width, grown.decode.height) {
                return Err(format!(
                    "the decoder answered {width}x{height} for a {}x{} region",
                    grown.decode.width, grown.decode.height,
                ));
            }
        }

        // Fitted once, before anything is written: every rendition of one photo has to get
        // the same transform, and the render has to match the camera's JPEG the grid tile is
        // made of, or a photo changes appearance when it is opened.
        //
        // Off the linear decode alone, with no geometry handed in: `fit_all` resolves both
        // halves in one pass over it, which is what an SDR fit's 431ms bought separately
        // when there was an 8-bit render to fit against. It reads the frame *before* the
        // filter below, because the geometry search runs `image::finish` on its own
        // downscaled render - calibrated at that scale, which this frame is not at.
        let (matched, fitted_now) = match job.match_embedded_jpeg {
            true => matched_for(job, &frame),
            false => (None, None),
        };

        let as_shot = frame.as_shot;
        let mut samples = frame
            .into_samples16()
            .ok_or("the render needs a 16-bit scene-linear decode")?;
        // Floored here and carried, so the white the frame is *coded* against and the white
        // the shader is told about are one number rather than two computed alike.
        //
        // The editor's, where a tile was handed them: a quantile of a crop describes where the
        // reader is pointing rather than the photograph, so a tile measuring its own is graded
        // against a white that changes as the loupe moves - and over anything dark, against one
        // far below the frame's, which lifts the crop to reference white. Refused rather than
        // trusted where they do not describe a frame, since they cross the API from a client.
        let levels = match job.levels.filter(|_| job.tile.is_some()).filter(tone::Levels::usable) {
            Some(given) => given,
            None => tone::levels(&samples, job.grade.white_quantile),
        }
        .anchored();
        // Read off the levels and coded against them, once, here. Everything below this line
        // - the filters, the resize, the warp, the shader - reads normalised PQ rather than
        // sensor levels, and `tone::encode_base` says what that buys.
        //
        // Ahead of every warp and every resize, which is where the denoise belongs and the
        // sharpen does not (`hdr::filter_base`). At the decode's size, which is the largest
        // any target asked for: the chroma denoise's radii and the defringe's constants are in
        // pixels of the frame they read, so this is the one size at which they mean what they
        // were tuned to mean.
        //
        // Both on the GPU in one pass where there is one, over the frame the decode has already
        // left there (`base::prepare`, and `edit::open` takes the same route with the warp on the
        // end of it). No lens here: a rendition's warp is per target and happens further down,
        // so this is the coding and the defringe alone.
        let strengths = job.strengths().before_the_fit();
        let chained = crate::gpu::device().and_then(crate::base::device).and_then(|base| {
            let gpu = crate::gpu::device()?;
            crate::base::prepare(
                gpu,
                base,
                &samples,
                (width, height),
                (width, height),
                levels,
                job.grade.reference_white_nits,
                strengths,
                &crate::fit::Lens::none(),
            )
        });
        match chained {
            Some(prepared) => samples = prepared,
            None => {
                tone::encode_base(&mut samples, levels, job.grade.reference_white_nits);
                hdr::filter_base(&mut samples, width, height, strengths);
            }
        }
        Ok(Base { samples, width, height, levels, matched, as_shot, fitted_now, asked })
    }
}

/// What a tile request becomes: a region to decode, the window of the corrected frame to build
/// out of it, and where the rectangle actually asked for sits inside that window.
struct Grown {
    /// The part of the *uncorrected* frame to decode, which the lens decides.
    decode: crate::Tile,
    /// The window of the corrected frame to produce: `(left, top, width, height)` in the
    /// photograph's own pixels.
    window: (usize, usize, usize, usize),
    /// `[left, top, width, height]` of the asked-for tile within that window.
    keep: [usize; 4],
    /// The photograph the window is a piece of.
    frame: (usize, usize),
    /// Its lens, resolved once here so the footprint and the gather cannot disagree about
    /// whether there is one.
    lens: Option<crate::fit::Lens>,
}

/// How far past a tile the presence sliders read, in the photograph's pixels.
///
/// **The guided filter is two windows deep**, and both are fractions of the working texture the
/// blur is built on - so in the picture's own pixels the reach is that fraction of the whole
/// photograph, whatever size the frame holding it is. A tile without it fits its models against
/// an edge the photograph does not have, and the Clarity along the rim of the glass is a filter
/// looking at nothing.
///
/// Zero where none of the three is asked for, which is what most tiles are: this is four times
/// the decode for a 400px tile, and it buys nothing at all when the sliders are at rest.
fn presence_reach(job: &Job, frame: (usize, usize)) -> usize {
    let presence = [job.adjust.clarity, job.adjust.texture, job.adjust.dehaze];
    if presence.iter().all(|value| *value == 0.0) {
        return 0;
    }
    let long = frame.0.max(frame.1);
    let working = crate::gpu::detail_long(long);
    // Texels of the working texture, then back into the photograph's own pixels at the rate that
    // texture shrinks it by - rounded up, because a reach one pixel short is a filtered edge.
    crate::gpu::detail_reach(working) * long.div_ceil(working.max(1) as usize)
}

/// Everything a tile's rectangle implies, before anything is read off the disk.
///
/// **A tile is a rectangle of the corrected picture, not of the sensor.** That is what the client
/// names - its frame is `edit::open`'s, with the lens already materialised into it - and what a
/// rendition would write there. Two things follow, and neither was true before:
///
/// - The gather has to be the *frame's*, over this window ([`image::PlanarWarp::for_lens_window`]).
///   A crop warped as though it were the photograph corrects at the wrong radius and lifts its own
///   corners as if they were the frame's.
/// - What to decode is then whatever that window gathers *from*, which the warp itself answers.
///   The distortion moves a corner of a 24MP frame by tens of pixels, so the region is not the
///   window and cannot be assumed to be.
///
/// On top of that the window is grown by the reach of everything that runs after the gather. **A
/// deconvolution reads 42 pixels past what it writes** (`image::Strengths::halo`): the decode's
/// own halo is eaten by the demosaic and the mosaic denoise long before the sharpen, so a tile
/// built at exactly the rectangle asked for rings along all four edges - and the loupe's tile is
/// only half again its glass, so at high magnification that ringing is inside what the reader is
/// looking at. [`graded`] cuts the window back to `keep` once every one of those stages has run.
///
/// Refuses a rectangle that is not inside the photograph, and a file that will not say how large
/// the photograph is - which is the same case `decode_tile` declines, reported here because this
/// runs first and the two failures are not the same thing to read in a log.
fn grown(job: &Job, [left, top, width, height]: [usize; 4]) -> Result<Grown, String> {
    let header = crate::header::read_path(&job.raw_file_path)
        .ok_or("the file will not say how large the photograph is")?;
    let frame = (header.width as usize, header.height as usize);
    if left + width > frame.0 || top + height > frame.1 {
        return Err(format!(
            "a tile of {width}x{height} at {left},{top} is outside a {}x{} photograph",
            frame.0, frame.1,
        ));
    }
    // The stored match's, and only where this job would grade through one at all: `matched_for`
    // makes the same choice for the colour, and a footprint measured for a lens the gather then
    // does not apply would decode the wrong region.
    let lens = match job.match_embedded_jpeg {
        true => job
            .camera_match
            .as_deref()
            .and_then(crate::camera_match::decode)
            .map(|matched| matched.lens)
            .filter(|lens| !lens.is_identity()),
        false => None,
    };

    // **Added, not maxed: the two stages are sequential and each reads what the one before it
    // wrote.** The blur the presence sliders read is built from the *sharpened* window, so a kept
    // pixel needs every pixel the blur averages into it to be far enough inside the window that
    // the deconvolution had real context there - the blur's reach *plus* the sharpen's, not
    // whichever is larger. At `max` the outermost 42 pixels of the window are sharpened against a
    // clamped edge and the blur reads them, which is a tile that differs from its export in
    // exactly the case a reader is most likely to have set up: Clarity on a sharpened photograph.
    let reach = job.strengths().halo() + presence_reach(job, frame);
    // Down to a whole texel of the blur's working texture, which is what lets that texture be the
    // photograph's own texels rather than a set of its own between them (`gpu::detail_step`).
    let step = crate::gpu::detail_step(frame.0.max(frame.1)) as usize;
    let start = |value: usize| (value.saturating_sub(reach) / step) * step;
    let (window_left, window_top) = (start(left), start(top));
    let window = (
        window_left,
        window_top,
        (left + width + reach).min(frame.0) - window_left,
        (top + height + reach).min(frame.1) - window_top,
    );
    let keep = [left - window_left, top - window_top, width, height];

    // What that window reads. Built against the whole frame first because the answer is the
    // question - the gather has to exist before it can say what it gathers from - and it is a
    // couple of tables either way.
    let decode = match lens.as_ref().and_then(|lens| {
        crate::image::PlanarWarp::for_lens_window(
            frame,
            window,
            (0, 0, frame.0, frame.1),
            lens,
            crate::image::Sampling::Bicubic,
        )
    }) {
        Some(probe) => probe.footprint(),
        // Nothing to correct, so the window is its own region.
        None => window,
    };
    Ok(Grown {
        decode: crate::Tile { left: decode.0, top: decode.1, width: decode.2, height: decode.3 },
        window,
        keep,
        frame,
        lens,
    })
}

/// This photograph's camera match: the caller's, if it kept one, and otherwise a fresh fit for
/// it to keep - except for a tile, which can only be handed one.
///
/// **The fit costs half a second and depends on nothing but the file.** It decodes the embedded
/// JPEG, resamples it and fits a curve per channel against the render, and every path that
/// wants one pays for the same answer: a rendition job, a rebuild after an edit, the editor's
/// open, and worst of all the loupe, which asks for a tile every time the reader moves.
/// Measured on a 24MP CR3, a 400px tile is 660ms fitting it and 105ms handed one.
///
/// Nothing an edit touches is an input to it - not a crop, an exposure or a denoise amount -
/// so a stored match can only go stale by the photograph itself changing, and keying it is the
/// caller's business rather than this one's.
///
/// The second return is the blob to keep, and it is `None` when the caller supplied a usable
/// one: its presence means "this is new" rather than "here it is again", so a caller can write
/// it back without first asking whether it already had it.
fn matched_for(
    job: &Job,
    frame: &crate::frame::Frame,
) -> (Option<crate::hdr_fit::HdrMatch>, Option<Vec<u8>>) {
    // What the caller kept, if it kept one. Nothing is reported back in that case: the answer
    // it already has is the answer.
    if let Some(stored) = job.camera_match.as_deref() {
        if let Some(matched) = crate::camera_match::decode(stored) {
            return (Some(matched), None);
        }
    }
    // A crop cannot fit one, and must not try: `fit_all` resamples the whole embedded JPEG to
    // the frame it is given, so fitting against a tile compares a squashed picture of the entire
    // scene with a 400px piece of it. That produces a different match for every tile position -
    // the loupe changing grade as it moves - on top of matching neither the rendition nor the
    // editor. Ungraded is wrong in one consistent way, which is recoverable; this is not.
    if job.tile.is_some() {
        return (None, None);
    }
    let fitted = crate::fit_hdr_for(
        frame,
        &job.raw_file_path,
        job.grade.white_quantile,
        None,
        job.strengths().before_the_fit(),
    );
    let keep = fitted.as_ref().map(crate::camera_match::encode);
    (fitted, keep)
}

/// A loupe is judging grain at 1:1, so it is encoded at the quality the `max` rendition is
/// rather than the one the viewing sizes are: the artefacts a reader is looking for have to be
/// the photograph's rather than the encoder's.
const TILE_QUANTIZER: i32 = 4;

// Fastest libaom will go. A tile is looked at once and thrown away, and it is on the reader's
// critical path where a rendition's encode is not - at 400px the quantizer above is what decides
// how it looks, and the speed only decides how long they waited for it.
const TILE_SPEED: i32 = 10;

/// One tile, graded and encoded, without a target or a file.
///
/// The same `Base` every rendition is cut from, with `job.tile` restricting the decode - so the
/// pixels a reader magnifies are the pixels their export would have, through the same fit, the
/// same mosaic denoise and the same grade shaders.
///
/// PQ Rec.2020 in an HDR AVIF, which is what every other picture this library serves is. A
/// loupe held over the stage has to tone map the way the stage does, and an SDR encode cannot:
/// it has already had the roll-off baked into it and the highlights clipped, so the one thing a
/// reader opens a loupe to check - what the export actually does up there - is the thing it
/// could not show.
///
/// 4:4:4, and that is the part worth being deliberate about: subsampled chroma would halve the
/// resolution of the colour noise the Colour slider is being set against.
///
/// No size fitting: a magnifier that resampled would be answering a different question.
pub fn tile(job: &Job) -> Option<Vec<u8>> {
    let (coded, out_width, out_height) = graded(job)?;
    let (primaries, transfer, matrix) = crate::hdr_args::cicp();
    crate::avif::encode_still(
        std::borrow::Cow::Owned(coded),
        out_width,
        out_height,
        &crate::avif::StillOptions {
            cicp: crate::avif::Cicp { primaries, transfer, matrix },
            format: crate::hdr_args::Chroma::Yuv444.avif_format(),
            quantizer: TILE_QUANTIZER,
            speed: TILE_SPEED,
        },
    )
    .ok()
}

/// The tile's pixels, before an encoder has been anywhere near them.
///
/// Split from the encode so a test can hold a tile against the same rectangle of the whole
/// render, which is the claim the loupe makes and the one an AVIF cannot be asked about.
pub(crate) fn graded(job: &Job) -> Option<(Vec<u16>, usize, usize)> {
    // A tile discards the match it may have fitted: the caller keeps one off the paths that
    // build a whole photograph, and a loupe is not the place to be writing to a catalogue.
    let Base { samples, width, height, levels, matched, as_shot, asked, fitted_now: _ } =
        Base::build(job, 0).ok()?;
    // A job with no rectangle is not a tile: this whole path is the window and what surrounds it,
    // and the route that reaches here refuses a request without one long before the decode.
    let grown = asked?;
    let scene = crate::tone::SceneGrade::new(
        matched.as_ref().map(|m| &m.colour),
        levels,
        job.grade.reference_white_nits,
        job.exposure,
        job.adjust,
        as_shot,
    );

    // The frame's own gather, over this window of it. Not `Cut::from_base`, which would take the
    // crop for the whole photograph and correct it at its own radius; the reader's geometry is not
    // applied either, because a tile is named in coordinates that already carry it.
    let mut cut = crate::hdr::Cut {
        samples: match grown.lens.as_ref().and_then(|lens| {
            crate::image::PlanarWarp::for_lens_window(
                grown.frame,
                grown.window,
                (grown.decode.left, grown.decode.top, width, height),
                lens,
                crate::image::Sampling::Bicubic,
            )
        }) {
            Some(warp) => warp.apply_u16(&samples),
            // No optics to correct, so the region decoded is the window itself.
            None => samples,
        },
        width: grown.window.2,
        height: grown.window.3,
    };
    // As `run` sharpens, and where it sharpens: the deconvolution undoes the *gather's* own
    // resample, so it belongs after it and before the colour transform. A tile skipped it
    // entirely, and showed a softer photograph than the export at the one magnification a reader
    // could have seen the difference at.
    cut.sharpen(job.sharpen);
    let (samples, width, height) = (cut.samples, cut.width, cut.height);

    let gpu = crate::gpu::device()?;
    let grade = crate::gpu::Grade {
        // The photograph's, where this frame is a window on one: `detail.wgsl` blurs at a
        // fraction of it, and a tile answering from its own dimensions would apply a Clarity
        // twelve times finer than the export's.
        photograph_long: grown.frame.0.max(grown.frame.1),
        ..scene.gpu_grade(width, height, job.grade.peak_nits, crate::gpu::Output::Pq)
    };
    // The editor's, where it sent one: the roll-off's input is a reduction over the frame it is
    // handed, so a tile left to measure its own compresses its highlights into whatever the crop
    // happens to reach. Nothing is refused here - `peak.wgsl` floors its own answer at one nit
    // and this takes the same floor - since a number that is not a peak is a picture rather than
    // a failure.
    let peak = match job.scene_peak.filter(|nits| nits.is_finite() && *nits >= 1.0) {
        Some(nits) => gpu.given_peak(nits as f32),
        None => gpu.scene_peak(),
    };
    let coded = gpu.upload(&samples, &grade, &peak).encode(&grade);

    // **Last, after the grade rather than before it.** The presence sliders read a blur built
    // from the frame that goes up, so the window has to still be carrying its halo when it does -
    // cutting first would leave the guided filter fitting its models against an edge that is not
    // in the photograph.
    Some(keep_only(coded, width, grown.keep))
}

/// One rectangle of a graded frame, which for a tile is the part of it the reader asked for.
fn keep_only(
    frame: Vec<u16>,
    stride: usize,
    [left, top, width, height]: [usize; 4],
) -> (Vec<u16>, usize, usize) {
    let mut samples = Vec::with_capacity(width * height * 3);
    for row in 0..height {
        let from = ((top + row) * stride + left) * 3;
        samples.extend_from_slice(&frame[from..from + width * 3]);
    }
    (samples, width, height)
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

    let Base { samples, width, height, levels, matched, as_shot, fitted_now, asked: _ } =
        Base::build(job, largest_size(&rendered))?;
    outcome.camera_match = fitted_now;
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

    // The scene, settled once: the camera's colour, the levels every rendition grades against
    // - which are the ones `Base::build` coded the frame with - and the photographer's
    // exposure. The levels stay unexposed and the gain moves against them, which is what
    // holds the colour still as it changes (`tone::SceneGrade`), and is why the exposure
    // belongs here rather than folded into the anchor the base was coded with.
    //
    // Refused rather than clamped where it is not positive: a gain of zero or less is not a
    // dark picture, it is a caller that sent stops where a multiplier belongs, and grading
    // every photo in the library black is a worse answer than saying so.
    if !job.exposure.is_finite() {
        return Err(format!("an exposure is a number of stops: {}", job.exposure));
    }
    let scene = tone::SceneGrade::new(
        matched.as_ref().map(|m| &m.colour),
        levels,
        job.grade.reference_white_nits,
        job.exposure,
        job.adjust,
        as_shot,
    );

    // Cut once off the base, sharpened once, and the base handed back before anything is
    // encoded - 366MB of samples at 61MP, released across the longest stage of the job.
    // Nothing below reads it: a smaller rendition comes out of the cut.
    let mut cut = {
        let source = hdr::Source { samples: &samples, width, height };
        let mut built = hdr::Cut::from_base(&source, lens, order[0].1, job.geometry);
        built.sharpen(job.sharpen);
        built
    };
    drop(samples);

    // **The frame goes up once per size, not once per rendition.** Two outputs of one size
    // differ by two words of a uniform; uploading 59MB at 3840 - 366MB at native - and
    // rebuilding the lattice, the curves and the output pair for each of them was most of
    // what a second target cost.
    // Measured on the first frame that goes up, which is the largest, and read by every
    // rendition after it. See `gpu::ScenePeak`.
    let scene_peak = gpu.scene_peak();
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
            None => uploaded.insert(gpu.upload(&cut.samples, &grade, &scene_peak)),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The loupe's job, as `rawshim_job.ts` renders it.
    ///
    /// The two whole-frame quantities a tile is handed are the only fields on this struct that
    /// nothing on either side reads, so a rename or a shape that stopped matching would not
    /// surface as an error anywhere: serde would leave them `None` and the tile would quietly go
    /// back to measuring its crop's. Which is a picture, and a plausible one - the grade still
    /// runs, on a diffuse white that belongs to wherever the reader happened to be pointing.
    #[test]
    fn a_tile_job_carries_what_the_crop_cannot_measure() {
        let job: Job = serde_json::from_str(
            r#"{
                "rawFilePath": "/photos/a.arw",
                "matchEmbeddedJpeg": true,
                "tile": [100, 200, 256, 256],
                "noiseFit": {
                    "alpha": 0.0001502,
                    "sigmaSq": 0.0000011,
                    "unifiedSigma": 1.1928239,
                    "darkRef": [0.1, -0.02, 0.33, 0.4]
                },
                "levels": { "white": 8133.5, "peak": 13783 },
                "scenePeak": 4130.5,
                "denoiseLuminance": 20,
                "denoiseColour": 30,
                "sharpen": 1,
                "defringe": 1,
                "exposure": 0.5,
                "grade": {
                    "peakNits": 1000,
                    "referenceWhiteNits": 203,
                    "whiteQuantile": 0.9
                },
                "targets": []
            }"#,
        )
        .expect("the job the tile route sends parses");

        assert_eq!(job.tile, Some([100, 200, 256, 256]));
        assert_eq!(job.levels, Some(tone::Levels { white: 8133.5, peak: 13783.0 }));
        assert_eq!(job.scene_peak, Some(4130.5));
        assert_eq!(job.noise_fit.map(|fit| fit.alpha), Some(0.0001502));
    }
}

