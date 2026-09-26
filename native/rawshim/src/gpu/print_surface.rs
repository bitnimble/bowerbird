use super::{Binding, Buffer, Grade, Recording, Texture, Uploaded, uniform_words};
use crate::light::Light;
use crate::print::Scene;
use crate::px::{Canvas, Size};

#[cfg(test)]
mod tests;

pub(super) struct Pipelines {
    scene_layout: wgpu::BindGroupLayout,
    field_layout: wgpu::BindGroupLayout,
    draw_layout: wgpu::BindGroupLayout,
    field: wgpu::ComputePipeline,
    draw: wgpu::RenderPipeline,
    pq: wgpu::RenderPipeline,
}

impl Pipelines {
    pub(super) fn new(device: &wgpu::Device) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("print surface"),
            source: wgpu::ShaderSource::Wgsl(include_str!(concat!(env!("OUT_DIR"), "/wgsl/print_surface.wgsl")).into()),
        });
        let scene_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("print surface scene"),
            entries: &[
                Binding::Uniform.seen_by(0, wgpu::ShaderStages::COMPUTE | wgpu::ShaderStages::FRAGMENT),
                Binding::Storage { read_only: true }.seen_by(1, wgpu::ShaderStages::COMPUTE | wgpu::ShaderStages::FRAGMENT),
                Binding::Storage { read_only: true }.seen_by(2, wgpu::ShaderStages::COMPUTE | wgpu::ShaderStages::FRAGMENT),
                Binding::Storage { read_only: true }.seen_by(3, wgpu::ShaderStages::COMPUTE | wgpu::ShaderStages::FRAGMENT),
            ],
        });
        let field_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("print lighting field"),
            entries: &[
                Binding::Uniform.entry(0),
                wgpu::BindGroupLayoutEntry {
                    binding: 4, visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba16Float,
                        view_dimension: wgpu::TextureViewDimension::D3,
                    }, count: None,
                },
            ],
        });
        let draw_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("print surface draw"),
            entries: &[Binding::Uniform.drawn(0), Binding::Detail.drawn(1), Binding::Volume.drawn(2), Binding::Sampler.drawn(3)],
        });
        let field = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("print lighting field"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("print lighting field"), bind_group_layouts: &[Some(&field_layout), Some(&scene_layout)],
                ..Default::default()
            })),
            module: &module, entry_point: Some("build_lighting"), compilation_options: Default::default(), cache: None,
        });
        let draw = |entry, format: wgpu::TextureFormat| device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("print surface"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("print surface"), bind_group_layouts: &[Some(&draw_layout), Some(&scene_layout)],
                ..Default::default()
            })),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(entry),
                compilation_options: Default::default(), targets: &[Some(format.into())] }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
        });
        let pq = draw("fs_pq", wgpu::TextureFormat::Rgba16Uint);
        let draw = draw("fs", super::CANVAS_FORMAT);
        Self { scene_layout, field_layout, draw_layout, field, draw, pq }
    }
}

#[derive(Default)]
pub(super) struct Cached {
    pub(super) pigment: Option<Pigment>,
    lighting: Option<(Vec<u8>, Texture)>,
}

pub(super) struct Pigment {
    words: Vec<u32>,
    peak_revision: u64,
    texture: Texture,
}

impl Uploaded<'_> {
    pub(super) fn draw_print_surface(
        &self, recording: &mut Recording<'_>, grade: &Grade<'_>, pyramid: &crate::base::Pyramid,
        target: &wgpu::TextureView, scene: &Scene, pq: bool,
    ) {
        let display_peak = grade.peak_nits;
        let grade = Grade {
            peak_nits: Light::at_diffuse_white(grade.reference_nits),
            // The pigment pass carries no print group, so the intent travels with the grade -
            // which is also what keys the pigment cache, so choosing another one redraws it.
            intent: scene.rendering_intent,
            print_blur: scene.ink_blur(grade.output().long()),
            ..grade.clone()
        };
        let shown = grade.canvas.expect("print surface canvas");
        let size = shown.size;
        let shape = grade.output_size();
        let pigment_grade = Grade { canvas: Some(super::Canvas {
            region: scene.photo_region(shape, shown.region), ..shown
        }), ..grade };
        let pigment = self.print_pigment(recording, &pigment_grade, pyramid);
        let view = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("print surface view"),
            contents: &[shown.region.0, shown.region.1, shown.region.2, shown.region.3,
                size.width.raw() as f64, size.height.raw() as f64, shape.0 as f64, shape.1 as f64]
                .into_iter().flat_map(|value| (value as f32).to_le_bytes()).collect::<Vec<_>>(),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let albedo = self.print_albedo_for(scene.refractive_index as f32);
        let calibration = self.print_light_for(scene.light_parameters(), scene.light_temperature_kelvin as f32);
        recording.holding(&albedo);
        recording.holding(&calibration);
        let (parameters, proof) = self.print_scene_binding(recording, scene, display_peak);
        let pipelines = &self.gpu.print_surface;
        let scene_group = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("print surface scene"), layout: &pipelines.scene_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: parameters.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: albedo.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: calibration.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: proof.as_entire_binding() },
            ],
        });
        let lighting = self.print_lighting(recording, scene, shape, &view, &scene_group);
        let group = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("print surface"), layout: &pipelines.draw_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: view.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&pigment.view()) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&lighting.view()) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&self.gpu.sampler) },
            ],
        });
        let mut pass = recording.encoder().begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("print surface"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: target, depth_slice: None, resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })],
            ..Default::default()
        });
        pass.set_pipeline(if pq { &pipelines.pq } else { &pipelines.draw });
        pass.set_bind_group(0, &group, &[]);
        pass.set_bind_group(1, &scene_group, &[]);
        pass.draw(0..3, 0..1);
    }

    fn print_pigment(&self, recording: &mut Recording<'_>, grade: &Grade<'_>, pyramid: &crate::base::Pyramid) -> Texture {
        let words = uniform_words(grade, grade.matched().unwrap_or(&self.identity));
        let peak_revision = self.peak_revision.load(std::sync::atomic::Ordering::Relaxed);
        let mut cached = self.print_surface.borrow_mut();
        if let Some(pigment) = cached.pigment.as_ref() {
            if pigment.words == words && pigment.peak_revision == peak_revision {
                recording.holding_texture(&pigment.texture);
                return pigment.texture.clone();
            }
        }
        let size: Size<Canvas> = grade.canvas.expect("print surface canvas").size;
        let texture = self.gpu.own_texture(&wgpu::TextureDescriptor {
            label: Some("print pigment"),
            size: wgpu::Extent3d { width: size.width.raw() as u32, height: size.height.raw() as u32, depth_or_array_layers: 1 },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        recording.holding_texture(&texture);
        self.draw_direct(recording, grade, pyramid, &texture.view(), None, false, true);
        cached.pigment = Some(Pigment { words, peak_revision, texture: texture.clone() });
        texture
    }

    fn print_lighting(
        &self, recording: &mut Recording<'_>, scene: &Scene, shape: (usize, usize),
        view: &Buffer, scene_group: &wgpu::BindGroup,
    ) -> Texture {
        let normalized = Scene { key_lux: Light::ZERO, fill_lux: Light::ZERO, light_temperature_kelvin: 6500.0,
            white_reflectance: crate::light::Gain::of_ratio(1.0), black_reflectance: crate::light::Gain::of_ratio(0.0), ..*scene };
        let mut key = normalized.uniform(Light::ZERO);
        key.extend(shape.0.to_le_bytes());
        key.extend(shape.1.to_le_bytes());
        let dark = scene.key_lux.raw() == 0.0;
        if dark { key = vec![0]; }
        let mut cached = self.print_surface.borrow_mut();
        if let Some((previous, texture)) = cached.lighting.as_ref() {
            if *previous == key {
                recording.holding_texture(texture);
                return texture.clone();
            }
        }
        let long = if scene.light_angular_degrees <= 5.0 { 512 }
            else if scene.light_angular_degrees <= 10.0 { 256 }
            else if scene.light_angular_degrees < 30.0 { 128 } else { 64 };
        let long = if scene.framed { long.max(96) } else { long };
        let extent = if dark { wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 } } else { wgpu::Extent3d {
            width: (long * shape.0 / shape.0.max(shape.1)).max(2) as u32,
            height: (long * shape.1 / shape.0.max(shape.1)).max(2) as u32,
            depth_or_array_layers: if scene.surface_texture == 0.0 { 1 }
                else if scene.light_angular_degrees < 5.0 && scene.surface_texture > 0.3 { 5 }
                else { 3 },
        } };
        let texture = cached.lighting.as_ref().filter(|(_, texture)| texture.size() == extent)
            .map(|(_, texture)| texture.clone()).unwrap_or_else(|| self.gpu.own_texture(&wgpu::TextureDescriptor {
            label: Some("print lighting"), size: extent, mip_level_count: 1, sample_count: 1,
            dimension: wgpu::TextureDimension::D3, format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        }));
        recording.holding_texture(&texture);
        if dark {
            cached.lighting = Some((key, texture.clone()));
            return texture;
        }
        let group = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("print lighting"), layout: &self.gpu.print_surface.field_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: view.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&texture.view()) },
            ],
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("print lighting"), ..Default::default() });
            pass.set_pipeline(&self.gpu.print_surface.field);
            pass.set_bind_group(0, &group, &[]);
            pass.set_bind_group(1, scene_group, &[]);
            pass.dispatch_workgroups(extent.width.div_ceil(8), extent.height.div_ceil(8), extent.depth_or_array_layers);
        }
        cached.lighting = Some((key, texture.clone()));
        texture
    }
}
