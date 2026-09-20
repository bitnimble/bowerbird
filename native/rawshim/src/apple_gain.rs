//! The headroom behind Apple's own gain map, out of the two maker note tags that state it.
//!
//! **Apple's, not a guess.** The reconstruction and this mapping are both written down - AppKit's
//! *Applying Apple HDR effect to your photos* gives the branches and the constants below, and the
//! `Reconstruction::Apple` arm of the kernel is the `hdr = sdr * (1 + (headroom - 1) * recovery)`
//! from the same page. What is undocumented is only what the two tags individually *mean*, which a
//! reader does not need: the pair goes in and a headroom comes out.
//!
//! Every iPhone from the 12 to the 15 writes this, iOS 14.1 through 17. iOS 18 writes ISO 21496-1
//! instead, and on the same hardware - so what reaches this module is a photograph taken before
//! that update rather than anything a current body produces.

/// Apple's two tags, in the `Apple iOS` maker note.
const HDR_HEADROOM: u16 = 0x0021;
const HDR_GAIN: u16 = 0x0030;

/// Apple's maker note signature, and the big-endian marker two bytes after it.
const SIGNATURE: &[u8] = b"Apple iOS\0";
const IFD_AT: usize = 14;

/// The linear headroom this photograph's gain map reaches, from the EXIF block it came with.
///
/// None where the file is not Apple's, or carries neither tag: the map is then a picture whose
/// brightness nothing states, and the base image is what a reader is shown.
pub fn headroom(tiff: &[u8]) -> Option<f32> {
    let maker = maker_note(tiff)?;
    let entries = ifd_entries(&maker);
    // The pair is meaningless apart, so a file with one and not the other is declined rather than
    // half-read: `stops` branches on both, and a default for either is a made-up exposure.
    let gain = entries.iter().find(|(tag, _)| *tag == HDR_GAIN)?.1;
    let ceiling = entries.iter().find(|(tag, _)| *tag == HDR_HEADROOM)?.1;
    Some(2f64.powf(stops(ceiling, gain).max(0.0)) as f32)
}

/// AppKit's own mapping from the two tags to stops of headroom.
fn stops(maker33: f64, maker48: f64) -> f64 {
    match (maker33 < 1.0, maker48 <= 0.01) {
        (true, true) => -20.0 * maker48 + 1.8,
        (true, false) => -0.101 * maker48 + 1.601,
        (false, true) => -70.0 * maker48 + 3.0,
        (false, false) => -0.303 * maker48 + 2.303,
    }
}

/// The `Apple iOS` maker note's own bytes, out of the EXIF IFD.
fn maker_note(tiff: &[u8]) -> Option<Vec<u8>> {
    use rawler::formats::tiff::reader::TiffReader;
    let reader =
        rawler::formats::tiff::reader::GenericTiffReader::new_with_buffer(tiff, 0, 0, None).ok()?;
    let exif = reader.root_ifd().get_sub_ifd(0x8769u16)?;
    let bytes = match &exif.get_entry(0x927Cu16)?.value {
        rawler::formats::tiff::Value::Undefined(bytes) => bytes,
        rawler::formats::tiff::Value::Byte(bytes) => bytes,
        _ => return None,
    };
    bytes.starts_with(SIGNATURE).then(|| bytes.clone())
}

/// Every `(tag, value)` of the maker note's IFD, as far as it parses.
///
/// **Hand-read rather than handed back to the TIFF reader**, because this IFD is not a TIFF: it has
/// no header, its byte order is fixed big-endian by the two bytes after the signature, and its
/// value offsets are relative to the maker note's own start rather than to the file's. Pointing a
/// general reader at it reads whatever happens to sit at those offsets in the outer file.
///
/// Every read is bounds-checked, for `icc_curve`'s reason: these are bytes out of somebody's photo,
/// and a truncated maker note must be a photograph without a gain map rather than a panic that
/// takes the rendition worker - or, in the browser, the tab.
fn ifd_entries(maker: &[u8]) -> Vec<(u16, f64)> {
    let be16 = |at: usize| -> Option<u16> {
        maker.get(at..at + 2).map(|b| u16::from_be_bytes([b[0], b[1]]))
    };
    let be32 = |at: usize| -> Option<u32> {
        maker.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    };

    let mut out = Vec::new();
    let Some(count) = be16(IFD_AT) else { return out };
    for index in 0..usize::from(count) {
        let at = IFD_AT + 2 + index * 12;
        let (Some(tag), Some(kind), Some(payload)) = (be16(at), be16(at + 2), be32(at + 8)) else {
            break;
        };
        if tag != HDR_HEADROOM && tag != HDR_GAIN {
            continue;
        }
        // The four value bytes are the value itself where it fits and an offset into the maker note
        // where it does not, which for every type below the rationals it is.
        let value = match kind {
            // SHORT and LONG, which a tag set to a whole number takes.
            3 => Some(f64::from(payload >> 16)),
            4 => Some(f64::from(payload)),
            // RATIONAL and SRATIONAL, at the offset the four bytes hold.
            5 | 10 => {
                let at = payload as usize;
                match (be32(at), be32(at + 4)) {
                    (Some(_), Some(0)) => None,
                    (Some(numerator), Some(denominator)) => Some(match kind {
                        10 => f64::from(numerator as i32) / f64::from(denominator as i32),
                        _ => f64::from(numerator) / f64::from(denominator),
                    }),
                    _ => None,
                }
            }
            // FLOAT, which is what a current build actually writes these two as.
            11 => be32(at + 8).map(|bits| f64::from(f32::from_bits(bits))),
            12 => {
                let at = payload as usize;
                let bytes: Option<[u8; 8]> = maker.get(at..at + 8).and_then(|b| b.try_into().ok());
                bytes.map(|b| f64::from_be_bytes(b))
            }
            _ => None,
        };
        if let Some(value) = value.filter(|it| it.is_finite()) {
            out.push((tag, value));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The four branches, at Apple's own constants.
    ///
    /// **The pair is not monotonic in one tag alone**, which is why both are read: `maker48` at
    /// zero is the *most* headroom, and which of the two lines it lands on is `maker33`'s to say.
    #[test]
    fn the_stops_are_the_four_lines_apple_documents() {
        // maker33 below one: the shallower pair, at most 1.8 stops.
        assert!((stops(0.5, 0.0) - 1.8).abs() < 1e-9);
        assert!((stops(0.5, 0.01) - 1.6).abs() < 1e-9);
        assert!((stops(0.5, 1.0) - 1.5).abs() < 1e-9);
        // maker33 at one or above: the deeper pair, at most 3 stops, which is the 8x this
        // pipeline's own container is built for (`transfer::HDR_HEADROOM`).
        assert!((stops(1.0, 0.0) - 3.0).abs() < 1e-9);
        assert!((stops(1.0, 0.01) - 2.3).abs() < 1e-9);
        assert!((stops(1.0, 8.0) - (-0.121)).abs() < 1e-9);
    }

    /// A headroom is a multiplier and never less than one: the mapping's last line goes negative,
    /// and a gain map that darkened the picture is not what any of this means.
    #[test]
    fn the_headroom_is_never_below_one() {
        assert!((2f64.powf(stops(1.0, 8.0).max(0.0)) - 1.0).abs() < 1e-9);
        assert!((2f64.powf(stops(1.0, 0.0).max(0.0)) - 8.0).abs() < 1e-9);
    }

    /// Bytes out of somebody's file, so every shape of truncation is a photograph without a gain
    /// map rather than a panic.
    #[test]
    fn a_truncated_maker_note_is_declined_rather_than_read_past() {
        let mut maker = SIGNATURE.to_vec();
        maker.extend_from_slice(&[0x00, 0x01, b'M', b'M']);
        maker.extend_from_slice(&2u16.to_be_bytes());
        for length in 0..maker.len() {
            assert!(ifd_entries(&maker[..length]).is_empty(), "read {length} bytes of a header");
        }
        // A count of two with no entries behind it.
        assert!(ifd_entries(&maker).is_empty());
    }

    /// The two tags as a real file writes them: a rational each, at an offset inside the note.
    #[test]
    fn the_two_tags_are_read_as_the_rationals_a_file_writes() {
        let mut maker = SIGNATURE.to_vec();
        maker.extend_from_slice(&[0x00, 0x01, b'M', b'M']);
        maker.extend_from_slice(&2u16.to_be_bytes());
        // Two entries, then the two rationals they point at.
        let values_at = (IFD_AT + 2 + 2 * 12) as u32;
        for (index, tag) in [HDR_HEADROOM, HDR_GAIN].iter().enumerate() {
            maker.extend_from_slice(&tag.to_be_bytes());
            maker.extend_from_slice(&5u16.to_be_bytes());
            maker.extend_from_slice(&1u32.to_be_bytes());
            maker.extend_from_slice(&(values_at + index as u32 * 8).to_be_bytes());
        }
        // 1.0 and 0.0, which is the deepest arm: three stops.
        maker.extend_from_slice(&1u32.to_be_bytes());
        maker.extend_from_slice(&1u32.to_be_bytes());
        maker.extend_from_slice(&0u32.to_be_bytes());
        maker.extend_from_slice(&1u32.to_be_bytes());

        let entries = ifd_entries(&maker);
        assert_eq!(entries, vec![(HDR_HEADROOM, 1.0), (HDR_GAIN, 0.0)]);
        assert!((stops(entries[0].1, entries[1].1) - 3.0).abs() < 1e-9);
    }
}
