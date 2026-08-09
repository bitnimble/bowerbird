//! The editor's colour shader, run against this crate's colour model.
//!
//! `gpu_fixture.rs` pins the bytes the CPU produces; `web/e2e/gpu_parity.spec.ts` asserts
//! the browser reproduces them. Between the two sat the thing that actually breaks - the
//! WGSL arithmetic - and asking about it meant a Playwright run: two cold servers, a Vite
//! dev build and a headless Chromium, for a question that is one dispatch wide.
//!
//! So the shader is compiled and run here, from the same files the app imports, and its
//! answers are compared to `hdr_fit`'s directly. What stays in Playwright is the
//! TypeScript that wires it up - the payload deinterleave, the bind groups, the passes -
//! which is a different failure and needs the real pipeline to say anything about.
//!
//! Skipped where no Vulkan adapter answers, loudly rather than silently: a parity test
//! that quietly passes because it never ran is the arrangement this file exists to end.

use rawshim::hdr_fit::{self, ChromaMap, HdrColour, TRUST_CEILING};
use wgpu::util::DeviceExt;

/// The composition `shaders.ts` performs, from the same files, plus an entry point that
/// exists only here.
///
/// Read rather than vendored, so a change to the shader is a change to this test. A copy
/// would pass forever against whatever it was copied from.
fn source() -> String {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../web/src/features/raw_edit/gpu/wgsl");
    let read = |name: &str| {
        std::fs::read_to_string(dir.join(name))
            .unwrap_or_else(|e| panic!("{}: {e}", dir.join(name).display()))
    };
    // `prelude`, `tick`, `adjust`, `colour` - the order `FRAME` and `PEAK` use. The entry
    // point takes bindings 5 and 6, which `colour` does not declare and only `peak` would.
    format!(
        "{}\n{}\n{}\n{}\n{}",
        read("prelude.wgsl"),
        read("tick.wgsl"),
        read("adjust.wgsl"),
        read("colour.wgsl"),
        PROBE,
    )
}

const PROBE: &str = r#"
@group(0) @binding(5) var<storage, read> probe_in: array<f32>;
@group(0) @binding(6) var<storage, read_write> probe_out: array<f32>;

@compute @workgroup_size(64)
fn probe(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i * 3u + 2u >= arrayLength(&probe_in)) { return; }
  let level = vec3f(probe_in[i * 3u], probe_in[i * 3u + 1u], probe_in[i * 3u + 2u]);
  // The middle of the frame, and it does not matter which: the presence sliders are the only
  // reader of this and the probe leaves all three at zero, so nothing samples the blur.
  let out = matched_nits(level, vec2f(0.5));
  probe_out[i * 3u] = out.r;
  probe_out[i * 3u + 1u] = out.g;
  probe_out[i * 3u + 2u] = out.b;
}
"#;

/// A colour model with every stage off its identity, so a shader that dropped one is
/// caught rather than flattered.
///
/// The lattice's nodes differ on all three axes and its lightness gain is off 1 at every
/// node, which is what makes a reader that swapped the chroma axes, mis-scaled the level
/// axis or lost the fifth value answer differently from this.
fn model() -> HdrColour {
    let mut colour = HdrColour::identity();
    for (channel, curve) in colour.curves.iter_mut().enumerate() {
        let gain = 1.0 + 0.06 * (channel as f64 - 1.0);
        let bend = 2.2 + 0.4 * channel as f64;
        let last = (curve.len() - 1) as f64;
        let full = 1.0 - (-bend).exp();
        for (bin, value) in curve.iter_mut().enumerate() {
            let x = bin as f64 / last;
            *value = TRUST_CEILING * gain * (1.0 - (-bend * x).exp()) / full;
        }
    }
    colour.matrix = [[0.92, 0.06, 0.02], [0.05, 0.90, 0.05], [0.01, 0.07, 0.92]];
    colour.saturation = 1.08;
    colour.chroma = Some(ChromaMap::from_nodes(|x, y, z| {
        let scale = 1.04 + 0.03 * x as f64 - 0.02 * y as f64 + 0.05 * z as f64;
        let skew = 0.02 * (x as f64 - y as f64);
        let lift = 1.0 + 0.015 * (x as f64 - 2.0) - 0.01 * (y as f64 - 2.0) + 0.004 * z as f64;
        // The luma-to-chroma pair, which is the only part of a node that acts at `d = 0`.
        [scale, skew, -skew, scale * 0.98, 0.004 * (x as f64 - 2.0), -0.003 * (y as f64 - 2.0), lift,
         // The chroma-to-lightness pair, off zero at every node so a reader that dropped
         // either or packed them in the wrong slot cannot answer correctly.
         0.05 * (x as f64 - 2.0), -0.04 * (y as f64 - 2.0)]
    }));
    colour
}

/// Colours spanning what the lattice indexes: neutrals up the grey axis, and saturated
/// ones out to the edge of every chroma node, at levels from the toe to the ceiling.
fn probes() -> Vec<[f32; 3]> {
    let mut out = Vec::new();
    for level in [0.02f64, 0.05, 0.12, 0.25, 0.4, 0.6, 0.8, 0.88] {
        for spread in [0.0f64, 0.1, 0.25, 0.45, 0.7] {
            for hue in 0..6 {
                let angle = hue as f64 * std::f64::consts::TAU / 6.0;
                let v = [
                    level * (1.0 + spread * angle.cos()),
                    level * (1.0 + spread * (angle + 2.1).cos()),
                    level * (1.0 + spread * (angle + 4.2).cos()),
                ];
                // Above the ceiling the tone stage takes its shared-gain branch, which is a
                // different path in both implementations and worth reaching, but a negative
                // has no meaning on either side.
                out.push([
                    v[0].max(0.0) as f32,
                    v[1].max(0.0) as f32,
                    v[2].max(0.0) as f32,
                ]);
            }
        }
    }
    out
}

/// `TICK_UNIFORM_FLOATS` in `shaders.ts`, field for field in `struct Tick`'s order.
///
/// Written here rather than taken from `gpu::Grade` because a probe's settings are not a
/// grade's: white, exposure and reference are all 1 so the shader is asked for the colour
/// transform in the model's own units, with no tone anchor or roll-off scaling in the way.
fn uniform(colour: &HdrColour) -> Vec<u8> {
    let shape = colour.chroma.as_ref().map(|m| m.shape());
    let shape = shape.as_ref();
    let mut words: Vec<u32> = Vec::new();
    // Written as a flat list of words so the order is checkable against the struct rather
    // than hidden behind a builder.
    words.push(PROBE_WIDTH);
    words.push(1); // height
    f_push(&mut words, 1.0); // white: the probe feeds scene levels directly
    f_push(&mut words, 1.0); // source_level
    f_push(&mut words, 1.0); // reference: nits per unit, so the compare is in the CPU's units
    f_push(&mut words, 1.0); // peak
    f_push(&mut words, 0.0); // exposure, in stops: none of it, so the probe sees the base curve
    words.push(0); // pad0
    words.push(1); // matched
    f_push(&mut words, colour.saturation as f32);
    words.push(u32::from(colour.chroma.is_some()));
    words.push(colour.curves[0].len() as u32);
    f_push(&mut words, TRUST_CEILING as f32);
    words.push(shape.map_or(2, |s| s.chroma_count as u32));
    words.push(shape.map_or(2, |s| s.level_count as u32));
    f_push(&mut words, shape.map_or(0.0, |s| s.chroma_low[0] as f32));
    f_push(&mut words, shape.map_or(1.0, |s| s.chroma_scale[0] as f32));
    f_push(&mut words, shape.map_or(0.0, |s| s.chroma_low[1] as f32));
    f_push(&mut words, shape.map_or(1.0, |s| s.chroma_scale[1] as f32));
    f_push(&mut words, shape.map_or(1.0, |s| s.level_scale as f32));
    f_push(&mut words, 203.0); // sdr_white
    words.push(1); // row_stride
    words.push(1); // peak_samples
    // WGSL puts a `vec2f` on a multiple of eight, and the scalars above end on 84. The
    // struct does not name this word - `pad0` earlier is a different one, named because it
    // is reusable - so it has to be written here or every field after it lands short.
    words.push(0);
    for _ in 0..6 {
        f_push(&mut words, 0.0); // region_origin, region_size, canvas_size
    }
    words.push(0); // max_lod
    words.push(0); // pad
    // The reader's sliders, all zero: this probe compares the *colour transform* against the
    // model it mirrors, and any of these set would be comparing an edit of it instead. The
    // last four are the white balance pair and the illuminant it moves from; zero there is
    // "as shot", which is the same statement.
    for _ in 0..14 {
        f_push(&mut words, 0.0);
    }
    // `balance_set`: neither half of the pair is set, so the shader reads the frame's own
    // illuminant - which is zero here, and it leaves the balance alone. Written rather than
    // left to the padding below, which happens to be zero today and is not a promise.
    words.push(0);
    // WGSL binds a uniform struct at its size rounded up to 16 bytes, so a buffer holding
    // exactly the fields is rejected as too small. Same rule as `gpu::uniform`.
    while words.len() % 4 != 0 {
        words.push(0);
    }
    words.iter().flat_map(|w| w.to_le_bytes()).collect()
}

const PROBE_WIDTH: u32 = 1;

fn f_push(words: &mut Vec<u32>, v: f32) {
    words.push(v.to_bits());
}

#[test]
fn the_colour_shader_agrees_with_the_model_it_mirrors() {
    // The crate's own device and its own lattice packing, not a copy of either. The
    // packing in particular has to be the shipped one: it splits the node across two
    // volumes and stores the luma gain as a deviation from 1, and a test that reimplemented
    // that would have agreed with itself through the f16 bug that cost a day.
    let Some(shipped) = rawshim::gpu::device() else {
        eprintln!(
            "SKIPPED: no adapter answered, so the colour shader was not run. \
             This test is the only thing checking the WGSL arithmetic outside Playwright.",
        );
        return;
    };
    let (device, queue) = (&shipped.device, &shipped.queue);

    let colour = model();
    let inputs = probes();
    let flat: Vec<f32> = inputs.iter().flatten().copied().collect();

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("colour"),
        source: wgpu::ShaderSource::Wgsl(source().into()),
    });

    let (chroma, chroma_luma, chroma_tint) = shipped.lattice(&colour);

    let curves = shipped.curves(&colour);

    let buffer = |contents: &[u8], usage: wgpu::BufferUsages| {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents,
            usage,
        })
    };
    let matrix_data: Vec<u8> = colour
        .matrix
        .iter()
        .flatten()
        .flat_map(|v| (*v as f32).to_le_bytes())
        .collect();
    let matrix = buffer(&matrix_data, wgpu::BufferUsages::STORAGE);
    // Declared by `colour.wgsl` and never read by the probe, but an explicit layout has to
    // supply everything the module declares.
    let frame = buffer(&[0u8; 16], wgpu::BufferUsages::STORAGE);
    let balance = buffer(&[0u8; 48], wgpu::BufferUsages::STORAGE);
    let tick = buffer(&uniform(&colour), wgpu::BufferUsages::UNIFORM);
    let probe_in = buffer(
        &flat.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>(),
        wgpu::BufferUsages::STORAGE,
    );
    let out_bytes = (flat.len() * 4) as u64;
    let probe_out = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("out"),
        size: out_bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: out_bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let sampler = shipped.sampler();

    let stage = wgpu::ShaderStages::COMPUTE;
    let entries = [
        wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: stage,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        },
        storage_entry(1, true),
        wgpu::BindGroupLayoutEntry {
            binding: 2,
            visibility: stage,
            // What an `r32float` view is without `float32-filterable`, matching the client.
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        },
        texture3d_entry(3),
        storage_entry(4, true),
        storage_entry(5, true),
        storage_entry(6, false),
        wgpu::BindGroupLayoutEntry {
            binding: 7,
            visibility: stage,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        },
        texture3d_entry(10),
        texture3d_entry(11),
        // `adjust.wgsl`'s blur. Statically referenced by `adjusted` whatever the sliders say,
        // so the layout has to carry it even though this probe never reads a texel of it.
        wgpu::BindGroupLayoutEntry {
            binding: 13,
            visibility: stage,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        },
        // `adjust.wgsl`'s balance matrix, likewise referenced whatever the pair says.
        storage_entry(14, true),
    ];
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("colour"),
        entries: &entries,
    });
    let chroma_view = chroma.create_view(&wgpu::TextureViewDescriptor::default());
    let luma_view = chroma_luma.create_view(&wgpu::TextureViewDescriptor::default());
    let tint_view = chroma_tint.create_view(&wgpu::TextureViewDescriptor::default());
    let curves_view = curves.create_view(&wgpu::TextureViewDescriptor::default());
    let detail = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("detail"),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let detail_view = detail.create_view(&wgpu::TextureViewDescriptor::default());
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("colour"),
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: tick.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: frame.as_entire_binding() },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::TextureView(&curves_view),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: wgpu::BindingResource::TextureView(&chroma_view),
            },
            wgpu::BindGroupEntry { binding: 4, resource: matrix.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: probe_in.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: probe_out.as_entire_binding() },
            wgpu::BindGroupEntry {
                binding: 7,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
            wgpu::BindGroupEntry {
                binding: 11,
                resource: wgpu::BindingResource::TextureView(&tint_view),
            },
            wgpu::BindGroupEntry {
                binding: 10,
                resource: wgpu::BindingResource::TextureView(&luma_view),
            },
            wgpu::BindGroupEntry {
                binding: 13,
                resource: wgpu::BindingResource::TextureView(&detail_view),
            },
            wgpu::BindGroupEntry { binding: 14, resource: balance.as_entire_binding() },
        ],
    });

    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("colour"),
        bind_group_layouts: &[Some(&layout)],
        ..Default::default()
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("probe"),
        layout: Some(&pipeline_layout),
        module: &module,
        entry_point: Some("probe"),
        compilation_options: Default::default(),
        cache: None,
    });

    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(inputs.len().div_ceil(64) as u32, 1, 1);
    }
    encoder.copy_buffer_to_buffer(&probe_out, 0, &readback, 0, out_bytes);
    queue.submit([encoder.finish()]);

    let slice = readback.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    device.poll(wgpu::PollType::wait_indefinitely()).expect("the dispatch finished");
    let mapped = slice.get_mapped_range().expect("the readback mapped");
    let got: Vec<f32> = mapped
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();

    // The bound is f16, which is what the lattice is stored as. Relative, because the
    // values span the toe to well past diffuse white and one absolute number would be
    // meaningless at both ends - and against the larger of the two so a channel landing
    // near zero cannot divide the comparison into nonsense.
    let mut worst = 0.0f64;
    let mut at = 0usize;
    for (i, level) in inputs.iter().enumerate() {
        let want = hdr_fit::apply_hdr_colour(
            &colour,
            f64::from(level[0]),
            f64::from(level[1]),
            f64::from(level[2]),
        );
        for c in 0..3 {
            let (a, b) = (f64::from(got[i * 3 + c]), want[c]);
            let scale = a.abs().max(b.abs()).max(1e-4);
            let error = (a - b).abs() / scale;
            if error > worst {
                worst = error;
                at = i;
            }
        }
    }
    assert!(
        worst < 2e-3,
        "the shader and the model disagree by {worst:.5} relative at {:?}; \
         f16 on the lattice is worth about 5e-4, so this is a difference in what they do",
        inputs[at],
    );
}

fn storage_entry(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn texture3d_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D3,
            multisampled: false,
        },
        count: None,
    }
}
