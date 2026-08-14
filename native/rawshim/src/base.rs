//! The base frame's own stages, on the GPU.
//!
//! Everything between the demosaic and the grade that both a rendition and the editor's open run:
//! the coding, the filters that are not the sharpen, the warp, and the two whole-frame numbers the
//! rest of them read. Measured on a 61MP frame, and this is why they are worth moving at all -
//! `open levels` 158ms, `open code, defringe` 1170ms, `open lens warp` 639ms and
//! `open noise measure` 1021ms, against a decode that is already on the GPU either side of them.
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
        "{}\n{}",
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/prelude.wgsl"),
        include_str!("wgsl/base.wgsl"),
    )
}

pub struct Base {
    layout: wgpu::BindGroupLayout,
    encode: wgpu::ComputePipeline,
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
        Some(Base { layout, encode })
    }
}

/// A megabyte at a time, for the reason `galosh` and `demosaic` give: the staged copy would
/// otherwise be a second whole frame, and at 61MP that is 361MB beside one that is already the
/// largest thing in the process.
const CHUNK: usize = 1 << 18;

/// Scene-linear levels to normalised PQ, as [`crate::tone::encode_base`] does it.
///
/// Takes and returns the frame rather than leaving it on the GPU, which is not where this ends up
/// - the point of the module is that the stages chain over one resident buffer - but is what lets
/// it be held against the CPU one stage at a time while they move across.
pub fn encode_base(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &mut [u16],
    levels: crate::tone::Anchored,
    reference_white_nits: f64,
) -> Option<()> {
    let device = &gpu.device;
    let words = samples.len().div_ceil(2);
    if words == 0 {
        return Some(());
    }

    let frame = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("base frame"),
        size: (words * 4) as u64,
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

    let params = [
        words as u32,
        samples.len() as u32,
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

    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("base readback"),
        size: (words * 4) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.encode);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((words as u32).div_ceil(64), 1, 1);
    }
    encoder.copy_buffer_to_buffer(&frame, 0, &readback, 0, (words * 4) as u64);
    gpu.queue.submit([encoder.finish()]);

    readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    device.poll(wgpu::PollType::wait_indefinitely()).ok()?;
    {
        let mapped = readback.slice(..).get_mapped_range().ok()?;
        for (sample, pair) in samples.iter_mut().zip(mapped.chunks_exact(2)) {
            *sample = u16::from_le_bytes([pair[0], pair[1]]);
        }
    }
    readback.unmap();
    Some(())
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
}
