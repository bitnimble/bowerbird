//! Ratio Corrected Demosaicing on the GPU.
//!
//! The algorithm is specified in `docs/rcd-algorithm-spec.md`, which is the normative document and
//! was written clean-room: every implementation of RCD in the wild is GPL-3, so one agent read
//! those and wrote the specification in mathematics, a second audited it for copyrightable
//! expression, and this file was written from the result without its author reading any of them.
//!
//! Six stages, each a pure map over its site set, so each is one dispatch and nothing inside a
//! stage depends on anything else the same stage writes.

use wgpu::util::DeviceExt;

/// Pixels at the frame edge that RCD does not write, filled by a cheap interpolation instead.
///
/// The specification's reach analysis composes to exactly this: the low-pass reaches 1, the
/// directional kernel 3, its energy 4, the refinement 5, and the two chroma stages 7 and 10.
const MARGIN: u32 = 10;

const STAGES: [&str; 7] = [
    "seed",
    "low_pass",
    "fields",
    "green_at_chroma",
    "chroma_at_chroma",
    "chroma_at_greens",
    "assemble",
];

pub struct Rcd {
    frame: wgpu::BindGroupLayout,
    planes: wgpu::BindGroupLayout,
    pipelines: Vec<wgpu::ComputePipeline>,
}

pub fn device(gpu: &'static crate::gpu::Gpu) -> Option<&'static Rcd> {
    static BUILT: std::sync::OnceLock<Option<Rcd>> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Rcd::new(gpu)).as_ref()
}

/// The uniform block, laid out by hand because the alternative is a serialisation crate for ten
/// words. Order and padding must match `Params` in the shader.
fn params_bytes(width: u32, height: u32, cfa: [u32; 4], margin: u32) -> Vec<u8> {
    // Eight words, which is 32 bytes and so already the multiple of 16 a uniform block must be.
    let words = [width, height, cfa[0], cfa[1], cfa[2], cfa[3], margin, 0];
    words.iter().flat_map(|w| w.to_ne_bytes()).collect()
}

impl Rcd {
    fn new(gpu: &crate::gpu::Gpu) -> Option<Rcd> {
        let device = &gpu.device;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("rcd"),
            source: wgpu::ShaderSource::Wgsl(include_str!("wgsl/rcd.wgsl").into()),
        });

        let storage = |binding: u32, read_only: bool| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };

        // Split in two so no single stage declares more than the eight storage buffers a device is
        // required to offer: the mosaic rides with the uniform, the seven working planes are their
        // own group.
        let frame = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("rcd frame"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                storage(1, true),
            ],
        });
        let planes = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("rcd planes"),
            entries: &(0..7).map(|b| storage(b, false)).collect::<Vec<_>>(),
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("rcd"),
            bind_group_layouts: &[Some(&frame), Some(&planes)],
            ..Default::default()
        });

        let pipelines = STAGES
            .iter()
            .map(|name| {
                device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(name),
                    layout: Some(&pipeline_layout),
                    module: &module,
                    entry_point: Some(name),
                    compilation_options: Default::default(),
                    cache: None,
                })
            })
            .collect();

        Some(Rcd { frame, planes, pipelines })
    }
}

/// Demosaics a Bayer mosaic, returning interleaved RGB at the same dimensions.
///
/// `mosaic` is expected already conditioned as the specification's §2.2 requires: black subtracted,
/// clamped at zero and divided by the white level, so it sits in roughly the unit interval. That is
/// not cosmetic - both numerical guards in the algorithm are chosen for that scale, and feeding raw
/// sensor counts makes them irrelevant while feeding very small values makes them dominate.
///
/// `cfa` is the sensor's 2x2 pattern read row-major from the top-left of the frame, with 0 red,
/// 1 green and 2 blue. Bayer only: a pattern that is not two greens on a diagonal is refused,
/// because every stage here pairs rows and columns into 2x2 sites.
pub fn demosaic(
    gpu: &crate::gpu::Gpu,
    rcd: &Rcd,
    mosaic: &[f32],
    width: usize,
    height: usize,
    cfa: [u32; 4],
) -> Option<Vec<f32>> {
    if width < (2 * MARGIN as usize) + 4 || height < (2 * MARGIN as usize) + 4 {
        return None;
    }
    if mosaic.len() < width * height {
        return None;
    }
    // Two greens on one diagonal of the 2x2, one red and one blue on the other. That covers RGGB,
    // BGGR, GRBG and GBRG and excludes everything else - X-Trans, Foveon, and the quad patterns -
    // for the reason every stage here pairs rows and columns into 2x2 sites.
    let (a, b) = if cfa[1] == 1 && cfa[2] == 1 {
        (cfa[0], cfa[3])
    } else if cfa[0] == 1 && cfa[3] == 1 {
        (cfa[1], cfa[2])
    } else {
        return None;
    };
    if (a != 0 || b != 2) && (a != 2 || b != 0) {
        return None;
    }

    let device = &gpu.device;
    let pixels = width * height;
    let plane_bytes = (pixels * std::mem::size_of::<f32>()) as u64;

    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("rcd params"),
        contents: &params_bytes(width as u32, height as u32, cfa, MARGIN),
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let mosaic_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("rcd mosaic"),
        size: plane_bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    // A megabyte at a time rather than one buffer of the whole frame, for the reason `galosh`
    // gives: the intermediate would be a quarter of a gigabyte at 61MP, held beside a decode that
    // is already the largest thing in the process.
    const CHUNK: usize = 1 << 18;
    let mut bytes: Vec<u8> = Vec::with_capacity(CHUNK * 4);
    for (at, block) in mosaic[..pixels].chunks(CHUNK).enumerate() {
        bytes.clear();
        for sample in block {
            bytes.extend_from_slice(&sample.to_ne_bytes());
        }
        gpu.queue.write_buffer(&mosaic_buf, (at * CHUNK * 4) as u64, &bytes);
    }

    let plane = |label: &str, bytes: u64| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        })
    };
    let lowpass = plane("rcd lowpass", plane_bytes);
    let field_axis = plane("rcd axis field", plane_bytes);
    let field_diag = plane("rcd diagonal field", plane_bytes);
    let green = plane("rcd green", plane_bytes);
    let red = plane("rcd red", plane_bytes);
    let blue = plane("rcd blue", plane_bytes);
    let rgb = plane("rcd rgb", plane_bytes * 3);

    let frame_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("rcd frame"),
        layout: &rcd.frame,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: mosaic_buf.as_entire_binding() },
        ],
    });
    let plane_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("rcd planes"),
        layout: &rcd.planes,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: lowpass.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: field_axis.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: field_diag.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: green.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: red.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: blue.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: rgb.as_entire_binding() },
        ],
    });

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("rcd") });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("rcd"),
            timestamp_writes: None,
        });
        pass.set_bind_group(0, &frame_group, &[]);
        pass.set_bind_group(1, &plane_group, &[]);
        let groups_x = width.div_ceil(8) as u32;
        let groups_y = height.div_ceil(8) as u32;
        // In order: the stages have real dependencies on each other (the specification's §12), and
        // a compute pass gives each dispatch a barrier against the last.
        for pipeline in &rcd.pipelines {
            pass.set_pipeline(pipeline);
            pass.dispatch_workgroups(groups_x, groups_y, 1);
        }
    }

    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("rcd readback"),
        size: plane_bytes * 3,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_buffer_to_buffer(&rgb, 0, &readback, 0, plane_bytes * 3);
    gpu.queue.submit(Some(encoder.finish()));

    let slice = readback.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    device.poll(wgpu::PollType::wait_indefinitely()).ok()?;
    let out: Vec<f32> = {
        let mapped = slice.get_mapped_range().ok()?;
        mapped
            .chunks_exact(4)
            .map(|b| f32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
            .collect()
    };
    readback.unmap();
    Some(out)
}
