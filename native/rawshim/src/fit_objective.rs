//! The geometry search's objective, over the grids the warp left on the device.
//!
//! `slang/fit_objective.slang` is the arithmetic over pixels: the gate that makes a pair, the bins
//! the curve is fitted from, and the residual the held-out half scores. What is left here is the
//! batching - every candidate of a scan in one submit, as `fit_score::Scoring` does for the colour
//! objective - and the curve between the two folds, which is 256 bins of arithmetic rather than a
//! picture.

/// Pixels one thread of the gate walks.
///
/// **Two, and it was measured rather than chosen.** A block is a thread and a thread is serial, so
/// this trades the gate's parallelism against how many blocks the scan below has to place. On a
/// 640x427 grid the search costs 436ms at 256, 214 at 8, 82 at 4, 73 at 2 and 98 at 1 - the last
/// because a block per pixel gives the group level four thousand entries to walk.
const BLOCK: usize = 2;

/// Blocks one group of the scan covers, which `fit_objective.slang` states for itself.
const GROUP: usize = 64;

/// Levels a curve is fitted over, and the two halves the pair list is split into.
const LEVELS: usize = 256;
const PHASES: usize = 2;

/// A sum and a count per level, per phase.
const BINS_PER_CANDIDATE: usize = PHASES * LEVELS * 2;

/// Words a pair's record occupies.
const RECORD_WORDS: usize = 2;

/// Words a candidate's answer occupies: the residual, its count, and the pairs the gate admitted.
const SCORE_WORDS: usize = 3;

/// `fit::refit_gain`'s radius bins, and the three sums each carries.
pub(crate) const FALLOFF_BINS: usize = 12;
const FALLOFF_WORDS: usize = 3;

struct Kernels {
    layout: wgpu::BindGroupLayout,
    count: wgpu::ComputePipeline,
    group: wgpu::ComputePipeline,
    scan: wgpu::ComputePipeline,
    offsets: wgpu::ComputePipeline,
    write: wgpu::ComputePipeline,
    bins: wgpu::ComputePipeline,
    curve: wgpu::ComputePipeline,
    score: wgpu::ComputePipeline,
    falloff: wgpu::ComputePipeline,
}

fn kernels(gpu: &'static crate::gpu::Gpu) -> &'static Kernels {
    static BUILT: std::sync::OnceLock<Kernels> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fit_objective"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_objective.wgsl")).into(),
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
            label: Some("fit_objective"),
            entries: &[
                entry(0, read),
                entry(1, read),
                entry(2, read),
                entry(3, write),
                entry(4, write),
                entry(5, write),
                entry(6, write),
                entry(7, write),
                entry(8, read),
                entry(9, write),
                entry(20, wgpu::BufferBindingType::Uniform),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fit_objective"),
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
            count: build("fit_obj_count"),
            group: build("fit_obj_group"),
            scan: build("fit_obj_scan"),
            offsets: build("fit_obj_offsets"),
            write: build("fit_obj_write"),
            bins: build("fit_obj_bins"),
            curve: build("fit_obj_curve"),
            score: build("fit_obj_score"),
            falloff: build("fit_obj_falloff"),
            layout,
        }
    })
}

/// Every candidate's pairs, gated and placed, held for the folds that read them.
///
/// **Held across the folds rather than rebuilt per fold**, which is the whole reason this pays: a
/// falloff asks three rounds of curve and score about one pair list, and a scan asks two folds
/// about each of tens of them.
pub(crate) struct Paired {
    gpu: &'static crate::gpu::Gpu,
    /// Bound into every group below and *held* rather than merely allocated: a `wgpu::BindGroup`
    /// keeps nothing alive that a browser will free.
    stacked: crate::gpu::Buffer,
    jpeg: crate::gpu::Buffer,
    counts: crate::gpu::Buffer,
    records: crate::gpu::Buffer,
    bins: crate::gpu::Buffer,
    curves: crate::gpu::Buffer,
    score: crate::gpu::Buffer,
    /// `invert_curve`'s answer for the round in hand, then `linear_table`, rewritten per round.
    falloff_tables: crate::gpu::Buffer,
    falloff_bins: crate::gpu::Buffer,
    /// Pairs the gate admitted, which the falloff walks and nothing else needs.
    admitted: std::cell::OnceCell<usize>,
    idle: crate::gpu::Buffer,
    width: usize,
    height: usize,
    pixels: usize,
    candidates: usize,
    blocks: usize,
}

/// One candidate's answer: its held-out residual and how many pairs the gate admitted.
pub(crate) struct Scored {
    pub delta: f64,
    pub pairs: usize,
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

/// Room for `candidates` warped grids against one camera grid.
///
/// **Allocated once and asked many times**, which is what the refine needs: it walks fifty
/// candidates one at a time, and allocating this set per step - six buffers, two of them megabytes -
/// cost more than every dispatch in it put together.
pub(crate) fn paired(
    gpu: &'static crate::gpu::Gpu,
    candidates: usize,
    jpeg: &crate::gpu::Buffer,
    (width, height): (usize, usize),
) -> Paired {
    let pixels = width * height;
    let candidates = candidates.max(1);
    let blocks = pixels.div_ceil(BLOCK).max(1);
    let storage = wgpu::BufferUsages::STORAGE;
    let readable = storage | wgpu::BufferUsages::COPY_SRC;
    // The two folds are asked several times over one pair list, and every slot is added into, so
    // both are cleared between rounds rather than allocated afresh.
    let cleared = readable | wgpu::BufferUsages::COPY_DST;

    // One buffer for every candidate's plane, because the kernel indexes them by slot and a
    // binding count cannot vary. Device to device, and only ever the planes a submit just wrote.
    let stacked = held(
        gpu,
        "fit objective planes",
        candidates * pixels * 3,
        storage | wgpu::BufferUsages::COPY_DST,
    );
    Paired {
        gpu,
        stacked,
        jpeg: jpeg.clone(),
        counts: held(
            gpu,
            "fit objective counts",
            candidates * (2 * blocks + 1 + blocks.div_ceil(GROUP)),
            readable,
        ),
        records: held(gpu, "fit objective records", candidates * pixels * RECORD_WORDS, readable),
        bins: held(gpu, "fit objective bins", candidates * BINS_PER_CANDIDATE, cleared),
        curves: held(gpu, "fit objective curves", candidates * LEVELS, readable),
        score: held(gpu, "fit objective score", candidates * SCORE_WORDS, cleared),
        // Two 256-level tables, rewritten each round because the curve they come off is.
        falloff_tables: held(
            gpu,
            "fit objective falloff tables",
            2 * LEVELS,
            storage | wgpu::BufferUsages::COPY_DST,
        ),
        falloff_bins: held(
            gpu,
            "fit objective falloff bins",
            blocks * FALLOFF_BINS * FALLOFF_WORDS,
            readable,
        ),
        admitted: std::cell::OnceCell::new(),
        idle: held(gpu, "unused", 1, storage),
        width,
        height,
        pixels,
        candidates,
        blocks,
    }
}

fn block(paired: &Paired, gained: bool, fitted: crate::fit::Phase) -> Vec<u8> {
    let mut words = [
        (paired.width as i32).to_ne_bytes(),
        (paired.height as i32).to_ne_bytes(),
        (BLOCK as i32).to_ne_bytes(),
        (paired.blocks as i32).to_ne_bytes(),
        (paired.candidates as i32).to_ne_bytes(),
        crate::fit::MAX_PAIR_GRADIENT.to_ne_bytes(),
        i32::from(gained).to_ne_bytes(),
        (fitted as i32).to_ne_bytes(),
        (fitted.held_out() as i32).to_ne_bytes(),
        (crate::fit::MIN_BIN_SAMPLES as i32).to_ne_bytes(),
        (paired.admitted.get().copied().unwrap_or(0) as i32).to_ne_bytes(),
    ]
    .concat();
    words.resize(48, 0);
    words
}

impl Paired {
    fn group(&self, push: &crate::gpu::Buffer, gain: &crate::gpu::Buffer) -> wgpu::BindGroup {
        self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("fit_objective"),
            layout: &kernels(self.gpu).layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.stacked.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.jpeg.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: gain.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: self.counts.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: self.records.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: self.bins.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: self.curves.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 7, resource: self.score.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: self.falloff_tables.as_entire_binding(),
                },
                wgpu::BindGroupEntry { binding: 9, resource: self.falloff_bins.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
            ],
        })
    }

    fn gain_of(&self, gain: Option<&crate::fit::Gain>) -> crate::gpu::Buffer {
        match gain {
            None => self.idle.clone(),
            Some(gain) => self.gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("fit objective gain"),
                contents: gain.table(),
                usage: wgpu::BufferUsages::STORAGE,
            }),
        }
    }

    /// Each candidate's mean residual over the half its curve was not fitted from.
    ///
    /// **Bins, curve and score in one submit**, which is the only shape that beats the host walk it
    /// replaced. Split so the host could draw the curve in the middle, the refine's fifty
    /// sequential steps paid three round trips each and the whole search came out half again
    /// slower - `test:bench` said so, at `measure` +51%.
    ///
    /// Scaled into L*-sized units so `REFINE_MARGIN` and `REFINE_FLOOR` mean what they meant when
    /// this was scored in deltaE.
    pub(crate) async fn scored(
        &self,
        warped: &[crate::gpu::Buffer],
        fitted: crate::fit::Phase,
        gain: Option<&crate::fit::Gain>,
    ) -> Option<Vec<Scored>> {
        let mut recording = self.gpu.record();
        recording.holding(&self.jpeg);
        // The planes into the one buffer the kernel indexes by slot, in the submit that reads them:
        // a binding count cannot vary, and device to device this is what a warp just wrote.
        let plane_bytes = (self.pixels * 3 * 4) as u64;
        for (slot, plane) in warped.iter().enumerate() {
            recording.holding(plane);
            recording.encoder().copy_buffer_to_buffer(
                plane,
                0,
                &self.stacked,
                slot as u64 * plane_bytes,
                plane_bytes,
            );
        }
        // Cleared rather than allocated afresh: a falloff asks three rounds of this about one pair
        // list, and every slot in both folds is added into.
        recording.encoder().clear_buffer(&self.bins, 0, None);
        recording.encoder().clear_buffer(&self.score, 0, None);
        let push = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("fit_objective push"),
            contents: &block(self, gain.is_some(), fitted),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let held_gain = self.gain_of(gain);
        let group = self.group(&push, &held_gain);
        let built = kernels(self.gpu);
        let over_blocks = (self.blocks as u32).div_ceil(64);
        // Over every pixel rather than over the pairs that survived, which is not known here
        // without a readback and is what the folds' own bound already handles.
        let over_pairs = (self.pixels as u32).div_ceil(64);
        let candidates = self.candidates as u32;
        let over_groups = (self.blocks.div_ceil(GROUP) as u32).div_ceil(64);
        // A pass each, and every one of them reads what the pass before it wrote.
        for (pipeline, across, down) in [
            (&built.count, over_blocks, candidates),
            (&built.group, over_groups, candidates),
            (&built.scan, candidates.div_ceil(64), 1),
            (&built.offsets, over_blocks, candidates),
            (&built.write, over_blocks, candidates),
            (&built.bins, over_pairs, candidates),
            (&built.curve, candidates, 1),
            (&built.score, over_pairs, candidates),
        ] {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(across, down, 1);
        }
        let words = self.candidates * SCORE_WORDS;
        let out = held(
            self.gpu,
            "fit objective score out",
            words,
            wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        );
        recording.encoder().copy_buffer_to_buffer(&self.score, 0, &out, 0, (words * 4) as u64);
        recording.submit();
        let read = read_words(self.gpu, &out).await?;
        Some(
            (0..self.candidates)
                .map(|c| Scored {
                    delta: match read[c * SCORE_WORDS + 1] {
                        0 => f64::INFINITY,
                        counted => {
                            f64::from(read[c * SCORE_WORDS]) / f64::from(counted) * (100.0 / 255.0)
                        }
                    },
                    pairs: read[c * SCORE_WORDS + 2] as usize,
                })
                .collect(),
        )
    }

    /// The curve the last [`Self::scored`] drew for one candidate.
    ///
    /// `refit_gain` is the only thing that wants it: it reads the curve backwards to say what light
    /// each pair should have carried, which is 256 levels of arithmetic against a pair list the
    /// device never hands over.
    pub(crate) async fn curve(&self, candidate: usize) -> Option<[u8; LEVELS]> {
        let mut recording = self.gpu.record();
        let out = held(
            self.gpu,
            "fit objective curve out",
            LEVELS,
            wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        );
        let from = (candidate * LEVELS * 4) as u64;
        recording.encoder().copy_buffer_to_buffer(&self.curves, from, &out, 0, (LEVELS * 4) as u64);
        recording.submit();
        let read = read_words(self.gpu, &out).await?;
        Some(std::array::from_fn(|level| read[level] as u8))
    }

    /// The falloff's radius bins over the pairs the gate admitted: what the camera wants, what we
    /// have, and how many pairs carried each.
    ///
    /// **The tables cross, not the pairs.** `back` is the round's own curve inverted and changes
    /// under each of the three rounds, so it is written per call - five hundred and twelve floats
    /// against the hundred and eighty thousand records it saves reading.
    ///
    /// Blocks come back in index order for the caller to sum, which is what makes the answer the
    /// same on every adapter.
    pub(crate) async fn falloff(
        &self,
        admitted: usize,
        phase: crate::fit::Phase,
        back: &[u8; LEVELS],
        linear: &[f64; LEVELS],
    ) -> Option<Vec<[f64; 3]>> {
        if admitted == 0 {
            return Some(Vec::new());
        }
        let _ = self.admitted.set(admitted);
        let tables: Vec<u8> = back
            .iter()
            .map(|level| f64::from(*level))
            .chain(linear.iter().copied())
            .flat_map(|v| (v as f32).to_ne_bytes())
            .collect();
        self.gpu.queue.write_buffer(&self.falloff_tables, 0, &tables);

        let blocks = admitted.div_ceil(BLOCK).max(1);
        let words = blocks * FALLOFF_BINS * FALLOFF_WORDS;
        let mut recording = self.gpu.record();
        let push = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("fit_objective push"),
            contents: &block(self, false, phase),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let gain = self.idle.clone();
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernels(self.gpu).falloff);
            pass.set_bind_group(0, &self.group(&push, &gain), &[]);
            pass.dispatch_workgroups((blocks as u32).div_ceil(64), 1, 1);
        }
        let out = held(
            self.gpu,
            "fit objective falloff out",
            words,
            wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        );
        recording.encoder().copy_buffer_to_buffer(
            &self.falloff_bins,
            0,
            &out,
            0,
            (words * 4) as u64,
        );
        recording.submit();
        let read = crate::gpu::read_back(self.gpu, &out, |mapped| {
            mapped
                .chunks_exact(4)
                .map(|word| f64::from(f32::from_ne_bytes([word[0], word[1], word[2], word[3]])))
                .collect::<Vec<f64>>()
        })
        .await?;

        // Folded here, in block order, into the twelve bins the solve reads.
        let mut bins = vec![[0.0f64; FALLOFF_WORDS]; FALLOFF_BINS];
        for block in read.chunks_exact(FALLOFF_BINS * FALLOFF_WORDS).take(blocks) {
            for (bin, slot) in bins.iter_mut().enumerate() {
                for word in 0..FALLOFF_WORDS {
                    slot[word] += block[bin * FALLOFF_WORDS + word];
                }
            }
        }
        Some(bins)
    }
}

#[cfg(test)]
mod tests {
    /// Everything the host sizes a buffer with that the shader indexes it by. `GROUP` is the one
    /// that bites hardest: it decides where a candidate's group bases sit, so a value that moved
    /// on one side has the scan reading its bases out of another candidate's counts - a score that
    /// is wrong rather than missing, and a geometry fit that returns a slightly wrong answer.
    #[test]
    fn the_shader_indexes_the_buffers_the_host_sizes() {
        const SOURCE: &str = include_str!("../../../slang/fit_objective.slang");
        for line in [
            format!("static const int SCORE_WORDS = {};", super::SCORE_WORDS),
            format!("static const int LEVELS = {};", super::LEVELS),
            format!("static const int PHASES = {};", super::PHASES),
            format!("static const int GROUP = {};", super::GROUP),
        ] {
            assert!(SOURCE.contains(&line), "fit_objective.slang does not say `{line}`");
        }
    }
}
