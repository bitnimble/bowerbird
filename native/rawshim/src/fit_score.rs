//! The colour fit's objective on the device, and the pairs it reads held there across a stage.
//!
//! `slang/fit_score.slang` is the arithmetic. This side is the two halves the shader cannot do:
//! uploading the pairs once for a stage that will ask many probes, and folding the per-block
//! partials in block order (`hdr_fit::folded`).

/// `hdr_fit::BIAS_BUCKETS`, which the shader states for itself and
/// `the_shader_pools_the_buckets_the_host_folds` holds the two together - a count that differed
/// would pool the bias over a different number of buckets on each side.
const BIAS_BUCKETS: usize = super::hdr_fit::BIAS_BUCKETS;

/// Per block: the trusted balance summed, every balance's magnitude summed, the trusted pairs
/// counted, the pairs counted, then the tally per bucket.
const INVARIANT: usize = 4 + BIAS_BUCKETS;

/// Four sums, a signed chroma pair per bucket, then the block's invariant.
const PARTIAL: usize = 4 + 2 * BIAS_BUCKETS + INVARIANT;

/// Words a probe's parameters occupy: a 3x3, a scalar, and the padding that keeps the stride a
/// round number so the shader indexes it by multiplication.
const PROBE_WORDS: usize = 12;

/// What the probes about to be asked carry.
pub enum Shape {
    /// A scalar scaling each pair's chroma about its own luma - `fitted_saturation`'s blend.
    Saturation,
    /// A 3x3 of the probe's own, with `to_srgb` already folded in - the ridge candidates.
    Matrix,
}

/// One block's partial sums, in the order the shader wrote them.
///
/// The deltaE sums and their normalisers count only pairs whose target the camera rendered
/// unclipped; the gamut sums count every pair, since a clipped target is exactly where a
/// candidate can be measured past the hull.
#[derive(Clone)]
pub struct Partial {
    pub balanced: f64,
    pub flat: f64,
    pub gamut_balanced: f64,
    pub gamut_flat: f64,
    pub weight: f64,
    pub weight_all: f64,
    pub trusted: f64,
    pub counted: f64,
    pub bias: [[f64; 2]; BIAS_BUCKETS],
    pub seen: [f64; BIAS_BUCKETS],
}

struct Kernel {
    layout: wgpu::BindGroupLayout,
    target: wgpu::ComputePipeline,
    score: wgpu::ComputePipeline,
}

fn kernel(gpu: &'static crate::gpu::Gpu) -> &'static Kernel {
    static BUILT: std::sync::OnceLock<Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fit_score"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_score.wgsl")).into(),
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
            label: Some("fit_score"),
            entries: &[
                entry(0, read),
                entry(1, write),
                entry(3, read),
                entry(4, read),
                entry(5, write),
                entry(6, write),
                entry(20, wgpu::BufferBindingType::Uniform),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fit_score"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = |name: &'static str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(name),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(name),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        Kernel { target: pipeline("fit_target"), score: pipeline("fit_score"), layout }
    })
}

fn words(values: impl IntoIterator<Item = f32>) -> Vec<u8> {
    values.into_iter().flat_map(f32::to_ne_bytes).collect()
}

/// `count` words written straight into the buffer that will be uploaded.
///
/// **Not `flat_map` into a `collect`.** These planes are 150k pairs of four floats each, and
/// building 4.8MB by appending four-byte arrays one at a time is more host work than the thirty
/// probes it exists to serve: `Resident::of` records the same lesson, where the same shape was
/// most of what a call cost.
fn packed(count: usize, fill: impl Fn(usize) -> [u8; 4] + Sync + Send) -> Vec<u8> {
    use crate::parallel::*;
    let mut bytes = vec![0u8; count * 4];
    bytes.par_chunks_mut(4).enumerate().for_each(|(k, word)| {
        word.copy_from_slice(&fill(k));
    });
    bytes
}

/// A `below` plane from colours the host holds: each pair's colour, and the luma beside it.
///
/// One zeroed pair where there are none, since a binding cannot be empty.
pub fn below_buffer(gpu: &'static crate::gpu::Gpu, below: &[([f64; 3], f64)]) -> crate::gpu::Buffer {
    gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit_score below"),
        contents: &packed(below.len().max(1) * 4, |k| {
            let value = below.get(k / 4).map_or(0.0, |(m, l)| match k % 4 {
                3 => *l,
                c => m[c],
            });
            (value as f32).to_ne_bytes()
        }),
        usage: wgpu::BufferUsages::STORAGE,
    })
}

/// A stage's pairs on the device, so the probes it asks cost only their own parameters.
///
/// **Held across the stage rather than per probe**, which is the whole reason this pays. The
/// per-pair planes are the same five megabytes for every probe of a saturation sweep or a ridge
/// scan, and there are about thirty of those in a fit.
pub struct Scoring {
    gpu: &'static crate::gpu::Gpu,
    /// Bound once into `group` and never named again, and *held* rather than merely allocated:
    /// a `wgpu::BindGroup` keeps nothing alive that a browser will free, so dropping these here
    /// would destroy the buffers the group still points at.
    #[expect(dead_code)]
    below: crate::gpu::Buffer,
    #[expect(dead_code)]
    target: crate::gpu::Buffer,
    #[expect(dead_code)]
    to_srgb: crate::gpu::Buffer,
    #[expect(dead_code)]
    invariant: crate::gpu::Buffer,
    /// The four a call would otherwise create and destroy, and the bind group over them, so that
    /// asking again costs two `write_buffer`s and a dispatch.
    ///
    /// What a call costs beyond that is the arithmetic, and `examples/score_bench` is where to read
    /// it: the fixed part is about 0.24ms and everything above it scales with probes times pairs.
    partials: crate::gpu::Buffer,
    staging: crate::gpu::Buffer,
    parameters: crate::gpu::Buffer,
    push: crate::gpu::Buffer,
    group: wgpu::BindGroup,
    pairs: usize,
    blocks: usize,
    block: usize,
}

/// Probes one call may ask about, which is what the held buffers are sized for.
///
/// The saturation's sweep is the widest asker at `SATURATION_SWEEP` plus its neutral, and the ridge
/// scan takes six. A caller past this splits, which nothing does.
const MAX_PROBES: usize = 32;

impl Scoring {
    /// `below` is each pair's colour beneath whatever the probes vary and the luma a saturation
    /// blend rotates about, already on the device (`hdr_fit::evaluate`, or [`below_buffer`]);
    /// `target` is the camera's rendering in the render's own linear Rec.2020, which `to_srgb`
    /// and `fit_target` put on the JPEG's own grid, and `balance` the hue weight beside it.
    pub fn new(
        gpu: &'static crate::gpu::Gpu,
        below: crate::gpu::Buffer,
        target: &[[f64; 3]],
        balance: &[f64],
        to_srgb: &[[f64; 3]; 3],
        block: usize,
    ) -> Scoring {
        let pairs = target.len();
        let blocks = pairs.div_ceil(block.max(1));
        let partial_bytes = (MAX_PROBES * blocks * PARTIAL * 4).max(4) as u64;
        let held = |label, size, usage| {
            gpu.own_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size,
                usage,
                mapped_at_creation: false,
            })
        };
        let partials = held(
            "fit_score partial",
            partial_bytes,
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        );
        let staging = held(
            "fit_score out",
            partial_bytes,
            wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        );
        let parameters = held(
            "fit_score probes",
            (MAX_PROBES * PROBE_WORDS * 4) as u64,
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        );
        let push = held(
            "fit_score push",
            32,
            wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        );
        let invariant = held(
            "fit_score invariant",
            (blocks.max(1) * INVARIANT * 4) as u64,
            wgpu::BufferUsages::STORAGE,
        );
        let held_target = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("fit_score target"),
            contents: &packed(pairs.max(1) * 4, |k| {
                let value = match k % 4 {
                    3 => balance.get(k / 4).copied(),
                    c => target.get(k / 4).map(|t| t[c]),
                };
                (value.unwrap_or(0.0) as f32).to_ne_bytes()
            }),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let held_srgb = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("fit_score to_srgb"),
            contents: &words(to_srgb.iter().flatten().map(|v| *v as f32)),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("fit_score"),
            layout: &kernel(gpu).layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: below.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: held_target.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: parameters.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: held_srgb.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: partials.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: invariant.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
            ],
        });
        let scoring = Scoring {
            gpu,
            below,
            target: held_target,
            to_srgb: held_srgb,
            invariant,
            partials,
            staging,
            parameters,
            push,
            group,
            pairs,
            blocks,
            block,
        };
        if pairs > 0 {
            scoring.describe(0, &Shape::Saturation);
            let mut recording = gpu.record();
            {
                let mut pass = recording.encoder().begin_compute_pass(&Default::default());
                pass.set_pipeline(&kernel(gpu).target);
                pass.set_bind_group(0, &scoring.group, &[]);
                pass.dispatch_workgroups((blocks as u32).div_ceil(64), 1, 1);
            }
            recording.submit();
        }
        scoring
    }

    /// The block both kernels read: the pairs, their blocking, and what the probes carry.
    fn describe(&self, probes: usize, shape: &Shape) {
        let mut block = [
            self.pairs as i32,
            self.blocks as i32,
            self.block as i32,
            probes as i32,
            match shape {
                Shape::Saturation => 0,
                Shape::Matrix => 1,
            },
        ]
        .iter()
        .flat_map(|v| v.to_ne_bytes())
        .collect::<Vec<u8>>();
        block.resize(32, 0);
        self.gpu.queue.write_buffer(&self.push, 0, &block);
    }

    /// Every probe's per-block partials, in `(probe, block)` order.
    ///
    /// The fold across blocks stays on the host: it is `blocks` additions per probe, it is where
    /// the bias pooling and the two weightings live, and it is the half that has to keep `f64`.
    /// A stage with no pairs has no blocks, so each probe folds to what an empty sum gives.
    pub async fn partials(&self, shape: &Shape, probes: &[Probe]) -> Option<Vec<Vec<Partial>>> {
        if probes.is_empty() || self.pairs == 0 {
            return Some(vec![Vec::new(); probes.len()]);
        }
        assert!(probes.len() <= MAX_PROBES, "{} probes at once", probes.len());
        let units = probes.len() * self.blocks;
        let bytes = (units * PARTIAL * 4) as u64;
        // Written rather than created, which is the whole point of holding them.
        self.gpu.queue.write_buffer(
            &self.parameters,
            0,
            &words(probes.iter().flat_map(Probe::words)),
        );
        self.describe(probes.len(), shape);

        let mut recording = self.gpu.record();
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernel(self.gpu).score);
            pass.set_bind_group(0, &self.group, &[]);
            pass.dispatch_workgroups((units as u32).div_ceil(64), 1, 1);
        }
        recording.encoder().copy_buffer_to_buffer(&self.partials, 0, &self.staging, 0, bytes);
        recording.submit();

        // The buffer is sized for `MAX_PROBES` and this call wrote `units` of it, so the tail
        // holds whatever the last call left.
        let read = crate::gpu::read_back(self.gpu, &self.staging, |mapped| {
            mapped
                .chunks_exact(PARTIAL * 4)
                .take(units)
                .map(|words| {
                    let at = |k: usize| {
                        let word = &words[k * 4..k * 4 + 4];
                        f64::from(f32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
                    };
                    let invariant = 4 + 2 * BIAS_BUCKETS;
                    Partial {
                        balanced: at(0),
                        flat: at(1),
                        gamut_balanced: at(2),
                        gamut_flat: at(3),
                        weight: at(invariant),
                        weight_all: at(invariant + 1),
                        trusted: at(invariant + 2),
                        counted: at(invariant + 3),
                        bias: std::array::from_fn(|i| [at(4 + 2 * i), at(4 + 2 * i + 1)]),
                        seen: std::array::from_fn(|i| at(invariant + 4 + i)),
                    }
                })
                .collect::<Vec<Partial>>()
        })
        .await?;
        Some(read.chunks(self.blocks).map(<[Partial]>::to_vec).collect())
    }
}

/// One probe's parameters, in the shape the shader reads them.
pub struct Probe {
    pub matrix: [[f64; 3]; 3],
    pub saturation: f64,
}

impl Probe {
    /// The probe that changes nothing: saturation exactly 1.0, which the shader short-circuits.
    pub fn neutral() -> Probe {
        Probe { matrix: [[0.0; 3]; 3], saturation: 1.0 }
    }

    fn words(&self) -> Vec<f32> {
        let mut out: Vec<f32> = self.matrix.iter().flatten().map(|v| *v as f32).collect();
        out.push(self.saturation as f32);
        out.resize(PROBE_WORDS, 0.0);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bucket count is stated twice, and a fold over a different number of buckets from the
    /// one the shader tallied is a cast measured against the wrong population.
    #[test]
    fn the_shader_pools_the_buckets_the_host_folds() {
        const SOURCE: &str = include_str!("../../../slang/fit_score.slang");
        let line = format!("static const int BIAS_BUCKETS = {};", BIAS_BUCKETS);
        assert!(SOURCE.contains(&line), "fit_score.slang does not say `{line}`");
    }

    /// An sRGB level taken to light and handed over as a target comes back on the level it was
    /// encoded from, so `on_grid`'s transfer, its rounding and its inverse agree.
    ///
    /// Asked through the objective rather than by reading the buffer back, because that is where
    /// a slip would land: the pairs' own side reaches `lab_of` unrounded, so a target that missed
    /// its level by one is exactly the distance this asserts away.
    #[test]
    fn the_camera_lands_back_on_the_level_it_was_encoded_from() {
        let Some(gpu) = crate::gpu::device() else { return };
        const IDENTITY: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let lit: Vec<[f64; 3]> = [[0u8, 0, 0], [13, 64, 200], [128, 128, 128], [255, 255, 255]]
            .into_iter()
            .map(|codes| codes.map(crate::hdr_fit::srgb_eotf))
            .collect();
        let below: Vec<([f64; 3], f64)> = lit.iter().map(|v| (*v, 0.0)).collect();
        let scoring = Scoring::new(gpu, below_buffer(gpu, &below), &lit, &[1.0; 4], &IDENTITY, 2);
        let partials =
            pollster::block_on(scoring.partials(&Shape::Saturation, &[Probe::neutral()]))
                .expect("the device scored");
        let flat: f64 = partials[0].iter().map(|p| p.flat).sum();
        assert!(flat < 1e-2, "the camera's side moved off its levels by {flat}");
    }

    /// A colour past the sRGB hull is measured by how far, and a clipped target is measured by
    /// that alone: no deltaE, no place in the trusted count, its weight kept for the gamut sum.
    #[test]
    fn a_clipped_target_counts_for_the_gamut_and_nothing_else() {
        let Some(gpu) = crate::gpu::device() else { return };
        const IDENTITY: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        // Green a fifth of full scale below zero on a red, which a luma-preserving pull to the
        // hull would take 0.2 / (0.0696 + 0.2) of the chroma to mend; and one inside the gamut,
        // on the JPEG's own levels so its deltaE against itself is nothing.
        let inside = [128u8, 100, 80].map(crate::hdr_fit::srgb_eotf);
        let below = vec![([1.0, -0.2, 0.0], 0.0), (inside, 0.0)];
        let target = [[1.0, 0.0, 0.0], inside];
        let balance = [-2.0, 1.0];
        let scoring = Scoring::new(gpu, below_buffer(gpu, &below), &target, &balance, &IDENTITY, 2);
        let partials =
            pollster::block_on(scoring.partials(&Shape::Saturation, &[Probe::neutral()]))
                .expect("the device scored");
        let sum = |f: fn(&Partial) -> f64| partials[0].iter().map(f).sum::<f64>();
        let expected = 0.2 / (0.2126 - 0.7152 * 0.2 + 0.2);
        assert!((sum(|p| p.gamut_flat) - expected).abs() < 1e-4, "{}", sum(|p| p.gamut_flat));
        assert!((sum(|p| p.gamut_balanced) - 2.0 * expected).abs() < 1e-4);
        assert_eq!(sum(|p| p.trusted), 1.0);
        assert_eq!(sum(|p| p.counted), 2.0);
        assert_eq!(sum(|p| p.weight), 1.0);
        assert_eq!(sum(|p| p.weight_all), 3.0);
        assert!(sum(|p| p.flat) < 1e-2, "the trusted pair sits on its own level");
    }
}
