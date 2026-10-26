//! GALOSH-RAW: the blind denoise, on the mosaic, on the GPU.
//!
//! **Why the mosaic and not the frame.** Sensor noise is per-photosite. A demosaic averages
//! neighbouring sites to invent the two colours each site did not record, which correlates
//! the noise across pixels and smears a chroma error into a coloured smudge no
//! post-demosaic filter can separate again. Denoising first is the only place the noise is
//! still what the sensor made.
//!
//! **Blind.** Phase 0 fits the sensor's own Poisson-Gaussian model off the frame - shot and read
//! noise as the slope and intercept of green's variance against level - so there is no per-body
//! noise profile to ship and no ISO to trust.
//!
//! The kernels are in `slang/galosh/` with every other shader, compiled at build time and
//! `include_str!`'d out of `OUT_DIR`. This module is the only thing that dispatches them either
//! way: a browser reaches these kernels through the wasm build of it rather than by binding them
//! itself.
//!
//! **The shrinkage is a multi-scale pyramid.** Each site of the stabilised mosaic (2x2 on Bayer,
//! 3x3 on X-Trans) goes through an orthonormal transform into one plane per photosite, and every
//! plane is box-downsampled into four levels, each shrunk as 8x8 DCT blocks at stride 4 (a
//! block-thresholded pilot, then a Wiener pass off it) and fused back up through its Laplacian.

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

/// Sizes of the histograms, the table and the partials `prelude.slang` declares, held against its
/// text by `the_table_sizes_are_the_ones_the_shader_declares`.
const SIGMA_BINS: usize = 4096;
const LUT_SIZE: usize = 4096;
const UNDER_BLACK_SUMS: usize = 24;

/// `params_buf` slots, which are `prelude.slang`'s and must stay its.
///
/// Only the ones the host writes or reads are here; the kernels address the rest themselves. The
/// readback below and `NoiseFit`'s seeding are the two places this side touches the block, and
/// `the_params_slots_are_the_ones_the_shader_declares` holds these against the shader's own text.
const P_UNIFIED_SIGMA: usize = 4;
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

/// What `ne_finalize` holds in workgroup storage, the most any kernel here does.
const WORKGROUP_STORAGE: u32 = 23_556;

/// `pyramid.slang`'s shape, which `the_pyramid_is_the_shape_its_shaders_declare` holds to it.
const PYRAMID_LEVELS: usize = 4;
const PYRAMID_MAX_PLANES: usize = 9;
const PYRAMID_TILE: usize = 28;
const PYRAMID_STRIDE: usize = 4;
const PYRAMID_PILOT_ID: &str = "0";
const PYRAMID_OWN_PILOT_ID: &str = "1";
const PYRAMID_FROM_RAW_ID: &str = "0";
/// The luma Wiener pass's block grids, averaged: one grid leaves block-edge haze on flat ground.
const PYRAMID_LUMA_OFFSETS: [(usize, usize); 2] = [(0, 0), (2, 2)];

/// How far past a pixel the pyramid reads, in the coarsest level's sites: three 7-site passes and
/// the fuses' bilinear drift come to 23, and the site's own span rounds it up. Recompute on any
/// change to the levels, block or passes; `tiling_the_denoise_does_not_move_a_sample` holds it.
const PYRAMID_REACH_SITES: usize = 24;
const PYRAMID_COLOUR_BY_LEVEL: [f32; PYRAMID_LEVELS] = [0.5, 0.5, 0.7, 1.0];

/// Photosites a side of one of the coarsest level's sites.
fn coarsest_site(side: usize) -> usize {
    side << (PYRAMID_LEVELS - 1)
}

/// The halo a region of this pattern needs at least, past the `halo` its caller asked for.
pub fn reach(cfa: &crate::cfa::Cfa, halo: usize) -> usize {
    let side = site_side(cfa).unwrap_or(2);
    halo.max(PYRAMID_REACH_SITES * coarsest_site(side))
}

/// The grid a region's origin has to start on, per axis, for its denoise to be the frame's.
///
/// Claims on one number: the coarsest level's block stride, so every level's blocks sit where the
/// whole frame's do, and a whole period of the pattern, since the site transform is the period's.
/// So an origin owes the first common multiple: 64 on Bayer, 96 on X-Trans.
pub fn lattice(cfa: &crate::cfa::Cfa) -> (usize, usize) {
    let multiple = |a: usize, b: usize| a / gcd(a, b) * b;
    let side = site_side(cfa).unwrap_or(2);
    let blocks = PYRAMID_STRIDE * coarsest_site(side);
    let (pw, ph) = cfa.period();
    (multiple(blocks, pw), multiple(blocks, ph))
}

fn gcd(mut a: usize, mut b: usize) -> usize {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
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
    under_black_reduce: Kernel,
    ne_finalize: Kernel,
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
    pyr_pack: Kernel,
    /// `pyr_pack` straight off the conditioned mosaic, for a run handed its fit.
    pyr_pack_raw: Kernel,
    pyr_down: Kernel,
    /// `pyr_shrink` as its pilot.
    pyr_pilot: Kernel,
    pyr_shrink: Kernel,
    /// `pyr_shrink` with each block's gains off its own pilot.
    pyr_shrink_own: Kernel,
    pyr_fuse: Kernel,
    pyr_restore: Kernel,
}

/// Whether this pattern's mosaic is one GALOSH can filter at all.
pub fn filters(cfa: &crate::cfa::Cfa) -> bool {
    site_side(cfa).is_some()
}

/// Photosites a side of the smallest square that tiles the period with every colour in each: 2 on
/// Bayer, 3 on X-Trans.
fn site_side(cfa: &crate::cfa::Cfa) -> Option<usize> {
    let (pw, ph) = cfa.period();
    (2..=3).find(|&side| {
        pw % side == 0
            && ph % side == 0
            && (0..ph / side).all(|down| {
                (0..pw / side).all(|across| {
                    let colours = |colour| {
                        (0..side * side).any(|k| {
                            cfa.colour_at(down * side + k / side, across * side + k % side)
                                == colour
                        })
                    };
                    [crate::cfa::RED, crate::cfa::GREEN, crate::cfa::BLUE]
                        .into_iter()
                        .all(colours)
                })
            })
    })
}

/// Each site of one period's orthonormal transform, row-major `PYRAMID_MAX_PLANES` square: the
/// site's mean, its red-blue and magenta-green differences, then each colour's photosites against
/// their own mean as gradients across the site. Orthonormal, so the GAT's unit white noise stays
/// unit and white in every plane, and the transpose undoes it.
fn site_transform(cfa: &crate::cfa::Cfa, side: usize) -> Vec<f32> {
    let (pw, ph) = cfa.period();
    let planes = side * side;
    let mut table = Vec::new();
    for down in 0..ph / side {
        for across in 0..pw / side {
            let colour = |k: usize| cfa.colour_at(down * side + k / side, across * side + k % side);
            let of = |wanted: u8| -> Vec<f64> {
                let count = (0..planes).filter(|&k| colour(k) == wanted).count() as f64;
                (0..planes)
                    .map(|k| {
                        if colour(k) == wanted {
                            1.0 / count
                        } else {
                            0.0
                        }
                    })
                    .collect()
            };
            let (red, green, blue) = (
                of(crate::cfa::RED),
                of(crate::cfa::GREEN),
                of(crate::cfa::BLUE),
            );
            let mut candidates = vec![
                vec![1.0; planes],
                (0..planes).map(|k| red[k] - blue[k]).collect(),
                (0..planes)
                    .map(|k| 0.5 * (red[k] + blue[k]) - green[k])
                    .collect::<Vec<f64>>(),
            ];
            let gradients = |x: f64, y: f64| {
                let (xx, yy) = (x * x, y * y);
                [x, y, x * y, xx, yy, xx * y, x * yy, xx * yy]
            };
            for wanted in [crate::cfa::GREEN, crate::cfa::RED, crate::cfa::BLUE] {
                for term in 0..8 {
                    candidates.push(
                        (0..planes)
                            .map(|k| match colour(k) == wanted {
                                true => gradients((k % side) as f64, (k / side) as f64)[term],
                                false => 0.0,
                            })
                            .collect(),
                    );
                }
            }
            let mut rows: Vec<Vec<f64>> = Vec::new();
            for mut candidate in candidates {
                for row in &rows {
                    let along: f64 = candidate.iter().zip(row).map(|(c, r)| c * r).sum();
                    candidate
                        .iter_mut()
                        .zip(row)
                        .for_each(|(c, r)| *c -= along * r);
                }
                let norm = candidate.iter().map(|c| c * c).sum::<f64>().sqrt();
                if norm > 1e-6 && rows.len() < planes {
                    rows.push(candidate.iter().map(|c| c / norm).collect());
                }
            }
            assert_eq!(
                rows.len(),
                planes,
                "a site's transform spans its photosites"
            );
            for p in 0..PYRAMID_MAX_PLANES {
                for k in 0..PYRAMID_MAX_PLANES {
                    let value = match p < planes && k < planes {
                        true => rows[p][k] as f32,
                        false => 0.0,
                    };
                    table.push(value);
                }
            }
        }
    }
    table
}

/// What `pyr_shrink` reads to find a block's colours from its first three planes: those planes of
/// a flat colour per colour (3x3, plane by colour), its inverse (colour by plane), and each colour's
/// share of the four parity slots the dark references are kept by (3x4).
fn colour_basis(cfa: &crate::cfa::Cfa, side: usize) -> Vec<f32> {
    let table = site_transform(cfa, side);
    let mut flat = [[0.0f64; 3]; 3];
    for k in 0..side * side {
        let colour = cfa.colour_at(k / side, k % side) as usize;
        for (p, row) in flat.iter_mut().enumerate() {
            row[colour] += f64::from(table[p * PYRAMID_MAX_PLANES + k]);
        }
    }
    let inverse =
        crate::hdr_fit::invert3(&flat).expect("a site holds every colour, so its colours separate");
    let (pw, ph) = cfa.period();
    let mut slots = [[0.0f64; 4]; 3];
    for y in 0..ph {
        for x in 0..pw {
            slots[cfa.colour_at(y, x) as usize][(y & 1) | ((x & 1) << 1)] += 1.0;
        }
    }
    let mut basis = Vec::with_capacity(30);
    basis.extend(flat.iter().flatten().map(|&v| v as f32));
    basis.extend(inverse.iter().flatten().map(|&v| v as f32));
    for counts in slots {
        let total: f64 = counts.iter().sum();
        basis.extend(counts.iter().map(|&count| (count / total) as f32));
    }
    basis
}

pub const UNGAINED: [f32; 3] = [1.0; 3];

/// `prelude::to_green`'s red and blue: green's conditioning gain over each one's.
fn to_green(gains: [f32; 3]) -> [f32; 2] {
    let over = |colour: f32| {
        let ratio = gains[1] / colour;
        if ratio.is_finite() && ratio > 0.0 {
            ratio
        } else {
            1.0
        }
    };
    [over(gains[0]), over(gains[2])]
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
        // `ne_finalize` wants more than the 16KB a WebGPU device is only required to offer, so
        // this is asked rather than assumed - a validation failure would be fatal, since
        // `on_uncaptured_error` panics.
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
                        ty: wgpu::BufferBindingType::Storage {
                            read_only: *read_only,
                        },
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
            Kernel {
                pipeline,
                layout,
                name,
            }
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
            under_black_reduce: kernel!("under_black_reduce", &[(0, R), (1, W)]),
            ne_finalize: kernel!("ne_finalize", &[(0, R), (1, R), (2, R), (3, W)]),
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
            pyr_pack: kernel!("pyr_pack", &[(0, R), (1, W), (2, W), (3, R), (9, R)]),
            pyr_pack_raw: kernel!(
                "pyr_pack",
                &[(0, R), (1, W), (2, W), (3, R), (9, R)],
                &[(PYRAMID_FROM_RAW_ID, 1.0)]
            ),
            pyr_down: kernel!("pyr_down", &[(0, R), (1, W)]),
            pyr_pilot: kernel!(
                "pyr_shrink",
                &[(0, R), (1, W), (3, R), (4, R), (5, R)],
                &[(PYRAMID_PILOT_ID, 1.0)]
            ),
            pyr_shrink: kernel!("pyr_shrink", &[(0, R), (1, W), (3, R), (4, R), (5, R)]),
            pyr_shrink_own: kernel!(
                "pyr_shrink",
                &[(0, R), (1, W), (3, R), (4, R), (5, R)],
                &[(PYRAMID_OWN_PILOT_ID, 1.0)]
            ),
            pyr_fuse: kernel!("pyr_fuse", &[(0, W), (1, R), (2, R)]),
            pyr_restore: kernel!(
                "pyr_restore",
                &[
                    (0, R),
                    (1, R),
                    (2, R),
                    (4, W),
                    (5, R),
                    (6, R),
                    (7, R),
                    (8, R),
                    (9, R)
                ]
            ),
        })
    }
}

/// How hard each half of the denoise works, for the luma plane and for every other plane: the
/// noise each Wiener pass assumes, as a multiple of the deviation the fit measured, and under 1 the
/// share of the noise taken out, the rest left as it was. Both zero is the frame untouched.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Amounts {
    pub luma: f32,
    pub colour: f32,
}

/// The sensor's noise, as Phase 0 fitted it off this frame.
///
/// A physical model rather than a slider position: the variance of a green photosite reading a
/// signal `s` is `alpha * s + sigma_sq`, shot noise and read noise, both in the units the
/// mosaic was conditioned into. Fitted from the frame's own statistics - the slope and intercept
/// of per-block variance against per-block level - so it needs no per-body profile and does not
/// consult the ISO, which by itself cannot tell a pushed exposure from a clean one.
///
/// Green's noise: a reader that divides a conditioning gain back out (`pmrid`,
/// `base::noise_already_balanced`) divides green's.
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
        NoiseModel {
            alpha: self.alpha,
            sigma_sq: self.sigma_sq,
        }
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
        let hi = self
            .dark_ref
            .iter()
            .copied()
            .fold(f32::NEG_INFINITY, f32::max);
        hi - lo <= ACHROMATIC_RANGE
    }
}

/// Where [`NoiseModel::shadow_noise`] is read, in the conditioned mosaic's units: moving it moves
/// every automatic Detail, whose gate and span were set against the noise here.
const SHADOW: f32 = 0.014;

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

    /// The noise a shadow carries, which is what says how noisy a *photograph* is: grain shows
    /// first a little above black, where neither term alone describes it.
    pub fn shadow_noise(&self) -> f32 {
        (self.alpha * SHADOW + self.sigma_sq).max(0.0).sqrt()
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
        const GATE: f32 = 0.00082;
        const SPAN: f32 = 0.0074;
        let over = self.shadow_noise() - GATE;
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
const TRACK_TOP: f64 = 0.992;

/// How far ahead of luminance the suggestion runs colour, as the panel's own numbers - the two
/// tracks do not share a top, so this is a lead on the slider a reader sees rather than on the
/// amount the kernels are handed.
const COLOUR_LEAD: f64 = 3.2;

const COLOUR_TRACK_TOP: f64 = 3.0;

impl Amounts {
    /// The Detail panel's two sliders, 0 to 100, in the units the kernels read.
    ///
    /// A position is a fraction of a track a reader drags, so each track ends at the strongest
    /// setting worth shipping.
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
/// and an ISO 12800 one. Left unset a slider is [`NoiseModel::suggested_amounts`] off the fit of
/// the frame being decoded.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Detail {
    pub luminance: Option<f64>,
    pub colour: Option<f64>,
    /// Which filter those two positions drive, which is a choice and not a strength.
    #[serde(default)]
    pub denoiser: Denoiser,
    /// The Highlight recovery slider, 0 to 100; unset is 100.
    #[serde(default)]
    pub highlight_recovery: Option<f64>,
}

/// The filter the Detail panel drives.
///
/// **Here beside the panel's own document rather than in either filter's module**, because it is
/// neither one's to define: a document holds a reader's choice between them, and both modules are
/// downstream of that. What the two positions mean does depend on which is chosen - GALOSH reads
/// Luminance as a multiple of the noise it measured, where PMRID reads it as the share of the
/// residual it predicted to keep - and `crate::pmrid::denoise` says why that is not a mismatch to
/// paper over.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Denoiser {
    /// The blind denoise, which measures this frame and filters it on its own statistics.
    #[default]
    Galosh,
    /// A published network, which brings another sensor's calibration and is worth choosing where
    /// this frame suits it.
    Pmrid,
    /// Our own network (`crate::upscale`), which denoises the mosaic as it upscales it to twice the
    /// photosites, demosaiced there and taken back to the photo's size.
    Upscaler,
}

impl Detail {
    /// Both halves as a reader set them.
    pub const fn at(luminance: f64, colour: f64) -> Detail {
        Detail {
            luminance: Some(luminance),
            colour: Some(colour),
            denoiser: Denoiser::Galosh,
            highlight_recovery: None,
        }
    }

    /// The same pair, driving the other filter.
    pub const fn using(self, denoiser: Denoiser) -> Detail {
        Detail { denoiser, ..self }
    }

    /// What a decode the upscaler cannot serve denoises with: a frame merged from a pixel-shift
    /// burst has no upscale to take back down, and an X-Trans one no Bayer mosaic to upscale, so
    /// those take GALOSH at the frame's own amounts in its place.
    pub fn without_upscaler(self) -> Detail {
        match self.denoiser {
            Denoiser::Upscaler => Detail::AUTO,
            _ => self,
        }
    }

    /// This as a decode over a mosaic that is or is not a Bayer one carries it out: both networks
    /// read a 2x2 site, so off Bayer either takes GALOSH at the frame's own amounts.
    pub fn on_bayer(self, bayer: bool) -> Detail {
        match (bayer, self.denoiser) {
            (true, _) | (false, Denoiser::Galosh) => self,
            (false, _) => Detail::AUTO,
        }
    }

    /// Neither, which is what a document that has never been edited holds.
    pub const AUTO: Detail = Detail {
        luminance: None,
        colour: None,
        denoiser: Denoiser::Galosh,
        highlight_recovery: None,
    };

    /// How much colour a reconstructed highlight keeps.
    pub fn colouring(&self) -> crate::highlight::Colouring {
        crate::highlight::Colouring::at(self.highlight_recovery.unwrap_or(100.0) / 100.0)
    }

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
        self.denoiser == Denoiser::Upscaler
            || self.luminance.unwrap_or(100.0) > 0.0
            || self.colour.unwrap_or(100.0) > 0.0
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
        let (luma, colour) = match (self.denoiser, fit) {
            (Denoiser::Upscaler, _) => (crate::upscale::LUMINANCE, 100.0),
            (_, Some(fit)) => fit.model().suggested_amounts(),
            (_, None) => (0.0, 0.0),
        };
        (
            self.luminance.unwrap_or(luma.round()),
            self.colour.unwrap_or(colour.round()),
        )
    }

    /// The same pair in the units the kernels read.
    pub fn amounts(&self, fit: Option<NoiseFit>) -> Amounts {
        let (luminance, colour) = self.resolved(fit);
        Amounts::from_sliders(luminance, colour)
    }

    /// The share of the frame's noise variance this denoise leaves, approximately; 1 where it
    /// filters nothing. `fit` is the one the decode denoised against, None where it denoised nothing.
    pub fn noise_left(&self, fit: Option<NoiseFit>) -> f32 {
        if fit.is_none() {
            return 1.0;
        }
        let (luminance, _) = self.resolved(fit);
        let left = match self.denoiser {
            Denoiser::Upscaler => crate::upscale::noise_left(luminance),
            Denoiser::Pmrid | Denoiser::Galosh => {
                let kept = 1.0 - (luminance / 100.0).clamp(0.0, 1.0);
                kept * kept
            }
        };
        // No denoise leaves none; a gate at 0 noise sharpens whatever grain did survive.
        left.max(LEAST_NOISE_LEFT) as f32
    }
}

const LEAST_NOISE_LEFT: f64 = 0.02;

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
static STOP_AFTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(usize::MAX);

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
    let wanted = (per_channel / NE_TARGET_BLOCKS).max(1);
    (wanted..)
        .find(|s| gcd(*s, blocks_across.max(1)) == 1)
        .unwrap_or(1)
}

/// The kernels the last run recorded, in the order it recorded them.
///
/// Kept only while a profile is being read, since the sequence is a fact about one call's shape -
/// a supplied fit skips Phase 2's iterations, a cached table skips two more - so it has to come
/// from the run being priced rather than from a list written beside it.
static DISPATCHED: std::sync::Mutex<Vec<(&'static str, u32)>> = std::sync::Mutex::new(Vec::new());

/// Each kernel the last run recorded, with the workgroups it was dispatched over.
///
/// The count is what says whether a dispatch can fill the machine at all: a device schedules whole
/// workgroups onto its cores, so one that offers fewer than the device has slots leaves the rest
/// idle however long it runs, and no amount of work inside the kernel reaches them.
pub fn dispatched() -> Vec<(&'static str, u32)> {
    DISPATCHED
        .lock()
        .unwrap_or_else(|held| held.into_inner())
        .clone()
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

/// The whole denoise: a mosaic in [0, 1] goes in, the same mosaic denoised comes back.
///
/// Even dimensions, because the fit pairs rows and columns into 2x2 CFA sites; the caller trims an
/// odd edge before it gets here.
///
/// `gains` are the conditioning's own, by CFA colour; a mosaic conditioned without any takes
/// [`UNGAINED`].
pub async fn denoise(
    gpu: &crate::gpu::Gpu,
    galosh: &Galosh,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    gains: [f32; 3],
    amounts: Amounts,
) -> NoiseFit {
    run(
        gpu,
        galosh,
        mosaic,
        cfa,
        gains,
        Work::Denoise { amounts, fit: None },
    )
    .await
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
    gains: [f32; 3],
    amounts: Amounts,
    fit: NoiseFit,
) -> NoiseFit {
    run(
        gpu,
        galosh,
        mosaic,
        cfa,
        gains,
        Work::Denoise {
            amounts,
            fit: Some(fit),
        },
    )
    .await
}

/// One pyramid shrink dispatch over a level: its push for a pass starting at plane 0 or 1, and its
/// workgroups across one plane and down.
struct ShrinkPass {
    from_luma: u32,
    from_colour: u32,
    tiles_x: u32,
    tiles_y: u32,
}

/// The tile a progressive denoise is cut into, and what a caller with no reason to choose should
/// pass as `denoise_in_tiles`' `tile`.
///
/// **The fastest size, which is also the one that reports.** Over the 61MP fixture at halo 96 on an
/// RTX 3080, by `examples/galosh_progress.rs`, with the median gap between two updates beside it:
///
/// | tile | tiles | total | update | vs 1x |
/// |------|-------|-------|--------|-------|
/// | -    | 1     | 94ms  | -      | 1.00x |
/// | 4096 | 6     | 102ms | 12ms   | 1.08x |
/// | 2048 | 20    | 85ms  | 2ms    | 0.90x |
/// | 1024 | 70    | 135ms | 1ms    | 1.43x |
/// | 512  | 247   | 254ms | 0ms    | 2.69x |
///
/// 1024 is where the halo's redundancy overtakes what it buys, and 512 spends more again, its
/// regions being small enough that the per-call floor shows.
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
    gains: [f32; 3],
    amounts: Amounts,
    fit: NoiseFit,
    halo: usize,
    tile: usize,
    mut done: impl FnMut(f32),
) {
    let (width, height) = (mosaic.width, mosaic.height);
    let halo = reach(cfa, halo);
    let (lattice_x, lattice_y) = lattice(cfa);
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
        recording
            .encoder()
            .copy_buffer_to_buffer(&mosaic.buffer, 0, &filtered.buffer, 0, bytes);
        recording.submit();
    }
    let mut finished = 0usize;
    for (y0, y1) in spans(height) {
        for (x0, x1) in spans(width) {
            // On the lattice, not merely a CFA site: every level's DCT blocks are laid from the
            // region's origin, so an origin off it shrinks every pixel against other blocks.
            let left = x0.saturating_sub(halo) / lattice_x * lattice_x;
            let top = y0.saturating_sub(halo) / lattice_y * lattice_y;
            let (right, bottom) =
                cfa.aligned_end((left, top), (x1 + halo, y1 + halo), (width, height));
            let window = mosaic.window(gpu, left, top, right - left, bottom - top);
            denoise_with(gpu, galosh, &window, cfa, gains, amounts, fit).await;
            window.copy_rect(
                gpu,
                (x0 - left, y0 - top),
                &filtered,
                (x0, y0),
                (x1 - x0, y1 - y0),
            );
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
/// shrinkage or the inverse.
pub async fn fit(
    gpu: &crate::gpu::Gpu,
    galosh: &Galosh,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    gains: [f32; 3],
) -> NoiseFit {
    // Straight off the caller's frame: a fit stops before `pyr_restore`, which is the only
    // dispatch that writes what it was given, so there is nothing here to protect it from.
    run(gpu, galosh, mosaic, cfa, gains, Work::FitOnly).await
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
/// transforms and none of the shrinkage or inverse.
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
    Denoise {
        amounts: Amounts,
        fit: Option<NoiseFit>,
    },
}

async fn run(
    gpu: &crate::gpu::Gpu,
    galosh: &Galosh,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    gains: [f32; 3],
    work: Work,
) -> NoiseFit {
    let (width, height) = (mosaic.width, mosaic.height);
    // **Every statistic in Phase 0 is taken down one colour's own sub-lattice**, so the stride it
    // walks and the number of those lattices are the pattern's rather than Bayer's two and four.
    let (pw, ph) = cfa.period();
    let slots = (pw * ph) as i32;
    let amounts = match work {
        Work::FitOnly => Amounts::default(),
        Work::Denoise { amounts, .. } => amounts,
    };
    let supplied = match work {
        Work::Denoise { fit: Some(fit), .. } => Some(fit),
        _ => None,
    };
    let fit_only = matches!(work, Work::FitOnly);
    let side = site_side(cfa).expect("GALOSH filters a pattern only where it has a site");
    let planes = side * side;
    assert!(
        width % 2 == 0 && height % 2 == 0,
        "the mosaic's dimensions pair into 2x2 sites"
    );

    // The same switch the decode and the open report through, because what this splits out is
    // the part of a call that does not scale with the region: a run over tiles pays it per tile,
    // and at a few hundred tiles that decides whether tiling is worth anything at all.
    let mut lap = crate::clock::laps("    galosh ");

    let (w, h) = (width as i32, height as i32);
    let npix = width * height;

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

    // The caller's own frame, filtered where it lies. `pyr_restore` is the only dispatch that
    // writes it and a fit stops before that one.
    let raw = mosaic.buffer.clone();
    recording.holding(&raw);

    // The pyramid's levels, the sites first. Zero-length for a fit, which stops before any of them
    // is read: they are most of the gigabyte this holds at 61MP, a cost the editor's open should
    // not pay for a number.
    let mut level_sizes = [(width.div_ceil(side), height.div_ceil(side)); PYRAMID_LEVELS];
    for level in 1..PYRAMID_LEVELS {
        let (lw, lh) = level_sizes[level - 1];
        level_sizes[level] = (lw.div_ceil(2), lh.div_ceil(2));
    }
    let levelled = |level: usize| {
        let (lw, lh) = level_sizes[level];
        if fit_only { 0 } else { planes * lw * lh }
    };
    // The GAT frame, then the sites' level shrunk: free once the sites are packed out of it.
    let full_a = plane!("galosh in_gat / sites shrunk", npix.max(levelled(0)));

    // Copied back with the frame: what Phase 0 fitted is the only physical description of
    // this photograph's noise anything has, and a caller choosing an amount wants it.
    // Seeded where the caller brought the frame's own statistics, so the dispatches that would
    // have measured them can be skipped. The slots are `prelude.slang`'s.
    let mut seed = [0f32; 32];
    if let Some(fit) = supplied {
        // Floored like `ne_finalize`'s, because this is the same slot by another route and the
        // transform divides by it.
        seed[P_ALPHA] = fit.alpha.max(ALPHA_MIN);
        seed[P_SIGMA_SQ] = fit.sigma_sq;
        seed[P_UNIFIED_SIGMA] = fit.unified_sigma;
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
        let at = tables
            .iter()
            .position(|t| t.alpha == alpha && t.sigma_sq == sigma_sq)?;
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
    let sigma_partial = plane!(
        "galosh sigma partial",
        slots as usize * slices as usize * (SIGMA_BINS + 1)
    );
    let partial = plane!("galosh partial", DR_WORKGROUPS as usize * 5);
    let partial_resid = plane!("galosh partial resid", DR_WORKGROUPS as usize * 2);
    let under_black = plane!(
        "galosh under black",
        DR_WORKGROUPS as usize * UNDER_BLACK_SUMS
    );

    // **The blocks are the channel's own sub-lattice, so they shrink with the period.** A Bayer
    // channel is a quarter of the frame and an X-Trans one a thirty-sixth, which is the same total
    // count of blocks either way - one per photosite - spread over more channels of fewer blocks.
    let (ne_bx, ne_by) = (width / pw / 8, height / ph / 8);
    let ne_per_ch = ne_bx * ne_by;
    let ne_stride = block_stride(ne_per_ch, ne_bx);
    let ne_sampled = ne_per_ch.div_ceil(ne_stride);
    let blk_mean = plane!("galosh blk_mean", slots as usize * ne_sampled);
    let blk_var = plane!("galosh blk_var", slots as usize * ne_sampled);
    let green = (0..pw * ph)
        .filter(|&channel| cfa.colour_at(channel / pw, channel % pw) == 1)
        .fold(0u64, |mask, channel| mask | 1 << channel);

    // Uncleared: every plane the output depends on is written whole before it is read.
    macro_rules! scratch {
        ($label:expr, $len:expr) => {
            recording.scratch(&wgpu::BufferDescriptor {
                label: Some($label),
                size: (($len as usize).max(1) * 4) as u64,
                usage: storage,
                mapped_at_creation: false,
            })
        };
    }
    let pyramid_noisy: Vec<crate::gpu::Buffer> = (0..PYRAMID_LEVELS)
        .map(|level| scratch!("galosh pyramid noisy", levelled(level)))
        .collect();
    let pyramid_shrunk: Vec<crate::gpu::Buffer> = (0..PYRAMID_LEVELS)
        .map(|level| {
            let len = if level == 0 { 0 } else { levelled(level) };
            scratch!("galosh pyramid shrunk", len)
        })
        .collect();
    // Each level's shrunk, boxed to the size of the level below it.
    let pyramid_boxed: Vec<crate::gpu::Buffer> = (0..PYRAMID_LEVELS - 1)
        .map(|level| scratch!("galosh pyramid boxed", levelled(level + 1)))
        .collect();
    // One level's luma pilot at a time, so the largest level's luma plane serves them all.
    let pyramid_pilot = scratch!("galosh pyramid pilot", levelled(0) / planes);
    let transform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("galosh site transform"),
        contents: &site_transform(cfa, side)
            .iter()
            .flat_map(|value| value.to_ne_bytes())
            .collect::<Vec<u8>>(),
        usage: storage,
    });
    let basis = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("galosh colour basis"),
        contents: &colour_basis(cfa, side)
            .iter()
            .flat_map(|value| value.to_ne_bytes())
            .collect::<Vec<u8>>(),
        usage: storage,
    });

    let fitted = recording.buffer(&wgpu::BufferDescriptor {
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
        Word::I(ne_sampled as i32),
        Word::I(ne_stride as i32),
        Word::I(pw as i32),
        Word::I(ph as i32),
        Word::I(green as u32 as i32),
        Word::I((green >> 32) as u32 as i32),
    ]);
    let finalize = pushes.add(&[Word::I(w), Word::I(h), Word::I(slots * ne_sampled as i32)]);
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
    let ratios = to_green(gains).map(Word::F);
    let pattern_push = pushes.add(&[
        Word::I(w),
        Word::I(h),
        Word::I(pw as i32),
        Word::I(ph as i32),
        packed[0],
        packed[1],
        packed[2],
        ratios[0],
        ratios[1],
    ]);
    let size_words = |level: usize| {
        let (lw, lh) = level_sizes[level];
        [Word::I(lw as i32), Word::I(lh as i32)]
    };
    let luma_strength = amounts.luma * amounts.luma;
    let kept_share = |amount: f32| Word::F((1.0 - amount).max(0.0));
    let site_push = pushes.add(
        &[
            &[Word::I(w), Word::I(h)][..],
            &size_words(0),
            &size_words(1),
            &[
                Word::I(side as i32),
                Word::I((pw / side) as i32),
                Word::I((ph / side) as i32),
            ],
            &packed,
            &ratios,
            &[kept_share(amounts.luma)],
        ]
        .concat(),
    );
    let between = |level: usize| {
        [
            &size_words(level)[..],
            &size_words(level + 1),
            &[Word::I(planes as i32)],
        ]
        .concat()
    };
    let down_pushes: Vec<u32> = (1..PYRAMID_LEVELS - 1)
        .map(|level| pushes.add(&between(level)))
        .collect();
    let fuse_pushes: Vec<u32> = (0..PYRAMID_LEVELS - 1)
        .map(|level| pushes.add(&between(level)))
        .collect();
    let mut passes_over = |offsets: &[(usize, usize)]| -> Vec<Vec<ShrinkPass>> {
        (0..PYRAMID_LEVELS)
            .map(|level| {
                let (lw, lh) = level_sizes[level];
                let colour = PYRAMID_COLOUR_BY_LEVEL[level] * amounts.colour;
                let colour_strength = luma_strength.max(colour * colour);
                offsets
                    .iter()
                    .enumerate()
                    .map(|(pass, &(ox, oy))| {
                        let tiles_x = (lw + ox).div_ceil(PYRAMID_TILE);
                        let tiles_y = (lh + oy).div_ceil(PYRAMID_TILE);
                        let mut push = |first: i32| {
                            pushes.add(&[
                                Word::I(lw as i32),
                                Word::I(lh as i32),
                                Word::I(ox as i32),
                                Word::I(oy as i32),
                                Word::I(tiles_x as i32),
                                Word::I(first),
                                Word::F(0.25f32.powi(level as i32)),
                                Word::F(1.0 / offsets.len() as f32),
                                Word::F(luma_strength),
                                Word::F(colour_strength),
                                Word::I((pass > 0) as i32),
                                match first {
                                    0 => Word::F(0.0),
                                    _ => kept_share(amounts.colour),
                                },
                            ])
                        };
                        ShrinkPass {
                            from_luma: push(0),
                            from_colour: push(1),
                            tiles_x: tiles_x as u32,
                            tiles_y: tiles_y as u32,
                        }
                    })
                    .collect()
            })
            .collect()
    };
    let luma_passes = passes_over(&PYRAMID_LUMA_OFFSETS);
    let single_passes = passes_over(&[(0, 0)]);

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
        (
            (w as u32).div_ceil(tile).max(1),
            (h as u32).div_ceil(tile).max(1),
        )
    };
    let (fx, fy) = groups(width, height, 16);

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
            DISPATCHED
                .lock()
                .unwrap_or_else(|held| held.into_inner())
                .clear();
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
            // **A pass each, rather than one for the chain.** Most dispatches read what the one
            // before them wrote, and in a single pass on Metal those reads landed before the write
            // did. A pass boundary is where WebGPU guarantees the write is visible.
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernel.pipeline);
            pass.set_bind_group(0, group, &[offset]);
            pass.dispatch_workgroups(x, y, 1);
        };

        // Phase 0: the blind Poisson-Gaussian fit, off the frame's own statistics - or off the
        // frame this region was cut from, in which case it is already in `params` and none of
        // these whole-region reductions would be measuring the right thing anyway.
        if supplied.is_none() {
            let g = bind(
                &galosh.ne_block_stats,
                &[(0, &raw), (1, &blk_mean), (2, &blk_var)],
            );
            run(
                &galosh.ne_block_stats,
                &g,
                block_stats,
                (slots as u32 * ne_sampled as u32).div_ceil(64).max(1),
                1,
            );
            let g = bind(&galosh.under_black_reduce, &[(0, &raw), (1, &under_black)]);
            run(
                &galosh.under_black_reduce,
                &g,
                pattern_push,
                DR_WORKGROUPS,
                1,
            );
            let g = bind(
                &galosh.ne_finalize,
                &[
                    (0, &blk_mean),
                    (1, &blk_var),
                    (2, &under_black),
                    (3, &params),
                ],
            );
            run(&galosh.ne_finalize, &g, finalize, 1, 1);
        }

        // Phase 1: into the GAT domain, and the table that comes back out of it. A run handed its
        // fit has nothing left to measure on the stabilised frame, so its pack stabilises the
        // mosaic as it reads it, and this phase, the normalising and the dark subtraction are
        // skipped.
        let packs_raw = supplied.is_some();
        if !packs_raw {
            let g = bind(
                &galosh.gat_forward_full,
                &[(0, &raw), (1, &full_a), (6, &params)],
            );
            run(&galosh.gat_forward_full, &g, pattern_push, fx, fy);
        }
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
            run(
                &galosh.sigma_per_cfa,
                &g,
                sigma_slice,
                slots as u32 * slices,
                1,
            );
            let g = bind(
                &galosh.sigma_per_cfa_merge,
                &[(0, &sigma_partial), (1, &params)],
            );
            run(&galosh.sigma_per_cfa_merge, &g, sigma_merge, 4, 1);
            let g = bind(&galosh.unified_sigma, &[(0, &params)]);
            run(&galosh.unified_sigma, &g, wh, 1, 1);
        }
        if !packs_raw {
            let g = bind(&galosh.normalize_apply, &[(0, &full_a), (5, &params)]);
            run(&galosh.normalize_apply, &g, wh, fx, fy);
        }

        // Phase 2: the per-slot dark reference, by three IRLS iterations.
        let g = bind(&galosh.irls_seed, &[(0, &params)]);
        run(&galosh.irls_seed, &g, wh, 1, 1);
        let reduce = bind(
            &galosh.dark_ref_reduce,
            &[(0, &full_a), (1, &raw), (2, &params), (3, &partial)],
        );
        let reduce_fin = bind(&galosh.dark_ref_finalize, &[(0, &partial), (1, &params)]);
        let resid = bind(
            &galosh.dark_resid_reduce,
            &[(0, &full_a), (1, &raw), (2, &params), (3, &partial_resid)],
        );
        let resid_fin = bind(
            &galosh.dark_resid_finalize,
            &[(0, &partial_resid), (1, &params)],
        );
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

        if !packs_raw {
            let g = bind(&galosh.dark_sub_full, &[(0, &full_a), (5, &params)]);
            run(&galosh.dark_sub_full, &g, wh, fx, fy);
        }

        let size = |level: usize| level_sizes[level];
        let noisy = &pyramid_noisy;
        let shrunk = |level: usize| match level {
            0 => &full_a,
            _ => &pyramid_shrunk[level],
        };
        let (pack, mosaic) = match packs_raw {
            true => (&galosh.pyr_pack_raw, &raw),
            false => (&galosh.pyr_pack, &full_a),
        };
        let g = bind(
            pack,
            &[
                (0, mosaic),
                (1, &noisy[0]),
                (2, &noisy[1]),
                (3, &params),
                (9, &transform),
            ],
        );
        let (px, py) = groups(size(1).0, size(1).1, 16);
        run(pack, &g, site_push, px, py);
        for level in 1..PYRAMID_LEVELS - 1 {
            let g = bind(
                &galosh.pyr_down,
                &[(0, &noisy[level]), (1, &noisy[level + 1])],
            );
            let (dx, dy) = groups(size(level + 1).0, size(level + 1).1, 16);
            run(&galosh.pyr_down, &g, down_pushes[level - 1], dx, dy);
        }
        for level in 0..PYRAMID_LEVELS {
            // The pilot reads no pilot; any plane of the right usage stands in.
            let pilot = &pyramid_pilot;
            let single = &single_passes[level];
            let passes = [
                (&galosh.pyr_pilot, pilot, &noisy[level], 0, 1, single),
                (
                    &galosh.pyr_shrink,
                    shrunk(level),
                    pilot,
                    0,
                    1,
                    &luma_passes[level],
                ),
                (
                    &galosh.pyr_shrink_own,
                    shrunk(level),
                    pilot,
                    1,
                    planes,
                    single,
                ),
            ];
            for (kernel, out, guide, from, to, over) in passes {
                let g = bind(
                    kernel,
                    &[
                        (0, &noisy[level]),
                        (1, out),
                        (3, guide),
                        (4, &basis),
                        (5, &params),
                    ],
                );
                for pass in over {
                    let push = match from {
                        0 => pass.from_luma,
                        _ => pass.from_colour,
                    };
                    let across = pass.tiles_x * (to - from) as u32;
                    run(kernel, &g, push, across, pass.tiles_y);
                }
            }
            if level + 1 < PYRAMID_LEVELS {
                let g = bind(
                    &galosh.pyr_down,
                    &[(0, shrunk(level)), (1, &pyramid_boxed[level])],
                );
                let (dx, dy) = groups(size(level + 1).0, size(level + 1).1, 16);
                run(&galosh.pyr_down, &g, fuse_pushes[level], dx, dy);
            }
        }
        for level in (1..PYRAMID_LEVELS - 1).rev() {
            let g = bind(
                &galosh.pyr_fuse,
                &[
                    (0, shrunk(level)),
                    (1, &pyramid_boxed[level]),
                    (2, shrunk(level + 1)),
                ],
            );
            let (ux, uy) = groups(size(level).0, size(level).1, 16);
            run(&galosh.pyr_fuse, &g, fuse_pushes[level], ux, uy);
        }
        let g = bind(
            &galosh.pyr_restore,
            &[
                (0, &full_a),
                (1, &pyramid_boxed[0]),
                (2, shrunk(1)),
                (4, &raw),
                (5, &lut_d),
                (6, &lut_x),
                (7, &lut_params),
                (8, &params),
                (9, &transform),
            ],
        );
        let (rx, ry) = groups(size(0).0, size(0).1, 16);
        run(&galosh.pyr_restore, &g, site_push, rx, ry);
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
        for (from, out, len) in [
            (&lut_d, d, LUT_SIZE as u64),
            (&lut_x, x, LUT_SIZE as u64),
            (&lut_params, table_params, 8),
        ] {
            encoder.copy_buffer_to_buffer(from, 0, out, 0, len * 4);
        }
    }
    lap("record");
    recording.submit();
    // Before anything below, so the lap that says "dispatch" is the dispatch. It is also what
    // bounds a tiled run: dropping a plane's last handle *schedules* its release against the work
    // still pending, so without a wait here the next tile allocates while this one's gigabyte is
    // still owed - which at 61MP is every tile's planes resident at once.
    crate::gpu::finished(gpu)
        .await
        .expect("the denoise finished");
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
        None => crate::gpu::read_back(gpu, &fitted, fit_of)
            .await
            .expect("the model mapped"),
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
        dark_ref: [
            at(P_DARK_REF0),
            at(P_DARK_REF0 + 1),
            at(P_DARK_REF0 + 2),
            at(P_DARK_REF0 + 3),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ACHROMATIC_RANGE, ALPHA_MIN, Amounts, COLOUR_LEAD, Denoiser, Detail, LUT_SIZE, NoiseFit,
        NoiseModel, P_ALPHA, P_DARK_REF0, P_SIGMA_SQ, P_UNIFIED_SIGMA, SIGMA_BINS, UNGAINED,
        denoise, device,
    };

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
            let start = SLANG
                .find(&opener)
                .unwrap_or_else(|| panic!("{name} is declared"));
            let rest = &SLANG[start + opener.len()..];
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            digits
                .parse::<usize>()
                .unwrap_or_else(|_| panic!("{name} is a number"))
        };
        for (name, here) in [
            ("P_UNIFIED_SIGMA", P_UNIFIED_SIGMA),
            ("P_DARK_REF0", P_DARK_REF0),
            ("P_ALPHA", P_ALPHA),
            ("P_SIGMA_SQ", P_SIGMA_SQ),
        ] {
            assert_eq!(
                declared(name),
                here,
                "{name}: the shader and this host disagree"
            );
        }
    }

    #[test]
    fn the_table_sizes_are_the_ones_the_shader_declares() {
        const SLANG: &str = include_str!("../../../slang/galosh/prelude.slang");
        for (name, here) in [
            ("SIGMA_BINS", SIGMA_BINS),
            ("LUT_SIZE", LUT_SIZE),
            ("UNDER_BLACK_SUMS", super::UNDER_BLACK_SUMS),
        ] {
            let opener = format!("public static const int {name} = ");
            let start = SLANG
                .find(&opener)
                .unwrap_or_else(|| panic!("{name} is declared"));
            let digits: String = SLANG[start + opener.len()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            assert_eq!(
                digits.parse::<usize>().ok(),
                Some(here),
                "{name}: the shader and this host disagree"
            );
        }
    }

    #[test]
    fn the_pyramid_is_the_shape_its_shaders_declare() {
        const SLANG: &str = include_str!("../../../slang/galosh/pyramid.slang");
        for line in [
            format!(
                "public static const int MAX_PLANES = {};",
                super::PYRAMID_MAX_PLANES
            ),
            format!(
                "public static const int LEVELS = {};",
                super::PYRAMID_LEVELS
            ),
            format!("public static const int TILE = {};", super::PYRAMID_TILE),
            format!(
                "public static const int STRIDE = {};",
                super::PYRAMID_STRIDE
            ),
        ] {
            assert!(SLANG.contains(&line), "pyramid.slang does not say `{line}`");
        }
        let shrink = include_str!("../../../slang/galosh/pyr_shrink.slang");
        let pack = include_str!("../../../slang/galosh/pyr_pack.slang");
        for (slang, id, name) in [
            (shrink, super::PYRAMID_PILOT_ID, "PILOT"),
            (shrink, super::PYRAMID_OWN_PILOT_ID, "OWN_PILOT"),
            (pack, super::PYRAMID_FROM_RAW_ID, "FROM_RAW"),
        ] {
            let line = format!("[vk::constant_id({id})]\nconst int {name} = 0;");
            assert!(slang.contains(&line), "no shader says `{line}`");
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
        let literal: String = SLANG[start + opener.len()..]
            .chars()
            .take_while(|c| *c != ';')
            .collect();
        let declared: f32 = literal.trim().parse().expect("ALPHA_MIN is a number");
        assert_eq!(
            declared, ALPHA_MIN,
            "the shader and this host floor alpha differently"
        );
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
        let line = format!(
            "public static const int DR_WORKGROUPS = {};",
            super::DR_WORKGROUPS
        );
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
        let start = SLANG
            .find(opener)
            .expect("the prelude declares ACHROMATIC_RANGE");
        let literal: String = SLANG[start + opener.len()..]
            .chars()
            .take_while(|c| *c != ';')
            .collect();
        let declared: f32 = literal
            .trim()
            .parse()
            .expect("ACHROMATIC_RANGE is a number");
        assert_eq!(
            declared, ACHROMATIC_RANGE,
            "the shader and this host gate neutrality differently"
        );
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

        let drifted = NoiseFit {
            dark_ref: [56.22, 56.12, 91.0, 56.17],
            ..sane
        };
        assert!(
            !drifted.usable(),
            "a reference the blocks cannot have said was accepted"
        );
    }

    /// Every host reaches the kernels through this function, so what needs pinning is not two
    /// implementations against each other but this one against the numbers it is meant to produce.
    #[test]
    fn the_track_ends_where_a_photograph_still_survives_it() {
        assert!((Amounts::from_sliders(100.0, 100.0).luma - 0.992).abs() < 1e-6);
        assert!((Amounts::from_sliders(100.0, 100.0).colour - 3.0).abs() < 1e-6);
        assert_eq!(Amounts::from_sliders(0.0, 0.0).does_anything(), false);

        // **What `photo_edits.ts` actually ships, in the units the kernels read.** The schema's
        // defaults are positions on this track, so moving the track's top moves what every stored
        // edit means. A position is pinned here rather than there because this is the only side
        // that can say what it is worth, and a silent change to what the shipped default denoises
        // at is precisely the thing nothing else in either suite would notice.
        let shipped = Amounts::from_sliders(20.0, 30.0);
        assert!(
            (shipped.luma - 0.1984).abs() < 1e-6,
            "luma {}",
            shipped.luma
        );
        assert!(
            (shipped.colour - 0.9).abs() < 1e-6,
            "colour {}",
            shipped.colour
        );
    }

    /// The pair the two halves of the Detail panel are suggested at.
    #[test]
    fn the_suggested_colour_runs_ahead_of_the_luminance() {
        let at = |shadow: f32| {
            NoiseModel {
                alpha: 0.0,
                sigma_sq: shadow * shadow,
            }
            .suggested_amounts()
        };
        // A base-ISO frame is declined on both halves rather than on one.
        assert_eq!(at(0.00037), (0.0, 0.0));
        // **Luminance lands well short of the end of its track and colour is at the end of its**,
        // which is the same rule read on two tracks rather than an inconsistency: what is lost to
        // under-denoising luminance is grain and still reads as a photograph, and what is lost to
        // under-denoising colour is mottle and never does. This is `DSC00982` at ISO 12800.
        let (luma, colour) = at(0.00394);
        assert!((35.0..45.0).contains(&luma), "luma {luma}");
        assert_eq!(
            colour, 100.0,
            "the noisiest frame in the library does not reach the end of the Colour track"
        );

        // A frame the ramp puts mid-track, where the lead is the lead rather than the clamp: this
        // is `IMG_4138` at ISO 2000.
        let (luma, colour) = at(0.00235);
        assert!(colour > luma, "colour {colour} does not lead luma {luma}");
        assert!(
            (colour - luma * COLOUR_LEAD).abs() < 1e-6,
            "colour {colour} is not the lead"
        );
        assert!((55.0..75.0).contains(&colour), "colour {colour}");
    }

    /// What an unset slider resolves to, and what a decode may conclude before it has measured.
    /// A library edited before there was a choice has documents that do not mention one, and every
    /// one of them has to keep rendering as it did.
    #[test]
    fn a_document_that_names_no_denoiser_is_galosh() {
        let old: Detail = serde_json::from_str(r#"{"luminance":40,"colour":20}"#).expect("reads");
        assert_eq!(old.denoiser, Denoiser::Galosh);
        assert_eq!(old.resolved(None), (40.0, 20.0));

        let chosen: Detail =
            serde_json::from_str(r#"{"luminance":40,"colour":20,"denoiser":"pmrid"}"#)
                .expect("reads");
        assert_eq!(chosen.denoiser, Denoiser::Pmrid);
        assert_eq!(
            serde_json::to_value(chosen).expect("writes")["denoiser"],
            serde_json::json!("pmrid"),
        );
    }

    #[test]
    fn highlight_recovery_colours_reading_highlights_first_then_blown_ones() {
        let pair = |detail: Detail| {
            let colouring = detail.colouring();
            (colouring.reading, colouring.blown)
        };
        let at = |amount: f64| {
            pair(Detail {
                highlight_recovery: Some(amount),
                ..Detail::AUTO
            })
        };
        assert_eq!(pair(Detail::AUTO), (1.0, 1.0));
        assert_eq!(at(100.0), (1.0, 1.0));
        assert_eq!(at(75.0), (1.0, 0.5));
        assert_eq!(at(50.0), (1.0, 0.0));
        assert_eq!(at(25.0), (0.5, 0.0));
        assert_eq!(at(0.0), (0.0, 0.0));
    }

    #[test]
    fn the_sharpen_is_told_how_much_noise_each_denoise_left() {
        let fit = Some(NoiseFit {
            alpha: 0.0,
            sigma_sq: 0.00257 * 0.00257,
            unified_sigma: 1.2,
            dark_ref: [0.0; 4],
        });
        let left = |luminance: f64, denoiser: Denoiser| {
            Detail::at(luminance, 0.0).using(denoiser).noise_left(fit)
        };
        for denoiser in [Denoiser::Galosh, Denoiser::Pmrid, Denoiser::Upscaler] {
            assert_eq!(Detail::at(62.0, 50.0).using(denoiser).noise_left(None), 1.0);
            assert_eq!(left(0.0, denoiser), 1.0);
            let mut previous = 1.0;
            for luminance in (0..=100).step_by(5) {
                let now = left(f64::from(luminance), denoiser);
                assert!(
                    (0.0..=previous).contains(&now),
                    "{denoiser:?} at {luminance} left {now}, after {previous}"
                );
                previous = now;
            }
        }
        assert!((left(50.0, Denoiser::Galosh) - 0.25).abs() < 1e-6);
        assert!((left(50.0, Denoiser::Pmrid) - 0.25).abs() < 1e-6);
        assert!((left(75.0, Denoiser::Upscaler) - 0.0625).abs() < 1e-6);
        for denoiser in [Denoiser::Galosh, Denoiser::Pmrid, Denoiser::Upscaler] {
            assert!(
                left(100.0, denoiser) >= 0.02,
                "{denoiser:?} at 100 opened the gate"
            );
        }
    }

    #[test]
    fn an_unset_detail_is_the_frames_own_and_not_a_number() {
        let noisy = NoiseFit {
            alpha: 0.0,
            sigma_sq: 0.00257 * 0.00257,
            unified_sigma: 1.2,
            dark_ref: [0.0; 4],
        };
        let (luma, colour) = NoiseModel {
            alpha: 0.0,
            sigma_sq: noisy.sigma_sq,
        }
        .suggested_amounts();
        assert_eq!(
            Detail::AUTO.resolved(Some(noisy)),
            (luma.round(), colour.round())
        );

        // Half set is half resolved: a reader who moved one slider is not asking the frame about
        // the other one as well.
        let half = Detail {
            luminance: Some(4.0),
            ..Detail::AUTO
        };
        assert_eq!(half.resolved(Some(noisy)), (4.0, colour.round()));

        // **A decode cannot say an unset slider does nothing until it has measured**, which is what
        // stands between the automatic amount and a gate that skips GALOSH before Phase 0 runs.
        assert!(Detail::AUTO.could_do_anything());
        assert!(Detail::AUTO.needs_a_fit());
        assert!(!Detail::at(0.0, 0.0).could_do_anything());
        assert!(!Detail::at(0.0, 0.0).needs_a_fit());

        // A clean frame is declined on both halves, and that is the whole of what a fit can say -
        // so an automatic decode of one filters nothing rather than filtering a little.
        let clean = NoiseFit {
            sigma_sq: 0.00036 * 0.00036,
            ..noisy
        };
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
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(kernels) = device(gpu) else { return };

        let (w, h) = (192usize, 192usize);
        let mosaic: Vec<f32> = (0..w * h)
            .map(|at| 0.2 + 0.6 * ((at % 97) as f32 / 97.0) + ((at % 13) as f32 / 13.0) * 0.05)
            .collect();
        let amounts = Amounts::from_sliders(50.0, 50.0);
        let denoised = |fit: super::NoiseFit| {
            let out = crate::condition::Mosaic::upload(gpu, &mosaic, w, h);
            pollster::block_on(super::denoise_with(
                gpu,
                kernels,
                &out,
                &rggb(),
                UNGAINED,
                amounts,
                fit,
            ));
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
        let other = super::NoiseFit {
            alpha: 0.0079_3,
            sigma_sq: 4.41e-5,
            ..one
        };

        let before = built();
        let first = denoised(one);
        assert_eq!(
            built(),
            before + 1,
            "the first run of a new fit did not sum a table"
        );

        let between = denoised(other);
        assert_eq!(
            built(),
            before + 2,
            "a different fit reused another fit's table"
        );

        let again = denoised(one);
        assert_eq!(
            built(),
            before + 2,
            "a fit already summed was summed a second time"
        );

        assert_eq!(
            first, again,
            "the kept table changed what the same fit produced"
        );
        assert_ne!(
            first, between,
            "two different fits denoised to the same frame"
        );
    }

    /// Tiling is a schedule and not a filter, and the progress it reports is a fraction.
    ///
    /// **The failure this exists for is silent and looks like a denoise.** A halo dropped, an
    /// origin off the lattice or a period, a crop-back off by a row: nothing errors, no dimension
    /// is wrong, and the picture is simply not the one an export would produce. Tile sizes on no
    /// lattice, because a geometry bug commonly survives the size it was written against.
    ///
    /// And the reach the halo is floored at, measured: one photosite moved in the middle of the
    /// frame moves nothing further than [`super::reach`] from it. A tiling with too small a halo is
    /// only caught where a tile's edge falls within reach of real structure, which the reach check
    /// catches anywhere.
    #[test]
    fn tiling_the_denoise_does_not_move_a_sample() {
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        let kernels = device(gpu).expect("the GALOSH kernels");
        // Neither a whole number of X-Trans periods, so the last tile ends mid-period.
        let (w, h) = (1730usize, 1342usize);
        let mosaic = frame(w, h);
        let amounts = Amounts::from_sliders(50.0, 100.0);
        // Unequal, so a tile reading a photosite's colour off its own origin rather than the
        // frame's scales it by the wrong one.
        let gains = [1.0, 0.5, 0.7];
        for cfa in [rggb(), xtrans()] {
            // The frame's own, handed to every tile: measured per tile it would be each tile's
            // statistics, which is a different denoise before any halo is considered.
            let uploaded = crate::condition::Mosaic::upload(gpu, &mosaic, w, h);
            let fit = pollster::block_on(super::fit(gpu, kernels, &uploaded, &cfa, gains));
            let denoised = |samples: &[f32]| {
                let whole = crate::condition::Mosaic::upload(gpu, samples, w, h);
                pollster::block_on(super::denoise_with(
                    gpu, kernels, &whole, &cfa, gains, amounts, fit,
                ));
                read(gpu, &whole)
            };
            let whole = denoised(&mosaic);

            // At either end of a coarsest site, which is where its reach runs farthest one way.
            let span = super::coarsest_site(super::site_side(&cfa).expect("a site"));
            let reach = super::reach(&cfa, 0);
            for (cx, cy) in [(w / 2, h / 2), (w / 2 + span - 1, h / 2 + span - 1)] {
                let mut moved = mosaic.clone();
                moved[cy * w + cx] += 0.25;
                let farthest = denoised(&moved)
                    .iter()
                    .zip(&whole)
                    .enumerate()
                    .filter(|(_, (a, b))| a != b)
                    .map(|(at, _)| (at % w).abs_diff(cx).max((at / w).abs_diff(cy)))
                    .max()
                    .expect("moving a photosite moved its own output");
                assert!(
                    farthest <= reach,
                    "{cfa:?}: a photosite at {cx},{cy} reached {farthest}, past {reach}"
                );
            }

            for tile in [300usize, 700] {
                let mut tiled = crate::condition::Mosaic::upload(gpu, &mosaic, w, h);
                let mut ticks = Vec::new();
                pollster::block_on(super::denoise_in_tiles(
                    gpu,
                    kernels,
                    &mut tiled,
                    &cfa,
                    gains,
                    amounts,
                    fit,
                    crate::RENDITION_TILE_HALO,
                    tile,
                    |done| ticks.push(done),
                ));
                if let Some((at, (&got, &expected))) = read(gpu, &tiled)
                    .iter()
                    .zip(&whole)
                    .enumerate()
                    .find(|(_, (a, b))| a != b)
                {
                    panic!(
                        "{cfa:?}: a {tile}px tiling moved sample {at}: {got} instead of {expected}"
                    );
                }
                assert!(
                    ticks.len() > 1,
                    "a {tile}px tiling reported {} tiles",
                    ticks.len()
                );
                assert!(
                    ticks.windows(2).all(|pair| pair[1] > pair[0]),
                    "{ticks:?} went backwards"
                );
                assert_eq!(ticks.last(), Some(&1.0), "{tile}px did not report finished");
            }
        }
    }

    /// The automatic amount against the shadow noise a real library actually reports.
    ///
    /// Every figure here is `shadow_noise` measured by `examples/noise_survey` over 43 frames
    /// spanning ISO 50 to 25600, so this fails if the ramp is ever moved off the photographs it
    /// was fitted to. Each is entered as `sigma_sq` alone, which reads back the same figure.
    #[test]
    fn a_clean_frame_is_left_alone_and_a_noisy_one_is_not() {
        let at = |shadow: f32| {
            NoiseModel {
                alpha: 0.0,
                sigma_sq: shadow * shadow,
            }
            .suggested_amount()
        };
        // Base ISO, across both libraries: the whole range is declined rather than put through
        // the chain to be left alone.
        for clean in [0.00029, 0.00037, 0.00044, 0.00054] {
            assert_eq!(
                at(clean),
                0.0,
                "a base-ISO frame at {clean} asks for nothing"
            );
        }
        // Nothing measured reaches the upper half, the ramp erring towards grain rather than
        // towards smearing.
        assert!(
            (1.0..20.0).contains(&at(0.00147)),
            "ISO 1250 asks {}",
            at(0.00147)
        );
        assert!(
            (15.0..30.0).contains(&at(0.00246)),
            "ISO 6400 asks {}",
            at(0.00246)
        );
        assert!(
            (40.0..50.0).contains(&at(0.00423)),
            "ISO 25600 asks {}",
            at(0.00423)
        );
        // Ramped rather than stepped, so two frames either side of the gate are not two
        // different photographs.
        assert!(at(0.00096) < at(0.00124));
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
        let fit = pollster::block_on(denoise(
            gpu,
            galosh,
            &uploaded,
            &rggb(),
            UNGAINED,
            Amounts {
                luma: 1.0,
                colour: 1.0,
            },
        ));
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

    /// A silhouette edge must not come back wearing a stripe. A row's mean change is the stripe's
    /// own measure: legitimate denoising is zero-mean over a row, the stripe is not.
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
        let mut uniform = uniform_from(0x853c_49e6_748f_ea9b);
        let noisy: Vec<f32> = (0..width * height)
            .map(|at| {
                let (x, y) = (at % width, at / width);
                let slot = (y & 1) | ((x & 1) << 1);
                let ridge = height as f32 * 0.45 + 20.0 * (x as f32 / 97.0).sin();
                let level: f32 = if (y as f32) < ridge {
                    [0.08, 0.11, 0.11, 0.16][slot]
                } else {
                    0.002
                };
                let sigma = 0.0005 + 0.01 * level.sqrt();
                (level + (uniform() + uniform() + uniform() - 1.5) * sigma).clamp(0.0, 1.0)
            })
            .collect();

        let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
        pollster::block_on(denoise(
            gpu,
            galosh,
            &uploaded,
            &rggb(),
            UNGAINED,
            Amounts::from_sliders(40.0, 40.0),
        ));
        let denoised = read(gpu, &uploaded);

        for row in 0..height {
            let mean = (0..width)
                .map(|col| f64::from(denoised[row * width + col] - noisy[row * width + col]))
                .sum::<f64>()
                / width as f64;
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
        let mut uniform = uniform_from(0x9e37_79b9_7f4a_7c15);
        let read_noise = 0.004;
        // Lit on the right so the fit has a slope to measure, black on the left.
        let noisy: Vec<f32> = (0..width * height)
            .map(|at| {
                let (x, y) = (at % width, at / width);
                let slot = (y & 1) | ((x & 1) << 1);
                let level: f32 = if x > width / 2 {
                    [0.20, 0.34, 0.34, 0.12][slot]
                } else {
                    0.0
                };
                let sigma = read_noise + 0.01 * level.sqrt();
                level + (uniform() + uniform() + uniform() - 1.5) * 2.0 * sigma
            })
            .collect();

        let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
        pollster::block_on(denoise(
            gpu,
            galosh,
            &uploaded,
            &rggb(),
            UNGAINED,
            Amounts::from_sliders(40.0, 40.0),
        ));
        let denoised = read(gpu, &uploaded);

        let black: Vec<f64> = (16..height - 16)
            .flat_map(|row| (16..width / 2 - 32).map(move |col| row * width + col))
            .map(|at| f64::from(denoised[at]))
            .collect();
        let mean = black.iter().sum::<f64>() / black.len() as f64;
        // A zero floor after the inverse leaves 0.00048 here.
        assert!(mean.abs() < 0.0001, "black denoised to a mean of {mean:.5}");
    }

    #[test]
    fn a_photosite_under_black_survives_a_fit_with_no_read_noise() {
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(galosh) = device(gpu) else {
            return;
        };

        let (width, height) = (512, 384);
        let mut uniform = uniform_from(0x9e37_79b9_7f4a_7c15);
        let noisy: Vec<f32> = (0..width * height)
            .map(|at| {
                let (x, y) = (at % width, at / width);
                let slot = (y & 1) | ((x & 1) << 1);
                let level: f32 = if x > width / 2 {
                    [0.20, 0.34, 0.34, 0.12][slot]
                } else {
                    0.0
                };
                let sigma = 0.001 + 0.01 * level.sqrt();
                level + (uniform() + uniform() + uniform() - 1.5) * 2.0 * sigma
            })
            .collect();
        let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
        let measured = pollster::block_on(super::fit(gpu, galosh, &uploaded, &rggb(), UNGAINED));
        pollster::block_on(super::denoise_with(
            gpu,
            galosh,
            &uploaded,
            &rggb(),
            UNGAINED,
            Amounts::from_sliders(40.0, 40.0),
            NoiseFit {
                sigma_sq: 0.0,
                ..measured
            },
        ));
        let denoised = read(gpu, &uploaded);

        // The black half went in within 0.003 of zero.
        let worst = farthest_from_black(&denoised, width, height);
        assert!(
            worst < 0.01,
            "a black photosite came back {worst} from black"
        );
    }

    /// The farthest from zero a frame's black left half came back, or NaN where any of it did.
    fn farthest_from_black(denoised: &[f32], width: usize, height: usize) -> f32 {
        (16..height - 16)
            .flat_map(|row| (16..width / 2 - 32).map(move |col| row * width + col))
            .map(|at| denoised[at].abs())
            .fold(
                0.0,
                |worst, v| if v > worst || v.is_nan() { v } else { worst },
            )
    }

    /// Dark noise a block's Laplacians read as nothing is fitted from the photosites under black.
    #[test]
    fn dark_noise_no_block_can_see_is_fitted_from_the_photosites_under_black() {
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(galosh) = device(gpu) else {
            return;
        };

        let (width, height) = (1024, 768);
        let mut uniform = uniform_from(0x9e37_79b9_7f4a_7c15);
        // Black on the left, as a field that is flat across each of the fit's blocks with a spike
        // in one photosite of two hundred; a ramp on the right carrying shot noise alone.
        let block = 16;
        let field: Vec<f32> = (0..(width / block) * (height / block))
            .map(|_| (uniform() - 0.5) * 6e-4)
            .collect();
        let noisy: Vec<f32> = (0..width * height)
            .map(|at| {
                let (x, y) = (at % width, at / width);
                if x < width / 2 {
                    let spike = if uniform() < 0.005 { -1.5e-3 } else { 0.0 };
                    return field[(y / block) * (width / block) + x / block] + spike;
                }
                let level = 0.5 * (x - width / 2) as f32 / (width / 2) as f32;
                level + (uniform() + uniform() + uniform() - 1.5) * 2.0 * 0.01 * level.sqrt()
            })
            .collect();
        let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
        let fit = pollster::block_on(denoise(
            gpu,
            galosh,
            &uploaded,
            &rggb(),
            UNGAINED,
            Amounts::from_sliders(40.0, 40.0),
        ));
        let denoised = read(gpu, &uploaded);

        // The field's lower half has a mean depth of 1.5e-4, which is a sigma of 1.9e-4.
        assert!(
            (1e-8..1e-7).contains(&fit.sigma_sq),
            "the photosites under black read a variance of {}",
            fit.sigma_sq
        );
        // The black half went in within 0.002 of zero.
        let worst = farthest_from_black(&denoised, width, height);
        assert!(
            worst < 0.01,
            "a black photosite came back {worst} from black"
        );
    }

    /// Photosites under black with none beside them are defects or a lit field's tail, and say
    /// nothing about the read noise however deep they sit.
    #[test]
    fn a_lone_photosite_under_black_does_not_move_the_fit() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(galosh) = device(gpu) else {
            return;
        };

        let (width, height) = (1024usize, 768usize);
        let fitted = |defects: bool| {
            let mut uniform = uniform_from(0x9e37_79b9_7f4a_7c15);
            // Lit throughout, so nothing is under black but what is put there.
            let noisy: Vec<f32> = (0..width * height)
                .map(|at| {
                    let (x, y) = (at % width, at / width);
                    let level = 0.02 + 0.48 * x as f32 / width as f32;
                    let sigma = (2e-4 * level + 1e-6).sqrt();
                    let lit = level + (uniform() + uniform() + uniform() - 1.5) * 2.0 * sigma;
                    // One green photosite in a 128x128 cell, each at a depth of its own.
                    match defects && x % 128 == 7 && y % 128 == 10 {
                        true => -0.01 - 1e-5 * (at % 997) as f32,
                        false => lit,
                    }
                })
                .collect();
            let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
            pollster::block_on(super::fit(gpu, galosh, &uploaded, &rggb(), UNGAINED))
        };
        let (clean, defective) = (fitted(false), fitted(true));
        assert!(
            (defective.sigma_sq / clean.sigma_sq - 1.0).abs() < 0.05,
            "48 lone photosites moved the read variance from {} to {}",
            clean.sigma_sq,
            defective.sigma_sq
        );
    }

    /// The fit states the variance a photosite has, in both of its terms, whether or not the frame
    /// carries rows the sensor never read: those sit at the file's zero, far under black, at a
    /// value to each black level.
    #[test]
    fn the_fit_reads_back_the_model_a_frame_was_drawn_from() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(galosh) = device(gpu) else {
            return;
        };

        let (width, height) = (1024usize, 768usize);
        let (alpha, sigma_sq) = (2e-4f32, 1e-6f32);
        for read_rows in [height, height - 64] {
            let mut uniform = uniform_from(0x9e37_79b9_7f4a_7c15);
            // Black over the left quarter, then a ramp: a second difference reads none of it.
            let noisy: Vec<f32> = (0..width * height)
                .map(|at| {
                    let (x, y) = (at % width, at / width);
                    if y >= read_rows {
                        return [-0.034, -0.011, -0.012, -0.017][(y & 1) | ((x & 1) << 1)];
                    }
                    let level = 0.5 * x.saturating_sub(width / 4) as f32 / (3 * width / 4) as f32;
                    let sigma = (alpha * level + sigma_sq).sqrt();
                    level + (uniform() + uniform() + uniform() - 1.5) * 2.0 * sigma
                })
                .collect();
            let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
            let fit = pollster::block_on(super::fit(gpu, galosh, &uploaded, &rggb(), UNGAINED));

            assert!(
                (fit.alpha / alpha - 1.0).abs() < 0.1,
                "a shot slope of {alpha} was fitted as {} over {read_rows} rows",
                fit.alpha
            );
            assert!(
                (fit.sigma_sq / sigma_sq - 1.0).abs() < 0.2,
                "a read variance of {sigma_sq} was fitted as {} over {read_rows} rows",
                fit.sigma_sq
            );
        }
    }

    /// A colour step at the top of the Colour track must stay where the scene put it.
    ///
    /// The coarse levels are box downsamples, so a fuse that took one whole would spread a
    /// saturated green on grey across its sites.
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
        let mut uniform = uniform_from(0x2545_f491_4f6c_dd1d);
        let level = |x: usize, slot: usize| -> f32 {
            if x < edge {
                0.1
            } else {
                [0.03, 0.18, 0.18, 0.03][slot]
            }
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
        pollster::block_on(denoise(
            gpu,
            galosh,
            &uploaded,
            &rggb(),
            UNGAINED,
            Amounts::from_sliders(0.0, 100.0),
        ));
        let denoised = read(gpu, &uploaded);

        // The red sites, averaged down each column: the grey side is 0.1 and the green side 0.03.
        for x in (0..width).step_by(2).filter(|x| x.abs_diff(edge) >= 6) {
            let mean = (0..height)
                .step_by(2)
                .map(|y| denoised[y * width + x])
                .sum::<f32>()
                / (height / 2) as f32;
            let off = (mean - level(x, 0)).abs() / 0.07;
            assert!(off < 0.03, "column {x} carries {off:.3} of the step");
        }
    }

    #[test]
    fn a_plate_keeps_its_colour_without_noise_or_directional_grain() {
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        let galosh = device(gpu).expect("the GALOSH kernels");

        let (width, height) = (720, 208);
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/mosaics/red-plate-rim.f32");
        let bytes = std::fs::read(path).expect("the plate's mosaic");
        assert_eq!(bytes.len(), width * height * 4);
        let mosaic: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|word| f32::from_le_bytes([word[0], word[1], word[2], word[3]]))
            .collect();
        let rcd = crate::demosaic::device(gpu).expect("the demosaic kernels");
        let low_pass = |plane: &[f64], hole: isize| -> Vec<f64> {
            let mut smoothed = plane.to_vec();
            for (stride, size) in [(1, width), (width, height)] {
                smoothed = (0..plane.len())
                    .map(|at| {
                        let position = at / stride % size;
                        [1.0, 4.0, 6.0, 4.0, 1.0]
                            .into_iter()
                            .enumerate()
                            .map(|(tap, weight)| {
                                let neighbour = (position as isize + (tap as isize - 2) * hole)
                                    .clamp(0, size as isize - 1)
                                    as usize;
                                weight * smoothed[at - position * stride + neighbour * stride]
                                    / 16.0
                            })
                            .sum()
                    })
                    .collect();
            }
            smoothed
        };
        // Fixed noise budgets in preview codes of 255; changing them weakens regression coverage.
        let budgets = [
            (
                1.0,
                [
                    [[0.2843, 0.2919], [0.1727, 0.1305], [0.2358, 0.1933]],
                    [[0.3226, 0.3256], [0.2617, 0.1816], [0.3587, 0.2542]],
                ],
            ),
            (
                1.35,
                [
                    [[0.2832, 0.2865], [0.1749, 0.1298], [0.2388, 0.1989]],
                    [[0.3198, 0.3186], [0.2631, 0.1827], [0.3550, 0.2528]],
                ],
            ),
            (
                2.0,
                [
                    [[0.2858, 0.2882], [0.1732, 0.1307], [0.2349, 0.1924]],
                    [[0.3196, 0.3101], [0.2611, 0.1775], [0.3520, 0.2546]],
                ],
            ),
            (
                3.0,
                [
                    [[0.2819, 0.2833], [0.1724, 0.1273], [0.2312, 0.1763]],
                    [[0.3221, 0.3157], [0.2594, 0.1846], [0.3504, 0.2544]],
                ],
            ),
        ];
        for sensor_orientation in [false, true] {
            let orientation = if sensor_orientation {
                "sensor"
            } else {
                "upright"
            };
            let index = |x: usize, y: usize| {
                if sensor_orientation {
                    x * height + height - 1 - y
                } else {
                    y * width + x
                }
            };
            let (sample_width, sample_height, quad, dark_ref) = if sensor_orientation {
                (
                    height,
                    width,
                    [0, 1, 1, 2],
                    [37.809074, 37.36227, 37.358116, 36.996742],
                )
            } else {
                (
                    width,
                    height,
                    [1, 2, 0, 1],
                    [37.358116, 37.809074, 36.996742, 37.36227],
                )
            };
            let mut samples = vec![0.0; mosaic.len()];
            for y in 0..height {
                for x in 0..width {
                    samples[index(x, y)] = mosaic[y * width + x];
                }
            }
            let cfa = crate::cfa::Cfa::bayer(quad).expect("the plate's Bayer pattern");
            let fit = NoiseFit {
                alpha: 9.370247e-5,
                sigma_sq: 5.7659613e-6,
                unified_sigma: 1.4446775,
                dark_ref,
            };
            let filtered = |colour: f32| -> crate::condition::Mosaic {
                let uploaded =
                    crate::condition::Mosaic::upload(gpu, &samples, sample_width, sample_height);
                // The top of the Luminance track: the grain a lower position keeps is light, which a
                // colour difference in gamma over a coloured plate reads as colour.
                let amounts = Amounts {
                    luma: Amounts::from_sliders(100.0, 0.0).luma,
                    colour,
                };
                pollster::block_on(super::denoise_with(
                    gpu, galosh, &uploaded, &cfa, UNGAINED, amounts, fit,
                ));
                uploaded
            };
            let rows = |denoised: &[f32]| -> Vec<[f64; 2]> {
                (0..height / 2)
                    .map(|site| {
                        let mean = |dx: usize, dy: usize| {
                            (200..520)
                                .step_by(2)
                                .map(|x| f64::from(denoised[index(x + dx, site * 2 + dy)]))
                                .sum::<f64>()
                                / 160.0
                        };
                        [mean(0, 1), mean(1, 0)]
                    })
                    .collect()
            };
            let band_contrast = |profile: &[[f64; 2]]| {
                (138..154)
                    .step_by(2)
                    .map(|y| profile[y / 2][1] - profile[y / 2][0])
                    .sum::<f64>()
            };
            let chroma_noise = |rgb: &[u8]| -> [[[f64; 2]; 3]; 2] {
                std::array::from_fn(|axis| {
                    let mut plane: Vec<f64> = (0..width * height)
                        .map(|at| {
                            let pixel = &rgb[index(at % width, at / width) * 3..][..3];
                            let luma = pixel
                                .iter()
                                .zip(crate::image::LUMA)
                                .map(|(&value, weight)| f64::from(value) * f64::from(weight))
                                .sum::<f64>();
                            f64::from(pixel[2 * axis]) - luma
                        })
                        .collect();
                    std::array::from_fn(|band| {
                        let hole = 1isize << band;
                        let smoothed = low_pass(&plane, hole);
                        let mut detail: Vec<f64> = (16..42)
                            .flat_map(|y| (160..560).map(move |x| y * width + x))
                            .map(|at| (plane[at] - smoothed[at]).abs())
                            .collect();
                        let rms = (detail.iter().map(|value| value * value).sum::<f64>()
                            / detail.len() as f64)
                            .sqrt();
                        detail.sort_unstable_by(f64::total_cmp);
                        let middle = detail.len() / 2;
                        let mad = 1.4826 * (detail[middle - 1] + detail[middle]) * 0.5;
                        plane = smoothed;
                        [rms, mad]
                    })
                })
            };
            let reference = band_contrast(&rows(&read(gpu, &filtered(0.0))));
            for (colour, budget) in budgets {
                let uploaded = filtered(colour);
                let denoised = rows(&read(gpu, &uploaded));
                let retained = band_contrast(&denoised) / reference;
                assert!(
                    retained > 0.8,
                    "{orientation}, colour {colour} retained {retained:.3} of the blue band's contrast"
                );
                for y in (100..120).step_by(2) {
                    let [red, blue] = denoised[y / 2];
                    assert!(
                        red > blue,
                        "{orientation}, colour {colour}, red plate row {y}: R {red:.5}, B {blue:.5}"
                    );
                }
                for y in (140..148).step_by(2) {
                    let [red, blue] = denoised[y / 2];
                    assert!(
                        blue > red,
                        "{orientation}, colour {colour}, blue rim row {y}: R {red:.5}, B {blue:.5}"
                    );
                }
                let rgb = pollster::block_on(crate::demosaic::demosaic_plane(
                    gpu,
                    rcd,
                    &uploaded,
                    &cfa,
                    |bytes| {
                        bytes
                            .chunks_exact(4)
                            .map(|word| {
                                let value = f32::from_ne_bytes(word.try_into().unwrap());
                                ((value * 8.0).clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0).round()
                                    as u8
                            })
                            .collect::<Vec<_>>()
                    },
                ))
                .expect("the plate's preview");
                let noise = chroma_noise(&rgb);
                for (axis, name) in ["Cr", "Cb"].into_iter().enumerate() {
                    for band in 0..3 {
                        for (metric, label) in ["RMS", "MAD"].into_iter().enumerate() {
                            let (actual, original) =
                                (noise[axis][band][metric], budget[axis][band][metric]);
                            assert!(
                                actual <= original * 1.05,
                                "{orientation}, colour {colour}, background {name}, hole {}, {label}: {actual:.6} exceeds original {original:.6} by more than 5%",
                                1 << band
                            );
                        }
                    }
                }
                if colour == 3.0 {
                    let luma: Vec<f64> = (0..width * height)
                        .map(|at| {
                            rgb[index(at % width, at / width) * 3..][..3]
                                .iter()
                                .zip(crate::image::LUMA)
                                .map(|(&value, weight)| f64::from(value) * f64::from(weight))
                                .sum()
                        })
                        .collect();
                    let blurred = low_pass(&low_pass(&luma, 1), 1);
                    let detail: Vec<_> = luma.iter().zip(blurred).map(|(a, b)| a - b).collect();
                    let correlation = |dx: isize| {
                        let mut sums = [0.0f64; 6];
                        for y in 90..126 {
                            for x in 200..520 {
                                let a = detail[y * width + x];
                                let b = detail[(y + 2) * width + (x as isize + dx) as usize];
                                for (sum, value) in
                                    sums.iter_mut().zip([a, b, a * a, b * b, a * b, 1.0])
                                {
                                    *sum += value;
                                }
                            }
                        }
                        let [a, b, aa, bb, ab, n] = sums;
                        let correlation =
                            (ab - a * b / n) / ((aa - a * a / n) * (bb - b * b / n)).sqrt();
                        (correlation, (aa / n).sqrt())
                    };
                    let (along, rms) = correlation(2);
                    let (across, _) = correlation(-2);
                    assert!(
                        (along - across).abs() < 0.06,
                        "{orientation}: diagonal grain correlations {along:.4}/{across:.4} favour one direction"
                    );
                    assert!(
                        rms < 0.516 * 1.05,
                        "{orientation}: removing streaks increased fine-grain RMS to {rms:.4}"
                    );
                }
            }
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
        let mut uniform = uniform_from(0x6a09_e667_f3bc_c908);
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
        pollster::block_on(denoise(
            gpu,
            galosh,
            &uploaded,
            &rggb(),
            UNGAINED,
            Amounts::from_sliders(40.0, 0.0),
        ));
        let denoised = read(gpu, &uploaded);

        for band in [1.0f32, 2.0, 3.0, 4.0] {
            let ring: Vec<f32> = (0..width * height)
                .filter(|&at| (band..band + 1.0).contains(&distance(at)))
                .map(|at| denoised[at])
                .collect();
            let lift = ring.iter().sum::<f32>() / ring.len() as f32 / outside - 1.0;
            assert!(
                lift.abs() < 0.04,
                "{band}px outside the rim is lifted by {lift:.3}"
            );
        }
    }

    #[test]
    fn fine_detail_on_a_grey_subject_does_not_come_back_as_colour() {
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        let galosh = device(gpu).expect("the GALOSH kernels");
        let rcd = crate::demosaic::device(gpu).expect("the demosaic kernels");
        let fit = NoiseFit {
            alpha: 1e-5,
            sigma_sq: 1e-6,
            unified_sigma: 1.0,
            dark_ref: [200.00375; 4],
        };

        let (width, height) = (256, 192);
        for quad in [[0, 1, 1, 2], [2, 1, 1, 0], [1, 0, 2, 1], [1, 2, 0, 1]] {
            let cfa = crate::cfa::Cfa::bayer(quad).expect("Bayer pattern");
            let green_at_origin = cfa.colour_at(0, 0) == crate::cfa::GREEN;
            let diagonal = if green_at_origin { 1.0 } else { -1.0 };
            let mut uniform = uniform_from(0x9e37_79b9_7f4a_7c15);
            let scene = |x: usize, y: usize| {
                if y < height / 2 {
                    return 0.25;
                }
                let along = (x as f32 + diagonal * y as f32) * std::f32::consts::TAU / 6.0;
                0.25 * (1.0 + 0.4 * along.sin())
            };
            let clean: Vec<f32> = (0..width * height)
                .map(|at| scene(at % width, at / width))
                .collect();
            let noisy: Vec<f32> = (0..width * height)
                .map(|at| {
                    let level = clean[at];
                    let sigma = (fit.alpha * level + fit.sigma_sq).sqrt();
                    (level + (uniform() + uniform() + uniform() - 1.5) * 2.0 * sigma)
                        .clamp(0.0, 1.0)
                })
                .collect();

            let error_at = |colour: f32| {
                let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
                pollster::block_on(super::denoise_with(
                    gpu,
                    galosh,
                    &uploaded,
                    &cfa,
                    UNGAINED,
                    Amounts { luma: 0.0, colour },
                    fit,
                ));
                let rgb = pollster::block_on(crate::demosaic::demosaic_plane(
                    gpu,
                    rcd,
                    &uploaded,
                    &cfa,
                    |bytes| {
                        bytes
                            .chunks_exact(4)
                            .map(|word| f32::from_ne_bytes(word.try_into().unwrap()))
                            .collect::<Vec<_>>()
                    },
                ))
                .expect("the grey picture");
                let margin = crate::demosaic::MARGIN as usize;
                let mut sums = [0.0f64; 7];
                for y in height / 2 + margin..height - margin {
                    for x in margin..width - margin {
                        let at = y * width + x;
                        let pixel = &rgb[at * 3..][..3];
                        let luma = pixel
                            .iter()
                            .zip(crate::image::LUMA)
                            .map(|(&value, weight)| f64::from(value) * f64::from(weight))
                            .sum::<f64>();
                        let truth = f64::from(clean[at]);
                        let red_green = f64::from(pixel[0] - pixel[1]);
                        let blue_green = f64::from(pixel[2] - pixel[1]);
                        for (sum, value) in sums.iter_mut().zip([
                            truth,
                            luma,
                            truth * truth,
                            truth * luma,
                            red_green * red_green,
                            blue_green * blue_green,
                            1.0,
                        ]) {
                            *sum += value;
                        }
                    }
                }
                let [truth, luma, power, product, red, blue, n] = sums;
                let gain = (product - truth * luma / n) / (power - truth * truth / n);
                ([(red / n).sqrt(), (blue / n).sqrt()], gain)
            };
            let untouched = error_at(0.0);
            for colour in [1.0, 2.0, 3.0] {
                let smoothed = error_at(colour);
                for axis in 0..2 {
                    assert!(
                        smoothed.0[axis] <= untouched.0[axis] * 1.05,
                        "Bayer {quad:?}, colour {colour}: false-colour RMS {} against {} without colour denoise",
                        smoothed.0[axis],
                        untouched.0[axis]
                    );
                }
                assert!(
                    smoothed.1 >= untouched.1 * 0.95,
                    "Bayer {quad:?}, colour {colour}: texture gain {} against {} without colour denoise",
                    smoothed.1,
                    untouched.1,
                );
            }
        }
    }

    /// Texture on a coloured surface must survive the colour denoise.
    ///
    /// A site's differences carry the brightness change across it as well as its hue, so a shrink
    /// that smooths them as hue takes the texture with the noise and the inverse rebuilds each site
    /// flat - skin and hair come back painted, with the site grid showing through. Green, because
    /// on a coloured surface the modulation lands in the greens alone and a grey model of it would
    /// miss most of it.
    #[test]
    fn texture_on_a_coloured_surface_survives_the_colour_denoise() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(galosh) = device(gpu) else {
            return;
        };

        let (width, height) = (384, 384);
        let mut uniform = uniform_from(0x3c6e_f372_fe94_f82b);
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
        pollster::block_on(denoise(
            gpu,
            galosh,
            &uploaded,
            &rggb(),
            UNGAINED,
            Amounts::from_sliders(0.0, 27.0),
        ));
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
        assert!(
            kept > 0.6,
            "the colour denoise kept {kept:.3} of the texture"
        );
    }

    /// The pattern every synthetic frame here is written in, `frame_with_noise`'s four levels
    /// being indexed by the same 2x2 slot.
    fn rggb() -> crate::cfa::Cfa {
        crate::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB is a pattern")
    }

    fn xtrans() -> crate::cfa::Cfa {
        crate::cfa::tests::parse(crate::cfa::tests::XTRANS, 6, 6)
    }

    /// Xorshift from `seed`, uniform on [0, 1).
    fn uniform_from(mut seed: u64) -> impl FnMut() -> f32 {
        move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 40) as f32 / 16777216.0
        }
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
        let samples: Vec<f32> = (0..size)
            .flat_map(|y| (0..size).map(move |x| (x, y)))
            .map(|(x, y)| at(x0 + 2 * x, y0 + 2 * y))
            .collect();
        let mean = samples.iter().sum::<f32>() / samples.len() as f32;
        samples.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / samples.len() as f32
    }

    #[test]
    fn a_non_bayer_two_by_two_preserves_neutral_brightness() {
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        let galosh = device(gpu).expect("the GALOSH kernels");
        let cfa = crate::cfa::Cfa::new(2, 2, &[0, 1, 2, 1]).expect("an RGB pattern");
        assert!(!cfa.is_bayer() && super::filters(&cfa));
        let (width, height) = (64, 64);
        let level = 0.25;
        let fit = NoiseFit {
            alpha: 1e-5,
            sigma_sq: 1e-6,
            unified_sigma: 1.0,
            dark_ref: [0.0; 4],
        };
        for colour in [0.0, 3.0] {
            let mosaic =
                crate::condition::Mosaic::upload(gpu, &vec![level; width * height], width, height);
            pollster::block_on(super::denoise_with(
                gpu,
                galosh,
                &mosaic,
                &cfa,
                UNGAINED,
                Amounts {
                    luma: 0.528,
                    colour,
                },
                fit,
            ));
            for value in read(gpu, &mosaic) {
                assert!(
                    (value - level).abs() < 1e-4,
                    "colour {colour}: neutral brightness {level} became {value}"
                );
            }
        }
    }

    #[test]
    fn colour_denoise_preserves_mean_colour_on_a_flat_surface() {
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        let galosh = device(gpu).expect("the GALOSH kernels");
        let (width, height) = (256, 192);
        let mut noisy = frame(width, height);
        for (at, value) in noisy.iter_mut().enumerate() {
            if (at % width) % 2 == 1 && (at / width) % 2 == 0 {
                *value += 0.02;
            }
        }
        let original = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
        let fit = pollster::block_on(super::fit(gpu, galosh, &original, &rggb(), UNGAINED));
        for colour in [1.0, 1.35, 2.0, 3.0] {
            let uploaded = original.duplicate(gpu);
            pollster::block_on(super::denoise_with(
                gpu,
                galosh,
                &uploaded,
                &rggb(),
                UNGAINED,
                Amounts {
                    luma: 0.528,
                    colour,
                },
                fit,
            ));
            let denoised = read(gpu, &uploaded);
            for (slot, expected) in [0.20, 0.34, 0.36, 0.12].into_iter().enumerate() {
                let (dx, dy) = (slot >> 1, slot & 1);
                let mean = (16..80)
                    .step_by(2)
                    .flat_map(|y| {
                        let values = &denoised;
                        (16..80)
                            .step_by(2)
                            .map(move |x| f64::from(values[(y + dy) * width + x + dx]))
                    })
                    .sum::<f64>()
                    / 1024.0;
                assert!(
                    (mean - expected).abs() < 0.003,
                    "colour {colour}, slot {slot}: mean {mean:.5}, expected {expected:.5}"
                );
            }
            assert!(
                variance(&denoised, width, 16, 16, 32) < variance(&noisy, width, 16, 16, 32) * 0.5,
                "colour {colour} leaves more than half the flat surface's noise variance"
            );
        }
    }

    #[test]
    fn colour_amount_starts_from_zero_without_a_jump() {
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        let galosh = device(gpu).expect("the GALOSH kernels");
        let (width, height) = (256, 192);
        let source = crate::condition::Mosaic::upload(gpu, &frame(width, height), width, height);
        let fit = pollster::block_on(super::fit(gpu, galosh, &source, &rggb(), UNGAINED));
        let at = |colour| {
            let mosaic = source.duplicate(gpu);
            pollster::block_on(super::denoise_with(
                gpu,
                galosh,
                &mosaic,
                &rggb(),
                UNGAINED,
                Amounts {
                    luma: 0.528,
                    colour,
                },
                fit,
            ));
            read(gpu, &mosaic)
        };
        let zero = at(0.0);
        let moved = |colour| {
            zero.iter()
                .zip(at(colour))
                .map(|(a, b)| (a - b).abs())
                .fold(0.0f32, f32::max)
        };
        let (jump, whole) = (moved(0.001), moved(1.0));
        assert!(whole > 0.0, "a colour amount of 1 moved nothing");
        assert!(
            jump <= 0.002 * whole,
            "colour amount approaching zero moves a sample {jump}, against {whole} at 1"
        );
    }

    /// Noise a denoise leaves on flat ground is grain, never a site-scale checker: less the share of
    /// its own noise a weaker setting hands back, the frame holds none.
    #[test]
    fn flat_noise_is_left_as_grain_and_never_as_checkers() {
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        let galosh = device(gpu).expect("the GALOSH kernels");
        let (width, height) = (512, 512);
        let mut uniform = uniform_from(0x9e37_79b9_7f4a_7c15);
        let level = 0.02f32;
        let sigma = 0.0005 + 0.01 * level.sqrt();
        let noisy: Vec<f32> = (0..width * height)
            .map(|_| level + (uniform() + uniform() + uniform() + uniform() - 2.0) * sigma)
            .collect();
        let means = |samples: &[f32]| -> Vec<f32> {
            (0..width / 2 * height / 2)
                .map(|at| {
                    let (x, y) = (at % (width / 2) * 2, at / (width / 2) * 2);
                    let site = |dx: usize, dy: usize| samples[(y + dy) * width + x + dx];
                    (site(0, 0) + site(1, 0) + site(0, 1) + site(1, 1)) / 2.0
                })
                .collect()
        };
        let source = means(&noisy);
        let mean = source.iter().sum::<f32>() / source.len() as f32;
        let deviation =
            (source.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / source.len() as f32).sqrt();
        let worst_checker = |plane: &[f32]| -> f32 {
            let side = width / 2;
            let mut worst = 0.0f32;
            for y in (8..side - 12).step_by(2) {
                for x in (8..side - 12).step_by(2) {
                    let mut sum = 0.0;
                    for j in 0..4 {
                        for i in 0..4 {
                            let sign = if (i + j) % 2 == 0 { 1.0 } else { -1.0 };
                            sum += sign * plane[(y + j) * side + x + i];
                        }
                    }
                    worst = worst.max((sum / 4.0).abs() / deviation);
                }
            }
            worst
        };
        for luma in [0.8f32, 0.992] {
            let mosaic = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
            pollster::block_on(denoise(
                gpu,
                galosh,
                &mosaic,
                &rggb(),
                UNGAINED,
                Amounts { luma, colour: 3.0 },
            ));
            let kept = 1.0 - luma;
            let shrunk: Vec<f32> = means(&read(gpu, &mosaic))
                .iter()
                .zip(&source)
                .map(|(denoised, noisy)| (denoised - kept * noisy) / luma)
                .collect();
            let left = worst_checker(&shrunk);
            assert!(
                left < 0.08,
                "luma {luma}: the shrink leaves a checker of {left:.3} deviations"
            );
        }
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
        pollster::block_on(denoise(
            gpu,
            galosh,
            &uploaded,
            &rggb(),
            UNGAINED,
            Amounts {
                luma: 1.0,
                colour: 1.0,
            },
        ));
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

    /// **More Colour never leaves a saturated colour more coloured grain**: the channels of a
    /// period disagree less, in proportion to their levels, the stronger the Colour.
    ///
    /// The GAT is near a square root, so equal noise on every colour in it is a larger swing in
    /// proportion on a dim channel than a bright one: colour shrunk toward no slope against the luma
    /// turned the luma's own noise into colour, and past 1.8 the dim green of this blue rose with
    /// the strength (0.393 to 0.427 of its level on X-Trans) while red and blue fell. Grey grain
    /// is equal swings in proportion, so a bright channel may rise toward it; disagreement may not.
    #[test]
    fn more_colour_never_leaves_a_saturated_colour_more_coloured_grain() {
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        let galosh = device(gpu).expect("the GALOSH kernels");
        let (width, height) = (576, 576);
        let levels = [0.008f32, 0.0016, 0.027];
        for cfa in [rggb(), xtrans()] {
            let mut uniform = uniform_from(0x2545_f491_4f6c_dd1d);
            let noisy: Vec<f32> = (0..width * height)
                .map(|at| {
                    let level = levels[cfa.colour_at(at / width, at % width) as usize];
                    let deviation = (1.0e-3 * level + 0.002f32 * 0.002).sqrt();
                    let bell = (uniform() + uniform() + uniform() + uniform() - 2.0) * 1.732;
                    level + bell * deviation
                })
                .collect();
            let (pw, ph) = cfa.period();
            let mut previous = f64::INFINITY;
            for colour in [1.2, 1.8, 2.4, 3.0] {
                let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
                pollster::block_on(denoise(
                    gpu,
                    galosh,
                    &uploaded,
                    &cfa,
                    UNGAINED,
                    Amounts { luma: 0.0, colour },
                ));
                let denoised = read(gpu, &uploaded);
                let (mut disagreement, mut periods) = (0.0f64, 0.0f64);
                for top in (96..height - 96).step_by(ph) {
                    for left in (96..width - 96).step_by(pw) {
                        let mut swing = [0.0f64; 3];
                        let mut counts = [0.0f64; 3];
                        for y in top..top + ph {
                            for x in left..left + pw {
                                let c = cfa.colour_at(y, x) as usize;
                                swing[c] +=
                                    f64::from(denoised[y * width + x]) / f64::from(levels[c]) - 1.0;
                                counts[c] += 1.0;
                            }
                        }
                        let [red, green, blue] = std::array::from_fn(|c| swing[c] / counts[c]);
                        disagreement += (red - green).powi(2) + (blue - green).powi(2);
                        periods += 1.0;
                    }
                }
                let disagreement = (disagreement / periods).sqrt();
                assert!(
                    disagreement <= previous * 1.01,
                    "{cfa:?}, colour {colour}: the channels disagree by {disagreement:.4}, up from {previous:.4}"
                );
                previous = disagreement;
            }
        }
    }

    /// Every colour keeps its level, in shadow too, when the conditioning gave it more gain than
    /// green: its noise is larger by that gain, and stabilised as green's the GAT's curvature turns
    /// the excess into a mean pulled down.
    #[test]
    fn a_colour_conditioned_at_more_gain_keeps_its_level() {
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        let galosh = device(gpu).expect("the GALOSH kernels");
        let gains = [1.0f32, 0.36, 0.57];
        let (alpha, sigma_sq) = (2.75e-3f32, 8.4e-6f32);
        let sky = [0.011f32, 0.0092, 0.010];
        let (width, height) = (1152, 1152);
        let lit = |x: usize| (x.saturating_sub(width / 4) as f32 / (3 * width / 4) as f32).min(1.0);
        let over_green = |colour: usize| gains[colour] / gains[1];
        let deviation = |colour: usize, level: f32| {
            let green = level / over_green(colour);
            over_green(colour) * (alpha * green.max(0.0) + sigma_sq).sqrt()
        };
        for cfa in [rggb(), xtrans()] {
            let mut uniform = uniform_from(0x9e37_79b9_7f4a_7c15);
            let noisy: Vec<f32> = (0..width * height)
                .map(|at| {
                    let (x, y) = (at % width, at / width);
                    let colour = cfa.colour_at(y, x) as usize;
                    let level = sky[colour] * lit(x);
                    let bell = (uniform() + uniform() + uniform() + uniform() - 2.0) * 1.732;
                    level + bell * deviation(colour, level)
                })
                .collect();
            let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
            pollster::block_on(denoise(
                gpu,
                galosh,
                &uploaded,
                &cfa,
                gains,
                Amounts {
                    luma: 0.8,
                    colour: 3.0,
                },
            ));
            let denoised = read(gpu, &uploaded);
            for (left, right) in [(24, 200), (560, 736), (920, 1128)] {
                let mut sums = [0.0f64; 3];
                let mut counts = [0.0f64; 3];
                let (mut left_over, mut given) = (0.0f64, 0.0f64);
                for y in 24..height - 24 {
                    for x in left..right {
                        let colour = cfa.colour_at(y, x) as usize;
                        let truth = sky[colour] * lit(x);
                        let error = f64::from(denoised[y * width + x] - truth);
                        sums[colour] += error;
                        counts[colour] += 1.0;
                        left_over += error * error;
                        given += f64::from(noisy[y * width + x] - truth).powi(2);
                    }
                }
                assert!(
                    left_over < 0.25 * given,
                    "{cfa:?}, columns {left} to {right}: {:.3} of the noise left",
                    left_over / given
                );
                let centre = sky.map(|level| level * lit((left + right) / 2));
                for colour in 0..3 {
                    let off = sums[colour]
                        / counts[colour]
                        / f64::from(deviation(colour, centre[colour]));
                    assert!(
                        off.abs() < 0.04,
                        "{cfa:?}, columns {left} to {right}: colour {colour} moved {off:+.3} of its noise"
                    );
                }
            }
        }
    }

    /// X-Trans is shrunk as 3x3 sites: flat ground loses most of its noise, and an edge stays an
    /// edge rather than a ramp.
    #[test]
    fn an_xtrans_frame_loses_its_noise_and_keeps_its_edge() {
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        let galosh = device(gpu).expect("the GALOSH kernels");
        let cfa = xtrans();
        let (width, height) = (288, 192);
        let mut uniform = uniform_from(0x2545_f491_4f6c_dd1d);
        let noisy: Vec<f32> = (0..width * height)
            .map(|at| {
                let (x, y) = (at % width, at / width);
                let level = [0.20, 0.34, 0.12][cfa.colour_at(y, x) as usize];
                let bright = if x > width / 2 { 0.45 } else { 0.0 };
                (level + bright + (uniform() + uniform() - 1.0) * 0.05).clamp(0.0, 1.0)
            })
            .collect();
        let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
        pollster::block_on(denoise(
            gpu,
            galosh,
            &uploaded,
            &cfa,
            UNGAINED,
            Amounts {
                luma: 1.0,
                colour: 1.0,
            },
        ));
        let denoised = read(gpu, &uploaded);

        let spread = |frame: &[f32]| {
            let samples: Vec<f32> = (0..16)
                .flat_map(|j| (0..16).map(move |i| frame[(12 + 6 * j) * width + 12 + 6 * i]))
                .collect();
            let mean = samples.iter().sum::<f32>() / samples.len() as f32;
            samples.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / samples.len() as f32
        };
        let (before, after) = (spread(&noisy), spread(&denoised));
        assert!(
            after < before * 0.5,
            "a flat field should lose most of its variance: {before} -> {after}"
        );
        let step = |frame: &[f32]| {
            let row = 96 * width;
            frame[row + width / 2 + 12] - frame[row + width / 2 - 12]
        };
        assert!(
            step(&denoised) > step(&noisy) * 0.9,
            "the edge should survive: {} -> {}",
            step(&noisy),
            step(&denoised),
        );
    }

    /// A run handed its fit stabilises inside its pack, and must come back the frame a run
    /// measuring its own does.
    #[test]
    fn a_given_fit_denoises_as_the_frames_own_does() {
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        let galosh = device(gpu).expect("the GALOSH kernels");
        let (width, height) = (288, 192);
        let noisy = frame(width, height);
        let amounts = Amounts {
            luma: 1.0,
            colour: 1.0,
        };
        let gains = [1.0, 0.5, 0.7];
        for cfa in [rggb(), xtrans()] {
            let measured = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
            let fit = pollster::block_on(denoise(gpu, galosh, &measured, &cfa, gains, amounts));
            let given = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
            pollster::block_on(super::denoise_with(
                gpu, galosh, &given, &cfa, gains, amounts, fit,
            ));
            let worst = read(gpu, &given)
                .iter()
                .zip(read(gpu, &measured))
                .map(|(a, b)| (a - b).abs())
                .fold(0f32, f32::max);
            assert!(
                worst < 1e-5,
                "{cfa:?}: a given fit moved a sample by {worst}"
            );
        }
    }

    /// At no strength the frame comes back as it went in, on a frame whose GAT sits far from zero:
    /// X-Trans's luma plane is thrice a photosite, and read noise lifts it further. Both entry
    /// points, since `pyr_restore` rebuilds the noisy luma plane the way each one packed it.
    #[test]
    fn a_frame_at_no_strength_comes_back_itself() {
        let _held = ONE_DENOISE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        let galosh = device(gpu).expect("the GALOSH kernels");
        let (width, height) = (288, 192);
        let noisy = frame(width, height);
        let gains = [1.0, 0.5, 0.7];
        let nothing = Amounts {
            luma: 0.0,
            colour: 0.0,
        };
        for cfa in [rggb(), xtrans()] {
            let uploaded = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
            let fit = pollster::block_on(super::fit(gpu, galosh, &uploaded, &cfa, gains));
            for given in [true, false] {
                let denoised = crate::condition::Mosaic::upload(gpu, &noisy, width, height);
                match given {
                    true => pollster::block_on(super::denoise_with(
                        gpu, galosh, &denoised, &cfa, gains, nothing, fit,
                    )),
                    false => pollster::block_on(super::denoise(
                        gpu, galosh, &denoised, &cfa, gains, nothing,
                    )),
                };
                let worst = read(gpu, &denoised)
                    .iter()
                    .zip(&noisy)
                    .map(|(a, b)| (a - b).abs())
                    .fold(0f32, f32::max);
                assert!(
                    worst < 1e-4,
                    "{cfa:?}, fit given {given}: a sample moved by {worst}"
                );
            }
        }
    }

    /// Every site transform is orthonormal, so the inverse is its transpose and white noise stays
    /// white and unit in every plane.
    #[test]
    fn every_site_transform_is_orthonormal() {
        let patterns = [
            rggb(),
            crate::cfa::Cfa::new(2, 2, &[0, 1, 2, 1]).expect("an RGB pattern"),
            xtrans(),
        ];
        for cfa in patterns {
            let side = super::site_side(&cfa).expect("a site");
            let planes = side * side;
            let n = super::PYRAMID_MAX_PLANES;
            for site in super::site_transform(&cfa, side).chunks(n * n) {
                for p in 0..planes {
                    for q in 0..planes {
                        let dot: f32 = (0..planes).map(|k| site[p * n + k] * site[q * n + k]).sum();
                        let expected = if p == q { 1.0 } else { 0.0 };
                        assert!(
                            (dot - expected).abs() < 1e-5,
                            "{cfa:?}: rows {p} and {q} meet at {dot}"
                        );
                    }
                }
            }
        }
    }
}
