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
/// `prelude` and `tick` declare what `colour` and `frame` assume; the order is the one
/// `FRAME` uses on the client. Concatenated rather than `#import`ed because WGSL has no
/// include and the client's bundler does the same join.
fn source() -> String {
    format!(
        "{}\n{}\n{}\n{}",
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/prelude.wgsl"),
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/tick.wgsl"),
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/colour.wgsl"),
        include_str!("../../../web/src/features/raw_edit/gpu/wgsl/frame.wgsl"),
    )
}

pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    module: wgpu::ShaderModule,
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
    sampler: wgpu::Sampler,
}

static GPU: OnceLock<Option<Gpu>> = OnceLock::new();

/// The device, or None where no adapter of any kind answered.
///
/// None is a real outcome rather than a panic: a caller grades on the CPU-shaped path it
/// already has for a frame with no camera match, and a machine with no Vulkan at all gets
/// a degraded import rather than a crash loop.
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
        // fitting: `counts` is `pixels * 3 * 4`, so 288MB at 24MP and 732MB at 61MP. The
        // browser lives with that floor because it has to; a native process has no reason
        // to ask for less than the hardware offers, and asking for less turns every
        // full-size rendition into a validation failure.
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
            source: wgpu::ShaderSource::Wgsl(source().into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("encode"),
            entries: &ENCODE_BINDINGS.map(|(binding, kind)| kind.entry(binding)),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("encode"),
            bind_group_layouts: &[Some(&layout)],
            ..Default::default()
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("encode"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("encode"),
            compilation_options: Default::default(),
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Some(Gpu { device, queue, module, layout, pipeline, sampler })
    }

    /// The shader module, for tests that want a second entry point over the same source.
    pub fn module(&self) -> &wgpu::ShaderModule {
        &self.module
    }

    /// The largest binding one frame needs, which is the `u32` per component `encode`
    /// writes - four bytes where the input is two.
    fn binding_bytes(pixels: usize) -> u64 {
        (pixels * 3 * 4) as u64
    }

    /// Whether a frame of this many pixels fits the adapter in one dispatch.
    ///
    /// Asked rather than assumed because the answer is a hardware limit and the frames are
    /// large: 274MiB of output at 24MP, 698MiB at 61MP.
    ///
    /// **Measured, it does not bite on real hardware.** RADV on an integrated Radeon
    /// reports 2047MiB for both `max_storage_buffer_binding_size` and `max_buffer_size`,
    /// which is three times what the largest sensor here needs. So the banding this would
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
const ENCODE_BINDINGS: [(u32, Binding); 11] = [
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
];

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
    /// The peak the roll-off is against, which the caller measures - it is an input to the
    /// grade rather than part of it, and the CPU already has it.
    pub scene_peak: f64,
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

impl Gpu {
    /// One `encode` dispatch: the graded frame as `u16` counts of PQ.
    ///
    /// The same entry point the editor's readback uses, so a rendition and a tick of the
    /// same photo are the same pixels by construction.
    pub fn encode(&self, frame: &[u16], grade: &Grade<'_>) -> Vec<u16> {
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

        let mut bytes: Vec<u8> = frame.iter().flat_map(|v| v.to_le_bytes()).collect();
        // A whole number of words, since the shader indexes `array<u32>`.
        while bytes.len() % 4 != 0 {
            bytes.push(0);
        }
        let buffer = |contents: &[u8], usage: wgpu::BufferUsages| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents,
                usage,
            })
        };
        let samples = buffer(&bytes, wgpu::BufferUsages::STORAGE);
        let peak_out =
            buffer(&(grade.scene_peak as f32).to_le_bytes().repeat(4), wgpu::BufferUsages::STORAGE);

        let identity = HdrColour::identity();
        let described = grade.colour.unwrap_or(&identity);
        let matrix: Vec<u8> =
            described.matrix.iter().flatten().flat_map(|v| (*v as f32).to_le_bytes()).collect();
        let matrix = buffer(&matrix, wgpu::BufferUsages::STORAGE);
        let tick = buffer(&uniform(grade, described), wgpu::BufferUsages::UNIFORM);

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

        let out_bytes = (pixels * 3 * 4) as u64;
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
        let (chroma_view, luma_view, curves_view, pyramid_view) =
            (view(&chroma), view(&chroma_luma), view(&curves), view(&pyramid));
        let tint_view = view(&chroma_tint);
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("encode"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: tick.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: samples.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&curves_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&chroma_view),
                },
                wgpu::BindGroupEntry { binding: 4, resource: matrix.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: peak_out.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: counts.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 9,
                    resource: wgpu::BindingResource::TextureView(&pyramid_view),
                },
                wgpu::BindGroupEntry {
                    binding: 10,
                    resource: wgpu::BindingResource::TextureView(&luma_view),
                },
                wgpu::BindGroupEntry {
                    binding: 11,
                    resource: wgpu::BindingResource::TextureView(&tint_view),
                },
            ],
        });

        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(
                (grade.width as u32).div_ceil(8),
                (grade.height as u32).div_ceil(8),
                1,
            );
        }
        encoder.copy_buffer_to_buffer(&counts, 0, &readback, 0, out_bytes);
        self.queue.submit([encoder.finish()]);

        let slice = readback.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        self.device.poll(wgpu::PollType::wait_indefinitely()).expect("the dispatch finished");
        let mapped = slice.get_mapped_range().expect("the readback mapped");
        mapped.chunks_exact(4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as u16).collect()
    }

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

/// `TICK_UNIFORM_FLOATS` in `shaders.ts`, field for field in `struct Tick`'s order.
///
/// Flat rather than a builder so it can be read against the struct. The one subtlety is
/// the unnamed word before `region_origin`: WGSL puts a `vec2f` on a multiple of eight and
/// the scalars end on 84, so without it every field after lands short and the binding is
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
    w.push(1); // row_stride
    w.push((grade.width * grade.height) as u32); // peak_samples
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
