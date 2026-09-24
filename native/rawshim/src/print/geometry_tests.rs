use super::Scene;
use crate::px::Extent;

#[test]
fn print_bends_along_its_long_edge_and_keeps_stock_thickness() {
    let scene = Scene { yaw_degrees: 0.0, pitch_degrees: 0.0, ..Scene::default() };
    for shape in [[300.0, 200.0], [200.0, 300.0]] {
        let axis = usize::from(shape[1] > shape[0]);
        let mut edge = [0.0, 0.0, 0.0091];
        edge[axis] = 0.9;
        let samples = probe(&scene, &[
            sample(project([0.0, 0.0, 0.001], &scene, shape), shape),
            sample(project(edge, &scene, shape), shape),
        ]);
        assert!((samples[0][2] * 150.0 - 0.15).abs() < 0.0001, "front thickness: {samples:?}");
        assert!((samples[1][2] * 150.0 - 1.365).abs() < 0.001, "curved edge: {samples:?}");
        assert!((samples[1][4 + axis] + 0.017997).abs() < 0.0001, "curved normal: {samples:?}");
        assert!((samples[1][6] - 0.999838).abs() < 0.0001, "normal length: {samples:?}");
        assert_eq!(samples[0][7], 1.0);
        assert_eq!(samples[1][7], 1.0);
    }
    let back = Scene { yaw_degrees: 180.0, ..scene };
    let sample = probe(&back, &[sample(project([0.0, 0.0, -0.001], &back, [300.0, 200.0]), [300.0, 200.0])])[0];
    assert!((sample[2] * 150.0 + 0.15).abs() < 0.0001, "back thickness: {sample:?}");
    assert!((sample[6] + 1.0).abs() < 0.0001, "back normal: {sample:?}");
    assert!(sample[15] > 0.99, "back must face camera: {sample:?}");
}

#[test]
fn print_edges_cover_fractional_pixels_at_front_and_grazing_angles() {
    for yaw in [0.0, 75.0, 89.8, 90.0, 180.0] {
        let scene = Scene { yaw_degrees: yaw, pitch_degrees: 0.0, ..Scene::default() };
        let edge = project([1.0, 0.0, 0.011], &scene, [300.0, 200.0]);
        let probes: Vec<_> = (-80..=80).map(|offset| {
            sample([edge[0] + offset as f32 * 0.05, edge[1]], [300.0, 200.0])
        }).collect();
        let samples = probe(&scene, &probes);
        assert!(samples.iter().all(|row| row.iter().all(|value| value.is_finite())), "nonfinite yaw {yaw}");
        let partial: Vec<_> = samples.iter().map(|row| row[7]).filter(|value| *value > 0.0 && *value < 1.0).collect();
        assert!(partial.len() > 4, "missing antialiasing at yaw {yaw}: {partial:?}");
        assert!(partial.iter().any(|value| (value * 4.0).fract().abs() > 0.01), "four-sample coverage at yaw {yaw}: {partial:?}");
    }
    let scene = Scene {
        yaw_degrees: 90.0, pitch_degrees: 0.0,
        paper_long_edge_mm: Extent::exactly(1000.0), ..Scene::default()
    };
    let center = project([0.0, 0.0, 0.0], &scene, [300.0, 200.0]);
    let probes: Vec<_> = (-20..=20).map(|offset| {
        sample([center[0] + offset as f32 * 0.025, center[1]], [300.0, 200.0])
    }).collect();
    assert!(probe(&scene, &probes).iter().any(|row| row[3] == 0.0 && row[14] == 1.0 && row[7] > 0.0),
        "subpixel paper disappeared when center ray missed");
    let thin = project([0.0, 0.5, 0.0025], &scene, [200.0, 300.0]);
    let covered = probe(&scene, &[[thin[0] / 8.0 + 0.03, thin[1] / 8.0, 64.0, 64.0, 200.0, 300.0, 0.0, 0.0]])[0];
    assert_eq!(covered[3], 0.0, "center must miss thin stock: {covered:?}");
    assert!((covered[7] - 0.0438).abs() < 0.005, "thin stock must retain fractional area: {covered:?}");
}

#[test]
fn print_texture_derivatives_follow_the_curved_tangent() {
    let scene = Scene { yaw_degrees: 60.0, pitch_degrees: 20.0, ..Scene::default() };
    let center = project([0.7, 0.1, 0.0059], &scene, [300.0, 200.0]);
    let samples = probe(&scene, &[
        sample(center, [300.0, 200.0]),
        sample([center[0] + 1.0, center[1]], [300.0, 200.0]),
        sample([center[0], center[1] + 1.0], [300.0, 200.0]),
    ]);
    assert!(samples.iter().all(|row| row[3] == 1.0));
    for channel in 0..2 {
        let dx = samples[1][8 + channel] - samples[0][8 + channel];
        let dy = samples[2][8 + channel] - samples[0][8 + channel];
        assert!((samples[0][10 + channel] - dx).abs() < 0.00001, "curved x derivative: {samples:?}");
        assert!((samples[0][12 + channel] - dy).abs() < 0.00001, "curved y derivative: {samples:?}");
    }
}

#[test]
fn frame_mat_has_the_same_width_on_every_side_of_a_rectangular_photo() {
    for shape in [[300.0, 200.0], [200.0, 300.0], [800.0, 200.0]] {
        let long = f64::max(shape[0], shape[1]);
        let scene = Scene { framed: true, yaw_degrees: 0.0, pitch_degrees: 0.0,
            paper_long_edge_mm: Extent::measured(long), ..Scene::default() };
        let half_mm = long * 0.5;
        for axis in 0..2 {
            for side in [-1.0, 1.0] {
                for (margin_mm, depth_mm) in [(10.0, 1.4), (22.0, 9.0)] {
                    let mut point = [0.0, 0.0, depth_mm / half_mm];
                    point[axis] = side * (shape[axis] / long + margin_mm / half_mm);
                    let shape = shape.map(|value| value as f32);
                    let hit = probe(&scene, &[sample(project(point, &scene, shape), shape)])[0];
                    assert_eq!(hit[3], 1.0, "frame missing at {point:?}");
                    assert!((f64::from(hit[2]) * half_mm - depth_mm).abs() < 0.001,
                        "unequal border at {point:?}: {hit:?}");
                }
            }
        }
    }
}

/// A landscape sheet on a landscape canvas fills it as far as a portrait one does, rather than
/// laying its long edge along the canvas's long one and covering half of it.
#[test]
fn every_sheet_shape_is_framed_to_the_same_margin() {
    let scene = Scene { yaw_degrees: 0.0, pitch_degrees: 0.0, ..Scene::default() };
    let canvas = [640.0f32, 400.0];
    let fill = |shape: [f32; 2]| {
        let across = |axis: usize| {
            let probes: Vec<_> = (0..canvas[axis] as usize).map(|at| {
                let mut pixel = [canvas[0] / 2.0, canvas[1] / 2.0];
                pixel[axis] = at as f32 + 0.5;
                [pixel[0], pixel[1], canvas[0], canvas[1], shape[0], shape[1], 0.0, 0.0]
            }).collect();
            probe(&scene, &probes).iter().filter(|row| row[3] == 1.0).count() as f32 / canvas[axis]
        };
        across(0).max(across(1))
    };
    let (portrait, landscape) = (fill([200.0, 300.0]), fill([300.0, 200.0]));
    assert!((portrait - landscape).abs() < 0.02, "a portrait sheet fills {portrait}, a landscape one {landscape}");
}

fn sample(pixel: [f32; 2], shape: [f32; 2]) -> [f32; 8] {
    [pixel[0], pixel[1], 512.0, 512.0, shape[0], shape[1], 0.0, 0.0]
}

/// Where a point on the sheet lands on `sample`'s square canvas: the shader's camera, fitted to the
/// sheet's outline on a canvas whose two edges are the same.
fn project(point: [f64; 3], scene: &Scene, shape: [f32; 2]) -> [f32; 2] {
    let (yaw_sin, yaw_cos) = scene.yaw_degrees.to_radians().sin_cos();
    let (pitch_sin, pitch_cos) = scene.pitch_degrees.to_radians().sin_cos();
    let yawed = [yaw_cos * point[0] + yaw_sin * point[2], point[1], -yaw_sin * point[0] + yaw_cos * point[2]];
    let world = [yawed[0], pitch_cos * yawed[1] - pitch_sin * yawed[2], pitch_sin * yawed[1] + pitch_cos * yawed[2]];
    let border = if scene.framed { 0.125 } else { 0.0 };
    let camera = 3.4 * (1.0 + 2.0 * border);
    let short = f64::from(shape[0].min(shape[1]) / shape[0].max(shape[1]));
    let focal = 1.45 * camera / (3.4 * (1.0 + 2.0 * border * short));
    let scale = focal * 512.0 / (camera - world[2]);
    [(256.0 + world[0] * scale) as f32, (256.0 - world[1] * scale) as f32]
}

fn probe(scene: &Scene, probes: &[[f32; 8]]) -> Vec<[f32; 16]> {
    let gpu = crate::gpu::device().expect("print requires Vulkan");
    let device = gpu.describing();
    let mut recording = gpu.record();
    let inputs = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("print geometry probes"),
        contents: &probes.iter().flatten().flat_map(|value| value.to_le_bytes()).collect::<Vec<_>>(),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("print geometry scene"), contents: &scene.uniform(crate::light::Light::ZERO), usage: wgpu::BufferUsages::UNIFORM,
    });
    let bytes = probes.len() as u64 * 64;
    let output = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("print geometry results"), size: bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false,
    });
    let readback = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("print geometry readback"), size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false,
    });
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("print geometry"), source: wgpu::ShaderSource::Wgsl(include_str!(concat!(env!("OUT_DIR"), "/wgsl/print_geometry_probe.wgsl")).into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("print geometry"), layout: None, module: &module, entry_point: Some("main"),
        compilation_options: Default::default(), cache: None,
    });
    let probes_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("print geometry probes"), layout: &pipeline.get_bind_group_layout(0), entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: inputs.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: output.as_entire_binding() },
        ],
    });
    let scene_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("print geometry scene"), layout: &pipeline.get_bind_group_layout(1),
        entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() }],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &probes_group, &[]);
        pass.set_bind_group(1, &scene_group, &[]);
        pass.dispatch_workgroups(probes.len() as u32, 1, 1);
    }
    recording.encoder().copy_buffer_to_buffer(&output, 0, &readback, 0, bytes);
    recording.submit();
    pollster::block_on(crate::gpu::read_back(gpu, &readback, |bytes| {
        bytes.chunks_exact(64).map(|row| std::array::from_fn(|i| {
            f32::from_le_bytes(row[i * 4..i * 4 + 4].try_into().expect("float"))
        })).collect()
    })).expect("geometry results")
}
