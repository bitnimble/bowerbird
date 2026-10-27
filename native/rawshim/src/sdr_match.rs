//! How a platform shows a PQ video's SDR range (`slang/sdr_match.slang`), which the 10-bit copies
//! and the editor's video frames made for it are coded to match.

use units::light::{DisplayNits, Light};

const MAC_VIDEO_WHITE_NITS: f64 = 100.0;
const SDR_READ_POWER: f64 = 2.2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SdrMatch {
    /// As a browser shows a PQ still: SDR white at 203 nits, the sRGB curve under it.
    Still,
    /// As Firefox on macOS shows a PQ video, matched by eye on an XDR display against Chrome showing
    /// the still: SDR white at 100 nits, and the SDR under it read through a 2.2 power where the
    /// sRGB curve made it.
    MacVideo,
}

const NAMES: [(&str, SdrMatch); 2] = [
    ("still", SdrMatch::Still),
    ("mac-video", SdrMatch::MacVideo),
];

impl SdrMatch {
    /// The name the page and the server use, `schemas/sdr_match.ts`.
    pub fn named(name: &str) -> Option<SdrMatch> {
        NAMES
            .iter()
            .find(|(named, _)| *named == name)
            .map(|&(_, matching)| matching)
    }

    fn white(self) -> Light<DisplayNits> {
        match self {
            SdrMatch::Still => Light::exactly(crate::grade::CANVAS_WHITE_NITS),
            SdrMatch::MacVideo => Light::exactly(MAC_VIDEO_WHITE_NITS),
        }
    }

    fn reads_sdr_as_power(self) -> bool {
        self == SdrMatch::MacVideo
    }

    /// `sdr_match.slang`'s `matched` for one channel, on the host: for scalars like a copy's
    /// content light level, never a picture's pixels.
    pub fn of_still(self, still: Light<DisplayNits>) -> Light<DisplayNits> {
        let whites = still.raw() / crate::grade::CANVAS_WHITE_NITS;
        let shown = match self.reads_sdr_as_power() && whites < 1.0 {
            true => crate::hdr_fit::srgb_oetf(whites.max(0.0)).powf(SDR_READ_POWER),
            false => whites,
        };
        Light::exactly(shown * self.white().raw())
    }

    pub(crate) fn words(self) -> [u32; 2] {
        [
            (self.white().raw() as f32).to_bits(),
            u32::from(self.reads_sdr_as_power()),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::{NAMES, SDR_READ_POWER};

    #[test]
    fn the_names_are_the_schemas() {
        let quoted: Vec<String> = NAMES.iter().map(|(name, _)| format!("'{name}'")).collect();
        let line = format!(
            "export const SdrMatchSchema = z.enum([{}]);",
            quoted.join(", ")
        );
        assert!(
            include_str!("../../../src/schemas/sdr_match.ts").contains(&line),
            "src/schemas/sdr_match.ts does not say `{line}`"
        );
    }

    #[test]
    fn the_read_power_is_the_shaders() {
        let line = format!("static const float SDR_READ_POWER = {SDR_READ_POWER:?};");
        assert!(
            include_str!("../../../slang/sdr_match.slang").contains(&line),
            "slang/sdr_match.slang does not say `{line}`"
        );
    }
}
