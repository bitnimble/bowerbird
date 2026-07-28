// What the catalogue needs from a RAW without decoding a pixel: dimensions,
// orientation, capture time, GPS, exposure, and the camera and lens names.
//
// In Rust because it was six tables of hardcoded byte offsets in TypeScript,
// reaching into five of LibRaw's structs - `libraw_image_sizes_t`,
// `libraw_imgother_t`, `libraw_gps_info_t`, `libraw_iparams_t` and
// `libraw_lensinfo_t` - one of which was reached by assuming where `sizes` sits
// inside `libraw_data_t`. That is the same guess that motivated moving the decode
// here (DESIGN 10.4): the offsets were right, and were checked against real files
// from several bodies, but nothing made them stay right. bindgen resolves every
// field from the headers the runtime library was built from, so a layout change is
// now a compile error rather than a photo dated 1970 at the wrong coordinates.
//
// The struct handed back is `#[repr(C)]` and ours, which is the distinction that
// matters: TypeScript still reads it at fixed offsets, but this one cannot change
// under us the way an upstream C struct can, and its size is checked at the first
// call.

use crate::raw;
use std::ffi::c_char;

/// Unknown, for a field the camera did not record. LibRaw leaves these at 0, and
/// a 0 that reached the catalogue would print as f/0 or 1970.
const UNKNOWN: f32 = 0.0;

/// Flat header fields, in one struct so reading them is one call.
#[repr(C)]
pub struct BbHeader {
    /// Display orientation, with the masked-border crop already applied.
    pub width: u32,
    pub height: u32,
    /// LibRaw's `sizes.flip` (0/3/5/6), 0 when unreadable.
    pub orientation: i32,
    /// 0 for anything the camera did not record.
    pub iso: f32,
    pub shutter: f32,
    pub aperture: f32,
    pub focal: f32,
    /// Seconds since the epoch as LibRaw's `mktime` produced it, so it is the
    /// camera's wall clock read in *this machine's* zone. 0 when absent; the
    /// caller re-encodes it (see `wallClockIso`).
    pub timestamp: i64,
    /// NaN when the file carries no parsed GPS fix.
    pub latitude: f64,
    pub longitude: f64,
    /// NUL-padded. Empty means the camera did not record it.
    pub camera_make: [u8; 64],
    pub camera_model: [u8; 64],
    pub lens_model: [u8; 128],
}

impl BbHeader {
    fn blank() -> BbHeader {
        BbHeader {
            width: 0,
            height: 0,
            orientation: 0,
            iso: UNKNOWN,
            shutter: UNKNOWN,
            aperture: UNKNOWN,
            focal: UNKNOWN,
            timestamp: 0,
            latitude: f64::NAN,
            longitude: f64::NAN,
            camera_make: [0; 64],
            camera_model: [0; 64],
            lens_model: [0; 128],
        }
    }
}

/// Copies a fixed-width NUL-padded C string across, truncating rather than
/// overflowing. A name longer than the destination is a misparse either way.
fn copy_name(into: &mut [u8], from: &[c_char]) {
    let bytes: Vec<u8> = from.iter().map(|c| *c as u8).collect();
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    let n = end.min(into.len().saturating_sub(1));
    into[..n].copy_from_slice(&bytes[..n]);
}

/// LibRaw's own cleaned-up names where it has them - "ILCE-7CR" rather than a
/// vendor string with firmware glued on - falling back to the raw ones.
fn preferred(normalized: &[c_char], raw_name: &[c_char], into: &mut [u8]) {
    copy_name(into, normalized);
    if into[0] == 0 {
        copy_name(into, raw_name);
    }
}

/// Degrees from LibRaw's degrees/minutes/seconds triple.
fn degrees(dms: &[f32; 3]) -> f64 {
    f64::from(dms[0]) + f64::from(dms[1]) / 60.0 + f64::from(dms[2]) / 3600.0
}

/// Bounds that mean "no camera reports this", not physical limits: ISO 4 million,
/// a one-hour exposure, f/256 and a 10m lens are all past anything real, so a
/// value beyond them is a misread rather than an unusual shot.
fn plausible(value: f32, max: f32) -> f32 {
    if value.is_finite() && value > 0.0 && value < max { value } else { UNKNOWN }
}

/// Reads the header of an already-opened file. `r` must have had `open_file` run.
///
/// # Safety
/// `r` must be a live `libraw_data_t` from `libraw_init`.
pub unsafe fn read(r: *mut raw::libraw_data_t) -> BbHeader {
    let mut out = BbHeader::blank();

    // sizes.flip is set at open and must be read before adjust_sizes_info_only.
    let flip = (*r).sizes.flip;
    out.orientation = if (0..=8).contains(&flip) { flip } else { 0 };

    // The stored dimensions describe the picture that gets thumbnailed, so they
    // carry the same crop the decode applies.
    let insets = crate::rotate_insets(crate::read_insets(r), flip);
    raw::libraw_adjust_sizes_info_only(r);
    out.width = u32::from((*r).sizes.iwidth).saturating_sub((insets.left + insets.right) as u32);
    out.height = u32::from((*r).sizes.iheight).saturating_sub((insets.top + insets.bottom) as u32);

    let other = &(*r).other;
    out.iso = plausible(other.iso_speed, 4_000_000.0);
    out.shutter = plausible(other.shutter, 3600.0);
    out.aperture = plausible(other.aperture, 256.0);
    out.focal = plausible(other.focal_len, 10_000.0);

    // 1990 to 2100: a timestamp outside that is a misparse, not a photograph.
    let seconds = other.timestamp as i64;
    if seconds > 631_152_000 && seconds < 4_102_444_800 {
        out.timestamp = seconds;
    }

    let gps = &other.parsed_gps;
    // Canon reports a parsed fix on every frame and zeroes the triples when there
    // was none, so an exact 0,0 is a body saying nothing rather than a photograph
    // taken in the Gulf of Guinea.
    if gps.gpsparsed == 1 && !(gps.latitude == [0.0; 3] && gps.longitude == [0.0; 3]) {
        // 'S' and 'W' are the negative hemispheres.
        let latitude = degrees(&gps.latitude) * if gps.latref as u8 == b'S' { -1.0 } else { 1.0 };
        let longitude = degrees(&gps.longitude) * if gps.longref as u8 == b'W' { -1.0 } else { 1.0 };
        if latitude.is_finite() && latitude.abs() <= 90.0 {
            out.latitude = latitude;
        }
        if longitude.is_finite() && longitude.abs() <= 180.0 {
            out.longitude = longitude;
        }
    }

    let idata = &(*r).idata;
    preferred(&idata.normalized_make, &idata.make, &mut out.camera_make);
    preferred(&idata.normalized_model, &idata.model, &mut out.camera_model);
    copy_name(&mut out.lens_model, &(*r).lens.Lens);

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_layout_the_typescript_reader_assumes_still_holds() {
        // rawshim_ops.ts reads this at fixed offsets and checks the size at the
        // first call. This is the same check, at build time.
        assert_eq!(std::mem::size_of::<BbHeader>(), 312);
        assert_eq!(std::mem::align_of::<BbHeader>(), 8);
    }

    #[test]
    fn a_name_is_truncated_rather_than_overflowing() {
        let mut into = [0u8; 8];
        let long: Vec<c_char> = "ILCE-7CR-and-then-some".bytes().map(|b| b as c_char).collect();
        copy_name(&mut into, &long);
        assert_eq!(&into[..7], b"ILCE-7C");
        assert_eq!(into[7], 0, "always NUL-terminated");
    }

    #[test]
    fn a_blank_normalized_name_falls_back_to_the_raw_one() {
        let mut into = [0u8; 64];
        let blank: Vec<c_char> = vec![0; 64];
        let raw_name: Vec<c_char> = "SONY".bytes().map(|b| b as c_char).collect();
        preferred(&blank, &raw_name, &mut into);
        assert_eq!(&into[..4], b"SONY");
    }

    #[test]
    fn implausible_readings_report_unknown_rather_than_a_number() {
        // A 0 reaching the catalogue prints as f/0; a garbage float prints as a
        // shot nobody took. Both are worse than "unknown".
        assert_eq!(plausible(0.0, 256.0), UNKNOWN);
        assert_eq!(plausible(-2.8, 256.0), UNKNOWN);
        assert_eq!(plausible(f32::NAN, 256.0), UNKNOWN);
        assert_eq!(plausible(1e9, 256.0), UNKNOWN);
        assert_eq!(plausible(2.8, 256.0), 2.8);
    }

    #[test]
    fn degrees_combines_the_dms_triple() {
        assert!((degrees(&[51.0, 30.0, 0.0]) - 51.5).abs() < 1e-9);
        assert!((degrees(&[0.0, 0.0, 3600.0]) - 1.0).abs() < 1e-9);
    }
}
