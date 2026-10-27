//! Colour spaces: the primaries conversions, the sRGB transfer, and the 3x3 arithmetic over them.

/// Rec.2020 luma, for the chroma blend and the sample weighting.
pub const LUMA: [f64; 3] = [0.2627, 0.678, 0.0593];

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
