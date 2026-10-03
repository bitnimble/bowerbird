//! A print file's request (`job::Target::print`): the space the printer is sent, the file's exact
//! pixels, and the turn - and what those ask of the grade.

use crate::image::Geometry;
use crate::printer_gamut::{PrintTarget, PrinterGamut};
use crate::px::{Drawn, Size};

/// The encoding the printer takes, from the best it accepts down.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Space {
    Srgb,
    AdobeRgb,
    /// The printer's own RGB, uncorrected, through its paper's profile.
    Device,
}

/// A print file's samples, at the depth the printer takes.
pub enum PrintSamples {
    Eight(Vec<u8>),
    Sixteen(Vec<u16>),
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub space: Space,
    pub bits: u8,
    #[serde(default)]
    pub intent: crate::gpu::Intent,
    #[serde(default)]
    pub black_point_compensation: bool,
    /// The printer's ICC output profile, base64, which `Space::Device` writes through.
    #[serde(default)]
    pub icc: Option<String>,
    /// The file's pixels, after the turn.
    pub width: u32,
    pub height: u32,
    /// Clockwise quarter turns of the finished picture.
    #[serde(default)]
    pub quarter_turns: u16,
}

impl Spec {
    /// Whether this is a file that can be written at all, before anything is decoded for it.
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.bits, 8 | 16) {
            return Err(format!("a print file is 8 or 16 bits, not {}", self.bits));
        }
        if self.width == 0 || self.height == 0 {
            return Err("a print file needs a width and a height".to_owned());
        }
        if self.space == Space::Device && self.icc.is_none() {
            return Err("a device print needs the printer's ICC profile".to_owned());
        }
        Ok(())
    }

    /// The target the file is brought inside, which for a device print proves the profile can be
    /// written to.
    pub fn target(&self) -> Result<PrintTarget, String> {
        self.validate()?;
        match self.space {
            Space::Srgb => Ok(PrintTarget::Srgb),
            Space::AdobeRgb => Ok(PrintTarget::AdobeRgb),
            Space::Device => {
                let icc = base64(self.icc.as_deref().unwrap_or_default())?;
                let printer = PrinterGamut::new(&icc)?;
                printer.device_table()?;
                Ok(PrintTarget::Profile(std::sync::Arc::new(printer)))
            }
        }
    }

    pub fn output(&self) -> crate::gpu::PrintOutput {
        crate::gpu::PrintOutput {
            size: crate::px::Size::measured(self.width as usize, self.height as usize),
            sixteen_bit: self.bits == 16,
            black_point_compensation: self.black_point_compensation,
        }
    }

    /// The file's pixels before the turn, which is the shape the crop is tightened to.
    fn unturned(&self, rotate: u16) -> (f64, f64) {
        let (width, height) = (f64::from(self.width), f64::from(self.height));
        match rotate % 180 {
            90 => (height, width),
            _ => (width, height),
        }
    }

    fn rotate(&self, document: Geometry) -> u16 {
        (document.rotate + 90 * (self.quarter_turns % 4)) % 360
    }

    /// The reader's crop, turned by the request and tightened about its own centre to the file's
    /// shape, over a `frame` drawn at some size; and how many file pixels one of that frame's
    /// pixels then covers, which [`Spec::drawn_long_edge`] holds at one or more. The dispatch
    /// writes the file's pixels through this geometry, so the resample is the Catmull-Rom every
    /// rendition reads with and no second one.
    pub fn geometry(&self, document: Geometry, frame: Size<Drawn>) -> (Geometry, f64) {
        let rotate = self.rotate(document);
        let (file_w, file_h) = self.unturned(rotate);
        let (sin, cos) = document.angle_degrees.to_radians().sin_cos();
        let (width, height) = frame.raw();
        let (sw, sh) = (
            width as f64 * cos.abs() + height as f64 * sin.abs(),
            width as f64 * sin.abs() + height as f64 * cos.abs(),
        );
        let [left, top, right, bottom] = document.crop;
        let region_w = (sw * (right - left)).max(1e-9);
        let region_h = (sh * (bottom - top)).max(1e-9);
        let scale = (file_w / region_w).max(file_h / region_h);
        let (dw, dh) = (file_w / (scale * sw), file_h / (scale * sh));
        let (cx, cy) = ((left + right) / 2.0, (top + bottom) / 2.0);
        (
            Geometry {
                crop: [cx - dw / 2.0, cy - dh / 2.0, cx + dw / 2.0, cy + dh / 2.0],
                rotate,
                ..document
            },
            scale,
        )
    }

    /// The long edge to draw `photograph` at: shrunk until one of its pixels covers one of the
    /// file's, so what the dispatch's one tap does is at most a magnification, and never past the
    /// photograph's own.
    pub fn drawn_long_edge(&self, document: Geometry, photograph: Size<Drawn>) -> u32 {
        let native = photograph.long().raw();
        let (_, scale) = self.geometry(document, photograph);
        ((native as f64 * scale).ceil() as u32).min(native as u32)
    }
}

fn base64(text: &str) -> Result<Vec<u8>, String> {
    let value = |byte: u8| match byte {
        b'A'..=b'Z' => Ok(u32::from(byte - b'A')),
        b'a'..=b'z' => Ok(u32::from(byte - b'a') + 26),
        b'0'..=b'9' => Ok(u32::from(byte - b'0') + 52),
        b'+' | b'-' => Ok(62),
        b'/' | b'_' => Ok(63),
        other => Err(format!("not base64: {:?}", other as char)),
    };
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut held = 0u32;
    let mut bits = 0;
    for byte in text.bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        held = (held << 6) | value(byte)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((held >> bits) as u8);
            held &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: usize, height: usize) -> Size<Drawn> {
        Size::measured(width, height)
    }

    fn spec(width: u32, height: u32, quarter_turns: u16) -> Spec {
        Spec {
            space: Space::AdobeRgb,
            bits: 16,
            intent: crate::gpu::Intent::Perceptual,
            black_point_compensation: true,
            icc: None,
            width,
            height,
            quarter_turns,
        }
    }

    #[test]
    fn base64_decodes_what_the_server_encodes() {
        assert_eq!(base64("aGVsbG8=").expect("decodes"), b"hello");
        assert_eq!(base64("aGVsbG8gd29ybGQ").expect("decodes"), b"hello world");
        assert_eq!(base64("").expect("decodes"), b"");
        assert!(base64("a*").is_err());
    }

    /// A 4:3 crop printed 1:1 keeps its height and loses an eighth of its width each side.
    #[test]
    fn the_crop_is_tightened_to_the_files_shape_about_its_centre() {
        let document = Geometry {
            crop: [0.1, 0.2, 0.9, 0.8],
            ..Geometry::none()
        };
        let (geometry, scale) = spec(600, 600, 0).geometry(document, frame(1000, 1000));
        let [left, top, right, bottom] = geometry.crop;
        assert!(
            (left - 0.2).abs() < 1e-9 && (right - 0.8).abs() < 1e-9,
            "{:?}",
            geometry.crop
        );
        assert!(
            (top - 0.2).abs() < 1e-9 && (bottom - 0.8).abs() < 1e-9,
            "{:?}",
            geometry.crop
        );
        assert!((scale - 1.0).abs() < 1e-9, "{scale}");
        assert_eq!(geometry.rotate, 0);
    }

    /// Turned, the file's shape is matched before the turn, and the turn adds to the reader's.
    #[test]
    fn a_turned_print_tightens_to_the_file_as_it_lies_before_the_turn() {
        let document = Geometry::none();
        let (geometry, scale) = spec(300, 600, 1).geometry(document, frame(1200, 400));
        assert_eq!(geometry.rotate, 90);
        let turned_twice = spec(300, 600, 1).geometry(
            Geometry {
                rotate: 270,
                ..document
            },
            frame(1200, 400),
        );
        assert_eq!(turned_twice.0.rotate, 0);
        let [left, top, right, bottom] = geometry.crop;
        // 600 wide by 300 tall before the turn, over a 3:1 frame: the height is the limit.
        assert!((bottom - top - 1.0).abs() < 1e-9, "{:?}", geometry.crop);
        assert!(
            (right - left - 800.0 / 1200.0).abs() < 1e-9,
            "{:?}",
            geometry.crop
        );
        assert!((scale - 0.75).abs() < 1e-9, "{scale}");
    }

    #[test]
    fn the_frame_is_drawn_no_larger_than_the_file_reads_and_never_past_native() {
        let document = Geometry::none();
        let photograph = frame(6000, 4000);
        assert_eq!(spec(600, 400, 0).drawn_long_edge(document, photograph), 600);
        assert_eq!(spec(600, 600, 0).drawn_long_edge(document, photograph), 900);
        assert_eq!(
            spec(9000, 6000, 0).drawn_long_edge(document, photograph),
            6000
        );
        let (_, scale) = spec(9000, 6000, 0).geometry(document, photograph);
        assert!((scale - 1.5).abs() < 1e-9, "a magnification: {scale}");
    }

    #[test]
    fn a_request_names_what_it_cannot_be() {
        assert!(spec(0, 10, 0).target().is_err());
        assert!(
            Spec {
                bits: 12,
                ..spec(1, 1, 0)
            }
            .target()
            .is_err()
        );
        assert!(
            Spec {
                space: Space::Device,
                ..spec(1, 1, 0)
            }
            .target()
            .is_err()
        );
        let srgb = Spec {
            space: Space::Srgb,
            ..spec(1, 1, 0)
        };
        let target = srgb.target().expect("sRGB");
        assert!(matches!(target, PrintTarget::Srgb));
        let profile = moxcms::ColorProfile::new_from_slice(&target.icc().expect("a profile"))
            .expect("readable");
        assert_eq!(profile.profile_class, moxcms::ProfileClass::DisplayDevice);
    }
}
