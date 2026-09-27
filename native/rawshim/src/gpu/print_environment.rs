use super::{Binding, Gpu, Texture};
use crate::print::environment::{self, Environment};

#[cfg(test)]
mod tests;

/// What the map is stored at against the file's own scale: the hotel's second downlight reads
/// 207000, which a half float cannot hold, and the lamp calibration takes any scale out again.
const STORED_SCALE: f32 = 1.0 / 16.0;

pub(super) struct Pipelines {
    unpack_layout: wgpu::BindGroupLayout,
    shrink_layout: wgpu::BindGroupLayout,
    unpack: wgpu::ComputePipeline,
    shrink: wgpu::ComputePipeline,
    /// The map and its sampler, as the print's own group binds them.
    pub(super) map_layout: wgpu::BindGroupLayout,
    pub(super) sampler: wgpu::Sampler,
}

impl Pipelines {
    pub(super) fn new(device: &wgpu::Device) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("print environment"),
            source: wgpu::ShaderSource::Wgsl(include_str!(concat!(env!("OUT_DIR"), "/wgsl/print_environment_build.wgsl")).into()),
        });
        let written = wgpu::BindGroupLayoutEntry {
            binding: 2, visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::StorageTexture {
                access: wgpu::StorageTextureAccess::WriteOnly,
                format: wgpu::TextureFormat::Rgba16Float,
                view_dimension: wgpu::TextureViewDimension::D2,
            }, count: None,
        };
        let unpack_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("print environment unpack"),
            entries: &[Binding::Uniform.entry(0), Binding::Storage { read_only: true }.entry(1), written],
        });
        let shrink_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("print environment shrink"),
            entries: &[Binding::Uniform.entry(0), written, Binding::Detail.entry(3)],
        });
        let compute = |layout: &wgpu::BindGroupLayout, entry: &str| device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(entry),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(entry), bind_group_layouts: &[Some(layout)], ..Default::default()
            })),
            module: &module, entry_point: Some(entry), compilation_options: Default::default(), cache: None,
        });
        let unpack = compute(&unpack_layout, "unpack");
        let shrink = compute(&shrink_layout, "shrink");
        let seen = wgpu::ShaderStages::COMPUTE | wgpu::ShaderStages::FRAGMENT;
        let map_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("print environment map"),
            entries: &[Binding::Detail.seen_by(4, seen), Binding::Sampler.seen_by(5, seen)],
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("print environment"),
            // Across the seam behind the reader, which a lobe straddles as readily as anywhere else.
            address_mode_u: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        Self { unpack_layout, shrink_layout, unpack, shrink, map_layout, sampler }
    }
}

/// `print_environment_build.slang`'s `Build`, for a level `written` texels across.
fn build_words(written: (u32, u32), map: &environment::Rgbe, source: &environment::Source) -> Vec<u8> {
    let lamp = source.lamp_uv();
    [written.0, written.1, source.turn(map.width), 0]
        .into_iter().flat_map(u32::to_le_bytes)
        .chain([lamp[0], lamp[1], (source.lamp_radius_degrees as f32).to_radians().cos(), 0.0,
            source.threshold as f32, STORED_SCALE, 0.0, 0.0].into_iter().flat_map(f32::to_le_bytes))
        .collect()
}

impl Gpu {
    /// The environment's map, turned to where the print hangs and with its lamp taken out, down to
    /// a texel.
    pub(crate) fn print_environment(&self, environment: Environment) -> Result<Texture, String> {
        let map = environment::decode(&environment.bytes()?)?;
        let source = environment.source();
        let levels = 32 - map.width.max(map.height).leading_zeros();
        let texture = self.own_texture(&wgpu::TextureDescriptor {
            label: Some("print environment"),
            size: wgpu::Extent3d { width: map.width, height: map.height, depth_or_array_layers: 1 },
            mip_level_count: levels, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let mut recording = self.record();
        recording.holding_texture(&texture);
        let texels = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("print environment texels"),
            contents: &map.texels.iter().flat_map(|texel| texel.to_le_bytes()).collect::<Vec<_>>(),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let level_view = |level: u32| texture.create_view(&wgpu::TextureViewDescriptor {
            base_mip_level: level, mip_level_count: Some(1), ..Default::default()
        });
        let pipelines = &self.print_environment;
        for level in 0..levels {
            let (width, height) = ((map.width >> level).max(1), (map.height >> level).max(1));
            let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
                label: Some("print environment build"), contents: &build_words((width, height), &map, &source),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let written = level_view(level);
            let group = if level == 0 {
                self.bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("print environment unpack"), layout: &pipelines.unpack_layout,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 1, resource: texels.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&written) },
                    ],
                })
            } else {
                let finer = level_view(level - 1);
                self.bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("print environment shrink"), layout: &pipelines.shrink_layout,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&written) },
                        wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&finer) },
                    ],
                })
            };
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(if level == 0 { &pipelines.unpack } else { &pipelines.shrink });
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
        }
        recording.submit();
        Ok(texture)
    }

    #[cfg(test)]
    pub(crate) fn print_environment_sampler(&self) -> &wgpu::Sampler {
        &self.print_environment.sampler
    }

    /// The map as the lamp calibration binds it.
    pub(crate) fn print_environment_group(&self, map: &Texture) -> wgpu::BindGroup {
        self.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("print environment map"), layout: &self.print_environment.map_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&map.view()) },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::Sampler(&self.print_environment.sampler) },
            ],
        })
    }
}
