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
    defringe_layout: wgpu::BindGroupLayout,
    defringe_luma: wgpu::ComputePipeline,
    defringe_apply: wgpu::ComputePipeline,
    noise_layout: wgpu::BindGroupLayout,
    noise_luma: wgpu::ComputePipeline,
    noise_blocks: wgpu::ComputePipeline,
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
        let defringe_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("defringe"),
            source: wgpu::ShaderSource::Wgsl(include_str!("wgsl/defringe.wgsl").into()),
        });
        let defringe_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("defringe"),
            entries: &[
                uniform_entry(0),
                storage_entry(1),
                storage_entry(2),
            ],
        });
        let defringe_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("defringe"),
                bind_group_layouts: &[Some(&defringe_layout)],
                immediate_size: 0,
            });
        let defringe = |entry: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&defringe_pipeline_layout),
                module: &defringe_module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };

        let noise_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("noise"),
            source: wgpu::ShaderSource::Wgsl(include_str!("wgsl/noise.wgsl").into()),
        });
        let noise_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("noise"),
            entries: &[
                uniform_entry(0),
                storage_entry(1),
                storage_entry(2),
                storage_entry(3),
            ],
        });
        let noise_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("noise"),
            bind_group_layouts: &[Some(&noise_layout)],
            immediate_size: 0,
        });
        let noise = |entry: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&noise_pipeline_layout),
                module: &noise_module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };

        Some(Base {
            layout,
            encode,
            defringe_layout,
            defringe_luma: defringe("defringe_luma"),
            defringe_apply: defringe("defringe_apply"),
            noise_layout,
            noise_luma: noise("noise_luma"),
            noise_blocks: noise("noise_blocks"),
        })
    }
}

fn uniform_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn storage_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only: false },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

/// Longitudinal chromatic aberration, as [`crate::image::finish_with`] takes it off with
/// `Strengths::before_the_fit`.
///
/// `defocus` is `measure_defocus`'s pair, already scaled by the setting - the measurement stays on
/// the CPU for now, which is a whole-frame reduction of its own and moves separately.
pub fn defringe(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &mut [u16],
    width: usize,
    height: usize,
    defocus: (f32, f32),
) -> Option<()> {
    // The same refusal `image::finish_in_strips` makes: a frame with no room for the stencil has
    // no curvature to read, and the border fill would be the whole of it.
    if width < 3 || height < 3 || defocus == (0.0, 0.0) || samples.len() < width * height * 3 {
        return Some(());
    }
    let device = &gpu.device;
    let pixels = width * height;
    let words = (pixels * 3).div_ceil(2);

    let frame = upload(gpu, samples);
    let luma = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("defringe luma"),
        size: (pixels * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });

    let mut params = Vec::with_capacity(32);
    params.extend_from_slice(&(width as u32).to_le_bytes());
    params.extend_from_slice(&(height as u32).to_le_bytes());
    params.extend_from_slice(&defocus.0.to_le_bytes());
    params.extend_from_slice(&defocus.1.to_le_bytes());
    for channel in crate::image::LUMA {
        params.extend_from_slice(&channel.to_le_bytes());
    }
    // `vec3f` is padded to four words, and the `full` after it lands in the hole rather than past
    // it - which is the same layout the shader declares and not a coincidence worth relying on
    // silently.
    params.extend_from_slice(&f32::from(u16::MAX).to_le_bytes());
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("defringe params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("defringe"),
        layout: &base.defringe_layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: frame.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: luma.as_entire_binding() },
        ],
    });

    let mut encoder = device.create_command_encoder(&Default::default());
    {
        // A pass each, because the second reads every value the first wrote and a pass is where
        // wgpu puts that barrier.
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.defringe_luma);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((pixels as u32).div_ceil(64), 1, 1);
    }
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.defringe_apply);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((pixels.div_ceil(2) as u32).div_ceil(64), 1, 1);
    }
    read_back(gpu, encoder, &frame, words, samples)
}

/// A megabyte at a time, for the reason `galosh` and `demosaic` give: the staged copy would
/// otherwise be a second whole frame, and at 61MP that is 361MB beside one that is already the
/// largest thing in the process.
const CHUNK: usize = 1 << 18;

/// The frame, packed two samples to a word.
fn upload(gpu: &crate::gpu::Gpu, samples: &[u16]) -> wgpu::Buffer {
    let words = samples.len().div_ceil(2);
    let frame = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("base frame"),
        size: (words * 4).max(4) as u64,
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
    frame
}

/// Submits the work and copies the frame back over the samples it came from.
fn read_back(
    gpu: &crate::gpu::Gpu,
    mut encoder: wgpu::CommandEncoder,
    frame: &wgpu::Buffer,
    words: usize,
    samples: &mut [u16],
) -> Option<()> {
    let readback = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("base readback"),
        size: (words * 4) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_buffer_to_buffer(frame, 0, &readback, 0, (words * 4) as u64);
    gpu.queue.submit([encoder.finish()]);

    readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).ok()?;
    {
        let mapped = readback.slice(..).get_mapped_range().ok()?;
        for (sample, pair) in samples.iter_mut().zip(mapped.chunks_exact(2)) {
            *sample = u16::from_le_bytes([pair[0], pair[1]]);
        }
    }
    readback.unmap();
    Some(())
}

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

    let frame = upload(gpu, samples);
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

    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.encode);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((words as u32).div_ceil(64), 1, 1);
    }
    read_back(gpu, encoder, &frame, words, samples)
}

/// The shader's stencil, and the size of the lap array it selects a median from.
///
/// Tiling the frame by one number and measuring it with another leaves an estimate that is
/// quietly wrong and a picture nobody would look at twice, so the two are held together here.
const BLOCK: usize = 8;
const _: () = assert!(BLOCK == crate::noise::BLOCK);

/// One dispatch's constants. `transform` is `alpha` and `sigma_sq` once the coarse pass has found
/// them, and `None` on the pass that measures the plane against itself.
fn noise_params(
    width: usize,
    height: usize,
    blocks: (usize, usize),
    transform: Option<(f32, f32)>,
) -> Vec<u8> {
    let (alpha, sigma_sq) = transform.unwrap_or((0.0, 0.0));
    // `crate::noise::stabilise`'s two constants, composed on this side so the shader evaluates the
    // same expression the CPU does rather than a second rounding of it.
    let c = 0.375 * alpha * alpha + sigma_sq;
    let mut out = Vec::with_capacity(32);
    for word in [width as u32, height as u32, blocks.0 as u32, blocks.1 as u32] {
        out.extend_from_slice(&word.to_le_bytes());
    }
    for value in [alpha, c, 2.0 / alpha.max(1e-12)] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.extend_from_slice(&u32::from(transform.is_some()).to_le_bytes());
    out
}

/// Submits the work and brings back one pair per block: its mean level, and its sigma.
fn read_blocks(
    gpu: &crate::gpu::Gpu,
    mut encoder: wgpu::CommandEncoder,
    stats: &wgpu::Buffer,
    count: usize,
) -> Option<Vec<[f32; 2]>> {
    let bytes = (count * 8) as u64;
    let readback = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("noise readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_buffer_to_buffer(stats, 0, &readback, 0, bytes);
    gpu.queue.submit([encoder.finish()]);

    readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).ok()?;
    let blocks = {
        let mapped = readback.slice(..).get_mapped_range().ok()?;
        mapped
            .chunks_exact(8)
            .map(|block| {
                let at = |o: usize| {
                    f32::from_le_bytes([block[o], block[o + 1], block[o + 2], block[o + 3]])
                };
                [at(0), at(4)]
            })
            .collect()
    };
    readback.unmap();
    Some(blocks)
}

/// What the prepared frame's noise is, as [`crate::noise::measure`] reads it.
///
/// **The GPU takes the pixels and the host keeps the quantiles**, which is the same line
/// `defringe` draws around its coefficients. The luma plane and the two block reductions are 61
/// million pixels apiece and are where the 1021ms is; the envelope and the binning run over the
/// ~941k block sigmas those produce - a few MB, read back once - and a quantile is the one shape a
/// GPU has nothing to offer over a `select_nth`. The tail here calls `noise`'s own `envelope` and
/// `typical` rather than reimplementing them, so the two paths cannot come to disagree about where
/// a percentile sits.
///
/// `None` where the GPU declines, including the frame too small to bin: the CPU answers that one
/// in microseconds and there is nothing to save.
pub fn measure(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &[u16],
    width: usize,
    height: usize,
) -> Option<crate::noise::Noise> {
    let pixels = width * height;
    let blocks = (width / BLOCK, height / BLOCK);
    let count = blocks.0 * blocks.1;
    if pixels == 0 || samples.len() < pixels * 3 || count == 0 {
        return None;
    }
    let device = &gpu.device;

    let frame = upload(gpu, samples);
    let plane = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("noise luma"),
        size: (pixels * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    let stats = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("noise blocks"),
        size: (count * 8) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let group = |uniform: &wgpu::Buffer| {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("noise"),
            layout: &base.noise_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: frame.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: plane.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: stats.as_entire_binding() },
            ],
        })
    };
    let uniform = |transform: Option<(f32, f32)>| {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("noise params"),
            contents: &noise_params(width, height, blocks, transform),
            usage: wgpu::BufferUsages::UNIFORM,
        })
    };

    let coarse_group = group(&uniform(None));
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        // A pass each, as the defringe's two are: every block reads luma the pass before it wrote,
        // and a pass is where wgpu puts that barrier.
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.noise_luma);
        pass.set_bind_group(0, &coarse_group, &[]);
        pass.dispatch_workgroups((pixels as u32).div_ceil(64), 1, 1);
    }
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.noise_blocks);
        pass.set_bind_group(0, &coarse_group, &[]);
        pass.dispatch_workgroups((count as u32).div_ceil(64), 1, 1);
    }
    let coarse = read_blocks(gpu, encoder, &stats, count)?;

    // One sigma to parameterise the transform with, and the round trip the split is built around:
    // the second pass cannot be encoded until this number exists.
    let mut all: Vec<f32> = coarse.iter().map(|block| block[1]).collect();
    let sigma = crate::noise::envelope(&mut all).unwrap_or(1e-5).max(1e-5);
    let alpha = (sigma * 0.1).max(1e-5);
    let sigma_sq = (sigma * sigma).max(1e-8);

    let measured_group = group(&uniform(Some((alpha, sigma_sq))));
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.noise_blocks);
        pass.set_bind_group(0, &measured_group, &[]);
        pass.dispatch_workgroups((count as u32).div_ceil(64), 1, 1);
    }
    let measured = read_blocks(gpu, encoder, &stats, count)?;

    let mut bins: Vec<Vec<f32>> = vec![Vec::new(); crate::noise::BINS];
    for block in &measured {
        let bin = (block[0] * crate::noise::BINS as f32) as usize;
        bins[bin.min(crate::noise::BINS - 1)].push(block[1]);
    }
    let binned: Vec<crate::noise::Bin> = bins
        .iter_mut()
        .map(|sigmas| crate::noise::Bin {
            blocks: sigmas.len(),
            sigma: crate::noise::envelope(sigmas),
        })
        .collect();
    let stabilised = crate::noise::typical(&binned)
        .map_or(1e-6, |sigma| (sigma * crate::noise::DEMOSAIC_CORRELATION).max(1e-6));
    Some(crate::noise::Noise { stabilised, alpha, sigma_sq })
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

    /// A frame with as much curvature as the format allows, since that is what the correction is
    /// proportional to.
    ///
    /// **A gentle frame passes a wrong shader.** A first version of this varied by a few thousand
    /// counts over blocks of five pixels, which left the luma Laplacian around 0.036 and the
    /// green correction under twenty counts - so a coefficient 5% wrong moved a sample by less
    /// than one and the bound below swallowed it. Single-pixel alternation between the ends of
    /// the range puts the Laplacian near its maximum, where a percent is a count.
    fn edged(width: usize, height: usize) -> Vec<u16> {
        let mut out = vec![0u16; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let at = (y * width + x) * 3;
                let high = (x + y) % 2 == 0;
                // Away from both rails, so the correction is not measured against a clamp.
                let (dark, light) = (6000u16, 58000u16);
                out[at] = if high { light } else { dark };
                out[at + 1] = if high { dark } else { light };
                out[at + 2] = if high { light / 2 } else { dark * 2 };
            }
        }
        out
    }

    /// The defringe, against `image::finish_with` running the same stage on the same frame.
    ///
    /// Held against `finish_with` rather than `finish` so both sides take the *same* defocus
    /// pair: `finish` measures it, and a test that let each measure its own would be comparing
    /// two measurements rather than the correction they drive.
    ///
    /// **Not bit-equal, and it cannot be.** The CPU splits the frame into three `f32` planes,
    /// corrects the two chroma differences and solves the luma equation for green on the way
    /// back; the shader composes those into one add per channel and rounds once instead of
    /// twice. So a sample can land a count either side of the CPU's, and the bound is two -
    /// one for each rounding the CPU does that the shader does not.
    #[test]
    fn the_defringe_matches_the_cpu_within_two_counts() {
        let Some(gpu) = crate::gpu::device() else { return };
        let Some(base) = super::device(gpu) else { return };

        let (width, height) = (61usize, 43);
        let frame = edged(width, height);
        let strengths = crate::image::Strengths { sharpen: 0.0, defringe: 1.0 };
        let defocus = (0.031f32, -0.017f32);

        let mut theirs = frame.clone();
        crate::image::finish_with(&mut theirs, width, height, strengths, defocus);

        let mut mine = frame.clone();
        super::defringe(gpu, base, &mut mine, width, height, defocus).expect("the defringe runs");

        // **Asserted before the bound, and on the size of the correction rather than on how many
        // samples it touched.** A count of moved samples says a stage ran; it does not say it did
        // anything a tolerance would notice, and a correction smaller than the bound makes the
        // bound vacuous - a shader that returned its input unchanged would pass.
        let correction =
            theirs.iter().zip(&frame).map(|(a, b)| a.abs_diff(*b)).max().expect("samples");
        assert!(correction > 200, "the CPU's own correction peaks at {correction} counts");

        let worst = theirs.iter().zip(&mine).map(|(a, b)| a.abs_diff(*b)).max().expect("samples");
        assert!(worst <= 2, "the shader and the planes disagree by {worst} counts");
    }

    /// Four bands of real noise, each at its own level and its own sigma, each channel offset.
    ///
    /// **What the estimator reads is a percentile of a percentile, so a gentle frame proves
    /// nothing.** A block's sigma is the median of its 96 Laplacians and a bin's is the quiet fifth
    /// of its blocks, both of which a smooth ramp answers with the same near-zero number
    /// everywhere - a shader that measured the wrong plane, or binned by the wrong level, would
    /// agree with the CPU to every digit. Bands give the bins something to disagree about; the
    /// noise is gaussian and independent per channel, so a block's median Laplacian is a sigma
    /// rather than a step; and the channels sit at different levels, so the luma weights are
    /// load-bearing rather than summing to one over three copies of the same number.
    ///
    /// The levels land mid-bin (luma is about 0.946 of the level here), which is not fussiness: a
    /// band sitting on a bin edge splits across two, and the weighted median that picks one bin is
    /// then a coin toss the two paths could call differently. The brightest band stops short of
    /// the top for the reason the defringe's frame stays off both rails - a clipped channel is a
    /// measurement of the clip.
    fn banded(width: usize, height: usize) -> Vec<u16> {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut normal = || {
            // Sum of twelve uniforms, minus six: mean 0, variance 1, and no dependency.
            (0..12)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    (state >> 40) as f32 / 16777216.0
                })
                .sum::<f32>()
                - 6.0
        };
        let bands = [(0.1156f32, 0.020f32), (0.3799, 0.008), (0.6111, 0.003), (0.7768, 0.0012)];
        let mut out = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            let (level, sigma) = bands[y * bands.len() / height];
            for _ in 0..width {
                for tint in [0.75, 1.0, 1.2] {
                    let value = (level * tint + sigma * normal()) * 65535.0;
                    out.push(value.clamp(0.0, 65535.0) as u16);
                }
            }
        }
        out
    }

    /// The measurement, against the CPU it replaces.
    ///
    /// **Not bit-equal, and it cannot be.** Every number either side reports is a quantile of
    /// quantiles: a block's sigma is an order statistic of 96 `f32` Laplacians, a bin's is the mean
    /// of a slice of a sort, and the frame's is whichever bin the weighted median lands in. The
    /// per-pixel arithmetic differs in the last bit or two - the shader is free to contract a
    /// multiply and an add into one rounding where Rust is not - and a block whose two middle
    /// Laplacians differ by less than that can hand back the other one.
    ///
    /// So the bound is a fifth of a percent, relative, and it sits between two measured numbers.
    /// The rounding alone lands at 1e-6 here. One flipped order statistic is worth about 1e-3: a
    /// block's neighbouring Laplacians are a percent or so apart, and a bin's envelope averages
    /// nineteen of its blocks. A structural error is nowhere near either - the divisor 6% wrong
    /// reads 2.8% off and swapping two luma weights 3.9%, both of which this rejects by more than
    /// an order of magnitude.
    #[test]
    fn the_noise_matches_the_cpu_within_a_fifth_of_a_percent() {
        let Some(gpu) = crate::gpu::device() else { return };
        let Some(base) = super::device(gpu) else { return };

        // Neither dimension a multiple of the block, so the partial row and column the CPU drops
        // are dropped here too; and an odd sample count, so `upload`'s tail is exercised.
        let (width, height) = (259usize, 131);
        let frame = banded(width, height);

        let theirs = crate::noise::measure(&frame, width, height);
        // **Asserted before the bound.** A frame the estimator declines reports its floor, and two
        // floors agree perfectly - so a shader that measured nothing at all would pass a relative
        // bound against one.
        assert!(theirs.stabilised > 0.01, "the CPU's own answer is {}", theirs.stabilised);

        let mine = super::measure(gpu, base, &frame, width, height).expect("the measurement runs");
        let off = |mine: f32, theirs: f32| (mine - theirs).abs() / theirs;
        assert!(
            off(mine.stabilised, theirs.stabilised) < 0.002,
            "sigma {} against {}",
            mine.stabilised,
            theirs.stabilised
        );
        // The transform the sigma was measured through, which the client applies verbatim: a sigma
        // that matched through a different transform would not be the same measurement.
        assert!(
            off(mine.alpha, theirs.alpha) < 0.002,
            "alpha {} against {}",
            mine.alpha,
            theirs.alpha
        );
        assert!(
            off(mine.sigma_sq, theirs.sigma_sq) < 0.002,
            "sigma_sq {} against {}",
            mine.sigma_sq,
            theirs.sigma_sq
        );
    }
}
