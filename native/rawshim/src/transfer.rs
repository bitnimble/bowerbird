//! What a finished picture's code values mean, and the scale they land on.
//!
//! **A RAW carries no colour space and a delivered picture carries nothing else.** The sensor's
//! samples are counts of light in the camera's own primaries, and `decode_rawler` reads the matrix
//! that takes them to Rec.2020 off the file. A JPEG, a PNG, a HEIC or an AVIF has been rendered
//! already: its numbers are code values in somebody's transfer, in somebody's primaries, and both
//! have to be undone before the pipeline can treat them as light.
//!
//! Everything here is host arithmetic evaluated once per photograph, into the table
//! `linearise.slang` reads. The kernel is a lookup for the reason `condition.slang` is: a transfer
//! is a function of a code value alone, so evaluating it per pixel is tens of millions of `pow`
//! calls for an answer that has at most 65536 distinct results - and a shader spelling the curve
//! itself disagrees with this one in the last bit, over the frame every rendition is built from.

/// How far above reference white the scene-linear frame can go before it clips.
///
/// **Three stops, because that is what a RAW's metered exposure actually leaves.** The pipeline's
/// currency is a linear `u16`, so a scale is a trade between shadow resolution and highlight
/// headroom, and PQ's own range would spend it all on the second: BT.2408 puts reference white at
/// 203 nits of 10000, so honouring the whole curve would put diffuse white at level 1337 and leave
/// an 8-bit shadow step below the first level. A RAW's diffuse white sits a few stops under sensor
/// saturation - the same shape, arrived at from the other end - and matching it is what lets one
/// grade read both.
///
/// The cost is stated: a capture graded for a 4000-nit master clips at 1624. Everything above
/// that was going through `frame.slang`'s roll-off into a display peak far below it.
pub const HDR_HEADROOM: f64 = 8.0;

/// The top of a frame's sample container: what a `u16` holds.
pub const FULL_SCALE: f64 = 65535.0;

/// BT.2408's reference white, which is what an HDR signal's diffuse white is coded at.
const REFERENCE_NITS: f64 = 203.0;

/// The transfer a delivered picture's code values are in.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Curve {
    /// IEC 61966-2-1, the piecewise curve every JPEG and PNG is assumed to be in.
    Srgb,
    /// BT.709's camera OETF, which is not sRGB's: the toe is steeper and the exponent is 0.45.
    Rec709,
    /// A plain power law, for an ICC profile that states one.
    Gamma(f32),
    /// SMPTE ST 2084, absolute: a code is a number of nits.
    Pq,
    /// BT.2100 hybrid log-gamma, scene-referred.
    Hlg,
    Linear,
}

impl Curve {
    /// A normalised code value as light, relative to reference white.
    ///
    /// 1.0 is diffuse white for every arm, which is what makes the two families comparable: an
    /// SDR curve's own 1.0, PQ's 203 nits, and HLG's 75% signal are the same brightness.
    pub fn light(self, code: f64) -> crate::light::Light<crate::light::Scene> {
        let code = code.clamp(0.0, 1.0);
        crate::light::Light::exactly(match self {
            Curve::Srgb => match code <= 0.040_45 {
                true => code / 12.92,
                false => ((code + 0.055) / 1.055).powf(2.4),
            },
            Curve::Rec709 => match code < 0.081 {
                true => code / 4.5,
                false => ((code + 0.099) / 1.099).powf(1.0 / 0.45),
            },
            Curve::Gamma(exponent) => code.powf(f64::from(exponent)),
            Curve::Pq => {
                crate::tone::pq_inv::<crate::light::SceneNits>(crate::light::Light::exactly(code))
                    .raw()
                    / REFERENCE_NITS
            }
            // **Through the OOTF, not the inverse OETF alone.** HLG's signal is scene-referred
            // and PQ's is display light, so normalising HLG in the scene domain would put the two
            // families on different scales - which is the one thing this function exists to stop.
            // BT.2100's system gamma is what closes the gap: with it, HLG's peak lands at 4.92
            // times reference white, which is BT.2408's 1000 nits over 203; without it, 3.77, and
            // the midtones are 26% high as well because the error is a gamma rather than a scale.
            //
            // Per channel, which is BT.2390's approximate EOTF rather than BT.2100's exact one:
            // the exact OOTF scales by a power of the *scene luminance*, and a table indexed by a
            // single code value cannot see the other two channels.
            Curve::Hlg => {
                (hlg_scene(code) / hlg_scene(HLG_REFERENCE_SIGNAL)).powf(HLG_SYSTEM_GAMMA)
            }
            Curve::Linear => code,
        })
    }

    /// Whether this curve can carry anything above diffuse white.
    ///
    /// The scale follows from it: an SDR picture's brightest code *is* white, so giving it
    /// headroom would only throw resolution away, where an HDR one's would clip without.
    pub fn carries_highlights(self) -> bool {
        matches!(self, Curve::Pq | Curve::Hlg)
    }
}

/// Where BT.2100 puts reference white on the HLG signal.
const HLG_REFERENCE_SIGNAL: f64 = 0.75;

/// BT.2100's system gamma at a 1000-nit nominal peak, which is what takes HLG's scene light to
/// the display light PQ states directly.
const HLG_SYSTEM_GAMMA: f64 = 1.2;

/// BT.2100's inverse OETF: a signal as scene light, 1.0 being the signal's own peak.
fn hlg_scene(signal: f64) -> f64 {
    const A: f64 = 0.178_832_77;
    const B: f64 = 0.284_668_92;
    const C: f64 = 0.559_910_73;
    match signal <= 0.5 {
        true => signal * signal / 3.0,
        false => (((signal - C) / A).exp() + B) / 12.0,
    }
}

/// The primaries a picture's code values are in, as CIE xy chromaticities.
///
/// Chromaticities rather than four hardcoded matrices: the matrix is derived below, so a space
/// added here is three pairs of numbers off its own specification rather than nine off somebody's
/// arithmetic.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Primaries {
    pub red: (f64, f64),
    pub green: (f64, f64),
    pub blue: (f64, f64),
    pub white: (f64, f64),
}

const D65: (f64, f64) = (0.3127, 0.3290);

impl Primaries {
    pub const REC709: Primaries = Primaries {
        red: (0.640, 0.330),
        green: (0.300, 0.600),
        blue: (0.150, 0.060),
        white: D65,
    };
    pub const REC2020: Primaries = Primaries {
        red: (0.708, 0.292),
        green: (0.170, 0.797),
        blue: (0.131, 0.046),
        white: D65,
    };
    pub const DISPLAY_P3: Primaries = Primaries {
        red: (0.680, 0.320),
        green: (0.265, 0.690),
        blue: (0.150, 0.060),
        white: D65,
    };
    pub const ADOBE_RGB: Primaries = Primaries {
        red: (0.640, 0.330),
        green: (0.210, 0.710),
        blue: (0.150, 0.060),
        white: D65,
    };

    /// The matrix taking this space's linear RGB to CIE XYZ, by the usual construction: the
    /// primaries as columns, scaled so that RGB (1,1,1) is the white point.
    fn to_xyz(self) -> [[f64; 3]; 3] {
        let column = |(x, y): (f64, f64)| match y == 0.0 {
            true => [0.0, 0.0, 0.0],
            false => [x / y, 1.0, (1.0 - x - y) / y],
        };
        let (r, g, b) = (column(self.red), column(self.green), column(self.blue));
        let white = column(self.white);
        let basis = [[r[0], g[0], b[0]], [r[1], g[1], b[1]], [r[2], g[2], b[2]]];
        let scale = match invert(basis) {
            Some(inverse) => apply(inverse, white),
            None => [1.0, 1.0, 1.0],
        };
        let mut matrix = [[0.0; 3]; 3];
        for (row, out) in matrix.iter_mut().enumerate() {
            for (column, cell) in out.iter_mut().enumerate() {
                *cell = basis[row][column] * scale[column];
            }
        }
        matrix
    }

    /// This space's linear RGB as Rec.2020's, which is what every stage below the decode reads.
    ///
    /// Identity for a Rec.2020 source, arrived at rather than special-cased.
    pub fn to_rec2020(self) -> [[f32; 3]; 3] {
        from_xyz(self.to_xyz())
    }

    /// The way back: Rec.2020's linear RGB as this space's, which is what a display transform
    /// rotates through on its way to a canvas.
    ///
    /// `f64` where `to_rec2020` is `f32`, because this is what `slang/primaries.slang`'s literals
    /// are held against and six places of agreement is the whole point of the comparison.
    pub fn from_rec2020(self) -> [[f64; 3]; 3] {
        match invert(self.to_xyz()) {
            Some(inverse) => multiply(inverse, Primaries::REC2020.to_xyz()),
            None => [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        }
    }
}

/// A source's RGB-to-XYZ as its RGB-to-Rec.2020, whatever produced the first.
///
/// The one place the destination is named, so an ICC profile's colorants and a set of
/// chromaticities land on the same matrix rather than on two derivations of it.
fn from_xyz(to_xyz: [[f64; 3]; 3]) -> [[f32; 3]; 3] {
    let Some(inverse) = invert(Primaries::REC2020.to_xyz()) else {
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    };
    let combined = multiply(inverse, to_xyz);
    let mut out = [[0.0f32; 3]; 3];
    for (row, cells) in combined.iter().enumerate() {
        for (column, cell) in cells.iter().enumerate() {
            out[row][column] = *cell as f32;
        }
    }
    out
}

/// Bradford, D65 to the D50 an ICC profile's colorants are adapted to.
///
/// **Only ever used to move Rec.2020 into the profile's own reference**, which is what makes an
/// ICC path need no `chad` tag of its own: the colorants are already D50, so adapting the
/// destination the same way leaves the conversion between them exact.
const D65_TO_D50: [[f64; 3]; 3] = [
    [1.047_886, 0.022_919, -0.050_216],
    [0.029_582, 0.990_484, -0.017_079],
    [-0.009_252, 0.015_073, 0.751_678],
];

fn apply(matrix: [[f64; 3]; 3], vector: [f64; 3]) -> [f64; 3] {
    let mut out = [0.0; 3];
    for (row, cells) in matrix.iter().enumerate() {
        out[row] = cells[0] * vector[0] + cells[1] * vector[1] + cells[2] * vector[2];
    }
    out
}

fn multiply(left: [[f64; 3]; 3], right: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0; 3]; 3];
    for (row, cells) in out.iter_mut().enumerate() {
        for (column, cell) in cells.iter_mut().enumerate() {
            *cell = (0..3).map(|k| left[row][k] * right[k][column]).sum();
        }
    }
    out
}

fn invert(matrix: [[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let m = matrix;
    let cofactor = [
        [
            m[1][1] * m[2][2] - m[1][2] * m[2][1],
            m[0][2] * m[2][1] - m[0][1] * m[2][2],
            m[0][1] * m[1][2] - m[0][2] * m[1][1],
        ],
        [
            m[1][2] * m[2][0] - m[1][0] * m[2][2],
            m[0][0] * m[2][2] - m[0][2] * m[2][0],
            m[0][2] * m[1][0] - m[0][0] * m[1][2],
        ],
        [
            m[1][0] * m[2][1] - m[1][1] * m[2][0],
            m[0][1] * m[2][0] - m[0][0] * m[2][1],
            m[0][0] * m[1][1] - m[0][1] * m[1][0],
        ],
    ];
    let determinant = m[0][0] * cofactor[0][0] + m[0][1] * cofactor[1][0] + m[0][2] * cofactor[2][0];
    if determinant.abs() < 1e-12 {
        return None;
    }
    let mut out = [[0.0; 3]; 3];
    for (row, cells) in out.iter_mut().enumerate() {
        for (column, cell) in cells.iter_mut().enumerate() {
            *cell = cofactor[row][column] / determinant;
        }
    }
    Some(out)
}

/// Everything about a delivered picture's numbers that is not the numbers.
#[derive(Clone, Copy, Debug)]
pub struct Coding {
    /// The source's linear RGB as Rec.2020's, which is what `linearise.slang` multiplies by.
    ///
    /// A matrix rather than a named space, because an ICC profile does not name one: it states
    /// its colorants, and those are as good an answer as a set of chromaticities.
    pub matrix: [[f32; 3]; 3],
    pub curve: Curve,
    /// How many of a `u16`'s bits the decoder actually filled, which is what the table is indexed
    /// over. 8 for a JPEG, 8 or 10 for a HEIC, up to 16 for a PNG.
    pub depth: u32,
}

impl Coding {
    /// What every picture with no colour information at all is read as.
    pub fn srgb(depth: u32) -> Coding {
        Coding::of(Primaries::REC709, Curve::Srgb, depth)
    }

    pub fn of(primaries: Primaries, curve: Curve, depth: u32) -> Coding {
        Coding { matrix: primaries.to_rec2020(), curve, depth }
    }

    /// A picture whose container states CICP code points: a HEIF `colr nclx`, or a PNG `cICP`.
    ///
    /// Anything unrecognised falls back to the sRGB reading rather than refusing the file, and
    /// says so - a picture in the wrong primaries is a picture, and the alternative is a
    /// photograph the library will not import.
    pub fn from_cicp(primaries: u16, transfer: u16, depth: u32) -> Coding {
        // ITU-T H.273 Table 2. 12 is Display P3 and 11 is DCI-P3, which share primaries and
        // differ only in a white point no still photograph is ever mastered to.
        let space = match primaries {
            // 2 is "unspecified", which every profile reads as its own default rather than as a
            // file saying something this build failed to understand.
            1 | 2 => Primaries::REC709,
            5 | 6 | 7 => Primaries::REC709,
            9 => Primaries::REC2020,
            11 | 12 => Primaries::DISPLAY_P3,
            other => {
                crate::warn(&format!(
                    "rawshim: this picture states colour primaries {other}, which this build does \
                     not know; reading it as Rec.709",
                ));
                Primaries::REC709
            }
        };
        // Table 3. 2 is "unspecified", which every profile says to read as its own default.
        let curve = match transfer {
            1 | 6 | 14 | 15 => Curve::Rec709,
            8 => Curve::Linear,
            4 => Curve::Gamma(2.2),
            16 => Curve::Pq,
            18 => Curve::Hlg,
            13 | 2 | 0 => Curve::Srgb,
            other => {
                crate::warn(&format!(
                    "rawshim: this picture states transfer characteristics {other}, which this \
                     build does not know; reading it as sRGB",
                ));
                Curve::Srgb
            }
        };
        Coding::of(space, curve, depth)
    }

    /// A picture carrying an ICC profile, where one can be read as a matrix and a curve.
    ///
    /// **Matrix-shaper profiles only, which is every display profile anyone tags a photograph
    /// with** - sRGB, Display P3, Adobe RGB, ProPhoto. A LUT-based profile (a printer's, a
    /// scanner's) has no matrix to take, and this declines rather than inventing one.
    pub fn from_icc(profile: &[u8], depth: u32) -> Option<Coding> {
        let tag = |want: &[u8; 4]| -> Option<&[u8]> {
            // Bounded by what the buffer can actually hold rather than trusted: the count is a
            // `u32` out of the file, and a profile declaring four billion tags would otherwise
            // spin through four billion bounds-checked reads per lookup and stall an import on
            // one bad photograph.
            let stated = be32(profile.get(128..132)?) as usize;
            let count = stated.min(profile.len().saturating_sub(132) / 12);
            (0..count).find_map(|at| {
                let entry = profile.get(132 + at * 12..132 + at * 12 + 12)?;
                if &entry[..4] != want {
                    return None;
                }
                let (offset, size) = (be32(&entry[4..8]) as usize, be32(&entry[8..12]) as usize);
                profile.get(offset..offset.checked_add(size)?)
            })
        };
        // s15Fixed16 triples, which is what a colorant tag's `XYZ ` payload is.
        let colorant = |want: &[u8; 4]| -> Option<[f64; 3]> {
            let body = tag(want)?;
            let fixed = |at: usize| -> Option<f64> {
                Some(f64::from(be32(body.get(at..at + 4)?) as i32) / 65536.0)
            };
            Some([fixed(8)?, fixed(12)?, fixed(16)?])
        };
        let (red, green, blue) = (colorant(b"rXYZ")?, colorant(b"gXYZ")?, colorant(b"bXYZ")?);
        let to_xyz = [
            [red[0], green[0], blue[0]],
            [red[1], green[1], blue[1]],
            [red[2], green[2], blue[2]],
        ];
        // The colorants are adapted to the PCS illuminant, so the destination is adapted with
        // them and the conversion between the two stays exact.
        let inverse = invert(multiply(D65_TO_D50, Primaries::REC2020.to_xyz()))?;
        let mut matrix = [[0.0f32; 3]; 3];
        for (row, cells) in multiply(inverse, to_xyz).iter().enumerate() {
            for (column, cell) in cells.iter().enumerate() {
                matrix[row][column] = *cell as f32;
            }
        }
        Some(Coding { matrix, curve: icc_curve(tag(b"rTRC")?), depth })
    }

    /// The level reference white lands on, which is full scale unless the picture can go above it.
    pub fn white_level(&self, gain_mapped: bool) -> f64 {
        match self.curve.carries_highlights() || gain_mapped {
            true => FULL_SCALE / HDR_HEADROOM,
            false => FULL_SCALE,
        }
    }

    /// The table `linearise.slang` indexes by code value: every code this depth can take, as the
    /// light it stands for with diffuse white at 1.0.
    ///
    /// **Relative rather than on the frame's scale**, because the gain map is applied between the
    /// two and ISO 21496-1's offsets are in units of diffuse white. The shader's one multiply by
    /// [`Coding::white_level`] is what puts it on the scale.
    ///
    /// Sized to the depth rather than to 65536 always: a JPEG's table is 256 floats, and the
    /// alternative is a quarter of a megabyte uploaded per photograph to hold 255 answers.
    pub fn table(&self) -> Vec<f32> {
        let last = ((1u32 << self.depth.clamp(1, 16)) - 1) as f64;
        (0..=last as u32).map(|code| self.curve.light(f64::from(code) / last).raw() as f32).collect()
    }
}

/// An ICC tone curve as the nearest curve this crate evaluates.
///
/// **The three shapes a display profile actually uses.** `curv` with no points is linear; `curv`
/// with one is a plain gamma; `para` type 3 is sRGB's own piecewise curve, written out. A sampled
/// `curv` table is read as its midpoint gamma, which is within a code value of the table for every
/// display profile and is the alternative to carrying a second interpolation into the kernel.
fn icc_curve(body: &[u8]) -> Curve {
    // Every read below is bounds-checked, because a profile is bytes out of somebody's file: an
    // `iCCP` chunk truncated mid-tag would otherwise index past the slice, and a panic here takes
    // the rendition worker with it - or, in the browser build, the tab.
    let word = |at: usize| -> Option<u32> { body.get(at..at + 4).map(be32) };
    let half = |at: usize| -> Option<u16> {
        body.get(at..at + 2).map(|it| u16::from_be_bytes([it[0], it[1]]))
    };
    match body.get(..4) {
        // `None` is a tag too short to carry a count, which is not the same as a count of zero:
        // one is a file that said "linear" and the other is a file that said nothing, and reading
        // the second as the first renders the photograph with no transfer undone at all.
        Some(b"curv") => match word(8) {
            None => Curve::Srgb,
            Some(0) => Curve::Linear,
            // A `u8Fixed8` gamma, which is the whole curve.
            Some(1) => half(12).map_or(Curve::Srgb, |raw| Curve::Gamma(f32::from(raw) / 256.0)),
            Some(points) => {
                // **The gamma the table's midpoint implies**, which is within a code value of the
                // table for every display profile and is the alternative to carrying a second
                // interpolation into the kernel.
                //
                // `ln(y) / ln(x)`, and the order is the whole of it: the table is `y = x^g`
                // sampled at `x`, so the exponent is the log of the *sample* over the log of the
                // position. The other way up is `1/g` - which for the sampled sRGB curve that
                // Photoshop, Lightroom and most cameras embed reads 0.45 where the answer is
                // 2.22, and imports every one of those JPEGs about 1.75 stops over and flat.
                let at = 12 + (points as usize / 2) * 2;
                let Some(sample) = half(at) else { return Curve::Srgb };
                let y = f64::from(sample) / 65535.0;
                // The position that sample sits at, which is only 0.5 when the table has an odd
                // number of points; for an even one the midpoint index is half a step past it.
                let x = (points as usize / 2) as f64 / f64::from(points.saturating_sub(1).max(1));
                match y > 0.0 && x > 0.0 && x < 1.0 {
                    true => Curve::Gamma((y.ln() / x.ln()) as f32),
                    false => Curve::Srgb,
                }
            }
        },
        // Types 3 and 4 are sRGB's own shape - a linear toe into a displaced power law - and
        // types 0 to 2 are a plain power law. Read as their exponent rather than evaluated: the
        // toe is a fraction of a code value wide on every profile that states one, and the
        // alternative is a fifth `Curve` arm carrying five parameters into the table.
        Some(b"para") => match half(8).unwrap_or(0) {
            3 | 4 => Curve::Srgb,
            _ => {
                let g = f64::from(word(12).unwrap_or(0) as i32) / 65536.0;
                match g > 0.0 {
                    true => Curve::Gamma(g as f32),
                    false => Curve::Srgb,
                }
            }
        },
        _ => Curve::Srgb,
    }
}

fn be32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_curve_puts_diffuse_white_at_one() {
        // What makes an SDR JPEG and a PQ HEIC land on the same scale: their whites agree, and
        // only the HDR one has anything above.
        for curve in [Curve::Srgb, Curve::Rec709, Curve::Gamma(2.2), Curve::Linear] {
            assert!((curve.light(1.0).raw() - 1.0).abs() < 1e-9, "{curve:?}");
        }
        let white: crate::light::Light<crate::light::SceneNits> = crate::light::Light::exactly(203.0);
        let pq_white = Curve::Pq.light(crate::tone::pq(white).raw()).raw();
        assert!((pq_white - 1.0).abs() < 1e-3, "PQ's 203 nits is diffuse white, got {pq_white}");
        let hlg_white = Curve::Hlg.light(0.75).raw();
        assert!((hlg_white - 1.0).abs() < 1e-9, "HLG's 75% signal is diffuse white, got {hlg_white}");
    }

    #[test]
    fn only_an_hdr_curve_reaches_past_white() {
        assert!(Curve::Srgb.light(1.0).raw() <= 1.0);
        assert!(Curve::Pq.light(1.0).raw() > 40.0, "PQ's own peak is 10000 nits");
    }

    /// **HLG through the OOTF, which is what puts it on PQ's scale.** Its signal is scene light
    /// where PQ's is display light, so the inverse OETF alone leaves the peak at 3.77x white
    /// instead of BT.2408's 1000/203 - and because the gap is a gamma rather than a scale, the
    /// midtones are 26% high as well. Both numbers below are the standard's, not this code's.
    #[test]
    fn hlg_lands_on_the_same_scale_as_pq() {
        let peak = Curve::Hlg.light(1.0).raw();
        assert!((peak - 1000.0 / 203.0).abs() < 0.02, "HLG's peak came back at {peak}x white");
        // The half-signal, where the missing system gamma shows as a lifted midtone: 0.2496
        // display-referred against 0.3145 scene-referred.
        let half = Curve::Hlg.light(0.5).raw();
        assert!((half - 0.2496).abs() < 1e-3, "the 50% signal came back at {half}");
    }

    /// **The exponent of a sampled tone curve, not its reciprocal.** The stock sRGB profile that
    /// Photoshop, Lightroom and most cameras embed stores its `rTRC` as a 1024-entry `curv`, so
    /// this is the arm nearly every tagged JPEG in a library takes - and inverted it reads gamma
    /// 0.45 for a curve that is 2.2, which imports the photograph about 1.75 stops over and flat.
    #[test]
    fn a_sampled_tone_curve_reads_as_its_own_exponent() {
        // A 1024-point table of exactly `y = x^2.2`, which is what a profile writes out.
        let points = 1024u32;
        let mut body = Vec::new();
        body.extend_from_slice(b"curv");
        body.extend_from_slice(&[0; 4]);
        body.extend_from_slice(&points.to_be_bytes());
        for at in 0..points {
            let x = f64::from(at) / f64::from(points - 1);
            body.extend_from_slice(&((x.powf(2.2) * 65535.0).round() as u16).to_be_bytes());
        }

        let Curve::Gamma(exponent) = icc_curve(&body) else {
            panic!("expected a power law, got {:?}", icc_curve(&body));
        };
        assert!((exponent - 2.2).abs() < 0.02, "read back as gamma {exponent}");
        // And the failure it is guarding against, named: the reciprocal is nowhere near.
        assert!(exponent > 1.0, "an inverted exponent would be 0.45");
    }

    /// A profile is bytes out of somebody's file, and a truncated tag must fall back rather than
    /// index past itself - a panic here is a rendition worker, or a browser tab.
    #[test]
    fn a_truncated_tone_curve_falls_back_rather_than_panicking() {
        assert_eq!(icc_curve(b"curv"), Curve::Srgb);
        assert_eq!(icc_curve(b"para"), Curve::Srgb);
        assert_eq!(icc_curve(b"curv\0\0\0\0\0\0\0\x01"), Curve::Srgb, "a gamma with no value");
        assert_eq!(icc_curve(b"para\0\0\0\0\0\x00"), Curve::Srgb, "a power law with no exponent");
        assert_eq!(icc_curve(&[]), Curve::Srgb);
    }

    /// Both piecewise curves change arm partway up, and a toe that does not meet its power
    /// section is a visible step in the shadows of every picture read through it.
    ///
    /// The tolerance is not zero because BT.709's own curve is not continuous: its published
    /// constants put the join at 0.018 of light on the linear side and 0.017945 on the power
    /// side, which is a hundredth of an 8-bit code. A typo in either arm is orders of magnitude
    /// larger than that, which is what this is actually watching for.
    #[test]
    fn the_transfers_meet_across_their_own_joins() {
        for (curve, join) in [(Curve::Srgb, 0.040_45), (Curve::Rec709, 0.081)] {
            let below = curve.light(join - 1e-9).raw();
            let above = curve.light(join + 1e-9).raw();
            assert!((below - above).abs() < 1e-4, "{curve:?} steps at its join: {below} vs {above}");
        }
    }

    #[test]
    fn rec2020_converts_to_itself() {
        let matrix = Primaries::REC2020.to_rec2020();
        for (row, cells) in matrix.iter().enumerate() {
            for (column, cell) in cells.iter().enumerate() {
                let want = if row == column { 1.0 } else { 0.0 };
                assert!((cell - want).abs() < 1e-5, "{row},{column} is {cell}");
            }
        }
    }

    #[test]
    fn a_smaller_gamut_keeps_its_white_and_pulls_its_primaries_in() {
        let matrix = Primaries::REC709.to_rec2020();
        // White is white in every space that shares a white point, which is the one row-sum
        // identity a primaries conversion has to satisfy.
        for cells in &matrix {
            let sum: f32 = cells.iter().sum();
            assert!((sum - 1.0).abs() < 1e-5, "white does not survive: {sum}");
        }
        // Rec.709's red is inside Rec.2020's, so it takes green and blue with it.
        assert!(matrix[1][0] > 0.0 && matrix[2][0] > 0.0);
    }

    #[test]
    fn the_table_is_the_depth_and_ends_at_diffuse_white() {
        let eight = Coding::srgb(8).table();
        assert_eq!(eight.len(), 256);
        assert_eq!(eight[0], 0.0);
        assert!((eight[255] - 1.0).abs() < 1e-6);

        let pq = Coding::of(Primaries::REC2020, Curve::Pq, 10);
        let table = pq.table();
        assert_eq!(table.len(), 1024);
        let nits: crate::light::Light<crate::light::SceneNits> = crate::light::Light::exactly(203.0);
        let white = table[(crate::tone::pq(nits).raw() * 1023.0).round() as usize];
        assert!((f64::from(white) - 1.0).abs() < 2e-3, "white landed at {white}");
        assert!(table[1023] > 40.0, "and PQ's own peak is far above it");
    }

    /// A profile's colorants and the same space's chromaticities have to reach the same matrix,
    /// or a Display P3 PNG changes colour depending on which of the two the file happened to
    /// carry.
    #[test]
    fn an_icc_profile_and_a_set_of_chromaticities_agree() {
        let icc = display_p3_profile();
        let read = Coding::from_icc(&icc, 8).expect("a matrix-shaper profile");
        let stated = Primaries::DISPLAY_P3.to_rec2020();
        for (row, cells) in read.matrix.iter().enumerate() {
            for (column, cell) in cells.iter().enumerate() {
                let want = stated[row][column];
                assert!(
                    (cell - want).abs() < 2e-3,
                    "{row},{column}: the profile gives {cell} and the chromaticities {want}",
                );
            }
        }
        assert_eq!(read.curve, Curve::Srgb);
    }

    #[test]
    fn a_profile_with_no_matrix_declines_rather_than_inventing_one() {
        assert!(Coding::from_icc(&[0u8; 132], 8).is_none());
    }

    /// Display P3's colorants as an ICC profile writes them: the primaries taken to XYZ and
    /// Bradford-adapted to D50, which is what `from_icc` has to undo.
    fn display_p3_profile() -> Vec<u8> {
        let adapted = multiply(D65_TO_D50, Primaries::DISPLAY_P3.to_xyz());
        let mut out = vec![0u8; 132];
        out[128..132].copy_from_slice(&4u32.to_be_bytes());
        let mut table = Vec::new();
        let mut body = Vec::new();
        let base = 132 + 4 * 12;
        for (at, name) in [b"rXYZ", b"gXYZ", b"bXYZ"].into_iter().enumerate() {
            table.extend_from_slice(name);
            table.extend_from_slice(&((base + body.len()) as u32).to_be_bytes());
            table.extend_from_slice(&20u32.to_be_bytes());
            body.extend_from_slice(b"XYZ ");
            body.extend_from_slice(&[0; 4]);
            for row in 0..3 {
                let fixed = (adapted[row][at] * 65536.0).round() as i32;
                body.extend_from_slice(&fixed.to_be_bytes());
            }
        }
        table.extend_from_slice(b"rTRC");
        table.extend_from_slice(&((base + body.len()) as u32).to_be_bytes());
        table.extend_from_slice(&32u32.to_be_bytes());
        body.extend_from_slice(b"para");
        body.extend_from_slice(&[0; 4]);
        body.extend_from_slice(&3u16.to_be_bytes());
        body.extend_from_slice(&[0; 22]);

        out.extend_from_slice(&table);
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn a_gain_mapped_sdr_base_is_given_the_headroom_it_is_about_to_use() {
        let sdr = Coding::srgb(8);
        assert_eq!(sdr.white_level(false), 65535.0);
        assert_eq!(sdr.white_level(true), 65535.0 / HDR_HEADROOM);
    }
}
