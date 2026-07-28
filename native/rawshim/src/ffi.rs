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
    let decoded = Pipeline::decode_upright(std::slice::from_raw_parts(bytes, len))
        .and_then(|pipeline| pipeline.resize_to_fit(long_edge as usize))
        .and_then(Pipeline::finish);
    match decoded {
        Ok(image) => BbImage::own(image),
        Err(_) => std::ptr::null_mut(),
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

/// Fits the transform taking a render to the camera's embedded JPEG.
///
/// Returns 1 when there is no usable match, which is not an error: the caller
/// renders untransformed rather than shipping a bad grade. 0 on success, -1 on
/// failure.
///
/// # Safety
/// `image` must be a live handle from this library, `jpeg` valid for `jpeg_len`,
/// and `out` a writable `BbProfile`.
#[no_mangle]
pub unsafe extern "C" fn bb_fit(
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
    let Some(render) = (*image).view() else { return -1 };
    let jpeg_bytes = std::slice::from_raw_parts(jpeg, jpeg_len);
    let knots = if camera_knots.is_null() || camera_knot_count == 0 {
        None
    } else {
        Some(std::slice::from_raw_parts(camera_knots, camera_knot_count as usize).to_vec())
    };

    match fit::fit(render, jpeg_bytes, knots) {
        Ok(Some(profile)) => {
            *out = BbProfile::from(&profile);
            0
        }
        Ok(None) => 1,
        Err(_) => -1,
    }
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
