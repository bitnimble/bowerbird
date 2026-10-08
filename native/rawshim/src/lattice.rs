//! The chroma lattice as a match carries it: a list of kernels, baked on the device into the two
//! volumes `colour.slang`'s `correct` samples (`slang/lattice_bake.slang`).
//!
//! A kernel is a place in the lattice's coordinates (`index_space.slang`'s `lattice_at`: hue in
//! turns, the square root of chroma, lightness, the square root of the neighbourhood), how far it
//! reaches along each axis, and the operator it applies there as a generator. Where kernels overlap
//! their generators add, and the bake exponentiates the sum per texel.

use crate::gpu::{Gpu, Texture};
use crate::light::{Light, Rendered};
use crate::tone;

/// Floats a kernel occupies on the device, as `lattice_bake.slang` reads them.
pub const KERNEL_WORDS: usize = 17;

/// Words ahead of the kernels in [`ChromaMap::words`]: the four axis ends.
pub const HEAD_WORDS: usize = 4;

/// Texels along the baked volumes' axes. Hue carries one more than its bins: the last is a copy
/// of the first, so the wrap needs no sampler of its own.
pub const HUE_TEXELS: usize = 73;
pub const CHROMA_TEXELS: usize = 25;
pub const LEVEL_TEXELS: usize = 33;
pub const NEIGHBOURHOOD_TEXELS: usize = 3;

/// The chroma of Rec.2020's widest primary at diffuse white, the most a lattice axis needs to reach.
pub fn widest_chroma() -> f64 {
    (0..3)
        .map(|c| {
            chroma_of(std::array::from_fn(|k| match k == c {
                true => Light::measured(1.0),
                false => Light::ZERO,
            }))
        })
        .fold(0.0, f64::max)
}

/// Generator magnitude below which a kernel changes nothing a half float can hold.
const NEGLIGIBLE: f64 = 1e-4;

/// A rendered colour as ZCAM sees it, as `index_space.slang`'s `opponent_of` has it: lightness,
/// then chroma laid along its hue.
pub fn opponent_of(rendered: [Light<Rendered>; 3]) -> [f64; 3] {
    let zcam = Zcam::pinned();
    let [m, a, b] = iab_of(rendered.map(|v| v.raw() * INDEX_WHITE_NITS));
    let lightness = zcam.lightness(m - ZCAM_EPSILON);
    let ab = a.hypot(b);
    if ab == 0.0 {
        return [lightness, 0.0, 0.0];
    }
    let hue = [a / ab, b / ab];
    let chroma = zcam.chroma(ab, hue);
    [lightness, chroma * hue[0], chroma * hue[1]]
}

/// The lightness a neutral at `level` of `Rendered` takes.
pub fn lightness_of_neutral(level: Light<Rendered>) -> f64 {
    opponent_of([level; 3])[0]
}

pub fn chroma_of(rendered: [Light<Rendered>; 3]) -> f64 {
    let [_, a, b] = opponent_of(rendered);
    a.hypot(b)
}

/// Inverse of [`opponent_of`].
pub fn rendered_of([lightness, x, y]: [f64; 3]) -> [Light<Rendered>; 3] {
    let zcam = Zcam::pinned();
    let iz = zcam.white_iz * (lightness.max(0.0) / 100.0).powf(1.0 / zcam.lightness_exponent);
    let chroma = x.hypot(y);
    let hue = match chroma > 0.0 {
        true => [x / chroma, y / chroma],
        false => [1.0, 0.0],
    };
    let ab = (chroma / (zcam.chroma_scale * eccentricity(hue).powf(0.068))).powf(50.0 / 37.0);
    let uncoded = |code: f64| {
        let e = code.max(0.0).powf(1.0 / ZCAM_P);
        10000.0 * ((e - tone::C1).max(0.0) / (tone::C2 - tone::C3 * e)).powf(1.0 / tone::M1)
    };
    let cones = apply(
        inverse(LMS_TO_IAB).expect("invertible"),
        [iz + ZCAM_EPSILON, ab * hue[0], ab * hue[1]],
    );
    apply(
        inverse(R2020_TO_LMS).expect("invertible"),
        cones.map(uncoded),
    )
    .map(|nits| Light::measured(nits / INDEX_WHITE_NITS))
}

/// `Iz` still carrying `ZCAM_EPSILON`, `az`, `bz`.
fn iab_of(nits: [f64; 3]) -> [f64; 3] {
    let coded = |nits: f64| {
        let y = (nits.max(0.0) / 10000.0).powf(tone::M1);
        ((tone::C1 + tone::C2 * y) / (1.0 + tone::C3 * y)).powf(ZCAM_P)
    };
    apply(LMS_TO_IAB, apply(R2020_TO_LMS, nits).map(coded))
}

fn apply(m: M3, v: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|r| (0..3).map(|c| m[r][c] * v[c]).sum())
}

/// ZCAM's `e_z`, for `hue` a unit direction in the opponent plane.
fn eccentricity(hue: [f64; 2]) -> f64 {
    let (sin, cos) = ZCAM_HUE_OFFSET_DEGREES.to_radians().sin_cos();
    1.015 + cos * hue[0] - sin * hue[1]
}

/// ZCAM, hue in degrees.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColourNode {
    pub hue: f64,
    pub chroma: f64,
    /// None reaches every lightness, and is solved at [`ANY_LIGHTNESS_AT`].
    pub lightness: Option<f64>,
    pub target_hue: f64,
    pub target_chroma: f64,
    pub target_lightness: f64,
    /// Each reach is where the node moves a colour half as far as its own, in the middle of
    /// [`NODE_FEATHER`].
    pub hue_reach: f64,
    /// Outward from `chroma`. The fall is even in √chroma, so it reaches less inward.
    pub chroma_reach: f64,
    pub lightness_reach: f64,
}

/// What a node's weight falls from one to nothing over, along each lattice axis, whatever its
/// reach: hue in turns, √chroma, lightness, √neighbourhood.
pub const NODE_FEATHER: [f64; 4] = [12.0 / 360.0, 0.35, 10.0, 0.0];

/// Where a weight that is half at `half` and falls over `feather` reaches nothing: a reach too
/// short for the whole feather falls over all of itself, a tent.
fn fallen(half: f64, feather: f64) -> f64 {
    half + feather.min(2.0 * half) / 2.0
}

pub const ANY_LIGHTNESS_AT: f64 = 55.0;

pub const MOST_NODES: usize = 32;

impl ColourNode {
    /// The kernel taking this node's colour exactly onto its target, over `axes`, as
    /// `colour.slang`'s `moved_by_reader` reads it: `[a_re, a_im, d_a, d_b, u_lightness, b_re, b_im]`.
    pub fn kernel(&self, axes: &LutAxes) -> Kernel {
        let level = self.lightness.unwrap_or(ANY_LIGHTNESS_AT);
        let opponent = |chroma: f64, hue: f64| {
            let (sin, cos) = hue.to_radians().sin_cos();
            [chroma * cos, chroma * sin]
        };
        let z = opponent(self.chroma, self.hue);
        let to = opponent(self.target_chroma, self.target_hue);
        let turn = opponent(1.0, self.target_hue - self.hue);
        let added = self.target_chroma - self.chroma;
        let lightness = match level > 0.0 {
            true => self.target_lightness / level - 1.0,
            false => 0.0,
        };
        Kernel {
            centre: [
                (self.hue / 360.0).rem_euclid(1.0),
                self.chroma.max(0.0).sqrt(),
                level,
                0.0,
            ],
            // At least a texel each, or a node between two texels reaches neither.
            reach: [
                fallen(self.hue_reach / 360.0, NODE_FEATHER[0]).max(1.0 / (HUE_TEXELS - 1) as f64),
                fallen(
                    (self.chroma + self.chroma_reach).max(0.0).sqrt() - self.chroma.max(0.0).sqrt(),
                    NODE_FEATHER[1],
                )
                .max(axes.chroma_top / (CHROMA_TEXELS - 1) as f64),
                self.lightness.map_or(0.0, |_| {
                    fallen(self.lightness_reach, NODE_FEATHER[2])
                        .max((axes.level_top - axes.level_low) / (LEVEL_TEXELS - 1) as f64)
                }),
                0.0,
            ],
            generator: [
                turn[0] - 1.0,
                turn[1],
                to[0] - z[0],
                to[1] - z[1],
                lightness,
                added * turn[0],
                added * turn[1],
            ],
            to_lightness: [0.0; 2],
        }
    }
}

/// ZCAM at the lattice's pinned viewing conditions, as `index_space.slang` holds it.
#[derive(Clone, Copy, Debug)]
struct Zcam {
    white_iz: f64,
    lightness_exponent: f64,
    chroma_scale: f64,
}

impl Zcam {
    fn pinned() -> Zcam {
        let white_iz = iab_of([INDEX_WHITE_NITS; 3])[0] - ZCAM_EPSILON;
        let background = ZCAM_BACKGROUND.sqrt();
        let adapting_luminance = INDEX_WHITE_NITS * ZCAM_BACKGROUND;
        let luminance_level =
            0.171 * adapting_luminance.cbrt() * (1.0 - (-48.0 / 9.0 * adapting_luminance).exp());
        let lightness_exponent = 1.6 * ZCAM_DIM_SURROUND / background.powf(0.12);
        let white_brightness = 2700.0
            * white_iz.powf(lightness_exponent)
            * ZCAM_DIM_SURROUND.powf(2.2)
            * background.sqrt()
            * luminance_level.powf(0.2);
        Zcam {
            white_iz,
            lightness_exponent,
            chroma_scale: 1e4 * luminance_level.powf(0.2)
                / (background.powf(0.1) * white_iz.powf(0.78) * white_brightness),
        }
    }

    fn lightness(&self, iz: f64) -> f64 {
        100.0 * (iz.max(0.0) / self.white_iz).powf(self.lightness_exponent)
    }

    /// `ab` the opponent axes' length, `hue` their direction.
    fn chroma(&self, ab: f64, hue: [f64; 2]) -> f64 {
        self.chroma_scale * ab.powf(0.74) * eccentricity(hue).powf(0.068)
    }
}

const INDEX_WHITE_NITS: f64 = 203.0;
/// BT.2100's reference viewing environment.
const ZCAM_DIM_SURROUND: f64 = 0.59;
/// ZCAM's `Yb / Yw`.
const ZCAM_BACKGROUND: f64 = 0.2;
const ZCAM_EPSILON: f64 = 3.7035226210190005e-11;
const ZCAM_HUE_OFFSET_DEGREES: f64 = 89.038;
const ZCAM_P: f64 = 134.034375;
/// Jzazbz's cones with the long and short rows scaled to the middle one's white, so every neutral
/// lands on the lattice's grey axis at every lightness.
const R2020_TO_LMS: [[f64; 3]; 3] = [
    [0.530258488, 0.355874713, 0.086131396],
    [0.289388269, 0.525394823, 0.157481505],
    [0.091036765, 0.147488240, 0.733739592],
];
const LMS_TO_IAB: [[f64; 3]; 3] = [
    [0.0, 1.0, 0.0],
    [3.524000000, -4.066708000, 0.542708000],
    [0.199076000, 1.096799000, -1.295875000],
];

/// One place's correction.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Kernel {
    /// Hue in turns, √chroma, lightness, √neighbourhood.
    pub centre: [f64; 4],
    /// Along the same axes. Zero on an axis the kernel does not depend on.
    pub reach: [f64; 4],
    /// A fitted kernel's operator as its matrix log, on `(d0, d2, l)`: the 2x2 `[a, b, c, d]`, the
    /// tint each chroma axis takes from lightness `[e, f]`, and the lightness term `g`. A colour
    /// edit's holds its move instead ([`ColourNode::kernel`]).
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

impl LutAxes {
    /// Every chroma a display primary has and every lightness PQ codes.
    pub fn of_nodes() -> LutAxes {
        LutAxes {
            chroma_top: widest_chroma().sqrt(),
            level_low: lightness_of_neutral(Light::ZERO),
            level_top: lightness_of_neutral(Light::measured(10000.0 / INDEX_WHITE_NITS)),
            neighbourhood_top: 1.0,
        }
    }

    pub fn shape(&self) -> MapShape {
        MapShape {
            hue_count: HUE_TEXELS,
            chroma_count: CHROMA_TEXELS,
            level_count: LEVEL_TEXELS,
            neighbourhood_count: NEIGHBOURHOOD_TEXELS,
            chroma_scale: (CHROMA_TEXELS - 1) as f64 / self.chroma_top.max(1e-6),
            level_low: self.level_low,
            level_scale: (LEVEL_TEXELS - 1) as f64 / (self.level_top - self.level_low).max(1e-6),
            neighbourhood_scale: (NEIGHBOURHOOD_TEXELS - 1) as f64
                / self.neighbourhood_top.max(1e-6),
        }
    }
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
}

/// Floats a texel of [`Summed`] holds, as `lattice_bake.slang`'s `sum` writes them.
const SUM_WORDS: usize = 9;

/// A kernel set's generators summed per texel over `axes`, once a device has asked: shared by
/// every map that scales or joins the set, so its kernels are walked once.
struct Summed {
    kernels: Vec<Kernel>,
    axes: LutAxes,
    /// [`ColourNode::kernel`]s: solved to land exactly at their centres, and baked unexponentiated.
    moves: bool,
    on: std::sync::OnceLock<(u64, crate::gpu::Buffer)>,
}

impl Summed {
    fn new(kernels: Vec<Kernel>, axes: LutAxes) -> std::sync::Arc<Summed> {
        std::sync::Arc::new(Summed {
            kernels,
            axes,
            moves: false,
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
        self.kernels == other.kernels && self.axes == other.axes
    }
}

impl std::fmt::Debug for ChromaMap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChromaMap")
            .field("kernels", &self.kernels.len())
            .field("axes", &self.axes)
            .finish()
    }
}

impl ChromaMap {
    /// The map that changes nothing, for a caller with no fit yet.
    pub fn identity() -> ChromaMap {
        ChromaMap::new(
            Vec::new(),
            LutAxes {
                chroma_top: widest_chroma().sqrt(),
                level_low: lightness_of_neutral(Light::ZERO),
                level_top: lightness_of_neutral(Light::measured(1.0)),
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

    pub fn of_nodes(nodes: &[ColourNode]) -> ChromaMap {
        let axes = LutAxes::of_nodes();
        // Unfiltered: a node asked to change nothing still holds its colour against its neighbours.
        let kernels: Vec<Kernel> = nodes
            .iter()
            .take(MOST_NODES)
            .map(|node| node.kernel(&axes))
            .collect();
        let summed = std::sync::Arc::new(Summed {
            kernels: kernels.clone(),
            axes,
            moves: true,
            on: std::sync::OnceLock::new(),
        });
        ChromaMap {
            kernels,
            axes,
            terms: vec![(summed, 1.0)],
            baked: Default::default(),
        }
    }

    /// `kernels` over the identity's axes, for fixtures and tests.
    pub fn with_kernels(kernels: Vec<Kernel>) -> ChromaMap {
        ChromaMap::new(kernels, ChromaMap::identity().axes)
    }

    /// Kernels whose generators are too small to change a texel are left out.
    pub fn new(kernels: Vec<Kernel>, axes: LutAxes) -> ChromaMap {
        let kernels: Vec<Kernel> = kernels.into_iter().filter(|k| !k.negligible()).collect();
        let terms = vec![(Summed::new(kernels.clone(), axes), 1.0)];
        ChromaMap::baking(kernels, axes, terms)
    }

    fn baking(
        kernels: Vec<Kernel>,
        axes: LutAxes,
        terms: Vec<(std::sync::Arc<Summed>, f64)>,
    ) -> ChromaMap {
        ChromaMap {
            kernels: kernels.into_iter().filter(|k| !k.negligible()).collect(),
            axes,
            terms,
            baked: Default::default(),
        }
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
        ChromaMap::baking(kernels, self.axes, terms)
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
        ChromaMap::baking(kernels, self.axes, terms)
    }

    pub fn shape(&self) -> MapShape {
        self.axes.shape()
    }

    /// The map as words: `HEAD_WORDS` of axes, then the kernels.
    pub fn words(&self) -> Vec<f64> {
        let mut out = vec![
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
        let axes = LutAxes {
            chroma_top: head[0],
            level_low: head[1],
            level_top: head[2],
            neighbourhood_top: head[3],
        };
        let kernels = rest
            .chunks_exact(KERNEL_WORDS)
            .map(Kernel::from_words)
            .collect();
        Some(ChromaMap::new(kernels, axes))
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
/// A matrix with no real log - a node solved to a reflection - keeps half the share of its
/// correction that has one, along the straight way from the identity to it.
pub fn generator_of(node: [f64; 7]) -> [f64; 7] {
    let a = matrix_of(node);
    if let Some(log) = log_of(a) {
        return node_of(log);
    }
    let toward = |share: f64| add(IDENTITY, scale(sub(a, IDENTITY), share));
    let (mut has, mut lacks) = (0.0, 1.0);
    for _ in 0..40 {
        let share = (has + lacks) / 2.0;
        match log_of(toward(share)) {
            Some(_) => has = share,
            None => lacks = share,
        }
    }
    // At `has` an eigenvalue reaches zero, flattening a chroma direction; back off to half.
    node_of(log_of(toward(has / 2.0)).unwrap_or([[0.0; 3]; 3]))
}

/// Inverse scaling and squaring.
fn log_of(a: M3) -> Option<M3> {
    let mut x = a;
    let mut halvings = 0;
    while norm(sub(x, IDENTITY)) > 0.25 {
        if halvings == 24 {
            return None;
        }
        x = square_root(x)?;
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
    out.iter().flatten().all(|v| v.is_finite()).then_some(out)
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
    interpolate_layout: wgpu::BindGroupLayout,
    interpolate: wgpu::ComputePipeline,
    sum_layout: wgpu::BindGroupLayout,
    sum: wgpu::ComputePipeline,
    bake_layout: wgpu::BindGroupLayout,
    bake: wgpu::ComputePipeline,
    bake_moves: wgpu::ComputePipeline,
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
        let (interpolate_layout, interpolate) = pipeline(
            &[
                buffer(0, read),
                buffer(6, wgpu::BufferBindingType::Storage { read_only: false }),
                buffer(20, wgpu::BufferBindingType::Uniform),
            ],
            "interpolate",
        );
        let (sum_layout, sum) = pipeline(
            &[
                buffer(0, read),
                buffer(3, wgpu::BufferBindingType::Storage { read_only: false }),
                buffer(20, wgpu::BufferBindingType::Uniform),
            ],
            "sum",
        );
        let baking = [
            buffer(4, read),
            buffer(5, read),
            storage(1),
            storage(2),
            buffer(20, wgpu::BufferBindingType::Uniform),
        ];
        let (bake_layout, bake) = pipeline(&baking, "bake");
        let (_, bake_moves) = pipeline(&baking, "bake_moves");
        BakeKernel {
            interpolate_layout,
            interpolate,
            sum_layout,
            sum,
            bake_layout,
            bake,
            bake_moves,
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
fn params(kernels: usize, axes: LutAxes, scales: [f64; 2], feather: [f64; 4]) -> Vec<u8> {
    let mut push: Vec<u8> = [
        kernels as u32,
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
    push.extend(0u32.to_ne_bytes());
    for v in feather {
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
            summed.axes,
            [0.0; 2],
            match summed.moves {
                true => NODE_FEATHER,
                false => [0.0; 4],
            },
        ),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let built = gpu.lattice_bake();
    let kernels = match summed.moves && !summed.kernels.is_empty() {
        false => kernels,
        true => {
            let solved = recording.buffer(&wgpu::BufferDescriptor {
                label: Some("lattice solved kernels"),
                size: words.len() as u64,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            });
            let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
                label: Some("lattice_bake interpolate"),
                layout: &built.interpolate_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: kernels.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 6,
                        resource: solved.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 20,
                        resource: push.as_entire_binding(),
                    },
                ],
            });
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&built.interpolate);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(1, 1, 1);
            drop(pass);
            solved
        }
    };
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
            map.axes,
            [*first_scale, second_scale],
            [0.0; 4],
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
    let pipeline = match map.terms[0].0.moves {
        true => &built.bake_moves,
        false => &built.bake,
    };
    dispatch(&mut recording, pipeline, &group);
    recording.submit();
    (chroma, luma)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_reads_a_kernel_as_the_bake_does() {
        const SOURCE: &str = include_str!("../../../slang/lattice_bake.slang");
        for line in [
            format!("static const uint KERNEL_WORDS = {KERNEL_WORDS};"),
            format!("static const uint MOST_NODES = {MOST_NODES};"),
            format!("static const uint SUM_WORDS = {SUM_WORDS};"),
            format!(
                "static const uint GENERATOR_WORDS = {};",
                Kernel::from_words(&[0.0; KERNEL_WORDS]).generator.len()
            ),
        ] {
            assert!(
                SOURCE.contains(&line),
                "lattice_bake.slang does not say `{line}`"
            );
        }
    }

    #[test]
    fn the_page_holds_the_hosts_node_limits() {
        for (file, source, line) in [
            (
                "colour_wheel.ts",
                include_str!("../../../web/src/features/raw_edit/colour_wheel/colour_wheel.ts"),
                format!("export const ANY_LIGHTNESS_AT = {ANY_LIGHTNESS_AT};"),
            ),
            (
                "photo_edits.ts",
                include_str!("../../../src/schemas/photo_edits.ts"),
                format!("export const COLOUR_NODES_MAX = {MOST_NODES};"),
            ),
        ] {
            assert!(source.contains(&line), "{file} does not say `{line}`");
        }
    }

    #[test]
    fn a_node_reaching_nothing_still_moves_its_own_colour() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let node = ColourNode {
            hue: 122.5,
            chroma: 10.0,
            lightness: Some(32.0),
            target_hue: 142.5,
            target_chroma: 10.0,
            target_lightness: 32.0,
            hue_reach: 0.0,
            chroma_reach: 0.0,
            lightness_reach: 0.0,
        };
        let (pair, _) = ChromaMap::of_nodes(std::slice::from_ref(&node)).baked(gpu);
        let most = read_volume(gpu, &pair)
            .iter()
            .map(|[re, im, _, _]| im.atan2(1.0 + re).to_degrees().abs())
            .fold(0.0, f64::max);
        assert!(
            most > 5.0,
            "the node turned no texel past {most:.1} degrees"
        );
        let anywhere = ColourNode {
            lightness: None,
            ..node
        };
        assert_eq!(anywhere.kernel(&LutAxes::of_nodes()).reach[2], 0.0);
    }

    #[test]
    fn a_node_moves_its_whole_reach_fully_and_falls_to_half_at_its_edge() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let axes = LutAxes::of_nodes();
        let (level_at, chroma_at, hue_at) = (7, 12, 36);
        let root_chroma = axes.chroma_top * chroma_at as f64 / (CHROMA_TEXELS - 1) as f64;
        let hue_of = |texel: usize| 360.0 * texel as f64 / (HUE_TEXELS - 1) as f64;
        let node = ColourNode {
            hue: hue_of(hue_at),
            chroma: root_chroma * root_chroma,
            lightness: Some(
                axes.level_low
                    + (axes.level_top - axes.level_low) * level_at as f64
                        / (LEVEL_TEXELS - 1) as f64,
            ),
            target_hue: hue_of(hue_at) + 10.0,
            target_chroma: root_chroma * root_chroma,
            target_lightness: 60.0,
            // The edge three texels round; the plateau ends half the feather short of it.
            hue_reach: hue_of(3),
            chroma_reach: 6.0,
            lightness_reach: 15.0,
        };
        assert!(hue_of(1) < hue_of(3) - 180.0 * NODE_FEATHER[0]);
        let (pair, luma) = ChromaMap::of_nodes(std::slice::from_ref(&node)).baked(gpu);
        let (pair, luma) = (read_volume(gpu, &pair), read_volume(gpu, &luma));
        let row = (level_at * CHROMA_TEXELS + chroma_at) * HUE_TEXELS;
        let at = |hue_texel: usize| move_at(&pair, &luma, row + hue_texel);
        let own = at(hue_at);
        for (texel, share) in [(hue_at + 1, 1.0), (hue_at + 3, 0.5), (hue_at + 5, 0.0)] {
            let got = at(texel);
            for w in 0..7 {
                assert!(
                    (got[w] - share * own[w]).abs() < 1e-2 * own[w].abs().max(1e-2),
                    "texel {texel} word {w}: {got:?}, wanted {share} of {own:?}"
                );
            }
        }
    }

    #[test]
    fn overlapping_nodes_each_land_on_their_own_target() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let axes = LutAxes::of_nodes();
        // On texels, so the baked operator there is read without interpolating.
        let (level_at, chroma_at) = (7, 12);
        let lightness = axes.level_low
            + (axes.level_top - axes.level_low) * level_at as f64 / (LEVEL_TEXELS - 1) as f64;
        let root_chroma = axes.chroma_top * chroma_at as f64 / (CHROMA_TEXELS - 1) as f64;
        let chroma = root_chroma * root_chroma;
        let hue_of = |texel: usize| 360.0 * texel as f64 / (HUE_TEXELS - 1) as f64;
        let node = |hue_texel: usize, target: [f64; 3]| ColourNode {
            hue: hue_of(hue_texel),
            chroma,
            lightness: Some(lightness),
            target_hue: target[0],
            target_chroma: target[1],
            target_lightness: target[2],
            hue_reach: 20.0,
            chroma_reach: 2.8,
            lightness_reach: 15.0,
        };
        let nodes = [
            node(48, [hue_of(48) + 15.0, chroma, lightness]),
            node(52, [hue_of(52), chroma * 0.5, lightness + 5.0]),
        ];
        let (pair, luma) = ChromaMap::of_nodes(&nodes).baked(gpu);
        let (pair, luma) = (read_volume(gpu, &pair), read_volume(gpu, &luma));
        for (n, hue_texel) in nodes.iter().zip([48, 52]) {
            let texel = (level_at * CHROMA_TEXELS + chroma_at) * HUE_TEXELS + hue_texel;
            let got = moved(
                move_at(&pair, &luma, texel),
                opponent(lightness, chroma, n.hue),
            );
            let want = opponent(n.target_lightness, n.target_chroma, n.target_hue);
            let off = got
                .iter()
                .zip(want)
                .map(|(got, want)| (got - want).abs())
                .fold(0.0, f64::max);
            assert!(off < 0.1, "{n:?} gave {got:?}, wanted {want:?}");
        }
    }

    #[test]
    fn nodes_at_nearly_one_colour_asking_opposite_turns_stay_within_their_turns() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let node = |hue: f64, turn: f64| ColourNode {
            hue,
            chroma: 12.0,
            lightness: None,
            target_hue: hue + turn,
            target_chroma: 12.0,
            target_lightness: ANY_LIGHTNESS_AT,
            hue_reach: 40.0,
            chroma_reach: 8.0,
            lightness_reach: 0.0,
        };
        let (pair, luma) = ChromaMap::of_nodes(&[node(100.0, 20.0), node(104.0, -20.0)]).baked(gpu);
        let (pair, luma) = (read_volume(gpu, &pair), read_volume(gpu, &luma));
        let axes = LutAxes::of_nodes();
        let most = (0..pair.len())
            .map(|texel| {
                let at = opponent_at(place_of(axes, texel));
                let to = moved(move_at(&pair, &luma, texel), at);
                let turn = (to[2].atan2(to[1]) - at[2].atan2(at[1])).to_degrees();
                let turn = (turn + 180.0).rem_euclid(360.0) - 180.0;
                match at[1].hypot(at[2]) > 1.0 {
                    true => turn.abs(),
                    false => 0.0,
                }
            })
            .fold(0.0, f64::max);
        assert!(
            most < 60.0,
            "a texel turns {most:.0} degrees for edits asking 20"
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

    /// A dark node from a night frame, solved to a reflection.
    #[test]
    fn a_reflection_keeps_half_the_share_of_it_that_has_a_log() {
        let node = [-14.4, -1.63, 202.0, 23.1, 0.0, 0.0, 1.0];
        let identity = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        let back = operator_of(generator_of(node));
        // The 2x2's eigenvalues are 9.0726 and -0.37256; the second reaches zero at a share of
        // 1 / 1.37256.
        let share = back[2] / node[2];
        assert!((share - 0.5 / 1.37256).abs() < 1e-4, "kept {share} of it");
        for k in 0..7 {
            let want = identity[k] + share * (node[k] - identity[k]);
            assert!(
                (back[k] - want).abs() < 1e-4 * want.abs().max(1.0),
                "{back:?} is not on the way to {node:?}"
            );
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
            vec![Kernel {
                centre: [0.25, 2.1, 42.0, 0.5],
                reach: [1.0 / 12.0, 0.7, 11.0, 0.4],
                generator: [0.1, 0.02, -0.01, 0.05, 0.003, -0.002, 0.04],
                to_lightness: [0.01, -0.02],
            }],
            LutAxes {
                chroma_top: 4.2,
                level_low: 0.0,
                level_top: 135.0,
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
        let texels = read_volume(gpu, &chroma);

        let tent = |d: f64, reach: f64| -> f64 {
            if reach <= 0.0 {
                return 1.0;
            }
            let u = 1.0 - (d.abs() / reach).min(1.0);
            u * u * u * (u * (u * 6.0 - 15.0) + 10.0)
        };
        let mut worst: f64 = 0.0;
        for (texel, got) in texels.iter().enumerate() {
            let at = place_of(axes, texel);
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
            for (got, want) in got.iter().zip(&want[..4]) {
                let off = (got - want).abs() / want.abs().max(1.0);
                worst = if off <= worst { worst } else { off };
            }
        }
        assert!(
            worst < 2e-3,
            "a texel is {worst} off the sum over every kernel"
        );
    }

    /// A lightness term with nothing else, reaching everywhere: each texel's gain is the term at
    /// the colour that texel stands for, which only the shader's `rendered_of` can have found.
    #[test]
    fn the_bake_reads_each_texel_at_the_colour_it_stands_for() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let to_lightness = [0.5, -0.3];
        let map = ChromaMap::new(
            vec![Kernel {
                centre: [0.0; 4],
                reach: [0.0; 4],
                generator: [0.0; 7],
                to_lightness,
            }],
            LutAxes {
                chroma_top: 4.6,
                level_top: lightness_of_neutral(Light::measured(6.0)),
                ..ChromaMap::identity().axes
            },
        );
        let (_, luma) = map.baked(gpu);
        let texels = read_volume(gpu, &luma);
        let chromaticity = |d: f64, level: f64, weight: f64| match level <= 0.0 {
            true => 0.0,
            false => (d / level).clamp(-1.0, 1.0 / weight - 1.0),
        };
        let luma = crate::hdr_fit::LUMA;
        let mut worst: (f64, usize) = (0.0, 0);
        for (texel, got) in texels.iter().enumerate() {
            let colour = raw_rendered_of(opponent_at(place_of(map.axes, texel)));
            let l: f64 = colour.iter().zip(luma).map(|(c, w)| c * w).sum();
            let want = to_lightness[0] * chromaticity(colour[0] - l, l, luma[0])
                + to_lightness[1] * chromaticity(colour[2] - l, l, luma[2]);
            let off = (got[2] - want).abs() / want.abs().max(0.25);
            if !(off <= worst.0) {
                worst = (off, texel);
            }
        }
        // SwiftShader's `pow` is looser: a near-black texel far outside the gamut reads 1% off.
        assert!(
            worst.0 < 2e-2,
            "texel {} at {:?} is {} off",
            worst.1,
            place_of(map.axes, worst.1),
            worst.0
        );
    }

    #[test]
    fn zcam_reads_back_the_colour_it_was_given() {
        for colour in [
            [0.18, 0.18, 0.18],
            [0.9, 0.1, 0.05],
            [0.05, 0.6, 0.2],
            [0.1, 0.2, 0.95],
            [3.5, 2.0, 0.4],
            [0.002, 0.001, 0.003],
        ] {
            let back = raw_rendered_of(opponent_of(colour.map(Light::measured)));
            for (got, want) in back.iter().zip(colour) {
                assert!(
                    (got - want).abs() < 1e-9 * want.max(1.0),
                    "{colour:?} came back {back:?}"
                );
            }
        }
    }

    /// `index_space.slang`'s `opponent_at`.
    fn opponent_at([turn, root_chroma, lightness, _]: [f64; 4]) -> [f64; 3] {
        let (sin, cos) = (turn * std::f64::consts::TAU).sin_cos();
        let chroma = root_chroma * root_chroma;
        [lightness, chroma * cos, chroma * sin]
    }

    fn raw_rendered_of(opponent: [f64; 3]) -> [f64; 3] {
        rendered_of(opponent).map(Light::raw)
    }

    #[test]
    fn a_node_moves_its_colour_onto_its_target() {
        let node = |hue, chroma, lightness, target: [f64; 3]| ColourNode {
            hue,
            chroma,
            lightness,
            target_hue: target[0],
            target_chroma: target[1],
            target_lightness: target[2],
            hue_reach: 30.0,
            chroma_reach: 4.0,
            lightness_reach: 25.0,
        };
        for node in [
            node(240.0, 12.0, Some(55.0), [215.0, 18.0, 50.0]),
            node(30.0, 8.0, Some(80.0), [30.0, 3.0, 80.0]),
            node(120.0, 0.3, Some(30.0), [60.0, 6.0, 35.0]),
            node(300.0, 10.0, None, [330.0, 10.0, 60.0]),
            node(0.0, 5.0, Some(110.0), [0.0, 5.0, 110.0]),
            node(120.0, 9.0, None, [301.0, 12.0, 55.0]),
        ] {
            let from = opponent(
                node.lightness.unwrap_or(ANY_LIGHTNESS_AT),
                node.chroma,
                node.hue,
            );
            let want = opponent(node.target_lightness, node.target_chroma, node.target_hue);
            let generator = node.kernel(&LutAxes::of_nodes()).generator;
            let got = moved(generator, from);
            for (got, want) in got.iter().zip(want) {
                assert!(
                    (got - want).abs() < 1e-9,
                    "{node:?} gave {got:?}, wanted {want:?}"
                );
            }
        }
    }

    #[test]
    fn a_partly_reached_colour_moves_continuously_as_the_target_crosses_the_far_side() {
        let node = |target_hue: f64| ColourNode {
            hue: 120.0,
            chroma: 9.0,
            lightness: None,
            target_hue,
            target_chroma: 12.0,
            target_lightness: ANY_LIGHTNESS_AT,
            hue_reach: 30.0,
            chroma_reach: 6.0,
            lightness_reach: 0.0,
        };
        let half_of = |target_hue: f64| {
            let generator = node(target_hue).kernel(&LutAxes::of_nodes()).generator;
            moved(
                std::array::from_fn(|k| generator[k] / 2.0),
                opponent(ANY_LIGHTNESS_AT, 9.0, 120.0),
            )
        };
        let (before, after) = (half_of(299.5), half_of(300.5));
        let apart = (before[1] - after[1]).hypot(before[2] - after[2]);
        assert!(apart < 0.2, "half a move went from {before:?} to {after:?}");
    }

    #[test]
    fn the_grade_turns_a_colour_from_the_chroma_the_host_does() {
        const SOURCE: &str = include_str!("../../../slang/colour.slang");
        let line = format!("static const float TURNED_HALF_AT = {TURNED_HALF_AT:.1};");
        assert!(SOURCE.contains(&line), "colour.slang does not say `{line}`");
    }

    #[test]
    fn a_grey_in_reach_moves_by_the_nodes_offset_whatever_its_hue() {
        let node = ColourNode {
            hue: 315.0,
            chroma: 7.0,
            lightness: None,
            target_hue: 135.0,
            target_chroma: 38.0,
            target_lightness: ANY_LIGHTNESS_AT,
            hue_reach: 60.0,
            chroma_reach: 6.0,
            lightness_reach: 0.0,
        };
        let generator = node.kernel(&LutAxes::of_nodes()).generator;
        let got = moved(generator, opponent(ANY_LIGHTNESS_AT, 0.0, 0.0));
        let from = opponent(ANY_LIGHTNESS_AT, 7.0, 315.0);
        let to = opponent(ANY_LIGHTNESS_AT, 38.0, 135.0);
        for k in 1..3 {
            assert!((got[k] - (to[k] - from[k])).abs() < 1e-9, "{got:?}");
        }
    }

    #[test]
    fn a_vivid_colour_beside_a_node_keeps_its_hue_apart_and_takes_the_chroma_change() {
        let node = ColourNode {
            hue: 100.0,
            chroma: 60.0,
            lightness: None,
            target_hue: 130.0,
            target_chroma: 90.0,
            target_lightness: ANY_LIGHTNESS_AT,
            hue_reach: 40.0,
            chroma_reach: 10.0,
            lightness_reach: 0.0,
        };
        let generator = node.kernel(&LutAxes::of_nodes()).generator;
        let [_, a, b] = moved(generator, opponent(ANY_LIGHTNESS_AT, 60.0, 110.0));
        let hue = b.atan2(a).to_degrees();
        assert!((hue - 140.0).abs() < 0.5, "turned to {hue}");
        assert!((a.hypot(b) - 90.0).abs() < 0.5, "chroma {}", a.hypot(b));
    }

    fn opponent(lightness: f64, chroma: f64, hue: f64) -> [f64; 3] {
        let (sin, cos) = hue.to_radians().sin_cos();
        [lightness, chroma * cos, chroma * sin]
    }

    /// `colour.slang`'s.
    const TURNED_HALF_AT: f64 = 5.0;

    /// `colour.slang`'s `moved_by_reader`, by a kernel's move words or a texel of its volumes.
    fn moved(by: [f64; 7], [lightness, a, b]: [f64; 3]) -> [f64; 3] {
        let chroma = a.hypot(b);
        let (along_a, along_b) = match chroma > 0.0 {
            true => (a / chroma, b / chroma),
            false => (0.0, 0.0),
        };
        let turn = [
            by[0] * a - by[1] * b + by[5] * along_a - by[6] * along_b,
            by[0] * b + by[1] * a + by[5] * along_b + by[6] * along_a,
        ];
        let share = chroma * chroma / (chroma * chroma + TURNED_HALF_AT * TURNED_HALF_AT);
        [
            lightness * (1.0 + by[4]),
            a + share * turn[0] + (1.0 - share) * by[2],
            b + share * turn[1] + (1.0 - share) * by[3],
        ]
    }

    /// Texel `texel`'s move from a node map's two volumes, in a kernel's word order.
    fn move_at(pair: &[[f64; 4]], luma: &[[f64; 4]], texel: usize) -> [f64; 7] {
        let [a, b, c, d] = pair[texel];
        let [lightness, turn_a, turn_b, _] = luma[texel];
        [a, b, c, d, lightness, turn_a, turn_b]
    }

    /// Texel `texel`'s place in lattice coordinates, as `lattice_bake.slang`'s `place_of` has it.
    fn place_of(axes: LutAxes, texel: usize) -> [f64; 4] {
        let (x, y, z) = (
            texel % HUE_TEXELS,
            (texel / HUE_TEXELS) % CHROMA_TEXELS,
            texel / (HUE_TEXELS * CHROMA_TEXELS),
        );
        let (level, neighbourhood) = (z % LEVEL_TEXELS, z / LEVEL_TEXELS);
        [
            x as f64 / (HUE_TEXELS - 1) as f64,
            axes.chroma_top * y as f64 / (CHROMA_TEXELS - 1) as f64,
            axes.level_low
                + (axes.level_top - axes.level_low) * level as f64 / (LEVEL_TEXELS - 1) as f64,
            axes.neighbourhood_top * neighbourhood as f64 / (NEIGHBOURHOOD_TEXELS - 1) as f64,
        ]
    }

    /// Every texel of a baked volume, hue fastest.
    fn read_volume(gpu: &Gpu, volume: &Texture) -> Vec<[f64; 4]> {
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
                texture: volume,
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
            volume.size(),
        );
        recording.submit();
        let bytes = pollster::block_on(crate::gpu::read_back(gpu, &staged, |b| b.to_vec()))
            .expect("read back");
        (0..HUE_TEXELS * CHROMA_TEXELS * depth)
            .map(|texel| {
                let (x, rows) = (texel % HUE_TEXELS, texel / HUE_TEXELS);
                let at = rows * row + x * 8;
                std::array::from_fn(|c| {
                    f64::from(half::f16::from_le_bytes([
                        bytes[at + 2 * c],
                        bytes[at + 2 * c + 1],
                    ]))
                })
            })
            .collect()
    }

    #[test]
    fn diffuse_white_is_a_hundred_and_hdr_sits_above_it() {
        let white = lightness_of_neutral(Light::measured(1.0));
        assert!((white - 100.0).abs() < 1e-9, "{white}");
        let black = lightness_of_neutral(Light::ZERO);
        assert!(black.abs() < 1e-6, "{black}");
        let peak = lightness_of_neutral(Light::measured(4.0));
        assert!(peak > 130.0, "{peak}");
        for level in [0.01, 0.18, 1.0, 20.0] {
            let grey = chroma_of([Light::measured(level); 3]);
            assert!(grey < 0.01, "a neutral at {level} reads {grey} of chroma");
        }
    }

    #[test]
    fn the_shader_holds_the_hosts_zcam_constants() {
        const SOURCE: &str = include_str!("../../../slang/index_space.slang");
        let declared = |name: &str| -> f64 {
            let from = SOURCE
                .find(&format!("float {name} = "))
                .unwrap_or_else(|| panic!("index_space.slang does not declare {name}"))
                + name.len()
                + 9;
            SOURCE[from..SOURCE[from..].find(';').expect("a ;") + from]
                .parse()
                .expect("a float")
        };
        let zcam = Zcam::pinned();
        let (sin, cos) = ZCAM_HUE_OFFSET_DEGREES.to_radians().sin_cos();
        let wrong: Vec<String> = [
            ("INDEX_WHITE_NITS", INDEX_WHITE_NITS),
            ("ZCAM_P", ZCAM_P),
            ("ZCAM_EPSILON", ZCAM_EPSILON),
            ("ZCAM_WHITE_IZ", zcam.white_iz),
            ("ZCAM_LIGHTNESS_EXPONENT", zcam.lightness_exponent),
            ("ZCAM_CHROMA_SCALE", zcam.chroma_scale),
            ("ZCAM_HUE_COS", cos),
            ("ZCAM_HUE_SIN", sin),
        ]
        .into_iter()
        .filter(|(name, want)| (declared(name) - want).abs() > 1e-7 * want.abs())
        .map(|(name, want)| format!("{name} = {want:.9}"))
        .collect();
        assert!(wrong.is_empty(), "index_space.slang should say {wrong:?}");
        let back = inverse(R2020_TO_LMS).expect("invertible");
        let entries = R2020_TO_LMS
            .iter()
            .chain(&back)
            .chain(&LMS_TO_IAB)
            .flatten();
        for v in entries.filter(|v| v.abs() != 0.0 && v.abs() != 1.0 && **v != 0.5) {
            assert!(
                SOURCE.contains(&format!("{v:.9}")),
                "index_space.slang does not hold {v:.9}"
            );
        }
    }
}
