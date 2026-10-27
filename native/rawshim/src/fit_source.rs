//! What the camera match reads off the decoded frame, taken where the frame already is.
//!
//! Two reductions of a frame that is 360MB at 61MP: a box average down to the preview's own grid
//! - 1616 on the long edge - and the histogram of a million sampled pixels that `fit_scan` walks
//! for the three levels the grade is placed against. What crosses to the host is those three
//! levels; the plane and the render stay where they were written, and every reader binds them
//! there.

use crate::parallel::*;
use colour::resident::Resident;
use gpu::dispatch::Whole;

/// The three floats `fit_scan` writes, which is all of the histogram that crosses to the host.
const LEVEL_BYTES: u64 = 12;

/// Everything the fit needs off the frame, in one round trip.
pub struct Prepared {
    pub plane: crate::hdr_fit::Source,
    pub rendered: Rendered,
    pub levels: colour::tone::Levels,
}

/// The plane as the geometry search and the lateral aberration read it: sRGB in 0..1, one float a
/// component, where `fit_render` wrote it beside the plane.
pub struct Rendered {
    pub buffer: gpu::Buffer,
    pub width: usize,
    pub height: usize,
}

pub(crate) struct Kernels {
    layout: wgpu::BindGroupLayout,
    resize: wgpu::ComputePipeline,
    levels: wgpu::ComputePipeline,
    scan: wgpu::ComputePipeline,
    render: wgpu::ComputePipeline,
}

pub(crate) fn kernels(gpu: &'static gpu::Gpu) -> &'static Kernels {
    static BUILT: gpu::Cache<Kernels> = gpu::Cache::new();
    BUILT.get(gpu, || {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fit_source"),
            source: wgpu::ShaderSource::Wgsl(shaders::FIT_SOURCE.source.into()),
        });
        let entry = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let read = wgpu::BufferBindingType::Storage { read_only: true };
        let write = wgpu::BufferBindingType::Storage { read_only: false };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("fit_source"),
            entries: &[
                entry(0, read),
                entry(1, write),
                entry(2, write),
                entry(3, write),
                entry(4, write),
                entry(20, wgpu::BufferBindingType::Uniform),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fit_source"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let build = |name: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(name),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(name),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        Kernels {
            resize: build("fit_resize"),
            levels: build("fit_levels"),
            scan: build("fit_scan"),
            render: build("fit_render"),
            layout,
        }
    })
}

/// The shape the fit's plane reduces a frame to: about `wide` across, and never wider than the
/// frame it came from.
pub fn plane_size(width: usize, height: usize, wide: usize) -> (usize, usize) {
    let wide = width.min(wide).max(1);
    let tall = (((height as f64 / width as f64) * wide as f64).round() as usize).max(1);
    (wide, tall)
}

pub async fn prepared(
    gpu: &'static gpu::Gpu,
    frame: &Resident,
    wide: usize,
    quantile: f64,
) -> Option<Prepared> {
    let taken = run(gpu, frame, Some(wide), quantile).await?;
    Some(Prepared {
        plane: taken.plane?,
        rendered: taken.rendered?,
        levels: taken.levels,
    })
}

/// The quantile alone, for a caller that wants the anchor and no fit.
pub async fn levels(
    gpu: &'static gpu::Gpu,
    frame: &Resident,
    quantile: f64,
) -> Option<colour::tone::Levels> {
    Some(run(gpu, frame, None, quantile).await?.levels)
}

struct Taken {
    plane: Option<crate::hdr_fit::Source>,
    rendered: Option<Rendered>,
    levels: colour::tone::Levels,
}

async fn run(
    gpu: &'static gpu::Gpu,
    frame: &Resident,
    wide: Option<usize>,
    quantile: f64,
) -> Option<Taken> {
    let mut recording = gpu.record();
    recording.holding(frame.buffer());
    let (width, height) = frame.size();
    if width == 0 || height == 0 {
        return None;
    }
    // A single pixel where no plane was asked for, and the resize left undispatched below: a
    // buffer of nothing is not bindable, and one pixel is cheaper than a second pipeline layout
    // to leave the binding out of.
    let wanted = wide.is_some();
    let (wide, tall) = match wide {
        Some(wide) => plane_size(width, height, wide),
        None => (1, 1),
    };
    let pixels = width * height;
    let counted = pixels.min(colour::tone::QUANTILE_SAMPLES);

    let plane_bytes = (wide * tall * 3 * 4) as u64;
    let plane = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit plane"),
        size: plane_bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    // The geometry search binds this where it is; `Grids` holds it past this recording, which the
    // buffer being reference counted is what allows.
    let render = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit render"),
        size: plane_bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let histogram = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit histogram"),
        size: (colour::tone::LEVEL_BINS * 4) as u64,
        // Zeroed by the driver, which the counting relies on: every bin is added into rather
        // than written.
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    let levels = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit levels"),
        size: LEVEL_BYTES,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let mut staging = |label, size| {
        recording.buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    };
    let levels_out = staging("fit levels out", LEVEL_BYTES);

    let (floor_mark, white_mark, peak_mark) = colour::tone::marks(counted, quantile);
    let mut block = [
        width as i32,
        height as i32,
        wide as i32,
        tall as i32,
        counted as i32,
        pixels as i32,
        floor_mark as i32,
        white_mark as i32,
        peak_mark as i32,
    ]
    .iter()
    .flat_map(|v| v.to_ne_bytes())
    .chain((colour::tone::WHITE_FLOOR_UNDER_PEAK.raw() as f32).to_ne_bytes())
    .collect::<Vec<u8>>();
    // The matrix starts on a 16-byte boundary and each row occupies one, which is what `float4[3]`
    // is in std140 and why the rows are written with a pad word rather than nine floats running on.
    block.resize(48, 0);
    let to_srgb = colour::space::rec2020_to_srgb();
    for row in &to_srgb {
        block.extend(row.iter().flat_map(|v| (*v as f32).to_ne_bytes()));
        block.extend(0f32.to_ne_bytes());
    }
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit_source push"),
        contents: &block,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let built = kernels(gpu);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("fit_source"),
        layout: &built.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: frame.buffer().as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: plane.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: histogram.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: levels.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: render.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 20,
                resource: push.as_entire_binding(),
            },
        ],
    });

    let over_plane = [(wide as u32).div_ceil(16), (tall as u32).div_ceil(16), 1];
    if wanted {
        recording.dispatch(over_plane, Whole::Measured, |pass| {
            pass.set_bind_group(0, &group, &[]);
            pass.set_pipeline(&built.resize);
        });
    }
    recording.dispatch(
        [(counted as u32).div_ceil(64), 1, 1],
        Whole::Fixed,
        |pass| {
            pass.set_bind_group(0, &group, &[]);
            pass.set_pipeline(&built.levels);
        },
    );
    recording.dispatch([1, 1, 1], Whole::Fixed, |pass| {
        pass.set_bind_group(0, &group, &[]);
        pass.set_pipeline(&built.scan);
    });
    if wanted {
        recording.dispatch(over_plane, Whole::Fixed, |pass| {
            pass.set_bind_group(0, &group, &[]);
            pass.set_pipeline(&built.render);
        });
    }
    recording.copy_buffer_to_buffer(&levels, 0, &levels_out, 0, LEVEL_BYTES);
    recording.submit();

    let measured = gpu::read_back(gpu, &levels_out, |mapped| {
        let at = |i: usize| {
            f64::from(f32::from_ne_bytes([
                mapped[i],
                mapped[i + 1],
                mapped[i + 2],
                mapped[i + 3],
            ]))
        };
        // The one place a level enters the host now that `fit_scan` takes the quantile: what the
        // shader wrote, read back and named.
        colour::tone::Levels {
            white: units::light::Light::measured(at(0)),
            peak: units::light::Light::measured(at(4)),
            floor: Some(units::light::Light::measured(at(8))),
        }
    })
    .await;
    // The named locals as well as the recording, or its copies are not the last ones and the
    // planes stay up until the caller returns. `plane` and `render` are not among them: the
    // caller keeps both.
    drop((histogram, levels, levels_out, push, recording));

    let plane = match wanted {
        false => None,
        true => Some(crate::hdr_fit::Source {
            buffer: plane,
            width: wide,
            height: tall,
        }),
    };
    let rendered = match wanted {
        false => None,
        true => Some(Rendered {
            buffer: render,
            width: wide,
            height: tall,
        }),
    };
    Some(Taken {
        plane,
        rendered,
        levels: measured?,
    })
}

/// A resident plane on the host, which only a test wants: everything else reads the buffer.
#[cfg(test)]
async fn read_plane(
    gpu: &'static gpu::Gpu,
    plane: &crate::hdr_fit::Source,
) -> Option<crate::hdr_fit::Plane> {
    let bytes = (plane.width * plane.height * 3 * 4) as u64;
    let mut recording = gpu.record();
    let out = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit plane out"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    recording.copy_buffer_to_buffer(&plane.buffer, 0, &out, 0, bytes);
    recording.submit();
    let data = gpu::read_back(gpu, &out, |mapped| {
        mapped
            .par_chunks_exact(4)
            .map(|word| f64::from(f32::from_ne_bytes([word[0], word[1], word[2], word[3]])))
            .collect::<Vec<f64>>()
    })
    .await?;
    Some(crate::hdr_fit::Plane {
        width: plane.width,
        height: plane.height,
        data,
    })
}

/// A render assembled from codes, for the tests that measure one rather than produce one.
#[cfg(test)]
pub(crate) fn uploaded_render(gpu: &'static gpu::Gpu, image: units::rgb::RgbRef<'_>) -> Rendered {
    let words: Vec<u8> = image
        .data
        .iter()
        .flat_map(|code| (f32::from(*code) / 255.0).to_ne_bytes())
        .collect();
    Rendered {
        buffer: gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("fit render"),
            contents: &words,
            usage: wgpu::BufferUsages::STORAGE,
        }),
        width: image.width,
        height: image.height,
    }
}

/// The render as the codes it would quantise to. Nothing on the fit's path wants this - it is for
/// the pin that holds `fit_render` against the arithmetic it took over, and for the examples that
/// look at a match.
pub async fn read_render(gpu: &'static gpu::Gpu, render: &Rendered) -> Option<units::rgb::Rgb> {
    let bytes = (render.width * render.height * 3 * 4) as u64;
    let mut recording = gpu.record();
    let out = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit render out"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    recording.copy_buffer_to_buffer(&render.buffer, 0, &out, 0, bytes);
    recording.submit();
    let data = gpu::read_back(gpu, &out, |mapped| {
        mapped
            .par_chunks_exact(4)
            .map(|word| {
                let v = f32::from_ne_bytes([word[0], word[1], word[2], word[3]]);
                (255.0 * v).round().clamp(0.0, 255.0) as u8
            })
            .collect::<Vec<u8>>()
    })
    .await?;
    Some(units::rgb::Rgb {
        width: render.width,
        height: render.height,
        data,
    })
}

#[cfg(test)]
mod tests {
    use colour::tone::{Levels, WHITE_FLOOR_UNDER_PEAK};
    use units::light::{Level, Light};

    /// A frame of one pixel per level asked for, grey, one row tall. `fit_levels` samples a fixed
    /// count and this is shorter than that count, so every pixel is read exactly once and the
    /// histogram it counts is these levels themselves.
    fn frame(levels: impl IntoIterator<Item = usize>) -> Vec<u16> {
        levels
            .into_iter()
            .flat_map(|level| [colour::resident::bits_of_level(level as f32); 3])
            .collect()
    }

    fn stored(level: f32) -> Light<Level> {
        Light::measured(f64::from(colour::resident::level_of_bits(
            colour::resident::bits_of_level(level),
        )))
    }

    fn scanned(gpu: &'static gpu::Gpu, samples: &[u16], quantile: f64) -> Levels {
        let resident = colour::resident::Resident::upload(gpu, samples, samples.len() / 3, 1);
        pollster::block_on(super::levels(gpu, &resident, quantile))
            .expect("the device read the levels off the frame")
    }

    #[test]
    fn the_peak_is_read_above_diffuse_white() {
        let Some(gpu) = gpu::device() else {
            return;
        };
        let out = scanned(gpu, &frame((0..3000).map(|i| i * 20)), 0.9);
        assert!(
            out.peak > out.white,
            "the peak must sit above diffuse white"
        );
        assert!(out.white > Light::ZERO);
    }

    /// A night frame: nine pixels in ten near black, the rest lit. The quantile lands on the
    /// dark ground and the anchor is held to three stops under the lights instead.
    #[test]
    fn diffuse_white_is_read_no_lower_than_three_stops_under_the_peak() {
        let Some(gpu) = gpu::device() else {
            return;
        };
        let night = frame((0..10_000).map(|i| if i % 10 == 0 { 40_000 } else { 400 }));
        let out = scanned(gpu, &night, 0.9);
        let lit = stored(40_000.0);
        assert_eq!(out.peak, lit);
        assert_eq!(out.white, lit / WHITE_FLOOR_UNDER_PEAK);

        // Where the quantile already sits within reach of the peak the floor does nothing.
        let out = scanned(gpu, &frame((0..10_000).map(|i| i * 4)), 0.9);
        assert!(out.white > out.peak / WHITE_FLOOR_UNDER_PEAK);
        let apart = (out.white - Light::measured(36_000.0)).raw();
        assert!(
            apart.abs() < 100.0,
            "the quantile itself, got {:?}",
            out.white
        );
    }

    #[test]
    fn a_reconstructed_sun_past_full_scale_leaves_diffuse_white_alone() {
        let Some(gpu) = gpu::device() else {
            return;
        };
        let sun = 8 * usize::from(u16::MAX);
        let out = scanned(
            gpu,
            &frame((0..10_000).map(|i| if i % 100 == 0 { sun } else { 20_000 })),
            0.9,
        );
        assert_eq!(out.peak, stored(sun as f32));
        assert_eq!(out.white, stored(20_000.0));

        // A sun so large the quantile lands on it: white holds at what the sensor recorded.
        let out = scanned(
            gpu,
            &frame((0..10_000).map(|i| if i % 5 == 0 { sun } else { 20_000 })),
            0.9,
        );
        assert_eq!(out.peak, stored(sun as f32));
        assert_eq!(out.white, stored(f32::from(u16::MAX)));
    }
    /// `fit_render` against the arithmetic it took over, on the plane and the white the same round
    /// trip produced.
    ///
    /// **The host copy exists for this and for building fixtures, nothing else** - the fit reads the
    /// device buffer, and this test is the only thing that brings the plane back. What it pins is
    /// the whole chain in one: dividing by diffuse white rather than the peak, the Rec.2020 to sRGB
    /// matrix arriving through the uniform rather than as a literal in the shader, the transfer,
    /// and the quantisation onto the 255 steps the camera's JPEG lives on. A drift in any of them
    /// moves what the geometry search compares against the JPEG, and the search would go on
    /// returning a fit - a slightly wrong one.
    #[test]
    fn the_rendered_plane_is_what_the_host_would_have_computed() {
        let Some(gpu) = gpu::device() else {
            eprintln!("SKIPPED: no adapter answered, so the render was not read off the device.");
            return;
        };
        // A frame with something in every decade of the range, so the transfer's toe, its curve
        // and the clamp above white are all exercised rather than one flat level.
        let (width, height) = (64usize, 48usize);
        let mut samples = vec![0u16; width * height * 3];
        let stored = |level: usize| colour::resident::bits_of_level((level % 60000) as f32);
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                samples[i] = stored(x * 900 + y * 40);
                samples[i + 1] = stored(x * 37 + y * 700);
                samples[i + 2] = stored(x * y * 13);
            }
        }
        let resident = colour::resident::Resident::upload(gpu, &samples, width, height);
        let prepared = pollster::block_on(super::prepared(gpu, &resident, width, 0.9))
            .expect("the device prepared the frame");

        let plane =
            pollster::block_on(super::read_plane(gpu, &prepared.plane)).expect("the plane back");
        let want = crate::hdr_fit::render_srgb8(&plane, prepared.levels.white);
        let got =
            pollster::block_on(super::read_render(gpu, &prepared.rendered)).expect("the render");
        assert_eq!((got.width, got.height), (want.width, want.height));
        let worst = got
            .data
            .iter()
            .zip(&want.data)
            .map(|(a, b)| (i32::from(*a) - i32::from(*b)).abs())
            .max()
            .expect("a render");
        // A code, not exact: the shader divides and takes `pow` in f32 where the host has f64, so a
        // sample sitting on a rounding boundary may land either side of it. Anything larger is a
        // different picture rather than a different last bit.
        assert!(
            worst <= 1,
            "the device render is {worst} codes from the host's at worst"
        );
    }
}
