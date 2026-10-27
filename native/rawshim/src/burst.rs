//! Where a burst's frames should sit against the reference: the recipe's placement of each,
//! projected through its lens, less any shift the camera made on purpose, as the prior the aligner
//! searches from.

use crate::px::{Extent, Sensor};

/// A stack of frames merged on the mosaic: how they were taken, and how they are weighed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stack {
    pub taken: Taken,
    pub weights: crate::merge::Weights,
}

/// How a burst's frames were taken, which says where each one's photosites should sit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Taken {
    /// On a tripod, the sensor moved a photosite between frames ([`SHIFTS`]).
    SensorShift,
    /// Wherever the recipe placed each frame, nothing moved on purpose.
    Placed,
}

impl Taken {
    /// Whether `frames` is a burst taken this way.
    pub fn holds(self, frames: usize) -> bool {
        match self {
            Taken::SensorShift => frames == SHIFTS.len(),
            Taken::Placed => frames >= 2,
        }
    }

    fn shift(self, index: usize) -> Option<Offset> {
        match self {
            Taken::SensorShift => SHIFTS.get(index).copied(),
            Taken::Placed => Some(Offset::exactly(0.0, 0.0)),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Offset {
    pub x: Extent<Sensor>,
    pub y: Extent<Sensor>,
}

impl Offset {
    pub const fn exactly(x: f64, y: f64) -> Offset {
        Offset {
            x: Extent::exactly(x),
            y: Extent::exactly(y),
        }
    }
}

pub const SHIFTS: [Offset; 4] = [
    Offset::exactly(0.0, 0.0),
    Offset::exactly(0.0, 1.0),
    Offset::exactly(-1.0, 1.0),
    Offset::exactly(-1.0, 0.0),
];

pub fn prior(
    recipe: &crate::composition::Composition,
    window: crate::px::Rect<crate::px::Photograph>,
    taken: Taken,
) -> Option<Vec<Offset>> {
    let reference = recipe.sources.get(recipe.reference)?;
    if !taken.holds(recipe.sources.len()) {
        return None;
    }
    let window = window.raw();
    let raw_x = (window.0 as f64 + window.2 as f64 * 0.5).min(reference.size[0] as f64 - 1.0);
    let raw_y = (window.1 as f64 + window.3 as f64 * 0.5).min(reference.size[1] as f64 - 1.0);
    (0..recipe.sources.len())
        .map(|index| prior_at(recipe, index, [raw_x, raw_y], taken))
        .collect()
}

pub fn prior_at(
    recipe: &crate::composition::Composition,
    index: usize,
    at: [f64; 2],
    taken: Taken,
) -> Option<Offset> {
    let reference = recipe.sources.get(recipe.reference)?;
    let source = recipe.sources.get(index)?;
    let (shift, from) = (taken.shift(index)?, taken.shift(recipe.reference)?);
    let shift = Offset::exactly(shift.x.raw() - from.x.raw(), shift.y.raw() - from.y.raw());
    let corrected = crate::composition::sensor_to_corrected(reference, at)?;
    let ray = crate::composition::source_to_ray(reference, corrected[0], corrected[1]);
    let corrected = crate::composition::ray_to_source(source, ray)?;
    let source_at = crate::composition::corrected_to_sensor(source, corrected)?;
    Some(Offset {
        x: Extent::measured(source_at[0] - at[0] - shift.x.raw()),
        y: Extent::measured(source_at[1] - at[1] - shift.y.raw()),
    })
}

#[cfg(test)]
mod tests {
    use super::{Offset, SHIFTS};
    use crate::align::{self, Exposure, Search};
    use crate::px::{At, Rect};

    #[test]
    fn prior_maps_each_lens_back_to_sensor_coordinates() {
        let mut recipe = crate::composition::Composition::of_one(
            [1000, 800],
            crate::composition::LensSpec {
                distortion: None,
                crop: 0.8,
                falloff: None,
                tca: None,
                axis: [0.0; 2],
            },
        );
        recipe.sources = vec![recipe.sources[0].clone(); 4];
        recipe.sources[1].lens = crate::composition::LensSpec::none();
        recipe.sources[2].lens.crop = 0.6;
        let window = Rect::exact(780, 600, 2, 2);
        let offsets = super::prior(&recipe, window, super::Taken::SensorShift).unwrap();
        assert!((offsets[1].x.raw() - 70.25).abs() < 1e-6);
        assert!((offsets[1].y.raw() - 49.25).abs() < 1e-6);
        assert!((offsets[2].x.raw() + 69.25).abs() < 1e-6);
        assert!((offsets[2].y.raw() + 51.25).abs() < 1e-6);

        let distortion = vec![
            0.0,
            -0.02 * crate::image::SPLINE_UNIT,
            -0.04 * crate::image::SPLINE_UNIT,
        ];
        for source in &mut recipe.sources {
            source.lens.distortion = Some(distortion.clone());
            source.lens.crop = 0.9;
        }
        let offsets = super::prior(&recipe, window, super::Taken::SensorShift).unwrap();
        for (offset, shift) in offsets.iter().zip(SHIFTS) {
            assert!((offset.x.raw() + shift.x.raw()).abs() < 1e-5);
            assert!((offset.y.raw() + shift.y.raw()).abs() < 1e-5);
        }
    }

    fn scene(x: f32, y: f32, channel: usize) -> f32 {
        0.25 + 0.07 * (x * 0.091).sin()
            + 0.06 * (y * 0.073).cos()
            + 0.05 * ((x + y) * 0.047).sin()
            + 0.03 * (x * 0.14 - y * 0.12).cos()
            + 0.07 * (x * 0.71).sin() * (y * 0.63).cos()
            + channel as f32 * 0.02
    }

    fn mosaic(
        gpu: &'static crate::gpu::Gpu,
        cfa: &crate::cfa::Cfa,
        width: usize,
        height: usize,
        displacement: [f32; 2],
    ) -> crate::condition::Mosaic {
        let samples: Vec<f32> = (0..height)
            .flat_map(|y| {
                (0..width).map(move |x| {
                    scene(
                        x as f32 - displacement[0],
                        y as f32 - displacement[1],
                        usize::from(cfa.colour_at(y, x)),
                    )
                })
            })
            .collect();
        crate::condition::Mosaic::upload(gpu, &samples, width, height)
    }

    fn floats(
        gpu: &'static crate::gpu::Gpu,
        buffer: &crate::gpu::Buffer,
        count: usize,
    ) -> Vec<f32> {
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
        pollster::block_on(crate::gpu::read_back(gpu, &readback, |mapped| {
            bytemuck::cast_slice::<u8, f32>(mapped).to_vec()
        }))
        .unwrap()
    }

    #[test]
    fn alignment_recovers_fractional_translation_from_imperfect_prior() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        let (width, height) = (768, 640);
        let reference = mosaic(gpu, &cfa, width, height, [0.0, 0.0]);
        let translated = mosaic(gpu, &cfa, width, height, [3.4, -12.7]);
        let pyramid = align::Pyramid::of(gpu, &reference, Exposure::UNCLIPPED);
        let field = align::measure(
            gpu,
            &pyramid,
            &translated,
            Exposure::UNCLIPPED,
            At::ORIGIN,
            At::ORIGIN,
            Rect::exact(256, 192, 256, 256),
            |_, _| Offset::exactly(5.0, -10.0),
            Search::AROUND_PRIOR,
        );
        let values = floats(gpu, &field.buffer, field.width * field.height * 4);
        let at = (field.width + 1) * 4;
        assert!((values[at] - 3.4).abs() < 0.1, "x: {}", values[at]);
        assert!((values[at + 1] + 12.7).abs() < 0.1, "y: {}", values[at + 1]);
        let neighbour = align::measure(
            gpu,
            &pyramid,
            &translated,
            Exposure::UNCLIPPED,
            At::ORIGIN,
            At::ORIGIN,
            Rect::exact(384, 192, 256, 256),
            |_, _| Offset::exactly(5.0, -10.0),
            Search::AROUND_PRIOR,
        );
        let adjacent = floats(
            gpu,
            &neighbour.buffer,
            neighbour.width * neighbour.height * 4,
        );
        let tile = align::TILE.raw() as i32;
        let shared = (neighbour.left + tile - field.left) / tile;
        let ours = (field.width + shared as usize) * 4;
        let theirs = (neighbour.width + 1) * 4;
        assert_eq!(&values[ours..ours + 2], &adjacent[theirs..theirs + 2]);
    }

    #[test]
    fn alignment_recovers_integer_shift_from_imperfect_prior() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        let (width, height) = (768, 640);
        let reference = mosaic(gpu, &cfa, width, height, [0.0, 0.0]);
        let one_site = mosaic(gpu, &cfa, width, height, [0.0, -1.0]);
        let pyramid = align::Pyramid::of(gpu, &reference, Exposure::UNCLIPPED);
        let tripod = align::measure(
            gpu,
            &pyramid,
            &one_site,
            Exposure::UNCLIPPED,
            At::ORIGIN,
            At::ORIGIN,
            Rect::exact(256, 192, 256, 256),
            |_, _| Offset::exactly(1.0, 1.0),
            Search::AROUND_PRIOR,
        );
        let exact = floats(gpu, &tripod.buffer, tripod.width * tripod.height * 4);
        let at = (tripod.width + 1) * 4;
        assert!(
            exact[at].abs() < 0.1 && (exact[at + 1] + 1.0).abs() < 0.1,
            "tripod offset: {}, {}",
            exact[at],
            exact[at + 1]
        );
    }

    #[test]
    fn flat_tiles_keep_their_sensor_anchored_priors() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let (width, height) = (768, 640);
        let samples = vec![0.25; width * height];
        let reference = crate::condition::Mosaic::upload(gpu, &samples, width, height);
        let frame = crate::condition::Mosaic::upload(gpu, &samples, width, height);
        let pyramid = align::Pyramid::of(gpu, &reference, Exposure::UNCLIPPED);
        let field = align::measure(
            gpu,
            &pyramid,
            &frame,
            Exposure::UNCLIPPED,
            At::ORIGIN,
            At::ORIGIN,
            Rect::exact(256, 192, 256, 256),
            |x, y| Offset::exactly(x / 128.0, y / 128.0),
            Search::AROUND_PRIOR,
        );
        let values = floats(gpu, &field.buffer, field.width * field.height * 4);
        let tile = align::TILE.raw() as f32;
        let x = field.left as f32 + tile * 1.5;
        let y = field.top as f32 + tile * 1.5;
        let centre = (field.width + 1) * 4;
        let beside = centre + 4;
        assert_eq!(&values[centre..centre + 2], &[x / 128.0, y / 128.0]);
        assert_eq!(
            &values[beside..beside + 2],
            &[(x + tile) / 128.0, y / 128.0]
        );
    }
}
