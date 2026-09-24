use rawshim::gpu::{Adjust, Canvas, Grade, Output};
use rawshim::light::{Gain, Light, Stops};
use rawshim::print::{Paper, Scene};
use rawshim::px::{Size, Span};

fn main() -> Result<(), String> {
    let path = std::env::args().nth(1).ok_or("usage: print_hdr_audit <photograph>")?;
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    eprintln!("preparing photograph");
    let prepared = rawshim::edit::prepare_bytes(&bytes, &rawshim::edit::EditRequest {
        long_edge: 1600,
        grade: rawshim::hdr::Grade {
            peak_nits: Light::exactly(1000.0), reference_white_nits: Light::exactly(203.0), white_quantile: 0.995,
        },
        defringe: 1.0, photo_analysis: None, denoise_luminance: None, denoise_colour: None,
        denoiser: rawshim::galosh::Denoiser::Galosh, dust: Default::default(), repairs: Vec::new(),
        stated_white: false,
    }, 40.0)?;
    let gpu = rawshim::gpu::device().ok_or("print requires Vulkan")?;
    let base = rawshim::base::device(gpu).ok_or("the source pyramid")?;
    let header = &prepared.header;
    let analysis = header.photo_analysis.as_deref().and_then(rawshim::photo_analysis::decode);
    let pyramid = rawshim::base::pyramid(gpu, base, &prepared.samples, (header.width, header.height)).ok_or("the source pyramid")?;
    let grade = Grade {
        width: header.width, height: header.height,
        photograph_long: Span::measured(header.width.max(header.height)),
        colour: analysis.as_ref().and_then(|analysis| analysis.from_raw.matched.as_ref()).and_then(|matched| matched.colour.as_ref()),
        white: header.white, source_level: header.peak, floor: header.floor,
        reference_nits: header.grade.reference_white_nits, peak_nits: Light::exactly(1000.0),
        exposure: Stops::ZERO, adjust: Adjust::none(), as_shot: header.as_shot, output: Output::Pq,
        geometry: rawshim::image::Geometry::none(), window: None, surround_window: None,
        canvas: Some(Canvas {
            region: (0.0, 0.0, header.width as f64, header.height as f64),
            size: Size::measured(1280, 960), max_lod: pyramid.levels,
        }),
        print_tone: rawshim::gpu::Tonemap::Neutral,
    };
    let peak = gpu.scene_peak();
    let uploaded = gpu.upload(&prepared.samples, &grade, &peak);
    let texture = |format| gpu.own_texture(&wgpu::TextureDescriptor {
        label: Some("print HDR audit"), size: wgpu::Extent3d { width: 1280, height: 960, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let canvases = [texture(wgpu::TextureFormat::Rgba16Float), texture(wgpu::TextureFormat::Rgba16Uint),
        texture(wgpu::TextureFormat::Rgba16Float), texture(wgpu::TextureFormat::Rgba16Float)];
    let views = canvases.each_ref().map(|canvas| canvas.view());
    let device = gpu.describing();
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("print HDR audit"),
        source: wgpu::ShaderSource::Wgsl(include_str!(concat!(env!("OUT_DIR"), "/wgsl/print_hdr_audit.wgsl")).into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("print HDR audit"), layout: None, module: &shader, entry_point: Some("audit"),
        compilation_options: Default::default(), cache: None,
    });
    eprintln!("adapter: {}", gpu.adapter);
    println!("paper,view,light_angular_degrees,key_lux,fill_lux,min_nits,peak_nits,mean_nits,peak_p3_nits,peak_canvas_code,above_203_percent,above_500_percent,above_1000_percent,pq_error_nits,pq_error_relative,sdr_proof_error,twice_light_error");
    for (name, paper, roughness, white, black, surface_texture) in [
        ("gloss", Paper::Gloss, 0.08, 0.92, 0.004, 0.15),
        ("satin", Paper::Satin, 0.18, 0.9, 0.008, 0.5),
        ("matte", Paper::Matte, 0.65, 0.88, 0.025, 0.85),
    ] {
        let scene = Scene {
            paper, roughness, white_reflectance: Gain::of_ratio(white), black_reflectance: Gain::of_ratio(black),
            surface_texture, ..Scene::default()
        };
        for (view, scene) in [("default", scene), ("glare", Scene {
            yaw_degrees: -15.0, pitch_degrees: -12.0, ..scene
        }.lit_from(-32.0, 25.0, 4.0))] {
            for light_angular_degrees in [60.0, 45.0, 30.0, 25.0] {
                let scene = Scene { light_angular_degrees, ..scene };
                let doubled = Scene {
                    key_lux: Light::exactly(scene.key_lux.raw() * 2.0),
                    fill_lux: Light::exactly(scene.fill_lux.raw() * 2.0), ..scene
                };
                let proof = Grade { output: Output::Srgb, peak_nits: Light::exactly(203.0), ..grade };
                for (index, grade, scene) in [(0, &grade, &scene), (1, &grade, &scene), (2, &grade, &doubled), (3, &proof, &scene)] {
                    let mut recording = gpu.record();
                    uploaded.draw_into(&mut recording, grade, &pyramid, &views[index], Some(scene), index == 1);
                    recording.submit();
                }
                let mut recording = gpu.record();
                let result = recording.buffer(&wgpu::BufferDescriptor {
                    label: Some("print HDR statistics"), size: 64,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false,
                });
                let readback = recording.buffer(&wgpu::BufferDescriptor {
                    label: Some("print HDR statistics readback"), size: 64,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false,
                });
                let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("print HDR audit"), layout: &pipeline.get_bind_group_layout(0), entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&views[0]) },
                        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&views[1]) },
                        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&views[2]) },
                        wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&views[3]) },
                        wgpu::BindGroupEntry { binding: 4, resource: result.as_entire_binding() },
                    ],
                });
                {
                    let mut pass = recording.encoder().begin_compute_pass(&Default::default());
                    pass.set_pipeline(&pipeline);
                    pass.set_bind_group(0, &group, &[]);
                    pass.dispatch_workgroups(1, 1, 1);
                }
                recording.encoder().copy_buffer_to_buffer(&result, 0, &readback, 0, 64);
                recording.submit();
                let statistics: [f32; 16] = pollster::block_on(rawshim::gpu::read_back(gpu, &readback, |bytes| {
                    std::array::from_fn(|index| f32::from_le_bytes(bytes[index * 4..index * 4 + 4].try_into().expect("float")))
                })).ok_or("print HDR statistics")?;
                let [minimum, maximum, p3, coded, sum, superwhite, count, _, pq_absolute, pq_relative, proof_error, scaling, over500, over1000, ..] = statistics;
                println!("{name},{view},{light_angular_degrees},{},{},{minimum:.3},{maximum:.3},{:.3},{p3:.3},{coded:.5},{:.3},{:.3},{:.3},{pq_absolute:.5},{pq_relative:.5},{proof_error:.5},{scaling:.5}",
                    scene.key_lux.raw(), scene.fill_lux.raw(), sum / count, superwhite * 100.0 / count, over500 * 100.0 / count, over1000 * 100.0 / count);
                assert!(proof_error == 0.0, "SDR proof changed the print: {proof_error}");
                assert!(pq_relative < 0.003, "float canvas disagrees with the PQ reference: {pq_relative}");
                assert!(scaling < 0.005, "exposure adaptation changed local lighting ratios: {scaling}");
            }
        }
    }
    Ok(())
}
