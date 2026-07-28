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
// spline meant handing JavaScript the entire RAW, 60-120MB per photo, for one tag.
// The caller now reads a bounded head of the file instead (`ffi.rs`), which is not
// as small as it sounds: the tag is early but its data is not.
//
// Only Sony is implemented, and a CR3 is not a TIFF at all, so Canon falls through
// to `None` and the caller fits the geometry instead. That is the same path 14 of
// 20 Sony bodies take, and it costs nothing measurable here: across 27 EOS R8
// frames every fit is accepted, at a median deltaE of 1.89 against 1.35 for a Sony
// set of the same size. Reading Canon's own correction out of the `CMT3` makernote
// would be reverse engineering for a residual that is already below the threshold.

/// Whether the body corrected its own preview, beside the spline it recorded for
/// the lens. Sony writes the SubIFD as flag/params pairs - 0x7031/0x7032 for
/// vignetting, 0x7034/0x7035 for chromatic aberration, these two for distortion.
const CORRECTION_TAG: u16 = 0x7036;
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

/// 0 is the body saying it corrected nothing, so its preview needs nothing undone.
/// The "on" value is not a single constant - 1 and 17 both appear across bodies -
/// so anything non-zero counts as on rather than matching a list that would go
/// stale on the next model.
fn find_correction(reader: &Reader<'_>, entries: &[Entry]) -> Option<bool> {
    entries
        .iter()
        .find(|entry| entry.tag == CORRECTION_TAG && entry.kind == TYPE_SHORT && entry.count == 1)
        .and_then(|entry| reader.u16(entry.start))
        .map(|value| value != 0)
}

/// What the file says about distortion.
pub struct Distortion {
    /// Whether the camera applied its correction to the preview this render is
    /// matched against. None when the file states nothing, which is every format
    /// but Sony's.
    pub applied: Option<bool>,
    /// Radial knots, centre to corner, in `SPLINE_UNIT`s. None when the file
    /// records none, which is most bodies older than about 2012.
    pub spline: Option<Vec<f64>>,
}

impl Distortion {
    fn nothing() -> Distortion {
        Distortion { applied: None, spline: None }
    }
}

/// Both tags, in one walk of the SubIFDs, since they sit side by side.
pub fn read_distortion(bytes: &[u8]) -> Distortion {
    let little = match bytes.get(..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return Distortion::nothing(),
    };
    let reader = Reader { bytes, little };
    let Some(ifd0) = reader.u32(4) else { return Distortion::nothing() };

    let mut out = Distortion::nothing();
    for entry in read_ifd(&reader, ifd0 as usize) {
        if entry.tag != SUBIFD_TAG || entry.kind != TYPE_LONG {
            continue;
        }
        for k in 0..entry.count as usize {
            let Some(offset) = reader.u32(entry.start + k * 4) else { break };
            let entries = read_ifd(&reader, offset as usize);
            if out.applied.is_none() {
                out.applied = find_correction(&reader, &entries);
            }
            if out.spline.is_none() {
                out.spline = find_spline(&reader, &entries);
            }
            if out.applied.is_some() && out.spline.is_some() {
                return out;
            }
        }
    }
    out
}

/// The spline alone, whatever the correction flag says. For the tests, which check
/// the parser rather than the decision made from it.
pub fn read_distortion_spline(bytes: &[u8]) -> Option<Vec<f64>> {
    read_distortion(bytes).spline
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A little-endian TIFF with one SubIFD holding a distortion tag.
    fn synthetic(knots: &[i16]) -> Vec<u8> {
        with_correction(knots, None)
    }

    /// The same, optionally carrying the correction flag beside the spline.
    fn with_correction(knots: &[i16], flag: Option<u16>) -> Vec<u8> {
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

        // SubIFD: the distortion spline pointing at 128, and the flag inline
        // before it where the file carries one.
        bytes[64..66].copy_from_slice(&(if flag.is_some() { 2u16 } else { 1u16 }).to_le_bytes());
        if let Some(value) = flag {
            bytes[66..68].copy_from_slice(&CORRECTION_TAG.to_le_bytes());
            bytes[68..70].copy_from_slice(&TYPE_SHORT.to_le_bytes());
            bytes[70..74].copy_from_slice(&1u32.to_le_bytes());
            bytes[74..78].copy_from_slice(&u32::from(value).to_le_bytes());
        }
        let spline = if flag.is_some() { 78 } else { 66 };
        bytes[spline..spline + 2].copy_from_slice(&DISTORTION_TAG.to_le_bytes());
        bytes[spline + 2..spline + 4].copy_from_slice(&TYPE_SSHORT.to_le_bytes());
        bytes[spline + 4..spline + 8].copy_from_slice(&((knots.len() + 1) as u32).to_le_bytes());
        bytes[spline + 8..spline + 12].copy_from_slice(&128u32.to_le_bytes());

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
    fn reads_whether_the_body_corrected_its_own_preview() {
        // 0 is off. The on value is not one constant - 1 and 17 both appear across
        // bodies - so anything non-zero has to read as on.
        assert_eq!(read_distortion(&with_correction(&[0, -120], Some(0))).applied, Some(false));
        assert_eq!(read_distortion(&with_correction(&[0, -120], Some(1))).applied, Some(true));
        assert_eq!(read_distortion(&with_correction(&[0, -120], Some(17))).applied, Some(true));
    }

    #[test]
    fn states_nothing_when_the_file_carries_no_flag() {
        // Every format but Sony's, which must go on being fitted rather than being
        // read as "the camera corrected nothing".
        assert_eq!(read_distortion(&synthetic(&[0, -120, -400])).applied, None);
    }

    #[test]
    fn the_flag_does_not_disturb_the_spline_beside_it() {
        let found = read_distortion(&with_correction(&[0, -120, -400], Some(0)));
        assert_eq!(found.applied, Some(false));
        assert_eq!(found.spline, Some(vec![0.0, -120.0, -400.0]), "the knots are still read when the flag says off");
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
