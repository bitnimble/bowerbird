// The C surface TypeScript calls.
//
// Coarse on purpose, in two directions. One call per job rather than one per
// operation, because the fit evaluates tens of candidates internally and exposing
// its pieces would put the boundary back inside the loop this module exists to
// close. And handles rather than pixels: every call here takes a `BbImage` the
// library still owns and, where it produces an image, hands back another one. JS
// passes a path in and gets a path or a handle out; the samples stay on this side.

use crate::fit;
use crate::job;
use std::ffi::{CStr, c_char};

/// The reply protocol every entry point below answers with, stated once.
///
/// The payload copied into the caller's buffer and its length returned; or, where it does not fit
/// or there is nowhere to put it, the length alone with nothing written, which is what tells the
/// caller how big a buffer to ask again with.
///
/// # Safety
/// `out` must be writable for `out_cap` bytes, or null to ask for the length.
#[expect(unsafe_code)]
unsafe fn reply(payload: &[u8], out: *mut u8, out_cap: usize) -> isize {
    if payload.len() > out_cap || out.is_null() {
        return payload.len() as isize;
    }
    // SAFETY: the caller promises `out_cap` writable bytes, and the payload is no longer.
    let destination = unsafe { std::slice::from_raw_parts_mut(out, payload.len()) };
    destination.copy_from_slice(payload);
    payload.len() as isize
}

/// A caller's buffer as bytes this side can read, or None where it handed over nothing.
///
/// # Safety
/// `ptr` must point at `len` readable bytes, which are borrowed for the call and not retained.
#[expect(unsafe_code)]
unsafe fn borrowed<'a>(ptr: *const u8, len: usize) -> Option<&'a [u8]> {
    if ptr.is_null() {
        return None;
    }
    Some(unsafe { std::slice::from_raw_parts(ptr, len) })
}

/// A caller's NUL-terminated string, or None where it is absent or not UTF-8.
///
/// # Safety
/// `ptr` must be null or point at a NUL-terminated string, borrowed for the call.
#[expect(unsafe_code)]
unsafe fn as_str<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(ptr) }.to_str().ok()
}

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
    // The one place a pointer becomes a Rust value, and it is copied out of
    // immediately: `serde` owns every string in the job, so nothing downstream
    // borrows the caller's buffer and no lifetime escapes this function.
    let Some(bytes) = (unsafe { borrowed(command, command_len) }) else {
        return -1;
    };
    let parsed: Result<job::Job, _> = serde_json::from_slice(bytes);

    let result = match parsed {
        Err(error) => Err(format!("could not read the job: {error}")),
        Ok(parsed) => crate::progress::counted(parsed.report_progress, || {
            crate::guard("bb_run_job", Err("panicked".to_string()), || {
                job::run(&parsed)
            })
        }),
    };

    unsafe { replied(result, out, out_cap) }
}

/// Writes one rendition a client rendered (`job::render_bytes`), as `bb_run_job` would have written
/// it: `command` is the job naming the one target, `framed` the client's frame. Replies as
/// `bb_run_job` does.
///
/// # Safety
/// `command` must point at `command_len` readable bytes, `framed` at `framed_len`, and `out` at
/// `out_cap` writable ones. None is retained.
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_write_rendered(
    command: *const u8,
    command_len: usize,
    framed: *const u8,
    framed_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> isize {
    let (Some(bytes), Some(framed)) =
        (unsafe { borrowed(command, command_len) }, unsafe { borrowed(framed, framed_len) })
    else {
        return -1;
    };
    let result = match serde_json::from_slice::<job::Job>(bytes) {
        Err(error) => Err(format!("could not read the job: {error}")),
        Ok(parsed) => crate::guard("bb_write_rendered", Err("panicked".to_string()), || {
            job::write_rendered(&parsed, framed)
        }),
    };
    unsafe { replied(result, out, out_cap) }
}

/// A job's result as the reply both job entry points answer with.
///
/// # Safety
/// As [`reply`].
#[expect(unsafe_code)]
unsafe fn replied(result: Result<job::Outcome, String>, out: *mut u8, out_cap: usize) -> isize {
    // Both arms are reported the same way, as JSON: a job that failed is a result,
    // not an absent one, and the caller gets the reason rather than a status code it
    // has to look up.
    let payload = match result {
        Ok(outcome) => serde_json::to_vec(&JobReply {
            ok: true,
            error: None,
            outcome: Some(outcome),
        }),
        Err(error) => serde_json::to_vec(&JobReply {
            ok: false,
            error: Some(error),
            outcome: None,
        }),
    };
    let Ok(payload) = payload else { return -1 };
    unsafe { reply(&payload, out, out_cap) }
}

/// How much of a prepared picture's buffer the header may take, before the samples.
///
/// Read once by the caller ([`bb_prepare_header_cap`]) so the two sides cannot disagree about
/// where the samples start. The header is a few hundred bytes plus the analysis blob, which is
/// about 5kB and bounded by the dust list.
pub const PREPARE_HEADER_CAP: usize = 256 * 1024;

/// One picture of a recipe, coded, for a client that will grade it itself.
///
/// **The reply is framed rather than JSON**: a `u32` little-endian header length, that much UTF-8
/// JSON ([`crate::edit::PreparedHeader`] or `{"error":…}`), zero padding to a multiple of four,
/// then the samples as native-endian `u16`. Four, so the samples land on a word and a client can
/// view them without a copy - and in the body rather than beside it, because the desktop shell's
/// proxy keeps seven response headers and drops everything else, so a header would arrive empty.
///
/// **The caller sizes `out` and this never asks for a second call.** A prepared picture is tens of
/// megabytes and its size is known before the call - `width * height * 6 + PREPARE_HEADER_CAP` -
/// where `bb_run_job`'s grow-and-retry would run the whole prepare again for a reply that did not
/// fit. So a short buffer is a failure naming the size it needed, not a retry.
///
/// # Safety
/// `command` must point at `command_len` readable bytes and `out` at `out_cap` writable ones.
/// Both are borrowed for the call and neither is retained.
#[cfg(feature = "renditions")]
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_prepare_picture(
    command: *const u8,
    command_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> isize {
    let Some(bytes) = (unsafe { borrowed(command, command_len) }) else {
        return -1;
    };
    let parsed: Result<PrepareCommand, _> = serde_json::from_slice(bytes);
    let result = match parsed {
        Err(error) => Err(format!("could not read the prepare: {error}")),
        Ok(command) => crate::guard("bb_prepare_picture", Err("panicked".to_string()), || {
            let rect = |[left, top, width, height]: [usize; 4]| {
                crate::px::Rect::exact(left, top, width, height)
            };
            let window = command.window.map(rect);
            let parts: Vec<_> = command.parts.iter().copied().map(rect).collect();
            crate::picture::prepared(&command.job, command.level, window, &parts)
        }),
    };

    let framed = match result {
        Ok(picture) => frame(
            &serde_json::to_vec(&picture.header).unwrap_or_default(),
            &picture.samples,
        ),
        // A failure is framed the same way, so a caller reads the header either way and finds the
        // reason in it rather than having to map a status code.
        Err(error) => frame(
            &serde_json::to_vec(&PrepareFailure { error }).unwrap_or_default(),
            &[],
        ),
    };
    unsafe { reply(&framed, out, out_cap) }
}

/// How many bytes of a prepared picture's buffer are the header's, so the caller sizes for it.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub extern "C" fn bb_prepare_header_cap() -> usize {
    PREPARE_HEADER_CAP
}

/// What a prepare is asked for: an ordinary job, which level of its picture, and what rectangle of
/// that level.
#[cfg(feature = "renditions")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareCommand {
    job: job::Job,
    level: u32,
    /// `[left, top, width, height]` in the level's own pixels, absent for the whole of it.
    #[serde(default)]
    window: Option<[usize; 4]>,
    /// The parts of `window` the caller is short of, empty for the whole of it.
    ///
    /// **An L of tiles costs what the L covers, not what its box does.** Each source is decoded
    /// for the box bounding *its own* parts, and a source no part reaches is not decoded at all -
    /// where the box bounding an L holds a corner nobody asked about, which widens every
    /// footprint and can pull in a source on its own (`composite_tile::CompositeRequest::parts`).
    #[serde(default)]
    parts: Vec<[usize; 4]>,
}

#[cfg(feature = "renditions")]
#[derive(serde::Serialize)]
struct PrepareFailure {
    error: String,
}

/// A header and a body in one buffer: the length, the header, padding to a word, then the samples.
#[cfg(feature = "renditions")]
fn frame(header: &[u8], samples: &[u16]) -> Vec<u8> {
    let at = crate::edit::samples_at(header.len());
    let mut out = Vec::with_capacity(at + samples.len() * 2);
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(header);
    out.resize(at, 0);
    out.extend_from_slice(bytemuck::cast_slice(samples));
    out
}

#[cfg(all(test, feature = "renditions"))]
mod framing {
    use super::*;

    /// The frame a client reads: a length, a header at four, the samples on a word past it.
    #[test]
    fn a_framed_reply_puts_its_samples_on_a_word() {
        // Header lengths either side of every alignment, since the padding is the part a reader
        // gets wrong: one word exactly, one byte over, three over.
        for header_len in [0usize, 1, 3, 4, 5, 7, 8, 100, 4096] {
            let header: Vec<u8> = (0..header_len).map(|i| (i % 251) as u8 + 1).collect();
            let samples: Vec<u16> = (0..17u16).map(|i| i * 4013).collect();
            let framed = frame(&header, &samples);

            let stated = u32::from_le_bytes(framed[0..4].try_into().expect("a length")) as usize;
            assert_eq!(stated, header_len, "the frame states its own header length");
            assert_eq!(
                &framed[4..4 + header_len],
                &header[..],
                "the header follows the length"
            );

            let at = crate::edit::samples_at(stated);
            assert_eq!(at % 4, 0, "the samples start on a word: {at}");
            assert!(
                framed[4 + header_len..at].iter().all(|byte| *byte == 0),
                "the pad is zeroed"
            );
            assert_eq!(
                framed.len(),
                at + samples.len() * 2,
                "nothing follows the samples"
            );
            let read: Vec<u16> = framed[at..]
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            assert_eq!(read, samples, "the samples come back as they went in");
        }
    }

    /// A picture with no samples is still a frame, which is what a failure is reported as.
    #[test]
    fn a_reply_with_no_samples_is_still_a_frame() {
        let header = br#"{"error":"no"}"#;
        let framed = frame(header, &[]);
        let stated = u32::from_le_bytes(framed[0..4].try_into().expect("a length")) as usize;
        assert_eq!(stated, header.len());
        assert_eq!(framed.len(), crate::edit::samples_at(stated));
    }
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
    let Some(path) = (unsafe { as_str(path) }) else {
        return -1;
    };
    let encoded = crate::guard("bb_transcode_jpeg", None, || {
        let bytes = std::fs::read(path).ok()?;
        let decoded = crate::image::decode(&bytes, long_edge as usize).ok()?;
        crate::jpeg::encode(decoded.as_ref(), quality).ok()
    });
    let Some(encoded) = encoded else { return -1 };
    unsafe { reply(&encoded, out, out_cap) }
}

/// Writes an SDR picture and its HDR twin as one file with a gain map between them (§10.5).
///
/// Both paths are AVIFs this process wrote moments earlier, at one size: two dispatches of one
/// export. Hands the file back rather than writing it, for the reason `bb_transcode_jpeg` above
/// does - it is a response body on its way to a socket.
///
/// `format` is `avif` or `jpeg`, and `quality` is that container's own scale: libaom's quantizer
/// for the one, JPEG's 1-100 for the other. It covers the map as well as the base, since the map
/// is what is reconstructed from and spending less on it would put the artefacts in the highlights.
///
/// Returns the byte length written, or the length needed when that is more than `out_cap`, in
/// which case nothing was written. Negative is a failure.
///
/// # Safety
/// `base`, `alternate` and `format` must be NUL-terminated and `out` must point at `out_cap`
/// writable bytes. None is retained past the call.
#[cfg(feature = "renditions")]
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_write_gain_map(
    base: *const c_char,
    alternate: *const c_char,
    format: *const c_char,
    quality: i32,
    speed: i32,
    out: *mut u8,
    out_cap: usize,
) -> isize {
    let (Some(base), Some(alternate), Some(format)) = (
        unsafe { as_str(base) },
        unsafe { as_str(alternate) },
        unsafe { as_str(format) },
    ) else {
        return -1;
    };
    let encoded = crate::guard("bb_write_gain_map", None, || {
        let base = std::fs::read(base).ok()?;
        let alternate = std::fs::read(alternate).ok()?;
        match format {
            "avif" => crate::avif_gain_write::combine(&base, &alternate, quality, speed).ok(),
            "jpeg" => crate::jpeg_gain_write::combine(&base, &alternate, quality).ok(),
            _ => None,
        }
    });
    let Some(encoded) = encoded else { return -1 };
    unsafe { reply(&encoded, out, out_cap) }
}

/// Re-encodes a rendered AVIF into one of the formats an export offers (§10.5).
///
/// `format` is `png`, `png-hdr`, `tiff`, `jxl` or `jxl-hdr`. The `-hdr` arms keep the PQ Rec.2020
/// samples at sixteen bits and state that transfer, so a viewer treats them as HDR; the rest are
/// eight-bit sRGB, which is what the SDR render holds.
///
/// `quality` is JXL's butteraugli distance and is ignored by the lossless formats.
///
/// Bytes back rather than a file, for the reason `bb_transcode_jpeg` hands them back: it is a
/// response body on its way to a socket.
///
/// # Safety
/// `path` and `format` must be NUL-terminated and `out` must point at `out_cap` writable bytes.
/// None is retained past the call.
#[cfg(feature = "renditions")]
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_export_still(
    path: *const c_char,
    format: *const c_char,
    quality: f32,
    out: *mut u8,
    out_cap: usize,
) -> isize {
    let (Some(path), Some(format)) = (unsafe { as_str(path) }, unsafe { as_str(format) }) else {
        return -1;
    };
    let encoded = crate::guard("bb_export_still", None, || {
        let bytes = std::fs::read(path).ok()?;
        match format {
            // Twelve bits of PQ into a sixteen-bit container, which is the whole point: the
            // samples are the ones the AVIF holds rather than a tone map of them.
            "png-hdr" => {
                let (samples, width, height) = crate::avif::decode_at(&bytes, 16).ok()?;
                crate::png_write::encode_hdr(&samples, width, height).ok()
            }
            "jxl-hdr" => {
                let (samples, width, height) = crate::avif::decode_at(&bytes, 16).ok()?;
                crate::jxl_write::encode_hdr(&samples, width, height, quality).ok()
            }
            "png" => {
                let decoded = crate::image::decode(&bytes, 0).ok()?;
                crate::png_write::encode_sdr(
                    decoded.as_ref().data,
                    decoded.as_ref().width,
                    decoded.as_ref().height,
                )
                .ok()
            }
            "jxl" => {
                let decoded = crate::image::decode(&bytes, 0).ok()?;
                let frame = decoded.as_ref();
                crate::jxl_write::encode_sdr(frame.data, frame.width, frame.height, quality).ok()
            }
            "tiff" => {
                let decoded = crate::image::decode(&bytes, 0).ok()?;
                crate::tiff_write::encode(
                    decoded.as_ref().data,
                    decoded.as_ref().width,
                    decoded.as_ref().height,
                )
                .ok()
            }
            _ => None,
        }
    });
    let Some(encoded) = encoded else { return -1 };
    unsafe { reply(&encoded, out, out_cap) }
}

/// Names the adapter the grade will run on, or reports that there is none.
///
/// **For the one line the entrypoint prints at boot**, and it earns its place because the
/// interesting failure here is silent. The image carries SwiftShader, so a container that
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
    unsafe { reply(gpu.adapter.as_bytes(), out, out_cap) }
}

/// Answers a question about pixels, for the tests and pins.
///
/// Same shape as `bb_run_job` and the same rule: JSON in, JSON out, into a buffer the caller
/// owns. It exists because the pins have to assert on what this library produced, and a digest
/// and a per-channel stat answer that without a buffer crossing - which is what a handle API
/// reading samples back would exist for.
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
    let Some(bytes) = (unsafe { borrowed(command, command_len) }) else {
        return -1;
    };
    let parsed: Result<crate::debug::Command, _> = serde_json::from_slice(bytes);
    let result = match parsed {
        Err(error) => Err(format!("could not read the debug command: {error}")),
        Ok(parsed) => crate::guard("bb_for_testing_debug", Err("panicked".to_string()), || {
            crate::debug::run(&parsed)
        }),
    };

    let payload = match result {
        Ok(reply) => serde_json::to_vec(&DebugReply {
            ok: true,
            error: None,
            reply: Some(reply),
        }),
        Err(error) => serde_json::to_vec(&DebugReply {
            ok: false,
            error: Some(error),
            reply: None,
        }),
    };
    let Ok(payload) = payload else { return -1 };
    unsafe { reply(&payload, out, out_cap) }
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
/// failure, or 0 where there is no preview to serve - which is not an error. That
/// covers a file with none embedded, and a rotated one whose preview will not take
/// the EXIF tag that stands it up; `with_embedded_jpeg` says when that happens.
/// -2 where the requested additional turn cannot be written into EXIF.
/// rotate is clockwise degrees in quarter turns; zero keeps the preview unchanged.
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
    rotate: u16,
    out: *mut u8,
    out_cap: usize,
) -> isize {
    let Some(path) = (unsafe { as_str(path) }) else {
        return -1;
    };
    let Some(rotated) = crate::with_embedded_jpeg(path, |jpeg| crate::jpeg::with_added_rotation(jpeg, rotate)) else {
        return 0;
    };
    let Some(bytes) = rotated else {
        return -2;
    };
    unsafe { reply(&bytes, out, out_cap) }
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

    let mut window = SPLINE_WINDOW;
    loop {
        let mut head = Vec::new();
        std::fs::File::open(path)?
            .take(window)
            .read_to_end(&mut head)?;
        let found = crate::lens::read_distortion(&head);
        if found.spline.is_some() {
            return Ok(found);
        }
        // A short read means that was the whole file, so there is nothing further on.
        if (head.len() as u64) < window {
            return Ok(found);
        }
        // The one reason a larger buffer could answer differently is a pointer this walk could
        // not follow, and `needed` is the furthest of those - so no pointer left the window
        // means the file records no spline, whatever its size. That is every CR2, and every
        // CR3, whose byte order mark fails at offset 0 and reaches past nothing at all.
        let Some(reach) = found.needed.filter(|reach| *reach as u64 > window) else {
            return Ok(found);
        };
        // Never less than double, so a file naming its next pointer a page further on each
        // time costs a handful of reads rather than one per page.
        window = (reach as u64).max(window * 2);
    }
}

/// Which geometry tier this file falls into, from the file alone - no pixels decoded.
///
/// None is a file that could not be read, which the callers report separately from a
/// file that simply records no correction.
pub fn geometry_for(path: &str) -> Option<fit::Geometry> {
    let Ok(found) = distortion_of(path) else {
        return None;
    };
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
/// Applied at face value (`tca::supplied_curve`), shape and magnitude both: refitting the
/// strength here measured worse than trusting it, and what makes trusting it safe is not a fit
/// but `tca::improves`, which drops the curve if the frame disagrees.
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
    let [red, blue] = lensdb::tca_knots(
        crate::header::name(&header.camera_make),
        crate::header::name(&header.camera_model),
        crate::header::name(&header.lens_model),
        header.focal,
        header.aperture,
        header.width as usize,
        header.height as usize,
    )?;
    Some([in_spline_units(red), in_spline_units(blue)])
}

/// A radial offset as `lensdb` reports it - a fraction of the radius - into the unit a camera's
/// own spline is carried in, which is what the fit compares the two tiers in.
fn in_spline_units(knots: Vec<f64>) -> Vec<f64> {
    knots.into_iter().map(|it| it * crate::image::SPLINE_UNIT).collect()
}

/// The database's profile for whatever lens this file names.
///
/// None when the file names no lens, when nothing plausible matches, or when the
/// match carries no distortion data - each of which leaves the geometry to be
/// fitted, as it was before lensfun was here.
fn lensfun_geometry(path: &str) -> Option<fit::Geometry> {
    let header = crate::header::read_path(path)?;
    let knots = lensdb::distortion_knots(
        crate::header::name(&header.camera_make),
        crate::header::name(&header.camera_model),
        crate::header::name(&header.lens_model),
        header.focal,
        header.aperture,
        header.width as usize,
        header.height as usize,
    )?;
    Some(fit::Geometry::Profiled(in_spline_units(knots)))
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
/// faults the moment real pixel work starts. So this reduces a frame, which is the
/// resample every fit and preview goes through, then builds a blur's taps over the
/// result and reads a noise level off a histogram of it, which are the float loops a
/// tuned build compiles differently.
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
    let small = crate::image::resize_to_fit(source.as_ref(), 32);
    if small.width != 32 || small.data.iter().all(|value| *value == 0) {
        return -1;
    }
    let taps = crate::image::gaussian(0.8, 2);
    let mut bins = vec![0u32; crate::image::NOISE_BINS];
    for (tap, value) in taps.iter().cycle().zip(&small.data) {
        let residual = (f32::from(*value) / 255.0 * tap).min(crate::image::NOISE_MAX);
        let bin =
            (residual / crate::image::NOISE_MAX * (crate::image::NOISE_BINS - 1) as f32) as usize;
        bins[bin] += 1;
    }
    let sigma = crate::image::sigma_from(&bins, 1.0);
    match sigma.is_finite() && taps.iter().sum::<f32>() > 0.0 {
        true => 0,
        false => -1,
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
