// The decode, the fit and the grade, exposed as what the app actually wants rather
// than the twenty-odd C calls it once made to assemble them.
//
// Everything a frame needs happens on this side: as-shot white balance, the demosaic, the
// half-size decision, and the masked-border crop. JS gets one call and a pointer.
//
// `bb_` and `Bb` are short for Bowerbird. On the exported functions the prefix is
// not decoration: C has one flat symbol namespace, and this library is dlopen'd
// into a process that already holds libavif and libjxl, so a bare
// `decode` or `fit` would be an invitation. The `#[repr(C)]` types carry it too,
// against the usual rule of naming for behaviour rather than owner, only so that
// each pairs visibly with the symbol it crosses the boundary in - `BbHeader` with
// `bb_read_header`. Types that stay on this side are named normally.

#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case)]
// Unsafe is denied crate-wide and exempted one statement at a time, never one
// module or one function at a time. The three lints are a set and none of them
// does the job alone:
//
//   unsafe_code                   nothing may reach for unsafe unmarked.
//   unsafe_op_in_unsafe_fn        an `unsafe fn` body is not a blanket over its
//                                 contents, so each operation inside one needs its
//                                 own visible block and the surface stays
//                                 countable rather than being one marker per
//                                 function.
//   unfulfilled_lint_expectations paired with `#[expect(unsafe_code)]` rather than
//                                 `#[allow]`, this makes a *stale* exemption an
//                                 error too - so unsafe that gets refactored away
//                                 takes its marker with it in the same commit.
//
// Together they hold one invariant: the only things marked are those directly
// performing an unsafe operation. A caller cannot be marked to cover a callee, and
// a marker cannot outlive what it was for. `grep -rn "expect(unsafe_code)"
// native/*/src` is the audit.
//
// A marker counts one operation, not one block, so it measures the C surface rather
// than how much code sits inside a brace - and a `Drop` of two lines carries as much
// weight as a body of sixty. The number that has to keep falling is the calls
// themselves: `grep -rniE "destroy\(|_free\(|from_raw_parts" native/*/src`. The other
// crates hold the same three lints.
//
// The C handles are `formats`', each owned by a Rust value whose `Drop` frees it. What is
// left here is the irreducible part: reading the one command buffer at an entry
// point. Our own memory is
// marked nowhere - a `Frame` is an owned Rust value with a real lifetime, and the
// handle API that needs raw pointers for it sits behind a lint fence, for tests.
#![deny(unsafe_code)]
#![deny(unfulfilled_lint_expectations)]
#![deny(unsafe_op_in_unsafe_fn)]

#[cfg(feature = "renditions")]
use std::ffi::CStr;
#[cfg(feature = "renditions")]
use std::os::raw::c_char;
#[cfg(feature = "renditions")]
use std::os::raw::c_int;

/// The jobs an assembly asks for that render nothing: its analysis, and its seams.
#[cfg(feature = "renditions")]
pub mod assembly_job;
/// What a job asks of a composite: align a set of photographs, or render the recipe that came out.
///
/// The server's half, like `job` it hands its work to: the browser opens one photograph and has
/// no rendition to build, so a composite is not something it can be asked for.
#[cfg(feature = "renditions")]
pub mod composite_job;
#[cfg(feature = "renditions")]
pub mod debug;
#[cfg(all(test, feature = "renditions"))]
mod demosaic_tests;
#[cfg(test)]
mod grade_tests;
pub mod dereflect;
/// The editor's open half. The tick that follows it is the client's GPU.
pub mod edit;
#[cfg(feature = "renditions")]
pub mod ffi;
pub mod hdr;
pub mod hdr_args;
pub mod job;
#[cfg(feature = "renditions")]
pub mod lens_geometry;
pub mod open;
/// One picture of a recipe, coded and handed over, for a client that will grade it itself.
///
/// A rendition stopped one stage early, so a reader dragging a slider and the export they are
/// heading towards are the same picture.
#[cfg(feature = "renditions")]
pub mod picture;
pub mod pipelines;
pub mod scrub;
/// Test answers committed as PNGs a reader can open, and the side-by-side that shows one moving.
#[cfg(all(feature = "renditions", not(target_arch = "wasm32")))]
pub mod snapshot;
#[cfg(feature = "renditions")]
pub mod stacks;
pub mod tile;
pub mod tile_grid;
/// The viewer's stage drawn into an Android TV's window, which the shell calls.
#[cfg(all(feature = "renditions", target_os = "android"))]
mod tv_stage;
/// The browser's entry points, which no other host has.
#[cfg(target_arch = "wasm32")]
pub mod wasm;

/// Hands over the library's held log lines (see [`trace::warn`]), and from the first call on holds
/// them rather than printing them.
///
/// # Safety
/// `out` must be `cap` writable bytes.
#[expect(unsafe_code)]
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_take_log(out: *mut u8, cap: usize) -> usize {
    if out.is_null() {
        return 0;
    }
    let out = unsafe { std::slice::from_raw_parts_mut(out, cap) };
    trace::take_log(out)
}

/// Whether every stage lap goes to the held log as an info line, for a server logging at debug.
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn bb_log_laps(on: i32) {
    trace::clock::log_laps(on != 0);
}

/// A panic's message, for [`trace::warn`]'s reason: without one the page is told `unreachable` and
/// nothing else - not the assertion, not the file, not the line, only the trap the panic ends in.
///
/// At module init, so it covers every entry point rather than the one that remembered to ask.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn announce_panics() {
    std::panic::set_hook(Box::new(|panicked| {
        trace::warn(&format!("rawshim: {panicked}"))
    }));
}

/// How long a call that lost the GPU waits before each run again, and so how many it gets.
#[cfg(not(target_arch = "wasm32"))]
const GPU_LOST_RETRIES: [std::time::Duration; 2] = [
    std::time::Duration::from_secs(2),
    std::time::Duration::from_secs(8),
];

/// Runs `body`, turning a panic into `fallback` rather than letting it out of the
/// library.
///
/// Every `bb_*` entry point is `extern "C"`, and a panic that reaches one of those
/// aborts the process - not this call, the whole of it, which here means the server and
/// every worker in it, with no Rust error string and nothing on stderr but the abort.
/// One frame that trips an index takes down an import of fifty thousand.
///
/// Applied to the entry points that run code rather than to all of them, and the line
/// is meant: the accessors that only report a `size_of`, and the frees that only take a
/// `Box` back, have nothing in them that can panic. Anything that touches a pixel, a
/// path or a parse is wrapped.
///
/// `AssertUnwindSafe` because the alternative is threading `UnwindSafe` through raw
/// pointers that are already the caller's responsibility. What it gives up - seeing a
/// half-updated value after a panic - is not available here anyway: every one of these
/// reports failure and hands back nothing.
///
/// A call that loses the device it ran on runs again, after [`GPU_LOST_RETRIES`], on the device
/// [`gpu::device`] opens in its place: whatever it returned came off a GPU that stopped partway.
pub(crate) fn guard<T>(what: &str, fallback: T, body: impl FnMut() -> T) -> T {
    #[cfg(not(target_arch = "wasm32"))]
    let outcome = rerun_on_loss(
        what,
        || gpu::dispatch::LOSSES.load(std::sync::atomic::Ordering::Relaxed),
        &GPU_LOST_RETRIES,
        body,
    );
    #[cfg(target_arch = "wasm32")]
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
    match outcome {
        Ok(value) => value,
        Err(panicked) => {
            let why = panicked
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| panicked.downcast_ref::<String>().map(String::as_str))
                .unwrap_or("no message");
            trace::warn(&format!(
                "rawshim: {what} panicked ({why}); reporting failure rather than aborting the process"
            ));
            fallback
        }
    }
}

/// `body`, run again after each of `waits` for as long as `losses` moves while it runs.
#[cfg(not(target_arch = "wasm32"))]
fn rerun_on_loss<T>(
    what: &str,
    losses: impl Fn() -> u64,
    waits: &[std::time::Duration],
    mut body: impl FnMut() -> T,
) -> std::thread::Result<T> {
    let mut waits = waits.iter();
    loop {
        let before = losses();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(&mut body));
        let Some(wait) = (losses() != before).then(|| waits.next()).flatten() else {
            return outcome;
        };
        trace::warn(&format!(
            "rawshim: {what} lost the GPU; running it again in {}s",
            wait.as_secs()
        ));
        std::thread::sleep(*wait);
    }
}

/// Hands the pages a finished call freed back to the system, unless a render queue is holding
/// memory for its next render ([`bb_hold_render_memory`]). For the end of an entry point that
/// worked on whole frames.
#[cfg(feature = "renditions")]
#[cfg_attr(all(target_os = "linux", target_env = "gnu"), expect(unsafe_code))]
pub(crate) fn release_freed_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        if denoise::pmrid::arenas_held() {
            return;
        }
        unsafe extern "C" {
            fn malloc_trim(pad: usize) -> std::ffi::c_int;
        }
        // glibc keeps a freed frame in the arena of whichever thread allocated it, one arena per
        // thread up to eight per core, so without this a server's heap grows to every render
        // thread's peak at once and stays there.
        // SAFETY: takes no pointers, and walks only the allocator's own state under its locks.
        unsafe {
            malloc_trim(0);
        }
    }
}

// **The denoise is not scaled by the frame's ISO.** Shot noise does go as its square root, but
// the ISO is what the body was set to rather than what the sensor did, and it says nothing about
// a pushed exposure. It is fitted off the mosaic instead (`galosh::NoiseModel`, carried on the
// frame), which needs no reference ISO, no cap, and no special case for a body that records
// nothing.

/// Decodes a RAW to an owned frame.
///
/// Every caller on this side wants a `Frame`; only the FFI boundary wants a pointer, and it is
/// the one place that builds one.
pub fn decode_frame(path: &str, at_least_long_edge: u32) -> Option<decode::frame::Frame> {
    decode_frame_via(
        DecodeSource::Path(path),
        at_least_long_edge,
        denoise::galosh::Detail::at(0.0, 0.0),
    )
}

/// The same decode, with the mosaic denoised before it is demosaiced.
///
/// `fit` is whose statistics it filters with: [`denoise::galosh::Fit::Given`] where the caller has the
/// photograph's already, which is a quarter of a second of whole-frame reductions it does not pay
/// again (`fit::photo_analysis`).
pub fn decode_frame_denoised(
    path: &str,
    at_least_long_edge: u32,
    detail: denoise::galosh::Detail,
    fit: denoise::galosh::Fit,
) -> Option<decode::frame::Frame> {
    decode_frame_cropped(
        DecodeSource::Path(path),
        at_least_long_edge,
        detail,
        None,
        fit,
    )
}

/// `fit` is what the decode does about the noise, and only an in-memory decode is ever asked:
/// [`denoise::galosh::Fit::Only`] measures the frame without filtering it, which is the editor's open, and
/// the measurement rides back on `frame.noise` for the loupe tiles that follow.
pub fn decode_frame_bytes(
    bytes: &[u8],
    at_least_long_edge: u32,
    fit: denoise::galosh::Fit,
) -> Option<decode::frame::Frame> {
    decode_frame_cropped(
        DecodeSource::Bytes(bytes),
        at_least_long_edge,
        denoise::galosh::Detail::at(0.0, 0.0),
        None,
        fit,
    )
}

enum DecodeSource<'a> {
    Path(&'a str),
    Bytes(&'a [u8]),
}

fn decode_frame_via(
    source: DecodeSource<'_>,
    at_least_long_edge: u32,
    detail: denoise::galosh::Detail,
) -> Option<decode::frame::Frame> {
    decode_frame_cropped(
        source,
        at_least_long_edge,
        detail,
        None,
        denoise::galosh::Fit::Measure,
    )
}

/// `at_least_long_edge` is a floor rather than a size: the smallest long edge that would still
/// serve. A frame whose own is at least twice that is halved, which skips the demosaic entirely.
fn decode_frame_cropped(
    source: DecodeSource<'_>,
    at_least_long_edge: u32,
    detail: denoise::galosh::Detail,
    crop: Option<(decode::view::View, usize)>,
    fit: denoise::galosh::Fit,
) -> Option<decode::frame::Frame> {
    // Nothing taken off the glass here. The callers below are the ones that are not the pipeline -
    // the debug renders, the fixture pins, the examples - and a spot removed from a fixture is a
    // fixture that no longer pins what it was written to pin.
    let glass = denoise::dust::Wanted::Off;
    let scene = match (&source, crop) {
        // The view carries its own scale, so `at_least_long_edge` says nothing here: whether a
        // window is halved is the *photograph's* question and the caller has already answered it.
        (DecodeSource::Path(path), Some((view, halo))) => pollster::block_on(decode::tile_from(
            decode::Source::Path(path),
            view,
            detail,
            fit,
            halo,
            denoise::dust::Known::Off,
        )),
        (DecodeSource::Path(path), None) => {
            decode::frame_from_path(path, detail, at_least_long_edge, false, fit, glass)
        }
        // A tile of an in-memory source has no caller, so it is refused rather than read to a file
        // to get one.
        (DecodeSource::Bytes(bytes), None) => pollster::block_on(decode::frame_from_bytes(
            bytes,
            detail,
            at_least_long_edge,
            fit,
            glass,
        )),
        (DecodeSource::Bytes(_), Some(_)) => None,
    }?;

    // **The transfer back, for the callers that are not the pipeline.** A decode leaves its frame on
    // the device, because the pipeline's next stage is a shader; everything reached through this
    // function - the debug renders, the fixture pins, the examples - wants samples in hand instead,
    // and says so once, here. The two spellings are the same decode, so there is nothing to drift.
    pollster::block_on(scene.to_host())
}

/// One tile of a photograph, at rendition quality, with nothing kept between requests.
///
/// **The whole point is that this is a pure function of its arguments.** Only the region the tile
/// covers is decoded - measured on a 24MP CR3, a 512 tile costs 59ms against 588ms for the frame -
/// and the denoise takes a window, so a tile is an open, a partial read and two small pieces of
/// work. Nothing is cached, so nothing has to be invalidated when an edit lands; the tile a reader
/// sees is the tile their current settings describe.
///
/// `crop` is in the decoded image's own pixels, upright, which is the space the editor's region
/// speaks.
///
/// `fit` is the *frame's* noise, measured by the open and handed back with the request. Without it
/// the tile measures its own, which is a different number - between 0.49 and 1.51 times the frame's
/// on the fixtures - and the strength it denoises at, so the magnifier stops predicting the export
/// and starts moving as the reader pans.
///
/// `halo` is how much context the denoise is given either side, and it is the caller's because the
/// two callers want different answers: `decode::RENDITION_TILE_HALO` where the tile has to match what a
/// render would produce, `EDITOR_TILE_HALO` where it is drawn and then replaced.
pub fn decode_tile(
    path: &str,
    view: decode::view::View,
    detail: denoise::galosh::Detail,
    fit: denoise::galosh::Fit,
    halo: usize,
) -> Option<decode::frame::Frame> {
    decode_frame_cropped(DecodeSource::Path(path), 0, detail, Some((view, halo)), fit)
}

/// The camera's embedded preview as an owned frame, fitted to `long_edge`.
///
/// The whole of an import's tile pass in one call. None when the file embeds no
/// JPEG preview, which is a property of the file rather than an error: the caller
/// falls back to a render.
///
/// **The smallest preview that covers the size asked for**, since this is the tile pass and a tile
/// is downsized to `long_edge` whatever it is handed. On a body that embeds a full-resolution JPEG
/// beside a small one, taking the large one reads 4-14MB to make an 800px tile that looks the same.
/// A caller that wants the body's own rendering rather than a cheap source of pixels wants
/// `decode_embedded_rgb` with `Preview::Largest`.
pub fn decode_embedded_frame(raw_path: &str, long_edge: u32) -> Option<decode::frame::Frame> {
    let image = guard("decode_embedded_frame", None, || {
        decode::raw::upright_preview_rgb(
            raw_path,
            long_edge as usize,
            decode::raw::Preview::SmallestCovering(long_edge as usize),
        )
    })?;
    Some(decode::frame::Frame::new(
        image.width,
        image.height,
        decode::frame::Pixels::Eight(image.data),
    ))
}

/// The camera match for the HDR grade, in the domain the grade works in (10.8.1): both
/// halves run off this decode in a single pass over it.
#[cfg(feature = "renditions")]
pub fn fit_hdr_for(
    frame: &colour::resident::Resident,
    raw_path: &str,
    quantile: f64,
    as_shot: Option<colour::white_balance::Illuminant>,
) -> Option<fit::hdr::HdrMatch> {
    fit_hdr_measured(
        frame,
        raw_path,
        quantile,
        fit::hdr::CameraMatch::LensAndColour,
        as_shot,
    )
    .map(|(matched, _)| matched)
}

/// `fit_hdr_for`, with the levels the match was fitted against - which `open::measure` would
/// otherwise read off the frame a second time.
#[cfg(feature = "renditions")]
pub fn fit_hdr_measured(
    frame: &colour::resident::Resident,
    raw_path: &str,
    quantile: f64,
    camera_match: fit::hdr::CameraMatch,
    as_shot: Option<colour::white_balance::Illuminant>,
) -> Option<(fit::hdr::HdrMatch, colour::tone::Levels)> {
    let gpu = gpu::device()?;
    guard("fit_hdr_for", None, || {
        let geometry = lens_geometry::geometry_for(raw_path)?;
        pollster::block_on(hdr::fit_all(
            gpu,
            raw_path,
            frame,
            quantile,
            geometry,
            camera_match,
            as_shot,
        ))
        .map(|(_, matched, levels)| (matched, levels))
    })
}

/// Writes an image as an AVIF, at the size it arrives.
///
/// Sizing belongs to whoever built the frame, not here: the SDR base is resized once
/// in `job::run` and an embedded preview is shrunk during its JPEG decode, so every
/// caller already hands over final pixels. A resize at the encode would also land
/// after `render_base`'s sharpen, which is calibrated for the size it ran at (10.1).
#[cfg(feature = "renditions")]
pub fn save_avif_frame(
    source: units::rgb::RgbRef<'_>,
    quantizer: i32,
    speed: i32,
    full_chroma: bool,
    out_path: &str,
    rotate: u16,
    exif: Option<&[u8]>,
) -> Result<(), String> {
    formats::avif::encode_rendition_rotated(
        source.data.into(),
        source.width,
        source.height,
        quantizer,
        speed,
        full_chroma,
        out_path,
        rotate,
        exif,
    )
}

/// Runs `use_bytes` over the camera's embedded JPEG preview, standing it upright first.
///
/// **Upright is not free and is not optional.** The preview is stored as the sensor read it, so a
/// portrait frame arrives on its side, and every caller here either decodes it to compare against
/// an upright render or hands it to something that will display it. Turning it once here rather
/// than at each of them is measured: left sideways, the camera match fits against unrelated content
/// and a portrait CR2 came out 15% down on mean luma. A landscape frame, which is most of them, is
/// passed through untouched.
///
/// None when the file has no JPEG preview: some bodies embed a bitmap and some embed nothing, which
/// is a property of the file rather than an error, and the caller falls back to a render. Also when
/// a rotated preview will not take the tag that stands it up - EXIF this cannot parse, or an APP1
/// with no room left in it - since handing back a sideways frame is the failure being avoided.
///
/// A JPEG that arrived as itself is its own preview: nothing was lifted out of it, so what a
/// caller asking for "the camera's rendering" gets is the file, byte for byte. Every other
/// rendered format has none, and the caller renders (`decode::rendered`).
#[cfg(feature = "renditions")]
fn with_embedded_jpeg<T>(path: &str, use_bytes: impl FnOnce(&[u8]) -> T) -> Option<T> {
    if formats::rendered::is_rendered(path) {
        let bytes = std::fs::read(path).ok()?;
        return bytes.starts_with(&[0xFF, 0xD8]).then(|| use_bytes(&bytes));
    }
    decode::raw::upright_preview_jpeg(path, decode::raw::Preview::Largest)
        .map(|jpeg| use_bytes(&jpeg))
}

/// The camera's own picture of this file turned `rotate` degrees further clockwise: a JPEG
/// retagged, or a HEIF with the turn written into its own boxes. None when the file has no such
/// picture; Some(None) when it has one this cannot turn.
#[cfg(feature = "renditions")]
fn turned_camera_picture(path: &str, rotate: u16) -> Option<Option<Vec<u8>>> {
    if !formats::rendered::is_rendered(path) {
        return with_embedded_jpeg(path, |jpeg| formats::jpeg::with_added_rotation(jpeg, rotate));
    }
    let bytes = std::fs::read(path).ok()?;
    if heif::is_heif(&bytes) {
        return Some(heif::with_added_rotation(&bytes, rotate));
    }
    bytes
        .starts_with(&[0xFF, 0xD8])
        .then(|| formats::jpeg::with_added_rotation(&bytes, rotate))
}

/// The camera's embedded preview as RGB, bounded by `long_edge`, for callers on this
/// side of the boundary. None when the file embeds no JPEG preview.
///
/// The body's own full-size rendering: every caller here is measuring against what the camera
/// produced rather than looking for cheap pixels, which is the distinction `Preview` draws.
#[cfg(feature = "renditions")]
pub fn decode_embedded_rgb(path: &str, long_edge: usize) -> Option<units::rgb::Rgb> {
    decode::raw::upright_preview_rgb(path, long_edge, decode::raw::Preview::Largest)
}

/// Reads what the catalogue needs from a RAW without decoding a pixel.
///
/// Returns 0 on success, -1 if the file could not be opened. See `header.rs` for
/// why this is not a set of byte offsets in TypeScript.
///
/// # Safety
/// `path` must be a NUL-terminated C string and `out` a writable `BbHeader`.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_read_header(path: *const c_char, out: *mut formats::header::BbHeader) -> c_int {
    if path.is_null() || out.is_null() {
        return -1;
    }
    let Ok(path) = unsafe { CStr::from_ptr(path) }.to_str() else {
        return -1;
    };
    // Runs on every file of a scan, and parses maker notes off untrusted bytes.
    match guard("bb_read_header", None, || formats::header::read_path(path)) {
        Some(header) => {
            unsafe {
                *out = header;
            }
            0
        }
        None => -1,
    }
}

/// `header::camera_names`, for names a catalogue already holds. Each output is a `BbHeader`
/// name field, 64 bytes, NUL-padded.
///
/// Returns 0, or -1 for a null pointer or a name that is not UTF-8.
///
/// # Safety
/// `make` and `model` must be NUL-terminated C strings, `out_make` and `out_model` writable
/// for 64 bytes each.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_camera_names(
    make: *const c_char,
    model: *const c_char,
    out_make: *mut u8,
    out_model: *mut u8,
) -> c_int {
    if make.is_null() || model.is_null() || out_make.is_null() || out_model.is_null() {
        return -1;
    }
    let (Ok(make), Ok(model)) = (
        unsafe { CStr::from_ptr(make) }.to_str(),
        unsafe { CStr::from_ptr(model) }.to_str(),
    ) else {
        return -1;
    };
    let Some((make, model)) = guard("bb_camera_names", None, || {
        Some(formats::header::camera_names(make, model))
    }) else {
        return -1;
    };
    unsafe {
        formats::header::write_name(std::slice::from_raw_parts_mut(out_make, 64), &make);
        formats::header::write_name(std::slice::from_raw_parts_mut(out_model, 64), &model);
    }
    0
}

/// How far the job running under `progress_id` has got: steps done in the high word, steps in the
/// pass in the low one, and zero where none is running.
///
/// Read from a thread other than the one inside `bb_run_job`, which is the whole point: a merge or
/// an export is minutes of work behind one blocking call, and this is what the caller shows a
/// reader meanwhile.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub extern "C" fn bb_job_progress(progress_id: u32) -> u64 {
    trace::progress::packed(progress_id)
}

/// Tells the job running under `progress_id` to stop at the next boundary it counts itself at.
/// Nothing happens where no job is running under it yet.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub extern "C" fn bb_cancel_job(progress_id: u32) {
    trace::progress::cancel(progress_id);
}

/// Keeps what a render allocates for the next render to reuse, until as many
/// `bb_release_render_memory` calls as holds. For a queue of renders; a render with no hold frees
/// everything it allocated as it finishes.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub extern "C" fn bb_hold_render_memory() {
    denoise::pmrid::hold_arenas();
}

/// Ends one `bb_hold_render_memory`; the last frees everything kept.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub extern "C" fn bb_release_render_memory() {
    denoise::pmrid::release_arenas();
    release_freed_memory();
}

/// Size of `BbHeader`, which the caller checks against the layout it reads.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub extern "C" fn bb_header_size() -> usize {
    std::mem::size_of::<formats::header::BbHeader>()
}

/// How many bytes a stacking descriptor occupies, so the caller can size its
/// buffer and the database column without either guessing.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub extern "C" fn bb_descriptor_size() -> usize {
    stacks::DESCRIPTOR_BYTES
}

/// The byte every descriptor of this format begins with.
///
/// Comparison refuses a descriptor that does not carry it, and refuses it quietly - two frames
/// simply score as unalike - so a caller assembling a descriptor by hand has no way to discover the
/// tag by being told it is wrong.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub extern "C" fn bb_descriptor_format() -> u8 {
    stacks::FORMAT
}

/// Groups frames into stacks, writing one group index per frame into `out`, or
/// -1 for a frame that ended up alone.
///
/// The frames must arrive in ascending time order, which the query that selects
/// them already guarantees.
///
/// Returns 0 on success, -1 on a null argument.
///
/// # Safety
/// `descriptors` must hold `count * bb_descriptor_size()` bytes, and
/// `timestamps` and `out` must each hold `count` elements.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_stack_groups(
    descriptors: *const u8,
    timestamps: *const i64,
    count: usize,
    threshold: f32,
    window_seconds: i64,
    out: *mut i32,
) -> c_int {
    if descriptors.is_null() || timestamps.is_null() || out.is_null() {
        return -1;
    }
    let descriptors =
        unsafe { std::slice::from_raw_parts(descriptors, count * stacks::DESCRIPTOR_BYTES) };
    let timestamps = unsafe { std::slice::from_raw_parts(timestamps, count) };
    let groups = stacks::group(descriptors, timestamps, threshold, window_seconds);
    unsafe { std::ptr::copy_nonoverlapping(groups.as_ptr(), out, count) };
    0
}

/// The tests that decode a real RAW, behind the `fixtures` feature so the default
/// suite stays fast enough to run on every edit.
#[cfg(all(test, feature = "fixtures"))]
mod fixture_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_call_that_loses_the_gpu_runs_again_and_one_that_keeps_losing_it_stops() {
        let losses = std::cell::Cell::new(0);
        let lose_first = std::cell::Cell::new(true);
        let mut runs = 0;
        let outcome = rerun_on_loss(
            "test",
            || losses.get(),
            &[std::time::Duration::ZERO; 2],
            || {
                runs += 1;
                if lose_first.replace(false) {
                    losses.set(losses.get() + 1);
                }
                runs
            },
        );
        assert_eq!(outcome.expect("no panic"), 2);

        let mut runs = 0;
        let outcome = rerun_on_loss(
            "test",
            || losses.get(),
            &[std::time::Duration::ZERO; 2],
            || {
                runs += 1;
                losses.set(losses.get() + 1);
                runs
            },
        );
        assert_eq!(outcome.expect("no panic"), 3);
    }

    /// What a loupe tile would cost with no cache at all: open, unpack, demosaic and denoise,
    /// every one of them per request.
    ///
    /// The question is whether `params.cropbox` restricts the *work* or only the output. If it
    /// restricts the work, a tile is a request and nothing has to stay resident between them.
    ///
    /// Ignored by default: it wants a real RAW, which no fixture is.
    ///
    ///   BOWERBIRD_TILE_RAW=/path/to.CR3 cargo test --release --manifest-path \
    ///     native/rawshim/Cargo.toml --lib tile_cost -- --nocapture --ignored
    #[test]
    #[ignore = "wants a real RAW on this machine"]
    fn tile_cost() {
        let Ok(path) = std::env::var("BOWERBIRD_TILE_RAW") else {
            return;
        };
        // The decode either side of the tile, which is what the region read is measured against.
        // `tile_check` is the finer instrument - it compares a tile against the frame's own
        // pixels - and this is the wall clock a reader waits on.
        let started = std::time::Instant::now();
        let whole = decode_frame(&path, 0).expect("the frame decodes");
        println!(
            "  whole frame             {:>5}ms  {}x{}",
            started.elapsed().as_millis(),
            whole.width,
            whole.height,
        );

        // How big the fit actually is, which decides whether it is worth storing per photo
        // rather than re-fitting. Measured rather than counted off the constants.
        #[cfg(feature = "renditions")]
        if let Some(frame) = decode_frame(&path, 0) {
            let gpu = gpu::device().expect("the fit needs an adapter");
            let resident = frame.on_device(gpu).expect("the frame reaches the device");
            if let Some(fitted) = fit_hdr_for(&resident, &path, 0.995, frame.as_shot) {
                let colour = fitted.colour.as_ref().expect("a colour fit");
                let numbers = colour.curves.iter().map(Vec::len).sum::<usize>()
                    + 9
                    + colour.chroma.as_ref().map_or(0, |map| map.words().len())
                    + fitted.lens.distortion.as_ref().map_or(0, Vec::len)
                    + fitted
                        .lens
                        .tca
                        .as_ref()
                        .map_or(0, |pair| pair[0].len() + pair[1].len())
                    + 3;
                let blob = fit::photo_analysis::encode(&fit::photo_analysis::PhotoAnalysis {
                    from_raw: fit::photo_analysis::FromRaw {
                        matched: Some(fitted),
                        ..Default::default()
                    },
                    ..Default::default()
                });
                println!(
                    "  the fit is {numbers} numbers, {} bytes stored ({} kB as f64)",
                    blob.len(),
                    numbers * 8 / 1024,
                );
            }
        }

        // And the decode alone: one tile, denoised and demosaiced, from nothing.
        //
        // Warmed first, because the pipelines and the adapter are built once per process and a
        // loupe asks its second question with them already up.
        let seeing = |side: usize| {
            decode::view::View::whole(units::px::Size::exact(whole.width, whole.height))
                .showing(units::px::Rect::exact(2000, 1400, side, side))
        };
        let sliders = denoise::galosh::Detail::at(40.0, 40.0);
        decode_tile(
            &path,
            seeing(400),
            sliders,
            denoise::galosh::Fit::Measure,
            decode::RENDITION_TILE_HALO,
        );
        for side in [400usize, 700] {
            let started = std::time::Instant::now();
            let tile = decode_tile(
                &path,
                seeing(side),
                sliders,
                denoise::galosh::Fit::Measure,
                decode::RENDITION_TILE_HALO,
            );
            let took = started.elapsed().as_millis();
            let frame = tile.expect("the tile decodes");
            println!(
                "  whole tile, {side}px        {took:>5}ms  {}x{}",
                frame.width, frame.height,
            );
            assert!(
                frame.width <= side + 8 && frame.height <= side + 8,
                "the crop is the tile"
            );
        }
    }

    #[test]
    fn a_panic_becomes_a_failed_call_rather_than_a_dead_process() {
        // The thing being prevented does not fail a test, it ends the test binary - a
        // panic crossing an `extern "C"` boundary aborts. So this checks the guard
        // itself: the value comes back, the process is still here to assert on it, and
        // a normal return still passes through untouched.
        //
        // Quietened first, or the panic's own backtrace goes to stderr and reads like
        // a failure in a suite that is passing.
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let out = guard("a test", -1, || -> i32 {
            panic!("as if an index escaped a frame")
        });
        std::panic::set_hook(previous);

        assert_eq!(out, -1, "a panic must come back as the fallback");
        assert_eq!(
            guard("a test", -1, || 7),
            7,
            "and an ordinary return untouched"
        );
    }
}
