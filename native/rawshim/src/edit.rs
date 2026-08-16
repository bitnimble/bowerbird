// The open half of the editor.
//
// Everything before the first slider tick - decode, prepare, fit the camera match,
// materialise the lens warp, denoise and sharpen - with none of the per-tick half, which
// runs as shader dispatches on the client (`docs/raw-edit-gpu.md` §6). What crosses is
// this module's `Prepared`: the coded frame the grade reads (`tone::encode_base`), plus the
// numbers the grade needs and cannot re-derive from pixels.
//
// This half is where the threads are worth having - measured at 3.2x between one and
// twelve - against a tick that is entirely the GPU's.

use crate::hdr::{self, Prepared as HdrPrepared};
use crate::hdr_fit::{ChromaMap, HdrColour};
use crate::image::Strengths;
use serde::{Deserialize, Serialize};

/// What the client has to be told to open a RAW, which is the library's settings and
/// nothing about this machine.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditRequest {
    /// Longest edge the decode is fitted to, which is the size every tick then grades.
    pub long_edge: u32,
    pub grade: hdr::Grade,
    pub strengths: Strengths,
    /// This photograph's camera match, where the caller has kept one.
    ///
    /// Half a second of fitting that depends on nothing but the file, so an open that is handed
    /// one skips it. A blob this build cannot read is ignored and the fit happens as it always
    /// did (`crate::camera_match`).
    #[serde(default)]
    pub camera_match: Option<Vec<u8>>,
}

/// The camera match, flattened into what a shader can index.
///
/// `HdrColour` carries `Vec<f64>` curves and an optional lattice; both become plain arrays
/// here because the client uploads them as buffers and reads them with the same
/// interpolation the CPU uses.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColourPayload {
    /// Per channel, `BINS` samples spanning render values 0 to `trustCeiling`.
    pub curves: [Vec<f32>; 3],
    pub matrix: [[f32; 3]; 3],
    pub saturation: f32,
    pub trust_ceiling: f32,
    /// Flattened `ChromaMap`, or `None` where the fit did not support one.
    pub chroma: Option<ChromaPayload>,
}

/// `ChromaMap`'s lattice, flat, with the axis constants the shader needs to walk it.
///
/// `NODE_VALUES` per node, level-major then `d2` then `d0`, which is the order `correct`
/// indexes them in. The scales travel with the nodes rather than being hardcoded on the
/// client so a change to the grid shape cannot leave the two disagreeing about which node
/// a colour belongs to.
///
/// The values per node are not sent. They follow from the grid's own dimensions, which
/// have to be right for the texture to exist, and the client holds the count it knows how
/// to read - so a server built against a different model is a length that does not divide
/// and a thrown error, rather than a field agreeing with itself while the array beside it
/// says otherwise. That failure is silent and looks like colour: five values read as four
/// land every node after the first one slot out.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromaPayload {
    pub nodes: Vec<f32>,
    pub chroma_count: u32,
    pub level_count: u32,
    pub chroma_low: f32,
    pub chroma_scale: f32,
    pub chroma_low_by: f32,
    pub chroma_scale_by: f32,
    pub level_scale: f32,
}

/// The header that travels in front of the samples.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHeader {
    pub width: usize,
    pub height: usize,
    /// `tone::Levels`: the frame's own diffuse white and peak, in input levels.
    pub white: f64,
    pub peak: f64,
    pub grade: hdr::Grade,
    pub strengths: Strengths,
    /// False where the file embeds no preview or the fit found too few pairs, in which
    /// case the client grades the neutral arm exactly as a rendition does.
    pub matched: bool,
    /// The illuminant the decode balanced against, which is the baseline the reader's
    /// temperature and tint move away from. None where the camera recorded no usable
    /// multipliers, and then the pair has nothing to mean and the panel says so.
    ///
    /// For the *panel*, which shows the reader where the sliders start. The grade reads it out
    /// of `tick` below rather than from here, so no arithmetic depends on this field.
    pub as_shot: Option<crate::white_balance::AsShot>,
    /// `struct Edit`, built by [`crate::gpu::uniform_words`], with everything the reader owns left
    /// at rest.
    ///
    /// **What makes the two hosts one implementation rather than two that agree.** The editor
    /// copies these words and overwrites only the exposure, the sliders, the region on screen
    /// and the canvas showing it; every other word - the levels, the camera match's shape, the
    /// peak's sampling stride - is this side's, byte for byte. It used to rebuild them from
    /// `colour` below, which is one frame described twice in two languages.
    pub edits: Vec<u32>,
    /// The working texture `detail.wgsl` blurs on, as `gpu::detail_size` sized it.
    ///
    /// Sent rather than recomputed for the same reason as `edits`: how large a share of the
    /// picture each blur covers follows from this, so a client that rounded it differently
    /// would apply a different clarity from the rendition and both would look like
    /// photographs.
    pub detail: crate::gpu::DetailSize,
    pub colour: Option<ColourPayload>,
    /// What the samples' own noise is, level by level, for the tick's denoise to shrink against.
    ///
    /// Measured here rather than on the client for the reason [`crate::noise`] gives: the
    /// estimator reduces every block in the frame before the first pixel can be denoised, which
    /// is a whole-frame pass the tick would otherwise repeat on every slider move.
    pub noise: crate::noise::Noise,
    /// The *mosaic's* noise, which is a different thing from `noise` above and for a different
    /// consumer: the client filters nothing with it and only hands it back on its loupe tile
    /// requests, so a tile is denoised at the strength its own export would use rather than at
    /// whatever its few hundred thousand photosites happen to imply.
    ///
    /// Absent where the decode had no adapter, which is the same case as a tile fitting its own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub noise_fit: Option<crate::galosh::NoiseFit>,
    /// The camera match this open had to fit, for the caller to keep beside the photograph.
    ///
    /// Absent where the caller supplied a usable one, so its presence means "this is new" and a
    /// caller can store it without first asking whether it already had it. About 5kB, and it is
    /// half a second off every later open, render and loupe tile of this photograph.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera_match: Option<Vec<u8>>,
    /// Bytes of `u16` little-endian RGB following the header.
    pub samples_len: usize,
}

pub struct Prepared {
    pub header: PreparedHeader,
    pub samples: Vec<u16>,
}

impl ColourPayload {
    fn from(colour: &HdrColour) -> Self {
        let curve = |c: usize| colour.curves[c].iter().map(|v| *v as f32).collect::<Vec<f32>>();
        ColourPayload {
            curves: [curve(0), curve(1), curve(2)],
            matrix: std::array::from_fn(|r| std::array::from_fn(|c| colour.matrix[r][c] as f32)),
            saturation: colour.saturation as f32,
            trust_ceiling: crate::hdr_fit::TRUST_CEILING as f32,
            chroma: colour.chroma.as_ref().map(ChromaPayload::from),
        }
    }
}

impl ChromaPayload {
    fn from(map: &ChromaMap) -> Self {
        let shape = map.shape();
        ChromaPayload {
            nodes: map.nodes_flat().iter().map(|v| *v as f32).collect(),
            chroma_count: shape.chroma_count as u32,
            level_count: shape.level_count as u32,
            chroma_low: shape.chroma_low[0] as f32,
            chroma_scale: shape.chroma_scale[0] as f32,
            chroma_low_by: shape.chroma_low[1] as f32,
            chroma_scale_by: shape.chroma_scale[1] as f32,
            level_scale: shape.level_scale as f32,
        }
    }
}

/// Decodes, prepares, fits and warps, leaving the frame a tick can grade from.
///
/// Prepare once to measure the levels, fit the match from the embedded JPEG, then rebuild
/// the prepared frame so the warp the match was fitted through is materialised into the
/// buffer the client uploads. Grading an unwarped frame through a curve fitted from warped
/// pairs is the bug that arrangement exists to prevent.
///
/// The page fetches the RAW from the library and prepares it in the tab, which is the point -
/// the RAW is tens of megabytes and the prepared frame is hundreds, so the smaller of the two
/// is the one worth putting on a network. Every host does this now, the desktop shell included;
/// what still calls the blocking form here is the fixture suite, where `prepare_bytes_async`
/// would want a runtime to no purpose.
pub fn prepare_bytes(bytes: &[u8], request: &EditRequest) -> Result<Prepared, String> {
    let _open = admit();
    pollster::block_on(open(bytes, request))
}

/// The same open, awaited, which is the only spelling a browser can take.
///
/// The decode's readback cannot be blocked for in a tab ([`crate::decode_rawler::decode_bytes_async`]),
/// and native drives this to completion without ever suspending - which is what lets the
/// blocking entry point above stay exactly as blocking as it was.
///
/// **No turn taken.** [`admit`]'s `Mutex` is held for the length of the open, which here means
/// across the decode's suspensions - and std's single-threaded mutex aborts rather than queues on
/// a second lock, so a page that opened a second photograph would take the module down with it.
/// A tab opens one photograph at a time and has no other opens to be bounded against.
pub async fn prepare_bytes_async(bytes: &[u8], request: &EditRequest) -> Result<Prepared, String> {
    open(bytes, request).await
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
    let guard = ONE_AT_A_TIME.lock().unwrap_or_else(|held| held.into_inner());
    let waited = asked.elapsed();
    // Reported, because an open that queues is indistinguishable from an open that is merely
    // slow from the outside, and the two want different answers: a reader waiting behind
    // somebody else's decode is the queue working, where a reader waiting alone is the decode
    // being slow. Only mentioned when it actually waited, so an idle server stays quiet.
    if waited > std::time::Duration::from_millis(50) {
        eprintln!("rawshim: an open waited {}ms for the one before it", waited.as_millis());
    }
    Turn { _guard: guard, began: elapsed_micros() }
}

/// Microseconds since the first turn was asked for, which is a clock two threads can compare.
///
/// `Instant` cannot be shared as a number, and a wall clock can step backwards. This only has
/// to order events inside one process.
fn elapsed_micros() -> u64 {
    static START: std::sync::OnceLock<crate::clock::Mark> = std::sync::OnceLock::new();
    START.get_or_init(crate::clock::Mark::now).elapsed().as_micros() as u64
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
        SERVED.lock().unwrap_or_else(|h| h.into_inner()).push((self.began, elapsed_micros()));
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
async fn open(bytes: &[u8], request: &EditRequest) -> Result<Prepared, String> {
    {
        // The same switch and the same shape as `decode_rawler::decode_source`, so an open reads
        // as one run of laps rather than as a decode that reports and a half that does not.
        let mut lap = crate::clock::laps("  open ");

        // `decode_frame_bytes` with 16-bit scene-linear Rec.2020 asked for, which is that
        // function's identity arm - reached directly because only this spelling can be awaited.
        let frame = crate::decode_rawler::decode_bytes_async(
            bytes,
            crate::galosh::Amounts::default(),
            request.long_edge,
            crate::galosh::Fit::Only,
        )
        .await
        .ok_or("the decoder could not read this file")?;
        lap("decode");
        let noise_fit = frame.noise;
        let samples = frame.samples16().ok_or("the decode was not 16-bit")?;
        let source = hdr::Source { samples, width: frame.width, height: frame.height };

        // The caller's stored match where it has one. Fitting is about half a second and
        // depends on nothing but the file, so an open that has been through this before is that
        // much faster to first pixel (`crate::camera_match`).
        let stored = request.camera_match.as_deref().and_then(crate::camera_match::decode);
        let had_one = stored.is_some();
        let matched = stored.or_else(|| fit(bytes, &source, request));
        // Reported back only where this open had to fit it, so its presence means "keep this"
        // rather than "here is the one you gave me".
        let keep = match had_one {
            true => None,
            false => matched.as_ref().map(crate::camera_match::encode),
        };
        lap(if had_one { "camera match (supplied)" } else { "camera match (fitted)" });
        let mut prepared = hdr::prepare(&source, None, &request.grade);
        lap("levels");

        // The same refusal `tone::grade` makes, and for the same reason: the grade divides
        // by diffuse white, and `tone::levels` reports zero when the white quantile lands on
        // level 0 - a frame that is essentially all black, a lens cap, a failed exposure.
        //
        // A rendition ships such a frame ungraded. The editor cannot: `white` crosses to the
        // shader, and both arms of the colour transform divide by it, so what the reader
        // would get is `level / 0` rolling every pixel to display peak and `0 / 0` leaving
        // the black ones indeterminate - a flat white canvas reporting itself live. Better
        // to say so.
        if prepared.levels.white <= 0.0 {
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
        // **The coding, the defringe and the warp over one resident frame.** Apart, each carried
        // 361MB up and back to run a few instructions a pixel, and the warp wired in alone measured
        // no faster than the CPU it replaced. `base::prepare` measures its own defocus off the
        // frame it has just coded, so nothing has to come back between the stages.
        let chained = match crate::gpu::device().and_then(crate::base::device) {
            Some(base) => {
                let gpu = crate::gpu::device().expect("the device the pipelines were built on");
                let (width, height) = (prepared.width, prepared.height);
                let none = crate::fit::Lens::none();
                crate::base::prepare(
                    gpu,
                    base,
                    &prepared.samples,
                    (width, height),
                    (width, height),
                    prepared.levels.anchored(),
                    request.grade.reference_white_nits,
                    request.strengths.before_the_fit(),
                    matched.as_ref().map_or(&none, |m| &m.lens),
                )
                .await
            }
            None => None,
        };
        if let Some(samples) = chained {
            prepared.samples = samples;
            lap("code, defringe, warp");
            crate::hdr::filter_base(
                &mut prepared.samples,
                prepared.width,
                prepared.height,
                Strengths { sharpen: request.strengths.sharpen, ..Default::default() },
            );
            lap("sharpen");
            let out =
                payload(prepared, matched.as_ref(), frame.as_shot, request, keep, noise_fit).await;
            lap("noise measure, header");
            return Ok(out);
        }

        crate::base::declined("the coding, the defringe and the lens warp");
        crate::tone::encode_base(
            &mut prepared.samples,
            prepared.levels.anchored(),
            request.grade.reference_white_nits,
        );
        // Filtered here, so a tick is the grade alone - and split around the warp, which is
        // where the two halves belong for reasons that have nothing to do with the editor
        // (`hdr::filter_base`). The denoise and the defringe read a frame whose noise is still
        // the sensor's, uniform across the field; the sharpen deconvolves the blur the warp's
        // own resample puts in, so it has to see that blur applied.
        let filter = |prepared: &mut HdrPrepared, strengths: Strengths| {
            crate::hdr::filter_base(
                &mut prepared.samples,
                prepared.width,
                prepared.height,
                strengths,
            )
        };
        filter(&mut prepared, request.strengths.before_the_fit());
        lap("code, defringe");
        if let Some(colour) = matched.as_ref() {
            if let Some(warped) = crate::hdr_fit::apply_lens(
                &prepared.samples,
                prepared.width,
                prepared.height,
                colour,
            )
            .await
            {
                prepared.samples = warped;
            }
        }
        lap("lens warp");
        filter(&mut prepared, Strengths { sharpen: request.strengths.sharpen, ..Default::default() });
        lap("sharpen");
        let out =
            payload(prepared, matched.as_ref(), frame.as_shot, request, keep, noise_fit).await;
        lap("noise measure, header");
        Ok(out)
    }
}

/// The camera match, or `None` where there is nothing to fit against.
///
/// Declining is not an error: `hdr::fit_all_from_preview` returns `None` for a file with
/// no embedded preview and for one whose fit found too few usable pairs, and the grade
/// then takes its neutral arm exactly as a rendition's does.
fn fit(
    raw: &[u8],
    source: &hdr::Source<'_>,
    request: &EditRequest,
) -> Option<crate::hdr_fit::HdrMatch> {
    // A decode narrower than the preview cannot be paired against it: `fit_plane` clamps
    // its target to the source's own width, so the two grids come out different sizes and
    // `pairs` asserts on it. Renditions never reach this because they decode at thousands
    // of pixels; the editor can, because the client asks for the size its stage can show
    // (`docs/raw-edit-gpu.md` §4.1). Declining is already a supported outcome - the grade
    // takes its neutral arm - so this is one more reason to decline rather than a failure.
    if source.width.max(source.height) < crate::hdr_fit::sample_long_edge() {
        return None;
    }
    let jpeg = crate::decode_rawler::upright_preview_jpeg_bytes(raw)?;
    // Bounded on the way out, as `hdr::fit_all` bounds it: the fit linearises the preview
    // whole into f64 before resampling, so a full-size one is 576MB.
    let preview = crate::jpeg::decode(&jpeg, crate::hdr_fit::sample_long_edge()).ok()?;
    let recorded = crate::lens::read_distortion(raw);
    // Three outcomes where `ffi::geometry_for` has four: no `Profiled`, so a lens with no
    // recorded spline is fitted from the picture rather than looked up in lensfun. Chosen,
    // not missed. The editor links no C at all - the whole crate does without the
    // `renditions` feature - and that is what makes the desktop and Android shells buildable
    // at all, since lensfun has no Android build and wants glib underneath it.
    //
    // Measured before it went: over 32 Canon frames lensfun is worth 0.049 luma levels of
    // 65535 against the fitted geometry, and the gap lives almost entirely in wide and
    // superzoom glass where the distortion is not a one-parameter shape. The editor never
    // consulted it on any platform, so nothing regressed; what a rendition still gets is the
    // fourth tier, and the two agree to within that.
    let geometry = match (recorded.applied, recorded.spline) {
        (Some(false), _) => crate::fit::Geometry::Uncorrected,
        (_, Some(knots)) => crate::fit::Geometry::Recorded(knots),
        (_, None) => crate::fit::Geometry::Unstated,
    };
    hdr::fit_all_from_preview(
        source,
        request.grade.white_quantile,
        geometry,
        // Without the sharpen, which is what a rendition fits with too: it deconvolves the
        // resample's blur and so has not run at the point the match is measured.
        request.strengths.before_the_fit(),
        &preview,
        recorded.lateral,
    )
    .map(|(_, matched)| matched)
}

async fn payload(
    prepared: HdrPrepared,
    matched: Option<&crate::hdr_fit::HdrMatch>,
    as_shot: Option<crate::white_balance::AsShot>,
    request: &EditRequest,
    // The match this open fitted, or None where the request carried a usable one.
    camera_match: Option<Vec<u8>>,
    noise_fit: Option<crate::galosh::NoiseFit>,
) -> Prepared {
    // The frame's own half of the uniform, in the units and the order the shader reads. At rest
    // on everything a tick moves: no gain, no adjustment, and the region and canvas the editor
    // fills in once it knows how big a stage it has.
    let identity = crate::hdr_fit::HdrColour::identity();
    let colour = matched.map(|m| &m.colour);
    let edits = crate::gpu::uniform_words(
        &crate::gpu::Grade {
            width: prepared.width,
            height: prepared.height,
            // The editor is handed the whole photograph, so the blur's scale is its own.
            photograph_long: prepared.width.max(prepared.height),
            colour,
            white: prepared.levels.white,
            source_level: prepared.levels.peak,
            reference_nits: request.grade.reference_white_nits,
            peak_nits: request.grade.peak_nits,
            exposure: 0.0,
            adjust: crate::gpu::Adjust::none(),
            as_shot,
            output: crate::gpu::Output::Pq,
        },
        colour.unwrap_or(&identity),
    );

    // **On the GPU, with the CPU behind it**, the same fall-through the coding and the warp take.
    // This was wired once before and taken back out at 987ms against the CPU's 958ms, its median
    // being a per-block selection sort that spilled every block to scratch; as `noise.wgsl`'s
    // `median96` it is 221ms against 910ms, and 227ms measured in this lap rather than alone. It is
    // the one stage that pays an upload and gets no readback, so that margin is the whole of its
    // case for being here.
    let measured = match crate::gpu::device().and_then(crate::base::device) {
        Some(base) => {
            let gpu = crate::gpu::device().expect("the device the pipelines were built on");
            crate::base::measure(gpu, base, &prepared.samples, prepared.width, prepared.height).await
        }
        None => None,
    };
    let noise = measured.unwrap_or_else(|| {
        crate::base::declined("the noise measure");
        crate::noise::measure(&prepared.samples, prepared.width, prepared.height)
    });

    let header = PreparedHeader {
        width: prepared.width,
        height: prepared.height,
        white: prepared.levels.white,
        peak: prepared.levels.peak,
        grade: request.grade,
        strengths: request.strengths,
        matched: matched.is_some(),
        as_shot,
        edits,
        detail: crate::gpu::detail_size(prepared.width, prepared.height),
        colour: matched.map(|m| ColourPayload::from(&m.colour)),
        // Last, on the buffer as it will be sent: the warp resamples and the sharpen amplifies,
        // and a tick denoises what comes out of both rather than what went into them.
        noise,
        noise_fit,
        camera_match,
        samples_len: prepared.samples.len() * 2,
    };
    Prepared { header, samples: prepared.samples }
}



/// The wire form: a little-endian `u32` header length, that many bytes of JSON, then the
/// samples as little-endian `u16`.
///
/// One buffer rather than two calls, because splitting the header into a second reply would
/// let the two disagree about which frame they describe. Both hosts that hand a frame to the
/// page - the shell over IPC, the module in the tab - come out of here, so the page has one
/// reader.
///
/// **The header is padded to four with spaces**, which JSON ignores and the reader depends
/// on: it leaves the samples on an offset a `Uint16Array` can be mapped over rather than
/// copied to. Padded here rather than by whoever serves it, because the alternative is what
/// the server used to do - take this apart and put it back together with the padding in,
/// which at 61MP is two 366MB copies and three of them alive at once for a reply that is one
/// buffer already.
///
/// Spaces, not NULs: the reader hands the whole padded span to `JSON.parse` rather than
/// trimming it, and a NUL is "Unrecognized token" where a space is JSON's own whitespace.
pub fn encode(prepared: &Prepared) -> Result<Vec<u8>, String> {
    let mut header = serde_json::to_vec(&prepared.header).map_err(|e| e.to_string())?;
    header.resize(header.len().next_multiple_of(4), b' ');

    let mut out = Vec::with_capacity(4 + header.len() + prepared.samples.len() * 2);
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    for sample in &prepared.samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A header of a given weight, so the padding can be swept across all four remainders.
    fn encoded(pixels: usize, matched: bool) -> Vec<u8> {
        let samples = vec![7u16; pixels * 3];
        let header = PreparedHeader {
            width: pixels,
            height: 1,
            white: 1000.0,
            peak: 4000.0,
            grade: hdr::Grade {
                peak_nits: 1000.0,
                reference_white_nits: 203.0,
                white_quantile: 0.995,
            },
            strengths: Strengths { sharpen: 1.0, defringe: 1.0 },
            matched,
            as_shot: Some(crate::white_balance::AsShot { temperature: 5200.0, tint: 4.0 }),
            // Long enough to weigh on the framing this test is about, and otherwise arbitrary:
            // what the words *are* is `gpu::uniform_words`' business.
            edits: vec![0; 48],
            detail: crate::gpu::detail_size(pixels, 1),
            colour: None,
            noise: crate::noise::measure(&samples, pixels, 1),
            noise_fit: None,
            camera_match: None,
            samples_len: samples.len() * 2,
        };
        encode(&Prepared { header, samples }).expect("encoding a frame")
    }

    fn described(framed: &[u8]) -> usize {
        u32::from_le_bytes([framed[0], framed[1], framed[2], framed[3]]) as usize
    }

    /// What the padding is for. The page maps a `Uint16Array` over the samples where they
    /// sit, which needs the offset they start at to be even - and it hands the whole padded
    /// span to `JSON.parse`, which needs the padding to be whitespace JSON accepts.
    ///
    /// Swept across widths so all four remainders are covered: at one width it is a coin toss
    /// whether any padding is emitted at all, which is how a wrong byte survives a green run.
    #[test]
    fn leaves_the_samples_where_the_page_can_map_over_them() {
        let mut remainders = std::collections::HashSet::new();
        for pixels in 1..=24 {
            let bytes = encoded(pixels, pixels % 2 == 0);
            let length = described(&bytes);
            assert_eq!(length % 4, 0, "header length {length} is not a multiple of four");
            assert_eq!((4 + length) % 2, 0, "the samples do not start on a u16 boundary");

            let text = std::str::from_utf8(&bytes[4..4 + length]).expect("the header is utf8");
            let parsed: serde_json::Value =
                serde_json::from_str(text).expect("the padded span parses as JSON");
            assert_eq!(parsed["width"], serde_json::json!(pixels));
            assert!(text.ends_with(|c: char| c == '}' || c == ' '), "padded with {text:?}");

            let json = serde_json::to_vec(&serde_json::from_str::<serde_json::Value>(text).unwrap())
                .unwrap();
            remainders.insert(json.len() % 4);
        }
        // The sweep really did cover every case rather than landing on one repeatedly.
        assert!(remainders.len() > 1, "every width padded the same way: {remainders:?}");
    }
}
