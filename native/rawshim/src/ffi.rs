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
use crate::vips::{self, Pipeline};
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
#[no_mangle]
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
/// The one call that genuinely hands bytes back rather than writing a file: it is a
/// response body on its way to a socket, which is the exception the rule was always
/// stated with (10.4). It still crosses no address - the JPEG is copied into a
/// buffer the caller owns, exactly as a job reply is.
///
/// Returns the byte length written, or the length needed when that is more than
/// `out_cap`, in which case nothing was written. Negative is a failure.
///
/// # Safety
/// `path` must be NUL-terminated and `out` must point at `out_cap` writable bytes.
/// Neither is retained past the call.
#[expect(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn bb_transcode_jpeg(
    path: *const c_char,
    long_edge: u32,
    quality: i32,
    out: *mut u8,
    out_cap: usize,
) -> isize {
    vips::init();
    if path.is_null() {
        return -1;
    }
    let Ok(path) = (unsafe { CStr::from_ptr(path) }).to_str() else { return -1 };
    let encoded = crate::guard("bb_transcode_jpeg", None, || {
        let bytes = std::fs::read(path).ok()?;
        let pipeline = match long_edge {
            0 => Pipeline::decode_upright(&bytes),
            edge => Pipeline::thumbnail(&bytes, edge as usize),
        };
        pipeline.and_then(|p| p.encode_jpeg(quality)).ok()
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
#[no_mangle]
pub unsafe extern "C" fn bb_for_testing_debug(
    command: *const u8,
    command_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> isize {
    vips::init();
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
#[no_mangle]
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
/// faults the moment the warp runs. So this grades through a real distortion,
/// which is `warp` plus the folded colour lookup - the hot loops - and puts the
/// result through libvips to confirm the linkage too.
#[expect(unsafe_code)]
#[no_mangle]
pub extern "C" fn bb_selftest() -> i32 {
    vips::init();
    let width = 64;
    let height = 48;
    let source = vips::Rgb {
        width,
        height,
        data: (0..width * height * 3).map(|i| (i % 251) as u8).collect(),
    };

    let mut colour = fit::ColourTransform::identity();
    colour.matrix = [[0.9, 0.05, 0.05], [0.1, 0.8, 0.1], [0.0, 0.02, 0.98]];
    let profile = Profile {
        knots: Some(crate::image::polynomial_knots(-0.02, 0.0, 16)),
        crop: 0.99,
        source: 2,
        delta_e: 0.0,
        colour,
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
    match Pipeline::from_rgb(graded.as_ref()).and_then(|p| p.resize_to_fit(32)).and_then(Pipeline::finish) {
        Ok(small) if small.width == 32 => 0,
        _ => -1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_selftest_passes_on_the_machine_that_built_it() {
        // If this can fail here it is worthless as a gate on a tuned build.
        assert_eq!(bb_selftest(), 0);
    }
}

