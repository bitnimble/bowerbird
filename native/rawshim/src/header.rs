// What the catalogue needs from a RAW without decoding a pixel: dimensions,
// orientation, capture time, GPS, exposure, and the camera and lens names.
//
// In Rust because it was six tables of hardcoded byte offsets in TypeScript,
// reaching into five C structs, one of which was reached by assuming where another
// sat inside a sixth. That is the same guess that motivated moving the decode here
// (DESIGN 10.4): the offsets were right, and were checked against real files from
// several bodies, but nothing made them stay right. rawler hands back named fields,
// so a layout change is now a compile error rather than a photo dated 1970 at the
// wrong coordinates.
//
// The struct handed back is `#[repr(C)]` and ours, which is the distinction that
// matters: TypeScript still reads it at fixed offsets, but this one cannot change
// under us the way an upstream C struct can, and its size is checked at the first
// call.

/// Unknown, for a field the camera did not record. A 0 that reached the catalogue would print as
/// f/0 or 1970.
const UNKNOWN: f32 = 0.0;

/// Flat header fields, in one struct so reading them is one call.
#[repr(C)]
pub struct BbHeader {
    /// Display orientation, with the masked-border crop already applied.
    pub width: u32,
    pub height: u32,
    /// The EXIF tag, 1 to 8, and 0 when unreadable. Not the `flip` encoding LibRaw handed over
    /// here, which used 0/3/5/6 and is what the catalogue's older rows hold.
    pub orientation: i32,
    /// 0 for anything the camera did not record.
    pub iso: f32,
    pub shutter: f32,
    pub aperture: f32,
    pub focal: f32,
    /// Seconds since the epoch, from the camera's wall clock read as UTC. 0 when
    /// absent; the caller re-encodes it (see `wallClockIso`).
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

/// Bounds that mean "no camera reports this", not physical limits: ISO 4 million,
/// a one-hour exposure, f/256 and a 10m lens are all past anything real, so a
/// value beyond them is a misread rather than an unusual shot.
fn plausible(value: f32, max: f32) -> f32 {
    if value.is_finite() && value > 0.0 && value < max { value } else { UNKNOWN }
}

/// The header of a file on disk, or None when it cannot be read.
///
/// The one place that opens a photograph purely for its metadata - the fit reaches for this too,
/// to name the lens.
///
/// The dimensions come from a dummy decode rather than from EXIF. EXIF describes the picture the
/// camera would have made, which is not always the one this produces: the recommended crop and the
/// orientation both move it, and the catalogue's row has to agree with the rendition it will show.
pub fn read_path(path: &str) -> Option<BbHeader> {
    // A finished picture is not rawler's to read, and asking anyway costs an open and a decoder
    // search per file on an import that may be entirely JPEGs.
    if crate::decode_rendered::is_rendered(path) {
        return read_rendered(path);
    }
    // `new_lazy`, not `new`: the prefault in `new` reads the whole 25-60MB file, and everything
    // below reads tags. An import opens every file in the library through here.
    let source = rawler::rawsource::RawSource::new_lazy(std::path::Path::new(path)).ok()?;
    let decoder = rawler::get_decoder(&source).ok()?;
    read_with(&source, decoder.as_ref())
}

/// The same header, for a photograph that arrives already rendered.
///
/// **The size comes off the container rather than off a decode**, which is the whole difference:
/// a PNG's `IHDR`, a JPEG's frame header and a HEIF's `ispe` each state it in the first few
/// kilobytes, so an import of fifty thousand JPEGs never decodes a pixel. Everything else is the
/// EXIF block the file carries, read through the same rules a RAW's is.
pub fn read_rendered(path: &str) -> Option<BbHeader> {
    // The front of the file, then the whole of it only where that was not enough. An import opens
    // every file in the library through here, and a JPEG is megabytes of entropy-coded data behind
    // a few kilobytes of tags - the same reason the RAW path above opens `new_lazy`.
    //
    // "Not enough" is a probe that failed, or one that found no EXIF in a file with more of it to
    // read: a HEIF's EXIF is an item located through `iloc` and can sit anywhere in `mdat`. A file
    // that fits inside the window and carried no tags carried none.
    let window = head(path, HEADER_WINDOW);
    let probed = window.as_deref().and_then(crate::decode_rendered::probe);
    let whole;
    let probe = match probed {
        // A PNG's `eXIf` and a JPEG's `APP1` both sit in front of the pixels, so a probe that
        // walked them and found none has the answer - reading the rest of the file would put the
        // same walk over the same bytes. Only a HEIF can hide its EXIF further in, its `Exif`
        // item being located through `iloc` and free to sit anywhere in `mdat`.
        Some(probe) if probe.exif.is_some() || !probe.deferred => probe,
        _ => {
            whole = std::fs::read(path).ok()?;
            crate::decode_rendered::probe(&whole)?
        }
    };
    Some(from_probe(probe))
}

/// The header of a photograph a caller holds the whole of, which is a browser's only way to have one.
pub fn read_bytes(bytes: &[u8]) -> Option<BbHeader> {
    if crate::decode_rendered::is_rendered_bytes(bytes) {
        return crate::decode_rendered::probe(bytes).map(from_probe);
    }
    let source = rawler::rawsource::RawSource::new_from_slice(bytes);
    let decoder = rawler::get_decoder(&source).ok()?;
    read_with(&source, decoder.as_ref())
}

fn from_probe(probe: crate::decode_rendered::Probe) -> BbHeader {
    let mut out = BbHeader::blank();
    let (mut width, mut height) = (probe.width as u32, probe.height as u32);
    if crate::orientation::transposes(probe.turn) {
        std::mem::swap(&mut width, &mut height);
    }
    out.width = width;
    out.height = height;
    out.orientation = i32::from(probe.orientation);
    if let Some(exif) = probe.exif.as_deref() {
        read_exif_into(exif, &mut out);
    }
    out
}

/// How much of a finished picture is read before the whole of it is, which is the same distance
/// `exif_zone.ts` reads for the same reason.
const HEADER_WINDOW: usize = 256 * 1024;

/// The first `bytes` of a file, or the whole of it where it is shorter.
fn head(path: &str, bytes: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut out = Vec::with_capacity(bytes);
    file.take(bytes as u64).read_to_end(&mut out).ok()?;
    Some(out)
}

/// The tags a delivered picture carries, into the fields the catalogue reads.
///
/// Through rawler's own TIFF reader rather than a second walk of hardcoded offsets, which is what
/// this module exists to have stopped doing.
fn read_exif_into(tiff: &[u8], out: &mut BbHeader) {
    use rawler::formats::tiff::reader::TiffReader;
    const EXIF_IFD: u16 = 0x8769;
    const GPS_IFD: u16 = 0x8825;

    let Ok(reader) = rawler::formats::tiff::reader::GenericTiffReader::new(
        &mut std::io::Cursor::new(tiff),
        0,
        0,
        None,
        &[EXIF_IFD, GPS_IFD],
    ) else {
        return;
    };
    let root = reader.root_ifd();
    let exif = root.get_sub_ifd(EXIF_IFD);

    let rational = |tag: u16| -> f32 {
        exif.and_then(|ifd| ifd.get_entry(tag)).map_or(0.0, |entry| entry.force_f32(0))
    };
    out.iso = plausible(
        exif.and_then(|ifd| ifd.get_entry(0x8827u16).or_else(|| ifd.get_entry(0x8833u16)))
            .map_or(0.0, |entry| entry.force_f32(0)),
        4_000_000.0,
    );
    out.shutter = plausible(rational(0x829A), 3600.0);
    out.aperture = plausible(rational(0x829D), 256.0);
    out.focal = plausible(rational(0x920A), 10_000.0);

    let taken = exif
        .and_then(|ifd| ifd.get_entry(0x9003u16))
        .and_then(|entry| entry.as_string())
        .and_then(|stamp| seconds_since_epoch(stamp));
    if let Some(taken) = taken {
        if taken > 631_152_000 && taken < 4_102_444_800 {
            out.timestamp = taken;
        }
    }

    if let Some(gps) = root.get_sub_ifd(GPS_IFD) {
        let triple = |tag: u16| -> Option<f64> {
            let entry = gps.get_entry(tag)?;
            Some(
                f64::from(entry.force_f32(0))
                    + f64::from(entry.force_f32(1)) / 60.0
                    + f64::from(entry.force_f32(2)) / 3600.0,
            )
        };
        let sign = |tag: u16, negative: &str| -> f64 {
            match gps.get_entry(tag).and_then(|entry| entry.as_string()).map(String::as_str) {
                Some(it) if it.trim() == negative => -1.0,
                _ => 1.0,
            }
        };
        let latitude = triple(0x0002).unwrap_or(0.0) * sign(0x0001, "S");
        let longitude = triple(0x0004).unwrap_or(0.0) * sign(0x0003, "W");
        // The same 0,0 rule as a RAW's: a body saying nothing rather than a photograph taken in
        // the Gulf of Guinea.
        if latitude != 0.0 || longitude != 0.0 {
            if latitude.is_finite() && latitude.abs() <= 90.0 {
                out.latitude = latitude;
            }
            if longitude.is_finite() && longitude.abs() <= 180.0 {
                out.longitude = longitude;
            }
        }
    }

    let string = |ifd: Option<&rawler::formats::tiff::ifd::IFD>, tag: u16| -> String {
        ifd.and_then(|ifd| ifd.get_entry(tag))
            .and_then(|entry| entry.as_string())
            .cloned()
            .unwrap_or_default()
    };
    write_name(&mut out.camera_make, &string(Some(root), 0x010F));
    write_name(&mut out.camera_model, &string(Some(root), 0x0110));
    write_name(&mut out.lens_model, &string(exif, 0xA434));
}

/// The EXIF orientation tag out of a TIFF block, for the two containers that keep their turn
/// there rather than in a box of their own.
pub fn exif_orientation(tiff: &[u8]) -> Option<u16> {
    use rawler::formats::tiff::reader::TiffReader;
    let reader = rawler::formats::tiff::reader::GenericTiffReader::new_with_buffer(tiff, 0, 0, None)
        .ok()?;
    let tag = reader.root_ifd().get_entry(0x0112u16)?.force_u16(0);
    match (1..=8).contains(&tag) {
        true => Some(tag),
        false => None,
    }
}

/// The same header, off a source and decoder the caller already opened.
pub fn read_with(
    source: &rawler::rawsource::RawSource,
    decoder: &dyn rawler::decoders::Decoder,
) -> Option<BbHeader> {
    let params = rawler::decoders::RawDecodeParams::default();
    let metadata = decoder.raw_metadata(source, &params).ok()?;
    let shape = decoder.raw_image(source, &params, true).ok()?;

    let mut out = BbHeader::blank();
    let exif = &metadata.exif;

    let orientation = exif.orientation.unwrap_or(1);
    out.orientation = if (1..=8).contains(&orientation) { i32::from(orientation) } else { 0 };

    let (mut width, mut height) = shape
        .crop_area
        .map_or((shape.width as u32, shape.height as u32), |area| (area.d.w as u32, area.d.h as u32));
    if matches!(orientation, 5 | 6 | 7 | 8) {
        std::mem::swap(&mut width, &mut height);
    }
    out.width = width;
    out.height = height;

    let ratio = |r: &rawler::formats::tiff::Rational| match r.d {
        0 => 0.0,
        d => r.n as f32 / d as f32,
    };
    out.iso = plausible(
        exif.iso_speed.or_else(|| exif.iso_speed_ratings.map(u32::from)).unwrap_or(0) as f32,
        4_000_000.0,
    );
    out.shutter = plausible(exif.exposure_time.as_ref().map_or(0.0, ratio), 3600.0);
    out.aperture = plausible(exif.fnumber.as_ref().map_or(0.0, ratio), 256.0);
    out.focal = plausible(exif.focal_length.as_ref().map_or(0.0, ratio), 10_000.0);

    if let Some(taken) = exif.date_time_original.as_deref().and_then(seconds_since_epoch) {
        // 1990 to 2100: a timestamp outside that is a misparse, not a photograph.
        if taken > 631_152_000 && taken < 4_102_444_800 {
            out.timestamp = taken;
        }
    }

    if let Some(gps) = exif.gps.as_ref() {
        // An exact 0,0 is a body saying nothing rather than a photograph taken in the Gulf of
        // Guinea, which is why this reads the triples rather than trusting their presence.
        let latitude = gps.gps_latitude.map(|t| degrees_of(&t)).unwrap_or(0.0)
            * if gps.gps_latitude_ref.as_deref() == Some("S") { -1.0 } else { 1.0 };
        let longitude = gps.gps_longitude.map(|t| degrees_of(&t)).unwrap_or(0.0)
            * if gps.gps_longitude_ref.as_deref() == Some("W") { -1.0 } else { 1.0 };
        if latitude != 0.0 || longitude != 0.0 {
            if latitude.is_finite() && latitude.abs() <= 90.0 {
                out.latitude = latitude;
            }
            if longitude.is_finite() && longitude.abs() <= 180.0 {
                out.longitude = longitude;
            }
        }
    }

    write_name(&mut out.camera_make, &metadata.make);
    write_name(&mut out.camera_model, &metadata.model);
    let lens = metadata
        .lens
        .as_ref()
        .map(|l| l.lens_name.clone())
        .or_else(|| exif.lens_model.clone())
        .unwrap_or_default();
    write_name(&mut out.lens_model, &lens);

    Some(out)
}

/// Degrees, minutes and seconds as the one number the catalogue stores.
fn degrees_of(triple: &[rawler::formats::tiff::Rational; 3]) -> f64 {
    let part = |r: &rawler::formats::tiff::Rational| match r.d {
        0 => 0.0,
        d => f64::from(r.n) / f64::from(d),
    };
    part(&triple[0]) + part(&triple[1]) / 60.0 + part(&triple[2]) / 3600.0
}

/// EXIF's `YYYY:MM:DD HH:MM:SS`, in seconds, treated as UTC.
///
/// Treated as UTC deliberately, which is what LibRaw's own parse did: the offset tags are not
/// filled in by every body, and a timestamp that shifts depending on whether the camera recorded a
/// zone would reorder a shoot.
fn seconds_since_epoch(stamp: &str) -> Option<i64> {
    let numbers: Vec<i64> = stamp
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse().ok())
        .collect();
    let [year, month, day, hour, minute, second] = numbers.get(..6)?.try_into().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    // Days since 1970 by the civil-from-days algorithm, which needs no calendar crate and no
    // leap-year special cases beyond the shifted year it starts from.
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second)
}

/// Writes a name into its fixed-width field, truncated and always NUL-terminated.
fn write_name(field: &mut [u8], value: &str) {
    let trimmed = value.trim().as_bytes();
    let room = field.len().saturating_sub(1);
    let taken = trimmed.len().min(room);
    field[..taken].copy_from_slice(&trimmed[..taken]);
    field[taken..].fill(0);
}

/// The name a field holds, or "" where the camera recorded none.
pub fn name(field: &[u8]) -> &str {
    let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
    std::str::from_utf8(&field[..end]).unwrap_or("").trim()
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
        write_name(&mut into, "ILCE-7CR-and-then-some");
        assert_eq!(&into[..7], b"ILCE-7C");
        assert_eq!(into[7], 0, "always NUL-terminated");
    }

    #[test]
    fn a_name_leaves_no_tail_of_the_one_before_it() {
        let mut into = [0u8; 16];
        write_name(&mut into, "ILCE-7CR");
        write_name(&mut into, "R8");
        assert_eq!(name(&into), "R8");
    }

    #[test]
    fn a_timestamp_is_read_from_the_exif_spelling() {
        // 2024-06-07 14:58:25 UTC.
        assert_eq!(seconds_since_epoch("2024:06:07 14:58:25"), Some(1_717_772_305));
        // A leap day, which is where a hand-rolled calendar goes wrong if it is going to.
        assert_eq!(seconds_since_epoch("2024:02:29 00:00:00"), Some(1_709_164_800));
        assert_eq!(seconds_since_epoch("1970:01:01 00:00:00"), Some(0));
    }

    #[test]
    fn a_timestamp_that_is_not_one_reports_nothing() {
        assert_eq!(seconds_since_epoch(""), None);
        assert_eq!(seconds_since_epoch("2024:06:07"), None, "a date with no time is short");
        assert_eq!(seconds_since_epoch("2024:13:07 00:00:00"), None, "there is no thirteenth month");
    }

    #[test]
    fn degrees_come_out_of_the_triple_the_way_a_map_wants_them() {
        let rational = |n: u32, d: u32| rawler::formats::tiff::Rational::new(n, d);
        // 38 deg 37' 3.5" is the south side of Huka Falls.
        let dms = [rational(38, 1), rational(37, 1), rational(35, 10)];
        assert!((degrees_of(&dms) - 38.617_638_9).abs() < 1e-6);
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
        let rational = |n: u32, d: u32| rawler::formats::tiff::Rational::new(n, d);
        assert!((degrees_of(&[rational(51, 1), rational(30, 1), rational(0, 1)]) - 51.5).abs() < 1e-9);
        assert!((degrees_of(&[rational(0, 1), rational(0, 1), rational(3600, 1)]) - 1.0).abs() < 1e-9);
    }
}
