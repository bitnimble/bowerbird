//! What an HDR still is as a file: its size, its chroma, the CICP it claims and the content light
//! it states.

/// A PQ still's `clli` (CTA-861.3), in the whole nits the box holds.
///
/// The viewer fits a still to a display against `max_cll`, which is why it is rounded up: a
/// `clli` below the brightest pixel is a display told to clip it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentLight {
    pub max_cll: u16,
    pub max_fall: u16,
}

/// What `content_light.slang` summed over a frame, or over the bands of one so far.
#[derive(Clone, Copy, Debug, Default)]
pub struct LightTally {
    pub brightest: f64,
    pub sum: f64,
    pub pixels: usize,
}

impl LightTally {
    pub fn and(self, more: LightTally) -> LightTally {
        LightTally {
            brightest: self.brightest.max(more.brightest),
            sum: self.sum + more.sum,
            pixels: self.pixels + more.pixels,
        }
    }

    pub fn content_light(self) -> ContentLight {
        let nits = |value: f64| value.clamp(0.0, f64::from(u16::MAX)) as u16;
        ContentLight {
            max_cll: nits(self.brightest.ceil()),
            max_fall: nits((self.sum / self.pixels.max(1) as f64).round()),
        }
    }
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
    Size {
        width: even(f64::from(width) * scale),
        height: even(f64::from(height) * scale),
    }
}

/// libavif's `AVIF_DEFAULT_IMAGE_DIMENSION_LIMIT` and `AVIF_DEFAULT_IMAGE_SIZE_LIMIT`, which a
/// decoder may lower and never raise: past either, no libavif reader opens the file, grid or not.
pub const AVIF_MAX_EDGE: u32 = 32768;
pub const AVIF_MAX_PIXELS: u64 = 16384 * 16384;

/// The largest size inside what every AVIF reader will open, at the frame's own aspect.
pub fn decodable(size: Size) -> Size {
    let (width, height) = (f64::from(size.width), f64::from(size.height));
    let scale = (f64::from(AVIF_MAX_EDGE) / width.max(height))
        .min((AVIF_MAX_PIXELS as f64 / (width * height)).sqrt())
        .min(1.0);
    if scale == 1.0 {
        return size;
    }
    // Floored, but past the last bit of `scale`'s error, which otherwise leaves the edge that bound
    // at 32767. The area can then only be over by that same rounding, a row or a column.
    let side = |edge: f64| ((edge * scale + 1e-6) as u32).clamp(1, AVIF_MAX_EDGE);
    let mut fitted = Size {
        width: side(width),
        height: side(height),
    };
    while u64::from(fitted.width) * u64::from(fitted.height) > AVIF_MAX_PIXELS {
        match fitted.width >= fitted.height {
            true => fitted.width -= 1,
            false => fitted.height -= 1,
        }
    }
    fitted
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
            Chroma::Yuv420 => crate::raw::avifPixelFormat::AVIF_PIXEL_FORMAT_YUV420,
            Chroma::Yuv444 => crate::raw::avifPixelFormat::AVIF_PIXEL_FORMAT_YUV444,
        }
    }

    pub fn subsampled(self) -> bool {
        self == Chroma::Yuv420
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tally_rounds_its_brightest_up_and_averages_over_every_band() {
        let first = LightTally {
            brightest: 1200.2,
            sum: 300.0,
            pixels: 3,
        };
        let second = LightTally {
            brightest: 80.0,
            sum: 100.0,
            pixels: 1,
        };
        assert_eq!(
            first.and(second).content_light(),
            ContentLight {
                max_cll: 1201,
                max_fall: 100
            }
        );
        assert_eq!(
            LightTally::default().content_light(),
            ContentLight {
                max_cll: 0,
                max_fall: 0
            }
        );
    }

    #[test]
    fn an_oversized_frame_is_fitted_on_both_axes_evenly() {
        let size = fitted(4024, 6024, 3840.0);
        assert_eq!(
            size,
            Size {
                width: 2566,
                height: 3840
            }
        );
        assert_eq!(size.width % 2, 0);
        assert_eq!(size.height % 2, 0);
    }

    #[test]
    fn a_frame_already_inside_the_edge_is_left_alone() {
        assert_eq!(
            fitted(800, 533, 3840.0),
            Size {
                width: 800,
                height: 533
            }
        );
        assert_eq!(
            fitted(800, 533, f64::INFINITY),
            Size {
                width: 800,
                height: 533
            }
        );
    }

    /// Whichever of libavif's two limits binds first is the one the frame is fitted to, and the
    /// aspect survives both.
    #[test]
    fn a_frame_past_what_avif_opens_is_fitted_inside_it() {
        let wide = decodable(Size {
            width: 36564,
            height: 10562,
        });
        assert!(u64::from(wide.width) * u64::from(wide.height) <= AVIF_MAX_PIXELS);
        assert!(wide.width > 30000, "the area bound first, at {wide:?}");
        assert!((f64::from(wide.width) / f64::from(wide.height) - 36564.0 / 10562.0).abs() < 1e-3);

        for width in [40_000, 49_999, 60_000, 65_537, 99_991] {
            let long = decodable(Size {
                width,
                height: 1000,
            });
            assert_eq!(
                long.width, AVIF_MAX_EDGE,
                "the edge bound first, from {width}"
            );
        }
        for (width, height) in [(20_000, 15_000), (31_111, 9_871), (17_000, 16_999)] {
            let area = decodable(Size { width, height });
            let pixels = u64::from(area.width) * u64::from(area.height);
            assert!(pixels <= AVIF_MAX_PIXELS, "{area:?} from {width}x{height}");
            assert!(
                pixels > AVIF_MAX_PIXELS - 2 * 16384,
                "{area:?} gave away more than a row"
            );
        }

        let inside = Size {
            width: 16384,
            height: 16384,
        };
        assert_eq!(decodable(inside), inside);
    }

    #[cfg(feature = "renditions")]
    #[test]
    fn the_limits_are_libavifs() {
        assert_eq!(
            AVIF_MAX_EDGE,
            crate::raw::AVIF_DEFAULT_IMAGE_DIMENSION_LIMIT
        );
        assert_eq!(
            AVIF_MAX_PIXELS,
            u64::from(crate::raw::AVIF_DEFAULT_IMAGE_SIZE_LIMIT)
        );
    }

    /// The triple whose loss is invisible until a browser refuses to treat a file as HDR.
    #[test]
    fn a_still_is_tagged_bt2020_pq() {
        assert_eq!(cicp(), (9, 16, 9), "bt2020 / smpte2084 / bt2020nc");
    }
}
