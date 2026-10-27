//! A burst's local displacement field, measured coarse to fine on 2x2-block luma on the GPU.
//!
//! Each block sees every Bayer filter once, so odd-photosite shifts remain comparable. The same
//! sensor-anchored tiles measure whole-site tripod offsets and fractional handheld offsets.

use crate::condition::Mosaic;
use gpu::dispatch::Whole;
use gpu::{Buffer, Gpu};
use units::px::{Sensor, Span};

pub const TILE: Span<Sensor> = Span::exact(64);
// One step either side below the coarsest level: repeated texture finer than a search's reach
// offers a whole period's slip as a match as good as the true one.
const SEARCH: [Span<Sensor>; 2] = [Span::exact(2), Span::exact(4)];
const PATCH: [Span<Sensor>; 3] = [Span::exact(10), Span::exact(12), Span::exact(24)];
const COARSE_STEP: Span<Sensor> = Span::exact(8);
const REFINE_RADIUS: Span<Sensor> = Span::exact(24);
pub const REFERENCE_MARGIN: Span<Sensor> = Span::exact(
    TILE.raw()
        + if PATCH[2].raw() > REFINE_RADIUS.raw() + 2 {
            PATCH[2].raw()
        } else {
            REFINE_RADIUS.raw() + 2
        }
        + COARSE_STEP.raw() / 2,
);
// align.slang's `REFINE_REACH`, and two for `frame_cubic`'s stencil past it.
const REFINED_AND_SAMPLED: Span<Sensor> = Span::exact(3 + 2);

/// How far past the window a frame cut around its prior is read: the reference's margin, then
/// everywhere `search` and each finer level may move a tile off the prior.
pub fn frame_margin(search: Search) -> Span<Sensor> {
    Span::exact(
        REFERENCE_MARGIN.raw()
            + search.reach.raw()
            + SEARCH.iter().map(|reach| reach.raw()).sum::<usize>()
            + REFINED_AND_SAMPLED.raw(),
    )
}

/// How far the coarsest level looks from the prior, and what straying from the prior costs a match.
#[derive(Clone, Copy)]
pub struct Search {
    pub reach: Span<Sensor>,
    /// Correlation given up per squared photosite from the prior.
    pub penalty: f32,
}

impl Search {
    /// A prior from a recipe already placing the frame within a few photosites.
    pub const AROUND_PRIOR: Search = Search {
        reach: Span::exact(64),
        penalty: 0.0003,
    };

    /// No prior worth leaning on: a frame anywhere within a sixth of `long`.
    pub fn unplaced(long: usize) -> Search {
        let reach = (long / 6).max(64);
        Search {
            reach: Span::exact(reach),
            penalty: 0.1 / (reach * reach) as f32,
        }
    }
}

/// A frame's light against the reference's, and where each photosite of its mosaic saturates.
#[derive(Clone, Copy)]
pub struct Exposure {
    pub gain: f32,
    /// By position in the mosaic's 2x2, row-major from its origin.
    pub ceilings: [f32; 4],
}

impl Exposure {
    #[cfg(test)]
    pub const UNCLIPPED: Exposure = Exposure {
        gain: 1.0,
        ceilings: [f32::INFINITY; 4],
    };

    pub fn of(cfa: &crate::cfa::Cfa, ceiling: [f32; 3], gain: f32) -> Exposure {
        let at = |row, column| ceiling[usize::from(cfa.colour_at(row, column)).min(2)];
        Exposure {
            gain,
            ceilings: [at(0, 0), at(0, 1), at(1, 0), at(1, 1)],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct LumaParams {
    width: u32,
    height: u32,
    output_width: u32,
    output_height: u32,
    gain: f32,
    ceilings: [f32; 4],
    tile: u32,
    pad: [u32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct AlignParams {
    reference_width: u32,
    reference_height: u32,
    frame_width: u32,
    frame_height: u32,
    reference_left: i32,
    reference_top: i32,
    frame_left: i32,
    frame_top: i32,
    grid_left: i32,
    grid_top: i32,
    grid_width: u32,
    grid_height: u32,
    step: u32,
    reach: i32,
    patch: i32,
    has_previous: u32,
    tile: u32,
    penalty: f32,
    pad1: u32,
    pad2: u32,
}

#[cfg(test)]
pub(crate) fn luma_block() -> usize {
    std::mem::size_of::<LumaParams>()
}

#[cfg(test)]
pub(crate) fn align_block() -> usize {
    std::mem::size_of::<AlignParams>()
}

fn luma_kernel(gpu: &'static Gpu, entry: &'static str) -> &'static gpu::compute::Kernel {
    use gpu::compute::{READ, UNIFORM, WRITE};
    static BLOCK: gpu::Cache<gpu::compute::Kernel> = gpu::Cache::new();
    static REDUCE: gpu::Cache<gpu::compute::Kernel> = gpu::Cache::new();
    static SITE: gpu::Cache<gpu::compute::Kernel> = gpu::Cache::new();
    static DETAIL: gpu::Cache<gpu::compute::Kernel> = gpu::Cache::new();
    let cell = match entry {
        "block_luma" => &BLOCK,
        "site_luma" => &SITE,
        "detail" => &DETAIL,
        _ => &REDUCE,
    };
    cell.get(gpu, || {
        gpu::compute::kernel(
            gpu,
            entry,
            shaders::ALIGN_LUMA.source,
            &[(0, UNIFORM), (1, READ), (2, WRITE)],
            &[],
        )
    })
}

fn align_kernel(gpu: &'static Gpu, entry: &'static str) -> &'static gpu::compute::Kernel {
    use gpu::compute::{READ, UNIFORM, WRITE};
    static ALIGN: gpu::Cache<gpu::compute::Kernel> = gpu::Cache::new();
    static REFINE: gpu::Cache<gpu::compute::Kernel> = gpu::Cache::new();
    static REGULARIZE: gpu::Cache<gpu::compute::Kernel> = gpu::Cache::new();
    static FILL: gpu::Cache<gpu::compute::Kernel> = gpu::Cache::new();
    let cell = match entry {
        "align" => &ALIGN,
        "refine" => &REFINE,
        "fill" => &FILL,
        _ => &REGULARIZE,
    };
    cell.get(gpu, || {
        gpu::compute::kernel(
            gpu,
            entry,
            shaders::ALIGN.source,
            &[
                (0, UNIFORM),
                (1, READ),
                (2, READ),
                (3, READ),
                (4, WRITE),
                (5, READ),
            ],
            &[],
        )
    })
}

struct Plane {
    buffer: Buffer,
    width: usize,
    height: usize,
    step: usize,
}

#[track_caller]
fn plane(
    gpu: &'static Gpu,
    recording: &mut gpu::Recording<'static>,
    source: &Buffer,
    width: usize,
    height: usize,
    step: usize,
    entry: &'static str,
    exposure: Exposure,
) -> Plane {
    let halving = if step == 1 { 1 } else { 2 };
    let output_width = width.div_ceil(halving);
    let output_height = height.div_ceil(halving);
    let output = gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some("align luma"),
        size: (output_width * output_height * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    let params = LumaParams {
        width: width as u32,
        height: height as u32,
        output_width: output_width as u32,
        output_height: output_height as u32,
        gain: exposure.gain,
        ceilings: exposure.ceilings,
        tile: 0,
        pad: [0; 2],
    };
    let kernel = luma_kernel(gpu, entry);
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("align luma params"),
        contents: bytemuck::bytes_of(&params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    recording.holding(source);
    recording.holding(&output);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("align luma"),
        layout: &kernel.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: source.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: output.as_entire_binding(),
            },
        ],
    });
    recording.dispatch(
        [
            (output_width as u32).div_ceil(8),
            (output_height as u32).div_ceil(8),
            1,
        ],
        Whole::Measured,
        |pass| {
            pass.set_pipeline(&kernel.pipeline);
            pass.set_bind_group(0, &group, &[]);
        },
    );
    Plane {
        buffer: output,
        width: output_width,
        height: output_height,
        step,
    }
}

pub struct Pyramid {
    sites: Plane,
    planes: [Plane; 3],
}

impl Pyramid {
    /// The full-resolution luma the refinement reads, one value a photosite.
    pub fn sites(&self) -> &Buffer {
        &self.sites.buffer
    }

    pub fn of(gpu: &'static Gpu, mosaic: &Mosaic, exposure: Exposure) -> Pyramid {
        let mut recording = gpu.record();
        let pyramid = Pyramid::record(gpu, &mut recording, mosaic, exposure);
        recording.submit();
        pyramid
    }

    fn record(
        gpu: &'static Gpu,
        recording: &mut gpu::Recording<'static>,
        mosaic: &Mosaic,
        exposure: Exposure,
    ) -> Pyramid {
        let sites = plane(
            gpu,
            recording,
            &mosaic.buffer,
            mosaic.width,
            mosaic.height,
            1,
            "site_luma",
            exposure,
        );
        let base = plane(
            gpu,
            recording,
            &mosaic.buffer,
            mosaic.width,
            mosaic.height,
            2,
            "block_luma",
            exposure,
        );
        let middle = plane(
            gpu,
            recording,
            &base.buffer,
            base.width,
            base.height,
            4,
            "reduce_luma",
            exposure,
        );
        let coarse = plane(
            gpu,
            recording,
            &middle.buffer,
            middle.width,
            middle.height,
            COARSE_STEP.raw(),
            "reduce_luma",
            exposure,
        );
        Pyramid {
            sites,
            planes: [base, middle, coarse],
        }
    }
}

pub struct Field {
    pub buffer: Buffer,
    pub left: i32,
    pub top: i32,
    pub width: usize,
    pub height: usize,
}

/// One tile of a [`Field`]: where it sits on the reference, and where the frame has it.
#[derive(Clone, Copy, Debug)]
pub struct Placed {
    pub at: [f64; 2],
    pub moved: [f64; 2],
    pub score: f64,
}

impl Field {
    /// The tiles a search placed itself, leaving out those that took their neighbours' answer.
    pub async fn placed(&self, gpu: &'static Gpu) -> Option<Vec<Placed>> {
        let values = read_floats(gpu, &self.buffer, self.width * self.height * 4).await?;
        let tile = TILE.raw() as f64;
        Some(
            values
                .chunks_exact(4)
                .enumerate()
                .filter(|(_, value)| value[2] > 0.0 && value[3] > 0.0)
                .map(|(at, value)| Placed {
                    at: [
                        self.left as f64 + (at % self.width) as f64 * tile + tile / 2.0,
                        self.top as f64 + (at / self.width) as f64 * tile + tile / 2.0,
                    ],
                    moved: [f64::from(value[0]), f64::from(value[1])],
                    score: f64::from(value[2]),
                })
                .collect(),
        )
    }
}

/// How much of a luma plane's contrast is fine detail, which blur takes and exposure scales out of.
pub async fn sharpness(gpu: &'static Gpu, luma: &Mosaic) -> Option<f64> {
    let tile = TILE.raw();
    let (across, down) = (luma.width.div_ceil(tile), luma.height.div_ceil(tile));
    let output = gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some("align detail"),
        size: (across * down * 8) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let params = LumaParams {
        width: luma.width as u32,
        height: luma.height as u32,
        output_width: across as u32,
        output_height: down as u32,
        gain: 1.0,
        ceilings: [1.0; 4],
        tile: tile as u32,
        pad: [0; 2],
    };
    let kernel = luma_kernel(gpu, "detail");
    let mut recording = gpu.record();
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("align detail params"),
        contents: bytemuck::bytes_of(&params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    recording.holding(&luma.buffer);
    recording.holding(&output);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("align detail"),
        layout: &kernel.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: luma.buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: output.as_entire_binding(),
            },
        ],
    });
    recording.dispatch(
        [(across as u32).div_ceil(8), (down as u32).div_ceil(8), 1],
        Whole::Measured,
        |pass| {
            pass.set_pipeline(&kernel.pipeline);
            pass.set_bind_group(0, &group, &[]);
        },
    );
    let tiles = read_floats(gpu, &output, across * down * 2).await?;
    let (fine, contrast) = tiles
        .chunks_exact(2)
        .fold((0.0, 0.0), |(fine, contrast), tile| {
            (fine + f64::from(tile[0]), contrast + f64::from(tile[1]))
        });
    (contrast > 0.0).then(|| fine / contrast)
}

pub(crate) async fn read_floats(
    gpu: &'static Gpu,
    buffer: &Buffer,
    count: usize,
) -> Option<Vec<f32>> {
    let bytes = (count * 4) as u64;
    let mut recording = gpu.record();
    let readback = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("align readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    recording.copy_buffer_to_buffer(buffer, 0, &readback, 0, bytes);
    recording.submit();
    gpu::read_back(gpu, &readback, |mapped| {
        bytemuck::cast_slice::<u8, f32>(mapped).to_vec()
    })
    .await
}

pub fn measure(
    gpu: &'static Gpu,
    reference: &Pyramid,
    frame: &Mosaic,
    exposure: Exposure,
    reference_origin: units::px::At<Sensor>,
    frame_origin: units::px::At<Sensor>,
    window: units::px::Rect<Sensor>,
    prior_at: impl Fn(f64, f64) -> crate::burst::Offset,
    search: Search,
) -> Field {
    let (reference_left, reference_top) = reference_origin.raw();
    let (frame_left, frame_top) = frame_origin.raw();
    let window = window.raw();
    let tile = TILE.raw() as i32;
    let left = ((window.0 as i32 - tile / 2).div_euclid(tile)) * tile;
    let top = ((window.1 as i32 - tile / 2).div_euclid(tile)) * tile;
    let width = ((window.0 + window.2) as i32 - left + tile / 2).div_euclid(tile) as usize + 1;
    let height = ((window.1 + window.3) as i32 - top + tile / 2).div_euclid(tile) as usize + 1;
    let mut prior_values = Vec::with_capacity(width * height * 2);
    for y in 0..height {
        for x in 0..width {
            let sensor_x = left as f64 + (x * TILE.raw() + TILE.raw() / 2) as f64;
            let sensor_y = top as f64 + (y * TILE.raw() + TILE.raw() / 2) as f64;
            let prior = prior_at(sensor_x, sensor_y);
            prior_values.extend([prior.x.raw() as f32, prior.y.raw() as f32]);
        }
    }
    let priors = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("align tile priors"),
        contents: bytemuck::cast_slice(&prior_values),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let mut recording = gpu.record();
    let frame_planes = Pyramid::record(gpu, &mut recording, frame, exposure);
    let stub = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("align empty field"),
        contents: &[0u8; 16],
        usage: wgpu::BufferUsages::STORAGE,
    });
    let mut previous = stub;
    for level in (0..3).rev() {
        let ours = &reference.planes[level];
        let theirs = &frame_planes.planes[level];
        let reach = SEARCH.get(level).copied().unwrap_or(search.reach);
        let params = AlignParams {
            reference_width: ours.width as u32,
            reference_height: ours.height as u32,
            frame_width: theirs.width as u32,
            frame_height: theirs.height as u32,
            reference_left: reference_left as i32,
            reference_top: reference_top as i32,
            frame_left: frame_left as i32,
            frame_top: frame_top as i32,
            grid_left: left,
            grid_top: top,
            grid_width: width as u32,
            grid_height: height as u32,
            step: ours.step as u32,
            reach: (reach.raw() / ours.step) as i32,
            patch: (PATCH[level].raw() / ours.step) as i32,
            has_previous: u32::from(level != 2),
            tile: TILE.raw() as u32,
            penalty: search.penalty,
            pad1: 0,
            pad2: 0,
        };
        previous = dispatch(
            gpu,
            &mut recording,
            "align",
            &params,
            &ours.buffer,
            &theirs.buffer,
            &previous,
            &priors,
            width,
            height,
        );
    }
    let params = AlignParams {
        reference_width: reference.sites.width as u32,
        reference_height: reference.sites.height as u32,
        frame_width: frame_planes.sites.width as u32,
        frame_height: frame_planes.sites.height as u32,
        reference_left: reference_left as i32,
        reference_top: reference_top as i32,
        frame_left: frame_left as i32,
        frame_top: frame_top as i32,
        grid_left: left,
        grid_top: top,
        grid_width: width as u32,
        grid_height: height as u32,
        step: 1,
        reach: 0,
        patch: REFINE_RADIUS.raw() as i32,
        has_previous: 1,
        tile: TILE.raw() as u32,
        penalty: 0.0,
        pad1: 0,
        pad2: 0,
    };
    previous = dispatch(
        gpu,
        &mut recording,
        "refine",
        &params,
        &reference.sites.buffer,
        &frame_planes.sites.buffer,
        &previous,
        &priors,
        width,
        height,
    );
    let params = AlignParams {
        reference_width: 0,
        reference_height: 0,
        frame_width: 0,
        frame_height: 0,
        reference_left: 0,
        reference_top: 0,
        frame_left: 0,
        frame_top: 0,
        grid_left: left,
        grid_top: top,
        grid_width: width as u32,
        grid_height: height as u32,
        step: 2,
        reach: 0,
        patch: 0,
        has_previous: 1,
        tile: TILE.raw() as u32,
        penalty: 0.0,
        pad1: 0,
        pad2: 0,
    };
    let mut regular = dispatch(
        gpu,
        &mut recording,
        "regularize",
        &params,
        &reference.planes[0].buffer,
        &frame_planes.planes[0].buffer,
        &previous,
        &priors,
        width,
        height,
    );
    for _ in 0..width.max(height) {
        regular = dispatch(
            gpu,
            &mut recording,
            "fill",
            &params,
            &reference.planes[0].buffer,
            &frame_planes.planes[0].buffer,
            &regular,
            &priors,
            width,
            height,
        );
    }
    recording.submit();
    Field {
        buffer: regular,
        left,
        top,
        width,
        height,
    }
}

#[track_caller]
fn dispatch(
    gpu: &'static Gpu,
    recording: &mut gpu::Recording<'static>,
    entry: &'static str,
    params: &AlignParams,
    reference: &Buffer,
    frame: &Buffer,
    previous: &Buffer,
    priors: &Buffer,
    width: usize,
    height: usize,
) -> Buffer {
    let output = gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some("align field"),
        size: (width * height * 16) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let kernel = align_kernel(gpu, entry);
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("align params"),
        contents: bytemuck::bytes_of(params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    for buffer in [reference, frame, previous, priors, &output] {
        recording.holding(buffer);
    }
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("align"),
        layout: &kernel.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: reference.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: frame.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: previous.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: output.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: priors.as_entire_binding(),
            },
        ],
    });
    let (across, down) = match entry {
        "refine" => (width as u32, height as u32),
        _ => ((width as u32).div_ceil(8), (height as u32).div_ceil(8)),
    };
    recording.dispatch([across, down, 1], Whole::Measured, |pass| {
        pass.set_pipeline(&kernel.pipeline);
        pass.set_bind_group(0, &group, &[]);
    });
    output
}
