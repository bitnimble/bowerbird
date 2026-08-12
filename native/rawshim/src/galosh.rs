//! GALOSH-RAW: the blind denoise, on the Bayer mosaic, on the GPU.
//!
//! Thirty-one compute kernels transcribed from the reference's Vulkan port (its
//! `o32_*.comp` shaders, Apache-2.0, arXiv:2607.03768); this file is the host that drives
//! them, and it follows the reference host blueprint's dispatch table dispatch for
//! dispatch so the two can be read side by side.
//!
//! **Why the mosaic and not the frame.** Sensor noise is per-photosite. A demosaic averages
//! neighbouring sites to invent the two colours each site did not record, which correlates
//! the noise across pixels and smears a chroma error into a coloured smudge no
//! post-demosaic filter can separate again. Denoising first is the only place the noise is
//! still what the sensor made.
//!
//! **Blind.** Phase 0 fits the sensor's own Poisson-Gaussian model off the frame - shot
//! noise from the slope of variance against level, read noise from the Laplacians of the
//! dark pixels - so there is no per-body noise profile to ship and no ISO to trust.
//!
//! The WGSL lives under `web/` like every other shader here, and is `include_str!`'d from
//! there - even though the mosaic never crosses to the browser. Three of these kernels are
//! not the mosaic's: the reference's sRGB front-end, which is what the editor runs on its
//! own frame per tick, dispatches `pass12`, `build_inv_lut` and `lut_finalize` verbatim.
//! One copy, two hosts, exactly as `gpu.rs` does it.

use wgpu::util::DeviceExt;

const PRELUDE: &str = include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/prelude.wgsl");

/// The K16 upsample's bilateral bandwidth, and the LOESS strength. Literals in the
/// reference's host too.
const K16_BW: f32 = 1.5;
const LOESS_STRENGTH: f32 = 1.0;

/// Workgroups for the IRLS reductions, and the invocations in each.
const DR_WORKGROUPS: u32 = 64;

/// What `pass12` needs of a workgroup: four tile planes of 40x40 f32.
const WORKGROUP_STORAGE: u32 = 4 * 40 * 40 * 4;

/// The tile `pass12` gives one workgroup, and the one `loess_chroma_3p_tiled` does.
const PASS12_TILE: u32 = 28;
const LOESS_TILE: u32 = 16;

/// One dispatch's scalars, as the uniform slot the kernel reads them from.
///
/// A slot each rather than a buffer each: WGSL has no push constants, so every kernel takes
/// its `Push` at binding 20 out of one buffer bound with a dynamic offset. 256 is the
/// alignment a dynamic offset is required to respect.
const SLOT: u64 = 256;

#[derive(Clone, Copy)]
enum Word {
    I(i32),
    F(f32),
}

/// Every dispatch's scalars, laid end to end in slots.
struct Pushes {
    bytes: Vec<u8>,
}

impl Pushes {
    /// Appends a slot and hands back the dynamic offset that binds it.
    fn add(&mut self, words: &[Word]) -> u32 {
        let at = self.bytes.len();
        for word in words {
            match word {
                Word::I(v) => self.bytes.extend_from_slice(&v.to_ne_bytes()),
                Word::F(v) => self.bytes.extend_from_slice(&v.to_ne_bytes()),
            }
        }
        self.bytes.resize(at + SLOT as usize, 0);
        at as u32
    }
}

struct Kernel {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
}

/// Every kernel, built once and kept for the process.
pub struct Galosh {
    ne_block_stats: Kernel,
    ne_finalize: Kernel,
    ne_dark_thresh_hist: Kernel,
    ne_dark_thresh_finalize: Kernel,
    ne_dark_lap_hist: Kernel,
    ne_dark_finalize: Kernel,
    gat_forward_full: Kernel,
    build_inv_lut: Kernel,
    lut_finalize: Kernel,
    sigma_per_cfa: Kernel,
    unified_sigma: Kernel,
    normalize_apply: Kernel,
    irls_seed: Kernel,
    dark_ref_reduce: Kernel,
    dark_ref_finalize: Kernel,
    dark_resid_reduce: Kernel,
    dark_resid_finalize: Kernel,
    dark_sub_full: Kernel,
    forward_l_stride1: Kernel,
    chroma_extract_halfres: Kernel,
    pass12: Kernel,
    lpixel_lh_den_fused: Kernel,
    box_downsample_2x: Kernel,
    box_downsample_2x_3p: Kernel,
    loess_chroma_3p_tiled: Kernel,
    crop_2d_topleft: Kernel,
    k16_jbu_3p: Kernel,
    pad_2d_edge: Kernel,
    smoothstep_blend_3p: Kernel,
    k16_inverse_fused: Kernel,
}

/// The denoise, or None where this adapter cannot run it.
///
/// None rather than a panic because the caller's answer is to skip the denoise and decode
/// the frame anyway: a photograph with its noise still in it is a far better outcome than a
/// failed import, and the two limits asked about below are the only ones a real adapter is
/// likely to miss.
pub fn device(gpu: &'static crate::gpu::Gpu) -> Option<&'static Galosh> {
    static BUILT: std::sync::OnceLock<Option<Galosh>> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Galosh::new(gpu)).as_ref()
}

impl Galosh {
    fn new(gpu: &crate::gpu::Gpu) -> Option<Galosh> {
        let limits = gpu.device.limits();
        // `pass12` holds its tile, both accumulators and the pilot in workgroup storage, and
        // `ne_finalize` its per-bin histograms. Both want more than the 16KB a WebGPU device
        // is only required to offer, so this is asked rather than assumed - a validation
        // failure would be fatal, since `on_uncaptured_error` panics.
        if limits.max_compute_workgroup_storage_size < WORKGROUP_STORAGE
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
        Some(Galosh {
            ne_block_stats: kernel(
                "ne_block_stats",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/ne_block_stats.wgsl"),
                &[(0, R), (1, W), (2, W)],
            ),
            ne_finalize: kernel(
                "ne_finalize",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/ne_finalize.wgsl"),
                &[(0, R), (1, R), (3, W)],
            ),
            ne_dark_thresh_hist: kernel(
                "ne_dark_thresh_hist",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/ne_dark_thresh_hist.wgsl"),
                &[(0, R), (1, W)],
            ),
            ne_dark_thresh_finalize: kernel(
                "ne_dark_thresh_finalize",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/ne_dark_thresh_finalize.wgsl"),
                &[(0, R), (1, W)],
            ),
            ne_dark_lap_hist: kernel(
                "ne_dark_lap_hist",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/ne_dark_lap_hist.wgsl"),
                &[(0, R), (1, R), (2, W)],
            ),
            ne_dark_finalize: kernel(
                "ne_dark_finalize",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/ne_dark_finalize.wgsl"),
                &[(0, R), (1, W)],
            ),
            gat_forward_full: kernel(
                "gat_forward_full",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/gat_forward_full.wgsl"),
                &[(0, R), (1, W), (6, R)],
            ),
            build_inv_lut: kernel(
                "build_inv_lut",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/build_inv_lut.wgsl"),
                &[(0, R), (1, W), (2, W), (3, W)],
            ),
            lut_finalize: kernel(
                "lut_finalize",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/lut_finalize.wgsl"),
                &[(0, R), (1, W)],
            ),
            sigma_per_cfa: kernel(
                "sigma_per_cfa",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/sigma_per_cfa.wgsl"),
                &[(0, R), (1, W)],
            ),
            unified_sigma: kernel(
                "unified_sigma",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/unified_sigma.wgsl"),
                &[(0, W)],
            ),
            normalize_apply: kernel(
                "normalize_apply",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/normalize_apply.wgsl"),
                &[(0, W), (5, R)],
            ),
            irls_seed: kernel("irls_seed", include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/irls_seed.wgsl"), &[(0, W)]),
            dark_ref_reduce: kernel(
                "dark_ref_reduce_mwg",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/dark_ref_reduce_mwg.wgsl"),
                &[(0, R), (1, R), (2, R), (3, W)],
            ),
            dark_ref_finalize: kernel(
                "dark_ref_finalize_mwg",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/dark_ref_finalize_mwg.wgsl"),
                &[(0, R), (1, W)],
            ),
            dark_resid_reduce: kernel(
                "dark_resid_reduce_mwg",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/dark_resid_reduce_mwg.wgsl"),
                &[(0, R), (1, R), (2, R), (3, W)],
            ),
            dark_resid_finalize: kernel(
                "dark_resid_finalize_mwg",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/dark_resid_finalize_mwg.wgsl"),
                &[(0, R), (1, W)],
            ),
            dark_sub_full: kernel(
                "dark_sub_full",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/dark_sub_full.wgsl"),
                &[(0, W), (5, R)],
            ),
            forward_l_stride1: kernel(
                "forward_l_stride1",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/forward_l_stride1.wgsl"),
                &[(0, R), (1, W)],
            ),
            chroma_extract_halfres: kernel(
                "chroma_extract_halfres",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/chroma_extract_halfres.wgsl"),
                &[(0, R), (1, W), (2, W), (3, W)],
            ),
            pass12: kernel("pass12", include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/pass12.wgsl"), &[(0, R), (1, W)]),
            lpixel_lh_den_fused: kernel(
                "lpixel_lh_den_fused",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/lpixel_lh_den_fused.wgsl"),
                &[(0, R), (1, W), (2, W)],
            ),
            box_downsample_2x: kernel(
                "box_downsample_2x",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/box_downsample_2x.wgsl"),
                &[(0, R), (1, W)],
            ),
            box_downsample_2x_3p: kernel(
                "box_downsample_2x_3p",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/box_downsample_2x_3p.wgsl"),
                &[(0, R), (1, R), (2, R), (3, W), (4, W), (5, W)],
            ),
            loess_chroma_3p_tiled: kernel(
                "loess_chroma_3p_tiled",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/loess_chroma_3p_tiled.wgsl"),
                &[(0, R), (1, R), (2, R), (3, R), (4, W), (5, W), (6, W)],
            ),
            crop_2d_topleft: kernel(
                "crop_2d_topleft",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/crop_2d_topleft.wgsl"),
                &[(0, R), (1, W)],
            ),
            k16_jbu_3p: kernel(
                "k16_jbu_3p",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/k16_jbu_3p.wgsl"),
                &[(0, R), (1, R), (2, R), (3, R), (4, W), (5, W), (6, W)],
            ),
            pad_2d_edge: kernel(
                "pad_2d_edge",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/pad_2d_edge.wgsl"),
                &[(0, R), (1, W)],
            ),
            smoothstep_blend_3p: kernel(
                "smoothstep_blend_3p",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/smoothstep_blend_3p.wgsl"),
                &[
                    (0, R),
                    (1, R),
                    (2, R),
                    (3, W),
                    (4, W),
                    (5, W),
                    (6, R),
                    (7, R),
                    (8, R),
                    (9, R),
                    (10, R),
                    (11, R),
                ],
            ),
            k16_inverse_fused: kernel(
                "k16_inverse_fused",
                include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/k16_inverse_fused.wgsl"),
                &[(0, R), (1, R), (2, R), (3, R), (4, W), (5, R), (6, R), (7, R), (8, R)],
            ),
        })
    }
}

/// How hard each half of the denoise works.
///
/// `luma` is the shrinkage threshold in units of the frame's own measured noise, so 1.0
/// means "threshold at exactly what the sensor put there"; the reference's default is 0.5.
/// `colour` walks four anchors - noisy, the half-res regression, the quarter-res level and
/// the eighth - so its unit is *how far colour may be smoothed*, in scales rather than in
/// amount, and it runs 0 to 3. Both zero is the frame untouched.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Amounts {
    pub luma: f32,
    pub colour: f32,
}

/// The sensor's noise, as Phase 0 fitted it off this frame.
///
/// A physical model rather than a slider position: the variance of a photosite reading a
/// signal `s` is `alpha * s + sigma_sq`, shot noise and read noise, both in the units the
/// mosaic was normalised into. Fitted from the frame's own statistics - the slope of
/// per-block variance against per-block level, and the Laplacians of the pixels its own
/// tenth percentile calls dark - so it needs no per-body profile and does not consult the
/// ISO, which by itself cannot tell a pushed exposure from a clean one.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoiseModel {
    pub alpha: f32,
    pub sigma_sq: f32,
}

impl NoiseModel {
    /// The noise a mid-grey photosite carries, as a standard deviation in [0, 1].
    ///
    /// One number for "how noisy is this frame", at the level where a denoise is judged.
    /// The reference uses the same statistic to decide a frame is clean enough to skip.
    pub fn at_mid_grey(&self) -> f32 {
        (self.alpha * 0.5 + self.sigma_sq).max(0.0).sqrt()
    }
}

impl Amounts {
    /// The Detail panel's two sliders, 0 to 100, in the units the kernels read.
    ///
    /// Scaled so the document's default of 40 lands on exactly the denoise the reference
    /// ships - a luma shrinkage of 0.5 and a colour walk of 1.0 - rather than putting that
    /// at a third of the way along and leaving the rest of the track to overshoot it. The
    /// top is 1.25 and 2.5, which is inside the range the reference tuned over.
    pub fn from_sliders(luminance: f64, colour: f64) -> Amounts {
        Amounts {
            luma: (luminance.clamp(0.0, 100.0) / 100.0 * 1.25) as f32,
            colour: (colour.clamp(0.0, 100.0) / 100.0 * 2.5) as f32,
        }
    }

    pub fn does_anything(&self) -> bool {
        self.luma > 0.0 || self.colour > 0.0
    }
}

/// A LOESS dispatch's seven buffers: the guide first, as the kernel declares them.
fn loess_binds<'a>(
    guide: &'a wgpu::Buffer,
    src: &'a [wgpu::Buffer; 3],
    dst: &'a [wgpu::Buffer; 3],
) -> [(u32, &'a wgpu::Buffer); 7] {
    [
        (0, guide),
        (1, &src[0]),
        (2, &src[1]),
        (3, &src[2]),
        (4, &dst[0]),
        (5, &dst[1]),
        (6, &dst[2]),
    ]
}

/// A K16 dispatch's seven: the three chroma planes first, the guide fourth.
fn k16_binds<'a>(
    src: &'a [wgpu::Buffer; 3],
    guide: &'a wgpu::Buffer,
    dst: &'a [wgpu::Buffer; 3],
) -> [(u32, &'a wgpu::Buffer); 7] {
    [
        (0, &src[0]),
        (1, &src[1]),
        (2, &src[2]),
        (3, guide),
        (4, &dst[0]),
        (5, &dst[1]),
        (6, &dst[2]),
    ]
}

/// The whole denoise: a mosaic in [0, 1] goes in, the same mosaic denoised comes back.
///
/// Even dimensions, because every phase pairs rows and columns into 2x2 CFA sites; the
/// caller trims an odd edge before it gets here.
///
/// ponytail: the frame is denoised whole, which at 61MP is a little over a gigabyte of
/// device buffers. Band it with an overlap if that ever fails to allocate - every phase but
/// the noise fit and the IRLS is local with a bounded halo, so the bands are independent.
pub fn denoise(
    gpu: &crate::gpu::Gpu,
    galosh: &Galosh,
    mosaic: &mut [f32],
    width: usize,
    height: usize,
    amounts: Amounts,
) -> NoiseModel {
    assert!(width % 2 == 0 && height % 2 == 0, "the mosaic's dimensions pair into 2x2 sites");
    assert_eq!(mosaic.len(), width * height, "one sample per photosite");

    let device = &gpu.device;
    let (w, h) = (width as i32, height as i32);
    let npix = width * height;
    let (hw, hh) = (width / 2, height / 2);
    let (cq_w, cq_h) = (hw / 2, hh / 2);
    let (ce_w, ce_h) = (cq_w / 2, cq_h / 2);
    // K16 writes exactly twice its input, so a level with an odd dimension is upsampled from
    // a cropped guide and edge-padded back out.
    let (kq_w, kq_h) = (2 * cq_w, 2 * cq_h);
    let (ke_w, ke_h) = (2 * ce_w, 2 * ce_h);

    let storage = wgpu::BufferUsages::STORAGE;
    let plane = |label: &str, len: usize| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: (len.max(1) * 4) as u64,
            usage: storage,
            mapped_at_creation: false,
        })
    };

    let raw = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("galosh raw"),
        size: (npix * 4) as u64,
        usage: storage | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    // A megabyte at a time, rather than one `Vec<u8>` of the whole frame: the intermediate
    // would be 240MB at 61MP, held beside a decode that is already the largest thing in the
    // process.
    const CHUNK: usize = 1 << 18;
    let mut bytes: Vec<u8> = Vec::with_capacity(CHUNK * 4);
    for (at, block) in mosaic.chunks(CHUNK).enumerate() {
        bytes.clear();
        for sample in block {
            bytes.extend_from_slice(&sample.to_ne_bytes());
        }
        gpu.queue.write_buffer(&raw, (at * CHUNK * 4) as u64, &bytes);
    }

    // Two full-resolution scratch planes carry four roles between them, because a plane at
    // 61MP is 240MB. `full_a` is the GAT frame until the chroma has been taken out of it,
    // then the shrinkage's output; `full_b` is the luma transform until `pass12` has read
    // it, then the overlap average that guides the chroma home.
    let full_a = plane("galosh in_gat / L_cs_den", npix);
    let full_b = plane("galosh L_cs / L_pixel", npix);

    // Copied back with the frame: what Phase 0 fitted is the only physical description of
    // this photograph's noise anything has, and a caller choosing an amount wants it.
    let params = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("galosh params"),
        size: 32 * 4,
        usage: storage | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let lut_d = plane("galosh lut_d", 4096);
    let lut_x = plane("galosh lut_x", 4096);
    let lut_params = plane("galosh lut_params", 8);
    let partial = plane("galosh partial", DR_WORKGROUPS as usize * 10);
    let partial_resid = plane("galosh partial resid", DR_WORKGROUPS as usize * 4);

    let (ne_bx, ne_by) = (hw / 8, hh / 8);
    let ne_per_ch = ne_bx * ne_by;
    let blk_mean = plane("galosh blk_mean", 4 * ne_per_ch);
    let blk_var = plane("galosh blk_var", 4 * ne_per_ch);
    let dark_thresh_hist = plane("galosh dark thresh hist", 4096);
    let dark_lap_hist = plane("galosh dark lap hist", 4096);

    let half = hw * hh;
    let quarter = cq_w * cq_h;
    let eighth = ce_w * ce_h;
    let l_h_den = plane("galosh L_h_den", half);
    let l_q = plane("galosh L_q", quarter);
    let l_e = plane("galosh L_e", eighth);
    let l_for_q = plane("galosh L_for_q", kq_w * kq_h);
    let l_for_e = plane("galosh L_for_e", ke_w * ke_h);
    let trio = |label: &str, len: usize| [plane(label, len), plane(label, len), plane(label, len)];
    let c_h = trio("galosh C_h", half);
    // The half-res regression, and where the blend writes its answer back: nothing reads the
    // regression again afterwards, so a fifth trio of half-res planes would only be moving
    // values between two addresses.
    let c_loess_h = trio("galosh C_loess_h / C_h_den", half);
    let c_q = trio("galosh C_q", quarter);
    let c_e = trio("galosh C_e", eighth);
    let c_loess_q = trio("galosh C_loess_q", quarter);
    let c_loess_e = trio("galosh C_loess_e", eighth);
    let c_q_up = trio("galosh C_q_up", half);
    let c_e_up = trio("galosh C_e_up", half);
    let c_e_to_q = trio("galosh C_e_to_q", quarter);
    // One scratch trio per scale, for the K16 whose output is not already the size its
    // consumer wants. The chains use them at different times, so one of each is enough - and
    // on a frame whose half-resolution dimensions are both even there is no padding at all.
    let padded_half = kq_w == hw && kq_h == hh;
    let padded_quarter = ke_w == cq_w && ke_h == cq_h;
    let scratch_half = trio("galosh K16 scratch", if padded_half { 0 } else { kq_w * kq_h });
    let scratch_quarter =
        trio("galosh K16 scratch", if padded_quarter { 0 } else { ke_w * ke_h });

    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("galosh readback"),
        size: (npix * 4) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let fitted = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("galosh fitted model"),
        size: 32 * 4,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut pushes = Pushes { bytes: Vec::new() };
    let wh = pushes.add(&[Word::I(w), Word::I(h)]);
    let block_stats = pushes.add(&[
        Word::I(w),
        Word::I(h),
        Word::I(ne_bx as i32),
        Word::I(ne_by as i32),
        Word::I(ne_per_ch as i32),
    ]);
    let finalize = pushes.add(&[Word::I(w), Word::I(h), Word::I(4 * ne_per_ch as i32)]);
    let thresh_slot = pushes.add(&[Word::I(15)]);
    let lap_hist = pushes.add(&[Word::I(w), Word::I(h), Word::I(15)]);
    let n_wg = pushes.add(&[Word::I(DR_WORKGROUPS as i32)]);
    let extract = pushes.add(&[Word::I(w), Word::I(h), Word::I(hw as i32), Word::I(hh as i32)]);
    let shrink = pushes.add(&[Word::I(w), Word::I(h), Word::F(amounts.luma)]);
    let overlap = pushes.add(&[Word::I(w), Word::I(h), Word::I(hw as i32)]);
    let down_h = pushes.add(&[Word::I(hw as i32), Word::I(hh as i32)]);
    let down_q = pushes.add(&[Word::I(cq_w as i32), Word::I(cq_h as i32)]);
    let loess_h = pushes.add(&[Word::I(hw as i32), Word::I(hh as i32), Word::F(LOESS_STRENGTH)]);
    let loess_q =
        pushes.add(&[Word::I(cq_w as i32), Word::I(cq_h as i32), Word::F(LOESS_STRENGTH)]);
    let loess_e =
        pushes.add(&[Word::I(ce_w as i32), Word::I(ce_h as i32), Word::F(LOESS_STRENGTH)]);
    let crop_q = pushes.add(&[
        Word::I(hw as i32),
        Word::I(hh as i32),
        Word::I(kq_w as i32),
        Word::I(kq_h as i32),
    ]);
    let crop_e = pushes.add(&[
        Word::I(cq_w as i32),
        Word::I(cq_h as i32),
        Word::I(ke_w as i32),
        Word::I(ke_h as i32),
    ]);
    let k16_q = pushes.add(&[Word::I(cq_w as i32), Word::I(cq_h as i32), Word::F(K16_BW)]);
    let k16_e = pushes.add(&[Word::I(ce_w as i32), Word::I(ce_h as i32), Word::F(K16_BW)]);
    let k16_final = pushes.add(&[Word::I(hw as i32), Word::I(hh as i32), Word::F(K16_BW)]);
    let pad_to_half = pushes.add(&[
        Word::I(kq_w as i32),
        Word::I(kq_h as i32),
        Word::I(hw as i32),
        Word::I(hh as i32),
    ]);
    let pad_to_quarter = pushes.add(&[
        Word::I(ke_w as i32),
        Word::I(ke_h as i32),
        Word::I(cq_w as i32),
        Word::I(cq_h as i32),
    ]);
    let blend = pushes.add(&[Word::I(hw as i32), Word::I(hh as i32), Word::F(amounts.colour)]);

    let uniforms = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("galosh pushes"),
        contents: &pushes.bytes,
        usage: wgpu::BufferUsages::UNIFORM,
    });

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

    let groups = |w: usize, h: usize, tile: u32| {
        ((w as u32).div_ceil(tile).max(1), (h as u32).div_ceil(tile).max(1))
    };
    let (fx, fy) = groups(width, height, 16);
    let (hx, hy) = groups(hw, hh, 16);
    let (qx, qy) = groups(cq_w, cq_h, 16);
    let (ex, ey) = groups(ce_w, ce_h, 16);
    let (kx, ky) = groups(kq_w, kq_h, 16);
    let (kex, key) = groups(ke_w, ke_h, 16);

    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        let mut run = |kernel: &Kernel, group: &wgpu::BindGroup, offset: u32, x: u32, y: u32| {
            pass.set_pipeline(&kernel.pipeline);
            pass.set_bind_group(0, group, &[offset]);
            pass.dispatch_workgroups(x, y, 1);
        };

        // Phase 0: the blind Poisson-Gaussian fit, off the frame's own statistics.
        let g = bind(&galosh.ne_block_stats, &[(0, &raw), (1, &blk_mean), (2, &blk_var)]);
        run(&galosh.ne_block_stats, &g, block_stats, (4 * ne_per_ch as u32).div_ceil(64).max(1), 1);
        let g = bind(&galosh.ne_finalize, &[(0, &blk_mean), (1, &blk_var), (3, &params)]);
        run(&galosh.ne_finalize, &g, finalize, 1, 1);
        let g = bind(&galosh.ne_dark_thresh_hist, &[(0, &raw), (1, &dark_thresh_hist)]);
        let (tx, ty) = groups((hw + 2) / 3, (hh + 2) / 3, 16);
        run(&galosh.ne_dark_thresh_hist, &g, wh, tx, ty);
        let g = bind(&galosh.ne_dark_thresh_finalize, &[(0, &dark_thresh_hist), (1, &params)]);
        run(&galosh.ne_dark_thresh_finalize, &g, thresh_slot, 1, 1);
        let g = bind(&galosh.ne_dark_lap_hist, &[(0, &raw), (1, &params), (2, &dark_lap_hist)]);
        run(&galosh.ne_dark_lap_hist, &g, lap_hist, hx, hy);
        let g = bind(&galosh.ne_dark_finalize, &[(0, &dark_lap_hist), (1, &params)]);
        run(&galosh.ne_dark_finalize, &g, thresh_slot, 1, 1);

        // Phase 1: into the GAT domain, and the table that comes back out of it.
        let g = bind(&galosh.gat_forward_full, &[(0, &raw), (1, &full_a), (6, &params)]);
        run(&galosh.gat_forward_full, &g, wh, fx, fy);
        let g =
            bind(&galosh.build_inv_lut, &[(0, &params), (1, &lut_d), (2, &lut_x), (3, &lut_params)]);
        run(&galosh.build_inv_lut, &g, wh, 16, 1);
        let g = bind(&galosh.lut_finalize, &[(0, &lut_d), (1, &lut_params)]);
        run(&galosh.lut_finalize, &g, wh, 1, 1);
        let g = bind(&galosh.sigma_per_cfa, &[(0, &full_a), (1, &params)]);
        run(&galosh.sigma_per_cfa, &g, wh, 4, 1);
        let g = bind(&galosh.unified_sigma, &[(0, &params)]);
        run(&galosh.unified_sigma, &g, wh, 1, 1);
        let g = bind(&galosh.normalize_apply, &[(0, &full_a), (5, &params)]);
        run(&galosh.normalize_apply, &g, wh, fx, fy);

        // Phase 2: the per-slot dark reference, by three IRLS iterations.
        let g = bind(&galosh.irls_seed, &[(0, &params)]);
        run(&galosh.irls_seed, &g, wh, 1, 1);
        let reduce =
            bind(&galosh.dark_ref_reduce, &[(0, &full_a), (1, &raw), (2, &params), (3, &partial)]);
        let reduce_fin = bind(&galosh.dark_ref_finalize, &[(0, &partial), (1, &params)]);
        let resid = bind(
            &galosh.dark_resid_reduce,
            &[(0, &full_a), (1, &raw), (2, &params), (3, &partial_resid)],
        );
        let resid_fin = bind(&galosh.dark_resid_finalize, &[(0, &partial_resid), (1, &params)]);
        for iteration in 0..3 {
            run(&galosh.dark_ref_reduce, &reduce, wh, DR_WORKGROUPS, 1);
            run(&galosh.dark_ref_finalize, &reduce_fin, n_wg, 1, 1);
            if iteration == 2 {
                break;
            }
            run(&galosh.dark_resid_reduce, &resid, wh, DR_WORKGROUPS, 1);
            run(&galosh.dark_resid_finalize, &resid_fin, n_wg, 1, 1);
        }
        let g = bind(&galosh.dark_sub_full, &[(0, &full_a), (5, &params)]);
        run(&galosh.dark_sub_full, &g, wh, fx, fy);

        // Phases 3 and 4: the 2x2 transform, luma at stride 1 and chroma per site.
        let g = bind(&galosh.forward_l_stride1, &[(0, &full_a), (1, &full_b)]);
        run(&galosh.forward_l_stride1, &g, wh, fx, fy);
        let g = bind(
            &galosh.chroma_extract_halfres,
            &[(0, &full_a), (1, &c_h[0]), (2, &c_h[1]), (3, &c_h[2])],
        );
        run(&galosh.chroma_extract_halfres, &g, extract, hx, hy);

        // Phase 5: the shrinkage. `full_a` held the GAT frame until the dispatch above.
        let g = bind(&galosh.pass12, &[(0, &full_b), (1, &full_a)]);
        let (px, py) = groups(width, height, PASS12_TILE);
        run(&galosh.pass12, &g, shrink, px, py);

        // Phase 6: the sixteen phases averaged back. `full_b` held the transform.
        let g = bind(&galosh.lpixel_lh_den_fused, &[(0, &full_a), (1, &full_b), (2, &l_h_den)]);
        run(&galosh.lpixel_lh_den_fused, &g, overlap, fx, fy);

        // Phase 7: the chroma pyramid, and the guided upsamples back up it.
        let g = bind(&galosh.box_downsample_2x, &[(0, &l_h_den), (1, &l_q)]);
        run(&galosh.box_downsample_2x, &g, down_h, qx, qy);
        let g = bind(&galosh.box_downsample_2x, &[(0, &l_q), (1, &l_e)]);
        run(&galosh.box_downsample_2x, &g, down_q, ex, ey);
        let g = bind(
            &galosh.box_downsample_2x_3p,
            &[(0, &c_h[0]), (1, &c_h[1]), (2, &c_h[2]), (3, &c_q[0]), (4, &c_q[1]), (5, &c_q[2])],
        );
        run(&galosh.box_downsample_2x_3p, &g, down_h, qx, qy);
        let g = bind(
            &galosh.box_downsample_2x_3p,
            &[(0, &c_q[0]), (1, &c_q[1]), (2, &c_q[2]), (3, &c_e[0]), (4, &c_e[1]), (5, &c_e[2])],
        );
        run(&galosh.box_downsample_2x_3p, &g, down_q, ex, ey);

        let g = bind(&galosh.loess_chroma_3p_tiled, &loess_binds(&l_h_den, &c_h, &c_loess_h));
        let (lx, ly) = groups(hw, hh, LOESS_TILE);
        run(&galosh.loess_chroma_3p_tiled, &g, loess_h, lx, ly);
        let g = bind(&galosh.loess_chroma_3p_tiled, &loess_binds(&l_q, &c_q, &c_loess_q));
        let (lx, ly) = groups(cq_w, cq_h, LOESS_TILE);
        run(&galosh.loess_chroma_3p_tiled, &g, loess_q, lx, ly);
        let g = bind(&galosh.loess_chroma_3p_tiled, &loess_binds(&l_e, &c_e, &c_loess_e));
        let (lx, ly) = groups(ce_w, ce_h, LOESS_TILE);
        run(&galosh.loess_chroma_3p_tiled, &g, loess_e, lx, ly);

        let g = bind(&galosh.crop_2d_topleft, &[(0, &l_h_den), (1, &l_for_q)]);
        run(&galosh.crop_2d_topleft, &g, crop_q, kx, ky);
        let g = bind(&galosh.crop_2d_topleft, &[(0, &l_q), (1, &l_for_e)]);
        run(&galosh.crop_2d_topleft, &g, crop_e, kex, key);

        let q_up_target = if padded_half { &c_q_up } else { &scratch_half };
        let e_to_q_target = if padded_quarter { &c_e_to_q } else { &scratch_quarter };
        let e_up_target = if padded_half { &c_e_up } else { &scratch_half };

        let g = bind(&galosh.k16_jbu_3p, &k16_binds(&c_loess_q, &l_for_q, q_up_target));
        run(&galosh.k16_jbu_3p, &g, k16_q, kx, ky);
        if !padded_half {
            for at in 0..3 {
                let g =
                    bind(&galosh.pad_2d_edge, &[(0, &scratch_half[at]), (1, &c_q_up[at])]);
                run(&galosh.pad_2d_edge, &g, pad_to_half, hx, hy);
            }
        }
        let g = bind(&galosh.k16_jbu_3p, &k16_binds(&c_loess_e, &l_for_e, e_to_q_target));
        run(&galosh.k16_jbu_3p, &g, k16_e, kex, key);
        if !padded_quarter {
            for at in 0..3 {
                let g =
                    bind(&galosh.pad_2d_edge, &[(0, &scratch_quarter[at]), (1, &c_e_to_q[at])]);
                run(&galosh.pad_2d_edge, &g, pad_to_quarter, qx, qy);
            }
        }
        let g = bind(&galosh.k16_jbu_3p, &k16_binds(&c_e_to_q, &l_for_q, e_up_target));
        run(&galosh.k16_jbu_3p, &g, k16_q, kx, ky);
        if !padded_half {
            for at in 0..3 {
                let g = bind(&galosh.pad_2d_edge, &[(0, &scratch_half[at]), (1, &c_e_up[at])]);
                run(&galosh.pad_2d_edge, &g, pad_to_half, hx, hy);
            }
        }

        // Phase 8: the colour strength, as a walk along those four anchors, answered back
        // over the regression it walks from.
        let g = bind(
            &galosh.smoothstep_blend_3p,
            &[
                (0, &c_h[0]),
                (1, &c_h[1]),
                (2, &c_h[2]),
                (3, &c_loess_h[0]),
                (4, &c_loess_h[1]),
                (5, &c_loess_h[2]),
                (6, &c_q_up[0]),
                (7, &c_q_up[1]),
                (8, &c_q_up[2]),
                (9, &c_e_up[0]),
                (10, &c_e_up[1]),
                (11, &c_e_up[2]),
            ],
        );
        run(&galosh.smoothstep_blend_3p, &g, blend, hx, hy);

        // Phases 9 and 10: upsampled and inverted in one pass, back over the input.
        let g = bind(
            &galosh.k16_inverse_fused,
            &[
                (0, &c_loess_h[0]),
                (1, &c_loess_h[1]),
                (2, &c_loess_h[2]),
                (3, &full_b),
                (4, &raw),
                (5, &lut_d),
                (6, &lut_x),
                (7, &lut_params),
                (8, &params),
            ],
        );
        run(&galosh.k16_inverse_fused, &g, k16_final, fx, fy);
    }
    encoder.copy_buffer_to_buffer(&raw, 0, &readback, 0, (npix * 4) as u64);
    encoder.copy_buffer_to_buffer(&params, 0, &fitted, 0, 32 * 4);
    gpu.queue.submit([encoder.finish()]);

    let slice = readback.slice(..);
    let model_slice = fitted.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    model_slice.map_async(wgpu::MapMode::Read, |_| {});
    device.poll(wgpu::PollType::wait_indefinitely()).expect("the denoise finished");
    {
        let mapped = slice.get_mapped_range().expect("the readback mapped");
        for (sample, word) in mosaic.iter_mut().zip(mapped.chunks_exact(4)) {
            *sample = f32::from_ne_bytes([word[0], word[1], word[2], word[3]]);
        }
    }
    let model = {
        let mapped = model_slice.get_mapped_range().expect("the model mapped");
        let at = |slot: usize| {
            let word = &mapped[slot * 4..slot * 4 + 4];
            f32::from_ne_bytes([word[0], word[1], word[2], word[3]])
        };
        NoiseModel { alpha: at(13), sigma_sq: at(14) }
    };
    readback.unmap();
    fitted.unmap();
    model
}

#[cfg(test)]
mod tests {
    use super::{Amounts, denoise, device};

    /// A synthetic frame: four flat CFA levels with Gaussian noise on top, and one hard
    /// vertical edge, so a test can ask both what was removed and what was kept.
    fn frame(width: usize, height: usize) -> Vec<f32> {
        let level = |slot: usize| [0.20, 0.34, 0.34, 0.12][slot];
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut noise = || {
            // xorshift, twice, summed: enough of a bell for a variance to mean something,
            // and deterministic so a failure is reproducible.
            let mut sum = 0.0;
            for _ in 0..2 {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                sum += (seed >> 40) as f32 / 16777216.0 - 0.5;
            }
            sum * 0.05
        };
        (0..width * height)
            .map(|at| {
                let (x, y) = (at % width, at / width);
                let slot = (y & 1) | ((x & 1) << 1);
                let bright = if x > width / 2 { 0.45 } else { 0.0 };
                (level(slot) + bright + noise()).clamp(0.0, 1.0)
            })
            .collect()
    }

    /// The variance of one CFA slot over a window, which is what the denoise is meant to
    /// take out of a flat field.
    fn variance(frame: &[f32], width: usize, x0: usize, y0: usize, size: usize) -> f32 {
        let at = |x: usize, y: usize| frame[y * width + x];
        let samples: Vec<f32> =
            (0..size).flat_map(|y| (0..size).map(move |x| (x, y))).map(|(x, y)| at(x0 + 2 * x, y0 + 2 * y)).collect();
        let mean = samples.iter().sum::<f32>() / samples.len() as f32;
        samples.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / samples.len() as f32
    }

    #[test]
    fn every_kernel_builds_and_the_frame_survives_it() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(galosh) = device(gpu) else {
            // An adapter under the workgroup-storage floor, which is a supported outcome.
            return;
        };

        let (width, height) = (256, 192);
        let noisy = frame(width, height);
        let mut denoised = noisy.clone();
        denoise(
            gpu,
            galosh,
            &mut denoised,
            width,
            height,
            Amounts { luma: 1.0, colour: 1.0 },
        );

        assert!(
            denoised.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)),
            "the inverse table's output is clamped to the unit interval",
        );

        // The flat left half loses most of its noise...
        let before = variance(&noisy, width, 8, 8, 40);
        let after = variance(&denoised, width, 8, 8, 40);
        assert!(
            after < before * 0.5,
            "a flat field should lose most of its variance: {before} -> {after}",
        );
        // ...and the edge in the middle is still an edge, rather than a ramp.
        let step = |frame: &[f32]| {
            let row = 96 * width;
            frame[row + width / 2 + 8] - frame[row + width / 2 - 8]
        };
        assert!(
            step(&denoised) > step(&noisy) * 0.9,
            "the edge should survive: {} -> {}",
            step(&noisy),
            step(&denoised),
        );
    }
}
