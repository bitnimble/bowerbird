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
}

/// Primaries, transfer and matrix as CICP numbers (AV1 spec 6.4.2, and the same values
/// AVIF's `colr` box carries): BT.2020, PQ, and the non-constant-luminance BT.2020
/// matrix.
///
/// A function rather than a constant because it is the answer to "what does this file
/// claim to be", and that is worth asking in one place.
pub fn cicp() -> (u16, u16, u16) {
    (9, 16, 9)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

/// yuv420 has no odd dimensions.
fn even(n: f64) -> u32 {
    ((n / 2.0).round() * 2.0).max(2.0) as u32
}

pub fn fitted(width: u32, height: u32, max_edge: f64) -> Size {
    let longest = f64::from(width.max(height));
    let scale = (max_edge / longest).min(1.0);
    if scale == 1.0 {
        return Size { width, height };
    }
    Size { width: even(f64::from(width) * scale), height: even(f64::from(height) * scale) }
}

/// What this rendition ends up as: the requested edge, rounded to what the chroma can
/// carry.
///
/// `fitted` hands back the frame untouched when nothing needs shrinking, and a decode
/// can arrive odd - the masked-border crop takes asymmetric insets off it - so a
/// native-resolution 4:2:0 encode could be asked for an odd width and refuse outright.
/// Which makes the rounding a native-resolution concern alone: nothing else here can
/// produce an odd number.
pub fn target_size(width: u32, height: u32, options: &EncodeOptions) -> Size {
    let size = fitted(width, height, options.max_edge);
    if !options.still_chroma.subsampled() {
        return size;
    }
    // Down to even, never up. `even` rounds to nearest, which is right inside `fitted`
    // where the number is already below the source, and wrong here: a 533-row frame
    // would be asked for 534 and the encoder would be upscaling to invent a row. Losing
    // one is the only direction available.
    Size { width: size.width & !1, height: size.height & !1 }
}

/// The still's chroma, which is the `hdr_still_full_chroma` setting.
///
/// 4:2:0 by default, and that is a memory decision rather than a quality one. It keeps
/// luma whole and drops chroma to a quarter of the samples, which is measurably worse
/// per byte on a photograph - held to equal SSIM it needs 51% more of them - but it
/// roughly halves what libaom carries, and the encoder is the peak (DESIGN 10.7).
/// 4:4:4 is there for a library that would rather spend the memory.
///
/// Not identity/RGB either way: RGB compresses worse than decorrelated YCbCr, and AVIF
/// only carries it at 4:4:4.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Chroma {
    Yuv420,
    Yuv444,
}

impl Chroma {
    #[cfg(feature = "renditions")]
    pub fn avif_format(self) -> crate::raw::avifPixelFormat {
        match self {
            Chroma::Yuv420 => 3,
            Chroma::Yuv444 => 1,
        }
    }

    fn subsampled(self) -> bool {
        self == Chroma::Yuv420
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    /// The library's own defaults, which is what the recorded rows were captured with.
    const SHIPPING_GRADE: crate::hdr::Grade = crate::hdr::Grade {
        peak_nits: crate::light::Light::exactly(1000.0),
        reference_white_nits: crate::light::Light::exactly(203.0),
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
        }
    }

    #[test]
    fn an_oversized_frame_is_fitted_on_both_axes_evenly() {
        let size = fitted(4024, 6024, 3840.0);
        assert_eq!(size, Size { width: 2566, height: 3840 });
        assert_eq!(size.width % 2, 0);
        assert_eq!(size.height % 2, 0);
    }

    #[test]
    fn a_frame_already_inside_the_edge_is_left_alone() {
        assert_eq!(fitted(800, 533, 3840.0), Size { width: 800, height: 533 });
        assert_eq!(fitted(800, 533, f64::INFINITY), Size { width: 800, height: 533 });
    }

    #[test]
    fn an_odd_frame_loses_a_row_to_subsampled_chroma_rather_than_gaining_one() {
        // 4:2:0 has no odd dimensions, and at native size nothing else is rounding
        // them - the masked-border crop can leave a frame odd. It has to come down:
        // asking a 533-row source for 534 makes the encoder invent a row.
        let subsampled = options_with(f64::INFINITY, Chroma::Yuv420);
        assert_eq!(target_size(801, 533, &subsampled), Size { width: 800, height: 532 });

        // 4:4:4 keeps every pixel it was given.
        let full = options_with(f64::INFINITY, Chroma::Yuv444);
        assert_eq!(target_size(801, 533, &full), Size { width: 801, height: 533 });
    }

    /// The triple whose loss is invisible until a browser refuses to treat a file as HDR.
    #[test]
    fn a_still_is_tagged_bt2020_pq() {
        assert_eq!(cicp(), (9, 16, 9), "bt2020 / smpte2084 / bt2020nc");
    }
}
