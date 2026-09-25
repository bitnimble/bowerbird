//! A burst gathered onto the reference's photosite lattice at its measured positions.
//!
//! Whole-photosite tripod offsets put each sample at one site; fractional handheld offsets
//! spread their weight between sites. One gather handles both, with reference RCD where evidence
//! is thin or the frames disagree.

use crate::pixel_shift_align::Field;
use crate::px::{Extent, Sensor};

#[derive(Clone, Copy, Debug)]
pub struct Offset {
    pub x: Extent<Sensor>,
    pub y: Extent<Sensor>,
}

impl Offset {
    pub const fn exactly(x: f64, y: f64) -> Offset {
        Offset { x: Extent::exactly(x), y: Extent::exactly(y) }
    }
}

pub const SHIFTS: [Offset; 4] = [
    Offset::exactly(0.0, 0.0),
    Offset::exactly(0.0, 1.0),
    Offset::exactly(-1.0, 1.0),
    Offset::exactly(-1.0, 0.0),
];

pub const SETTLE_REACH: crate::px::Span<Sensor> = crate::px::Span::exact(2);
pub const WORKING_BYTES_PER_PIXEL: f64 = 36.0 + 8.0 + 2.0 * (1.0 + 0.25 + 0.0625);

pub fn prior(
    recipe: &crate::composition::Composition,
    window: (usize, usize, usize, usize),
) -> Option<Vec<Offset>> {
    let reference = recipe.sources.first()?;
    if recipe.sources.len() != SHIFTS.len() {
        return None;
    }
    let raw_x = (window.0 as f64 + window.2 as f64 * 0.5).min(reference.size[0] as f64 - 1.0);
    let raw_y = (window.1 as f64 + window.3 as f64 * 0.5).min(reference.size[1] as f64 - 1.0);
    (0..recipe.sources.len()).map(|index| prior_at(recipe, index, [raw_x, raw_y])).collect()
}

pub fn prior_at(
    recipe: &crate::composition::Composition,
    index: usize,
    at: [f64; 2],
) -> Option<Offset> {
    let reference = recipe.sources.first()?;
    let source = recipe.sources.get(index)?;
    let shift = *SHIFTS.get(index)?;
    let corrected = crate::composition::sensor_to_corrected(reference, at)?;
    let ray = crate::composition::source_to_ray(reference, corrected[0], corrected[1]);
    let corrected = crate::composition::ray_to_source(source, ray)?;
    let source_at = crate::composition::corrected_to_sensor(source, corrected)?;
    Some(Offset {
        x: Extent::measured(source_at[0] - at[0] - shift.x.raw()),
        y: Extent::measured(source_at[1] - at[1] - shift.y.raw()),
    })
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GatherParams {
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
    is_reference: u32,
    colour0: u32,
    colour1: u32,
    colour2: u32,
    colour3: u32,
    tile: u32,
    pad1: u32,
    pad2: u32,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct SettleParams {
    width: u32,
    height: u32,
    left: u32,
    top: u32,
    region_width: u32,
    region_height: u32,
    alpha: f32,
    sigma_sq: f32,
    reach: u32,
    pad: [u32; 3],
}

#[cfg(test)]
pub(crate) fn gather_block() -> usize {
    std::mem::size_of::<GatherParams>()
}

#[cfg(test)]
pub(crate) fn settle_block() -> usize {
    std::mem::size_of::<SettleParams>()
}

fn gathering(gpu: &'static crate::gpu::Gpu) -> &'static crate::hdr_fit::Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| crate::hdr_fit::kernel(
        gpu,
        "gather",
        include_str!(concat!(env!("OUT_DIR"), "/wgsl/pixel_shift.wgsl")),
        &[(0, UNIFORM), (1, READ), (2, READ), (3, WRITE), (4, WRITE), (5, WRITE)],
        &[],
    ))
}

fn settling(gpu: &'static crate::gpu::Gpu) -> &'static crate::hdr_fit::Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| crate::hdr_fit::kernel(
        gpu,
        "settle",
        include_str!(concat!(env!("OUT_DIR"), "/wgsl/pixel_shift_settle.wgsl")),
        &[(0, UNIFORM), (1, READ), (2, READ), (3, READ), (4, WRITE)],
        &[],
    ))
}

pub struct Merged {
    sums: crate::gpu::Buffer,
    weights: crate::gpu::Buffer,
    greens: crate::gpu::Buffer,
    origin: crate::px::At<Sensor>,
    width: usize,
    height: usize,
}

impl Merged {
    pub fn over(gpu: &crate::gpu::Gpu, region: crate::px::Rect<Sensor>) -> Merged {
        let (width, height) = region.size.raw();
        let zeroed = |label| gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: &vec![0u8; width * height * 3 * 4],
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        });
        Merged {
            sums: zeroed("pixel shift sums"),
            weights: zeroed("pixel shift weights"),
            greens: zeroed("pixel shift greens"),
            origin: region.at,
            width,
            height,
        }
    }

    pub fn gather(
        &self,
        gpu: &'static crate::gpu::Gpu,
        mosaic: &crate::condition::Mosaic,
        cfa: &crate::cfa::Cfa,
        origin: crate::px::At<Sensor>,
        field: Option<&Field>,
    ) -> Option<()> {
        if !cfa.is_bayer() {
            return None;
        }
        let empty = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("pixel shift zero field"),
            contents: &[0u8; 16],
            usage: wgpu::BufferUsages::STORAGE,
        });
        let (buffer, grid_left, grid_top, grid_width, grid_height, is_reference) = match field {
            Some(field) => (&field.buffer, field.left, field.top, field.width, field.height, 0),
            None => (&empty, 0, 0, 1, 1, 1),
        };
        let params = GatherParams {
            width: self.width as u32,
            height: self.height as u32,
            frame_width: mosaic.width as u32,
            frame_height: mosaic.height as u32,
            reference_left: self.origin.x.raw() as i32,
            reference_top: self.origin.y.raw() as i32,
            frame_left: origin.x.raw() as i32,
            frame_top: origin.y.raw() as i32,
            grid_left,
            grid_top,
            grid_width: grid_width as u32,
            grid_height: grid_height as u32,
            is_reference,
            colour0: u32::from(cfa.colour_at(0, 0)),
            colour1: u32::from(cfa.colour_at(0, 1)),
            colour2: u32::from(cfa.colour_at(1, 0)),
            colour3: u32::from(cfa.colour_at(1, 1)),
            tile: crate::pixel_shift_align::TILE.raw() as u32,
            pad1: 0,
            pad2: 0,
        };
        let kernel = gathering(gpu);
        let mut recording = gpu.record();
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("pixel shift gather params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        for buffer in [&mosaic.buffer, buffer, &self.sums, &self.weights, &self.greens] {
            recording.holding(buffer);
        }
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pixel shift gather"),
            layout: &kernel.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: mosaic.buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: self.sums.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: self.weights.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: self.greens.as_entire_binding() },
            ],
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernel.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups((self.width as u32).div_ceil(8), (self.height as u32).div_ceil(8), 1);
        }
        recording.submit();
        Some(())
    }

    pub fn settle(
        &self,
        gpu: &'static crate::gpu::Gpu,
        recording: &mut crate::gpu::Recording<'static>,
        rgb: &crate::gpu::Buffer,
        window: (usize, usize, usize, usize),
        noise: Option<crate::galosh::NoiseModel>,
    ) {
        let (left, top, width, height) = window;
        let params = SettleParams {
            width: width as u32,
            height: height as u32,
            left: left as u32,
            top: top as u32,
            region_width: self.width as u32,
            region_height: self.height as u32,
            alpha: noise.map_or(0.0, |model| model.alpha),
            sigma_sq: noise.map_or(0.0, |model| model.sigma_sq),
            reach: SETTLE_REACH.raw() as u32,
            pad: [0; 3],
        };
        let kernel = settling(gpu);
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("pixel shift settle params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        for buffer in [&self.sums, &self.weights, &self.greens] {
            recording.holding(buffer);
        }
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pixel shift settle"),
            layout: &kernel.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.sums.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: self.weights.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: self.greens.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: rgb.as_entire_binding() },
            ],
        });
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((width as u32).div_ceil(8), (height as u32).div_ceil(8), 1);
    }
}

#[cfg(test)]
mod tests {
    use super::{Merged, Offset, SHIFTS};
    use crate::pixel_shift_align::{self, Field};
    use crate::px::{At, Rect};

    const W: usize = 64;
    const H: usize = 64;

    #[test]
    fn prior_maps_each_lens_back_to_sensor_coordinates() {
        let mut recipe = crate::composition::Composition::of_one(
            [1000, 800],
            crate::composition::LensSpec {
                distortion: None,
                crop: 0.8,
                falloff: None,
                tca: None,
            },
        );
        recipe.sources = vec![recipe.sources[0].clone(); 4];
        recipe.sources[1].lens = crate::composition::LensSpec::none();
        recipe.sources[2].lens.crop = 0.6;
        let offsets = super::prior(&recipe, (780, 600, 2, 2)).unwrap();
        assert!((offsets[1].x.raw() - 70.25).abs() < 1e-6);
        assert!((offsets[1].y.raw() - 49.25).abs() < 1e-6);
        assert!((offsets[2].x.raw() + 69.25).abs() < 1e-6);
        assert!((offsets[2].y.raw() + 51.25).abs() < 1e-6);

        let distortion = vec![0.0, -0.02 * crate::image::SPLINE_UNIT, -0.04 * crate::image::SPLINE_UNIT];
        for source in &mut recipe.sources {
            source.lens.distortion = Some(distortion.clone());
            source.lens.crop = 0.9;
        }
        let offsets = super::prior(&recipe, (780, 600, 2, 2)).unwrap();
        for (offset, shift) in offsets.iter().zip(SHIFTS) {
            assert!((offset.x.raw() + shift.x.raw()).abs() < 1e-5);
            assert!((offset.y.raw() + shift.y.raw()).abs() < 1e-5);
        }
    }

    fn scene(x: f32, y: f32, channel: usize) -> f32 {
        0.25 + 0.07 * (x * 0.091).sin() + 0.06 * (y * 0.073).cos()
            + 0.05 * ((x + y) * 0.047).sin() + 0.03 * (x * 0.14 - y * 0.12).cos()
            + 0.07 * (x * 0.71).sin() * (y * 0.63).cos()
            + channel as f32 * 0.02
    }

    fn mosaic(
        gpu: &'static crate::gpu::Gpu,
        cfa: &crate::cfa::Cfa,
        width: usize,
        height: usize,
        displacement: [f32; 2],
        moved: impl Fn(usize, usize) -> bool,
    ) -> crate::condition::Mosaic {
        let samples: Vec<f32> = (0..height).flat_map(|y| {
            let moved = &moved;
            (0..width).map(move |x| {
                if moved(x, y) { 0.9 } else {
                    scene(x as f32 - displacement[0], y as f32 - displacement[1], usize::from(cfa.colour_at(y, x)))
                }
            })
        }).collect();
        crate::condition::Mosaic::upload(gpu, &samples, width, height)
    }

    fn noisy_mosaic(
        gpu: &'static crate::gpu::Gpu,
        cfa: &crate::cfa::Cfa,
        width: usize,
        height: usize,
        displacement: [f32; 2],
        shot: u32,
    ) -> crate::condition::Mosaic {
        let samples: Vec<f32> = (0..height).flat_map(|y| (0..width).map(move |x| {
            let mut hash = (x as u32).wrapping_mul(0x9e3779b9)
                ^ (y as u32).wrapping_mul(0x85ebca6b) ^ shot.wrapping_mul(0xc2b2ae35);
            hash ^= hash >> 16;
            hash = hash.wrapping_mul(0x7feb352d);
            hash ^= hash >> 15;
            let noise = (hash as f32 / u32::MAX as f32 * 2.0 - 1.0) * 0.025;
            scene(x as f32 - displacement[0], y as f32 - displacement[1], usize::from(cfa.colour_at(y, x))) + noise
        })).collect();
        crate::condition::Mosaic::upload(gpu, &samples, width, height)
    }

    fn field(gpu: &'static crate::gpu::Gpu, displacement: [f32; 2]) -> Field {
        let values: Vec<f32> = (0..4).flat_map(|_| [displacement[0], displacement[1], 1.0, 1.0]).collect();
        Field {
            buffer: gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("known pixel shift field"),
                contents: bytemuck::cast_slice(&values),
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            }),
            left: -128,
            top: -128,
            width: 2,
            height: 2,
        }
    }

    fn floats(gpu: &'static crate::gpu::Gpu, buffer: &crate::gpu::Buffer, count: usize) -> Vec<f32> {
        let bytes = (count * 4) as u64;
        let mut recording = gpu.record();
        let readback = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("pixel shift readback"),
            size: bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        recording.encoder().copy_buffer_to_buffer(buffer, 0, &readback, 0, bytes);
        recording.submit();
        pollster::block_on(crate::gpu::read_back(gpu, &readback, |mapped| {
            bytemuck::cast_slice::<u8, f32>(mapped).to_vec()
        })).unwrap()
    }

    fn rcd(gpu: &'static crate::gpu::Gpu, values: &[f32]) -> crate::gpu::Buffer {
        gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("reference RCD"),
            contents: bytemuck::cast_slice(values),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        })
    }

    fn settle(gpu: &'static crate::gpu::Gpu, merged: &Merged, values: &[f32], width: usize, height: usize, noise: Option<crate::galosh::NoiseModel>) -> Vec<f32> {
        let output = rcd(gpu, values);
        let mut recording = gpu.record();
        merged.settle(gpu, &mut recording, &output, (0, 0, width, height), noise);
        recording.submit();
        floats(gpu, &output, width * height * 3)
    }

    #[test]
    fn integer_shift_reconstructs_all_channels() {
        let Some(gpu) = crate::gpu::device() else { return };
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        let merged = Merged::over(gpu, Rect::exact(8, 8, W - 16, H - 16));
        for (index, shift) in SHIFTS.into_iter().enumerate() {
            let displacement = [-shift.x.raw() as f32, -shift.y.raw() as f32];
            let samples = mosaic(gpu, &cfa, W, H, displacement, |_, _| false);
            let known = field(gpu, displacement);
            merged.gather(gpu, &samples, &cfa, At::ORIGIN, (index != 0).then_some(&known)).unwrap();
        }
        let (width, height) = (W - 16, H - 16);
        let output = settle(gpu, &merged, &vec![-1.0; width * height * 3], width, height, None);
        for y in 2..height - 2 {
            for x in 2..width - 2 {
                for channel in 0..3 {
                    let got = output[(y * width + x) * 3 + channel];
                    let want = scene((x + 8) as f32, (y + 8) as f32, channel);
                    assert!((got - want).abs() < 1e-5, "{x},{y} channel {channel}: {got} against {want}");
                }
            }
        }
    }

    #[test]
    fn moving_patch_uses_reference() {
        let Some(gpu) = crate::gpu::device() else { return };
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        let merged = Merged::over(gpu, Rect::exact(0, 0, W, H));
        for (index, shift) in SHIFTS.into_iter().enumerate() {
            let displacement = [-shift.x.raw() as f32, -shift.y.raw() as f32];
            let samples = mosaic(gpu, &cfa, W, H, displacement, |x, y| index >= 2 && (24..32).contains(&x) && (24..32).contains(&y));
            let known = field(gpu, displacement);
            merged.gather(gpu, &samples, &cfa, At::ORIGIN, (index != 0).then_some(&known)).unwrap();
        }
        let output = settle(gpu, &merged, &vec![-1.0; W * H * 3], W, H, None);
        assert_eq!(output[(28 * W + 28) * 3 + 1], -1.0);
        assert!((output[(48 * W + 48) * 3 + 1] - scene(48.0, 48.0, 1)).abs() < 1e-5);
    }

    #[test]
    fn missing_channel_coverage_uses_reference() {
        let Some(gpu) = crate::gpu::device() else { return };
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        let merged = Merged::over(gpu, Rect::exact(0, 0, W, H));
        let samples = mosaic(gpu, &cfa, W, H, [0.0, 0.0], |_, _| false);
        merged.gather(gpu, &samples, &cfa, At::ORIGIN, None).unwrap();
        let output = settle(gpu, &merged, &vec![-1.0; W * H * 3], W, H, None);
        assert_eq!(&output[(32 * W + 32) * 3..(32 * W + 32) * 3 + 3], &[-1.0; 3]);
    }

    #[test]
    fn alignment_recovers_fractional_translation_from_imperfect_prior() {
        let Some(gpu) = crate::gpu::device() else { return };
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        let (width, height) = (768, 640);
        let reference = mosaic(gpu, &cfa, width, height, [0.0, 0.0], |_, _| false);
        let translated = mosaic(gpu, &cfa, width, height, [3.4, -12.7], |_, _| false);
        let pyramid = pixel_shift_align::Pyramid::of(gpu, &reference);
        let field = pixel_shift_align::measure(gpu, &pyramid, &translated, At::ORIGIN, At::ORIGIN, Rect::exact(256, 192, 256, 256), |_, _| Offset::exactly(5.0, -10.0));
        let values = floats(gpu, &field.buffer, field.width * field.height * 4);
        let at = (1 * field.width + 1) * 4;
        assert!((values[at] - 3.4).abs() < 0.1, "x: {}", values[at]);
        assert!((values[at + 1] + 12.7).abs() < 0.1, "y: {}", values[at + 1]);
        let neighbour = pixel_shift_align::measure(gpu, &pyramid, &translated, At::ORIGIN, At::ORIGIN, Rect::exact(384, 192, 256, 256), |_, _| Offset::exactly(5.0, -10.0));
        let adjacent = floats(gpu, &neighbour.buffer, neighbour.width * neighbour.height * 4);
        let same_tile = neighbour.width * 4;
        assert_eq!(&values[at..at + 2], &adjacent[same_tile..same_tile + 2]);
    }

    #[test]
    fn alignment_recovers_integer_shift_from_imperfect_prior() {
        let Some(gpu) = crate::gpu::device() else { return };
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        let (width, height) = (768, 640);
        let reference = mosaic(gpu, &cfa, width, height, [0.0, 0.0], |_, _| false);
        let one_site = mosaic(gpu, &cfa, width, height, [0.0, -1.0], |_, _| false);
        let pyramid = pixel_shift_align::Pyramid::of(gpu, &reference);
        let tripod = pixel_shift_align::measure(gpu, &pyramid, &one_site, At::ORIGIN, At::ORIGIN, Rect::exact(256, 192, 256, 256), |_, _| Offset::exactly(1.0, 1.0));
        let exact = floats(gpu, &tripod.buffer, tripod.width * tripod.height * 4);
        let at = (tripod.width + 1) * 4;
        assert!(exact[at].abs() < 0.1 && (exact[at + 1] + 1.0).abs() < 0.1, "tripod offset: {}, {}", exact[at], exact[at + 1]);
    }

    #[test]
    fn flat_tiles_keep_their_sensor_anchored_priors() {
        let Some(gpu) = crate::gpu::device() else { return };
        let (width, height) = (768, 640);
        let samples = vec![0.25; width * height];
        let reference = crate::condition::Mosaic::upload(gpu, &samples, width, height);
        let frame = crate::condition::Mosaic::upload(gpu, &samples, width, height);
        let pyramid = pixel_shift_align::Pyramid::of(gpu, &reference);
        let field = pixel_shift_align::measure(
            gpu, &pyramid, &frame, At::ORIGIN, At::ORIGIN,
            Rect::exact(256, 192, 256, 256),
            |x, y| Offset::exactly(x / 128.0, y / 128.0),
        );
        let values = floats(gpu, &field.buffer, field.width * field.height * 4);
        let centre = (field.width + 1) * 4;
        let beside = centre + 4;
        assert_eq!(&values[centre..centre + 2], &[3.0, 3.0]);
        assert_eq!(&values[beside..beside + 2], &[5.0, 3.0]);
    }

    #[test]
    fn handheld_merge_improves_on_reference_rcd() {
        let Some(gpu) = crate::gpu::device() else { return };
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        let (width, height) = (768, 640);
        let offsets = [[0.0, 0.0], [10.4, -5.7], [17.4, -6.7], [18.4, -7.7]];
        let priors = [[0.0, 0.0], [8.0, -3.0], [14.0, -4.0], [15.0, -5.0]];
        let frames: Vec<_> = offsets.iter().enumerate().map(|(index, &offset)| noisy_mosaic(gpu, &cfa, width, height, offset, index as u32)).collect();
        let reference = pollster::block_on(crate::demosaic::demosaic_plane(
            gpu,
            crate::demosaic::device(gpu).unwrap(),
            &frames[0],
            &cfa,
            |bytes| bytemuck::cast_slice::<u8, f32>(bytes).to_vec(),
        )).unwrap();
        let merged = Merged::over(gpu, Rect::exact(0, 0, width, height));
        merged.gather(gpu, &frames[0], &cfa, At::ORIGIN, None).unwrap();
        let pyramid = pixel_shift_align::Pyramid::of(gpu, &frames[0]);
        for index in 1..frames.len() {
            let field = pixel_shift_align::measure(gpu, &pyramid, &frames[index], At::ORIGIN, At::ORIGIN, Rect::exact(256, 192, 256, 256), |_, _| Offset::exactly(priors[index][0] as f64, priors[index][1] as f64));
            let found = floats(gpu, &field.buffer, field.width * field.height * 4);
            let at = (field.width + 1) * 4;
            assert!((found[at] - offsets[index][0]).abs() < 0.5, "frame {index} x: {}", found[at]);
            assert!((found[at + 1] - offsets[index][1]).abs() < 0.5, "frame {index} y: {}", found[at + 1]);
            merged.gather(gpu, &frames[index], &cfa, At::ORIGIN, Some(&field)).unwrap();
        }
        let output = settle(gpu, &merged, &reference, width, height, Some(crate::galosh::NoiseModel { alpha: 0.0, sigma_sq: 0.025 * 0.025 / 3.0 }));
        let mut before = 0.0;
        let mut after = 0.0;
        let mut phase_before = [0.0; 4];
        let mut phase_after = [0.0; 4];
        for y in 288..416 {
            for x in 320..448 {
                let phase = (y % 2) * 2 + x % 2;
                for channel in 0..3 {
                    let at = (y * width + x) * 3 + channel;
                    let want = scene(x as f32, y as f32, channel);
                    let old_error = (reference[at] - want).abs();
                    let new_error = (output[at] - want).abs();
                    before += old_error;
                    after += new_error;
                    phase_before[phase] += old_error;
                    phase_after[phase] += new_error;
                }
            }
        }
        assert!(after < before, "handheld error {after} against RCD {before}");
        for phase in 0..4 {
            assert!(phase_after[phase] < phase_before[phase], "phase {phase}: {} against {}", phase_after[phase], phase_before[phase]);
        }
    }
}
