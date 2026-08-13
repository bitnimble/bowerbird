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

/// One tile of a photograph, graded and encoded, as JPEG bytes.
///
/// Takes the same `Job` JSON `bb_run_job` does, with `tile` set, and hands back an image rather
/// than a descriptor - a tile is a response and not a file, so writing one to disk to read it
/// back would be the only reason a path existed.
///
/// The two-call sizing protocol is `bb_run_job`'s, and cheap here for the reason it is cheap
/// there: the second call re-runs the *encode* against a buffer that fits, not the decode.
/// Being generous with the first buffer is what keeps that from happening at all.
///
/// # Safety
/// `command` must point to `command_len` readable bytes, and `out` to `out_cap` writable ones.
#[unsafe(no_mangle)]
#[expect(unsafe_code)]
pub unsafe extern "C" fn bb_render_tile(
    command: *const u8,
    command_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> isize {
    if command.is_null() {
        return -1;
    }
    let bytes = unsafe { std::slice::from_raw_parts(command, command_len) };
    let Ok(parsed) = serde_json::from_slice::<job::Job>(bytes) else { return -1 };
    let rendered = crate::guard("bb_render_tile", None, || job::tile(&parsed));
    let Some(payload) = rendered else { return -1 };

    if payload.len() > out_cap || out.is_null() {
        return payload.len() as isize;
    }
    let destination = unsafe { std::slice::from_raw_parts_mut(out, payload.len()) };
    destination.copy_from_slice(&payload);
    payload.len() as isize
}

// ---------------------------------------------------------------------------------------
// The editor's open, without holding the caller's thread.
//
// It is seconds of decoding, and the server calls it from the one thread that answers every
// other request - so doing it in line stopped the library dead for as long as it took. This
// starts the work on a thread of its own and returns immediately, and the caller learns it
// is done through a function pointer it registered rather than by blocking or polling.
//
// There was a blocking `bb_prepare_edit` beside this, on the two-call sizing protocol
// `bb_run_job` uses. It has no callers left: that protocol cannot size a reply that is the
// frame without either running the open twice or holding it somewhere, and holding it under
// a job id is what this does anyway. The desktop shell never crossed this boundary at all -
// it calls `edit::prepare_bytes` in process.
//
// The finished open is left here to be collected rather than announced. It used to be
// announced, through a Bun `JSCallback { threadsafe: true }` entered from the thread that did
// the work - which reads as the better shape, and is a way to segfault the runtime: measured
// at five crashes in forty runs of the specimens that cross this boundary, against none of the
// ones that do not, always on the main thread and mid-run. The caller polls instead, and
// nothing this library owns ever enters the JS runtime.

static NEXT_JOB: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Every job that has been started and not yet taken. `None` is still running.
static JOBS: std::sync::Mutex<Option<std::collections::HashMap<u64, Option<Vec<u8>>>>> =
    std::sync::Mutex::new(None);

/// Still running: not an error, and not a length. Distinct from -1 so a caller can tell
/// "come back" from "there is no such job", which is what ends its wait.
pub const EDIT_RUNNING: i64 = -2;

fn jobs<T>(with: impl FnOnce(&mut std::collections::HashMap<u64, Option<Vec<u8>>>) -> T) -> Option<T> {
    let mut held = JOBS.lock().ok()?;
    Some(with(held.get_or_insert_with(std::collections::HashMap::new)))
}

/// Starts an open and returns its job id, without waiting for it.
///
/// 0 is a refusal that will never be reported: a null command, or a thread that would not
/// start. Anything else is a job `bb_prepare_edit_poll` will answer for.
///
/// # Safety
/// `command` must point at `command_len` readable bytes. It is copied before this returns,
/// so the caller may free it immediately.
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_prepare_edit_start(command: *const u8, command_len: usize) -> u64 {
    if command.is_null() {
        return 0;
    }
    // Copied rather than borrowed, because the caller is about to return to its event loop
    // and the buffer is its own.
    let bytes = unsafe { std::slice::from_raw_parts(command, command_len) }.to_vec();
    let job = NEXT_JOB.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    // Entered before the thread starts, not by it: a poll that lands in between would
    // otherwise read "no such job" and end a wait for work that is about to begin.
    if jobs(|open| open.insert(job, None)).is_none() {
        return 0;
    }

    // Spawning is what can fail here, and it fails by panicking - which out of an
    // `extern "C"` function is an abort, so a machine that has run out of threads would take
    // the server with it rather than refuse one open. 0 is the refusal the caller can read.
    let spawned = crate::guard("bb_prepare_edit_start spawning a thread", false, || {
        std::thread::spawn(move || {
            // The whole job, not just the decode: a panic anywhere in here and the slot below
            // is never filled, which is not a failed open but a promise that never settles -
            // the request hangs until the reader gives up, with the editor still saying
            // "decoding".
            let payload = crate::guard("an open", None, || Some(open_reply(&bytes)))
                .unwrap_or_else(|| crate::edit::refusal("the open panicked"));
            jobs(|open| open.insert(job, Some(payload)));
        });
        true
    });
    if spawned {
        job
    } else {
        jobs(|open| open.remove(&job));
        0
    }
}

/// How a job is getting on: `EDIT_RUNNING`, or the bytes its reply needs, or -1 for a job
/// that was never started, has already been taken, or could not be tracked.
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn bb_prepare_edit_poll(job: u64) -> i64 {
    jobs(|open| match open.get(&job) {
        Some(Some(payload)) => payload.len() as i64,
        Some(None) => EDIT_RUNNING,
        None => -1,
    })
    .unwrap_or(-1)
}

/// One open, from its command to the bytes its reply is made of. Failures are replies too.
fn open_reply(command: &[u8]) -> Vec<u8> {
    let request = match serde_json::from_slice::<crate::edit::EditRequest>(command) {
        Ok(request) => request,
        Err(error) => {
            return crate::edit::refusal(&format!("could not read the edit request: {error}"))
        }
    };
    match crate::edit::prepare(&request).and_then(|frame| crate::edit::encode(&frame)) {
        Ok(bytes) => bytes,
        Err(error) => crate::edit::refusal(&error),
    }
}

/// Copies out a finished job's reply, once. -1 for a job that is not waiting to be taken.
///
/// A null `out` drops it instead, which is how a caller that cannot go on - it failed to
/// allocate, its request was abandoned - says so. Without that the payload would sit in
/// `FINISHED` for the life of the process, and a prepared frame is hundreds of megabytes:
/// the one thing here that must not be leaked by an error path.
///
/// # Safety
/// `out` must point at `out_cap` writable bytes, or be null to discard.
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_prepare_edit_take(job: u64, out: *mut u8, out_cap: usize) -> isize {
    // Only a finished job is takeable. A running one stays where it is: removing it would let
    // its thread put the frame back under an id nobody will ask for again, which is the one
    // leak here that costs hundreds of megabytes.
    let taken = jobs(|open| match open.get(&job) {
        Some(Some(payload)) if !out.is_null() && payload.len() > out_cap => None,
        Some(Some(_)) => open.remove(&job).flatten(),
        _ => None,
    });

    let Some(payload) = taken.flatten() else { return -1 };
    if out.is_null() {
        return 0;
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

/// Names the adapter the grade will run on, or reports that there is none.
///
/// **For the one line the entrypoint prints at boot**, and it earns its place because the
/// interesting failure here is silent. The image carries lavapipe, so a container that
/// cannot reach the host's card does not fail - it renders on a CPU rasteriser, correctly,
/// at a fraction of the speed, and the only evidence is that everything is slow. Naming
/// what answered turns a missing `devices:` or `group_add:` into something a reader sees
/// before importing a library.
///
/// Writes the adapter's name into `out` and returns its length, `bb_transcode_jpeg`'s
/// protocol: a length longer than `out_cap` means nothing was written and the buffer wants
/// to be that big. -1 means no adapter of any kind answered, which is a build with no
/// Vulkan driver at all and the one case that does fail every job.
///
/// # Safety
/// `out` must be writable for `out_cap` bytes, or null to ask for the length.
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_gpu_adapter(out: *mut u8, out_cap: usize) -> isize {
    let Some(gpu) = crate::guard("bb_gpu_adapter", None, crate::gpu::device) else {
        return -1;
    };
    let name = gpu.adapter.as_bytes();
    if name.len() > out_cap || out.is_null() {
        return name.len() as isize;
    }
    let destination = unsafe { std::slice::from_raw_parts_mut(out, name.len()) };
    destination.copy_from_slice(name);
    name.len() as isize
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
    let Ok(path) = (unsafe { std::ffi::CStr::from_ptr(path) }).to_str() else {
        return -1;
    };
    let Some(bytes) = crate::with_embedded_jpeg(path, <[u8]>::to_vec) else {
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

    /// The event-based open's protocol, end to end, without needing a RAW to decode.
    ///
    /// Polls until the job stops saying it is running, and answers with what it settled on.
    fn settled(job: u64) -> i64 {
        for _ in 0..200 {
            let length = bb_prepare_edit_poll(job);
            if length != EDIT_RUNNING {
                return length;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("job {job} never finished");
    }

    /// A command that will not parse fails inside the worker rather than at the call, which
    /// is exactly the path being checked: `start` has to return a job id anyway, the reply
    /// has to arrive from the other thread, and it has to be waiting to be taken when it does.
    #[test]
    fn an_open_finishes_on_its_own_thread_and_waits_to_be_taken() {
        #[expect(unsafe_code)]
        let job = unsafe { bb_prepare_edit_start(b"not json".as_ptr(), 8) };
        assert_ne!(job, 0, "the job starts");

        let length = settled(job);
        assert!(length > 0, "a failed open is a reply, not an absent one");

        // Once, and only once: the frame is hundreds of megabytes and the slot is freed by
        // the call that reads it.
        let mut out = vec![0u8; length as usize];
        #[expect(unsafe_code)]
        let written = unsafe { bb_prepare_edit_take(job, out.as_mut_ptr(), out.len()) };
        assert_eq!(written, length as isize);
        assert!(String::from_utf8_lossy(&out).contains("could not read the edit request"));

        #[expect(unsafe_code)]
        let again = unsafe { bb_prepare_edit_take(job, out.as_mut_ptr(), out.len()) };
        assert_eq!(again, -1, "a job that has been taken is gone");
        assert_eq!(bb_prepare_edit_poll(job), -1, "and polling it says so rather than waiting");
    }

    /// The distinction the whole wait rests on. A caller that read "still running" as "no such
    /// job" would give up on every open; one that read the reverse would wait out its timeout
    /// on a job that was never started.
    #[test]
    fn a_job_that_was_never_started_is_not_a_job_that_is_still_running() {
        assert_eq!(bb_prepare_edit_poll(u64::MAX), -1);
    }

    /// The other way a reply leaves: dropped by a caller that cannot take it.
    ///
    /// Without this the payload would sit under its job id for the life of the process, and a
    /// real one is the whole frame - so the error path that matters is the caller failing to
    /// allocate the buffer it was about to copy into.
    #[test]
    fn a_reply_the_caller_cannot_take_is_dropped_rather_than_kept() {
        #[expect(unsafe_code)]
        let job = unsafe { bb_prepare_edit_start(b"{".as_ptr(), 1) };
        assert!(settled(job) > 0);

        #[expect(unsafe_code)]
        let dropped = unsafe { bb_prepare_edit_take(job, std::ptr::null_mut(), 0) };
        assert_eq!(dropped, 0, "a null buffer discards it");

        let mut out = [0u8; 64];
        #[expect(unsafe_code)]
        let after = unsafe { bb_prepare_edit_take(job, out.as_mut_ptr(), out.len()) };
        assert_eq!(after, -1, "and nothing is left holding the frame");
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
