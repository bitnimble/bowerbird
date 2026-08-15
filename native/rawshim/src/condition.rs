//! Conditioning the sensor's samples into the mosaic, on the GPU.
//!
//! **The transfer is the reason, not the arithmetic.** Conditioning a sample is a subtract, a
//! divide and a multiply, which no device does meaningfully faster than a threaded CPU - the
//! kernel does not even do that much, since `decode_rawler::curve` tabulates the whole domain and
//! this looks the answer up. What changes is what crosses to the GPU: the mosaic every later stage
//! reads is `f32` and 241MB at 61MP, and the samples it is made from are `u16` and 120MB.
//!
//! **On this box it is slower, and that is expected rather than a disappointment.** Measured on a
//! 61MP frame: the stage is 26-30ms threaded on the CPU and 86ms here, because the adapter is
//! integrated - its memory is the CPU's, so the halved upload is a memcpy either way, and the
//! mosaic still has to come *back* for `galosh::fit` and the tiled demosaic to read it on the host.
//! 361MB of traffic to replace 26ms of arithmetic loses, and would lose however the kernel were
//! written. The open around it is unchanged: 6454ms before against 6524ms after, which is noise.
//!
//! The tab is what this is for, and there neither half of that holds - the mosaic never leaves the
//! GPU, and the CPU it would otherwise run on is one thread rather than twelve. The stage that
//! makes it pay off here is `galosh` taking a device buffer, which is what deletes the readback.
//!
//! Its own module rather than more of `demosaic.rs` because the denoise sits between the two, and
//! than more of `base.rs` because that one's frame is the demosaiced one.

use rayon::prelude::*;
use wgpu::util::DeviceExt;

pub struct Condition {
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
}

pub fn device(gpu: &'static crate::gpu::Gpu) -> Option<&'static Condition> {
    static BUILT: std::sync::OnceLock<Option<Condition>> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Condition::new(gpu)).as_ref()
}

impl Condition {
    fn new(gpu: &crate::gpu::Gpu) -> Option<Condition> {
        let device = &gpu.device;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("condition"),
            source: wgpu::ShaderSource::Wgsl(
                format!(
                    "{}\n{}",
                    include_str!("wgsl/lanes.wgsl"),
                    include_str!("wgsl/condition.wgsl"),
                )
                .into(),
            ),
        });
        let storage = |binding: u32, read_only: bool| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("condition"),
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
                storage(1, true),
                storage(2, true),
                storage(3, false),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("condition"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("condition"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("condition"),
            compilation_options: Default::default(),
            cache: None,
        });
        Some(Condition { layout, pipeline })
    }
}

/// Levels a sensor can report, times the four positions of the 2x2: the whole domain of the
/// conditioning, which is what lets the kernel be a lookup rather than an expression.
pub const CURVE: usize = 4 * (1 << 16);

/// The mosaic, from the samples and `decode_rawler::curve`'s answer for every level.
///
/// None where the frame is empty, the samples are short of it, or the curve is not the whole
/// domain - the caller's cue for the CPU, which answers those in microseconds.
pub fn normalise(
    gpu: &crate::gpu::Gpu,
    kernels: &Condition,
    samples: &[u16],
    width: usize,
    height: usize,
    curve: &[f32],
) -> Option<Vec<f32>> {
    let count = width.checked_mul(height)?;
    if count == 0 || samples.len() < count || curve.len() != CURVE {
        return None;
    }
    let device = &gpu.device;

    let words = upload(gpu, &samples[..count]);
    let levels = float_storage(gpu, curve);
    let mosaic = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("condition mosaic"),
        size: (count * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });

    let mut params: Vec<u8> = Vec::with_capacity(16);
    for word in [width as u32, count as u32, 0, 0] {
        params.extend_from_slice(&word.to_le_bytes());
    }
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("condition params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("condition"),
        layout: &kernels.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: words.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: levels.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: mosaic.as_entire_binding() },
        ],
    });

    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernels.pipeline);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = crate::base::groups(count);
        pass.dispatch_workgroups(x, y, 1);
    }

    let bytes = (count * 4) as u64;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("condition readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_buffer_to_buffer(&mosaic, 0, &readback, 0, bytes);
    gpu.queue.submit([encoder.finish()]);

    readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    device.poll(wgpu::PollType::wait_indefinitely()).ok()?;
    let mut out = vec![0f32; count];
    {
        let mapped = readback.slice(..).get_mapped_range().ok()?;
        out.par_chunks_mut(GRAIN).zip(mapped.par_chunks(GRAIN * 4)).for_each(|(slots, bytes)| {
            for (slot, word) in slots.iter_mut().zip(bytes.chunks_exact(4)) {
                *slot = f32::from_le_bytes([word[0], word[1], word[2], word[3]]);
            }
        });
    }
    readback.unmap();

    // wgpu frees on a poll rather than on a drop, so without this the samples and the mosaic are
    // still resident through the denoise that follows - `base::reclaim` says what that cost.
    for buffer in [words, levels, mosaic, readback] {
        buffer.destroy();
    }
    device.poll(wgpu::PollType::Poll).ok();
    Some(out)
}

fn float_storage(gpu: &crate::gpu::Gpu, values: &[f32]) -> wgpu::Buffer {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("condition curve"),
        contents: &bytes,
        usage: wgpu::BufferUsages::STORAGE,
    })
}

/// Samples one thread packs, and floats one thread reads back.
///
/// **Two bytes is not a unit of work.** Spelt `par_chunks_mut(2)`, the pack over a 61MP frame spent
/// more in rayon than in the copy: the stage was 174ms, and 86ms of that was the granularity.
const GRAIN: usize = 1 << 13;

/// The samples packed two to a word, in the flat layout `condition.wgsl` unpacks.
///
/// Chunked for the reason `base::upload` gives, and threaded because a serial `to_le_bytes` over 61
/// million samples costs more than the dispatch it feeds.
fn upload(gpu: &crate::gpu::Gpu, samples: &[u16]) -> wgpu::Buffer {
    let words = samples.len().div_ceil(2);
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("condition samples"),
        size: (words * 4).max(4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    const CHUNK: usize = 1 << 20;
    let mut bytes = vec![0u8; CHUNK * 2];
    for (at, block) in samples.chunks(CHUNK).enumerate() {
        let scratch = &mut bytes[..block.len().div_ceil(2) * 4];
        // A chunk holds an even number of samples, so only the frame's own last word can be half
        // full - and the scratch is reused, so its spare half would otherwise carry a sample from a
        // megabyte earlier. The shader reads that word whole before it masks the half off.
        scratch[block.len() * 2..].fill(0);
        scratch
            .par_chunks_mut(GRAIN * 2)
            .zip(block.par_chunks(GRAIN))
            .for_each(|(out, block)| {
                for (pair, sample) in out.chunks_exact_mut(2).zip(block) {
                    pair.copy_from_slice(&sample.to_le_bytes());
                }
            });
        gpu.queue.write_buffer(&buffer, (at * CHUNK * 2) as u64, scratch);
    }
    buffer
}
