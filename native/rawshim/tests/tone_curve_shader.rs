use rawshim::gpu::{Grade, ToneCurve};
use rawshim::hdr_fit::HdrColour;
use rawshim::light::{CurveCode, Gain, Light, Stops};

fn probe(entry: &str, samples: &[[f32; 4]], grade: &Grade<'_>) -> Vec<[f32; 4]> {
    let gpu = rawshim::gpu::device().expect("Vulkan adapter");
    let device = gpu.describing();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("tone probe"),
        source: wgpu::ShaderSource::Wgsl(include_str!(concat!(env!("OUT_DIR"), "/wgsl/tone_probe.wgsl")).into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: None, layout: None, module: &module, entry_point: Some(entry),
        compilation_options: Default::default(), cache: None,
    });
    let mut recording = gpu.record();
    let mut init = |bytes: &[u8], usage| recording.init(&wgpu::util::BufferInitDescriptor {
        label: None, contents: bytes, usage,
    });
    let inputs = init(&samples.iter().flatten().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>(), wgpu::BufferUsages::STORAGE);
    let identity = HdrColour::identity();
    let words = rawshim::gpu::uniform_words(grade, grade.colour.unwrap_or(&identity));
    let edits = init(&words.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>(), wgpu::BufferUsages::UNIFORM);
    let out = init(&vec![0; samples.len() * 16], wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC);
    let readback = recording.buffer(&wgpu::BufferDescriptor {
        label: None, size: (samples.len() * 16) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None, layout: &pipeline.get_bind_group_layout(0), entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 22, resource: inputs.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 23, resource: out.as_entire_binding() },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(samples.len().div_ceil(64) as u32, 1, 1);
    }
    recording.encoder().copy_buffer_to_buffer(&out, 0, &readback, 0, (samples.len() * 16) as u64);
    recording.submit();
    pollster::block_on(rawshim::gpu::read_back(gpu, &readback, |bytes| {
        bytes.chunks_exact(16).map(|pixel| std::array::from_fn(|c|
            f32::from_le_bytes(pixel[c * 4..c * 4 + 4].try_into().unwrap()))).collect()
    })).expect("tone probe readback")
}

fn probe_grade(count: usize) -> Grade<'static> {
    Grade::new(count, 1, rawshim::tone::Levels {
        white: Light::measured(1.0), peak: Light::measured(8.0), floor: Some(Light::measured(0.01)),
    }, Light::exactly(1.0), Light::exactly(10000.0))
}

#[test]
fn shader_curve_matches_the_shared_host_table() {
    #[derive(serde::Deserialize)]
    struct Case { points: Vec<[f64; 2]>, samples: Vec<[f64; 2]> }
    let cases: Vec<Case> = serde_json::from_str(include_str!("../../../test/fixtures/tables/tone-curve.json")).unwrap();
    for case in cases {
        let inputs: Vec<[f32; 4]> = case.samples.iter().filter(|p| p[0] >= 0.0).map(|p| {
            let light = CurveCode::from_raw(p[0]).white_ratio().raw() as f32;
            [light, light, light, 0.0]
        }).collect();
        let mut grade = probe_grade(inputs.len());
        grade.adjust.tone_curve = Some(ToneCurve::PchipCbrt3 { points: case.points.clone() });
        let results = probe("curve_draw", &inputs, &grade);
        let tangents = rawshim::light::curve_tangents(&case.points);
        for (input, output) in inputs.iter().zip(results) {
            let code = CurveCode::of_white_ratio(Gain::of_ratio(f64::from(input[0])));
            let expected = rawshim::light::curve_at(&case.points, &tangents, code).white_ratio().raw();
            assert!((f64::from(output[0]) - expected).abs() < 2e-5, "{} != {expected}", output[0]);
        }
    }
}

#[test]
fn subfloor_edits_keep_colour_and_exposed_grey_is_the_contrast_pivot() {
    let mut colour = HdrColour::identity();
    colour.curve = vec![[0.0, 0.02], [0.3, 0.3], [1.0, 1.0]];
    colour.exposure = Stops::measured(1.0);
    let samples: Vec<[f32; 4]> = [0.01, 0.0199, 0.0201, 0.025].iter().map(|&code| {
        let luma = CurveCode::from_raw(code).white_ratio().raw();
        let rgb = [1.4, 0.8, 0.4];
        let weighted = 0.2627 * rgb[0] + 0.6780 * rgb[1] + 0.0593 * rgb[2];
        [rgb[0] as f32 * (luma / weighted) as f32, rgb[1] as f32 * (luma / weighted) as f32, rgb[2] as f32 * (luma / weighted) as f32, 0.0]
    }).collect();
    let mut grade = probe_grade(samples.len());
    grade.colour = Some(&colour);
    let rest = probe("curve_draw", &samples, &grade);
    grade.exposure = Some(Stops::measured(1.01));
    let moved = probe("curve_draw", &samples, &grade);
    for (before, after) in rest.iter().zip(moved) {
        for c in 0..3 { assert!((after[c] / before[c] - 1.0).abs() < 0.04); }
        assert!((after[0] / after[1] - before[0] / before[1]).abs() < 1e-5);
        assert!((after[2] / after[1] - before[2] / before[1]).abs() < 1e-5);
    }
    colour.curve = rawshim::light::IDENTITY_CURVE.to_vec();
    let grey = (rawshim::light::PIVOT * Gain::of(colour.exposure)).raw() as f32;
    for contrast in [-100.0, 100.0] {
        let mut grade = probe_grade(1);
        grade.colour = Some(&colour);
        grade.adjust.contrast = contrast;
        let result = probe("curve_draw", &[[grey, grey, grey, 0.0]], &grade);
        assert!((result[0][0] - grey).abs() < 1e-6);
    }
}

#[test]
fn shader_knee_preserves_diffuse_light_and_lands_the_peak_monotonically() {
    assert!(include_str!("../../../slang/prelude.slang").contains("KNEE_UNDER_WHITE = { -0.32 }"));
    for peak in [50.0f32, 203.0, 1000.0] {
        let white = 203.0f32;
        let floor = white.min(peak) * 2.0f32.powf(-0.32);
        let mut samples: Vec<[f32; 4]> = (0..=256).map(|i| [5000.0 * i as f32 / 256.0, 5000.0, peak, white]).collect();
        samples.extend([[floor * 0.5, 5000.0, peak, white], [floor, 5000.0, peak, white]]);
        let results = probe("knee_probe", &samples, &probe_grade(samples.len()));
        assert!(results[..257].windows(2).all(|p| p[0][0] <= p[1][0] + 1e-3));
        assert!((results[256][0] - peak).abs() < peak * 1e-4);
        for (input, output) in samples[257..].iter().zip(&results[257..]) {
            assert!((output[0] - input[0]).abs() < 1e-3);
            assert!((output[0] - output[1]).abs() < 1e-3);
        }
    }
}
