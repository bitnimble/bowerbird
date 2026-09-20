//! The wide pass's two walks over the sharp planes, taken where the planes are.
//!
//! `slang/fit_wide.slang` is the arithmetic. This side states the gates' thresholds - they are
//! `hdr_fit`'s, and a shader restating one would be a second place to change it - and holds the
//! tiling between the two walks, which is index bookkeeping over a few thousand probes rather than
//! work on a picture.

/// Stepped positions one thread of the gate walks.
const BLOCK: usize = 256;

/// Words a gathered sample occupies: ours, the camera's, and whether it survived.
const SAMPLE_WORDS: usize = 7;

/// The two planes the pass reads, with what the lens did to ours.
pub(crate) struct Planes<'a> {
    pub ours: &'a crate::hdr_fit::Source,
    pub theirs: &'a crate::hdr_fit::Source,
    pub falloff: Option<(f64, f64)>,
    /// The top of our own domain, which a sample may not reach.
    pub ceiling: f64,
}

impl Planes<'_> {
    /// The grid both are read on, which is the smaller of the two.
    fn grid(&self) -> (usize, usize) {
        (self.ours.width.min(self.theirs.width), self.ours.height.min(self.theirs.height))
    }
}

struct Kernels {
    layout: wgpu::BindGroupLayout,
    count: wgpu::ComputePipeline,
    offsets: wgpu::ComputePipeline,
    write: wgpu::ComputePipeline,
    gather: wgpu::ComputePipeline,
}

fn kernels(gpu: &'static crate::gpu::Gpu) -> &'static Kernels {
    static BUILT: std::sync::OnceLock<Kernels> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fit_wide"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_wide.wgsl")).into(),
            ),
        });
        let entry = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let read = wgpu::BufferBindingType::Storage { read_only: true };
        let write = wgpu::BufferBindingType::Storage { read_only: false };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("fit_wide"),
            entries: &[
                entry(0, read),
                entry(1, read),
                entry(2, read),
                entry(3, read),
                entry(4, write),
                entry(5, write),
                entry(6, write),
                entry(20, wgpu::BufferBindingType::Uniform),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fit_wide"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let build = |name: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(name),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(name),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        Kernels {
            count: build("fit_wide_count"),
            offsets: build("fit_wide_offsets"),
            write: build("fit_wide_write"),
            gather: build("fit_wide_gather"),
            layout,
        }
    })
}

/// The positions the gate admitted, in row-major order, on both sides: the host tiles them and the
/// gather reads them where they are.
pub(crate) struct Admitted {
    pub at: Vec<[i32; 2]>,
    on_device: crate::gpu::Buffer,
}

/// What `block` writes, for `wgsl_layout`, which holds it against the struct its own shader
/// declares.
#[cfg(test)]
pub(crate) fn params_block() -> usize {
    std::mem::size_of::<Block>()
}

/// `Params` in `fit_wide.slang`. The trailing pad is what rounds the block up to sixteen bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Block {
    width: i32,
    height: i32,
    target_width: i32,
    our_width: i32,
    our_height: i32,
    stride: i32,
    block: i32,
    blocks: i32,
    rows: i32,
    count: i32,
    edge: i32,
    sample: i32,
    sample_range: f32,
    min_chroma: f32,
    camera_clipping: f32,
    camera_crushed: f32,
    margin_dark: f32,
    flat_enough: f32,
    ceiling: f32,
    has_falloff: i32,
    half_diagonal: f32,
    pad: [u32; 3],
}

fn block(planes: &Planes<'_>, blocks: usize, count: usize) -> Block {
    let (width, height) = planes.grid();
    let (cx, cy) = (planes.ours.width as f64 / 2.0, planes.ours.height as f64 / 2.0);
    Block {
        width: width as i32,
        height: height as i32,
        target_width: planes.theirs.width as i32,
        our_width: planes.ours.width as i32,
        our_height: planes.ours.height as i32,
        stride: crate::hdr_fit::WIDE_STRIDE as i32,
        block: BLOCK as i32,
        blocks: blocks as i32,
        rows: rows(planes) as i32,
        count: count as i32,
        edge: (crate::hdr_fit::PATCH + crate::hdr_fit::SEARCH) as i32,
        sample: crate::hdr_fit::SAMPLE as i32,
        sample_range: crate::hdr_fit::SAMPLE_RANGE as f32,
        min_chroma: crate::hdr_fit::WIDE_MIN_CHROMA as f32,
        camera_clipping: crate::hdr_fit::CAMERA_CLIPPING as f32,
        camera_crushed: crate::hdr_fit::CAMERA_CRUSHED as f32,
        margin_dark: crate::hdr_fit::MARGIN_DARK as f32,
        flat_enough: crate::hdr_fit::FLAT_ENOUGH as f32,
        ceiling: planes.ceiling as f32,
        has_falloff: i32::from(planes.falloff.is_some()),
        half_diagonal: (cx * cx + cy * cy).sqrt().max(1.0) as f32,
        pad: [0; 3],
    }
}

/// Rows of stepped positions the gate walks, and columns in each.
fn rows(planes: &Planes<'_>) -> usize {
    planes.grid().1.saturating_sub(2).div_ceil(crate::hdr_fit::WIDE_STRIDE)
}

fn columns(planes: &Planes<'_>) -> usize {
    planes.grid().0.saturating_sub(2).div_ceil(crate::hdr_fit::WIDE_STRIDE)
}

fn gains_of(gpu: &'static crate::gpu::Gpu, falloff: Option<(f64, f64)>) -> crate::gpu::Buffer {
    let contents: Vec<u8> = match falloff {
        None => vec![0u8; 4],
        Some((a, b)) => (0..=u8::MAX)
            .flat_map(|r| (crate::fit::Gain::at(a, b, r) as f32).to_ne_bytes())
            .collect(),
    };
    gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit wide gains"),
        contents: &contents,
        usage: wgpu::BufferUsages::STORAGE,
    })
}

fn bound(
    gpu: &'static crate::gpu::Gpu,
    planes: &Planes<'_>,
    gains: &crate::gpu::Buffer,
    found: &crate::gpu::Buffer,
    counts: &crate::gpu::Buffer,
    at: &crate::gpu::Buffer,
    samples: &crate::gpu::Buffer,
    push: &crate::gpu::Buffer,
) -> wgpu::BindGroup {
    gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("fit_wide"),
        layout: &kernels(gpu).layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: planes.ours.buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: planes.theirs.buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: gains.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: found.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: counts.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: at.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: samples.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
        ],
    })
}

/// Which positions the pass will teach the lattice from.
pub(crate) async fn admit(
    gpu: &'static crate::gpu::Gpu,
    planes: &Planes<'_>,
) -> Option<Admitted> {
    let stepped = rows(planes) * columns(planes);
    let blocks = stepped.div_ceil(BLOCK).max(1);
    let storage = wgpu::BufferUsages::STORAGE;
    let readable = storage | wgpu::BufferUsages::COPY_SRC;
    let held = |label, words: usize, usage| {
        gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: (words * 4).max(4) as u64,
            usage,
            mapped_at_creation: false,
        })
    };
    let counts = held("fit wide counts", blocks + 1, readable);
    let gains = gains_of(gpu, planes.falloff);
    // A stub each for the read slot and for *both* write slots: one buffer bound twice as writable
    // storage in a single dispatch is aliasing, whichever of the two the kernel actually touches.
    // WebGPU refuses the command and the browser's decode ends in a panic where Vulkan says
    // nothing.
    let idle = held("unused", 1, storage);
    let spare = held("unused", 1, storage);
    let spare_samples = held("unused", 1, storage);

    let mut recording = gpu.record();
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit_wide push"),
        contents: bytemuck::bytes_of(&block(planes, blocks, 0)),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let group = bound(gpu, planes, &gains, &idle, &counts, &spare, &spare_samples, &push);
    let over_blocks = (blocks as u32).div_ceil(64);
    let built = kernels(gpu);
    // A pass each: the scan reads what the count wrote.
    for (pipeline, dispatch) in [(&built.count, over_blocks), (&built.offsets, 1)] {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(dispatch, 1, 1);
    }
    let out = held("fit wide counts out", blocks + 1, wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST);
    recording.encoder().copy_buffer_to_buffer(&counts, 0, &out, 0, ((blocks + 1) * 4) as u64);
    recording.submit();
    let scanned = read_words(gpu, &out).await?;
    let count = scanned[blocks] as usize;

    let at = held("fit wide at", (count * 2).max(1), readable);
    let mut recording = gpu.record();
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&built.write);
        let group = bound(gpu, planes, &gains, &idle, &counts, &at, &spare, &push);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(over_blocks, 1, 1);
    }
    let positions = held(
        "fit wide at out",
        (count * 2).max(1),
        wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
    );
    let bytes = (count * 2 * 4).max(4) as u64;
    recording.encoder().copy_buffer_to_buffer(&at, 0, &positions, 0, bytes);
    recording.submit();
    let read = read_words(gpu, &positions).await?;
    Some(Admitted {
        at: (0..count).map(|k| [read[k * 2] as i32, read[k * 2 + 1] as i32]).collect(),
        on_device: at,
    })
}

/// What the pair at each admitted position is, about the offset `found` holds for it.
///
/// `None` where the position did not survive the gather's own re-tests, which are asked of the
/// pixel the search landed on rather than the one the gate looked at.
pub(crate) async fn gather(
    gpu: &'static crate::gpu::Gpu,
    planes: &Planes<'_>,
    admitted: &Admitted,
    found: &crate::gpu::Buffer,
) -> Option<Vec<Option<([f64; 3], [f64; 3])>>> {
    let count = admitted.at.len();
    let words = (count * SAMPLE_WORDS).max(1);
    let storage = wgpu::BufferUsages::STORAGE;
    let samples = gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some("fit wide samples"),
        size: (words * 4) as u64,
        usage: storage | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let gains = gains_of(gpu, planes.falloff);
    let mut recording = gpu.record();
    recording.holding(found);
    recording.holding(&admitted.on_device);
    let idle = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("unused"),
        size: 4,
        usage: storage,
        mapped_at_creation: false,
    });
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit_wide push"),
        contents: bytemuck::bytes_of(&block(planes, 1, count)),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernels(gpu).gather);
        let group =
            bound(gpu, planes, &gains, found, &idle, &admitted.on_device, &samples, &push);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((count as u32).div_ceil(64).max(1), 1, 1);
    }
    let out = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit wide samples out"),
        size: (words * 4) as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    recording.encoder().copy_buffer_to_buffer(&samples, 0, &out, 0, (words * 4) as u64);
    recording.submit();

    let read = crate::gpu::read_back(gpu, &out, |mapped| {
        mapped
            .chunks_exact(4)
            .map(|word| f32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
            .collect::<Vec<f32>>()
    })
    .await?;
    Some(
        read.chunks_exact(SAMPLE_WORDS)
            .take(count)
            .map(|s| {
                (s[6] != 0.0).then(|| {
                    let of = |at: usize| f64::from(s[at]);
                    ([of(0), of(1), of(2)], [of(3), of(4), of(5)])
                })
            })
            .collect(),
    )
}

async fn read_words(
    gpu: &'static crate::gpu::Gpu,
    staging: &crate::gpu::Buffer,
) -> Option<Vec<u32>> {
    crate::gpu::read_back(gpu, staging, |mapped| {
        mapped
            .chunks_exact(4)
            .map(|word| u32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
            .collect::<Vec<u32>>()
    })
    .await
}

#[cfg(test)]
mod tests {
    /// The stride the shader writes a sample at and the host reads one back at, stated on both
    /// sides. A value that moved on one reads each sample's fields out of its neighbour's, which
    /// is a plane of plausible numbers rather than a failure.
    #[test]
    fn the_host_reads_a_sample_at_the_width_the_shader_wrote_it() {
        const SOURCE: &str = include_str!("../../../slang/fit_wide.slang");
        let line = format!("static const int SAMPLE_WORDS = {};", super::SAMPLE_WORDS);
        assert!(SOURCE.contains(&line), "fit_wide.slang does not say `{line}`");
    }
}
