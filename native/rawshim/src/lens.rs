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
// set of the same size.
//
// There is no Canon equivalent to reach for. The `CMT3` makernote carries lens
// identity and the shot's characteristics - markers and IDs - and not the correction
// itself, which lives in Canon's own software rather than in the file.

/// Whether the body corrected its own preview, beside the spline it recorded for
/// the lens. Sony writes the SubIFD as flag/params pairs - 0x7031/0x7032 for
/// vignetting, 0x7034/0x7035 for chromatic aberration, these two for distortion.
const CORRECTION_TAG: u16 = 0x7036;
const DISTORTION_TAG: u16 = 0x7037;
const LATERAL_TAG: u16 = 0x7035;

/// The lateral tag holds both channels back to back, so its declared count is twice a
/// distortion spline's.
const LATERAL_KNOTS: usize = 16;

/// What the lateral values are stored in, as a divisor of `SPLINE_UNIT`.
///
/// The full factor is `1 + c * 2^-21`, and `spline_at` already divides by `SPLINE_UNIT`
/// (2^14), so what is left here is 2^7. The sign is positive and means what our warp
/// means by it: a positive coefficient reads the channel farther out, which shrinks it,
/// because a positive coefficient records a channel that was magnified in the raw.
///
/// Sony documents none of this. The constant comes from a decompile of Imaging Edge
/// Desktop, cross-checked against darktable's shipping implementation, which computes
/// `cor_rgb[0][i] *= ca_r[i] * 2^-21 + 1` on knots read as `posc[i + 1]` and
/// `posc[nc + i + 1]` - two blocks of sixteen, red first. The knots are evenly spaced in
/// radius from the centre to the corner, which is what `spline_at` assumes.
///
/// **Two earlier readings were wrong and are worth not repeating.** A correlation of the
/// tag's raw corner value against the aberration measured off the same frames once stood
/// at +0.85 and +0.78 and justified nothing: consecutive frames of one shoot carry
/// byte-identical tags while the measured aberration on them varies, so a near-constant
/// regressor was being credited with tracking a varying target. Then the blocks were
/// rebased against their own first knot, on the reasoning that a lateral aberration
/// vanishes on axis. It does, but these are not displacements - they are the knots of a
/// magnification, and a channel imaged larger is larger everywhere. Rebasing threw away
/// the uniform term and left the curve a factor of the radius out, which measured as a
/// displacement that was flat with radius where the model wanted one growing with it.
const LATERAL_UNIT: f64 = 128.0;
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

/// Records the furthest byte a pointer led to that the buffer did not hold.
fn want(needed: &mut Option<usize>, upto: usize) {
    *needed = Some(needed.map_or(upto, |far| far.max(upto)));
}

fn read_ifd(reader: &Reader<'_>, offset: usize, needed: &mut Option<usize>) -> Vec<Entry> {
    let Some(count) = reader.u16(offset) else {
        want(needed, offset + 2);
        return Vec::new();
    };
    if count == 0 || count > MAX_IFD_ENTRIES {
        return Vec::new();
    }
    let end = offset + 2 + count as usize * 12 + 4;
    if end > reader.bytes.len() {
        want(needed, end);
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

fn find_spline(reader: &Reader<'_>, entries: &[Entry], needed: &mut Option<usize>) -> Option<Vec<f64>> {
    for entry in entries {
        if entry.tag != DISTORTION_TAG || (entry.kind != TYPE_SSHORT && entry.kind != TYPE_SHORT) {
            continue;
        }
        if entry.count < 2 {
            continue;
        }
        let end = entry.start + entry.count as usize * 2;
        if end > reader.bytes.len() {
            want(needed, end);
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

/// Red and blue's lateral curves, in `SPLINE_UNIT`s, from the pair the body recorded.
///
/// Same shape as the distortion tag beside it: a count prefix then that many SSHORTs,
/// except the count is 32 because both channels are stored back to back - red first,
/// then blue. The two blocks routinely carry opposite signs, which is what a lateral
/// aberration does.
fn find_lateral(reader: &Reader<'_>, entries: &[Entry], needed: &mut Option<usize>) -> Option<[Vec<f64>; 2]> {
    for entry in entries {
        if entry.tag != LATERAL_TAG || (entry.kind != TYPE_SSHORT && entry.kind != TYPE_SHORT) {
            continue;
        }
        let wanted = LATERAL_KNOTS * 2;
        if entry.count as usize <= wanted {
            continue;
        }
        let end = entry.start + entry.count as usize * 2;
        if end > reader.bytes.len() {
            want(needed, end);
            continue;
        }
        let declared = reader.i16(entry.start)?;
        if declared as usize != wanted {
            continue;
        }
        // **Absolute, not rebased.** These are the knots of a multiplicative radial factor
        // and the first one is not meant to be zero: a channel imaged larger is larger
        // everywhere, so a non-zero value on axis is a genuine uniform magnification
        // difference rather than an offset to remove. Subtracting it, which an earlier
        // version did on the reasoning that a lateral aberration vanishes on axis, throws
        // away that term and leaves the curve a factor of the radius out.
        let read = |from: usize| -> Option<Vec<f64>> {
            (0..LATERAL_KNOTS)
                .map(|i| {
                    reader.i16(entry.start + (from + i) * 2).map(|v| f64::from(v) / LATERAL_UNIT)
                })
                .collect()
        };
        let (red, blue) = (read(1)?, read(1 + LATERAL_KNOTS)?);
        // A lateral aberration is a fraction of a percent, and at this unit an `i16` can
        // express 1.6% - so a misread of the layout can produce a number that is not a
        // lens, and returning it would leave the caller to discover that. `tca::accept`
        // would also reject it, but a reader that hands back garbage is worse than one
        // that admits it found none.
        let sane = |knots: &Vec<f64>| {
            knots.iter().all(|knot| (knot / crate::image::SPLINE_UNIT).abs() < 0.01)
        };
        if !sane(&red) || !sane(&blue) {
            continue;
        }
        return Some([red, blue]);
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
    /// Red and blue's lateral curves against green, from the pair beside the spline.
    pub lateral: Option<[Vec<f64>; 2]>,
    /// The furthest byte the walk wanted and these bytes did not hold, or None where it
    /// followed every pointer it met. None is what says a larger buffer cannot answer
    /// differently, so what was found here is what the file records.
    pub needed: Option<usize>,
}

impl Distortion {
    fn nothing() -> Distortion {
        Distortion { applied: None, spline: None, lateral: None, needed: None }
    }
}

/// Whether these bytes open as a TIFF, and little-endian if they do.
///
/// The mark is at offset 0, which is what makes this answerable from any window of the file's
/// front: a buffer without it is not a buffer that was cut too short.
pub fn byte_order(bytes: &[u8]) -> Option<bool> {
    match bytes.get(..2) {
        Some(b"II") => Some(true),
        Some(b"MM") => Some(false),
        _ => None,
    }
}

/// Both tags, in one walk of the SubIFDs, since they sit side by side.
pub fn read_distortion(bytes: &[u8]) -> Distortion {
    let mut out = Distortion::nothing();
    let Some(little) = byte_order(bytes) else { return out };
    let reader = Reader { bytes, little };
    let mut needed = None;
    let Some(ifd0) = reader.u32(4) else {
        out.needed = Some(8);
        return out;
    };

    let top = read_ifd(&reader, ifd0 as usize, &mut needed);
    'walk: for entry in top {
        if entry.tag != SUBIFD_TAG || entry.kind != TYPE_LONG {
            continue;
        }
        // A tag naming one SubIFD holds its offset inside the entry; naming two or more, it
        // holds a pointer to the offsets, which is itself somewhere in the file and can be
        // somewhere this buffer does not reach. Capped like an IFD's own entries, since the
        // count is four bytes read off the file and a corrupt one would otherwise walk the
        // whole buffer four bytes at a time.
        for k in 0..(entry.count as usize).min(MAX_IFD_ENTRIES as usize) {
            let at = entry.start + k * 4;
            let Some(offset) = reader.u32(at) else {
                // Not "there are no more SubIFDs": the addresses of the rest are past the end,
                // and `needed` is what tells the reader to come back with more of the file.
                want(&mut needed, at + 4);
                break;
            };
            let entries = read_ifd(&reader, offset as usize, &mut needed);
            if out.applied.is_none() {
                out.applied = find_correction(&reader, &entries);
            }
            if out.spline.is_none() {
                out.spline = find_spline(&reader, &entries, &mut needed);
            }
            if out.lateral.is_none() {
                out.lateral = find_lateral(&reader, &entries, &mut needed);
            }
            if out.applied.is_some() && out.spline.is_some() && out.lateral.is_some() {
                break 'walk;
            }
        }
    }
    out.needed = needed;
    out
}

/// Every entry in the SubIFDs, as tag/type/count/first-values. For working out what an
/// undocumented tag actually holds.
#[cfg(all(test, feature = "fixtures"))]
pub fn _for_testing_subifd(bytes: &[u8], wanted: u16) -> Option<(u16, u32, Vec<i32>)> {
    let reader = Reader { bytes, little: byte_order(bytes)? };
    let ifd0 = reader.u32(4)?;
    // This one is handed whole files, so how far a pointer reached is nobody's question.
    let reach = &mut None;
    let top = read_ifd(&reader, ifd0 as usize, reach);
    for entry in top {
        if entry.tag != SUBIFD_TAG || entry.kind != TYPE_LONG {
            continue;
        }
        for k in 0..entry.count as usize {
            let Some(offset) = reader.u32(entry.start + k * 4) else { break };
            for found in read_ifd(&reader, offset as usize, reach) {
                if found.tag != wanted {
                    continue;
                }
                let unit = type_size(found.kind)?;
                if found.start + (found.count * unit) as usize > bytes.len() {
                    continue;
                }
                let values = (0..found.count as usize)
                    .filter_map(|i| match found.kind {
                        TYPE_SSHORT => reader.i16(found.start + i * 2).map(i32::from),
                        TYPE_SHORT => reader.u16(found.start + i * 2).map(i32::from),
                        TYPE_LONG => reader.u32(found.start + i * 4).map(|v| v as i32),
                        _ => reader.bytes.get(found.start + i).map(|v| i32::from(*v)),
                    })
                    .collect();
                return Some((found.kind, found.count, values));
            }
        }
    }
    None
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

    /// A TIFF whose SubIFD tag names two of them, so the offsets are a block the tag points
    /// at rather than a value inside it - the shape a body writing more than one SubIFD
    /// produces, and the one where the addresses themselves can be out of reach.
    fn two_subifds(offsets_at: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; 512];
        bytes[..2].copy_from_slice(b"II");
        bytes[2..4].copy_from_slice(&42u16.to_le_bytes());
        bytes[4..8].copy_from_slice(&8u32.to_le_bytes());

        bytes[8..10].copy_from_slice(&1u16.to_le_bytes());
        bytes[10..12].copy_from_slice(&SUBIFD_TAG.to_le_bytes());
        bytes[12..14].copy_from_slice(&TYPE_LONG.to_le_bytes());
        bytes[14..18].copy_from_slice(&2u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&(offsets_at as u32).to_le_bytes());

        // The first SubIFD sits before the offsets and carries only the flag, so a buffer cut
        // just past them can read it whole and the furthest thing wanted is the second offset.
        bytes[offsets_at..offsets_at + 4].copy_from_slice(&100u32.to_le_bytes());
        bytes[offsets_at + 4..offsets_at + 8].copy_from_slice(&256u32.to_le_bytes());
        bytes[100..102].copy_from_slice(&1u16.to_le_bytes());
        bytes[102..104].copy_from_slice(&CORRECTION_TAG.to_le_bytes());
        bytes[104..106].copy_from_slice(&TYPE_SHORT.to_le_bytes());
        bytes[106..110].copy_from_slice(&1u32.to_le_bytes());
        bytes[110..114].copy_from_slice(&0u32.to_le_bytes());

        // The second holds the spline, at 320.
        bytes[256..258].copy_from_slice(&1u16.to_le_bytes());
        bytes[258..260].copy_from_slice(&DISTORTION_TAG.to_le_bytes());
        bytes[260..262].copy_from_slice(&TYPE_SSHORT.to_le_bytes());
        bytes[262..266].copy_from_slice(&4u32.to_le_bytes());
        bytes[266..270].copy_from_slice(&320u32.to_le_bytes());
        bytes[320..322].copy_from_slice(&3i16.to_le_bytes());
        for (i, knot) in [0i16, -120, -400].iter().enumerate() {
            bytes[322 + i * 2..324 + i * 2].copy_from_slice(&knot.to_le_bytes());
        }
        bytes
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

    /// A SubIFD carrying only the lateral pair: a count prefix of 32, then 16 red knots
    /// and 16 blue, which is the layout the Japan shoot's files revealed.
    fn with_lateral(red: &[i16; 16], blue: &[i16; 16]) -> Vec<u8> {
        let mut bytes = vec![0u8; 512];
        bytes[..2].copy_from_slice(b"II");
        bytes[2..4].copy_from_slice(&42u16.to_le_bytes());
        bytes[4..8].copy_from_slice(&8u32.to_le_bytes());

        bytes[8..10].copy_from_slice(&1u16.to_le_bytes());
        bytes[10..12].copy_from_slice(&SUBIFD_TAG.to_le_bytes());
        bytes[12..14].copy_from_slice(&TYPE_LONG.to_le_bytes());
        bytes[14..18].copy_from_slice(&1u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&64u32.to_le_bytes());

        bytes[64..66].copy_from_slice(&1u16.to_le_bytes());
        bytes[66..68].copy_from_slice(&LATERAL_TAG.to_le_bytes());
        bytes[68..70].copy_from_slice(&TYPE_SSHORT.to_le_bytes());
        bytes[70..74].copy_from_slice(&33u32.to_le_bytes());
        bytes[74..78].copy_from_slice(&128u32.to_le_bytes());

        bytes[128..130].copy_from_slice(&32i16.to_le_bytes());
        for (i, value) in red.iter().chain(blue.iter()).enumerate() {
            let at = 130 + i * 2;
            bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    /// A block that grows from a non-zero baseline, which is what the files carry: the
    /// values are relative to the centre knot, so only the growth is the aberration.
    fn ramp(base: i16, step: i16) -> [i16; 16] {
        let mut block = [0i16; 16];
        for (i, knot) in block.iter_mut().enumerate() {
            *knot = base + step * i as i16;
        }
        block
    }

    #[test]
    fn reads_the_lateral_pair_as_two_channels() {
        // Distinct blocks growing opposite ways, which is both what the files carry and
        // what would go unnoticed if the split were off by one.
        let (red, blue) = (ramp(1152, -64), ramp(-256, 32));
        let [found_red, found_blue] =
            read_distortion(&with_lateral(&red, &blue)).lateral.expect("a lateral pair");

        assert_eq!(found_red.len(), 16);
        assert_eq!(found_blue.len(), 16);
        // Absolute, so the centre knot survives: 1152 and -256 over a unit of 128.
        assert!((found_red[0] - 9.0).abs() < 1e-9, "red centre {}", found_red[0]);
        assert!((found_blue[0] + 2.0).abs() < 1e-9, "blue centre {}", found_blue[0]);
        // And 15 steps of -64 and +32 from there.
        assert!((found_red[15] - 1.5).abs() < 1e-9, "red corner {}", found_red[15]);
        assert!((found_blue[15] - 1.75).abs() < 1e-9, "blue corner {}", found_blue[15]);
    }

    #[test]
    fn a_constant_pair_is_a_uniform_magnification_difference() {
        // Not "no correction". These are the knots of a multiplicative factor, so a block
        // that does not vary with radius says the channel is imaged larger by the same
        // amount everywhere - which is a real aberration and a correctable one. An
        // earlier version rebased each block against its own first knot and turned
        // exactly this case into nothing at all.
        let [red, blue] = read_distortion(&with_lateral(&[1152; 16], &[-256; 16])).lateral.expect("a pair");
        assert!(red.iter().all(|knot| (knot - 9.0).abs() < 1e-9), "constant red became {red:?}");
        assert!(blue.iter().all(|knot| (knot + 2.0).abs() < 1e-9), "constant blue became {blue:?}");
    }

    #[test]
    fn refuses_a_lateral_pair_too_large_to_be_an_aberration() {
        // At this unit an `i16` reaches 1.6% of a radial scale, well past any lens, so
        // the guard is reachable and worth having: a misread layout is the case it exists
        // for. Checked with a value the tag really can hold rather than a synthetic one.
        let absurd = [i16::MAX; 16];
        assert!(read_distortion(&with_lateral(&absurd, &[0; 16])).lateral.is_none());
        // And an ordinary block still reads, so the bound is not simply refusing
        // everything.
        assert!(read_distortion(&with_lateral(&[1152; 16], &[-256; 16])).lateral.is_some());
    }

    #[test]
    fn reads_no_lateral_pair_where_the_file_records_none() {
        // The distortion-only synthetic: its SubIFD carries a spline and no pair.
        assert!(read_distortion(&synthetic(&[0, -120, -400])).lateral.is_none());
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

    // What a caller reading the file a window at a time decides on: `needed` says whether a
    // larger buffer could answer differently, so "no spline" and "no spline yet" stop being the
    // same answer.
    #[test]
    fn a_walk_that_followed_every_pointer_asks_for_nothing_further() {
        let found = read_distortion(&synthetic(&[0, -120, -400]));
        assert_eq!(found.spline, Some(vec![0.0, -120.0, -400.0]));
        assert_eq!(found.needed, None, "every pointer was inside the buffer");
    }

    #[test]
    fn knots_past_the_buffer_report_where_they_end() {
        // The SubIFD sits at 64 and the knots it points at start at 128, so this holds the
        // entry and not its data - the case a wider read exists for.
        let found = read_distortion(&synthetic(&[0, -120, -400])[..100]);
        assert_eq!(found.spline, None);
        assert_eq!(found.needed, Some(136), "four SSHORTs from 128");
    }

    #[test]
    fn a_subifd_past_the_buffer_reports_where_it_ends() {
        let found = read_distortion(&synthetic(&[0, -120, -400])[..70]);
        assert_eq!(found.spline, None);
        assert_eq!(found.needed, Some(82), "one entry and the next-IFD pointer, from 64");
    }

    // The reader stops widening the moment a walk asks for nothing further, so a walk that
    // gave up without asking is a spline silently lost - which is the whole failure the
    // window's fallback exists to prevent.
    #[test]
    fn subifd_offsets_past_the_buffer_report_where_they_end() {
        let whole = two_subifds(200);
        assert_eq!(read_distortion(&whole).spline, Some(vec![0.0, -120.0, -400.0]), "whole, it reads");

        // Cut between the tag that names the SubIFDs and the offsets it points at.
        let found = read_distortion(&whole[..180]);
        assert_eq!(found.spline, None, "the offsets are out of reach");
        assert_eq!(found.needed, Some(204), "so it asks for the block holding them");
    }

    #[test]
    fn a_second_subifd_offset_past_the_buffer_is_still_asked_for() {
        // The first offset is readable and its SubIFD complete, so what the walk found is a
        // flag and no spline - and it has to say it was cut short rather than let that stand
        // as the whole answer.
        let found = read_distortion(&two_subifds(200)[..204]);
        assert_eq!(found.applied, Some(false), "the first SubIFD did read");
        assert_eq!(found.spline, None);
        assert_eq!(found.needed, Some(208), "the second offset is four bytes past the cut");
    }

    #[test]
    fn bytes_that_are_not_a_tiff_ask_for_nothing_further() {
        // A CR3 opens as an ISO base-media box, and the mark it fails on is at offset 0 - so
        // reading more of it cannot change this answer, however large the file is.
        assert_eq!(read_distortion(b"\0\0\0\x18ftypcrx ").needed, None);
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
