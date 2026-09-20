//! The chroma lattice's moments, summed where the pairs already are.
//!
//! `slang/fit_lattice.slang` is the arithmetic. What crosses back is twenty-six sums a node -
//! thirty-four thousand floats - where a colour a pair used to, and the host reads them into the
//! same `ChromaMoments` the per-node solves have always taken.
//!
//! **A pair lands on sixteen nodes, so this needed a compaction the other folds did not.** The
//! landings are binned by their cell in pair order, and a thread per (node, corner) then walks the
//! one cell that reaches it that way. Twenty-one thousand threads rather than the lattice's
//! thirteen hundred, which is what makes it worth doing at all.

/// Sums a node carries, which `fit_lattice.slang` states for itself.
pub(crate) const NODE_WORDS: usize = 26;
/// Words a landing occupies on the device.
const LANDING_WORDS: usize = 12;
/// Corners of a cell, which is how many cells a node is a corner of.
const CORNERS: usize = 16;
/// Pairs one thread of the count and the write walks.
const BLOCK: usize = 4096;

struct Kernels {
    layout: wgpu::BindGroupLayout,
    land: wgpu::ComputePipeline,
    count: wgpu::ComputePipeline,
    total: wgpu::ComputePipeline,
    scan: wgpu::ComputePipeline,
    write: wgpu::ComputePipeline,
    gather: wgpu::ComputePipeline,
    fold: wgpu::ComputePipeline,
}

fn kernels(gpu: &'static crate::gpu::Gpu) -> &'static Kernels {
    static BUILT: std::sync::OnceLock<Kernels> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fit_lattice"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_lattice.wgsl")).into(),
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
            label: Some("fit_lattice"),
            entries: &[
                entry(0, read),
                entry(1, read),
                entry(2, read),
                entry(3, read),
                entry(4, write),
                entry(5, write),
                entry(6, write),
                entry(7, write),
                entry(8, write),
                entry(20, wgpu::BufferBindingType::Uniform),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fit_lattice"),
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
            land: build("lat_land"),
            count: build("lat_count"),
            total: build("lat_total"),
            scan: build("lat_scan"),
            write: build("lat_write"),
            gather: build("lat_gather"),
            fold: build("lat_fold"),
            layout,
        }
    })
}

/// Where the lattice's axes sit for this frame, as the shader reads them.
pub(crate) struct Axes {
    pub low: [f64; 2],
    pub scale: [f64; 2],
    pub level: f64,
    pub surround: f64,
}

/// Every pair's landing, folded into the twenty-six sums each node carries.
pub(crate) async fn moments(
    gpu: &'static crate::gpu::Gpu,
    through: &crate::gpu::Buffer,
    target: &crate::gpu::Buffer,
    surround: &crate::gpu::Buffer,
    weights: &crate::gpu::Buffer,
    pairs: usize,
    axes: &Axes,
    nodes: usize,
    cells: usize,
) -> Option<Vec<[f64; NODE_WORDS]>> {
    if pairs == 0 {
        return Some(vec![[0.0; NODE_WORDS]; nodes]);
    }
    let blocks = pairs.div_ceil(BLOCK).max(1);
    let storage = wgpu::BufferUsages::STORAGE;

    let mut recording = gpu.record();
    recording.holding(through);
    recording.holding(target);
    recording.holding(surround);
    recording.holding(weights);
    let mut buffer = |label: &'static str, words: usize, usage: wgpu::BufferUsages| {
        recording.buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: (words * 4).max(4) as u64,
            usage,
            mapped_at_creation: false,
        })
    };
    let landed = buffer("fit lattice landings", pairs * LANDING_WORDS, storage);
    let counts = buffer("fit lattice counts", 2 * blocks * cells + cells, storage);
    let ordered = buffer("fit lattice order", pairs, storage);
    let corners = buffer("fit lattice corners", nodes * CORNERS * NODE_WORDS, storage);
    let out = buffer(
        "fit lattice moments",
        nodes * NODE_WORDS,
        storage | wgpu::BufferUsages::COPY_SRC,
    );
    let words = nodes * NODE_WORDS;
    let staging = buffer(
        "fit lattice out",
        words,
        wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
    );

    let mut block = [(pairs as i32), (BLOCK as i32), (blocks as i32)]
        .iter()
        .flat_map(|v| v.to_ne_bytes())
        .collect::<Vec<u8>>();
    for v in [axes.low[0], axes.scale[0], axes.low[1], axes.scale[1], axes.level, axes.surround] {
        block.extend((v as f32).to_ne_bytes());
    }
    block.resize(48, 0);
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit_lattice push"),
        contents: &block,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("fit_lattice"),
        layout: &kernels(gpu).layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: through.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: target.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: surround.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: weights.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: landed.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: counts.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: ordered.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 7, resource: corners.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 8, resource: out.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
        ],
    });

    // A pass each, because every one of them reads what the last wrote.
    let built = kernels(gpu);
    let over = |n: usize| (n as u32).div_ceil(64).max(1);
    for (pipeline, groups) in [
        (&built.land, over(pairs)),
        (&built.count, over(blocks)),
        (&built.total, over(cells)),
        (&built.scan, 1),
        (&built.write, over(blocks)),
        (&built.gather, over(nodes * CORNERS)),
        (&built.fold, over(nodes)),
    ] {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(groups, 1, 1);
    }
    recording.encoder().copy_buffer_to_buffer(&out, 0, &staging, 0, (words * 4) as u64);
    recording.submit();

    let read = crate::gpu::read_back(gpu, &staging, |mapped| {
        mapped
            .chunks_exact(4)
            .map(|word| f64::from(f32::from_ne_bytes([word[0], word[1], word[2], word[3]])))
            .collect::<Vec<f64>>()
    })
    .await?;
    Some(
        read.chunks_exact(NODE_WORDS)
            .take(nodes)
            .map(|node| std::array::from_fn(|i| node[i]))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    /// The lattice's shape and a node's stride, both stated on each side.
    #[test]
    fn the_host_reads_the_lattice_the_shader_walks() {
        const SOURCE: &str = include_str!("../../../slang/fit_lattice.slang");
        for line in [
            format!("static const int NODE_WORDS = {};", super::NODE_WORDS),
            format!("static const int LANDING_WORDS = {};", super::LANDING_WORDS),
            format!("static const int CORNERS = {};", super::CORNERS),
            format!("static const int MAP_CHROMA = {};", crate::hdr_fit::MAP_CHROMA),
            format!("static const int MAP_LEVEL = {};", crate::hdr_fit::MAP_LEVEL),
            format!("static const int MAP_SURROUND = {};", crate::hdr_fit::MAP_SURROUND),
        ] {
            assert!(SOURCE.contains(&line), "fit_lattice.slang does not say `{line}`");
        }
    }
}
