//! The lateral aberration's walks over the render, taken where the render is.
//!
//! `slang/tca.slang` is the arithmetic over pixels. `tca.rs` keeps everything that decides: the
//! argmin of a sweep, the bins, the regression's solve and every gate that says whether a curve is
//! believed. What crosses back is two floats per sweep candidate, four per halo offset, five per
//! row of the reduce, three channel sums and the one word saying how many point sources the scan
//! found - never the picture, in either direction.

/// Stepped positions one thread of the scan walks.
///
/// Wide, because `tca_offsets` walks the blocks in one lane: at 8 a 24MP render is 1.5M blocks and
/// that walk is the stage. At 128 it is 92k blocks, which is still far more threads than the
/// device has lanes, and the scan itself does the same work either way.
const BLOCK: usize = 128;

/// Words a row of the regression reports: two cross sums, two squares, and its count.
const ROW_WORDS: usize = 5;

/// Margin the scan keeps from the frame's edge.
const MARGIN: usize = 24;

/// Where `curves` stops being the regression's gains and starts being the halo's knots.
const KNOTS_FROM: usize = 3;

/// Sweep candidates the split buffer is sized for. `nulling_scale` is the widest asker at 61.
const MAX_CANDIDATES: usize = 128;

struct Kernels {
    layout: wgpu::BindGroupLayout,
    reduce: wgpu::ComputePipeline,
    count: wgpu::ComputePipeline,
    offsets: wgpu::ComputePipeline,
    write: wgpu::ComputePipeline,
    split: wgpu::ComputePipeline,
    halo: wgpu::ComputePipeline,
    gains: wgpu::ComputePipeline,
    slopes: wgpu::ComputePipeline,
}

fn kernels(gpu: &'static crate::gpu::Gpu) -> &'static Kernels {
    static BUILT: std::sync::OnceLock<Kernels> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("tca"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/tca.wgsl")).into(),
            ),
        });
        let entry = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let read = wgpu::BufferBindingType::Storage { read_only: true };
        let write = wgpu::BufferBindingType::Storage { read_only: false };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("tca"),
            entries: &[
                entry(0, read),
                entry(1, write),
                entry(2, write),
                entry(3, write),
                entry(4, write),
                entry(5, read),
                entry(6, write),
                entry(7, read),
                entry(8, write),
                entry(20, wgpu::BufferBindingType::Uniform),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("tca"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let build = |name: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(name),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(name),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        Kernels {
            reduce: build("tca_reduce"),
            count: build("tca_count"),
            offsets: build("tca_offsets"),
            write: build("tca_write"),
            split: build("tca_split"),
            halo: build("tca_halo"),
            gains: build("tca_gains"),
            slopes: build("tca_slopes"),
            layout,
        }
    })
}

/// What one dispatch varies. Everything else in the block is a property of the frame.
struct Ask {
    candidates: usize,
    channel: usize,
    scaled: bool,
    from: f64,
    to: f64,
    band: (f64, f64),
    stride: usize,
    knots: usize,
}

impl Ask {
    /// A dispatch that varies nothing, for the passes whose answer is the frame itself.
    fn plain() -> Ask {
        Ask {
            candidates: 1,
            channel: 0,
            scaled: false,
            from: 0.0,
            to: 0.0,
            band: crate::tca::ANY_RADIUS,
            stride: 1,
            knots: 0,
        }
    }
}

/// The render where `fit_render` left it, the point sources found in it, and the reduce the
/// estimate reads.
pub struct Frame {
    gpu: &'static crate::gpu::Gpu,
    image: crate::gpu::Buffer,
    small: crate::gpu::Buffer,
    counts: crate::gpu::Buffer,
    at: crate::gpu::Buffer,
    splits: crate::gpu::Buffer,
    halos: crate::gpu::Buffer,
    rows: crate::gpu::Buffer,
    curves: crate::gpu::Buffer,
    tally: crate::gpu::Buffer,
    width: usize,
    height: usize,
    out_width: usize,
    out_height: usize,
    blocks: usize,
    /// The point sources the scan admitted, in the order a serial scan would have found them.
    pub points: usize,
}

fn held(
    gpu: &'static crate::gpu::Gpu,
    label: &str,
    words: usize,
    usage: wgpu::BufferUsages,
) -> crate::gpu::Buffer {
    gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: (words * 4).max(4) as u64,
        usage,
        mapped_at_creation: false,
    })
}

async fn read_words(
    gpu: &'static crate::gpu::Gpu,
    staging: &crate::gpu::Buffer,
) -> Option<Vec<u32>> {
    crate::gpu::read_back(gpu, staging, |mapped| {
        mapped
            .chunks_exact(4)
            .map(|word| u32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
            .collect::<Vec<u32>>()
    })
    .await
}

async fn read_floats(
    gpu: &'static crate::gpu::Gpu,
    staging: &crate::gpu::Buffer,
) -> Option<Vec<f64>> {
    crate::gpu::read_back(gpu, staging, |mapped| {
        mapped
            .chunks_exact(4)
            .map(|word| f64::from(f32::from_ne_bytes([word[0], word[1], word[2], word[3]])))
            .collect::<Vec<f64>>()
    })
    .await
}

impl Frame {
    fn scan_rows(&self) -> usize {
        self.height.saturating_sub(2 * MARGIN).div_ceil(2)
    }

    fn block(&self, ask: &Ask) -> Vec<u8> {
        let mut words = [
            (self.width as i32).to_ne_bytes(),
            (self.height as i32).to_ne_bytes(),
            (self.out_width as i32).to_ne_bytes(),
            (self.out_height as i32).to_ne_bytes(),
            (crate::tca::REDUCE as i32).to_ne_bytes(),
            (BLOCK as i32).to_ne_bytes(),
            (self.blocks as i32).to_ne_bytes(),
            (self.scan_rows() as i32).to_ne_bytes(),
            (self.points as i32).to_ne_bytes(),
            (ask.candidates as i32).to_ne_bytes(),
            (crate::tca::HALO_OFFSETS.len() as i32).to_ne_bytes(),
            (ask.channel as i32).to_ne_bytes(),
            i32::from(ask.scaled).to_ne_bytes(),
            (ask.from as f32).to_ne_bytes(),
            (ask.to as f32).to_ne_bytes(),
            crate::tca::HALO_ACROSS.to_ne_bytes(),
            (crate::tca::SCAN_FROM as f32).to_ne_bytes(),
            (ask.band.0 as f32).to_ne_bytes(),
            (ask.band.1 as f32).to_ne_bytes(),
            (crate::tca::MIN_EDGE as f32).to_ne_bytes(),
            (ask.stride as i32).to_ne_bytes(),
            (ask.knots as i32).to_ne_bytes(),
            (crate::image::SPLINE_UNIT as f32).to_ne_bytes(),
        ]
        .concat();
        // Twenty-three fields is ninety-two bytes, and a uniform block is rounded up to sixteen.
        words.resize(96, 0);
        words
    }

    fn group(&self, push: &crate::gpu::Buffer) -> wgpu::BindGroup {
        self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("tca"),
            layout: &kernels(self.gpu).layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.image.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.small.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: self.counts.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: self.at.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: self.splits.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: self.halos.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: self.rows.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 7, resource: self.curves.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 8, resource: self.tally.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
            ],
        })
    }

    /// One dispatch of `pipeline` under `ask`, with `words` of `splits` read back.
    async fn asked(
        &self,
        pipeline: &wgpu::ComputePipeline,
        ask: &Ask,
        threads: usize,
        words: usize,
    ) -> Option<Vec<f64>> {
        let mut recording = self.gpu.record();
        let push = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("tca push"),
            contents: &self.block(ask),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &self.group(&push), &[]);
            pass.dispatch_workgroups((threads as u32).div_ceil(64).max(1), 1, 1);
        }
        let out = held(
            self.gpu,
            "tca splits out",
            words,
            wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        );
        recording.encoder().copy_buffer_to_buffer(&self.splits, 0, &out, 0, (words * 4) as u64);
        recording.submit();
        read_floats(self.gpu, &out).await
    }

    /// Every candidate of a sweep at every halo offset, in one dispatch.
    ///
    /// The answer per candidate is what `sweep` scores it on: the split's magnitude summed over
    /// both reaches, or `None` where a reach saw too few points to be believed. A shift large
    /// enough to push a channel out of the near window still has to answer for the far one, so
    /// nulling by evacuation scores no better than nulling by registering.
    pub(crate) async fn swept(
        &self,
        slot: usize,
        scaled: bool,
        from: f64,
        to: f64,
        steps: usize,
        band: (f64, f64),
    ) -> Option<Vec<Option<f64>>> {
        let offsets = crate::tca::HALO_OFFSETS.len();
        let candidates = steps + 1;
        assert!(candidates <= MAX_CANDIDATES, "{candidates} sweep candidates at once");
        let ask = Ask {
            candidates,
            channel: match slot {
                0 => 0,
                _ => 2,
            },
            scaled,
            from,
            to,
            band,
            ..Ask::plain()
        };
        let read = self
            .asked(&kernels(self.gpu).split, &ask, candidates * offsets, candidates * offsets * 2)
            .await?;
        Some(
            (0..candidates)
                .map(|c| {
                    let mut total = 0.0;
                    let mut any = false;
                    for o in 0..offsets {
                        let at = (c * offsets + o) * 2;
                        if read[at + 1] as usize >= crate::tca::MIN_PER_BIN {
                            total += (read[at] / read[at + 1]).abs();
                            any = true;
                        }
                    }
                    any.then_some(total)
                })
                .collect(),
        )
    }

    /// The split around every point at each halo offset, with each channel read through `curve` -
    /// or through nothing, which reads the frame as it stands.
    pub(crate) async fn haloed(
        &self,
        curve: Option<&[Vec<f64>; 2]>,
        band: (f64, f64),
    ) -> Option<Vec<Option<[f64; 2]>>> {
        let knots = curve.map_or(0, |curve| curve[0].len().max(curve[1].len()));
        if let Some(curve) = curve {
            // Both channels' knots at one width, so the shader indexes them by slot. A curve
            // shorter than its neighbour is held flat past its own last knot, which is what
            // `spline_at` does with it anyway.
            let mut words: Vec<u8> = Vec::new();
            for slot in 0..2 {
                for k in 0..knots {
                    let at = curve[slot].get(k.min(curve[slot].len().saturating_sub(1)));
                    words.extend((at.copied().unwrap_or(0.0) as f32).to_ne_bytes());
                }
            }
            self.gpu.queue.write_buffer(&self.curves, (KNOTS_FROM * 4) as u64, &words);
        }
        let offsets = crate::tca::HALO_OFFSETS.len();
        let ask = Ask { knots, band, ..Ask::plain() };
        let read = self.asked(&kernels(self.gpu).halo, &ask, offsets, offsets * 4).await?;
        Some(
            (0..offsets)
                .map(|o| {
                    let counted = read[o * 4 + 2];
                    (counted as usize >= crate::tca::MIN_POINTS)
                        .then(|| [read[o * 4] / counted, read[o * 4 + 1] / counted])
                })
                .collect(),
        )
    }

    /// The projected-gradient sums of the reduce, a row at a time, folded in row order.
    pub(crate) async fn slopes(&self, gains: [f64; 3], stride: usize) -> Option<(f64, f64, u64)> {
        let words: Vec<u8> = gains.iter().flat_map(|v| (*v as f32).to_ne_bytes()).collect();
        self.gpu.queue.write_buffer(&self.curves, 0, &words);
        let ask = Ask { stride, ..Ask::plain() };
        let walked = self.out_height.saturating_sub(2);

        let mut recording = self.gpu.record();
        let push = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("tca push"),
            contents: &self.block(&ask),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernels(self.gpu).slopes);
            pass.set_bind_group(0, &self.group(&push), &[]);
            pass.dispatch_workgroups((walked as u32).div_ceil(64).max(1), 1, 1);
        }
        let count = walked.max(1) * ROW_WORDS;
        let out = held(
            self.gpu,
            "tca rows out",
            count,
            wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        );
        recording.encoder().copy_buffer_to_buffer(&self.rows, 0, &out, 0, (count * 4) as u64);
        recording.submit();
        let read = read_floats(self.gpu, &out).await?;

        let (mut cross, mut square) = ([0.0f64; 2], [0.0f64; 2]);
        let mut counted = 0u64;
        for row in read.chunks_exact(ROW_WORDS).take(walked) {
            for s in 0..2 {
                cross[s] += row[s];
                square[s] += row[2 + s];
            }
            counted += row[4] as u64;
        }
        // A frame with no gradient anywhere has no slope to answer rather than a failure that
        // would take the other channel down with it.
        let strength = |s: usize| match square[s] > 0.0 {
            true => cross[s] / square[s],
            false => 0.0,
        };
        Some((strength(0), strength(1), counted))
    }

    /// The gain each channel is matched against green with, over every ninety-seventh pixel of
    /// the reduce.
    pub(crate) async fn gains(&self) -> Option<[f64; 3]> {
        let sampled = (self.out_width * self.out_height).div_ceil(97);
        let mut recording = self.gpu.record();
        let push = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("tca push"),
            contents: &self.block(&Ask::plain()),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        recording.encoder().clear_buffer(&self.tally, 0, None);
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernels(self.gpu).gains);
            pass.set_bind_group(0, &self.group(&push), &[]);
            pass.dispatch_workgroups((sampled as u32).div_ceil(64).max(1), 1, 1);
        }
        let out = held(
            self.gpu,
            "tca tally out",
            3,
            wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        );
        recording.encoder().copy_buffer_to_buffer(&self.tally, 0, &out, 0, 12);
        recording.submit();
        let read = read_words(self.gpu, &out).await?;
        let sums = [f64::from(read[0]), f64::from(read[1]), f64::from(read[2])];
        Some([
            if sums[0] > 0.0 { sums[1] / sums[0] } else { 1.0 },
            1.0,
            if sums[2] > 0.0 { sums[1] / sums[2] } else { 1.0 },
        ])
    }

    pub(crate) fn reduced_size(&self) -> (usize, usize) {
        (self.out_width, self.out_height)
    }

    /// The frame's half-diagonal, which every radius the measurement talks in is a fraction of.
    pub(crate) fn half(&self) -> f64 {
        let (cx, cy) = (self.width as f64 / 2.0, self.height as f64 / 2.0);
        (cx * cx + cy * cy).sqrt().max(1.0)
    }
}

/// The render bound where it is, reduced, and scanned for the point sources every split reads.
///
/// One scan, at the innermost radius any caller wants, and each split then names the band of radii
/// it reads. Scanning per caller would be the same walk twice over the same picture, since the
/// only thing a scan's floor changes is which points it admits.
pub(crate) async fn frame(
    gpu: &'static crate::gpu::Gpu,
    render: &crate::fit_source::Rendered,
) -> Option<Frame> {
    let (width, height) = (render.width, render.height);
    let reduce = crate::tca::REDUCE;
    let (out_width, out_height) = (width / reduce, height / reduce);
    let storage = wgpu::BufferUsages::STORAGE;
    let readable = storage | wgpu::BufferUsages::COPY_SRC;

    let rows = height.saturating_sub(2 * MARGIN).div_ceil(2);
    let columns = width.saturating_sub(2 * MARGIN);
    let blocks = (rows * columns).div_ceil(BLOCK).max(1);
    let offsets = crate::tca::HALO_OFFSETS.len();

    let mut frame = Frame {
        gpu,
        image: render.buffer.clone(),
        small: held(gpu, "tca reduce", (out_width * out_height * 3).max(1), storage),
        counts: held(gpu, "tca counts", blocks + 1, readable),
        // Replaced once the count is known. Sized for every scanned position instead, a 24MP
        // render would ask for 94MB to hold a list that is thousands long.
        at: held(gpu, "tca points", 1, storage),
        splits: held(gpu, "tca splits", MAX_CANDIDATES * offsets * 4, readable),
        halos: gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("tca halos"),
            contents: &crate::tca::HALO_OFFSETS
                .iter()
                .flat_map(|v| (*v as f32).to_ne_bytes())
                .collect::<Vec<u8>>(),
            usage: storage,
        }),
        rows: held(gpu, "tca rows", out_height.max(1) * ROW_WORDS, readable),
        // The gains, then room for both channels' knots at whatever width a curve arrives in.
        curves: held(
            gpu,
            "tca curves",
            KNOTS_FROM + 2 * 64,
            storage | wgpu::BufferUsages::COPY_DST,
        ),
        tally: held(gpu, "tca tally", 3, readable | wgpu::BufferUsages::COPY_DST),
        width,
        height,
        out_width,
        out_height,
        blocks,
        points: 0,
    };

    let ask = Ask::plain();
    let mut recording = gpu.record();
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("tca push"),
        contents: &frame.block(&ask),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let group = frame.group(&push);
    let built = kernels(gpu);
    if out_width > 0 && out_height > 0 {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&built.reduce);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(
            (out_width as u32).div_ceil(16),
            (out_height as u32).div_ceil(16),
            1,
        );
    }
    // A pass each: the scan reads what the count wrote.
    let over_blocks = (blocks as u32).div_ceil(64);
    for (pipeline, groups) in [(&built.count, over_blocks), (&built.offsets, 1)] {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(groups, 1, 1);
    }
    // The total alone, which is the only word of the counts the host wants: the offsets are read
    // by `tca_write` where they are, and the buffer is a word a block.
    let out = held(gpu, "tca total", 1, wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST);
    recording.encoder().copy_buffer_to_buffer(&frame.counts, (blocks * 4) as u64, &out, 0, 4);
    recording.submit();
    frame.points = read_words(gpu, &out).await?[0] as usize;

    frame.at = held(gpu, "tca points", (frame.points * 2).max(1), storage);
    let mut recording = gpu.record();
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("tca push"),
        contents: &frame.block(&ask),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&built.write);
        pass.set_bind_group(0, &frame.group(&push), &[]);
        pass.dispatch_workgroups(over_blocks, 1, 1);
    }
    recording.submit();
    Some(frame)
}

#[cfg(test)]
mod tests {
    /// The three the host and the shader each state for themselves, none of which crosses in the
    /// uniform. Each fails silently: a `MARGIN` that moved has the host's block spans covering
    /// positions the shader never scans, a `ROW_WORDS` folds the regression's rows at the wrong
    /// stride, and a `KNOTS_FROM` writes a curve over the gains.
    #[test]
    fn the_shader_reads_the_layout_the_host_writes() {
        const SOURCE: &str = include_str!("../../../slang/tca.slang");
        for line in [
            format!("static const int MARGIN = {};", super::MARGIN),
            format!("static const int ROW_WORDS = {};", super::ROW_WORDS),
            format!("static const int KNOTS_FROM = {};", super::KNOTS_FROM),
        ] {
            assert!(SOURCE.contains(&line), "tca.slang does not say `{line}`");
        }
    }
}
