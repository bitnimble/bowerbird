//! The gain map a JPEG carries beside its picture, in either of the two spellings that exist.
//!
//! **A JPEG's gain map is a second JPEG inside the same file**, and what points at it is MPF - the
//! Multi-Picture Format index in an `APP2` segment, which states an offset and a length per image.
//! That much is shared: Apple, Adobe and Google all write the map as the second MPF entry. What
//! differs is where the *terms* live, and there are two answers:
//!
//!   ISO 21496-1  an `APP2` segment introduced by `urn:iso:std:iso:ts:21496:-1\0`, holding the same
//!                payload a HEIC's `tmap` item does - so `decode_rendered::iso_21496_terms` reads
//!                both and there is one parser for the standard.
//!   Apple        nothing in the file beside the map: the headroom is two maker note tags, which
//!                `apple_gain` turns into the one number that arm needs.
//!
//! Google's Ultra HDR v1 states its terms in XMP under `hdrgm:` instead. Not read here: v1.1 moved
//! to the ISO payload above, so what an XMP-only file needs is a second metadata parser for a
//! spelling its own author has superseded. Such a file shows its SDR base, which is what Ultra
//! HDR's base is built to be.

use crate::linearise::{GainMap, Reconstruction};

/// The gain map beside a JPEG's primary picture, decoded and ready for the kernel.
///
/// None where the file has no second image, where its terms are in neither spelling, or where the
/// map itself would not decode - all of which are a photograph shown at its standard range, which
/// is a correct picture rather than an error.
pub fn read(file: &[u8], exif: Option<&[u8]>) -> Option<GainMap> {
    let map = second_image(file)?;
    let terms = terms_of(file, exif)?;
    let coded = decode(map)?;
    Some(GainMap {
        last: f32::from(u16::MAX >> (16 - coded.depth.clamp(8, 16))),
        samples: coded.samples,
        width: coded.width,
        height: coded.height,
        terms,
    })
}

/// Which reconstruction this file states, preferring the standard where it carries both.
///
/// **ISO first, because a file with both is Apple's own transition**: iOS 18 writes the ISO payload
/// and keeps the maker note tags, and the two do not describe the same curve - so reading the
/// maker note there would apply Apple's straight line to a map whose terms say otherwise.
fn terms_of(file: &[u8], exif: Option<&[u8]>) -> Option<Reconstruction> {
    // **The map's own segments first.** A file carrying the standard states it twice: the primary
    // gets the two version words alone, and the full payload rides with the map - so reading the
    // primary and stopping there finds a stub that parses as nothing.
    let iso = second_image(file)
        .and_then(iso_segment)
        .or_else(|| iso_segment(file))
        .and_then(crate::decode_rendered::iso_21496_terms);
    if let Some(iso) = iso {
        return Some(iso);
    }
    let headroom = crate::apple_gain::headroom(exif?)?;
    match headroom > 1.0 {
        true => Some(Reconstruction::Apple { headroom }),
        false => None,
    }
}

const SOI: u8 = 0xD8;
const EOI: u8 = 0xD9;
const SOS: u8 = 0xDA;
const APP2: u8 = 0xE2;

const ISO_URN: &[u8] = b"urn:iso:std:iso:ts:21496:-1\0";
const MPF_TAG: &[u8] = b"MPF\0";

/// Every marker segment's `(marker, body)`, stopping where the entropy-coded data begins.
///
/// **Stops at `SOS` deliberately.** Past the first scan the bytes are compressed data with stuffed
/// `FF`s in it, and walking those as markers finds segment lengths that are whatever the picture
/// happened to encode - which is how a walker runs off the end of a perfectly good file.
fn segments(file: &[u8]) -> Vec<Segment<'_>> {
    let mut out = Vec::new();
    let mut at = 2;
    while at + 4 <= file.len() {
        if file[at] != 0xFF {
            break;
        }
        let marker = file[at + 1];
        if marker == SOS || marker == EOI {
            break;
        }
        let length = usize::from(u16::from_be_bytes([file[at + 2], file[at + 3]]));
        if length < 2 || at + 2 + length > file.len() {
            break;
        }
        out.push(Segment { marker, at: at + 4, body: &file[at + 4..at + 2 + length] });
        at += 2 + length;
    }
    out
}

/// One marker segment, with where in the file its body begins - which MPF's offsets are stated
/// against and nothing else here needs.
struct Segment<'a> {
    marker: u8,
    at: usize,
    body: &'a [u8],
}

/// The ISO 21496-1 payload, out of the `APP2` segment that names it.
fn iso_segment(file: &[u8]) -> Option<&[u8]> {
    segments(file)
        .into_iter()
        .find(|it| it.marker == APP2 && it.body.starts_with(ISO_URN))
        .map(|it| &it.body[ISO_URN.len()..])
}

/// The second MPF image's bytes, which is where every writer puts the map.
///
/// MPF's offsets are from the end of the `MPF\0` tag's four bytes rather than from the file's
/// start, which is the one thing about this format that a reader gets wrong once.
fn second_image(file: &[u8]) -> Option<&[u8]> {
    let segment =
        segments(file).into_iter().find(|it| it.marker == APP2 && it.body.starts_with(MPF_TAG))?;
    let tiff = segment.body.get(MPF_TAG.len()..)?;
    // The offsets an entry states are relative to this point: the byte after `MPF\0`.
    let base = segment.at + MPF_TAG.len();

    let big = match tiff.get(0..2)? {
        b"MM" => true,
        b"II" => false,
        _ => return None,
    };
    let word = |at: usize| -> Option<u32> {
        let b: [u8; 4] = tiff.get(at..at + 4)?.try_into().ok()?;
        Some(match big {
            true => u32::from_be_bytes(b),
            false => u32::from_le_bytes(b),
        })
    };
    let short = |at: usize| -> Option<u16> {
        let b: [u8; 2] = tiff.get(at..at + 2)?.try_into().ok()?;
        Some(match big {
            true => u16::from_be_bytes(b),
            false => u16::from_le_bytes(b),
        })
    };

    let ifd_at = word(4)? as usize;
    let count = short(ifd_at)?;
    // `MPEntry`, tag 0xB002: a run of sixteen-byte records, one per image in the file.
    let mut entries_at = None;
    for index in 0..usize::from(count) {
        let at = ifd_at + 2 + index * 12;
        if short(at)? == 0xB002 {
            entries_at = Some(word(at + 8)? as usize);
        }
    }
    let entries_at = entries_at?;
    // The first record is the primary picture, whose offset is stated as zero; the second is the
    // map. A file with one image has nothing here and is not an error.
    let second = entries_at + 16;
    let size = word(second + 4)? as usize;
    let offset = word(second + 8)? as usize;
    if size == 0 || offset == 0 {
        return None;
    }
    let from = base.checked_add(offset)?;
    let to = from.checked_add(size)?;
    let bytes = file.get(from..to)?;
    bytes.starts_with(&[0xFF, SOI]).then_some(bytes)
}

/// The map's own JPEG, which is monochrome in every file that writes one.
fn decode(bytes: &[u8]) -> Option<crate::hevc::Coded> {
    let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(bytes));
    let pixels = decoder.decode().ok()?;
    let info = decoder.info()?;
    let channels = match info.pixel_format {
        jpeg_decoder::PixelFormat::L8 => 1,
        jpeg_decoder::PixelFormat::RGB24 => 3,
        _ => return None,
    };
    let (width, height) = (usize::from(info.width), usize::from(info.height));
    Some(crate::hevc::Coded {
        samples: crate::decode_rendered::interleaved(&pixels, width * height, channels),
        width,
        height,
        depth: 8,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A JPEG with no MPF index has no second image, which is most JPEGs and not an error.
    #[test]
    fn a_plain_jpeg_carries_no_map() {
        let file = [0xFF, SOI, 0xFF, SOS];
        assert!(second_image(&file).is_none());
        assert!(read(&file, None).is_none());
    }

    /// Bytes out of somebody's file: every truncation of a well-formed header is a photograph
    /// without a gain map rather than a panic.
    #[test]
    fn a_truncated_mpf_index_is_declined_rather_than_read_past() {
        let mut body = MPF_TAG.to_vec();
        body.extend_from_slice(b"MM\0\x2a");
        body.extend_from_slice(&8u32.to_be_bytes());
        body.extend_from_slice(&1u16.to_be_bytes());
        body.extend_from_slice(&0xB002u16.to_be_bytes());
        body.extend_from_slice(&7u16.to_be_bytes());
        body.extend_from_slice(&32u32.to_be_bytes());
        body.extend_from_slice(&64u32.to_be_bytes());
        for length in 0..body.len() {
            let mut file = vec![0xFF, SOI, 0xFF, APP2];
            let segment = &body[..length];
            file.extend_from_slice(&((segment.len() + 2) as u16).to_be_bytes());
            file.extend_from_slice(segment);
            file.extend_from_slice(&[0xFF, SOS]);
            assert!(second_image(&file).is_none(), "read {length} bytes of an index");
        }
    }

    /// The walk stops at the scan, so compressed bytes that look like markers are never followed.
    #[test]
    fn the_segment_walk_stops_where_the_picture_starts() {
        let file = [0xFF, SOI, 0xFF, SOS, 0xFF, APP2, 0xFF, 0xFF, 0xFF, 0xFF];
        assert!(segments(&file).is_empty());
    }
}
