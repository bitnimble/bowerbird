//! Conditioning the sensor's samples into the mosaic, on the GPU.
//!
//! **The transfer is the reason, not the arithmetic.** Conditioning a sample is a subtract, a
//! divide and a multiply, which no device does meaningfully faster than a threaded CPU - the
//! kernel does not even do that much, since `decode_rawler::curve` tabulates the whole domain and
//! this looks the answer up. What changes is what crosses to the GPU: the mosaic every later stage
//! reads is `f32` and 241MB at 61MP, and the samples it is made from are `u16` and 120MB.
//!
//! **The mosaic stays where it is written**, which is what makes the stage worth having. It lost to
//! the CPU while it did not: 26-30ms threaded against 86ms here, because everything it produced came
//! straight back for `galosh::fit` and the tiled demosaic to read on the host. 361MB of traffic to
//! replace 26ms of arithmetic loses however the kernel is written. So it hands back a [`Mosaic`]
//! rather than a `Vec<f32>`, and the denoise and RCD read that buffer. Measured on a 61MP frame,
//! quiet box, the editor's open, warm runs: conditioning and the fit together were 1022-1072ms and
//! are 757-778ms, and the whole decode 2367-2407ms against 1947-2002ms.
//!
//! Its own module rather than more of `demosaic.rs` because the denoise sits between the two, and
//! than more of `base.rs` because that one's frame is the demosaiced one.

use rayon::prelude::*;
use wgpu::util::DeviceExt;

pub struct Condition {
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
    rect_layout: wgpu::BindGroupLayout,
    copy_rect: wgpu::ComputePipeline,
}

/// Infallible where `galosh::device` and `demosaic::device` are not: those decline an adapter under
/// a limit they need, and these two kernels ask for nothing beyond a storage buffer. A shader that
/// would not build is a panic through `on_uncaptured_error`, not a `None` anyone could handle.
pub fn device(gpu: &'static crate::gpu::Gpu) -> &'static Condition {
    static BUILT: std::sync::OnceLock<Condition> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Condition::new(gpu))
}

impl Condition {
    fn new(gpu: &crate::gpu::Gpu) -> Condition {
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
        let uniform = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("condition"),
            entries: &[uniform(0), storage(1, true), storage(2, true), storage(3, false)],
        });
        let rect_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("copy_rect"),
            entries: &[uniform(4), storage(5, true), storage(6, false)],
        });
        let compute = |label: &str, group: &wgpu::BindGroupLayout, entry_point: &str| {
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(label),
                bind_group_layouts: &[Some(group)],
                immediate_size: 0,
            });
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(entry_point),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let pipeline = compute("condition", &layout, "condition");
        let copy_rect = compute("copy_rect", &rect_layout, "copy_rect");
        Condition { layout, pipeline, rect_layout, copy_rect }
    }
}

/// The conditioned frame, where every stage between here and the demosaic reads it: on the device.
///
/// **The whole point of the type is that there is no `Vec<f32>` behind it.** `galosh::fit`, the
/// denoise and RCD each used to take a host slice, upload it, and read their answer back - three
/// round trips of 241MB at 61MP for a frame none of them wanted on the CPU. They take this instead,
/// and the only thing that crosses back is what a caller asked for.
pub struct Mosaic {
    pub buffer: wgpu::Buffer,
    pub width: usize,
    pub height: usize,
}

impl Mosaic {
    pub fn samples(&self) -> usize {
        self.width * self.height
    }

    /// Room for a frame of this size, zeroed.
    pub fn plane(gpu: &crate::gpu::Gpu, width: usize, height: usize) -> Mosaic {
        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("mosaic"),
            size: ((width * height).max(1) * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Mosaic { buffer, width, height }
    }

    /// A second buffer holding what this one holds, on the device.
    ///
    /// For a caller that has to keep an unfiltered frame: the denoise writes where it reads, so
    /// filtering twice at two amounts means filtering two copies. A frame is four bytes a
    /// photosite - 96MB at 24MP - which is worth it to answer a slider without re-reading a file.
    pub fn duplicate(&self, gpu: &crate::gpu::Gpu) -> Mosaic {
        let copy = Mosaic::plane(gpu, self.width, self.height);
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(&self.buffer, 0, &copy.buffer, 0, (self.samples() * 4) as u64);
        gpu.queue.submit([encoder.finish()]);
        copy
    }

    /// A mosaic that is already on the host, for a caller that built one another way.
    pub fn upload(gpu: &crate::gpu::Gpu, values: &[f32], width: usize, height: usize) -> Mosaic {
        let mosaic = Mosaic::plane(gpu, width, height);
        // A megabyte at a time rather than one `Vec<u8>` of the frame, which at 61MP would be
        // 240MB held beside the buffer it is being copied into.
        const CHUNK: usize = 1 << 18;
        let mut bytes: Vec<u8> = Vec::with_capacity(CHUNK * 4);
        for (at, block) in values[..width * height].chunks(CHUNK).enumerate() {
            bytes.clear();
            for sample in block {
                bytes.extend_from_slice(&sample.to_ne_bytes());
            }
            gpu.queue.write_buffer(&mosaic.buffer, (at * CHUNK * 4) as u64, &bytes);
        }
        mosaic
    }

    /// A rectangle of this one, densely packed, which is what every tiled stage reads.
    pub fn window(
        &self,
        gpu: &'static crate::gpu::Gpu,
        left: usize,
        top: usize,
        width: usize,
        height: usize,
    ) -> Mosaic {
        let out = Mosaic::plane(gpu, width, height);
        self.copy_rect(gpu, (left, top), &out, (0, 0), (width, height));
        out
    }

    /// A rectangle of this one written into `into` at `at`.
    pub fn copy_rect(
        &self,
        gpu: &'static crate::gpu::Gpu,
        from: (usize, usize),
        into: &Mosaic,
        at: (usize, usize),
        size: (usize, usize),
    ) {
        let kernels = device(gpu);
        let (width, height) = size;
        if width == 0 || height == 0 {
            return;
        }
        let words = [
            self.width as u32,
            from.0 as u32,
            from.1 as u32,
            into.width as u32,
            at.0 as u32,
            at.1 as u32,
            width as u32,
            height as u32,
        ];
        let uniform = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("copy_rect"),
            contents: &words.iter().flat_map(|word| word.to_le_bytes()).collect::<Vec<u8>>(),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("copy_rect"),
            layout: &kernels.rect_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 4, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: self.buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: into.buffer.as_entire_binding() },
            ],
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernels.copy_rect);
            pass.set_bind_group(0, &group, &[]);
            let (x, y) = crate::base::groups(width * height);
            pass.dispatch_workgroups(x, y, 1);
        }
        gpu.queue.submit([encoder.finish()]);
    }

    /// The whole frame back on the host, for the one caller that still wants it there.
    pub async fn read(&self, gpu: &crate::gpu::Gpu) -> Option<Vec<f32>> {
        let count = self.samples();
        let bytes = (count * 4) as u64;
        let readback = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("mosaic readback"),
            size: bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(&self.buffer, 0, &readback, 0, bytes);
        gpu.queue.submit([encoder.finish()]);

        let out = crate::gpu::read_back(&gpu.device, &readback, |mapped| {
            let mut out = vec![0f32; count];
            out.par_chunks_mut(GRAIN).zip(mapped.par_chunks(GRAIN * 4)).for_each(
                |(slots, bytes)| {
                    for (slot, word) in slots.iter_mut().zip(bytes.chunks_exact(4)) {
                        *slot = f32::from_le_bytes([word[0], word[1], word[2], word[3]]);
                    }
                },
            );
            out
        })
        .await;
        readback.destroy();
        out
    }
}

/// Levels a sensor can report, times the four positions of the 2x2: the whole domain of the
///
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
) -> Option<Mosaic> {
    let count = width.checked_mul(height)?;
    if count == 0 || samples.len() < count || curve.len() != CURVE {
        return None;
    }
    let device = &gpu.device;

    let words = upload(gpu, &samples[..count]);
    let levels = float_storage(gpu, curve);
    let mosaic = Mosaic::plane(gpu, width, height);

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
            wgpu::BindGroupEntry { binding: 3, resource: mosaic.buffer.as_entire_binding() },
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
    gpu.queue.submit([encoder.finish()]);

    // wgpu frees on a poll rather than on a drop, so without this the samples are still resident
    // through the denoise that follows - `base::reclaim` says what that cost. The mosaic itself
    // stays: it is what the caller was handed.
    for buffer in [words, levels] {
        buffer.destroy();
    }
    device.poll(wgpu::PollType::Poll).ok();
    Some(mosaic)
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
