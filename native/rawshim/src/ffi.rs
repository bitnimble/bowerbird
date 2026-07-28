// The C surface TypeScript calls.
//
// Coarse on purpose, in two directions. One call per job rather than one per
// operation, because the fit evaluates tens of candidates internally and exposing
// its pieces would put the boundary back inside the loop this module exists to
// close. And handles rather than pixels: every call here takes a `BbImage` the
// library still owns and, where it produces an image, hands back another one. JS
// passes a path in and gets a path or a handle out; the samples stay on this side.

use crate::fit::{self, Profile};
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
    let encoded = std::slice::from_raw_parts(bytes, len);
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
    let Ok(bytes) = std::fs::read(path) else { return -1 };

    match crate::lens::read_distortion_spline(&bytes) {
        None => 0,
        Some(knots) => {
            let n = knots.len().min(max as usize);
            std::ptr::copy_nonoverlapping(knots.as_ptr(), out, n);
            n as i32
        }
    }
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

    // The spline lives in the first few kilobytes, but its offsets are absolute, so
    // the whole file is what can be indexed safely. The decode just read it, so
    // this is a page-cache hit rather than a second trip to disk.
    let knots = match std::fs::read(path) {
        Ok(bytes) => crate::lens::read_distortion_spline(&bytes),
        Err(_) => return -1,
    };

    let fitted = crate::with_embedded_jpeg(raw_path, |jpeg| fit_against(image, jpeg, knots, out));
    // No JPEG preview: nothing to match, and the caller renders untransformed.
    fitted.unwrap_or(-1)
}

/// The fit itself, once its inputs are in hand.
unsafe fn fit_against(
    image: *const BbImage,
    jpeg: &[u8],
    camera_knots: Option<Vec<f64>>,
    out: *mut BbProfile,
) -> i32 {
    let Some(render) = (*image).view() else { return -1 };
    match fit::fit(render, jpeg, camera_knots) {
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
    let knots = match camera_knots.is_null() || camera_knot_count == 0 {
        true => None,
        false => Some(std::slice::from_raw_parts(camera_knots, camera_knot_count as usize).to_vec()),
    };
    fit_against(image, std::slice::from_raw_parts(jpeg, jpeg_len), knots, out)
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
    quality: i32,
    effort: i32,
    path: *const c_char,
) -> i32 {
    vips::init();
    if image.is_null() || path.is_null() {
        return -1;
    }
    let (Some(source), Ok(path)) = ((*image).view(), CStr::from_ptr(path).to_str()) else { return -1 };
    let written = Pipeline::from_rgb(source)
        .and_then(|pipeline| pipeline.resize_to_fit(long_edge as usize))
        .and_then(|pipeline| pipeline.save_avif(quality, effort, path));
    match written {
        Ok(()) => 0,
        Err(_) => -1,
    }
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
    let encoded = Pipeline::from_rgb(source)
        .and_then(|pipeline| pipeline.resize_to_fit(long_edge as usize))
        .and_then(|pipeline| pipeline.encode_jpeg(quality));
    match encoded {
        Ok(bytes) => BbBuffer::from_vec(bytes),
        Err(_) => std::ptr::null_mut(),
    }
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
