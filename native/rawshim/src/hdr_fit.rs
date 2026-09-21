// The camera's colour treatment, fitted for the HDR grade (DESIGN 10.8).
//
// The geometry comes from `fit.rs` - it is a property of the lens, not of a colour space -
// and the colour is fitted here, in the domain the grade actually works in: Rec.2020
// linear, normalised so diffuse white is 1.0. A fit in 8-bit sRGB could not be lifted to
// HDR: its domain stops at display white, so it has nothing to say about the scene above
// it, and 8 bits of output is coarser than the shadows of a PQ signal. Linear makes the
// curve extrapolable, which is what lets the camera's rendering stop at diffuse white and
// BT.2390 take over above it (10.7.1).

use crate::parallel::*;
use crate::px::TUNED_ON;

/// Long edge of the grid the fit runs on. Fitting small and applying at full resolution is
/// free, and a 60MP fit is minutes of work for the same answer.
///
/// Half the 1616px preview Sony embeds, which is what every match fits against where a body
/// offers it (`decode_rawler::Preview::for_the_match`); a body that offers only its full JPEG
/// is box-averaged to the same grid in linear light by `fitted_preview_size`, so the grade's
/// supervision footprint (`gpu::mean_block`) is one number for every body. Measured on the
/// Canon fixture against fitting its 6000px JPEG at 1280: the fit halves, and against the
/// camera's own crops the render moves by 0.15 to 0.47 of a count in 255.
const FIT_LONG_EDGE: usize = 808;

/// Curve resolution over the fit domain.
///
/// Spaced evenly in scene light, which under-describes the shadows: both sides of this fit are
/// linear, so the stop below diffuse white takes 128 of these and five stops down there are 8.
/// **Measured, respacing them does not help.** On the square root of the level - 19 bins five
/// stops down instead of 8 - the 32-frame library came out at a mean deltaE of 3.063 against
/// 3.059, six frames better and ten worse, and it cost the identity transform its exactness
/// (a quadratic through linearly interpolated bins lands 3e-6 out). What limits the shadows is
/// not how many bins they get but how few pairs land in them: `MIN_BIN_SAMPLES` already drops
/// the sparse ones, so finer spacing buys more empty bins. `pool_violators` is the fix that
/// worked.
pub(crate) const BINS: usize = 256;

/// The default top of the fit's domain, as a fraction of diffuse white.
///
/// Not 1.0: the last stop before an 8-bit image clips is the camera compressing
/// highlights into a range it does not have, and a curve fitted through that learns
/// the compression as though it were colour. Cut below it and the shoulder is never
/// seen.
///
/// The default and the floor, not the domain itself - that is `HdrColour::ceiling`, which the
/// selection stretches on frames whose exposure puts camera-visible content above this.
pub const TRUST_CEILING: f64 = 0.9;

const MIN_BIN_SAMPLES: usize = 8;
const MIN_PAIRS: usize = 2000;

/// Rec.2020 luma, for the chroma blend and the sample weighting.
pub(crate) const LUMA: [f64; 3] = [0.2627, 0.678, 0.0593];

/// Three box passes, close enough to a Gaussian here. Both images are blurred before
/// pairing for the reason the geometry search blurs its grids: the camera's sharpening and noise
/// reduction are not reproducible and must not leak into the colour fit, and residual
/// misregistration stops mattering once neither image has detail at that scale.
const FIT_BLUR_RADIUS: usize = 2;

/// Where the camera's rendering stops carrying information. Above this a JPEG level is
/// on its way to flat white and says nothing about what colour was there, so a pair is
/// no use for the channel that reached it.
///
/// High, and the cost of setting it low is asymmetric by channel: lit skin's red
/// crosses first, so a cautious gate censors red's brightest teachers while green and
/// blue keep theirs, and the shared curve's top end is then taught by less-red content -
/// a green tinge on the brightest skin, from a transform with no local knob at all.
pub(crate) const CAMERA_CLIPPING: f64 = 0.98;

/// The same thing at the other end, and only the chroma stages refuse it.
///
/// A channel the body crushed reports what it was clipped to rather than what colour was
/// there, and the ratios a hue and a 3x3 are made of are then quantisation noise. On a
/// night frame that is most of blue, and the matrix fitted from it puts blue on luma:
/// DSC05726's blue row came back `[0.296, 0.102, 0.602]`, which turned its red awning and
/// its warm lanterns pink.
///
/// The per-channel curves keep such a pair. Where the camera crushes is what the toe *is*,
/// and a curve is the one part of the model that can say so - so the three channel bits are
/// left where they were, and it is the stages reading the camera's chroma that refuse it:
/// the `COLOUR` bit, and the wide pass that fills the lattice beside it.
///
/// The level `GREY_FLOOR` already calls enough light to read a pixel's chroma at.
pub(crate) const CAMERA_CRUSHED: f64 = 0.02;

/// The same level again, where the pair list asks whether either side rendered a pixel neutral.
///
/// Named apart from `CAMERA_CRUSHED` on purpose: that one is a statement about what a body's
/// output means at the bottom of its range, and this is a floor under a chroma *ratio*, which is
/// noise taken between small numbers whoever produced them. Ours is tested against it too.
pub(crate) const GREY_FLOOR: f64 = 0.02;

/// The damping used where a frame gives `fitted_matrix` nothing at all to choose
/// between candidates with, its moments being empty. The frame picks its own in every
/// other case, so this is the fallback rather than the usual answer.
const MATRIX_RIDGE: f64 = 0.05;

pub(crate) const SRGB_TO_XYZ: [[f64; 3]; 3] = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.072175],
    [0.0193339, 0.119192, 0.9503041],
];
const XYZ_TO_REC2020: [[f64; 3]; 3] = [
    [1.7166512, -0.3556708, -0.2533663],
    [-0.6666844, 1.6164812, 0.0157685],
    [0.0176399, -0.0427706, 0.9421031],
];
pub(crate) const REC2020_TO_XYZ: [[f64; 3]; 3] = [
    [0.637958, 0.1446169, 0.168881],
    [0.2627002, 0.6779981, 0.0593017],
    [0.0, 0.0280727, 1.0609851],
];
const XYZ_TO_SRGB: [[f64; 3]; 3] = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.969266, 1.8760108, 0.041556],
    [0.0556434, -0.2040259, 1.0572252],
];

const IDENTITY: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

pub(crate) fn multiply(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

/// A 3x3 over one colour, for the fixtures and the pins that check a matrix by hand. The stages
/// that apply one to a picture do it in the shader that produced the picture.
#[cfg(test)]
fn apply3(m: &[[f64; 3]; 3], r: f64, g: f64, b: f64) -> [f64; 3] {
    [
        m[0][0] * r + m[0][1] * g + m[0][2] * b,
        m[1][0] * r + m[1][1] * g + m[1][2] * b,
        m[2][0] * r + m[2][1] * g + m[2][2] * b,
    ]
}

/// The sRGB transfer's inverse, for a value already in 0..1.
fn srgb_eotf_f(coded: f64) -> f64 {
    let c = coded.clamp(0.0, 1.0);
    match c <= 0.04045 {
        true => c / 12.92,
        false => ((c + 0.055) / 1.055).powf(2.4),
    }
}

/// The sRGB transfer's inverse, for a JPEG's 8-bit level: the camera's own encoding, undone.
pub fn srgb_eotf(level: u8) -> f64 {
    let c = f64::from(level) / 255.0;
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

/// The frame's own light at arm's length: a small luma plane of the whole photograph,
/// blurred as `surround_plane` blurs, in the render's scene-linear units.
///
/// This is what the lattice's surround axis reads at grade time. It travels with the
/// colour because the lattice is unusable without it - a map fitted against a
/// neighbourhood and read against none lands every conditioned correction on the wrong
/// slab - and because a loupe tile cannot compute it: the blur spans the photograph and
/// a tile only holds its window.
#[derive(Clone, PartialEq)]
pub struct SurroundThumb {
    pub width: usize,
    pub height: usize,
    /// `f16`-quantised at the fit, so a stored match compares equal to a fresh one.
    pub data: Vec<f64>,
}

impl SurroundThumb {
    /// No thumb, for a colour with no lattice to read one.
    pub fn none() -> SurroundThumb {
        SurroundThumb { width: 0, height: 0, data: Vec::new() }
    }
}

/// `PartialEq` because [`crate::gpu::Uploaded`] owns a copy and refuses a grade describing a
/// different one; the fields are plain numbers, so the derive is the whole comparison.
#[derive(Clone, PartialEq)]
pub struct HdrColour {
    /// Per-channel, `BINS` samples spanning render values 0 to `ceiling`.
    pub curves: [Vec<f64>; 3],
    /// The top of the fit's domain, in the render's own anchored units.
    ///
    /// `TRUST_CEILING` unless the frame's exposure put what the camera can still see
    /// above it. The render is anchored on its own white quantile where the camera meters
    /// the subject, so a lit subject in a dark frame lands at 1.5 render units while the
    /// camera renders it unclipped - and a domain ending at 0.9 then censors exactly the
    /// region where the two disagree: the curves cannot learn it, its pairs are gated out
    /// of every chroma stage, and the fitted-versus-held boundary crosses the subject as
    /// a band. Sized by `fit_pairs::Selected::ceiling` so it ends where the camera's data does.
    pub ceiling: f64,
    /// Where `colour.slang`'s `curves_at` reads a highlight's colour, from `chroma_anchor`.
    ///
    /// Derived from the curve wherever a match is built or read back, never stored beside
    /// it: a sidecar carrying both could come back with an anchor its own curve does not
    /// imply, and the frame would render a colour no fit ever chose.
    pub anchor: f64,
    /// Applied after the curves; row-major, output channel by input channel.
    pub matrix: [[f64; 3]; 3],
    /// Blend towards luma afterwards; 1 leaves chroma alone.
    ///
    /// One number, and the baseline the `chroma` map below generalises rather than the
    /// whole of what this model says about saturation.
    ///
    /// A curve over chroma and a gain per hue each described this camera's saturation far
    /// better - it takes a brown's chroma up 36% where it takes grass's up 8% - and both
    /// had to come out again, because a gain computed per pixel from that pixel's own
    /// colour amplifies the *variation* in that colour. Across a dog's flat fur
    /// neighbouring pixels were pulled apart into red speckles beside green ones, and a
    /// wall the camera renders flat grey came out blotchy. They improved every number this
    /// fit reports and damaged the picture, which is why the numbers are not the last
    /// word. Denoising the render first does not buy them back either: the speckle is
    /// still there at the strength the render is denoised by (§10.9).
    ///
    /// What made a hue-dependent correction safe afterwards was bounding how fast it may
    /// vary - a coarse lattice read by trilinear interpolation has a gradient bounded by
    /// the difference between neighbouring nodes, where those per-pixel gains had none.
    ///
    /// That bound is the *grid*, and it is the whole of it now. There was an amplitude cap
    /// on top - `strain_at`, `relax`, a pair of allowances - and it has been removed: it
    /// fired on all 58 frames measured across two bodies and two libraries, cost accuracy
    /// on nearly every one, and changed no render by more than JPEG noise. At three times
    /// the fitted deviation there was still no speckle. What actually stops a wild map is
    /// `MAP_MARGIN` and the acceptance gate, which are outcome tests rather than parameter
    /// bounds, and which do reject one when it happens.
    ///
    /// A luma term on the nodes would want this re-measured: the grid bounds its gradient
    /// too, but the eye reads luma noise differently from chroma noise.
    pub saturation: f64,
    /// The hue-dependent part, where the frame supported fitting one.
    ///
    /// None is not a failure - it is the model this had before there was a chroma axis,
    /// and a frame with too little colour to fit one is better served by it.
    pub chroma: Option<ChromaMap>,
    /// The surround the map above reads; empty whenever `chroma` is `None`.
    pub surround: SurroundThumb,
    /// The hue-balanced CIEDE2000 the fit scores itself by, on pairs it was not fitted from,
    /// with the cast term of `folded` in it.
    ///
    /// **Still not a measure of whether the render looks right**, and it has been read as one.
    /// It was a bare mean ΔE76 when IMG_8789 reported 2.47 here and rendered its bird bath
    /// and stone wall visibly green; it now carries a distance function that does not discount
    /// near-neutral error, a signed term that a cast cannot hide from, and a holdout that
    /// memorising cannot flatter. What it still cannot see is anything the fit solves rather
    /// than chooses, and it remains one number over a whole frame - so a render is what says
    /// a render is right.
    pub delta_e: f64,
}

/// A fitted colour and what the render was already worth without it.
///
/// Beside the colour rather than on it: `HdrColour` is compared by value against a match
/// decoded from a record (`gpu::Uploaded`), so a number that does not round-trip through
/// that record would make every fresh fit compare unequal to its own stored copy.
pub struct Fitted {
    pub colour: HdrColour,
    /// The same measure over the same held-out pairs with nothing applied, which is what
    /// `colour.delta_e` has to beat to be worth applying.
    pub baseline_delta_e: f64,
}

/// Nodes across each chroma axis and up the level axis.
///
/// Deliberately coarse. What this corrects is a camera's hue-dependent rendering, which
/// is smooth; what it must not do is vary fast enough with a pixel's own colour to
/// amplify the noise in that colour, which is what took the per-hue gain out again
/// (`HdrColour::saturation`). Cell width is the denominator of that gradient, so it is
/// the safety margin.
///
/// **Held-out pairs do not answer this and a holdout cannot be made to.** Swept from 7 to 39
/// nodes an axis, held-out `delta_e` says the opposite of what the render says - it falls all
/// the way, by a quarter to a third, while the picture measured against the camera's own JPEG
/// gets steadily worse: at the level nine below, 1.667 at seven nodes, 1.686 at fifteen, 1.722
/// at thirty-one. The two disagree in direction, not in size.
///
/// Blocking the holdout by region rather than by stride does not fix it, which is the part
/// worth knowing before trying: a lattice memorises *colours*, and the same lawn and the same
/// skin sit on both sides of any partition of one photograph, so no split makes a held-out pair
/// an unseen colour. What the table below measures - the whole render against the camera - is
/// the only thing that has ever been able to see this, and `examples/sweep` reports it.
///
/// **And coarse for a second reason, which is now the stronger one: finer overfits.**
/// Measured on IMG_8789, against the camera's own JPEG at full resolution rather than on
/// the pairs the fit is scored by:
///
/// | grid    | fit ΔE2000 | full-res mean | light muted `da*` |
/// |---------|-----------:|--------------:|------------------:|
/// | 5x5x4   |     1.9527 |        5.4981 |            -2.164 |
/// | 7x7x16  |     1.6591 |        5.3705 |            -2.927 |
///
/// The finer grid fits the *training* pairs 15% better, moves the actual render 2%, and
/// makes the green cast on light near-neutral surfaces 35% worse - a bird bath and a stone
/// wall, which is the failure this model has twice been shipped with. A mean of a magnitude
/// cannot see that trade; only a signed statistic can, which is why one exists.
///
/// So node count is not the lever it looks like. Every node added divides the pairs that
/// reach each one, `MAP_CONFIDENCE` then shrinks them harder, and what survives is a
/// better fit to noise.
///
/// **And this cannot be fixed by scoring differently, which was the next thing tried.**
/// Adding the signed cast to the objective at three times the weight of the mean still
/// preferred the finer grid - 3.11 against 3.99 - while its held-out cast stayed the worse
/// of the two. The objective is measured on the pairs the model is fitted to, so a richer
/// model overfits whatever statistic is put in it, a signed one included. What is missing
/// is not a better statistic but held-out pairs: `DESIGN`'s falloff keeps its term only
/// where it wins "on the pairs the round was not fitted on", and that discipline was never
/// extended to the colour model - which is the stage whose capacity actually grew.
///
/// **Two things about measuring this that cost a while to learn.** A cast has to be pooled
/// over pixels of *similar colour*, not over a neighbourhood: pooled spatially the finer
/// grid scores better at every window from 4px to 64px, because a window on this frame is
/// mostly lawn and the lawn genuinely improved, so the bird bath drowns in it. And the
/// pooling has to be inside a class rather than across the frame, or a green cast on the
/// neutrals and a warm one on the saturates cancel and the number reads clean. The eye
/// agrees with the classed measure and not with the spatial one: side by side at 1:1, the
/// finer grid's bird bath is the greener.
pub(crate) const MAP_CHROMA: usize = 7;
/// Nine, matched to the level axis reaching the fitted ceiling rather than the default
/// domain (`with_level_reach`): the same nodes-per-root-unit the shadows and midtones
/// had over the shorter reach, with the stretch above getting its own.
///
/// **Five looks better than this and renders worse, which is the trap `MAP_CHROMA` describes.**
/// Held-out `delta_e` prefers five by half a point and more, bracketed on both sides and at two
/// chroma counts - a thorough-looking result, and wrong. Against the camera's own JPEG the same
/// change costs about 0.055 whatever the chroma is beside it: 1.667 to 1.723 at seven nodes,
/// 1.686 to 1.736 at fifteen. Reading a lattice size off the pairs it was fitted from finds
/// five; reading it off the picture finds this.
///
/// Below four there is no lattice at all rather than a smaller one - the acceptance gate refuses
/// the map and the fit ships without one - so the axis has a floor as well as a cost.
pub(crate) const MAP_LEVEL: usize = 9;

/// Nodes along the surround axis: the pixel's own neighbourhood brightness, at arm's
/// length, which is the one thing the camera's rendering reads that no colour can carry.
///
/// Measured before believed: at identical `(d0, d2, level)` coordinates on one frame, the
/// camera's JPEG renders blue-to-green 0.385 where a lit gradient falls into shadow and
/// 0.597 where the same colour sits in a dark corner - its local tone mapping conditions
/// on the neighbourhood, so a model indexed by colour alone must average the two and
/// paints the transition a colour the camera never printed. Three nodes, because the
/// effect is first-order in the surround: what it needs is to tell "dark against light"
/// from "dark against dark", not to resolve the neighbourhood finely.
pub(crate) const MAP_SURROUND: usize = 3;

/// The grid `colour.slang`'s `correct` walks, for a caller that has to walk the same one.
pub struct MapShape {
    pub chroma_count: usize,
    pub level_count: usize,
    pub surround_count: usize,
    /// Per axis, red-green then blue-yellow: the two carry different spans because a
    /// frame's chroma is not distributed alike on them.
    pub chroma_low: [f64; 2],
    pub chroma_scale: [f64; 2],
    pub level_scale: f64,
    pub surround_scale: f64,
}

/// Every node of the grid, as a compile-time count.
const MAP_NODES: usize = MAP_CHROMA * MAP_CHROMA * MAP_LEVEL * MAP_SURROUND;

/// Cells the applied lattice carries per fitted cell, on every axis (`ChromaMap::densified`).
const MAP_DENSITY: usize = 4;

/// How many nodes the lattice has, for a caller sizing a buffer to read one back into.
pub fn map_nodes() -> usize {
    MAP_NODES
}

/// How far out the chroma axes reach before the grid clamps, and how far up the level
/// axis does. Beyond either, a colour keeps the last node's correction rather than an
/// extrapolated one - which is what makes the map safe above the reference's clip point.
///
/// Measured rather than guessed, and the first guess wasted the grid: at 0.6 the chroma
/// axes spanned half again what a frame actually contains - |d| runs to 0.42 at its very
/// widest and 0.375 at the 99th - so 58 of 100 nodes were never touched and the ones that
/// were sat three to an axis.
///
/// The level axis is in the square root, where a frame reaches about 0.85.
const CHROMA_REACH: f64 = 0.45;
const LEVEL_REACH: f64 = 0.9;

/// A correction around the grey axis and along it, indexed by chroma and level.
///
/// **The lightness term is a correction, not the transfer.** The camera's rendering of
/// level is still the tone curves' job: they hold 256 bins where this holds nine, and the
/// reference cannot speak past its own clip point, so mapping lightness onto the JPEG's
/// wholesale would hand back exactly the highlight range an HDR rendition exists to keep.
/// What lives here is the part the curves structurally cannot say - a lightness error
/// that depends on *hue*. Measured on IMG_8789: a blue pot whose hue lands within 2.5
/// degrees of the camera and whose chroma is within 0.2 comes out 4.4 L* too dark, and
/// the blues as a whole run 2 to 4 L* down while the reds sit at +0.04. No stage in the
/// model before this one could express that - the matrix is one 3x3 for the whole frame,
/// so it cannot vary with level; the curves see one channel each, so they cannot vary
/// with hue; and this lattice preserved luma exactly by construction.
///
/// Near identity everywhere, which is what keeps the old argument intact: a gain that
/// stays near 1 where the data runs out is still safe above the fit domain, where a
/// transfer is not.
///
/// Indexed in Cartesian chroma rather than hue and saturation, which costs nothing per
/// pixel: `d = v - luma` already lies in the plane `LUMA . d = 0`, so `(d[0], d[2])` fixes
/// it and `d[1]` follows. Polar would mean an `atan2` on every one of 180M samples to say
/// the same thing, and it puts a seam at the wrap where trilinear needs none.
#[derive(Clone, PartialEq)]
pub struct ChromaMap {
    /// Per node, indexed surround-major, then level, then y, then x. `NODE_VALUES`
    /// describes what is in one.
    nodes: Vec<[f64; NODE_VALUES]>,
    /// Nodes along each chroma axis. `MAP_CHROMA` as fitted; `densified` multiplies it.
    chroma_count: usize,
    level_count: usize,
    surround_count: usize,
    /// How far the chroma axes reach, fitted to the frame rather than fixed.
    ///
    /// A constant here has to be the widest any frame might be, and then every frame that
    /// is not that wide spends its nodes on colours it does not contain. Measured on
    /// IMG_8789 at the fixed 0.45: the outermost column of the grid held zero pairs at
    /// every level, and the blue pot - the one object the lattice most needed to represent -
    /// sat between two interior nodes carrying 41,225 pairs of lawn and paving between them.
    /// A fifth of the lattice was unreachable and the object that needed it was averaged
    /// into its surroundings.
    /// Axis low edge and gaps-per-unit, red-green then blue-yellow. `chroma_span` sizes
    /// them so zero lands exactly on a node.
    low: [f64; 2],
    scale: [f64; 2],
    level_scale: f64,
    surround_scale: f64,
}

/// Three rows over `(d0, d2, l)`, so every output depends on chroma *and* lightness.
///
/// `[a, b, c, d, e, f, g, h, i]`:
///
/// ```text
/// d0' = a.d0 + b.d2 + e.l
/// d2' = c.d0 + d.d2 + f.l
/// l'  = h.d0 + i.d2 + g.l
/// ```
///
/// **`e` and `f` are what lets a node tint a neutral.** With only the 2x2 a colour at
/// `d = 0` comes out at `d = 0` however the node is set, so the lattice could not express a
/// cast on near-neutral surfaces at all - the defect a bird bath and a stone wall were
/// showing. Proportional to `l` rather than a constant, which keeps the properties the 2x2
/// has: black stays black, and the term stays near identity where the data runs out. They
/// also subsume `grey_balance`, which is two chroma degrees of freedom held constant across
/// level where these are two per level node.
///
/// **`h` and `i` are what lets a node's *lightness* correction depend on the colour.**
/// Without them the output lightness is exactly `g.l` for one `g` per node, so a small
/// saturated object needing 1.43x and the surroundings it shares a node with needing 1.0 can
/// only be given their average - the blue pot's node solved to 1.006 with the pot inside it.
/// The chroma rows could always separate two colours in one node, being linear in `d`; this
/// gives lightness the same freedom.
pub const NODE_VALUES: usize = 9;

/// **Both groups beyond the 2x2 earn their place, asked on the render.** They were added against
/// held-out `delta_e`, which `MAP_CHROMA` records disagreeing with the picture elsewhere, so they
/// were put to the render directly by zeroing each group after the solve.
///
/// Without `e` and `f` the render loses 0.045 on three fixtures and DSC02981 stops clearing the
/// acceptance gate altogether, shipping with no map. Without `h` and `i` three fixtures gain
/// 0.023 - and forty-three real frames lose 0.006 and 0.022, which is the answer that counts.

impl ChromaMap {
    /// The map that changes nothing, for a caller with no fit yet.
    pub fn identity() -> ChromaMap {
        ChromaMap::from_saturation(1.0)
    }

    /// A map built node by node, for the fixtures and the tests.
    ///
    /// `from_saturation` puts the same 2x2 at every node, which is enough to say the lookup
    /// happens and nothing about where it read: a reader that swapped the chroma axes, or
    /// scaled the level axis wrongly, lands on an identical node and answers correctly. A
    /// pin against a second implementation needs a lattice whose nodes differ.
    ///
    /// `f` is given the node's `(x, y, z)` - the two chroma axes and the level - in the
    /// order `nodes` is indexed in. The same values fill every surround slab, so a
    /// synthetic map answers as it always did whatever surround it is read at.
    pub fn from_nodes(f: impl Fn(usize, usize, usize) -> [f64; NODE_VALUES]) -> ChromaMap {
        let mut nodes = vec![[0.0; NODE_VALUES]; MAP_NODES];
        for s in 0..MAP_SURROUND {
            for z in 0..MAP_LEVEL {
                for y in 0..MAP_CHROMA {
                    for x in 0..MAP_CHROMA {
                        nodes[((s * MAP_LEVEL + z) * MAP_CHROMA + y) * MAP_CHROMA + x] =
                            f(x, y, z);
                    }
                }
            }
        }
        let reach = ChromaMap::warp(CHROMA_REACH);
        ChromaMap { low: [-reach; 2], scale: [ChromaMap::scale_for(reach); 2], ..ChromaMap::coarse_shell(nodes) }
    }

    /// The map that does exactly what the saturation scalar does.
    ///
    /// Which is the point of the shape: one gain applied to every colour alike is this
    /// model with the same 2x2 at every node, so the chroma map is a strict
    /// generalisation of the scalar it replaces rather than a second thing beside it.
    /// A frame that wants nothing hue-dependent is described by the same 2x2 at every
    /// node, exactly.
    ///
    /// Exactly in the 2x2, not bit-identically in what leaves `colour.slang`'s
    /// `finish_chroma`: that rebuilds the middle channel as `-(L0.d0 + L2.d2) / L1` where the
    /// scalar path blends it directly, so the two agree to a few ulps rather than to the bit.
    ///
    /// The luma gain is 1 at every node, so the generalisation still holds exactly with
    /// the lightness term present: a frame that wants nothing hue-dependent gets a map
    /// that leaves lightness where the tone stage put it.
    pub fn from_saturation(saturation: f64) -> ChromaMap {
        let node = [saturation, 0.0, 0.0, saturation, 0.0, 0.0, 1.0, 0.0, 0.0];
        let reach = ChromaMap::warp(CHROMA_REACH);
        ChromaMap { low: [-reach; 2], scale: [ChromaMap::scale_for(reach); 2], ..ChromaMap::coarse_shell(vec![node; MAP_NODES]) }
    }

    /// A map at the fitted grid's own shape, for the constructors that fill one in.
    fn coarse_shell(nodes: Vec<[f64; NODE_VALUES]>) -> ChromaMap {
        ChromaMap {
            nodes,
            chroma_count: MAP_CHROMA,
            level_count: MAP_LEVEL,
            surround_count: MAP_SURROUND,
            low: [0.0; 2],
            scale: [0.0; 2],
            level_scale: Self::LEVEL_SCALE,
            surround_scale: Self::SURROUND_SCALE,
        }
    }

    /// Where a coordinate sits on an axis running up from `low`: the node below it, and
    /// how far past. `scale` is the gap width's reciprocal.
    fn axis(value: f64, nodes: usize, low: f64, scale: f64) -> (usize, f64) {
        // `max` then `min` rather than `clamp`: these return whichever operand is not
        // NaN, so a NaN arriving here lands on a node instead of propagating into an
        // index.
        let t = ((value - low) * scale).max(0.0).min((nodes - 1) as f64);
        let below = (t as usize).min(nodes - 2);
        (below, t - below as f64)
    }

    /// Gaps per unit for one half of an axis, given how far that half reaches in
    /// warped units.
    fn scale_for(reach: f64) -> f64 {
        (MAP_CHROMA - 1) as f64 / (2.0 * reach.max(1e-6))
    }

    /// Chroma to the space the axes are laid out in: signed root, so the nodes go where
    /// the colours are. A frame's chroma masses near neutral the way its levels mass in
    /// the shadows, and the level axis takes the same root for the same reason - spaced
    /// evenly in chroma itself, the nodes either resolve the near-neutral mass and clamp
    /// the frame's own saturated colours onto the outermost node, or cover them and blur
    /// the mass; measured, each of those costs about a deltaE against the other's frames.
    /// `low` and `scale` are in this space; `colour.slang` warps identically.
    fn warp(d: f64) -> f64 {
        d.signum() * d.abs().sqrt()
    }

    const LEVEL_SCALE: f64 = (MAP_LEVEL - 1) as f64 / LEVEL_REACH;
    const SURROUND_SCALE: f64 = (MAP_SURROUND - 1) as f64 / LEVEL_REACH;

    /// The lattice rebuilt from what [`ChromaMap::nodes_flat`] and [`ChromaMap::shape`] handed
    /// out, for a match read back from storage rather than fitted.
    ///
    /// Refuses a `nodes` of the wrong length rather than padding it: the grid's dimensions are
    /// this module's, and a stored map that disagrees was written by a build whose lattice was
    /// a different shape - which would land every colour on the wrong node rather than fail.
    pub fn from_parts(nodes: &[f64], low: [f64; 2], scale: [f64; 2]) -> Option<ChromaMap> {
        if nodes.len() != MAP_NODES * NODE_VALUES {
            return None;
        }
        let mut lattice = vec![[0.0; NODE_VALUES]; MAP_NODES];
        for (node, values) in lattice.iter_mut().zip(nodes.chunks_exact(NODE_VALUES)) {
            node.copy_from_slice(values);
        }
        Some(ChromaMap { low, scale, ..ChromaMap::coarse_shell(lattice) })
    }

    /// The lattice as one flat array, `NODE_VALUES` per node, in `correct`'s index order.
    ///
    /// For the editor's client, which walks the same map in a shader (`edit.rs`). Handing
    /// out the shape alongside it rather than letting the other side hardcode the grid is
    /// what keeps a change here from silently landing a colour on the wrong node there.
    pub fn nodes_flat(&self) -> Vec<f64> {
        self.nodes.iter().flatten().copied().collect()
    }

    /// The axis constants `correct` reads the lattice with.
    pub fn shape(&self) -> MapShape {
        MapShape {
            chroma_count: self.chroma_count,
            level_count: self.level_count,
            surround_count: self.surround_count,
            chroma_low: self.low,
            chroma_scale: self.scale,
            level_scale: self.level_scale,
            surround_scale: self.surround_scale,
        }
    }

    /// The cell a colour sits in: the node below it on each axis, and how far across it is.
    ///
    /// `colour.slang`'s `correct` walks the same axes as texture coordinates. The two must agree
    /// about which cell a colour belongs to - a map fitted against one neighbourhood and read
    /// from another is wrong everywhere - and nothing but this note enforces that.
    fn cell(
        axes: &LatticeAxes,
        level: f64,
        surround: f64,
        d0: f64,
        d2: f64,
    ) -> ([usize; 4], [f64; 4]) {
        let (x, fx) = Self::axis(Self::warp(d0), MAP_CHROMA, axes.span[0][0], axes.span[0][1]);
        let (y, fy) = Self::axis(Self::warp(d2), MAP_CHROMA, axes.span[1][0], axes.span[1][1]);
        // Square root rather than the level itself, so the shadows get nodes in
        // proportion to how much of a picture lives in them, and cheaper than a cube root
        // in a loop this size. The surround takes the same root for the same reason.
        let (z, fz) = Self::axis(level.max(0.0).sqrt(), MAP_LEVEL, 0.0, axes.level_scale);
        let (s, fs) =
            Self::axis(surround.max(0.0).sqrt(), MAP_SURROUND, 0.0, axes.surround_scale);
        ([x, y, z, s], [fx, fy, fz, fs])
    }

    /// The sixteen nodes about a cell's corner, and the share of a sample each takes.
    ///
    /// The same sixteen corners `colour.slang`'s two-slab trilinear blends, for the reason on
    /// [`cell`](Self::cell).
    fn nodes_of([x, y, z, s]: [usize; 4], [fx, fy, fz, fs]: [f64; 4]) -> ([usize; 16], [f64; 16]) {
        let mut at = [0usize; 16];
        let mut weight = [0.0f64; 16];
        let mut k = 0;
        for (ds, ws) in [(0, 1.0 - fs), (1, fs)] {
            for (dz, wz) in [(0, 1.0 - fz), (1, fz)] {
                for (dy, wy) in [(0, 1.0 - fy), (1, fy)] {
                    for (dx, wx) in [(0, 1.0 - fx), (1, fx)] {
                        at[k] = (((s + ds) * MAP_LEVEL + z + dz) * MAP_CHROMA + y + dy)
                            * MAP_CHROMA
                            + x
                            + dx;
                        weight[k] = ws * wz * wy * wx;
                        k += 1;
                    }
                }
            }
        }
        (at, weight)
    }

    /// The applied form of a fitted lattice: smoothed, then resampled dense.
    ///
    /// The fitted nodes are solved independently, so the multilinear read's slope jumps at
    /// every cell crossing, and a wide smooth gradient renders the jumps as flat zones with
    /// contours between them - `through`'s failure, in four dimensions. A smooth curve
    /// *through* the fitted nodes is not the answer: they were solved against the linear
    /// read, so Catmull-Rom through them overshoots exactly where the lattice is steep -
    /// deltaE 1.227 against 1.032 on the frame the zones came from. `project` instead finds
    /// the control values whose curve sits closest to the fitted polyline, which rounds
    /// each crossing inside its own cell and keeps the fit everywhere else.
    ///
    /// The chroma and level axes only. Those are the axes a smooth gradient traverses; the
    /// surround is read from a plane already blurred to a tenth of the frame, so its kinks
    /// never land on neighbouring pixels - and at `MAP_SURROUND` nodes a cubic bending
    /// between the slabs costs real fidelity for that nothing.
    pub fn smoothed(&self) -> ChromaMap {
        let (c, l, s) = (self.chroma_count, self.level_count, self.surround_count);
        let nodes = Self::project(&self.nodes, s * l * c, c, 1);
        let nodes = Self::project(&nodes, s * l, c, c);
        let nodes = Self::project(&nodes, s, l, c * c);
        ChromaMap { nodes, ..self.clone() }.densified()
    }

    /// Dense samples of the Catmull-Rom curve the node values control.
    ///
    /// Reads its input as control values, not as a surface to draw through - `smoothed` is
    /// where a fitted lattice becomes controls. Resampled at `MAP_DENSITY` cells per fitted
    /// cell, the read both hosts already do follows the curve with kinks `MAP_DENSITY`
    /// times smaller than the fitted grid's and a deviation from it `MAP_DENSITY`^2
    /// smaller.
    ///
    /// The controls go through `f16` and the span through `f32` first - the widths the
    /// sidecar stores them at - so `coarse` of the result round-trips storage exactly:
    /// the curve passes through its controls, and decimation reads them back.
    pub fn densified(&self) -> ChromaMap {
        let quantised: Vec<[f64; NODE_VALUES]> = self
            .nodes
            .iter()
            .map(|node| std::array::from_fn(|c| f64::from(half::f16::from_f64(node[c]))))
            .collect();
        let (c, l, s) = (self.chroma_count, self.level_count, self.surround_count);
        let dense = |n: usize| (n - 1) * MAP_DENSITY + 1;
        let nodes = Self::upsample(&quantised, s * l * c, c, 1);
        let nodes = Self::upsample(&nodes, s * l, c, dense(c));
        let nodes = Self::upsample(&nodes, s, l, dense(c) * dense(c));
        ChromaMap {
            nodes,
            chroma_count: dense(c),
            level_count: dense(l),
            surround_count: s,
            low: self.low.map(|v| f64::from(v as f32)),
            scale: self.scale.map(|v| f64::from(v as f32) * MAP_DENSITY as f64),
            level_scale: self.level_scale * MAP_DENSITY as f64,
            surround_scale: self.surround_scale,
        }
    }

    /// The level and surround axes re-scoped to this frame's fitted domain.
    ///
    /// At the default reach, a frame whose ceiling was stretched holds content far above
    /// it, and the whole stretch lands on the top level plane - one shared answer for
    /// every brightness the stretch admitted, averaged from all of it. On lit skin that
    /// average is green.
    pub(crate) fn with_level_reach(mut self, ceiling: f64) -> ChromaMap {
        let reach = ceiling.sqrt();
        self.level_scale = (self.level_count - 1) as f64 / reach;
        self.surround_scale = (self.surround_count - 1) as f64 / reach;
        self
    }

    /// The lattice with each level profile projected onto a cubic.
    ///
    /// Adjacent level nodes are solved from different pair populations, and their small
    /// alternation renders on a smoothly lit ramp as parallel hue bands along the
    /// iso-illumination contours - the one structure a gradient cannot hide. A plain
    /// blur damps the genuine level trend with the wiggle and loses fit for it, and a
    /// quadratic squeezes the camera's real level behaviour hard enough to push the
    /// error somewhere new; a cubic keeps every trend the level profile can honestly
    /// claim and still cannot alternate stripe-fine, so the bands are excluded by
    /// construction rather than by trade.
    fn level_trended(&self) -> ChromaMap {
        let (c, l, s) = (self.chroma_count, self.level_count, self.surround_count);
        let area = c * c;
        // Orthogonal polynomials over the node indices, so the projection is four dot
        // products per profile rather than a solve.
        let mean = (l as f64 - 1.0) / 2.0;
        let p1: Vec<f64> = (0..l).map(|z| z as f64 - mean).collect();
        let m2 = p1.iter().map(|v| v * v).sum::<f64>() / l as f64;
        let p2: Vec<f64> = p1.iter().map(|v| v * v - m2).collect();
        let m4 = p1.iter().map(|v| v.powi(4)).sum::<f64>()
            / p1.iter().map(|v| v * v).sum::<f64>();
        let p3: Vec<f64> = p1.iter().map(|v| v.powi(3) - m4 * v).collect();
        let (n1, n2, n3) = (
            p1.iter().map(|v| v * v).sum::<f64>(),
            p2.iter().map(|v| v * v).sum::<f64>(),
            p3.iter().map(|v| v * v).sum::<f64>(),
        );
        let mut nodes = self.nodes.clone();
        for si in 0..s {
            for at in 0..area {
                for ch in 0..NODE_VALUES {
                    let v = |z: usize| self.nodes[(si * l + z) * area + at][ch];
                    let a0 = (0..l).map(&v).sum::<f64>() / l as f64;
                    let a1 = (0..l).map(|z| v(z) * p1[z]).sum::<f64>() / n1;
                    let a2 = (0..l).map(|z| v(z) * p2[z]).sum::<f64>() / n2;
                    let a3 = (0..l).map(|z| v(z) * p3[z]).sum::<f64>() / n3;
                    for z in 0..l {
                        nodes[(si * l + z) * area + at][ch] =
                            a0 + a1 * p1[z] + a2 * p2[z] + a3 * p3[z];
                    }
                }
            }
        }
        ChromaMap { nodes, ..self.clone() }
    }

    /// The fitted lattice `densified` was built from, at the shape the sidecar stores.
    /// Exact, not an approximation: the resample passes through the fitted nodes, so
    /// decimation recovers them.
    pub fn coarse(&self) -> ChromaMap {
        if self.chroma_count == MAP_CHROMA {
            return self.clone();
        }
        let d = MAP_DENSITY;
        let mut nodes = Vec::with_capacity(MAP_NODES);
        for s in 0..MAP_SURROUND {
            for z in 0..MAP_LEVEL {
                for y in 0..MAP_CHROMA {
                    for x in 0..MAP_CHROMA {
                        let at = ((s * self.level_count + z * d) * self.chroma_count
                            + y * d)
                            * self.chroma_count
                            + x * d;
                        nodes.push(self.nodes[at]);
                    }
                }
            }
        }
        ChromaMap {
            low: self.low,
            scale: self.scale.map(|v| v / d as f64),
            // The fitted reach, not the shell's default: a re-scoped map that loses its
            // scales here reads the level axis wrong anywhere but through `take_match`,
            // which happens to re-apply them.
            level_scale: self.level_scale / d as f64,
            surround_scale: self.surround_scale,
            ..ChromaMap::coarse_shell(nodes)
        }
    }

    /// The Catmull-Rom sampling matrix for one axis: dense row `j` against control `q`,
    /// `(n - 1) * MAP_DENSITY + 1` rows of `n`.
    ///
    /// A tap past either end reads a linear extension of the edge pair, folded into the
    /// edge columns. Duplicating the edge control instead flattens the phantom slope and
    /// the end cell's cubic bends to absorb it - measured, the two largest slope jumps of
    /// the whole read sat in the last cell.
    fn cr_matrix(n: usize) -> (usize, Vec<f64>) {
        let rows = (n - 1) * MAP_DENSITY + 1;
        let mut matrix = vec![0.0; rows * n];
        for j in 0..rows {
            let k = (j / MAP_DENSITY).min(n - 2);
            let t = (j - k * MAP_DENSITY) as f64 / MAP_DENSITY as f64;
            let weights = [
                0.5 * (-t * t * t + 2.0 * t * t - t),
                0.5 * (3.0 * t * t * t - 5.0 * t * t + 2.0),
                0.5 * (-3.0 * t * t * t + 4.0 * t * t + t),
                0.5 * (t * t * t - t * t),
            ];
            let row = &mut matrix[j * n..][..n];
            for (tap, weight) in (k as isize - 1..).zip(weights) {
                if tap < 0 {
                    row[0] += 2.0 * weight;
                    row[1] -= weight;
                } else if tap as usize > n - 1 {
                    row[n - 1] += 2.0 * weight;
                    row[n - 2] -= weight;
                } else {
                    row[tap as usize] += weight;
                }
            }
        }
        (rows, matrix)
    }

    /// One axis of the lattice resampled `MAP_DENSITY`-fold through `cr_matrix`, for a
    /// layout of `outer` runs of `n` entries `inner` apart.
    fn upsample(
        data: &[[f64; NODE_VALUES]],
        outer: usize,
        n: usize,
        inner: usize,
    ) -> Vec<[f64; NODE_VALUES]> {
        let (rows, matrix) = Self::cr_matrix(n);
        let mut out = vec![[0.0; NODE_VALUES]; outer * rows * inner];
        for o in 0..outer {
            for j in 0..rows {
                let row = &matrix[j * n..][..n];
                for i in 0..inner {
                    let mut node = [0.0; NODE_VALUES];
                    for (q, weight) in row.iter().enumerate() {
                        if *weight == 0.0 {
                            continue;
                        }
                        let from = data[(o * n + q) * inner + i];
                        for (slot, value) in node.iter_mut().zip(from) {
                            *slot += weight * value;
                        }
                    }
                    out[(o * rows + j) * inner + i] = node;
                }
            }
        }
        out
    }

    /// Control values whose curve sits closest to the linear read of `data` along one
    /// axis, judged at the same dense positions `upsample` emits.
    ///
    /// A small least squares per line - `n` is at most `MAP_CHROMA` - against a normal
    /// matrix every line shares.
    fn project(
        data: &[[f64; NODE_VALUES]],
        outer: usize,
        n: usize,
        inner: usize,
    ) -> Vec<[f64; NODE_VALUES]> {
        let (rows, matrix) = Self::cr_matrix(n);
        let mut normal = vec![0.0; n * n];
        for j in 0..rows {
            let row = &matrix[j * n..][..n];
            for p in 0..n {
                for q in 0..n {
                    normal[p * n + q] += row[p] * row[q];
                }
            }
        }
        let mut out = vec![[0.0; NODE_VALUES]; outer * n * inner];
        for o in 0..outer {
            for i in 0..inner {
                let value = |q: usize| data[(o * n + q) * inner + i];
                let mut rhs = vec![[0.0; NODE_VALUES]; n];
                for j in 0..rows {
                    let k = (j / MAP_DENSITY).min(n - 2);
                    let t = (j - k * MAP_DENSITY) as f64 / MAP_DENSITY as f64;
                    let (below, above) = (value(k), value(k + 1));
                    let target: [f64; NODE_VALUES] =
                        std::array::from_fn(|c| (1.0 - t) * below[c] + t * above[c]);
                    let row = &matrix[j * n..][..n];
                    for (q, weight) in row.iter().enumerate() {
                        if *weight == 0.0 {
                            continue;
                        }
                        for (slot, value) in rhs[q].iter_mut().zip(target) {
                            *slot += weight * value;
                        }
                    }
                }
                for (q, node) in Self::solve(&normal, rhs, n).into_iter().enumerate() {
                    out[(o * n + q) * inner + i] = node;
                }
            }
        }
        out
    }

    /// Gaussian elimination with partial pivoting, every `NODE_VALUES` right-hand side at
    /// once. The matrix is a Catmull-Rom normal matrix: tiny, symmetric positive definite,
    /// so a pivot is always there to take.
    fn solve(normal: &[f64], mut rhs: Vec<[f64; NODE_VALUES]>, n: usize) -> Vec<[f64; NODE_VALUES]> {
        let mut a = normal.to_vec();
        for col in 0..n {
            let pivot = (col..n)
                .max_by(|p, q| a[p * n + col].abs().total_cmp(&a[q * n + col].abs()))
                .unwrap_or(col);
            if pivot != col {
                for k in 0..n {
                    a.swap(col * n + k, pivot * n + k);
                }
                rhs.swap(col, pivot);
            }
            for row in col + 1..n {
                let factor = a[row * n + col] / a[col * n + col];
                for k in col..n {
                    a[row * n + k] -= factor * a[col * n + k];
                }
                let (above, below) = (rhs[col], &mut rhs[row]);
                for (slot, value) in below.iter_mut().zip(above) {
                    *slot -= factor * value;
                }
            }
        }
        for col in (0..n).rev() {
            for k in col + 1..n {
                let (ahead, here) = (rhs[k], &mut rhs[col]);
                let factor = a[col * n + k];
                for (slot, value) in here.iter_mut().zip(ahead) {
                    *slot -= factor * value;
                }
            }
            let lead = a[col * n + col];
            for slot in rhs[col].iter_mut() {
                *slot /= lead;
            }
        }
        rhs
    }

}

/// The whole transform: what the lens did, then what the camera did to its colour.
///
/// One struct rather than three arguments because they are one thing. The colour was
/// fitted from pairs that only correspond *through* the geometry, so applying the
/// colour without the warp gives a photo the camera's colour and the raw render's shape.
/// The falloff is on the same terms: the curves were fitted on a render that already
/// carried it.
#[derive(Clone)]
pub struct HdrMatch {
    /// The geometry search's lens and falloff, as they were fitted (10.8.1).
    pub lens: crate::fit::Lens,
    pub colour: Option<HdrColour>,
}

#[derive(serde::Deserialize, serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CameraMatch {
    None,
    Lens,
    LensAndColour,
}

impl CameraMatch {
    pub fn needs_fit(self, matched: Option<&HdrMatch>) -> bool {
        match self {
            Self::None => false,
            Self::Lens => matched.is_none(),
            Self::LensAndColour => matched.and_then(|m| m.colour.as_ref()).is_none(),
        }
    }

    pub fn apply(self, matched: Option<HdrMatch>) -> Option<HdrMatch> {
        match self {
            Self::None => None,
            Self::Lens => matched.map(|m| HdrMatch { lens: m.lens, colour: None }),
            Self::LensAndColour => matched,
        }
    }
}

#[cfg(test)]
mod camera_match_tests {
    use super::{CameraMatch, HdrMatch};

    #[test]
    fn camera_match_applies_only_the_requested_parts() {
        let matched = crate::photo_analysis::tests::a_match();
        assert!(CameraMatch::None.apply(Some(matched.clone())).is_none());
        let lens = CameraMatch::Lens.apply(Some(matched.clone())).expect("lens");
        assert_eq!(lens.lens.crop, matched.lens.crop);
        assert!(lens.colour.is_none());
        assert!(CameraMatch::LensAndColour.apply(Some(matched.clone())).expect("match").colour.is_some());
        assert!(!CameraMatch::None.needs_fit(None));
        assert!(CameraMatch::Lens.needs_fit(None));
        assert!(!CameraMatch::Lens.needs_fit(Some(&lens)));
        assert!(CameraMatch::LensAndColour.needs_fit(Some(&lens)));
        assert!(!CameraMatch::LensAndColour.needs_fit(Some(&matched)));
    }

    #[test]
    fn camera_match_protocol_refuses_colour_without_lens() {
        for value in ["none", "lens", "lensAndColour"] {
            assert!(serde_json::from_value::<CameraMatch>(serde_json::json!(value)).is_ok());
        }
        assert!(serde_json::from_str::<CameraMatch>(r#""colour""#).is_err());
    }

    #[test]
    fn camera_match_lens_analysis_round_trips_and_gains_colour_without_losing_it() {
        use crate::photo_analysis::{self, FromRaw, PhotoAnalysis};
        let full = PhotoAnalysis {
            from_raw: FromRaw { matched: Some(photo_analysis::tests::a_match()), ..Default::default() },
            ..Default::default()
        };
        let lens = PhotoAnalysis {
            from_raw: FromRaw {
                matched: Some(HdrMatch { lens: full.from_raw.matched.as_ref().unwrap().lens.clone(), colour: None }),
                ..Default::default()
            },
            ..Default::default()
        };
        let decoded = photo_analysis::decode(&photo_analysis::encode(&lens)).expect("analysis");
        let matched = decoded.from_raw.matched.expect("lens");
        assert!(matched.colour.is_none());
        assert_eq!(matched.lens.distortion.as_ref().unwrap().len(), 4);
        assert!((matched.lens.crop - 1.0234).abs() < 1e-6);
        assert!(full.adds_to(&lens));
        assert!(!lens.adds_to(&full));
        assert!(lens.filled_from(&full).from_raw.matched.expect("match").colour.is_some());
    }
}

/// Interleaved RGB, linear, 1.0 = diffuse white.
pub struct Plane {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f64>,
}

// ------------------------------------------------------------------ the mask

/// Where the hue a pixel was censused into rides in the same word the mask crosses back in.
///
/// The mask is the low byte and the hue is the one above it, which is what leaves the shader's
/// `ALL` and `COLOUR` room to sit beside the three channel bits without colliding with a bucket.
pub(crate) const HUE_SHIFT: u32 = 8;

/// How much square-root luma may change across a pixel before a small misregistration could
/// change its colour, which is what disqualifies it as a pair.
pub(crate) const PAIR_GRADIENT: f64 = 0.03;

/// Below this much chroma a pixel has no hue worth censusing: a ratio taken between crushed
/// codes is noise, and a pixel the camera rendered 2/1/3 would land in a bin on nothing.
pub(crate) const HUE_CHROMA: f64 = 0.1;

/// Below this many usable pixels a frame does not get to move its own ceiling.
pub(crate) const MIN_CEILING_PIXELS: usize = 16;

/// How far up our own render a pair still carries colour, as a fraction of diffuse white.
///
/// Only our clipping, unlike `TRUST_CEILING`. Above this the channel is at or against the
/// top of its container and the objective clamps it to the gamut (`fit_score.slang`), so the
/// comparison would be against a white we invented rather than one we rendered.
pub(crate) const OUR_CLIPPING: f64 = 0.99;

// ------------------------------------------------------------------- the model

/// Binned mean with the gaps between bins interpolated, and the highest bin the data
/// actually reached. Above that bin the curve is undefined; `extend_alone` fills it.
///
/// The mean is weighted, so a bin answers for the levels the frame holds rather than
/// for whichever colour happens to fill it (`hue_balance`). The count floor stays on
/// the pairs themselves: a bin filled by pixels the weight discounts is thin evidence,
/// not absent evidence, and dropping it would shorten the curve.
fn fit_curve(binned: &crate::fit_curve::Binned) -> (Vec<f64>, isize) {
    let crate::fit_curve::Binned { sum, weight, count } = binned;
    // Made monotone here, where the bins still carry the weight behind them, rather than left
    // to the running maximum in `make_monotone` further down.
    let mut measured: Vec<(usize, f64, f64)> = (0..BINS)
        .filter(|b| count[*b] >= MIN_BIN_SAMPLES && weight[*b] > 0.0)
        .map(|b| (b, srgb_eotf_f(sum[b] / weight[b]), weight[b]))
        .collect();
    if crate::clock::watched() {
        let raw: Vec<String> = measured
            .iter()
            .take_while(|(bin, _, _)| *bin < 16)
            .map(|(bin, value, _)| format!("{bin}:{value:.5}"))
            .collect();
        eprintln!("  curve toe measured {}", raw.join(" "));
    }
    pool_violators(&mut measured);

    let Some(&(reach, _, _)) = measured.last() else {
        return (vec![0.0; BINS], -1);
    };
    if crate::clock::watched() {
        let toe: Vec<String> = measured
            .iter()
            .take_while(|(bin, _, _)| *bin < 16)
            .map(|(bin, value, weight)| format!("{bin}:{value:.4}@{weight:.0}"))
            .collect();
        let dropped: Vec<String> = (0..16)
            .filter(|b| count[*b] < MIN_BIN_SAMPLES || !(weight[*b] > 0.0))
            .map(|b| format!("{b}:{}", count[b]))
            .collect();
        eprintln!("  curve toe pairs {}", toe.join(" "));
        eprintln!("  curve toe bins dropped {}", dropped.join(" "));
    }
    (through(&measured, reach), reach as isize)
}

/// Knots the fitted curve is drawn through.
///
/// **The curve is read once per channel, so a colour's hue is decided by the curve's slope at each
/// of its three values** - which is how hue comes to move with brightness, and is the camera's own
/// behaviour. What must not happen is the slope *jumping*, because then hue moves in steps and a
/// gradient renders as flat bands with contours between them. `pool_violators` guarantees jumps:
/// a pooled run is one value repeated, so joining the bins with straight lines gives a flat tread
/// and then a riser. Measured where a neon-lit frame's green and blue read the curve, that ran
/// 0.008 against 3.073 between neighbouring bins, and the hue mapping stepped with it - input hue
/// 0.399, 0.409, 0.420, 0.433 came out 0.454, 0.522, 0.530, 0.592, so a gain of 6.8 then 0.9 then
/// 4.8, and the outputs clustered onto the treads.
///
/// Spaced evenly in the square root of the bin, not in the bin. Evenly spaced knots wide enough to
/// average a run are also wide enough to flatten the toe, where the curve turns hardest and where
/// a channel whose pairs ran out early is extended from - that cost four of the tail tests. In the
/// root, the spacing is about seven bins down in the toe and eighteen up where the runs are, which
/// is what each end needs.
const CURVE_KNOTS: usize = 32;

/// One knot's local fit: the level its window read at the knot, and the slope it read it on.
struct Window {
    here: f64,
    width: f64,
    level: f64,
    slope: f64,
}

impl Window {
    /// What this window's line says at `at`, in bins.
    fn read(&self, at: f64) -> f64 {
        (self.level + self.slope * (at - self.here) / self.width).max(0.0)
    }
}

/// A smooth monotone curve through the pooled bins.
///
/// Monotone cubic (Fritsch-Carlson): the slope is continuous, and with non-decreasing knots every
/// secant is non-negative and a harmonic mean of two non-negative secants is too, so the curve
/// still cannot dip. That is what `pool_violators` is for, kept, without its staircase.
fn through(measured: &[(usize, f64, f64)], reach: usize) -> Vec<f64> {
    let span = reach.max(1) as f64;
    let root = span.sqrt();
    let at_knot = |knot: usize| -> f64 {
        let t = knot as f64 / (CURVE_KNOTS - 1) as f64;
        (t * root).powi(2)
    };

    // Each knot a weighted line through the pooled bins around it, read at the knot, over a window
    // that follows the knot spacing - so a bin the fit trusted more pulls harder and the toe is not
    // averaged with the shoulder. Black is pinned: every camera puts zero at zero.
    let mut fits: Vec<Window> = Vec::with_capacity(CURVE_KNOTS);
    for knot in 0..CURVE_KNOTS {
        let here = at_knot(knot);
        let width = (at_knot((knot + 1).min(CURVE_KNOTS - 1)) - at_knot(knot.saturating_sub(1)))
            .max(2.0)
            / 2.0;
        let (mut held, mut sum_d, mut sum_y, mut sum_dd, mut sum_dy) = (0.0f64, 0.0, 0.0, 0.0, 0.0);
        for &(bin, value, weight) in measured {
            let d = (bin as f64 - here) / width;
            let near = (-0.5 * d * d).exp() * weight;
            held += near;
            sum_d += near * d;
            sum_y += near * value;
            sum_dd += near * d * d;
            sum_dy += near * d * value;
        }
        if !(held > 0.0) {
            let level = fits.last().map_or(0.0, |window| window.level);
            fits.push(Window { here, width, level, slope: 0.0 });
            continue;
        }
        // **A mean of the window rather than a line through it lifts every shadow.** The toe turns
        // hard enough that a window a bin or two wide spans three or four times the camera's
        // answer, so its mean lands near the top of the window instead of at the knot: knot 3 read
        // 0.0101 where its own bins held 0.0060, and the render sat 7 L* over the camera at L* 10.
        let (mean_d, mean_y) = (sum_d / held, sum_y / held);
        let spread = sum_dd / held - mean_d * mean_d;
        let slope = match spread > 1e-6 {
            true => (sum_dy / held - mean_d * mean_y) / spread,
            false => 0.0,
        };
        fits.push(Window { here, width, level: mean_y - slope * mean_d, slope });
    }
    // The knot values are windowed fits and carry the window's sampling noise, which
    // the cubic below draws faithfully - and the curve is read once per channel, so a
    // knot-to-knot wiggle in its slope rotates hue at exactly the knot period, parallel
    // bands along a gradient's iso-level contours. Softened 1-4-6-4-1 before drawing:
    // a quarter of the wiggle, for a doubling of each knot's effective window - which
    // the root spacing keeps narrower than the toe's own turns.
    //
    // Each neighbour *read at this knot* rather than taken at its own, for the reason the line
    // above it exists: averaging five neighbours' own answers across a toe that doubles between
    // knots puts the lift straight back - measured, bin 3 went 0.0059 to 0.0093 again.
    let mut ys: Vec<f64> = (0..CURVE_KNOTS)
        .map(|knot| {
            let here = fits[knot].here;
            let mut total = 0.0;
            for (step, share) in [(-2isize, 1.0), (-1, 4.0), (0, 6.0), (1, 4.0), (2, 1.0)] {
                let at = (knot as isize + step).clamp(0, CURVE_KNOTS as isize - 1) as usize;
                total += share * fits[at].read(here);
            }
            total / 16.0
        })
        .collect();
    ys[0] = 0.0;
    for knot in 1..CURVE_KNOTS {
        ys[knot] = ys[knot].max(ys[knot - 1]);
    }

    let secant: Vec<f64> = (0..CURVE_KNOTS - 1)
        .map(|i| (ys[i + 1] - ys[i]) / (at_knot(i + 1) - at_knot(i)).max(1e-6))
        .collect();
    let mut slope = vec![0.0f64; CURVE_KNOTS];
    slope[0] = secant[0];
    slope[CURVE_KNOTS - 1] = secant[CURVE_KNOTS - 2];
    for knot in 1..CURVE_KNOTS - 1 {
        let (before, after) = (secant[knot - 1], secant[knot]);
        slope[knot] = match before > 0.0 && after > 0.0 {
            true => 2.0 / (1.0 / before + 1.0 / after),
            false => 0.0,
        };
    }

    let mut curve = vec![0.0f64; BINS];
    let mut at = 0usize;
    for bin in 0..=reach.min(BINS - 1) {
        while at + 2 < CURVE_KNOTS && at_knot(at + 1) < bin as f64 {
            at += 1;
        }
        let (x0, x1) = (at_knot(at), at_knot(at + 1));
        let h = (x1 - x0).max(1e-6);
        let t = ((bin as f64 - x0) / h).clamp(0.0, 1.0);
        let (t2, t3) = (t * t, t * t * t);
        curve[bin] = (2.0 * t3 - 3.0 * t2 + 1.0) * ys[at]
            + (t3 - 2.0 * t2 + t) * h * slope[at]
            + (-2.0 * t3 + 3.0 * t2) * ys[at + 1]
            + (t3 - t2) * h * slope[at + 1];
    }
    make_monotone(&mut curve);
    curve
}

/// Makes a set of measured bins non-decreasing by averaging the runs that are not, weighted by
/// what each bin measured over. Isotonic regression, pool-adjacent-violators.
///
/// **A running maximum was doing this and it floored the shadows.** Clamping each bin up to the
/// highest one before it propagates a single over-estimate forward over every bin after it,
/// until the real curve climbs past it - so one noisy low bin becomes a flat band, and every
/// tone under it renders as one value. On IMG_9887 that band covered the whole bottom of the
/// range: every input from 0.001 to 0.05 came out at 0.0554, and three unrelated dark objects
/// rendered 67/66/67 where the camera had 23/20/18, 33/26/20 and 31/25/32.
///
/// Averaging instead moves the outlier *down* toward its neighbours in proportion to how little
/// it saw, which is what the data supports: a bin holding forty pixels has no business setting
/// the floor for a bin holding forty thousand. Monotonicity is still absolute - a curve that
/// dips posterises a gradient - it is just not bought by lifting everything to the worst
/// estimate in the run.
fn pool_violators(points: &mut [(usize, f64, f64)]) {
    // Each block is a run already pooled: its mean, the weight behind it, and how many bins it
    // covers. A new bin below the block before it merges the two and re-checks, because the
    // merged mean can now dip under the block before *that*.
    let mut blocks: Vec<(f64, f64, usize)> = Vec::with_capacity(points.len());
    for &(_, value, weight) in points.iter() {
        let mut block = (value, weight, 1usize);
        while let Some(&(mean, held, span)) = blocks.last() {
            if mean <= block.0 {
                break;
            }
            blocks.pop();
            let total = held + block.1;
            block = ((mean * held + block.0 * block.1) / total, total, span + block.2);
        }
        blocks.push(block);
    }

    let mut at = 0usize;
    for (mean, _, span) in blocks {
        for _ in 0..span {
            points[at].1 = mean;
            at += 1;
        }
    }
}

fn make_monotone(curve: &mut [f64]) {
    for b in 1..BINS {
        if curve[b] < curve[b - 1] {
            curve[b] = curve[b - 1];
        }
    }
}

/// Extends a curve past its data at the slope it ended on.
fn extend_alone(curve: &mut [f64], last: usize) {
    let back = last.saturating_sub(16);
    let slope = if last > back {
        (curve[last] - curve[back]) / ((last - back) as f64 / (BINS - 1) as f64)
    } else {
        1.0
    };
    for b in last + 1..BINS {
        curve[b] = curve[last] + slope * (b - last) as f64 / (BINS - 1) as f64;
    }
    make_monotone(curve);
}

/// The level where the camera's rendering stops expanding chroma and starts compressing
/// it: the highest bin whose log-log slope still reaches one.
///
/// A tone curve steeper than proportional pulls a pixel's channels apart and one
/// flatter pushes them together, so this is the exact level the camera's shoulder
/// begins at - measured 0.40 of the domain on IMG_8584, where the slope runs 1.46 at
/// 0.30 and 0.43 by the ceiling. `colour.slang`'s `curves_at` reads a highlight's colour here.
///
/// The ceiling where no bin expands, which makes the correction a no-op rather than
/// reading a colour off the toe.
pub fn chroma_anchor(curve: &[f64], ceiling: f64) -> f64 {
    // From bin two: the first bin's backward difference is against the curve's own zero, so
    // it reads as exactly proportional whatever the curve does and every search reaches it.
    let expansive = |b: usize| curve[b] > 0.0 && (curve[b] - curve[b - 1]) * b as f64 >= curve[b];
    match (2..BINS).rev().find(|b| expansive(*b)) {
        Some(bin) => ceiling * bin as f64 / (BINS - 1) as f64,
        None => ceiling,
    }
}

impl HdrColour {
    /// A transform that returns its input.
    ///
    /// A fit always produces a real one; this is for the tests and for a caller with no fit
    /// yet, both of which need a known-good transform rather than a fitted one.
    pub fn identity() -> Self {
        let ramp: Vec<f64> =
            (0..BINS).map(|i| (i as f64 / (BINS - 1) as f64) * TRUST_CEILING).collect();
        HdrColour {
            curves: [ramp.clone(), ramp.clone(), ramp],
            ceiling: TRUST_CEILING,
            anchor: TRUST_CEILING,
            matrix: IDENTITY,
            saturation: 1.0,
            chroma: None,
            surround: SurroundThumb::none(),
            delta_e: 0.0,
        }
    }
}

/// How much of the colour model [`evaluate`] runs, as `fit_model.slang` names them.
#[derive(Clone, Copy)]
pub enum Stage {
    Tone,
    ToneMatrix,
    Full,
}

/// A stage's output per sample, on the device: the colour, then its luma - the layout
/// `fit_score.slang` reads as `below`.
pub struct Evaluated {
    pub buffer: crate::gpu::Buffer,
    count: usize,
}

impl Evaluated {
    /// The outputs back on the host, one `[r, g, b, luma]` per sample.
    pub async fn read(&self, gpu: &'static crate::gpu::Gpu) -> Option<Vec<[f32; 4]>> {
        if self.count == 0 {
            return Some(Vec::new());
        }
        let bytes = (self.count * 16) as u64;
        let mut recording = gpu.record();
        let staging = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("fit model out"),
            size: bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        recording.encoder().copy_buffer_to_buffer(&self.buffer, 0, &staging, 0, bytes);
        recording.submit();
        crate::gpu::read_back(gpu, &staging, |mapped| {
            mapped
                .par_chunks_exact(16)
                .map(|word| {
                    std::array::from_fn(|c| {
                        let at = c * 4;
                        f32::from_ne_bytes([word[at], word[at + 1], word[at + 2], word[at + 3]])
                    })
                })
                .collect::<Vec<[f32; 4]>>()
        })
        .await
    }
}

/// `fit_model.slang`'s bindings: `colour.slang`'s model, and the samples in and out.
fn model_device(gpu: &'static crate::gpu::Gpu) -> &'static Kernel {
    static BUILT: std::sync::OnceLock<Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fit_model"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_model.wgsl")).into(),
            ),
        });
        let entry = |binding: u32, ty: wgpu::BindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty,
            count: None,
        };
        let buffer = |ty: wgpu::BufferBindingType| wgpu::BindingType::Buffer {
            ty,
            has_dynamic_offset: false,
            min_binding_size: None,
        };
        let texture = |dimension: wgpu::TextureViewDimension, filterable: bool| {
            wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable },
                view_dimension: dimension,
                multisampled: false,
            }
        };
        let (d2, d3) = (wgpu::TextureViewDimension::D2, wgpu::TextureViewDimension::D3);
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("fit_model"),
            entries: &[
                entry(0, buffer(UNIFORM)),
                // The curves are `r32float` and read by `Load`, which is what the client binds.
                entry(2, texture(d2, false)),
                entry(3, texture(d3, true)),
                entry(4, buffer(READ)),
                entry(5, buffer(READ)),
                entry(6, buffer(WRITE)),
                entry(7, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering)),
                entry(10, texture(d3, true)),
                entry(11, texture(d3, true)),
                entry(20, buffer(UNIFORM)),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fit_model"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        Kernel {
            pipeline: device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("fit_model"),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some("fit_model"),
                compilation_options: Default::default(),
                cache: None,
            }),
            layout,
        }
    })
}

/// The grade whose uniform hands `colour.slang` the fit's own domain: white, reference and
/// exposure at their identities, so a sample is read as itself.
fn probe_grade(colour: &HdrColour) -> crate::gpu::Grade<'_> {
    crate::gpu::Grade {
        width: 1,
        height: 1,
        photograph_long: crate::px::Span::measured(1),
        colour: Some(colour),
        // Every anchor at its identity, which is what lets `fit_model` run the grade's own stages
        // over samples that are already scene-relative.
        white: crate::light::Light::measured(1.0),
        source_level: crate::light::Light::measured(1.0),
        floor: None,
        reference_nits: crate::light::Light::exactly(1.0),
        peak_nits: crate::light::Light::exactly(1.0),
        exposure: crate::light::Stops::ZERO,
        adjust: crate::gpu::Adjust::none(),
        as_shot: None,
        output: crate::gpu::Output::Pq,
        geometry: crate::image::Geometry::none(),
        window: None,
        surround_window: None,
        canvas: None,
    }
}

/// The colour model at each of `samples`, up to `stage`, left on the device.
///
/// A sample is `(r, g, b, surround)`: the scene colour with diffuse white at 1.0, and the
/// neighbourhood's brightness the lattice reads beside it (`surround_plane`).
pub fn evaluate(
    gpu: &'static crate::gpu::Gpu,
    colour: &HdrColour,
    samples: &[[f32; 4]],
    stage: Stage,
) -> Evaluated {
    let mut words = vec![0u8; samples.len().max(1) * 16];
    words.par_chunks_mut(16).zip(samples.par_iter()).for_each(|(word, sample)| {
        for (c, value) in sample.iter().enumerate() {
            word[c * 4..c * 4 + 4].copy_from_slice(&value.to_ne_bytes());
        }
    });
    let input = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit model input"),
        contents: &words,
        usage: wgpu::BufferUsages::STORAGE,
    });
    evaluate_over(gpu, colour, &input, samples.len(), stage)
}

/// [`evaluate`], over samples already on the device.
///
/// Which is every caller inside the fit: `gathered` writes them off the plane the probe is about,
/// and the fit asks dozens of probes about the same pairs.
pub fn evaluate_over(
    gpu: &'static crate::gpu::Gpu,
    colour: &HdrColour,
    input: &crate::gpu::Buffer,
    count: usize,
    stage: Stage,
) -> Evaluated {
    let output = gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some("fit model output"),
        size: (count.max(1) * 16) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    if count == 0 {
        return Evaluated { buffer: output, count };
    }
    let mut recording = gpu.record();
    recording.holding(input);
    let mut init = |label: &str, contents: &[u8], usage: wgpu::BufferUsages| {
        recording.init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents, usage })
    };
    let uniform: Vec<u8> = crate::gpu::uniform_words(&probe_grade(colour), colour)
        .iter()
        .flat_map(|v| v.to_ne_bytes())
        .collect();
    let edits = init("fit model edit", &uniform, wgpu::BufferUsages::UNIFORM);
    let push: Vec<u8> =
        [count as i32, stage as i32, 0, 0].iter().flat_map(|v| v.to_ne_bytes()).collect();
    let push = init("fit model push", &push, wgpu::BufferUsages::UNIFORM);
    let matrix: Vec<u8> =
        colour.matrix.iter().flatten().flat_map(|v| (*v as f32).to_ne_bytes()).collect();
    let matrix = init("fit model matrix", &matrix, wgpu::BufferUsages::STORAGE);
    let (chroma, chroma_luma, chroma_tint) = gpu.lattice(colour);
    let curves = gpu.curves(colour);
    let (chroma, chroma_luma, chroma_tint, curves) =
        (chroma.view(), chroma_luma.view(), chroma_tint.view(), curves.view());
    let kernel = model_device(gpu);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("fit_model"),
        layout: &kernel.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&curves) },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&chroma) },
            wgpu::BindGroupEntry { binding: 4, resource: matrix.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: input.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: output.as_entire_binding() },
            wgpu::BindGroupEntry {
                binding: 7,
                resource: wgpu::BindingResource::Sampler(gpu.sampler()),
            },
            wgpu::BindGroupEntry {
                binding: 10,
                resource: wgpu::BindingResource::TextureView(&chroma_luma),
            },
            wgpu::BindGroupEntry {
                binding: 11,
                resource: wgpu::BindingResource::TextureView(&chroma_tint),
            },
            wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel.pipeline);
        pass.set_bind_group(0, &group, &[]);
        let (across, down) = crate::base::groups(count);
        pass.dispatch_workgroups(across, down, 1);
    }
    recording.submit();
    Evaluated { buffer: output, count }
}

/// [`evaluate`], read back: the stage's colour and luma at each sample.
pub async fn evaluated(
    gpu: &'static crate::gpu::Gpu,
    colour: &HdrColour,
    samples: &[[f32; 4]],
    stage: Stage,
) -> Option<Vec<[f32; 4]>> {
    evaluate(gpu, colour, samples, stage).read(gpu).await
}

fn gather_device(gpu: &'static crate::gpu::Gpu) -> &'static Kernel {
    static BUILT: std::sync::OnceLock<Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        kernel(
            gpu,
            "fit_gather",
            include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_gather.wgsl")),
            &[(0, READ), (1, READ), (2, READ), (3, WRITE), (20, UNIFORM)],
            &[],
        )
    })
}

/// A resident plane on the host, for a caller that wants to look at one.
pub async fn read_plane(gpu: &'static crate::gpu::Gpu, plane: &Source) -> Option<Plane> {
    let mut recording = gpu.record();
    let out = staged(&mut recording, &plane.buffer, plane.pixels() * 3);
    recording.submit();
    plane_read(gpu, &out, plane.width, plane.height).await
}

/// A plane where the passes that read it are: interleaved f32 RGB, never on the host.
pub struct Source {
    pub buffer: crate::gpu::Buffer,
    pub width: usize,
    pub height: usize,
}

impl Source {
    fn pixels(&self) -> usize {
        self.width * self.height
    }
}

/// `(r, g, b, surround)` at each of `at`'s pixels of `plane`, as [`evaluate_over`] reads them.
///
/// `surround` is `None` for every probe below the lattice, which never reads the fourth component.
fn gathered(
    gpu: &'static crate::gpu::Gpu,
    plane: &Source,
    at: &crate::gpu::Buffer,
    count: usize,
    surround: Option<&crate::gpu::Buffer>,
) -> crate::gpu::Buffer {
    let samples = gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some("fit gather samples"),
        size: (count.max(1) * 16) as u64,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    if count == 0 {
        return samples;
    }
    let mut recording = gpu.record();
    recording.holding(&plane.buffer);
    recording.holding(at);
    if let Some(surround) = surround {
        recording.holding(surround);
    }
    let idle = unused_buffer(&mut recording);
    let block: Vec<u8> =
        [count as i32, plane.pixels() as i32, i32::from(surround.is_some()), 0]
            .iter()
            .flat_map(|v| v.to_ne_bytes())
            .collect();
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit gather push"),
        contents: &block,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let built = gather_device(gpu);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("fit_gather"),
        layout: &built.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: plane.buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: at.as_entire_binding() },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: surround.unwrap_or(&idle).as_entire_binding(),
            },
            wgpu::BindGroupEntry { binding: 3, resource: samples.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&built.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((count as u32).div_ceil(64), 1, 1);
    }
    recording.submit();
    samples
}

/// One matrix row, least squares subject to its three terms summing to one.
///
/// The constraint enters as a Lagrange multiplier, which makes it a 4x4 solve on the
/// bordered system: `ata` with a row and column of ones, and the multiplier last.
fn neutral_row(ata: &[[f64; 3]; 3], rhs: &[f64; 3]) -> Option<[f64; 3]> {
    let mut m = [[0.0f64; 5]; 4];
    for i in 0..3 {
        m[i][..3].copy_from_slice(&ata[i]);
        m[i][3] = 1.0;
        m[i][4] = rhs[i];
    }
    m[3] = [1.0, 1.0, 1.0, 0.0, 1.0];

    for col in 0..4 {
        let pivot = (col..4).max_by(|a, b| m[*a][col].abs().total_cmp(&m[*b][col].abs()))?;
        m.swap(col, pivot);
        if m[col][col].abs() < 1e-12 {
            return None;
        }
        for row in 0..4 {
            if row == col {
                continue;
            }
            let factor = m[row][col] / m[col][col];
            for k in col..5 {
                m[row][k] -= factor * m[col][k];
            }
        }
    }
    Some([m[0][4] / m[0][0], m[1][4] / m[1][1], m[2][4] / m[2][2]])
}

/// Gauss-Jordan on a 3x3, returning None rather than garbage when singular.
fn solve_row(matrix: &[[f64; 3]; 3], rhs: &[f64; 3]) -> Option<[f64; 3]> {
    let mut m = [[0.0f64; 4]; 3];
    for i in 0..3 {
        m[i][..3].copy_from_slice(&matrix[i]);
        m[i][3] = rhs[i];
    }
    for col in 0..3 {
        let mut pivot = col;
        for row in col + 1..3 {
            if m[row][col].abs() > m[pivot][col].abs() {
                pivot = row;
            }
        }
        m.swap(col, pivot);
        if m[col][col].abs() < 1e-12 {
            return None;
        }
        for row in 0..3 {
            if row == col {
                continue;
            }
            let factor = m[row][col] / m[col][col];
            for k in col..4 {
                m[row][k] -= factor * m[col][k];
            }
        }
    }
    Some([m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]])
}

/// Rec.2020 linear to sRGB linear - the primaries conversion, and nothing else.
///
/// A fixed 3x3, because the two share a white point and so there is no chromatic
/// adaptation in it. This is what `zscale`'s `pin=bt2020 ... p=bt709` was doing for the
/// SDR still (sRGB and BT.709 have the same primaries and differ only in transfer), and
/// it is here rather than there so the still's encode can stay in this process.
///
/// Returned rather than applied, so a caller converting a whole frame builds it once.
pub fn rec2020_to_srgb() -> [[f64; 3]; 3] {
    multiply(&XYZ_TO_SRGB, &REC2020_TO_XYZ)
}

pub fn srgb_to_rec2020() -> [[f64; 3]; 3] {
    multiply(&XYZ_TO_REC2020, &SRGB_TO_XYZ)
}

/// One matrix out of `slang/primaries.slang`, in the order `float3x3` takes rows.
///
/// The shader carries every conversion as a literal and a literal is a copy, so each is held
/// against what this crate derives - `the_primaries_match_the_host` and
/// `the_cone_matrices_are_what_they_are_derived_from`, which sit in different modules and read
/// the one file through this.
#[cfg(test)]
pub fn in_the_shader(name: &str) -> [[f64; 3]; 3] {
    let source = include_str!("../../../slang/primaries.slang");
    let start = source.find(&format!("{name} = float3x3")).expect("the constant is there");
    let body = &source[start..source[start..].find(");").expect("it is closed") + start];
    let found: Vec<f64> = body
        .split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
        .filter(|s| s.contains('.'))
        .filter_map(|s| s.parse().ok())
        .collect();
    assert_eq!(found.len(), 9, "parsed {found:?} out of {body}");
    [
        [found[0], found[1], found[2]],
        [found[3], found[4], found[5]],
        [found[6], found[7], found[8]],
    ]
}

/// The sRGB transfer, IEC 61966-2-1. Out-of-gamut values clamp, which is what zimg does
/// with them too - neither of us is gamut-mapping, just refusing to encode a negative.
pub fn srgb_oetf(value: f64) -> f64 {
    let c = value.clamp(0.0, 1.0);
    if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

/// The camera's rendering as the fit will compare against it, and the weights and pair
/// list every comparison uses, worked out once.
///
/// The fit measures itself dozens of times over - six ridge candidates at each of three
/// rounds, then the saturation sweep and its refinement - and none of this changes between
/// them.
struct Pairs {
    at: Vec<usize>,
    /// `at` and `greys` on the device, which is where every probe gathers its samples from.
    indices: crate::gpu::Buffer,
    grey_indices: crate::gpu::Buffer,
    /// The camera's rendering, in the render's own linear Rec.2020. `fit_score.slang` takes it
    /// to sRGB, onto the JPEG's 255 steps and to Lab once per upload, and every probe compares
    /// against that.
    target: Vec<[f64; 3]>,
    balance: Vec<f64>,
    to_srgb: [[f64; 3]; 3],
    /// The pairs that are neutral in *either* image, and what the camera renders them as.
    /// Which pixels those are is a fact about the two inputs, so it does not change as
    /// the fit moves underneath it, and neither does the sum being matched.
    greys: Vec<usize>,
    grey_target: [f64; 3],
    /// `target` and `balance` on the device, built the first time a kernel asks for them.
    linear: std::cell::OnceCell<crate::gpu::Buffer>,
}

impl Pairs {
    /// The camera's rendering and the hue balance beside it, where a kernel can read them.
    ///
    /// **Not `fit_score`'s copy of the same numbers.** `fit_target` rewrites that one in place as
    /// Lab before any probe sees it, and the normal equations want the linear Rec.2020 it was
    /// before. Held here rather than uploaded per call because neither the pairs nor their
    /// targets move while the fit alternates over them.
    fn linear_on(&self, gpu: &'static crate::gpu::Gpu) -> &crate::gpu::Buffer {
        self.linear.get_or_init(|| {
            let mut bytes = vec![0u8; self.at.len().max(1) * 16];
            for (word, (t, balance)) in
                bytes.chunks_exact_mut(16).zip(self.target.iter().zip(self.balance.iter()))
            {
                for c in 0..3 {
                    word[c * 4..][..4].copy_from_slice(&(t[c] as f32).to_ne_bytes());
                }
                word[12..].copy_from_slice(&(*balance as f32).to_ne_bytes());
            }
            gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("fit pairs linear"),
                contents: &bytes,
                usage: wgpu::BufferUsages::STORAGE,
            })
        })
    }
}

/// A pixel list where the gather reads it.
fn indices_on(gpu: &'static crate::gpu::Gpu, at: &[usize]) -> crate::gpu::Buffer {
    let mut bytes = vec![0u8; at.len().max(1) * 4];
    bytes.par_chunks_mut(4).zip(at.par_iter()).for_each(|(word, p)| {
        word.copy_from_slice(&(*p as u32).to_ne_bytes());
    });
    gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit gather at"),
        contents: &bytes,
        usage: wgpu::BufferUsages::STORAGE,
    })
}

/// One pair in every this many is held back from the fit and used to judge it.
///
/// A fifth, which is enough to score on and cheap to give up: the stages that read these
/// have tens of thousands and none of them is short of data.
///
/// Strided rather than blocked, so both halves see the whole frame. A contiguous split would
/// hand the fit one part of the picture and judge it on another, which measures how alike
/// two regions are as much as it measures the model.
///
/// **Holding out by region instead does not buy what it looks like it buys**, and `MAP_CHROMA`
/// has the measurement: a lattice memorises colours rather than places, the same lawn is on
/// both sides of any partition of one photograph, and blocking by region leaves held-out
/// `delta_e` preferring a finer grid exactly as the stride does - while the render says the
/// opposite. What separates them is the picture, not the split.
const HOLDOUT_EVERY: usize = 5;

impl Pairs {
    /// The pairs a stage may fit from, and the ones it is judged on.
    ///
    /// **A model is only as trustworthy as the data it was not shown.** A gate that scores on
    /// the pairs the thing it gates was fitted from measures how well a stage memorised its own
    /// inputs, which is what makes capacity look free: a finer lattice fits its own pairs 15%
    /// better, moves the render 2%, makes the bird bath's cast 35% worse, and the number such a
    /// gate reads goes *down* through all of it. `DESIGN`'s falloff keeps its term on held-out
    /// pairs for the same reason.
    fn split(&self, gpu: &'static crate::gpu::Gpu) -> (Pairs, Pairs) {
        let held = |k: usize| k % HOLDOUT_EVERY == 0;
        let take = |want_held: bool| {
            let at: Vec<usize> = self.at.iter().enumerate()
                .filter(|(k, _)| held(*k) == want_held).map(|(_, v)| *v).collect();
            Pairs {
                indices: indices_on(gpu, &at),
                at,
                target: self.target.iter().enumerate().filter(|(k, _)| held(*k) == want_held)
                    .map(|(_, v)| *v).collect(),
                balance: self.balance.iter().enumerate().filter(|(k, _)| held(*k) == want_held)
                    .map(|(_, v)| *v).collect(),
                to_srgb: self.to_srgb,
                // Both halves keep the whole grey set. `grey_balance` is not gated on anything,
                // so there is nothing to hold out from, and halving it would only make the
                // neutral axis noisier on the frames that have fewest greys to begin with.
                greys: self.greys.clone(),
                grey_indices: self.grey_indices.clone(),
                grey_target: self.grey_target,
                linear: std::cell::OnceCell::new(),
            }
        };
        (take(false), take(true))
    }

    /// Every `stride`th pair, for a probe whose answer is a choice between coarse alternatives
    /// rather than a number anything keeps.
    fn every(&self, gpu: &'static crate::gpu::Gpu, stride: usize) -> Pairs {
        let at: Vec<usize> = self.at.iter().step_by(stride).copied().collect();
        Pairs {
            indices: indices_on(gpu, &at),
            at,
            target: self.target.iter().step_by(stride).copied().collect(),
            balance: self.balance.iter().step_by(stride).copied().collect(),
            to_srgb: self.to_srgb,
            greys: Vec::new(),
            grey_indices: indices_on(gpu, &[]),
            grey_target: self.grey_target,
            linear: std::cell::OnceCell::new(),
        }
    }

    /// Every pixel of two planes as a pair, weighted alike: the shape a test builds when what it
    /// is measuring is a stage downstream of the selection rather than the selection.
    #[cfg(test)]
    fn over(gpu: &'static crate::gpu::Gpu, render: &Plane, jpeg: &Plane) -> Pairs {
        let neutral = |plane: &[f64], i: usize| {
            let t = [plane[i], plane[i + 1], plane[i + 2]];
            let high = t[0].max(t[1]).max(t[2]);
            high > GREY_FLOOR && (high - t[0].min(t[1]).min(t[2])) / high < GREY_CHROMA
        };
        let at: Vec<usize> = (0..render.width * render.height).collect();
        let mut greys = Vec::new();
        let mut grey_target = [0.0f64; 3];
        for p in at.iter().copied() {
            if !neutral(&jpeg.data, p * 3) && !neutral(&render.data, p * 3) {
                continue;
            }
            greys.push(p);
            for c in 0..3 {
                grey_target[c] += jpeg.data[p * 3 + c];
            }
        }
        Pairs {
            target: at.iter().map(|p| [0, 1, 2].map(|c| jpeg.data[p * 3 + c])).collect(),
            balance: vec![1.0; at.len()],
            indices: indices_on(gpu, &at),
            at,
            to_srgb: rec2020_to_srgb(),
            grey_indices: indices_on(gpu, &greys),
            greys,
            grey_target,
            linear: std::cell::OnceCell::new(),
        }
    }

}

/// One probe's blocks into its two answers: the mean deltaE, hue-balanced and flat.
///
/// The fold is `blocks` additions per probe - nothing beside the 150k evaluations behind it on
/// the device - and it is where the bias pooling and the two weightings live, which want `f64`.
fn folded(blocks: impl IntoIterator<Item = crate::fit_score::Partial>) -> (f64, f64) {
    let (mut balanced, mut flat, mut n, mut counted) = (0.0, 0.0, 0.0f64, 0.0f64);
    let (mut gamut_balanced, mut gamut_flat, mut n_all, mut counted_all) = (0.0, 0.0, 0.0f64, 0.0f64);
    let mut bias = [[0.0f64; 2]; BIAS_BUCKETS];
    let mut seen = [0.0f64; BIAS_BUCKETS];
    for part in blocks {
        balanced += part.balanced;
        flat += part.flat;
        n += part.weight;
        counted += part.trusted;
        gamut_balanced += part.gamut_balanced;
        gamut_flat += part.gamut_flat;
        n_all += part.weight_all;
        counted_all += part.counted;
        for i in 0..BIAS_BUCKETS {
            bias[i][0] += part.bias[i][0];
            bias[i][1] += part.bias[i][1];
            seen[i] += part.seen[i];
        }
    }
    // Bias and scatter weighted apart. The residual's size splits into a systematic
    // part and a random one, and they are not equally visible: a wall a little green
    // everywhere is a defect, the same error scattered is texture. Averaged inside a
    // bucket rather than over the frame, or a green cast on the neutrals and a warm
    // one on the saturates cancel and the number reads clean.
    let population: f64 = seen.iter().sum::<f64>().max(1.0);
    let cast: f64 = (0..BIAS_BUCKETS)
        .filter(|i| seen[*i] > 0.0)
        .map(|i| {
            let (da, db) = (bias[i][0] / seen[i], bias[i][1] / seen[i]);
            (seen[i] / population) * da.hypot(db)
        })
        .sum();
    let mean = flat / counted.max(1.0);
    (
        balanced / n.max(1e-9) + BIAS_WEIGHT * cast + GAMUT_WEIGHT * gamut_balanced / n_all.max(1e-9),
        mean + BIAS_WEIGHT * cast + GAMUT_WEIGHT * gamut_flat / counted_all.max(1.0),
    )
}

/// Three bands of the camera's chroma against three of its lightness.
pub(crate) const BIAS_BUCKETS: usize = 9;

/// How much a unit of systematic bias counts against a unit of average error.
const BIAS_WEIGHT: f64 = 3.0;

/// How much a unit of gamut excursion counts against a unit of average error.
///
/// `fit_score.slang`'s `excursion` is the fraction of a colour's chroma the hull would take off,
/// so a whole unit is a colour with no grey of its luma left to pull towards, and this is the
/// deltaE that is taken to be worth. The camera's rendering is an sRGB JPEG and a deltaE against
/// it reads zero for anything past its hull - `lab_of` clamps first, and the target clipped
/// there is not a pair at all - so without this term the objective is blind in exactly the
/// direction a matrix with a large negative off-diagonal errs. DSC03422's red hood: the camera at
/// sRGB (181, 0, 1), the fit's choice at green a thousandth of red in Rec.2020, a hundredfold
/// past the hull's tenth, and every score of the day identical on it.
const GAMUT_WEIGHT: f64 = 30.0;

/// `prelude.slang`'s `GAMUT_FLOOR`, held against the shader by
/// `the_gamut_floor_is_the_one_the_shader_declares`: where the grade holds a colour's lowest
/// channel, as a fraction of its luma.
pub const GAMUT_FLOOR: f64 = 0.02;

/// `prelude.slang`'s `in_gamut` on the host, for the tests that hold a pass to it: the lowest
/// channel eased into [`GAMUT_FLOOR`] of the luma through a knee at twice that, the luma kept.
pub fn in_gamut(v: [f64; 3]) -> [f64; 3] {
    // The positive part's luma, as the shader takes it: a negative channel is why this is reached
    // and green's weight is the largest of the three, so the triple's own luma subtracts the
    // out-of-gamut channel from the in-gamut ones. `prelude.slang` carries the measurement.
    let luma: f64 = (0..3).map(|c| LUMA[c] * v[c].max(0.0)).sum();
    if luma <= 0.0 {
        return [0.0; 3];
    }
    let x = v.iter().copied().fold(f64::INFINITY, f64::min) / luma;
    if x >= 2.0 * GAMUT_FLOOR {
        return v;
    }
    let held = GAMUT_FLOOR * (1.0 + ((x - 2.0 * GAMUT_FLOOR) / GAMUT_FLOOR).exp());
    let scale = (1.0 - held) / (1.0 - x);
    let pulled: [f64; 3] = std::array::from_fn(|c| luma + (v[c] - luma) * scale);
    // The mix keeps the triple's weighted mean, not the positive part's, so the target is restored
    // by a uniform scale - a brightness rather than a hue, and one the floor is invariant under.
    let achieved: f64 = (0..3).map(|c| LUMA[c] * pulled[c]).sum();
    pulled.map(|v| v * luma / achieved.max(1e-12))
}

/// The same trade, inside the per-node least squares where it can actually shape a map.
const BIAS_LAMBDA: f64 = 4.0;

/// The mean deltaE over the pairs, hue-balanced and flat.
///
/// Both, because the two answer different questions - what the camera does, and what
/// the picture will look like - the stages here disagree about which one they are
/// asking, and the one that wants both wants them for the same matrix.
async fn measure(
    gpu: &'static crate::gpu::Gpu,
    colour: &HdrColour,
    render: &Source,
    surround: &crate::gpu::Buffer,
    pairs: &Pairs,
) -> Option<(f64, f64)> {
    let count = pairs.at.len();
    let samples = gathered(gpu, render, &pairs.indices, count, Some(surround));
    let below = evaluate_over(gpu, colour, &samples, count, Stage::Full);
    scored_as_is(&scoring_over(gpu, pairs, below.buffer)).await
}

async fn untransformed(
    gpu: &'static crate::gpu::Gpu,
    render: &Source,
    pairs: &Pairs,
) -> Option<(f64, f64)> {
    let count = pairs.at.len();
    // The gather's own layout is what `fit_score.slang` reads a `below` plane as - a colour and
    // the luma a saturation blend rotates about, which this probe does not use.
    let below = gathered(gpu, render, &pairs.indices, count, None);
    scored_as_is(&scoring_over(gpu, pairs, below)).await
}

/// The held colours scored as they are: the neutral probe, which the shader short-circuits.
async fn scored_as_is(scoring: &crate::fit_score::Scoring) -> Option<(f64, f64)> {
    let neutral = [crate::fit_score::Probe::neutral()];
    let mut partials = scoring.partials(&crate::fit_score::Shape::Saturation, &neutral).await?;
    Some(folded(partials.remove(0)))
}

/// Pairs per block of the matrix's moments, summed in order: the block shape is part of the
/// summation order and so part of the answer, and a fold that followed rayon's scheduling
/// would fit a different matrix run to run.
const MEASURE_BLOCK: usize = 4096;

/// Hues the frame is divided into before its pairs are counted, plus one bucket for
/// everything too close to grey to have a hue at all.
pub(crate) const HUE_BINS: usize = 12;

/// How far a bin's weight may be pushed from parity, either way.
///
/// Balancing without a bound hands a frame's rarest few pixels the whole fit: forty
/// magenta pixels against forty thousand green ones would each count for a thousand,
/// and a fit driven by forty pixels is noise. Bounded, a dominant hue loses most of its
/// advantage while a rare one cannot take over.
///
/// Measured on IMG_8789: raising it to 8, 16 or 64 moves the fit by 0.1 of a level,
/// because the dominant bin is already at the cap and what is left is not the
/// weighting's to fix.
const BALANCE_LIMIT: f64 = 4.0;

/// Levels the curve fit's pairs are counted over, and how far parity may push one, on the
/// square root the lattice's own level axis uses.
pub(crate) const LEVEL_BINS: usize = 12;
pub(crate) const LEVEL_BALANCE_LIMIT: f64 = 2.0;

/// The same bound for the chroma lattice, which can afford far more of it.
///
/// `BALANCE_LIMIT` is set by what a *global* fit can survive: the matrix and the curves are
/// one answer for the whole frame, so letting forty rare pixels outvote forty thousand is
/// how a fit ends up driven by noise. A lattice node is not that. It is solved from the
/// pairs that land near it and moves nothing else, so weighting a rare hue heavily changes
/// only the region of colour space that hue occupies.
///
/// Sized off what the fit is asked to represent rather than picked: a small saturated
/// object covers a fraction of a percent of a frame, so it needs about two orders of
/// magnitude to hold its own node against the surroundings it shares one with.
const MAP_BALANCE_LIMIT: f64 = 1024.0;

/// Everything a weighted least squares needs from a set of pairs, and nothing that
/// scales with how many there were.
#[derive(Default, Clone)]
struct Moments {
    ata: [[f64; 3]; 3],
    atb: [[f64; 3]; 3],
}

impl Moments {
    /// One pair into the normal equations, which is what `fit_moments.slang` does over all of
    /// them. Here for the tests that state a set of pairs directly and ask what matrix they want;
    /// nothing on the fit's path builds a moment a pair at a time.
    #[cfg(test)]
    fn add(&mut self, w: f64, v: &[f64; 3], y: &[f64]) {
        for a in 0..3 {
            for b in 0..3 {
                self.ata[a][b] += w * v[a] * v[b];
            }
            for o in 0..3 {
                self.atb[o][a] += w * v[a] * y[o];
            }
        }
    }

    fn trace(&self) -> f64 {
        self.ata[0][0] + self.ata[1][1] + self.ata[2][2]
    }

    /// The matrix this set asks for, damped by `ridge` towards the identity, and held
    /// to leaving a neutral neutral.
    ///
    /// Each row is solved subject to summing to one, so `(x, x, x)` maps to `(x, x, x)`
    /// however large the off-diagonals grow. That is the constraint the ridge was
    /// standing in for and the one it could not express: what a wild matrix actually
    /// does is tint the greys - and worst of all above the fit domain, where the
    /// highlights are extrapolated and no pair is there to object. Constrained, the
    /// cross-channel freedom a brown needs costs a grey nothing.
    fn solve(&self, ridge: f64) -> [[f64; 3]; 3] {
        let mut ata = self.ata;
        let mut atb = self.atb;
        let scale = self.trace();
        for i in 0..3 {
            ata[i][i] += ridge * scale;
            atb[i][i] += ridge * scale;
        }
        std::array::from_fn(|o| {
            neutral_row(&ata, &atb[o]).or_else(|| solve_row(&ata, &atb[o])).unwrap_or(IDENTITY[o])
        })
    }
}

/// The ridges tried, log-spaced around the fixed one this replaced, most damped first
/// so that a frame which cannot choose between them keeps the safe end.
const RIDGE_CANDIDATES: [f64; 6] = [0.15, 0.05, 0.02, 0.008, 0.002, 0.0005];

/// One pixel in this many along each axis carries `FRAME`, which is the set every candidate is
/// scored on beside the pairs. A sixteenth of the plane, enough to say what a candidate does to a
/// picture and cheap enough to ask of seven candidates a round.
pub(crate) const FRAME_STRIDE: usize = 4;

/// The matrix, at the least damping this frame can support.
///
/// A fixed ridge cannot serve both ends of what arrives here. Damping exists because a
/// frame whose colours all sit near the grey axis cannot constrain nine free parameters;
/// but held at the value such a frame needs, a frame that *can* constrain one does not
/// get it - IMG_8789 has saturated grass and saturated browns, its camera scales green
/// by 0.884 on the one and 0.690 on the other, only the off-diagonals can say that, and
/// damped to near-identity they cannot. The dogs come out olive however the pairs are
/// weighted.
///
/// So the frame chooses, on the sum of two scores. The pairs are asked with the same hue
/// balance the fit uses, because that is the question the balance exists to ask - an even
/// score lets 120k pairs of lawn outvote 16k of dog and picks the ridge that suits grass.
/// The picture is asked evenly, because a picture is seen by area, and on some frames the
/// pairs are not a sample of it at all: `FRAME` in `fit_pairs.slang` carries that argument
/// and the set it selects. IMG_9808 is why the picture has a voice - sky and snow, no colour
/// spread to pin nine parameters down, and the least damped candidate came back with a blue
/// row of `[-0.285, -0.334, 1.619]` that reads as an improvement hue-balanced while the
/// hillside renders acid yellow-green and the frame's own deltaE doubles.
///
/// **A sum, not a veto.** Refusing any candidate more than a margin worse on the picture and
/// falling to the next rung is a cliff: a frame a hair past the margin loses the whole
/// matrix, and the rung it lands on may be the identity, which is a different photograph.
/// Summed, the picture's loss is weighed against the pairs' gain in the same units, and what
/// the choice does as a frame drifts is drift with it.
///
/// The residual the solve itself minimises was tried for this and is close to useless:
/// it is the quantity every candidate is optimising, in a space where a wild matrix
/// looks fine, and on a near-neutral frame all of them score it identically to the last
/// bit so the choice fell to list order.
/// The candidates a frame's moments offer, or nothing where they offer only one.
///
/// Split from the choosing below so the scoring between them can be awaited: the six differ only
/// in their matrix, which is a shape `fit_score` asks about in one dispatch.
fn ridge_candidates(whole: &Moments) -> Option<Vec<[[f64; 3]; 3]>> {
    // The identity ahead of the ridges, as the damped end of the same scale rather than a special
    // case: the most damped ridge is still solved from the pairs, so on a frame whose pairs are not
    // the picture it can contradict the picture too. It wins where it scores best, which is what
    // "most damped first" already promises on a frame that cannot tell it from one.
    (whole.trace() > 0.0).then(|| {
        std::iter::once(IDENTITY).chain(RIDGE_CANDIDATES.iter().map(|r| whole.solve(*r))).collect()
    })
}

fn fitted_matrix(
    matrices: &[[[f64; 3]; 3]],
    scores: &[(f64, f64)],
    frame_scores: &[(f64, f64)],
) -> [[f64; 3]; 3] {
    let mut best: Option<(&[[f64; 3]; 3], f64)> = None;
    for ((matrix, (balanced, _)), (_, even)) in matrices.iter().zip(scores).zip(frame_scores) {
        let score = balanced + even;
        // Written to reject rather than to accept, so a score that is not a number falls out
        // here instead of passing a comparison that is false either way - which would let it
        // latch as the winner. Nothing reachable produces one today; `to_levels` clamps its
        // input, so the deltaE is finite even for a wild matrix.
        if !score.is_finite() {
            continue;
        }
        // Strictly better, and the candidates run most damped first, so a frame that
        // cannot tell them apart keeps the safe end rather than whichever came first.
        if best.is_none_or(|(_, held)| score < held) {
            best = Some((matrix, score));
        }
    }
    *best.map_or(&matrices[0], |(matrix, _)| matrix)
}

/// Which bucket every pair's hue landed in, and how many landed in each.
///
/// Kept apart from the weighting because the weighting is asked for twice, at the curve fit's
/// limit and at the chroma map's, and a hue angle per pair is all of the cost and none of the
/// difference between them.
struct HueCensus {
    of: Vec<u8>,
    counted: Vec<usize>,
    total: usize,
}

impl HueCensus {
    /// What one pixel counts for, under a weighting `hue_balance` worked out per bucket.
    fn weigh(&self, weights: &[f64], p: usize) -> f64 {
        weights[usize::from(self.of[p])]
    }
}

/// How much each pair counts, so that what a frame is *of* does not decide what the
/// camera is taken to do.
///
/// The fit minimises error over every pair equally, so a frame that is mostly one
/// colour is fitted to that colour: on IMG_8789, a lawn, the fit lands within ΔE 2.96
/// of the camera and still renders the two brown dogs olive, because the dogs are a
/// small enough share of the pairs that their error costs it almost nothing. The
/// held-out ΔE cannot see it either - 2.961 against 2.995 across settings that move the
/// dogs by three levels - which is why this went unnoticed while the number looked fine.
///
/// So a pair counts for the reciprocal of how common its hue is. The grass shapes the
/// fit where the fit is about grass, and not what happens to a dog.
/// Hue is taken from the camera's rendering rather than the render, since that is the
/// thing being matched, and low-chroma pixels share one bucket because a hue angle
/// measured on a grey is noise.
///
/// One weight a bucket, not a plane of them: whoever wants a pixel's weight has its bucket
/// already, in `HueCensus::of` or in the byte `fit_pairs.slang` packed above the mask.
fn hue_balance(census: &HueCensus, limit: f64) -> Vec<f64> {
    let HueCensus { counted, total, .. } = census;

    let occupied = counted.iter().filter(|n| **n > 0).count().max(1);
    let parity = *total as f64 / occupied as f64;
    counted
        .iter()
        .map(|n| match *n {
            // Counted over pairs usable for all three channels, but read back per
            // channel by `fit_curves`, where a pixel needs only its own channel in
            // range. A hue that shows up only on such pixels is censused at zero, and
            // weighting it zero drops it from that channel's curve entirely rather than
            // merely declining to favour it - which is the opposite of what the
            // per-channel mask is for. Unseen means unknown here, so it counts as one.
            0 => 1.0,
            n => (parity / n as f64).clamp(1.0 / limit, limit),
        })
        .collect()
}

/// How many times the curves and the matrix are fitted against each other.
///
/// Three, matching the falloff's alternation in `fit.rs`: the second round is where the
/// cross-channel part moves out of the curves and into the matrix, and the third
/// settles it.
const FIT_ROUNDS: usize = 3;

/// The tone curve, one shape shared by all three channels.
///
/// **Shared, and that is the whole point.** Fitted a channel at a time, nothing ties the
/// three together, so a frame whose green channel is sampled from different objects than
/// its red lands them apart - and a curve is indexed by a channel's *value*, so it cannot
/// tell grass from a grey of the same green. The correction meant for the lawn then lands
/// on every neutral at that level. Measured on IMG_8789 by feeding the fitted model a pure
/// grey: +27 counts of green at mid level, from a frame containing no green greys. That is
/// the wash over the bird bath, the cushion and the dogs' pale fur.
///
/// One shape cannot do that: a shared curve is a function of the pixel, applied identically
/// to r, g and b, so a grey in is a grey out however the curve bends. What is given up is
/// the ability to say "this camera lifts green harder here", and that has to live
/// *somewhere*, or the frames whose channels really do render differently break - which is
/// exactly what happened the last time the three were held to one shape.
///
/// It lives in the lattice now. `ChromaMap` is indexed by chroma *and* level, so it can say
/// "grass at this level goes greener" while leaving a grey at that same level alone - the
/// distinction a per-channel curve is structurally unable to draw. The neutral axis on top
/// of this is `grey_balance`, one scalar per channel, which is a white balance rather than a
/// shape and so cannot reintroduce the divergence.
///
/// `inverse` undoes the matrix from the camera's rendering first, so what the curve is
/// asked to reproduce is only the part a tone curve can: on the first round there is no
/// matrix yet and the target is the rendering itself.
///
/// The binning behind it - every usable channel of every usable pixel, weighted by hue and then by
/// level - is `slang/fit_curve.slang`. `LEVEL_BALANCE_LIMIT` has why the second weighting exists.
async fn fit_curves(
    gpu: &'static crate::gpu::Gpu,
    evidence: &crate::fit_curve::Evidence,
    hue_weights: &[f64],
    ceiling: f64,
    inverse: Option<&[[f64; 3]; 3]>,
) -> Option<([Vec<f64>; 3], f64)> {
    let binned = crate::fit_curve::binned(gpu, evidence, hue_weights, ceiling, inverse).await?;
    let (mut curve, last) = fit_curve(&binned);
    if let Ok(last) = usize::try_from(last) {
        extend_alone(&mut curve, last);
    }
    let anchor = chroma_anchor(&curve, ceiling);
    Some(([curve.clone(), curve.clone(), curve], anchor))
}

/// How close to grey the camera has to render a pixel for it to count as neutral, and
/// how many such pixels are needed before their average is worth acting on.
pub(crate) const GREY_CHROMA: f64 = 0.06;
const MIN_GREY: u64 = 200;

/// Pulls the transform's neutral axis onto the camera's.
///
/// Nothing else in the model can. The matrix's rows sum to one, so it maps a grey to a
/// grey and cannot move one that arrives already tinted; the chroma curve scales chroma
/// about the luma axis, which is a no-op on a grey. That leaves the three tone curves,
/// and they are fitted one channel at a time from whatever content sits at each level -
/// nothing ties them to each other, so a frame whose green channel is sampled from
/// different objects than its red lands them apart and every grey in the picture picks
/// up the difference. On IMG_8789 that was +2.3% green on the pixels the camera renders
/// neutral, which is the wash across the whites and the dogs' pale fur.
///
/// So the frame's own greys say what the gains should be, and the curves are scaled to
/// meet them. Bounded, because a frame with few greys should nudge this rather than
/// swing it, and skipped entirely where there are too few to average.
async fn grey_balance(
    gpu: &'static crate::gpu::Gpu,
    colour: &mut HdrColour,
    render: &Source,
    pairs: &Pairs,
) -> Option<()> {
    if (pairs.greys.len() as u64) < MIN_GREY {
        return Some(());
    }
    // Surround of zero, because this runs inside the rounds, before any lattice exists - with
    // `chroma` still `None` the surround is never read.
    let samples = gathered(gpu, render, &pairs.grey_indices, pairs.greys.len(), None);
    let mut ours = [0.0f64; 3];
    for v in evaluate_over(gpu, colour, &samples, pairs.greys.len(), Stage::Full).read(gpu).await? {
        for c in 0..3 {
            ours[c] += f64::from(v[c]);
        }
    }
    for c in 0..3 {
        let gain = (pairs.grey_target[c] / ours[c].max(1e-9)).clamp(0.9, 1.1);
        let last = colour.curves[c].len().saturating_sub(1).max(1);
        for (bin, level) in colour.curves[c].iter_mut().enumerate() {
            // Faded out towards the top of the domain, where it must not act at all.
            //
            // The shape is shared, so this is the only per-channel freedom and so the only
            // thing that can pull a neutral apart - and at the very top there is nothing left
            // to pull towards. A sensor clipped to exactly neutral and rendered by the camera
            // as exactly neutral has to come out neutral. Applied flat instead of faded, this
            // gain reintroduces the tint the shared shape just removed: the blown highlight
            // comes out [1.261, 1.330, 1.181], 12.7% apart.
            //
            // Linear in the bin rather than shaped, because what it interpolates between is
            // two exactly-known ends - the frame's measured grey gain at the bottom, and
            // unity at the top - with no evidence about the middle to justify a curve.
            let toward_white = bin as f64 / last as f64;
            *level *= gain + (1.0 - gain) * toward_white;
        }
        // The taper's multiplier varies across the domain, so unlike a flat gain it can
        // reorder two bins the fit left nearly level - and a curve that dips is a gradient
        // that posterises. Held here rather than by weakening the taper, because the fade
        // is the part that keeps highlights neutral.
        let mut floor = f64::MIN;
        for level in colour.curves[c].iter_mut() {
            floor = floor.max(*level);
            *level = floor;
        }
    }
    Some(())
}

/// The plane read at each set's own pixels, which is what the rounds below share.
///
/// The gather depends on the plane and the indices and on nothing the rounds move, where the tone
/// stage above it reads the curves and so has to run again each time.
struct Gathered {
    pairs: crate::gpu::Buffer,
    frame: crate::gpu::Buffer,
}

/// The matrix for the tone stage a colour currently carries.
async fn fitted_matrix_for(
    gpu: &'static crate::gpu::Gpu,
    colour: &HdrColour,
    pairs: &Pairs,
    frame: &Pairs,
    samples: &Gathered,
) -> Option<[[f64; 3]; 3]> {
    // The tone stage once, kept on the device for the candidates below: they differ only in
    // their matrix, which sits after it.
    let toned = evaluate_over(gpu, colour, &samples.pairs, pairs.at.len(), Stage::Tone);
    // Summed where the tone stage left them: eighteen floats a block comes back, rather than a
    // colour per pair for the host to sum the same eighteen itself.
    let blocks = crate::fit_moments::partials(
        gpu,
        &toned.buffer,
        pairs.linear_on(gpu),
        pairs.at.len(),
        MEASURE_BLOCK,
    )
    .await?;

    // Folded in block order, which is what makes this the same answer on every adapter.
    let mut moments = Moments::default();
    for block in &blocks {
        for a in 0..3 {
            for b in 0..3 {
                moments.ata[a][b] += block[a * 3 + b];
                moments.atb[a][b] += block[9 + a * 3 + b];
            }
        }
    }
    let Some(candidates) = ridge_candidates(&moments) else {
        return Some(moments.solve(MATRIX_RIDGE));
    };
    // **All seven in one dispatch**: a probe costs a round trip whatever it computes, and these
    // differ only in the matrix that sits after the tone stage.
    let scored = scored_on_matrices(gpu, pairs, toned.buffer, &candidates).await?;
    // The same candidates again over the picture, which is the question the pairs cannot answer.
    // Its own tone stage, since it is a different set of pixels.
    let frame_toned = evaluate_over(gpu, colour, &samples.frame, frame.at.len(), Stage::Tone);
    let frame_scored =
        scored_on_matrices(gpu, frame, frame_toned.buffer, &candidates).await?;
    if crate::clock::watched() {
        let names = std::iter::once("identity".to_string())
            .chain(RIDGE_CANDIDATES.iter().map(|r| r.to_string()));
        let ridges: Vec<String> = names
            .zip(&scored)
            .zip(&frame_scored)
            .map(|((ridge, (balanced, _)), (_, frame))| {
                format!("{ridge}: pairs {balanced:.3} frame {frame:.3}")
            })
            .collect();
        eprintln!("  matrix candidates {}", ridges.join(", "));
    }
    Some(fitted_matrix(&candidates, &scored, &frame_scored))
}

/// Each ridge candidate's two answers, off the device.
///
/// `to_srgb` is folded into the candidate before it crosses, so the shader applies one 3x3
/// rather than two.
async fn scored_on_matrices(
    gpu: &'static crate::gpu::Gpu,
    pairs: &Pairs,
    toned: crate::gpu::Buffer,
    candidates: &[[[f64; 3]; 3]],
) -> Option<Vec<(f64, f64)>> {
    let scoring = scoring_over(gpu, pairs, toned);
    let probes: Vec<crate::fit_score::Probe> = candidates
        .iter()
        .map(|matrix| crate::fit_score::Probe {
            matrix: compose3(&pairs.to_srgb, matrix),
            saturation: 1.0,
        })
        .collect();
    let partials = scoring.partials(&crate::fit_score::Shape::Matrix, &probes).await?;
    Some(partials.into_iter().map(folded).collect())
}

/// `a` after `b`, as one matrix.
fn compose3(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    std::array::from_fn(|r| {
        std::array::from_fn(|c| (0..3).map(|k| a[r][k] * b[k][c]).sum())
    })
}

/// A 3x3 inverse, by solving the matrix against each basis vector. None when singular.
pub(crate) fn invert3(m: &[[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let columns: [[f64; 3]; 3] = [
        solve_row(m, &[1.0, 0.0, 0.0])?,
        solve_row(m, &[0.0, 1.0, 0.0])?,
        solve_row(m, &[0.0, 0.0, 1.0])?,
    ];
    Some(std::array::from_fn(|r| std::array::from_fn(|c| columns[c][r])))
}

/// The widest saturation the search may return, and the resolution it stops at.
///
/// The bound is a bound, not a fit: outside it the scalar is no longer describing a
/// camera and is covering for a stage that went wrong. The resolution is below what an
/// eye resolves, so the last few iterations of the search would be spent on nothing.
const SATURATION_RANGE: (f64, f64) = (0.6, 1.5);
const SATURATION_RESOLUTION: f64 = 0.002;

/// Steps of the coarse sweep, and how much better than leaving the chroma alone the
/// result has to measure before it is used.
///
/// The sweep is coarse enough to stay cheap - each step is a pass over every pair - and
/// fine enough to bracket the minimum before the section refines inside it. The margin
/// sits two orders below the difference a saturation that matters makes.
///
/// The objective can have more than one dip - it is a mean of a non-convex distance over a
/// frame's worth of colours - and 19 extra passes is a cheap insurance against a section
/// walking into the wrong one. Whether a plain section suffices is measurable and unmeasured;
/// that is the reason to leave this alone rather than an argument that it is needed.
const SATURATION_SWEEP: usize = 18;
const NEUTRAL_MARGIN: f64 = 0.02;

/// One pair in this many is enough to bracket the sweep's minimum.
///
/// The sweep answers *which* 0.05-wide bracket, not what the number is inside it, and the
/// refinement that follows reads every pair. So the accuracy this has to reach is the gap between
/// neighbouring brackets, which thousands of pairs settle as firmly as a hundred thousand. Eight
/// rather than twenty because at twenty a frame near a boundary can pick the neighbouring bracket,
/// and the section then converges to that bracket's edge instead of into the dip.
const SWEEP_STRIDE: usize = 8;

/// The chroma blend, at the strength that best matches the camera.
///
/// Fitted against deltaE rather than solved for the mean chroma ratio, which is what
/// this did and is a proxy that fails exactly when the stages above it leave a residual:
/// the ratio is a mean, one scalar can always be found that makes a mean come out right,
/// and on IMG_9808 the one that did came out at 1.153 - which took hues that were
/// already within 1.3 of the camera and pushed the hillside to 11.6, acid yellow-green,
/// while the number it was solving for looked perfect. The deltaE fit lands at 0.995
/// there and leaves the frames whose chroma really is short alone.
///
/// Every pair counts the same here, unlike the curve and matrix fits. `hue_balance`
/// stops a frame's dominant colour deciding what the camera is taken to *do*, and the
/// curves and the matrix have the freedom to act on that separately per hue. This
/// scalar has none - it moves the whole picture at once - so balancing it does not
/// protect a minority hue, it hands the picture to one. IMG_9808 balanced lands at
/// 0.772 and drains its sky, 75k pairs at deltaE 9.4, to bring 1.2k red ones in.
///
/// Coarse sweep first, then a golden section inside the bracket it found - and the
/// answer has to beat leaving the chroma alone before it is taken.
///
/// A plain golden section over the whole range is not safe here: the objective is a mean of
/// a non-convex distance and can dip more than once (`SATURATION_SWEEP`), and where it is
/// flat every comparison ties, so a bisection that discards a half on a tie walks to
/// whichever end it favours - on an achromatic frame that is a 1.5x chroma boost applied to
/// pixels the blurred fit grid never saw. The strict comparison below is what keeps a flat
/// stretch at neutral.
///
/// So the sweep finds which dip to be in, the section refines inside it, and neutral is
/// the answer unless something clearly beats it. `NEUTRAL_MARGIN` is what "clearly"
/// means, and a real difference is nowhere near that small - IMG_9808 moves deltaE by
/// about 2 between its fitted saturation and 1.0.
///
/// Everything under the blend is evaluated once and held on the device: this scalar is the last
/// stage of the transform and the probes above it move nothing else, so the curves and the matrix
/// would otherwise be recomputed thirty times over for a result identical every time.
async fn fitted_saturation(
    gpu: &'static crate::gpu::Gpu,
    colour: &HdrColour,
    render: &Source,
    pairs: &Pairs,
) -> Option<f64> {
    let samples = gathered(gpu, render, &pairs.indices, pairs.at.len(), None);
    let below = evaluate_over(gpu, colour, &samples, pairs.at.len(), Stage::ToneMatrix);
    let (low, high) = SATURATION_RANGE;
    let scoring = scoring_over(gpu, pairs, below.buffer);
    // Flat rather than balanced, which is what every comparison in this function reads.
    let flat = async |sweep: &[f64]| scored_on(&scoring, sweep).await;

    // Neutral first, then the sweep: they do not depend on each other, and asked one at a
    // time they leave most of the machine idle.
    let probes: Vec<f64> = std::iter::once(1.0)
        .chain((0..=SATURATION_SWEEP).map(|step| low + (high - low) * step as f64 / SATURATION_SWEEP as f64))
        .collect();
    // **On a sample of the pairs, and only this pass.** All the sweep decides is which of the
    // nineteen brackets to refine inside, and a bracket is 0.05 wide where the answer is wanted to
    // 0.002 - so it is a choice between coarse alternatives, which a twentieth of the pairs settles
    // as firmly as all of them. The refinement below and the neutral comparison at the end read the
    // whole set, so what this changes is which bracket, not what the answer is inside it.
    let sample = pairs.every(gpu, SWEEP_STRIDE);
    let taken = gathered(gpu, render, &sample.indices, sample.at.len(), None);
    let sampled = evaluate_over(gpu, colour, &taken, sample.at.len(), Stage::ToneMatrix);
    let swept =
        scored_on(&scoring_over(gpu, &sample, sampled.buffer), &probes).await?;

    let (mut at, mut best) = (1.0, swept[0]);
    for (probe, here) in probes.iter().zip(&swept).skip(1) {
        // Strictly better, so a flat objective keeps the neutral this started from
        // instead of sliding to whichever end the comparisons happen to favour.
        if *here < best {
            (at, best) = (*probe, *here);
        }
    }

    // **Golden section, and it stays one.** Batching this the way the sweep above is batched was
    // tried and is a loss: a section places each probe where the last one's answer says, so it
    // reaches 0.002 from a 0.05 bracket in nine evaluations, where rounds of eight need sixteen to
    // reach 0.008. The device's parallel efficiency does not cover 1.8x the work.
    let scored = async |saturation: f64| -> Option<f64> { Some(flat(&[saturation]).await?[0]) };
    let coarse = (high - low) / SATURATION_SWEEP as f64;
    let (mut lo, mut hi) = ((at - coarse).max(low), (at + coarse).min(high));
    const INVERSE_PHI: f64 = 0.618_033_988_749_895;
    let (mut c, mut d) = (hi - (hi - lo) * INVERSE_PHI, lo + (hi - lo) * INVERSE_PHI);
    let (mut fc, mut fd) = (scored(c).await?, scored(d).await?);
    while hi - lo > SATURATION_RESOLUTION {
        if fc < fd {
            (hi, d, fd) = (d, c, fc);
            c = hi - (hi - lo) * INVERSE_PHI;
            fc = scored(c).await?;
        } else {
            (lo, c, fc) = (c, d, fd);
            d = lo + (hi - lo) * INVERSE_PHI;
            fd = scored(d).await?;
        }
    }
    let found = (lo + hi) / 2.0;

    // On every pair, unlike the sweep: this one decides whether the frame gets a saturation at
    // all, and `NEUTRAL_MARGIN` is a real bar rather than a tie-break between brackets. Both
    // together, since neither depends on the other's answer.
    let against = flat(&[found, 1.0]).await?;
    Some(match against[0] + NEUTRAL_MARGIN < against[1] {
        true => found,
        false => 1.0,
    })
}

/// A stage's pairs on the device, over the colours `below` holds for them, ready for as many
/// probes as it wants to ask. A stage with no pairs never dispatches and scores as an empty sum.
fn scoring_over(
    gpu: &'static crate::gpu::Gpu,
    pairs: &Pairs,
    below: crate::gpu::Buffer,
) -> crate::fit_score::Scoring {
    crate::fit_score::Scoring::new(
        gpu,
        below,
        &pairs.target,
        &pairs.balance,
        &pairs.to_srgb,
        SCORE_BLOCK,
    )
}

/// Pairs a device thread sums.
///
/// **Small because a probe is one thread per block, and a section asks one probe at a time.** The
/// golden section cannot be batched - it places each probe where the last one's answer says, and
/// the arithmetic for why is beside the loop - so at 4096 a 150k-pair frame offered 37 threads,
/// which on any adapter is a kernel waiting on one lane's serial walk: measured at 4.4ms a probe,
/// against 0.5ms once the same work is spread over 600.
///
/// Fixed in code rather than per adapter: the block is part of the summation order and so part
/// of the answer, so no two runs disagree.
const SCORE_BLOCK: usize = 256;

/// Each probe's flat mean, folded from the blocks the device summed.
async fn scored_on(scoring: &crate::fit_score::Scoring, sweep: &[f64]) -> Option<Vec<f64>> {
    let probes: Vec<crate::fit_score::Probe> = sweep
        .iter()
        .map(|s| crate::fit_score::Probe { matrix: [[0.0; 3]; 3], saturation: *s })
        .collect();
    let partials = scoring.partials(&crate::fit_score::Shape::Saturation, &probes).await?;
    Some(partials.into_iter().map(|blocks| folded(blocks).1).collect())
}

/// Weight a node needs before it is trusted on its own rather than on the frame's.
///
/// Not a threshold but a half-way point: a node carrying this much keeps half of what it
/// measured and takes half of the global answer, and one with none keeps none. So a frame
/// with colour everywhere gets a map that follows it, and a frame of snow and sky gets back
/// the single scalar this generalises, without a cliff between them.
///
/// Low, and it has to be read against the weights rather than as a pair count. It was 400
/// when the wide pass contributed a flat 0.25 per sample and the pairs carried a hue
/// balance, so the two were on different scales and a small saturated object arrived at its
/// node with a weight in the tens - it kept a few percent of its own answer and the node
/// solved to the surroundings. With both sides weighted alike, the same object arrives with
/// enough to be believed, and this is what "enough" now means.
const MAP_CONFIDENCE: f64 = 2.0;

/// How far the lattice's chroma-to-lightness terms may reach, in lightness per unit chroma.
///
/// Chroma runs to about 0.3, so this bounds how much a colour's saturation may change its
/// lightness to roughly a fifth of full scale - wide enough for the blue pot, which needs
/// about 1.4x, and narrow enough that a node fitted from a handful of dark pixels cannot
/// drive the output negative.
const MAP_MAX_TINT: f64 = 0.6;

/// The furthest the de-attenuation may rescale a node, either way.
///
/// A node whose pairs are nearly grey has almost no chroma to compare the length of, so
/// the ratio it asks for is noise over noise. Bounded, such a node keeps roughly the
/// length least squares gave it and the shrinkage below decides the rest.
const MAP_MAX_GAIN: f64 = 2.0;

/// The furthest a node may move lightness, either way.
///
/// Far tighter than the chroma bound, and for a different reason. This term exists to
/// carry a *correction* - the blues on IMG_8789 run 2 to 4 L* dark against reds at +0.04,
/// which is a few percent of luma - not to carry the camera's rendering of level, which
/// is the tone curves' job and holds 256 bins against this axis's nine. A node asking for
/// more than a few percent is describing something the curves should have said, and
/// letting it would put a coarse second transfer under the fine one.
///
/// It also bounds what the term can do above the fit domain, where a node is read by
/// extrapolation and there are no pairs to object.
///
/// Wide, because a small saturated object genuinely asks for a lot: the blue pot needs
/// about 1.4x to land on the camera's lightness. It binds only because a node believes such an
/// object at all, which is `MAP_CONFIDENCE`'s doing and stated there: against a weighting that
/// shrinks it to its surroundings instead, the solve asks for about unity everywhere and no
/// bound in this range is ever reached.
const MAP_MAX_LUMA: f64 = 1.60;

/// Damping on each node's own least squares, relative to its own scale.
const MAP_RIDGE: f64 = 0.05;

/// How much chroma the camera has to give a pixel before the wide pass looks at it.
///
/// A noise floor, not a hue test: any higher bar drops a lit transition's near-neutral
/// mid-levels - the mask's gradient gate already declines them, so the map would reach
/// those colours from nowhere and a smooth shoulder bands at precisely the levels both
/// admissions declined. Neutrals outvoting the pairs in shared cells is the weight
/// ladder's job to prevent, not this bar's.
pub(crate) const WIDE_MIN_CHROMA: f64 = 0.005;

/// Wide-plane pixels one correspondence is shared across.
///
/// **What the search returns is a registration, and registration is smooth.** It absorbs the
/// shift between our render's grid and the camera's preview - two rows on this body, and
/// varying across the frame only as slowly as a lens's distortion does - so the answer at a
/// pixel is the answer at its neighbours. `correspond.slang` says the same from its own side:
/// at stride one the 81 windows around a point overlap the 81 around its neighbour almost
/// entirely, which is work spent to be told what is already known.
///
/// Sixteen, and not a tight bound: `WIDE_REFINE` lets a pixel leave its tile's answer either
/// way, so a tile has only to be right about where to look rather than what is there. Measured
/// on DSC02981, doubling it moves the frame's deltaE by 0.015 against the 0.1 that hangs on
/// whether a pixel is scored at its own offset at all - so this is the cheap axis, and
/// `WIDE_REFINE` is the one that matters.
const WIDE_TILE: usize = 16;

/// Points corresponded per tile, the best-scoring of them deciding it.
///
/// One probe would be enough if every admitted pixel were textured, and the pass exists for
/// objects that are - but a single probe landing on the one flat pixel in a textured tile
/// reports a zero shift it never measured, and every pixel of that tile would then sample the
/// camera at the wrong place. Four costs nothing beside a search per pixel and makes that
/// unlucky.
const WIDE_TILE_PROBES: usize = 4;

/// How far a pixel may depart from its tile's offset.
///
/// **Not zero, because the tile's answer is a starting point and not a verdict.** A tile spans
/// an object's edge as often as not, and the two sides of an edge genuinely register
/// differently; pinned to the tile exactly, the losing side samples the camera a pixel out and
/// contributes a colour blended across the boundary.
///
/// One, because that is what the tile can be wrong by. `SEARCH` bounds the whole field to four
/// pixels and a tile is sixteen across, so the offset varies by well under a pixel inside it -
/// the neighbours are there to absorb the rounding, not to re-search.
///
/// Nine offsets against the full window's eighty-one, and the pass keeps its rejection: a pixel
/// whose content matches at none of the nine still scores below `MATCH_MIN` and is dropped, the
/// same as when every pixel searched for itself.
const WIDE_REFINE: i32 = 1;

/// The wide plane is asked about every this-many-th pixel on each axis.
///
/// The pass admits nearly the whole plane - four wide pixels for every pair - and the search and
/// the gather are per pixel. At two on each axis a 20px object at the
/// preview's width still lands four hundred samples on its node, against the two
/// `MAP_CONFIDENCE` asks for. Measured against one on the three fixtures: the held-out pair
/// deltaE moves by two hundredths either way, and a 1:1 crop of the frame the lattice moved most
/// on by 0.6 of a count in 255, worst pixel 9.
pub(crate) const WIDE_STRIDE: usize = 2;

/// What one admitted pixel counts for: the ones the stride passed over.
const WIDE_STANDS_FOR: f64 = (WIDE_STRIDE * WIDE_STRIDE) as f64;

/// What one pass over some pixels tells the chroma map, per node.
#[derive(Clone)]
struct ChromaMoments {
    /// The 2x2 normal equations for `M . ours = theirs`.
    ata: Vec<[[f64; 3]; 3]>,
    atb: Vec<[[f64; 3]; 2]>,
    /// The weighted sums of the input and of the target, which is what a penalty on the
    /// *mean* residual needs: `sum(w.r)` is `M.sx - st`, so squaring it is rank-one in the
    /// coefficients and adds to the normal equations rather than replacing them.
    sx: Vec<[f64; 3]>,
    st: Vec<[f64; 2]>,
    /// The camera's own chroma, squared: what the map's output is scaled to match.
    btb: Vec<f64>,
    /// The luma gain's normal equations, which are one-dimensional: `g . ours = theirs`
    /// is a scalar fit, so it needs a sum of squares and a sum of products rather than a
    /// matrix. Kept beside the chroma moments because the two are accumulated in one pass
    /// over the pairs and share the node weights.
    lta: Vec<f64>,
    /// `sum(w . d . theirs)` per chroma axis, which with `ata` is everything the
    /// chroma-to-lightness terms need without a second pass over the pairs.
    lda: Vec<[f64; 2]>,
    ltb: Vec<f64>,
    /// How much landed here.
    seen: Vec<f64>,
}

impl Default for ChromaMoments {
    fn default() -> Self {
        let nodes = MAP_NODES;
        ChromaMoments {
            ata: vec![[[0.0; 3]; 3]; nodes],
            atb: vec![[[0.0; 3]; 2]; nodes],
            sx: vec![[0.0; 3]; nodes],
            st: vec![[0.0; 2]; nodes],
            btb: vec![0.0; nodes],
            lta: vec![0.0; nodes],
            lda: vec![[0.0; 2]; nodes],
            ltb: vec![0.0; nodes],
            seen: vec![0.0; nodes],
        }
    }
}

// --------------------------------------------------------------- correspondence

/// How far a comparison reaches: the window it holds, and how far it sweeps that window.
///
/// **Lengths in the plane being searched, which is why they are carried rather than fixed.** The
/// camera match's planes are one size and `Reach::NARROW` is what registers them. A panorama's are
/// whatever the smallest preview across its set was - 1616 from a RAW, 800 from a grid tile - and
/// the same absolute window covers twice the scene on the smaller one, which would quietly make
/// every bar downstream mean something different. `Reach::across` states the same *fraction* of a
/// frame whatever size it arrived at.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Reach {
    pub patch: isize,
    pub search: isize,
}

impl Reach {
    /// What registers two renderings of one photograph, at the size the camera match works in.
    pub const NARROW: Reach = Reach { patch: PATCH, search: SEARCH };

    /// The same reach as `NARROW` has at `TUNED_ON`, in the pixels of a plane whose long edge is
    /// `long` - but never smaller than `NARROW`.
    ///
    /// **A share upwards and a floor downwards, because the two directions are not symmetric.** A
    /// plane larger than the one these were measured on holds the same scene at more samples, so the
    /// window has to grow with it or it stops covering the thing it was sized to cover. A *smaller*
    /// plane holds the same scene at fewer, and shrinking with it would spend the little statistical
    /// power left: measured on the 808px fixtures, a proportional window found 1804 correspondences
    /// where the floor finds over two thousand, and the six-view rig came back at 2.5px rather than
    /// under one. Seven pixels is about the least a correlation says anything with.
    pub fn across(long: usize) -> Reach {
        let share = |of: isize| {
            let scaled = (of as f64 * long as f64 / TUNED_ON as f64).round() as isize;
            scaled.max(of)
        };
        Reach { patch: share(PATCH), search: share(SEARCH) }
    }

    /// How far from the plane's edge a point has to sit for its window to be readable.
    pub fn margin(&self) -> isize {
        self.patch + self.search
    }
}

/// Half-width of the patch a correspondence is judged on, in wide-plane pixels.
pub(crate) const PATCH: isize = 3;

/// How far a pair is allowed to have moved, in wide-plane pixels.
///
/// The geometry fit has already taken out the lens and the framing, so what is left here
/// is that fit's own residual - a pixel or two at this scale, not a search across the
/// frame. Widening it costs the square and invites a confident match onto a repeating
/// texture that happens to sit nearby.
pub(crate) const SEARCH: isize = 4;

/// How much of a patch's structure has to agree before its match is believed.
///
/// Correlation is on zero-mean luma, so this judges *shape* and is blind to the brightness
/// and colour difference between the two renderings - which is the point, since that
/// difference is the thing the fit exists to measure and must not be matched away.
const MATCH_MIN: f64 = 0.75;

/// Below this much total squared luma deviation a patch counts as featureless.
///
/// In the planes' own units, where diffuse white is 1: a patch whose pixels all sit within
/// about a fiftieth of full scale of each other has no structure to correlate.
const FLAT_PATCH: f64 = 0.02;

/// Half-width of the average a matched sample is read through, in wide-plane pixels.
///
/// Small on purpose. Correspondence is what makes a sharp read safe, so this is left with
/// only the job a match cannot do: one pixel carries sensor noise, and a node fitted from
/// a noisy sample lands as far from the truth as a misregistered one does.
pub(crate) const SAMPLE: isize = 1;

/// How far a neighbour may sit from the centre, per channel, and still be averaged into it.
///
/// The edge-aware part, and it has to be **tight** - about two counts of 255. Measured on
/// the independent judge, with the window fixed at 3x3:
///
/// | gate | deltaE |
/// |------|--------|
/// | luma only, 0.03 | 1.313 |
/// | all channels, 0.03 | 1.292 |
/// | all channels, 0.008 | 1.262 |
/// | no window at all | 1.262 |
///
/// So a loose window is worse than no window. The fit already pools ~190k pairs, which
/// averages pixel noise out on its own; what a window adds that the pooling cannot undo is
/// *bias* from mixing two surfaces, and every count of slack here is more of it. At this
/// threshold it averages only neighbours that are the same colour to within the sensor's
/// own noise, which is the case it was wanted for and no other.
pub(crate) const SAMPLE_RANGE: f64 = 0.008;

/// The two wide planes' luma on the device, held across the passes that search them: `registered`
/// searches every grid position and `fitted_chroma`'s wide pass whatever its gates admit.
///
/// **The camera's plane is tabulated.** Both searches that read it are dense - every grid
/// position, at stride 1 - so each of a point's 81 windows overlaps its neighbour's by 72 of 49
/// samples, and working the statistics out inside the offset loop costs a point 81 x 98 taps
/// against 81 loads. One pass over the plane pays for both searches and for every probe.
struct Wide {
    ours: DevicePlane,
    theirs: DevicePlane,
}

/// A compute kernel of the fit's, built once for the process.
pub struct Kernel {
    pub(crate) layout: wgpu::BindGroupLayout,
    pub(crate) pipeline: wgpu::ComputePipeline,
}

pub fn kernel(
    gpu: &'static crate::gpu::Gpu,
    name: &str,
    wgsl: &str,
    bindings: &[(u32, wgpu::BufferBindingType)],
    constants: &[(&str, f64)],
) -> Kernel {
    let device = gpu.describing();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(name),
        source: wgpu::ShaderSource::Wgsl(wgsl.into()),
    });
    let entries: Vec<wgpu::BindGroupLayoutEntry> = bindings
        .iter()
        .map(|(binding, ty)| wgpu::BindGroupLayoutEntry {
            binding: *binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: *ty,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        })
        .collect();
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some(name),
        entries: &entries,
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(name),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    Kernel {
        pipeline: device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(name),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some(name),
            compilation_options: wgpu::PipelineCompilationOptions {
                constants,
                ..Default::default()
            },
            cache: None,
        }),
        layout,
    }
}

pub(crate) const READ: wgpu::BufferBindingType = wgpu::BufferBindingType::Storage { read_only: true };
pub(crate) const WRITE: wgpu::BufferBindingType =
    wgpu::BufferBindingType::Storage { read_only: false };
pub(crate) const UNIFORM: wgpu::BufferBindingType = wgpu::BufferBindingType::Uniform;

/// The search, in both of the forms `TABULATED` selects between.
///
/// One layout, so a bind group made for either fits both, and the caller picks the pipeline off
/// whether the plane it is searching into carries its statistics.
pub struct Searching {
    tabulated: Kernel,
    inline: Kernel,
}

impl Searching {
    fn pipeline(&self, tabulated: bool) -> &wgpu::ComputePipeline {
        match tabulated {
            true => &self.tabulated.pipeline,
            false => &self.inline.pipeline,
        }
    }
}

pub fn search_device(gpu: &'static crate::gpu::Gpu) -> &'static Searching {
    static BUILT: std::sync::OnceLock<Searching> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        const WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/correspond.wgsl"));
        const BINDINGS: &[(u32, wgpu::BufferBindingType)] =
            &[(0, READ), (1, READ), (2, READ), (3, WRITE), (4, READ), (5, READ), (20, UNIFORM)];
        Searching {
            tabulated: kernel(gpu, "correspond", WGSL, BINDINGS, &[("0", 1.0)]),
            inline: kernel(gpu, "correspond", WGSL, BINDINGS, &[("0", 0.0)]),
        }
    })
}

const SHAPING_WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_warp.wgsl"));
const SHAPING_BINDINGS: &[(u32, wgpu::BufferBindingType)] =
    &[(0, READ), (1, READ), (2, WRITE), (20, UNIFORM)];

fn warp_device(gpu: &'static crate::gpu::Gpu) -> &'static Kernel {
    static BUILT: std::sync::OnceLock<Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| kernel(gpu, "fit_warp", SHAPING_WGSL, SHAPING_BINDINGS, &[]))
}

fn box_device(gpu: &'static crate::gpu::Gpu) -> &'static Kernel {
    static BUILT: std::sync::OnceLock<Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| kernel(gpu, "fit_box", SHAPING_WGSL, SHAPING_BINDINGS, &[]))
}

const PACKED_BOX_BINDINGS: &[(u32, wgpu::BufferBindingType)] =
    &[(2, WRITE), (3, READ), (4, READ), (20, UNIFORM)];

fn packed_box_device(gpu: &'static crate::gpu::Gpu) -> &'static Kernel {
    static BUILT: std::sync::OnceLock<Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| kernel(gpu, "fit_box_packed", SHAPING_WGSL, PACKED_BOX_BINDINGS, &[]))
}

fn register_device(gpu: &'static crate::gpu::Gpu) -> &'static Kernel {
    static BUILT: std::sync::OnceLock<Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        kernel(
            gpu,
            "fit_register",
            include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_register.wgsl")),
            &[(0, READ), (1, READ), (2, READ), (3, READ), (4, WRITE), (5, WRITE), (20, UNIFORM)],
            &[],
        )
    })
}

fn stats_device(gpu: &'static crate::gpu::Gpu) -> &'static Kernel {
    static BUILT: std::sync::OnceLock<Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        kernel(
            gpu,
            "patch_stats",
            include_str!(concat!(env!("OUT_DIR"), "/wgsl/patch_stats.wgsl")),
            &[(0, READ), (1, WRITE), (20, UNIFORM)],
            &[],
        )
    })
}

/// Something to bind where a shader takes a buffer the dispatch never reads.
///
/// Built per call rather than held in a `static`: `wgpu::Buffer` is neither `Send` nor `Sync` on
/// wasm, where it carries the `Rc` its map state lives behind, so a `static` of one refuses to
/// compile for the browser at all.
fn unused_buffer(recording: &mut crate::gpu::Recording<'_>) -> crate::gpu::Buffer {
    recording.buffer(&wgpu::BufferDescriptor {
        label: Some("unused"),
        size: 4,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    })
}

/// Interleaved samples as the f32 RGB `fit_warp.slang` reads.
fn rgb_words<T: Copy + Sync>(samples: &[T], to_f32: impl Fn(T) -> f32 + Sync) -> Vec<u8> {
    let mut bytes = vec![0u8; samples.len() * 4];
    bytes.par_chunks_mut(4).zip(samples.par_iter()).for_each(|(word, v)| {
        word.copy_from_slice(&to_f32(*v).to_ne_bytes());
    });
    bytes
}

fn rgb_source(
    recording: &mut crate::gpu::Recording<'_>,
    label: &str,
    words: &[u8],
) -> crate::gpu::Buffer {
    recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: words,
        usage: wgpu::BufferUsages::STORAGE,
    })
}

/// Room for an f32 RGB plane a shader is about to write, readable back through `staged`.
fn rgb_buffer(
    recording: &mut crate::gpu::Recording<'_>,
    label: &str,
    width: usize,
    height: usize,
) -> crate::gpu::Buffer {
    recording.buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: (width * height * 3 * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    })
}

/// A copy of `plane` the host can map once the recording is submitted, for `plane_read`.
fn staged(
    recording: &mut crate::gpu::Recording<'_>,
    plane: &crate::gpu::Buffer,
    floats: usize,
) -> crate::gpu::Buffer {
    let bytes = (floats * 4) as u64;
    let staging = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit plane out"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    recording.encoder().copy_buffer_to_buffer(plane, 0, &staging, 0, bytes);
    staging
}

async fn plane_read(
    gpu: &'static crate::gpu::Gpu,
    staging: &crate::gpu::Buffer,
    width: usize,
    height: usize,
) -> Option<Plane> {
    let data = crate::gpu::read_back(gpu, staging, |mapped| {
        mapped
            .par_chunks_exact(4)
            .map(|word| f64::from(f32::from_ne_bytes([word[0], word[1], word[2], word[3]])))
            .collect::<Vec<f64>>()
    })
    .await?;
    Some(Plane { width, height, data })
}

/// What one `fit_warp.slang` dispatch makes of its source.
enum Shape<'a> {
    /// Through the lens, onto the grid `out` is sized for, every sample scaled on the way.
    Warp { lens: &'a crate::fit::Lens, luma: bool, scale: f64 },
    Luma,
    Box { finish: Finish },
    /// `Box` over 8-bit RGB uploaded as its own bytes, each code averaged as `levels[code]`.
    PackedBox { levels: &'a [f32; 256], finish: Finish },
}

/// What a shaping does to each pixel on the way out, in the pass rather than on the host over
/// the whole plane after a readback.
#[derive(Clone, Copy)]
enum Finish {
    None,
    /// The plane's primaries into the fit's, for a source that arrived in someone else's.
    Matrix([[f64; 3]; 3]),
    /// Onto the 255 steps an 8-bit source's codes live on.
    Codes,
    /// The lens's own falloff, which the fit's pairs have to carry because the grade applies it
    /// before the colour: a curve fitted against corners it has not yet lifted would be asked at
    /// grade time for levels it never saw.
    Falloff((f64, f64)),
}

/// One `fit_warp.slang` dispatch, recorded: `source` at `(sw, sh)` into `out` at
/// `(width, height)`. Its buffers are the recording's, so they outlive the submit.
struct Shaping {
    pipeline: &'static wgpu::ComputePipeline,
    group: wgpu::BindGroup,
    width: usize,
    height: usize,
}

impl Shaping {
    fn new(
        gpu: &'static crate::gpu::Gpu,
        recording: &mut crate::gpu::Recording<'_>,
        source: &crate::gpu::Buffer,
        (sw, sh): (usize, usize),
        out: &crate::gpu::Buffer,
        (width, height): (usize, usize),
        shape: Shape<'_>,
    ) -> Shaping {
        let finish = match shape {
            Shape::PackedBox { finish, .. } | Shape::Box { finish } => finish,
            _ => Finish::None,
        };
        let scale = match shape {
            Shape::Warp { scale, .. } => scale,
            _ => 1.0,
        };
        let (kernel, table, (source_binding, table_binding), warping, luma) = match shape {
            Shape::Warp { lens, luma, .. } => {
                let tables = crate::image::ratio_tables(
                    lens.distortion.as_deref().unwrap_or_default(),
                    lens.crop,
                    &lens.channels(),
                );
                let contents: Vec<u8> =
                    tables.iter().flatten().flat_map(|v| (*v as f32).to_ne_bytes()).collect();
                let ratios = recording.init(&wgpu::util::BufferInitDescriptor {
                    label: Some("fit warp ratios"),
                    contents: &contents,
                    usage: wgpu::BufferUsages::STORAGE,
                });
                // `moves_pixels` so a lens carrying a scale and no spline still warps, and a
                // source held larger than the grid is gathered down whatever the lens does.
                let moves = lens.tca.is_some()
                    || crate::image::moves_pixels(lens.distortion.as_deref(), lens.crop)
                    || (sw, sh) != (width, height);
                (warp_device(gpu), ratios, (0, 1), moves, luma)
            }
            Shape::Luma => (warp_device(gpu), unused_buffer(recording), (0, 1), false, true),
            Shape::Box { finish } => {
                // The polynomial stays on the host, tabulated per radius bucket exactly as the
                // geometry search's own table is, so the shader looks up rather than evaluates.
                let table = match finish {
                    Finish::Falloff((a, b)) => {
                        let gains: Vec<u8> = (0..=u8::MAX)
                            .flat_map(|r| (crate::fit::Gain::at(a, b, r) as f32).to_ne_bytes())
                            .collect();
                        recording.init(&wgpu::util::BufferInitDescriptor {
                            label: Some("fit falloff gains"),
                            contents: &gains,
                            usage: wgpu::BufferUsages::STORAGE,
                        })
                    }
                    _ => unused_buffer(recording),
                };
                (box_device(gpu), table, (0, 1), false, false)
            }
            Shape::PackedBox { levels, .. } => {
                let contents: Vec<u8> = levels.iter().flat_map(|v| v.to_ne_bytes()).collect();
                let levels = recording.init(&wgpu::util::BufferInitDescriptor {
                    label: Some("fit box levels"),
                    contents: &contents,
                    usage: wgpu::BufferUsages::STORAGE,
                });
                (packed_box_device(gpu), levels, (4, 3), false, false)
            }
        };
        let half = ((width as f64 / 2.0).powi(2) + (height as f64 / 2.0).powi(2)).sqrt();
        let step = |source: usize, out: usize| (half * source as f64 / out as f64) as f32;
        let mut block = [
            (sw as i32).to_ne_bytes(),
            (sh as i32).to_ne_bytes(),
            (width as i32).to_ne_bytes(),
            (height as i32).to_ne_bytes(),
            i32::from(warping).to_ne_bytes(),
            (half as f32).to_ne_bytes(),
            step(sw, width).to_ne_bytes(),
            step(sh, height).to_ne_bytes(),
            i32::from(luma).to_ne_bytes(),
        ]
        .concat();
        block.extend(
            match finish {
                Finish::None => 0i32,
                Finish::Matrix(_) => 1,
                Finish::Codes => 2,
                Finish::Falloff(_) => 3,
            }
            .to_ne_bytes(),
        );
        block.extend((scale as f32).to_ne_bytes());
        // The matrix starts on a 16-byte boundary and takes one per row, which is what `float4[3]`
        // is in std140; the two pad words before it are the shader's own.
        block.resize(48, 0);
        if let Finish::Matrix(m) = finish {
            for row in &m {
                block.extend(row.iter().flat_map(|v| (*v as f32).to_ne_bytes()));
                block.extend(0f32.to_ne_bytes());
            }
        }
        block.resize(96, 0);
        let push = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("fit warp push"),
            contents: &block,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("fit warp"),
            layout: &kernel.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: source_binding,
                    resource: source.as_entire_binding(),
                },
                wgpu::BindGroupEntry { binding: table_binding, resource: table.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: out.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
            ],
        });
        Shaping { pipeline: &kernel.pipeline, group, width, height }
    }

    fn dispatch(&self, pass: &mut wgpu::ComputePass<'_>) {
        pass.set_pipeline(self.pipeline);
        pass.set_bind_group(0, &self.group, &[]);
        pass.dispatch_workgroups(
            (self.width as u32).div_ceil(16),
            (self.height as u32).div_ceil(16),
            1,
        );
    }
}

/// A luma plane resident on the device, so that a caller asking repeatedly pays for it once.
///
/// **The upload is what costs, not the search.** A settle asks about six thousand points and the
/// search itself is a millisecond; shipping the two planes it searches is eight megabytes and
/// several more. The camera's plane never changes across a settle's rounds, so it is uploaded once
/// and held here.
pub struct DevicePlane {
    pub(crate) buffer: crate::gpu::Buffer,
    /// `patch_stats` over this plane, where a caller asked for it. Only ever the plane being
    /// searched *into*, and only where the search is dense enough to reuse a window.
    stats: Option<Tabulated>,
    pub(crate) width: usize,
    pub(crate) height: usize,
}

/// A plane's patch statistics, and the block the pass that wrote them read its size from.
///
/// The uniform is held rather than released at the end of `tabulate`, because the pass is encoded
/// there and submitted by the caller: a buffer destroyed between those two is a buffer the bind
/// group still points at when the queue reaches it.
struct Tabulated {
    buffer: crate::gpu::Buffer,
    /// Held for its count: the bind group the pass was recorded with points at it, and the last
    /// handle dropping destroys it.
    #[expect(dead_code)]
    push: crate::gpu::Buffer,
}

impl DevicePlane {
    /// Room for a plane a shader is about to write, rather than one the host already has.
    fn empty(gpu: &'static crate::gpu::Gpu, width: usize, height: usize) -> DevicePlane {
        DevicePlane {
            buffer: gpu.own_buffer(&wgpu::BufferDescriptor {
                label: Some("correspond plane"),
                size: (width * height * 4) as u64,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
            stats: None,
            width,
            height,
        }
    }

    /// A plane the host already holds, for a test that wants to say what the search will read.
    #[cfg(test)]
    pub(crate) fn from_luma(
        gpu: &'static crate::gpu::Gpu,
        luma: &[f32],
        width: usize,
        height: usize,
    ) -> DevicePlane {
        let bytes: Vec<u8> = luma.iter().flat_map(|v| v.to_ne_bytes()).collect();
        DevicePlane {
            buffer: gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("correspond plane"),
                contents: &bytes,
                usage: wgpu::BufferUsages::STORAGE,
            }),
            stats: None,
            width,
            height,
        }
    }

    /// The luma of `source`, box-averaged down to `(width, height)` on the way.
    ///
    /// Box rather than a filtered resize, as every other reduction of a pair here is: a level of
    /// a pyramid that is sharper than the one it is searched against correlates worse with it,
    /// and the pair is what the search is about.
    ///
    /// **Averaged in the coding, and that is deliberate here where `light` says it is meaningless.**
    /// That module's rule - a mean of sRGB is not the mean of anything, which is why a pyramid
    /// decodes per tap - is about a picture: an average that has to *be* the light those samples
    /// carried. This pyramid is never looked at. It is correlated, and a correlation wants contrast
    /// spread across the tonal range rather than proportional to light, which is the whole reason
    /// vision works on gamma-encoded frames. Measured on the twenty-six frame set from the library's
    /// own grid tiles, decoding per tap and averaging in light costs two junctions of the row and
    /// reshapes the canvas from 3.22:1 to 2.27:1 - the reduced pixels become dominated by the sky,
    /// the dark hills stop carrying structure, and the coarse search keys on self-similar cloud and
    /// matches a frame to the wrong instance of it, 941px out where a whole frame step is 690.
    ///
    /// So the plane arrives from `levelled_source` still coded, on purpose. Anything that wants the
    /// light those samples carried wants `linear_source` and a different function from this one.
    pub(crate) fn reduced_luma(
        gpu: &'static crate::gpu::Gpu,
        source: &Source,
        width: usize,
        height: usize,
    ) -> DevicePlane {
        let mut recording = gpu.record();
        let smaller = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("pyramid level"),
            size: (width * height * 3 * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let reducing = Shaping::new(
            gpu,
            &mut recording,
            &source.buffer,
            (source.width, source.height),
            &smaller,
            (width, height),
            Shape::Box { finish: Finish::None },
        );
        let plane = DevicePlane::empty(gpu, width, height);
        let taking = Shaping::new(
            gpu,
            &mut recording,
            &smaller,
            (width, height),
            &plane.buffer,
            (width, height),
            Shape::Luma,
        );
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            reducing.dispatch(&mut pass);
            taking.dispatch(&mut pass);
        }
        recording.submit();
        plane
    }

    /// The plane carrying the statistics of every window a search will read. `reach` has to be the
    /// one that search will use, since the statistics are of its window and no other.
    pub(crate) fn tabulated(mut self, gpu: &'static crate::gpu::Gpu, reach: Reach) -> DevicePlane {
        let mut recording = gpu.record();
        self.tabulate(gpu, recording.encoder(), reach);
        recording.submit();
        self
    }

    /// The luma of an f32 RGB `source` on the device, written by the pass this records.
    fn luma_of(
        gpu: &'static crate::gpu::Gpu,
        recording: &mut crate::gpu::Recording<'_>,
        source: &crate::gpu::Buffer,
        width: usize,
        height: usize,
    ) -> DevicePlane {
        let plane = DevicePlane::empty(gpu, width, height);
        let shaping = Shaping::new(
            gpu,
            recording,
            source,
            (width, height),
            &plane.buffer,
            (width, height),
            Shape::Luma,
        );
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        shaping.dispatch(&mut pass);
        drop(pass);
        plane
    }

    /// Work every patch statistic out up front, for a plane a dense search will read.
    ///
    /// Encoded rather than submitted, so a caller can put it in front of the search that reads it -
    /// which is the whole point, since a submit of its own would cost the round trip the batch
    /// exists to avoid.
    fn tabulate(
        &mut self,
        gpu: &'static crate::gpu::Gpu,
        encoder: &mut wgpu::CommandEncoder,
        reach: Reach,
    ) {
        let buffer = gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some("patch stats"),
            size: (self.width * self.height * 2 * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let mut block = [
            (self.width as i32).to_ne_bytes(),
            (self.height as i32).to_ne_bytes(),
            (reach.patch as i32).to_ne_bytes(),
        ]
        .concat();
        block.resize(16, 0);
        let push = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("patch stats push"),
            contents: &block,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let kernels = stats_device(gpu);
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("patch stats"),
            layout: &kernels.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
            ],
        });
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernels.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(
                (self.width as u32).div_ceil(16),
                (self.height as u32).div_ceil(16),
                1,
            );
        }
        self.stats = Some(Tabulated { buffer, push });
    }
}

/// Every point's correspondence at once, on the device.
///
/// **A batch, and that is what makes it fit the search at all.** Eighty-one offsets of a 7x7
/// normalised cross correlation per point is template matching, and the host spends more of the
/// camera match on it than on anything else - but the callers reach it from inside `rayon`, which
/// cannot await. So the points are gathered first, handed over in one dispatch outside any parallel
/// region, and consumed afterwards. Nothing has to await inside a `par_iter`.
pub async fn corresponded(
    gpu: &'static crate::gpu::Gpu,
    ours: &DevicePlane,
    theirs: &DevicePlane,
    points: &[[i32; 2]],
) -> Option<Vec<Option<Found>>> {
    corresponded_about(gpu, ours, theirs, points, None, -1, Reach::NARROW).await
}

/// `corresponded`, left where it was written, for a caller that reads the offsets in a shader.
///
/// The whole `Asking` comes back rather than its buffer: it holds the bind group and the uniform
/// the dispatch points at, and destroying either between the submit and the queue reaching it is
/// the failure `Tabulated` records.
fn corresponded_grid(
    gpu: &'static crate::gpu::Gpu,
    ours: &DevicePlane,
    theirs: &DevicePlane,
    points: &[[i32; 2]],
) -> Asking {
    corresponded_grid_about(gpu, ours, theirs, points, None, -1)
}

/// `corresponded_grid`, with each point's search centred on an offset already believed.
fn corresponded_grid_about(
    gpu: &'static crate::gpu::Gpu,
    ours: &DevicePlane,
    theirs: &DevicePlane,
    points: &[[i32; 2]],
    about: Option<&[[i32; 2]]>,
    refine: i32,
) -> Asking {
    let mut recording = gpu.record();
    let at = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("correspond at"),
        contents: &point_words(&readable(points, about, theirs, Reach::NARROW)),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let given = about.map(|offsets| {
        recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("correspond given"),
            contents: &point_words(offsets),
            usage: wgpu::BufferUsages::STORAGE,
        })
    });
    let asking = Asking::new(
        gpu,
        &mut recording,
        ours,
        theirs,
        &at,
        points.len(),
        given.as_ref(),
        refine,
        Reach::NARROW,
    );
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        asking.dispatch(gpu, &mut pass);
    }
    recording.submit();
    asking
}

/// The points a search may actually read, with the rest marked as edges.
///
/// A search centred on `at + given` reads a `PATCH + SEARCH` window about that centre, so a point
/// whose belief pushes the window off `theirs` has nothing to score - and where the belief is the
/// point itself, this is the guard the callers were already applying. `[-1, -1]` is how
/// `correspond.slang` is told a point was never admissible, which it answers as unmatched, so the
/// caller's answers still line up with its points by index.
fn readable(
    points: &[[i32; 2]],
    about: Option<&[[i32; 2]]>,
    theirs: &DevicePlane,
    reach: Reach,
) -> Vec<[i32; 2]> {
    let Some(about) = about else { return points.to_vec() };
    let margin = reach.margin() as i32;
    let (width, height) = (theirs.width as i32, theirs.height as i32);
    points
        .iter()
        .zip(about)
        .map(|(point, given)| {
            let (cx, cy) = (point[0] + given[0], point[1] + given[1]);
            let inside = cx - margin >= 0 && cy - margin >= 0 && cx + margin < width && cy + margin < height;
            match inside {
                true => *point,
                false => [-1, -1],
            }
        })
        .collect()
}

/// Two ints a point, as `correspond.slang` reads its `at` and its `given`.
fn point_words(pairs: &[[i32; 2]]) -> Vec<u8> {
    let mut bytes = vec![0u8; pairs.len() * 8];
    bytes.par_chunks_mut(8).zip(pairs.par_iter()).for_each(|(word, p)| {
        word[..4].copy_from_slice(&p[0].to_ne_bytes());
        word[4..].copy_from_slice(&p[1].to_ne_bytes());
    });
    bytes
}

/// `corresponded`, with each point's search centred on an offset the caller already believes and
/// `refine` deciding how far either way of it to look - negative for the whole window.
///
/// `None` centres each search on the point itself, which is what a caller with nothing to start
/// from wants. The offsets come back relative to the point either way, so a belief the caller
/// handed in is already in the answer.
pub async fn corresponded_about(
    gpu: &'static crate::gpu::Gpu,
    ours: &DevicePlane,
    theirs: &DevicePlane,
    points: &[[i32; 2]],
    about: Option<&[[i32; 2]]>,
    refine: i32,
    reach: Reach,
) -> Option<Vec<Option<Found>>> {
    if points.is_empty() {
        return Some(Vec::new());
    }
    debug_assert!(about.is_none_or(|offsets| offsets.len() == points.len()));
    let mut recording = gpu.record();
    let at = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("correspond at"),
        contents: &point_words(&readable(points, about, theirs, reach)),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let given = about.map(|offsets| {
        recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("correspond given"),
            contents: &point_words(offsets),
            usage: wgpu::BufferUsages::STORAGE,
        })
    });
    let asking = Asking::new(
        gpu,
        &mut recording,
        ours,
        theirs,
        &at,
        points.len(),
        given.as_ref(),
        refine,
        reach,
    );
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        asking.dispatch(gpu, &mut pass);
    }
    asking.copy(recording.encoder());
    recording.submit();
    asking.read(gpu).await
}

/// `correspond.slang`'s `numthreads`, which the span below is a whole number of.
const CORRESPOND_GROUP: u32 = 64;

/// Threads the correspondence search puts along x, the rest going to y.
///
/// **A dense search does not fit in one dimension.** It is a thread per pixel of the camera's
/// plane, and a dispatch dimension holds 65535 workgroups - so a plane past about 4.2M pixels is
/// a validation error, which `gpu::build` promotes to a panic, so `fit_hdr_for` fails and the
/// frame ships with its own colour rather than the camera's. Measured over 43 frames of two real
/// libraries, 8 of them were losing their match to this.
///
/// Below the limit this is every point, so `y` is one group and the dispatch is what it always
/// was. `correspond.slang` reconstructs the index as `id.y * span + id.x` and must agree.
///
/// Split evenly rather than filling x first: at 66084 groups, packing x to the limit dispatches
/// 65535 by 2 and half of the second row launches only to fail the bounds test, where an even
/// 33042 by 2 is the same coverage with nothing spare.
fn dispatch_span(points: usize) -> usize {
    const LIMIT: usize = 65535;
    let groups = (points.div_ceil(CORRESPOND_GROUP as usize)).max(1);
    groups.div_ceil(groups.div_ceil(LIMIT)) * CORRESPOND_GROUP as usize
}

/// One correspondence dispatch's own buffers, so a caller can put it in an encoder beside whatever
/// else it wanted submitted - the settle builds the plane it searches in the same submit.
struct Asking {
    pub(crate) found: crate::gpu::Buffer,
    staging: crate::gpu::Buffer,
    /// Held rather than read, as `Tabulated`'s is and for the same reason. `filler` is bound at
    /// the stats slot for an untabulated plane, so it is one of these too.
    #[expect(dead_code)]
    push: crate::gpu::Buffer,
    #[expect(dead_code)]
    filler: crate::gpu::Buffer,
    group: wgpu::BindGroup,
    points: usize,
    tabulated: bool,
}

impl Asking {
    /// The uniform's tail: how far a comparison reaches, which the shader reads as lengths in the
    /// plane it was handed.
    fn reaching(reach: Reach) -> [u8; 8] {
        let mut out = [0u8; 8];
        out[..4].copy_from_slice(&(reach.patch as i32).to_ne_bytes());
        out[4..].copy_from_slice(&(reach.search as i32).to_ne_bytes());
        out
    }

    fn new(
        gpu: &'static crate::gpu::Gpu,
        recording: &mut crate::gpu::Recording<'_>,
        ours: &DevicePlane,
        theirs: &DevicePlane,
        at: &crate::gpu::Buffer,
        points: usize,
        given: Option<&crate::gpu::Buffer>,
        refine: i32,
        reach: Reach,
    ) -> Asking {
        let bytes = (points * 4 * 4) as u64;
        let found = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("correspond found"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let staging = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("correspond out"),
            size: bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        // Ten fields is forty bytes, which a uniform block rounds up to forty-eight.
        let mut block = [
            (ours.width as i32).to_ne_bytes(),
            (ours.height as i32).to_ne_bytes(),
            (points as i32).to_ne_bytes(),
            (FLAT_PATCH as f32).to_ne_bytes(),
            (MATCH_MIN as f32).to_ne_bytes(),
            (dispatch_span(points) as i32).to_ne_bytes(),
            refine.to_ne_bytes(),
            i32::from(given.is_some()).to_ne_bytes(),
        ]
        .concat();
        block.extend_from_slice(&Asking::reaching(reach));
        block.resize(48, 0);
        let push = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("correspond push"),
            contents: &block,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let filler = unused_buffer(recording);
        let their_stats = theirs.stats.as_ref().map_or(&filler, |stats| &stats.buffer);
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("correspond"),
            layout: &search_device(gpu).tabulated.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: ours.buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: theirs.buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: at.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: found.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: their_stats.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: given.unwrap_or(&filler).as_entire_binding(),
                },
                wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
            ],
        });
        Asking { found, staging, push, filler, group, points, tabulated: theirs.stats.is_some() }
    }

    fn dispatch(&self, gpu: &'static crate::gpu::Gpu, pass: &mut wgpu::ComputePass<'_>) {
        pass.set_pipeline(search_device(gpu).pipeline(self.tabulated));
        pass.set_bind_group(0, &self.group, &[]);
        let across = dispatch_span(self.points) as u32 / CORRESPOND_GROUP;
        let groups = (self.points as u32).div_ceil(CORRESPOND_GROUP).max(1);
        pass.dispatch_workgroups(across, groups.div_ceil(across), 1);
    }

    fn copy(&self, encoder: &mut wgpu::CommandEncoder) {
        encoder.copy_buffer_to_buffer(&self.found, 0, &self.staging, 0, (self.points * 16) as u64);
    }

    async fn read(&self, gpu: &'static crate::gpu::Gpu) -> Option<Vec<Option<Found>>> {
        crate::gpu::read_back(gpu, &self.staging, |mapped| {
            mapped
                .par_chunks_exact(16)
                .map(|word| {
                    let take = |at: usize| {
                        f32::from_ne_bytes([word[at], word[at + 1], word[at + 2], word[at + 3]])
                    };
                    let (dx, dy, peak, outcome) = (take(0), take(4), take(8), take(12));
                    match outcome < 0.0 {
                        true => None,
                        false => Some(Found {
                            dx: f64::from(dx),
                            dy: f64::from(dy),
                            peak: f64::from(peak),
                            featureless: outcome > 0.0,
                        }),
                    }
                })
                .collect::<Vec<_>>()
        })
        .await
    }
}

/// What the search found at one point.
///
/// The offsets are sub-pixel: the scan lands on the nearest whole one and a parabola through the
/// peak's neighbours says where between them the correlation actually peaks. A caller that wants
/// a tap rounds; one that is solving a geometry from a field of these wants the remainder.
pub struct Found {
    pub dx: f64,
    pub dy: f64,
    pub peak: f64,
    /// The offset is zero because there was no structure to match on, not because a search
    /// chose it. Worth separating when reading these: a featureless point is not evidence
    /// the search works, only that it was not needed.
    pub featureless: bool,
}

/// The fit's two planes after registration, where the stages downstream read them.
struct Corresponded {
    render: crate::gpu::Buffer,
    jpeg: crate::gpu::Buffer,
    width: usize,
    height: usize,
}

/// The two fit-grid planes resampled onto found correspondence rather than assumed
/// alignment.
///
/// Same grid and same indices as the blurred planes they replace, so every stage that
/// reads a pair keeps reading it the same way. What changes is that pixel `p` now holds
/// two views of one point in the *scene* rather than two views of one coordinate.
///
/// This is what the prefilter blur was standing in for. The geometry fit leaves a
/// residual and nothing downstream knew where a pixel had gone, so both sides were
/// smeared until the misregistration stopped mattering - which is also why a small
/// saturated object arrives desaturated, and why a light neutral beside foliage arrives
/// green. Doing it here rather than only where the chroma map is fitted is the difference
/// between the fit reading corresponded pixels and the fit being *scored* on them: with
/// the objective still measured against the blurred planes, every gate in the fit would be
/// asking a smeared oracle whether a sharply-sampled correction was an improvement.
async fn registered(
    gpu: &'static crate::gpu::Gpu,
    planes: &FitPlanes,
) -> Option<Corresponded> {
    let (width, height) = (planes.render.width, planes.render.height);
    let (ours, theirs) = (&planes.sharp.wide, &planes.sharp.camera);
    let scale = ours.width / width.max(1);
    let held = |render: crate::gpu::Buffer, jpeg: crate::gpu::Buffer| {
        Some(Corresponded { render, jpeg, width, height })
    };
    if scale == 0 || ours.width != theirs.width || ours.height != theirs.height {
        return held(planes.render.buffer.clone(), planes.jpeg.buffer.clone());
    }

    let edge = PATCH + SEARCH;
    // One search for the whole grid, so the answers line up with `p` by index and the pass below
    // needs no map from a compaction back to a position. A position the margins exclude is asked
    // about as `(-1, -1)`, which `correspond.slang` answers with the outcome that means nothing
    // was found.
    let (held_wide, held_tall) =
        (ours.width.min(theirs.width) as isize, ours.height.min(theirs.height) as isize);
    let asked: Vec<[i32; 2]> = (0..width * height)
        .into_par_iter()
        .map(|p| {
            let x = ((p % width) * scale) as isize;
            let y = ((p / width) * scale) as isize;
            let inside =
                x >= edge && y >= edge && x < held_wide - edge && y < held_tall - edge;
            match inside {
                true => [x as i32, y as i32],
                false => [-1, -1],
            }
        })
        .collect();
    let asking = corresponded_grid(gpu, &planes.resident.ours, &planes.resident.theirs, &asked);

    let mut recording = gpu.record();
    // Both outputs start as the prefiltered planes, so a position the search could not act on
    // keeps its blurred value by the kernel leaving it alone. Blur is a poor answer to
    // misregistration but it is a bounded one, where a sharp read at an unverified location is not.
    let carried = |recording: &mut crate::gpu::Recording<'_>, from: &crate::gpu::Buffer| {
        let bytes = (width * height * 3 * 4) as u64;
        let out = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("fit plane registered"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        recording.encoder().copy_buffer_to_buffer(from, 0, &out, 0, bytes);
        out
    };
    let mine = carried(&mut recording, &planes.render.buffer);
    let camera = carried(&mut recording, &planes.jpeg.buffer);
    let gains = match planes.sharp.falloff {
        None => unused_buffer(&mut recording),
        Some((a, b)) => {
            let contents: Vec<u8> = (0..=u8::MAX)
                .flat_map(|r| (crate::fit::Gain::at(a, b, r) as f32).to_ne_bytes())
                .collect();
            recording.init(&wgpu::util::BufferInitDescriptor {
                label: Some("fit register gains"),
                contents: &contents,
                usage: wgpu::BufferUsages::STORAGE,
            })
        }
    };
    let (cx, cy) = (ours.width as f64 / 2.0, ours.height as f64 / 2.0);
    let mut block = [
        (width as i32).to_ne_bytes(),
        (height as i32).to_ne_bytes(),
        (ours.width as i32).to_ne_bytes(),
        (ours.height as i32).to_ne_bytes(),
        (scale as i32).to_ne_bytes(),
        (SAMPLE as i32).to_ne_bytes(),
        (SAMPLE_RANGE as f32).to_ne_bytes(),
        i32::from(planes.sharp.falloff.is_some()).to_ne_bytes(),
        ((cx * cx + cy * cy).sqrt().max(1.0) as f32).to_ne_bytes(),
    ]
    .concat();
    block.resize(48, 0);
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit register push"),
        contents: &block,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let built = register_device(gpu);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("fit register"),
        layout: &built.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: planes.sharp.wide.buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: planes.sharp.camera.buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry { binding: 2, resource: asking.found.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: gains.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: mine.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: camera.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&built.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((width as u32).div_ceil(16), (height as u32).div_ceil(16), 1);
    }
    recording.submit();
    held(mine, camera)
}

/// Where each chroma axis starts and how many gaps it spans per unit, for *this* frame.
///
/// **Sized to what the grade will look up, not to the fit's pairs.** The pairs are
/// censored - the camera's clipped pixels and everything over `TRUST_CEILING` are gated
/// out, and what did not correlate stays blurred - so their chroma tops out far below the
/// frame's own. Measured on a frame of neon-lit skin: the pairs reached +0.20 / +0.16 on
/// the two axes where the sharp plane runs +0.35 / +1.58, and on five of six frames the
/// pair-sized reach sat on the degeneracy floor outright. Every saturated colour then
/// rode the outermost nodes: the fit averaged unlike hues into them, and the grade's
/// correction stepped along the clamp contour - which crosses a lit subject as a visible
/// band, because absolute chroma grows with brightness.
///
/// Each tail sized on its own, because a frame's chroma is neither centred nor alike on
/// the two axes: skin, foliage and sky are all one-sided, and the narrower tail of a
/// one-sided frame is empty. Zero still lands exactly on a node - the split is an integer
/// gap count - so a grey is left to the node that says leave it alone rather than
/// interpolating between two neighbours' corrections.
///
/// Taken from percentiles so a single outlier cannot stretch the grid, floored so a frame
/// of snow and sky cannot collapse the axes onto its own noise, and capped at
/// `CHROMA_REACH`: past the cap live only colours the camera clipped on, where no node
/// has data and the edge hold is the answer anyway.
async fn chroma_span(
    gpu: &'static crate::gpu::Gpu,
    colour: &HdrColour,
    sharp: &Sharp,
) -> Option<[[f64; 2]; 2]> {
    let reach = ChromaMap::warp(CHROMA_REACH);
    let fallback = [-reach, ChromaMap::scale_for(reach)];
    let samples = sharp.wide.pixels();
    if samples < MIN_SPAN_SAMPLES {
        return Some([fallback; 2]);
    }
    let quantile = |q: f64| ((samples as f64 * q) as usize).min(samples - 1);
    let picked =
        crate::fit_span::spans(gpu, colour, &sharp.wide, sharp.falloff, [quantile(0.001), quantile(0.999)])
            .await?;
    Some(std::array::from_fn(|axis| {
        let below = ChromaMap::warp((-picked[axis][0]).clamp(CHROMA_REACH / 8.0, CHROMA_REACH));
        let above = ChromaMap::warp(picked[axis][1].clamp(CHROMA_REACH / 8.0, CHROMA_REACH));
        let gaps = (MAP_CHROMA - 1) as f64;
        // At least one gap per side, so the shorter tail keeps a cell of its own instead
        // of clamping against the zero node.
        let zero = ((gaps * below / (below + above)).round() as usize).clamp(1, MAP_CHROMA - 2);
        let cell = (below / zero as f64).max(above / (gaps - zero as f64));
        [-(zero as f64) * cell, 1.0 / cell]
    }))
}

/// The surround in both the places that read it: the device, where every probe gathers it beside
/// the colour, and the host, where the thumb the grade carries is sampled out of it.
struct Surround {
    buffer: crate::gpu::Buffer,
    of: Vec<f64>,
}

/// The neighbourhood's brightness at every fit-grid pixel, in the render's own
/// scene-linear units: the luma, box-blurred to about a tenth of the frame.
///
/// This is the surround the lattice's fourth axis reads (`MAP_SURROUND`), and the grade
/// computes the same quantity from the frame it holds - a blur this wide is indifferent
/// to which of the two pipelines' frames it came from.
///
/// Even on purpose, not edge-aware: a bilateral measure that held a boundary's two
/// populations apart was tried, and it painted the lit transition *harder* - the
/// transition band is where every supervision gate drops its samples, so sharpening its
/// coordinate only concentrates the model's untaught answer there. What the transition
/// needs is teachers, not a finer address.
async fn surround_plane(
    gpu: &'static crate::gpu::Gpu,
    render: &Source,
    width: usize,
    height: usize,
) -> Option<Surround> {
    let mut recording = gpu.record();
    let source = crate::fit::Sampled {
        buffer: render.buffer.clone(),
        width,
        height,
        packed: false,
    };
    // Blurred and then reduced, where the host took the luma first. Both are linear, so the two
    // orders are the same arithmetic, and this way the blur is the only pass that has to exist.
    let blurred = crate::fit::box_blurred(gpu, &mut recording, &source, width / 10);
    let plane = DevicePlane::luma_of(gpu, &mut recording, &blurred.buffer, width, height);
    let out = staged(&mut recording, &plane.buffer, width * height);
    recording.submit();
    let of = crate::gpu::read_back(gpu, &out, |mapped| {
        mapped
            .par_chunks_exact(4)
            .map(|word| f64::from(f32::from_ne_bytes([word[0], word[1], word[2], word[3]])))
            .collect::<Vec<f64>>()
    })
    .await?;
    Some(Surround { buffer: plane.buffer, of })
}

/// How far the four neighbours two pixels out may sit from the centre, in luma and
/// relative to it, for a shift of a pixel or two to be unable to change the colour.
pub(crate) const FLAT_ENOUGH: f64 = 0.04;

/// A registered wide-plane sample: ours with the falloff on, the camera's answer, and
/// the lattice's hue weight for it.
///
/// Collected once and split exactly as the pairs are, so the map is fitted from one half
/// and judged on the other. The saturated objects and lit transitions this pass exists
/// for are what the fit-grid pairs structurally cannot hold - the mask's gradient gate
/// drops sloped regions - so a gate that scores only pairs can neither credit a map for
/// correcting them nor blame one for wrecking them.
struct WideSample {
    v: [f64; 3],
    t: [f64; 3],
    hue: f64,
    /// The neighbourhood's brightness at this sample, from the frame's surround plane.
    s: f64,
}

/// The wide planes' registered samples, gated and searched, ready to fit from or judge on.
async fn wide_samples(
    gpu: &'static crate::gpu::Gpu,
    sharp: &Sharp,
    resident: &Wide,
    // The fit grid, which every wide pixel's weight and surround are read at.
    (fit_wide, fit_tall): (usize, usize),
    weights: &[f64],
    census: &HueCensus,
    surround: &[f64],
    ceiling: f64,
) -> Vec<WideSample> {
    let (wide, target) = (&sharp.wide, &sharp.camera);
    // The planes need not share a grid exactly - the pairing is by correspondence, not
    // by coordinate, and the search exists to absorb exactly this kind of shift. What it
    // cannot absorb is a different *picture*: a sensor's aspect is not its preview's, so
    // this camera's render is 1280x853 against a 1280x855 preview - two rows, well within
    // the search - where an SDR bug once paired 571x855 against 855x1280, which is not a
    // stretch but a different photograph. Demanding equality was how two rows silently
    // disabled the whole pass on every frame of this camera.
    if wide.width.abs_diff(target.width) > 8 || wide.height.abs_diff(target.height) > 8 {
        debug_assert!(false, "the wide planes are not two views of one grid");
        return Vec::new();
    }
    let (width, height) = (wide.width.min(target.width), wide.height.min(target.height));
    let mut lap = crate::clock::laps("  wide ");
    // **The gates first, then one search for everything that passed them.** The tests are pure
    // reads of the camera's plane, so they run before anything is corresponded - and the search,
    // which is what costs, then goes to the device as a single batch.
    let planes = crate::fit_wide::Planes { ours: wide, theirs: target, falloff: sharp.falloff, ceiling };
    let Some(admitted) = crate::fit_wide::admit(gpu, &planes).await else {
        return Vec::new();
    };
    // **A search per tile, not per admitted pixel** (`WIDE_TILE`). Gathered tile-major here so
    // the probes go to the device as one batch; the gather itself keeps the row-major order the
    // gate wrote, which is the order every moment is summed in.
    let tiles_across = width.div_ceil(WIDE_TILE);
    let mut tiles: Vec<Vec<[i32; 2]>> =
        vec![Vec::new(); tiles_across * height.div_ceil(WIDE_TILE)];
    for point in &admitted.at {
        tiles[(point[1] as usize / WIDE_TILE) * tiles_across + (point[0] as usize / WIDE_TILE)]
            .push(*point);
    }
    let mut asked: Vec<[i32; 2]> = Vec::new();
    // Spread through the tile's own admitted pixels rather than taken from its start, so the
    // probes cannot all land on one edge of it.
    let probes: Vec<(usize, usize)> = tiles
        .iter()
        .map(|holds| {
            let open = asked.len();
            if !holds.is_empty() {
                asked.extend(holds.iter().step_by(holds.len().div_ceil(WIDE_TILE_PROBES)));
            }
            (open, asked.len() - open)
        })
        .collect();
    lap("gate, tiles");
    // Corresponded rather than gated on flatness. This pass exists for small saturated
    // objects, and those are curved and textured almost everywhere - a glazed pot with a
    // highlight down it has barely a featureless pixel on it. Flatness would only be
    // standing in for registration ("flat enough that a pixel of shift cannot change the
    // colour"), and the search answers registration directly, so a textured interior
    // counts.
    let Some(searched) = corresponded(gpu, &resident.ours, &resident.theirs, &asked).await else {
        return Vec::new();
    };
    lap("probe search");
    // The best-scoring probe decides where its tile looks, a measured match beating a
    // featureless one however confidently the latter reports its zero.
    let shifts: Vec<[i32; 2]> = probes
        .iter()
        .map(|(open, count)| {
            (0..*count)
                .filter_map(|k| searched[open + k].as_ref())
                .max_by(|a, b| b.featureless.cmp(&a.featureless).then(a.peak.total_cmp(&b.peak)))
                // Rounded: what a tile hands its pixels is where to centre a whole-offset
                // search, and the sub-pixel remainder is measured again per pixel below.
                .map_or([0, 0], |found| {
                    [found.dx.round() as i32, found.dy.round() as i32]
                })
        })
        .collect();

    // **Then every pixel, about its own tile's answer.** The tile says where to look and this
    // says what is actually there, so the pass keeps the per-pixel rejection it has always had -
    // the earlier shape of this, which took the tile's offset as each pixel's answer outright,
    // carried pixels whose content matches at no offset and cost DSC02981 a tenth of a deltaE.
    let about: Vec<[i32; 2]> = admitted
        .at
        .iter()
        .map(|p| shifts[(p[1] as usize / WIDE_TILE) * tiles_across + (p[0] as usize / WIDE_TILE)])
        .collect();
    let refined = corresponded_grid_about(
        gpu,
        &resident.ours,
        &resident.theirs,
        &admitted.at,
        Some(&about),
        WIDE_REFINE,
    );
    lap("refine search");
    let Some(taken) = crate::fit_wide::gather(gpu, &planes, &admitted, &refined.found).await
    else {
        return Vec::new();
    };
    // The hue weight the pairs carry and the neighbourhood the lattice reads, looked up on the
    // fit-grid pixel each wide one sits inside. Neither is a read of a picture, and both are host
    // arrays the gather has no business carrying.
    let samples: Vec<WideSample> = taken
        .into_iter()
        .zip(&admitted.at)
        .filter_map(|(pair, point)| {
            let (v, t) = pair?;
            let fit_at = (point[1] as usize / 2).min(fit_tall - 1) * fit_wide
                + (point[0] as usize / 2).min(fit_wide - 1);
            Some(WideSample { v, t, hue: census.weigh(weights, fit_at), s: surround[fit_at] })
        })
        .collect();
    lap("gather");
    samples
}

/// The mean hue-weighted deltaE over held-out wide samples, which is the half of the
/// held-out question `measure` cannot ask: the pairs live only where the mask's gradient
/// gate admits them, and every population the wide pass exists for - saturated objects,
/// lit transitions - is precisely what that gate drops.
async fn wide_score(
    gpu: &'static crate::gpu::Gpu,
    colour: &HdrColour,
    to_srgb: &[[f64; 3]; 3],
    wides: &[WideSample],
) -> Option<f64> {
    if wides.is_empty() {
        return Some(0.0);
    }
    let samples: Vec<[f32; 4]> = wides
        .iter()
        .map(|s| [s.v[0] as f32, s.v[1] as f32, s.v[2] as f32, s.s as f32])
        .collect();
    let below = evaluate(gpu, colour, &samples, Stage::Full);
    let target: Vec<[f64; 3]> = wides.iter().map(|s| s.t).collect();
    let hue: Vec<f64> = wides.iter().map(|s| s.hue).collect();
    let scoring =
        crate::fit_score::Scoring::new(gpu, below.buffer, &target, &hue, to_srgb, SCORE_BLOCK);
    let neutral = [crate::fit_score::Probe::neutral()];
    let mut partials = scoring.partials(&crate::fit_score::Shape::Saturation, &neutral).await?;
    let (sum, weight) = partials
        .remove(0)
        .iter()
        .fold((0.0, 0.0), |a, b| (a.0 + b.balanced, a.1 + b.weight));
    Some(sum / weight.max(1e-9))
}

/// Where the lattice's four axes sit for one frame.
///
/// The scales are the frame's own reach, so the ceiling's stretch is addressable rather than all
/// of it clamping onto the top level plane (`with_level_reach`).
struct LatticeAxes {
    span: [[f64; 2]; 2],
    level_scale: f64,
    surround_scale: f64,
}

impl LatticeAxes {
    fn of(colour: &HdrColour, span: [[f64; 2]; 2]) -> LatticeAxes {
        LatticeAxes {
            span,
            level_scale: (MAP_LEVEL - 1) as f64 / colour.ceiling.sqrt(),
            surround_scale: (MAP_SURROUND - 1) as f64 / colour.ceiling.sqrt(),
        }
    }
}

impl ChromaMoments {
    /// One sample landed on the sixteen nodes about it, counting `of` times each node's share.
    fn land(
        &mut self,
        at: &[usize; 16],
        weight: &[f64; 16],
        of: f64,
        input: [f64; 3],
        target: [f64; 2],
        theirs: f64,
    ) {
        let ours = input[2];
        for (node, share) in at.iter().copied().zip(weight.iter().copied()) {
            let sw = of * share;
            if sw <= 0.0 {
                continue;
            }
            for a in 0..2 {
                for b in 0..3 {
                    self.atb[node][a][b] += sw * input[b] * target[a];
                }
            }
            for a in 0..3 {
                for b in 0..3 {
                    self.ata[node][a][b] += sw * input[a] * input[b];
                }
                self.sx[node][a] += sw * input[a];
            }
            for a in 0..2 {
                self.st[node][a] += sw * target[a];
            }
            self.btb[node] += sw * (target[0] * target[0] + target[1] * target[1]);
            // Weighted least squares for the scalar `g` in `g . ours = theirs`, which is
            // `sum(w . ours . theirs) / sum(w . ours^2)`. Relative rather than an offset
            // so it stays near 1 where the data runs out, which is the property that made
            // the chroma half safe to apply above the fit domain.
            self.lta[node] += sw * ours * ours;
            self.ltb[node] += sw * ours * theirs;
            for c in 0..2 {
                self.lda[node][c] += sw * input[c] * theirs;
            }
            self.seen[node] += sw;
        }
    }

    /// `other`'s sums onto this one's, node by node.
    fn add(&mut self, other: &ChromaMoments) {
        for node in 0..MAP_NODES {
            for a in 0..3 {
                for b in 0..3 {
                    self.ata[node][a][b] += other.ata[node][a][b];
                }
                self.sx[node][a] += other.sx[node][a];
            }
            for a in 0..2 {
                for b in 0..3 {
                    self.atb[node][a][b] += other.atb[node][a][b];
                }
                self.st[node][a] += other.st[node][a];
                self.lda[node][a] += other.lda[node][a];
            }
            self.btb[node] += other.btb[node];
            self.lta[node] += other.lta[node];
            self.ltb[node] += other.ltb[node];
            self.seen[node] += other.seen[node];
        }
    }
}

/// Landings a thread sums before its block is folded in.
///
/// Fixed, and the blocks folded in order, for the reason `MEASURE_BLOCK` is: the block shape is
/// part of the summation order and so part of the answer, and a fold that followed rayon's
/// scheduling would fit a different lattice run to run.
const LANDING_BLOCK: usize = 1 << 16;

/// A sample with the lattice's cell for it worked out - the corner below it and its fraction
/// across the cell on each axis - and what it lands there.
///
/// Worked out once and landed many times: every rung of the ladder lands the same wide samples
/// again at a different weight.
struct Landed {
    corner: [u8; 4],
    fraction: [f64; 4],
    /// The sample's chroma and, third, the luma it arrived with, which is what carries a tint on
    /// a colour that has no chroma to scale.
    input: [f64; 3],
    /// The camera's chroma about the camera's own luma: lightness is carried by the gain rather
    /// than by these, so a node that wants only one of the two is not made to pay for the other.
    target: [f64; 2],
    theirs: f64,
    /// What the sample counts for, before whatever a rung scales it by.
    weight: f64,
}

impl Landed {
    /// `m` is the sample through the tone stage and the matrix (`Stage::ToneMatrix`), with its
    /// luma fourth; `t` is the camera's rendering of it.
    fn of(axes: &LatticeAxes, m: [f32; 4], t: [f64; 3], surround: f64, weight: f64) -> Landed {
        let ours = f64::from(m[3]);
        let theirs = LUMA[0] * t[0] + LUMA[1] * t[1] + LUMA[2] * t[2];
        let (d0, d2) = (f64::from(m[0]) - ours, f64::from(m[2]) - ours);
        let (e0, e2) = (t[0] - theirs, t[2] - theirs);
        let (corner, fraction) = ChromaMap::cell(axes, ours, surround, d0, d2);
        Landed {
            corner: corner.map(|c| c as u8),
            fraction,
            input: [d0, d2, ours],
            target: [e0, e2],
            theirs,
            weight,
        }
    }
}


/// Cells the lattice holds: one fewer than nodes on every axis, a cell being the gap between two.
pub(crate) const MAP_CELLS: usize =
    (MAP_CHROMA - 1) * (MAP_CHROMA - 1) * (MAP_LEVEL - 1) * (MAP_SURROUND - 1);

/// Every pair's landing folded into the lattice's nodes, without any of them crossing the bus.
///
/// **The pairs' half only.** The wide samples go through `landed_on` still: there are thousands of
/// them against these hundreds of thousands, and the ladder re-folds them at seven weights, which
/// is a host loop over a small list rather than over a picture.
///
/// What goes up is a surround and a hue weight per pair - the two things `Landed::of` reads that
/// are indexed by pixel rather than by pair - which is half what a full evaluated sample would
/// cost coming down, and an upload rather than a stall.
async fn pair_moments(
    gpu: &'static crate::gpu::Gpu,
    colour: &HdrColour,
    render: &Source,
    axes: &LatticeAxes,
    surround: &Surround,
    pairs: &Pairs,
    weights: &[f64],
    census: &HueCensus,
) -> Option<ChromaMoments> {
    let count = pairs.at.len();
    let samples = gathered(gpu, render, &pairs.indices, count, Some(&surround.buffer));
    let through = evaluate_over(gpu, colour, &samples, count, Stage::ToneMatrix);
    let upload = |label: &str, of: &dyn Fn(usize) -> f64| {
        let bytes: Vec<u8> = pairs.at.iter().flat_map(|p| (of(*p) as f32).to_ne_bytes()).collect();
        gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: &bytes,
            usage: wgpu::BufferUsages::STORAGE,
        })
    };
    let surrounds = upload("fit lattice surround", &|p| surround.of[p]);
    let hue = upload("fit lattice hue", &|p| census.weigh(weights, p));

    let nodes = crate::fit_lattice::moments(
        gpu,
        &through.buffer,
        pairs.linear_on(gpu),
        &surrounds,
        &hue,
        count,
        &crate::fit_lattice::Axes {
            low: [axes.span[0][0], axes.span[1][0]],
            scale: [axes.span[0][1], axes.span[1][1]],
            level: axes.level_scale,
            surround: axes.surround_scale,
        },
        MAP_NODES,
        MAP_CELLS,
    )
    .await?;

    let mut moments = ChromaMoments::default();
    for (node, sums) in nodes.iter().enumerate() {
        for a in 0..3 {
            for b in 0..3 {
                moments.ata[node][a][b] = sums[a * 3 + b];
            }
            moments.sx[node][a] = sums[15 + a];
        }
        for a in 0..2 {
            for b in 0..3 {
                moments.atb[node][a][b] = sums[9 + a * 3 + b];
            }
            moments.st[node][a] = sums[18 + a];
            moments.lda[node][a] = sums[23 + a];
        }
        moments.btb[node] = sums[20];
        moments.lta[node] = sums[21];
        moments.ltb[node] = sums[22];
        moments.seen[node] = sums[25];
    }
    Some(moments)
}

/// `from` with every landing added, each counting `scale` times its own weight.
fn landed_on(from: &ChromaMoments, landings: &[Landed], scale: f64) -> ChromaMoments {
    let blocks: Vec<ChromaMoments> = landings
        .par_chunks(LANDING_BLOCK)
        .map(|block| {
            let mut moments = ChromaMoments::default();
            for landing in block {
                let (at, weight) =
                    ChromaMap::nodes_of(landing.corner.map(usize::from), landing.fraction);
                let of = scale * landing.weight;
                moments.land(&at, &weight, of, landing.input, landing.target, landing.theirs);
            }
            moments
        })
        .collect();
    let mut merged = from.clone();
    for block in &blocks {
        merged.add(block);
    }
    merged
}

/// The wide samples, for the colours the fit grid cannot hold: a small saturated object is mostly
/// edge at the pair grid's width and mostly interior at the wide planes', and the fit is only
/// ever as good as whether it saw the colour at all - a blue pot puts a handful of pairs into
/// `pair_landings`, out of hundreds of thousands.
///
/// At the hue weight the pairs carry; what a rung scales that by is how much they may outvote
/// the pairs where both live, a cell only these samples reach being fully taught at any weight
/// that clears `MAP_CONFIDENCE` - which is why the caller offers the gate a ladder of them.
async fn wide_landings(
    gpu: &'static crate::gpu::Gpu,
    colour: &HdrColour,
    axes: &LatticeAxes,
    wides: &[WideSample],
) -> Option<Vec<Landed>> {
    let samples: Vec<[f32; 4]> = wides
        .iter()
        .map(|s| [s.v[0] as f32, s.v[1] as f32, s.v[2] as f32, s.s as f32])
        .collect();
    let through = evaluated(gpu, colour, &samples, Stage::ToneMatrix).await?;
    Some(
        through
            .par_iter()
            .zip(wides.par_iter())
            .map(|(m, sample)| Landed::of(axes, *m, sample.t, sample.s, sample.hue))
            .collect(),
    )
}

/// The chroma correction, fitted per node from the pairs that land near it.
///
/// This is the stage that gives the model a hue axis. Without one, the only way to say
/// "the camera treats grass differently from a brown" is to bend a per-channel tone
/// curve, which is indexed by a channel's value and cannot tell grass from a grey of the
/// same green - so the correction meant for the lawn lands on every neutral at that
/// level, washing a white bird bath and pale fur. Holding the three tone curves to one
/// shape suppresses that, and then wrecks any frame whose channels really do render
/// differently.
///
/// Solved rather than searched: with the nodes fixed and the interpolation linear in
/// them, matching our chroma to the camera's is a weighted least squares per node.
fn fitted_chroma(
    axes: &LatticeAxes,
    moments: &ChromaMoments,
    saturation: f64,
) -> Option<ChromaMap> {
    const NODES: usize = MAP_NODES;
    let ChromaMoments { ata, atb, sx, st, btb, lta, lda, ltb, seen } = moments;

    // Each node solved on its own, then pulled back toward the scalar by how little it
    // saw. A node with nothing keeps nothing of its own.
    let flat = [saturation, 0.0, 0.0, saturation, 0.0, 0.0, 1.0, 0.0, 0.0];
    let mut map = ChromaMap {
        low: [axes.span[0][0], axes.span[1][0]],
        scale: [axes.span[0][1], axes.span[1][1]],
        level_scale: axes.level_scale,
        surround_scale: axes.surround_scale,
        ..ChromaMap::coarse_shell(vec![flat; MAP_NODES])
    };
    let mut fitted = 0usize;
    for node in 0..NODES {
        // The lightness gain first, and independently: it is a scalar least squares that
        // shares only the node weights with the chroma solve, so a node whose chroma is
        // degenerate can still carry a lightness correction. Bounded for the reason the
        // chroma gain is - a node that saw a handful of near-black pixels can otherwise
        // ask for an arbitrary ratio, and lightness is the one axis where that shows.
        if lta[node] > 0.0 {
            let solved = (ltb[node] / lta[node]).clamp(1.0 / MAP_MAX_LUMA, MAP_MAX_LUMA);
            let keep = seen[node] / (seen[node] + MAP_CONFIDENCE);
            let gain = 1.0 + (solved - 1.0) * keep;
            map.nodes[node][6] = gain;

            // What the gain could not say. A single scalar gives every colour in a node the
            // same lightness correction, so a small saturated object needing 1.4 and the
            // surroundings it shares a node with needing 1.0 come out at their average - the
            // blue pot's node solved to 1.006 with the pot inside it. These two terms let
            // lightness vary with chroma *within* a node, fitted on what the scalar left
            // behind so the scalar itself is unchanged and stays as well conditioned as it
            // was. Solving lightness from scratch over all three inputs instead was tried:
            // it is badly conditioned on a node's dominant population and drove the bluest
            // pairs to -0.12 red.
            let a = ata[node];
            let m2 = [
                [a[0][0] + MAP_RIDGE * a[0][0].max(1e-12), a[0][1]],
                [a[1][0], a[1][1] + MAP_RIDGE * a[1][1].max(1e-12)],
            ];
            let rhs = [lda[node][0] - gain * a[0][2], lda[node][1] - gain * a[1][2]];
            let det = m2[0][0] * m2[1][1] - m2[0][1] * m2[1][0];
            if det.abs() > 1e-18 {
                let h = (rhs[0] * m2[1][1] - m2[0][1] * rhs[1]) / det;
                let i = (m2[0][0] * rhs[1] - rhs[0] * m2[1][0]) / det;
                map.nodes[node][7] = (h * keep).clamp(-MAP_MAX_TINT, MAP_MAX_TINT);
                map.nodes[node][8] = (i * keep).clamp(-MAP_MAX_TINT, MAP_MAX_TINT);
            }
        }

        let a = ata[node];
        // Each column damped against **its own** scale, not a shared one. `l` is order 1
        // where `d` is order 0.01, so their diagonals differ by about four orders of
        // magnitude; one ridge taken off the trace is then ~800x the chroma terms' own
        // size and ~0.3x the luma term's. That damps the 2x2 to nothing while leaving the
        // luma-to-chroma tint almost free - so the model loses the chroma correction it
        // was built for and keeps the one degree of freedom that can turn a grey green.
        //
        // It did exactly that: a neutral fed through the fitted model came out +25 counts
        // of green at mid level, from a frame where nothing grey is green. Relative
        // damping is scale-invariant, so the same `MAP_RIDGE` now means the same strength
        // for every column regardless of the units it happens to be carried in.
        if !(a[0][0] > 0.0 && a[1][1] > 0.0 && a[2][2] > 0.0) {
            continue;
        }
        let ridge: [f64; 3] = std::array::from_fn(|i| MAP_RIDGE * a[i][i]);
        let mut m = a;
        for i in 0..3 {
            m[i][i] += ridge[i];
        }
        // A cast costs more than scatter of the same size, and this is where that has to
        // be said: the nodes are solved in closed form, so a term added to the *score*
        // picks between finished maps and cannot shape one. Measured, adding it there
        // moved the bird bath by 0.10 where the coefficients themselves moved it by 0.39.
        //
        // `sum(w.r)` is `M.sx - st`, so penalising its square is rank one - an outer
        // product on the normal matrix and a multiple of `sx` on the right-hand side. The
        // squared-residual term it joins is `sum(w.|r|^2)`, so dividing by the node's
        // weight puts the two in the same units: at `BIAS_LAMBDA` a residual pointing one
        // way everywhere costs `1 + lambda` times the same residual scattered.
        let bias = match seen[node] > 0.0 {
            true => BIAS_LAMBDA / seen[node],
            false => 0.0,
        };
        for i in 0..3 {
            for j in 0..3 {
                m[i][j] += bias * sx[node][i] * sx[node][j];
            }
        }
        // The ridge pulls toward the scalar rather than toward zero, so damping a node
        // means "behave like the rest of the frame", not "throw the colour away". The
        // scalar has no tint, so the two luma-to-chroma terms are damped toward 0.
        let target: [[f64; 3]; 2] = [[flat[0], flat[1], 0.0], [flat[2], flat[3], 0.0]];
        let mut solved = [0.0f64; 6];
        let mut ok = true;
        for row in 0..2 {
            let rhs: [f64; 3] = std::array::from_fn(|i| {
                atb[node][row][i] + ridge[i] * target[row][i] + bias * st[node][row] * sx[node][i]
            });
            match solve_row(&m, &rhs) {
                Some(x) => {
                    solved[row * 2] = x[0];
                    solved[row * 2 + 1] = x[1];
                    solved[4 + row] = x[2];
                }
                None => ok = false,
            }
        }
        if !ok {
            continue;
        }
        // Scaled so the chroma it produces is as strong as the camera's. `tr(M A M')` is
        // the mean square chroma this node would emit and `tr(B)` what it should be, both
        // already summed above, so this is the correction least squares could not make for
        // itself. Over all three inputs, since the tint contributes chroma too.
        let mut emitted = 0.0;
        for row in 0..2 {
            let x = [solved[row * 2], solved[row * 2 + 1], solved[4 + row]];
            for i in 0..3 {
                for j in 0..3 {
                    emitted += x[i] * a[i][j] * x[j];
                }
            }
        }
        if emitted > 0.0 && btb[node] > 0.0 {
            let gain = (btb[node] / emitted).sqrt().clamp(1.0 / MAP_MAX_GAIN, MAP_MAX_GAIN);
            for v in &mut solved {
                *v *= gain;
            }
        }

        let keep = seen[node] / (seen[node] + MAP_CONFIDENCE);
        for k in 0..6 {
            map.nodes[node][k] = flat[k] + (solved[k] - flat[k]) * keep;
        }
        fitted += 1;
    }

    if fitted == 0 {
        return None;
    }

    Some(map)
}

/// The same two planes before either was blurred, at the fit grid and at twice it.
struct Sharp {
    /// Twice the fit grid, unblurred, for objects the fit grid is too coarse to hold.
    /// The falloff is not in `wide`; whoever reads a pixel applies it.
    wide: Source,
    camera: Source,
    falloff: Option<(f64, f64)>,
}

/// Below this many samples a frame has no chroma distribution to take a percentile of.
const MIN_SPAN_SAMPLES: usize = 16;

async fn fit_colour(
    gpu: &'static crate::gpu::Gpu,
    planes: &Corresponded,
    sharp: &Sharp,
    wide: &Wide,
) -> Option<Fitted> {
    let (width, height) = (planes.width, planes.height);
    let mut lap = crate::clock::laps("  colour ");
    let selected =
        crate::fit_pairs::select(gpu, &planes.render, &planes.jpeg, width, height).await?;
    if selected.at.len() < MIN_PAIRS {
        return None;
    }
    let crate::fit_pairs::Selected {
        ceiling,
        hues,
        counted,
        total,
        words,
        at,
        target,
        greys,
        grey_target,
        frame_at,
        frame_target,
        ..
    } = selected;
    let census = HueCensus { of: hues, counted, total };
    let balance = hue_balance(&census, BALANCE_LIMIT);
    // A separate, looser weighting for the lattice alone. The cap exists because a global
    // fit driven by a frame's forty rarest pixels is noise - but a lattice node is not a
    // global fit. Each node is solved from its own pairs, so a rare hue counting heavily
    // moves only the node that hue lands in, and every other node is untouched. The blue
    // pot is 0.55% of the frame's pairs, so at the global cap of 4 it is still outvoted
    // several times over inside its own node and its correction averages to nothing.
    let map_balance = hue_balance(&census, MAP_BALANCE_LIMIT);

    let pairs = Pairs {
        balance: at.iter().map(|p| census.weigh(&balance, *p)).collect(),
        indices: indices_on(gpu, &at),
        grey_indices: indices_on(gpu, &greys),
        at,
        target,
        greys,
        grey_target,
        to_srgb: rec2020_to_srgb(),
        linear: std::cell::OnceCell::new(),
    };
    // Fitted on one half, judged on the other. `Pairs::split` has why every gate below now
    // reads `held` and every fit reads `train`.
    let (train, held) = pairs.split(gpu);
    // The picture every candidate is scored on beside the pairs. Hue-balanced like the pairs so a frame's rare colours
    // are not drowned by whatever it is mostly made of, and split on nothing: it judges rather
    // than teaches, so there is no overfitting to hold anything back from.
    let frame = Pairs {
        balance: frame_at
            .iter()
            .zip(&frame_target)
            .map(|(p, t)| {
                let weight = census.weigh(&balance, *p);
                // Negative marks a target the camera clipped, which `fit_score.slang` measures
                // for the gamut alone. Never a negative zero, which the shader reads as trusted.
                match t.iter().any(|c| *c >= CAMERA_CLIPPING) {
                    true => -weight.max(1e-9),
                    false => weight,
                }
            })
            .collect(),
        indices: indices_on(gpu, &frame_at),
        grey_indices: indices_on(gpu, &[]),
        at: frame_at,
        target: frame_target,
        greys: Vec::new(),
        grey_target: [0.0; 3],
        to_srgb: rec2020_to_srgb(),
        linear: std::cell::OnceCell::new(),
    };
    let source = Source { buffer: planes.render.clone(), width, height };
    let evidence = crate::fit_curve::Evidence {
        render: planes.render.clone(),
        jpeg: planes.jpeg.clone(),
        bits: words,
        pixels: source.pixels(),
    };
    lap("mask, census, pairs");
    let mut colour = fit_model(gpu, &source, &evidence, &balance, ceiling, &train, &frame).await?;
    lap("model");

    // One scalar on top, because a 3x3 cannot express a saturation that varies with
    // level and the camera's does. It stays one number for the reason on the field
    // itself.
    colour.saturation = fitted_saturation(gpu, &colour, &source, &train).await?;
    lap("saturation");

    // Then the hue-dependent part, kept only if it earns its place. Least squares on
    // chroma minimises chroma error, and this fit is judged on deltaE - the same gap
    // that made a mean chroma ratio the wrong way to pick the scalar. Per node it is far
    // better constrained than one number was, but "better constrained" is not "always an
    // improvement", so it is measured rather than assumed.
    //
    // Gated on pairs the map was not fitted from, which is what makes this a question about
    // the model rather than about how well it memorised its inputs. Scored on its own pairs
    // the map could not lose: it contains the scalar exactly, so more capacity always fitted
    // them better, and it took a render to look at to notice that the extra capacity was
    // going into a cast.
    //
    // What it measures with is not a bare mean: `folded` adds `BIAS_WEIGHT` times the
    // signed residual pooled inside each of `BIAS_BUCKETS`, so a correction that tints one
    // class of content costs more here than the same error scattered. So this asks two things
    // of the map - that it lowered the error on data it had not seen, and that it did not do
    // so by casting.
    //
    // What that does not reach is anything the fit *solves* rather than *chooses*. The tone
    // curves are a least squares, not a candidate, so no score gated them and three of them
    // free to diverge tinted every neutral at a level by up to 27 counts with this term
    // running the whole time. That one needed the model constrained (`fit_curves`), not
    // measured better.
    let axes = LatticeAxes::of(&colour, chroma_span(gpu, &colour, sharp).await?);
    lap("span");
    let surround = surround_plane(gpu, &source, width, height).await?;
    lap("surround");
    // Fitted on one half of the wide samples and judged on the other, exactly as the
    // pairs are split - and judged on *both* held populations together, with a voice
    // each rather than a vote per sample. The pairs alone cannot see the content the
    // wide pass exists for, so a gate reading only them structurally rejects any map
    // that corrects a lit transition at some cost to the flats, and accepts one that
    // wrecks the transitions for free.
    let wides = wide_samples(
        gpu,
        sharp,
        wide,
        (width, height),
        &map_balance,
        &census,
        &surround.of,
        colour.ceiling,
    )
    .await;
    let (mut wide_train, mut wide_held) = (Vec::new(), Vec::new());
    for (k, sample) in wides.into_iter().enumerate() {
        match k % HOLDOUT_EVERY == 0 {
            true => wide_held.push(sample),
            false => wide_train.push(sample),
        }
    }
    lap("wide samples");
    if crate::clock::watched() {
        eprintln!(
            "  colour grid {width}x{height}: {} pairs, {} wide samples",
            pairs.at.len(),
            wide_train.len() + wide_held.len(),
        );
    }
    let mut scored = measure(gpu, &colour, &source, &surround.buffer, &held).await?;
    let mut scored_wide = wide_score(gpu, &colour, &pairs.to_srgb, &wide_held).await?;
    lap("scored");
    // The flats' budget is set once, against the scalar, so two candidates cannot spend
    // it twice between them.
    let flat_budget = scored.1 + MAP_FLAT_SLACK;
    // And the picture's, which joins the sum a rung has to beat rather than bounding it: the
    // lattice is taught on the pairs, so a node they never reached extrapolates onto the pixels
    // they left out - on an orange-lit stairwell that doubled the blue on every dark wall, which
    // no held-out pair can object to because none of them is a dark wall.
    let mut scored_frame = measure(gpu, &colour, &source, &surround.buffer, &frame).await?.1;
    let mut chosen = 0.0;
    // A ladder of candidates rather than one, because the wide samples change what the
    // fit believes and the gate must be free to disagree by degree. A cell only they
    // reach is fully taught at any weight on the ladder - `MAP_CONFIDENCE` is 2 against
    // thousands of samples - so what the ladder actually offers is how far they may
    // outvote the pairs in the cells both populations reach. Judged on both held
    // populations: better in sum, and bounded on the flats, because the wide samples
    // score terribly under the scalar (saturated content is what a scalar cannot say)
    // and an unbounded sum would let a map buy a large wide win with the flats, which
    // are most of the picture.
    let taught =
        pair_moments(gpu, &colour, &source, &axes, &surround, &train, &map_balance, &census)
            .await?;
    lap("pair moments");
    let wide_landed = wide_landings(gpu, &colour, &axes, &wide_train).await?;
    lap("wide landings");
    for wide_weight in [0.0, 0.002, 0.01, 0.05, 0.25, 1.0, 4.0] {
        let mut rung = crate::clock::laps("  ladder ");
        let moments = match wide_weight > 0.0 {
            true => landed_on(&taught, &wide_landed, wide_weight * WIDE_STANDS_FOR),
            false => taught.clone(),
        };
        let Some(map) = fitted_chroma(&axes, &moments, colour.saturation) else {
            continue;
        };
        rung("fit");
        // Trended, then smoothed, before it is judged: the gate must score the surface
        // a render will actually read, not the fitted lattice it was built from.
        let trial =
            HdrColour { chroma: Some(map.level_trended().smoothed()), ..colour.clone() };
        rung("trend, smooth");
        let trialled = measure(gpu, &trial, &source, &surround.buffer, &held).await?;
        rung("measure");
        let trialled_wide = wide_score(gpu, &trial, &pairs.to_srgb, &wide_held).await?;
        rung("wide score");
        let keeps_the_flats = trialled.1 <= flat_budget;
        let trialled_frame = measure(gpu, &trial, &source, &surround.buffer, &frame).await?.1;
        rung("frame");
        if crate::clock::watched() {
            eprintln!(
                "  ladder rung {wide_weight}: pairs {:.3} wide {:.3} frame {trialled_frame:.3} \
                 against {:.3} {:.3} {scored_frame:.3}",
                trialled.1, trialled_wide, scored.1, scored_wide,
            );
        }
        if keeps_the_flats
            && trialled.1 + trialled_wide + trialled_frame + MAP_MARGIN
                < scored.1 + scored_wide + scored_frame
        {
            colour = trial;
            scored = trialled;
            scored_wide = trialled_wide;
            scored_frame = trialled_frame;
            chosen = wide_weight;
        }
    }
    lap("chroma ladder");
    if crate::clock::watched() {
        eprintln!(
            "  colour gate: pairs {:.5} balanced {:.5} flat, wide {:.5}, rung {chosen}",
            scored.0, scored.1, scored_wide
        );
    }
    // The map that won reads the surround at grade time, so its thumb travels with it.
    if colour.chroma.is_some() {
        let step = 16usize;
        let (tw, th) = ((width / step).max(1), (height / step).max(1));
        let mut data = Vec::with_capacity(tw * th);
        for y in 0..th {
            for x in 0..tw {
                // Cell centres, because the grade samples the thumb bilinearly at texel
                // centres; a corner sample would hand it every value half a cell early.
                let at = (y * step + step / 2).min(height - 1) * width
                    + (x * step + step / 2).min(width - 1);
                data.push(f64::from(half::f16::from_f64(surround.of[at])));
            }
        }
        colour.surround = SurroundThumb { width: tw, height: th, data };
    }

    colour.delta_e = scored.0;
    let baseline_delta_e = untransformed(gpu, &source, &held).await?.0;
    lap("thumb, baseline");
    Some(Fitted { colour, baseline_delta_e })
}

/// How much better the chroma map has to measure than the scalar it replaces.
///
/// Small, because the map is a strict generalisation - it contains the scalar exactly -
/// so it can only lose by overfitting, and the shrinkage already answers that. This is
/// here to catch the case where it has, not to set a bar it must clear.
///
/// A noise floor rather than a threshold anyone tuned: a map that earns its place clears this
/// by two orders, and firmer is the safe direction for a gate that admits capacity.
const MAP_MARGIN: f64 = 0.005;

/// How much held-out pair error a map may spend to win the wide samples.
const MAP_FLAT_SLACK: f64 = 0.15;

/// Below this our side is a warp-margin crumb for the pair and wide admission, where the
/// camera has content over it. Two orders below a real shadow, and one-sided: a Sony puts
/// true black at code 0-1, under this bar, over our signal - on a night frame that is half
/// the pairs, and refusing them left the fitted toe a pedestal at code 16.
pub(crate) const MARGIN_DARK: f64 = 0.004;

async fn fit_model(
    gpu: &'static crate::gpu::Gpu,
    source: &Source,
    evidence: &crate::fit_curve::Evidence,
    balance: &[f64],
    ceiling: f64,
    pairs: &Pairs,
    frame: &Pairs,
) -> Option<HdrColour> {
    let mut lap = crate::clock::laps("  model ");
    let (curves, anchor) = fit_curves(gpu, evidence, balance, ceiling, None).await?;
    let mut colour = HdrColour {
        curves,
        ceiling,
        anchor,
        matrix: IDENTITY,
        saturation: 1.0,
        chroma: None,
        surround: SurroundThumb::none(),
        delta_e: f64::INFINITY,
    };
    lap("curves");

    // The least squares below is weighted twice over, and neither is a detail. By
    // `hue_balance`, so what the frame is mostly made of does not decide what the camera
    // is taken to do; and by d(cbrt)/dv, so a sample counts for its perceptual size
    // rather than its photometric one - unweighted in linear light the brightest pixels
    // dominate, and the matrix that lands on oversaturates everything darker, measured
    // at 1.093x the camera's mean chroma.
    //
    // Curves and matrix in turn, because fitted once each in order they are not fitting
    // the same thing the other is. The curves go first against the camera's rendering
    // whole, so whatever of it is cross-channel - and on this camera a good deal is,
    // green scaled 0.884 on grass and 0.690 on a brown - is booked into a per-channel
    // curve that cannot express it and cannot be corrected by the matrix afterwards.
    // Undoing the matrix from the target and refitting the curves against what is left
    // gives each stage only the part it can represent. `fit.rs` alternates its falloff
    // against the colour for the same reason, and lands within 0.1 after three rounds.
    // Once, outside the alternation: neither set's pixels nor the plane under them move with the
    // rounds, and a gather is a dispatch and an allocation apiece.
    let samples = Gathered {
        pairs: gathered(gpu, source, &pairs.indices, pairs.at.len(), None),
        frame: gathered(gpu, source, &frame.indices, frame.at.len(), None),
    };
    for round in 0..FIT_ROUNDS {
        colour.matrix = fitted_matrix_for(gpu, &colour, pairs, frame, &samples).await?;
        lap("matrix");
        let Some(inverse) = invert3(&colour.matrix).filter(|_| round + 1 < FIT_ROUNDS) else {
            break;
        };
        (colour.curves, colour.anchor) =
            fit_curves(gpu, evidence, balance, ceiling, Some(&inverse)).await?;
        lap("curves");
        // Inside the alternation, not after it, and not conditional. A camera-neutral
        // rendering neutral is a property the transform should have rather than an
        // improvement it might make - it is the same kind of statement as the matrix's
        // rows summing to one - and the matrix refit at the top of the next round is
        // what lets the rest of the fit settle around it. Applied afterwards instead it
        // has no round left to settle in, and scores worse than not doing it at all.
        grey_balance(gpu, &mut colour, source, pairs).await?;
        lap("grey");
    }

    Some(colour)
}

// ------------------------------------------------------------------- the entry

/// Fits the camera's colour treatment in the HDR grade's own domain, through a lens the
/// geometry search already resolved.
///
/// `anchor` is diffuse white as a raw 16-bit level, which the grade measures the same
/// way (10.7.1); the fit is done in multiples of it so the curve means the same thing
/// whatever the exposure. None when there are too few usable pairs to fit from, in
/// which case the caller grades untransformed.
pub async fn fit(
    gpu: &'static crate::gpu::Gpu,
    plane: &Source,
    anchor: crate::light::Light<crate::light::Level>,
    preview: &crate::rgb::Rgb,
    lens: crate::fit::Lens,
) -> Option<HdrMatch> {
    let (wide_jpeg, _) = preview_planes(gpu, preview).await?;
    fit_linearised(gpu, plane, anchor, wide_jpeg, lens).await
}

/// The preview at the fit's size twice over: linearised into Rec.2020 for the colour fit, and
/// box-averaged in its own 8-bit domain for the geometry search, which compares
/// display-referred planes and wants both of its sides filtered alike.
///
/// Linearised before the resample: averaging gamma-encoded samples is not averaging light,
/// and at this scale factor that alone shifts the mid-tones.
///
/// Which is also why a preview larger than the fit wants is shrunk *here*, after the
/// transfer, rather than by its own decoder: the JPEG's scaled decode averages
/// display-encoded values, and over texture that average sits off the linear one by the
/// transfer's curvature - a skew that grows with texture contrast, follows the lighting, and
/// lands on a lit gradient as iso-level bands. The matrix waits until after the shrink: it is
/// linear, so the two orders agree, and it runs over a thousandth of the pixels this way.
pub async fn preview_planes(
    gpu: &'static crate::gpu::Gpu,
    preview: &crate::rgb::Rgb,
) -> Option<(Source, Source)> {
    let (w, h) = (preview.width, preview.height);
    let (tw, th) = fitted_preview_size(w, h);
    if w == 0 || h == 0 || tw == 0 || th == 0 {
        return None;
    }
    let eotf: [f32; 256] = std::array::from_fn(|level| srgb_eotf(level as u8) as f32);
    let identity: [f32; 256] = std::array::from_fn(|level| level as f32);
    let mut recording = gpu.record();
    let bytes = rgb_source(&mut recording, "fit preview bytes", &preview.data);
    let light_out = rgb_buffer(&mut recording, "fit preview light", tw, th);
    let codes_out = rgb_buffer(&mut recording, "fit preview codes", tw, th);
    let boxes = [
        Shaping::new(
            gpu,
            &mut recording,
            &bytes,
            (w, h),
            &light_out,
            (tw, th),
            // Into the primaries the fit works in, here rather than in a second pass over the
            // plane on the host. The matrix is linear, so it agrees either side of the box - and
            // this way it runs over a thousandth of the pixels the source has.
            Shape::PackedBox { levels: &eotf, finish: Finish::Matrix(srgb_to_rec2020()) },
        ),
        Shaping::new(
            gpu,
            &mut recording,
            &bytes,
            (w, h),
            &codes_out,
            (tw, th),
            Shape::PackedBox { levels: &identity, finish: Finish::Codes },
        ),
    ];
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        for shaping in &boxes {
            shaping.dispatch(&mut pass);
        }
    }
    recording.submit();
    // Both stay where they were written. The colour fit reads the linearised one and the geometry
    // search reads the coded one, and `FINISH_CODES` already put the second on the 255 steps a
    // JPEG's levels live on - so neither has to come back to be rounded and sent up again.
    Some((
        Source { buffer: light_out, width: tw, height: th },
        Source { buffer: codes_out, width: tw, height: th },
    ))
}

/// `fit`, for a caller that took the preview through `preview_planes` already.
pub async fn fit_linearised(
    gpu: &'static crate::gpu::Gpu,
    plane: &Source,
    anchor: crate::light::Light<crate::light::Level>,
    wide_jpeg: Source,
    lens: crate::fit::Lens,
) -> Option<HdrMatch> {
    if !(anchor > crate::light::Light::ZERO) {
        return None;
    }
    // The normalisation is the only per-fit thing about the plane, and it rides the warp that
    // reads it: a pass of its own would be the whole plane back to the host and up again, between
    // two passes that both already have it.
    let fitted = fit_model_planes(gpu, plane, 1.0 / anchor.raw(), wide_jpeg, &lens).await?;
    Some(HdrMatch { lens, colour: Some(fitted.colour) })
}

/// Everything `prepared_planes` built, in the place the stage after it reads it.
///
/// The fit-grid pair stays on the device because `registered` rewrites it there; the wide planes
/// are on both sides, the host's copies being what the wide pass and the chroma span still read.
struct FitPlanes {
    render: crate::fit::Sampled,
    jpeg: crate::fit::Sampled,
    sharp: Sharp,
    resident: Wide,
}

/// The fit's planes, once both sides are normalised into one domain.
///
/// `source` is the render at its own size, unwarped and unnormalised; `scale` is what puts it in
/// multiples of diffuse white and rides the warp. The lens is applied here because the pairs only
/// correspond through it. One submit builds every plane: the render warped through the lens, both
/// sides' luma for the search, and both sides box-averaged to the fit grid, prefiltered and with
/// the lens's falloff already in ours.
async fn prepared_planes(
    gpu: &'static crate::gpu::Gpu,
    source: &Source,
    scale: f64,
    wide_jpeg: Source,
    lens: &crate::fit::Lens,
) -> Option<FitPlanes> {
    let mut lap = crate::clock::laps("  planes ");
    let (wide, tall) = (source.width, source.height);
    // The fit itself runs at half this.
    let (fit_wide, fit_tall) = ((wide_jpeg.width / 2).max(1), (wide_jpeg.height / 2).max(1));
    let (camera_wide, camera_tall) = (wide_jpeg.width, wide_jpeg.height);

    let mut recording = gpu.record();
    recording.holding(&source.buffer);
    recording.holding(&wide_jpeg.buffer);
    let source = source.buffer.clone();
    let camera = wide_jpeg.buffer.clone();
    let warped = rgb_buffer(&mut recording, "fit render warped", wide, tall);
    let render_out = rgb_buffer(&mut recording, "fit render", fit_wide, fit_tall);
    let jpeg_out = rgb_buffer(&mut recording, "fit camera", fit_wide, fit_tall);
    // Through the geometry the search resolved, so a pair is two views of one point in
    // the scene. Warped at twice the fit grid rather than at full resolution: warping
    // 60MP with bilinear taps and resampling afterwards is both slower and worse - it
    // aliases going in and blurs the geometry going out - and measured, it took the fit
    // from under a second to 17.
    let shapings = [
        Shaping::new(
            gpu,
            &mut recording,
            &source,
            (wide, tall),
            &warped,
            (wide, tall),
            Shape::Warp { lens, luma: false, scale },
        ),
        Shaping::new(
            gpu,
            &mut recording,
            &warped,
            (wide, tall),
            &render_out,
            (fit_wide, fit_tall),
            // The falloff on the way out of the box, because the grade applies it before the
            // colour too: a curve fitted against corners the falloff has not yet lifted would be
            // asked at grade time for levels it never saw.
            Shape::Box {
                finish: lens.falloff.map_or(Finish::None, Finish::Falloff),
            },
        ),
        Shaping::new(
            gpu,
            &mut recording,
            &camera,
            (camera_wide, camera_tall),
            &jpeg_out,
            (fit_wide, fit_tall),
            Shape::Box { finish: Finish::None },
        ),
    ];
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        for shaping in &shapings {
            shaping.dispatch(&mut pass);
        }
    }
    let prefiltered = |recording: &mut crate::gpu::Recording<'_>, plane: &crate::gpu::Buffer| {
        let held = crate::fit::Sampled {
            buffer: plane.clone(),
            width: fit_wide,
            height: fit_tall,
            packed: false,
        };
        crate::fit::box_blurred(gpu, recording, &held, FIT_BLUR_RADIUS)
    };
    let render_blurred = prefiltered(&mut recording, &render_out);
    let jpeg_blurred = prefiltered(&mut recording, &jpeg_out);
    let ours = DevicePlane::luma_of(gpu, &mut recording, &warped, wide, tall);
    let mut theirs = DevicePlane::luma_of(gpu, &mut recording, &camera, camera_wide, camera_tall);
    theirs.tabulate(gpu, recording.encoder(), Reach::NARROW);
    recording.submit();
    lap("device planes");

    // The same render at twice the grid, which is where it was warped anyway - only the
    // resample down to the fit grid is skipped. Its falloff is carried rather than
    // applied: a hundredth of these pixels reach the point of needing it, and multiplying
    // the other 99% through a square root each cost more than the whole pass it feeds.
    //
    // The lens travels with the colour, never beside it: these pairs only correspond
    // through that warp and carry that falloff, so the three are one transform.
    Some(FitPlanes {
        render: render_blurred,
        jpeg: jpeg_blurred,
        sharp: Sharp {
            wide: Source { buffer: warped, width: wide, height: tall },
            camera: Source { buffer: camera, width: camera_wide, height: camera_tall },
            falloff: lens.falloff,
        },
        resident: Wide { ours, theirs },
    })
}

async fn fit_model_planes(
    gpu: &'static crate::gpu::Gpu,
    source: &Source,
    scale: f64,
    wide_jpeg: Source,
    lens: &crate::fit::Lens,
) -> Option<Fitted> {
    let mut lap = crate::clock::laps("  colour ");
    let planes = prepared_planes(gpu, source, scale, wide_jpeg, lens).await?;
    lap("prepared planes");
    let corresponded = registered(gpu, &planes).await?;
    lap("registered");
    fit_colour(gpu, &corresponded, &planes.sharp, &planes.resident).await
}

/// What a point the search could not match is charged, as a squared displacement in
/// wide-plane pixels. Without it a geometry wrong enough to push features out of range
/// scores on the few that stayed in it, so being wrong looks like being right about less.
const UNMATCHED: f64 = (2 * SEARCH * SEARCH) as f64;

/// Below this many matches a bin does not get to answer for its own radius. Per bin because
/// that is what the mean is taken over; a frame-wide floor set anywhere near a real count is
/// a coin toss on a sparse frame.
const MIN_BIN_MATCHED: f64 = 24.0;

/// How far a geometry still leaves the render from the camera's own picture.
pub struct Registration {
    /// Mean radial displacement per radius bin, as a fraction of the half-diagonal.
    /// Positive means the camera put a feature further out than this geometry does. None
    /// where the bin had too little to match on.
    pub radial: Vec<Option<f64>>,
    /// How many matches each bin's mean is over, and their mean radius as a fraction of the
    /// half-diagonal.
    pub counts: Vec<f64>,
    pub radii: Vec<f64>,
    /// Mean squared displacement in wide-plane pixels.
    pub misfit: f64,
    pub matched: usize,
}

/// An 8-bit plane on the device as the 0..1 f32 RGB `fit_warp.slang` reads, held for as long as
/// the search asks about it.
pub fn levelled_source(
    gpu: &'static crate::gpu::Gpu,
    plane: crate::rgb::RgbRef<'_>,
) -> crate::gpu::Buffer {
    gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit warp source"),
        contents: &rgb_words(plane.data, |v| f32::from(v) / 255.0),
        usage: wgpu::BufferUsages::STORAGE,
    })
}

/// `source` through each of `lenses` onto a `width` by `height` grid, one plane per lens, left
/// where they were written. One submit for all of them: the geometry search scores every candidate
/// of a scan at once, and a round trip per candidate was most of what it cost.
///
/// The planes stay on the device because the objective that reads them is
/// `slang/fit_objective.slang`. They came back as 8-bit levels when it was `fit::pairs`, which
/// walked both grids on the host for each candidate in turn.
pub(crate) fn warped_planes(
    gpu: &'static crate::gpu::Gpu,
    source: &crate::gpu::Buffer,
    (sw, sh): (usize, usize),
    lenses: &[crate::fit::Lens],
    (width, height): (usize, usize),
) -> Vec<crate::gpu::Buffer> {
    if lenses.is_empty() {
        return Vec::new();
    }
    let mut recording = gpu.record();
    recording.holding(source);
    let planes: Vec<crate::gpu::Buffer> = lenses
        .iter()
        .map(|_| rgb_buffer(&mut recording, "fit candidate", width, height))
        .collect();
    let shapings: Vec<Shaping> = lenses
        .iter()
        .zip(&planes)
        .map(|(lens, plane)| {
            Shaping::new(
                gpu,
                &mut recording,
                source,
                (sw, sh),
                plane,
                (width, height),
                Shape::Warp { lens, luma: false, scale: 1.0 },
            )
        })
        .collect();
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        for shaping in &shapings {
            shaping.dispatch(&mut pass);
        }
    }
    recording.submit();
    planes
}

/// [`warped_planes`], back on the host as 8-bit levels.
///
/// Only the tests that look at a warped plane want this - the search reads the buffers where they
/// are, and a candidate's plane is 820KB.
#[cfg(test)]
pub(crate) async fn warped_levels(
    gpu: &'static crate::gpu::Gpu,
    source: &crate::gpu::Buffer,
    source_size: (usize, usize),
    lenses: &[crate::fit::Lens],
    (width, height): (usize, usize),
) -> Option<Vec<Vec<u8>>> {
    let planes = warped_planes(gpu, source, source_size, lenses, (width, height));
    let mut recording = gpu.record();
    let mut out = Vec::with_capacity(planes.len());
    for plane in &planes {
        out.push(staged(&mut recording, plane, width * height * 3));
    }
    recording.submit();
    let mut levels = Vec::with_capacity(out.len());
    for staging in &out {
        levels.push(
            crate::gpu::read_back(gpu, staging, |mapped| {
                mapped
                    .par_chunks_exact(4)
                    .map(|word| {
                        (f32::from_ne_bytes([word[0], word[1], word[2], word[3]]) * 255.0).round()
                            as u8
                    })
                    .collect::<Vec<u8>>()
            })
            .await?,
        );
    }
    Some(levels)
}

/// Everything a settle's rounds share, so that a round pays only for what its lens changed: a
/// ratio table and a dispatch. Nothing per-pixel is on the host, and nothing but the answer
/// crosses back.
pub struct Settling {
    /// The render, levelled, on the device. Not warped: the warp is the only thing a round changes.
    source: crate::gpu::Buffer,
    /// Where the warp writes and the search reads, reused by every round.
    ours: DevicePlane,
    width: usize,
    height: usize,
    theirs: DevicePlane,
    /// The strided grid the search asks about, which is the same grid every round.
    asked: Vec<[i32; 2]>,
    points: crate::gpu::Buffer,
    preview_width: usize,
    preview_height: usize,
}

impl Settling {
    pub fn new(
        gpu: &'static crate::gpu::Gpu,
        render: &Source,
        preview: &Source,
        stride: usize,
    ) -> Settling {
        let source = render.buffer.clone();
        let ours = DevicePlane::empty(gpu, render.width, render.height);
        let edge = PATCH + SEARCH;
        let across = render.width.div_ceil(stride.max(1));
        let down = render.height.div_ceil(stride.max(1));
        let inside = |x: isize, y: isize, width: usize, height: usize| {
            x >= edge && y >= edge && x < width as isize - edge && y < height as isize - edge
        };
        let asked: Vec<[i32; 2]> = (0..across * down)
            .filter_map(|p| {
                let (x, y) = (((p % across) * stride) as isize, ((p / across) * stride) as isize);
                let held = inside(x, y, render.width, render.height)
                    && inside(x, y, preview.width, preview.height);
                held.then_some([x as i32, y as i32])
            })
            .collect();
        let coordinates: Vec<u8> = asked
            .iter()
            .flat_map(|p| [p[0].to_ne_bytes(), p[1].to_ne_bytes()].concat())
            .collect();
        let points = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("fit warp points"),
            contents: &coordinates,
            usage: wgpu::BufferUsages::STORAGE,
        });
        // **Tabulated even though the search is sparse**, which the settle is the one caller that
        // can say yes to: 6000 points on a stride of 13 do not share a window, but the six rounds
        // ask about the same 6000 against the same camera plane, so one pass over 1.1M pixels
        // stands in for six rounds of 81 windows each.
        let mut recording = gpu.record();
        recording.holding(&preview.buffer);
        let mut theirs = DevicePlane::luma_of(
            gpu,
            &mut recording,
            &preview.buffer,
            preview.width,
            preview.height,
        );
        theirs.tabulate(gpu, recording.encoder(), Reach::NARROW);
        recording.submit();
        Settling {
            source,
            ours,
            width: render.width,
            height: render.height,
            theirs,
            asked,
            points,
            preview_width: preview.width,
            preview_height: preview.height,
        }
    }
}

/// Where the camera actually put each feature, against where this geometry puts it.
///
/// The lens is applied here, since the two pictures only correspond through it. None where no bin
/// had enough to match on.
///
/// **One submit, and nothing per-pixel on the host.** The warp writes the plane the search reads, so
/// the two go into one encoder and the round trip is paid once: what crosses back is six thousand
/// answers, not the plane they were found in.
pub async fn registration(
    gpu: &'static crate::gpu::Gpu,
    settling: &Settling,
    lens: &crate::fit::Lens,
    bins: usize,
) -> Option<Registration> {
    if settling.width != settling.preview_width
        || settling.height != settling.preview_height
        || bins == 0
        || settling.asked.is_empty()
    {
        return None;
    }
    let (width, height) = (settling.width, settling.height);
    let (cx, cy) = (width as f64 / 2.0, height as f64 / 2.0);
    let half = (cx * cx + cy * cy).sqrt().max(1.0);

    let mut recording = gpu.record();
    let warping = Shaping::new(
        gpu,
        &mut recording,
        &settling.source,
        (width, height),
        &settling.ours.buffer,
        (width, height),
        Shape::Warp { lens, luma: true, scale: 1.0 },
    );
    let asking = Asking::new(
        gpu,
        &mut recording,
        &settling.ours,
        &settling.theirs,
        &settling.points,
        settling.asked.len(),
        None,
        -1,
        Reach::NARROW,
    );
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        warping.dispatch(&mut pass);
        asking.dispatch(gpu, &mut pass);
    }
    asking.copy(recording.encoder());
    recording.submit();
    let searched = asking.read(gpu).await?;

    let measured: Vec<(usize, Option<(f64, f64)>, f64)> = settling
        .asked
        .par_iter()
        .zip(searched.par_iter())
        .map(|(point, found)| {
            let (x, y) = (f64::from(point[0]), f64::from(point[1]));
            let (dx, dy) = (x - cx, y - cy);
            let radius = (dx * dx + dy * dy).sqrt();
            let bin = ((radius / half * bins as f64) as usize).min(bins - 1);
            let Some(found) = found else {
                return (bin, None, UNMATCHED);
            };
            // A featureless patch reports a zero shift it never measured, so it says
            // nothing about where the camera put anything - but it is also not a point
            // this geometry failed, so it carries its zero into the misfit and no radial.
            let squared = found.dx * found.dx + found.dy * found.dy;
            let shift = (!found.featureless && radius >= 1.0)
                .then(|| ((found.dx * dx + found.dy * dy) / radius / half, radius / half));
            (bin, shift, squared)
        })
        .collect();

    let mut sum = vec![0.0; bins];
    let mut at = vec![0.0; bins];
    let mut count = vec![0.0; bins];
    let mut misfit = 0.0;
    for (bin, shift, squared) in &measured {
        misfit += squared;
        if let Some((shift, radius)) = shift {
            sum[*bin] += shift;
            at[*bin] += radius;
            count[*bin] += 1.0;
        }
    }
    let radial: Vec<Option<f64>> = (0..bins)
        .map(|bin| (count[bin] >= MIN_BIN_MATCHED).then(|| sum[bin] / count[bin]))
        .collect();
    if radial.iter().all(Option::is_none) {
        return None;
    }
    let radii = (0..bins).map(|bin| at[bin] / count[bin].max(1.0)).collect();
    Some(Registration {
        radial,
        matched: count.iter().sum::<f64>() as usize,
        counts: count,
        radii,
        misfit: misfit / measured.len() as f64,
    })
}

/// The two wide planes the search runs in, and what it found at each of `points`.
///
/// For looking at the correspondence rather than trusting its score: a match that is
/// confidently wrong scores just as well as one that is right, and only the two patches
/// side by side say which it was. `points` are in wide-plane coordinates, which is twice
/// the fit grid.
pub async fn correspondence_at(
    gpu: &'static crate::gpu::Gpu,
    render: &crate::rgb::Rgb,
    preview: &Source,
    lens: &crate::fit::Lens,
    points: &[(usize, usize)],
) -> Option<(Plane, Plane, Vec<Option<Found>>)> {
    let ours = Source {
        buffer: levelled_source(gpu, render.as_ref()),
        width: render.width,
        height: render.height,
    };
    let theirs =
        Source { buffer: preview.buffer.clone(), width: preview.width, height: preview.height };
    let FitPlanes { sharp, resident, .. } =
        prepared_planes(gpu, &ours, 1.0, theirs, lens).await?;
    let edge = PATCH + SEARCH;
    // The margins are the tighter of the two planes', which is what a window inside both means.
    let (wide, tall) = (
        sharp.wide.width.min(sharp.camera.width) as isize,
        sharp.wide.height.min(sharp.camera.height) as isize,
    );
    let holds = |x: isize, y: isize| x >= edge && y >= edge && x < wide - edge && y < tall - edge;
    let inside: Vec<[i32; 2]> = points
        .iter()
        .filter(|(x, y)| holds(*x as isize, *y as isize))
        .map(|(x, y)| [*x as i32, *y as i32])
        .collect();
    let searched =
        corresponded(gpu, &resident.ours, &resident.theirs, &inside).await.unwrap_or_default();
    let mut taken = searched.into_iter();
    let found = points
        .iter()
        .map(|(x, y)| match holds(*x as isize, *y as isize) {
            true => taken.next().flatten(),
            false => None,
        })
        .collect();
    // Read back for looking at, which is the whole point of this one: the fit itself never brings
    // either plane down.
    Some((read_plane(gpu, &sharp.wide).await?, read_plane(gpu, &sharp.camera).await?, found))
}

/// The long edge a caller should decode the preview to.
///
/// Twice the fit grid, and the extra is not for the fit - that still runs at
/// `FIT_LONG_EDGE`, where the cost of a geometry search lives. It is for the chroma map,
/// which has to see small saturated objects that the fit grid loses: at 640 a blue pot
/// 20 pixels across has no interior the blur has not reached, and nine pairs in the whole
/// frame look like it. The render side is already built at this size on its way down.
pub fn sample_long_edge() -> usize {
    FIT_LONG_EDGE * 2
}

/// The size a preview settles to for the fit: `sample_long_edge` on its long side, or
/// its own where it is already no larger.
pub fn fitted_preview_size(width: usize, height: usize) -> (usize, usize) {
    let long = width.max(height);
    if long <= sample_long_edge() {
        return (width, height);
    }
    let s = sample_long_edge() as f64 / long as f64;
    (
        ((width as f64 * s).round() as usize).max(1),
        ((height as f64 * s).round() as usize).max(1),
    )
}

/// A plane as an 8-bit sRGB render, to build a fixture with.
///
/// **Not the render the fit runs on** - that is `fit_source.slang`'s `fit_render`, written on the
/// device beside the plane it comes from. This is here so a test can state a camera's rendering as
/// a plane and get the bytes a camera would have written, which is a chart rather than a stage.
///
/// The normalisation the real one does, and why, is on `fit_render`: diffuse white rather than the
/// frame's peak, because the peak is the maximum of a strided subsample and one specular sample
/// drags the whole render toward black by the peak/white ratio.
#[cfg(test)]
pub fn render_srgb8(
    plane: &Plane,
    white: crate::light::Light<crate::light::Level>,
) -> crate::rgb::Rgb {
    let white = white.raw();
    let mut data = vec![0u8; plane.width * plane.height * 3];
    let to_srgb = rec2020_to_srgb();
    data.par_chunks_mut(3).zip(plane.data.par_chunks(3)).for_each(|(out, px)| {
        // sRGB primaries first, which is where the camera's JPEG lives; the fit works in
        // Rec.2020.
        let v = apply3(&to_srgb, px[0] / white, px[1] / white, px[2] / white);
        for c in 0..3 {
            out[c] = (255.0 * srgb_oetf(v[c])).round() as u8;
        }
    });
    crate::rgb::Rgb { width: plane.width, height: plane.height, data }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The selection over two planes flat enough that its own ceiling lands on `TRUST_CEILING`,
    /// so the only thing varying is the pair.
    fn selection(ours: [f64; 3], theirs: [f64; 3]) -> crate::fit_pairs::Selected {
        selection_across(5, ours, theirs)
    }

    /// The same over a square of `side`, for the tests that need a pixel the border does not eat.
    fn selection_across(
        side: usize,
        ours: [f64; 3],
        theirs: [f64; 3],
    ) -> crate::fit_pairs::Selected {
        let gpu = searching();
        let flat = |level: [f64; 3]| {
            let data: Vec<f64> = (0..side * side).flat_map(|_| level).collect();
            gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("selection test plane"),
                contents: &rgb_words(&data, |v| v as f32),
                usage: wgpu::BufferUsages::STORAGE,
            })
        };
        pollster::block_on(crate::fit_pairs::select(gpu, &flat(ours), &flat(theirs), side, side))
            .expect("the device selected")
    }

    /// The centre of a 5x5, which is the only pixel a border-skipping mask and a gradient three
    /// wide can both reach.
    const CENTRE: usize = 12;

    fn masked(ours: [f64; 3], theirs: [f64; 3]) -> u8 {
        selection(ours, theirs).bits[CENTRE]
    }

    /// The camera crushes true black to code 0-1, under `MARGIN_DARK`, while our side keeps the
    /// signal: that pair is what teaches the toe. Our side dark under camera content is the warp
    /// margin's taper, and measures nothing.
    #[test]
    fn a_camera_black_over_our_signal_teaches_the_toe() {
        assert!(masked([0.05; 3], [0.0003; 3]) != 0, "camera black over our signal");
        assert!(masked([0.001; 3], [0.0003; 3]) != 0, "dark on both sides");
        assert!(masked([0.001; 3], [0.2; 3]) == 0, "our taper under camera content");
        assert!(masked([0.0; 3], [0.0003; 3]) == 0, "an exact-zero margin");
    }

    /// The toe wants a crushed channel and the chroma stages cannot use one, so the two bits
    /// part company: a night frame's blue is against the bottom over most of the picture, and
    /// a matrix fitted from it puts blue on luma.
    #[test]
    fn a_crushed_camera_channel_teaches_the_toe_and_not_the_colour() {
        let crushed = selection([0.4, 0.2, 0.05], [0.3, 0.1, 0.0004]);
        assert_eq!(
            crushed.bits[CENTRE] & 0b111,
            0b111,
            "every channel is inside the curves' domain"
        );
        assert!(!crushed.at.contains(&CENTRE), "blue measured nothing, so it is not a pair");
        let lit = selection([0.4, 0.2, 0.05], [0.3, 0.1, 0.06]);
        assert!(lit.at.contains(&CENTRE), "a blue with signal is");
    }

    /// The set every candidate is scored on beside the pairs keeps what the pairs throw away,
    /// and refuses only the warp's own margin.
    ///
    /// A 9x9 because the stride grid's first interior pixel is (4, 4): on a 5x5 every one of them
    /// is border, which the mask drops before any of this.
    #[test]
    fn the_frame_set_keeps_the_pixels_the_pairs_reject() {
        const INSIDE: usize = 4 * 9 + 4;
        // Blue crushed in the camera: no pair, since the chroma stages need a target that says
        // what colour was there - but the matrix is about to be applied to it all the same.
        let crushed = selection_across(9, [0.4, 0.2, 0.05], [0.3, 0.1, 0.0004]);
        assert!(!crushed.at.contains(&INSIDE), "a crushed blue is not a pair");
        assert!(crushed.frame_at.contains(&INSIDE), "and is still part of the picture");

        // The camera's own clipping is no level to be measured against, and it is still the
        // picture: `hdr_fit` marks its balance negative and the objective reads it for the gamut
        // alone.
        let clipped = selection_across(9, [0.4, 0.2, 0.05], [0.99, 0.99, 0.99]);
        assert!(clipped.frame_at.contains(&INSIDE), "a clipped camera pixel is still the picture");

        // Nor is the warp's black margin scene content.
        let margin = selection_across(9, [0.0; 3], [0.3, 0.1, 0.05]);
        assert!(!margin.frame_at.contains(&INSIDE), "an exact-zero margin is not the picture");

        // One in sixteen of the interior, and the camera's colour carried with each.
        assert_eq!(crushed.frame_at.len(), crushed.frame_target.len());
        assert_eq!(crushed.frame_at, vec![INSIDE], "the stride grid's interior of a 9x9");
        for c in 0..3 {
            assert!(
                (crushed.frame_target[0][c] - [0.3, 0.1, 0.0004][c]).abs() < 1e-6,
                "the camera's colour travels with the pixel: {:?}",
                crushed.frame_target[0],
            );
        }
    }

    /// A candidate is chosen on the pairs and the picture together, so serving the pairs at the
    /// picture's expense wins or loses by how much - and never falls off a cliff to the identity.
    #[test]
    fn a_matrix_is_chosen_on_the_pairs_and_the_picture_together() {
        let wild = [[1.0, 0.0, 0.0], [-0.5, 1.8, -0.3], [0.2, -0.2, 1.0]];
        let tame = [[0.95, 0.03, 0.02], [0.02, 0.96, 0.02], [0.01, 0.03, 0.96]];
        let candidates = [wild, tame, IDENTITY];
        // The wild one wins the pairs outright, on both of their scores.
        let pairs = [(1.0, 1.0), (1.5, 1.5), (2.0, 2.0)];

        let agreeing = [(0.0, 1.0), (0.0, 1.0), (0.0, 1.0)];
        assert_eq!(fitted_matrix(&candidates, &pairs, &agreeing), wild);
        // On the picture it loses more than it won on the pairs.
        let disagreeing = [(0.0, 4.0), (0.0, 1.5), (0.0, 1.49)];
        assert_eq!(fitted_matrix(&candidates, &pairs, &disagreeing), tame);
        // Worse on the picture by less than it is better on the pairs, it keeps its place - which
        // a margin on the picture alone would have refused it for.
        let costly = [(0.0, 1.4), (0.0, 1.0), (0.0, 1.0)];
        assert_eq!(fitted_matrix(&candidates, &pairs, &costly), wild);
        // And the identity is a candidate like any other: it wins when its sum is the least.
        let hopeless = [(0.0, 5.0), (0.0, 4.0), (0.0, 1.0)];
        assert_eq!(fitted_matrix(&candidates, &pairs, &hopeless), IDENTITY);
    }

    /// The floor is stated twice, and a host copy that drifted would have two tests holding two
    /// passes to two different knees.
    #[test]
    fn the_gamut_floor_is_the_one_the_shader_declares() {
        const SOURCE: &str = include_str!("../../../slang/prelude.slang");
        let line = format!("public static const float GAMUT_FLOOR = {GAMUT_FLOOR};");
        assert!(SOURCE.contains(&line), "prelude.slang does not say `{line}`");
    }

    /// The knee is the identity inside it, continuous and C1 at it, and holds the floor past it.
    ///
    /// **The luma it keeps is the positive part's**, which is the whole of what a negative channel
    /// changes here. Held against the triple's own, a colour far outside the gamut is pulled towards
    /// a grey its out-of-gamut channel darkened - green's weight being the largest of the three -
    /// and the further out it is the darker that grey. The pane in `prelude.slang`'s measurement
    /// lost five and a half times its brightness that way, and the ratio the correction's strength
    /// divides by carried the photosites' noise with it.
    #[test]
    fn the_knee_holds_the_floor_without_a_step() {
        let luma = |v: [f64; 3]| -> f64 { (0..3).map(|c| LUMA[c] * v[c].max(0.0)).sum() };
        let inside = [0.5, 0.1, 0.05];
        assert_eq!(in_gamut(inside), inside, "a colour inside the knee is untouched");
        let mut last = in_gamut([0.5, 0.1, 0.06])[2];
        for step in 1..=200 {
            let v = [0.5, 0.1, 0.06 - 0.001 * f64::from(step)];
            let held = in_gamut(v);
            assert!((luma(held) - luma(v)).abs() < 1e-9, "the luma moved at {v:?}");
            let lowest = held.iter().copied().fold(f64::INFINITY, f64::min);
            assert!(lowest >= GAMUT_FLOOR * luma(v) - 1e-9, "under the floor at {v:?}: {held:?}");
            // Falls to the floor and then sits on it, rather than falling forever. The floor is a
            // fraction of the colour's own luma and that luma is now held, so a colour pushed
            // further out keeps the channel where it is instead of carrying it down - which is the
            // whole of what was wrong. What must not happen is a *step*, in either direction.
            //
            // It does creep up on the way, by 8.4e-7 over the whole sweep, because the rescale that
            // restores the luma grows as the colour goes further out while the floor it multiplies
            // is already flat. Measured rather than allowed for: the bound is ten times it.
            assert!(held[2] - last < 1e-5 && last - held[2] < 0.002, "a step at {v:?}");
            last = held[2];
        }
    }

    /// What the positive part buys, stated as the property the picture actually needed.
    ///
    /// **A colour's brightness must not fall as it is pushed further outside the gamut.** The rule
    /// gives up saturation, which is its whole purpose; giving up brightness as well is what put a
    /// stained glass pane at a twentieth of diffuse white where the body that shot it rendered it
    /// near white. Swept over a blue leaving the hull, the held colour's own positive luma is flat
    /// where the triple's falls away.
    #[test]
    fn a_colour_further_outside_the_gamut_does_not_come_back_darker() {
        let bright = |v: [f64; 3]| -> f64 { (0..3).map(|c| LUMA[c] * v[c].max(0.0)).sum() };
        let mut least = f64::INFINITY;
        let mut most: f64 = 0.0;
        for step in 0..=200 {
            // Green driven further negative, which is what a camera matrix does to a narrow blue.
            let v = [0.02, -0.002 * f64::from(step), 0.9];
            let held = bright(in_gamut(v));
            least = least.min(held);
            most = most.max(held);
        }
        assert!(
            most / least < 1.02,
            "the held brightness ran from {least} to {most} as the colour left the gamut",
        );
    }

    /// The prefilter on the device against the same window summed outright, at every edge a
    /// radius can meet.
    ///
    /// The truncation is the part worth holding: a window that ran off the frame and was divided
    /// by its full width instead of by what survived darkens every border pixel, which reads as a
    /// vignette the falloff fit would then try to answer.
    #[test]
    fn the_prefilter_is_the_box_it_slides_over() {
        let Some(gpu) = crate::gpu::device() else {
            eprintln!("SKIPPED: no adapter answered, so the prefilter never ran.");
            return;
        };
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut noise = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f64 / (1u64 << 53) as f64
        };
        for (w, h, radius) in [(1, 1, 3), (7, 5, 1), (40, 9, 4), (13, 41, 20), (64, 48, 6)] {
            let source: Vec<f64> = (0..w * h * 3).map(|_| noise()).collect();
            let mut recording = gpu.record();
            let held = crate::fit::Sampled {
                buffer: rgb_source(
                    &mut recording,
                    "prefilter source",
                    &rgb_words(&source, |v| v as f32),
                ),
                width: w,
                height: h,
                packed: false,
            };
            let blurred = crate::fit::box_blurred(gpu, &mut recording, &held, radius);
            let out = staged(&mut recording, &blurred.buffer, w * h * 3);
            recording.submit();
            let got =
                pollster::block_on(plane_read(gpu, &out, w, h)).expect("the device prefiltered");

            let mut slow = source;
            let mut tmp = vec![0.0; slow.len()];
            for _ in 0..3 {
                for y in 0..h {
                    for x in 0..w {
                        let (lo, hi) = (x.saturating_sub(radius), (x + radius).min(w - 1));
                        for c in 0..3 {
                            let sum: f64 = (lo..=hi).map(|k| slow[(y * w + k) * 3 + c]).sum();
                            tmp[(y * w + x) * 3 + c] = sum / (hi - lo + 1) as f64;
                        }
                    }
                }
                for y in 0..h {
                    let (lo, hi) = (y.saturating_sub(radius), (y + radius).min(h - 1));
                    for x in 0..w * 3 {
                        let sum: f64 = (lo..=hi).map(|k| tmp[k * w * 3 + x]).sum();
                        slow[y * w * 3 + x] = sum / (hi - lo + 1) as f64;
                    }
                }
            }
            for (a, b) in got.data.iter().zip(&slow) {
                assert!((a - b).abs() < 1e-5, "{w}x{h} r{radius}: {a} against {b}");
            }
        }
    }

    /// The device the correspondence search runs on. A test with no adapter has nothing to measure,
    /// and saying so beats a `None` that reads as a fit declining.
    fn searching() -> &'static crate::gpu::Gpu {
        crate::gpu::device().expect("an adapter for the fit's search")
    }

    /// A band-limited scene, sampled wherever a shifted copy is asked for.
    ///
    /// Sines rather than noise: the search reads a peak between whole offsets by fitting a
    /// parabola to it, and only a plane that is actually smooth between samples has a sub-pixel
    /// answer to find. Three of them at different frequencies so no patch is a repeat of its
    /// neighbour.
    fn banded(x: f64, y: f64) -> f32 {
        (0.5 + 0.2 * (x * 0.31).sin() * (y * 0.23).cos() + 0.15 * ((x + y) * 0.17).sin()) as f32
    }

    fn shifted_plane(width: usize, height: usize, dx: f64, dy: f64) -> Vec<f32> {
        (0..width * height)
            .map(|p| banded((p % width) as f64 - dx, (p / width) as f64 - dy))
            .collect()
    }

    /// The offsets are read between whole pixels, which is what a panorama's rotations are solved
    /// from: rounded to the nearest pixel at a 1616px preview, the residual is most of a pixel at
    /// 61MP and the seam it leaves is visible.
    #[test]
    fn the_search_lands_between_pixels() {
        let gpu = searching();
        let (w, h) = (96usize, 96usize);
        let (shift_x, shift_y) = (1.3, -0.6);
        let ours = DevicePlane::from_luma(gpu, &shifted_plane(w, h, 0.0, 0.0), w, h);
        let theirs = DevicePlane::from_luma(gpu, &shifted_plane(w, h, shift_x, shift_y), w, h);
        let points: Vec<[i32; 2]> =
            (0..5).flat_map(|i| (0..5).map(move |j| [16 + i * 14, 16 + j * 14])).collect();

        let found = pollster::block_on(corresponded(gpu, &ours, &theirs, &points))
            .expect("the device searches");

        let hits: Vec<&Found> = found.iter().flatten().filter(|f| !f.featureless).collect();
        assert!(hits.len() >= 20, "{} of 25 points matched", hits.len());
        let mean = |of: fn(&Found) -> f64| hits.iter().map(|f| of(f)).sum::<f64>() / hits.len() as f64;
        let (dx, dy) = (mean(|f| f.dx), mean(|f| f.dy));
        assert!((dx - shift_x).abs() < 0.15 && (dy - shift_y).abs() < 0.15, "found ({dx}, {dy})");
    }

    /// A belief the caller hands in is where the search looks, however far away it is.
    ///
    /// The window is nine pixels wide, and a panorama's frames overlap by a third of a frame, so
    /// a `given` clamped into the window would search around the point - which is not where the
    /// content is, and reads out as a frame that does not match its neighbour at all.
    #[test]
    fn the_search_is_centred_where_it_is_told() {
        let gpu = searching();
        let (w, h) = (96usize, 96usize);
        let (shift_x, shift_y) = (23, -9);
        let ours = DevicePlane::from_luma(gpu, &shifted_plane(w, h, 0.0, 0.0), w, h);
        let theirs =
            DevicePlane::from_luma(gpu, &shifted_plane(w, h, f64::from(shift_x), f64::from(shift_y)), w, h);
        // Inside the plane both before and after the shift, so every point is one the search may
        // read rather than one it declines at the edge.
        let points: Vec<[i32; 2]> =
            (0..5).flat_map(|i| (0..5).map(move |j| [16 + i * 8, 24 + j * 8])).collect();
        let given = vec![[shift_x, shift_y]; points.len()];

        let found = pollster::block_on(corresponded_about(
            gpu,
            &ours,
            &theirs,
            &points,
            Some(&given),
            -1,
            Reach::NARROW,
        ))
        .expect("the device searches");

        let hits: Vec<&Found> = found.iter().flatten().filter(|f| !f.featureless).collect();
        assert!(hits.len() >= 20, "{} of 25 points matched", hits.len());
        let mean = |of: fn(&Found) -> f64| hits.iter().map(|f| of(f)).sum::<f64>() / hits.len() as f64;
        let (dx, dy) = (mean(|f| f.dx), mean(|f| f.dy));
        // Reported against the point, so the belief is part of the answer rather than something
        // the caller has to add back on.
        assert!(
            (dx - f64::from(shift_x)).abs() < 0.15 && (dy - f64::from(shift_y)).abs() < 0.15,
            "found ({dx}, {dy})"
        );
    }

    /// The search window is stated twice, and both have to say the same thing.
    ///
    /// The host reserves a margin of `Reach::margin` about every point it admits and the device
    /// searches `pc.patch` and `pc.search` about that point, so the two disagreeing is a device
    /// reading outside what was reserved for it - which comes back as a border pixel rather than as
    /// an error. They agree by construction now that the host sends the numbers, and what is left to
    /// go wrong is *where* it sends them: the block is built by position, so these two have to be
    /// the last fields of `Push` and in this order, on both shaders that take them.
    #[test]
    fn the_shader_searches_the_window_the_host_reserves() {
        let tail = |source: &str, of: &[&str]| {
            let fields: Vec<&str> = source
                .split_once("struct Push {")
                .expect("a Push block")
                .1
                .split_once('}')
                .expect("a closed Push block")
                .0
                .lines()
                .filter_map(|line| line.trim().strip_prefix("int ")?.strip_suffix(';'))
                .collect();
            assert_eq!(&fields[fields.len() - of.len()..], of, "the uniform's tail moved");
        };
        tail(include_str!("../../../slang/correspond.slang"), &["patch", "search"]);
        tail(include_str!("../../../slang/patch_stats.slang"), &["patch"]);
    }

    /// The colour model at each sample, on the device, or None where no adapter answered.
    fn through(colour: &HdrColour, stage: Stage, samples: &[[f64; 4]]) -> Option<Vec<[f64; 3]>> {
        let gpu = crate::gpu::device()?;
        let samples: Vec<[f32; 4]> = samples.iter().map(|s| s.map(|v| v as f32)).collect();
        let out = pollster::block_on(evaluated(gpu, colour, &samples, stage))
            .expect("the device evaluates the model");
        Some(out.iter().map(|v| [f64::from(v[0]), f64::from(v[1]), f64::from(v[2])]).collect())
    }

    /// The ratio table is sized on the host and indexed on the device; a length that drifted is
    /// a read past the table's end, which comes out as a warp rather than as an error.
    #[test]
    fn the_shader_reads_the_table_the_host_builds() {
        const SOURCE: &str = include_str!("../../../slang/fit_warp.slang");
        let last = format!("static const int TABLE_LAST = {};", crate::image::RATIO_TABLE_LAST);
        assert!(SOURCE.contains(&last), "fit_warp.slang does not say `{last}`");
    }

    fn identity_colour() -> HdrColour {
        HdrColour::identity()
    }

    /// What `gathered` would take off a host plane, with a surround of zero, in the width
    /// `through` takes.
    fn samples_of_f64(render: &Plane, at: &[usize]) -> Vec<[f64; 4]> {
        at.iter()
            .map(|p| [render.data[p * 3], render.data[p * 3 + 1], render.data[p * 3 + 2], 0.0])
            .collect()
    }

    /// A host plane where the probes read one.
    fn source_of(gpu: &'static crate::gpu::Gpu, plane: &Plane) -> Source {
        Source {
            buffer: gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("fit source test"),
                contents: &rgb_words(&plane.data, |v| v as f32),
                usage: wgpu::BufferUsages::STORAGE,
            }),
            width: plane.width,
            height: plane.height,
        }
    }

    #[test]
    fn an_identity_transform_returns_its_input() {
        // Past the ceiling too, where the pixel takes the shared gain: that path reads the
        // curve for a level as well as for a colour, so an identity one has to come back out.
        let levels = [0.0, 0.1, 0.45, 0.9, 1.6, 4.0];
        let samples: Vec<[f64; 4]> = levels.iter().map(|v| [*v, *v, *v, 0.0]).collect();
        let Some(out) = through(&identity_colour(), Stage::Full, &samples) else { return };
        for (value, out) in levels.iter().zip(&out) {
            assert!((out[0] - value).abs() < 1e-5, "{value} -> {out:?}");
        }
    }

    #[test]
    fn above_the_ceiling_the_gain_is_shared_rather_than_per_channel() {
        // The magenta-sky failure: three channels extrapolating independently drift
        // apart as brightness rises. A shared gain keeps the ratio, so a bright
        // orange stays orange and only gets brighter.
        let samples = [[0.6, 0.3, 0.15, 0.0], [2.4, 1.2, 0.6, 0.0]];
        let Some(out) = through(&identity_colour(), Stage::Full, &samples) else { return };
        let ratio_low = out[0][1] / out[0][0];
        let ratio_high = out[1][1] / out[1][0];
        assert!((ratio_low - ratio_high).abs() < 1e-5, "hue drifted: {ratio_low} vs {ratio_high}");
    }

    #[test]
    fn saturation_below_one_pulls_towards_luma() {
        let mut colour = identity_colour();
        colour.saturation = 0.5;
        let Some(out) = through(&colour, Stage::Full, &[[0.8, 0.2, 0.2, 0.0]]) else { return };
        let l = LUMA[0] * 0.8 + LUMA[1] * 0.2 + LUMA[2] * 0.2;
        assert!((out[0][0] - (l + (0.8 - l) * 0.5)).abs() < 1e-5, "{:?}", out[0]);
    }

    /// Every value `f16`-exact, so `densified`'s storage quantisation changes nothing and
    /// the smoothness comparison below reads the same fitted values both ways.
    fn a_bumpy_map() -> ChromaMap {
        ChromaMap::from_nodes(|x, y, z| {
            let v = (x as f64 * 0.71 + y as f64 * 1.13 + z as f64 * 0.37).sin() * 0.1;
            [1.0 + v, v * 0.5, -v * 0.3, 1.0 - v, v, -v, 1.0 + v * 0.2, v * 0.1, -v * 0.1]
                .map(|value| f64::from(half::f16::from_f64(value)))
        })
    }

    #[test]
    fn a_lattice_index_past_the_gamut_is_read_at_its_edge() {
        // The camera matrix hands the lattice colours no Rec.2020 primary can make - a
        // saturated red with green below zero and a luma near nothing - and the
        // chroma-to-lightness pair divides by that luma. Held to the chromaticity a colour with
        // no negative channel can have, so the read is the gamut edge's rather than a sign
        // that follows noise. One node everywhere, so the two reads land on identical cells and
        // differ only in what the pair was scaled by.
        let mut colour = HdrColour::identity();
        // Green pulled down by half the red, which is what takes the first sample past the
        // gamut after an identity tone stage, and leaves the second exactly on its edge.
        colour.matrix = [[1.0, 0.0, 0.0], [-0.5, 1.0, 0.0], [0.0, 0.0, 1.0]];
        colour.chroma = Some(ChromaMap::from_nodes(|_, _, _| {
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.1, -0.05]
        }));
        let m = [0.3, -0.11, 0.0];
        let l = LUMA[0] * m[0] + LUMA[1] * m[1] + LUMA[2] * m[2];
        assert!(l > 0.0 && (m[0] - l) / l > 1.0 / LUMA[0] - 1.0, "not past the gamut: {l}");
        let edge = l / LUMA[0];
        let samples = [[m[0], m[1] + 0.5 * m[0], 0.0, 0.0], [edge, 0.5 * edge, 0.0, 0.0]];
        let Some(out) = through(&colour, Stage::Full, &samples) else { return };
        // The chroma differs - each keeps its own - but the lightness the pair produced is read
        // off the index, and the index past the gamut is held to the edge's.
        let luma = |v: &[f64; 3]| LUMA[0] * v[0] + LUMA[1] * v[1] + LUMA[2] * v[2];
        let (past, held) = (luma(&out[0]), luma(&out[1]));
        assert!(
            (past - held).abs() < 1e-5 * held.max(1e-6),
            "read past the edge: {:?} against {:?}",
            out[0],
            out[1],
        );
    }

    #[test]
    fn the_applied_lattice_round_trips_through_its_coarse_form() {
        // The curve passes through its controls, so decimating the dense lattice reads the
        // controls back and `densified` rebuilds it bit-for-bit - the exactness the
        // sidecar's round trip stands on.
        let dense = a_bumpy_map().smoothed();
        let back = dense.coarse();
        assert_eq!(back.shape().chroma_count, MAP_CHROMA);
        assert_eq!(back.densified().nodes_flat(), dense.nodes_flat());
    }

    #[test]
    fn a_densified_lattice_reads_without_the_kinks() {
        // What a level-gradient reads is the lattice along `z` at its own chroma position,
        // and a zone contour is that read's slope jumping. The fitted lattice is linear
        // between nodes, so all its slope change lands on the crossings; the dense one
        // spreads a C1 curve's curvature over `MAP_DENSITY` steps. Measured on the value
        // sequences themselves, per step of each lattice's own grid, so the comparison
        // carries no smooth background from the probe.
        let map = a_bumpy_map();
        let dense = map.smoothed();
        // An off-grid chroma position - dense grid indices that are not multiples of
        // `MAP_DENSITY` - so the coarse side is a genuine interpolated read.
        let (fx, fy) = (0.25, 0.75);
        let coarse_at = |m: &ChromaMap, z: usize| -> f64 {
            let node = |x: usize, y: usize| m.nodes[(z * MAP_CHROMA + y) * MAP_CHROMA + x][4];
            (1.0 - fx) * (1.0 - fy) * node(1, 1)
                + fx * (1.0 - fy) * node(2, 1)
                + (1.0 - fx) * fy * node(1, 2)
                + fx * fy * node(2, 2)
        };
        let dense_at = |m: &ChromaMap, z: usize| -> f64 {
            let (x, y) = (MAP_DENSITY + 1, MAP_DENSITY * 2 - 1);
            m.nodes[(z * m.chroma_count + y) * m.chroma_count + x][4]
        };
        let ridges = |values: Vec<f64>| -> f64 {
            values.windows(3).map(|w| (w[2] - 2.0 * w[1] + w[0]).abs()).fold(0.0, f64::max)
        };
        let coarse = ridges((0..MAP_LEVEL).map(|z| coarse_at(&map, z)).collect());
        let smooth =
            ridges((0..dense.level_count).map(|z| dense_at(&dense, z)).collect());
        // The whole slope change of a fitted cell against one dense step's share of it.
        // Theory says `MAP_DENSITY`^2 apart for an even spread; the curvature bunches
        // towards the fitted nodes, so half that is what the resample must clear.
        assert!(
            smooth < coarse / (MAP_DENSITY * MAP_DENSITY) as f64 * 2.0,
            "slope still jumps: {smooth} against the fitted lattice's {coarse}"
        );
    }

    /// What `fit_curve_bins` writes, built on the host: the fixture the tests below want, whose
    /// subject is the solve over the bins rather than the binning that filled them.
    fn binned_by_hand(xs: &[f64], ys: &[f64], ws: &[f64]) -> crate::fit_curve::Binned {
        let mut binned = crate::fit_curve::Binned {
            sum: vec![0.0; BINS],
            weight: vec![0.0; BINS],
            count: vec![0usize; BINS],
        };
        for ((x, y), w) in xs.iter().zip(ys).zip(ws) {
            let bin = (((x / TRUST_CEILING) * (BINS - 1) as f64).round() as isize)
                .clamp(0, BINS as isize - 1) as usize;
            binned.sum[bin] += srgb_oetf(y.clamp(0.0, 1.0)) * w;
            binned.weight[bin] += w;
            binned.count[bin] += 1;
        }
        binned
    }

    /// A curve fitted from pairs of `shape`, whose samples reach `reach` of the domain.
    fn curve_of(reach: f64, shape: impl Fn(f64) -> f64) -> (Vec<f64>, isize) {
        let (xs, ys): (Vec<f64>, Vec<f64>) = (0..4000)
            .map(|i| {
                let x = (i as f64 / 4000.0) * TRUST_CEILING * reach;
                (x, shape(x))
            })
            .unzip();
        fit_curve(&binned_by_hand(&xs, &ys, &vec![1.0; xs.len()]))
    }

    /// The failure that renders a frame washed out: one over-estimated bin low in the range
    /// floors every bin after it, so all shadow detail comes out as a single value. On
    /// IMG_9887 the band covered 0.001 to 0.05 and three unrelated dark objects rendered
    /// 67/66/67 against the camera's 23/20/18, 33/26/20 and 31/25/32.
    ///
    /// The outlier has to sit in a bin of its own for this to be the real case. Mixed in with
    /// the dense pairs the binning averages it away before anything else sees it, which is why
    /// the first version of this test passed against the very code it was written to catch.
    #[test]
    fn one_bad_dark_bin_does_not_flatten_the_shadows() {
        let bin_of = |x: f64| ((x / TRUST_CEILING) * (BINS - 1) as f64).round() as usize;
        let bad = TRUST_CEILING * 0.02;
        let (mut xs, mut ys, mut ws) = (Vec::new(), Vec::new(), Vec::new());
        for i in 0..40_000 {
            let x = (i as f64 / 40_000.0) * TRUST_CEILING;
            // Everything but the outlier's own bin, so nothing dilutes it.
            if bin_of(x) == bin_of(bad) {
                continue;
            }
            xs.push(x);
            ys.push(x * 0.8);
            ws.push(1.0);
        }
        // Just enough pairs to be believed at all, claiming a value the honest curve does not
        // reach until six times the level.
        for _ in 0..MIN_BIN_SAMPLES + 2 {
            xs.push(bad);
            ys.push(TRUST_CEILING * 0.12 * 0.8);
            ws.push(1.0);
        }
        let (curve, _) = fit_curve(&binned_by_hand(&xs, &ys, &ws));

        // The bins above it have to keep climbing. Clamped to a running maximum they all sat at
        // its value until the honest curve caught up, and a band of one value is what
        // posterises a shadow.
        let at = |x: f64| curve[bin_of(x)];
        let (low, high) = (at(bad * 1.5), at(bad * 3.0));
        assert!(high > low + 1e-4, "the shadows flattened: {low} then {high}");

        // And the outlier is pulled down toward its neighbours rather than dragging them up: it
        // saw ten pairs against the thousands around it, so it has no business setting a floor.
        let honest = bad * 0.8;
        assert!(
            at(bad) < honest * 3.0,
            "one thin bin moved the curve to {} where the data says {honest}",
            at(bad),
        );
    }

    /// **A camera's toe turns hard enough that a knot's window spans several times the answer at
    /// its centre**, so a mean of that window lands near its top and the fitted curve sits above
    /// the bins it was drawn from wherever the shadows are. Measured on a backlit frame: knot 3
    /// came back at 0.0101 against its own bins' 0.0060, the render sat 7 L* over the camera at
    /// L* 10, and the blacks read as lifted across the picture.
    #[test]
    fn the_toe_is_fitted_where_its_bins_sit_rather_than_above_them() {
        let toe = |x: f64| TRUST_CEILING * (x / TRUST_CEILING).powf(1.6);
        let (curve, _) = curve_of(1.0, toe);
        for bin in 2..32 {
            let x = TRUST_CEILING * bin as f64 / (BINS - 1) as f64;
            let want = toe(x);
            assert!(
                (curve[bin] - want).abs() <= want * 0.12,
                "bin {bin} fitted {} against the {want} its own pairs measured",
                curve[bin],
            );
        }
    }

    #[test]
    fn a_curve_is_monotone_and_extends_past_its_data() {
        // Samples only up to half the domain: the tail must extend at the last slope
        // rather than flatten, or every highlight the frame did not sample is crushed.
        let (mut curve, last) = curve_of(0.5, |x| x * 0.8);
        extend_alone(&mut curve, last as usize);
        for b in 1..BINS {
            assert!(curve[b] >= curve[b - 1], "curve dipped at {b}");
        }
        assert!(curve[BINS - 1] > curve[BINS / 2], "the tail must keep climbing");
    }

    /// A camera's shape: a toe that expands chroma, a shoulder that compresses it, and a
    /// known level between them. Log-log slope 2 below `knee` and 0.4 above it, which is
    /// what makes the anchor's right answer a number rather than a range.
    fn shouldered(knee: f64) -> Vec<f64> {
        (0..BINS)
            .map(|b| {
                let x = TRUST_CEILING * b as f64 / (BINS - 1) as f64;
                match x <= knee {
                    true => x * x,
                    false => knee * knee * (x / knee).powf(0.4),
                }
            })
            .collect()
    }

    #[test]
    fn the_anchor_is_where_the_curve_stops_expanding_chroma() {
        let knee = TRUST_CEILING * 0.4;
        let anchor = chroma_anchor(&shouldered(knee), TRUST_CEILING);
        let step = TRUST_CEILING / (BINS - 1) as f64;
        assert!((anchor - knee).abs() <= step, "anchor {anchor} against the knee at {knee}");

        // A curve that never expands has nowhere better to read, and must not reach into
        // the toe for one.
        let flat: Vec<f64> =
            (0..BINS).map(|b| (b as f64 / (BINS - 1) as f64).powf(0.45) * 0.9).collect();
        assert_eq!(chroma_anchor(&flat, TRUST_CEILING), TRUST_CEILING);
    }

    #[test]
    fn a_highlight_keeps_its_colour_climbing_past_the_ceiling() {
        // The sunset. Reading every highlight at the shoulder rendered one scene colour
        // at the same saturation for 1x, 3x and 8x diffuse white alike, and flatter than
        // the same colour in the midtones. The join stays continuous and the brightest
        // channel does not move.
        let curve = shouldered(TRUST_CEILING * 0.4);
        let colour = HdrColour {
            curves: [curve.clone(), curve.clone(), curve.clone()],
            anchor: chroma_anchor(&curve, TRUST_CEILING),
            ..HdrColour::identity()
        };
        let saturation = |v: [f64; 3]| {
            let high = v[0].max(v[1]).max(v[2]);
            (high - v[0].min(v[1]).min(v[2])) / high
        };
        let levels: Vec<f64> = (0..=12).map(|step| TRUST_CEILING * f64::powi(1.3, step)).collect();
        let mut samples: Vec<[f64; 4]> =
            levels.iter().map(|level| [*level, level * 0.55, level * 0.2, 0.0]).collect();
        let above = TRUST_CEILING * 1.001;
        samples.push([above, above * 0.55, above * 0.2, 0.0]);
        samples.push([3.0, 3.0, 3.0, 0.0]);
        let Some(out) = through(&colour, Stage::Tone, &samples) else { return };

        let mut last = saturation(out[0]);
        for step in 1..=12 {
            let now = saturation(out[step]);
            assert!(now > last, "step {step} lost colour: {now} after {last}");
            last = now;
        }
        assert!(last > saturation(out[0]) * 1.1, "the climb never amounted to anything");

        // Continuous across the join, and the shoulder still decides the brightest channel.
        let (below, above) = (out[0], out[13]);
        assert!((saturation(above) - saturation(below)).abs() < 1e-3, "{above:?} after {below:?}");
        assert!((above[0] / below[0] - 1.001).abs() < 1e-3, "the peak moved: {above:?}");

        // A neutral highlight has no colour to keep and must not acquire one.
        assert!(saturation(out[14]) < 1e-6, "a neutral highlight came out {:?}", out[14]);
    }

    /// A lawn and a dog are different hues to the census, which is the whole premise of weighting
    /// by one. Held here rather than inside the weighting's own test, where the two colours would
    /// be a pattern too fine for the mask's gradient gate to admit anything at all.
    #[test]
    fn a_warm_brown_and_a_green_are_censused_apart() {
        let brown = selection([0.45, 0.25, 0.12], [0.45, 0.25, 0.12]).hues[CENTRE];
        let green = selection([0.16, 0.40, 0.10], [0.16, 0.40, 0.10]).hues[CENTRE];
        assert_ne!(brown, green, "both landed in bucket {brown}");
        assert!(usize::from(brown.max(green)) < HUE_BINS, "one of them read as grey");
    }

    #[test]
    fn one_colour_filling_a_frame_does_not_own_the_fit() {
        // IMG_8789's whole story: a lawn fills the frame, the fit minimises over every
        // pair equally, and the two brown dogs are too small a share for their error to
        // cost it anything - so they render olive while the held-out deltaE reports 2.96
        // and looks healthy. What a frame is *of* must not decide what the camera is
        // taken to do.
        let of: Vec<u8> = (0..40 * 40).map(|p| u8::from(p % 10 != 0)).collect();
        let mut counted = vec![0usize; HUE_BINS + 1];
        for bucket in &of {
            counted[usize::from(*bucket)] += 1;
        }
        let census = HueCensus { of, counted, total: 40 * 40 };

        let weights = hue_balance(&census, BALANCE_LIMIT);
        let share = |want: usize| -> f64 {
            (0..40 * 40).filter(|p| p % 10 == want).map(|p| census.weigh(&weights, p)).sum()
        };
        let (brown, green) = (share(0), (1..10).map(share).sum::<f64>());
        // Nine to one by area; the weighting has to pull that much closer to parity
        // without inverting it, since the grass is still most of what there is to fit.
        assert!(green / brown < 4.0, "the dominant hue still owns it: {green} against {brown}");
        assert!(green > brown, "the rare hue took over instead: {green} against {brown}");
    }

    /// One hue held across the whole brightness range, dark enough at the bottom to stay
    /// clear of the clipping cut.
    fn ramped_planes(hue: [f64; 3]) -> (Plane, Plane) {
        let (width, height) = (64, 64);
        let mut data = vec![0.0f64; width * height * 3];
        for p in 0..width * height {
            let level = 0.05 + 0.7 * (p / width) as f64 / (height - 1) as f64;
            for c in 0..3 {
                data[p * 3 + c] = hue[c] * level;
            }
        }
        let jpeg = Plane { width, height, data };
        (Plane { width, height, data: jpeg.data.clone() }, jpeg)
    }

    #[test]
    fn a_frame_with_no_chroma_to_measure_keeps_its_saturation() {
        // Fog, snow, overcast. Every probe rounds to the same 8-bit target, so the
        // objective is flat and every comparison ties - and a search that discards half
        // its bracket on a tie walks to whichever end it favours. This returned 1.499,
        // a 1.5x chroma boost, and then applied it to a full-resolution frame that is
        // not achromatic once it is off the blurred grid the fit measured on.
        let (render, jpeg) = ramped_planes([0.4, 0.4, 0.4]);
        let ramp: Vec<f64> = (0..BINS).map(|i| i as f64 / (BINS - 1) as f64).collect();
        let pairs = Pairs::over(searching(), &render, &jpeg);
        let colour = HdrColour {
            curves: [ramp.clone(), ramp.clone(), ramp],
            ceiling: TRUST_CEILING,
            anchor: TRUST_CEILING,
            matrix: IDENTITY,
            saturation: 1.0,
            chroma: None,
            surround: SurroundThumb::none(),
            delta_e: 0.0,
        };
        let source = source_of(searching(), &render);
        let found = pollster::block_on(fitted_saturation(searching(), &colour, &source, &pairs))
            .expect("the device scores");
        assert!((found - 1.0).abs() < 1e-9, "invented a saturation out of a flat frame: {found}");
    }

    #[test]
    fn a_one_sided_frame_still_reaches_the_colours_it_holds() {
        // Skin, foliage, sky: one chroma tail full, the other empty. Sized to the
        // narrower tail the axes collapse to their floor, every saturated pixel rides
        // the outermost node, and the grade's correction steps along the clamp contour -
        // which crosses a lit subject as a visible band.
        let red = [0.7, 0.3, 0.3];
        let grey = [0.4, 0.4, 0.4];
        let mut data = Vec::new();
        for p in 0..64 * 64 {
            data.extend_from_slice(if p % 2 == 0 { &grey } else { &red });
        }
        let wide_render = Plane { width: 64, height: 64, data };
        let wide_jpeg = Plane { width: 64, height: 64, data: vec![0.0; 64 * 64 * 3] };
        let sharp = Sharp {
            wide: source_of(searching(), &wide_render),
            camera: source_of(searching(), &wide_jpeg),
            falloff: None,
        };
        let span = pollster::block_on(chroma_span(searching(), &HdrColour::identity(), &sharp))
            .expect("the device evaluates the model");

        let l = LUMA[0] * red[0] + LUMA[1] * red[1] + LUMA[2] * red[2];
        let gaps = (MAP_CHROMA - 1) as f64;
        for (axis, d) in [(0, red[0] - l), (1, red[2] - l)] {
            let u = ChromaMap::warp(d);
            let (low, scale) = (span[axis][0], span[axis][1]);
            let high = low + gaps / scale;
            // The covering tail lands on the axis end to the f32 the device measured it in,
            // so an ulp is not a miss.
            assert!(
                low - 1e-5 <= u.min(0.0) && u.max(0.0) <= high + 1e-5,
                "axis {axis} spans {low:.3}..{high:.3}, the frame's own colour sits at {u:.3}",
            );
            // A grey has to land exactly on a node for the map to leave it alone.
            let zero = (0.0 - low) * scale;
            assert!((zero - zero.round()).abs() < 1e-9, "zero sits between nodes, at {zero}");
        }
    }

    #[test]
    fn the_saturation_search_recovers_the_blend_the_camera_used() {
        // And is not solved from a mean chroma ratio, which on IMG_9808 could be made
        // to come out right by a scalar that pushed the hillside eight deltaE further
        // from the camera than it started.
        let (render, jpeg) = ramped_planes([0.5, 0.3, 0.18]);
        let ramp: Vec<f64> = (0..BINS).map(|i| i as f64 / (BINS - 1) as f64).collect();

        for want in [0.85, 1.0, 1.2] {
            // The camera's rendering *is* the render pushed to `want`, so the search has
            // a right answer to find rather than a compromise to settle on.
            let applied = HdrColour {
                curves: [ramp.clone(), ramp.clone(), ramp.clone()],
                ceiling: TRUST_CEILING,
                anchor: TRUST_CEILING,
                matrix: IDENTITY,
                saturation: want,
                chroma: None,
                surround: SurroundThumb::none(),
                delta_e: 0.0,
            };
            let all: Vec<usize> = (0..render.width * render.height).collect();
            let pushed = through(&applied, Stage::Full, &samples_of_f64(&render, &all))
                .expect("an adapter for the fit's search");
            let target = Plane {
                width: jpeg.width,
                height: jpeg.height,
                data: pushed.iter().flatten().copied().collect(),
            };

            let pairs = Pairs::over(searching(), &render, &target);
            let neutral = HdrColour { saturation: 1.0, ..applied };
            let source = source_of(searching(), &render);
            let found =
                pollster::block_on(fitted_saturation(searching(), &neutral, &source, &pairs))
                    .expect("the device scores");
            assert!((found - want).abs() < 0.02, "wanted {want}, found {found}");
        }
    }

    #[test]
    fn a_neutral_highlight_comes_out_neutral_where_no_channel_has_data() {
        // The guarantee the sky needs, and the one three independently extrapolated
        // curves cannot give: DSC05469's sky is clipped in the sensor to exactly
        // neutral and rendered by the camera as exactly neutral, and it came out green.
        // Every channel converging on one curve is what makes neutral in mean neutral
        // out, rather than leaving it to three guesses that happen to agree.
        let (plane, preview) = warm_chart();
        let fitted =
            pollster::block_on(fit(
                searching(),
                &source_of(searching(), &plane),
                crate::light::Light::measured(1.0),
                &preview,
                crate::fit::Lens::none(),
            ))
                .expect("the chart is fittable");

        // Read where the grade reads a blown sky: the shared gain scales the pixel so
        // its brightest channel sits at the top of the domain.
        let out = through(fitted.colour.as_ref().expect("colour"), Stage::Tone, &[[1.0, 1.0, 1.0, 0.0]])
            .expect("an adapter for the fit's search")[0];
        let (high, low) = (out[0].max(out[1]).max(out[2]), out[0].min(out[1]).min(out[2]));
        assert!(high / low - 1.0 < 0.01, "a neutral highlight came out {out:?}");
    }

    #[test]
    fn converging_the_tail_does_not_flatten_a_colour_the_scene_had() {
        // Converging the curves is not desaturation: what carries a highlight's colour
        // is the pixel, not the curve, so a warm one stays warm.
        let (plane, preview) = warm_chart();
        let fitted =
            pollster::block_on(fit(
                searching(),
                &source_of(searching(), &plane),
                crate::light::Light::measured(1.0),
                &preview,
                crate::fit::Lens::none(),
            ))
                .expect("the chart is fittable");

        let out = through(fitted.colour.as_ref().expect("colour"), Stage::Tone, &[[1.2, 0.6, 0.3, 0.0]])
            .expect("an adapter for the fit's search")[0];
        assert!(out[0] > out[1] * 1.3, "the warm highlight went flat: {out:?}");
        assert!(out[1] > out[2] * 1.2, "the warm highlight went flat: {out:?}");
    }

    #[test]
    fn the_extension_replaces_only_the_bins_the_pairs_never_reached() {
        // A tail drawn from the wrong place still looks right, so the assertions above
        // pass just as well on an extension that overwrites the measured curve too. What
        // it must not touch is the data - the pairs are the only thing here that is not
        // an assumption.
        let (mut curve, last) = curve_of(0.18, |x| x.powf(0.45) * 0.9 * 1.3);
        let measured = curve.clone();
        extend_alone(&mut curve, last as usize);

        for b in 0..=last as usize {
            assert_eq!(curve[b], measured[b], "bin {b} was measured, not guessed");
        }
    }

    /// The camera's rendering of one scene-linear level, per channel. A power curve with a
    /// per-channel gain: the shape the three share, and a cast for `grey_balance` to pull out.
    const CAMERA_GAIN: [f64; 3] = [1.0, 1.06, 0.94];
    fn camera(channel: usize, level: f64) -> f64 {
        CAMERA_GAIN[channel] * 1.172 * level.max(0.0).powf(0.533)
    }

    /// A patch chart and the camera's rendering of it, shaped like the frame that
    /// turned green: the body of it sits in the domain all three channels share, and
    /// what reaches past that is warm, so red carries pairs to render 0.45 where green
    /// and blue stop around 0.20 and everything above is a guess.
    ///
    /// Flat patches rather than a gradient, because `fit_mask` drops any pixel with a
    /// gradient across it - a ramp is all edge and would leave nothing to fit from.
    ///
    /// The warm patches stop where they do because an 8-bit sRGB preview cannot hold a
    /// brighter one: rendered, render 0.62 against green's 0.20 leaves the sRGB gamut,
    /// clamps, and the fit then reads a red curve the camera never wrote.
    fn warm_chart() -> (Plane, crate::rgb::Rgb) {
        const COLS: usize = 10;
        const PATCHES: usize = 80;
        const PATCH: usize = 32;
        let (width, height) = (COLS * PATCH, (PATCHES / COLS) * PATCH);

        let patch = |i: usize| -> [f64; 3] {
            // Warm highlights: only red reaches past the domain the three share.
            if i >= 60 {
                let t = (i - 60) as f64 / 19.0;
                return [0.24 + t * 0.21, 0.10 + t * 0.095, 0.06 + t * 0.075];
            }
            // Everything the three channels have in common, tinted four ways so the
            // matrix has more than a grey axis to fit against.
            let level = 0.004 + (i as f64 / 59.0) * 0.196;
            let tint = [[1.0, 1.0, 1.0], [1.0, 0.85, 0.7], [0.8, 1.0, 0.9], [0.9, 0.85, 1.0]][i % 4];
            [0, 1, 2].map(|c| level * tint[c])
        };

        // Both planes at twice the chart, because `fit` pairs them pixel for pixel: the
        // caller decodes its preview to `preview_long_edge`, which is the grid the
        // render arrives on too.
        let mut scene = vec![0.0f64; width * height * 3 * 4];
        let mut rendered = vec![0.0f64; width * height * 3 * 4];
        for y in 0..height {
            for x in 0..width {
                let colour = patch((y / PATCH) * COLS + (x / PATCH));
                let camera = [0, 1, 2].map(|c| camera(c, colour[c]));
                for c in 0..3 {
                    for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                        let p = ((y * 2 + dy) * width * 2) + x * 2 + dx;
                        rendered[p * 3 + c] = camera[c];
                        scene[p * 3 + c] = colour[c];
                    }
                }
            }
        }

        let camera_plane = Plane { width: width * 2, height: height * 2, data: rendered };
        (
            Plane { width: width * 2, height: height * 2, data: scene },
            render_srgb8(&camera_plane, crate::light::Light::measured(1.0)),
        )
    }

    #[test]
    fn a_channel_that_ran_out_of_pairs_lands_near_the_rendering_it_never_saw() {
        // The green sky, on a frame small enough to build here. Above render 0.20 the
        // green curve is guesswork whatever this does, so what is asserted is which
        // guess: the shape red measured, rather than a straight line from green's own
        // last bin - which on this chart is 8.4% hot at 0.4 and 19.2% at 0.6, climbing
        // away from red, which is the part the eye reads as a cast.
        //
        // Bounded per channel rather than by one number for all three, because the
        // chart is built with per-channel gains (1.06 on green, 0.94 on blue) and the
        // design deliberately gives them up above the join: every channel converges on
        // the *highest* held extension, so once past its own pairs the coolest channel
        // must read about its gain difference high. Asserting one tight bound across
        // all three would be asserting against the design and could only be met by
        // loosening it until it said nothing.
        let (plane, preview) = warm_chart();
        let fitted =
            pollster::block_on(fit(
                searching(),
                &source_of(searching(), &plane),
                crate::light::Light::measured(1.0),
                &preview,
                crate::fit::Lens::none(),
            ))
                .expect("the chart is fittable");

        // Through the whole model, not through `curves` alone. The tone stage is one shared
        // shape, so per-channel behaviour is the *model's* to produce and reading a curve on its
        // own says nothing about what the picture gets. This is the same reason a held-out mean
        // could not see the cast: measure the layer, and you learn about the layer.
        //
        // At the level's own surround, because a flat sky's neighbourhood is itself - and it is
        // where the chart's pairs taught the map. Zero would read the one surround slab no pair
        // of this chart reached.
        let levels = [0.4, 0.5, 0.6];
        let samples: Vec<[f64; 4]> = levels.iter().map(|l| [*l, *l, *l, *l]).collect();
        let outs = through(fitted.colour.as_ref().expect("colour"), Stage::Full, &samples)
            .expect("an adapter for the fit's search");
        for (level, out) in levels.iter().copied().zip(outs) {
            for c in 0..3 {
                let at = out[c] / camera(c, level) - 1.0;
                assert!(at.abs() < 0.06, "channel {c} at {level}: {at:+.3}");
            }
            // And the point of the whole exercise: whatever each channel is doing, they may
            // not climb away from each other. Extrapolating green off its own last bin runs
            // 8.4% hot at 0.4 and 19.2% at 0.6 - a spread that widens with level is exactly
            // what the eye reads as a cast, where an even offset reads as exposure.
            let (high, low) = (
                (0..3).map(|c| out[c] / camera(c, level)).fold(f64::MIN, f64::max),
                (0..3).map(|c| out[c] / camera(c, level)).fold(f64::MAX, f64::min),
            );
            assert!(high / low - 1.0 < 0.085, "channels {high:.3}/{low:.3} apart at {level}");
        }
    }

    #[test]
    fn two_neighbours_of_nearly_the_same_colour_are_not_pulled_apart() {
        // The rash. A stage that computes its gain from the pixel's own colour
        // amplifies whatever variation that colour has, and on a real frame most of the
        // variation across a flat surface is sensor noise the camera's JPEG has had
        // denoised away - so a dog's even fur came out red-speckled beside green and a
        // flat grey wall came out blotchy. Denoising ours first does not fix it at the
        // strength the render is denoised by, so what the transform must do instead is
        // leave neighbours as close together as it found them.
        let mut colour = identity_colour();
        colour.matrix = [[1.06, -0.04, -0.02], [-0.03, 1.05, -0.02], [-0.02, -0.05, 1.07]];
        colour.saturation = 1.08;

        let bases = [[0.12, 0.10, 0.09], [0.40, 0.30, 0.22], [0.75, 0.74, 0.72]];
        // Two pixels a hair apart, as neighbours on a flat surface are.
        let near = |base: [f64; 3]| [base[0] + 0.004, base[1] - 0.003, base[2] + 0.002];
        let samples: Vec<[f64; 4]> = bases
            .iter()
            .flat_map(|base| {
                let n = near(*base);
                [[base[0], base[1], base[2], 0.0], [n[0], n[1], n[2], 0.0]]
            })
            .collect();
        let Some(out) = through(&colour, Stage::Full, &samples) else { return };
        for (k, base) in bases.into_iter().enumerate() {
            let near = near(base);
            let (a, b) = (out[k * 2], out[k * 2 + 1]);
            let apart = |x: [f64; 3], y: [f64; 3]| {
                (0..3).map(|c| (x[c] - y[c]).powi(2)).sum::<f64>().sqrt()
            };
            let (before, after) = (apart(base, near), apart(a, b));
            assert!(
                after < before * 1.5,
                "{before} apart went to {after}: {a:?} against {b:?}",
            );
        }
    }

    #[test]
    fn the_matrix_leaves_a_neutral_neutral_however_hard_it_is_pulled() {
        // The freedom browns need and the guarantee greys need, at the same time. A ridge
        // buys the second by denying the first: damped to near-identity the matrix cannot
        // say that this camera scales green by 0.884 on grass and 0.690 on a dog, and the
        // dogs come out olive. Constrained instead, the rows may go where the pairs point
        // as long as a grey stays a grey.
        let mut m = Moments::default();
        // Pairs that want a strong cross-channel term: green pulled down hard on
        // anything red-dominant, left alone on green-dominant.
        for (v, y) in [
            ([0.5, 0.3, 0.2], [0.5, 0.18, 0.2]),
            ([0.2, 0.6, 0.1], [0.2, 0.6, 0.1]),
            ([0.4, 0.4, 0.4], [0.4, 0.4, 0.4]),
            ([0.1, 0.2, 0.6], [0.1, 0.2, 0.6]),
        ] {
            m.add(1.0, &v, &y);
        }

        let matrix = m.solve(0.0005);
        for (o, row) in matrix.iter().enumerate() {
            let sum: f64 = row.iter().sum();
            assert!((sum - 1.0).abs() < 1e-9, "row {o} sums to {sum}");
        }
        for grey in [0.05, 0.4, 0.9, 2.5] {
            let out = apply3(&matrix, grey, grey, grey);
            let (high, low) = (out[0].max(out[1]).max(out[2]), out[0].min(out[1]).min(out[2]));
            assert!(high - low < 1e-9, "grey {grey} came out {out:?}");
        }
        // And it did use the freedom rather than sitting at the identity.
        assert!(matrix[1][0].abs() > 0.05, "no cross-channel term was fitted: {matrix:?}");
    }

    #[test]
    fn solve_row_reports_a_singular_system() {
        let singular = [[1.0, 2.0, 3.0], [2.0, 4.0, 6.0], [3.0, 6.0, 9.0]];
        assert!(solve_row(&singular, &[1.0, 2.0, 3.0]).is_none());
    }

    #[test]
    fn the_rec2020_round_trip_lands_back_on_srgb() {
        // A neutral in Rec.2020 linear must come back neutral in sRGB, or the deltaE
        // `fit_score.slang` reports is measured in the wrong space - this is the matrix it is
        // handed for it.
        let v = apply3(&rec2020_to_srgb(), 0.5, 0.5, 0.5);
        let out = [0, 1, 2].map(|c| (255.0 * srgb_oetf(v[c])).round());
        assert!((out[0] - out[1]).abs() <= 1.0 && (out[1] - out[2]).abs() <= 1.0, "{out:?}");
        assert!(out[0] > 150.0 && out[0] < 200.0, "mid grey, got {}", out[0]);
    }

    /// The correspondence dispatch reaches every point without asking for a dimension the
    /// device refuses, at the plane sizes a real camera produces.
    ///
    /// A 61MP frame is what found this: one dimension held 66084 workgroups against a limit of
    /// 65535, the validation error became a panic, and the frame lost its camera match. The
    /// arithmetic is here rather than only at the call site because `correspond.slang` rebuilds
    /// the index from the same span and a disagreement drops the tail of the plane silently.
    #[test]
    fn the_correspondence_dispatch_covers_its_points_within_the_device_limit() {
        for points in [1usize, 63, 64, 6_000, 3_300_000, 4_194_240, 4_229_376, 60_200_000] {
            let span = dispatch_span(points);
            let across = span / CORRESPOND_GROUP as usize;
            let groups = points.div_ceil(CORRESPOND_GROUP as usize).max(1);
            let down = groups.div_ceil(across);
            assert!(across <= 65535 && down <= 65535, "{points} asks {across} by {down}");
            assert!(across * CORRESPOND_GROUP as usize * down >= points, "{points} uncovered");
            // Every launched group does work: the spare is under one row of them.
            assert!(across * down - groups < across, "{points} wastes {} groups", across * down);
        }
    }

    /// The index `correspond.slang` rebuilds reaches every point exactly once, and nothing else.
    ///
    /// **The span is computed on one side and undone on the other**, which is the shape that put
    /// a 61MP frame's fit on the floor to begin with. The test above says the host's dispatch is
    /// within the device's limits; this one walks the grid that dispatch describes and applies the
    /// shader's own `id.y * span + id.x` to it, so the two halves are held together rather than
    /// each being correct about its own arithmetic.
    ///
    /// Small counts, plus the two either side of one row: a real multi-row dispatch on the device
    /// is 4.2M points and a plane to match, which is minutes of GPU for a claim that is about
    /// indexing rather than about pixels.
    #[test]
    fn the_shader_rebuilds_every_point_the_dispatch_covers() {
        for points in [1usize, 64, 65, 4_194_240, 4_194_241, 4_229_376] {
            let span = dispatch_span(points);
            let across = (span / CORRESPOND_GROUP as usize) as u32;
            let groups = (points as u32).div_ceil(CORRESPOND_GROUP).max(1);
            let down = groups.div_ceil(across);

            let mut seen = vec![false; points];
            for y in 0..down {
                for x in 0..across * CORRESPOND_GROUP {
                    // `correspond.slang`: `int(id.y * uint(pc.span) + id.x)`, then the bounds
                    // test that follows it.
                    let point = y as usize * span + x as usize;
                    if point >= points {
                        continue;
                    }
                    assert!(!seen[point], "{points}: point {point} is dispatched twice");
                    seen[point] = true;
                }
            }
            assert!(seen.iter().all(|hit| *hit), "{points}: a point was never dispatched");
        }
    }

    #[test]
    fn the_holdout_keeps_a_fifth_and_gives_both_halves_the_frame() {
        let gpu = searching();
        let at: Vec<usize> = (0..1000).collect();
        let pairs = Pairs {
            target: vec![[0.0; 3]; at.len()],
            balance: vec![1.0; at.len()],
            indices: indices_on(gpu, &at),
            at,
            to_srgb: IDENTITY,
            grey_indices: indices_on(gpu, &[]),
            greys: Vec::new(),
            grey_target: [0.0; 3],
            linear: std::cell::OnceCell::new(),
        };
        let (fitted, judged) = pairs.split(gpu);
        assert_eq!(fitted.at.len() + judged.at.len(), 1000);
        assert_eq!(judged.at.len(), 1000 / HOLDOUT_EVERY);
        // Neither half is one end of the list, which is what the stride is for.
        assert!(judged.at[0] < HOLDOUT_EVERY);
        assert!(*judged.at.last().unwrap() >= 1000 - HOLDOUT_EVERY);
    }

    #[test]
    fn the_correspondence_dispatch_is_unchanged_below_the_limit() {
        // One row, so `id.y * span + id.x` is `id.x` and the geometry is what it always was.
        let points: usize = 3_300_000;
        let groups = points.div_ceil(CORRESPOND_GROUP as usize);
        assert_eq!(dispatch_span(points), groups * CORRESPOND_GROUP as usize);
    }
}
