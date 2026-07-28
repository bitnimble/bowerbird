// The lens distortion correction the camera recorded for the shot it just took.
//
// Sony writes it into the RAW as a spline: IFD0 -> SubIFD (tag 0x014a) -> tag
// 0x7037, an SSHORT array whose first element is the number of knots that follow.
// The knots are evenly spaced from the frame centre to the corner and give the
// radial displacement in units of 1/16384 of the half-diagonal, anchored at zero
// in the centre. Plain TIFF parsing reaches all of it; none of Sony's enciphered
// 0x94xx blocks are involved.
//
// Ported from TypeScript so the fit takes a path rather than a file: reading the
// spline meant handing JavaScript the entire RAW - 60-120MB per photo - to find
// one tag in the first few kilobytes of it.
//
// Only Sony is implemented. Canon records an equivalent, but CR2/CR3 have not been
// checked against a real file, so they fall through to `None` and the caller fits
// the geometry instead.

const DISTORTION_TAG: u16 = 0x7037;
const SUBIFD_TAG: u16 = 0x014a;
const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;
const TYPE_SSHORT: u16 = 8;

/// A correction beyond this is not a lens profile, it is a misparse. The largest
/// seen on real files is the RX100M3's -10.5%.
const PLAUSIBLE_CORNER: f64 = 0.25;
const MAX_IFD_ENTRIES: u16 = 512;

struct Reader<'a> {
    bytes: &'a [u8],
    little: bool,
}

impl<'a> Reader<'a> {
    fn u16(&self, at: usize) -> Option<u16> {
        let raw = self.bytes.get(at..at + 2)?.try_into().ok()?;
        Some(if self.little { u16::from_le_bytes(raw) } else { u16::from_be_bytes(raw) })
    }

    fn i16(&self, at: usize) -> Option<i16> {
        self.u16(at).map(|value| value as i16)
    }

    fn u32(&self, at: usize) -> Option<u32> {
        let raw = self.bytes.get(at..at + 4)?.try_into().ok()?;
        Some(if self.little { u32::from_le_bytes(raw) } else { u32::from_be_bytes(raw) })
    }
}

struct Entry {
    tag: u16,
    kind: u16,
    count: u32,
    start: usize,
}

/// Bytes per TIFF type code. `None` for codes this does not know, which are
/// skipped rather than guessed at.
fn type_size(kind: u16) -> Option<u32> {
    match kind {
        1 | 2 | 6 | 7 => Some(1),
        3 | 8 => Some(2),
        4 | 9 | 11 => Some(4),
        5 | 10 | 12 => Some(8),
        _ => None,
    }
}

fn read_ifd(reader: &Reader<'_>, offset: usize) -> Vec<Entry> {
    let Some(count) = reader.u16(offset) else { return Vec::new() };
    if count == 0 || count > MAX_IFD_ENTRIES {
        return Vec::new();
    }
    if offset + 2 + count as usize * 12 + 4 > reader.bytes.len() {
        return Vec::new();
    }

    let mut entries = Vec::with_capacity(count as usize);
    for i in 0..count as usize {
        let at = offset + 2 + i * 12;
        let (Some(tag), Some(kind), Some(n)) = (reader.u16(at), reader.u16(at + 2), reader.u32(at + 4)) else {
            continue;
        };
        let Some(unit) = type_size(kind) else { continue };
        // A value of four bytes or fewer is stored in the entry, not pointed at.
        let start = match unit.saturating_mul(n) <= 4 {
            true => at + 8,
            false => match reader.u32(at + 8) {
                Some(pointer) => pointer as usize,
                None => continue,
            },
        };
        entries.push(Entry { tag, kind, count: n, start });
    }
    entries
}

fn find_spline(reader: &Reader<'_>, entries: &[Entry]) -> Option<Vec<f64>> {
    for entry in entries {
        if entry.tag != DISTORTION_TAG || (entry.kind != TYPE_SSHORT && entry.kind != TYPE_SHORT) {
            continue;
        }
        if entry.count < 2 || entry.start + entry.count as usize * 2 > reader.bytes.len() {
            continue;
        }

        // The count is per tag and per body, not a constant: the ILCE-7CR writes 16
        // knots and the ILCE-6300 writes 11, and within one RX100M3 file the
        // vignetting tag uses a different count from this one. Trust the prefix only
        // when it fits the tag it came from.
        let Some(declared) = reader.i16(entry.start) else { continue };
        if declared < 2 || declared as u32 > entry.count - 1 {
            continue;
        }

        let knots: Vec<f64> = (1..=declared as usize)
            .filter_map(|i| reader.i16(entry.start + i * 2).map(f64::from))
            .collect();
        if knots.len() != declared as usize {
            continue;
        }
        if (knots[knots.len() - 1] / crate::image::SPLINE_UNIT).abs() > PLAUSIBLE_CORNER {
            continue;
        }
        return Some(knots);
    }
    None
}

/// Radial distortion knots, centre to corner, in `SPLINE_UNIT`s. None when the
/// file records none, which is most bodies older than about 2012.
pub fn read_distortion_spline(bytes: &[u8]) -> Option<Vec<f64>> {
    let little = match bytes.get(..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let reader = Reader { bytes, little };

    for entry in read_ifd(&reader, reader.u32(4)? as usize) {
        if entry.tag != SUBIFD_TAG || entry.kind != TYPE_LONG {
            continue;
        }
        for k in 0..entry.count as usize {
            let Some(offset) = reader.u32(entry.start + k * 4) else { break };
            if let Some(knots) = find_spline(&reader, &read_ifd(&reader, offset as usize)) {
                return Some(knots);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A little-endian TIFF with one SubIFD holding a distortion tag.
    fn synthetic(knots: &[i16]) -> Vec<u8> {
        let mut bytes = vec![0u8; 512];
        bytes[..2].copy_from_slice(b"II");
        bytes[2..4].copy_from_slice(&42u16.to_le_bytes());
        bytes[4..8].copy_from_slice(&8u32.to_le_bytes()); // IFD0 at 8

        // IFD0: one entry, the SubIFD pointer.
        bytes[8..10].copy_from_slice(&1u16.to_le_bytes());
        bytes[10..12].copy_from_slice(&SUBIFD_TAG.to_le_bytes());
        bytes[12..14].copy_from_slice(&TYPE_LONG.to_le_bytes());
        bytes[14..18].copy_from_slice(&1u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&64u32.to_le_bytes()); // SubIFD at 64

        // SubIFD: one entry, the distortion spline, pointing at 128.
        bytes[64..66].copy_from_slice(&1u16.to_le_bytes());
        bytes[66..68].copy_from_slice(&DISTORTION_TAG.to_le_bytes());
        bytes[68..70].copy_from_slice(&TYPE_SSHORT.to_le_bytes());
        bytes[70..74].copy_from_slice(&((knots.len() + 1) as u32).to_le_bytes());
        bytes[74..78].copy_from_slice(&128u32.to_le_bytes());

        // The length prefix, then the knots.
        bytes[128..130].copy_from_slice(&(knots.len() as i16).to_le_bytes());
        for (i, knot) in knots.iter().enumerate() {
            let at = 130 + i * 2;
            bytes[at..at + 2].copy_from_slice(&knot.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn reads_a_spline_through_the_subifd() {
        let knots = read_distortion_spline(&synthetic(&[0, -120, -400, -740])).expect("a spline");
        assert_eq!(knots, vec![0.0, -120.0, -400.0, -740.0]);
    }

    #[test]
    fn honours_the_declared_count_rather_than_assuming_one() {
        // The count is per tag and per body: the ILCE-7CR writes 16 and the
        // ILCE-6300 writes 11, so a hardcoded length would misread one of them.
        for count in [2usize, 7, 11, 16] {
            let knots: Vec<i16> = (0..count).map(|i| -(i as i16) * 40).collect();
            let read = read_distortion_spline(&synthetic(&knots)).expect("a spline");
            assert_eq!(read.len(), count);
            assert_eq!(read[count - 1], f64::from(knots[count - 1]));
        }
    }

    #[test]
    fn is_none_when_the_body_recorded_no_correction() {
        // A well-formed SubIFD carrying some other tag: most bodies older than
        // about 2012, and the case the fitted fallback exists for.
        let mut bytes = synthetic(&[0, -120, -400]);
        bytes[66..68].copy_from_slice(&0x7032u16.to_le_bytes()); // vignetting, not distortion
        assert!(read_distortion_spline(&bytes).is_none());
    }

    #[test]
    fn refuses_bytes_that_are_not_tiff() {
        assert!(read_distortion_spline(b"not a raw file at all").is_none());
        assert!(read_distortion_spline(&[]).is_none());
        assert!(read_distortion_spline(&[0xFF, 0xD8, 0xFF, 0xE0]).is_none());
    }

    #[test]
    fn refuses_a_correction_too_large_to_be_a_lens() {
        // 0.5 of the half-diagonal is a misparse, not a lens. Accepting it would
        // hand the fit a wildly wrong geometry that it would then rank as best.
        let absurd = (0.5 * crate::image::SPLINE_UNIT) as i16;
        assert!(read_distortion_spline(&synthetic(&[0, 100, absurd])).is_none());
    }

    #[test]
    fn refuses_a_prefix_that_does_not_fit_its_own_tag() {
        // A count claiming more knots than the tag holds is the failure mode that
        // matters: it would read whatever follows the tag as spline data.
        let mut bytes = synthetic(&[0, -120, -400]);
        bytes[128..130].copy_from_slice(&99i16.to_le_bytes());
        assert!(read_distortion_spline(&bytes).is_none());
    }

    #[test]
    fn survives_a_pointer_past_the_end_of_the_file() {
        let mut bytes = synthetic(&[0, -120, -400]);
        bytes[74..78].copy_from_slice(&100_000u32.to_le_bytes());
        assert!(read_distortion_spline(&bytes).is_none());
    }
}
