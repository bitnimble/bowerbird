//! PNG, for an export that wants the picture back without an encoder's opinion of it (§10.5).
//!
//! **PNG carries HDR, which is not obvious and is recent.** The Third Edition (W3C, June 2025)
//! added `cICP`, four bytes stating BT.2100 PQ or HLG, and Chrome, Safari and Firefox all honour
//! it. So an HDR PNG here is the same PQ Rec.2020 samples the AVIF holds, at sixteen bits,
//! with the chunk that says so - not a tone map down to SDR.
//!
//! The matrix coefficient is always 0 and the range always full: PNG stores RGB, so there is no
//! YCbCr matrix to name and no studio-range convention to honour. `png` refuses anything else.

use png::{BitDepth, ColorType, Encoder};

/// Rec.2020 primaries and PQ, which is what every HDR still here is coded in.
pub(crate) const HDR: (u8, u8) = (9, 16);
/// sRGB primaries and transfer.
pub(crate) const SDR: (u8, u8) = (1, 13);

/// A PNG's 8-byte signature followed by its IHDR chunk, which is always 25 bytes: the length,
/// the type, thirteen of payload and the checksum. `cICP` goes directly after it.
const AFTER_IHDR: usize = 8 + 25;

/// `cICP` as four bytes: primaries, transfer, matrix, range.
///
/// **Spliced rather than set**, because `png` reads this chunk and does not write one. The
/// alternative is no chunk, which is a PNG that decodes perfectly and is simply not HDR - the
/// same shape of silent failure the AVIF `colr` box has (§10.7), and the reason that one is
/// asserted off a written file too.
fn cicp_chunk(cicp: (u8, u8)) -> Vec<u8> {
    // PNG is RGB, so there is no matrix to name, and full range because a still has no studio
    // convention. The specification allows nothing else here.
    let payload = [cicp.0, cicp.1, 0, 1];
    let mut chunk = Vec::with_capacity(12 + payload.len());
    chunk.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    chunk.extend_from_slice(b"cICP");
    chunk.extend_from_slice(&payload);
    // The checksum covers the type and the payload, not the length.
    let mut crc = crc32fast::Hasher::new();
    crc.update(&chunk[4..]);
    chunk.extend_from_slice(&crc.finalize().to_be_bytes());
    chunk
}

fn write<T>(
    width: usize,
    height: usize,
    depth: BitDepth,
    cicp: (u8, u8),
    rows: impl FnOnce(&mut png::Writer<&mut Vec<u8>>) -> Result<T, png::EncodingError>,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = Encoder::new(&mut out, width as u32, height as u32);
        encoder.set_color(ColorType::Rgb);
        encoder.set_depth(depth);
        let mut writer = encoder.write_header().map_err(|e| format!("could not write a PNG header: {e}"))?;
        rows(&mut writer).map_err(|e| format!("could not write PNG pixels: {e}"))?;
        writer.finish().map_err(|e| format!("could not finish the PNG: {e}"))?;
    }
    if out.len() < AFTER_IHDR {
        return Err(format!("the PNG is {} bytes, too short to hold a header", out.len()));
    }
    out.splice(AFTER_IHDR..AFTER_IHDR, cicp_chunk(cicp));
    Ok(out)
}

/// Eight-bit sRGB, for an export with no HDR asked for.
pub fn encode_sdr(rgb8: &[u8], width: usize, height: usize) -> Result<Vec<u8>, String> {
    if rgb8.len() < width * height * 3 {
        return Err(format!("frame is {} bytes, expected {}", rgb8.len(), width * height * 3));
    }
    write(width, height, BitDepth::Eight, SDR, |writer| writer.write_image_data(&rgb8[..width * height * 3]))
}

/// Sixteen-bit PQ Rec.2020, with the `cICP` chunk that makes a viewer treat it as HDR.
///
/// Big-endian, which PNG requires and no platform this runs on is: the swap is here rather than
/// left to the caller because it is a property of the container.
pub fn encode_hdr(pq: &[u16], width: usize, height: usize) -> Result<Vec<u8>, String> {
    let samples = width * height * 3;
    if pq.len() < samples {
        return Err(format!("frame is {} samples, expected {samples}", pq.len()));
    }
    let mut bytes = Vec::with_capacity(samples * 2);
    for sample in &pq[..samples] {
        bytes.extend_from_slice(&sample.to_be_bytes());
    }
    write(width, height, BitDepth::Sixteen, HDR, |writer| writer.write_image_data(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Written and read back, because the chunk that makes this HDR is the one a broken writer
    /// would omit while still producing a perfectly good picture.
    #[test]
    fn an_hdr_png_says_it_is_pq_rec2020() {
        let (w, h) = (16usize, 8usize);
        let pq: Vec<u16> = (0..w * h * 3).map(|i| (i * 37 % 65536) as u16).collect();
        let encoded = encode_hdr(&pq, w, h).expect("the encode");

        let decoder = png::Decoder::new(std::io::Cursor::new(&encoded));
        let reader = decoder.read_info().expect("the header");
        let info = reader.info();
        let points = info.coding_independent_code_points.expect("a cICP chunk");
        assert_eq!((points.color_primaries, points.transfer_function), HDR);
        assert_eq!(info.bit_depth, BitDepth::Sixteen);
    }

    #[test]
    fn an_sdr_png_says_it_is_srgb() {
        let (w, h) = (16usize, 8usize);
        let encoded = encode_sdr(&vec![128u8; w * h * 3], w, h).expect("the encode");
        let decoder = png::Decoder::new(std::io::Cursor::new(&encoded));
        let reader = decoder.read_info().expect("the header");
        let points = reader.info().coding_independent_code_points.expect("a cICP chunk");
        assert_eq!((points.color_primaries, points.transfer_function), SDR);
    }

    #[test]
    fn a_frame_smaller_than_it_claims_is_refused() {
        assert!(encode_sdr(&[0u8; 8], 16, 8).is_err());
        assert!(encode_hdr(&[0u16; 8], 16, 8).is_err());
    }
}
