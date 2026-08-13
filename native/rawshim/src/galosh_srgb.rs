//! The editor's denoise, on this side of the wire.
//!
//! `web/src/features/raw_edit/gpu/denoise_chain.ts` is the browser's host for these kernels and
//! this is the same eight dispatches against the same WGSL files, so that what the editor shows
//! can be rendered without a browser. That is the whole point of it: the editor's tick is a
//! render specification and nothing else - a prepared frame, a noise measurement and two slider
//! positions - so asking "what does the editor show" should cost a decode, not a Playwright run
//! and a screenshot.
//!
//! Not a second implementation of the denoise: the kernels are the shared files, and the order
//! and the bindings are transcribed from the one host that already existed. What is genuinely
//! twice is the *amount mapping*, which is arithmetic rather than pixels, and
//! [`Amounts::for_editor`] carries a test that pins it to its TypeScript twin's landmarks.
//!
//! The mosaic path's host is `galosh.rs`; the two denoisers are deliberately different and
//! DESIGN 10.9.1 says why.

use crate::gpu::Gpu;

const PRELUDE: &str = include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/prelude.wgsl");

/// `pass12`'s tile, and the regression's window, as `denoise_chain.ts` declares them.
const PASS12_TILE: u32 = 28;
const LOESS_RADIUS: i32 = 7;

/// `params` slots the kernels read, as `prelude.wgsl` names them.
const P_ALPHA: usize = 13;
const P_SIGMA_SQ: usize = 14;
const P_SIGMA_GAT: i32 = 21;

/// The alignment a dynamic offset has to respect, which is one dispatch's scalars.
const SLOT: u64 = 256;

/// How the Detail sliders reach these kernels.
///
/// The twin of `denoiseAmounts` in `web/src/features/raw_edit/gpu/shaders.ts`, and the editor's
/// own mapping rather than the mosaic path's: `blend` mixes the chroma regression's answer in
/// against the pixel's own over the first half of the track, and `ridge` widens the regression
/// past the middle, where the mosaic path walks four anchors instead.
#[derive(Clone, Copy)]
pub struct Amounts {
    pub luma: f32,
    pub blend: f32,
    pub ridge: f32,
}

impl Amounts {
    pub fn for_editor(luminance: f64, colour: f64) -> Amounts {
        let on = |value: f64| value.clamp(0.0, 100.0) / 100.0;
        let past = |value: f64| (on(value) - 0.5).max(0.0) * 2.0;
        Amounts {
            luma: (on(luminance) * 2.0) as f32,
            blend: (on(colour) * 2.0).min(1.0) as f32,
            ridge: (1.0 + past(colour) * 2.0) as f32,
        }
    }

    fn does_anything(&self) -> bool {
        self.luma > 0.0 || self.blend > 0.0
    }
}

struct Kernel {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
}

/// Every kernel of the editor's chain, built once and kept for the process.
pub struct Editor {
    split: Kernel,
    gat: Kernel,
    norm: Kernel,
    denorm: Kernel,
    lut: Kernel,
    lut_finalize: Kernel,
    shrink: Kernel,
    invert: Kernel,
    loess: Kernel,
    join: Kernel,
}

/// The chain, or None where this adapter cannot run it.
///
/// The same storage limit `pass12` needs on the mosaic path, asked rather than assumed for the
/// same reason: a validation failure is fatal where `on_uncaptured_error` panics.
pub fn device(gpu: &'static Gpu) -> Option<&'static Editor> {
    static BUILT: std::sync::OnceLock<Option<Editor>> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Editor::new(gpu)).as_ref()
}

impl Editor {
    fn new(gpu: &Gpu) -> Option<Editor> {
        let limits = gpu.device.limits();
        if limits.max_compute_workgroup_storage_size < 26_240
            || limits.max_compute_invocations_per_workgroup < 256
        {
            return None;
        }

        let device = &gpu.device;
        let kernel = |name: &'static str, body: &str, bindings: &[(u32, bool)]| -> Kernel {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(name),
                source: wgpu::ShaderSource::Wgsl(format!("{PRELUDE}\n{body}").into()),
            });
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
                binding: 20,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
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
            Kernel { pipeline, layout }
        };

        const R: bool = true;
        const W: bool = false;
        Some(Editor {
            split: kernel(
                "yuv_split",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/yuv_split.wgsl"),
                &[(0, R), (1, W), (2, W), (3, W)],
            ),
            gat: kernel(
                "yuv_gat_fwd",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/yuv_gat_fwd.wgsl"),
                &[(0, R), (1, W), (2, R)],
            ),
            norm: kernel(
                "yuv_sigma_norm",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/yuv_sigma_scale.wgsl"),
                &[(0, W), (1, R)],
            ),
            denorm: kernel(
                "yuv_sigma_denorm",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/yuv_sigma_scale.wgsl"),
                &[(0, W), (1, R)],
            ),
            lut: kernel(
                "build_inv_lut",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/build_inv_lut.wgsl"),
                &[(0, R), (1, W), (2, W), (3, W)],
            ),
            lut_finalize: kernel(
                "lut_finalize",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/lut_finalize.wgsl"),
                &[(0, R), (1, W)],
            ),
            shrink: kernel(
                "pass12",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/pass12.wgsl"),
                &[(0, R), (1, W)],
            ),
            invert: kernel(
                "yuv_makitalo",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/yuv_makitalo.wgsl"),
                &[(0, R), (1, W), (2, R), (3, R), (4, R)],
            ),
            loess: kernel(
                "yuv_loess",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/yuv_loess.wgsl"),
                &[(0, R), (1, R), (2, R), (3, W), (4, W)],
            ),
            join: kernel(
                "yuv_join",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/yuv_join.wgsl"),
                &[(0, R), (1, R), (2, R), (3, W)],
            ),
        })
    }
}

/// The prepared frame, denoised in place, exactly as a tick would leave it.
///
/// `samples` is interleaved RGB `u16` in normalised PQ - `edit::prepare`'s own output, which is
/// what the client uploads. `noise` is what [`crate::noise::measure`] read off it, because the
/// tick is handed that rather than measuring for itself.
pub fn denoise(
    gpu: &Gpu,
    editor: &Editor,
    samples: &mut [u16],
    width: usize,
    height: usize,
    noise: &crate::noise::Noise,
    amounts: Amounts,
) {
    let npix = width * height;
    assert_eq!(samples.len(), npix * 3, "three samples to a pixel");
    if !amounts.does_anything() || npix == 0 {
        return;
    }

    let device = &gpu.device;
    // The frame crosses as packed `u16` pairs, which is what `yuv_split` unpacks and `yuv_join`
    // writes back - so the buffer is words, not samples.
    //
    // **Sized from the pairs `yuv_join` writes, not from the samples.** It takes two pixels at a
    // time and writes three whole words for them, so an odd pixel count costs a word of padding
    // that no sample occupies - `ceil(3 * npix / 2)` is one short of `3 * ceil(npix / 2)` on every
    // odd frame, and the kernel's last store lands past the end. The browser's own sizing rounds
    // up twice and happens to land on the right number, so the two hosts disagreed only here.
    let words = 3 * npix.div_ceil(2);

    let storage = wgpu::BufferUsages::STORAGE;
    let plane = |label: &str, len: usize| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: (len.max(1) * 4) as u64,
            usage: storage,
            mapped_at_creation: false,
        })
    };

    let frame = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("editor frame"),
        size: (words * 4) as u64,
        usage: storage | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut packed: Vec<u8> = Vec::with_capacity(words * 4);
    for pair in samples.chunks(2) {
        packed.extend_from_slice(&pair[0].to_le_bytes());
        packed.extend_from_slice(&pair.get(1).copied().unwrap_or(0).to_le_bytes());
    }
    gpu.queue.write_buffer(&frame, 0, &packed);

    let y = plane("editor Y", npix);
    let cb = plane("editor Cb", npix);
    let cr = plane("editor Cr", npix);
    let y_stab = plane("editor Y stabilised", npix);
    let y_den = plane("editor Y shrunk / Cb out", npix);
    let cr_out = plane("editor Cr out", npix);
    let lut_d = plane("editor lut d", 4096);
    let lut_x = plane("editor lut x", 4096);
    let lut_params = plane("editor lut params", 8);

    // Written from here rather than by a kernel, which is what the measurement living in
    // prepare means on both hosts.
    let params = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("editor params"),
        size: 32 * 4,
        usage: storage | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut constants = [0f32; 32];
    constants[P_ALPHA] = noise.alpha;
    constants[P_SIGMA_SQ] = noise.sigma_sq;
    constants[P_SIGMA_GAT as usize] = noise.stabilised;
    let mut constant_bytes: Vec<u8> = Vec::with_capacity(32 * 4);
    for value in constants {
        constant_bytes.extend_from_slice(&value.to_ne_bytes());
    }
    gpu.queue.write_buffer(&params, 0, &constant_bytes);

    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("editor readback"),
        size: (words * 4) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let (w, h) = (width as i32, height as i32);
    let n = npix as i32;
    let mut pushes: Vec<u8> = Vec::new();
    let mut add = |words: &[[u8; 4]]| -> u32 {
        let at = pushes.len();
        for word in words {
            pushes.extend_from_slice(word);
        }
        pushes.resize(at + SLOT as usize, 0);
        at as u32
    };
    let i = i32::to_ne_bytes;
    let f = f32::to_ne_bytes;
    let flat_push = add(&[i(n)]);
    let scale_push = add(&[i(n), i(P_SIGMA_GAT)]);
    let shrink_push = add(&[i(w), i(h), f(amounts.luma)]);
    let loess_push = add(&[i(w), i(h), f(amounts.ridge), f(amounts.blend), i(LOESS_RADIUS)]);
    let pairs_push = add(&[i(n)]);

    let uniforms = {
        use wgpu::util::DeviceExt;
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("editor pushes"),
            contents: &pushes,
            usage: wgpu::BufferUsages::UNIFORM,
        })
    };

    let bind = |kernel: &Kernel, buffers: &[(u32, &wgpu::Buffer)]| {
        let mut entries: Vec<_> = buffers
            .iter()
            .map(|(binding, buffer)| wgpu::BindGroupEntry {
                binding: *binding,
                resource: buffer.as_entire_binding(),
            })
            .collect();
        entries.push(wgpu::BindGroupEntry {
            binding: 20,
            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                buffer: &uniforms,
                offset: 0,
                size: std::num::NonZeroU64::new(SLOT),
            }),
        });
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &kernel.layout,
            entries: &entries,
        })
    };

    // The browser folds a flat sweep into two dimensions because one of them cannot hold a
    // 24MP frame; `flat_index` reads it back the same way whoever dispatched it.
    let spread = |invocations: usize| -> (u32, u32) {
        let wanted = (invocations as u32).div_ceil(256).max(1);
        let wide = device.limits().max_compute_workgroups_per_dimension.max(1);
        let x = wanted.min(wide).max(1);
        (x, wanted.div_ceil(x).max(1))
    };
    let (fx, fy) = spread(npix);
    let (px, py) = spread(npix.div_ceil(2));
    let tiles = ((w as u32).div_ceil(PASS12_TILE).max(1), (h as u32).div_ceil(PASS12_TILE).max(1));
    let full = ((w as u32).div_ceil(16).max(1), (h as u32).div_ceil(16).max(1));

    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        let mut run = |kernel: &Kernel, group: &wgpu::BindGroup, offset: u32, x: u32, y: u32| {
            pass.set_pipeline(&kernel.pipeline);
            pass.set_bind_group(0, group, &[offset]);
            pass.dispatch_workgroups(x, y, 1);
        };

        let g = bind(&editor.split, &[(0, &frame), (1, &y), (2, &cb), (3, &cr)]);
        run(&editor.split, &g, flat_push, fx, fy);
        let g = bind(&editor.gat, &[(0, &y), (1, &y_stab), (2, &params)]);
        run(&editor.gat, &g, flat_push, fx, fy);
        let g = bind(&editor.norm, &[(0, &y_stab), (1, &params)]);
        run(&editor.norm, &g, scale_push, fx, fy);
        let g = bind(&editor.lut, &[(0, &params), (1, &lut_d), (2, &lut_x), (3, &lut_params)]);
        run(&editor.lut, &g, flat_push, 16, 1);
        let g = bind(&editor.lut_finalize, &[(0, &lut_d), (1, &lut_params)]);
        run(&editor.lut_finalize, &g, flat_push, 1, 1);
        let g = bind(&editor.shrink, &[(0, &y_stab), (1, &y_den)]);
        run(&editor.shrink, &g, shrink_push, tiles.0, tiles.1);
        let g = bind(&editor.denorm, &[(0, &y_den), (1, &params)]);
        run(&editor.denorm, &g, scale_push, fx, fy);
        let g = bind(
            &editor.invert,
            &[(0, &y_den), (1, &y), (2, &lut_d), (3, &lut_x), (4, &lut_params)],
        );
        run(&editor.invert, &g, flat_push, fx, fy);
        let g = bind(&editor.loess, &[(0, &y_stab), (1, &cb), (2, &cr), (3, &y_den), (4, &cr_out)]);
        run(&editor.loess, &g, loess_push, full.0, full.1);
        // Two pixels an invocation, which is what makes the pack race-free.
        let g = bind(&editor.join, &[(0, &y), (1, &y_den), (2, &cr_out), (3, &frame)]);
        run(&editor.join, &g, pairs_push, px, py);
    }
    encoder.copy_buffer_to_buffer(&frame, 0, &readback, 0, (words * 4) as u64);
    gpu.queue.submit([encoder.finish()]);

    let slice = readback.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    device.poll(wgpu::PollType::wait_indefinitely()).expect("the denoise finished");
    {
        let mapped = slice.get_mapped_range().expect("the readback mapped");
        for (at, chunk) in mapped.chunks_exact(2).enumerate() {
            if at < samples.len() {
                samples[at] = u16::from_le_bytes([chunk[0], chunk[1]]);
            }
        }
    }
    readback.unmap();
}

#[cfg(test)]
mod tests {
    use super::Amounts;

    /// The whole track, against the same file the TypeScript twin reads.
    ///
    /// **Landmarks are not enough for a curve.** The two hosts were pinned at 0, 40, 50 and 100
    /// each against its own arithmetic, which a rewrite that landed on those four and missed
    /// everywhere between would pass on both sides at once - and the editor's live preview takes
    /// one of these while an export takes the other, so that is a picture which changes when it is
    /// saved. The fixture is off-landmark on purpose.
    #[test]
    fn the_editor_track_is_the_one_the_fixture_states() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../test/fixtures/denoise-amounts.txt");
        let text = std::fs::read_to_string(path).expect("the shared fixture");
        let mut rows = 0;
        for line in text.lines().filter(|line| !line.trim_start().starts_with('#') && !line.trim().is_empty()) {
            let cells: Vec<f64> = line.split_whitespace().map(|cell| cell.parse().expect("a number")).collect();
            let [luminance, colour, luma, blend, ridge] = cells[..] else { panic!("five columns: {line}") };
            let got = Amounts::for_editor(luminance, colour);
            for (name, got, want) in
                [("luma", got.luma, luma), ("blend", got.blend, blend), ("ridge", got.ridge, ridge)]
            {
                assert!(
                    (f64::from(got) - want).abs() < 1e-6,
                    "at {luminance},{colour} the {name} is {got} where the fixture says {want}",
                );
            }
            rows += 1;
        }
        assert!(rows >= 8, "the fixture has only {rows} rows");
    }

    /// **Half of a two-language guard.** `denoiseAmounts` in
    /// `web/src/features/raw_edit/gpu/shaders.ts` maps the same slider, and
    /// `web/src/features/raw_edit/gpu/tests/detail_track.test.ts` pins the same landmarks from
    /// the other side. Nothing but arithmetic keeps them agreeing.
    #[test]
    fn the_editor_track_lands_where_its_typescript_twin_does() {
        let calibrated = Amounts::for_editor(50.0, 50.0);
        assert!((calibrated.luma - 1.0).abs() < 1e-6, "luma {}", calibrated.luma);
        assert!((calibrated.blend - 1.0).abs() < 1e-6, "blend {}", calibrated.blend);

        let shipped = Amounts::for_editor(40.0, 40.0);
        assert!((shipped.luma - 0.8).abs() < 1e-6, "luma {}", shipped.luma);

        // Colour keeps going past the middle by widening the regression, not by blending
        // further - the mix is already fully wet there.
        let top = Amounts::for_editor(100.0, 100.0);
        assert!((top.luma - 2.0).abs() < 1e-6, "luma {}", top.luma);
        assert!((top.blend - 1.0).abs() < 1e-6, "blend {}", top.blend);
        assert!(top.ridge > calibrated.ridge, "{} against {}", top.ridge, calibrated.ridge);

        assert!(!Amounts::for_editor(0.0, 0.0).does_anything());
    }
}
