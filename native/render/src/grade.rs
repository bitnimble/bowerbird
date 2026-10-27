//! The grade, on whatever GPU this machine has, from the shaders the editor runs.
//!
//! **This exists so there is one implementation of the grade.** The editor's tick has to be
//! WGSL - it runs in a browser - so the choice was ever a second implementation in Rust or
//! this. Two implementations of one picture drift silently (DESIGN 21.1); sharing the source
//! makes that unexpressible rather than tested-for.
//!
//! The shaders are the `shaders` crate's, compiled from the files the browser's build compiles, so
//! the module the page runs and the module this runs are the same bytes. A copy beside either host
//! would pass every test it had while diverging from what ships.

// A browser draws rather than encodes, so the encode, the peak and the readback are unreachable
// there rather than unwanted.
#![cfg_attr(target_arch = "wasm32", allow(dead_code))]

use colour::matched::HdrColour;
use geometry::warp::Band;
use colour::sdr_match::CANVAS_WHITE_NITS;
use colour::tone::{Anchored, Levels};
use gpu::{Buffer, Gpu, Recording, Texture, dispatch, read_back};
use units::light::{Light, SceneNits, Stops};

pub mod colour_wheel;
mod print_environment;
mod print_surface;
#[cfg(all(not(target_arch = "wasm32"), feature = "renditions"))]
pub mod surface_stage;

/// `frame.slang`'s `FROM_FRAME`, as the draw's two pipelines name it.
const FROM_FRAME_ID: &str = "0";

/// Every `(from_frame, entry)` pair [`Grader::drawing`] has a pipeline for.
const DRAWINGS: [(bool, &str); 6] = [
    (true, "fs"),
    (false, "fs"),
    (true, "fs_print"),
    (true, "fs_print_pq"),
    (true, "fs_print_pigment"),
    (true, "fs_print_flat"),
];

const FRAME_WGSL: &str = shaders::FRAME.source;
const PEAK_WGSL: &str = shaders::PEAK.source;
const DETAIL_WGSL: &str = shaders::DETAIL.source;
const READBACK_WGSL: &str = shaders::READBACK.source;
const PQ420_WGSL: &str = shaders::PQ420.source;

/// Where `pq420.slang`'s `pack_pq420` writes each plane of a `width` by `height` frame, in words of
/// two samples: luma rows a block of four pixels wide and padded to an even count, then the two
/// chroma planes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pq420Layout {
    width: u32,
    height: u32,
    luma_stride: u32,
    chroma_stride: u32,
    cb_at: u32,
    cr_at: u32,
    words: u32,
}

impl Pq420Layout {
    fn of(width: u32, height: u32) -> Pq420Layout {
        let blocks = width.div_ceil(4);
        let rows = height.div_ceil(2);
        let (luma_stride, chroma_stride) = (blocks * 2, blocks);
        let cb_at = luma_stride * rows * 2;
        let cr_at = cb_at + chroma_stride * rows;
        Pq420Layout {
            width,
            height,
            luma_stride,
            chroma_stride,
            cb_at,
            cr_at,
            words: cr_at + chroma_stride * rows,
        }
    }

    /// What leads [`Grader::pq420`]'s answer: the width and height, then the strides and the chroma
    /// planes' offsets in samples from the first, then two unused.
    fn header(&self) -> [u32; PQ420_HEADER_WORDS] {
        [
            self.width,
            self.height,
            self.luma_stride * 2,
            self.chroma_stride * 2,
            self.cb_at * 2,
            self.cr_at * 2,
            0,
            0,
        ]
    }
}

const PQ420_HEADER_WORDS: usize = 8;

const PACK_BINDINGS: [(u32, Binding); 3] = [
    (0, Binding::Drawn),
    (1, Binding::Storage { read_only: false }),
    (2, Binding::Uniform),
];

/// `DETAIL_LONG` in `detail.slang`, which is the long edge of that blur's working texture.
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
    detail_within(width, height, width.max(height))
}

/// The same, for a frame that is a *piece* of a photograph whose long edge is `photograph_long`.
///
/// **At the photograph's rate rather than its own.** The blur is a shrink of the frame it is
/// built from, so a loupe tile scaled to fill the working texture would blur a twelfth of the
/// distance the export blurs - the same Clarity, acting on something else. Sized here and its
/// *window* carried in the uniform (`edit.detail_long`), because the two are separate facts: how
/// much of the photograph this texture holds, and how far across the photograph the filter
/// reaches.
pub fn detail_within(width: usize, height: usize, photograph_long: usize) -> DetailSize {
    let step = detail_step(photograph_long) as usize;
    DetailSize {
        width: width.div_ceil(step).max(1) as u32,
        height: height.div_ceil(step).max(1) as u32,
    }
}

/// How many of the photograph's pixels one texel of that texture covers.
///
/// **A step, so that the partition does not move with the window.** Dividing the frame given by
/// the texture allocated for it is the same thing for a whole photograph and is not the same
/// thing for a piece of one: a tile's texel boundaries land between the frame's, so every texel
/// averages a different set of pixels and the guided filter
/// was fitted from a picture the export never sees. With a step, a window whose origin is a whole
/// number of them gets the photograph's own texels.
pub fn detail_step(photograph_long: usize) -> u32 {
    (photograph_long.max(1) as u32).div_ceil(DETAIL_LONG).max(1)
}

/// The working texture's long edge for a whole photograph of `photograph_long`, which is what
/// `detail.slang` takes its window and its sigma as a fraction of.
pub fn detail_long(photograph_long: usize) -> u32 {
    (photograph_long.max(1) as u32).div_ceil(detail_step(photograph_long))
}

/// `GUIDE_RADIUS` in `detail.slang`: the guided filter's window, as a fraction of that long edge.
const GUIDE_RADIUS: f64 = 1.0 / 64.0;

/// `FINE_SIGMA` there: the fine reference's blur, in the same units.
const FINE_SIGMA: f64 = 1.0 / 1024.0;

/// How far the presence sliders read past a texel, in texels of a working texture this long.
///
/// **Two windows and a blur**, which is what the filter is: the moments are gathered over one
/// window and the models it fits are averaged over another, so an output texel depends on twice
/// the radius, and the fine reference adds its own taps on top. A caller building the blur for a
/// *piece* of a photograph needs this to know how much of the surroundings it has to hold
/// (`job::presence_reach`); a whole frame has them already.
///
/// The arithmetic is `detail.slang`'s, in Rust, which `the_detail_reach_is_the_shaders_own` pins
/// against the shader rather than trusting.
/// **Texels of the working texture, not pixels of the frame.** The two differ by `detail_step`, and
/// a caller that used this as a pixel reach would grow a window by a fraction of what the filter
/// actually reads - `tile::presence_reach` is the one that converts.
pub fn detail_reach_texels(detail_long: u32) -> units::px::Span<units::px::Texel> {
    // Off the working texture's own long edge, which is what keeps it a share of the photograph
    // rather than a count of texels: `detail_reach` is `GUIDE_RADIUS` and `FINE_SIGMA` of it.
    units::px::Span::measured(detail_reach(detail_long))
}

pub fn detail_reach(detail_long: u32) -> usize {
    let long = f64::from(detail_long);
    let guide = (long * GUIDE_RADIUS).round().max(1.0);
    let fine = (3.0 * (long * FINE_SIGMA).max(0.5)).ceil();
    (2.0 * guide + fine) as usize
}

/// The blur's working texture, named so it can travel to the editor as one.
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailSize {
    pub width: u32,
    pub height: u32,
}

/// The frame's coding undone, and nothing of `colour` because it binds the same table
/// read-only.
const DECODE_WGSL: &str = shaders::DECODE.source;

const MEAN_FRAME_WGSL: &str = shaders::MEAN_FRAME.source;
const CHROMA_SMOOTH_WGSL: &str = shaders::CHROMA_SMOOTH.source;

/// How many texels the chroma-smoothing pass's blur reaches, held against `chroma_smooth.slang`.
const CHROMA_BLUR_REACH: u32 = 4;

/// Photograph long edges to a texel of that pass's shrunk frame.
///
/// **A share of the photograph, not a count of this frame's pixels**, for the reason
/// `DETAIL_LONG` is one and `mean_grid`'s block is one: the frame is a rendition of a
/// photograph and its pixels are whatever size that rendition asked for. A texel per four
/// pixels covers four times as much of a photograph rendered at 3840 as of the same one at a
/// 61MP sensor's own size, so the same picture's colour was smoothed over 2.5x more of itself
/// in the viewer's rendition than in the editor at 1:1 - measured as three times the chroma
/// noise in the larger render (`examples/supersample.rs`).
///
/// A 960th is four pixels at the size the viewer's rendition ships, so that rendition is
/// unchanged and every other size now agrees with it rather than the other way about.
///
/// A [`units::px::Share`] and not a number of pixels, which is the type saying what went wrong
/// here: `Output`'s pixels are as large as the rendition is small, so it is not [`Absolute`] and
/// a constant distance in it does not compile.
const CHROMA_GRID: units::px::Share = units::px::Share::of(1, 960);

/// This frame's pixels to a texel of `chroma_smoothed`, given the photograph it is part of.
pub fn chroma_shrink(
    photograph_long: units::px::Span<units::px::Output>,
) -> units::px::Span<units::px::Output> {
    CHROMA_GRID.over(photograph_long)
}

/// How far, in frame pixels, a pixel's chroma can be moved by a neighbour: the texel the
/// bilinear read straddles, the blur's reach beyond it, and the texel that reach lands in.
/// A comparison that expects a pixel's colour to be a function of its own value alone has
/// to stay this far from anything that differs, and a window that must render as the
/// whole frame does has to carry this much of it past what it keeps.
pub fn chroma_smooth_reach(
    photograph_long: units::px::Span<units::px::Output>,
) -> units::px::Span<units::px::Output> {
    chroma_shrink(photograph_long) * (CHROMA_BLUR_REACH + 2) as usize
}

/// The reader's temperature and tint solved into one matrix, and the camera match's into another.
const BALANCE_WGSL: &str = shaders::WHITE_BALANCE.source;

/// Floats that pass writes: two matrices of three rows of four, the fourth of each unread.
const BALANCE_FLOATS: u64 = 24;

/// Entries in that table, which is every `u16` a sample can hold. `PQ_CODES` on the client.
const PQ_CODES: u64 = 65536;

/// The scene's own top end, measured once and read by every rendition of the photograph.
///
/// **Once per photograph, not once per size.** It is a property of the scene - what the
/// roll-off compresses into the display - so two renditions measuring it separately would
/// compress their highlights by different amounts, which is the drift `tone::QUANTILE_SAMPLES`
/// exists to prevent at the other end of the range. `job::run` uploads once per size group, so a
/// grid-and-full job would otherwise measure it twice, on two differently sized frames.
///
/// Four words, filled on the GPU by `Uploaded::measure_peak` and read there by the grade. The
/// CPU never sees the number.
pub struct ScenePeak {
    buffer: Buffer,
    measured: std::cell::Cell<bool>,
    revision: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl ScenePeak {
    /// Whether this still wants filling, claiming it if so.
    fn claim(&self) -> bool {
        !self.measured.replace(true)
    }
}

/// How the peak samples a frame: every nth row, for about `tone::QUANTILE_SAMPLES` pixels.
///
/// Whole rows rather than a scatter because `peak.slang` reads a frame: consecutive lanes stay
/// adjacent, where a stride applied per pixel would take a cache line each and fetch the whole
/// frame to read a tenth of it.
pub fn sampled_rows(width: usize, height: usize) -> (u32, u32) {
    let pixels = width * height;
    let stride = (((pixels as f64) / (colour::tone::QUANTILE_SAMPLES as f64)).round() as u32).max(1);
    (stride, (height as u32).div_ceil(stride))
}


/// The grade's pipelines on one device, and the tables they read.
pub struct Grader {
    pub gpu: &'static Gpu,
    layout: wgpu::BindGroupLayout,
    encode: dispatch::Banded,
    frame_module: wgpu::ShaderModule,
    draw_layout: wgpu::BindGroupLayout,
    draw_from_frame: std::sync::OnceLock<wgpu::RenderPipeline>,
    draw_from_pyramid: std::sync::OnceLock<wgpu::RenderPipeline>,
    print_layout: wgpu::BindGroupLayout,
    print_pipeline: std::sync::OnceLock<wgpu::RenderPipeline>,
    print_pq_pipeline: std::sync::OnceLock<wgpu::RenderPipeline>,
    print_pigment_pipeline: std::sync::OnceLock<wgpu::RenderPipeline>,
    print_flat_pipeline: std::sync::OnceLock<wgpu::RenderPipeline>,
    print_surface: std::sync::OnceLock<print_surface::Pipelines>,
    print_environment: std::sync::OnceLock<print_environment::Pipelines>,
    print_material: std::sync::OnceLock<PrintMaterial>,
    colour_wheel: std::sync::OnceLock<colour_wheel::Pipelines>,
    identity_lattice: std::sync::OnceLock<(Texture, Texture)>,
    pack_layout: wgpu::BindGroupLayout,
    pack: wgpu::ComputePipeline,
    pack_pq420: std::sync::OnceLock<wgpu::ComputePipeline>,
    pack_srgb8: std::sync::OnceLock<wgpu::ComputePipeline>,
    peak_layout: wgpu::BindGroupLayout,
    peak_measure: wgpu::ComputePipeline,
    peak_collect: wgpu::ComputePipeline,
    peak_remeasure: wgpu::ComputePipeline,
    peak_quantile: wgpu::ComputePipeline,
    detail_shrink_layout: wgpu::BindGroupLayout,
    detail_moments_layout: wgpu::BindGroupLayout,
    detail_box_layout: wgpu::BindGroupLayout,
    detail_mean_layout: wgpu::BindGroupLayout,
    detail_apply_layout: wgpu::BindGroupLayout,
    detail_shrink: dispatch::Banded,
    detail_moments: dispatch::Banded,
    detail_coefficients: dispatch::Banded,
    detail_window_mean: dispatch::Banded,
    detail_apply: dispatch::Banded,
    balance_layout: wgpu::BindGroupLayout,
    balance_pipeline: wgpu::ComputePipeline,
    mean_layout: wgpu::BindGroupLayout,
    mean_pipeline: dispatch::Banded,
    chroma_model_layout: wgpu::BindGroupLayout,
    chroma_blur_layout: wgpu::BindGroupLayout,
    chroma_model: dispatch::Banded,
    chroma_blur: dispatch::Banded,
    sampler: wgpu::Sampler,
    /// The frame's coding undone. Filled once with the device, since `tone::encode_base`
    /// anchors every frame to the reference white before coding it and what comes back out
    /// is nits - nothing here depends on the photograph.
    nits_of_code: Buffer,
}

struct PrintMaterial {
    layout: wgpu::BindGroupLayout,
    tabulate: wgpu::ComputePipeline,
    average: wgpu::ComputePipeline,
    light: wgpu::ComputePipeline,
    room: wgpu::ComputePipeline,
}

/// The grade on `gpu`, built on first use and again for each device opened after a loss.
pub fn device(gpu: &'static Gpu) -> &'static Grader {
    static BUILT: gpu::Cache<Grader> = gpu::Cache::new();
    BUILT.get(gpu, || Grader::new(gpu))
}

impl Grader {
    pub fn print_light_calibration(
        &self,
        parameters: [f32; 4],
        temperature: f32,
        environment: &Texture,
    ) -> Buffer {
        self.calibrate_print_light(parameters, temperature, environment, None)
    }

    /// Another lamp in the room `calibrated` was made for, which must be `environment`.
    pub fn print_lamp_calibration(
        &self,
        calibrated: &Buffer,
        parameters: [f32; 4],
        temperature: f32,
        environment: &Texture,
    ) -> Buffer {
        self.calibrate_print_light(parameters, temperature, environment, Some(calibrated))
    }

    fn calibrate_print_light(
        &self,
        parameters: [f32; 4],
        temperature: f32,
        environment: &Texture,
        room: Option<&Buffer>,
    ) -> Buffer {
        let mut recording = self.gpu.record();
        recording.holding_texture(environment);
        let buffer = self.gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some("print light calibration"),
            size: crate::print::CALIBRATION_BYTES,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        recording.holding(&buffer);
        if let Some(room) = room {
            recording.holding(room);
            recording.copy_buffer_to_buffer(room, 0, &buffer, 0, crate::print::CALIBRATION_BYTES);
        }
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("print lamp"),
            contents: &crate::print::light_uniform(parameters, temperature),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("print light calibration"),
            layout: &self.print_material().layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: buffer.as_entire_binding(),
                },
            ],
        });
        let map = self.print_environment_group(environment);
        let mut light = |pipeline: &wgpu::ComputePipeline| {
            recording.dispatch([1, 1, 1], dispatch::Whole::Fixed, |pass| {
                pass.set_bind_group(0, &group, &[]);
                pass.set_bind_group(1, &map, &[]);
                pass.set_pipeline(pipeline);
            });
        };
        light(&self.print_material().light);
        if room.is_none() {
            light(&self.print_material().room);
        }
        buffer
    }

    pub fn print_albedo_table(&self, eta: f32) -> Buffer {
        let mut recording = self.gpu.record();
        let buffer = self.gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some("print directional albedo"),
            size: crate::print::ALBEDO_BYTES,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        recording.holding(&buffer);
        let values = [eta, 0.0, 0.0, 0.0]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>();
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("print material"),
            contents: &values,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("print albedo"),
            layout: &self.print_material().layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: buffer.as_entire_binding(),
                },
            ],
        });
        recording.dispatch(
            [
                crate::print::ALBEDO_VIEWS.div_ceil(64),
                crate::print::ALBEDO_ROUGHNESSES,
                1,
            ],
            dispatch::Whole::Fixed,
            |pass| {
                pass.set_bind_group(0, &group, &[]);
                pass.set_pipeline(&self.print_material().tabulate);
            },
        );
        recording.dispatch(
            [crate::print::ALBEDO_ROUGHNESSES.div_ceil(64), 1, 1],
            dispatch::Whole::Fixed,
            |pass| {
                pass.set_bind_group(0, &group, &[]);
                pass.set_pipeline(&self.print_material().average);
            },
        );
        buffer
    }

    fn print_material(&self) -> &PrintMaterial {
        self.print_material.get_or_init(|| {
            let device = &self.gpu.describing();
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("print albedo"),
                source: wgpu::ShaderSource::Wgsl(
                    shaders::PRINT_ALBEDO.source.into(),
                ),
            });
            let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("print albedo"),
                entries: &[
                    Binding::Uniform.entry(0),
                    Binding::Storage { read_only: false }.entry(1),
                ],
            });
            let albedo_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("print albedo"),
                bind_group_layouts: &[Some(&layout)],
                ..Default::default()
            });
            let compute =
                |label, module: &wgpu::ShaderModule, layout: &wgpu::PipelineLayout, entry| {
                    device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                        label: Some(label),
                        layout: Some(layout),
                        module,
                        entry_point: Some(entry),
                        compilation_options: Default::default(),
                        cache: None,
                    })
                };
            let tabulate = compute("print albedo", &module, &albedo_layout, "tabulate");
            let average = compute("print average albedo", &module, &albedo_layout, "average");
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("print lamp"),
                source: wgpu::ShaderSource::Wgsl(
                    shaders::PRINT_LIGHT_CALIBRATE.source
                        .into(),
                ),
            });
            let light_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("print light calibration"),
                bind_group_layouts: &[
                    Some(&layout),
                    Some(&self.print_environment_pipelines().map_layout),
                ],
                ..Default::default()
            });
            let light = compute(
                "print light calibration",
                &module,
                &light_layout,
                "calibrate",
            );
            let room = compute("print light calibration", &module, &light_layout, "room");
            PrintMaterial {
                layout,
                tabulate,
                average,
                light,
                room,
            }
        })
    }

    pub fn colour_wheel(&self) -> &colour_wheel::Pipelines {
        self.colour_wheel
            .get_or_init(|| colour_wheel::Pipelines::new(&self.gpu.describing()))
    }

}

impl Grader {
    fn new(gpu: &'static Gpu) -> Grader {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("edit"),
            source: wgpu::ShaderSource::Wgsl(FRAME_WGSL.into()),
        });
        let peak_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("peak"),
            source: wgpu::ShaderSource::Wgsl(PEAK_WGSL.into()),
        });
        let group_layout = |label: &str, bindings: &[(u32, Binding)]| {
            let entries: Vec<_> = bindings
                .iter()
                .map(|(binding, kind)| kind.entry(*binding))
                .collect();
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some(label),
                entries: &entries,
            })
        };
        let layout = group_layout("encode", &ENCODE_BINDINGS);
        let peak_layout = group_layout("peak", &PEAK_BINDINGS);
        let draw_layout = {
            let entries: Vec<_> = DRAW_BINDINGS
                .iter()
                .map(|(binding, kind)| kind.drawn(*binding))
                .collect();
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("draw"),
                entries: &entries,
            })
        };
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
        let banded = |label: &str,
                      module: &wgpu::ShaderModule,
                      group: &wgpu::BindGroupLayout,
                      entry_point: &str| {
            device.create_banded_pipeline(label, module, &[group], entry_point, &[])
        };
        let detail_shrink_layout = group_layout("detail shrink", &DETAIL_SHRINK_BINDINGS);
        let detail_moments_layout = group_layout("detail moments", &DETAIL_MOMENTS_BINDINGS);
        let detail_box_layout = group_layout("detail box", &DETAIL_BOX_BINDINGS);
        let detail_mean_layout = group_layout("detail fit", &DETAIL_MEAN_BINDINGS);
        let detail_apply_layout = group_layout("detail apply", &DETAIL_APPLY_BINDINGS);
        let detail_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("detail"),
            source: wgpu::ShaderSource::Wgsl(DETAIL_WGSL.into()),
        });
        let detail_shrink = banded("shrink", &detail_module, &detail_shrink_layout, "shrink");
        let detail_moments = banded(
            "moments_of",
            &detail_module,
            &detail_moments_layout,
            "moments_of",
        );
        let detail_coefficients = banded(
            "coefficients",
            &detail_module,
            &detail_box_layout,
            "coefficients",
        );
        let detail_window_mean = banded(
            "window_mean",
            &detail_module,
            &detail_mean_layout,
            "window_mean",
        );
        let detail_apply = banded(
            "apply_guided",
            &detail_module,
            &detail_apply_layout,
            "apply_guided",
        );

        let balance_layout = group_layout("balance", &BALANCE_BINDINGS);
        let balance_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("balance"),
            source: wgpu::ShaderSource::Wgsl(BALANCE_WGSL.into()),
        });
        let balance_pipeline = compute("balance", &balance_module, &balance_layout, "balance");

        let mean_layout = group_layout(
            "mean_frame",
            &[
                (1, Binding::Storage { read_only: true }),
                (19, Binding::Written),
                (20, Binding::Uniform),
            ],
        );
        let mean_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("mean_frame"),
            source: wgpu::ShaderSource::Wgsl(MEAN_FRAME_WGSL.into()),
        });
        let mean_pipeline = banded("mean_frame", &mean_module, &mean_layout, "mean");

        let chroma_model_layout = group_layout("chroma model", &CHROMA_MODEL_BINDINGS);
        let chroma_blur_layout = group_layout(
            "chroma blur",
            &[
                (20, Binding::Uniform),
                (22, Binding::Written),
                (23, Binding::Detail),
            ],
        );
        let chroma_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("chroma_smooth"),
            source: wgpu::ShaderSource::Wgsl(CHROMA_SMOOTH_WGSL.into()),
        });
        let chroma_model = banded(
            "chroma model",
            &chroma_module,
            &chroma_model_layout,
            "model",
        );
        let chroma_blur = banded("chroma blur", &chroma_module, &chroma_blur_layout, "blur");

        let encode = banded("encode", &module, &layout, "encode");
        let print_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("print"),
            entries: &[
                Binding::Uniform.drawn(0),
                Binding::Storage { read_only: true }.drawn(1),
                Binding::Storage { read_only: true }.drawn(2),
                Binding::Storage { read_only: true }.drawn(3),
                Binding::Detail.drawn(4),
                Binding::Sampler.drawn(5),
            ],
        });
        let peak_measure = compute("measure", &peak_module, &peak_layout, "measure");
        // The editor's route to the same number, so that it has one here to be held against:
        // `collect` keeps the brightest of the sampled million and `remeasure` grades only
        // those again, which is what lets a slider move without re-sweeping the frame. A
        // rendition is graded at one exposure and never asks twice, so nothing on that path
        // dispatches these - `the_kept_candidates_answer_as_the_whole_sample_does` is what does.
        let peak_collect = compute("collect", &peak_module, &peak_layout, "collect");
        let peak_remeasure = compute("remeasure", &peak_module, &peak_layout, "remeasure");
        let peak_quantile = compute("quantile", &peak_module, &peak_layout, "quantile");
        let pack_layout = group_layout("pack", &PACK_BINDINGS);
        let readback_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("readback"),
            source: wgpu::ShaderSource::Wgsl(READBACK_WGSL.into()),
        });
        let pack = compute("pack", &readback_module, &pack_layout, "pack");
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        // Filled by the shader rather than by `tone::pq_inv` and uploaded, so that the coding
        // the frame arrives in is undone by the same source the client undoes it with. There
        // is a Rust `pq_inv` and it is not this one's twin: this table is what the *grade*
        // reads, and the grade has one implementation on purpose (21.1).
        let nits_of_code = gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some("nits_of_code"),
            size: PQ_CODES * 4,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let decode_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("decode"),
            source: wgpu::ShaderSource::Wgsl(DECODE_WGSL.into()),
        });
        let decode_layout = group_layout("decode", &[(12, Binding::Storage { read_only: false })]);
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("decode"),
            layout: &decode_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 12,
                resource: nits_of_code.as_entire_binding(),
            }],
        });
        let pq_table = compute("pq_table", &decode_module, &decode_layout, "pq_table");

        let grader = Grader {
            gpu,
            layout,
            encode,
            frame_module: module,
            draw_layout,
            draw_from_frame: std::sync::OnceLock::new(),
            draw_from_pyramid: std::sync::OnceLock::new(),
            print_layout,
            print_pipeline: std::sync::OnceLock::new(),
            print_pq_pipeline: std::sync::OnceLock::new(),
            print_pigment_pipeline: std::sync::OnceLock::new(),
            print_flat_pipeline: std::sync::OnceLock::new(),
            print_surface: std::sync::OnceLock::new(),
            print_environment: std::sync::OnceLock::new(),
            print_material: std::sync::OnceLock::new(),
            colour_wheel: std::sync::OnceLock::new(),
            identity_lattice: std::sync::OnceLock::new(),
            pack_layout,
            pack,
            pack_pq420: std::sync::OnceLock::new(),
            pack_srgb8: std::sync::OnceLock::new(),
            peak_layout,
            peak_measure,
            peak_collect,
            peak_remeasure,
            peak_quantile,
            detail_shrink_layout,
            detail_moments_layout,
            detail_box_layout,
            detail_mean_layout,
            detail_apply_layout,
            detail_shrink,
            detail_moments,
            detail_coefficients,
            detail_window_mean,
            detail_apply,
            balance_layout,
            balance_pipeline,
            mean_layout,
            mean_pipeline,
            chroma_model_layout,
            chroma_blur_layout,
            chroma_model,
            chroma_blur,
            sampler,
            nits_of_code,
        };
        gpu.record().dispatch(
            [(PQ_CODES / 64) as u32, 1, 1],
            dispatch::Whole::Fixed,
            |pass| {
                pass.set_pipeline(&pq_table);
                pass.set_bind_group(0, &group, &[]);
            },
        );
        grader
    }

    fn print_environment_pipelines(&self) -> &print_environment::Pipelines {
        self.print_environment
            .get_or_init(|| print_environment::Pipelines::new(&self.gpu.describing()))
    }

    fn print_surface(&self) -> &print_surface::Pipelines {
        self.print_surface
            .get_or_init(|| print_surface::Pipelines::new(&self.gpu.describing()))
    }

    /// Builds every pipeline this device leaves to the first draw that needs it.
    pub fn build_deferred_pipelines(&self) {
        for (from_frame, entry) in DRAWINGS {
            self.drawing(from_frame, entry);
        }
        self.print_material();
        self.print_surface();
    }

    fn drawing(&self, from_frame: bool, entry: &str) -> &wgpu::RenderPipeline {
        let held = match entry {
            "fs" if from_frame => &self.draw_from_frame,
            "fs" => &self.draw_from_pyramid,
            "fs_print" => &self.print_pipeline,
            "fs_print_pq" => &self.print_pq_pipeline,
            "fs_print_pigment" => &self.print_pigment_pipeline,
            "fs_print_flat" => &self.print_flat_pipeline,
            _ => unreachable!("a frame drawing entry point"),
        };
        held.get_or_init(|| {
            self.gpu.describing()
                .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("draw"),
                    layout: Some(&self.gpu.describing().create_pipeline_layout(
                        &wgpu::PipelineLayoutDescriptor {
                            label: Some("draw"),
                            bind_group_layouts: &if entry != "fs" && entry != "fs_print_pigment" {
                                vec![Some(&self.draw_layout), Some(&self.print_layout)]
                            } else {
                                vec![Some(&self.draw_layout)]
                            },
                            ..Default::default()
                        },
                    )),
                    vertex: wgpu::VertexState {
                        module: &self.frame_module,
                        entry_point: Some("vs"),
                        compilation_options: Default::default(),
                        buffers: &[],
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &self.frame_module,
                        entry_point: Some(entry),
                        compilation_options: wgpu::PipelineCompilationOptions {
                            constants: shaders::FRAME.constants_for(
                                entry,
                                &[(FROM_FRAME_ID, f64::from(u8::from(from_frame)))],
                            ),
                            ..Default::default()
                        },
                        targets: &[Some(if entry == "fs_print_pq" {
                            wgpu::TextureFormat::Rgba16Uint.into()
                        } else {
                            CANVAS_FORMAT.into()
                        })],
                    }),
                    primitive: Default::default(),
                    depth_stencil: None,
                    multisample: Default::default(),
                    multiview_mask: Default::default(),
                    cache: None,
                })
        })
    }

    /// `drawn` as RGB9E5 words, four little-endian bytes a pixel, a row after another: what a
    /// canvas the page draws itself is sent (`readback.slang`).
    pub async fn rgb9e5(&self, drawn: &Texture) -> Option<Vec<u8>> {
        self.four_byte_packed(drawn, &self.pack).await
    }

    /// `drawn` as eight-bit sRGB RGBA, a row after another: a thumbnail, ready for a PNG.
    pub async fn srgb8(&self, drawn: &Texture) -> Option<Vec<u8>> {
        let pipeline = self.pack_srgb8.get_or_init(|| {
            self.compute_pipeline("srgb8", READBACK_WGSL, &self.pack_layout, "pack_srgb8")
        });
        self.four_byte_packed(drawn, pipeline).await
    }

    /// `drawn` through one of `readback.slang`'s four-byte packs.
    async fn four_byte_packed(
        &self,
        drawn: &Texture,
        pack: &wgpu::ComputePipeline,
    ) -> Option<Vec<u8>> {
        let (width, height) = (drawn.width(), drawn.height());
        self.packed(
            drawn,
            pack,
            u64::from(width) * u64::from(height) * 4,
            &[width, height, 0, 0],
            (width.div_ceil(16), height.div_ceil(16)),
            <[u8]>::to_vec,
        )
        .await
    }

    /// `drawn` through `pack`, one of the pipelines on `pack_layout`.
    async fn packed<T>(
        &self,
        drawn: &Texture,
        pack: &wgpu::ComputePipeline,
        bytes: u64,
        uniform: &[u32],
        (across, down): (u32, u32),
        take: impl FnOnce(&[u8]) -> T,
    ) -> Option<T> {
        let mut recording = self.gpu.record();
        recording.holding_texture(drawn);
        let words = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("packed"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let read = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("packed read"),
            size: bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let uniform: Vec<u8> = uniform.iter().copied().flat_map(u32::to_le_bytes).collect();
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("packed uniform"),
            contents: &uniform,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let view = drawn.view();
        let group = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("packed"),
            layout: &self.pack_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: words.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform.as_entire_binding(),
                },
            ],
        });
        recording.dispatch([across, down, 1], dispatch::Whole::Measured, |pass| {
            pass.set_pipeline(pack);
            pass.set_bind_group(0, &group, &[]);
        });
        recording.copy_buffer_to_buffer(&words, 0, &read, 0, bytes);
        recording.submit();
        read_back(self.gpu, &read, take).await
    }

    /// `drawn` as the ten-bit PQ 4:2:0 planes the editor's VP9 encoder takes on Firefox
    /// (`pq420.slang`), with the canvas's SDR range coded as `matching` shows it:
    /// `Pq420Layout::header` as little-endian words, then the planes as little-endian samples.
    pub async fn pq420(
        &self,
        drawn: &Texture,
        matching: colour::sdr_match::SdrMatch,
    ) -> Option<Vec<u8>> {
        let [white, reads_sdr_as_power] = matching.words();
        let layout = Pq420Layout::of(drawn.width(), drawn.height());
        let pipeline = self.pack_pq420.get_or_init(|| {
            self.compute_pipeline("pq420", PQ420_WGSL, &self.pack_layout, "pack_pq420")
        });
        self.packed(
            drawn,
            pipeline,
            u64::from(layout.words) * 4,
            &[
                layout.width,
                layout.height,
                layout.luma_stride,
                layout.chroma_stride,
                layout.cb_at,
                layout.cr_at,
                white,
                reads_sdr_as_power,
            ],
            (
                layout.width.div_ceil(4).div_ceil(8),
                layout.height.div_ceil(2).div_ceil(8),
            ),
            |mapped| {
                let mut answer = Vec::with_capacity(PQ420_HEADER_WORDS * 4 + mapped.len());
                answer.extend(layout.header().into_iter().flat_map(u32::to_le_bytes));
                answer.extend_from_slice(mapped);
                answer
            },
        )
        .await
    }

    /// One compute pipeline over one bind group, for a pipeline built on first use.
    fn compute_pipeline(
        &self,
        label: &str,
        wgsl: &'static str,
        group: &wgpu::BindGroupLayout,
        entry_point: &str,
    ) -> wgpu::ComputePipeline {
        let module = self.gpu.describing().create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(label),
                source: wgpu::ShaderSource::Wgsl(wgsl.into()),
            });
        let layout = self.gpu.describing().create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(label),
                bind_group_layouts: &[Some(group)],
                ..Default::default()
            });
        self.gpu.describing()
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(label),
                layout: Some(&layout),
                module: &module,
                entry_point: Some(entry_point),
                compilation_options: Default::default(),
                cache: None,
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
    /// dimension allows.
    fn encode_groups(&self, pixels: usize) -> (u32, u32) {
        gpu::compute::groups(pixels.div_ceil(2))
    }

    /// Whether a frame of this many pixels fits the adapter in one dispatch.
    ///
    /// Asked rather than assumed because the answer is a hardware limit and the frames are
    /// large: 137MiB of output at 24MP, 349MiB at 61MP. One question covers both bindings now
    /// that the output is packed - six bytes a pixel is exactly what the frame takes - where a
    /// `u32` per component made the output the larger of the two and this the only one asked
    /// about.
    ///
    /// A caller that gets `false` therefore has to band the frame or grade it another way;
    /// what it must not do is dispatch and find out, since a binding over the limit is a
    /// validation error and `on_uncaptured_error` makes those fatal.
    pub fn fits(&self, pixels: usize) -> bool {
        Self::binding_bytes(pixels) <= self.gpu.most_bound()
    }
}

/// What `encodeLayout` names on the client, in one list so the layout and the bind group
/// cannot drift apart.
const ENCODE_BINDINGS: [(u32, Binding); 18] = [
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
    (15, Binding::Volume),
    (17, Binding::Detail),
    (19, Binding::Detail),
    (21, Binding::Detail),
];

/// `drawLayout` on the client: `ENCODE_BINDINGS` without the buffer the encode writes, and seen by
/// the fragment stage rather than by a compute one.
const DRAW_BINDINGS: [(u32, Binding); 17] = [
    (0, Binding::Uniform),
    (1, Binding::Storage { read_only: true }),
    (2, Binding::Curves),
    (3, Binding::Volume),
    (4, Binding::Storage { read_only: true }),
    (5, Binding::Storage { read_only: true }),
    (7, Binding::Sampler),
    (9, Binding::Pyramid),
    (10, Binding::Volume),
    (11, Binding::Volume),
    (12, Binding::Storage { read_only: true }),
    (13, Binding::Detail),
    (14, Binding::Storage { read_only: true }),
    (15, Binding::Volume),
    (17, Binding::Detail),
    (19, Binding::Detail),
    (21, Binding::Detail),
];

/// What the canvas holds, and what a native draw renders into: extended-range float, because the
/// values the fragment shader writes are display nits over an SDR white and go past one.
const CANVAS_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

/// Everything the grade settles for one photo, before any rendition's size or display.
pub struct SceneGrade<'a> {
    levels: Levels,
    reference: Light<SceneNits>,
    exposure: Option<Stops>,
    /// The reader's own sliders. Settled on the photo like the levels and the colour, and
    /// for the same reason: two sizes of one photograph must not be adjusted differently.
    adjust: crate::grade::Adjust,
    /// The illuminant the decode balanced against, which the pair in `adjust` moves away from.
    /// Settled on the photo like everything else here: two sizes of it must not be balanced
    /// against two different baselines.
    as_shot: Option<colour::white_balance::Illuminant>,
    /// The camera match, whatever `adjust`'s profile asks of it (`crate::grade::Grade::colour`).
    colour: Option<&'a HdrColour>,
}

impl<'a> SceneGrade<'a> {
    /// No frame and no GPU. The matched arm's peak is measured off the frame that is already
    /// uploaded, by the shader, in `crate::grade::Uploaded::measure_peak` - so what is left here is
    /// what the uniform carries.
    ///
    /// Infallible, and [`Anchored`] is what makes that true rather than assumed: a white of zero
    /// cannot reach here, because every caller has to floor it before coding the frame with it.
    pub fn new(
        colour: Option<&'a HdrColour>,
        levels: Anchored,
        reference: Light<SceneNits>,
        exposure: Option<Stops>,
        adjust: crate::grade::Adjust,
        as_shot: Option<colour::white_balance::Illuminant>,
    ) -> Self {
        assert!(
            exposure.is_none_or(|stops| stops.raw().is_finite()),
            "an exposure is a number of stops: {exposure:?}"
        );
        SceneGrade {
            levels: *levels,
            reference,
            exposure,
            colour,
            adjust,
            as_shot,
        }
    }

    /// This scene as the shader's uniform wants it.
    ///
    /// Assembled here so the fields stay private and so the one place that knows what a
    /// scene *is* is the one place that describes it to the GPU.
    ///
    /// No scene peak: the matched arm's is measured on the GPU off the uploaded frame, and
    /// the neutral arm's is `source_level / white` scaled by the reference, which the shader
    /// does for itself from the two fields below.
    pub fn gpu_grade(
        &'a self,
        width: usize,
        height: usize,
        output: crate::grade::Output,
    ) -> crate::grade::Grade<'a> {
        crate::grade::Grade {
            colour: self.colour,
            exposure: self.exposure,
            adjust: self.adjust.clone(),
            as_shot: self.as_shot,
            output,
            ..crate::grade::Grade::new(
                width,
                height,
                self.levels,
                self.reference,
                output.mastered(self.reference),
            )
        }
    }
}
/// The gamut and the tone mapping every canvas the editor draws on is configured with.
///
/// **One constant because there is more than one canvas**: the stage and the loupe, and a
/// magnifier that tone mapped differently from the picture under it is the one fault a loupe
/// cannot have. `ExtendedDisplayP3` is wgpu's spelling of `colorSpace: "display-p3"` with
/// `toneMapping: { mode: "extended" }` - values past one reach the panel rather than being
/// clamped, and the gamut is the wide one (§7).
///
/// Read by [`Stage::resize`], so only in a browser: there is no canvas on this side to configure.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
const CANVAS_COLOR_SPACE: wgpu::SurfaceColorSpace = wgpu::SurfaceColorSpace::ExtendedDisplayP3;

/// The editor's canvas, as a surface on the device that prepared the frame.
///
/// **This is what keeps the frame on the GPU.** A `GPUDevice` does not cross a worker boundary and
/// a texture does not cross one either, so a canvas owned by the page and a frame owned by this
/// module could only meet through the host - the frame down into wasm memory, across as bytes, and
/// up again into a second device's buffer, every open. Handed the canvas instead
/// ([`crate::wasm::Editor::attach_stage`]), the draw is one more pass on the queue that already holds the
/// prepare, and nothing is read back at all.
///
/// `ExtendedDisplayP3` is `colorSpace: "display-p3"` with `toneMapping: { mode: "extended" }`,
/// which is what the page configured its context with and what §7 measured: values past one reach
/// the panel rather than being clamped, and the gamut is the wide one.
#[cfg(target_arch = "wasm32")]
pub struct Stage {
    target: StageTarget,
    width: u32,
    height: u32,
    /// Held for a video rather than a canvas, read back by [`Grader::pq420`] coded to this match.
    video: Option<colour::sdr_match::SdrMatch>,
}

#[cfg(target_arch = "wasm32")]
enum StageTarget {
    Surface(wgpu::Surface<'static>, web_sys::OffscreenCanvas),
    /// A texture of this module's, read back for the page to show itself: by [`Grader::rgb9e5`] for a
    /// canvas, since WebKit caps what a transferred one may show at 1000 nits over 203, and by
    /// [`Grader::pq420`] for a video, since Firefox shows HDR in nothing else.
    Held(Option<Texture>),
}

#[cfg(target_arch = "wasm32")]
impl Stage {
    /// Takes a canvas the page transferred into this worker, at the size it is already sized to.
    ///
    /// None where the browser refuses a surface on it, which is a tab that shows no picture rather
    /// than one that fails: the caller says so and the editor stays closed.
    pub fn attach(
        gpu: &'static Gpu,
        canvas: web_sys::OffscreenCanvas,
        width: u32,
        height: u32,
    ) -> Option<Stage> {
        let surface = gpu
            .instance()
            .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
            .ok()?;
        let mut held = Stage {
            target: StageTarget::Surface(surface, canvas),
            width: 0,
            height: 0,
            video: None,
        };
        held.resize(gpu, width, height);
        Some(held)
    }

    /// A stage drawn into a texture rather than a canvas, for the page to be sent ([`Stage::drawn`])
    /// as a canvas's words or, with `video`, as a video frame's planes.
    pub fn held(
        gpu: &Gpu,
        width: u32,
        height: u32,
        video: Option<colour::sdr_match::SdrMatch>,
    ) -> Stage {
        let mut held = Stage {
            target: StageTarget::Held(None),
            width: 0,
            height: 0,
            video,
        };
        held.resize(gpu, width, height);
        held
    }

    /// The backing store the reader's box asks for, which changes with the stage and the density.
    ///
    /// Configured rather than merely resized: a WebGPU canvas has no separate resize, and the
    /// dimensions are members of the configuration itself.
    pub fn resize(&mut self, gpu: &Gpu, width: u32, height: u32) {
        let (width, height) = (width.max(1), height.max(1));
        if (width, height) == (self.width, self.height) {
            return;
        }
        match &mut self.target {
            StageTarget::Surface(surface, _) => gpu.configure(
                surface,
                &wgpu::SurfaceConfiguration {
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                    format: CANVAS_FORMAT,
                    color_space: CANVAS_COLOR_SPACE,
                    width,
                    height,
                    present_mode: wgpu::PresentMode::Fifo,
                    desired_maximum_frame_latency: 2,
                    alpha_mode: wgpu::CompositeAlphaMode::Opaque,
                    view_formats: Vec::new(),
                },
            ),
            StageTarget::Held(texture) => {
                *texture = Some(gpu.own_texture(&wgpu::TextureDescriptor {
                    label: Some("held stage"),
                    size: wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: CANVAS_FORMAT,
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                        | wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                }));
            }
        }
        (self.width, self.height) = (width, height);
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// What the last draw wrote, where this stage is held rather than a canvas, and the match a
    /// video is coded to where it is held for one.
    pub fn drawn(&self) -> Option<(Texture, Option<colour::sdr_match::SdrMatch>)> {
        match &self.target {
            StageTarget::Held(texture) => texture.clone().map(|texture| (texture, self.video)),
            StageTarget::Surface(..) => None,
        }
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    type CanvasContext;
    #[wasm_bindgen(method)]
    fn unconfigure(this: &CanvasContext);
}

#[cfg(target_arch = "wasm32")]
impl Drop for Stage {
    fn drop(&mut self) {
        use wasm_bindgen::JsCast;
        // wgpu's web surface drops as a no-op: the context would hold its swap images until the
        // worker's GC finds the canvas, which an editor reopening its wheel outruns on a phone.
        if let StageTarget::Surface(_, canvas) = &self.target
            && let Ok(Some(context)) = canvas.get_context("webgpu")
        {
            context.unchecked_into::<CanvasContext>().unconfigure();
        }
    }
}

/// One tick, onto the image the canvas handed over.
///
/// **Nothing comes back.** The draw writes the swapchain's own texture and presents it, so a tick
/// is a uniform write, a pass and a submit - where the page's copy of this had to have the graded
/// frame in a buffer of its own first.
#[cfg(target_arch = "wasm32")]
pub fn present(
    uploaded: &Uploaded<'_>,
    stage: &Stage,
    grade: &Grade<'_>,
    pyramid: &crate::base::Pyramid,
    print: Option<&crate::print::Scene>,
) {
    use wgpu::CurrentSurfaceTexture::{Suboptimal, Success};
    let surface = match &stage.target {
        StageTarget::Surface(surface, _) => surface,
        StageTarget::Held(texture) => {
            let Some(texture) = texture else { return };
            let mut recording = uploaded.grader.gpu.record();
            recording.holding_texture(texture);
            uploaded.draw_into(
                &mut recording,
                grade,
                pyramid,
                &texture.view(),
                print,
                false,
            );
            recording.submit();
            return;
        }
    };
    // Suboptimal draws too: the image is the right one and only its configuration has drifted,
    // which the next `resize` settles. Everything else - a timeout, an occluded tab, a canvas
    // resized under the surface - skips this tick rather than drawing a stale image.
    let (Success(image) | Suboptimal(image)) = surface.get_current_texture() else {
        return;
    };
    let target = image.texture.create_view(&Default::default());
    let mut recording = uploaded.grader.gpu.record();
    uploaded.draw_into(&mut recording, grade, pyramid, &target, print, false);
    recording.submit();
    uploaded.grader.gpu.queue.present(image);
}

/// `white_balance.slang`, which writes the matrix everything above reads.
const BALANCE_BINDINGS: [(u32, Binding); 2] = [
    (0, Binding::Uniform),
    (14, Binding::Storage { read_only: false }),
];

/// `detail.slang`'s four entry-point shapes, on layouts of their own: the downscale reads the
/// frame and the decode table, the moments read the working texture, the box means and the fit
/// read only the 32-bit texture before them, and the last reads both.
const DETAIL_SHRINK_BINDINGS: [(u32, Binding); 4] = [
    (0, Binding::Uniform),
    (1, Binding::Storage { read_only: true }),
    (3, Binding::Written),
    (12, Binding::Storage { read_only: true }),
];

/// The order the guided filter's entry points run in.
///
/// A different order, or one box mean where it ran two, is a different neighbourhood from the same
/// frame - and nothing in the graded fixtures could see it, since those are pinned at every slider
/// zero where `adjusted` returns before it samples this texture at all. So it is stated as data
/// and pinned by `test/fixtures/tables/detail-passes.txt`, which makes a reordering deliberate.
///
/// The ping-pong between the two 32-bit textures is derived from this rather than written out:
/// every pass reads what the one before it wrote.
pub const DETAIL_PASSES: [&str; 6] = [
    "shrink",
    "moments_of",
    // Both means, and both bilateral: gathering the moments over a box and averaging the fitted
    // models over a box are the two ways a dark surface's statistics reach the bright pixels
    // beside it, which is a halo (`detail.slang`).
    "window_mean",
    "coefficients",
    "window_mean",
    "apply_guided",
];

const DETAIL_MOMENTS_BINDINGS: [(u32, Binding); 2] = [(2, Binding::Detail), (16, Binding::Wrote32)];

const DETAIL_BOX_BINDINGS: [(u32, Binding); 2] = [(15, Binding::Read32), (16, Binding::Wrote32)];

/// The uniform as well, for `detail_long`: the fine reference's sigma is a fraction of the
/// *photograph's* working texture and this pass may be writing a piece of one.
const DETAIL_APPLY_BINDINGS: [(u32, Binding); 4] = [
    (0, Binding::Uniform),
    (2, Binding::Detail),
    (15, Binding::Read32),
    (3, Binding::Written),
];

/// The mean, which needs the guide as well as what it is averaging: it has to know which taps
/// describe the same surface as the texel it is writing. And the uniform, for the window's own
/// width, which is `detail_long`'s to say for the same reason.
const DETAIL_MEAN_BINDINGS: [(u32, Binding); 4] = [
    (0, Binding::Uniform),
    (2, Binding::Detail),
    (15, Binding::Read32),
    (16, Binding::Wrote32),
];

/// The same colour bindings the encode takes, and the histogram, the peak and the candidates all
/// writable where the encode reads the peak and writes only the frame.
/// What the model pass binds of an upload, before the `Uploaded` that owns them exists.
struct ChromaModelInputs<'a> {
    matrix: &'a wgpu::Buffer,
    curves: &'a wgpu::TextureView,
    chroma: &'a wgpu::TextureView,
    chroma_luma: &'a wgpu::TextureView,
    neighbourhood: &'a wgpu::TextureView,
    mean: &'a wgpu::TextureView,
    detail: &'a wgpu::TextureView,
}

/// What `chroma_smooth.slang`'s model pass reads: the colour transform's own set, and the
/// texture it writes.
const CHROMA_MODEL_BINDINGS: [(u32, Binding); 14] = [
    (0, Binding::Uniform),
    (1, Binding::Storage { read_only: true }),
    (2, Binding::Curves),
    (3, Binding::Volume),
    (4, Binding::Storage { read_only: true }),
    (7, Binding::Sampler),
    (10, Binding::Volume),
    (12, Binding::Storage { read_only: true }),
    (13, Binding::Detail),
    (14, Binding::Storage { read_only: true }),
    (17, Binding::Detail),
    (19, Binding::Detail),
    (21, Binding::Detail),
    (22, Binding::Written),
];

const PEAK_BINDINGS: [(u32, Binding); 18] = [
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
    (15, Binding::Volume),
    (17, Binding::Detail),
    (19, Binding::Detail),
    (21, Binding::Detail),
];

/// `BINS` in `peak.slang`, which this sizes the buffer for.
const PEAK_BINS: u64 = 8192;

/// `CANDIDATES` in `peak.slang`, likewise.
const PEAK_CANDIDATES: u64 = 16384;

#[derive(Clone, Copy)]
enum Binding {
    Uniform,
    Storage {
        read_only: bool,
    },
    /// `r32float`, which without `float32-filterable` is unfilterable - and is only ever
    /// loaded, never sampled.
    Curves,
    Volume,
    Sampler,
    /// Declared by `frame.slang` and unread at `lod` 0, but an explicit layout has to supply
    /// everything the module declares.
    Pyramid,
    /// `detail.slang`'s output: the fine reference in stops, then the smooth fit's `a` and `b`
    /// for the grade to evaluate against the pixel's own luma, then the guided-filtered dark
    /// channel. Filterable, because the grade samples it at a frame coordinate rather than a
    /// texel of it - and because interpolating that pair is what a guided filter upsamples with.
    Detail,
    /// The same texture where a pass is writing it.
    Written,
    /// The guided filter's moments and coefficients. `rgba32float`, which is unfilterable
    /// wherever it is read - and it is only ever loaded, never sampled.
    Read32,
    Wrote32,
    /// A texture a draw wrote, `CANVAS_FORMAT`, loaded a texel at a time.
    Drawn,
}

impl Binding {
    const fn entry(self, binding: u32) -> wgpu::BindGroupLayoutEntry {
        self.seen_by(binding, wgpu::ShaderStages::COMPUTE)
    }

    /// The same binding for the draw, whose only difference from the encode is the stage that
    /// reads it.
    const fn drawn(self, binding: u32) -> wgpu::BindGroupLayoutEntry {
        self.seen_by(binding, wgpu::ShaderStages::FRAGMENT)
    }

    const fn seen_by(
        self,
        binding: u32,
        visibility: wgpu::ShaderStages,
    ) -> wgpu::BindGroupLayoutEntry {
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
            Binding::Read32 | Binding::Drawn => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            Binding::Wrote32 => wgpu::BindingType::StorageTexture {
                access: wgpu::StorageTextureAccess::WriteOnly,
                format: wgpu::TextureFormat::Rgba32Float,
                view_dimension: wgpu::TextureViewDimension::D2,
            },
        };
        wgpu::BindGroupLayoutEntry {
            binding,
            visibility,
            ty,
            count: None,
        }
    }
}

/// Everything a grade needs that is not the frame itself.
#[derive(Clone)]
pub struct Grade<'a> {
    pub width: usize,
    pub height: usize,
    /// The long edge of the *photograph* this frame is a piece of, which is its own for every
    /// caller but the loupe's tile.
    ///
    /// Only the presence sliders read it, through the working texture `detail.slang` blurs on: how
    /// large a share of the picture that blur covers is a property of the photograph, and a crop
    /// left to answer it from its own dimensions applies a different Clarity from the export.
    pub photograph_long: units::px::Span<units::px::Output>,
    /// The camera match, whatever the profile: its exposure, curve and saturation are where the
    /// sliders start on both. [`Grade::matched`] is the part a None profile leaves out.
    pub colour: Option<&'a HdrColour>,
    /// `tone::Levels`, as the uniform's `white`, `source_level` and `black_floor`.
    pub white: units::light::Light<units::light::Level>,
    pub source_level: units::light::Light<units::light::Level>,
    /// None where nothing walked a histogram for this frame, and then `adjust.slang` places the low
    /// pair at their deepest - which is where a photograph with real black in it puts them anyway.
    pub floor: Option<units::light::Light<units::light::Level>>,
    /// What diffuse white is anchored to, which is the divisor between the scene's nits and the
    /// scene-relative units the fit and the sliders are written in.
    pub reference_nits: units::light::Light<units::light::SceneNits>,
    /// Where this target's highlights roll into: [`Output::mastered`] for a rendition, and the
    /// display's own peak for a draw.
    pub peak_nits: units::light::Light<units::light::DisplayNits>,
    /// None resolves to the camera match's exposure, or zero without a match.
    pub exposure: Option<units::light::Stops>,
    /// The reader's own sliders, on Camera Raw's -100..100 scales.
    pub adjust: Adjust,
    /// The illuminant the camera balanced this frame for, which is the baseline the reader's
    /// temperature and tint move away from. None where the file recorded no usable
    /// multipliers, in which case there is nothing to move relative to and the pair is ignored.
    pub as_shot: Option<colour::white_balance::Illuminant>,
    /// Which transfer to write. The grade is the same either way; an SDR target differs by
    /// having its `peak_nits` at diffuse white ([`Output::mastered`]) and by ending here.
    pub output: Output,
    /// The reader's crop, straighten and quarter turn, applied in the same dispatch as the grade.
    ///
    /// **Where a rendition applies it too, and that is what makes the two hosts one pipeline.** The
    /// editor has never had a choice - a reader dragging a crop handle would otherwise re-prepare
    /// the frame on every frame - so this is the draw's own mapping (`geometry.slang`), and a
    /// rendition reaching it through the same uniform is the same picture rather than a second
    /// route that agrees.
    pub geometry: geometry::warp::Geometry,
    /// Where the frame above sits in the photograph, when it is only a piece of one.
    ///
    /// **None is the whole picture**, which is the editor and every rendition that had no crop to
    /// decode less of - so the common case says nothing rather than repeating the frame's own size.
    pub window: Option<Window>,
    /// Where this frame sits in the photograph for the neighbourhood thumb alone: a loupe
    /// tile applies no geometry - `window` stays `None` there - but the thumb is the
    /// photograph's and has to be read in its UV. `None` falls back to `window`, then to
    /// the frame being the whole picture.
    pub neighbourhood_window: Option<Window>,
    /// What a draw is showing, where this grade is being drawn rather than encoded.
    ///
    /// None everywhere a rendition runs - `encode` reads none of these fields - and the words go
    /// out as zeroes there.
    pub canvas: Option<Canvas>,
    /// How an sRGB output or a print is brought inside its gamut. A PQ draw rolls off to its
    /// display and never looks at this.
    pub intent: Intent,
    /// How far one printed mark reaches (`print::Scene::ink_blur`); zero everywhere but a print.
    pub print_blur: units::px::Extent<units::px::Output>,
    /// The output rows an encode writes. None writes every row.
    pub band: Option<Band>,
    /// Only the stage's draw reads it; None everywhere else.
    pub reach_mask: Option<ReachMask>,
}

/// One colour edit's reach shown on the stage: what it does not reach, taken towards black.
#[derive(Clone, Debug)]
pub struct ReachMask {
    pub node: colour::lattice::ColourNode,
    /// 0 draws the picture as it is, 1 draws what the edit does not reach black.
    pub strength: f64,
}

/// How a picture is brought inside what its target can show. `gamut_map.slang` reads these by
/// number, so a variant's place in this list is its number there.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Intent {
    /// ICC's perceptual: the whole range compressed, highlights rolled and the gamut's edge
    /// approached through a knee, so gradients survive.
    Perceptual,
    /// ICC's relative colorimetric: every colour the target can show left exactly, and the rest
    /// clipped to its edge.
    RelativeColorimetric,
    /// Highlights rolled on luma from lower down and brought inside the gamut at that luma, so a
    /// bright saturated light gives up its colour on the way to white.
    #[default]
    ToWhite,
}

/// The reader's view: which rectangle of the output is on screen, and how large the screen is.
///
/// **The only thing that differs between the editor's draw and a rendition's dispatch.** Both run
/// `frame.slang` over the same frame through the same geometry; a rendition writes one output pixel
/// per output pixel, and a draw writes one per *canvas* pixel and averages whatever falls inside it
/// (`covered`). So zoom and pan are these four numbers rather than another route through the grade.
#[derive(Clone, Copy)]
pub struct Canvas {
    /// The window on the output, in output pixels: what pan and zoom move.
    pub region: (f64, f64, f64, f64),
    /// The canvas itself, in its own pixels - the browser's, which are neither the frame's nor the
    /// output's however the two happen to compare at one zoom.
    pub size: units::px::Size<units::px::Canvas>,
    /// How deep the pyramid bound with it goes. Zero draws from the frame's buffer whatever the
    /// ratio, which is what a tile does: it is only ever magnified.
    pub max_lod: u32,
}

/// A frame that is a window on a larger photograph, for the geometry's sake.
///
/// The crop fractions and the straighten are defined over the *photograph*, so a render that let
/// its crop restrict the decode has to say what the photograph was and where its buffer starts in
/// it. `geometry.slang` reads both, and takes the origin off after the mapping rather than before -
/// `warp.slang`'s `Params::centre` says what folding those together costs.
/// **Both in the pixels of the frame being graded**, which at `Scale::Half` are not the
/// photograph's. Handing this the unhalved photograph while the buffer beside it was halved put
/// the crop's fractions over a picture twice the size of the one they were fractions of.
#[derive(Clone, Copy)]
pub struct Window {
    pub photograph: units::px::Size<units::px::Drawn>,
    pub origin: units::px::At<units::px::Drawn>,
}

impl<'a> Grade<'a> {
    /// A whole `width` by `height` frame graded as it stands: no colour match, no edits, upright,
    /// written as PQ, and drawn nowhere.
    pub fn new(
        width: usize,
        height: usize,
        levels: colour::tone::Levels,
        reference_nits: units::light::Light<units::light::SceneNits>,
        peak_nits: units::light::Light<units::light::DisplayNits>,
    ) -> Grade<'a> {
        Grade {
            width,
            height,
            photograph_long: units::px::Span::measured(width.max(height)),
            colour: None,
            white: levels.white,
            source_level: levels.peak,
            floor: levels.floor,
            reference_nits,
            peak_nits,
            exposure: None,
            adjust: Adjust::none(),
            as_shot: None,
            output: Output::Pq,
            geometry: geometry::warp::Geometry::none(),
            window: None,
            neighbourhood_window: None,
            canvas: None,
            intent: Intent::default(),
            print_blur: units::px::Extent::measured(0.0),
            band: None,
            reach_mask: None,
        }
    }

    /// The same grade, writing only `band` of its output.
    pub fn banded(self, band: Band) -> Grade<'a> {
        Grade {
            band: Some(band),
            ..self
        }
    }

    /// The same grade showing the reader's crop, straighten and turn.
    pub fn showing(self, geometry: geometry::warp::Geometry) -> Grade<'a> {
        Grade { geometry, ..self }
    }

    /// The same grade over a frame that is a *piece* of `photograph`.
    ///
    /// **The one place a piece takes the whole picture's scale.** `detail.slang` blurs at a fraction
    /// of the photograph's long edge, so a frame answering that from its own dimensions applies a
    /// Clarity the export never does - twelve times finer, for a loupe tile. Three callers need the
    /// rule and each spelled it, which is one rule too many for something that fails as a
    /// photograph rather than as an error.
    pub fn within(self, photograph: (usize, usize)) -> Grade<'a> {
        Grade {
            photograph_long: units::px::Span::measured(photograph.0.max(photograph.1)),
            ..self
        }
    }

    /// The same grade, drawn onto a canvas: what a tick is, against what an encode is.
    pub fn onto(self, canvas: Canvas) -> Grade<'a> {
        Grade {
            canvas: Some(canvas),
            ..self
        }
    }

    /// The same grade over a window on a larger photograph, which the geometry reads across.
    ///
    /// Takes the blur's scale with it: a window is a piece by definition. A loupe tile is a piece
    /// too and does *not* come through here - it applies no geometry, so `geometry_at` has to stay
    /// the identity over its buffer - which is why [`Grade::within`] is separable.
    pub fn windowed(
        self,
        photograph: units::px::Size<units::px::Drawn>,
        origin: units::px::At<units::px::Drawn>,
    ) -> Grade<'a> {
        Grade {
            window: Some(Window { photograph, origin }),
            ..self.within(photograph.raw())
        }
    }

    /// The match's colour as this grade renders it: none under a None profile, whose tone still
    /// comes off `colour`.
    pub fn matched(&self) -> Option<&'a HdrColour> {
        self.adjust.colour(self.colour)
    }

    /// The photograph this frame is of, which is its own unless a crop cut the decode down.
    pub fn photograph(&self) -> (usize, usize) {
        self.window
            .map_or((self.width, self.height), |w| w.photograph.raw())
    }

    /// The same grade with the neighbourhood thumb read at this frame's place in the
    /// photograph - the loupe tile's half of [`Grade::windowed`], which it cannot use
    /// because a tile applies no geometry.
    pub fn neighbourhood_windowed(
        self,
        photograph: units::px::Size<units::px::Drawn>,
        origin: units::px::At<units::px::Drawn>,
    ) -> Grade<'a> {
        Grade {
            neighbourhood_window: Some(Window { photograph, origin }),
            ..self
        }
    }

    /// What this grade writes: the photograph, through the geometry.
    ///
    /// **Its own space, not a rectangle of the frame.** A straighten's bounding box can exceed the
    /// frame it was cut from, so a caller sizing a buffer or a dispatch off `width`/`height`
    /// instead of this under-allocates and writes a picture with an unwritten tail.
    pub fn output(&self) -> units::px::Size<units::px::Output> {
        let (width, height) = self.photograph();
        geometry::warp::cropped_out(units::px::Size::exact(width, height), self.geometry)
    }

    /// The same, as the two numbers a dispatch and a buffer size want.
    pub fn output_size(&self) -> (usize, usize) {
        self.output().raw()
    }

    /// The rows of that output an encode writes: all of them, or its band.
    pub fn written(&self) -> Band {
        self.band.unwrap_or(Band {
            top: units::px::Place::ORIGIN,
            rows: self.output().height,
        })
    }

    /// What an encode writes, as the two numbers a buffer wants.
    pub fn written_size(&self) -> (usize, usize) {
        (self.output().width.raw(), self.written().rows.raw())
    }
}

/// Every slider but the exposure, as `adjust.slang` reads them.
///
/// Its own type rather than ten fields on [`Grade`] because they travel together from the
/// stored document all the way to the uniform, and a caller that has none of them says so
/// once with [`Adjust::none`] rather than ten times.
///
/// The last three are the presence group, which read the blur `detail.slang` builds rather
/// than the pixel alone. They are terms in the same function as the rest - what the blur
/// costs is a pass at upload, not a second grade.
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Adjust {
    pub contrast: f64,
    pub highlights: f64,
    pub shadows: f64,
    pub whites: f64,
    pub blacks: f64,
    pub tone_curve: Option<ToneCurve>,
    pub vibrance: f64,
    /// `sat_adjust` in the shader: `saturation` there is the camera match's own multiplier. None
    /// is the camera's, as for the exposure.
    pub saturation: Option<f64>,
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
    /// Whether a None half is the camera match's illuminant rather than the camera's own: a
    /// document still awaiting the match, which has no numbers to state yet.
    pub camera_balance: bool,
    pub colour_profile: ColourProfile,
    pub colour_nodes: Vec<colour::lattice::ColourNode>,
}


#[derive(Clone, Copy, Default, PartialEq, Eq, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColourProfile {
    #[default]
    Matched,
    None,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "ToneCurveData", into = "ToneCurveData")]
pub enum ToneCurve {
    /// PCHIP harmonic spline, flat below and linear above, on cbrt(luma / white) / 2 to +3 stops.
    PchipCbrt3 { points: Vec<[f64; 2]> },
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind")]
enum ToneCurveData {
    #[serde(rename = "pchipCbrt3")]
    PchipCbrt3 { points: Vec<[f64; 2]> },
}

impl TryFrom<ToneCurveData> for ToneCurve {
    type Error = &'static str;

    fn try_from(value: ToneCurveData) -> Result<Self, Self::Error> {
        let ToneCurveData::PchipCbrt3 { points } = value;
        if !units::light::curve_is_valid(&points) {
            return Err("tone curve points must be finite, ordered, and inside [0,1]");
        }
        Ok(Self::PchipCbrt3 { points })
    }
}

impl From<ToneCurve> for ToneCurveData {
    fn from(value: ToneCurve) -> Self {
        let ToneCurve::PchipCbrt3 { points } = value;
        Self::PchipCbrt3 { points }
    }
}

impl ToneCurve {
    pub fn points(&self) -> &[[f64; 2]] {
        match self {
            ToneCurve::PchipCbrt3 { points } => points,
        }
    }
}

impl Adjust {
    /// The picture as the camera rendered it, which is what an unedited photo asks for.
    pub fn none() -> Self {
        Self::default()
    }

    pub fn colour<'a>(&self, matched: Option<&'a HdrColour>) -> Option<&'a HdrColour> {
        matched.filter(|_| self.colour_profile == ColourProfile::Matched)
    }

    /// Whether this, at `exposure`, is the camera match's own rendering: every slider at rest, and
    /// the four the match fits either unset or at the match's own values.
    pub fn at_the_camera(
        &self,
        exposure: Option<units::light::Stops>,
        colour: Option<&HdrColour>,
    ) -> bool {
        let curve = colour.map_or(units::light::IDENTITY_CURVE.as_slice(), |c| {
            c.curve.as_slice()
        });
        let camera_exposure = colour.map_or(units::light::Stops::ZERO, |c| c.exposure);
        let saturation = colour.map_or(0.0, HdrColour::saturation_slider);
        let illuminant = colour.and_then(|c| c.illuminant);
        let balance_at_camera = match (self.temperature, self.tint) {
            (None, None) => self.camera_balance || illuminant.is_none(),
            (Some(temperature), Some(tint)) => {
                illuminant.is_some_and(|i| i.temperature == temperature && i.tint == tint)
            }
            _ => false,
        };
        Adjust {
            tone_curve: None,
            saturation: None,
            temperature: None,
            tint: None,
            camera_balance: false,
            ..self.clone()
        } == Adjust::none()
            && balance_at_camera
            // At `f32`, for the reason `same_curve` gives.
            && exposure.is_none_or(|e| e.raw() as f32 == camera_exposure.raw() as f32)
            && self.saturation.is_none_or(|s| s == saturation)
            && self
                .tone_curve
                .as_ref()
                .is_none_or(|c| units::light::same_curve(c.points(), curve))
    }

    /// Whether any slider reads the neighbourhood, and so whether `detail` has to be built.
    ///
    /// **`adjust.slang`'s `local`, and it has to stay that**: the shader samples the texture only
    /// under this test, and the host builds it only under this test, so a slider added to one and
    /// not the other is either a blur nothing reads or a read of a blur nobody built.
    /// `the_detail_pass_runs_exactly_when_the_shader_reads_it` holds the two together.
    ///
    /// Not just the presence three: `tone_adjusted` weights highlights and shadows by how bright
    /// the region is rather than the pixel, so those read it too.
    pub fn reads_the_neighbourhood(&self) -> bool {
        self.texture != 0.0
            || self.clarity != 0.0
            || self.dehaze != 0.0
            || self.highlights != 0.0
            || self.shadows != 0.0
    }
}

/// The rectangle of the output a tick draws, as the page names it: zoom and pan, in output pixels.
#[derive(Clone, Copy, serde::Deserialize)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
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

impl Output {
    /// Where a rendition in this output rolls its highlights into.
    ///
    /// An HDR file is graded scene-referred, to PQ's own ceiling, and fitted to a display by
    /// whatever shows it (`stage.slang`), against the brightest pixel its `clli` names. An SDR one
    /// has nothing above diffuse white to put a highlight in.
    pub fn mastered(
        self,
        reference: units::light::Light<units::light::SceneNits>,
    ) -> units::light::Light<units::light::DisplayNits> {
        match self {
            Output::Pq | Output::Rolled => units::light::Light::PQ_CEILING,
            Output::Srgb => units::light::Light::at_diffuse_white(reference),
        }
    }
}

/// One frame, uploaded once, ready for as many dispatches as a job has outputs.
///
/// **Everything here is per photo-and-size; only the uniform is per rendition.** The frame
/// itself is the expensive part - 59MB at 3840 and 366MB at native resolution - and a job
/// naming an SDR and an HDR target of one size was uploading it, the lattice, the curves and
/// the matrix once each, then allocating a fresh output and readback pair, for every one of
/// them. What actually differs between two outputs of the same frame is `peak_nits` and
/// `output`, which are two words of a uniform.
/// The pair a balance is solved from, as the key to anything derived from one.
///
/// The reader's half of it: what the frame was shot at is the upload's own and cannot move.
#[derive(Clone, Copy, PartialEq)]
struct Illuminant {
    temperature: Option<f64>,
    tint: Option<f64>,
    camera_balance: bool,
}

impl Illuminant {
    fn of(grade: &Grade<'_>) -> Self {
        Self {
            temperature: grade.adjust.temperature,
            tint: grade.adjust.tint,
            camera_balance: grade.adjust.camera_balance,
        }
    }
}

struct NodeVolumes {
    nodes: Vec<colour::lattice::ColourNode>,
    pair: (Texture, wgpu::TextureView),
    luma: (Texture, wgpu::TextureView),
}

impl NodeVolumes {
    fn of(grader: &Grader, nodes: &[colour::lattice::ColourNode]) -> NodeVolumes {
        let (pair, luma) = match nodes.is_empty() {
            true => grader.identity_volumes(),
            false => colour::lattice::ChromaMap::of_nodes(nodes).baked(grader.gpu),
        };
        NodeVolumes {
            nodes: nodes.to_vec(),
            pair: (pair.clone(), pair.view()),
            luma: (luma.clone(), luma.view()),
        }
    }
}

pub struct Uploaded<'a> {
    grader: &'a Grader,
    print_albedo: std::cell::RefCell<Option<(f32, Buffer)>>,
    print_light: std::cell::RefCell<Option<([f32; 4], f32, crate::print::Environment, Buffer)>>,
    print_environment: std::cell::RefCell<Option<(crate::print::Environment, Texture)>>,
    printer: std::cell::RefCell<Option<std::sync::Arc<crate::printer_gamut::PrinterGamut>>>,
    print_surface: std::cell::RefCell<print_surface::Cached>,
    peak_revision: std::sync::Arc<std::sync::atomic::AtomicU64>,
    peak_cached: std::cell::RefCell<Option<(u64, Vec<u32>, Vec<colour::lattice::ColourNode>)>>,
    width: usize,
    height: usize,
    /// For the editor this is the `Resident`'s own frame, shared rather than copied.
    samples: Buffer,
    matrix: Buffer,
    peak_out: Buffer,
    histogram: Buffer,
    candidates: Buffer,
    curves: wgpu::TextureView,
    chroma: wgpu::TextureView,
    chroma_luma: wgpu::TextureView,
    neighbourhood: wgpu::TextureView,
    mean: wgpu::TextureView,
    nodes: std::cell::RefCell<NodeVolumes>,
    /// The camera's own chroma blur, and the illuminant it was built under.
    ///
    /// **Rebuilt when the reader moves the balance, because it encodes `matched_scene` and the
    /// balance is now upstream of that.** The blend in `colour.slang` replaces a pixel's chroma
    /// with this neighbourhood's, so a texture built at one illuminant and read at another does
    /// not merely age - it puts the old colour back, and the temperature slider does nothing at
    /// all. That is the editor exactly: it uploads once at `Adjust::none()` and grades every tick
    /// off that upload, where a rendition uploads with the edit already in hand and so never sees
    /// it. Measured at 2000K on a daylight frame: the tick came out 3851, 3746, 3916 against the
    /// rendition's 1441, 3749, 27156.
    ///
    /// The texture rides with the view so that replacing the pair drops the generation it
    /// replaces. Kept to one: a temperature drag rebuilds per distinct value, and a list of them
    /// would hold ~5MB a tick until the whole upload went.
    chroma_smoothed: std::cell::RefCell<(Illuminant, Texture, wgpu::TextureView)>,
    pyramid: wgpu::TextureView,
    /// The blur the neighbourhood sliders read, built off this frame at this size.
    ///
    /// **On first need rather than at upload, because an upload outlives the edit it was made
    /// with.** The editor uploads once at `Adjust::none()` and grades every later tick off that
    /// upload (`wasm.rs`), so building this only where the *upload's* adjust reads it hands a
    /// Shadows drag a texture nothing ever wrote. Deferred rather than simply unconditional
    /// because the chain opens with a pass over the whole frame, and the renditions that never
    /// read it are most of what this crate does - 2% of a graded 24MP frame, measured.
    detail: std::cell::OnceCell<wgpu::TextureView>,
    /// One texel, so a bind group keeps its shape where nothing reads the blur.
    detail_absent: wgpu::TextureView,
    /// The uniform every dispatch off this frame reads, and the balance it is solved into.
    ///
    /// Made once and rewritten, because a tick is sixty of these a second. `write_buffer` is
    /// ordered on the queue, so a rewrite lands after the submission that read the last one.
    words: Buffer,
    balance: Buffer,
    /// Where [`Uploaded::encode`] writes and what it maps to read the result, a frame each.
    ///
    /// **On the first encode rather than at upload**, because the editor never encodes at all: it
    /// draws onto a canvas, so a pair allocated here is 722MB at 61MP that no tick ever binds -
    /// and one of them is `MAP_READ`, which is host memory rather than the card's.
    encoded: std::cell::OnceCell<(Buffer, Buffer)>,
    /// The textures the views above are onto, which a `wgpu::TextureView` does not keep alive.
    /// A `RefCell` because the blur and the chroma smoothing are both built behind `&self`, on the
    /// tick that first wants one.
    held: std::cell::RefCell<Vec<Texture>>,
    /// The identity the uniform describes where a frame has no camera match, kept alive
    /// because `Grade::colour` borrows one or the other.
    identity: HdrColour,
    /// What the resources above were built from, so [`Uploaded::encode`] can refuse a grade
    /// that disagrees with them rather than dispatching against the wrong lattice.
    ///
    /// **Owned rather than borrowed**, which is what lets an editor hold one of these across
    /// ticks: the browser's frame stays up for the life of the open, and a borrow would tie it
    /// to whatever stack the match was fitted on. A few kilobytes of curves and lattice, cloned
    /// once per open against a frame of hundreds of megabytes.
    colour: Option<HdrColour>,
}

impl Grader {
    /// One `encode` dispatch: the graded frame as `u16` counts of PQ.
    ///
    /// The same entry point the editor's readback uses, so a rendition and a tick of the
    /// same photo are the same pixels by construction.
    ///
    /// For one output. A caller with several off one frame wants [`Grader::upload`], which pays
    /// for the frame once.
    pub fn encode(&self, frame: &[u16], grade: &Grade<'_>) -> Vec<u16> {
        self.upload(frame, grade, &self.scene_peak()).encode(grade)
    }

    /// An unmeasured [`ScenePeak`], for a caller about to upload one photo's frames.
    pub fn scene_peak(&self) -> ScenePeak {
        ScenePeak {
            buffer: self.gpu.own_buffer(&wgpu::BufferDescriptor {
                label: Some("peak_out"),
                size: 4 * 4,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
            measured: std::cell::Cell::new(false),
            revision: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    /// What a measurement left in one, in nits.
    ///
    /// The number itself, for a caller that has to hand it to a frame holding a piece of the same
    /// photograph: a loupe tile, and the analysis a job keeps beside the photograph so no later
    /// render measures it again (`crate::photo_analysis`). The renditions of one job never ask -
    /// they pass the buffer along and the CPU stays out of it.
    pub fn read_peak(&self, peak: &ScenePeak) -> f32 {
        pollster::block_on(self.peak_of(peak)).expect("the readback mapped")
    }

    /// [`Self::read_peak`], awaited.
    pub async fn peak_of(&self, peak: &ScenePeak) -> Option<f32> {
        let mut recording = self.gpu.record();
        let staging = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("peak readback"),
            size: 4,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        recording.copy_buffer_to_buffer(&peak.buffer, 0, &staging, 0, 4);
        recording.submit();
        read_back(self.gpu, &staging, |mapped| {
            f32::from_le_bytes([mapped[0], mapped[1], mapped[2], mapped[3]])
        })
        .await
    }

    /// The peak a caller already knows, which nothing will then measure.
    ///
    /// **For a frame that is a piece of a photograph.** The measurement reduces whatever is
    /// uploaded, so a loupe tile measures a crop's top end - and the roll-off compresses into
    /// *that*, which is a magnifier grading its highlights differently from the picture it is
    /// held over. The editor measures the whole frame every tick and hands the number back with
    /// the tile request; `peak.slang` writes nits into word zero and this seeds the same word,
    /// so the two are the same quantity rather than two that agree.
    pub fn given_peak(&self, nits: f32) -> ScenePeak {
        let buffer = self.gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some("peak_out"),
            size: 4 * 4,
            // `COPY_SRC` as the measured one has it, so `read_peak` answers for either kind
            // rather than failing validation on whichever a test happens to hold.
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: true,
        });
        {
            let mut view = buffer
                .slice(..)
                .get_mapped_range_mut()
                .expect("a buffer mapped at creation");
            view.slice(..4).write_iter(nits.to_le_bytes());
        }
        buffer.unmap();
        // Claimed, so `upload` leaves it alone. The words above zero are the measurement's own
        // scratch and nothing but `peak.slang` reads them.
        ScenePeak {
            buffer,
            measured: std::cell::Cell::new(true),
            revision: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
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
    fn frame_buffer(&self, frame: &[u16]) -> Buffer {
        let buffer = self.gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some("frame"),
            size: ((frame.len() as u64 * 2) + 3) & !3,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: true,
        });
        {
            let mut view = buffer
                .slice(..)
                .get_mapped_range_mut()
                .expect("a buffer mapped at creation");
            view.slice(..frame.len() * 2)
                .write_iter(frame.iter().flat_map(|v| v.to_le_bytes()));
        }
        buffer.unmap();
        buffer
    }

    /// The frame and everything else a dispatch reads, uploaded once.
    pub fn upload<'a>(
        &'a self,
        frame: &[u16],
        grade: &Grade<'_>,
        peak: &ScenePeak,
    ) -> Uploaded<'a> {
        self.with_frame(self.frame_buffer(frame), grade, peak)
    }

    /// The same resources over a frame that never left the device - the render loop's
    /// spelling, which is what spares the sharpen a trip down and back up.
    ///
    /// Takes a counted handle on the resident's buffer, so the caller keeps the frame for a later
    /// downscale and neither side can free it while the other is drawing from it.
    ///
    /// The grade is read rather than held: an `Uploaded` owns the colour it was built against, so
    /// what it borrows is only the device - which is what lets an editor keep one across ticks
    /// whose grades are built and dropped one at a time.
    pub fn upload_resident<'a>(
        &'a self,
        frame: &colour::resident::Resident,
        grade: &Grade<'_>,
        peak: &ScenePeak,
    ) -> Uploaded<'a> {
        self.with_frame(frame.buffer().clone(), grade, peak)
    }

    fn with_frame<'a>(
        &'a self,
        samples: Buffer,
        grade: &Grade<'_>,
        peak: &ScenePeak,
    ) -> Uploaded<'a> {
        // The larger of what is read and what is written: a straighten's bounding box writes about
        // half again what an uncropped frame reads.
        let (out_width, out_height) = grade.written_size();
        let pixels = (grade.width * grade.height).max(out_width * out_height);
        assert!(
            self.fits(pixels),
            "a {}x{} frame graded to {}x{} needs a {}MiB storage binding and this adapter allows \
             {}MiB - a render that large is graded in bands (`job::banded`), so this caller skipped \
             them",
            grade.width,
            grade.height,
            out_width,
            out_height,
            Self::binding_bytes(pixels) / (1 << 20),
            self.gpu.limits().max_storage_buffer_binding_size / (1 << 20),
        );

        let buffer = |contents: &[u8], usage: wgpu::BufferUsages| {
            self.gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents,
                usage,
            })
        };
        // The caller's, so every size off one photograph rolls off against one measurement.
        // Only the matched arm reads it (`frame.slang`'s `rolled_off`); the neutral one
        // computes its own source peak from the levels in the uniform.
        let peak_out = peak.buffer.clone();
        let zeroed = |words: u64| {
            self.gpu.own_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: words * 4,
                // `COPY_DST` for the clear a second measurement over the same frame needs: both
                // counting entry points add into what is already there.
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let histogram = zeroed(PEAK_BINS);
        // A header and room for every candidate, as the page allocates it. `quantile` reads
        // `candidates[0]` to ask whether anything has been kept, and on the rendition path
        // nothing has: `collect` runs only where a caller asks for the editor's route, and the
        // buffer is a quarter of a megabyte beside a frame of hundreds.
        let candidates = zeroed(4 + PEAK_CANDIDATES * 4);

        let identity = HdrColour::identity();
        let described = grade.matched().unwrap_or(&identity);
        let matrix: Vec<u8> = described
            .matrix
            .iter()
            .flatten()
            .flat_map(|v| (*v as f32).to_le_bytes())
            .collect();
        let matrix = buffer(&matrix, wgpu::BufferUsages::STORAGE);

        let (chroma, chroma_luma) = self.lattice(described);
        let neighbourhood = self.neighbourhood(described);
        let mean = self.mean_frame(&samples, grade);
        let curves = self.curves(described);
        let pyramid = self.gpu.own_texture(&wgpu::TextureDescriptor {
            label: Some("pyramid"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Uint,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        // The blur itself waits for a grade that reads it ([`Uploaded::detail`]). This is the
        // one texel that stands in until then, which the chroma model binds and never reads.
        let (absent_texture, detail_absent) = self.build_detail(
            &samples,
            &uniform(grade, described),
            DetailSize {
                width: 1,
                height: 1,
            },
            false,
        );

        let view = |t: &Texture| t.view();
        let chroma_smoothed = self.chroma_smoothed(
            &samples,
            grade,
            described,
            &ChromaModelInputs {
                matrix: &matrix,
                curves: &view(&curves),
                chroma: &view(&chroma),
                chroma_luma: &view(&chroma_luma),
                neighbourhood: &view(&neighbourhood),
                mean: &view(&mean),
                detail: &detail_absent,
            },
        );
        let uploaded = Uploaded {
            grader: self,
            print_albedo: std::cell::RefCell::new(None),
            print_light: std::cell::RefCell::new(None),
            print_environment: std::cell::RefCell::new(None),
            printer: std::cell::RefCell::new(None),
            print_surface: std::cell::RefCell::new(print_surface::Cached::default()),
            peak_revision: peak.revision.clone(),
            peak_cached: std::cell::RefCell::new(None),
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
            neighbourhood: view(&neighbourhood),
            mean: view(&mean),
            nodes: std::cell::RefCell::new(NodeVolumes::of(self, &grade.adjust.colour_nodes)),
            chroma_smoothed: std::cell::RefCell::new((
                Illuminant::of(grade),
                chroma_smoothed.clone(),
                view(&chroma_smoothed),
            )),
            pyramid: view(&pyramid),
            detail: std::cell::OnceCell::new(),
            detail_absent,
            words: self.gpu.own_buffer(&wgpu::BufferDescriptor {
                label: Some("edit"),
                size: uniform(grade, described).len() as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
            balance: self.balance_buffer(),
            encoded: std::cell::OnceCell::new(),
            held: std::cell::RefCell::new(vec![
                curves,
                chroma,
                chroma_luma,
                neighbourhood,
                mean,
                pyramid,
                absent_texture,
            ]),
            identity,
            colour: grade.matched().cloned(),
        };
        // The largest size is uploaded first, so the one measurement is taken off the frame
        // with the most of the photograph in it.
        if grade.matched().is_some() && peak.claim() {
            uploaded.measure_peak(grade);
        }
        uploaded
    }

    /// The lattice's two volumes, baked from its kernels (`lattice::ChromaMap::baked`).
    pub fn lattice(&self, colour: &HdrColour) -> (Texture, Texture) {
        match &colour.chroma {
            Some(map) => map.baked(self.gpu),
            None => self.identity_volumes(),
        }
    }

    fn identity_volumes(&self) -> (Texture, Texture) {
        self.identity_lattice
            .get_or_init(|| colour::lattice::ChromaMap::identity().baked(self.gpu))
            .clone()
    }

    /// The frame's nits at the fit's own footprint (`mean_frame.slang`), where
    /// `matched_nits` reads the lattice. Built by a dispatch over the frame's own buffer,
    /// once per upload.
    ///
    /// One black texel where the grade carries no colour: `matched_nits` is the only
    /// reader and `matched` gates it off, so a neutral upload skips the whole-frame pass.
    fn mean_frame(&self, samples: &Buffer, grade: &Grade<'_>) -> Texture {
        if grade.matched().is_none() {
            return self.black_texel("mean_frame");
        }
        let (block, phase, cells) = mean_grid(grade);
        let size = wgpu::Extent3d {
            width: cells.0 * 2,
            height: cells.1,
            depth_or_array_layers: 1,
        };
        let texture = self.written_texture("mean_frame", size);
        let mut recording = self.gpu.record();
        recording.holding(samples);
        recording.holding_texture(&texture);
        // Padded to 16: WGSL binds a uniform struct at its size rounded up, same as
        // `grade::uniform`.
        let push: Vec<u8> = [
            grade.width as u32,
            grade.height as u32,
            block,
            phase.0,
            phase.1,
            (grade.reference_nits.raw() as f32).to_bits(),
            0,
            0,
        ]
        .iter()
        .flat_map(|v| v.to_le_bytes())
        .collect();
        let push = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("mean_frame push"),
            contents: &push,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let view = texture.view();
        let group = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("mean_frame"),
            layout: &self.mean_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: samples.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 19,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 20,
                    resource: push.as_entire_binding(),
                },
            ],
        });
        recording.banded(
            &self.mean_pipeline,
            [cells.0.div_ceil(8), cells.1.div_ceil(8), 1],
            |pass| pass.set_bind_group(0, &group, &[]),
        );
        texture
    }

    /// The matched colour over the frame at a texel per `chroma_shrink` pixels, encoded for
    /// display and blurred (`chroma_smooth.slang`), for `matched_nits` to take each pixel's
    /// chroma from. Once per upload beside `mean_frame`: `matched_scene` is the frame and
    /// the fit alone. One black texel where the grade carries no colour.
    fn chroma_smoothed(
        &self,
        samples: &Buffer,
        grade: &Grade<'_>,
        described: &HdrColour,
        bound: &ChromaModelInputs<'_>,
    ) -> Texture {
        if grade.matched().is_none() {
            return self.black_texel("chroma smoothed");
        }
        let (_, cells) = grid_for(grade, chroma_shrink(grade.photograph_long).raw() as u32);
        let size = wgpu::Extent3d {
            width: cells.0,
            height: cells.1,
            depth_or_array_layers: 1,
        };
        let mut recording = self.gpu.record();
        recording.holding(samples);
        let modelled = self.written_texture("chroma modelled", size);
        let across = self.written_texture("chroma blurred across", size);
        let smoothed = self.written_texture("chroma smoothed", size);
        for texture in [&modelled, &across, &smoothed] {
            recording.holding_texture(texture);
        }
        // The model's own words, with the smoothing off: this pass is what it smooths.
        let edits = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("chroma model"),
            contents: &uniform_words_with(grade, described, false)
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<u8>>(),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        // Its own pair rather than the upload's: this runs before there is an `Uploaded` to hold
        // one, and once per illuminant rather than per tick.
        let balance = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("balance"),
            size: BALANCE_FLOATS * 4,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        self.build_balance(&mut recording, &edits, &balance);
        let unread_texture = self.black_texel("chroma unread");
        recording.holding_texture(&unread_texture);
        let unread = unread_texture.view();
        let model = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("chroma model"),
            layout: &self.chroma_model_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: edits.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: samples.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(bound.curves),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(bound.chroma),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: bound.matrix.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 10,
                    resource: wgpu::BindingResource::TextureView(bound.chroma_luma),
                },
                wgpu::BindGroupEntry {
                    binding: 12,
                    resource: self.nits_of_code.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 13,
                    resource: wgpu::BindingResource::TextureView(bound.detail),
                },
                wgpu::BindGroupEntry {
                    binding: 14,
                    resource: balance.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 17,
                    resource: wgpu::BindingResource::TextureView(bound.neighbourhood),
                },
                wgpu::BindGroupEntry {
                    binding: 19,
                    resource: wgpu::BindingResource::TextureView(bound.mean),
                },
                wgpu::BindGroupEntry {
                    binding: 21,
                    resource: wgpu::BindingResource::TextureView(&unread),
                },
                wgpu::BindGroupEntry {
                    binding: 22,
                    resource: wgpu::BindingResource::TextureView(&modelled.view()),
                },
            ],
        });
        let blur =
            |recording: &mut Recording<'_>, from: &Texture, to: &Texture, horizontal: u32| {
                let push: Vec<u8> = [size.width, size.height, horizontal, 0]
                    .iter()
                    .flat_map(|v| v.to_le_bytes())
                    .collect();
                let push = recording.init(&wgpu::util::BufferInitDescriptor {
                    label: Some("chroma blur push"),
                    contents: &push,
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                self.gpu.bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("chroma blur"),
                    layout: &self.chroma_blur_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 20,
                            resource: push.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 22,
                            resource: wgpu::BindingResource::TextureView(&to.view()),
                        },
                        wgpu::BindGroupEntry {
                            binding: 23,
                            resource: wgpu::BindingResource::TextureView(&from.view()),
                        },
                    ],
                })
            };
        let passes = [
            (&self.chroma_model, model),
            (
                &self.chroma_blur,
                blur(&mut recording, &modelled, &across, 1),
            ),
            (
                &self.chroma_blur,
                blur(&mut recording, &across, &smoothed, 0),
            ),
        ];
        for (pipeline, group) in &passes {
            recording.banded(
                pipeline,
                [size.width.div_ceil(8), size.height.div_ceil(8), 1],
                |pass| pass.set_bind_group(0, group, &[]),
            );
        }
        smoothed
    }

    fn black_texel(&self, label: &'static str) -> Texture {
        self.gpu.own_texture_with_data(
            &wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &[0; 8],
        )
    }

    fn written_texture(&self, label: &'static str, size: wgpu::Extent3d) -> Texture {
        self.gpu.own_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
    }

    /// The neighbourhood thumb as a texture the grade samples per pixel, in photograph UV.
    ///
    /// One black texel where the colour carries none, so the bind group keeps its shape;
    /// the shader gates on `has_neighbourhood` and never reads it there.
    fn neighbourhood(&self, colour: &HdrColour) -> Texture {
        let thumb = &colour.neighbourhood;
        let (width, height, data): (usize, usize, Vec<u8>) = match thumb.data.is_empty() {
            true => (1, 1, vec![0, 0]),
            false => (
                thumb.width,
                thumb.height,
                thumb.data.iter().flat_map(|v| half(*v as f32)).collect(),
            ),
        };
        self.gpu.own_texture_with_data(
            &wgpu::TextureDescriptor {
                label: Some("neighbourhood"),
                size: wgpu::Extent3d {
                    width: width as u32,
                    height: height as u32,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R16Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &data,
        )
    }

    pub fn curves(&self, colour: &HdrColour) -> Texture {
        let data: Vec<u8> = (0..3)
            .flat_map(|c| colour.curves[c].iter().map(|v| (*v as f32).to_le_bytes()))
            .flatten()
            .collect();
        self.gpu.own_texture_with_data(
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
    /// **Recorded ahead of whatever is about to grade, off that dispatch's own uniform.** The
    /// pair moves with the slider where the levels and the lattice do not, so a balance settled
    /// once with the frame is the picture as it was opened rather than as the reader is editing
    /// it - a temperature drag that changes nothing at all, since the editor holds one upload
    /// across every tick.
    ///
    /// The search itself is `white_balance.slang` rather than this file, and that is the point
    /// of the pass - both hosts need the same answer on every frame they grade, and two
    /// Robertson searches disagreeing by a few Kelvin would render as a picture rather than as
    /// an error.
    /// Written into rather than allocated, so a tick can hand the same buffer every frame.
    pub fn build_balance(
        &self,
        recording: &mut Recording<'_>,
        edits: &Buffer,
        balance: &Buffer,
    ) {
        let group = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("balance"),
            layout: &self.balance_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: edits.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 14,
                    resource: balance.as_entire_binding(),
                },
            ],
        });
        recording.dispatch([1, 1, 1], dispatch::Whole::Fixed, |pass| {
            pass.set_pipeline(&self.balance_pipeline);
            pass.set_bind_group(0, &group, &[]);
        });
    }

    pub fn balance_buffer(&self) -> Buffer {
        self.gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some("balance"),
            size: BALANCE_FLOATS * 4,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        })
    }

    /// The neighbourhood the presence sliders read, off the frame that is already up
    /// (`detail.slang`).
    ///
    /// Once per uploaded frame, like the scene peak beside it and for the same reason: it
    /// describes the photograph rather than the rendition, so every output off this frame has
    /// to read the same one. Unconditional, rather than skipped when the three sliders are
    /// zero - it is one read of the frame and a handful of box means over a 512px texture
    /// against a job that spends seconds in the decode and the encoder, and a resource that
    /// sometimes exists is a bind group that sometimes does.
    ///
    /// A pass each rather than one with several dispatches: every one of them reads the texture
    /// the one before it wrote, and a pass is where wgpu puts the barrier for that.
    ///
    /// **`DETAIL_PASSES` in order**, which is where the sequence is stated: the editor's clarity
    /// and the rendition's are the same picture because they are this same walk.
    /// Hands back the texture as well as the view onto it: a `TextureView` keeps nothing alive that
    /// a browser will free, so the caller has to hold the texture for the view to stay good.
    fn build_detail(
        &self,
        samples: &Buffer,
        edits: &[u8],
        size: DetailSize,
        wanted: bool,
    ) -> (Texture, wgpu::TextureView) {
        let mut recording = self.gpu.record();
        recording.holding(samples);
        let mut texture = |label: &str, format: wgpu::TextureFormat| {
            recording.texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: size.width,
                    height: size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING,
                view_formats: &[],
            })
        };
        let half = wgpu::TextureFormat::Rgba16Float;
        let full = wgpu::TextureFormat::Rgba32Float;
        // The frame at working resolution, and what the grade ends up binding.
        let base = texture("detail base", half).view();
        let kept = texture("detail", half);
        let detail = kept.view();
        if !wanted {
            return (kept, detail);
        }
        // The moments and the coefficients. 32 bits because a variance is a difference of two
        // nearly equal averages (`detail.slang`), and ping-ponged because a separable box mean
        // cannot read and write one texture in a pass.
        let moments = texture("detail moments", full).view();
        let spare_moments = texture("detail moments scratch", full).view();

        let edits = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("detail"),
            contents: edits,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let shrink = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("detail shrink"),
            layout: &self.detail_shrink_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: edits.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: samples.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&base),
                },
                wgpu::BindGroupEntry {
                    binding: 12,
                    resource: self.nits_of_code.as_entire_binding(),
                },
            ],
        });
        let pair = |label: &str,
                    layout: &wgpu::BindGroupLayout,
                    from: (u32, &wgpu::TextureView),
                    to: (u32, &wgpu::TextureView)| {
            self.gpu.bind_group(&wgpu::BindGroupDescriptor {
                label: Some(label),
                layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: from.0,
                        resource: wgpu::BindingResource::TextureView(from.1),
                    },
                    wgpu::BindGroupEntry {
                        binding: to.0,
                        resource: wgpu::BindingResource::TextureView(to.1),
                    },
                ],
            })
        };
        // The pair the 32-bit passes ping-pong through, swapped after each one, so which
        // texture a pass reads follows from the sequence rather than being written beside it.
        let mut held = &moments;
        let mut spare = &spare_moments;
        for name in DETAIL_PASSES {
            let (pipeline, group) = match name {
                "shrink" => (&self.detail_shrink, shrink.clone()),
                "moments_of" => (
                    &self.detail_moments,
                    pair(
                        "detail moments",
                        &self.detail_moments_layout,
                        (2, &base),
                        (16, held),
                    ),
                ),
                "window_mean" => {
                    let group = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("detail mean"),
                        layout: &self.detail_mean_layout,
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: edits.as_entire_binding(),
                            },
                            wgpu::BindGroupEntry {
                                binding: 2,
                                resource: wgpu::BindingResource::TextureView(&base),
                            },
                            wgpu::BindGroupEntry {
                                binding: 15,
                                resource: wgpu::BindingResource::TextureView(held),
                            },
                            wgpu::BindGroupEntry {
                                binding: 16,
                                resource: wgpu::BindingResource::TextureView(spare),
                            },
                        ],
                    });
                    std::mem::swap(&mut held, &mut spare);
                    (&self.detail_window_mean, group)
                }
                "apply_guided" => (
                    &self.detail_apply,
                    self.gpu.bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("detail apply"),
                        layout: &self.detail_apply_layout,
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: edits.as_entire_binding(),
                            },
                            wgpu::BindGroupEntry {
                                binding: 2,
                                resource: wgpu::BindingResource::TextureView(&base),
                            },
                            wgpu::BindGroupEntry {
                                binding: 15,
                                resource: wgpu::BindingResource::TextureView(held),
                            },
                            wgpu::BindGroupEntry {
                                binding: 3,
                                resource: wgpu::BindingResource::TextureView(&detail),
                            },
                        ],
                    }),
                ),
                // The fit itself, which is pointwise over the moments and so needs no guide.
                _ => {
                    let group = pair(
                        "detail fit",
                        &self.detail_box_layout,
                        (15, held),
                        (16, spare),
                    );
                    std::mem::swap(&mut held, &mut spare);
                    (&self.detail_coefficients, group)
                }
            };
            recording.banded(
                pipeline,
                [size.width.div_ceil(8), size.height.div_ceil(8), 1],
                |pass| pass.set_bind_group(0, &group, &[]),
            );
        }
        (kept, detail)
    }

    pub fn sampler(&self) -> &wgpu::Sampler {
        &self.sampler
    }

    pub fn layout(&self) -> &wgpu::BindGroupLayout {
        &self.layout
    }
}

/// Which of `peak.slang`'s entry points a measurement runs, the histogram and the quantile behind
/// them being the same either way.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PeakRoute {
    /// `measure`: the sampled million, which is what a rendition takes.
    WholeSample,
    /// `remeasure`: the candidates a `Collect` kept, which is what a slider takes.
    KeptCandidates,
    /// `collect`: choosing them, against the threshold a `WholeSample` left.
    Collect,
}

impl PeakRoute {
    /// Both counting entry points add into what is already there, so a second measurement over the
    /// counts the first one left reads a rank twice as deep. `collect` adds into the candidate
    /// header instead, and its own four words go the same way.
    fn cleared(self) -> std::ops::Range<u64> {
        match self {
            PeakRoute::Collect => 0..16,
            _ => 0..PEAK_BINS * 4,
        }
    }

    fn reaches_the_quantile(self) -> bool {
        self != PeakRoute::Collect
    }
}

impl Uploaded<'_> {
    /// The scene's own top end, written into `peak_out` for the dispatches that follow.
    ///
    /// **Off the frame that is already up, sampled the way the editor samples it.** Both hosts
    /// run these two passes, and what they run them *over* has to match: gathering a
    /// proportional scatter of the unwarped, unsharpened base on the CPU and uploading it as a
    /// strip is the same estimator over a different million pixels, so a thin specular one
    /// sampling catches and the other steps over moves `scene_peak` and with it where the
    /// roll-off knee lands. The parity fixtures cannot see that: both degenerate to the plain
    /// maximum at 6144 pixels.
    ///
    /// Reading the uploaded frame is also strictly less work than a strip: no gather,
    /// no second upload, and no readback, since `encode` reads `peak_out` on the GPU rather
    /// than being handed a number.
    ///
    /// Once per upload rather than once per rendition: it is a property of the photograph,
    /// and every output off this frame rolls off against the same one.
    fn measure_peak(&self, grade: &Grade<'_>) {
        self.peak_passes(grade, PeakRoute::WholeSample);
    }

    /// The same measurement the editor's slider takes, off the candidates a `Collect` kept.
    ///
    /// **The editor's route, here so that it can be held against the one a rendition takes.** A
    /// tick cannot re-sweep the frame at every slider position, so `collect` keeps the brightest
    /// of the sampled million once and `remeasure` grades only those again - and the whole claim
    /// that rests on is that the exposure cannot reorder the frame enough to push an uncollected
    /// pixel into the top hundred. That is a claim about arithmetic rather than about a browser,
    /// so it is answered in milliseconds by
    /// `the_kept_candidates_answer_as_the_whole_sample_does` rather than by opening a page.
    ///
    /// Nothing on the rendition path calls this: one exposure, measured once.
    pub fn peak_from_candidates(&self, grade: &Grade<'_>) {
        let words = uniform_words(
            &Grade {
                canvas: None,
                // The peak never reads it; a fading mask would measure the peak again every tick.
                reach_mask: None,
                ..grade.clone()
            },
            grade.matched().unwrap_or(&self.identity),
        );
        let revision = self
            .peak_revision
            .load(std::sync::atomic::Ordering::Relaxed);
        let nodes = &grade.adjust.colour_nodes;
        if self
            .peak_cached
            .borrow()
            .as_ref()
            .is_some_and(|cached| cached.0 == revision && cached.1 == words && cached.2 == *nodes)
        {
            return;
        }
        // A colour edit can lift a pixel the candidates were collected without past them.
        let route = match nodes.is_empty() {
            true => PeakRoute::KeptCandidates,
            false => PeakRoute::WholeSample,
        };
        self.peak_passes(grade, route);
        *self.peak_cached.borrow_mut() = Some((
            self.peak_revision
                .load(std::sync::atomic::Ordering::Relaxed),
            words,
            nodes.clone(),
        ));
    }

    /// The printer a print is laid down by, or none for the scene's own paper white and black.
    pub fn set_printer(&self, printer: Option<std::sync::Arc<crate::printer_gamut::PrinterGamut>>) {
        *self.printer.borrow_mut() = printer;
    }

    pub fn invalidate_print_cache(&self) {
        self.print_surface.borrow_mut().pigment = None;
        *self.peak_cached.borrow_mut() = None;
    }

    /// `collect`, over a histogram and a threshold `measure_peak` has already left.
    pub fn collect_candidates(&self, grade: &Grade<'_>) {
        self.peak_passes(grade, PeakRoute::Collect);
    }

    /// The camera's chroma blur for this grade, rebuilt if the reader has moved the illuminant
    /// since the one in hand was made ([`Uploaded::chroma_smoothed`]).
    ///
    /// Three passes at a sixteenth of the frame, and only on the tick a temperature or tint
    /// actually changes - a drag pays it once per distinct value and a grade that never touches
    /// the pair never pays it at all.
    fn chroma_smoothed_for(&self, grade: &Grade<'_>) -> std::cell::Ref<'_, wgpu::TextureView> {
        let wanted = Illuminant::of(grade);
        if self.chroma_smoothed.borrow().0 != wanted {
            let described = grade.matched().unwrap_or(&self.identity);
            let rebuilt = self.grader.chroma_smoothed(
                &self.samples,
                grade,
                described,
                &ChromaModelInputs {
                    matrix: &self.matrix,
                    curves: &self.curves,
                    chroma: &self.chroma,
                    chroma_luma: &self.chroma_luma,
                    neighbourhood: &self.neighbourhood,
                    mean: &self.mean,
                    detail: &self.detail_absent,
                },
            );
            // The generation this replaces is destroyed here, which is safe against the draws that
            // read it: those were submitted before this call, and a destroy is scheduled against
            // work in flight rather than taken from under it.
            let view = rebuilt.view();
            *self.chroma_smoothed.borrow_mut() = (wanted, rebuilt, view);
        }
        std::cell::Ref::map(self.chroma_smoothed.borrow(), |held| &held.2)
    }

    fn nodes_for(&self, grade: &Grade<'_>) -> std::cell::Ref<'_, NodeVolumes> {
        if self.nodes.borrow().nodes != grade.adjust.colour_nodes {
            *self.nodes.borrow_mut() = NodeVolumes::of(self.grader, &grade.adjust.colour_nodes);
        }
        self.nodes.borrow()
    }

    /// The blur for this grade, built the first time one asks for it.
    ///
    /// Keyed on nothing, because it is a function of the frame alone: `detail.slang` reads the
    /// size, the reference and the frame, and no slider. So the first grade to want it builds
    /// the one every later grade off this upload reads.
    fn detail_for(&self, grade: &Grade<'_>) -> &wgpu::TextureView {
        if !grade.adjust.reads_the_neighbourhood() {
            return &self.detail_absent;
        }
        self.detail.get_or_init(|| {
            let described = grade.matched().unwrap_or(&self.identity);
            let (texture, view) = self.grader.build_detail(
                &self.samples,
                &uniform(grade, described),
                detail_within(self.width, self.height, grade.photograph_long.raw()),
                true,
            );
            self.held.borrow_mut().push(texture);
            view
        })
    }

    /// This grade's words in the buffer every dispatch binds, and the balance beside it.
    ///
    /// `write_buffer` rather than a fresh buffer: the write is ordered on the queue, so it lands
    /// after whatever submission read the last set rather than changing it underneath.
    fn written(&self, grade: &Grade<'_>, described: &HdrColour) -> (&Buffer, &Buffer) {
        self.grader
            .gpu
            .queue
            .write_buffer(&self.words, 0, &uniform(grade, described));
        (&self.words, &self.balance)
    }

    fn peak_passes(&self, grade: &Grade<'_>, route: PeakRoute) {
        if route.reaches_the_quantile() {
            self.peak_revision
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        let described = grade.matched().unwrap_or(&self.identity);
        let mut recording = self.grader.gpu.record();
        let (edits, balance) = self.written(grade, described);
        // Ahead of the passes below, which grade through the whole colour transform: a balance
        // written after them puts the roll-off knee at the peak of a colour nobody sees.
        self.grader.build_balance(&mut recording, edits, balance);
        let smoothed = self.chroma_smoothed_for(grade);
        let nodes = self.nodes_for(grade);
        let group = self.grader.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("peak"),
            layout: &self.grader.peak_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: edits.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: self.samples.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&self.curves),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&self.chroma),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: self.matrix.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: self.histogram.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: self.peak_out.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&self.grader.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: self.candidates.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 10,
                    resource: wgpu::BindingResource::TextureView(&self.chroma_luma),
                },
                wgpu::BindGroupEntry {
                    binding: 11,
                    resource: wgpu::BindingResource::TextureView(&nodes.pair.1),
                },
                wgpu::BindGroupEntry {
                    binding: 15,
                    resource: wgpu::BindingResource::TextureView(&nodes.luma.1),
                },
                wgpu::BindGroupEntry {
                    binding: 12,
                    resource: self.grader.nits_of_code.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 13,
                    resource: wgpu::BindingResource::TextureView(self.detail_for(grade)),
                },
                wgpu::BindGroupEntry {
                    binding: 14,
                    resource: balance.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 17,
                    resource: wgpu::BindingResource::TextureView(&self.neighbourhood),
                },
                wgpu::BindGroupEntry {
                    binding: 19,
                    resource: wgpu::BindingResource::TextureView(&self.mean),
                },
                wgpu::BindGroupEntry {
                    binding: 21,
                    resource: wgpu::BindingResource::TextureView(&smoothed),
                },
            ],
        });

        let (_, rows) = sampled_rows(self.width, self.height);
        let over_the_sample = ((self.width as u32).div_ceil(64), rows);
        let cleared = route.cleared();
        let counted = if route == PeakRoute::Collect {
            &self.candidates
        } else {
            &self.histogram
        };
        recording.clear_buffer(counted, cleared.start, Some(cleared.end - cleared.start));
        let (pipeline, workgroups) = match route {
            PeakRoute::WholeSample => (&self.grader.peak_measure, over_the_sample),
            PeakRoute::KeptCandidates => (
                &self.grader.peak_remeasure,
                ((PEAK_CANDIDATES as u32).div_ceil(64), 1),
            ),
            PeakRoute::Collect => (&self.grader.peak_collect, over_the_sample),
        };
        recording.dispatch(
            [workgroups.0, workgroups.1, 1],
            dispatch::Whole::Fixed,
            |pass| {
                pass.set_bind_group(0, &group, &[]);
                pass.set_pipeline(pipeline);
            },
        );
        if route.reaches_the_quantile() {
            // One workgroup: the search is over bins, not pixels.
            recording.dispatch([1, 1, 1], dispatch::Whole::Fixed, |pass| {
                pass.set_bind_group(0, &group, &[]);
                pass.set_pipeline(&self.grader.peak_quantile);
            });
        }
    }

    /// The frame the last [`encode`](Self::encode) wrote, still on the device, for a measurement
    /// that wants the coded frame without a second upload. None before any encode.
    pub fn encoded_frame(&self) -> Option<&Buffer> {
        self.encoded.get().map(|(counts, _)| counts)
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
        pollster::block_on(self.coded(grade)).expect("the readback mapped")
    }

    /// [`Self::encode`], awaited, which is the only spelling a browser can take.
    pub async fn coded(&self, grade: &Grade<'_>) -> Option<Vec<u16>> {
        self.encoded_as(grade, |mapped, samples| {
            colour::resident::samples_of(mapped)[..samples].to_vec()
        })
        .await
    }

    /// The same picture, read back as the eight bits an SDR output actually holds.
    ///
    /// **`frame.slang` writes one buffer whatever the output is**, delivering an SDR rendition as
    /// 8-bit values in the low byte of 16-bit counts - so reading it as counts and converting
    /// afterwards puts the whole picture in memory twice at once, and the wider copy is freed only
    /// once the narrower one is complete. On a 16384-wide canvas that is 446MB beside 223MB. Taken
    /// off the mapping in the shape it is wanted, the sixteen-bit copy is never made.
    ///
    /// Little-endian, as [`colour::resident::samples_of`] says of the same bytes: the low byte of
    /// each count stands first.
    pub fn encode_bytes(&self, grade: &Grade<'_>) -> Vec<u8> {
        pollster::block_on(self.coded_bytes(grade)).expect("the readback mapped")
    }

    /// [`Self::encode_bytes`], awaited.
    pub async fn coded_bytes(&self, grade: &Grade<'_>) -> Option<Vec<u8>> {
        self.encoded_as(grade, |mapped, samples| {
            mapped.iter().step_by(2).take(samples).copied().collect()
        })
        .await
    }

    /// The grade and the transfer in one dispatch, and whatever the caller makes of what comes
    /// back: the mapped readback, and how many samples of it are the picture rather than the
    /// odd pixel's padding.
    async fn encoded_as<T>(
        &self,
        grade: &Grade<'_>,
        take: impl FnOnce(&[u8], usize) -> T,
    ) -> Option<T> {
        assert_eq!(
            (grade.width, grade.height),
            (self.width, self.height),
            "the uniform describes a different frame than the one uploaded",
        );
        assert!(
            match (grade.matched(), self.colour.as_ref()) {
                (None, None) => true,
                (Some(a), Some(b)) => a == b,
                _ => false,
            },
            "the lattice and the curves bound here are the ones this frame went up with",
        );
        let described = grade.matched().unwrap_or(&self.identity);
        // Sized for what is *written*, which a geometry can make larger than the frame: a
        // straighten's bounding box is wider than the picture it turns, so an uncropped frame at
        // 45 degrees writes about half again what it reads.
        //
        // The pair is built on the first encode and kept, so a second one asking for a larger
        // output would copy past the end of a readback sized for the first. `output_size` moves
        // with the geometry and the window, neither of which the asserts above cover.
        let (out_width, out_height) = grade.written_size();
        let wanted = Grader::binding_bytes(out_width * out_height);
        let (counts, readback) = self.encoded.get_or_init(|| {
            let bytes = wanted;
            (
                self.grader.gpu.own_buffer(&wgpu::BufferDescriptor {
                    label: Some("counts"),
                    size: bytes,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                }),
                self.grader.gpu.own_buffer(&wgpu::BufferDescriptor {
                    label: Some("readback"),
                    size: bytes,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }),
            )
        });
        assert!(
            wanted <= readback.size(),
            "this grade writes {wanted} bytes and the pair was built for {} by an earlier encode \
             off the same upload",
            readback.size(),
        );
        let mut recording = self.grader.gpu.record();
        let (edits, balance) = self.written(grade, described);
        self.grader.build_balance(&mut recording, edits, balance);
        let smoothed = self.chroma_smoothed_for(grade);
        let nodes = self.nodes_for(grade);
        let group = self.grader.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("encode"),
            layout: &self.grader.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: edits.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: self.samples.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&self.curves),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&self.chroma),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: self.matrix.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: self.peak_out.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: counts.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&self.grader.sampler),
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
                    resource: wgpu::BindingResource::TextureView(&nodes.pair.1),
                },
                wgpu::BindGroupEntry {
                    binding: 15,
                    resource: wgpu::BindingResource::TextureView(&nodes.luma.1),
                },
                wgpu::BindGroupEntry {
                    binding: 12,
                    resource: self.grader.nits_of_code.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 13,
                    resource: wgpu::BindingResource::TextureView(self.detail_for(grade)),
                },
                wgpu::BindGroupEntry {
                    binding: 14,
                    resource: balance.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 17,
                    resource: wgpu::BindingResource::TextureView(&self.neighbourhood),
                },
                wgpu::BindGroupEntry {
                    binding: 19,
                    resource: wgpu::BindingResource::TextureView(&self.mean),
                },
                wgpu::BindGroupEntry {
                    binding: 21,
                    resource: wgpu::BindingResource::TextureView(&smoothed),
                },
            ],
        });

        // The output's pixels, not the frame's: the dispatch writes one per pixel of what the crop
        // and the turn produce, and reads the frame wherever the geometry sends it.
        let pixels = out_width * out_height;
        let out_bytes = Grader::binding_bytes(pixels);
        let (x, y) = self.grader.encode_groups(pixels);
        recording.banded(&self.grader.encode, [x, y, 1], |pass| {
            pass.set_bind_group(0, &group, &[]);
        });
        recording.copy_buffer_to_buffer(counts, 0, readback, 0, out_bytes);
        recording.submit();

        // Unmapped by `read_back` before the next rendition maps it again; a second `map_async` on
        // a buffer still mapped is a validation error, and `on_uncaptured_error` makes those fatal.
        // The odd pixel's padding dropped by taking only what the frame has.
        read_back(self.grader.gpu, readback, |mapped| take(mapped, pixels * 3)).await
    }

    /// The editor's canvas: `vs` and `fs`, over the frame that is already up.
    ///
    /// **The reader's own view, on this host, so that something other than a browser can say what
    /// it shows.** The draw was the last stage of the picture with no native execution at all - the
    /// one stage a Playwright screenshot was the only way to look at - and `covered`'s averaging,
    /// the level it picks off `edit.max_lod`, and the display transform all live in it.
    ///
    /// The one thing here that is genuinely the client's is the *transform*: a rendition is tagged
    /// Rec.2020 PQ and handed to a compositor, where a canvas has neither Rec.2020 nor absolute
    /// luminance, so `fs` computes what the media path declares (§7.1). That is why the two ends
    /// differ at all, and it is a conversion of the same nits rather than a second grade -
    /// `the_draw_shows_what_the_rendition_ships` inverts it and holds the two together.
    ///
    /// `grade.canvas` is what zoom and pan are; `pyramid` is what a ratio past two reads, and
    /// `max_lod` of zero draws from the frame's buffer whatever the ratio.
    ///
    /// Comes back as `f32` per channel, the target being `rgba16float`, which is what the canvas
    /// itself holds: these are display nits over an SDR white and go past one.
    pub fn draw(&self, grade: &Grade<'_>, pyramid: &crate::base::Pyramid) -> Vec<f32> {
        self.draw_with_print(grade, pyramid, None, false)
            .into_iter()
            .map(|word| half::f16::from_bits(word).to_f32())
            .collect()
    }

    pub fn draw_print(
        &self,
        grade: &Grade<'_>,
        pyramid: &crate::base::Pyramid,
        scene: &crate::print::Scene,
    ) -> Vec<f32> {
        self.draw_with_print(grade, pyramid, Some(scene), false)
            .into_iter()
            .map(|word| half::f16::from_bits(word).to_f32())
            .collect()
    }

    pub fn print_pq(
        &self,
        grade: &Grade<'_>,
        pyramid: &crate::base::Pyramid,
        scene: &crate::print::Scene,
    ) -> Vec<u16> {
        self.draw_with_print(grade, pyramid, Some(scene), true)
            .chunks_exact(4)
            .flat_map(|rgba| rgba[..3].iter().copied())
            .collect()
    }

    fn draw_with_print(
        &self,
        grade: &Grade<'_>,
        pyramid: &crate::base::Pyramid,
        print: Option<&crate::print::Scene>,
        pq: bool,
    ) -> Vec<u16> {
        let shown = grade.canvas.expect("a draw needs a canvas to draw onto");
        let (canvas_w, canvas_h) = shown.size.raw();
        let mut recording = self.grader.gpu.record();
        let canvas = recording.texture(&wgpu::TextureDescriptor {
            label: Some("canvas"),
            size: wgpu::Extent3d {
                width: canvas_w as u32,
                height: canvas_h as u32,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: if pq {
                wgpu::TextureFormat::Rgba16Uint
            } else {
                CANVAS_FORMAT
            },
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let target = canvas.view();

        self.draw_into(&mut recording, grade, pyramid, &target, print, pq);

        let stride = (canvas_w * 8).div_ceil(256) * 256;
        let staged = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("canvas readback"),
            size: (stride * canvas_h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        recording.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &canvas,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &staged,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride as u32),
                    rows_per_image: Some(canvas_h as u32),
                },
            },
            wgpu::Extent3d {
                width: canvas_w as u32,
                height: canvas_h as u32,
                depth_or_array_layers: 1,
            },
        );
        recording.submit();

        let slice = staged.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        self.grader.gpu.block_until_done();
        let drawn = {
            let mapped = slice.get_mapped_range().expect("the canvas mapped");
            let mut out = Vec::with_capacity(canvas_w * canvas_h * 4);
            for row in 0..canvas_h {
                let bytes = &mapped[row * stride..];
                for channel in 0..canvas_w * 4 {
                    let at = channel * 2;
                    out.push(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
                }
            }
            out
        };
        staged.unmap();
        drawn
    }

    /// The same draw, recorded onto a view the caller owns.
    ///
    /// **The editor's tick and the pin above are this one pass.** A browser hands it the image it
    /// took off its swapchain and presents it; a test hands it a texture it is about to read back.
    /// Neither knows anything the other does not, which is what stops the picture a reader sees
    /// from drifting from the picture a test measures.
    pub fn draw_into(
        &self,
        recording: &mut Recording<'_>,
        grade: &Grade<'_>,
        pyramid: &crate::base::Pyramid,
        target: &wgpu::TextureView,
        print: Option<&crate::print::Scene>,
        pq: bool,
    ) {
        if let Some(scene) =
            print.filter(|scene| matches!(scene.presentation, crate::print::Presentation::Surface))
        {
            self.draw_print_surface(recording, grade, pyramid, target, scene, pq);
            return;
        }
        self.draw_direct(recording, grade, pyramid, target, print, pq, false);
    }

    fn draw_direct(
        &self,
        recording: &mut Recording<'_>,
        grade: &Grade<'_>,
        pyramid: &crate::base::Pyramid,
        target: &wgpu::TextureView,
        print: Option<&crate::print::Scene>,
        pq: bool,
        pigment: bool,
    ) {
        let display_peak = grade.peak_nits;
        let print_grade;
        let grade = if print.is_some() || pigment {
            print_grade = Grade {
                peak_nits: units::light::Light::at_diffuse_white(grade.reference_nits),
                intent: print.map_or(grade.intent, |scene| scene.rendering_intent),
                print_blur: print.map_or(grade.print_blur, |scene| {
                    scene.ink_blur(grade.output().long())
                }),
                ..grade.clone()
            };
            &print_grade
        } else {
            grade
        };
        let canvas = grade.canvas.map(|mut canvas| {
            if let Some(scene) = print {
                canvas.region = scene.photo_region(grade.output_size(), canvas.region);
            }
            canvas
        });
        let view_grade = Grade {
            canvas,
            ..grade.clone()
        };
        let grade = &view_grade;
        let shown = grade.canvas.expect("a draw needs a canvas to draw onto");
        let described = grade.matched().unwrap_or(&self.identity);
        // What this binds belongs to the upload and the pyramid rather than to the recording, so
        // it takes a count on each: a caller that drops either before submitting would otherwise
        // be handing the queue a destroyed resource.
        recording.holding(&self.samples);
        recording.holding_texture(pyramid.texture());
        for texture in self.held.borrow().iter() {
            recording.holding_texture(texture);
        }
        let (edits, balance) = self.written(grade, described);
        self.grader.build_balance(recording, edits, balance);
        let smoothed = self.chroma_smoothed_for(grade);
        let nodes = self.nodes_for(grade);
        let level = pyramid.view();
        let group = self.grader.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("draw"),
            layout: &self.grader.draw_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: edits.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: self.samples.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&self.curves),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&self.chroma),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: self.matrix.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: self.peak_out.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&self.grader.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 9,
                    resource: wgpu::BindingResource::TextureView(&level),
                },
                wgpu::BindGroupEntry {
                    binding: 10,
                    resource: wgpu::BindingResource::TextureView(&self.chroma_luma),
                },
                wgpu::BindGroupEntry {
                    binding: 11,
                    resource: wgpu::BindingResource::TextureView(&nodes.pair.1),
                },
                wgpu::BindGroupEntry {
                    binding: 15,
                    resource: wgpu::BindingResource::TextureView(&nodes.luma.1),
                },
                wgpu::BindGroupEntry {
                    binding: 12,
                    resource: self.grader.nits_of_code.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 13,
                    resource: wgpu::BindingResource::TextureView(self.detail_for(grade)),
                },
                wgpu::BindGroupEntry {
                    binding: 14,
                    resource: balance.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 17,
                    resource: wgpu::BindingResource::TextureView(&self.neighbourhood),
                },
                wgpu::BindGroupEntry {
                    binding: 19,
                    resource: wgpu::BindingResource::TextureView(&self.mean),
                },
                wgpu::BindGroupEntry {
                    binding: 21,
                    resource: wgpu::BindingResource::TextureView(&smoothed),
                },
            ],
        });

        let (canvas_w, canvas_h) = shown.size.raw();
        // **The ratio picks the pipeline, not a branch inside one**, which is the page's rule and
        // has to be this side's too: the shader reads `FROM_FRAME` as an override, so a host that
        // chose differently would draw from the buffer where the reader draws from a level.
        let ratio = (shown.region.2 / canvas_w as f64).max(shown.region.3 / canvas_h as f64);
        let from_frame = shown.max_lod == 0 || ratio < 2.0;
        let print_group = print.map(|scene| {
            let albedo = self.print_albedo_for(scene.refractive_index as f32);
            recording.holding(&albedo);
            let environment = self.print_environment_for(scene.environment);
            recording.holding_texture(&environment);
            let calibration = self.print_light_for(scene, &environment);
            recording.holding(&calibration);
            let (buffer, proof) = self.print_scene_binding(recording, scene, display_peak);
            self.grader.gpu.bind_group(&wgpu::BindGroupDescriptor {
                label: Some("print"),
                layout: &self.grader.print_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: albedo.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: calibration.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: proof.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::TextureView(&environment.view()),
                    },
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: wgpu::BindingResource::Sampler(
                            &self.grader.print_environment_pipelines().sampler,
                        ),
                    },
                ],
            })
        });

        let flat = print
            .is_some_and(|scene| matches!(scene.presentation, crate::print::Presentation::Flat));
        let pipeline = if pigment {
            self.grader.drawing(true, "fs_print_pigment")
        } else if flat && !pq {
            self.grader.drawing(true, "fs_print_flat")
        } else if print.is_some() && pq {
            self.grader.drawing(true, "fs_print_pq")
        } else if print.is_some() {
            self.grader.drawing(true, "fs_print")
        } else if from_frame {
            self.grader.drawing(true, "fs")
        } else {
            self.grader.drawing(false, "fs")
        };
        recording.draw(
            &wgpu::RenderPassDescriptor {
                label: Some("draw"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            },
            |pass| {
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &group, &[]);
                if let Some(group) = print_group.as_ref() {
                    pass.set_bind_group(1, group, &[]);
                }
                // One triangle covering the target, as `vs` builds it from the vertex index alone.
                pass.draw(0..3, 0..1);
            },
        );
    }

    fn print_albedo_for(&self, eta: f32) -> Buffer {
        if let Some((cached_eta, buffer)) = self.print_albedo.borrow().as_ref() {
            if *cached_eta == eta {
                return buffer.clone();
            }
        }
        let buffer = self.grader.print_albedo_table(eta);
        *self.print_albedo.borrow_mut() = Some((eta, buffer.clone()));
        buffer
    }

    /// The print's uniform and the target it is laid down within.
    pub(super) fn print_scene_binding(
        &self,
        recording: &mut Recording<'_>,
        scene: &crate::print::Scene,
        display_peak: units::light::Light<units::light::DisplayNits>,
    ) -> (Buffer, Buffer) {
        let target = crate::printer_gamut::target(scene, self.printer.borrow().as_deref());
        let target = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("print target"),
            contents: &target
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect::<Vec<_>>(),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let parameters = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("print"),
            contents: &scene.uniform(display_peak),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        (parameters, target)
    }

    fn print_light_for(&self, scene: &crate::print::Scene, environment: &Texture) -> Buffer {
        let parameters = scene.light_parameters();
        let temperature = scene.light_temperature_kelvin as f32;
        let cached = self
            .print_light
            .borrow()
            .as_ref()
            .filter(|(_, _, cached_environment, _)| *cached_environment == scene.environment)
            .map(|(cached_parameters, cached_temperature, _, buffer)| {
                (*cached_parameters, *cached_temperature, buffer.clone())
            });
        let buffer = match cached {
            Some((cached_parameters, cached_temperature, buffer))
                if cached_parameters == parameters && cached_temperature == temperature =>
            {
                return buffer;
            }
            Some((_, _, buffer)) => {
                self.grader
                    .print_lamp_calibration(&buffer, parameters, temperature, environment)
            }
            None => self
                .grader
                .print_light_calibration(parameters, temperature, environment),
        };
        *self.print_light.borrow_mut() =
            Some((parameters, temperature, scene.environment, buffer.clone()));
        buffer
    }

    /// Where a page has not fetched the environment yet, `wasm::Editor::set_print` has already
    /// refused the scene naming it.
    fn print_environment_for(&self, environment: crate::print::Environment) -> Texture {
        if let Some((cached, texture)) = self.print_environment.borrow().as_ref() {
            if *cached == environment {
                return texture.clone();
            }
        }
        let texture = self
            .grader
            .print_environment(environment)
            .unwrap_or_else(|error| panic!("the print's environment: {error}"));
        *self.print_environment.borrow_mut() = Some((environment, texture.clone()));
        texture
    }
}

/// `struct Edit`'s fields, in the order [`uniform`] writes them.
///
/// Here because the writer below is two dozen pushes into a flat buffer, and nothing about a
/// push says which field it is. Swapping two of them leaves every suite green and grades
/// the picture with one number where another belongs.
///
/// `the_uniform_matches_the_shader_struct` parses the struct out of the `.slang` and holds
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
    "hue_count",
    "chroma_count",
    "level_count",
    "has_nodes",
    "chroma_scale",
    "level_low",
    "level_scale",
    "sdr_white",
    "row_stride",
    "peak_samples",
    "region_origin",
    "region_size",
    "canvas_size",
    "max_lod",
    "intent",
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
    "crop_cos",
    "crop_sin",
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
    "detail_long",
    "detail_step",
    "photo_width",
    "photo_height",
    "window_left",
    "window_top",
    "neighbourhood_count",
    "neighbourhood_scale",
    "has_neighbourhood",
    "neighbourhood_left",
    "neighbourhood_top",
    "neighbourhood_photo_width",
    "neighbourhood_photo_height",
    "has_mean",
    "mean_block",
    "has_smoothed",
    "chroma_shrink",
    "tone_anchor",
    "black_floor",
    "print_blur",
    "reader_curve_count",
    "camera_curve_count",
    "curve_is_camera",
    "reader_curve[CURVE_POINTS]",
    "camera_curve[CURVE_POINTS]",
    "camera_exposure",
    "camera_saturation",
    "band_top",
    "band_rows",
    "matched_temperature",
    "matched_tint",
    "node_hue_count",
    "node_chroma_count",
    "node_level_count",
    "node_neighbourhood_count",
    "node_chroma_scale",
    "node_level_low",
    "node_level_scale",
    "node_neighbourhood_scale",
    "reach_mask",
    "mask_centre_0",
    "mask_centre_1",
    "mask_centre_2",
    "mask_centre_3",
    "mask_reach_0",
    "mask_reach_1",
    "mask_reach_2",
    "mask_reach_3",
    "mask_feather_0",
    "mask_feather_1",
    "mask_feather_2",
    "mask_feather_3",
];

/// `struct Edit`, field for field, in the order the shader declares them.
///
/// Flat rather than a builder so it can be read against the struct. The one subtlety is
/// the unnamed word before `region_origin`: WGSL puts a `vec2f` on a multiple of eight and
/// the scalars end on 92, so without it every field after lands short and the binding is
/// rejected four bytes small.
fn uniform(grade: &Grade<'_>, colour: &HdrColour) -> Vec<u8> {
    uniform_words(grade, colour)
        .iter()
        .flat_map(|v| v.to_le_bytes())
        .collect()
}

/// The same words, before they are bytes, so the editor can be handed them.
///
/// **This is the only thing that builds a `Edit`.** A client building its own from the payload -
/// re-deriving `curve_bins` from the curve it was sent, the seven lattice shape fields from the
/// chroma map, `trust_ceiling`, `sdr_white`, and the peak's sampling stride - is twenty-two words
/// of one frame described twice in two languages. The shaders are one implementation; what would
/// be two is the thing that fills them, and a mismatch there is a photograph graded with one
/// number where another belongs, on a path no test crosses.
///
/// So the frame's own words are built here, once, and travel on `edit::PreparedHeader`. What
/// the editor still writes is only what the *reader* owns and this side cannot know: the exposure,
/// the sliders, the region on screen and the canvas showing it.
pub fn uniform_words(grade: &Grade<'_>, colour: &HdrColour) -> Vec<u32> {
    uniform_words_with(grade, colour, true)
}

/// `uniform_words`, saying whether `chroma_smoothed` is there to read: the pass that
/// builds it runs the model without it.
fn uniform_words_with(grade: &Grade<'_>, colour: &HdrColour, smoothed: bool) -> Vec<u32> {
    let shape = colour.chroma.as_ref().map(|m| m.shape());
    let shape = shape.as_ref();
    let identity = units::light::IDENTITY_CURVE;
    let camera = grade
        .colour
        .map_or(identity.as_slice(), |c| c.curve.as_slice());
    let reader = grade
        .adjust
        .tone_curve
        .as_ref()
        .map(ToneCurve::points)
        .unwrap_or(camera);
    let mut w: Vec<u32> = Vec::new();
    let f = |w: &mut Vec<u32>, v: f64| w.push((v as f32).to_bits());
    w.push(grade.width as u32);
    w.push(grade.height as u32);
    f(&mut w, grade.white.raw());
    f(&mut w, grade.source_level.raw());
    f(&mut w, grade.reference_nits.raw());
    f(&mut w, grade.peak_nits.raw());
    let camera_exposure = grade
        .colour
        .map_or(units::light::Stops::ZERO, |c| c.exposure);
    f(&mut w, grade.exposure.unwrap_or(camera_exposure).raw());
    w.push(match grade.output {
        Output::Pq => 0,
        Output::Srgb => 1,
        Output::Rolled => 2,
    });
    let matched = grade.matched().is_some();
    w.push(u32::from(matched));
    f(&mut w, colour.saturation);
    w.push(u32::from(matched && colour.chroma.is_some()));
    w.push(colour.curves[0].len() as u32);
    f(&mut w, colour.ceiling);
    w.push(shape.map_or(2, |s| s.hue_count as u32));
    w.push(shape.map_or(2, |s| s.chroma_count as u32));
    w.push(shape.map_or(2, |s| s.level_count as u32));
    w.push(u32::from(!grade.adjust.colour_nodes.is_empty()));
    f(&mut w, shape.map_or(1.0, |s| s.chroma_scale));
    f(&mut w, shape.map_or(0.0, |s| s.level_low));
    f(&mut w, shape.map_or(1.0, |s| s.level_scale));
    f(&mut w, CANVAS_WHITE_NITS); // sdr_white
    let (stride, rows) = sampled_rows(grade.width, grade.height);
    w.push(stride); // row_stride
    w.push(grade.width as u32 * rows); // peak_samples
    w.push(0); // the alignment word before `region_origin`
    let shown = grade.canvas.unwrap_or(Canvas {
        region: (0.0, 0.0, 0.0, 0.0),
        size: units::px::Size::of(units::px::Span::ZERO, units::px::Span::ZERO),
        max_lod: 0,
    });
    let (canvas_w, canvas_h) = shown.size.raw();
    for value in [
        shown.region.0,
        shown.region.1,
        shown.region.2,
        shown.region.3,
        canvas_w as f64,
        canvas_h as f64,
    ] {
        f(&mut w, value); // region_origin, region_size, canvas_size
    }
    w.push(shown.max_lod);
    w.push(grade.intent as u32);
    // The reader's sliders, in `struct Edit`'s order. Appended after the scalars there, so
    // nothing above this line moved when they were added.
    f(&mut w, grade.adjust.contrast);
    f(&mut w, grade.adjust.highlights);
    f(&mut w, grade.adjust.shadows);
    f(&mut w, grade.adjust.whites);
    f(&mut w, grade.adjust.blacks);
    f(&mut w, grade.adjust.vibrance);
    let camera_saturation = grade.colour.map_or(0.0, HdrColour::saturation_slider);
    f(&mut w, grade.adjust.saturation.unwrap_or(camera_saturation));
    f(&mut w, grade.adjust.texture);
    f(&mut w, grade.adjust.clarity);
    f(&mut w, grade.adjust.dehaze);
    // The frame's illuminant, then the document's, copied rather than resolved against each
    // other: `white_balance.slang` is where a null half becomes the frame's own, so that rule
    // has one implementation instead of one per host. Zero as-shot means the camera recorded
    // no usable multipliers, and the shader leaves the balance alone.
    f(&mut w, grade.as_shot.map_or(0.0, |s| s.temperature));
    f(&mut w, grade.as_shot.map_or(0.0, |s| s.tint));
    f(&mut w, grade.adjust.temperature.unwrap_or(0.0));
    f(&mut w, grade.adjust.tint.unwrap_or(0.0));
    w.push(
        u32::from(grade.adjust.temperature.is_some())
            | (u32::from(grade.adjust.tint.is_some()) << 1)
            | (u32::from(grade.adjust.camera_balance) << 2),
    );
    // The reader's crop, straighten and turn, which both hosts apply here - in the same dispatch
    // as the grade, off the whole frame. The editor patches these per tick, since a crop handle
    // must not cost a re-prepare; a rendition fills them from its job and gets the identical
    // mapping rather than a gather that agrees with it.
    let (out_width, out_height) = grade.output_size();
    let [left, top, right, bottom] = grade.geometry.crop;
    let (sin, cos) = grade.geometry.angle_degrees.to_radians().sin_cos();
    for value in [left, top, right, bottom, cos, sin] {
        f(&mut w, value);
    }
    w.push(u32::from(grade.geometry.rotate));
    w.push(out_width as u32);
    w.push(out_height as u32);
    for value in grade.geometry.keystone.unwrap_or_default() {
        f(&mut w, value);
    }
    w.push(u32::from(grade.geometry.keystone.is_some()));
    w.push(detail_long(grade.photograph_long.raw()));
    w.push(detail_step(grade.photograph_long.raw()));
    // The photograph the crop fractions are of, and where this buffer starts in it. The frame's own
    // size and the origin for every caller whose frame *is* the photograph, which is the editor and
    // every rendition that had no crop to decode less of.
    let (photo_width, photo_height) = grade.photograph();
    let origin = grade.window.map_or((0, 0), |w| w.origin.raw());
    w.push(photo_width as u32);
    w.push(photo_height as u32);
    w.push(origin.0 as u32);
    w.push(origin.1 as u32);
    // The neighbourhood axis and where to read its thumb. A separate window from `window`,
    // because a loupe tile applies no geometry - `window` must stay `None` there - while
    // the thumb is still the photograph's and has to be read in its UV.
    w.push(shape.map_or(2, |s| s.neighbourhood_count as u32));
    f(&mut w, shape.map_or(1.0, |s| s.neighbourhood_scale));
    w.push(u32::from(
        matched && colour.chroma.is_some() && !colour.neighbourhood.data.is_empty(),
    ));
    let neighbourhood_window = grade.neighbourhood_window.or(grade.window);
    let s_origin = neighbourhood_window.map_or((0, 0), |s| s.origin.raw());
    let (s_width, s_height) =
        neighbourhood_window.map_or((grade.width, grade.height), |s| s.photograph.raw());
    w.push(s_origin.0 as u32);
    w.push(s_origin.1 as u32);
    w.push(s_width.max(1) as u32);
    w.push(s_height.max(1) as u32);
    // A mean is always built beside a real frame; only the probes, which bind a dummy,
    // clear this in their own uniform builders.
    w.push(1);
    // The block alone: `cell_at` in `colour.slang` reads the cells by index off this and the
    // window's own origin, where an affine onto the texture's UV could not be exact - a window's
    // texture holds fewer cells than the photograph's, so normalising by it and letting the
    // sampler multiply it back rounds differently on the two routes.
    w.push(mean_grid(grade).0);
    // Built beside every matched frame; the pass that builds it, and the probes, clear this
    // in their own copies.
    w.push(u32::from(smoothed && matched));
    w.push(chroma_shrink(grade.photograph_long).raw() as u32);
    f(&mut w, colour.anchor);
    f(
        &mut w,
        colour::tone::floor_share(grade.floor, grade.white).raw(),
    );
    f(&mut w, grade.print_blur.raw());
    for points in [reader, camera] {
        assert!(
            units::light::curve_is_valid(points),
            "not a tone curve: {points:?}"
        );
        w.push(points.len() as u32);
    }
    w.push(u32::from(units::light::same_curve(reader, camera)));
    for points in [reader, camera] {
        let tangents = units::light::curve_tangents(points);
        for (point, tangent) in points.iter().zip(tangents) {
            for value in [point[0], point[1], tangent, 0.0] {
                f(&mut w, value);
            }
        }
        w.resize(
            w.len() + (units::light::CURVE_MAX_POINTS - points.len()) * 4,
            0,
        );
    }
    f(&mut w, camera_exposure.raw());
    f(&mut w, camera_saturation);
    let written = grade.written();
    w.push(written.top.raw() as u32);
    w.push(written.rows.raw() as u32);
    let matched_illuminant = grade.colour.and_then(|c| c.illuminant);
    f(&mut w, matched_illuminant.map_or(0.0, |i| i.temperature));
    f(&mut w, matched_illuminant.map_or(0.0, |i| i.tint));
    let nodes = colour::lattice::LutAxes::of_nodes().shape();
    w.push(nodes.hue_count as u32);
    w.push(nodes.chroma_count as u32);
    w.push(nodes.level_count as u32);
    w.push(nodes.neighbourhood_count as u32);
    f(&mut w, nodes.chroma_scale);
    f(&mut w, nodes.level_low);
    f(&mut w, nodes.level_scale);
    f(&mut w, nodes.neighbourhood_scale);
    let mask = grade.reach_mask.as_ref();
    f(&mut w, mask.map_or(0.0, |m| m.strength.clamp(0.0, 1.0)));
    let kernel = mask.map(|m| m.node.kernel(&colour::lattice::LutAxes::of_nodes()));
    for axes in kernel.map_or([[0.0; 4]; 3], |k| {
        [k.centre, k.reach, colour::lattice::NODE_FEATHER]
    }) {
        for value in axes {
            f(&mut w, value);
        }
    }
    // WGSL rounds a uniform struct's size up to a multiple of 16 bytes, and binds it at that
    // size - so a buffer holding exactly the fields is rejected as too small, by however much
    // the last few fields left over. Here it was implicit in the field count until a field was
    // added, and then it was four bytes short.
    // Stated as the rule rather than as a spare word, so the next field cannot break it.
    while w.len() % 4 != 0 {
        w.push(0);
    }
    w
}

/// The mean pass's grid for this frame: the supervision block, the frame's offset inside
/// its photograph-anchored first block, and the cell counts those give the texture.
///
/// The block is exactly one fit-plane pixel of the photograph, in this frame's pixels -
/// `photograph_long` is already in those. Equal to the fit's own footprint on purpose,
/// neither finer nor coarser: the fit models the transform at its plane's pixels, and a
/// mean read at any other width diverges from that model over texture by the tone curve's
/// curvature - measured as a blue deficit on lit skin when this sat at twice the fit's
/// width. Anchored at the photograph's origin so a tile and the whole render average the
/// same pixels into every cell they share; the reader's affine UV (`mean_scale_*`,
/// `mean_offset_*`) is derived from the same numbers, which is what keeps the two honest.
/// The camera match's supervision footprint, in the pixels of a frame whose photograph is
/// `photograph_long` on its long edge.
///
/// A window has to decode this much past what it keeps: the blocks partition the *photograph*, so
/// a cell the kept rectangle only partly covers would be averaged over the pixels inside the
/// window and nothing outside it, where the whole render averages the block. `matched_scene`
/// divides the pixel by that average, so the error would land on the picture rather than staying
/// in a statistic. `tile::grown` adds one of these to its reach, and this is a function so the
/// two cannot drift.
pub fn mean_block(photograph_long: usize) -> u32 {
    ((2 * photograph_long).div_ceil(colour::matched::sample_long_edge()) as u32).max(1)
}

fn mean_grid(grade: &Grade<'_>) -> (u32, (u32, u32), (u32, u32)) {
    let block = mean_block(grade.photograph_long.raw());
    let (phase, cells) = grid_for(grade, block);
    (block, phase, cells)
}

/// A grid of `block`-pixel cells partitioning the photograph, as this frame meets it: the
/// frame's offset inside its first cell, and how many cells cover it.
fn grid_for(grade: &Grade<'_>, block: u32) -> ((u32, u32), (u32, u32)) {
    let origin = grade
        .neighbourhood_window
        .or(grade.window)
        .map_or((0, 0), |w| w.origin.raw());
    let phase = (origin.0 as u32 % block, origin.1 as u32 % block);
    let cells = (
        (grade.width as u32 + phase.0).div_ceil(block),
        (grade.height as u32 + phase.1).div_ceil(block),
    );
    (phase, cells)
}

/// An `f32` as the `f16` bits a texture holds.
fn half(v: f32) -> [u8; 2] {
    half::f16::from_f32(v).to_bits().to_le_bytes()
}

#[cfg(test)]
mod tests {
    use units::light::{Light, Stops};

    #[test]
    fn renditions_defer_canvas_and_print_pipelines_and_draws_reuse_them() {
        let grader = super::Grader::new(gpu::device().expect("a GPU adapter"));
        let grade = super::Grade::new(
            2,
            2,
            colour::tone::Levels {
                white: Light::measured(1.0),
                peak: Light::measured(1.0),
                floor: None,
            },
            Light::exactly(203.0),
            Light::exactly(1000.0),
        );
        let frame = [4096u16; 12];
        let encoded = grader.encode(&frame, &grade);
        assert_eq!(encoded.len(), 12);
        assert!(encoded.iter().any(|&code| code > 0));
        assert_eq!(grader.encode(&frame, &grade), encoded);
        let drawings = [
            &grader.draw_from_frame,
            &grader.draw_from_pyramid,
            &grader.print_pipeline,
            &grader.print_pq_pipeline,
            &grader.print_pigment_pipeline,
            &grader.print_flat_pipeline,
        ];
        assert!(drawings.iter().all(|cell| cell.get().is_none()));
        assert!(grader.print_material.get().is_none());
        assert!(grader.print_surface.get().is_none());
        assert!(grader.print_environment.get().is_none());

        for (from_frame, entry) in super::DRAWINGS {
            assert!(std::ptr::eq(
                grader.drawing(from_frame, entry),
                grader.drawing(from_frame, entry)
            ));
        }
        assert!(std::ptr::eq(grader.print_material(), grader.print_material()));
        assert!(std::ptr::eq(grader.print_surface(), grader.print_surface()));
        assert!(std::ptr::eq(
            grader.print_environment_pipelines(),
            grader.print_environment_pipelines()
        ));
    }



    /// A drawn frame packed to RGB9E5 unpacks to what was drawn, within the format's 9 bits,
    /// headroom and all: what a canvas the page draws itself is shown.
    #[test]
    fn a_packed_frame_is_the_frame_it_was_drawn_as() {
        let gpu = gpu::device().expect("a Vulkan adapter");
        let drawn: [[f32; 3]; 6] = [
            [0.0, 0.0, 0.0],
            [0.5, 0.25, 0.125],
            [1.0, 1.0, 1.0],
            [4.9, 2.0, 0.3],
            [12.0, 0.01, 7.5],
            [-0.2, 0.7, 1.4],
        ];
        let texture = drawn_texture(gpu, 3, 2, &drawn);
        let words = pollster::block_on(crate::grade::device(gpu).rgb9e5(&texture)).expect("the readback mapped");
        for (at, (word, want)) in words.chunks_exact(4).zip(drawn).enumerate() {
            let word = u32::from_le_bytes(word.try_into().expect("a word"));
            let scale = 2f32.powi((word >> 27) as i32 - 15 - 9);
            let got =
                [word & 0x1ff, (word >> 9) & 0x1ff, (word >> 18) & 0x1ff].map(|m| m as f32 * scale);
            // One exponent for the three, so a channel is as fine as the pixel's brightest allows.
            let step = want.into_iter().fold(1e-3f32, f32::max) / 256.0;
            for (got, want) in got.into_iter().zip(want) {
                let want = half::f16::from_f32(want).to_f32().max(0.0);
                assert!((got - want).abs() <= step, "pixel {at}: {got} for {want}");
            }
        }
    }

    /// A thumbnail drawn proofed into sRGB over the canvas's P3 comes back as the eight-bit sRGB a
    /// PNG holds: neutral levels unmoved, and a primary at the edge of sRGB at sRGB's own primary.
    #[test]
    fn a_thumbnail_is_packed_as_the_srgb_it_was_proofed_to() {
        let gpu = gpu::device().expect("a Vulkan adapter");
        let p3_of_srgb_red = {
            let to_rec2020 = colour::space::srgb_to_rec2020();
            let to_p3 = colour::transfer::Primaries::DISPLAY_P3.from_rec2020();
            let rec2020: [f64; 3] = std::array::from_fn(|row| to_rec2020[row][0]);
            let linear: [f64; 3] =
                std::array::from_fn(|row| (0..3).map(|col| to_p3[row][col] * rec2020[col]).sum());
            linear.map(|v| colour::space::srgb_oetf(v) as f32)
        };
        let drawn: [[f32; 3]; 4] = [
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0],
            [0.5, 0.5, 0.5],
            p3_of_srgb_red,
        ];
        let texture = drawn_texture(gpu, 2, 2, &drawn);
        let rgba = pollster::block_on(crate::grade::device(gpu).srgb8(&texture)).expect("the readback mapped");
        let want: [[u8; 4]; 4] = [
            [0, 0, 0, 255],
            [255, 255, 255, 255],
            [128, 128, 128, 255],
            [255, 0, 0, 255],
        ];
        for (at, (got, want)) in rgba.chunks_exact(4).zip(want).enumerate() {
            let off = got.iter().zip(want).map(|(&g, w)| g.abs_diff(w)).max();
            assert!(off <= Some(1), "pixel {at}: {got:?} for {want:?}");
        }
    }

    /// The planes Firefox's video is encoded from code the light the canvas would have shown, as
    /// BT.2020 video range: luma per pixel, chroma sited on each pair's left column between its
    /// rows, and padding where the picture's width and height are not multiples of the block.
    #[test]
    fn the_video_planes_code_what_the_canvas_would_show() {
        use units::light::{DisplayNits, Light};
        let gpu = gpu::device().expect("a Vulkan adapter");
        let (width, height) = (7u32, 5u32);
        // What `fs` writes: Display P3 over SDR white through the signed sRGB curve, past one for
        // highlights and below zero for a colour outside P3.
        let drawn: Vec<[f32; 3]> = (0..width * height)
            .map(|at| {
                let t = at as f32 / (width * height) as f32;
                [2.4 * t, (1.3 - 1.7 * t).abs(), 0.9 * (t * 7.0).sin() - 0.1]
            })
            .collect();
        let texture = drawn_texture(gpu, width, height, &drawn);
        // Not the still's match, so a coding that ignored the one it was given would fail.
        let matching = colour::sdr_match::SdrMatch::MacVideo;
        let answer =
            pollster::block_on(crate::grade::device(gpu).pq420(&texture, matching)).expect("the readback mapped");

        let layout = super::Pq420Layout::of(width, height);
        let words: Vec<u32> = answer
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().expect("a word")))
            .collect();
        assert_eq!(words[..super::PQ420_HEADER_WORDS], layout.header());
        let samples: Vec<u16> = answer[super::PQ420_HEADER_WORDS * 4..]
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes(b.try_into().expect("a sample")))
            .collect();
        assert_eq!(samples.len(), layout.words as usize * 2);

        // An independent statement of the coding: the canvas undone, ST 2084, BT.2020's weights.
        let to_rec2020 = colour::transfer::Primaries::DISPLAY_P3.to_rec2020();
        let eotf = |v: f64| {
            let level = v.abs();
            let linear = match level <= 0.04045 {
                true => level / 12.92,
                false => ((level + 0.055) / 1.055).powf(2.4),
            };
            linear.copysign(v)
        };
        let video = |x: i64, y: i64| -> [f64; 3] {
            let (x, y) = (x.clamp(0, width as i64 - 1), y.clamp(0, height as i64 - 1));
            let canvas = drawn[(y * width as i64 + x) as usize]
                .map(|v| eotf(f64::from(half::f16::from_f32(v).to_f32())));
            let pq: [f64; 3] = std::array::from_fn(|row| {
                let whites: f64 = (0..3)
                    .map(|col| f64::from(to_rec2020[row][col]) * canvas[col])
                    .sum();
                let still = Light::<DisplayNits>::exactly(whites * colour::sdr_match::CANVAS_WHITE_NITS);
                let nits = matching.of_still(still).raw();
                colour::tone::pq(Light::<DisplayNits>::exactly(nits.max(0.0))).raw()
            });
            let [kr, kg, kb] = colour::space::LUMA;
            let luma = kr * pq[0] + kg * pq[1] + kb * pq[2];
            [
                64.0 + 876.0 * luma,
                512.0 + 896.0 * (pq[2] - luma) / (2.0 * (1.0 - kb)),
                512.0 + 896.0 * (pq[0] - luma) / (2.0 * (1.0 - kr)),
            ]
        };
        let close = |got: u16, want: f64, what: &str| {
            assert!(
                (f64::from(got) - want).abs() <= 1.0,
                "{what}: {got} for {want:.2}"
            );
        };
        for y in 0..height {
            for x in 0..width {
                let got = samples[(y * layout.luma_stride * 2 + x) as usize];
                close(
                    got,
                    video(x.into(), y.into())[0],
                    &format!("luma ({x}, {y})"),
                );
            }
        }
        for y in 0..height.div_ceil(2) {
            for x in 0..width.div_ceil(2) {
                let (left, top) = (i64::from(x) * 2, i64::from(y) * 2);
                let mut want = [0.0; 2];
                for (dx, weight) in [(-1, 1.0), (0, 2.0), (1, 1.0)] {
                    for dy in 0..2 {
                        let at = video(left + dx, top + dy);
                        want[0] += weight * at[1] / 8.0;
                        want[1] += weight * at[2] / 8.0;
                    }
                }
                let at = (y * layout.chroma_stride * 2 + x) as usize;
                close(
                    samples[(layout.cb_at * 2) as usize + at],
                    want[0],
                    &format!("cb ({x}, {y})"),
                );
                close(
                    samples[(layout.cr_at * 2) as usize + at],
                    want[1],
                    &format!("cr ({x}, {y})"),
                );
            }
        }
    }

    /// The page reads the header `pq420` leads its answer with, so both say how long it is.
    #[test]
    fn the_page_reads_the_header_the_host_writes() {
        let line = format!("const HEADER_WORDS = {};", super::PQ420_HEADER_WORDS);
        assert!(
            include_str!("../../../web/src/vp9/vp9_encoder.ts").contains(&line),
            "vp9_encoder.ts does not say `{line}`"
        );
    }

    fn drawn_texture(
        gpu: &super::Gpu,
        width: u32,
        height: u32,
        rgb: &[[f32; 3]],
    ) -> super::Texture {
        let data: Vec<u8> = rgb
            .iter()
            .flat_map(|&[r, g, b]| [r, g, b, 1.0])
            .flat_map(super::half)
            .collect();
        gpu.own_texture_with_data(
            &wgpu::TextureDescriptor {
                label: Some("drawn"),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &data,
        )
    }

    /// A `Geometry`, positionally, so a table of cases reads as a table.
    fn geometry(
        crop: [f64; 4],
        angle_degrees: f64,
        rotate: u16,
        keystone: Option<[f64; 8]>,
    ) -> geometry::warp::Geometry {
        geometry::warp::Geometry {
            crop,
            angle_degrees,
            rotate,
            keystone,
        }
    }

    /// An encode written a band of rows at a time is the whole encode, PQ and sRGB alike, through a
    /// geometry that sends each output row somewhere across the frame.
    #[test]
    fn a_grade_written_in_bands_is_the_grade_written_whole() {
        let Some(gpu) = gpu::device() else {
            return;
        };
        let (width, height) = (53usize, 37usize);
        let frame: Vec<u16> = (0..width * height * 3)
            .map(|i| (20_000 + (i * 7919) % 30_000) as u16)
            .collect();
        let levels = colour::tone::Levels {
            white: Light::measured(40_000.0),
            peak: Light::measured(60_000.0),
            floor: None,
        };
        let reference = Light::exactly(203.0);
        let hdr = super::Grade::new(width, height, levels, reference, Light::exactly(1000.0))
            .showing(geometry([0.05, 0.1, 0.9, 0.95], 3.5, 90, None));
        let sdr = super::Grade {
            output: super::Output::Srgb,
            peak_nits: super::Output::Srgb.mastered(reference),
            ..hdr.clone()
        };
        let peak = crate::grade::device(gpu).given_peak(4000.0);
        for (name, grade) in [("pq", hdr), ("srgb", sdr)] {
            let up = crate::grade::device(gpu).upload(&frame, &grade, &peak);
            let whole = up.encode(&grade);

            let (out_width, out_height) = grade.output_size();
            let mut stitched = Vec::with_capacity(whole.len());
            for top in (0..out_height).step_by(7) {
                let rows = 7.min(out_height - top);
                let band = super::Grade {
                    band: Some(geometry::warp::Band {
                        top: units::px::Place::measured(top),
                        rows: units::px::Span::measured(rows),
                    }),
                    ..grade.clone()
                };
                assert_eq!(band.written_size(), (out_width, rows));
                stitched.extend(up.encode(&band));
            }
            assert_eq!(stitched, whole, "{name} in bands");
        }
    }



    /// The host builds `detail` under exactly the test the shader reads it under.
    ///
    /// **Both directions are silent failures.** A slider added to `adjust.slang`'s `local` and not
    /// to [`super::Adjust::reads_the_neighbourhood`] samples a texture nothing wrote, which is a
    /// blur of whatever the allocation held; added here and not there, the frame pays five passes
    /// for a texture no pixel reads. Neither shows as an error, and the second is what this pass
    /// was doing for every unedited photograph before it was gated.
    #[test]
    fn the_detail_pass_runs_exactly_when_the_shader_reads_it() {
        const ADJUST_SLANG: &str = include_str!("../../../slang/adjust.slang");
        let local = ADJUST_SLANG
            .split_once("let local =")
            .and_then(|(_, rest)| rest.split_once(';'))
            .map(|(test, _)| test.to_string())
            .expect("adjust.slang states `local`");
        // The five the shader names, each against a probe that sets only that one.
        let set: [(&str, fn(&mut super::Adjust)); 5] = [
            ("texture_adjust", |a| a.texture = 1.0),
            ("clarity", |a| a.clarity = 1.0),
            ("dehaze", |a| a.dehaze = 1.0),
            ("highlights", |a| a.highlights = 1.0),
            ("shadows", |a| a.shadows = 1.0),
        ];
        for (field, set) in set {
            assert!(
                local.contains(&format!("edit.{field}")),
                "adjust.slang's `local` no longer reads {field}, so the host builds a blur for it \
                 that nothing samples",
            );
            let mut adjust = super::Adjust::none();
            set(&mut adjust);
            assert!(
                adjust.reads_the_neighbourhood(),
                "{field} is in the shader's `local` and not in `reads_the_neighbourhood`, so it \
                 samples a texture the host never built",
            );
        }
        // And nothing else does: a slider the shader does not read must not build the pass.
        let others: [fn(&mut super::Adjust); 5] = [
            |a| a.contrast = 1.0,
            |a| a.whites = 1.0,
            |a| a.blacks = 1.0,
            |a| a.vibrance = 1.0,
            |a| a.saturation = Some(1.0),
        ];
        for set in others {
            let mut adjust = super::Adjust::none();
            set(&mut adjust);
            assert!(
                !adjust.reads_the_neighbourhood(),
                "a slider that reads no neighbourhood"
            );
        }
        assert!(!super::Adjust::none().reads_the_neighbourhood());
    }

    /// The shader's own sizes, against the buffers this host allocates for them.
    ///
    /// **A histogram longer than its buffer is a dropped dispatch, not an error.** WGSL bounds
    /// an out-of-range store rather than failing it, so raising `BINS` in `peak.slang` without
    /// raising [`super::PEAK_BINS`] would silently discard every sample past the eighth
    /// thousand bin while `quantile` still divides by the full count - every rendition's scene
    /// peak low, the roll-off knee in the wrong place, and nothing said anywhere.
    #[test]
    fn the_shader_sizes_match_the_buffers_allocated_for_them() {
        // **The Slang, not what it emitted.** A `static const` is folded into its use sites before
        // emission, so the declaration is not in the generated WGSL to read.
        const PEAK_SLANG: &str = include_str!("../../../slang/peak.slang");
        const DETAIL_SLANG: &str = include_str!("../../../slang/detail.slang");
        let declared = |source: &str, name: &str| -> u64 {
            let at = source
                .find(&format!("static const uint {name} ="))
                .unwrap_or_else(|| panic!("{name} is declared"));
            let line = &source[at..][..source[at..].find(';').expect("it is terminated")];
            let digits: String = line
                .rsplit('=')
                .next()
                .expect("it is assigned")
                .matches(char::is_numeric)
                .collect();
            digits
                .parse()
                .unwrap_or_else(|_| panic!("{name} reads `{line}`"))
        };
        assert_eq!(
            declared(PEAK_SLANG, "BINS"),
            super::PEAK_BINS,
            "peak.slang's BINS and grade.rs's PEAK_BINS have drifted",
        );
        // **The one that fails quietly.** A `CANDIDATES` raised in the shader without the buffer
        // is a store past the end, which WGSL clamps rather than faults - so the collect keeps a
        // truncated set, the tick re-measures the peak off it, and the roll-off knee lands low on
        // every matched photograph with nothing anywhere saying why.
        assert_eq!(
            declared(PEAK_SLANG, "CANDIDATES"),
            super::PEAK_CANDIDATES,
            "peak.slang's CANDIDATES and grade.rs's PEAK_CANDIDATES have drifted",
        );
        // Not a buffer size but the same failure: this one sets how large a share of the
        // picture a blur covers, so a host allocating a different texture blurs at a different
        // scale and the rendition stops matching the editor. Silent - both pictures look like
        // pictures.
        assert_eq!(
            declared(DETAIL_SLANG, "DETAIL_LONG"),
            u64::from(super::DETAIL_LONG),
            "detail.slang's DETAIL_LONG and grade.rs's have drifted",
        );
        // The reach is what `chroma_smooth_reach` promises a comparison it can stand clear of.
        // The shrink itself is not pinned here and cannot be: it is a share of the photograph
        // rather than a constant, so the host computes it and the shader reads it off the
        // uniform.
        const CHROMA_SLANG: &str = include_str!("../../../slang/chroma_smooth.slang");
        let reach = CHROMA_SLANG
            .split("static const int REACH =")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .and_then(|digits| digits.trim().parse::<u64>().ok())
            .expect("chroma_smooth.slang declares REACH");
        assert_eq!(
            reach,
            u64::from(super::CHROMA_BLUR_REACH),
            "chroma_smooth.slang's REACH and grade.rs's CHROMA_BLUR_REACH have drifted",
        );
        // `decode` writes one entry per code and guards on the last one, so it carries the
        // count as `65535` - the top code rather than the length.
        let source = include_str!("../../../slang/decode.slang");
        let top: u64 = source
            .split("id.x > ")
            .nth(1)
            .and_then(|rest| rest.split(')').next())
            .and_then(|digits| digits.trim().parse().ok())
            .expect("decode.slang bounds its entry point");
        assert_eq!(
            top + 1,
            super::PQ_CODES,
            "decode.slang fills {} entries and grade.rs allocates {}",
            top + 1,
            super::PQ_CODES,
        );
    }

    /// The WGSL of every shader that imports `px`, read here rather than through `grade.rs`'s own
    /// consts: most of these are built by the module that dispatches them, and this test is about
    /// the emitted text rather than about any pipeline.
    const SHARPEN_WGSL: &str = shaders::SHARPEN.source;
    const DUST_WGSL: &str = shaders::DUST.source;
    const DUST_FIND_WGSL: &str = shaders::DUST_FIND.source;
    const COMPOSITE_FEATURES_WGSL: &str =
        shaders::COMPOSITE_FEATURES.source;

    /// `px.slang`'s spaces are a compile-time argument and reach no buffer a host binds.
    ///
    /// **The one way typing the shaders could have cost something.** A `Span` is a struct, and a
    /// struct that reached a uniform or a storage binding would change the layout both hosts agree
    /// on - silently, since the numbers in it are the numbers that were always there. Slang
    /// monomorphises the generic into a local, so what a lane holds is a `u32` in a wrapper the
    /// compiler flattens; this says the wrapper never got into a binding to be flattened wrongly.
    #[test]
    fn the_generic_pixels_cost_nothing() {
        // `_std140_` is what slangc suffixes a struct it is laying out for a binding, so a `Span`
        // inside one of those bodies is exactly the failure. Others are locals and are free.
        //
        // **Every shader that imports `px`, not the two it started with.** The claim is about what
        // the module does to a binding, so a shader left off this list is a shader the claim was
        // never made about - `sharpen`, `dust` and `dust_find` had been importing it unchecked, and
        // `composite_features` joins them the moment its descriptor window becomes a `Share`.
        let each = [
            ("chroma_smooth", super::CHROMA_SMOOTH_WGSL),
            ("detail", super::DETAIL_WGSL),
            ("sharpen", SHARPEN_WGSL),
            ("dust", DUST_WGSL),
            ("dust_find", DUST_FIND_WGSL),
            ("composite_features", COMPOSITE_FEATURES_WGSL),
        ];
        for (name, wgsl) in each {
            for block in wgsl.split("struct ").skip(1).filter(|b| {
                b.split('{')
                    .next()
                    .is_some_and(|head| head.contains("_std140_"))
            }) {
                let body = block.split('}').next().unwrap_or_default();
                assert!(
                    !body.contains("Span"),
                    "{name}.wgsl binds a struct holding a px Span, so its layout is not the \
                     numbers alone: {body}",
                );
            }
        }
    }

    /// `light.slang`'s domains are the same compile-time argument, and reach no binding either.
    ///
    /// The same hazard as the pixels', on the shaders that carry the grade: `Edit` is written field
    /// for field by `uniform_words` and read back by `the_uniform_matches_the_shader_struct`, so a
    /// `Colour` or a `Light` laid out inside it would be a uniform whose words are not the words
    /// this host wrote - with every number in it still the number it always was.
    #[test]
    fn the_generic_lights_cost_nothing() {
        for (name, wgsl) in [
            ("frame", super::FRAME_WGSL),
            ("peak", super::PEAK_WGSL),
            ("decode", super::DECODE_WGSL),
            ("chroma_smooth", super::CHROMA_SMOOTH_WGSL),
        ] {
            for block in wgsl.split("struct ").skip(1).filter(|b| {
                b.split('{')
                    .next()
                    .is_some_and(|head| head.contains("_std140_"))
            }) {
                let body = block.split('}').next().unwrap_or_default();
                for wrapper in ["Light", "Colour", "Gain", "Stops"] {
                    assert!(
                        !body.contains(wrapper),
                        "{name}.wgsl binds a struct holding a light {wrapper}, so its layout is \
                         not the numbers alone: {body}",
                    );
                }
            }
        }
    }

    /// The reach `detail_reach` reports against the fractions the shader actually filters with.
    ///
    /// **This one decides how much of a photograph a loupe tile has to decode**, and it is the
    /// shader's arithmetic written out in Rust, which is the arrangement DESIGN 21.1 exists to
    /// distrust. Wrong small and a tile's Clarity is fitted against an edge that is not in the
    /// picture; wrong large and every tile pays for surroundings nothing reads.
    #[test]
    fn the_detail_reach_is_the_shaders_own() {
        const DETAIL_SLANG: &str = include_str!("../../../slang/detail.slang");
        let fraction = |name: &str| -> f64 {
            // A `Share`, so the value is braced: `static const Share NAME = { 1.0 / 64.0 };`.
            let at = DETAIL_SLANG
                .find(&format!("static const Share {name} ="))
                .unwrap_or_else(|| panic!("{name} is declared"));
            let line = &DETAIL_SLANG[at..][..DETAIL_SLANG[at..].find(';').expect("terminated")];
            let (numerator, denominator) = line
                .rsplit('=')
                .next()
                .and_then(|value| value.split_once('/'))
                .unwrap_or_else(|| panic!("{name} reads `{line}`"));
            let number = |text: &str| {
                text.trim()
                    .trim_matches(['{', '}'])
                    .trim()
                    .parse::<f64>()
                    .expect("a number")
            };
            number(numerator) / number(denominator)
        };
        assert_eq!(
            fraction("GUIDE_RADIUS"),
            super::GUIDE_RADIUS,
            "the window has moved"
        );
        assert_eq!(
            fraction("FINE_SIGMA"),
            super::FINE_SIGMA,
            "the fine reference has moved"
        );
        // And what those come to at the size every photograph larger than the working texture
        // gets, which is the number a tile is grown by.
        assert_eq!(super::detail_reach(super::DETAIL_LONG), 2 * 8 + 2);
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
    /// The shader is the source of truth: this parses `struct Edit` out of the `.slang` rather
    /// than restating it.
    #[test]
    fn the_uniform_matches_the_shader_struct() {
        let source = include_str!("../../../slang/edit.slang");
        let body = source
            .split_once("public struct Edit {")
            .and_then(|(_, rest)| rest.split_once("};"))
            .map(|(body, _)| body)
            .expect("edit.slang declares struct Edit");

        let declared: Vec<&str> = body
            .lines()
            .map(str::trim)
            .filter_map(|line| line.strip_prefix("public "))
            .filter_map(|field| field.strip_suffix(';'))
            .filter_map(|field| field.rsplit(' ').next())
            .collect();

        assert_eq!(
            declared,
            super::EDIT_FIELDS,
            "struct Edit and grade.rs's EDIT_FIELDS have drifted",
        );

        // And the buffer the writer produces is the size the binding wants: every field a
        // word, `vec2f` two, the alignment word before the first of those, rounded up to four.
        //
        // The alignment word counted rather than left to the rounding to absorb, which is what
        // it was doing: at 63 named words the round to 64 happened to cover it, so the next field
        // appended made this expect one word fewer than the writer emits.
        let words: usize = super::EDIT_FIELDS
            .iter()
            .map(|name| {
                if name.starts_with("region_") || *name == "canvas_size" {
                    2
                } else if name.ends_with("[CURVE_POINTS]") {
                    units::light::CURVE_MAX_POINTS * 4
                } else {
                    1
                }
            })
            .sum::<usize>()
            + 1;
        let before_curve = super::EDIT_FIELDS
            .iter()
            .take_while(|name| **name != "reader_curve[CURVE_POINTS]")
            .map(|name| {
                if name.starts_with("region_") || *name == "canvas_size" {
                    2
                } else {
                    1
                }
            })
            .sum::<usize>()
            + 1;
        assert_eq!(before_curve % 4, 0, "curve array needs 16-byte alignment");
        let expected = words.div_ceil(4) * 4 * 4;
        let colour = colour::matched::HdrColour::identity();
        let grade = super::Grade::new(
            1,
            1,
            colour::tone::Levels {
                white: Light::measured(1.0),
                peak: Light::measured(1.0),
                floor: None,
            },
            Light::exactly(203.0),
            Light::exactly(1000.0),
        );
        assert_eq!(super::uniform(&grade, &colour).len(), expected);
    }

    #[test]
    fn invalid_tone_curves_are_refused() {
        let colour = colour::matched::HdrColour::identity();
        for points in [
            vec![[0.0, 0.0]],
            vec![[0.0, 0.0]; 17],
            vec![[0.5, 0.0], [0.4, 1.0]],
            vec![[0.0, 0.0], [1.0, f64::NAN]],
            vec![[0.0, 0.0], [1.0, 1.1]],
            vec![[0.0, 0.8], [1.0, 0.2]],
        ] {
            let grade = super::Grade {
                adjust: super::Adjust {
                    tone_curve: Some(super::ToneCurve::PchipCbrt3 { points }),
                    ..super::Adjust::none()
                },
                ..super::Grade::new(
                    1,
                    1,
                    colour::tone::Levels {
                        white: Light::measured(1.0),
                        peak: Light::measured(1.0),
                        floor: None,
                    },
                    Light::exactly(203.0),
                    Light::exactly(1000.0),
                )
            };
            let words = std::panic::AssertUnwindSafe(|| super::uniform_words(&grade, &colour));
            assert!(std::panic::catch_unwind(words).is_err());
        }
    }

    #[test]
    fn raising_the_curve_origin_lifts_black() {
        let Some(gpu) = gpu::device() else { return };
        let frame = vec![0u16; 16 * 16 * 3];
        let render = |curve| {
            let grade = super::Grade {
                adjust: super::Adjust {
                    tone_curve: curve,
                    ..super::Adjust::none()
                },
                output: super::Output::Rolled,
                ..super::Grade::new(
                    16,
                    16,
                    colour::tone::Levels {
                        white: Light::measured(20000.0),
                        peak: Light::measured(20000.0),
                        floor: None,
                    },
                    Light::exactly(203.0),
                    Light::exactly(10000.0),
                )
            };
            crate::grade::device(gpu).encode(&frame, &grade)
        };
        let plain = render(None);
        let lifted = render(Some(super::ToneCurve::PchipCbrt3 {
            points: vec![[0.0, 0.1], [1.0, 1.0]],
        }));
        assert!(
            lifted[0] > plain[0],
            "curve origin left black at {}",
            plain[0]
        );
    }

    /// The canvas the reader looks at against the frame the file gets, pixel for pixel.
    ///
    /// **The draw was the last stage of the picture that only a browser could run**, which made
    /// "does the editor show what the export contains" a question for a Playwright screenshot. It
    /// is `vs` and `fs` over the same frame, the same geometry and the same grade as `encode`, so
    /// it is answerable here in milliseconds.
    ///
    /// **Held as a mapping rather than as a difference, which is what makes it exact.** The two
    /// ends genuinely differ at the last step and are meant to: a rendition is tagged Rec.2020 PQ
    /// and handed to a compositor, and a canvas has neither Rec.2020 nor absolute luminance, so
    /// `fs` computes the display transform the media path declares (§7.1). Undoing that here would
    /// put a second copy of the transform in this file, which is the drift the shared shader
    /// exists to prevent. So what is asserted is that one function relates them: every pixel the
    /// rendition gives the same value, the draw gives the same value too. A geometry that differed
    /// by a pixel, a roll-off against a different peak, a lattice read at a different node - each
    /// of those breaks the mapping, and none of them needs the transform written down to catch.
    ///
    /// Blocks rather than a photograph, because `covered` averages four taps a quarter of a pixel
    /// either side of the centre where `coded_at` takes one at it. Inside a block those are the
    /// same value and the comparison is exact; across an edge they are not, and the difference
    /// would be the cubic's own spread rather than anything the two hosts disagree about.
    #[test]
    fn the_draw_shows_what_the_rendition_ships() {
        let Some(gpu) = gpu::device() else { return };
        let Some(base) = crate::base::device(gpu) else {
            return;
        };

        // Wide enough that a block has an interior beyond the chroma smoothing's reach from
        // its edges: the match reads a pixel's chroma from its neighbourhood, so only there
        // is a pixel's colour a function of its own value.
        const BLOCK: usize = 64;
        // Off this frame's own long edge, the smoothing's footprint being a share of the
        // photograph rather than a fixed count of pixels.
        let margin = 2 + super::chroma_smooth_reach(units::px::Span::measured(1024)).raw();
        /// One pixel wide, and away from every block edge: what says the two routes read the same
        /// *place*. A drawn canvas offset by a pixel still agrees about every block interior.
        const SPIKE: usize = 160;
        // Sixteen values over 128 blocks, so each one turns up in eight blocks scattered about the
        // frame rather than once. A value per block would make the map below injective, and an
        // injective map asserts only that a block draws one colour.
        const SHADES: usize = 16;

        let (width, height) = (1024usize, 512usize);
        let mut frame: Vec<u16> = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for x in 0..width {
                let block = (y / BLOCK) * (width / BLOCK) + (x / BLOCK);
                let shade = (block * 7 + block / (width / BLOCK)) % SHADES;
                for channel in 0..3 {
                    frame.push(match x == SPIKE {
                        true => 33000,
                        false => ((shade * 1900 + channel * 430) % 31000) as u16,
                    });
                }
            }
        }

        let colour = colour::matched::HdrColour::identity();
        let shown = super::Canvas {
            region: (0.0, 0.0, width as f64, height as f64),
            size: units::px::Size::measured(width, height),
            // Drawn at 1:1, where the frame's own buffer is what a canvas pixel covers.
            max_lod: 0,
        };
        let grade = super::Grade {
            colour: Some(&colour),
            exposure: Some(Stops::measured(0.5)),
            output: super::Output::Rolled,
            canvas: Some(shown),
            ..super::Grade::new(
                width,
                height,
                colour::tone::Levels {
                    white: Light::measured(1.0),
                    peak: Light::measured(1.0),
                    floor: None,
                },
                Light::exactly(203.0),
                Light::exactly(1000.0),
            )
        };

        let peak = crate::grade::device(gpu).scene_peak();
        let uploaded = crate::grade::device(gpu).upload(&frame, &grade, &peak);
        let shipped = uploaded.encode(&grade);
        let pyramid = crate::base::pyramid(gpu, base, &frame, (width, height)).expect("a pyramid");
        let drawn = uploaded.draw(&grade, &pyramid);

        let mut mapping: std::collections::HashMap<[u16; 3], [f32; 3]> =
            std::collections::HashMap::new();
        let mut compared = 0usize;
        for y in 0..height {
            for x in 0..width {
                // The smoothing's reach and two pixels more in from every block edge, and as
                // clear of the spike: a cubic reaches one back and two forward, so this is where
                // every tap of both routes is inside one value.
                let inside = |at: usize| at % BLOCK >= margin && at % BLOCK < BLOCK - margin;
                if !inside(x) || !inside(y) || x.abs_diff(SPIKE) <= margin {
                    continue;
                }
                let at = y * width + x;
                let ships = [shipped[at * 3], shipped[at * 3 + 1], shipped[at * 3 + 2]];
                let shows = [drawn[at * 4], drawn[at * 4 + 1], drawn[at * 4 + 2]];
                match mapping.get(&ships) {
                    None => {
                        mapping.insert(ships, shows);
                    }
                    Some(first) => assert_eq!(
                        *first, shows,
                        "the rendition writes {ships:?} at ({x}, {y}) where it wrote it before, \
                         and the draw shows {shows:?} rather than {first:?}",
                    ),
                }
                compared += 1;
            }
        }

        // Thousands of pixels onto sixteen values, so the equality above is a comparison between
        // scattered blocks rather than a key that is only ever written once.
        assert!(
            compared > 10_000,
            "only {compared} pixels were inside a block"
        );
        assert_eq!(
            mapping.len(),
            SHADES,
            "the frame did not reach the shades it was built with"
        );
        let lit = mapping
            .values()
            .filter(|shows| shows.iter().any(|v| *v > 0.01))
            .count();
        assert!(
            lit > SHADES / 2,
            "only {lit} of {SHADES} drawn values were above black"
        );

        // **And the two agree about *where*.** Everything above holds for a canvas offset by a
        // pixel, every tap of both routes being inside one flat block; the spike is one pixel wide,
        // so the column it lands in is the whole of what says `covered`'s footprint starts where
        // `coded_at`'s does. Their last expressions differ - one lays taps out over a region and
        // the other indexes the output - which is exactly where an offset would come from.
        let brightest = |row: usize, of: &dyn Fn(usize) -> f32| {
            (0..width)
                .max_by(|a, b| of(row * width + a).total_cmp(&of(row * width + b)))
                .expect("a row has pixels")
        };
        for row in [3usize, 40, 71, 125] {
            let ships = brightest(row, &|at| f32::from(shipped[at * 3]));
            let shows = brightest(row, &|at| drawn[at * 4]);
            assert_eq!(
                ships, SPIKE,
                "the rendition put row {row}'s spike at {ships}"
            );
            assert_eq!(
                shows, ships,
                "the draw put row {row}'s spike at {shows}, not {ships}"
            );
        }
    }

    #[test]
    fn the_reach_mask_darkens_what_the_edit_does_not_reach() {
        let Some(gpu) = gpu::device() else { return };
        let Some(base) = crate::base::device(gpu) else {
            return;
        };
        let side = 64usize;
        let frame: Vec<u16> = [9000u16, 12000, 15000].repeat(side * side);
        let colour = colour::matched::HdrColour::identity();
        let node = |chroma: f64, chroma_reach: f64, hue_reach: f64| colour::lattice::ColourNode {
            hue: 0.0,
            chroma,
            lightness: None,
            target_hue: 0.0,
            target_chroma: chroma,
            target_lightness: colour::lattice::ANY_LIGHTNESS_AT,
            hue_reach,
            chroma_reach,
            lightness_reach: 0.0,
        };
        let everywhere = node(0.0, crate::grade::colour_wheel::wheel_chroma(), 180.0);
        let nowhere = node(40.0, 0.5, 5.0);
        let drawn_with = |mask: Option<super::ReachMask>| {
            let grade = super::Grade {
                colour: Some(&colour),
                output: super::Output::Rolled,
                adjust: super::Adjust {
                    colour_nodes: vec![everywhere.clone(), nowhere.clone()],
                    ..super::Adjust::none()
                },
                canvas: Some(super::Canvas {
                    region: (0.0, 0.0, side as f64, side as f64),
                    size: units::px::Size::measured(side, side),
                    max_lod: 0,
                }),
                reach_mask: mask,
                ..super::Grade::new(
                    side,
                    side,
                    colour::tone::Levels {
                        white: Light::measured(1.0),
                        peak: Light::measured(1.0),
                        floor: None,
                    },
                    Light::exactly(203.0),
                    Light::exactly(1000.0),
                )
            };
            let peak = crate::grade::device(gpu).scene_peak();
            let uploaded = crate::grade::device(gpu).upload(&frame, &grade, &peak);
            let pyramid = crate::base::pyramid(gpu, base, &frame, (side, side)).expect("a pyramid");
            let drawn = uploaded.draw(&grade, &pyramid);
            let middle = (side / 2 * side + side / 2) * 4;
            [drawn[middle], drawn[middle + 1], drawn[middle + 2]]
        };
        let masked = |node: &colour::lattice::ColourNode, strength: f64| {
            drawn_with(Some(super::ReachMask {
                node: node.clone(),
                strength,
            }))
        };
        let plain = drawn_with(None);
        assert!(plain.iter().all(|v| *v > 0.01), "{plain:?}");
        assert_eq!(masked(&everywhere, 1.0), plain);
        assert_eq!(masked(&nowhere, 1.0), [0.0; 3]);
        let linear = |coded: f32| {
            let v = f64::from(coded);
            match v <= 0.04045 {
                true => v / 12.92,
                false => ((v + 0.055) / 1.055).powf(2.4),
            }
        };
        let half = masked(&nowhere, 0.5);
        for c in 0..3 {
            let share = linear(half[c]) / linear(plain[c]);
            assert!((share - 0.5).abs() < 2e-3, "{half:?} against {plain:?}");
        }
    }

    /// The zoomed-out draw reads the pyramid at the level and the place the frame's own draw would.
    ///
    /// **`FROM_FRAME` is false here, and nothing else ever makes it false.** Every other case in
    /// this file draws at 1:1 or with no pyramid at all, so `pyramid_cubic`, the per-tap decode and
    /// the `lod - 1` that turns a draw's level into a texture's were dispatched by nothing. A
    /// transposed index or an off-by-one on the level is invisible at 1:1 and wrong the moment a
    /// reader zooms out, which is the half of the editor nobody is looking at pixel-for-pixel.
    ///
    /// **Held against the *other draw path*, not against a second copy of the arithmetic.** At a
    /// ratio of exactly two the canvas is the frame halved, and `base::pyramid`'s level 0 is the
    /// frame halved, so one canvas pixel covers one texel: what the pyramid path shows for a block
    /// must be what the frame path shows for the same block, since averaging one value gives that
    /// value. `every_pyramid_level_is_a_mean_of_the_four_above_it` already holds the level itself
    /// to the frame, so a disagreement here is the draw's indexing and not the pyramid's contents.
    ///
    /// Blocks, and a frame that is not square with a shade that weighs its two axes differently:
    /// reading the level transposed lands in another block rather than the same value.
    #[test]
    fn the_zoomed_out_draw_reads_the_level_the_frame_would() {
        let Some(gpu) = gpu::device() else { return };
        let Some(base) = crate::base::device(gpu) else {
            return;
        };

        // Wide enough that a block has an interior beyond the chroma smoothing's reach from
        // its edges, on the halved canvas too (`the_draw_shows_what_the_rendition_ships`).
        const BLOCK: usize = 128;
        let (width, height) = (1024usize, 512usize);
        let across = width / BLOCK;
        let shade = |bx: usize, by: usize| (bx * 3 + by * 11) % 16;

        let mut frame: Vec<u16> = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for x in 0..width {
                let tone = shade(x / BLOCK, y / BLOCK);
                for channel in 0..3 {
                    frame.push(((tone * 1900 + channel * 430) % 31000) as u16);
                }
            }
        }

        let colour = colour::matched::HdrColour::identity();
        let grade = |canvas: super::Canvas| super::Grade {
            colour: Some(&colour),
            exposure: Some(Stops::measured(0.5)),
            output: super::Output::Rolled,
            canvas: Some(canvas),
            ..super::Grade::new(
                width,
                height,
                colour::tone::Levels {
                    white: Light::measured(1.0),
                    peak: Light::measured(1.0),
                    floor: None,
                },
                Light::exactly(203.0),
                Light::exactly(1000.0),
            )
        };

        let pyramid = crate::base::pyramid(gpu, base, &frame, (width, height)).expect("a pyramid");
        assert!(
            pyramid.levels > 0,
            "the frame was too small to build a level to read"
        );

        // The frame's own buffer, at 1:1: `max_lod` of zero is what makes it so whatever the ratio.
        let at_one = grade(super::Canvas {
            region: (0.0, 0.0, width as f64, height as f64),
            size: units::px::Size::measured(width, height),
            max_lod: 0,
        });
        // The same region on half the canvas, which is a ratio of two - the point `grade.rs` stops
        // choosing the frame and starts choosing a level.
        let (canvas_w, canvas_h) = (width / 2, height / 2);
        let zoomed = grade(super::Canvas {
            region: (0.0, 0.0, width as f64, height as f64),
            size: units::px::Size::measured(canvas_w, canvas_h),
            max_lod: pyramid.levels,
        });

        let peak = crate::grade::device(gpu).scene_peak();
        let uploaded = crate::grade::device(gpu).upload(&frame, &at_one, &peak);
        let close = uploaded.draw(&at_one, &pyramid);
        let far = uploaded.draw(&zoomed, &pyramid);

        // The smoothing's reach and two canvas pixels more in from every block edge, so all four
        // taps, the cubic's own reach and the neighbourhood the chroma is read from stay inside
        // one value at both scales.
        let margin = super::chroma_smooth_reach(units::px::Span::measured(width))
            .raw()
            .div_ceil(2)
            + 2;
        let block_on_canvas = BLOCK / 2;
        let mut compared = 0usize;
        for cy in 0..canvas_h {
            for cx in 0..canvas_w {
                let (inx, iny) = (cx % block_on_canvas, cy % block_on_canvas);
                if !(margin..block_on_canvas - margin).contains(&inx)
                    || !(margin..block_on_canvas - margin).contains(&iny)
                {
                    continue;
                }
                let (bx, by) = (cx / block_on_canvas, cy / block_on_canvas);
                let centre = (by * BLOCK + BLOCK / 2) * width + bx * BLOCK + BLOCK / 2;
                let one = &close[centre * 4..centre * 4 + 3];
                let at = cy * canvas_w + cx;
                let two = &far[at * 4..at * 4 + 3];
                for channel in 0..3 {
                    assert!(
                        (one[channel] - two[channel]).abs() < 1e-3,
                        "block ({bx}, {by}) draws {:?} from the frame and {:?} from the level, at \
                         canvas ({cx}, {cy})",
                        one,
                        two,
                    );
                }
                compared += 1;
            }
        }
        assert!(
            compared > 1_000,
            "only {compared} canvas pixels were inside a block"
        );

        // And the shades genuinely differ, so the equality above is not every block drawing black.
        let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
        for by in 0..height / BLOCK {
            for bx in 0..across {
                let centre = (by * BLOCK + BLOCK / 2) * width + bx * BLOCK + BLOCK / 2;
                seen.insert(close[centre * 4].to_bits());
            }
        }
        assert!(
            seen.len() > 8,
            "the frame drew only {} distinct values",
            seen.len()
        );
    }

    /// The editor's peak against the rendition's, across the exposure slider's whole range.
    ///
    /// **What `collect` and `remeasure` rest on.** A tick cannot re-sweep the frame at every
    /// slider position, so the brightest of the sampled million are kept once and only those are
    /// graded again - and that is sound only if the exposure cannot reorder the frame enough to
    /// push an uncollected pixel into the top hundred. Where it is not, the editor rolls its
    /// highlights off at a knee the export does not, and the reader is looking at a picture the
    /// file will not contain.
    ///
    /// It is arithmetic, so it is answered here rather than by opening a page. What rests on it is
    /// `wasm::HeldRaw::draw`, which re-measures every tick off the candidates the open collected.
    ///
    /// **A compressive tone, and it is the whole point of the fixture.** The camera curve here bends
    /// under exposure, so a bright pixel gains less than a dim one. Candidate reuse must still
    /// agree with a measurement of the whole frame after that compression.
    #[test]
    fn the_kept_candidates_answer_as_the_whole_sample_does() {
        let Some(gpu) = gpu::device() else { return };

        let mut colour = colour::matched::HdrColour {
            curve: vec![[0.0, 0.0], [0.5, 0.43], [1.0, 0.83]],
            ..colour::matched::HdrColour::identity()
        };
        for (channel, curve) in colour.curves.iter_mut().enumerate() {
            let shoulder = 0.5 + channel as f64 * 0.08;
            let bins = curve.len();
            for (at, value) in curve.iter_mut().enumerate() {
                let x = (at as f64 / (bins - 1) as f64) * colour::matched::TRUST_CEILING;
                *value = x / (1.0 + x * shoulder) * (1.0 + shoulder);
            }
        }

        // A ramp with a specular tail on it: the quantile is a rank near the top, so a frame
        // whose brightest pixels are all one value is answered the same way by any rule at all.
        let (width, height) = (256usize, 192usize);
        let mut frame: Vec<u16> = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for x in 0..width {
                let ramp = ((x * 26000) / width) as u16;
                let speck = (x * 7 + y * 13) % 991 == 0;
                for channel in 0..3u16 {
                    frame.push(match speck {
                        true => 34000 - channel * 700,
                        false => ramp.saturating_sub(channel * 300),
                    });
                }
            }
        }

        let at = |exposure: Stops| super::Grade {
            colour: Some(&colour),
            exposure: Some(exposure),
            ..super::Grade::new(
                width,
                height,
                colour::tone::Levels {
                    white: Light::measured(1.0),
                    peak: Light::measured(1.0),
                    floor: None,
                },
                Light::exactly(203.0),
                Light::exactly(1000.0),
            )
        };

        let peak = crate::grade::device(gpu).scene_peak();
        // The open: `measure` over the sample, `quantile` for the threshold, then `collect`.
        let uploaded = crate::grade::device(gpu).upload(&frame, &at(Stops::ZERO), &peak);
        uploaded.collect_candidates(&at(Stops::ZERO));

        let mut worst = 0.0f64;
        let mut sampled: Vec<(f64, f64)> = Vec::new();
        for exposure in [-5.0, -2.0, -0.5, 0.0, 1.0, 2.0, 3.5, 5.0] {
            uploaded.peak_from_candidates(&at(Stops::measured(exposure)));
            let kept = f64::from(crate::grade::device(gpu).read_peak(&peak));
            uploaded.measure_peak(&at(Stops::measured(exposure)));
            let whole = f64::from(crate::grade::device(gpu).read_peak(&peak));
            assert!(
                whole > 0.0,
                "the whole sample read no peak at all at {exposure} stops"
            );
            worst = worst.max((kept - whole).abs() / whole);
            sampled.push((exposure, whole));
        }

        // **The tone compresses, so the agreement above is one this fixture could have failed.**
        // Under a straight line the peak would be its neutral value times the gain exactly, at
        // every stop, and no pixel could overtake another however far the slider moved.
        let (_, neutral) = sampled[sampled.iter().position(|(ev, _)| *ev == 0.0).expect("0 EV")];
        let (top, lit) = *sampled.last().expect("a brightest exposure");
        assert!(
            lit < neutral * 2f64.powf(top) * 0.95,
            "a gain of {top} stops took the peak from {neutral:.1} to {lit:.1}, which is the \
             straight line this fixture exists to avoid",
        );

        // **And the histogram's range travels with the exposure**, which is the other thing these
        // eight measurements can say. `bin_of` spans a fixed 28 stops around the *reference*, and
        // getting that wrong fails in two directions, neither of them as an error:
        //
        // - A top fixed at a few times reference saturates, and the peak stops climbing. On screen
        //   that is highlights clipping a couple of stops up the slider.
        // - A range grown with the gain loses the values instead, the curve compressing faster
        //   than the range opens, and the peak falls towards nothing - the picture going dark and
        //   flat at particular slider positions.
        //
        // Rising catches both. Tracking the gain catches the first on its own, and needs a band
        // rather than a number because the tone is allowed to bend it: this fixture's camera curve
        // takes it 13.8% under at +5 stops, where a fitted frame sits near 5% and a saturating
        // histogram reads 35%. So the compression guard above and this one bound it from either
        // side, and the fixture has to sit between them.
        for pair in sampled.windows(2) {
            let ((was, lower), (now, higher)) = (pair[0], pair[1]);
            assert!(
                higher > lower,
                "the peak went {lower:.1} to {higher:.1} from {was} to {now} stops, which is a \
                 histogram losing its values rather than binning them",
            );
        }
        for (ev, whole) in sampled.iter().copied().filter(|(ev, _)| *ev >= 0.0) {
            let gain = 2f64.powf(ev);
            let drift = (whole / neutral / gain - 1.0).abs();
            assert!(
                drift < 0.2,
                "the peak at {ev} stops is {:.2}x neutral against {gain:.0}x, {:.1}% off - which \
                 is the histogram saturating rather than the curve bending",
                whole / neutral,
                drift * 100.0,
            );
        }

        // Measured at zero: the sample is small enough here that every pixel above the threshold
        // fits inside `CANDIDATES`, so the two routes rank the same set and land in the same bin.
        // A tolerance rather than equality because what has to hold is the knee, and the bins are
        // 8192 over 28 stops - a shuffle of one is 0.24% of a value.
        eprintln!(
            "{top} stops took the peak to {:.2}x, not {:.0}x; the candidates differ from the \
             whole sample by {:.4}%",
            lit / neutral,
            2f64.powf(top),
            worst * 100.0,
        );
        assert!(
            worst < 0.005,
            "the two peak routes differ by {:.3}%",
            worst * 100.0
        );
    }

    /// The exposure does not drag the picture onto the lattice's outermost level.
    ///
    /// **The camera match is a function of the colour the camera rendered**, and the fit only ever
    /// saw the levels that colour had. Exposed first and matched afterwards, a frame lifted four
    /// stops reads the top level node whatever it was - and takes, everywhere, the correction
    /// fitted for the one thing that sat up there, which is a clipping highlight. On a real fit
    /// that is a magenta cast arriving as the slider goes up.
    ///
    /// A lattice that is the identity everywhere but its top level plane, so the only thing that
    /// can tint this grey is having been read at the wrong level.
    #[test]
    fn the_exposure_does_not_move_which_lattice_node_the_match_reads() {
        let Some(gpu) = gpu::device() else { return };

        let (width, height) = (32usize, 32usize);
        let frame: Vec<u16> = vec![24000; width * height * 3];
        let mut colour = colour::matched::HdrColour::identity();
        let axes = colour::lattice::ChromaMap::identity().axes();
        // The generator's sixth term is the tint the blue-yellow axis takes from lightness: what
        // takes a neutral towards blue in proportion to its level, the one way a kernel can tint a
        // grey at all.
        colour.chroma = Some(colour::lattice::ChromaMap::with_kernels(vec![
            colour::lattice::Kernel {
                centre: [0.0, 0.0, axes.level_top, 0.0],
                reach: [0.0, 0.0, (axes.level_top - axes.level_low) / 8.0, 0.0],
                generator: [0.0, 0.0, 0.0, 0.0, 0.0, 0.4, 0.0],
                to_lightness: [0.0; 2],
            },
        ]));
        let grade = |exposure| super::Grade {
            colour: Some(&colour),
            exposure: Some(exposure),
            output: super::Output::Rolled,
            ..super::Grade::new(
                width,
                height,
                colour::tone::Levels {
                    white: Light::measured(1.0),
                    peak: Light::measured(1.0),
                    floor: None,
                },
                Light::exactly(203.0),
                Light::exactly(1000.0),
            )
        };

        let cast = |exposure: f64| {
            let exposure = Stops::measured(exposure);
            let peak = crate::grade::device(gpu).scene_peak();
            let out = crate::grade::device(gpu)
                .upload(&frame, &grade(exposure), &peak)
                .encode(&grade(exposure));
            let (r, g, b) = (f64::from(out[0]), f64::from(out[1]), f64::from(out[2]));
            assert!(
                g > 1000.0,
                "the grey came out at {r}, {g}, {b} at {} stops",
                exposure.raw()
            );
            (b - g) / g
        };

        // The lattice this grey reads at rest is the identity, so it leaves as it arrived. Asserted
        // rather than assumed: a grey bright enough to sit on the top plane already would make the
        // comparison below pass on a frame that is tinted at both exposures.
        let rest = cast(0.0);
        assert!(
            rest.abs() < 0.01,
            "the unexposed grey is already {:.1}% blue",
            rest * 100.0
        );
        let lifted = cast(4.0);
        assert!(
            lifted.abs() < 0.01,
            "four stops took the same grey {:.1}% blue, which is the top level node's tint",
            lifted * 100.0,
        );
    }

    #[test]
    fn the_cameras_own_curve_renders_the_match_as_fitted() {
        let Some(gpu) = gpu::device() else { return };

        let (width, height) = (64usize, 64usize);
        // Every level from black past diffuse white, so each zone and the contrast's pivot are
        // crossed somewhere in the frame.
        let frame: Vec<u16> = (0..width * height * 3)
            .map(|i| ((i / 3) * 16 + (i % 3) * 700).min(65535) as u16)
            .collect();
        let fitted = colour::matched::HdrColour {
            saturation: 1.2,
            chroma: Some(colour::lattice::ChromaMap::from_saturation(1.2)),
            ..colour::matched::HdrColour::identity()
        };
        let told = colour::matched::HdrColour {
            exposure: Stops::measured(0.7),
            curve: vec![[0.0, 0.0], [0.35, 0.25], [0.7, 0.78], [1.0, 0.96]],
            ..fitted.clone()
        };
        let graded_as = |colour: Option<&colour::matched::HdrColour>,
                         exposure: Option<Stops>,
                         adjust: super::Adjust| {
            let grade = super::Grade {
                colour,
                exposure,
                adjust,
                output: super::Output::Rolled,
                ..super::Grade::new(
                    width,
                    height,
                    colour::tone::Levels {
                        white: Light::measured(20000.0),
                        peak: Light::measured(65535.0),
                        floor: Some(Light::measured(40.0)),
                    },
                    Light::exactly(203.0),
                    // Room for the whole frame, so nothing rolls: the scene peak is a histogram's
                    // bin, and a last-bit difference that crosses one moves every highlight's knee.
                    Light::exactly(10000.0),
                )
            };
            let peak = crate::grade::device(gpu).scene_peak();
            crate::grade::device(gpu).upload(&frame, &grade, &peak).encode(&grade)
        };
        let graded = |colour: &colour::matched::HdrColour,
                      exposure: Option<Stops>,
                      tone_curve: Option<super::ToneCurve>| {
            graded_as(
                Some(colour),
                exposure,
                super::Adjust {
                    tone_curve,
                    ..super::Adjust::none()
                },
            )
        };
        let written_out = super::Adjust {
            tone_curve: Some(super::ToneCurve::PchipCbrt3 {
                points: told.curve.clone(),
            }),
            saturation: Some(told.saturation_slider()),
            ..super::Adjust::none()
        };
        let worst = |a: &[u16], b: &[u16]| {
            a.iter()
                .zip(b)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap_or(0)
        };

        let plain = graded(&fitted, None, None);
        let untouched = graded(&told, None, None);
        assert!(
            plain == untouched,
            "an unedited photo's curve moved the match"
        );
        let undone = graded_as(Some(&told), Some(told.exposure), written_out.clone());
        let moved = worst(&plain, &undone);
        assert!(
            moved <= 2,
            "the camera's own sliders, written out, moved the match by {moved} codes"
        );

        // A None profile drops the match and keeps where its sliders start: the neutral arm at the
        // camera's exposure, curve and saturation, with nothing matched at all.
        let none = super::Adjust {
            colour_profile: super::ColourProfile::None,
            ..super::Adjust::none()
        };
        let unmatched = graded_as(Some(&told), None, none);
        let neutral_at_camera = graded_as(
            None,
            Some(told.exposure),
            super::Adjust {
                colour_profile: super::ColourProfile::None,
                ..written_out
            },
        );
        assert!(
            unmatched == neutral_at_camera,
            "a None profile moved a slider off the camera's"
        );
        assert!(
            worst(&unmatched, &graded_as(None, None, super::Adjust::none())) > 100,
            "the camera's sliders did nothing"
        );

        let one_stop = colour::matched::HdrColour {
            exposure: Stops::measured(1.0),
            ..fitted.clone()
        };
        assert_eq!(plain, graded(&one_stop, None, None));
        let zero = graded(&one_stop, Some(Stops::ZERO), None);
        let middle = plain
            .iter()
            .position(|&code| (1000..30000).contains(&code))
            .expect("a midtone");
        let ratio = f64::from(zero[middle]) / f64::from(plain[middle]);
        assert!(
            (ratio - 0.5).abs() < 0.01,
            "zero exposure left midtone at {ratio:.3} of match"
        );
    }

    /// The temperature reaches a frame that is already up.
    ///
    /// **The editor holds one upload for the life of an open**, so anything the balance is
    /// settled with there is settled for every tick after it - and a Temperature drag then moves
    /// a slider that changes no pixel, on the one host where that drag exists. Two draws off one
    /// [`Uploaded`], which is the shape a tick has and the shape a rendition never has.
    #[test]
    fn the_balance_follows_the_slider_after_the_frame_is_up() {
        let Some(gpu) = gpu::device() else { return };
        let Some(base) = crate::base::device(gpu) else {
            return;
        };

        let (width, height) = (64usize, 64usize);
        let frame: Vec<u16> = (0..width * height * 3)
            .map(|i| ((i * 37) % 30000) as u16)
            .collect();
        let colour = colour::matched::HdrColour::identity();
        let shown = super::Canvas {
            region: (0.0, 0.0, width as f64, height as f64),
            size: units::px::Size::measured(width, height),
            max_lod: 0,
        };
        let grade = |adjust| super::Grade {
            colour: Some(&colour),
            adjust,
            // Without one there is no illuminant to move away from and the shader is right to
            // leave the frame alone, which would make this test pass on a broken balance.
            as_shot: Some(colour::white_balance::Illuminant {
                temperature: 5500.0,
                tint: 0.0,
            }),
            output: super::Output::Rolled,
            canvas: Some(shown),
            ..super::Grade::new(
                width,
                height,
                colour::tone::Levels {
                    white: Light::measured(1.0),
                    peak: Light::measured(1.0),
                    floor: None,
                },
                Light::exactly(203.0),
                Light::exactly(1000.0),
            )
        };

        let peak = crate::grade::device(gpu).scene_peak();
        let uploaded = crate::grade::device(gpu).upload(&frame, &grade(super::Adjust::none()), &peak);
        let pyramid = crate::base::pyramid(gpu, base, &frame, (width, height)).expect("a pyramid");

        let unmoved = uploaded.draw(&grade(super::Adjust::none()), &pyramid);
        let warmed = super::Adjust {
            temperature: Some(3000.0),
            ..super::Adjust::none()
        };
        let moved = uploaded.draw(&grade(warmed), &pyramid);

        let apart = unmoved
            .iter()
            .zip(&moved)
            .filter(|(before, after)| (**before - **after).abs() > 1e-3)
            .count();
        assert!(
            apart > unmoved.len() / 4,
            "2500K off the frame's own illuminant moved {apart} of {} drawn components",
            unmoved.len(),
        );
    }

    #[test]
    fn a_neutral_draw_over_a_matched_upload_is_the_neutral_picture() {
        let Some(gpu) = gpu::device() else { return };
        let Some(base) = crate::base::device(gpu) else {
            return;
        };

        let (width, height) = (64usize, 64usize);
        let frame: Vec<u16> = (0..width * height * 3)
            .map(|i| {
                let (x, y) = ((i / 3) % width, (i / 3) / width);
                (6000.0 + 4000.0 * ((x + y * 2 + (i % 3) * 7) % 11) as f64) as u16
            })
            .collect();
        let mut colour = colour::matched::HdrColour::identity();
        for (channel, curve) in colour.curves.iter_mut().enumerate() {
            let shoulder = 0.5 + channel as f64 * 0.08;
            let bins = curve.len();
            for (at, value) in curve.iter_mut().enumerate() {
                let x = (at as f64 / (bins - 1) as f64) * colour::matched::TRUST_CEILING;
                *value = x / (1.0 + x * shoulder) * (1.0 + shoulder);
            }
        }
        let grade = |adjust: super::Adjust| super::Grade {
            colour: adjust.colour(Some(&colour)),
            adjust,
            output: super::Output::Rolled,
            canvas: Some(super::Canvas {
                region: (0.0, 0.0, width as f64, height as f64),
                size: units::px::Size::measured(width, height),
                max_lod: 0,
            }),
            ..super::Grade::new(
                width,
                height,
                colour::tone::Levels {
                    white: Light::measured(1.0),
                    peak: Light::measured(1.0),
                    floor: None,
                },
                Light::exactly(203.0),
                Light::exactly(1000.0),
            )
        };
        let matched = super::Adjust::none();
        let neutral = super::Adjust {
            colour_profile: super::ColourProfile::None,
            ..super::Adjust::none()
        };
        let pyramid = crate::base::pyramid(gpu, base, &frame, (width, height)).expect("a pyramid");

        let editor = crate::grade::device(gpu).upload(&frame, &grade(matched.clone()), &crate::grade::device(gpu).scene_peak());
        let rendition = crate::grade::device(gpu).upload(&frame, &grade(neutral.clone()), &crate::grade::device(gpu).scene_peak());

        let shown = editor.draw(&grade(neutral.clone()), &pyramid);
        assert_eq!(shown, rendition.draw(&grade(neutral), &pyramid));
        assert_ne!(
            shown,
            editor.draw(&grade(matched), &pyramid),
            "the match moved nothing"
        );
    }

    /// The forward map against the inverse, over the slider's whole range.
    ///
    /// **The one property neither entry point can check alone.** `xy_of` turns a temperature
    /// and a tint into a chromaticity and `as_shot` walks it back, over one locus table but by
    /// different arithmetic - a search against a closed form - so a chromaticity that goes out
    /// has to come back. What would break is quiet: a Lightroom sidecar's 5000K would land on
    /// an illuminant that is not Lightroom's 5000K, and the photograph would simply be the
    /// wrong colour.
    ///
    /// Run through a probe entry point rather than through a rendition, because a matrix that
    /// happens to look plausible is exactly what this is trying not to accept.
    #[test]
    fn the_shader_solves_the_illuminant_this_crate_reads_back() {
        let Some(gpu) = gpu::device() else {
            eprintln!(
                "SKIPPED: no adapter answered, so the white balance maps were not compared. \
                 Nothing else checks that the shader and this crate agree about an illuminant.",
            );
            return;
        };
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("probe_xy"),
            source: wgpu::ShaderSource::Wgsl(
                shaders::PROBE_XY.source.into(),
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
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("probe_xy"),
                    bind_group_layouts: &[Some(&layout)],
                    ..Default::default()
                }),
            ),
            module: &module,
            entry_point: Some("probe_xy"),
            compilation_options: Default::default(),
            cache: None,
        });
        let out = gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some("probe_xy"),
            size: super::BALANCE_FLOATS * 4,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some("probe_xy"),
            size: 8,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let colour = colour::matched::HdrColour::identity();
        let mut worst_temperature = 0.0f64;
        let mut worst_tint = 0.0f64;
        // The document's whole range, and the tint's, including the ends where the locus table
        // is coarsest and a transcription slip would show first.
        for temperature in [
            2000.0, 2700.0, 3200.0, 5000.0, 5500.0, 6500.0, 10000.0, 20000.0, 50000.0,
        ] {
            for tint in [-150.0, -50.0, 0.0, 25.0, 150.0] {
                let asked = colour::white_balance::Illuminant { temperature, tint };
                let grade = super::Grade {
                    adjust: super::Adjust {
                        temperature: Some(temperature),
                        tint: Some(tint),
                        ..super::Adjust::none()
                    },
                    as_shot: Some(asked),
                    ..super::Grade::new(
                        1,
                        1,
                        colour::tone::Levels {
                            white: Light::measured(1.0),
                            peak: Light::measured(1.0),
                            floor: None,
                        },
                        Light::exactly(203.0),
                        Light::exactly(1000.0),
                    )
                };
                let edits = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("probe_xy"),
                    contents: &super::uniform(&grade, &colour),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("probe_xy"),
                    layout: &layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: edits.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 14,
                            resource: out.as_entire_binding(),
                        },
                    ],
                });
                let mut recording = gpu.record();
                recording.dispatch([1, 1, 1], super::dispatch::Whole::Fixed, |pass| {
                    pass.set_pipeline(&pipeline);
                    pass.set_bind_group(0, &group, &[]);
                });
                recording.copy_buffer_to_buffer(&out, 0, &readback, 0, 8);
                recording.submit();
                let slice = readback.slice(..);
                slice.map_async(wgpu::MapMode::Read, |_| {});
                gpu.block_until_done();
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

                // The camera that reports the probed chromaticity outright: multipliers of one,
                // and a matrix whose inverse is that chromaticity's tristimulus values. Diagonal
                // rather than the identity with the values as multipliers, because a tint far off
                // the locus puts `Z` negative and a negative multiplier is a decline.
                let (big_x, big_z) = (x / y, (1.0 - x - y) / y);
                let back = pollster::block_on(colour::white_balance::as_shot(
                    gpu,
                    &[1.0, 1.0, 1.0, 0.0],
                    &[
                        [(1.0 / big_x) as f32, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, (1.0 / big_z) as f32],
                        [0.0, 0.0, 0.0],
                    ],
                ))
                .expect("an invertible matrix");
                worst_temperature =
                    worst_temperature.max((back.temperature - temperature).abs() / temperature);
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

    /// The shader's crop against this crate's, pixel for pixel.
    ///
    /// Both hosts run the shader, so this holds no two renderers together - what it
    /// pins is `geometry.slang` against `geometry::warp::Plan::at`, which is the mapping Rust needs to work
    /// out what a cropped render has to decode. The two are four lines of arithmetic each and
    /// nothing else compares them.
    ///
    /// Every case moves something the arithmetic could get wrong: a crop off-centre, a
    /// straighten in both directions, each quarter turn, and the two composed.
    #[test]
    fn the_draw_places_a_pixel_where_the_gather_does() {
        let Some(gpu) = gpu::device() else {
            eprintln!(
                "SKIPPED: no adapter answered, so the editor's crop was not compared with the \
                 gather's. Nothing else checks that the preview is the picture.",
            );
            return;
        };
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("probe_geometry"),
            source: wgpu::ShaderSource::Wgsl(
                shaders::PROBE_GEOMETRY.source.into(),
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
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("probe_geometry"),
                    bind_group_layouts: &[Some(&layout)],
                    ..Default::default()
                }),
            ),
            module: &module,
            entry_point: Some("probe_geometry"),
            compilation_options: Default::default(),
            cache: None,
        });

        let colour = colour::matched::HdrColour::identity();
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
        let cases: [geometry::warp::Geometry; 10] = [
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

        // Each geometry over the whole photograph, and then over a frame that is a *window* on it -
        // which is what a render whose crop let it decode less is handed. The mapping is the
        // photograph's either way and the origin comes off the answer, so the windowed run has to
        // land exactly the unwindowed one shifted, and that is what is asserted below.
        let mut worst = 0.0f64;
        for (geometry, origin) in cases
            .iter()
            .flat_map(|g| [(*g, (0usize, 0usize)), (*g, (37, 23))])
        {
            let out = geometry::warp::cropped_size(full.0, full.1, geometry);
            let pixels = out.0 * out.1;
            let bytes = (pixels * 2 * 4) as u64;
            let probe = gpu.own_buffer(&wgpu::BufferDescriptor {
                label: Some("probe_geometry"),
                size: bytes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            let readback = gpu.own_buffer(&wgpu::BufferDescriptor {
                label: Some("probe_geometry"),
                size: bytes,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });

            let windowed = origin != (0, 0);
            let grade = super::Grade {
                photograph_long: units::px::Span::measured(full.0.max(full.1)),
                geometry,
                window: match windowed {
                    true => Some(super::Window {
                        photograph: units::px::Size::exact(full.0, full.1),
                        origin: units::px::At::exact(origin.0, origin.1),
                    }),
                    false => None,
                },
                // The buffer, which for the windowed run is smaller than the photograph. Nothing in
                // the mapping reads it; what it does is stop the identity short-circuit taking a
                // run that has an origin to subtract.
                ..super::Grade::new(
                    full.0 - origin.0,
                    full.1 - origin.1,
                    colour::tone::Levels {
                        white: Light::measured(1.0),
                        peak: Light::measured(1.0),
                        floor: None,
                    },
                    Light::exactly(203.0),
                    Light::exactly(1000.0),
                )
            };
            assert_eq!(
                grade.output_size(),
                out,
                "the probe's grid is not what the grade writes"
            );
            let words = super::uniform_words(&grade, &colour);

            let edits = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("probe_geometry"),
                contents: &words
                    .iter()
                    .flat_map(|v| v.to_le_bytes())
                    .collect::<Vec<u8>>(),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("probe_geometry"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: edits.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 6,
                        resource: probe.as_entire_binding(),
                    },
                ],
            });

            let mut recording = gpu.record();
            recording.dispatch(
                [pixels.div_ceil(64) as u32, 1, 1],
                super::dispatch::Whole::Measured,
                |pass| {
                    pass.set_pipeline(&pipeline);
                    pass.set_bind_group(0, &group, &[]);
                },
            );
            recording.copy_buffer_to_buffer(&probe, 0, &readback, 0, bytes);
            recording.submit();
            let slice = readback.slice(..);
            slice.map_async(wgpu::MapMode::Read, |_| {});
            gpu.block_until_done();
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
                    let whole = geometry::warp::geometry_at(
                        full,
                        out,
                        geometry,
                        x as f64 + 0.5,
                        y as f64 + 0.5,
                    );
                    // The photograph's answer, moved into the buffer. A window changes where the
                    // pixel is *read*, never where the mapping sent it.
                    let want = (whole.0 - origin.0 as f64, whole.1 - origin.1 as f64);
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
        assert!(
            worst < 0.01,
            "the draw is {worst:.5} pixels from the gather at worst"
        );
    }
}