//! How far this frame's chroma reaches on each of the lattice's axes.
//!
//! `slang/fit_span.slang` is the arithmetic: a sample per pixel of the sharp plane, the colour
//! model over them, and an exact rank taken twice on each axis. What crosses back is four floats,
//! rather than a sample per pixel up and the whole evaluated plane down again.

/// Buckets each half of a selection counts into.
const HALF_BINS: usize = 65536;
/// One high half and one low half per rank, per axis.
const AXIS_BINS: usize = 3 * HALF_BINS;
/// A bucket, a running count, and the picked value.
const PER_RANK: usize = 3;
const MARKS_PER_AXIS: usize = 2 * PER_RANK;
/// Where in a rank's marks the answer lands.
const PICKED: usize = 2;

struct Kernels {
    layout: wgpu::BindGroupLayout,
    gather: wgpu::ComputePipeline,
    high: wgpu::ComputePipeline,
    pick: wgpu::ComputePipeline,
    low: wgpu::ComputePipeline,
    finish: wgpu::ComputePipeline,
}

fn kernels(gpu: &'static crate::gpu::Gpu) -> &'static Kernels {
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
            ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
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

/// Both ranks of both axes: `[axis][rank]`, in the units the lattice is sized in.
pub(crate) async fn spans(
    gpu: &'static crate::gpu::Gpu,
    colour: &crate::hdr_fit::HdrColour,
    plane: &crate::hdr_fit::Source,
    falloff: Option<(f64, f64)>,
    ranks: [usize; 2],
) -> Option<[[f64; 2]; 2]> {
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
    let samples = held("fit span samples", pixels * 4, storage);

    // The gather is a submit of its own because the model runs between it and the ranking, and the
    // model is a submit of `hdr_fit`'s own.
    let mut recording = gpu.record();
    recording.holding(&plane.buffer);
    let gains: Vec<u8> = match falloff {
        None => vec![0u8; 4],
        Some((a, b)) => (0..=u8::MAX)
            .flat_map(|r| (crate::fit::Gain::at(a, b, r) as f32).to_ne_bytes())
            .collect(),
    };
    let gains = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit span gains"),
        contents: &gains,
        usage: storage,
    });
    // Zeroed by the driver, which the counting relies on.
    let histogram = held("fit span histogram", 2 * AXIS_BINS, storage);
    let marks = held("fit span marks", 2 * MARKS_PER_AXIS, storage | wgpu::BufferUsages::COPY_SRC);
    let (cx, cy) = (plane.width as f64 / 2.0, plane.height as f64 / 2.0);
    let half = (cx * cx + cy * cy).sqrt().max(1.0);
    let built = kernels(gpu);
    let describing = |axis: usize| {
        let mut block: Vec<u8> = [
            (plane.width as i32).to_ne_bytes(),
            (plane.height as i32).to_ne_bytes(),
            i32::from(falloff.is_some()).to_ne_bytes(),
            (half as f32).to_ne_bytes(),
            (axis as i32).to_ne_bytes(),
            (ranks[0] as i32).to_ne_bytes(),
            (ranks[1] as i32).to_ne_bytes(),
        ]
        .concat();
        // Seven fields is twenty-eight bytes and a uniform block is rounded up to sixteen.
        block.resize(32, 0);
        gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("fit_span push"),
            contents: &block,
            usage: wgpu::BufferUsages::UNIFORM,
        })
    };
    // One layout serves the gather and the ranking, and each binds a stub where the other's plane
    // goes: `samples` bound as both the written and the read one in a single dispatch is a
    // conflicting usage, whichever of the two the kernel actually touches.
    let idle = held("unused", 1, storage);
    let pushes: Vec<crate::gpu::Buffer> = (0..2).map(describing).collect();
    let gathering = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("fit_span gather"),
        layout: &built.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: plane.buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: gains.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: samples.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: idle.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: histogram.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: marks.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 20, resource: pushes[0].as_entire_binding() },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&built.gather);
        pass.set_bind_group(0, &gathering, &[]);
        pass.dispatch_workgroups(
            (plane.width as u32).div_ceil(16),
            (plane.height as u32).div_ceil(16),
            1,
        );
    }
    recording.submit();

    let evaluated =
        crate::hdr_fit::evaluate_over(gpu, colour, &samples, pixels, crate::hdr_fit::Stage::ToneMatrix);

    // The ranking reads what the model wrote, so the bind group points at that rather than at the
    // samples the gather filled - the two are the same shape and the second overwrites nothing.
    let ranking: Vec<wgpu::BindGroup> = pushes
        .iter()
        .map(|push| {
            gpu.bind_group(&wgpu::BindGroupDescriptor {
                label: Some("fit_span rank"),
                layout: &built.layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: plane.buffer.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: gains.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: idle.as_entire_binding() },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: evaluated.buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry { binding: 4, resource: histogram.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 5, resource: marks.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
                ],
            })
        })
        .collect();

    let mut recording = gpu.record();
    let over_samples = (pixels as u32).div_ceil(64);
    // A pass each, which is what orders them: every step reads what the step before it wrote.
    for axis in 0..2 {
        for (pipeline, dispatch) in [
            (&built.high, over_samples),
            (&built.pick, 1),
            (&built.low, over_samples),
            (&built.finish, 1),
        ] {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &ranking[axis], &[]);
            pass.dispatch_workgroups(dispatch, 1, 1);
        }
    }
    let words = 2 * MARKS_PER_AXIS;
    let out = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit span out"),
        size: (words * 4) as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    recording.encoder().copy_buffer_to_buffer(&marks, 0, &out, 0, (words * 4) as u64);
    recording.submit();

    let read = crate::gpu::read_back(gpu, &out, |mapped| {
        mapped
            .chunks_exact(4)
            .map(|word| u32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
            .collect::<Vec<u32>>()
    })
    .await?;
    Some(std::array::from_fn(|axis| {
        std::array::from_fn(|rank| {
            let at = axis * MARKS_PER_AXIS + rank * PER_RANK + PICKED;
            f64::from(f32::from_bits(read[at]))
        })
    }))
}

#[cfg(test)]
mod tests {
    /// The shape of the buffers the host allocates and the shader indexes, which each states for
    /// itself. A value that moved on one side reads a rank out of another rank's marks - a span
    /// that is wrong rather than absent, so nothing downstream would report it.
    #[test]
    fn the_shader_marks_the_buckets_the_host_allocates() {
        const SOURCE: &str = include_str!("../../../slang/fit_span.slang");
        for line in [
            format!("static const uint HALF_BINS = {};", super::HALF_BINS),
            format!("static const uint PER_RANK = {};", super::PER_RANK),
        ] {
            assert!(SOURCE.contains(&line), "fit_span.slang does not say `{line}`");
        }
    }
}
