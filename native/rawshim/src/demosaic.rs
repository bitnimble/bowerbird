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
pub const MARGIN: u32 = 10;

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

/// Two greens on one diagonal of the 2x2, one red and one blue on the other.
///
/// That covers RGGB, BGGR, GRBG and GBRG and excludes everything else - X-Trans, Foveon, and the
/// quad patterns - for the reason every stage here pairs rows and columns into 2x2 sites. Asked by
/// both demosaics, so a sensor the GPU turns away does not come back through the CPU instead.
fn is_bayer(cfa: [u32; 4]) -> bool {
    let (a, b) = if cfa[1] == 1 && cfa[2] == 1 {
        (cfa[0], cfa[3])
    } else if cfa[0] == 1 && cfa[3] == 1 {
        (cfa[1], cfa[2])
    } else {
        return false;
    };
    (a == 0 && b == 2) || (a == 2 && b == 0)
}

/// The same frame demosaiced on the CPU, for a host that has no device to run RCD on.
///
/// **This is a different picture, not a slower one.** PPG is the algorithm RCD replaced, and
/// `examples/demosaic_psnr.rs` is where the gap between them is measured; a frame reconstructed
/// here is a worse reconstruction of the same photograph. Taking it therefore says so on stderr,
/// because a fall-through nothing announces is how a regression passes a whole fixture suite.
///
/// rawler's own, rather than one written here: it is already a dependency, already the only thing
/// that reads a sensor, and already Bayer-aware down to the pattern shift.
///
/// Interleaved RGB in the mosaic's own coordinates - the same shape `to_rec2020_from` reads, and
/// not the `u8` mapping [`demosaic_with`] hands back, since nothing here crosses a GPU buffer.
/// `cfa` is the 2x2 read row-major with 0 red, 1 green, 2 blue, as everywhere else in this module.
///
/// ponytail: the whole frame at once, where the GPU path tiles at `RENDER_TILE`. Three floats a
/// photosite is 732MB at 61MP, which fits wasm32's address space beside the mosaic and would not
/// fit much more. PPG takes a `Rect`, so tiling it is `demosaic_in_tiles` with a different inner
/// call if a real sensor ever runs out of room.
pub fn cpu(mosaic: &[f32], width: usize, height: usize, cfa: [u32; 4]) -> Option<Vec<f32>> {
    use rawler::imgop::sensor::Demosaic;

    // PPG panics rather than declining on a pattern it cannot read, so both checks happen here.
    if mosaic.len() < width * height || width == 0 || height == 0 || !is_bayer(cfa) {
        return None;
    }
    let name: String = cfa
        .iter()
        .map(|colour| match colour {
            0 => 'R',
            1 => 'G',
            _ => 'B',
        })
        .collect();
    let pattern = rawler::cfa::CFA::new(&name);

    eprintln!("rawshim: no GPU for the demosaic, so this frame is PPG on the CPU rather than RCD");
    let plane = rawler::pixarray::PixF32::new_with(mosaic[..width * height].to_vec(), width, height);
    let whole = rawler::imgop::Rect::new(
        rawler::imgop::Point::new(0, 0),
        rawler::imgop::Dim2::new(width, height),
    );
    let rgb = rawler::imgop::sensor::bayer::ppg::PPGDemosaic::new().demosaic(
        &plane,
        &pattern,
        &rawler::cfa::PlaneColor::default(),
        whole,
    );
    Some(rgb.into_inner().into_flattened())
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

/// Demosaics a Bayer mosaic, handing `consume` the interleaved RGB as native-endian `f32` bytes,
/// three per pixel, at the same dimensions.
///
/// `mosaic` is expected already conditioned as the specification's §2.2 requires: black subtracted,
/// clamped at zero and divided by the white level, so it sits in roughly the unit interval. That is
/// not cosmetic - both numerical guards in the algorithm are chosen for that scale, and feeding raw
/// sensor counts makes them irrelevant while feeding very small values makes them dominate.
///
/// `cfa` is the sensor's 2x2 pattern read row-major from the top-left of the frame, with 0 red,
/// 1 green and 2 blue. Bayer only: a pattern that is not two greens on a diagonal is refused,
/// because every stage here pairs rows and columns into 2x2 sites.
pub fn demosaic_with<T>(
    gpu: &crate::gpu::Gpu,
    rcd: &Rcd,
    mosaic: &[f32],
    width: usize,
    height: usize,
    cfa: [u32; 4],
    consume: impl FnOnce(&[u8]) -> T,
) -> Option<T> {
    if width < (2 * MARGIN as usize) + 4 || height < (2 * MARGIN as usize) + 4 {
        return None;
    }
    if mosaic.len() < width * height {
        return None;
    }
    if !is_bayer(cfa) {
        return None;
    }

    let mut lap = crate::clock::laps("    rcd ");

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
    lap("upload");

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
    lap("allocate");

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
    lap("dispatch");
    let out = {
        let mapped = slice.get_mapped_range().ok()?;
        consume(&mapped)
    };
    readback.unmap();
    lap("read back");
    Some(out)
}

#[cfg(test)]
mod tests {
    /// The seam between what RCD writes and what the border fill writes.
    ///
    /// **A stage may only read a site an earlier stage actually wrote.** §10's reaches are
    /// cumulative from the mosaic, so each stage can compute nearer the edge than the final margin
    /// of 10 - and it has to, because the stage after it reads past its own output. Gating them all
    /// at 10 left stage E reading green at `r - 2` on the first interior row, where stage C had
    /// declined to write and the seed's zero was still sitting: a ring of wrong colour a few pixels
    /// wide, around every frame, on every photograph.
    ///
    /// Measured on a field smooth enough that the interior is nearly exact, so anything the seam
    /// does stands out against it. `demosaic_psnr` cannot see this - it crops 16 pixels off each
    /// side, "comfortably more than the algorithm's own margin", which is exactly the band at issue.
    #[test]
    fn the_seam_reconstructs_as_well_as_the_interior() {
        let Some(gpu) = crate::gpu::device() else { return };
        let Some(rcd) = super::device(gpu) else { return };

        let (w, h) = (96usize, 96usize);
        let cfa = [0u32, 1, 1, 2];
        // One smooth ramp with a constant offset per channel, so every colour difference is
        // constant over the frame - which is the assumption RCD interpolates under, and the only
        // kind of field it reconstructs to within rounding. A field whose channels vary
        // *differently* measures the algorithm's modelling error instead, which at 0.13 here
        // swamps what this test is looking for.
        let truth = |r: usize, c: usize, channel: usize| -> f32 {
            let (x, y) = (c as f32 / w as f32, r as f32 / h as f32);
            let base = 0.3 + 0.3 * x + 0.2 * y;
            base + match channel {
                0 => 0.10,
                1 => 0.0,
                _ => -0.05,
            }
        };
        let mosaic: Vec<f32> = (0..h)
            .flat_map(|r| (0..w).map(move |c| truth(r, c, cfa[(r & 1) * 2 + (c & 1)] as usize)))
            .collect();

        let rgb = super::demosaic_with(gpu, rcd, &mosaic, w, h, cfa, |bytes| {
            bytes
                .chunks_exact(4)
                .map(|word| f32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
                .collect::<Vec<f32>>()
        })
        .expect("the demosaic runs");

        let margin = super::MARGIN as usize;
        let worst = |rows: std::ops::Range<usize>, cols: std::ops::Range<usize>| {
            let mut worst = 0f32;
            for r in rows {
                for c in cols.clone() {
                    for channel in 0..3 {
                        let got = rgb[(r * w + c) * 3 + channel];
                        worst = worst.max((got - truth(r, c, channel)).abs());
                    }
                }
            }
            worst
        };

        // The top seam, away from the left and right ones - a band spanning the full width would
        // carry the vertical seams into every row it measured, including the interior's.
        let seam = worst(margin..margin + 4, margin + 8..w - margin - 8);
        let interior = worst(h / 2 - 2..h / 2 + 2, w / 2 - 2..w / 2 + 2);
        // Generous against the interior, because the seam legitimately has less evidence to work
        // from. Measured with the flat margin the seam was off by 0.148 against an interior of
        // 5.2e-6 - a factor of nearly thirty thousand, so the bar has room to spare.
        assert!(
            seam < interior.max(1e-5) * 100.0,
            "the seam is off by {seam} where the interior is off by {interior}",
        );
    }
}
