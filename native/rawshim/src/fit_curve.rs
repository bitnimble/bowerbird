//! The tone curve's evidence, binned where the two fit planes are.
//!
//! `slang/fit_curve.slang` is the arithmetic over pixels. What is left here is the fold - each
//! block's partials summed in block order, in `f64` - and the solve the fold feeds, which is a
//! pass over 256 bins rather than over a picture.

use crate::gpu::dispatch::Whole;
use crate::parallel::*;

/// Workgroups the binning is split across, which is also how many partials come back.
///
/// The fold that crosses is `BLOCKS * BINS * 3` floats, so raising it costs the readback linearly.
const BLOCKS: usize = 256;

/// `fit_curve.slang`'s lanes and the curve bins each owns, which bound the bins one block can hold.
const LANES: usize = 64;
const OWNED: usize = 4;

/// The three sums a curve bin carries.
const PER_BIN: usize = 3;

/// What the curve is drawn through: each bin's weighted sum of the camera's coded answer, the
/// weight behind it, and how many entries reached it.
pub(crate) struct Binned {
    pub sum: Vec<f64>,
    pub weight: Vec<f64>,
    pub count: Vec<usize>,
}

pub(crate) struct Kernels {
    layout: wgpu::BindGroupLayout,
    levels: wgpu::ComputePipeline,
    weights: wgpu::ComputePipeline,
    bins: wgpu::ComputePipeline,
}

pub(crate) fn kernels(gpu: &'static crate::gpu::Gpu) -> &'static Kernels {
    static BUILT: crate::gpu::Cache<Kernels> = crate::gpu::Cache::new();
    BUILT.get(gpu, || {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fit_curve"),
            source: wgpu::ShaderSource::Wgsl(shaders::FIT_CURVE.source.into()),
        });
        let entry = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let read = wgpu::BufferBindingType::Storage { read_only: true };
        let write = wgpu::BufferBindingType::Storage { read_only: false };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("fit_curve"),
            entries: &[
                entry(0, read),
                entry(1, read),
                entry(2, read),
                entry(3, read),
                entry(4, write),
                entry(5, write),
                entry(6, write),
                entry(20, wgpu::BufferBindingType::Uniform),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fit_curve"),
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
            levels: build("fit_curve_levels"),
            weights: build("fit_curve_weights"),
            bins: build("fit_curve_bins"),
            layout,
        }
    })
}

/// The planes and the mask the binning reads, uploaded once and asked about every round.
pub(crate) struct Evidence {
    pub render: crate::gpu::Buffer,
    pub jpeg: crate::gpu::Buffer,
    pub bits: crate::gpu::Buffer,
    pub pixels: usize,
}

pub(crate) async fn binned(
    gpu: &'static crate::gpu::Gpu,
    evidence: &Evidence,
    hue_weights: &[f64],
    ceiling: f64,
    inverse: Option<&[[f64; 3]; 3]>,
) -> Option<Binned> {
    let bins = crate::hdr_fit::BINS;
    let level_bins = crate::hdr_fit::LEVEL_BINS;
    assert!(bins <= LANES * OWNED && level_bins <= LANES);
    let mut recording = gpu.record();
    recording.holding(&evidence.render);
    recording.holding(&evidence.jpeg);
    recording.holding(&evidence.bits);

    let held = |recording: &mut crate::gpu::Recording<'_>, label, words: usize, usage| {
        recording.buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: (words * 4).max(4) as u64,
            usage,
            mapped_at_creation: false,
        })
    };
    let storage = wgpu::BufferUsages::STORAGE;
    let levels = held(
        &mut recording,
        "fit curve levels",
        BLOCKS * level_bins,
        storage,
    );
    let weights = held(&mut recording, "fit curve weights", level_bins, storage);
    let partial_words = BLOCKS * bins * PER_BIN;
    let partials = held(
        &mut recording,
        "fit curve partials",
        partial_words,
        storage | wgpu::BufferUsages::COPY_SRC,
    );
    let hues = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit curve hues"),
        contents: &hue_weights
            .iter()
            .flat_map(|v| (*v as f32).to_ne_bytes())
            .collect::<Vec<u8>>(),
        usage: storage,
    });

    let mut block = [
        (evidence.pixels as i32).to_ne_bytes(),
        (evidence.pixels.div_ceil(BLOCKS) as i32).to_ne_bytes(),
        (BLOCKS as i32).to_ne_bytes(),
        (bins as i32).to_ne_bytes(),
        (level_bins as i32).to_ne_bytes(),
        (ceiling as f32).to_ne_bytes(),
        (crate::hdr_fit::LEVEL_BALANCE_LIMIT as f32).to_ne_bytes(),
        i32::from(inverse.is_some()).to_ne_bytes(),
        (crate::hdr_fit::HUE_SHIFT as i32).to_ne_bytes(),
    ]
    .concat();
    // The matrix starts on a 16-byte boundary and takes one per row, which is what `float4[3]` is
    // in std140.
    block.resize(48, 0);
    for row in inverse.unwrap_or(&[[0.0; 3]; 3]) {
        block.extend(row.iter().flat_map(|v| (*v as f32).to_ne_bytes()));
        block.extend(0f32.to_ne_bytes());
    }
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit_curve push"),
        contents: &block,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let built = kernels(gpu);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("fit_curve"),
        layout: &built.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: evidence.render.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: evidence.jpeg.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: evidence.bits.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: hues.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: levels.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: weights.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 6,
                resource: partials.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 20,
                resource: push.as_entire_binding(),
            },
        ],
    });
    let over_blocks = BLOCKS as u32;
    for (pipeline, groups) in [
        (&built.levels, over_blocks),
        (&built.weights, 1),
        (&built.bins, over_blocks),
    ] {
        recording.dispatch([groups, 1, 1], Whole::Fixed, |pass| {
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
        });
    }
    let out = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit curve out"),
        size: (partial_words * 4) as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    recording.copy_buffer_to_buffer(&partials, 0, &out, 0, (partial_words * 4) as u64);
    recording.submit();

    let read = crate::gpu::read_back(gpu, &out, |mapped| {
        mapped
            .par_chunks_exact(4)
            .map(|word| f64::from(f32::from_ne_bytes([word[0], word[1], word[2], word[3]])))
            .collect::<Vec<f64>>()
    })
    .await?;

    // Folded in block order, which is what makes two fits of one photograph draw one curve.
    let mut binned = Binned {
        sum: vec![0.0; bins],
        weight: vec![0.0; bins],
        count: vec![0usize; bins],
    };
    for block in read.chunks_exact(bins * PER_BIN) {
        for bin in 0..bins {
            binned.sum[bin] += block[bin * PER_BIN];
            binned.weight[bin] += block[bin * PER_BIN + 1];
            binned.count[bin] += block[bin * PER_BIN + 2] as usize;
        }
    }
    Some(binned)
}

#[cfg(test)]
mod tests {
    /// The shader states the mask's own width for itself nowhere: the hue's shift crosses in the
    /// uniform, so what has to hold is that it is the same one `fit_pairs.slang` packed with.
    #[test]
    fn the_binning_reads_the_hue_where_the_selection_wrote_it() {
        const SOURCE: &str = include_str!("../../../slang/fit_pairs.slang");
        let line = format!(
            "static const uint HUE_SHIFT = {};",
            crate::hdr_fit::HUE_SHIFT
        );
        assert!(
            SOURCE.contains(&line),
            "fit_pairs.slang does not say `{line}`"
        );
    }

    /// Blocks of several staged runs with the last block and its last run part-filled, channels
    /// masked one and two at a time, and bins every lane owns up to the last: each bin holds what a
    /// serial walk of every usable (pixel, channel) gives it, with the matrix undone and without.
    #[test]
    fn the_bins_hold_what_a_serial_walk_does() {
        use crate::hdr_fit::{BINS, HUE_SHIFT, LEVEL_BALANCE_LIMIT, LEVEL_BINS, srgb_oetf};
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let pixels = super::BLOCKS * 150 + 37;
        let ceiling = 0.9f32;
        let hue_weights = [0.5, 1.0, 1.5, 0.8, 1.2, 2.0];
        let mut seed = 9u64;
        let mut next = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 40) as f32 / (1u64 << 24) as f32
        };
        let (mut render, mut jpeg, mut bits) = (vec![], vec![], vec![]);
        for _ in 0..pixels {
            for _ in 0..3 {
                render.push(1.05 * ceiling * next());
                jpeg.push(next());
            }
            let channels = (next() * 8.0) as u32;
            let hue = (next() * hue_weights.len() as f32) as u32;
            bits.push(channels | (hue << HUE_SHIFT));
        }
        let upload = |label, bytes: Vec<u8>| {
            gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: &bytes,
                usage: wgpu::BufferUsages::STORAGE,
            })
        };
        let evidence = super::Evidence {
            render: upload(
                "render",
                render.iter().flat_map(|v| v.to_ne_bytes()).collect(),
            ),
            jpeg: upload("jpeg", jpeg.iter().flat_map(|v| v.to_ne_bytes()).collect()),
            bits: upload("bits", bits.iter().flat_map(|v| v.to_ne_bytes()).collect()),
            pixels,
        };
        let masks = &bits;
        let usable = |p: usize| (0..3usize).filter(move |&c| masks[p] & (1u32 << c) != 0);
        let hue_weight = |p: usize| hue_weights[(masks[p] >> HUE_SHIFT) as usize];
        let level_of = |x: f32| {
            let t = (x.max(0.0) / ceiling).sqrt();
            ((t * LEVEL_BINS as f32) as usize).min(LEVEL_BINS - 1)
        };
        let mut counted = [0.0f64; LEVEL_BINS];
        for p in 0..pixels {
            for c in usable(p) {
                counted[level_of(render[p * 3 + c])] += hue_weight(p);
            }
        }
        let occupied = counted.iter().filter(|c| **c > 0.0).count().max(1);
        let parity = counted.iter().sum::<f64>() / occupied as f64;
        let level_weight = counted.map(|c| match c > 0.0 {
            true => (parity / c).clamp(1.0 / LEVEL_BALANCE_LIMIT, LEVEL_BALANCE_LIMIT),
            false => 1.0,
        });
        let inverse = [[1.2, -0.1, -0.1], [-0.05, 1.1, -0.05], [0.0, -0.2, 1.2]];
        for inverse in [None, Some(&inverse)] {
            let device = pollster::block_on(super::binned(
                gpu,
                &evidence,
                &hue_weights,
                f64::from(ceiling),
                inverse,
            ))
            .expect("binned");
            let (mut sum, mut weight, mut count) =
                (vec![0.0; BINS], vec![0.0; BINS], vec![0; BINS]);
            for p in 0..pixels {
                let v = [0, 1, 2].map(|c| f64::from(jpeg[p * 3 + c]));
                let want = match inverse {
                    None => v,
                    Some(m) => {
                        m.map(|row| (row[0] * v[0] + row[1] * v[1] + row[2] * v[2]).max(0.0))
                    }
                };
                for c in usable(p) {
                    let x = render[p * 3 + c];
                    let w = hue_weight(p) * level_weight[level_of(x)];
                    let bin = (x / ceiling * (BINS - 1) as f32)
                        .round_ties_even()
                        .clamp(0.0, (BINS - 1) as f32) as usize;
                    sum[bin] += srgb_oetf(want[c].clamp(0.0, 1.0)) * w;
                    weight[bin] += w;
                    count[bin] += 1;
                }
            }
            assert!(count[BINS - 1] > 0, "the last bin is reached");
            let close = |a: f64, b: f64| (a - b).abs() <= 1e-4 * b.abs().max(1.0);
            for bin in 0..BINS {
                assert_eq!(device.count[bin], count[bin], "bin {bin}");
                assert!(
                    close(device.sum[bin], sum[bin]) && close(device.weight[bin], weight[bin]),
                    "bin {bin}: {} {} against {} {}",
                    device.sum[bin],
                    device.weight[bin],
                    sum[bin],
                    weight[bin]
                );
            }
        }
    }

    #[test]
    fn the_host_bounds_the_bins_with_the_shaders_lanes() {
        const SOURCE: &str = include_str!("../../../slang/fit_curve.slang");
        for line in [
            format!("static const int LANES = {};", super::LANES),
            format!("static const int OWNED = {};", super::OWNED),
        ] {
            assert!(
                SOURCE.contains(&line),
                "fit_curve.slang does not say `{line}`"
            );
        }
    }
}
