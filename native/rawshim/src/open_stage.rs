/// A step of an open, reported as it begins so a page can say what it is waiting on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Decoding,
    MeasuringNoise,
    FindingDust,
    Denoising,
    Demosaicing,
    Matching,
    Correcting,
}

impl Stage {
    pub const ALL: [Stage; 7] = [
        Stage::Decoding,
        Stage::MeasuringNoise,
        Stage::FindingDust,
        Stage::Denoising,
        Stage::Demosaicing,
        Stage::Matching,
        Stage::Correcting,
    ];

    /// What the page knows this stage as: `test/fixtures/tables/open-stages.txt`.
    pub fn name(self) -> &'static str {
        match self {
            Stage::Decoding => "decoding",
            Stage::MeasuringNoise => "measuring-noise",
            Stage::FindingDust => "finding-dust",
            Stage::Denoising => "denoising",
            Stage::Demosaicing => "demosaicing",
            Stage::Matching => "matching",
            Stage::Correcting => "correcting",
        }
    }
}

/// Where an open reports its stages.
pub type Report<'a> = &'a dyn Fn(Stage);

/// For an open nobody is watching.
pub fn quiet(_: Stage) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stages_are_the_ones_the_page_names() {
        let table: Vec<&str> =
            include_str!("../../../test/fixtures/tables/open-stages.txt").lines().collect();
        assert_eq!(Stage::ALL.map(Stage::name).to_vec(), table);
    }
}
