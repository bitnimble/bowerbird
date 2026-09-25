//! A burst's local displacement field, measured coarse to fine on 2x2-block luma on the GPU.
//!
//! Each block sees every Bayer filter once, so odd-photosite shifts remain comparable. The same
//! sensor-anchored tiles measure whole-site tripod offsets and fractional handheld offsets.

use crate::condition::Mosaic;
use crate::gpu::{Buffer, Gpu};
use crate::px::{Sensor, Span};

pub const TILE: Span<Sensor> = Span::exact(256);
pub const MARGIN: Span<Sensor> = Span::exact(320);
const SEARCH: [Span<Sensor>; 3] = [Span::exact(6), Span::exact(12), Span::exact(64)];
const PATCH: [Span<Sensor>; 3] = [Span::exact(10), Span::exact(12), Span::exact(24)];
const COARSE_STEP: Span<Sensor> = Span::exact(8);
pub const REFERENCE_MARGIN: Span<Sensor> = Span::exact(TILE.raw() + PATCH[2].raw() + COARSE_STEP.raw() / 2);

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct LumaParams {
    width: u32,
    height: u32,
    output_width: u32,
    output_height: u32,
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
    pad0: u32,
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

fn luma_kernel(gpu: &'static Gpu, entry: &'static str) -> &'static crate::hdr_fit::Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    static BLOCK: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    static REDUCE: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    let cell = if entry == "block_luma" { &BLOCK } else { &REDUCE };
    cell.get_or_init(|| crate::hdr_fit::kernel(
        gpu,
        entry,
        include_str!(concat!(env!("OUT_DIR"), "/wgsl/pixel_shift_luma.wgsl")),
        &[(0, UNIFORM), (1, READ), (2, WRITE)],
        &[],
    ))
}

fn align_kernel(gpu: &'static Gpu, entry: &'static str) -> &'static crate::hdr_fit::Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    static ALIGN: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    static REGULARIZE: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    let cell = if entry == "align" { &ALIGN } else { &REGULARIZE };
    cell.get_or_init(|| crate::hdr_fit::kernel(
        gpu,
        entry,
        include_str!(concat!(env!("OUT_DIR"), "/wgsl/pixel_shift_align.wgsl")),
        &[(0, UNIFORM), (1, READ), (2, READ), (3, READ), (4, WRITE), (5, READ)],
        &[],
    ))
}

struct Plane {
    buffer: Buffer,
    width: usize,
    height: usize,
    step: usize,
}

fn plane(
    gpu: &'static Gpu,
    recording: &mut crate::gpu::Recording<'static>,
    source: &Buffer,
    width: usize,
    height: usize,
    step: usize,
    entry: &'static str,
) -> Plane {
    let output_width = width.div_ceil(2);
    let output_height = height.div_ceil(2);
    let output = gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some("pixel shift luma"),
        size: (output_width * output_height * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    let params = LumaParams {
        width: width as u32,
        height: height as u32,
        output_width: output_width as u32,
        output_height: output_height as u32,
    };
    let kernel = luma_kernel(gpu, entry);
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pixel shift luma params"),
        contents: bytemuck::bytes_of(&params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    recording.holding(source);
    recording.holding(&output);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("pixel shift luma"),
        layout: &kernel.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: source.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: output.as_entire_binding() },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((output_width as u32).div_ceil(8), (output_height as u32).div_ceil(8), 1);
    }
    Plane { buffer: output, width: output_width, height: output_height, step }
}

pub struct Pyramid {
    planes: [Plane; 3],
}

impl Pyramid {
    pub fn of(gpu: &'static Gpu, mosaic: &Mosaic) -> Pyramid {
        let mut recording = gpu.record();
        let pyramid = Pyramid::record(gpu, &mut recording, mosaic);
        recording.submit();
        pyramid
    }

    fn record(gpu: &'static Gpu, recording: &mut crate::gpu::Recording<'static>, mosaic: &Mosaic) -> Pyramid {
        let base = plane(gpu, recording, &mosaic.buffer, mosaic.width, mosaic.height, 2, "block_luma");
        let middle = plane(gpu, recording, &base.buffer, base.width, base.height, 4, "reduce_luma");
        let coarse = plane(gpu, recording, &middle.buffer, middle.width, middle.height, COARSE_STEP.raw(), "reduce_luma");
        Pyramid { planes: [base, middle, coarse] }
    }
}

pub struct Field {
    pub buffer: Buffer,
    pub left: i32,
    pub top: i32,
    pub width: usize,
    pub height: usize,
}

pub fn measure(
    gpu: &'static Gpu,
    reference: &Pyramid,
    frame: &Mosaic,
    reference_origin: crate::px::At<Sensor>,
    frame_origin: crate::px::At<Sensor>,
    window: crate::px::Rect<Sensor>,
    prior_at: impl Fn(f64, f64) -> crate::pixel_shift::Offset,
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
        label: Some("pixel shift tile priors"),
        contents: bytemuck::cast_slice(&prior_values),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let mut recording = gpu.record();
    let frame_planes = Pyramid::record(gpu, &mut recording, frame);
    let stub = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("pixel shift empty field"),
        contents: &[0u8; 16],
        usage: wgpu::BufferUsages::STORAGE,
    });
    let mut previous = stub;
    for level in (0..3).rev() {
        let ours = &reference.planes[level];
        let theirs = &frame_planes.planes[level];
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
            reach: (SEARCH[level].raw() / ours.step) as i32,
            patch: (PATCH[level].raw() / ours.step) as i32,
            has_previous: u32::from(level != 2),
            tile: TILE.raw() as u32,
            pad0: 0,
            pad1: 0,
            pad2: 0,
        };
        previous = dispatch(gpu, &mut recording, "align", &params, &ours.buffer, &theirs.buffer, &previous, &priors, width, height);
    }
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
        pad0: 0,
        pad1: 0,
        pad2: 0,
    };
    let regular = dispatch(gpu, &mut recording, "regularize", &params, &reference.planes[0].buffer, &frame_planes.planes[0].buffer, &previous, &priors, width, height);
    recording.submit();
    Field { buffer: regular, left, top, width, height }
}

fn dispatch(
    gpu: &'static Gpu,
    recording: &mut crate::gpu::Recording<'static>,
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
        label: Some("pixel shift field"),
        size: (width * height * 16) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let kernel = align_kernel(gpu, entry);
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pixel shift align params"),
        contents: bytemuck::bytes_of(params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    for buffer in [reference, frame, previous, priors, &output] {
        recording.holding(buffer);
    }
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("pixel shift align"),
        layout: &kernel.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: reference.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: frame.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: previous.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: output.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: priors.as_entire_binding() },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((width as u32).div_ceil(8), (height as u32).div_ceil(8), 1);
    }
    output
}
