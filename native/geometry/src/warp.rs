//! Where the warp reads: the reader's geometry over the corrected picture, and the rectangles a
//! window of it reads from the frame.

use crate::lens::{Lens, RATIO_TABLE_LAST, moves_pixels, ratio_table, ratio_tables};
use rayon::prelude::*;

/// The reader's own geometry, as a gather reads it.
///
/// Crop edges are fractions of the frame **after** the straighten, which is Camera Raw's
/// definition and the one `EditDocSchema` stores. `rotate` is quarter turns clockwise, applied
/// last - it only permutes the output grid, so it costs nothing and resamples nothing.
#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    /// Left, top, right, bottom, as fractions of the straightened frame.
    pub crop: [f64; 4],
    pub angle_degrees: f64,
    pub rotate: u16,
    /// The perspective correction, row-major with the ninth element dropped, or none.
    ///
    /// Corrected back to source and in fractions of the frame, which is the direction this
    /// gather reads and the units that make it mean the same at every rendition size. Applied
    /// under the straighten: it corrects where the camera stood, and the straighten and the crop
    /// are choices made about the picture that comes out of that.
    #[serde(default)]
    pub keystone: Option<[f64; 8]>,
}

impl Geometry {
    /// The whole frame, upright: what a photo nobody has cropped asks for.
    pub fn none() -> Self {
        Geometry {
            crop: [0.0, 0.0, 1.0, 1.0],
            angle_degrees: 0.0,
            rotate: 0,
            keystone: None,
        }
    }

    pub fn is_identity(&self) -> bool {
        self.crop == [0.0, 0.0, 1.0, 1.0]
            && self.angle_degrees == 0.0
            && self.rotate % 360 == 0
            && self.keystone.is_none()
    }
}

/// A point of the corrected picture, back where it came from in the frame.
///
/// In and out as offsets from the frame's centre in pixels, which is the only thing `Plan::at`
/// has to hand; the matrix itself is in fractions, so the frame's size goes on and comes back
/// off around it. `geometry.slang` says this again on the GPU - it is four lines, and the probe
/// holds the two together over every pixel of a frame.
fn keystoned(matrix: [f64; 8], fx: f64, fy: f64, full: (f64, f64)) -> (f64, f64) {
    let x = (fx + full.0 / 2.0) / full.0;
    let y = (fy + full.1 / 2.0) / full.1;
    let w = matrix[6] * x + matrix[7] * y + 1.0;
    let sx = (matrix[0] * x + matrix[1] * y + matrix[2]) / w;
    let sy = (matrix[3] * x + matrix[4] * y + matrix[5]) / w;
    (sx * full.0 - full.0 / 2.0, sy * full.1 - full.1 / 2.0)
}

/// Output pixel to a position in the corrected frame, before the lens ratio is applied.
#[derive(Clone, Copy)]
struct Plan {
    /// Half-diagonal of the *whole* corrected frame. The lens ratio is a function of radius
    /// there, so a crop must not shrink it - a cropped frame is a window on the same optics,
    /// not a smaller lens.
    half_full: f64,
    full: (f64, f64),
    origin: (f64, f64),
    stride: (f64, f64),
    cos: f64,
    sin: f64,
    rotate: u16,
    /// The perspective correction in *frame pixels*, or none. `Geometry` carries it in fractions.
    keystone: Option<[f64; 8]>,
}

impl Plan {
    /// Where output position `(x, y)` sits in the corrected frame, as an offset from its centre
    /// normalised by the full frame's half-diagonal - which is what the ratio table indexes.
    ///
    /// **Continuous coordinates, not pixel indices**: pixel `k` covers `[k, k+1)` and its centre
    /// is `k + 0.5`, at both ends. The turn's mirror is `span - c` in those units and would be
    /// `span - 1 - i` in indices, so the two conventions differ by a whole pixel under a turn -
    /// and `geometry.slang`, which has to work in the coordinates a fragment is given, can only
    /// have the continuous one. A caller iterating pixels passes `i as f64 + 0.5` and takes the
    /// half back off the frame position it gets.
    fn at(&self, x: f64, y: f64, out: (usize, usize)) -> (f64, f64) {
        // The quarter turn first, because it is a relabelling of the output grid rather than
        // a transform of the picture: undoing it here means everything below works in the
        // straightened frame's own axes.
        let (u, v) = match self.rotate % 360 {
            90 => (y, out.0 as f64 - x),
            180 => (out.0 as f64 - x, out.1 as f64 - y),
            270 => (out.1 as f64 - y, x),
            _ => (x, y),
        };

        // Into the straightened frame, then back through the straighten to the corrected one.
        // Rotating about the straightened frame's centre rather than the corrected frame's is
        // what makes the crop fractions mean what Camera Raw says they mean.
        let sx = self.origin.0 + u * self.stride.0;
        let sy = self.origin.1 + v * self.stride.1;
        let (cx, cy) = (self.straightened().0 / 2.0, self.straightened().1 / 2.0);
        let (rx, ry) = (sx - cx, sy - cy);
        let fx = rx * self.cos + ry * self.sin;
        let fy = -rx * self.sin + ry * self.cos;

        // Last, so it is first on the way the picture actually travels: the reader straightened
        // and cropped what they saw *after* the perspective was corrected.
        let (fx, fy) = match self.keystone {
            None => (fx, fy),
            Some(matrix) => keystoned(matrix, fx, fy, self.full),
        };

        (fx / self.half_full, fy / self.half_full)
    }

    /// The bounding box the straighten needs, which is the frame the crop is a fraction of.
    fn straightened(&self) -> (f64, f64) {
        let (w, h) = self.full;
        (
            w * self.cos.abs() + h * self.sin.abs(),
            w * self.sin.abs() + h * self.cos.abs(),
        )
    }

    /// The plan an output grid of `out` needs to show `geometry` of a frame of `full`.
    ///
    /// The one place the crop fractions become an origin and a stride. It was written out twice -
    /// once in the gather, once in what the shader is checked against - and two copies of the
    /// rule the whole probe exists to pin is the drift it was meant to catch.
    fn for_geometry(full: (f64, f64), out: (usize, usize), geometry: Geometry) -> Plan {
        let radians = geometry.angle_degrees.to_radians();
        let mut plan = Plan {
            half_full: ((full.0 / 2.0).powi(2) + (full.1 / 2.0).powi(2)).sqrt(),
            full,
            origin: (0.0, 0.0),
            stride: (1.0, 1.0),
            cos: radians.cos(),
            sin: radians.sin(),
            rotate: geometry.rotate,
            keystone: geometry.keystone,
        };

        // The crop, in the straightened frame the fractions are defined against. The output
        // grid spans exactly that rectangle, so its own size decides the stride.
        let (sw, sh) = plan.straightened();
        let [left, top, right, bottom] = geometry.crop;
        // The turn permutes which output axis spans which, so the stride is computed against
        // the grid before it - `Plan::at` undoes the turn first for the same reason.
        let (span_x, span_y) = match geometry.rotate % 360 {
            90 | 270 => (out.1, out.0),
            _ => (out.0, out.1),
        };
        plan.origin = (left * sw, top * sh);
        plan.stride = (
            (right - left) * sw / span_x.max(1) as f64,
            (bottom - top) * sh / span_y.max(1) as f64,
        );
        plan
    }
}

/// Where output pixel `(x, y)` sits in a frame of `full`, under `geometry`.
///
/// The mapping the host sizes a decode window with, and what the probe holds `geometry.slang`
/// to (`the_draw_places_a_pixel_where_the_gather_does`): the editor applies the same geometry
/// in its draw and cannot share this code - it is a shader - so the two are checked against
/// each other instead.
///
/// In frame pixels, where [`Plan::at`] returns the normalised offset the ratio table indexes;
/// the lens is the identity here, which is what the editor's already-warped frame has. Takes and
/// returns [`Plan::at`]'s continuous coordinates, so the probe can hand the shader the very same
/// numbers a fragment would carry.
pub fn geometry_at(
    full: (usize, usize),
    out: (usize, usize),
    geometry: Geometry,
    x: f64,
    y: f64,
) -> (f64, f64) {
    let (full_w, full_h) = (full.0 as f64, full.1 as f64);
    let plan = Plan::for_geometry((full_w, full_h), out, geometry);
    let (nx, ny) = plan.at(x, y, out);
    (
        full_w / 2.0 + nx * plan.half_full,
        full_h / 2.0 + ny * plan.half_full,
    )
}

/// [`geometry_at`] backwards: where a point of the frame lands on the output grid, which may be off
/// it where the geometry crops the point away.
pub fn output_at(
    full: (usize, usize),
    out: (usize, usize),
    geometry: Geometry,
    x: f64,
    y: f64,
) -> (f64, f64) {
    let (full_w, full_h) = (full.0 as f64, full.1 as f64);
    let plan = Plan::for_geometry((full_w, full_h), out, geometry);
    let (fx, fy) = match plan.keystone {
        None => (x - full_w / 2.0, y - full_h / 2.0),
        Some(matrix) => {
            let [a, b, c, d, e, f, g, h] = matrix;
            // The homography's inverse, as its adjugate: the scale it drops is divided out below.
            let inverse = [
                e - f * h,
                c * h - b,
                b * f - c * e,
                f * g - d,
                a - c * g,
                c * d - a * f,
                d * h - e * g,
                b * g - a * h,
                a * e - b * d,
            ];
            let (sx, sy) = (x / full_w, y / full_h);
            let w = inverse[6] * sx + inverse[7] * sy + inverse[8];
            let cx = (inverse[0] * sx + inverse[1] * sy + inverse[2]) / w;
            let cy = (inverse[3] * sx + inverse[4] * sy + inverse[5]) / w;
            (cx * full_w - full_w / 2.0, cy * full_h - full_h / 2.0)
        }
    };
    let (sw, sh) = plan.straightened();
    let rx = fx * plan.cos - fy * plan.sin;
    let ry = fx * plan.sin + fy * plan.cos;
    let u = (rx + sw / 2.0 - plan.origin.0) / plan.stride.0;
    let v = (ry + sh / 2.0 - plan.origin.1) / plan.stride.1;
    match plan.rotate % 360 {
        90 => (out.0 as f64 - v, u),
        180 => (out.0 as f64 - u, out.1 as f64 - v),
        270 => (v, out.1 as f64 - u),
        _ => (u, v),
    }
}

/// The part of the corrected photograph a geometry actually reads, as a whole-pixel rectangle.
///
/// **What lets a cropped render decode less of the picture.** Everything below the decode - the
/// denoise, the coding, the defringe, the lens gather - costs what it is given, and a photograph
/// cropped to a quarter has three quarters of that thrown away at the grade. This is the rectangle
/// worth keeping, and `job::Base::cropped` hands it to the same window machinery a loupe tile uses.
///
/// The output's *border* rather than every pixel of it: the crop, the straighten and the turn are
/// affine and the keystone is projective, and both map a convex region's boundary to its boundary -
/// so a sweep of the four edges bounds the interior. Grown by the resample's own reach before it is
/// rounded out, because the mapping lands on continuous positions and the Catmull-Rom around one
/// reads a pixel back and two forward.
///
/// Clamped to the photograph: a straighten reaches outside it at the corners, and there is nothing
/// there to decode.
pub fn geometry_footprint(
    full: (usize, usize),
    out: (usize, usize),
    geometry: Geometry,
) -> (usize, usize, usize, usize) {
    let band = Band {
        top: units::px::Place::measured(0),
        rows: units::px::Span::measured(out.1),
    };
    rows_footprint(
        units::px::Size::exact(full.0, full.1),
        units::px::Size::measured(out.0, out.1),
        geometry,
        band,
    )
    .raw()
}

/// [`geometry_footprint`] for some of the output's rows alone, which is what a band of a render
/// graded a band at a time reads.
pub fn rows_footprint(
    full: units::px::Size<units::px::Drawn>,
    out: units::px::Size<units::px::Output>,
    geometry: Geometry,
    band: Band,
) -> units::px::Rect<units::px::Drawn> {
    let (full, out) = (full.raw(), out.raw());
    let rows = band.top.raw()..(band.top + band.rows).raw();
    let (mut left, mut top) = (f64::MAX, f64::MAX);
    let (mut right, mut bottom) = (f64::MIN, f64::MIN);
    let mut visit = |x: usize, y: usize| {
        let (px, py) = geometry_at(full, out, geometry, x as f64 + 0.5, y as f64 + 0.5);
        left = left.min(px);
        top = top.min(py);
        right = right.max(px);
        bottom = bottom.max(py);
    };
    for x in 0..out.0 {
        visit(x, rows.start);
        visit(x, rows.end - 1);
    }
    for y in rows {
        visit(0, y);
        visit(out.0 - 1, y);
    }

    // The cubic reads `floor(p - 0.5) - 1` through `+ 2`, so two pixels back and three forward of
    // the position itself. Rounded out from there, and clamped: outside the photograph there is
    // nothing to decode, and the grade leaves those pixels black either way.
    const REACH: f64 = 3.0;
    let start = |v: f64, limit: usize| ((v - REACH).floor().max(0.0) as usize).min(limit);
    let end = |v: f64, limit: usize| (((v + REACH).ceil().max(0.0) as usize) + 1).min(limit);
    let (x0, y0) = (start(left, full.0), start(top, full.1));
    let (x1, y1) = (end(right, full.0), end(bottom, full.1));
    units::px::Rect::exact(
        x0,
        y0,
        x1.saturating_sub(x0).max(1),
        y1.saturating_sub(y0).max(1),
    )
}

/// The part of the frame a window of the corrected picture reads, as a whole-pixel rectangle in
/// the frame's own pixels.
///
/// **What a loupe tile needs from the lens.** A lens correction is a function of radius in the
/// *photograph*, so a tile is gathered as the frame's own gather would gather that window
/// (`base::Gather::window`) - and what has to be *decoded* to feed it is a bounds question the
/// host answers before there are any pixels: the same tables the gather reads, asked where they
/// reach. `warp.slang`'s Catmull-Rom reads two pixels either side of the position it lands on,
/// which is the margin below.
///
/// Every output pixel rather than the window's border: the ratio curve is not monotone for every
/// lens, so an extreme can sit inside the rectangle rather than on its edge, and a footprint that
/// missed one would leave a strip of black down the magnified picture. A tile whose region is too
/// small reads zeros at its edge, and the pins that hold it against the rendition fail on the
/// picture.
///
/// None where the lens is an identity, which is a caller that can decode its window and skip the
/// gather entirely.
pub fn lens_footprint(
    full: units::px::Size<units::px::Drawn>,
    window: units::px::Rect<units::px::Drawn>,
    lens: &Lens,
) -> Option<(usize, usize, usize, usize)> {
    if lens.is_identity() {
        return None;
    }
    const TAP: f64 = 2.0;
    let (full_w, full_h) = full.raw();
    let (left, top, width, height) = window.raw();
    let knots = lens.distortion.as_deref().unwrap_or_default();
    // A registered lens reads three identical tables, so it reads one: the walk below evaluates
    // every table at every pixel of the window, and two of the three would answer the same.
    let tables: Vec<Vec<f64>> = match lens.corrects_channels() {
        false => vec![ratio_table(knots, lens.crop)],
        true => ratio_tables(knots, lens.crop, &lens.channels()).into(),
    };
    let half = ((full_w as f64 / 2.0).powi(2) + (full_h as f64 / 2.0).powi(2)).sqrt();
    // The window as the plan already expresses a crop: an origin and a unit stride, in the
    // frame's own pixels, with no straighten or turn - those belong to the reader's geometry
    // and a tile is named in coordinates that already have them.
    let plan = Plan {
        half_full: half,
        full: (full_w as f64, full_h as f64),
        origin: (left as f64, top as f64),
        stride: (1.0, 1.0),
        cos: 1.0,
        sin: 0.0,
        rotate: 0,
        keystone: None,
    };
    // The photograph's centre half a pixel back, as `warp.slang`'s `Params::centre` has it: the
    // taps read a grid where an integer is a pixel's centre.
    let (centre_x, centre_y) = (full_w as f64 / 2.0 - 0.5, full_h as f64 / 2.0 - 0.5);
    let box_of = |a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)| {
        (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3))
    };
    let (read_left, read_top, read_right, read_bottom) = (0..height)
        .into_par_iter()
        .map(|y| {
            let mut bounds = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for x in 0..width {
                let at = plan.at(x as f64 + 0.5, y as f64 + 0.5, (width, height));
                for table in &tables {
                    let (sx, sy) = lens.read_from(at, |squared| ratio_at(table, squared));
                    let (px, py) = (centre_x + sx * half, centre_y + sy * half);
                    bounds = box_of(bounds, (px, py, px, py));
                }
            }
            bounds
        })
        .reduce(|| (f64::MAX, f64::MAX, f64::MIN, f64::MIN), box_of);
    let start = |v: f64| (v - TAP).floor().max(0.0) as usize;
    let end = |v: f64, limit: usize| ((v + TAP).ceil().max(0.0) as usize + 1).min(limit);
    let (x0, y0) = (start(read_left), start(read_top));
    Some((
        x0,
        y0,
        end(read_right, full_w) - x0,
        end(read_bottom, full_h) - y0,
    ))
}

/// A ratio table read at a squared radius, as `warp.slang` reads it.
fn ratio_at(table: &[f64], squared: f64) -> f64 {
    let t = squared * RATIO_TABLE_LAST as f64;
    let slot = if t < RATIO_TABLE_LAST as f64 {
        t as usize
    } else {
        RATIO_TABLE_LAST - 1
    };
    let low = table[slot];
    low + (table[slot + 1] - low) * (t - slot as f64)
}

/// Where the lens gather reads the frame for each of `points` of the corrected picture, through
/// green's table: positions stored on the picture as the lens left it, found on the decode.
pub fn lens_sources(
    full: units::px::Size<units::px::Drawn>,
    points: &[units::px::Point<units::px::Drawn>],
    lens: &Lens,
) -> Vec<units::px::Point<units::px::Drawn>> {
    if !moves_pixels(lens.distortion.as_deref(), lens.crop) {
        return points.to_vec();
    }
    let (full_w, full_h) = full.raw();
    let table = ratio_table(lens.distortion.as_deref().unwrap_or_default(), lens.crop);
    let half = ((full_w as f64 / 2.0).powi(2) + (full_h as f64 / 2.0).powi(2)).sqrt();
    let plan = Plan {
        half_full: half,
        full: (full_w as f64, full_h as f64),
        origin: (0.0, 0.0),
        stride: (1.0, 1.0),
        cos: 1.0,
        sin: 0.0,
        rotate: 0,
        keystone: None,
    };
    let source = |point: &units::px::Point<units::px::Drawn>| {
        let at = plan.at(point.x.raw(), point.y.raw(), (full_w, full_h));
        let (sx, sy) = lens.read_from(at, |squared| ratio_at(&table, squared));
        // The gather's grid puts a pixel's centre on an integer, a stored position its edge.
        units::px::Point {
            x: units::px::Coordinate::exactly(full_w as f64 / 2.0 + sx * half),
            y: units::px::Coordinate::exactly(full_h as f64 / 2.0 + sy * half),
        }
    };
    points.iter().map(source).collect()
}

/// What a frame measures once the reader's geometry is applied to it.
///
/// The Rust twin of `displaySize` in `schemas/display_size.ts`, and the same three steps in the
/// same order: straighten to the bounding box, crop as fractions of *that*, then the quarter
/// turn. The two have to agree, because the catalogue lays a grid tile out on one and the
/// encoder writes a file at the other - a disagreement is a tile that is the wrong shape for
/// the picture inside it.
///
/// Floored at one: the fractions are free to describe a rectangle narrower than a pixel at
/// tile size, and a rendition of no pixels is a failed encode rather than a small picture.
///
/// **Not a sub-rectangle of what went in.** A straighten's bounding box is larger than the frame it
/// was cut from, so what comes back is its own space - which is why `encode` indexes
/// `output_width` and a caller that sized a buffer off the frame instead under-allocated it.
pub fn cropped_out(
    frame: units::px::Size<units::px::Drawn>,
    geometry: Geometry,
) -> units::px::Size<units::px::Output> {
    let (width, height) = cropped_size(frame.width.raw(), frame.height.raw(), geometry);
    // The extent of a frame that is about to exist, which is the one thing `Output` can be given
    // from outside: its pixels are as large as the rendition is small, so nothing in that space
    // can be written down and everything else in it is derived from this.
    units::px::Size::measured(width, height)
}

pub fn cropped_size(width: usize, height: usize, geometry: Geometry) -> (usize, usize) {
    let radians = geometry.angle_degrees.to_radians();
    let (cos, sin) = (radians.cos().abs(), radians.sin().abs());
    let (sw, sh) = (
        width as f64 * cos + height as f64 * sin,
        width as f64 * sin + height as f64 * cos,
    );
    let [left, top, right, bottom] = geometry.crop;
    let w = sw * (right - left).max(0.0);
    let h = sh * (bottom - top).max(0.0);
    let turned = matches!(geometry.rotate % 360, 90 | 270);
    let (w, h) = if turned { (h, w) } else { (w, h) };
    ((w.round() as usize).max(1), (h.round() as usize).max(1))
}

/// A run of whole output rows.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Band {
    pub top: units::px::Place<units::px::Output>,
    pub rows: units::px::Span<units::px::Output>,
}

#[cfg(test)]
mod geometry_tests {
    use super::*;

    /// The frame pixel output pixel `(x, y)` reads, under `geometry`.
    fn read(
        full: (usize, usize),
        out: (usize, usize),
        geometry: Geometry,
        x: usize,
        y: usize,
    ) -> (usize, usize) {
        let at = geometry_at(full, out, geometry, x as f64 + 0.5, y as f64 + 0.5);
        (at.0.floor() as usize, at.1.floor() as usize)
    }

    #[test]
    fn a_crop_reads_the_rectangle_it_names() {
        // The right half, so the output's first column is the source's middle one.
        let geometry = Geometry {
            crop: [0.5, 0.0, 1.0, 1.0],
            ..Geometry::none()
        };

        // Sampled at the same scale, so this is a window rather than a resize: output x maps
        // to source x + 32.
        assert_eq!(
            read((64, 64), (32, 64), geometry, 0, 0),
            (32, 0),
            "the first column is the middle of the source"
        );
        assert_eq!(
            read((64, 64), (32, 64), geometry, 31, 63),
            (63, 63),
            "the last column and row are the source's last"
        );
    }

    #[test]
    fn a_quarter_turn_permutes_the_axes_without_resampling() {
        let geometry = Geometry {
            rotate: 90,
            ..Geometry::none()
        };

        // Clockwise: the output's top-left comes from the source's bottom-left.
        assert_eq!(read((64, 64), (64, 64), geometry, 0, 0), (0, 63));
    }

    #[test]
    fn a_turn_mirrors_the_grid_by_its_width_not_its_last_index() {
        // The half of this the GPU probe cannot reach: it skips itself where no adapter answers,
        // and it compares two implementations rather than either against an answer. `span - 1 - i`
        // reads right for indices and is a whole pixel out for the positions a fragment carries -
        // the far edge folds past zero and clamps, so the first column is drawn twice and the
        // last never is.
        let geometry = Geometry {
            rotate: 180,
            ..Geometry::none()
        };
        let full = (263usize, 171usize);
        for (x, y, want) in [
            (0usize, 0usize, (262usize, 170usize)),
            (262, 170, (0, 0)),
            (7, 5, (255, 165)),
        ] {
            let at = geometry_at(full, full, geometry, x as f64 + 0.5, y as f64 + 0.5);
            assert_eq!(
                (at.0.floor() as usize, at.1.floor() as usize),
                want,
                "output ({x}, {y})"
            );
        }
    }

    #[test]
    fn the_crop_is_a_fraction_of_the_straightened_frame() {
        // A 45-degree straighten on a square needs a box sqrt(2) wider, so a half-width crop
        // of *that* is wider than half the original. The alternative reading - fractions of
        // the frame before the straighten - would give 32 here and be wrong in the direction
        // nobody notices until a straightened crop comes out framed differently from the
        // editor's preview.
        let geometry = Geometry {
            crop: [0.0, 0.0, 0.5, 1.0],
            angle_degrees: 45.0,
            ..Geometry::none()
        };
        assert_eq!(super::cropped_size(64, 64, geometry), (45, 91));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A point of the frame taken onto the output and back is where it started, under every part of
    /// a geometry at once.
    #[test]
    fn a_point_comes_back_from_the_output_where_it_was() {
        let full = (600, 400);
        let keystone = Some([1.05, 0.02, -0.03, 0.01, 0.97, 0.02, 0.04, -0.03]);
        for rotate in [0, 90, 180, 270] {
            for keystone in [None, keystone] {
                let geometry = Geometry {
                    crop: [0.1, 0.05, 0.85, 0.9],
                    angle_degrees: 3.5,
                    rotate,
                    keystone,
                };
                let out = cropped_size(full.0, full.1, geometry);
                for (x, y) in [(0.5, 0.5), (17.0, 301.25), (out.0 as f64 - 3.0, 9.5)] {
                    let (px, py) = geometry_at(full, out, geometry, x, y);
                    let (bx, by) = output_at(full, out, geometry, px, py);
                    assert!(
                        (bx - x).abs() < 1e-6 && (by - y).abs() < 1e-6,
                        "({x}, {y}) came back at ({bx}, {by}) turned {rotate}, keystoned {}",
                        keystone.is_some(),
                    );
                }
            }
        }
    }

    /// A lens that moves pixels every way this gather can be asked to: a radial curve, a rescale,
    /// a vignette and a lateral shift per channel.
    fn bent() -> Lens {
        Lens {
            distortion: Some(vec![0.0, 0.004, 0.011, 0.022, 0.038]),
            crop: 1.02,
            falloff: Some((0.31, -0.04)),
            tca: Some([vec![0.0, 0.0004, 0.0009], vec![0.0, -0.0005, -0.0011]]),
            axis: [0.03, -0.02],
        }
    }

    /// A window's footprint is a region about the window, inside the frame, and never the
    /// whole frame: a loupe tile decodes what its gather reads and no more.
    #[test]
    fn a_window_footprint_is_the_region_its_gather_reads() {
        let (width, height) = (320usize, 240usize);
        let lens = bent();
        let full = units::px::Size::exact(width, height);

        assert!(
            lens_footprint(full, units::px::Rect::exact(40, 30, 64, 48), &Lens::none()).is_none()
        );

        let whole = lens_footprint(full, units::px::Rect::exact(0, 0, width, height), &lens)
            .expect("the lens bends");
        assert!(
            whole.0 + whole.2 <= width && whole.1 + whole.3 <= height,
            "{whole:?} is not inside the frame"
        );

        let region = lens_footprint(full, units::px::Rect::exact(40, 30, 64, 48), &lens)
            .expect("the lens bends");
        assert!(
            region.0 + region.2 <= width && region.1 + region.3 <= height,
            "{region:?} is not inside the frame"
        );
        // A 3.8% corner correction, a 2% crop and a lateral shift move a pixel a few from where
        // the window names it, so the region is the window and its taps, not the frame.
        assert!(
            region.2 < 64 + 16 && region.3 < 48 + 16,
            "{region:?} reads far past its window"
        );
        assert!(
            region.0 < 40 + 8 && region.1 < 30 + 8,
            "{region:?} starts far from its window"
        );
        assert!(
            region.0 + region.2 > 40 + 64 - 8 && region.1 + region.3 > 30 + 48 - 8,
            "{region:?} ends short of its window"
        );
    }
}
