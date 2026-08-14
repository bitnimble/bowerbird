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
    warp_layout: wgpu::BindGroupLayout,
    warp: wgpu::ComputePipeline,
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

        // The falloff is a gain folded into PQ's intermediate, so the warp needs the same
        // constants the coding does.
        let warp_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("warp"),
            source: wgpu::ShaderSource::Wgsl(
                format!(
                    "{}\n{}",
                    include_str!("../../../web/src/features/raw_edit/gpu/wgsl/prelude.wgsl"),
                    include_str!("wgsl/warp.wgsl"),
                )
                .into(),
            ),
        });
        let warp_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("warp"),
            entries: &[
                uniform_entry(0),
                storage_entry(1),
                storage_entry(2),
                storage_entry(3),
                storage_entry(4),
            ],
        });
        let warp_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("warp"),
            bind_group_layouts: &[Some(&warp_layout)],
            immediate_size: 0,
        });
        let warp = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("warp_lens"),
            layout: Some(&warp_pipeline_layout),
            module: &warp_module,
            entry_point: Some("warp_lens"),
            compilation_options: Default::default(),
            cache: None,
        });

        Some(Base {
            layout,
            encode,
            defringe_layout,
            defringe_luma: defringe("defringe_luma"),
            defringe_apply: defringe("defringe_apply"),
            warp_layout,
            warp,
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

/// `image::channel_ratio_table` for all three channels end to end, as `f32`.
///
/// **The table, not the spline.** The knots are `f64` and evaluating them per pixel is a handful
/// of instructions a shader would not notice - but it would be a *different* warp: the gather the
/// CPU runs reads this table, whose 4096 buckets in r^2 and linear interpolation between them are
/// part of the answer, not an optimisation over it. A shader that evaluated the spline exactly
/// would disagree with the rendition by more than `f32` costs, and in a way that moves with the
/// lens. So the quantisation is uploaded along with the values.
///
/// Rebuilt here rather than borrowed from `PlanarWarp`, whose tables are private to `image`.
/// `the_lens_warp_matches_the_cpu` is what holds the two spellings together.
fn ratio_tables(lens: &crate::fit::Lens) -> Vec<f32> {
    let knots = lens.distortion.as_deref().unwrap_or_default();
    let last = crate::image::RATIO_TABLE_LAST;
    let mut out = Vec::with_capacity((last + 1) * 3);
    for channel in lens.channels() {
        for slot in 0..=last {
            let radius = (slot as f64 / last as f64).sqrt();
            let base = match radius == 0.0 {
                true => lens.crop,
                false => crate::image::sample_radius(knots, radius, lens.crop) / radius,
            };
            out.push((base * (1.0 + crate::image::spline_at(&channel, radius))) as f32);
        }
    }
    out
}

/// `map_u16`'s `lifts`: `g^m1` per radius bucket, and 1.0 where there is no falloff to undo.
///
/// A flat table of ones rather than a flag, since the shader already refuses to round-trip a gain
/// of exactly 1 - the one branch answers both.
fn lift_table(falloff: Option<(f64, f64)>) -> Vec<f32> {
    (0..256)
        .map(|radius| {
            let Some((a, b)) = falloff else { return 1.0 };
            let gain = crate::fit::Gain::at(a, b, radius as u8);
            match (gain - 1.0).abs() < 1e-5 {
                true => 1.0,
                false => crate::tone::gain_in_y(gain) as f32,
            }
        })
        .collect()
}

fn float_storage(gpu: &crate::gpu::Gpu, label: &str, values: &[f32]) -> wgpu::Buffer {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: &bytes,
        usage: wgpu::BufferUsages::STORAGE,
    })
}

/// The lens correction, as [`crate::hdr_fit::apply_lens`] runs it - `PlanarWarp::for_lens`
/// through the bicubic, gathered onto a frame of its own.
///
/// None where there is nothing to do, which is `for_lens`'s own answer to an identity lens, and
/// also what a refused device gives: both want the caller's CPU path, and `apply_lens` already
/// answers None by leaving the frame alone.
///
/// Bicubic only. The bilinear is the fit's, and the fit warps 8-bit and `f64` planes that never
/// reach this buffer layout.
pub fn warp_lens(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &[u16],
    source: (usize, usize),
    out: (usize, usize),
    lens: &crate::fit::Lens,
) -> Option<Vec<u16>> {
    let (sw, sh) = source;
    let (width, height) = out;
    // `map_u16`'s own refusal on `sw < 2`, and `for_lens`'s on an identity. The shader indexes
    // `sw - 2u` unsigned, so a one-pixel source would read the far end of the buffer.
    if lens.is_identity() || sw < 2 || sh < 2 || width == 0 || height == 0 {
        return None;
    }
    if samples.len() < sw * sh * 3 {
        return None;
    }

    let device = &gpu.device;
    let pixels = width * height;
    let words = (pixels * 3).div_ceil(2);

    let frame = upload(gpu, samples);
    let warped = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("warp out"),
        size: (words * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let ratios = float_storage(gpu, "warp ratios", &ratio_tables(lens));
    let lifts = float_storage(gpu, "warp lifts", &lift_table(lens.falloff));

    // The output grid's half-diagonal squared, which is what `PlanarWarp::new` measures the
    // radius against - and squared throughout, because the table is indexed by r^2.
    let half2 = (width as f64 / 2.0).powi(2) + (height as f64 / 2.0).powi(2);
    let mut params: Vec<u8> = Vec::with_capacity(48);
    for word in [sw as u32, sh as u32, width as u32, height as u32] {
        params.extend_from_slice(&word.to_le_bytes());
    }
    for value in [
        (sw as f64 / 2.0 - 0.5) as f32,
        (sh as f64 / 2.0 - 0.5) as f32,
        (sw as f64 / width as f64) as f32,
        (sh as f64 / height as f64) as f32,
        (sw - 1) as f32,
        (sh - 1) as f32,
        (1.0 / half2) as f32,
        0.0,
    ] {
        params.extend_from_slice(&value.to_le_bytes());
    }
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("warp params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("warp"),
        layout: &base.warp_layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: frame.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: warped.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: ratios.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: lifts.as_entire_binding() },
        ],
    });

    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.warp);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((pixels.div_ceil(2) as u32).div_ceil(64), 1, 1);
    }
    let mut gathered = vec![0u16; pixels * 3];
    read_back(gpu, encoder, &warped, words, &mut gathered)?;
    Some(gathered)
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

    /// The lens correction, against `PlanarWarp::apply_u16` on the same frame and the same lens.
    ///
    /// **On a checkerboard, because a warp is a resample and a smooth frame does not test one.**
    /// Every displacement here lands between samples, so the four cubic taps carry the whole
    /// answer and a wrong weight is tens of thousands of counts out - where on a ramp the same
    /// wrong weight interpolates to nearly the right number.
    ///
    /// A lens with all four corrections on it: a distortion with its fill crop, a falloff, and a
    /// lateral aberration - the last is what makes the three channels read at three different
    /// radii, so a shader that gathered one position for the pixel would fail here and nowhere
    /// else.
    ///
    /// Odd in both dimensions, so the pair of pixels an invocation writes and the half word at
    /// the end of the frame are exercised rather than assumed.
    ///
    /// **Not bit-equal, and it cannot be.** The CPU carries the ratio table, the tap positions
    /// and the sixteen weighted taps in `f64`; the shader has `f32`, so a tap lands ~1e-5 of a
    /// pixel from the CPU's, and against this frame's 50000 counts per pixel that is a third of
    /// a count on its own. `as u16` truncates rather than rounds, so any such difference that
    /// straddles an integer is a whole count.
    ///
    /// Measured on RADV: worst 2, mean 0.167, with 17% of samples a count out and thirteen of
    /// 139551 reaching the bound. **Worst and mean both, because a bicubic that is right in the
    /// middle and wrong at the border reads as a worst far above its mean** - and this one does
    /// not: three of those thirteen are within two pixels of an edge, which is the share the
    /// border holds of the frame.
    #[test]
    fn the_lens_warp_matches_the_cpu() {
        let Some(gpu) = crate::gpu::device() else { return };
        let Some(base) = super::device(gpu) else { return };

        let (width, height) = (257usize, 181);
        let frame = edged(width, height);
        let knots = vec![0.0, 40.0, 160.0, 380.0];
        let lens = crate::fit::Lens {
            crop: crate::image::fill_crop(&knots, width, height),
            distortion: Some(knots),
            falloff: Some((0.25, 0.1)),
            tca: Some([vec![0.0, 24.0, 60.0], vec![0.0, -18.0, -44.0]]),
        };

        let warp = crate::image::PlanarWarp::for_lens(
            width,
            height,
            width,
            height,
            &lens,
            crate::image::Sampling::Bicubic,
        )
        .expect("a lens that moves pixels");
        let theirs = warp.apply_u16(&frame);
        let mine = super::warp_lens(gpu, base, &frame, (width, height), (width, height), &lens)
            .expect("the warp runs");

        // The warp has to have moved the frame before a tolerance on it means anything: a gather
        // that returned its source would otherwise agree with itself perfectly.
        let moved = theirs.iter().zip(&frame).map(|(a, b)| a.abs_diff(*b)).max().expect("samples");
        assert!(moved > 10000, "the CPU's own warp moves a sample by only {moved} counts");

        let worst = theirs.iter().zip(&mine).map(|(a, b)| a.abs_diff(*b)).max().expect("samples");
        let mean = theirs.iter().zip(&mine).map(|(a, b)| f64::from(a.abs_diff(*b))).sum::<f64>()
            / theirs.len() as f64;
        assert!(worst <= 2, "the shader and the gather disagree by {worst} counts, mean {mean:.4}");
    }
}
