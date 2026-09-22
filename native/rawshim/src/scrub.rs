//! The file a bug report can carry: everything the camera recorded about itself, and nothing
//! that records who held it or where they stood.
//!
//! **Nothing here moves a byte.** Every value is blanked where it lies and every length stays
//! what it was, because a RAW is a web of absolute offsets - IFD pointers, strip offsets, a
//! maker note whose own sub-directory is addressed from the start of the file - and any of them
//! would be left pointing at the wrong place by an edit that shortened a string. The file that
//! comes out is the same size as the file that went in and opens in the same decoders.
//!
//! **A format this cannot recognise is refused rather than passed through.** A scrubber that
//! silently hands back what it was given is worse than no scrubber, since the reader has been
//! told the file was cleaned.

use std::collections::HashSet;

/// Tags whose values name somebody, somewhere, or one particular camera.
///
/// What is deliberately *not* here is the record of the photograph itself: the make and model,
/// the lens, the exposure, the date, and the maker notes, which is the half of a RAW's metadata
/// a bug report is worth reading for.
///
/// **The maker note is kept, and Nikon, Canon and Sony all write a body serial into theirs**, so
/// the serials below go from where EXIF standardised them and not from the vendor's own block.
/// Reading that block means a parser per vendor per generation, and getting one wrong corrupts
/// the file rather than failing. What is promised is the standard tags, not an anonymous
/// camera, and the form's label says as much: it strips identifying EXIF, not the maker note.
const IDENTIFYING: &[u16] = &[
    0x010d, // DocumentName
    0x010e, // ImageDescription
    0x013b, // Artist
    0x013c, // HostComputer
    0x02bc, // The XMP packet, which carries a creator and often a place name
    0x8298, // Copyright
    0x83bb, // IPTC/NAA
    0x8649, // Photoshop image resources, which is where IPTC usually ends up
    0x9286, // UserComment
    0x9c9b, // XPTitle, and the four below it, which Windows writes as UTF-16
    0x9c9c, // XPComment
    0x9c9d, // XPAuthor
    0x9c9e, // XPKeywords
    0x9c9f, // XPSubject
    0xa420, // ImageUniqueID
    0xa430, // CameraOwnerName
    0xa431, // BodySerialNumber
    0xa435, // LensSerialNumber
];

/// The tags above reach XMP and IPTC where a TIFF directory holds them. A JPEG carries the same
/// two as segments of its own instead, which no directory names and so no walk of one reaches.
const XMP: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const XMP_EXTENSION: &[u8] = b"http://ns.adobe.com/xmp/extension/\0";
const PHOTOSHOP: &[u8] = b"Photoshop 3.0\0";

const EXIF_IFD: u16 = 0x8769;
const GPS_IFD: u16 = 0x8825;
const INTEROP_IFD: u16 = 0xa005;
const SUBIFDS: u16 = 0x014a;

/// A chain long enough that no camera writes one, and short enough that a malformed file cannot
/// hold this in a loop: the visited set already stops a cycle, this stops a long spiral.
const IFD_CEILING: usize = 256;

fn type_size(kind: u16) -> usize {
    match kind {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 => 4,
        5 | 10 | 12 => 8,
        _ => 0,
    }
}

struct Block<'a> {
    bytes: &'a mut [u8],
    big_endian: bool,
}

impl Block<'_> {
    fn short(&self, at: usize) -> Option<u16> {
        let bytes = self.bytes.get(at..at + 2)?.try_into().ok()?;
        Some(if self.big_endian { u16::from_be_bytes(bytes) } else { u16::from_le_bytes(bytes) })
    }

    fn long(&self, at: usize) -> Option<u32> {
        let bytes = self.bytes.get(at..at + 4)?.try_into().ok()?;
        Some(if self.big_endian { u32::from_be_bytes(bytes) } else { u32::from_le_bytes(bytes) })
    }

    fn clear_short(&mut self, at: usize) {
        if let Some(slot) = self.bytes.get_mut(at..at + 2) {
            slot.fill(0);
        }
    }

    fn blank(&mut self, at: usize, len: usize) {
        let end = at.saturating_add(len).min(self.bytes.len());
        if let Some(slot) = self.bytes.get_mut(at..end) {
            slot.fill(0);
        }
    }
}

/// Queued only while the walk below could still reach it. The ceiling has to bound the queue and
/// not just the walk: an entry's own SubIFD list is already bounded by the block, but a directory
/// may repeat the tag once per twelve bytes of itself, and the product of the two is a queue
/// quadratic in the size of the file that asked for it - grown whole before the first pop.
fn queue(pending: &mut Vec<(usize, bool)>, at: Option<u32>, is_gps: bool) {
    if pending.len() < IFD_CEILING {
        pending.push((at.unwrap_or(0) as usize, is_gps));
    }
}

/// Blanks one TIFF block in place. False where these bytes are not one.
///
/// The block is addressed from its own start, which is what lets the same walk serve a file that
/// is a TIFF, a `CMT1` box inside a CR3, and the APP1 of a preview: in all three the offsets
/// inside are relative to the header rather than to the file.
pub fn scrub_tiff(bytes: &mut [u8]) -> bool {
    let big_endian = match bytes.get(..2) {
        Some(b"MM") => true,
        Some(b"II") => false,
        _ => return false,
    };
    let mut block = Block { bytes, big_endian };
    // 42 is TIFF's; Panasonic writes 85 into an RW2 and is otherwise an ordinary TIFF.
    if !matches!(block.short(2), Some(42 | 85)) {
        return false;
    }
    let Some(first) = block.long(4) else {
        return false;
    };

    let mut seen: HashSet<usize> = HashSet::new();
    let mut pending = vec![(first as usize, false)];
    let mut walked = 0;

    while let Some((ifd, is_gps)) = pending.pop() {
        if ifd == 0 || !seen.insert(ifd) {
            continue;
        }
        walked += 1;
        if walked > IFD_CEILING {
            break;
        }
        let Some(entries) = block.short(ifd) else {
            continue;
        };
        for i in 0..usize::from(entries) {
            let at = ifd + 2 + i * 12;
            let (Some(tag), Some(kind), Some(count)) =
                (block.short(at), block.short(at + 2), block.long(at + 4))
            else {
                break;
            };
            let len = type_size(kind).saturating_mul(count as usize);
            // Four bytes or fewer live in the entry; anything longer is addressed from here.
            let value_at = if len <= 4 { at + 8 } else { block.long(at + 8).unwrap_or(0) as usize };

            if is_gps || IDENTIFYING.contains(&tag) {
                block.blank(value_at, len);
                continue;
            }
            match tag {
                EXIF_IFD | INTEROP_IFD => queue(&mut pending, block.long(at + 8), false),
                GPS_IFD => queue(&mut pending, block.long(at + 8), true),
                // One SubIFD sits in the entry; several are a list of addresses it points at.
                //
                // Bounded by what the block could actually hold rather than by the count the tag
                // declares: `count` is four bytes off the file, so a corrupt one asks for four
                // billion addresses and is answered with four billion pushes before anything
                // above gets to refuse it.
                SUBIFDS => {
                    let slots = (count as usize).min(block.bytes.len().saturating_sub(value_at) / 4);
                    for slot in 0..slots {
                        if pending.len() >= IFD_CEILING {
                            break;
                        }
                        let address = if count == 1 { block.long(at + 8) } else { block.long(value_at + slot * 4) };
                        queue(&mut pending, address, false);
                    }
                }
                _ => {}
            }
        }
        // The values are gone above; this is what stops a reader finding an empty latitude and
        // reporting the equator rather than nothing.
        if is_gps {
            block.clear_short(ifd);
            continue;
        }
        queue(&mut pending, block.long(ifd + 2 + usize::from(entries) * 12), false);
    }
    true
}

/// Every segment a JPEG hides identity in, blanked, and how many EXIF directories there were.
///
/// A RAW's previews are whole JPEGs with EXIF of their own, so a walk of the container's
/// directories alone leaves a second copy of the coordinates sitting inside the thumbnail. This
/// is also the whole of the work for a Fuji RAF, which keeps its EXIF in the preview - and the
/// count is how that case knows it understood the file at all. Only the EXIF is counted: the
/// other two are text a file may simply not carry, so finding none of either says nothing.
fn scrub_app1(bytes: &mut [u8]) -> usize {
    let mut at = 0;
    let mut found = 0;
    while at + 14 < bytes.len() {
        let app1 = bytes[at + 1] == 0xe1;
        let app13 = bytes[at + 1] == 0xed;
        if bytes[at] != 0xff || !(app1 || app13) {
            at += 1;
            continue;
        }
        let length = usize::from(u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]));
        let end = at + 2 + length;
        if length < 8 || end > bytes.len() {
            at += 2;
            continue;
        }
        if app1 && bytes[at + 4..end].starts_with(b"Exif\0\0") {
            if scrub_tiff(&mut bytes[at + 10..end]) {
                found += 1;
            }
            at = end;
            continue;
        }
        // The packet blanked whole rather than read. Its coordinates and its creator are a dozen
        // properties of text, and the tags above have already established that a bug report wants
        // none of what lives beside them.
        let signature = match (app1, app13) {
            (true, _) if bytes[at + 4..end].starts_with(XMP) => XMP.len(),
            (true, _) if bytes[at + 4..end].starts_with(XMP_EXTENSION) => XMP_EXTENSION.len(),
            // Every 8BIM resource, not only IPTC's `0x0404`: what else is in there is a clipping
            // path and a thumbnail, and neither is what the reader ticked the box to keep.
            (_, true) if bytes[at + 4..end].starts_with(PHOTOSHOP) => PHOTOSHOP.len(),
            _ => {
                at += 2;
                continue;
            }
        };
        bytes[at + 4 + signature..end].fill(0);
        at = end;
    }
    found
}

/// The Canon boxes that hold a CR3's EXIF, and whether any were found. `CMT3` and `CMT4` are
/// the maker notes and stay.
///
/// **Finding none is a failure, not a clean file.** Every box walk here bails on arithmetic that
/// does not add up - a truncated download, a container that is not Canon's - and a bail that
/// reported success would hand back a CR3 whose EXIF had never been looked at.
fn scrub_bmff(bytes: &mut [u8], from: usize, to: usize, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    let mut found = false;
    let mut at = from;
    while at + 8 <= to {
        let declared = u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
        let kind: [u8; 4] = [bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]];
        let (header, size) = match declared {
            0 => (8, to - at),
            1 if at + 16 <= to => {
                let large = u64::from_be_bytes(bytes[at + 8..at + 16].try_into().unwrap_or_default());
                (16, usize::try_from(large).unwrap_or(to - at))
            }
            _ => (8, declared),
        };
        if size < header || at + size > to {
            return found;
        }
        match &kind {
            b"CMT1" | b"CMT2" => {
                found |= scrub_tiff(&mut bytes[at + header..at + size]);
            }
            // A `uuid` names itself in the sixteen bytes after the header, and Canon's holds the
            // CMT boxes; the rest are ordinary containers.
            b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"uuid" => {
                let inner = at + header + if &kind == b"uuid" { 16 } else { 0 };
                if inner <= at + size {
                    // The other `uuid` a CR3 carries is the XMP packet, which is XML rather than
                    // boxes: recursing into it finds nothing and leaves the creator and the place
                    // an editor wrote there sitting in the file.
                    if bytes[inner..at + size].starts_with(b"<?xpacket") {
                        bytes[inner..at + size].fill(0);
                    } else {
                        found |= scrub_bmff(bytes, inner, at + size, depth + 1);
                    }
                }
            }
            _ => {}
        }
        at += size;
    }
    found
}

/// Blanks every identifying tag where it lies. False for a container this cannot read, in which
/// case the bytes are left exactly as they were and the caller has to refuse to send them.
///
/// In place because the file is the size of a RAW and the edit never changes that size: a copy
/// here would be tens of megabytes to hand back bytes that are mostly the same ones.
pub fn scrub_in_place(bytes: &mut [u8]) -> bool {
    let Some(kind) = Container::of(bytes) else {
        return false;
    };

    let directories = match kind {
        Container::Tiff => scrub_tiff(bytes),
        Container::Bmff => {
            let end = bytes.len();
            scrub_bmff(bytes, 0, end, 0)
        }
        Container::Jpeg | Container::Fuji => false,
    };
    let previews = scrub_app1(bytes) > 0;

    match kind {
        // Everything a preview has to lose is in an APP1, so one with none is already in the
        // state this is asked to reach rather than one this failed to read.
        Container::Jpeg => true,
        // Fuji's EXIF is inside its preview, so finding no preview is finding no EXIF in a file
        // that certainly has some: this did not understand it.
        Container::Fuji => previews,
        Container::Tiff | Container::Bmff => directories,
    }
}

/// The four shapes a photograph's own file arrives in here, by the bytes at its front.
#[derive(Clone, Copy)]
enum Container {
    Tiff,
    /// A preview lifted out of a RAW, which is attached beside it and carries the same fix.
    Jpeg,
    Fuji,
    Bmff,
}

impl Container {
    fn of(bytes: &[u8]) -> Option<Container> {
        match bytes.get(..2) {
            Some(b"II") | Some(b"MM") => Some(Container::Tiff),
            Some([0xff, 0xd8]) => Some(Container::Jpeg),
            _ if bytes.starts_with(b"FUJIFILM") => Some(Container::Fuji),
            _ if bytes.get(4..8) == Some(b"ftyp") => Some(Container::Bmff),
            _ => None,
        }
    }
}

/// The same file, scrubbed, or None for a container this cannot read.
pub fn scrubbed(file: &[u8]) -> Option<Vec<u8>> {
    let mut out = file.to_vec();
    scrub_in_place(&mut out).then_some(out)
}

#[cfg(all(test, feature = "fixtures"))]
mod fixtures {
    use super::*;
    use crate::fixture_tests::{canon, fuji, sony};
    use crate::header::{name, read_bytes};

    /// One of each container this has to recognise: a TIFF, a BMFF, and Fuji's own wrapper.
    fn all() -> [std::path::PathBuf; 3] {
        [sony(), canon(), fuji()]
    }

    #[test]
    fn a_scrubbed_raw_still_says_what_took_it() {
        for path in all() {
            let before = std::fs::read(&path).expect("the fixture reads");
            let after =
                scrubbed(&before).unwrap_or_else(|| panic!("{} is a container this reads", path.display()));
            assert_eq!(before.len(), after.len(), "{}", path.display());

            let was = read_bytes(&before).expect("the fixture parses");
            let now = read_bytes(&after).expect("and still parses once scrubbed");
            assert_eq!(name(&was.camera_make), name(&now.camera_make), "{}", path.display());
            assert_eq!(name(&was.camera_model), name(&now.camera_model), "{}", path.display());
            assert_eq!(name(&was.lens_model), name(&now.lens_model), "{}", path.display());
            assert_eq!(was.iso, now.iso, "{}", path.display());
            assert_eq!(was.aperture, now.aperture, "{}", path.display());
            assert_eq!(was.timestamp, now.timestamp, "{}", path.display());
            assert_eq!(was.width, now.width, "{}", path.display());
        }
    }

    /// The whole safety argument for editing a RAW in place, as an assertion: a byte this did
    /// not zero is a byte it did not touch, so nothing an offset points at has moved.
    #[test]
    fn a_scrub_only_ever_zeroes() {
        for path in all() {
            let before = std::fs::read(&path).expect("the fixture reads");
            let after = scrubbed(&before).expect("a container this reads");
            for (at, (old, new)) in before.iter().zip(after.iter()).enumerate() {
                assert!(
                    old == new || *new == 0,
                    "{} had byte {at} rewritten from {old} to {new}",
                    path.display(),
                );
            }
        }
    }

    /// The preview is attached to a report beside the original, and carries its own EXIF - so
    /// a scrubber that only knew containers would send the coordinates it had just removed.
    #[test]
    fn the_camera_preview_is_scrubbed_as_it_stands() {
        for path in all() {
            let preview = crate::with_embedded_jpeg(path.to_str().expect("a path"), <[u8]>::to_vec)
                .unwrap_or_else(|| panic!("{} embeds a JPEG", path.display()));
            assert!(preview.starts_with(&[0xff, 0xd8]), "a JPEG starts with SOI");

            let scrubbed = scrubbed(&preview)
                .unwrap_or_else(|| panic!("{} embeds a container this reads", path.display()));
            assert_eq!(preview.len(), scrubbed.len(), "{}", path.display());
            for (at, (old, new)) in preview.iter().zip(scrubbed.iter()).enumerate() {
                assert!(old == new || *new == 0, "{} rewrote byte {at}", path.display());
            }
        }
    }

    /// What each of these files actually had to lose.
    ///
    /// **Not a GPS test, deliberately.** None of these fixtures carries a fix, so asserting
    /// there is none afterwards would pass against a scrubber that did nothing at all; that
    /// claim is made on a synthetic file with a latitude in it instead.
    ///
    /// **The Canon is the interesting one.** Its EXIF is reached - `scrubbed` would answer None
    /// otherwise, since a CR3 whose `CMT1` was never found is refused - and its directories hold
    /// nothing to blank, because Canon writes the body's identity into the maker note, which is
    /// kept on purpose. What it loses is the XMP packet it carries as a `uuid` box of its own,
    /// which no directory names and which is where an editor writes a creator and a place.
    #[test]
    fn what_each_fixture_has_to_lose() {
        assert!(blanked(&sony()) > 0, "the Sony carries standard tags worth removing");
        assert!(blanked(&fuji()) > 0, "and so does the Fuji, in the preview it keeps its EXIF in");

        let before = std::fs::read(canon()).expect("the fixture reads");
        let after = scrubbed(&before).expect("a container this reads");
        let at = before
            .windows(9)
            .position(|window| window == b"<?xpacket")
            .expect("the Canon carries an XMP packet to begin with");
        assert_eq!(&after[at..at + 9], &[0u8; 9], "which goes");
        assert_eq!(before[..at], after[..at], "and nothing before it moves");
    }

    fn blanked(path: &std::path::Path) -> usize {
        let before = std::fs::read(path).expect("the fixture reads");
        let after = scrubbed(&before).expect("a container this reads");
        before.iter().zip(after.iter()).filter(|(old, new)| old != new).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TYPE_ASCII: u16 = 2;
    const TYPE_LONG: u16 = 4;
    const TYPE_RATIONAL: u16 = 5;

    /// A little-endian TIFF: IFD0 with a model, an artist and a GPS pointer, and a GPS IFD
    /// holding a latitude. The shape every camera writes, at its smallest.
    fn synthetic() -> Vec<u8> {
        let mut bytes = vec![0u8; 512];
        bytes[..2].copy_from_slice(b"II");
        bytes[2..4].copy_from_slice(&42u16.to_le_bytes());
        bytes[4..8].copy_from_slice(&8u32.to_le_bytes());

        let entry = |bytes: &mut Vec<u8>, at: usize, tag: u16, kind: u16, count: u32, value: u32| {
            bytes[at..at + 2].copy_from_slice(&tag.to_le_bytes());
            bytes[at + 2..at + 4].copy_from_slice(&kind.to_le_bytes());
            bytes[at + 4..at + 8].copy_from_slice(&count.to_le_bytes());
            bytes[at + 8..at + 12].copy_from_slice(&value.to_le_bytes());
        };

        bytes[8..10].copy_from_slice(&3u16.to_le_bytes());
        entry(&mut bytes, 10, 0x0110, TYPE_ASCII, 6, 200); // Model
        entry(&mut bytes, 22, 0x013b, TYPE_ASCII, 8, 220); // Artist
        entry(&mut bytes, 34, GPS_IFD, TYPE_LONG, 1, 300);
        bytes[46..50].copy_from_slice(&0u32.to_le_bytes()); // no next IFD

        bytes[200..206].copy_from_slice(b"A7 IV\0");
        bytes[220..228].copy_from_slice(b"Declan\0\0");

        bytes[300..302].copy_from_slice(&1u16.to_le_bytes());
        entry(&mut bytes, 302, 0x0002, TYPE_RATIONAL, 3, 400); // GPSLatitude
        bytes[314..318].copy_from_slice(&0u32.to_le_bytes());
        for (i, value) in [51u32, 1, 30, 1, 0, 1].iter().enumerate() {
            bytes[400 + i * 4..404 + i * 4].copy_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn the_camera_is_kept_and_the_photographer_is_not() {
        let mut bytes = synthetic();
        assert!(scrub_tiff(&mut bytes));

        assert_eq!(&bytes[200..206], b"A7 IV\0", "the model is what a bug report is read for");
        assert_eq!(&bytes[220..228], &[0u8; 8], "the artist is a name");
    }

    #[test]
    fn a_blanked_gps_reads_as_absent_rather_than_as_the_equator() {
        let mut bytes = synthetic();
        assert!(scrub_tiff(&mut bytes));

        assert_eq!(&bytes[400..424], &[0u8; 24], "the coordinates are gone from the file");
        assert_eq!(u16::from_le_bytes([bytes[300], bytes[301]]), 0, "and the directory is empty");
    }

    #[test]
    fn nothing_moves() {
        let before = synthetic();
        let mut after = before.clone();
        assert!(scrub_tiff(&mut after));
        assert_eq!(before.len(), after.len());
    }

    #[test]
    fn bytes_that_are_not_a_container_are_refused_rather_than_handed_back() {
        assert!(scrubbed(b"not a photograph at all").is_none());
    }

    /// A count is four bytes off the file, so it can ask for four billion addresses. Bounded by
    /// the block rather than by the count, this returns; unbounded, it exhausts the machine
    /// before anything upstream gets to refuse it.
    #[test]
    fn a_subifd_count_no_file_could_hold_does_not_run_away() {
        let mut bytes = vec![0u8; 64];
        bytes[..2].copy_from_slice(b"II");
        bytes[2..4].copy_from_slice(&42u16.to_le_bytes());
        bytes[4..8].copy_from_slice(&8u32.to_le_bytes());
        bytes[8..10].copy_from_slice(&1u16.to_le_bytes());
        bytes[10..12].copy_from_slice(&SUBIFDS.to_le_bytes());
        bytes[12..14].copy_from_slice(&TYPE_LONG.to_le_bytes());
        bytes[14..18].copy_from_slice(&u32::MAX.to_le_bytes());
        bytes[18..22].copy_from_slice(&24u32.to_le_bytes());

        assert!(scrub_tiff(&mut bytes));
    }

    /// The count above is bounded per entry, which a directory defeats by carrying the tag again:
    /// a list per twelve bytes of a file, each as long as the file over four, is a queue of
    /// billions grown from under a megabyte. Unbounded, this does not return.
    #[test]
    fn a_directory_of_nothing_but_subifd_lists_does_not_run_away() {
        let entries: u16 = 20_000;
        let mut bytes = vec![0u8; 12 + usize::from(entries) * 12 + 4];
        bytes[..2].copy_from_slice(b"II");
        bytes[2..4].copy_from_slice(&42u16.to_le_bytes());
        bytes[4..8].copy_from_slice(&8u32.to_le_bytes());
        bytes[8..10].copy_from_slice(&entries.to_le_bytes());
        for i in 0..usize::from(entries) {
            let at = 10 + i * 12;
            bytes[at..at + 2].copy_from_slice(&SUBIFDS.to_le_bytes());
            bytes[at + 2..at + 4].copy_from_slice(&TYPE_LONG.to_le_bytes());
            bytes[at + 4..at + 8].copy_from_slice(&u32::MAX.to_le_bytes());
            // Zero addresses the block's own start, so every entry's list is the whole file.
            bytes[at + 8..at + 12].copy_from_slice(&0u32.to_le_bytes());
        }

        assert!(scrub_tiff(&mut bytes));
    }

    /// A download that stopped short is the plausible way to meet this, and answering it with
    /// "scrubbed" would send a CR3 whose EXIF was never reached.
    #[test]
    fn a_truncated_bmff_is_refused_rather_than_called_clean() {
        let mut bytes = vec![0u8; 24];
        bytes[..4].copy_from_slice(&16u32.to_be_bytes());
        bytes[4..8].copy_from_slice(b"ftyp");
        // A second box claiming more than the file holds, where `moov` and the EXIF would be.
        bytes[16..20].copy_from_slice(&4096u32.to_be_bytes());
        bytes[20..24].copy_from_slice(b"moov");

        assert!(!scrub_in_place(&mut bytes));
    }

    /// The camera's preview is attached beside the original and carries the same coordinates,
    /// and it arrives here as a bare JPEG rather than inside anything.
    #[test]
    fn a_jpeg_on_its_own_is_a_container_this_reads() {
        let jpeg = with_exif(&synthetic());

        let scrubbed = scrubbed(&jpeg).expect("a JPEG is a container this reads");

        assert_eq!(&scrubbed[APP1_AT + 220..APP1_AT + 228], &[0u8; 8], "the artist goes");
        assert_eq!(&scrubbed[APP1_AT + 200..APP1_AT + 206], b"A7 IV\0", "the camera stays");
    }

    /// Where the TIFF block lands in whatever `with_exif` wrapped it in: two bytes of marker,
    /// two of length, and the six of `Exif\0\0`.
    const APP1_AT: usize = 2 + 2 + 2 + 6;

    /// `exif` as the APP1 of a JPEG, which is the shape a camera's preview arrives in.
    fn with_exif(exif: &[u8]) -> Vec<u8> {
        let length = u16::try_from(exif.len() + 8).expect("the synthetic EXIF fits an APP1");
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe1];
        jpeg.extend_from_slice(&length.to_be_bytes());
        jpeg.extend_from_slice(b"Exif\0\0");
        jpeg.extend_from_slice(exif);
        jpeg
    }

    /// A segment of its own, named by no directory, so the walk that finds every tag above never
    /// goes near it. A phone writes a fix here and nowhere else, and the tick that promised to
    /// remove one would have sent it.
    #[test]
    fn a_jpeg_keeps_neither_the_xmp_packet_nor_the_photoshop_block() {
        let packet = b"<x:xmpmeta><exif:GPSLatitude>51,30.0N</exif:GPSLatitude></x:xmpmeta>";
        let block = b"8BIM\x04\x04\0\0\0\0\0\x08Declan\0\0";

        let mut jpeg = with_exif(&synthetic());
        let xmp_at = jpeg.len() + 4 + XMP.len();
        jpeg.extend_from_slice(&segment(0xe1, XMP, packet));
        let iptc_at = jpeg.len() + 4 + PHOTOSHOP.len();
        jpeg.extend_from_slice(&segment(0xed, PHOTOSHOP, block));

        let scrubbed = scrubbed(&jpeg).expect("a JPEG is a container this reads");

        assert_eq!(&scrubbed[xmp_at..xmp_at + packet.len()], &vec![0u8; packet.len()][..]);
        assert_eq!(&scrubbed[iptc_at..iptc_at + block.len()], &vec![0u8; block.len()][..]);
        assert_eq!(&scrubbed[APP1_AT + 200..APP1_AT + 206], b"A7 IV\0", "the camera still stays");
    }

    fn segment(marker: u8, signature: &[u8], payload: &[u8]) -> Vec<u8> {
        let length = u16::try_from(signature.len() + payload.len() + 2).expect("a segment fits");
        let mut bytes = vec![0xff, marker];
        bytes.extend_from_slice(&length.to_be_bytes());
        bytes.extend_from_slice(signature);
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn a_preview_keeps_no_copy_of_what_the_directory_lost() {
        // A preview's APP1, inside a file that is otherwise a TIFF.
        let mut file = synthetic();
        let at = file.len() + 4 + 6;
        file.extend_from_slice(&with_exif(&synthetic())[2..]);

        let scrubbed = scrubbed(&file).expect("a TIFF is a container this reads");
        assert_eq!(&scrubbed[at + 220..at + 228], &[0u8; 8], "the preview's own artist goes too");
    }
}
