//! What the colour fit selects off its two planes, taken where `fit_register.slang` left them.
//!
//! `slang/fit_pairs.slang` is the arithmetic. This side is the two halves the shader cannot do:
//! stating the thresholds it gates on - they are `hdr_fit`'s, and a shader restating one would be a
//! second place to change it - and turning what comes back into the shapes the fit already reads.
//!
//! Two submits rather than one, because the pair list's length is not known until the blocks have
//! been counted and scanned: sizing it for every pixel instead would put an eight megabyte map at
//! the end of a pass whose answer is a third of that.

use crate::parallel::*;

/// Buckets each half of the selection counts into.
const HALF_BINS: usize = 65536;

/// Words a pair's record occupies, which `fit_pairs.slang` states for itself.
const PAIR_WORDS: usize = 5;

/// Pixels one thread of the two pair passes walks.
///
/// The count and the write have to agree on this and nothing else does, so it is a free choice:
/// small enough that the blocks fill a device, large enough that the scan over them stays short.
const BLOCK: usize = 256;

/// Where the single-invocation passes leave what the host reads, and where the hue counts start.
/// `the_shader_marks_the_slots_the_host_reads` holds these against the shader's own.
const CEILING: usize = 4;
const TOTAL: usize = 5;
const HUES: usize = 6;

async fn read_words(
    gpu: &'static crate::gpu::Gpu,
    staging: &crate::gpu::Buffer,
) -> Option<Vec<u32>> {
    crate::gpu::read_back(gpu, staging, |mapped| {
        mapped
            .par_chunks_exact(4)
            .map(|word| u32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
            .collect::<Vec<u32>>()
    })
    .await
}

/// What the colour fit selects off its two planes.
pub(crate) struct Selected {
    /// Where the fit's domain has to end for this frame, so the exposure gap between the two
    /// sides does not censor what the camera can still teach.
    ///
    /// The render is anchored on its own white quantile; the camera meters the subject. On a lit
    /// subject in a dark frame the two disagree by a stop and more, and everything the camera
    /// renders unclipped then sits above `TRUST_CEILING` in our units - outside the curves'
    /// domain, gated out of the pairs, unreachable by the lattice. So the domain is stretched
    /// until it holds as much of our render as the camera holds of the scene: the camera's
    /// unclipped fraction of pixels, read off our own brightness distribution.
    ///
    /// It arrives as the `f32` the selection wrote, which is the width it crosses to the shader
    /// and to the sidecar at - a stored match is compared by value against a fresh fit.
    pub ceiling: f64,
    /// The hue each pixel was censused into, which is what the weighting is read through.
    pub hues: Vec<u8>,
    /// The mask beside it, in the same word, where the curve fit reads both. Nothing on the host
    /// reads the mask - the tests that look at what a pixel earned are the only ones that do.
    pub words: crate::gpu::Buffer,
    #[cfg(test)]
    pub bits: Vec<u8>,
    /// Pixels usable for all three channels, per hue bucket, and summed over them.
    pub counted: Vec<usize>,
    pub total: usize,
    /// The pairs, in ascending pixel order, and the camera's colour at each.
    pub at: Vec<usize>,
    pub target: Vec<[f64; 3]>,
    /// The pairs either side rendered near enough to neutral, and what the camera made of them.
    pub greys: Vec<usize>,
    pub grey_target: [f64; 3],
    /// The picture every candidate is scored on beside the pairs, and the camera's colour across
    /// it: one pixel in `FRAME_STRIDE` along each axis, gated on nothing but the warp's black
    /// margin - a target the camera clipped is kept, and `hdr_fit` marks it for the gamut term
    /// alone. `FRAME` in `fit_pairs.slang` says why the picture cannot be read off the pairs.
    pub frame_at: Vec<usize>,
    pub frame_target: Vec<[f64; 3]>,
}

struct Kernels {
    layout: wgpu::BindGroupLayout,
    extent_high: wgpu::ComputePipeline,
    extent_pick: wgpu::ComputePipeline,
    extent_low: wgpu::ComputePipeline,
    extent_finish: wgpu::ComputePipeline,
    mask: wgpu::ComputePipeline,
    count: wgpu::ComputePipeline,
    offsets: wgpu::ComputePipeline,
    write: wgpu::ComputePipeline,
    frame_count: wgpu::ComputePipeline,
    frame_write: wgpu::ComputePipeline,
}

fn kernels(gpu: &'static crate::gpu::Gpu) -> &'static Kernels {
    static BUILT: std::sync::OnceLock<Kernels> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fit_pairs"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_pairs.wgsl")).into(),
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
            label: Some("fit_pairs"),
            entries: &[
                entry(0, read),
                entry(1, read),
                entry(2, write),
                entry(3, write),
                entry(4, write),
                entry(5, write),
                entry(6, write),
                entry(20, wgpu::BufferBindingType::Uniform),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fit_pairs"),
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
            extent_high: build("fit_extent_high"),
            extent_pick: build("fit_extent_pick"),
            extent_low: build("fit_extent_low"),
            extent_finish: build("fit_extent_finish"),
            mask: build("fit_mask"),
            count: build("fit_pairs_count"),
            offsets: build("fit_pairs_offsets"),
            write: build("fit_pairs_write"),
            frame_count: build("fit_frame_count"),
            frame_write: build("fit_frame_write"),
            layout,
        }
    })
}

/// `Params` in `fit_pairs.slang`, word for word in the order it declares them.
///
/// Its own function so `every_uniform_is_the_size_its_shader_reads` can take the length, which is
/// the whole of what the host promises about this block: every threshold in it is `hdr_fit`'s, and
/// a field added or reordered moves the tail on one side only.
fn params_bytes(width: usize, height: usize, blocks: usize) -> Vec<u8> {
    let mut block = [
        (width as i32).to_ne_bytes(),
        (height as i32).to_ne_bytes(),
        (BLOCK as i32).to_ne_bytes(),
        (blocks as i32).to_ne_bytes(),
        (crate::hdr_fit::HUE_BINS as i32).to_ne_bytes(),
        (crate::hdr_fit::MIN_CEILING_PIXELS as i32).to_ne_bytes(),
        (crate::hdr_fit::MARGIN_DARK as f32).to_ne_bytes(),
        (crate::hdr_fit::CAMERA_CLIPPING as f32).to_ne_bytes(),
        (crate::hdr_fit::CAMERA_CRUSHED as f32).to_ne_bytes(),
        (crate::hdr_fit::TRUST_CEILING as f32).to_ne_bytes(),
        ((crate::hdr_fit::OUR_CLIPPING / crate::hdr_fit::TRUST_CEILING) as f32).to_ne_bytes(),
        (crate::hdr_fit::PAIR_GRADIENT as f32).to_ne_bytes(),
        (crate::hdr_fit::GREY_CHROMA as f32).to_ne_bytes(),
        (crate::hdr_fit::GREY_FLOOR as f32).to_ne_bytes(),
        (crate::hdr_fit::HUE_CHROMA as f32).to_ne_bytes(),
        (crate::hdr_fit::FRAME_STRIDE as i32).to_ne_bytes(),
    ]
    .concat();
    // WGSL rounds a uniform struct up to sixteen bytes, and wgpu rejects a buffer shorter than
    // the rounded size.
    block.resize(block.len().next_multiple_of(16), 0);
    block
}

/// The block's length, for the layout test.
#[cfg(test)]
pub(crate) fn params_block() -> usize {
    params_bytes(1, 1, 1).len()
}

pub(crate) async fn select(
    gpu: &'static crate::gpu::Gpu,
    render: &crate::gpu::Buffer,
    jpeg: &crate::gpu::Buffer,
    width: usize,
    height: usize,
) -> Option<Selected> {
    let pixels = width * height;
    let blocks = pixels.div_ceil(BLOCK).max(1);
    let hue_slots = crate::hdr_fit::HUE_BINS + 1;
    let marks_words = HUES + hue_slots;

    let held = |label, words: usize, usage| {
        gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: (words * 4).max(4) as u64,
            usage,
            mapped_at_creation: false,
        })
    };
    let storage = wgpu::BufferUsages::STORAGE;
    let readable = storage | wgpu::BufferUsages::COPY_SRC;
    // Zeroed by the driver, which the counting relies on: every slot is added into rather than
    // written, and the scans read a total nothing set.
    let bits_words = held("fit pairs bits", pixels, readable);
    let histogram = held("fit pairs histogram", 2 * HALF_BINS, storage);
    let marks = held("fit pairs marks", marks_words, readable);
    let counts = held("fit pairs counts", blocks, storage);

    let push = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit_pairs push"),
        contents: &params_bytes(width, height, blocks),
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let built = kernels(gpu);
    let group = |pairs: &crate::gpu::Buffer| {
        gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("fit_pairs"),
            layout: &built.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: render.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: jpeg.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: bits_words.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: histogram.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: marks.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: counts.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: pairs.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
            ],
        })
    };

    let mut recording = gpu.record();
    let idle = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("unused"),
        size: 4,
        usage: storage,
        mapped_at_creation: false,
    });
    let selecting = group(&idle);
    let over_pixels = ((width as u32).div_ceil(16), (height as u32).div_ceil(16), 1);
    let over_blocks = ((blocks as u32).div_ceil(64), 1, 1);
    // A pass each, which is what orders them: within one pass two dispatches may overlap, and
    // every step here reads what the step before it wrote.
    for (pipeline, (x, y, z)) in [
        (&built.extent_high, over_pixels),
        (&built.extent_pick, (1, 1, 1)),
        (&built.extent_low, over_pixels),
        (&built.extent_finish, (1, 1, 1)),
        (&built.mask, over_pixels),
        (&built.count, over_blocks),
        (&built.offsets, (1, 1, 1)),
    ] {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &selecting, &[]);
        pass.dispatch_workgroups(x, y, z);
    }
    let staging = |recording: &mut crate::gpu::Recording<'_>,
                   from: &crate::gpu::Buffer,
                   words: usize| {
        let bytes = (words * 4).max(4) as u64;
        let out = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("fit pairs out"),
            size: bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        recording.encoder().copy_buffer_to_buffer(from, 0, &out, 0, bytes);
        out
    };
    let bits_out = staging(&mut recording, &bits_words, pixels);
    let marks_out = staging(&mut recording, &marks, marks_words);
    recording.submit();

    let words = read_words(gpu, &bits_out).await?;
    let read = read_words(gpu, &marks_out).await?;
    drop((bits_out, marks_out, recording));

    let ceiling = f64::from(f32::from_bits(read[CEILING]));
    let total_pairs = read[TOTAL] as usize;
    #[cfg(test)]
    let bits: Vec<u8> = words.par_iter().map(|w| *w as u8).collect();
    let hues: Vec<u8> = words.par_iter().map(|w| (*w >> crate::hdr_fit::HUE_SHIFT) as u8).collect();
    let counted: Vec<usize> = (0..hue_slots).map(|bucket| read[HUES + bucket] as usize).collect();
    let total = counted.iter().sum();

    let mut recording = gpu.record();
    let pairs = held("fit pairs", total_pairs * PAIR_WORDS, readable);
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&built.write);
        pass.set_bind_group(0, &group(&pairs), &[]);
        pass.dispatch_workgroups(over_blocks.0, 1, 1);
    }
    let pairs_out = staging(&mut recording, &pairs, total_pairs * PAIR_WORDS);
    recording.submit();
    let placed = read_words(gpu, &pairs_out).await?;

    let mut at = Vec::with_capacity(total_pairs);
    let mut target = Vec::with_capacity(total_pairs);
    let mut greys = Vec::new();
    let mut grey_target = [0.0f64; 3];
    for record in placed.chunks_exact(PAIR_WORDS).take(total_pairs) {
        let colour = [1, 2, 3].map(|c| f64::from(f32::from_bits(record[c])));
        at.push(record[0] as usize);
        target.push(colour);
        if record[4] != 0 {
            greys.push(record[0] as usize);
            for c in 0..3 {
                grey_target[c] += colour[c];
            }
        }
    }
    // The same compaction again over `FRAME`, which is a different set rather than a larger one:
    // the counts and the offsets are per-bit, so the second walk cannot share the first's.
    let mut recording = gpu.record();
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&built.frame_count);
        pass.set_bind_group(0, &selecting, &[]);
        pass.dispatch_workgroups(over_blocks.0, 1, 1);
    }
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&built.offsets);
        pass.set_bind_group(0, &selecting, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    let frame_marks = staging(&mut recording, &marks, marks_words);
    recording.submit();
    let total_frame = read_words(gpu, &frame_marks).await?[TOTAL] as usize;
    drop((frame_marks, recording));

    let mut recording = gpu.record();
    let frame = held("fit frame", total_frame * PAIR_WORDS, readable);
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&built.frame_write);
        pass.set_bind_group(0, &group(&frame), &[]);
        pass.dispatch_workgroups(over_blocks.0, 1, 1);
    }
    let frame_out = staging(&mut recording, &frame, total_frame * PAIR_WORDS);
    recording.submit();
    let framed = read_words(gpu, &frame_out).await?;

    let mut frame_at = Vec::with_capacity(total_frame);
    let mut frame_target = Vec::with_capacity(total_frame);
    for record in framed.chunks_exact(PAIR_WORDS).take(total_frame) {
        frame_at.push(record[0] as usize);
        frame_target.push([1, 2, 3].map(|c| f64::from(f32::from_bits(record[c]))));
    }

    Some(Selected {
        ceiling,
        #[cfg(test)]
        bits,
        hues,
        words: bits_words,
        counted,
        total,
        at,
        target,
        greys,
        grey_target,
        frame_at,
        frame_target,
    })
}

#[cfg(test)]
mod tests {
    const SOURCE: &str = include_str!("../../../slang/fit_pairs.slang");

    /// The slots the single-invocation passes write are read back by offset, so a shader that moved
    /// one would hand the host a ceiling that was a pair count - and the selection's own buckets
    /// are what the host sizes the histogram to, so a shader that widened them would write past it
    /// and answer with a ceiling nobody could see was wrong.
    #[test]
    fn the_shader_marks_the_slots_the_host_reads() {
        for (name, value) in [
            ("CEILING", super::CEILING),
            ("TOTAL", super::TOTAL),
            ("HUES", super::HUES),
            ("HALF_BINS", super::HALF_BINS),
        ] {
            let line = format!("static const uint {name} = {value};");
            assert!(SOURCE.contains(&line), "fit_pairs.slang does not say `{line}`");
        }
    }

    /// The mask and the hue share a word, and the host takes them apart by width: the low byte is
    /// the mask, the byte above it is the bucket. A shader that packed them differently would hand
    /// `fit_curves` a hue where it reads a channel bit.
    #[test]
    fn the_shader_packs_the_word_the_host_takes_apart() {
        for (name, value) in [
            ("HUE_SHIFT", crate::hdr_fit::HUE_SHIFT),
            ("PAIR_WORDS", super::PAIR_WORDS as u32),
        ] {
            let line = format!("static const uint {name} = {value};");
            assert!(SOURCE.contains(&line), "fit_pairs.slang does not say `{line}`");
        }
        for name in ["ALL", "COLOUR", "FRAME"] {
            let line = format!("static const uint {name} = ");
            let Some((_, tail)) = SOURCE.split_once(&line) else {
                panic!("fit_pairs.slang does not declare {name}");
            };
            let bit: u32 = tail.split(';').next().expect("a value").trim().parse().expect("a bit");
            assert!(bit < 1 << crate::hdr_fit::HUE_SHIFT, "{name} collides with the hue");
        }
    }
}
