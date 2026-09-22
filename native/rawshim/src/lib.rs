// The decode, the fit and the grade, exposed as what the app actually wants rather
// than the twenty-odd C calls it once made to assemble them.
//
// Everything a frame needs happens on this side: as-shot white balance, the demosaic, the
// half-size decision, and the masked-border crop. JS gets one call and a pointer.
//
// `bb_` and `Bb` are short for Bowerbird. On the exported functions the prefix is
// not decoration: C has one flat symbol namespace, and this library is dlopen'd
// into a process that already holds lensfun and libavif, so a bare
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
// native/rawshim/src` is the audit.
//
// A marker counts one operation, not one block, so it measures the C surface rather
// than how much code sits inside a brace - and a `Drop` of two lines carries as much
// weight as a body of sixty. The number that has to keep falling is the calls
// themselves: `grep -rniE "destroy\(|_free\(|from_raw_parts" native/rawshim/src`.
// Case-insensitive because lensfun's C API is snake_case where libavif's and libjxl's
// are CamelCase, and a pattern that misses one of them audits nothing.
//
// Every C handle is owned by a Rust value whose `Drop` frees it - `avif::Image`,
// `avif::Encoder`, `avif_gain_write::GainMap`, `lensfun::Modifier`,
// `jxl_write::Runner` - so the marked calls are the one that creates and the one that
// frees, and no early return can leak in between.
//
// What is left is the irreducible part: reading the one command buffer at an entry
// point, and calling libavif, libjxl and lensfun, which are C. Our own memory is
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

/// The headroom behind Apple's own gain map, which the two maker note tags state between them.
pub mod apple_gain;
/// A composition's geometry, and the tiles across it that each take one frame.
pub mod assembly;
/// A set of photographs into an assembly: the whole of §3, up to the field its seams are solved over.
pub mod assembly_analysis;
/// What each piece's frame is multiplied by to meet the light across its seams.
pub mod assembly_balance;
/// §5.2's two bands, mixed in log2 light: the lowpass at `W(x)`, the detail at two render pixels.
pub mod assembly_blend;
/// The jobs an assembly asks for that render nothing: its analysis, and its seams.
#[cfg(feature = "renditions")]
pub mod assembly_job;
/// Which frame each cell takes under the reader's picks.
pub mod assembly_labelling;
/// Each frame's light and colour over every cell a seam is solved on.
pub mod assembly_levels;
/// What the analysis measures over: every source of a recipe, prepared and on one canvas.
pub mod assembly_planes;
/// The crop-wide lowpass a render's two-band mix reads.
pub mod assembly_render;
/// The field a seam is solved over, and the min cut that solves it.
pub mod assembly_seam;
/// Where the frames a reader picked meet, solved for those picks.
pub mod assembly_seams;
/// A labelling's pieces as one subdivision whose neighbours share their vertices.
pub mod assembly_tiles;
/// What the analysis leaves on disk for a seam solve.
pub mod assembly_volume;
/// §5.2's weight field: one signed distance a source, one `W(x)` for all of them.
pub mod assembly_weight;
#[cfg(feature = "renditions")]
pub mod avif;
/// Writing a gain map beside a picture, which only an export asks for.
#[cfg(feature = "renditions")]
pub mod avif_gain_write;
/// The same, in the spelling a JPEG carries it.
#[cfg(feature = "renditions")]
pub mod jpeg_gain_write;
/// JPEG XL, the same.
#[cfg(feature = "renditions")]
pub mod jxl_write;
/// PNG, which an export can ask for and nothing else writes.
#[cfg(feature = "renditions")]
pub mod png_write;
/// TIFF, the same.
#[cfg(feature = "renditions")]
pub mod tiff_write;
/// Test answers committed as PNGs a reader can open, and the side-by-side that shows one moving.
#[cfg(all(feature = "renditions", not(target_arch = "wasm32")))]
pub mod snapshot;
/// The stages between the demosaic and the grade, moving onto the GPU one at a time.
pub mod base;
/// Where a patch of one frame lies in another, or elsewhere in its own.
pub mod patch_search;
pub mod photo_analysis;
pub mod view;
/// What a uniform block is, according to the shader that reads it.
#[cfg(test)]
mod wgsl_layout;
/// Which colour each photosite carries, as a period rather than as a 2x2.
pub mod cfa;
/// The monotonic clock the timed paths read, which `wasm32` has none of.
pub mod clock;
/// The sensor's samples into the mosaic, with the samples crossing to the GPU rather than it.
pub mod condition;
#[cfg(feature = "renditions")]
pub mod debug;
/// Which decoder a photograph gets, which is the one place the two front ends differ.
pub mod decode;
pub mod decode_rawler;
/// The photographs that arrive already rendered: PNG, JPEG, HEIC and AVIF.
pub mod decode_rendered;
pub mod demosaic;
/// Sensor particles found on the mosaic, and their shadows divided back out of it.
pub mod dust;
/// The search half of that, dispatched on the device the mosaic is already on.
pub mod dust_find;
/// The editor's open half. The tick that follows it is the client's GPU.
pub mod edit;
#[cfg(feature = "renditions")]
pub mod ffi;
pub mod fit;
mod fit_curve;
mod fit_objective;
mod fit_pairs;
mod fit_lattice;
mod fit_moments;
pub mod fit_score;
mod fit_span;
mod fit_wide;
pub mod fit_source;
pub mod frame;
/// The denoise, on the mosaic, before anything has averaged a neighbour into it.
pub mod galosh;
/// The other denoise, in the same place: a learned network a reader can choose instead.
pub mod pmrid;
pub mod gpu;
pub mod hdr;
pub mod hdr_args;
pub mod hdr_fit;
pub mod header;
/// A HEIF file's boxes: where the picture is, what colour it is, and what came with it.
pub mod heif;
/// The HEVC bitstream inside a HEIC, into the code values the linearise reads.
pub mod hevc;
pub mod image;
pub mod jpeg;
/// The gain map a JPEG carries as its second MPF image, in either spelling of the terms.
pub mod jpeg_gain;
pub mod job;
pub mod lens;
#[cfg(feature = "renditions")]
pub mod lensfun;
pub mod light;
/// A finished picture's code values into the frame the pipeline reads. The rendered formats'
/// answer to the conditioning and the demosaic, which they have no mosaic for.
pub mod linearise;
/// Demosaicing by luma-chroma demultiplexing, for the patterns RCD cannot pair into 2x2 sites.
pub mod lslcd;
pub mod open;
/// Which way up a file says its picture goes, in the numbering both hosts and both shaders use.
pub mod orientation;
/// A set of photographs into a recipe: what overlaps what, and where each one points.
pub mod composite_align;
/// Corners of a frame and what each one looks like, so a match can be asked whether it is *unique*
/// - which is the one thing a correlation search cannot say.
pub mod composite_features;
/// What a job asks of a composite: align a set of photographs, or render the recipe that came out.
///
/// The server's half, like `job` it hands its work to: the browser opens one photograph and has
/// no rendition to build, so a composite is not something it can be asked for.
#[cfg(feature = "renditions")]
pub mod composite_job;
/// What two frames of a composite have in common: how far apart they sit, and where their content
/// corresponds once that is known.
pub mod composite_pairs;
/// A world, and what a camera pointed at it would have recorded: the synthetic views a composite's
/// alignment is exercised against, and the library the end-to-end suite composes one out of.
pub mod composite_scene;
/// Where each frame of a composite points, and how long the lens was, from what the pairs found.
pub mod composite_solve;
/// What a composition is: the sources a composite is made of, where each one points, and the
/// surface they are projected onto. A panorama is one recipe over it; an assembly is another.
pub mod composition;
/// One rectangle of a composite's canvas, gathered source by source and blended.
pub mod composite_tile;
pub mod parallel;
/// One picture of a recipe, coded and handed over, for a client that will grade it itself.
///
/// A rendition stopped one stage early, so a reader dragging a slider and the export they are
/// heading towards are the same picture.
#[cfg(feature = "renditions")]
pub mod picture;
/// How far the work somebody is waiting on has got, read from outside the call doing it.
pub mod progress;
pub mod px;
pub mod raw_cache;
pub mod repair;
pub mod repair_solve;
pub mod resident;
pub mod retouched_frame;
pub mod rgb;
pub mod scrub;
#[cfg(feature = "renditions")]
pub mod stacks;
pub mod tca;
pub mod tca_device;
pub mod tile;
pub mod tile_grid;
pub mod tone;
/// What a delivered picture's code values mean: somebody else's transfer, in somebody else's
/// primaries, undone into the light the pipeline grades.
pub mod transfer;
/// The browser's entry points, which no other host has.
#[cfg(target_arch = "wasm32")]
pub mod wasm;
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
/// A line about something the pipeline declined to do, where the reader will actually see it.
///
/// **`eprintln!` is dropped on `wasm32-unknown-unknown`**, whose std has no stderr behind it - so
/// the announcements that exist to stop a fall-through being silent were silent in the one host
/// that has the most to fall through to. The console is where a page's are.
pub(crate) fn warn(message: &str) {
    #[cfg(target_arch = "wasm32")]
    console::warn(message);
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{message}");
}

#[cfg(target_arch = "wasm32")]
mod console {
    #[wasm_bindgen::prelude::wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = console)]
        pub fn warn(message: &str);
    }
}

/// A panic's message, for the same reason: without one the page is told `unreachable` and nothing
/// else - not the assertion, not the file, not the line, only the trap the panic ends in.
///
/// At module init, so it covers every entry point rather than the one that remembered to ask.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn announce_panics() {
    std::panic::set_hook(Box::new(|panicked| console::warn(&format!("rawshim: {panicked}"))));
}

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

// **The denoise is not scaled by the frame's ISO.** Shot noise does go as its square root, but
// the ISO is what the body was set to rather than what the sensor did, and it says nothing about
// a pushed exposure. It is fitted off the mosaic instead (`galosh::NoiseModel`, carried on the
// frame), which needs no reference ISO, no cap, and no special case for a body that records
// nothing.

/// Decodes a RAW to an owned frame.
///
/// Every caller on this side wants a `Frame`; only the FFI boundary wants a pointer, and it is
/// the one place that builds one.
pub fn decode_frame(path: &str, at_least_long_edge: u32) -> Option<frame::Frame> {
    decode_frame_via(DecodeSource::Path(path), at_least_long_edge, galosh::Detail::at(0.0, 0.0))
}

/// The same decode, with the mosaic denoised before it is demosaiced.
///
/// `fit` is whose statistics it filters with: [`galosh::Fit::Given`] where the caller has the
/// photograph's already, which is a quarter of a second of whole-frame reductions it does not pay
/// again (`crate::photo_analysis`).
pub fn decode_frame_denoised(
    path: &str,
    at_least_long_edge: u32,
    detail: galosh::Detail,
    fit: galosh::Fit,
) -> Option<frame::Frame> {
    decode_frame_cropped(DecodeSource::Path(path), at_least_long_edge, detail, None, fit)
}

/// `fit` is what the decode does about the noise, and only an in-memory decode is ever asked:
/// [`galosh::Fit::Only`] measures the frame without filtering it, which is the editor's open, and
/// the measurement rides back on `frame.noise` for the loupe tiles that follow.
pub fn decode_frame_bytes(
    bytes: &[u8],
    at_least_long_edge: u32,
    fit: galosh::Fit,
) -> Option<frame::Frame> {
    decode_frame_cropped(
        DecodeSource::Bytes(bytes),
        at_least_long_edge,
        galosh::Detail::at(0.0, 0.0),
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
    detail: galosh::Detail,
) -> Option<frame::Frame> {
    decode_frame_cropped(source, at_least_long_edge, detail, None, galosh::Fit::Measure)
}

/// `at_least_long_edge` is a floor rather than a size: the smallest long edge that would still
/// serve. A frame whose own is at least twice that is halved, which skips the demosaic entirely.
fn decode_frame_cropped(
    source: DecodeSource<'_>,
    at_least_long_edge: u32,
    detail: galosh::Detail,
    crop: Option<(crate::view::View, usize)>,
    fit: galosh::Fit,
) -> Option<frame::Frame> {
    // Nothing taken off the glass here. The callers below are the ones that are not the pipeline -
    // the debug renders, the fixture pins, the examples - and a spot removed from a fixture is a
    // fixture that no longer pins what it was written to pin.
    let glass = dust::Wanted::Off;
    let scene = match (&source, crop) {
        // The view carries its own scale, so `at_least_long_edge` says nothing here: whether a
        // window is halved is the *photograph's* question and the caller has already answered it.
        (DecodeSource::Path(path), Some((view, halo))) => pollster::block_on(decode::tile_from(
            decode::Source::Path(path),
            view,
            detail,
            fit,
            halo,
            dust::Known::Off,
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
/// two callers want different answers: `RENDITION_TILE_HALO` where the tile has to match what a
/// render would produce, `EDITOR_TILE_HALO` where it is drawn and then replaced.
pub fn decode_tile(
    path: &str,
    view: crate::view::View,
    detail: galosh::Detail,
    fit: galosh::Fit,
    halo: usize,
) -> Option<frame::Frame> {
    decode_frame_cropped(DecodeSource::Path(path), 0, detail, Some((view, halo)), fit)
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
    /// The denoise is local with a bounded reach - the chroma pyramid goes to a quarter of the
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

/// How much context the mosaic denoise needs either side of a tile, where what a seam costs is
/// worth more than what it costs to avoid.
///
/// **96 is where the join is exact and 32 is where it stops being visible**, and they are not the
/// same question. Measured by `examples/halo_seams.rs` over photographs and by
/// `examples/halo_pattern.rs` over a field built to be worse than any of them: the join's excess
/// over its own neighbourhood falls to the baseline at 32 and stays there, while 16 is still a
/// line at several times it.
///
/// **What sets the exact one is the coarse level's reach, not the full-resolution pass's.** That
/// pass depends on about fourteen pixels either side and was exact at 64; the level below it works
/// on a plane [`galosh::COARSE_SCALE`] times smaller, so the same fourteen of *its* samples are
/// four times as far across the frame. `tiling_the_denoise_does_not_move_a_sample` is what says
/// where that lands.
///
/// A rendition is kept and looked at later, so it takes the exact one. So does the loupe, whose
/// whole purpose is to predict what a rendition will be - a magnifier denoised differently from
/// the export is a magnifier that lies, which is worse than a slower one.
pub const RENDITION_TILE_HALO: usize = 96;

/// The same, for a tile the editor draws and then replaces.
///
/// Past the knee, and a multiple of four for the chroma pyramid. What it buys is set by the tile
/// size rather than by itself: over a 61MP frame the whole 16-to-64 range is 9% at 2048 tiles and
/// 37% at 512, so the halo is cheap and small tiles are not.
pub const EDITOR_TILE_HALO: usize = 32;

/// Set by the seam harnesses to cut one frame at several halos from one process, which is the only
/// way to put the results beside each other. `usize::MAX` leaves the caller's own choice alone.
static TILE_HALO_OVERRIDE: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(usize::MAX);

pub fn set_tile_halo(halo: usize) {
    TILE_HALO_OVERRIDE.store(halo, std::sync::atomic::Ordering::Relaxed);
}

/// The halo to use, which is the caller's unless a harness has taken the choice away.
pub fn tile_halo(asked: usize) -> usize {
    match TILE_HALO_OVERRIDE.load(std::sync::atomic::Ordering::Relaxed) {
        usize::MAX => asked,
        set => set,
    }
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
pub fn decode_embedded_frame(raw_path: &str, long_edge: u32) -> Option<frame::Frame> {
    let image = guard("decode_embedded_frame", None, || {
        decode_rawler::upright_preview_rgb(
            raw_path,
            long_edge as usize,
            decode_rawler::Preview::SmallestCovering(long_edge as usize),
        )
    })?;
    Some(frame::Frame::new(
        image.width,
        image.height,
        frame::Pixels::Eight(image.data),
    ))
}

/// The camera match for the HDR grade, in the domain the grade works in (10.8.1): both
/// halves run off this decode in a single pass over it.
#[cfg(feature = "renditions")]
pub fn fit_hdr_for(
    frame: &resident::Resident,
    raw_path: &str,
    quantile: f64,
) -> Option<hdr_fit::HdrMatch> {
    fit_hdr_measured(frame, raw_path, quantile, hdr_fit::CameraMatch::LensAndColour).map(|(matched, _)| matched)
}

/// `fit_hdr_for`, with the levels the match was fitted against - which `open::measure` would
/// otherwise read off the frame a second time.
#[cfg(feature = "renditions")]
pub fn fit_hdr_measured(
    frame: &resident::Resident,
    raw_path: &str,
    quantile: f64,
    camera_match: hdr_fit::CameraMatch,
) -> Option<(hdr_fit::HdrMatch, tone::Levels)> {
    let gpu = gpu::device()?;
    guard("fit_hdr_for", None, || {
        let geometry = ffi::geometry_for(raw_path)?;
        pollster::block_on(hdr::fit_all(gpu, raw_path, frame, quantile, geometry, camera_match))
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
    source: rgb::RgbRef<'_>,
    quantizer: i32,
    effort: i32,
    full_chroma: bool,
    out_path: &str,
    rotate: u16,
) -> Result<(), String> {
    // libvips counted effort up from 0 as *fastest*; libavif counts speed down from
    // 10 as fastest. Same knob, opposite ends.
    let speed = (10 - effort).clamp(0, 10);
    avif::encode_rendition_rotated(
        source.data.into(),
        source.width,
        source.height,
        quantizer,
        speed,
        full_chroma,
        out_path,
        rotate,
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
/// rendered format has none, and the caller renders (`decode_rendered`).
#[cfg(feature = "renditions")]
fn with_embedded_jpeg<T>(path: &str, use_bytes: impl FnOnce(&[u8]) -> T) -> Option<T> {
    if decode_rendered::is_rendered(path) {
        let bytes = std::fs::read(path).ok()?;
        return bytes.starts_with(&[0xFF, 0xD8]).then(|| use_bytes(&bytes));
    }
    decode_rawler::upright_preview_jpeg(path, decode_rawler::Preview::Largest)
        .map(|jpeg| use_bytes(&jpeg))
}

/// The camera's embedded preview as RGB, bounded by `long_edge`, for callers on this
/// side of the boundary. None when the file embeds no JPEG preview.
///
/// The body's own full-size rendering: every caller here is measuring against what the camera
/// produced rather than looking for cheap pixels, which is the distinction `Preview` draws.
#[cfg(feature = "renditions")]
pub fn decode_embedded_rgb(path: &str, long_edge: usize) -> Option<rgb::Rgb> {
    decode_rawler::upright_preview_rgb(path, long_edge, decode_rawler::Preview::Largest)
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

/// How far the job counting itself right now has got: steps done in the high word, steps in the
/// pass in the low one, and zero where none is counting.
///
/// Read from a thread other than the one inside `bb_run_job`, which is the whole point: a merge or
/// an export is minutes of work behind one blocking call, and this is what the caller shows a
/// reader meanwhile.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub extern "C" fn bb_job_progress() -> u64 {
    progress::packed()
}

/// Tells whatever job is running to stop at the next boundary it counts itself at.
///
/// A control signal about a job already running rather than a second way to start one, so it
/// follows `bb_job_progress`'s shape: a flag beside the counter, set from the caller's thread and
/// read by the library's. Seen only by the job counting its steps, and cleared as
/// that job starts.
#[expect(unsafe_code)]
#[cfg(feature = "renditions")]
#[unsafe(no_mangle)]
pub extern "C" fn bb_cancel_job() {
    progress::cancel();
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
            if let Some(fitted) = fit_hdr_for(&resident, &path, 0.995) {
                let colour = fitted.colour.as_ref().expect("a colour fit");
                let numbers = colour.curves.iter().map(Vec::len).sum::<usize>()
                    + 9
                    + colour.chroma.as_ref().map_or(0, |map| map.nodes_flat().len())
                    + fitted.lens.distortion.as_ref().map_or(0, Vec::len)
                    + fitted.lens.tca.as_ref().map_or(0, |pair| pair[0].len() + pair[1].len())
                    + 3;
                let blob = photo_analysis::encode(&photo_analysis::PhotoAnalysis {
                    from_raw: photo_analysis::FromRaw {
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
            view::View::whole(px::Size::exact(whole.width, whole.height))
                .showing(px::Rect::exact(2000, 1400, side, side))
        };
        let sliders = galosh::Detail::at(40.0, 40.0);
        decode_tile(&path, seeing(400), sliders, galosh::Fit::Measure, RENDITION_TILE_HALO);
        for side in [400usize, 700] {
            let started = std::time::Instant::now();
            let tile =
                decode_tile(&path, seeing(side), sliders, galosh::Fit::Measure, RENDITION_TILE_HALO);
            let took = started.elapsed().as_millis();
            let frame = tile.expect("the tile decodes");
            println!(
                "  whole tile, {side}px        {took:>5}ms  {}x{}",
                frame.width, frame.height,
            );
            assert!(frame.width <= side + 8 && frame.height <= side + 8, "the crop is the tile");
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
