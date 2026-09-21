// The crate's resampling and pixel maths: the reduce, the radial tables the warp reads and the
// spline they follow, and the numbers the render's defringe and sharpen are built on. The codecs are
// their own modules - `jpeg` in Rust, `avif` over libavif - and `decode` below is the one
// entry point that picks between them.

use crate::parallel::*;
use crate::rgb::{Rgb, RgbRef};

pub const SPLINE_UNIT: f64 = 16384.0;

/// Entries in the lookup the warp indexes by r^2. Radii are normalised to the
/// half-diagonal, so r^2 runs exactly 0..1 over the frame and the table needs no
/// range beyond that. 4096 puts a 16-knot spline's kinks several buckets apart,
/// well below the bilinear sampling that follows.
pub(crate) const RATIO_TABLE_LAST: usize = 4096;

/// A spline read at a radius, as the fraction it displaces by. 0 where it is empty.
///
/// The knots are evenly spaced from centre to corner and interpolated linearly, which
/// is the one convention every producer of them shares: a camera's recorded spline, a
/// curve sampled out of lensfun, and a constant scale written as a flat array.
pub fn spline_at(knots: &[f64], radius: f64) -> f64 {
    if knots.is_empty() {
        return 0.0;
    }
    let last = (knots.len() - 1) as f64;
    let position = (radius * last).clamp(0.0, last);
    let index = position.floor() as usize;
    let next = (index + 1).min(knots.len() - 1);
    let value = knots[index] + (knots[next] - knots[index]) * (position - index as f64);
    value / SPLINE_UNIT
}

pub fn sample_radius(knots: &[f64], radius: f64, crop: f64) -> f64 {
    crop * radius * (1.0 + spline_at(knots, radius))
}

/// A radial correction per channel, in `SPLINE_UNIT`s, indexed red, green, blue.
///
/// Empty means that channel needs none, which green's always is: the lateral aberration
/// is expressed as what red and blue do *relative to* green, so green is the reference
/// and moves only with the distortion every channel shares.
pub type Channels = [Vec<f64>; 3];

/// Channels that need nothing beyond the distortion, which is most frames.
pub fn registered() -> Channels {
    [Vec::new(), Vec::new(), Vec::new()]
}

/// Whether any channel asks to be read at its own radius.
pub fn is_registered(channels: &Channels) -> bool {
    channels
        .iter()
        .all(|knots| knots.iter().all(|knot| *knot == 0.0))
}

/// The largest crop that still fills the frame.
///
/// A correction that pulls the corners inward leaves black behind them, which no camera
/// ships: it scales the picture up until the frame is full again.
///
/// A ray from the centre leaves the frame at its own boundary radius, and those run from
/// the short half-edge out to the corner, so they are the radii that have to contain
/// something. What they have to contain is the *furthest* the curve reaches anywhere
/// along the ray, not where it lands at the end - a mustache profile can bulge past the
/// short edge in mid-field with its corner sitting comfortably inside, and reading the
/// far radii alone would call that a full frame. Hence the running maximum, which for
/// the monotone curves real lenses produce is just the value at that radius. Never above
/// 1, since a crop above 1 pulls the whole frame in.
pub fn fill_crop(knots: &[f64], width: usize, height: usize) -> f64 {
    // Every knot lands exactly on a sample, and so does the short edge. Both are places
    // the answer turns: the spline is linear between its knots, so a kink is where a
    // bulge peaks, and the short edge is the tightest boundary radius there is. A grid
    // that straddles either reads it low - by 0.4% on a spike steep enough to matter,
    // which is a crop 0.4% too loose and black back in the corners.
    let steps = (knots.len().max(2) - 1) * 32;
    let half = ((width as f64 / 2.0).powi(2) + (height as f64 / 2.0).powi(2)).sqrt();
    let short_edge = (width.min(height) as f64 / 2.0) / half;
    let mut radii: Vec<f64> = (0..=steps).map(|step| step as f64 / steps as f64).collect();
    radii.push(short_edge);
    radii.sort_by(f64::total_cmp);

    let (mut reach, mut crop) = (0.0f64, 1.0f64);
    for radius in radii {
        reach = reach.max(sample_radius(knots, radius, 1.0));
        if radius >= short_edge && reach > 0.0 {
            crop = crop.min(radius / reach);
        }
    }
    match crop < 1.0 {
        // A sixteenth of a pixel on a 6000px frame, and the crop is not exact without it: the warp
        // gathers through a 4096-entry f32 table where this walks the spline in f64, so a crop
        // that touches the boundary exactly here lands a ulp outside it there and
        // `warp.slang`'s bounds test leaves the corner black. Which side of the boundary that
        // ulp falls on is the adapter's FMA contraction, so without this the black corner is
        // on one GPU and not the next. Untouched at 1: shaving a crop nothing distorts would
        // turn `moves_pixels` true for every undistorted photograph.
        true => crop * (1.0 - 1e-5),
        false => crop,
    }
}

/// Whether a curve and a crop describe anything other than leaving the picture alone.
///
/// A crop with no curve is still a geometry - a rescale - so `knots.is_none()` is not
/// the question, and asking it that way drops the scale a fit found for a frame whose
/// curve it declined.
pub fn moves_pixels(knots: Option<&[f64]>, crop: f64) -> bool {
    crop != 1.0 || knots.is_some_and(|knots| knots.iter().any(|knot| *knot != 0.0))
}

/// `sample_radius(r) / r` sampled over r^2, which is the form the warp wants: it
/// has dx and dy so it has r^2 for free, and the table skips a sqrt, a walk along
/// the spline and a division at every pixel.
fn ratio_table(knots: &[f64], crop: f64) -> Vec<f64> {
    channel_ratio_table(knots, &[], crop)
}

/// The same, with one channel's lateral correction folded in.
///
/// Both are radial multipliers on the radius a pixel is read from, so they compose by
/// multiplication and one table answers for both - the warp does not need to know that
/// two separate corrections went into it.
fn channel_ratio_table(knots: &[f64], channel: &[f64], crop: f64) -> Vec<f64> {
    (0..=RATIO_TABLE_LAST)
        .map(|slot| {
            let radius = (slot as f64 / RATIO_TABLE_LAST as f64).sqrt();
            // At the centre the distortion contributes the crop alone: its spline is
            // anchored at zero there, and dividing a zero radius by itself is not
            // defined. A lateral scale is not anchored - a channel imaged larger is
            // larger everywhere - so it multiplies in at every radius including this
            // one.
            let base = if radius == 0.0 {
                crop
            } else {
                sample_radius(knots, radius, crop) / radius
            };
            base * (1.0 + spline_at(channel, radius))
        })
        .collect()
}

/// The three tables a gather reads, whichever gather it is.
///
/// The distortion and the lateral correction are both radial multipliers on the radius a pixel is
/// read from, so they compose into one table per channel and no gather learns that two corrections
/// went into it. A registered lens leaves three copies of the same numbers, which is two tables of
/// 4097 doubles against a branch every pixel would take.
pub(crate) fn ratio_tables(knots: &[f64], crop: f64, channels: &Channels) -> [Vec<f64>; 3] {
    std::array::from_fn(|c| channel_ratio_table(knots, &channels[c], crop))
}

/// Lanczos3 reduce onto an exact grid, on the host.
///
/// **The callers are the ones with no device to reach for**: a plane a CPU codec has just handed
/// back, bounded before anything else sees it, and `ffi::bb_selftest`, which probes the vectorised
/// code in a throwaway process. Everything a fit resamples is `fit_grids.slang`'s, written to this
/// filter's conventions and pinned against it.
///
/// **A warp is not a substitute, and reaching for one here was a real bug.** A bilinear
/// gather reads two taps per axis, so reducing 6000x4000 to 1280 with it reads four of every
/// hundred source pixels and aliases the rest into the result: against this reduce it came
/// out mean 12.4 of 255 off, worst 241. A fit built on those grids picked a different lens
/// tier on IMG_5360 than one built on a real reduce. Two taps are right where a warp *warps*
/// - small displacements on prefiltered pixels - and wrong the moment the grid shrinks.
///
/// Lanczos3 because that is what libvips gave the renditions before this replaced it, and
/// it lands within 1 of 255 of it. Also 17x cheaper in CPU: 15ms against 255ms on that
/// same reduction, since this is a SIMD integer kernel rather than a general tiled
/// float pipeline. Single-threaded: already milliseconds, and the callers are inside their
/// own parallelism.
pub fn resize(source: RgbRef<'_>, width: usize, height: usize) -> Rgb {
    if width == 0 || height == 0 || source.width == 0 || source.height == 0 {
        return Rgb {
            width,
            height,
            data: vec![0u8; width * height * 3],
        };
    }
    if (width, height) == (source.width, source.height) {
        return Rgb {
            width,
            height,
            data: source.data.to_vec(),
        };
    }
    let src = fast_image_resize::images::ImageRef::new(
        source.width as u32,
        source.height as u32,
        source.data,
        fast_image_resize::PixelType::U8x3,
    )
    .unwrap_or_else(|_| {
        panic!(
            "a {}x{} plane needs {} bytes, got {}",
            source.width,
            source.height,
            source.width * source.height * 3,
            source.data.len()
        )
    });
    let mut destination = fast_image_resize::images::Image::new(
        width as u32,
        height as u32,
        fast_image_resize::PixelType::U8x3,
    );
    let options = fast_image_resize::ResizeOptions::new().resize_alg(
        fast_image_resize::ResizeAlg::Convolution(fast_image_resize::FilterType::Lanczos3),
    );
    fast_image_resize::Resizer::new()
        .resize(&src, &mut destination, Some(&options))
        .expect("a resize between two RGB planes of known size");
    Rgb {
        width,
        height,
        data: destination.into_vec(),
    }
}

/// Decodes an encoded file, bounded to `long_edge` on its longest side. 0 decodes it whole.
///
/// Two formats, because two is all this app writes: a JPEG is a camera's embedded preview,
/// an AVIF is one of our own renditions on its way to a download. Sniffed rather than taken
/// from the caller - the callers that need this hold a path, and a library holds more than
/// one format - and refused outright rather than guessed at, since the alternative is a
/// decoder failing deep inside a job with nothing about the file in the message.
///
#[cfg(feature = "renditions")]
/// Server-side only: the bound to a JPEG belongs to `jpeg::decode`, and it is AVIF that
/// needs libavif, which the client does not link.
pub fn decode(bytes: &[u8], long_edge: usize) -> Result<Rgb, String> {
    // The `ftyp` box, at offset 4 because the first four bytes are its own length.
    let is_avif = bytes.len() > 12 && &bytes[4..8] == b"ftyp";
    match (bytes.starts_with(&[0xFF, 0xD8]), is_avif) {
        (true, _) => crate::jpeg::decode(bytes, long_edge),
        (_, true) => crate::avif::decode(bytes).map(|image| fitted(image, long_edge)),
        _ => Err("not a JPEG or an AVIF".to_string()),
    }
}

/// Longest-edge fit, preserving aspect. 0 leaves the image alone.
///
/// Only ever shrinks. Nothing here wants an enlargement - a rendition is bounded by the
/// frame it came from - and a body that embeds a preview smaller than the bound would
/// otherwise have it upscaled into invented detail.
/// `resize_to_fit` for a frame the caller owns, handing it straight back when it already
/// fits. Worth its own function because the copy it avoids is the whole frame - an
/// unbounded decode of a 61MP embedded preview is 170MB of it.
pub fn fitted(frame: Rgb, long_edge: usize) -> Rgb {
    match long_edge {
        0 => frame,
        edge if frame.width.max(frame.height) <= edge => frame,
        edge => resize_to_fit(frame.as_ref(), edge),
    }
}

pub fn resize_to_fit(source: RgbRef<'_>, long_edge: usize) -> Rgb {
    let longest = source.width.max(source.height);
    if long_edge == 0 || longest <= long_edge {
        return Rgb {
            width: source.width,
            height: source.height,
            data: source.data.to_vec(),
        };
    }
    let scaled = |dimension: usize| {
        usize::try_from(dimension as u64 * long_edge as u64 / longest as u64)
            .expect("a resized dimension must fit the address space")
            .max(1)
    };
    resize(source, scaled(source.width), scaled(source.height))
}

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
        visit(x, 0);
        visit(x, out.1 - 1);
    }
    for y in 0..out.1 {
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
    (
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
    full: crate::px::Size<crate::px::Drawn>,
    window: crate::px::Rect<crate::px::Drawn>,
    lens: &crate::fit::Lens,
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
                let (dx, dy) = plan.at(x as f64 + 0.5, y as f64 + 0.5, (width, height));
                let t = (dx * dx + dy * dy) * RATIO_TABLE_LAST as f64;
                let slot = if t < RATIO_TABLE_LAST as f64 {
                    t as usize
                } else {
                    RATIO_TABLE_LAST - 1
                };
                for table in &tables {
                    let low = table[slot];
                    let ratio = low + (table[slot + 1] - low) * (t - slot as f64);
                    let px = centre_x + dx * ratio * half;
                    let py = centre_y + dy * ratio * half;
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

/// The resample's own blur, as a Gaussian sigma in output pixels, and the whole answer
/// where no capture sigma was measured.
///
/// This is **capture sharpening's** question, not creative sharpening's: what spread did
/// the resample, the demosaic and the lens put on a point, and can it be taken back off.
/// A deep downscale to the rendition's size is most of it there; at 1:1 the capture's own
/// spread is all of it, which is what [`deconvolve_split`] interpolates between.
/// RawTherapee's equivalent defaults near this and uses a 5x5 kernel below radius 0.84,
/// which is what the tap count works out to.
pub const DECONVOLVE_SIGMA: f32 = 0.7;

/// What the Detail panel's Sharpening slider asks for at the top of its track.
///
/// The blend is a fraction of the supported recovered estimate, so the middle of the track applies
/// its accepted correction and the top extrapolates to twice that difference, with
/// [`SHARPEN_OVERSHOOT`] holding what it pushes past a neighbourhood's range.
pub const SHARPEN_GAIN: f64 = 2.0;

/// How far past its neighbourhood's range a sharpened pixel may go, as a share of that range;
/// zero is the hard clamp. `sharpen.slang`'s `limited` says what the hard clamp costs.
pub const SHARPEN_OVERSHOOT: f64 = 1.0;

/// The sigma the deconvolution should undo, at the frame it actually runs over.
///
/// `composed` is the whole answer for a flat field; where the lens warp is in the chain its
/// per-pixel Jacobian stretches the `terms` instead, since the capture's blur is uniform in
/// the *source* and a corner the correction stretched carries proportionally wider blur.
/// `terms` is None where nothing was measured, and the fixed default rules alone.
#[derive(Clone, Copy)]
pub struct SharpenSigma {
    pub composed: f32,
    /// `(capture at this scale, the resample's own spread)`, recomposed per pixel by
    /// `sharpen.slang` under the warp's local derivative.
    pub terms: Option<(f32, f32)>,
}

/// Sensor noise carried to the raster and coding capture sharpening reads.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SharpenNoise {
    pub(crate) sensitivity: [[f32; 3]; 3],
    pub(crate) shot_per_light: [f32; 3],
    pub(crate) read_variance: [f32; 3],
    pub(crate) reduction: usize,
}

impl SharpenNoise {
    pub const NONE: SharpenNoise = SharpenNoise {
        sensitivity: [[0.0; 3]; 3],
        shot_per_light: [0.0; 3],
        read_variance: [0.0; 3],
        reduction: 1,
    };

    pub fn at(
        self,
        sensor: crate::px::Span<crate::px::Sensor>,
        drawn: crate::px::Span<crate::px::Drawn>,
    ) -> SharpenNoise {
        let reduction = self.reduction.max(1);
        let decoded = sensor.raw().div_ceil(reduction).max(1);
        let linear = drawn.raw().min(decoded) as f32 / decoded as f32;
        let area = linear * linear;
        let samples = match reduction {
            2 => [1.0, 2.0, 1.0],
            3 => [1.0, 5.0, 1.0],
            _ => [1.0; 3],
        };
        SharpenNoise {
            shot_per_light: std::array::from_fn(|channel| {
                self.shot_per_light[channel] * area / samples[channel]
            }),
            read_variance: std::array::from_fn(|channel| {
                self.read_variance[channel] * area / samples[channel]
            }),
            ..self
        }
    }
}

impl Default for SharpenNoise {
    fn default() -> Self {
        SharpenNoise::NONE
    }
}

impl SharpenSigma {
    pub fn fixed(composed: f32) -> SharpenSigma {
        SharpenSigma {
            composed,
            terms: None,
        }
    }
}

/// [`SharpenSigma`] from the capture's own measurement, or the fixed default without one.
///
/// The capture's blur is measured on the mosaic in sensor pixels; a downscale by `k`
/// narrows it to `capture / k` and adds the resample kernel's own spread, which is fixed
/// in *output* pixels and vanishes as `k` reaches one. In quadrature, with the resample
/// term scaled by `(k^2 - 1) / k^2` so the composition is exact at both ends:
/// `k = 1` gives the capture sigma alone, a deep downscale gives [`DECONVOLVE_SIGMA`],
/// which is the tuned value this pipeline always sharpened deep downscales with.
///
/// Clamped to the range the 5-tap kernel is honest for; a missing measurement falls back
/// to the fixed sigma, which is yesterday's behaviour exactly.
pub fn deconvolve_split(capture: Option<f32>, sensor_long: usize, out_long: usize) -> SharpenSigma {
    let Some(capture) = capture else {
        return SharpenSigma::fixed(DECONVOLVE_SIGMA);
    };
    let k = (sensor_long.max(1) as f32 / out_long.max(1) as f32).max(1.0);
    let capture_here = capture / k;
    let resample = (DECONVOLVE_SIGMA * DECONVOLVE_SIGMA * (k * k - 1.0)).sqrt() / k;
    SharpenSigma {
        composed: (capture_here * capture_here + resample * resample)
            .sqrt()
            .clamp(0.3, 0.84),
        terms: Some((capture_here, resample)),
    }
}

/// The edge-width histogram's bins and the widest rise one can hold, in pixels. Both are
/// `edge_spread.slang`'s, pinned by a test.
pub(crate) const EDGE_SPREAD_BINS: usize = 256;
pub(crate) const EDGE_SPREAD_CEIL: f32 = 8.0;

/// How far a rise may climb before it stops being one edge. The shader's, and what decides how
/// much of the frame's border has no room to be measured.
pub(crate) const EDGE_SPREAD_RUN: usize = 8;

/// The 10-90 distance of a Gaussian's own edge, in sigmas.
pub(crate) const EDGE_SPREAD_PER_SIGMA: f32 = 2.563;

/// What fraction of a frame's edges is taken to be the optics rather than the scene.
///
/// A scene edge can be softer than the point spread and never harder, so the *sharpest* of them
/// are the measurement and everything above is a soft subject. A decile rather than the minimum:
/// the narrowest rise in sixty million belongs to whichever noise spike cleared the guards.
const EDGE_SPREAD_QUANTILE: f64 = 0.1;

/// The capture's blur, off a mapped copy of that histogram, or None where the frame offered too
/// few edges or an answer outside what a lens does.
pub(crate) fn edge_spread_sigma(mapped: &[u8]) -> Option<f32> {
    let bins: Vec<u64> = mapped
        .chunks_exact(4)
        .map(|word| u64::from(u32::from_le_bytes([word[0], word[1], word[2], word[3]])))
        .collect();
    let total: u64 = bins.iter().sum();
    // A frame with almost no edges is not a soft frame, it is an unanswered question, and the
    // fixed sigma is the better answer than a decile of noise. Low, though: a whole-frame pass
    // over a 24MP fixture of hillside and haze voted 918 times and read 0.94 against an
    // independent probe's 0.96, so a floor in the thousands would have thrown that away.
    if total < 500 {
        return None;
    }
    let want = ((total as f64 * EDGE_SPREAD_QUANTILE) as u64).max(1);
    let mut seen = 0u64;
    for (bin, count) in bins.iter().enumerate() {
        seen += count;
        if seen >= want {
            let width = (bin as f32 + 0.5) / EDGE_SPREAD_BINS as f32 * EDGE_SPREAD_CEIL;
            let sigma = width / EDGE_SPREAD_PER_SIGMA;
            return (0.2..=2.0).contains(&sigma).then_some(sigma);
        }
    }
    None
}

/// Richardson-Lucy iterations, each two steps (`sharpen_correct` squares its correction).
///
/// **Four dispatches each, so this is most of what the sharpen costs**: 400ms of a 24MP render at
/// ten, against the whole GALOSH denoise's 396ms. Fewer iterations under a larger gain is not the
/// same picture once the estimate is unregularised: the extrapolation then amplifies the whole
/// unconverged difference, grain included, where more iterations recover edges first.
///
/// It is also a halo: [`Strengths::halo`] is `2·RADIUS·this + RADIUS`, so a loupe tile grows its
/// decode window by it - a 400px tile decodes 484 square.
pub(crate) const DECONVOLVE_ITERATIONS: usize = 10;

/// Half-width of the point spread, in taps. See `gaussian`.
///
/// **Taps and not pixels**: this is how many samples the stencil reads, and what decides how much
/// picture they span is the sigma, which [`deconvolve_split`] composes per scale and clamps to
/// what five of them are honest for. `sharpen.slang` declares it in the same unit.
pub(crate) const DECONVOLVE_TAPS: crate::px::Span<crate::px::Tap> = crate::px::Span::exact(2);

/// The same as a plain count, for the arithmetic that indexes with it.
pub(crate) const DECONVOLVE_RADIUS: usize = DECONVOLVE_TAPS.raw();

/// BT.709's luma weights, used on a Rec.2020 frame too.
///
/// They decide how much of an edge each channel is credited with and which part of a
/// pixel counts as its colour, not what colour anything is; the two sets differ by less
/// than either knob here does.
///
/// **The one copy.** The geometry fit, the falloff fit and the stacking descriptor all
/// carried their own, which is three chances for them to drift apart and no way to tell
/// that they had. Not to be confused with the Y row of an sRGB-to-XYZ matrix, which is
/// the same three numbers meaning something else and stays with its matrix
/// (`hdr_fit::SRGB_TO_XYZ`).
pub const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];

/// How far a reconstruction's per-channel noise tracks each other channel's, as Pearson
/// coefficients indexed by channel pair.
///
/// Measured on RCD by `examples/defringe_noise`; a different demosaic needs them measured again.
pub(crate) const DEMOSAIC_CHANNEL_CORRELATION: [[f64; 3]; 3] =
    [[1.0, 0.63, 0.45], [0.63, 1.0, 0.63], [0.45, 0.63, 1.0]];

/// What a five-point Laplacian of luma returns over reconstructed noise, as a multiple of luma's
/// own variance.
///
/// Not the stencil's own `1+1+1+1+16`: that holds only where no two of the five share a photosite,
/// and a demosaic builds the neighbours out of the centre's. Measured over pure reconstructed grain
/// by `examples/defringe_noise`, two Sony bodies and a Canon giving 7.46 to 7.59.
pub(crate) const NOISE_CURVATURE_PER_VARIANCE: f64 = 7.53;

/// Indexed by channel; green is never asked, its response being identically zero.
///
/// Fitted against `defocus.slang`'s summed terms, where they are applied. A per-pixel expectation of
/// the same quantity comes to about four times these and raising them to it puts blue's coefficient
/// back on the decline with grain they were fitted to remove.
pub(crate) const NOISE_RESPONSE_PER_VARIANCE: [f64; 3] = [0.045, 0.0, 0.21];

/// The reconstruction's noise covariance, from each channel's measured variance and the
/// correlations the lattice and the camera matrix between them imply.
///
/// `variance` is read off the frame the defringe sees, which is past the matrix; the correlations
/// are not, so only they are carried through it. Passing no matrix leaves the lattice's own.
pub(crate) fn noise_covariance(variance: [f64; 3], matrix: Option<[[f32; 3]; 3]>) -> [[f64; 3]; 3] {
    let correlation = matrix.map_or(DEMOSAIC_CHANNEL_CORRELATION, correlation_through);
    let mut sigma = [[0f64; 3]; 3];
    for (a, row) in sigma.iter_mut().enumerate() {
        for (b, cell) in row.iter_mut().enumerate() {
            *cell = correlation[a][b] * (variance[a] * variance[b]).sqrt();
        }
    }
    sigma
}

/// What RCD leaves each channel's noise at, relative to the loudest. Only the ratios are read.
const DEMOSAIC_CHANNEL_GAIN: [f64; 3] = [1.0, 0.903, 1.0];

/// The correlations alone, carried through a camera matrix.
///
/// Correlations only: `sigma_from`'s variances are measured past `assemble` already, and sending
/// those through too applies the matrix twice, which inflates the correction until every bin's
/// curvature energy is subtracted away.
fn correlation_through(matrix: [[f32; 3]; 3]) -> [[f64; 3]; 3] {
    let m = |r: usize, c: usize| f64::from(matrix[r][c]);
    let before = |a: usize, b: usize| {
        DEMOSAIC_CHANNEL_CORRELATION[a][b] * DEMOSAIC_CHANNEL_GAIN[a] * DEMOSAIC_CHANNEL_GAIN[b]
    };
    let after = |r: usize, c: usize| -> f64 {
        (0..3)
            .flat_map(|a| (0..3).map(move |b| (a, b)))
            .map(|(a, b)| m(r, a) * before(a, b) * m(c, b))
            .sum()
    };
    let spread: Vec<f64> = (0..3)
        .map(|c| after(c, c).max(f64::MIN_POSITIVE).sqrt())
        .collect();
    let mut out = [[0f64; 3]; 3];
    for (r, row) in out.iter_mut().enumerate() {
        for (c, cell) in row.iter_mut().enumerate() {
            *cell = (after(r, c) / (spread[r] * spread[c])).clamp(-1.0, 1.0);
        }
    }
    out
}

/// BT.709 luma of a triple, in whatever domain and scale the caller's values are.
///
/// `f64` because every caller outside this module works there. `edge_spread.slang` computes the
/// same weighted sum on the device, and sums before it divides for the same reason this does.
pub fn luma709(r: f64, g: f64, b: f64) -> f64 {
    f64::from(LUMA[0]) * r + f64::from(LUMA[1]) * g + f64::from(LUMA[2]) * b
}

/// Normalised Gaussian taps for `sigma`, from the centre outwards, out to `radius`.
///
/// The radius is given rather than derived from the sigma because the point spread this
/// deconvolves is truncated on purpose: a 3-sigma tail contributes a thousandth of the
/// kernel and costs a third of every convolution, and this one runs forty times. Two is
/// the 5x5 RawTherapee uses below radius 0.84.
pub(crate) fn gaussian(sigma: f32, radius: usize) -> Vec<f32> {
    let taps: Vec<f32> = (0..=radius)
        .map(|d| (-((d * d) as f32) / (2.0 * sigma * sigma)).exp())
        .collect();
    let sum: f32 = taps[0] + 2.0 * taps[1..].iter().sum::<f32>();
    taps.into_iter().map(|t| t / sum).collect()
}

/// Bins in the noise estimate's histogram, over a high-pass magnitude of 0..`NOISE_MAX`.
pub(crate) const NOISE_BINS: usize = 1024;
pub(crate) const NOISE_MAX: f32 = 0.08;

/// Where the noise estimate stops believing itself, with no measurement to say.
///
/// A frame that is *mostly* fine detail - a wall of close stripes - has a large median
/// residual that is signal rather than noise. Sensor noise surviving a demosaic and a
/// resample does not reach 2% of full scale, so past that this is reading texture.
const NOISE_CEILING: f32 = 0.02;

/// How much larger a reconstructed channel's noise can be than the mosaic's own sigma. Measured at
/// 0.93 to 1.03 by `examples/defringe_noise`, the rest headroom for a less kind matrix.
///
/// Widening it does not make the bound safer, it makes it inert: what it holds down is a median
/// that has wandered into texture, and a few times the real ratio loses every frame past ISO 800.
const NOISE_OVER_MOSAIC: f32 = 1.25;

/// The ceiling [`sigma_from`] should hold itself to on a frame whose noise has been fitted.
pub(crate) fn noise_ceiling(fit: Option<crate::galosh::NoiseFit>) -> f32 {
    // Not floored at `NOISE_CEILING`: a high-ISO frame carries more grain than that guess, and
    // holding a measurement down to it tells the estimate the noise is smaller than the frame
    // demonstrably has.
    fit.map_or(NOISE_CEILING, |fit| {
        fit.model().at_white() * NOISE_OVER_MOSAIC
    })
}

/// How much of a pixel's own noise survives subtracting a 3x3 mean of its neighbourhood.
///
/// A demosaic builds the eight neighbours partly out of the photosites under the centre, so the
/// mean predicts the centre better than independent grain allows and the residual keeps less of it.
/// Measured at 0.598 and 0.599 over pure reconstructed grain by `examples/defringe_noise`,
/// unchanged from a mosaic sigma of 0.005 to 0.02.
const RESIDUAL_KEEPS: f32 = 0.60;

/// A plane's noise level, off a histogram of high-pass magnitudes.
///
/// The standard estimator from wavelet shrinkage: take a high-pass residual and read its
/// **median** absolute value rather than its mean. The median is what makes it work on a
/// photograph - edges and texture are a minority of pixels and arbitrarily large, so they
/// drag a mean anywhere, while the median sits among the ordinary pixels where the only
/// signal is noise. The 1.4826 recovers a Gaussian sigma from that median.
///
/// **The median is taken over the pixels that vary at all.** A pixel whose residual is
/// *exactly* zero is not a quiet noise sample; it is a pixel with no high-frequency content
/// whatsoever - clipped sky, a black letterbox, a blown highlight - and it says nothing
/// about the noise. Counting them, a frame that is half blown sky puts the median in that
/// flat half and reports zero noise.
///
/// The denoise this was written for runs on the mosaic now and fits its own model
/// (`crate::galosh`); what still asks is the defringe, which needs each channel's noise to
/// debias its regression.
pub(crate) fn sigma_from(bins: &[u32], ceiling: f32) -> f32 {
    // Bin 0 is a residual under 0.008% of full scale, which is below a quantisation step
    // at any depth this runs at - so it is the "did not vary at all" bin, and the median
    // is taken over everything above it.
    let varying: u32 = bins[1..].iter().sum();
    if varying == 0 {
        return 0.0;
    }
    // Floored at one, or a frame with a single varying pixel takes the first bin
    // whatever its count - returning the minimum rather than the median.
    let half = (varying / 2).max(1);
    let mut seen = 0u32;
    let median = bins[1..]
        .iter()
        .position(|count| {
            seen += count;
            seen >= half
        })
        .map(|slot| slot + 1)
        .unwrap_or(1) as f32
        * NOISE_MAX
        / NOISE_BINS as f32;
    (median * 1.4826 / RESIDUAL_KEEPS).min(ceiling)
}

/// Samples of real curvature the estimate needs before it will believe itself.
pub(crate) const DEFOCUS_MIN_SAMPLES: usize = 2000;

/// Every nth pixel in each direction the estimate reads.
///
/// The coefficient is one number for the whole frame, so a 24MP frame at 3 still offers a
/// million samples and reading them all buys nothing.
pub(crate) const DEFOCUS_STRIDE: usize = 3;

/// Beyond this it is not a focus difference, it is a frame the model had no business
/// being fitted on. A coefficient is a blur difference in pixels squared; the worst real
/// measurement is a small fraction of one.
pub(crate) const DEFOCUS_MAX: f32 = 0.5;

/// Below this a coefficient is indistinguishable from zero, so it neither corrects
/// anything nor gets a vote on whether the other channel is believable.
///
/// Measured against a channel that is genuinely defocused: IMG_8408's blue reads 0.148
/// where its red reads -0.011, and treating that -0.011 as a real disagreement threw the
/// whole frame away.
pub(crate) const DEFOCUS_NOISE: f32 = 0.02;

/// The five-point Laplacian of a plane, clamped at the border.
///
/// **A fixture's, now that the regressor and the correction are both `defocus.slang`'s.** What is
/// left reaching this is `defocused`, which builds a frame carrying a known softness by adding a
/// multiple of it - so the shader is asked to recover a curvature this spelled out.
#[cfg(test)]
pub(crate) fn laplacian(plane: &[f32], width: usize, height: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; width * height];
    out.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        for (x, slot) in row.iter_mut().enumerate() {
            let here = plane[y * width + x];
            let left = plane[y * width + x.saturating_sub(1)];
            let right = plane[y * width + (x + 1).min(width - 1)];
            let up = plane[y.saturating_sub(1) * width + x];
            let down = plane[(y + 1).min(height - 1) * width + x];
            *slot = left + right + up + down - 4.0 * here;
        }
    });
    out
}

/// Radial bins the defocus fit accumulates into, uniform in r^2.
///
/// Enough to fit a line through and few enough that each holds a real sample count.
pub(crate) const DEFOCUS_BINS: usize = 6;

/// Samples a bin needs before its own coefficient is believed.
pub(crate) const DEFOCUS_MIN_PER_BIN: usize = 200;

/// Bins that must resolve before the constant and the `r^2` term can be told apart. Two
/// points fit a line exactly and prove nothing about whether the profile is one.
pub(crate) const DEFOCUS_MIN_BINS: usize = 3;

/// **Longitudinal chromatic aberration, which no warp can fix.**
///
/// Lateral aberration is a magnification difference and comes out in the resample. This is
/// the other one: the lens focuses red, green and blue at different distances, so at a
/// hard edge one channel is sharp and another is not, and the difference reads as a purple
/// or green rim. There is no geometry to undo - the channels are registered, one is simply
/// blurrier.
///
/// So the correction is to subtract the part of the colour that *is* that blur difference,
/// which `measure_defocus` has already measured for the whole frame. Linear, with no mask,
/// no threshold and no notion of "enough": where the frame carries no focus difference the
/// coefficient is zero and every pixel is left exactly as it was.

/// How hard each stage works, 0 for a stage that does not run.
///
/// The denoise is not here: it runs on the mosaic (`crate::galosh`), before anything has
/// averaged a neighbour into anything, which is the only place the noise is still what the
/// sensor made. These are the two corrections that belong after a resample.
///
/// Named rather than two positional `f64`s: the pipeline calls this twice with a different
/// one of them non-zero each time, and `0.0, sharpen` at a call site says nothing about
/// which stage that is.
#[derive(Clone, Copy, Default, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct Strengths {
    pub sharpen: f64,
    pub defringe: f64,
}

impl Strengths {
    /// What runs on the frame before the camera match is fitted against it.
    ///
    /// Everything but the sharpen, which is a deconvolution of the *resample's* blur and
    /// so has to wait until after the warp that does the resampling (`base::prepare`).
    /// A fit calibrated against a sharpened render is calibrated against a frame that
    /// will not exist by the time the transform is applied.
    pub fn before_the_fit(self) -> Strengths {
        Strengths {
            sharpen: 0.0,
            ..self
        }
    }

    /// How far past a window the sharpen actually reads.
    ///
    /// Richardson-Lucy adds the point spread once per convolution, twice per iteration, and
    /// the anti-ringing limit adds its own window on top.
    pub fn halo(&self) -> usize {
        match self.sharpen > 0.0 {
            true => 2 * DECONVOLVE_RADIUS * DECONVOLVE_ITERATIONS + DECONVOLVE_RADIUS,
            false => 0,
        }
    }
}

/// A radial polynomial as knots, so a fitted model and a camera's own spline are
/// interchangeable everywhere downstream.
pub fn polynomial_knots(k1: f64, k2: f64, count: usize) -> Vec<f64> {
    (0..count)
        .map(|i| {
            let u = i as f64 / (count - 1) as f64;
            let r2 = u * u;
            ((k1 * r2 + k2 * r2 * r2) * SPLINE_UNIT).round()
        })
        .collect()
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
        assert_eq!(super::super::hdr::cropped_size(64, 64, geometry), (45, 91));
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
                let out = crate::hdr::cropped_size(full.0, full.1, geometry);
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

    /// The edge-width histogram's shape, against the shader that fills it.
    ///
    /// [`edge_spread_sigma`] turns a bin index back into a sigma with these numbers, so a shader
    /// edit that moved one alone reads every histogram at the wrong scale and the sharpen
    /// deconvolves a blur that means nothing. `RUN` is here too because it is what decides how
    /// much of the border the dispatch leaves out, which the host guards on.
    ///
    /// Read from the Slang rather than what it emitted: a `static const` is folded into its use
    /// sites, so the declaration is not in the generated WGSL.
    #[test]
    fn the_edge_histogram_is_the_shape_the_shader_fills() {
        const SLANG: &str = include_str!("../../../slang/edge_spread.slang");
        let declared = |name: &str| {
            let opener = format!(" {name} = ");
            let start = SLANG
                .find(&opener)
                .unwrap_or_else(|| panic!("{name} is declared"));
            let rest = &SLANG[start + opener.len()..];
            rest.split(';')
                .next()
                .expect("a terminator")
                .trim()
                .to_string()
        };
        assert_eq!(declared("BINS"), EDGE_SPREAD_BINS.to_string());
        assert_eq!(
            declared("SPAN_CEIL").parse::<f32>().expect("a number"),
            EDGE_SPREAD_CEIL
        );
        assert_eq!(declared("RUN"), EDGE_SPREAD_RUN.to_string());
    }

    /// The sharpen's reach, against the halo the tiling is grown by: a stencil wider than the halo
    /// is a seam down every tile boundary.
    #[test]
    fn the_sharpen_reads_within_the_tile_halo() {
        let halo = Strengths {
            sharpen: 1.0,
            defringe: 0.0,
        }
        .halo();
        assert!(
            halo <= crate::RENDITION_TILE_HALO,
            "the sharpen reads past the tile's halo"
        );
    }

    /// The decile walk, on histograms whose answer is known.
    ///
    /// The soft majority is what a photograph is - most edges are the subject rather than the
    /// optics - so an estimator that read the middle would report the scene. What is pinned is
    /// that it reads the sharp tail instead, and that a handful of impossibly narrow votes does
    /// not drag it below what the lens could have done.
    #[test]
    fn the_edge_spread_reads_the_sharp_decile() {
        let bytes = |bins: &[(usize, u32)]| {
            let mut mapped = vec![0u8; EDGE_SPREAD_BINS * 4];
            for &(bin, count) in bins {
                mapped[bin * 4..bin * 4 + 4].copy_from_slice(&count.to_le_bytes());
            }
            mapped
        };
        let width_bin = |width: f32| (width / EDGE_SPREAD_CEIL * EDGE_SPREAD_BINS as f32) as usize;

        // A sigma of 0.7 is a 10-90 of 1.79 pixels; a soft majority at 3 pixels must not win, and
        // twenty spikes at half a pixel must not either.
        let mapped = bytes(&[
            (width_bin(0.5), 20),
            (width_bin(1.79), 60_000),
            (width_bin(3.0), 500_000),
        ]);
        let sigma = edge_spread_sigma(&mapped).expect("a sigma");
        assert!(
            (0.66..=0.74).contains(&sigma),
            "the decile sits near 0.7 and this read {sigma}"
        );

        // Too few edges is no answer, not a confident one.
        assert_eq!(edge_spread_sigma(&bytes(&[(width_bin(1.79), 400)])), None);
    }

    #[test]
    fn a_fitted_frame_is_held_to_its_own_noise_rather_than_a_constant() {
        // `unified_sigma` is set to what a photograph carries rather than to match `sigma_sq`: it is
        // GAT-domain and reads near 1.2 at any exposure, so a fixture agreeing with both cannot tell
        // a ceiling built from the wrong one apart.
        let fitted = |sigma: f32| crate::galosh::NoiseFit {
            alpha: 0.0,
            sigma_sq: sigma * sigma,
            unified_sigma: 1.19,
            dark_ref: [0.0; 4],
        };
        assert_eq!(noise_ceiling(None), NOISE_CEILING);
        // A quiet frame binds far tighter than the constant, and by its own sigma.
        let quiet = noise_ceiling(Some(fitted(0.001)));
        assert!(
            quiet < NOISE_CEILING / 4.0,
            "a quiet frame is barely bounded: {quiet}"
        );
        assert!((quiet - 0.001 * NOISE_OVER_MOSAIC).abs() < 1e-6, "{quiet}");
        // And a noisy one is allowed past it, or the estimate is told its grain is smaller than
        // the frame measurably has.
        assert!(noise_ceiling(Some(fitted(0.02))) > NOISE_CEILING);
    }

    #[test]
    fn the_matrix_remixes_the_lattice_correlations() {
        let variance = [1.0, 1.0, 1.0];
        let lattice = noise_covariance(variance, None);
        for (a, row) in DEMOSAIC_CHANNEL_CORRELATION.iter().enumerate() {
            for (b, want) in row.iter().enumerate() {
                assert!(
                    (lattice[a][b] - want).abs() < 1e-9,
                    "{a}{b}: {}",
                    lattice[a][b]
                );
            }
        }

        // The identity has to change nothing, or the propagation is doing something besides
        // propagating.
        let identity = noise_covariance(
            variance,
            Some([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]),
        );
        for (a, row) in DEMOSAIC_CHANNEL_CORRELATION.iter().enumerate() {
            for (b, want) in row.iter().enumerate() {
                assert!(
                    (identity[a][b] - want).abs() < 1e-6,
                    "{a}{b}: {}",
                    identity[a][b]
                );
            }
        }

        // A real camera matrix pulls blue away from green: measured on a Sony, 0.63 falls to about
        // 0.21, which is the whole reason the propagation exists.
        let sony = [
            [1.53, -0.42, -0.11],
            [-0.09, 1.20, -0.11],
            [0.01, -0.30, 1.29],
        ];
        let remixed = noise_covariance(variance, Some(sony));
        let correlation =
            |a: usize, b: usize| remixed[a][b] / (remixed[a][a] * remixed[b][b]).sqrt();
        assert!(
            correlation(2, 1) < 0.45,
            "blue against green: {}",
            correlation(2, 1)
        );
        // Still a correlation matrix afterwards, whatever the matrix was.
        for c in 0..3 {
            assert!(remixed[c][c] > 0.0, "channel {c} has no variance");
        }
        for (a, b) in [(0, 1), (2, 1), (0, 2)] {
            assert!(
                correlation(a, b).abs() <= 1.0,
                "{a}{b} left [-1, 1]: {}",
                correlation(a, b)
            );
        }
    }

    /// A frame that is nothing but fine detail reports its own fitted noise, not the constant.
    ///
    /// The clamp is what carries the fit into the estimate, so it is asserted against a ceiling
    /// [`noise_ceiling`] built one - against the constant it would hold for the old fixed ceiling
    /// too, and pass whether or not a fit ever reached here.
    #[test]
    fn the_ceiling_is_what_bounds_a_median_that_ran_into_texture() {
        let mut bins = vec![0u32; NOISE_BINS];
        bins[NOISE_BINS - 1] = 10_000;
        let quiet = crate::galosh::NoiseFit {
            alpha: 0.0,
            sigma_sq: 0.001 * 0.001,
            unified_sigma: 1.19,
            dark_ref: [0.0; 4],
        };
        let fitted = noise_ceiling(Some(quiet));
        assert_eq!(sigma_from(&bins, fitted), fitted);
        assert!(
            fitted < NOISE_CEILING,
            "a quiet frame should bind tighter than {NOISE_CEILING}"
        );
    }

    /// What the deconvolution undoes, at both ends of the downscale and in between.
    ///
    /// **Every picture this pipeline sharpens goes through here**, and the failure is silent: a
    /// composition off by a fifth is a photograph slightly soft or slightly crunchy, which nothing
    /// downstream can see. The graded fixtures cannot - they run at `SharpenSigma::fixed` - and
    /// the shader tests hold the *taps* against a sigma they are handed rather than against this.
    ///
    /// The two ends are what the quadrature is written to get exactly right, so they are asserted
    /// as identities rather than as numbers: at `k = 1` there is no resample and the answer is the
    /// capture's own blur; as `k` grows the capture narrows away and the answer approaches the
    /// fixed sigma this pipeline sharpened every deep downscale with before anything was measured.
    #[test]
    fn the_sigma_composes_from_the_capture_and_the_resample() {
        // No measurement is yesterday's behaviour, whatever the scale.
        assert_eq!(
            deconvolve_split(None, 6000, 1200).composed,
            DECONVOLVE_SIGMA
        );
        assert!(deconvolve_split(None, 6000, 1200).terms.is_none());

        // 1:1, so nothing was resampled and the capture stands alone.
        let full = deconvolve_split(Some(0.62), 6000, 6000);
        assert!((full.composed - 0.62).abs() < 1e-6, "{}", full.composed);
        let (capture, resample) = full.terms.expect("the two terms");
        assert!((capture - 0.62).abs() < 1e-6);
        assert_eq!(resample, 0.0);

        // A target larger than the source does not sharpen it *more*: `k` floors at one.
        assert_eq!(
            deconvolve_split(Some(0.62), 3000, 6000).composed,
            full.composed
        );

        // Halved, which is the editor's own decode: the capture narrows to half and the resample
        // is the fixed sigma's share of what the downscale added.
        let half = deconvolve_split(Some(0.62), 6000, 3000)
            .terms
            .expect("the two terms");
        assert!((half.0 - 0.31).abs() < 1e-6, "{}", half.0);
        let wanted = (DECONVOLVE_SIGMA * DECONVOLVE_SIGMA * 3.0).sqrt() / 2.0;
        assert!(
            (half.1 - wanted).abs() < 1e-6,
            "{} against {wanted}",
            half.1
        );

        // Deep, where the capture has narrowed to nothing and only the resample is left.
        let deep = deconvolve_split(Some(0.62), 9504, 400);
        assert!(
            (deep.composed - DECONVOLVE_SIGMA).abs() < 0.01,
            "{} is not {DECONVOLVE_SIGMA}",
            deep.composed,
        );

        // In between it walks from the capture's own blur to the fixed sigma and stops there,
        // whichever side it started - so the direction is the *limit's*, not downward. A capture
        // sharper than the default rises to meet it, a softer one falls to it, and neither
        // overshoots: `(k^2-1)/k^2` reaches one and no further.
        for capture in [0.35f32, 0.62, 0.80] {
            let (low, high) = (capture.min(DECONVOLVE_SIGMA), capture.max(DECONVOLVE_SIGMA));
            let mut last = capture;
            for out in [6000, 4000, 3000, 2000, 1500, 1000, 600, 400] {
                let at = deconvolve_split(Some(capture), 6000, out).composed;
                assert!((0.3..=0.84).contains(&at), "{at} at {out} from {capture}");
                assert!(
                    (low - 1e-6..=high + 1e-6).contains(&at),
                    "{at} left {low}..{high}"
                );
                let toward = (at - last) * (DECONVOLVE_SIGMA - capture);
                assert!(
                    toward >= -1e-6,
                    "{at} at {out} moved away from the fixed sigma"
                );
                last = at;
            }
            let deepest = deconvolve_split(Some(capture), 6000, 200).composed;
            assert!(
                (deepest - DECONVOLVE_SIGMA).abs() < 0.02,
                "{deepest} from {capture}"
            );
        }
    }

    #[test]
    fn sharpen_noise_follows_the_decode_and_resize_samples() {
        let noise = SharpenNoise {
            shot_per_light: [4.0; 3],
            read_variance: [8.0; 3],
            ..SharpenNoise::NONE
        };
        let sensor = crate::px::Span::<crate::px::Sensor>::exact(6000);
        assert_eq!(
            noise.at(sensor, crate::px::Span::<crate::px::Drawn>::exact(6000)),
            noise,
        );
        assert_eq!(
            noise.at(sensor, crate::px::Span::<crate::px::Drawn>::exact(3000)),
            SharpenNoise {
                shot_per_light: [1.0; 3],
                read_variance: [2.0; 3],
                ..noise
            },
        );

        let halved = SharpenNoise { reduction: 2, ..noise };
        assert_eq!(
            halved.at(sensor, crate::px::Span::<crate::px::Drawn>::exact(3000)),
            SharpenNoise {
                shot_per_light: [4.0, 2.0, 4.0],
                read_variance: [8.0, 4.0, 8.0],
                ..halved
            },
        );
        assert_eq!(
            halved.at(sensor, crate::px::Span::<crate::px::Drawn>::exact(1500)),
            SharpenNoise {
                shot_per_light: [1.0, 0.5, 1.0],
                read_variance: [2.0, 1.0, 2.0],
                ..halved
            },
        );

        let third = SharpenNoise { reduction: 3, ..noise };
        let cfa = crate::cfa::tests::parse(crate::cfa::tests::XTRANS, 6, 6);
        let mut least = [usize::MAX; 3];
        for row in 0..6 {
            for col in 0..6 {
                let mut counts = [0usize; 3];
                for dy in 0..3 {
                    for dx in 0..3 {
                        counts[usize::from(cfa.colour_at(row + dy, col + dx))] += 1;
                    }
                }
                for channel in 0..3 {
                    least[channel] = least[channel].min(counts[channel]);
                }
            }
        }
        assert_eq!(least, [1, 5, 1]);
        assert_eq!(
            third.at(sensor, crate::px::Span::<crate::px::Drawn>::exact(2000)),
            SharpenNoise {
                shot_per_light: [4.0, 0.8, 4.0],
                read_variance: [8.0, 1.6, 8.0],
                ..third
            },
        );
    }

    /// A lens that moves pixels every way this gather can be asked to: a radial curve, a rescale,
    /// a vignette and a lateral shift per channel.
    fn bent() -> crate::fit::Lens {
        crate::fit::Lens {
            distortion: Some(vec![0.0, 0.004, 0.011, 0.022, 0.038]),
            crop: 1.02,
            falloff: Some((0.31, -0.04)),
            tca: Some([vec![0.0, 0.0004, 0.0009], vec![0.0, -0.0005, -0.0011]]),
        }
    }

    /// A window's footprint is a region about the window, inside the frame, and never the
    /// whole frame: a loupe tile decodes what its gather reads and no more.
    #[test]
    fn a_window_footprint_is_the_region_its_gather_reads() {
        let (width, height) = (320usize, 240usize);
        let lens = bent();
        let full = crate::px::Size::exact(width, height);

        assert!(
            lens_footprint(
                full,
                crate::px::Rect::exact(40, 30, 64, 48),
                &crate::fit::Lens::none()
            )
            .is_none()
        );

        let whole = lens_footprint(full, crate::px::Rect::exact(0, 0, width, height), &lens)
            .expect("the lens bends");
        assert!(
            whole.0 + whole.2 <= width && whole.1 + whole.3 <= height,
            "{whole:?} is not inside the frame"
        );

        let region = lens_footprint(full, crate::px::Rect::exact(40, 30, 64, 48), &lens)
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

    #[test]
    fn resizes_to_a_long_edge_keeping_aspect() {
        let source = ramp(400, 200);
        let out = resize_to_fit(source.as_ref(), 100);
        assert_eq!((out.width, out.height), (100, 50));
        assert_eq!(out.data.len(), 100 * 50 * 3);
    }

    #[test]
    fn resize_to_fit_only_ever_shrinks() {
        let source = ramp(400, 200);
        for long_edge in [0, 400, 4000] {
            let out = resize_to_fit(source.as_ref(), long_edge);
            assert_eq!((out.width, out.height), (400, 200), "long edge {long_edge}");
            assert_eq!(out.data, source.data, "long edge {long_edge}");
        }
    }

    /// A reduce has to actually filter, not point-sample: a two-tap gather reads four of
    /// every hundred source pixels at this ratio and came out mean 12.4 of 255 from a real
    /// reduce, which is what put the fit on the wrong lens tier.
    #[test]
    fn a_reduce_averages_the_pixels_it_skips() {
        // Alternating columns: any filter with support averages them to the midpoint,
        // while a point sample lands on one column or the other.
        let (width, height) = (640usize, 8usize);
        let mut data = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let level = if x % 2 == 0 { 40 } else { 200 };
                data[(y * width + x) * 3..(y * width + x) * 3 + 3].fill(level);
            }
        }
        let source = Rgb {
            width,
            height,
            data,
        };

        let reduced = resize(source.as_ref(), 80, height);
        let midpoint = 120i32;
        let worst = reduced
            .data
            .iter()
            .map(|v| (i32::from(*v) - midpoint).abs())
            .max()
            .unwrap();
        assert!(
            worst <= 8,
            "a reduce should average the columns it drops, worst was {worst} off"
        );
    }

    fn ramp(width: usize, height: usize) -> Rgb {
        let mut data = vec![0u8; width * height * 3];
        for (i, byte) in data.iter_mut().enumerate() {
            *byte = (i % 251) as u8;
        }
        Rgb {
            width,
            height,
            data,
        }
    }

    /// Dense achromatic bars.
    ///
    /// **Dense on purpose.** The estimate is a regression that wants thousands of samples
    /// carrying real second differences, and a fixture with one edge in it offers a few
    /// dozen - so it would decline for want of evidence and every assertion below would
    /// pass on the stage doing nothing.
    fn bars(width: usize, height: usize) -> Vec<u8> {
        let mut data = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                let value = if (x / 4) % 2 == 0 { 40u8 } else { 210 };
                for c in 0..3 {
                    data[i + c] = value;
                }
            }
        }
        data
    }

    /// Rescales one channel about the centre, which is what a *lateral* aberration is: a
    /// magnification difference, with every channel still perfectly in focus.
    fn scale_channel(src: &[u8], channel: usize, scale: f64) -> Vec<u8> {
        let (w, h) = (400usize, 300usize);
        let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
        let mut out = src.to_vec();
        for y in 0..h {
            for x in 0..w {
                let (sx, sy) = (cx + (x as f64 - cx) * scale, cy + (y as f64 - cy) * scale);
                if sx < 0.0 || sy < 0.0 || sx >= (w - 1) as f64 || sy >= (h - 1) as f64 {
                    continue;
                }
                let (x0, y0) = (sx as usize, sy as usize);
                let (fx, fy) = (sx - x0 as f64, sy - y0 as f64);
                let at = |xx: usize, yy: usize| f64::from(src[(yy * w + xx) * 3 + channel]);
                let value = at(x0, y0) * (1.0 - fx) * (1.0 - fy)
                    + at(x0 + 1, y0) * fx * (1.0 - fy)
                    + at(x0, y0 + 1) * (1.0 - fx) * fy
                    + at(x0 + 1, y0 + 1) * fx * fy;
                out[(y * w + x) * 3 + channel] = value.round().clamp(0.0, 255.0) as u8;
            }
        }
        out
    }

    /// Defocuses `channels` against the rest, which is what a longitudinal aberration
    /// physically is.
    ///
    /// `v + s.lap(v)` is one step of the heat equation, so it blurs - and it leaves the
    /// channel carrying exactly `s.lap(luma)` of extra colour, which is the model
    /// `measure_defocus` fits. The old fixture painted a magenta rim on by hand, which is
    /// a fringe-*coloured* frame rather than a defocused one: nothing about its shape
    /// obliged an estimator to be right about the defect.
    fn defocus_channels(
        frame: &[u8],
        width: usize,
        height: usize,
        channels: &[usize],
        softness: f32,
    ) -> Vec<u8> {
        let mut out = frame.to_vec();
        for y in 0..height {
            for x in 0..width {
                for &c in channels {
                    let at = |xx: usize, yy: usize| f32::from(frame[(yy * width + xx) * 3 + c]);
                    // Clamped at the border rather than skipped, because `laplacian` is:
                    // leave the border undefocused and the correction still runs there,
                    // inventing a fringe the fixture never injected.
                    let curvature = at(x.saturating_sub(1), y)
                        + at((x + 1).min(width - 1), y)
                        + at(x, y.saturating_sub(1))
                        + at(x, (y + 1).min(height - 1))
                        - 4.0 * at(x, y);
                    out[(y * width + x) * 3 + c] =
                        (at(x, y) + softness * curvature).clamp(0.0, 255.0).round() as u8;
                }
            }
        }
        out
    }

    /// **Noise alone must measure nothing.**
    ///
    /// The regressor and the response are built from the same pixels - the stencil's `-4c`
    /// term and the response's `-luma(c)` share one - so their noise is correlated by
    /// construction. Green's enters the two with opposite signs, which made the residue
    /// *positive for both channels*: it cleared the sign veto, which exists to catch things
    /// that flip sign, and being a ratio of variances it did not shrink as the noise did.
    /// A flat frame with independent per-channel grain fitted (0.124, 0.175) - the blue
    /// figure larger than the 0.148 measured on the worst real frame in the library.
    ///
    /// `measure_defocus` now subtracts both sums' noise terms analytically, and this is the
    /// test that says so. **Independent per-channel noise is the whole point**: every other
    /// noisy fixture here adds the *same* grain to all three channels, which cancels in
    /// `R - luma` identically and is exactly why this shipped unseen.
    /// The defocus fit, on the device, over an 8-bit fixture widened to what the shader reads.
    ///
    /// **The estimator's properties are asserted against the implementation that ships.** These
    /// fixtures are 8-bit because they were written against a CPU copy that has gone; the widening
    /// is `* 257`, which is exact and leaves every threshold in the normalised scale it is written
    /// against.
    fn fitted(frame: &[u8], width: usize, height: usize) -> Option<(f32, f32)> {
        let gpu = crate::gpu::device()?;
        let base = crate::base::device(gpu)?;
        let wide: Vec<u16> = frame.iter().map(|&b| u16::from(b) * 257).collect();
        pollster::block_on(crate::base::measure_defocus(
            gpu, base, &wide, width, height, None, None,
        ))
    }

    /// Whether there is a device to fit on at all, so a test can decline rather than read a
    /// missing adapter as the estimator answering `None`.
    fn fits() -> bool {
        crate::gpu::device().and_then(crate::base::device).is_some()
    }

    #[test]
    fn independent_channel_noise_alone_is_not_a_focus_difference() {
        if !fits() {
            return;
        }
        let (w, h) = (400usize, 300usize);
        let noise = |seed: u64, base: &[u8]| {
            let mut out = base.to_vec();
            let mut state = seed;
            for slot in out.iter_mut() {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let grain = ((state >> 33) % 5) as i32 - 2;
                *slot = (i32::from(*slot) + grain).clamp(0, 255) as u8;
            }
            out
        };

        let flat = noise(0x9E37_79B9_7F4A_7C15, &vec![128u8; w * h * 3]);
        assert_eq!(
            fitted(&flat, w, h),
            None,
            "noise alone is not a focus difference"
        );

        // And the correction it does measure has to be the same with the noise as without,
        // or the subtraction has merely moved the bias rather than removed it.
        let clean = defocus_channels(&bars(w, h), w, h, &[0, 2], 0.12);
        let grainy = noise(0x2545_F491_4F6C_DD1D, &clean);
        let (clean_red, clean_blue) = fitted(&clean, w, h).expect("a coefficient");
        let (noisy_red, noisy_blue) = fitted(&grainy, w, h).expect("a coefficient");
        assert!(
            (clean_red - noisy_red).abs() < 0.01 && (clean_blue - noisy_blue).abs() < 0.01,
            "noise moved the coefficient: ({clean_red}, {clean_blue}) to ({noisy_red}, {noisy_blue})",
        );
    }

    /// **A lateral aberration is not a focus difference, and the radius is what says so.**
    ///
    /// A channel displaced by `d` expands as `G + d.grad G + (d^2/2).lap G`, and that
    /// second-order term is the very basis this fit regresses on. It carries `d^2`, so it
    /// is positive for red and blue whichever way each channel is displaced - exactly the
    /// case the sign-disagreement veto cannot catch, since that veto rejects things which
    /// flip sign. Before the radial split this fixture fitted (0.054, 0.053) with nothing
    /// out of focus anywhere, and the correction was then applied at every radius including
    /// the centre, where a magnification difference displaces nothing at all.
    ///
    /// What separates them: `d` grows with `r`, so a lateral confound's apparent
    /// coefficient grows with `r^2`, where a focus difference is flat across the field. The
    /// fit is taken per radial bin and split into a constant and an `r^2` term; only the
    /// constant survives. That leaves 0.008 here, under the noise band, so the frame
    /// declines outright.
    #[test]
    fn a_pure_lateral_aberration_is_not_read_as_a_focus_difference() {
        if !fits() {
            return;
        }
        let (w, h) = (400usize, 300usize);
        let lateral = scale_channel(&scale_channel(&bars(w, h), 0, 1.0015), 2, 0.9985);
        assert_eq!(
            fitted(&lateral, w, h),
            None,
            "a magnification difference is not a focus difference",
        );
    }

    #[test]
    fn a_focus_difference_survives_a_lateral_one_on_top_of_it() {
        if !fits() {
            return;
        }
        // The split must not simply reject everything radial: a real focus difference sits
        // in the constant term and has to come through a frame carrying both.
        let (w, h) = (400usize, 300usize);
        let defocus = defocus_channels(&bars(w, h), w, h, &[0, 2], 0.12);
        let (clean_red, _) = fitted(&defocus, w, h).expect("a coefficient");
        let both = scale_channel(&scale_channel(&defocus, 0, 1.0015), 2, 0.9985);
        let (mixed_red, mixed_blue) = fitted(&both, w, h).expect("a coefficient");
        assert!(
            mixed_red > clean_red * 0.7 && mixed_red < clean_red * 1.3,
            "the focus difference should survive the lateral one: {mixed_red} against {clean_red}",
        );
        assert!(mixed_blue > DEFOCUS_NOISE, "blue too: {mixed_blue}");
    }

    #[test]
    fn the_estimate_recovers_the_softness_that_was_injected() {
        if !fits() {
            return;
        }
        // Straight at the estimator, because the round trip above would also pass on a
        // coefficient that is merely the right sign.
        let (w, h) = (400usize, 300usize);
        for injected in [0.06f32, 0.12] {
            let frame = defocus_channels(&bars(w, h), w, h, &[0, 2], injected);
            let (red, blue) = fitted(&frame, w, h).expect("a coefficient");
            for (name, found) in [("red", red), ("blue", blue)] {
                assert!(
                    (found - injected).abs() < injected * 0.35,
                    "{name}: injected {injected}, measured {found}",
                );
            }
        }
    }

    #[test]
    fn one_channel_measuring_nothing_does_not_veto_the_other() {
        if !fits() {
            return;
        }
        // **The case that shipped broken.** IMG_8408 - the frame this project cites as its
        // worst, at 98.48 of fringe - measures blue at +0.148 and red at -0.011, and a bare
        // product veto read that -0.011 as a disagreement and threw the whole frame away.
        // A channel with nothing to say must not silence one that has.
        let (w, h) = (400usize, 300usize);
        let frame = defocus_channels(&bars(w, h), w, h, &[2], 0.15);
        let (red, blue) = fitted(&frame, w, h).expect("blue alone is still a fringe");
        assert!(blue > 0.1, "blue measured {blue}");
        assert_eq!(
            red, 0.0,
            "red had nothing to correct and must be left at zero"
        );
    }

    #[test]
    fn a_channel_measured_sharper_than_green_is_not_sharpened() {
        if !fits() {
            return;
        }
        // Subtracting a negative coefficient would add curvature to that channel's chroma,
        // inventing an edge rather than removing one.
        let (w, h) = (400usize, 300usize);
        let frame = defocus_channels(&bars(w, h), w, h, &[0], -0.15);
        match fitted(&frame, w, h) {
            None => {}
            Some((red, blue)) => {
                assert_eq!(
                    (red, blue),
                    (0.0, 0.0),
                    "a sharper channel asked for a correction"
                );
            }
        }
    }

    #[test]
    fn a_channel_softer_and_a_channel_sharper_is_declined() {
        if !fits() {
            return;
        }
        // Autofocus works on luma, so green is the focused channel and red and blue are
        // both softer than it. Coefficients on opposite sides of zero are the scene's
        // colour being read as a lens fault, which is the way this regression fails.
        let (w, h) = (400usize, 300usize);
        let softened = defocus_channels(&bars(w, h), w, h, &[0], 0.12);
        let frame = defocus_channels(&softened, w, h, &[2], -0.12);
        assert!(fitted(&frame, w, h).is_none());
    }

    /// A channel scaled above 1 reads every radius further out than the plain table, below 1
    /// further in, and a registered lens reads three copies of the plain table.
    ///
    /// **The direction, which "it moved" does not pin.** Inverting `1.0 + spline_at` to
    /// `1.0 - spline_at` in `channel_ratio_table` leaves every other test green and doubles every
    /// fringe the correction exists to remove.
    #[test]
    fn a_lateral_scale_reads_further_out_above_one_and_further_in_below() {
        let flat = |scale: f64| vec![(scale - 1.0) * SPLINE_UNIT; 2];
        let knots = [
            0.0,
            -0.005 * SPLINE_UNIT,
            -0.02 * SPLINE_UNIT,
            -0.05 * SPLINE_UNIT,
        ];
        let crop = 0.98;
        let plain = ratio_table(&knots, crop);
        let outward = channel_ratio_table(&knots, &flat(1.05), crop);
        let inward = channel_ratio_table(&knots, &flat(0.95), crop);
        // Every slot, the centre included: a channel imaged larger is larger everywhere.
        for (slot, base) in plain.iter().enumerate() {
            assert!(
                outward[slot] > *base,
                "slot {slot}: {} reads inside {base}",
                outward[slot]
            );
            assert!(
                inward[slot] < *base,
                "slot {slot}: {} reads outside {base}",
                inward[slot]
            );
        }
        let [red, green, blue] = ratio_tables(&knots, crop, &registered());
        assert_eq!(red, plain);
        assert_eq!(green, plain);
        assert_eq!(blue, plain);
    }

    #[test]
    fn the_fill_crop_is_the_reciprocal_of_the_corner_it_has_to_undo() {
        let knots = polynomial_knots(0.0173, 0.0, 16);
        assert!((fill_crop(&knots, 6000, 4000) - 1.0 / 1.0173).abs() < 1e-3);
    }

    #[test]
    fn a_correction_that_pushes_nothing_out_needs_no_crop() {
        // Barrel: the corner is sampled inside the frame already, and cropping further
        // would throw away picture for nothing.
        assert_eq!(
            fill_crop(&polynomial_knots(-0.03, 0.0, 16), 6000, 4000),
            1.0
        );
        assert_eq!(fill_crop(&[], 6000, 4000), 1.0);
    }

    #[test]
    fn the_fill_crop_sees_a_bulge_the_corner_does_not() {
        // Mustache: the curve reaches furthest in mid-field while its corner sits at
        // zero. Reading only the radii from the short edge outward calls this a full
        // frame, because every one of them is an identity - and the bulge inside them
        // is meanwhile sampling past the short edge.
        let mut knots = vec![0.0; 16];
        knots[7] = 0.30 * SPLINE_UNIT;
        let (width, height) = (60usize, 40usize);
        let half = ((width as f64 / 2.0).powi(2) + (height as f64 / 2.0).powi(2)).sqrt();
        let short_edge = (height as f64 / 2.0) / half;

        let crop = fill_crop(&knots, width, height);
        assert!(
            crop < 0.93,
            "the far radii alone would have left this at 1.0, got {crop}"
        );
        // Exact, not approximate: the peak is at a knot, and the grid lands on knots.
        let reach = crop * sample_radius(&knots, 7.0 / 15.0, 1.0);
        assert!(
            reach <= short_edge + 1e-9,
            "the bulge reaches {reach}, past {short_edge}"
        );
    }

    #[test]
    fn a_pincushion_correction_at_its_fill_crop_leaves_no_black() {
        // The bug this guards: a lensfun profile with a +1.7% corner was applied at a
        // crop that did not fill, and the corners showed the black the warp sampled from
        // outside the frame.
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let (width, height) = (120usize, 80usize);
        let mut source = ramp(width, height);
        // A ramp passes through zero, and a black source pixel is not a black margin.
        for byte in &mut source.data {
            *byte = (*byte).max(1);
        }
        let knots = polynomial_knots(0.0173, 0.0, 16);
        let lens = crate::fit::Lens {
            crop: fill_crop(&knots, width, height),
            distortion: Some(knots),
            falloff: None,
            tca: None,
        };
        let resident = crate::hdr_fit::levelled_source(gpu, source.as_ref());
        let out = pollster::block_on(crate::hdr_fit::warped_levels(
            gpu,
            &resident,
            (width, height),
            &[lens],
            (width, height),
        ))
        .expect("the device warps")
        .remove(0);
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                assert_ne!((out[i], out[i + 1], out[i + 2]), (0, 0, 0), "pixel {x},{y}");
            }
        }
    }

    #[test]
    fn a_curve_scaled_to_nothing_is_not_a_geometry_but_a_crop_alone_is() {
        // Gain 0 leaves a curve of zeroes, which moves no pixel; the crop beside it
        // still does, and that is the case a `knots.is_none()` check misses.
        assert!(!moves_pixels(Some(&[0.0; 16]), 1.0));
        assert!(!moves_pixels(None, 1.0));
        assert!(moves_pixels(None, 0.995));
        assert!(moves_pixels(Some(&polynomial_knots(0.02, 0.0, 16)), 1.0));
    }

    #[test]
    fn sample_radius_is_the_identity_without_knots() {
        assert!((sample_radius(&[], 0.7, 1.0) - 0.7).abs() < 1e-12);
        assert!((sample_radius(&[], 0.7, 0.5) - 0.35).abs() < 1e-12);
    }

    #[test]
    fn polynomial_knots_round_trip_through_sample_radius() {
        let k1 = -0.0275;
        let knots = polynomial_knots(k1, 0.0, 64);
        assert!((sample_radius(&knots, 1.0, 1.0) - (1.0 + k1)).abs() < 1e-3);
        assert!((sample_radius(&knots, 0.5, 1.0) - 0.5 * (1.0 + k1 * 0.25)).abs() < 1e-3);
    }
}
