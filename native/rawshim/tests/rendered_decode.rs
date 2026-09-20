//! Reading a finished picture off real bytes: what came out, and what the file said it meant.
//!
//! **Encoded here rather than committed as a fixture**, because what these ask about is the
//! *reading*: a file this test wrote is one whose every code value, colour chunk and orientation
//! tag is known exactly, where a photograph from a phone would only say whether something looked
//! right. The formats a fixture is actually needed for - a camera's HEIC, with its grid of tiles
//! and its gain map - are `hevc.rs`'s own tests and the suite behind `--features fixtures`.

use rawshim::decode_rendered;
use rawshim::transfer::Curve;
use rawler::decoders::Orientation;

/// A PNG of `width x height`, eight bits, with whatever the caller sets on the encoder.
fn encode_png(
    width: u32,
    height: u32,
    pixels: &[u8],
    write: impl FnOnce(&mut png::Encoder<'_, &mut Vec<u8>>),
) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        write(&mut encoder);
        let mut writer = encoder.write_header().expect("the header writes");
        writer.write_image_data(pixels).expect("the pixels write");
    }
    out
}

/// One ancillary chunk, spliced in after `IHDR`.
///
/// The encoder writes the chunks it knows and `cICP` is not one of them, so the reader is asked
/// about a chunk assembled here - which is also the only way to be sure the *reader* is what is
/// being tested rather than a round trip through one library's opinion.
fn with_chunk(png: &[u8], kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    // 8 of signature, then IHDR: 4 length, 4 type, 13 data, 4 CRC.
    let at = 8 + 25;
    let mut chunk = Vec::new();
    chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
    chunk.extend_from_slice(kind);
    chunk.extend_from_slice(data);
    let mut crc = 0xFFFF_FFFFu32;
    for byte in kind.iter().chain(data) {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    chunk.extend_from_slice(&(crc ^ 0xFFFF_FFFF).to_be_bytes());

    let mut out = png[..at].to_vec();
    out.extend_from_slice(&chunk);
    out.extend_from_slice(&png[at..]);
    out
}

fn ramp(width: usize, height: usize) -> Vec<u8> {
    (0..width * height)
        .flat_map(|at| [(at * 7 % 256) as u8, (at * 13 % 256) as u8, (at * 29 % 256) as u8])
        .collect()
}

#[test]
fn a_png_comes_back_at_its_own_code_values() {
    let (width, height) = (9usize, 5);
    let pixels = ramp(width, height);
    let file = encode_png(width as u32, height as u32, &pixels, |_| {});

    let read = decode_rendered::read(&file).expect("a readable PNG");
    assert_eq!((read.width, read.height), (width, height));
    assert_eq!(read.coding.depth, 8);
    // No chunk said otherwise, so sRGB is what it is read as.
    assert_eq!(read.coding.curve, Curve::Srgb);
    assert_eq!(read.turn, Orientation::Normal);
    let codes: Vec<u16> = pixels.iter().map(|v| u16::from(*v)).collect();
    assert_eq!(read.codes, codes, "the codes are the file's, unscaled");
}

/// A grey PNG is three channels by the time the pipeline sees it, and an alpha channel is
/// dropped rather than multiplied into the picture.
#[test]
fn a_grey_png_and_an_alpha_png_both_come_back_as_three_channels() {
    let mut grey = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut grey, 2, 1);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("the header writes");
        writer.write_image_data(&[40, 200]).expect("the pixels write");
    }
    let read = decode_rendered::read(&grey).expect("a readable PNG");
    assert_eq!(read.codes, vec![40, 40, 40, 200, 200, 200]);

    let mut alpha = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut alpha, 1, 1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("the header writes");
        writer.write_image_data(&[10, 20, 30, 128]).expect("the pixels write");
    }
    let read = decode_rendered::read(&alpha).expect("a readable PNG");
    assert_eq!(read.codes, vec![10, 20, 30]);
}

/// **Two channels is grey with alpha, and it must not be read as a colour picture.** The demux
/// walked off the end of a 2-channel buffer: pixel 0 came back as grey, alpha, and the *next*
/// pixel's grey, and the last pixel indexed past the slice and panicked - which on the browser
/// build traps the module and kills the editor worker for the session.
///
/// Reachable two ways, and the second is the one nobody would think to write down: a plain
/// greyscale PNG carrying a `tRNS` chunk, which `png`'s `EXPAND` turns into grey-plus-alpha.
#[test]
fn a_grey_png_with_alpha_is_grey_rather_than_a_panic() {
    let mut with_alpha = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut with_alpha, 2, 1);
        encoder.set_color(png::ColorType::GrayscaleAlpha);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("the header writes");
        writer.write_image_data(&[10, 255, 20, 128]).expect("the pixels write");
    }
    let read = decode_rendered::read(&with_alpha).expect("a readable PNG");
    assert_eq!(read.codes, vec![10, 10, 10, 20, 20, 20]);

    // The same picture reached through `tRNS`, which is grey on the way in and grey-plus-alpha by
    // the time the buffer is read.
    let mut transparent = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut transparent, 2, 1);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_trns(vec![0, 10]);
        let mut writer = encoder.write_header().expect("the header writes");
        writer.write_image_data(&[10, 20]).expect("the pixels write");
    }
    let read = decode_rendered::read(&transparent).expect("a readable PNG");
    assert_eq!(read.codes, vec![10, 10, 10, 20, 20, 20]);
}

/// A palette is expanded on the way out, and the buffer that comes back is RGB where the file's
/// own header still says one sample a pixel. Reading the channel count off the header renders a
/// third of the picture, stretched, in the wrong colours - and nothing reports it.
#[test]
fn an_indexed_png_is_read_at_the_channels_the_buffer_actually_has() {
    let mut indexed = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut indexed, 2, 1);
        encoder.set_color(png::ColorType::Indexed);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_palette(vec![10, 20, 30, 200, 210, 220]);
        let mut writer = encoder.write_header().expect("the header writes");
        writer.write_image_data(&[0, 1]).expect("the pixels write");
    }
    let read = decode_rendered::read(&indexed).expect("a readable PNG");
    assert_eq!((read.width, read.height), (2, 1));
    assert_eq!(read.codes, vec![10, 20, 30, 200, 210, 220]);
}

/// A sixteen-bit PNG keeps its depth, so the table is indexed over 65536 codes rather than
/// widening 256 of them and quantising the shadows to an eight-bit ladder.
#[test]
fn a_sixteen_bit_png_is_read_at_sixteen_bits() {
    let mut deep = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut deep, 1, 1);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Sixteen);
        let mut writer = encoder.write_header().expect("the header writes");
        writer.write_image_data(&[0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC]).expect("the pixels write");
    }
    let read = decode_rendered::read(&deep).expect("a readable PNG");
    assert_eq!(read.coding.depth, 16);
    assert_eq!(read.codes, vec![0x1234, 0x5678, 0x9ABC]);
}

/// The `cICP` chunk is exact where every other colour chunk is a declaration, so it is what wins.
#[test]
fn a_pngs_cicp_chunk_decides_its_colour() {
    let pixels = ramp(4, 2);
    // Rec.2020 primaries, PQ, identity matrix, full range.
    let file = with_chunk(&encode_png(4, 2, &pixels, |_| {}), b"cICP", &[9, 16, 0, 1]);
    let read = decode_rendered::read(&file).expect("a readable PNG");
    assert_eq!(read.coding.curve, Curve::Pq);
    // Rec.2020 in and Rec.2020 out, so the conversion is the identity.
    for (row, cells) in read.coding.matrix.iter().enumerate() {
        for (column, cell) in cells.iter().enumerate() {
            let want = if row == column { 1.0 } else { 0.0 };
            assert!((cell - want).abs() < 1e-4, "{row},{column} is {cell}");
        }
    }
}

/// `gAMA` records the encoding exponent, so a file stating 1/1.8 is read back through 1.8 - and
/// the reciprocal the other way round is a picture that is far too dark.
///
/// 1.8 rather than 2.2 because `png` recognises sRGB's own substitute gamma and reports the file
/// as sRGB-tagged, which is the right answer for that value and would not exercise this.
#[test]
fn a_pngs_gamma_chunk_is_the_encoding_exponent() {
    let pixels = ramp(2, 2);
    let file = encode_png(2, 2, &pixels, |encoder| {
        encoder.set_source_gamma(png::ScaledFloat::new(1.0 / 1.8));
    });
    let read = decode_rendered::read(&file).expect("a readable PNG");
    let Curve::Gamma(exponent) = read.coding.curve else {
        panic!("expected a power law, got {:?}", read.coding.curve);
    };
    assert!((exponent - 1.8).abs() < 1e-3, "read back as gamma {exponent}");
}

#[test]
fn a_jpeg_comes_back_at_the_size_it_was_written() {
    let (width, height) = (32usize, 16);
    let pixels = ramp(width, height);
    let mut file = Vec::new();
    jpeg_encoder::Encoder::new(&mut file, 95)
        .encode(&pixels, width as u16, height as u16, jpeg_encoder::ColorType::Rgb)
        .expect("the JPEG encodes");

    let read = decode_rendered::read(&file).expect("a readable JPEG");
    assert_eq!((read.width, read.height), (width, height));
    assert_eq!(read.coding.depth, 8);
    assert_eq!(read.codes.len(), width * height * 3);
    // A lossy round trip, so the pixels are compared as a mean rather than exactly - what would
    // break is a decode that came back at the wrong stride or in the wrong channel order, and
    // either of those is tens of levels out rather than a quantiser's worth.
    let error: f64 = read
        .codes
        .iter()
        .zip(&pixels)
        .map(|(got, want)| (f64::from(*got) - f64::from(*want)).abs())
        .sum::<f64>()
        / pixels.len() as f64;
    assert!(error < 8.0, "the decode is {error} levels from what was encoded");
}

/// The probe is what an import calls, and it must agree with the decode about every file - a
/// catalogue row that says a photograph is one shape while its rendition is another is a grid
/// that lays out tiles at the wrong aspect.
#[test]
fn the_probe_and_the_decode_agree_about_every_file() {
    let png = encode_png(9, 5, &ramp(9, 5), |_| {});
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, 90)
        .encode(&ramp(11, 7), 11, 7, jpeg_encoder::ColorType::Rgb)
        .expect("the JPEG encodes");

    for file in [png, jpeg] {
        let probe = decode_rendered::probe(&file).expect("a probe");
        let read = decode_rendered::read(&file).expect("a decode");
        assert_eq!((probe.width, probe.height), (read.width, read.height));
        assert_eq!(probe.turn, read.turn);
    }
}

/// The sniff decides which of two decoders a photograph gets, so a RAW it read as a finished
/// picture is a library that imports nothing - and a CR3 is an ISOBMFF file exactly as a HEIC is.
#[test]
fn a_cr3_is_not_read_as_a_finished_picture() {
    let mut cr3 = Vec::new();
    cr3.extend_from_slice(&24u32.to_be_bytes());
    cr3.extend_from_slice(b"ftypcrx ");
    cr3.extend_from_slice(&0u32.to_be_bytes());
    cr3.extend_from_slice(b"crx isom");
    assert!(!decode_rendered::is_rendered_bytes(&cr3));
    assert!(!decode_rendered::is_rendered("IMG_0001.CR3"));
}

/// The catalogue's row, which is what an import writes fifty thousand of - and the one thing on
/// it a reader notices immediately is a photograph the grid lays out at the wrong aspect.
#[test]
fn the_catalogues_header_comes_off_a_finished_pictures_container() {
    let dir = std::env::temp_dir().join(format!("bb-header-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a temporary directory");
    let at = dir.join("wide.png");
    std::fs::write(&at, encode_png(40, 25, &ramp(40, 25), |_| {})).expect("the file writes");

    let header = rawshim::header::read_rendered(at.to_str().unwrap()).expect("a header");
    assert_eq!((header.width, header.height), (40, 25));
    assert_eq!(header.orientation, 1, "a PNG with no EXIF is upright");
    // Nothing was recorded, and an unrecorded reading is 0 rather than a guess (`plausible`).
    assert_eq!(header.iso, 0.0);
    assert_eq!(header.timestamp, 0);
    assert!(header.latitude.is_nan());

    // And `read_path` routes to it, which is what every caller actually goes through.
    let routed = rawshim::header::read_path(at.to_str().unwrap()).expect("a header");
    assert_eq!((routed.width, routed.height), (40, 25));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn something_that_is_none_of_the_four_is_refused_by_name() {
    let why = match decode_rendered::read(b"II*\0 a TIFF, which is not one of these") {
        Err(why) => why,
        Ok(_) => panic!("a TIFF is not one of these"),
    };
    assert!(why.contains("PNG"), "{why}");
    assert!(decode_rendered::probe(b"II*\0").is_none());
}
