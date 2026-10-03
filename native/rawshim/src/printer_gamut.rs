//! What a printer can lay down on its paper, read from its ICC output profile, and the print's
//! target as `print_scene.slang` reads it.

use moxcms::{
    ColorProfile, DataColorSpace, Layout, Matrix3d, ProfileClass, RenderingIntent, ToneReprCurve,
    TransformOptions,
};

pub const TARGET_HUES: usize = 64;
pub const TARGET_LUMAS: usize = 32;
/// Where the edge table starts in [`proof`]'s words.
const TARGET_TABLE: usize = 13;
/// `print_target[0]`, as `print_scene.slang` reads it.
const TARGET_SRGB: f32 = 0.0;
const TARGET_ADOBE_RGB: f32 = 1.0;
const TARGET_PROFILE: f32 = 2.0;
/// How far the eye settles on the paper's own white: 0 sees its measured cast whole, 1 none of it.
pub const PAPER_ADAPTATION: f64 = 0.7;
const BRADFORD: [[f64; 3]; 3] = [
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
];

/// What a print is brought inside: a tagged space's cube, or what a printer's profile reaches.
#[derive(Clone, Default)]
pub enum PrintTarget {
    Srgb,
    /// Generic paper, with no printer named: the widest space a printer is commonly sent.
    #[default]
    AdobeRgb,
    Profile(std::sync::Arc<PrinterGamut>),
}

impl PrintTarget {
    pub fn parse(kind: &str, icc: Option<&[u8]>) -> Result<PrintTarget, String> {
        match (kind, icc) {
            ("srgb", _) => Ok(PrintTarget::Srgb),
            ("adobe-rgb", _) => Ok(PrintTarget::AdobeRgb),
            ("profile", Some(icc)) => Ok(PrintTarget::Profile(std::sync::Arc::new(
                PrinterGamut::new(icc)?,
            ))),
            ("profile", None) => Err("a profile target needs its ICC profile".to_owned()),
            (other, _) => Err(format!("no print target is called {other}")),
        }
    }

    fn kind(&self) -> f32 {
        match self {
            PrintTarget::Srgb => TARGET_SRGB,
            PrintTarget::AdobeRgb => TARGET_ADOBE_RGB,
            PrintTarget::Profile(_) => TARGET_PROFILE,
        }
    }

    pub fn profile(&self) -> Option<&PrinterGamut> {
        match self {
            PrintTarget::Profile(printer) => Some(printer),
            _ => None,
        }
    }

    /// The ICC profile a file in this target is tagged with: the space's own, or the printer's
    /// verbatim.
    pub fn icc(&self) -> Result<Vec<u8>, String> {
        let encoded = |profile: ColorProfile| {
            profile
                .encode()
                .map_err(|error| format!("the profile cannot be written: {error:?}"))
        };
        match self {
            PrintTarget::Srgb => encoded(ColorProfile::new_srgb()),
            PrintTarget::AdobeRgb => encoded(ColorProfile::new_adobe_rgb()),
            PrintTarget::Profile(printer) => Ok(printer.icc().to_vec()),
        }
    }
}

/// A printer profile's gamut and paper, in linear Rec.2020 as a share of the paper's white.
pub struct PrinterGamut {
    /// The most chroma the ink reaches, by hue and then by luma, as `print_scene.slang` indexes it.
    edge: Vec<f32>,
    black: [f64; 3],
    /// A share of the paper's white to the light it reflects.
    tint: [[f64; 3]; 3],
    profile: ColorProfile,
    icc: Vec<u8>,
    /// [`PrinterGamut::device_table`], baked on first need: a printer that is only proofed
    /// never asks for it.
    device: std::sync::OnceLock<Result<Vec<f32>, String>>,
}

impl PrinterGamut {
    pub fn new(icc: &[u8]) -> Result<PrinterGamut, String> {
        PrinterGamut::adapted(icc, PAPER_ADAPTATION)
    }

    /// As [`PrinterGamut::new`], with the eye `adaptation` of the way onto the paper's white.
    pub fn adapted(icc: &[u8], adaptation: f64) -> Result<PrinterGamut, String> {
        let printer = ColorProfile::new_from_slice(icc)
            .map_err(|error| format!("unreadable ICC profile: {error:?}"))?;
        if printer.profile_class != ProfileClass::OutputDevice {
            return Err("not a printer profile: its class is not output".to_owned());
        }
        let (layout, grid) = match printer.color_space {
            DataColorSpace::Rgb => (Layout::Rgb, device_grid(3, 41)),
            DataColorSpace::Cmyk => (Layout::Rgba, device_grid(4, 15)),
            other => {
                return Err(format!(
                    "a printer profile over {other:?} is not one this reads"
                ));
            }
        };
        let signal = linear_rec2020();
        let read = printer
            .create_transform_f32(
                layout,
                &signal,
                Layout::Rgb,
                TransformOptions {
                    rendering_intent: RenderingIntent::RelativeColorimetric,
                    ..TransformOptions::default()
                },
            )
            .map_err(|error| format!("the profile cannot be read: {error:?}"))?;
        let mut laid = vec![0.0; grid.len() / layout.channels() * 3];
        read.transform(&grid, &mut laid)
            .map_err(|error| format!("the profile cannot be read: {error:?}"))?;

        let mut edge = vec![f32::NAN; TARGET_HUES * TARGET_LUMAS];
        let mut black = [1.0f64; 3];
        for colour in laid.chunks_exact(3) {
            let colour = [colour[0], colour[1], colour[2]].map(f64::from);
            let (luma, chroma) = split(colour);
            if luma < split(black).0 {
                black = colour;
            }
            let hue = (hue_of(chroma) * TARGET_HUES as f64).round() as usize % TARGET_HUES;
            let level = (luma.clamp(0.0, 1.0) * (TARGET_LUMAS - 1) as f64).round() as usize;
            let size = length(chroma) as f32;
            let node = &mut edge[hue * TARGET_LUMAS + level];
            if node.is_nan() || *node < size {
                *node = size;
            }
        }
        let lowest = (split(black).0.clamp(0.0, 1.0) * (TARGET_LUMAS - 1) as f64).ceil() as usize;
        for column in edge.chunks_exact_mut(TARGET_LUMAS) {
            fill(column, lowest);
        }

        let to_xyz = signal.rgb_to_xyz_matrix();
        let from_xyz = to_xyz.inverse();
        let d50 = [0.9642, 1.0, 0.8249];
        let media = printer
            .media_white_point
            .map_or(d50, |white| [white.x, white.y, white.z]);
        let bradford = Matrix3d { v: BRADFORD };
        let cone = |xyz: [f64; 3]| bradford.mul_vector(moxcms::Vector3d { v: xyz }).v;
        let (paper, neutral, reference) = (cone(media), cone(d50.map(|c| c * media[1])), cone(d50));
        let seen = [0, 1, 2].map(|c| paper[c] + adaptation * (neutral[c] - paper[c]));
        let tint = from_xyz
            .mat_mul(bradford.inverse())
            .mat_mul(diagonal([0, 1, 2].map(|c| seen[c] / reference[c])))
            .mat_mul(bradford)
            .mat_mul(to_xyz)
            .v;
        Ok(PrinterGamut {
            edge,
            black,
            tint,
            profile: printer,
            icc: icc.to_vec(),
            device: std::sync::OnceLock::new(),
        })
    }

    /// The ICC profile this was read from, byte for byte.
    pub fn icc(&self) -> &[u8] {
        &self.icc
    }

    /// The printer's device RGB for every node of a `LUT_STEPS` grid over linear Rec.2020, as
    /// `print_output.slang` samples it: four words a node, red fastest, each axis coded by
    /// `LUT_GAMMA` so the shadows get as many nodes as the lights. Relative colorimetric, the
    /// gamut having been reached by `gamut_map.slang` already.
    ///
    /// Only an RGB printer has one: what a print file carries is the three channels a driver
    /// takes uncorrected, and an ink set's own channels are the driver's to lay.
    pub fn device_table(&self) -> Result<&[f32], String> {
        self.device
            .get_or_init(|| self.bake_device_table())
            .as_deref()
            .map_err(Clone::clone)
    }

    fn bake_device_table(&self) -> Result<Vec<f32>, String> {
        if self.profile.color_space != DataColorSpace::Rgb {
            return Err(format!(
                "a print file carries RGB, and this printer profile is over {:?}",
                self.profile.color_space
            ));
        }
        let signal = linear_rec2020();
        let lay = signal
            .create_transform_f32(
                Layout::Rgb,
                &self.profile,
                Layout::Rgb,
                TransformOptions {
                    rendering_intent: RenderingIntent::RelativeColorimetric,
                    ..TransformOptions::default()
                },
            )
            .map_err(|error| format!("the profile cannot be written to: {error:?}"))?;
        let nodes: Vec<f32> = device_grid(3, LUT_STEPS)
            .into_iter()
            .map(|coded| coded.powf(LUT_GAMMA))
            .collect();
        let mut device = vec![0.0; nodes.len()];
        lay.transform(&nodes, &mut device)
            .map_err(|error| format!("the profile cannot be written to: {error:?}"))?;
        Ok(device
            .chunks_exact(3)
            .flat_map(|rgb| [rgb[0], rgb[1], rgb[2], 1.0])
            .collect())
    }
}

/// `print_output.slang`'s grid: nodes to a side, and the power each axis is coded by.
pub const LUT_STEPS: usize = 65;
pub const LUT_GAMMA: f32 = 2.4;

/// The print's target as `print_scene.slang` proofs it: a profile's own paper, or else the tagged
/// space laid between the scene's paper black and white.
pub(crate) fn proof(scene: &crate::print::Scene, target: &PrintTarget) -> Vec<f32> {
    match target.profile() {
        Some(printer) => words(target, printer.black, printer.tint, Some(&printer.edge)),
        None => {
            let white = scene.white_reflectance.raw();
            words(
                target,
                [scene.black_reflectance.raw() / white; 3],
                [[white, 0.0, 0.0], [0.0, white, 0.0], [0.0, 0.0, white]],
                None,
            )
        }
    }
}

/// The same target as a print file is written into: a tagged space's black is the printer's to
/// lay, so it sits at zero, where a profile's is its paper's.
pub(crate) fn output(target: &PrintTarget) -> Vec<f32> {
    let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    match target.profile() {
        Some(printer) => words(target, printer.black, identity, Some(&printer.edge)),
        None => words(target, [0.0; 3], identity, None),
    }
}

fn words(
    target: &PrintTarget,
    black: [f64; 3],
    tint: [[f64; 3]; 3],
    edge: Option<&[f32]>,
) -> Vec<f32> {
    let mut words: Vec<f32> = [f64::from(target.kind())]
        .into_iter()
        .chain(black)
        .chain(tint.into_iter().flatten())
        .map(|value| value as f32)
        .collect();
    debug_assert_eq!(words.len(), TARGET_TABLE);
    words.extend(edge.unwrap_or_default());
    words
}

/// Every node of a grid over a device's `channels` inks, `steps` to a side.
fn device_grid(channels: u32, steps: usize) -> Vec<f32> {
    let count = steps.pow(channels);
    (0..count)
        .flat_map(|index| {
            (0..channels).map(move |channel| {
                (index / steps.pow(channel) % steps) as f32 / (steps - 1) as f32
            })
        })
        .collect()
}

/// A column's nodes the samples left empty, drawn in between the ones either side; nothing below
/// the ink's darkest and nothing at white.
fn fill(column: &mut [f32], lowest: usize) {
    let last = column.len() - 1;
    for (level, node) in column.iter_mut().enumerate() {
        if level < lowest || level == last {
            *node = 0.0;
        }
    }
    let known: Vec<usize> = (0..=last)
        .filter(|&level| !column[level].is_nan())
        .collect();
    for level in 0..=last {
        if !column[level].is_nan() {
            continue;
        }
        let below = known.iter().rev().find(|&&at| at < level);
        let above = known.iter().find(|&&at| at > level);
        column[level] = match (below, above) {
            (Some(&low), Some(&high)) => {
                let t = (level - low) as f32 / (high - low) as f32;
                column[low] + (column[high] - column[low]) * t
            }
            _ => 0.0,
        };
    }
}

fn split(colour: [f64; 3]) -> (f64, [f64; 3]) {
    let luma = colour
        .iter()
        .zip(crate::hdr_fit::LUMA)
        .map(|(value, weight)| value * weight)
        .sum::<f64>();
    (luma, colour.map(|value| value - luma))
}

/// Where `chroma` points, as a share of the way round from the hue `print_scene.slang` starts at.
fn hue_of(chroma: [f64; 3]) -> f64 {
    let angle = (0.5 * (chroma[0] + chroma[1]) - chroma[2]).atan2(chroma[0] - chroma[1]);
    angle / std::f64::consts::TAU + 0.5
}

fn length(chroma: [f64; 3]) -> f64 {
    chroma.iter().map(|value| value * value).sum::<f64>().sqrt()
}

/// Rec.2020 with a linear transfer, which is what the print's signal is.
fn linear_rec2020() -> ColorProfile {
    let mut profile = ColorProfile::new_bt2020();
    let linear = ToneReprCurve::Lut(Vec::new());
    profile.red_trc = Some(linear.clone());
    profile.green_trc = Some(linear.clone());
    profile.blue_trc = Some(linear);
    profile
}

fn diagonal(by: [f64; 3]) -> Matrix3d {
    Matrix3d {
        v: [[by[0], 0.0, 0.0], [0.0, by[1], 0.0], [0.0, 0.0, by[2]]],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A printer reproducing linear Rec.2020 exactly, on a neutral paper reflecting `white`.
    fn ideal_printer(white: f64) -> Vec<u8> {
        ideal_printer_on(moxcms::Xyzd {
            x: 0.9642 * white,
            y: white,
            z: 0.8249 * white,
        })
    }

    fn ideal_printer_on(media: moxcms::Xyzd) -> Vec<u8> {
        let mut profile = linear_rec2020();
        profile.profile_class = ProfileClass::OutputDevice;
        profile.media_white_point = Some(media);
        profile.encode().expect("an encodable profile")
    }

    fn apply(matrix: [[f64; 3]; 3], colour: [f64; 3]) -> [f64; 3] {
        Matrix3d { v: matrix }
            .mul_vector(moxcms::Vector3d { v: colour })
            .v
    }

    #[test]
    fn an_ideal_printer_reaches_rec_2020_from_black() {
        let gamut = PrinterGamut::new(&ideal_printer(1.0)).expect("a printer");
        assert!(
            gamut.black.iter().all(|value| value.abs() < 1e-3),
            "black: {:?}",
            gamut.black
        );
        // Pure green's own node: its chroma is the edge there.
        let green = [0.0, 1.0, 0.0];
        let (luma, chroma) = split(green);
        let at = ((hue_of(chroma) * TARGET_HUES as f64).round() as usize % TARGET_HUES)
            * TARGET_LUMAS
            + (luma * (TARGET_LUMAS - 1) as f64).round() as usize;
        assert!(
            (f64::from(gamut.edge[at]) - length(chroma)).abs() < 0.05,
            "{} against {}",
            gamut.edge[at],
            length(chroma)
        );
        assert!(
            gamut
                .edge
                .iter()
                .skip(TARGET_LUMAS - 1)
                .step_by(TARGET_LUMAS)
                .all(|&edge| edge == 0.0),
            "white has no chroma"
        );
    }

    #[test]
    fn the_paper_tints_what_is_laid_on_it() {
        let gamut = PrinterGamut::new(&ideal_printer(0.5)).expect("a printer");
        let white = apply(gamut.tint, [1.0; 3]);
        assert!(
            white.iter().all(|value| (value - 0.5).abs() < 1e-3),
            "paper white: {white:?}"
        );
    }

    #[test]
    fn a_warm_paper_warms_what_is_laid_on_it_as_far_as_the_eye_keeps_it() {
        let warm = ideal_printer_on(moxcms::Xyzd {
            x: 0.9642 * 0.9,
            y: 0.9,
            z: 0.8249 * 0.8,
        });
        let cast = |adaptation: f64| {
            let gamut = PrinterGamut::adapted(&warm, adaptation).expect("a printer");
            let white = apply(gamut.tint, [1.0; 3]);
            assert!((split(white).0 - 0.9).abs() < 0.01, "paper luma: {white:?}");
            white[0] / white[2]
        };
        let (seen_whole, seen_default, seen_none) = (cast(0.0), cast(PAPER_ADAPTATION), cast(1.0));
        assert!(
            seen_whole > seen_default && seen_default > 1.0,
            "{seen_whole} {seen_default}"
        );
        assert!((seen_none - 1.0).abs() < 1e-3, "adapted away: {seen_none}");
    }

    #[test]
    fn generic_paper_is_adobe_rgb_between_its_black_and_white() {
        let scene = crate::print::Scene::default();
        let words = proof(&scene, &PrintTarget::default());
        assert_eq!(words.len(), TARGET_TABLE);
        assert_eq!(words[0], TARGET_ADOBE_RGB);
        let black = (scene.black_reflectance.raw() / scene.white_reflectance.raw()) as f32;
        assert_eq!(&words[1..4], &[black; 3]);
        assert_eq!(words[4], scene.white_reflectance.raw() as f32);
    }

    #[test]
    fn each_kind_names_itself_and_a_profile_brings_its_table() {
        let scene = crate::print::Scene::default();
        assert_eq!(proof(&scene, &PrintTarget::Srgb)[0], TARGET_SRGB);
        let printer = PrintTarget::parse("profile", Some(&ideal_printer(0.5))).expect("a printer");
        let words = proof(&scene, &printer);
        assert_eq!(words[0], TARGET_PROFILE);
        assert_eq!(words.len(), TARGET_TABLE + TARGET_HUES * TARGET_LUMAS);
        assert!(PrintTarget::parse("profile", None).is_err());
        assert!(PrintTarget::parse("cmyk", None).is_err());
    }

    #[test]
    fn a_print_file_in_a_tagged_space_starts_at_black() {
        let words = output(&PrintTarget::AdobeRgb);
        assert_eq!(words.len(), TARGET_TABLE);
        assert_eq!(&words[1..4], &[0.0; 3]);
        assert_eq!(
            &words[4..13],
            &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
        );
        let printer = PrintTarget::parse("profile", Some(&ideal_printer(0.5))).expect("a printer");
        let words = output(&printer);
        assert_eq!(words[0], TARGET_PROFILE);
        assert_eq!(words.len(), TARGET_TABLE + TARGET_HUES * TARGET_LUMAS);
    }

    /// Trilinear on the host, as the sampler reads it, against moxcms laying the colour itself.
    #[test]
    fn the_device_table_lays_what_the_profile_does() {
        let printer = PrinterGamut::new(&ideal_printer(0.9)).expect("a printer");
        let table = printer.device_table().expect("an RGB printer has a table");
        assert_eq!(table.len(), LUT_STEPS.pow(3) * 4);
        let lay = linear_rec2020()
            .create_transform_f32(
                Layout::Rgb,
                &printer.profile,
                Layout::Rgb,
                TransformOptions {
                    rendering_intent: RenderingIntent::RelativeColorimetric,
                    ..TransformOptions::default()
                },
            )
            .expect("the profile writes");
        let mut worst = 0.0f32;
        for colour in [
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0],
            [0.18, 0.18, 0.18],
            [0.002, 0.004, 0.003],
            [0.7, 0.1, 0.05],
            [0.05, 0.6, 0.55],
            [0.31, 0.27, 0.9],
            [0.999, 0.5, 0.013],
        ] {
            let mut expected = [0.0f32; 3];
            lay.transform(&colour, &mut expected).expect("laid");
            let sampled = sample_device_table(table, colour);
            for channel in 0..3 {
                worst = worst.max((sampled[channel] - expected[channel]).abs());
            }
        }
        assert!(
            worst * 255.0 < 0.5,
            "the table is {worst} from the profile's own answer"
        );
    }

    /// `print_output.slang`'s read of the table, in `f32`.
    fn sample_device_table(table: &[f32], colour: [f32; 3]) -> [f32; 3] {
        let node = colour
            .map(|value| value.clamp(0.0, 1.0).powf(1.0 / LUT_GAMMA) * (LUT_STEPS - 1) as f32);
        let low = node.map(|at| (at.floor() as usize).min(LUT_STEPS - 2));
        let t = [0, 1, 2].map(|axis| node[axis] - low[axis] as f32);
        let mut out = [0.0; 3];
        for corner in 0..8 {
            let mut weight = 1.0;
            let mut index = 0;
            for axis in 0..3 {
                let up = (corner >> axis) & 1;
                weight *= if up == 1 { t[axis] } else { 1.0 - t[axis] };
                index += (low[axis] + up) * LUT_STEPS.pow(axis as u32);
            }
            for channel in 0..3 {
                out[channel] += weight * table[index * 4 + channel];
            }
        }
        out
    }

    #[test]
    fn the_shader_reads_the_table_this_writes() {
        let output = include_str!("../../../slang/print_output.slang");
        assert!(output.contains(&format!("static const uint LUT_STEPS = {LUT_STEPS};")));
        assert!(output.contains(&format!("static const float LUT_GAMMA = {LUT_GAMMA:.1};")));
        let shader = include_str!("../../../slang/print_scene.slang");
        for (name, value) in [
            ("TARGET_HUES", TARGET_HUES),
            ("TARGET_LUMAS", TARGET_LUMAS),
            ("TARGET_TABLE", TARGET_TABLE),
            ("TARGET_SRGB", TARGET_SRGB as usize),
            ("TARGET_ADOBE_RGB", TARGET_ADOBE_RGB as usize),
            ("TARGET_PROFILE", TARGET_PROFILE as usize),
        ] {
            assert!(
                shader.contains(&format!("static const uint {name} = {value};")),
                "print_scene.slang's {name}"
            );
        }
    }

    #[test]
    fn a_display_profile_is_refused() {
        let error = PrinterGamut::new(&ColorProfile::new_srgb().encode().expect("sRGB"))
            .err()
            .expect("sRGB is no printer");
        assert!(error.contains("not a printer profile"), "{error}");
    }
}
