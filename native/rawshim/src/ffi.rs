// The C surface TypeScript calls.
//
// Coarse on purpose, in two directions. One call per job rather than one per
// operation, because the fit evaluates tens of candidates internally and exposing
// its pieces would put the boundary back inside the loop this module exists to
// close. And handles rather than pixels: every call here takes a `BbImage` the
// library still owns and, where it produces an image, hands back another one. JS
// passes a path in and gets a path or a handle out; the samples stay on this side.

use crate::fit::{self, Profile};
use crate::hdr_args;
use crate::vips::{self, Pipeline};
use crate::BbImage;
use std::ffi::{c_char, CStr};

/// A byte buffer handed to TypeScript. It owns the allocation; `bb_buffer_free`
/// returns it. Only for the encoders, whose output really is bytes JS wants.
#[repr(C)]
pub struct BbBuffer {
    pub data: *mut u8,
    pub len: usize,
    capacity: usize,
}

impl BbBuffer {
    fn from_vec(bytes: Vec<u8>) -> *mut BbBuffer {
        let mut bytes = std::mem::ManuallyDrop::new(bytes);
        Box::into_raw(Box::new(BbBuffer {
            data: bytes.as_mut_ptr(),
            len: bytes.len(),
            capacity: bytes.capacity(),
        }))
    }
}

/// A fitted profile, flattened so TypeScript can read it with one DataView and
/// hand it straight back to `bb_render` without reconstructing anything.
#[repr(C)]
pub struct BbProfile {
    pub has_distortion: u32,
    /// 0 none, 1 the camera's own spline, 2 fitted.
    pub source: u32,
    pub crop: f64,
    pub delta_e: f64,
    pub knot_count: u32,
    pub knots: [f64; 64],
    pub curves: [u8; 768],
    pub matrix: [f64; 9],
}

impl BbProfile {
    fn from(profile: &Profile) -> BbProfile {
        let mut out = BbProfile {
            has_distortion: u32::from(profile.knots.is_some()),
            source: profile.source,
            crop: profile.crop,
            delta_e: profile.delta_e,
            knot_count: 0,
            knots: [0.0; 64],
            curves: [0; 768],
            matrix: [0.0; 9],
        };
        if let Some(knots) = &profile.knots {
            let n = knots.len().min(64);
            out.knot_count = n as u32;
            out.knots[..n].copy_from_slice(&knots[..n]);
        }
        for channel in 0..3 {
            out.curves[channel * 256..(channel + 1) * 256].copy_from_slice(&profile.colour.curves[channel]);
        }
        for row in 0..3 {
            out.matrix[row * 3..row * 3 + 3].copy_from_slice(&profile.colour.matrix[row]);
        }
        out
    }

    fn to_profile(&self) -> Profile {
        let mut curves = [[0u8; 256]; 3];
        for channel in 0..3 {
            curves[channel].copy_from_slice(&self.curves[channel * 256..(channel + 1) * 256]);
        }
        let mut matrix = [[0.0f64; 3]; 3];
        for row in 0..3 {
            matrix[row].copy_from_slice(&self.matrix[row * 3..row * 3 + 3]);
        }
        Profile {
            knots: if self.has_distortion == 1 {
                Some(self.knots[..self.knot_count as usize].to_vec())
            } else {
                None
            },
            crop: self.crop,
            source: self.source,
            delta_e: self.delta_e,
            colour: fit::ColourTransform { curves, matrix },
        }
    }
}

/// Whether a longest-edge target would actually shrink this image.
///
/// A resize that is not one still costs a full pass through libvips and a
/// materialised copy of the result, which on a native-resolution rendition is the
/// whole 60MP frame moved for nothing.
fn shrinks(image: &vips::RgbRef<'_>, long_edge: u32) -> bool {
    long_edge > 0 && image.width.max(image.height) > long_edge as usize
}

/// Decodes an encoded image off disk, applying its EXIF orientation and optionally
/// fitting it to a longest edge. `long_edge` of 0 leaves the size alone.
///
/// A path rather than bytes, so a rendition being transcoded is not read into
/// JavaScript only to be handed straight back.
///
/// # Safety
/// `path` must be a NUL-terminated C string. Release with `bb_free`.
#[no_mangle]
pub unsafe extern "C" fn bb_decode_file(path: *const c_char, long_edge: u32) -> *mut BbImage {
    vips::init();
    if path.is_null() {
        return std::ptr::null_mut();
    }
    let Ok(path) = CStr::from_ptr(path).to_str() else { return std::ptr::null_mut() };
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("bb_decode_file: {path}: {e}");
            return std::ptr::null_mut();
        }
    };
    decode_encoded(&bytes, long_edge)
}

/// Decodes an encoded image, applies its EXIF orientation, and optionally fits it
/// to a longest edge. `long_edge` of 0 leaves the size alone.
///
/// # Safety
/// `bytes` must be valid for `len`. The result must be released with `bb_free`.
#[no_mangle]
pub unsafe extern "C" fn bb_decode_image(bytes: *const u8, len: usize, long_edge: u32) -> *mut BbImage {
    vips::init();
    if bytes.is_null() {
        return std::ptr::null_mut();
    }
    decode_encoded(std::slice::from_raw_parts(bytes, len), long_edge)
}

fn decode_encoded(encoded: &[u8], long_edge: u32) -> *mut BbImage {
    // Both `bb_decode_file` and `bb_decode_image` funnel through here, so one guard
    // keeps a malformed file from taking the process down rather than the call.
    crate::guard("bb_decode_image", std::ptr::null_mut(), || {
        // Shrinking during the decode rather than after it, where a size was asked for.
        let decoded = match long_edge {
            0 => Pipeline::decode_upright(encoded).and_then(Pipeline::finish),
            edge => Pipeline::thumbnail(encoded, edge as usize).and_then(Pipeline::finish),
        };
        match decoded {
            Ok(image) => BbImage::own(image),
            Err(e) => {
                eprintln!("bb_decode_image: {e}");
                std::ptr::null_mut()
            }
        }
    })
}

/// The HDR encode's settings, flat so TypeScript can fill it with one DataView.
#[repr(C)]
pub struct BbHdrOptions {
    /// 0 still, 1 video.
    pub medium: u32,
    pub peak_nits: f64,
    pub reference_white_nits: f64,
    pub white_quantile: f64,
    pub crf: i32,
    pub preset: i32,
    /// Non-finite means no limit, which is how a native-resolution export asks.
    pub max_edge: f64,
}

impl BbHdrOptions {
    unsafe fn to_options(&self, output_path: &str) -> Option<hdr_args::EncodeOptions> {
        Some(hdr_args::EncodeOptions {
            medium: match self.medium {
                0 => hdr_args::Medium::Still,
                1 => hdr_args::Medium::Video,
                _ => return None,
            },
            output_path: output_path.to_string(),
            peak_nits: self.peak_nits,
            reference_white_nits: self.reference_white_nits,
            white_quantile: self.white_quantile,
            crf: self.crf,
            preset: self.preset,
            max_edge: if self.max_edge.is_finite() { self.max_edge } else { f64::INFINITY },
        })
    }
}

/// Size of `BbHdrOptions`, checked by the caller against the layout it writes.
#[no_mangle]
pub extern "C" fn bb_hdr_options_size() -> usize {
    std::mem::size_of::<BbHdrOptions>()
}

/// The argv this would hand to ffmpeg or avifenc, NUL-separated.
///
/// Exposed only so the pin that captured the TypeScript's output can be held
/// against this (`hdr_pin.integration.test.ts`). `which` is 0 for ffmpeg's
/// arguments, 1 for avifenc's, 2 for the target size as `WxH`. Nothing in the app
/// calls it; `bb_encode_hdr` builds and runs these itself.
///
/// # Safety
/// `options` must be a readable `BbHdrOptions`, the paths NUL-terminated C strings.
/// Release with `bb_buffer_free`.
#[no_mangle]
pub unsafe extern "C" fn bb_hdr_argv(
    options: *const BbHdrOptions,
    width: u32,
    height: u32,
    output_path: *const c_char,
    y4m_path: *const c_char,
    which: u32,
) -> *mut BbBuffer {
    if options.is_null() || output_path.is_null() || y4m_path.is_null() {
        return std::ptr::null_mut();
    }
    let (Ok(out), Ok(y4m)) = (CStr::from_ptr(output_path).to_str(), CStr::from_ptr(y4m_path).to_str()) else {
        return std::ptr::null_mut();
    };
    let Some(built) = (*options).to_options(out) else { return std::ptr::null_mut() };

    let parts = match which {
        0 => hdr_args::ffmpeg_args(width, height, &built),
        1 => hdr_args::avifenc_args(&built, y4m),
        2 => {
            let size = hdr_args::target_size(width, height, &built);
            vec![format!("{}x{}", size.width, size.height)]
        }
        _ => return std::ptr::null_mut(),
    };
    BbBuffer::from_vec(parts.join("\0").into_bytes())
}

/// A fitted HDR match, owned by this library for as long as JS holds the pointer.
///
/// Opaque, and separate from the encode on purpose. Fitting it costs ~0.9s on a 61MP
/// frame and every rendition of one photo must use the *same* one anyway, so a still
/// and its video twin share it. Folding the fit into the encode - which is how this
/// was first ported - paid for it once per rendition instead of once per photo.
pub struct BbHdrMatch {
    inner: crate::hdr_fit::HdrMatch,
}

/// Fits the camera's colour for the HDR grade, reusing the geometry the SDR fit
/// resolved.
///
/// Null when the file embeds no preview, when the fit found too few usable pairs, or
/// when `profile` is null - in each case the caller grades neutrally, which is also
/// what the HDR check page wants: it exists to judge the tone mapping, and the
/// camera's colour on top would be one more variable.
///
/// # Safety
/// `image` must be a live 16-bit handle, `raw_path` a NUL-terminated C string.
/// Release with `bb_hdr_match_free`.
#[no_mangle]
pub unsafe extern "C" fn bb_fit_hdr_match(
    image: *const BbImage,
    raw_path: *const c_char,
    options: *const BbHdrOptions,
    profile: *const BbProfile,
) -> *mut BbHdrMatch {
    vips::init();
    if image.is_null() || raw_path.is_null() || options.is_null() || profile.is_null() {
        return std::ptr::null_mut();
    }
    let (Ok(raw), Some(built), Some(samples)) = (
        CStr::from_ptr(raw_path).to_str(),
        (*options).to_options(""),
        (*image).view_u16(),
    ) else {
        return std::ptr::null_mut();
    };
    let source = crate::hdr::Source {
        samples,
        width: (*image).width as usize,
        height: (*image).height as usize,
    };

    // The SDR profile's colour cannot be reused - its curves are 8-bit sRGB and stop
    // at display white, where this grade needs a domain it can carry past diffuse
    // white. The geometry is a property of the lens, so that half is reused, and it is
    // the expensive half.
    let sdr = (*profile).to_profile();
    let fitted = crate::guard("bb_fit_hdr_match", None, || {
        crate::hdr::fit_match(raw, &source, built.white_quantile, sdr.knots, sdr.crop)
    });
    match fitted {
        Some(inner) => Box::into_raw(Box::new(BbHdrMatch { inner })),
        None => std::ptr::null_mut(),
    }
}

/// Releases a match from `bb_fit_hdr_match`. Safe with null.
///
/// # Safety
/// `matched` must have come from this module and not been freed already.
#[no_mangle]
pub unsafe extern "C" fn bb_hdr_match_free(matched: *mut BbHdrMatch) {
    if !matched.is_null() {
        drop(Box::from_raw(matched));
    }
}

/// The fitted HDR colour transform, flattened for inspection.
#[repr(C)]
pub struct BbHdrColour {
    /// Held-out mean deltaE76 over the fit pairs.
    pub delta_e: f64,
    /// The chroma blend applied after the matrix; 1 leaves it alone.
    pub saturation: f64,
    /// Row-major, output channel by input channel.
    pub matrix: [f64; 9],
    /// Three 256-entry curves, spanning render values 0 to TRUST_CEILING.
    pub curves: [f64; 768],
}

/// Size of `BbHdrColour`, checked by the caller against the layout it reads.
#[no_mangle]
pub extern "C" fn bb_hdr_colour_size() -> usize {
    std::mem::size_of::<BbHdrColour>()
}

/// The fitted transform, flattened for inspection.
///
/// The grade uses the handle directly; this is here so the tests that judge the fit
/// against a real file can reach it - a monotone curve, three channels leaving the fit
/// domain together, a deltaE inside the bound. None of that is visible from a
/// synthetic input, and none of it would fail an assertion about shape.
///
/// # Safety
/// `matched` must be a live handle and `out` a writable `BbHdrColour`.
#[no_mangle]
pub unsafe extern "C" fn bb_hdr_match_colour(matched: *const BbHdrMatch, out: *mut BbHdrColour) -> i32 {
    if matched.is_null() || out.is_null() {
        return -1;
    }
    let colour = &(*matched).inner.colour;
    let mut flat = BbHdrColour {
        delta_e: colour.delta_e,
        saturation: colour.saturation,
        matrix: [0.0; 9],
        curves: [0.0; 768],
    };
    for row in 0..3 {
        flat.matrix[row * 3..row * 3 + 3].copy_from_slice(&colour.matrix[row]);
    }
    for channel in 0..3 {
        let curve = &colour.curves[channel];
        flat.curves[channel * 256..channel * 256 + curve.len()].copy_from_slice(curve);
    }
    *out = flat;
    0
}

/// The decode and settings both encode entry points need.
unsafe fn hdr_source<'a>(
    image: *const BbImage,
    options: *const BbHdrOptions,
    output_path: &str,
) -> Option<(crate::hdr::Source<'a>, hdr_args::EncodeOptions)> {
    if image.is_null() || options.is_null() {
        return None;
    }
    let built = (*options).to_options(output_path)?;
    let samples = (*image).view_u16()?;
    Some((
        crate::hdr::Source { samples, width: (*image).width as usize, height: (*image).height as usize },
        built,
    ))
}

/// Builds one HDR rendition, and its one-frame video twin where `video_output_path`
/// names one, from a scene-linear decode to the files on disk.
///
/// The fit to size, the warp, the grade, and ffmpeg - with avifenc after it for a
/// still. None of the samples cross the boundary, which is the reason for the shape:
/// the graded frame is ~115MB at 24MP and ~366MB at 61MP.
///
/// The twin is named here rather than encoded by a second call because the two share
/// the grade outright - same resize, same warp, same tone map, and since the video
/// moved off SVT-AV1 there is no encoder row ceiling to make them different sizes
/// either. An empty string asks for no twin.
///
/// `image` must be a 16-bit `rec2020-linear` decode, and `matched` a match from
/// `bb_fit_hdr_match` or null for a neutral grade. Both are passed rather than derived
/// here so a still and its video twin share one decode and one fit.
///
/// 0 on success, -1 on failure.
///
/// # Safety
/// `image` must be a live handle, `output_path` and `video_output_path` NUL-terminated
/// C strings, `options` readable, `matched` null or a live handle.
#[no_mangle]
pub unsafe extern "C" fn bb_encode_hdr(
    image: *const BbImage,
    matched: *const BbHdrMatch,
    output_path: *const c_char,
    options: *const BbHdrOptions,
    video_output_path: *const c_char,
) -> i32 {
    vips::init();
    if output_path.is_null() || video_output_path.is_null() {
        return -1;
    }
    let (Ok(out), Ok(video)) =
        (CStr::from_ptr(output_path).to_str(), CStr::from_ptr(video_output_path).to_str())
    else {
        return -1;
    };
    let Some((source, built)) = hdr_source(image, options, out) else { return -1 };
    let matched = matched.as_ref().map(|m| &m.inner);

    let encoded = crate::guard("bb_encode_hdr", Err("panicked".to_string()), || {
        crate::hdr::encode_pair(&source, &built, (!video.is_empty()).then_some(video), matched)
    });
    match encoded {
        Ok(()) => 0,
        Err(detail) => {
            eprintln!("bb_encode_hdr: {detail}");
            -1
        }
    }
}

/// The graded 16-bit samples `bb_encode_hdr` would hand to ffmpeg.
///
/// Exposed only so the pin captured from the TypeScript this replaced can be held
/// against it (`hdr_pin.integration.test.ts`). It copies the whole graded frame -
/// ~115MB at 24MP - which is exactly what the production path exists to avoid, so
/// nothing in the app calls it.
///
/// `out_size` receives the width and height, since a fit-to-edge changes both.
///
/// # Safety
/// As `bb_encode_hdr`, with `out_size` valid for two u32s. Release with
/// `bb_buffer_free`.
#[no_mangle]
pub unsafe extern "C" fn bb_hdr_graded(
    image: *const BbImage,
    matched: *const BbHdrMatch,
    options: *const BbHdrOptions,
    out_size: *mut u32,
) -> *mut BbBuffer {
    vips::init();
    if out_size.is_null() {
        return std::ptr::null_mut();
    }
    let Some((source, built)) = hdr_source(image, options, "") else { return std::ptr::null_mut() };
    let matched = matched.as_ref().map(|m| &m.inner);

    let (graded, width, height) = crate::hdr::graded(&source, &built, matched);
    *out_size = width as u32;
    *out_size.add(1) = height as u32;
    let bytes =
        std::slice::from_raw_parts(graded.as_ptr() as *const u8, std::mem::size_of_val(&graded[..])).to_vec();
    BbBuffer::from_vec(bytes)
}

/// The camera's embedded JPEG preview, as bytes.
///
/// The one call here that hands pixels over on purpose: its caller serves them to
/// an HTTP response unchanged, so they are bytes bound for a socket rather than
/// input to another image operation. Anything that goes on to decode the preview
/// wants `bb_decode_embedded`, which keeps it on this side.
///
/// Null when the file has no JPEG preview, which is not an error.
///
/// # Safety
/// `path` must be a NUL-terminated C string. Release with `bb_buffer_free`.
#[no_mangle]
pub unsafe extern "C" fn bb_extract_embedded(path: *const c_char) -> *mut BbBuffer {
    if path.is_null() {
        return std::ptr::null_mut();
    }
    match crate::with_embedded_jpeg(path, <[u8]>::to_vec) {
        Some(bytes) => BbBuffer::from_vec(bytes),
        None => std::ptr::null_mut(),
    }
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

/// Reads the distortion spline a body recorded for this shot, in SPLINE_UNITs.
///
/// Returns the knot count written to `out`, 0 when the file records none, or -1 if
/// the file could not be read. `bb_fit` does this itself; this is exposed so a test
/// can check the parser against a real ARW rather than only the synthetic TIFFs in
/// `lens.rs`, which cannot catch a wrong assumption about how Sony nests it.
///
/// # Safety
/// `path` must be a NUL-terminated C string and `out` valid for `max` f64s.
#[no_mangle]
pub unsafe extern "C" fn bb_read_distortion_spline(path: *const c_char, out: *mut f64, max: u32) -> i32 {
    if path.is_null() || out.is_null() {
        return -1;
    }
    let Ok(path) = CStr::from_ptr(path).to_str() else { return -1 };
    let Ok(found) = distortion_of(path) else { return -1 };

    match found.spline {
        None => 0,
        Some(knots) => {
            let n = knots.len().min(max as usize);
            std::ptr::copy_nonoverlapping(knots.as_ptr(), out, n);
            n as i32
        }
    }
}

/// The lensfun correction for a lens, in SPLINE_UNITs, resolved from the strings a
/// RAW carries.
///
/// Returns the knot count written to `out`, 0 when no plausible lens matches or the
/// match carries no distortion data, or -1 on a bad argument. `bb_fit` does this
/// itself; this is exposed for the test that holds the resolution and the sampled
/// geometry against the database, which nothing on the fit's own path would notice
/// going wrong - a silently absent profile just costs a slower fit.
///
/// # Safety
/// The three strings must be NUL-terminated, and `out` valid for `max` f64s.
#[no_mangle]
pub unsafe extern "C" fn bb_lensfun_knots(
    make: *const c_char,
    model: *const c_char,
    lens: *const c_char,
    focal: f32,
    aperture: f32,
    width: u32,
    height: u32,
    out: *mut f64,
    max: u32,
) -> i32 {
    if make.is_null() || model.is_null() || lens.is_null() || out.is_null() {
        return -1;
    }
    let (Ok(make), Ok(model), Ok(lens)) = (
        CStr::from_ptr(make).to_str(),
        CStr::from_ptr(model).to_str(),
        CStr::from_ptr(lens).to_str(),
    ) else {
        return -1;
    };

    let Some(knots) = crate::lensfun::knots(make, model, lens, focal, aperture, width as usize, height as usize)
    else {
        return 0;
    };
    let n = knots.len().min(max as usize);
    std::ptr::copy_nonoverlapping(knots.as_ptr(), out, n);
    n as i32
}

/// Takes a copy of an 8-bit RGB buffer JS already holds.
///
/// The one place a picture legitimately travels the other way. Everything in the
/// app decodes on this side, so the only callers are tests, which construct a
/// target and need it in the same form a decode would have produced.
///
/// # Safety
/// `data` must be valid for `width * height * 3` bytes. The result must be
/// released with `bb_free`.
#[no_mangle]
pub unsafe extern "C" fn bb_image_from_rgb(data: *const u8, width: u32, height: u32) -> *mut BbImage {
    vips::init();
    let len = width as usize * height as usize * 3;
    if data.is_null() || len == 0 {
        return std::ptr::null_mut();
    }
    BbImage::own(vips::Rgb {
        width: width as usize,
        height: height as usize,
        data: std::slice::from_raw_parts(data, len).to_vec(),
    })
}

/// Fits the transform taking a render to the camera's own JPEG, given the RAW.
///
/// Everything it needs comes off the path: the embedded preview to match against,
/// and the distortion spline the body recorded. Neither crosses the boundary -
/// the preview is 5-14MB on a 61MP body, and reading the spline in TypeScript
/// meant handing it the whole 60-120MB file to find one tag near the front.
///
/// Returns 1 when there is no usable match, which is not an error: the caller
/// renders untransformed rather than shipping a bad grade. 0 on success, -1 on
/// failure - including a file with no JPEG preview, which leaves nothing to fit
/// against.
///
/// # Safety
/// `image` must be a live handle from this library, `raw_path` a NUL-terminated C
/// string, and `out` a writable `BbProfile`.
#[no_mangle]
pub unsafe extern "C" fn bb_fit(image: *const BbImage, raw_path: *const c_char, out: *mut BbProfile) -> i32 {
    vips::init();
    if image.is_null() || raw_path.is_null() || out.is_null() {
        return -1;
    }
    let Ok(path) = CStr::from_ptr(raw_path).to_str() else { return -1 };
    let Some(geometry) = geometry_for(path) else { return -1 };
    let Some(render) = (*image).view() else { return -1 };

    let fitted = crate::with_embedded_jpeg(raw_path, |jpeg| fit_against(render, jpeg, geometry, out));
    // No JPEG preview: nothing to match, and the caller renders untransformed.
    fitted.unwrap_or(-1)
}

/// Which geometry tier this file falls into, from the file alone - no pixels decoded.
///
/// None is a file that could not be read, which the callers report separately from a
/// file that simply records no correction.
fn geometry_for(path: &str) -> Option<fit::Geometry> {
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

/// The whole camera match for an HDR rendition, off the scene-linear decode alone.
///
/// Where nothing in the job renders SDR there is no 8-bit render to take geometry from
/// and no reason to make one, so the geometry search and the colour fit both run off
/// this decode - and off one pass over it, since they want the same downscale, the same
/// preview and the same levels. `out` receives the geometry the search settled on, for
/// reporting and for the test that holds it against the 8-bit path.
///
/// Null when there is no usable match, which is not an error: the caller grades
/// neutrally. Release the result with `bb_hdr_match_free`.
///
/// # Safety
/// `image` must be a live 16-bit handle, `raw_path` a NUL-terminated C string,
/// `options` readable, and `out` a writable `BbProfile`.
#[no_mangle]
pub unsafe extern "C" fn bb_fit_hdr(
    image: *const BbImage,
    raw_path: *const c_char,
    options: *const BbHdrOptions,
    out: *mut BbProfile,
) -> *mut BbHdrMatch {
    vips::init();
    if image.is_null() || raw_path.is_null() || options.is_null() || out.is_null() {
        return std::ptr::null_mut();
    }
    let (Ok(path), Some(built), Some(samples)) = (
        CStr::from_ptr(raw_path).to_str(),
        (*options).to_options(""),
        (*image).view_u16(),
    ) else {
        return std::ptr::null_mut();
    };
    let Some(geometry) = geometry_for(path) else { return std::ptr::null_mut() };

    let source = crate::hdr::Source {
        samples,
        width: (*image).width as usize,
        height: (*image).height as usize,
    };
    let fitted = crate::guard("bb_fit_hdr", None, || {
        crate::hdr::fit_all(path, &source, built.white_quantile, geometry)
    });
    match fitted {
        Some((profile, inner)) => {
            *out = BbProfile::from(&profile);
            Box::into_raw(Box::new(BbHdrMatch { inner }))
        }
        None => std::ptr::null_mut(),
    }
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

/// The fit itself, once its inputs are in hand.
///
/// Takes the render borrowed rather than as a handle, so the HDR path - which derives
/// one from its scene-linear decode instead of demosaicing a second time in 8-bit -
/// reaches the same search by the same door.
unsafe fn fit_against(
    render: vips::RgbRef<'_>,
    jpeg: &[u8],
    geometry: fit::Geometry,
    out: *mut BbProfile,
) -> i32 {
    // The search warps, blurs, pairs and solves over tens of candidates; a panic in any
    // of that would otherwise leave the library by way of `bb_fit` and take the process
    // with it. Both entry points funnel through here, so one guard covers them.
    let fitted = crate::guard("bb_fit", Err("panicked".to_string()), || fit::fit(render, jpeg, geometry));
    match fitted {
        Ok(Some(profile)) => {
            *out = BbProfile::from(&profile);
            0
        }
        Ok(None) => 1,
        Err(_) => -1,
    }
}

/// `bb_fit` against a caller-supplied target rather than the file's own preview.
///
/// Exists for the test that injects a known distortion into a JPEG and requires
/// the fit to recover it - the check this whole module is kept honest by, since a
/// radial model and a radial error will always find each other and a null result
/// looks identical to no sensitivity. Nothing in the app calls it.
///
/// # Safety
/// As `bb_fit`, with `jpeg` valid for `jpeg_len`.
#[no_mangle]
pub unsafe extern "C" fn bb_fit_against(
    image: *const BbImage,
    jpeg: *const u8,
    jpeg_len: usize,
    camera_knots: *const f64,
    camera_knot_count: u32,
    out: *mut BbProfile,
) -> i32 {
    vips::init();
    if image.is_null() || jpeg.is_null() || out.is_null() {
        return -1;
    }
    let geometry = match camera_knots.is_null() || camera_knot_count == 0 {
        true => fit::Geometry::Unstated,
        false => fit::Geometry::Recorded(std::slice::from_raw_parts(camera_knots, camera_knot_count as usize).to_vec()),
    };
    let Some(render) = (*image).view() else { return -1 };
    fit_against(render, std::slice::from_raw_parts(jpeg, jpeg_len), geometry, out)
}

/// Fits an image to a longest edge and applies a profile, in that order.
///
/// Either half is optional: a null profile is a plain resize, and a `long_edge`
/// of 0 (or one the image already fits inside) grades at the size it arrived at.
/// One call rather than two because the pair is what a rendition wants, and
/// splitting them would materialise the intermediate.
///
/// The order is load-bearing but free either way: the distortion model is in
/// radii normalised to the half-diagonal and the colour transform is a per-pixel
/// lookup, so neither depends on resolution - and grading the smaller image is
/// the cheaper of the two.
///
/// # Safety
/// `image` must be a live handle from this library. The result must be released
/// with `bb_free`.
#[no_mangle]
pub unsafe extern "C" fn bb_render(image: *const BbImage, profile: *const BbProfile, long_edge: u32) -> *mut BbImage {
    vips::init();
    if image.is_null() {
        return std::ptr::null_mut();
    }
    let Some(source) = (*image).view() else { return std::ptr::null_mut() };
    crate::guard("bb_render", std::ptr::null_mut(), || render(source, profile, long_edge))
}

/// The warp and the resize, where a panic would otherwise reach the FFI boundary.
unsafe fn render(source: vips::RgbRef<'_>, profile: *const BbProfile, long_edge: u32) -> *mut BbImage {
    if !shrinks(&source, long_edge) {
        return match profile.is_null() {
            true => BbImage::own(vips::Rgb { width: source.width, height: source.height, data: source.data.to_vec() }),
            false => BbImage::own(fit::apply(source, &(*profile).to_profile())),
        };
    }

    let resized = match Pipeline::from_rgb(source)
        .and_then(|pipeline| pipeline.resize_to_fit(long_edge as usize))
        .and_then(Pipeline::finish)
    {
        Ok(resized) => resized,
        Err(_) => return std::ptr::null_mut(),
    };
    match profile.is_null() {
        true => BbImage::own(resized),
        false => BbImage::own(fit::apply(resized.as_ref(), &(*profile).to_profile())),
    }
}

/// Writes an AVIF, 4:4:4, fitting to `long_edge` on the way. 0 writes as is.
///
/// # Safety
/// `image` must be a live handle from this library and `path` a NUL-terminated C
/// string.
#[no_mangle]
pub unsafe extern "C" fn bb_save_avif(
    image: *const BbImage,
    long_edge: u32,
    quantizer: i32,
    effort: i32,
    path: *const c_char,
) -> i32 {
    vips::init();
    if image.is_null() || path.is_null() {
        return -1;
    }
    let (Some(source), Ok(path)) = ((*image).view(), CStr::from_ptr(path).to_str()) else { return -1 };
    crate::guard("bb_save_avif", -1, || {
        // libvips counted effort up from 0 as *fastest*; libavif counts speed down from
        // 10 as fastest. Same knob, opposite ends.
        let speed = (10 - effort).clamp(0, 10);

        // Encoded where it lies when there is no resize to do, which is the common case
        // and not a rare one: the worker builds its base at the largest size the job
        // asks for and then encodes that target from it, so the biggest rendition of
        // every photo arrives here already the right size. Going through the pipeline
        // regardless meant `finish` materialising a whole second copy of the frame to
        // hand libavif pixels it could have read in place.
        if long_edge == 0 || source.width.max(source.height) <= long_edge as usize {
            return match crate::avif::encode_rendition(
                source.data, source.width, source.height, quantizer, speed, path,
            ) {
                Ok(()) => 0,
                Err(detail) => {
                    eprintln!("bb_save_avif: {detail}");
                    -1
                }
            };
        }

        // libvips still does the resize - it is the lazy pipeline's whole point - but
        // the encode goes to libavif rather than out through libheif. Same codec at the
        // end of both, and measured at matched quality it is 307ms to 275ms at Q80 and
        // 370ms to 302ms at Q88, with libheif and its plugin-priority trap gone from
        // the chain.
        let resized = match Pipeline::from_rgb(source)
            .and_then(|pipeline| pipeline.resize_to_fit(long_edge as usize))
            .and_then(Pipeline::finish)
        {
            Ok(image) => image,
            Err(_) => return -1,
        };
        let written = crate::avif::encode_rendition(
            &resized.data,
            resized.width,
            resized.height,
            quantizer,
            speed,
            path,
        );
        match written {
            Ok(()) => 0,
            Err(detail) => {
                eprintln!("bb_save_avif: {detail}");
                -1
            }
        }
    })
}


/// Encodes a JPEG into a buffer, fitting to `long_edge` on the way. 0 encodes as is.
///
/// # Safety
/// `image` must be a live handle from this library. The result must be released
/// with `bb_buffer_free`.
#[no_mangle]
pub unsafe extern "C" fn bb_encode_jpeg(image: *const BbImage, long_edge: u32, quality: i32) -> *mut BbBuffer {
    vips::init();
    if image.is_null() {
        return std::ptr::null_mut();
    }
    let Some(source) = (*image).view() else { return std::ptr::null_mut() };
    crate::guard("bb_encode_jpeg", std::ptr::null_mut(), || {
        let encoded = Pipeline::from_rgb(source)
            .and_then(|pipeline| pipeline.resize_to_fit(long_edge as usize))
            .and_then(|pipeline| pipeline.encode_jpeg(quality));
        match encoded {
            Ok(bytes) => BbBuffer::from_vec(bytes),
            Err(_) => std::ptr::null_mut(),
        }
    })
}

/// Releases a buffer from any of the calls above. Safe with null.
///
/// # Safety
/// `buffer` must have come from this module and not been freed already.
#[no_mangle]
pub unsafe extern "C" fn bb_buffer_free(buffer: *mut BbBuffer) {
    if buffer.is_null() {
        return;
    }
    let buffer = Box::from_raw(buffer);
    drop(Vec::from_raw_parts(buffer.data, buffer.len, buffer.capacity));
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

/// Size of `BbProfile`, so the caller can allocate it without hardcoding a layout
/// that changes when a field is added.
#[no_mangle]
pub extern "C" fn bb_profile_size() -> usize {
    std::mem::size_of::<BbProfile>()
}

/// Size of `BbBuffer`, which the caller checks against the layout it reads.
///
/// The reader needs the offsets of `data` and `len`, and a size alone cannot give
/// it those - but adding a field changes the size, so comparing it turns what
/// would be a silent misread of every buffer into an immediate, explained failure.
#[no_mangle]
pub extern "C" fn bb_buffer_header_size() -> usize {
    std::mem::size_of::<BbBuffer>()
}

/// Size of `BbImage`, checked by the caller for the same reason as `BbBuffer`.
#[no_mangle]
pub extern "C" fn bb_image_header_size() -> usize {
    std::mem::size_of::<BbImage>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_selftest_passes_on_the_machine_that_built_it() {
        // If this can fail here it is worthless as a gate on a tuned build.
        assert_eq!(bb_selftest(), 0);
    }

    #[test]
    fn the_layouts_the_typescript_reader_assumes_still_hold() {
        // rawshim_ops.ts reads these structs at hardcoded offsets, having no way to
        // ask for them. It checks the sizes at the first call and refuses to run on
        // a mismatch; this is the same check, but at build time.
        assert_eq!(bb_image_header_size(), 48);
        assert_eq!(bb_buffer_header_size(), 24);
        assert_eq!(bb_profile_size(), 1384);
    }
}

