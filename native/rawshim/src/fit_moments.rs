//! The camera match's normal equations, summed where the pairs already are.
//!
//! `slang/fit_moments.slang` is the fold. What crosses back is thirty-six floats a block and
//! matrix, rather than a colour per pair - 150k of them, three times a fit - for the host to sum
//! the same numbers itself. The 3x3 solve stays on the host: it reads those and nothing else, so
//! a dispatch for it would be all round trip and no work.

/// Twenty-seven for the three rows' `A^T A` and nine for `A^T b`, which is `Moments` exactly.
pub(crate) const MOMENT_WORDS: usize = 36;

struct Kernel {
    layout: wgpu::BindGroupLayout,
    moments: wgpu::ComputePipeline,
}

fn kernel(gpu: &'static crate::gpu::Gpu) -> &'static Kernel {
    static BUILT: std::sync::OnceLock<Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fit_moments"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_moments.wgsl")).into(),
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
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("fit_moments"),
            entries: &[
                entry(0, read),
                entry(1, read),
                entry(2, wgpu::BufferBindingType::Storage { read_only: false }),
                entry(3, read),
                entry(20, wgpu::BufferBindingType::Uniform),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fit_moments"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        Kernel {
            moments: device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("fit_moments"),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some("fit_moments"),
                compilation_options: Default::default(),
                cache: None,
            }),
            layout,
        }
    })
}

/// Per matrix, the per-block partials of each row's `A^T A` and of `A^T b`, in block order, with
/// every crushed channel counted where that matrix overshoots it.
///
/// Returned rather than folded here so the caller sums them in the order it chose, which is what
/// makes the answer the same on every adapter.
pub(crate) async fn partials(
    gpu: &'static crate::gpu::Gpu,
    below: &crate::gpu::Buffer,
    target: &crate::gpu::Buffer,
    pairs: usize,
    block: usize,
    matrices: &[[[f64; 3]; 3]],
) -> Option<Vec<Vec<[f64; MOMENT_WORDS]>>> {
    if pairs == 0 || matrices.is_empty() {
        return Some(vec![Vec::new(); matrices.len()]);
    }
    let blocks = pairs.div_ceil(block);
    let words = matrices.len() * blocks * MOMENT_WORDS;

    let mut recording = gpu.record();
    recording.holding(below);
    recording.holding(target);
    let partial = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit moments partials"),
        size: (words * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let matrices_on = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit moments matrices"),
        contents: &matrices
            .iter()
            .flatten()
            .flatten()
            .flat_map(|v| (*v as f32).to_ne_bytes())
            .collect::<Vec<u8>>(),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let push: Vec<u8> = [
        (pairs as i32).to_ne_bytes(),
        (blocks as i32).to_ne_bytes(),
        (block as i32).to_ne_bytes(),
        (crate::hdr_fit::CAMERA_CRUSHED as f32).to_ne_bytes(),
        (matrices.len() as i32).to_ne_bytes(),
        [0; 4],
        [0; 4],
        [0; 4],
    ]
    .concat();
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit_moments push"),
        contents: &push,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("fit_moments"),
        layout: &kernel(gpu).layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: below.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: target.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: partial.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: matrices_on.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 20,
                resource: push.as_entire_binding(),
            },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel(gpu).moments);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(((matrices.len() * blocks) as u32).div_ceil(64), 1, 1);
    }
    let staging = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit moments out"),
        size: (words * 4) as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    recording
        .encoder()
        .copy_buffer_to_buffer(&partial, 0, &staging, 0, (words * 4) as u64);
    recording.submit();

    let read = crate::gpu::read_back(gpu, &staging, |mapped| {
        mapped
            .chunks_exact(4)
            .map(|word| f64::from(f32::from_ne_bytes([word[0], word[1], word[2], word[3]])))
            .collect::<Vec<f64>>()
    })
    .await?;
    Some(
        read.chunks_exact(blocks * MOMENT_WORDS)
            .take(matrices.len())
            .map(|probe| {
                probe
                    .chunks_exact(MOMENT_WORDS)
                    .map(|block| std::array::from_fn(|i| block[i]))
                    .collect()
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    /// The block layout the host reads a partial at, which the shader states for itself.
    #[test]
    fn the_host_folds_the_words_the_shader_writes() {
        const SOURCE: &str = include_str!("../../../slang/fit_moments.slang");
        let line = format!("static const int MOMENT_WORDS = {};", super::MOMENT_WORDS);
        assert!(
            SOURCE.contains(&line),
            "fit_moments.slang does not say `{line}`"
        );
    }
}
