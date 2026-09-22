//! Writing a gain map beside a picture, which is the other half of `avif::gain_map` (§10.5).
//!
//! **The arithmetic is libavif's.** Handed a base and an alternate, `avifRGBImageComputeGainMap`
//! derives the per-pixel ratio and the ISO 21496-1 metadata that states how to undo it - the
//! log2 encoding, the per-channel min and max, the offsets and the two headrooms. Reimplementing
//! that here would be a second answer to a specification the decoder half already reads through
//! libavif, and the two would drift.
//!
//! **The base is the SDR picture and the alternate is the HDR one**, which is the opposite way
//! round from what the renditions want. An export asking for a gain map has asked for
//! compatibility: the reader is sending this file somewhere unknown, so what a viewer that
//! ignores the map sees has to be a correct ordinary photograph. A rendition is served to a
//! browser this app can detect, where keeping the PQ base means nothing that already works
//! regresses.

use crate::raw;

// The enums take the type bindgen gave them rather than a width, for `avif.rs`'s reason: MSVC
// types a C enum `int` where the Unixes type it `unsigned int`. The two transform bits are a flag
// set, `uint32_t` everywhere.
pub(crate) const AVIF_RESULT_OK: raw::avifResult = 0;
const AVIF_TRANSFORM_IROT: u32 = 1 << 2;
const AVIF_TRANSFORM_IMIR: u32 = 1 << 3;
const AVIF_RGB_FORMAT_RGB: raw::avifRGBFormat = 0;
const AVIF_PIXEL_FORMAT_YUV420: raw::avifPixelFormat = 3;
/// Rec.2020 primaries, PQ, Rec.2020 non-constant luminance: what every HDR still here is.
pub(crate) const HDR_CICP: (u16, u16) = (9, 16);
/// sRGB primaries and transfer, which is what the SDR arm is written as.
pub(crate) const SDR_CICP: (u16, u16) = (1, 13);
/// The gain map's own primaries and transfer are unspecified by the standard.
pub(crate) const UNSPECIFIED: u16 = 2;

/// What libavif wrote into its diagnostics, which is where a refusal explains itself.
pub(crate) fn said(diagnostics: &raw::avifDiagnostics) -> String {
    let bytes = diagnostics.error.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect::<Vec<_>>();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// One decoded AVIF, held as interleaved 8-bit RGB with the image it came from.
pub(crate) struct Decoded {
    pub(crate) image: crate::avif::Image,
    pub(crate) rgb: raw::avifRGBImage,
}

impl Drop for Decoded {
    fn drop(&mut self) {
        // SAFETY: allocated by `avifRGBImageAllocatePixels` in `decode` and freed exactly once.
        // The image frees itself.
        #[expect(unsafe_code)]
        unsafe {
            raw::avifRGBImageFreePixels(&mut self.rgb);
        }
    }
}

/// libavif's gain map, freed when it leaves scope along with the image hung off it.
pub(crate) struct GainMap(pub(crate) *mut raw::avifGainMap);

impl GainMap {
    pub(crate) fn new() -> Result<GainMap, String> {
        #[expect(unsafe_code)]
        let handle = unsafe { raw::avifGainMapCreate() };
        match handle.is_null() {
            true => Err("libavif would not allocate a gain map".to_string()),
            false => Ok(GainMap(handle)),
        }
    }
}

impl Drop for GainMap {
    fn drop(&mut self) {
        // SAFETY: built by `avifGainMapCreate` in `new` and freed exactly once, here.
        #[expect(unsafe_code)]
        unsafe {
            raw::avifGainMapDestroy(self.0);
        }
    }
}

/// Decodes one AVIF and converts it to 8-bit RGB, which is what the gain map computation takes.
pub(crate) fn decode(bytes: &[u8]) -> Result<Decoded, String> {
    let decoder = crate::avif::Decoder::new()?;
    let image = crate::avif::Image::empty()?;

    // SAFETY: both handles are live for the block, and `rgb` is libavif's to fill and this
    // function's to hand on.
    #[expect(unsafe_code)]
    unsafe {
        let read = raw::avifDecoderReadMemory(decoder.0, image.0, bytes.as_ptr(), bytes.len());
        if read != AVIF_RESULT_OK {
            return Err(format!("libavif could not decode: {}", crate::avif::message(read)));
        }

        let mut rgb = std::mem::zeroed::<raw::avifRGBImage>();
        raw::avifRGBImageSetDefaults(&mut rgb, image.0);
        rgb.format = AVIF_RGB_FORMAT_RGB;
        rgb.depth = 8;
        let allocated = raw::avifRGBImageAllocatePixels(&mut rgb);
        if allocated != AVIF_RESULT_OK {
            let why = crate::avif::message(allocated);
            return Err(format!("libavif would not allocate pixels: {why}"));
        }

        // Owned before the conversion, so a refusal past here still frees the pixels.
        let mut decoded = Decoded { image, rgb };
        let converted = raw::avifImageYUVToRGB(decoded.image.0, &mut decoded.rgb);
        if converted != AVIF_RESULT_OK {
            let why = crate::avif::message(converted);
            return Err(format!("libavif could not convert to RGB: {why}"));
        }
        Ok(decoded)
    }
}

#[expect(unsafe_code)]
pub(crate) fn orientation_tag(image: &crate::avif::Image) -> Result<u16, String> {
    unsafe {
        let image = &*image.0;
        if image.transformFlags & AVIF_TRANSFORM_IMIR != 0 {
            return Err("a mirrored gain-map AVIF is not supported".into());
        }
        let angle = if image.transformFlags & AVIF_TRANSFORM_IROT != 0 { image.irot.angle } else { 0 };
        match angle {
            0 => Ok(1),
            1 => Ok(8),
            2 => Ok(3),
            3 => Ok(6),
            _ => Err("the gain-map AVIF has an invalid rotation".into()),
        }
    }
}

/// An SDR base and an HDR alternate, written as one file with the map between them.
///
/// Both must be the same size, which they are by construction: they are two dispatches of one
/// export at one target size. A mismatch is a caller's bug and is refused rather than resampled,
/// since resampling one of them here would silently change the picture the reader asked for.
///
/// `quality` is a libaom quantizer, 0-63 and lower is better, and covers the map as well as the
/// base - see `write` for why the map is not separately settable.
pub fn combine(base: &[u8], alternate: &[u8], quality: i32, speed: i32) -> Result<Vec<u8>, String> {
    let base = decode(base)?;
    let alternate = decode(alternate)?;
    if orientation_tag(&base.image)? != orientation_tag(&alternate.image)? {
        return Err("gain-map arms have different orientations".into());
    }
    if base.rgb.width != alternate.rgb.width || base.rgb.height != alternate.rgb.height {
        return Err(format!(
            "a gain map needs both images at one size: {}x{} against {}x{}",
            base.rgb.width, base.rgb.height, alternate.rgb.width, alternate.rgb.height
        ));
    }
    let gain_map = GainMap::new()?;

    // SAFETY: every pointer is libavif's own and live for the block - the two decodes and the
    // gain map each free themselves, and the map's image belongs to the map.
    #[expect(unsafe_code)]
    unsafe {
        // The map at the base's own size. Half resolution is the conventional choice and
        // the wrong one here: the gain lives on highlight edges - a neon tube, a sun - and
        // halving smears exactly the content the map exists for.
        let map_image =
            raw::avifImageCreate(base.rgb.width, base.rgb.height, 8, AVIF_PIXEL_FORMAT_YUV420);
        if map_image.is_null() {
            return Err("libavif would not allocate the gain map's image".to_string());
        }
        // Handed over before anything can fail, so the map's `Drop` is what frees it.
        (*gain_map.0).image = map_image;
        // The standard leaves the map's own colorimetry unspecified, and libavif refuses
        // anything else.
        (*map_image).colorPrimaries = UNSPECIFIED;
        (*map_image).transferCharacteristics = UNSPECIFIED;

        // A real buffer rather than null: libavif clears the diagnostics at the head of
        // every non-const call, and it is also the only place the reason a computation
        // refused is written down.
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

        // Hung off the base rather than encoded separately: `avifEncoderWrite` writes the
        // pair and the `tmap` item that binds them when the field is set.
        (*base.image.0).gainMap = gain_map.0;
        let encoded = write(base.image.0, quality, speed);
        // Taken back before the image is dropped, or `avifImageDestroy` frees a gain map
        // that `GainMap`'s own `Drop` is also about to.
        (*base.image.0).gainMap = std::ptr::null_mut();
        encoded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 64;
    const H: usize = 48;

    /// A ramp that clips in the SDR arm and does not in the HDR one, so there is a real gain to
    /// find: a flat pair produces a valid map of nothing and would pass this without meaning it.
    fn arms() -> (Vec<u8>, Vec<u16>) {
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

    fn encoded() -> (Vec<u8>, Vec<u8>) {
        let (sdr, hdr) = arms();
        let base = crate::avif::encode_rgb8(sdr.into(), W, H, 20, 10, true).expect("the SDR arm");
        let alternate = crate::avif::encode_still(
            hdr.into(),
            W,
            H,
            &crate::avif::StillOptions {
                cicp: crate::avif::Cicp { primaries: 9, transfer: 16, matrix: 9 },
                format: 1,
                quantizer: 20,
                speed: 10,
            },
        )
        .expect("the HDR arm");
        (base, alternate)
    }

    /// The writer against the reader that already existed: a file this produces has to be one
    /// `avif::gain_map` can take apart again, which is the only claim that spans both halves.
    #[test]
    fn a_written_gain_map_is_one_the_reader_finds() {
        let (base, alternate) = encoded();
        let combined = combine(&base, &alternate, 20, 10).expect("the combine");
        assert!(combined.len() > base.len(), "a file with a map in it is larger than one without");

        let (map, width, height, _, _) = crate::avif::gain_map(&combined).expect("the reader finds a map");
        assert_eq!((width, height), (W, H));
        // Not a constant: the ramp clips in one arm and not the other, so the gain has to vary
        // across it. A map of one value is what a broken computation produces.
        let low = map.iter().copied().min().expect("samples");
        let high = map.iter().copied().max().expect("samples");
        assert!(high > low, "the map is flat at {low}, so nothing was measured between the arms");
    }

    /// The one quality there is reaches both images, which is what makes a second knob pointless
    /// rather than merely absent - `write` says why `qualityGainMap` is not that knob.
    #[test]
    fn the_quality_reaches_the_map_as_well_as_the_base() {
        // A gain that varies per pixel rather than along a ramp: a smooth map costs the same
        // handful of bytes at every quality, so a ramp cannot tell two encodes apart.
        const W: usize = 256;
        const H: usize = 192;
        let (mut sdr, mut hdr) = (vec![0u8; W * H * 3], vec![0u16; W * H * 3]);
        for pixel in 0..W * H {
            let noise = (pixel.wrapping_mul(2654435761) >> 11) as u8;
            for channel in 0..3 {
                sdr[pixel * 3 + channel] = 128;
                hdr[pixel * 3 + channel] = 32768 + u16::from(noise) * 100;
            }
        }
        let base = crate::avif::encode_rgb8(sdr.into(), W, H, 10, 10, true).expect("the SDR arm");
        let alternate = crate::avif::encode_still(
            hdr.into(),
            W,
            H,
            &crate::avif::StillOptions {
                cicp: crate::avif::Cicp { primaries: 9, transfer: 16, matrix: 9 },
                format: 1,
                quantizer: 10,
                speed: 10,
            },
        )
        .expect("the HDR arm");

        // The base is flat grey, so what differs between these two files is almost entirely the
        // map: a quality that stopped at the base would leave them the same size.
        let coarse = combine(&base, &alternate, 55, 10).expect("a coarse encode");
        let fine = combine(&base, &alternate, 5, 10).expect("a fine encode");
        assert!(fine.len() > coarse.len(), "{} against {}", fine.len(), coarse.len());
    }

    #[test]
    fn two_sizes_are_refused_rather_than_resampled() {
        let (base, _) = encoded();
        let small = crate::avif::encode_rgb8(vec![0u8; 8 * 8 * 3].into(), 8, 8, 20, 10, true).expect("a small arm");
        assert!(combine(&base, &small, 20, 10).is_err());
    }

    #[test]
    fn different_orientations_are_refused_before_computing_a_gain_map() {
        let (sdr, _) = arms();
        let base = crate::avif::encode_rgb8_rotated(sdr.into(), W, H, 20, 10, true, 180)
            .expect("rotated SDR arm");
        let (_, alternate) = encoded();
        assert_eq!(combine(&base, &alternate, 20, 10).err().as_deref(),
            Some("gain-map arms have different orientations"));
    }

    #[test]
    fn combined_gain_map_keeps_base_orientation() {
        let (sdr, hdr) = arms();
        let base = crate::avif::encode_rgb8_rotated(sdr.into(), W, H, 20, 10, true, 90).expect("SDR arm");
        let alternate = crate::avif::encode_still_rotated(
            hdr.into(),
            W,
            H,
            &crate::avif::StillOptions {
                cicp: crate::avif::Cicp { primaries: 9, transfer: 16, matrix: 9 },
                format: 1,
                quantizer: 20,
                speed: 10,
            },
            90,
        ).expect("HDR arm");
        let combined = combine(&base, &alternate, 20, 10).expect("combined gain map");
        let decoded = decode(&combined).expect("decoded combined image");
        assert_eq!(orientation_tag(&decoded.image).expect("orientation"), 6);
        let file = crate::heif::read(&combined).expect("combined AVIF");
        assert_eq!(file.primary.turn, rawler::decoders::Orientation::Rotate90);
    }
}

#[expect(unsafe_code)]
unsafe fn write(image: *mut raw::avifImage, quality: i32, speed: i32) -> Result<Vec<u8>, String> {
    let encoder = crate::avif::Encoder::new()?;
    unsafe {
        (*encoder.0).maxThreads = std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(1);
        (*encoder.0).speed = speed;
        (*encoder.0).minQuantizer = quality;
        (*encoder.0).maxQuantizer = quality;
        // The map goes at the base's quality, which is libavif's own default for it. Not a
        // choice left open: measured on 1.4.2, `qualityGainMap` set to 5 and to 97 decode to
        // byte-identical maps, so a knob here would be one that does nothing.
        (*encoder.0).autoTiling = 1;

        let mut output = crate::avif::Output::empty();
        let status = raw::avifEncoderWrite(encoder.0, image, &mut output.0);
        match (status, output.bytes()) {
            (AVIF_RESULT_OK, Some(written)) => Ok(written),
            (AVIF_RESULT_OK, None) => Err("libavif returned no bytes".to_string()),
            _ => Err(format!("libavif could not encode: {}", crate::avif::message(status))),
        }
    }
}
