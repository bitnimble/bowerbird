// JPEG, in and out. Two pure-Rust crates where libvips used to be.
//
// ============================================================================================
// JPEG IS FOR PIXELS LEAVING THE APPLICATION. NEVER FOR TRANSPORT INSIDE IT.
// ============================================================================================
//
// The line is who opens the file. A download is on its way to somebody else's software, where
// JPEG's universality is the whole point and is worth what it costs. Anything this application
// hands to itself - a tile, a preview, a frame for a harness to look at - has an AVIF decoder
// waiting at the other end, so there is nothing to buy and a real amount to lose.
//
// What it loses: JPEG is 8-bit and cannot carry PQ, so encoding through here bakes in the
// roll-off and clips the highlights. That never surfaces as a failure. It surfaces as a picture
// that looks slightly flat and a reader who believes it - the loupe's tiles were JPEG for
// exactly this reason, and it made the glass disagree with the stage underneath it while both
// were, as far as any test could tell, working.
//
// So: `decode` for a camera's own embedded JPEG, which is the one JPEG this library genuinely
// handles and which arrives from someone else's encoder. `encode` from `bb_transcode_jpeg`, the
// download an SDR library offers for compatibility - an HDR library's download hands back the
// AVIF untouched, since transcoding it would ship a tone-map and call it the render.
//
// And from `fixture_tests`, which manufactures a stand-in for that embedded JPEG so the lens fit
// has a target with a known falloff or distortion in it. The fit reads JPEG bytes because a
// camera hands it JPEG bytes, so a test that wants to control what it sees has to encode one.
//
// Writing a picture out to look at? `avif::encode_rendition` for 8-bit, `avif::encode_still`
// for PQ. Both are as easy to open as a JPEG and neither loses the thing being examined.
//
// libvips was reached for because it was already linked, and by the time the resampling
// and filtering moved to `image` and `fit` it was carrying three calls: this decode, this
// encode, and reading our own AVIF renditions back (`avif::decode`). What that cost was
// not the library - 3MB - but its closure: 29 packages the rest of the app does not
// touch, ImageMagick, poppler, OpenEXR, HDF5, NSS, cfitsio and matio among them, ~34MB in
// the runtime image and a PDF renderer's worth of attack surface for a photo server.
//
// It is close to free to leave, because the shape of the work suits an ordinary decoder:
//
//   decode to 800px    38ms CPU against libvips' 32ms, deviation mean 0.25 of 255, worst 4
//   decode to 1280px   38ms against 34ms, mean 0.26, worst 7
//   decode whole       230ms against 303ms, mean 0.02, worst 4
//   encode 1280px      10.0ms against 6.7ms, byte-for-byte within 0.2%
//   encode 6000x4000   197ms against 70ms, same
//
// Single-threaded against a libvips that spreads over the machine, which is why the whole
// decode wins on CPU and loses on wall time. Neither figure is on a hot path: every
// production decode is a shrink-on-load to the fit grid, where the two are a wash, and the
// full-size encode happens once per manual download.
//
// One decoder, for everybody. There were two for a while - this one behind the server's fit
// and the browser's own behind the editor's - and the editor's went with the wasm build: a
// shell fetches the RAW and prepares it through `edit::fit`, which reads the embedded preview
// through here, so no client decodes anything any more.

use crate::rgb::{Rgb, RgbRef};

/// Decodes a JPEG, bounded to `long_edge` on its longest side. 0 decodes it whole.
///
/// Bounded rather than whole-then-resize because the saving is not marginal. A 61MP body
/// embeds a *full-resolution* preview - 9504x6336, 5-14MB of JPEG - and the grid tile is
/// 800px, so decoding it whole spends ~250-540ms to discard 99% of what it produced.
/// libjpeg's 1/2, 1/4 and 1/8 DCT scaling is the way out of that, and `Decoder::scale`
/// picks the coarsest of those factors that still covers the request.
///
/// Going all the way to the target rather than leaving the reduce a factor of two to work
/// with is a deliberate quality trade. The scaled IDCT and a Lanczos3 reduce are different
/// filters, so shifting work between them moves the result: against decoding whole and
/// reducing once, an 800px tile goes from deltaE 0.29 mean to 0.63, and its worst pixels
/// from 7 to 24. That error is confined to fine detail where the two filters disagree -
/// foliage, not sky - and at tile size it is not visible even under a 1:1 crop.
///
/// EXIF orientation is applied, so callers get the picture the way it was shot. A render
/// never needs this - the decode bakes the rotation in - but an embedded preview is stored the
/// way the sensor read it.
pub fn decode(bytes: &[u8], long_edge: usize) -> Result<Rgb, String> {
    let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(bytes));
    decoder.read_info().map_err(|e| format!("not a readable JPEG: {e}"))?;

    if long_edge > 0 {
        // The bound on **both** axes, not a proportional pair. `scale` takes the smallest
        // factor covering *either* axis, so a square request is exactly the longest-axis
        // test, while a proportional one lets the floored short edge satisfy that `or` a
        // factor early: 6392x4261 asked for (800, 533) comes back 799x533, under the
        // bound, because 533 was already met at 1:1.
        let edge = u16::try_from(long_edge).unwrap_or(u16::MAX);
        decoder
            .scale(edge, edge)
            .map_err(|e| format!("the JPEG would not scale during the decode: {e}"))?;
    }

    let pixels = decoder.decode().map_err(|e| format!("the JPEG would not decode: {e}"))?;
    let scaled = decoder.info().ok_or("the JPEG has no frame header")?;
    // Read before the pixels are moved: the decoder holds the APP1 payload, not the frame.
    let turn = decoder.exif_data().map(orientation).unwrap_or(Orientation::AsStored);

    // Renditions and fits are all 3-band, and an embedded preview is occasionally
    // greyscale, so normalise rather than trusting the source. CMYK is refused rather
    // than guessed at: it needs the ICC profile to mean anything, no camera writes one
    // here, and a wrong conversion would look like a colour bug much further downstream.
    let data = match scaled.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => pixels,
        jpeg_decoder::PixelFormat::L8 => pixels.iter().flat_map(|v| [*v, *v, *v]).collect(),
        jpeg_decoder::PixelFormat::L16 => {
            return Err("16-bit greyscale JPEG is not supported".to_string());
        }
        jpeg_decoder::PixelFormat::CMYK32 => return Err("CMYK JPEG is not supported".to_string()),
    };

    let decoded = Rgb { width: usize::from(scaled.width), height: usize::from(scaled.height), data };
    // The DCT gets within a factor of two; a proper reduce finishes the job. Reduced
    // before the rotation rather than after, so the transpose moves the smaller image - on
    // a 60MP portrait preview that ordering is most of the cost of the call. Both stages
    // take the frame by value and hand back the same one when there is nothing to do,
    // because an unbounded decode of that preview is 170MB per copy avoided.
    Ok(turn.applied(crate::image::fitted(decoded, long_edge)))
}

/// Encodes interleaved 8-bit RGB.
///
/// Full chroma, no subsampling. Every caller asks for 90 or better, which is where libvips
/// also wrote 4:4:4 - within 0.2% of the same byte count and the same round-trip error -
/// and a download is the wrong place to throw away chroma to save a tenth of the pixels.
pub fn encode(image: RgbRef<'_>, quality: i32) -> Result<Vec<u8>, String> {
    let expected = image.width * image.height * 3;
    if image.data.len() < expected {
        return Err(format!("buffer is {} bytes, expected {expected}", image.data.len()));
    }
    let (Ok(width), Ok(height)) = (u16::try_from(image.width), u16::try_from(image.height)) else {
        return Err(format!("JPEG cannot hold a {}x{} image", image.width, image.height));
    };

    let mut out = Vec::new();
    let mut encoder = jpeg_encoder::Encoder::new(&mut out, quality.clamp(1, 100) as u8);
    encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::F_1_1);
    encoder
        .encode(&image.data[..expected], width, height, jpeg_encoder::ColorType::Rgb)
        .map_err(|e| format!("the JPEG would not encode: {e}"))?;
    Ok(out)
}

/// EXIF orientation: how the frame is stored against how it was shot.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Orientation {
    AsStored,
    FlipHorizontal,
    Rotate180,
    FlipVertical,
    Transpose,
    Rotate90,
    Transverse,
    Rotate270,
}

impl Orientation {
    fn from_tag(tag: u16) -> Self {
        match tag {
            2 => Self::FlipHorizontal,
            3 => Self::Rotate180,
            4 => Self::FlipVertical,
            5 => Self::Transpose,
            6 => Self::Rotate90,
            7 => Self::Transverse,
            8 => Self::Rotate270,
            _ => Self::AsStored,
        }
    }

    /// Whether the picture's width and height are the stored frame's the other way round.
    fn swaps_axes(self) -> bool {
        matches!(self, Self::Transpose | Self::Rotate90 | Self::Transverse | Self::Rotate270)
    }

    fn applied(self, frame: Rgb) -> Rgb {
        if self == Self::AsStored {
            return frame;
        }
        let image = frame.as_ref();
        let (width, height) = match self.swaps_axes() {
            true => (image.height, image.width),
            false => (image.width, image.height),
        };
        let mut out = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let (sx, sy) = match self {
                    Self::AsStored => (x, y),
                    Self::FlipHorizontal => (width - 1 - x, y),
                    Self::Rotate180 => (width - 1 - x, height - 1 - y),
                    Self::FlipVertical => (x, height - 1 - y),
                    Self::Transpose => (y, x),
                    Self::Rotate90 => (y, image.height - 1 - x),
                    Self::Transverse => (image.width - 1 - y, image.height - 1 - x),
                    Self::Rotate270 => (image.width - 1 - y, x),
                };
                let from = (sy * image.width + sx) * 3;
                let to = (y * width + x) * 3;
                out[to..to + 3].copy_from_slice(&image.data[from..from + 3]);
            }
        }
        Rgb { width, height, data: out }
    }
}

/// Reads tag 0x0112 out of IFD0, the one field of EXIF this crate needs.
///
/// Parsed here rather than through a metadata crate: `exif` starts at the TIFF header, so
/// this is a byte order, an offset and a walk over 12-byte entries. Anything malformed
/// reads as "as stored", which is also what a frame with no orientation means.
///
/// Offsets are added as `u64` because the file supplies them: on a 32-bit target a corrupt
/// IFD pointer near `u32::MAX` would otherwise overflow a `usize` and panic, and this crate
/// keeps overflow checks on in release.
fn orientation(exif: &[u8]) -> Orientation {
    let big_endian = match exif.get(..2) {
        Some(b"MM") => true,
        Some(b"II") => false,
        _ => return Orientation::AsStored,
    };
    let at = |offset: u64, len: u64| -> Option<&[u8]> {
        let start = usize::try_from(offset).ok()?;
        let end = usize::try_from(offset + len).ok()?;
        exif.get(start..end)
    };
    let short = |offset: u64| -> Option<u16> {
        let bytes = at(offset, 2)?.try_into().ok()?;
        Some(match big_endian {
            true => u16::from_be_bytes(bytes),
            false => u16::from_le_bytes(bytes),
        })
    };
    let long = |offset: u64| -> Option<u32> {
        let bytes = at(offset, 4)?.try_into().ok()?;
        Some(match big_endian {
            true => u32::from_be_bytes(bytes),
            false => u32::from_le_bytes(bytes),
        })
    };

    let Some(ifd) = long(4).map(u64::from) else { return Orientation::AsStored };
    let Some(entries) = short(ifd) else { return Orientation::AsStored };
    (0..u64::from(entries))
        .map(|i| ifd + 2 + i * 12)
        .find(|entry| short(*entry) == Some(0x0112))
        .and_then(|entry| match short(entry + 2) {
            // A SHORT sits in the first two bytes of the 4-byte value field, whichever
            // end of it the byte order puts first - so reading one as though the field
            // were a LONG gets 0 on a big-endian file. The spec says SHORT and cameras
            // write SHORT, but a writer that used LONG would silently read as upright.
            Some(3) => short(entry + 8),
            Some(4) => long(entry + 8).and_then(|value| u16::try_from(value).ok()),
            _ => None,
        })
        .map(Orientation::from_tag)
        .unwrap_or(Orientation::AsStored)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(width: usize, height: usize) -> Rgb {
        let mut data = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                data[i] = (x * 255 / width.max(1)) as u8;
                data[i + 1] = (y * 255 / height.max(1)) as u8;
                data[i + 2] = 128;
            }
        }
        Rgb { width, height, data }
    }

    /// A frame with no symmetry in either axis, so every one of the eight transforms
    /// produces a different result.
    fn corners() -> Rgb {
        let mut image = gradient(4, 3);
        image.data[..3].copy_from_slice(&[255, 0, 0]);
        image.data[9..12].copy_from_slice(&[0, 255, 0]);
        image
    }

    fn pixel(image: &Rgb, x: usize, y: usize) -> [u8; 3] {
        let at = (y * image.width + x) * 3;
        [image.data[at], image.data[at + 1], image.data[at + 2]]
    }

    #[test]
    fn round_trips_through_an_encode() {
        let source = gradient(80, 40);
        let encoded = encode(source.as_ref(), 92).unwrap();
        let decoded = decode(&encoded, 0).unwrap();
        assert_eq!((decoded.width, decoded.height), (80, 40));
        assert_eq!(decoded.data.len(), 80 * 40 * 3);
    }

    #[test]
    fn a_decode_fits_inside_the_bound_and_never_enlarges() {
        let jpeg = encode(gradient(1600, 900).as_ref(), 92).unwrap();

        // The bound and the aspect, not the exact rounding: 900/1600*200 is 112.5, and
        // which side of it the reduce lands on is not this module's business.
        let small = decode(&jpeg, 200).unwrap();
        assert_eq!(small.width.max(small.height), 200);
        assert!((small.height as i32 - 113).abs() <= 1, "got {}x{}", small.width, small.height);

        // Bigger than the source: inventing detail here would mean a grid tile upscaled
        // from a small embedded preview.
        let big = decode(&jpeg, 4000).unwrap();
        assert_eq!((big.width, big.height), (1600, 900));
    }

    /// The DCT can only scale by 1/2, 1/4 and 1/8, and a frame that comes back under the
    /// bound cannot be brought up to it: the reduce afterwards only ever shrinks.
    #[test]
    fn the_scaled_decode_never_undershoots_the_bound() {
        // 96x64 shrinks by 1/8 exactly, so each bound lands on a different factor.
        let jpeg = encode(gradient(96, 64).as_ref(), 92).unwrap();
        for (bound, expected) in [(96, 96), (48, 48), (24, 24), (12, 12), (10, 10), (7, 7)] {
            let decoded = decode(&jpeg, bound).unwrap();
            assert_eq!(decoded.width, expected, "bound {bound}");
            assert_eq!(decoded.data.len(), decoded.width * decoded.height * 3);
        }

        // A bound a pixel above what 1:1 covers, which is where asking per axis went
        // wrong: 900/8 met a proportional short-edge request of 113 at 1:1, so the frame
        // came back 200 wide against a bound of 201.
        let oblong = encode(gradient(1600, 900).as_ref(), 92).unwrap();
        for bound in [199, 200, 201, 400, 401] {
            let decoded = decode(&oblong, bound).unwrap();
            assert_eq!(decoded.width, bound, "bound {bound}");
        }
    }

    #[test]
    fn every_orientation_moves_the_frame_where_exif_says() {
        let source = corners();
        // Red is the stored frame's top left, green its top right.
        assert_eq!(pixel(&source, 0, 0), [255, 0, 0]);
        assert_eq!(pixel(&source, 3, 0), [0, 255, 0]);

        for (tag, size, red, green) in [
            (1u16, (4usize, 3usize), (0usize, 0usize), (3usize, 0usize)),
            (2, (4, 3), (3, 0), (0, 0)),
            (3, (4, 3), (3, 2), (0, 2)),
            (4, (4, 3), (0, 2), (3, 2)),
            (5, (3, 4), (0, 0), (0, 3)),
            (6, (3, 4), (2, 0), (2, 3)),
            (7, (3, 4), (2, 3), (2, 0)),
            (8, (3, 4), (0, 3), (0, 0)),
        ] {
            let turned = Orientation::from_tag(tag).applied(corners());
            assert_eq!((turned.width, turned.height), size, "orientation {tag}");
            assert_eq!(pixel(&turned, red.0, red.1), [255, 0, 0], "orientation {tag} red");
            assert_eq!(pixel(&turned, green.0, green.1), [0, 255, 0], "orientation {tag} green");
        }
    }

    #[test]
    fn reads_the_orientation_tag_out_of_either_byte_order() {
        // TIFF header, one IFD entry: tag 0x0112, type SHORT, count 1, value 6.
        let little =
            [b'I', b'I', 0x2A, 0x00, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0];
        let big = [b'M', b'M', 0x00, 0x2A, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0];
        assert_eq!(orientation(&little), Orientation::Rotate90);
        assert_eq!(orientation(&big), Orientation::Rotate90);

        // The same field written as a LONG (type 4), which reads as 0 - and so as
        // upright - if the value is taken as a SHORT regardless of the type.
        let mut long = big;
        long[13] = 4;
        long[19] = 0;
        long[21] = 6;
        assert_eq!(orientation(&long), Orientation::Rotate90);
        // Truncated, empty and non-TIFF payloads all mean "as stored" rather than a panic.
        assert_eq!(orientation(&little[..12]), Orientation::AsStored);
        assert_eq!(orientation(b""), Orientation::AsStored);
        assert_eq!(orientation(b"not exif at all"), Orientation::AsStored);
    }

    #[test]
    fn a_short_buffer_is_refused_rather_than_read_past() {
        let short = RgbRef { width: 64, height: 64, data: &[0u8; 64 * 3] };
        assert!(encode(short, 92).is_err());
    }

    #[test]
    fn a_greyscale_jpeg_comes_back_as_three_bands() {
        // jpeg-encoder writes greyscale from a luma-only buffer.
        let mut out = Vec::new();
        let encoder = jpeg_encoder::Encoder::new(&mut out, 92);
        encoder.encode(&[0u8, 64, 128, 255], 2, 2, jpeg_encoder::ColorType::Luma).unwrap();
        let decoded = decode(&out, 0).unwrap();
        assert_eq!((decoded.width, decoded.height), (2, 2));
        assert_eq!(decoded.data.len(), 2 * 2 * 3);
        for pixel in decoded.data.chunks_exact(3) {
            assert_eq!(pixel[0], pixel[1], "greyscale stays neutral");
            assert_eq!(pixel[1], pixel[2], "greyscale stays neutral");
        }
    }

    #[test]
    fn bytes_that_are_not_a_jpeg_are_an_error_rather_than_a_panic() {
        assert!(decode(b"", 0).is_err());
        assert!(decode(&[0xFF, 0xD8, 0, 1, 2, 3], 800).is_err());
    }
}
