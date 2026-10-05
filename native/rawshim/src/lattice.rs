//! The chroma lattice as a match carries it: a list of kernels, baked on the device into the two
//! volumes `colour.slang`'s `correct` samples (`slang/lattice_bake.slang`).
//!
//! A kernel is a place in the lattice's coordinates (`index_space.slang`'s `lattice_at`: hue in
//! turns, the square root of chroma, lightness, the square root of the neighbourhood), how far it
//! reaches along each axis, and the operator it applies there as a generator. Where kernels overlap
//! their generators add, and the bake exponentiates the sum per texel.

use crate::gpu::{Gpu, Texture};
use crate::light::{Light, Rendered};

/// Floats a kernel occupies on the device, as `lattice_bake.slang` reads them.
pub const KERNEL_WORDS: usize = 17;

/// Words ahead of the kernels in [`ChromaMap::words`]: the space and the four axis ends.
pub const HEAD_WORDS: usize = 5;

/// Texels along the baked volumes' axes. Hue carries one more than its bins: the last is a copy
/// of the first, so the wrap needs no sampler of its own.
pub const HUE_TEXELS: usize = 73;
pub const CHROMA_TEXELS: usize = 25;
pub const LEVEL_TEXELS: usize = 33;
pub const NEIGHBOURHOOD_TEXELS: usize = 3;

/// Rec.2020's own red at diffuse white, the most chroma a lattice axis needs to reach.
pub const WHITE_RED: [Light<Rendered>; 3] = [Light::measured(1.0), Light::ZERO, Light::ZERO];

/// Generator magnitude below which a kernel changes nothing a half float can hold.
const NEGLIGIBLE: f64 = 1e-4;

/// Where the lattice is indexed (`index_space.slang`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndexSpace {
    Jzazbz,
    Ictcp,
}

impl IndexSpace {
    /// `BOWERBIRD_LATTICE_SPACE=ictcp` fits in ICtCp, for comparing the two.
    pub fn chosen() -> IndexSpace {
        match std::env::var("BOWERBIRD_LATTICE_SPACE").as_deref() {
            Ok("ictcp") => IndexSpace::Ictcp,
            _ => IndexSpace::Jzazbz,
        }
    }

    pub fn word(self) -> u32 {
        match self {
            IndexSpace::Jzazbz => 0,
            IndexSpace::Ictcp => 1,
        }
    }

    pub fn from_word(word: u32) -> Option<IndexSpace> {
        match word {
            0 => Some(IndexSpace::Jzazbz),
            1 => Some(IndexSpace::Ictcp),
            _ => None,
        }
    }

    /// A rendered colour's lightness and two opponent axes, as `index_space.slang`'s
    /// `opponent_of` has them: for sizing the lattice's axes off a handful of colours.
    pub fn opponent_of(self, rendered: [Light<Rendered>; 3]) -> [f64; 3] {
        let coded = |nits: f64, p: f64| {
            let y = (nits.max(0.0) / 10000.0).powf(PQ_M1);
            ((PQ_C1 + PQ_C2 * y) / (1.0 + PQ_C3 * y)).powf(p)
        };
        let apply = |m: &[[f64; 3]; 3], v: [f64; 3]| -> [f64; 3] {
            std::array::from_fn(|r| (0..3).map(|c| m[r][c] * v[c]).sum())
        };
        let nits = rendered.map(|v| v.raw() * INDEX_WHITE_NITS);
        match self {
            IndexSpace::Ictcp => apply(
                &ICTCP_LMS_TO_ITP,
                apply(&R2020_TO_ICTCP_LMS, nits).map(|v| coded(v, PQ_M2)),
            ),
            IndexSpace::Jzazbz => {
                let iab = apply(
                    &JZ_LMS_TO_IAB,
                    apply(&R2020_TO_JZ_LMS, nits).map(|v| coded(v, JZ_P)),
                );
                let jz = (1.0 + JZ_D) * iab[0] / (1.0 + JZ_D * iab[0]) - JZ_D0;
                [jz, iab[1], iab[2]]
            }
        }
    }

    /// The lightness a neutral at `level` of `Rendered` takes.
    pub fn lightness_of_neutral(self, level: Light<Rendered>) -> f64 {
        self.opponent_of([level; 3])[0]
    }

    /// The chroma of a colour, which sizes how far the lattice's chroma axis reaches.
    pub fn chroma_of(self, rendered: [Light<Rendered>; 3]) -> f64 {
        let [_, a, b] = self.opponent_of(rendered);
        a.hypot(b)
    }
}

/// `index_space.slang`'s constants, which `hdr_fit`'s `the_span_picks_the_samples_a_sort_would`
/// holds to the shader's in both spaces.
pub const INDEX_WHITE_NITS: f64 = 203.0;
const PQ_M1: f64 = 0.1593017578125;
const PQ_M2: f64 = 78.84375;
const PQ_C1: f64 = 0.8359375;
const PQ_C2: f64 = 18.8515625;
const PQ_C3: f64 = 18.6875;
const JZ_P: f64 = 134.034375;
const JZ_D: f64 = -0.56;
const JZ_D0: f64 = 1.6295499532821566e-11;
const R2020_TO_JZ_LMS: [[f64; 3]; 3] = [
    [0.530003576, 0.355703633, 0.086089990],
    [0.289388269, 0.525394823, 0.157481505],
    [0.091098083, 0.147587582, 0.734233807],
];
const JZ_LMS_TO_IAB: [[f64; 3]; 3] = [
    [0.5, 0.5, 0.0],
    [3.524000000, -4.066708000, 0.542708000],
    [0.199076000, 1.096799000, -1.295875000],
];
const R2020_TO_ICTCP_LMS: [[f64; 3]; 3] = [
    [0.412109375, 0.523925781, 0.063964844],
    [0.166748047, 0.720458984, 0.112792969],
    [0.024169922, 0.075439453, 0.900390625],
];
const ICTCP_LMS_TO_ITP: [[f64; 3]; 3] = [
    [0.5, 0.5, 0.0],
    [1.613769531, -3.323486328, 1.709716797],
    [4.378173828, -4.245605469, -0.132568359],
];

/// One place's correction.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Kernel {
    /// Hue in turns, √chroma, lightness, √neighbourhood.
    pub centre: [f64; 4],
    /// Along the same axes. Zero on an axis the kernel does not depend on.
    pub reach: [f64; 4],
    /// The operator's matrix log, on `(d0, d2, l)`: the 2x2 `[a, b, c, d]`, the tint each chroma
    /// axis takes from lightness `[e, f]`, and the lightness term `g`.
    pub generator: [f64; 7],
    /// Lightness per unit chromaticity on each chroma axis, added to the lightness gain.
    pub to_lightness: [f64; 2],
}

impl Kernel {
    fn words(&self) -> [f32; KERNEL_WORDS] {
        let mut out = [0.0f32; KERNEL_WORDS];
        let values = self
            .centre
            .iter()
            .chain(&self.reach)
            .chain(&self.generator)
            .chain(&self.to_lightness);
        for (slot, value) in out.iter_mut().zip(values) {
            *slot = *value as f32;
        }
        out
    }

    fn from_words(words: &[f64]) -> Kernel {
        Kernel {
            centre: std::array::from_fn(|k| words[k]),
            reach: std::array::from_fn(|k| words[4 + k]),
            generator: std::array::from_fn(|k| words[8 + k]),
            to_lightness: std::array::from_fn(|k| words[15 + k]),
        }
    }

    fn negligible(&self) -> bool {
        self.generator
            .iter()
            .chain(&self.to_lightness)
            .all(|v| v.abs() < NEGLIGIBLE)
    }
}

/// Where the baked volumes' axes end, in lattice coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LutAxes {
    pub chroma_top: f64,
    pub level_low: f64,
    pub level_top: f64,
    pub neighbourhood_top: f64,
}

/// The constants `colour.slang`'s `correct` reads the baked volumes with.
pub struct MapShape {
    pub hue_count: usize,
    pub chroma_count: usize,
    pub level_count: usize,
    pub neighbourhood_count: usize,
    pub chroma_scale: f64,
    pub level_low: f64,
    pub level_scale: f64,
    pub neighbourhood_scale: f64,
    pub space: IndexSpace,
}

/// Floats a texel of [`Summed`] holds, as `lattice_bake.slang`'s `sum` writes them.
const SUM_WORDS: usize = 9;

/// A kernel set's generators summed per texel over `axes`, once a device has asked: shared by
/// every map that scales or joins the set, so its kernels are walked once.
struct Summed {
    kernels: Vec<Kernel>,
    axes: LutAxes,
    on: std::sync::OnceLock<(u64, crate::gpu::Buffer)>,
}

impl Summed {
    fn new(kernels: Vec<Kernel>, axes: LutAxes) -> std::sync::Arc<Summed> {
        std::sync::Arc::new(Summed {
            kernels,
            axes,
            on: std::sync::OnceLock::new(),
        })
    }

    fn buffer(&self, gpu: &Gpu) -> crate::gpu::Buffer {
        let (on, buffer) = self.on.get_or_init(|| (gpu.id(), sum(gpu, self)));
        match *on == gpu.id() {
            true => buffer.clone(),
            false => sum(gpu, self),
        }
    }
}

#[derive(Clone)]
pub struct ChromaMap {
    space: IndexSpace,
    kernels: Vec<Kernel>,
    axes: LutAxes,
    /// What the bake exponentiates: one or two summed kernel sets, each scaled.
    terms: Vec<(std::sync::Arc<Summed>, f64)>,
    /// The volumes this map bakes to, once a device has asked, and that device's `Gpu::id`.
    /// Shared by clones, which are the same map; a changed map is a new value and bakes afresh.
    baked: std::sync::Arc<std::sync::OnceLock<(u64, (Texture, Texture))>>,
}

impl PartialEq for ChromaMap {
    fn eq(&self, other: &ChromaMap) -> bool {
        self.space == other.space && self.kernels == other.kernels && self.axes == other.axes
    }
}

impl std::fmt::Debug for ChromaMap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChromaMap")
            .field("space", &self.space)
            .field("kernels", &self.kernels.len())
            .field("axes", &self.axes)
            .finish()
    }
}

impl ChromaMap {
    /// The map that changes nothing, for a caller with no fit yet.
    pub fn identity() -> ChromaMap {
        let space = IndexSpace::Jzazbz;
        ChromaMap::new(
            space,
            Vec::new(),
            LutAxes {
                chroma_top: space.chroma_of(WHITE_RED).sqrt(),
                level_low: space.lightness_of_neutral(Light::ZERO),
                level_top: space.lightness_of_neutral(Light::measured(1.0)),
                neighbourhood_top: 1.0,
            },
        )
    }

    /// The map that does exactly what the saturation scalar does: one kernel everywhere, scaling
    /// chroma about the grey axis. The lattice is a strict generalisation of the scalar.
    pub fn from_saturation(saturation: f64) -> ChromaMap {
        let log = saturation.ln();
        ChromaMap::with_kernels(vec![Kernel {
            centre: [0.0; 4],
            reach: [0.0; 4],
            generator: [log, 0.0, 0.0, log, 0.0, 0.0, 0.0],
            to_lightness: [0.0; 2],
        }])
    }

    /// `kernels` over the identity's axes, for fixtures and tests.
    pub fn with_kernels(kernels: Vec<Kernel>) -> ChromaMap {
        let identity = ChromaMap::identity();
        ChromaMap::new(identity.space, kernels, identity.axes)
    }

    /// Kernels whose generators are too small to change a texel are left out.
    pub fn new(space: IndexSpace, kernels: Vec<Kernel>, axes: LutAxes) -> ChromaMap {
        let kernels: Vec<Kernel> = kernels.into_iter().filter(|k| !k.negligible()).collect();
        let terms = vec![(Summed::new(kernels.clone(), axes), 1.0)];
        ChromaMap::baking(space, kernels, axes, terms)
    }

    fn baking(
        space: IndexSpace,
        kernels: Vec<Kernel>,
        axes: LutAxes,
        terms: Vec<(std::sync::Arc<Summed>, f64)>,
    ) -> ChromaMap {
        ChromaMap {
            space,
            kernels: kernels.into_iter().filter(|k| !k.negligible()).collect(),
            axes,
            terms,
            baked: Default::default(),
        }
    }

    pub fn space(&self) -> IndexSpace {
        self.space
    }

    pub fn kernels(&self) -> &[Kernel] {
        &self.kernels
    }

    pub fn axes(&self) -> LutAxes {
        self.axes
    }

    /// Every kernel keeping `strength` of its correction: exact in the generators, where scaling
    /// a rotation scales its angle.
    pub fn at_strength(&self, strength: f64) -> ChromaMap {
        let kernels = self
            .kernels
            .iter()
            .map(|k| Kernel {
                generator: k.generator.map(|g| g * strength),
                to_lightness: k.to_lightness.map(|t| t * strength),
                ..*k
            })
            .collect();
        let terms = self
            .terms
            .iter()
            .map(|(summed, by)| (summed.clone(), by * strength))
            .collect();
        ChromaMap::baking(self.space, kernels, self.axes, terms)
    }

    /// Both maps' kernels in one, read over this one's axes.
    pub fn joined(&self, other: &ChromaMap) -> ChromaMap {
        let kernels: Vec<Kernel> = self.kernels.iter().chain(&other.kernels).copied().collect();
        let theirs = match other.axes == self.axes {
            true => other.terms.clone(),
            false => vec![(Summed::new(other.kernels.clone(), self.axes), 1.0)],
        };
        let mut terms: Vec<_> = self.terms.iter().cloned().chain(theirs).collect();
        if terms.len() > 2 {
            terms = vec![(Summed::new(kernels.clone(), self.axes), 1.0)];
        }
        ChromaMap::baking(self.space, kernels, self.axes, terms)
    }

    pub fn shape(&self) -> MapShape {
        let axes = self.axes;
        MapShape {
            hue_count: HUE_TEXELS,
            chroma_count: CHROMA_TEXELS,
            level_count: LEVEL_TEXELS,
            neighbourhood_count: NEIGHBOURHOOD_TEXELS,
            chroma_scale: (CHROMA_TEXELS - 1) as f64 / axes.chroma_top.max(1e-6),
            level_low: axes.level_low,
            level_scale: (LEVEL_TEXELS - 1) as f64 / (axes.level_top - axes.level_low).max(1e-6),
            neighbourhood_scale: (NEIGHBOURHOOD_TEXELS - 1) as f64
                / axes.neighbourhood_top.max(1e-6),
            space: self.space,
        }
    }

    /// The map as words: `HEAD_WORDS` of space and axes, then the kernels.
    pub fn words(&self) -> Vec<f64> {
        let mut out = vec![
            f64::from(self.space.word()),
            self.axes.chroma_top,
            self.axes.level_low,
            self.axes.level_top,
            self.axes.neighbourhood_top,
        ];
        for kernel in &self.kernels {
            out.extend(kernel.words().map(f64::from));
        }
        out
    }

    pub fn from_words(words: &[f64]) -> Option<ChromaMap> {
        let (head, rest) = words.split_at_checked(HEAD_WORDS)?;
        if rest.len() % KERNEL_WORDS != 0 {
            return None;
        }
        let space = IndexSpace::from_word(head[0] as u32)?;
        let axes = LutAxes {
            chroma_top: head[1],
            level_low: head[2],
            level_top: head[3],
            neighbourhood_top: head[4],
        };
        let kernels = rest
            .chunks_exact(KERNEL_WORDS)
            .map(Kernel::from_words)
            .collect();
        Some(ChromaMap::new(space, kernels, axes))
    }

    /// This map as a sidecar hands it back: the head in `f32` and the kernels in `f16`.
    pub fn stored(&self) -> ChromaMap {
        let words: Vec<f64> = self
            .words()
            .iter()
            .enumerate()
            .map(|(k, v)| match k < HEAD_WORDS {
                true => f64::from(*v as f32),
                false => f64::from(half::f16::from_f64(*v)),
            })
            .collect();
        ChromaMap::from_words(&words).expect("a map's own words read back")
    }

    /// The two volumes `correct` samples, baked once per map and device.
    pub fn baked(&self, gpu: &Gpu) -> (Texture, Texture) {
        let (baked_on, volumes) = self.baked.get_or_init(|| (gpu.id(), bake(gpu, self)));
        match *baked_on == gpu.id() {
            true => volumes.clone(),
            false => bake(gpu, self),
        }
    }
}

/// An operator on `(d0, d2, l)` as its generator: `[a, b, c, d, e, f, g]` for the matrix
/// `[[a, b, e], [c, d, f], [0, 0, g]]`, logged.
///
/// Inverse scaling and squaring: square roots until the matrix is near the identity, the log's
/// series there, then doubled back. A matrix with no real log - a node solved to a reflection -
/// falls back to its first-order generator, `A - I`.
pub fn generator_of(node: [f64; 7]) -> [f64; 7] {
    let a = matrix_of(node);
    let first_order = sub(a, IDENTITY);
    let mut x = a;
    let mut halvings = 0;
    while norm(sub(x, IDENTITY)) > 0.25 {
        if halvings == 24 {
            return node_of(first_order);
        }
        match square_root(x) {
            Some(root) => x = root,
            None => return node_of(first_order),
        }
        halvings += 1;
    }
    let y = sub(x, IDENTITY);
    let mut term = y;
    let mut log = [[0.0; 3]; 3];
    for n in 1..=24 {
        let sign = if n % 2 == 1 { 1.0 } else { -1.0 };
        log = add(log, scale(term, sign / n as f64));
        term = mul(term, y);
    }
    let out = scale(log, (1u64 << halvings) as f64);
    match out.iter().flatten().all(|v| v.is_finite()) {
        true => node_of(out),
        false => node_of(first_order),
    }
}

/// [`generator_of`] undone: the operator a generator exponentiates to, as the bake computes it.
pub fn operator_of(generator: [f64; 7]) -> [f64; 7] {
    let g = matrix_of(generator);
    let halvings = (norm(g).max(1e-12).log2().ceil() as i32 + 3).clamp(0, 16);
    let x = scale(g, 1.0 / f64::from(1u32 << halvings));
    let mut term = IDENTITY;
    let mut sum = IDENTITY;
    for n in 1..=12 {
        term = scale(mul(term, x), 1.0 / n as f64);
        sum = add(sum, term);
    }
    for _ in 0..halvings {
        sum = mul(sum, sum);
    }
    node_of(sum)
}

type M3 = [[f64; 3]; 3];
const IDENTITY: M3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

fn matrix_of([a, b, c, d, e, f, g]: [f64; 7]) -> M3 {
    [[a, b, e], [c, d, f], [0.0, 0.0, g]]
}

fn node_of(m: M3) -> [f64; 7] {
    [
        m[0][0], m[0][1], m[1][0], m[1][1], m[0][2], m[1][2], m[2][2],
    ]
}

fn mul(x: M3, y: M3) -> M3 {
    std::array::from_fn(|i| std::array::from_fn(|j| (0..3).map(|k| x[i][k] * y[k][j]).sum()))
}

fn add(x: M3, y: M3) -> M3 {
    std::array::from_fn(|i| std::array::from_fn(|j| x[i][j] + y[i][j]))
}

fn sub(x: M3, y: M3) -> M3 {
    std::array::from_fn(|i| std::array::from_fn(|j| x[i][j] - y[i][j]))
}

fn scale(x: M3, by: f64) -> M3 {
    x.map(|row| row.map(|v| v * by))
}

fn norm(x: M3) -> f64 {
    x.iter()
        .map(|row| row.iter().map(|v| v.abs()).sum::<f64>())
        .fold(0.0, f64::max)
}

fn inverse(m: M3) -> Option<M3> {
    let [[a, b, c], [d, e, f], [g, h, i]] = m;
    let (ca, cb, cc) = (e * i - f * h, f * g - d * i, d * h - e * g);
    let det = a * ca + b * cb + c * cc;
    if det.abs() < 1e-300 || !det.is_finite() {
        return None;
    }
    Some([
        [ca / det, (c * h - b * i) / det, (b * f - c * e) / det],
        [cb / det, (a * i - c * g) / det, (c * d - a * f) / det],
        [cc / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ])
}

/// Denman-Beavers: the principal square root, where one exists.
fn square_root(a: M3) -> Option<M3> {
    let (mut y, mut z) = (a, IDENTITY);
    for _ in 0..64 {
        let (yi, zi) = (inverse(y)?, inverse(z)?);
        let next = scale(add(y, zi), 0.5);
        z = scale(add(z, yi), 0.5);
        let moved = norm(sub(next, y));
        y = next;
        if moved < 1e-15 {
            break;
        }
    }
    let squared = mul(y, y);
    match norm(sub(squared, a)) < 1e-9 * norm(a).max(1.0) {
        true => Some(y),
        false => None,
    }
}

pub(crate) struct BakeKernel {
    sum_layout: wgpu::BindGroupLayout,
    sum: wgpu::ComputePipeline,
    bake_layout: wgpu::BindGroupLayout,
    bake: wgpu::ComputePipeline,
}

impl BakeKernel {
    pub(crate) fn new(device: crate::gpu::Describing<'_>) -> BakeKernel {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("lattice_bake"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/lattice_bake.wgsl")).into(),
            ),
        });
        let storage = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::StorageTexture {
                access: wgpu::StorageTextureAccess::WriteOnly,
                format: wgpu::TextureFormat::Rgba16Float,
                view_dimension: wgpu::TextureViewDimension::D3,
            },
            count: None,
        };
        let buffer = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
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
        let pipeline = |entries: &[wgpu::BindGroupLayoutEntry], entry: &str| {
            let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some(entry),
                entries,
            });
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(entry),
                bind_group_layouts: &[Some(&layout)],
                immediate_size: 0,
            });
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            });
            (layout, pipeline)
        };
        let (sum_layout, sum) = pipeline(
            &[
                buffer(0, read),
                buffer(3, wgpu::BufferBindingType::Storage { read_only: false }),
                buffer(20, wgpu::BufferBindingType::Uniform),
            ],
            "sum",
        );
        let (bake_layout, bake) = pipeline(
            &[
                buffer(4, read),
                buffer(5, read),
                storage(1),
                storage(2),
                buffer(20, wgpu::BufferBindingType::Uniform),
            ],
            "bake",
        );
        BakeKernel {
            sum_layout,
            sum,
            bake_layout,
            bake,
        }
    }
}

const SIZE: wgpu::Extent3d = wgpu::Extent3d {
    width: HUE_TEXELS as u32,
    height: CHROMA_TEXELS as u32,
    // Lightness and neighbourhood packed into depth, neighbourhood-major: `correct` samples one
    // neighbourhood slab at a time, so hardware filtering never crosses the seam between them.
    depth_or_array_layers: (LEVEL_TEXELS * NEIGHBOURHOOD_TEXELS) as u32,
};

/// `lattice_bake.slang`'s `Params`.
fn params(kernels: usize, space: IndexSpace, axes: LutAxes, scales: [f64; 2]) -> Vec<u8> {
    let mut push: Vec<u8> = [
        kernels as u32,
        space.word(),
        HUE_TEXELS as u32,
        CHROMA_TEXELS as u32,
        LEVEL_TEXELS as u32,
        NEIGHBOURHOOD_TEXELS as u32,
    ]
    .iter()
    .flat_map(|v| v.to_ne_bytes())
    .collect();
    for v in [
        axes.chroma_top,
        axes.level_low,
        axes.level_top,
        axes.neighbourhood_top,
        scales[0],
        scales[1],
    ] {
        push.extend((v as f32).to_ne_bytes());
    }
    push
}

fn dispatch(
    recording: &mut crate::gpu::Recording<'_>,
    pipeline: &wgpu::ComputePipeline,
    group: &wgpu::BindGroup,
) {
    let mut pass = recording.encoder().begin_compute_pass(&Default::default());
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, group, &[]);
    pass.dispatch_workgroups(
        SIZE.width.div_ceil(4),
        SIZE.height.div_ceil(4),
        SIZE.depth_or_array_layers.div_ceil(4),
    );
}

fn sum(gpu: &Gpu, summed: &Summed) -> crate::gpu::Buffer {
    let texels = (SIZE.width * SIZE.height * SIZE.depth_or_array_layers) as usize;
    let out = gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some("lattice sums"),
        size: (texels * SUM_WORDS * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    let mut recording = gpu.record();
    recording.holding(&out);
    let mut words: Vec<u8> = summed
        .kernels
        .iter()
        .flat_map(|k| k.words())
        .flat_map(|v| v.to_ne_bytes())
        .collect();
    if words.is_empty() {
        words.resize(KERNEL_WORDS * 4, 0);
    }
    let kernels = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("lattice kernels"),
        contents: &words,
        usage: wgpu::BufferUsages::STORAGE,
    });
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("lattice_bake push"),
        contents: &params(
            summed.kernels.len(),
            IndexSpace::Jzazbz,
            summed.axes,
            [0.0; 2],
        ),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let built = gpu.lattice_bake();
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("lattice_bake sum"),
        layout: &built.sum_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: kernels.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: out.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 20,
                resource: push.as_entire_binding(),
            },
        ],
    });
    dispatch(&mut recording, &built.sum, &group);
    recording.submit();
    out
}

fn bake(gpu: &Gpu, map: &ChromaMap) -> (Texture, Texture) {
    let volume = |label: &'static str| {
        gpu.own_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: SIZE,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        })
    };
    let (first, first_scale) = &map.terms[0];
    let first = first.buffer(gpu);
    let (second, second_scale) = match map.terms.get(1) {
        Some((summed, by)) => (summed.buffer(gpu), *by),
        None => (first.clone(), 0.0),
    };
    let (chroma, luma) = (volume("chroma"), volume("chroma_luma"));
    let mut recording = gpu.record();
    recording.holding_texture(&chroma);
    recording.holding_texture(&luma);
    recording.holding(&first);
    recording.holding(&second);
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("lattice_bake push"),
        contents: &params(
            map.kernels.len(),
            map.space,
            map.axes,
            [*first_scale, second_scale],
        ),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let (chroma_view, luma_view) = (chroma.view(), luma.view());
    let built = gpu.lattice_bake();
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("lattice_bake"),
        layout: &built.bake_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 4,
                resource: first.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: second.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&chroma_view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::TextureView(&luma_view),
            },
            wgpu::BindGroupEntry {
                binding: 20,
                resource: push.as_entire_binding(),
            },
        ],
    });
    dispatch(&mut recording, &built.bake, &group);
    recording.submit();
    (chroma, luma)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_reads_a_kernel_as_the_bake_does() {
        const SOURCE: &str = include_str!("../../../slang/lattice_bake.slang");
        let line = format!("static const uint KERNEL_WORDS = {KERNEL_WORDS};");
        assert!(
            SOURCE.contains(&line),
            "lattice_bake.slang does not say `{line}`"
        );
    }

    #[test]
    fn a_generator_exponentiates_back_to_its_operator() {
        for node in [
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            [1.2, 0.05, -0.03, 0.9, 0.01, -0.02, 1.1],
            // A quarter turn of hue at unit saturation, which has no first-order answer.
            [0.0, -1.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            [0.4, 0.3, -0.2, 1.6, 0.05, 0.04, 0.7],
        ] {
            let back = operator_of(generator_of(node));
            for (a, b) in node.iter().zip(back) {
                assert!((a - b).abs() < 1e-9, "{node:?} came back {back:?}");
            }
        }
    }

    #[test]
    fn half_a_rotation_turns_half_the_angle() {
        let quarter = generator_of([0.0, -1.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        let eighth = operator_of(quarter.map(|g| g * 0.5));
        let s = std::f64::consts::FRAC_1_SQRT_2;
        for (got, want) in eighth.iter().zip([s, -s, s, s, 0.0, 0.0, 1.0]) {
            assert!((got - want).abs() < 1e-9, "{eighth:?}");
        }
    }

    #[test]
    fn a_map_reads_back_from_its_words() {
        let map = ChromaMap::new(
            IndexSpace::Ictcp,
            vec![Kernel {
                centre: [0.25, 0.1, 0.12, 0.5],
                reach: [1.0 / 12.0, 0.05, 0.03, 0.4],
                generator: [0.1, 0.02, -0.01, 0.05, 0.003, -0.002, 0.04],
                to_lightness: [0.01, -0.02],
            }],
            LutAxes {
                chroma_top: 0.2,
                level_low: 0.0,
                level_top: 0.35,
                neighbourhood_top: 1.1,
            },
        )
        .stored();
        assert_eq!(ChromaMap::from_words(&map.words()), Some(map));
    }

    /// Kernels scattered over the whole lattice at every reach, so most workgroups cull most of
    /// them: every texel still holds what the sum over every kernel says.
    #[test]
    fn the_bake_sums_every_kernel_that_reaches_a_texel() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let axes = ChromaMap::identity().axes;
        let mut seed = 3u64;
        let mut next = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) as f64 / (1u64 << 31) as f64
        };
        let span = [
            1.0,
            axes.chroma_top,
            axes.level_top - axes.level_low,
            axes.neighbourhood_top,
        ];
        let kernels: Vec<Kernel> = (0..600)
            .map(|k| Kernel {
                centre: [
                    next(),
                    axes.chroma_top * next(),
                    axes.level_low + span[2] * next(),
                    axes.neighbourhood_top * next(),
                ],
                reach: std::array::from_fn(|axis| match (k + axis) % 7 {
                    0 => 0.0,
                    _ => span[axis] * (0.02 + 0.3 * next()),
                }),
                generator: std::array::from_fn(|_| 0.2 * (next() - 0.5)),
                to_lightness: [0.0; 2],
            })
            .collect();
        let map = ChromaMap::with_kernels(kernels);
        let (chroma, _) = map.baked(gpu);

        let depth = LEVEL_TEXELS * NEIGHBOURHOOD_TEXELS;
        let row = (HUE_TEXELS * 8).next_multiple_of(256);
        let mut recording = gpu.record();
        let staged = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("baked readback"),
            size: (row * CHROMA_TEXELS * depth) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        recording.encoder().copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &chroma,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &staged,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row as u32),
                    rows_per_image: Some(CHROMA_TEXELS as u32),
                },
            },
            chroma.size(),
        );
        recording.submit();
        let texels = pollster::block_on(crate::gpu::read_back(gpu, &staged, |b| b.to_vec()))
            .expect("read back");

        let tent = |d: f64, reach: f64| -> f64 {
            if reach <= 0.0 {
                return 1.0;
            }
            let u = 1.0 - (d.abs() / reach).min(1.0);
            u * u * u * (u * (u * 6.0 - 15.0) + 10.0)
        };
        let mut worst: f64 = 0.0;
        for z in 0..depth {
            for y in 0..CHROMA_TEXELS {
                for x in 0..HUE_TEXELS {
                    let (level, neighbourhood) = (z % LEVEL_TEXELS, z / LEVEL_TEXELS);
                    let at = [
                        x as f64 / (HUE_TEXELS - 1) as f64,
                        axes.chroma_top * y as f64 / (CHROMA_TEXELS - 1) as f64,
                        axes.level_low + span[2] * level as f64 / (LEVEL_TEXELS - 1) as f64,
                        axes.neighbourhood_top * neighbourhood as f64
                            / (NEIGHBOURHOOD_TEXELS - 1) as f64,
                    ];
                    let mut sum = [0.0; 7];
                    for k in map.kernels() {
                        let mut turns = (at[0] - k.centre[0]).abs();
                        turns = turns.min(1.0 - turns);
                        if k.centre[1] < k.reach[1] {
                            turns *= (at[1] / k.centre[1].max(1e-6)).clamp(0.0, 1.0);
                        }
                        let w = tent(turns, k.reach[0])
                            * (1..4)
                                .map(|a| tent(at[a] - k.centre[a], k.reach[a]))
                                .product::<f64>();
                        for (s, g) in sum.iter_mut().zip(k.generator) {
                            *s += w * g;
                        }
                    }
                    let want = operator_of(sum);
                    let at = (z * CHROMA_TEXELS + y) * row + x * 8;
                    for (c, want) in want[..4].iter().enumerate() {
                        let got = f64::from(half::f16::from_le_bytes([
                            texels[at + 2 * c],
                            texels[at + 2 * c + 1],
                        ]));
                        worst = worst.max((got - want).abs() / want.abs().max(1.0));
                    }
                }
            }
        }
        assert!(
            worst < 2e-3,
            "a texel is {worst} off the sum over every kernel"
        );
    }

    #[test]
    fn white_sits_where_each_space_puts_it() {
        // Jzazbz puts 100 nits of D65 near 0.167 lightness; ICtCp's I at 203 nits is PQ of 203.
        let jz = IndexSpace::Jzazbz.lightness_of_neutral(Light::measured(100.0 / INDEX_WHITE_NITS));
        assert!((jz - 0.167).abs() < 0.01, "{jz}");
        let i = IndexSpace::Ictcp.lightness_of_neutral(Light::measured(1.0));
        assert!((i - 0.58).abs() < 0.01, "{i}");
    }
}
