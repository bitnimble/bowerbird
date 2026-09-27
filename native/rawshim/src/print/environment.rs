use crate::light::{Illuminance, Light};
use crate::px::Share;

/// The room a print hangs in: one of Poly Haven's HDR maps (`bun run get:environments`), with its
/// brightest light taken out and drawn as the lamp.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    /// `poly_haven_studio`: a room lit by its windows at midday, and eight ceiling downlights.
    #[default]
    Studio,
    /// `meadow_2`: open grass under a clear sun.
    Meadow,
    /// `hotel_room`: a bedroom at dusk under warm downlights.
    Hotel,
}

pub const ENVIRONMENTS: [Environment; 3] = [Environment::Studio, Environment::Meadow, Environment::Hotel];

/// What the lamp stands in for, measured off the map it is taken out of: its lux against the room's
/// on an upright sheet facing the reader, its colour, and the direction the map turned puts it in.
pub struct Lighting {
    pub key_lux: Light<Illuminance>,
    pub fill_lux: Light<Illuminance>,
    pub light_temperature_kelvin: f64,
    pub light_across: Share,
    pub light_height: Share,
    pub light_forward: Share,
    pub light_angular_degrees: f64,
}

/// Where on the source map the lamp is, and how the map turns to put the print where it hangs.
pub(crate) struct Source {
    /// The lamp's brightest texel, round from the middle of the map and up from its horizon.
    pub lamp_degrees: (f64, f64),
    pub lamp_radius_degrees: f64,
    /// The map's luminance above which a texel inside that radius is the lamp.
    pub threshold: f64,
    /// How far round the map turns: what the source holds this far round is straight ahead.
    pub turn_degrees: f64,
}

impl Source {
    /// Where the lamp is on the source map, as the build shader's `environment_direction` reads it.
    pub fn lamp_uv(&self) -> [f32; 2] {
        [(0.5 + self.lamp_degrees.0 / 360.0) as f32, ((90.0 - self.lamp_degrees.1) / 180.0) as f32]
    }

    /// The turn in whole texels of a map `width` across.
    pub fn turn(&self, width: u32) -> u32 {
        (self.turn_degrees / 360.0 * f64::from(width)).round().rem_euclid(f64::from(width)) as u32
    }
}

impl Environment {
    pub fn name(self) -> &'static str {
        match self {
            Environment::Studio => "studio",
            Environment::Meadow => "meadow",
            Environment::Hotel => "hotel",
        }
    }

    pub fn lighting(self) -> Lighting {
        let (key, fill, kelvin, [across, height, forward], degrees) = match self {
            Environment::Studio => (133.0, 500.0, 7800.0, [0.45, 4.7, 1.65], 1.5),
            // The sun's own half degree, where the map's disc is three times that in the lens's bloom.
            Environment::Meadow => (80000.0, 9570.0, 5400.0, [4.45, 4.55, 7.7], 0.5),
            Environment::Hotel => (30.0, 15.0, 3600.0, [0.7, 4.2, 2.65], 1.4),
        };
        Lighting {
            key_lux: Light::exactly(key),
            fill_lux: Light::exactly(fill),
            light_temperature_kelvin: kelvin,
            light_across: Share::measured(across, 1.0),
            light_height: Share::measured(height, 1.0),
            light_forward: Share::measured(forward, 1.0),
            light_angular_degrees: degrees,
        }
    }

    pub(crate) fn source(self) -> Source {
        match self {
            Environment::Studio => Source { lamp_degrees: (36.65, 70.58), lamp_radius_degrees: 2.0, threshold: 50.0, turn_degrees: -128.85 },
            Environment::Meadow => Source { lamp_degrees: (36.12, 26.98), lamp_radius_degrees: 5.0, threshold: 100.0, turn_degrees: -113.91 },
            Environment::Hotel => Source { lamp_degrees: (-88.15, 57.04), lamp_radius_degrees: 2.5, threshold: 100.0, turn_degrees: -253.3 },
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn bytes(self) -> Result<std::borrow::Cow<'static, [u8]>, String> {
        let path = format!("{}/.environments/{}.hdr", env!("CARGO_MANIFEST_DIR"), self.name());
        std::fs::read(&path).map(std::borrow::Cow::Owned)
            .map_err(|error| format!("{path}: {error}. `bun run get:environments` fetches it"))
    }

    #[cfg(target_arch = "wasm32")]
    pub(crate) fn bytes(self) -> Result<std::borrow::Cow<'static, [u8]>, String> {
        HELD.with(|held| held.borrow().iter().find(|(environment, _)| *environment == self).map(|(_, bytes)| *bytes))
            .map(std::borrow::Cow::Borrowed)
            .ok_or_else(|| format!("the {} environment has not been fetched", self.name()))
    }
}

#[cfg(target_arch = "wasm32")]
thread_local! {
    static HELD: std::cell::RefCell<Vec<(Environment, &'static [u8])>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// What the page fetched, kept for the rest of the tab like PMRID's weights.
#[cfg(target_arch = "wasm32")]
pub fn hold(environment: Environment, bytes: Vec<u8>) {
    HELD.with(|held| {
        let mut held = held.borrow_mut();
        if held.iter().all(|(kept, _)| *kept != environment) {
            held.push((environment, Box::leak(bytes.into_boxed_slice())));
        }
    });
}

#[cfg(target_arch = "wasm32")]
pub fn held(environment: Environment) -> bool {
    environment.bytes().is_ok()
}

/// A Radiance `.hdr`, its texels packed as the file stores them: red, green, blue and a shared
/// exponent, a byte each, lowest first.
pub(crate) struct Rgbe {
    pub width: u32,
    pub height: u32,
    pub texels: Vec<u32>,
}

const MOST_TEXELS: u64 = 8192 * 4096;

pub(crate) fn decode(bytes: &[u8]) -> Result<Rgbe, String> {
    let mut at = 0;
    let mut line = || -> Result<&[u8], String> {
        let end = bytes[at..].iter().position(|&byte| byte == b'\n').ok_or("a truncated header")? + at;
        let text = &bytes[at..end];
        at = end + 1;
        Ok(text)
    };
    if !line()?.starts_with(b"#?") { return Err("not a Radiance file".to_owned()); }
    while !line()?.is_empty() {}
    let size = std::str::from_utf8(line()?).map_err(|error| error.to_string())?;
    let fields: Vec<&str> = size.split_whitespace().collect();
    let (height, width) = match fields.as_slice() {
        ["-Y", height, "+X", width] => (height.parse::<u32>(), width.parse::<u32>()),
        _ => return Err(format!("an orientation other than -Y +X: {size}")),
    };
    let (height, width) = (height.map_err(|error| error.to_string())?, width.map_err(|error| error.to_string())?);
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MOST_TEXELS {
        return Err(format!("a {width}x{height} map"));
    }
    let mut texels = Vec::with_capacity(width as usize * height as usize);
    let mut scanline = vec![0_u8; width as usize * 4];
    let mut data = bytes[at..].iter().copied();
    let mut next = || data.next().ok_or_else(|| "a truncated scanline".to_owned());
    for _ in 0..height {
        let head = [next()?, next()?, next()?, next()?];
        if head[0] != 2 || head[1] != 2 || (u32::from(head[2]) << 8 | u32::from(head[3])) != width {
            return Err("a scanline that is not run-length encoded".to_owned());
        }
        for channel in 0..4 {
            let mut x = 0;
            while x < width as usize {
                let count = next()?;
                let (count, repeated) = if count > 128 { (usize::from(count - 128), Some(next()?)) } else { (usize::from(count), None) };
                if count == 0 || x + count > width as usize { return Err("a run past the scanline".to_owned()); }
                for _ in 0..count {
                    scanline[x * 4 + channel] = match repeated { Some(value) => value, None => next()? };
                    x += 1;
                }
            }
        }
        texels.extend(scanline.chunks_exact(4).map(|texel| u32::from_le_bytes([texel[0], texel[1], texel[2], texel[3]])));
    }
    Ok(Rgbe { width, height, texels })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lighting_is_what_the_browser_offers() {
        let table: serde_json::Value = serde_json::from_str(include_str!("../../../../test/fixtures/tables/print-environments.json"))
            .expect("the table");
        for environment in ENVIRONMENTS {
            let lighting = environment.lighting();
            let row = &table[environment.name()];
            for (name, value) in [
                ("keyLux", lighting.key_lux.raw()),
                ("fillLux", lighting.fill_lux.raw()),
                ("lightTemperatureKelvin", lighting.light_temperature_kelvin),
                ("lightAcross", lighting.light_across.raw()),
                ("lightHeight", lighting.light_height.raw()),
                ("lightForward", lighting.light_forward.raw()),
                ("lightAngularDegrees", lighting.light_angular_degrees),
            ] {
                assert_eq!(row[name].as_f64(), Some(value), "{environment:?}'s {name}");
            }
        }
    }

    /// Two scanlines eight texels across: red a run of 128, green written out, blue a run of 0 and
    /// the exponent a run of 129.
    fn file(size: &str) -> Vec<u8> {
        let mut bytes = format!("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n{size}\n").into_bytes();
        for _ in 0..2 {
            bytes.extend([2, 2, 0, 8, 136, 128, 8, 1, 2, 3, 4, 5, 6, 7, 8, 136, 0, 136, 129]);
        }
        bytes
    }

    #[test]
    fn a_run_length_map_decodes_texel_by_texel() {
        let map = decode(&file("-Y 2 +X 8")).expect("a map");
        assert_eq!((map.width, map.height), (8, 2));
        assert_eq!(map.texels.len(), 16);
        assert_eq!(map.texels[2], u32::from_le_bytes([128, 3, 0, 129]));
        assert_eq!(map.texels[15], u32::from_le_bytes([128, 8, 0, 129]));
    }

    #[test]
    fn a_map_the_file_does_not_hold_is_refused() {
        let whole = file("-Y 2 +X 8");
        assert!(decode(&whole[..whole.len() - 1]).is_err(), "a truncated scanline");
        assert!(decode(&file("+Y 2 +X 8")).is_err(), "another orientation");
        assert!(decode(&file("-Y 99999 +X 99999")).is_err(), "a header past any map");
        let mut overrun = file("-Y 2 +X 8");
        let run = overrun.iter().position(|&byte| byte == 136).expect("the first run");
        overrun[run] = 137;
        assert!(decode(&overrun).is_err(), "a run past the scanline");
    }
}
