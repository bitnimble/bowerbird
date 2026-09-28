//! How much a pixel's chroma scatters, per level of the lattice, on the plane a rendition's pixels
//! are like rather than on the fit grid that averaged them.
//!
//! `slang/fit_noise.slang` is the arithmetic. What crosses back is three floats a level a block.

use crate::hdr_fit::MAP_LEVEL;

/// `fit_pairs.slang`'s `FRAME`. Every bit below it is written only past the mask's gradient gate,
/// so a pixel carrying any of them sits on no edge.
const FRAME: u32 = 32;

/// Per level, both chroma axes' variances summed and the 2x2s that gave them.
const NOISE_WORDS: usize = 3 * MAP_LEVEL;

/// 2x2s one thread walks.
const NOISE_BLOCK: usize = 1024;

struct Kernel {
    layout: wgpu::BindGroupLayout,
    noise: wgpu::ComputePipeline,
}

fn kernel(gpu: &'static crate::gpu::Gpu) -> &'static Kernel {
    static BUILT: std::sync::OnceLock<Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fit_noise"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_noise.wgsl")).into(),
            ),
        });
        let entry = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let read = wgpu::BufferBindingType::Storage { read_only: true };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("fit_noise"),
            entries: &[
                entry(0, read),
                entry(1, read),
                entry(2, wgpu::BufferBindingType::Storage { read_only: false }),
                entry(20, wgpu::BufferBindingType::Uniform),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fit_noise"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        Kernel {
            noise: device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("fit_noise"),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some("fit_noise"),
                compilation_options: Default::default(),
                cache: None,
            }),
            layout,
        }
    })
}

/// Per level of a lattice laid out at `level_scale`, the chroma variance on each of its two axes
/// in the linear units the lattice's inputs arrive in, or None where no flat 2x2 landed there.
///
/// `evaluated` is the model's output over every pixel of a `width` x `height` plane, and `bits`
/// the fit grid's mask.
pub(crate) async fn by_level(
    gpu: &'static crate::gpu::Gpu,
    evaluated: &crate::gpu::Buffer,
    (width, height): (usize, usize),
    bits: &crate::gpu::Buffer,
    (grid_width, grid_height): (usize, usize),
    level_scale: f64,
) -> Option<[Option<[f64; 2]>; MAP_LEVEL]> {
    let quads = (width / 2) * (height / 2);
    if quads == 0 {
        return Some([None; MAP_LEVEL]);
    }
    let blocks = quads.div_ceil(NOISE_BLOCK);
    let words = blocks * NOISE_WORDS;

    let mut recording = gpu.record();
    recording.holding(evaluated);
    recording.holding(bits);
    let partial = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit noise partials"),
        size: (words * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let push: Vec<u8> = [
        (width as i32).to_ne_bytes(),
        (height as i32).to_ne_bytes(),
        (grid_width as i32).to_ne_bytes(),
        (grid_height as i32).to_ne_bytes(),
        (blocks as i32).to_ne_bytes(),
        (NOISE_BLOCK as i32).to_ne_bytes(),
        (level_scale as f32).to_ne_bytes(),
        (FRAME - 1).to_ne_bytes(),
    ]
    .concat();
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit_noise push"),
        contents: &push,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("fit_noise"),
        layout: &kernel(gpu).layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: evaluated.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: bits.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: partial.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel(gpu).noise);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((blocks as u32).div_ceil(64), 1, 1);
    }
    let staging = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit noise out"),
        size: (words * 4) as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    recording.encoder().copy_buffer_to_buffer(&partial, 0, &staging, 0, (words * 4) as u64);
    recording.submit();

    let read = crate::gpu::read_back(gpu, &staging, |mapped| {
        mapped
            .chunks_exact(4)
            .map(|word| f64::from(f32::from_ne_bytes([word[0], word[1], word[2], word[3]])))
            .collect::<Vec<f64>>()
    })
    .await?;
    // Folded in block order, which is what makes this the same answer on every adapter.
    let mut sums = [0.0f64; NOISE_WORDS];
    for block in read.chunks_exact(NOISE_WORDS).take(blocks) {
        for (sum, word) in sums.iter_mut().zip(block) {
            *sum += word;
        }
    }
    Some(std::array::from_fn(|z| {
        let seen = sums[z * 3 + 2];
        (seen > 0.0).then(|| [sums[z * 3] / seen, sums[z * 3 + 1] / seen])
    }))
}

#[cfg(test)]
mod tests {
    /// The constants the host and the shader each state for themselves.
    #[test]
    fn the_shader_bins_the_levels_the_host_reads() {
        const NOISE: &str = include_str!("../../../slang/fit_noise.slang");
        const PAIRS: &str = include_str!("../../../slang/fit_pairs.slang");
        let levels = format!("static const int MAP_LEVEL = {};", super::MAP_LEVEL);
        assert!(NOISE.contains(&levels), "fit_noise.slang does not say `{levels}`");
        let frame = format!("static const uint FRAME = {};", super::FRAME);
        assert!(PAIRS.contains(&frame), "fit_pairs.slang does not say `{frame}`");
    }

    /// Each level's variances, on the device, as the host works them out from the same plane: flat
    /// grid pixels only, a bit at or past `FRAME` not being flat.
    #[test]
    fn the_device_measures_the_scatter_the_host_does() {
        let Some(gpu) = crate::gpu::device() else { return };
        let (width, height, grid_width, grid_height) = (64usize, 48usize, 32usize, 24usize);
        let level_scale = 8.0;
        let mut seed = 5u64;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as f64 / (1u64 << 31) as f64
        };
        let evaluated: Vec<[f32; 4]> = (0..width * height)
            .map(|p| {
                let level = ((p / width) as f64 / height as f64).powi(2);
                let jitter = 0.05 * (1.0 + (p % 7) as f64);
                let c = [0, 1, 2].map(|_| (level + jitter * (next() - 0.5)) as f32);
                [c[0], c[1], c[2], level as f32]
            })
            .collect();
        let bits: Vec<u32> = (0..grid_width * grid_height)
            .map(|g| match g % 3 {
                0 => 1,
                1 => 0,
                _ => super::FRAME,
            })
            .collect();
        let upload = |label, bytes: Vec<u8>| {
            gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: &bytes,
                usage: wgpu::BufferUsages::STORAGE,
            })
        };
        let device = pollster::block_on(super::by_level(
            gpu,
            &upload("evaluated", evaluated.iter().flatten().flat_map(|v| v.to_ne_bytes()).collect()),
            (width, height),
            &upload("bits", bits.iter().flat_map(|v| v.to_ne_bytes()).collect()),
            (grid_width, grid_height),
            level_scale,
        ))
        .expect("measured");

        let mut sums = [[0.0f64; 3]; super::MAP_LEVEL];
        for qy in 0..height / 2 {
            for qx in 0..width / 2 {
                let (gx, gy) = ((qx * 2 * grid_width / width), (qy * 2 * grid_height / height));
                if bits[gy * grid_width + gx] & (super::FRAME - 1) == 0 {
                    continue;
                }
                let e: [[f64; 4]; 4] = std::array::from_fn(|i| {
                    evaluated[(2 * qy + (i >> 1)) * width + 2 * qx + (i & 1)].map(f64::from)
                });
                let mean: [f64; 4] = std::array::from_fn(|c| e.iter().map(|v| v[c]).sum::<f64>() / 4.0);
                let spread = |c: usize| {
                    e.iter().map(|v| ((v[c] - v[3]) - (mean[c] - mean[3])).powi(2)).sum::<f64>() / 3.0
                };
                let level = ((mean[3].max(0.0).sqrt() * level_scale).round() as usize).min(super::MAP_LEVEL - 1);
                sums[level] = [sums[level][0] + spread(0), sums[level][1] + spread(2), sums[level][2] + 1.0];
            }
        }
        let mut seen = 0;
        for (z, [s0, s2, n]) in sums.iter().enumerate() {
            match device[z] {
                None => assert_eq!(*n, 0.0, "level {z}"),
                Some([v0, v2]) => {
                    seen += 1;
                    for (got, want) in [(v0, s0 / n), (v2, s2 / n)] {
                        assert!((got - want).abs() <= 1e-4 * want.abs(), "level {z}: {got} against {want}");
                    }
                }
            }
        }
        assert!(seen > 3, "{seen} levels measured");
    }
}
