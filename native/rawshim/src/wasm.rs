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

#[wasm_bindgen]
pub struct Editor {
    frame: Frame,
    width: usize,
    height: usize,
    levels: Levels,
    /// The camera's whole match - colour and the lens it was fitted through - once
    /// `fit_camera_match` has been given a preview. Kept whole rather than reduced to its
    /// colour, because `hdr::graded` applies the warp before the grade and the curve was
    /// fitted from pairs that only correspond through it.
    matched: Option<crate::hdr_fit::HdrMatch>,
    /// The RAW's bytes, kept so the embedded preview can be pulled out after the decode.
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
    planes: Vec<u8>,
}

#[wasm_bindgen]
impl Editor {
    /// Decodes a RAW from bytes. Seconds-scale work, so callers should keep it off the
    /// main thread; every `grade` afterwards is milliseconds.
    ///
    /// `long_edge` fits the decode on the way out, which is where the memory goes: the
    /// grade's cost is linear in pixels and it is what a slider tick pays for.
    /// `ten_bit` is a browser capability, not a preference.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8], long_edge: u32, ten_bit: bool) -> Result<Editor, JsError> {
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
            planes: Vec::new(),
            frame,
        };
        editor.prepare();
        Ok(editor)
    }

    /// Runs the two exposure-independent stages and sizes every buffer downstream of them.
    ///
    /// Called at open and again whenever the match changes, since the warp is the match's.
    fn prepare(&mut self) {
        let Some(samples) = self.frame.samples16() else {
            return;
        };
        let source = crate::hdr::Source {
            samples,
            width: self.frame.width,
            height: self.frame.height,
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
        // 4:2:0 has no odd dimensions, and `VideoFrame` refuses an odd frame outright.
        (self.width, self.height) = (width & !1, height & !1);
        let plane_bytes = self.depth.plane_bytes(self.width, self.height);
        self.planes = vec![0u8; plane_bytes];
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
        let Some(samples) = self.frame.samples16() else {
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
            width: self.frame.width,
            height: self.frame.height,
        };
        let recorded = crate::lens::read_distortion(&self.raw);
        let geometry = match (recorded.applied, recorded.spline) {
            (Some(false), _) => crate::fit::Geometry::Uncorrected,
            (_, Some(knots)) => crate::fit::Geometry::Recorded(knots),
            (_, None) => crate::fit::Geometry::Unstated,
        };
        self.matched = crate::hdr::fit_all_from_pixels(
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
    /// **Both levels move together**, which is the part that is easy to get wrong. The
    /// grade reads the roll-off out of `peak / white`, and `tone.rs` records that ratio
    /// as what makes the grade exposure-invariant - "a property of the scene". Scaling
    /// `white` alone silently changes it, so a slider meant to move brightness was also
    /// rewriting how hard the highlights compress: down at -4 EV the scene peak read
    /// sixteen times lower than it is, and the roll-off stopped engaging at all.
    pub fn grade(&mut self, ev: f32) {
        let stops = 2f64.powf(f64::from(ev));

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
            Levels {
                white: self.levels.white / stops,
                peak: self.levels.peak / stops,
            },
        );

        tone::encode_pq(&mut self.working, PEAK_NITS);
        crate::image::finish(
            &mut self.working,
            self.pq_size.0,
            self.pq_size.1,
            FINISH_STRENGTHS,
        );
        self.output_size = self.pq_size;
        self.repack();
    }

    /// Runs the exact shared grade on a cached 960px frame while the slider moves.
    ///
    /// Exposure enters before the fitted camera curve, so no transform of the finished
    /// PQ frame can reproduce it: multiplying display nits under-lifts this camera's
    /// shadows. Resolution is the disposable part during a drag; tone and colour are not.
    pub fn preview(&mut self, ev: f32) {
        let length = self.preview_prepared.len();
        self.working[..length].copy_from_slice(&self.preview_prepared);
        let stops = 2f64.powf(f64::from(ev));
        crate::hdr::grade_prepared(
            &mut self.working[..length],
            REFERENCE_WHITE_NITS,
            PEAK_NITS,
            self.matched.as_ref(),
            Levels {
                white: self.levels.white / stops,
                peak: self.levels.peak / stops,
            },
        );
        tone::encode_pq(&mut self.working[..length], PEAK_NITS);
        crate::image::finish(
            &mut self.working[..length],
            self.preview_size.0,
            self.preview_size.1,
            FINISH_STRENGTHS,
        );
        self.output_size = self.preview_size;
        self.repack();
    }

    /// The one place planes are written, so interactive and full grades cannot diverge.
    fn repack(&mut self) {
        let (source_width, source_height) = self.output_size;
        crate::pack::pack_i420(
            &self.working,
            source_width,
            source_width & !1,
            source_height & !1,
            self.depth,
            &mut self.planes,
        );
    }

    /// Where the planes live in wasm memory.
    ///
    /// The view JS builds over this must be rebuilt whenever wasm memory grows, since
    /// growing detaches every existing `ArrayBuffer` view.
    #[wasm_bindgen(getter)]
    pub fn planes_ptr(&self) -> *const u8 {
        self.planes.as_ptr()
    }

    #[wasm_bindgen(getter)]
    pub fn planes_len(&self) -> usize {
        self.depth
            .plane_bytes(self.output_width(), self.output_height())
    }

    #[wasm_bindgen(getter)]
    pub fn output_width(&self) -> usize {
        self.output_size.0 & !1
    }

    #[wasm_bindgen(getter)]
    pub fn output_height(&self) -> usize {
        self.output_size.1 & !1
    }
}
