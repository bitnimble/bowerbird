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
use rawler::formats::bmff::ext_cr3::cr3desc::Cr3DescBox;
use rawler::formats::bmff::ext_cr3::cr3xpacket::Cr3XpacketBox;

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
        4 | 9 | 11 | 13 => 4,
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
        let bytes = self.bytes.get(at..at.checked_add(2)?)?.try_into().ok()?;
        Some(if self.big_endian { u16::from_be_bytes(bytes) } else { u16::from_le_bytes(bytes) })
    }

    fn long(&self, at: usize) -> Option<u32> {
        let bytes = self.bytes.get(at..at.checked_add(4)?)?.try_into().ok()?;
        Some(if self.big_endian { u32::from_be_bytes(bytes) } else { u32::from_le_bytes(bytes) })
    }

    fn blank(&mut self, at: usize, len: usize) -> Option<()> {
        self.bytes.get_mut(at..at.checked_add(len)?)?.fill(0);
        Some(())
    }
}

/// Queued only while the walk below could still reach it. The ceiling has to bound the queue and
/// not just the walk: an entry's own SubIFD list is already bounded by the block, but a directory
/// may repeat the tag once per twelve bytes of itself, and the product of the two is a queue
/// quadratic in the size of the file that asked for it - grown whole before the first pop.
fn queue(pending: &mut Vec<(usize, bool)>, at: u32, is_gps: bool) -> Option<()> {
    if at == 0 {
        return Some(());
    }
    if pending.len() >= IFD_CEILING {
        return None;
    }
    pending.push((at as usize, is_gps));
    Some(())
}

/// Blanks one TIFF block in place. False where these bytes are not one.
///
/// The block is addressed from its own start, which is what lets the same walk serve a file that
/// is a TIFF, a `CMT1` box inside a CR3, and the APP1 of a preview: in all three the offsets
/// inside are relative to the header rather than to the file.
pub fn scrub_tiff(bytes: &mut [u8]) -> bool {
    scrub_block(bytes, false).is_some()
}

/// A TIFF block whose first directory is itself a GPS directory, as a CR3's `CMT4` is.
fn scrub_block(bytes: &mut [u8], gps_first: bool) -> Option<()> {
    let big_endian = match bytes.get(..2) {
        Some(b"MM") => true,
        Some(b"II") => false,
        _ => return None,
    };
    let mut block = Block { bytes, big_endian };
    // 42 is TIFF's; Panasonic writes 85 into an RW2 and is otherwise an ordinary TIFF.
    if !matches!(block.short(2), Some(42 | 85)) {
        return None;
    }
    let first = block.long(4)? as usize;
    if first < 8 { return None; }

    let mut seen = HashSet::new();
    let mut pending = vec![(first, gps_first)];
    let mut walked = 0;

    while let Some((ifd, is_gps)) = pending.pop() {
        if !seen.insert((ifd, is_gps)) {
            continue;
        }
        walked += 1;
        if ifd < 8 || walked > IFD_CEILING {
            return None;
        }
        let entries = block.short(ifd)?;
        let start = ifd.checked_add(2)?;
        let next_at = start.checked_add(usize::from(entries) * 12)?;
        let next = block.long(next_at)?;
        for i in 0..usize::from(entries) {
            let at = start + i * 12;
            let tag = block.short(at)?;
            let kind = block.short(at + 2)?;
            let count = block.long(at + 4)? as usize;
            let size = type_size(kind);
            if size == 0 { return None; }
            let len = size.checked_mul(count)?;
            // Four bytes or fewer live in the entry; anything longer is addressed from here.
            let value_at = if len <= 4 { at + 8 } else { block.long(at + 8)? as usize };
            if value_at < 8 { return None; }
            block.bytes.get(value_at..value_at.checked_add(len)?)?;

            if is_gps || IDENTIFYING.contains(&tag) {
                block.blank(value_at, len)?;
                continue;
            }
            match tag {
                EXIF_IFD | INTEROP_IFD | GPS_IFD => {
                    if !matches!(kind, 4 | 13) || count != 1 { return None; }
                    queue(&mut pending, block.long(value_at)?, tag == GPS_IFD)?;
                }
                SUBIFDS => {
                    if !matches!(kind, 4 | 13) || count > IFD_CEILING { return None; }
                    for slot in 0..count {
                        queue(&mut pending, block.long(value_at + slot * 4)?, false)?;
                    }
                }
                _ => {}
            }
        }
        // The values are gone above; this is what stops a reader finding an empty latitude and
        // reporting the equator rather than nothing.
        // A root directory keeps its entries, values blanked, since a TIFF reader refuses a root
        // with none - a CR3's `CMT4` then refuses to open. A blanked rational is 0/0, not the equator.
        queue(&mut pending, next, is_gps)?;
        if is_gps && ifd != first {
            block.blank(ifd, 2)?;
            // An empty directory's next pointer is read where its first entry was: left as that
            // entry's tag and type, a reader follows it into the file and gives up on the whole
            // CR3.
            block.blank(ifd + 2, 4)?;
        }
    }
    Some(())
}

/// Every segment a JPEG hides identity in, blanked, and how many EXIF directories there were.
///
/// A RAW's previews are whole JPEGs with EXIF of their own, so a walk of the container's
/// directories alone leaves a second copy of the coordinates sitting inside the thumbnail. This
/// is also the whole of the work for a Fuji RAF, which keeps its EXIF in the preview - and the
/// count is how that case knows it understood the file at all. Only the EXIF is counted: the
/// other two are text a file may simply not carry, so finding none of either says nothing.
fn scrub_app1(bytes: &mut [u8]) -> Result<usize, ()> {
    let mut at = 0;
    let mut found = 0;
    while at + 4 <= bytes.len() {
        let app1 = bytes[at + 1] == 0xe1;
        let app13 = bytes[at + 1] == 0xed;
        if bytes[at] != 0xff || !(app1 || app13) {
            at += 1;
            continue;
        }
        let length = usize::from(u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]));
        let end = at + 2 + length;
        let payload = &bytes[at + 4..];
        let metadata_length = match (app1, app13) {
            (true, _) if payload.starts_with(b"Exif\0\0") => 6,
            (true, _) if payload.starts_with(XMP) => XMP.len(),
            (true, _) if payload.starts_with(XMP_EXTENSION) => XMP_EXTENSION.len(),
            (_, true) if payload.starts_with(PHOTOSHOP) => PHOTOSHOP.len(),
            _ => 0,
        };
        if length < metadata_length + 2 || end > bytes.len() {
            if metadata_length > 0 { return Err(()); }
            at += 2;
            continue;
        }
        if app1 && bytes[at + 4..end].starts_with(b"Exif\0\0") {
            if !scrub_tiff(&mut bytes[at + 10..end]) {
                return Err(());
            }
            found += 1;
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
    Ok(found)
}

/// The Canon boxes that hold a CR3's EXIF, and whether any were found. `CMT3` is the maker note
/// and stays; `CMT4` is the GPS directory, blanked whole.
///
/// **Finding none is a failure, not a clean file.** Every box walk here bails on arithmetic that
/// does not add up - a truncated download, a container that is not Canon's - and a bail that
/// reported success would hand back a CR3 whose EXIF had never been looked at.
fn scrub_bmff(bytes: &mut [u8], from: usize, to: usize, depth: usize) -> Result<bool, ()> {
    if depth > 8 || from > to || to > bytes.len() {
        return Err(());
    }
    let mut found = false;
    let mut at = from;
    while at < to {
        if to - at < 8 { return Err(()); }
        let declared = u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
        let kind: [u8; 4] = [bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]];
        let (header, size) = match declared {
            0 => (8, to - at),
            1 => {
                if to - at < 16 { return Err(()); }
                let large = u64::from_be_bytes(bytes[at + 8..at + 16].try_into().map_err(|_| ())?);
                (16, usize::try_from(large).map_err(|_| ())?)
            }
            _ => (8, declared),
        };
        if size < header || size > to - at {
            return Err(());
        }
        match &kind {
            b"CMT1" | b"CMT2" => {
                if !scrub_tiff(&mut bytes[at + header..at + size]) {
                    return Err(());
                }
                found = true;
            }
            b"CMT4" => {
                scrub_block(&mut bytes[at + header..at + size], true).ok_or(())?;
            }
            b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" => {
                found |= scrub_bmff(bytes, at + header, at + size, depth + 1)?;
            }
            b"uuid" => {
                if size - header < 16 { return Err(()); }
                let uuid = &bytes[at + header..at + header + 16];
                let inner = at + header + 16;
                if uuid == Cr3XpacketBox::UUID.as_slice() || bytes[inner..at + size].starts_with(b"<?xpacket") {
                    bytes[inner..at + size].fill(0);
                } else if uuid == Cr3DescBox::UUID.as_slice() {
                    found |= scrub_bmff(bytes, inner, at + size, depth + 1)?;
                }
            }
            _ => {}
        }
        at += size;
    }
    Ok(found)
}

/// Blanks identifying tags in place. On false, bytes may be partly scrubbed and must not be sent.
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
            scrub_bmff(bytes, 0, end, 0).unwrap_or(false)
        }
        Container::Jpeg | Container::Fuji => false,
    };
    let Ok(previews) = scrub_app1(bytes) else { return false };

    match kind {
        // Everything a preview has to lose is in an APP1, so one with none is already in the
        // state this is asked to reach rather than one this failed to read.
        Container::Jpeg => true,
        // Fuji's EXIF is inside its preview, so finding no preview is finding no EXIF in a file
        // that certainly has some: this did not understand it.
        Container::Fuji => previews > 0,
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
    /// otherwise, since a CR3 whose `CMT1` was never found is refused - and its EXIF directories
    /// hold nothing to blank, because Canon writes the body's identity into the maker note, which
    /// is kept on purpose. What it loses is its `CMT4` GPS box, here a version and no position,
    /// and the XMP packet it carries as a `uuid` box of its own, which no directory names and
    /// which is where an editor writes a creator and a place.
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
        let gps = before.windows(4).position(|window| window == b"CMT4").expect("a GPS box");
        let gps_end = gps - 4 + u32::from_be_bytes(before[gps - 4..gps].try_into().unwrap()) as usize;
        assert!(gps_end <= at);
        assert_eq!(before[..gps], after[..gps], "and nothing before the GPS box moves");
        assert_eq!(before[gps_end..at], after[gps_end..at], "nor between it and the packet");
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

        assert!(!scrub_tiff(&mut bytes));
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

        assert!(!scrub_tiff(&mut bytes));
    }

    /// A CR3 keeps its GPS directory as a box of its own, `CMT4`, whose first directory is the
    /// GPS one: nothing points at it from the EXIF, so a walk of `CMT1` never reaches it.
    #[test]
    fn a_cr3_loses_the_position_in_its_own_box() {
        let exif = synthetic();
        let mut gps = synthetic();
        // The same latitude, with the GPS directory now the block's first.
        gps[4..8].copy_from_slice(&300u32.to_le_bytes());
        let mut moov = boxed(b"CMT1", &exif);
        moov.extend(boxed(b"CMT4", &gps));
        let mut file = boxed(b"ftyp", b"crx isom");
        file.extend(boxed(b"moov", &moov));
        let cmt4 = file.len() - gps.len();

        assert!(scrub_in_place(&mut file));
        assert_eq!(&file[cmt4 + 400..cmt4 + 424], &[0u8; 24], "the coordinates are gone");
        let entries = u16::from_le_bytes([file[cmt4 + 300], file[cmt4 + 301]]);
        assert_eq!(entries, 1, "and the root keeps its entry, without which the CR3 will not open");
        assert_eq!(file.len(), 16 + 8 + 2 * 8 + 2 * 512);
    }

    fn boxed(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn a_valid_directory_cannot_hide_a_failed_metadata_scrub() {
        for kind in [b"CMT4", b"CMT1", b"CMT2"] {
            let malformed = boxed(kind, b"unreadable metadata");
            let mut uuid = Cr3DescBox::UUID.to_vec();
            uuid.extend_from_slice(&malformed);
            for container in [malformed.clone(), boxed(b"moov", &malformed), boxed(b"uuid", &uuid)] {
                let mut file = boxed(b"ftyp", b"crx isom");
                file.extend(boxed(b"CMT1", &synthetic()));
                file.extend(container);
                file.extend(boxed(b"CMT1", &synthetic()));
                assert!(scrubbed(&file).is_none(),
                    "malformed {} was returned as clean", String::from_utf8_lossy(kind));
            }
        }
    }

    #[test]
    fn malformed_metadata_box_lengths_are_refused_after_valid_metadata() {
        for declared in [1u32, 4, 4096] {
            let mut malformed = declared.to_be_bytes().to_vec();
            malformed.extend_from_slice(b"CMT4");
            let mut uuid = Cr3DescBox::UUID.to_vec();
            uuid.extend_from_slice(&malformed);
            for container in [malformed.clone(), boxed(b"moov", &malformed), boxed(b"uuid", &uuid)] {
                let mut file = boxed(b"ftyp", b"crx isom");
                file.extend(boxed(b"CMT1", &synthetic()));
                file.extend(container);
                assert!(scrubbed(&file).is_none(), "a box length of {declared} was accepted");
            }
        }
    }

    #[test]
    fn invalid_tiff_directories_entries_and_payloads_are_refused() {
        let malformed = [
            (4, u32::MAX.to_le_bytes().to_vec()),
            (4, 0u32.to_le_bytes().to_vec()),
            (8, u16::MAX.to_le_bytes().to_vec()),
            (24, 0u16.to_le_bytes().to_vec()),
            (26, u32::MAX.to_le_bytes().to_vec()),
            (30, 509u32.to_le_bytes().to_vec()),
            (42, 510u32.to_le_bytes().to_vec()),
            (46, u32::MAX.to_le_bytes().to_vec()),
            (310, 509u32.to_le_bytes().to_vec()),
            (314, u32::MAX.to_le_bytes().to_vec()),
        ];
        for (at, value) in malformed {
            let mut bytes = synthetic();
            bytes[at..at + value.len()].copy_from_slice(&value);
            assert!(!scrub_tiff(&mut bytes.clone()), "accepted malformed TIFF field at {at}");
            let mut file = boxed(b"ftyp", b"crx isom");
            file.extend(boxed(b"CMT1", &synthetic()));
            file.extend(boxed(b"CMT2", &bytes));
            assert!(scrubbed(&file).is_none(), "accepted nested malformed TIFF field at {at}");
        }
    }

    #[test]
    fn opaque_uuid_payloads_are_kept_and_known_metadata_still_scrubbed() {
        let mut opaque = vec![0x55; 16];
        opaque.extend_from_slice(b"opaque vendor data, not a box stream");
        let mut metadata = Cr3DescBox::UUID.to_vec();
        metadata.extend(boxed(b"CMT1", &synthetic()));
        let mut file = boxed(b"ftyp", b"crx isom");
        let opaque_at = file.len() + 8;
        file.extend(boxed(b"uuid", &opaque));
        let tiff_at = file.len() + 8 + 16 + 8;
        file.extend(boxed(b"uuid", &metadata));

        let after = scrubbed(&file).expect("an opaque UUID beside Canon metadata");
        assert_eq!(&after[opaque_at..opaque_at + opaque.len()], &opaque);
        assert_eq!(&after[tiff_at + 220..tiff_at + 228], &[0; 8]);
        assert_eq!(&after[tiff_at + 400..tiff_at + 424], &[0; 24]);
    }

    #[test]
    fn a_valid_directory_cannot_hide_an_invalid_preview() {
        let mut malformed = synthetic();
        malformed[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        let preview = with_exif(&malformed);
        assert!(scrubbed(&preview).is_none());

        let mut file = synthetic();
        file.extend_from_slice(&preview[2..]);
        assert!(scrubbed(&file).is_none());
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
