//! Writing the gain map a JPEG carries, in both spellings at once - the other half of `jpeg_gain`.
//!
//! **Two whole JPEGs, one after the other.** The primary is an ordinary baseline picture that any
//! decoder since 1992 shows; the map is a second JPEG appended past its `EOI`, which a decoder that
//! has never heard of any of this stops before reaching. What binds them is MPF, the multi-picture
//! index in an `APP2` segment, whose offsets are stated from the byte after its own `MPF\0` tag.
//!
//! **The terms are written twice, deliberately.** ISO 21496-1 is what Apple and Android 15 read;
//! Google's `hdrgm:` XMP is what everything older reads, and what the sharing pipelines that never
//! moved still parse. A file with one of them renders flat somewhere a reader is likely to send it.
//!
//! The map is single channel here, where `avif_gain_write`'s is three. That is the same reasoning
//! as the base being SDR: this format is picked when the file is going somewhere unknown, and a
//! one-channel map is what every reader of either spelling handles.

use crate::avif_gain_write::{AVIF_RESULT_OK, GainMap, HDR_CICP, SDR_CICP, UNSPECIFIED, decode, orientation_tag, said};
use crate::raw;

const AVIF_PIXEL_FORMAT_YUV400: raw::avifPixelFormat = raw::avifPixelFormat::AVIF_PIXEL_FORMAT_YUV400;

const APP1: u8 = 0xE1;
const APP2: u8 = 0xE2;
const XMP_URI: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const ISO_URN: &[u8] = b"urn:iso:std:iso:ts:21496:-1\0";
const MPF_TAG: &[u8] = b"MPF\0";

/// The reconstruction terms, copied out of libavif's struct before it is freed.
///
/// One value per term rather than three: the map is single channel, so the standard states each
/// term once and means it for all three.
struct Terms {
    min: f32,
    max: f32,
    gamma: f32,
    base_offset: f32,
    alternate_offset: f32,
    base_headroom: f32,
    alternate_headroom: f32,
    use_base_colour_space: bool,
}

fn signed(fraction: raw::avifSignedFraction) -> f32 {
    match fraction.d {
        0 => 0.0,
        d => fraction.n as f32 / d as f32,
    }
}

fn unsigned(fraction: raw::avifUnsignedFraction) -> f32 {
    match fraction.d {
        0 => 0.0,
        d => fraction.n as f32 / d as f32,
    }
}

/// An SDR base and an HDR alternate, written as one JPEG with the map between them.
///
/// `quality` is JPEG's own 1-100, and covers the map as well as the base: the map is the thing
/// being reconstructed from, so spending less on it would put the artefacts in the highlights.
pub fn combine(base: &[u8], alternate: &[u8], quality: i32) -> Result<Vec<u8>, String> {
    let (base_rgb, width, height, map, terms, orientation) = compute(base, alternate)?;

    let base_jpeg = crate::jpeg::encode(
        crate::rgb::RgbRef { width, height, data: &base_rgb },
        quality,
    )?;
    let base_jpeg = match crate::avif::exif(base) {
        Some(exif) => crate::jpeg::with_exif(&base_jpeg, &exif).ok_or("the EXIF does not fit a JPEG")?,
        None => base_jpeg,
    };
    let map_jpeg = encode_grey(&map, width, height, quality)?;
    let (base_jpeg, map_jpeg) = if orientation == 1 {
        (base_jpeg, map_jpeg)
    } else {
        (
            crate::jpeg::with_orientation(&base_jpeg, orientation)
                .ok_or("could not orient the gain-map JPEG")?,
            crate::jpeg::with_orientation(&map_jpeg, orientation)
                .ok_or("could not orient the gain-map JPEG")?,
        )
    };

    Ok(assemble(base_jpeg, map_jpeg, &terms))
}

/// Both arms decoded, and the map libavif derives between them.
fn compute(base: &[u8], alternate: &[u8]) -> Result<(Vec<u8>, usize, usize, Vec<u8>, Terms, u16), String> {
    let base = decode(base)?;
    let alternate = decode(alternate)?;
    let orientation = orientation_tag(&base.image)?;
    if orientation != orientation_tag(&alternate.image)? {
        return Err("gain-map arms have different orientations".into());
    }
    if base.rgb.width != alternate.rgb.width || base.rgb.height != alternate.rgb.height {
        return Err(format!(
            "a gain map needs both images at one size: {}x{} against {}x{}",
            base.rgb.width, base.rgb.height, alternate.rgb.width, alternate.rgb.height
        ));
    }
    let (width, height) = (base.rgb.width as usize, base.rgb.height as usize);
    let gain_map = GainMap::new()?;

    // SAFETY: every pointer is libavif's own and live for the block - the two decodes and the
    // gain map each free themselves, and the map's image belongs to the map.
    #[expect(unsafe_code)]
    unsafe {
        let map_image =
            raw::avifImageCreate(base.rgb.width, base.rgb.height, 8, AVIF_PIXEL_FORMAT_YUV400);
        if map_image.is_null() {
            return Err("libavif would not allocate the gain map's image".to_string());
        }
        // Handed over before anything can fail, so the map's `Drop` is what frees it.
        (*gain_map.0).image = map_image;
        (*map_image).colorPrimaries = UNSPECIFIED;
        (*map_image).transferCharacteristics = UNSPECIFIED;

        let mut diagnostics = std::mem::zeroed::<raw::avifDiagnostics>();
        let computed = raw::avifRGBImageComputeGainMap(
            &base.rgb,
            SDR_CICP.0,
            SDR_CICP.1,
            &alternate.rgb,
            HDR_CICP.0,
            HDR_CICP.1,
            gain_map.0,
            &mut diagnostics,
        );
        if computed != AVIF_RESULT_OK {
            return Err(format!(
                "libavif could not compute a gain map: {} ({})",
                crate::avif::message(computed),
                said(&diagnostics),
            ));
        }

        // Row by row: libavif's plane is padded to its own stride, which is not the width.
        let plane = (*map_image).yuvPlanes[0];
        let stride = (*map_image).yuvRowBytes[0] as usize;
        if plane.is_null() {
            return Err("libavif computed a gain map with no pixels".to_string());
        }
        let mut map = Vec::with_capacity(width * height);
        for row in 0..height {
            map.extend_from_slice(std::slice::from_raw_parts(plane.add(row * stride), width));
        }

        let terms = Terms {
            min: signed((*gain_map.0).gainMapMin[0]),
            max: signed((*gain_map.0).gainMapMax[0]),
            gamma: unsigned((*gain_map.0).gainMapGamma[0]),
            base_offset: signed((*gain_map.0).baseOffset[0]),
            alternate_offset: signed((*gain_map.0).alternateOffset[0]),
            base_headroom: unsigned((*gain_map.0).baseHdrHeadroom),
            alternate_headroom: unsigned((*gain_map.0).alternateHdrHeadroom),
            use_base_colour_space: (*gain_map.0).useBaseColorSpace != 0,
        };

        let rgb = std::slice::from_raw_parts(base.rgb.pixels, width * height * 3).to_vec();
        Ok((rgb, width, height, map, terms, orientation))
    }
}

fn encode_grey(map: &[u8], width: usize, height: usize, quality: i32) -> Result<Vec<u8>, String> {
    let (Ok(width), Ok(height)) = (u16::try_from(width), u16::try_from(height)) else {
        return Err("JPEG cannot hold a gain map that large".to_string());
    };
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, quality.clamp(1, 100) as u8)
        .encode(map, width, height, jpeg_encoder::ColorType::Luma)
        .map_err(|e| format!("the gain map would not encode: {e}"))?;
    Ok(out)
}

/// A marker segment, ready to splice in behind an `SOI`.
fn segment(marker: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![0xFF, marker];
    out.extend_from_slice(&((body.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(body);
    out
}

fn spliced(jpeg: Vec<u8>, at: usize, segments: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(jpeg.len() + segments.len());
    out.extend_from_slice(&jpeg[..at]);
    out.extend_from_slice(segments);
    out.extend_from_slice(&jpeg[at..]);
    out
}

/// The two pictures, their two spellings of the terms, and the index that binds them.
fn assemble(base_jpeg: Vec<u8>, map_jpeg: Vec<u8>, terms: &Terms) -> Vec<u8> {
    let map_front = [segment(APP1, &xmp(&map_xmp(terms))), segment(APP2, &iso_payload(terms))].concat();
    let map = spliced(map_jpeg, 2, &map_front);

    let directory = segment(APP1, &xmp(&primary_xmp(map.len())));
    // The primary states only that the standard is in the file; the terms themselves are in the
    // map's own segment, which is where libultrahdr puts them and where a reader looks for them.
    let iso_stub = segment(APP2, &[ISO_URN, &[0, 0, 0, 0]].concat());
    // MPF follows the Exif APP1 where there is one, which is where its specification puts it.
    let front_at = crate::jpeg::after_exif(&base_jpeg);
    // MPF's offsets are counted from the byte after its own tag: everything ahead of the segment,
    // then its marker and length, then the tag.
    let index_at = front_at + directory.len();
    let mpf_base = index_at + 4 + MPF_TAG.len();
    // The index's own size does not depend on what it states, so one pass over the lengths is
    // enough: two entries is always the same 82 bytes.
    let primary_length = base_jpeg.len() + directory.len() + segment(APP2, &mpf(0, 0, 0)).len() + iso_stub.len();

    let front = [
        directory,
        segment(APP2, &mpf(primary_length, (primary_length - mpf_base) as u32, map.len())),
        iso_stub,
    ]
    .concat();
    let mut out = spliced(base_jpeg, front_at, &front);
    out.extend_from_slice(&map);
    out
}

fn xmp(body: &str) -> Vec<u8> {
    [XMP_URI, body.as_bytes()].concat()
}

fn primary_xmp(map_length: usize) -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0"><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="{map_length}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>"#
    )
}

fn map_xmp(terms: &Terms) -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" hdrgm:BaseRenditionIsHDR="False" hdrgm:GainMapMin="{}" hdrgm:GainMapMax="{}" hdrgm:Gamma="{}" hdrgm:OffsetSDR="{}" hdrgm:OffsetHDR="{}" hdrgm:HDRCapacityMin="{}" hdrgm:HDRCapacityMax="{}"/></rdf:RDF></x:xmpmeta>"#,
        terms.min,
        terms.max,
        terms.gamma,
        terms.base_offset,
        terms.alternate_offset,
        terms.base_headroom,
        terms.alternate_headroom,
    )
}

/// ISO 21496-1's metadata payload, which `decode_rendered::iso_21496_terms` reads back.
fn iso_payload(terms: &Terms) -> Vec<u8> {
    fn rational(value: f32) -> [u8; 8] {
        const DENOMINATOR: u32 = 1_000_000;
        let numerator = (value * DENOMINATOR as f32).round() as i32;
        let mut out = [0u8; 8];
        out[..4].copy_from_slice(&numerator.to_be_bytes());
        out[4..].copy_from_slice(&DENOMINATOR.to_be_bytes());
        out
    }

    let mut out = Vec::from(ISO_URN);
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes());
    // Single channel, so the multichannel bit stays clear.
    out.push(match terms.use_base_colour_space {
        true => 0x40,
        false => 0,
    });
    out.extend_from_slice(&rational(terms.base_headroom));
    out.extend_from_slice(&rational(terms.alternate_headroom));
    for term in [terms.min, terms.max, terms.gamma, terms.base_offset, terms.alternate_offset] {
        out.extend_from_slice(&rational(term));
    }
    out
}

/// The multi-picture index: two images, the second at `offset` and `map_size` bytes long.
fn mpf(primary_size: usize, offset: u32, map_size: usize) -> Vec<u8> {
    let mut out = Vec::from(MPF_TAG);
    out.extend_from_slice(b"MM\0\x2A");
    out.extend_from_slice(&8u32.to_be_bytes());
    out.extend_from_slice(&3u16.to_be_bytes());
    // MPFVersion, four undefined bytes held inline.
    out.extend_from_slice(&0xB000u16.to_be_bytes());
    out.extend_from_slice(&7u16.to_be_bytes());
    out.extend_from_slice(&4u32.to_be_bytes());
    out.extend_from_slice(b"0100");
    // NumberOfImages.
    out.extend_from_slice(&0xB001u16.to_be_bytes());
    out.extend_from_slice(&4u16.to_be_bytes());
    out.extend_from_slice(&1u32.to_be_bytes());
    out.extend_from_slice(&2u32.to_be_bytes());
    // MPEntry, two sixteen-byte records that follow the index.
    out.extend_from_slice(&0xB002u16.to_be_bytes());
    out.extend_from_slice(&7u16.to_be_bytes());
    out.extend_from_slice(&32u32.to_be_bytes());
    out.extend_from_slice(&50u32.to_be_bytes());
    out.extend_from_slice(&0u32.to_be_bytes());

    // Representative image, baseline MP primary, JPEG; its offset is stated as zero.
    out.extend_from_slice(&0x2003_0000u32.to_be_bytes());
    out.extend_from_slice(&(primary_size as u32).to_be_bytes());
    out.extend_from_slice(&0u32.to_be_bytes());
    out.extend_from_slice(&[0; 4]);
    // The map: no attributes, since it is neither representative nor a picture in its own right.
    out.extend_from_slice(&0u32.to_be_bytes());
    out.extend_from_slice(&(map_size as u32).to_be_bytes());
    out.extend_from_slice(&offset.to_be_bytes());
    out.extend_from_slice(&[0; 4]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 64;
    const H: usize = 48;

    fn samples() -> (Vec<u8>, Vec<u16>) {
        let mut sdr = vec![0u8; W * H * 3];
        let mut hdr = vec![0u16; W * H * 3];
        for y in 0..H {
            for x in 0..W {
                let at = (y * W + x) * 3;
                let along = x as f32 / (W - 1) as f32;
                for channel in 0..3 {
                    sdr[at + channel] = (255.0 * along.min(0.6) / 0.6) as u8;
                    hdr[at + channel] = (65535.0 * along) as u16;
                }
            }
        }
        (sdr, hdr)
    }

    /// Both arms written at `rotate`, the SDR one carrying `exif`.
    fn arms_written(rotate: u16, exif: Option<&[u8]>) -> (Vec<u8>, Vec<u8>) {
        let (sdr, hdr) = samples();
        let base = crate::avif::encode_rgb8_rotated(sdr.into(), W, H, 20, 10, true, rotate, exif)
            .expect("the SDR arm");
        let alternate = crate::avif::encode_still_rotated(
            hdr.into(),
            W,
            H,
            &crate::avif::StillOptions {
                cicp: crate::avif::Cicp { primaries: 9, transfer: 16, matrix: 9 },
                format: raw::avifPixelFormat::AVIF_PIXEL_FORMAT_YUV444,
                quantizer: 20,
                speed: 10,
            },
            rotate,
            None,
        )
        .expect("the HDR arm");
        (base, alternate)
    }

    fn arms() -> (Vec<u8>, Vec<u8>) {
        arms_written(0, None)
    }

    /// The writer against the reader that already existed, which is the only claim spanning both.
    #[test]
    fn a_written_jpeg_gain_map_is_one_the_reader_finds() {
        let (base, alternate) = arms();
        let file = combine(&base, &alternate, 90).expect("the combine");

        // A reader that has never heard of any of this sees a whole, ordinary picture.
        assert_eq!(crate::jpeg::dimensions(&file), Some((W, H)));

        let map = crate::jpeg_gain::read(&file, None).expect("the reader finds a map");
        assert_eq!((map.width, map.height), (W, H));
        let low = map.samples.iter().copied().min().expect("samples");
        let high = map.samples.iter().copied().max().expect("samples");
        assert!(high > low, "the map is flat at {low}, so nothing was measured between the arms");
    }

    /// The `hdrgm:` spelling is the one an older reader parses, so it has to state real terms.
    #[test]
    fn the_older_spelling_states_the_same_gain() {
        let (base, alternate) = arms();
        let file = combine(&base, &alternate, 90).expect("the combine");
        let text = String::from_utf8_lossy(&file);
        assert!(text.contains(r#"hdrgm:Version="1.0""#));
        assert!(text.contains(r#"Item:Semantic="GainMap""#));
        let max = text
            .split(r#"hdrgm:GainMapMax=""#)
            .nth(1)
            .and_then(|it| it.split('"').next())
            .and_then(|it| it.parse::<f32>().ok())
            .expect("a stated maximum");
        assert!(max > 0.0, "the XMP claims no gain at {max}");
    }

    #[test]
    fn two_sizes_are_refused_rather_than_resampled() {
        let (base, _) = arms();
        let small = crate::avif::encode_rgb8(vec![0u8; 8 * 8 * 3].into(), 8, 8, 20, 10, true).expect("a small arm");
        assert!(combine(&base, &small, 90).is_err());
    }

    /// The base's EXIF, with the turn the arms were written at added to it, and a map the MPF
    /// index still leads to past the extra segment.
    #[test]
    fn the_base_carries_its_exif_and_its_turn() {
        let exif = crate::exif::tests::block();
        let (base, alternate) = arms_written(90, Some(&exif));

        let file = combine(&base, &alternate, 90).expect("the combine");
        let probe = crate::decode_rendered::probe(&file).expect("the header");
        assert_eq!(probe.orientation, 6);
        let carried = crate::exif::Recorded::parse(&probe.exif.expect("an EXIF block")).expect("it parses");
        assert_eq!(carried.block(crate::exif::NON_IDENTIFYING), Some(exif));
        assert!(crate::jpeg_gain::read(&file, None).is_some(), "the map is still found");
        let at = |tag: &[u8]| file.windows(tag.len()).position(|window| window == tag).expect("the segment");
        assert!(at(b"Exif\0\0") < at(MPF_TAG), "MPF follows the Exif APP1");
    }
}
