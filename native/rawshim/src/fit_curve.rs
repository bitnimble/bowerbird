//! The tone curve's evidence, binned where the two fit planes are.
//!
//! `slang/fit_curve.slang` is the arithmetic over pixels. What is left here is the fold - each
//! thread's partials summed in thread order, in `f64` - and the solve the fold feeds, which is a
//! pass over 256 bins rather than over a picture.

use crate::parallel::*;

/// Threads the binning is split across, which is also how many partials come back.
///
/// Low on purpose: the fold that crosses is `BLOCKS * BINS * 3` floats, and the work either side of
/// it is a few million adds, which this many lanes finish in microseconds. Raising it buys nothing
/// and costs the readback linearly.
const BLOCKS: usize = 256;

/// The three sums a curve bin carries.
const PER_BIN: usize = 3;

/// What the curve is drawn through: each bin's weighted sum of the camera's coded answer, the
/// weight behind it, and how many entries reached it.
pub(crate) struct Binned {
    pub sum: Vec<f64>,
    pub weight: Vec<f64>,
    pub count: Vec<usize>,
}

struct Kernels {
    layout: wgpu::BindGroupLayout,
    levels: wgpu::ComputePipeline,
    weights: wgpu::ComputePipeline,
    bins: wgpu::ComputePipeline,
}

fn kernels(gpu: &'static crate::gpu::Gpu) -> &'static Kernels {
    static BUILT: std::sync::OnceLock<Kernels> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fit_curve"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_curve.wgsl")).into(),
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
    // Zeroed by the driver, which both binnings rely on: every slot is added into.
    let levels = held(&mut recording, "fit curve levels", BLOCKS * level_bins, storage);
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
        contents: &hue_weights.iter().flat_map(|v| (*v as f32).to_ne_bytes()).collect::<Vec<u8>>(),
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
            wgpu::BindGroupEntry { binding: 0, resource: evidence.render.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: evidence.jpeg.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: evidence.bits.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: hues.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: levels.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: weights.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: partials.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
        ],
    });
    // A pass each: the weighting reads what the level count wrote, and the binning reads what the
    // weighting wrote.
    let over_blocks = (BLOCKS as u32).div_ceil(64);
    for (pipeline, groups) in
        [(&built.levels, over_blocks), (&built.weights, 1), (&built.bins, over_blocks)]
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(groups, 1, 1);
    }
    let out = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit curve out"),
        size: (partial_words * 4) as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    recording.encoder().copy_buffer_to_buffer(&partials, 0, &out, 0, (partial_words * 4) as u64);
    recording.submit();

    let read = crate::gpu::read_back(gpu, &out, |mapped| {
        mapped
            .par_chunks_exact(4)
            .map(|word| f64::from(f32::from_ne_bytes([word[0], word[1], word[2], word[3]])))
            .collect::<Vec<f64>>()
    })
    .await?;

    // Folded in thread order, which is what makes two fits of one photograph draw one curve.
    let mut binned =
        Binned { sum: vec![0.0; bins], weight: vec![0.0; bins], count: vec![0usize; bins] };
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
        let line = format!("static const uint HUE_SHIFT = {};", crate::hdr_fit::HUE_SHIFT);
        assert!(SOURCE.contains(&line), "fit_pairs.slang does not say `{line}`");
    }
}
