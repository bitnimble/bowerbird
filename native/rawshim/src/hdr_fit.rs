// The camera's colour treatment, fitted for the HDR path (DESIGN 10.8).
//
// The SDR fit (`fit.rs`) works entirely in 8-bit sRGB: its curves are indexed by an
// 8-bit render level and answer with an 8-bit JPEG level. That cannot be lifted to
// HDR, for two reasons that are both fatal rather than approximate. Its domain stops
// at display white, so it has nothing to say about the scene above it - which is the
// whole of what HDR adds. And 8 bits of output is coarser than the shadows of a PQ
// signal, so applying it would band.
//
// So the geometry is reused - it is a property of the lens, not of a colour space -
// and only the colour is refitted, in the domain the grade actually works in:
// Rec.2020 linear, normalised so diffuse white is 1.0. That makes the curve
// extrapolable, which is what lets the camera's rendering stop at diffuse white and
// BT.2390 take over above it (10.7.1).

use crate::image::warp_planar;
use crate::parallel::*;

/// Long edge of the grid the fit runs on. Matching the SDR fit: fitting small and
/// applying at full resolution is free, and a 60MP fit is minutes of work for the
/// same answer.
const FIT_LONG_EDGE: usize = 640;

/// Curve resolution over the fit domain.
const BINS: usize = 256;

/// How far above diffuse white the JPEG is still believed, as a fraction of it.
///
/// Not 1.0: the last stop before an 8-bit image clips is the camera compressing
/// highlights into a range it does not have, and a curve fitted through that learns
/// the compression as though it were colour. Cut below it and the shoulder is never
/// seen.
pub const TRUST_CEILING: f64 = 0.9;

const MIN_BIN_SAMPLES: usize = 8;
const MIN_PAIRS: usize = 2000;

/// Rec.2020 luma, for the chroma blend and the sample weighting.
const LUMA: [f64; 3] = [0.2627, 0.678, 0.0593];

/// Three box passes, close enough to a Gaussian here. Both images are blurred before
/// pairing for the same reason the SDR fit does it: the camera's sharpening and noise
/// reduction are not reproducible and must not leak into the colour fit, and residual
/// misregistration stops mattering once neither image has detail at that scale.
const FIT_BLUR_RADIUS: usize = 2;

/// Where the camera's rendering stops carrying information. Above this a JPEG level is
/// on its way to flat white and says nothing about what colour was there, so a pair is
/// no use for the channel that reached it.
const CAMERA_CLIPPING: f64 = 0.94;

/// The damping used where a frame gives `fitted_matrix` nothing at all to choose
/// between candidates with, its moments being empty. The frame picks its own in every
/// other case; this is the value it used to be fixed at.
const MATRIX_RIDGE: f64 = 0.05;

const SRGB_TO_XYZ: [[f64; 3]; 3] = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.072175],
    [0.0193339, 0.119192, 0.9503041],
];
const XYZ_TO_REC2020: [[f64; 3]; 3] = [
    [1.7166512, -0.3556708, -0.2533663],
    [-0.6666844, 1.6164812, 0.0157685],
    [0.0176399, -0.0427706, 0.9421031],
];
const REC2020_TO_XYZ: [[f64; 3]; 3] = [
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

fn multiply(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

fn apply3(m: &[[f64; 3]; 3], r: f64, g: f64, b: f64) -> [f64; 3] {
    [
        m[0][0] * r + m[0][1] * g + m[0][2] * b,
        m[1][0] * r + m[1][1] * g + m[1][2] * b,
        m[2][0] * r + m[2][1] * g + m[2][2] * b,
    ]
}

fn srgb_eotf(level: u8) -> f64 {
    let c = f64::from(level) / 255.0;
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

#[derive(Clone)]
pub struct HdrColour {
    /// Per-channel, `BINS` samples spanning render values 0 to TRUST_CEILING.
    pub curves: [Vec<f64>; 3],
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
    pub saturation: f64,
    /// The hue-dependent part, where the frame supported fitting one.
    ///
    /// None is not a failure - it is the model this had before there was a chroma axis,
    /// and a frame with too little colour to fit one is better served by it.
    pub chroma: Option<ChromaMap>,
    /// Held-out mean deltaE76 over the fit pairs, for reporting.
    pub delta_e: f64,
}

/// Nodes across each chroma axis and up the level axis.
///
/// Deliberately coarse. What this corrects is a camera's hue-dependent rendering, which
/// is smooth; what it must not do is vary fast enough with a pixel's own colour to
/// amplify the noise in that colour, which is what took the per-hue gain out again
/// (`HdrColour::saturation`). Cell width is the denominator of that gradient, so it is
/// the safety margin.
const MAP_CHROMA: usize = 5;
const MAP_LEVEL: usize = 4;

/// Every node of the grid, as a compile-time count.
const MAP_NODES: usize = MAP_CHROMA * MAP_CHROMA * MAP_LEVEL;

/// How far out the chroma axes reach before the grid clamps, and how far up the level
/// axis does. Beyond either, a colour keeps the last node's correction rather than an
/// extrapolated one - which is what makes the map safe above the reference's clip point.
///
/// Measured rather than guessed, and the first guess wasted the grid: at 0.6 the chroma
/// axes spanned half again what a frame actually contains - |d| runs to 0.42 at its very
/// widest and 0.375 at the 99th - so 58 of 100 nodes were never touched and the ones that
/// were sat three to an axis. The level axis is in the square root, where a frame reaches
/// about 0.85.
const CHROMA_REACH: f64 = 0.45;
const LEVEL_REACH: f64 = 0.9;

/// `a` toward `b`, fused where the target has an instruction to fuse with.
///
/// `mul_add` is one instruction and one rounding where the pair is two, and on the v3 and
/// v4 builds it takes ~10% off reading the chroma map. On the baseline build it is a
/// catastrophe: with no FMA instruction it lowers to a libm call for a correctly-rounded
/// result, and the same loop goes from 22ns per pixel to 54. The image ships a build per
/// instruction set (DESIGN 11.x), so this resolves per build rather than being chosen once
/// for all three - and the baseline is the one that runs on hardware with no AVX at all.
#[inline]
fn lerp(a: f64, b: f64, t: f64) -> f64 {
    #[cfg(target_feature = "fma")]
    {
        (b - a).mul_add(t, a)
    }
    #[cfg(not(target_feature = "fma"))]
    {
        a + (b - a) * t
    }
}

/// A correction on chroma alone, indexed by chroma and level.
///
/// **Not on lightness.** The camera's rendering of *level* is the tone curves' job and
/// the reference cannot speak past its own clip point, so mapping lightness onto the
/// JPEG's would hand back exactly the highlight range an HDR rendition exists to keep.
/// This moves a colour around the grey axis and leaves how bright it is alone, which is
/// also what makes it safe to apply above the fit domain: a correction near identity
/// stays near identity where the data runs out, where a transfer does not.
///
/// Indexed in Cartesian chroma rather than hue and saturation, which costs nothing per
/// pixel: `d = v - luma` already lies in the plane `LUMA . d = 0`, so `(d[0], d[2])` fixes
/// it and `d[1]` follows. Polar would mean an `atan2` on every one of 180M samples to say
/// the same thing, and it puts a seam at the wrap where trilinear needs none.
#[derive(Clone)]
pub struct ChromaMap {
    /// A 2x2 on `(d0, d2)` per node, indexed level-major then y then x.
    ///
    /// Fixed length rather than a `Vec`, which is worth 12% of what reading this map
    /// costs. `axis` clamps every index into range before it is used, but a runtime
    /// length makes the compiler prove that again at each corner - eight bounds checks
    /// per pixel, each one a branch the blend behind it has to wait on.
    nodes: Box<[[f64; 4]; MAP_NODES]>,
}

impl ChromaMap {
    /// The map that changes nothing, for a caller with no fit yet.
    pub fn identity() -> ChromaMap {
        ChromaMap::from_saturation(1.0)
    }

    /// The map that does exactly what the saturation scalar does.
    ///
    /// Which is the point of the shape: one gain applied to every colour alike is this
    /// model with the same 2x2 at every node, so the chroma map is a strict
    /// generalisation of the scalar it replaces rather than a second thing beside it.
    /// A frame that wants nothing hue-dependent is described by the same 2x2 at every
    /// node, exactly.
    ///
    /// Exactly in the 2x2, not bit-identically in what leaves `finish_chroma`: that
    /// rebuilds the middle channel as `-(L0.d0 + L2.d2) / L1` where the scalar path
    /// blends it directly, so the two agree to a few ulps rather than to the bit.
    pub fn from_saturation(saturation: f64) -> ChromaMap {
        let node = [saturation, 0.0, 0.0, saturation];
        ChromaMap { nodes: Box::new([node; MAP_NODES]) }
    }

    /// Where a coordinate sits on an axis running `low` to `high`: the node below it,
    /// and how far past.
    ///
    /// `scale` is the span's reciprocal times the gaps, passed in rather than divided out
    /// here: both axes have a span fixed at compile time, and three divisions per pixel of
    /// a full-size rendition was the single largest cost in reading this map.
    #[inline]
    fn axis(value: f64, nodes: usize, low: f64, scale: f64) -> (usize, f64) {
        // `max` then `min` rather than `clamp`: these return whichever operand is not
        // NaN, so a NaN arriving here lands on a node instead of propagating into an
        // index.
        let t = ((value - low) * scale).max(0.0).min((nodes - 1) as f64);
        let below = (t as usize).min(nodes - 2);
        (below, t - below as f64)
    }

    /// Gaps per unit on each axis, so `axis` multiplies where it used to divide.
    const CHROMA_SCALE: f64 = (MAP_CHROMA - 1) as f64 / (2.0 * CHROMA_REACH);
    const LEVEL_SCALE: f64 = (MAP_LEVEL - 1) as f64 / LEVEL_REACH;

    /// The eight nodes a colour sits between, and how much of each it takes.
    ///
    /// Used by the fit. `correct` walks the same axes and the same eight corners inline,
    /// because building the index and weight arrays is most of what reading the map
    /// costs and it runs per pixel. The two must agree about which nodes a colour
    /// belongs to - a map fitted against one neighbourhood and read from another is
    /// wrong everywhere - and nothing but this note enforces that now.
    fn nodes_for(level: f64, d0: f64, d2: f64) -> ([usize; 8], [f64; 8]) {
        let (x, fx) = Self::axis(d0, MAP_CHROMA, -CHROMA_REACH, Self::CHROMA_SCALE);
        let (y, fy) = Self::axis(d2, MAP_CHROMA, -CHROMA_REACH, Self::CHROMA_SCALE);
        // Square root rather than the level itself, so the shadows get nodes in
        // proportion to how much of a picture lives in them, and cheaper than a cube root
        // in a loop this size.
        let (z, fz) = Self::axis(level.max(0.0).sqrt(), MAP_LEVEL, 0.0, Self::LEVEL_SCALE);

        let mut at = [0usize; 8];
        let mut weight = [0.0f64; 8];
        let mut k = 0;
        for (dz, wz) in [(0, 1.0 - fz), (1, fz)] {
            for (dy, wy) in [(0, 1.0 - fy), (1, fy)] {
                for (dx, wx) in [(0, 1.0 - fx), (1, fx)] {
                    at[k] = ((z + dz) * MAP_CHROMA + y + dy) * MAP_CHROMA + x + dx;
                    weight[k] = wz * wy * wx;
                    k += 1;
                }
            }
        }
        (at, weight)
    }

    /// The corrected chroma coordinates.
    ///
    /// Trilinear, so the correction is continuous everywhere and its gradient is bounded
    /// by the difference between neighbouring nodes over a cell's width - which is the
    /// property that keeps it from turning noise in a pixel's colour into speckle.
    /// Blended as nested interpolations rather than as eight weighted nodes, which is the
    /// same surface for seven multiply-adds per coefficient instead of eight products and
    /// eight more to build the weights. It runs on every pixel of a full-size rendition,
    /// where the eight-weight form is what `nodes_for` is for - the fit wants the weights
    /// themselves, to say how much each node was told.
    fn correct(&self, level: f64, d0: f64, d2: f64) -> (f64, f64) {
        let (x, fx) = Self::axis(d0, MAP_CHROMA, -CHROMA_REACH, Self::CHROMA_SCALE);
        let (y, fy) = Self::axis(d2, MAP_CHROMA, -CHROMA_REACH, Self::CHROMA_SCALE);
        let (z, fz) = Self::axis(level.max(0.0).sqrt(), MAP_LEVEL, 0.0, Self::LEVEL_SCALE);

        // The eight corners copied into locals before any of the blending, so the four
        // coefficients are computed from registers rather than reloading two row pointers
        // per coefficient. It runs on every pixel of a full-size rendition, and left to
        // index the table per coefficient it cost about five times what the arithmetic in
        // it does.
        let area = MAP_CHROMA * MAP_CHROMA;
        let base = z * area + y * MAP_CHROMA + x;
        let corner = |at: usize| -> ([f64; 4], [f64; 4], [f64; 4], [f64; 4]) {
            (self.nodes[at], self.nodes[at + 1], self.nodes[at + MAP_CHROMA], self.nodes[at + MAP_CHROMA + 1])
        };
        let (n00, n01, n10, n11) = corner(base);
        let (f00, f01, f10, f11) = corner(base + area);

        let mut cell = [0.0f64; 4];
        for (c, slot) in cell.iter_mut().enumerate() {
            let near = {
                let lo = lerp(n00[c], n01[c], fx);
                let hi = lerp(n10[c], n11[c], fx);
                lerp(lo, hi, fy)
            };
            let far = {
                let lo = lerp(f00[c], f01[c], fx);
                let hi = lerp(f10[c], f11[c], fx);
                lerp(lo, hi, fy)
            };
            *slot = lerp(near, far, fz);
        }
        (cell[0] * d0 + cell[1] * d2, cell[2] * d0 + cell[3] * d2)
    }

    /// How far past its allowance one node sits: 1 is exactly at it.
    ///
    /// The speckle test, and it has to be a test rather than an argument. A correction
    /// that varies with a pixel's own colour amplifies the noise in that colour by its
    /// Jacobian - `M + (dM/dd) . d` - and a per-hue gain fitted finely enough did exactly
    /// that here once, pulling flat fur apart into red speckles beside green ones. The
    /// first term is the node's own 2x2; the second is bounded by how much neighbouring
    /// nodes differ across a cell, which is why the grid is coarse.
    ///
    /// What is allowed depends on where the node sits, because that is where the damage
    /// would be. Speckle is seen on flat, near-neutral surfaces - fur, a rendered wall, a
    /// white ceramic - where the eye reads any colour at all as a defect. A deeply
    /// saturated glaze takes a much firmer hand before anything looks wrong, and it is
    /// the saturated minority colours that need one, being the ones a single global
    /// scalar never described.
    fn strain_at(&self, x: usize, y: usize, z: usize) -> f64 {
        let step = 2.0 * CHROMA_REACH / (MAP_CHROMA - 1) as f64;
        let here = self.nodes[(z * MAP_CHROMA + y) * MAP_CHROMA + x];
        // The 2x2 itself, as an upper bound on its gain.
        let own = (here[0].abs() + here[1].abs()).max(here[2].abs() + here[3].abs());
        // Plus what the neighbours' disagreement adds over one cell, at the chroma *this*
        // node sits at - not at the grid's furthest corner. The varying part of the
        // Jacobian is `(dM/dd) . d`, so it vanishes on the grey axis and grows outward.
        let coordinate = |i: usize| -CHROMA_REACH + i as f64 * step;
        let reach = coordinate(x).hypot(coordinate(y));
        let mut slope: f64 = 0.0;
        for (nx, ny) in [(x + 1, y), (x, y + 1)] {
            if nx >= MAP_CHROMA || ny >= MAP_CHROMA {
                continue;
            }
            let next = self.nodes[(z * MAP_CHROMA + ny) * MAP_CHROMA + nx];
            let gap = (0..4).map(|k| (next[k] - here[k]).abs()).fold(0.0, f64::max);
            slope = slope.max(gap / step * reach);
        }
        let allowed =
            MAP_AMP_NEUTRAL + (MAP_AMP_SATURATED - MAP_AMP_NEUTRAL) * (reach / CHROMA_REACH).min(1.0);
        (own + slope) / allowed
    }

    /// The worst of them, for reporting.
    fn strain(&self) -> f64 {
        let mut worst: f64 = 0.0;
        for z in 0..MAP_LEVEL {
            for y in 0..MAP_CHROMA {
                for x in 0..MAP_CHROMA {
                    worst = worst.max(self.strain_at(x, y, z));
                }
            }
        }
        worst
    }

    /// Pulls back whichever nodes are over their allowance, and only those.
    ///
    /// Node by node rather than the whole map, because the map is damped for a local
    /// reason. Shrinking all of it to bring one near-neutral node under its (deliberately
    /// tight) allowance also shrinks the saturated corrections that node has nothing to
    /// do with - which is the whole reason those corrections exist. Relaxed rather than
    /// solved: a node's strain reads its neighbours, so pulling one back moves theirs.
    ///
    /// **Known defect: this cannot converge when `saturation` exceeds `MAP_AMP_NEUTRAL`.**
    /// Each node is shrunk toward the flat map, and the flat map's own strain is
    /// `saturation / allowed` - so above 1.05 the target is itself over the allowance and
    /// no number of sweeps reaches it. All twelve fire and the node keeps `0.75^12` of
    /// what was fitted, which is 3%: the near-neutral nodes lose their correction for a
    /// reason that is nothing to do with their own variation, while the saturated nodes
    /// they were competing with survive. Above ~1.45 every node goes, the map collapses to
    /// the scalar and `MAP_MARGIN` then drops it entirely.
    ///
    /// Left as it measures. The shrinkage, the margin and the amplitude bounds were all
    /// calibrated over the 35-frame set against this behaviour, so the fix - strain
    /// measured against the scalar baseline rather than in absolute amplification - moves
    /// every one of them and wants the corpus, the pot and the speckle regions re-run
    /// behind it.
    fn relax(&mut self, saturation: f64) {
        let flat = [saturation, 0.0, 0.0, saturation];
        for _ in 0..12 {
            if self.strain() <= 1.0 {
                return;
            }
            let mut over = false;
            for z in 0..MAP_LEVEL {
                for y in 0..MAP_CHROMA {
                    for x in 0..MAP_CHROMA {
                        if self.strain_at(x, y, z) <= 1.0 {
                            continue;
                        }
                        over = true;
                        let node = &mut self.nodes[(z * MAP_CHROMA + y) * MAP_CHROMA + x];
                        for k in 0..4 {
                            node[k] = flat[k] + (node[k] - flat[k]) * 0.75;
                        }
                    }
                }
            }
            if !over {
                break;
            }
        }
    }

}

/// The whole transform: what the lens did, then what the camera did to its colour.
///
/// One struct rather than three arguments because they are one thing. The colour was
/// fitted from pairs that only correspond *through* the geometry, so applying the
/// colour without the warp gives a photo the camera's colour and LibRaw's shape -
/// which is what shipped first, and it made the HDR rendition disagree with its own
/// SDR twin about where everything in the frame was. The falloff joined on the same
/// terms: the curves were fitted on a render that already carried it.
#[derive(Clone)]
pub struct HdrMatch {
    /// The SDR fit's geometry and falloff, lifted as they were fitted (10.8.1).
    pub lens: crate::fit::Lens,
    pub colour: HdrColour,
}

/// Interleaved RGB, linear, 1.0 = diffuse white.
pub struct Plane {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f64>,
}

// ------------------------------------------------------------------ the pair

/// Box average, in f64 rather than through the 8-bit resize the rest of the crate uses:
/// routing a scene-linear plane through 8-bit sRGB left ~57 distinct levels across the
/// whole fit domain once it was normalised, and the curve fitted from that staircase was
/// visibly contrasty. Doing both sides here also means neither gets a filter the other
/// did not.
///
/// `to_f64` converts each sample on the way in, which is what keeps the decode out of
/// this in its own right: normalising a 61MP frame to diffuse white beforehand meant a
/// 1.46GB f64 copy of it, built only to be averaged down to ~1280px on the next line.
fn resample<T: Copy + Sync>(
    src: &[T],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
    to_f64: impl Fn(T) -> f64 + Sync,
) -> Vec<f64> {
    let mut out = vec![0.0f64; dw * dh * 3];
    let xs = sw as f64 / dw as f64;
    let ys = sh as f64 / dh as f64;
    out.par_chunks_mut(dw * 3).enumerate().for_each(|(dy, out_row)| {
        let y0 = (dy as f64 * ys).floor() as usize;
        let y1 = (((dy + 1) as f64 * ys).floor() as usize).max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f64 * xs).floor() as usize;
            let x1 = (((dx + 1) as f64 * xs).floor() as usize).max(x0 + 1);
            let mut acc = [0.0f64; 3];
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * sw + x) * 3;
                    for c in 0..3 {
                        acc[c] += to_f64(src[i + c]);
                    }
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f64;
            for c in 0..3 {
                out_row[dx * 3 + c] = acc[c] / n;
            }
        }
    });
    out
}

fn blur_plane(plane: &mut Plane, radius: usize) {
    if radius < 1 {
        return;
    }
    let (w, h) = (plane.width, plane.height);
    let mut tmp = vec![0.0f64; plane.data.len()];
    for _pass in 0..3 {
        for horizontal in [true, false] {
            let (span, lines) = if horizontal { (w, h) } else { (h, w) };
            for line in 0..lines {
                for i in 0..span {
                    let lo = i.saturating_sub(radius);
                    let hi = (i + radius).min(span - 1);
                    let mut acc = [0.0f64; 3];
                    for k in lo..=hi {
                        let idx = if horizontal { line * w + k } else { k * w + line } * 3;
                        let src = if horizontal { &plane.data } else { &tmp };
                        for c in 0..3 {
                            acc[c] += src[idx + c];
                        }
                    }
                    let n = (hi - lo + 1) as f64;
                    let o = if horizontal { line * w + i } else { i * w + line } * 3;
                    let dst = if horizontal { &mut tmp } else { &mut plane.data };
                    for c in 0..3 {
                        dst[o + c] = acc[c] / n;
                    }
                }
            }
        }
    }
}

fn luma(data: &[f64], i: usize) -> f64 {
    LUMA[0] * data[i] + LUMA[1] * data[i + 1] + LUMA[2] * data[i + 2]
}

// ------------------------------------------------------------------ the mask

/// Bit c is set when channel c of this pixel is usable on its own; `ALL` when all
/// three are.
///
/// The distinction is load-bearing. A per-channel curve only needs its own channel in
/// range, and requiring all three threw away most of the samples at the top of red's
/// and green's domains: in a sky it is blue that is near clipping, so every sky pixel
/// was dropped from red's curve as well. Both curves then ran out of data well below
/// the ceiling and were extrapolated from there, which tinted the upper mid-tones
/// magenta - measured at deltaA* +5.2 in the 75-89 L* band, on pixels that sit
/// *inside* the fit domain. The matrix still wants all three, being cross-channel.
const ALL: u8 = 8;

fn mask(render: &Plane, jpeg: &Plane) -> Vec<u8> {
    let (width, height) = (render.width, render.height);
    let mut out = vec![0u8; width * height];
    if width < 3 || height < 3 {
        return out;
    }
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let p = y * width + x;
            let i = p * 3;
            // A black warp margin is not scene content.
            if render.data[i] == 0.0 && render.data[i + 1] == 0.0 && render.data[i + 2] == 0.0 {
                continue;
            }

            let mut bits = 0u8;
            for c in 0..3 {
                if jpeg.data[i + c] < CAMERA_CLIPPING && render.data[i + c] < TRUST_CEILING {
                    bits |= 1 << c;
                }
            }
            if bits == 0 {
                continue;
            }
            if bits == 0b111 {
                bits |= ALL;
            }

            // Gradient on the square root of luma rather than on linear light. A
            // fixed linear threshold is not the same test at both ends - in the
            // shadows almost nothing exceeds it and in the sky almost everything
            // does - so the surviving pixels come from the dark half of the frame
            // and the curve is fitted where it has least to say.
            let at = |dx: isize, dy: isize| -> f64 {
                let yy = (y as isize + dy) as usize;
                let xx = (x as isize + dx) as usize;
                luma(&jpeg.data, (yy * width + xx) * 3).max(0.0).sqrt()
            };
            if (at(1, 0) - at(-1, 0)).abs() + (at(0, 1) - at(0, -1)).abs() > 0.03 {
                continue;
            }
            out[p] = bits;
        }
    }
    out
}

// ------------------------------------------------------------------- the model

/// Binned mean with the gaps between bins interpolated, and the highest bin the data
/// actually reached. Above that bin the curve is undefined; `extend_curves` fills it.
///
/// The mean is weighted, so a bin answers for the levels the frame holds rather than
/// for whichever colour happens to fill it (`hue_balance`). The count floor stays on
/// the pairs themselves: a bin filled by pixels the weight discounts is thin evidence,
/// not absent evidence, and dropping it would shorten the curve.
fn fit_curve(xs: &[f64], ys: &[f64], ws: &[f64], n: usize) -> (Vec<f64>, isize) {
    let mut sum = vec![0.0f64; BINS];
    let mut weight = vec![0.0f64; BINS];
    let mut count = vec![0usize; BINS];
    for i in 0..n {
        let bin = (((xs[i] / TRUST_CEILING) * (BINS - 1) as f64).round() as isize)
            .clamp(0, BINS as isize - 1) as usize;
        sum[bin] += ys[i] * ws[i];
        weight[bin] += ws[i];
        count[bin] += 1;
    }

    let mut curve = vec![0.0f64; BINS];
    let mut last: isize = -1;
    for b in 0..BINS {
        if count[b] < MIN_BIN_SAMPLES || !(weight[b] > 0.0) {
            continue;
        }
        let value = sum[b] / weight[b];
        if last < 0 {
            for k in 0..=b {
                curve[k] = value * (k as f64 / (b.max(1)) as f64);
            }
        } else {
            let lastu = last as usize;
            for k in lastu + 1..=b {
                curve[k] = curve[lastu] + (value - curve[lastu]) * (k - lastu) as f64 / (b - lastu) as f64;
            }
        }
        curve[b] = value;
        last = b as isize;
    }
    (curve, last)
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

/// Bins of overlap the gain between two channels is read over.
///
/// Not the join bin alone, which is the least trustworthy sample the channel has: it is
/// the bin that only just cleared `MIN_BIN_SAMPLES`, so it is the thinnest average in
/// the curve, and a ratio read there is carried over the whole tail. Averaged over the
/// last 16 bins the extension landed within 1.9-2.1% of the channel's own curve on a
/// replay that truncated it at render 0.18, against 3.2-4.0% from the join bin alone.
const JOIN_WINDOW: usize = 16;

/// The gain a channel ran at against the reference where both had pairs, and where its
/// extension would land holding that gain to the top of the domain.
///
/// None when the overlap says nothing, which leaves the channel to `extend_alone`.
fn join(curve: &[f64], last: usize, reference: &[f64]) -> Option<(f64, f64)> {
    let window = last.saturating_sub(JOIN_WINDOW)..=last;
    let ours: f64 = curve[window.clone()].iter().sum();
    let theirs: f64 = reference[window].iter().sum();
    if !(theirs > 0.0) {
        return None;
    }
    let gain = ours / theirs;
    Some((gain, curve[last] + (reference[BINS - 1] - reference[last]) * gain))
}

/// Fills a channel's tail: the reference's shape at the channel's own gain near the
/// join, converging on `top` - the one level every channel ends at - by the ceiling.
///
/// The reference's *steps* rather than its levels, so the extension leaves the join
/// where the channel's own data left it: anchoring on the gain instead lands the first
/// extended bin off its neighbour, and `make_monotone` turns that into a flat band of
/// crushed contrast right where the tail starts.
///
/// Converging is what makes a neutral highlight neutral. A frame's brightest region is
/// where the fit has least to go on - on DSC05469 the sky is clipped in the sensor to
/// exactly neutral and rendered by the camera as exactly neutral - and three curves
/// each holding their own gain up there is what turned that neutral green. Converged, a
/// neutral render value maps to one number whatever channel it arrived in, while a
/// pixel whose channels differ keeps every bit of that difference: it is the input that
/// carries the colour, not the curve.
///
/// `top` must be at or above every channel's held extension, and that is not a detail.
/// Let it sit below one and that channel has to *fall* to reach it, `make_monotone`
/// clamps the fall flat, and the channel ends at its own level with the others at the
/// reference's - the per-channel gain this exists to remove, reintroduced by the guard
/// against a curve that dips. Measured on DSC05469 before that: a sky reading neutral
/// off a full decode came out 13% red off a bounded one, the two decodes disagreeing
/// about which channel reached furthest.
fn extend_onto(curve: &mut [f64], last: usize, reference: &[f64], gain: f64, top: f64) {
    let span = (BINS - 1 - last).max(1) as f64;
    let climb = reference[BINS - 1] - reference[last];
    for b in last + 1..BINS {
        let held = curve[last] + (reference[b] - reference[last]) * gain;
        // The same shape taken all the way to the shared top, which is where the two
        // agree by the ceiling however far apart they start.
        let shared = match climb > 0.0 {
            true => curve[last] + (top - curve[last]) * ((reference[b] - reference[last]) / climb),
            false => top,
        };
        let converged = (b - last) as f64 / span;
        curve[b] = held * (1.0 - converged) + shared * converged;
    }
    make_monotone(curve);
}

/// Fills in each channel above the point its pairs ran out, off the channel that got
/// furthest.
///
/// Every channel extending on its own last slope is what turned this frame's sky green
/// (DSC05469), and where each one stops is close to arbitrary. That frame is bimodal:
/// 114K of its pairs sit below render 0.2, its sky sits above 0.9 and is blown in the
/// JPEG so the mask drops it for all three channels alike, and the stretch between
/// holds a few hundred pairs per tenth, most of them rejected for lying on a gradient.
/// Whether a channel's last filled bin lands at 0.18 or 0.66 is then decided by which
/// side of `MIN_BIN_SAMPLES` a hundred-odd surviving pixels fall - red kept 113 in the
/// 0.6-0.7 band where green kept 13. Three straight lines from three arbitrary places
/// diverge, and by diffuse white green was reading 2.19 against red's 1.15: a cast that
/// grows with brightness, on pixels well inside the trusted domain.
///
/// The channels agree on shape wherever they overlap - within about 5% across the
/// domain on the fixture - which is what makes borrowing it sound: what a short channel
/// is missing is reach, not a rendering of its own. Only above its own last bin, so a
/// channel keeps every pair it measured.
fn extend_curves(mut fitted: [(Vec<f64>, isize); 3]) -> [Vec<f64>; 3] {
    let furthest = (0..3).max_by_key(|c| fitted[*c].1).unwrap_or(0);
    let Ok(last) = usize::try_from(fitted[furthest].1) else {
        // No channel had a single filled bin; every curve is still zeroes.
        return fitted.map(|(curve, _)| curve);
    };
    extend_alone(&mut fitted[furthest].0, last);
    let reference = fitted[furthest].0.clone();

    // Where each channel would land holding its own gain to the ceiling, and then the
    // one level they all end on: the highest of them, so that reaching it is a climb
    // for every channel and a fall for none.
    let held: [Option<(f64, f64)>; 3] = std::array::from_fn(|c| {
        usize::try_from(fitted[c].1).ok().and_then(|last| join(&fitted[c].0, last, &reference))
    });
    let top = held
        .iter()
        .flatten()
        .map(|(_, top)| *top)
        .fold(reference[BINS - 1], f64::max);

    // The reference goes through this too, so all three end on one level rather than
    // two of them converging on a curve the third never adopted.
    for c in 0..3 {
        let Ok(last) = usize::try_from(fitted[c].1) else {
            // Not one bin of this channel ever reached `MIN_BIN_SAMPLES`, so there is no
            // shape to extend and no overlap to read a gain from. Skipped, it keeps the
            // zeroes it was initialised with and that channel renders black - a frame
            // missing its red, which is worse than any cast this file exists to remove.
            // It takes the reference outright: what a short channel lacks is reach rather
            // than a rendering of its own, and this one lacks all of it.
            fitted[c].0.copy_from_slice(&reference);
            continue;
        };
        match held[c] {
            Some((gain, _)) => extend_onto(&mut fitted[c].0, last, &reference, gain, top),
            None => extend_alone(&mut fitted[c].0, last),
        }
    }
    fitted.map(|(curve, _)| curve)
}

fn sample_curve(curve: &[f64], x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    let t = ((x / TRUST_CEILING) * (BINS - 1) as f64).min((BINS - 1) as f64);
    let lo = t.floor() as usize;
    if lo >= BINS - 1 {
        return curve[BINS - 1];
    }
    curve[lo] * (1.0 - (t - lo as f64)) + curve[lo + 1] * (t - lo as f64)
}

/// The tone stage: the camera's per-channel rendering below diffuse white, and one
/// shared gain above it.
///
/// Above the ceiling the whole pixel is scaled down until its brightest channel sits
/// at the top of the fit domain, read there, and scaled back up by the same factor.
/// So a bright orange keeps the camera's orange and only gets brighter.
///
/// Letting each channel run on its own extrapolation instead is what tinted the sky
/// magenta: the three end slopes came out 0.435 / 0.206 / 0.336, so red and blue
/// climbed at twice green's rate and the drift grew with brightness.
pub fn tone(colour: &HdrColour, r: f64, g: f64, b: f64) -> [f64; 3] {
    let s = (r.max(g).max(b) / TRUST_CEILING).max(1.0);
    [
        sample_curve(&colour.curves[0], r / s) * s,
        sample_curve(&colour.curves[1], g / s) * s,
        sample_curve(&colour.curves[2], b / s) * s,
    ]
}

/// The tone stage for one channel, valid only while every channel of the pixel is
/// below the ceiling - which is where the shared gain is 1 and the stage is
/// separable. That is almost every pixel, so a caller grading a 60MP frame builds a
/// lookup from this and takes the general path only for the highlights.
pub fn tone_channel(colour: &HdrColour, channel: usize, x: f64) -> f64 {
    sample_curve(&colour.curves[channel], x)
}

/// What happens around the grey axis, to a colour the matrix has already been through.
///
/// Separate from `finish_colour` because the grade has done that multiply itself and
/// would otherwise pay for a second one on every pixel of a 60MP frame.
pub fn finish_chroma(colour: &HdrColour, m: [f64; 3]) -> [f64; 3] {
    let Some(map) = &colour.chroma else {
        if colour.saturation == 1.0 {
            return m;
        }
        let l = LUMA[0] * m[0] + LUMA[1] * m[1] + LUMA[2] * m[2];
        return [
            l + (m[0] - l) * colour.saturation,
            l + (m[1] - l) * colour.saturation,
            l + (m[2] - l) * colour.saturation,
        ];
    };

    // The luma stays exactly where the tone stage put it. Only the offset from it moves,
    // and `d[1]` is not free: `LUMA . d` is zero by construction, so the two coordinates
    // carried through the map determine the third.
    let l = LUMA[0] * m[0] + LUMA[1] * m[1] + LUMA[2] * m[2];
    let (d0, d2) = map.correct(l, m[0] - l, m[2] - l);
    let d1 = -(LUMA[0] * d0 + LUMA[2] * d2) / LUMA[1];
    [l + d0, l + d1, l + d2]
}

/// Everything after the tone stage: the matrix, then what happens around the grey axis.
pub fn finish_colour(colour: &HdrColour, r: f64, g: f64, b: f64) -> [f64; 3] {
    finish_chroma(colour, apply3(&colour.matrix, r, g, b))
}

impl HdrColour {
    /// A transform that returns its input.
    ///
    /// A fit always produces a real one; this is for the self-test and the tests, both of
    /// which need a known-good transform rather than a fitted one.
    pub fn identity() -> Self {
        let ramp: Vec<f64> =
            (0..BINS).map(|i| (i as f64 / (BINS - 1) as f64) * TRUST_CEILING).collect();
        HdrColour {
            curves: [ramp.clone(), ramp.clone(), ramp],
            matrix: IDENTITY,
            saturation: 1.0,
            chroma: None,
            delta_e: 0.0,
        }
    }
}

pub fn apply_hdr_colour(colour: &HdrColour, r: f64, g: f64, b: f64) -> [f64; 3] {
    let v = tone(colour, r, g, b);
    finish_colour(colour, v[0], v[1], v[2])
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

/// deltaE76 wants 8-bit sRGB, which is also the only space the two fits report in
/// comparably. Values above diffuse white have nowhere to go in it, but the mask has
/// already excluded those.
/// Rec.2020 linear to sRGB linear - the primaries conversion, and nothing else.
///
/// A fixed 3x3, because the two share a white point and so there is no chromatic
/// adaptation in it. This is what `zscale`'s `pin=bt2020 ... p=bt709` was doing for the
/// SDR still (sRGB and BT.709 have the same primaries and differ only in transfer), and
/// it is here rather than there so the still's encode can stay in this process.
///
/// Returned rather than applied, so a caller converting a whole frame builds it once:
/// this used to be multiplied out per pixel inside the fit's measurement loop.
pub fn rec2020_to_srgb() -> [[f64; 3]; 3] {
    multiply(&XYZ_TO_SRGB, &REC2020_TO_XYZ)
}

/// The transfer LibRaw's 8-bit path applies, for a render meant to match one of those.
///
/// dcraw's `gamma_curve(gamm[0], gamm[1], ..)` at LibRaw's defaults - 1/2.222 over a
/// slope of 4.5 - whose bisection converges on the BT.709 constants written out here.
///
/// Not to be confused with `srgb_oetf` below, and the distinction is the whole point:
/// the *measurement* wants sRGB, because a deltaE against an 8-bit JPEG is defined
/// there, while the geometry *render* is trying to look like something LibRaw made.
fn bt709_oetf(value: f64) -> f64 {
    let c = value.clamp(0.0, 1.0);
    if c < 0.018 { 4.5 * c } else { 1.099 * c.powf(0.45) - 0.099 }
}

/// The sRGB transfer, IEC 61966-2-1. Out-of-gamut values clamp, which is what zimg does
/// with them too - neither of us is gamut-mapping, just refusing to encode a negative.
pub fn srgb_oetf(value: f64) -> f64 {
    let c = value.clamp(0.0, 1.0);
    if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

fn to_srgb8(to_srgb: &[[f64; 3]; 3], r: f64, g: f64, b: f64) -> [f64; 3] {
    // Back to sRGB primaries first; the fit works in Rec.2020.
    let v = apply3(to_srgb, r, g, b);
    [0, 1, 2].map(|c| (255.0 * srgb_oetf(v[c])).round())
}

/// The linear values at which the 8-bit level steps, so quantising to a level is a
/// search rather than a transfer.
///
/// `(255 * oetf(v)).round()` lands on `k` exactly while `255 * oetf(v)` sits in
/// `[k - 0.5, k + 0.5)`, so the step between `k - 1` and `k` is near the linear value the
/// transfer sends to `k - 0.5`. Those 255 values are constants, and finding a place among
/// them costs a lookup and a step or two where the transfer costs a `powf` - which, three
/// per pair per probe over the dozens of probes a fit makes, was its largest remaining
/// arithmetic.
///
/// Near, not at: `oetf` and its inverse do not round-trip exactly, so the analytic edge
/// can sit a bit either side of where the transfer actually steps, and a level out by one
/// is a different measurement. Each edge is walked to the first f64 the transfer really
/// sends to `k`, which makes the table agree with what it replaces by construction
/// rather than by argument - at edge 241 the analytic value is on the wrong side.
fn srgb_edges() -> [f64; 255] {
    std::array::from_fn(|i| {
        let level = i as f64 + 1.0;
        let c = (i as f64 + 0.5) / 255.0;
        let mut v = if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) };
        let reaches = |v: f64| (255.0 * srgb_oetf(v)).round() >= level;
        // Bounded: a handful of steps in practice, and a bound rather than `while true`
        // so a transfer that stopped being monotone could not hang the fit.
        for _ in 0..64 {
            if !reaches(v) {
                break;
            }
            v = f64::from_bits(v.to_bits() - 1);
        }
        for _ in 0..64 {
            if reaches(v) {
                break;
            }
            v = f64::from_bits(v.to_bits() + 1);
        }
        v
    })
}

/// The guess table `to_levels` starts from, indexed by the top bits of the value itself.
///
/// A float's bit pattern is monotone in the float for positives, so the top bits are an
/// index that needs a shift where a square root of it needed `sqrtsd` - and the shadows
/// still get the resolution, since those bits are exponent first. A bucket spans about
/// 0.4% of a value either way, which is under one level everywhere, and the walk in
/// `to_levels` covers the rest. Any monotone index would do here: the walk is what makes
/// the answer right, the table only decides how far it has to go.
const LEVEL_SHIFT: u32 = 44;
const LEVEL_GUESSES: usize = (1.0f64.to_bits() >> LEVEL_SHIFT) as usize + 1;

fn level_guesses(edges: &[f64; 255]) -> Vec<u8> {
    (0..LEVEL_GUESSES)
        .map(|i| {
            let v = f64::from_bits((i as u64) << LEVEL_SHIFT);
            edges.partition_point(|e| *e <= v) as u8
        })
        .collect()
}

fn to_levels(
    to_srgb: &[[f64; 3]; 3],
    edges: &[f64; 255],
    guesses: &[u8],
    r: f64,
    g: f64,
    b: f64,
) -> [u8; 3] {
    let v = apply3(to_srgb, r, g, b);
    [0, 1, 2].map(|c| {
        // Bounded for the reason `srgb_oetf` clamps: out of gamut is refused rather than
        // encoded, and there is nothing to say about a level outside the range. Written
        // as a test on the value rather than `clamp` so that negative zero - which the
        // matrix does produce, and which `clamp` passes through unchanged - lands on
        // positive zero. Indexing on its bits otherwise reads far past the table.
        let value = if v[c] > 0.0 { v[c].min(1.0) } else { 0.0 };
        // A guess, then walked to the answer. Bisecting the 255 edges instead is eight
        // unpredictable branches per channel and the guess is almost always already
        // right, so this is a shift and a lookup where that was two dozen mispredictions
        // per pair.
        let mut level = guesses[(value.to_bits() >> LEVEL_SHIFT) as usize];
        while level > 0 && edges[level as usize - 1] > value {
            level -= 1;
        }
        while level < 255 && edges[level as usize] <= value {
            level += 1;
        }
        level
    })
}

/// The camera's rendering as the fit will compare against it, and the weights and pair
/// list every comparison uses, worked out once.
///
/// The fit measures itself about seventy times over - six ridge candidates at each of
/// three rounds, then the saturation sweep and its refinement, for each of the two
/// models - and none of this changes between them. Recomputed inside the loop it was
/// most of the cost of the fit: the sRGB target
/// alone is three `powf`s per pixel, and `rec2020_to_srgb` was being rebuilt, a pair of
/// 3x3 multiplies, once per pixel per pass.
struct Pairs {
    at: Vec<usize>,
    /// The camera's rendering as Lab, not as levels. Every probe compares against it and
    /// none of them move it, where `delta_e76` re-derived it each time - three `powf` and
    /// three `cbrt` per pair per pass, for an answer that was the same every pass.
    target: Vec<[f64; 3]>,
    balance: Vec<f64>,
    to_srgb: [[f64; 3]; 3],
    /// 8-bit level to linear light, so the transfer's `powf` is paid 256 times rather
    /// than three times per pair. `fit.rs` builds this for the SDR fit for the same
    /// reason; this is that table.
    levels: [f64; 256],
    edges: [f64; 255],
    guesses: Vec<u8>,
    /// The pairs the camera renders neutral, and what it renders them as. Which pixels
    /// those are is a fact about the camera's output, so it does not change as the fit
    /// moves underneath it, and neither does the sum being matched.
    greys: Vec<usize>,
    grey_target: [f64; 3],
}

impl Pairs {
    fn new(jpeg: &Plane, bits: &[u8], balance: &[f64]) -> Pairs {
        let to_srgb = rec2020_to_srgb();
        let at: Vec<usize> = (0..bits.len()).filter(|p| bits[*p] & ALL != 0).collect();

        let mut greys = Vec::new();
        let mut grey_target = [0.0f64; 3];
        for p in at.iter().copied() {
            let i = p * 3;
            let t = [jpeg.data[i], jpeg.data[i + 1], jpeg.data[i + 2]];
            let high = t[0].max(t[1]).max(t[2]);
            if !(high > 0.02) || (high - t[0].min(t[1]).min(t[2])) / high >= GREY_CHROMA {
                continue;
            }
            greys.push(p);
            for c in 0..3 {
                grey_target[c] += t[c];
            }
        }

        let levels = crate::fit::linear_table();
        let edges = srgb_edges();
        Pairs {
            // Across cores, and `collect` on an indexed parallel iterator keeps the
            // order, so which thread built an entry cannot change what is in it.
            target: at
                .par_iter()
                .map(|p| {
                    let v = to_srgb8(&to_srgb, jpeg.data[p * 3], jpeg.data[p * 3 + 1], jpeg.data[p * 3 + 2]);
                    crate::fit::lab_from_levels(&levels, v[0] as u8, v[1] as u8, v[2] as u8)
                })
                .collect(),
            balance: at.iter().map(|p| balance[*p]).collect(),
            at,
            to_srgb,
            levels,
            edges,
            guesses: level_guesses(&edges),
            greys,
            grey_target,
        }
    }
}

/// The mean deltaE the given colour makes on the pairs, hue-balanced and flat.
///
/// Takes the colour a pair comes out as rather than working it out, because most of what
/// produces that colour does not change between probes and the caller knows which part
/// does. A ridge candidate moves only the matrix, so the tone stage above it is the same
/// for all six; a saturation probe moves only the blend, so the matrix below it is the
/// same for all thirty. Recomputed per probe they were the fit's two most expensive
/// stages by a wide margin.
fn score(pairs: &Pairs, colour_of: impl Fn(usize) -> [f64; 3] + Sync) -> (f64, f64) {
    score_many(pairs, 1, |_, k| colour_of(k))[0]
}

/// Several probes at once, which is how the stages that have several want to ask.
///
/// A probe's answer does not depend on how many it was asked with: each is summed over
/// the same fixed blocks in the same order. That matters twice - floating point addition
/// is not associative, so a reduction whose shape follows rayon's scheduling would give
/// a different fit run to run, and the graded output is pinned by hash.
///
/// Asked one probe at a time, a frame's 47 blocks over six threads leaves most of them
/// idle in the last round, and the fit only reached 4.2x on six cores. Asked twenty at a
/// time there is always work to steal. The block size cannot be shrunk to fix that
/// instead: it is part of the summation order, so it is part of the answer.
fn score_many(
    pairs: &Pairs,
    probes: usize,
    colour_of: impl Fn(usize, usize) -> [f64; 3] + Sync,
) -> Vec<(f64, f64)> {
    let blocks = pairs.at.len().div_ceil(MEASURE_BLOCK);
    let partial: Vec<(f64, f64, f64)> = (0..probes * blocks)
        .into_par_iter()
        .map(|unit| {
            let (probe, block) = (unit / blocks, unit % blocks);
            let start = block * MEASURE_BLOCK;
            let end = (start + MEASURE_BLOCK).min(pairs.at.len());
            let mut sums = (0.0, 0.0, 0.0f64);
            for k in start..end {
                let v = colour_of(probe, k);
                let a = to_levels(&pairs.to_srgb, &pairs.edges, &pairs.guesses, v[0], v[1], v[2]);
                let ours = crate::fit::lab_from_levels(&pairs.levels, a[0], a[1], a[2]);
                let t = &pairs.target[k];
                let e = ((ours[0] - t[0]).powi(2) + (ours[1] - t[1]).powi(2)
                    + (ours[2] - t[2]).powi(2))
                .sqrt();
                sums.0 += pairs.balance[k] * e;
                sums.1 += e;
                sums.2 += pairs.balance[k];
            }
            sums
        })
        .collect();

    (0..probes)
        .map(|probe| {
            let (mut balanced, mut flat, mut n) = (0.0, 0.0, 0.0f64);
            for (a, b, w) in &partial[probe * blocks..(probe + 1) * blocks] {
                balanced += a;
                flat += b;
                n += w;
            }
            (balanced / n.max(1e-9), flat / (pairs.at.len() as f64).max(1.0))
        })
        .collect()
}

/// The mean deltaE over the pairs, hue-balanced and flat.
///
/// Both, because the two answer different questions - what the camera does, and what
/// the picture will look like - the stages here disagree about which one they are
/// asking, and the one that wants both wants them for the same matrix. Separately it
/// was two passes to save one multiply-add.
fn measure(colour: &HdrColour, render: &Plane, pairs: &Pairs) -> (f64, f64) {
    score(pairs, |k| {
        let i = pairs.at[k] * 3;
        apply_hdr_colour(colour, render.data[i], render.data[i + 1], render.data[i + 2])
    })
}

/// Pixels per block. Large enough that the per-block overhead is nothing beside the work,
/// small enough to keep every core fed on a small frame.
const MEASURE_BLOCK: usize = 4096;

/// Hues the frame is divided into before its pairs are counted, plus one bucket for
/// everything too close to grey to have a hue at all.
const HUE_BINS: usize = 12;

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

/// Everything a weighted least squares needs from a set of pairs, and nothing that
/// scales with how many there were.
#[derive(Default, Clone)]
struct Moments {
    ata: [[f64; 3]; 3],
    atb: [[f64; 3]; 3],
}

impl Moments {
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

/// How much worse a candidate may leave the frame as a whole, against the best any
/// candidate manages, before its damping is refused however well it serves a subject.
///
/// This is the veto that stops "serve the minority hue" becoming "wreck the picture".
/// IMG_9808 is why it exists: sky and snow, no colour spread anywhere in it to pin nine
/// parameters down, and the least damped candidate came back with a blue row of
/// `[-0.285, -0.334, 1.619]` - off-diagonals an order of magnitude past what damping
/// leaves. Weighted by hue that matrix looks like an improvement, since it is serving the
/// frame's few coloured pixels, while the hillside renders acid yellow-green and the
/// frame's own deltaE doubles.
const FRAME_VETO: f64 = 1.03;

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
/// So the frame chooses, on two scores rather than one. Which candidate is *best* is
/// asked with the same hue balance the fit uses, because that is the question the
/// balance exists to ask - an even score lets 120k pairs of lawn outvote 16k of dog and
/// picks the ridge that suits grass. Which candidates are *allowed* is asked evenly,
/// because that question is about the whole picture and a picture is seen by area.
///
/// The residual the solve itself minimises was tried for this and is close to useless:
/// it is the quantity every candidate is optimising, in a space where a wild matrix
/// looks fine, and on a near-neutral frame all of them score it identically to the last
/// bit so the choice fell to list order.
fn fitted_matrix(
    whole: &Moments,
    scored: impl Fn(&[[[f64; 3]; 3]]) -> Vec<(f64, f64)>,
) -> [[f64; 3]; 3] {
    if !(whole.trace() > 0.0) {
        return whole.solve(MATRIX_RIDGE);
    }
    let matrices: Vec<[[f64; 3]; 3]> = RIDGE_CANDIDATES.iter().map(|r| whole.solve(*r)).collect();
    let tried: Vec<([[f64; 3]; 3], f64, f64)> = matrices
        .iter()
        .zip(scored(&matrices))
        .map(|(matrix, (balanced, evenly))| (*matrix, balanced, evenly))
        .collect();

    let floor = tried.iter().map(|(_, _, even)| *even).fold(f64::MAX, f64::min);
    let mut best: Option<(&[[f64; 3]; 3], f64)> = None;
    for (matrix, balanced_score, even_score) in &tried {
        // Both tests written to reject rather than to accept, so a score that is not a
        // number falls out here instead of passing a comparison that is false either
        // way - which would let it latch as the winner and refuse every candidate after
        // it. Nothing reachable produces one today; `to_levels` clamps its input, so the
        // deltaE is finite even for a wild matrix.
        if !(*even_score <= floor * FRAME_VETO) || !balanced_score.is_finite() {
            continue;
        }
        // Strictly better, and the candidates run most damped first, so a frame that
        // cannot tell them apart keeps the safe end rather than whichever came first.
        if best.is_none_or(|(_, score)| *balanced_score < score) {
            best = Some((matrix, *balanced_score));
        }
    }
    *best.map_or(&tried[0].0, |(matrix, _)| matrix)
}

fn hue_bucket(jpeg: &Plane, i: usize) -> usize {
    let (r, g, b) = (jpeg.data[i], jpeg.data[i + 1], jpeg.data[i + 2]);
    let (high, low) = (r.max(g).max(b), r.min(g).min(b));
    if !(high > 0.0) || (high - low) / high < 0.1 {
        return HUE_BINS;
    }
    // Sixths of the hue circle, subdivided: enough to separate foliage from skin from
    // sky, few enough that a bin holds a real population.
    let span = high - low;
    let sixth = if r >= g && r >= b {
        (g - b) / span
    } else if g >= b {
        2.0 + (b - r) / span
    } else {
        4.0 + (r - g) / span
    };
    let turns = (sixth + 6.0) % 6.0 / 6.0;
    ((turns * HUE_BINS as f64) as usize).min(HUE_BINS - 1)
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
/// So a pair counts for the reciprocal of how common its hue is. The grass still shapes
/// the fit where the fit is about grass; it no longer shapes what happens to a dog.
/// Hue is taken from the camera's rendering rather than the render, since that is the
/// thing being matched, and low-chroma pixels share one bucket because a hue angle
/// measured on a grey is noise.
fn hue_balance(jpeg: &Plane, bits: &[u8]) -> Vec<f64> {
    let bucket = |i: usize| hue_bucket(jpeg, i);

    let mut counted = vec![0usize; HUE_BINS + 1];
    let mut total = 0usize;
    for p in 0..bits.len() {
        if bits[p] & ALL == 0 {
            continue;
        }
        counted[bucket(p * 3)] += 1;
        total += 1;
    }

    let occupied = counted.iter().filter(|n| **n > 0).count().max(1);
    let parity = total as f64 / occupied as f64;
    let weights: Vec<f64> = counted
        .iter()
        .map(|n| match *n {
            // Counted over pairs usable for all three channels, but read back per
            // channel by `fit_curves`, where a pixel needs only its own channel in
            // range. A hue that shows up only on such pixels is censused at zero, and
            // weighting it zero drops it from that channel's curve entirely rather than
            // merely declining to favour it - which is the opposite of what the
            // per-channel mask is for. Unseen means unknown here, so it counts as one.
            0 => 1.0,
            n => (parity / n as f64).clamp(1.0 / BALANCE_LIMIT, BALANCE_LIMIT),
        })
        .collect();

    (0..bits.len()).map(|p| weights[bucket(p * 3)]).collect()
}

/// How many times the curves and the matrix are fitted against each other.
///
/// Three, matching the falloff's alternation in `fit.rs`: the second round is where the
/// cross-channel part moves out of the curves and into the matrix, and the third
/// settles it.
const FIT_ROUNDS: usize = 3;

/// The three per-channel curves.
///
/// `inverse` undoes the matrix from the camera's rendering first, so what the curves
/// are asked to reproduce is only the part a per-channel curve can: on the first round
/// there is no matrix yet and the target is the rendering itself.
fn fit_curves(
    render: &Plane,
    jpeg: &Plane,
    bits: &[u8],
    balance: &[f64],
    inverse: Option<&[[f64; 3]; 3]>,
) -> [Vec<f64>; 3] {
    let target = |i: usize| -> [f64; 3] {
        let v = [jpeg.data[i], jpeg.data[i + 1], jpeg.data[i + 2]];
        match inverse {
            None => v,
            // Clamped, because inverting a matrix out of a colour near the edge of what
            // the camera can print can ask for a negative amount of a channel.
            Some(m) => apply3(m, v[0], v[1], v[2]).map(|c| c.max(0.0)),
        }
    };

    // A channel at a time, and nothing ties them together, so the three fit at once. Each
    // builds and sums only its own pairs.
    let mut done: Vec<(Vec<f64>, isize)> = (0..3usize)
        .into_par_iter()
        .map(|c| {
            let mut xs = vec![0.0f64; bits.len()];
            let mut ys = vec![0.0f64; bits.len()];
            let mut ws = vec![0.0f64; bits.len()];
            let mut k = 0usize;
            for p in 0..bits.len() {
                if bits[p] & (1 << c) == 0 {
                    continue;
                }
                xs[k] = render.data[p * 3 + c];
                ys[k] = target(p * 3)[c];
                ws[k] = balance[p];
                k += 1;
            }
            fit_curve(&xs, &ys, &ws, k)
        })
        .collect();
    extend_curves([done.remove(0), done.remove(0), done.remove(0)])
}


/// How close to grey the camera has to render a pixel for it to count as neutral, and
/// how many such pixels are needed before their average is worth acting on.
const GREY_CHROMA: f64 = 0.06;
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
fn grey_balance(colour: &mut HdrColour, render: &Plane, pairs: &Pairs) {
    if (pairs.greys.len() as u64) < MIN_GREY {
        return;
    }
    let mut ours = [0.0f64; 3];
    for p in pairs.greys.iter().copied() {
        let i = p * 3;
        let v = apply_hdr_colour(colour, render.data[i], render.data[i + 1], render.data[i + 2]);
        for c in 0..3 {
            ours[c] += v[c];
        }
    }
    for c in 0..3 {
        let gain = (pairs.grey_target[c] / ours[c].max(1e-9)).clamp(0.9, 1.1);
        for level in colour.curves[c].iter_mut() {
            *level *= gain;
        }
    }
}

/// The matrix for the tone stage a colour currently carries.
fn fitted_matrix_for(
    colour: &HdrColour,
    render: &Plane,
    jpeg: &Plane,
    balance: &[f64],
    pairs: &Pairs,
) -> [[f64; 3]; 3] {
    // Blocked and summed in order, for the reason `score` is. The tone stage is kept
    // rather than recomputed: the candidates below differ only in their matrix, which
    // sits after it, so all six would otherwise sample the same three curves again.
    let mut toned = vec![[0.0f64; 3]; pairs.at.len()];
    let blocks: Vec<Moments> = toned
        .par_chunks_mut(MEASURE_BLOCK)
        .zip(pairs.at.par_chunks(MEASURE_BLOCK))
        .map(|(out, chunk)| {
            let mut moments = Moments::default();
            for (slot, p) in out.iter_mut().zip(chunk.iter().copied()) {
                let i = p * 3;
                let v = tone(colour, render.data[i], render.data[i + 1], render.data[i + 2]);
                let w = balance[p] / (luma(&jpeg.data, i).cbrt().powi(2) + 1e-3);
                moments.add(w, &v, &jpeg.data[i..i + 3]);
                *slot = v;
            }
            moments
        })
        .collect();

    let mut moments = Moments::default();
    for block in &blocks {
        for a in 0..3 {
            for b in 0..3 {
                moments.ata[a][b] += block.ata[a][b];
                moments.atb[a][b] += block.atb[a][b];
            }
        }
    }
    fitted_matrix(&moments, |candidates| {
        let trials: Vec<HdrColour> = candidates
            .iter()
            .map(|matrix| HdrColour { matrix: *matrix, ..colour.clone() })
            .collect();
        score_many(pairs, trials.len(), |probe, k| {
            finish_colour(&trials[probe], toned[k][0], toned[k][1], toned[k][2])
        })
    })
}

/// A 3x3 inverse, by solving the matrix against each basis vector. None when singular.
fn invert3(m: &[[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
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
/// The sweep is fine enough to land in the right dip of a staircase whose treads are
/// hundredths wide, and coarse enough to stay cheap - each step is a pass over every
/// pair. The margin is an order above the tread the measurement showed, and two below
/// the difference a saturation that matters makes.
const SATURATION_SWEEP: usize = 18;
const NEUTRAL_MARGIN: f64 = 0.02;

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
/// A plain golden section over the whole range is wrong here twice over, and both were
/// measured rather than reasoned about. The objective is *not* unimodal: it goes through
/// `srgb_oetf` and then a round to 8 bits, so it is a staircase, and on a near-neutral
/// ramp a 0.01 sweep dips at 0.60, climbs to 0.74, dips again at 0.76 and again at 1.26.
/// Golden section walked into the wrong dip and returned 0.805 where the sweep's best is
/// 0.60. Worse, where every step of that round lands in the same place the objective is
/// *flat*, every comparison ties, and a bisection that discards a half on a tie walks to
/// whichever end it favours: an achromatic frame - fog, snow, overcast - came back with
/// 1.499, a 1.5x chroma boost, applied at full resolution to a frame that is not
/// achromatic once it is off the blurred 640px grid this was measured on.
///
/// So the sweep finds which dip to be in, the section refines inside it, and neutral is
/// the answer unless something clearly beats it. `NEUTRAL_MARGIN` is what "clearly"
/// means: below it the difference is the staircase's own tread rather than a fact about
/// the camera, and a real one is nowhere near that small - IMG_9808 moves deltaE by
/// about 2 between its fitted saturation and 1.0.
fn fitted_saturation(colour: &HdrColour, render: &Plane, pairs: &Pairs) -> f64 {
    // Everything under the blend, once. This scalar is the last stage of the transform
    // and the probes below move nothing else, so the curves and the matrix would
    // otherwise be recomputed thirty times over for a result identical every time. The
    // luma travels with it because it is what the blend is about.
    let below: Vec<([f64; 3], f64)> = pairs
        .at
        .par_iter()
        .map(|p| {
            let i = p * 3;
            let v = tone(colour, render.data[i], render.data[i + 1], render.data[i + 2]);
            let m = apply3(&colour.matrix, v[0], v[1], v[2]);
            (m, LUMA[0] * m[0] + LUMA[1] * m[1] + LUMA[2] * m[2])
        })
        .collect();

    let blend = |saturation: f64, k: usize| {
        let (m, l) = below[k];
        // The same short circuit `finish_colour` takes, and it has to be here too:
        // `l + (m - l) * 1.0` is not bit-identical to `m`, the neutral guard below
        // returns exactly 1.0 often, and the graded output is pinned by hash.
        match saturation == 1.0 {
            true => m,
            false => [0, 1, 2].map(|c| l + (m[c] - l) * saturation),
        }
    };
    let scored = |saturation: f64| score(pairs, |k| blend(saturation, k)).1;
    let (low, high) = SATURATION_RANGE;

    // Neutral first, then the sweep, all in one parallel job: they do not depend on each
    // other, and asked one at a time they leave most of the machine idle.
    let probes: Vec<f64> = std::iter::once(1.0)
        .chain((0..=SATURATION_SWEEP).map(|step| low + (high - low) * step as f64 / SATURATION_SWEEP as f64))
        .collect();
    let swept = score_many(pairs, probes.len(), |probe, k| blend(probes[probe], k));

    let (mut at, mut best) = (1.0, swept[0].1);
    for (probe, (_, here)) in probes.iter().zip(&swept).skip(1) {
        // Strictly better, so a flat objective keeps the neutral this started from
        // instead of sliding to whichever end the comparisons happen to favour.
        if *here < best {
            (at, best) = (*probe, *here);
        }
    }

    let coarse = (high - low) / SATURATION_SWEEP as f64;
    let (mut lo, mut hi) = ((at - coarse).max(low), (at + coarse).min(high));
    const INVERSE_PHI: f64 = 0.618_033_988_749_895;
    let (mut c, mut d) = (hi - (hi - lo) * INVERSE_PHI, lo + (hi - lo) * INVERSE_PHI);
    let (mut fc, mut fd) = (scored(c), scored(d));
    while hi - lo > SATURATION_RESOLUTION {
        if fc < fd {
            (hi, d, fd) = (d, c, fc);
            c = hi - (hi - lo) * INVERSE_PHI;
            fc = scored(c);
        } else {
            (lo, c, fc) = (c, d, fd);
            d = lo + (hi - lo) * INVERSE_PHI;
            fd = scored(d);
        }
    }

    // `swept[0]` is neutral, probed at the top and not probed again here.
    let found = (lo + hi) / 2.0;
    match scored(found) + NEUTRAL_MARGIN < swept[0].1 {
        true => found,
        false => 1.0,
    }
}

/// Pairs a node needs before it is trusted on its own rather than on the frame's.
///
/// Not a threshold but a half-way point: a node with this many pairs keeps half of what
/// it measured and takes half of the global answer, and one with none keeps none. So a
/// frame with colour everywhere gets a map that follows it, and a frame of snow and sky
/// gets back the single scalar this generalises, without a cliff between them.
const MAP_CONFIDENCE: f64 = 400.0;

/// How much a colour may be pulled away from its neighbours before the map is damped,
/// on the grey axis and at the edge of the grid.
///
/// `ChromaMap::strain` measures what the map does to the difference between two nearly
/// identical pixels, against these. Above them it is sharpening colour noise, which is
/// what the per-hue gain did to a dog's fur, so the whole map is shrunk until it is
/// under. Near neutral the allowance is tight because that is where speckle is seen at
/// all; out at the saturated edge it is loose because that is where the corrections that
/// matter live and where the eye is least able to call one wrong.
const MAP_AMP_NEUTRAL: f64 = 1.05;
const MAP_AMP_SATURATED: f64 = 1.45;

/// How far a sharp sample may sit from its own blurred mean and still count as flat.
///
/// In the planes' own units, where diffuse white is 1. Loose enough that sensor noise and
/// the camera's own denoising do not disqualify an even surface, tight enough that a
/// pixel anywhere near an edge is taken from the blurred plane, where misregistration
/// cannot turn one side of the edge into the other's colour.
const FLAT_ENOUGH: f64 = 0.02;

/// The furthest the de-attenuation may rescale a node, either way.
///
/// A node whose pairs are nearly grey has almost no chroma to compare the length of, so
/// the ratio it asks for is noise over noise. Bounded, such a node keeps roughly the
/// length least squares gave it and the shrinkage below decides the rest.
const MAP_MAX_GAIN: f64 = 2.0;

/// Damping on each node's own least squares, relative to its own scale.
const MAP_RIDGE: f64 = 0.05;

/// How much chroma the camera has to give a pixel before the wide pass looks at it.
///
/// Roughly a third of the way to the first node out from grey, so a colour with any real
/// hue to it counts while the frame's neutrals - most of every frame, and already the
/// best-served part of the map - do not.
const WIDE_MIN_CHROMA: f64 = 0.03;

/// What one pass over some pixels tells the chroma map, per node.
struct ChromaMoments {
    /// The 2x2 normal equations for `M . ours = theirs`.
    ata: Vec<[[f64; 2]; 2]>,
    atb: Vec<[[f64; 2]; 2]>,
    /// The camera's own chroma, squared: what the map's output is scaled to match.
    btb: Vec<f64>,
    /// How much landed here.
    seen: Vec<f64>,
}

impl Default for ChromaMoments {
    fn default() -> Self {
        let nodes = MAP_CHROMA * MAP_CHROMA * MAP_LEVEL;
        ChromaMoments {
            ata: vec![[[0.0; 2]; 2]; nodes],
            atb: vec![[[0.0; 2]; 2]; nodes],
            btb: vec![0.0; nodes],
            seen: vec![0.0; nodes],
        }
    }
}

/// The chroma correction, fitted per node from the pairs that land near it.
///
/// This is the stage that gives the model a hue axis. Until it existed the only way to
/// say "the camera treats grass differently from a brown" was to bend a per-channel tone
/// curve, which is indexed by a channel's value and cannot tell grass from a grey of the
/// same green - so the correction meant for the lawn landed on every neutral at that
/// level, the wash across a white bird bath and pale fur that used to need the three tone
/// curves held to one shape to suppress, and that constraint then wrecked any frame whose
/// channels really do render differently.
///
/// Solved rather than searched: with the nodes fixed and the interpolation linear in
/// them, matching our chroma to the camera's is a weighted least squares per node.
fn fitted_chroma(
    colour: &HdrColour,
    render: &Plane,
    jpeg: &Plane,
    sharp: &Sharp,
    pairs: &Pairs,
    saturation: f64,
) -> Option<ChromaMap> {
    const NODES: usize = MAP_CHROMA * MAP_CHROMA * MAP_LEVEL;
    let ChromaMoments { mut ata, mut atb, mut btb, mut seen } = ChromaMoments::default();

    for (k, p) in pairs.at.iter().enumerate() {
        let i = p * 3;
        // Sharp where the neighbourhood is flat, blurred where it is not. The blurred
        // plane is the local mean, so the gap between them is already a measure of how
        // much is going on around a pixel - no second pass needed to find out.
        //
        // This is what a small saturated object needs. Blur mixes it with whatever
        // surrounds it, so the blue pot arrives at the fit desaturated and contributing
        // 0.3% of the pairs, and the map has nothing to learn a blue from. Its interior
        // is flat, so it keeps its own colour here.
        let flat = |a: &Plane, b: &Plane| {
            (0..3).all(|c| (a.data[i + c] - b.data[i + c]).abs() <= FLAT_ENOUGH)
        };
        let take = |a: &Plane, b: &Plane| -> [f64; 3] {
            let from = if flat(a, b) { a } else { b };
            [from.data[i], from.data[i + 1], from.data[i + 2]]
        };
        let source = take(&sharp.render, render);
        let toned = tone(colour, source[0], source[1], source[2]);
        let m = apply3(&colour.matrix, toned[0], toned[1], toned[2]);
        let t = take(&sharp.jpeg, jpeg);

        let ours = LUMA[0] * m[0] + LUMA[1] * m[1] + LUMA[2] * m[2];
        let theirs = LUMA[0] * t[0] + LUMA[1] * t[1] + LUMA[2] * t[2];
        let (d0, d2) = (m[0] - ours, m[2] - ours);
        // The camera's chroma, about the camera's own luma. Lightness is the tone
        // stage's business and this must not carry any of it.
        let (e0, e2) = (t[0] - theirs, t[2] - theirs);

        let w = pairs.balance[k];
        let (at, weight) = ChromaMap::nodes_for(ours, d0, d2);
        for (node, share) in at.into_iter().zip(weight) {
            let sw = w * share;
            if sw <= 0.0 {
                continue;
            }
            let input = [d0, d2];
            let target = [e0, e2];
            for a in 0..2 {
                for b in 0..2 {
                    ata[node][a][b] += sw * input[a] * input[b];
                    atb[node][a][b] += sw * input[b] * target[a];
                }
            }
            btb[node] += sw * (e0 * e0 + e2 * e2);
            seen[node] += sw;
        }
    }

    // And the same again over the wide planes, for the colours the fit grid cannot hold.
    // A small saturated object is mostly edge at 640 and mostly interior at 1280, and the
    // fit is only ever as good as whether it saw the colour at all: the blue pot puts
    // nine pairs into the loop above, out of 189,330.
    let wide = &sharp.wide_render;
    let target = &sharp.wide_jpeg;
    // Debug-asserted rather than merely skipped. Two planes of different sizes cannot be
    // paired, but a caller that lands them that way has a bug and silence let one live:
    // an SDR render asked for a long edge where a width was meant arrived at 571x855
    // against an 855x1280 preview, and this pass did nothing on every portrait frame.
    debug_assert_eq!(
        (wide.width, wide.height),
        (target.width, target.height),
        "the wide planes must share a grid to be paired",
    );
    if wide.width == target.width && wide.height == target.height {
        // A row at a time across cores, then summed back in row order. Reduced in
        // whatever order the threads finished, a node's moments would differ run to run
        // in the last bits and a frame sitting on a near-tie would fit two ways.
        let (cx, cy) = (wide.width as f64 / 2.0, wide.height as f64 / 2.0);
        let half = (cx * cx + cy * cy).sqrt().max(1.0);
        let rows: Vec<ChromaMoments> = (1..wide.height.saturating_sub(1))
            .into_par_iter()
            .map(|y| {
                let mut row = ChromaMoments::default();
                for x in 1..wide.width - 1 {
                    let p = y * wide.width + x;
                    let i = p * 3;
                    let t = [target.data[i], target.data[i + 1], target.data[i + 2]];
                    // Clipped says nothing, exactly as `mask` has it.
                    if t[0].max(t[1]).max(t[2]) >= CAMERA_CLIPPING {
                        continue;
                    }
                    // Only the colours this pass exists for. A near-neutral costs the
                    // same neighbour test as a saturated one and tells the map nothing:
                    // the frame's greys already fill those nodes from the pairs, and
                    // there are four wide pixels for every pair, so letting them in would
                    // refit the neutral nodes off this pass instead of supplementing it.
                    let theirs = LUMA[0] * t[0] + LUMA[1] * t[1] + LUMA[2] * t[2];
                    if (t[0] - theirs).abs().max((t[2] - theirs).abs()) < WIDE_MIN_CHROMA {
                        continue;
                    }
                    // Flat in both, judged against the neighbours rather than a blurred
                    // copy - there is no blurred copy at this size, and building one
                    // would cost more than the four differences do. Read before the
                    // falloff, which is smooth enough to be the same number across three
                    // pixels and so cannot make a flat neighbourhood look otherwise.
                    let raw = [wide.data[i], wide.data[i + 1], wide.data[i + 2]];
                    let flat = |plane: &Plane, here: [f64; 3]| {
                        [p - 1, p + 1, p - wide.width, p + wide.width].into_iter().all(|q| {
                            (0..3).all(|c| (plane.data[q * 3 + c] - here[c]).abs() <= FLAT_ENOUGH)
                        })
                    };
                    if !flat(wide, raw) || !flat(target, t) {
                        continue;
                    }

                    let v = match sharp.falloff {
                        None => raw,
                        Some((a, b)) => {
                            let r = crate::fit::Gain::radius(x as f64 - cx, y as f64 - cy, half);
                            let g = crate::fit::Gain::at(a, b, r);
                            [raw[0] * g, raw[1] * g, raw[2] * g]
                        }
                    };
                    if v[0].max(v[1]).max(v[2]) >= TRUST_CEILING {
                        continue;
                    }

                    let toned = tone(colour, v[0], v[1], v[2]);
                    let m = apply3(&colour.matrix, toned[0], toned[1], toned[2]);
                    let ours = LUMA[0] * m[0] + LUMA[1] * m[1] + LUMA[2] * m[2];
                    let (d0, d2) = (m[0] - ours, m[2] - ours);
                    let (e0, e2) = (t[0] - theirs, t[2] - theirs);

                    // A quarter each, there being four of these pixels for every one of
                    // the pairs above, describing the same surface.
                    //
                    // Flat, where the pairs above carry `balance` - the hue weighting,
                    // which runs to 4 on a rare hue and 0.25 on a dominant one. So a wide
                    // pixel of a rare saturated hue counts a sixteenth of the pair it
                    // supplements, not a quarter, and the nodes this pass exists to feed
                    // are the ones it under-feeds. Left as it measures rather than as it
                    // reads: the map's shrinkage and its margin were tuned against this
                    // pass at this weight, so correcting the scale is a re-tuning of
                    // `MAP_CONFIDENCE` and `MAP_MARGIN` with it, not a one-line fix.
                    let (at, weight) = ChromaMap::nodes_for(ours, d0, d2);
                    for (node, share) in at.into_iter().zip(weight) {
                        let sw = 0.25 * share;
                        if sw <= 0.0 {
                            continue;
                        }
                        let input = [d0, d2];
                        let goal = [e0, e2];
                        for a in 0..2 {
                            for b in 0..2 {
                                row.ata[node][a][b] += sw * input[a] * input[b];
                                row.atb[node][a][b] += sw * input[b] * goal[a];
                            }
                        }
                        row.btb[node] += sw * (e0 * e0 + e2 * e2);
                        row.seen[node] += sw;
                    }
                }
                row
            })
            .collect();

        for row in &rows {
            for node in 0..NODES {
                for a in 0..2 {
                    for b in 0..2 {
                        ata[node][a][b] += row.ata[node][a][b];
                        atb[node][a][b] += row.atb[node][a][b];
                    }
                }
                btb[node] += row.btb[node];
                seen[node] += row.seen[node];
            }
        }
    }

    // Each node solved on its own, then pulled back toward the scalar by how little it
    // saw. A node with nothing keeps nothing of its own.
    let flat = [saturation, 0.0, 0.0, saturation];
    let mut map = ChromaMap { nodes: Box::new([flat; MAP_NODES]) };
    let mut fitted = 0usize;
    for node in 0..NODES {
        let a = ata[node];
        let scale = a[0][0] + a[1][1];
        if !(scale > 0.0) {
            continue;
        }
        let ridge = MAP_RIDGE * scale;
        let (m00, m01, m10, m11) = (a[0][0] + ridge, a[0][1], a[1][0], a[1][1] + ridge);
        let det = m00 * m11 - m01 * m10;
        if !(det.abs() > 1e-12) {
            continue;
        }
        // The ridge pulls toward the scalar rather than toward zero, so damping a node
        // means "behave like the rest of the frame", not "throw the colour away".
        let mut solved = [0.0f64; 4];
        for row in 0..2 {
            let (b0, b1) = (
                atb[node][row][0] + ridge * flat[row * 2],
                atb[node][row][1] + ridge * flat[row * 2 + 1],
            );
            solved[row * 2] = (b0 * m11 - b1 * m01) / det;
            solved[row * 2 + 1] = (b1 * m00 - b0 * m10) / det;
        }
        // Scaled so the chroma it produces is as strong as the camera's. `tr(M A M')`
        // is the mean square chroma this node would emit and `tr(B)` what it should be,
        // both already summed above, so this is the correction least squares could not
        // make for itself.
        let a = ata[node];
        let mut emitted = 0.0;
        for row in 0..2 {
            let (m0, m1) = (solved[row * 2], solved[row * 2 + 1]);
            emitted += m0 * (a[0][0] * m0 + a[0][1] * m1) + m1 * (a[1][0] * m0 + a[1][1] * m1);
        }
        if emitted > 0.0 && btb[node] > 0.0 {
            let gain = (btb[node] / emitted).sqrt().clamp(1.0 / MAP_MAX_GAIN, MAP_MAX_GAIN);
            for v in &mut solved {
                *v *= gain;
            }
        }

        let keep = seen[node] / (seen[node] + MAP_CONFIDENCE);
        for k in 0..4 {
            map.nodes[node][k] = flat[k] + (solved[k] - flat[k]) * keep;
        }
        fitted += 1;
    }
    if fitted == 0 {
        return None;
    }

    // And whatever nodes would sharpen colour noise pulled back until they cannot.
    map.relax(saturation);
    Some(map)
}

/// The same two planes before either was blurred, at the fit grid and at twice it.
struct Sharp {
    render: Plane,
    jpeg: Plane,
    /// Twice the fit grid, unblurred, for objects the fit grid is too coarse to hold.
    /// The falloff is not in `wide_render`; whoever reads a pixel applies it.
    wide_render: Plane,
    wide_jpeg: Plane,
    falloff: Option<(f64, f64)>,
}

fn fit_colour(render: &Plane, jpeg: &Plane, sharp: &Sharp) -> Option<HdrColour> {
    let bits = mask(render, jpeg);
    let all = bits.iter().filter(|v| *v & ALL != 0).count();
    if all < MIN_PAIRS {
        return None;
    }
    let balance = hue_balance(jpeg, &bits);

    let pairs = Pairs::new(jpeg, &bits, &balance);
    let mut colour = fit_model(render, jpeg, &bits, &balance, &pairs);

    // One scalar on top, because a 3x3 cannot express a saturation that varies with
    // level and the camera's does. It stays one number for the reason on the field
    // itself.
    colour.saturation = fitted_saturation(&colour, render, &pairs);

    // Then the hue-dependent part, kept only if it earns its place. Least squares on
    // chroma minimises chroma error, and this fit is judged on deltaE - the same gap
    // that made a mean chroma ratio the wrong way to pick the scalar. Per node it is far
    // better constrained than one number was, but "better constrained" is not "always an
    // improvement", so it is measured rather than assumed.
    let flat = measure(&colour, render, &pairs).1;
    if let Some(map) = fitted_chroma(&colour, render, jpeg, sharp, &pairs, colour.saturation) {
        let trial = HdrColour { chroma: Some(map), ..colour.clone() };
        if measure(&trial, render, &pairs).1 + MAP_MARGIN < flat {
            colour = trial;
        }
    }

    colour.delta_e = measure(&colour, render, &pairs).0;
    Some(colour)
}

/// How much better the chroma map has to measure than the scalar it replaces.
///
/// Small, because the map is a strict generalisation - it contains the scalar exactly -
/// so it can only lose by overfitting, and the shrinkage already answers that. This is
/// here to catch the case where it has, not to set a bar it must clear.
const MAP_MARGIN: f64 = 0.005;

fn fit_model(
    render: &Plane,
    jpeg: &Plane,
    bits: &[u8],
    balance: &[f64],
    pairs: &Pairs,
) -> HdrColour {
    let mut colour = HdrColour {
        curves: fit_curves(render, jpeg, bits, balance, None),
        matrix: IDENTITY,
        saturation: 1.0,
        chroma: None,
        delta_e: f64::INFINITY,
    };

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
    for round in 0..FIT_ROUNDS {
        colour.matrix = fitted_matrix_for(&colour, render, jpeg, balance, pairs);
        let Some(inverse) = invert3(&colour.matrix).filter(|_| round + 1 < FIT_ROUNDS) else {
            break;
        };
        colour.curves = fit_curves(render, jpeg, bits, balance, Some(&inverse));
        // Inside the alternation, not after it, and not conditional. A camera-neutral
        // rendering neutral is a property the transform should have rather than an
        // improvement it might make - it is the same kind of statement as the matrix's
        // rows summing to one - and the matrix refit at the top of the next round is
        // what lets the rest of the fit settle around it. Applied afterwards instead it
        // has no round left to settle in, and scores worse than not doing it at all.
        grey_balance(&mut colour, render, pairs);
    }

    colour
}

// ------------------------------------------------------------------- the entry

/// Materialises everything the lens did onto a 16-bit frame: the warp and the falloff,
/// in one gather.
///
/// Both are resolution-independent - each is in radii normalised to the half-diagonal -
/// so this is cheapest after any fit-to-size. None when the match asks for neither.
///
/// For the editor, which caches the corrected frame and re-grades on every slider tick.
/// The one-shot encode builds the same [`crate::image::PlanarWarp`] and warps inside
/// [`crate::tone::grade_owned`] instead, so prepare need not hold the intermediate.
/// The falloff is indexed by the output pixel's own radius - the currency it was fitted
/// in against the warped render - and brightens corners, clipping a little more of the
/// top of the buffer (0.089% to 0.124% of samples on the worst of 32 Canon frames, 10.8.1).
pub fn apply_lens(samples: &[u16], width: usize, height: usize, m: &HdrMatch) -> Option<Vec<u16>> {
    let warp = crate::image::PlanarWarp::for_lens(
        width,
        height,
        width,
        height,
        &m.lens,
        crate::image::Sampling::Bicubic,
    )?;
    Some(warp.apply_u16(samples))
}

/// Fits the camera's colour treatment in the HDR grade's own domain, reusing the
/// geometry the SDR fit already resolved.
///
/// `anchor` is diffuse white as a raw 16-bit level, which the grade measures the same
/// way (10.7.1); the fit is done in multiples of it so the curve means the same thing
/// whatever the exposure. None when there are too few usable pairs to fit from, in
/// which case the caller grades untransformed.
pub fn fit(
    plane: &Plane,
    anchor: f64,
    preview: &crate::rgb::Rgb,
    lens: crate::fit::Lens,
) -> Option<HdrMatch> {
    if !(anchor > 0.0) {
        return None;
    }

    // Linearised before the resample: averaging gamma-encoded samples is not
    // averaging light, and at this scale factor that alone shifts the mid-tones.
    let srgb_to_rec2020 = multiply(&XYZ_TO_REC2020, &SRGB_TO_XYZ);
    let mut full = vec![0.0f64; preview.width * preview.height * 3];
    for p in 0..preview.width * preview.height {
        let i = p * 3;
        let v = apply3(
            &srgb_to_rec2020,
            srgb_eotf(preview.data[i]),
            srgb_eotf(preview.data[i + 1]),
            srgb_eotf(preview.data[i + 2]),
        );
        full[i..i + 3].copy_from_slice(&v);
    }
    let wide_jpeg = Plane { width: preview.width, height: preview.height, data: full };
    // Only the normalisation is per-fit, so this is a pass over ~1.1M pixels rather
    // than over the frame the plane was averaged from.
    let small: Vec<f64> = plane.data.par_iter().map(|v| v / anchor).collect();
    let colour = fit_model_planes(small, plane.width, plane.height, wide_jpeg, &lens)?;
    Some(HdrMatch { lens, colour })
}

/// The same fit, for a caller whose render and reference are already in one display
/// domain rather than in the grade's.
///
/// The model has nothing HDR about it: per-channel curves, a 3x3, and a correction over
/// chroma and level are all statements about colour, and the domain they are fitted in is
/// whatever the two planes arrive in. An SDR rendition hands over 8-bit sRGB on both
/// sides, so the preparation here is a divide rather than a transfer and a primary
/// conversion - and that is the whole difference between the two entry points.
pub fn fit_display(
    render: &crate::rgb::Rgb,
    preview: &crate::rgb::Rgb,
    lens: &crate::fit::Lens,
) -> Option<HdrColour> {
    let level = |v: u8| f64::from(v) / 255.0;
    let wide_jpeg = Plane {
        width: preview.width,
        height: preview.height,
        data: preview.data.iter().map(|v| level(*v)).collect(),
    };
    let small: Vec<f64> = render.data.par_iter().map(|v| level(*v)).collect();
    fit_model_planes(small, render.width, render.height, wide_jpeg, lens)
}

/// The fit itself, once both sides are normalised into one domain.
///
/// `small` is the render at `wide` x `tall`, unwarped; the lens is applied here because
/// the pairs only correspond through it.
fn fit_model_planes(
    small: Vec<f64>,
    wide: usize,
    tall: usize,
    wide_jpeg: Plane,
    lens: &crate::fit::Lens,
) -> Option<HdrColour> {
    // The fit itself runs at half this, as it always has.
    let (fit_wide, fit_tall) = (wide_jpeg.width / 2, wide_jpeg.height / 2);
    let mut jpeg = Plane {
        width: fit_wide,
        height: fit_tall,
        data: resample(&wide_jpeg.data, wide_jpeg.width, wide_jpeg.height, fit_wide, fit_tall, |v| v),
    };
    let sharp_jpeg = Plane { width: jpeg.width, height: jpeg.height, data: jpeg.data.clone() };
    blur_plane(&mut jpeg, FIT_BLUR_RADIUS);

    // Through the geometry the search resolved, so a pair is two views of one point in
    // the scene. Warped at twice the fit grid rather than at full resolution: warping
    // 60MP with bilinear taps and resampling afterwards is both slower and worse - it
    // aliases going in and blurs the geometry going out - and measured, it took the fit
    // from under a second to 17.
    //
    // Gated on `moves_pixels`, so a lens carrying a scale and no spline still warps.
    // The lateral scales travel with the warp, or the pairs this fit is built from
    // correspond through a different geometry than the grade applies - which is the failure
    // the `Lens` struct exists to make unexpressible.
    let warped = match lens.tca.is_some()
        || crate::image::moves_pixels(lens.distortion.as_deref(), lens.crop)
    {
        true => {
            let knots = lens.distortion.as_deref().unwrap_or_default();
            warp_planar(
                &small,
                wide,
                tall,
                wide,
                tall,
                knots,
                lens.crop,
                None,
                &lens.channels(),
                crate::image::Sampling::Bilinear,
                |v| v,
                |v| v,
            )
        }
        false => small,
    };

    let mut render = Plane {
        width: jpeg.width,
        height: jpeg.height,
        data: resample(&warped, wide, tall, jpeg.width, jpeg.height, |v| v),
    };
    // Before the blur and before the fit, because the grade applies it before the
    // colour too: a curve fitted against corners the falloff has not yet lifted would
    // be asked at grade time for levels it never saw.
    if let Some((a, b)) = lens.falloff {
        let (cx, cy) = (render.width as f64 / 2.0, render.height as f64 / 2.0);
        let half = (cx * cx + cy * cy).sqrt().max(1.0);
        for y in 0..render.height {
            let dy = y as f64 - cy;
            for x in 0..render.width {
                let g = crate::fit::Gain::at(a, b, crate::fit::Gain::radius(x as f64 - cx, dy, half));
                let i = (y * render.width + x) * 3;
                for c in 0..3 {
                    render.data[i + c] *= g;
                }
            }
        }
    }
    let sharp_render = Plane { width: render.width, height: render.height, data: render.data.clone() };
    blur_plane(&mut render, FIT_BLUR_RADIUS);

    // The same render at twice the grid, which is where it was warped anyway - only the
    // resample down to the fit grid is skipped. Its falloff is carried rather than
    // applied: a hundredth of these pixels reach the point of needing it, and multiplying
    // the other 99% through a square root each cost more than the whole pass it feeds.
    let wide_render = Plane { width: wide, height: tall, data: warped };

    // The lens travels with the colour, never beside it: these pairs only correspond
    // through that warp and carry that falloff, so the three are one transform.
    let sharp = Sharp {
        render: sharp_render,
        jpeg: sharp_jpeg,
        wide_render,
        wide_jpeg,
        falloff: lens.falloff,
    };
    fit_colour(&render, &jpeg, &sharp)
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

/// The decode box-averaged to the grid both fits work on, in the decode's own units.
///
/// Shared rather than built twice. The geometry search and the colour fit want exactly
/// this same average and differ only in the scalar they normalise it by, so walking a
/// 61MP frame once each was a whole extra pass over 15.8M pixels for the same answer.
/// Left unnormalised for that reason: each consumer divides by its own level.
///
/// `wide` is the preview's own width, which both callers resize their render to -
/// so arriving at that size makes its own resize a no-op rather than a second resample.
pub fn fit_plane(linear: &[u16], width: usize, height: usize, wide: usize) -> Plane {
    let wide = width.min(wide).max(1);
    let tall = (((height as f64 / width as f64) * wide as f64).round() as usize).max(1);
    Plane { width: wide, height: tall, data: resample(linear, width, height, wide, tall, f64::from) }
}

/// That plane as an 8-bit render, for the geometry search.
///
/// So the geometry fit can be driven off the HDR decode rather than a second, 8-bit one
/// taken of the same file. Both are renders of one RAW and the fit asks them the same
/// question, so they had better agree - and what they are handed is the only thing that
/// can make the answer differ.
///
/// **In LibRaw's transfer, which is not the sRGB one.** Its 8-bit path runs dcraw's
/// `gamma_curve` at LibRaw's default `gamm` of 1/2.222 over a slope of 4.5, which is
/// BT.709; sRGB's 1/2.4 over 12.92 lifts shadows considerably further. Rendered with
/// sRGB's, this put level 16 where LibRaw puts 8 and 32 where it puts 16 - 12.4 levels
/// apart across the frame, of which a per-channel curve explained all but 2.3, the rest
/// being the 1280px plane against LibRaw's 3000px decode.
///
/// **Normalised by diffuse white, not by the frame's peak**, and the difference is not
/// cosmetic. LibRaw's auto-bright is a percentile - it clips its brightest ~1% on
/// purpose. Dividing by the peak instead clips nothing, which sounds safer and is the
/// bug: the peak is the maximum of a strided subsample, so a single specular sample - a
/// sun, a chrome edge, a hot pixel - drags the whole render toward black by the
/// peak/white ratio, which `tone.rs` documents as varying 10x across bodies. Measured on
/// DSC02981 that took the render's mean from 88 to 51 against LibRaw's 115, about a stop
/// and a fifth, and `fit::pairs` drops any pair whose darkest channel lands on 1 or
/// below - so the shadows that error creates are not merely dark, they are discarded,
/// and a frame can fall under `MIN_PAIRS` and lose its colour match altogether.
///
/// The quantile is also what keeps this *close* across decode sizes, which the peak is
/// not - and close is the goal rather than equal. Two jobs fitting the same photo from
/// differently-sized decodes should land on the same geometry, since nothing is
/// persisted between them (10.8), but they cannot land on it exactly: a half-size
/// decode is its own demosaic rather than a downscale of the full one, so resampling
/// both to the fit grid gives slightly different planes whatever is done here. Measured
/// on the 24MP fixture, a full decode against a halved one moves the fitted matrix by
/// about 0.5%. What is worth fixing is anything that makes the gap *larger* than that
/// for no reason, which is what the peak was doing before `tone` read it as a quantile.
pub fn render_srgb8(plane: &Plane, white: f64) -> crate::rgb::Rgb {
    let mut data = vec![0u8; plane.width * plane.height * 3];
    let to_srgb = rec2020_to_srgb();
    data.par_chunks_mut(3).zip(plane.data.par_chunks(3)).for_each(|(out, px)| {
        // sRGB primaries first, as LibRaw's own `OUTPUT_SRGB` lands on; the fit works in
        // Rec.2020.
        let v = apply3(&to_srgb, px[0] / white, px[1] / white, px[2] / white);
        for c in 0..3 {
            out[c] = (255.0 * bt709_oetf(v[c])).round() as u8;
        }
    });
    crate::rgb::Rgb { width: plane.width, height: plane.height, data }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity_colour() -> HdrColour {
        HdrColour::identity()
    }

    #[test]
    fn an_identity_transform_returns_its_input() {
        let colour = identity_colour();
        for value in [0.0, 0.1, 0.45, 0.9] {
            let out = apply_hdr_colour(&colour, value, value, value);
            assert!((out[0] - value).abs() < 1e-9, "{value} -> {out:?}");
        }
    }

    #[test]
    fn above_the_ceiling_the_gain_is_shared_rather_than_per_channel() {
        // The magenta-sky failure: three channels extrapolating independently drift
        // apart as brightness rises. A shared gain keeps the ratio, so a bright
        // orange stays orange and only gets brighter.
        let colour = identity_colour();
        let low = apply_hdr_colour(&colour, 0.6, 0.3, 0.15);
        let high = apply_hdr_colour(&colour, 2.4, 1.2, 0.6);
        let ratio_low = low[1] / low[0];
        let ratio_high = high[1] / high[0];
        assert!((ratio_low - ratio_high).abs() < 1e-6, "hue drifted: {ratio_low} vs {ratio_high}");
    }

    #[test]
    fn saturation_below_one_pulls_towards_luma() {
        let mut colour = identity_colour();
        colour.saturation = 0.5;
        let out = finish_colour(&colour, 0.8, 0.2, 0.2);
        let l = LUMA[0] * 0.8 + LUMA[1] * 0.2 + LUMA[2] * 0.2;
        assert!((out[0] - (l + (0.8 - l) * 0.5)).abs() < 1e-9);
    }

    /// A curve fitted from pairs of `shape`, whose samples reach `reach` of the domain.
    fn curve_of(reach: f64, shape: impl Fn(f64) -> f64) -> (Vec<f64>, isize) {
        let (xs, ys): (Vec<f64>, Vec<f64>) = (0..4000)
            .map(|i| {
                let x = (i as f64 / 4000.0) * TRUST_CEILING * reach;
                (x, shape(x))
            })
            .unzip();
        fit_curve(&xs, &ys, &vec![1.0; xs.len()], xs.len())
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

    #[test]
    fn a_channel_whose_pairs_run_out_early_does_not_drift_from_the_others() {
        // The green-sky failure. All three channels see the same rendering, but the
        // JPEG clips green a quarter of the way up the domain and red not until
        // two-thirds - so green's own last slope, taken from the steep part of the
        // curve, ran it to twice red's by diffuse white.
        let shape = |x: f64| x.powf(0.45) * 0.9;
        let curves =
            extend_curves([curve_of(0.66, shape), curve_of(0.18, shape), curve_of(0.20, shape)]);

        for x in [0.3, 0.5, 0.7, TRUST_CEILING] {
            let [r, g, b] = [0, 1, 2].map(|c| sample_curve(&curves[c], x * TRUST_CEILING));
            assert!((g / r - 1.0).abs() < 0.02, "green drifted at {x}: {g} against {r}");
            assert!((b / r - 1.0).abs() < 0.02, "blue drifted at {x}: {b} against {r}");
        }
    }

    #[test]
    fn a_borrowed_tail_holds_the_gain_near_the_join_and_lets_it_go_by_the_top() {
        // Both halves of the same trade. Just above the join the channel's own
        // measurement is the best thing there is, so a camera rendering it 20% hotter
        // keeps that. By the top of the domain the gain is a claim about a level the
        // frame never measured, and holding it there is what puts a colour in a sky
        // that has none - so it fades and the channel becomes the shared curve.
        let shape = |x: f64| x.powf(0.45) * 0.9;
        let curves = extend_curves([
            curve_of(0.66, shape),
            curve_of(0.18, |x| shape(x) * 1.2),
            curve_of(0.66, shape),
        ]);

        let at = |x: f64| (sample_curve(&curves[1], x), sample_curve(&curves[0], x));
        let (hot, plain) = at(0.2);
        assert!((hot / plain - 1.2).abs() < 0.05, "gain lost at the join: {hot} vs {plain}");
        let (hot, plain) = at(TRUST_CEILING);
        assert!((hot / plain - 1.0).abs() < 0.02, "gain held to the top: {hot} vs {plain}");
    }

    #[test]
    fn a_channel_that_ends_above_the_reference_still_converges_onto_it() {
        // The corner that made a neutral sky come out 13% red off a bounded decode and
        // neutral off a full one. A channel reaching far with a strong gain ends higher
        // than the reference's extension, so converging asks it to fall, and the
        // monotone guard - which the measured part of the curve needs - clamps the whole
        // tail flat at its own level instead. It has to be the curves that move, not the
        // guard that gives way.
        let shape = |x: f64| x.powf(0.45) * 0.9;
        let curves = extend_curves([
            curve_of(0.30, shape),
            curve_of(0.85, |x| shape(x) * 1.4),
            curve_of(0.30, shape),
        ]);

        let tops = [0, 1, 2].map(|c| curves[c][BINS - 1]);
        let (high, low) = (tops.iter().cloned().fold(0.0, f64::max), tops.iter().cloned().fold(f64::MAX, f64::min));
        assert!(high / low - 1.0 < 0.01, "the channels ended apart: {tops:?}");
        // And nothing was dragged downwards to get there.
        for c in 0..3 {
            for b in 1..BINS {
                assert!(curves[c][b] >= curves[c][b - 1], "channel {c} dips at {b}");
            }
        }
    }

    #[test]
    fn one_colour_filling_a_frame_does_not_own_the_fit() {
        // IMG_8789's whole story: a lawn fills the frame, the fit minimises over every
        // pair equally, and the two brown dogs are too small a share for their error to
        // cost it anything - so they render olive while the held-out deltaE reports 2.96
        // and looks healthy. What a frame is *of* must not decide what the camera is
        // taken to do.
        let mut plane = Plane { width: 40, height: 40, data: vec![0.0; 40 * 40 * 3] };
        for p in 0..40 * 40 {
            // Nine tenths one green, one tenth a warm brown.
            let px = match p % 10 {
                0 => [0.45, 0.25, 0.12],
                _ => [0.16, 0.40, 0.10],
            };
            plane.data[p * 3..p * 3 + 3].copy_from_slice(&px);
        }
        let bits = vec![ALL | 0b111; 40 * 40];

        let balance = hue_balance(&plane, &bits);
        let share = |want: usize| -> f64 {
            (0..40 * 40).filter(|p| p % 10 == want).map(|p| balance[p]).sum()
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
    fn a_channel_that_measured_nothing_takes_the_shape_rather_than_staying_black() {
        // Not one bin reaching `MIN_BIN_SAMPLES` left that curve as the zeroes it was
        // initialised with, so the channel rendered black. `fit_curve` returns
        // `last = -1` for such a channel.
        let shape = |x: f64| x.powf(0.45) * 0.9;
        let curves = extend_curves([
            curve_of(0.66, shape),
            (vec![0.0; BINS], -1),
            curve_of(0.40, shape),
        ]);
        let reference = &curves[0];
        assert!(curves[1].iter().any(|v| *v > 0.0), "the channel with no pairs stayed black");
        for bin in [BINS / 4, BINS / 2, BINS - 1] {
            assert!(
                (curves[1][bin] - reference[bin]).abs() < 1e-9,
                "bin {bin}: {} against the reference's {}",
                curves[1][bin],
                reference[bin]
            );
        }
    }

    #[test]
    fn the_level_search_lands_where_the_transfer_would_have() {
        // It replaces a `powf` in the fit's hottest loop, so it has to agree with the
        // thing it replaced everywhere, not merely closely - a level out by one is a
        // different measurement and the graded output is pinned by hash.
        let edges = srgb_edges();
        let guesses = level_guesses(&edges);
        let identity = IDENTITY;
        for i in 0..200_001u32 {
            let v = f64::from(i) / 200_000.0 * 1.2 - 0.1;
            let want = (255.0 * srgb_oetf(v)).round() as u8;
            let got = to_levels(&identity, &edges, &guesses, v, v, v);
            assert_eq!(got[0], want, "at {v}");
        }
        // Negative zero reaches here from the matrix, and it indexes on its bits: it
        // carries the sign bit, so read as an index it lands far outside the table. The
        // panic that follows is caught by `guard`, which reports no match at all, so the
        // frame quietly renders unmatched rather than crashing - four of the 35-frame
        // set did exactly that.
        for value in [-0.0f64, 0.0, -1e-30, f64::NAN, -5.0, 5.0] {
            let got = to_levels(&identity, &edges, &guesses, value, value, value);
            let want = (255.0 * srgb_oetf(if value.is_nan() { 0.0 } else { value })).round() as u8;
            assert_eq!(got[0], want, "at {value}");
        }

        // And on the boundaries themselves, which is where the two could disagree.
        for (k, edge) in edges.iter().enumerate() {
            let want = (255.0 * srgb_oetf(*edge)).round() as u8;
            assert_eq!(
                to_levels(&identity, &edges, &guesses, *edge, 0.0, 0.0)[0], want, "at edge {k}");
        }
    }

    #[test]
    fn a_frame_with_no_chroma_to_measure_keeps_its_saturation() {
        // Fog, snow, overcast. Every probe rounds to the same 8-bit target, so the
        // objective is flat and every comparison ties - and a search that discards half
        // its bracket on a tie walks to whichever end it favours. This returned 1.499,
        // a 1.5x chroma boost, and then applied it to a full-resolution frame that is
        // not achromatic once it is off the blurred grid the fit measured on.
        let (render, jpeg) = ramped_planes([0.4, 0.4, 0.4]);
        let bits = vec![ALL | 0b111; render.width * render.height];
        let ramp: Vec<f64> = (0..BINS).map(|i| i as f64 / (BINS - 1) as f64).collect();
        let pairs = Pairs::new(&jpeg, &bits, &vec![1.0f64; bits.len()]);
        let colour = HdrColour {
            curves: [ramp.clone(), ramp.clone(), ramp],
            matrix: IDENTITY,
            saturation: 1.0,
            chroma: None,
            delta_e: 0.0,
        };
        let found = fitted_saturation(&colour, &render, &pairs);
        assert!((found - 1.0).abs() < 1e-9, "invented a saturation out of a flat frame: {found}");
    }

    #[test]
    fn the_saturation_search_recovers_the_blend_the_camera_used() {
        // And is not solved from a mean chroma ratio, which on IMG_9808 could be made
        // to come out right by a scalar that pushed the hillside eight deltaE further
        // from the camera than it started.
        let (render, jpeg) = ramped_planes([0.5, 0.3, 0.18]);
        let bits = vec![ALL | 0b111; render.width * render.height];
        let ramp: Vec<f64> = (0..BINS).map(|i| i as f64 / (BINS - 1) as f64).collect();
        let flat = vec![1.0f64; bits.len()];

        for want in [0.85, 1.0, 1.2] {
            // The camera's rendering *is* the render pushed to `want`, so the search has
            // a right answer to find rather than a compromise to settle on.
            let applied = HdrColour {
                curves: [ramp.clone(), ramp.clone(), ramp.clone()],
                matrix: IDENTITY,
                saturation: want,
                chroma: None,
                delta_e: 0.0,
            };
            let mut target =
                Plane { width: jpeg.width, height: jpeg.height, data: jpeg.data.clone() };
            for p in 0..render.width * render.height {
                let i = p * 3;
                let v = apply_hdr_colour(&applied, render.data[i], render.data[i + 1], render.data[i + 2]);
                target.data[i..i + 3].copy_from_slice(&v);
            }

            let pairs = Pairs::new(&target, &bits, &flat);
            let neutral = HdrColour { saturation: 1.0, ..applied };
            let found = fitted_saturation(&neutral, &render, &pairs);
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
            fit(&plane, 1.0, &preview, crate::fit::Lens::none()).expect("the chart is fittable");

        // Read where the grade reads a blown sky: the shared gain scales the pixel so
        // its brightest channel sits at the top of the domain.
        let out = tone(&fitted.colour, 1.0, 1.0, 1.0);
        let (high, low) = (out[0].max(out[1]).max(out[2]), out[0].min(out[1]).min(out[2]));
        assert!(high / low - 1.0 < 0.01, "a neutral highlight came out {out:?}");
    }

    #[test]
    fn converging_the_tail_does_not_flatten_a_colour_the_scene_had() {
        // Converging the curves is not desaturation: what carries a highlight's colour
        // is the pixel, not the curve, so a warm one stays warm.
        let (plane, preview) = warm_chart();
        let fitted =
            fit(&plane, 1.0, &preview, crate::fit::Lens::none()).expect("the chart is fittable");

        let out = tone(&fitted.colour, 1.2, 0.6, 0.3);
        assert!(out[0] > out[1] * 1.3, "the warm highlight went flat: {out:?}");
        assert!(out[1] > out[2] * 1.2, "the warm highlight went flat: {out:?}");
    }

    #[test]
    fn borrowing_replaces_only_the_bins_a_channel_never_measured() {
        // The channels are near enough the same shape that a tail borrowed from the
        // wrong place still looks right, so the assertions above pass just as well on
        // an extension that overwrites the measured curve too. What it must not touch
        // is the data - a channel's own pairs are the only thing here that is not an
        // assumption.
        let short = |x: f64| x.powf(0.45) * 0.9 * 1.3;
        let (measured, last) = curve_of(0.18, short);
        let curves =
            extend_curves([curve_of(0.66, |x| x.powf(0.45) * 0.9), (measured.clone(), last), curve_of(0.66, short)]);

        for b in 0..=last as usize {
            assert_eq!(curves[1][b], measured[b], "bin {b} was measured, not guessed");
        }
    }

    /// The camera's rendering of one scene-linear level, per channel. A power curve
    /// with a per-channel gain: the shape the three share, and the difference between
    /// them that a borrowed tail has to keep.
    const CAMERA_GAIN: [f64; 3] = [1.0, 1.06, 0.94];
    fn camera(channel: usize, level: f64) -> f64 {
        CAMERA_GAIN[channel] * 1.172 * level.max(0.0).powf(0.533)
    }

    /// A patch chart and the camera's rendering of it, shaped like the frame that
    /// turned green: the body of it sits in the domain all three channels share, and
    /// what reaches past that is warm, so red carries pairs to render 0.45 where green
    /// and blue stop around 0.20 and everything above is a guess.
    ///
    /// Flat patches rather than a gradient, because `mask` drops any pixel with a
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
        let mut rendered = vec![0u8; width * height * 3 * 4];
        for y in 0..height {
            for x in 0..width {
                let colour = patch((y / PATCH) * COLS + (x / PATCH));
                let camera = [0, 1, 2].map(|c| camera(c, colour[c]));
                let srgb = to_srgb8(&rec2020_to_srgb(), camera[0], camera[1], camera[2]);
                for c in 0..3 {
                    for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                        let p = ((y * 2 + dy) * width * 2) + x * 2 + dx;
                        rendered[p * 3 + c] = srgb[c] as u8;
                        scene[p * 3 + c] = colour[c];
                    }
                }
            }
        }

        (
            Plane { width: width * 2, height: height * 2, data: scene },
            crate::rgb::Rgb { width: width * 2, height: height * 2, data: rendered },
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
            fit(&plane, 1.0, &preview, crate::fit::Lens::none()).expect("the chart is fittable");

        for level in [0.4, 0.5, 0.6] {
            let at = |c: usize| sample_curve(&fitted.colour.curves[c], level) / camera(c, level) - 1.0;
            // Red measured its own pairs to 0.66, so it is held to them.
            assert!(at(0).abs() < 0.03, "red at {level}: {:+.3}", at(0));
            // Green ran out at 0.18 and converges towards a gain near its own.
            assert!(at(1).abs() < 0.04, "green at {level}: {:+.3}", at(1));
            // Blue ran out at 0.20 and is the one converging *away* from its own gain,
            // by about the 6% that separates 0.94 from the top of the three.
            assert!(at(2) > 0.0 && at(2) < 0.08, "blue at {level}: {:+.3}", at(2));
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

        for base in [[0.12, 0.10, 0.09], [0.40, 0.30, 0.22], [0.75, 0.74, 0.72]] {
            // Two pixels a hair apart, as neighbours on a flat surface are.
            let near = [base[0] + 0.004, base[1] - 0.003, base[2] + 0.002];
            let (a, b) = (apply_hdr_colour(&colour, base[0], base[1], base[2]),
                          apply_hdr_colour(&colour, near[0], near[1], near[2]));
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
        // The freedom browns need and the guarantee greys need, at the same time. The
        // ridge used to buy the second by denying the first: damped to near-identity
        // the matrix could not say that this camera scales green by 0.884 on grass and
        // 0.690 on a dog, so the dogs came out olive. Constrained instead, the rows may
        // go where the pairs point as long as a grey stays a grey.
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
        // this reports is measured in the wrong space.
        let out = to_srgb8(&rec2020_to_srgb(), 0.5, 0.5, 0.5);
        assert!((out[0] - out[1]).abs() <= 1.0 && (out[1] - out[2]).abs() <= 1.0, "{out:?}");
        assert!(out[0] > 150.0 && out[0] < 200.0, "mid grey, got {}", out[0]);
    }
}
