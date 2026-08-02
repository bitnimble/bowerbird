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
use crate::hdr::Prepared;
use crate::hdr_fit::HdrMatch;
use crate::pack::Depth;
use crate::tone;
use serde::Deserialize;
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

/// What the browser has to say before the editor can grade the way a rendition does.
///
/// Every field here is settings the server reads from the library for its own renders
/// (`job::Job`), and the editor used to inline the shipping defaults for. That made a
/// library whose peak, anchor or denoise had been moved show one picture in the viewer
/// and a different one in the file it produced.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSpec {
    /// Longest edge the decode is fitted to on the way out of LibRaw, which is where the
    /// memory goes: the grade's cost is linear in pixels and a slider tick pays it.
    pub long_edge: u32,
    /// Longest edge a drag grades at. Resolution is the disposable part while the slider
    /// moves; tone and colour are not.
    pub interactive_edge: u32,
    pub grade: crate::hdr::Grade,
    /// The two denoises, the sharpen and the defringe, as the library has them set. The
    /// fit takes these without the sharpen, exactly as a rendition's does.
    pub strengths: crate::image::Strengths,
    pub sink: Sink,
    /// Whether a `VideoFrame` here will take ten bits. Only the video sink reads it, and
    /// it is a browser capability rather than a preference.
    pub ten_bit: bool,
}

/// How a graded frame leaves the module.
///
/// Browser capabilities rather than preferences, the same way `Depth` is; `raw_edit_route`
/// on the web side is what measures them and DESIGN 21.2 records what each measurement
/// found. Three engines, three answers, and no two of them take the same container.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Sink {
    /// Planes for a `VideoFrame`, which is Chromium: it takes 10 bits and composites a PQ
    /// track. No encode, no blob, no decode - the cheapest route there is.
    Video,
    /// A whole PNG, which is Safari. WebKit's `VideoFrame` validates I420 and NV12 alone,
    /// so a track there is 8-bit, and Apple's guidance for the layer behind a
    /// `MediaStream` is that sample buffers need 10 bits or more to reach EDR - a PQ tag
    /// on an 8-bit track is accepted and then tone-mapped, which on an XDR panel looks
    /// like a washed-out picture. A PNG goes through Core Graphics instead, which has no
    /// such floor and reads CICP.
    ///
    /// The better *frame* - 16-bit rather than 10, and no dither - and the worse *drag*,
    /// which is why the track stays the route wherever it is accepted. Measured in
    /// Chromium on a 45MP CR3, same decode and same grade either way: 12fps against 9,
    /// and a peak RSS of 841MB against 1435MB at 1920 (1.24GB against 2.17GB at 3840).
    /// The grade costs the same on both, so the gap is the emit - a PNG per tick is an
    /// encode, a blob and a browser-side decode.
    Still,
    /// A whole AVIF, which is Firefox, and the only sink here that pays for an encode.
    ///
    /// Gecko composites HDR through video and only video, and every route to a video
    /// frame in-page is capped at 8 bits - which it then will not composite either
    /// (measured against a 10-bit control on Windows). So the frame has to arrive as one
    /// its own decoder made, and the page rewraps this AVIF's AV1 into an MP4 to hand it
    /// over (`avif-hdr-video`, DESIGN 10.7.2) exactly as it already does for renditions.
    Avif,
}

/// The editor's own encode settings, which are not the library's.
///
/// A rendition is a file kept forever, so its quantizer is a size decision. This one
/// exists for the length of a slider tick and never reaches a disk, so size is free and
/// latency is the only cost: fastest speed, and a quantizer low enough to be judged on.
const AVIF_QUANTIZER: i32 = 10;
const AVIF_SPEED: i32 = 10;

/// 4:2:0, whatever the library's `sdr_full_chroma` says.
///
/// Not a quality decision: Firefox plays 4:4:4 AV1 in software and then will not
/// composite it in HDR (DESIGN 10.7), so full chroma here would trade a washed-out
/// picture for chroma nobody can see at a slider's resolution.
const AVIF_CHROMA: crate::hdr_args::Chroma = crate::hdr_args::Chroma::Yuv420;

/// Which prepared frame a tick grades from - the full one, or the cached smaller one a
/// drag can afford.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Resolution {
    Full,
    Interactive,
}

#[wasm_bindgen]
pub struct Editor {
    /// LibRaw's decode, and `None` once `release_source` has run. Needed only to build
    /// `prepared`, which is every stage a slider tick does not repeat.
    frame: Option<Frame>,
    /// The camera's whole match - colour and the lens it was fitted through - once
    /// `fit_camera_match` has been given a preview. Kept whole rather than reduced to its
    /// colour, because the warp runs before the grade and the curve was fitted from pairs
    /// that only correspond through it.
    matched: Option<HdrMatch>,
    /// The RAW's bytes, kept so the embedded preview and the lens record can be pulled
    /// out after the decode, and dropped by `release_source` once they have been.
    raw: Vec<u8>,
    /// Everything a rendition does before the grade, and none of it exposure-dependent.
    /// Rebuilt only when the match changes, so a slider tick pays for the grade alone.
    prepared: Prepared,
    /// A smaller copy of `prepared`, cached once so interactive edits can run the exact
    /// camera-space grade without paying for every output pixel.
    preview: Prepared,
    /// The grade works in place, so `prepared` is kept whole and this is what gets
    /// trampled each tick.
    working: Vec<u16>,
    output_size: (usize, usize),
    grade: crate::hdr::Grade,
    strengths: crate::image::Strengths,
    interactive_edge: usize,
    depth: Depth,
    sink: Sink,
    /// The finished frame in whichever container `sink` names - YUV planes, or a whole
    /// PNG or AVIF. Reused rather than returned, so a tick does not hold two 59MB copies.
    output: Vec<u8>,
}

#[wasm_bindgen]
impl Editor {
    /// Decodes a RAW from bytes, under the settings the library renders with.
    ///
    /// Seconds-scale work, so callers should keep it off the main thread; every `grade`
    /// afterwards is milliseconds. `spec` is `EditorSpec` as JSON - the same shape and
    /// the same route a rendition job takes over the FFI, so neither side can be given
    /// settings the other has not heard of.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8], spec: &str) -> Result<Editor, JsError> {
        report_panics();
        let spec: EditorSpec =
            serde_json::from_str(spec).map_err(|e| JsError::new(&format!("bad editor spec: {e}")))?;
        let interactive_edge = spec.interactive_edge as usize;

        let frame = crate::decode_frame_bytes(bytes, 16, true, spec.long_edge)
            .ok_or_else(|| JsError::new("LibRaw could not decode this file"))?;
        let (prepared, preview) =
            Editor::prepared_from(&frame, None, &spec.grade, interactive_edge)
                .ok_or_else(|| JsError::new("the decode was not 16-bit"))?;

        let mut editor = Editor {
            matched: None,
            raw: bytes.to_vec(),
            prepared,
            preview,
            working: Vec::new(),
            output_size: (0, 0),
            grade: spec.grade,
            strengths: spec.strengths,
            interactive_edge,
            depth: match spec.ten_bit {
                true => Depth::Ten,
                false => Depth::Eight,
            },
            sink: spec.sink,
            output: Vec::new(),
            frame: Some(frame),
        };
        editor.size_buffers();
        Ok(editor)
    }

    /// The exposure-independent stages, at full size and at the interactive one.
    ///
    /// `hdr::prepare` with no fit-to-size, because LibRaw already bounded the decode to
    /// `EditorSpec::long_edge`, and resampling again would only soften it.
    fn prepared_from(
        frame: &Frame,
        matched: Option<&HdrMatch>,
        grade: &crate::hdr::Grade,
        interactive_edge: usize,
    ) -> Option<(Prepared, Prepared)> {
        let source = crate::hdr::Source {
            samples: frame.samples16()?,
            width: frame.width,
            height: frame.height,
        };
        let prepared = crate::hdr::prepare(&source, None, grade, matched);
        let preview = prepared.shrunk_to(interactive_edge);
        Some((prepared, preview))
    }

    /// Sizes every buffer downstream of the prepared frame, which a new match resizes.
    fn size_buffers(&mut self) {
        self.working = vec![0u16; self.prepared.samples.len()];
        self.output_size = (self.prepared.width, self.prepared.height);
        // Planes are written into a buffer that has to exist first, and it is sized for
        // the largest grade so a preview can share it. An encoded file sizes itself.
        self.output = match self.sink {
            Sink::Video => vec![0u8; self.depth.plane_bytes(self.prepared.width, self.prepared.height)],
            Sink::Still | Sink::Avif => Vec::new(),
        };
    }

    /// 4:4:4 has a sample per pixel and a PNG has no constraint either, so neither route
    /// gives up the odd column 4:2:0 used to.
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> usize {
        self.prepared.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> usize {
        self.prepared.height
    }

    /// Longest edge the preview should be decoded to before being handed back.
    ///
    /// Fits the camera's colour from the embedded preview, and grades through it from here.
    ///
    /// Returns whether a match was found. False where the file embeds no preview, or where
    /// the fit found too few usable pairs - neither is an error, and the grade then takes
    /// the neutral arm exactly as a rendition does.
    ///
    /// **The preview is decoded here rather than by the browser.** It was `createImageBitmap`
    /// onto an `OffscreenCanvas` once, on the reasoning that the engine has a good decoder
    /// and the alternative was another codec in the module - but `crate::jpeg` is pure Rust
    /// and already compiled in, so there was no second codec to avoid, and the canvas was
    /// not the same decoder the server fits with. Measured: through the canvas this declined
    /// on both fixture bodies where the native fit matched, so every browser edit graded
    /// neutral - flatter and less saturated than the rendition beside it.
    pub fn fit_camera_match(&mut self) -> bool {
        let Some(frame) = self.frame.as_ref() else {
            return false;
        };
        let Some(samples) = frame.samples16() else {
            return false;
        };
        let Some(jpeg) = crate::embedded_jpeg_bytes(&self.raw) else {
            return false;
        };
        // Bounded on the way out, as `hdr::fit_all` bounds it: `hdr_fit` linearises the
        // preview whole into f64 before resampling, so a full-size one asks for 576MB -
        // fine on a server, and past what wasm32 will allocate.
        let Ok(preview) = crate::jpeg::decode(&jpeg, crate::hdr_fit::sample_long_edge()) else {
            return false;
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
        // Without the sharpen, which is what a rendition fits with too: it is a
        // deconvolution of the resample's blur, so it has not run yet at the point the
        // match is measured (`Strengths::before_the_fit`).
        self.matched = crate::hdr::fit_all_from_preview(
            &source,
            self.grade.white_quantile,
            geometry,
            self.strengths.before_the_fit(),
            &preview,
            recorded.lateral,
        )
        .map(|(_, matched)| matched);
        // The warp is the match's, so the prepared frame is stale the moment one is fitted.
        let rebuilt = self.frame.as_ref().and_then(|frame| {
            Editor::prepared_from(
                frame,
                self.matched.as_ref(),
                &self.grade,
                self.interactive_edge,
            )
        });
        if let Some((prepared, preview)) = rebuilt {
            self.prepared = prepared;
            self.preview = preview;
            self.size_buffers();
        }
        self.matched.is_some()
    }

    /// Drops the decode and the file, which nothing downstream of the open reads.
    ///
    /// `prepared` and `preview` are what a slider tick grades from, and both are built by
    /// `prepared_from`. Its inputs - LibRaw's frame and the RAW's own bytes - are then
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

    /// Re-grades at `ev` stops of exposure and leaves the result in `output`.
    ///
    /// Exposure moves the diffuse-white anchor rather than scaling the frame, which is
    /// what makes it read as stops: the grade ties `white` to 203 nits, so halving it is
    /// one stop up.
    pub fn grade(&mut self, ev: f32) {
        self.grade_from(Resolution::Full, ev);
    }

    /// The same grade on the cached interactive frame, for while the slider moves.
    ///
    /// Exposure enters before the fitted camera curve, so no transform of the finished
    /// PQ frame can reproduce it: multiplying display nits under-lifts this camera's
    /// shadows. Resolution is the disposable part during a drag; tone and colour are not.
    pub fn preview(&mut self, ev: f32) {
        self.grade_from(Resolution::Interactive, ev);
    }

    /// The one grade, so a drag and a settle cannot show different pictures.
    ///
    /// **From a prepared frame, not the decode.** A rendition runs fit-to-size, warp, and
    /// grade, and only the last depends on exposure; the first two are `prepared_from`,
    /// run once per open. Grading the *decode* would skip the warp, which is the bug this
    /// replaced: a curve fitted from warped pairs applied to unwarped pixels.
    ///
    /// The levels handed over are the frame's own and the stops go alongside them, which
    /// is what keeps the colour still as the slider moves. Dividing them here instead
    /// leaves the grade unable to tell an exposed frame from a dimmer one, and its three
    /// per-channel curves then rotate the hue - 59/1000 of chromaticity at p99 across
    /// half a stop, measured. `tone::GradeOptions::exposure` has the rest.
    fn grade_from(&mut self, resolution: Resolution, ev: f32) {
        let source = match resolution {
            Resolution::Full => &self.prepared,
            Resolution::Interactive => &self.preview,
        };
        let (width, height) = (source.width, source.height);
        // The interactive frame writes only the front of a buffer sized for the full one.
        let working = &mut self.working[..source.samples.len()];

        working.copy_from_slice(&source.samples);
        crate::hdr::grade_prepared(
            working,
            &self.grade,
            self.matched.as_ref(),
            source.levels,
            2f64.powf(f64::from(ev)),
        );
        tone::encode_pq(working, self.grade.peak_nits);
        crate::image::finish(working, width, height, self.strengths);

        self.output_size = (width, height);
        self.emit();
    }

    /// The one place the output is written, so interactive and full grades cannot
    /// diverge, and neither can the three containers.
    ///
    /// A failed encode leaves `output` empty rather than raising: the caller reads a
    /// pointer and a length, so a zero length is already the signal, and a slider tick is
    /// not somewhere to throw from.
    fn emit(&mut self) {
        // The grade wrote `output_size` pixels into the front of `working`, so the row
        // stride is its own width in every case.
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
            // The same call a rendition's still makes, under the same CICP. That is the
            // point of linking libavif into this module rather than reaching for a second
            // AV1 encoder: what the editor shows Firefox and what the library writes to
            // disk come out of one encoder.
            Sink::Avif => {
                let (primaries, transfer, matrix) = crate::hdr_args::cicp();
                let samples = &self.working[..width * height * 3];
                self.output = crate::avif::encode_still(
                    std::borrow::Cow::Borrowed(samples),
                    width,
                    height,
                    &crate::avif::StillOptions {
                        cicp: crate::avif::Cicp { primaries, transfer, matrix },
                        format: AVIF_CHROMA.avif_format(),
                        quantizer: AVIF_QUANTIZER,
                        speed: AVIF_SPEED,
                    },
                )
                .unwrap_or_else(|e| {
                    console_error(&format!("the editor could not encode an AVIF: {e}"));
                    Vec::new()
                });
            }
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
            Sink::Still | Sink::Avif => self.output.len(),
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

