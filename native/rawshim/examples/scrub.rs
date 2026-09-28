//! A RAW made fit to commit as a fixture: `scrub::scrubbed`, and then the Sony maker note's serial
//! and its enciphered blocks zeroed, which is where the body keeps its serial number and shutter
//! count.
//!
//! ```text
//! scrub <in.ARW> <out.ARW>
//! ```
//!
//! `0x9416` is kept: the decoder reads the lens id from it.

const EXIF_IFD: u16 = 0x8769;
const MAKER_NOTE: u16 = 0x927c;
const SONY_HEADER: &[u8] = b"SONY DSC \0\0\0";
const LENS_BLOCK: u16 = 0x9416;
const SERIAL: u16 = 0x2031;

fn main() {
    let mut args = std::env::args().skip(1);
    let from = args.next().expect("scrub <in> <out>");
    let to = args.next().expect("scrub <in> <out>");
    let bytes = std::fs::read(&from).expect("a readable RAW");
    let mut out = rawshim::scrub::scrubbed(&bytes).expect("a container scrub reads");
    let zeroed = zero_sony_blocks(&mut out).expect("a Sony maker note");
    println!("zeroed maker note blocks {zeroed:04x?}");
    std::fs::write(&to, out).expect("the output writes");
}

fn zero_sony_blocks(bytes: &mut [u8]) -> Option<Vec<u16>> {
    let little = bytes.get(..2)? == b"II";
    let short = |b: &[u8], at: usize| {
        let v: [u8; 2] = b.get(at..at + 2)?.try_into().ok()?;
        Some(if little { u16::from_le_bytes(v) } else { u16::from_be_bytes(v) })
    };
    let long = |b: &[u8], at: usize| {
        let v: [u8; 4] = b.get(at..at + 4)?.try_into().ok()?;
        Some(if little { u32::from_le_bytes(v) } else { u32::from_be_bytes(v) } as usize)
    };
    let entry = |b: &[u8], ifd: usize, want: u16| -> Option<usize> {
        let count = short(b, ifd)? as usize;
        (0..count).map(|k| ifd + 2 + 12 * k).find(|at| short(b, *at) == Some(want))
    };
    let ifd0 = long(bytes, 4)?;
    let exif = long(bytes, entry(bytes, ifd0, EXIF_IFD)? + 8)?;
    let note = entry(bytes, exif, MAKER_NOTE)?;
    let start = long(bytes, note + 8)?;
    // An ARW's maker note is a bare IFD; the JPEG-era header only sometimes precedes it.
    let ifd = match bytes.get(start..start + SONY_HEADER.len())? == SONY_HEADER {
        true => start + SONY_HEADER.len(),
        false => start,
    };
    let count = short(bytes, ifd)? as usize;
    let mut zeroed = Vec::new();
    for k in 0..count {
        let at = ifd + 2 + 12 * k;
        let tag = short(bytes, at)?;
        let enciphered = (0x9000..0x9500).contains(&tag) && tag != LENS_BLOCK;
        if !enciphered && tag != SERIAL {
            continue;
        }
        let size = match short(bytes, at + 2)? {
            1 | 2 | 6 | 7 => 1,
            3 | 8 => 2,
            4 | 9 | 11 => 4,
            5 | 10 | 12 => 8,
            _ => continue,
        } * long(bytes, at + 4)?;
        let data = match size <= 4 {
            true => at + 8,
            false => long(bytes, at + 8)?,
        };
        bytes.get_mut(data..data + size)?.fill(0);
        zeroed.push(tag);
    }
    Some(zeroed)
}
