//! The base frame's own stages, on the GPU.
//!
//! Everything between the demosaic and the grade that both a rendition and the editor's open run:
//! the coding, the filters that are not the sharpen, the warp, and the two whole-frame numbers the
//! rest of them read. Measured on a 61MP frame, and this is why they are worth moving at all -
//! `open code, defringe` 1170ms, `open lens warp` 639ms and `open noise measure` 1021ms, against
//! a decode that is already on the GPU either side of them.
//!
//! The levels quantile is the one stage that stayed behind, and `tone::levels` says why: threaded
//! it is 12ms, which no upload-sharing kernel can beat by enough to be worth wiring.
//!
//! **The prize is not the stage timings, it is the two transfers they sit between.** RCD leaves
//! the frame in VRAM and reads it back; the grade uploads it again. At 61MP that is 361MB each
//! way for the privilege of running pointwise arithmetic on a CPU. Every stage that moves here
//! brings those two closer together, and the last one deletes them.
//!
//! Its own module rather than more of `gpu.rs` for the reason `demosaic.rs` is its own: the
//! shaders here never cross to a client - the frame reaches it already coded, filtered and warped
//! - so they live in `src/wgsl` beside RCD rather than under `web/` with the ones both hosts read.

use wgpu::util::DeviceExt;

/// `prelude.wgsl` in front, so `pq` is the curve `colour.wgsl` inverts rather than a second copy
/// of the same five constants.
fn source() -> String {
    format!(
        "{}\n{}\n{}",
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/prelude.wgsl"),
        include_str!("wgsl/lanes.wgsl"),
        include_str!("wgsl/base.wgsl"),
    )
}

pub struct Base {
    layout: wgpu::BindGroupLayout,
    encode: wgpu::ComputePipeline,
    defringe_layout: wgpu::BindGroupLayout,
    defringe_luma: wgpu::ComputePipeline,
    defringe_apply: wgpu::ComputePipeline,
    warp_layout: wgpu::BindGroupLayout,
    warp: wgpu::ComputePipeline,
    noise_layout: wgpu::BindGroupLayout,
    noise_luma: wgpu::ComputePipeline,
    noise_blocks: wgpu::ComputePipeline,
    defocus_layout: wgpu::BindGroupLayout,
    defocus_bins: wgpu::ComputePipeline,
    defocus_residuals: wgpu::ComputePipeline,
}

pub fn device(gpu: &'static crate::gpu::Gpu) -> Option<&'static Base> {
    static BUILT: std::sync::OnceLock<Option<Base>> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Base::new(gpu)).as_ref()
}

impl Base {
    fn new(gpu: &crate::gpu::Gpu) -> Option<Base> {
        let device = &gpu.device;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("base"),
            source: wgpu::ShaderSource::Wgsl(source().into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("base"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("base"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let encode = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("encode_base"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("encode_base"),
            compilation_options: Default::default(),
            cache: None,
        });
        let defringe_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("defringe"),
            source: wgpu::ShaderSource::Wgsl(
                format!(
                    "{}\n{}",
                    include_str!("wgsl/lanes.wgsl"),
                    include_str!("wgsl/defringe.wgsl"),
                )
                .into(),
            ),
        });
        let defringe_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("defringe"),
            entries: &[
                uniform_entry(0),
                storage_entry(1),
                storage_entry(2),
            ],
        });
        let defringe_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("defringe"),
                bind_group_layouts: &[Some(&defringe_layout)],
                immediate_size: 0,
            });
        let defringe = |entry: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&defringe_pipeline_layout),
                module: &defringe_module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };

        // The falloff is a gain folded into PQ's intermediate, so the warp needs the same
        // constants the coding does.
        let warp_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("warp"),
            source: wgpu::ShaderSource::Wgsl(
                format!(
                    "{}\n{}\n{}",
                    include_str!("../../../web/src/features/raw_edit/gpu/wgsl/prelude.wgsl"),
                    include_str!("wgsl/lanes.wgsl"),
                    include_str!("wgsl/warp.wgsl"),
                )
                .into(),
            ),
        });
        let warp_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("warp"),
            entries: &[
                uniform_entry(0),
                storage_entry(1),
                storage_entry(2),
                storage_entry(3),
                storage_entry(4),
            ],
        });
        let warp_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("warp"),
            bind_group_layouts: &[Some(&warp_layout)],
            immediate_size: 0,
        });
        let warp = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("warp_lens"),
            layout: Some(&warp_pipeline_layout),
            module: &warp_module,
            entry_point: Some("warp_lens"),
            compilation_options: Default::default(),
            cache: None,
        });

        let noise_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("noise"),
            source: wgpu::ShaderSource::Wgsl(
                format!(
                    "{}\n{}",
                    include_str!("wgsl/lanes.wgsl"),
                    include_str!("wgsl/noise.wgsl"),
                )
                .into(),
            ),
        });
        let noise_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("noise"),
            entries: &[
                uniform_entry(0),
                storage_entry(1),
                storage_entry(2),
                storage_entry(3),
            ],
        });
        let noise_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("noise"),
            bind_group_layouts: &[Some(&noise_layout)],
            immediate_size: 0,
        });
        let noise = |entry: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&noise_pipeline_layout),
                module: &noise_module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };

        let defocus_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("defocus"),
            source: wgpu::ShaderSource::Wgsl(
                format!(
                    "{}\n{}",
                    include_str!("wgsl/lanes.wgsl"),
                    include_str!("wgsl/defocus.wgsl"),
                )
                .into(),
            ),
        });
        let defocus_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("defocus"),
            entries: &[uniform_entry(0), storage_entry(1), storage_entry(2), storage_entry(3)],
        });
        let defocus_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("defocus"),
                bind_group_layouts: &[Some(&defocus_layout)],
                immediate_size: 0,
            });
        let defocus = |entry: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&defocus_pipeline_layout),
                module: &defocus_module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };

        Some(Base {
            layout,
            encode,
            defringe_layout,
            defringe_luma: defringe("defringe_luma"),
            defringe_apply: defringe("defringe_apply"),
            warp_layout,
            warp,
            noise_layout,
            noise_luma: noise("noise_luma"),
            noise_blocks: noise("noise_blocks"),
            defocus_layout,
            defocus_bins: defocus("defocus_bins"),
            defocus_residuals: defocus("defocus_residuals"),
        })
    }
}

fn uniform_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn storage_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only: false },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

/// The coding, the defringe and the lens warp over one resident frame - one upload in front of
/// them and one readback behind, instead of a pair around each.
///
/// **This is what the module is for.** The stages were worth a third of their own time and none of
/// the render's: at 61MP each was carrying 361MB up and 361MB back for the privilege of running
/// pointwise arithmetic somewhere else, and the warp wired in alone measured 588-610ms against the
/// CPU's 639ms. Four transfers become two here, and the sharpen behind it is the only reason the
/// second one is still there.
///
/// A stage whose inputs say it does nothing is left out of the chain rather than run as an
/// identity, so the result is `out`-sized where the lens warps and `source`-sized where it does
/// not. None where the frame is too small to be worth the trip, which is the caller's cue for the
/// CPU path.
pub fn prepare(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &[u16],
    source: (usize, usize),
    out: (usize, usize),
    levels: crate::tone::Anchored,
    reference_white_nits: f64,
    strengths: crate::image::Strengths,
    lens: &crate::fit::Lens,
) -> Option<Vec<u16>> {
    let (sw, sh) = source;
    if sw == 0 || sh == 0 || samples.len() < sw * sh * 3 {
        return None;
    }

    let frame = upload(gpu, samples);
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encode_base_into(gpu, base, &mut encoder, &frame, samples.len(), levels, reference_white_nits);

    // **Measured here rather than handed in, which is why it had to move onto the GPU too.** The
    // pair describes the *coded* frame - `finish_in_strips` takes it after `encode_base` - so a
    // caller supplying it would have to code, read back, measure and upload again, the round trip
    // this function exists to delete. The reduction reads the buffer the pass above just wrote and
    // only the two numbers come back.
    let defocus = match strengths.defringe > 0.0 {
        true => {
            let taken = std::mem::replace(
                &mut encoder,
                gpu.device.create_command_encoder(&Default::default()),
            );
            measure_defocus_into(gpu, base, taken, &frame, sw, sh)
                .map(|(red, blue)| {
                    let scale = strengths.defringe.clamp(0.0, 1.0) as f32;
                    (red * scale, blue * scale)
                })
                .unwrap_or((0.0, 0.0))
        }
        false => (0.0, 0.0),
    };
    if defringes(samples.len(), sw, sh, defocus) {
        defringe_into(gpu, base, &mut encoder, &frame, sw, sh, defocus);
    }

    if !warps(samples.len(), source, out, lens) {
        let mut prepared = vec![0u16; samples.len()];
        read_back(gpu, encoder, &frame, samples.len().div_ceil(2), &mut prepared)?;
        reclaim(gpu, [frame]);
        return Some(prepared);
    }
    let words = (out.0 * out.1 * 3).div_ceil(2);
    let warped = warped_buffer(gpu, words);
    warp_lens_into(gpu, base, &mut encoder, &frame, &warped, source, out, lens);
    let mut prepared = vec![0u16; out.0 * out.1 * 3];
    read_back(gpu, encoder, &warped, words, &mut prepared)?;
    reclaim(gpu, [frame, warped]);
    Some(prepared)
}

/// Hands the frame's buffers back before the caller's next stage asks for memory of its own.
///
/// **wgpu frees on a poll, not on a drop.** `read_back` polls and *then* the buffers go out of
/// scope, so without this they are queued for destruction and released only whenever something
/// polls next - which, for an open, is after the sharpen has run. Measured on a 61MP frame: a
/// chained open held 722MB of frame and warped copy through a CPU sharpen that then ran 700-900ms
/// slower than the same sharpen on the same pixels without them.
fn reclaim<const N: usize>(gpu: &crate::gpu::Gpu, buffers: [wgpu::Buffer; N]) {
    for buffer in buffers {
        buffer.destroy();
    }
    gpu.device.poll(wgpu::PollType::Poll).ok();
}

/// Longitudinal chromatic aberration, as [`crate::image::finish_with`] takes it off with
/// `Strengths::before_the_fit`.
///
/// `defocus` is [`measure_defocus`]'s pair, already scaled by the setting.
pub fn defringe(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &mut [u16],
    width: usize,
    height: usize,
    defocus: (f32, f32),
) -> Option<()> {
    if !defringes(samples.len(), width, height, defocus) {
        return Some(());
    }
    let frame = upload(gpu, samples);
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    defringe_into(gpu, base, &mut encoder, &frame, width, height, defocus);
    read_back(gpu, encoder, &frame, (width * height * 3).div_ceil(2), samples)
}

/// The same refusal `image::finish_in_strips` makes: a frame with no room for the stencil has no
/// curvature to read, and the border fill would be the whole of it.
///
/// Asked rather than discovered, because [`prepare`] has to know before it uploads whether the
/// stage is in the chain at all.
fn defringes(samples: usize, width: usize, height: usize, defocus: (f32, f32)) -> bool {
    width >= 3 && height >= 3 && defocus != (0.0, 0.0) && samples >= width * height * 3
}

/// Records the correction against a frame already in VRAM. `defringes` is its precondition.
fn defringe_into(
    gpu: &crate::gpu::Gpu,
    base: &Base,
    encoder: &mut wgpu::CommandEncoder,
    frame: &wgpu::Buffer,
    width: usize,
    height: usize,
    defocus: (f32, f32),
) {
    let device = &gpu.device;
    let pixels = width * height;

    let luma = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("defringe luma"),
        size: (pixels * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });

    let mut params = Vec::with_capacity(32);
    params.extend_from_slice(&(width as u32).to_le_bytes());
    params.extend_from_slice(&(height as u32).to_le_bytes());
    params.extend_from_slice(&defocus.0.to_le_bytes());
    params.extend_from_slice(&defocus.1.to_le_bytes());
    for channel in crate::image::LUMA {
        params.extend_from_slice(&channel.to_le_bytes());
    }
    // `vec3f` is padded to four words, and the `full` after it lands in the hole rather than past
    // it - which is the same layout the shader declares and not a coincidence worth relying on
    // silently.
    params.extend_from_slice(&f32::from(u16::MAX).to_le_bytes());
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("defringe params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("defringe"),
        layout: &base.defringe_layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: frame.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: luma.as_entire_binding() },
        ],
    });

    {
        // A pass each, because the second reads every value the first wrote and a pass is where
        // wgpu puts that barrier.
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.defringe_luma);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = groups(pixels);
        pass.dispatch_workgroups(x, y, 1);
    }
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.defringe_apply);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = groups(pixels.div_ceil(2));
        pass.dispatch_workgroups(x, y, 1);
    }
}

/// A megabyte at a time, for the reason `galosh` and `demosaic` give: the staged copy would
/// otherwise be a second whole frame, and at 61MP that is 361MB beside one that is already the
/// largest thing in the process.
const CHUNK: usize = 1 << 18;

/// Invocations per workgroup, and the pair every kernel here is dispatched over.
const LANES: u32 = 64;

/// Workgroups for `count` invocations, spread over two dimensions.
///
/// **A dispatch dimension stops at 65535**, which one dimension of 64-wide groups reaches at 4.19M
/// invocations - a 61MP frame is fourteen times that, and the driver refuses the whole command
/// buffer rather than clamping. Every kernel here indexes by a linear id, so the second dimension
/// is a carry rather than a shape and the shaders undo it with `num_workgroups`.
///
/// Found by wiring the warp into a real render: the tests all ran on synthetic frames of a few
/// hundred pixels a side, where a dispatch is hundreds of groups and this is invisible.
fn groups(count: usize) -> (u32, u32) {
    let groups = (count as u32).div_ceil(LANES).max(1);
    let across = groups.min(32768);
    (across, groups.div_ceil(across))
}

/// The frame, packed two samples to a word.
fn upload(gpu: &crate::gpu::Gpu, samples: &[u16]) -> wgpu::Buffer {
    let words = samples.len().div_ceil(2);
    let frame = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("base frame"),
        size: (words * 4).max(4) as u64,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut bytes: Vec<u8> = Vec::with_capacity(CHUNK * 2);
    for (at, block) in samples.chunks(CHUNK).enumerate() {
        bytes.clear();
        for sample in block {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        // The tail of an odd frame, so the copy covers whole words and the spare half is a
        // defined zero rather than whatever the allocation held.
        if bytes.len() % 4 != 0 {
            bytes.extend_from_slice(&[0, 0]);
        }
        gpu.queue.write_buffer(&frame, (at * CHUNK * 2) as u64, &bytes);
    }
    frame
}

/// Submits the work and copies the frame back over the samples it came from.
fn read_back(
    gpu: &crate::gpu::Gpu,
    mut encoder: wgpu::CommandEncoder,
    frame: &wgpu::Buffer,
    words: usize,
    samples: &mut [u16],
) -> Option<()> {
    let readback = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("base readback"),
        size: (words * 4) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_buffer_to_buffer(frame, 0, &readback, 0, (words * 4) as u64);
    gpu.queue.submit([encoder.finish()]);

    readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).ok()?;
    {
        let mapped = readback.slice(..).get_mapped_range().ok()?;
        for (sample, pair) in samples.iter_mut().zip(mapped.chunks_exact(2)) {
            *sample = u16::from_le_bytes([pair[0], pair[1]]);
        }
    }
    readback.unmap();
    Some(())
}

/// Scene-linear levels to normalised PQ, as [`crate::tone::encode_base`] does it.
///
/// Takes and returns the frame rather than leaving it on the GPU, which [`prepare`] is the version
/// that does not: this spelling is what lets the stage be held against the CPU on its own.
pub fn encode_base(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &mut [u16],
    levels: crate::tone::Anchored,
    reference_white_nits: f64,
) -> Option<()> {
    let words = samples.len().div_ceil(2);
    if words == 0 {
        return Some(());
    }
    let frame = upload(gpu, samples);
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encode_base_into(gpu, base, &mut encoder, &frame, samples.len(), levels, reference_white_nits);
    read_back(gpu, encoder, &frame, words, samples)
}

/// Records the coding against a frame already in VRAM, `count` samples of it.
fn encode_base_into(
    gpu: &crate::gpu::Gpu,
    base: &Base,
    encoder: &mut wgpu::CommandEncoder,
    frame: &wgpu::Buffer,
    count: usize,
    levels: crate::tone::Anchored,
    reference_white_nits: f64,
) {
    let device = &gpu.device;
    let words = count.div_ceil(2);
    let params = [
        words as u32,
        count as u32,
        ((reference_white_nits / levels.white) as f32).to_bits(),
        0,
    ];
    let mut params_bytes = Vec::with_capacity(16);
    for word in params {
        params_bytes.extend_from_slice(&word.to_le_bytes());
    }
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("base params"),
        contents: &params_bytes,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("base"),
        layout: &base.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: frame.as_entire_binding() },
        ],
    });

    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.encode);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = groups(words);
        pass.dispatch_workgroups(x, y, 1);
    }
}

/// `image::channel_ratio_table` for all three channels end to end, as `f32`.
///
/// **The table, not the spline.** The knots are `f64` and evaluating them per pixel is a handful
/// of instructions a shader would not notice - but it would be a *different* warp: the gather the
/// CPU runs reads this table, whose 4096 buckets in r^2 and linear interpolation between them are
/// part of the answer, not an optimisation over it. A shader that evaluated the spline exactly
/// would disagree with the rendition by more than `f32` costs, and in a way that moves with the
/// lens. So the quantisation is uploaded along with the values.
///
/// Rebuilt here rather than borrowed from `PlanarWarp`, whose tables are private to `image`.
/// `the_lens_warp_matches_the_cpu` is what holds the two spellings together.
fn ratio_tables(lens: &crate::fit::Lens) -> Vec<f32> {
    let knots = lens.distortion.as_deref().unwrap_or_default();
    let last = crate::image::RATIO_TABLE_LAST;
    let mut out = Vec::with_capacity((last + 1) * 3);
    for channel in lens.channels() {
        for slot in 0..=last {
            let radius = (slot as f64 / last as f64).sqrt();
            let base = match radius == 0.0 {
                true => lens.crop,
                false => crate::image::sample_radius(knots, radius, lens.crop) / radius,
            };
            out.push((base * (1.0 + crate::image::spline_at(&channel, radius))) as f32);
        }
    }
    out
}

/// `map_u16`'s `lifts`: `g^m1` per radius bucket, and 1.0 where there is no falloff to undo.
///
/// A flat table of ones rather than a flag, since the shader already refuses to round-trip a gain
/// of exactly 1 - the one branch answers both.
fn lift_table(falloff: Option<(f64, f64)>) -> Vec<f32> {
    (0..256)
        .map(|radius| {
            let Some((a, b)) = falloff else { return 1.0 };
            let gain = crate::fit::Gain::at(a, b, radius as u8);
            match (gain - 1.0).abs() < 1e-5 {
                true => 1.0,
                false => crate::tone::gain_in_y(gain) as f32,
            }
        })
        .collect()
}

fn float_storage(gpu: &crate::gpu::Gpu, label: &str, values: &[f32]) -> wgpu::Buffer {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: &bytes,
        usage: wgpu::BufferUsages::STORAGE,
    })
}

/// The lens correction, as [`crate::hdr_fit::apply_lens`] runs it - `PlanarWarp::for_lens`
/// through the bicubic, gathered onto a frame of its own.
///
/// None where there is nothing to do, which is `for_lens`'s own answer to an identity lens, and
/// also what a refused device gives: both want the caller's CPU path, and `apply_lens` already
/// answers None by leaving the frame alone.
///
/// Bicubic only. The bilinear is the fit's, and the fit warps 8-bit and `f64` planes that never
/// reach this buffer layout.
pub fn warp_lens(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &[u16],
    source: (usize, usize),
    out: (usize, usize),
    lens: &crate::fit::Lens,
) -> Option<Vec<u16>> {
    if !warps(samples.len(), source, out, lens) {
        return None;
    }
    let pixels = out.0 * out.1;
    let words = (pixels * 3).div_ceil(2);

    let frame = upload(gpu, samples);
    let warped = warped_buffer(gpu, words);
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    warp_lens_into(gpu, base, &mut encoder, &frame, &warped, source, out, lens);
    let mut gathered = vec![0u16; pixels * 3];
    read_back(gpu, encoder, &warped, words, &mut gathered)?;
    Some(gathered)
}

/// `map_u16`'s own refusal on `sw < 2`, and `for_lens`'s on an identity. The shader indexes
/// `sw - 2u` unsigned, so a one-pixel source would read the far end of the buffer.
///
/// Asked rather than discovered, for [`prepare`]'s sake: whether the warp runs is which buffer
/// holds the prepared frame.
fn warps(
    samples: usize,
    source: (usize, usize),
    out: (usize, usize),
    lens: &crate::fit::Lens,
) -> bool {
    let (sw, sh) = source;
    !lens.is_identity()
        && sw >= 2
        && sh >= 2
        && out.0 > 0
        && out.1 > 0
        && samples >= sw * sh * 3
}

/// The gather's destination, which cannot be its source.
fn warped_buffer(gpu: &crate::gpu::Gpu, words: usize) -> wgpu::Buffer {
    gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("warp out"),
        size: (words * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    })
}

/// Records the gather from one resident frame onto another. `warps` is its precondition.
fn warp_lens_into(
    gpu: &crate::gpu::Gpu,
    base: &Base,
    encoder: &mut wgpu::CommandEncoder,
    frame: &wgpu::Buffer,
    warped: &wgpu::Buffer,
    source: (usize, usize),
    out: (usize, usize),
    lens: &crate::fit::Lens,
) {
    let device = &gpu.device;
    let (sw, sh) = source;
    let (width, height) = out;
    let pixels = width * height;

    let ratios = float_storage(gpu, "warp ratios", &ratio_tables(lens));
    let lifts = float_storage(gpu, "warp lifts", &lift_table(lens.falloff));

    // The output grid's half-diagonal squared, which is what `PlanarWarp::new` measures the
    // radius against - and squared throughout, because the table is indexed by r^2.
    let half2 = (width as f64 / 2.0).powi(2) + (height as f64 / 2.0).powi(2);
    let mut params: Vec<u8> = Vec::with_capacity(48);
    for word in [sw as u32, sh as u32, width as u32, height as u32] {
        params.extend_from_slice(&word.to_le_bytes());
    }
    for value in [
        (sw as f64 / 2.0 - 0.5) as f32,
        (sh as f64 / 2.0 - 0.5) as f32,
        (sw as f64 / width as f64) as f32,
        (sh as f64 / height as f64) as f32,
        (sw - 1) as f32,
        (sh - 1) as f32,
        (1.0 / half2) as f32,
        0.0,
    ] {
        params.extend_from_slice(&value.to_le_bytes());
    }
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("warp params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("warp"),
        layout: &base.warp_layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: frame.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: warped.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: ratios.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: lifts.as_entire_binding() },
        ],
    });

    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.warp);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = groups(pixels.div_ceil(2));
        pass.dispatch_workgroups(x, y, 1);
    }
}

/// The shader's stencil, and what fixes the size of the network it takes a median with.
///
/// Tiling the frame by one number and measuring it with another leaves an estimate that is
/// quietly wrong and a picture nobody would look at twice, so the two are held together here.
/// `median96` is wired for the 96 Laplacians an 8x8 block has and has no other size, so this is
/// the assertion that keeps the shader answering the question the CPU asks.
const BLOCK: usize = 8;
const _: () = assert!(BLOCK == crate::noise::BLOCK);

/// One dispatch's constants. `transform` is `alpha` and `sigma_sq` once the coarse pass has found
/// them, and `None` on the pass that measures the plane against itself.
fn noise_params(
    width: usize,
    height: usize,
    blocks: (usize, usize),
    transform: Option<(f32, f32)>,
) -> Vec<u8> {
    let (alpha, sigma_sq) = transform.unwrap_or((0.0, 0.0));
    // `crate::noise::stabilise`'s two constants, composed on this side so the shader evaluates the
    // same expression the CPU does rather than a second rounding of it.
    let c = 0.375 * alpha * alpha + sigma_sq;
    let mut out = Vec::with_capacity(32);
    for word in [width as u32, height as u32, blocks.0 as u32, blocks.1 as u32] {
        out.extend_from_slice(&word.to_le_bytes());
    }
    for value in [alpha, c, 2.0 / alpha.max(1e-12)] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.extend_from_slice(&u32::from(transform.is_some()).to_le_bytes());
    out
}

/// Submits the work and brings back one pair per block: its mean level, and its sigma.
fn read_blocks(
    gpu: &crate::gpu::Gpu,
    mut encoder: wgpu::CommandEncoder,
    stats: &wgpu::Buffer,
    count: usize,
) -> Option<Vec<[f32; 2]>> {
    let bytes = (count * 8) as u64;
    let readback = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("noise readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_buffer_to_buffer(stats, 0, &readback, 0, bytes);
    gpu.queue.submit([encoder.finish()]);

    readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).ok()?;
    let blocks = {
        let mapped = readback.slice(..).get_mapped_range().ok()?;
        mapped
            .chunks_exact(8)
            .map(|block| {
                let at = |o: usize| {
                    f32::from_le_bytes([block[o], block[o + 1], block[o + 2], block[o + 3]])
                };
                [at(0), at(4)]
            })
            .collect()
    };
    readback.unmap();
    Some(blocks)
}

/// What the prepared frame's noise is, as [`crate::noise::measure`] reads it.
///
/// **The GPU takes the pixels and the host keeps the quantiles**, which is the same line
/// `defringe` draws around its coefficients. The luma plane and the two block reductions are 61
/// million pixels apiece and are where the 1021ms is; the envelope and the binning run over the
/// ~941k block sigmas those produce - a few MB, read back once - and a quantile is the one shape a
/// GPU has nothing to offer over a `select_nth`. The tail here calls `noise`'s own `envelope` and
/// `typical` rather than reimplementing them, so the two paths cannot come to disagree about where
/// a percentile sits.
///
/// `None` where the GPU declines, including the frame too small to bin: the CPU answers that one
/// in microseconds and there is nothing to save.
pub fn measure(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &[u16],
    width: usize,
    height: usize,
) -> Option<crate::noise::Noise> {
    if width * height == 0 || samples.len() < width * height * 3 {
        return None;
    }
    let frame = upload(gpu, samples);
    let encoder = gpu.device.create_command_encoder(&Default::default());
    measure_into(gpu, base, encoder, &frame, width, height)
}

/// Reads a frame already in VRAM, and the one stage that takes its encoder rather than borrowing
/// one: the transform the second reduction runs under is a quantile of the first's output, so this
/// has to submit and map before it can record the rest. Whatever the caller had recorded goes down
/// with the coarse pass.
fn measure_into(
    gpu: &crate::gpu::Gpu,
    base: &Base,
    mut encoder: wgpu::CommandEncoder,
    frame: &wgpu::Buffer,
    width: usize,
    height: usize,
) -> Option<crate::noise::Noise> {
    let pixels = width * height;
    let blocks = (width / BLOCK, height / BLOCK);
    let count = blocks.0 * blocks.1;
    if count == 0 {
        return None;
    }
    let device = &gpu.device;

    let plane = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("noise luma"),
        size: (pixels * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    let stats = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("noise blocks"),
        size: (count * 8) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let group = |uniform: &wgpu::Buffer| {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("noise"),
            layout: &base.noise_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: frame.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: plane.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: stats.as_entire_binding() },
            ],
        })
    };
    let uniform = |transform: Option<(f32, f32)>| {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("noise params"),
            contents: &noise_params(width, height, blocks, transform),
            usage: wgpu::BufferUsages::UNIFORM,
        })
    };

    let coarse_group = group(&uniform(None));
    {
        // A pass each, as the defringe's two are: every block reads luma the pass before it wrote,
        // and a pass is where wgpu puts that barrier.
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.noise_luma);
        pass.set_bind_group(0, &coarse_group, &[]);
        let (x, y) = groups(pixels);
        pass.dispatch_workgroups(x, y, 1);
    }
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.noise_blocks);
        pass.set_bind_group(0, &coarse_group, &[]);
        let (x, y) = groups(count);
        pass.dispatch_workgroups(x, y, 1);
    }
    let coarse = read_blocks(gpu, encoder, &stats, count)?;

    // One sigma to parameterise the transform with, and the round trip the split is built around:
    // the second pass cannot be encoded until this number exists.
    let mut all: Vec<f32> = coarse.iter().map(|block| block[1]).collect();
    let sigma = crate::noise::envelope(&mut all).unwrap_or(1e-5).max(1e-5);
    let alpha = (sigma * 0.1).max(1e-5);
    let sigma_sq = (sigma * sigma).max(1e-8);

    let measured_group = group(&uniform(Some((alpha, sigma_sq))));
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.noise_blocks);
        pass.set_bind_group(0, &measured_group, &[]);
        let (x, y) = groups(count);
        pass.dispatch_workgroups(x, y, 1);
    }
    let measured = read_blocks(gpu, encoder, &stats, count)?;

    let mut bins: Vec<Vec<f32>> = vec![Vec::new(); crate::noise::BINS];
    for block in &measured {
        let bin = (block[0] * crate::noise::BINS as f32) as usize;
        bins[bin.min(crate::noise::BINS - 1)].push(block[1]);
    }
    let binned: Vec<crate::noise::Bin> = bins
        .iter_mut()
        .map(|sigmas| crate::noise::Bin {
            blocks: sigmas.len(),
            sigma: crate::noise::envelope(sigmas),
        })
        .collect();
    let stabilised = crate::noise::typical(&binned)
        .map_or(1e-6, |sigma| (sigma * crate::noise::DEMOSAIC_CORRELATION).max(1e-6));
    Some(crate::noise::Noise { stabilised, alpha, sigma_sq })
}

/// Sampled points one invocation sums before the host takes over, and `defocus.wgsl`'s pair.
const DEFOCUS_PER_SEGMENT: usize = 64;

/// The shader hardcodes all three, as `noise.wgsl` hardcodes its block. A host that sized the
/// readback by one number while the kernel binned by another would read plausible sums out of the
/// wrong slots, which is the failure with no symptom.
const _: () = assert!(crate::image::DEFOCUS_BINS == 6);
const _: () = assert!(crate::image::DEFOCUS_STRIDE == 3);
const _: () = assert!(crate::image::NOISE_BINS == 1024);

/// The defocus coefficients, as [`crate::image::measure_defocus`] reads them off the coded frame.
///
/// **This is the last thing that kept the chain from staying resident.** [`prepare`] takes the pair
/// as an input, and the CPU measures it from the frame *after* `tone::encode_base` has run - so a
/// caller had to code, read back, measure and upload again, which is the round trip `prepare`
/// exists to delete.
///
/// **The GPU takes the pixels and the host keeps the fit**, the same line [`measure`] draws. Both
/// whole-frame reductions are on the GPU: the radial sums over every third pixel, and the three
/// residual histograms each channel's noise sigma is a median of. What comes back is 24 numbers per
/// segment and three 1024-bucket histograms - and everything downstream of that reads six points.
/// A median of a histogram, a weighted line through six samples, and four vetoes are not
/// arithmetic a GPU has anything to offer on, and putting them there would mean a second copy of
/// the statistical rules rather than `image`'s own.
///
/// The tail is `measure_defocus`'s spelled a second time, which `sigma_from` and every constant
/// are deliberately *not* - `the_defocus_matches_the_cpu` is what holds the two spellings together.
///
/// None wherever the CPU answers None: too few samples, too few bins that resolve, a coefficient
/// past what a lens does, or two channels that disagree in sign.
pub fn measure_defocus(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &[u16],
    width: usize,
    height: usize,
) -> Option<(f32, f32)> {
    if width < 3 || height < 3 || samples.len() < width * height * 3 {
        return None;
    }
    let frame = upload(gpu, samples);
    let encoder = gpu.device.create_command_encoder(&Default::default());
    measure_defocus_into(gpu, base, encoder, &frame, width, height)
}

/// Reads a frame already in VRAM. Takes the encoder rather than borrowing one, as [`measure_into`]
/// does and for the same reason: the answer is a host computation over what the kernels write, so
/// this has to submit and map before it can return one.
fn measure_defocus_into(
    gpu: &crate::gpu::Gpu,
    base: &Base,
    mut encoder: wgpu::CommandEncoder,
    frame: &wgpu::Buffer,
    width: usize,
    height: usize,
) -> Option<(f32, f32)> {
    let device = &gpu.device;
    let bins = crate::image::DEFOCUS_BINS;
    let rows = (height - 2).div_ceil(crate::image::DEFOCUS_STRIDE);
    let across = (width - 2).div_ceil(crate::image::DEFOCUS_STRIDE);
    let segments = across.div_ceil(DEFOCUS_PER_SEGMENT);
    let partial_bytes = rows * segments * bins * 16;
    let histogram_bytes = 3 * crate::image::NOISE_BINS * 4;

    let partials = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("defocus bins"),
        size: partial_bytes as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    // Zeroed explicitly: every other buffer here is written before it is read, and this one is
    // added to.
    let residuals = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("defocus residuals"),
        contents: &vec![0u8; histogram_bytes],
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    });

    let (cx, cy) = (width as f64 / 2.0, height as f64 / 2.0);
    let mut params: Vec<u8> = Vec::with_capacity(48);
    for word in [width as u32, height as u32, across as u32, rows as u32, segments as u32] {
        params.extend_from_slice(&word.to_le_bytes());
    }
    for value in [cx as f32, cy as f32, (cx * cx + cy * cy) as f32] {
        params.extend_from_slice(&value.to_le_bytes());
    }
    for channel in crate::image::LUMA {
        params.extend_from_slice(&channel.to_le_bytes());
    }
    // `vec3f` is padded to four words and `noise_max` lands in the hole, as the defringe's `full`
    // does - the layout the shader declares, not a coincidence.
    params.extend_from_slice(&crate::image::NOISE_MAX.to_le_bytes());
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("defocus params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("defocus"),
        layout: &base.defocus_layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: frame.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: partials.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: residuals.as_entire_binding() },
        ],
    });

    {
        // One pass for both, unlike the defringe's and the noise's: neither kernel reads what the
        // other writes, so there is no barrier to put between them.
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.defocus_bins);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = groups(rows * segments);
        pass.dispatch_workgroups(x, y, 1);
        pass.set_pipeline(&base.defocus_residuals);
        let (x, y) = groups(width * height);
        pass.dispatch_workgroups(x, y, 1);
    }
    let [packed, histograms] =
        read_all(gpu, encoder, [(&partials, partial_bytes), (&residuals, histogram_bytes)])?;

    // The widening the shader could not do: an invocation sums 64 samples in `f32` where the CPU
    // sums a row in `f64`, and the segments meet here.
    let mut cross_red = vec![0.0f64; bins];
    let mut cross_blue = vec![0.0f64; bins];
    let mut square = vec![0.0f64; bins];
    let mut counted = vec![0.0f64; bins];
    for (at, sums) in packed.chunks_exact(16).enumerate() {
        let value = |o: usize| {
            f64::from(f32::from_le_bytes([sums[o], sums[o + 1], sums[o + 2], sums[o + 3]]))
        };
        let bin = at % bins;
        cross_red[bin] += value(0);
        cross_blue[bin] += value(4);
        square[bin] += value(8);
        counted[bin] += value(12);
    }
    if counted.iter().sum::<f64>() < crate::image::DEFOCUS_MIN_SAMPLES as f64 {
        return None;
    }

    let sigmas: Vec<f64> = histograms
        .chunks_exact(4)
        .map(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]]))
        .collect::<Vec<u32>>()
        .chunks_exact(crate::image::NOISE_BINS)
        .map(|histogram| f64::from(crate::image::sigma_from(histogram)))
        .collect();
    let weight = crate::image::LUMA.map(f64::from);
    let variance = [sigmas[0] * sigmas[0], sigmas[1] * sigmas[1], sigmas[2] * sigmas[2]];
    let luma_variance: f64 = (0..3).map(|c| weight[c] * weight[c] * variance[c]).sum();
    let bias = |channel: usize| 4.0 * luma_variance - 4.0 * weight[channel] * variance[channel];

    let mut samples: Vec<(f64, f64, f64, f64)> = Vec::new();
    for bin in 0..bins {
        if counted[bin] < crate::image::DEFOCUS_MIN_PER_BIN as f64 {
            continue;
        }
        let energy = square[bin] - counted[bin] * 20.0 * luma_variance;
        if energy <= 0.0 {
            continue;
        }
        let red = (cross_red[bin] - counted[bin] * bias(0)) / energy;
        let blue = (cross_blue[bin] - counted[bin] * bias(2)) / energy;
        samples.push(((bin as f64 + 0.5) / bins as f64, red, blue, energy));
    }
    if samples.len() < crate::image::DEFOCUS_MIN_BINS {
        return None;
    }
    let constant_term = |pick: &dyn Fn(&(f64, f64, f64, f64)) -> f64| -> f64 {
        let total: f64 = samples.iter().map(|s| s.3).sum();
        let mean_at = samples.iter().map(|s| s.3 * s.0).sum::<f64>() / total;
        let mean_k = samples.iter().map(|s| s.3 * pick(s)).sum::<f64>() / total;
        let covariance: f64 =
            samples.iter().map(|s| s.3 * (s.0 - mean_at) * (pick(s) - mean_k)).sum();
        let spread: f64 = samples.iter().map(|s| s.3 * (s.0 - mean_at).powi(2)).sum();
        let slope = match spread > 0.0 {
            true => covariance / spread,
            false => 0.0,
        };
        mean_k - slope * mean_at
    };
    let red = constant_term(&|s| s.1) as f32;
    let blue = constant_term(&|s| s.2) as f32;
    if red.abs() > crate::image::DEFOCUS_MAX || blue.abs() > crate::image::DEFOCUS_MAX {
        return None;
    }
    let noise = crate::image::DEFOCUS_NOISE;
    if red.abs() > noise && blue.abs() > noise && red * blue < 0.0 {
        return None;
    }
    let (red, blue) = (red.max(0.0), blue.max(0.0));
    match red > noise || blue > noise {
        true => Some((red, blue)),
        false => None,
    }
}

/// Submits the work and brings every result back on one fence, since no kernel here reads what
/// another writes and a second wait would buy nothing.
fn read_all<const N: usize>(
    gpu: &crate::gpu::Gpu,
    mut encoder: wgpu::CommandEncoder,
    sources: [(&wgpu::Buffer, usize); N],
) -> Option<[Vec<u8>; N]> {
    let staged = sources.map(|(source, bytes)| {
        let readback = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("base readback"),
            size: bytes as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_buffer_to_buffer(source, 0, &readback, 0, bytes as u64);
        readback
    });
    gpu.queue.submit([encoder.finish()]);

    for readback in &staged {
        readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    }
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).ok()?;
    let mut read = Vec::with_capacity(N);
    for readback in &staged {
        read.push(readback.slice(..).get_mapped_range().ok()?.to_vec());
        readback.unmap();
    }
    read.try_into().ok()
}

#[cfg(test)]
mod tests {
    /// The coding, against the CPU it replaces, over every level a sample can hold.
    ///
    /// **Not bit-equal, and it cannot be.** The CPU builds a 65536-entry table in `f64` and rounds
    /// each entry once; the shader evaluates the same curve in `f32` per sample. So the bound is
    /// on the count, and it is one: a level either lands on the same code or on its neighbour,
    /// which is the whole of what `f32` can cost a curve that is monotone in its input.
    ///
    /// Every level rather than a photograph's worth, since a table is exactly the thing where the
    /// levels a frame happens to contain say nothing about the ones it does not.
    #[test]
    fn the_coding_matches_the_cpu_within_a_count() {
        let Some(gpu) = crate::gpu::device() else { return };
        let Some(base) = super::device(gpu) else { return };

        // Odd, so the tail that shares its word with nothing is exercised rather than assumed.
        let levels: Vec<u16> = (0..=u16::MAX).chain(std::iter::once(0)).collect();
        let anchored = crate::tone::Levels { white: 8133.0, peak: 13783.0 }.anchored();

        let mut theirs = levels.clone();
        crate::tone::encode_base(&mut theirs, anchored, 203.0);

        let mut mine = levels.clone();
        super::encode_base(gpu, base, &mut mine, anchored, 203.0).expect("the coding runs");

        let worst = theirs
            .iter()
            .zip(&mine)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .expect("a frame with samples in it");
        assert!(worst <= 1, "the shader and the table disagree by {worst} counts");
        // And it is a coding rather than a copy, which a bound alone would let through.
        assert_ne!(theirs, levels, "the CPU left the frame as it found it");
    }

    /// Every dispatch a real sensor asks for is one a driver will accept.
    ///
    /// **Nothing else here can see this.** The parity tests run on frames a few hundred pixels a
    /// side, where a dispatch is hundreds of groups in one dimension and the ceiling is four
    /// orders of magnitude away; the warp reached a render before anyone noticed, and the driver
    /// refused the whole command buffer with "must be less or equal to 65535". So the sizes are
    /// asserted against the limit directly rather than against a frame that happens to be small.
    #[test]
    fn a_sensor_sized_dispatch_is_one_a_driver_will_take() {
        // 61MP, and the pathological end of what `MAX_EDIT_EDGE` admits.
        for pixels in [24_240_576usize, 60_217_344, 100_000 * 100_000 / 8] {
            for count in [pixels, pixels * 3, pixels.div_ceil(2)] {
                let (x, y) = super::groups(count);
                assert!(x <= 65535 && y <= 65535, "{count} dispatches {x}x{y}");
                let covered = u64::from(x) * u64::from(y) * u64::from(super::LANES);
                assert!(covered >= count as u64, "{count} covered by only {covered}");
            }
        }
        // And a frame small enough to fit one dimension still gets one, so the common case is not
        // paying for a second.
        assert_eq!(super::groups(64 * 100).1, 1);
    }

    /// A frame with as much curvature as the format allows, since that is what the correction is
    /// proportional to.
    ///
    /// **A gentle frame passes a wrong shader.** A first version of this varied by a few thousand
    /// counts over blocks of five pixels, which left the luma Laplacian around 0.036 and the
    /// green correction under twenty counts - so a coefficient 5% wrong moved a sample by less
    /// than one and the bound below swallowed it. Single-pixel alternation between the ends of
    /// the range puts the Laplacian near its maximum, where a percent is a count.
    fn edged(width: usize, height: usize) -> Vec<u16> {
        let mut out = vec![0u16; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let at = (y * width + x) * 3;
                let high = (x + y) % 2 == 0;
                // Away from both rails, so the correction is not measured against a clamp.
                let (dark, light) = (6000u16, 58000u16);
                out[at] = if high { light } else { dark };
                out[at + 1] = if high { dark } else { light };
                out[at + 2] = if high { light / 2 } else { dark * 2 };
            }
        }
        out
    }

    /// The defringe, against `image::finish_with` running the same stage on the same frame.
    ///
    /// Held against `finish_with` rather than `finish` so both sides take the *same* defocus
    /// pair: `finish` measures it, and a test that let each measure its own would be comparing
    /// two measurements rather than the correction they drive.
    ///
    /// **Not bit-equal, and it cannot be.** The CPU splits the frame into three `f32` planes,
    /// corrects the two chroma differences and solves the luma equation for green on the way
    /// back; the shader composes those into one add per channel and rounds once instead of
    /// twice. So a sample can land a count either side of the CPU's, and the bound is two -
    /// one for each rounding the CPU does that the shader does not.
    #[test]
    fn the_defringe_matches_the_cpu_within_two_counts() {
        let Some(gpu) = crate::gpu::device() else { return };
        let Some(base) = super::device(gpu) else { return };

        let (width, height) = (61usize, 43);
        let frame = edged(width, height);
        let strengths = crate::image::Strengths { sharpen: 0.0, defringe: 1.0 };
        let defocus = (0.031f32, -0.017f32);

        let mut theirs = frame.clone();
        crate::image::finish_with(&mut theirs, width, height, strengths, defocus);

        let mut mine = frame.clone();
        super::defringe(gpu, base, &mut mine, width, height, defocus).expect("the defringe runs");

        // **Asserted before the bound, and on the size of the correction rather than on how many
        // samples it touched.** A count of moved samples says a stage ran; it does not say it did
        // anything a tolerance would notice, and a correction smaller than the bound makes the
        // bound vacuous - a shader that returned its input unchanged would pass.
        let correction =
            theirs.iter().zip(&frame).map(|(a, b)| a.abs_diff(*b)).max().expect("samples");
        assert!(correction > 200, "the CPU's own correction peaks at {correction} counts");

        let worst = theirs.iter().zip(&mine).map(|(a, b)| a.abs_diff(*b)).max().expect("samples");
        assert!(worst <= 2, "the shader and the planes disagree by {worst} counts");
    }

    /// The lens correction, against `PlanarWarp::apply_u16` on the same frame and the same lens.
    ///
    /// **On a checkerboard, because a warp is a resample and a smooth frame does not test one.**
    /// Every displacement here lands between samples, so the four cubic taps carry the whole
    /// answer and a wrong weight is tens of thousands of counts out - where on a ramp the same
    /// wrong weight interpolates to nearly the right number.
    ///
    /// A lens with all four corrections on it: a distortion with its fill crop, a falloff, and a
    /// lateral aberration - the last is what makes the three channels read at three different
    /// radii, so a shader that gathered one position for the pixel would fail here and nowhere
    /// else.
    ///
    /// Odd in both dimensions, so the pair of pixels an invocation writes and the half word at
    /// the end of the frame are exercised rather than assumed.
    ///
    /// **Not bit-equal, and it cannot be.** The CPU carries the ratio table, the tap positions
    /// and the sixteen weighted taps in `f64`; the shader has `f32`, so a tap lands ~1e-5 of a
    /// pixel from the CPU's, and against this frame's 50000 counts per pixel that is a third of
    /// a count on its own. `as u16` truncates rather than rounds, so any such difference that
    /// straddles an integer is a whole count.
    ///
    /// Measured on RADV: worst 2, mean 0.167, with 17% of samples a count out and thirteen of
    /// 139551 reaching the bound. **Worst and mean both, because a bicubic that is right in the
    /// middle and wrong at the border reads as a worst far above its mean** - and this one does
    /// not: three of those thirteen are within two pixels of an edge, which is the share the
    /// border holds of the frame.
    #[test]
    fn the_lens_warp_matches_the_cpu() {
        let Some(gpu) = crate::gpu::device() else { return };
        let Some(base) = super::device(gpu) else { return };

        let (width, height) = (257usize, 181);
        let frame = edged(width, height);
        let knots = vec![0.0, 40.0, 160.0, 380.0];
        let lens = crate::fit::Lens {
            crop: crate::image::fill_crop(&knots, width, height),
            distortion: Some(knots),
            falloff: Some((0.25, 0.1)),
            tca: Some([vec![0.0, 24.0, 60.0], vec![0.0, -18.0, -44.0]]),
        };

        let warp = crate::image::PlanarWarp::for_lens(
            width,
            height,
            width,
            height,
            &lens,
            crate::image::Sampling::Bicubic,
        )
        .expect("a lens that moves pixels");
        let theirs = warp.apply_u16(&frame);
        let mine = super::warp_lens(gpu, base, &frame, (width, height), (width, height), &lens)
            .expect("the warp runs");

        // The warp has to have moved the frame before a tolerance on it means anything: a gather
        // that returned its source would otherwise agree with itself perfectly.
        let moved = theirs.iter().zip(&frame).map(|(a, b)| a.abs_diff(*b)).max().expect("samples");
        assert!(moved > 10000, "the CPU's own warp moves a sample by only {moved} counts");

        let worst = theirs.iter().zip(&mine).map(|(a, b)| a.abs_diff(*b)).max().expect("samples");
        let mean = theirs.iter().zip(&mine).map(|(a, b)| f64::from(a.abs_diff(*b))).sum::<f64>()
            / theirs.len() as f64;
        assert!(worst <= 2, "the shader and the gather disagree by {worst} counts, mean {mean:.4}");
    }

    /// The chain against the three public functions it collapses, on the same frame.
    ///
    /// **Bit-equal, unlike every other test here, and it has to be.** The others hold a shader
    /// against a CPU that computes the same thing differently; this holds the same shaders on the
    /// same data against themselves, and every stage writes u16 back into the same packed buffer -
    /// so the readbacks the chain deletes were copies, not roundings. A count of difference is a
    /// bug in the plumbing.
    ///
    /// Both branches, because which buffer holds the answer is what the warp's absence changes.
    #[test]
    fn prepare_is_the_three_stages_over_one_buffer() {
        let Some(gpu) = crate::gpu::device() else { return };
        let Some(base) = super::device(gpu) else { return };

        let (width, height) = (257usize, 181);
        let frame = edged(width, height);
        let levels = crate::tone::Levels { white: 8133.0, peak: 13783.0 }.anchored();
        // The strengths `prepare` takes, and the pair it will measure for itself off the coded
        // frame - taken here the same way so the staged side is the same arithmetic rather than a
        // number chosen to agree with it.
        let strengths = crate::image::Strengths { sharpen: 0.0, defringe: 1.0 };
        let defocus = {
            let mut coded = frame.clone();
            super::encode_base(gpu, base, &mut coded, levels, 203.0).expect("the coding runs");
            super::measure_defocus(gpu, base, &coded, width, height)
                .map(|(red, blue)| {
                    let scale = strengths.defringe.clamp(0.0, 1.0) as f32;
                    (red * scale, blue * scale)
                })
                .unwrap_or((0.0, 0.0))
        };
        let knots = vec![0.0, 40.0, 160.0, 380.0];
        let lens = crate::fit::Lens {
            crop: crate::image::fill_crop(&knots, width, height),
            distortion: Some(knots),
            falloff: Some((0.25, 0.1)),
            tca: Some([vec![0.0, 24.0, 60.0], vec![0.0, -18.0, -44.0]]),
        };

        let staged = |lens: &crate::fit::Lens| {
            let mut samples = frame.clone();
            super::encode_base(gpu, base, &mut samples, levels, 203.0).expect("the coding runs");
            super::defringe(gpu, base, &mut samples, width, height, defocus)
                .expect("the defringe runs");
            let gathered =
                super::warp_lens(gpu, base, &samples, (width, height), (width, height), lens);
            gathered.unwrap_or(samples)
        };
        let chained = |lens: &crate::fit::Lens| {
            super::prepare(
                gpu,
                base,
                &frame,
                (width, height),
                (width, height),
                levels,
                203.0,
                strengths,
                lens,
            )
            .expect("the chain runs")
        };
        let differing = |mine: &[u16], theirs: &[u16]| {
            assert_eq!(mine.len(), theirs.len(), "the chain returned a different frame");
            mine.iter().zip(theirs).filter(|(a, b)| a != b).count()
        };

        let theirs = staged(&lens);
        // The stages have to have moved the frame before an equality on them means anything: two
        // chains that both did nothing agree perfectly.
        assert!(differing(&theirs, &frame) > frame.len() / 2, "the stages left the frame alone");
        assert_eq!(differing(&chained(&lens), &theirs), 0, "the chained frame differs");

        let identity = crate::fit::Lens::none();
        assert_eq!(differing(&chained(&identity), &staged(&identity)), 0, "unwarped, it differs");
    }

    /// Four bands of real noise, each at its own level and its own sigma, each channel offset.
    ///
    /// **What the estimator reads is a percentile of a percentile, so a gentle frame proves
    /// nothing.** A block's sigma is the median of its 96 Laplacians and a bin's is the quiet fifth
    /// of its blocks, both of which a smooth ramp answers with the same near-zero number
    /// everywhere - a shader that measured the wrong plane, or binned by the wrong level, would
    /// agree with the CPU to every digit. Bands give the bins something to disagree about; the
    /// noise is gaussian and independent per channel, so a block's median Laplacian is a sigma
    /// rather than a step; and the channels sit at different levels, so the luma weights are
    /// load-bearing rather than summing to one over three copies of the same number.
    ///
    /// The levels land mid-bin (luma is about 0.946 of the level here), which is not fussiness: a
    /// band sitting on a bin edge splits across two, and the weighted median that picks one bin is
    /// then a coin toss the two paths could call differently. The brightest band stops short of
    /// the top for the reason the defringe's frame stays off both rails - a clipped channel is a
    /// measurement of the clip.
    fn banded(width: usize, height: usize) -> Vec<u16> {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut normal = || {
            // Sum of twelve uniforms, minus six: mean 0, variance 1, and no dependency.
            (0..12)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    (state >> 40) as f32 / 16777216.0
                })
                .sum::<f32>()
                - 6.0
        };
        let bands = [(0.1156f32, 0.020f32), (0.3799, 0.008), (0.6111, 0.003), (0.7768, 0.0012)];
        let mut out = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            let (level, sigma) = bands[y * bands.len() / height];
            for _ in 0..width {
                for tint in [0.75, 1.0, 1.2] {
                    let value = (level * tint + sigma * normal()) * 65535.0;
                    out.push(value.clamp(0.0, 65535.0) as u16);
                }
            }
        }
        out
    }

    /// A frame whose red and blue are genuinely softer than its green, by the same amount
    /// everywhere in the field.
    ///
    /// **A focus difference is not a colour, so it cannot be painted on.** The fit regresses
    /// `channel - luma` on the curvature of luma, so a frame with arbitrary colour at its edges
    /// gives it nothing to find and one where the fringe *is* a multiple of that curvature gives
    /// it the multiple. A blur of `t` is `g + t.lap(g)` to first order, which is that same model,
    /// so red and blue are green seen through one - flat across the field, which is what the `r^2`
    /// split is there to keep and a lateral aberration would not survive.
    ///
    /// **Blocks with ramped edges rather than a grating, because the sigmas are measured too.**
    /// The debias needs each channel's noise, and `sigma_from` reads it as the median residual of
    /// a 3x3 mean - a frame textured *everywhere* has no quiet pixels for that median to sit
    /// among, reads its own texture as noise, and pins itself at `NOISE_CEILING`, which two paths
    /// would then agree on for the wrong reason. Flats are the majority here, so the median lands
    /// among them and the number is the noise that was actually added.
    ///
    /// The contrast grows with radius, so the bins carry genuinely different curvature energy and
    /// the weighting in the regression is load-bearing; the coefficient does not, so what the fit
    /// should recover is the constant it was built with.
    fn defocused(width: usize, height: usize) -> Vec<u16> {
        let (cx, cy) = (width as f32 / 2.0, height as f32 / 2.0);
        let half = (cx * cx + cy * cy).sqrt();
        let mut blocks = vec![0.0f32; width * height];
        for y in 0..height {
            for x in 0..width {
                let radius = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt() / half;
                let amplitude = 0.10 + 0.28 * radius;
                let up = ((x / 17) + (y / 17)) % 2 == 0;
                blocks[y * width + x] = 0.5 + if up { amplitude } else { -amplitude };
            }
        }
        // A hard step's Laplacian is two spikes a pixel wide, and the stride reads every third
        // pixel - so half the frame's curvature would be in samples nobody looks at, and which of
        // them get looked at would depend on where the blocks happen to start.
        let smooth = crate::image::box_mean(&blocks, width, height, 1);
        let curvature = crate::image::laplacian(&smooth, width, height);

        let mut state = 0x853c_49e6_748f_ea9bu64;
        let mut normal = || {
            (0..12)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    (state >> 40) as f32 / 16777216.0
                })
                .sum::<f32>()
                - 6.0
        };
        // Green sharp, since that is the channel autofocus works on; and a sigma per channel,
        // because the debias indexes the three separately and one figure could not catch a
        // transposition.
        let softness = [0.08f32, 0.0, 0.15];
        let sigmas = [0.0012f32, 0.0015, 0.0018];
        let mut out = Vec::with_capacity(width * height * 3);
        for at in 0..width * height {
            for channel in 0..3 {
                let value =
                    smooth[at] + softness[channel] * curvature[at] + sigmas[channel] * normal();
                out.push((value * 65535.0).clamp(0.0, 65535.0) as u16);
            }
        }
        out
    }

    /// The defocus fit, against the CPU it replaces.
    ///
    /// **Not bit-equal, and it cannot be.** The sums are `f64` per row on the CPU and `f32` per
    /// 64-sample segment here, and the shader is free to contract a multiply and an add into one
    /// rounding where Rust is not - which lands at 2e-7, measured on RADV.
    ///
    /// So the bound is half a percent, and what sets it is the one place either side can take a
    /// whole step rather than a small one: each channel's sigma is a bucket index off a
    /// 1024-bucket histogram, and the residual it is binned from is a nine-tap mean here against
    /// `box_mean`'s two sliding sweeps. Those agree to the last bit or two, so a pixel sitting on
    /// a bucket edge can fall either side - and one bucket of sigma moves the debias enough to
    /// shift the coefficient by ~0.2%. Half a percent clears that with room and still rejects a
    /// structural error by five times over: the Laplacian's centre tap a quarter of a percent
    /// wrong reads 2.5% off, because the fit divides one sum built from the stencil by another.
    #[test]
    fn the_defocus_matches_the_cpu() {
        let Some(gpu) = crate::gpu::device() else { return };
        let Some(base) = super::device(gpu) else { return };

        // Neither dimension a multiple of the stride or the block, so the partial segment at the
        // end of a row is exercised rather than assumed, and an odd sample count for `upload`.
        let (width, height) = (211usize, 149);
        let frame = defocused(width, height);

        let theirs =
            crate::image::measure_defocus(&frame, width, height).expect("a frame the CPU fits");
        // **Asserted before the bound**, and on the size of the fit rather than on it existing: a
        // relative bound against a coefficient the CPU floored to nothing is a bound against
        // nothing, and both paths declining is the way this test has failed to test anything
        // before.
        assert!(theirs.0 > 0.03 && theirs.1 > 0.08, "the CPU's own fit is {theirs:?}");

        let mine = super::measure_defocus(gpu, base, &frame, width, height)
            .expect("the measurement runs");
        let off = |mine: f32, theirs: f32| (mine - theirs).abs() / theirs;
        assert!(off(mine.0, theirs.0) < 0.005, "red {} against {}", mine.0, theirs.0);
        assert!(off(mine.1, theirs.1) < 0.005, "blue {} against {}", mine.1, theirs.1);
    }

    /// The measurement, against the CPU it replaces.
    ///
    /// **Not bit-equal, and it cannot be.** Every number either side reports is a quantile of
    /// quantiles: a block's sigma is an order statistic of 96 `f32` Laplacians, a bin's is the mean
    /// of a slice of a sort, and the frame's is whichever bin the weighted median lands in. The
    /// per-pixel arithmetic differs in the last bit or two - the shader is free to contract a
    /// multiply and an add into one rounding where Rust is not - and a block whose two middle
    /// Laplacians differ by less than that can hand back the other one.
    ///
    /// So the bound is a fifth of a percent, relative, and it sits between two measured numbers.
    /// The rounding alone lands at 1e-6 here. One flipped order statistic is worth about 1e-3: a
    /// block's neighbouring Laplacians are a percent or so apart, and a bin's envelope averages
    /// nineteen of its blocks. A structural error is nowhere near either - the divisor 6% wrong
    /// reads 2.8% off and swapping two luma weights 3.9%, both of which this rejects by more than
    /// an order of magnitude.
    #[test]
    fn the_noise_matches_the_cpu_within_a_fifth_of_a_percent() {
        let Some(gpu) = crate::gpu::device() else { return };
        let Some(base) = super::device(gpu) else { return };

        // Neither dimension a multiple of the block, so the partial row and column the CPU drops
        // are dropped here too; and an odd sample count, so `upload`'s tail is exercised.
        let (width, height) = (259usize, 131);
        let frame = banded(width, height);

        let theirs = crate::noise::measure(&frame, width, height);
        // **Asserted before the bound.** A frame the estimator declines reports its floor, and two
        // floors agree perfectly - so a shader that measured nothing at all would pass a relative
        // bound against one.
        assert!(theirs.stabilised > 0.01, "the CPU's own answer is {}", theirs.stabilised);

        let mine = super::measure(gpu, base, &frame, width, height).expect("the measurement runs");
        let off = |mine: f32, theirs: f32| (mine - theirs).abs() / theirs;
        assert!(
            off(mine.stabilised, theirs.stabilised) < 0.002,
            "sigma {} against {}",
            mine.stabilised,
            theirs.stabilised
        );
        // The transform the sigma was measured through, which the client applies verbatim: a sigma
        // that matched through a different transform would not be the same measurement.
        assert!(
            off(mine.alpha, theirs.alpha) < 0.002,
            "alpha {} against {}",
            mine.alpha,
            theirs.alpha
        );
        assert!(
            off(mine.sigma_sq, theirs.sigma_sq) < 0.002,
            "sigma_sq {} against {}",
            mine.sigma_sq,
            theirs.sigma_sq
        );
    }

    /// `noise.wgsl`'s `median96`, modelled here, against the rank `noise::blocks` asks for.
    ///
    /// The GPU test above cannot see this on its own: it compares two quantiles of quantiles under
    /// a 0.2% bound, and a network that returned the 47th or the 50th smallest would sit well
    /// inside it on photographic data, where neighbouring Laplacians are a percent apart. What can
    /// be wrong with a network is only ever its wiring - which half of a half-cleaner the rank
    /// falls in, which way a reversal runs, whether the sentinels sort where they are assumed to -
    /// and that is exact, so it is checked exactly, here, against `select_nth_unstable_by`.
    ///
    /// Weighted towards ties, runs and zeros because that is the only place the two can differ
    /// visibly: with 96 distinct values almost any wrong index still lands a plausible number.
    #[test]
    fn the_median_network_takes_the_rank_the_cpu_takes() {
        /// A bitonic sequence made ascending: the shader's `clean8`, `clean16`, `clean32` and
        /// `clean64`, which are one recursion at four sizes.
        fn clean(v: &mut [u32]) {
            if v.len() < 2 {
                return;
            }
            let half = v.len() / 2;
            for i in 0..half {
                let (a, b) = (v[i], v[i + half]);
                v[i] = a.min(b);
                v[i + half] = a.max(b);
            }
            let (lo, hi) = v.split_at_mut(half);
            clean(lo);
            clean(hi);
        }

        /// Two ascending runs made one, by reversing the second - the shader's `merge*`.
        fn merge(v: &mut [u32]) {
            let half = v.len() / 2;
            v[half..].reverse();
            clean(v);
        }

        /// The shader's `sort8`, which is `sort4` on each half and a merge - the same recursion
        /// again, and it bottoms out on the compare-exchange `clean` does at length two.
        fn sorted(v: &mut [u32]) {
            if v.len() < 2 {
                return;
            }
            let (lo, hi) = v.split_at_mut(v.len() / 2);
            sorted(lo);
            sorted(hi);
            merge(v);
        }

        fn network(laps: &[f32; 96]) -> u32 {
            let mut bits: Vec<u32> = laps.iter().map(|lap| lap.to_bits()).collect();
            for eight in bits.chunks_mut(8) {
                sorted(eight);
            }
            for sixteen in bits.chunks_mut(16) {
                merge(sixteen);
            }
            for thirty_two in bits.chunks_mut(32) {
                merge(thirty_two);
            }
            merge(&mut bits[..64]);

            let (ab, c) = bits.split_at(64);
            // The fourth thirty-two is all sentinel, so the first half of the 128-merge is `ab`
            // unchanged below 32 and a min against a reversed `c` above it.
            let low: Vec<u32> = (32..64).map(|i| ab[i].min(c[63 - i])).collect();
            let h2: Vec<u32> = (0..32).map(|i| ab[i].max(low[i])).collect();
            (0..16).map(|i| h2[i].max(h2[i + 16])).min().expect("sixteen candidates")
        }

        fn next(seed: &mut u64) -> u64 {
            *seed ^= *seed << 13;
            *seed ^= *seed >> 7;
            *seed ^= *seed << 17;
            *seed
        }

        let mut seed = 0x2545_f491_4f6c_dd1du64;
        // Any non-negative pattern, infinities and NaNs included: `total_cmp` and the integer order
        // agree over the whole of it, so the equivalence being checked is not restricted to the
        // magnitudes a real block produces - and a shader that got a swizzle wrong would be caught
        // by whichever value the wrong lane held.
        let pools = [1usize, 2, 3, 7, 16, 96];
        for round in 0..60_000usize {
            let pool: Vec<f32> = (0..pools[round % pools.len()])
                .map(|_| {
                    let bits = next(&mut seed) as u32 & 0x7fff_ffff;
                    // A third of the values pinned to zero, the shared low bit pattern a flat
                    // block, a clipped highlight and a clamped shadow all produce at once.
                    if next(&mut seed) % 3 == 0 { 0.0 } else { f32::from_bits(bits) }
                })
                .collect();

            let mut laps = [0.0f32; 96];
            if round % 2 == 0 {
                for lap in laps.iter_mut() {
                    *lap = pool[next(&mut seed) as usize % pool.len()];
                }
            } else {
                // In adjacent runs as well as scattered, because the twelve groups the network
                // sorts are positional: a run that fills one exactly takes a different path
                // through the merges than the same values spread over all of them.
                let run = 1 + round % 13;
                let mut at = 0;
                while at < laps.len() {
                    let value = pool[next(&mut seed) as usize % pool.len()];
                    for _ in 0..run.min(laps.len() - at) {
                        laps[at] = value;
                        at += 1;
                    }
                }
            }

            let mut reference = laps;
            reference.select_nth_unstable_by(96 / 2, f32::total_cmp);
            let want = reference[96 / 2].to_bits();
            let got = network(&laps);
            assert_eq!(got, want, "round {round} over {laps:?}");
        }
    }
}
