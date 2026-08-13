// A LibRaw wrapper that exposes what the app actually wants, rather than the
// twenty-odd C calls the app currently makes to assemble it.
//
// Everything the TypeScript decoder does per frame happens here instead: as-shot
// white balance, PPG demosaic, the half-size decision, and the masked-border crop
// during the copy out of LibRaw's buffer. JS gets one call and a pointer.
//
// The reason this exists rather than a one-function shim: `params.half_size` has
// no setter in the C API, and bindgen resolves it from the installed headers, so
// the offset is the compiler's problem instead of something located at runtime.
//
// `bb_` and `Bb` are short for Bowerbird. On the exported functions the prefix is
// not decoration: C has one flat symbol namespace, and this library is dlopen'd
// into a process that already holds LibRaw, lensfun and libavif, so a bare
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
// native/rawshim/src` is the audit, and the count only ever goes down.
//
// What is left is the irreducible part: reading the one command buffer at an entry
// point, and calling LibRaw, libavif and lensfun, which are C. Nothing is
// marked for our own memory any more - a `Frame` is an owned Rust value with a real
// lifetime, and the handle API that needed raw pointers for it survives only behind
// a lint fence, for tests.
#![deny(unsafe_code)]
#![deny(unfulfilled_lint_expectations)]
#![deny(unsafe_op_in_unsafe_fn)]

#[cfg(feature = "renditions")]
use std::ffi::CStr;
#[cfg(feature = "renditions")]
use std::os::raw::c_char;
#[cfg(feature = "renditions")]
use std::os::raw::c_int;

#[cfg(feature = "renditions")]
pub mod avif;
pub mod camera_match;
#[cfg(feature = "renditions")]
pub mod debug;
pub mod decode_rawler;
pub mod demosaic;
/// The editor's open half. The tick that follows it is the client's GPU.
pub mod edit;
#[cfg(feature = "renditions")]
pub mod ffi;
pub mod fit;
pub mod frame;
/// The denoise, on the mosaic, before anything has averaged a neighbour into it.
pub mod galosh;
pub mod galosh_srgb;
pub mod gpu;
pub mod hdr;
pub mod hdr_args;
pub mod hdr_fit;
pub mod header;
pub mod image;
pub mod jpeg;
#[cfg(feature = "renditions")]
pub mod job;
pub mod lens;
#[cfg(feature = "renditions")]
pub mod lensfun;
pub mod noise;
pub mod parallel;
pub mod rgb;
#[cfg(feature = "renditions")]
pub mod stacks;
pub mod tca;
pub mod tone;
pub mod white_balance;

/// lensfun and libavif, which only a `renditions` build binds. An editor build links no C at all
/// and so has no bindings to declare.
#[cfg(feature = "renditions")]
mod raw {
    #![allow(
        non_upper_case_globals,
        non_camel_case_types,
        non_snake_case,
        dead_code
    )]
    #![expect(unsafe_code)]
    include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
}

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
pub(crate) fn guard<T>(what: &str, fallback: T, body: impl FnOnce() -> T) -> T {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        Ok(value) => value,
        Err(_) => {
            eprintln!(
                "rawshim: {what} panicked; reporting failure rather than aborting the process"
            );
            fallback
        }
    }
}

// The denoise used to be scaled here by the frame's ISO, on the reasoning that shot
// noise goes as its square root. It is measured off the frame instead now
// (`image::measure_noise`), which answers the same question better: by the time the
// denoise runs, the frame has been through a demosaic, a resample that averaged some of
// the noise away and a grade that may have lifted it several stops, and none of that is
// in the ISO. Asking the pixels costs one box mean and needs no reference ISO, no cap
// and no special case for a body that records nothing.

/// Decodes a RAW to an owned frame.
///
/// The body of what `bb_decode` used to be, with the handle taken off the end. Every
/// caller on this side wants a `Frame`; only the boundary wanted a pointer, and it
/// is the one place that still builds one.
pub fn decode_frame(
    path: &str,
    depth: u32,
    rec2020_linear: bool,
    at_least_long_edge: u32,
) -> Option<frame::Frame> {
    decode_frame_via(
        DecodeSource::Path(path),
        depth,
        rec2020_linear,
        at_least_long_edge,
        false,
        galosh::Amounts::default(),
    )
}

/// The same decode, with the mosaic denoised before it is demosaiced.
///
/// Its own entry point rather than a parameter on every decode, because only a rendition
/// asks for it: the editor's frame crosses to a client that denoises on its own, in its own
/// domain and at whatever cost a tick can afford, and the two answers are deliberately not
/// the same one (DESIGN 10.9).
pub fn decode_frame_denoised(
    path: &str,
    depth: u32,
    rec2020_linear: bool,
    at_least_long_edge: u32,
    amounts: galosh::Amounts,
) -> Option<frame::Frame> {
    decode_frame_via(
        DecodeSource::Path(path),
        depth,
        rec2020_linear,
        at_least_long_edge,
        false,
        amounts,
    )
}

pub fn decode_frame_bytes(
    bytes: &[u8],
    depth: u32,
    rec2020_linear: bool,
    at_least_long_edge: u32,
) -> Option<frame::Frame> {
    decode_frame_via(
        DecodeSource::Bytes(bytes),
        depth,
        rec2020_linear,
        at_least_long_edge,
        false,
        galosh::Amounts::default(),
    )
}

enum DecodeSource<'a> {
    Path(&'a str),
    Bytes(&'a [u8]),
}

/// `decode_frame`, on LibRaw's own `dcraw_make_mem_image` path rather than the fused
/// one (§10.4).
///
/// Only the differential pin wants this, and it wants it because the two routes must
/// agree to the byte. It used to be an environment variable read inside the library,
/// which meant a subprocess per case to set it; a parameter says the same thing and
/// lets both arms run in one process.
#[cfg(all(test, feature = "fixtures"))]
pub fn _for_testing_decode_frame_reference(
    path: &str,
    depth: u32,
    rec2020_linear: bool,
    at_least_long_edge: u32,
) -> Option<frame::Frame> {
    decode_frame_via(
        DecodeSource::Path(path),
        depth,
        rec2020_linear,
        at_least_long_edge,
        true,
        galosh::Amounts::default(),
    )
}

fn decode_frame_via(
    source: DecodeSource<'_>,
    depth: u32,
    rec2020_linear: bool,
    at_least_long_edge: u32,
    reference: bool,
    amounts: galosh::Amounts,
) -> Option<frame::Frame> {
    decode_frame_cropped(source, depth, rec2020_linear, at_least_long_edge, reference, amounts, None)
}

/// `at_least_long_edge` is a floor rather than a size: the smallest long edge that would still
/// serve. A frame whose own is at least twice that is halved, which skips the demosaic entirely.
fn decode_frame_cropped(
    source: DecodeSource<'_>,
    depth: u32,
    rec2020_linear: bool,
    at_least_long_edge: u32,
    _reference: bool,
    amounts: galosh::Amounts,
    crop: Option<Tile>,
) -> Option<frame::Frame> {
    if depth != 8 && depth != 16 {
        return None;
    }
    let scene = match (&source, crop) {
        // A tile is magnifying, so it is never halved however small the caller's floor is.
        (DecodeSource::Path(path), Some(tile)) => decode_rawler::decode_tile(path, tile, amounts),
        (DecodeSource::Path(path), None) => decode_rawler::decode_fitted(path, amounts, at_least_long_edge),
        // A tile of an in-memory source has no caller, so it is refused rather than read to a file
        // to get one.
        (DecodeSource::Bytes(bytes), None) => decode_rawler::decode_bytes(bytes, amounts, at_least_long_edge),
        (DecodeSource::Bytes(_), Some(_)) => None,
    }?;

    // Scene-linear Rec.2020 is what the decode produces; 8-bit sRGB is that with the matrix and the
    // transfer curve on top. `dcraw_process` handed the second back directly, which is why the two
    // still arrive as one request.
    match (depth, rec2020_linear) {
        (16, true) => Some(scene),
        (8, false) => decode_rawler::to_srgb8(&scene),
        _ => None,
    }
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
pub fn decode_tile(
    path: &str,
    crop: Tile,
    depth: u32,
    rec2020_linear: bool,
    amounts: galosh::Amounts,
) -> Option<frame::Frame> {
    decode_frame_cropped(
        DecodeSource::Path(path),
        depth,
        rec2020_linear,
        0,
        false,
        amounts,
        Some(crop),
    )
}

/// A rectangle of the mosaic, in the raw image's own pixels.
#[derive(Clone, Copy)]
pub struct Tile {
    pub left: usize,
    pub top: usize,
    pub width: usize,
    pub height: usize,
}

impl Tile {
    /// The window grown by `halo` on every side, which is what a tile needs.
    ///
    /// The denoise is local with a bounded reach - the chroma pyramid goes to an eighth of the
    /// frame and the joint upsample reads a neighbourhood on the way back - so a tile denoised
    /// on its own disagrees with its neighbour along the seam unless both were computed with
    /// the context that reaches across it. The halo is trimmed off by the demosaic's own crop.
    pub fn with_halo(self, halo: usize) -> Tile {
        Tile {
            left: self.left.saturating_sub(halo),
            top: self.top.saturating_sub(halo),
            width: self.width + halo * 2,
            height: self.height + halo * 2,
        }
    }
}

/// How much context the mosaic denoise needs either side of a tile.
///
/// A multiple of eight, because the chroma pyramid's smallest level is an eighth of what it is
/// given; 64 covers that and the joint upsample's own neighbourhood on the way back up.
pub const TILE_HALO: usize = 64;

/// The camera's embedded preview as an owned frame, fitted to `long_edge`.
///
/// The whole of an import's tile pass in one call. None when the file embeds no
/// JPEG preview, which is a property of the file rather than an error: the caller
/// falls back to a render.
pub fn decode_embedded_frame(raw_path: &str, long_edge: u32) -> Option<frame::Frame> {
    let decoded = guard("decode_embedded_frame", None, || {
        with_embedded_jpeg(raw_path, |jpeg| jpeg::decode(jpeg, long_edge as usize))
    })?;
    let image = decoded.ok()?;
    Some(frame::Frame::new(
        image.width,
        image.height,
        frame::Pixels::Eight(image.data),
    ))
}

/// The camera match for an 8-bit render, fitted against the embedded JPEG (10.8).
///
/// None when the file embeds no preview, when the fit found nothing worth applying,
/// or when there were too few usable pairs - in each case the caller renders
/// untransformed.
#[cfg(feature = "renditions")]
pub fn fit_profile_for(render: &frame::Frame, raw_path: &str) -> Option<fit::Profile> {
    let source = render.rgb8()?;
    let geometry = ffi::geometry_for(raw_path)?;
    let fitted = guard("fit_profile_for", None, || {
        with_embedded_jpeg(raw_path, |jpeg| fit::fit(source, jpeg, geometry).ok().flatten())
    })?;
    // After the fit, not inside it: the lateral aberration is measured off the render
    // alone, so it wants neither the preview nor the search (`fit::with_lateral`).
    let mut fitted = fitted?;
    fit::with_lateral(&mut fitted, source, ffi::recorded_lateral(raw_path));
    Some(fitted)
}

/// The camera match for the HDR grade, in the domain the grade works in (10.8.1).
///
/// Reuses the geometry an SDR fit already resolved where there is one; where nothing
/// renders SDR both halves run off this decode in a single pass over it.
///
/// `finished` is what the frame will have had done to it by the time the match is applied,
/// so the geometry search can be run against that rather than against the raw render.
#[cfg(feature = "renditions")]
pub fn fit_hdr_for(
    linear: &frame::Frame,
    raw_path: &str,
    quantile: f64,
    profile: Option<&fit::Profile>,
    finished: image::Strengths,
) -> Option<hdr_fit::HdrMatch> {
    let samples = linear.samples16()?;
    let source = hdr::Source {
        samples,
        width: linear.width,
        height: linear.height,
    };
    guard("fit_hdr_for", None, || match profile {
        Some(profile) => hdr::fit_match(raw_path, &source, quantile, profile.lens()),
        None => {
            let geometry = ffi::geometry_for(raw_path)?;
            hdr::fit_all(raw_path, &source, quantile, geometry, finished)
                .map(|(_, matched)| matched)
        }
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
    source: rgb::RgbRef<'_>,
    quantizer: i32,
    effort: i32,
    full_chroma: bool,
    out_path: &str,
) -> Result<(), String> {
    // libvips counted effort up from 0 as *fastest*; libavif counts speed down from
    // 10 as fastest. Same knob, opposite ends.
    let speed = (10 - effort).clamp(0, 10);
    avif::encode_rendition(
        source.data.into(),
        source.width,
        source.height,
        quantizer,
        speed,
        full_chroma,
        out_path,
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
/// is a property of the file rather than an error, and the caller falls back to a render.
fn with_embedded_jpeg<T>(path: &str, use_bytes: impl FnOnce(&[u8]) -> T) -> Option<T> {
    decode_rawler::upright_preview_jpeg(path).map(|jpeg| use_bytes(&jpeg))
}

/// The camera's embedded preview as RGB, bounded by `long_edge`, for callers on this
/// side of the boundary. None when the file embeds no JPEG preview.
#[cfg(feature = "renditions")]
pub fn decode_embedded_rgb(path: &str, long_edge: usize) -> Option<rgb::Rgb> {
    let decoded = with_embedded_jpeg(path, |bytes| jpeg::decode(bytes, long_edge));
    match decoded {
        Some(Ok(image)) => Some(image),
        Some(Err(detail)) => {
            eprintln!("decode_embedded_rgb: {detail}");
            None
        }
        None => None,
    }
}

/// Reads what the catalogue needs from a RAW without decoding a pixel.
///
/// Returns 0 on success, -1 if the file could not be opened. See `header.rs` for
/// why this is not a set of byte offsets in TypeScript any more.
///
/// # Safety
/// `path` must be a NUL-terminated C string and `out` a writable `BbHeader`.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_read_header(path: *const c_char, out: *mut header::BbHeader) -> c_int {
    if path.is_null() || out.is_null() {
        return -1;
    }
    let Ok(path) = unsafe { CStr::from_ptr(path) }.to_str() else {
        return -1;
    };
    // Runs on every file of a scan, and parses maker notes off untrusted bytes.
    match guard("bb_read_header", None, || header::read_path(path)) {
        Some(header) => {
            unsafe {
                *out = header;
            }
            0
        }
        None => -1,
    }
}

/// Size of `BbHeader`, which the caller checks against the layout it reads.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub extern "C" fn bb_header_size() -> usize {
    std::mem::size_of::<header::BbHeader>()
}

/// How many bytes a stacking descriptor occupies, so the caller can size its
/// buffer and the database column without either guessing.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub extern "C" fn bb_descriptor_size() -> usize {
    stacks::DESCRIPTOR_BYTES
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

/// Holding behaviour to a recorded copy of it, shared by the argv pin (synthetic) and
/// the grade pin (fixture-backed).
#[cfg(test)]
mod pin;

/// The tests that decode a real RAW, behind the `fixtures` feature so the default
/// suite stays fast enough to run on every edit.
#[cfg(all(test, feature = "fixtures"))]
mod fixture_tests;

#[cfg(test)]
mod tests {
    use super::*;

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
        let Ok(path) = std::env::var("BOWERBIRD_TILE_RAW") else { return };
        // The decode either side of the tile, which is what the region read is measured against.
        // `tile_check` is the finer instrument - it compares a tile against the frame's own
        // pixels - and this is the wall clock a reader waits on.
        let started = std::time::Instant::now();
        let whole = decode_frame(&path, 16, true, 0).expect("the frame decodes");
        println!(
            "  whole frame             {:>5}ms  {}x{}",
            started.elapsed().as_millis(),
            whole.width,
            whole.height,
        );

        // The whole server path, which is what a reader actually waits on: `job::tile` fits the
        // camera match and grades on top of the decode below.
        #[cfg(feature = "renditions")]
        {
            let tile_job = |side: usize| job::Job {
                raw_file_path: path.clone(),
                match_embedded_jpeg: true,
                tile: Some([2000, 1400, side, side]),
                camera_match: None,
                denoise_luminance: 20.0,
                denoise_colour: 30.0,
                sharpen: 1.0,
                defringe: 1.0,
                exposure: 0.0,
                adjust: gpu::Adjust::none(),
                geometry: image::Geometry::none(),
                grade: hdr::Grade {
                    peak_nits: 1000.0,
                    reference_white_nits: 203.0,
                    white_quantile: 0.995,
                },
                targets: Vec::new(),
            };
            job::tile(&tile_job(400));
            for side in [400usize, 700] {
                let started = std::time::Instant::now();
                let bytes = job::tile(&tile_job(side)).expect("the tile renders");
                println!(
                    "  job::tile, {side}px         {:>5}ms  {} kB",
                    started.elapsed().as_millis(),
                    bytes.len() / 1024,
                );
            }
            // How big the fit actually is, which decides whether it is worth storing per photo
            // rather than re-fitting. Measured rather than counted off the constants.
            if let Some(frame) = decode_frame(&path, 16, true, 0) {
                if let Some(fitted) =
                    fit_hdr_for(&frame, &path, 0.995, None, image::Strengths::default())
                {
                    let colour = &fitted.colour;
                    let numbers = colour.curves.iter().map(Vec::len).sum::<usize>()
                        + 9
                        + colour.chroma.as_ref().map_or(0, |map| map.nodes_flat().len())
                        + fitted.lens.distortion.as_ref().map_or(0, Vec::len)
                        + fitted.lens.tca.as_ref().map_or(0, |pair| pair[0].len() + pair[1].len())
                        + 3;
                    let blob = camera_match::encode(&fitted);
                    println!(
                        "  the fit is {numbers} numbers, {} bytes stored ({} kB as f64)",
                        blob.len(),
                        numbers * 8 / 1024,
                    );

                    // And the tile with that match handed to it, which is what a photograph
                    // whose fit has been kept costs from the second request onwards.
                    let mut with_match = tile_job(400);
                    with_match.camera_match = Some(blob);
                    job::tile(&with_match);
                    let started = std::time::Instant::now();
                    job::tile(&with_match).expect("renders");
                    println!(
                        "  job::tile, match stored  {:>5}ms",
                        started.elapsed().as_millis(),
                    );
                }
            }

            // The same tile with no camera match, which is the one expensive thing a tile
            // repeats that belongs to the *photograph* rather than to the crop.
            let mut unmatched = tile_job(400);
            unmatched.match_embedded_jpeg = false;
            let started = std::time::Instant::now();
            job::tile(&unmatched).expect("renders");
            println!("  job::tile, no match      {:>5}ms", started.elapsed().as_millis());
        }

        // And the decode alone: one tile, denoised and demosaiced, from nothing.
        //
        // Warmed first, because the pipelines and the adapter are built once per process and a
        // loupe asks its second question with them already up.
        let warm = Tile { left: 2000, top: 1400, width: 400, height: 400 };
        decode_tile(&path, warm, 16, true, galosh::Amounts::from_sliders(40.0, 40.0));
        for side in [400usize, 700] {
            let crop = Tile { left: 2000, top: 1400, width: side, height: side };
            let started = std::time::Instant::now();
            let tile = decode_tile(&path, crop, 16, true, galosh::Amounts::from_sliders(40.0, 40.0));
            let took = started.elapsed().as_millis();
            let frame = tile.expect("the tile decodes");
            println!(
                "  whole tile, {side}px        {took:>5}ms  {}x{}",
                frame.width, frame.height,
            );
            assert!(frame.width <= side + 8 && frame.height <= side + 8, "the crop is the tile");
        }
    }

    // Every orientation LibRaw can hand over, which the fixtures cannot give.
    //
    // Both test RAWs carry EXIF orientation 8, which dcraw maps to flip 5 - so the
    // byte-for-byte pin against `dcraw_make_mem_image` covers one value out of eight,
    // and *not* flip 0, an ordinary landscape photograph. The commit that added it
    // claimed two. This is the coverage that claim wanted.
    //
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
