//! Luma-chroma demultiplexing on the GPU, for the patterns RCD cannot pair into 2x2 sites.
//!
//! The algorithm is specified in `docs/lslcd-xtrans-spec.md`, which is the normative document. That
//! file is also where the provenance is stated exactly: the framework is Dubois's, the X-Trans
//! decomposition is derived there rather than taken from the paper that published one.
//!
//! Three stages, each a pure map over its sites, so each is one dispatch and nothing inside a stage
//! depends on anything else the same stage writes. The frame, the pattern and the border fill come
//! from `slang/mosaic.slang`, shared with RCD.

use crate::cfa::Cfa;

/// Radius of the one-dimensional prototype, and so the margin the demultiplexing does not write
/// (specification §3.1, §5). The horizontal pass reaches this far in `x` and the vertical this far
/// in `y`, and neither reaches diagonally, so the two compose to this rather than to twice it.
const RADIUS: usize = 8;

const TAPS: usize = RADIUS + 1;

pub const MARGIN: u32 = RADIUS as u32;

const STAGES: [&str; 3] = ["modulate_h", "filter_v", "assemble"];

pub struct Lslcd {
    planes: wgpu::BindGroupLayout,
    pipelines: Vec<wgpu::ComputePipeline>,
}

pub fn device(gpu: &'static crate::gpu::Gpu) -> Option<&'static Lslcd> {
    static BUILT: std::sync::OnceLock<Option<Lslcd>> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Lslcd::new(gpu)).as_ref()
}

// ---------------------------------------------------------------------------
// The decomposition (specification §2)
// ---------------------------------------------------------------------------

/// What one pattern's period says about how its mosaic splits into luma and two chroma signals.
///
/// Everything here is closed form in the three colour counts; nothing is fitted and nothing depends
/// on which phase of the pattern a body happens to write, because the masks are read off the colours
/// themselves.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Basis {
    /// `pq / 2N²` and `p / 2N`: the mean squares the two estimates are divided by (§2.3).
    pub k1: f64,
    pub k2: f64,
    /// `q / 2N`, the weight `C1` carries into red and blue (§2.2), and the value `w1` takes there.
    pub chroma_gain: f64,
    /// `p / N`, the weight it carries into green, and `-w1` there.
    pub green_gain: f64,
}

impl Basis {
    /// None for a pattern §2.6 cannot decompose: unequal red and blue counts break the orthogonality
    /// the estimator rests on, and without it each chroma estimate carries a share of the other.
    pub fn of(cfa: &Cfa) -> Option<Self> {
        let [red, green, blue] = cfa.counts();
        if red != blue || red == 0 || green == 0 {
            return None;
        }
        let (p, q) = (red as f64, green as f64);
        let n = 2.0 * p + q;
        Some(Self {
            k1: p * q / (2.0 * n * n),
            k2: p / (2.0 * n),
            chroma_gain: q / (2.0 * n),
            green_gain: p / n,
        })
    }

    /// `w1` and `w2` at a photosite of this colour (§2.3), as `lslcd.slang` derives them.
    pub fn masks(&self, colour: u8) -> (f64, f64) {
        match colour {
            crate::cfa::RED => (self.chroma_gain, 0.5),
            crate::cfa::BLUE => (self.chroma_gain, -0.5),
            _ => (-self.green_gain, 0.0),
        }
    }
}

// ---------------------------------------------------------------------------
// The filter (specification §3)
// ---------------------------------------------------------------------------

/// Quadrature points over `[0, π]`. The integrands are smooth trigonometric polynomials of degree at
/// most `RADIUS`, so this is far past where the rule stops mattering.
const QUADRATURE: usize = 4096;

/// Where the chroma passband stops and where the stopband starts (§3.3).
const PASSBAND: f64 = std::f64::consts::PI / 3.0;
const STOPBAND: f64 = 2.0 * std::f64::consts::PI / 3.0;

/// How much harder the fit is pushed past the nearest carrier than below it.
///
/// The two errors are not worth the same. Passband ripple tilts chroma across its own band, which
/// reads as a slight shift in saturation; what leaks through the stopband is a carrier surviving
/// demodulation, which reads as a colour that is not in the scene, laid over the pattern's own
/// period. Weighting them equally spends the filter's freedom on the one nobody sees.
const STOPBAND_WEIGHT: f64 = 8.0;

/// The symmetric prototype, centre tap first.
///
/// Constrained least squares: §3.2's four equalities exactly, §3.3's target in the remaining
/// freedom. Solved once per process rather than per frame - it depends on nothing but the constants
/// above.
pub fn design() -> [f32; TAPS] {
    static BUILT: std::sync::OnceLock<[f32; TAPS]> = std::sync::OnceLock::new();
    *BUILT.get_or_init(|| {
        let taps = solve_design().expect("the KKT system of a positive definite Gram is solvable");
        let mut out = [0f32; TAPS];
        for (slot, value) in out.iter_mut().zip(taps) {
            *slot = value as f32;
        }
        out
    })
}

/// `A(ω)`'s basis: `φ₀ = 1`, `φ_i = 2cos(iω)` (§3.1).
fn basis_at(omega: f64) -> [f64; TAPS] {
    let mut phi = [0f64; TAPS];
    phi[0] = 1.0;
    for (i, slot) in phi.iter_mut().enumerate().skip(1) {
        *slot = 2.0 * (i as f64 * omega).cos();
    }
    phi
}

/// `A'(ω)`, for the double zero §3.2 places on the nearest carrier group.
fn slope_at(omega: f64) -> [f64; TAPS] {
    let mut phi = [0f64; TAPS];
    for (i, slot) in phi.iter_mut().enumerate().skip(1) {
        *slot = -2.0 * i as f64 * (i as f64 * omega).sin();
    }
    phi
}

/// The ideal chroma response: flat over the passband, zero past the nearest carrier, raised cosine
/// between so the fit is not asked for a discontinuity it cannot have.
fn target(omega: f64) -> f64 {
    if omega <= PASSBAND {
        return 1.0;
    }
    if omega >= STOPBAND {
        return 0.0;
    }
    let across = (omega - PASSBAND) / (STOPBAND - PASSBAND);
    0.5 * (1.0 + (std::f64::consts::PI * across).cos())
}

fn solve_design() -> Option<Vec<f64>> {
    let step = std::f64::consts::PI / QUADRATURE as f64;
    let mut gram = [[0f64; TAPS]; TAPS];
    let mut against = [0f64; TAPS];
    for point in 0..QUADRATURE {
        let omega = (point as f64 + 0.5) * step;
        let phi = basis_at(omega);
        let want = target(omega);
        let weight = step * if omega >= STOPBAND { STOPBAND_WEIGHT } else { 1.0 };
        for i in 0..TAPS {
            against[i] += phi[i] * want * weight;
            for j in 0..TAPS {
                gram[i][j] += phi[i] * phi[j] * weight;
            }
        }
    }

    let constraints = [
        (basis_at(0.0), 1.0),
        (basis_at(STOPBAND), 0.0),
        (slope_at(STOPBAND), 0.0),
        (basis_at(std::f64::consts::PI), 0.0),
    ];

    // [ 2R  Cᵀ ] [ h ]   [ 2p ]
    // [ C   0  ] [ λ ] = [ b  ]
    let n = TAPS + constraints.len();
    let mut matrix = vec![0f64; n * n];
    let mut rhs = vec![0f64; n];
    for i in 0..TAPS {
        for j in 0..TAPS {
            matrix[i * n + j] = 2.0 * gram[i][j];
        }
        rhs[i] = 2.0 * against[i];
    }
    for (row, (coefficients, value)) in constraints.iter().enumerate() {
        for (column, coefficient) in coefficients.iter().enumerate() {
            matrix[(TAPS + row) * n + column] = *coefficient;
            matrix[column * n + TAPS + row] = *coefficient;
        }
        rhs[TAPS + row] = *value;
    }

    let mut solved = crate::fit::gaussian(&matrix, &rhs, n)?;
    solved.truncate(TAPS);
    Some(solved)
}

// ---------------------------------------------------------------------------
// The dispatch
// ---------------------------------------------------------------------------

/// `Params` in `lslcd.slang`, which is only what `mosaic.slang`'s `Shape` does not already carry.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    radius: u32,
    k1_inv: f32,
    k2_inv: f32,
    chroma_gain: f32,
    green_gain: f32,
    pad: [u32; 3],
}

#[cfg(test)]
pub(crate) fn params_block() -> usize {
    std::mem::size_of::<Params>()
}

impl Lslcd {
    fn new(gpu: &crate::gpu::Gpu) -> Option<Self> {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("lslcd"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/lslcd.wgsl")).into(),
            ),
        });

        let storage = |binding: u32, read_only: bool| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let uniform = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };

        // Group 0 is `mosaic.slang`'s and has the same shape here as it does for RCD - the caller
        // builds the group, since it is the same one the assembly binds next. Group 1 is this
        // algorithm's own: five storage buffers against the eight a device is required to offer,
        // which is what the two chroma signals sharing one plane apiece buys.
        let shape = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("lslcd shape"),
            entries: &[uniform(0), storage(1, true)],
        });
        let planes = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("lslcd planes"),
            entries: &[uniform(0), storage(1, true), storage(2, false), storage(3, false), storage(4, false)],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("lslcd"),
            bind_group_layouts: &[Some(&shape), Some(&planes)],
            ..Default::default()
        });

        let xtrans = Cfa::new(6, 6, &[1; 36])?;
        let pipelines = STAGES
            .iter()
            .map(|name| {
                device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(name),
                    layout: Some(&pipeline_layout),
                    module: &module,
                    entry_point: Some(name),
                    // Every stage here runs on a 6x6 period and no other, so `mosaic.slang`'s
                    // modulo is a compile-time one.
                    compilation_options: wgpu::PipelineCompilationOptions {
                        constants: &xtrans.constants(),
                        ..Default::default()
                    },
                    cache: None,
                })
            })
            .collect();

        Some(Lslcd { planes, pipelines })
    }
}

/// The three dispatches, recorded but not submitted, with the plane they write.
///
/// None where the pattern is not one §2.6 decomposes, or where the frame is too small to hold an
/// interior at all - a decode that reads nothing rather than one that answers with a second
/// arithmetic.
pub fn record(
    gpu: &'static crate::gpu::Gpu,
    lslcd: &Lslcd,
    mosaic: &crate::condition::Mosaic,
    cfa: &Cfa,
    shape_group: &wgpu::BindGroup,
) -> Option<crate::demosaic::Recorded> {
    let (width, height) = (mosaic.width, mosaic.height);
    if width < (2 * RADIUS) + 4 || height < (2 * RADIUS) + 4 {
        return None;
    }
    let basis = Basis::of(cfa)?;

    let mut lap = crate::clock::laps("    lslcd ");

    let pixels = width * height;
    let plane_bytes = (pixels * std::mem::size_of::<f32>()) as u64;

    let mut recording = gpu.record();
    recording.holding(&mosaic.buffer);
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("lslcd params"),
        contents: bytemuck::bytes_of(&Params {
            radius: RADIUS as u32,
            k1_inv: (1.0 / basis.k1) as f32,
            k2_inv: (1.0 / basis.k2) as f32,
            chroma_gain: basis.chroma_gain as f32,
            green_gain: basis.green_gain as f32,
            pad: [0; 3],
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let taps = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("lslcd taps"),
        contents: bytemuck::cast_slice(&design()),
        usage: wgpu::BufferUsages::STORAGE,
    });

    macro_rules! plane {
        ($label:expr, $bytes:expr) => {
            recording.buffer(&wgpu::BufferDescriptor {
                label: Some($label),
                size: $bytes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            })
        };
    }
    // Both chroma signals in one plane apiece, interleaved: they are filtered by the same taps over
    // the same sites, so one read of a neighbour serves both.
    let mid = plane!("lslcd modulated", plane_bytes * 2);
    let chroma = plane!("lslcd chroma", plane_bytes * 2);
    let rgb = plane!("lslcd rgb", plane_bytes * 3);
    lap("allocate");

    let plane_group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("lslcd planes"),
        layout: &lslcd.planes,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: taps.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: mid.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: chroma.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: rgb.as_entire_binding() },
        ],
    });

    {
        let mut pass = recording.encoder().begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("lslcd"),
            timestamp_writes: None,
        });
        pass.set_bind_group(0, shape_group, &[]);
        pass.set_bind_group(1, &plane_group, &[]);
        let groups_x = width.div_ceil(8) as u32;
        let groups_y = height.div_ceil(8) as u32;
        // In order: the vertical pass reads what the horizontal one wrote, and a compute pass gives
        // each dispatch a barrier against the last.
        for pipeline in &lslcd.pipelines {
            pass.set_pipeline(pipeline);
            pass.dispatch_workgroups(groups_x, groups_y, 1);
        }
    }

    lap("record");
    Some(crate::demosaic::Recorded { recording, rgb, width, height })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cfa::tests::{XTRANS, parse};

    fn amplitude(taps: &[f32; TAPS], omega: f64) -> f64 {
        basis_at(omega).iter().zip(taps).map(|(phi, tap)| phi * f64::from(*tap)).sum()
    }

    /// §3.2, which is what makes a carrier's leakage zero rather than small.
    ///
    /// Held against the solved coefficients rather than the `f32` the shader reads: the constraints
    /// are exact in the design and a cancellation of seven terms of order one afterwards, so what
    /// survives single precision is a millionth and not a billionth. The test below is the one that
    /// says the rounded taps are still the filter.
    #[test]
    fn the_prototype_nulls_every_carrier_and_passes_dc() {
        let taps = solve_design().expect("the KKT system is solvable");
        let at = |basis: [f64; TAPS]| -> f64 {
            basis.iter().zip(&taps).map(|(phi, tap)| phi * tap).sum()
        };
        assert!((at(basis_at(0.0)) - 1.0).abs() < 1e-12, "DC gain is exactly one");
        assert!(at(basis_at(STOPBAND)).abs() < 1e-12, "the nearest carrier group");
        assert!(at(basis_at(std::f64::consts::PI)).abs() < 1e-12, "the rest");
        assert!(
            at(slope_at(STOPBAND)).abs() < 1e-12,
            "a double zero, so the carrier's neighbourhood goes too"
        );
    }

    /// And that single precision has not undone any of it.
    #[test]
    fn the_rounded_taps_are_still_the_filter() {
        let taps = design();
        assert!((amplitude(&taps, 0.0) - 1.0).abs() < 1e-6);
        assert!(amplitude(&taps, STOPBAND).abs() < 1e-6);
        assert!(amplitude(&taps, std::f64::consts::PI).abs() < 1e-6);
    }

    /// The passband has to be flat enough that chroma is not tilted across its own band, and the
    /// stopband quiet enough that what survives a carrier is not a visible colour.
    #[test]
    fn the_prototype_is_flat_where_chroma_lives_and_quiet_where_it_does_not() {
        let taps = design();
        for step in 0..=32 {
            let omega = PASSBAND * f64::from(step) / 32.0;
            let error = (amplitude(&taps, omega) - 1.0).abs();
            assert!(error < 0.08, "passband ripple at {omega}: {error}");
        }
        for step in 0..=32 {
            let omega = STOPBAND + (std::f64::consts::PI - STOPBAND) * f64::from(step) / 32.0;
            let leak = amplitude(&taps, omega).abs();
            assert!(leak < 0.08, "stopband leak at {omega}: {leak}");
        }
    }

    /// §2.2 read back: the decomposition has to invert, or every colour is wrong by a fixed matrix
    /// nothing downstream can see.
    #[test]
    fn the_decomposition_reconstructs_the_colours_it_was_built_from() {
        for cfa in [parse(XTRANS, 6, 6), Cfa::bayer([0, 1, 1, 2]).unwrap()] {
            let basis = Basis::of(&cfa).expect("a pattern with equal red and blue");
            let [p, q, _] = cfa.counts();
            let n = cfa.slots() as f64;
            for (red, green, blue) in [(0.2, 0.5, 0.7), (1.0, 1.0, 1.0), (0.0, 0.3, 0.9)] {
                let luma = (p as f64 * (red + blue) + q as f64 * green) / n;
                let c1 = red - 2.0 * green + blue;
                let c2 = red - blue;
                let back_g = luma - basis.green_gain * c1;
                let back_r = luma + basis.chroma_gain * c1 + 0.5 * c2;
                let back_b = luma + basis.chroma_gain * c1 - 0.5 * c2;
                assert!((back_r - red).abs() < 1e-12, "{back_r} != {red}");
                assert!((back_g - green).abs() < 1e-12, "{back_g} != {green}");
                assert!((back_b - blue).abs() < 1e-12, "{back_b} != {blue}");
            }
        }
    }

    /// §2.3: both masks have zero mean, they are orthogonal over the period, and their mean squares
    /// are the constants the estimator divides by. Every cross term in §2.5 rests on these.
    #[test]
    fn the_masks_are_orthogonal_and_their_mean_squares_are_the_divisors() {
        for cfa in [parse(XTRANS, 6, 6), Cfa::bayer([0, 1, 1, 2]).unwrap()] {
            let basis = Basis::of(&cfa).unwrap();
            let slots = cfa.slots() as f64;
            let masks: Vec<(f64, f64)> =
                (0..cfa.slots()).map(|i| basis.masks(cfa.colour_of_slot(i))).collect();
            let mean1: f64 = masks.iter().map(|m| m.0).sum::<f64>() / slots;
            let mean2: f64 = masks.iter().map(|m| m.1).sum::<f64>() / slots;
            let cross: f64 = masks.iter().map(|m| m.0 * m.1).sum::<f64>() / slots;
            let square1: f64 = masks.iter().map(|m| m.0 * m.0).sum::<f64>() / slots;
            let square2: f64 = masks.iter().map(|m| m.1 * m.1).sum::<f64>() / slots;
            assert!(mean1.abs() < 1e-12 && mean2.abs() < 1e-12, "neither mask carries DC");
            assert!(cross.abs() < 1e-12, "the two estimates do not share a baseband term");
            assert!((square1 - basis.k1).abs() < 1e-12, "{square1} != {}", basis.k1);
            assert!((square2 - basis.k2).abs() < 1e-12, "{square2} != {}", basis.k2);
        }
    }

    /// The Fourier coefficients of one mask, as §2.4 reads them.
    fn carriers(cfa: &Cfa, which: usize) -> Vec<(usize, usize)> {
        let basis = Basis::of(cfa).unwrap();
        let (period_w, period_h) = cfa.period();
        let mut found = Vec::new();
        for k1 in 0..period_h {
            for k2 in 0..period_w {
                let (mut re, mut im) = (0f64, 0f64);
                for n1 in 0..period_h {
                    for n2 in 0..period_w {
                        let pair = basis.masks(cfa.colour_at(n1, n2));
                        let w = if which == 0 { pair.0 } else { pair.1 };
                        let angle = -2.0
                            * std::f64::consts::PI
                            * ((k1 * n1) as f64 / period_h as f64
                                + (k2 * n2) as f64 / period_w as f64);
                        re += w * angle.cos();
                        im += w * angle.sin();
                    }
                }
                if re.hypot(im) > 1e-9 {
                    found.push((k1, k2));
                }
            }
        }
        found
    }

    /// §2.4's list, which is what the prototype's nulls were placed against.
    #[test]
    fn the_xtrans_carriers_are_the_two_groups_the_specification_names() {
        let cfa = parse(XTRANS, 6, 6);
        assert_eq!(
            carriers(&cfa, 0),
            vec![(0, 2), (0, 4), (2, 0), (2, 2), (2, 4), (4, 0), (4, 2), (4, 4)]
        );
        assert_eq!(carriers(&cfa, 1), vec![(1, 3), (3, 1), (3, 5), (5, 3)]);
    }

    /// **The claim the separable filter rests on, over every phase a body can write.** A translated
    /// pattern is the same pattern to a reader and a different mask to the arithmetic; if one of
    /// them put a carrier at an index the prototype does not null, that body would render with a
    /// colour lattice laid over it and nothing else would notice.
    #[test]
    fn the_carriers_survive_every_phase() {
        let base = parse(XTRANS, 6, 6);
        for down in 0..6 {
            for across in 0..6 {
                let colours: Vec<u8> = (0..6)
                    .flat_map(|r| (0..6).map(move |c| (r, c)))
                    .map(|(r, c)| base.colour_at(r + down, c + across))
                    .collect();
                let shifted = Cfa::new(6, 6, &colours).unwrap();
                assert!(shifted.is_xtrans(), "a translation is still X-Trans");
                for which in 0..2 {
                    for (k1, k2) in carriers(&shifted, which) {
                        let nulled = |k: usize| matches!(k, 2 | 3 | 4);
                        assert!(
                            nulled(k1) || nulled(k2),
                            "phase ({down},{across}) carries ({k1},{k2}), which the prototype passes"
                        );
                    }
                }
            }
        }
    }

    /// A pattern with more red than blue has no orthogonal pair of masks, so it is turned away
    /// rather than rendered with each chroma estimate carrying a share of the other.
    #[test]
    fn a_pattern_with_unequal_red_and_blue_is_refused() {
        assert_eq!(Basis::of(&Cfa::new(2, 2, &[0, 0, 1, 2]).unwrap()), None);
    }
}
