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
        "{}\n{}\n{}\n{}\n{}\n{last}",
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/prelude.wgsl"),
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/edit.wgsl"),
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/adjust.wgsl"),
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/colour.wgsl"),
        GEOMETRY_WGSL,
    )
}

/// The crop, straighten and turn as a coordinate mapping. Composed into `FRAME` on both hosts,
/// and into the probe that holds it against [`crate::image::geometry_at`].
pub(crate) const GEOMETRY_WGSL: &str =
    include_str!("../../../web/src/features/raw_edit/gpu/wgsl/geometry.wgsl");

const FRAME_WGSL: &str = include_str!("../../../web/src/features/raw_edit/gpu/wgsl/frame.wgsl");
const PEAK_WGSL: &str = include_str!("../../../web/src/features/raw_edit/gpu/wgsl/peak.wgsl");
const DETAIL_WGSL: &str = include_str!("../../../web/src/features/raw_edit/gpu/wgsl/detail.wgsl");

/// `DETAIL` in `shaders.ts`: the blur the presence sliders read, on layouts of its own.
fn detail_source() -> String {
    format!(
        "{}\n{}\n{DETAIL_WGSL}",
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/prelude.wgsl"),
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/edit.wgsl"),
    )
}

/// `DETAIL_LONG` in `detail.wgsl`, which is the long edge of that blur's working texture.
///
/// The shader declares it and this allocates for it, so the two are pinned together by
/// `the_shader_sizes_match_the_buffers_allocated_for_them`.
const DETAIL_LONG: u32 = 512;

/// The working texture for a frame of this size: the long edge capped, never scaled up.
///
/// The only place this is decided. The editor is told the answer on `PreparedHeader`, because
/// how large a share of the picture each blur covers follows from it - two hosts rounding it
/// differently would apply two different clarities and both would look like photographs.
pub fn detail_size(width: usize, height: usize) -> DetailSize {
    let long = width.max(height).max(1) as f64;
    let scale = (f64::from(DETAIL_LONG) / long).min(1.0);
    DetailSize {
        width: ((width as f64 * scale).round() as u32).max(1),
        height: ((height as f64 * scale).round() as u32).max(1),
    }
}

/// The blur's working texture, named so it can travel to the editor as one.
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailSize {
    pub width: u32,
    pub height: u32,
}

/// `DECODE` in `shaders.ts`: the frame's coding undone, and nothing of `colour.wgsl` because
/// it binds the same table read-only.
fn decode_source() -> String {
    format!(
        "{}\n{}",
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/prelude.wgsl"),
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/decode.wgsl"),
    )
}

/// `BALANCE` in `shaders.ts`: the reader's temperature and tint solved into one matrix.
fn balance_source() -> String {
    format!(
        "{}\n{}\n{}",
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/prelude.wgsl"),
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/edit.wgsl"),
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/white_balance.wgsl"),
    )
}

/// Floats that pass writes: three rows of four, the fourth of each unread.
const BALANCE_FLOATS: u64 = 12;

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
/// `EditPipeline`'s `rowStride` and `sampledGroups`, arrived at the same way, because the two
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
    /// What answered, for the one line the entrypoint prints at boot.
    ///
    /// Kept because *which* adapter answered is a deployment fault nothing else reports. The
    /// image carries lavapipe, so a container that cannot reach the host's card does not fail
    /// - it renders on a CPU rasteriser, correctly, at a fraction of the speed, and the only
    /// evidence is that everything is slow. Measured in a container: with `devices:` and
    /// `group_add:` this reads `RADV RAPHAEL_MENDOCINO`, and dropping `group_add` alone makes
    /// the same container read `llvmpipe`. Naming it at boot is what tells a misconfigured
    /// deployment from a machine that genuinely has no GPU.
    pub adapter: String,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
    peak_layout: wgpu::BindGroupLayout,
    peak_measure: wgpu::ComputePipeline,
    peak_quantile: wgpu::ComputePipeline,
    detail_shrink_layout: wgpu::BindGroupLayout,
    detail_blur_layout: wgpu::BindGroupLayout,
    detail_shrink: wgpu::ComputePipeline,
    detail_blur_x: wgpu::ComputePipeline,
    detail_blur_y: wgpu::ComputePipeline,
    balance_layout: wgpu::BindGroupLayout,
    balance_pipeline: wgpu::ComputePipeline,
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
            label: Some("edit"),
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
        let detail_shrink_layout = group_layout("detail shrink", &DETAIL_SHRINK_BINDINGS);
        let detail_blur_layout = group_layout("detail blur", &DETAIL_BLUR_BINDINGS);
        let detail_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("detail"),
            source: wgpu::ShaderSource::Wgsl(detail_source().into()),
        });
        let detail_shrink = compute("shrink", &detail_module, &detail_shrink_layout, "shrink");
        let detail_blur_x = compute("blur_x", &detail_module, &detail_blur_layout, "blur_x");
        let detail_blur_y = compute("blur_y", &detail_module, &detail_blur_layout, "blur_y");

        let balance_layout = group_layout("balance", &BALANCE_BINDINGS);
        let balance_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("balance"),
            source: wgpu::ShaderSource::Wgsl(balance_source().into()),
        });
        let balance_pipeline =
            compute("balance", &balance_module, &balance_layout, "balance");

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
            adapter: {
                let info = adapter.get_info();
                format!("{} ({:?}, {:?})", info.name, info.backend, info.device_type)
            },
            device,
            queue,
            layout,
            pipeline,
            peak_layout,
            peak_measure,
            peak_quantile,
            detail_shrink_layout,
            detail_blur_layout,
            detail_shrink,
            detail_blur_x,
            detail_blur_y,
            balance_layout,
            balance_pipeline,
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
const ENCODE_BINDINGS: [(u32, Binding); 14] = [
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
    (13, Binding::Detail),
    (14, Binding::Storage { read_only: true }),
];

/// `white_balance.wgsl`, which writes the matrix everything above reads.
const BALANCE_BINDINGS: [(u32, Binding); 2] =
    [(0, Binding::Uniform), (14, Binding::Storage { read_only: false })];

/// `detail.wgsl`'s two entry-point shapes, on layouts of their own: the downscale reads the
/// frame and the decode table, and the separable pair reads only the texture before it.
const DETAIL_SHRINK_BINDINGS: [(u32, Binding); 4] = [
    (0, Binding::Uniform),
    (1, Binding::Storage { read_only: true }),
    (3, Binding::Written),
    (12, Binding::Storage { read_only: true }),
];

const DETAIL_BLUR_BINDINGS: [(u32, Binding); 2] = [(2, Binding::Detail), (3, Binding::Written)];

/// `peakLayout` on the client: the same colour bindings, and the histogram, the peak and the
/// candidates all writable where the encode reads the peak and writes only the frame.
const PEAK_BINDINGS: [(u32, Binding); 14] = [
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
    (13, Binding::Detail),
    (14, Binding::Storage { read_only: true }),
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
    /// `detail.wgsl`'s output: the fine blur, the coarse blur and the dark channel, all in
    /// stops. Filterable, because the grade samples it at a frame coordinate rather than a
    /// texel of it.
    Detail,
    /// The same texture where a pass is writing it.
    Written,
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
            Binding::Detail => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            Binding::Written => wgpu::BindingType::StorageTexture {
                access: wgpu::StorageTextureAccess::WriteOnly,
                format: wgpu::TextureFormat::Rgba16Float,
                view_dimension: wgpu::TextureViewDimension::D2,
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
    /// The reader's own sliders, on Camera Raw's -100..100 scales. All zero is unedited.
    pub adjust: Adjust,
    /// The illuminant the camera balanced this frame for, which is the baseline the reader's
    /// temperature and tint move away from. None where the file recorded no usable
    /// multipliers, in which case there is nothing to move relative to and the pair is ignored.
    pub as_shot: Option<crate::white_balance::AsShot>,
    /// Which transfer to write. The grade is the same either way; an SDR target differs by
    /// having its `peak_nits` at diffuse white (`job::peak_nits`) and by ending here.
    pub output: Output,
}

/// Every slider but the exposure, as `adjust.wgsl` reads them.
///
/// Its own type rather than ten fields on [`Grade`] because they travel together from the
/// stored document all the way to the uniform, and a caller that has none of them says so
/// once with [`Adjust::none`] rather than ten times.
///
/// The last three are the presence group, which read the blur `detail.wgsl` builds rather
/// than the pixel alone. They are terms in the same function as the rest - what the blur
/// costs is a pass at upload, not a second grade.
#[derive(Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Adjust {
    pub contrast: f64,
    pub highlights: f64,
    pub shadows: f64,
    pub whites: f64,
    pub blacks: f64,
    pub vibrance: f64,
    /// `sat_adjust` in the shader: `saturation` there is the camera match's own multiplier.
    pub saturation: f64,
    /// `texture_adjust` in the shader, where a member called `texture` would read as a type.
    pub texture: f64,
    pub clarity: f64,
    pub dehaze: f64,
    /// The illuminant the reader asked for, or None for the one the camera chose.
    ///
    /// None rather than the as-shot numbers because the *document* stores null there, and it
    /// has to: an edit that recorded 5500K would mean a different picture on a frame whose
    /// camera metered 3200, where "as shot" means the same thing on every one.
    pub temperature: Option<f64>,
    pub tint: Option<f64>,
}

impl Adjust {
    /// The picture as the camera rendered it, which is what an unedited photo asks for.
    pub fn none() -> Self {
        Self::default()
    }
}

/// `edit.output` in the shader, whose values these must match.
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
    /// The blur the presence sliders read, built off this frame at this size.
    detail: wgpu::TextureView,
    /// The reader's temperature and tint, solved once for this photograph.
    balance: wgpu::Buffer,
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

        // Before the peak is measured, which grades through the whole colour transform: a
        // balance written after it would place the roll-off knee for a colour nobody sees.
        let balance = self.build_balance(&uniform(grade, described));
        let detail = self.build_detail(
            &samples,
            &uniform(grade, described),
            detail_size(grade.width, grade.height),
        );

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
            detail,
            balance,
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
    /// The lattice, split the way `edit_pipeline.ts` splits it: the 2x2 in one volume, and
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

    /// The reader's temperature and tint, solved into the matrix the grade reads.
    ///
    /// Once per uploaded frame, where the editor does it per tick: a rendition's pair comes off
    /// a stored document and cannot move between the outputs of one photograph.
    ///
    /// The search itself is `white_balance.wgsl` rather than this file, and that is the point
    /// of the pass - both hosts need the same answer on every frame they grade, and two
    /// Robertson searches disagreeing by a few Kelvin would render as a picture rather than as
    /// an error.
    fn build_balance(&self, edits: &[u8]) -> wgpu::Buffer {
        let device = &self.device;
        let balance = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("balance"),
            size: BALANCE_FLOATS * 4,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let edits = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("balance"),
            contents: edits,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("balance"),
            layout: &self.balance_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 14, resource: balance.as_entire_binding() },
            ],
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.balance_pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        self.queue.submit([encoder.finish()]);
        balance
    }

    /// The blur the presence sliders read, off the frame that is already up (`detail.wgsl`).
    ///
    /// Once per uploaded frame, like the scene peak beside it and for the same reason: it
    /// describes the photograph rather than the rendition, so every output off this frame has
    /// to read the same one. Unconditional, rather than skipped when the three sliders are
    /// zero - it is one read of the frame and two Gaussians over a 512px texture against a job
    /// that spends seconds in the decode and the encoder, and a resource that sometimes exists
    /// is a bind group that sometimes does.
    ///
    /// Three passes rather than one with three dispatches: the middle two read the texture the
    /// one before them wrote, and a pass is where wgpu puts the barrier for that.
    fn build_detail(
        &self,
        samples: &wgpu::Buffer,
        edits: &[u8],
        size: DetailSize,
    ) -> wgpu::TextureView {
        let device = &self.device;
        let texture = |label: &str| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: size.width,
                    height: size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::STORAGE_BINDING,
                view_formats: &[],
            })
        };
        let view = |t: &wgpu::Texture| t.create_view(&wgpu::TextureViewDescriptor::default());
        // Ping-ponged, and the pass count is odd, so the result lands back in `detail`.
        let detail = view(&texture("detail"));
        let scratch = view(&texture("detail scratch"));

        let edits = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("detail"),
            contents: edits,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let shrink = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("detail shrink"),
            layout: &self.detail_shrink_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: samples.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&detail),
                },
                wgpu::BindGroupEntry {
                    binding: 12,
                    resource: self.nits_of_code.as_entire_binding(),
                },
            ],
        });
        let blur = |from: &wgpu::TextureView, to: &wgpu::TextureView| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("detail blur"),
                layout: &self.detail_blur_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(from),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(to),
                    },
                ],
            })
        };

        let mut encoder = device.create_command_encoder(&Default::default());
        for (pipeline, group) in [
            (&self.detail_shrink, &shrink),
            (&self.detail_blur_x, &blur(&detail, &scratch)),
            (&self.detail_blur_y, &blur(&scratch, &detail)),
        ] {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(size.width.div_ceil(8), size.height.div_ceil(8), 1);
        }
        self.queue.submit([encoder.finish()]);
        detail
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
        let edits = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("peak"),
            contents: &uniform(grade, described),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("peak"),
            layout: &self.gpu.peak_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
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
                wgpu::BindGroupEntry {
                    binding: 13,
                    resource: wgpu::BindingResource::TextureView(&self.detail),
                },
                wgpu::BindGroupEntry { binding: 14, resource: self.balance.as_entire_binding() },
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
        let edits = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("edit"),
            contents: &uniform(grade, described),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("encode"),
            layout: &self.gpu.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
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
                wgpu::BindGroupEntry {
                    binding: 13,
                    resource: wgpu::BindingResource::TextureView(&self.detail),
                },
                wgpu::BindGroupEntry { binding: 14, resource: self.balance.as_entire_binding() },
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

/// `struct Edit`'s fields, in the order [`uniform`] writes them.
///
/// The Rust twin of `EDIT_LAYOUT` in `shaders.ts`, and here for the same reason that one
/// exists: the writer below is two dozen pushes into a flat buffer, and nothing about a
/// push says which field it is. Swapping two of them leaves every suite green and grades
/// the picture with one number where another belongs.
///
/// `the_uniform_matches_the_shader_struct` parses the struct out of the `.wgsl` and holds
/// this against it, so the shader stays the source of truth and this stays honest about it.
#[cfg(test)]
const EDIT_FIELDS: &[&str] = &[
    "width",
    "height",
    "white",
    "source_level",
    "reference",
    "peak",
    "exposure",
    "output",
    "matched",
    "saturation",
    "has_chroma",
    "curve_bins",
    "trust_ceiling",
    "chroma_count",
    "level_count",
    "chroma_low",
    "chroma_scale",
    "chroma_low_by",
    "chroma_scale_by",
    "level_scale",
    "sdr_white",
    "row_stride",
    "peak_samples",
    "region_origin",
    "region_size",
    "canvas_size",
    "max_lod",
    "pad",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "vibrance",
    "sat_adjust",
    "texture_adjust",
    "clarity",
    "dehaze",
    "as_shot_temperature",
    "as_shot_tint",
    "temperature",
    "tint",
    "balance_set",
    "crop_left",
    "crop_top",
    "crop_right",
    "crop_bottom",
    "crop_angle",
    "rotate",
    "output_width",
    "output_height",
    "keystone_0",
    "keystone_1",
    "keystone_2",
    "keystone_3",
    "keystone_4",
    "keystone_5",
    "keystone_6",
    "keystone_7",
    "has_keystone",
];

/// `EDIT_UNIFORM_FLOATS` in `shaders.ts`, field for field in `struct Edit`'s order.
///
/// Flat rather than a builder so it can be read against the struct. The one subtlety is
/// the unnamed word before `region_origin`: WGSL puts a `vec2f` on a multiple of eight and
/// the scalars end on 92, so without it every field after lands short and the binding is
/// rejected four bytes small.
fn uniform(grade: &Grade<'_>, colour: &HdrColour) -> Vec<u8> {
    uniform_words(grade, colour).iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// The same words, before they are bytes, so the editor can be handed them.
///
/// **This is the only thing that builds a `Edit`.** The client used to build its own from the
/// payload - re-deriving `curve_bins` from the curve it was sent, the seven lattice shape
/// fields from the chroma map, `trust_ceiling`, `sdr_white`, and the peak's sampling stride -
/// which is twenty-two words of one frame described twice in two languages. The shaders were
/// always one implementation; what was two was the thing that filled them, and a mismatch there
/// is a photograph graded with one number where another belongs, on a path no test crossed.
///
/// So the frame's own words are built here, once, and travel on `edit::PreparedHeader`. What
/// the editor still writes is only what the *reader* owns and this side cannot know: the exposure,
/// the sliders, the region on screen and the canvas showing it.
pub fn uniform_words(grade: &Grade<'_>, colour: &HdrColour) -> Vec<u32> {
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
    // sdr_white: BT.2408 reference white, and the divisor an extended-range canvas needs.
    //
    // Measured rather than assumed (`docs/raw-edit-gpu.md` §7.1): swept against a real PQ AVIF
    // of the same pixels, Chrome and Safari both match at 203. It is the *browser's* constant
    // rather than `reference_nits`, which a library is free to move - which is why it is a
    // literal here and not read off the grade, and why it lived on the client until the client
    // stopped building its own uniform.
    f(&mut w, 203.0);
    let (stride, rows) = sampled_rows(grade.width, grade.height);
    w.push(stride); // row_stride
    w.push(grade.width as u32 * rows); // peak_samples
    w.push(0); // the alignment word before `region_origin`
    for _ in 0..6 {
        f(&mut w, 0.0); // region_origin, region_size, canvas_size
    }
    w.push(0); // max_lod
    w.push(0); // pad
    // The reader's sliders, in `struct Edit`'s order. Appended after `pad` there, so nothing
    // above this line moved when they were added.
    f(&mut w, grade.adjust.contrast);
    f(&mut w, grade.adjust.highlights);
    f(&mut w, grade.adjust.shadows);
    f(&mut w, grade.adjust.whites);
    f(&mut w, grade.adjust.blacks);
    f(&mut w, grade.adjust.vibrance);
    f(&mut w, grade.adjust.saturation);
    f(&mut w, grade.adjust.texture);
    f(&mut w, grade.adjust.clarity);
    f(&mut w, grade.adjust.dehaze);
    // The frame's illuminant, then the document's, copied rather than resolved against each
    // other: `white_balance.wgsl` is where a null half becomes the frame's own, so that rule
    // has one implementation instead of one per host. Zero as-shot means the camera recorded
    // no usable multipliers, and the shader leaves the balance alone.
    f(&mut w, grade.as_shot.map_or(0.0, |s| s.temperature));
    f(&mut w, grade.as_shot.map_or(0.0, |s| s.tint));
    f(&mut w, grade.adjust.temperature.unwrap_or(0.0));
    f(&mut w, grade.adjust.tint.unwrap_or(0.0));
    w.push(
        u32::from(grade.adjust.temperature.is_some())
            | (u32::from(grade.adjust.tint.is_some()) << 1),
    );
    // The geometry, always the identity here, and that is not an omission. A rendition's crop
    // is applied in `image::PlanarWarp`'s gather - one pass rather than a warp and then a
    // copy - so the frame this shader is handed is *already* cropped and turned, and applying
    // it a second time would crop the crop. What the field is for is the editor, whose frame
    // is the whole one: it patches these and sees what a rendition will produce without one
    // being built. `frame.wgsl`'s `geometry_at` is the identity on these values.
    for value in [0.0, 0.0, 1.0, 1.0, 0.0] {
        f(&mut w, value);
    }
    w.push(0); // rotate
    w.push(grade.width as u32);
    w.push(grade.height as u32);
    // The keystone, identity here for the reason above: the gather already applied it.
    for _ in 0..8 {
        f(&mut w, 0.0);
    }
    w.push(0); // has_keystone
    // WGSL rounds a uniform struct's size up to a multiple of 16 bytes, and binds it at that
    // size - so a buffer holding exactly the fields is rejected as too small, by however much
    // the last few fields left over. `shaders.ts` does this in `editOffsets`; here it was
    // implicit in the field count until a field was added, and then it was four bytes short.
    // Stated as the rule rather than as a spare word, so the next field cannot break it.
    while w.len() % 4 != 0 {
        w.push(0);
    }
    w
}

/// An `f32` as the `f16` bits a texture holds.
fn half(v: f32) -> [u8; 2] {
    half::f16::from_f32(v).to_bits().to_le_bytes()
}

#[cfg(test)]
mod tests {
    use wgpu::util::DeviceExt;

    /// Which word a `Edit` field starts at, under WGSL's uniform rules.
    ///
    /// `editOffsets` on the client, arrived at the same way: everything is a word except the
    /// three `vec2f`, which take two and start on an even one. Written here rather than
    /// counted by hand because the field *index* is not the word offset - three vec2f and the
    /// alignment they force put the tail eight words along from where a naive count says, which
    /// is exactly the mistake this test made first and caught itself on.
    fn field_offset(name: &str) -> usize {
        let mut next = 0usize;
        for field in super::EDIT_FIELDS {
            let pair = field.starts_with("region_") || *field == "canvas_size";
            if pair {
                next = next.div_ceil(2) * 2;
            }
            if *field == name {
                return next;
            }
            next += if pair { 2 } else { 1 };
        }
        panic!("struct Edit has no {name}");
    }

    /// A `Geometry`, positionally, so a table of cases reads as a table.
    fn geometry(
        crop: [f64; 4],
        angle_degrees: f64,
        rotate: u16,
        keystone: Option<[f64; 8]>,
    ) -> crate::image::Geometry {
        crate::image::Geometry { crop, angle_degrees, rotate, keystone }
    }

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
        // Not a buffer size but the same failure: this one sets how large a share of the
        // picture a blur covers, so a host allocating a different texture blurs at a different
        // scale and the rendition stops matching the editor. Silent - both pictures look like
        // pictures.
        assert_eq!(
            declared(super::DETAIL_WGSL, "DETAIL_LONG: u32"),
            u64::from(super::DETAIL_LONG),
            "detail.wgsl's DETAIL_LONG and gpu.rs's have drifted",
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

    /// `struct Edit` in the shader against the order and the size this host writes.
    ///
    /// Two failures, both silent without this. A field inserted anywhere but the tail
    /// shifts every field after it, so the grade reads the exposure out of `peak` and the
    /// picture is wrong in a way no validation catches. And a field *appended* leaves the
    /// buffer short of the 16-byte multiple WGSL binds the struct at, which wgpu does
    /// catch - but as "bound with size 156 where the shader expects 160", at the dispatch,
    /// which is a long way from the line that added the field.
    ///
    /// The client pins the same thing in `gpu/tests/edit_uniform.test.ts`. Two hosts, two
    /// pins, one shader that is the source of truth for both.
    #[test]
    fn the_uniform_matches_the_shader_struct() {
        let source = include_str!("../../../web/src/features/raw_edit/gpu/wgsl/edit.wgsl");
        let body = source
            .split_once("struct Edit {")
            .and_then(|(_, rest)| rest.split_once("};"))
            .map(|(body, _)| body)
            .expect("edit.wgsl declares struct Edit");

        let declared: Vec<&str> = body
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("//"))
            .filter_map(|line| line.split_once(':'))
            .map(|(name, _)| name.trim())
            .collect();

        assert_eq!(
            declared, super::EDIT_FIELDS,
            "struct Edit and gpu.rs's EDIT_FIELDS have drifted",
        );

        // And the buffer the writer produces is the size the binding wants: every field a
        // word, `vec2f` two, rounded up to four.
        let words: usize = super::EDIT_FIELDS
            .iter()
            .map(|name| if name.starts_with("region_") || *name == "canvas_size" { 2 } else { 1 })
            .sum();
        let expected = words.div_ceil(4) * 4 * 4;
        let colour = crate::hdr_fit::HdrColour::identity();
        let grade = super::Grade {
            width: 1,
            height: 1,
            colour: None,
            white: 1.0,
            source_level: 1.0,
            reference_nits: 203.0,
            peak_nits: 1000.0,
            exposure: 0.0,
            adjust: super::Adjust::none(),
            as_shot: None,
            output: super::Output::Pq,
        };
        assert_eq!(super::uniform(&grade, &colour).len(), expected);
    }

    /// The shader's forward map against this crate's inverse, over the slider's whole range.
    ///
    /// **The one property neither side can check alone.** `white_balance.rs` turns a
    /// chromaticity into a temperature and a tint, `white_balance.wgsl` turns them back into a
    /// chromaticity, and nothing else compares the two: the standard-illuminant tests pin only
    /// the inverse, and the shader's identity arm makes "as shot" the same picture whether or
    /// not the maps agree. What would break is quieter than either - a Lightroom sidecar's
    /// 5000K would land on an illuminant that is not Lightroom's 5000K, and the photograph
    /// would simply be the wrong colour.
    ///
    /// Run through a probe entry point rather than through a rendition, because a matrix that
    /// happens to look plausible is exactly what this is trying not to accept.
    #[test]
    fn the_shader_solves_the_illuminant_this_crate_reads_back() {
        const PROBE: &str = r#"
@compute @workgroup_size(1)
fn probe_xy() {
  let xy = xy_of(edit.temperature, edit.tint);
  balance_out[0] = xy.x;
  balance_out[1] = xy.y;
}
"#;
        let Some(gpu) = super::device() else {
            eprintln!(
                "SKIPPED: no adapter answered, so the white balance maps were not compared. \
                 Nothing else checks that the shader and this crate agree about an illuminant.",
            );
            return;
        };
        let device = &gpu.device;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("probe_xy"),
            source: wgpu::ShaderSource::Wgsl(
                format!("{}\n{PROBE}", super::balance_source()).into(),
            ),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("probe_xy"),
            entries: &[
                super::Binding::Uniform.entry(0),
                super::Binding::Storage { read_only: false }.entry(14),
            ],
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("probe_xy"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("probe_xy"),
                bind_group_layouts: &[Some(&layout)],
                ..Default::default()
            })),
            module: &module,
            entry_point: Some("probe_xy"),
            compilation_options: Default::default(),
            cache: None,
        });
        let out = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("probe_xy"),
            size: super::BALANCE_FLOATS * 4,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("probe_xy"),
            size: 8,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let colour = crate::hdr_fit::HdrColour::identity();
        let mut worst_temperature = 0.0f64;
        let mut worst_tint = 0.0f64;
        // The document's whole range, and the tint's, including the ends where the locus table
        // is coarsest and a transcription slip would show first.
        for temperature in [2000.0, 2700.0, 3200.0, 5000.0, 5500.0, 6500.0, 10000.0, 20000.0, 50000.0] {
            for tint in [-150.0, -50.0, 0.0, 25.0, 150.0] {
                let asked = crate::white_balance::AsShot { temperature, tint };
                let grade = super::Grade {
                    width: 1,
                    height: 1,
                    colour: None,
                    white: 1.0,
                    source_level: 1.0,
                    reference_nits: 203.0,
                    peak_nits: 1000.0,
                    exposure: 0.0,
                    adjust: super::Adjust {
                        temperature: Some(temperature),
                        tint: Some(tint),
                        ..super::Adjust::none()
                    },
                    as_shot: Some(asked),
                    output: super::Output::Pq,
                };
                let edits = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("probe_xy"),
                    contents: &super::uniform(&grade, &colour),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("probe_xy"),
                    layout: &layout,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 14, resource: out.as_entire_binding() },
                    ],
                });
                let mut encoder = device.create_command_encoder(&Default::default());
                {
                    let mut pass = encoder.begin_compute_pass(&Default::default());
                    pass.set_pipeline(&pipeline);
                    pass.set_bind_group(0, &group, &[]);
                    pass.dispatch_workgroups(1, 1, 1);
                }
                encoder.copy_buffer_to_buffer(&out, 0, &readback, 0, 8);
                gpu.queue.submit([encoder.finish()]);
                let slice = readback.slice(..);
                slice.map_async(wgpu::MapMode::Read, |_| {});
                device.poll(wgpu::PollType::wait_indefinitely()).expect("the probe finished");
                let (x, y) = {
                    let mapped = slice.get_mapped_range().expect("the readback mapped");
                    let read = |at: usize| {
                        f64::from(f32::from_le_bytes([
                            mapped[at],
                            mapped[at + 1],
                            mapped[at + 2],
                            mapped[at + 3],
                        ]))
                    };
                    (read(0), read(4))
                };
                readback.unmap();

                let back = crate::white_balance::from_xy(x, y);
                worst_temperature = worst_temperature
                    .max((back.temperature - temperature).abs() / temperature);
                worst_tint = worst_tint.max((back.tint - tint).abs());
                // Measured at 0.011% and 0.00, which is `f32` in the shader against `f64`
                // here rather than any disagreement about the locus. Bounded well inside what
                // a transcription slip costs - one wrong digit moves a temperature by percent
                // - and well outside what another GPU's rounding can.
                assert!(
                    (back.temperature - temperature).abs() < temperature * 0.005
                        && (back.tint - tint).abs() < 0.5,
                    "the shader put {temperature}K tint {tint} at ({x:.5}, {y:.5}), which this \
                     crate reads back as {:.0}K tint {:.1}",
                    back.temperature,
                    back.tint,
                );
            }
        }
        // Reported even on success: the two maps interpolate the same table differently, so
        // the round trip is close rather than exact, and how close is worth knowing before
        // anybody tightens the bound above.
        eprintln!(
            "white balance round trip: worst {:.3}% on temperature, {worst_tint:.2} on tint",
            worst_temperature * 100.0,
        );
    }

    /// The editor's crop against the gather's, pixel for pixel.
    ///
    /// **The one mapping in this pipeline that genuinely exists twice.** A rendition crops
    /// inside `image::PlanarWarp`'s gather, on the CPU, while it is correcting the lens; the
    /// editor crops in its draw, over a frame already warped at the open. Neither can call the
    /// other, so what stops them drifting is this - and drift here is a photograph whose
    /// preview is not the picture the file gets, which is the whole complaint that made the
    /// uniform one implementation in the first place.
    ///
    /// Every case moves something the arithmetic could get wrong: a crop off-centre, a
    /// straighten in both directions, each quarter turn, and the two composed.
    #[test]
    fn the_draw_places_a_pixel_where_the_gather_does() {
        const PROBE: &str = r#"
@group(0) @binding(6) var<storage, read_write> probe_out: array<f32>;

@compute @workgroup_size(64)
fn probe_geometry(@builtin(global_invocation_id) id: vec3u) {
  let out = vec2u(edit.output_width, edit.output_height);
  if (id.x >= out.x * out.y) { return; }
  // Pixel centres, which is what a fragment carries: `geometry_at` speaks in positions, and
  // handing it indices would agree with a gather that had the same bug.
  let at = geometry_at(vec2f(f32(id.x % out.x) + 0.5, f32(id.x / out.x) + 0.5));
  probe_out[id.x * 2u] = at.x;
  probe_out[id.x * 2u + 1u] = at.y;
}
"#;
        let Some(gpu) = super::device() else {
            eprintln!(
                "SKIPPED: no adapter answered, so the editor's crop was not compared with the \
                 gather's. Nothing else checks that the preview is the picture.",
            );
            return;
        };
        let device = &gpu.device;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("probe_geometry"),
            source: wgpu::ShaderSource::Wgsl(
                format!(
                    "{}\n{}\n{}\n{PROBE}",
                    include_str!("../../../web/src/features/raw_edit/gpu/wgsl/prelude.wgsl"),
                    include_str!("../../../web/src/features/raw_edit/gpu/wgsl/edit.wgsl"),
                    super::GEOMETRY_WGSL,
                )
                .into(),
            ),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("probe_geometry"),
            entries: &[
                super::Binding::Uniform.entry(0),
                super::Binding::Storage { read_only: false }.entry(6),
            ],
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("probe_geometry"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("probe_geometry"),
                bind_group_layouts: &[Some(&layout)],
                ..Default::default()
            })),
            module: &module,
            entry_point: Some("probe_geometry"),
            compilation_options: Default::default(),
            cache: None,
        });

        let colour = crate::hdr_fit::HdrColour::identity();
        let full = (263usize, 171usize);
        // A real correction, off `keystone.ts` for a pair of leaning uprights: asymmetric in
        // both the projective terms, so a transposed row or a swapped pair shows up.
        const LEANING: [f64; 8] = [
            0.847_222_222_222_222_2,
            0.0,
            0.076_388_888_888_888_9,
            0.0,
            0.847_222_222_222_222_2,
            0.076_388_888_888_888_9,
            -0.083_333_333_333_333_3,
            -0.125,
        ];
        let cases: [crate::image::Geometry; 10] = [
            geometry([0.0, 0.0, 1.0, 1.0], 0.0, 0, None),
            geometry([0.13, 0.07, 0.82, 0.91], 0.0, 0, None),
            geometry([0.0, 0.0, 1.0, 1.0], 7.5, 0, None),
            geometry([0.0, 0.0, 1.0, 1.0], -3.25, 0, None),
            geometry([0.0, 0.0, 1.0, 1.0], 0.0, 90, None),
            geometry([0.0, 0.0, 1.0, 1.0], 0.0, 270, None),
            geometry([0.2, 0.1, 0.75, 0.66], 4.0, 180, None),
            // A crop under a quarter turn, which is the only case where the stride's axes are
            // swapped. The two turns above carry the identity crop, and that is invariant under
            // the swap - so without this one the whole `span` permutation is unpinned.
            geometry([0.2, 0.1, 0.75, 0.66], 4.0, 90, None),
            // The keystone alone, and then under everything else: it is the one step that is
            // not affine, so the order it composes in is visible in the answer and nowhere else.
            geometry([0.0, 0.0, 1.0, 1.0], 0.0, 0, Some(LEANING)),
            geometry([0.15, 0.2, 0.9, 0.8], -6.0, 270, Some(LEANING)),
        ];

        let mut worst = 0.0f64;
        for geometry in cases {
            let out = crate::hdr::cropped_size(full.0, full.1, geometry);
            let pixels = out.0 * out.1;
            let bytes = (pixels * 2 * 4) as u64;
            let probe = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("probe_geometry"),
                size: bytes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            let readback = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("probe_geometry"),
                size: bytes,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });

            let grade = super::Grade {
                width: full.0,
                height: full.1,
                colour: None,
                white: 1.0,
                source_level: 1.0,
                reference_nits: 203.0,
                peak_nits: 1000.0,
                exposure: 0.0,
                adjust: super::Adjust::none(),
                as_shot: None,
                output: super::Output::Pq,
            };
            // The words the *editor* writes: `uniform_words` leaves the geometry at its
            // identity for a rendition, whose frame is cropped before the shader sees it.
            let mut words = super::uniform_words(&grade, &colour);
            let at = field_offset("crop_left");
            for (offset, value) in [
                geometry.crop[0],
                geometry.crop[1],
                geometry.crop[2],
                geometry.crop[3],
                geometry.angle_degrees,
            ]
            .iter()
            .enumerate()
            {
                words[at + offset] = (*value as f32).to_bits();
            }
            words[at + 5] = u32::from(geometry.rotate);
            words[at + 6] = out.0 as u32;
            words[at + 7] = out.1 as u32;
            let keystone_at = field_offset("keystone_0");
            for (offset, value) in geometry.keystone.unwrap_or_default().iter().enumerate() {
                words[keystone_at + offset] = (*value as f32).to_bits();
            }
            words[field_offset("has_keystone")] = u32::from(geometry.keystone.is_some());

            let edits = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("probe_geometry"),
                contents: &words.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>(),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("probe_geometry"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 6, resource: probe.as_entire_binding() },
                ],
            });

            let mut encoder = device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&pipeline);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups(pixels.div_ceil(64) as u32, 1, 1);
            }
            encoder.copy_buffer_to_buffer(&probe, 0, &readback, 0, bytes);
            gpu.queue.submit([encoder.finish()]);
            let slice = readback.slice(..);
            slice.map_async(wgpu::MapMode::Read, |_| {});
            device.poll(wgpu::PollType::wait_indefinitely()).expect("the probe finished");
            let got: Vec<f32> = {
                let mapped = slice.get_mapped_range().expect("the readback mapped");
                mapped
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .collect()
            };
            readback.unmap();

            for y in 0..out.1 {
                for x in 0..out.0 {
                    let want =
                        crate::image::geometry_at(full, out, geometry, x as f64 + 0.5, y as f64 + 0.5);
                    let index = (y * out.0 + x) * 2;
                    let off = ((f64::from(got[index]) - want.0).powi(2)
                        + (f64::from(got[index + 1]) - want.1).powi(2))
                    .sqrt();
                    // `max`, not `>`: a comparison against NaN is false, so a shader that
                    // divided by a degenerate span would leave `worst` at zero and pass.
                    assert!(off.is_finite(), "the draw put pixel ({x}, {y}) nowhere");
                    worst = worst.max(off);
                }
            }
        }
        // In frame pixels, and generous only against `f32` against `f64` over coordinates in
        // the hundreds - a real disagreement about the mapping is a pixel or far more, not a
        // thousandth of one.
        assert!(worst < 0.01, "the draw is {worst:.5} pixels from the gather at worst");
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
