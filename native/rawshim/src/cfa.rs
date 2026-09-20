//! Which colour each photosite carries, as a period rather than as a 2x2.
//!
//! **Every stage below this once took `[u32; 4]` and asked `(row & 1, col & 1)` for a colour.** That
//! is true of every Bayer sensor and of nothing else: Fuji's X-Trans repeats over 6x6, with 20 greens
//! to 8 reds and 8 blues, and no 2x2 of it contains one of each colour. So the pattern travels as its
//! own period and its own colours, and the arithmetic a reader used to spell for itself - the
//! modulo, the count of a colour, whether a 2x2 exists at all - is here once.
//!
//! A shader reads [`Cfa::shape`], which is `mosaic.slang`'s group 0 and the one description of a
//! pattern both demosaics share.

/// The largest period carried, which is X-Trans's.
pub const MAX_PERIOD: usize = 6;

/// Positions in the largest period, which every shader that tabulates by position sizes itself to.
pub const MAX_SLOTS: usize = MAX_PERIOD * MAX_PERIOD;

/// 0 red, 1 green, 2 blue, matching rawler's `CFA_COLOR_*` and every shader below.
pub const RED: u8 = 0;
pub const GREEN: u8 = 1;
pub const BLUE: u8 = 2;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Cfa {
    width: u8,
    height: u8,
    colours: [u8; MAX_SLOTS],
}

impl Cfa {
    /// `colours` is row-major over `width * height`, from the top-left of the frame.
    ///
    /// None for a period this cannot carry, or for a colour outside red, green and blue - which is
    /// how the RGBW and CMYG sensors rawler also knows about are turned away before anything below
    /// tries to render one.
    pub fn new(width: usize, height: usize, colours: &[u8]) -> Option<Self> {
        if width == 0 || height == 0 || width > MAX_PERIOD || height > MAX_PERIOD {
            return None;
        }
        if colours.len() != width * height || colours.iter().any(|&c| c > BLUE) {
            return None;
        }
        let mut held = [0u8; MAX_SLOTS];
        held[..colours.len()].copy_from_slice(colours);
        Some(Self { width: width as u8, height: height as u8, colours: held })
    }

    pub fn bayer(quad: [u32; 4]) -> Option<Self> {
        let colours: Vec<u8> = quad.iter().map(|&c| c.min(255) as u8).collect();
        Self::new(2, 2, &colours)
    }

    pub fn from_rawler(cfa: &rawler::CFA) -> Option<Self> {
        let mut colours = Vec::with_capacity(cfa.width * cfa.height);
        for row in 0..cfa.height {
            for col in 0..cfa.width {
                colours.push(u8::try_from(cfa.color_at(row, col)).ok()?);
            }
        }
        Self::new(cfa.width, cfa.height, &colours)
    }

    pub fn period(&self) -> (usize, usize) {
        (self.width as usize, self.height as usize)
    }

    /// Positions in one period, which is how many slots anything keyed by position needs.
    pub fn slots(&self) -> usize {
        self.width as usize * self.height as usize
    }

    /// Where a frame coordinate lands in the period.
    pub fn slot_at(&self, row: usize, col: usize) -> usize {
        (row % self.height as usize) * self.width as usize + col % self.width as usize
    }

    pub fn colour_at(&self, row: usize, col: usize) -> u8 {
        self.colours[self.slot_at(row, col)]
    }

    pub fn colour_of_slot(&self, slot: usize) -> u8 {
        self.colours[slot]
    }

    /// How many photosites of each colour one period holds: `[8, 20, 8]` for X-Trans, `[1, 2, 1]`
    /// for Bayer. What the demultiplexing's baseband weights are built from.
    /// What each of the denoise's two chroma axes carries of one photosite's noise.
    ///
    /// **The shrinkage's threshold is calibrated against an axis that carries exactly one sigma**,
    /// which the 2x2 pair does by construction: four independent samples at a magnitude of a half.
    /// A period's pair is built from per-colour *means* instead, so each axis carries only what
    /// averaging over that many samples leaves - `mR - mB` is `sqrt(1/nR + 1/nB)` and
    /// `mR - 2mG + mB` is `sqrt(1/nR + 4/nG + 1/nB)`. On X-Trans's 8, 20 and 8 that is half a sigma
    /// and two thirds, unequal to each other as well as to the pair the threshold was measured
    /// against, so both axes are read as noisier than they are and shrunk too hard - which takes
    /// colour detail out while leaving the noise that motivated the slider.
    ///
    /// Counted off the pattern rather than written down for X-Trans, because the denoise takes any
    /// period whose colours are all present and each of them divides differently.
    pub fn chroma_gain(&self) -> [f32; 2] {
        if self.is_bayer() {
            return [1.0, 1.0];
        }
        let counts = self.counts();
        let share = |colour: usize, weight: f32| match counts[colour] {
            0 => 0.0,
            n => weight / n as f32,
        };
        [
            (share(0, 1.0) + share(2, 1.0)).sqrt(),
            (share(0, 1.0) + share(1, 4.0) + share(2, 1.0)).sqrt(),
        ]
    }

    pub fn counts(&self) -> [usize; 3] {
        let mut counts = [0usize; 3];
        for &colour in &self.colours[..self.slots()] {
            counts[colour as usize] += 1;
        }
        counts
    }

    /// Two greens on one diagonal of a 2x2, one red and one blue on the other.
    ///
    /// That covers RGGB, BGGR, GRBG and GBRG and excludes everything else, which is the question RCD
    /// asks: every stage of it pairs rows and columns into 2x2 sites.
    pub fn is_bayer(&self) -> bool {
        let Some(quad) = self.as_2x2() else { return false };
        let (a, b) = if quad[1] == GREEN as u32 && quad[2] == GREEN as u32 {
            (quad[0], quad[3])
        } else if quad[0] == GREEN as u32 && quad[3] == GREEN as u32 {
            (quad[1], quad[2])
        } else {
            return false;
        };
        (a == RED as u32 && b == BLUE as u32) || (a == BLUE as u32 && b == RED as u32)
    }

    /// The four colours of the 2x2, for the stages that are written in terms of one.
    pub fn as_2x2(&self) -> Option<[u32; 4]> {
        if self.width != 2 || self.height != 2 {
            return None;
        }
        Some([
            u32::from(self.colours[0]),
            u32::from(self.colours[1]),
            u32::from(self.colours[2]),
            u32::from(self.colours[3]),
        ])
    }

    /// Whether this is the 6x6 with every row and every column carrying all three colours, which is
    /// what X-Trans is and what `lslcd` is designed against.
    ///
    /// Asked rather than assumed from the period, because a 6x6 that fails it would be demultiplexed
    /// against carriers that do not describe it - a picture of the right shape and the wrong colours,
    /// which nothing downstream can notice.
    pub fn is_xtrans(&self) -> bool {
        if self.width != 6 || self.height != 6 {
            return false;
        }
        if self.counts() != [8, 20, 8] {
            return false;
        }
        (0..6).all(|line| {
            let row: Vec<u8> = (0..6).map(|col| self.colour_at(line, col)).collect();
            let column: Vec<u8> = (0..6).map(|r| self.colour_at(r, line)).collect();
            [RED, GREEN, BLUE].iter().all(|c| row.contains(c) && column.contains(c))
        })
    }

    /// A region lifted out of the frame keeps the frame's colours only if its origin sits on a whole
    /// period; otherwise every photosite in it is relabelled.
    pub fn aligned(&self, left: usize, top: usize) -> bool {
        left % self.width as usize == 0 && top % self.height as usize == 0
    }

    /// An origin moved back to the nearest whole period at or before it.
    ///
    /// **Every region lifted out of the mosaic passes through this, and the cost of missing one is a
    /// picture rather than an error.** A stage reads a photosite's colour from where it sits inside
    /// the region, so an origin off the period relabels every sample in it - and what comes back has
    /// the right shape, the right exposure, and a lattice of false colour at the pattern's own pitch
    /// laid over the whole frame. Bayer hid this for as long as it did because aligning to a 2x2
    /// site is the same arithmetic as making a coordinate even, which several callers were already
    /// doing for reasons of their own.
    pub fn align_origin(&self, left: usize, top: usize) -> (usize, usize) {
        let (w, h) = (self.width as usize, self.height as usize);
        (left / w * w, top / h * h)
    }

    /// An extent trimmed to whole periods, so a region's far edge lands on a site boundary too.
    pub fn align_extent(&self, width: usize, height: usize) -> (usize, usize) {
        let (w, h) = (self.width as usize, self.height as usize);
        (width / w * w, height / h * h)
    }

    /// The period's colours two bits apiece, twelve to a word.
    ///
    /// Red, green and blue are 0, 1 and 2, so two bits hold a colour and 36 of them hold a period.
    /// `mosaic.slang` says why this is packed rather than an array, and the bench says what the
    /// array cost.
    pub fn packed_colours(&self) -> [u32; 3] {
        let mut packed = [0u32; 3];
        for slot in 0..self.slots() {
            packed[slot / 12] |= u32::from(self.colours[slot]) << ((slot % 12) * 2);
        }
        packed
    }

    /// The block every demosaic's group 0 carries, whichever one is running.
    ///
    /// The period is not in it: `mosaic.slang` takes that as a specialisation constant, so a
    /// pipeline is compiled for one period and the modulo folds. [`Cfa::constants`] is the pair.
    pub fn shape(&self, width: usize, height: usize, margin: u32) -> Shape {
        let packed = self.packed_colours();
        Shape {
            width: width as u32,
            height: height as u32,
            margin,
            packed0: packed[0],
            packed1: packed[1],
            packed2: packed[2],
            pad: [0; 2],
        }
    }

    /// `mosaic.slang`'s `PERIOD_W` and `PERIOD_H`, keyed by the ids its `[vk::constant_id]` fixes.
    ///
    /// Keyed by id rather than by name for `gpu.rs`'s reason: the generated WGSL renames a
    /// specialisation constant, and a key matching none of them is a pipeline the driver refuses.
    pub fn constants(&self) -> [(&'static str, f64); 2] {
        [("0", f64::from(self.width)), ("1", f64::from(self.height))]
    }
}

/// `Shape` in `slang/mosaic.slang`. Order and padding must match what the module declares.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Shape {
    width: u32,
    height: u32,
    margin: u32,
    packed0: u32,
    packed1: u32,
    packed2: u32,
    /// Written out rather than left implicit: the uniform address space rounds a struct to sixteen
    /// and the host builds these bytes itself, so the gap has to be something it can see.
    pad: [u32; 2],
}

/// What [`Cfa::shape`] writes, for `wgsl_layout`, which holds it against the struct the module
/// declares.
#[cfg(test)]
pub(crate) fn shape_block() -> usize {
    std::mem::size_of::<Shape>()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The pattern `rawler/data/cameras/fuji/x-h2.toml` carries, which is the phase the X-H2 and the
    /// GFX 100 write.
    pub(crate) const XTRANS: &str = "GGRGGBGGBGGRBRGRBGGGBGGRGGRGGBRBGBRG";

    pub(crate) fn parse(pattern: &str, width: usize, height: usize) -> Cfa {
        let colours: Vec<u8> = pattern
            .chars()
            .map(|c| match c {
                'R' => RED,
                'G' => GREEN,
                _ => BLUE,
            })
            .collect();
        Cfa::new(width, height, &colours).expect("a pattern this module can carry")
    }

    #[test]
    fn a_bayer_quad_is_recognised_in_every_phase() {
        for quad in [[0u32, 1, 1, 2], [2, 1, 1, 0], [1, 0, 2, 1], [1, 2, 0, 1]] {
            assert!(Cfa::bayer(quad).unwrap().is_bayer(), "{quad:?}");
        }
    }

    #[test]
    fn a_quad_of_one_colour_is_not_bayer() {
        assert!(!Cfa::bayer([1, 1, 1, 1]).unwrap().is_bayer());
        assert!(!Cfa::bayer([0, 1, 2, 1]).unwrap().is_bayer());
    }

    #[test]
    fn xtrans_is_twenty_greens_and_every_line_carrying_every_colour() {
        let cfa = parse(XTRANS, 6, 6);
        assert_eq!(cfa.counts(), [8, 20, 8]);
        assert!(cfa.is_xtrans());
        assert!(!cfa.is_bayer());
        assert_eq!(cfa.as_2x2(), None);
    }

    /// `x-t5.toml` and `x-pro1.toml` carry a 36-character pattern whose fifth column holds no blue,
    /// so it is not an X-Trans phase at all. Files from those bodies name their own layout in
    /// metadata and never reach the table, but a pattern that did would be turned away rather than
    /// demultiplexed against carriers that do not describe it.
    #[test]
    fn a_six_by_six_that_is_not_xtrans_is_refused() {
        let stale = parse("GGRGGBGGBGGRBRGRGBGGBGGRGGRGGBRBGBRG", 6, 6);
        assert!(!stale.is_xtrans());
    }

    #[test]
    fn a_slot_is_the_position_within_the_period() {
        let cfa = parse(XTRANS, 6, 6);
        assert_eq!(cfa.slot_at(0, 0), 0);
        assert_eq!(cfa.slot_at(6, 6), 0);
        assert_eq!(cfa.slot_at(7, 8), 8);
        assert_eq!(cfa.colour_at(0, 2), RED);
        assert_eq!(cfa.colour_at(6, 8), RED);
    }

    #[test]
    fn a_region_origin_off_the_period_relabels_every_photosite() {
        let cfa = parse(XTRANS, 6, 6);
        assert!(cfa.aligned(12, 18));
        assert!(!cfa.aligned(2, 0));
        assert!(Cfa::bayer([0, 1, 1, 2]).unwrap().aligned(2, 4));
    }

    /// **What `assemble.slang`'s highlight reconstruction rests on.** `fills_at` averages a 3x3 to
    /// ask how full each colour's wells are here, and a window holding none of a colour reports that
    /// colour as empty - which reads as "not clipped" on a blown highlight, and leaves the
    /// reconstruction to tint a sun with the illuminant's own ratios. It is obvious for Bayer, where
    /// any 3x3 holds all four positions. For X-Trans it is a property of the pattern rather than of
    /// the window size, and it is true, but only just: the 2x2 green clumps mean several windows
    /// carry exactly one red or one blue.
    #[test]
    fn every_three_by_three_window_holds_every_colour() {
        for cfa in [parse(XTRANS, 6, 6), Cfa::bayer([0, 1, 1, 2]).unwrap()] {
            let (period_w, period_h) = cfa.period();
            for row in 0..period_h {
                for col in 0..period_w {
                    let mut seen = [false; 3];
                    for dr in 0..3 {
                        for dc in 0..3 {
                            seen[usize::from(cfa.colour_at(row + dr, col + dc))] = true;
                        }
                    }
                    assert!(seen.iter().all(|&it| it), "the window at {row},{col} misses a colour");
                }
            }
        }
    }

    /// The packing read back the way `mosaic.slang` reads it: two encodings of one pattern are one
    /// encoding and one bug otherwise.
    #[test]
    fn the_packed_colours_unpack_to_the_pattern() {
        for cfa in [parse(XTRANS, 6, 6), Cfa::bayer([0, 1, 1, 2]).unwrap()] {
            let packed = cfa.packed_colours();
            for slot in 0..cfa.slots() {
                let word = slot / 12;
                let unpacked = (packed[word] >> ((slot - word * 12) * 2)) & 3;
                assert_eq!(unpacked, u32::from(cfa.colour_of_slot(slot)), "slot {slot}");
            }
        }
    }

    #[test]
    fn a_colour_outside_rgb_is_refused() {
        assert_eq!(Cfa::new(2, 2, &[0, 1, 1, 6]), None);
        assert_eq!(Cfa::new(8, 8, &[0; 64]), None);
    }
}
