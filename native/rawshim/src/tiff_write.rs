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

use rawler::formats::tiff::writer::{DirectoryWriter, TiffWriter};
use rawler::formats::tiff::Rational;
use rawler::tags::TiffCommonTag;
use std::io::Cursor;

const PLANAR_CONFIGURATION: u16 = 0x011c;

/// Eight-bit RGB, uncompressed, in one strip. `exif` is a TIFF block (`crate::exif`), whose
/// directories become the file's own.
///
/// Uncompressed rather than LZW: the reader picked an interchange format, LZW on a photograph
/// saves a few percent for a file some older readers decline, and the one thing this format is
/// for is being opened by something else.
pub fn encode(rgb8: &[u8], width: usize, height: usize, exif: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let samples = width * height * 3;
    if rgb8.len() < samples {
        return Err(format!("frame is {} bytes, expected {samples}", rgb8.len()));
    }
    let (Ok(width), Ok(height), Ok(bytes)) = (u32::try_from(width), u32::try_from(height), u32::try_from(samples))
    else {
        return Err(format!("a TIFF cannot hold a {width}x{height} frame"));
    };
    let failed = |e: rawler::formats::tiff::TiffError| format!("could not write the TIFF: {e}");

    let mut out = Vec::new();
    let mut tiff = TiffWriter::new(Cursor::new(&mut out)).map_err(failed)?;
    let strip = tiff.write_data(&rgb8[..samples]).map_err(failed)?;
    let mut root = DirectoryWriter::new();
    root.add_tag(TiffCommonTag::ImageWidth, width);
    root.add_tag(TiffCommonTag::ImageLength, height);
    root.add_tag(TiffCommonTag::BitsPerSample, [8u16, 8, 8]);
    root.add_tag(TiffCommonTag::Compression, 1u16);
    root.add_tag(TiffCommonTag::PhotometricInt, 2u16);
    root.add_tag(TiffCommonTag::StripOffsets, strip);
    root.add_tag(TiffCommonTag::SamplesPerPixel, 3u16);
    root.add_tag(TiffCommonTag::RowsPerStrip, height);
    root.add_tag(TiffCommonTag::StripByteCounts, bytes);
    root.add_tag(TiffCommonTag::XResolution, Rational::new(72, 1));
    root.add_tag(TiffCommonTag::YResolution, Rational::new(72, 1));
    root.add_tag(TiffCommonTag::ResolutionUnit, 2u16);
    root.add_untyped_tag(PLANAR_CONFIGURATION, 1u16);
    if let Some(exif) = exif {
        crate::exif::copy_into(exif, &mut tiff, &mut root)?;
    }
    tiff.build(root).map_err(failed)?;
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
        let encoded = encode(&pixels, w, h, Some(&crate::exif::tests::block())).expect("the encode");

        let mut decoder = tiff::decoder::Decoder::new(Cursor::new(&encoded)).expect("the decode");
        assert_eq!(decoder.dimensions().expect("dimensions"), (w as u32, h as u32));
        let tiff::decoder::DecodingResult::U8(read) = decoder.read_image().expect("the pixels") else {
            panic!("an 8-bit TIFF has to read back as 8-bit");
        };
        assert_eq!(read, pixels);
    }

    /// Read back as a camera's own file is, which is how another editor finds it.
    #[test]
    fn a_tiff_carries_its_exif_as_its_own_directories() {
        let exif = crate::exif::tests::block();
        let encoded = encode(&[0u8; 4 * 2 * 3], 4, 2, Some(&exif)).expect("the encode");
        let carried = crate::exif::Recorded::parse(&encoded).expect("the file's tags parse");
        assert_eq!(carried.block(crate::exif::NON_IDENTIFYING), Some(exif));
    }

    #[test]
    fn a_frame_smaller_than_it_claims_is_refused() {
        assert!(encode(&[0u8; 8], 12, 5, None).is_err());
    }
}
