//! Colour spaces: the primaries conversions, the sRGB transfer, and the 3x3 arithmetic over them.

/// Rec.2020 luma, for the chroma blend and the sample weighting.
pub const LUMA: [f64; 3] = [0.2627, 0.678, 0.0593];

/// BT.709's luma weights, used on a Rec.2020 frame too: `prelude.slang`'s `LUMA709`.
///
/// They decide how much of an edge each channel is credited with and which part of a
/// pixel counts as its colour, not what colour anything is; the two sets differ by less
/// than either knob does.
///
/// **The one copy.** The geometry fit, the falloff fit and the stacking descriptor all
/// carried their own, which is three chances for them to drift apart and no way to tell
/// that they had. Not to be confused with the Y row of [`SRGB_TO_XYZ`], which is the same
/// three numbers meaning something else and stays with its matrix.
pub const LUMA709: [f32; 3] = [0.2126, 0.7152, 0.0722];

/// BT.709 luma of a triple, in whatever domain and scale the caller's values are.
///
/// `f64` because every caller works there. `edge_spread.slang` computes the same weighted sum
/// on the device, and sums before it divides for the same reason this does.
pub fn luma709(r: f64, g: f64, b: f64) -> f64 {
    f64::from(LUMA709[0]) * r + f64::from(LUMA709[1]) * g + f64::from(LUMA709[2]) * b
}

pub const SRGB_TO_XYZ: [[f64; 3]; 3] = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.072175],
    [0.0193339, 0.119192, 0.9503041],
];
pub const XYZ_TO_REC2020: [[f64; 3]; 3] = [
    [1.7166512, -0.3556708, -0.2533663],
    [-0.6666844, 1.6164812, 0.0157685],
    [0.0176399, -0.0427706, 0.9421031],
];
pub const REC2020_TO_XYZ: [[f64; 3]; 3] = [
    [0.636958, 0.1446169, 0.168881],
    [0.2627002, 0.6779981, 0.0593017],
    [0.0, 0.0280727, 1.0609851],
];
pub const XYZ_TO_SRGB: [[f64; 3]; 3] = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.969266, 1.8760108, 0.041556],
    [0.0556434, -0.2040259, 1.0572252],
];

pub const IDENTITY: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

pub fn multiply(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

/// A 3x3 over one colour, for the fixtures and the pins that check a matrix by hand. The stages
/// that apply one to a picture do it in the shader that produced the picture.
pub fn apply3(m: &[[f64; 3]; 3], r: f64, g: f64, b: f64) -> [f64; 3] {
    [
        m[0][0] * r + m[0][1] * g + m[0][2] * b,
        m[1][0] * r + m[1][1] * g + m[1][2] * b,
        m[2][0] * r + m[2][1] * g + m[2][2] * b,
    ]
}

/// The sRGB transfer's inverse, for a value already in 0..1.
pub fn srgb_eotf_f(coded: f64) -> f64 {
    let c = coded.clamp(0.0, 1.0);
    match c <= 0.04045 {
        true => c / 12.92,
        false => ((c + 0.055) / 1.055).powf(2.4),
    }
}

/// The sRGB transfer's inverse, for a JPEG's 8-bit level: the camera's own encoding, undone.
pub fn srgb_eotf(level: u8) -> f64 {
    let c = f64::from(level) / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Gauss-Jordan on a 3x3, returning None rather than garbage when singular.
pub fn solve_row(matrix: &[[f64; 3]; 3], rhs: &[f64; 3]) -> Option<[f64; 3]> {
    let mut m = [[0.0f64; 4]; 3];
    for i in 0..3 {
        m[i][..3].copy_from_slice(&matrix[i]);
        m[i][3] = rhs[i];
    }
    for col in 0..3 {
        let mut pivot = col;
        for row in col + 1..3 {
            if m[row][col].abs() > m[pivot][col].abs() {
                pivot = row;
            }
        }
        m.swap(col, pivot);
        if m[col][col].abs() < 1e-12 {
            return None;
        }
        for row in 0..3 {
            if row == col {
                continue;
            }
            let factor = m[row][col] / m[col][col];
            for k in col..4 {
                m[row][k] -= factor * m[col][k];
            }
        }
    }
    Some([m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]])
}

/// Rec.2020 linear to sRGB linear - the primaries conversion, and nothing else.
///
/// A fixed 3x3, because the two share a white point and so there is no chromatic
/// adaptation in it. This is what `zscale`'s `pin=bt2020 ... p=bt709` was doing for the
/// SDR still (sRGB and BT.709 have the same primaries and differ only in transfer), and
/// it is here rather than there so the still's encode can stay in this process.
///
/// Returned rather than applied, so a caller converting a whole frame builds it once.
pub fn rec2020_to_srgb() -> [[f64; 3]; 3] {
    multiply(&XYZ_TO_SRGB, &REC2020_TO_XYZ)
}

pub fn srgb_to_rec2020() -> [[f64; 3]; 3] {
    multiply(&XYZ_TO_REC2020, &SRGB_TO_XYZ)
}

/// One matrix out of `slang/primaries.slang`, in the order `float3x3` takes rows.
///
/// The shader carries every conversion as a literal and a literal is a copy, so each is held
/// against what this crate derives - `the_primaries_match_the_host` and
/// `the_cone_matrices_are_what_they_are_derived_from`, which sit in different modules and read
/// the one file through this.
pub fn in_the_shader(name: &str) -> [[f64; 3]; 3] {
    let source = include_str!("../../../slang/primaries.slang");
    let start = source
        .find(&format!("{name} = float3x3"))
        .expect("the constant is there");
    let body = &source[start..source[start..].find(");").expect("it is closed") + start];
    let found: Vec<f64> = body
        .split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
        .filter(|s| s.contains('.'))
        .filter_map(|s| s.parse().ok())
        .collect();
    assert_eq!(found.len(), 9, "parsed {found:?} out of {body}");
    [
        [found[0], found[1], found[2]],
        [found[3], found[4], found[5]],
        [found[6], found[7], found[8]],
    ]
}

/// The sRGB transfer, IEC 61966-2-1. Out-of-gamut values clamp, which is what zimg does
/// with them too - neither of us is gamut-mapping, just refusing to encode a negative.
pub fn srgb_oetf(value: f64) -> f64 {
    let c = value.clamp(0.0, 1.0);
    if c <= 0.0031308 {
        12.92 * c
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// `prelude.slang`'s `GAMUT_FLOOR`, held against the shader by
/// `the_gamut_floor_is_the_one_the_shader_declares`: where the grade holds a colour's lowest
/// channel, as a fraction of its luma.
pub const GAMUT_FLOOR: f64 = 0.02;

/// `prelude.slang`'s `in_gamut` on the host, for the tests that hold a pass to it: the lowest
/// channel eased into [`GAMUT_FLOOR`] of the luma through a knee at twice that, the luma kept.
pub fn in_gamut(v: [f64; 3]) -> [f64; 3] {
    // The positive part's luma, as the shader takes it: a negative channel is why this is reached
    // and green's weight is the largest of the three, so the triple's own luma subtracts the
    // out-of-gamut channel from the in-gamut ones. `prelude.slang` carries the measurement.
    let luma: f64 = (0..3).map(|c| LUMA[c] * v[c].max(0.0)).sum();
    if luma <= 0.0 {
        return [0.0; 3];
    }
    let x = v.iter().copied().fold(f64::INFINITY, f64::min) / luma;
    if x >= 2.0 * GAMUT_FLOOR {
        return v;
    }
    let held = GAMUT_FLOOR * (1.0 + ((x - 2.0 * GAMUT_FLOOR) / GAMUT_FLOOR).exp());
    let scale = (1.0 - held) / (1.0 - x);
    let pulled: [f64; 3] = std::array::from_fn(|c| luma + (v[c] - luma) * scale);
    // The mix keeps the triple's weighted mean, not the positive part's, so the target is restored
    // by a uniform scale - a brightness rather than a hue, and one the floor is invariant under.
    let achieved: f64 = (0..3).map(|c| LUMA[c] * pulled[c]).sum();
    pulled.map(|v| v * luma / achieved.max(1e-12))
}

/// A 3x3 inverse, by solving the matrix against each basis vector. None when singular.
pub fn invert3(m: &[[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let columns: [[f64; 3]; 3] = [
        solve_row(m, &[1.0, 0.0, 0.0])?,
        solve_row(m, &[0.0, 1.0, 0.0])?,
        solve_row(m, &[0.0, 0.0, 1.0])?,
    ];
    Some(std::array::from_fn(|r| {
        std::array::from_fn(|c| columns[c][r])
    }))
}

#[cfg(test)]
mod tests {
    use super::{GAMUT_FLOOR, LUMA, in_gamut};

    /// The floor is stated twice, and a host copy that drifted would have two tests holding two
    /// passes to two different knees.
    #[test]
    fn the_gamut_floor_is_the_one_the_shader_declares() {
        const SOURCE: &str = include_str!("../../../slang/prelude.slang");
        let line = format!("public static const float GAMUT_FLOOR = {GAMUT_FLOOR};");
        assert!(
            SOURCE.contains(&line),
            "prelude.slang does not say `{line}`"
        );
    }

    /// The knee is the identity inside it, continuous and C1 at it, and holds the floor past it.
    ///
    /// **The luma it keeps is the positive part's**, which is the whole of what a negative channel
    /// changes here. Held against the triple's own, a colour far outside the gamut is pulled towards
    /// a grey its out-of-gamut channel darkened - green's weight being the largest of the three -
    /// and the further out it is the darker that grey. The pane in `prelude.slang`'s measurement
    /// lost five and a half times its brightness that way, and the ratio the correction's strength
    /// divides by carried the photosites' noise with it.
    #[test]
    fn the_knee_holds_the_floor_without_a_step() {
        let luma = |v: [f64; 3]| -> f64 { (0..3).map(|c| LUMA[c] * v[c].max(0.0)).sum() };
        let inside = [0.5, 0.1, 0.05];
        assert_eq!(
            in_gamut(inside),
            inside,
            "a colour inside the knee is untouched"
        );
        let mut last = in_gamut([0.5, 0.1, 0.06])[2];
        for step in 1..=200 {
            let v = [0.5, 0.1, 0.06 - 0.001 * f64::from(step)];
            let held = in_gamut(v);
            assert!(
                (luma(held) - luma(v)).abs() < 1e-9,
                "the luma moved at {v:?}"
            );
            let lowest = held.iter().copied().fold(f64::INFINITY, f64::min);
            assert!(
                lowest >= GAMUT_FLOOR * luma(v) - 1e-9,
                "under the floor at {v:?}: {held:?}"
            );
            // Falls to the floor and then sits on it, rather than falling forever. The floor is a
            // fraction of the colour's own luma and that luma is now held, so a colour pushed
            // further out keeps the channel where it is instead of carrying it down - which is the
            // whole of what was wrong. What must not happen is a *step*, in either direction.
            //
            // It does creep up on the way, by 8.4e-7 over the whole sweep, because the rescale that
            // restores the luma grows as the colour goes further out while the floor it multiplies
            // is already flat. Measured rather than allowed for: the bound is ten times it.
            assert!(
                held[2] - last < 1e-5 && last - held[2] < 0.002,
                "a step at {v:?}"
            );
            last = held[2];
        }
    }

    /// What the positive part buys, stated as the property the picture actually needed.
    ///
    /// **A colour's brightness must not fall as it is pushed further outside the gamut.** The rule
    /// gives up saturation, which is its whole purpose; giving up brightness as well is what put a
    /// stained glass pane at a twentieth of diffuse white where the body that shot it rendered it
    /// near white. Swept over a blue leaving the hull, the held colour's own positive luma is flat
    /// where the triple's falls away.
    #[test]
    fn a_colour_further_outside_the_gamut_does_not_come_back_darker() {
        let bright = |v: [f64; 3]| -> f64 { (0..3).map(|c| LUMA[c] * v[c].max(0.0)).sum() };
        let mut least = f64::INFINITY;
        let mut most: f64 = 0.0;
        for step in 0..=200 {
            // Green driven further negative, which is what a camera matrix does to a narrow blue.
            let v = [0.02, -0.002 * f64::from(step), 0.9];
            let held = bright(in_gamut(v));
            least = least.min(held);
            most = most.max(held);
        }
        assert!(
            most / least < 1.02,
            "the held brightness ran from {least} to {most} as the colour left the gamut",
        );
    }

    #[test]
    fn solve_row_reports_a_singular_system() {
        let singular = [[1.0, 2.0, 3.0], [2.0, 4.0, 6.0], [3.0, 6.0, 9.0]];
        assert!(super::solve_row(&singular, &[1.0, 2.0, 3.0]).is_none());
    }

    /// The gamut rotations in `primaries.slang` against the matrices this crate derives.
    ///
    /// This is the pattern the rest of the shared numbers use: written out there, pinned here, so
    /// the two cannot drift without a test saying so.
    ///
    /// `R2020_TO_P3` is the one both hosts read - the editor's draw and the viewer's stage - which
    /// is exactly why a wrong digit in it would agree with itself everywhere and show up nowhere.
    #[test]
    fn the_primaries_match_the_host() {
        pinned("R2020_TO_SRGB", super::rec2020_to_srgb());
        pinned("SRGB_TO_R2020", super::srgb_to_rec2020());
        pinned(
            "R2020_TO_P3",
            crate::transfer::Primaries::DISPLAY_P3.from_rec2020(),
        );
        pinned(
            "P3_TO_R2020",
            crate::transfer::Primaries::DISPLAY_P3
                .to_rec2020()
                .map(|row| row.map(f64::from)),
        );
    }

    fn pinned(name: &str, want: [[f64; 3]; 3]) {
        let found = super::in_the_shader(name);
        let rows: Vec<String> = (0..3)
            .map(|row| {
                let v: Vec<String> = (0..3)
                    .map(|col| format!("{:>10.6}", want[row][col]))
                    .collect();
                format!("    {},", v.join(", "))
            })
            .collect();
        let worst = (0..9)
            .map(|i| (found[i / 3][i % 3] - want[i / 3][i % 3]).abs())
            .fold(0.0f64, f64::max);
        assert!(
            worst < 5e-6,
            "{name} is {worst:.6} out of step with the host's. It should read:\n\
             public static const float3x3 {name} = float3x3(\n{}\n);",
            rows.join("\n").trim_end_matches(','),
        );
    }
}
