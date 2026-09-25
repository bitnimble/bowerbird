use rawshim::gpu::{Canvas, Grade};
use rawshim::image::Geometry;
use rawshim::light::{Light, SceneNits};
use rawshim::print::Scene;
use rawshim::px::Size;

#[test]
fn grazing_print_preserves_detail_across_its_short_pixel_axis() {
    let gpu = rawshim::gpu::device().expect("print requires Vulkan");
    let base = rawshim::base::device(gpu).expect("the source pyramid");
    let size = 1024;
    let canvas = 384;
    let code = |nits| (rawshim::tone::pq(Light::<SceneNits>::exactly(nits)).raw() * 65535.0).round() as u16;
    let white = code(203.0);
    let grey = code(101.5);
    let grade = Grade {
        canvas: Some(Canvas {
            region: (0.0, 0.0, size as f64, size as f64),
            size: Size::measured(canvas, canvas),
            max_lod: 10,
        }),
        ..Grade::new(
            size,
            size,
            rawshim::tone::Levels { white: Light::measured(10000.0), peak: Light::measured(60000.0), floor: None },
            Light::exactly(203.0),
            Light::exactly(1000.0),
        )
    };
    let scene = Scene {
        yaw_degrees: 80.0,
        pitch_degrees: 0.0,
        key_lux: Light::ZERO,
        fill_lux: Light::exactly(500.0),
        refractive_index: 1.0,
        surface_texture: 0.0,
        ..Scene::default()
    };
    for (geometry, scene) in [
        (Geometry::none(), scene),
        (
            Geometry {
                crop: [0.2, 0.15, 0.8, 0.85],
                rotate: 90,
                keystone: Some([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.12, 0.0]),
                ..Geometry::none()
            },
            Scene { yaw_degrees: 0.0, pitch_degrees: 80.0, ..scene },
        ),
    ] {
        let grade = Grade { geometry, ..grade.clone() };
        let peak = gpu.scene_peak();
        let mut draws = Vec::new();
        for pattern in 0..3 {
            let frame: Vec<u16> = (0..size * size).flat_map(|pixel| {
                let value = match pattern {
                    0 => if (pixel / size / 4) % 2 == 0 { 0 } else { white },
                    1 => if (pixel % size) % 2 == 0 { 0 } else { white },
                    _ => grey,
                };
                [value; 3]
            }).collect();
            let pyramid = rawshim::base::pyramid(gpu, base, &frame, (size, size)).expect("a pyramid");
            let uploaded = gpu.upload(&frame, &grade, &peak);
            draws.push(uploaded.draw_print(&grade, &pyramid, &scene));
        }
        let scan: Vec<_> = (canvas / 2 - 32..canvas / 2 + 32).map(|offset| {
            if geometry.rotate == 0 { (offset * canvas + canvas / 2) * 4 }
            else { (canvas / 2 * canvas + offset) * 4 }
        }).collect();
        let low = scan.iter().map(|&at| draws[0][at]).fold(f32::INFINITY, f32::min);
        let high = scan.iter().map(|&at| draws[0][at]).fold(f32::NEG_INFINITY, f32::max);
        assert!(high - low > 0.25, "resolvable horizontal bands lost contrast: {low}..{high}");
        for at in scan {
            assert!((draws[1][at] - draws[2][at]).abs() < 0.005,
                "compressed vertical bands must average in linear light: {} vs {}", draws[1][at], draws[2][at]);
        }
    }
}
