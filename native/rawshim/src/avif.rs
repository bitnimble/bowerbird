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
// What ffmpeg was doing here was `zscale`, and it is two things this crate already
// owns: the PQ transfer, which is `tone::pq`, and the Rec.2020 matrix with its
// limited-range quantisation, which is `avifImageRGBToYUV`. So nothing is
// reimplemented that libavif or this crate did not already have.

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
    /// 4:4:4 for a photograph, 4:2:0 for the baseline control.
    pub subsample_420: bool,
    /// libaom's quantizer, which is what avifenc's `--max` set.
    pub quantizer: i32,
    /// avifenc's `--speed`.
    pub speed: i32,
    /// Display peak the graded samples are scaled against, for the PQ transfer.
    pub peak_nits: f64,
}

// avifenc's `--range limited`, and the depth every still is written at.
const AVIF_RANGE_LIMITED: u32 = 0;
const AVIF_DEPTH: u32 = 10;
const AVIF_PIXEL_FORMAT_YUV444: u32 = 1;
const AVIF_PIXEL_FORMAT_YUV420: u32 = 3;
const AVIF_RGB_FORMAT_RGB: u32 = 0;
const AVIF_RESULT_OK: u32 = 0;

/// The graded frame, PQ-encoded, at 16 bits.
///
/// `tone::grade` hands back display-referred linear where full range is the display's
/// peak, which is what `zscale`'s `npl` used to be told. The transfer is applied here
/// instead, off the same curve the grade rolls highlights with, and the result is what
/// libavif's own converter takes to YCbCr - so the matrix and the limited-range
/// quantisation stay libavif's rather than being written out a second time here.
fn pq_encode(graded: &[u16], peak_nits: f64) -> Vec<u16> {
    // One curve covers all 65536 inputs, so the per-sample work is a lookup rather
    // than a pow(): a 24MP frame is 30M samples and a 60MP one 180M.
    let lut: Vec<u16> = (0..=u16::MAX)
        .map(|level| {
            let nits = (f64::from(level) / f64::from(u16::MAX)) * peak_nits;
            (tone::pq(nits) * f64::from(u16::MAX)).round() as u16
        })
        .collect();
    let mut out = vec![0u16; graded.len()];
    out.par_iter_mut().zip(graded.par_iter()).for_each(|(o, s)| *o = lut[*s as usize]);
    out
}

/// Encodes one graded frame as an AVIF still, straight to `out_path`.
///
/// `graded` is interleaved 16-bit RGB, display-referred linear, as `tone::grade` leaves
/// it. Nothing is copied out of it: the PQ pass produces the one buffer libavif reads.
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

    // SAFETY: every pointer below is either freshly created by libavif or points into
    // `encoded`, which outlives the call. The image is destroyed on every path.
    unsafe {
        let format =
            if options.subsample_420 { AVIF_PIXEL_FORMAT_YUV420 } else { AVIF_PIXEL_FORMAT_YUV444 };
        let image = raw::avifImageCreate(width as u32, height as u32, AVIF_DEPTH, format);
        if image.is_null() {
            return Err("libavif would not allocate an image".to_string());
        }
        let result = (|| -> Result<Vec<u8>, String> {
            (*image).yuvRange = AVIF_RANGE_LIMITED;
            (*image).colorPrimaries = options.cicp.primaries;
            (*image).transferCharacteristics = options.cicp.transfer;
            (*image).matrixCoefficients = options.cicp.matrix;

            // Borrowed, not copied: `rgb.pixels` points into `encoded`.
            let mut rgb = std::mem::zeroed::<raw::avifRGBImage>();
            raw::avifRGBImageSetDefaults(&mut rgb, image);
            rgb.format = AVIF_RGB_FORMAT_RGB;
            rgb.depth = 16;
            rgb.pixels = encoded.as_ptr() as *mut u8;
            rgb.rowBytes = (width * 3 * 2) as u32;

            let status = raw::avifImageRGBToYUV(image, &rgb);
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
                (*encoder).speed = options.speed;
                // The quantizer pair avifenc's `--min 0 --max N` set.
                (*encoder).minQuantizer = 0;
                (*encoder).maxQuantizer = options.quantizer;
                // libaom parallelises across tiles, so without them the threads idle.
                (*encoder).autoTiling = 1;

                let mut output = std::mem::zeroed::<raw::avifRWData>();
                let status = raw::avifEncoderWrite(encoder, image, &mut output);
                if status != AVIF_RESULT_OK {
                    return Err(format!("libavif could not encode: {}", message(status)));
                }
                let bytes = std::slice::from_raw_parts(output.data, output.size).to_vec();
                raw::avifRWDataFree(&mut output);
                Ok(bytes)
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
            subsample_420: false,
            quantizer: 20,
            speed: 8,
            peak_nits: 1000.0,
        };
        let short = vec![0u16; 8 * 8 * 3 - 1];
        assert!(encode_still(&short, 8, 8, &options, "/dev/null").is_err());
    }
}
