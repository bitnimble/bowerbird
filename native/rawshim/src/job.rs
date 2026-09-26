// One photo's renditions, run end to end on this side (DESIGN 10.3).
//
// Orchestrated here rather than from TypeScript over a handle - not because TypeScript is
// slow at it, it would do almost nothing per call, but because orchestrating from over there
// requires the decode to exist as a raw pointer JavaScript holds between calls, and a pointer
// whose lifetime the compiler cannot see is a pointer whose lifetime is a comment. Here every
// frame is an owned
// value in a scope, dropped when that scope ends, borrowed with references the
// borrow checker actually checks.
//
// What crosses the boundary is a command and a result, both JSON: no addresses, no
// handles, nothing for the other side to free, and no way to ask for pixels.
//
// **There is one rendering pipeline, and SDR is an output stage of it.** Everything
// internal is one 16-bit base through one grade; a rendition's dynamic range reaches
// only the peak that grade rolls into and the transfer and depth of the buffer that leaves.
//
// The ordering is the worker's and the reasons come with it: one decode shared by the fit
// and every rendition, one camera match and one filter pass per photo rather than one per
// rendition, and everything that does not depend on a target's size or its display settled
// before the loop over them.

use crate::decode::Source as Raw;
use crate::hdr;
use crate::hdr_args::{self, Chroma, EncodeOptions};
use crate::image::Strengths;
use crate::light::{DisplayNits, Light, Stops};
#[cfg(feature = "renditions")]
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
    /// The cameras' own picture of a canvas, composited from its frames' JPEGs at the size they
    /// make. Only a composite has one - a photograph's camera JPEG is served as itself.
    Embedded,
}

/// Where a rendition's highlights roll into, and what codes the result.
///
/// **The only thing a rendition's dynamic range reaches inside the pipeline.** Everything
/// upstream is one 16-bit render; this says which peak the BT.2390 roll-off
/// targets and what the buffer is coded as on the way out. Named rather than a `hdr: bool`
/// so a job reads as one render with a list of outputs, and so a third coding is additive.
#[derive(Serialize, Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Output {
    /// The grade's `peak_nits`, PQ, at `avif::AVIF_DEPTH`.
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
    /// How an sRGB output reaches its gamut. A PQ output reads nothing of it.
    #[serde(default)]
    pub intent: crate::gpu::Intent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub raw_file_path: String,
    pub camera_match: crate::hdr_fit::CameraMatch,
    /// Collapse each Bayer quad into one output pixel instead of interpolating it.
    ///
    /// **Asked for rather than inferred.** The decode already halves on its own when the
    /// caller's floor allows it, which is the right rule for a rendition - it is a size
    /// request and halving is an optimisation inside it. An export is not: a reader ticking
    /// this box is choosing the trade, and on a frame small enough that the floor would never
    /// have triggered the halving, inferring it would silently ignore them.
    #[serde(default)]
    pub half_size: bool,
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
    pub scene_peak: Option<Light<DisplayNits>>,
    /// Anchor diffuse white where a finished picture's file states it rather than at a quantile of
    /// the frame, so a rendition graded neutral shows the light it was encoded with.
    ///
    /// A RAW states none, and an ordinary JPEG or HEIC original is a scene to grade like one, so
    /// only the prepare that serves a photograph's own rendition asks.
    #[serde(default)]
    pub stated_white: bool,
    /// What has already been measured about this photograph, if the caller kept it
    /// (`crate::photo_analysis`).
    ///
    /// The camera match is half a second, the noise fit a quarter of one, and the levels are a
    /// quantile over a million samples - none of them depend on anything a rendition brings, so a
    /// caller that keeps them hands them back rather than paying again. A blob this build cannot
    /// read is ignored and everything is measured the slow way, which is what every job did before
    /// this existed.
    #[serde(default)]
    pub photo_analysis: Option<Vec<u8>>,
    /// The Detail panel's two sliders, 0 to 100, exactly as `EditDoc` stores them (§10.9).
    ///
    /// They drive the denoise on the *mosaic*, inside the decode (`crate::galosh`), which
    /// is why they are on the job rather than on a target: every rendition is cut from one
    /// decode, so they could not differ between targets even if a caller asked.
    ///
    /// Nothing is scaled here or on the way in. How much noise the frame has is fitted off
    /// its own photosites, which is why neither side needs its ISO.
    ///
    /// Null is the document not having said, which the decode answers with this frame's own
    /// measurement rather than with a number (`galosh::Detail`).
    #[serde(default)]
    pub denoise_luminance: Option<f64>,
    #[serde(default)]
    pub denoise_colour: Option<f64>,
    /// Which filter those two positions drive. Absent is the one every rendition took before there
    /// was a choice, so a library rendered before this reads the same.
    #[serde(default)]
    pub denoiser: crate::galosh::Denoiser,
    /// The dust panel's switch and two sliders, on the job for the same reason the pair above is:
    /// the correction is on the mosaic, inside the one decode every target is cut from.
    #[serde(default)]
    pub dust: crate::dust::Settings,
    /// The reader's repairs, in the order they were made (`crate::repair`).
    ///
    /// On the job rather than on a target for the reason the dust is: every rendition is cut from
    /// the one frame they are applied to, the largest, and the rest are downscales of it.
    #[serde(default)]
    pub repairs: Vec<crate::repair::Repair>,
    /// The fraction of the deconvolution to blend in, as the Detail panel's Sharpening slider
    /// sets it (§10.9). Read against `image::SHARPEN_GAIN`, so 1 is the top of that track and
    /// the deconvolution as computed is its middle.
    pub sharpen: f64,
    /// How hard to take the colour off a fringing edge (`raw_defringe`, §10.9). Longitudinal
    /// aberration is a focus difference rather than a magnification one, so the warp cannot
    /// reach it and this is the only stage that does.
    pub defringe: f64,
    /// The photographer's own exposure, **in stops**, exactly as `EditDoc` stores it.
    ///
    /// The document's own unit, carried to the shader untouched. Converting it to a `2^EV` gain
    /// on the way in is one rule with an implementation on each path, and the kind that fails
    /// silently because both answers are plausible exposures. `colour.slang` raises it once, for
    /// both.
    /// None resolves to the camera match's level, or zero without a match.
    #[serde(default)]
    pub exposure: Option<Stops>,
    /// The reader's tonal and colour sliders, on Camera Raw's -100..100 scales.
    ///
    /// Defaulted whole, so a caller that knows nothing about edits sends no field and gets
    /// the picture as the camera rendered it.
    #[serde(default)]
    pub adjust: crate::gpu::Adjust,
    /// The reader's crop, straighten and quarter turn.
    ///
    /// The crop and straighten run in the grade's dispatch. The quarter turn is written to
    /// the output container so the encoded pixels keep their unturned positions.
    #[serde(default = "upright")]
    pub geometry: crate::image::Geometry,
    #[serde(default)]
    pub preserve_source_orientation: bool,
    pub grade: hdr::Grade,
    pub targets: Vec<Target>,
    /// This is the import's scan: report the catalogue's fields off the source this job already
    /// opens, and **never demosaic**.
    ///
    /// The scan's answer and the grid tile are otherwise the same file read twice - the same
    /// open, the same decoder, the same tag walk, and the tile then reading a preview that sits
    /// in the pages the walk faulted.
    ///
    /// The refusal to render is the other half of it, and it is not a detail. A target whose
    /// embedded preview cannot be lifted - a body that embeds a bitmap, or nothing - otherwise
    /// falls through to `Base::build`, which is a demosaic, a denoise and a camera match: 1.5
    /// seconds on the *scan* pool, for a tile the rendition pass is about to be asked for
    /// anyway. So a scan leaves that photograph tileless and says so by writing nothing, and the
    /// rendition pass builds it with the library's own settings, which a scan does not carry.
    #[serde(default)]
    pub scan: bool,
    /// The photographs this job is a panorama of, and what to do with them.
    ///
    /// Present, `raw_file_path` says nothing: the sources are here, and what a target renders is
    /// the composite of them. Absent, which is every other job, nothing below changes at all.
    #[cfg(feature = "renditions")]
    #[serde(default)]
    pub composite: Option<crate::composite_job::CompositeJob>,
    /// Measure this photograph and write nothing: no target, no picture, no file.
    ///
    /// The camera match is fitted inside the base every render builds (`open::measure`), and a
    /// library that serves the cameras' pictures never asks for one - so a panorama of those
    /// frames has no lens table to reach their sensors through (`composite_align::Aligned::lensless`).
    /// This is how that fit is asked for on its own: everything past the base is a picture nobody
    /// wanted, and the cut, the grade, the encode and the file are most of what a render costs
    /// once the decode is paid for.
    #[serde(default)]
    pub measure: bool,
    /// Count this job's steps in `crate::progress`, for a caller watching from another thread.
    ///
    /// Asked for rather than always, because there is one counter for the process: an import
    /// building tiles four at a time would report over whatever the reader is actually waiting
    /// on. An export, and a merge's own align, carve and renders, are what somebody is watching.
    /// A carve has to count: only a counting job sees a cancel.
    #[serde(default)]
    pub report_progress: bool,
}

/// **The grade is the shaders the editor runs, and there is nothing to fall back to.** The tick
/// has to be WGSL because it runs in a browser, so the choice was ever a second implementation in
/// Rust or this - and DESIGN 21.1 records what the second one cost: the editor lost the camera
/// match twice, silently, to two implementations drifting. A machine with no adapter at all
/// therefore builds no renditions rather than building different ones. `gpu::device` asks for a
/// software adapter where there is no hardware, so that means no Vulkan whatsoever rather than
/// merely no GPU.
const NO_ADAPTER: &str = "no GPU adapter of any kind, so the grade cannot run - the shaders are \
                          its only implementation. Install a Vulkan driver; SwiftShader \
                          (`bun run get:swiftshader`) will do, slowly";

/// Serde's default for [`Job::geometry`]: the whole frame, as the camera framed it.
fn upright() -> crate::image::Geometry {
    crate::image::Geometry::none()
}

impl Job {
    /// The denoise, as this document holds it: a position on each track, or neither.
    pub(crate) fn detail(&self) -> crate::galosh::Detail {
        crate::galosh::Detail {
            luminance: self.denoise_luminance,
            colour: self.denoise_colour,
            denoiser: self.denoiser,
        }
    }

    /// What the caller already knows about this photograph, as far as this build can read it.
    pub(crate) fn stored(&self) -> crate::photo_analysis::PhotoAnalysis {
        self.photo_analysis
            .as_deref()
            .and_then(crate::photo_analysis::decode)
            .unwrap_or_default()
    }

    /// Every stage's strength, as the library has them set.
    pub(crate) fn strengths(&self) -> Strengths {
        Strengths {
            sharpen: self.sharpen,
            defringe: self.defringe,
        }
    }

    pub(crate) fn pixel_geometry(&self) -> crate::image::Geometry {
        crate::image::Geometry { rotate: 0, ..self.geometry }
    }

    #[cfg(feature = "renditions")]
    fn output_rotation(&self) -> Result<u16, String> {
        if !self.preserve_source_orientation {
            return Ok(self.geometry.rotate);
        }
        if self.geometry.rotate % 360 != 0 {
            return Err("a source-preserving roll cannot also rotate the output".into());
        }
        let bytes = std::fs::read(&self.raw_file_path)
            .map_err(|error| format!("could not read {}: {error}", self.raw_file_path))?;
        let picture = crate::heif::read(&bytes)?.primary;
        match picture.turn {
            rawler::decoders::Orientation::Normal => Ok(0),
            rawler::decoders::Orientation::Rotate90 => Ok(90),
            rawler::decoders::Orientation::Rotate180 => Ok(180),
            rawler::decoders::Orientation::Rotate270 => Ok(270),
            _ => Err("a source-preserving roll needs a non-mirrored AVIF".into()),
        }
    }
}

/// What the caller gets back. Never pixels: a stacking descriptor is a 2.6kB
/// summary, and everything else this job produces is a file on disk.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// What this job measured that the caller did not already have.
    ///
    /// Absent when the request carried everything, so its presence means "this is new, keep it"
    /// rather than "here it is again". Bytes for the same reason the descriptor beside it is:
    /// `serde_json` renders them as numbers, and 5kB saves a base64 decode on the far side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub photo_analysis: Option<Vec<u8>>,
    /// Only from a grid tile, that being the one pass every photo makes exactly once
    /// whatever its library builds from (19.3). Bytes rather than a string, which
    /// `serde_json` renders as an array of numbers - small enough at 2.6kB, and it
    /// saves a base64 decode on the other side.
    pub descriptor: Option<Vec<u8>>,
    /// The catalogue's fields, where [`Job::header`] asked for them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<HeaderFields>,
    /// What an align answered, as JSON: the recipe, and what it could not state about the set it
    /// was given - the lenses nothing has fitted among them (`composite_job::align`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composite: Option<String>,
}

/// What `bb_read_header` reports, as JSON rather than as a `#[repr(C)]` struct.
///
/// The nulls are applied here rather than by the reader, so the two spellings of the same
/// question answer identically: `rawshim_ops.ts` turns a 0 or a NaN into null on its way out of
/// the struct, and a fused import that reported 0 would date a photograph to 1970.
#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HeaderFields {
    pub width: u32,
    pub height: u32,
    pub orientation: i32,
    pub timestamp: Option<i64>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub iso: Option<f32>,
    pub shutter_speed: Option<f32>,
    pub aperture: Option<f32>,
    pub focal_length: Option<f32>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens_model: Option<String>,
    pub sequence: Option<CaptureSequence>,
}

/// `BbHeader`'s sequence fields, as `rawshim_ops.ts` reads them off the struct.
#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSequence {
    pub kind: &'static str,
    pub group: Option<u32>,
    pub index: Option<u32>,
    pub count: Option<u32>,
}

impl CaptureSequence {
    fn of(header: &crate::header::BbHeader) -> Option<CaptureSequence> {
        let kind = match header.sequence_kind {
            crate::header::SEQUENCE_PIXEL_SHIFT => "pixelShift",
            crate::header::SEQUENCE_EXPOSURE_BRACKET => "exposureBracket",
            crate::header::SEQUENCE_FOCUS_BRACKET => "focusBracket",
            _ => return None,
        };
        let known = |value: u32| (value != 0).then_some(value);
        Some(CaptureSequence {
            kind,
            group: known(header.sequence_group),
            index: known(header.sequence_index),
            count: known(header.sequence_count),
        })
    }
}

impl From<crate::header::BbHeader> for HeaderFields {
    fn from(header: crate::header::BbHeader) -> HeaderFields {
        let positive = |value: f32| (value > 0.0).then_some(value);
        let finite = |value: f64| value.is_finite().then_some(value);
        // Blank and all-dashes read as "unknown", which is `name`'s rule in `rawshim_ops.ts`.
        let named = |field: &[u8]| {
            let text = crate::header::name(field);
            (!text.is_empty() && !text.bytes().all(|b| b == b'-')).then(|| text.to_string())
        };
        HeaderFields {
            sequence: CaptureSequence::of(&header),
            width: header.width,
            height: header.height,
            orientation: header.orientation,
            timestamp: (header.timestamp != 0).then_some(header.timestamp),
            latitude: finite(header.latitude),
            longitude: finite(header.longitude),
            iso: positive(header.iso),
            shutter_speed: positive(header.shutter),
            aperture: positive(header.aperture),
            focal_length: positive(header.focal),
            camera_make: named(&header.camera_make),
            camera_model: named(&header.camera_model),
            lens_model: named(&header.lens_model),
        }
    }
}

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
/// `still_chroma` reads whichever setting covers this rendition, because the sizing depends on
/// it: 4:2:0 has no odd dimensions. One rule for both ranges - sizing SDR with `resize_to_fit`
/// instead rounds down without regard to what the encoder can carry.
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
        // `run` composes the deconvolution's sigma itself and hands it to `Cut::from_base`;
        // these options only ever reach the one-shot paths, which fall back on None.
        sharpen_sigma: None,
        max_edge: match target.size {
            0 => f64::INFINITY,
            size => f64::from(size),
        },
    }
}

/// The frame a target cuts from `photograph`, before the reader's geometry: `hdr_args::target_size`,
/// shrunk until what the geometry writes of it still opens in every AVIF reader. A straighten's
/// bounding box is larger than the frame it turns, so a frame at the limit can write past it.
fn drawn_size(
    job: &Job,
    photograph: (usize, usize),
    options: &EncodeOptions,
) -> hdr_args::Size {
    let mut options = options.clone();
    loop {
        let size = hdr_args::target_size(photograph.0 as u32, photograph.1 as u32, &options);
        let (width, height) =
            hdr::cropped_size(size.width as usize, size.height as usize, job.pixel_geometry());
        let written = hdr_args::Size { width: width as u32, height: height as u32 };
        let fits = hdr_args::decodable(written);
        if fits == written {
            return size;
        }
        let long = size.width.max(size.height);
        let shrunk = f64::from(long) * f64::from(fits.width) / f64::from(written.width);
        options.max_edge = shrunk.floor().min(f64::from(long - 1));
    }
}

/// The fraction of a 64px tile's blocks a 4:2:0 decode may get visibly wrong before the still is
/// written 4:4:4 (`base::chroma_leak`).
///
/// Measured over seven frames. DSC03422, whose headlight the shipped 4:2:0 file speckled, reads
/// 0.24 at native resolution and 0.24 at 3840. The next frame reads 0.10 on one tile of dense
/// chroma texture whose 4:2:0 encode measured no leak - blue's detail smoothed, red untouched,
/// which is what subsampling ordinarily costs and is not this - and the three clean frames read
/// nothing. Between the two, nearer the frame that does need it than the one that does not.
const CHROMA_LEAK_TILE_FRACTION: f64 = 0.15;

/// Where the grade rolls this target's highlights into.
///
/// The only thing a rendition's dynamic range reaches inside the pipeline. An SDR render is
/// the same grade with the peak at diffuse white, so everything above it rolls off into
/// white through the same BT.2390 curve instead of clipping there.
fn peak_nits(job: &Job, target: &Target) -> Light<DisplayNits> {
    match target.output {
        Output::Pq => job.grade.peak_nits,
        // The one place the scene's anchor becomes the display's, spelled rather than implied:
        // `at_diffuse_white` is a claim about what the container can hold, not a unit conversion.
        Output::Srgb => Light::at_diffuse_white(job.grade.reference_white_nits),
    }
}

/// Never fatal. A descriptor is what stacking would like, not what the import owes,
/// and a photo without one is simply not a candidate.
///
/// **Asks for the adapter itself rather than being handed one.** The grids are a kernel, but a
/// grid tile lifted whole out of the camera's JPEG runs no grade, and a job that only does that
/// has no other reason to need a device. Taking one for the whole job would refuse to catalogue
/// such a photograph on a machine with no Vulkan, over a descriptor it is allowed to do without.
#[cfg(feature = "renditions")]
fn describe_if_grid(image: crate::rgb::RgbRef<'_>, target: &Target, outcome: &mut Outcome) {
    if target.rendition != Rendition::Grid {
        return;
    }
    let Some(gpu) = crate::gpu::device() else {
        eprintln!("rawshim: no adapter, so this photograph gets no stacking descriptor");
        return;
    };
    if let Some(descriptor) = stacks::describe(gpu, image) {
        outcome.descriptor = Some(descriptor);
    }
}

#[cfg(feature = "renditions")]
fn save_avif(image: crate::rgb::RgbRef<'_>, target: &Target, rotate: u16) -> Result<(), String> {
    crate::save_avif_frame(
        image,
        target.sdr_quantizer,
        target.preset,
        target.sdr_full_chroma,
        &target.output_path,
        rotate,
    )
}

/// The photo, carried as far as no rendition's size or display can take it.
///
/// Everything here is measured or fitted against the whole frame and would be the same
/// answer for every target, so it is settled once: the decode, the levels the grade anchors
/// to, the coding, the camera match, and the denoise. What is left per target is the resize,
/// the warp, and then one dispatch carrying the colour transform, the roll-off into that
/// display's peak and the transfer - followed by the encode.
/// Normalised PQ Rec.2020 (`tone::encode_base`), denoised and defringed, and the one thing about a
/// base that depends on how it was made.
///
/// A whole-frame build leaves it where the coding wrote it, because the resize and the warp that
/// come next are shaders and a `Vec<u16>` between them is a frame taken off the device and put
/// straight back. A window has already been resized, warped and sharpened by `tile::prepared`, so
/// it arrives on the host and there is nothing left to run over it.
pub(crate) enum Cutting {
    OnDevice(crate::resident::Resident),
    AlreadyCut(crate::hdr::Cut),
}

impl Cutting {
    /// The samples on the host, whichever side of the bus they were on.
    ///
    /// For a reader that is not `run` - the fixture pins, which grade the base directly. `run`
    /// itself matches, because the two arms are different work rather than one value in two places.
    #[cfg(all(test, feature = "fixtures"))]
    pub(crate) fn host(self) -> Vec<u16> {
        match self {
            Cutting::AlreadyCut(cut) => cut.into_samples(),
            Cutting::OnDevice(frame) => {
                pollster::block_on(frame.into_host()).expect("the prepared frame maps")
            }
        }
    }
}

pub(crate) struct Base {
    pub(crate) frame: Cutting,
    /// The decode's own size. `run` reads it off the cut instead, which carries its own either
    /// side of the bus; what still wants it here is the fixture suite, assembling the two
    /// routes by hand to hold them against each other.
    #[cfg_attr(not(all(test, feature = "fixtures")), allow(dead_code))]
    pub(crate) width: usize,
    #[cfg_attr(not(all(test, feature = "fixtures")), allow(dead_code))]
    pub(crate) height: usize,
    /// The frame's own diffuse white and scene peak, off the *unresized* decode, and the pair
    /// the samples above were coded against.
    pub(crate) levels: tone::Anchored,
    /// The whole photograph, which is the frame above unless a crop let the decode skip most of it.
    /// Every rendition's size is a bound on *this*, so it is what `run` orders the targets by.
    pub(crate) photograph: (usize, usize),
    /// Where the frame sits in that photograph, for the grade's geometry. None when it is all of it.
    pub(crate) window: Option<crate::gpu::Window>,
    pub(crate) matched: Option<crate::hdr_fit::HdrMatch>,
    /// Everything this build now knows about the photograph, whether it was told or measured it.
    /// What is worth writing back is decided at the end of the job, once the peak is in too.
    pub(crate) analysis: crate::photo_analysis::PhotoAnalysis,
    /// What the job was handed, to report the difference against.
    pub(crate) stored: crate::photo_analysis::PhotoAnalysis,
    /// The illuminant the decode balanced against, which the stored temperature and tint move
    /// away from. Read off the processor and carried, because the decode is the only place it
    /// exists.
    pub(crate) as_shot: Option<crate::white_balance::AsShot>,
    /// The capture's blur sigma in sensor pixels, and the sensor's long edge those pixels
    /// belong to - the pair `image::deconvolve_split` carries to each target's scale.
    pub(crate) capture_sigma: Option<f32>,
    pub(crate) sensor_long: usize,
    pub(crate) sharpen_noise: crate::image::SharpenNoise,
    /// Whether what this base measured describes the photograph, and so is worth filing under it.
    ///
    /// **False for a composite of the cameras' own pictures**, whose every measurement is of what
    /// the bodies printed rather than of the canvas: its white is the transfer's white and its peak
    /// is full scale, both by construction (`composite_job::camera_levels`). Filed under the row, they
    /// would be read straight back by the next composite *of the photographs*, which is keyed on
    /// the quantile and the reference white - identical across the two arms. And the grid tile is
    /// the arm a merge runs first, so the camera's peak would be the first thing ever filed and
    /// every later render of that canvas would roll off against it.
    pub(crate) describes_the_photograph: bool,
}

/// The picture this job is of, assembled at `size` on its long edge, whatever it is composed from.
///
/// **The one place a recipe is dispatched on.** A render and a client's prepare
/// ([`crate::picture::prepared`]) both start here, so neither can be the one that forgets that a
/// composite measures its levels over its whole set or that a cropped render can decode less.
///
/// `rendered` is only read by the two arms that need to know what the targets asked for: a
/// composite of the cameras' own pictures rather than of the photographs, and a cropped render's
/// refusal to guess at a size the decode does not offer. A prepare passes none, and gets the
/// photographs and no crop - which is what it wants, the client applying the reader's geometry to
/// the picture itself.
#[cfg(feature = "renditions")]
pub(crate) fn assembled(
    job: &Job,
    size: u32,
    rendered: &[&Target],
    window: Option<crate::px::Rect<crate::px::Composite>>,
    // The parts of `window` a caller asked for, or empty for the whole of it.
    parts: &[crate::px::Rect<crate::px::Composite>],
) -> Result<Base, String> {
    match &job.composite {
        // A composite of its sources, which is a coded frame with levels and a colour match
        // beside it - the same three things a decode hands over, so everything below is
        // untouched by there being several photographs behind it.
        //
        // `Source::Embedded` composites the cameras' own JPEGs rather than the sources
        // themselves, which is the same recipe over a picture that is already corrected: it
        // is what a grid tile takes, and what gives a merge something to look at in seconds.
        // Asked of every target at once because one composite feeds them all, and a job that
        // wanted both would be two jobs.
        Some(crate::composite_job::CompositeJob {
            sources,
            want: crate::composite_job::Want::Render { recipe },
        }) => crate::composite_job::base(
            job,
            sources,
            recipe,
            size,
            match !rendered.is_empty()
                && rendered
                    .iter()
                    .all(|target| target.source == Source::Embedded)
            {
                true => crate::composite_tile::From::Camera,
                false => crate::composite_tile::From::Original,
            },
            window,
            parts,
        ),
        Some(_) => Err("only a render of a composite has a picture to draw".into()),
        None => pollster::block_on(single(job, Raw::Path(&job.raw_file_path), size, rendered)),
    }
}

/// One photograph's base, from wherever its bytes are: the window a crop reads where that route
/// takes it, and the whole frame otherwise.
async fn single(job: &Job, raw: Raw<'_>, size: u32, rendered: &[&Target]) -> Result<Base, String> {
    let stored = job.stored();
    match Base::window(job, raw, rendered, &stored).await {
        Some(cropped) => cropped,
        None => Base::built(job, raw, size).await,
    }
}

/// Where the camera match comes from for a photograph read from `raw`.
///
/// A path takes lensfun's tier on top of the picture's own geometry, which a browser has no lensfun
/// to consult for (`open::Fitting`). A photograph with its match on file - which is nearly every
/// one a rendition is asked of - reads that instead and never reaches either.
fn fitting<'a>(job: &Job, raw: Raw<'a>) -> crate::open::Fitting<'a> {
    if job.camera_match == crate::hdr_fit::CameraMatch::None {
        return crate::open::Fitting::None;
    }
    match raw {
        #[cfg(feature = "renditions")]
        Raw::Path(path) if !crate::decode_rendered::is_rendered(path) => {
            crate::open::Fitting::Profiled(path)
        }
        Raw::Bytes(bytes) if !crate::decode_rendered::is_rendered_bytes(bytes) => {
            crate::open::Fitting::Preview(bytes)
        }
        _ => crate::open::Fitting::None,
    }
}

impl Base {
    #[cfg(feature = "renditions")]
    pub(crate) fn build(job: &Job, size: u32) -> Result<Base, String> {
        pollster::block_on(Base::built(job, Raw::Path(&job.raw_file_path), size))
    }

    async fn built(job: &Job, raw: Raw<'_>, size: u32) -> Result<Base, String> {
        let mut lap = crate::clock::laps("  base ");
        let stored = job.stored();
        // Denoised inside the decode, on the mosaic, which is the only place the noise is
        // still one photosite's own (`crate::galosh`).
        // Reached through `decode` rather than `crate::decode_frame_denoised`, which reads the
        // frame back for the callers that want samples: everything below this is a shader, so the
        // rendition takes the spelling that leaves it where the decode wrote it.
        let fit = crate::galosh::wanted(stored.from_raw.noise, job.detail());
        // Off the sidecar where the editor's open already found them, so an export agrees with
        // the tab that ordered it spot for spot rather than detecting a second time against a
        // frame the decode may have halved.
        let dust = job.dust.wanted(stored.from_raw.dust.as_deref());
        let frame = match raw {
            #[cfg(feature = "renditions")]
            Raw::Path(path) if job.preserve_source_orientation => crate::decode::frame_from_path_unturned(path, size),
            Raw::Path(path) => crate::decode::frame_from_path(
                path,
                job.detail(),
                size,
                job.half_size,
                fit,
                dust,
            ),
            Raw::Bytes(_) if job.preserve_source_orientation => {
                return Err("source orientation can only be preserved from a file".into());
            }
            Raw::Bytes(_) if job.half_size => {
                return Err("a halved decode is an export's, which is not drawn from bytes".into());
            }
            Raw::Bytes(bytes) => {
                crate::decode::frame_from_bytes(bytes, job.detail(), size, fit, dust).await
            }
        }
        .ok_or("could not decode this photograph scene-linear")?;
        lap("decode, denoise, demosaic");
        let (width, height) = (frame.width, frame.height);
        let (noise, matrix) = (frame.noise, frame.matrix);
        let frame_reduced = frame.reduced.max(1);
        let sensor_long = width.max(height) * frame_reduced;
        let as_shot = frame.as_shot;
        let wb_gains = frame.wb_gains;
        let dust = frame.dust.clone();
        let stated_white = frame
            .white_to_anchor(job.stated_white)
            .map_err(|why| format!("{}: {why}", job.raw_file_path))?;
        let crate::frame::Pixels::Resident(resident) = frame.pixels else {
            return Err("the render needs a 16-bit scene-linear decode on the device".to_string());
        };

        let strengths = job.strengths().before_the_fit();
        // **The open, which is the editor's** (`crate::open`): the correction ahead of the fit, the
        // camera match, and the levels - one implementation, so a rendition and the tab that
        // predicts it cannot measure the same photograph two ways.
        let opening = crate::open::Opening {
            camera_match: job.camera_match,
            grade: job.grade,
            strengths: job.strengths(),
            stored: &stored,
            // A finished picture has no second rendering of itself to be fitted against, so the
            // setting has nothing to turn on: what a JPEG or a HEIC *is* is somebody's render.
            fitting: fitting(job, raw),
            noise,
            matrix,
        };
        let crate::open::Measured {
            matched,
            levels: measured,
            defringe,
            blur,
        } = crate::open::measure(&resident, &opening).await?;
        lap("defringe, camera match, levels");
        // Carried from an earlier pass or read off the frame just measured; the sensor's own long
        // edge travels beside it because the sigma is in sensor pixels and the decode may have
        // halved, which is also what scales a blur read on the decode back into them.
        let capture_sigma = stored
            .from_raw
            .capture_sigma
            .or_else(|| blur.map(|blur| blur * frame_reduced as f32));
        let measured = match stated_white {
            Some(white) => measured.at_stated_white(white),
            None => measured,
        };
        // Floored here and carried, so the white the frame is *coded* against and the white the
        // shader is told about are one number rather than two computed alike.
        let levels = measured.anchored();
        let sharpen_noise = crate::base::sharpen_noise(
            levels,
            job.grade.reference_white_nits,
            noise,
            matrix,
            wb_gains,
            frame_reduced,
        );
        // Read off the levels and coded against them, once, here. Everything below this line
        // - the filters, the resize, the warp, the shader - reads normalised PQ rather than
        // sensor levels, and `tone::encode_base` says what that buys.
        //
        // Ahead of every warp and every resize, which is where the denoise belongs and the
        // sharpen does not (`Cut::from_base` runs it after both). At the decode's size, which is the largest
        // any target asked for: the chroma denoise's radii and the defringe's constants are in
        // pixels of the frame they read, so this is the one size at which they mean what they
        // were tuned to mean.
        //
        // Both on the GPU in one pass where there is one, over the frame the decode has already
        // left there (`base::prepare`, and `edit::open` takes the same route with the warp on the
        // end of it). No lens here: a rendition's warp is per target and happens further down,
        // so this is the coding and the defringe alone. What it does about the aberration is the
        // open's answer, not a second one derived here.
        let refused = || crate::base::without_a_device("the coding and the defringe");
        let gpu = crate::gpu::device().ok_or_else(refused)?;
        let base = crate::base::device(gpu).ok_or_else(refused)?;
        let (prepared, defocus) = crate::base::prepare(
            gpu,
            base,
            resident,
            crate::base::Gather::frame(crate::px::Size::exact(width, height)),
            levels,
            job.grade.reference_white_nits,
            strengths,
            crate::image::SharpenSigma::fixed(crate::image::DECONVOLVE_SIGMA),
            crate::image::SharpenNoise::NONE,
            &crate::fit::Lens::none(),
            defringe,
            noise,
            matrix,
        )
        .await
        .ok_or_else(refused)?;
        let (red, blue) = defocus;
        gpu.settle();
        lap("code, defringe");
        let analysis = crate::photo_analysis::PhotoAnalysis {
            from_raw: crate::photo_analysis::FromRaw {
                matched: matched.clone(),
                noise,
                dust,
                capture_sigma,
                // One photograph, so every caller that wants the balance has decoded it: this is
                // filed for a composite, whose reference frame a window may never reach.
                balance: None,
            },
            from_render: crate::photo_analysis::FromRender {
                levels: Some(crate::photo_analysis::MeasuredLevels {
                    levels: measured,
                    white_quantile: job.grade.white_quantile,
                }),
                // Filled in by `run` once a frame has been up: the peak is measured on the GPU,
                // through the whole colour transform, and there is no frame there yet.
                scene_peak: None,
                defocus: Some(crate::photo_analysis::MeasuredDefocus {
                    red,
                    blue,
                    defringe: strengths.defringe,
                    // The decode's own, which is what it was fitted over - and which the decode may
                    // have halved.
                    long_edge: width.max(height),
                }),
                // One photograph, so there is no set for a stamp to distinguish: what these were
                // measured over is the file the row is keyed on.
                set: None,
            },
        };
        Ok(Base {
            frame: Cutting::OnDevice(prepared),
            width,
            height,
            levels,
            photograph: (width, height),
            window: None,
            matched,
            analysis,
            stored,
            as_shot,
            capture_sigma,
            sensor_long,
            sharpen_noise,
            describes_the_photograph: true,
        })
    }

    /// The same base, decoded only where the reader's crop actually reads.
    ///
    /// **Everything below the decode costs what it is given.** The denoise is thirty kernels over
    /// the mosaic, the coding and the defringe are the frame, and the lens gather writes it again -
    /// and a photograph cropped to a quarter throws three quarters of all of it away at the grade.
    /// So a cropped render asks for the rectangle its geometry reads and nothing else, which is the
    /// window machinery a loupe tile already goes through (`crate::tile`) and is pinned against the
    /// rendition it predicts.
    ///
    /// `None` declines, and the caller decodes the whole photograph as it always did. Three ways
    /// that happens, and none of them is a failure:
    ///
    /// - Nothing is cropped, which is most photographs.
    /// - Some target wants a size neither of the decode's two resolutions produces. The window
    ///   would then have to be resized along with the photograph's own coordinates, and an origin
    ///   scaled by a non-integer ratio is a sub-pixel shift between this route and the whole-frame
    ///   one. Worth having later, behind a measurement; not worth guessing at. Exactly half is not
    ///   this case - the ratio is two, every coordinate divides, and `tile::grown` converts.
    /// - **The photograph has not been measured yet.** A window cannot read the levels, the noise,
    ///   the aberration or the match - all four are whole-frame - so without them stored there is
    ///   nothing to hand it. No user path reaches a cropped render cold, since a crop is made in
    ///   the editor and the open measures all four; and if one ever does, the whole-frame decode
    ///   measures and stores them, so the next render of that photograph takes this route.
    #[cfg(all(test, feature = "fixtures"))]
    pub(crate) fn cropped(
        job: &Job,
        rendered: &[&Target],
        stored: &crate::photo_analysis::PhotoAnalysis,
    ) -> Option<Result<Base, String>> {
        pollster::block_on(Base::window(job, Raw::Path(&job.raw_file_path), rendered, stored))
    }

    async fn window(
        job: &Job,
        raw: Raw<'_>,
        rendered: &[&Target],
        stored: &crate::photo_analysis::PhotoAnalysis,
    ) -> Option<Result<Base, String>> {
        let geometry = job.pixel_geometry();
        if geometry.is_identity() {
            return None;
        }
        let header = match raw {
            Raw::Path(path) => crate::header::read_path(path),
            Raw::Bytes(bytes) => crate::header::read_bytes(bytes),
        }?;
        let photograph = (header.width as usize, header.height as usize);
        if photograph.0 == 0 || photograph.1 == 0 {
            return None;
        }
        // Every target at the size the sensor gives it, so the window's coordinates are the
        // photograph's and nothing anywhere has to be scaled. One target wanting less is enough to
        // send the whole job the other way: they share a frame.
        // **The scale is the photograph's answer to the largest target**, and the window is then
        // demosaiced exactly as the whole frame would have been (`view::Scale::for_long_edge`).
        //
        // Every target has to want the size that scale produces on the nose. The decode offers two
        // resolutions and nothing between, so any other size is a resize on top - and a window
        // resized on its own lands on a grid the whole frame's resize never had. That case is worth
        // having and is not this one: it needs a tolerance rather than the equality below.
        let sized = |target: &Target| {
            let size = drawn_size(job, photograph, &encode_options(job, target, &target.output_path));
            (size.width as usize, size.height as usize)
        };
        let out = sized(rendered.first()?);
        let scale = crate::view::Scale::for_long_edge(photograph, out.0.max(out.1) as u32);
        let drawn = crate::view::View::whole(crate::px::Size::exact(photograph.0, photograph.1))
            .at(scale)
            .drawn();
        if rendered.iter().any(|target| sized(target) != out) || out != drawn.raw() {
            return None;
        }

        let strengths = job.strengths().before_the_fit();
        let levels = stored
            .from_render
            .levels?
            .levels_at(job.grade.white_quantile)?;
        // The *drawn* long edge, which is the frame the whole-frame decode this window stands in for
        // would have measured over: it halves itself for the same floor, and a coefficient is in
        // the pixels of whatever it was fitted on.
        let defocus = stored
            .from_render
            .defocus?
            .pair_for(strengths.defringe, drawn.long().raw())?;
        stored.from_raw.noise?;
        if job.camera_match.needs_fit(stored.from_raw.matched.as_ref()) {
            return None;
        }
        // **A window cannot look for particles**, deliberately: the gates read the frame's own
        // texture floor, so a crop finding its own would find a different set from the picture it
        // was cut out of. A photograph whose glass has never been read therefore takes the long way
        // round, where the whole-frame decode can look - the alternative is a cropped export
        // shipping the dust that the uncropped one beside it had removed.
        //
        // Unless the frame could not hold a particle at all. Wider than `WIDEST_USEFUL_APERTURE` the
        // search refuses outright, so the whole-frame decode this would fall back to would return an
        // empty list and correct nothing - and with the switch on by default, that is most of a
        // library taking the long way round on its first crop to be told there was nothing to find.
        // The aperture is in the header, which is already read above.
        if job.dust.wanted(None).does_anything()
            && crate::dust::worth_reading(header.aperture)
            && stored.from_raw.dust.is_none()
        {
            return None;
        }

        let out = crate::hdr::cropped_size(photograph.0, photograph.1, geometry);
        let asked = crate::image::geometry_footprint(photograph, out, geometry);
        // Nothing to save where the crop reads the whole picture anyway - a straighten alone does -
        // and the window route would then be the long way round to the same frame.
        if asked.2 * asked.3 * 10 >= photograph.0 * photograph.1 * 9 {
            return None;
        }

        // On the device, and it stays there: this window is about to be graded rather than read,
        // and the route exists to avoid work rather than to move it. Taking the samples here cost
        // a download of the whole window and an upload of the same bytes a few lines later.
        let window = crate::tile::prepared_on_device(
            match raw {
                Raw::Path(path) => crate::tile::Source::Path(path),
                Raw::Bytes(bytes) => crate::tile::Source::Bytes(bytes),
            },
            &crate::tile::TileRequest {
                tile: [asked.0, asked.1, asked.2, asked.3],
                frame: [photograph.0, photograph.1],
                grade: job.grade,
                strengths: job.strengths(),
                denoise_luminance: job.denoise_luminance,
                denoise_colour: job.denoise_colour,
                denoiser: job.denoiser,
                dust: job.dust,
                adjust: job.adjust.clone(),
                levels: Some(levels),
                noise_fit: stored.from_raw.noise,
                capture_sigma: stored.from_raw.capture_sigma,
                // `frame` below is the header's own dimensions, which are the sensor's.
                sensor_long: None,
                defocus: crate::base::Defringe::Take(defocus),
                photo_analysis: job.photo_analysis.as_deref().map(|analysis| with_camera_match(analysis, job.camera_match)),
                // None throughout this file: a rendition is built by a host with libavif, which
                // reads the field's picture where it stands.
                scale,
                repairs: job.repairs.clone(),
                drawn: None,
            },
        )
        .await;
        let (frame, window) = match window {
            Ok(window) => window,
            Err(why) => return Some(Err(why)),
        };
        // The whole window, halo and all: the grade reads past the rectangle asked for, so cutting
        // to `keep` here would be the ringing a tile grows its window to avoid.
        //
        // **In the buffer's pixels, because that is the frame the grade is about to read.** `asked`
        // is the photograph's and `keep` is what `tile::grown` measured inside the window it built,
        // so the two only subtract once the first has been through the same conversion the second
        // already has. `drawn` is the photograph at this scale for the same reason.
        let asked_at: crate::px::At<crate::px::Photograph> = crate::px::At::exact(asked.0, asked.1);
        let origin: crate::px::At<crate::px::Drawn> = crate::px::At {
            x: scale.at(asked_at.x) - crate::px::Span::exact(window.keep[0]),
            y: scale.at(asked_at.y) - crate::px::Span::exact(window.keep[1]),
        };
        Some(Ok(Base {
            width: window.width,
            height: window.height,
            frame: Cutting::AlreadyCut(crate::hdr::Cut::device(
                frame.into_frame(),
                window.width,
                window.height,
            )),
            levels: levels.anchored(),
            photograph: drawn.raw(),
            window: Some(crate::gpu::Window {
                photograph: drawn,
                origin,
            }),
            matched: window.matched,
            analysis: crate::photo_analysis::PhotoAnalysis {
                from_raw: stored.from_raw.clone(),
                from_render: stored.from_render,
            },
            stored: stored.clone(),
            as_shot: window.as_shot,
            // The window arrives sharpened by `tile::prepared_on_device`, so `run` never composes a
            // sigma for it; carried anyway so the analysis written back stays whole.
            capture_sigma: stored.from_raw.capture_sigma,
            sensor_long: photograph.0.max(photograph.1),
            sharpen_noise: crate::image::SharpenNoise::NONE,
            describes_the_photograph: true,
        }))
    }
}

/// One tile of the photograph, graded, as pixels.
///
/// The same `Base` every rendition is cut from, with `job.tile` restricting the decode - so the
/// pixels a reader magnifies are the pixels their export would have, through the same fit, the
/// same mosaic denoise and the same grade shaders. `crate::tile` is where the page's own tiles
/// come from, so this is the native side of the claim the loupe makes, and what a fixture test
/// can hold against the same rectangle of the whole render.
#[cfg(feature = "renditions")]
pub fn graded(job: &Job) -> Option<(Vec<u16>, usize, usize)> {
    // A job with no rectangle is not a tile.
    let asked = job.tile?;
    let window = crate::tile::prepared(
        crate::tile::Source::Path(&job.raw_file_path),
        &tile_request(job, asked),
    )
    .ok()?;
    let scene = window.scene(job.exposure, job.adjust.clone());
    let gpu = crate::gpu::device()?;
    let grade = window.grade(&scene, job.grade.peak_nits, crate::gpu::Output::Pq);
    let width = window.width;
    // The editor's, where it sent one: the roll-off's input is a reduction over the frame it is
    // handed, so a tile left to measure its own compresses its highlights into whatever the crop
    // happens to reach. Nothing is refused here - `peak.slang` floors its own answer at one nit
    // and this takes the same floor - since a number that is not a peak is a picture rather than
    // a failure.
    let peak = match job.scene_peak.filter(|nits| nits.is_a_peak()) {
        Some(nits) => gpu.given_peak(nits.raw() as f32),
        None => gpu.scene_peak(),
    };
    let coded = gpu.upload(&window.samples, &grade, &peak).encode(&grade);

    // **Last, after the grade rather than before it.** The presence sliders read a blur built
    // from the frame that goes up, so the window has to still be carrying its halo when it does -
    // cutting first would leave the guided filter fitting its models against an edge that is not
    // in the photograph.
    Some(keep_only(coded, width, window.keep))
}

/// This job's tile, as the shared path asks for it.
///
/// The photograph's size comes off the file rather than out of the request: a client naming a
/// rectangle over HTTP has no standing to say how large the photograph it is a piece of is, where
/// a page that decoded the frame itself has nothing else to say.
#[cfg(feature = "renditions")]
fn tile_request(job: &Job, asked: [usize; 4]) -> crate::tile::TileRequest {
    let frame = crate::header::read_path(&job.raw_file_path).map_or([0, 0], |header| {
        [header.width as usize, header.height as usize]
    });
    crate::tile::TileRequest {
        tile: asked,
        frame,
        grade: job.grade,
        strengths: job.strengths(),
        denoise_luminance: job.denoise_luminance,
        denoise_colour: job.denoise_colour,
        denoiser: job.denoiser,
        dust: job.dust,
        adjust: job.adjust.clone(),
        levels: job.levels,
        noise_fit: job.noise_fit,
        capture_sigma: job.stored().from_raw.capture_sigma,
        // `frame` above came off the file's header, so it is already the sensor's.
        sensor_long: None,
        // The editor hands its open's in; a rendition's loupe is answered by a process with no
        // frame of this photograph in front of it, so it reads the photograph's own out of the
        // analysis instead of fitting one off the window's edges (`crate::tile::prepared_async`
        // falls back to that where neither is available).
        defocus: crate::base::Defringe::Measure,
        // A tile cannot fit its own and must not try: `fit_all` resamples the whole embedded JPEG
        // to the frame it is given, so fitting against a tile compares a squashed picture of the
        // entire scene with a 400px piece of it. That produces a different match for every tile
        // position - the loupe changing grade as it moves - on top of matching neither the
        // rendition nor the editor.
        // **Withheld only where it would let a tile fit its own match** - not dropped wholesale.
        // The particles travel in here too, and they are the photograph's rather than this
        // rectangle's, so a tile denied the analysis corrects no dust while the render beside it
        // does. Stripping the match keeps the reason above and leaves the rest.
        photo_analysis: job.photo_analysis.as_deref().map(|analysis| with_camera_match(analysis, job.camera_match)),
        // A loupe is showing the reader the export's own pixels, so it never halves.
        scale: crate::view::Scale::Full,
        repairs: job.repairs.clone(),
        drawn: None,
    }
}

/// The job's repairs over a whole cut of the picture, which for a composite is its canvas. A window
/// has had them already (`tile::prepared_on_device`).
fn repaired(cut: &hdr::Cut, job: &Job) -> Result<(), String> {
    let Some(frame) = cut.resident() else {
        return Ok(());
    };
    // What each was drawn over is the editor's to keep (`repaired`), and a rendition keeps nothing.
    crate::repair::apply(
        frame,
        crate::px::Size::exact(cut.width, cut.height),
        crate::px::At::ORIGIN,
        &job.repairs,
    )
    .map(drop)
}

fn with_camera_match(analysis: &[u8], camera_match: crate::hdr_fit::CameraMatch) -> Vec<u8> {
    if camera_match == crate::hdr_fit::CameraMatch::LensAndColour {
        return analysis.to_vec();
    }
    let mut stored = crate::photo_analysis::decode(analysis).unwrap_or_default();
    stored.from_raw.matched = camera_match.apply(stored.from_raw.matched);
    crate::photo_analysis::encode(&stored)
}

/// One rectangle of a graded frame, which for a tile is the part of it the reader asked for.
#[cfg(feature = "renditions")]
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
#[cfg(feature = "renditions")]
pub fn run(job: &Job) -> Result<Outcome, String> {
    let mut lap = crate::clock::laps("  job ");
    let mut outcome = Outcome::default();

    // A search renders nothing and reads no rendition setting: it is a pass over the sources, and
    // what it answers is a recipe for every later job to render.
    if let Some(pano) = &job.composite {
        use crate::composite_job::Want;
        let answered = match &pano.want {
            Want::Align { shape } => {
                let gpu = crate::gpu::device().ok_or(NO_ADAPTER)?;
                Some((crate::composite_job::align(gpu, pano, *shape)?, "align"))
            }
            Want::Analyse { volume_path } => {
                Some((crate::assembly_job::analyse(pano, volume_path)?, "analyse"))
            }
            Want::Seams {
                recipe,
                volume_path,
                picks,
            } => Some((
                crate::assembly_job::seams(recipe, volume_path, picks)?,
                "seams",
            )),
            Want::Render { .. } => None,
        };
        if let Some((answer, what)) = answered {
            outcome.composite = Some(answer);
            lap(what);
            return Ok(outcome);
        }
    }

    // The camera's own JPEG, where a target asks for it. No decode, no fit and no grade,
    // which is where the real speed of a grid tile lives - 18ms against a render's 1.7s.
    // That is a different *source*, not a different pipeline, and it is the only thing the
    // unification left alone.
    //
    // Every grid tile arrives with `Source::Embedded` whatever the library is set to: the
    // service decides that, not the library's `rendition_source`, which governs the photo
    // viewer alone (10.1). A file with no usable preview falls through to the render below,
    // which it could not do while the decode was gated on some *other* target wanting one.
    // The import's fused pass: one mmap and one decoder answering both the catalogue's fields and
    // the tile below, where a scan and a tile pass ask the same file the same questions twice.
    // Declared before the decoder, which borrows it, so it outlives it.
    let source = match job.scan {
        true => {
            rawler::rawsource::RawSource::new_lazy(std::path::Path::new(&job.raw_file_path)).ok()
        }
        false => None,
    };
    let decoder = match &source {
        Some(source) => rawler::get_decoder(source).ok(),
        None => None,
    };
    if let (Some(source), Some(decoder)) = (source.as_ref(), decoder.as_ref()) {
        outcome.header = crate::header::read_with(source, decoder.as_ref()).map(HeaderFields::from);
        lap("header");
    } else if job.scan && crate::decode_rendered::is_rendered(&job.raw_file_path) {
        // A finished picture is not rawler's, so the fused pass above found no decoder for it and
        // the catalogue's fields come off its container instead. Still without decoding a pixel:
        // every one of the three states its size in its first few kilobytes.
        outcome.header = crate::header::read_rendered(&job.raw_file_path).map(HeaderFields::from);
        lap("header");
    }
    // A scan that could not open the file at all has nothing to say about it, and must not go on
    // to render: the caller reads a missing header as "catalogue this the ordinary way".
    if job.scan && outcome.header.is_none() {
        return Ok(outcome);
    }

    // A fit and nothing else. The base is where the camera match is made, and everything after it
    // - the cut, the lens gather, the grade, the readback, the encode, the file - is a picture
    // this caller has not asked for. It still costs the decode, which is what a fit is measured
    // over; a smaller target would not have made that cheaper.
    if job.measure {
        let base = Base::build(job, 0)?;
        match base.frame {
            Cutting::OnDevice(frame) => frame.reclaim(),
            Cutting::AlreadyCut(mut cut) => cut.release(),
        }
        lap("measure");
        if base.analysis.adds_to(&base.stored) {
            outcome.photo_analysis = Some(crate::photo_analysis::encode(
                &base.analysis.filled_from(&base.stored),
            ));
        }
        return Ok(outcome);
    }

    let output_rotation = job.output_rotation()?;
    let mut rendered: Vec<&Target> = Vec::new();
    for target in &job.targets {
        // Never for a panorama: what a photograph's embedded target lifts is one JPEG out of one
        // file, and a panorama's is a composite of all of theirs. It has a fast path of its own
        // (`composite_tile::From::Camera`), reached through the render below.
        if job.composite.is_none()
            && target.source == Source::Embedded
            && target.output == Output::Srgb
        {
            // Extracted, decoded and shrunk inside one call, so the preview - which is
            // full resolution on a 61MP body, 5-14MB of JPEG - is never held whole.
            let size = target.size as usize;
            let want = crate::decode_rawler::Preview::SmallestCovering(size);
            let preview = crate::guard("the embedded preview", None, || {
                match (source.as_ref(), decoder.as_ref()) {
                    (Some(source), Some(decoder)) => {
                        crate::decode_rawler::upright_preview_rgb_with(
                            source,
                            decoder.as_ref(),
                            size,
                            want,
                        )
                    }
                    // A JPEG that arrived as itself *is* the camera's rendering, so the tile is a
                    // bounded decode of the file. Every other rendered format has no preview to
                    // lift and falls through to the render below, which is the same answer a RAW
                    // that embeds nothing gets.
                    _ if crate::decode_rendered::is_rendered(&job.raw_file_path) => {
                        crate::decode_rendered::preview_rgb(&job.raw_file_path, size)
                    }
                    _ => crate::decode_rawler::upright_preview_rgb(&job.raw_file_path, size, want),
                }
            });
            if let Some(preview) = preview {
                let image = crate::rgb::RgbRef {
                    width: preview.width,
                    height: preview.height,
                    data: &preview.data,
                };
                save_avif(image, target, output_rotation)?;
                describe_if_grid(image, target, &mut outcome);
                lap("embedded preview, encode, write");
                continue;
            }
            // Nothing to lift, and a scan may not demosaic to make up for it: this photograph
            // gets no tile here and the rendition pass builds one, with the settings a scan does
            // not carry (see `Job::scan`).
            if job.scan {
                continue;
            }
        }
        rendered.push(target);
    }
    if rendered.is_empty() {
        return Ok(outcome);
    }

    let (banded, whole): (Vec<&Target>, Vec<&Target>) =
        rendered.iter().partition(|target| is_banded(job, target));
    // A band cannot measure its own levels or peak; the 3840px target measures the photograph.
    let measuring = banded.first().map(|target| Target {
        rendition: target.rendition,
        output: target.output,
        output_path: String::new(),
        size: MEASURED_LONG_EDGE,
        source: Source::Render,
        sdr_quantizer: target.sdr_quantizer,
        hdr_quantizer: target.hdr_quantizer,
        preset: target.preset,
        still_full_chroma: true,
        sdr_full_chroma: true,
        intent: target.intent,
    });
    let mut first = whole.clone();
    if let Some(measuring) = &measuring {
        first.push(measuring);
    }

    // The waits a caller can be told about: the decode, the cut, and an encode per rendition.
    // Only where it asked, because the cell is one for the whole process (`crate::progress`) - a
    // rendition built in the background would otherwise count over a merge somebody is watching.
    if job.report_progress {
        crate::progress::begin(2 + first.len() + banded.len());
    }

    // Asked for below the loop above, so a job that renders nothing needs no adapter: a scan that
    // read a header, or one whose only target was lifted whole out of the camera's JPEG, is not a
    // photograph this refuses to catalogue on a machine with no Vulkan.
    crate::gpu::device().ok_or(NO_ADAPTER)?;
    let base = assembled(job, largest_size(&first), &first, None, &[])?;
    lap("decode, open");
    step(job);
    let measured = pollster::block_on(render(job, base, &first, |target, coded, width, height, options| {
        if measuring.as_ref().is_some_and(|value| std::ptr::eq(target, value)) {
            return Ok(());
        }
        write(coded, width, height, target, options, output_rotation, &mut outcome)
    }))?;
    outcome.photo_analysis = measured.owed;
    if banded.is_empty() {
        return Ok(outcome);
    }
    let held = match job.preserve_source_orientation {
        true => crate::decode::hold_path_unturned(&job.raw_file_path)?,
        false => pollster::block_on(crate::decode::hold_path(&job.raw_file_path))?,
    };
    lap("hold");
    for target in banded {
        pollster::block_on(bands(job, target, &held, &measured.known, measured.peak, output_rotation, &mut outcome))?;
        lap("bands, encode, write");
        step(job);
    }
    Ok(outcome)
}

/// The long edge a photograph is measured at where only windows of it are wanted: the bands of a
/// render, or a window of a level too large to decode whole (`picture::prepared`).
#[cfg(feature = "renditions")]
pub(crate) const MEASURED_LONG_EDGE: u32 = 3840;

/// Pixels past which a target is rendered a band at a time, of the frame it is drawn at or of the
/// decode it is drawn from: the whole-frame chain holds several frames of each on the device at
/// once.
#[cfg(feature = "renditions")]
pub(crate) const BANDED_PIXELS: usize = 128 << 20;

/// Output pixels in one band, before the margins its window grows by.
#[cfg(feature = "renditions")]
const BAND_PIXELS: usize = 16 << 20;

/// Whether `target` is rendered a band at a time ([`bands`]).
///
/// A photograph's own, and only where the chain would be over [`BANDED_PIXELS`]: a composite has
/// a tiled assembly and a size cap of its own.
#[cfg(feature = "renditions")]
fn is_banded(job: &Job, target: &Target) -> bool {
    if job.composite.is_some() {
        return false;
    }
    let header = match crate::decode_rendered::is_rendered(&job.raw_file_path) {
        true => crate::header::read_rendered(&job.raw_file_path),
        false => crate::header::read_path(&job.raw_file_path),
    };
    let Some(header) = header else {
        return false;
    };
    let photograph = (header.width as usize, header.height as usize);
    let drawn = drawn_size(job, photograph, &encode_options(job, target, &target.output_path));
    let scale = crate::view::Scale::for_long_edge(photograph, drawn.width.max(drawn.height));
    let decoded = scale.of(photograph.0) * scale.of(photograph.1);
    let (drawn_width, drawn_height) = (drawn.width as usize, drawn.height as usize);
    // A straighten's bounding box is larger than the frame it turns.
    let (out_width, out_height) = hdr::cropped_size(drawn_width, drawn_height, job.pixel_geometry());
    [drawn_width * drawn_height, decoded, out_width * out_height].into_iter().any(|pixels| pixels > BANDED_PIXELS)
}

/// Output rows in a band of `pixels`, within what a grid of them may be (`avif::encode_grid`): at
/// least 64 rows, at most 256 bands. A multiple of 64, so no tile the chroma leak is counted over
/// straddles two bands.
#[cfg(feature = "renditions")]
fn band_rows(width: usize, height: usize, pixels: usize) -> usize {
    let budget = (pixels / width.max(1)) / 64 * 64;
    budget.max(64).max(height.div_ceil(256).next_multiple_of(64))
}

/// One target, rendered a band of output rows at a time and written as a grid of them.
#[cfg(feature = "renditions")]
async fn bands(
    job: &Job,
    target: &Target,
    held: &crate::decode::Held,
    known: &crate::photo_analysis::PhotoAnalysis,
    scene_peak: Light<DisplayNits>,
    rotate: u16,
    outcome: &mut Outcome,
) -> Result<(), String> {
    let graded = graded_bands(job, target, held, known, scene_peak, BAND_PIXELS).await?;
    let (width, height) = graded.size;
    // A grid at 4:2:0 has no odd edge, where a single frame pads one itself.
    let odd = width % 2 == 1 || height % 2 == 1;
    let mut options = encode_options(job, target, &target.output_path);
    match target.output {
        Output::Pq => {
            if odd || graded.leak > CHROMA_LEAK_TILE_FRACTION {
                options.still_chroma = Chroma::Yuv444;
            }
            let bands = graded.bands.into_iter().filter_map(|band| match band {
                Coded::Pq(samples) => Some(samples),
                Coded::Srgb(_) => None,
            });
            hdr::encode_bands(bands.collect(), width, &options, rotate)
        }
        Output::Srgb => {
            let bands: Vec<Vec<u8>> = graded.bands.into_iter().filter_map(|band| match band {
                Coded::Srgb(samples) => Some(samples),
                Coded::Pq(_) => None,
            }).collect();
            if target.rendition == Rendition::Grid {
                let samples = bands.concat();
                describe_if_grid(
                    crate::rgb::RgbRef { width, height, data: &samples },
                    target,
                    outcome,
                );
            }
            crate::avif::save_rendition_bands(
                bands,
                width,
                target.sdr_quantizer,
                target.preset,
                target.sdr_full_chroma || odd,
                &target.output_path,
                rotate,
            )
        }
    }
}

#[cfg(feature = "renditions")]
pub(crate) struct Graded {
    pub(crate) size: (usize, usize),
    pub(crate) bands: Vec<Coded>,
    /// The worst 64-pixel tile's chroma leak over every band (`base::chroma_leak`), where the
    /// target is a PQ still that may be written 4:2:0.
    pub(crate) leak: f64,
}

/// [`bands`] up to the encode, in bands of about `pixels` output pixels.
#[cfg(feature = "renditions")]
pub(crate) async fn graded_bands(
    job: &Job,
    target: &Target,
    held: &crate::decode::Held,
    known: &crate::photo_analysis::PhotoAnalysis,
    scene_peak: Light<DisplayNits>,
    pixels: usize,
) -> Result<Graded, String> {
    let gpu = crate::gpu::device().ok_or(NO_ADAPTER)?;
    let base = crate::base::device(gpu).ok_or("the device the pipelines were built on")?;
    let photograph = held.size().raw();
    let options = encode_options(job, target, &target.output_path);
    let size = drawn_size(job, photograph, &options);
    let drawn = crate::px::Size::<crate::px::Drawn>::exact(size.width as usize, size.height as usize);
    let geometry = job.pixel_geometry();
    let out = hdr::cropped_out(drawn, geometry);
    let (out_width, out_height) = out.raw();
    let rows = band_rows(out_width, out_height, pixels);
    let analysis = with_camera_match(&crate::photo_analysis::encode(known), job.camera_match);
    let scale = crate::view::Scale::for_long_edge(photograph, size.width.max(size.height));
    let output = match target.output {
        Output::Pq => crate::gpu::Output::Pq,
        Output::Srgb => crate::gpu::Output::Srgb,
    };
    let peak = gpu.given_peak(scene_peak.raw() as f32);
    let mut leak: f64 = 0.0;
    let mut bands = Vec::with_capacity(out_height.div_ceil(rows));
    for top in (0..out_height).step_by(rows) {
        let rows = rows.min(out_height - top);
        let band = crate::gpu::Band { top: crate::px::Place::measured(top), rows: crate::px::Span::measured(rows) };
        let (left, top_read, width, height) = crate::image::rows_footprint(drawn, out, geometry, band).raw();
        let request = crate::tile::TileRequest {
            tile: [left, top_read, width, height],
            frame: [photograph.0, photograph.1],
            grade: job.grade,
            strengths: job.strengths(),
            denoise_luminance: job.denoise_luminance,
            denoise_colour: job.denoise_colour,
            denoiser: job.denoiser,
            dust: job.dust,
            adjust: job.adjust.clone(),
            levels: None,
            noise_fit: None,
            capture_sigma: None,
            sensor_long: None,
            defocus: crate::base::Defringe::Measure,
            photo_analysis: Some(analysis.clone()),
            scale,
            repairs: job.repairs.clone(),
            drawn: Some([drawn.width.raw(), drawn.height.raw()]),
        };
        let (frame, window) =
            crate::tile::prepared_on_device(crate::tile::Source::Held(held), &request).await?;
        let scene = window.scene(job.exposure, job.adjust.clone());
        let grade = crate::gpu::Grade {
            intent: target.intent,
            ..scene.gpu_grade(window.width, window.height, peak_nits(job, target), output)
        }
        .showing(geometry)
        .windowed(drawn, crate::px::At::exact(window.origin.0, window.origin.1))
        .banded(band);
        let frame = frame.into_frame();
        let up = gpu.upload_resident(&frame, &grade, &peak);
        let unread = "a band of the graded frame could not be read back";
        match target.output {
            Output::Pq => {
                bands.push(Coded::Pq(up.coded(&grade).await.ok_or(unread)?));
                if !target.still_full_chroma {
                    let coded = up.encoded_frame().ok_or("the encode left no frame on the device")?;
                    let band = crate::base::chroma_leak(gpu, base, coded, out_width, rows)
                        .await
                        .ok_or("the chroma leak could not be measured")?;
                    leak = leak.max(band);
                }
            }
            Output::Srgb => bands.push(Coded::Srgb(up.coded_bytes(&grade).await.ok_or(unread)?)),
        }
        drop(up);
        frame.reclaim();
    }
    Ok(Graded { size: (out_width, out_height), bands, leak })
}

/// One step of a job somebody is watching (`Job::report_progress`).
fn step(job: &Job) {
    if job.report_progress {
        crate::progress::advance();
    }
}

/// A photograph's targets, cut from its base and graded, each handed to `wrote` as it comes off the
/// device - and the analysis the job now owes the photograph, where it measured anything new.
///
/// **The half of a job a browser runs too.** Everything here is the device's; what differs between
/// the hosts is where the base came from and what `wrote` does with the pixels, which is an encode
/// and a file on a server and a frame sent to one from a page (`render_bytes`).
pub(crate) async fn render(
    job: &Job,
    base: Base,
    rendered: &[&Target],
    mut wrote: impl FnMut(&Target, Coded, usize, usize, &EncodeOptions) -> Result<(), String>,
) -> Result<Rendered, String> {
    let mut lap = crate::clock::laps("  job ");
    let gpu = crate::gpu::device().ok_or(NO_ADAPTER)?;

    // No `width`/`height`: a cut carries its own now, whichever arm below produced it.
    let Base {
        frame,
        width: _,
        height: _,
        levels,
        photograph,
        window,
        matched,
        mut analysis,
        stored,
        as_shot,
        capture_sigma,
        sensor_long,
        sharpen_noise,
        describes_the_photograph,
        // No window: a rendition is of the whole picture, and the crop it ships is taken here rather
        // than asked of the assembly (`Base::cropped`).
    } = base;
    // A window has been through the photograph's own gather already (`tile::prepared`), so there is
    // no lens left to apply to it.
    let lens = match window {
        Some(_) => None,
        None => matched.as_ref().map(|m| &m.lens),
    };

    // Largest first, so every smaller rendition is a downscale of one already cut rather
    // than its own resize, its own warp table and its own dispatch over the colour transform.
    let mut order: Vec<(&Target, hdr_args::Size)> = rendered
        .iter()
        .map(|target| {
            let options = encode_options(job, target, &target.output_path);
            // The *photograph's* size, which a rendition's own is a bound on - not the frame's,
            // which for a cropped render is only the part of it the crop reads.
            (*target, drawn_size(job, photograph, &options))
        })
        .collect();
    order
        .sort_by_key(|(_, size)| std::cmp::Reverse(u64::from(size.width) * u64::from(size.height)));

    // The scene, settled once: the camera's colour, the levels every rendition grades against
    // - which are the ones `Base::build` coded the frame with - and the photographer's
    // exposure. The levels stay unexposed and the gain moves against them, which is what
    // holds the colour still as it changes (`tone::SceneGrade`), and is why the exposure
    // belongs here rather than folded into the anchor the base was coded with.
    //
    // Refused rather than clamped where it is not positive: a gain of zero or less is not a
    // dark picture, it is a caller that sent stops where a multiplier belongs, and grading
    // every photo in the library black is a worse answer than saying so.
    if job.exposure.is_some_and(|exposure| !exposure.raw().is_finite()) {
        return Err(format!("an exposure is a number of stops: {:?}", job.exposure));
    }
    let scene = tone::SceneGrade::new(
        matched.as_ref().and_then(|m| m.colour.as_ref()),
        levels,
        job.grade.reference_white_nits,
        job.exposure,
        job.adjust.clone(),
        as_shot,
    );

    // Cut once off the base, sharpened once, and never brought over the bus: the grade reads
    // the same buffer the sharpen wrote, and a smaller rendition is resized from it in place.
    let mut cut = match frame {
        // Already cut, warped and sharpened by `tile::prepared`; running `from_base` over it would
        // resize the piece up to the photograph's own size.
        Cutting::AlreadyCut(cut) => cut,
        Cutting::OnDevice(frame) => {
            let size = order[0].1;
            let sigma = crate::image::deconvolve_split(
                capture_sigma,
                sensor_long,
                size.width.max(size.height) as usize,
            );
            let noise = sharpen_noise.at(
                crate::px::Span::<crate::px::Sensor>::exact(sensor_long),
                crate::px::Span::<crate::px::Drawn>::exact(
                    size.width.max(size.height) as usize,
                ),
            );
            let cut = hdr::Cut::from_base(frame, lens, size, job.sharpen, sigma, noise);
            repaired(&cut, job)?;
            cut
        }
    };
    gpu.settle();
    lap("resize, lens, sharpen");
    step(job);

    // **The frame goes up once per size, not once per rendition.** Two outputs of one size
    // differ by two words of a uniform; uploading 59MB at 3840 - 366MB at native - and
    // rebuilding the lattice, the curves and the output pair for each of them was most of
    // what a second target cost.
    // Measured on the first frame that goes up, which is the largest, and read by every
    // rendition after it. See `gpu::ScenePeak`.
    //
    // The photograph's own where it has one and this job is rendering at rest: the peak is read
    // *after* the exposure (`peak.slang`), so a job carrying a gain has to find its own, but every
    // other one gets the number every earlier render of this photograph rolled off against rather
    // than one measured off whatever frame this job happens to have cut.
    //
    // And only where this job's frame is that photograph: a composite of the cameras' own pictures
    // is coded against what the bodies printed white at rather than a quantile of the scene
    // (`composite_job::camera_levels`), so the knee a render of the RAWs rolled off against is not on
    // its scale. Both halves of the pair are gated, or the arm that is forbidden from filing a peak
    // would still be graded by one.
    let at_rest = job.exposure.is_none() && job.adjust == crate::gpu::Adjust::none();
    // The cache key omits match mode, so neutral peaks must not reuse or replace matched peaks.
    let keeps_peak = at_rest && describes_the_photograph && matched.as_ref().is_some_and(|m| m.colour.is_some());
    let known_peak = match keeps_peak {
        true => stored
            .from_render
            .scene_peak
            .and_then(|p| p.nits_at(job.grade.white_quantile, job.grade.reference_white_nits)),
        false => None,
    };
    let scene_peak = match known_peak {
        Some(nits) => gpu.given_peak(nits.raw() as f32),
        None => gpu.scene_peak(),
    };
    let mut uploaded: Option<crate::gpu::Uploaded<'_>> = None;
    for (index, (target, size)) in order.iter().enumerate() {
        let want = (size.width as usize, size.height as usize);
        // Never for a window: `Base::cropped` only takes that route when every target wants the
        // photograph at the size the sensor gives it, so there is nothing here to downscale.
        if window.is_none() && (cut.width, cut.height) != want {
            let smaller = cut.downscale(*size);
            cut.release();
            cut = smaller;
            uploaded = None;
            lap("downscale");
        }
        let mut options = encode_options(job, target, &target.output_path);
        let output = match target.output {
            Output::Pq => crate::gpu::Output::Pq,
            Output::Srgb => crate::gpu::Output::Srgb,
        };
        let mut grade = crate::gpu::Grade {
            intent: target.intent,
            ..scene.gpu_grade(cut.width, cut.height, peak_nits(job, target), output)
        }.showing(job.pixel_geometry());
        if let Some(window) = window {
            // Which takes the blur's scale with it. A *whole* frame keeps its own even when it has
            // been downscaled - at 1600 off a 3840 base the photograph is 1600 by then, and the
            // blur is a fraction of what the reader is given.
            grade = grade.windowed(window.photograph, window.origin);
        }
        let (out_width, out_height) = grade.output_size();
        let up = match &uploaded {
            Some(up) => up,
            None => uploaded.insert(match cut.resident() {
                Some(frame) => gpu.upload_resident(frame, &grade, &scene_peak),
                None => gpu.upload(
                    cut.host_samples()
                        .expect("a cut holds one frame or the other"),
                    &grade,
                    &scene_peak,
                ),
            }),
        };
        // Colour, roll-off and transfer, in one dispatch, from the frame the editor would
        // have handed the same shader - read back in the shape this output is written in, so an
        // eight-bit rendition never exists as sixteen (`Uploaded::encode_bytes`).
        let unread = "the graded frame could not be read back";
        let coded = match target.output {
            Output::Pq => Coded::Pq(up.coded(&grade).await.ok_or(unread)?),
            Output::Srgb => Coded::Srgb(up.coded_bytes(&grade).await.ok_or(unread)?),
        };
        lap("grade");
        // **Chroma is chosen by the frame, not by the setting alone.** 4:2:0 stores four pixels'
        // colour in four lumas and two chromas, and where a channel swings per pixel while
        // another does not - white sparkle on a red, a channel held near the PQ foot - the decode
        // hands two thirds of the swing to the wrong channel as speckle the frame never had.
        // `chroma_leak.slang` predicts that from the coded frame, and a still whose worst tile
        // would come back wrong is written 4:4:4 on its own, at the memory that costs, rather than
        // every still paying it or this one shipping speckled.
        if target.output == Output::Pq && !target.still_full_chroma {
            let base = crate::base::device(gpu).ok_or("the device the pipelines were built on")?;
            let coded = up
                .encoded_frame()
                .ok_or("the encode left no frame on the device")?;
            let leak = crate::base::chroma_leak(gpu, base, coded, out_width, out_height)
                .await
                .ok_or("the chroma leak could not be measured")?;
            if leak > CHROMA_LEAK_TILE_FRACTION {
                options.still_chroma = Chroma::Yuv444;
            }
            if crate::clock::watched() {
                eprintln!("  chroma leak {leak:.4}, {:?}", options.still_chroma);
            }
            lap("chroma leak");
        }
        // **The cut is handed back after the last grade that reads it.** The upload holds its own
        // count on the frame, so this only returns the memory once that goes too - but it is what
        // says the cut is finished with, and once every target left wants this same size nothing
        // reads it again.
        if order[index + 1..].iter().all(|(_, later)| later == size) {
            cut.release();
        }
        wrote(target, coded, out_width, out_height, &options)?;
        lap("encode, write");
        step(job);
    }

    // Dropped first: it borrows `scene_peak`, and the readback wants the buffer to itself.
    drop(uploaded);
    let peak: Light<DisplayNits> = match known_peak {
        Some(nits) => nits,
        None => Light::measured(f64::from(
            gpu.peak_of(&scene_peak).await.ok_or("the scene peak could not be read back")?,
        )),
    };
    // The peak the frames above rolled off against, kept so no later render of this photograph
    // measures its own - and so a rendition and the editor put the knee in the same place. Only
    // from a job at rest: `peak.slang` reads after the exposure, so a gain would store a peak that
    // belongs to this job's edit rather than to the scene.
    //
    // And only from a base that measured *this* photograph: a composite of the cameras' own
    // pictures did not (`Base::describes_the_photograph`).
    if known_peak.is_none() && keeps_peak {
        if peak.is_a_peak() {
            analysis.from_render.scene_peak = Some(crate::photo_analysis::MeasuredPeak {
                nits: peak,
                reference_white_nits: job.grade.reference_white_nits,
                white_quantile: job.grade.white_quantile,
            });
        }
        lap("scene peak");
    }
    let adds = analysis.adds_to(&stored);
    let known = analysis.filled_from(&stored);
    Ok(Rendered {
        owed: adds.then(|| crate::photo_analysis::encode(&known)),
        #[cfg(feature = "renditions")]
        known,
        #[cfg(feature = "renditions")]
        peak,
    })
}

pub(crate) struct Rendered {
    owed: Option<Vec<u8>>,
    #[cfg(feature = "renditions")]
    pub(crate) known: crate::photo_analysis::PhotoAnalysis,
    #[cfg(feature = "renditions")]
    pub(crate) peak: Light<DisplayNits>,
}

/// A graded frame off the device, in the depth its output is written at.
///
/// The shader writes one buffer whatever the output is, so an SDR rendition arrives as eight bits
/// in the low byte of each count - and `Uploaded::encode_bytes` is what takes them as bytes while
/// the readback is still mapped, rather than making a sixteen-bit copy of the whole picture to
/// convert from.
pub enum Coded {
    Pq(Vec<u16>),
    Srgb(Vec<u8>),
}

/// What travels in front of a rendition rendered on one host for another to encode.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderedHeader {
    width: usize,
    height: usize,
    output: Output,
    rotation: u16,
    /// The chroma leak's verdict (`render`), which only the host holding the frame could measure.
    full_chroma: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    photo_analysis: Option<Vec<u8>>,
}

/// A job's one rendition, rendered from the photograph's bytes and framed for the host that
/// encodes it: a `u32` little-endian header length, that much [`RenderedHeader`] JSON, zero padding
/// to a word (`edit::samples_at`), then the samples - eight bits each for sRGB, and for PQ twelve-bit
/// codes as every high byte followed by every low byte, which gzips far better than interleaved.
///
/// **What a browser renders for a server whose GPU is worse than its own.** It has no libavif, so the
/// picture crosses as the samples `write` would have encoded and [`write_rendered`] encodes them.
pub async fn render_bytes(job: &Job, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let [target] = job.targets.as_slice() else {
        return Err("a picture rendered for another host is one rendition at a time".into());
    };
    let rendered = [target];
    let base = single(job, Raw::Bytes(bytes), largest_size(&rendered), &rendered).await?;
    let mut graded = None;
    let photo_analysis = render(job, base, &rendered, |_, coded, width, height, options| {
        graded = Some((coded, width, height, options.still_chroma == Chroma::Yuv444));
        Ok(())
    })
    .await?
    .owed;
    let (coded, width, height, full_chroma) = graded.ok_or("the job rendered nothing")?;
    framed(
        &RenderedHeader {
            width,
            height,
            output: target.output,
            rotation: job.geometry.rotate,
            full_chroma,
            photo_analysis,
        },
        &coded,
    )
}

fn framed(header: &RenderedHeader, coded: &Coded) -> Result<Vec<u8>, String> {
    let text = serde_json::to_vec(header).map_err(|e| e.to_string())?;
    let at = crate::edit::samples_at(text.len());
    let samples = match coded {
        Coded::Pq(frame) => frame.len() * 2,
        Coded::Srgb(data) => data.len(),
    };
    let mut framed = Vec::with_capacity(at + samples);
    framed.extend_from_slice(&(text.len() as u32).to_le_bytes());
    framed.extend_from_slice(&text);
    framed.resize(at, 0);
    match coded {
        Coded::Pq(frame) => {
            framed.extend(frame.iter().map(|&v| (twelve_bit(v) >> 8) as u8));
            framed.extend(frame.iter().map(|&v| twelve_bit(v) as u8));
        }
        Coded::Srgb(data) => framed.extend_from_slice(data),
    }
    Ok(framed)
}

/// The largest PQ code a frame carries. Twelve bits because that is all the HDR encode keeps
/// (`avif::AVIF_DEPTH`): rounding here instead is a different encode of equal accuracy, and the
/// upload shrinks by a third.
const TWELVE_BIT_MAX: u32 = 4095;

fn twelve_bit(sample: u16) -> u16 {
    ((u32::from(sample) * TWELVE_BIT_MAX + 32767) / 65535) as u16
}

#[cfg(feature = "renditions")]
fn sixteen_bit(code: u16) -> Option<u16> {
    let code = u32::from(code);
    (code <= TWELVE_BIT_MAX).then(|| ((code * 65535 + TWELVE_BIT_MAX / 2) / TWELVE_BIT_MAX) as u16)
}

/// Encodes and writes what [`render_bytes`] framed, as `run` would have written the same target.
///
/// The job is the server's own, so the file, the quantizers and which range it is are this host's
/// to decide; the frame must fit the requested rendition size and dynamic range.
#[cfg(feature = "renditions")]
pub fn write_rendered(job: &Job, framed: &[u8]) -> Result<Outcome, String> {
    let [target] = job.targets.as_slice() else {
        return Err("a picture rendered elsewhere is written one rendition at a time".into());
    };
    let (header, coded) = unframed(framed)?;
    if header.output != target.output {
        return Err("this picture was rendered for the other dynamic range".into());
    }
    if header.rotation != job.output_rotation()? {
        return Err("this picture was rendered for another orientation".into());
    }
    if target.size != 0 && header.width.max(header.height) > target.size as usize {
        return Err("this picture exceeds the requested rendition size".into());
    }
    let size = hdr_args::Size { width: header.width as u32, height: header.height as u32 };
    if hdr_args::decodable(size) != size {
        return Err("this picture is larger than an AVIF can hold".into());
    }
    let mut options = encode_options(job, target, &target.output_path);
    if header.full_chroma {
        options.still_chroma = Chroma::Yuv444;
    }
    let mut outcome = Outcome::default();
    write(coded, header.width, header.height, target, &options, header.rotation, &mut outcome)?;
    outcome.photo_analysis = header.photo_analysis;
    Ok(outcome)
}

/// [`framed`]'s inverse, trusting nothing about a frame but its layout.
#[cfg(feature = "renditions")]
fn unframed(framed: &[u8]) -> Result<(RenderedHeader, Coded), String> {
    let length = framed
        .get(0..4)
        .map(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]]) as usize)
        .ok_or("this rendered picture came with no header")?;
    // Bounded before it is rounded up: the word came off a socket.
    let text = framed
        .get(4..4usize.saturating_add(length))
        .ok_or("this rendered picture's header runs past its buffer")?;
    let header: RenderedHeader = serde_json::from_slice(text)
        .map_err(|e| format!("this rendered picture's header is malformed: {e}"))?;
    let body = framed
        .get(crate::edit::samples_at(length)..)
        .ok_or("this rendered picture has no samples")?;
    let depth = match header.output {
        Output::Pq => 2,
        Output::Srgb => 1,
    };
    let wanted = header
        .width
        .checked_mul(header.height)
        .and_then(|pixels| pixels.checked_mul(3 * depth))
        .filter(|&bytes| bytes > 0)
        .ok_or("this rendered picture has no pixels")?;
    if body.len() != wanted {
        return Err(format!(
            "a {}x{} picture is {wanted} bytes and {} arrived",
            header.width,
            header.height,
            body.len()
        ));
    }
    let coded = match header.output {
        Output::Pq => {
            let (high, low) = body.split_at(body.len() / 2);
            Coded::Pq(
                high.iter()
                    .zip(low)
                    .map(|(&high, &low)| sixteen_bit(u16::from_be_bytes([high, low])))
                    .collect::<Option<_>>()
                    .ok_or("this rendered picture has a code past twelve bits")?,
            )
        }
        Output::Srgb => Coded::Srgb(body.to_vec()),
    };
    Ok((header, coded))
}

/// The transfer and the encode: all a rolled rendition has left.
#[cfg(feature = "renditions")]
fn write(
    coded: Coded,
    width: usize,
    height: usize,
    target: &Target,
    options: &EncodeOptions,
    rotate: u16,
    outcome: &mut Outcome,
) -> Result<(), String> {
    // The transfer already ran, in the same dispatch as the grade (`frame.slang::encode`), so
    // there is nothing left here but handing the bytes to an encoder.
    match coded {
        Coded::Pq(frame) => {
            hdr::encode_pq_frame_rotated(frame, width, height, options, rotate)?;
        }
        Coded::Srgb(data) => {
            let image = crate::rgb::RgbRef {
                width,
                height,
                data: &data,
            };
            save_avif(image, target, rotate)?;
            describe_if_grid(image, target, outcome);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_straightened_target_fits_the_avif_limit() {
        let mut job: Job = serde_json::from_str(
            r#"{
                "rawFilePath": "",
                "cameraMatch": "none",
                "sharpen": 0,
                "defringe": 0,
                "grade": { "peakNits": 1000, "referenceWhiteNits": 203, "whiteQuantile": 0.9 },
                "targets": [{
                    "rendition": "max", "output": "pq", "outputPath": "",
                    "size": 0, "source": "render", "sdrQuantizer": 20,
                    "hdrQuantizer": 20, "preset": 6,
                    "stillFullChroma": true, "sdrFullChroma": true
                }]
            }"#,
        )
        .expect("the target parses");
        let options = encode_options(&job, &job.targets[0], "");
        let in_limit = drawn_size(&job, (4000, 2000), &options);
        assert_eq!((in_limit.width, in_limit.height), (4000, 2000));

        job.geometry.angle_degrees = 5.0;
        let capped = drawn_size(&job, (32768, 8192), &options);
        assert!(capped.width < 32768);
        let (width, height) = hdr::cropped_size(
            capped.width as usize,
            capped.height as usize,
            job.pixel_geometry(),
        );
        let written = hdr_args::Size { width: width as u32, height: height as u32 };
        assert_eq!(hdr_args::decodable(written), written);
    }

    fn rendered(output: Output, width: usize, height: usize, samples: usize) -> Vec<u8> {
        let coded = match output {
            Output::Pq => Coded::Pq(vec![40_000; samples]),
            Output::Srgb => Coded::Srgb(vec![7; samples]),
        };
        let header = RenderedHeader {
            width,
            height,
            output,
            rotation: 0,
            full_chroma: true,
            photo_analysis: Some(vec![1, 2, 3]),
        };
        framed(&header, &coded).expect("the frame serialises")
    }

    #[cfg(feature = "renditions")]
    #[test]
    fn a_frame_from_an_old_client_cannot_acquire_rotation_twice() {
        let old = br#"{"width":2,"height":2,"output":"srgb","fullChroma":true}"#;
        let mut framed = (old.len() as u32).to_le_bytes().to_vec();
        framed.extend_from_slice(old);
        let error = unframed(&framed).err().expect("old header refused");
        assert!(error.contains("rotation"), "{error}");
    }


    #[cfg(feature = "renditions")]
    #[test]
    fn a_rendered_frame_reads_back_as_it_was_written() {
        let (header, coded) = unframed(&rendered(Output::Pq, 3, 2, 18)).expect("the frame reads");
        assert_eq!((header.width, header.height), (3, 2));
        assert!(header.full_chroma);
        assert_eq!(header.photo_analysis, Some(vec![1, 2, 3]));
        // 40000 is code 2499.43 of 4095, which crosses as 2499 and comes back as its sixteen bits.
        assert!(matches!(coded, Coded::Pq(samples) if samples == vec![39_993; 18]));
    }

    #[cfg(feature = "renditions")]
    #[test]
    fn every_twelve_bit_code_crosses_unchanged() {
        for code in 0..=TWELVE_BIT_MAX as u16 {
            let sixteen = sixteen_bit(code).expect("a twelve-bit code widens");
            assert_eq!(twelve_bit(sixteen), code);
        }
        assert_eq!(sixteen_bit(4096), None);
    }

    #[cfg(feature = "renditions")]
    #[test]
    fn a_rendered_frame_short_of_its_size_is_refused() {
        let mut short = rendered(Output::Srgb, 3, 2, 18);
        short.pop();
        assert_eq!(
            unframed(&short).err().as_deref(),
            Some("a 3x2 picture is 18 bytes and 17 arrived")
        );
    }

    #[cfg(feature = "renditions")]
    #[test]
    fn a_frame_rendered_for_the_other_range_is_not_written() {
        let job: Job = serde_json::from_str(
            r#"{
                "rawFilePath": "",
                "cameraMatch": "lensAndColour",
                "sharpen": 1,
                "defringe": 1,
                "grade": { "peakNits": 1000, "referenceWhiteNits": 203, "whiteQuantile": 0.9 },
                "targets": [{
                    "rendition": "full",
                    "output": "srgb",
                    "outputPath": "/nonexistent/full.avif",
                    "size": 3840,
                    "source": "render",
                    "sdrQuantizer": 20,
                    "hdrQuantizer": 20,
                    "preset": 6,
                    "stillFullChroma": false,
                    "sdrFullChroma": false
                }]
            }"#,
        )
        .expect("the job parses");
        assert_eq!(
            write_rendered(&job, &rendered(Output::Pq, 3, 2, 18)).err().as_deref(),
            Some("this picture was rendered for the other dynamic range")
        );
    }

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
                "cameraMatch": "lensAndColour",
                "tile": [100, 200, 256, 256],
                "noiseFit": {
                    "alpha": 0.0001502,
                    "sigmaSq": 0.0000011,
                    "unifiedSigma": 1.1928239,
                    "darkRef": [0.1, -0.02, 0.33, 0.4]
                },
                "levels": { "white": 8133.5, "peak": 13783, "floor": 141 },
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
        let level = Light::measured;
        assert_eq!(
            job.levels,
            Some(tone::Levels {
                white: level(8133.5),
                peak: level(13783.0),
                floor: Some(level(141.0)),
            })
        );
        assert_eq!(job.scene_peak, Some(Light::measured(4130.5)));
        assert_eq!(job.noise_fit.map(|fit| fit.alpha), Some(0.0001502));
        assert_eq!(job.exposure, Some(Stops::measured(0.5)));
    }

    #[test]
    fn a_job_preserves_null_and_explicit_exposure() {
        let mut value = serde_json::json!({
            "rawFilePath": "/library/a.arw", "cameraMatch": "lensAndColour", "targets": [],
            "sharpen": 0, "defringe": 0,
            "grade": { "peakNits": 1000, "referenceWhiteNits": 203, "whiteQuantile": 0.9 },
            "exposure": null
        });
        let rest: Job = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(rest.exposure, None);
        value["exposure"] = serde_json::json!(1.75);
        let moved: Job = serde_json::from_value(value).unwrap();
        assert_eq!(moved.exposure, Some(Stops::measured(1.75)));

        let mut value = serde_json::json!({
            "rawFilePath": "/library/a.arw", "cameraMatch": "lensAndColour", "targets": [],
            "sharpen": 0, "defringe": 0,
            "grade": { "peakNits": 1000, "referenceWhiteNits": 203, "whiteQuantile": 0.9 },
            "adjust": { "toneCurve": serde_json::to_value(crate::gpu::ToneCurve::PchipCbrt3 {
                points: crate::light::IDENTITY_CURVE.to_vec()
            }).unwrap() }
        });
        value["adjust"]["toneCurve"]["points"] = serde_json::json!([[0.5, 0.0], [0.4, 1.0]]);
        assert!(serde_json::from_value::<Job>(value).is_err());
    }
}
