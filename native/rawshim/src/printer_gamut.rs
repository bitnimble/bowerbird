//! What a printer can lay down on its paper, read from its ICC output profile, and the print's
//! target as `print_scene.slang` reads it.

use moxcms::{ColorProfile, DataColorSpace, Layout, Matrix3d, ProfileClass, RenderingIntent, ToneReprCurve,
    TransformOptions};

pub const TARGET_HUES: usize = 64;
pub const TARGET_LUMAS: usize = 32;
/// Where the edge table starts in [`target`]'s words.
const TARGET_TABLE: usize = 22;
/// How far the eye settles on the paper's own white: 0 sees its measured cast whole, 1 none of it.
pub const PAPER_ADAPTATION: f64 = 0.7;
const BRADFORD: [[f64; 3]; 3] = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];

/// A printer profile's gamut and paper, in linear Rec.2020 as a share of the paper's white.
pub struct PrinterGamut {
    /// The most chroma the ink reaches, by hue and then by luma, as `print_scene.slang` indexes it.
    edge: Vec<f32>,
    black: [f64; 3],
    /// A share of the paper's white to the light it reflects, and back.
    tint: [[f64; 3]; 3],
    untint: [[f64; 3]; 3],
}

impl PrinterGamut {
    pub fn new(icc: &[u8]) -> Result<PrinterGamut, String> {
        PrinterGamut::adapted(icc, PAPER_ADAPTATION)
    }

    /// As [`PrinterGamut::new`], with the eye `adaptation` of the way onto the paper's white.
    pub fn adapted(icc: &[u8], adaptation: f64) -> Result<PrinterGamut, String> {
        let printer = ColorProfile::new_from_slice(icc).map_err(|error| format!("unreadable ICC profile: {error:?}"))?;
        if printer.profile_class != ProfileClass::OutputDevice {
            return Err("not a printer profile: its class is not output".to_owned());
        }
        let (layout, grid) = match printer.color_space {
            DataColorSpace::Rgb => (Layout::Rgb, device_grid(3, 41)),
            DataColorSpace::Cmyk => (Layout::Rgba, device_grid(4, 15)),
            other => return Err(format!("a printer profile over {other:?} is not one this reads")),
        };
        let signal = linear_rec2020();
        let read = printer.create_transform_f32(layout, &signal, Layout::Rgb, TransformOptions {
            rendering_intent: RenderingIntent::RelativeColorimetric,
            ..TransformOptions::default()
        }).map_err(|error| format!("the profile cannot be read: {error:?}"))?;
        let mut laid = vec![0.0; grid.len() / layout.channels() * 3];
        read.transform(&grid, &mut laid).map_err(|error| format!("the profile cannot be read: {error:?}"))?;

        let mut edge = vec![f32::NAN; TARGET_HUES * TARGET_LUMAS];
        let mut black = [1.0f64; 3];
        for colour in laid.chunks_exact(3) {
            let colour = [colour[0], colour[1], colour[2]].map(f64::from);
            let (luma, chroma) = split(colour);
            if luma < split(black).0 { black = colour; }
            let hue = (hue_of(chroma) * TARGET_HUES as f64).round() as usize % TARGET_HUES;
            let level = (luma.clamp(0.0, 1.0) * (TARGET_LUMAS - 1) as f64).round() as usize;
            let size = length(chroma) as f32;
            let node = &mut edge[hue * TARGET_LUMAS + level];
            if node.is_nan() || *node < size { *node = size; }
        }
        let lowest = (split(black).0.clamp(0.0, 1.0) * (TARGET_LUMAS - 1) as f64).ceil() as usize;
        for column in edge.chunks_exact_mut(TARGET_LUMAS) {
            fill(column, lowest);
        }

        let to_xyz = signal.rgb_to_xyz_matrix();
        let from_xyz = to_xyz.inverse();
        let d50 = [0.9642, 1.0, 0.8249];
        let media = printer.media_white_point.map_or(d50, |white| [white.x, white.y, white.z]);
        let bradford = Matrix3d { v: BRADFORD };
        let cone = |xyz: [f64; 3]| bradford.mul_vector(moxcms::Vector3d { v: xyz }).v;
        let (paper, neutral, reference) = (cone(media), cone(d50.map(|c| c * media[1])), cone(d50));
        let seen = [0, 1, 2].map(|c| paper[c] + adaptation * (neutral[c] - paper[c]));
        let scaled = |by: [f64; 3]| from_xyz.mat_mul(bradford.inverse()).mat_mul(diagonal(by)).mat_mul(bradford).mat_mul(to_xyz).v;
        Ok(PrinterGamut {
            edge,
            black,
            tint: scaled([0, 1, 2].map(|c| seen[c] / reference[c])),
            untint: scaled([0, 1, 2].map(|c| reference[c] / seen[c])),
        })
    }
}

/// The print's target as `print_scene.slang` reads it: the printer's, or else sRGB laid between the
/// scene's own paper black and white.
pub(crate) fn target(scene: &crate::print::Scene, printer: Option<&PrinterGamut>) -> Vec<f32> {
    let (table, black, tint, untint) = match printer {
        Some(printer) => (true, printer.black, printer.tint, printer.untint),
        None => {
            let white = scene.white_reflectance.raw();
            let scaled = |by: f64| [[by, 0.0, 0.0], [0.0, by, 0.0], [0.0, 0.0, by]];
            (false, [scene.black_reflectance.raw() / white; 3], scaled(white), scaled(1.0 / white))
        }
    };
    let mut words: Vec<f32> = [if table { 1.0 } else { 0.0 }].into_iter()
        .chain(black)
        .chain(tint.into_iter().flatten())
        .chain(untint.into_iter().flatten())
        .map(|value| value as f32)
        .collect();
    debug_assert_eq!(words.len(), TARGET_TABLE);
    if let Some(printer) = printer { words.extend(&printer.edge); }
    words
}

/// Every node of a grid over a device's `channels` inks, `steps` to a side.
fn device_grid(channels: u32, steps: usize) -> Vec<f32> {
    let count = steps.pow(channels);
    (0..count).flat_map(|index| (0..channels).map(move |channel| {
        (index / steps.pow(channel) % steps) as f32 / (steps - 1) as f32
    })).collect()
}

/// A column's nodes the samples left empty, drawn in between the ones either side; nothing below
/// the ink's darkest and nothing at white.
fn fill(column: &mut [f32], lowest: usize) {
    let last = column.len() - 1;
    for (level, node) in column.iter_mut().enumerate() {
        if level < lowest || level == last { *node = 0.0; }
    }
    let known: Vec<usize> = (0..=last).filter(|&level| !column[level].is_nan()).collect();
    for level in 0..=last {
        if !column[level].is_nan() { continue; }
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
    let luma = colour.iter().zip(crate::hdr_fit::LUMA).map(|(value, weight)| value * weight).sum::<f64>();
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
    Matrix3d { v: [[by[0], 0.0, 0.0], [0.0, by[1], 0.0], [0.0, 0.0, by[2]]] }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A printer reproducing linear Rec.2020 exactly, on a neutral paper reflecting `white`.
    fn ideal_printer(white: f64) -> Vec<u8> {
        ideal_printer_on(moxcms::Xyzd { x: 0.9642 * white, y: white, z: 0.8249 * white })
    }

    fn ideal_printer_on(media: moxcms::Xyzd) -> Vec<u8> {
        let mut profile = linear_rec2020();
        profile.profile_class = ProfileClass::OutputDevice;
        profile.media_white_point = Some(media);
        profile.encode().expect("an encodable profile")
    }

    fn apply(matrix: [[f64; 3]; 3], colour: [f64; 3]) -> [f64; 3] {
        Matrix3d { v: matrix }.mul_vector(moxcms::Vector3d { v: colour }).v
    }

    #[test]
    fn an_ideal_printer_reaches_rec_2020_from_black() {
        let gamut = PrinterGamut::new(&ideal_printer(1.0)).expect("a printer");
        assert!(gamut.black.iter().all(|value| value.abs() < 1e-3), "black: {:?}", gamut.black);
        // Pure green's own node: its chroma is the edge there.
        let green = [0.0, 1.0, 0.0];
        let (luma, chroma) = split(green);
        let at = ((hue_of(chroma) * TARGET_HUES as f64).round() as usize % TARGET_HUES) * TARGET_LUMAS
            + (luma * (TARGET_LUMAS - 1) as f64).round() as usize;
        assert!((f64::from(gamut.edge[at]) - length(chroma)).abs() < 0.05, "{} against {}", gamut.edge[at], length(chroma));
        assert!(gamut.edge.iter().skip(TARGET_LUMAS - 1).step_by(TARGET_LUMAS).all(|&edge| edge == 0.0), "white has no chroma");
    }

    #[test]
    fn the_paper_tints_what_is_laid_on_it() {
        let gamut = PrinterGamut::new(&ideal_printer(0.5)).expect("a printer");
        let white = apply(gamut.tint, [1.0; 3]);
        assert!(white.iter().all(|value| (value - 0.5).abs() < 1e-3), "paper white: {white:?}");
        let back = apply(gamut.untint, white);
        assert!(back.iter().all(|value| (value - 1.0).abs() < 1e-3), "untinted: {back:?}");
    }

    #[test]
    fn a_warm_paper_warms_what_is_laid_on_it_as_far_as_the_eye_keeps_it() {
        let warm = ideal_printer_on(moxcms::Xyzd { x: 0.9642 * 0.9, y: 0.9, z: 0.8249 * 0.8 });
        let cast = |adaptation: f64| {
            let gamut = PrinterGamut::adapted(&warm, adaptation).expect("a printer");
            let white = apply(gamut.tint, [1.0; 3]);
            assert!((split(white).0 - 0.9).abs() < 0.01, "paper luma: {white:?}");
            let back = apply(gamut.untint, white);
            assert!(back.iter().all(|value| (value - 1.0).abs() < 1e-3), "untinted: {back:?}");
            white[0] / white[2]
        };
        let (seen_whole, seen_default, seen_none) = (cast(0.0), cast(PAPER_ADAPTATION), cast(1.0));
        assert!(seen_whole > seen_default && seen_default > 1.0, "{seen_whole} {seen_default}");
        assert!((seen_none - 1.0).abs() < 1e-3, "adapted away: {seen_none}");
    }

    #[test]
    fn generic_paper_is_srgb_between_its_black_and_white() {
        let scene = crate::print::Scene::default();
        let words = target(&scene, None);
        assert_eq!(words.len(), TARGET_TABLE);
        assert_eq!(words[0], 0.0);
        let black = (scene.black_reflectance.raw() / scene.white_reflectance.raw()) as f32;
        assert_eq!(&words[1..4], &[black; 3]);
        assert_eq!(words[4], scene.white_reflectance.raw() as f32);
    }

    #[test]
    fn the_shader_reads_the_table_this_writes() {
        let shader = include_str!("../../../slang/print_scene.slang");
        for (name, value) in [("TARGET_HUES", TARGET_HUES), ("TARGET_LUMAS", TARGET_LUMAS), ("TARGET_TABLE", TARGET_TABLE)] {
            assert!(shader.contains(&format!("static const uint {name} = {value};")), "print_scene.slang's {name}");
        }
    }

    #[test]
    fn a_display_profile_is_refused() {
        let error = PrinterGamut::new(&ColorProfile::new_srgb().encode().expect("sRGB"))
            .err().expect("sRGB is no printer");
        assert!(error.contains("not a printer profile"), "{error}");
    }
}
