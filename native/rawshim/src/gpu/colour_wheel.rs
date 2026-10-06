//! The colour wheel `lattice::ColourNode`s are edited on.

use super::{Binding, Buffer, Grade, Recording, Uploaded};

/// Places, as ZCAM lightness and opponent pair, and a weight.
pub type Place = [f32; 4];

pub(crate) struct Pipelines {
    backdrop_layout: wgpu::BindGroupLayout,
    backdrop: wgpu::RenderPipeline,
    probe_layout: wgpu::BindGroupLayout,
    scatter: wgpu::ComputePipeline,
    field: wgpu::ComputePipeline,
}

const PROBE_BINDINGS: [(u32, Binding); 12] = [
    (0, Binding::Uniform),
    (2, Binding::Curves),
    (3, Binding::Volume),
    (4, Binding::Storage { read_only: true }),
    (7, Binding::Sampler),
    (10, Binding::Volume),
    (12, Binding::Storage { read_only: true }),
    (14, Binding::Storage { read_only: true }),
    (17, Binding::Detail),
    (19, Binding::Detail),
    (23, Binding::Storage { read_only: true }),
    (24, Binding::Storage { read_only: false }),
];

impl Pipelines {
    pub(super) fn new(device: &wgpu::Device) -> Self {
        let wheel = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("colour wheel"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/colour_wheel.wgsl")).into(),
            ),
        });
        let probe = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("colour probe"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/colour_probe.wgsl")).into(),
            ),
        });
        let backdrop_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("colour wheel"),
            entries: &[Binding::Uniform.drawn(0)],
        });
        let backdrop = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("colour wheel"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("colour wheel"),
                    bind_group_layouts: &[Some(&backdrop_layout)],
                    ..Default::default()
                }),
            ),
            vertex: wgpu::VertexState {
                module: &wheel,
                entry_point: Some("wheel_vs"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &wheel,
                entry_point: Some("backdrop"),
                compilation_options: Default::default(),
                targets: &[Some(super::CANVAS_FORMAT.into())],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        let entries: Vec<_> = PROBE_BINDINGS
            .iter()
            .map(|(binding, kind)| kind.entry(*binding))
            .collect();
        let probe_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("colour probe"),
            entries: &entries,
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("colour probe"),
            bind_group_layouts: &[Some(&probe_layout)],
            ..Default::default()
        });
        let compute = |entry: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&pipeline_layout),
                module: &probe,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        Self {
            backdrop_layout,
            backdrop,
            probe_layout,
            scatter: compute("scatter"),
            field: compute("field"),
        }
    }
}

/// The wheel at one lightness, as `colour_wheel.slang`'s `Wheel` holds it.
#[derive(Clone, Copy, Debug)]
pub struct Backdrop {
    pub lightness: f64,
    pub side: u32,
    /// Diffuse white, in nits.
    pub reference: f64,
}

pub fn wheel_chroma() -> f64 {
    crate::lattice::ChromaMap::of_nodes(&[])
        .axes()
        .chroma_top
        .powi(2)
}

/// Per whole degree of hue, the chroma Display P3 shows out to at `lightness`, with no component
/// negative or past `headroom` times diffuse white.
pub fn displayable(lightness: f64, headroom: f64) -> Vec<f64> {
    let to_p3 = crate::transfer::Primaries::DISPLAY_P3.from_rec2020();
    let top = wheel_chroma();
    let shown = |chroma: f64, hue: f64| {
        let (sin, cos) = hue.to_radians().sin_cos();
        let rendered = crate::lattice::rendered_of([lightness, chroma * cos, chroma * sin])
            .map(crate::light::Light::raw);
        to_p3.iter().all(|row| {
            let v: f64 = row.iter().zip(rendered).map(|(m, c)| m * c).sum();
            (-1e-9..=headroom).contains(&v)
        })
    };
    (0..360)
        .map(|degree| {
            let hue = f64::from(degree);
            if !shown(0.0, hue) {
                return 0.0;
            }
            if shown(top, hue) {
                return top;
            }
            let (mut inside, mut outside) = (0.0, top);
            for _ in 0..24 {
                let mid = 0.5 * (inside + outside);
                match shown(mid, hue) {
                    true => inside = mid,
                    false => outside = mid,
                }
            }
            inside
        })
        .collect()
}

impl super::Gpu {
    /// `target` is `CANVAS_FORMAT`, `side` square.
    pub fn draw_backdrop(
        &self,
        recording: &mut Recording<'_>,
        target: &wgpu::TextureView,
        backdrop: &Backdrop,
    ) {
        let words: Vec<u8> = [
            backdrop.lightness,
            wheel_chroma(),
            f64::from(backdrop.side),
            backdrop.reference,
            super::CANVAS_WHITE_NITS,
        ]
        .iter()
        .flat_map(|v| (*v as f32).to_le_bytes())
        .chain([0u8; 12])
        .collect();
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("colour wheel"),
            contents: &words,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let built = self.colour_wheel();
        let group = self.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("colour wheel"),
            layout: &built.backdrop_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            }],
        });
        let mut pass = recording
            .encoder()
            .begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("colour wheel"),
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
            });
        pass.set_pipeline(&built.backdrop);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
}

#[cfg(target_arch = "wasm32")]
pub fn present_backdrop(gpu: &super::Gpu, stage: &super::Stage, backdrop: &Backdrop) {
    use wgpu::CurrentSurfaceTexture::{Suboptimal, Success};
    let mut recording = gpu.record();
    match &stage.target {
        super::StageTarget::Held(texture) => {
            let Some(texture) = texture else { return };
            recording.holding_texture(texture);
            gpu.draw_backdrop(&mut recording, &texture.view(), backdrop);
            recording.submit();
        }
        super::StageTarget::Surface(surface) => {
            let (Success(image) | Suboptimal(image)) = surface.get_current_texture() else {
                return;
            };
            let target = image.texture.create_view(&Default::default());
            gpu.draw_backdrop(&mut recording, &target, backdrop);
            recording.submit();
            gpu.queue.present(image);
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Probed {
    /// Two per block: each half's mean weighted by its share, or the whole mean and a zero.
    pub scatter: Vec<Place>,
    /// Where the profile takes each asked place.
    pub field: Vec<Place>,
}

pub struct Probing {
    gpu: &'static super::Gpu,
    scatter: (Buffer, usize),
    field: (Buffer, usize),
}

impl Probing {
    pub async fn read(self) -> Option<Probed> {
        let read = |count: usize| {
            move |bytes: &[u8]| -> Vec<Place> {
                bytes
                    .chunks_exact(16)
                    .take(count)
                    .map(|p| {
                        std::array::from_fn(|k| {
                            f32::from_le_bytes([p[k * 4], p[k * 4 + 1], p[k * 4 + 2], p[k * 4 + 3]])
                        })
                    })
                    .collect()
            }
        };
        Some(Probed {
            scatter: super::read_back(self.gpu, &self.scatter.0, read(self.scatter.1)).await?,
            field: super::read_back(self.gpu, &self.field.0, read(self.field.1)).await?,
        })
    }
}

impl Uploaded<'static> {
    pub async fn colour_probe(&self, grade: &Grade<'_>, places: &[Place]) -> Option<Probed> {
        self.probing(grade, places).read().await
    }

    /// Submitted without waiting, so a caller can let go of this upload first.
    pub fn probing(&self, grade: &Grade<'_>, places: &[Place]) -> Probing {
        let described = grade.matched().unwrap_or(&self.identity);
        let gpu = self.gpu;
        let mut recording = gpu.record();
        let (edits, balance) = self.written(grade, described);
        gpu.build_balance(&mut recording, edits, balance);
        let mean = self.mean_if(grade, true);
        let cells = {
            let size = self.mean.borrow().1.size();
            (size.width / 2 * size.height) as usize
        };
        let place_bytes: Vec<u8> = match places.is_empty() {
            true => vec![0; 16],
            false => places
                .iter()
                .flatten()
                .flat_map(|v| v.to_le_bytes())
                .collect(),
        };
        let given = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("colour probe places"),
            contents: &place_bytes,
            usage: wgpu::BufferUsages::STORAGE,
        });
        let answers = |recording: &mut Recording<'_>, count: usize| -> (Buffer, Buffer, u64) {
            let size = (count.max(1) * 16) as u64;
            let out = recording.buffer(&wgpu::BufferDescriptor {
                label: Some("colour probe answers"),
                size,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            let staged = recording.buffer(&wgpu::BufferDescriptor {
                label: Some("colour probe readback"),
                size,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            (out, staged, size)
        };
        let scattered = answers(&mut recording, cells * 2);
        let fielded = answers(&mut recording, places.len());
        let built = gpu.colour_wheel();
        let group = |out: &Buffer| {
            gpu.bind_group(&wgpu::BindGroupDescriptor {
                label: Some("colour probe"),
                layout: &built.probe_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: edits.as_entire_binding(),
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
                        binding: 7,
                        resource: wgpu::BindingResource::Sampler(&gpu.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 10,
                        resource: wgpu::BindingResource::TextureView(&self.chroma_luma),
                    },
                    wgpu::BindGroupEntry {
                        binding: 12,
                        resource: gpu.nits_of_code.as_entire_binding(),
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
                        resource: wgpu::BindingResource::TextureView(&mean),
                    },
                    wgpu::BindGroupEntry {
                        binding: 23,
                        resource: given.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 24,
                        resource: out.as_entire_binding(),
                    },
                ],
            })
        };
        let (scatter_group, field_group) = (group(&scattered.0), group(&fielded.0));
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&built.scatter);
            pass.set_bind_group(0, &scatter_group, &[]);
            pass.dispatch_workgroups((cells as u32).div_ceil(64), 1, 1);
            if !places.is_empty() {
                pass.set_pipeline(&built.field);
                pass.set_bind_group(0, &field_group, &[]);
                pass.dispatch_workgroups((places.len() as u32).div_ceil(64), 1, 1);
            }
        }
        for (out, staged, size) in [&scattered, &fielded] {
            recording
                .encoder()
                .copy_buffer_to_buffer(out, 0, staged, 0, *size);
        }
        recording.submit();
        Probing {
            gpu,
            scatter: (scattered.1, cells * 2),
            field: (fielded.1, places.len()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_backdrop_draws_each_place_at_its_colour() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        const SIDE: u32 = 32;
        let backdrop = Backdrop {
            lightness: 70.0,
            side: SIDE,
            reference: 203.0,
        };
        let target = gpu.own_texture(&wgpu::TextureDescriptor {
            label: Some("wheel"),
            size: wgpu::Extent3d {
                width: SIDE,
                height: SIDE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: super::super::CANVAS_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let row = (SIDE as usize * 8).next_multiple_of(256);
        let mut recording = gpu.record();
        recording.holding_texture(&target);
        gpu.draw_backdrop(&mut recording, &target.view(), &backdrop);
        let staged = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("wheel readback"),
            size: (row * SIDE as usize) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        recording.encoder().copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &target,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &staged,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row as u32),
                    rows_per_image: Some(SIDE),
                },
            },
            target.size(),
        );
        recording.submit();
        let bytes = pollster::block_on(crate::gpu::read_back(gpu, &staged, |b| b.to_vec()))
            .expect("read back");
        let to_p3 = crate::transfer::Primaries::DISPLAY_P3.from_rec2020();
        let (half, top) = (f64::from(SIDE) / 2.0, wheel_chroma());
        for (x, y) in [(16, 16), (30, 16), (16, 2), (5, 27), (24, 9)] {
            let out = [
                (x as f64 + 0.5 - half) / half * top,
                (half - y as f64 - 0.5) / half * top,
            ];
            let rendered = crate::lattice::rendered_of([backdrop.lightness, out[0], out[1]])
                .map(crate::light::Light::raw);
            let at = y * row + x * 8;
            for (c, weights) in to_p3.iter().enumerate() {
                let p3: f64 = weights.iter().zip(rendered).map(|(m, v)| m * v).sum();
                // `prelude.slang`'s `srgb_oetf_signed`, which carries past one.
                let v = p3.abs();
                let encoded = match v <= 0.0031308 {
                    true => 12.92 * v,
                    false => 1.055 * v.powf(1.0 / 2.4) - 0.055,
                };
                let want = p3.signum() * encoded;
                let got = f64::from(half::f16::from_le_bytes([
                    bytes[at + 2 * c],
                    bytes[at + 2 * c + 1],
                ]));
                assert!(
                    (got - want).abs() < 4e-3 * want.abs().max(1.0),
                    "({x}, {y}) channel {c}: drew {got}, wanted {want}"
                );
            }
        }
    }

    #[test]
    fn the_displayable_edge_follows_the_display() {
        let above_white = displayable(110.0, 1.0);
        assert!(above_white.iter().all(|c| *c == 0.0), "{above_white:?}");
        for lightness in [15.0, 60.0, 110.0] {
            let edge = displayable(lightness, 4.9);
            assert!(edge.iter().all(|c| *c > 0.0), "{lightness}: {edge:?}");
        }
    }
}
