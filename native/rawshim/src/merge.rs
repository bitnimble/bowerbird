//! One merge for every stack of frames onto the same place (`slang/merge.slang`).
//!
//! Each frame's photosites are splatted onto an output grid through kernels the reference's
//! structure shapes, weighted by how far the frame agrees with the reference. The grid is the
//! reference's photosites or a finer one, the same arithmetic either way.

use crate::align::{Exposure, Field};
use crate::condition::Mosaic;
use crate::galosh::NoiseModel;
use crate::gpu::{Buffer, Gpu, Recording};
use crate::hdr_fit::Kernel;
use crate::px::{At, Sensor};

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    width: u32,
    height: u32,
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
    tile: u32,
    scale: u32,
    output_width: u32,
    output_height: u32,
    output_left: i32,
    output_top: i32,
    colours: [u32; 4],
    gain: f32,
    ceilings: [f32; 4],
    alpha: f32,
    sigma_sq: f32,
    reference_alpha: f32,
    reference_sigma_sq: f32,
    is_reference: u32,
    frames: u32,
    window_left: i32,
    window_top: i32,
    window_width: u32,
    window_height: u32,
    sharpness_power: f32,
    sharpest: f32,
    robust_reach: i32,
    reference_ceilings: [f32; 4],
    averages: u32,
    pad: [u32; 3],
}

/// How a stack's frames are weighed against the reference.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Weights {
    /// What the high band raises a frame's detail over the reference's to.
    pub sharpness_power: f32,
    /// The most a frame sharper than the reference counts for, before the power.
    pub sharpest: f32,
    /// Half-resolution periods either side a frame's light is compared over.
    pub robust_reach: i32,
    /// Whether every frame lands samples at a place. A stack whose places each take one frame
    /// averages nothing, so its frames are read through the reader's denoise, and its kernels are
    /// as wide as one frame's samples need.
    pub averages: bool,
}

impl Weights {
    /// Frames of one moment, any of them blurred by the hand. Fourier burst accumulation's p of 11
    /// assumes exact spectra; a ratio of local Laplacian energies is noisy enough that past 2 it
    /// discards sharp frames' samples along with the blurred ones'.
    pub const MOMENT: Weights = Weights {
        sharpness_power: 2.0,
        sharpest: 2.0,
        robust_reach: 1,
        averages: true,
    };

    /// Frames focused at different distances: each place takes the frame in focus there, and a
    /// defocused edge moves a period's light as much as a subject moving would, so the comparison
    /// is over a window wide enough that it averages out.
    pub const FOCUS: Weights = Weights {
        sharpness_power: 8.0,
        sharpest: 4.0,
        robust_reach: 3,
        averages: false,
    };
}

/// What a one-photosite merge holds for each pixel of its region, beside the strip itself: the
/// kernels, both halved planes, the reference's detail, robustness and sharpness and their erosion,
/// three accumulators, the four planes the bands settle through, the reference's demosaic under
/// them, the merged mosaic, and two alignment pyramids.
pub const WORKING_BYTES_PER_PIXEL: f64 = 4.0
    * (3.0
        + 0.75
        + 0.75
        + 0.5
        + 0.5
        + 0.75
        + 27.0
        + 12.0
        + 3.0
        + 1.0
        + 2.0 * (1.0 + 0.25 + 0.0625 + 0.015625));

#[cfg(test)]
pub(crate) fn block() -> usize {
    std::mem::size_of::<Params>()
}

/// The output grid: where it starts among the reference's photosites, how many pixels it has, and
/// how many it puts across each photosite.
#[derive(Clone, Copy)]
pub struct Grid {
    pub left: usize,
    pub top: usize,
    pub width: usize,
    pub height: usize,
    pub scale: usize,
}

/// One frame as the merge reads it.
pub struct Frame<'a> {
    pub mosaic: &'a Mosaic,
    pub cfa: &'a crate::cfa::Cfa,
    pub origin: At<Sensor>,
    pub exposure: Exposure,
    pub noise: NoiseModel,
}

pub struct Merge {
    origin: At<Sensor>,
    width: usize,
    height: usize,
    grid: Grid,
    frames: usize,
    weighed: Weights,
    noise: NoiseModel,
    colours: [u32; 4],
    ceilings: [f32; 4],
    kernels: Buffer,
    reference_half: Buffer,
    reference_detail: Buffer,
    robustness: Buffer,
    eroded: Buffer,
    prior: Buffer,
    sums: Buffer,
    wide_sums: Buffer,
    clipped_light: Buffer,
}

#[derive(Clone, Copy)]
enum Entry {
    Shape,
    Halve,
    ReferenceDetails,
    Robust,
    Erode,
    Accumulate,
    Settle,
    BlurRows,
    Combine,
    Paste,
    Remosaic,
}

fn kernel(gpu: &'static Gpu, entry: Entry) -> &'static Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    static BUILT: [std::sync::OnceLock<Kernel>; Entry::Remosaic as usize + 1] =
        [const { std::sync::OnceLock::new() }; Entry::Remosaic as usize + 1];
    let index = entry as usize;
    let (name, bindings): (&str, &[(u32, wgpu::BufferBindingType)]) = match entry {
        Entry::Shape => ("shape", &[(0, UNIFORM), (3, READ), (4, WRITE)]),
        Entry::Halve => ("halve", &[(0, UNIFORM), (1, READ), (12, WRITE)]),
        Entry::ReferenceDetails => (
            "reference_details",
            &[(0, UNIFORM), (5, READ), (6, READ), (14, WRITE)],
        ),
        Entry::Robust => (
            "robust",
            &[
                (0, UNIFORM),
                (2, READ),
                (5, READ),
                (6, READ),
                (7, WRITE),
                (14, WRITE),
            ],
        ),
        Entry::Erode => ("erode", &[(0, UNIFORM), (7, WRITE), (9, WRITE)]),
        Entry::Accumulate => (
            "accumulate",
            &[
                (0, UNIFORM),
                (1, READ),
                (2, READ),
                (4, WRITE),
                (6, READ),
                (8, WRITE),
                (9, WRITE),
                (13, WRITE),
                (18, READ),
                (19, WRITE),
            ],
        ),
        Entry::Settle => (
            "settle",
            &[
                (0, UNIFORM),
                (8, WRITE),
                (11, WRITE),
                (13, WRITE),
                (15, WRITE),
            ],
        ),
        Entry::BlurRows => ("blur_rows", &[(0, UNIFORM), (11, WRITE), (16, WRITE)]),
        Entry::Combine => (
            "combine",
            &[
                (0, UNIFORM),
                (11, WRITE),
                (15, WRITE),
                (16, WRITE),
                (17, WRITE),
                (18, READ),
                (19, WRITE),
            ],
        ),
        Entry::Paste => ("paste", &[(0, UNIFORM), (10, WRITE), (11, WRITE)]),
        Entry::Remosaic => (
            "remosaic",
            &[(0, UNIFORM), (11, WRITE), (18, READ), (20, WRITE)],
        ),
    };
    BUILT[index].get_or_init(|| {
        crate::hdr_fit::kernel(
            gpu,
            name,
            include_str!(concat!(env!("OUT_DIR"), "/wgsl/merge.wgsl")),
            bindings,
            &[],
        )
    })
}

fn storage(gpu: &Gpu, label: &'static str, floats: usize) -> Buffer {
    gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: (floats.max(1) * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    })
}

fn dispatch(
    gpu: &'static Gpu,
    entry: Entry,
    params: &Params,
    buffers: &[(u32, &Buffer)],
    across: usize,
    down: usize,
) {
    let mut recording = gpu.record();
    record(gpu, &mut recording, entry, params, buffers, across, down);
    recording.submit();
}

fn record(
    gpu: &'static Gpu,
    recording: &mut Recording<'static>,
    entry: Entry,
    params: &Params,
    buffers: &[(u32, &Buffer)],
    across: usize,
    down: usize,
) {
    let kernel = kernel(gpu, entry);
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("merge params"),
        contents: bytemuck::bytes_of(params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let mut entries = vec![wgpu::BindGroupEntry {
        binding: 0,
        resource: uniform.as_entire_binding(),
    }];
    for (binding, buffer) in buffers {
        recording.holding(buffer);
        entries.push(wgpu::BindGroupEntry {
            binding: *binding,
            resource: buffer.as_entire_binding(),
        });
    }
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("merge"),
        layout: &kernel.layout,
        entries: &entries,
    });
    let mut pass = recording.encoder().begin_compute_pass(&Default::default());
    pass.set_pipeline(&kernel.pipeline);
    pass.set_bind_group(0, &group, &[]);
    pass.dispatch_workgroups((across as u32).div_ceil(8), (down as u32).div_ceil(8), 1);
}

fn colours_of(cfa: &crate::cfa::Cfa) -> [u32; 4] {
    [
        u32::from(cfa.colour_at(0, 0)),
        u32::from(cfa.colour_at(0, 1)),
        u32::from(cfa.colour_at(1, 0)),
        u32::from(cfa.colour_at(1, 1)),
    ]
}

impl Merge {
    /// The merge with only `reference` in it, of the `frames` it will hold. `luma` is the
    /// reference's alignment pyramid's site luma.
    pub fn new(
        gpu: &'static Gpu,
        rcd: &crate::demosaic::Rcd,
        reference: Frame,
        luma: &Buffer,
        grid: Grid,
        frames: usize,
        weighed: Weights,
    ) -> Option<Merge> {
        if !reference.cfa.is_bayer() {
            return None;
        }
        let prior = crate::demosaic::demosaic_resident(gpu, rcd, reference.mosaic, reference.cfa)?;
        let (width, height) = (reference.mosaic.width, reference.mosaic.height);
        let (half_width, half_height) = (width / 2, height / 2);
        let values = grid.width * grid.height * 3;
        let merge = Merge {
            origin: reference.origin,
            width,
            height,
            grid,
            frames,
            weighed,
            noise: reference.noise,
            colours: colours_of(reference.cfa),
            ceilings: reference.exposure.ceilings,
            kernels: storage(gpu, "merge kernels", width * height * 3),
            reference_half: storage(gpu, "merge reference half", half_width * half_height * 3),
            reference_detail: storage(gpu, "merge reference detail", half_width * half_height * 2),
            robustness: storage(gpu, "merge robustness", half_width * half_height * 2),
            eroded: storage(gpu, "merge eroded robustness", half_width * half_height * 3),
            prior,
            sums: storage(gpu, "merge sums", values * 4),
            wide_sums: storage(gpu, "merge wide sums", values * 4),
            clipped_light: storage(gpu, "merge clipped light", values),
        };
        let params = merge.params(&reference, None);
        dispatch(
            gpu,
            Entry::Shape,
            &params,
            &[(3, luma), (4, &merge.kernels)],
            width,
            height,
        );
        dispatch(
            gpu,
            Entry::Halve,
            &params,
            &[(1, &reference.mosaic.buffer), (12, &merge.reference_half)],
            half_width,
            half_height,
        );
        dispatch(
            gpu,
            Entry::ReferenceDetails,
            &params,
            &[
                (5, &merge.reference_half),
                (6, &merge.reference_half),
                (14, &merge.reference_detail),
            ],
            half_width,
            half_height,
        );
        merge.accumulate(gpu, &reference, None)?;
        Some(merge)
    }

    /// Gathers `frame` in where `field` places it.
    pub fn add(&self, gpu: &'static Gpu, frame: Frame, field: &Field) -> Option<()> {
        self.accumulate(gpu, &frame, Some(field))
    }

    /// The merged picture, three values a pixel of the grid, in the reference's light.
    pub fn settle(&self, gpu: &'static Gpu) -> Buffer {
        let values = self.grid.width * self.grid.height * 3;
        let merged = storage(gpu, "merged", values);
        let low = storage(gpu, "merged low band", values);
        let blurred = storage(gpu, "merged high band's blur", values);
        let banded = storage(gpu, "merged bands", values);
        let params = self.blank();
        let (across, down) = (self.grid.width, self.grid.height);
        let mut recording = gpu.record();
        record(
            gpu,
            &mut recording,
            Entry::Settle,
            &params,
            &[
                (8, &self.sums),
                (11, &merged),
                (13, &self.wide_sums),
                (15, &low),
            ],
            across,
            down,
        );
        record(
            gpu,
            &mut recording,
            Entry::BlurRows,
            &params,
            &[(11, &merged), (16, &blurred)],
            across,
            down,
        );
        record(
            gpu,
            &mut recording,
            Entry::Combine,
            &params,
            &[
                (11, &merged),
                (15, &low),
                (16, &blurred),
                (17, &banded),
                (18, &self.prior),
                (19, &self.clipped_light),
            ],
            across,
            down,
        );
        recording.submit();
        banded
    }

    /// Writes `merged`, what [`Merge::settle`] handed back, over `rgb`, a demosaic of `window` of
    /// [`Merge::remosaic`]'s mosaic.
    pub fn paste(
        &self,
        gpu: &'static Gpu,
        recording: &mut Recording<'static>,
        merged: &Buffer,
        rgb: &Buffer,
        window: (usize, usize, usize, usize),
    ) {
        let (left, top, width, height) = window;
        let params = Params {
            window_left: left as i32 - (self.grid.left * self.grid.scale) as i32,
            window_top: top as i32 - (self.grid.top * self.grid.scale) as i32,
            window_width: width as u32,
            window_height: height as u32,
            ..self.blank()
        };
        record(
            gpu,
            recording,
            Entry::Paste,
            &params,
            &[(10, rgb), (11, merged)],
            width,
            height,
        );
    }

    fn accumulate(&self, gpu: &'static Gpu, frame: &Frame, field: Option<&Field>) -> Option<()> {
        if !frame.cfa.is_bayer() {
            return None;
        }
        let params = self.params(frame, field);
        let stub = storage(gpu, "merge reference field", 4);
        let (field, frame_half) = match field {
            None => (&stub, None),
            Some(field) => {
                let (half_width, half_height) = (frame.mosaic.width / 2, frame.mosaic.height / 2);
                let half = storage(gpu, "merge frame half", half_width * half_height * 3);
                dispatch(
                    gpu,
                    Entry::Halve,
                    &params,
                    &[(1, &frame.mosaic.buffer), (12, &half)],
                    half_width,
                    half_height,
                );
                (&field.buffer, Some(half))
            }
        };
        let frame_half = frame_half.as_ref().unwrap_or(&self.reference_half);
        let mut recording = gpu.record();
        record(
            gpu,
            &mut recording,
            Entry::Robust,
            &params,
            &[
                (2, field),
                (5, &self.reference_half),
                (6, frame_half),
                (7, &self.robustness),
                (14, &self.reference_detail),
            ],
            self.width / 2,
            self.height / 2,
        );
        record(
            gpu,
            &mut recording,
            Entry::Erode,
            &params,
            &[(7, &self.robustness), (9, &self.eroded)],
            self.width / 2,
            self.height / 2,
        );
        record(
            gpu,
            &mut recording,
            Entry::Accumulate,
            &params,
            &[
                (1, &frame.mosaic.buffer),
                (2, field),
                (4, &self.kernels),
                (6, frame_half),
                (8, &self.sums),
                (9, &self.eroded),
                (13, &self.wide_sums),
                (18, &self.prior),
                (19, &self.clipped_light),
            ],
            self.grid.width,
            self.grid.height,
        );
        recording.submit();
        Some(())
    }

    /// `merged`, what [`Merge::settle`] handed back, as a mosaic over the reference's whole region at
    /// the grid's scale, in the reference's pattern: the merge where it reached, and the reference's
    /// demosaic around it.
    pub fn remosaic(&self, gpu: &'static Gpu, merged: &Buffer) -> Mosaic {
        let (width, height) = (self.width * self.grid.scale, self.height * self.grid.scale);
        let remosaiced = storage(gpu, "merged mosaic", width * height);
        dispatch(
            gpu,
            Entry::Remosaic,
            &self.blank(),
            &[(11, merged), (18, &self.prior), (20, &remosaiced)],
            width,
            height,
        );
        Mosaic {
            buffer: remosaiced,
            width,
            height,
        }
    }

    fn blank(&self) -> Params {
        let (reference_left, reference_top) = self.origin.raw();
        Params {
            width: self.width as u32,
            height: self.height as u32,
            frame_width: self.width as u32,
            frame_height: self.height as u32,
            reference_left: reference_left as i32,
            reference_top: reference_top as i32,
            frame_left: reference_left as i32,
            frame_top: reference_top as i32,
            grid_left: 0,
            grid_top: 0,
            grid_width: 1,
            grid_height: 1,
            tile: crate::align::TILE.raw() as u32,
            scale: self.grid.scale as u32,
            output_width: self.grid.width as u32,
            output_height: self.grid.height as u32,
            output_left: self.grid.left as i32,
            output_top: self.grid.top as i32,
            colours: self.colours,
            gain: 1.0,
            ceilings: self.ceilings,
            alpha: self.noise.alpha,
            sigma_sq: self.noise.sigma_sq,
            reference_alpha: self.noise.alpha,
            reference_sigma_sq: self.noise.sigma_sq,
            is_reference: 1,
            frames: match self.weighed.averages {
                true => self.frames as u32,
                false => 1,
            },
            window_left: 0,
            window_top: 0,
            window_width: 0,
            window_height: 0,
            sharpness_power: self.weighed.sharpness_power,
            sharpest: self.weighed.sharpest,
            robust_reach: self.weighed.robust_reach,
            reference_ceilings: self.ceilings,
            averages: u32::from(self.weighed.averages),
            pad: [0; 3],
        }
    }

    fn params(&self, frame: &Frame, field: Option<&Field>) -> Params {
        let (frame_left, frame_top) = frame.origin.raw();
        Params {
            frame_width: frame.mosaic.width as u32,
            frame_height: frame.mosaic.height as u32,
            frame_left: frame_left as i32,
            frame_top: frame_top as i32,
            grid_left: field.map_or(0, |field| field.left),
            grid_top: field.map_or(0, |field| field.top),
            grid_width: field.map_or(1, |field| field.width as u32),
            grid_height: field.map_or(1, |field| field.height as u32),
            colours: colours_of(frame.cfa),
            gain: frame.exposure.gain,
            ceilings: frame.exposure.ceilings,
            alpha: frame.noise.alpha,
            sigma_sq: frame.noise.sigma_sq,
            is_reference: u32::from(field.is_none()),
            ..self.blank()
        }
    }
}
