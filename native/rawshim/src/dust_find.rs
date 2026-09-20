//! The search, dispatched.
//!
//! Everything `dust_find.slang` needs to be run in order, and nothing about what it means -
//! [`crate::dust`] owns the reasoning, this owns the buffers and the bind groups.
//!
//! **Two things cross back, and neither of them is the frame.** The thresholded prominence, which is
//! the flood fill's mask and its heights in one plane, and the fitted spots, which are twenty-odd
//! kilobytes. The mosaic itself never leaves the device.


/// Log-spaced bins the texture's floor is taken from. `HIST_BINS` in the shader, which is where the
/// quantile over them is worked out; this side only sizes the buffer.
const HIST_BINS: usize = 512;

/// One dispatch's scalars, at the dynamic offset that binds them.
///
/// A slot each rather than a buffer each, as `galosh` does it: WGSL has no push constants, and the
/// radius, the channel and the floor all change between passes - so a single buffer rewritten
/// between dispatches would hand every pass the last one's numbers, a queue write landing before the
/// whole submit rather than between two of its passes.
const SLOT: u64 = 256;

/// Where `count` sits inside a slot: the one field the host writes after the buffer is built, once
/// the fill has said how many blobs there are.
const AT_COUNT: u64 = 60;

/// `SEGMENT` in the shader: samples one thread of the box pass runs its sum down.
const SEGMENT: usize = 256;

/// `PATCH` in the shader: the tile one workgroup of the transpose turns.
const PATCH: usize = 32;

/// The planes [`Search`] hands to the fits, and the one it reads the mask out of, by the role they
/// hold at the end of a sweep rather than the one they were allocated under.
const LOG_MEAN: usize = 0;
const LIT: usize = 1;
const MASKED: usize = 2;
const TEXTURE: usize = 3;

struct Kernel {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
}

pub struct Find {
    quads: Kernel,
    /// One layout for the four passes that read binding 10 and write binding 11.
    separable: wgpu::BindGroupLayout,
    box_cols: wgpu::ComputePipeline,
    transpose: wgpu::ComputePipeline,
    rank_rows: wgpu::ComputePipeline,
    rank_cols: wgpu::ComputePipeline,
    fold: Kernel,
    judge: Kernel,
    tophat: Kernel,
    spread: Kernel,
    quantile: Kernel,
    threshold: Kernel,
    fits: Kernel,
}

/// What `fits` holds per workgroup: the profile's bins and their counts, one set per lane, the
/// reduction beside them, and the handful of scalars the lanes broadcast through.
const WORKGROUP_STORAGE: u32 = (2 * crate::dust::BINS as u32 + 1) * 64 * 4 + 64;

/// The kernels, built once and kept for the process.
///
/// None where the adapter cannot hold that. The caller's answer is to leave the photograph's
/// particles where they are, which is a far better outcome than a failed decode.
pub fn device(gpu: &'static crate::gpu::Gpu) -> Option<&'static Find> {
    static BUILT: std::sync::OnceLock<Option<Find>> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Find::new(gpu)).as_ref()
}

impl Find {
    fn new(gpu: &crate::gpu::Gpu) -> Option<Find> {
        let device = gpu.describing();
        if device.limits().max_compute_workgroup_storage_size < WORKGROUP_STORAGE {
            return None;
        }
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("dust find"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/dust_find.wgsl")).into(),
            ),
        });

        let bindings = |bindings: &[(u32, bool)]| {
            let mut entries: Vec<_> = bindings
                .iter()
                .map(|(binding, read_only)| wgpu::BindGroupLayoutEntry {
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
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: None,
                },
                count: None,
            });
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("dust find"),
                entries: &entries,
            })
        };
        let pipeline = |name: &'static str, layout: &wgpu::BindGroupLayout| {
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(name),
                bind_group_layouts: &[Some(layout)],
                ..Default::default()
            });
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(name),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(name),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let kernel = |name: &'static str, entries: &[(u32, bool)]| {
            let layout = bindings(entries);
            Kernel { pipeline: pipeline(name, &layout), layout }
        };

        const R: bool = true;
        const W: bool = false;
        let separable = bindings(&[(10, R), (11, W)]);
        Some(Find {
            quads: kernel("quads", &[(1, R), (2, W), (3, W), (4, W), (5, W), (6, W)]),
            box_cols: pipeline("box_cols", &separable),
            transpose: pipeline("transpose", &separable),
            rank_rows: pipeline("rank_rows", &separable),
            rank_cols: pipeline("rank_cols", &separable),
            separable,
            fold: kernel("fold", &[(20, R), (21, R), (22, W), (23, W), (24, W)]),
            // The band planes are one set of globals, declared for the fold that writes them, so the
            // judge that only reads them still binds them writable.
            judge: kernel("judge", &[(22, W), (23, W), (24, W), (30, W), (31, W)]),
            tophat: kernel("tophat", &[(40, R), (41, R), (42, W)]),
            spread: kernel("spread", &[(50, R), (51, W)]),
            quantile: kernel("quantile", &[(52, W)]),
            threshold: kernel("threshold", &[(60, R), (61, R), (62, W), (63, R)]),
            fits: kernel("fits", &[(70, R), (71, R), (72, R), (73, R), (74, W)]),
        })
    }
}

/// What the search needs of the frame, in the working grid's own terms.
///
/// Every field but the scales is a fact about the sensor; the scales are what [`crate::dust`]
/// derives from the predicted shadow, and this carries them rather than deriving them twice.
pub struct Shape {
    pub hw: usize,
    pub hh: usize,
    pub stride: usize,
    pub ox: usize,
    pub oy: usize,
    pub shrink: usize,
    pub cfa: [u32; 4],
    pub fine: f32,
    pub coarse: f32,
    pub surround: f32,
    pub texture: f32,
    pub opening: usize,
    pub mask_snr: f32,
}

impl Shape {
    fn samples(&self) -> usize {
        self.hw * self.hh
    }
}

/// The box radius three passes approximate this sigma with.
fn radius_for(sigma: f32) -> u32 {
    (((4.0 * sigma * sigma + 1.0).sqrt() - 1.0) / 2.0).round().max(1.0) as u32
}

/// One blob, as `fits` reads it: where its centre is, how large it was, and how far it stood above
/// its own opening.
pub struct Blob {
    pub cx: f32,
    pub cy: f32,
    pub area: f32,
    pub peak: f32,
}

/// Slots of the one uniform buffer, filled as they are needed and bound by dynamic offset.
struct Slots {
    bytes: Vec<u8>,
}

impl Slots {
    fn add(&mut self, shape: &Shape, radius: u32, channel: u32, dilate: u32) -> u32 {
        self.laid(shape, (shape.hw, shape.hh), radius, channel, dilate)
    }

    /// The same for a pass reading the turned frame, whose rows are the frame's columns.
    fn turned(&mut self, shape: &Shape, radius: u32) -> u32 {
        self.laid(shape, (shape.hh, shape.hw), radius, 0, 0)
    }

    fn laid(
        &mut self,
        shape: &Shape,
        (hw, hh): (usize, usize),
        radius: u32,
        channel: u32,
        dilate: u32,
    ) -> u32 {
        let at = self.bytes.len();
        for word in [
            hw as u32,
            hh as u32,
            shape.stride as u32,
            shape.ox as u32,
            shape.oy as u32,
            (2 * shape.shrink) as u32,
            shape.shrink as u32,
            radius,
            shape.cfa[0],
            shape.cfa[1],
            shape.cfa[2],
            shape.cfa[3],
        ] {
            self.bytes.extend_from_slice(&word.to_ne_bytes());
        }
        self.bytes.extend_from_slice(&(shape.mask_snr * shape.mask_snr).to_ne_bytes());
        // The blob count goes in afterwards: it is an answer to a dispatch this buffer is being
        // built for.
        for word in [channel, dilate, 0] {
            self.bytes.extend_from_slice(&word.to_ne_bytes());
        }
        self.bytes.resize(at + SLOT as usize, 0);
        at as u32
    }
}

/// A search in progress: the working planes, still on the device, and the mask the host took off it.
///
/// Held rather than finished in one call because the flood fill is the one part with no shader - so
/// the host reads the mask, walks it, and hands the blobs it grew back to [`Search::fits`], which
/// reads the planes still sitting where the sweep left them.
pub struct Search {
    /// The thresholded prominence, as the half floats the plane holds: positive where a sample is
    /// masked, zero elsewhere.
    ///
    /// **Left encoded, because the fill only ever compares them.** A non-negative half float orders
    /// exactly as its bit pattern does, so `> 0` and a running maximum are the same answer either
    /// way - and decoding a 61MP frame's worth to find a few hundred blobs would cost more than the
    /// readback. [`decoded`] converts the handful that turn out to be a blob's height.
    pub masked: Vec<u16>,
    planes: Vec<crate::gpu::Buffer>,
    uniforms: crate::gpu::Buffer,
    fits_slot: u32,
}

/// Everything up to the mask, leaving the planes the fits read where they are.
///
/// One submit and one readback: the mask's floor is a quantile of a plane this sweep writes, and it
/// is worked out on the device rather than fetched, so nothing here waits on the host.
pub async fn sweep(
    gpu: &crate::gpu::Gpu,
    kernels: &Find,
    mosaic: &crate::condition::Mosaic,
    shape: &Shape,
) -> Option<Search> {
    let count = shape.samples();
    if count == 0 {
        return None;
    }
    // The planes and the uniforms outlive this recording - they are the `Search` the caller is
    // handed - so they are allocated on the device rather than against the submission.
    let mut recording = gpu.record();
    recording.holding(&mosaic.buffer);

    // **Ten planes carrying fourteen roles, at two samples a word.** Each is 7.5MB on a 61MP body
    // read at half, so a plane per stage would be an eighth of a gigabyte of device memory to say
    // what these say. The three logged channels are consumed one at a time by the folds and are free
    // afterwards, which is where the score, the texture and the prominence go.
    let plane = |label: &str| {
        gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: (count * 2) as u64,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    };
    let planes: Vec<crate::gpu::Buffer> = [
        "dust log mean",
        "dust surround",
        "dust red / score / masked",
        "dust green / texture",
        "dust blue / prominence",
        "dust sharp",
        "dust scratch",
        "dust band sum / top-hat",
        "dust band low",
        "dust band high",
    ]
    .iter()
    .map(|label| plane(label))
    .collect();
    let (log_mean, lit) = (&planes[LOG_MEAN], &planes[LIT]);
    let (red, green, blue) = (&planes[MASKED], &planes[TEXTURE], &planes[4]);
    let (score, texture, prominence) = (&planes[MASKED], &planes[TEXTURE], &planes[4]);
    let (sharp, scratch) = (&planes[5], &planes[6]);
    let (sum, low, high) = (&planes[7], &planes[8], &planes[9]);

    let histogram = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("dust histogram"),
        size: (HIST_BINS * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let mut slots = Slots { bytes: Vec::new() };
    let plain = slots.add(shape, 1, 0, 0);
    // A pair each: the same window, once down the frame's own columns and once down the turned
    // frame's, which are the frame's rows.
    let blurs: Vec<(u32, u32)> = [shape.surround, shape.fine, shape.coarse, shape.texture]
        .into_iter()
        .map(|sigma| {
            let radius = radius_for(sigma);
            (slots.add(shape, radius, 0, 0), slots.turned(shape, radius))
        })
        .collect();
    let erode = slots.add(shape, shape.opening as u32, 0, 0);
    let dilate = slots.add(shape, shape.opening as u32, 0, 1);
    let folds: Vec<u32> = (0..3).map(|channel| slots.add(shape, 1, channel, 0)).collect();
    let fits_slot = slots.add(shape, 1, 0, 0);
    let uniforms = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("dust find slots"),
        contents: &slots.bytes,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });

    let bind = |layout: &wgpu::BindGroupLayout, buffers: &[(u32, &crate::gpu::Buffer)]| {
        bound(gpu, &uniforms, layout, buffers)
    };

    // **A pass each rather than one for the chain**, for the reason `galosh` records: most dispatches
    // here read what the one before them wrote, and a pass boundary is where WebGPU guarantees the
    // write is visible.
    let run = |encoder: &mut wgpu::CommandEncoder,
               pipeline: &wgpu::ComputePipeline,
               group: &wgpu::BindGroup,
               slot: u32,
               items: usize| {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, group, &[slot]);
        let (x, y) = crate::base::groups(items);
        pass.dispatch_workgroups(x, y, 1);
    };
    // Three box passes down the columns, the frame turned, three more, and turned back - which is
    // close enough to a Gaussian for a background estimate, at eight linear passes rather than a
    // convolution, and with every one of them reading the frame the way it is laid out.
    //
    // The passes alternate between the plane and the scratch, so three of them leave the answer in
    // the scratch and the turn puts it back in the plane. Two buffers carry the whole blur.
    // Every plane pass is a thread to a *word*, which is two samples.
    let words = count / 2;
    let down = |hw: usize, hh: usize| hw / 2 * hh.div_ceil(SEGMENT);
    let tiles = shape.hw.div_ceil(PATCH) * shape.hh.div_ceil(PATCH) * 64;
    let blur = |encoder: &mut wgpu::CommandEncoder, plane: &crate::gpu::Buffer, window: (u32, u32)| {
        let out = bind(&kernels.separable, &[(10, plane), (11, scratch)]);
        let back = bind(&kernels.separable, &[(10, scratch), (11, plane)]);
        let laid = [
            (window.0, down(shape.hw, shape.hh)),
            (window.1, down(shape.hh, shape.hw)),
        ];
        for (slot, items) in laid {
            for step in 0..3 {
                let group = match step % 2 {
                    0 => &out,
                    _ => &back,
                };
                run(encoder, &kernels.box_cols, group, slot, items);
            }
            run(encoder, &kernels.transpose, &back, slot, tiles);
        }
    };

    let encoder = recording.encoder();
    encoder.clear_buffer(&histogram, 0, None);

    let quads = bind(
        &kernels.quads.layout,
        &[(1, &mosaic.buffer), (2, red), (3, green), (4, blue), (5, log_mean), (6, lit)],
    );
    run(encoder, &kernels.quads.pipeline, &quads, plain, words);
    blur(encoder, lit, blurs[0]);

    for (channel, plane) in [red, green, blue].into_iter().enumerate() {
        encoder.copy_buffer_to_buffer(plane, 0, sharp, 0, (count * 2) as u64);
        blur(encoder, sharp, blurs[1]);
        blur(encoder, plane, blurs[2]);
        let fold = bind(
            &kernels.fold.layout,
            &[(20, sharp), (21, plane), (22, sum), (23, low), (24, high)],
        );
        run(encoder, &kernels.fold.pipeline, &fold, folds[channel], words);
    }

    let judge = bind(
        &kernels.judge.layout,
        &[(22, sum), (23, low), (24, high), (30, score), (31, texture)],
    );
    run(encoder, &kernels.judge.pipeline, &judge, plain, words);

    // The opening, and the top-hat against the score it was taken from. Out into `sum`, which the
    // judge has finished with, because the difference reads both of its inputs.
    encoder.copy_buffer_to_buffer(score, 0, prominence, 0, (count * 2) as u64);
    let out = bind(&kernels.separable, &[(10, prominence), (11, scratch)]);
    let back = bind(&kernels.separable, &[(10, scratch), (11, prominence)]);
    for slot in [erode, dilate] {
        run(encoder, &kernels.rank_rows, &out, slot, words);
        run(encoder, &kernels.rank_cols, &back, slot, words);
    }
    let tophat = bind(&kernels.tophat.layout, &[(40, prominence), (41, score), (42, sum)]);
    run(encoder, &kernels.tophat.pipeline, &tophat, plain, words);

    // How busy the neighbourhood is, as the RMS of the band-pass over a window wide enough that one
    // particle is a small part of it. Already squared by `judge`.
    blur(encoder, texture, blurs[3]);

    let spread = bind(&kernels.spread.layout, &[(50, texture), (51, &histogram)]);
    run(encoder, &kernels.spread.pipeline, &spread, plain, words);

    // **The quantile is a dispatch, not a readback.** Two kilobytes of counts crossing back to be
    // divided would drain the device and stall everything after it - and the only thing the threshold
    // wants of them is one float, which a single lane can work out where they lie.
    let counts = bind(&kernels.quantile.layout, &[(52, &histogram)]);
    run(encoder, &kernels.quantile.pipeline, &counts, plain, 1);

    let threshold = bind(
        &kernels.threshold.layout,
        &[(60, sum), (61, texture), (62, score), (63, &histogram)],
    );
    run(encoder, &kernels.threshold.pipeline, &threshold, plain, words);
    recording.submit();

    // Held from here, so that every way out of this function gives the planes back - including the
    // one where the mask never arrives, which is a `?` on a value this now owns.
    let mut search = Search { masked: Vec::new(), planes, uniforms, fits_slot };
    let masked = read_halves(gpu, &search.planes[MASKED], count).await;
    search.masked = masked?;
    Some(search)
}

impl Search {
    /// Every blob's ellipse, profile and confidence, and whether the gates kept it.
    ///
    /// One `SPOT_WORDS + 1` run per blob, the last word being the flag.
    pub async fn fits(
        &self,
        gpu: &crate::gpu::Gpu,
        kernels: &Find,
        blobs: &[Blob],
    ) -> Option<Vec<f32>> {
        if blobs.is_empty() {
            return Some(Vec::new());
        }
        let words = crate::dust::SPOT_WORDS + 1;
        gpu.queue.write_buffer(
            &self.uniforms,
            u64::from(self.fits_slot) + AT_COUNT,
            &(blobs.len() as u32).to_ne_bytes(),
        );

        let mut recording = gpu.record();
        let table = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("dust blobs"),
            contents: &blobs
                .iter()
                .flat_map(|blob| [blob.cx, blob.cy, blob.area, blob.peak])
                .flat_map(f32::to_ne_bytes)
                .collect::<Vec<u8>>(),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let out = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("dust spots"),
            size: (blobs.len() * words * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });

        let group = bound(
            gpu,
            &self.uniforms,
            &kernels.fits.layout,
            &[
                (70, &table),
                (71, &self.planes[LOG_MEAN]),
                (72, &self.planes[TEXTURE]),
                (73, &self.planes[LIT]),
                (74, &out),
            ],
        );

        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernels.fits.pipeline);
            pass.set_bind_group(0, &group, &[self.fits_slot]);
            pass.dispatch_workgroups(blobs.len() as u32, 1, 1);
        }
        recording.submit();

        read_f32(gpu, &out, blobs.len() * words).await
    }

}

fn bound(
    gpu: &crate::gpu::Gpu,
    uniforms: &crate::gpu::Buffer,
    layout: &wgpu::BindGroupLayout,
    buffers: &[(u32, &crate::gpu::Buffer)],
) -> wgpu::BindGroup {
    let mut entries: Vec<_> = buffers
        .iter()
        .map(|(binding, buffer)| wgpu::BindGroupEntry {
            binding: *binding,
            resource: buffer.as_entire_binding(),
        })
        .collect();
    entries.push(wgpu::BindGroupEntry {
        binding: 0,
        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
            buffer: uniforms,
            offset: 0,
            size: std::num::NonZeroU64::new(SLOT),
        }),
    });
    gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("dust find"),
        layout,
        entries: &entries,
    })
}

async fn mapped(gpu: &crate::gpu::Gpu, from: &crate::gpu::Buffer, bytes: u64) -> Option<Vec<u8>> {
    let mut recording = gpu.record();
    let readback = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("dust find readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    recording.encoder().copy_buffer_to_buffer(from, 0, &readback, 0, bytes);
    recording.submit();
    crate::gpu::read_back(gpu, &readback, <[u8]>::to_vec).await
}

/// One half float, as `pack2x16float` wrote it.
///
/// Ten lines rather than a dependency, and only ever called a few hundred times a search: the plane
/// crosses back encoded and the fill walks it that way.
pub fn decoded(bits: u16) -> f32 {
    let sign = match bits & 0x8000 {
        0 => 1.0,
        _ => -1.0,
    };
    let exponent = u32::from(bits >> 10) & 0x1f;
    let fraction = u32::from(bits & 0x3ff);
    sign * match exponent {
        // Zero and the subnormals, which have no implied leading one: `fraction * 2^-24`.
        0 => fraction as f32 / 16_777_216.0,
        31 => f32::from_bits(0x7f80_0000 | fraction << 13),
        // 127 - 15, the two formats' exponent biases.
        _ => f32::from_bits((exponent + 112) << 23 | fraction << 13),
    }
}

async fn read_halves(
    gpu: &crate::gpu::Gpu,
    from: &crate::gpu::Buffer,
    count: usize,
) -> Option<Vec<u16>> {
    let bytes = mapped(gpu, from, (count * 2) as u64).await?;
    Some(bytes.chunks_exact(2).map(|half| u16::from_ne_bytes([half[0], half[1]])).collect())
}

async fn read_f32(
    gpu: &crate::gpu::Gpu,
    from: &crate::gpu::Buffer,
    count: usize,
) -> Option<Vec<f32>> {
    let bytes = mapped(gpu, from, (count * 4) as u64).await?;
    Some(
        bytes
            .chunks_exact(4)
            .map(|word| f32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// [`decoded`] against every half float there is.
    ///
    /// **Exhaustive because it can be**: there are 65536 of them, and hand-written bit arithmetic is
    /// exactly the kind of thing a sampled test agrees with everywhere but the corner that matters.
    /// Held against the encoding rather than against a table, by rounding an f32 back down.
    #[test]
    fn a_half_float_decodes_to_what_it_encodes() {
        for bits in 0..=u16::MAX {
            let exponent = (bits >> 10) & 0x1f;
            let value = decoded(bits);
            if exponent == 31 {
                assert!(!value.is_finite(), "{bits:#06x} decoded to {value}");
                continue;
            }
            // Re-encoding is exact for anything a half float can hold, so the round trip has to
            // land on the same bits - which pins the sign, the bias and both shifts at once.
            let sign = u32::from(bits & 0x8000) << 16;
            let re = value.to_bits();
            assert_eq!(re & 0x8000_0000, sign, "{bits:#06x} lost its sign as {value}");
            assert!(value.abs() <= 65504.0, "{bits:#06x} decoded to {value}, past the format");
            if exponent != 0 {
                let back = (((re >> 23) & 0xff) as i32 - 112) as u16;
                assert_eq!(back, exponent, "{bits:#06x} moved exponent");
                assert_eq!((re >> 13) & 0x3ff, u32::from(bits & 0x3ff), "{bits:#06x} moved mantissa");
            }
        }
        assert_eq!(decoded(0), 0.0);
        assert_eq!(decoded(0x3c00), 1.0);
        assert_eq!(decoded(0xbc00), -1.0);
        // The smallest subnormal, and the largest finite value.
        assert_eq!(decoded(1), 2f32.powi(-24));
        assert_eq!(decoded(0x7bff), 65504.0);
    }
}
