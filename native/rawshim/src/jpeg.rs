// JPEG, in and out. Two pure-Rust crates, and no libvips.
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
// One decoder, for everybody. A shell fetches the RAW and prepares it through `edit::fit`,
// which reads the embedded preview through here, so no client decodes a JPEG of its own.

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

/// The same JPEG, carrying `orientation`, without touching a pixel of it.
///
/// **A rotation nobody has to perform.** A camera stores its preview the way the sensor read it
/// and records the turn in the RAW's own EXIF, not the preview's - so standing a portrait frame
/// up meant decoding it, permuting it and re-encoding it. At 1616x1080 that was cheap; on the
/// full-resolution preview it is a 60MP decode and encode, measured at 1.2 seconds against 120ms
/// for the landscape frame beside it, and it spends a generation of quality-95 loss doing it.
///
/// EXIF says the same thing in thirty-six bytes. Every browser honours it - `image-orientation:
/// from-image` is the default - a downloaded file opens the right way up in anything, and
/// [`decode`] reads it back through the same tag, so a caller that does want pixels gets what it
/// got before.
///
/// A preview that already carries an Exif APP1 is edited rather than fronted with a second one:
/// the entry is overwritten where the camera wrote one, and where it did not, IFD0 is rebuilt past
/// the end of the segment, so every value offset the other entries hold still points where it did.
///
/// None only where there is nothing to write into - not a JPEG, EXIF this cannot parse, or an APP1
/// that the extra entry would push over its 64KB ceiling.
pub fn with_orientation(jpeg: &[u8], orientation: u16) -> Option<Vec<u8>> {
    if jpeg.len() < 4 || jpeg[0] != 0xff || jpeg[1] != 0xd8 {
        return None;
    }
    match exif_app1(jpeg) {
        Some((length_at, tiff)) => retagged(jpeg, length_at, tiff, orientation),
        None => spliced(jpeg, orientation),
    }
}

pub fn with_added_rotation(jpeg: &[u8], rotate: u16) -> Option<Vec<u8>> {
    if rotate % 90 != 0 || jpeg.len() < 4 || !jpeg.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    if rotate % 360 == 0 {
        return Some(jpeg.to_vec());
    }
    let current = exif_app1(jpeg)
        .map(|(_, tiff)| orientation(&jpeg[tiff]))
        .unwrap_or(Orientation::AsStored);
    let mut tag = match current {
        Orientation::AsStored => 1,
        Orientation::FlipHorizontal => 2,
        Orientation::Rotate180 => 3,
        Orientation::FlipVertical => 4,
        Orientation::Transpose => 5,
        Orientation::Rotate90 => 6,
        Orientation::Transverse => 7,
        Orientation::Rotate270 => 8,
    };
    let clockwise = [0, 6, 7, 8, 5, 2, 3, 4, 1];
    for _ in 0..rotate % 360 / 90 {
        tag = clockwise[tag];
    }
    with_orientation(jpeg, tag as u16)
}

/// The length field of the Exif APP1, and the TIFF block inside it.
fn exif_app1(jpeg: &[u8]) -> Option<(usize, std::ops::Range<usize>)> {
    let mut at = 2;
    loop {
        if *jpeg.get(at)? != 0xff {
            return None;
        }
        let marker = *jpeg.get(at + 1)?;
        // A run of 0xff is fill; the standalone markers carry no length; and the scan, which
        // starts at SOS, has no header after it worth walking byte by byte.
        if marker == 0xff {
            at += 1;
            continue;
        }
        if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            at += 2;
            continue;
        }
        if marker == 0xda || marker == 0xd9 {
            return None;
        }
        let length = usize::from(u16::from_be_bytes([*jpeg.get(at + 2)?, *jpeg.get(at + 3)?]));
        let payload = at + 4..at + 2 + length.max(2);
        if payload.end > jpeg.len() {
            return None;
        }
        // Inside the segment's own declared length, not merely inside the file: a length short
        // enough to leave no payload would otherwise match six bytes belonging to whatever comes
        // next, and hand back a range that starts after it ends.
        let payload_bytes = jpeg.get(payload.start..payload.end)?;
        if marker == 0xe1 && payload_bytes.starts_with(b"Exif\0\0") {
            return Some((at + 2, payload.start + 6..payload.end));
        }
        at = payload.end;
    }
}

/// The same JPEG with tag 0x0112 written into the EXIF it already has.
fn retagged(
    jpeg: &[u8],
    length_at: usize,
    tiff: std::ops::Range<usize>,
    orientation: u16,
) -> Option<Vec<u8>> {
    let block = &jpeg[tiff.clone()];
    let big_endian = match block.get(..2) {
        Some(b"MM") => true,
        Some(b"II") => false,
        _ => return None,
    };
    let short = |at: usize| -> Option<u16> {
        let bytes = block.get(at..at + 2)?.try_into().ok()?;
        Some(match big_endian {
            true => u16::from_be_bytes(bytes),
            false => u16::from_le_bytes(bytes),
        })
    };
    let long = |at: usize| -> Option<u32> {
        let bytes = block.get(at..at + 4)?.try_into().ok()?;
        Some(match big_endian {
            true => u32::from_be_bytes(bytes),
            false => u32::from_le_bytes(bytes),
        })
    };
    let short_bytes =
        |value: u16| match big_endian { true => value.to_be_bytes(), false => value.to_le_bytes() };
    let long_bytes =
        |value: u32| match big_endian { true => value.to_be_bytes(), false => value.to_le_bytes() };

    let ifd = usize::try_from(long(4)?).ok()?;
    if ifd > block.len() {
        return None;
    }
    let entries = usize::from(short(ifd)?);
    let entry = |i: usize| ifd + 2 + i * 12;
    let next_ifd = entry(entries);
    if next_ifd + 4 > block.len() {
        return None;
    }

    let mut field = Vec::with_capacity(12);
    field.extend_from_slice(&short_bytes(0x0112));
    field.extend_from_slice(&short_bytes(3));
    field.extend_from_slice(&long_bytes(1));
    field.extend_from_slice(&short_bytes(orientation));
    field.extend_from_slice(&[0, 0]);

    let mut out = jpeg.to_vec();
    if let Some(i) = (0..entries).find(|i| short(entry(*i)) == Some(0x0112)) {
        // The whole entry, not its value: a writer that recorded the tag as a LONG would
        // otherwise keep its type over a SHORT's two bytes.
        let at = tiff.start + entry(i);
        out[at..at + 12].copy_from_slice(&field);
        return Some(out);
    }

    let mut rebuilt = Vec::with_capacity(2 + (entries + 1) * 12 + 4);
    rebuilt.extend_from_slice(&short_bytes(u16::try_from(entries + 1).ok()?));
    let mut placed = false;
    for i in 0..entries {
        // IFD entries run in ascending tag order, and a reader is entitled to binary-search them.
        if !placed && short(entry(i))? > 0x0112 {
            rebuilt.extend_from_slice(&field);
            placed = true;
        }
        rebuilt.extend_from_slice(block.get(entry(i)..entry(i) + 12)?);
    }
    if !placed {
        rebuilt.extend_from_slice(&field);
    }
    rebuilt.extend_from_slice(block.get(next_ifd..next_ifd + 4)?);

    let pad = block.len() % 2;
    let placed_at = u32::try_from(block.len() + pad).ok()?;
    let grown = usize::from(u16::from_be_bytes([jpeg[length_at], jpeg[length_at + 1]]))
        + pad
        + rebuilt.len();
    let grown = u16::try_from(grown).ok()?;

    out[tiff.start + 4..tiff.start + 8].copy_from_slice(&long_bytes(placed_at));
    out[length_at..length_at + 2].copy_from_slice(&grown.to_be_bytes());
    out.splice(tiff.end..tiff.end, std::iter::repeat(0).take(pad).chain(rebuilt));
    Some(out)
}

/// The same JPEG with an Exif APP1 in front of it, for one that has none.
fn spliced(jpeg: &[u8], orientation: u16) -> Option<Vec<u8>> {
    // One little-endian TIFF header, one IFD holding one SHORT, and no next IFD.
    let tiff: [u8; 26] = [
        b'I', b'I', 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00,
        0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
        orientation.to_le_bytes()[0], orientation.to_le_bytes()[1], 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
    ];
    // The length field counts itself and the payload, but not the marker.
    let length = (2 + 6 + tiff.len()) as u16;
    let mut out = Vec::with_capacity(jpeg.len() + 2 + usize::from(length));
    out.extend_from_slice(&jpeg[..2]);
    out.extend_from_slice(&[0xff, 0xe1]);
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(b"Exif\0\0");
    out.extend_from_slice(&tiff);
    out.extend_from_slice(&jpeg[2..]);
    Some(out)
}

/// A JPEG's stored size, without decoding a pixel of it.
///
/// `read_info` stops at the frame header, so this costs the few hundred bytes before it rather
/// than the entropy-coded rest - which is what makes choosing between a file's embedded previews
/// affordable: a body writes two or three, and picking the right one otherwise means decoding each.
///
/// As stored, so a portrait frame reads landscape; the caller compares against a long edge, which
/// is the one measure the orientation does not move.
pub fn dimensions(bytes: &[u8]) -> Option<(usize, usize)> {
    let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(bytes));
    decoder.read_info().ok()?;
    let info = decoder.info()?;
    Some((usize::from(info.width), usize::from(info.height)))
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
    fn an_edit_turn_composes_with_every_camera_orientation_without_reencoding() {
        let stored = encode(corners().as_ref(), 95).expect("JPEG encode");
        for tag in 1..=8 {
            let camera = with_orientation(&stored, tag).expect("camera orientation");
            let camera_pixels = decode(&camera, 0).expect("camera JPEG");
            for (degrees, turn) in [
                (90, Orientation::Rotate90),
                (180, Orientation::Rotate180),
                (270, Orientation::Rotate270),
            ] {
                let edited = with_added_rotation(&camera, degrees).expect("edit orientation");
                let actual = decode(&edited, 0).expect("edited JPEG");
                let expected = turn.applied(camera_pixels.clone());
                assert_eq!((actual.width, actual.height, actual.data),
                    (expected.width, expected.height, expected.data), "EXIF {tag}, edit {degrees}");
                assert_eq!(&edited[edited.len() - 32..], &camera[camera.len() - 32..]);
            }
        }
    }

    /// The splice is bytes rather than pixels, so the only thing that can prove it worked is a
    /// decode reading the tag back off it - and the frame arriving turned, at quality the
    /// re-encode it replaces would have spent.
    #[test]
    fn a_spliced_orientation_turns_the_picture_a_decode_gives_back() {
        let stored = encode(corners().as_ref(), 95).unwrap();
        let tagged = with_orientation(&stored, 6).expect("a JFIF preview takes the tag");

        let turned = decode(&tagged, 0).unwrap();
        assert_eq!((turned.width, turned.height), (3, 4), "Rotate90 swaps the axes");

        // The corner marks travel: (0,0) to the top right, and (3,0) to the bottom right.
        // Which channel dominates, not the exact triple - it has been through a lossy encode.
        let [red, green, _] = pixel(&turned, 2, 0);
        assert!(red > 200 && green < 60, "the red corner is top right, got {red},{green}");
        let [red, green, _] = pixel(&turned, 2, 3);
        assert!(green > 200 && red < 60, "the green corner is bottom right, got {red},{green}");

        // And the pixels themselves are untouched - the same entropy-coded scan, moved.
        assert_eq!(&tagged[tagged.len() - 64..], &stored[stored.len() - 64..]);
    }

    /// A camera's preview carries its own EXIF, so the tag has to be written into the segment that
    /// is already there - overwritten where the camera wrote one, added where it did not, and in
    /// both cases without moving the entries whose values sit at offsets further down the block.
    #[test]
    fn an_existing_exif_segment_is_edited_rather_than_fronted() {
        let stored = encode(corners().as_ref(), 95).unwrap();

        // Written once, then written again: the second call finds the entry and replaces it.
        let once = with_orientation(&stored, 3).expect("a JFIF preview takes the tag");
        let twice = with_orientation(&once, 6).expect("its own EXIF takes the tag again");
        assert_eq!(twice.len(), once.len(), "an entry that is there is overwritten in place");
        assert_eq!(decode(&twice, 0).unwrap().width, 3, "Rotate90 swaps the axes");

        // EXIF holding another tag and no orientation, whose value sits past the IFD - which is
        // what the rebuilt IFD0 must not disturb.
        let tiff: [u8; 34] = [
            b'I', b'I', 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
            0x01, 0x00,
            0x1a, 0x01, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x48, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
        ];
        let length = (2 + 6 + tiff.len()) as u16;
        let mut carrying = Vec::new();
        carrying.extend_from_slice(&stored[..2]);
        carrying.extend_from_slice(&[0xff, 0xe1]);
        carrying.extend_from_slice(&length.to_be_bytes());
        carrying.extend_from_slice(b"Exif\0\0");
        carrying.extend_from_slice(&tiff);
        carrying.extend_from_slice(&stored[2..]);

        let tagged = with_orientation(&carrying, 6).expect("EXIF without the tag takes one");
        let turned = decode(&tagged, 0).unwrap();
        assert_eq!((turned.width, turned.height), (3, 4), "Rotate90 swaps the axes");
        // The resolution the other entry points at is still 72/1, and the scan is untouched.
        let exif = tagged.windows(6).position(|w| w == b"Exif\0\0").unwrap() + 6;
        assert_eq!(&tagged[exif + 26..exif + 34], &[0x48, 0, 0, 0, 1, 0, 0, 0]);
        assert_eq!(&tagged[tagged.len() - 64..], &stored[stored.len() - 64..]);
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

        // An APP1 declaring no payload, with the EXIF signature sitting just past its end. Read
        // against the file rather than the segment, those six bytes match and the block they
        // announce begins after it finishes.
        let mut crafted = vec![0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00];
        crafted.extend_from_slice(b"Exif\0\0");
        crafted.extend_from_slice(&encode(gradient(8, 8).as_ref(), 90).unwrap()[2..]);
        with_orientation(&crafted, 6);
    }
}
