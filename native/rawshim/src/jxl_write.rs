//! JPEG XL, which an export can ask for and nothing else writes (§10.5).
//!
//! Two arms, the same split every other export format has: eight-bit sRGB out of the SDR render,
//! and the PQ Rec.2020 samples the HDR one holds at sixteen bits. What JXL adds over the rest is
//! that its distance parameter reaches zero, so the top of the quality scale is mathematically
//! lossless rather than nearly so.

use crate::raw;

const JXL_ENC_SUCCESS: raw::JxlEncoderStatus = raw::JxlEncoderStatus::JXL_ENC_SUCCESS;
const JXL_ENC_NEED_MORE_OUTPUT: raw::JxlEncoderStatus = raw::JxlEncoderStatus::JXL_ENC_NEED_MORE_OUTPUT;
const JXL_TYPE_UINT8: raw::JxlDataType = raw::JxlDataType::JXL_TYPE_UINT8;
const JXL_TYPE_UINT16: raw::JxlDataType = raw::JxlDataType::JXL_TYPE_UINT16;
const JXL_NATIVE_ENDIAN: raw::JxlEndianness = raw::JxlEndianness::JXL_NATIVE_ENDIAN;
const JXL_COLOR_SPACE_RGB: raw::JxlColorSpace = raw::JxlColorSpace::JXL_COLOR_SPACE_RGB;
const JXL_WHITE_POINT_D65: raw::JxlWhitePoint = raw::JxlWhitePoint::JXL_WHITE_POINT_D65;
const JXL_PRIMARIES_SRGB: raw::JxlPrimaries = raw::JxlPrimaries::JXL_PRIMARIES_SRGB;
const JXL_PRIMARIES_2100: raw::JxlPrimaries = raw::JxlPrimaries::JXL_PRIMARIES_2100;
const JXL_TRANSFER_FUNCTION_SRGB: raw::JxlTransferFunction = raw::JxlTransferFunction::JXL_TRANSFER_FUNCTION_SRGB;
const JXL_TRANSFER_FUNCTION_PQ: raw::JxlTransferFunction = raw::JxlTransferFunction::JXL_TRANSFER_FUNCTION_PQ;
const JXL_RENDERING_INTENT_RELATIVE: raw::JxlRenderingIntent = raw::JxlRenderingIntent::JXL_RENDERING_INTENT_RELATIVE;

/// Eight-bit sRGB, which is what the SDR render holds. `exif` is a TIFF block (`crate::exif`).
pub fn encode_sdr(
    samples: &[u8],
    width: usize,
    height: usize,
    distance: f32,
    exif: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    encode(samples, width, height, distance, false, exif)
}

/// The PQ Rec.2020 samples at sixteen bits, taken from the AVIF rather than tone mapped.
pub fn encode_hdr(
    samples: &[u16],
    width: usize,
    height: usize,
    distance: f32,
    exif: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    // A reinterpret rather than a conversion: the bytes are the samples in this machine's order,
    // which is what `JXL_NATIVE_ENDIAN` says the buffer is in.
    encode(bytemuck::cast_slice(samples), width, height, distance, true, exif)
}

fn encode(
    samples: &[u8],
    width: usize,
    height: usize,
    distance: f32,
    hdr: bool,
    exif: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let depth = match hdr {
        true => 16,
        false => 8,
    };
    let expected = width * height * 3 * (depth as usize / 8);
    if samples.len() < expected {
        return Err(format!("buffer is {} bytes, expected {expected}", samples.len()));
    }
    if width == 0 || height == 0 {
        return Err("JPEG XL cannot hold an empty frame".to_string());
    }

    let encoder = Encoder::new()?;
    let runner = Runner::threads();

    // SAFETY: both handles are live for the block, and every buffer handed over outlives the call
    // that reads it.
    #[expect(unsafe_code)]
    unsafe {
        if !runner.0.is_null()
            && raw::JxlEncoderSetParallelRunner(encoder.0, Some(raw::JxlThreadParallelRunner), runner.0)
                != JXL_ENC_SUCCESS
        {
            return Err("libjxl would not take a parallel runner".to_string());
        }

        if let Some(exif) = exif {
            // The offset to the TIFF header, which follows directly.
            let contents = [&[0u8; 4][..], exif].concat();
            if raw::JxlEncoderUseContainer(encoder.0, 1) != JXL_ENC_SUCCESS
                || raw::JxlEncoderUseBoxes(encoder.0) != JXL_ENC_SUCCESS
                || raw::JxlEncoderAddBox(encoder.0, b"Exif".as_ptr().cast(), contents.as_ptr(), contents.len(), 0)
                    != JXL_ENC_SUCCESS
            {
                return Err("libjxl would not take the EXIF".to_string());
            }
        }

        let mut info = std::mem::zeroed::<raw::JxlBasicInfo>();
        raw::JxlEncoderInitBasicInfo(&mut info);
        info.xsize = width as u32;
        info.ysize = height as u32;
        info.bits_per_sample = depth;
        info.exponent_bits_per_sample = 0;
        info.num_color_channels = 3;
        info.alpha_bits = 0;
        // **Only at distance zero.** Keeping the original profile means coding the samples as
        // they arrived instead of in libjxl's own perceptual space, which is what lossless
        // requires and what makes every lossy file several times larger for nothing.
        info.uses_original_profile = i32::from(distance <= 0.0);
        if raw::JxlEncoderSetBasicInfo(encoder.0, &info) != JXL_ENC_SUCCESS {
            return Err(format!("libjxl refused a {width}x{height} frame at {depth} bits"));
        }

        let mut colour = std::mem::zeroed::<raw::JxlColorEncoding>();
        colour.color_space = JXL_COLOR_SPACE_RGB;
        colour.white_point = JXL_WHITE_POINT_D65;
        colour.rendering_intent = JXL_RENDERING_INTENT_RELATIVE;
        (colour.primaries, colour.transfer_function) = match hdr {
            true => (JXL_PRIMARIES_2100, JXL_TRANSFER_FUNCTION_PQ),
            false => (JXL_PRIMARIES_SRGB, JXL_TRANSFER_FUNCTION_SRGB),
        };
        if raw::JxlEncoderSetColorEncoding(encoder.0, &colour) != JXL_ENC_SUCCESS {
            return Err("libjxl refused the colour encoding".to_string());
        }

        // Owned by the encoder, so there is nothing here to free.
        let settings = raw::JxlEncoderFrameSettingsCreate(encoder.0, std::ptr::null());
        if settings.is_null() {
            return Err("libjxl would not allocate frame settings".to_string());
        }
        if distance <= 0.0 {
            if raw::JxlEncoderSetFrameLossless(settings, 1) != JXL_ENC_SUCCESS {
                return Err("libjxl refused a lossless frame".to_string());
            }
        } else if raw::JxlEncoderSetFrameDistance(settings, distance) != JXL_ENC_SUCCESS {
            return Err(format!("libjxl refused a distance of {distance}"));
        }

        let format = raw::JxlPixelFormat {
            num_channels: 3,
            data_type: match hdr {
                true => JXL_TYPE_UINT16,
                false => JXL_TYPE_UINT8,
            },
            endianness: JXL_NATIVE_ENDIAN,
            align: 0,
        };
        if raw::JxlEncoderAddImageFrame(settings, &format, samples.as_ptr().cast(), expected)
            != JXL_ENC_SUCCESS
        {
            return Err("libjxl would not take the frame".to_string());
        }
        raw::JxlEncoderCloseInput(encoder.0);

        // Grown rather than sized: libjxl writes into whatever is offered and asks again, so
        // the loop is the only thing that knows when the codestream ended.
        let mut out = vec![0u8; 1 << 20];
        let mut written = 0usize;
        loop {
            let mut next = out.as_mut_ptr().add(written);
            let mut available = out.len() - written;
            let status = raw::JxlEncoderProcessOutput(encoder.0, &mut next, &mut available);
            written = out.len() - available;
            match status {
                JXL_ENC_SUCCESS => break,
                JXL_ENC_NEED_MORE_OUTPUT => out.resize(out.len() * 2, 0),
                _ => return Err("libjxl could not encode".to_string()),
            }
        }
        out.truncate(written);
        Ok(out)
    }
}

/// libjxl's encoder, freed when it leaves scope.
struct Encoder(*mut raw::JxlEncoder);

impl Encoder {
    fn new() -> Result<Encoder, String> {
        #[expect(unsafe_code)]
        let handle = unsafe { raw::JxlEncoderCreate(std::ptr::null()) };
        match handle.is_null() {
            true => Err("libjxl would not allocate an encoder".to_string()),
            false => Ok(Encoder(handle)),
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        // SAFETY: built by `JxlEncoderCreate` in `new` and freed exactly once, here.
        #[expect(unsafe_code)]
        unsafe {
            raw::JxlEncoderDestroy(self.0);
        }
    }
}

/// libjxl's thread pool, freed when it leaves scope.
///
/// Null where libjxl would not build one, which the encode treats as a reason to run
/// single-threaded rather than as a failure.
struct Runner(*mut std::ffi::c_void);

impl Runner {
    fn threads() -> Runner {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        #[expect(unsafe_code)]
        let handle = unsafe { raw::JxlThreadParallelRunnerCreate(std::ptr::null(), threads) };
        Runner(handle)
    }
}

impl Drop for Runner {
    fn drop(&mut self) {
        if self.0.is_null() {
            return;
        }
        // SAFETY: built by `JxlThreadParallelRunnerCreate` in `threads` and freed exactly once.
        #[expect(unsafe_code)]
        unsafe {
            raw::JxlThreadParallelRunnerDestroy(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 48;
    const H: usize = 32;

    fn ramp8() -> Vec<u8> {
        (0..W * H * 3).map(|i| ((i / 3) % 256) as u8).collect()
    }

    /// A JPEG XL codestream, which begins `FF 0A` bare or `00 00 00 0C 4A 58 4C 20` in a container.
    fn is_jxl(bytes: &[u8]) -> bool {
        bytes.starts_with(&[0xFF, 0x0A]) || bytes.starts_with(b"\0\0\0\x0CJXL ")
    }

    #[test]
    fn an_sdr_frame_encodes() {
        let file = encode_sdr(&ramp8(), W, H, 1.0, None).expect("the encode");
        assert!(is_jxl(&file), "not a codestream: {:02x?}", &file[..8.min(file.len())]);
    }

    /// Sixteen bits of PQ, which is the arm that would silently truncate if the depth or the
    /// sample type disagreed with the buffer.
    #[test]
    fn an_hdr_frame_encodes_at_sixteen_bits() {
        let samples: Vec<u16> = (0..W * H * 3).map(|i| (i * 17 % 65536) as u16).collect();
        let file = encode_hdr(&samples, W, H, 1.0, None).expect("the encode");
        assert!(is_jxl(&file));
    }

    /// Distance zero is the top of the quality scale, and it has to reach the encoder as lossless
    /// rather than as a very small distance.
    ///
    /// Measured on noise rather than the ramp: a gradient is what modular mode is best at, so
    /// there lossless is the *smaller* file and the comparison says nothing about which arm ran.
    #[test]
    fn lossless_costs_more_than_the_default_distance() {
        let noise: Vec<u8> = (0..W * H * 3).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        let lossy = encode_sdr(&noise, W, H, 1.5, None).expect("the lossy encode");
        let lossless = encode_sdr(&noise, W, H, 0.0, None).expect("the lossless encode");
        assert!(lossless.len() > lossy.len(), "{} against {}", lossless.len(), lossy.len());
    }

    #[test]
    fn a_short_buffer_is_refused() {
        assert!(encode_sdr(&[0; 8], W, H, 1.0, None).is_err());
    }

    fn exif_box(file: &[u8]) -> Option<&[u8]> {
        let mut at = 0;
        while at + 8 <= file.len() {
            let size = u32::from_be_bytes(file[at..at + 4].try_into().ok()?) as usize;
            if size < 8 || at + size > file.len() {
                return None;
            }
            if &file[at + 4..at + 8] == b"Exif" {
                return Some(&file[at + 8..at + size]);
            }
            at += size;
        }
        None
    }

    #[test]
    fn a_jxl_carries_its_exif_in_a_box() {
        let exif = crate::exif::tests::block();
        let file = encode_sdr(&ramp8(), W, H, 1.0, Some(&exif)).expect("the encode");
        assert!(is_jxl(&file));
        let contents = exif_box(&file).expect("an Exif box");
        assert_eq!(&contents[..4], &[0; 4], "the TIFF header follows directly");
        assert_eq!(&contents[4..], &exif[..]);
    }
}
