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
// into a process that already holds LibRaw, libvips, libheif and GLib, so a bare
// `decode` or `fit` would be an invitation. The `#[repr(C)]` types carry it too,
// against the usual rule of naming for behaviour rather than owner, only so that
// each pairs visibly with the symbol it crosses the boundary in - `BbHeader` with
// `bb_read_header`. Types that stay on this side are named normally.

#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case)]

use std::ffi::CStr;
use std::os::raw::{c_char, c_int};

pub mod ffi;
pub mod fit;
pub mod hdr;
pub mod hdr_args;
pub mod hdr_fit;
pub mod header;
pub mod image;
pub mod lens;
pub mod tone;
pub mod vips;

mod raw {
    #![allow(non_upper_case_globals, non_camel_case_types, non_snake_case, dead_code)]
    include!(concat!(env!("OUT_DIR"), "/libraw.rs"));
}

/// LibRaw's `user_qual`: PPG, the cheapest of LibRaw's algorithms and not the
/// worst. See DESIGN 10.4 for the measured table across all of them.
const DEMOSAIC_PPG: c_int = 2;

/// Which demosaic to run, overridable with BOWERBIRD_DEMOSAIC.
///
/// A knob because the choice is a speed/quality trade that only measurement
/// settles, and the measurement is worth repeating on a different sensor: see
/// DESIGN 10.4 for the numbers across LibRaw's algorithms. Anything outside the
/// range LibRaw accepts falls back to PPG rather than letting it pick its default.
fn demosaic() -> c_int {
    std::env::var("BOWERBIRD_DEMOSAIC")
        .ok()
        .and_then(|value| value.parse::<c_int>().ok())
        .filter(|value| (0..=12).contains(value))
        .unwrap_or(DEMOSAIC_PPG)
}

const OUTPUT_SRGB: c_int = 1;
const OUTPUT_REC2020: c_int = 8;

/// A decoded image, owned by this library for as long as JS holds the pointer.
///
/// Handed to JS as an opaque handle, not as pixels. Every operation - fit, grade,
/// resize, encode - takes the handle back and works on the buffer where it lies,
/// so a 60MP render never crosses the boundary. It used to: the decode copied
/// into a JS `Buffer` and each call copied it back into a `Vec`, three ~45MB
/// moves of pixels no JavaScript ever looked at.
///
/// Still `#[repr(C)]` with plain fields, because the two paths that genuinely do
/// want the samples in JS - the 16-bit scene-linear decode the HDR encoder pipes
/// to ffmpeg, and the fit that grades it - read them through a DataView.
#[repr(C)]
pub struct BbImage {
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub data: *mut u8,
    pub len: usize,
    /// Non-zero when the frame was decoded at half size.
    pub halved: u32,
    /// Kept so `bb_free` can drop the exact allocation it handed out.
    capacity: usize,
}

impl BbImage {
    /// Takes ownership of an 8-bit RGB buffer and hands back a handle to it.
    pub fn own(image: vips::Rgb) -> *mut BbImage {
        let width = image.width as u32;
        let height = image.height as u32;
        let mut data = std::mem::ManuallyDrop::new(image.data);
        Box::into_raw(Box::new(BbImage {
            width,
            height,
            depth: 8,
            data: data.as_mut_ptr(),
            len: data.len(),
            halved: 0,
            capacity: data.capacity(),
        }))
    }

    /// The pixels, borrowed. None for a 16-bit decode, which the image operations
    /// have no path for - they are all 8-bit sRGB, and reading a 16-bit buffer as
    /// though it were 8-bit would silently render half the frame.
    ///
    /// The samples of a 16-bit decode, borrowed. None for an 8-bit one.
    ///
    /// Separate from `view` because the two are not interchangeable: the image
    /// operations are all 8-bit sRGB, and the HDR grade is all 16-bit scene-linear.
    /// Reading either buffer as the other silently renders half a frame.
    ///
    /// # Safety
    /// `data` must still point at the allocation this handle was built with.
    pub unsafe fn view_u16(&self) -> Option<&[u16]> {
        if self.depth != 16 || self.data.is_null() {
            return None;
        }
        Some(std::slice::from_raw_parts(self.data as *const u16, self.len / 2))
    }

    /// # Safety
    /// `data` must still point at the allocation this handle was built with.
    pub unsafe fn view(&self) -> Option<vips::RgbRef<'_>> {
        if self.depth != 8 || self.data.is_null() {
            return None;
        }
        Some(vips::RgbRef {
            width: self.width as usize,
            height: self.height as usize,
            data: std::slice::from_raw_parts(self.data, self.len),
        })
    }
}

pub struct Insets {
    pub left: usize,
    pub top: usize,
    pub right: usize,
    pub bottom: usize,
}

const UNSET: u16 = 65535;

/// Rows and columns the camera says are outside the picture, in sensor
/// orientation. Some bodies report masked border columns as visible, and decoding
/// them verbatim bakes black bars into the render.
pub(crate) unsafe fn read_insets(r: *mut raw::libraw_data_t) -> Insets {
    let s = &(*r).sizes;
    let none = Insets { left: 0, top: 0, right: 0, bottom: 0 };
    let crop = s.raw_inset_crops[0];
    if crop.cleft == UNSET || crop.ctop == UNSET || crop.cwidth == 0 || crop.cheight == 0 {
        return none;
    }
    if crop.cleft + crop.cwidth > s.raw_width || crop.ctop + crop.cheight > s.raw_height {
        return none;
    }
    Insets {
        left: crop.cleft as usize,
        top: crop.ctop as usize,
        right: (s.raw_width - crop.cleft - crop.cwidth) as usize,
        bottom: (s.raw_height - crop.ctop - crop.cheight) as usize,
    }
}

/// dcraw_process emits an upright frame, so sensor-space margins arrive rotated by
/// the same flip.
pub(crate) fn rotate_insets(i: Insets, flip: c_int) -> Insets {
    match flip {
        3 => Insets { left: i.right, top: i.bottom, right: i.left, bottom: i.top },
        5 => Insets { left: i.top, top: i.right, right: i.bottom, bottom: i.left },
        6 => Insets { left: i.bottom, top: i.left, right: i.top, bottom: i.right },
        _ => i,
    }
}

fn halve_insets(i: Insets) -> Insets {
    Insets { left: i.left / 2, top: i.top / 2, right: i.right / 2, bottom: i.bottom / 2 }
}

/// as-shot multipliers normalised to green. None when the file recorded no usable
/// set: writing a zero would zero that channel, which is worse than the wrong
/// white balance this exists to fix. The fourth is excluded from the test because a
/// three-colour camera reports it as 0 legitimately.
fn camera_multipliers(cam_mul: &[f32; 4]) -> Option<[f32; 4]> {
    let (r, g, b, g2) = (cam_mul[0], cam_mul[1], cam_mul[2], cam_mul[3]);
    if !(r > 0.0) || !(g > 0.0) || !(b > 0.0) {
        return None;
    }
    Some([r / g, 1.0, b / g, if g2 > 0.0 { g2 / g } else { 1.0 }])
}

/// Copies the frame out of LibRaw's buffer with the crop applied on the way, which
/// is the only copy: doing it whole and then cropping moves ~190MB twice.
unsafe fn copy_cropped(src: *const u8, w: usize, h: usize, bytes_per_px: usize, i: &Insets) -> Vec<u8> {
    let width = w.saturating_sub(i.left + i.right);
    let height = h.saturating_sub(i.top + i.bottom);
    if width == 0 || height == 0 || (i.left | i.top | i.right | i.bottom) == 0 {
        return std::slice::from_raw_parts(src, w * h * bytes_per_px).to_vec();
    }
    let stride = w * bytes_per_px;
    let row_bytes = width * bytes_per_px;
    let mut out = Vec::with_capacity(width * height * bytes_per_px);
    for row in 0..height {
        let from = (row + i.top) * stride + i.left * bytes_per_px;
        out.extend_from_slice(std::slice::from_raw_parts(src.add(from), row_bytes));
    }
    out
}

/// Decodes a RAW to an upright RGB bitmap.
///
/// `at_least_long_edge` is the longest edge the caller needs; when halving still
/// clears it the decode runs at half size. 0 means the whole frame.
///
/// Returns null on any failure. The result must be released with `bb_free`.
///
/// # Safety
/// `path` must be a NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn bb_decode(
    path: *const c_char,
    depth: u32,
    rec2020_linear: c_int,
    at_least_long_edge: u32,
) -> *mut BbImage {
    if path.is_null() || (depth != 8 && depth != 16) {
        return std::ptr::null_mut();
    }
    let r = raw::libraw_init(0);
    if r.is_null() {
        return std::ptr::null_mut();
    }

    let result = (|| -> Option<Box<BbImage>> {
        if raw::libraw_open_file(r, CStr::from_ptr(path).as_ptr()) != 0 {
            return None;
        }

        // Read before unpack/process, which overwrite the size fields.
        let flip = (*r).sizes.flip;
        let mut insets = rotate_insets(read_insets(r), flip);
        let full_long_edge = (*r).sizes.width.max((*r).sizes.height) as u32;

        // The typed field the whole wrapper exists for.
        let halved = at_least_long_edge > 0 && full_long_edge / 2 >= at_least_long_edge;
        if halved {
            (*r).params.half_size = 1;
            insets = halve_insets(insets);
        }

        if let Some(mul) = camera_multipliers(&(*r).color.cam_mul) {
            (*r).params.user_mul = mul;
        }
        (*r).params.user_qual = demosaic();
        (*r).params.output_bps = depth as c_int;
        if rec2020_linear != 0 {
            (*r).params.output_color = OUTPUT_REC2020;
            // Identity curve, so samples stay proportional to the light that made
            // them, and no auto-brightening to normalise away HDR headroom.
            (*r).params.gamm[0] = 1.0;
            (*r).params.gamm[1] = 1.0;
            (*r).params.no_auto_bright = 1;
        } else {
            (*r).params.output_color = OUTPUT_SRGB;
        }

        if raw::libraw_unpack(r) != 0 || raw::libraw_dcraw_process(r) != 0 {
            return None;
        }
        let mut err: c_int = 0;
        let image = raw::libraw_dcraw_make_mem_image(r, &mut err);
        if image.is_null() || err != 0 {
            return None;
        }

        let w = (*image).width as usize;
        let h = (*image).height as usize;
        let colors = (*image).colors;
        let bits = (*image).bits as u32;
        let data = copy_cropped(
            (*image).data.as_ptr(),
            w,
            h,
            3 * (depth as usize / 8),
            &insets,
        );
        raw::libraw_dcraw_clear_mem(image);
        if colors != 3 || bits != depth {
            return None;
        }

        let width = (w - insets.left - insets.right) as u32;
        let height = (h - insets.top - insets.bottom) as u32;
        let mut data = std::mem::ManuallyDrop::new(data);
        Some(Box::new(BbImage {
            width,
            height,
            depth,
            data: data.as_mut_ptr(),
            len: data.len(),
            halved: u32::from(halved),
            capacity: data.capacity(),
        }))
    })();

    raw::libraw_recycle(r);
    raw::libraw_close(r);
    match result {
        Some(image) => Box::into_raw(image),
        None => std::ptr::null_mut(),
    }
}

/// `libraw_image_formats_t`: a preview is either a JPEG or a bare bitmap.
const LIBRAW_IMAGE_JPEG: raw::LibRaw_image_formats = 1;

/// Runs `use_bytes` over the camera's embedded JPEG preview, in place.
///
/// The bytes stay in LibRaw's own buffer for the duration - they are 5-14MB on a
/// 61MP body, which embeds a full-resolution preview - and are released before
/// this returns. Nothing copies them, and in particular nothing hands them to
/// JavaScript, which is the whole reason this exists rather than an "extract the
/// preview" call.
///
/// None when the file has no JPEG preview: some bodies embed a bitmap and some
/// embed nothing, which is a property of the file rather than an error, and the
/// caller falls back to a render.
///
/// # Safety
/// `path` must be a NUL-terminated C string.
unsafe fn with_embedded_jpeg<T>(path: *const c_char, use_bytes: impl FnOnce(&[u8]) -> T) -> Option<T> {
    let r = raw::libraw_init(0);
    if r.is_null() {
        return None;
    }

    let result = (|| -> Option<T> {
        if raw::libraw_open_file(r, path) != 0 || raw::libraw_unpack_thumb(r) != 0 {
            return None;
        }
        let mut err: c_int = 0;
        let thumb = raw::libraw_dcraw_make_mem_thumb(r, &mut err);
        if thumb.is_null() || err != 0 {
            return None;
        }
        // Freed on every path below, including the one where the format is wrong.
        let out = (|| {
            let size = (*thumb).data_size as usize;
            if (*thumb).type_ != LIBRAW_IMAGE_JPEG || size == 0 {
                return None;
            }
            Some(use_bytes(std::slice::from_raw_parts((*thumb).data.as_ptr(), size)))
        })();
        raw::libraw_dcraw_clear_mem(thumb);
        out
    })();

    raw::libraw_recycle(r);
    raw::libraw_close(r);
    result
}

/// The camera's embedded preview as RGB, bounded by `long_edge`, for callers on this
/// side of the boundary. None when the file embeds no JPEG preview.
pub fn decode_embedded_rgb(path: &str, long_edge: usize) -> Option<vips::Rgb> {
    vips::init();
    let c_path = std::ffi::CString::new(path).ok()?;
    // SAFETY: the CString outlives the call.
    let decoded = unsafe {
        with_embedded_jpeg(c_path.as_ptr(), |bytes| {
            vips::Pipeline::thumbnail(bytes, long_edge).and_then(vips::Pipeline::finish)
        })
    };
    match decoded {
        Some(Ok(image)) => Some(image),
        Some(Err(detail)) => {
            eprintln!("decode_embedded_rgb: {detail}");
            None
        }
        None => None,
    }
}

/// Decodes the camera's embedded preview to an upright RGB bitmap, fitted to
/// `long_edge`. 0 leaves it at the size the body embedded.
///
/// This is the whole of an import's thumbnail stage: extract, decode, shrink. It
/// used to be three steps with the JPEG copied into a JavaScript `Buffer` in the
/// middle, which was both the largest thing crossing the boundary and the reason
/// libvips' operation cache had to go - a cached graph held a pointer into bytes
/// that JavaScript was free to collect (`vips.rs`).
///
/// Returns null when the file has no JPEG preview, which is not an error.
///
/// # Safety
/// `path` must be a NUL-terminated C string. Release with `bb_free`.
#[no_mangle]
pub unsafe extern "C" fn bb_decode_embedded(path: *const c_char, long_edge: u32) -> *mut BbImage {
    vips::init();
    if path.is_null() {
        return std::ptr::null_mut();
    }

    let decoded = with_embedded_jpeg(path, |bytes| match long_edge {
        0 => vips::Pipeline::decode_upright(bytes).and_then(vips::Pipeline::finish),
        edge => vips::Pipeline::thumbnail(bytes, edge as usize).and_then(vips::Pipeline::finish),
    });

    match decoded {
        Some(Ok(image)) => BbImage::own(image),
        Some(Err(detail)) => {
            eprintln!("bb_decode_embedded: {detail}");
            std::ptr::null_mut()
        }
        None => std::ptr::null_mut(),
    }
}

/// Reads what the catalogue needs from a RAW without decoding a pixel.
///
/// Returns 0 on success, -1 if the file could not be opened. See `header.rs` for
/// why this is not a set of byte offsets in TypeScript any more.
///
/// # Safety
/// `path` must be a NUL-terminated C string and `out` a writable `BbHeader`.
#[no_mangle]
pub unsafe extern "C" fn bb_read_header(path: *const c_char, out: *mut header::BbHeader) -> c_int {
    if path.is_null() || out.is_null() {
        return -1;
    }
    let r = raw::libraw_init(0);
    if r.is_null() {
        return -1;
    }

    let status = match raw::libraw_open_file(r, path) {
        0 => {
            *out = header::read(r);
            0
        }
        _ => -1,
    };

    raw::libraw_recycle(r);
    raw::libraw_close(r);
    status
}

/// Size of `BbHeader`, which the caller checks against the layout it reads.
#[no_mangle]
pub extern "C" fn bb_header_size() -> usize {
    std::mem::size_of::<header::BbHeader>()
}

/// Releases an image from `bb_decode`. Safe to call with null.
///
/// # Safety
/// `image` must have come from `bb_decode` and not been freed already.
#[no_mangle]
pub unsafe extern "C" fn bb_free(image: *mut BbImage) {
    if image.is_null() {
        return;
    }
    let image = Box::from_raw(image);
    drop(Vec::from_raw_parts(image.data, image.len, image.capacity));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_the_as_shot_multipliers_to_green() {
        // A real ILCE-7CR set, as LibRaw reports it.
        let out = camera_multipliers(&[2770.0, 1024.0, 1669.0, 1024.0]).unwrap();
        assert_eq!(out, [2770.0 / 1024.0, 1.0, 1669.0 / 1024.0, 1.0]);
    }

    #[test]
    fn substitutes_green_for_a_three_colour_camera() {
        // Reporting 0 in the fourth slot is legitimate, not corruption, so it must
        // not veto the set - that would skip white balance on exactly those bodies.
        let out = camera_multipliers(&[2060.0, 1024.0, 2904.0, 0.0]).unwrap();
        assert_eq!(out, [2060.0 / 1024.0, 1.0, 2904.0 / 1024.0, 1.0]);
    }

    #[test]
    fn refuses_a_set_missing_any_of_r_g_b() {
        // These go straight into user_mul, so one zero would zero that channel and
        // one negative would invert it. Falling back to LibRaw's default is better.
        assert!(camera_multipliers(&[0.0, 1024.0, 1669.0, 1024.0]).is_none());
        assert!(camera_multipliers(&[2770.0, 0.0, 1669.0, 1024.0]).is_none());
        assert!(camera_multipliers(&[2770.0, 1024.0, 0.0, 1024.0]).is_none());
        assert!(camera_multipliers(&[2770.0, 1024.0, -1669.0, 1024.0]).is_none());
    }

    #[test]
    fn never_returns_a_non_positive_multiplier() {
        for set in [[2770.0, 1024.0, 1669.0, 1024.0], [2060.0, 1024.0, 2904.0, 0.0], [1.0, 1.0, 1.0, -5.0]] {
            if let Some(out) = camera_multipliers(&set) {
                assert!(out.iter().all(|v| *v > 0.0), "{set:?} produced {out:?}");
            }
        }
    }

    #[test]
    fn halves_insets_without_going_negative() {
        let halved = halve_insets(Insets { left: 7, top: 3, right: 9, bottom: 1 });
        assert_eq!((halved.left, halved.top, halved.right, halved.bottom), (3, 1, 4, 0));
    }
}
