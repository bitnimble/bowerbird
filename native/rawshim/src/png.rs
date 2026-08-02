// PQ-coded RGB to a PNG the browser will composite as HDR.
//
// The still counterpart to `pack.rs`, and it exists because `<video>` is a dead end on
// WebKit. A `VideoFrame` there can only be 8-bit (I420 and NV12 are the two formats
// WebKit validates), and Apple's own guidance for the layer that renders a MediaStream
// is that sample buffers "need to have 10-bit or higher bit-depth" to route to EDR. So a
// PQ tag on an 8-bit frame is accepted by the API and then tone-mapped, which is what a
// washed-out picture on an XDR panel looks like.
//
// An `<img>` goes through Core Graphics instead, which has no such floor, and Safari 26
// reads CICP off a still. Two things fall out of that beyond HDR working at all: samples
// are 16-bit rather than 10, and they are 4:4:4 rather than subsampled.
//
// **Stored deflate, not compression.** The bytes never leave the tab, so the only thing
// entropy coding would buy is a smaller handoff to the decoder, against a cost measured
// on this project's own JXL polyfill: dynamic Huffman spent most of 5.2s on a 121MB
// intermediate to save 18% (DESIGN.md §10.5). Stored blocks make this a memcpy and two
// checksums, and no dependency.

/// The eight bytes every PNG opens with.
const SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

/// BT.2100 PQ, as ITU-T H.273 numbers it: BT.2020 primaries, the PQ transfer, identity
/// matrix, full range. The matrix is identity because PNG stores RGB, and the range flag
/// is full because PNG has no footroom - both are the only values the format allows.
const CICP_PQ: [u8; 4] = [9, 16, 0, 1];

/// Truecolour, no alpha.
const COLOUR_TYPE_RGB: u8 = 2;

/// Deflate's stored block carries its length in 16 bits.
const MAX_STORED_BLOCK: usize = u16::MAX as usize;

const CRC_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut bit = 0;
        while bit < 8 {
            c = match c & 1 {
                0 => c >> 1,
                _ => 0xEDB8_8320 ^ (c >> 1),
            };
            bit += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
};

fn crc32(running: u32, bytes: &[u8]) -> u32 {
    let mut crc = running;
    for byte in bytes {
        crc = CRC_TABLE[((crc ^ u32::from(*byte)) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc
}

/// Adler-32, zlib's own check value over the *uncompressed* stream.
#[derive(Clone, Copy)]
struct Adler {
    a: u32,
    b: u32,
}

impl Adler {
    /// Largest run that cannot overflow `b` before the reduction, from zlib's `NMAX`.
    const STRIDE: usize = 5552;
    const BASE: u32 = 65521;

    fn new() -> Adler {
        Adler { a: 1, b: 0 }
    }

    fn push(&mut self, bytes: &[u8]) {
        for run in bytes.chunks(Adler::STRIDE) {
            for byte in run {
                self.a += u32::from(*byte);
                self.b += self.a;
            }
            self.a %= Adler::BASE;
            self.b %= Adler::BASE;
        }
    }

    fn finish(self) -> u32 {
        (self.b << 16) | self.a
    }
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(crc32(!0, kind), data);
    out.extend_from_slice(&(!crc).to_be_bytes());
}

/// Buffers the scanline stream into deflate stored blocks, straight into the output.
///
/// The staging buffer is what keeps peak memory to one copy of the image rather than
/// two: the alternative is building the whole zlib stream and then appending it.
struct Stored<'a> {
    out: &'a mut Vec<u8>,
    block: Vec<u8>,
    adler: Adler,
}

impl<'a> Stored<'a> {
    fn new(out: &'a mut Vec<u8>) -> Stored<'a> {
        out.extend_from_slice(&[0x78, 0x01]);
        Stored {
            out,
            block: Vec::with_capacity(MAX_STORED_BLOCK),
            adler: Adler::new(),
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.adler.push(bytes);
        let mut rest = bytes;
        while !rest.is_empty() {
            let room = MAX_STORED_BLOCK - self.block.len();
            let take = room.min(rest.len());
            self.block.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.block.len() == MAX_STORED_BLOCK {
                self.flush(false);
            }
        }
    }

    fn flush(&mut self, last: bool) {
        // Sound only because `push` never lets the block past the field's own width. A
        // wrong length here is not a wrong pixel, it is a stream every decoder rejects.
        debug_assert!(self.block.len() <= MAX_STORED_BLOCK);
        let len = self.block.len() as u16;
        self.out.push(u8::from(last));
        self.out.extend_from_slice(&len.to_le_bytes());
        self.out.extend_from_slice(&(!len).to_le_bytes());
        self.out.append(&mut self.block);
    }

    /// Always emits a final block, empty if the last push happened to fill one - a
    /// stream whose blocks all say "more follows" is truncated, not merely wasteful.
    fn finish(mut self) {
        self.flush(true);
        let adler = self.adler.finish();
        self.out.extend_from_slice(&adler.to_be_bytes());
    }
}

/// How many bits a PNG sample gets.
///
/// Sixteen is the interesting one and the reason this path exists at all: it clears the
/// 10 bits the video route tops out at, so PQ's near-vertical toe has room and the
/// dither `pack.rs` needs at 8 bits is unnecessary here.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Bits {
    Eight,
    Sixteen,
}

impl Bits {
    fn depth(self) -> u8 {
        match self {
            Bits::Eight => 8,
            Bits::Sixteen => 16,
        }
    }

    fn bytes_per_sample(self) -> usize {
        match self {
            Bits::Eight => 1,
            Bits::Sixteen => 2,
        }
    }
}

/// Writes `rgb` into `out` as a PQ-tagged PNG.
///
/// `rgb` is interleaved 16-bit RGB as `tone::encode_pq` leaves it, full range against the
/// display peak, with `stride` samples per row - which can exceed `width` when the caller
/// is packing a sub-rectangle of a larger frame.
///
/// Takes the buffer rather than returning one so a slider tick reuses it. Returning a
/// fresh `Vec` would hold the old file alive while the new one is built, and at 3840px
/// each is 59MB.
pub fn encode_pq(out: &mut Vec<u8>, rgb: &[u16], stride: usize, width: usize, height: usize, bits: Bits) {
    let row_bytes = width * 3 * bits.bytes_per_sample();
    out.clear();
    out.reserve(SIGNATURE.len() + 128 + height * (row_bytes + 6));
    out.extend_from_slice(&SIGNATURE);

    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&(width as u32).to_be_bytes());
    header.extend_from_slice(&(height as u32).to_be_bytes());
    // Bit depth, colour type, then the three that PNG only defines one value for:
    // deflate, adaptive filtering, no interlace.
    header.extend_from_slice(&[bits.depth(), COLOUR_TYPE_RGB, 0, 0, 0]);
    chunk(out, b"IHDR", &header);
    // Before IDAT, which is where a decoder stops looking for colour information.
    chunk(out, b"cICP", &CICP_PQ);

    let start = out.len();
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(b"IDAT");
    let payload = out.len();

    let mut row = vec![0u8; 1 + row_bytes];
    let mut stored = Stored::new(out);
    for y in 0..height {
        let source = &rgb[y * stride * 3..][..width * 3];
        // Filter 0. Filtering exists to help the entropy coder, and there is not one.
        row[0] = 0;
        match bits {
            Bits::Sixteen => {
                for (sample, cell) in source.iter().zip(row[1..].chunks_exact_mut(2)) {
                    cell.copy_from_slice(&sample.to_be_bytes());
                }
            }
            Bits::Eight => {
                for (sample, cell) in source.iter().zip(row[1..].iter_mut()) {
                    *cell = (sample >> 8) as u8;
                }
            }
        }
        stored.push(&row);
    }
    stored.finish();

    let length = (out.len() - payload) as u32;
    out[start..start + 4].copy_from_slice(&length.to_be_bytes());
    let crc = crc32(!0, &out[start + 4..]);
    out.extend_from_slice(&(!crc).to_be_bytes());

    chunk(out, b"IEND", &[]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(rgb: &[u16], stride: usize, width: usize, height: usize, bits: Bits) -> Vec<u8> {
        let mut out = Vec::new();
        encode_pq(&mut out, rgb, stride, width, height, bits);
        out
    }

    /// Walks the chunk list, returning each `(kind, data)` in order.
    ///
    /// A hand-rolled reader rather than a crate: the point is to prove the bytes are
    /// self-describing to something that did not write them.
    fn chunks(png: &[u8]) -> Vec<(String, Vec<u8>)> {
        assert_eq!(&png[..8], &SIGNATURE, "signature");
        let mut at = 8;
        let mut found = Vec::new();
        while at < png.len() {
            let length = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
            let kind = String::from_utf8(png[at + 4..at + 8].to_vec()).unwrap();
            let data = png[at + 8..at + 8 + length].to_vec();
            let stated = u32::from_be_bytes(
                png[at + 8 + length..at + 12 + length]
                    .try_into()
                    .unwrap(),
            );
            let computed = !crc32(crc32(!0, &png[at + 4..at + 8]), &data);
            assert_eq!(stated, computed, "{kind} CRC");
            found.push((kind, data));
            at += 12 + length;
        }
        assert_eq!(at, png.len(), "trailing bytes");
        found
    }

    /// Inflates a stored-block zlib stream, checking the framing as it goes.
    fn inflate_stored(zlib: &[u8]) -> Vec<u8> {
        assert_eq!(zlib[0] & 0x0F, 8, "deflate method");
        assert_eq!(
            (u16::from(zlib[0]) * 256 + u16::from(zlib[1])) % 31,
            0,
            "zlib header check"
        );
        let mut out = Vec::new();
        let mut at = 2;
        loop {
            let header = zlib[at];
            assert_eq!(header >> 1, 0, "stored block type");
            let len = u16::from_le_bytes([zlib[at + 1], zlib[at + 2]]);
            let nlen = u16::from_le_bytes([zlib[at + 3], zlib[at + 4]]);
            assert_eq!(len, !nlen, "stored block length complement");
            out.extend_from_slice(&zlib[at + 5..at + 5 + len as usize]);
            at += 5 + len as usize;
            if header & 1 == 1 {
                break;
            }
        }
        let mut adler = Adler::new();
        adler.push(&out);
        assert_eq!(
            u32::from_be_bytes(zlib[at..at + 4].try_into().unwrap()),
            adler.finish(),
            "adler"
        );
        assert_eq!(at + 4, zlib.len(), "trailing zlib bytes");
        out
    }

    /// The tag is the whole reason for this module, and it is four bytes that no test
    /// downstream of here would notice the loss of - a PNG without them is a valid,
    /// ordinary, SDR picture.
    #[test]
    fn the_file_carries_the_pq_tag_ahead_of_the_pixels() {
        let png = encoded(&[0u16; 2 * 2 * 3], 2, 2, 2, Bits::Sixteen);
        let kinds: Vec<String> = chunks(&png).into_iter().map(|(kind, _)| kind).collect();
        assert_eq!(kinds, ["IHDR", "cICP", "IDAT", "IEND"]);

        let cicp = chunks(&png)[1].1.clone();
        assert_eq!(cicp, [9, 16, 0, 1], "BT.2020 primaries, PQ, identity, full");
    }

    /// Samples must survive at their full width, big-endian, with every row filtered.
    #[test]
    fn the_pixels_round_trip_at_sixteen_bits() {
        // Spread over the range, and every one with a high byte unlike its low, so a
        // byte order that got swapped could not read as a pass.
        let rgb: Vec<u16> = (0..2 * 2 * 3).map(|n: u16| n * 4095 + n).collect();
        let png = encoded(&rgb, 2, 2, 2, Bits::Sixteen);
        let (_, header) = &chunks(&png)[0];
        assert_eq!(header[8], 16, "bit depth");
        assert_eq!(header[9], COLOUR_TYPE_RGB);

        let raw = inflate_stored(&chunks(&png)[2].1);
        let mut want = Vec::new();
        for row in rgb.chunks_exact(6) {
            want.push(0u8);
            for sample in row {
                want.extend_from_slice(&sample.to_be_bytes());
            }
        }
        assert_eq!(raw, want);
    }

    /// Eight bits takes the high byte, so the two depths agree on brightness.
    #[test]
    fn eight_bits_keeps_the_top_of_each_sample() {
        let rgb = vec![0xABCDu16; 3];
        let raw = inflate_stored(&chunks(&encoded(&rgb, 1, 1, 1, Bits::Eight))[2].1);
        assert_eq!(raw, [0, 0xAB, 0xAB, 0xAB]);
    }

    /// A row wider than a stored block has to span several, and the last one - and only
    /// the last - may say so. Getting that bit wrong yields a stream every decoder
    /// rejects as truncated, on large frames alone.
    #[test]
    fn a_row_longer_than_a_stored_block_still_inflates() {
        let width = 40_000;
        let rgb = vec![0x1234u16; width * 3];
        let png = encoded(&rgb, width, width, 1, Bits::Sixteen);
        let raw = inflate_stored(&chunks(&png)[2].1);
        assert_eq!(raw.len(), 1 + width * 6);
        assert_eq!(raw[0], 0, "filter byte");
        assert!(raw[1..].chunks_exact(2).all(|s| s == [0x12, 0x34]));
    }

    /// A frame packed out of a wider buffer must read its own columns, not the stride's.
    #[test]
    fn a_narrower_frame_reads_past_the_stride() {
        let stride = 4;
        let mut rgb = vec![0u16; stride * 2 * 3];
        for (n, pixel) in rgb.chunks_exact_mut(3).enumerate() {
            pixel.fill(n as u16 * 256);
        }
        let raw = inflate_stored(&chunks(&encoded(&rgb, stride, 2, 2, Bits::Eight))[2].1);
        // Pixels 0,1 from the first row and 4,5 from the second - never 2,3.
        assert_eq!(raw, [0, 0, 0, 0, 1, 1, 1, 0, 4, 4, 4, 5, 5, 5]);
    }
}
