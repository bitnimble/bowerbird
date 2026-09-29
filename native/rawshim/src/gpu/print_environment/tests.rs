use super::*;
use crate::print::Scene;
use crate::print::environment::ENVIRONMENTS;

fn floats(
    gpu: &Gpu,
    mut recording: super::super::Recording<'_>,
    from: &super::super::Buffer,
    count: usize,
) -> Vec<f32> {
    let bytes = (count * 4) as u64;
    let readback = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("print environment readback"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    recording
        .encoder()
        .copy_buffer_to_buffer(from, 0, &readback, 0, bytes);
    recording.submit();
    pollster::block_on(super::super::read_back(gpu, &readback, |bytes| {
        bytes
            .chunks_exact(4)
            .map(|word| f32::from_le_bytes(word.try_into().expect("a float")))
            .collect()
    }))
    .expect("a readback")
}

/// `print_environment_probe.slang`'s `measure` over the environment's source map, and its width.
fn measured(gpu: &Gpu, environment: Environment) -> (Vec<f32>, u32) {
    let map = environment::decode(&environment.bytes().expect("the map")).expect("a Radiance file");
    let device = gpu.describing();
    let mut recording = gpu.record();
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("print environment measure"),
        contents: &build_words((map.width, map.height), &map, &environment.source()),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let texels = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("print environment texels"),
        contents: &map
            .texels
            .iter()
            .flat_map(|texel| texel.to_le_bytes())
            .collect::<Vec<_>>(),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let output = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("print environment measured"),
        size: 28,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("print environment measure"),
        entries: &[
            Binding::Uniform.entry(0),
            Binding::Storage { read_only: true }.entry(1),
            Binding::Storage { read_only: false }.entry(2),
        ],
    });
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("print environment measure"),
        source: wgpu::ShaderSource::Wgsl(
            include_str!(concat!(
                env!("OUT_DIR"),
                "/wgsl/print_environment_probe.wgsl"
            ))
            .into(),
        ),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("print environment measure"),
        layout: Some(
            &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("print environment measure"),
                bind_group_layouts: &[Some(&layout)],
                ..Default::default()
            }),
        ),
        module: &module,
        entry_point: Some("measure"),
        compilation_options: Default::default(),
        cache: None,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("print environment measure"),
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: texels.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: output.as_entire_binding(),
            },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    (floats(gpu, recording, &output, 7), map.width)
}

#[test]
fn each_environments_lamp_is_the_light_it_takes_out_of_its_map() {
    let gpu = super::super::device().expect("print requires Vulkan");
    for environment in ENVIRONMENTS {
        let (lamp, width) = measured(gpu, environment);
        let scene = Scene::default().in_environment(environment);
        let map = gpu.print_environment(environment).expect("the map");
        let buffer = gpu.print_light_calibration(
            scene.light_parameters(),
            scene.light_temperature_kelvin as f32,
            &map,
        );
        let calibration = floats(gpu, gpu.record(), &buffer, 7);

        let turned =
            f64::from(environment.source().turn(width)) / f64::from(width) * std::f64::consts::TAU;
        let (x, y, z) = (f64::from(lamp[0]), f64::from(lamp[1]), f64::from(lamp[2]));
        let (around, flat) = (x.atan2(-z) - turned, x.hypot(z));
        let arrives = [flat * around.sin(), y, -flat * around.cos()];
        let hangs = [
            scene.light_across.raw(),
            scene.light_height.raw(),
            scene.light_forward.raw(),
        ];
        let cosine = arrives.iter().zip(hangs).map(|(a, h)| a * h).sum::<f64>()
            / (arrives.iter().map(|a| a * a).sum::<f64>().sqrt()
                * hangs.iter().map(|h| h * h).sum::<f64>().sqrt());
        assert!(
            cosine.acos().to_degrees() < 1.0,
            "{environment:?}'s lamp hangs {}° from its light",
            cosine.acos().to_degrees()
        );

        // The room's illuminance on a sheet facing the reader, in the source map's own units.
        let facing = 1.0 / (f64::from(calibration[6]) * f64::from(STORED_SCALE));
        let ratio = f64::from(lamp[3]) / facing;
        let preset = scene.key_lux.raw() / scene.fill_lux.raw();
        assert!(
            (ratio / preset - 1.0).abs() < 0.1,
            "{environment:?}: its light is {ratio} of the room, the preset {preset}"
        );

        let tint = [lamp[4], lamp[5], lamp[6]];
        let luma = tint
            .iter()
            .zip(crate::hdr_fit::LUMA)
            .map(|(value, weight)| f64::from(*value) * weight)
            .sum::<f64>();
        for (channel, drawn) in tint.iter().zip(&calibration[2..5]) {
            // The lamp is a temperature with no tint, and the hotel's downlights sit 0.064 off any of them.
            assert!(
                (f64::from(*channel) / luma - f64::from(*drawn)).abs() < 0.07,
                "{environment:?}'s light is {tint:?} over {luma}, its lamp {:?}",
                &calibration[2..5]
            );
        }
    }
}

#[test]
fn another_lamp_in_the_same_room_calibrates_as_if_from_scratch() {
    let gpu = super::super::device().expect("print requires Vulkan");
    let words = (crate::print::CALIBRATION_BYTES / 4) as usize;
    let scene = Scene::default().in_environment(Environment::Hotel);
    let map = gpu.print_environment(scene.environment).expect("the map");
    let first = gpu.print_light_calibration(
        scene.light_parameters(),
        scene.light_temperature_kelvin as f32,
        &map,
    );
    let moved = Scene {
        yaw_degrees: 30.0,
        pitch_degrees: -20.0,
        light_angular_degrees: 6.0,
        light_temperature_kelvin: 2700.0,
        ..scene
    };
    let (parameters, temperature) = (
        moved.light_parameters(),
        moved.light_temperature_kelvin as f32,
    );
    let fresh = floats(
        gpu,
        gpu.record(),
        &gpu.print_light_calibration(parameters, temperature, &map),
        words,
    );
    let copied = floats(
        gpu,
        gpu.record(),
        &gpu.print_lamp_calibration(&first, parameters, temperature, &map),
        words,
    );
    assert_ne!(
        fresh[..6],
        floats(gpu, gpu.record(), &first, words)[..6],
        "the lamp moved"
    );
    assert_eq!(copied, fresh);
}
