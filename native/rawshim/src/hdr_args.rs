// The command lines the HDR renditions are built with (DESIGN 10.7).
//
// Ported from TypeScript with the rest of the HDR encode, so the samples never
// cross the FFI boundary. The reasoning behind each flag came with it, because
// that reasoning is the reason the flags are what they are: every one of them was
// arrived at by watching a browser refuse to treat a file as HDR.

// There is one transfer, and no enum for it. PQ is absolute where HLG is relative to the
// display's own range, which makes HLG the wrong curve for judging whether a panel reaches a
// given nits value.

// There is one medium, and no enum for it. A one-frame AV1 in MP4 is a container away from the
// AVIF still - the same graded frame through the same encoder at the same settings - so Firefox,
// which honours no HDR image tagging, rewraps the file it is already served (§10.7).

use formats::still::{Chroma, ContentLight, Size, decodable, fitted};

#[derive(Clone)]
pub struct EncodeOptions {
    pub still_chroma: Chroma,
    pub output_path: String,
    pub grade: crate::hdr::Grade,
    /// Constant-quality level; lower is better and slower.
    pub crf: i32,
    /// Encoder speed, 0 slowest, clamped to libavif's 10.
    pub preset: i32,
    /// The defringe, the two denoises and the fraction of the deconvolution to blend in,
    /// all applied to the graded frame after the transfer and before either encoder sees it
    /// (§10.9). None is scaled here: how much noise the frame has is measured off its own
    /// pixels where the filters run.
    pub strengths: crate::image::Strengths,
    /// The sigma the deconvolution undoes, already composed for this target's scale
    /// ([`crate::image::deconvolve_split`]); None is the fixed default.
    pub sharpen_sigma: Option<f32>,
    /// Longest edge of the output. Infinite means "whatever the frame is".
    pub max_edge: f64,
    /// What the graded frame measured, written as the still's `clli`; none where nothing measured it.
    pub content_light: Option<ContentLight>,
}

/// What this rendition ends up as: the requested edge, inside what an AVIF reader will open, and
/// rounded to what the chroma can carry.
///
/// `fitted` hands back the frame untouched when nothing needs shrinking, and a decode
/// can arrive odd - the masked-border crop takes asymmetric insets off it - so a
/// native-resolution 4:2:0 encode could be asked for an odd width and refuse outright.
/// `decodable` can leave one odd too, shrinking to the reader's limit.
pub fn target_size(width: u32, height: u32, options: &EncodeOptions) -> Size {
    let size = decodable(fitted(width, height, options.max_edge));
    if !options.still_chroma.subsampled() {
        return size;
    }
    // Down to even, never up. `even` rounds to nearest, which is right inside `fitted`
    // where the number is already below the source, and wrong here: a 533-row frame
    // would be asked for 534 and the encoder would be upscaling to invent a row. Losing
    // one is the only direction available. A 1 stays 1: `decodable` can shrink a sliver to it,
    // and 0 is no picture at all.
    let even = |v: u32| if v >= 2 { v & !1 } else { v };
    Size {
        width: even(size.width),
        height: even(size.height),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The library's own defaults, which is what the recorded rows were captured with.
    const SHIPPING_GRADE: crate::hdr::Grade = crate::hdr::Grade {
        reference_white_nits: units::light::Light::exactly(203.0),
        white_quantile: 0.9,
    };

    fn options_with(max_edge: f64, still_chroma: Chroma) -> EncodeOptions {
        EncodeOptions {
            still_chroma,
            output_path: "/out/rendition.avif".to_string(),
            grade: SHIPPING_GRADE,
            crf: 8,
            preset: 8,
            strengths: crate::image::Strengths::default(),
            sharpen_sigma: None,
            max_edge,
            content_light: None,
        }
    }

    #[test]
    fn an_odd_frame_loses_a_row_to_subsampled_chroma_rather_than_gaining_one() {
        // 4:2:0 has no odd dimensions, and at native size nothing else is rounding
        // them - the masked-border crop can leave a frame odd. It has to come down:
        // asking a 533-row source for 534 makes the encoder invent a row.
        let subsampled = options_with(f64::INFINITY, Chroma::Yuv420);
        assert_eq!(
            target_size(801, 533, &subsampled),
            Size {
                width: 800,
                height: 532
            }
        );

        // 4:4:4 keeps every pixel it was given.
        let full = options_with(f64::INFINITY, Chroma::Yuv444);
        assert_eq!(
            target_size(801, 533, &full),
            Size {
                width: 801,
                height: 533
            }
        );

        // A sliver the reader's limit shrinks to 1 pixel keeps it.
        assert_eq!(
            target_size(2, 65536, &subsampled),
            Size {
                width: 1,
                height: 32768
            }
        );
    }
}
