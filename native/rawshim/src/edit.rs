// The open half of the editor.
//
// Everything before the first slider tick - decode, prepare, fit the camera match,
// materialise the lens warp, denoise and sharpen - with none of the per-tick half, which is
// `gpu.rs` (`docs/gpu-editor.md`). What comes out is `Opened`: the coded frame the grade
// reads (`tone::encode_base`), left on the device, plus the numbers the grade needs and cannot
// re-derive from pixels.
//
// This half is where the threads are worth having - measured at 3.2x between one and
// twelve - against a tick that is entirely the GPU's.

use crate::hdr;
use crate::image::Strengths;
use serde::{Deserialize, Serialize};

/// What the client has to be told to open a RAW, which is the library's settings and
/// nothing about this machine.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditRequest {
    /// Longest edge the decode is fitted to, which is the size every tick then grades.
    pub long_edge: u32,
    pub grade: hdr::Grade,
    /// The library's defringe strength, which is the only filter this request decides.
    ///
    /// The sharpen is an argument to [`from_frame`] instead. It belongs to the Detail panel with
    /// the denoise pair, and those are already arguments here for the same reason: a request is
    /// what an open is *held* at, and a Detail slider moves without reopening anything.
    pub defringe: f64,
    /// What has already been measured about this photograph, where the caller kept it.
    ///
    /// The camera match is half a second, the noise fit a quarter of one, and neither depends on
    /// anything the reader can move - so an open that is handed them skips both. A blob this build
    /// cannot read is ignored and everything is measured as it always was
    /// (`crate::photo_analysis`).
    #[serde(default)]
    pub photo_analysis: Option<Vec<u8>>,
    /// The Detail sliders, which the open denoises the mosaic at exactly as a rendition does.
    ///
    /// Here rather than on the client because the denoise belongs on the mosaic, where the noise
    /// is still one photosite's own, and the mosaic exists only inside the decode
    /// (`job::Base::build` makes the same call).
    ///
    /// Null is the document not having said, which the decode answers with this frame's own
    /// measurement rather than with a number (`galosh::Detail`).
    #[serde(default)]
    pub denoise_luminance: Option<f64>,
    #[serde(default)]
    pub denoise_colour: Option<f64>,
    /// Which filter those two positions drive. Absent is the one every document had before there
    /// was a choice.
    #[serde(default)]
    pub denoiser: crate::galosh::Denoiser,
    /// The dust panel's switch and two sliders, which correct the mosaic where the denoise does.
    ///
    /// Here for the same reason the Detail pair is: the shadow is one number per photosite while the
    /// frame is still a mosaic, and three that disagree once RCD has interpolated between them.
    #[serde(default)]
    pub dust: crate::dust::Settings,
    /// The reader's repairs, which the open applies after the chain as every window does.
    #[serde(default)]
    pub repairs: Vec<crate::repair::Repair>,
    /// Diffuse white where a finished picture states it rather than where its histogram puts it:
    /// a rendition shown as it was encoded (`job::Job::stated_white`).
    #[serde(default)]
    pub stated_white: bool,
}

impl EditRequest {
    /// The Detail sliders as this document holds them, spelled as `job::Job::detail` spells it.
    pub fn detail(&self) -> crate::galosh::Detail {
        crate::galosh::Detail {
            luminance: self.denoise_luminance,
            colour: self.denoise_colour,
            denoiser: self.denoiser,
        }
    }

    /// What the caller already knows about this photograph, as far as this build can read it.
    pub fn stored(&self) -> crate::photo_analysis::PhotoAnalysis {
        self.photo_analysis
            .as_deref()
            .and_then(crate::photo_analysis::decode)
            .unwrap_or_default()
    }
}

/// What an open answers with: everything the page shows about the photograph, and nothing about
/// its pixels.
///
/// Read back as well as written, because a picture prepared elsewhere arrives with one of these in
/// front of its samples and this side is what draws it ([`crate::wasm::hold_picture`]). One shape
/// either way, so there is no second description of a photograph to keep in step.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHeader {
    pub width: usize,
    pub height: usize,
    /// `tone::Levels`: the frame's own diffuse white, peak and floor, in input levels.
    pub white: crate::light::Light<crate::light::Level>,
    pub peak: crate::light::Light<crate::light::Level>,
    /// Absent where the picture was prepared without a histogram walk behind it, and then a loupe
    /// tile handing these back is refused and measures its own ([`crate::tone::Levels::usable`]).
    pub floor: Option<crate::light::Light<crate::light::Level>>,
    pub grade: hdr::Grade,
    pub strengths: Strengths,
    pub camera_match: crate::hdr_fit::CameraMatch,
    /// False where the file embeds no preview or the fit found too few pairs, in which
    /// case the client grades the neutral arm exactly as a rendition does.
    pub matched: bool,
    /// Whether this photograph has a sensor mosaic behind it.
    ///
    /// False for a JPEG, a PNG, a HEIC or an AVIF, and it is what the Detail and Dust panels
    /// read: the denoise is fitted to a photosite's own noise on the CFA and the particle search
    /// reads the same lattice, so on a picture somebody else's camera has already demosaiced
    /// there is nothing for either to act on. A slider that silently does nothing is worse than
    /// one that is not offered.
    pub mosaic: bool,
    /// The illuminant the decode balanced against, which is the baseline the reader's
    /// temperature and tint move away from. None where the camera recorded no usable
    /// multipliers, and then the pair has nothing to mean and the panel says so.
    ///
    /// For the *panel*, which shows the reader where the sliders start. The grade reads it out
    /// of `tick` below rather than from here, so no arithmetic depends on this field.
    pub as_shot: Option<crate::white_balance::AsShot>,
    /// The two Detail positions this frame was actually filtered at, 0 to 100.
    ///
    /// **What the panel shows where the document has left a slider unset.** The ramp that turns a
    /// noise fit into a position is `galosh::NoiseModel::suggested_amounts`, and a second copy of
    /// it on the page would be a copy that drifts - so the decode that used it reports it, and the
    /// page reads a number rather than deriving one.
    pub detail: (f64, f64),
    /// The mosaic's noise, handed back on every loupe tile and every band of a re-prepare - so a
    /// crop is denoised at the strength its own export would use rather than at whatever its few
    /// hundred thousand photosites happen to imply.
    ///
    /// Absent where the decode had no adapter, which is the same case as a tile fitting its own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub noise_fit: Option<crate::galosh::NoiseFit>,
    /// The longitudinal aberration the defringe took off, handed back for the same reason as the
    /// fit above: it is read over the whole frame, so a loupe tile fitting its own is corrected by
    /// whatever its window's edges say, and neighbouring tiles by different amounts.
    pub defocus: (f32, f32),
    /// What is known about the photograph, to keep beside it. About 5kB, and it is most of a
    /// second off every later open, render and loupe tile.
    ///
    /// **Two callers fill it differently, and each has a reason.** A tab's own open reports only
    /// what it *gained* over what it was handed, so presence means "this is new" and the page can
    /// store it without asking whether it already had it. A prepare
    /// ([`crate::picture::prepared`]) reports the whole of it: its client sent nothing and holds
    /// nothing. The fitted camera match is in here; `camera_match` says which part this prepared
    /// picture applies without discarding a richer fit kept for later.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub photo_analysis: Option<Vec<u8>>,
    /// Where these samples sit in the picture, where they are a rectangle of a larger one.
    ///
    /// **None means the samples *are* the picture at their level**, which is what a tab's own open
    /// and a whole level both hand over - so a client reading this field is asking one question
    /// and getting one answer, rather than comparing `width` against a canvas it would have to be
    /// told separately.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<PreparedWindow>,
    /// The photograph these samples are of, at scale 1.
    ///
    /// **The size that does not move when a level does**, which is why it is beside `width` rather
    /// than derived from it. A page states the reader's own things against the photograph - the
    /// crop fractions, the region a zoom moves - and a page that measured the level instead would
    /// throw their zoom away each time a finer window of the same picture arrived.
    ///
    /// None for an open that holds the photograph itself, where `width`/`height` already are it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture: Option<(usize, usize)>,
    /// Which halving of the picture these samples are, where they are one.
    ///
    /// **A client cannot work it out and has to name it back.** Once it holds tiles of a level it
    /// asks for the ones it is missing *of that level*, and the only thing that says which level
    /// the tiles it is holding came from is this. Deriving it from `canvas` against `picture`
    /// would be a second implementation of `composite_job::sized`, rounding and composite ceiling and
    /// all, in the one place a disagreement puts a reader's tiles at the wrong scale.
    #[serde(default)]
    pub level: u32,
    /// Whether these samples are the photograph's own pixels, with no finer level to ask for.
    ///
    /// **Stated rather than inferred, because a client cannot work it out.** It knows what it
    /// asked for and what arrived, not how many halvings the picture has - so a client guessing
    /// either keeps asking for a picture it already holds, once per pan for the life of the open,
    /// or stops asking on a picture that had a finer level all along.
    #[serde(default)]
    pub finest: bool,
}

/// A prepared picture's place in the one it is a window of, at the level it was prepared at.
///
/// The recipe's canvas rather than the row's `width`/`height`: a composite's row holds what the
/// align's framing leaves, and the crop fractions are of the canvas. The two disagree by exactly
/// that framing, and applying it twice frames the picture at the square of it.
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedWindow {
    pub canvas: (usize, usize),
    pub origin: (usize, usize),
}

/// An open with its frame read back, for a caller that has nowhere to draw it ([`Opened::shipped`]).
pub struct Prepared {
    pub header: PreparedHeader,
    pub samples: Vec<u16>,
}

/// Where a framed picture's samples start, given the header length in its first word.
///
/// Stated once because `ffi::bb_prepare_picture` writes the frame and `wasm::hold_picture` reads
/// it, and a misread is not a wrong pixel but a picture of noise. Here rather than beside the
/// writer, which is behind a feature the reader is not.
pub fn samples_at(header_len: usize) -> usize {
    4 + header_len.next_multiple_of(4)
}

/// Decodes, prepares, fits and warps, leaving the frame a tick can grade from.
///
/// Prepare once to measure the levels, fit the match from the embedded JPEG, then rebuild
/// the prepared frame so the warp the match was fitted through is materialised into the
/// buffer the client uploads. Grading an unwarped frame through a curve fitted from warped
/// pairs is the bug that arrangement exists to prevent.
///
/// The page fetches the RAW from the library and opens it in the tab, which is the point - the
/// RAW is tens of megabytes and the prepared frame is hundreds, so the smaller of the two is the
/// one worth putting on a network. A browser takes [`open`] directly and keeps the frame on the
/// device; what calls this blocking form, which reads the samples back, is the fixture suite and
/// the benchmarks.
pub fn prepare_bytes(
    bytes: &[u8],
    request: &EditRequest,
    sharpen: f64,
) -> Result<Prepared, String> {
    let _open = admit();
    pollster::block_on(async {
        let opened = open(bytes, request, sharpen).await?;
        opened.shipped().await
    })
}

/// A turn to open something. One at a time, across every caller.
///
/// An open cannot be cancelled: a reader who opens the editor and changes their mind leaves
/// the decode running, because neither the browser abandoning a request nor Tauri dropping an
/// invoke reaches the thread already inside the decode. So what bounds this is how many can be
/// *underway*, and until now nothing did. Stepping through a few photographs and opening each
/// was that many full-sensor decodes at once, and at 61MP one of those is the decode plus an
/// f32 buffer of the same shape, well over a gigabyte.
///
/// Serialised rather than metered, because concurrency buys nothing here to trade away: the
/// work inside is already spread across every core by rayon, so a second open running beside
/// the first makes neither finish sooner and doubles what is held. Waiting is what a reader
/// would want even if memory were free.
///
/// Taken by the entry point and nowhere below it, which is what keeps a `Mutex` that does not
/// re-enter safe to hold across the whole open.
///
/// ponytail: a whole-process lock, so two libraries on one server queue behind each other
/// too. A permit count would let that through; nothing today has two.
fn admit() -> Turn {
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let asked = crate::clock::Mark::now();
    // A poisoned lock means a previous open panicked. That was reported to its own caller and
    // left nothing shared behind - the guard owns no data - so refusing every open after it
    // would turn one failure into a permanent one.
    let guard = ONE_AT_A_TIME
        .lock()
        .unwrap_or_else(|held| held.into_inner());
    let waited = asked.elapsed();
    // Reported, because an open that queues is indistinguishable from an open that is merely
    // slow from the outside, and the two want different answers: a reader waiting behind
    // somebody else's decode is the queue working, where a reader waiting alone is the decode
    // being slow. Only mentioned when it actually waited, so an idle server stays quiet.
    if waited > std::time::Duration::from_millis(50) {
        eprintln!(
            "rawshim: an open waited {}ms for the one before it",
            waited.as_millis()
        );
    }
    Turn {
        _guard: guard,
        began: elapsed_micros(),
    }
}

/// Microseconds since the first turn was asked for, which is a clock two threads can compare.
///
/// `Instant` cannot be shared as a number, and a wall clock can step backwards. This only has
/// to order events inside one process.
fn elapsed_micros() -> u64 {
    static START: std::sync::OnceLock<crate::clock::Mark> = std::sync::OnceLock::new();
    START
        .get_or_init(crate::clock::Mark::now)
        .elapsed()
        .as_micros() as u64
}

/// A turn at opening, held for as long as the open runs.
///
/// Records the interval it covered on the way out. That is what makes "one at a time" testable
/// without timing: two opens either overlap or they do not, and asking that is exact where
/// comparing their durations is a guess that gets worse the busier the machine is.
pub struct Turn {
    /// Held, not read: dropping it is what releases the next open.
    _guard: std::sync::MutexGuard<'static, ()>,
    began: u64,
}

impl Drop for Turn {
    fn drop(&mut self) {
        SERVED
            .lock()
            .unwrap_or_else(|h| h.into_inner())
            .push((self.began, elapsed_micros()));
    }
}

static SERVED: std::sync::Mutex<Vec<(u64, u64)>> = std::sync::Mutex::new(Vec::new());

/// Every turn taken so far, as the microsecond interval it covered.
///
/// For the test that asks whether two opens ran side by side. Kept behind the fixtures feature
/// so it is not a production surface: nothing outside a test has any business reading it.
#[cfg(feature = "fixtures")]
pub fn served() -> Vec<(u64, u64)> {
    SERVED.lock().unwrap_or_else(|h| h.into_inner()).clone()
}

/// The open itself, with the turn already taken.
async fn open(bytes: &[u8], request: &EditRequest, sharpen: f64) -> Result<Opened, String> {
    let stored = request.stored();
    // 16-bit scene-linear Rec.2020, which is what the whole pipeline below reads and what both
    // front ends produce - a RAW through the mosaic and a finished picture through its transfer.
    //
    // Denoised on the mosaic at the reader's own Detail, which is `job::Base::build`'s call: what
    // the editor shows and what the export ships are one pipeline because they are one line.
    let frame = crate::decode::frame_from_bytes(
        bytes,
        request.detail(),
        request.long_edge,
        crate::galosh::wanted(stored.from_raw.noise, request.detail()),
        // Detected here where the caller has never had this photograph looked at, and taken off the
        // sidecar where it has - a whole-frame read is most of a second, and nothing about which
        // particles are on the glass depends on anything a reader can move.
        request.dust.wanted(stored.from_raw.dust.as_deref()),
    )
    .await
    .ok_or("the decoder could not read this file")?;
    from_frame(
        frame,
        bytes,
        !crate::decode_rendered::is_rendered_bytes(bytes),
        request,
        sharpen,
    )
    .await
}

/// Everything an open does once it has a frame, which is everything a Detail amount cannot move.
///
/// **Split out so a caller holding a mosaic can re-run the pipeline without re-reading a file.**
/// The editor keeps a `decode_rawler::Held` for as long as a photograph is open and re-denoises a
/// copy of it when a slider moves; this is the half below that, and it is the same half a fresh
/// open runs, so the two cannot drift.
/// `mosaic` is whether the photograph has a sensor behind it, and `bytes` its file - which a
/// caller holding a finished picture is free to pass empty, since the only thing read out of it is
/// the preview a camera match is fitted against and there is none. Stated rather than sniffed
/// here: deriving it from the buffer is the same fact twice, and the second derivation is wrong
/// the moment a caller stops carrying the buffer.
pub async fn from_frame(
    frame: crate::frame::Frame,
    bytes: &[u8],
    mosaic: bool,
    request: &EditRequest,
    sharpen: f64,
) -> Result<Opened, String> {
    let strengths = Strengths {
        sharpen,
        defringe: request.defringe,
    };
    {
        // The same switch and the same shape as `decode_rawler::decode_source`, so an open reads
        // as one run of laps rather than as a decode that reports and a half that does not.
        let mut lap = crate::clock::laps("  open ");
        let noise_fit = frame.noise;
        let stored = request.stored();
        let as_shot = frame.as_shot;
        let stated_white = frame.white_to_anchor(request.stated_white)?;
        let (width, height) = (frame.width, frame.height);
        // The sigma above is in sensor pixels, and this frame's may not be: a decode that
        // halved hands the window machinery a frame at half the sensor's density.
        let sensor_long = width.max(height) * frame.reduced.max(1);

        // **The open, which is the same one a rendition makes** (`crate::open`): correct the frame
        // where a match is about to be fitted against it, then measure the match and the levels,
        // reading the frame back only where one of those two actually has to. It stays on the
        // device for the chain below either way.
        //
        // **Awaited, not blocked on.** This half runs in the browser through the wasm build, where
        // there is no thread to park: `pollster::block_on` compiles and then traps, and what a
        // reader sees is the editor reporting `failed` with `unreachable` behind it. Every readback
        // on this path is a future for that reason (`gpu::read_back`).
        let resident = frame.resident().ok_or("the decode is not on the device")?;
        let opening = crate::open::Opening {
            camera_match: crate::hdr_fit::CameraMatch::LensAndColour,
            grade: request.grade,
            strengths,
            stored: &stored,
            // No preview to fit against for a finished picture: what a JPEG or a HEIC *is* is
            // somebody's render, so there is no second rendering of the same frame to compare it
            // to and the grade takes its neutral arm.
            fitting: match mosaic {
                true => crate::open::Fitting::Preview(bytes),
                false => crate::open::Fitting::None,
            },
            noise: frame.noise,
            matrix: frame.matrix,
        };
        let crate::open::Measured {
            matched,
            levels,
            defringe,
            blur,
        } = crate::open::measure(resident, &opening).await?;
        lap("defringe, camera match, levels");
        let levels = match stated_white {
            Some(white) => levels.at_stated_white(white),
            None => levels,
        };
        // The frame's own where nothing was on file, in the sensor's pixels rather than this
        // decode's: the same scaling `sensor_long` above carries, for the same halving.
        let capture_sigma = stored
            .from_raw
            .capture_sigma
            .or_else(|| blur.map(|blur| blur * frame.reduced.max(1) as f32));

        // The grade divides by diffuse white, and `fit_scan` reports zero when the white
        // quantile lands on level 0 - a frame that is essentially all black, a lens cap, a
        // failed exposure.
        //
        // A rendition ships such a frame ungraded. The editor cannot: `white` crosses to the
        // shader, and both arms of the colour transform divide by it, so what the reader
        // would get is `level / 0` rolling every pixel to display peak and `0 / 0` leaving
        // the black ones indeterminate - a flat white canvas reporting itself live. Better
        // to say so.
        if levels.white <= crate::light::Light::ZERO {
            return Err("this frame is too dark to read an exposure from".to_string());
        }
        // Coded before anything reads it, exactly as `job::Base::build` codes it: what crosses
        // to the client is normalised PQ, and the shader's `nits_of_code` is the only thing
        // that undoes it. One coding on both hosts is the same argument as one grade.
        //
        // `anchored` is a formality here - the refusal above already turned away every white a
        // rendition would have had to floor - but it is what `encode_base` takes, and the
        // client is sent `prepared.levels` unfloored, so the two agree by that check rather
        // than by the floor.
        // **The rest is the chain every window goes through**, over a view that happens to be the
        // whole picture: the coding, the defringe, the photograph's own lens gather and the
        // sharpen. A loupe tile, a band of a re-prepare, a cropped rendition and this are one call
        // at four settings, which is the whole of what makes the editor show what the export ships.
        //
        // Whatever the decode found on the glass, taken before the frame is handed on: it is the
        // photograph's, so it belongs in the sidecar and in every later window's request.
        let mut frame = frame;
        let dust = frame.dust.take();
        // The match this open may have just fitted travels down as the analysis, because that is
        // where the window reads its lens from - handing it separately would be the same value
        // arriving two ways.
        let handed = crate::photo_analysis::encode(&crate::photo_analysis::PhotoAnalysis {
            from_raw: crate::photo_analysis::FromRaw {
                matched: matched.clone(),
                noise: noise_fit,
                dust: dust.clone(),
                capture_sigma,
                // Nothing to file: this caller holds the decode, so the window below is handed
                // the frame's own balance rather than reading one off a sidecar.
                balance: None,
            },
            ..Default::default()
        });
        let (resident, window) = crate::tile::prepared_on_device(
            crate::tile::Source::Frame(frame),
            &crate::tile::TileRequest {
                tile: [0, 0, width, height],
                frame: [width, height],
                grade: request.grade,
                strengths,
                denoise_luminance: request.denoise_luminance,
                denoise_colour: request.denoise_colour,
                denoiser: request.denoiser,
                // Off, and it has to be: this window is handed a frame the decode already
                // corrected, so asking again would divide every shadow out twice and leave a bright
                // disc where a dark one was. Spelled rather than defaulted, because the default is
                // the *reader's* starting position and that one is on.
                dust: crate::dust::Settings {
                    enabled: false,
                    ..Default::default()
                },
                // At rest: the reader's sliders are the tick's, and what they would widen here is
                // the window, which is already the whole picture.
                adjust: crate::gpu::Adjust::none(),
                levels: Some(levels),
                noise_fit,
                capture_sigma,
                sensor_long: Some(sensor_long),
                // The open's answer, whichever of the three it was: already off this very buffer
                // where the fit needed a defringed frame to read, the photograph's own pair where
                // one was on file, and otherwise the chain's to read for itself.
                defocus: defringe,
                photo_analysis: Some(handed),
                // Handed down with it: `handed` carries the field as whatever this build could
                // write, and where that is a picture this build cannot read back, the cells the
                // host decoded are the only copy of it there is.
                // The editor is handed the photograph at the size it asked the decode for, and the
                // decode has already halved it if it was going to.
                scale: crate::view::Scale::Full,
                repairs: request.repairs.clone(),
            },
        )
        .await?;
        lap("code, defringe, warp, sharpen");

        let header = payload(
            Framed {
                width: window.width,
                height: window.height,
                levels,
            },
            matched.as_ref(),
            as_shot,
            request,
            strengths,
            &stored,
            noise_fit,
            capture_sigma,
            window.defocus,
            dust,
            mosaic,
        )
        .await;
        lap("noise measure, header");
        Ok(Opened {
            frame: resident,
            header,
            levels,
            matched,
            as_shot,
        })
    }
}

/// The editor's open, with the frame left in the buffer the chain wrote it into.
///
/// **What the browser keeps for the life of an open.** The tick draws this frame onto the canvas
/// the page handed over, so it never crosses to the host at all - where the page's own copy of the
/// grade had to be given the samples, which is a `GPUDevice` boundary a frame cannot cross except
/// as bytes.
pub struct Opened {
    pub frame: crate::retouched_frame::RetouchedFrame,
    pub header: PreparedHeader,
    /// What the frame was coded against, which the tick's uniform anchors to.
    pub levels: crate::tone::Levels,
    pub matched: Option<crate::hdr_fit::HdrMatch>,
    pub as_shot: Option<crate::white_balance::AsShot>,
}

impl Opened {
    /// The open as a frame to send somewhere, which is what a host that does not draw it wants.
    ///
    /// The shell's route and the fixture suite: both hand the samples to something else, so the
    /// one transfer happens here rather than in the chain, and a browser never asks for it.
    pub async fn shipped(self) -> Result<Prepared, String> {
        let samples = self
            .frame
            .into_frame()
            .into_host()
            .await
            .ok_or("the prepared frame could not be read")?;
        Ok(Prepared {
            header: self.header,
            samples,
        })
    }
}

/// The frame the header describes, without the pixels it describes them for.
struct Framed {
    width: usize,
    height: usize,
    levels: crate::tone::Levels,
}

async fn payload(
    prepared: Framed,
    matched: Option<&crate::hdr_fit::HdrMatch>,
    as_shot: Option<crate::white_balance::AsShot>,
    request: &EditRequest,
    // What the frame was actually filtered at, which the request only half decides.
    strengths: Strengths,
    // What the request arrived carrying, so what this open measured can be reported as new.
    stored: &crate::photo_analysis::PhotoAnalysis,
    noise_fit: Option<crate::galosh::NoiseFit>,
    capture_sigma: Option<f32>,
    defocus: (f32, f32),
    dust: Option<Vec<crate::dust::Spot>>,
    mosaic: bool,
) -> PreparedHeader {
    // Everything this open now knows, against everything it was told. Reported only where it says
    // something new, so its presence means "keep this" rather than "here is what you gave me".
    let measured = crate::photo_analysis::PhotoAnalysis {
        from_raw: crate::photo_analysis::FromRaw {
            matched: matched.cloned(),
            noise: noise_fit,
            dust,
            capture_sigma,
            // A tab that opened the RAW reads the balance off its own decode on every tick, so
            // filing it would be storing what this side already has.
            balance: None,
        },
        from_render: crate::photo_analysis::FromRender {
            levels: Some(crate::photo_analysis::MeasuredLevels {
                levels: prepared.levels,
                white_quantile: request.grade.white_quantile,
            }),
            // The peak is measured on the host that grades, and that is the client here: it runs
            // `peak.slang` over the frame below and keeps the candidates a tick remeasures. What it
            // finds comes back through the API rather than out of this call.
            scene_peak: None,
            defocus: Some(crate::photo_analysis::MeasuredDefocus {
                red: defocus.0,
                blue: defocus.1,
                defringe: request.defringe,
                long_edge: prepared.width.max(prepared.height),
            }),
            // A client's own prepare is of a single file, which is the arm the gate takes it on.
            set: None,
        },
    };
    let photo_analysis = match measured.adds_to(stored) {
        true => Some(crate::photo_analysis::encode(&measured.filled_from(stored))),
        false => None,
    };

    PreparedHeader {
        width: prepared.width,
        height: prepared.height,
        white: prepared.levels.white,
        peak: prepared.levels.peak,
        floor: prepared.levels.floor,
        grade: request.grade,
        strengths,
        camera_match: crate::hdr_fit::CameraMatch::LensAndColour,
        matched: matched.is_some(),
        mosaic,
        as_shot,
        detail: request.detail().resolved(noise_fit),
        noise_fit,
        defocus,
        photo_analysis,
        // A tab's own open holds the whole photograph, which is the arm the gate takes it on: its
        // buffer is the picture, and there is no level for either of these to distinguish.
        window: None,
        picture: None,
        // A tab that decoded the RAW is holding every pixel there is of it, which is level zero
        // and the only level it will ever have.
        level: 0,
        finest: true,
    }
}
