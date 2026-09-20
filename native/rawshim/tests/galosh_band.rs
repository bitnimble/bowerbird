//! A band of the shrinkage against the same rows of the frame shrunk whole.
//!
//! The editor re-prepares a Detail change a strip at a time, and the strips are only allowed to
//! land final if a band's answer *is* the whole frame's answer over those rows.
//! `a_band_of_a_held_mosaic_is_the_frame_it_was_cut_from` asks that of the whole chain, on a real
//! RAW; this asks it of the one kernel where it is a claim rather than an identity, on a synthetic
//! frame, so a failure says which kernel rather than only that something moved.
//!
//! `pass12` shrinks over a tile grid, so it reads outside the rows it writes. The per-pixel
//! kernels take a `start` and touch nothing else.
//!
//! **This is the failure `decode_rawler`'s tiled denoise carried for months.** A region whose
//! origin was off `pass12`'s grid shrank every pixel in it against a neighbourhood the whole-frame
//! answer never used - 94% of a 61MP frame's samples differed, spread rather than banded at the
//! seams, so it did not look like a tiling bug. Exact equality is the assertion because the two
//! runs do identical arithmetic in an identical order: anything but exact means the grid moved.

/// A whole number of `pass12` tiles, which is what a band has to be for its grid to stay put.
const BAND_ROWS: u32 = 112;
const WIDTH: u32 = 128;
const HEIGHT: u32 = BAND_ROWS * 2;
const PASS12_TILE: u32 = 28;

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
        let limits = gpu.describing().limits();
        if limits.max_compute_workgroup_storage_size < 26_240 {
            eprintln!(
                "SKIPPED: this adapter has no room for pass12's tile, so {what} was not run."
            );
            return None;
        }
        Some(Harness { gpu })
    }

    fn plane(&self, values: &[f32]) -> rawshim::gpu::Buffer {
        let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        self.gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: &bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        })
    }

    fn push(&self, words: &[u32]) -> rawshim::gpu::Buffer {
        let mut bytes: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
        // std140 rounds a block out to a multiple of 16, so a `Push` of five words is a binding of
        // thirty-two bytes. Padded here rather than at each call site: sized to the words given, a
        // field added to any of these structs fails every test at once with a binding-size error
        // that names neither the struct nor the field.
        bytes.resize(bytes.len().next_multiple_of(16), 0);
        self.gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
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
        buffers: &[(u32, bool, &rawshim::gpu::Buffer)],
        dispatches: &[(&rawshim::gpu::Buffer, u32, u32)],
    ) {
        let device = self.gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(name),
            source: wgpu::ShaderSource::Wgsl(body.into()),
        });
        let mut entries: Vec<_> = buffers
            .iter()
            .map(|(binding, read_only, _)| wgpu::BindGroupLayoutEntry {
                binding: *binding,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage {
                        read_only: *read_only,
                    },
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

        let mut recording = self.gpu.record();
        for (push, x, y) in dispatches {
            let mut bound: Vec<_> = buffers
                .iter()
                .map(|(binding, _, buffer)| wgpu::BindGroupEntry {
                    binding: *binding,
                    resource: buffer.as_entire_binding(),
                })
                .collect();
            bound.push(wgpu::BindGroupEntry {
                binding: 20,
                resource: push.as_entire_binding(),
            });
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(name),
                layout: &layout,
                entries: &bound,
            });
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(*x, *y, 1);
        }
        recording.submit();
    }

    fn read(&self, plane: &rawshim::gpu::Buffer, len: usize) -> Vec<f32> {
        let mut recording = self.gpu.record();
        let readback = recording.buffer(&wgpu::BufferDescriptor {
            label: None,
            size: (len * 4) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        recording
            .encoder()
            .copy_buffer_to_buffer(plane, 0, &readback, 0, (len * 4) as u64);
        recording.submit();
        pollster::block_on(rawshim::gpu::read_back(self.gpu, &readback, |mapped| {
            mapped
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect()
        }))
        .expect("the readback mapped")
    }
}

/// The kernels as the crate was built with them, from where `build.rs` gathered them.
fn read_wgsl(name: &str) -> String {
    let path = std::path::Path::new(env!("OUT_DIR"))
        .join("wgsl/galosh")
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
    let Some(harness) = Harness::open("the banded shrinkage") else {
        return;
    };
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
    let pushes: Vec<rawshim::gpu::Buffer> = (0..HEIGHT / BAND_ROWS)
        .map(|band| harness.push(&[WIDTH, HEIGHT, sigma, band * band_tiles]))
        .collect();
    let dispatches: Vec<(&rawshim::gpu::Buffer, u32, u32)> = pushes
        .iter()
        .map(|push| (push, across, band_tiles))
        .collect();
    harness.run(
        "pass12",
        &body,
        &[(0, true, &input), (1, false, &banded_out)],
        &dispatches,
    );

    let whole = harness.read(&whole_out, npix);
    let banded = harness.read(&banded_out, npix);
    assert!(
        whole.iter().any(|v| *v != 0.0),
        "the shrinkage wrote nothing to compare"
    );
    if let Some((at, a, b)) = disagreement(&whole, &banded) {
        panic!(
            "row {} column {} shrank to {b} in a band and {a} in the whole frame; \
             `tile_y0` counts tiles so that cannot happen unless the grid moved",
            at / WIDTH as usize,
            at % WIDTH as usize,
        );
    }
}

/// A frame of one value, which the shrinkage has to hand back.
///
/// **This is the cheapest thing that can tell a miscompiled transform from a working one, and it
/// needs no reference to compare against.** A constant block's AC coefficients are all zero, so
/// pass 1's threshold removes nothing and pass 2's Wiener gains multiply nothing: whatever sigma
/// says, both passes reconstruct the block they were given. Metal got this wrong by returning a
/// stale tail from `wht2d` when its call sites shared one copy of the function, and a frame at 41
/// came back at 0.64. It passes on any device where the transform is compiled correctly, which is
/// what makes it worth running everywhere rather than only where it once failed.
#[test]
fn a_frame_of_one_value_survives_the_shrinkage() {
    let Some(harness) = Harness::open("the constant frame") else {
        return;
    };
    let body = read_wgsl("pass12.wgsl");
    let npix = (WIDTH * HEIGHT) as usize;
    let level = 41.0f32;
    let input = harness.plane(&vec![level; npix]);
    let output = harness.plane(&vec![0.0; npix]);
    let across = WIDTH.div_ceil(PASS12_TILE);
    let tile_rows = HEIGHT / PASS12_TILE;

    harness.run(
        "pass12",
        &body,
        &[(0, true, &input), (1, false, &output)],
        &[(
            &harness.push(&[WIDTH, HEIGHT, 1.7f32.to_bits(), 0]),
            across,
            tile_rows,
        )],
    );

    let got = harness.read(&output, npix);
    // Sixteen overlapping estimates are averaged into each pixel, so the last bits move; a
    // transform that dropped its tail is out by whole multiples of the value, not by ulps.
    if let Some((at, v)) = got
        .iter()
        .enumerate()
        .find(|(_, v)| (**v - level).abs() > 1e-3)
    {
        panic!(
            "row {} column {} came back {v} from a frame that was {level} everywhere; \
             a constant block has nothing to shrink, so both passes must return it",
            at / WIDTH as usize,
            at % WIDTH as usize,
        );
    }
}

/// At zero luma the shrinkage hands back the frame it was given, on a frame with structure in it.
///
/// **What lets the host skip the dispatch.** The reader's Detail pair is two sliders and
/// `Amounts::does_anything` is an *or*, so denoising colour alone runs this kernel at
/// `sigma_strength` zero over the whole frame - the single most expensive pass in the pipeline,
/// computing the frame it was handed. `galosh::run` copies instead, and this is the claim that
/// makes the copy the same picture rather than merely a faster one.
///
/// The arithmetic: sigma zero puts `lambda` at zero, so pass 1's threshold keeps every
/// coefficient and the pilot is the input; pass 2's Wiener gain is then `s2 / s2`, one wherever
/// the pilot is non-zero, and `WIENER_FLOOR` only reaches coefficients whose pilot is exactly
/// zero - where the noisy coefficient is that same zero and the floor multiplies nothing. Both
/// passes reconstruct their block, and averaging sixteen copies of one estimate returns it.
///
/// Not exact, and the tolerance says by how much. A block whose AC magnitudes fall under
/// `mad_sigma_y_sq`'s own `1e-10` guard takes the `lambda = 1e30` arm and has its AC zeroed - a
/// deviation bounded by that guard, far under a count of 65535 once the inverse GAT and the
/// quantisation have run - and the overlap average divides two sums that are equal only in exact
/// arithmetic.
#[test]
fn at_zero_luma_the_shrinkage_returns_the_frame() {
    let Some(harness) = Harness::open("the zero-luma shrinkage") else {
        return;
    };
    let body = read_wgsl("pass12.wgsl");
    let npix = (WIDTH * HEIGHT) as usize;
    let frame = textured(23);
    let input = harness.plane(&frame);
    let output = harness.plane(&vec![0.0; npix]);

    harness.run(
        "pass12",
        &body,
        &[(0, true, &input), (1, false, &output)],
        &[(
            &harness.push(&[WIDTH, HEIGHT, 0f32.to_bits(), 0]),
            WIDTH.div_ceil(PASS12_TILE),
            HEIGHT / PASS12_TILE,
        )],
    );

    let got = harness.read(&output, npix);
    let worst = got
        .iter()
        .zip(&frame)
        .map(|(a, b)| (a - b).abs())
        .fold(0f32, f32::max);
    assert!(
        worst < 1e-5,
        "zero luma moved a sample by {worst}, so the copy is not the dispatch"
    );
}

/// At zero colour the blend hands back its first anchor, which is what lets the LOESS be skipped.
///
/// **`galosh::run` binds `c_h` straight into the inverse at zero rather than running the
/// regression and the blend over it**, on the strength of this identity - the half-resolution
/// LOESS is a fifth of the denoise, 89ms of 396 on a 24MP mosaic, and at zero every value it
/// computes is overwritten. If this stops holding, a reader with Colour at zero gets an
/// *un-extracted* chroma plane through the inverse, which is a colour cast rather than a
/// missing denoise, and nothing else in the suite is looking at that corner.
///
/// The arithmetic the two kernels make non-obvious: at `slider <= 0` the blend takes `blended = a`,
/// so the smoothed green difference `weigh_green_difference` reads equals the raw one and the
/// `real` lerp between them is that value whatever the weight. `sum` is then `a.x + a.y` and the two writes are `0.5(sum ± (a.x - a.y))`,
/// which is `a.x` and `a.y`. So it is an identity in exact arithmetic rather than approximately,
/// and the tolerance below is float addition's, not the algorithm's.
#[test]
fn at_zero_colour_the_blend_returns_the_chroma_it_was_handed() {
    let Some(harness) = Harness::open("the zero-colour blend") else {
        return;
    };
    let npix = (WIDTH * HEIGHT) as usize;

    // Three planes that disagree, so a blend reaching for the wrong anchor cannot look like this
    // one: the LOESS and the eighth's arm are the first negated and trebled.
    let anchor: [Vec<f32>; 3] = [textured(11), textured(12), textured(13)];
    let loess: [Vec<f32>; 3] = std::array::from_fn(|c| anchor[c].iter().map(|v| -v).collect());
    let eighth: [Vec<f32>; 3] =
        std::array::from_fn(|c| anchor[c].iter().map(|v| v * 3.0).collect());

    let a: [rawshim::gpu::Buffer; 3] = std::array::from_fn(|c| harness.plane(&anchor[c]));
    let b: [rawshim::gpu::Buffer; 3] = std::array::from_fn(|c| harness.plane(&loess[c]));
    let e: [rawshim::gpu::Buffer; 3] = std::array::from_fn(|c| harness.plane(&eighth[c]));

    // Below one the near anchor is the chroma itself, as `galosh::run` binds it.
    let bindings: Vec<(u32, bool, &rawshim::gpu::Buffer)> = (0..3)
        .map(|c| (c as u32, true, &a[c]))
        // The LOESS trio is where the kernel writes, so it is the one bound writable.
        .chain((0..3).map(|c| (3 + c as u32, false, &b[c])))
        .chain((0..3).map(|c| (6 + c as u32, true, &e[c])))
        .collect();
    let push = harness.push(&[WIDTH, HEIGHT, 0f32.to_bits(), 1.5f32.to_bits()]);
    let groups = (WIDTH.div_ceil(16), HEIGHT.div_ceil(16));

    harness.run(
        "smoothstep_blend_3p",
        &read_wgsl("smoothstep_blend_3p.wgsl"),
        &bindings,
        &[(&push, groups.0, groups.1)],
    );
    // And the green difference weighed after it, as a Bayer mosaic has it.
    harness.run(
        "weigh_green_difference",
        &read_wgsl("weigh_green_difference.wgsl"),
        &[
            (0, true, &a[0]),
            (1, true, &a[1]),
            (3, false, &b[0]),
            (4, false, &b[1]),
        ],
        &[(&push, groups.0, groups.1)],
    );

    for c in 0..3 {
        let got = harness.read(&b[c], npix);
        let worst = got
            .iter()
            .zip(&anchor[c])
            .map(|(a, b)| (a - b).abs())
            .fold(0f32, f32::max);
        assert!(
            worst < 1e-5,
            "zero colour moved plane {c} by {worst}, so skipping the LOESS is not the dispatch"
        );
    }
}
