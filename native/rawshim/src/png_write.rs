//! PNG, for an export that wants the picture back without an encoder's opinion of it (§10.5).
//!
//! **PNG carries HDR, which is not obvious and is recent.** The Third Edition (W3C, June 2025)
//! added `cICP`, four bytes stating BT.2100 PQ or HLG, and Chrome, Safari and Firefox all honour
//! it. So an HDR PNG here is the same PQ Rec.2020 samples the AVIF holds, at sixteen bits,
//! with the chunk that says so - not a tone map down to SDR.
//!
//! The matrix coefficient is always 0 and the range always full: PNG stores RGB, so there is no
//! YCbCr matrix to name and no studio-range convention to honour. `png` refuses anything else.

use crate::print_output::PrintSamples;
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
    chunk(b"cICP", &[cicp.0, cicp.1, 0, 1])
}

fn chunk(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut chunk = Vec::with_capacity(12 + payload.len());
    chunk.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    chunk.extend_from_slice(kind);
    chunk.extend_from_slice(payload);
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
    exif: Option<&[u8]>,
    rows: impl FnOnce(&mut png::Writer<&mut Vec<u8>>) -> Result<T, png::EncodingError>,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = Encoder::new(&mut out, width as u32, height as u32);
        encoder.set_color(ColorType::Rgb);
        encoder.set_depth(depth);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("could not write a PNG header: {e}"))?;
        rows(&mut writer).map_err(|e| format!("could not write PNG pixels: {e}"))?;
        writer
            .finish()
            .map_err(|e| format!("could not finish the PNG: {e}"))?;
    }
    if out.len() < AFTER_IHDR {
        return Err(format!(
            "the PNG is {} bytes, too short to hold a header",
            out.len()
        ));
    }
    let mut ahead = cicp_chunk(cicp);
    if let Some(exif) = exif {
        ahead.extend(chunk(b"eXIf", exif));
    }
    out.splice(AFTER_IHDR..AFTER_IHDR, ahead);
    Ok(out)
}

/// A print file: RGB in the space `icc` describes, carried as its `iCCP` chunk, which is the one
/// tag every print path reads. No `cICP`: a printer's own profile has no code point, and a file
/// saying both would be read by whichever a driver prefers.
pub fn encode_print(
    samples: &PrintSamples,
    width: usize,
    height: usize,
    icc: &[u8],
) -> Result<Vec<u8>, String> {
    let count = width * height * 3;
    let (depth, bytes): (BitDepth, Vec<u8>) = match samples {
        PrintSamples::Eight(rgb8) => {
            if rgb8.len() < count {
                return Err(format!("frame is {} samples, expected {count}", rgb8.len()));
            }
            (BitDepth::Eight, rgb8[..count].to_vec())
        }
        PrintSamples::Sixteen(rgb16) => {
            if rgb16.len() < count {
                return Err(format!(
                    "frame is {} samples, expected {count}",
                    rgb16.len()
                ));
            }
            (
                BitDepth::Sixteen,
                rgb16[..count]
                    .iter()
                    .flat_map(|sample| sample.to_be_bytes())
                    .collect(),
            )
        }
    };
    let mut info = png::Info::with_size(width as u32, height as u32);
    info.color_type = ColorType::Rgb;
    info.bit_depth = depth;
    info.icc_profile = Some(std::borrow::Cow::Borrowed(icc));
    let mut out = Vec::new();
    let mut writer = Encoder::with_info(&mut out, info)
        .and_then(|encoder| encoder.write_header())
        .map_err(|e| format!("could not write a PNG header: {e}"))?;
    writer
        .write_image_data(&bytes)
        .map_err(|e| format!("could not write PNG pixels: {e}"))?;
    writer
        .finish()
        .map_err(|e| format!("could not finish the PNG: {e}"))?;
    Ok(out)
}

/// Eight-bit sRGB, for an export with no HDR asked for. `exif` is a TIFF block (`crate::exif`).
pub fn encode_sdr(
    rgb8: &[u8],
    width: usize,
    height: usize,
    exif: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    if rgb8.len() < width * height * 3 {
        return Err(format!(
            "frame is {} bytes, expected {}",
            rgb8.len(),
            width * height * 3
        ));
    }
    write(width, height, BitDepth::Eight, SDR, exif, |writer| {
        writer.write_image_data(&rgb8[..width * height * 3])
    })
}

/// Sixteen-bit PQ Rec.2020, with the `cICP` chunk that makes a viewer treat it as HDR.
///
/// Big-endian, which PNG requires and no platform this runs on is: the swap is here rather than
/// left to the caller because it is a property of the container.
pub fn encode_hdr(
    pq: &[u16],
    width: usize,
    height: usize,
    exif: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let samples = width * height * 3;
    if pq.len() < samples {
        return Err(format!("frame is {} samples, expected {samples}", pq.len()));
    }
    let mut bytes = Vec::with_capacity(samples * 2);
    for sample in &pq[..samples] {
        bytes.extend_from_slice(&sample.to_be_bytes());
    }
    write(width, height, BitDepth::Sixteen, HDR, exif, |writer| {
        writer.write_image_data(&bytes)
    })
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
        let encoded = encode_hdr(&pq, w, h, None).expect("the encode");

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
        let encoded = encode_sdr(&vec![128u8; w * h * 3], w, h, None).expect("the encode");
        let decoder = png::Decoder::new(std::io::Cursor::new(&encoded));
        let reader = decoder.read_info().expect("the header");
        let points = reader
            .info()
            .coding_independent_code_points
            .expect("a cICP chunk");
        assert_eq!((points.color_primaries, points.transfer_function), SDR);
    }

    #[test]
    fn a_png_carries_its_exif_where_a_reader_finds_it() {
        let exif = crate::exif::tests::block();
        let encoded = encode_sdr(&[128u8; 16 * 8 * 3], 16, 8, Some(&exif)).expect("the encode");
        let reader = png::Decoder::new(std::io::Cursor::new(&encoded))
            .read_info()
            .expect("the header");
        assert_eq!(reader.info().exif_metadata.as_deref(), Some(&exif[..]));
        assert!(
            reader.info().coding_independent_code_points.is_some(),
            "and still its cICP"
        );
    }

    #[test]
    fn a_frame_smaller_than_it_claims_is_refused() {
        assert!(encode_sdr(&[0u8; 8], 16, 8, None).is_err());
        assert!(encode_hdr(&[0u16; 8], 16, 8, None).is_err());
        assert!(encode_print(&PrintSamples::Eight(vec![0u8; 8]), 16, 8, &[]).is_err());
    }

    #[test]
    fn a_print_png_carries_its_profile_and_sixteen_bits_big_endian() {
        let icc = moxcms::ColorProfile::new_adobe_rgb()
            .encode()
            .expect("Adobe RGB");
        let samples: Vec<u16> = (0..16 * 8 * 3).map(|i| (i * 977 % 65536) as u16).collect();
        let encoded =
            encode_print(&PrintSamples::Sixteen(samples.clone()), 16, 8, &icc).expect("the encode");
        let mut reader = png::Decoder::new(std::io::Cursor::new(&encoded))
            .read_info()
            .expect("the header");
        assert_eq!(reader.info().bit_depth, BitDepth::Sixteen);
        assert_eq!(reader.info().icc_profile.as_deref(), Some(&icc[..]));
        assert!(reader.info().coding_independent_code_points.is_none());
        let mut bytes = vec![0; reader.output_buffer_size().expect("a size")];
        reader.next_frame(&mut bytes).expect("the frame");
        let read: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(read, samples);
    }
}
