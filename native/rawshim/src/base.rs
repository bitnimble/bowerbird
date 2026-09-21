//! The base frame's own stages, on the GPU.
//!
//! Everything between the demosaic and the grade that both a rendition and the editor's open run:
//! the coding, the defringe, the warp, the sharpen, and the two whole-frame numbers the
//! rest of them read. Measured on a 61MP frame, and this is why they are worth moving at all -
//! `open code, defringe` 1170ms, `open lens warp` 639ms and `open noise measure` 1021ms, against
//! a decode that is already on the GPU either side of them.
//!
//! **The prize is not the stage timings, it is the two transfers they sit between.** RCD leaves
//! the frame in VRAM and reads it back; the grade uploads it again. At 61MP that is 361MB each
//! way for the privilege of running pointwise arithmetic on a CPU. Every stage that moves here
//! brings those two closer together, and the last one deletes them.
//!
//! Its own module rather than more of `gpu.rs` for the reason `demosaic.rs` is its own: the denoise
//! sits between them, and this one's frame is the demosaiced one.

fn source() -> String {
    include_str!(concat!(env!("OUT_DIR"), "/wgsl/base.wgsl")).to_string()
}

pub struct Base {
    layout: wgpu::BindGroupLayout,
    encode: wgpu::ComputePipeline,
    defringe_layout: wgpu::BindGroupLayout,
    defringe_luma: wgpu::ComputePipeline,
    defringe_apply: wgpu::ComputePipeline,
    warp_layout: wgpu::BindGroupLayout,
    warp: wgpu::ComputePipeline,
    sharpen_layout: wgpu::BindGroupLayout,
    sharpen_luma: wgpu::ComputePipeline,
    sharpen_spread: wgpu::ComputePipeline,
    sharpen_ratio: wgpu::ComputePipeline,
    sharpen_gather: wgpu::ComputePipeline,
    sharpen_correct: wgpu::ComputePipeline,
    sharpen_range: wgpu::ComputePipeline,
    sharpen_apply: wgpu::ComputePipeline,
    /// Every code a frame can hold, as the light behind it, normalised so the largest is one.
    ///
    /// The resize's, and the process's: it is the PQ curve inverted and nothing about a particular
    /// frame, so it is built once beside the pipelines rather than per render. 256kB.
    light_of_code: crate::gpu::Buffer,
    /// The same for a frame that has not been coded, which is the ramp. 256kB.
    light_of_level: crate::gpu::Buffer,
    resize_layout: wgpu::BindGroupLayout,
    resize: wgpu::ComputePipeline,
    halve_layout: wgpu::BindGroupLayout,
    halve: wgpu::ComputePipeline,
    reduce_layout: wgpu::BindGroupLayout,
    reduce: wgpu::ComputePipeline,
    defocus_layout: wgpu::BindGroupLayout,
    defocus_bins: wgpu::ComputePipeline,
    defocus_residuals: wgpu::ComputePipeline,
    edge_spread_layout: wgpu::BindGroupLayout,
    edge_spread: wgpu::ComputePipeline,
    chroma_leak_layout: wgpu::BindGroupLayout,
    chroma_leak: wgpu::ComputePipeline,
}

#[cfg(not(target_arch = "wasm32"))]
pub fn device(gpu: &'static crate::gpu::Gpu) -> Option<&'static Base> {
    static BUILT: std::sync::OnceLock<Option<Base>> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Base::new(gpu)).as_ref()
}

/// The same pipelines, built once per page.
///
/// Leaked into a thread local rather than held in a `OnceLock`, for [`crate::gpu::page_device`]'s
/// reason: wgpu's WebGPU handles are `Rc`s, so a `Base` is neither `Send` nor `Sync` and cannot sit
/// in a static.
#[cfg(target_arch = "wasm32")]
pub fn device(gpu: &'static crate::gpu::Gpu) -> Option<&'static Base> {
    thread_local! {
        static BUILT: std::cell::Cell<Option<&'static Base>> = const { std::cell::Cell::new(None) };
    }
    if let Some(built) = BUILT.with(std::cell::Cell::get) {
        return Some(built);
    }
    let built: &'static Base = Box::leak(Box::new(Base::new(gpu)?));
    BUILT.with(|held| held.set(Some(built)));
    Some(built)
}

/// What a caller says when there is no device to run these stages on.
///
/// **A message rather than a fallback.** Every stage between the mosaic and the picture is a
/// shader, and the editor runs the same ones in a browser - so a CPU arm here would be a second
/// answer to the same question, which is the drift this pipeline is built to not have. A host with
/// no Vulkan renders nothing rather than rendering differently, and that is a five-minute install
/// rather than a class of machine: `gpu::device` takes a software adapter where there is no
/// hardware one.
pub fn without_a_device(stages: &str) -> String {
    format!(
        "no Vulkan adapter answered, so {stages} cannot run - they are shaders and there is no CPU \
         copy of them. On a machine with no GPU, `bun run get:swiftshader` fetches a CPU driver \
         that is enough; it is very slow and it works"
    )
}

impl Base {
    fn new(gpu: &crate::gpu::Gpu) -> Option<Base> {
        let device = gpu.describing();
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
                read_only_entry(2),
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
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/defringe.wgsl")).into(),
            ),
        });
        let defringe_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("defringe"),
            entries: &[uniform_entry(0), storage_entry(1), storage_entry(2)],
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

        let warp_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("warp"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/warp.wgsl")).into(),
            ),
        });
        let warp_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("warp"),
            entries: &[
                uniform_entry(0),
                read_only_entry(1),
                storage_entry(2),
                read_only_entry(3),
                read_only_entry(4),
                storage_entry(5),
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

        let sharpen_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("sharpen"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/sharpen.wgsl")).into(),
            ),
        });
        let sharpen_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("sharpen"),
            entries: &[
                uniform_entry(0),
                storage_entry(1),
                storage_entry(2),
                storage_entry(3),
                storage_entry(4),
                storage_entry(5),
                storage_entry(6),
                read_only_entry(7),
                read_only_entry(8),
            ],
        });
        let sharpen_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("sharpen"),
                bind_group_layouts: &[Some(&sharpen_layout)],
                immediate_size: 0,
            });
        let sharpen = |entry: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&sharpen_pipeline_layout),
                module: &sharpen_module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };

        // The browser's own file, verbatim, exactly as the grade's shaders are: the three entry
        // points below are one averaging rule over three pairs of source and destination, and a
        // second copy here is the drift the shared file exists to prevent.
        let reduce_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("reduce"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/reduce.wgsl")).into(),
            ),
        });
        // A layout per entry point, holding exactly what that entry point reads, which is what the
        // page does and for its reason: one shared layout would have to name `coarser`, and the
        // only texture to put there for the first level is the one being written - a read and a
        // write of one resource in a single pass, and rejected as such.
        let resize_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("resize"),
            entries: &[
                uniform_entry(0),
                read_only_entry(1),
                storage_entry(4),
                read_only_entry(5),
            ],
        });
        let halve_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("halve"),
            entries: &[uniform_entry(0), read_only_entry(1), written_level(3), read_only_entry(5)],
        });
        let reduce_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("reduce"),
            entries: &[read_level(2), written_level(3), read_only_entry(5)],
        });
        let reducing = |entry: &str, layout: &wgpu::BindGroupLayout| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(
                    &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                        label: Some(entry),
                        bind_group_layouts: &[Some(layout)],
                        immediate_size: 0,
                    }),
                ),
                module: &reduce_module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let resize = reducing("resize", &resize_layout);
        let halve = reducing("halve", &halve_layout);
        let reduce = reducing("reduce", &reduce_layout);

        let defocus_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("defocus"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/defocus.wgsl")).into(),
            ),
        });
        let defocus_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("defocus"),
            entries: &[
                uniform_entry(0),
                storage_entry(1),
                storage_entry(2),
                storage_entry(3),
            ],
        });
        let defocus_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("defocus"),
                bind_group_layouts: &[Some(&defocus_layout)],
                immediate_size: 0,
            });
        let defocus = |entry: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&defocus_pipeline_layout),
                module: &defocus_module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };

        let edge_spread_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("edge_spread"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/edge_spread.wgsl")).into(),
            ),
        });
        let edge_spread_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("edge_spread"),
                entries: &[uniform_entry(0), storage_entry(1), storage_entry(2)],
            });
        let edge_spread = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("edge_spread"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("edge_spread"),
                    bind_group_layouts: &[Some(&edge_spread_layout)],
                    immediate_size: 0,
                }),
            ),
            module: &edge_spread_module,
            entry_point: Some("edge_spread"),
            compilation_options: Default::default(),
            cache: None,
        });

        let chroma_leak_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("chroma_leak"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/chroma_leak.wgsl")).into(),
            ),
        });
        let chroma_leak_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("chroma_leak"),
                entries: &[uniform_entry(0), storage_entry(1), storage_entry(2)],
            });
        let chroma_leak = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("chroma_leak"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("chroma_leak"),
                    bind_group_layouts: &[Some(&chroma_leak_layout)],
                    immediate_size: 0,
                }),
            ),
            module: &chroma_leak_module,
            entry_point: Some("chroma_leak"),
            compilation_options: Default::default(),
            cache: None,
        });

        Some(Base {
            light_of_code: light_of_code(gpu),
            light_of_level: light_of_level(gpu),
            layout,
            encode,
            defringe_layout,
            defringe_luma: defringe("defringe_luma"),
            defringe_apply: defringe("defringe_apply"),
            warp_layout,
            warp,
            sharpen_layout,
            sharpen_luma: sharpen("sharpen_luma"),
            sharpen_spread: sharpen("sharpen_spread"),
            sharpen_ratio: sharpen("sharpen_ratio"),
            sharpen_gather: sharpen("sharpen_gather"),
            sharpen_correct: sharpen("sharpen_correct"),
            sharpen_range: sharpen("sharpen_range"),
            sharpen_apply: sharpen("sharpen_apply"),
            resize_layout,
            resize,
            halve_layout,
            halve,
            reduce_layout,
            reduce,
            defocus_layout,
            defocus_bins: defocus("defocus_bins"),
            defocus_residuals: defocus("defocus_residuals"),
            edge_spread_layout,
            edge_spread,
            chroma_leak_layout,
            chroma_leak,
        })
    }

    pub fn light_of_code(&self) -> &crate::gpu::Buffer {
        &self.light_of_code
    }
}

/// The coding undone, per code, for the resize to average behind.
///
/// **Normalised rather than in nits, and that is what makes it the process's rather than a frame's.**
/// `encode_base` divides by diffuse white and multiplies by the reference before coding, so a code
/// stands for a different number of nits from one photograph to the next - but the *ratio* between
/// two codes is the PQ curve alone. An average is a weighted mean, so a constant factor divides
/// straight back out of it, and the resize needs no anchor to be correct.
///
/// Built in `f64` for the reason `coding_curve` is: this is the table the round trip is held exact
/// against, and a `f32` curve would put the search a count out on the codes where PQ is steepest.
fn light_of_code(gpu: &crate::gpu::Gpu) -> crate::gpu::Buffer {
    let signal = |of: u16| crate::light::Light::measured(f64::from(of) / f64::from(u16::MAX));
    let ceiling = crate::tone::pq_inv::<crate::light::SceneNits>(signal(u16::MAX));
    let mut bytes = Vec::with_capacity((u16::MAX as usize + 1) * 4);
    for code in 0..=u16::MAX {
        // A ratio, which is what the header means by normalised: both ends are the scene's nits,
        // so whatever the frame's anchor was divides out and this is the curve alone.
        let light = crate::tone::pq_inv::<crate::light::SceneNits>(signal(code)) / ceiling;
        bytes.extend_from_slice(&(light.raw() as f32).to_le_bytes());
    }
    gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("light of code"),
        contents: &bytes,
        usage: wgpu::BufferUsages::STORAGE,
    })
}

/// The same table for a frame the coding has not reached: the ramp, since a level *is* its light.
///
/// Normalised the same way, so `code_of_light`'s search over it lands back on the level it came
/// from and a flat field survives the round trip.
fn light_of_level(gpu: &crate::gpu::Gpu) -> crate::gpu::Buffer {
    let mut bytes = Vec::with_capacity((u16::MAX as usize + 1) * 4);
    for level in 0..=u16::MAX {
        bytes.extend_from_slice(&(f32::from(level) / f32::from(u16::MAX)).to_le_bytes());
    }
    gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("light of level"),
        contents: &bytes,
        usage: wgpu::BufferUsages::STORAGE,
    })
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

fn read_only_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only: true },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        ..storage_entry(binding)
    }
}

/// `rgba16uint` is `reduce.slang`'s `finer`, and the frame's own coding at a channel's full depth.
const PYRAMID_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Uint;

/// A pyramid level being written, one mip view at a time.
fn written_level(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::StorageTexture {
            access: wgpu::StorageTextureAccess::WriteOnly,
            format: PYRAMID_FORMAT,
            view_dimension: wgpu::TextureViewDimension::D2,
        },
        count: None,
    }
}

/// The level above it, being read.
fn read_level(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Uint,
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

/// What the chain is to do about longitudinal aberration.
///
/// **Three answers, not two, and the third is the one a pair alone cannot express.** An open that
/// fits a camera match corrects the linear frame first ([`correct`]) and then runs this chain over
/// the same buffer, so it has a pair *and* the work is already done. Handing that pair over as
/// "here it is, do not re-measure" reads as "here it is, apply it", and the frame comes back
/// corrected twice - a difference no test saw, because the pair is right either way and only the
/// pixels move.
#[derive(Clone, Copy, Default)]
pub enum Defringe {
    /// Read it off this frame and take it off. What a caller with nothing stored asks for.
    #[default]
    Measure,
    /// Take this pair off. The photograph's own, measured over the whole frame somewhere a window
    /// could not - a stored analysis, or the open that preceded this tile.
    Take((f32, f32)),
    /// Already off, at this pair. [`correct`] ran over this same frame ahead of the camera match.
    Done((f32, f32)),
}

impl<'de> serde::Deserialize<'de> for Defringe {
    /// From the wire's `Option<(f32, f32)>`: the photograph's pair to take off, or nothing and the
    /// window measures its own.
    ///
    /// `Done` is deliberately not expressible here. It says the buffer the caller is about to hand
    /// over has already been through the correction, which is a fact about that caller's own
    /// memory - a request arriving over HTTP brings a rectangle and a number, never a frame.
    fn deserialize<D: serde::Deserializer<'de>>(from: D) -> Result<Self, D::Error> {
        let pair = <Option<(f32, f32)> as serde::Deserialize>::deserialize(from)?;
        Ok(pair.map_or(Defringe::Measure, Defringe::Take))
    }
}

/// The coding, the defringe, the lens warp and the sharpen over one resident frame, with no
/// transfer at all.
///
/// **This is what the module is for.** The stages were worth a third of their own time and none of
/// the render's: at 61MP each was carrying 361MB up and 361MB back for the privilege of running
/// pointwise arithmetic somewhere else, and the warp wired in alone measured 588-610ms against the
/// CPU's 639ms.
///
/// A stage whose inputs say it does nothing is left out of the chain rather than run as an
/// identity, so the result is `gather.out`-sized where the lens warps and `gather.source`-sized
/// where it does not - and in that second case it is the frame it was handed, written in place.
/// None where there is no device, which is a caller that has to refuse ([`without_a_device`]).
///
/// **The gather is the whole of what a window changes.** A frame corrects itself onto a grid of its
/// own ([`Gather::whole`]); a loupe tile or a cropped render corrects a rectangle of the same
/// photograph onto the window it writes ([`Gather::window`]). Taking it here rather than a pair of
/// sizes is what lets a window come through this chain at all: without it a caller with a window to
/// fill had to ask for the coding and the defringe alone, read the frame back, upload it again and
/// warp it separately - which is the two extra transfers this function exists to delete, 361MB each
/// way at 61MP.
pub async fn prepare(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    frame: crate::resident::Resident,
    gather: Gather,
    levels: crate::tone::Anchored,
    reference_white_nits: crate::light::Light<crate::light::SceneNits>,
    strengths: crate::image::Strengths,
    sharpen_sigma: crate::image::SharpenSigma,
    sharpen_noise: crate::image::SharpenNoise,
    lens: &crate::fit::Lens,
    defocus: Defringe,
    noise: Option<crate::galosh::NoiseFit>,
    matrix: Option<[[f32; 3]; 3]>,
) -> Option<(crate::resident::Resident, (f32, f32))> {
    let (source, out) = (gather.source, gather.out);
    let (sw, sh) = source.raw();
    let samples = frame.samples();
    if sw == 0 || sh == 0 || samples < sw * sh * 3 {
        return None;
    }

    let mut recording = gpu.record();
    recording.holding(frame.buffer());

    // **Measured and corrected in linear, ahead of the coding**, which is where the defect
    // happened: the model is `R - luma = k.laplacian(luma)`, and that comes from each channel
    // focusing at a different plane - a small blur difference is a Laplacian to first order, and
    // convolution is linear in *intensity*. In PQ the relation is only locally true, the effective
    // `k` drifting with the curve's slope, so one coefficient per radius bin fits a misspecified
    // model. Measured on a frame carrying a known focus difference: linear takes off 96% and 97%
    // of the red and blue fringe where PQ took off -9% and 26%, and linear's coefficient is flat
    // across radius to 4% where PQ's swings 29% on a quantity a focus difference cannot vary.
    //
    // **Measured off the frame this is given, unless the caller already has the photograph's.**
    // The fit is global - it reads the whole frame's channel residuals - so a window measuring its
    // own is defringed at that window's aberration, and the strips of a re-prepare come back
    // corrected by different amounts down the picture.
    let (defocus, apply) = match (defocus, strengths.defringe > 0.0) {
        (Defringe::Done(pair), _) => (pair, false),
        (Defringe::Take(pair), _) => (pair, true),
        (Defringe::Measure, true) => {
            // Its own recording: this one submits and maps before it can answer, and what follows
            // is recorded against the answer.
            let measured = measure_defocus_into(gpu, base, frame.buffer(), sw, sh, noise, matrix)
                .await
                .map(|(red, blue)| {
                    let scale = strengths.defringe.clamp(0.0, 1.0) as f32;
                    (red * scale, blue * scale)
                })
                .unwrap_or((0.0, 0.0));
            (measured, true)
        }
        (Defringe::Measure, false) => ((0.0, 0.0), false),
    };
    if apply && defringes(samples, sw, sh, defocus) {
        defringe_into(gpu, base, &mut recording, frame.buffer(), sw, sh, defocus);
    }

    encode_base_into(
        gpu,
        base,
        &mut recording,
        frame.buffer(),
        samples,
        levels,
        reference_white_nits,
    );

    // After the warp, which is the resample whose blur it deconvolves; before the grade, which
    // is where the editor has always had it. On whichever buffer leaves this function.
    if !warps(samples, source.raw(), out.raw(), lens) {
        let (w, h) = source.raw();
        if sharpens(samples, w, h, strengths.sharpen) {
            sharpen_into(
                gpu,
                base,
                &mut recording,
                frame.buffer(),
                w,
                h,
                strengths.sharpen,
                sharpen_sigma,
                sharpen_noise,
                None,
            );
        }
        recording.submit();
        return Some((frame, defocus));
    }
    let (ow, oh) = out.raw();
    let warped = crate::resident::Resident::empty(gpu, ow, oh);
    recording.holding(warped.buffer());
    let jacobian = warp_lens_into(
        gpu,
        base,
        &mut recording,
        frame.buffer(),
        warped.buffer(),
        gather,
        lens,
    );
    if sharpens(warped.samples(), ow, oh, strengths.sharpen) {
        sharpen_into(
            gpu,
            base,
            &mut recording,
            warped.buffer(),
            ow,
            oh,
            strengths.sharpen,
            sharpen_sigma,
            sharpen_noise,
            Some(&jacobian),
        );
    }
    recording.submit();
    // Before the reclaim, so the nudge inside it has the frame's last handle to retire.
    drop(recording);
    frame.reclaim();
    Some((warped, defocus))
}

/// Two `vec2u` and a `vec2f` are 24 bytes and a uniform block is a multiple of 16, so the tail is
/// padding the shader never names.
pub const REDUCTION_BYTES: usize = 32;

/// What `Reduction` in `reduce.slang` holds: two sizes and the ratio between them, as the bytes the
/// shader reads.
///
/// The ratio is given rather than divided out of the sizes because a pyramid level is a *floored*
/// half - at an odd width the ratio the level wants is two and the quotient of the sizes is not.
///
/// Public because the browser builds this same block for its own pyramid, and
/// `reduction-words.txt` holds the two spellings together - the block is only eight words, and a
/// pair transposed in one of them is a canvas sampling a level of a different picture.
pub fn reduction_bytes(source: (usize, usize), out: (usize, usize), scale: (f64, f64)) -> Vec<u8> {
    let mut params: Vec<u8> = Vec::with_capacity(REDUCTION_BYTES);
    for word in [source.0 as u32, source.1 as u32, out.0 as u32, out.1 as u32] {
        params.extend_from_slice(&word.to_le_bytes());
    }
    for value in [scale.0 as f32, scale.1 as f32] {
        params.extend_from_slice(&value.to_le_bytes());
    }
    params.resize(REDUCTION_BYTES, 0);
    params
}

fn reduction(
    recording: &mut crate::gpu::Recording<'_>,
    source: (usize, usize),
    out: (usize, usize),
    scale: (f64, f64),
) -> crate::gpu::Buffer {
    recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("reduction"),
        contents: &reduction_bytes(source, out, scale),
        usage: wgpu::BufferUsages::UNIFORM,
    })
}

/// The downscale, as an area average over each output pixel's own fractional footprint. What a
/// rendition is cut with, and `halve`'s general case.
///
/// One pass rather than [`pyramid`]'s chain, and the arithmetic is why: each source pixel falls in
/// exactly one output footprint per axis, so this reads the frame once however deep the reduction.
/// A canvas is fixed-size and the same is not true of it.
///
/// None where there is nothing to do - the sizes match, or the caller asked to enlarge, which this
/// declines: it exists to avoid work rather than to invent detail.
pub fn resize(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    frame: &crate::resident::Resident,
    out: (usize, usize),
) -> Option<crate::resident::Resident> {
    resized_through(gpu, base, frame, out, &base.light_of_code)
}

/// The same over a frame the coding has not reached yet, whose samples are already light.
///
/// **The mean has to be of light, and which table says so depends on what the samples are.** A
/// coded frame's taps go through the PQ curve undone; a scene-linear one's are the light, so the
/// table that undoes its coding is the ramp - and a mean of samples is then the mean of what they
/// measure. Handing a linear frame to [`resize`] instead reads each sample as a PQ code, which is
/// monotone and so looks plausible while weighing a box's bright taps as though several stops of
/// scene were one of signal: measured over a stacked set of twenty-six frames, that read the peak
/// it was being measured for 5% high, and how far it reaches is the local contrast's to decide
/// rather than bounded by anything.
pub fn resize_scene(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    frame: &crate::resident::Resident,
    out: (usize, usize),
) -> Option<crate::resident::Resident> {
    resized_through(gpu, base, frame, out, &base.light_of_level)
}

fn resized_through(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    frame: &crate::resident::Resident,
    out: (usize, usize),
    light_of_sample: &crate::gpu::Buffer,
) -> Option<crate::resident::Resident> {
    let source = frame.size();
    let (sw, sh) = source;
    if out.0 >= sw || out.1 >= sh || out.0 == 0 || out.1 == 0 {
        return None;
    }
    let pixels = out.0 * out.1;

    let smaller = crate::resident::Resident::empty(gpu, out.0, out.1);
    let mut recording = gpu.record();
    recording.holding(frame.buffer());
    recording.holding(smaller.buffer());
    let uniform = reduction(
        &mut recording,
        source,
        out,
        (sw as f64 / out.0 as f64, sh as f64 / out.1 as f64),
    );
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("resize"),
        layout: &base.resize_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: frame.buffer().as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: smaller.buffer().as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: light_of_sample.as_entire_binding(),
            },
        ],
    });

    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.resize);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = groups(pixels.div_ceil(2));
        pass.dispatch_workgroups(x, y, 1);
    }
    recording.submit();
    Some(smaller)
}

/// What the editor's draw averages a zoomed-out canvas with: the frame halved, and halved again,
/// until a side is one.
///
/// The chain is the client's, entry point for entry point - `halve` off the frame's buffer, then
/// `reduce` off the level above - so the level a canvas reads at some zoom and the frame a rendition
/// is cut to at the same ratio come out of the same weighted footprint.
///
/// Stays on the device, because the draw binds it: [`Pyramid::levels_host`] is for the test that
/// holds it against the resize.
///
/// Starts at half resolution, so the frame is not stored twice, and the level that leaves out is the
/// one a draw reads straight from the buffer.
pub fn pyramid(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &[u16],
    source: (usize, usize),
) -> Option<Pyramid> {
    let (sw, sh) = source;
    if samples.len() < sw * sh * 3 {
        return None;
    }
    let frame = crate::resident::Resident::upload(gpu, samples, sw, sh);
    let built = pyramid_of(gpu, base, &frame, source);
    frame.reclaim();
    built
}

/// The same chain, off a frame that is already on the device.
///
/// What the editor builds from: its frame stays up for the life of an open, so uploading a copy
/// to average would be the transfer the whole path exists to avoid.
pub fn pyramid_of(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    frame: &crate::resident::Resident,
    source: (usize, usize),
) -> Option<Pyramid> {
    let (sw, sh) = source;
    if sw < 2 || sh < 2 || frame.samples() < sw * sh * 3 {
        return None;
    }
    let half = (sw / 2, sh / 2);
    // Half a side, not the side: an adapter reporting 4096 holds an 8192px frame's pyramid. Asked
    // rather than dispatched into, because a texture over the limit is a validation error and
    // `on_uncaptured_error` makes those fatal - the editor would report a live frame over a black
    // canvas.
    if half.0.max(half.1) as u32 > gpu.limits().max_texture_dimension_2d {
        return None;
    }
    let levels = (half.0.max(half.1) as f64).log2().floor() as u32 + 1;
    let texture = gpu.own_texture(&wgpu::TextureDescriptor {
        label: Some("pyramid"),
        size: wgpu::Extent3d {
            width: half.0 as u32,
            height: half.1 as u32,
            depth_or_array_layers: 1,
        },
        mip_level_count: levels,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: PYRAMID_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let one_level = |level: u32| {
        texture.create_view(&wgpu::TextureViewDescriptor {
            base_mip_level: level,
            mip_level_count: Some(1),
            ..Default::default()
        })
    };
    let mut recording = gpu.record();
    recording.holding(frame.buffer());
    recording.holding_texture(&texture);
    let uniform = reduction(&mut recording, source, half, (2.0, 2.0));
    for level in 0..levels {
        let (coarser, finer) = (one_level(level.saturating_sub(1)), one_level(level));
        let mut entries = if level == 0 {
            vec![
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: frame.buffer().as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&finer),
                },
            ]
        } else {
            vec![
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&coarser),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&finer),
                },
            ]
        };
        entries.push(wgpu::BindGroupEntry {
            binding: 5,
            resource: base.light_of_code.as_entire_binding(),
        });
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pyramid level"),
            layout: if level == 0 {
                &base.halve_layout
            } else {
                &base.reduce_layout
            },
            entries: &entries,
        });
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(if level == 0 {
            &base.halve
        } else {
            &base.reduce
        });
        pass.set_bind_group(0, &group, &[]);
        let across = ((half.0 >> level).max(1) as u32).div_ceil(8);
        let down = ((half.1 >> level).max(1) as u32).div_ceil(8);
        pass.dispatch_workgroups(across, down, 1);
    }

    recording.submit();
    Some(Pyramid {
        texture,
        levels,
        half,
    })
}

/// The chain of averaged levels a zoomed-out draw reads, on the device.
pub struct Pyramid {
    texture: crate::gpu::Texture,
    /// `edit.max_lod` is this: `lod` 0 is the frame's own buffer, so the levels here are 1..=levels.
    pub levels: u32,
    /// Level 0's size, the frame halved.
    pub half: (usize, usize),
}

impl Pyramid {
    pub fn view(&self) -> wgpu::TextureView {
        self.texture.view()
    }

    /// The mips themselves, for a submission that binds a view onto them and has to keep them.
    pub fn texture(&self) -> &crate::gpu::Texture {
        &self.texture
    }

    pub fn size_of(&self, level: u32) -> (usize, usize) {
        ((self.half.0 >> level).max(1), (self.half.1 >> level).max(1))
    }

    /// Every level on the host, for the test that holds them against the resize.
    pub async fn levels_host(
        &self,
        gpu: &'static crate::gpu::Gpu,
    ) -> Option<Vec<(Vec<u16>, (usize, usize))>> {
        // Every level into one staging buffer in a single submit: a readback per level would be a
        // device poll per level, and the whole chain is smaller than the frame it came from.
        let strides: Vec<usize> = (0..self.levels)
            .map(|level| padded_row(self.size_of(level).0))
            .collect();
        let offsets: Vec<u64> = strides
            .iter()
            .enumerate()
            .scan(0u64, |at, (level, stride)| {
                let here = *at;
                *at += (stride * self.size_of(level as u32).1) as u64;
                Some(here)
            })
            .collect();
        let last = self.levels as usize - 1;
        let mut recording = gpu.record();
        let staged = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("pyramid readback"),
            size: offsets[last] + (strides[last] * self.size_of(last as u32).1) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        for level in 0..self.levels {
            let (width, height) = self.size_of(level);
            recording.encoder().copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.texture,
                    mip_level: level,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyBufferInfo {
                    buffer: &staged,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: offsets[level as usize],
                        bytes_per_row: Some(strides[level as usize] as u32),
                        rows_per_image: Some(height as u32),
                    },
                },
                wgpu::Extent3d {
                    width: width as u32,
                    height: height as u32,
                    depth_or_array_layers: 1,
                },
            );
        }
        recording.submit();

        let mut built: Vec<(Vec<u16>, (usize, usize))> = (0..self.levels)
            .map(|level| {
                let size = self.size_of(level);
                (vec![0u16; size.0 * size.1 * 3], size)
            })
            .collect();
        crate::gpu::read_back(gpu, &staged, |mapped| {
            for (level, (out, size)) in built.iter_mut().enumerate() {
                let stride = strides[level];
                let at = offsets[level] as usize;
                for row in 0..size.1 {
                    let bytes = &mapped[at + row * stride..];
                    for column in 0..size.0 {
                        // RGBA on the device, RGB in a frame: the alpha the store wrote is a
                        // constant.
                        for channel in 0..3 {
                            let byte = column * 8 + channel * 2;
                            out[(row * size.0 + column) * 3 + channel] =
                                u16::from_le_bytes([bytes[byte], bytes[byte + 1]]);
                        }
                    }
                }
            }
        })
        .await?;
        // Both handles, then the poll: the recording's copy is not the last one while `staged` is
        // still a named local.
        drop((staged, recording));
        gpu.nudge();
        Some(built)
    }
}

/// A texture copy's rows are 256-byte aligned, whatever the row itself is.
fn padded_row(width: usize) -> usize {
    (width.max(1) * 8).div_ceil(256) * 256
}

/// The correction on its own, measured and applied over one resident frame, for a caller about to
/// fit the camera match against it.
///
/// **The fit has to see a defringed frame.** It compares our render against the camera's embedded
/// JPEG, which the camera has already defringed, so leaving the fringe on asks the geometry search
/// to match two pictures that differ by a defect we know how to remove. [`prepare`] corrects too,
/// but it ends in PQ and the fit wants linear - so where a match is about to be fitted, the
/// correction runs here first and `prepare` is told the pair so it does not repeat it.
///
/// **Which is only ever a first open.** A photograph whose match is stored skips the fit entirely
/// and goes straight down `prepare`; this pass is the one an open pays on the way to a fit it is
/// already spending half a second on.
///
/// Written into the frame it is given, which stays on the device: the fit reads a host copy
/// ([`crate::resident::Resident::host`]) and `prepare` then runs over this same buffer.
///
/// Returns the pair it used, for `prepare` and for the analysis file.
pub async fn correct(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    frame: &crate::resident::Resident,
    strengths: crate::image::Strengths,
    defocus: Option<(f32, f32)>,
    noise: Option<crate::galosh::NoiseFit>,
    matrix: Option<[[f32; 3]; 3]>,
) -> Option<(f32, f32)> {
    let (width, height) = frame.size();
    if width == 0 || height == 0 {
        return None;
    }
    let defocus = match (defocus, strengths.defringe > 0.0) {
        (Some(given), _) => given,
        (None, true) => {
            measure_defocus_into(gpu, base, frame.buffer(), width, height, noise, matrix)
                .await
                .map(|(red, blue)| {
                    let scale = strengths.defringe.clamp(0.0, 1.0) as f32;
                    (red * scale, blue * scale)
                })
                .unwrap_or((0.0, 0.0))
        }
        (None, false) => (0.0, 0.0),
    };
    if !defringes(frame.samples(), width, height, defocus) {
        return Some(defocus);
    }
    let mut recording = gpu.record();
    recording.holding(frame.buffer());
    defringe_into(
        gpu,
        base,
        &mut recording,
        frame.buffer(),
        width,
        height,
        defocus,
    );
    recording.submit();
    Some(defocus)
}

/// Longitudinal chromatic aberration, as `defocus.slang` measured it.
///
/// `defocus` is [`measure_defocus`]'s pair, already scaled by the setting.
pub async fn defringe(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &mut [u16],
    width: usize,
    height: usize,
    defocus: (f32, f32),
) -> Option<()> {
    if !defringes(samples.len(), width, height, defocus) {
        return Some(());
    }
    let frame = crate::resident::Resident::upload(gpu, samples, width, height);
    let mut recording = gpu.record();
    recording.holding(frame.buffer());
    defringe_into(
        gpu,
        base,
        &mut recording,
        frame.buffer(),
        width,
        height,
        defocus,
    );
    let read = frame.read_into(&mut recording, samples).await;
    drop(recording);
    frame.reclaim();
    read
}

/// A frame with no room for the stencil has no curvature to read, and the border fill would
/// be the whole of it.
///
/// Asked rather than discovered, because [`prepare`] has to know before it uploads whether the
/// stage is in the chain at all.
fn defringes(samples: usize, width: usize, height: usize, defocus: (f32, f32)) -> bool {
    width >= 3 && height >= 3 && defocus != (0.0, 0.0) && samples >= width * height * 3
}

/// Records the correction against a frame already in VRAM. `defringes` is its precondition.
fn defringe_into(
    gpu: &crate::gpu::Gpu,
    base: &Base,
    recording: &mut crate::gpu::Recording<'_>,
    frame: &crate::gpu::Buffer,
    width: usize,
    height: usize,
    defocus: (f32, f32),
) {
    let pixels = width * height;

    let luma = recording.buffer(&wgpu::BufferDescriptor {
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
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("defringe params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("defringe"),
        layout: &base.defringe_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: frame.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: luma.as_entire_binding(),
            },
        ],
    });

    {
        // A pass each, because the second reads every value the first wrote and a pass is where
        // wgpu puts that barrier.
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.defringe_luma);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = groups(pixels);
        pass.dispatch_workgroups(x, y, 1);
    }
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.defringe_apply);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = groups(pixels.div_ceil(2));
        pass.dispatch_workgroups(x, y, 1);
    }
}

/// A frame with no room for the deconvolution's stencil has nothing to sharpen.
pub(crate) fn sharpens(samples: usize, width: usize, height: usize, amount: f64) -> bool {
    amount > 0.0 && width >= 3 && height >= 3 && samples >= width * height * 3
}

pub(crate) struct AtomicF32(std::sync::atomic::AtomicU32);

impl AtomicF32 {
    pub(crate) const fn new(value: f32) -> AtomicF32 {
        AtomicF32(std::sync::atomic::AtomicU32::new(value.to_bits()))
    }

    pub(crate) fn set(&self, value: f32) {
        self.0.store(value.to_bits(), std::sync::atomic::Ordering::Relaxed);
    }

    /// What was forced, or `default` while nothing non-negative has been.
    pub(crate) fn or(&self, default: f64) -> f32 {
        match f32::from_bits(self.0.load(std::sync::atomic::Ordering::Relaxed)) {
            forced if forced >= 0.0 => forced,
            _ => default as f32,
        }
    }
}

/// Richardson-Lucy against a frame already in VRAM. `sharpens` is its precondition.
///
/// Four dispatches per iteration over ping-pong luma planes, then the neighbourhood range and the
/// limit-and-blend write.
pub(crate) fn sharpen_into(
    gpu: &crate::gpu::Gpu,
    base: &Base,
    recording: &mut crate::gpu::Recording<'_>,
    frame: &crate::gpu::Buffer,
    width: usize,
    height: usize,
    amount: f64,
    sigma: crate::image::SharpenSigma,
    noise: crate::image::SharpenNoise,
    jacobian: Option<&crate::gpu::Buffer>,
) {
    let pixels = width * height;

    macro_rules! plane {
        ($label:expr) => {
            recording.buffer(&wgpu::BufferDescriptor {
                label: Some($label),
                size: (pixels * 4) as u64,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            })
        };
    }
    let observed = plane!("sharpen observed");
    let estimate = plane!("sharpen estimate");
    let blurred = plane!("sharpen blurred");
    let ratio = plane!("sharpen ratio");
    // The binding wants a buffer whether or not the sigma varies; one word of nothing where
    // the warp was not in the chain to hand one over.
    let unbent;
    let (jacobian, terms) = match (jacobian, sigma.terms) {
        (Some(plane), Some(terms)) => (plane, Some(terms)),
        _ => {
            unbent = recording.buffer(&wgpu::BufferDescriptor {
                label: Some("sharpen jacobian unused"),
                size: 4,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            });
            (&unbent, None)
        }
    };

    let taps = crate::image::gaussian(sigma.composed, crate::image::DECONVOLVE_RADIUS);
    let (capture, resample) = terms.unwrap_or((0.0, 0.0));
    let mut params = Vec::with_capacity(64);
    params.extend_from_slice(&(width as u32).to_le_bytes());
    params.extend_from_slice(&(height as u32).to_le_bytes());
    params.extend_from_slice(
        &((amount.clamp(0.0, 1.0) * crate::image::SHARPEN_GAIN) as f32).to_le_bytes(),
    );
    params.extend_from_slice(&f32::from(u16::MAX).to_le_bytes());
    // `capture` and `resample` sit in the two `vec3f` tails, which is the shader's own layout
    // rather than a convenience: a scalar after a `vec3f` packs into its fourth word, so a
    // host writing it one slot later feeds `spatial` a sigma's bit pattern.
    for tap in &taps {
        params.extend_from_slice(&tap.to_le_bytes());
    }
    params.extend_from_slice(&capture.to_le_bytes());
    for channel in crate::image::LUMA {
        params.extend_from_slice(&channel.to_le_bytes());
    }
    params.extend_from_slice(&resample.to_le_bytes());
    params.extend_from_slice(&u32::from(terms.is_some()).to_le_bytes());
    params.extend_from_slice(&(crate::image::SHARPEN_OVERSHOOT as f32).to_le_bytes());
    // std140 rounds the block to a multiple of sixteen.
    params.resize(params.len().next_multiple_of(16), 0);
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("sharpen params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let noise = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("sharpen noise"),
        contents: &sharpen_noise_bytes(noise),
        usage: wgpu::BufferUsages::STORAGE,
    });

    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("sharpen"),
        layout: &base.sharpen_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: frame.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: observed.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: estimate.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: blurred.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: ratio.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 6,
                resource: jacobian.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 7,
                resource: base.light_of_code.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 8,
                resource: noise.as_entire_binding(),
            },
        ],
    });

    // A pass each: every dispatch reads what the one before wrote, and on Metal a read within one
    // pass can land before the write (`galosh::run` measured it).
    let encoder = recording.encoder();
    let mut run = |pipeline: &wgpu::ComputePipeline, count: usize| {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = groups(count);
        pass.dispatch_workgroups(x, y, 1);
    };

    run(&base.sharpen_luma, pixels);
    for _ in 0..crate::image::DECONVOLVE_ITERATIONS {
        run(&base.sharpen_spread, pixels);
        run(&base.sharpen_ratio, pixels);
        run(&base.sharpen_gather, pixels);
        run(&base.sharpen_correct, pixels);
    }
    run(&base.sharpen_range, pixels);
    run(&base.sharpen_apply, pixels.div_ceil(2));
}

const SHARPEN_NOISE_SENSITIVITY: usize = 0;
const SHARPEN_NOISE_SHOT: usize = 9;
const SHARPEN_NOISE_READ: usize = 12;
const SHARPEN_NOISE_WORDS: usize = 15;

fn sharpen_noise_bytes(noise: crate::image::SharpenNoise) -> Vec<u8> {
    let mut words = [0.0f32; SHARPEN_NOISE_WORDS];
    for camera in 0..3 {
        words[SHARPEN_NOISE_SENSITIVITY + camera * 3..][..3]
            .copy_from_slice(&noise.sensitivity[camera]);
    }
    words[SHARPEN_NOISE_SHOT..][..3].copy_from_slice(&noise.shot_per_light);
    words[SHARPEN_NOISE_READ..][..3].copy_from_slice(&noise.read_variance);
    let mut out = Vec::with_capacity(SHARPEN_NOISE_WORDS * 4);
    for value in words {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

/// Invocations per workgroup, and the pair every kernel here is dispatched over.
const LANES: u32 = 64;

/// Workgroups to a row of a two-dimensional dispatch, which `lanes.slang`'s `ROW_GROUPS` is the
/// shader's copy of.
///
/// **Only meaningful because `groups` below dispatches `x` at exactly this whenever `y` exceeds
/// one.** The shaders fold `y` back in by multiplying by this rather than by asking how wide the
/// dispatch actually was, so the two numbers are one number and
/// `the_shaders_split_a_dispatch_where_the_host_does` refuses a build where they drift.
pub(crate) const ROW_GROUPS: u32 = 32768;

/// Workgroups for `count` invocations, spread over two dimensions.
///
/// **A dispatch dimension stops at 65535**, which one dimension of 64-wide groups reaches at 4.19M
/// invocations - a 61MP frame is fourteen times that, and the driver refuses the whole command
/// buffer rather than clamping. Every kernel here indexes by a linear id, so the second dimension
/// is a carry rather than a shape and `lanes.slang`'s `linear` undoes it.
///
/// Found by wiring the warp into a real render: the tests all ran on synthetic frames of a few
/// hundred pixels a side, where a dispatch is hundreds of groups and this is invisible.
pub fn groups(count: usize) -> (u32, u32) {
    let groups = (count as u32).div_ceil(LANES).max(1);
    // `min`, so a dispatch that fits one row is not padded out to a full one. The shader's fold is
    // still exact there: `y` is 1, so the term it would multiply is zero.
    let across = groups.min(ROW_GROUPS);
    (across, groups.div_ceil(across))
}

/// The sharpen alone, over a frame on the host.
///
/// Takes and returns the frame rather than leaving it on the GPU, as [`encode_base`] below
/// does: this spelling is what lets the fixtures and the pins drive the one implementation
/// without assembling the whole prepare around it.
pub async fn sharpen_base(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &mut [u16],
    width: usize,
    height: usize,
    amount: f64,
    sigma: f32,
) -> Option<()> {
    if !sharpens(samples.len(), width, height, amount) {
        return Some(());
    }
    let frame = crate::resident::Resident::upload(gpu, samples, width, height);
    let mut recording = gpu.record();
    recording.holding(frame.buffer());
    sharpen_into(
        gpu,
        base,
        &mut recording,
        frame.buffer(),
        width,
        height,
        amount,
        crate::image::SharpenSigma::fixed(sigma),
        crate::image::SharpenNoise::NONE,
        None,
    );
    recording.submit();
    drop(recording);
    let sharpened = frame.into_host().await?;
    samples[..width * height * 3].copy_from_slice(&sharpened[..width * height * 3]);
    Some(())
}

/// Scene-linear levels to normalised PQ, through [`coding_curve`]'s table of [`crate::tone::pq`].
///
/// Takes and returns the frame rather than leaving it on the GPU, which [`prepare`] is the version
/// that does not: this spelling is what lets the coding be held against ST 2084 on its own.
pub async fn encode_base(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &mut [u16],
    levels: crate::tone::Anchored,
    reference_white_nits: crate::light::Light<crate::light::SceneNits>,
) -> Option<()> {
    if samples.is_empty() {
        return Some(());
    }
    // A row of pixels, whatever the frame's real shape: the coding is pointwise and the kernel is
    // dispatched over words, so nothing here reads a stride. Rounded up rather than down, so a
    // caller with a sample count that is not three's multiple - the coding's own pin, which walks
    // every level and one over - still gets a buffer its samples fit in.
    let frame = crate::resident::Resident::upload(gpu, samples, samples.len().div_ceil(3), 1);
    let mut recording = gpu.record();
    recording.holding(frame.buffer());
    encode_base_into(
        gpu,
        base,
        &mut recording,
        frame.buffer(),
        samples.len(),
        levels,
        reference_white_nits,
    );
    let read = frame.read_into(&mut recording, samples).await;
    drop(recording);
    frame.reclaim();
    read
}

/// What `coded` in `base.slang` looks up: every level a `u16` can hold, coded, two to a word.
///
/// **Evaluated here rather than in the shader, and `condition.rs` gives the argument.** The domain
/// is 65536 entries, which is a quarter of a megabyte and a fraction of a millisecond; evaluating
/// ST 2084 per sample in `f32` instead disagrees with this `f64` by a count on about a fifth of a
/// real frame. Neither answer is wrong, but only one of them can be the coding, and the accurate one
/// costs nothing at this size.
fn coding_curve(
    levels: crate::tone::Anchored,
    reference_white_nits: crate::light::Light<crate::light::SceneNits>,
) -> Vec<u8> {
    // Nits per level, hoisted out of the loop: `pq` takes the scene's own nits, and one multiply
    // per entry is what the table has always been evaluated as.
    let scale = reference_white_nits.raw() / levels.white.raw();
    let mut out = Vec::with_capacity((u16::MAX as usize + 1) * 2);
    for level in 0..=u16::MAX {
        let nits =
            crate::light::Light::<crate::light::SceneNits>::measured(f64::from(level) * scale);
        let coded = (crate::tone::pq(nits).raw() * f64::from(u16::MAX)).round();
        out.extend_from_slice(&(coded as u16).to_le_bytes());
    }
    out
}

/// The light a full-scale mosaic sample codes to, in the normalisation [`Base::light_of_code`]
/// answers in.
///
/// **What carries a measurement made on the mosaic into a coded frame's units.** A noise fit is a
/// variance at a signal in the mosaic's own normalisation, where a coded frame is in light against
/// PQ's ceiling; the two differ by this frame's anchoring, which is a factor of about 25 at a
/// reference white of 203 nits. `pq_inv` undoes `coding_curve`'s `pq` exactly, so this is the
/// coding's own `scale` and no curve at all.
pub fn full_scale_light(
    levels: crate::tone::Anchored,
    reference_white_nits: crate::light::Light<crate::light::SceneNits>,
) -> f32 {
    let ceiling =
        crate::tone::pq_inv::<crate::light::SceneNits>(crate::light::Light::measured(1.0)).raw();
    let scale = reference_white_nits.raw() / levels.white.raw();
    (f64::from(u16::MAX) * scale / ceiling) as f32
}

/// The mosaic noise fit in the coded RGB frame capture sharpening reads.
pub fn sharpen_noise(
    levels: crate::tone::Anchored,
    reference_white_nits: crate::light::Light<crate::light::SceneNits>,
    noise: Option<crate::galosh::NoiseFit>,
    matrix: Option<[[f32; 3]; 3]>,
    wb_gains: [f32; 3],
    reduction: usize,
) -> crate::image::SharpenNoise {
    let Some(model) = noise.map(|fit| fit.model()) else {
        return crate::image::SharpenNoise::NONE;
    };
    let identity = [[1.0f64, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let matrix = matrix.map_or(identity, |matrix| matrix.map(|row| row.map(f64::from)));
    let output_luma = crate::image::LUMA.map(f64::from);
    let sensitivity = std::array::from_fn(|camera| {
        std::array::from_fn(|output| (output_luma[output] * matrix[output][camera]) as f32)
    });
    let (fitted_shot, fitted_read) = noise_already_balanced(wb_gains);
    let full = f64::from(full_scale_light(levels, reference_white_nits));
    let mut shot_per_light = wb_gains.map(|gain| {
        f64::from(model.alpha) * full * f64::from(gain) / fitted_shot.max(f64::MIN_POSITIVE)
    });
    let mut read_variance = wb_gains.map(|gain| {
        f64::from(model.sigma_sq) * full * full * f64::from(gain).powi(2)
            / fitted_read.max(f64::MIN_POSITIVE)
    });
    match crate::hdr_fit::invert3(&matrix) {
        Some(inverse) => {
            for camera in 0..3 {
                shot_per_light[camera] *= inverse[camera].iter().map(|v| v.abs()).sum::<f64>();
            }
        }
        None => {
            for camera in 0..3 {
                read_variance[camera] += shot_per_light[camera] * full;
                shot_per_light[camera] = 0.0;
            }
        }
    }
    crate::image::SharpenNoise {
        sensitivity,
        shot_per_light: shot_per_light.map(|value| value as f32),
        read_variance: read_variance.map(|value| value as f32),
        reduction,
    }
}

/// What a mosaic fit's two terms become in a luma plane past the white balance.
///
/// A channel multiplied by `g` has `g²` times its source variance, but its shot term is
/// proportional to the pre-gain signal `L / g`; shot therefore scales by `g` and read noise by
/// `g²`. Luma weights are squared because independent channel variances add after weighting.
pub fn noise_through_balance(luma: [f64; 3], wb_gains: [f32; 3]) -> (f64, f64) {
    let mut shot = 0.0;
    let mut read = 0.0;
    for (weight, gain) in luma.iter().zip(wb_gains) {
        let share = weight * weight;
        shot += share * f64::from(gain);
        read += share * f64::from(gain) * f64::from(gain);
    }
    (shot, read)
}

/// The same two factors a `NoiseFit` **already carries**, the conditioning having gained the mosaic
/// before GALOSH ever measured it.
///
/// `decode_rawler::conditioned` multiplies each photosite by its channel's gain, and `Held::fit`
/// runs over that - so the fitted `alpha` and `sigma_sq` are an average of the four CFA positions'
/// own, `ne_block_stats` measuring each position separately and `ne_finalize` binning all of them
/// by level together. The mean is therefore over R, G, G and B, greens twice; the per-channel
/// terms are only a *re*-weighting once divided by this.
pub fn noise_already_balanced(wb_gains: [f32; 3]) -> (f64, f64) {
    let positions = [wb_gains[0], wb_gains[1], wb_gains[1], wb_gains[2]];
    let shot = positions.iter().map(|g| f64::from(*g)).sum::<f64>() / 4.0;
    let read = positions
        .iter()
        .map(|g| f64::from(*g) * f64::from(*g))
        .sum::<f64>()
        / 4.0;
    (shot, read)
}

/// Records the coding against a frame already in VRAM, `count` samples of it.
fn encode_base_into(
    gpu: &crate::gpu::Gpu,
    base: &Base,
    recording: &mut crate::gpu::Recording<'_>,
    frame: &crate::gpu::Buffer,
    count: usize,
    levels: crate::tone::Anchored,
    reference_white_nits: crate::light::Light<crate::light::SceneNits>,
) {
    let words = count.div_ceil(2);
    // The scale is folded into the curve, so nothing but the two lengths crosses here.
    let params = [words as u32, count as u32, 0, 0];
    let mut params_bytes = Vec::with_capacity(16);
    for word in params {
        params_bytes.extend_from_slice(&word.to_le_bytes());
    }
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("base params"),
        contents: &params_bytes,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let curve = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("base curve"),
        contents: &coding_curve(levels, reference_white_nits),
        usage: wgpu::BufferUsages::STORAGE,
    });

    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("base"),
        layout: &base.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: frame.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: curve.as_entire_binding(),
            },
        ],
    });

    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.encode);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = groups(words);
        pass.dispatch_workgroups(x, y, 1);
    }
}

/// `image::ratio_tables` end to end, as `f32`.
///
/// **The table, not the spline.** The knots are `f64` and evaluating them per pixel is a handful
/// of instructions a shader would not notice - but its 4096 buckets in r^2 and the linear
/// interpolation between them are part of the answer, not an optimisation over it: the fit's
/// gather (`fit_warp.slang`) and the host's decode window (`image::lens_footprint`) read the same
/// table, and a shader that evaluated the spline exactly would disagree with both in a way that
/// moves with the lens. So the quantisation is uploaded along with the values.
pub(crate) fn ratio_tables(lens: &crate::fit::Lens) -> Vec<f32> {
    crate::image::ratio_tables(
        lens.distortion.as_deref().unwrap_or_default(),
        lens.crop,
        &lens.channels(),
    )
    .iter()
    .flatten()
    .map(|ratio| *ratio as f32)
    .collect()
}

/// `g^m1` per radius bucket, and 1.0 where there is no falloff to undo.
///
/// A flat table of ones rather than a flag, since the shader already refuses to round-trip a gain
/// of exactly 1 - the one branch answers both.
pub(crate) fn lift_table(falloff: Option<(f64, f64)>) -> Vec<f32> {
    (0..256)
        .map(|radius| {
            let Some((a, b)) = falloff else { return 1.0 };
            let gain = crate::fit::Gain::at(a, b, radius as u8);
            match (gain - 1.0).abs() < 1e-5 {
                true => 1.0,
                false => crate::tone::gain_in_y(crate::light::Gain::of_ratio(gain)) as f32,
            }
        })
        .collect()
}

pub(crate) fn float_storage(
    recording: &mut crate::gpu::Recording<'_>,
    label: &str,
    values: &[f32],
) -> crate::gpu::Buffer {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: &bytes,
        usage: wgpu::BufferUsages::STORAGE,
    })
}

/// Which pixels a gather writes, and where the optics they are corrected through are centred.
///
/// **One type because there is one gather.** A whole frame corrects itself about its own centre; a
/// loupe tile is a rectangle of the same photograph and has to be corrected about the
/// *photograph's*, at the radius the frame would have read there. Those differ by three numbers,
/// and holding them in a struct is what stops the second case being a second kernel - which is what
/// it was, on the CPU, and what left a magnified region a count or two from the render it predicts.
/// **Every rectangle here is the frame's own**, never the photograph's: a window is named in the
/// pixels of the buffer that was decoded to feed it, and at `Scale::Half` those are not the same
/// numbers. The types say so, because the three arguments below are otherwise interchangeable and
/// two of them being in one space and the third in another produces a picture rather than an error.
#[derive(Clone, Copy)]
pub struct Gather {
    /// The buffer the taps read, which is the whole frame for one and the decoded region for the
    /// other.
    pub source: crate::px::Size<crate::px::Drawn>,
    /// The grid written.
    pub out: crate::px::Size<crate::px::Drawn>,
    /// The photograph's centre, half a pixel back: the taps read a grid where an integer is a
    /// pixel's centre.
    ///
    /// The photograph's rather than this buffer's, with [`Gather::origin`] taken off afterwards -
    /// `warp.slang`'s `Params::centre` says what folding the two together costs.
    centre: (f64, f64),
    /// Where this buffer starts in the photograph. Zero for a whole frame.
    origin: (f64, f64),
    /// Source pixels per output pixel, which the ratio multiplies into.
    scale: (f64, f64),
    /// Where output pixel zero sits relative to that centre.
    bias: (f64, f64),
    /// `1 / half^2` of the grid the lens is defined over.
    inv_half2: f64,
}

impl Gather {
    /// A whole frame onto a grid its own size, which is every warp that does not also resize.
    pub fn frame(size: crate::px::Size<crate::px::Drawn>) -> Gather {
        Gather::whole(size, size)
    }

    /// A whole frame onto a grid of its own, resizing where the two differ.
    pub fn whole(
        source: crate::px::Size<crate::px::Drawn>,
        out: crate::px::Size<crate::px::Drawn>,
    ) -> Gather {
        let (sw, sh) = source.raw();
        let (ow, oh) = out.raw();
        let half2 = (ow as f64 / 2.0).powi(2) + (oh as f64 / 2.0).powi(2);
        Gather {
            source,
            out,
            centre: (sw as f64 / 2.0 - 0.5, sh as f64 / 2.0 - 0.5),
            origin: (0.0, 0.0),
            scale: (sw as f64 / ow as f64, sh as f64 / oh as f64),
            bias: (-(ow as f64) / 2.0, -(oh as f64) / 2.0),
            inv_half2: 1.0 / half2,
        }
    }

    /// A rectangle of a photograph, corrected as the photograph's own gather would correct it.
    ///
    /// `window` is `[left, top, width, height]` of the output, in the corrected picture's pixels;
    /// `region` is the piece of the frame that was decoded to feed it. The scale is one - a tile is
    /// read at the frame's own resolution - so what changes from [`Gather::whole`] is where the
    /// photograph's centre falls in the buffer and where the window sits relative to it.
    ///
    /// `image::lens_footprint` reads the identical plan for what has to be *decoded*, which is a
    /// bounds question the host answers before there are any pixels to gather.
    pub fn window(
        full: crate::px::Size<crate::px::Drawn>,
        window: crate::px::Rect<crate::px::Drawn>,
        region: crate::px::Rect<crate::px::Drawn>,
    ) -> Gather {
        let (fw, fh) = full.raw();
        let (window_left, window_top, window_w, window_h) = window.raw();
        let (region_left, region_top, region_w, region_h) = region.raw();
        let half2 = (fw as f64 / 2.0).powi(2) + (fh as f64 / 2.0).powi(2);
        Gather {
            source: crate::px::Size::exact(region_w, region_h),
            out: crate::px::Size::exact(window_w, window_h),
            // The frame's own, exactly as `Gather::whole` computes it for the frame this is a
            // piece of, so the two land on the same tap to the bit.
            centre: (fw as f64 / 2.0 - 0.5, fh as f64 / 2.0 - 0.5),
            origin: (region_left as f64, region_top as f64),
            scale: (1.0, 1.0),
            bias: (
                window_left as f64 - fw as f64 / 2.0,
                window_top as f64 - fh as f64 / 2.0,
            ),
            inv_half2: 1.0 / half2,
        }
    }
}

/// The lens correction, gathered onto a frame of its own.
///
/// None where there is nothing to do - an identity lens, or a source too small to tap - and also
/// what a refused device gives: both want the caller to leave the frame alone.
///
/// Bicubic. The fit gathers its own planes through `fit_warp.slang`'s bilinear, over f32 RGB
/// that never reaches this buffer layout.
pub fn warp_lens(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    frame: &crate::resident::Resident,
    gather: Gather,
    lens: &crate::fit::Lens,
) -> Option<(crate::resident::Resident, crate::gpu::Buffer)> {
    if !warps(frame.samples(), gather.source.raw(), gather.out.raw(), lens) {
        return None;
    }
    let (out_w, out_h) = gather.out.raw();
    let warped = crate::resident::Resident::empty(gpu, out_w, out_h);
    let mut recording = gpu.record();
    recording.holding(frame.buffer());
    recording.holding(warped.buffer());
    let jacobian = warp_lens_into(
        gpu,
        base,
        &mut recording,
        frame.buffer(),
        warped.buffer(),
        gather,
        lens,
    );
    recording.submit();
    // The jacobian outlives this recording: the caller sharpens through it, and its own recording
    // is what frees it.
    Some((warped, jacobian))
}

/// Nothing to gather for an identity lens, and nothing to tap below two pixels a side: the shader
/// indexes `sw - 2u` unsigned, so a one-pixel source would read the far end of the buffer.
///
/// Asked rather than discovered, for [`prepare`]'s sake: whether the warp runs is which buffer
/// holds the prepared frame.
fn warps(
    samples: usize,
    source: (usize, usize),
    out: (usize, usize),
    lens: &crate::fit::Lens,
) -> bool {
    let (sw, sh) = source;
    !lens.is_identity() && sw >= 2 && sh >= 2 && out.0 > 0 && out.1 > 0 && samples >= sw * sh * 3
}

/// Records the gather from one resident frame onto another, handing back the per-pixel
/// Jacobian plane the sharpen scales its sigma by. `warps` is its precondition.
fn warp_lens_into(
    gpu: &crate::gpu::Gpu,
    base: &Base,
    recording: &mut crate::gpu::Recording<'_>,
    frame: &crate::gpu::Buffer,
    warped: &crate::gpu::Buffer,
    gather: Gather,
    lens: &crate::fit::Lens,
) -> crate::gpu::Buffer {
    let (sw, sh) = gather.source.raw();
    let (width, height) = gather.out.raw();
    let pixels = width * height;

    let ratios = float_storage(recording, "warp ratios", &ratio_tables(lens));
    let lifts = float_storage(recording, "warp lifts", &lift_table(lens.falloff));
    let jacobian = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("warp jacobian"),
        size: (pixels.max(1) * 4) as u64,
        // `COPY_SRC` for the pin that reads it back against the plan's own derivative.
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });

    let mut params: Vec<u8> = Vec::with_capacity(64);
    for word in [sw as u32, sh as u32, width as u32, height as u32] {
        params.extend_from_slice(&word.to_le_bytes());
    }
    for value in [
        gather.centre.0 as f32,
        gather.centre.1 as f32,
        gather.origin.0 as f32,
        gather.origin.1 as f32,
        gather.scale.0 as f32,
        gather.scale.1 as f32,
        (sw - 1) as f32,
        (sh - 1) as f32,
        gather.bias.0 as f32,
        gather.bias.1 as f32,
        gather.inv_half2 as f32,
        0.0,
    ] {
        params.extend_from_slice(&value.to_le_bytes());
    }
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("warp params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("warp"),
        layout: &base.warp_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: frame.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: warped.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: ratios.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: lifts.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: jacobian.as_entire_binding(),
            },
        ],
    });

    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.warp);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = groups(pixels.div_ceil(2));
        pass.dispatch_workgroups(x, y, 1);
    }
    jacobian
}

/// Sampled points one invocation sums before the host takes over, and `defocus.slang`'s pair.
///
/// Held against the shader's own by `the_defocus_numbers_are_the_ones_the_shader_declares`, with
/// the three beside it: a host that sized the readback by one number while the kernel binned by
/// another would read plausible sums out of the wrong slots, which is the failure with no symptom.
const DEFOCUS_PER_SEGMENT: usize = 64;

/// How much softer red and blue are than green, as a multiple of luma's curvature.
///
/// **The GPU takes the pixels and the host keeps the fit.** Both whole-frame reductions are
/// dispatches: the radial sums over every third pixel, and the three residual histograms each
/// channel's noise sigma is a median of. What comes back is 24 numbers per segment and three
/// 1024-bucket histograms, and everything downstream of that reads six points - a median of a
/// histogram, a weighted line through six samples and four vetoes, which is not arithmetic a GPU
/// has anything to offer on.
///
/// Read in linear and ahead of the coding, for the reason [`prepare`] records at length: the model
/// is `R - luma = k.laplacian(luma)`, which holds because convolution is linear in intensity and
/// only locally in a perceptual domain.
///
/// None where there is nothing to fit: too few samples, too few bins that resolve, a coefficient
/// past what a lens does, or two channels that disagree in sign.
pub async fn measure_defocus(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &[u16],
    width: usize,
    height: usize,
    noise: Option<crate::galosh::NoiseFit>,
    matrix: Option<[[f32; 3]; 3]>,
) -> Option<(f32, f32)> {
    if samples.len() < width * height * 3 {
        return None;
    }
    let frame = crate::resident::Resident::upload(gpu, samples, width, height);
    let measured =
        measure_defocus_into(gpu, base, frame.buffer(), width, height, noise, matrix).await;
    frame.reclaim();
    measured
}

/// The blur in the frame, off the 10-90 distance of its own sharpest edges.
///
/// In linear light and after the demosaic, which is where that distance is 2.563 sigma and where
/// the number means the blur the sharpen will actually meet. [`crate::image::EDGE_SPREAD_BINS`]
/// and the decile are on the host so that the shader stays a vote and nothing else.
pub async fn measure_edge_spread(
    gpu: &crate::gpu::Gpu,
    base: &Base,
    frame: &crate::gpu::Buffer,
    width: usize,
    height: usize,
) -> Option<f32> {
    // The stencil reads two samples behind each start and nine ahead of it, so a frame narrower
    // than that has nothing to vote and the dispatch would be empty.
    if width < crate::image::EDGE_SPREAD_RUN + 5 || height == 0 {
        return None;
    }
    let bytes = crate::image::EDGE_SPREAD_BINS * 4;

    let mut recording = gpu.record();
    recording.holding(frame);
    // Zeroed explicitly, as the defocus residuals are and for the same reason: this one is added
    // to rather than written.
    let histogram = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("edge spread"),
        contents: &vec![0u8; bytes],
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    });

    let mut params: Vec<u8> = Vec::with_capacity(32);
    for word in [width as u32, height as u32] {
        params.extend_from_slice(&word.to_le_bytes());
    }
    // A `vec3f` aligns to four words, so the two counts above are followed by their own padding
    // rather than by the weights - the layout the shader declares.
    params.extend_from_slice(&[0u8; 8]);
    for channel in crate::image::LUMA {
        params.extend_from_slice(&channel.to_le_bytes());
    }
    params.extend_from_slice(&[0u8; 4]);
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("edge spread params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("edge spread"),
        layout: &base.edge_spread_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: frame.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: histogram.as_entire_binding(),
            },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.edge_spread);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((width as u32).div_ceil(16), (height as u32).div_ceil(16), 1);
    }
    let [mapped] = read_all(&mut recording, [(&histogram, bytes)]).await?;
    crate::image::edge_spread_sigma(&mapped)
}

/// A predicted reconstruction error past this, in 16-bit PQ codes, is a pixel a 4:2:0 decode gets
/// visibly wrong: 64 ten-bit steps, each of which ST 2084 was built to be about one just
/// noticeable difference.
///
/// **Several times the grain, not a step or two of it.** Every saturated surface carries chroma
/// grain of a thousand codes and more - PQ's foot makes a small linear noise a large one in codes
/// - and at a bar of 1024 six of seven frames measured had tiles mostly over it while their
/// encodes showed no leak at all, only 4:2:0's ordinary smoothing of chroma texture. What reads
/// as artefact is a channel handed several times its own grain: DSC03422's red hood, at a 99th
/// percentile of ~2200 codes, given ~8600 by the shipped file; its headlight's red, 2365 given
/// 6327. At this bar that frame's worst tile reads 0.24 and the next frame's 0.10, with the
/// clean frames at nothing.
pub(crate) const CHROMA_LEAK_CODES: f32 = 4096.0;

/// Blocks whose mean luma is under this many 16-bit PQ codes are not counted: 0.15 of the curve
/// is 1.7 nits, black on a display whose diffuse white is 203, and an error there is a
/// dark-adapted eye's to see.
pub(crate) const CHROMA_LEAK_DARK: f32 = 0.15 * 65535.0;

/// The tile the leak is counted over, in 2x2 blocks: 64 pixels a side.
const CHROMA_LEAK_TILE: usize = 32;

/// How much of a 4:2:0 encode of a PQ frame would come back wrong: the worst tile's fraction of
/// blocks whose reconstruction error exceeds [`CHROMA_LEAK_CODES`], from the frame on the device.
///
/// `chroma_leak.slang` has the arithmetic. The worst tile rather than the frame, because a
/// subject is small and a frame is large; the host walks tiles, never pixels.
pub async fn chroma_leak(
    gpu: &crate::gpu::Gpu,
    base: &Base,
    frame: &crate::gpu::Buffer,
    width: usize,
    height: usize,
) -> Option<f64> {
    let (blocks_w, blocks_h) = (width / 2, height / 2);
    if blocks_w == 0 || blocks_h == 0 {
        return Some(0.0);
    }
    let (tiles_w, tiles_h) = (
        blocks_w.div_ceil(CHROMA_LEAK_TILE),
        blocks_h.div_ceil(CHROMA_LEAK_TILE),
    );
    let bytes = tiles_w * tiles_h * 4;

    let mut recording = gpu.record();
    recording.holding(frame);
    let tiles = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("chroma leak"),
        contents: &vec![0u8; bytes],
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    });
    let mut params: Vec<u8> = Vec::with_capacity(32);
    for word in [width as u32, height as u32] {
        params.extend_from_slice(&word.to_le_bytes());
    }
    params.extend_from_slice(&CHROMA_LEAK_CODES.to_le_bytes());
    params.extend_from_slice(&CHROMA_LEAK_DARK.to_le_bytes());
    for word in [CHROMA_LEAK_TILE as u32, tiles_w as u32] {
        params.extend_from_slice(&word.to_le_bytes());
    }
    params.extend_from_slice(&[0u8; 8]);
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("chroma leak params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("chroma leak"),
        layout: &base.chroma_leak_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: frame.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: tiles.as_entire_binding(),
            },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.chroma_leak);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(
            (blocks_w as u32).div_ceil(16),
            (blocks_h as u32).div_ceil(16),
            1,
        );
    }
    let [mapped] = read_all(&mut recording, [(&tiles, bytes)]).await?;

    let mut fractions: Vec<(f64, usize, usize)> = mapped
        .chunks_exact(4)
        .enumerate()
        .map(|(tile, word)| {
            let leaking = f64::from(u32::from_le_bytes([word[0], word[1], word[2], word[3]]));
            // An edge tile holds fewer blocks, and its fraction is of what it holds.
            let (tx, ty) = (tile % tiles_w, tile / tiles_w);
            let wide = (blocks_w - tx * CHROMA_LEAK_TILE).min(CHROMA_LEAK_TILE);
            let tall = (blocks_h - ty * CHROMA_LEAK_TILE).min(CHROMA_LEAK_TILE);
            (
                leaking / (wide * tall) as f64,
                tx * CHROMA_LEAK_TILE * 2,
                ty * CHROMA_LEAK_TILE * 2,
            )
        })
        .collect();
    fractions.sort_by(|a, b| b.0.total_cmp(&a.0));
    if crate::clock::watched() {
        let top: Vec<String> = fractions
            .iter()
            .take(6)
            .map(|(f, x, y)| format!("{f:.3}@{x},{y}"))
            .collect();
        let over = fractions.iter().filter(|(f, _, _)| *f > 0.02).count();
        eprintln!(
            "  chroma leak tiles: {} over 2% of {}, worst {}",
            over,
            fractions.len(),
            top.join(" ")
        );
    }
    Some(fractions.first().map_or(0.0, |(f, _, _)| *f))
}

/// [`chroma_leak`] over a frame on the host, for the harness and the pins.
pub async fn chroma_leak_of(
    gpu: &'static crate::gpu::Gpu,
    base: &'static Base,
    samples: &[u16],
    width: usize,
    height: usize,
) -> Option<f64> {
    let frame = crate::resident::Resident::upload(gpu, samples, width, height);
    let leak = chroma_leak(gpu, base, frame.buffer(), width, height).await;
    frame.reclaim();
    leak
}

/// Reads a frame already in VRAM. Records and submits for itself rather than joining a caller's
/// recording: the answer is a host computation over what the kernels write, so this has to submit
/// and map before it can return one, and what the caller records next depends on the answer.
async fn measure_defocus_into(
    gpu: &crate::gpu::Gpu,
    base: &Base,
    frame: &crate::gpu::Buffer,
    width: usize,
    height: usize,
    noise: Option<crate::galosh::NoiseFit>,
    matrix: Option<[[f32; 3]; 3]>,
) -> Option<(f32, f32)> {
    // **The stencil has to fit, and this is where every caller meets.** `defocus.slang` reads the
    // row either side of each sample, so a frame under three pixels on an axis has nothing to
    // measure - and the arithmetic below says so violently rather than quietly: at two the bin
    // buffer is zero-sized and the bind group is a validation error, which this host makes fatal,
    // and at one `height - 2` underflows. A loupe tile can be that small (`tile::grown` grows a
    // 1x1 request to 2x2), so the guard belongs here rather than on the public spelling alone.
    if width < 3 || height < 3 {
        return None;
    }
    let bins = crate::image::DEFOCUS_BINS;
    let rows = (height - 2).div_ceil(crate::image::DEFOCUS_STRIDE);
    let across = (width - 2).div_ceil(crate::image::DEFOCUS_STRIDE);
    let segments = across.div_ceil(DEFOCUS_PER_SEGMENT);
    let partial_bytes = rows * segments * bins * 16;
    let histogram_bytes = 3 * crate::image::NOISE_BINS * 4;

    let mut recording = gpu.record();
    recording.holding(frame);
    let partials = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("defocus bins"),
        size: partial_bytes as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    // Zeroed explicitly: every other buffer here is written before it is read, and this one is
    // added to.
    let residuals = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("defocus residuals"),
        contents: &vec![0u8; histogram_bytes],
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    });

    let (cx, cy) = (width as f64 / 2.0, height as f64 / 2.0);
    let mut params: Vec<u8> = Vec::with_capacity(48);
    for word in [
        width as u32,
        height as u32,
        across as u32,
        rows as u32,
        segments as u32,
    ] {
        params.extend_from_slice(&word.to_le_bytes());
    }
    for value in [cx as f32, cy as f32, (cx * cx + cy * cy) as f32] {
        params.extend_from_slice(&value.to_le_bytes());
    }
    for channel in crate::image::LUMA {
        params.extend_from_slice(&channel.to_le_bytes());
    }
    // `vec3f` is padded to four words and `noise_max` lands in the hole, as the defringe's `full`
    // does - the layout the shader declares, not a coincidence.
    params.extend_from_slice(&crate::image::NOISE_MAX.to_le_bytes());
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("defocus params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("defocus"),
        layout: &base.defocus_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: frame.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: partials.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: residuals.as_entire_binding(),
            },
        ],
    });

    {
        // One pass for both, unlike the defringe's and the noise's: neither kernel reads what the
        // other writes, so there is no barrier to put between them.
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&base.defocus_bins);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = groups(rows * segments);
        pass.dispatch_workgroups(x, y, 1);
        pass.set_pipeline(&base.defocus_residuals);
        let (x, y) = groups(width * height);
        pass.dispatch_workgroups(x, y, 1);
    }
    let [packed, histograms] = read_all(
        &mut recording,
        [(&partials, partial_bytes), (&residuals, histogram_bytes)],
    )
    .await?;

    // The widening the shader could not do: an invocation sums 64 samples in `f32` where the CPU
    // sums a row in `f64`, and the segments meet here.
    let mut cross_red = vec![0.0f64; bins];
    let mut cross_blue = vec![0.0f64; bins];
    let mut square = vec![0.0f64; bins];
    let mut counted = vec![0.0f64; bins];
    for (at, sums) in packed.chunks_exact(16).enumerate() {
        let value = |o: usize| {
            f64::from(f32::from_le_bytes([
                sums[o],
                sums[o + 1],
                sums[o + 2],
                sums[o + 3],
            ]))
        };
        let bin = at % bins;
        cross_red[bin] += value(0);
        cross_blue[bin] += value(4);
        square[bin] += value(8);
        counted[bin] += value(12);
    }
    if counted.iter().sum::<f64>() < crate::image::DEFOCUS_MIN_SAMPLES as f64 {
        return None;
    }

    let ceiling = crate::image::noise_ceiling(noise);
    let sigmas: Vec<f64> = histograms
        .chunks_exact(4)
        .map(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]]))
        .collect::<Vec<u32>>()
        .chunks_exact(crate::image::NOISE_BINS)
        .map(|histogram| f64::from(crate::image::sigma_from(histogram, ceiling)))
        .collect();
    // The full covariance, not `sum w_c^2.v_c`: that reduction needs independent channels, and a
    // demosaic building red and blue out of green is what makes it untrue. On a flat frame the
    // cross terms are the difference between a fit of (0.124, 0.175) and nothing.
    let weight = crate::image::LUMA.map(f64::from);
    let variance = [
        sigmas[0] * sigmas[0],
        sigmas[1] * sigmas[1],
        sigmas[2] * sigmas[2],
    ];
    let sigma = crate::image::noise_covariance(variance, matrix);
    let luma_variance: f64 = (0..3)
        .flat_map(|a| (0..3).map(move |b| (a, b)))
        .map(|(a, b)| weight[a] * weight[b] * sigma[a][b])
        .sum();
    let bias = |channel: usize| crate::image::NOISE_RESPONSE_PER_VARIANCE[channel] * luma_variance;

    // **The split that tells this defect from a lateral one.** A channel displaced by `d` expands
    // as `G + d.grad G + (d^2/2).lap G`, and that second term is the very basis this fit regresses
    // on - so a lateral aberration answers it too, positively for both channels whichever way each
    // is displaced, which is exactly what the sign veto cannot catch. What separates them is the
    // radius: `d` grows with `r` for a magnification difference, so its apparent coefficient grows
    // with `r^2`, where a focus difference is flat across the field.
    //
    // So the coefficient is fitted per radial bin and then split into a constant and an `r^2` term,
    // and only the constant is kept - the same move `tca::measure` makes in reverse: fit the part
    // you cannot explain so it has somewhere to go, then discard it. Field curvature means a real
    // focus difference is not perfectly flat either, so this gives up a little of it, in the
    // conservative direction.
    let mut samples: Vec<(f64, f64, f64, f64)> = Vec::new();
    for bin in 0..bins {
        if counted[bin] < crate::image::DEFOCUS_MIN_PER_BIN as f64 {
            continue;
        }
        let energy =
            square[bin] - counted[bin] * crate::image::NOISE_CURVATURE_PER_VARIANCE * luma_variance;
        // A bin whose curvature is all noise leaves nothing behind to divide by.
        if energy <= 0.0 {
            continue;
        }
        let red = (cross_red[bin] - counted[bin] * bias(0)) / energy;
        let blue = (cross_blue[bin] - counted[bin] * bias(2)) / energy;
        samples.push(((bin as f64 + 0.5) / bins as f64, red, blue, energy));
    }
    // Every refusal below returns the same `None`, so from outside they are one answer.
    let trace = std::env::var_os("BOWERBIRD_DEFOCUS_TRACE").is_some();
    if trace {
        for (at, red, blue, energy) in &samples {
            eprintln!("defocus: bin at {at:.2} red {red:+.4} blue {blue:+.4} energy {energy:.1}");
        }
    }
    if samples.len() < crate::image::DEFOCUS_MIN_BINS {
        if trace {
            eprintln!(
                "defocus: declined, {} bins resolved of {bins}",
                samples.len()
            );
        }
        return None;
    }
    // Weighted by each bin's own curvature energy, which is how much it actually knows.
    let constant_term = |pick: &dyn Fn(&(f64, f64, f64, f64)) -> f64| -> f64 {
        let total: f64 = samples.iter().map(|s| s.3).sum();
        let mean_at = samples.iter().map(|s| s.3 * s.0).sum::<f64>() / total;
        let mean_k = samples.iter().map(|s| s.3 * pick(s)).sum::<f64>() / total;
        let covariance: f64 = samples
            .iter()
            .map(|s| s.3 * (s.0 - mean_at) * (pick(s) - mean_k))
            .sum();
        let spread: f64 = samples.iter().map(|s| s.3 * (s.0 - mean_at).powi(2)).sum();
        let slope = match spread > 0.0 {
            true => covariance / spread,
            false => 0.0,
        };
        mean_k - slope * mean_at
    };
    let red = constant_term(&|s| s.1) as f32;
    let blue = constant_term(&|s| s.2) as f32;
    if red.abs() > crate::image::DEFOCUS_MAX || blue.abs() > crate::image::DEFOCUS_MAX {
        if trace {
            eprintln!("defocus: declined, outside DEFOCUS_MAX");
        }
        return None;
    }
    // **Opposite signs mean the scene's colour, not the lens - but only when both are real.** Green
    // is the channel autofocus works on, so red and blue are both softer than it and both
    // coefficients land on the same side of zero. A frame dominated by one coloured object drives
    // them apart instead, because a red object raises `R - luma` and lowers `B - luma` at the very
    // same curvature.
    //
    // The band is what makes that test usable. Vetoing on the bare product rejected IMG_8408 - a
    // frame carrying 98.48 of fringe - because blue measured +0.148 and red measured -0.0105, a
    // fourteenth of it and indistinguishable from zero. One channel having nothing to say must not
    // silence the other, which is the same lesson `tca::measure` learned about discarding a good
    // channel.
    let band = crate::image::DEFOCUS_NOISE;
    if red.abs() > band && blue.abs() > band && red * blue < 0.0 {
        if trace {
            eprintln!("defocus: declined, the channels disagree in sign");
        }
        return None;
    }
    // A channel measured *sharper* than green is not something this can fix: subtracting a negative
    // coefficient would sharpen its chroma, inventing an edge rather than removing one. Taken as
    // nothing to do, per channel.
    let (red, blue) = (red.max(0.0), blue.max(0.0));
    // Below the noise band there is nothing worth resampling for, and it is also where the residue
    // of a lateral aberration lands once the `r^2` term has been taken out: 0.008 on the fixture
    // that fitted 0.054 before the split, against 0.09 for a real focus difference.
    match red > band || blue > band {
        true => {
            if trace {
                eprintln!("defocus: red {red:.4} blue {blue:.4}");
            }
            Some((red, blue))
        }
        false => {
            if trace {
                eprintln!("defocus: declined, both channels under the noise band");
            }
            None
        }
    }
}

/// Submits the work once and brings every result back, since no kernel here reads what another
/// writes.
async fn read_all<const N: usize>(
    recording: &mut crate::gpu::Recording<'_>,
    sources: [(&crate::gpu::Buffer, usize); N],
) -> Option<[Vec<u8>; N]> {
    let gpu = recording.gpu();
    let staged = sources.map(|(source, bytes)| {
        let readback = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("base readback"),
            size: bytes as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        recording
            .encoder()
            .copy_buffer_to_buffer(source, 0, &readback, 0, bytes as u64);
        readback
    });
    recording.submit();

    let mut read = Vec::with_capacity(N);
    for readback in &staged {
        read.push(crate::gpu::read_back(gpu, readback, <[u8]>::to_vec).await);
    }
    read.into_iter()
        .collect::<Option<Vec<_>>>()?
        .try_into()
        .ok()
}

#[cfg(test)]
mod tests {
    use crate::light::{Light, SceneNits};
    use crate::resident::Resident;

    /// The reference every test here codes against, which is BT.2408's.
    const REFERENCE: Light<SceneNits> = Light::exactly(203.0);

    /// [`super::sharpen_base`], or the frame untouched where there is no device to run it.
    fn gpu_sharpened(samples: &[u16], width: usize, height: usize, sigma: f32) -> Option<Vec<u16>> {
        gpu_sharpened_at(samples, width, height, sigma, 1.0)
    }

    fn gpu_sharpened_at(
        samples: &[u16],
        width: usize,
        height: usize,
        sigma: f32,
        amount: f64,
    ) -> Option<Vec<u16>> {
        let gpu = crate::gpu::device()?;
        let base = super::device(gpu)?;
        let mut frame = samples.to_vec();
        pollster::block_on(super::sharpen_base(
            gpu, base, &mut frame, width, height, amount, sigma,
        ))?;
        Some(frame)
    }

    fn gpu_sharpened_with_noise(
        samples: &[u16],
        width: usize,
        height: usize,
        sigma: f32,
        amount: f64,
        noise: crate::image::SharpenNoise,
    ) -> Option<Vec<u16>> {
        let gpu = crate::gpu::device()?;
        let base = super::device(gpu)?;
        let frame = crate::resident::Resident::upload(gpu, samples, width, height);
        let mut recording = gpu.record();
        recording.holding(frame.buffer());
        super::sharpen_into(
            gpu,
            base,
            &mut recording,
            frame.buffer(),
            width,
            height,
            amount,
            crate::image::SharpenSigma::fixed(sigma),
            noise,
            None,
        );
        recording.submit();
        drop(recording);
        pollster::block_on(frame.into_host())
    }

    /// Separable convolution by `taps` (centre outwards, as [`crate::image::gaussian`] builds
    /// them), edges clamped as `sharpen.slang`'s stencils clamp theirs.
    fn blur(plane: &[f32], width: usize, height: usize, taps: &[f32]) -> Vec<f32> {
        let along = |at: &dyn Fn(usize) -> f32, x: usize, len: usize| -> f32 {
            taps.iter()
                .enumerate()
                .skip(1)
                .fold(taps[0] * at(x), |acc, (d, tap)| {
                    acc + tap * (at(x.saturating_sub(d)) + at((x + d).min(len - 1)))
                })
        };
        let mut across = vec![0.0f32; width * height];
        for y in 0..height {
            for x in 0..width {
                across[y * width + x] = along(&|x: usize| plane[y * width + x], x, width);
            }
        }
        let mut down = vec![0.0f32; width * height];
        for y in 0..height {
            for x in 0..width {
                down[y * width + x] = along(&|y: usize| across[y * width + x], y, height);
            }
        }
        down
    }

    /// A grey step edge blurred by the point spread the sharpen deconvolves, which is what a
    /// real edge looks like after a resample. `low`/`high` are `u16` levels.
    fn blurred_edge(width: usize, height: usize, low: f32, high: f32) -> Vec<u16> {
        let plane: Vec<f32> = (0..width * height)
            .map(|i| if i % width < width / 2 { low } else { high })
            .collect();
        let taps = crate::image::gaussian(
            crate::image::DECONVOLVE_SIGMA,
            crate::image::DECONVOLVE_RADIUS,
        );
        let blurred = blur(&plane, width, height, &taps);
        let mut frame = vec![0u16; width * height * 3];
        for (i, value) in blurred.iter().enumerate() {
            for c in 0..3 {
                frame[i * 3 + c] = value.round().clamp(0.0, 65535.0) as u16;
            }
        }
        frame
    }

    /// The estimator against a blur it was given, which is the only thing that says it measures one.
    ///
    /// **The two host halves are pinned and the shader is not**, which leaves every rule about
    /// which rises vote - the run length, the settled level behind the foot, the contrast floor -
    /// checked by nothing. Those rules decide *which* edges reach the histogram, and the answer is
    /// the sharpest decile of whatever does, so a rule that admits a truncated slice of a rise
    /// biases the whole estimate towards sharp and no host test can see it.
    ///
    /// **The reference is the profile's own tenths, not the sigma it was built from.** A five-tap
    /// sampled Gaussian truncated at radius two is wider than the ideal it is named for: at a
    /// nominal 0.7 its step response spans 2.12 samples between the tenths, which
    /// `EDGE_SPREAD_PER_SIGMA` calls 0.83. Asserting against 0.7 would fail a correct estimator and
    /// pass a biased one, so the expected value comes off the same convolution the frame was made
    /// with.
    #[test]
    fn the_edge_spread_recovers_a_blur_it_was_given() {
        // One edge per row and `EDGE_SPREAD_VOTES` rows needed before the decile means anything, so
        // the frame is tall rather than wide.
        let (w, h) = (64usize, 1024usize);
        let (low, high) = (40.0f32 * 257.0, 200.0f32 * 257.0);
        let frame = blurred_edge(w, h, low, high);

        // The same step through the same taps, and the crossings the shader goes looking for.
        let taps = crate::image::gaussian(
            crate::image::DECONVOLVE_SIGMA,
            crate::image::DECONVOLVE_RADIUS,
        );
        let plane: Vec<f32> = (0..w).map(|x| f32::from(x >= w / 2)).collect();
        let profile = blur(&plane, w, 1, &taps);
        let crossing = |want: f32| -> f32 {
            let at = (1..w)
                .find(|&x| profile[x] >= want)
                .expect("the profile crosses");
            at as f32 - 1.0 + (want - profile[at - 1]) / (profile[at] - profile[at - 1])
        };
        let want = (crossing(0.9) - crossing(0.1)) / crate::image::EDGE_SPREAD_PER_SIGMA;

        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };
        let resident = crate::resident::Resident::upload(gpu, &frame, w, h);
        let measured = pollster::block_on(super::measure_edge_spread(
            gpu,
            base,
            resident.buffer(),
            w,
            h,
        ))
        .expect("the frame has an edge to measure");

        assert!(
            (measured - want).abs() < 0.05,
            "a profile whose own tenths span {want} sigma measured {measured}, so the vote is not \
             the blur the frame carries"
        );
    }

    #[test]
    fn the_sharpen_steepens_a_blurred_edge_towards_the_step_it_came_from() {
        // The property an unsharp mask cannot claim: this is measured against the *step*
        // the blur was applied to, so "sharper" means closer to the original rather than
        // merely higher contrast across the transition. At the default, which is the estimate
        // itself; the top of the track extrapolates past it on purpose.
        let (w, h) = (64usize, 8usize);
        let (low, high) = (60.0f32 * 257.0, 180.0f32 * 257.0);
        let before = blurred_edge(w, h, low, high);
        let Some(frame) =
            gpu_sharpened_at(&before, w, h, crate::image::DECONVOLVE_SIGMA, 0.5)
        else {
            return;
        };

        let at = |data: &[u16], x: usize| f32::from(data[(4 * w + x) * 3]);
        let ideal = |x: usize| if x < w / 2 { low } else { high };
        // Across the transition as a whole: the unregularised estimate rings a column or two out,
        // so single columns there may move away while the edge as a whole closes on the step.
        let error = |data: &[u16]| (28..36).map(|x| (at(data, x) - ideal(x)).abs()).sum::<f32>();
        let (was, now) = (error(&before), error(&frame));
        assert!(
            now * 100.0 < was * 52.0,
            "the transition sat {was} from the step and now sits {now}"
        );
        assert!(
            at(&frame, 31) < at(&before, 31),
            "the dark side of the edge"
        );
        assert!(
            at(&frame, 32) > at(&before, 32),
            "the light side of the edge"
        );
    }

    #[test]
    fn the_sharpen_recovers_diagonal_edges_and_point_detail() {
        let (w, h) = (64usize, 64usize);
        let (low, high) = (60.0f32 * 257.0, 180.0f32 * 257.0);
        let taps = crate::image::gaussian(
            crate::image::DECONVOLVE_SIGMA,
            crate::image::DECONVOLVE_RADIUS,
        );
        let frame_of = |plane: &[f32]| {
            let mut frame = vec![0u16; w * h * 3];
            for (pixel, value) in plane.iter().enumerate() {
                for channel in 0..3 {
                    frame[pixel * 3 + channel] = value.round().clamp(0.0, 65535.0) as u16;
                }
            }
            frame
        };

        let diagonal: Vec<f32> = (0..w * h)
            .map(|pixel| if pixel % w + pixel / w < w { low } else { high })
            .collect();
        let diagonal_before = frame_of(&blur(&diagonal, w, h, &taps));
        let measured_noise = crate::image::SharpenNoise {
            sensitivity: [
                [crate::image::LUMA[0], 0.0, 0.0],
                [0.0, crate::image::LUMA[1], 0.0],
                [0.0, 0.0, crate::image::LUMA[2]],
            ],
            read_variance: [1e-8; 3],
            ..crate::image::SharpenNoise::NONE
        };
        let Some(diagonal_after) = gpu_sharpened_with_noise(
            &diagonal_before,
            w,
            h,
            crate::image::DECONVOLVE_SIGMA,
            0.5,
            measured_noise,
        ) else {
            return;
        };
        let diagonal_error = |frame: &[u16]| {
            (8..h - 8)
                .flat_map(|y| (8..w - 8).map(move |x| (x, y)))
                .map(|(x, y)| (f32::from(frame[(y * w + x) * 3]) - diagonal[y * w + x]).abs())
                .sum::<f32>()
        };
        let (was, now) = (diagonal_error(&diagonal_before), diagonal_error(&diagonal_after));
        assert!(
            now * 100.0 < was * 87.0,
            "the diagonal sat {was} from the step and now sits {now}"
        );

        let mut point = vec![low; w * h];
        point[(h / 2) * w + w / 2] = high;
        let point_before = frame_of(&blur(&point, w, h, &taps));
        let Some(point_after) = gpu_sharpened_with_noise(
            &point_before,
            w,
            h,
            crate::image::DECONVOLVE_SIGMA,
            0.5,
            measured_noise,
        ) else {
            return;
        };
        let at = (h / 2 * w + w / 2) * 3;
        let before_error = high - f32::from(point_before[at]);
        let after_error = high - f32::from(point_after[at]);
        assert!(
            after_error * 10.0 < before_error * 7.0,
            "the point sat {before_error} under its peak and now sits {after_error} under it"
        );
    }

    #[test]
    fn coloured_shadow_noise_is_measured_in_each_pq_channel() {
        let (w, h) = (64usize, 32usize);
        let light = [0.01f64, 0.001, 0.000_001];
        let sigma = 0.000_001;
        let code = |value: f64| {
            (crate::tone::pq(crate::light::Light::<crate::light::SceneNits>::measured(
                value.max(0.0) * 10_000.0,
            ))
            .raw()
                * f64::from(u16::MAX))
            .round() as u16
        };
        let frame: Vec<u16> = (0..w * h)
            .flat_map(|pixel| {
                let direction = if pixel % 2 == 0 { -1.0 } else { 1.0 };
                light.map(|value| code(value + direction * sigma))
            })
            .collect();
        let measured_noise = crate::image::SharpenNoise {
            sensitivity: [
                [crate::image::LUMA[0], 0.0, 0.0],
                [0.0, crate::image::LUMA[1], 0.0],
                [0.0, 0.0, crate::image::LUMA[2]],
            ],
            read_variance: [1e-12; 3],
            ..crate::image::SharpenNoise::NONE
        };
        let Some(sharpened) = gpu_sharpened_with_noise(
            &frame,
            w,
            h,
            crate::image::DECONVOLVE_SIGMA,
            0.5,
            measured_noise,
        ) else {
            return;
        };
        let roughness = |samples: &[u16]| {
            let luma = |pixel: usize| {
                (0..3)
                    .map(|channel| {
                        crate::image::LUMA[channel]
                            * f32::from(samples[pixel * 3 + channel])
                    })
                    .sum::<f32>()
            };
            (0..h)
                .flat_map(|y| (0..w - 2).map(move |x| y * w + x))
                .map(|pixel| (luma(pixel) - 2.0 * luma(pixel + 1) + luma(pixel + 2)).abs())
                .sum::<f32>()
        };
        let (before, after) = (roughness(&frame), roughness(&sharpened));
        assert!(
            after <= before * 1.01,
            "sharpening raised coloured shadow roughness from {before} to {after}"
        );
    }

    #[test]
    fn signed_camera_lobes_cancel_before_noise_support() {
        let (w, h) = (64usize, 32usize);
        let (low, high) = (20_000.0f32, 21_000.0f32);
        let ideal: Vec<f32> = (0..w * h)
            .map(|pixel| if pixel % w < w / 2 { low } else { high })
            .collect();
        let taps = crate::image::gaussian(
            crate::image::DECONVOLVE_SIGMA,
            crate::image::DECONVOLVE_RADIUS,
        );
        let blurred = blur(&ideal, w, h, &taps);
        let frame: Vec<u16> = blurred
            .iter()
            .flat_map(|value| [value.round() as u16; 3])
            .collect();
        let noise = crate::image::SharpenNoise {
            sensitivity: [[1.0, -0.9, 0.0], [0.0; 3], [0.0; 3]],
            read_variance: [1e-8, 0.0, 0.0],
            ..crate::image::SharpenNoise::NONE
        };
        let Some(sharpened) = gpu_sharpened_with_noise(
            &frame,
            w,
            h,
            crate::image::DECONVOLVE_SIGMA,
            0.5,
            noise,
        ) else {
            return;
        };
        let error = |samples: &[u16]| {
            (8..h - 8)
                .flat_map(|y| (w / 2 - 4..w / 2 + 4).map(move |x| y * w + x))
                .map(|pixel| (f32::from(samples[pixel * 3]) - ideal[pixel]).abs())
                .sum::<f32>()
        };
        let (before, after) = (error(&frame), error(&sharpened));
        assert!(
            after < before * 0.9,
            "the signed matrix edge sat {before} from its step and now sits {after}"
        );
    }

    #[test]
    fn the_sharpen_overshoots_the_edge_no_further_than_its_knee() {
        // RL rings against a step, and at the top of the track the blend extrapolates past it;
        // `limited` is what keeps that from becoming a halo.
        let (w, h) = (64usize, 8usize);
        let (low, high) = (60.0f32 * 257.0, 180.0f32 * 257.0);
        let Some(frame) = gpu_sharpened(
            &blurred_edge(w, h, low, high),
            w,
            h,
            crate::image::DECONVOLVE_SIGMA,
        ) else {
            return;
        };
        let past = (24..40)
            .map(|x| f32::from(frame[(4 * w + x) * 3]))
            .map(|value| (value - high).max(low - value).max(0.0))
            .fold(0.0f32, f32::max);
        // Measured at 12% of the step at the top of the track.
        assert!(
            past < 0.15 * (high - low),
            "the edge overshot by {past} of a {} step",
            high - low
        );
    }

    /// A flat frame leaks nothing; a green checkerboard on a red leaks in every block, since each
    /// pixel's green departs the block mean by half the checker and the decode would hand two
    /// thirds of that to red.
    #[test]
    fn the_leak_counts_the_blocks_a_decode_would_get_wrong() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let base = super::device(gpu).expect("the pipelines");
        let (w, h) = (128usize, 96usize);
        let flat: Vec<u16> = (0..w * h).flat_map(|_| [40000u16, 6000, 6000]).collect();
        let leak = pollster::block_on(super::chroma_leak_of(gpu, base, &flat, w, h));
        assert_eq!(leak, Some(0.0), "a flat frame leaks");

        let checker: Vec<u16> = (0..w * h)
            .flat_map(|at| {
                let (x, y) = (at % w, at / w);
                let green = match (x + y) % 2 == 0 {
                    true => 6000u16,
                    false => 26000,
                };
                [40000u16, green, 6000]
            })
            .collect();
        let leak = pollster::block_on(super::chroma_leak_of(gpu, base, &checker, w, h));
        assert_eq!(leak, Some(1.0), "every block of a checker leaks");

        // A leak confined to one tile is the whole answer, not a frame fraction of it.
        let mut corner = flat.clone();
        for y in 0..64 {
            for x in 0..64 {
                if (x + y) % 2 == 1 {
                    corner[(y * w + x) * 3 + 1] = 26000;
                }
            }
        }
        let leak = pollster::block_on(super::chroma_leak_of(gpu, base, &corner, w, h));
        assert_eq!(leak, Some(1.0), "one wholly leaking tile reads as one");
    }

    #[test]
    fn a_uniform_frame_survives_the_sharpen() {
        // Where a division by the estimate's own blur would land on a flat frame, and the
        // symptom is not subtle: NaN clamped back to black across the picture.
        let (w, h) = (24usize, 24usize);
        let frame = vec![33410u16; w * h * 3];
        let Some(sharpened) = gpu_sharpened(&frame, w, h, crate::image::DECONVOLVE_SIGMA) else {
            return;
        };
        assert_eq!(sharpened, frame, "a uniform frame came back changed");
    }

    #[test]
    fn the_sharpen_reads_no_further_than_the_halo_it_declares() {
        // The margin every window and band is grown by (`Strengths::halo`), measured as the
        // dependency itself: a pixel one row past it must not move the frame's top row, and
        // one well inside it must - so the probe is known to see anything at all.
        let (w, h) = (96usize, 128usize);
        let strengths = crate::image::Strengths {
            sharpen: 1.0,
            defringe: 0.0,
        };
        let halo = strengths.halo();
        let source = blurred_edge(w, h, 9000.0, 41000.0);
        let Some(baseline) = gpu_sharpened(&source, w, h, crate::image::DECONVOLVE_SIGMA) else {
            return;
        };
        let probe = |row: usize, rgb: [u16; 3]| {
            let mut probed = source.clone();
            let i = (row * w + w / 4) * 3;
            probed[i..i + 3].copy_from_slice(&rgb);
            let sharpened = gpu_sharpened(&probed, w, h, crate::image::DECONVOLVE_SIGMA)
                .expect("the device answered the baseline");
            sharpened[..w * 3] != baseline[..w * 3]
        };
        let white = [65535, 65535, 65535];
        assert!(
            !probe(halo + 1, white),
            "a change {} rows down reached the top",
            halo + 1
        );
        assert!(probe(2, white), "the probe detects nothing two rows down");
    }

    /// A lens that genuinely bends: a strong pincushion correction, so the Jacobian is well
    /// away from one at the corners - and the corners read *inward*, where there is picture,
    /// rather than off the edge into black a sharpen cannot move.
    fn bending() -> crate::fit::Lens {
        let unit = crate::image::SPLINE_UNIT;
        crate::fit::Lens {
            distortion: Some(vec![
                0.0,
                -0.01 * unit,
                -0.03 * unit,
                -0.06 * unit,
                -0.1 * unit,
            ]),
            crop: 1.0,
            falloff: None,
            tca: None,
        }
    }

    /// The warp's Jacobian against the same ratio tables walked on the host.
    ///
    /// The reference mirrors `source_of` deliberately: what is pinned is that the shader's
    /// derivative is the derivative of the mapping it actually gathers with, so a table
    /// re-index or a folded centre on either side fails here rather than as a corner
    /// sharpened at the wrong width.
    #[test]
    fn the_warp_hands_the_sharpen_the_derivative_of_its_own_mapping() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };

        let (w, h) = (192usize, 128usize);
        let lens = bending();
        let frame = Resident::upload(gpu, &vec![13000u16; w * h * 3], w, h);
        let gather = super::Gather::frame(crate::px::Size::exact(w, h));
        let Some((warped, jacobian)) = super::warp_lens(gpu, base, &frame, gather, &lens) else {
            panic!("a bending lens warps");
        };
        frame.reclaim();

        let mut recording = gpu.record();
        let out = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("jacobian out"),
            size: (w * h * 4) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        recording
            .encoder()
            .copy_buffer_to_buffer(&jacobian, 0, &out, 0, (w * h * 4) as u64);
        recording.submit();
        let words = pollster::block_on(crate::gpu::read_back(gpu, &out, <[u8]>::to_vec))
            .expect("the jacobian maps");
        warped.reclaim();

        let tables = super::ratio_tables(&lens);
        let last = tables.len() / 3 - 1;
        let half2 = (w as f64 / 2.0).powi(2) + (h as f64 / 2.0).powi(2);
        let source_x = |ox: f64, oy: f64| {
            let r2 = (ox * ox + oy * oy) / half2;
            let t = (r2 * last as f64).min(last as f64 - 1e-9);
            let slot = (t as usize).min(last - 1);
            let low = f64::from(tables[last + 1 + slot]);
            let ratio = low + (f64::from(tables[last + 1 + slot + 1]) - low) * (t - slot as f64);
            w as f64 / 2.0 - 0.5 + ox * ratio
        };
        for (x, y) in [(w / 2, h / 2), (4, 4), (w - 5, h / 2)] {
            let ox = x as f64 + 0.5 - w as f64 / 2.0;
            let oy = y as f64 + 0.5 - h as f64 / 2.0;
            let expected = 1.0 / (source_x(ox + 1.0, oy) - source_x(ox, oy)).abs();
            let word = u32::from_le_bytes(
                words[(y * w + x) * 4..(y * w + x) * 4 + 4]
                    .try_into()
                    .expect("a word"),
            );
            let jx = f64::from(f32::from(half::f16::from_bits(word as u16)));
            assert!(
                (jx - expected.clamp(0.25, 4.0)).abs() < expected * 0.02 + 0.01,
                "({x},{y}): the shader says {jx}, the tables say {expected}",
            );
        }
    }

    /// The sigma actually varies under the Jacobian: a bent frame sharpened with the terms
    /// differs from one sharpened at the flat composition in the stretched corners, and
    /// nowhere near the centre, where the derivative is one.
    #[test]
    fn a_stretched_corner_is_sharpened_at_its_own_width() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };

        let (w, h) = (256usize, 192usize);
        // Fine vertical bars, blurred: something everywhere for the deconvolution to move.
        let plane: Vec<f32> = (0..w * h)
            .map(|i| {
                if (i % w / 3) % 2 == 0 {
                    9000.0
                } else {
                    34000.0
                }
            })
            .collect();
        let taps = crate::image::gaussian(0.7, crate::image::DECONVOLVE_RADIUS);
        let soft = blur(&plane, w, h, &taps);
        let mut samples = vec![0u16; w * h * 3];
        for (i, value) in soft.iter().enumerate() {
            for c in 0..3 {
                samples[i * 3 + c] = *value as u16;
            }
        }

        let sigma = crate::image::SharpenSigma {
            composed: 0.6,
            terms: Some((0.6, 0.0)),
        };
        let levels = crate::tone::Levels {
            white: Light::measured(30000.0),
            peak: Light::measured(60000.0),
            floor: None,
        }
        .anchored();
        let run = |sigma: crate::image::SharpenSigma| {
            let frame = Resident::upload(gpu, &samples, w, h);
            let (prepared, _) = pollster::block_on(super::prepare(
                gpu,
                base,
                frame,
                super::Gather::frame(crate::px::Size::exact(w, h)),
                levels,
                REFERENCE,
                crate::image::Strengths {
                    sharpen: 1.0,
                    defringe: 0.0,
                },
                sigma,
                crate::image::SharpenNoise::NONE,
                &bending(),
                super::Defringe::Done((0.0, 0.0)),
                None,
                None,
            ))
            .expect("the chain runs");
            pollster::block_on(prepared.into_host()).expect("the prepared frame maps")
        };
        let flat = run(crate::image::SharpenSigma::fixed(sigma.composed));
        let bent = run(sigma);

        let differs = |x0: usize, y0: usize| {
            let mut worst = 0u16;
            for y in y0..y0 + 16 {
                for x in x0..x0 + 16 {
                    for c in 0..3 {
                        let i = (y * w + x) * 3 + c;
                        worst = worst.max(flat[i].abs_diff(bent[i]));
                    }
                }
            }
            worst
        };
        // Relative rather than absolute at the centre: its derivative is one only to the f16
        // the Jacobian travels as, and the shader's own `exp` differs from the host's in the
        // last ulps - the iteration turns both into a handful of counts. The damping widens that
        // again, being a nonlinear weight on the correction: the same last-ulp difference in `c`
        // maps to a larger one in what multiplies the estimate. What must hold is the *shape*:
        // the corner, where the derivative is real, moves far more than that.
        let (corner, centre) = (differs(4, 4), differs(w / 2 - 8, h / 2 - 8));
        assert!(
            corner > centre * 4 + 32,
            "the corner never saw its own sigma: corner {corner} against centre {centre}",
        );
        assert!(
            centre <= 36,
            "the centre moved under a derivative of one: worst {centre}"
        );
    }

    /// The stencil half-width the shader declares, against the host constant the halo and the
    /// taps are built from. String-parsed as the galosh pins are: renumbering one side alone
    /// is a silently wrong margin, not a failure.
    #[test]
    fn the_shader_radius_is_the_hosts() {
        const SLANG: &str = include_str!("../../../slang/sharpen.slang");
        // In taps, whose unit the declaration names: what spans a picture is the sigma, and
        // `deconvolve_split` is what clamps that to what this many are honest for.
        let opener = "static const Span<Tap> RADIUS = { ";
        let start = SLANG.find(opener).expect("RADIUS is declared");
        let rest = &SLANG[start + opener.len()..];
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        assert_eq!(
            digits.parse::<usize>().expect("a number"),
            crate::image::DECONVOLVE_RADIUS,
            "sharpen.slang and image.rs disagree on the point spread's half-width",
        );
    }

    #[test]
    fn the_sharpen_noise_layout_is_the_shaders() {
        let noise = crate::image::SharpenNoise {
            sensitivity: [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]],
            shot_per_light: [10.0, 11.0, 12.0],
            read_variance: [13.0, 14.0, 15.0],
            ..crate::image::SharpenNoise::NONE
        };
        let bytes = super::sharpen_noise_bytes(noise);
        let words: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|word| f32::from_le_bytes(word.try_into().expect("one word")))
            .collect();
        assert_eq!(words, (1..=15).map(|value| value as f32).collect::<Vec<_>>());

        const SLANG: &str = include_str!("../../../slang/sharpen.slang");
        let declared = |name: &str| -> usize {
            let opener = format!("static const uint {name} = ");
            let start = SLANG
                .find(&opener)
                .unwrap_or_else(|| panic!("{name} is declared"));
            SLANG[start + opener.len()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .unwrap_or_else(|_| panic!("{name} is a number"))
        };
        assert_eq!(declared("NOISE_SENSITIVITY"), super::SHARPEN_NOISE_SENSITIVITY);
        assert_eq!(declared("NOISE_SHOT"), super::SHARPEN_NOISE_SHOT);
        assert_eq!(declared("NOISE_READ"), super::SHARPEN_NOISE_READ);
        assert_eq!(declared("NOISE_WORDS"), super::SHARPEN_NOISE_WORDS);
    }

    /// The four `defocus.slang` bins and strides its readback is shaped by, against the host's.
    ///
    /// The kernel writes `24` sums per segment and three `NOISE_BINS` histograms; the host reads
    /// them back at sizes it computes from its own copies of the same numbers. Move one alone and
    /// the sums land in the wrong slots - a fit off a frame binned one way and read another, which
    /// is a plausible six numbers rather than an error.
    #[test]
    fn the_defocus_numbers_are_the_ones_the_shader_declares() {
        const SLANG: &str = include_str!("../../../slang/defocus.slang");
        let declared = |name: &str| -> usize {
            let opener = format!("static const uint {name} = ");
            let start = SLANG
                .find(&opener)
                .unwrap_or_else(|| panic!("{name} is declared"));
            let rest = &SLANG[start + opener.len()..];
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            digits
                .parse()
                .unwrap_or_else(|_| panic!("{name} is a number"))
        };
        assert_eq!(declared("BINS"), crate::image::DEFOCUS_BINS);
        assert_eq!(declared("STRIDE"), crate::image::DEFOCUS_STRIDE);
        assert_eq!(declared("NOISE_BINS"), crate::image::NOISE_BINS);
        assert_eq!(declared("PER_SEGMENT"), super::DEFOCUS_PER_SEGMENT);
    }

    /// [`super::resize`] from host samples and back, which is what a test has rather than a frame
    /// already on the device.
    fn resized(
        gpu: &'static crate::gpu::Gpu,
        base: &'static super::Base,
        samples: &[u16],
        source: (usize, usize),
        out: (usize, usize),
    ) -> Option<Vec<u16>> {
        let frame = Resident::upload(gpu, samples, source.0, source.1);
        let smaller = super::resize(gpu, base, &frame, out);
        frame.reclaim();
        pollster::block_on(smaller?.into_host())
    }

    /// The same for [`super::resize_scene`].
    fn resized_scene(
        gpu: &'static crate::gpu::Gpu,
        base: &'static super::Base,
        samples: &[u16],
        source: (usize, usize),
        out: (usize, usize),
    ) -> Option<Vec<u16>> {
        let frame = Resident::upload(gpu, samples, source.0, source.1);
        let smaller = super::resize_scene(gpu, base, &frame, out);
        frame.reclaim();
        pollster::block_on(smaller?.into_host())
    }

    /// The same, for [`super::warp_lens`].
    fn warped(
        gpu: &'static crate::gpu::Gpu,
        base: &'static super::Base,
        samples: &[u16],
        gather: super::Gather,
        lens: &crate::fit::Lens,
    ) -> Option<Vec<u16>> {
        let (sw, sh) = gather.source.raw();
        let frame = Resident::upload(gpu, samples, sw, sh);
        let gathered = super::warp_lens(gpu, base, &frame, gather, lens);
        frame.reclaim();
        pollster::block_on(gathered?.0.into_host())
    }

    /// The coding, against ST 2084 itself, over every level a sample can hold.
    ///
    /// **Held against `tone::pq` rather than against a second whole-frame pass**, that pass having
    /// been the CPU copy of this shader. What is left on this side is the scalar curve, which the
    /// host tabulates for the shader to read - so the reference here is the definition rather than
    /// a reimplementation of the stage, and the agreement is exact.
    ///
    /// Every level rather than a photograph's worth, since the levels a frame happens to contain
    /// say nothing about the ones it does not - and the odd tail, so the half-word a frame with an
    /// odd sample count leaves behind is exercised rather than assumed.
    #[test]
    fn the_coding_is_st_2084_exactly() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };

        // Odd, so the tail that shares its word with nothing is exercised rather than assumed.
        let levels: Vec<u16> = (0..=u16::MAX).chain(std::iter::once(0)).collect();
        let anchored = crate::tone::Levels {
            white: Light::measured(8133.0),
            peak: Light::measured(13783.0),
            floor: None,
        }
        .anchored();

        let scale = REFERENCE.raw() / anchored.white.raw();
        let theirs: Vec<u16> = levels
            .iter()
            .map(|level| {
                let nits = Light::<SceneNits>::measured(f64::from(*level) * scale);
                (crate::tone::pq(nits).raw() * f64::from(u16::MAX)).round() as u16
            })
            .collect();

        let mut mine = levels.clone();
        pollster::block_on(super::encode_base(
            gpu, base, &mut mine, anchored, REFERENCE,
        ))
        .expect("the coding runs");

        let worst = theirs
            .iter()
            .zip(&mine)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .expect("a frame with samples in it");
        // Exact, and that is the point of the table: the shader looks up what this expression
        // wrote, so the only way to disagree is to index it wrongly. Evaluating ST 2084 in the
        // shader instead put a fifth of a real frame one count out.
        assert_eq!(
            worst, 0,
            "the shader and the table disagree by {worst} counts"
        );
        // And it is a coding rather than a copy, which a bound alone would let through.
        assert_ne!(theirs, levels, "the table left the frame as it found it");
    }

    /// [`super::full_scale_light`] against the coding it is the inverse of: code a full-scale
    /// sample and read its light back off the table the device reads.
    ///
    /// A stage measuring a mosaic against a coded frame divides by this, so a factor lost here is a
    /// noise floor off by that factor (`assembly_levels`).
    #[test]
    fn a_full_scale_sample_codes_to_the_light_it_is_named_at() {
        let ceiling = crate::tone::pq_inv::<SceneNits>(Light::measured(1.0)).raw();
        // Every one of them anchors full scale below PQ's ceiling, which is where the curve is a
        // curve rather than a clamp: a white under ~1330 codes 65535 to more than 10000 nits.
        for white in [2000.0, 8133.0, 32767.0, 65535.0] {
            let anchored = crate::tone::Levels {
                white: Light::measured(white),
                peak: Light::measured(white),
                floor: None,
            }
            .anchored();
            let coded = super::coding_curve(anchored, REFERENCE);
            let last = coded.len() - 2;
            let code = u16::from_le_bytes([coded[last], coded[last + 1]]);
            let signal = Light::measured(f64::from(code) / f64::from(u16::MAX));
            let read = crate::tone::pq_inv::<SceneNits>(signal).raw() / ceiling;
            let mine = f64::from(super::full_scale_light(anchored, REFERENCE));
            assert!(
                (read - mine).abs() < 5e-4 * read,
                "a white of {white} codes full scale to {read}, named as {mine}",
            );
        }
    }

    /// A frame carrying a known focus difference, and the stage taking it off again.
    ///
    /// **Nothing else in the suite sees this stage run.** Both fixture RAWs measure `(0.0, 0.0)` -
    /// between the noise floor, the `DEFOCUS_MAX` cap and the sign veto, the correction declines on
    /// every real frame in the corpus - so no fixture can tell whether the stage works at all, and
    /// a defect in it reaches a photograph before it reaches a test.
    ///
    /// The defect is injected as optics produce it - each channel is the same pattern under a
    /// different Gaussian, in linear light - rather than as `G + k.laplacian(G)`, which is the
    /// model being fitted and would be handing the fit its own answer.
    ///
    /// Four things this fixture has to get right, each of which had it reading zero:
    ///
    /// - **Every level at every radius.** The fit splits its coefficient into a constant and an
    ///   `r^2` term and keeps the constant, which is what tells a focus difference from a lateral
    ///   one. Levels on a radial ramp are read as lateral and discarded whole.
    /// - **Sigmas the model admits.** A Gaussian of `sigma` is `1 + (sigma^2/2).lap` to first
    ///   order, so 0.5 and 0.8 are coefficients of 0.125 and 0.32 against a `DEFOCUS_MAX` of 0.5.
    ///   At 1.1 the blue coefficient is over the cap and the whole measurement vetoes.
    /// - **Sparse edges.** `channel_sigmas` calls a pixel's departure from its own 3x3 mean noise,
    ///   and a dense checkerboard is half edge - it read the pattern as noise and the debias
    ///   subtracted more curvature energy than the bins held.
    /// - **Noise at all.** The debias is derived for a noisy frame; on a clean one the sigma
    ///   estimate saturates at 0.02 and every bin falls out on `square <= 0`.
    #[test]
    fn the_defringe_takes_off_a_focus_difference_it_was_given() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };

        let (width, height) = (384usize, 384usize);
        let frame = focus_difference(width, height, 12000.0);
        let before = fringe(&frame, width, height);

        let pair = pollster::block_on(super::measure_defocus(
            gpu, base, &frame, width, height, None, None,
        ))
        .expect("a frame built to carry one");
        // Injected 0.125 and 0.32; the fit reads low because a Gaussian is only a Laplacian to
        // first order, and what matters is what comes off rather than the coefficient itself.
        assert!(pair.0 > 0.02 && pair.1 > pair.0, "the pair is {pair:?}");

        let mut corrected = frame.clone();
        pollster::block_on(super::defringe(
            gpu,
            base,
            &mut corrected,
            width,
            height,
            pair,
        ))
        .expect("the correction runs");
        let after = fringe(&corrected, width, height);

        // Measured at 96% and 97% of the red and blue fringe removed. The bar is well under that,
        // since what it has to catch is the stage not running rather than the last few per cent.
        eprintln!("fringe {before:?} to {after:?}");
        assert!(
            after.0 < before.0 * 0.4 && after.1 < before.1 * 0.4,
            "the fringe went {before:?} to {after:?}",
        );
    }

    /// How far red and blue sit from luma where luma is moving fastest, which is what a fringe is.
    ///
    /// Away from black, because dividing by the local luma is what lets a pixel at two counts
    /// report a ratio of one.
    fn fringe(frame: &[u16], width: usize, height: usize) -> (f64, f64) {
        let luma_at = |x: usize, y: usize| -> f64 {
            let at = (y * width + x) * 3;
            0.2126 * f64::from(frame[at])
                + 0.7152 * f64::from(frame[at + 1])
                + 0.0722 * f64::from(frame[at + 2])
        };
        let mut edges: Vec<(f64, usize, usize)> = Vec::new();
        for y in 1..height - 1 {
            for x in 1..width - 1 {
                let dx = luma_at(x + 1, y) - luma_at(x - 1, y);
                let dy = luma_at(x, y + 1) - luma_at(x, y - 1);
                edges.push(((dx * dx + dy * dy).sqrt(), x, y));
            }
        }
        edges.sort_by(|a, b| b.0.total_cmp(&a.0));
        let (mut red, mut blue, mut counted) = (0.0f64, 0.0f64, 0usize);
        for (_, x, y) in &edges[..(edges.len() / 100).max(1)] {
            let at = (y * width + x) * 3;
            let luma = luma_at(*x, *y);
            if luma < 64.0 {
                continue;
            }
            red += (f64::from(frame[at]) - luma).abs() / luma;
            blue += (f64::from(frame[at + 2]) - luma).abs() / luma;
            counted += 1;
        }
        let counted = counted.max(1) as f64;
        (red / counted, blue / counted)
    }

    /// The fixture itself: a checkerboard stepping through six decades, each channel under its own
    /// blur, then sensor noise.
    fn focus_difference(width: usize, height: usize, white: f64) -> Vec<u16> {
        let side = width / 6;
        let mut green = vec![0.0f64; width * height];
        for y in 0..height {
            for x in 0..width {
                let level = white * 10f64.powi(-((((x / side) + (y / side)) % 6).min(5) as i32));
                green[y * width + x] = level
                    * if ((x / 48) + (y / 48)) % 2 == 0 {
                        1.0
                    } else {
                        0.25
                    };
            }
        }
        // Green is the channel autofocus works on, so it is the sharp one and both coefficients
        // come out positive - which is also what clears the sign veto.
        let red = gaussian_blur(&green, width, height, 0.5);
        let blue = gaussian_blur(&green, width, height, 0.8);

        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut noise = move || -> f64 {
            for _ in 0..1 {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
            }
            ((seed >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
        };
        let amplitude = white * 0.004;
        let mut out = vec![0u16; width * height * 3];
        for at in 0..width * height {
            for (channel, plane) in [&red, &green, &blue].iter().enumerate() {
                let value = plane[at] + noise() * amplitude;
                out[at * 3 + channel] = value.round().clamp(0.0, f64::from(u16::MAX)) as u16;
            }
        }
        out
    }

    fn gaussian_blur(plane: &[f64], width: usize, height: usize, sigma: f64) -> Vec<f64> {
        let radius = (sigma * 3.0).ceil() as isize;
        let taps: Vec<f64> = (-radius..=radius)
            .map(|t| (-(t as f64 * t as f64) / (2.0 * sigma * sigma)).exp())
            .collect();
        let total: f64 = taps.iter().sum();
        let taps: Vec<f64> = taps.iter().map(|t| t / total).collect();
        let at = |v: &[f64], x: isize, y: isize| -> f64 {
            v[(y.clamp(0, height as isize - 1) as usize) * width
                + x.clamp(0, width as isize - 1) as usize]
        };
        let mut across = vec![0.0; width * height];
        for y in 0..height as isize {
            for x in 0..width as isize {
                across[y as usize * width + x as usize] = (-radius..=radius)
                    .map(|t| taps[(t + radius) as usize] * at(plane, x + t, y))
                    .sum();
            }
        }
        let mut down = vec![0.0; width * height];
        for y in 0..height as isize {
            for x in 0..width as isize {
                down[y as usize * width + x as usize] = (-radius..=radius)
                    .map(|t| taps[(t + radius) as usize] * at(&across, x, y + t))
                    .sum();
            }
        }
        down
    }

    /// Every dispatch a real sensor asks for is one a driver will accept.
    ///
    /// **Nothing else here can see this.** The parity tests run on frames a few hundred pixels a
    /// side, where a dispatch is hundreds of groups in one dimension and the ceiling is four
    /// orders of magnitude away; the warp reached a render before anyone noticed, and the driver
    /// refused the whole command buffer with "must be less or equal to 65535". So the sizes are
    /// asserted against the limit directly rather than against a frame that happens to be small.
    #[test]
    fn a_sensor_sized_dispatch_is_one_a_driver_will_take() {
        // 61MP, and a frame far past any sensor, which nothing bounds now that the open takes
        // whatever the tab hands it.
        for pixels in [24_240_576usize, 60_217_344, 100_000 * 100_000 / 8] {
            for count in [pixels, pixels * 3, pixels.div_ceil(2)] {
                let (x, y) = super::groups(count);
                assert!(x <= 65535 && y <= 65535, "{count} dispatches {x}x{y}");
                let covered = u64::from(x) * u64::from(y) * u64::from(super::LANES);
                assert!(covered >= count as u64, "{count} covered by only {covered}");
            }
        }
        // And a frame small enough to fit one dimension still gets one, so the common case is not
        // paying for a second.
        assert_eq!(super::groups(64 * 100).1, 1);
    }

    /// The row width the shaders fold `y` back in at, against the one the host splits at.
    ///
    /// Two spellings of one number, and the failure they guard is silent: a shader multiplying by
    /// more than the host dispatched reads a later row's samples for every row after the first, so
    /// the picture is assembled out of the wrong pixels and nothing reports it. Asserted as text
    /// because that is the only thing this side can see of the shader.
    #[test]
    fn the_shaders_split_a_dispatch_where_the_host_does() {
        let line = format!(
            "public static const uint ROW_GROUPS = {};",
            super::ROW_GROUPS
        );
        assert!(
            include_str!("../../../slang/lanes.slang").contains(&line),
            "slang/lanes.slang does not say `{line}`",
        );

        // Every dispatch the shaders undo has to be exactly that wide, or one row short of it.
        // Narrower with rows above it and the fold reads past its own row.
        for count in [64usize, 64 * 32_768, 64 * 32_769, 24_240_576, 60_217_344] {
            let (x, y) = super::groups(count);
            assert!(
                y == 1 || x == super::ROW_GROUPS,
                "{count} dispatches {x}x{y}, and the shaders fold at {}",
                super::ROW_GROUPS,
            );
        }
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

    /// The resize is the area average it claims to be, at a ratio that is not a whole number.
    ///
    /// **Which is nearly every render, and is where the CPU resize this replaced was wrong.** A
    /// destination pixel of a 3.75x reduction covers source `[3.75, 7.5)` - a quarter of pixel 3,
    /// all of 4, 5 and 6, half of 7. The old one took `floor` of each end and averaged whole pixels
    /// equally, reading 3, 4, 5 and 6 at equal weight and not reading 7 at all. On a ramp that is a
    /// *bias* rather than noise, every output pixel pulled towards the start of its footprint, and
    /// it measured 625 counts of 65535 - at exactly the ratio a 6000px sensor takes to a 1600px
    /// rendition. It went unseen because the tests it had asked at 2x and 4x, where a footprint
    /// lands on whole pixels and the two answers agree.
    ///
    /// A ramp, because the area average of an interval over one is its own midpoint - so the error
    /// is readable as a displacement rather than as noise.
    #[test]
    fn the_resize_weights_a_fractional_footprint() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };

        let (w, h) = (60usize, 4);
        let src: Vec<u16> = (0..w * h)
            .flat_map(|at| [((at % w) * 1000) as u16; 3])
            .collect();
        let out = resized(gpu, base, &src, (w, h), (16, 2)).expect("a downscale");

        // The area average spelled out here rather than as a closed form: each source pixel weighted
        // by how much of the footprint it covers, which is the definition the kernel implements and
        // is not the same as integrating the ramp - a pixel is a sample, not a segment.
        //
        // **In light, which is where the kernel accumulates.** The ramp is a ramp in *codes*, so its
        // area average in light is not its area average in codes; reading the expectation off the
        // codes would be asserting the bug this domain exists to remove.
        let decoded = |signal: f64| crate::tone::pq_inv::<SceneNits>(Light::measured(signal));
        let full = decoded(1.0);
        let light = |code: f64| (decoded(code / 65535.0) / full).raw();
        let mut worst = 0.0f64;
        for x in 0..16 {
            let (starts, ends) = (x as f64 * 3.75, (x + 1) as f64 * 3.75);
            let (mut acc, mut total) = (0.0f64, 0.0f64);
            for sx in starts.floor() as usize..ends.ceil() as usize {
                let weight = ((sx + 1) as f64).min(ends) - (sx as f64).max(starts);
                acc += weight * light((sx * 1000) as f64);
                total += weight;
            }
            // Back to a code the same way the shader does, by the curve rather than by a table.
            let want =
                crate::tone::pq(full * crate::light::Gain::of_ratio(acc / total)).raw() * 65535.0;
            worst = worst.max((f64::from(out[x * 3]) - want).abs());
        }
        // Of 65535, against the 625 the truncated footprint managed on the same ramp. What is left
        // is `f32` and the rounding into `u16`.
        eprintln!("the weighted footprint is off the area average by {worst:.1} of 65535");
        assert!(
            worst < 2.0,
            "the resize is {worst:.1} counts off the area average"
        );
    }

    /// It averages rather than sampling, and declines to enlarge.
    #[test]
    fn the_resize_averages_and_will_not_enlarge() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };

        // Two-by-two blocks of a known value: an averaging shrink returns the value, a
        // nearest-neighbour one returns whichever corner it happened to land on.
        let (w, h) = (4usize, 4usize);
        let mut src = vec![0u16; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let block = (y / 2) * 2 + (x / 2);
                for c in 0..3 {
                    src[(y * w + x) * 3 + c] = (1000 * (block + 1)) as u16;
                }
            }
        }
        let out = resized(gpu, base, &src, (w, h), (2, 2)).expect("a downscale");
        assert_eq!(out.len(), 2 * 2 * 3);
        for block in 0..4 {
            assert_eq!(out[block * 3], (1000 * (block + 1)) as u16, "block {block}");
        }

        // It exists to avoid work, not to invent detail; the caller keeps the original.
        let flat = vec![7u16; 8 * 8 * 3];
        assert!(resized(gpu, base, &flat, (8, 8), (16, 16)).is_none());
        assert!(
            resized(gpu, base, &flat, (8, 8), (8, 8)).is_none(),
            "the same size is not a downscale",
        );
        assert!(resized(gpu, base, &flat, (8, 8), (4, 4)).is_some());
    }

    /// A frame the coding has not reached averages in its own samples, which for that frame is the
    /// light: two levels a stop apart reduce to their arithmetic mean, where the coded resize -
    /// reading the same numbers as PQ - lands two thirds of the way to the brighter one.
    ///
    /// **The two answers are what the choice of table is**, so this pins the pair rather than one
    /// of them: a scene-linear frame handed to [`super::resize`] is monotone and plausible and
    /// wrong, which is a bug nothing else in a picture would show.
    #[test]
    fn scene_and_coded_resizes_decode_their_own_input_domains() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };

        // A checkerboard at the resize's own ratio of two: each output pixel covers two of each
        // level, so the answer is a mean of the pair however it is weighted.
        let (w, h) = (4usize, 4usize);
        let (dark, light) = (8000u16, 16000u16);
        let mut src = vec![0u16; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                for c in 0..3 {
                    src[(y * w + x) * 3 + c] = match (x + y) % 2 == 0 {
                        true => dark,
                        false => light,
                    };
                }
            }
        }

        let scene = resized_scene(gpu, base, &src, (w, h), (2, 2)).expect("a scene downscale");
        let mean = (u32::from(dark) + u32::from(light)) / 2;
        for (at, sample) in scene.iter().enumerate() {
            assert!(
                sample.abs_diff(mean as u16) <= 1,
                "sample {at} came back {sample}, not the mean {mean}",
            );
        }

        // The same numbers read as PQ: 8000 and 16000 stand for 0.56 and 4.73 nits there, so the
        // brighter tap is eight times the light its code suggests and the mean lands at about
        // 13330 - two thirds of the way up rather than half.
        let coded = resized(gpu, base, &src, (w, h), (2, 2)).expect("a coded downscale");
        assert!(
            coded[0] > mean as u16 + 1000,
            "the coded resize should read these as PQ, and gave {}",
            coded[0],
        );
    }

    #[test]
    fn pyramid_averages_hdr_light_and_preserves_flat_fields() {
        let gpu = crate::gpu::device().expect("the pyramid requires Vulkan");
        let base = super::device(gpu).expect("the pyramid pipeline");
        let frame: Vec<u16> = (0..16).flat_map(|pixel| {
            [if pixel % 2 == 1 && pixel / 4 % 2 == 1 { 59150 } else { 37953 }; 3]
        }).collect();
        let pyramid = super::pyramid(gpu, base, &frame, (4, 4)).expect("a pyramid");
        let levels = pollster::block_on(pyramid.levels_host(gpu)).expect("the levels");
        assert_eq!(levels[0], (vec![50270; 12], (2, 2)));
        assert_eq!(levels[1], (vec![50270; 3], (1, 1)));
        let flat = super::pyramid(gpu, base, &[59150; 48], (4, 4)).expect("a flat pyramid");
        let levels = pollster::block_on(flat.levels_host(gpu)).expect("the flat levels");
        assert_eq!(levels[0], (vec![59150; 12], (2, 2)));
        assert_eq!(levels[1], (vec![59150; 3], (1, 1)));
    }

    #[test]
    fn every_pyramid_level_is_a_mean_of_the_four_above_it() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };

        let (width, height) = (129usize, 67);
        let frame = edged(width, height);
        let built = super::pyramid(gpu, base, &frame, (width, height)).expect("a pyramid");
        let levels = pollster::block_on(built.levels_host(gpu)).expect("the levels read back");
        assert_eq!(
            levels.len(),
            7,
            "half of 129 is 64, and 64 halves six more times"
        );

        let mut coarser = frame;
        let mut size = (width, height);
        for (level, (theirs, want)) in levels.iter().enumerate() {
            // Floored, then held at one: an axis that has bottomed out stops halving while the
            // other carries on, and the footprint then covers whatever row or column is left
            // rather than two of them.
            let half = ((size.0 / 2).max(1), (size.1 / 2).max(1));
            assert_eq!(
                *want, half,
                "level {level} is not a floored half of the one above it"
            );
            let mut mine = vec![0u16; half.0 * half.1 * 3];
            for y in 0..half.1 {
                for x in 0..half.0 {
                    let (last_x, last_y) = ((2 * x + 2).min(size.0), (2 * y + 2).min(size.1));
                    for channel in 0..3 {
                        let (mut acc, mut taps) = (0.0f64, 0.0f64);
                        for sy in 2 * y..last_y {
                            for sx in 2 * x..last_x {
                                let code = coarser[((sy * size.0) + sx) * 3 + channel];
                                acc += crate::tone::pq_inv::<crate::light::SceneNits>(
                                    crate::light::Light::measured(f64::from(code) / 65535.0),
                                ).raw();
                                taps += 1.0;
                            }
                        }
                        mine[((y * half.0) + x) * 3 + channel] = (crate::tone::pq(
                            crate::light::Light::<crate::light::SceneNits>::measured(acc / taps),
                        ).raw() * 65535.0).round() as u16;
                    }
                }
            }
            let worst = theirs
                .iter()
                .zip(&mine)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .expect("samples");
            assert!(
                worst <= 1,
                "level {level} at {}x{} is {worst} counts off a mean of four",
                half.0, half.1,
            );
            coarser = mine;
            size = half;
        }
    }

    /// A window of the frame against the whole frame's own gather, over the same pixels.
    ///
    /// **What a loupe tile rests on.** The magnifier decodes a region and corrects it, and the
    /// correction has to be the one the *photograph's* gather would have applied there - a window
    /// corrected as though it were the whole picture bends by the entire distortion across a few
    /// hundred pixels and lifts its corners as if they were the frame's. That is one `Gather` field
    /// away from the whole-frame case ([`Gather::window`]), which is exactly why it is worth
    /// asserting rather than assuming.
    ///
    /// Bit-equal, and it can be: both sides are the same shader on the same frame, reading the same
    /// taps. The window is handed the whole frame as its region, so the only thing that differs is
    /// which output pixels are written.
    #[test]
    fn a_window_of_the_gather_is_the_frame_it_was_cut_from() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };

        let (width, height) = (257usize, 181);
        let frame = edged(width, height);
        let knots = vec![0.0, 40.0, 160.0, 380.0];
        let lens = crate::fit::Lens {
            crop: crate::image::fill_crop(&knots, width, height),
            distortion: Some(knots),
            falloff: Some((0.25, 0.1)),
            tca: Some([vec![0.0, 24.0, 60.0], vec![0.0, -18.0, -44.0]]),
        };

        let whole = warped(
            gpu,
            base,
            &frame,
            super::Gather::frame(crate::px::Size::exact(width, height)),
            &lens,
        )
        .expect("the whole frame warps");

        // Off-centre and odd on both axes, so nothing about the window lines up with the frame's
        // own centre or with the pair of pixels an invocation writes.
        for (left, top, cut_width, cut_height) in [
            (0usize, 0usize, 61usize, 43usize),
            (97, 63, 71, 51),
            (width - 53, height - 39, 53, 39),
        ] {
            let cut = warped(
                gpu,
                base,
                &frame,
                super::Gather::window(
                    crate::px::Size::exact(width, height),
                    crate::px::Rect::exact(left, top, cut_width, cut_height),
                    crate::px::Rect::exact(0, 0, width, height),
                ),
                &lens,
            )
            .expect("the window warps");

            for row in 0..cut_height {
                for column in 0..cut_width {
                    for channel in 0..3 {
                        let from = ((top + row) * width + left + column) * 3 + channel;
                        let to = (row * cut_width + column) * 3 + channel;
                        assert_eq!(
                            cut[to], whole[from],
                            "the window at {left},{top} differs at {column},{row}",
                        );
                    }
                }
            }
        }
    }

    /// A channel scaled above 1 reads further out on the GPU, below 1 further in, and green reads
    /// bit for bit where it read with no lateral correction at all.
    ///
    /// A horizontal ramp, so a channel's value says where it was read from. Left of centre the
    /// ramp rises towards the middle, so reading further out - towards the edge - reads darker.
    #[test]
    fn a_lateral_scale_moves_each_channel_the_way_it_was_told_to() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };

        let (w, h) = (64usize, 48usize);
        let frame: Vec<u16> = (0..w * h)
            .flat_map(|at| [(2_000 + (at % w) * 900) as u16; 3])
            .collect();
        let flat = |scale: f64| vec![(scale - 1.0) * crate::image::SPLINE_UNIT; 2];
        let gather = super::Gather::frame(crate::px::Size::exact(w, h));
        let plain = warped(gpu, base, &frame, gather, &bending()).expect("a bending lens warps");
        let scaled = crate::fit::Lens {
            tca: Some([flat(1.05), flat(0.95)]),
            ..bending()
        };
        let out = warped(gpu, base, &frame, gather, &scaled).expect("a bending lens warps");

        let moved = out
            .iter()
            .zip(&plain)
            .skip(1)
            .step_by(3)
            .position(|(a, b)| a != b);
        assert_eq!(
            moved, None,
            "green must not move, and did at pixel {moved:?}"
        );

        // Well off centre, so the scale buys more than a rounding step of the ramp.
        let at = |c: usize| i32::from(out[((h / 2) * w + w / 8) * 3 + c]);
        assert!(
            at(0) < at(1),
            "red scaled >1 must read further out: {} against {}",
            at(0),
            at(1)
        );
        assert!(
            at(2) > at(1),
            "blue scaled <1 must read further in: {} against {}",
            at(2),
            at(1)
        );
    }

    /// The lens warp on the base and then the geometry in the grade land a pixel where one gather
    /// through both mappings would.
    ///
    /// Two resamples in place of one is what lets a crop handle move without a re-prepare, and what
    /// it must not cost is registration: a half-pixel shift, a transposed pair, a turn resolved the
    /// wrong way. The reference is the mapping alone - `geometry_at` into the lens's own ratio
    /// tables, as `lens_footprint` walks them - evaluated on a plane, which a cubic reproduces
    /// exactly. What the bound absorbs is the cubic on the coded curve, twice, and it is a
    /// ratchet: a change widening the gap says so here rather than in a photograph.
    #[test]
    fn the_staged_pipeline_places_a_pixel_where_one_fused_gather_would() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };

        let (width, height) = (192usize, 128usize);
        let plane = |x: f64, y: f64| 8_000.0 + 200.0 * x + 100.0 * y;
        let frame: Vec<u16> = (0..width * height)
            .flat_map(|at| [plane((at % width) as f64, (at / width) as f64).round() as u16; 3])
            .collect();

        let unit = crate::image::SPLINE_UNIT;
        let lens = crate::fit::Lens {
            tca: Some([vec![0.0, 0.01 * unit], vec![0.0, -0.008 * unit]]),
            ..bending()
        };
        // An off-centre crop, a straighten and a quarter turn: a pixel's error is a function of how
        // far it travels, and a gentle case would say nothing about the frames this protects.
        let geometry = crate::image::Geometry {
            crop: [0.08, 0.06, 0.92, 0.94],
            angle_degrees: 2.5,
            rotate: 90,
            keystone: None,
        };

        let levels = crate::tone::Levels {
            white: Light::measured(50_000.0),
            peak: Light::measured(58_900.0),
            floor: None,
        };
        let code =
            |samples: &mut [u16]| crate::hdr::code_base(samples, levels.anchored(), REFERENCE);
        let grading = |width: usize, height: usize, geometry: crate::image::Geometry| {
            crate::gpu::Grade {
                width,
                height,
                photograph_long: crate::px::Span::measured(width.max(height)),
                colour: None,
                white: levels.white,
                source_level: levels.peak,
                floor: levels.floor,
                reference_nits: REFERENCE,
                peak_nits: Light::exactly(1000.0),
                exposure: crate::light::Stops::ZERO,
                adjust: crate::gpu::Adjust::none(),
                as_shot: None,
                // Rolled rather than PQ, so a difference in counts is a difference in light: the
                // transfer compresses the shadows and would flatter every number below.
                output: crate::gpu::Output::Rolled,
                geometry,
                window: None,
                surround_window: None,
                canvas: None,
            }
        };

        // The pipeline: the lens on the GPU into a frame of its own, then the geometry in the grade.
        let mut coded = frame.clone();
        code(&mut coded);
        let warped = warped(
            gpu,
            base,
            &coded,
            super::Gather::frame(crate::px::Size::exact(width, height)),
            &lens,
        )
        .expect("a bending lens warps");
        let staged = grading(width, height, geometry);
        let out = staged.output_size();
        let ours = gpu.encode(&warped, &staged);

        // The reference: the plane read at where both mappings, composed, put each output pixel.
        let tables = crate::image::ratio_tables(
            lens.distortion.as_deref().unwrap_or_default(),
            lens.crop,
            &lens.channels(),
        );
        let last = crate::image::RATIO_TABLE_LAST;
        let (full_w, full_h) = (width as f64, height as f64);
        let half2 = (full_w / 2.0).powi(2) + (full_h / 2.0).powi(2);
        let mut fused = vec![0u16; out.0 * out.1 * 3];
        for y in 0..out.1 {
            for x in 0..out.0 {
                let (px, py) = crate::image::geometry_at(
                    (width, height),
                    out,
                    geometry,
                    x as f64 + 0.5,
                    y as f64 + 0.5,
                );
                let (ox, oy) = (px - full_w / 2.0, py - full_h / 2.0);
                let t = (ox * ox + oy * oy) / half2 * last as f64;
                let slot = (t as usize).min(last - 1);
                for (c, table) in tables.iter().enumerate() {
                    let ratio = table[slot] + (table[slot + 1] - table[slot]) * (t - slot as f64);
                    // The photograph's centre half a pixel back, as `warp.slang`'s `Params::centre`
                    // has it: an integer is a pixel's centre.
                    let sx = full_w / 2.0 - 0.5 + ox * ratio;
                    let sy = full_h / 2.0 - 0.5 + oy * ratio;
                    fused[(y * out.0 + x) * 3 + c] = plane(sx, sy).round() as u16;
                }
            }
        }
        code(&mut fused);
        let theirs = gpu.encode(
            &fused,
            &grading(out.0, out.1, crate::image::Geometry::none()),
        );

        assert_eq!(
            ours.len(),
            theirs.len(),
            "the two routes framed differently"
        );

        // Interior only: the staged route reads an edge the lens warp already invented, and that
        // band is a separate question from whether the interiors match.
        let margin = 6;
        let (mut worst, mut total, mut counted) = (0u32, 0u64, 0u64);
        for y in margin..out.1 - margin {
            for x in margin..out.0 - margin {
                for channel in 0..3 {
                    let at = (y * out.0 + x) * 3 + channel;
                    let off = u32::from(ours[at].abs_diff(theirs[at]));
                    worst = worst.max(off);
                    total += u64::from(off);
                    counted += 1;
                }
            }
        }
        let mean = total as f64 / counted as f64;
        eprintln!("staged against fused: mean {mean:.2} counts of 65535, worst {worst}");
        // Of 65535, on a plane climbing 200 counts a pixel: half a pixel of drift anywhere in the
        // mapping is a hundred counts here and nowhere near these.
        assert!(
            mean < 1.5,
            "the two routes differ by a mean of {mean:.2} counts"
        );
        assert!(worst < 12, "the two routes differ by up to {worst} counts");
    }

    /// The chain against the three public functions it collapses, on the same frame.
    ///
    /// **Bit-equal, unlike every other test here, and it has to be.** The others hold a shader
    /// against a CPU that computes the same thing differently; this holds the same shaders on the
    /// same data against themselves, and every stage writes u16 back into the same packed buffer -
    /// so the readbacks the chain deletes were copies, not roundings. A count of difference is a
    /// bug in the plumbing.
    ///
    /// Both branches, because which buffer holds the answer is what the warp's absence changes.
    #[test]
    fn prepare_is_the_three_stages_over_one_buffer() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };

        let (width, height) = (257usize, 181);
        let frame = edged(width, height);
        let levels = crate::tone::Levels {
            white: Light::measured(8133.0),
            peak: Light::measured(13783.0),
            floor: None,
        }
        .anchored();
        // The strengths `prepare` takes, and the pair it will measure for itself - off the frame as
        // it arrives, which is linear, since that is where the correction now happens. Taken here
        // the same way so the staged side is the same arithmetic rather than a number chosen to
        // agree with it.
        let strengths = crate::image::Strengths {
            sharpen: 0.0,
            defringe: 1.0,
        };
        let defocus = pollster::block_on(super::measure_defocus(
            gpu, base, &frame, width, height, None, None,
        ))
        .map(|(red, blue)| {
            let scale = strengths.defringe.clamp(0.0, 1.0) as f32;
            (red * scale, blue * scale)
        })
        .unwrap_or((0.0, 0.0));
        let knots = vec![0.0, 40.0, 160.0, 380.0];
        let lens = crate::fit::Lens {
            crop: crate::image::fill_crop(&knots, width, height),
            distortion: Some(knots),
            falloff: Some((0.25, 0.1)),
            tca: Some([vec![0.0, 24.0, 60.0], vec![0.0, -18.0, -44.0]]),
        };

        let staged = |lens: &crate::fit::Lens| {
            // Defringe, then code, then warp - the order `prepare` runs them in, the correction
            // belonging to the linear frame the decode hands over.
            let mut samples = frame.clone();
            pollster::block_on(super::defringe(
                gpu,
                base,
                &mut samples,
                width,
                height,
                defocus,
            ))
            .expect("the defringe runs");
            pollster::block_on(super::encode_base(
                gpu,
                base,
                &mut samples,
                levels,
                REFERENCE,
            ))
            .expect("the coding runs");
            let gathered = warped(
                gpu,
                base,
                &samples,
                super::Gather::frame(crate::px::Size::exact(width, height)),
                lens,
            );
            gathered.unwrap_or(samples)
        };
        let chained = |lens: &crate::fit::Lens| {
            let prepared = pollster::block_on(super::prepare(
                gpu,
                base,
                Resident::upload(gpu, &frame, width, height),
                super::Gather::frame(crate::px::Size::exact(width, height)),
                levels,
                REFERENCE,
                strengths,
                crate::image::SharpenSigma::fixed(crate::image::DECONVOLVE_SIGMA),
                crate::image::SharpenNoise::NONE,
                lens,
                super::Defringe::Measure,
                None,
                None,
            ))
            .expect("the chain runs")
            .0;
            pollster::block_on(prepared.into_host()).expect("the prepared frame maps")
        };
        let differing = |mine: &[u16], theirs: &[u16]| {
            assert_eq!(
                mine.len(),
                theirs.len(),
                "the chain returned a different frame"
            );
            mine.iter().zip(theirs).filter(|(a, b)| a != b).count()
        };

        let theirs = staged(&lens);
        // The stages have to have moved the frame before an equality on them means anything: two
        // chains that both did nothing agree perfectly.
        assert!(
            differing(&theirs, &frame) > frame.len() / 2,
            "the stages left the frame alone"
        );
        assert_eq!(
            differing(&chained(&lens), &theirs),
            0,
            "the chained frame differs"
        );

        let identity = crate::fit::Lens::none();
        assert_eq!(
            differing(&chained(&identity), &staged(&identity)),
            0,
            "unwarped, it differs"
        );
    }

    /// A frame whose red and blue are genuinely softer than its green, by the same amount
    /// everywhere in the field.
    ///
    /// **A focus difference is not a colour, so it cannot be painted on.** The fit regresses
    /// `channel - luma` on the curvature of luma, so a frame with arbitrary colour at its edges
    /// gives it nothing to find and one where the fringe *is* a multiple of that curvature gives
    /// it the multiple. A blur of `t` is `g + t.lap(g)` to first order, which is that same model,
    /// so red and blue are green seen through one - flat across the field, which is what the `r^2`
    /// split is there to keep and a lateral aberration would not survive.
    ///
    /// **Blocks with ramped edges rather than a grating, because the sigmas are measured too.**
    /// The debias needs each channel's noise, and `sigma_from` reads it as the median residual of
    /// a 3x3 mean - a frame textured *everywhere* has no quiet pixels for that median to sit
    /// among, reads its own texture as noise, and pins itself at `NOISE_CEILING`, which two paths
    /// would then agree on for the wrong reason. Flats are the majority here, so the median lands
    /// among them and the number is the noise that was actually added.
    ///
    /// The contrast grows with radius, so the bins carry genuinely different curvature energy and
    /// the weighting in the regression is load-bearing; the coefficient does not, so what the fit
    /// should recover is the constant it was built with.
    fn defocused(width: usize, height: usize) -> Vec<u16> {
        let (cx, cy) = (width as f32 / 2.0, height as f32 / 2.0);
        let half = (cx * cx + cy * cy).sqrt();
        let mut blocks = vec![0.0f32; width * height];
        for y in 0..height {
            for x in 0..width {
                let radius = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt() / half;
                let amplitude = 0.10 + 0.28 * radius;
                let up = ((x / 17) + (y / 17)) % 2 == 0;
                blocks[y * width + x] = 0.5 + if up { amplitude } else { -amplitude };
            }
        }
        // A hard step's Laplacian is two spikes a pixel wide, and the stride reads every third
        // pixel - so half the frame's curvature would be in samples nobody looks at, and which of
        // them get looked at would depend on where the blocks happen to start.
        let smooth: Vec<f32> = (0..width * height)
            .map(|at| {
                let (x, y) = (at % width, at / width);
                let (mut sum, mut count) = (0.0f32, 0.0f32);
                for sy in y.saturating_sub(1)..=(y + 1).min(height - 1) {
                    for sx in x.saturating_sub(1)..=(x + 1).min(width - 1) {
                        sum += blocks[sy * width + sx];
                        count += 1.0;
                    }
                }
                sum / count
            })
            .collect();
        let curvature = crate::image::laplacian(&smooth, width, height);

        let mut state = 0x853c_49e6_748f_ea9bu64;
        let mut normal = || {
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
        let softness = DEFOCUSED_SOFTNESS;
        let sigmas = [0.0012f32, 0.0015, 0.0018];
        let mut out = Vec::with_capacity(width * height * 3);
        for at in 0..width * height {
            for channel in 0..3 {
                let value =
                    smooth[at] + softness[channel] * curvature[at] + sigmas[channel] * normal();
                out.push((value * 65535.0).clamp(0.0, 65535.0) as u16);
            }
        }
        out
    }

    /// What `defocused` writes into the frame, and so what the fit has to return.
    ///
    /// Green sharp, since that is the channel autofocus works on; and the two that are not sharp
    /// differ, because one figure could not catch a transposition.
    const DEFOCUSED_SOFTNESS: [f32; 3] = [0.08, 0.0, 0.15];

    /// The defocus fit, against the coefficients the fixture was built with.
    ///
    /// **Against the injection rather than against a second implementation**, which is the
    /// stronger claim: `defocused` writes
    /// `smooth + softness.laplacian(smooth)` per channel, so the numbers the fit should return are
    /// known exactly rather than agreed with.
    ///
    /// The bound is a percent, and what sets it is the one place the fit can take a whole step
    /// rather than a small one: each channel's sigma is a bucket index off a 1024-bucket
    /// histogram, and one bucket moves the debias enough to shift the coefficient by ~0.2%. A
    /// percent clears that and still rejects a structural error several times over - the
    /// Laplacian's centre tap a quarter of a percent wrong reads 2.5% off, the fit dividing one
    /// sum built from the stencil by another.
    #[test]
    fn the_defocus_fit_recovers_the_softness_it_was_given() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };

        // Neither dimension a multiple of the stride or the block, so the partial segment at the
        // end of a row is exercised rather than assumed, and an odd sample count for `upload`.
        let (width, height) = (211usize, 149);
        let frame = defocused(width, height);

        let mine = pollster::block_on(super::measure_defocus(
            gpu, base, &frame, width, height, None, None,
        ))
        .expect("the measurement runs");
        eprintln!("fit {mine:?} against injected {DEFOCUSED_SOFTNESS:?}");

        // **A band per channel, and it cannot be tighter than this.** The debias subtracts
        // `4.v_luma - 4.cov(luma, c)` from each channel, and that covariance differs between red
        // and blue, so the subtraction takes some signal with it and takes *different* amounts of
        // it from the two. Neither the magnitudes nor their ratio survives, so what is left to
        // assert is that each lands near its own injection.
        //
        // Which is still enough to catch the failures that matter. The two injected values are far
        // enough apart that a transposition puts red at blue's 0.138, well outside its band.
        for (got, injected) in [
            (mine.0, DEFOCUSED_SOFTNESS[0]),
            (mine.1, DEFOCUSED_SOFTNESS[2]),
        ] {
            assert!(
                got > injected * 0.6 && got < injected * 1.1,
                "{got} is not the {injected} that went in",
            );
        }
    }

    /// A frame corrected ahead of the camera match is not corrected again by the chain.
    ///
    /// **Both `correct` and `prepare` defringe, and an open that fits a match calls both over the
    /// same frame** - the correction first, because the search compares our render against a JPEG
    /// the camera has already defringed, and then the chain for the coding. Handing the chain the
    /// pair so it does not re-measure is not the same as telling it the work is done, and the
    /// difference between those two is a frame corrected twice.
    ///
    /// Held against the chain doing it once, off the same frame, rather than against a tolerance:
    /// the two are the same dispatch over the same buffer, so the only thing that can differ is how
    /// many times it ran.
    #[test]
    fn a_frame_corrected_before_the_fit_is_not_corrected_again() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(base) = super::device(gpu) else {
            return;
        };

        let (width, height) = (211usize, 149);
        let samples = defocused(width, height);
        let levels = crate::tone::Levels {
            white: Light::measured(30000.0),
            peak: Light::measured(60000.0),
            floor: None,
        }
        .anchored();
        let strengths = crate::image::Strengths {
            sharpen: 0.0,
            defringe: 1.0,
        };
        let gather = super::Gather::frame(crate::px::Size::exact(width, height));
        let none = crate::fit::Lens::none();

        // What an open does: correct the linear frame for the fit, then run the chain over it.
        let first = Resident::upload(gpu, &samples, width, height);
        let pair = pollster::block_on(super::correct(
            gpu, base, &first, strengths, None, None, None,
        ))
        .expect("the correction runs");
        assert_ne!(
            pair,
            (0.0, 0.0),
            "a pair of zero would make both arms the same test"
        );
        let opened = pollster::block_on(async {
            let (prepared, _) = super::prepare(
                gpu,
                base,
                first,
                gather,
                levels,
                REFERENCE,
                strengths,
                crate::image::SharpenSigma::fixed(crate::image::DECONVOLVE_SIGMA),
                crate::image::SharpenNoise::NONE,
                &none,
                super::Defringe::Done(pair),
                None,
                None,
            )
            .await?;
            prepared.into_host().await
        })
        .expect("the chain runs");

        // The same correction applied once, by the chain alone.
        let second = Resident::upload(gpu, &samples, width, height);
        let once = pollster::block_on(async {
            let (prepared, _) = super::prepare(
                gpu,
                base,
                second,
                gather,
                levels,
                REFERENCE,
                strengths,
                crate::image::SharpenSigma::fixed(crate::image::DECONVOLVE_SIGMA),
                crate::image::SharpenNoise::NONE,
                &none,
                super::Defringe::Take(pair),
                None,
                None,
            )
            .await?;
            prepared.into_host().await
        })
        .expect("the chain runs");

        let differing = opened.iter().zip(&once).filter(|(a, b)| a != b).count();
        assert_eq!(
            differing, 0,
            "{differing} samples were defringed a second time"
        );
    }
}
