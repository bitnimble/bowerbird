//! A RAW made fit to commit as a fixture: `scrub::scrubbed`, and then the maker note's own record
//! of the body zeroed, which `scrubbed` keeps - the Sony's serial and its enciphered blocks, where
//! it keeps its shutter count, or the Canon's owner, serials and image id.
//!
//! ```text
//! scrub <in.ARW|in.CR3> <out>
//! ```
//!
//! `0x9416` is kept: the decoder reads a Sony's lens id from it.

const EXIF_IFD: u16 = 0x8769;
const MAKER_NOTE: u16 = 0x927c;
const SONY_HEADER: &[u8] = b"SONY DSC \0\0\0";
const LENS_BLOCK: u16 = 0x9416;
const SONY_SERIAL: u16 = 0x2031;
/// OwnerName, SerialNumber, ImageUniqueID, InternalSerialNumber.
const CANON_IDENTITY: [u16; 4] = [0x0009, 0x000c, 0x0028, 0x0096];
const CANON_LENS_INFO: u16 = 0x4019;

fn main() {
    let mut args = std::env::args().skip(1);
    let from = args.next().expect("scrub <in> <out>");
    let to = args.next().expect("scrub <in> <out>");
    let bytes = std::fs::read(&from).expect("a readable RAW");
    let mut out = rawshim::scrub::scrubbed(&bytes).expect("a container scrub reads");
    let zeroed = match out.get(4..8) == Some(b"ftyp") {
        true => zero_canon_note(&mut out).expect("a Canon maker note"),
        false => zero_sony_blocks(&mut out).expect("a Sony maker note"),
    };
    println!("zeroed maker note tags {zeroed:04x?}");
    std::fs::write(&to, out).expect("the output writes");
}

fn short(bytes: &[u8], little: bool, at: usize) -> Option<u16> {
    let v: [u8; 2] = bytes.get(at..at + 2)?.try_into().ok()?;
    Some(if little {
        u16::from_le_bytes(v)
    } else {
        u16::from_be_bytes(v)
    })
}

fn long(bytes: &[u8], little: bool, at: usize) -> Option<usize> {
    let v: [u8; 4] = bytes.get(at..at + 4)?.try_into().ok()?;
    Some(if little {
        u32::from_le_bytes(v)
    } else {
        u32::from_be_bytes(v)
    } as usize)
}

fn entry(bytes: &[u8], little: bool, ifd: usize, want: u16) -> Option<usize> {
    let count = short(bytes, little, ifd)? as usize;
    (0..count)
        .map(|k| ifd + 2 + 12 * k)
        .find(|at| short(bytes, little, *at) == Some(want))
}

/// Every entry of the directory at `ifd` that `zero` names, its value zeroed where it lies. Offsets
/// are from the start of `tiff`.
fn zero_entries(
    tiff: &mut [u8],
    little: bool,
    ifd: usize,
    zero: impl Fn(u16) -> Option<usize>,
) -> Option<Vec<u16>> {
    let count = short(tiff, little, ifd)? as usize;
    let mut zeroed = Vec::new();
    for k in 0..count {
        let at = ifd + 2 + 12 * k;
        let tag = short(tiff, little, at)?;
        let Some(limit) = zero(tag) else { continue };
        let size: usize = match short(tiff, little, at + 2)? {
            1 | 2 | 6 | 7 => 1,
            3 | 8 => 2,
            4 | 9 | 11 => 4,
            5 | 10 | 12 => 8,
            _ => return None,
        };
        let size = size.checked_mul(long(tiff, little, at + 4)?)?;
        if limit != usize::MAX && size < limit {
            return None;
        }
        let data = match size <= 4 {
            true => at + 8,
            false => long(tiff, little, at + 8)?,
        };
        tiff.get_mut(data..data.checked_add(size)?)?[..size.min(limit)].fill(0);
        zeroed.push(tag);
    }
    Some(zeroed)
}

fn zero_sony_blocks(bytes: &mut [u8]) -> Option<Vec<u16>> {
    let little = bytes.get(..2)? == b"II";
    let ifd0 = long(bytes, little, 4)?;
    let exif = long(bytes, little, entry(bytes, little, ifd0, EXIF_IFD)? + 8)?;
    let note = entry(bytes, little, exif, MAKER_NOTE)?;
    let start = long(bytes, little, note + 8)?;
    // An ARW's maker note is a bare IFD; the JPEG-era header only sometimes precedes it.
    let ifd = match bytes.get(start..start + SONY_HEADER.len())? == SONY_HEADER {
        true => start + SONY_HEADER.len(),
        false => start,
    };
    zero_entries(bytes, little, ifd, |tag| {
        (((0x9000..0x9500).contains(&tag) && tag != LENS_BLOCK) || tag == SONY_SERIAL)
            .then_some(usize::MAX)
    })
}

/// A CR3 keeps its maker note as a TIFF of its own, in the `CMT3` box.
fn zero_canon_note(bytes: &mut [u8]) -> Option<Vec<u16>> {
    let (start, end) = boxed(bytes, 0, bytes.len(), b"CMT3")?;
    let tiff = &mut bytes[start..end];
    let little = tiff.get(..2)? == b"II";
    let ifd = long(tiff, little, 4)?;
    zero_entries(tiff, little, ifd, |tag| {
        if tag == CANON_LENS_INFO {
            Some(5)
        } else {
            CANON_IDENTITY.contains(&tag).then_some(usize::MAX)
        }
    })
}

/// The payload of the first `want` box between `from` and `to`, looking inside `moov` and `uuid`.
fn boxed(bytes: &[u8], from: usize, to: usize, want: &[u8; 4]) -> Option<(usize, usize)> {
    let mut at = from;
    while at + 8 <= to {
        let declared = u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?) as usize;
        let kind = bytes.get(at + 4..at + 8)?;
        let (header, size) = match declared {
            1 => (
                16,
                u64::from_be_bytes(bytes.get(at + 8..at + 16)?.try_into().ok()?) as usize,
            ),
            0 => (8, to - at),
            _ => (8, declared),
        };
        if size < header || at + size > to {
            return None;
        }
        if kind == want {
            return Some((at + header, at + size));
        }
        let inner = match kind {
            b"moov" => Some(at + header),
            b"uuid" => Some(at + header + 16),
            _ => None,
        };
        if let Some(found) = inner.and_then(|inner| boxed(bytes, inner, at + size, want)) {
            return Some(found);
        }
        at += size;
    }
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn canon_lens_serial_is_blank_and_technical_data_stays() {
        let mut tiff = vec![0u8; 62];
        tiff[..4].copy_from_slice(b"II\x2a\0");
        tiff[4..8].copy_from_slice(&8u32.to_le_bytes());
        tiff[8..10].copy_from_slice(&1u16.to_le_bytes());
        tiff[10..12].copy_from_slice(&super::CANON_LENS_INFO.to_le_bytes());
        tiff[12..14].copy_from_slice(&7u16.to_le_bytes());
        tiff[14..18].copy_from_slice(&30u32.to_le_bytes());
        tiff[18..22].copy_from_slice(&32u32.to_le_bytes());
        tiff[32..].fill(0x5a);
        let mut file = ((tiff.len() + 8) as u32).to_be_bytes().to_vec();
        file.extend_from_slice(b"CMT3");
        file.extend_from_slice(&tiff);
        let before = file.clone();

        assert_eq!(
            super::zero_canon_note(&mut file),
            Some(vec![super::CANON_LENS_INFO])
        );
        assert_eq!(&file[40..45], &[0; 5]);
        assert_eq!(&file[..40], &before[..40]);
        assert_eq!(&file[45..], &before[45..]);
    }
}
