// The C surface TypeScript calls.
//
// Coarse on purpose, in two directions. One call per job rather than one per
// operation, because the fit evaluates tens of candidates internally and exposing
// its pieces would put the boundary back inside the loop this module exists to
// close. And handles rather than pixels: every call here takes a `BbImage` the
// library still owns and, where it produces an image, hands back another one. JS
// passes a path in and gets a path or a handle out; the samples stay on this side.

use crate::fit::{self, Profile};
use crate::job;
use std::ffi::{c_char, CStr};

/// Runs one rendition job. The whole boundary, and the shape every other entry
/// point is being moved to.
///
/// Command in, values out, and nothing else: `command` is UTF-8 JSON describing the
/// job (`job::Job`), and the result is UTF-8 JSON written into a buffer the *caller*
/// owns. No address this library allocated is ever handed over, so there is nothing
/// for the other side to hold between calls, nothing to free, and no lifetime that
/// depends on a convention. That is the difference from the handle API beside it:
/// there, a decode's lifetime was a comment, and a `use-after-free` was expressible
/// in a language that is supposed to make it impossible.
///
/// Returns the number of bytes the result needs. When that is larger than `out_cap`
/// nothing has been written and the caller should call again with a buffer that
/// size - which does not repeat the work, because a job that ran and a result that
/// did not fit are different failures and only the second is retried. Negative is a
/// failure that produced no result at all.
///
/// # Safety
/// `command` must point at `command_len` readable bytes and `out` at `out_cap`
/// writable ones. Both are borrowed for the call and neither is retained.
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_run_job(
    command: *const u8,
    command_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> isize {
    if command.is_null() {
        return -1;
    }
    // The one place a pointer becomes a Rust value, and it is copied out of
    // immediately: `serde` owns every string in the job, so nothing downstream
    // borrows the caller's buffer and no lifetime escapes this function.
    let bytes = unsafe { std::slice::from_raw_parts(command, command_len) };
    let parsed: Result<job::Job, _> = serde_json::from_slice(bytes);

    let result = match parsed {
        Err(error) => Err(format!("could not read the job: {error}")),
        Ok(parsed) => crate::guard("bb_run_job", Err("panicked".to_string()), || job::run(&parsed)),
    };

    // Both arms are reported the same way, as JSON: a job that failed is a result,
    // not an absent one, and the caller gets the reason rather than a status code it
    // has to look up.
    let payload = match result {
        Ok(outcome) => serde_json::to_vec(&JobReply { ok: true, error: None, outcome: Some(outcome) }),
        Err(error) => serde_json::to_vec(&JobReply { ok: false, error: Some(error), outcome: None }),
    };
    let Ok(payload) = payload else { return -1 };

    if payload.len() > out_cap || out.is_null() {
        // Nothing written; the caller sizes a buffer from this and asks again.
        return payload.len() as isize;
    }
    let destination = unsafe { std::slice::from_raw_parts_mut(out, payload.len()) };
    destination.copy_from_slice(&payload);
    payload.len() as isize
}

/// Opens a RAW for editing and hands back the frame every tick then grades.
///
/// The one call that returns pixels rather than a path, and for the reason the rule was
/// always stated with: this is a response body on its way to a socket or an IPC channel.
/// It is also the only way the editor's client can grade at all now that the tick is a
/// shader (`docs/raw-edit-gpu.md` §6) and there is no decoder in the page.
///
/// Same protocol as `bb_run_job` for sizing: returns the byte length the reply needs, and
/// writes nothing when that exceeds `out_cap`. The reply is `edit::encode`'s framing, a
/// `u32` header length then JSON then `u16` samples, rather than JSON alone, because
/// base64 of 59MB is neither cheap nor honest.
///
/// Where it parts company with `bb_run_job` is what a short buffer costs. That one can
/// promise a retry does not repeat the work, because a job's reply is a few hundred bytes
/// of JSON and fits the caller's first buffer every time. This reply is the frame, so the
/// sizing call never fits and the retry is certain - and inheriting the protocol unchanged
/// meant every open decoded, fitted, warped and denoised the RAW twice. So the payload that
/// did not fit is kept for the call that asks again.
///
/// Failure is reported as a JSON body with `ok: false` and no samples, which the caller
/// tells apart by parsing the header it already has to parse.
///
/// # Safety
/// `command` must point at `command_len` readable bytes and `out` at `out_cap` writable
/// ones. Both are borrowed for the call and neither is retained.
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_prepare_edit(
    command: *const u8,
    command_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> isize {
    if command.is_null() {
        return -1;
    }
    let bytes = unsafe { std::slice::from_raw_parts(command, command_len) };

    let payload = match take_prepared(bytes) {
        Some(kept) => kept,
        None => match serde_json::from_slice::<crate::edit::EditRequest>(bytes) {
            Err(error) => edit_failure(&format!("could not read the edit request: {error}")),
            Ok(request) => {
                match crate::guard("bb_prepare_edit", Err("panicked".to_string()), || {
                    crate::edit::prepare(&request)
                }) {
                    Ok(prepared) => match crate::edit::encode(&prepared) {
                        Ok(bytes) => bytes,
                        Err(error) => edit_failure(&error),
                    },
                    Err(error) => edit_failure(&error),
                }
            }
        },
    };

    if payload.len() > out_cap || out.is_null() {
        let needed = payload.len();
        keep_prepared(bytes, payload);
        return needed as isize;
    }
    let destination = unsafe { std::slice::from_raw_parts_mut(out, payload.len()) };
    destination.copy_from_slice(&payload);
    payload.len() as isize
}

/// The open whose caller's buffer was too small, held for the call that asks again.
///
/// One slot, keyed by the command that produced it, and taken rather than read so the frame
/// is freed the moment it has been copied out. Keyed because a second photo must not be
/// served the first one's pixels; one slot because the caller retries immediately, in the
/// same function, and a queue would only be somewhere for a frame to be forgotten.
///
/// No address crosses the boundary, which is the rule this module is built on. What is held
/// is a `Vec` on this side, copied out like every other reply.
static PREPARED: std::sync::Mutex<Option<(Vec<u8>, Vec<u8>)>> = std::sync::Mutex::new(None);

fn take_prepared(command: &[u8]) -> Option<Vec<u8>> {
    let mut held = PREPARED.lock().ok()?;
    if held.as_ref().is_none_or(|(kept, _)| kept != command) {
        return None;
    }
    held.take().map(|(_, payload)| payload)
}

fn keep_prepared(command: &[u8], payload: Vec<u8>) {
    if let Ok(mut held) = PREPARED.lock() {
        *held = Some((command.to_vec(), payload));
    }
}

/// A failed open in the same framing as a successful one, so the caller has one parse.
fn edit_failure(error: &str) -> Vec<u8> {
    let header = serde_json::json!({ "ok": false, "error": error }).to_string();
    let mut out = Vec::with_capacity(4 + header.len());
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(header.as_bytes());
    out
}

/// The envelope every job reply comes back in.
#[derive(serde::Serialize)]
struct JobReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<job::Outcome>,
}

/// Transcodes a stored rendition to JPEG, for a download.
///
/// One of two calls that genuinely hand bytes back rather than writing a file, and for
/// the same reason: it is a response body on its way to a socket, which is the exception
/// the rule was always stated with (10.4). It still crosses no address - the JPEG is
/// copied into a buffer the caller owns, exactly as a job reply is.
///
/// Returns the byte length written, or the length needed when that is more than
/// `out_cap`, in which case nothing was written. Negative is a failure.
///
/// # Safety
/// `path` must be NUL-terminated and `out` must point at `out_cap` writable bytes.
/// Neither is retained past the call.
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_transcode_jpeg(
    path: *const c_char,
    long_edge: u32,
    quality: i32,
    out: *mut u8,
    out_cap: usize,
) -> isize {
    if path.is_null() {
        return -1;
    }
    let Ok(path) = (unsafe { CStr::from_ptr(path) }).to_str() else { return -1 };
    let encoded = crate::guard("bb_transcode_jpeg", None, || {
        let bytes = std::fs::read(path).ok()?;
        let decoded = crate::image::decode(&bytes, long_edge as usize).ok()?;
        crate::jpeg::encode(decoded.as_ref(), quality).ok()
    });
    let Some(encoded) = encoded else { return -1 };

    if encoded.len() > out_cap || out.is_null() {
        return encoded.len() as isize;
    }
    let destination = unsafe { std::slice::from_raw_parts_mut(out, encoded.len()) };
    destination.copy_from_slice(&encoded);
    encoded.len() as isize
}

/// Answers a question about pixels, for the tests and pins.
///
/// Same shape as `bb_run_job` and the same rule: JSON in, JSON out, into a buffer
/// the caller owns. It exists because the pins have to assert on what this library
/// produced, and reading samples back used to be the only way - which is what kept
/// the handle API alive after its last production caller went. A digest and a
/// per-channel stat answer the same questions without a buffer crossing.
///
/// # Safety
/// As `bb_run_job`.
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_for_testing_debug(
    command: *const u8,
    command_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> isize {
    if command.is_null() {
        return -1;
    }
    let bytes = unsafe { std::slice::from_raw_parts(command, command_len) };
    let parsed: Result<crate::debug::Command, _> = serde_json::from_slice(bytes);
    let result = match parsed {
        Err(error) => Err(format!("could not read the debug command: {error}")),
        Ok(parsed) => {
            crate::guard("bb_for_testing_debug", Err("panicked".to_string()), || crate::debug::run(&parsed))
        }
    };

    let payload = match result {
        Ok(reply) => serde_json::to_vec(&DebugReply { ok: true, error: None, reply: Some(reply) }),
        Err(error) => serde_json::to_vec(&DebugReply { ok: false, error: Some(error), reply: None }),
    };
    let Ok(payload) = payload else { return -1 };
    if payload.len() > out_cap || out.is_null() {
        return payload.len() as isize;
    }
    let destination = unsafe { std::slice::from_raw_parts_mut(out, payload.len()) };
    destination.copy_from_slice(&payload);
    payload.len() as isize
}

#[derive(serde::Serialize)]
struct DebugReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply: Option<crate::debug::Reply>,
}

/// The camera's embedded JPEG preview, as bytes.
///
/// The one call here that hands pixels over on purpose: its caller serves them to
/// an HTTP response unchanged, so they are bytes bound for a socket rather than
/// input to another image operation. Anything that goes on to decode the preview
/// wants `bb_decode_embedded`, which keeps it on this side.
///
/// Returns the size written, the size needed where `out_cap` is too small, -1 on
/// failure, or 0 where the file has no JPEG preview - which is not an error.
///
/// The camera's own JPEG is the one thing besides a finished rendition that leaves
/// this library as bytes, because the server answers a request with it. It goes out
/// through a buffer the caller owns, like every other reply: an address this library
/// allocated would have to stay valid until the other side chose to hand it back.
///
/// # Safety
/// `path` must be a NUL-terminated C string, and `out` valid for `out_cap`.
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_extract_embedded(
    path: *const c_char,
    out: *mut u8,
    out_cap: usize,
) -> isize {
    if path.is_null() {
        return -1;
    }
    let Some(bytes) = (unsafe { crate::with_embedded_jpeg(path, <[u8]>::to_vec) }) else {
        return 0;
    };
    if bytes.len() > out_cap || out.is_null() {
        return bytes.len() as isize;
    }
    let destination = unsafe { std::slice::from_raw_parts_mut(out, bytes.len()) };
    destination.copy_from_slice(&bytes);
    bytes.len() as isize
}

/// How much of a RAW the spline parser is given before it is given all of it.
///
/// Not "the first few kilobytes", which is what this was assumed to be until it was
/// measured: over 1000 files sampled across the whole catalogue, a 128KB window
/// missed the spline on 971 of them and 256KB missed none. The tag is early, its
/// data is not - it lands past the previews IFD0 points at. So this is double what
/// was needed, and still two orders of magnitude below a whole frame.
const SPLINE_WINDOW: u64 = 512 * 1024;

/// The spline, from as little of the file as will yield it.
///
/// Reading it whole was a page-cache hit in `bb_fit` - the decode had just pulled
/// the same file through - but it still allocated and copied 25-60MB per photo.
///
/// The whole file is still read when the window comes back empty, and that is
/// load-bearing rather than belt-and-braces: TIFF offsets are absolute, and the
/// parser answers a pointer past the end of its buffer with `None`, which is the
/// same answer as a body that recorded nothing. A window one byte too small would
/// not fail, it would silently drop the frame onto the fitted fallback - slower and
/// a worse grade, with nothing to say so.
/// `Err` is a file that could not be read, which the callers report separately from
/// a file that simply records no correction.
/// The spline the body recorded for this shot, or None where it recorded none.
///
/// `geometry_for` reads this itself; this exists so the fixture test can hold the
/// parser against a real ARW, which `lens.rs`'s synthetic TIFFs cannot do.
#[cfg(all(test, feature = "fixtures"))]
pub fn _for_testing_distortion_spline(path: &str) -> Option<Vec<f64>> {
    distortion_of(path).ok()?.spline
}

fn distortion_of(path: &str) -> std::io::Result<crate::lens::Distortion> {
    use std::io::Read;

    let mut head = Vec::with_capacity(SPLINE_WINDOW as usize);
    std::fs::File::open(path)?.take(SPLINE_WINDOW).read_to_end(&mut head)?;
    let found = crate::lens::read_distortion(&head);
    if found.spline.is_some() {
        return Ok(found);
    }
    // A short read means that was the whole file, so there is nothing further on.
    if (head.len() as u64) < SPLINE_WINDOW {
        return Ok(found);
    }
    Ok(crate::lens::read_distortion(&std::fs::read(path)?))
}

/// Which geometry tier this file falls into, from the file alone - no pixels decoded.
///
/// None is a file that could not be read, which the callers report separately from a
/// file that simply records no correction.
pub(crate) fn geometry_for(path: &str) -> Option<fit::Geometry> {
    let Ok(found) = distortion_of(path) else { return None };
    // The body's own word that it corrected nothing, which saves searching for a
    // correction that is not there (`fit.rs`). Only Sony states it; everything else
    // reads as unstated and falls through.
    Some(match (found.applied, found.spline) {
        (Some(false), _) => fit::Geometry::Uncorrected,
        (_, Some(knots)) => fit::Geometry::Recorded(knots),
        // Nothing in the file, so ask the database. The header read this needs is a
        // second open of the same file, which is why it is here rather than above:
        // a body that recorded its own spline never pays for it.
        (_, None) => lensfun_geometry(path).unwrap_or(fit::Geometry::Unstated),
    })
}

/// The lateral aberration the body recorded for this shot, where it recorded one.
///
/// Preferred over measuring it, on the same grounds the distortion cascade prefers a
/// recorded spline: it is written per shot rather than per lens, so it tracks focal
/// length and focus distance that a database entry averages over. Only Sony writes it;
/// everything else reads as None and is measured off the frame.
///
/// Applied at face value (`tca::supplied_curve`), shape and magnitude both. The strength
/// used to be refitted here, which measured worse than trusting it - and what makes that
/// safe is not the fit but `tca::improves`, which drops the curve if the frame disagrees.
pub(crate) fn recorded_lateral(path: &str) -> Option<[Vec<f64>; 2]> {
    distortion_of(path).ok()?.lateral
}

/// The database's lateral aberration for whatever lens this file names, where it has
/// one.
///
/// Separate from `geometry_for` because the tiers are independent: lensfun's TCA
/// coverage is far thinner than its distortion coverage, so a lens routinely supplies
/// one and not the other.
///
/// Not on the fit's path - see `tca::supplied_curve` for the measurements that decided
/// that - so this is reached only by the test that keeps the reader honest.
#[cfg(all(test, feature = "fixtures"))]
pub(crate) fn database_lateral(path: &str) -> Option<[Vec<f64>; 2]> {
    let header = crate::header::read_path(path)?;
    crate::lensfun::tca_knots(
        crate::header::name(&header.camera_make),
        crate::header::name(&header.camera_model),
        crate::header::name(&header.lens_model),
        header.focal,
        header.aperture,
        header.width as usize,
        header.height as usize,
    )
}

/// The database's profile for whatever lens this file names.
///
/// None when the file names no lens, when nothing plausible matches, or when the
/// match carries no distortion data - each of which leaves the geometry to be
/// fitted, as it was before lensfun was here.
fn lensfun_geometry(path: &str) -> Option<fit::Geometry> {
    let header = crate::header::read_path(path)?;
    let knots = crate::lensfun::knots(
        crate::header::name(&header.camera_make),
        crate::header::name(&header.camera_model),
        crate::header::name(&header.lens_model),
        header.focal,
        header.aperture,
        header.width as usize,
        header.height as usize,
    )?;
    Some(fit::Geometry::Profiled(knots))
}


/// Exercises the pixel paths on a tiny image. 0 if the library works here.
///
/// For one specific job: the container entrypoint builds a second copy of this
/// library with `-C target-cpu=native` and has to decide whether to trust it
/// before promoting it over the portable one baked into the image. A build tuned
/// for instructions the host turns out to lack dies with `SIGILL`, which cannot
/// be caught, so it has to die in a throwaway process rather than inside a worker
/// halfway through an import.
///
/// It therefore has to run the *vectorised* code, not just enter the library: a
/// symbol returning a constant would load and answer perfectly on a CPU that
/// faults the moment the warp runs. So this grades through a real distortion and a
/// real falloff, which is `warp` plus the radial lookup plus the folded colour one -
/// the hot loops - and reduces the result, which is the other vectorised kernel a
/// rendition goes through.
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn bb_selftest() -> i32 {
    let width = 64;
    let height = 48;
    let source = crate::rgb::Rgb {
        width,
        height,
        data: (0..width * height * 3).map(|i| (i % 251) as u8).collect(),
    };

    let mut colour = crate::hdr_fit::HdrColour::identity();
    colour.matrix = [[0.9, 0.05, 0.05], [0.1, 0.8, 0.1], [0.0, 0.02, 0.98]];
    colour.chroma = Some(crate::hdr_fit::ChromaMap::from_saturation(1.1));
    let profile = Profile {
        knots: Some(crate::image::polynomial_knots(-0.02, 0.0, 16)),
        gain: Some(fit::Gain::from_poly(0.3, -0.05)),
        // Non-zero so the warp takes its per-channel branch: a build tuned for
        // instructions the host lacks has to fault here rather than in a worker.
        tca: Some(crate::tca::flat(1.0008, 0.9992)),
        crop: 0.99,
        source: 2,
        colour: Some(colour),
    };

    let graded = fit::apply(source.as_ref(), &profile);
    if graded.width != width || graded.height != height {
        return -1;
    }
    // An all-black result would mean the warp sampled nothing, which a broken
    // build can manage without faulting.
    if graded.data.iter().all(|value| *value == 0) {
        return -1;
    }
    match crate::image::resize_to_fit(graded.as_ref(), 32).width {
        32 => 0,
        _ => -1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sizing call keeps its payload, so the retry copies rather than opens again.
    ///
    /// Held at the slot rather than through the FFI symbol, because reaching it needs a RAW
    /// and this is about the protocol, not the decode: what the two calls have to agree on
    /// is that the second finds what the first left, and that a different command does not.
    #[test]
    fn a_short_buffer_keeps_the_open_for_the_call_that_asks_again() {
        let command = br#"{"rawFilePath":"a.arw"}"#;
        assert_eq!(take_prepared(command), None, "nothing kept yet");

        keep_prepared(command, vec![7u8; 32]);
        assert_eq!(
            take_prepared(br#"{"rawFilePath":"b.arw"}"#),
            None,
            "another photo is not served this one's pixels",
        );
        assert_eq!(take_prepared(command), Some(vec![7u8; 32]), "the retry finds it");
        assert_eq!(take_prepared(command), None, "and it is freed once copied out");
    }

    #[test]
    fn the_selftest_passes_on_the_machine_that_built_it() {
        // If this can fail here it is worthless as a gate on a tuned build.
        assert_eq!(bb_selftest(), 0);
    }

    /// The download path end to end: a stored rendition is an AVIF and what goes to the
    /// browser is a JPEG, so this crosses libavif's decoder and the JPEG encoder in one
    /// call. Worth having at the symbol rather than at the two halves, because the format
    /// the file turns out to be is decided in here.
    #[test]
    fn transcodes_a_stored_rendition_to_jpeg() {
        let dir = std::env::temp_dir().join("bb-transcode");
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let path = dir.join("rendition.avif");
        let (width, height) = (64usize, 48usize);
        let frame: Vec<u8> = (0..width * height * 3).map(|i| (i % 251) as u8).collect();
        crate::avif::encode_rendition(
            std::borrow::Cow::Borrowed(&frame),
            width,
            height,
            20,
            10,
            true,
            path.to_str().expect("a path"),
        )
        .expect("the rendition");

        let c_path = std::ffi::CString::new(path.to_str().expect("a path")).expect("nul");
        // Nothing written when the buffer is too small, and the length needed is what
        // comes back - the protocol the TypeScript side sizes its second call from.
        #[expect(unsafe_code)]
        let needed = unsafe { bb_transcode_jpeg(c_path.as_ptr(), 0, 92, std::ptr::null_mut(), 0) };
        assert!(needed > 0, "a rendition should transcode to something");

        let mut out = vec![0u8; needed as usize];
        #[expect(unsafe_code)]
        let written =
            unsafe { bb_transcode_jpeg(c_path.as_ptr(), 0, 92, out.as_mut_ptr(), out.len()) };
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(written, needed);
        assert_eq!(&out[..2], &[0xFF, 0xD8], "the reply is a JPEG");

        let decoded = crate::jpeg::decode(&out[..written as usize], 0).expect("the JPEG decodes");
        assert_eq!((decoded.width, decoded.height), (width, height));
    }

    /// The bound is honoured whichever format the file is, which is the half of
    /// `image::decode` a JPEG never exercises.
    #[test]
    fn transcoding_a_rendition_honours_the_long_edge() {
        let dir = std::env::temp_dir().join("bb-transcode-bounded");
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let path = dir.join("rendition.avif");
        let (width, height) = (64usize, 48usize);
        let frame = vec![128u8; width * height * 3];
        crate::avif::encode_rendition(
            std::borrow::Cow::Borrowed(&frame),
            width,
            height,
            20,
            10,
            true,
            path.to_str().expect("a path"),
        )
        .expect("the rendition");

        let c_path = std::ffi::CString::new(path.to_str().expect("a path")).expect("nul");
        let mut out = vec![0u8; 64 * 1024];
        #[expect(unsafe_code)]
        let written =
            unsafe { bb_transcode_jpeg(c_path.as_ptr(), 32, 92, out.as_mut_ptr(), out.len()) };
        let _ = std::fs::remove_dir_all(&dir);
        assert!(written > 0, "a bounded transcode should produce a JPEG");

        let decoded = crate::jpeg::decode(&out[..written as usize], 0).expect("the JPEG decodes");
        assert_eq!((decoded.width, decoded.height), (32, 24));
    }
}
