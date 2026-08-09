//! The grade, on whatever GPU this machine has, from the shaders the editor runs.
//!
//! **This exists so there is one implementation of the grade.** The editor's tick has to be
//! WGSL - it runs in a browser - so the choice was ever a second implementation in Rust or
//! this. DESIGN 21.1 records what the second one cost: the editor lost the camera match
//! twice, silently, because two implementations of one picture drifted. Sharing the source
//! makes that unexpressible rather than tested-for.
//!
//! The shaders are `include_str!`'d from `web/`, so the file the browser imports and the
//! file this compiles are the same bytes. A copy under `native/` would pass every test it
//! had while diverging from what ships.
//!
//! **The device is process-wide and built once.** Adapter enumeration and shader
//! compilation are tens of milliseconds; a rendition job that paid them per photo would
//! spend more there than on the grade. Held behind a `OnceLock` rather than passed down
//! through every caller, because the alternative is threading a device through
//! `job::run` -> `hdr::graded` -> `tone` for a resource there is exactly one of.

use crate::hdr_fit::{self, HdrColour};
use std::sync::OnceLock;
use wgpu::util::DeviceExt;

/// The same composition `shaders.ts` performs, from the same files.
///
/// `prelude` and `tick` declare what `colour` and the last file assume; the order is the one
/// `FRAME` and `PEAK` use on the client. Concatenated rather than `#import`ed because WGSL
/// has no include and the client's bundler does the same join.
fn source(last: &str) -> String {
    format!(
        "{}\n{}\n{}\n{last}",
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/prelude.wgsl"),
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/tick.wgsl"),
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/colour.wgsl"),
    )
}

const FRAME_WGSL: &str = include_str!("../../../web/src/features/raw_edit/gpu/wgsl/frame.wgsl");
const PEAK_WGSL: &str = include_str!("../../../web/src/features/raw_edit/gpu/wgsl/peak.wgsl");

/// `DECODE` in `shaders.ts`: the frame's coding undone, and nothing of `colour.wgsl` because
/// it binds the same table read-only.
fn decode_source() -> String {
    format!(
        "{}\n{}",
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/prelude.wgsl"),
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/decode.wgsl"),
    )
}

/// Entries in that table, which is every `u16` a sample can hold. `PQ_CODES` on the client.
const PQ_CODES: u64 = 65536;

/// The scene's own top end, measured once and read by every rendition of the photograph.
///
/// **Once per photograph, not once per size.** It is a property of the scene - what the
/// roll-off compresses into the display - so two renditions measuring it separately would
/// compress their highlights by different amounts, which is the drift `tone::levels` exists to
/// prevent at the other end of the range. `job::run` uploads once per size group, so a
/// grid-and-full job would otherwise measure it twice, on two differently sized frames.
///
/// Four words, filled on the GPU by `Uploaded::measure_peak` and read there by the grade. The
/// CPU never sees the number.
pub struct ScenePeak {
    buffer: wgpu::Buffer,
    measured: std::cell::Cell<bool>,
}

impl ScenePeak {
    /// Whether this still wants filling, claiming it if so.
    fn claim(&self) -> bool {
        !self.measured.replace(true)
    }
}

/// How the peak samples a frame: every nth row, for about `tone::QUANTILE_SAMPLES` pixels.
///
/// `TickPipeline`'s `rowStride` and `sampledGroups`, arrived at the same way, because the two
/// hosts have to read the *same* pixels or they measure two different peaks off one photo.
/// Whole rows rather than a scatter because `peak.wgsl` reads a frame: consecutive lanes stay
/// adjacent, where a stride applied per pixel would take a cache line each and fetch the whole
/// frame to read a tenth of it.
pub fn sampled_rows(width: usize, height: usize) -> (u32, u32) {
    let pixels = width * height;
    let stride =
        (((pixels as f64) / (crate::tone::QUANTILE_SAMPLES as f64)).round() as u32).max(1);
    (stride, (height as u32).div_ceil(stride))
}

pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
    peak_layout: wgpu::BindGroupLayout,
    peak_measure: wgpu::ComputePipeline,
    peak_quantile: wgpu::ComputePipeline,
    sampler: wgpu::Sampler,
    /// The frame's coding undone. Filled once with the device, since `tone::encode_base`
    /// anchors every frame to the reference white before coding it and what comes back out
    /// is nits - nothing here depends on the photograph.
    nits_of_code: wgpu::Buffer,
}

static GPU: OnceLock<Option<Gpu>> = OnceLock::new();

/// The device, or None where no adapter of any kind answered.
///
/// None is a refusal, not a fallback. There is no CPU grade to drop to any more - that was
/// the second implementation DESIGN 21.1 records the cost of - so `job::run` returns an error
/// naming the missing driver and the photo goes unrendered rather than rendered differently.
/// An `Option` rather than a panic so the refusal is the caller's to word.
pub fn device() -> Option<&'static Gpu> {
    GPU.get_or_init(Gpu::new).as_ref()
}

impl Gpu {
    fn new() -> Option<Gpu> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN | wgpu::Backends::METAL,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        // Hardware first, and software only if there is none. Both are asked for
        // explicitly: `request_adapter` with the default options will not return a
        // software adapter on its own, so a box with only lavapipe installed would
        // otherwise report no GPU at all. That path is very slow - it is a CPU rasteriser
        // running a shader written for a GPU - and it is here so such a box imports slowly
        // rather than not at all.
        let hardware = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }));
        let adapter = match hardware {
            Ok(adapter) => adapter,
            Err(_) => pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                force_fallback_adapter: true,
                ..Default::default()
            }))
            .ok()?,
        };

        // The adapter's own limits, not `downlevel_defaults`. Those are WebGPU's portable
        // floor and cap a storage binding at 128MB, which a real frame is nowhere near
        // fitting: the frame and `counts` are six bytes a pixel each, so 144MB at 24MP and
        // 366MB at 61MP. The browser lives with that floor because it has to; a native
        // process has no reason to ask for less than the hardware offers, and asking for
        // less turns every full-size rendition into a validation failure.
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("rawshim"),
                required_limits: adapter.limits(),
                ..Default::default()
            }))
            .ok()?;
        // A validation error here is a bug in the shader or in what is bound to it, and
        // both are ours. Left to the default handler it would print and continue, and the
        // frame would come back wrong rather than not at all.
        device.on_uncaptured_error(std::sync::Arc::new(|error| panic!("rawshim gpu: {error}")));

        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("tick"),
            source: wgpu::ShaderSource::Wgsl(source(FRAME_WGSL).into()),
        });
        let peak_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("peak"),
            source: wgpu::ShaderSource::Wgsl(source(PEAK_WGSL).into()),
        });
        let group_layout = |label: &str, bindings: &[(u32, Binding)]| {
            let entries: Vec<_> =
                bindings.iter().map(|(binding, kind)| kind.entry(*binding)).collect();
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some(label),
                entries: &entries,
            })
        };
        let layout = group_layout("encode", &ENCODE_BINDINGS);
        let peak_layout = group_layout("peak", &PEAK_BINDINGS);
        let compute = |label: &str,
                       module: &wgpu::ShaderModule,
                       group: &wgpu::BindGroupLayout,
                       entry_point: &str| {
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(label),
                bind_group_layouts: &[Some(group)],
                ..Default::default()
            });
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                module,
                entry_point: Some(entry_point),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let pipeline = compute("encode", &module, &layout, "encode");
        // `measure` and `quantile` only. `collect` and `remeasure` exist so the editor's
        // slider does not re-sweep the frame at every position; a rendition is graded at one
        // exposure and never asks twice.
        let peak_measure = compute("measure", &peak_module, &peak_layout, "measure");
        let peak_quantile = compute("quantile", &peak_module, &peak_layout, "quantile");
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        // Filled by the shader rather than by `tone::pq_inv` and uploaded, so that the coding
        // the frame arrives in is undone by the same source the client undoes it with. There
        // is a Rust `pq_inv` and it is not this one's twin: this table is what the *grade*
        // reads, and the grade has one implementation on purpose (21.1).
        let nits_of_code = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("nits_of_code"),
            size: PQ_CODES * 4,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let decode_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("decode"),
            source: wgpu::ShaderSource::Wgsl(decode_source().into()),
        });
        let decode_layout = group_layout("decode", &[(12, Binding::Storage { read_only: false })]);
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("decode"),
            layout: &decode_layout,
            entries: &[wgpu::BindGroupEntry { binding: 12, resource: nits_of_code.as_entire_binding() }],
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&compute("pq_table", &decode_module, &decode_layout, "pq_table"));
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups((PQ_CODES / 64) as u32, 1, 1);
        }
        queue.submit([encoder.finish()]);

        Some(Gpu {
            device,
            queue,
            layout,
            pipeline,
            peak_layout,
            peak_measure,
            peak_quantile,
            sampler,
            nits_of_code,
        })
    }

    /// The largest binding one frame needs: `encode`'s output, two `u16` components to a
    /// word, rounded up to the three whole words an invocation writes for its two pixels.
    fn binding_bytes(pixels: usize) -> u64 {
        (pixels.div_ceil(2) * 3 * 4) as u64
    }

    /// The workgroups `encode` wants for a frame of this many pixels, as a 2D grid.
    ///
    /// Two dimensions because one is not enough: an invocation covers two pixels and a
    /// workgroup 64 of them, so a 61MP frame wants 476k of them against the 65535 a single
    /// dimension allows. The shader folds `y` back in through `num_workgroups`, so the split
    /// is the host's to choose and nothing has to agree about it in the uniform.
    fn encode_groups(&self, pixels: usize) -> (u32, u32) {
        let wanted = pixels.div_ceil(2).div_ceil(64) as u32;
        let wide = self.device.limits().max_compute_workgroups_per_dimension.max(1);
        let x = wanted.min(wide).max(1);
        (x, wanted.div_ceil(x).max(1))
    }

    /// Whether a frame of this many pixels fits the adapter in one dispatch.
    ///
    /// Asked rather than assumed because the answer is a hardware limit and the frames are
    /// large: 137MiB of output at 24MP, 349MiB at 61MP. One question covers both bindings now
    /// that the output is packed - six bytes a pixel is exactly what the frame takes - where a
    /// `u32` per component made the output the larger of the two and this the only one asked
    /// about.
    ///
    /// **Measured, it does not bite on real hardware.** RADV on an integrated Radeon
    /// reports 2047MiB for both `max_storage_buffer_binding_size` and `max_buffer_size`,
    /// which is six times what the largest sensor here needs. So the banding this would
    /// otherwise force is unwritten on purpose - it would be complexity for a case no
    /// machine with a GPU reaches. Where it could bite is the software adapter, which is
    /// already the path that is very slow and not expected to be hit.
    ///
    /// A caller that gets `false` therefore has to band the frame or grade it another way;
    /// what it must not do is dispatch and find out, since a binding over the limit is a
    /// validation error and `on_uncaptured_error` makes those fatal.
    pub fn fits(&self, pixels: usize) -> bool {
        let limits = self.device.limits();
        let needed = Self::binding_bytes(pixels);
        needed <= u64::from(limits.max_storage_buffer_binding_size) && needed <= limits.max_buffer_size
    }
}

/// What `encodeLayout` names on the client, in one list so the layout and the bind group
/// cannot drift apart.
const ENCODE_BINDINGS: [(u32, Binding); 12] = [
    (0, Binding::Uniform),
    (1, Binding::Storage { read_only: true }),
    (2, Binding::Curves),
    (3, Binding::Volume),
    (4, Binding::Storage { read_only: true }),
    (5, Binding::Storage { read_only: true }),
    (6, Binding::Storage { read_only: false }),
    (7, Binding::Sampler),
    (9, Binding::Pyramid),
    (10, Binding::Volume),
    (11, Binding::Volume),
    (12, Binding::Storage { read_only: true }),
];

/// `peakLayout` on the client: the same colour bindings, and the histogram, the peak and the
/// candidates all writable where the encode reads the peak and writes only the frame.
const PEAK_BINDINGS: [(u32, Binding); 12] = [
    (0, Binding::Uniform),
    (1, Binding::Storage { read_only: true }),
    (2, Binding::Curves),
    (3, Binding::Volume),
    (4, Binding::Storage { read_only: true }),
    (5, Binding::Storage { read_only: false }),
    (6, Binding::Storage { read_only: false }),
    (7, Binding::Sampler),
    (8, Binding::Storage { read_only: false }),
    (10, Binding::Volume),
    (11, Binding::Volume),
    (12, Binding::Storage { read_only: true }),
];

/// `PEAK_BINS` in `shaders.ts`, and `BINS` in the shader that both stand for.
const PEAK_BINS: u64 = 8192;

#[derive(Clone, Copy)]
enum Binding {
    Uniform,
    Storage { read_only: bool },
    /// `r32float`, which without `float32-filterable` is unfilterable - and is only ever
    /// loaded, never sampled.
    Curves,
    Volume,
    Sampler,
    /// Declared by `frame.wgsl` and unread at `lod` 0, but an explicit layout has to supply
    /// everything the module declares.
    Pyramid,
}

impl Binding {
    const fn entry(self, binding: u32) -> wgpu::BindGroupLayoutEntry {
        let visibility = wgpu::ShaderStages::COMPUTE;
        let ty = match self {
            Binding::Uniform => wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            Binding::Storage { read_only } => wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            Binding::Curves => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            Binding::Volume => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D3,
                multisampled: false,
            },
            Binding::Sampler => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            Binding::Pyramid => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Uint,
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
        };
        wgpu::BindGroupLayoutEntry { binding, visibility, ty, count: None }
    }
}

/// Everything a grade needs that is not the frame itself.
pub struct Grade<'a> {
    pub width: usize,
    pub height: usize,
    pub colour: Option<&'a HdrColour>,
    /// `tone::Levels`, as the uniform's `white` and `source_level`.
    pub white: f64,
    pub source_level: f64,
    pub reference_nits: f64,
    pub peak_nits: f64,
    pub exposure: f64,
    /// Which transfer to write. The grade is the same either way; an SDR target differs by
    /// having its `peak_nits` at diffuse white (`job::peak_nits`) and by ending here.
    pub output: Output,
}

/// `tick.output` in the shader, whose values these must match.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Output {
    /// Rec.2020 at 16 bits of PQ.
    Pq,
    /// sRGB primaries and transfer at 8 bits, in the low byte of each `u32`.
    Srgb,
    /// The rolled frame, before any transfer - what the CPU's grade produced and what every
    /// rendition path already encodes for itself.
    Rolled,
}

/// One frame, uploaded once, ready for as many dispatches as a job has outputs.
///
/// **Everything here is per photo-and-size; only the uniform is per rendition.** The frame
/// itself is the expensive part - 59MB at 3840 and 366MB at native resolution - and a job
/// naming an SDR and an HDR target of one size was uploading it, the lattice, the curves and
/// the matrix once each, then allocating a fresh output and readback pair, for every one of
/// them. What actually differs between two outputs of the same frame is `peak_nits` and
/// `output`, which are two words of a uniform.
pub struct Uploaded<'a> {
    gpu: &'a Gpu,
    width: usize,
    height: usize,
    samples: wgpu::Buffer,
    matrix: wgpu::Buffer,
    peak_out: wgpu::Buffer,
    histogram: wgpu::Buffer,
    candidates: wgpu::Buffer,
    curves: wgpu::TextureView,
    chroma: wgpu::TextureView,
    chroma_luma: wgpu::TextureView,
    chroma_tint: wgpu::TextureView,
    pyramid: wgpu::TextureView,
    counts: wgpu::Buffer,
    readback: wgpu::Buffer,
    /// The identity the uniform describes where a frame has no camera match, kept alive
    /// because `Grade::colour` borrows one or the other.
    identity: HdrColour,
    /// What the resources above were built from, so [`Uploaded::encode`] can refuse a grade
    /// that disagrees with them rather than dispatching against the wrong lattice.
    colour: Option<&'a HdrColour>,
}

impl Gpu {
    /// One `encode` dispatch: the graded frame as `u16` counts of PQ.
    ///
    /// The same entry point the editor's readback uses, so a rendition and a tick of the
    /// same photo are the same pixels by construction.
    ///
    /// For one output. A caller with several off one frame wants [`Gpu::upload`], which pays
    /// for the frame once.
    pub fn encode(&self, frame: &[u16], grade: &Grade<'_>) -> Vec<u16> {
        self.upload(frame, grade, &self.scene_peak()).encode(grade)
    }

    /// An unmeasured [`ScenePeak`], for a caller about to upload one photo's frames.
    pub fn scene_peak(&self) -> ScenePeak {
        ScenePeak {
            buffer: self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("peak_out"),
                size: 4 * 4,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            }),
            measured: std::cell::Cell::new(false),
        }
    }

    /// The frame itself, written straight into the buffer the GPU will read.
    ///
    /// **Mapped at creation rather than through `create_buffer_init`**, which takes `&[u8]` and
    /// so needed the whole frame re-materialised as bytes first - a second 366MB at 61MP, live
    /// alongside the decode it was copied from and the buffer it was copied into. This writes
    /// the little-endian pairs into the mapping directly, so there is one copy and no Vec.
    ///
    /// Padded to a whole number of words, since the shader indexes `array<u32>`: three `u16` a
    /// pixel means an odd sample count whenever both dimensions are odd. `mapped_at_creation`
    /// hands back zeroed memory, so the tail the `zip` does not reach is already zero.
    fn frame_buffer(&self, frame: &[u16]) -> wgpu::Buffer {
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("frame"),
            size: ((frame.len() as u64 * 2) + 3) & !3,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: true,
        });
        {
            let mut view =
                buffer.slice(..).get_mapped_range_mut().expect("a buffer mapped at creation");
            view.slice(..frame.len() * 2).write_iter(frame.iter().flat_map(|v| v.to_le_bytes()));
        }
        buffer.unmap();
        buffer
    }

    /// The frame and everything else a dispatch reads, uploaded once.
    pub fn upload<'a>(
        &'a self,
        frame: &[u16],
        grade: &Grade<'a>,
        peak: &ScenePeak,
    ) -> Uploaded<'a> {
        let device = &self.device;
        let pixels = grade.width * grade.height;
        assert!(
            self.fits(pixels),
            "a {}x{} frame needs a {}MiB storage binding and this adapter allows {}MiB - the \
             grade would have to be dispatched in bands, which it is not. Hardware adapters \
             report far more than any sensor needs, so this is a software one",
            grade.width,
            grade.height,
            Self::binding_bytes(pixels) / (1 << 20),
            self.device.limits().max_storage_buffer_binding_size / (1 << 20),
        );

        let buffer = |contents: &[u8], usage: wgpu::BufferUsages| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents,
                usage,
            })
        };
        let samples = self.frame_buffer(frame);
        // The caller's, so every size off one photograph rolls off against one measurement.
        // Only the matched arm reads it (`frame.wgsl`'s `rolled_off`); the neutral one
        // computes its own source peak from the levels in the uniform.
        let peak_out = peak.buffer.clone();
        let zeroed = |words: u64| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: words * 4,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            })
        };
        let histogram = zeroed(PEAK_BINS);
        // `quantile` reads `candidates[0]` to ask whether anything has been kept. Nothing
        // has - `collect` is the editor's, for a slider this never moves - so four words of
        // zeroes is the whole of what it needs.
        let candidates = zeroed(4);

        let identity = HdrColour::identity();
        let described = grade.colour.unwrap_or(&identity);
        let matrix: Vec<u8> =
            described.matrix.iter().flatten().flat_map(|v| (*v as f32).to_le_bytes()).collect();
        let matrix = buffer(&matrix, wgpu::BufferUsages::STORAGE);

        let (chroma, chroma_luma, chroma_tint) = self.lattice(described);
        let curves = self.curves(described);
        let pyramid = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("pyramid"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Uint,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        let out_bytes = Self::binding_bytes(pixels);
        let counts = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("counts"),
            size: out_bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: out_bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let view = |t: &wgpu::Texture| t.create_view(&wgpu::TextureViewDescriptor::default());
        let uploaded = Uploaded {
            gpu: self,
            width: grade.width,
            height: grade.height,
            samples,
            matrix,
            peak_out,
            histogram,
            candidates,
            curves: view(&curves),
            chroma: view(&chroma),
            chroma_luma: view(&chroma_luma),
            chroma_tint: view(&chroma_tint),
            pyramid: view(&pyramid),
            counts,
            readback,
            identity,
            colour: grade.colour,
        };
        // The largest size is uploaded first, so the one measurement is taken off the frame
        // with the most of the photograph in it.
        if grade.colour.is_some() && peak.claim() {
            uploaded.measure_peak(grade);
        }
        uploaded
    }

    /// The scene's own top end, in nits, off the same two passes the editor measures it with.
    ///
    /// The lattice, split the way `tick_pipeline.ts` splits it: the 2x2 in one volume, and
    /// the lightness gain's *deviation from 1* in another.
    ///
    /// Two volumes because four values fill an `rgba16float` texel and five do not, and the
    /// deviation because half floats spend a fixed relative precision wherever the value
    /// sits: storing 1.02 puts it all on the 1. The 2x2 multiplies chroma differences and
    /// survives that; a gain multiplies luma and does not.
    pub fn lattice(&self, colour: &HdrColour) -> (wgpu::Texture, wgpu::Texture, wgpu::Texture) {
        let identity = hdr_fit::ChromaMap::identity();
        let map = colour.chroma.as_ref().unwrap_or(&identity);
        let shape = map.shape();
        let nodes = map.nodes_flat();
        let count = nodes.len() / hdr_fit::NODE_VALUES;
        let (mut pairs, mut gains, mut tints) = (Vec::new(), Vec::new(), Vec::new());
        for node in 0..count {
            let at = node * hdr_fit::NODE_VALUES;
            for k in 0..4 {
                pairs.extend_from_slice(&half(nodes[at + k] as f32));
            }
            // The second volume carries the two luma-to-chroma terms, the lightness gain's
            // deviation from 1, and the first of the two chroma-to-lightness terms.
            gains.extend_from_slice(&half(nodes[at + 4] as f32));
            gains.extend_from_slice(&half(nodes[at + 5] as f32));
            gains.extend_from_slice(&half(nodes[at + 6] as f32 - 1.0));
            gains.extend_from_slice(&half(nodes[at + 7] as f32));
            // Nine values need a third volume: eight fill two `rgba16float` texels exactly,
            // and the ninth has nowhere else to sit. Three of its four slots are spare, which
            // is the price of the chroma-to-lightness pair - a texel of padding per node
            // against a small saturated object otherwise coming out at its surroundings'
            // lightness.
            tints.extend_from_slice(&half(nodes[at + 8] as f32));
            for _ in 0..3 {
                tints.extend_from_slice(&half(0.0));
            }
        }
        let size = wgpu::Extent3d {
            width: shape.chroma_count as u32,
            height: shape.chroma_count as u32,
            depth_or_array_layers: shape.level_count as u32,
        };
        (
            self.volume(size, &pairs, "chroma"),
            self.volume(size, &gains, "chroma_luma"),
            self.volume(size, &tints, "chroma_tint"),
        )
    }

    fn volume(&self, size: wgpu::Extent3d, data: &[u8], label: &str) -> wgpu::Texture {
        self.device.create_texture_with_data(
            &self.queue,
            &wgpu::TextureDescriptor {
                label: Some(label),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D3,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            data,
        )
    }

    pub fn curves(&self, colour: &HdrColour) -> wgpu::Texture {
        let data: Vec<u8> = (0..3)
            .flat_map(|c| colour.curves[c].iter().map(|v| (*v as f32).to_le_bytes()))
            .flatten()
            .collect();
        self.device.create_texture_with_data(
            &self.queue,
            &wgpu::TextureDescriptor {
                label: Some("curves"),
                size: wgpu::Extent3d {
                    width: colour.curves[0].len() as u32,
                    height: 3,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R32Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &data,
        )
    }

    pub fn sampler(&self) -> &wgpu::Sampler {
        &self.sampler
    }

    pub fn layout(&self) -> &wgpu::BindGroupLayout {
        &self.layout
    }
}

impl Uploaded<'_> {
    /// The scene's own top end, written into `peak_out` for the dispatches that follow.
    ///
    /// **Off the frame that is already up, sampled the way the editor samples it.** Both
    /// hosts run these two passes; they used to disagree about what they ran them over. This
    /// side gathered a proportional scatter of the *unwarped, unsharpened* base on the CPU
    /// and uploaded it as a strip, where the editor reads whole rows of the frame it hands
    /// the shader. Same estimator over a different million pixels, so a thin specular one
    /// sampling caught and the other stepped over moved `scene_peak` and with it where the
    /// roll-off knee landed - and the parity fixtures could not see it, both degenerating to
    /// the plain maximum at 6144 pixels.
    ///
    /// Reading the uploaded frame is also strictly less work than the strip was: no gather,
    /// no second upload, and no readback, since `encode` reads `peak_out` on the GPU rather
    /// than being handed a number.
    ///
    /// Once per upload rather than once per rendition: it is a property of the photograph,
    /// and every output off this frame rolls off against the same one.
    fn measure_peak(&self, grade: &Grade<'_>) {
        let device = &self.gpu.device;
        let described = grade.colour.unwrap_or(&self.identity);
        let tick = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("peak"),
            contents: &uniform(grade, described),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("peak"),
            layout: &self.gpu.peak_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: tick.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.samples.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&self.curves),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&self.chroma),
                },
                wgpu::BindGroupEntry { binding: 4, resource: self.matrix.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: self.histogram.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: self.peak_out.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&self.gpu.sampler),
                },
                wgpu::BindGroupEntry { binding: 8, resource: self.candidates.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 10,
                    resource: wgpu::BindingResource::TextureView(&self.chroma_luma),
                },
                wgpu::BindGroupEntry {
                    binding: 11,
                    resource: wgpu::BindingResource::TextureView(&self.chroma_tint),
                },
                wgpu::BindGroupEntry {
                    binding: 12,
                    resource: self.gpu.nits_of_code.as_entire_binding(),
                },
            ],
        });

        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_bind_group(0, &group, &[]);
            pass.set_pipeline(&self.gpu.peak_measure);
            let (_, rows) = sampled_rows(self.width, self.height);
            pass.dispatch_workgroups((self.width as u32).div_ceil(64), rows, 1);
            // One workgroup: the search is over bins, not pixels.
            pass.set_pipeline(&self.gpu.peak_quantile);
            pass.dispatch_workgroups(1, 1, 1);
        }
        // Submitted rather than waited on. `encode` reads `peak_out` on the GPU, and wgpu
        // orders one submission against the next, so there is nothing to read back.
        self.gpu.queue.submit([encoder.finish()]);
    }

    /// One rendition: a new uniform, a dispatch, a readback. Everything else was paid for
    /// when the frame went up.
    ///
    /// Only `peak_nits` and `output` may differ from the upload's grade. The rest of it was
    /// baked into resources at that point - the frame, the matrix, the lattice, the curves and
    /// the `peak_out` those were measured through - while the *uniform* is rebuilt here from
    /// whatever arrives, so a `grade` disagreeing about the colour would describe textures
    /// that are not bound. Asserted rather than trusted: it is silent, and it shifts every
    /// pixel.
    pub fn encode(&self, grade: &Grade<'_>) -> Vec<u16> {
        assert_eq!(
            (grade.width, grade.height),
            (self.width, self.height),
            "the uniform describes a different frame than the one uploaded",
        );
        assert!(
            match (grade.colour, self.colour) {
                (None, None) => true,
                (Some(a), Some(b)) => std::ptr::eq(a, b),
                _ => false,
            },
            "the lattice and the curves bound here are the ones this frame went up with",
        );
        let device = &self.gpu.device;
        let described = grade.colour.unwrap_or(&self.identity);
        let tick = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("tick"),
            contents: &uniform(grade, described),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("encode"),
            layout: &self.gpu.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: tick.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.samples.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&self.curves),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&self.chroma),
                },
                wgpu::BindGroupEntry { binding: 4, resource: self.matrix.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: self.peak_out.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: self.counts.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&self.gpu.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 9,
                    resource: wgpu::BindingResource::TextureView(&self.pyramid),
                },
                wgpu::BindGroupEntry {
                    binding: 10,
                    resource: wgpu::BindingResource::TextureView(&self.chroma_luma),
                },
                wgpu::BindGroupEntry {
                    binding: 11,
                    resource: wgpu::BindingResource::TextureView(&self.chroma_tint),
                },
                wgpu::BindGroupEntry {
                    binding: 12,
                    resource: self.gpu.nits_of_code.as_entire_binding(),
                },
            ],
        });

        let out_bytes = Gpu::binding_bytes(self.width * self.height);
        let pixels = self.width * self.height;
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let (x, y) = self.gpu.encode_groups(pixels);
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.gpu.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(x, y, 1);
        }
        encoder.copy_buffer_to_buffer(&self.counts, 0, &self.readback, 0, out_bytes);
        self.gpu.queue.submit([encoder.finish()]);

        let slice = self.readback.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        self.gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("the dispatch finished");
        let out: Vec<u16> = {
            let mapped = slice.get_mapped_range().expect("the readback mapped");
            // Two components a word, and the odd pixel's padding dropped by taking only what
            // the frame has.
            let mut out = Vec::with_capacity(pixels * 3);
            for word in mapped.chunks_exact(4) {
                out.push(u16::from_le_bytes([word[0], word[1]]));
                out.push(u16::from_le_bytes([word[2], word[3]]));
            }
            out.truncate(pixels * 3);
            out
        };
        // Unmapped before the next rendition maps it again; a second `map_async` on a buffer
        // still mapped is a validation error, and `on_uncaptured_error` makes those fatal.
        self.readback.unmap();
        out
    }
}

/// `TICK_UNIFORM_FLOATS` in `shaders.ts`, field for field in `struct Tick`'s order.
///
/// Flat rather than a builder so it can be read against the struct. The one subtlety is
/// the unnamed word before `region_origin`: WGSL puts a `vec2f` on a multiple of eight and
/// the scalars end on 92, so without it every field after lands short and the binding is
/// rejected four bytes small.
fn uniform(grade: &Grade<'_>, colour: &HdrColour) -> Vec<u8> {
    let shape = colour.chroma.as_ref().map(|m| m.shape());
    let shape = shape.as_ref();
    let mut w: Vec<u32> = Vec::new();
    let f = |w: &mut Vec<u32>, v: f64| w.push((v as f32).to_bits());
    w.push(grade.width as u32);
    w.push(grade.height as u32);
    f(&mut w, grade.white);
    f(&mut w, grade.source_level);
    f(&mut w, grade.reference_nits);
    f(&mut w, grade.peak_nits);
    f(&mut w, grade.exposure);
    w.push(match grade.output {
        Output::Pq => 0,
        Output::Srgb => 1,
        Output::Rolled => 2,
    });
    w.push(u32::from(grade.colour.is_some()));
    f(&mut w, colour.saturation);
    w.push(u32::from(grade.colour.is_some() && colour.chroma.is_some()));
    w.push(colour.curves[0].len() as u32);
    f(&mut w, hdr_fit::TRUST_CEILING);
    w.push(shape.map_or(2, |s| s.chroma_count as u32));
    w.push(shape.map_or(2, |s| s.level_count as u32));
    f(&mut w, shape.map_or(0.0, |s| s.chroma_low[0]));
    f(&mut w, shape.map_or(1.0, |s| s.chroma_scale[0]));
    f(&mut w, shape.map_or(0.0, |s| s.chroma_low[1]));
    f(&mut w, shape.map_or(1.0, |s| s.chroma_scale[1]));
    f(&mut w, shape.map_or(1.0, |s| s.level_scale));
    f(&mut w, 203.0); // sdr_white
    let (stride, rows) = sampled_rows(grade.width, grade.height);
    w.push(stride); // row_stride
    w.push(grade.width as u32 * rows); // peak_samples
    w.push(0); // the alignment word before `region_origin`
    for _ in 0..6 {
        f(&mut w, 0.0); // region_origin, region_size, canvas_size
    }
    w.push(0); // max_lod
    w.push(0); // pad
    w.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// An `f32` as the `f16` bits a texture holds.
fn half(v: f32) -> [u8; 2] {
    half::f16::from_f32(v).to_bits().to_le_bytes()
}

#[cfg(test)]
mod tests {
    /// The shader's own sizes, against the buffers this host allocates for them.
    ///
    /// **A histogram longer than its buffer is a dropped dispatch, not an error.** WGSL bounds
    /// an out-of-range store rather than failing it, so raising `BINS` in `peak.wgsl` without
    /// raising [`super::PEAK_BINS`] would silently discard every sample past the eighth
    /// thousand bin while `quantile` still divides by the full count - every rendition's scene
    /// peak low, the roll-off knee in the wrong place, and nothing said anywhere. The client
    /// pins its own copy in `gpu/tests/peak_constants.test.ts`; this is the same guard for the
    /// host that got a second copy when the grade moved here.
    #[test]
    fn the_shader_sizes_match_the_buffers_allocated_for_them() {
        let declared = |source: &str, name: &str| -> u64 {
            let at = source
                .find(&format!("const {name}"))
                .unwrap_or_else(|| panic!("{name} is declared"));
            let line = &source[at..][..source[at..].find(';').expect("it is terminated")];
            let digits: String =
                line.rsplit('=').next().expect("it is assigned").matches(char::is_numeric).collect();
            digits.parse().unwrap_or_else(|_| panic!("{name} reads `{line}`"))
        };
        assert_eq!(
            declared(super::PEAK_WGSL, "BINS: u32"),
            super::PEAK_BINS,
            "peak.wgsl's BINS and gpu.rs's PEAK_BINS have drifted",
        );
        // `decode.wgsl` writes one entry per code and guards on the last one, so it carries the
        // count as `65535` - the top code rather than the length.
        let source = include_str!("../../../web/src/features/raw_edit/gpu/wgsl/decode.wgsl");
        let top: u64 = source
            .split("id.x > ")
            .nth(1)
            .and_then(|rest| rest.split('u').next())
            .and_then(|digits| digits.parse().ok())
            .expect("decode.wgsl bounds its entry point");
        assert_eq!(
            top + 1,
            super::PQ_CODES,
            "decode.wgsl fills {} entries and gpu.rs allocates {}",
            top + 1,
            super::PQ_CODES,
        );
    }

    /// `R2020_TO_SRGB` in `frame.wgsl` against the matrix this crate derives.
    ///
    /// The shader has to carry it as a literal - it must stay valid WGSL on its own - and a
    /// literal is a copy. This is the pattern the rest of the shared numbers use: written
    /// out there, pinned here, so the two cannot drift without a test saying so. Parsed out
    /// of the source rather than duplicated a third time in the test.
    #[test]
    fn the_srgb_primaries_match_the_host() {
        let source = include_str!("../../../web/src/features/raw_edit/gpu/wgsl/frame.wgsl");
        let start = source.find("const R2020_TO_SRGB").expect("the constant is there");
        let body = &source[start..source[start..].find(");").expect("it is closed") + start];
        let found: Vec<f64> = body
            .split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
            .filter(|s| s.contains('.'))
            .filter_map(|s| s.parse().ok())
            .collect();
        assert_eq!(found.len(), 9, "parsed {found:?} out of {body}");

        // `mat3x3f` takes columns, so the shader's order is the transpose of the crate's.
        let want = crate::hdr_fit::rec2020_to_srgb();
        let columns: Vec<String> = (0..3)
            .map(|col| {
                let v: Vec<String> =
                    (0..3).map(|row| format!("{:>10.6}", want[row][col])).collect();
                format!("  vec3f({}),", v.join(", "))
            })
            .collect();
        let worst = (0..9)
            .map(|i| (found[i] - want[i % 3][i / 3]).abs())
            .fold(0.0f64, f64::max);
        assert!(
            worst < 5e-6,
            "R2020_TO_SRGB is {worst:.6} out of step with the host's. It should read:\n\
             const R2020_TO_SRGB = mat3x3f(\n{}\n);",
            columns.join("\n"),
        );
    }
}
