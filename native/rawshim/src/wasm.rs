// The browser's view of rawshim: a RAW held open, re-graded on every slider tick.
//
// The decode happens once and its result stays resident as scene-referred linear; a tick
// costs the grade alone. That split is the point - a Lightroom slider is not re-reading
// the file, and neither is this.
//
// The decode and the grade are the *same code the renditions run*: `decode_with_libraw`
// for the pixels, `crate::tone` for the grade. What used to live in a separate wasm
// crate was a reimplementation of both, and it had already drifted twice - the grade lost
// the camera match, and the decode clipped highlights on the wrong side of the colour
// matrix and fringed blown skies magenta.
//
// **The camera match is fitted here too**, by `hdr_fit::fit` - the same function the
// renditions use, doing its own resample and blur in plain Rust, so there is no second
// resampler to drift against. The only step it cannot do is decode the camera's embedded
// JPEG, so `preview_jpeg` hands those bytes out, the browser decodes them, and
// `fit_camera_match` takes the pixels back.
//
// Without it the grade falls to its neutral arm - LibRaw's flat linear with a scale on
// it - and on a high-contrast frame that reads several stops brighter through the upper
// range than the camera's own shoulder would, because a linear ramp puts far more of the
// picture above diffuse white.
//
use crate::frame::Frame;
use crate::tone::{self, Levels};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(message: &str);
}

/// A panic in wasm reaches JS as a bare `RuntimeError: unreachable`, with the message left
/// on the Rust side. Six lines rather than a dependency on `console_error_panic_hook`,
/// which is all that crate does.
fn report_panics() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| console_error(&info.to_string())));
    });
}

#[wasm_bindgen]
pub fn thread_count() -> usize {
    crate::parallel::thread_count()
}

/// BT.2408 HDR Reference White and the display peak the roll-off targets - the same pair
/// the renditions use.
const REFERENCE_WHITE_NITS: f64 = 203.0;
const PEAK_NITS: f64 = 1000.0;
const INTERACTIVE_EDGE: usize = 960;

/// Quantile taken as diffuse white. The shipping default; the renditions read it from the
/// library's settings, which a preview has none of.
const WHITE_QUANTILE: f64 = 0.9;
const FINISH_STRENGTHS: crate::image::Strengths = crate::image::Strengths {
    luma: 0.5,
    chroma: 1.0,
    sharpen: 0.6,
    defringe: 1.0,
};

use crate::pack::Depth;

/// How a graded frame leaves the module.
///
/// A browser capability rather than a preference, the same way `Depth` is. WebKit's
/// `VideoFrame` validates I420 and NV12 alone, so a track there is 8-bit, and Apple's
/// guidance for the layer behind a `MediaStream` is that sample buffers need 10 bits or
/// more to reach EDR - a PQ tag on an 8-bit track is accepted and then tone-mapped, which
/// on an XDR panel looks like a washed-out picture. A still goes through Core Graphics
/// instead, which has no such floor and reads CICP.
///
/// The still is the better *frame* - 16-bit rather than 10, and no dither - but it is the
/// worse *drag*, which is why the track stays the route wherever it is accepted. Measured
/// in Chromium on a 45MP CR3, same decode and same grade either way: 12fps against 9, and
/// a peak RSS of 841MB against 1435MB at 1920 (1.24GB against 2.17GB at 3840). The grade
/// costs the same on both, so the gap is the emit - a PNG per tick is an encode, a blob
/// and a browser-side decode, and that churn is what the resident set is showing.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Sink {
    Video,
    Still,
}

#[wasm_bindgen]
pub struct Editor {
    /// LibRaw's decode, and `None` once `release_source` has run. Needed only to build
    /// `prepared`, which is every stage a slider tick does not repeat.
    frame: Option<Frame>,
    width: usize,
    height: usize,
    levels: Levels,
    /// The camera's whole match - colour and the lens it was fitted through - once
    /// `fit_camera_match` has been given a preview. Kept whole rather than reduced to its
    /// colour, because `hdr::graded` applies the warp before the grade and the curve was
    /// fitted from pairs that only correspond through it.
    matched: Option<crate::hdr_fit::HdrMatch>,
    /// The RAW's bytes, kept so the embedded preview and the lens record can be pulled
    /// out after the decode, and dropped by `release_source` once they have been.
    raw: Vec<u8>,
    /// The decode fitted to size and warped by the match's lens - everything a rendition
    /// does before the grade, and none of it exposure-dependent. Rebuilt only when the
    /// match changes, so a slider tick pays for the grade and nothing else.
    prepared: Vec<u16>,
    /// A smaller copy of `prepared`, cached once so interactive edits can run the exact
    /// camera-space grade without paying for every output pixel.
    preview_prepared: Vec<u16>,
    /// The grade works in place, so `prepared` is kept whole and this is what gets
    /// trampled each tick.
    working: Vec<u16>,
    /// `prepared`'s own width and height, which the fit-to-size decides and which
    /// `width`/`height` are the even-rounded version of.
    pq_size: (usize, usize),
    preview_size: (usize, usize),
    output_size: (usize, usize),
    depth: Depth,
    sink: Sink,
    /// The finished frame in whichever container `sink` names - YUV planes, or a whole
    /// PNG file. Reused rather than returned, so a tick does not hold two 59MB copies.
    output: Vec<u8>,
}

#[wasm_bindgen]
impl Editor {
    /// Decodes a RAW from bytes. Seconds-scale work, so callers should keep it off the
    /// main thread; every `grade` afterwards is milliseconds.
    ///
    /// `long_edge` fits the decode on the way out, which is where the memory goes: the
    /// grade's cost is linear in pixels and it is what a slider tick pays for.
    /// `ten_bit` and `still` are both browser capabilities, not preferences; `ten_bit` is
    /// read only on the video path, since a still is always 16-bit.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8], long_edge: u32, ten_bit: bool, still: bool) -> Result<Editor, JsError> {
        report_panics();
        let frame = crate::decode_frame_bytes(bytes, 16, true, long_edge)
            .ok_or_else(|| JsError::new("LibRaw could not decode this file"))?;
        let samples = frame
            .samples16()
            .ok_or_else(|| JsError::new("the decode was not 16-bit"))?;
        let levels = tone::levels(samples, WHITE_QUANTILE);

        let mut editor = Editor {
            width: 0,
            height: 0,
            levels,
            matched: None,
            raw: bytes.to_vec(),
            prepared: Vec::new(),
            preview_prepared: Vec::new(),
            working: Vec::new(),
            pq_size: (0, 0),
            preview_size: (0, 0),
            output_size: (0, 0),
            depth: match ten_bit {
                true => Depth::Ten,
                false => Depth::Eight,
            },
            sink: match still {
                true => Sink::Still,
                false => Sink::Video,
            },
            output: Vec::new(),
            frame: Some(frame),
        };
        editor.prepare();
        Ok(editor)
    }

    /// Runs the two exposure-independent stages and sizes every buffer downstream of them.
    ///
    /// Called at open and again whenever the match changes, since the warp is the match's.
    fn prepare(&mut self) {
        let Some(frame) = self.frame.as_ref() else {
            return;
        };
        let Some(samples) = frame.samples16() else {
            return;
        };
        let source = crate::hdr::Source {
            samples,
            width: frame.width,
            height: frame.height,
        };
        let (prepared, width, height) = crate::hdr::prepared_at(&source, self.matched.as_ref());
        self.prepared = prepared;
        let (preview, preview_width, preview_height) =
            crate::hdr::preview_prepared_at(&self.prepared, width, height, INTERACTIVE_EDGE);
        self.preview_prepared = preview;
        self.preview_size = (preview_width, preview_height);
        self.working = vec![0u16; self.prepared.len()];
        self.pq_size = (width, height);
        self.output_size = self.pq_size;
        // 4:4:4 has a sample per pixel and a PNG has no constraint either, so neither
        // route gives up the odd column 4:2:0 used to.
        (self.width, self.height) = (width, height);
        // Planes are written into a buffer that has to exist first, and it is sized for
        // the largest grade so a preview can share it. A PNG sizes itself as it is built.
        self.output = match self.sink {
            Sink::Video => vec![0u8; self.depth.plane_bytes(width, height)],
            Sink::Still => Vec::new(),
        };
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> usize {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> usize {
        self.height
    }

    /// Longest edge the preview should be decoded to before being handed back.
    ///
    /// The same number the renditions fit at. It is not a suggestion: `hdr_fit` linearises
    /// the preview whole into f64 before resampling, so a 24MP one asks for 576MB - fine
    /// on a server, and past what wasm32 will allocate.
    #[wasm_bindgen(getter)]
    pub fn preview_edge(&self) -> usize {
        crate::hdr_fit::sample_long_edge()
    }

    /// The camera's embedded JPEG preview, for the browser to decode.
    ///
    /// Empty where the file embeds none - some bodies embed a bitmap and some nothing,
    /// which is a property of the file rather than an error. The caller then grades
    /// neutral, exactly as a rendition does.
    pub fn preview_jpeg(&self) -> Vec<u8> {
        crate::embedded_jpeg_bytes(&self.raw).unwrap_or_default()
    }

    /// Fits the camera's colour from a decoded preview, and grades through it from here.
    ///
    /// `preview` is interleaved 8-bit RGB at any size - `hdr_fit` resamples to its own
    /// grid. Returns whether a match was found: too few usable pairs and it declines,
    /// which is the same fallback a rendition takes.
    pub fn fit_camera_match(&mut self, preview: &[u8], width: usize, height: usize) -> bool {
        if width == 0 || height == 0 || preview.len() < width * height * 3 {
            return false;
        }
        let Some(frame) = self.frame.as_ref() else {
            return false;
        };
        let Some(samples) = frame.samples16() else {
            return false;
        };
        let preview = crate::rgb::Rgb {
            width,
            height,
            data: preview[..width * height * 3].to_vec(),
        };
        // `hdr::fit_match_from` assembles the fit's inputs - the anchor's quantile and the
        // plane at twice the preview's width - so this does not. Reproducing those three
        // lines here is what produced a curve fitted at the wrong scale.
        let source = crate::hdr::Source {
            samples,
            width: frame.width,
            height: frame.height,
        };
        let recorded = crate::lens::read_distortion(&self.raw);
        let geometry = match (recorded.applied, recorded.spline) {
            (Some(false), _) => crate::fit::Geometry::Uncorrected,
            (_, Some(knots)) => crate::fit::Geometry::Recorded(knots),
            (_, None) => crate::fit::Geometry::Unstated,
        };
        self.matched = crate::hdr::fit_all_from_preview(
            &source,
            WHITE_QUANTILE,
            geometry,
            FINISH_STRENGTHS,
            &preview,
            recorded.lateral,
        )
        .map(|(_, matched)| matched);
        // The warp is the match's, so the prepared frame is stale the moment one is fitted.
        self.prepare();
        self.matched.is_some()
    }

    /// Drops the decode and the file, which nothing downstream of the open reads.
    ///
    /// `prepared` and `preview_prepared` are what a slider tick grades from, and both are
    /// built by `prepare`. Its inputs - LibRaw's frame and the RAW's own bytes - are then
    /// dead weight for the rest of the session, and not small: measured in Chromium on a
    /// 45MP CR3, dropping them takes 66MB off the resident set at 3840 and 32MB at 1920,
    /// on both routes.
    ///
    /// **Call once, after the last `fit_camera_match`.** A match rebuilds the prepared
    /// frame, so releasing before one is fitted would leave the grade on the neutral arm
    /// with no way back - which `fit_camera_match` then reports by declining, the same way
    /// it declines a file with no usable preview.
    pub fn release_source(&mut self) {
        self.frame = None;
        self.raw = Vec::new();
    }

    #[wasm_bindgen(getter)]
    pub fn matched(&self) -> bool {
        self.matched.is_some()
    }

    /// Re-grades at `ev` stops of exposure and leaves the result in `planes`.
    ///
    /// Exposure moves the diffuse-white anchor rather than scaling the frame, which is
    /// what makes it read as stops: the grade ties `white` to 203 nits, so halving it is
    /// one stop up.
    ///
    /// The levels handed over are the frame's own and the stops go alongside them, which
    /// is what keeps the colour still as the slider moves. Dividing them here instead
    /// leaves the grade unable to tell an exposed frame from a dimmer one, and its three
    /// per-channel curves then rotate the hue - 59/1000 of chromaticity at p99 across
    /// half a stop, measured. `tone::GradeOptions::exposure` has the rest.
    pub fn grade(&mut self, ev: f32) {
        // **From the prepared frame, not the decode.** A rendition runs three stages -
        // fit to size, warp by the lens the match was fitted through, then grade - and
        // only the third depends on exposure. The first two are `prepare`, run once per
        // open. Calling the grade alone on the *decode* would skip the warp, which is the
        // bug this replaced: a curve fitted from warped pairs applied to unwarped pixels.
        self.working.copy_from_slice(&self.prepared);
        crate::hdr::grade_prepared(
            &mut self.working,
            REFERENCE_WHITE_NITS,
            PEAK_NITS,
            self.matched.as_ref(),
            self.levels,
            2f64.powf(f64::from(ev)),
        );

        tone::encode_pq(&mut self.working, PEAK_NITS);
        crate::image::finish(
            &mut self.working,
            self.pq_size.0,
            self.pq_size.1,
            FINISH_STRENGTHS,
        );
        self.output_size = self.pq_size;
        self.emit();
    }

    /// Runs the exact shared grade on a cached 960px frame while the slider moves.
    ///
    /// Exposure enters before the fitted camera curve, so no transform of the finished
    /// PQ frame can reproduce it: multiplying display nits under-lifts this camera's
    /// shadows. Resolution is the disposable part during a drag; tone and colour are not.
    pub fn preview(&mut self, ev: f32) {
        let length = self.preview_prepared.len();
        let exposure = 2f64.powf(f64::from(ev));
        self.working[..length].copy_from_slice(&self.preview_prepared);
        crate::hdr::grade_prepared(
            &mut self.working[..length],
            REFERENCE_WHITE_NITS,
            PEAK_NITS,
            self.matched.as_ref(),
            self.levels,
            exposure,
        );
        tone::encode_pq(&mut self.working[..length], PEAK_NITS);
        crate::image::finish(
            &mut self.working[..length],
            self.preview_size.0,
            self.preview_size.1,
            FINISH_STRENGTHS,
        );
        self.output_size = self.preview_size;
        self.emit();
    }

    /// The one place the output is written, so interactive and full grades cannot
    /// diverge, and neither can the two containers.
    fn emit(&mut self) {
        // The grade wrote `output_size` pixels into the front of `working`, so the row
        // stride is its own width in both cases.
        let (width, height) = self.output_size;
        match self.sink {
            Sink::Video => {
                crate::pack::pack(&self.working, width, width, height, self.depth, &mut self.output)
            }
            Sink::Still => crate::png::encode_pq(
                &mut self.output,
                &self.working,
                width,
                width,
                height,
                crate::png::Bits::Sixteen,
            ),
        }
    }

    /// Where the finished frame lives in wasm memory.
    ///
    /// The view JS builds over this must be rebuilt whenever wasm memory grows, since
    /// growing detaches every existing `ArrayBuffer` view.
    #[wasm_bindgen(getter)]
    pub fn output_ptr(&self) -> *const u8 {
        self.output.as_ptr()
    }

    /// Not `output.len()` on the video path: that buffer is allocated once at the full
    /// grade's size and a preview writes only the front of it.
    #[wasm_bindgen(getter)]
    pub fn output_len(&self) -> usize {
        match self.sink {
            Sink::Video => self.depth.plane_bytes(self.output_size.0, self.output_size.1),
            Sink::Still => self.output.len(),
        }
    }

    #[wasm_bindgen(getter)]
    pub fn output_width(&self) -> usize {
        self.output_size.0
    }

    #[wasm_bindgen(getter)]
    pub fn output_height(&self) -> usize {
        self.output_size.1
    }
}

/// A two-patch reference at BT.2408 diffuse white and the display peak, PQ-tagged.
///
/// The one thing script cannot read back is whether a frame reached the HDR compositor,
/// so this exists to be looked at: on a working path the right half is obviously brighter
/// than paper white, and on a tone-mapped one the two patches sit a few percent apart.
/// Without it a dark photograph and a defeated PQ tag look the same.
///
/// The nits go through `tone::pq` rather than a pair of constants, so it cannot drift
/// from the transfer the photograph is graded with.
#[wasm_bindgen]
pub fn reference_png() -> Vec<u8> {
    const WIDTH: usize = 512;
    const HEIGHT: usize = 192;

    let level = |nits: f64| ((nits / PEAK_NITS) * f64::from(u16::MAX)).round() as u16;
    let mut patches = vec![0u16; WIDTH * HEIGHT * 3];
    for row in patches.chunks_exact_mut(WIDTH * 3) {
        for (x, pixel) in row.chunks_exact_mut(3).enumerate() {
            pixel.fill(match x < WIDTH / 2 {
                true => level(REFERENCE_WHITE_NITS),
                false => level(PEAK_NITS),
            });
        }
    }
    tone::encode_pq(&mut patches, PEAK_NITS);

    let mut out = Vec::new();
    crate::png::encode_pq(
        &mut out,
        &patches,
        WIDTH,
        WIDTH,
        HEIGHT,
        crate::png::Bits::Sixteen,
    );
    out
}
