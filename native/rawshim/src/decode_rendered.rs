//! Reading a photograph that arrives already rendered: PNG, JPEG, HEIC and AVIF.
//!
//! **The rendered counterpart of `decode_rawler`, and it stops at the same place.** That module
//! holds a RAW at the conditioned mosaic, where a Detail slider is the next thing that can move;
//! this one holds a finished picture at its code values, where nothing above the transfer can move
//! at all. Both hand the pipeline the same thing - a scene-linear Rec.2020 frame on the device -
//! and everything below the two is one implementation.
//!
//! **What a finished picture does not have**, and therefore what it does not run: a mosaic. So no
//! GALOSH, no dust search, no demosaic, no as-shot illuminant and no camera matrix to fit. What it
//! does run is everything below those: the coding, the defringe, the lens gather, the sharpen, the
//! grade, the crop and the roll-off - which is most of the pipeline and all of the editor.
//!
//! A linear DNG is held here too, since a camera demosaiced it before it was written, and it is
//! the one picture that keeps an as-shot illuminant ([`Camera`]).
//!
//! The codec for each container:
//!
//!   PNG   `png`, which reads `cICP`, `iCCP`, `cHRM`/`gAMA` and `eXIf` beside the pixels.
//!   JPEG  `jpeg-decoder`, already here for the camera previews the fit reads.
//!   HEIC  `heif` for the boxes and `hevc` for the bitstream, both ours.
//!   AVIF  `heif` for the boxes and libavif for the bitstream, which only a server build links -
//!         see `decode` below for what an editor build does instead.

use crate::linearise::GainMap;
use crate::transfer::{Coding, Curve, Primaries};
use rawler::decoders::Orientation;

/// A picture read off a file: its code values, what they mean, and what came with them.
pub struct Read {
    pub codes: Vec<u16>,
    pub width: usize,
    pub height: usize,
    pub coding: Coding,
    pub turn: Orientation,
    pub gain: Option<GainMap>,
    /// The TIFF block the file carried, for `header::read_rendered` to take the catalogue's
    /// fields out of.
    pub exif: Option<Vec<u8>>,
}

/// Whether this application reads a file of this name as a finished picture.
///
/// By extension rather than by content, because the caller asking is the *scan*, and the answer
/// has to be the same one `utils/scan.ts` gives without opening anything.
pub fn is_rendered(path: &str) -> bool {
    let extension = std::path::Path::new(path)
        .extension()
        .map(|it| it.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "heic" | "heif" | "hif" | "avif")
}

/// The same question of bytes in hand, which is what the editor has: the file's own magic.
pub fn is_rendered_bytes(bytes: &[u8]) -> bool {
    bytes.starts_with(&PNG_MAGIC) || bytes.starts_with(&[0xFF, 0xD8]) || heif::is_heif(bytes)
}

const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// A finished picture opened and kept where the kernel can reach it.
///
/// **The rendered arm of `decode_rawler::Held`, and the pair is what `decode::Held` routes
/// between.** A RAW stops at the mosaic because the Detail sliders live below it; this stops at
/// the code values because nothing above the transfer can move at all. Both answer the same
/// questions, and a caller above them asks without knowing which it has.
pub struct Held {
    picture: crate::linearise::Picture,
    /// Only a linear DNG's, which is a camera's counts rather than a rendering of them.
    camera: Option<Camera>,
}

/// What a picture demosaiced before it was written still says about the sensor behind it.
pub struct Camera {
    pub as_shot: Option<crate::white_balance::AsShot>,
    /// Where each channel saturates on the frame's scale, as `decode_rawler::channel_ceilings`
    /// states a RAW's.
    pub ceiling: [f32; 3],
}

impl Held {
    pub fn camera(picture: crate::linearise::Picture, camera: Camera) -> Held {
        Held { picture, camera: Some(camera) }
    }
}

/// Opens a finished picture as far as the device, which is as far as any setting is irrelevant.
pub fn hold(bytes: &[u8]) -> Result<Held, String> {
    holding(read(bytes)?)
}

/// The same, for a caller that already has the samples: a RAW's embedded preview, decoded and
/// turned upright by `decode_rawler::upright_preview_rgb`, is a finished picture that never was a
/// file. Re-encoding one to hand it to `hold` costs a full-size encode and a second decode.
pub fn holding(read: Read) -> Result<Held, String> {
    let gpu = crate::gpu::device()
        .ok_or_else(|| crate::base::without_a_device("reading a finished picture"))?;
    let picture = crate::linearise::Picture::upload(
        gpu,
        read.codes,
        read.width,
        read.height,
        read.coding,
        read.turn,
        read.gain,
    )
    .ok_or("this picture decoded to nothing")?;
    Ok(Held { picture, camera: None })
}

/// An AVIF the page decoded itself: `avif` for what the container says around the pixels, and the
/// planes its `ImageDecoder` handed back.
///
/// No gain map: a rendition's base is the HDR picture, so the map would only lead away from it.
pub fn hold_planes(avif: &[u8], planes: &[u8], layout: &crate::planes::Layout) -> Result<Held, String> {
    let gpu = crate::gpu::device()
        .ok_or_else(|| crate::base::without_a_device("reading a decoded rendition"))?;
    let primary = read_heif(avif)?.primary;
    let codes = crate::planes::codes(gpu, planes, layout)?;
    let turn = crate::orientation::of_heif(primary.turn);
    let picture = crate::linearise::Picture::on_device(gpu, codes, coding_of(&primary, 16), turn, None);
    Ok(Held { picture, camera: None })
}

impl Held {
    /// The picture's size the way a reader sees it.
    pub fn size(&self) -> crate::px::Size<crate::px::Photograph> {
        self.picture.upright_size()
    }

    /// The level diffuse white lands on in the frames [`Held::window`] produces.
    pub fn white_level(&self) -> crate::light::Light<crate::light::Level> {
        self.picture.white_level()
    }

    /// One window of it, as the scene-linear frame every stage below a decode reads.
    ///
    /// **The Detail amounts are not arguments here, and that is the point.** GALOSH is fitted to a
    /// photosite's own noise on the CFA and the dust search reads the same lattice; a picture that
    /// has been demosaiced by somebody else's camera has neither, so a slider that moved either
    /// would be filtering a reconstruction and calling it the sensor.
    pub fn window(
        &self,
        window: crate::px::Rect<crate::px::Photograph>,
        scale: crate::view::Scale,
    ) -> Option<crate::frame::Frame> {
        let gpu = crate::gpu::device()?;
        let resident = self.picture.window(gpu, crate::linearise::device(gpu), window, scale)?;
        Some(crate::frame::Frame {
            width: resident.width,
            height: resident.height,
            pixels: crate::frame::Pixels::Resident(resident),
            // **Reported, and it has to be.** What every reader of this field does with it is
            // scale a blur sigma back to the photograph's own pixels, and that pair is kept
            // beside the photograph and reused by every later rendition - so a frame that halved
            // and did not say would have its sigma stored at twice the width it was measured at,
            // and the next render at full size would sharpen through it.
            // A finished picture has no mosaic, so this is the resample's own factor rather than a
            // pattern's: the scale asked for and nothing to do with 2x2 sites.
            reduced: match scale == crate::view::Scale::Half {
                true => 2,
                false => 1,
            },
            // A finished picture has been white-balanced by whoever rendered it, and the samples
            // carry no trace of what was divided out. The panel says so rather than offering a
            // temperature to move away from a baseline nobody recorded.
            as_shot: self.camera.as_ref().and_then(|camera| camera.as_shot),
            noise: None,
            dust: None,
            // RCD did not run, so there is no reconstruction matrix for the defringe to propagate
            // its channel correlations through; it falls back to its own estimate.
            matrix: None,
            // One, which is what the field means for a frame whose white balance was applied by
            // somebody else's camera: all three channels clip at full scale together. A linear
            // DNG's balance is the table's, so its channels keep a RAW's separate ceilings.
            neutral_ceiling: self
                .camera
                .as_ref()
                .map_or(1.0, |camera| camera.ceiling.iter().copied().fold(f32::INFINITY, f32::min)),
            wb_gains: self.camera.as_ref().map_or([1.0; 3], |camera| camera.ceiling),
            // A linear DNG's white is a quantile of its scene, as a RAW's is.
            stated_white: match self.camera {
                Some(_) => None,
                None => Some(self.white_level()),
            },
        })
    }
}

/// A JPEG that arrived as itself, decoded to `long_edge`, upright, as the 8-bit sRGB a grid tile
/// is encoded from.
///
/// **Only a JPEG, and that is the whole of the shortcut.** What makes a grid tile cheap for a RAW
/// is lifting the camera's own rendering instead of demosaicing, and for a JPEG the file *is* that
/// rendering - `jpeg::decode` bounds the decode to the tile's size through libjpeg's DCT scaling,
/// so an 8000px file becomes an 800px tile without ever being held whole. A PNG, a HEIC or an AVIF
/// has nothing to lift and no scaled decode to lift it with, so each falls through to the render,
/// which is what a RAW embedding no preview does too.
pub fn preview_rgb(path: &str, long_edge: usize) -> Option<crate::rgb::Rgb> {
    let bytes = std::fs::read(path).ok()?;
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    crate::jpeg::decode(&bytes, long_edge).ok()
}

/// What a container says about itself before anything is decoded.
pub struct Probe {
    /// The picture as stored, before its turn.
    pub width: usize,
    pub height: usize,
    pub turn: Orientation,
    /// The EXIF tag's own numbering, 1 to 8, which is what the catalogue's column holds.
    pub orientation: u16,
    pub exif: Option<Vec<u8>>,
    /// Whether an absent `exif` might still be further into the file than the caller read.
    ///
    /// A caller that probed a window rather than the whole file needs to know the difference
    /// between "this photograph carries no tags" and "not in the part you gave me" - otherwise it
    /// either re-reads every EXIF-less file whole for nothing, or never finds a HEIF's.
    pub deferred: bool,
}

/// The size, the turn and the EXIF block, without decoding a pixel.
///
/// **What an import calls, fifty thousand times.** Every one of the three containers states its
/// dimensions in its first few kilobytes, so the catalogue's row costs a read of the header rather
/// than a decode of the picture.
pub fn probe(bytes: &[u8]) -> Option<Probe> {
    // Whether EXIF this probe did not find could still be further into the file. A PNG's `eXIf`
    // and a JPEG's `APP1` are both in front of the pixels, so "not here" is the answer; a HEIF's
    // is an item located through `iloc` and free to sit anywhere in `mdat`.
    let deferred = heif::is_heif(bytes);
    let (width, height, turn, exif) = if bytes.starts_with(&PNG_MAGIC) {
        // IHDR is the first chunk of every PNG, and its width and height are its first eight
        // bytes: 8 of signature, 4 of length, 4 of type.
        let ihdr = bytes.get(16..24)?;
        let dimension = |at: usize| {
            u32::from_be_bytes([ihdr[at], ihdr[at + 1], ihdr[at + 2], ihdr[at + 3]]) as usize
        };
        let exif = png_exif(bytes);
        (dimension(0), dimension(4), exif_turn(exif.as_deref()), exif)
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(bytes));
        decoder.read_info().ok()?;
        let info = decoder.info()?;
        let exif = decoder.exif_data().map(<[u8]>::to_vec);
        (
            usize::from(info.width),
            usize::from(info.height),
            exif_turn(exif.as_deref()),
            exif,
        )
    } else if heif::is_heif(bytes) {
        let file = read_heif(bytes).ok()?;
        let turn = crate::orientation::of_heif(file.primary.turn);
        (file.primary.width, file.primary.height, turn, file.exif)
    } else {
        return None;
    };
    Some(Probe { width, height, turn, orientation: exif_tag(turn), exif, deferred })
}

/// A PNG's `eXIf` chunk, walked for rather than decoded to.
///
/// `png`'s own reader reaches it, but only after `read_info`, which is a decode this does not
/// otherwise need. The chunk layout is four bytes of length, four of type and the payload.
fn png_exif(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut at = 8usize;
    loop {
        let header = bytes.get(at..at + 8)?;
        let length = u32::from_be_bytes(header[..4].try_into().ok()?) as usize;
        if &header[4..8] == b"eXIf" {
            return bytes.get(at + 8..at + 8 + length).map(<[u8]>::to_vec);
        }
        if &header[4..8] == b"IDAT" || &header[4..8] == b"IEND" {
            return None;
        }
        // The payload, then its four-byte CRC.
        at = at.checked_add(12)?.checked_add(length)?;
    }
}

/// Reads a finished picture off its bytes, whichever of the four it is.
pub fn read(bytes: &[u8]) -> Result<Read, String> {
    if bytes.starts_with(&PNG_MAGIC) {
        return png(bytes);
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        return jpeg(bytes);
    }
    if heif::is_heif(bytes) {
        return heif(bytes);
    }
    Err("this file is not a PNG, a JPEG, a HEIC or an AVIF".to_string())
}

/// A HEIF file's boxes, with anything the reader could not act on said out loud.
pub fn read_heif(bytes: &[u8]) -> Result<heif::File, String> {
    let file = heif::read(bytes)?;
    if let Some(unhandled) = &file.primary.unhandled {
        crate::warn(&format!("rawshim: {unhandled}"));
    }
    Ok(file)
}

fn png(bytes: &[u8]) -> Result<Read, String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    // Palettes expanded and low-bit-depth greys widened, so what comes out is 8- or 16-bit
    // channels and the only cases left below are how many of them there are.
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().map_err(|e| format!("not a readable PNG: {e}"))?;
    let mut buffer = vec![0u8; reader.output_buffer_size().unwrap_or(0)];
    let frame = reader.next_frame(&mut buffer).map_err(|e| format!("this PNG would not decode: {e}"))?;
    // **What the buffer holds, not what the file says.** `EXPAND` above turns a palette into RGB
    // and widens a sub-byte grey, and `Reader::info` still describes the *file* - so reading the
    // channel count off it renders an indexed PNG one third of the way across and in the wrong
    // colours.
    let (colour, bits) = reader.output_color_type();
    let info = reader.info();
    let (width, height) = (frame.width as usize, frame.height as usize);
    let depth = match bits {
        png::BitDepth::Sixteen => 16,
        _ => 8,
    };
    let channels = colour.samples();
    let codes = interleave(&buffer[..frame.buffer_size()], width * height, channels, depth == 16);

    // The colour, in the order a PNG's own chunks take precedence: CICP is exact, `sRGB` is a
    // declaration, an embedded profile is a measurement, and the primitives are what a file that
    // predates all three carries.
    let coding = info
        .coding_independent_code_points
        .map(|cicp| {
            Coding::from_cicp(u16::from(cicp.color_primaries), u16::from(cicp.transfer_function), depth)
        })
        .or_else(|| info.srgb.map(|_| Coding::srgb(depth)))
        .or_else(|| info.icc_profile.as_ref().and_then(|icc| Coding::from_icc(icc, depth)))
        .unwrap_or_else(|| {
            let primaries = info.chromaticities().map_or(Primaries::REC709, |it| Primaries {
                red: (f64::from(it.red.0.into_value()), f64::from(it.red.1.into_value())),
                green: (f64::from(it.green.0.into_value()), f64::from(it.green.1.into_value())),
                blue: (f64::from(it.blue.0.into_value()), f64::from(it.blue.1.into_value())),
                white: (f64::from(it.white.0.into_value()), f64::from(it.white.1.into_value())),
            });
            // `gAMA` records the *encoding* exponent, so the decode is its reciprocal.
            let curve = info.gamma().map_or(Curve::Srgb, |gamma| match gamma.into_value() {
                encoded if encoded > 0.0 => Curve::Gamma(1.0 / encoded),
                _ => Curve::Srgb,
            });
            Coding::of(primaries, curve, depth)
        });

    Ok(Read {
        codes,
        width,
        height,
        coding,
        // A PNG has no orientation of its own; where one carries EXIF, the turn is in there.
        turn: exif_turn(info.exif_metadata.as_deref()),
        gain: None,
        exif: info.exif_metadata.as_ref().map(|it| it.to_vec()),
    })
}

fn jpeg(bytes: &[u8]) -> Result<Read, String> {
    let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(bytes));
    let pixels = decoder.decode().map_err(|e| format!("this JPEG would not decode: {e}"))?;
    let info = decoder.info().ok_or("this JPEG says nothing about itself")?;
    let (width, height) = (usize::from(info.width), usize::from(info.height));
    let channels = match info.pixel_format {
        jpeg_decoder::PixelFormat::L8 => 1,
        jpeg_decoder::PixelFormat::RGB24 => 3,
        jpeg_decoder::PixelFormat::CMYK32 => {
            return Err("this JPEG is CMYK, which this build does not convert".to_string());
        }
        // **Refused rather than read, which is what `jpeg::decode` already does.** The decoder
        // reports `L16` for any precision from 9 to 16 and states none of them, and it writes the
        // samples in the host's own byte order where `interleave` reads PNG's - so there is no
        // scale to put them on and no order to read them in. A wide lossless greyscale JPEG is
        // rare enough that declining one by name beats a picture four stops dark, byte-swapped.
        jpeg_decoder::PixelFormat::L16 => {
            return Err("this JPEG is more than eight bits, which this build does not read"
                .to_string());
        }
    };
    let depth = 8;
    let codes = interleave(&pixels, width * height, channels, false);

    let exif = decoder.exif_data().map(<[u8]>::to_vec);
    let coding = decoder
        .icc_profile()
        .and_then(|icc| Coding::from_icc(&icc, depth))
        .unwrap_or_else(|| Coding::srgb(depth));
    let gain = crate::jpeg_gain::read(bytes, exif.as_deref());

    Ok(Read { codes, width, height, coding, turn: exif_turn(exif.as_deref()), gain, exif })
}

fn heif(bytes: &[u8]) -> Result<Read, String> {
    let file = read_heif(bytes)?;
    let picture = file.primary;
    let coded = decode_picture(bytes, &picture)?;
    let coding = coding_of(&picture, coded.depth);
    let gain = file
        .gain
        .as_ref()
        .and_then(|map| {
            gain_map_of(bytes, map, file.exif.as_deref(), picture.width, picture.height)
        });

    Ok(Read {
        codes: coded.samples,
        width: coded.width,
        height: coded.height,
        coding,
        turn: crate::orientation::of_heif(picture.turn),
        gain,
        exif: file.exif,
    })
}

/// One HEIF picture's bitstream, through whichever decoder its codec names.
fn decode_picture(file: &[u8], picture: &heif::Picture) -> Result<crate::hevc::Coded, String> {
    match picture.codec {
        heif::Codec::Hevc => crate::hevc::decode(picture),
        heif::Codec::Av1 => av1(file, picture),
    }
}

/// AV1, which only a server build can read.
///
/// **The one format this crate cannot decode on both hosts, and it is a dependency problem rather
/// than a design one.** libavif is already linked for the renditions it writes, and it reads an
/// AVIF back exactly; the browser has no C at all, and the only pure-Rust AV1 decoder under a
/// licence this project can take (`rav1d`, BSD-2) reaches for `libc` types that
/// `wasm32-unknown-unknown` does not have. So an AVIF gets renditions, a grid tile and a viewer,
/// and the editor says why it cannot open one rather than showing a black frame.
#[cfg(feature = "renditions")]
fn av1(file: &[u8], _picture: &heif::Picture) -> Result<crate::hevc::Coded, String> {
    // libavif reads the whole container for itself, so the boxes this module walked are used for
    // everything *around* the pixels - the colour, the turn, the EXIF, the gain map - and the file
    // goes to it entire.
    //
    // Sixteen bits asked for whatever the file carries, and the `pixi` property beside it left
    // alone: libavif rescales during the YUV conversion, so this is exact for an 8-bit file and
    // the only way to keep a 10-bit PQ one - where `avif.rs` measures one 8-bit step against four
    // of the ten the file has. A file that states no `pixi` would otherwise be read at eight.
    let (samples, width, height) = crate::avif::decode_at_unturned(file, 16)?;
    Ok(crate::hevc::Coded { samples, width, height, depth: 16 })
}

#[cfg(not(feature = "renditions"))]
fn av1(_: &[u8], _: &heif::Picture) -> Result<crate::hevc::Coded, String> {
    Err("this build reads no AVIF: the AV1 decoder is libavif, which a browser links no C to \
         reach. Open this photograph's rendition instead."
        .to_string())
}

/// What a HEIF picture's samples mean, from its `colr` box or its profile.
fn coding_of(picture: &heif::Picture, depth: u32) -> Coding {
    if let Some(nclx) = picture.nclx {
        return Coding::from_cicp(nclx.primaries, nclx.transfer, depth);
    }
    picture
        .icc
        .as_ref()
        .and_then(|icc| Coding::from_icc(icc, depth))
        .unwrap_or_else(|| Coding::srgb(depth))
}

/// The gain map beside a HEIF picture, decoded and turned into the terms the kernel applies.
///
/// Either spelling: ISO 21496-1 out of the `tmap` item's own payload, or - for the iPhones that
/// wrote gain maps before iOS 18 - Apple's, whose headroom is the maker note pair `apple_gain`
/// reads and whose reconstruction is a different curve (`linearise::Reconstruction`).
///
/// **An AVIF's is libavif's to find, not this module's.** libavif decodes a file rather than an
/// item, so a gain map item handed to it comes back as the primary picture - several stops of gain
/// applied to the photograph that was already right. Its own gain map API reads both the map and
/// its terms out of the container, which is what `avif::gain_map` asks for.
fn gain_map_of(
    file: &[u8],
    map: &heif::GainMap,
    exif: Option<&[u8]>,
    base_width: usize,
    base_height: usize,
) -> Option<GainMap> {
    if map.picture.codec == heif::Codec::Av1 {
        return avif_gain_map(file, base_width, base_height);
    }
    let terms = match map.metadata.as_deref() {
        Some(metadata) => iso_21496_terms(metadata)?,
        // Apple's, whose terms are not in the file beside the map.
        None => {
            let headroom = exif.and_then(crate::apple_gain::headroom).filter(|it| *it > 1.0);
            match headroom {
                Some(headroom) => crate::linearise::Reconstruction::Apple { headroom },
                None => {
                    crate::warn(
                        "rawshim: this HEIC carries Apple's own gain map but states no headroom \
                         for it; showing its standard-range base image",
                    );
                    return None;
                }
            }
        }
    };
    // Said out loud, like the two refusals above it: a gain map that would not decode is a
    // photograph shown at its standard range, and the reader is owed the reason rather than a
    // picture that is quietly two stops flat. `rust_h265` reads 4:2:0 only, and a single-channel
    // map is often coded monochrome, so this is the arm a real file reaches.
    let coded = match crate::hevc::decode(&map.picture) {
        Ok(coded) => coded,
        Err(why) => {
            crate::warn(&format!(
                "rawshim: this photograph's gain map would not decode, so its standard-range base \
                 image is what is shown: {why}",
            ));
            return None;
        }
    };
    // The map is a fraction of the picture's size and does not have to divide it exactly; what
    // the kernel needs is the ratio, which it takes from the two sizes.
    if base_width == 0 || base_height == 0 || coded.width == 0 || coded.height == 0 {
        return None;
    }
    Some(GainMap {
        last: f32::from(u16::MAX >> (16 - coded.depth.clamp(8, 16))),
        samples: coded.samples,
        width: coded.width,
        height: coded.height,
        terms,
    })
}

#[cfg(feature = "renditions")]
fn avif_gain_map(file: &[u8], base_width: usize, base_height: usize) -> Option<GainMap> {
    let (samples, width, height, depth, terms) = crate::avif::gain_map(file)?;
    if base_width == 0 || base_height == 0 || width == 0 || height == 0 {
        return None;
    }
    Some(GainMap {
        last: f32::from(u16::MAX >> (16 - depth.clamp(8, 16))),
        samples,
        width,
        height,
        terms,
    })
}

#[cfg(not(feature = "renditions"))]
fn avif_gain_map(_: &[u8], _: usize, _: usize) -> Option<GainMap> {
    // The editor declines an AVIF by name before reaching here, so this arm is the shape of the
    // build rather than a case a reader meets.
    None
}

/// ISO 21496-1's metadata payload, which is the `tmap` item's own bytes in a HEIF and the body of
/// the `APP2` segment that names the standard in a JPEG - one payload, so one parser.
///
/// The weight a display would apply is deliberately not read: this produces the alternate
/// rendition in full, and the roll-off that meets a panel is six stages further down
/// (`linearise.slang`'s `gain_mapped`).
pub(crate) fn iso_21496_terms(body: &[u8]) -> Option<crate::linearise::Reconstruction> {
    let flags = *body.get(4)?;
    let channels = match flags & 0x80 != 0 {
        true => 3usize,
        false => 1,
    };
    let signed = |at: usize| -> Option<f32> {
        let numerator = i32::from_be_bytes(body.get(at..at + 4)?.try_into().ok()?);
        let denominator = u32::from_be_bytes(body.get(at + 4..at + 8)?.try_into().ok()?);
        match denominator {
            0 => None,
            d => Some(numerator as f32 / d as f32),
        }
    };
    // Two version words, the flags byte, then the two headrooms as rationals.
    let mut at = 5 + 16;
    let mut terms = [[0.0f32; 3]; 5];
    for channel in 0..channels {
        for (which, term) in terms.iter_mut().enumerate() {
            term[channel] = signed(at + which * 8)?;
        }
        at += 5 * 8;
    }
    // A single-channel map states its terms once and means them for all three.
    if channels == 1 {
        for term in &mut terms {
            term[1] = term[0];
            term[2] = term[0];
        }
    }
    Some(crate::linearise::Reconstruction::Iso {
        min: terms[0],
        max: terms[1],
        gamma: terms[2],
        offset_base: terms[3],
        offset_alternate: terms[4],
    })
}

/// Every channel of a decoded picture as three, widened to `u16` code values.
///
/// Grey is replicated and alpha is dropped: the pipeline's frame is three channels, and a
/// photograph's transparency is not something a grade has anything to say about. Two channels is
/// grey *with* alpha - which `png`'s `EXPAND` also produces for a plain grey image carrying a
/// `tRNS` chunk - so it takes the same arm as one.
///
/// **`wide` means PNG's byte order, not "sixteen bits".** `png` writes a wide sample big-endian
/// and `jpeg-decoder` writes one native, so this is only safe to pass `true` for the former;
/// `jpeg` below refuses a wide JPEG outright rather than reading one the wrong way round, which
/// is not a picture slightly off but a picture of noise.
pub(crate) fn interleaved(bytes: &[u8], pixels: usize, channels: usize) -> Vec<u16> {
    interleave(bytes, pixels, channels, false)
}

fn interleave(bytes: &[u8], pixels: usize, channels: usize, wide: bool) -> Vec<u16> {
    let mut out = vec![0u16; pixels * 3];
    let stride = match wide {
        true => 2,
        false => 1,
    };
    let sample = |at: usize| -> u16 {
        match wide {
            true => u16::from_be_bytes([bytes[at * 2], bytes[at * 2 + 1]]),
            false => u16::from(bytes[at]),
        }
    };
    for pixel in 0..pixels {
        let base = pixel * channels;
        if (base + channels) * stride > bytes.len() {
            break;
        }
        for channel in 0..3 {
            out[pixel * 3 + channel] = match channels {
                1 | 2 => sample(base),
                _ => sample(base + channel),
            };
        }
    }
    out
}

/// The turn an EXIF block asks for, which is where a PNG's and a JPEG's orientation lives.
fn exif_turn(exif: Option<&[u8]>) -> Orientation {
    match exif.and_then(crate::header::exif_orientation).unwrap_or(1) {
        2 => Orientation::HorizontalFlip,
        3 => Orientation::Rotate180,
        4 => Orientation::VerticalFlip,
        5 => Orientation::Transpose,
        6 => Orientation::Rotate90,
        7 => Orientation::Transverse,
        8 => Orientation::Rotate270,
        _ => Orientation::Normal,
    }
}

/// Back the other way, since a HEIF's turn comes out of its boxes and the catalogue's column is
/// the EXIF tag whatever the container was.
fn exif_tag(turn: Orientation) -> u16 {
    match turn {
        Orientation::Normal | Orientation::Unknown => 1,
        Orientation::HorizontalFlip => 2,
        Orientation::Rotate180 => 3,
        Orientation::VerticalFlip => 4,
        Orientation::Transpose => 5,
        Orientation::Rotate90 => 6,
        Orientation::Transverse => 7,
        Orientation::Rotate270 => 8,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_grey_picture_becomes_three_channels_and_an_alpha_is_dropped() {
        assert_eq!(interleave(&[7, 9], 2, 1, false), vec![7, 7, 7, 9, 9, 9]);
        assert_eq!(interleave(&[1, 2, 3, 255], 1, 4, false), vec![1, 2, 3]);
        // 16-bit samples are big-endian in a PNG, which is the one place this can go wrong
        // silently: read the other way round, every pixel is a different colour and nothing
        // reports it.
        assert_eq!(interleave(&[0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC], 1, 3, true), vec![0x1234, 0x5678, 0x9ABC]);
    }

    /// The format is decided by the file's own magic, not by what a caller called it.
    #[test]
    fn the_container_is_read_off_the_bytes() {
        assert!(is_rendered_bytes(&PNG_MAGIC));
        assert!(is_rendered_bytes(&[0xFF, 0xD8, 0xFF, 0xE0]));
        let mut heif = vec![0, 0, 0, 24];
        heif.extend_from_slice(b"ftypheic");
        heif.extend_from_slice(&[0; 16]);
        assert!(is_rendered_bytes(&heif));
        assert!(!is_rendered_bytes(b"II*\0nonsense"));
    }

    #[test]
    fn the_scan_and_the_decode_agree_about_which_names_are_rendered() {
        for name in ["a.png", "a.JPG", "a.jpeg", "a.heic", "a.HEIF", "a.hif", "a.avif"] {
            assert!(is_rendered(name), "{name}");
        }
        for name in ["a.arw", "a.cr3", "a.tiff", "a"] {
            assert!(!is_rendered(name), "{name}");
        }
    }

    /// The metadata's five per-channel rationals, in the order ISO 21496-1 writes them.
    #[test]
    fn a_single_channel_gain_map_means_its_terms_for_all_three() {
        let mut body = vec![0u8; 5 + 16];
        body[4] = 0; // one channel
        for (numerator, denominator) in [(0i32, 1u32), (2, 1), (1, 1), (1, 64), (1, 64)] {
            body.extend_from_slice(&numerator.to_be_bytes());
            body.extend_from_slice(&denominator.to_be_bytes());
        }
        let crate::linearise::Reconstruction::Iso { min, max, gamma, offset_base, .. } =
            iso_21496_terms(&body).expect("well-formed metadata")
        else {
            panic!("the standard's payload is the standard's arm");
        };
        assert_eq!(min, [0.0; 3]);
        assert_eq!(max, [2.0; 3], "two stops of headroom, for every channel");
        assert_eq!(gamma, [1.0; 3]);
        assert_eq!(offset_base, [1.0 / 64.0; 3]);
    }

    #[test]
    fn a_truncated_gain_map_metadata_is_declined_rather_than_half_read() {
        assert!(iso_21496_terms(&[0u8; 8]).is_none());
    }
}
