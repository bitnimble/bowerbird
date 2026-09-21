use rawshim::gpu::{Adjust, Canvas, Grade, Output};
use rawshim::image::Geometry;
use rawshim::light::{Light, SceneNits, Stops};
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
    for (yaw, pitch) in [(35.0, 20.0), (-45.0, -30.0), (75.0, 10.0)] {
        let pose = Scene { yaw_degrees: yaw, pitch_degrees: pitch, ..scene };
        let moved = draw(&frame, &grade, Some(&pose));
        let difference = reference.iter().zip(&moved).map(|(a, b)| (a - b).abs()).fold(0.0_f32, f32::max);
        assert!(difference < 0.0001, "pose moved source pixels by {difference} at {yaw},{pitch}");
    }
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
