//! TIFF, for an export on its way into another editor rather than onto a screen (§10.5).
//!
//! **No HDR.** TIFF holds high bit depth happily - and 32-bit float, which nothing here needs -
//! but it has no CICP-style signalling that any viewer honours, so a PQ TIFF would be a file
//! that looks wrong everywhere while being technically correct. `schemas/export.ts` marks the
//! format SDR for that reason, and what arrives here is already display-referred sRGB.
//!
//! **Eight bits, which is the depth the SDR render has rather than the depth TIFF can hold.**
//! `gpu::Output::Srgb` writes eight bits, so a sixteen-bit TIFF here would be eight bits of
//! information in a sixteen-bit container - a bigger file saying nothing more. Giving TIFF the
//! depth that would justify picking it means a 16-bit SDR output in the shader, which is where
//! the limit actually is; this writes what the pipeline has.

use std::io::Cursor;
use tiff::encoder::{colortype, TiffEncoder};

/// Eight-bit RGB, uncompressed.
///
/// Uncompressed rather than LZW: the reader picked an interchange format, LZW on a photograph
/// saves a few percent for a file some older readers decline, and the one thing this format is
/// for is being opened by something else.
pub fn encode(rgb8: &[u8], width: usize, height: usize) -> Result<Vec<u8>, String> {
    let samples = width * height * 3;
    if rgb8.len() < samples {
        return Err(format!("frame is {} bytes, expected {samples}", rgb8.len()));
    }
    let mut out = Vec::new();
    let mut encoder =
        TiffEncoder::new(Cursor::new(&mut out)).map_err(|e| format!("could not start a TIFF: {e}"))?;
    encoder
        .write_image::<colortype::RGB8>(width as u32, height as u32, &rgb8[..samples])
        .map_err(|e| format!("could not write TIFF pixels: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read back with the same crate's decoder: the dimensions and the samples are what another
    /// editor reads the file by, and a writer that got either wrong still produces bytes.
    #[test]
    fn a_written_tiff_reads_back_as_the_pixels_it_was_given() {
        let (w, h) = (12usize, 5usize);
        let pixels: Vec<u8> = (0..w * h * 3).map(|i| (i * 61 % 256) as u8).collect();
        let encoded = encode(&pixels, w, h).expect("the encode");

        let mut decoder = tiff::decoder::Decoder::new(Cursor::new(&encoded)).expect("the decode");
        assert_eq!(decoder.dimensions().expect("dimensions"), (w as u32, h as u32));
        let tiff::decoder::DecodingResult::U8(read) = decoder.read_image().expect("the pixels") else {
            panic!("an 8-bit TIFF has to read back as 8-bit");
        };
        assert_eq!(read, pixels);
    }

    #[test]
    fn a_frame_smaller_than_it_claims_is_refused() {
        assert!(encode(&[0u8; 8], 12, 5).is_err());
    }
}
