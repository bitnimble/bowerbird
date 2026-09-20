//! The editor's peak measurement, run on the histograms that break it.
//!
//! `gpu_fixture.rs` pins the bytes this host produces, over a whole frame. What it cannot single
//! out is one kernel's arithmetic on an input a frame never hands it, which this asks about in
//! one dispatch rather than through a rendered picture.
//!
//! So the shaders are compiled and run here, from the same files the app imports. What stays in
//! Playwright is the TypeScript that wires them up - the payload deinterleave, the bind groups,
//! the passes - which is a different failure and needs the real pipeline to say anything about.
//!
//! Skipped where no Vulkan adapter answers, loudly rather than silently: a test that quietly
//! passes because it never ran is not a test.

use rawshim::hdr_fit::{ChromaMap, HdrColour, TRUST_CEILING};

/// The shaders as the crate was built with them, from where `build.rs` gathered them.
///
/// Read rather than vendored, so a change to the shader is a change to this test. A copy
/// would pass forever against whatever it was copied from.
fn read_wgsl(name: &str) -> String {
    let path = std::path::Path::new(env!("OUT_DIR")).join("wgsl").join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// A colour model with every stage off its identity, for a uniform shaped like a real match's.
fn model() -> HdrColour {
    let mut colour = HdrColour::identity();
    for (channel, curve) in colour.curves.iter_mut().enumerate() {
        let gain = 1.0 + 0.06 * (channel as f64 - 1.0);
        let bend = 2.2 + 0.4 * channel as f64;
        let last = (curve.len() - 1) as f64;
        let full = 1.0 - (-bend).exp();
        for (bin, value) in curve.iter_mut().enumerate() {
            let x = bin as f64 / last;
            *value = TRUST_CEILING * gain * (1.0 - (-bend * x).exp()) / full;
        }
    }
    colour.anchor = TRUST_CEILING * 0.4;
    colour.matrix = [[1.25, -0.2, -0.05], [-0.35, 1.5, -0.15], [0.02, -0.25, 1.23]];
    colour.saturation = 1.08;
    colour.chroma = Some(ChromaMap::from_nodes(|x, y, z| {
        let scale = 1.04 + 0.03 * x as f64 - 0.02 * y as f64 + 0.05 * z as f64;
        let skew = 0.02 * (x as f64 - y as f64);
        let lift = 1.0 + 0.015 * (x as f64 - 2.0) - 0.01 * (y as f64 - 2.0) + 0.004 * z as f64;
        [scale, skew, -skew, scale * 0.98, 0.004 * (x as f64 - 2.0), -0.003 * (y as f64 - 2.0), lift,
         0.05 * (x as f64 - 2.0), -0.04 * (y as f64 - 2.0)]
    }));
    colour
}

/// `struct Edit`, field for field, in the order the shader declares them.
///
/// Written here rather than taken from `gpu::Grade` because `peak_samples` is what the scan is
/// asked against, and a grade derives it from the frame rather than taking it.
fn uniform(colour: &HdrColour, peak_samples: u32, surround: f32) -> Vec<u8> {
    let shape = colour.chroma.as_ref().map(|m| m.shape());
    let shape = shape.as_ref();
    let mut words: Vec<u32> = Vec::new();
    // Written as a flat list of words so the order is checkable against the struct rather
    // than hidden behind a builder.
    words.push(PROBE_WIDTH);
    words.push(1); // height
    f_push(&mut words, 1.0); // white: the probe feeds scene levels directly
    f_push(&mut words, 1.0); // source_level
    f_push(&mut words, 1.0); // reference: nits per unit, so the peak comes back in units of it
    f_push(&mut words, 1.0); // peak
    f_push(&mut words, 0.0); // exposure, in stops: none of it, so the probe sees the base curve
    words.push(0); // pad0
    words.push(1); // matched
    f_push(&mut words, colour.saturation as f32);
    words.push(u32::from(colour.chroma.is_some()));
    words.push(colour.curves[0].len() as u32);
    f_push(&mut words, colour.ceiling as f32);
    words.push(shape.map_or(2, |s| s.chroma_count as u32));
    words.push(shape.map_or(2, |s| s.level_count as u32));
    f_push(&mut words, shape.map_or(0.0, |s| s.chroma_low[0] as f32));
    f_push(&mut words, shape.map_or(1.0, |s| s.chroma_scale[0] as f32));
    f_push(&mut words, shape.map_or(0.0, |s| s.chroma_low[1] as f32));
    f_push(&mut words, shape.map_or(1.0, |s| s.chroma_scale[1] as f32));
    f_push(&mut words, shape.map_or(1.0, |s| s.level_scale as f32));
    f_push(&mut words, 203.0); // sdr_white
    words.push(1); // row_stride
    words.push(peak_samples);
    // WGSL puts a `vec2f` on a multiple of eight, and the scalars above end on 84. The
    // struct does not name this word - `pad0` earlier is a different one, named because it
    // is reusable - so it has to be written here or every field after it lands short.
    words.push(0);
    for _ in 0..6 {
        f_push(&mut words, 0.0); // region_origin, region_size, canvas_size
    }
    words.push(0); // max_lod
    words.push(0); // pad
    // The reader's sliders, all zero. The last four are the white balance pair and the
    // illuminant it moves from; zero there is "as shot", which is the same statement.
    for _ in 0..14 {
        f_push(&mut words, 0.0);
    }
    // `balance_set`: neither half of the pair is set, so the shader reads the frame's own
    // illuminant - which is zero here, and it leaves the balance alone. Written rather than
    // left to the padding below, which happens to be zero today and is not a promise.
    words.push(0);
    // The geometry, at its identity: `geometry_at` returns its argument untouched on these.
    for value in [0.0, 0.0, 1.0, 1.0, 0.0] {
        f_push(&mut words, value);
    }
    words.push(0); // rotate
    words.push(PROBE_WIDTH); // output_width
    words.push(1); // output_height
    // The keystone, also at its identity, and `has_keystone` clear so nothing reads the eight.
    for _ in 0..8 {
        f_push(&mut words, 0.0);
    }
    words.push(0); // has_keystone
    // The blur's working texture, which nothing here builds: one texel per pixel and a
    // window of one, so `detail.slang` would be an identity if anything read it.
    words.push(1); // detail_long
    words.push(1); // detail_step
    // The photograph is this frame and the frame starts at its origin, which is what every caller
    // holding a whole picture says. A window is a render whose crop let it decode less, and there
    // is no crop here.
    words.push(PROBE_WIDTH); // photo_width
    words.push(1); // photo_height
    words.push(0); // window_left
    words.push(0); // window_top
    words.push(shape.map_or(2, |s| s.surround_count as u32));
    f_push(&mut words, shape.map_or(1.0, |s| s.surround_scale as f32));
    words.push(u32::from(surround != 0.0)); // has_surround
    words.push(0); // surround_left
    words.push(0); // surround_top
    words.push(1); // surround_photo_width
    words.push(1); // surround_photo_height
    words.push(0); // has_mean
    words.push(1); // mean_block: unread with the mean off, and never zero
    words.push(0); // has_smoothed
    words.push(1); // chroma_shrink: unread with the smoothing off, and never zero
    f_push(&mut words, colour.anchor as f32);
    // WGSL binds a uniform struct at its size rounded up to 16 bytes, so a buffer holding
    // exactly the fields is rejected as too small. Same rule as `gpu::uniform`.
    while words.len() % 4 != 0 {
        words.push(0);
    }
    words.iter().flat_map(|w| w.to_le_bytes()).collect()
}

const PROBE_WIDTH: u32 = 1;

fn f_push(words: &mut Vec<u32>, v: f32) {
    words.push(v.to_bits());
}

/// `peak.slang`'s own constants, which the shader folds in for Safari's sake.
const PEAK_BINS: u32 = 8192;
const LOG_LOW: f32 = -14.0;
const LOG_SPAN: f32 = 28.0;

/// The value a bin stands for, in units of reference white - `bin_centre`, said here.
fn bin_centre(bin: u32) -> f32 {
    (LOG_LOW + ((bin as f32 + 0.5) / PEAK_BINS as f32) * LOG_SPAN).exp2()
}

/// The scan that turns the histogram into the scene peak, run on the histograms that break it.
///
/// The peak is an *input* to the grade and everything is clamped to it, so a scan that answers
/// too low does not shade the picture differently - it flattens the whole frame onto that
/// value. The floor is one nit, which against 203-nit white is a black rectangle with the
/// shape of a photograph faintly in it.
///
/// The case that reaches it is a histogram holding fewer samples than the rank being asked
/// for, which is what the editor's candidates are: they are counted against the frame's
/// `peak_samples` while holding only the brightest few thousand pixels of it. Neither of the
/// scan's two loops could reach an unreachable rank, so both fell through with the bin at
/// zero. Here as WGSL against a hand-built histogram because that is what it is - no frame,
/// no decode and no browser can say anything about a scan over 8192 counts.
#[test]
fn the_peak_scan_answers_a_sample_shorter_than_its_rank() {
    let Some(shipped) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the peak's scan was not run.");
        return;
    };
    let device = shipped.describing();

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("peak"),
        source: wgpu::ShaderSource::Wgsl(read_wgsl("peak.wgsl").into()),
    });
    // Derived from what `quantile` actually reads, which is the histogram, the peak, the
    // candidates and the uniform. An explicit layout would have to name every binding the
    // module declares, and the colour transform's textures are nothing to do with this.
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("quantile"),
        layout: None,
        module: &module,
        entry_point: Some("quantile"),
        compilation_options: Default::default(),
        cache: None,
    });
    let layout = pipeline.get_bind_group_layout(0);

    // Two stops above reference white, which is a highlight rather than the floor the failure
    // returns - so the two answers cannot be confused.
    let bright = ((2.0 - LOG_LOW) / LOG_SPAN * PEAK_BINS as f32) as u32;
    let dim = ((-3.0 - LOG_LOW) / LOG_SPAN * PEAK_BINS as f32) as u32;

    // `peak_samples` is the frame's, so the rank is 100 either way; what changes is how much
    // of the frame the histogram in front of the scan actually holds.
    let cases: [(&str, Vec<(u32, u32)>); 3] = [
        ("a whole frame", vec![(dim, 999_900), (bright, 100)]),
        ("candidates, and fewer of them than the rank", vec![(bright, 10)]),
        ("a single sample", vec![(bright, 1)]),
    ];

    for (name, counts) in cases {
        let mut histogram = vec![0u32; PEAK_BINS as usize];
        for (bin, count) in &counts {
            histogram[*bin as usize] = *count;
        }
        let bytes: Vec<u8> = histogram.iter().flat_map(|c| c.to_le_bytes()).collect();
        let mut recording = shipped.record();
        let mut init = |contents: &[u8], usage: wgpu::BufferUsages| {
            recording.init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents,
                usage,
            })
        };
        let histogram = init(&bytes, wgpu::BufferUsages::STORAGE);
        let peak = init(
            &[0u8; 16],
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        );
        // Non-zero, which is what a tick's is: the threshold below the peak is the open's
        // business and `quantile` skips it once anything has been collected.
        let candidates = init(&1u32.to_le_bytes(), wgpu::BufferUsages::STORAGE);
        // Reference white is 1.0 in this uniform, so the peak comes back in units of it.
        let edits =
            init(&uniform(&model(), 1_000_000, 0.0), wgpu::BufferUsages::UNIFORM);
        let readback = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: 16,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let group = shipped.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("peak"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: histogram.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: peak.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 8, resource: candidates.as_entire_binding() },
            ],
        });

        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        recording.encoder().copy_buffer_to_buffer(&peak, 0, &readback, 0, 16);
        recording.submit();

        let got = pollster::block_on(rawshim::gpu::read_back(shipped, &readback, |mapped| {
            f32::from_le_bytes([mapped[0], mapped[1], mapped[2], mapped[3]])
        }))
        .expect("the readback mapped");

        // The brightest bin holding anything, in all three: with a whole frame the rank of 100
        // lands in it, and with less than that in front of the scan it is the only answer there
        // is. A bin is 0.0034 of a stop, so this is exact to the bin.
        let want = bin_centre(bright);
        assert!(
            (got - want).abs() / want < 1e-3,
            "{name}: the scan answered {got} where the brightest bin is {want}",
        );
    }
}

/// Every value the histogram bins lands somewhere defined, on any host.
///
/// `u32(x)` is undefined in WGSL for a NaN and for anything past the type's range, and the
/// colour transform can hand `bin_of` both: a division in the tone curve, a lattice fetch at
/// an out-of-range coordinate. Undefined there is not a rounding difference - the driver may
/// put it at the top of the histogram, where it shifts the quantile, or at the bottom, where
/// it does not - and this is the one measurement a rendition and the editor have to agree on
/// to the bin, since every pixel is then clamped to what it says.
#[test]
fn the_histogram_bins_a_nan_and_an_infinity_somewhere_defined() {
    let Some(shipped) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so `bin_of` was not run.");
        return;
    };
    let device = shipped.describing();

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("peak"),
        source: wgpu::ShaderSource::Wgsl(read_wgsl("probe_bins.wgsl").into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("probe_bins"),
        layout: None,
        module: &module,
        entry_point: Some("probe_bins"),
        compilation_options: Default::default(),
        cache: None,
    });

    let fed: [f32; 4] = [f32::NAN, f32::INFINITY, 0.0, 1.0];
    let bytes: Vec<u8> = fed.iter().flat_map(|v| v.to_bits().to_le_bytes()).collect();
    let mut recording = shipped.record();
    let mut init = |contents: &[u8], usage: wgpu::BufferUsages| {
        recording.init(&wgpu::util::BufferInitDescriptor { label: None, contents, usage })
    };
    let histogram = init(&bytes, wgpu::BufferUsages::STORAGE);
    let peak = init(&[0u8; 16], wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC);
    let readback = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: 16,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    // The two `bin_of` reaches, which is all the derived layout carries: it takes no uniform
    // and touches no candidate.
    let group = shipped.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("bins"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 5, resource: histogram.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: peak.as_entire_binding() },
        ],
    });

    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    recording.encoder().copy_buffer_to_buffer(&peak, 0, &readback, 0, 16);
    recording.submit();

    let got: Vec<u32> = pollster::block_on(rawshim::gpu::read_back(shipped, &readback, |mapped| {
        mapped
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as u32)
            .collect()
    }))
    .expect("the readback mapped");

    // A NaN and a black pixel at the bottom, where they cannot lift the quantile off a frame
    // they say nothing about; an infinity at the top, which is where a value past the range
    // belongs and is the answer the clamp gives rather than the one the conversion would.
    assert_eq!(got[0], 0, "a NaN binned at {}", got[0]);
    assert_eq!(got[1], PEAK_BINS - 1, "an infinity binned at {}", got[1]);
    assert_eq!(got[2], 0, "black binned at {}", got[2]);
    // Reference white is the middle of a range that spans fourteen stops either side of it.
    assert_eq!(got[3], PEAK_BINS / 2, "reference white binned at {}", got[3]);
}
