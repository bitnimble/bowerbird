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
    // The entry point takes bindings 5 and 6, which `colour` does not declare and only `peak`
    // would - so this composition is `FRAME`'s rather than `PEAK`'s.
    composed(PROBE)
}

fn read_wgsl(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../web/src/features/raw_edit/gpu/wgsl")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// `prelude`, `edit`, `adjust`, `colour`, then whichever module is being asked about - which
/// is how `shaders.ts` composes both `FRAME` and `PEAK`.
fn composed(tail: &str) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}",
        read_wgsl("prelude.wgsl"),
        read_wgsl("edit.wgsl"),
        read_wgsl("adjust.wgsl"),
        read_wgsl("colour.wgsl"),
        tail,
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

/// `EDIT_UNIFORM_FLOATS` in `shaders.ts`, field for field in `struct Edit`'s order.
///
/// Written here rather than taken from `gpu::Grade` because a probe's settings are not a
/// grade's: white, exposure and reference are all 1 so the shader is asked for the colour
/// transform in the model's own units, with no tone anchor or roll-off scaling in the way.
fn uniform(colour: &HdrColour, peak_samples: u32) -> Vec<u8> {
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
    words.push(peak_samples);
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
    // The geometry, at its identity: this probe asks about the colour transform, and a crop
    // is not part of one. `geometry_at` returns its argument untouched on these values.
    for value in [0.0, 0.0, 1.0, 1.0, 0.0] {
        f_push(&mut words, value);
    }
    words.push(0); // rotate
    words.push(PROBE_WIDTH); // output_width
    words.push(1); // output_height
    // The keystone, also at its identity, and `has_keystone` clear so nothing reads the eight.
    for _ in 0..8 {
        f_push(&mut words, 0.0);
    }
    words.push(0); // has_keystone
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
    let edits = buffer(&uniform(&colour, 1), wgpu::BufferUsages::UNIFORM);
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
            wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
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

/// Bins four values the entry points can genuinely be handed, through the shipped `bin_of`.
///
/// Fed through the histogram's own words because a WGSL const expression cannot hold either of
/// the two that matter: `1.0 / 0.0` is a compile error and `sqrt(-1.0)` folds.
const BIN_PROBE: &str = r#"
@compute @workgroup_size(1)
fn probe_bins() {
  for (var i = 0u; i < 4u; i = i + 1u) {
    peak_out[i] = f32(bin_of(bitcast<f32>(atomicLoad(&histogram[i]))));
  }
}
"#;

/// `peak.wgsl`'s own constants, which the shader holds as `const` for Safari's sake.
const PEAK_BINS: u32 = 8192;
const LOG_LOW: f32 = -14.0;
const LOG_SPAN: f32 = 28.0;

/// The value a bin stands for, in units of reference white - `bin_centre`, said here.
fn bin_centre(bin: u32) -> f32 {
    (LOG_LOW + ((bin as f32 + 0.5) / PEAK_BINS as f32) * LOG_SPAN).exp2()
}

/// The scan that turns the histogram into the scene peak, run on the histograms that break it.
///
/// The peak is an *input* to the grade and everything is clamped to it, so a scan that answers
/// too low does not shade the picture differently - it flattens the whole frame onto that
/// value. The floor is one nit, which against 203-nit white is a black rectangle with the
/// shape of a photograph faintly in it.
///
/// The case that reaches it is a histogram holding fewer samples than the rank being asked
/// for, which is what the editor's candidates are: they are counted against the frame's
/// `peak_samples` while holding only the brightest few thousand pixels of it. Neither of the
/// scan's two loops could reach an unreachable rank, so both fell through with the bin at
/// zero. Here as WGSL against a hand-built histogram because that is what it is - no frame,
/// no decode and no browser can say anything about a scan over 8192 counts.
#[test]
fn the_peak_scan_answers_a_sample_shorter_than_its_rank() {
    let Some(shipped) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the peak's scan was not run.");
        return;
    };
    let (device, queue) = (&shipped.device, &shipped.queue);

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("peak"),
        source: wgpu::ShaderSource::Wgsl(composed(&read_wgsl("peak.wgsl")).into()),
    });
    // Derived from what `quantile` actually reads, which is the histogram, the peak, the
    // candidates and the uniform. An explicit layout would have to name every binding the
    // module declares, and the colour transform's textures are nothing to do with this.
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("quantile"),
        layout: None,
        module: &module,
        entry_point: Some("quantile"),
        compilation_options: Default::default(),
        cache: None,
    });
    let layout = pipeline.get_bind_group_layout(0);

    // Two stops above reference white, which is a highlight rather than the floor the failure
    // returns - so the two answers cannot be confused.
    let bright = ((2.0 - LOG_LOW) / LOG_SPAN * PEAK_BINS as f32) as u32;
    let dim = ((-3.0 - LOG_LOW) / LOG_SPAN * PEAK_BINS as f32) as u32;

    // `peak_samples` is the frame's, so the rank is 100 either way; what changes is how much
    // of the frame the histogram in front of the scan actually holds.
    let cases: [(&str, Vec<(u32, u32)>); 3] = [
        ("a whole frame", vec![(dim, 999_900), (bright, 100)]),
        ("candidates, and fewer of them than the rank", vec![(bright, 10)]),
        ("a single sample", vec![(bright, 1)]),
    ];

    for (name, counts) in cases {
        let mut histogram = vec![0u32; PEAK_BINS as usize];
        for (bin, count) in &counts {
            histogram[*bin as usize] = *count;
        }
        let bytes: Vec<u8> = histogram.iter().flat_map(|c| c.to_le_bytes()).collect();
        let init = |contents: &[u8], usage: wgpu::BufferUsages| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents,
                usage,
            })
        };
        let histogram = init(&bytes, wgpu::BufferUsages::STORAGE);
        let peak = init(
            &[0u8; 16],
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        );
        // Non-zero, which is what a tick's is: the threshold below the peak is the open's
        // business and `quantile` skips it once anything has been collected.
        let candidates = init(&1u32.to_le_bytes(), wgpu::BufferUsages::STORAGE);
        // Reference white is 1.0 in this uniform, so the peak comes back in units of it.
        let edits = init(&uniform(&model(), 1_000_000), wgpu::BufferUsages::UNIFORM);
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: 16,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("peak"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: histogram.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: peak.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 8, resource: candidates.as_entire_binding() },
            ],
        });

        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        encoder.copy_buffer_to_buffer(&peak, 0, &readback, 0, 16);
        queue.submit([encoder.finish()]);

        let slice = readback.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::PollType::wait_indefinitely()).expect("the dispatch finished");
        let mapped = slice.get_mapped_range().expect("the readback mapped");
        let got = f32::from_le_bytes([mapped[0], mapped[1], mapped[2], mapped[3]]);

        // The brightest bin holding anything, in all three: with a whole frame the rank of 100
        // lands in it, and with less than that in front of the scan it is the only answer there
        // is. A bin is 0.0034 of a stop, so this is exact to the bin.
        let want = bin_centre(bright);
        assert!(
            (got - want).abs() / want < 1e-3,
            "{name}: the scan answered {got} where the brightest bin is {want}",
        );
    }
}

/// Every value the histogram bins lands somewhere defined, on any host.
///
/// `u32(x)` is undefined in WGSL for a NaN and for anything past the type's range, and the
/// colour transform can hand `bin_of` both: a division in the tone curve, a lattice fetch at
/// an out-of-range coordinate. Undefined there is not a rounding difference - the driver may
/// put it at the top of the histogram, where it shifts the quantile, or at the bottom, where
/// it does not - and this is the one measurement a rendition and the editor have to agree on
/// to the bin, since every pixel is then clamped to what it says.
#[test]
fn the_histogram_bins_a_nan_and_an_infinity_somewhere_defined() {
    let Some(shipped) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so `bin_of` was not run.");
        return;
    };
    let (device, queue) = (&shipped.device, &shipped.queue);

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("peak"),
        source: wgpu::ShaderSource::Wgsl(
            format!("{}\n{}", composed(&read_wgsl("peak.wgsl")), BIN_PROBE).into(),
        ),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("probe_bins"),
        layout: None,
        module: &module,
        entry_point: Some("probe_bins"),
        compilation_options: Default::default(),
        cache: None,
    });

    let fed: [f32; 4] = [f32::NAN, f32::INFINITY, 0.0, 1.0];
    let bytes: Vec<u8> = fed.iter().flat_map(|v| v.to_bits().to_le_bytes()).collect();
    let init = |contents: &[u8], usage: wgpu::BufferUsages| {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents, usage })
    };
    let histogram = init(&bytes, wgpu::BufferUsages::STORAGE);
    let peak = init(&[0u8; 16], wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC);
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: 16,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    // The two `bin_of` reaches, which is all the derived layout carries: it takes no uniform
    // and touches no candidate.
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("bins"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 5, resource: histogram.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: peak.as_entire_binding() },
        ],
    });

    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    encoder.copy_buffer_to_buffer(&peak, 0, &readback, 0, 16);
    queue.submit([encoder.finish()]);

    let slice = readback.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    device.poll(wgpu::PollType::wait_indefinitely()).expect("the dispatch finished");
    let mapped = slice.get_mapped_range().expect("the readback mapped");
    let got: Vec<u32> = mapped
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as u32)
        .collect();

    // A NaN and a black pixel at the bottom, where they cannot lift the quantile off a frame
    // they say nothing about; an infinity at the top, which is where a value past the range
    // belongs and is the answer the clamp gives rather than the one the conversion would.
    assert_eq!(got[0], 0, "a NaN binned at {}", got[0]);
    assert_eq!(got[1], PEAK_BINS - 1, "an infinity binned at {}", got[1]);
    assert_eq!(got[2], 0, "black binned at {}", got[2]);
    // Reference white is the middle of a range that spans fourteen stops either side of it.
    assert_eq!(got[3], PEAK_BINS / 2, "reference white binned at {}", got[3]);
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
