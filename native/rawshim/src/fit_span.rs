//! How far this frame's chroma reaches on the lattice's chroma axis.
//!
//! `slang/fit_span.slang` is the arithmetic: a sample per pixel of the sharp plane, the colour
//! model over them, and an exact rank of their chroma. What crosses back is one float, rather than
//! a sample per pixel up and the whole evaluated plane down again.

/// Buckets each half of a selection counts into.
const HALF_BINS: usize = 65536;
/// A bucket, a running count, and the picked value.
const MARKS: usize = 3;
const PICKED: usize = 2;

pub(crate) struct Kernels {
    layout: wgpu::BindGroupLayout,
    gather: wgpu::ComputePipeline,
    high: wgpu::ComputePipeline,
    pick: wgpu::ComputePipeline,
    low: wgpu::ComputePipeline,
    finish: wgpu::ComputePipeline,
}

pub(crate) fn kernels(gpu: &'static crate::gpu::Gpu) -> &'static Kernels {
    static BUILT: std::sync::OnceLock<Kernels> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fit_span"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_span.wgsl")).into(),
            ),
        });
        let entry = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let read = wgpu::BufferBindingType::Storage { read_only: true };
        let write = wgpu::BufferBindingType::Storage { read_only: false };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("fit_span"),
            entries: &[
                entry(0, read),
                entry(1, read),
                entry(2, write),
                entry(3, read),
                entry(4, write),
                entry(5, write),
                entry(20, wgpu::BufferBindingType::Uniform),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fit_span"),
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
            gather: build("fit_span_gather"),
            high: build("fit_span_high"),
            pick: build("fit_span_pick"),
            low: build("fit_span_low"),
            finish: build("fit_span_finish"),
            layout,
        }
    })
}

/// Every pixel of `plane` as a sample the colour model reads, with the lens's falloff the plane
/// does not carry lifted in.
pub(crate) fn lifted(
    gpu: &'static crate::gpu::Gpu,
    plane: &crate::hdr_fit::Source,
    falloff: Option<(f64, f64)>,
) -> crate::gpu::Buffer {
    let storage = wgpu::BufferUsages::STORAGE;
    let sized = |label, words: usize| {
        gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: (words * 4).max(4) as u64,
            usage: storage,
            mapped_at_creation: false,
        })
    };
    let held = |label| sized(label, 1);
    let samples = sized("fit lifted samples", plane.width * plane.height * 4);
    let mut recording = gpu.record();
    recording.holding(&plane.buffer);
    let gains: Vec<u8> = match falloff {
        None => vec![0u8; 4],
        Some((a, b)) => (0..=u8::MAX)
            .flat_map(|r| (crate::fit::Gain::at(a, b, r) as f32).to_ne_bytes())
            .collect(),
    };
    let gains = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit lifted gains"),
        contents: &gains,
        usage: storage,
    });
    let push = describing(
        gpu,
        plane,
        falloff.is_some(),
        0,
        crate::lattice::IndexSpace::Jzazbz,
    );
    let (evaluated, histogram, marks) = (held("unused"), held("unused"), held("unused"));
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("fit_span gather"),
        layout: &kernels(gpu).layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: plane.buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: gains.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: samples.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: evaluated.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: histogram.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: marks.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 20,
                resource: push.as_entire_binding(),
            },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernels(gpu).gather);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(
            (plane.width as u32).div_ceil(16),
            (plane.height as u32).div_ceil(16),
            1,
        );
    }
    recording.submit();
    samples
}

fn describing(
    gpu: &'static crate::gpu::Gpu,
    plane: &crate::hdr_fit::Source,
    falloff: bool,
    rank: usize,
    space: crate::lattice::IndexSpace,
) -> crate::gpu::Buffer {
    let (cx, cy) = (plane.width as f64 / 2.0, plane.height as f64 / 2.0);
    let half = (cx * cx + cy * cy).sqrt().max(1.0);
    let block: Vec<u8> = [
        (plane.width as i32).to_ne_bytes(),
        (plane.height as i32).to_ne_bytes(),
        i32::from(falloff).to_ne_bytes(),
        (half as f32).to_ne_bytes(),
        (rank as i32).to_ne_bytes(),
        space.word().to_ne_bytes(),
        0i32.to_ne_bytes(),
        0i32.to_ne_bytes(),
    ]
    .concat();
    gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit_span push"),
        contents: &block,
        usage: wgpu::BufferUsages::UNIFORM,
    })
}

/// The opponent chroma `space` gives the sample at `rank`, over `evaluated`, which is the model's
/// output over every pixel of `plane` as [`lifted`].
pub(crate) async fn ranked_chroma(
    gpu: &'static crate::gpu::Gpu,
    evaluated: &crate::gpu::Buffer,
    plane: &crate::hdr_fit::Source,
    rank: usize,
    space: crate::lattice::IndexSpace,
) -> Option<f64> {
    let pixels = plane.width * plane.height;
    let held = |label, words: usize, usage| {
        gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: (words * 4).max(4) as u64,
            usage,
            mapped_at_creation: false,
        })
    };
    let storage = wgpu::BufferUsages::STORAGE;
    // Zeroed by the driver, which the counting relies on.
    let histogram = held("fit span histogram", 2 * HALF_BINS, storage);
    let marks = held(
        "fit span marks",
        MARKS,
        storage | wgpu::BufferUsages::COPY_SRC,
    );
    let built = kernels(gpu);
    let idle = held("unused", 1, storage);
    let no_gains = held("unused gains", 1, storage);
    let push = describing(gpu, plane, false, rank, space);

    // The ranking reads what the model wrote, so the bind group points at that rather than at the
    // samples the gather filled - the two are the same shape and the second overwrites nothing.
    let ranking = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("fit_span rank"),
        layout: &built.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: plane.buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: no_gains.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: idle.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: evaluated.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: histogram.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: marks.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 20,
                resource: push.as_entire_binding(),
            },
        ],
    });

    let mut recording = gpu.record();
    let over_samples = (pixels as u32).div_ceil(64);
    // A pass each, which is what orders them: every step reads what the step before it wrote.
    for (pipeline, dispatch) in [
        (&built.high, over_samples),
        (&built.pick, 1),
        (&built.low, over_samples),
        (&built.finish, 1),
    ] {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &ranking, &[]);
        pass.dispatch_workgroups(dispatch, 1, 1);
    }
    let out = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit span out"),
        size: (MARKS * 4) as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    recording
        .encoder()
        .copy_buffer_to_buffer(&marks, 0, &out, 0, (MARKS * 4) as u64);
    recording.submit();

    let read = crate::gpu::read_back(gpu, &out, |mapped| {
        mapped
            .chunks_exact(4)
            .map(|word| u32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
            .collect::<Vec<u32>>()
    })
    .await?;
    Some(f64::from(f32::from_bits(read[PICKED])))
}

#[cfg(test)]
mod tests {
    /// The bucket count the host allocates for and the shader indexes, which each states for itself.
    /// A value that moved on one side walks the low half off the end of the high one - a span that
    /// is wrong rather than absent, so nothing downstream would report it.
    #[test]
    fn the_shader_marks_the_buckets_the_host_allocates() {
        const SOURCE: &str = include_str!("../../../slang/fit_span.slang");
        let line = format!("static const uint HALF_BINS = {};", super::HALF_BINS);
        assert!(
            SOURCE.contains(&line),
            "fit_span.slang does not say `{line}`"
        );
    }
}
