use crate::gpu::{self, Adjust, Canvas, Gpu, Grade, Output, Texture, Uploaded};
use crate::light::{Light, SceneNits, Stops};
use crate::print::{Presentation, Scene};
use crate::px::{Extent, Size, Span};

struct Comparison {
    gpu: &'static Gpu,
    uploaded: Uploaded<'static>,
    pyramid: crate::base::Pyramid,
    grade: Grade<'static>,
    targets: [Texture; 2],
    pipeline: wgpu::ComputePipeline,
}

impl Comparison {
    fn new() -> Self {
        let gpu = gpu::device().expect("print requires Vulkan");
        let base = crate::base::device(gpu).expect("source pyramid");
        let (width, height) = (384, 256);
        let code = (crate::tone::pq(Light::<SceneNits>::exactly(203.0)).raw() * 65535.0).round() as u16;
        let frame = vec![code; width * height * 3];
        let grade = Grade {
            width, height, photograph_long: Span::measured(width), colour: None,
            white: Light::measured(10000.0), source_level: Light::measured(10000.0), floor: None,
            reference_nits: Light::exactly(203.0), peak_nits: Light::exactly(1000.0),
            exposure: Stops::ZERO, adjust: Adjust::none(), as_shot: None, output: Output::Pq,
            geometry: crate::image::Geometry::none(), window: None, surround_window: None,
            canvas: Some(Canvas { region: (0.0, 0.0, width as f64, height as f64),
                size: Size::measured(width, height), max_lod: 0 }),
        };
        let pyramid = crate::base::pyramid(gpu, base, &frame, (width, height)).expect("source pyramid");
        let resident = crate::resident::Resident::upload(gpu, &frame, width, height);
        let uploaded = gpu.upload_resident(&resident, &grade, &gpu.scene_peak());
        let targets = std::array::from_fn(|_| gpu.own_texture(&wgpu::TextureDescriptor {
            label: Some("print comparison"),
            size: wgpu::Extent3d { width: width as u32, height: height as u32, depth_or_array_layers: 1 },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        }));
        let shader = gpu.describing().create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("print comparison"),
            source: wgpu::ShaderSource::Wgsl(include_str!(concat!(env!("OUT_DIR"), "/wgsl/print_surface_compare.wgsl")).into()),
        });
        let pipeline = gpu.describing().create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("print comparison"), layout: None, module: &shader, entry_point: Some("compare"),
            compilation_options: Default::default(), cache: None,
        });
        Self { gpu, uploaded, pyramid, grade, targets, pipeline }
    }

    fn draw(&self, scene: &Scene) -> [f32; 12] {
        let mut recording = self.gpu.record();
        self.uploaded.draw_direct(&mut recording, &self.grade, &self.pyramid, &self.targets[0].view(), Some(scene), false, false);
        recording.submit();
        let mut recording = self.gpu.record();
        self.uploaded.draw_into(&mut recording, &self.grade, &self.pyramid, &self.targets[1].view(), Some(scene), false);
        recording.submit();
        let mut recording = self.gpu.record();
        let output = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("print comparison"), size: 48, mapped_at_creation: false,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        });
        let readback = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("print comparison readback"), size: 48, mapped_at_creation: false,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        });
        let group = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("print comparison"), layout: &self.pipeline.get_bind_group_layout(0), entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&self.targets[0].view()) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&self.targets[1].view()) },
                wgpu::BindGroupEntry { binding: 2, resource: output.as_entire_binding() },
            ],
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        recording.encoder().copy_buffer_to_buffer(&output, 0, &readback, 0, 48);
        recording.submit();
        pollster::block_on(gpu::read_back(self.gpu, &readback, |bytes| std::array::from_fn(|i| {
            f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().expect("float"))
        }))).expect("comparison results")
    }
}

#[test]
fn print_surface_cache_preserves_lighting_and_hdr_peaks() {
    let comparison = Comparison::new();
    let mut failures = Vec::new();
    for (roughness, texture) in [(0.03, 0.0), (0.03, 1.0), (0.08, 0.15), (0.28, 0.5), (0.65, 0.85), (1.0, 1.0)] {
        for (angular, pitch, yaw, fill, millimetres) in [
            (30.0, -37.5, 0.0, 500.0, 300.0),
            (1.0, -37.5, 0.0, 0.0, 300.0),
            (5.0, -37.5, 0.0, 0.0, 300.0),
            (10.0, -37.5, 0.0, 0.0, 300.0),
            (20.0, -37.5, 0.0, 0.0, 300.0),
            (30.0, -20.0, 20.0, 500.0, 50.0),
            (90.0, -10.0, 75.0, 500.0, 1000.0),
        ] {
            let scene = Scene {
                presentation: Presentation::Surface, roughness, surface_texture: texture,
                light_angular_degrees: angular, pitch_degrees: pitch, yaw_degrees: yaw,
                fill_lux: Light::exactly(fill), paper_long_edge_mm: Extent::exactly(millimetres), ..Scene::default()
            };
            let [absolute, relative, squared, bad, reference_peak, peak, _, _, ..] = comparison.draw(&scene);
            eprintln!("roughness={roughness} texture={texture} angle={angular} pitch={pitch} yaw={yaw}: absolute={absolute} relative={relative} rms={} peak={reference_peak}/{peak}", squared.sqrt());
            assert_eq!(bad, 0.0);
            if relative >= 0.03 || squared.sqrt() >= 0.01 || (peak / reference_peak - 1.0).abs() >= 0.03 {
                failures.push((roughness, texture, angular, relative, squared.sqrt(), peak / reference_peak));
            }
        }
    }
    assert!(failures.is_empty(), "cached lighting differs: {failures:?}");
}

#[test]
fn print_surface_pigment_cache_tracks_photo_changes_and_source_writes() {
    let mut comparison = Comparison::new();
    let bands = [0.2, 0.4, 0.7, 1.0].map(|value| {
        (crate::tone::pq(Light::<SceneNits>::exactly(value * 203.0)).raw() * 65535.0).round() as u16
    });
    let pattern: Vec<u8> = (0..comparison.grade.width * comparison.grade.height).flat_map(|at| {
        let band = at % comparison.grade.width * 4 / comparison.grade.width;
        [bands[band]; 3].into_iter().flat_map(u16::to_le_bytes)
    }).collect();
    comparison.gpu.queue.write_buffer(&comparison.uploaded.samples, 0, &pattern);
    let scene = Scene { presentation: Presentation::Surface, key_lux: Light::ZERO, ..Scene::default() };
    let original = comparison.draw(&scene);
    comparison.grade.exposure = Stops::measured(-1.0);
    let exposed = comparison.draw(&scene);
    assert!(exposed[1] < 0.001 && exposed[7] < original[7] * 0.6,
        "exposure retained stale pigment: {exposed:?}, original {original:?}");
    comparison.grade.geometry.crop = [0.5, 0.0, 1.0, 1.0];
    let shape = comparison.grade.output_size();
    comparison.grade.canvas.as_mut().expect("canvas").region = (0.0, 0.0, shape.0 as f64, shape.1 as f64);
    let cropped = comparison.draw(&scene);
    assert!(cropped[1] < 0.001 && cropped[7] > exposed[7] * 1.2,
        "crop retained stale pigment: {cropped:?}, uncropped {exposed:?}");
    comparison.grade.canvas.as_mut().expect("canvas").region = (0.0, 0.0, shape.0 as f64 * 0.5, shape.1 as f64);
    let panned = comparison.draw(&scene);
    assert!(panned[1] < 0.001 && panned[7] < cropped[7] * 0.92,
        "visible region retained stale pigment: {panned:?}, whole crop {cropped:?}");
    comparison.uploaded.invalidate_print_cache();
    comparison.gpu.queue.write_buffer(&comparison.uploaded.samples, 0,
        &vec![0; comparison.grade.width * comparison.grade.height * 6]);
    let black = comparison.draw(&scene);
    assert!(black[1] < 0.001 && black[7] < exposed[7] * 0.2,
        "mutated source left stale pigment: {black:?}, exposed {exposed:?}");
    let lit = Scene { key_lux: Light::exactly(1000.0), pitch_degrees: -37.5, roughness: 0.08, ..scene };
    assert!(comparison.draw(&lit)[1] < 0.03, "ambient-only cache hid direct light");
}

#[test]
fn print_peak_cache_observes_other_uploads_sharing_the_measurement() {
    let comparison = Comparison::new();
    let colour = crate::hdr_fit::HdrColour::identity();
    let grade = Grade { colour: Some(&colour), ..comparison.grade };
    let raised = Grade { exposure: Stops::measured(1.0), ..grade };
    let code = (crate::tone::pq(Light::<SceneNits>::exactly(80.0)).raw() * 65535.0).round() as u16;
    let frame = vec![code; grade.width * grade.height * 3];
    let peak = comparison.gpu.scene_peak();
    let first = comparison.gpu.upload(&frame, &grade, &peak);
    first.collect_candidates(&grade);
    let second = comparison.gpu.upload(&frame, &grade, &peak);
    second.collect_candidates(&grade);
    first.peak_from_candidates(&grade);
    let expected = comparison.gpu.read_peak(&peak);
    second.peak_from_candidates(&raised);
    assert!(comparison.gpu.read_peak(&peak) > expected * 1.5);
    first.peak_from_candidates(&grade);
    assert_eq!(comparison.gpu.read_peak(&peak), expected, "memo reused another upload's peak");
}
