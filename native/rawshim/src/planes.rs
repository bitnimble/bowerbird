//! A rendition the page decoded, as the codes a finished picture is held at.
//!
//! The browser's `ImageDecoder` reads an AVIF this crate cannot in wasm (`decode_rendered::av1`),
//! and hands back its planes rather than RGB; where there is none, `native/avif_planes` does. `planes.slang` is the conversion libavif does on the
//! server, so what [`crate::linearise::Picture`] holds is the same either way.

use serde::Deserialize;

/// The planes as `VideoFrame.copyTo` laid them out.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub width: usize,
    pub height: usize,
    /// 10 or 12: what each little-endian `u16` sample carries.
    pub bits: u32,
    /// 4:2:0 rather than 4:4:4.
    pub subsampled: bool,
    /// Luma, blue, red, in bytes.
    pub planes: [Plane; 3],
}

#[derive(Deserialize)]
pub struct Plane {
    pub offset: usize,
    pub stride: usize,
}

struct Kernel {
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
}

fn kernel(gpu: &'static crate::gpu::Gpu) -> &'static Kernel {
    static BUILT: std::sync::OnceLock<Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("planes"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/planes.wgsl")).into(),
            ),
        });
        let entry = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("planes"),
            entries: &[
                entry(0, wgpu::BufferBindingType::Uniform),
                entry(1, wgpu::BufferBindingType::Storage { read_only: true }),
                entry(2, wgpu::BufferBindingType::Storage { read_only: false }),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("planes"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("planes"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("planes_to_codes"),
            compilation_options: Default::default(),
            cache: None,
        });
        Kernel { layout, pipeline }
    })
}

/// The picture as interleaved RGB codes at sixteen bits, on the device.
pub fn codes(
    gpu: &'static crate::gpu::Gpu,
    samples: &[u8],
    layout: &Layout,
) -> Result<crate::resident::Resident, String> {
    check(samples.len(), layout)?;
    let uploaded = gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some("planes"),
        size: samples.len().next_multiple_of(4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let whole = samples.len() & !3;
    gpu.queue.write_buffer(&uploaded, 0, &samples[..whole]);
    if whole < samples.len() {
        let mut tail = [0u8; 4];
        tail[..samples.len() - whole].copy_from_slice(&samples[whole..]);
        gpu.queue.write_buffer(&uploaded, whole as u64, &tail);
    }

    let out = crate::resident::Resident::empty(gpu, layout.width, layout.height);
    let kernel = kernel(gpu);
    let mut recording = gpu.record();
    recording.holding(out.buffer());
    recording.holding(&uploaded);
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("planes params"),
        contents: &block(layout),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("planes"),
        layout: &kernel.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: uploaded.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: out.buffer().as_entire_binding() },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel.pipeline);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = crate::base::groups(out.words());
        pass.dispatch_workgroups(x, y, 1);
    }
    recording.submit();
    Ok(out)
}

/// The page's word for where each plane is, held against the bytes it sent: a plane that ran past
/// them would read another plane's samples, or nothing, as a picture.
fn check(bytes: usize, layout: &Layout) -> Result<(), String> {
    if layout.width == 0 || layout.height == 0 {
        return Err("these planes hold no picture".to_string());
    }
    if layout.bits != 10 && layout.bits != 12 {
        return Err(format!("these planes are {} bits, where a rendition is 10 or 12", layout.bits));
    }
    let shift = usize::from(layout.subsampled);
    for (at, plane) in layout.planes.iter().enumerate() {
        let (width, height) = match at {
            0 => (layout.width, layout.height),
            _ => (layout.width.div_ceil(1 << shift), layout.height.div_ceil(1 << shift)),
        };
        let end = (height - 1)
            .checked_mul(plane.stride)
            .and_then(|rows| rows.checked_add(plane.offset))
            .and_then(|start| start.checked_add(width * 2));
        if plane.offset % 2 != 0 || plane.stride % 2 != 0 || plane.stride < width * 2 {
            return Err(format!("plane {at} is not laid out in whole samples"));
        }
        if end.is_none_or(|end| end > bytes) {
            return Err(format!("plane {at} runs past the {bytes} bytes it came in"));
        }
    }
    Ok(())
}

fn block(layout: &Layout) -> Vec<u8> {
    let depth: f32 = match layout.bits {
        12 => 4.0,
        _ => 1.0,
    };
    let mut bytes = Vec::with_capacity(BLOCK_BYTES);
    for word in [layout.width as u32, layout.height as u32, u32::from(layout.subsampled)] {
        bytes.extend_from_slice(&word.to_le_bytes());
    }
    bytes.extend_from_slice(&depth.to_le_bytes());
    let offsets = layout.planes.each_ref().map(|plane| plane.offset);
    let strides = layout.planes.each_ref().map(|plane| plane.stride);
    for in_bytes in [offsets, strides] {
        for value in in_bytes {
            bytes.extend_from_slice(&((value / 2) as u32).to_le_bytes());
        }
        bytes.extend_from_slice(&0u32.to_le_bytes());
    }
    bytes
}

/// What [`block`] writes, for `wgsl_layout` to hold against the shader's own struct.
pub(crate) const BLOCK_BYTES: usize = 4 * 4 + 2 * 16;
