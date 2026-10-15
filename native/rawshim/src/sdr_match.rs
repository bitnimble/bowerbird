//! How a platform shows a PQ video's SDR range (`slang/sdr_match.slang`), which the 10-bit copies
//! and the editor's video frames made for it are coded to match.

use crate::light::{DisplayNits, Light};

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

impl SdrMatch {
    /// The name the page and the server use, `schemas/sdr_match.ts`.
    pub fn named(name: &str) -> Option<SdrMatch> {
        match name {
            "still" => Some(SdrMatch::Still),
            "mac-video" => Some(SdrMatch::MacVideo),
            _ => None,
        }
    }

    pub fn white(self) -> Light<DisplayNits> {
        match self {
            SdrMatch::Still => Light::exactly(crate::gpu::CANVAS_WHITE_NITS),
            SdrMatch::MacVideo => Light::exactly(MAC_VIDEO_WHITE_NITS),
        }
    }

    pub fn reads_sdr_as_power(self) -> bool {
        self == SdrMatch::MacVideo
    }

    /// `sdr_match.slang`'s `matched` for one channel, on the host: for scalars like a copy's
    /// content light level, never a picture's pixels.
    pub fn of_still(self, still: Light<DisplayNits>) -> Light<DisplayNits> {
        let whites = still.raw() / crate::gpu::CANVAS_WHITE_NITS;
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
