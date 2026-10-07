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

pub const DOTS_ACROSS: usize = 64;

const PROBE_BINDINGS: [(u32, Binding); 14] = [
    (0, Binding::Uniform),
    (1, Binding::Storage { read_only: true }),
    (2, Binding::Curves),
    (3, Binding::Volume),
    (4, Binding::Storage { read_only: true }),
    (7, Binding::Sampler),
    (10, Binding::Volume),
    (12, Binding::Storage { read_only: true }),
    (14, Binding::Storage { read_only: true }),
    (17, Binding::Detail),
    (19, Binding::Detail),
    (21, Binding::Detail),
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
#[derive(Clone, Debug)]
pub struct Backdrop {
    pub lightness: f64,
    pub side: u32,
    pub reference: crate::light::Light<crate::light::SceneNits>,
    /// Darkens what this node does not reach, by as much as it does not.
    pub selected: Option<crate::lattice::ColourNode>,
}

const UNREACHED_SHADE: f64 = 0.8;

/// `colour_wheel_editor.tsx`'s `TARGET_RADIUS`, the ring the output colour is drawn inside.
const OUTPUT_RADIUS: f64 = 0.04;

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

/// The colour at ZCAM `lightness`, `hue` in degrees and `chroma`, as coded Display P3, scaled until
/// its brightest component is diffuse white: a shadow's colour is otherwise near black.
pub fn swatch(lightness: f64, hue: f64, chroma: f64) -> [f64; 3] {
    let (sin, cos) = hue.to_radians().sin_cos();
    let rendered = crate::lattice::rendered_of([lightness, chroma * cos, chroma * sin])
        .map(crate::light::Light::raw);
    let p3 = crate::transfer::Primaries::DISPLAY_P3
        .from_rec2020()
        .map(|row| {
            row.iter()
                .zip(rendered)
                .map(|(m, c)| m * c)
                .sum::<f64>()
                .max(0.0)
        });
    let brightest = p3.into_iter().fold(f64::MIN_POSITIVE, f64::max);
    p3.map(|v| {
        let v = v / brightest;
        match v <= 0.0031308 {
            true => 12.92 * v,
            false => 1.055 * v.powf(1.0 / 2.4) - 0.055,
        }
    })
}

impl super::Gpu {
    /// `target` is `CANVAS_FORMAT`, `side` square.
    pub fn draw_backdrop(
        &self,
        recording: &mut Recording<'_>,
        target: &wgpu::TextureView,
        backdrop: &Backdrop,
    ) {
        let kernel = backdrop
            .selected
            .as_ref()
            .map(|node| node.kernel(&crate::lattice::LutAxes::of_nodes()));
        let words: Vec<u8> = [
            backdrop.lightness,
            wheel_chroma(),
            f64::from(backdrop.side),
            backdrop.reference.raw(),
            super::CANVAS_WHITE_NITS,
            kernel.as_ref().map_or(0.0, |_| UNREACHED_SHADE),
            0.0,
            0.0,
        ]
        .into_iter()
        .chain(kernel.map_or([0.0; 8], |k| {
            std::array::from_fn(|i| if i < 4 { k.centre[i] } else { k.reach[i - 4] })
        }))
        .chain(backdrop.selected.as_ref().map_or([0.0; 4], |node| {
            let (sin, cos) = node.target_hue.to_radians().sin_cos();
            [
                node.target_lightness,
                node.target_chroma * cos,
                node.target_chroma * sin,
                OUTPUT_RADIUS,
            ]
        }))
        .chain(crate::lattice::NODE_FEATHER)
        .flat_map(|v| (v as f32).to_le_bytes())
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
        super::StageTarget::Surface(surface, _) => {
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
    /// A grid of pixels, `DOTS_ACROSS` to a row, each as the reader's colour edits key it.
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
        let smoothed = self.chroma_smoothed_for(grade);
        let down = (DOTS_ACROSS as f64 * self.height as f64 / self.width as f64)
            .round()
            .max(1.0) as usize;
        let dots = DOTS_ACROSS * down;
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
        let scattered = answers(&mut recording, dots);
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
                        resource: wgpu::BindingResource::TextureView(&self.mean),
                    },
                    wgpu::BindGroupEntry {
                        binding: 21,
                        resource: wgpu::BindingResource::TextureView(&smoothed),
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
            pass.dispatch_workgroups((dots as u32).div_ceil(64), 1, 1);
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
            scatter: (scattered.1, dots),
            field: (fielded.1, places.len()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIDE: u32 = 32;

    fn backdrop(selected: Option<crate::lattice::ColourNode>) -> Backdrop {
        Backdrop {
            lightness: 70.0,
            side: SIDE,
            reference: crate::light::Light::measured(203.0),
            selected,
        }
    }

    /// The opponent pair the backdrop draws at pixel `(x, y)`.
    fn out_at(x: u32, y: u32) -> [f64; 2] {
        let (half, top) = (f64::from(SIDE) / 2.0, wheel_chroma());
        [
            (f64::from(x) + 0.5 - half) / half * top,
            (half - f64::from(y) - 0.5) / half * top,
        ]
    }

    /// Each pixel's coded P3, row by row.
    fn drawn(gpu: &'static crate::gpu::Gpu, backdrop: &Backdrop) -> Vec<[f64; 3]> {
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
        gpu.draw_backdrop(&mut recording, &target.view(), backdrop);
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
        (0..SIDE as usize * SIDE as usize)
            .map(|i| {
                let at = (i / SIDE as usize) * row + (i % SIDE as usize) * 8;
                std::array::from_fn(|c| {
                    f64::from(half::f16::from_le_bytes([
                        bytes[at + 2 * c],
                        bytes[at + 2 * c + 1],
                    ]))
                })
            })
            .collect()
    }

    #[test]
    fn the_backdrop_draws_each_place_at_its_colour() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let backdrop = backdrop(None);
        let pixels = drawn(gpu, &backdrop);
        for (x, y) in [(16, 16), (30, 16), (16, 2), (5, 27), (24, 9)] {
            let got = pixels[(y * SIDE + x) as usize];
            assert_drawn(got, coded_at(backdrop.lightness, out_at(x, y)), (x, y));
        }
    }

    /// The canvas's coded P3 for a colour at `lightness` and opponent pair `out`.
    fn coded_at(lightness: f64, out: [f64; 2]) -> [f64; 3] {
        let to_p3 = crate::transfer::Primaries::DISPLAY_P3.from_rec2020();
        let rendered =
            crate::lattice::rendered_of([lightness, out[0], out[1]]).map(crate::light::Light::raw);
        std::array::from_fn(|c| {
            let p3: f64 = to_p3[c].iter().zip(rendered).map(|(m, v)| m * v).sum();
            // `prelude.slang`'s `srgb_oetf_signed`, which carries past one.
            let v = p3.abs();
            let encoded = match v <= 0.0031308 {
                true => 12.92 * v,
                false => 1.055 * v.powf(1.0 / 2.4) - 0.055,
            };
            p3.signum() * encoded
        })
    }

    fn assert_drawn(got: [f64; 3], want: [f64; 3], at: (u32, u32)) {
        for c in 0..3 {
            assert!(
                (got[c] - want[c]).abs() < 4e-3 * want[c].abs().max(1.0),
                "{at:?} channel {c}: drew {}, wanted {}",
                got[c],
                want[c]
            );
        }
    }

    #[test]
    fn a_selected_node_darkens_what_it_does_not_reach() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let (x, y) = (24, 9);
        let [a, b] = out_at(x, y);
        let node = crate::lattice::ColourNode {
            hue: b.atan2(a).to_degrees().rem_euclid(360.0),
            chroma: a.hypot(b),
            lightness: None,
            target_hue: 0.0,
            target_chroma: 0.0,
            target_lightness: 55.0,
            hue_reach: 30.0,
            chroma_reach: 6.0,
            lightness_reach: 0.0,
        };
        let plain = drawn(gpu, &backdrop(None));
        let shaded = drawn(gpu, &backdrop(Some(node)));
        let share = |x: u32, y: u32| {
            let at = (y * SIDE + x) as usize;
            shaded[at][1] / plain[at][1]
        };
        // Two pixels off is well inside its reach, short of the feather: undarkened as well.
        for (x, y) in [(x, y), (x - 2, y)] {
            assert!(
                (share(x, y) - 1.0).abs() < 2e-3,
                "({x}, {y}): {}",
                share(x, y)
            );
        }
        let unreached = 1.0 - UNREACHED_SHADE;
        assert!((share(5, 27) - unreached).abs() < 2e-3, "{}", share(5, 27));
    }

    #[test]
    fn the_output_colour_is_drawn_undarkened_inside_its_ring() {
        const EDITOR: &str = include_str!(
            "../../../../web/src/features/raw_edit/colour_wheel/colour_wheel_editor.tsx"
        );
        let line = format!("const TARGET_RADIUS = {OUTPUT_RADIUS};");
        assert!(
            EDITOR.contains(&line),
            "colour_wheel_editor.tsx does not say `{line}`"
        );
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let ([a, b], [ta, tb]) = (out_at(24, 9), out_at(8, 8));
        let node = crate::lattice::ColourNode {
            hue: b.atan2(a).to_degrees().rem_euclid(360.0),
            chroma: a.hypot(b),
            lightness: None,
            target_hue: tb.atan2(ta).to_degrees(),
            target_chroma: ta.hypot(tb),
            target_lightness: 40.0,
            hue_reach: 15.0,
            chroma_reach: 3.0,
            lightness_reach: 0.0,
        };
        let plain = drawn(gpu, &backdrop(None));
        let shaded = drawn(gpu, &backdrop(Some(node)));
        assert_drawn(
            shaded[(8 * SIDE + 8) as usize],
            coded_at(40.0, [ta, tb]),
            (8, 8),
        );
        // The next pixel out is past the ring, back on the darkened wheel.
        let beside = (8 * SIDE + 9) as usize;
        let unreached = 1.0 - UNREACHED_SHADE;
        assert!((shaded[beside][1] / plain[beside][1] - unreached).abs() < 2e-3);
    }

    #[test]
    fn a_nodes_hue_reach_is_where_it_moves_half_as_far() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        // Mirrored across the axis, so one sits on the other's hue edge at its own chroma.
        let ([a, b], edge) = (out_at(24, 12), (24, 19));
        let hue = b.atan2(a).to_degrees();
        let node = crate::lattice::ColourNode {
            hue,
            chroma: a.hypot(b),
            lightness: None,
            target_hue: 0.0,
            target_chroma: 0.0,
            target_lightness: 55.0,
            hue_reach: 2.0 * hue,
            chroma_reach: 1.0,
            lightness_reach: 0.0,
        };
        let plain = drawn(gpu, &backdrop(None));
        let shaded = drawn(gpu, &backdrop(Some(node)));
        let at = (edge.1 * SIDE + edge.0) as usize;
        let share = shaded[at][1] / plain[at][1];
        let half = 1.0 - UNREACHED_SHADE * 0.5;
        assert!((share - half).abs() < 2e-3, "{share}, wanted {half}");
    }

    #[test]
    fn the_probe_lays_out_its_dots_as_the_host_reads_them() {
        const SOURCE: &str = include_str!("../../../../slang/colour_probe.slang");
        let line = format!("static const uint DOTS_ACROSS = {DOTS_ACROSS};");
        assert!(
            SOURCE.contains(&line),
            "colour_probe.slang does not say `{line}`"
        );
    }

    #[test]
    fn a_swatch_is_its_colour_at_white() {
        for lightness in [10.0, 100.0] {
            let grey = swatch(lightness, 0.0, 0.0);
            assert!(grey.iter().all(|c| (c - 1.0).abs() < 1e-3), "{grey:?}");
        }
        let (hue, chroma) = (30.0_f64, 10.0);
        let [a, b] = [
            chroma * hue.to_radians().cos(),
            chroma * hue.to_radians().sin(),
        ];
        let coded = coded_at(55.0, [a, b]);
        let brightest = (0..3)
            .max_by(|&i, &j| coded[i].total_cmp(&coded[j]))
            .unwrap();
        for lightness in [10.0, 55.0, 110.0] {
            let shown = swatch(lightness, hue, chroma);
            assert!(
                (shown[brightest] - 1.0).abs() < 1e-9,
                "{lightness}: {shown:?}"
            );
            assert!(shown.iter().any(|c| *c < 0.9), "{lightness}: {shown:?}");
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
