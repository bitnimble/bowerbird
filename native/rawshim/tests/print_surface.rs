use rawshim::gpu::{Adjust, Canvas, Grade, Output};
use rawshim::image::Geometry;
use rawshim::light::{Gain, Light, SceneNits, Stops};
use rawshim::print::{Presentation, Scene};
use rawshim::px::{Size, Span};

#[test]
fn surface_fills_the_photo_and_pose_does_not_move_its_pixels() {
    let colors = [[0.8, 0.04, 0.04], [0.04, 0.8, 0.04], [0.04, 0.04, 0.8], [0.8; 3]].map(coded);
    let frame: Vec<_> = (0..64 * 64).flat_map(|at| colors[usize::from(at % 64 >= 32) + 2 * usize::from(at / 64 >= 32)]).collect();
    let grade = grade();
    let scene = diffuse();
    let reference = draw(&frame, &grade, Some(&scene));
    for (at, channel) in [([0, 0], 0), ([63, 0], 1), ([0, 63], 2)] {
        let offset = (at[1] * 64 + at[0]) * 4;
        assert!(reference[offset + channel] > 0.7, "photo corner became background: {at:?}");
        assert!(reference[offset + channel] > reference[offset + (channel + 1) % 3] * 1.5,
            "photo corner lost its source color: {at:?}");
    }
    // Held as colour rather than as brightness: the sheet is bowed, so turning it turns its curve
    // through the room and the light on it moves - which is the point of tilting a phone. What may
    // not move is the photograph, and a pixel that had shifted would take its neighbour's colour.
    for (yaw, pitch) in [(35.0, 20.0), (-45.0, -30.0), (75.0, 10.0)] {
        let pose = Scene { yaw_degrees: yaw, pitch_degrees: pitch, ..scene };
        let moved = draw(&frame, &grade, Some(&pose));
        let difference = (0..64 * 64).map(|at| {
            let (before, after) = (chromaticity(&reference, at * 4), chromaticity(&moved, at * 4));
            before.into_iter().zip(after).map(|(a, b)| (a - b).abs()).fold(0.0_f32, f32::max)
        }).fold(0.0_f32, f32::max);
        assert!(difference < 0.001, "pose moved source pixels by {difference} at {yaw},{pitch}");
    }
}

fn chromaticity(drawn: &[f32], at: usize) -> [f32; 2] {
    let colour = [linear(drawn[at]), linear(drawn[at + 1]), linear(drawn[at + 2])];
    let sum = colour.iter().sum::<f64>().max(1e-6);
    [(colour[0] / sum) as f32, (colour[1] / sum) as f32]
}

#[test]
fn surface_uses_the_editors_crop_keystone_and_visible_region() {
    let frame: Vec<_> = (0..64 * 64).flat_map(|at| {
        coded([0.05 + (at % 64) as f64 * 0.008 + (at / 64) as f64 * 0.004; 3])
    }).collect();
    let grade = Grade {
        geometry: Geometry {
            crop: [0.125, 0.125, 0.875, 0.875], angle_degrees: 4.0, rotate: 90,
            keystone: Some([1.0, 0.03, 0.0, 0.02, 1.0, 0.0, 0.08, 0.04]),
        },
        canvas: Some(Canvas {
            region: (6.0, 9.0, 24.0, 20.0), size: Size::measured(32, 24), max_lod: 6,
        }),
        ..grade()
    };
    let scene = diffuse();
    let ordinary = draw(&frame, &grade, None);
    let surface = draw(&frame, &grade, Some(&scene));
    let white_frame = coded([1.0; 3]).repeat(64 * 64);
    let black_frame = coded([0.0; 3]).repeat(64 * 64);
    let ordinary_white = draw(&white_frame, &grade, None);
    let paper_white = draw(&white_frame, &grade, Some(&scene));
    let paper_black = draw(&black_frame, &grade, Some(&scene));
    for y in [2, 12, 21] {
        for x in [2, 16, 29] {
            let at = (y * 32 + x) * 4;
            let source = linear(ordinary[at]) / linear(ordinary_white[at]);
            let black = linear(paper_black[at]);
            let white = linear(paper_white[at]);
            let expected = black + source * (white - black);
            assert!((linear(surface[at]) - expected).abs() < 0.0015,
                "surface disagrees with editor mapping at {x},{y}: {} vs {expected}", linear(surface[at]));
        }
    }
}

#[test]
fn surface_pose_moves_physical_hdr_reflections() {
    let frame = coded([1.0; 3]).repeat(64 * 64);
    let grade = grade();
    for (roughness, angular_degrees) in [(0.08, 30.0), (0.28, 10.0)] {
        let scene = Scene {
            presentation: Presentation::Surface, yaw_degrees: 0.0, pitch_degrees: 0.0,
            light_azimuth_degrees: 0.0, light_elevation_degrees: 75.0,
            light_angular_degrees: angular_degrees, fill_lux: Light::ZERO,
            roughness, surface_texture: 0.0, ..Scene::default()
        };
        let face = draw(&frame, &grade, Some(&scene));
        let reflected = draw(&frame, &grade, Some(&Scene { pitch_degrees: -37.5, ..scene }));
        let center = (32 * 64 + 32) * 4;
        assert!(linear(reflected[center]) > 2.0, "surface reflection lost HDR: {}", reflected[center]);
        assert!(linear(reflected[center]) > linear(face[center]) * 2.0,
            "surface pose did not move reflection: {} vs {}", face[center], reflected[center]);
    }
}

/// Glass is what a reader sees a framed print's surface through, whichever paper is behind it.
#[test]
fn glass_stands_in_for_the_paper_it_covers() {
    let photo = coded([0.35; 3]).repeat(64 * 64);
    let mut grade = grade();
    grade.canvas.as_mut().expect("canvas").region = (0.0, 0.0, 80.0, 80.0);
    let lit = Scene {
        presentation: Presentation::Surface, yaw_degrees: -15.0, pitch_degrees: -25.0,
        light_azimuth_degrees: -20.0, light_elevation_degrees: 60.0, light_angular_degrees: 30.0,
        key_lux: Light::exactly(1000.0), fill_lux: Light::exactly(500.0), refractive_index: 1.5,
        surface_texture: 0.0, ..Scene::default()
    };
    let coating = |framed: bool, roughness: f64| draw(&photo, &grade, Some(&Scene { framed, roughness, ..lit }));
    let apart = |a: &[f32], b: &[f32]| {
        let (sum, level) = a.iter().zip(b).fold((0.0, 0.0), |(sum, level), (a, b)| {
            (sum + f64::from((linear(*a) - linear(*b)).abs()), level + linear(*b))
        });
        sum / level.max(1e-6)
    };
    let framed = apart(&coating(true, 0.08), &coating(true, 0.28));
    let bare = apart(&coating(false, 0.08), &coating(false, 0.28));
    assert!(framed < bare / 2.0, "the paper reads through the glass: {framed} framed against {bare} bare");
}

#[test]
fn a_frame_has_a_dark_rim_a_light_mat_and_the_complete_photo() {
    let colors = [[0.8, 0.04, 0.04], [0.04, 0.8, 0.04], [0.04, 0.04, 0.8], [0.8; 3]].map(coded);
    let frame: Vec<_> = (0..64 * 64).flat_map(|at| colors[usize::from(at % 64 >= 32) + 2 * usize::from(at / 64 >= 32)]).collect();
    let scene = Scene { framed: true, ..diffuse() };
    let mut grade = grade();
    grade.canvas.as_mut().expect("canvas").region = (0.0, 0.0, 80.0, 80.0);
    let shown = draw(&frame, &grade, Some(&scene));
    let rim = linear(shown[(32 * 64) * 4]);
    let mat = linear(shown[(32 * 64 + 4) * 4]);
    assert!(rim < 0.04 && mat > 0.5, "rim={rim}, mat={mat}");
    for (x, y, channel) in [(12, 12, 0), (51, 12, 1), (12, 51, 2)] {
        let at = (y * 64 + x) * 4;
        assert!(shown[at + channel] > shown[at + (channel + 1) % 3] * 1.4,
            "framing lost the photo corner at {x},{y}");
    }
}

#[test]
fn frame_glass_has_hdr_reflections_and_gains_reflectivity_at_grazing_angles() {
    let black = coded([0.0; 3]).repeat(64 * 64);
    let scene = Scene { framed: true, black_reflectance: Gain::of_ratio(0.001), ..diffuse() };
    let mut framed_grade = grade();
    framed_grade.canvas.as_mut().expect("canvas").region = (0.0, 0.0, 80.0, 80.0);
    let center = (32 * 64 + 32) * 4;
    let face = draw(&black, &framed_grade, Some(&scene));
    let grazing = draw(&black, &framed_grade, Some(&Scene { yaw_degrees: 75.0, ..scene }));
    assert!(linear(grazing[center]) > linear(face[center]) * 3.0,
        "glass did not gain grazing reflection: {} / {}", grazing[center], face[center]);
    // A softbox rather than the default lamp: the centre reads the emitter's mirror image, and a
    // one-degree source lands its image between the probe and the frame.
    let lit = Scene { key_lux: Light::exactly(1000.0), light_elevation_degrees: 0.0,
        light_azimuth_degrees: 0.0, light_angular_degrees: 30.0, ..scene };
    let reflection = draw(&black, &framed_grade, Some(&lit));
    assert!(linear(reflection[center]) > 2.0, "glass lost HDR headroom: {}", reflection[center]);
    let bare = draw(&black, &grade(), Some(&Scene { framed: false, ..lit }));
    assert!(linear(reflection[center]) > linear(bare[center]) * 10.0,
        "reflection must belong to the glass above nonreflective paper");
}

#[test]
fn rectangular_surface_has_equal_mat_borders_without_stretching_the_photo() {
    let frame = coded([0.0; 3]).repeat(64 * 64);
    let scene = Scene { framed: true, ..diffuse() };
    for portrait in [false, true] {
        let (width, height) = if portrait { (80, 144) } else { (144, 80) };
        let grade = Grade {
            geometry: Geometry { crop: [0.0, 0.0, 1.0, 0.5], rotate: if portrait { 90 } else { 0 }, ..Geometry::none() },
            canvas: Some(Canvas { region: (0.0, 0.0, width as f64 / 2.0, height as f64 / 2.0),
                size: Size::measured(width, height), max_lod: 6 }),
            ..grade()
        };
        let shown = draw(&frame, &grade, Some(&scene));
        for (x, y) in [(4, height / 2), (width - 5, height / 2), (width / 2, 4), (width / 2, height - 5)] {
            assert!(linear(shown[(y * width + x) * 4]) > 0.5, "missing equal-width mat at {x},{y}");
        }
        for (x, y) in [(9, height / 2), (width - 10, height / 2), (width / 2, 9), (width / 2, height - 10)] {
            assert!(linear(shown[(y * width + x) * 4]) < 0.15, "mat obscured photo at {x},{y}");
        }
    }
}

fn diffuse() -> Scene {
    Scene {
        presentation: Presentation::Surface, yaw_degrees: 0.0, pitch_degrees: 0.0,
        key_lux: Light::ZERO, fill_lux: Light::exactly(500.0), refractive_index: 1.0,
        surface_texture: 0.0, ..Scene::default()
    }
}

fn grade() -> Grade<'static> {
    Grade {
        width: 64, height: 64, photograph_long: Span::measured(64), colour: None,
        white: Light::measured(10000.0), source_level: Light::measured(10000.0), floor: None,
        reference_nits: Light::exactly(203.0), peak_nits: Light::exactly(203.0),
        exposure: Stops::ZERO, adjust: Adjust::none(), as_shot: None, output: Output::Pq,
        geometry: Geometry::none(), window: None, surround_window: None,
        canvas: Some(Canvas { region: (0.0, 0.0, 64.0, 64.0), size: Size::measured(64, 64), max_lod: 6 }),
        print_tone: rawshim::gpu::Tonemap::Neutral,
    }
}

fn coded(rgb: [f64; 3]) -> [u16; 3] {
    rawshim::hdr_fit::srgb_to_rec2020().map(|row| {
        let value = row.into_iter().zip(rgb).map(|(weight, value)| weight * value).sum::<f64>();
        (rawshim::tone::pq(Light::<SceneNits>::exactly(value * 203.0)).raw() * 65535.0).round() as u16
    })
}

fn linear(coded: f32) -> f64 {
    let value = f64::from(coded);
    if value.abs() <= 0.04045 { value / 12.92 }
    else { value.signum() * ((value.abs() + 0.055) / 1.055).powf(2.4) }
}

fn draw(frame: &[u16], grade: &Grade<'_>, scene: Option<&Scene>) -> Vec<f32> {
    let gpu = rawshim::gpu::device().expect("print requires Vulkan");
    let base = rawshim::base::device(gpu).expect("source pyramid");
    let pyramid = rawshim::base::pyramid(gpu, base, frame, (64, 64)).expect("source pyramid");
    let peak = gpu.scene_peak();
    let uploaded = gpu.upload(frame, grade, &peak);
    match scene {
        Some(scene) => uploaded.draw_print(grade, &pyramid, scene),
        None => uploaded.draw(grade, &pyramid),
    }
}
