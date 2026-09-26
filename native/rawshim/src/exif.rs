//! The EXIF a picture this application writes carries: what the camera recorded, a group at a time.
//!
//! An allow-list, where `scrub.rs` is a deny-list: a tag is here only because a group names it, so a
//! maker note, a serial or a coordinate a camera keeps somewhere new never reaches a rendition.
//!
//! No orientation and no colour space: a rendition is stood up by its container's own rotation and
//! its colour is stated by CICP or ICC, so the camera's values would describe a different picture.

use rawler::exif::Exif;
use rawler::formats::tiff::reader::TiffReader;
use rawler::formats::tiff::writer::{DirectoryWriter, TiffWriter};
use rawler::formats::tiff::Value;
use rawler::tags::ExifTag;
use std::io::{Cursor, Seek, Write};

/// A part of what the camera recorded, taken whole or left.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Group {
    Camera,
    Lens,
    /// Shutter, aperture, sensitivity, focal length, and the modes the camera chose them in.
    Exposure,
    /// When the shutter fired, with its zone and fraction of a second.
    Taken,
}

/// Everything recorded that names nobody and nowhere.
pub const NON_IDENTIFYING: &[Group] = &[Group::Camera, Group::Lens, Group::Exposure, Group::Taken];

/// The directories a block may point to, which a reader has to be told to follow.
const SUB_DIRECTORIES: [u16; 2] = [0x8769, 0x8825];

/// What the camera recorded about a photograph, whichever kind of file it arrived in.
pub struct Recorded {
    make: String,
    model: String,
    exif: Exif,
}

impl Recorded {
    /// A RAW through its decoder, a finished picture through the EXIF block it carries.
    pub fn read(path: &str) -> Option<Recorded> {
        if crate::decode_rendered::is_rendered(path) {
            let bytes = std::fs::read(path).ok()?;
            return Recorded::parse(&crate::decode_rendered::probe(&bytes)?.exif?);
        }
        let source = rawler::rawsource::RawSource::new_lazy(std::path::Path::new(path)).ok()?;
        let decoder = rawler::get_decoder(&source).ok()?;
        Recorded::opened(&source, decoder.as_ref())
    }

    /// A RAW a caller already has open.
    pub fn opened(
        source: &rawler::rawsource::RawSource,
        decoder: &dyn rawler::decoders::Decoder,
    ) -> Option<Recorded> {
        let metadata = decoder.raw_metadata(source, &rawler::decoders::RawDecodeParams::default()).ok()?;
        Some(Recorded { make: metadata.make, model: metadata.model, exif: metadata.exif })
    }

    /// A TIFF block, as a JPEG's APP1 or a HEIF's `Exif` item holds one.
    pub fn parse(tiff: &[u8]) -> Option<Recorded> {
        let reader = rawler::formats::tiff::reader::GenericTiffReader::new(
            &mut Cursor::new(tiff),
            0,
            0,
            None,
            &SUB_DIRECTORIES,
        )
        .ok()?;
        let root = reader.root_ifd();
        let text = |tag: u16| {
            root.get_entry(tag)
                .and_then(|entry| entry.as_string())
                .map(|name| name.trim().to_string())
                .unwrap_or_default()
        };
        Some(Recorded {
            make: text(0x010f),
            model: text(0x0110),
            exif: Exif::new(root).ok()?,
        })
    }

    /// The groups asked for as a TIFF block, or None where the camera recorded none of them.
    pub fn block(&self, groups: &[Group]) -> Option<Vec<u8>> {
        let mut root = DirectoryWriter::new();
        let mut exif = DirectoryWriter::new();
        for group in groups {
            self.fill(*group, &mut root, &mut exif);
        }
        if root.is_empty() && exif.is_empty() {
            return None;
        }
        let mut out = Vec::new();
        let mut tiff = TiffWriter::new(Cursor::new(&mut out)).ok()?;
        if !exif.is_empty() {
            exif.add_tag_undefined(ExifTag::ExifVersion, b"0232".to_vec());
            let at = exif.build(&mut tiff).ok()?;
            root.add_tag(ExifTag::ExifOffset, at);
        }
        tiff.build(root).ok()?;
        Some(out)
    }

    fn fill(&self, group: Group, root: &mut DirectoryWriter, ifd: &mut DirectoryWriter) {
        let exif = &self.exif;
        match group {
            Group::Camera => {
                text(root, ExifTag::Make, Some(&self.make));
                text(root, ExifTag::Model, Some(&self.model));
            }
            Group::Lens => {
                text(ifd, ExifTag::LensMake, exif.lens_make.as_ref());
                text(ifd, ExifTag::LensModel, exif.lens_model.as_ref());
                put(ifd, ExifTag::LensSpecification, exif.lens_spec);
            }
            Group::Exposure => {
                put(ifd, ExifTag::ExposureTime, exif.exposure_time);
                put(ifd, ExifTag::FNumber, exif.fnumber);
                put(ifd, ExifTag::ApertureValue, exif.aperture_value);
                put(ifd, ExifTag::ShutterSpeedValue, exif.shutter_speed_value);
                put(ifd, ExifTag::BrightnessValue, exif.brightness_value);
                put(ifd, ExifTag::MaxApertureValue, exif.max_aperture_value);
                put(ifd, ExifTag::ExposureBiasValue, exif.exposure_bias);
                put(ifd, ExifTag::ExposureProgram, exif.exposure_program);
                put(ifd, ExifTag::ExposureMode, exif.exposure_mode);
                put(ifd, ExifTag::ISOSpeedRatings, exif.iso_speed_ratings);
                put(ifd, ExifTag::ISOSpeed, exif.iso_speed);
                put(ifd, ExifTag::SensitivityType, exif.sensitivity_type);
                put(ifd, ExifTag::RecommendedExposureIndex, exif.recommended_exposure_index);
                put(ifd, ExifTag::MeteringMode, exif.metering_mode);
                put(ifd, ExifTag::Flash, exif.flash);
                put(ifd, ExifTag::FlashEnergy, exif.flash_energy);
                put(ifd, ExifTag::FocalLength, exif.focal_length);
                put(ifd, ExifTag::FocalLengthIn35mmFormat, exif.focal_length_in_35mm);
                put(ifd, ExifTag::SubjectDistance, exif.subject_distance);
                put(ifd, ExifTag::SubjectDistanceRange, exif.subject_distance_range);
                put(ifd, ExifTag::LightSource, exif.light_source);
                put(ifd, ExifTag::WhiteBalance, exif.white_balance);
                put(ifd, ExifTag::SceneCaptureType, exif.scene_capture_type);
            }
            Group::Taken => {
                text(ifd, ExifTag::DateTimeOriginal, exif.date_time_original.as_ref());
                text(ifd, ExifTag::CreateDate, exif.create_date.as_ref());
                text(ifd, ExifTag::OffsetTime, exif.offset_time.as_ref());
                text(ifd, ExifTag::OffsetTimeOriginal, exif.offset_time_original.as_ref());
                text(ifd, ExifTag::OffsetTimeDigitized, exif.offset_time_digitized.as_ref());
                text(ifd, ExifTag::SubSecTime, exif.sub_sec_time.as_ref());
                text(ifd, ExifTag::SubSecTimeOriginal, exif.sub_sec_time_original.as_ref());
                text(ifd, ExifTag::SubSecTimeDigitized, exif.sub_sec_time_digitized.as_ref());
                put(ifd, ExifTag::TimeZoneOffset, exif.timezone_offset.clone());
            }
        }
    }
}

fn put<V: Into<Value>>(ifd: &mut DirectoryWriter, tag: ExifTag, value: Option<V>) {
    let Some(value) = value.map(Into::into) else { return };
    // An empty value is a panic in the writer rather than an error.
    if value.count() > 0 {
        ifd.add_value(tag, value);
    }
}

fn text(ifd: &mut DirectoryWriter, tag: ExifTag, value: Option<&String>) {
    let value = value.map(|value| value.trim()).filter(|value| !value.is_empty());
    put(ifd, tag, value);
}

/// `block`'s tags written into a TIFF file being built: IFD0's onto `root`, and each directory it
/// points to as one of the file's own, which is how a TIFF export carries what its source did.
pub fn copy_into<W: Write + Seek>(
    block: &[u8],
    tiff: &mut TiffWriter<W>,
    root: &mut DirectoryWriter,
) -> Result<(), String> {
    let reader = rawler::formats::tiff::reader::GenericTiffReader::new(
        &mut Cursor::new(block),
        0,
        0,
        None,
        &SUB_DIRECTORIES,
    )
    .map_err(|e| format!("the EXIF block does not parse: {e}"))?;
    let source = reader.root_ifd();
    for (tag, entry) in source.entries() {
        if !SUB_DIRECTORIES.contains(tag) {
            root.add_untyped_tag(*tag, entry.value.clone());
        }
    }
    for tag in SUB_DIRECTORIES {
        let Some(sub) = source.get_sub_ifd(tag) else { continue };
        let mut directory = DirectoryWriter::new();
        for (tag, entry) in sub.entries() {
            directory.add_untyped_tag(*tag, entry.value.clone());
        }
        if directory.is_empty() {
            continue;
        }
        let at = directory.build(tiff).map_err(|e| format!("could not write an EXIF directory: {e}"))?;
        root.add_untyped_tag(tag, at);
    }
    Ok(())
}

#[cfg(all(test, feature = "fixtures"))]
mod fixtures {
    use super::*;
    use crate::fixture_tests::{canon, fuji, sony};
    use crate::header::{name, read_path};

    /// Each container keeps its EXIF somewhere different, and every one of them has to reach a block.
    #[test]
    fn every_fixture_writes_the_record_the_catalogue_reads() {
        for path in [sony(), canon(), fuji()] {
            let path = path.to_str().expect("a path");
            let header = read_path(path).expect("the header");
            let block = Recorded::read(path)
                .and_then(|recorded| recorded.block(NON_IDENTIFYING))
                .unwrap_or_else(|| panic!("{path} writes a block"));
            let back = Recorded::parse(&block).expect("the block parses");

            assert_eq!(back.model, name(&header.camera_model), "{path}");
            let iso = back.exif.iso_speed.or(back.exif.iso_speed_ratings.map(u32::from));
            assert_eq!(iso.map(|iso| iso as f32), Some(header.iso), "{path}");
            assert!(back.exif.date_time_original.is_some(), "{path}");
            assert_eq!(back.exif.serial_number, None, "{path}");
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use rawler::formats::tiff::{Rational, SRational};

    /// What a rendition of `recorded` carries, for the writers' own tests.
    pub(crate) fn block() -> Vec<u8> {
        recorded().block(NON_IDENTIFYING).expect("a block")
    }

    fn recorded() -> Recorded {
        Recorded {
            make: "Sony".into(),
            model: "ILCE-7M4".into(),
            exif: Exif {
                orientation: Some(6),
                artist: Some("Declan".into()),
                copyright: Some("Declan".into()),
                owner_name: Some("Declan".into()),
                serial_number: Some("5123456".into()),
                lens_serial_number: Some("1800123".into()),
                user_comment: Some("the back garden".into()),
                color_space: Some(1),
                image_number: Some(4412),
                gps: Some(rawler::exif::ExifGPS {
                    gps_latitude_ref: Some("S".into()),
                    gps_latitude: Some([Rational::new(38, 1), Rational::new(37, 1), Rational::new(35, 10)]),
                    ..Default::default()
                }),
                lens_make: Some("Sony".into()),
                lens_model: Some("FE 24-70mm F2.8 GM II".into()),
                exposure_time: Some(Rational::new(1, 250)),
                fnumber: Some(Rational::new(28, 10)),
                exposure_bias: Some(SRational::new(-1, 3)),
                iso_speed_ratings: Some(400),
                focal_length: Some(Rational::new(35, 1)),
                focal_length_in_35mm: Some(35),
                date_time_original: Some("2026:09:18 17:04:31".into()),
                offset_time_original: Some("+12:00".into()),
                ..Default::default()
            },
        }
    }

    fn read_back(block: &[u8]) -> Recorded {
        Recorded::parse(block).expect("the block parses")
    }

    #[test]
    fn the_exposure_survives_and_the_photographer_does_not() {
        let block = recorded().block(NON_IDENTIFYING).expect("a block");
        let back = read_back(&block);

        assert_eq!((back.make.as_str(), back.model.as_str()), ("Sony", "ILCE-7M4"));
        assert_eq!(back.exif.lens_model.as_deref(), Some("FE 24-70mm F2.8 GM II"));
        assert_eq!(back.exif.exposure_time, Some(Rational::new(1, 250)));
        assert_eq!(back.exif.fnumber, Some(Rational::new(28, 10)));
        assert_eq!(back.exif.exposure_bias, Some(SRational::new(-1, 3)));
        assert_eq!(back.exif.iso_speed_ratings, Some(400));
        assert_eq!(back.exif.focal_length_in_35mm, Some(35));
        assert_eq!(back.exif.date_time_original.as_deref(), Some("2026:09:18 17:04:31"));
        assert_eq!(back.exif.offset_time_original.as_deref(), Some("+12:00"));

        assert_eq!(back.exif.artist, None);
        assert_eq!(back.exif.copyright, None);
        assert_eq!(back.exif.owner_name, None);
        assert_eq!(back.exif.serial_number, None);
        assert_eq!(back.exif.lens_serial_number, None);
        assert_eq!(back.exif.user_comment, None);
        assert_eq!(back.exif.image_number, None);
        assert_eq!(back.exif.gps, None);
    }

    /// The pixels a rendition holds are already stood up, and its colour is the container's to state.
    #[test]
    fn neither_the_turn_nor_the_colour_space_is_carried() {
        let back = read_back(&recorded().block(NON_IDENTIFYING).expect("a block"));
        assert_eq!(back.exif.orientation, None);
        assert_eq!(back.exif.color_space, None);
    }

    #[test]
    fn only_the_groups_asked_for_are_written() {
        let back = read_back(&recorded().block(&[Group::Camera]).expect("a block"));
        assert_eq!(back.model, "ILCE-7M4");
        assert_eq!(back.exif.exposure_time, None);
        assert_eq!(back.exif.date_time_original, None);
    }

    #[test]
    fn a_camera_that_recorded_nothing_asked_for_gets_no_block() {
        let empty = Recorded { make: String::new(), model: "  ".into(), exif: Exif::default() };
        assert!(empty.block(NON_IDENTIFYING).is_none());
    }

    #[test]
    fn a_copied_block_reads_back_from_the_file_it_was_copied_into() {
        let block = recorded().block(NON_IDENTIFYING).expect("a block");
        let mut out = Vec::new();
        {
            let mut tiff = TiffWriter::new(Cursor::new(&mut out)).expect("a writer");
            let mut root = DirectoryWriter::new();
            root.add_tag(rawler::tags::TiffCommonTag::ImageWidth, 1u32);
            copy_into(&block, &mut tiff, &mut root).expect("the copy");
            tiff.build(root).expect("the file");
        }
        let back = read_back(&out);
        assert_eq!(back.model, "ILCE-7M4");
        assert_eq!(back.exif.exposure_time, Some(Rational::new(1, 250)));
    }
}
