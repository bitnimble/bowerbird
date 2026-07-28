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

#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case)]

use std::ffi::CStr;
use std::os::raw::{c_char, c_int};

mod raw {
    #![allow(non_upper_case_globals, non_camel_case_types, non_snake_case, dead_code)]
    include!(concat!(env!("OUT_DIR"), "/libraw.rs"));
}

/// LibRaw's `user_qual`: PPG. Measured against the default AHD it is 544ms rather
/// than 849ms on a 61MP frame, for 0.18% mean difference.
const DEMOSAIC_PPG: c_int = 2;
const OUTPUT_SRGB: c_int = 1;
const OUTPUT_REC2020: c_int = 8;

/// What JS receives. Plain fields and a pointer, so it can be read through a
/// DataView without a second call per property.
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

struct Insets {
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
}

const UNSET: u16 = 65535;

/// Rows and columns the camera says are outside the picture, in sensor
/// orientation. Some bodies report masked border columns as visible, and decoding
/// them verbatim bakes black bars into the render.
unsafe fn read_insets(r: *mut raw::libraw_data_t) -> Insets {
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
fn rotate_insets(i: Insets, flip: c_int) -> Insets {
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
        (*r).params.user_qual = DEMOSAIC_PPG;
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
