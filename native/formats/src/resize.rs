use units::rgb::{Rgb, RgbRef};

/// Lanczos3 reduce onto an exact grid, on the host.
///
/// **A warp is not a substitute, and reaching for one here was a real bug.** A bilinear
/// gather reads two taps per axis, so reducing 6000x4000 to 1280 with it reads four of every
/// hundred source pixels and aliases the rest into the result: against this reduce it came
/// out mean 12.4 of 255 off, worst 241. A fit built on those grids picked a different lens
/// tier on IMG_5360 than one built on a real reduce. Two taps are right where a warp *warps*
/// - small displacements on prefiltered pixels - and wrong the moment the grid shrinks.
///
/// Lanczos3 because that is what libvips gave the renditions before this replaced it, and
/// it lands within 1 of 255 of it. Also 17x cheaper in CPU: 15ms against 255ms on that
/// same reduction, since this is a SIMD integer kernel rather than a general tiled
/// float pipeline. Single-threaded: already milliseconds, and the callers are inside their
/// own parallelism.
pub fn resize(source: RgbRef<'_>, width: usize, height: usize) -> Rgb {
    if width == 0 || height == 0 || source.width == 0 || source.height == 0 {
        return Rgb {
            width,
            height,
            data: vec![0u8; width * height * 3],
        };
    }
    if (width, height) == (source.width, source.height) {
        return Rgb {
            width,
            height,
            data: source.data.to_vec(),
        };
    }
    let src = fast_image_resize::images::ImageRef::new(
        source.width as u32,
        source.height as u32,
        source.data,
        fast_image_resize::PixelType::U8x3,
    )
    .unwrap_or_else(|_| {
        panic!(
            "a {}x{} plane needs {} bytes, got {}",
            source.width,
            source.height,
            source.width * source.height * 3,
            source.data.len()
        )
    });
    let mut destination = fast_image_resize::images::Image::new(
        width as u32,
        height as u32,
        fast_image_resize::PixelType::U8x3,
    );
    let options = fast_image_resize::ResizeOptions::new().resize_alg(
        fast_image_resize::ResizeAlg::Convolution(fast_image_resize::FilterType::Lanczos3),
    );
    fast_image_resize::Resizer::new()
        .resize(&src, &mut destination, Some(&options))
        .expect("a resize between two RGB planes of known size");
    Rgb {
        width,
        height,
        data: destination.into_vec(),
    }
}

/// Decodes an encoded file, bounded to `long_edge` on its longest side. 0 decodes it whole.
///
/// Two formats, because two is all this app writes: a JPEG is a camera's embedded preview,
/// an AVIF is one of our own renditions on its way to a download. Sniffed rather than taken
/// from the caller - the callers that need this hold a path, and a library holds more than
/// one format - and refused outright rather than guessed at, since the alternative is a
/// decoder failing deep inside a job with nothing about the file in the message.
///
#[cfg(feature = "renditions")]
/// Server-side only: the bound to a JPEG belongs to `jpeg::decode`, and it is AVIF that
/// needs libavif, which the client does not link.
pub fn decode(bytes: &[u8], long_edge: usize) -> Result<Rgb, String> {
    // The `ftyp` box, at offset 4 because the first four bytes are its own length.
    let is_avif = bytes.len() > 12 && &bytes[4..8] == b"ftyp";
    match (bytes.starts_with(&[0xFF, 0xD8]), is_avif) {
        (true, _) => crate::jpeg::decode(bytes, long_edge),
        (_, true) => crate::avif::decode(bytes).map(|image| fitted(image, long_edge)),
        _ => Err("not a JPEG or an AVIF".to_string()),
    }
}

/// Longest-edge fit, preserving aspect. 0 leaves the image alone.
///
/// Only ever shrinks. Nothing here wants an enlargement - a rendition is bounded by the
/// frame it came from - and a body that embeds a preview smaller than the bound would
/// otherwise have it upscaled into invented detail.
/// `resize_to_fit` for a frame the caller owns, handing it straight back when it already
/// fits. Worth its own function because the copy it avoids is the whole frame - an
/// unbounded decode of a 61MP embedded preview is 170MB of it.
pub fn fitted(frame: Rgb, long_edge: usize) -> Rgb {
    match long_edge {
        0 => frame,
        edge if frame.width.max(frame.height) <= edge => frame,
        edge => resize_to_fit(frame.as_ref(), edge),
    }
}

pub fn resize_to_fit(source: RgbRef<'_>, long_edge: usize) -> Rgb {
    let longest = source.width.max(source.height);
    if long_edge == 0 || longest <= long_edge {
        return Rgb {
            width: source.width,
            height: source.height,
            data: source.data.to_vec(),
        };
    }
    let scaled = |dimension: usize| {
        usize::try_from(dimension as u64 * long_edge as u64 / longest as u64)
            .expect("a resized dimension must fit the address space")
            .max(1)
    };
    resize(source, scaled(source.width), scaled(source.height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resizes_to_a_long_edge_keeping_aspect() {
        let source = ramp(400, 200);
        let out = resize_to_fit(source.as_ref(), 100);
        assert_eq!((out.width, out.height), (100, 50));
        assert_eq!(out.data.len(), 100 * 50 * 3);
    }

    #[test]
    fn resize_to_fit_only_ever_shrinks() {
        let source = ramp(400, 200);
        for long_edge in [0, 400, 4000] {
            let out = resize_to_fit(source.as_ref(), long_edge);
            assert_eq!((out.width, out.height), (400, 200), "long edge {long_edge}");
            assert_eq!(out.data, source.data, "long edge {long_edge}");
        }
    }

    /// A reduce has to actually filter, not point-sample: a two-tap gather reads four of
    /// every hundred source pixels at this ratio and came out mean 12.4 of 255 from a real
    /// reduce, which is what put the fit on the wrong lens tier.
    #[test]
    fn a_reduce_averages_the_pixels_it_skips() {
        // Alternating columns: any filter with support averages them to the midpoint,
        // while a point sample lands on one column or the other.
        let (width, height) = (640usize, 8usize);
        let mut data = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let level = if x % 2 == 0 { 40 } else { 200 };
                data[(y * width + x) * 3..(y * width + x) * 3 + 3].fill(level);
            }
        }
        let source = Rgb {
            width,
            height,
            data,
        };

        let reduced = resize(source.as_ref(), 80, height);
        let midpoint = 120i32;
        let worst = reduced
            .data
            .iter()
            .map(|v| (i32::from(*v) - midpoint).abs())
            .max()
            .unwrap();
        assert!(
            worst <= 8,
            "a reduce should average the columns it drops, worst was {worst} off"
        );
    }

    fn ramp(width: usize, height: usize) -> Rgb {
        let mut data = vec![0u8; width * height * 3];
        for (i, byte) in data.iter_mut().enumerate() {
            *byte = (i % 251) as u8;
        }
        Rgb {
            width,
            height,
            data,
        }
    }
}
