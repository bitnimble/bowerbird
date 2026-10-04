//! The colour of the light around every clipped highlight (`slang/highlight_field.slang`), read by
//! every tile `assemble.slang` reconstructs.
//!
//! A region measures the field its tile shares with the frame only over `reach` around the tile,
//! starting on `grid`; anything smaller is a different field.

use crate::gpu::Gpu;
use crate::px::{At, Sensor, Span};

const CELL_SITES: usize = 4;

/// Levels of the push-pull, which bounds how far a place's field reaches (`reach`): uncapped, a
/// region could not measure the field its tile shares with the frame.
const LEVELS: usize = 5;

fn site(cfa: &crate::cfa::Cfa) -> usize {
    let (period_w, period_h) = cfa.period();
    crate::decode_rawler::reduction(cfa).unwrap_or(period_w.max(period_h))
}

/// Photosites around a place that its field depends on: every level's cell above level 0 lends
/// through a bilinear one cell wide, the top level's own cell and its neighbours (`top_light`), the
/// level-0 bilinear read and the site's centred window.
pub fn reach(cfa: &crate::cfa::Cfa) -> usize {
    let cell = CELL_SITES * site(cfa);
    cell * ((1 << LEVELS) + 2 * (1 << (LEVELS - 1)) + 1) + site(cfa)
}

/// The grid a region's origin must sit on for its cells, at every level, to be the frame's.
pub fn grid(cfa: &crate::cfa::Cfa) -> usize {
    CELL_SITES * site(cfa) << (LEVELS - 1)
}

const SHADER: &str = "highlight_field.wgsl";

/// What `measure` writes, for `wgsl_layout`, which holds it against the struct the shader declares.
#[cfg(test)]
pub(crate) fn params_block() -> usize {
    std::mem::size_of::<Params>()
}

/// `Field` in `highlight_field.slang`.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    width: u32,
    height: u32,
    offset: u32,
    coarse_width: u32,
    coarse_height: u32,
    coarse_offset: u32,
    site: u32,
    cell_sites: u32,
    ceiling: [f32; 4],
}

pub(crate) struct Kernels {
    layout: wgpu::BindGroupLayout,
    seed: wgpu::ComputePipeline,
    seed_xtrans: wgpu::ComputePipeline,
    push: wgpu::ComputePipeline,
    pull: wgpu::ComputePipeline,
}

pub(crate) fn device(gpu: &'static Gpu) -> Option<&'static Kernels> {
    static BUILT: std::sync::OnceLock<Option<Kernels>> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Kernels::new(gpu)).as_ref()
}

impl Kernels {
    fn new(gpu: &'static Gpu) -> Option<Kernels> {
        let rcd = crate::demosaic::device(gpu)?;
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("highlight field"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/highlight_field.wgsl")).into(),
            ),
        });
        let storage = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: false },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("highlight field"),
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
                storage(1),
                storage(2),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("highlight field"),
            bind_group_layouts: &[Some(rcd.frame_layout()), Some(&layout)],
            ..Default::default()
        });
        let pipeline = |entry: &str, cfa: &crate::cfa::Cfa| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(entry),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: crate::wgsl_overrides::for_entry(SHADER, entry, &cfa.constants()),
                    ..Default::default()
                },
                cache: None,
            })
        };
        let bayer = crate::cfa::Cfa::bayer([0, 1, 1, 2])?;
        let xtrans = crate::cfa::Cfa::new(6, 6, &[1; 36])?;
        Some(Kernels {
            seed: pipeline("field_seed", &bayer),
            seed_xtrans: pipeline("field_seed", &xtrans),
            push: pipeline("field_push", &bayer),
            pull: pipeline("field_pull", &bayer),
            layout,
        })
    }
}

/// How much of the surrounding light's colour a reconstructed highlight keeps, against blowing out
/// to neutral white: where a channel still reads, and where every channel ran out. A pixel moves
/// from the first to the second as its last channels fill.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Colouring {
    pub reading: f32,
    pub blown: f32,
}

impl Colouring {
    pub const DEFAULT: Colouring = Colouring::at(1.0);

    /// The Detail panel's one amount, 0 to 1: its first half brings the colour into highlights
    /// whose channels still read, its second into those that ran out entirely.
    pub const fn at(amount: f64) -> Colouring {
        let amount = amount as f32;
        Colouring {
            reading: (amount * 2.0).clamp(0.0, 1.0),
            blown: (amount * 2.0 - 1.0).clamp(0.0, 1.0),
        }
    }
}

/// The filled colour share at every level-0 cell of a mosaic.
#[derive(Clone)]
pub struct Field {
    pub(crate) buffer: crate::gpu::Buffer,
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) cell: Span<Sensor>,
}

/// A field, where the mosaic a dispatch reads starts inside the one it was measured over, and how
/// much of its colour that dispatch keeps.
#[derive(Clone, Copy)]
pub struct Seen<'a> {
    pub field: &'a Field,
    pub origin: At<Sensor>,
    pub colouring: Colouring,
}

impl Field {
    pub fn seen(&self) -> Seen<'_> {
        self.seen_from(At::ORIGIN)
    }

    pub fn seen_from(&self, origin: At<Sensor>) -> Seen<'_> {
        Seen {
            field: self,
            origin,
            colouring: Colouring::DEFAULT,
        }
    }
}

impl<'a> Seen<'a> {
    pub fn coloured(self, colouring: Colouring) -> Seen<'a> {
        Seen { colouring, ..self }
    }

    /// The same field, from a window at `at` inside this one's mosaic.
    pub fn inside(&self, at: At<Sensor>) -> Seen<'a> {
        let ((x, y), (left, top)) = (self.origin.raw(), at.raw());
        Seen {
            colouring: self.colouring,
            field: self.field,
            origin: At::exact(x + left, y + top),
        }
    }
}

/// The field over `mosaic`, recorded and submitted; queue order puts it ahead of every demosaic
/// that reads it.
pub fn measure(
    gpu: &'static Gpu,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    ceiling: [f32; 3],
) -> Option<Field> {
    let kernels = device(gpu)?;
    let rcd = crate::demosaic::device(gpu)?;
    let site = site(cfa);
    let cell = CELL_SITES * site;

    let mut sizes = vec![(mosaic.width.div_ceil(cell), mosaic.height.div_ceil(cell))];
    while let Some(&(w, h)) = sizes
        .last()
        .filter(|&&(w, h)| (w > 1 || h > 1) && sizes.len() < LEVELS)
    {
        sizes.push((w.div_ceil(2), h.div_ceil(2)));
    }
    let offsets: Vec<usize> = sizes
        .iter()
        .scan(0, |at, &(w, h)| {
            let here = *at;
            *at += w * h;
            Some(here)
        })
        .collect();
    let (top_w, top_h) = sizes[sizes.len() - 1];
    let cells = offsets[offsets.len() - 1] + top_w * top_h;
    let buffer = |label| {
        gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: (cells * 16) as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        })
    };
    let (levels, estimates) = (buffer("highlight levels"), buffer("highlight estimates"));
    let (_shape, shape_group) = crate::demosaic::shape_group(gpu, rcd, cfa, mosaic, 0);

    let mut recording = gpu.record();
    recording.holding(&levels);
    recording.holding(&estimates);
    let level = |k: usize| (sizes[k].0, sizes[k].1, offsets[k]);
    let mut dispatch = |pipeline: &wgpu::ComputePipeline,
                        k: usize,
                        coarse: Option<usize>,
                        over: (usize, usize)| {
        let (width, height, offset) = level(k);
        let (coarse_width, coarse_height, coarse_offset) = coarse.map_or((0, 0, 0), level);
        let params = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("highlight field params"),
            contents: bytemuck::bytes_of(&Params {
                width: width as u32,
                height: height as u32,
                offset: offset as u32,
                coarse_width: coarse_width as u32,
                coarse_height: coarse_height as u32,
                coarse_offset: coarse_offset as u32,
                site: site as u32,
                cell_sites: CELL_SITES as u32,
                ceiling: [ceiling[0], ceiling[1], ceiling[2], 0.0],
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("highlight field"),
            layout: &kernels.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: levels.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: estimates.as_entire_binding(),
                },
            ],
        });
        let mut pass = recording
            .encoder()
            .begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("highlight field"),
                timestamp_writes: None,
            });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &shape_group, &[]);
        pass.set_bind_group(1, &group, &[]);
        pass.dispatch_workgroups(
            (over.0 as u32).div_ceil(8).max(1),
            (over.1 as u32).div_ceil(8).max(1),
            1,
        );
    };
    let seed = match cfa.is_bayer() {
        true => &kernels.seed,
        false => &kernels.seed_xtrans,
    };
    dispatch(seed, 0, None, sizes[0]);
    for k in 0..sizes.len() - 1 {
        dispatch(&kernels.push, k, Some(k + 1), sizes[k + 1]);
    }
    for k in (0..sizes.len()).rev() {
        let above = (k + 1 < sizes.len()).then_some(k + 1);
        dispatch(&kernels.pull, k, above, sizes[k]);
    }
    recording.submit();
    Some(Field {
        buffer: estimates,
        width: sizes[0].0,
        height: sizes[0].1,
        cell: Span::exact(cell),
    })
}
