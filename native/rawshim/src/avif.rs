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
use crate::tone;
use rayon::prelude::*;

/// CICP, the only signalling that matters: what `--cicp 9/16/9` was passing.
pub struct Cicp {
    pub primaries: u16,
    pub transfer: u16,
    pub matrix: u16,
}

pub struct StillOptions {
    pub cicp: Cicp,
    /// libaom's quantizer, which is what avifenc's `--max` set.
    pub quantizer: i32,
    /// avifenc's `--speed`.
    pub speed: i32,
    /// The display peak the grade normalised full range to, which is what the PQ
    /// transfer below has to be told in order to undo it.
    pub peak_nits: f64,
}

// avifenc's `--range limited`, and the depth every HDR still is written at.
const AVIF_RANGE_LIMITED: u32 = 0;
/// What an ordinary 8-bit picture uses, and what libheif was writing. Limited range
/// spends 7% of the code values on headroom a still has no use for, and it costs
/// measurably: the same quantizer scored SSIM 0.878 limited against 0.902 full.
const AVIF_RANGE_FULL: u32 = 1;
const AVIF_DEPTH: u32 = 10;
const AVIF_PIXEL_FORMAT_YUV444: u32 = 1;
const AVIF_RGB_FORMAT_RGB: u32 = 0;
const AVIF_RESULT_OK: u32 = 0;

/// The graded frame PQ-encoded, at 16 bits.
///
/// `tone::grade` hands back display-referred linear where full range is the display's
/// peak, which is what `zscale` was being told through `npl` and `tin=linear`. Only the
/// transfer is left: PQ's output gamut is Rec.2020, which is the space the grade already
/// works in, so nothing has to move between primaries. What comes out is what libavif's
/// own converter takes to YCbCr, so the matrix and the limited-range quantisation stay
/// libavif's rather than being written a second time here.
fn pq_encode(graded: &[u16], peak_nits: f64) -> Vec<u16> {
    // One curve covers all 65536 inputs, so the per-sample work is a lookup rather
    // than a pow(): a 24MP frame is 30M samples and a 60MP one 180M.
    let full = f64::from(u16::MAX);
    let lut: Vec<u16> = (0..=u16::MAX)
        .map(|level| (tone::pq((f64::from(level) / full) * peak_nits) * full).round() as u16)
        .collect();
    let mut out = vec![0u16; graded.len()];
    out.par_iter_mut().zip(graded.par_iter()).for_each(|(o, s)| *o = lut[*s as usize]);
    out
}

/// Encodes one graded frame as an AVIF still, straight to `out_path`.
///
/// `graded` is interleaved 16-bit RGB, display-referred linear, as `tone::grade` leaves
/// it, put into its output transfer and gamut here rather than by a `zscale` in another
/// process.
///
/// **This holds three frames at once**, which is the cost of not spawning anything: the
/// caller's graded buffer, the transfer-encoded copy below, and the 10-bit planes libavif
/// allocates to convert into. At 61MP that is roughly 1.1GB against the ~366MB the old
/// path kept on this side, because the other two used to live in ffmpeg's and avifenc's
/// address spaces and die with them. With `processing_concurrency` workers each holding
/// a decode as well, that is the number to watch on a machine that starts OOM-killing.
pub fn encode_still(
    graded: &[u16],
    width: usize,
    height: usize,
    options: &StillOptions,
    out_path: &str,
) -> Result<(), String> {
    if graded.len() < width * height * 3 {
        return Err(format!("frame is {} samples, expected {}", graded.len(), width * height * 3));
    }
    let encoded = pq_encode(graded, options.peak_nits);
    write_avif(&encoded, 16, AVIF_RANGE_LIMITED, width, height, AVIF_DEPTH,
        AVIF_PIXEL_FORMAT_YUV444, &options.cicp, options.quantizer, options.speed, out_path)
}

/// An 8-bit sRGB rendition, straight to disk.
///
/// The other half of what `bb_save_avif` used to hand to libvips. Nothing to transfer
/// and no gamut to convert: LibRaw's sRGB decode already produced display-referred sRGB,
/// so the pixels go to libavif exactly as they arrive and only the YCbCr matrix is left.
/// Tagged sRGB rather than left bare, since a file that says what it is costs nine bytes.
pub fn encode_rendition(
    rgb8: &[u8],
    width: usize,
    height: usize,
    quantizer: i32,
    speed: i32,
    out_path: &str,
) -> Result<(), String> {
    if rgb8.len() < width * height * 3 {
        return Err(format!("frame is {} bytes, expected {}", rgb8.len(), width * height * 3));
    }
    // sRGB primaries, sRGB transfer, BT.601 matrix - which is what libheif was writing.
    let cicp = Cicp { primaries: 1, transfer: 13, matrix: 6 };
    write_avif(rgb8, 8, AVIF_RANGE_FULL, width, height, 8, AVIF_PIXEL_FORMAT_YUV444, &cicp, quantizer, speed, out_path)
}

/// Hands interleaved RGB to libavif and writes what comes back.
///
/// `rgb` is borrowed, never copied: `avifRGBImage.pixels` points into it, and the only
/// allocation libavif adds is the YUV planes it converts into.
#[allow(clippy::too_many_arguments)]
fn write_avif<T>(
    rgb: &[T],
    rgb_depth: u32,
    range: u32,
    width: usize,
    height: usize,
    depth: u32,
    format: u32,
    cicp: &Cicp,
    quantizer: i32,
    speed: i32,
    out_path: &str,
) -> Result<(), String> {
    // SAFETY: every pointer below is either freshly created by libavif or points into
    // `rgb`, which outlives the call. The image is destroyed on every path.
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

            let encoder = raw::avifEncoderCreate();
            if encoder.is_null() {
                return Err("libavif would not allocate an encoder".to_string());
            }
            let written = (|| -> Result<Vec<u8>, String> {
                (*encoder).maxThreads = std::thread::available_parallelism()
                    .map(|n| n.get() as i32)
                    .unwrap_or(1);
                (*encoder).speed = speed;
                // The quantizer pair avifenc's `--min 0 --max N` set.
                (*encoder).minQuantizer = 0;
                (*encoder).maxQuantizer = quantizer;
                // libaom parallelises across tiles, so without them the threads idle.
                (*encoder).autoTiling = 1;

                let mut output = std::mem::zeroed::<raw::avifRWData>();
                let status = raw::avifEncoderWrite(encoder, image, &mut output);
                // Freed before the status is looked at: a write that fails part way
                // has already allocated, and `avifRWDataFree` is defined on a zeroed
                // struct, so the ordering costs nothing and the alternative leaks
                // however much of the file got built.
                let bytes = match (status, output.data.is_null()) {
                    (AVIF_RESULT_OK, false) => {
                        Ok(std::slice::from_raw_parts(output.data, output.size).to_vec())
                    }
                    (AVIF_RESULT_OK, true) => Err("libavif returned no bytes".to_string()),
                    _ => Err(format!("libavif could not encode: {}", message(status))),
                };
                raw::avifRWDataFree(&mut output);
                bytes
            })();
            raw::avifEncoderDestroy(encoder);
            written
        })();
        raw::avifImageDestroy(image);

        let bytes = result?;
        std::fs::write(out_path, bytes).map_err(|e| format!("could not write {out_path}: {e}"))
    }
}

/// libavif's own words for a failure, rather than a number.
unsafe fn message(status: u32) -> String {
    let text = raw::avifResultToString(status);
    if text.is_null() {
        return format!("result {status}");
    }
    std::ffi::CStr::from_ptr(text).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_transfer_matches_the_curve_the_grade_rolls_highlights_with() {
        // The PQ pass here replaces zscale's, so it has to be the same curve - and it
        // is the one `tone` already uses, which is what makes that checkable at all.
        //
        // Against input *levels* rather than a list of nits: PQ is near-vertical at the
        // bottom, so rounding a nits value to a level and back moves the answer by tens
        // of counts at 1 nit, and a test written that way measures the quantisation
        // rather than the curve.
        let levels: Vec<u16> = [0u16, 1, 66, 13303, 32768, u16::MAX].to_vec();
        let out = pq_encode(&levels, 1000.0);
        for (i, level) in levels.iter().enumerate() {
            let nits = (f64::from(*level) / f64::from(u16::MAX)) * 1000.0;
            let want = (tone::pq(nits) * f64::from(u16::MAX)).round() as u16;
            assert_eq!(out[i], want, "level {level}");
        }
    }

    #[test]
    fn the_display_peak_lands_where_pq_puts_it_rather_than_at_full_scale() {
        // PQ is absolute and its range runs to 10000 nits, so a 1000-nit peak encodes
        // at about 0.752 of the code range and *must not* be stretched to fill it.
        // Normalising it to full scale would be the mistake `npl` exists to prevent:
        // the file would then claim its diffuse white is 10000 nits.
        let ramp: Vec<u16> = (0..=255).map(|i| i * 257).collect();
        let out = pq_encode(&ramp, 1000.0);
        assert_eq!(out[0], 0, "black must stay black");
        let peak = *out.last().expect("a last sample");
        assert_eq!(peak, (tone::pq(1000.0) * f64::from(u16::MAX)).round() as u16);
        assert!((0.74..0.76).contains(&(f64::from(peak) / f64::from(u16::MAX))), "{peak}");
        for i in 1..out.len() {
            assert!(out[i] >= out[i - 1], "not monotone at {i}");
        }
    }

    #[test]
    fn a_frame_smaller_than_it_claims_is_refused_rather_than_read_past() {
        let options = StillOptions {
            cicp: Cicp { primaries: 9, transfer: 16, matrix: 9 },
            quantizer: 20,
            speed: 8,
            peak_nits: 1000.0,
        };
        let short = vec![0u16; 8 * 8 * 3 - 1];
        assert!(encode_still(&short, 8, 8, &options, "/dev/null").is_err());
    }
}
