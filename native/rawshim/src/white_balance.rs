//! The illuminant a photograph was balanced for, and the vocabulary the reader edits it in.
//!
//! **Only the inverse lives here.** Going from what the camera recorded to a temperature and a
//! tint happens once, natively, at the decode - there is no client twin of it, because the
//! client never sees a camera matrix. Going the other way is the shader's
//! (`white_balance.wgsl`), because both hosts need it on every tick and a second implementation
//! of a colour transform is the divergence DESIGN 21.1 is about. The table below appears in
//! both files and `the_locus_table_matches_the_shader` holds them together.
//!
//! **Camera Raw's numbers, not a scale of our own.** `crs:Temperature` and `crs:Tint` are what
//! a Lightroom sidecar carries and what `EditDocSchema` stores, so a photograph imported from
//! one has to mean here what it meant there. That is why this is Adobe's method - the DNG
//! SDK's `dng_temperature`, which is Robertson's isotherm search over the Planckian locus -
//! rather than one of the closed-form CCT approximations, which agree with it near daylight
//! and drift by hundreds of Kelvin at the ends of the slider.

/// The illuminant, as the reader's two sliders.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsShot {
    /// Correlated colour temperature in Kelvin. Higher is a *bluer* illuminant, which renders
    /// as a warmer picture - the processor divides more blue out of the scene.
    pub temperature: f64,
    /// Distance off the Planckian locus, positive towards magenta, on Adobe's scale.
    pub tint: f64,
}

/// Robertson's 31 isotherms: reciprocal megakelvin, the illuminant's CIE 1960 `u` and `v`,
/// and the slope of the isotherm through it.
///
/// Wyszecki & Stiles by way of the DNG SDK. Transcribed rather than computed because that is
/// what Adobe ships and what a sidecar's numbers were produced against; deriving the locus
/// from Planck's law instead would be a few hundred Kelvin off theirs at the ends.
const LOCUS: [[f64; 4]; 31] = [
    [0.0, 0.18006, 0.26352, -0.24341],
    [10.0, 0.18066, 0.26589, -0.25479],
    [20.0, 0.18133, 0.26846, -0.26876],
    [30.0, 0.18208, 0.27119, -0.28539],
    [40.0, 0.18293, 0.27407, -0.30470],
    [50.0, 0.18388, 0.27709, -0.32675],
    [60.0, 0.18494, 0.28021, -0.35156],
    [70.0, 0.18611, 0.28342, -0.37915],
    [80.0, 0.18740, 0.28668, -0.40955],
    [90.0, 0.18880, 0.28997, -0.44278],
    [100.0, 0.19032, 0.29326, -0.47888],
    [125.0, 0.19462, 0.30141, -0.58204],
    [150.0, 0.19962, 0.30921, -0.70471],
    [175.0, 0.20525, 0.31647, -0.84901],
    [200.0, 0.21142, 0.32312, -1.0182],
    [225.0, 0.21807, 0.32909, -1.2168],
    [250.0, 0.22511, 0.33439, -1.4512],
    [275.0, 0.23247, 0.33904, -1.7298],
    [300.0, 0.24010, 0.34308, -2.0637],
    [325.0, 0.24702, 0.34655, -2.4681],
    [350.0, 0.25591, 0.34951, -2.9641],
    [375.0, 0.26400, 0.35200, -3.5814],
    [400.0, 0.27218, 0.35407, -4.3633],
    [425.0, 0.28039, 0.35577, -5.3762],
    [450.0, 0.28863, 0.35714, -6.7262],
    [475.0, 0.29685, 0.35823, -8.5955],
    [500.0, 0.30505, 0.35907, -11.324],
    [525.0, 0.31320, 0.35968, -15.628],
    [550.0, 0.32129, 0.36011, -23.325],
    [575.0, 0.32931, 0.36038, -40.770],
    [600.0, 0.33724, 0.36051, -116.45],
];

/// Adobe's tint units per unit of `uv` off the locus. Negative, which is what puts positive
/// tint towards magenta.
const TINT_SCALE: f64 = -3000.0;

/// The illuminant the camera balanced for, from what the decoder read out of the file.
///
/// `cam_mul` is what a neutral surface has to be multiplied by to come out grey, so the
/// surface itself sat at its reciprocal - that reciprocal, through the camera's own
/// `cam_xyz`, is the illuminant. None where the file recorded no usable multipliers or the
/// matrix will not invert, in which case there is no baseline and the sliders stay closed.
///
/// One shot rather than the DNG SDK's iteration, because there is nothing here to iterate:
/// that loop exists for a dual-illuminant profile, whose matrix depends on the very
/// temperature being solved for, and the decode picks one matrix.
pub fn as_shot(cam_mul: &[f32; 4], cam_xyz: &[[f32; 3]; 4]) -> Option<AsShot> {
    let (r, g, b) = (f64::from(cam_mul[0]), f64::from(cam_mul[1]), f64::from(cam_mul[2]));
    if !(r > 0.0) || !(g > 0.0) || !(b > 0.0) {
        return None;
    }
    let xyz_to_cam = [
        [f64::from(cam_xyz[0][0]), f64::from(cam_xyz[0][1]), f64::from(cam_xyz[0][2])],
        [f64::from(cam_xyz[1][0]), f64::from(cam_xyz[1][1]), f64::from(cam_xyz[1][2])],
        [f64::from(cam_xyz[2][0]), f64::from(cam_xyz[2][1]), f64::from(cam_xyz[2][2])],
    ];
    let cam_to_xyz = crate::hdr_fit::invert3(&xyz_to_cam)?;
    let neutral = [1.0 / r, 1.0 / g, 1.0 / b];
    let xyz = apply(&cam_to_xyz, neutral);
    let sum = xyz[0] + xyz[1] + xyz[2];
    if !(sum > 0.0) {
        return None;
    }
    Some(from_xy(xyz[0] / sum, xyz[1] / sum))
}

/// A chromaticity as a temperature and a tint: Robertson's search for the isotherm it lies on.
///
/// Walks the locus from the blue end looking for the isotherm the point has crossed to the
/// far side of, interpolates the temperature between that pair, and reads the tint off the
/// remaining distance along the isotherm itself.
pub fn from_xy(x: f64, y: f64) -> AsShot {
    let denominator = 1.5 - x + 6.0 * y;
    // A degenerate chromaticity has no isotherm to sit on. D65 rather than an error, because
    // this is reached from a camera matrix that has already been checked and the caller has
    // nowhere useful to put a second failure.
    if denominator.abs() < 1e-12 {
        return AsShot { temperature: 6500.0, tint: 0.0 };
    }
    let u = 2.0 * x / denominator;
    let v = 3.0 * y / denominator;

    let (mut last_distance, mut last_du, mut last_dv) = (0.0f64, 0.0f64, 0.0f64);
    for index in 1..LOCUS.len() {
        let row = LOCUS[index];
        // The isotherm's direction, normalised. `t` is its slope in `uv`.
        let length = (1.0 + row[3] * row[3]).sqrt();
        let (mut du, mut dv) = (1.0 / length, row[3] / length);
        let (mut uu, mut vv) = (u - row[1], v - row[2]);
        // Which side of this isotherm the point is on. It starts positive at the blue end and
        // goes negative once the walk has passed the point.
        let mut distance = -uu * dv + vv * du;

        if distance <= 0.0 || index == LOCUS.len() - 1 {
            distance = (-distance).max(0.0);
            // Between this isotherm and the one before it, in reciprocal temperature - which
            // is the axis the table is uniform in and the one a temperature slider feels
            // linear on.
            let f = match index {
                1 => 0.0,
                _ => distance / (last_distance + distance),
            };
            let mireds = LOCUS[index - 1][0] * f + row[0] * (1.0 - f);
            uu = u - (LOCUS[index - 1][1] * f + row[1] * (1.0 - f));
            vv = v - (LOCUS[index - 1][2] * f + row[2] * (1.0 - f));
            du = du * (1.0 - f) + last_du * f;
            dv = dv * (1.0 - f) + last_dv * f;
            let length = (du * du + dv * dv).sqrt();
            return AsShot {
                temperature: 1.0e6 / mireds.max(1e-9),
                tint: (uu * du / length + vv * dv / length) * TINT_SCALE,
            };
        }
        last_distance = distance;
        last_du = du;
        last_dv = dv;
    }
    AsShot { temperature: 6500.0, tint: 0.0 }
}

/// Rec.2020 linear to the Bradford cone responses, and back.
///
/// The space the white balance is a *diagonal* in, which is the whole reason it is worth
/// converting into: an illuminant change is three gains there and a full matrix anywhere else.
/// Sharpened cones rather than plain XYZ because that is what makes the diagonal a good
/// approximation at all - von Kries in XYZ shifts saturated colours visibly.
///
/// `white_balance.wgsl` carries both as literals, since it has to stay valid WGSL on its own;
/// these are what `the_cone_matrices_match_the_shader` holds them to.
pub fn rec2020_to_cone() -> [[f64; 3]; 3] {
    crate::hdr_fit::multiply(&BRADFORD, &crate::hdr_fit::REC2020_TO_XYZ)
}

pub fn cone_to_rec2020() -> [[f64; 3]; 3] {
    crate::hdr_fit::invert3(&rec2020_to_cone()).expect("the Bradford transform is invertible")
}

pub fn xyz_to_cone() -> [[f64; 3]; 3] {
    BRADFORD
}

/// The Bradford chromatic adaptation transform, XYZ to sharpened cone responses.
const BRADFORD: [[f64; 3]; 3] = [
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
];

fn apply(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two illuminants everyone knows the answer for.
    ///
    /// This is the transcription check. The table is 124 numbers copied out of a C file, and a
    /// digit wrong in the middle of it would move one stretch of the slider and nothing else -
    /// which is exactly the kind of thing that reaches a photograph rather than a test. D65 and
    /// D50 sit at opposite ends of the range a photographer actually uses, and both are off the
    /// locus by a known amount, so they check the tint arm too.
    #[test]
    fn the_standard_illuminants_land_where_they_are_named() {
        let d65 = from_xy(0.3127, 0.3290);
        assert!(
            (d65.temperature - 6500.0).abs() < 100.0,
            "D65 came out at {:.0}K, tint {:.0}",
            d65.temperature,
            d65.tint,
        );
        // D65 is a daylight illuminant rather than a black body, so it sits a little off the
        // locus. Adobe reads it at about +10; what matters is the sign and the scale.
        assert!(d65.tint.abs() < 25.0, "D65's tint came out at {:.0}", d65.tint);

        let d50 = from_xy(0.34567, 0.35850);
        assert!(
            (d50.temperature - 5000.0).abs() < 100.0,
            "D50 came out at {:.0}K, tint {:.0}",
            d50.temperature,
            d50.tint,
        );
        assert!(d50.tint.abs() < 25.0, "D50's tint came out at {:.0}", d50.tint);
    }

    /// Warmer light reads as a lower number, which is the direction the whole slider hangs on.
    #[test]
    fn a_warmer_illuminant_reads_as_fewer_kelvin() {
        // Tungsten, roughly, against overcast daylight.
        let tungsten = from_xy(0.4476, 0.4074);
        let overcast = from_xy(0.2848, 0.2932);
        assert!(
            tungsten.temperature < 3500.0 && overcast.temperature > 8000.0,
            "tungsten {:.0}K, overcast {:.0}K",
            tungsten.temperature,
            overcast.temperature,
        );
    }

    /// A camera whose matrix is the identity is reporting XYZ, so its multipliers are the
    /// illuminant outright and the answer is checkable by hand.
    #[test]
    fn the_camera_neutral_becomes_the_illuminant_that_produced_it() {
        let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 0.0]];
        // D65 as XYZ at Y=1, then the multipliers that would neutralise it.
        let (x, y) = (0.3127, 0.3290);
        let xyz = [x / y, 1.0, (1.0 - x - y) / y];
        let mul = [(1.0 / xyz[0]) as f32, 1.0, (1.0 / xyz[2]) as f32, 0.0];
        let found = as_shot(&mul, &identity).expect("an invertible matrix");
        assert!(
            (found.temperature - 6500.0).abs() < 100.0,
            "came out at {:.0}K",
            found.temperature,
        );
    }

    /// A file with nothing usable in it declines rather than inventing a baseline.
    #[test]
    fn a_file_with_no_multipliers_has_no_illuminant() {
        let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 0.0]];
        assert!(as_shot(&[0.0, 1.0, 1.0, 0.0], &identity).is_none());
        assert!(as_shot(&[2.0, 1.0, 1.5, 0.0], &[[0.0; 3]; 4]).is_none());
    }

    const WGSL: &str =
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/white_balance.wgsl");

    /// Every number in a stretch of the shader's source, in the order it is written.
    fn literals(from: &str, opener: &str) -> Vec<f64> {
        let start = from.find(opener).unwrap_or_else(|| panic!("{opener} is declared"));
        let body = &from[start..][..from[start..].find(");").expect("it is closed")];
        body.split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == 'e'))
            .filter(|s| s.contains('.'))
            .filter_map(|s| s.parse().ok())
            .collect()
    }

    /// The locus table on both sides, entry for entry.
    ///
    /// It has to be in both - the shader must stay valid WGSL on its own, and the native
    /// inverse cannot wait on a GPU - so what stops them drifting is this. The failure it
    /// guards is silent and narrow: one digit wrong bends one stretch of the slider, and a
    /// photograph balanced there comes out with a colour cast nothing reports.
    #[test]
    fn the_locus_table_matches_the_shader() {
        let found = literals(WGSL, "var<private> LOCUS");
        assert_eq!(found.len(), LOCUS.len() * 4, "parsed {} values", found.len());
        for (row, entry) in LOCUS.iter().enumerate() {
            for (column, want) in entry.iter().enumerate() {
                let got = found[row * 4 + column];
                assert!(
                    (got - want).abs() < 1e-9,
                    "locus row {row} column {column}: the shader has {got} and this has {want}",
                );
            }
        }
    }

    /// And the three cone matrices, which are derived here and written out there.
    ///
    /// Reported as the block to paste, in the pattern `the_srgb_primaries_match_the_host`
    /// uses: the shader's copy is column-major and this side's is rows, so a reader who has to
    /// transpose by hand will eventually transpose it wrong.
    #[test]
    fn the_cone_matrices_match_the_shader() {
        for (name, want) in [
            ("const XYZ_TO_CONE", xyz_to_cone()),
            ("const R2020_TO_CONE", rec2020_to_cone()),
            ("const CONE_TO_R2020", cone_to_rec2020()),
        ] {
            let found = literals(WGSL, name);
            assert_eq!(found.len(), 9, "{name} parsed {found:?}");
            // `mat3x3f` takes columns, so the shader's order is the transpose of this side's.
            let worst = (0..9)
                .map(|i| (found[i] - want[i % 3][i / 3]).abs())
                .fold(0.0f64, f64::max);
            let columns: Vec<String> = (0..3)
                .map(|column| {
                    let values: Vec<String> =
                        (0..3).map(|row| format!("{:>10.6}", want[row][column])).collect();
                    format!("  vec3f({}),", values.join(", "))
                })
                .collect();
            assert!(
                worst < 5e-6,
                "{name} is {worst:.6} out of step with the host's. It should read:\n\
                 {name} = mat3x3f(\n{}\n);",
                columns.join("\n"),
            );
        }
    }

    #[test]
    fn the_cone_transform_round_trips() {
        let forward = rec2020_to_cone();
        let back = cone_to_rec2020();
        let product = crate::hdr_fit::multiply(&back, &forward);
        for (r, row) in product.iter().enumerate() {
            for (c, value) in row.iter().enumerate() {
                let want = if r == c { 1.0 } else { 0.0 };
                assert!((value - want).abs() < 1e-9, "{product:?}");
            }
        }
    }
}
