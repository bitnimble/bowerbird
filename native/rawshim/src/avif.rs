// The still's encode, in this process (DESIGN 10.7).
//
// `avifenc` is a thin wrapper around libavif, and libavif is what puts the nclx `colr`
// box on the file - the thing Chrome reads to decide a still is HDR, and the whole
// reason ffmpeg was not muxing this. Linking the library instead of spawning the
// binary removes what the binary cost: the graded frame was written to ffmpeg's stdin,
// converted, written again as y4m, and read back by avifenc. Three moves of a frame
// that is 56MB at 3840 and ~366MB at native resolution, none of which any of the three
// processes wanted kept.
//
// What ffmpeg was doing here was `zscale` - zimg behind a filter, which converts
// transfer, primaries, matrix, range and depth in one pass. Every one of those already
// had an owner on this side: the PQ transfer is `tone::pq`, the same curve the grade
// rolls highlights with; the sRGB transfer and the Rec.2020-to-BT.709 primaries matrix
// are `hdr_fit`'s, which has needed both all along because the fit measures its deltaE
// in sRGB; and the YCbCr matrix with its limited-range quantisation is libavif's own
// `avifImageRGBToYUV`. So no stage of it is reimplemented here - they are called from
// here instead of from another process.

use crate::raw;
use crate::rgb::Rgb;

/// CICP, the only signalling that matters: what `--cicp 9/16/9` was passing.
pub struct Cicp {
    pub primaries: u16,
    pub transfer: u16,
    pub matrix: u16,
}

pub struct StillOptions {
    pub cicp: Cicp,
    /// `avifPixelFormat`, from the still's chroma setting (`hdr_args::Chroma`).
    pub format: u32,
    /// libaom's quantizer, the same number `-crf` gives the video.
    pub quantizer: i32,
    /// avifenc's `--speed`.
    pub speed: i32,
}

// avifenc's `--range limited`, and the depth every HDR still is written at.
const AVIF_RANGE_LIMITED: u32 = 0;
/// What an ordinary 8-bit picture uses, and what libheif was writing. Limited range
/// spends 7% of the code values on headroom a still has no use for, and it costs
/// measurably: the same quantizer scored SSIM 0.878 limited against 0.902 full.
const AVIF_RANGE_FULL: u32 = 1;
const AVIF_DEPTH: u32 = 10;
const AVIF_PIXEL_FORMAT_YUV444: u32 = 1;
const AVIF_PIXEL_FORMAT_YUV420: u32 = 3;
const AVIF_RGB_FORMAT_RGB: u32 = 0;
const AVIF_RESULT_OK: u32 = 0;

fn max_threads() -> i32 {
    std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(1)
}

/// Decodes an AVIF back to interleaved 8-bit RGB.
///
/// Here because a rendition is stored as AVIF and a download asks for JPEG, so something
/// has to read one - and libvips, which used to, was the only reason a photo server linked
/// libheif, ImageMagick and poppler. Reading with the library that wrote the file also
/// removes a whole second AV1 implementation from the process.
///
/// 8-bit RGB out of whatever depth is in the file: libavif scales during the YUV
/// conversion. No tone mapping and no transfer applied - an SDR rendition is already sRGB,
/// and a 10-bit PQ still hands back its PQ code values, which is what libheif did too.
///
/// The `irot`/`imir` transform boxes are ignored, because nothing this reads has them:
/// every file comes from `encode_still` or `encode_rendition` a few lines up, and both
/// write pixels already the right way up. A camera HEIC would need them honoured.
///
pub fn decode(bytes: &[u8]) -> Result<Rgb, String> {
    // SAFETY: the decoder and image are libavif's, freed on every path; `source.pixels`
    // points into `data`, which outlives the conversion.
    #[expect(unsafe_code)]
    unsafe {
        let decoder = raw::avifDecoderCreate();
        if decoder.is_null() {
            return Err("libavif would not allocate a decoder".to_string());
        }
        let image = raw::avifImageCreateEmpty();
        if image.is_null() {
            raw::avifDecoderDestroy(decoder);
            return Err("libavif would not allocate an image".to_string());
        }
        let result = (|| -> Result<Rgb, String> {
            (*decoder).maxThreads = max_threads();
            let status =
                raw::avifDecoderReadMemory(decoder, image, bytes.as_ptr(), bytes.len());
            if status != AVIF_RESULT_OK {
                return Err(format!("libavif could not decode: {}", message(status)));
            }

            let (width, height) = ((*image).width as usize, (*image).height as usize);
            let mut data = vec![0u8; width * height * 3];
            let mut source = std::mem::zeroed::<raw::avifRGBImage>();
            raw::avifRGBImageSetDefaults(&mut source, image);
            source.format = AVIF_RGB_FORMAT_RGB;
            source.depth = 8;
            source.pixels = data.as_mut_ptr();
            source.rowBytes = (width * 3) as u32;

            let status = raw::avifImageYUVToRGB(image, &mut source);
            if status != AVIF_RESULT_OK {
                return Err(format!("libavif could not convert to RGB: {}", message(status)));
            }
            Ok(Rgb { width, height, data })
        })();
        raw::avifImageDestroy(image);
        raw::avifDecoderDestroy(decoder);
        result
    }
}

/// Encodes one frame as an AVIF still and hands back the file.
///
/// `pq` is interleaved 16-bit Rec.2020 RGB in the PQ transfer, as `frame.wgsl`'s `encode`
/// leaves it. What comes out of that is what libavif's own converter takes to YCbCr, so
/// the matrix and the limited-range quantisation stay libavif's rather than being
/// written a second time here.
///
/// `Cow` rather than a slice, and that is the memory knob rather than a signature
/// preference: an owned frame is handed straight to libavif and dropped as soon as the
/// YUV conversion has read it.
///
/// Only one frame of this is left live by the time libaom runs, and libaom's own working
/// set - ~700MB for a 24MP 10-bit 4:4:4 all-intra frame, five times ours - is what
/// actually sets the peak. Multiply by `processing_concurrency` on a machine that starts
/// OOM-killing; DESIGN 10.7 has the measurements.
///
/// Bytes rather than a path because the browser has neither (DESIGN 21.3). The frame is
/// what costs; the encoded file is single-digit MB, so carrying it back through a `Vec`
/// is not the copy worth avoiding.
pub fn encode_still(
    pq: std::borrow::Cow<'_, [u16]>,
    width: usize,
    height: usize,
    options: &StillOptions,
) -> Result<Vec<u8>, String> {
    if pq.len() < width * height * 3 {
        return Err(format!("frame is {} samples, expected {}", pq.len(), width * height * 3));
    }
    encode_avif(pq, 16, AVIF_RANGE_LIMITED, width, height, AVIF_DEPTH, options.format,
        &options.cicp, (options.quantizer, options.quantizer), options.speed)
}

/// `encode_still` to a file, for the renditions.
pub fn save_still(
    pq: std::borrow::Cow<'_, [u16]>,
    width: usize,
    height: usize,
    options: &StillOptions,
    out_path: &str,
) -> Result<(), String> {
    let file = encode_still(pq, width, height, options)?;
    std::fs::write(out_path, file).map_err(|e| format!("could not write {out_path}: {e}"))
}

/// An 8-bit sRGB rendition, straight to disk.
///
/// The other half of what `bb_save_avif` used to hand to libvips. Nothing to transfer
/// and no gamut to convert: the 8-bit decode already produced display-referred sRGB,
/// so the pixels go to libavif exactly as they arrive and only the YCbCr matrix is left.
/// Tagged sRGB rather than left bare, since a file that says what it is costs nine bytes.
///
/// `full_chroma` is the `sdr_full_chroma` setting, 4:2:0 by default for the reasons
/// DESIGN 10.1 measures. Unlike the HDR still there is no even-dimension problem to
/// go with it: libavif is handed the frame directly rather than through a y4m, and it
/// pads odd chroma itself.
pub fn encode_rendition(
    rgb8: std::borrow::Cow<'_, [u8]>,
    width: usize,
    height: usize,
    quantizer: i32,
    speed: i32,
    full_chroma: bool,
    out_path: &str,
) -> Result<(), String> {
    if rgb8.len() < width * height * 3 {
        return Err(format!("frame is {} bytes, expected {}", rgb8.len(), width * height * 3));
    }
    // sRGB primaries, sRGB transfer, BT.601 matrix - which is what libheif was writing.
    let cicp = Cicp { primaries: 1, transfer: 13, matrix: 6 };
    let format = match full_chroma {
        true => AVIF_PIXEL_FORMAT_YUV444,
        false => AVIF_PIXEL_FORMAT_YUV420,
    };
    let file = encode_avif(rgb8, 8, AVIF_RANGE_FULL, width, height, 8, format, &cicp, (quantizer, quantizer), speed)?;
    std::fs::write(out_path, file).map_err(|e| format!("could not write {out_path}: {e}"))
}

/// Hands interleaved RGB to libavif and returns the file it builds.
///
/// Never copies the frame: `avifRGBImage.pixels` points into `rgb`.
///
/// `Cow` so an owned frame can be **dropped as soon as the YUV conversion has read
/// it**, which is the peak that matters rather than a tidiness point. libaom allocates
/// its own working set - measured at ~560MB for a 24MP 10-bit 4:4:4 all-intra frame,
/// and near enough flat in the thread count, so it is per-frame state rather than
/// anything tiling can be traded against. Holding the RGB across `avifEncoderWrite`
/// stacked a whole frame under that for no reader: 145MB at 24MP, 366MB at 61MP.
#[allow(clippy::too_many_arguments)]
fn encode_avif<T: Clone>(
    rgb: std::borrow::Cow<'_, [T]>,
    rgb_depth: u32,
    range: u32,
    width: usize,
    height: usize,
    depth: u32,
    format: u32,
    cicp: &Cicp,
    // Both ends of libavif's quantizer pair, and a pair rather than one number because
    // it is what the encoder is actually given: libavif quantises on the *midpoint* of
    // the two, so a caller that names only one end has already decided something it
    // probably did not mean to. Production passes the same value twice; the test that
    // pins the midpoint rule is the one caller that does not.
    quantizers: (i32, i32),
    speed: i32,
) -> Result<Vec<u8>, String> {
    // SAFETY: every pointer below is either freshly created by libavif or points into
    // `rgb`, which outlives the call. The image is destroyed on every path.
    #[expect(unsafe_code)]
    unsafe {
        let image = raw::avifImageCreate(width as u32, height as u32, depth, format);
        if image.is_null() {
            return Err("libavif would not allocate an image".to_string());
        }
        let result = (|| -> Result<Vec<u8>, String> {
            (*image).yuvRange = range;
            (*image).colorPrimaries = cicp.primaries;
            (*image).transferCharacteristics = cicp.transfer;
            (*image).matrixCoefficients = cicp.matrix;

            // Borrowed, not copied: `rgb.pixels` points into the caller's frame.
            let mut source = std::mem::zeroed::<raw::avifRGBImage>();
            raw::avifRGBImageSetDefaults(&mut source, image);
            source.format = AVIF_RGB_FORMAT_RGB;
            source.depth = rgb_depth;
            source.pixels = rgb.as_ptr() as *mut u8;
            source.rowBytes = (width * 3 * (rgb_depth as usize / 8)) as u32;

            let status = raw::avifImageRGBToYUV(image, &source);
            if status != AVIF_RESULT_OK {
                return Err(format!("libavif could not convert to YUV: {}", message(status)));
            }
            // The planes hold everything now, and `source.pixels` is not read again -
            // `avifEncoderWrite` works off `image`. So the frame goes back before the
            // encoder asks for its own, rather than sitting under it.
            drop(rgb);

            let encoder = raw::avifEncoderCreate();
            if encoder.is_null() {
                return Err("libavif would not allocate an encoder".to_string());
            }
            let written = (|| -> Result<Vec<u8>, String> {
                (*encoder).maxThreads = max_threads();
                (*encoder).speed = speed;
                // Both ends, not `--min 0 --max N`. libavif takes the **midpoint** of
                // the pair, so a floor of 0 quietly halved every quantizer this app
                // asked for - and the video, whose `-crf` libaom reads literally, was
                // encoded at twice the still's. Measured on a 24MP frame at 3840: the
                // still scored SSIM 0.9802 against a near-lossless reference where its
                // twin scored 0.9529, which is the blocking and chroma loss that made
                // this findable at all.
                (*encoder).minQuantizer = quantizers.0;
                (*encoder).maxQuantizer = quantizers.1;
                // libaom parallelises across tiles, so without them the threads idle.
                (*encoder).autoTiling = 1;

                let mut output = std::mem::zeroed::<raw::avifRWData>();
                let status = raw::avifEncoderWrite(encoder, image, &mut output);
                // Copied out inside the free, so the bytes are still there to read.
                // Freed whatever the status: a write that fails part way has already
                // allocated, and `avifRWDataFree` is defined on a zeroed struct, so the
                // ordering costs nothing and the alternative leaks however much of the
                // file got built.
                let done = match (status, output.data.is_null()) {
                    (AVIF_RESULT_OK, false) => {
                        Ok(std::slice::from_raw_parts(output.data, output.size).to_vec())
                    }
                    (AVIF_RESULT_OK, true) => Err("libavif returned no bytes".to_string()),
                    _ => Err(format!("libavif could not encode: {}", message(status))),
                };
                raw::avifRWDataFree(&mut output);
                done
            })();
            raw::avifEncoderDestroy(encoder);
            written
        })();
        raw::avifImageDestroy(image);
        result
    }
}

/// libavif's own words for a failure, rather than a number.
#[expect(unsafe_code)]
unsafe fn message(status: u32) -> String {
    let text = unsafe { raw::avifResultToString(status) };
    if text.is_null() {
        return format!("result {status}");
    }
    unsafe { std::ffi::CStr::from_ptr(text) }.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_smaller_than_it_claims_is_refused_rather_than_read_past() {
        let options = StillOptions {
            cicp: Cicp { primaries: 9, transfer: 16, matrix: 9 },
            format: AVIF_PIXEL_FORMAT_YUV444,
            quantizer: 20,
            speed: 8,
        };
        let short = vec![0u16; 8 * 8 * 3 - 1];
        assert!(encode_still(short.into(), 8, 8, &options).is_err());
    }

    /// The rendition path both ways: what `encode_rendition` writes is what a download
    /// reads back, which is the only reason `decode` exists.
    #[test]
    fn a_rendition_decodes_back_to_the_pixels_it_was_written_from() {
        let dir = std::env::temp_dir().join("bb-avif-round-trip");
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let path = dir.join("rendition.avif");
        let (width, height) = (48usize, 32usize);
        let mut frame = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                frame[i] = (x * 255 / width) as u8;
                frame[i + 1] = (y * 255 / height) as u8;
                frame[i + 2] = 96;
            }
        }

        // Lossless-ish and full chroma, so what comes back is the encode's own error and
        // not 4:2:0's. `decode` is what is under test, not libaom's rate control.
        encode_rendition(
            std::borrow::Cow::Borrowed(&frame),
            width,
            height,
            0,
            10,
            true,
            path.to_str().expect("a path"),
        )
        .expect("the encode");

        let decoded = decode(&std::fs::read(&path).expect("the file")).expect("the decode");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((decoded.width, decoded.height), (width, height));
        let worst = frame
            .iter()
            .zip(decoded.data.iter())
            .map(|(wrote, read)| wrote.abs_diff(*read))
            .max()
            .expect("pixels");
        assert!(worst <= 4, "the round trip moved a channel by {worst} of 255");
    }

    #[test]
    fn bytes_that_are_not_an_avif_are_an_error_rather_than_a_panic() {
        assert!(decode(b"").is_err());
        assert!(decode(&[0u8; 64]).is_err());
    }

    /// libavif quantises on the **midpoint** of the quantizer pair, which is the claim
    /// the whole rescale rests on (§10.7): `min 0 / max 2N` and `min N / max N` have to
    /// be the same encode, or halving every default and migrating every tuned value
    /// silently moved the quality of every rendition this app writes.
    ///
    /// It was established by running `avifenc` at both settings and comparing file sizes.
    /// That is a fact about the linked library's version, not about this code - libavif
    /// only derives `quality` from the pair when `quality` is left at its default, and a
    /// build against 0.x would send min and max to the encoder directly and break the
    /// equivalence with nothing to say so. So it is asserted where it can fail loudly.
    #[test]
    fn the_quantizer_pair_is_read_as_its_midpoint() {
        // Something with detail to spend bits on: a flat frame encodes to the same few
        // bytes at any quantizer and would pass this without meaning anything.
        let (width, height) = (64usize, 64usize);
        let mut frame = vec![0u16; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                frame[i] = ((x * 977 + y * 631) % 65536) as u16;
                frame[i + 1] = ((x * 331 + y * 1181) % 65536) as u16;
                frame[i + 2] = ((x * 1499 + y * 173) % 65536) as u16;
            }
        }

        let encode = |min: i32, max: i32| {
            encode_avif(
                std::borrow::Cow::Borrowed(&frame),
                16,
                AVIF_RANGE_LIMITED,
                width,
                height,
                AVIF_DEPTH,
                AVIF_PIXEL_FORMAT_YUV444,
                &Cicp { primaries: 9, transfer: 16, matrix: 9 },
                (min, max),
                10,
            )
            .expect("the encode")
        };

        let pair = encode(0, 26);
        let midpoint = encode(13, 13);
        let tighter = encode(6, 6);

        assert_eq!(pair, midpoint, "min 0 / max 26 is not the same encode as min 13 / max 13");
        // And that the knob does something at all, so the equality above cannot be two
        // encodes that ignored their quantizers.
        assert_ne!(midpoint, tighter, "the quantizer changed nothing");
    }
}
