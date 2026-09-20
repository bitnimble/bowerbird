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
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("condition"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/condition.wgsl")).into(),
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
/// denoise and RCD each taking a host slice, uploading it and reading their answer back is three
/// round trips of 241MB at 61MP for a frame none of them wants on the CPU. They take this
/// instead, and the only thing that crosses back is what a caller asked for.
pub struct Mosaic {
    pub buffer: crate::gpu::Buffer,
    pub width: usize,
    pub height: usize,
}

impl Mosaic {
    pub fn samples(&self) -> usize {
        self.width * self.height
    }

    /// Room for a frame of this size, zeroed.
    pub fn plane(gpu: &crate::gpu::Gpu, width: usize, height: usize) -> Mosaic {
        let buffer = gpu.own_buffer(&wgpu::BufferDescriptor {
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
        let mut recording = gpu.record();
        recording.encoder().copy_buffer_to_buffer(
            &self.buffer,
            0,
            &copy.buffer,
            0,
            (self.samples() * 4) as u64,
        );
        recording.submit();
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
        let mut recording = gpu.record();
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("copy_rect"),
            contents: &words.iter().flat_map(|word| word.to_le_bytes()).collect::<Vec<u8>>(),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("copy_rect"),
            layout: &kernels.rect_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 4, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: self.buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: into.buffer.as_entire_binding() },
            ],
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernels.copy_rect);
            pass.set_bind_group(0, &group, &[]);
            let (x, y) = crate::base::groups(width * height);
            pass.dispatch_workgroups(x, y, 1);
        }
        recording.submit();
    }

    /// The whole frame back on the host, for the one caller that still wants it there.
    pub async fn read(&self, gpu: &crate::gpu::Gpu) -> Option<Vec<f32>> {
        self.read_rows(gpu, 0, self.height).await
    }

    /// A band of rows back on the host.
    ///
    /// **For a reader that does not need the frame at once.** A whole 61MP plane is 259MB in hand
    /// and another 259MB of mapping to build it from, which is most of what a detection ever asks
    /// the allocator for; a band at a time is the same bytes read and a fraction of them resident.
    ///
    /// Rows are contiguous in the buffer, so a band is one range rather than a gathered rectangle -
    /// which is why this takes rows and not a rectangle.
    pub async fn read_rows(&self, gpu: &crate::gpu::Gpu, top: usize, rows: usize) -> Option<Vec<f32>> {
        let rows = rows.min(self.height.checked_sub(top)?);
        let count = rows.checked_mul(self.width)?;
        let bytes = (count * 4) as u64;
        if count == 0 {
            return Some(Vec::new());
        }
        let mut recording = gpu.record();
        let readback = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("mosaic readback"),
            size: bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        recording.encoder().copy_buffer_to_buffer(
            &self.buffer,
            (top * self.width * 4) as u64,
            &readback,
            0,
            bytes,
        );
        recording.submit();

        crate::gpu::read_back(gpu, &readback, |mapped| {
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
        .await
    }
}

/// Levels a sensor can report, which is one run of the conditioning table.
pub const RUN: usize = 1 << 16;

/// The conditioning as the kernel reads it (`decode_rawler::curve`).
///
/// **Keyed by slot rather than by position, and the two are only the same on a Bayer sensor.** What
/// the arithmetic varies by is the pair (black level, white balance gain); a sensor has far fewer of
/// those than positions in its period, and X-Trans has 36 positions sharing three. A run per
/// position instead would be 9.4MB uploaded for every tile of every Fuji decode.
pub struct Curve {
    /// One run of [`RUN`] per distinct slot, in slot order.
    pub values: Vec<f32>,
    /// Which slot each position of the period reads, row-major over `period`.
    pub slot_of: Vec<u32>,
    /// The CFA's period, width then height.
    pub period: (usize, usize),
}

impl Curve {
    fn slots(&self) -> usize {
        self.slot_of.iter().copied().max().map_or(0, |top| top as usize + 1)
    }

    /// Whether this describes a whole domain the kernel can read.
    fn whole(&self) -> bool {
        let (w, h) = self.period;
        w > 0
            && h > 0
            && w <= crate::cfa::MAX_PERIOD
            && h <= crate::cfa::MAX_PERIOD
            && self.slot_of.len() == w * h
            && self.values.len() == self.slots() * RUN
    }
}

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
    curve: &Curve,
) -> Option<Mosaic> {
    let count = width.checked_mul(height)?;
    if count == 0 || samples.len() < count || !curve.whole() {
        return None;
    }
    // The samples and the curve belong to this dispatch and go with it; the mosaic is what the
    // caller was handed, so it is allocated outside the recording.
    let mut recording = gpu.record();
    let words = upload(&mut recording, &samples[..count]);
    let levels = float_storage(&mut recording, &curve.values);
    let mosaic = Mosaic::plane(gpu, width, height);

    let (period_w, period_h) = curve.period;
    let mut params: Vec<u8> = Vec::with_capacity(16 + crate::cfa::MAX_SLOTS * 16);
    for word in [width as u32, count as u32, period_w as u32, period_h as u32] {
        params.extend_from_slice(&word.to_le_bytes());
    }
    // The slot map, one per sixteen bytes: a uniform array strides its elements to sixteen whatever
    // they are, and the shader declares it that way too.
    for slot in 0..crate::cfa::MAX_SLOTS {
        let value = curve.slot_of.get(slot).copied().unwrap_or(0);
        params.extend_from_slice(&value.to_le_bytes());
        params.extend_from_slice(&[0u8; 12]);
    }
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("condition params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("condition"),
        layout: &kernels.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: words.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: levels.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: mosaic.buffer.as_entire_binding() },
        ],
    });

    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernels.pipeline);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = crate::base::groups(count);
        pass.dispatch_workgroups(x, y, 1);
    }
    recording.submit();

    // Every handle on the samples and the curve, then the poll that retires them. The recording
    // alone is not enough - these are named locals, so its copy is not the last one - and without
    // both the samples sit resident through the denoise that follows.
    drop((words, levels, uniform, recording));
    gpu.nudge();
    Some(mosaic)
}

fn float_storage(recording: &mut crate::gpu::Recording<'_>, values: &[f32]) -> crate::gpu::Buffer {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    recording.init(&wgpu::util::BufferInitDescriptor {
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

/// The samples packed two to a word, in the flat layout `condition.slang` unpacks.
///
/// Chunked for the reason `base::upload` gives, and threaded because a serial `to_le_bytes` over 61
/// million samples costs more than the dispatch it feeds.
fn upload(recording: &mut crate::gpu::Recording<'_>, samples: &[u16]) -> crate::gpu::Buffer {
    let words = samples.len().div_ceil(2);
    let gpu = recording.gpu();
    let buffer = recording.buffer(&wgpu::BufferDescriptor {
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
