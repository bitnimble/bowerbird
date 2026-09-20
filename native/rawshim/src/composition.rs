//! What a composition is: the sources a composite is made of, where each one points, and the
//! surface they are projected onto. A panorama is one recipe over it; an assembly is another.
//!
//! **A recipe, not a picture.** Nothing here holds pixels. A window of the canvas is composited on
//! demand from whichever sources reach it, so the same recipe answers a grid tile, a loupe tile at
//! 1:1 and a DNG export - and nothing ever holds two 61MP frames at once.
//!
//! **It is stated in the camera's own corrected geometry**, which is the geometry of the previews
//! it was solved from and of the JPEGs a camera writes. A source that is a RAW is reached by
//! applying its lens's ratio table after the pinhole, exactly as `warp.slang` does; a source that
//! is already a finished picture is reached at the pinhole itself.

use serde::{Deserialize, Serialize};

/// The surface the sources are projected onto.
///
/// Hugin's rule, and for its reasons: a rectilinear canvas keeps straight lines straight and is
/// unusable past about 100 degrees, where the corners stretch without bound; a cylinder holds any
/// width but cannot hold a tall field; the sphere holds everything and bends horizons.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Projection {
    Rectilinear,
    Cylindrical,
    Equirectangular,
}

/// A lens as a recipe carries it: `fit::Lens`, in the same shape `photo_analysis` stores.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LensSpec {
    pub distortion: Option<Vec<f64>>,
    pub crop: f64,
    pub falloff: Option<(f64, f64)>,
    pub tca: Option<[Vec<f64>; 2]>,
}

impl From<&crate::fit::Lens> for LensSpec {
    fn from(lens: &crate::fit::Lens) -> LensSpec {
        LensSpec {
            distortion: lens.distortion.clone(),
            crop: lens.crop,
            falloff: lens.falloff,
            tca: lens.tca.clone(),
        }
    }
}

impl LensSpec {
    /// The identity, for a source that is a finished picture: its own geometry is the corrected
    /// one, so there is nothing to undo.
    pub fn none() -> LensSpec {
        LensSpec::from(&crate::fit::Lens::none())
    }

    pub fn to_lens(&self) -> crate::fit::Lens {
        crate::fit::Lens {
            distortion: self.distortion.clone(),
            crop: self.crop,
            falloff: self.falloff,
            tca: self.tca.clone(),
        }
    }
}

/// One frame of a panorama, and where it points.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpec {
    /// The catalogue's photo id. The server resolves it to a path per job, so a recipe survives a
    /// library moving on disk.
    pub photo_id: String,
    /// The source's size in the corrected geometry, at full resolution.
    pub size: [usize; 2],
    /// Unit quaternion, camera to world, `[w, x, y, z]`.
    pub rotation: [f64; 4],
    /// Pinhole focal length in this source's own full-resolution pixels.
    pub focal: f64,
    pub lens: LensSpec,
    /// Applied to this source's scene-linear samples before they are blended, so two frames
    /// metered differently meet at the same brightness.
    pub gain: f64,
    /// An affine over the **canvas** this source's content is taken through: for a canvas point
    /// `p`, the gather samples this source as though the point were `[a b; c d] * p + [tx, ty]`.
    ///
    /// **§3.7a's per-piece correction, and the reason it is not a rotation.** An anisotropic
    /// scale or a *shear* is not expressible as any rotation of any pinhole, and a shear is what a
    /// subject that moved needs to meet the ground around it, so the correction lives where the
    /// canvas coordinate already is.
    ///
    /// **Render-time, and deliberately not serialised.** What a recipe stores is `Seams::warp`,
    /// one a piece, and the gather reads those through the weight mask's `tile_warps`; this is the
    /// warp outside every piece, which every render leaves the identity and
    /// `the_gather_places_a_pixel_where_the_recipe_does` sets to pin the shader's affine.
    #[serde(skip, default = "no_warp")]
    pub warp: [f64; 6],
}

/// The identity affine: what every source that is not a §3.7a correction carries.
pub fn no_warp() -> [f64; 6] {
    [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
}

/// The canvas point a source is actually asked for, given the canvas point being written.
///
/// **The host's statement of what `composite_gather.slang` does between the canvas and the ray**,
/// and pinned against it by `the_gather_places_a_pixel_where_the_recipe_does`.
pub fn warped_canvas(source: &SourceSpec, canvas: [f64; 2]) -> [f64; 2] {
    let [a, b, c, d, tx, ty] = source.warp;
    [
        a * canvas[0] + b * canvas[1] + tx,
        c * canvas[0] + d * canvas[1] + ty,
    ]
}

/// A panorama, as a stack carries it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Composition {
    pub version: u32,
    pub sources: Vec<SourceSpec>,
    pub projection: Projection,
    /// The canvas at scale 1, which is 1:1 with the reference source's centre.
    pub canvas: [usize; 2],
    /// Where the projection's own centre falls on that canvas.
    ///
    /// Not the canvas's middle: the sources are levelled and pointed by the solve, and the ground
    /// they cover is rarely symmetric about the frame that happened to be first, so the canvas is
    /// framed around what is there and this says where the axis went.
    pub centre: [f64; 2],
    /// Radians per canvas pixel at the projection's centre.
    pub radians_per_pixel: f64,
    /// The largest rectangle of the canvas the sources actually cover, as `left, top, right,
    /// bottom` fractions - `EditDoc`'s own crop, in its units.
    ///
    /// **What a render trims to, and what an export ignores.** The canvas is the union of the
    /// frames, which for a hand-held pan is a staircase with wedges of nothing at the corners; a
    /// picture on screen wants the rectangle inside that. But the wedges are data, and an export
    /// exists to hand another tool everything there is - so this trims what is *shown* and never
    /// what is *kept*, and a reader who wants a different crop is changing a setting rather than
    /// re-aligning a panorama.
    #[serde(default = "whole")]
    pub crop: [f64; 4],
    /// Which source's own rendering the composite is graded as, and whose match it carries.
    pub reference: usize,
    /// What the seams measured at the last full render, in pixels. None until one has run.
    pub seam_rms_px: Option<f64>,
}

/// The version a recipe written by this build carries.
pub const VERSION: u32 = 1;

/// Serde's default for [`Composition::crop`]: the whole canvas, for a recipe written before there
/// was one to compute.
fn whole() -> [f64; 4] {
    [0.0, 0.0, 1.0, 1.0]
}

impl Composition {
    pub fn reference(&self) -> &SourceSpec {
        &self.sources[self.reference.min(self.sources.len() - 1)]
    }

    /// What a measurement over this canvas was measured over, for
    /// [`crate::photo_analysis::FromRender::set`] to be stamped with and refused by.
    pub fn set_stamp(&self) -> crate::photo_analysis::SetStamp {
        crate::photo_analysis::SetStamp::of(
            self.sources
                .iter()
                .map(|source| (source.photo_id.as_str(), source.gain)),
            self.reference,
        )
    }

    /// The recipe that places one photograph on a canvas its own size, unchanged.
    ///
    /// **What makes a single file the same call as a panorama of twenty-six.** The canvas is the
    /// photograph, the projection is the plane the photograph already lies in, and the rotation is
    /// the identity - so `canvas_to_ray` followed by `ray_to_source` is the pixel it started at,
    /// and everything a composite does to a source reduces to what a window of one file does.
    ///
    /// The focal cancels and so is arbitrary: a rectilinear canvas rays a pixel as
    /// `(x - centre) * radians_per_pixel` on the plane at `z = 1`, and with
    /// `radians_per_pixel = 1 / focal` the source's own `centre + focal * x / z` undoes it
    /// exactly, whatever the focal was. It is named rather than picked per call so two recipes of
    /// one photograph compare equal.
    pub fn of_one(size: [usize; 2], lens: LensSpec) -> Composition {
        Composition {
            version: VERSION,
            sources: vec![SourceSpec {
                // Named by the caller everywhere it matters; a prepare resolves its sources by
                // position, since the recipe and the files are handed over as a pair.
                photo_id: String::new(),
                size,
                rotation: [1.0, 0.0, 0.0, 0.0],
                focal: FOCAL_OF_ONE,
                lens,
                gain: 1.0,
                warp: no_warp(),
            }],
            projection: Projection::Rectilinear,
            canvas: size,
            centre: [size[0] as f64 / 2.0, size[1] as f64 / 2.0],
            radians_per_pixel: 1.0 / FOCAL_OF_ONE,
            crop: whole(),
            reference: 0,
            seam_rms_px: None,
        }
    }
}

/// The pinhole focal [`Composition::of_one`] states its one source at.
///
/// Cancels out of the mapping entirely (see there), so what this value has to be is *finite and
/// positive*. A round number well inside f64's exact integers, so the division and the
/// multiplication that undo each other do so without rounding.
pub const FOCAL_OF_ONE: f64 = 4096.0;

/// How one source of a recipe reaches the canvas.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Placement {
    /// The recipe lays this source on the canvas pixel for pixel, so the canvas *is* the
    /// photograph and the gather is the frame's own lens warp
    /// ([`crate::base::Gather::window`]).
    Direct,
    /// The source has to be rotated and projected onto the canvas, which is `composite_gather`'s job.
    Projected,
}

/// Which of the two a source takes.
///
/// **Asked of the recipe rather than remembered by the caller**, so a one-source recipe that
/// arrived as JSON from a peer takes the same path as one built here - and so that the answer
/// cannot disagree with the arithmetic it stands for. Everything tested here is exactly what
/// [`Composition::of_one`] establishes; a recipe failing any of it is projected, which is always
/// correct and only ever slower.
pub fn placement(spec: &Composition, index: usize) -> Placement {
    let Some(source) = spec.sources.get(index) else {
        return Placement::Projected;
    };
    let identity = source.rotation == [1.0, 0.0, 0.0, 0.0];
    let square_on = spec.projection == Projection::Rectilinear
        && spec.canvas == source.size
        && spec.centre == [source.size[0] as f64 / 2.0, source.size[1] as f64 / 2.0]
        // The one condition that is a product rather than an equality: it is what makes a canvas
        // pixel and a source pixel the same step.
        && (spec.radians_per_pixel * source.focal - 1.0).abs() < 1e-12;
    match spec.sources.len() == 1 && identity && square_on {
        true => Placement::Direct,
        false => Placement::Projected,
    }
}

/// How far down a canvas's own mipmap a stage of this size reads from.
///
/// **The editor's answer to "how much of this picture is worth preparing".** A stage is a few
/// million pixels and a canvas can be three hundred million, so a level is the largest halving
/// that still leaves `supersample` canvas pixels per stage pixel - which is the point the draw
/// stops minifying by more than two and can read the window's own buffer
/// (`gpu.rs`, `from_frame`).
///
/// Bounded below by the coarsest level rather than by zero: the picture a reader is handed before
/// they have zoomed anywhere is the whole canvas, and the whole canvas of a pan is more than any
/// adapter will hold. So the coarsest level is the one that fits [`COARSEST_LONG`], and a stage
/// larger than that reads it magnified rather than asking for a level nothing can prepare.
///
/// Nothing outside this module's own tests reads it yet: a prepare answers the coarsest level and
/// a reader zooming magnifies it, so choosing a level *for a stage* is what the windowing turns
/// on rather than anything shipping. The half of this that does cross a host boundary is
/// [`coarsest_level`], and `prepare-levels.txt` holds those two together.
pub fn level_of(canvas_long: usize, stage_long: usize, supersample: f64) -> u32 {
    let coarsest = coarsest_level(canvas_long);
    if stage_long == 0 || !supersample.is_finite() || supersample <= 0.0 {
        return coarsest;
    }
    let wanted = (stage_long as f64 * supersample).max(1.0);
    let mut level = 0u32;
    // Halve while the level *below* still covers what the stage wants, so the answer is the
    // largest level whose long edge is at least `wanted` - and never past the coarsest, which is
    // the only level a caller is promised can be prepared.
    while level < coarsest && ((canvas_long >> (level + 1)) as f64) >= wanted {
        level += 1;
    }
    level
}

/// The long edge of the coarsest level a canvas is prepared at.
///
/// A whole 300MP canvas is 1.8GB of samples and no adapter's texture limit reaches it, so the
/// picture a reader opens on is this one.
pub const COARSEST_LONG: usize = 4096;

/// The deepest level of a canvas, which is the first one inside [`COARSEST_LONG`].
pub fn coarsest_level(canvas_long: usize) -> u32 {
    let mut level = 0u32;
    while (canvas_long >> level) > COARSEST_LONG {
        level += 1;
    }
    level
}

/// The ray a canvas pixel looks along, in world coordinates.
///
/// x is right, y is down and z is forward, which is the camera's own frame and so what a rotation
/// of `[0, 0, 1]` reads as. Not normalised: every reader divides by z or normalises for itself.
pub fn canvas_to_ray(p: &Composition, x: f64, y: f64) -> [f64; 3] {
    let (cx, cy) = (p.centre[0], p.centre[1]);
    let (u, v) = (
        (x - cx) * p.radians_per_pixel,
        (y - cy) * p.radians_per_pixel,
    );
    match p.projection {
        // The plane at z = 1, which is what "radians per pixel at the centre" means for a
        // projection whose scale grows with the angle.
        Projection::Rectilinear => [u, v, 1.0],
        Projection::Cylindrical => {
            let (sin, cos) = u.sin_cos();
            [sin, v, cos]
        }
        Projection::Equirectangular => {
            let (sin_lon, cos_lon) = u.sin_cos();
            let (sin_lat, cos_lat) = v.sin_cos();
            [sin_lon * cos_lat, sin_lat, cos_lon * cos_lat]
        }
    }
}

/// Where a ray lands on the canvas, or None where the projection cannot hold it.
///
/// The inverse of `canvas_to_ray`, and the thing the framing is worked out from: every source's
/// corners go through this to say how big the canvas has to be.
pub fn ray_to_canvas(p: &Composition, ray: [f64; 3]) -> Option<[f64; 2]> {
    let (cx, cy) = (p.centre[0], p.centre[1]);
    let [x, y, z] = ray;
    let (u, v) = match p.projection {
        Projection::Rectilinear => {
            if z <= 1e-9 {
                return None;
            }
            (x / z, y / z)
        }
        Projection::Cylindrical => {
            let flat = (x * x + z * z).sqrt();
            if flat <= 1e-9 {
                return None;
            }
            (x.atan2(z), y / flat)
        }
        Projection::Equirectangular => {
            let flat = (x * x + z * z).sqrt();
            (x.atan2(z), y.atan2(flat))
        }
    };
    Some([cx + u / p.radians_per_pixel, cy + v / p.radians_per_pixel])
}

/// Where a ray falls in one source's picture, in that source's full-resolution pixels, or None
/// where it is behind the camera.
///
/// The answer is a pinhole coordinate in the camera's *corrected* geometry. A RAW source then
/// applies its lens's ratio table to reach the sensor's own pixel, as `warp.slang` does; a source
/// that is a finished picture is already there.
pub fn ray_to_source(source: &SourceSpec, ray: [f64; 3]) -> Option<[f64; 2]> {
    let d = rotate(conjugate(source.rotation), ray);
    if d[2] <= 1e-9 {
        return None;
    }
    let (cx, cy) = (source.size[0] as f64 / 2.0, source.size[1] as f64 / 2.0);
    Some([
        cx + source.focal * d[0] / d[2],
        cy + source.focal * d[1] / d[2],
    ])
}

/// The ray a source's own pixel looks along, in world coordinates.
pub fn source_to_ray(source: &SourceSpec, x: f64, y: f64) -> [f64; 3] {
    let (cx, cy) = (source.size[0] as f64 / 2.0, source.size[1] as f64 / 2.0);
    rotate(
        source.rotation,
        [(x - cx) / source.focal, (y - cy) / source.focal, 1.0],
    )
}

/// `q * v * q⁻¹`, the rotation a unit quaternion stands for.
pub fn rotate(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let [w, x, y, z] = q;
    let u = [x, y, z];
    let uv = cross(u, v);
    let uuv = cross(u, uv);
    [
        v[0] + 2.0 * (w * uv[0] + uuv[0]),
        v[1] + 2.0 * (w * uv[1] + uuv[1]),
        v[2] + 2.0 * (w * uv[2] + uuv[2]),
    ]
}

pub fn conjugate(q: [f64; 4]) -> [f64; 4] {
    [q[0], -q[1], -q[2], -q[3]]
}

pub fn multiply(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    let [aw, ax, ay, az] = a;
    let [bw, bx, by, bz] = b;
    [
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ]
}

/// The rotation an axis-angle vector stands for, its length being the angle.
pub fn from_axis_angle(v: [f64; 3]) -> [f64; 4] {
    let angle = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if angle < 1e-12 {
        return [1.0, 0.0, 0.0, 0.0];
    }
    let (sin, cos) = (angle / 2.0).sin_cos();
    let k = sin / angle;
    [cos, v[0] * k, v[1] * k, v[2] * k]
}

pub fn normalise(q: [f64; 4]) -> [f64; 4] {
    let length = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if length < 1e-12 {
        return [1.0, 0.0, 0.0, 0.0];
    }
    q.map(|v| v / length)
}

pub(crate) fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recipe(projection: Projection) -> Composition {
        Composition {
            version: VERSION,
            sources: vec![SourceSpec {
                photo_id: "one".into(),
                size: [6000, 4000],
                rotation: [1.0, 0.0, 0.0, 0.0],
                focal: 5200.0,
                lens: LensSpec::none(),
                gain: 1.0,
                warp: no_warp(),
            }],
            projection,
            canvas: [4000, 2000],
            centre: [2000.0, 1000.0],
            radians_per_pixel: 0.0004,
            crop: whole(),
            reference: 0,
            seam_rms_px: None,
        }
    }

    const PROJECTIONS: [Projection; 3] = [
        Projection::Rectilinear,
        Projection::Cylindrical,
        Projection::Equirectangular,
    ];

    /// Both directions of the projection are one mapping, which is what lets the framing be
    /// worked out forwards and the compositing read backwards.
    #[test]
    fn a_ray_round_trips_through_each_projection() {
        for projection in PROJECTIONS {
            let p = recipe(projection);
            for i in 0..50 {
                let x = 200.0 + f64::from(i) * 70.0;
                let y = 300.0 + f64::from(i % 7) * 180.0;
                let back = ray_to_canvas(&p, canvas_to_ray(&p, x, y)).expect("in front");
                assert!(
                    (back[0] - x).abs() < 1e-9 && (back[1] - y).abs() < 1e-9,
                    "{projection:?}: ({x}, {y}) came back as {back:?}"
                );
            }
        }
    }

    /// An unrotated source looks along the canvas's own axis, and the canvas's centre is its
    /// centre. Everything a solve produces is relative to this.
    #[test]
    fn the_reference_source_is_upright_and_centred() {
        for projection in PROJECTIONS {
            let p = recipe(projection);
            let centre = ray_to_source(&p.sources[0], [0.0, 0.0, 1.0]).expect("in front");
            assert!((centre[0] - 3000.0).abs() < 1e-9 && (centre[1] - 2000.0).abs() < 1e-9);
            let middle = canvas_to_ray(&p, 2000.0, 1000.0);
            assert!(middle[0].abs() < 1e-12 && middle[1].abs() < 1e-12 && middle[2] > 0.0);
        }
    }

    /// A pixel of a source and the ray it looks along are the same statement either way round.
    #[test]
    fn a_source_pixel_round_trips_through_its_rotation() {
        let mut source = recipe(Projection::Cylindrical).sources.remove(0);
        source.rotation = normalise(from_axis_angle([0.05, -0.4, 0.02]));
        for (x, y) in [(10.0, 20.0), (3000.0, 2000.0), (5900.0, 3900.0)] {
            let back = ray_to_source(&source, source_to_ray(&source, x, y)).expect("in front");
            assert!(
                (back[0] - x).abs() < 1e-7 && (back[1] - y).abs() < 1e-7,
                "{back:?}"
            );
        }
    }

    /// **The claim the whole single-file arm rests on**: a one-source recipe maps a canvas pixel
    /// to the same pixel of its source, so a window of one photograph composited through the
    /// recipe is that window of that photograph.
    ///
    /// Exactly, not closely - the mapping is the focal dividing and multiplying back out - so the
    /// bound here is f64's own noise rather than a tolerance anything was tuned to.
    #[test]
    fn a_one_source_recipe_is_the_photograph_itself() {
        for size in [
            [6000, 4000],
            [4000, 6000],
            [8192, 8192],
            [1, 1],
            [9504, 6336],
        ] {
            let spec = Composition::of_one(size, LensSpec::none());
            let source = &spec.sources[0];
            let (across, down) = (size[0] as f64, size[1] as f64);
            for i in 0..40 {
                let x = across * f64::from(i) / 40.0 + 0.25;
                let y = down * f64::from(i % 13) / 13.0 + 0.75;
                let at = ray_to_source(source, canvas_to_ray(&spec, x, y)).expect("in front");
                assert!(
                    (at[0] - x).abs() < 1e-9 && (at[1] - y).abs() < 1e-9,
                    "{size:?}: canvas ({x}, {y}) reached source {at:?}",
                );
            }
        }
    }

    /// A one-source recipe is gathered as the photograph's own window; anything else is projected.
    #[test]
    fn only_a_recipe_that_changes_nothing_is_direct() {
        let size = [6000, 4000];
        assert_eq!(
            placement(&Composition::of_one(size, LensSpec::none()), 0),
            Placement::Direct
        );
        // Through JSON, since that is how a recipe arrives from a peer.
        let text = serde_json::to_string(&Composition::of_one(size, LensSpec::none())).unwrap();
        let back: Composition = serde_json::from_str(&text).unwrap();
        assert_eq!(placement(&back, 0), Placement::Direct);

        let turned = Composition {
            sources: vec![SourceSpec {
                rotation: normalise(from_axis_angle([0.0, 0.2, 0.0])),
                ..Composition::of_one(size, LensSpec::none())
                    .sources
                    .remove(0)
            }],
            ..Composition::of_one(size, LensSpec::none())
        };
        assert_eq!(
            placement(&turned, 0),
            Placement::Projected,
            "a pointed source is projected"
        );

        let mut scaled = Composition::of_one(size, LensSpec::none());
        scaled.radians_per_pixel *= 2.0;
        assert_eq!(
            placement(&scaled, 0),
            Placement::Projected,
            "a canvas at another scale"
        );

        let mut bent = Composition::of_one(size, LensSpec::none());
        bent.projection = Projection::Cylindrical;
        assert_eq!(placement(&bent, 0), Placement::Projected, "a curved canvas");

        let mut off = Composition::of_one(size, LensSpec::none());
        off.centre[0] += 1.0;
        assert_eq!(
            placement(&off, 0),
            Placement::Projected,
            "a canvas framed off its source"
        );

        // Two sources, whatever either one of them says.
        let mut pair = Composition::of_one(size, LensSpec::none());
        pair.sources.push(pair.sources[0].clone());
        assert_eq!(placement(&pair, 0), Placement::Projected);
        assert_eq!(placement(&pair, 1), Placement::Projected);
        // And an index nothing is at.
        assert_eq!(placement(&pair, 7), Placement::Projected);
    }

    /// A level leaves at least `supersample` canvas pixels per stage pixel, so the draw minifies
    /// by less than two and reads the window's own buffer.
    #[test]
    fn a_level_covers_the_stage_it_was_chosen_for() {
        const SUPERSAMPLE: f64 = 1.5;
        for canvas_long in [4096, 6000, 9504, 14845, 30000, 61000] {
            let coarsest = coarsest_level(canvas_long);
            assert!(
                (canvas_long >> coarsest) <= COARSEST_LONG,
                "{canvas_long} at its coarsest is {} wide",
                canvas_long >> coarsest,
            );
            for stage_long in [640, 1280, 2560, 3840, 5760] {
                let level = level_of(canvas_long, stage_long, SUPERSAMPLE);
                assert!(
                    level <= coarsest,
                    "{canvas_long}/{stage_long} asked for level {level}"
                );
                let at = canvas_long >> level;
                let wanted = stage_long as f64 * SUPERSAMPLE;
                // Either it covers what the stage wants, or there is no level that does: 0 is the
                // finest the picture has and the coarsest is the deepest anything will prepare.
                assert!(
                    at as f64 >= wanted || level == 0 || level == coarsest,
                    "{canvas_long} at level {level} is {at} for a stage wanting {wanted}",
                );
                // And it is the *largest* such level: one deeper would not cover it.
                if level < coarsest {
                    assert!(
                        ((canvas_long >> (level + 1)) as f64) < wanted,
                        "{canvas_long}/{stage_long} could have gone to {}",
                        level + 1,
                    );
                }
            }
        }
    }

    /// A stage larger than the canvas asks for the canvas, and a degenerate one is answered
    /// rather than dividing by it.
    #[test]
    fn a_level_is_asked_for_sizes_nothing_chose() {
        assert_eq!(level_of(4096, 8192, 1.5), 0);
        assert_eq!(level_of(4096, 0, 1.5), coarsest_level(4096));
        assert_eq!(level_of(30000, 0, 1.5), coarsest_level(30000));
        assert_eq!(level_of(4096, 1280, 0.0), coarsest_level(4096));
        assert_eq!(level_of(4096, 1280, f64::NAN), coarsest_level(4096));
        assert_eq!(coarsest_level(1), 0);
        assert_eq!(coarsest_level(4096), 0);
        assert_eq!(coarsest_level(4097), 1);
    }

    /// A recipe is JSON on a stack row, so it has to survive the trip.
    #[test]
    fn a_recipe_round_trips_through_json() {
        let p = recipe(Projection::Equirectangular);
        let text = serde_json::to_string(&p).expect("a recipe serialises");
        assert!(text.contains("\"equirectangular\""), "{text}");
        let back: Composition = serde_json::from_str(&text).expect("a recipe parses");
        assert_eq!(back.canvas, p.canvas);
        assert_eq!(back.sources[0].photo_id, "one");
        assert_eq!(back.projection, Projection::Equirectangular);
    }
}
