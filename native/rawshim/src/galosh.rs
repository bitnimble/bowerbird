//! GALOSH-RAW: the blind denoise, on the Bayer mosaic, on the GPU.
//!
//! Thirty-one compute kernels, and this file is the host that drives them.
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
//! The kernels are in `slang/galosh/` with every other shader, compiled at build time and
//! `include_str!`'d out of `OUT_DIR`. This module is the only thing that dispatches them either
//! way: a browser reaches these kernels through the wasm build of it rather than by binding them
//! itself.

/// The K16 upsample's bilateral bandwidth, and the LOESS strength.
const K16_BW: f32 = 1.5;
const LOESS_STRENGTH: f32 = 1.0;

/// The least luma, in the GAT's units, the chroma pyramid divides a colour difference by
/// (`loess_chroma_3p_tiled`, `k16_jbu_3p`); `renders --ratio-floor` sweeps it, and a floor of
/// zero is the pyramid on the differences themselves.
///
/// ponytail: zero, so the pyramid runs on the differences as it always did. On `synth_raw
/// --square`'s lines a floor of 0.5 kept a little more at noise 1 and amplified noise several-fold
/// at noise 4; most of what the colour walk loses is detail finer than a site, which a share of the
/// site's luma cannot carry either.
const RATIO_FLOOR: f32 = 0.0;

static FORCED_RATIO_FLOOR: crate::base::AtomicF32 = crate::base::AtomicF32::new(-1.0);

/// Hold every later denoise to this floor, or a negative for [`RATIO_FLOOR`].
pub fn force_ratio_floor(floor: f32) {
    FORCED_RATIO_FLOOR.set(floor);
}

/// Workgroups for the IRLS reductions, and the invocations in each.
///
/// **Wide enough that the reduction is not a serial walk.** These stride the whole frame five times
/// over - three IRLS iterations and two residual passes - and at 64 that is 16384 work items
/// sharing 6 million 2x2 blocks, about 366 apiece one after another. At 512 the cold denoise on a
/// 61MP frame runs 4080ms against 4187, measured on binaries built in advance and run back to back
/// on a quiet machine.
///
/// More partials is a different summation order in the finalize, so this is the one place in the
/// denoise that is not bit-identical across the change: differenced over 180 million samples, a
/// quarter of a percent of them move, by a mean of 0.003 counts of 65535. What pins it now is
/// `the_fit_is_the_one_this_sensor_has`, since nothing else reads the fit's absolute value.
const DR_WORKGROUPS: u32 = 512;

/// Sizes of the histograms and the table `prelude.slang` declares, held against its text by
/// `the_table_sizes_are_the_ones_the_shader_declares`.
const SIGMA_BINS: usize = 4096;
const DARK_HIST_BINS: usize = 4096;
const LUT_SIZE: usize = 4096;

/// `params_buf` slots, which are `prelude.slang`'s and must stay its.
///
/// Only the ones the host writes or reads are here; the kernels address the rest themselves. The
/// readback below and `NoiseFit`'s seeding are the two places this side touches the block, and
/// `the_params_slots_are_the_ones_the_shader_declares` holds these against the shader's own text.
const P_UNIFIED_SIGMA: usize = 4;
const P_INV_SG: usize = 5;
const P_DARK_REF0: usize = 6;
const P_ALPHA: usize = 13;
const P_SIGMA_SQ: usize = 14;

/// `prelude.slang`'s floor on the shot-noise slope, held against its text by
/// `the_alpha_floor_is_the_one_the_shader_declares`. The GAT divides by it; this is not a
/// judgement about how clean a sensor may be.
pub const ALPHA_MIN: f32 = 1e-8;

/// How far apart the four per-slot dark references may sit before the fit contradicts itself.
///
/// `dark_ref_reduce_mwg` only counts a 2x2 block whose four GAT samples lie within
/// `ACHROMATIC_RANGE` of each other - so every block the reference was fitted from was, by that
/// kernel's own definition, neutral to within this. A reference claiming the slots differ by more
/// than that is not describing a sensor with unusual offsets; it is describing something the
/// blocks it read cannot have said, which is what a reduction that came back wrong looks like.
/// Held against the shader by `the_achromatic_range_is_the_one_the_shader_declares`.
pub const ACHROMATIC_RANGE: f32 = 4.0;

/// What `pass12` needs of a workgroup: two 40x40 planes of `float2`, the sample beside its pilot
/// and the numerator beside its denominator.
const WORKGROUP_STORAGE: u32 = 2 * 40 * 40 * 8;

/// `pass12.slang`'s `PHASE_SPIN`, keyed by the id its `[vk::constant_id(0)]` fixes rather than by
/// name: the emitted WGSL renames it, and a key matching no constant is a pipeline the driver
/// refuses outright.
const PHASE_SPIN_ID: &str = "0";
const PHASE_SPIN_Y_ID: &str = "1";
const PHASE_DIAGONAL_ID: &str = "2";
/// `lpixel_lh_den_fused`'s, a different kernel with its own numbering.
const PHASE_POOL_ID: &str = "0";

/// How many of `pass12`'s sixteen phases to run.
///
/// **Two, on every frame, and down the diagonal.** Each phase shrinks the same neighbourhood at a
/// different offset, so the sixteen are estimates of the same block and averaging two lands where
/// averaging all sixteen does. What the averaging is *for*, though, is that no block boundary falls
/// in the same place twice, and two phases only manage that if they differ on both axes:
/// `PHASE_DIAGONAL` is what puts the second at (2, 2) rather than at (2, 0).
///
/// **A pair that spins the columns alone stripes a shadow.** Measured on `DSC05443`'s eaves at
/// slider 100, as the mean second difference of the crop's row means against its column means, a
/// ratio of one being a crop with no direction to it: column-only reads 0.570 down the rows against
/// 0.232 across them, a ratio of 2.46, and looks like horizontal lines once the sharpen's amount
/// multiplies it. The diagonal pair reads 0.220 against 0.278, and four phases 0.196 against 0.212
/// - no direction either way, and the same picture to the eye at 4x.
///
/// **Judged end to end against the camera's own JPEG, which is the only reference that can say
/// which of two renders is right rather than merely that they differ.** Each arm fits its own
/// camera match off its own denoised frame, so a shrinkage that cost the fit something would show
/// here. Over a whole 24MP frame the two arms land 2.343 and 2.352 counts of 255 from the camera;
/// on an ISO 25600 crop, 9.99 and 10.35. That comparison is what chose two - and it is worth
/// knowing what it cannot see, since it is a mean over a frame: a one-count pattern that follows
/// the rows moves it by nothing while being the first thing an eye finds. The row-against-column
/// figure above is what covers that, and it is the measurement to repeat if this number moves.
///
/// Four costs ~45ms more on a 24MP mosaic and buys nothing measurable here.
///
/// **Flat, rather than chosen per frame, because nothing about a frame predicts the cost.** Over 43
/// photographs from two libraries the deviation barely tracks the noise - `at_mid_grey` 0.00310 and
/// 0.00314 cost 1.23 and 3.51 counts of 65535, 0.00633 and 0.00753 cost 1.30 and 6.33 - so what
/// varies is the content, which no summary the fit carries can see.
///
/// Overridable, which is how those were measured and how `renders --phases` shows a reader the
/// difference.
fn phases() -> i32 {
    match FORCED_SPIN.load(std::sync::atomic::Ordering::Relaxed) {
        forced if forced > 0 => forced,
        _ => 2,
    }
}

/// The phase count every later run uses, or 0 for [`phases`]'s own answer.
static FORCED_SPIN: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// Hold every later denoise to this many phases: 2, 4, 8, 16, or 0 for the default.
pub fn force_phases(phases: i32) {
    FORCED_SPIN.store(phases, std::sync::atomic::Ordering::Relaxed);
}

/// Whether the luma phases pool before the inverse (`lpixel_lh_den_fused`).
///
/// Overridable for the same reason `phases` is: the pooling is a low-pass on luma that runs at every
/// amount including zero, and what that costs a frame is a picture question.
fn phase_pooled() -> bool {
    !UNPOOLED.load(std::sync::atomic::Ordering::Relaxed)
}

static UNPOOLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Hold every later denoise to the inverse with or without the phase pooling.
pub fn force_phase_pool(pooled: bool) {
    UNPOOLED.store(!pooled, std::sync::atomic::Ordering::Relaxed);
}

static UNBRACKETED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Hold every later denoise to smoothing the chroma with or without `chroma_detail`'s bracket.
pub fn force_chroma_detail(bracketed: bool) {
    UNBRACKETED.store(!bracketed, std::sync::atomic::Ordering::Relaxed);
}

/// How far a coarser chroma level may move the finer one, in the GAT's unit noise
/// (`smoothstep_blend_3p`'s `reached`); `renders --reach` sweeps it.
///
/// **Two measurements pull on it.** On `synth_raw --square` at Colour 100, red across the step runs
/// `176 167 158 148 139 131` ungated, `242 180 122 124` at 1.5 - Colour 0's own edge - and leaks
/// again at three. On `DSC05282`'s night sky at Colour 76 the 32-pixel mottle reads 0.71 ungated,
/// 1.19 with Colour off, 1.07 at one and 0.93 from 1.5 up to five: that sky's low-frequency chroma
/// stands several sigma off the white-noise model, so a tighter reach hands it back.
const LEVEL_REACH: f32 = 1.5;

static FORCED_LEVEL_REACH: crate::base::AtomicF32 = crate::base::AtomicF32::new(-1.0);

/// Hold every later denoise to this reach, or a negative for [`LEVEL_REACH`].
pub fn force_level_reach(reach: f32) {
    FORCED_LEVEL_REACH.set(reach);
}

/// The tile `pass12` gives one workgroup, and the one `loess_chroma_3p_tiled` does.
const PASS12_TILE: u32 = 28;

/// What a region's origin has to be a multiple of for its denoise to be the frame's.
///
/// **`pass12` shrinks within a tile measured from the region's own origin**, so a region that
/// starts off this grid shrinks every pixel against a different neighbourhood - 94% of a 61MP
/// frame comes out different, by up to 1.6e-3, spread everywhere rather than banded at the seams.
/// Doubled because the alignment must also be even: an odd origin relabels every colour, since
/// every phase pairs samples into 2x2 CFA sites. Whether even is *enough* is the pattern's to say,
/// which is what [`lattice`] asks it.
///
/// **And scaled by [`COARSE_SCALE`], because the coarse level shrinks on a grid of its own.** Its
/// tiles are measured from the region's origin *divided* by that scale, so an origin aligned only
/// for the full-resolution pass lands mid-tile down there and the same disagreement comes back one
/// octave down, where it is `tiling_the_denoise_does_not_move_a_sample` that catches it.
///
/// `denoise_in_tiles` rounds to this for its own tiles; anything else cutting a window it intends
/// to compare against the whole frame - a band of the editor's re-prepare - owes it the same.
pub const SHRINK_LATTICE: usize = COARSE_SCALE as usize * PASS12_TILE as usize;
const LOESS_TILE: u32 = 16;

/// The grid a region's origin has to start on, per axis, for its denoise to be the frame's.
///
/// Two claims on one number: [`SHRINK_LATTICE`] is the shrinkage's, and a whole period of the
/// pattern is the CFA's, since every kernel that asks a photosite's colour asks it of the region's
/// own coordinates. So an origin owes the first multiple of the lattice that is also a whole number
/// of periods. Bayer's two divides the lattice and this is the lattice itself; X-Trans's six does
/// not, and the answer is three times it.
pub fn lattice(cfa: &crate::cfa::Cfa) -> (usize, usize) {
    let step = |period: usize| {
        let (mut a, mut b) = (SHRINK_LATTICE, period);
        while b != 0 {
            (a, b) = (b, a % b);
        }
        SHRINK_LATTICE / a * period
    };
    let (pw, ph) = cfa.period();
    (step(pw), step(ph))
}

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
    /// What the dispatch sweep calls it. The chain records into one encoder, so a truncated run is
    /// the only way to price a single kernel - and a count with no name is a number nobody can act
    /// on without counting `run` calls by hand down the length of `run`.
    name: &'static str,
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
    sigma_per_cfa_merge: Kernel,
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
    chroma_detail: Kernel,
    pass12: Kernel,
    /// The same kernel striding the row phases alone, which runs eight of the sixteen.
    pass12_half: Kernel,
    /// And striding both, which runs four.
    pass12_quarter: Kernel,
    /// Two phases down the diagonal, at (0, 0) and (2, 2), which is the fewest that spins both axes.
    pass12_pair: Kernel,
    lpixel_lh_den_fused: Kernel,
    box_downsample_2x: Kernel,
    coarse_smooth: Kernel,
    coarse_correct: Kernel,
    loess_chroma_3p_tiled: Kernel,
    k16_jbu_3p: Kernel,
    copy_2d_clamped: Kernel,
    smoothstep_blend_3p: Kernel,
    weigh_green_difference: Kernel,
    k16_inverse_fused: Kernel,
    lpixel_lh_den_unpooled: Kernel,
}

/// Whether this pattern's mosaic is one GALOSH can filter at all.
///
/// **What the chain needs of a pattern is that one period of it holds all three colours**, since
/// that is what `chroma_extract_halfres` takes its three means over and what `chroma_weights` then
/// puts back. Everything else reads the period out of its own push and is arithmetic that does not
/// care how wide it is.
///
/// **Asked of the pattern, and not of the frame's dimensions, which is the trap this exists for.**
/// The only gate before this was `run`'s assertion that both extents are even - and an X-Trans
/// region satisfies that by accident, because a multiple of six is.
pub fn filters(cfa: &crate::cfa::Cfa) -> bool {
    cfa.counts().iter().all(|&count| count > 0)
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
        let limits = gpu.limits();
        // `pass12` holds its tile, both accumulators and the pilot in workgroup storage, and
        // `ne_finalize` its per-bin histograms. Both want more than the 16KB a WebGPU device
        // is only required to offer, so this is asked rather than assumed - a validation
        // failure would be fatal, since `on_uncaptured_error` panics.
        if limits.max_compute_workgroup_storage_size < WORKGROUP_STORAGE
            || limits.max_compute_invocations_per_workgroup < 256
        {
            return None;
        }

        let device = gpu.describing();
        let build = |name: &'static str,
                     body: &str,
                     bindings: &[(u32, bool)],
                     constants: &[(&str, f64)]|
         -> Kernel {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(name),
                source: wgpu::ShaderSource::Wgsl(body.into()),
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
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants,
                    ..Default::default()
                },
                cache: None,
            });
            Kernel { pipeline, layout, name }
        };

        // The entry point and the file are one name in every kernel here, so it is written once.
        macro_rules! kernel {
            ($name:literal, $bindings:expr) => {
                kernel!($name, $bindings, &[])
            };
            ($name:literal, $bindings:expr, $constants:expr) => {
                build(
                    $name,
                    include_str!(concat!(env!("OUT_DIR"), "/wgsl/galosh/", $name, ".wgsl")),
                    $bindings,
                    $constants,
                )
            };
        }

        const R: bool = true;
        const W: bool = false;
        Some(Galosh {
            ne_block_stats: kernel!("ne_block_stats", &[(0, R), (1, W), (2, W)]),
            ne_finalize: kernel!("ne_finalize", &[(0, R), (1, R), (3, W)]),
            ne_dark_thresh_hist: kernel!("ne_dark_thresh_hist", &[(0, R), (1, W)]),
            ne_dark_thresh_finalize: kernel!("ne_dark_thresh_finalize", &[(0, R), (1, W)]),
            ne_dark_lap_hist: kernel!("ne_dark_lap_hist", &[(0, R), (1, R), (2, W)]),
            ne_dark_finalize: kernel!("ne_dark_finalize", &[(0, R), (1, W)]),
            gat_forward_full: kernel!("gat_forward_full", &[(0, R), (1, W), (6, R)]),
            build_inv_lut: kernel!("build_inv_lut", &[(0, R), (1, W), (2, W), (3, W)]),
            lut_finalize: kernel!("lut_finalize", &[(0, R), (1, W)]),
            sigma_per_cfa: kernel!("sigma_per_cfa", &[(0, R), (1, W)]),
            sigma_per_cfa_merge: kernel!("sigma_per_cfa_merge", &[(0, R), (1, W)]),
            unified_sigma: kernel!("unified_sigma", &[(0, W)]),
            normalize_apply: kernel!("normalize_apply", &[(0, W), (5, R)]),
            irls_seed: kernel!("irls_seed", &[(0, W)]),
            dark_ref_reduce: kernel!("dark_ref_reduce_mwg", &[(0, R), (1, R), (2, R), (3, W)]),
            dark_ref_finalize: kernel!("dark_ref_finalize_mwg", &[(0, R), (1, W)]),
            dark_resid_reduce: kernel!("dark_resid_reduce_mwg", &[(0, R), (1, R), (2, R), (3, W)]),
            dark_resid_finalize: kernel!("dark_resid_finalize_mwg", &[(0, R), (1, W)]),
            dark_sub_full: kernel!("dark_sub_full", &[(0, W), (5, R)]),
            forward_l_stride1: kernel!("forward_l_stride1", &[(0, R), (1, W), (2, R), (3, R)]),
            chroma_extract_halfres: kernel!(
                "chroma_extract_halfres",
                &[(0, R), (1, W), (2, W), (3, W)]
            ),
            chroma_detail: kernel!(
                "chroma_detail",
                &[(0, R), (1, W), (2, W), (3, W), (4, W), (5, W), (6, W)]
            ),
            pass12: kernel!("pass12", &[(0, R), (1, W)]),
            pass12_half: kernel!("pass12", &[(0, R), (1, W)], &[(PHASE_SPIN_Y_ID, 2.0)]),
            pass12_quarter: kernel!(
                "pass12",
                &[(0, R), (1, W)],
                &[(PHASE_SPIN_ID, 2.0), (PHASE_SPIN_Y_ID, 2.0)]
            ),
            pass12_pair: kernel!(
                "pass12",
                &[(0, R), (1, W)],
                &[(PHASE_SPIN_ID, 2.0), (PHASE_SPIN_Y_ID, 4.0), (PHASE_DIAGONAL_ID, 1.0)]
            ),
            lpixel_lh_den_fused: kernel!("lpixel_lh_den_fused", &[(0, R), (1, W), (2, W)]),
            lpixel_lh_den_unpooled: kernel!(
                "lpixel_lh_den_fused",
                &[(0, R), (1, W), (2, W)],
                &[(PHASE_POOL_ID, 0.0)]
            ),
            box_downsample_2x: kernel!("box_downsample_2x", &[(0, R), (1, W)]),
            loess_chroma_3p_tiled: kernel!(
                "loess_chroma_3p_tiled",
                &[(0, R), (1, R), (2, R), (3, R), (4, W), (5, W), (6, W)]
            ),
            coarse_smooth: kernel!("coarse_smooth", &[(0, R), (1, W)]),
            coarse_correct: kernel!("coarse_correct", &[(0, R), (1, R), (2, W)]),
            k16_jbu_3p: kernel!(
                "k16_jbu_3p",
                &[(0, R), (1, R), (2, R), (3, R), (4, W), (5, W), (6, W)]
            ),
            copy_2d_clamped: kernel!("copy_2d_clamped", &[(0, R), (1, W)]),
            smoothstep_blend_3p: kernel!(
                "smoothstep_blend_3p",
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
                ]
            ),
            weigh_green_difference: kernel!(
                "weigh_green_difference",
                &[(0, R), (1, R), (3, W), (4, W)]
            ),
            k16_inverse_fused: kernel!(
                "k16_inverse_fused",
                &[(0, R), (1, R), (2, R), (3, R), (4, W), (5, R), (6, R), (7, R), (8, R)]
            ),
        })
    }
}

/// How hard each half of the denoise works.
///
/// `luma` is the shrinkage threshold in units of the frame's own measured noise, so 1.0
/// means "threshold at exactly what the sensor put there".
/// `colour` walks four anchors - noisy, the half-res regression, the quarter-res level and the
/// eighth - so its unit is *how far colour may be smoothed*, in scales rather than in
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

/// Everything the denoise reduces over the whole frame before any pixel is filtered.
///
/// **The reason this is a type rather than a local.** Every one of these is a *whole-frame*
/// statistic, so a denoise given a region fits a different one - and a loupe tile is a region.
/// Measured on the two fixtures, a 512px tile's noise came out between 0.49 and 1.51 times its own
/// frame's, which is the strength the tile is then denoised at: the magnifier disagreeing with the
/// export it exists to predict, and moving as the reader pans. Handing the frame's own fit back to
/// the tile is what makes the two the same picture (§10.9).
///
/// Geometry-independent, which is what makes one fit answer for every consumer: the halving
/// decision happens *after* the denoise, so this is always measured over the full-resolution
/// mosaic whatever size the caller asked the decode for.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseFit {
    pub alpha: f32,
    pub sigma_sq: f32,
    /// The RMS of the four per-CFA sigmas, which is the only form anything downstream reads.
    pub unified_sigma: f32,
    /// One per position of the 2x2, subtracted before the transform and added back after it.
    pub dark_ref: [f32; 4],
}

impl NoiseFit {
    /// The model the rest of the pipeline describes a frame's noise with.
    pub fn model(&self) -> NoiseModel {
        NoiseModel { alpha: self.alpha, sigma_sq: self.sigma_sq }
    }

    /// Whether this is a fit anything should be handed, rather than one to refuse and refit.
    ///
    /// It crosses the API from a client, so it is not the decode's own arithmetic. The
    /// bounds are deliberately wide - this is a guard against a corrupted or invented payload, not
    /// a judgement about what a sensor may do - but `alpha` at zero would divide by it in the GAT
    /// and a negative sigma would `sqrt` to a NaN that reaches every pixel. A slope merely *under*
    /// [`ALPHA_MIN`] is not refused here: the seed floors it, and refusing would refit on the
    /// tile, which is the wrong strength this fit crosses the wire to avoid.
    pub fn usable(&self) -> bool {
        let finite = |v: f32| v.is_finite();
        finite(self.alpha)
            && self.alpha > 0.0
            && finite(self.sigma_sq)
            && self.sigma_sq >= 0.0
            && finite(self.unified_sigma)
            && self.unified_sigma > 0.0
            && self.dark_ref.iter().all(|v| finite(*v))
            && self.dark_ref_is_self_consistent()
    }

    /// Whether the four per-slot references agree to within the neutrality they were fitted from.
    ///
    /// Not a judgement about a sensor either: [`ACHROMATIC_RANGE`] says why the bound is the
    /// kernel's own. What it catches is the failure that has no other symptom - the four offsets
    /// are subtracted per CFA slot and added back, so a set that has drifted apart pushes each
    /// channel a different way and the frame comes back in saturated primaries with its structure
    /// intact, which reads as a rendered picture rather than a broken one.
    fn dark_ref_is_self_consistent(&self) -> bool {
        let lo = self.dark_ref.iter().copied().fold(f32::INFINITY, f32::min);
        let hi = self.dark_ref.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        hi - lo <= ACHROMATIC_RANGE
    }
}

impl NoiseModel {
    /// The noise a mid-grey photosite carries, as a standard deviation in [0, 1].
    ///
    /// One number for "how noisy is this frame", at the level where a denoise is judged.
    pub fn at_mid_grey(&self) -> f32 {
        (self.alpha * 0.5 + self.sigma_sq).max(0.0).sqrt()
    }

    /// The same at full scale, which is the most any photosite in the frame carries.
    ///
    /// **What a bound wants, where `at_mid_grey` is what an estimate wants.** `alpha.s` is largest
    /// here, so a ceiling built on this sits above every photosite rather than beside the average
    /// one.
    ///
    /// Note this is the *model's* sigma, in the mosaic's own units. `NoiseFit::unified_sigma` is a
    /// GAT-domain figure that reads near 1.2 whatever the exposure, so anything comparing against a
    /// fraction of full scale wants this and not that.
    pub fn at_white(&self) -> f32 {
        (self.alpha + self.sigma_sq).max(0.0).sqrt()
    }

    /// The read-noise floor, which is what says how noisy a *photograph* is.
    ///
    /// **`sigma_sq` and not `alpha`, because only one of the two is measured robustly.** The slope
    /// comes from a regression of per-block variance against per-block level, so it needs the frame
    /// to offer a spread of levels with enough blocks in each; a night frame that is mostly black
    /// does not, and the fit collapses. Measured over a 42-frame library, `alpha` reads 0.000005 on
    /// an ISO 3200 frame and 0.000024 on an ISO 12800 one, against 0.001258 for another frame at
    /// that same 12800 - fifty times under, on exactly the photographs a denoise is for. The read
    /// term is taken instead from the Laplacians of the pixels the frame's own tenth percentile
    /// calls dark, which is a direct estimate and needs no spread, and it stays ordered with ISO
    /// across the whole library: 0.17 to 0.52 at base, 1.88 to 2.75 at 8000 and above (x10^-3).
    pub fn read_noise(&self) -> f32 {
        self.sigma_sq.max(0.0).sqrt()
    }

    /// What the Detail sliders should read on this frame, 0 to 100, where nobody has said.
    ///
    /// **A slider position is already relative, and that is exactly why it cannot be fixed.** The
    /// shrinkage normalises the plane to the frame's own sigma before it runs, so one position is
    /// the same *ratio* on every photograph - and what a reader sees is not the ratio but what is
    /// left, which is that ratio times however much noise there was. Measured on the first band of
    /// an a trous decomposition of an undenoised render, base-ISO daylight sits at 0.5 to 1.0 and
    /// these night frames at 4.5 to 6.9, so one number cannot serve both: it is either nothing on
    /// the first or a third of the job on the second.
    ///
    /// The gate sits above where this library's base-ISO frames read, so a daylight frame is
    /// declined outright rather than put through the whole chain to be left alone.
    ///
    /// **The span puts `DSC00982` at 40, and the direction it errs in is the point.** That frame is
    /// ISO 12800 and the noisiest here, so the suggestion reaches nothing like the end of the track
    /// and the upper half is left to a reader who wants it - which is deliberate: what is lost to
    /// under-denoising is grain, and grain still reads as a photograph, where what is lost to
    /// over-denoising is the texture itself and no slider brings it back. Judged against the body's
    /// own JPEG of the frame, 40 keeps the faint detail the track's three-quarter point was already
    /// softening.
    pub fn suggested_amount(&self) -> f64 {
        const GATE: f32 = 0.0006;
        const SPAN: f32 = 0.00539;
        let over = self.read_noise() - GATE;
        if over <= 0.0 {
            return 0.0;
        }
        f64::from(100.0 * over / SPAN).clamp(0.0, 100.0)
    }

    /// The pair, since the two halves do not want the same number.
    ///
    /// **Colour runs ahead of luminance** for the reason the schema gives about their defaults: the
    /// failure on the luminance side is grain, which still reads as a photograph, and on the colour
    /// side is mottle, which never does.
    pub fn suggested_amounts(&self) -> (f64, f64) {
        let luma = self.suggested_amount();
        (luma, (luma * COLOUR_LEAD).min(100.0))
    }
}

/// What the top of the Luminance track asks the kernels for.
const TRACK_TOP: f64 = 1.6;

/// How far ahead of luminance the suggestion runs colour, as the panel's own numbers - the two
/// tracks do not share a top, so this is a lead on the slider a reader sees rather than on the
/// amount the kernels are handed.
///
/// **A lot rather than a little, because what the top of the track buys is mottle** tens of pixels
/// across, which lives in the top third of the track and nowhere else: measured on `DSC05282` at
/// ISO 4000, the à trous band whose hole is 32 reads 0.35 codes at two thirds of the track against
/// 0.13 at the end of it, and the difference is visible on a night sky.
const COLOUR_LEAD: f64 = 3.2;

/// What the top of the Colour track asks for, which is not the same number and not the same unit.
///
/// **Colour's track is a distance, and 3.0 is the end of it rather than a strength chosen.** The
/// shrinkage's amount is a multiple of the measured noise and has no natural ceiling, which is why
/// [`TRACK_TOP`] had to be fitted to where a photograph stopped surviving. This one is a position
/// across four anchors - noisy, the half-resolution regression, the quarter-resolution level, the
/// eighth - and `smoothstep_blend_3p` returns the last anchor exactly at 3.0 and nothing further
/// above it.
///
/// **The top third is where the mottle a reader actually complains about lives.** Every level below
/// the eighth reaches tens of sensor pixels at most, so chroma structure wider than that survives a
/// walk that ends on the quarter-resolution one: measured on `DSC05282`, an ISO 4000 night frame,
/// the à trous band whose hole is 32 reads 0.87 on an undenoised render and 0.35 where the third
/// anchor ends the walk, two fifths of it still there. The last third is what takes it to 0.13.
///
/// **And the last fifth of the track costs colour detail, which is why the ramp stops short of
/// it.** The eighth level comes up two guided upsamples, each with the half-pixel siting bias
/// `k16_jbu_3p` records, so chroma arrives translated against luma by more than a level's worth.
/// On dense coloured detail that reads as a hue shift rather than as smoothing: measured on
/// `DSC05282`'s planting, greens go olive and the chroma roughness at the pixel's own scale
/// *doubles* between sliders 75 and 85, where the smoothstep hands the eighth level the majority
/// of the blend. A reader who wants the flattest sky can still ask for it.
const COLOUR_TRACK_TOP: f64 = 3.0;

impl Amounts {
    /// The Detail panel's two sliders, 0 to 100, in the units the kernels read.
    ///
    /// **One position, two units, and the landmark is not in the same place on each.** Luminance is
    /// a multiple of the noise Phase 0 measured, calibrated at 1.0 and so at slider 62.5, with the
    /// track above that as headroom against the fit reading low - which it does on a frame whose
    /// quietest blocks still hold texture. [`TRACK_TOP`] stops short of twice calibrated because
    /// the track ran past what a photograph survives: at 2.0 the noisiest frame in the library was
    /// not denoised but blurred. Colour is a distance rather than a strength, each whole number of
    /// it one more anchor up the pyramid, and [`COLOUR_TRACK_TOP`] is the end of what the blend
    /// answers to rather than a strength anyone chose.
    ///
    /// What the two share is the rule that a position is a fraction of a track a reader drags, so
    /// the useful thing for it to reach is the strongest setting worth shipping.
    pub fn from_sliders(luminance: f64, colour: f64) -> Amounts {
        Amounts {
            luma: (luminance.clamp(0.0, 100.0) / 100.0 * TRACK_TOP) as f32,
            colour: (colour.clamp(0.0, 100.0) / 100.0 * COLOUR_TRACK_TOP) as f32,
        }
    }

    pub fn does_anything(&self) -> bool {
        self.luma > 0.0 || self.colour > 0.0
    }
}

/// The Detail panel's two sliders as a document holds them, either of which may be unset.
///
/// **Unset is not zero and not a number a schema could supply: it is this photograph's own.** A
/// position is a fraction of a track, and what a reader sees at one is that fraction of however
/// much noise the frame happened to carry - so no fixed pair suits both a base-ISO daylight frame
/// and an ISO 12800 one. On the colour half that is not a matter of degree: the amount is a
/// *distance* rather than a strength, so a default high enough to take the mottle off a night sky
/// is the same default that smooths real colour out of a clean frame, whatever its noise. Left
/// unset a slider is [`NoiseModel::suggested_amounts`] off the fit of the frame being decoded.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Detail {
    pub luminance: Option<f64>,
    pub colour: Option<f64>,
}

impl Detail {
    /// Both halves as a reader set them.
    pub const fn at(luminance: f64, colour: f64) -> Detail {
        Detail { luminance: Some(luminance), colour: Some(colour) }
    }

    /// Neither, which is what a document that has never been edited holds.
    pub const AUTO: Detail = Detail { luminance: None, colour: None };

    /// Whether either half is still a measurement rather than a number.
    pub fn needs_a_fit(&self) -> bool {
        self.luminance.is_none() || self.colour.is_none()
    }

    /// Whether a decode has to measure before it can say the denoise does nothing.
    ///
    /// **The only honest answer before a fit, and the one the gates want**: an unset slider may
    /// resolve to anything the ramp allows, including the zero a clean frame is declined at, so a
    /// decode that skipped GALOSH on this would be deciding the amount by refusing to measure it.
    pub fn could_do_anything(&self) -> bool {
        self.luminance.unwrap_or(100.0) > 0.0 || self.colour.unwrap_or(100.0) > 0.0
    }

    /// The two positions a panel shows for this photograph, 0 to 100.
    ///
    /// A fit of `None` answers an unset slider with nothing, which is the only thing a caller with
    /// no measurement can say: every path that can reach a mosaic measures one first, and a
    /// finished picture has no photosites to fit.
    ///
    /// **Rounded to the track a reader drags**, which `EditDoc` stores as an integer: what the
    /// panel shows, what a drag starts from and what the kernels are handed all come through here,
    /// so a ramp answering 75.2 would show 75 and render something else.
    pub fn resolved(&self, fit: Option<NoiseFit>) -> (f64, f64) {
        let (luma, colour) = match fit {
            Some(fit) => fit.model().suggested_amounts(),
            None => (0.0, 0.0),
        };
        (self.luminance.unwrap_or(luma.round()), self.colour.unwrap_or(colour.round()))
    }

    /// The same pair in the units the kernels read.
    pub fn amounts(&self, fit: Option<NoiseFit>) -> Amounts {
        let (luminance, colour) = self.resolved(fit);
        Amounts::from_sliders(luminance, colour)
    }
}

/// **A coarse luma level was built here and removed, and the reason is worth keeping.** An 8x8
/// block's DC is its own mean, which nothing inside the block distinguishes from the picture, so a
/// second shrinkage an octave or two down looks like the way to reach it - and by the octave bands
/// of an a trous decomposition it was: the 4- and 8-pixel bands went from 0.84 and 0.80 to 0.41 and
/// 0.44 on DSC00982's out-of-focus background.
///
/// What those bands could not show is that the correction is itself made of blocks. At a quarter
/// resolution an 8x8 block spans 32 photosites, and a bilinear upsample of a block-shaped
/// correction is a soft-edged rectangle; against flat bokeh nothing appears, and against the
/// lettering on the stake the picture came back covered in hard rectangular patches. The phase spin
/// does not save it - at every phase the blocking is still there, because what is blocky is the
/// correction and not the tiling - and it was validated on a featureless crop, which is exactly the
/// one place the defect cannot be seen.
///
/// Whatever reaches that band next has to produce a *smooth* correction, not a block-shaped one.
///
/// Full-resolution pixels to one of that level's, kept because `SHRINK_LATTICE` is still stated in
/// terms of it: a region's origin has to suit the coarsest grid any pass might use.
pub const COARSE_SCALE: i32 = 4;

/// How far two of that band's samples may differ and still pool, per unit of the Luminance slider.
///
/// In the plane's own units, where a full-resolution GAT sample's noise is one and two box averages
/// have taken it down. Above the noise the bilateral pools and the band's mottle goes; below a real
/// eight-pixel edge it stops, which is what keeps this from flattening a face.
const COARSE_RANGE: f32 = 2.0;


/// How many dispatches a run records before it stops, which is `usize::MAX` for everything but
/// the profile sweep.
///
/// Set by `examples/open_bench.rs` to price the chain one kernel at a time: sweeping the count and
/// differencing consecutive runs is what says which of the twenty dispatches a call's cost is in,
/// and that is not answerable from the outside - the whole chain records into one encoder, so it
/// submits and completes as a unit. A count rather than a phase because the question the sweep was
/// written for turned out to be "which kernel", not "which phase".
///
/// The buffers stay sized for the whole run, so a truncated call differs from a full one only in
/// the dispatches it did not record. That is what makes the difference between two counts the cost
/// of the kernels between them, rather than the cost of a differently-shaped allocation.
static STOP_AFTER: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(usize::MAX);

pub fn stop_after(dispatches: usize) {
    STOP_AFTER.store(dispatches, std::sync::atomic::Ordering::Relaxed);
}

/// How many 8x8 blocks a channel's noise fit is measured from, before the stride below.
///
/// The fit is a line through a cloud of (block mean, block variance) points, binned into 32 mean
/// bins and reduced to a low percentile inside each. Thirty thousand points is far more than that
/// needs - the per-bin estimator's relative standard error is already a fraction of a percent - and
/// a 61MP frame offers 235,224 of them. What the floor is really guarding is not the line's
/// precision but `ne_finalize`'s two discrete gates, `cnt >= 20` per bin and four valid bins
/// overall: a sparsely populated bright bin has to survive the thinning.
const NE_TARGET_BLOCKS: usize = 32_768;

/// One block in this many, chosen coprime to the block grid's width.
///
/// **Coprimality is the whole of the correctness here.** Striding a raster by `s` visits the
/// columns that are multiples of `gcd(s, n_bx)`, so a stride sharing a factor with the width combs
/// a fixed subset of columns and leaves the rest unmeasured - at 594 columns wide, a stride of 9
/// would see 66 of them, a 144-sensor-pixel comb that beats against fabric, fences and sensor
/// banding. Coprime, the walk visits every column and precesses by `n_bx mod s` each row, which is
/// a free jitter over the whole frame.
///
/// That is what makes this a sample and not a crop. The codebase's other finding - that a 512px
/// tile fits between 0.49 and 1.51 times its own frame's noise - is about a contiguous region,
/// which sees one part of one subject; this sees the whole frame at one block in seven, so
/// vignetting, subject placement and the four CFA phases all keep the support they had.
fn block_stride(per_channel: usize, blocks_across: usize) -> usize {
    fn gcd(mut a: usize, mut b: usize) -> usize {
        while b != 0 {
            (a, b) = (b, a % b);
        }
        a
    }
    let wanted = (per_channel / NE_TARGET_BLOCKS).max(1);
    (wanted..).find(|s| gcd(*s, blocks_across.max(1)) == 1).unwrap_or(1)
}

/// The kernels the last run recorded, in the order it recorded them.
///
/// Kept only while a profile is being read, since the sequence is a fact about one call's shape -
/// a supplied fit skips Phase 2's iterations, a cached table skips two more - so it has to come
/// from the run being priced rather than from a list written beside it.
static DISPATCHED: std::sync::Mutex<Vec<(&'static str, u32)>> =
    std::sync::Mutex::new(Vec::new());

/// Each kernel the last run recorded, with the workgroups it was dispatched over.
///
/// The count is what says whether a dispatch can fill the machine at all: a device schedules whole
/// workgroups onto its cores, so one that offers fewer than the device has slots leaves the rest
/// idle however long it runs, and no amount of work inside the kernel reaches them.
pub fn dispatched() -> Vec<(&'static str, u32)> {
    DISPATCHED.lock().unwrap_or_else(|held| held.into_inner()).clone()
}

/// The inverse-GAT table, kept between calls.
///
/// **What made a denoise cost the same whatever it was given.** `build_inv_lut.slang` says so in
/// its own first paragraph - the table depends on nothing but (α, σ²), so its cost is the same at
/// any resolution - and it was built afresh on every call regardless: 373ms of a 61MP frame's
/// 5690ms, and 373ms of a 1152px tile's 507ms. A call was therefore ~395ms plus ~88ms per
/// megapixel, which is why cutting a frame into seventy tiles cost 34s where the frame whole cost
/// 5.7s. Nothing else in the chain has a dispatch whose size the region does not set.
///
/// Held as the values rather than as the buffers because 32KB is nothing to upload and a buffer
/// would have to be shared across calls that can run at once. Bounded, and moved to the front on
/// a hit, so a library interleaving a few photographs keeps all of their tables rather than
/// thrashing one slot - and so it cannot grow with the library either.
struct Table {
    alpha: u32,
    sigma_sq: u32,
    d: Vec<u8>,
    x: Vec<u8>,
    params: Vec<u8>,
}

/// Enough for a few photographs in flight, at 32KB each.
const TABLES_KEPT: usize = 4;

static TABLES: std::sync::Mutex<Vec<Table>> = std::sync::Mutex::new(Vec::new());

/// How many tables have been summed, which is the only way to ask whether a call reused one.
///
/// Two frames denoised against one table are a picture rather than a failure, and a key that
/// never matches is only slow - so neither shows up in the samples a test could compare. This is
/// what the test asserts on instead.
static TABLES_BUILT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// The pair keyed on its bits, since what has to match is the number the shader will read.
fn table_key(fit: &NoiseFit) -> (u32, u32) {
    (fit.alpha.to_bits(), fit.sigma_sq.to_bits())
}

/// A LOESS dispatch's seven buffers: the guide first, as the kernel declares them.
fn loess_binds<'a>(
    guide: &'a crate::gpu::Buffer,
    src: &'a [crate::gpu::Buffer; 3],
    dst: &'a [crate::gpu::Buffer; 3],
) -> [(u32, &'a crate::gpu::Buffer); 7] {
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
    src: &'a [crate::gpu::Buffer; 3],
    guide: &'a crate::gpu::Buffer,
    dst: &'a [crate::gpu::Buffer; 3],
) -> [(u32, &'a crate::gpu::Buffer); 7] {
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
pub async fn denoise(
    gpu: &crate::gpu::Gpu,
    galosh: &Galosh,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    amounts: Amounts,
) -> NoiseFit {
    run(gpu, galosh, mosaic, cfa, Work::Denoise { amounts, fit: None }).await
}

/// The same, over a frame whose whole-frame statistics were measured somewhere else.
///
/// For a tile: the fit is the frame's, so the crop is denoised at the strength its own export
/// would use rather than at whatever its few hundred thousand photosites happen to imply. Skips
/// the sixteen reduction dispatches that would have measured it, which is most of what a tile
/// spends before it filters anything.
pub async fn denoise_with(
    gpu: &crate::gpu::Gpu,
    galosh: &Galosh,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    amounts: Amounts,
    fit: NoiseFit,
) -> NoiseFit {
    run(gpu, galosh, mosaic, cfa, Work::Denoise { amounts, fit: Some(fit) }).await
}

/// The tile a progressive denoise is cut into, and what a caller with no reason to choose should
/// pass as `denoise_in_tiles`' `tile`.
///
/// **A latency size that measurement put back where the throughput size already was.** Over the
/// 61MP fixture at halo 64, best of three, with the median gap between two updates beside it:
///
/// | tile | tiles | total  | update | vs 1x |
/// |------|-------|--------|--------|-------|
/// | -    | 1     | 3920ms | -      | 1.00x |
/// | 4096 | 6     | 4308ms | 717ms  | 1.10x |
/// | 2048 | 20    | 4781ms | 236ms  | 1.22x |
/// | 1024 | 70    | 6777ms | 97ms   | 1.73x |
/// | 512  | 247   | 6833ms | 97ms   | 1.74x |
///
/// 4096 is six updates over four seconds, which reads as a frozen window rather than as progress.
/// 1024 is where the halo's redundancy overtakes what it buys - 73% of the wall clock for an
/// interval already below what a reader resolves - and 512 spends more again for nothing, its
/// regions being small enough that the per-call floor shows. 2048 is the one useful row.
///
/// The premise the plan wrote this item from - that a frame is one long silence - stopped holding
/// when the decode was tiled for memory at this same size. What was missing was the report.
pub const PROGRESS_TILE: usize = 2048;

/// The frame denoised tile by tile, reporting the fraction finished as each one lands.
///
/// **Sized for progress, not throughput.** Every tile is grown by `halo` on all four sides, so a
/// smaller `tile` puts more area through the filter and takes longer overall; what it buys is
/// somewhere to report from, because a frame denoised whole is seconds during which a caller can
/// draw nothing. See `PROGRESS_TILE` for the trade, measured.
///
/// `done` is passed a fraction in (0, 1], once per tile, between two submits - nothing here is
/// locked across it, so a consumer that takes its time delays the tile after it and nothing else.
///
/// Bit-identical to the same frame denoised whole, at every `tile` and every `halo`, which is what
/// the origin alignment below buys.
pub async fn denoise_in_tiles(
    gpu: &'static crate::gpu::Gpu,
    galosh: &Galosh,
    mosaic: &mut crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    amounts: Amounts,
    fit: NoiseFit,
    halo: usize,
    tile: usize,
    mut done: impl FnMut(f32),
) {
    let (width, height) = (mosaic.width, mosaic.height);
    // Split evenly rather than into whole tiles, so no strip is left a few pixels wide.
    let spans = move |total: usize| {
        let count = total.div_ceil(tile).max(1);
        let step = total.div_ceil(count);
        (0..count).map(move |at| (at * step, ((at + 1) * step).min(total)))
    };
    let tiles = spans(width).count() * spans(height).count();
    // Written to a second plane, read from the caller's: a tile's halo reaches into its neighbours,
    // so filtering in place would denoise a halo-wide band twice everywhere but the first tile.
    // Seeded from the caller's, so a region too small to filter is left as it arrived rather than
    // left as zeroes.
    let filtered = crate::condition::Mosaic::plane(gpu, width, height);
    {
        let bytes = (width * height * 4) as u64;
        let mut recording = gpu.record();
        recording.encoder().copy_buffer_to_buffer(
            &mosaic.buffer,
            0,
            &filtered.buffer,
            0,
            bytes,
        );
        recording.submit();
    }
    let mut finished = 0usize;
    for (y0, y1) in spans(height) {
        for (x0, x1) in spans(width) {
            // **Aligned to `pass12`'s workgroup, not merely to a CFA site.** `pass12` shrinks
            // within a shared tile measured from the region's origin, so an origin off that grid
            // shrinks every pixel against a different neighbourhood: unaligned, 94% of a 61MP
            // frame comes out different from the same frame denoised whole, by up to 1.6e-3,
            // spread everywhere rather than banded at the seams and identical at halo 64 and at
            // halo 512 - which is what says it is not reach. Costs the 55 pixels it can add to two
            // sides of a region, about 5% more area at a 2048 tile.
            //
            // Scaled because the alignment must also be a whole period of the pattern - an origin
            // off one relabels every colour in the region - and because the coarse level's tiles
            // sit on the same grid one octave further down.
            let (lattice_x, lattice_y) = lattice(cfa);
            let left = x0.saturating_sub(halo) / lattice_x * lattice_x;
            let top = y0.saturating_sub(halo) / lattice_y * lattice_y;
            let right = (x1 + halo).min(width);
            let bottom = (y1 + halo).min(height);
            let (span_w, span_h) = cfa.align_extent(right - left, bottom - top);
            let (right, bottom) = (left + span_w, top + span_h);
            if right > left && bottom > top {
                let (rw, rh) = (right - left, bottom - top);
                let window = mosaic.window(gpu, left, top, rw, rh);
                denoise_with(gpu, galosh, &window, cfa, amounts, fit).await;
                let (x1, y1) = (x1.min(right), y1.min(bottom));
                window.copy_rect(gpu, (x0 - left, y0 - top), &filtered, (x0, y0), (x1 - x0, y1 - y0));
            }
            finished += 1;
            done(finished as f32 / tiles as f32);
        }
    }
    *mosaic = filtered;
}

/// What the frame's statistics are, without filtering anything with them.
///
/// The editor's open wants this and no denoise: its frame crosses to a client that denoises on its
/// own (§10.9), but the loupe tiles it fetches afterwards are the server's and do want it. Running
/// the fit alone costs the two whole-frame transforms the reductions read through, and none of the
/// shrinkage, the chroma pyramid or the inverse.
pub async fn fit(
    gpu: &crate::gpu::Gpu,
    galosh: &Galosh,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
) -> NoiseFit {
    // Straight off the caller's frame: a fit stops before `k16_inverse_fused`, which is the only
    // dispatch that writes what it was given, so there is nothing here to protect it from.
    run(gpu, galosh, mosaic, cfa, Work::FitOnly).await
}

/// What a decode does about the noise: whose statistics it filters with, or whether it only
/// measures them.
#[derive(Clone, Copy, Default, Debug)]
pub enum Fit {
    /// Measure this frame's own as part of filtering it, which is what a whole frame wants. A
    /// decode that filters nothing measures nothing.
    #[default]
    Measure,
    /// Measure and hand back, filtering nothing: the editor's open, whose client filters for
    /// itself but whose loupe tiles have no frame of their own to measure.
    Only,
    /// The whole frame's, for a tile cut out of it.
    Given(NoiseFit),
}

/// What a decode of a whole frame should do about the noise, given what is already known.
///
/// **A decode always ends holding a fit, whatever the Detail sliders say.** The loupe tiles and
/// the bands of a re-prepare are handed the frame's own, and a reader who opens at Detail 0 and
/// moves the slider afterwards would otherwise have nothing to hand them - so a frame that filters
/// nothing still measures, which is exactly what [`Fit::Only`] is. It is the two whole-frame
/// transforms and none of the shrinkage, chroma pyramid or inverse.
///
/// **The noise is all this decides.** The capture's blur is measured on the prepared frame by
/// `base::measure_edge_spread`, which every path through `open::measure` runs whatever this
/// returns - so a stored fit is worth the `Given` arm on its own, and skipping the shrinkage
/// cannot cost a photograph its sigma.
pub fn wanted(stored: Option<NoiseFit>, detail: Detail) -> Fit {
    match (stored, detail.could_do_anything()) {
        (Some(fit), _) => Fit::Given(fit),
        (None, true) => Fit::Measure,
        (None, false) => Fit::Only,
    }
}

/// Which half of the chain to run, and with whose numbers.
enum Work {
    /// Stop once the whole-frame statistics are known; the frame itself is left alone.
    FitOnly,
    Denoise { amounts: Amounts, fit: Option<NoiseFit> },
}

async fn run(
    gpu: &crate::gpu::Gpu,
    galosh: &Galosh,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    work: Work,
) -> NoiseFit {
    let (width, height) = (mosaic.width, mosaic.height);
    // **Every statistic in Phase 0 is taken down one colour's own sub-lattice**, so the stride it
    // walks and the number of those lattices are the pattern's rather than Bayer's two and four.
    let (pw, ph) = cfa.period();
    let slots = (pw * ph) as i32;
    let amounts = match work {
        Work::FitOnly => Amounts { luma: 0.0, colour: 0.0 },
        Work::Denoise { amounts, .. } => amounts,
    };
    // **The colour amount is a distance up the chroma pyramid, and a period's plane starts further
    // along it.** `chroma_extract_halfres` writes one value per half-resolution site whatever the
    // pattern, but takes it over a whole period - two photosites a side on a 2x2 and six on a 6x6 -
    // so the plane the pyramid is handed already carries the smoothing Bayer's first octave would
    // have given it. Every level above therefore has `period / 2` times the support it does on a
    // 2x2, and past the first one that support has crossed the picture's own edges. The joint
    // upsample then puts that chroma back against luma's edges, which is a coloured blotch rather
    // than a smoothing - the demosaic is blamed for it, and no slider position removes it.
    //
    // Measured on the church fixture's darkest blue at `2078,1020`, sweeping the slider: chroma
    // roughness falls smoothly to 1.72/3.52 at 33 and jumps to 2.55/3.98 at 40. `walks_third` turns
    // the quarter-resolution level on at 33.3. Divided, the track's top lands on the last anchor
    // whose support is still the pattern's own, which is where the sweep's minimum is.
    //
    // A 2x2 divides by one, so nothing Bayer renders moves by this.
    let amounts = Amounts {
        colour: amounts.colour * 2.0 / (pw.max(ph) as f32),
        ..amounts
    };
    let supplied = match work {
        Work::Denoise { fit: Some(fit), .. } => Some(fit),
        _ => None,
    };
    let fit_only = matches!(work, Work::FitOnly);
    assert!(width % 2 == 0 && height % 2 == 0, "the mosaic's dimensions pair into 2x2 sites");

    // The same switch the decode and the open report through, because what this splits out is
    // the part of a call that does not scale with the region: a run over tiles pays it per tile,
    // and at a few hundred tiles that decides whether tiling is worth anything at all.
    let mut lap = crate::clock::laps("    galosh ");

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
    // A run of this allocates about five frames of working planes; they go when the recording
    // does, which is past the readbacks at the bottom.
    let mut recording = gpu.record();
    macro_rules! plane {
        ($label:expr, $len:expr) => {
            recording.buffer(&wgpu::BufferDescriptor {
                label: Some($label),
                size: (($len as usize).max(1) * 4) as u64,
                usage: storage,
                mapped_at_creation: false,
            })
        };
    }
    macro_rules! trio {
        ($label:expr, $len:expr) => {
            [plane!($label, $len), plane!($label, $len), plane!($label, $len)]
        };
    }

    // The caller's own frame, filtered where it lies. `k16_inverse_fused` is the only dispatch that
    // writes it and a fit stops before that one.
    let raw = mosaic.buffer.clone();
    recording.holding(&raw);

    // Two full-resolution scratch planes carry four roles between them, because a plane at
    // 61MP is 240MB. `full_a` is the GAT frame until the chroma has been taken out of it,
    // then the shrinkage's output; `full_b` is the luma transform until `pass12` has read
    // it, then the overlap average that guides the chroma home.
    let full_a = plane!("galosh in_gat / L_cs_den", npix);
    // Zero-length for a fit, which stops before any of them is read. The fit needs `full_a` and
    // the params block and nothing else, and the rest is most of the gigabyte this holds at 61MP -
    // a cost the editor's open should not pay for a number.
    let tail = |len: usize| if fit_only { 0 } else { len };
    let full_b = plane!("galosh L_cs / L_pixel", tail(npix));

    // Copied back with the frame: what Phase 0 fitted is the only physical description of
    // this photograph's noise anything has, and a caller choosing an amount wants it.
    // Seeded where the caller brought the frame's own statistics, so the dispatches that would
    // have measured them can be skipped. The slots are `prelude.slang`'s, and the two derived ones
    // go in with them: `P_INV_SG` is `unified_sigma`'s reciprocal, which only that kernel would
    // otherwise write.
    let mut seed = [0f32; 32];
    if let Some(fit) = supplied {
        // Floored like `ne_finalize`'s, because this is the same slot by another route and the
        // transform divides by it.
        seed[P_ALPHA] = fit.alpha.max(ALPHA_MIN);
        seed[P_SIGMA_SQ] = fit.sigma_sq;
        seed[P_UNIFIED_SIGMA] = fit.unified_sigma;
        seed[P_INV_SG] = 1.0 / fit.unified_sigma;
        seed[P_DARK_REF0..P_DARK_REF0 + 4].copy_from_slice(&fit.dark_ref);
    }
    let mut seed_bytes = Vec::with_capacity(seed.len() * 4);
    for value in seed {
        seed_bytes.extend_from_slice(&value.to_ne_bytes());
    }
    let params = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("galosh params"),
        contents: &seed_bytes,
        usage: storage | wgpu::BufferUsages::COPY_SRC,
    });
    // Written from a kept table on a hit and read back into one on a miss, so these three carry
    // both transfer usages where the rest of the chain's planes carry neither.
    let table_usage = storage | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST;
    macro_rules! table_plane {
        ($label:expr, $len:expr) => {
            recording.buffer(&wgpu::BufferDescriptor {
                label: Some($label),
                size: (($len as usize) * 4) as u64,
                usage: table_usage,
                mapped_at_creation: false,
            })
        };
    }
    let lut_d = table_plane!("galosh lut_d", LUT_SIZE);
    let lut_x = table_plane!("galosh lut_x", LUT_SIZE);
    let lut_params = table_plane!("galosh lut_params", 8);

    // Only where the caller brought the fit. Without one, (α, σ²) are what Phase 0 is about to
    // measure on the GPU, so there is nothing to look the table up by until the run that would
    // have used it has already happened - and that run is the once-per-photograph one anyway.
    // The tiles and the slider ticks this exists for all arrive with a fit in hand.
    let kept = supplied.filter(|_| !fit_only).and_then(|fit| {
        let (alpha, sigma_sq) = table_key(&fit);
        let mut tables = TABLES.lock().unwrap_or_else(|held| held.into_inner());
        let at = tables.iter().position(|t| t.alpha == alpha && t.sigma_sq == sigma_sq)?;
        let table = tables.remove(at);
        gpu.queue.write_buffer(&lut_d, 0, &table.d);
        gpu.queue.write_buffer(&lut_x, 0, &table.x);
        gpu.queue.write_buffer(&lut_params, 0, &table.params);
        tables.insert(0, table);
        Some(())
    });
    let build_the_table = kept.is_none();
    // One slot per sum each reduce kernel carries out of a workgroup, and the finalize beside it
    // reads them back at the same stride: `dark_ref_reduce_mwg` writes five (`wgid * 5 + q`, the
    // weight and one per CFA slot), `dark_resid_reduce_mwg` two. A slot is one f32 because a
    // `Tally` hands back a total, rather than a TwoSum sum and its compensation, which would
    // have to travel together to mean anything.
    let slices = gpu.reduction_slices;
    let sigma_partial =
        plane!("galosh sigma partial", slots as usize * slices as usize * (SIGMA_BINS + 1));
    let partial = plane!("galosh partial", DR_WORKGROUPS as usize * 5);
    let partial_resid = plane!("galosh partial resid", DR_WORKGROUPS as usize * 2);

    // **The blocks are the channel's own sub-lattice, so they shrink with the period.** A Bayer
    // channel is a quarter of the frame and an X-Trans one a thirty-sixth, which is the same total
    // count of blocks either way - one per photosite - spread over more channels of fewer blocks.
    let (ne_bx, ne_by) = (width / pw / 8, height / ph / 8);
    let ne_per_ch = ne_bx * ne_by;
    let ne_stride = block_stride(ne_per_ch, ne_bx);
    let ne_sampled = ne_per_ch.div_ceil(ne_stride);
    let blk_mean = plane!("galosh blk_mean", slots as usize * ne_sampled);
    let blk_var = plane!("galosh blk_var", slots as usize * ne_sampled);
    let dark_thresh_hist = plane!("galosh dark thresh hist", DARK_HIST_BINS);
    let dark_lap_hist = plane!("galosh dark lap hist", DARK_HIST_BINS);

    let half = tail(hw * hh);
    let l_h_den = plane!("galosh L_h_den", half);
    // The coarse band's own planes: a half-resolution stepping stone, then the quarter it is
    // smoothed at. Not `l_h_den` for the first, which is a decimation taken for the chroma guide
    // and so still carries every bit of the fine noise the average here is what removes.
    let (lcw, lch) = (hw / 2, hh / 2);
    let walks = amounts.luma > 0.0;
    let coarse_half = plane!("galosh L coarse half", if walks { half } else { 0 });
    let coarse = plane!("galosh L coarse", if walks { tail(lcw * lch) } else { 0 });
    let coarse_den = plane!("galosh L coarse den", if walks { tail(lcw * lch) } else { 0 });
    // Which anchors the walk reaches, which is what decides whether a level is built at all: the
    // blend reads the ones above it, and a plane nothing has written is bound as the noisy anchor
    // instead. The quarter level alone is a quarter of a gigabyte at 61MP, so a slider in the lower
    // third of the track pays for neither.
    let walks_third = amounts.colour > 1.0;
    let walks_fourth = amounts.colour > 2.0;
    let quarter = |len: usize| if walks_third { tail(len) } else { 0 };
    let eighth = |len: usize| if walks_fourth { tail(len) } else { 0 };
    let l_q = plane!("galosh L_q", quarter(cq_w * cq_h));
    let l_e = plane!("galosh L_e", eighth(ce_w * ce_h));
    let l_for_q = plane!("galosh L_for_q", quarter(kq_w * kq_h));
    let l_for_e = plane!("galosh L_for_e", eighth(ke_w * ke_h));
    let c_h = trio!("galosh C_h", half);
    // The half-res regression, and where the blend writes its answer back: nothing reads the
    // regression again afterwards, so a fifth trio of half-res planes would only be moving
    // values between two addresses.
    let c_loess_h = trio!("galosh C_loess_h / C_h_den", half);
    // `chroma_detail` models the 2x2 transform's three differences, which only a Bayer site has.
    let brackets = amounts.colour > 0.0
        && cfa.is_bayer()
        && !UNBRACKETED.load(std::sync::atomic::Ordering::Relaxed);
    let c_detail = trio!("galosh C detail", if brackets { half } else { 0 });
    let c_q = trio!("galosh C_q", quarter(cq_w * cq_h));
    let c_loess_q = trio!("galosh C_loess_q", quarter(cq_w * cq_h));
    let c_q_up = trio!("galosh C_q_up", quarter(hw * hh));
    let c_e = trio!("galosh C_e", eighth(ce_w * ce_h));
    let c_loess_e = trio!("galosh C_loess_e", eighth(ce_w * ce_h));
    let c_e_to_q = trio!("galosh C_e_to_q", eighth(cq_w * cq_h));
    let c_e_up = trio!("galosh C_e_up", eighth(hw * hh));
    // One scratch trio per scale, for the K16 whose output is not already the size its consumer
    // wants. The two chains use them at different times, so one of each is enough - and on a frame
    // whose half-resolution dimensions are both even there is no padding at all.
    let padded_half = kq_w == hw && kq_h == hh;
    let padded_quarter = ke_w == cq_w && ke_h == cq_h;
    let scratch_half =
        trio!("galosh K16 scratch", if padded_half { 0 } else { quarter(kq_w * kq_h) });
    let scratch_quarter =
        trio!("galosh K16 scratch", if padded_quarter { 0 } else { eighth(ke_w * ke_h) });

    let fitted = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("galosh fitted model"),
        size: 32 * 4,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut pushes = Pushes { bytes: Vec::new() };
    let wh = pushes.add(&[Word::I(w), Word::I(h)]);
    let wh_period =
        pushes.add(&[Word::I(w), Word::I(h), Word::I(pw as i32), Word::I(ph as i32)]);
    let block_stats = pushes.add(&[
        Word::I(w),
        Word::I(h),
        Word::I(ne_bx as i32),
        Word::I(ne_by as i32),
        Word::I(ne_sampled as i32),
        Word::I(ne_stride as i32),
        Word::I(pw as i32),
        Word::I(ph as i32),
    ]);
    let finalize =
        pushes.add(&[Word::I(w), Word::I(h), Word::I(slots * ne_sampled as i32)]);
    let thresh_slot = pushes.add(&[Word::I(15)]);
    let lap_hist =
        pushes.add(&[Word::I(w), Word::I(h), Word::I(15), Word::I(pw as i32), Word::I(ph as i32)]);
    let n_wg = pushes.add(&[Word::I(DR_WORKGROUPS as i32)]);
    let sigma_slice = pushes.add(&[
        Word::I(w),
        Word::I(h),
        Word::I(slices as i32),
        Word::I(pw as i32),
        Word::I(ph as i32),
    ]);
    // **The merge is unchanged and still four workgroups, which is the whole trick.** It reduces a
    // contiguous run of `slices` histograms into one sigma, so handing it `slots / 4` times as many
    // makes each of the four merge that share of the pattern's positions - nine of X-Trans's
    // thirty-six apiece, one of Bayer's four. `unified_sigma` combines the four either way.
    let sigma_merge = pushes.add(&[Word::I(slices as i32 * slots / 4)]);
    let packed = cfa.packed_colours().map(|word| Word::I(word as i32));
    let [gain_c1, gain_c2] = cfa.chroma_gain().map(Word::F);
    let extract = pushes.add(&[
        Word::I(w),
        Word::I(h),
        Word::I(hw as i32),
        Word::I(hh as i32),
        Word::I(pw as i32),
        Word::I(ph as i32),
        packed[0],
        packed[1],
        packed[2],
        gain_c1,
        gain_c2,
    ]);
    let detail_push = |sign: f32| {
        [Word::I(w), Word::I(h), Word::I(hw as i32), Word::I(hh as i32), Word::F(sign)]
    };
    let detail_predict = pushes.add(&detail_push(0.0));
    let detail_out = pushes.add(&detail_push(-1.0));
    let detail_in = pushes.add(&detail_push(1.0));
    let forward = pushes.add(&[
        Word::I(w),
        Word::I(h),
        Word::I(hw as i32),
        Word::I(pw as i32),
        Word::I(ph as i32),
        packed[0],
        packed[1],
        packed[2],
        gain_c1,
        gain_c2,
    ]);
    let shrink = pushes.add(&[Word::I(w), Word::I(h), Word::F(amounts.luma)]);
    let down_coarse = pushes.add(&[Word::I(hw as i32), Word::I(hh as i32)]);
    let smooth_coarse = pushes.add(&[
        Word::I(lcw as i32),
        Word::I(lch as i32),
        Word::F(amounts.luma * COARSE_RANGE),
    ]);
    let coarse_correct = pushes.add(&[
        Word::I(w),
        Word::I(h),
        Word::I(lcw as i32),
        Word::I(lch as i32),
        Word::I(COARSE_SCALE),
    ]);
    let overlap = pushes
        .add(&[Word::I(w), Word::I(h), Word::I(hw as i32), Word::I(cfa.is_bayer() as i32)]);
    let down_h = pushes.add(&[Word::I(hw as i32), Word::I(hh as i32)]);
    let floor = Word::F(FORCED_RATIO_FLOOR.or(f64::from(RATIO_FLOOR)));
    let loess = |w: usize, h: usize| [Word::I(w as i32), Word::I(h as i32), Word::F(LOESS_STRENGTH), floor];
    let loess_h = pushes.add(&loess(hw, hh));
    let down_q = pushes.add(&[Word::I(cq_w as i32), Word::I(cq_h as i32)]);
    let loess_q = pushes.add(&loess(cq_w, cq_h));
    let loess_e = pushes.add(&loess(ce_w, ce_h));
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
    let k16_q = pushes.add(&[Word::I(cq_w as i32), Word::I(cq_h as i32), Word::F(K16_BW), floor]);
    let k16_e = pushes.add(&[Word::I(ce_w as i32), Word::I(ce_h as i32), Word::F(K16_BW), floor]);
    let k16_final = pushes.add(&[
        Word::I(hw as i32),
        Word::I(hh as i32),
        Word::F(K16_BW),
        Word::I(pw as i32),
        Word::I(ph as i32),
        packed[0],
        packed[1],
        packed[2],
        gain_c1,
        gain_c2,
    ]);
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
    let blend = pushes.add(&[
        Word::I(hw as i32),
        Word::I(hh as i32),
        Word::F(amounts.colour),
        Word::F(FORCED_LEVEL_REACH.or(f64::from(LEVEL_REACH))),
    ]);
    let whole_to_whole =
        pushes.add(&[Word::I(w), Word::I(h), Word::I(w), Word::I(h)]);

    let uniforms = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("galosh pushes"),
        contents: &pushes.bytes,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    // Allocated before the encoder is borrowed for the dispatch sweep below, not where the copies
    // that fill them are recorded: one `&mut` on the recording at a time.
    let staged = (build_the_table && !fit_only && supplied.is_some()).then(|| {
        let mut out = |label: &str, len: usize| {
            recording.buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: (len * 4) as u64,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            })
        };
        (
            out("galosh lut_d out", LUT_SIZE),
            out("galosh lut_x out", LUT_SIZE),
            out("galosh lut_params out", 8),
        )
    });

    let bind = |kernel: &Kernel, buffers: &[(u32, &crate::gpu::Buffer)]| {
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
        gpu.bind_group(&wgpu::BindGroupDescriptor {
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

    lap("allocate");
    let encoder = recording.encoder();
    {
        // Everything past the fit is skipped rather than branched around, so a fit-only run reads
        // as the same sequence it is a prefix of. The buffers those dispatches would have touched
        // are zero-length above, which is what makes skipping them the whole saving rather than
        // half of it.
        let done = std::cell::Cell::new(false);
        let stop_after = STOP_AFTER.load(std::sync::atomic::Ordering::Relaxed);
        let recorded = std::cell::Cell::new(0usize);
        let naming = stop_after == usize::MAX && crate::clock::watched();
        if naming {
            DISPATCHED.lock().unwrap_or_else(|held| held.into_inner()).clear();
        }
        let mut run = |kernel: &Kernel, group: &wgpu::BindGroup, offset: u32, x: u32, y: u32| {
            if done.get() || recorded.get() >= stop_after {
                return;
            }
            recorded.set(recorded.get() + 1);
            if naming {
                DISPATCHED
                    .lock()
                    .unwrap_or_else(|held| held.into_inner())
                    .push((kernel.name, x * y));
            }
            // **A pass each, rather than one for the chain.** The planes here carry several roles
            // between them, so most dispatches read what the one before them wrote; in a single
            // pass on Metal those reads landed before the write did, and `pass12` denoised a frame
            // that was still being transformed under it - 1.9M of its tile samples read back as
            // something other than what they were copied from. A pass boundary is where WebGPU
            // guarantees the write is visible.
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernel.pipeline);
            pass.set_bind_group(0, group, &[offset]);
            pass.dispatch_workgroups(x, y, 1);
        };

        // Phase 0: the blind Poisson-Gaussian fit, off the frame's own statistics - or off the
        // frame this region was cut from, in which case it is already in `params` and none of
        // these whole-region reductions would be measuring the right thing anyway.
        if supplied.is_none() {
            let g = bind(&galosh.ne_block_stats, &[(0, &raw), (1, &blk_mean), (2, &blk_var)]);
            run(
                &galosh.ne_block_stats,
                &g,
                block_stats,
                (slots as u32 * ne_sampled as u32).div_ceil(64).max(1),
                1,
            );
            let g = bind(&galosh.ne_finalize, &[(0, &blk_mean), (1, &blk_var), (3, &params)]);
            run(&galosh.ne_finalize, &g, finalize, 1, 1);
            let g = bind(&galosh.ne_dark_thresh_hist, &[(0, &raw), (1, &dark_thresh_hist)]);
            let (tx, ty) = groups((hw + 2) / 3, (hh + 2) / 3, 16);
            run(&galosh.ne_dark_thresh_hist, &g, wh_period, tx, ty);
            let g = bind(&galosh.ne_dark_thresh_finalize, &[(0, &dark_thresh_hist), (1, &params)]);
            run(&galosh.ne_dark_thresh_finalize, &g, thresh_slot, 1, 1);
            let g = bind(&galosh.ne_dark_lap_hist, &[(0, &raw), (1, &params), (2, &dark_lap_hist)]);
            run(&galosh.ne_dark_lap_hist, &g, lap_hist, hx, hy);
            let g = bind(&galosh.ne_dark_finalize, &[(0, &dark_lap_hist), (1, &params)]);
            run(&galosh.ne_dark_finalize, &g, thresh_slot, 1, 1);
        }

        // Phase 1: into the GAT domain, and the table that comes back out of it.
        let g = bind(&galosh.gat_forward_full, &[(0, &raw), (1, &full_a), (6, &params)]);
        run(&galosh.gat_forward_full, &g, wh, fx, fy);
        // The table that undoes the GAT, which only the last phase reads: a fit stops before it,
        // and the series it sums is long enough that leaving it in doubles what a fit costs.
        // Skipped outright where a previous call already summed it for this (α, σ²) - see `Table`.
        if !fit_only && build_the_table {
            let g = bind(
                &galosh.build_inv_lut,
                &[(0, &params), (1, &lut_d), (2, &lut_x), (3, &lut_params)],
            );
            run(&galosh.build_inv_lut, &g, wh, 16, 1);
            let g = bind(&galosh.lut_finalize, &[(0, &lut_d), (1, &lut_params)]);
            run(&galosh.lut_finalize, &g, wh, 1, 1);
        }
        // The per-CFA sigmas and their RMS, which are whole-region reductions like Phase 0's.
        if supplied.is_none() {
            let g = bind(&galosh.sigma_per_cfa, &[(0, &full_a), (1, &sigma_partial)]);
            run(&galosh.sigma_per_cfa, &g, sigma_slice, slots as u32 * slices, 1);
            let g = bind(&galosh.sigma_per_cfa_merge, &[(0, &sigma_partial), (1, &params)]);
            run(&galosh.sigma_per_cfa_merge, &g, sigma_merge, 4, 1);
            let g = bind(&galosh.unified_sigma, &[(0, &params)]);
            run(&galosh.unified_sigma, &g, wh, 1, 1);
        }
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
        // The references themselves, which the IRLS reduces over the whole region - so a supplied
        // fit skips the iterations and `dark_sub_full` below subtracts the frame's own.
        //
        // **A 2x2 parity class is only a colour where the pattern is a 2x2.** On X-Trans each of
        // these four slots samples nine positions of the period, in a different colour mix per
        // slot, so what the reduction would report as a fixed-pattern offset is the frame's own
        // colour - subtracted here and added back by the inverse, and in between it is a
        // checkerboard the shrinkage sees. Left at zero instead.
        if supplied.is_none() && cfa.is_bayer() {
            for iteration in 0..3 {
                run(&galosh.dark_ref_reduce, &reduce, wh, DR_WORKGROUPS, 1);
                run(&galosh.dark_ref_finalize, &reduce_fin, n_wg, 1, 1);
                if iteration == 2 {
                    break;
                }
                run(&galosh.dark_resid_reduce, &resid, wh, DR_WORKGROUPS, 1);
                run(&galosh.dark_resid_finalize, &resid_fin, n_wg, 1, 1);
            }
        }
        // The whole-frame statistics are in `params` from here, which is all a fit was after.
        done.set(fit_only);

        let g = bind(&galosh.dark_sub_full, &[(0, &full_a), (5, &params)]);
        run(&galosh.dark_sub_full, &g, wh, fx, fy);

        // Phases 4 and 3: the chroma per site, then the plane the shrinkage reads.
        //
        // Chroma first, which is the order the dependency runs in off a pattern wider than a 2x2:
        // there Phase 3 takes each photosite's colour offset off the frame, and the offset is what
        // Phase 4 just measured.
        let g = bind(
            &galosh.chroma_extract_halfres,
            &[(0, &full_a), (1, &c_h[0]), (2, &c_h[1]), (3, &c_h[2])],
        );
        run(&galosh.chroma_extract_halfres, &g, extract, hx, hy);
        let g = bind(
            &galosh.forward_l_stride1,
            &[(0, &full_a), (1, &full_b), (2, &c_h[0]), (3, &c_h[1])],
        );
        run(&galosh.forward_l_stride1, &g, forward, fx, fy);

        // Phase 5: the shrinkage. `full_a` held the GAT frame until the dispatch above.
        //
        // **At zero luma the shrinkage is the frame, so it is copied rather than computed.**
        // `does_anything` is an *or*, so denoising colour alone reaches here with nothing to
        // threshold - and this kernel is the largest single stage of the denoise, half of it at
        // four phases and better than a third at the shipped two.
        // `at_zero_luma_the_shrinkage_returns_the_frame` is the claim that the copy is the same
        // picture.
        let shrinkage = match phases() {
            2 => &galosh.pass12_pair,
            4 => &galosh.pass12_quarter,
            8 => &galosh.pass12_half,
            _ => &galosh.pass12,
        };
        match amounts.luma > 0.0 {
            true => {
                let g = bind(shrinkage, &[(0, &full_b), (1, &full_a)]);
                let (px, py) = groups(width, height, PASS12_TILE);
                run(shrinkage, &g, shrink, px, py);
            }
            false => {
                let g = bind(&galosh.copy_2d_clamped, &[(0, &full_b), (1, &full_a)]);
                run(&galosh.copy_2d_clamped, &g, whole_to_whole, fx, fy);
            }
        }

        // Phase 6: the phases averaged back. `full_b` held the transform.
        let pooled = if phase_pooled() {
            &galosh.lpixel_lh_den_fused
        } else {
            &galosh.lpixel_lh_den_unpooled
        };
        let g = bind(pooled, &[(0, &full_a), (1, &full_b), (2, &l_h_den)]);
        run(pooled, &g, overlap, fx, fy);

        // Phase 6b: the band the full-resolution pass is blind to, smoothed rather than shrunk.
        if walks {
            // Each push is the *source's* shape, this kernel's destination being half of it.
            let g = bind(&galosh.box_downsample_2x, &[(0, &full_b), (1, &coarse_half)]);
            run(&galosh.box_downsample_2x, &g, wh, hx, hy);
            let g = bind(&galosh.box_downsample_2x, &[(0, &coarse_half), (1, &coarse)]);
            let (lx, ly) = groups(lcw, lch, 16);
            run(&galosh.box_downsample_2x, &g, down_coarse, lx, ly);
            let g = bind(&galosh.coarse_smooth, &[(0, &coarse), (1, &coarse_den)]);
            run(&galosh.coarse_smooth, &g, smooth_coarse, lx, ly);
            let g = bind(
                &galosh.coarse_correct,
                &[(0, &coarse_den), (1, &coarse), (2, &full_b)],
            );
            run(&galosh.coarse_correct, &g, coarse_correct, fx, fy);
        }

        // Phase 7: the chroma pyramid, and the guided upsamples back up it.
        //
        // **A level is built only where the walk reaches it.** `smoothstep_blend_3p` ends on the
        // anchor below wherever the slider stops and never reads the ones above it - so each of the
        // two coarse levels is two downsamples, a whole LOESS, a crop and a joint upsample per
        // octave it has to climb, all spent on a plane the blend would not read.
        //
        // **And at zero the walk never leaves the first anchor, so the half-resolution LOESS goes
        // too.** `smoothstep_blend_3p` at `slider <= 0` takes `blended = a`, which makes the
        // smoothed green difference `weigh_green_difference` weighs the raw one and its two outputs `a.x` and `a.y` exactly - an
        // identity copy of `c_h` into `c_loess_h`, written over whatever the regression computed.
        // So the LOESS and the blend are both skipped and `k16_inverse_fused` reads `c_h` where it
        // would have read the copy. Bit-identical, and the LOESS is a fifth of the denoise: 89ms of
        // 396 on a 24MP mosaic, with the blend another 19ms.
        let filters_colour = amounts.colour > 0.0;
        if brackets {
            for push in [detail_predict, detail_out] {
                let g = bind(
                    &galosh.chroma_detail,
                    &[
                        (0, &full_a),
                        (1, &c_h[0]),
                        (2, &c_h[1]),
                        (3, &c_h[2]),
                        (4, &c_detail[0]),
                        (5, &c_detail[1]),
                        (6, &c_detail[2]),
                    ],
                );
                run(&galosh.chroma_detail, &g, push, hx, hy);
            }
        }
        if walks_third {
            for (from, to) in [(&l_h_den, &l_q), (&c_h[0], &c_q[0]), (&c_h[1], &c_q[1]), (&c_h[2], &c_q[2])] {
                let g = bind(&galosh.box_downsample_2x, &[(0, from), (1, to)]);
                run(&galosh.box_downsample_2x, &g, down_h, qx, qy);
            }
        }

        if walks_fourth {
            for (from, to) in [(&l_q, &l_e), (&c_q[0], &c_e[0]), (&c_q[1], &c_e[1]), (&c_q[2], &c_e[2])] {
                let g = bind(&galosh.box_downsample_2x, &[(0, from), (1, to)]);
                run(&galosh.box_downsample_2x, &g, down_q, ex, ey);
            }
        }

        if filters_colour {
            let g = bind(&galosh.loess_chroma_3p_tiled, &loess_binds(&l_h_den, &c_h, &c_loess_h));
            let (lx, ly) = groups(hw, hh, LOESS_TILE);
            run(&galosh.loess_chroma_3p_tiled, &g, loess_h, lx, ly);
        }

        if walks_third {
            let g = bind(&galosh.loess_chroma_3p_tiled, &loess_binds(&l_q, &c_q, &c_loess_q));
            let (lx, ly) = groups(cq_w, cq_h, LOESS_TILE);
            run(&galosh.loess_chroma_3p_tiled, &g, loess_q, lx, ly);

            let g = bind(&galosh.copy_2d_clamped, &[(0, &l_h_den), (1, &l_for_q)]);
            run(&galosh.copy_2d_clamped, &g, crop_q, kx, ky);

            let q_up_target = if padded_half { &c_q_up } else { &scratch_half };

            let g = bind(&galosh.k16_jbu_3p, &k16_binds(&c_loess_q, &l_for_q, q_up_target));
            run(&galosh.k16_jbu_3p, &g, k16_q, kx, ky);
            if !padded_half {
                for at in 0..3 {
                    let g =
                        bind(&galosh.copy_2d_clamped, &[(0, &scratch_half[at]), (1, &c_q_up[at])]);
                    run(&galosh.copy_2d_clamped, &g, pad_to_half, hx, hy);
                }
            }
        }

        // The eighth level comes up two scales rather than one, each step guided by the luma of the
        // level it lands on: a K16 writes exactly twice its input, and a jump of four across a
        // frame's own chroma is where a joint upsample stops following an edge and starts inventing
        // one.
        if walks_fourth {
            let g = bind(&galosh.loess_chroma_3p_tiled, &loess_binds(&l_e, &c_e, &c_loess_e));
            let (lx, ly) = groups(ce_w, ce_h, LOESS_TILE);
            run(&galosh.loess_chroma_3p_tiled, &g, loess_e, lx, ly);

            let g = bind(&galosh.copy_2d_clamped, &[(0, &l_q), (1, &l_for_e)]);
            run(&galosh.copy_2d_clamped, &g, crop_e, kex, key);

            let e_to_q_target = if padded_quarter { &c_e_to_q } else { &scratch_quarter };
            let g = bind(&galosh.k16_jbu_3p, &k16_binds(&c_loess_e, &l_for_e, e_to_q_target));
            run(&galosh.k16_jbu_3p, &g, k16_e, kex, key);
            if !padded_quarter {
                for at in 0..3 {
                    let g =
                        bind(&galosh.copy_2d_clamped, &[(0, &scratch_quarter[at]), (1, &c_e_to_q[at])]);
                    run(&galosh.copy_2d_clamped, &g, pad_to_quarter, qx, qy);
                }
            }

            let e_up_target = if padded_half { &c_e_up } else { &scratch_half };
            let g = bind(&galosh.k16_jbu_3p, &k16_binds(&c_e_to_q, &l_for_q, e_up_target));
            run(&galosh.k16_jbu_3p, &g, k16_q, kx, ky);
            if !padded_half {
                for at in 0..3 {
                    let g = bind(&galosh.copy_2d_clamped, &[(0, &scratch_half[at]), (1, &c_e_up[at])]);
                    run(&galosh.copy_2d_clamped, &g, pad_to_half, hx, hy);
                }
            }
        }

        // Phase 8: the colour strength, as a walk along those four anchors, answered back
        // over the regression it walks from.
        if filters_colour {
            let g = bind(
                &galosh.smoothstep_blend_3p,
                &[
                    (0, if walks_third { &c_q_up[0] } else { &c_h[0] }),
                    (1, if walks_third { &c_q_up[1] } else { &c_h[1] }),
                    (2, if walks_third { &c_q_up[2] } else { &c_h[2] }),
                    (3, &c_loess_h[0]),
                    (4, &c_loess_h[1]),
                    (5, &c_loess_h[2]),
                    // The first anchor where the fourth was never built, which is never read: a
                    // binding cannot be left empty, and a plane of no length cannot be bound.
                    (6, if walks_fourth { &c_e_up[0] } else { &c_h[0] }),
                    (7, if walks_fourth { &c_e_up[1] } else { &c_h[1] }),
                    (8, if walks_fourth { &c_e_up[2] } else { &c_h[2] }),
                ],
            );
            run(&galosh.smoothstep_blend_3p, &g, blend, hx, hy);
            if cfa.is_bayer() {
                let g = bind(
                    &galosh.weigh_green_difference,
                    &[(0, &c_h[0]), (1, &c_h[1]), (3, &c_loess_h[0]), (4, &c_loess_h[1])],
                );
                run(&galosh.weigh_green_difference, &g, blend, hx, hy);
            }
        }
        if brackets {
            let g = bind(
                &galosh.chroma_detail,
                &[
                    (0, &full_a),
                    (1, &c_loess_h[0]),
                    (2, &c_loess_h[1]),
                    (3, &c_loess_h[2]),
                    (4, &c_detail[0]),
                    (5, &c_detail[1]),
                    (6, &c_detail[2]),
                ],
            );
            run(&galosh.chroma_detail, &g, detail_in, hx, hy);
        }
        let chroma = if filters_colour { &c_loess_h } else { &c_h };

        // Phases 9 and 10: upsampled and inverted in one pass, back over the input.
        let g = bind(
            &galosh.k16_inverse_fused,
            &[
                (0, &chroma[0]),
                (1, &chroma[1]),
                (2, &chroma[2]),
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
    // Only where nothing was supplied. Phase 0 and Phase 2 are the dispatches that write these
    // slots, both are skipped when the caller brought a fit, and `irls_seed` - the one thing that
    // does write `params` either way - writes only the IRLS bounds. So the block would come back
    // holding the seed, which is a map and a wait per tile for a number already in hand.
    let measure = supplied.is_none();
    if measure {
        encoder.copy_buffer_to_buffer(&params, 0, &fitted, 0, 32 * 4);
    }
    // Taken on the way past, so keeping the table costs this run one 32KB copy onto a map it was
    // already going to wait for, rather than a submit of its own.
    if let Some((d, x, table_params)) = &staged {
        for (from, out, len) in
            [(&lut_d, d, LUT_SIZE as u64), (&lut_x, x, LUT_SIZE as u64), (&lut_params, table_params, 8)]
        {
            encoder.copy_buffer_to_buffer(from, 0, out, 0, len * 4);
        }
    }
    lap("record");
    recording.submit();
    // Before anything below, so the lap that says "dispatch" is the dispatch. It is also what
    // bounds a tiled run: dropping a plane's last handle *schedules* its release against the work
    // still pending, so without a wait here the next tile allocates while this one's gigabyte is
    // still owed - which at 61MP is every tile's planes resident at once.
    crate::gpu::finished(gpu).await.expect("the denoise finished");
    lap("dispatch");

    if let (Some((d, x, table_params)), Some(fit)) = (&staged, supplied) {
        let (alpha, sigma_sq) = table_key(&fit);
        let mut taken = Vec::new();
        for buffer in [d, x, table_params] {
            taken.push(
                crate::gpu::read_back(gpu, buffer, <[u8]>::to_vec)
                    .await
                    .expect("the table mapped"),
            );
        }
        let mut taken = taken.into_iter();
        let table = Table {
            alpha,
            sigma_sq,
            d: taken.next().expect("the d table"),
            x: taken.next().expect("the x table"),
            params: taken.next().expect("the table's params"),
        };
        let mut tables = TABLES.lock().unwrap_or_else(|held| held.into_inner());
        tables.insert(0, table);
        tables.truncate(TABLES_KEPT);
        TABLES_BUILT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    let measured = match supplied {
        Some(fit) => fit,
        None => crate::gpu::read_back(gpu, &fitted, fit_of).await.expect("the model mapped"),
    };
    lap("read back");
    measured
}

/// The whole-frame statistics, off a mapped copy of the params block.
fn fit_of(mapped: &[u8]) -> NoiseFit {
    let at = |slot: usize| {
        let word = &mapped[slot * 4..slot * 4 + 4];
        f32::from_ne_bytes([word[0], word[1], word[2], word[3]])
    };
    NoiseFit {
        alpha: at(P_ALPHA),
        sigma_sq: at(P_SIGMA_SQ),
        unified_sigma: at(P_UNIFIED_SIGMA),
        dark_ref: [at(P_DARK_REF0), at(P_DARK_REF0 + 1), at(P_DARK_REF0 + 2), at(P_DARK_REF0 + 3)],
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ACHROMATIC_RANGE, ALPHA_MIN, Amounts, COLOUR_LEAD, Detail, NoiseFit, NoiseModel, P_ALPHA,
        P_DARK_REF0,
        P_INV_SG, P_SIGMA_SQ, P_UNIFIED_SIGMA, DARK_HIST_BINS, LUT_SIZE, SIGMA_BINS, denoise, device,
        phases,
    };

    /// How many phases every frame is shrunk over, which is a quality decision rather than a tuning.
    ///
    /// **Raising it costs a multiple of the shrinkage for a difference nobody could point at.** The
    /// measurements behind the number are on [`super::phases`]; what this pins is that the number
    /// stays a deliberate change, since nothing else in the suite fails when it moves - a frame
    /// denoised over sixteen phases is a *correct* picture, only a slower one.
    ///
    /// The pair is only safe *because* it runs down the diagonal, so the two move together: two
    /// phases without `PHASE_DIAGONAL` is the striped shadow [`super::phases`] measures.
    #[test]
    fn every_frame_is_shrunk_over_two_phases() {
        assert_eq!(phases(), 2);
    }

    /// The params slots, against the shader that declares them.
    ///
    /// Renumbering one in `prelude.slang` is a silent wrong picture rather than a failure: a
    /// supplied fit would be seeded into whatever now lives at 13, the reductions that would have
    /// written the real slot are skipped, and the tile denoises against a number that means
    /// something else.
    ///
    /// Read from the Slang rather than what it emitted: a `static const` is folded into its use
    /// sites, so the declaration is not in the generated WGSL.
    #[test]
    fn the_params_slots_are_the_ones_the_shader_declares() {
        const SLANG: &str = include_str!("../../../slang/galosh/prelude.slang");
        let declared = |name: &str| {
            let opener = format!("public static const int {name} = ");
            let start = SLANG.find(&opener).unwrap_or_else(|| panic!("{name} is declared"));
            let rest = &SLANG[start + opener.len()..];
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<usize>().unwrap_or_else(|_| panic!("{name} is a number"))
        };
        for (name, here) in [
            ("P_UNIFIED_SIGMA", P_UNIFIED_SIGMA),
            ("P_INV_SG", P_INV_SG),
            ("P_DARK_REF0", P_DARK_REF0),
            ("P_ALPHA", P_ALPHA),
            ("P_SIGMA_SQ", P_SIGMA_SQ),
        ] {
            assert_eq!(declared(name), here, "{name}: the shader and this host disagree");
        }
    }

    #[test]
    fn the_table_sizes_are_the_ones_the_shader_declares() {
        const SLANG: &str = include_str!("../../../slang/galosh/prelude.slang");
        for (name, here) in
            [("SIGMA_BINS", SIGMA_BINS), ("DARK_HIST_BINS", DARK_HIST_BINS), ("LUT_SIZE", LUT_SIZE)]
        {
            let opener = format!("public static const int {name} = ");
            let start = SLANG.find(&opener).unwrap_or_else(|| panic!("{name} is declared"));
            let digits: String =
                SLANG[start + opener.len()..].chars().take_while(char::is_ascii_digit).collect();
            assert_eq!(digits.parse::<usize>().ok(), Some(here), "{name}: the shader and this host disagree");
        }
    }

    /// The floor on `alpha`, against the shader that declares it.
    ///
    /// Two spellings of one number: this side floors a supplied fit before seeding the slot and
    /// `ne_finalize` floors the one it measures, so a prelude edit that moved only the shader's
    /// would leave a fit crossing the API able to do what the test below describes.
    #[test]
    fn the_alpha_floor_is_the_one_the_shader_declares() {
        const SLANG: &str = include_str!("../../../slang/galosh/prelude.slang");
        let opener = "public static const float ALPHA_MIN = ";
        let start = SLANG.find(opener).expect("the prelude declares ALPHA_MIN");
        let literal: String =
            SLANG[start + opener.len()..].chars().take_while(|c| *c != ';').collect();
        let declared: f32 = literal.trim().parse().expect("ALPHA_MIN is a number");
        assert_eq!(declared, ALPHA_MIN, "the shader and this host floor alpha differently");
    }

    /// The grid the two dark-reference reducers stride, against the dispatch they are given.
    ///
    /// They sweep the frame in `total_wis` steps and the host reads back one partial per
    /// workgroup, so a stride wider than the dispatch leaves the tail of every block row
    /// unvisited and the reference fitted to part of the frame - a dark frame subtracted at the
    /// wrong level, on a photograph nothing refuses.
    #[test]
    fn the_reducers_stride_the_grid_the_host_dispatches() {
        const SLANG: &str = include_str!("../../../slang/galosh/prelude.slang");
        let line = format!("public static const int DR_WORKGROUPS = {};", super::DR_WORKGROUPS);
        assert!(SLANG.contains(&line), "the prelude does not say `{line}`");
    }

    /// The neutrality the dark reference is fitted within, against the kernel that defines it.
    ///
    /// `NoiseFit::usable` refuses a reference whose slots sit further apart than this, and the
    /// whole argument for that bound is that it is the same number `dark_ref_reduce_mwg` gates its
    /// blocks on. Moved in the shader alone, the refusal stops meaning anything.
    #[test]
    fn the_achromatic_range_is_the_one_the_shader_declares() {
        const SLANG: &str = include_str!("../../../slang/galosh/prelude.slang");
        let opener = "public static const float ACHROMATIC_RANGE = ";
        let start = SLANG.find(opener).expect("the prelude declares ACHROMATIC_RANGE");
        let literal: String =
            SLANG[start + opener.len()..].chars().take_while(|c| *c != ';').collect();
        let declared: f32 = literal.trim().parse().expect("ACHROMATIC_RANGE is a number");
        assert_eq!(declared, ACHROMATIC_RANGE, "the shader and this host gate neutrality differently");
    }

    /// A fit whose per-slot references have drifted apart is refused rather than applied.
    ///
    /// The one failure with no other symptom: four offsets that disagree push each channel a
    /// different way, and the frame comes back in saturated primaries with its structure intact.
    #[test]
    fn a_dark_reference_that_contradicts_itself_is_refused() {
        let sane = NoiseFit {
            alpha: 4.4e-6,
            sigma_sq: 1.2e-8,
            unified_sigma: 0.88,
            dark_ref: [56.22, 56.12, 56.12, 56.17],
        };
        assert!(sane.usable(), "a measured fit was refused");

        let drifted = NoiseFit { dark_ref: [56.22, 56.12, 91.0, 56.17], ..sane };
        assert!(!drifted.usable(), "a reference the blocks cannot have said was accepted");
    }

    /// The Detail track's landmarks.
    ///
    /// Every host reaches the kernels through this function, so what needs pinning is not two
    /// implementations against each other but this one against the numbers it is meant to produce.
    #[test]
    fn the_track_ends_where_a_photograph_still_survives_it() {
        // The calibrated point - exactly the noise Phase 0 measured, treated as noise - is not the
        // midpoint. The track stops short of twice it, so 1.0 sits above the middle.
        let calibrated = Amounts::from_sliders(62.5, 62.5);
        assert!((calibrated.luma - 1.0).abs() < 1e-6, "luma {}", calibrated.luma);

        // Colour's landmarks are its anchors, one per third of the track: the half-resolution
        // regression exactly at a third, the quarter-resolution level at two thirds, and the walk
        // above each that `walks_third` and `walks_fourth` gate on.
        let third = Amounts::from_sliders(0.0, 100.0 / 3.0);
        assert!((third.colour - 1.0).abs() < 1e-6, "colour {}", third.colour);
        let two_thirds = Amounts::from_sliders(0.0, 200.0 / 3.0);
        assert!((two_thirds.colour - 2.0).abs() < 1e-6, "colour {}", two_thirds.colour);

        // The end of each track. Luminance stops where the library's noisiest frame was still a
        // photograph rather than a blur; colour stops where `smoothstep_blend_3p` stops answering,
        // which is the fourth anchor exactly.
        assert!((Amounts::from_sliders(100.0, 100.0).luma - 1.6).abs() < 1e-6);
        assert!((Amounts::from_sliders(100.0, 100.0).colour - 3.0).abs() < 1e-6);
        assert_eq!(Amounts::from_sliders(0.0, 0.0).does_anything(), false);

        // **What `photo_edits.ts` actually ships, in the units the kernels read.** The schema's
        // defaults are positions on this track, so moving the track's top moves what every stored
        // edit means - these two by a fifth when it came down from twice the calibrated point. A
        // position is pinned here rather than there because this is the only side that can say what
        // it is worth, and a silent change to what the shipped default denoises at is precisely the
        // thing nothing else in either suite would notice.
        let shipped = Amounts::from_sliders(20.0, 30.0);
        assert!((shipped.luma - 0.32).abs() < 1e-6, "luma {}", shipped.luma);
        assert!((shipped.colour - 0.9).abs() < 1e-6, "colour {}", shipped.colour);
    }

    /// The pair the two halves of the Detail panel are suggested at.
    #[test]
    fn the_suggested_colour_runs_ahead_of_the_luminance() {
        let at = |read: f32| {
            NoiseModel { alpha: 0.0, sigma_sq: read * read }.suggested_amounts()
        };
        // A base-ISO frame is declined on both halves rather than on one.
        assert_eq!(at(0.00026), (0.0, 0.0));
        // **Luminance lands well short of the end of its track and colour is at the end of its**,
        // which is the same rule read on two tracks rather than an inconsistency: what is lost to
        // under-denoising luminance is grain and still reads as a photograph, and what is lost to
        // under-denoising colour is mottle and never does. This is `DSC00982` at ISO 12800.
        let (luma, colour) = at(0.00275);
        assert!((35.0..45.0).contains(&luma), "luma {luma}");
        assert_eq!(colour, 100.0, "the noisiest frame in the library does not ask for every scale");

        // A frame the ramp puts mid-track, where the lead is the lead rather than the clamp: this
        // is `DSC05282` at ISO 4000, the frame the eighth-resolution anchor was measured on.
        let (luma, colour) = at(0.00187);
        assert!(colour > luma, "colour {colour} does not lead luma {luma}");
        assert!((colour - luma * COLOUR_LEAD).abs() < 1e-6, "colour {colour} is not the lead");
        assert!((70.0..85.0).contains(&colour), "colour {colour} does not reach the coarse level");
    }

    /// What an unset slider resolves to, and what a decode may conclude before it has measured.
    #[test]
    fn an_unset_detail_is_the_frames_own_and_not_a_number() {
        let noisy = NoiseFit {
            alpha: 0.0,
            sigma_sq: 0.00187 * 0.00187,
            unified_sigma: 1.2,
            dark_ref: [0.0; 4],
        };
        let (luma, colour) = NoiseModel { alpha: 0.0, sigma_sq: noisy.sigma_sq }.suggested_amounts();
        assert_eq!(Detail::AUTO.resolved(Some(noisy)), (luma.round(), colour.round()));

        // Half set is half resolved: a reader who moved one slider is not asking the frame about
        // the other one as well.
        let half = Detail { luminance: Some(4.0), colour: None };
        assert_eq!(half.resolved(Some(noisy)), (4.0, colour.round()));

        // **A decode cannot say an unset slider does nothing until it has measured**, which is what
        // stands between the automatic amount and a gate that skips GALOSH before Phase 0 runs.
        assert!(Detail::AUTO.could_do_anything());
        assert!(Detail::AUTO.needs_a_fit());
        assert!(!Detail::at(0.0, 0.0).could_do_anything());
        assert!(!Detail::at(0.0, 0.0).needs_a_fit());

        // A clean frame is declined on both halves, and that is the whole of what a fit can say -
        // so an automatic decode of one filters nothing rather than filtering a little.
        let clean = NoiseFit { sigma_sq: 0.00026 * 0.00026, ..noisy };
        assert_eq!(Detail::AUTO.resolved(Some(clean)), (0.0, 0.0));
        assert!(!Detail::AUTO.amounts(Some(clean)).does_anything());
    }

    /// `TABLES` and `TABLES_BUILT` outlive a call and the suite shares a process, so two tests
    /// that denoise at once sum each other's tables - which is only visible as the count below
    /// being one too many, on whichever of them the harness happened to run second.
    static ONE_DENOISE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A kept table is reused for its own (α, σ²), and summed again for any other.
    ///
    /// **Both ways of getting this wrong are silent.** One table serving two fits is a frame
    /// denoised against another frame's sensor, which is a picture rather than an error; a key
    /// that never matches is only slow, which is invisible to anything comparing samples and is
    /// the whole point of keeping the table. Neither shows up in the output, so the samples are
    /// only half of what this asserts - the other half is how many tables were summed, which is
    /// the decision itself.
    ///
    /// The mosaic is synthesised because what is compared is one run against another over
    /// whatever was handed in, and the fits are stated rather than measured so the keys are known
    /// to differ.
    #[test]
    fn a_kept_table_belongs_to_the_fit_it_was_built_for() {
        let _held = ONE_DENOISE_AT_A_TIME.lock().unwrap_or_else(|held| held.into_inner());
        let Some(gpu) = crate::gpu::device() else { return };
        let Some(kernels) = device(gpu) else { return };

        let (w, h) = (192usize, 192usize);
        let mosaic: Vec<f32> = (0..w * h)
            .map(|at| 0.2 + 0.6 * ((at % 97) as f32 / 97.0) + ((at % 13) as f32 / 13.0) * 0.05)
            .collect();
        let amounts = Amounts::from_sliders(50.0, 50.0);
        let denoised = |fit: super::NoiseFit| {
            let out = crate::condition::Mosaic::upload(gpu, &mosaic, w, h);
            pollster::block_on(super::denoise_with(gpu, kernels, &out, &rggb(), amounts, fit));
            read(gpu, &out)
        };
        let built = || super::TABLES_BUILT.load(std::sync::atomic::Ordering::Relaxed);

        // Unique to this test, since the tables outlive a single one and the suite shares a
        // process: a fit another test had already summed would make the first run a hit.
        let one = super::NoiseFit {
            alpha: 0.0021_7,
            sigma_sq: 1.13e-5,
            unified_sigma: 0.9,
            dark_ref: [0.0; 4],
        };
        // A different sensor in the two numbers the table is a function of and nothing else, so a
        // key ignoring either would collide here.
        let other = super::NoiseFit { alpha: 0.0079_3, sigma_sq: 4.41e-5, ..one };

        let before = built();
        let first = denoised(one);
        assert_eq!(built(), before + 1, "the first run of a new fit did not sum a table");

        let between = denoised(other);
        assert_eq!(built(), before + 2, "a different fit reused another fit's table");

        let again = denoised(one);
        assert_eq!(built(), before + 2, "a fit already summed was summed a second time");

        assert_eq!(first, again, "the kept table changed what the same fit produced");
        assert_ne!(first, between, "two different fits denoised to the same frame");
    }

    /// Tiling is a schedule and not a filter, and the progress it reports is a fraction.
    ///
    /// **The failure this exists for is silent and looks like a denoise.** A halo dropped, an
    /// origin off `pass12`'s grid or at odd parity, a crop-back off by a row: nothing errors, no
    /// dimension is wrong, and the picture is simply not the one an export would produce. Three
    /// tile sizes, none a multiple of the 56 the origins round to, because a geometry bug commonly
    /// survives the size it was written against.
    ///
    /// **1792 and not 512, though 512 would run in a third of the time.** Unaligned tiling leaves a
    /// 512px frame bit-identical anyway, so a frame that size cannot tell the rounding from its
    /// absence and this test would pass against the bug it exists for.
    #[test]
    fn tiling_the_denoise_does_not_move_a_sample() {
        let _held = ONE_DENOISE_AT_A_TIME.lock().unwrap_or_else(|held| held.into_inner());
        let Some(gpu) = crate::gpu::device() else { return };
        let Some(kernels) = device(gpu) else { return };

        let (w, h) = (1792usize, 1792usize);
        let mosaic = frame(w, h);
        // Colour at the end of its track, because the halo is sized for the deepest level the walk
        // can reach and the eighth-resolution anchor is the deepest: at 50 the chroma pyramid stops
        // an octave short and a halo too small for it would still pass.
        let amounts = Amounts::from_sliders(50.0, 100.0);
        // The frame's own, handed to every tile: measured per tile it would be each tile's
        // statistics, which is a different denoise before any halo is considered.
        let uploaded = crate::condition::Mosaic::upload(gpu, &mosaic, w, h);
        let fit = pollster::block_on(super::fit(gpu, kernels, &uploaded, &rggb()));
        let whole = crate::condition::Mosaic::upload(gpu, &mosaic, w, h);
        pollster::block_on(super::denoise_with(gpu, kernels, &whole, &rggb(), amounts, fit));
        let whole = read(gpu, &whole);

        for tile in [128usize, 192, 256] {
            let mut tiled = crate::condition::Mosaic::upload(gpu, &mosaic, w, h);
            let mut ticks = Vec::new();
            pollster::block_on(super::denoise_in_tiles(
                gpu,
                kernels,
                &mut tiled,
                &rggb(),
                amounts,
                fit,
                crate::RENDITION_TILE_HALO,
                tile,
                |done| ticks.push(done),
            ));
            assert_eq!(read(gpu, &tiled), whole, "a {tile}px tiling moved a sample");
            assert!(ticks.len() > 1, "a {tile}px tiling reported {} tiles", ticks.len());
            assert!(ticks.windows(2).all(|pair| pair[1] > pair[0]), "{ticks:?} went backwards");
            assert_eq!(ticks.last(), Some(&1.0), "{tile}px did not report finished");
        }
    }

    /// The automatic amount against the read noise a real library actually reports.
    ///
    /// Every figure here is measured by `examples/noise_survey` over 42 frames spanning ISO 100 to
    /// 12800, so this fails if the ramp is ever moved off the photographs it was fitted to. The
    /// alpha is zero throughout because the slope is precisely what this rule does not consult.
    #[test]
    fn a_clean_frame_is_left_alone_and_a_noisy_one_is_not() {
        let at = |read: f32| NoiseModel { alpha: 0.0, sigma_sq: read * read }.suggested_amount();
        // Base ISO, across both libraries: the whole range is declined rather than put through
        // the chain to be left alone.
        for clean in [0.00017, 0.00026, 0.00036, 0.00052] {
            assert_eq!(at(clean), 0.0, "a base-ISO frame at {clean} asks for nothing");
        }
        // ISO 250 is barely off the gate, and the library's noisiest frame - DSC00982 at ISO 12800
        // - is where the track was judged against the body's JPEG. Nothing measured reaches the
        // upper half, the ramp erring towards grain rather than towards smearing.
        assert!((1.0..20.0).contains(&at(0.00088)), "ISO 250 asks {}", at(0.00088));
        assert!((20.0..35.0).contains(&at(0.00211)), "ISO 5000 asks {}", at(0.00211));
        assert!((35.0..45.0).contains(&at(0.00275)), "ISO 12800 asks {}", at(0.00275));
        // Ramped rather than stepped, so two frames either side of the gate are not two
        // different photographs.
        assert!(at(0.0007) < at(0.0009));
    }

    /// The slope is what the automatic amount refuses to read, and this is why.
    ///
    /// Both of these are real: `DSC00982` at ISO 12800 fits a slope of 0.000024 where `DSC00981`
    /// at the same sensitivity fits 0.001258, because the regression behind it needs a spread of
    /// levels that a mostly-black frame does not offer. Keyed on the slope the noisier of the two
    /// asks for less than a third of what the other does; keyed on the read floor it does not.
    #[test]
    fn a_collapsed_slope_does_not_decide_the_amount() {
        let collapsed = NoiseModel { alpha: 0.000024, sigma_sq: 0.00000759 };
        let intact = NoiseModel { alpha: 0.001258, sigma_sq: 0.00000635 };
        assert!(
            collapsed.suggested_amount() > intact.suggested_amount(),
            "the noisier frame asks for more: {} against {}",
            collapsed.suggested_amount(),
            intact.suggested_amount(),
        );
        assert!(
            collapsed.at_mid_grey() < intact.at_mid_grey(),
            "the statistic this rule refuses to use is the one that inverts them",
        );
    }

    /// A frame clean enough that its Poisson means run past what f32 can sum.
    ///
    /// The inverse table's photon count is `x / alpha`, so the cleaner the frame the further the
    /// sum reaches - and past about lambda 125000 an f32 evaluation of it returns zero, which is
    /// a table whose ends bracket nothing. Every pixel then takes `gat_inv_lut`'s `d >= d_max`
    /// arm, comes back 1.0, and the photograph is flat white with nothing logged anywhere.
    ///
    /// A clean frame is the one nobody thinks to test a *denoise* on, and an ISO 50 exposure in a
    /// real library fits 4e-6. Asserting on the edge rather than on the variance, because what
    /// fails is not the filter working too hard but the picture being replaced by a constant.
    #[test]
    fn a_frame_too_clean_to_fit_still_comes_back_a_picture() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(galosh) = device(gpu) else {
            return;
        };

        let (width, height) = (256, 192);
        // Two orders under the noisy frame above, which is where the fitted slope falls under
        // what the table could be summed for.
        let clean = frame_with_noise(width, height, 0.0005);
        let uploaded = crate::condition::Mosaic::upload(gpu, &clean, width, height);
        let fit =
            pollster::block_on(denoise(gpu, galosh, &uploaded, &rggb(), Amounts { luma: 1.0, colour: 1.0 }));
        let denoised = read(gpu, &uploaded);

        assert!(
            fit.alpha >= ALPHA_MIN,
            "the fit must not report a slope the table cannot be summed for: {}",
            fit.alpha,
        );
        let step = |frame: &[f32]| {
            let row = 96 * width;
            frame[row + width / 2 + 8] - frame[row + width / 2 - 8]
        };
        assert!(
            step(&denoised) > step(&clean) * 0.9,
            "the edge should survive a frame this clean: {} -> {}",
            step(&clean),
            step(&denoised),
        );
    }

    /// A silhouette edge must not come back wearing a stripe.
    ///
    /// The inverse pairs the phase-averaged luma with chroma that exists only at site phase,
    /// so any luma the average mixes across a hard step prints on the two adjacent rows with
    /// alternating sign - `lpixel_lh_den_fused` weighs its phases to prevent exactly this,
    /// and this is the pin that holds it. A row's mean change is the stripe's own measure:
    /// legitimate denoising is zero-mean over a row, the stripe is not.
    #[test]
    fn a_hard_edge_comes_back_without_a_stripe() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(galosh) = device(gpu) else {
            return;
        };

        let (width, height) = (512, 384);
        // A blue-ish sky over a near-black hill, meeting along near-horizontal runs, at the
        // levels a sunset actually decodes to.
        let mut seed = 0x853c_49e6_748f_ea9bu64;
        let mut uniform = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 40) as f32 / 16777216.0
        };
        let noisy: Vec<f32> = (0..width * height)
            .map(|at| {
                let (x, y) = (at % width, at / width);
                let slot = (y & 1) | ((x & 1) << 1);
                let ridge = height as f32 * 0.45 + 20.0 * (x as f32 / 97.0).sin();
                let level: f32 =
                    if (y as f32) < ridge { [0.08, 0.11, 0.11, 0.16][slot] } else { 0.002 };
                let sigma = 0.0005 + 0.01 * level.sqrt();
                (level + (uniform() + uniform() + uniform() - 1.5) * sigma).clamp(0.0, 1.0)
            })
            .collect();

        let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
        pollster::block_on(denoise(gpu, galosh, &uploaded, &rggb(), Amounts::from_sliders(40.0, 40.0)));
        let denoised = read(gpu, &uploaded);

        for row in 0..height {
            let mean = (0..width)
                .map(|col| f64::from(denoised[row * width + col] - noisy[row * width + col]))
                .sum::<f64>()
                / width as f64;
            // The plain average printed 0.005 here; the weighted one leaves 0.0002.
            assert!(
                mean.abs() < 0.001,
                "row {row} moved by {mean:.5} on average, which is a stripe rather than a denoise",
            );
        }
    }

    /// Black with read noise on it denoises to black rather than to the upper half of its noise.
    #[test]
    fn a_noisy_black_denoises_to_black() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(galosh) = device(gpu) else {
            return;
        };

        let (width, height) = (512, 384);
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut uniform = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 40) as f32 / 16777216.0
        };
        let read_noise = 0.004;
        // Lit on the right so the fit has a slope to measure, black on the left.
        let noisy: Vec<f32> = (0..width * height)
            .map(|at| {
                let (x, y) = (at % width, at / width);
                let slot = (y & 1) | ((x & 1) << 1);
                let level: f32 = if x > width / 2 { [0.20, 0.34, 0.34, 0.12][slot] } else { 0.0 };
                let sigma = read_noise + 0.01 * level.sqrt();
                level + (uniform() + uniform() + uniform() - 1.5) * 2.0 * sigma
            })
            .collect();

        let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
        pollster::block_on(denoise(gpu, galosh, &uploaded, &rggb(), Amounts::from_sliders(40.0, 40.0)));
        let denoised = read(gpu, &uploaded);

        let black: Vec<f64> = (16..height - 16)
            .flat_map(|row| (16..width / 2 - 32).map(move |col| row * width + col))
            .map(|at| f64::from(denoised[at]))
            .collect();
        let mean = black.iter().sum::<f64>() / black.len() as f64;
        // A zero floor after the inverse leaves 0.00048 here.
        assert!(mean.abs() < 0.0001, "black denoised to a mean of {mean:.5}");
    }

    /// A colour step at the top of the Colour track must stay where the scene put it.
    ///
    /// The coarse levels are box downsamples, so taken whole the eighth spread a saturated green
    /// on grey across sixteen pixels; `LEVEL_REACH` is the pin's subject.
    #[test]
    fn a_colour_step_does_not_bleed_off_the_coarse_levels() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(galosh) = device(gpu) else {
            return;
        };

        let (width, height) = (512, 384);
        // Off every level's box grid: a step on a multiple of sixteen is never averaged across.
        let edge = 262;
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut uniform = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 40) as f32 / 16777216.0
        };
        let level = |x: usize, slot: usize| -> f32 {
            if x < edge { 0.1 } else { [0.03, 0.18, 0.18, 0.03][slot] }
        };
        let noisy: Vec<f32> = (0..width * height)
            .map(|at| {
                let (x, y) = (at % width, at / width);
                let level = level(x, (y & 1) | ((x & 1) << 1));
                let sigma = 0.0005 + 0.01 * level.sqrt();
                (level + (uniform() + uniform() + uniform() - 1.5) * sigma).clamp(0.0, 1.0)
            })
            .collect();

        let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
        pollster::block_on(denoise(gpu, galosh, &uploaded, &rggb(), Amounts::from_sliders(0.0, 100.0)));
        let denoised = read(gpu, &uploaded);

        // The red sites, averaged down each column: the grey side is 0.1 and the green side 0.03.
        for x in (0..width).step_by(2).filter(|x| x.abs_diff(edge) >= 6) {
            let mean = (0..height).step_by(2).map(|y| denoised[y * width + x]).sum::<f32>()
                / (height / 2) as f32;
            let off = (mean - level(x, 0)).abs() / 0.07;
            // Ungated, six pixels off the step read a quarter of it and twelve read 0.07.
            assert!(off < 0.03, "column {x} carries {off:.3} of the step");
        }
    }

    /// A bright curved edge must not come back with a rim of its own light on the dark side.
    ///
    /// A curve carries every sequency of the block transform, so a gain that scales the interior
    /// ones scales the edge's signal with them and the overlap average spreads the difference.
    #[test]
    fn a_bright_curve_comes_back_without_a_halo() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(galosh) = device(gpu) else {
            return;
        };

        let (width, height) = (384, 384);
        let (centre, radius) = (189.3f32, 120.0f32);
        let (inside, outside) = (0.4f32, 0.06f32);
        let mut seed = 0x6a09_e667_f3bc_c908u64;
        let mut uniform = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 40) as f32 / 16777216.0
        };
        let distance =
            |at: usize| ((at % width) as f32 - centre).hypot((at / width) as f32 - centre) - radius;
        let noisy: Vec<f32> = (0..width * height)
            .map(|at| {
                let level = outside + (inside - outside) * (0.5 - distance(at)).clamp(0.0, 1.0);
                let sigma = 0.0005 + 0.01 * level.sqrt();
                (level + (uniform() + uniform() + uniform() - 1.5) * sigma).clamp(0.0, 1.0)
            })
            .collect();

        let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
        pollster::block_on(denoise(gpu, galosh, &uploaded, &rggb(), Amounts::from_sliders(40.0, 0.0)));
        let denoised = read(gpu, &uploaded);

        for band in [1.0f32, 2.0, 3.0, 4.0] {
            let ring: Vec<f32> = (0..width * height)
                .filter(|&at| (band..band + 1.0).contains(&distance(at)))
                .map(|at| denoised[at])
                .collect();
            let lift = ring.iter().sum::<f32>() / ring.len() as f32 / outside - 1.0;
            // A ceiling of half on the interior gains read 0.16 here, one pixel out.
            assert!(lift.abs() < 0.04, "{band}px outside the rim is lifted by {lift:.3}");
        }
    }

    /// Fine detail on a grey subject must not come back as colour.
    ///
    /// The two greens of a site sample the same filter at two positions, so `gr - gb` holds the
    /// luma gradient across the site's anti-diagonal and no hue at all. It reaches the chroma
    /// planes anyway - it is `c1 - c2` of the 2x2 transform - and the colour arm treated the trio
    /// alike, so a gradient the half-resolution guide cannot see was flattened and the site came
    /// back with its greens disagreeing. That is a green imbalance, and a directional demosaic
    /// spreads one into a crosshatch: measured on a synthetic siemens star, a coloured weave over
    /// every radius where the spokes pass the red and blue sampling limit.
    ///
    /// Achromatic by construction - one scene function, sampled by all four photosites - so any
    /// colour in the answer was invented. Resolvable too, at six pixels along the diagonal, which
    /// leaves no argument that the pattern was beyond what the mosaic could carry.
    #[test]
    fn fine_detail_on_a_grey_subject_does_not_come_back_as_colour() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(galosh) = device(gpu) else {
            return;
        };

        let (width, height) = (256, 192);
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut uniform = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 40) as f32 / 16777216.0
        };
        // A 45-degree grating over the lower half, which is where a site's two greens are furthest
        // apart - the whole of the signal this is about lands in `gr - gb` and none of it in the
        // site's mean.
        //
        // **Flat above it, and the fit is why.** Phase 0 reads the frame's noise off per-block
        // variance, so a frame that is nothing but a grating reports the grating as noise: the
        // normalised space then puts this pattern a couple of sigma up instead of sixty, and every
        // threshold below reads as though the picture were grain.
        let scene = |x: usize, y: usize| {
            if y < height / 2 {
                return 0.25;
            }
            let along = (x as f32 - y as f32) * std::f32::consts::TAU / 6.0;
            0.25 * (1.0 + 0.4 * along.sin())
        };
        let noisy: Vec<f32> = (0..width * height)
            .map(|at| {
                let (x, y) = (at % width, at / width);
                let level = scene(x, y);
                (level + (uniform() + uniform() + uniform() - 1.5) * 0.004).clamp(0.0, 1.0)
            })
            .collect();

        // Per site, and over the interior: the transform reflects at the frame's edge, so the
        // outermost sites answer for the boundary rule rather than for this.
        let greens = |frame: &[f32], site_x: usize, site_y: usize| {
            let (x, y) = (site_x * 2, site_y * 2);
            f64::from(frame[y * width + x + 1] - frame[(y + 1) * width + x])
        };
        // **Against the same chain with the colour arm off, not against the frame that went in.**
        // The final upsample places one site's chroma on all four of its pixels whatever the
        // sliders say, and on a grating this fine that alone moves the difference - so a bound
        // against the input would be a bound on a stage this test is not about, and would pass or
        // fail on the pattern's period rather than on the colour arm's behaviour.
        let moved_at = |colour: f32| {
            let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
            pollster::block_on(denoise(gpu, galosh, &uploaded, &rggb(), Amounts { luma: 0.0, colour }));
            let denoised = read(gpu, &uploaded);
            let mut moved = 0f64;
            let mut sites = 0f64;
            for site_y in height / 4 + 4..height / 2 - 4 {
                for site_x in 4..width / 2 - 4 {
                    let delta = greens(&denoised, site_x, site_y) - greens(&noisy, site_x, site_y);
                    moved += delta * delta;
                    sites += 1.0;
                }
            }
            (moved / sites).sqrt()
        };
        let untouched = moved_at(0.0);
        let smoothed = moved_at(2.0);

        // No more than leaving colour off moves it, which is the claim rather than a number: a
        // grey subject has no hue for the colour arm to find, so whatever it does here is invented.
        // Smoothed as though it were one, this ran 1.45x the floor; weighed against the noise it
        // sits under it. The 5% is for a driver's arithmetic, not for a little smoothing.
        assert!(
            smoothed < untouched * 1.05,
            "the colour arm moved a grey subject's green difference by {smoothed:.5} where \
             leaving colour alone moves it {untouched:.5}, and the excess can only come back \
             as a hue",
        );
    }

    /// Texture on a coloured surface must survive the colour denoise.
    ///
    /// A site's three differences carry the brightness change across it as well as its hue, so a
    /// pyramid that smooths them as hue takes the texture with the noise and the inverse rebuilds
    /// each site flat - skin and hair come back painted, with the site grid showing through.
    /// `chroma_detail` is the pin's subject. Green, because on a coloured surface the modulation
    /// lands in the greens alone and a grey model of it would miss most of it.
    #[test]
    fn texture_on_a_coloured_surface_survives_the_colour_denoise() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(galosh) = device(gpu) else {
            return;
        };

        let (width, height) = (384, 384);
        let mut seed = 0x3c6e_f372_fe94_f82bu64;
        let mut uniform = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 40) as f32 / 16777216.0
        };
        let base = |slot: usize| [0.03f32, 0.18, 0.18, 0.03][slot];
        let texture = |x: usize, y: usize| {
            let (x, y) = (x as f32, y as f32);
            0.12 * (x * std::f32::consts::TAU / 5.0).sin() * (y * std::f32::consts::TAU / 7.0).cos()
        };
        let slot = |x: usize, y: usize| (y & 1) | ((x & 1) << 1);
        let noisy: Vec<f32> = (0..width * height)
            .map(|at| {
                let (x, y) = (at % width, at / width);
                let level = base(slot(x, y)) * (1.0 + texture(x, y));
                let sigma = 0.0005 + 0.01 * level.sqrt();
                (level + (uniform() + uniform() + uniform() - 1.5) * sigma).clamp(0.0, 1.0)
            })
            .collect();

        let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
        pollster::block_on(denoise(gpu, galosh, &uploaded, &rggb(), Amounts::from_sliders(0.0, 27.0)));
        let denoised = read(gpu, &uploaded);

        // The texture's own amplitude in the answer, by projection, away from the reflected edges.
        let (mut along, mut power) = (0f64, 0f64);
        for y in 16..height - 16 {
            for x in 16..width - 16 {
                let level = base(slot(x, y));
                let wanted = f64::from(level * texture(x, y));
                along += f64::from(denoised[y * width + x] - level) * wanted;
                power += wanted * wanted;
            }
        }
        let kept = along / power;
        // 0.69 with the bracket and 0.33 without it.
        assert!(kept > 0.6, "the colour denoise kept {kept:.3} of the texture");
    }

    /// The pattern every synthetic frame here is written in, `frame_with_noise`'s four levels
    /// being indexed by the same 2x2 slot.
    fn rggb() -> crate::cfa::Cfa {
        crate::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB is a pattern")
    }

    /// The mosaic back on the host, which is where these tests compare frames.
    fn read(gpu: &crate::gpu::Gpu, mosaic: &crate::condition::Mosaic) -> Vec<f32> {
        pollster::block_on(mosaic.read(gpu)).expect("the mosaic reads back")
    }

    /// A synthetic frame: four flat CFA levels with Gaussian noise on top, and one hard
    /// vertical edge, so a test can ask both what was removed and what was kept.
    fn frame(width: usize, height: usize) -> Vec<f32> {
        frame_with_noise(width, height, 0.05)
    }

    fn frame_with_noise(width: usize, height: usize, amplitude: f32) -> Vec<f32> {
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
            sum * amplitude
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
        let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
        pollster::block_on(denoise(gpu, galosh, &uploaded, &rggb(), Amounts { luma: 1.0, colour: 1.0 }));
        let denoised = read(gpu, &uploaded);

        assert!(
            denoised.iter().all(|v| v.is_finite() && *v <= 1.0),
            "the inverse table's output stays finite and below saturation",
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
