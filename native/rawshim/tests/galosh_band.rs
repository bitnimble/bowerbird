//! A band of the editor's denoise against the same rows of the frame denoised whole.
//!
//! `web/src/features/raw_edit/gpu/denoise_chain.ts` dispatches these kernels a strip at a time so
//! a Detail slider draws progressively, and the strips are only allowed to land final if a band's
//! answer *is* the whole frame's answer over those rows. Nothing else asks: the fixture suite pins
//! the grade at every slider zero, where the denoise does not run at all, and the browser has no
//! whole-frame mode left to compare against.
//!
//! So the claim is asked here, of the two kernels where it is a claim rather than an identity.
//! `pass12` shrinks over a tile grid and `yuv_loess` regresses over a 15x15 window, so both read
//! outside the rows they write; the per-pixel kernels take a `start` and touch nothing else, which
//! the TypeScript side pins by reading its own pushes back.
//!
//! **This is the failure `decode_rawler`'s tiled denoise carried for months.** A region whose
//! origin was off `pass12`'s grid shrank every pixel in it against a neighbourhood the whole-frame
//! answer never used - 94% of a 61MP frame's samples differed, spread rather than banded at the
//! seams, so it did not look like a tiling bug. Exact equality is the assertion because the two
//! runs do identical arithmetic in an identical order: anything but exact means the grid moved.

use wgpu::util::DeviceExt;

const PRELUDE: &str =
    include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/prelude.wgsl");

/// A whole number of `pass12` tiles and of `yuv_loess` workgroups, as `denoise_chain.ts` bands.
const BAND_ROWS: u32 = 112;
const WIDTH: u32 = 128;
const HEIGHT: u32 = BAND_ROWS * 2;
const PASS12_TILE: u32 = 28;
const LOESS_GROUP: u32 = 16;
const LOESS_RADIUS: i32 = 7;

struct Harness {
    gpu: &'static rawshim::gpu::Gpu,
}

impl Harness {
    /// The shipped device, or none where no adapter answered - loudly, since a parity test that
    /// quietly passes because it never ran is worse than no test.
    fn open(what: &str) -> Option<Harness> {
        let Some(gpu) = rawshim::gpu::device() else {
            eprintln!("SKIPPED: no adapter answered, so {what} was not run.");
            return None;
        };
        let limits = gpu.device.limits();
        if limits.max_compute_workgroup_storage_size < 26_240 {
            eprintln!("SKIPPED: this adapter has no room for pass12's tile, so {what} was not run.");
            return None;
        }
        Some(Harness { gpu })
    }

    fn plane(&self, values: &[f32]) -> wgpu::Buffer {
        let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        self.gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: &bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        })
    }

    fn push(&self, words: &[u32]) -> wgpu::Buffer {
        let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
        self.gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: &bytes,
            usage: wgpu::BufferUsages::UNIFORM,
        })
    }

    /// One kernel, its storage bindings in declaration order, dispatched once per push.
    ///
    /// Several pushes rather than one because that is what a band *is*: the same bindings, the
    /// same grid width, and a different offset each time.
    fn run(
        &self,
        name: &str,
        body: &str,
        buffers: &[(u32, bool, &wgpu::Buffer)],
        dispatches: &[(&wgpu::Buffer, u32, u32)],
    ) {
        let device = &self.gpu.device;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(name),
            source: wgpu::ShaderSource::Wgsl(format!("{PRELUDE}\n{body}").into()),
        });
        let mut entries: Vec<_> = buffers
            .iter()
            .map(|(binding, read_only, _)| wgpu::BindGroupLayoutEntry {
                binding: *binding,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: *read_only },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            })
            .collect();
        entries.push(wgpu::BindGroupLayoutEntry {
            binding: 20,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some(name),
            entries: &entries,
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some(name),
            bind_group_layouts: &[Some(&layout)],
            ..Default::default()
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(name),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some(name),
            compilation_options: Default::default(),
            cache: None,
        });

        let mut encoder = device.create_command_encoder(&Default::default());
        for (push, x, y) in dispatches {
            let mut bound: Vec<_> = buffers
                .iter()
                .map(|(binding, _, buffer)| wgpu::BindGroupEntry {
                    binding: *binding,
                    resource: buffer.as_entire_binding(),
                })
                .collect();
            bound.push(wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() });
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(name),
                layout: &layout,
                entries: &bound,
            });
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(*x, *y, 1);
        }
        self.gpu.queue.submit([encoder.finish()]);
    }

    fn read(&self, plane: &wgpu::Buffer, len: usize) -> Vec<f32> {
        let device = &self.gpu.device;
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: (len * 4) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(plane, 0, &readback, 0, (len * 4) as u64);
        self.gpu.queue.submit([encoder.finish()]);
        let slice = readback.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::PollType::wait_indefinitely()).expect("the dispatch finished");
        let mapped = slice.get_mapped_range().expect("the readback mapped");
        mapped.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
    }
}

fn read_wgsl(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../web/src/features/raw_edit/gpu/wgsl/galosh")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// A plane with edges, texture and a gradient, because a flat one is shrunk identically by any
/// grid and would pass whatever the tiling did.
fn textured(seed: u32) -> Vec<f32> {
    let mut values = Vec::with_capacity((WIDTH * HEIGHT) as usize);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let hash = (x.wrapping_mul(1103) ^ y.wrapping_mul(2749).wrapping_add(seed)) % 997;
            let grain = hash as f32 / 997.0 - 0.5;
            let ramp = (x + y) as f32 / (WIDTH + HEIGHT) as f32;
            let edge = if x % 37 < 18 { 0.25 } else { 0.0 };
            values.push(ramp + edge + grain * 0.2);
        }
    }
    values
}

fn disagreement(whole: &[f32], banded: &[f32]) -> Option<(usize, f32, f32)> {
    whole
        .iter()
        .zip(banded)
        .position(|(a, b)| a != b)
        .map(|at| (at, whole[at], banded[at]))
}

#[test]
fn a_band_of_the_shrinkage_is_the_frame_shrunk_whole() {
    let Some(harness) = Harness::open("the banded shrinkage") else { return };
    let body = read_wgsl("pass12.wgsl");
    let input = harness.plane(&textured(11));
    let npix = (WIDTH * HEIGHT) as usize;
    let across = WIDTH.div_ceil(PASS12_TILE);
    let tile_rows = HEIGHT / PASS12_TILE;
    let band_tiles = BAND_ROWS / PASS12_TILE;
    // Strong enough that the threshold actually bites; a sigma that shrank nothing would compare
    // two copies of the input.
    let sigma = 0.35f32.to_bits();

    let whole_out = harness.plane(&vec![0.0; npix]);
    harness.run(
        "pass12",
        &body,
        &[(0, true, &input), (1, false, &whole_out)],
        &[(&harness.push(&[WIDTH, HEIGHT, sigma, 0]), across, tile_rows)],
    );

    let banded_out = harness.plane(&vec![0.0; npix]);
    let pushes: Vec<wgpu::Buffer> = (0..HEIGHT / BAND_ROWS)
        .map(|band| harness.push(&[WIDTH, HEIGHT, sigma, band * band_tiles]))
        .collect();
    let dispatches: Vec<_> = pushes.iter().map(|push| (push, across, band_tiles)).collect();
    harness.run("pass12", &body, &[(0, true, &input), (1, false, &banded_out)], &dispatches);

    let whole = harness.read(&whole_out, npix);
    let banded = harness.read(&banded_out, npix);
    assert!(whole.iter().any(|v| *v != 0.0), "the shrinkage wrote nothing to compare");
    if let Some((at, a, b)) = disagreement(&whole, &banded) {
        panic!(
            "row {} column {} shrank to {b} in a band and {a} in the whole frame; \
             `tile_y0` counts tiles so that cannot happen unless the grid moved",
            at / WIDTH as usize,
            at % WIDTH as usize,
        );
    }
}

#[test]
fn a_band_of_the_regression_is_the_frame_regressed_whole() {
    let Some(harness) = Harness::open("the banded chroma regression") else { return };
    let body = read_wgsl("yuv_loess.wgsl");
    let npix = (WIDTH * HEIGHT) as usize;
    let guide = harness.plane(&textured(3));
    let cb_in = harness.plane(&textured(29));
    let cr_in = harness.plane(&textured(71));
    let across = WIDTH.div_ceil(LOESS_GROUP);
    let strength = 1.0f32.to_bits();
    let blend = 1.0f32.to_bits();
    let scalars = |y0: u32| [WIDTH, HEIGHT, strength, blend, LOESS_RADIUS as u32, y0];

    let whole_cb = harness.plane(&vec![0.0; npix]);
    let whole_cr = harness.plane(&vec![0.0; npix]);
    harness.run(
        "yuv_loess",
        &body,
        &[
            (0, true, &guide),
            (1, true, &cb_in),
            (2, true, &cr_in),
            (3, false, &whole_cb),
            (4, false, &whole_cr),
        ],
        &[(&harness.push(&scalars(0)), across, HEIGHT.div_ceil(LOESS_GROUP))],
    );

    let banded_cb = harness.plane(&vec![0.0; npix]);
    let banded_cr = harness.plane(&vec![0.0; npix]);
    let pushes: Vec<wgpu::Buffer> =
        (0..HEIGHT / BAND_ROWS).map(|band| harness.push(&scalars(band * BAND_ROWS))).collect();
    let dispatches: Vec<_> =
        pushes.iter().map(|push| (push, across, BAND_ROWS / LOESS_GROUP)).collect();
    harness.run(
        "yuv_loess",
        &body,
        &[
            (0, true, &guide),
            (1, true, &cb_in),
            (2, true, &cr_in),
            (3, false, &banded_cb),
            (4, false, &banded_cr),
        ],
        &dispatches,
    );

    for (channel, whole_plane, banded_plane) in
        [("Cb", &whole_cb, &banded_cb), ("Cr", &whole_cr, &banded_cr)]
    {
        let whole = harness.read(whole_plane, npix);
        let banded = harness.read(banded_plane, npix);
        assert!(whole.iter().any(|v| *v != 0.0), "the regression wrote no {channel} to compare");
        if let Some((at, a, b)) = disagreement(&whole, &banded) {
            panic!(
                "{channel} at row {} column {} regressed to {b} in a band and {a} in the whole \
                 frame; the window reaches seven rows either side, so a band that only saw its \
                 own rows would differ exactly here",
                at / WIDTH as usize,
                at % WIDTH as usize,
            );
        }
    }
}
