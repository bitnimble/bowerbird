// The crate's resampling and pixel maths.
//
// The reduce that used to go through libvips lives here now, beside the radial warp and
// the spline it follows, and the render's denoise and sharpen (§10.9): a guided filter, a
// Richardson-Lucy deconvolution and the box means and noise estimate they are built on,
// none of which libvips offered. The codecs are their own modules - `jpeg` in Rust,
// `avif` over libavif - and `decode` below is the one entry point that picks between them.

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
    channels.iter().all(|knots| knots.iter().all(|knot| *knot == 0.0))
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
    crop
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
            let base = if radius == 0.0 { crop } else { sample_radius(knots, radius, crop) / radius };
            base * (1.0 + spline_at(channel, radius))
        })
        .collect()
}

/// A warp resolved down to what every pixel of it needs: the spline is already a radial
/// table by this point, so what is left is arithmetic and one bilinear gather.
///
/// Handed out so a caller can drive the warp a row at a time and do its own work in the
/// same sweep. Materialising the warped frame and reading it back is two passes over a
/// 60MP buffer for one pixel's worth of dependency between them.
pub struct Warp {
    /// One radial table per channel. Where the lens registered the channels they are
    /// three copies of the same numbers, which costs two tables of 1024 doubles and
    /// keeps `at` free of a branch it would take per pixel.
    ratios: [Vec<f64>; 3],
    half: f64,
    scale: (f64, f64),
    centre: (f64, f64),
    edge: (f64, f64),
    size: (usize, usize),
    source_width: usize,
    source_height: usize,
    /// Which reconstruction filter the gather runs through. The output takes the cubic and
    /// the fit takes the bilinear, and this being a field rather than a constant is what
    /// lets one gather serve both - hardcoding it here quietly put the SDR render back on
    /// the bilinear that DESIGN measures a 25% edge-gradient loss against.
    sampling: Sampling,
}

impl Warp {
    pub fn new(
        source: RgbRef<'_>,
        width: usize,
        height: usize,
        knots: &[f64],
        crop: f64,
        channels: &Channels,
        sampling: Sampling,
    ) -> Warp {
        let half = ((width as f64 / 2.0).powi(2) + (height as f64 / 2.0).powi(2)).sqrt();
        let (sw, sh) = (source.width, source.height);
        let (scale_x, scale_y) = (sw as f64 / width as f64, sh as f64 / height as f64);
        Warp {
            // The distortion and the lateral correction are both radial multipliers on the
            // radius a pixel is read from, so they compose into one table per channel and
            // the gather below never learns that two corrections went into it.
            ratios: std::array::from_fn(|c| channel_ratio_table(knots, &channels[c], crop)),
            half,
            scale: (half * scale_x, half * scale_y),
            centre: (sw as f64 / 2.0, sh as f64 / 2.0),
            edge: ((sw - 1) as f64, (sh - 1) as f64),
            size: (width, height),
            source_width: sw,
            source_height: sh,
            sampling,
        }
    }

    /// The pixel of `source` that lands at `(x, y)`, or None where it falls outside.
    #[inline]
    pub fn at(&self, source: RgbRef<'_>, x: usize, y: usize) -> Option<[u8; 3]> {
        let (width, height) = self.size;
        let dy = (y as f64 - height as f64 / 2.0) / self.half;
        let dx = (x as f64 - width as f64 / 2.0) / self.half;
        let t = (dx * dx + dy * dy) * RATIO_TABLE_LAST as f64;
        let slot = if t < RATIO_TABLE_LAST as f64 { t as usize } else { RATIO_TABLE_LAST - 1 };
        // Per channel, because a lateral aberration means red and blue are read at their
        // own radius. One of them falling outside the frame is the whole pixel's answer:
        // a triple missing a channel is not a colour.
        let mut out = [0u8; 3];
        for (c, slot_out) in out.iter_mut().enumerate() {
            let table = &self.ratios[c];
            let low = table[slot];
            let ratio = low + (table[slot + 1] - low) * (t - slot as f64);
            let px = self.centre.0 + dx * ratio * self.scale.0;
            let py = self.centre.1 + dy * ratio * self.scale.1;
            if px < 0.0 || py < 0.0 || px > self.edge.0 || py > self.edge.1 {
                return None;
            }
            // Through the same `tap` `warp_planar` uses, so the two gathers cannot drift
            // in their filter the way they had already drifted at the frame edge.
            let value = tap(
                source.data,
                self.source_width,
                self.source_height,
                px,
                py,
                c,
                self.sampling,
                &|v: u8| f64::from(v),
            );
            *slot_out = value.clamp(0.0, 255.0) as u8;
        }
        Some(out)
    }
}

/// Bilinear resample of `source` onto a width x height grid through a radial model.
///
/// Drives `Warp`, which is the same gather this used to spell out for itself. The two had
/// drifted at the edges - one treating the last row and column as sample sites, the other
/// as out of bounds - and **neither reading is reachable on any frame measured here**, so
/// unifying them is a deduplication rather than a fix. What it buys is that the search and
/// the output can no longer disagree about where the frame ends.
///
/// Across cores, which the hand-written loop was not - and this is the fit's inner loop,
/// run once per candidate geometry.
pub fn warp(source: RgbRef<'_>, width: usize, height: usize, knots: &[f64], crop: f64) -> Rgb {
    let mut data = vec![0u8; width * height * 3];
    let (sw, sh) = (source.width, source.height);
    if sw < 2 || sh < 2 {
        return Rgb { width, height, data };
    }
    let warp = Warp::new(source, width, height, knots, crop, &registered(), Sampling::Bilinear);
    data.par_chunks_mut(width * 3).enumerate().for_each(|(y, row)| {
        for x in 0..width {
            // Outside the source frame the warp contributes nothing, and the black it
            // leaves is what the pair gate skips.
            if let Some(pixel) = warp.at(source, x, y) {
                row[x * 3..x * 3 + 3].copy_from_slice(&pixel);
            }
        }
    });
    Rgb { width, height, data }
}

/// Lanczos3 reduce onto an exact grid. The only downscale in the crate.
///
/// **A warp is not a substitute, and reaching for one here was a real bug.** `warp` gathers
/// two taps per axis, so reducing 6000x4000 to 1280 with it reads four of every hundred
/// source pixels and aliases the rest into the result: against this reduce it came out mean
/// 12.4 of 255 off, worst 241. A fit built on those grids picked a different lens tier on
/// IMG_5360 than one built on a real reduce. Two taps are right where a warp *warps* -
/// small displacements on prefiltered pixels - and wrong the moment the grid shrinks.
///
/// Lanczos3 because that is what libvips gave the renditions before this replaced it, and
/// it lands within 1 of 255 of it. Also 17x cheaper in CPU: 15ms against 255ms on that
/// same reduction, since this is a SIMD integer kernel rather than a general tiled
/// float pipeline. Single-threaded for the same reason `blur` is - already milliseconds,
/// and the callers are inside their own parallelism.
pub fn resize(source: RgbRef<'_>, width: usize, height: usize) -> Rgb {
    if width == 0 || height == 0 || source.width == 0 || source.height == 0 {
        return Rgb { width, height, data: vec![0u8; width * height * 3] };
    }
    if (width, height) == (source.width, source.height) {
        return Rgb { width, height, data: source.data.to_vec() };
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
    let mut destination =
        fast_image_resize::images::Image::new(width as u32, height as u32, fast_image_resize::PixelType::U8x3);
    let options = fast_image_resize::ResizeOptions::new()
        .resize_alg(fast_image_resize::ResizeAlg::Convolution(fast_image_resize::FilterType::Lanczos3));
    fast_image_resize::Resizer::new()
        .resize(&src, &mut destination, Some(&options))
        .expect("a resize between two RGB planes of known size");
    Rgb { width, height, data: destination.into_vec() }
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
/// frame it came from, and a fit grid exists to make the comparison cheaper - and a body
/// that embeds a preview smaller than the fit grid would otherwise have it upscaled into
/// invented detail.
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
        return Rgb { width: source.width, height: source.height, data: source.data.to_vec() };
    }
    let scaled = |dimension: usize| {
        usize::try_from(dimension as u64 * long_edge as u64 / longest as u64)
            .expect("a resized dimension must fit the address space")
            .max(1)
    };
    resize(source, scaled(source.width), scaled(source.height))
}

/// Which reconstruction filter a warp resamples through.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Sampling {
    /// Two taps per axis. What the fit measures through: both of its images are blurred
    /// at sigma 3 before anything is compared, so there is no detail left at the scale a
    /// sharper filter would preserve, and it is the inner loop of a scan over tens of
    /// candidates.
    Bilinear,
    /// Catmull-Rom, four taps per axis. What the output goes through.
    ///
    /// Bilinear's softening is radial here, which is why it was worth the taps: the warp
    /// holds the frame centre fixed, so near the centre it samples whole pixels and
    /// returns them untouched, while at the edge the displacement is ~23px at 3840 with
    /// a fractional part that is effectively arbitrary - and bilinear at half a pixel is
    /// a two-tap box blur. Sharp middle, soft edges, against a camera JPEG that is sharp
    /// to the corner.
    Bicubic,
}

/// Catmull-Rom weights for the four taps around a fractional offset.
///
/// The interpolating member of the cubic family (B=0, C=1/2): it passes through its
/// samples, so a warp that lands on a whole pixel returns that pixel rather than a
/// blend of its neighbours. Overshoots slightly at a hard edge, which is the price of
/// not softening every other pixel in the frame.
fn cubic_weights(t: f64) -> [f64; 4] {
    let (t2, t3) = (t * t, t * t * t);
    [
        0.5 * (-t3 + 2.0 * t2 - t),
        0.5 * (3.0 * t3 - 5.0 * t2 + 2.0),
        0.5 * (-3.0 * t3 + 4.0 * t2 + t),
        0.5 * (t3 - t2),
    ]
}

/// One channel sampled at one point, through the chosen filter.
///
/// The caller has checked the point is inside the source. Clamped rather than skipped
/// at the border: a cubic reaches one pixel back and two forward, so the outermost ring
/// has no full neighbourhood and the nearest sample stands in for what is off the edge.
#[inline]
fn tap<T: Copy>(
    src: &[T],
    sw: usize,
    sh: usize,
    px: f64,
    py: f64,
    channel: usize,
    sampling: Sampling,
    to_f64: &impl Fn(T) -> f64,
) -> f64 {
    let (x0, y0) = ((px as usize).min(sw - 2), (py as usize).min(sh - 2));
    let (fx, fy) = (px - x0 as f64, py - y0 as f64);
    if sampling == Sampling::Bilinear {
        let i00 = (y0 * sw + x0) * 3 + channel;
        let i01 = i00 + sw * 3;
        return to_f64(src[i00]) * (1.0 - fx) * (1.0 - fy)
            + to_f64(src[i00 + 3]) * fx * (1.0 - fy)
            + to_f64(src[i01]) * (1.0 - fx) * fy
            + to_f64(src[i01 + 3]) * fx * fy;
    }
    let (wx, wy) = (cubic_weights(fx), cubic_weights(fy));
    let columns = [x0.saturating_sub(1), x0, (x0 + 1).min(sw - 1), (x0 + 2).min(sw - 1)];
    let rows = [y0.saturating_sub(1), y0, (y0 + 1).min(sh - 1), (y0 + 2).min(sh - 1)];
    let mut total = 0.0;
    for (weight_y, row_y) in wy.iter().zip(rows) {
        let mut across = 0.0;
        for (weight_x, column) in wx.iter().zip(columns) {
            across += weight_x * to_f64(src[(row_y * sw + column) * 3 + channel]);
        }
        total += weight_y * across;
    }
    total
}

/// `tap` specialised on 16-bit sources, so the HDR grade's gather does not pay a
/// closure call per cubic weight.
#[inline]
fn tap_u16(src: &[u16], sw: usize, sh: usize, px: f64, py: f64, channel: usize, sampling: Sampling) -> f64 {
    let (x0, y0) = ((px as usize).min(sw - 2), (py as usize).min(sh - 2));
    let (fx, fy) = (px - x0 as f64, py - y0 as f64);
    if sampling == Sampling::Bilinear {
        let i00 = (y0 * sw + x0) * 3 + channel;
        let i01 = i00 + sw * 3;
        return f64::from(src[i00]) * (1.0 - fx) * (1.0 - fy)
            + f64::from(src[i00 + 3]) * fx * (1.0 - fy)
            + f64::from(src[i01]) * (1.0 - fx) * fy
            + f64::from(src[i01 + 3]) * fx * fy;
    }
    let (wx, wy) = (cubic_weights(fx), cubic_weights(fy));
    let columns = [x0.saturating_sub(1), x0, (x0 + 1).min(sw - 1), (x0 + 2).min(sw - 1)];
    let rows = [y0.saturating_sub(1), y0, (y0 + 1).min(sh - 1), (y0 + 2).min(sh - 1)];
    let mut total = 0.0;
    for (weight_y, row_y) in wy.iter().zip(rows) {
        let mut across = 0.0;
        for (weight_x, column) in wx.iter().zip(columns) {
            across += weight_x * f64::from(src[(row_y * sw + column) * 3 + channel]);
        }
        total += weight_y * across;
    }
    total
}


/// The planar twin of [`Warp`]: a radial table resolved once, handed out so a caller
/// can gather per pixel and do its own work in the same sweep.
///
/// `Warp` is 8-bit interleaved for the SDR fit; this is every other sample type the
/// HDR path carries - 16-bit scene-linear and the f64 planes derived from it - and it
/// folds the falloff in because that correction is indexed by the same output radius
/// the gather already has.
pub struct PlanarWarp {
    /// Empty when every channel shares [`Self::shared`]; otherwise one table per channel.
    per_channel: Vec<Vec<f64>>,
    shared: Vec<f64>,
    falloff: Option<(f64, f64)>,
    half: f64,
    step: (f64, f64),
    centre: (f64, f64),
    edge: (f64, f64),
    size: (usize, usize),
    source_width: usize,
    source_height: usize,
    sampling: Sampling,
}

impl PlanarWarp {
    pub fn new(
        source_width: usize,
        source_height: usize,
        width: usize,
        height: usize,
        knots: &[f64],
        crop: f64,
        falloff: Option<(f64, f64)>,
        channels: &Channels,
        sampling: Sampling,
    ) -> PlanarWarp {
        let half = ((width as f64 / 2.0).powi(2) + (height as f64 / 2.0).powi(2)).sqrt();
        let (scale_x, scale_y) = (source_width as f64 / width as f64, source_height as f64 / height as f64);
        let registered = is_registered(channels);
        PlanarWarp {
            shared: ratio_table(knots, crop),
            per_channel: match registered {
                true => Vec::new(),
                false => channels.iter().map(|c| channel_ratio_table(knots, c, crop)).collect(),
            },
            falloff,
            half,
            step: (half * scale_x, half * scale_y),
            centre: (source_width as f64 / 2.0, source_height as f64 / 2.0),
            edge: ((source_width - 1) as f64, (source_height - 1) as f64),
            size: (width, height),
            source_width,
            source_height,
            sampling,
        }
    }

    /// A warp for a lens that moves pixels or lifts corners, or None when it would be
    /// an identity gather.
    pub fn for_lens(
        source_width: usize,
        source_height: usize,
        width: usize,
        height: usize,
        lens: &crate::fit::Lens,
        sampling: Sampling,
    ) -> Option<PlanarWarp> {
        if lens.is_identity() {
            return None;
        }
        Some(PlanarWarp::new(
            source_width,
            source_height,
            width,
            height,
            lens.distortion.as_deref().unwrap_or_default(),
            lens.crop,
            lens.falloff,
            &lens.channels(),
            sampling,
        ))
    }

    /// The tight 16-bit gather: same loop as [`warp_planar`], driven from the tables
    /// this already holds. A per-pixel method over the same tables cost tens of ms on a
    /// 3840 frame against this loop - do not reintroduce one for whole-frame work.
    ///
    /// Quantises the way `warp_planar` does (`as u16`, not round), so the editor's
    /// materialised warp and the encode's gather cannot drift.
    pub fn apply_u16(&self, src: &[u16]) -> Vec<u16> {
        self.map_u16(src, |r, g, b| [r, g, b])
    }

    /// Gather each output pixel, quantise to `u16`, then map - one sweep for a caller
    /// that has more to do than materialise the warp (the HDR grade's colour transform).
    pub fn map_u16(
        &self,
        src: &[u16],
        map: impl Fn(u16, u16, u16) -> [u16; 3] + Sync,
    ) -> Vec<u16> {
        let (width, height) = self.size;
        let mut out = vec![0u16; width * height * 3];
        let (sw, sh) = (self.source_width, self.source_height);
        if sw < 2 || sh < 2 {
            return out;
        }
        let registered = self.per_channel.is_empty();
        let half = self.half;
        let (step_x, step_y) = self.step;
        let (centre_x, centre_y) = self.centre;
        let (edge_x, edge_y) = self.edge;
        let falloff = self.falloff;
        let sampling = self.sampling;
        let ratios = &self.shared;
        let per_channel = &self.per_channel;

        out.par_chunks_mut(width * 3).enumerate().for_each(|(y, row)| {
            let dy = (y as f64 - height as f64 / 2.0) / half;
            let dy2 = dy * dy;
            for x in 0..width {
                let dx = (x as f64 - width as f64 / 2.0) / half;
                let t = (dx * dx + dy2) * RATIO_TABLE_LAST as f64;
                let slot = if t < RATIO_TABLE_LAST as f64 { t as usize } else { RATIO_TABLE_LAST - 1 };
                let lift = match falloff {
                    None => 1.0,
                    Some((a, b)) => {
                        let at = (((dx * dx + dy2).sqrt()) * 255.0).min(255.0) as u8;
                        crate::fit::Gain::at(a, b, at)
                    }
                };
                let mut sample = [0u16; 3];
                if registered {
                    let low = ratios[slot];
                    let ratio = low + (ratios[slot + 1] - low) * (t - slot as f64);
                    let px = centre_x + dx * ratio * step_x;
                    let py = centre_y + dy * ratio * step_y;
                    if px >= 0.0 && py >= 0.0 && px <= edge_x && py <= edge_y {
                        for (c, slot_out) in sample.iter_mut().enumerate() {
                            *slot_out = (tap_u16(src, sw, sh, px, py, c, sampling) * lift)
                                .clamp(0.0, 65535.0) as u16;
                        }
                    }
                } else {
                    for (c, slot_out) in sample.iter_mut().enumerate() {
                        let table = &per_channel[c];
                        let low = table[slot];
                        let ratio = low + (table[slot + 1] - low) * (t - slot as f64);
                        let px = centre_x + dx * ratio * step_x;
                        let py = centre_y + dy * ratio * step_y;
                        if px < 0.0 || py < 0.0 || px > edge_x || py > edge_y {
                            continue;
                        }
                        *slot_out = (tap_u16(src, sw, sh, px, py, c, sampling) * lift)
                            .clamp(0.0, 65535.0) as u16;
                    }
                }
                let mapped = map(sample[0], sample[1], sample[2]);
                row[x * 3..x * 3 + 3].copy_from_slice(&mapped);
            }
        });
        out
    }
}

/// `warp` over any sample type, for the HDR path and for every output.
///
/// The SDR fit is 8-bit throughout, but the HDR one works on 16-bit scene-linear
/// samples and on the f64 planes it derives from them. Two copies of a warp is two
/// places for a sign to be wrong in, so the arithmetic lives here once and the
/// caller supplies the conversions.
///
/// A row at a time across cores. `warp` deliberately is not: it runs inside the fit's
/// own candidate scan, which is already parallel.
///
/// [`PlanarWarp::apply_u16`] / [`PlanarWarp::map_u16`] are the same gather for a warp
/// that already exists; this builds the tables and runs them. The HDR encode peaks the
/// unwarped source then gather+colours through `map_u16`; the fit still calls this for
/// f64 planes that have no `PlanarWarp` in hand.
#[allow(clippy::too_many_arguments)]
/// `falloff` is applied in the same sweep rather than by the caller afterwards. It is
/// pointwise on what the warp gathered and indexed by the output pixel's own radius,
/// which this loop has already, so a second pass over a 16-bit frame bought nothing.
/// Measured on a 3840x2560 frame, that pass cost 39ms against the warp's 99ms.
pub fn warp_planar<T: Copy + Default + Send + Sync>(
    src: &[T],
    source_width: usize,
    source_height: usize,
    width: usize,
    height: usize,
    knots: &[f64],
    crop: f64,
    falloff: Option<(f64, f64)>,
    channels: &Channels,
    sampling: Sampling,
    to_f64: impl Fn(T) -> f64 + Sync,
    from_f64: impl Fn(f64) -> T + Sync,
) -> Vec<T> {
    let mut out = vec![T::default(); width * height * 3];
    let (sw, sh) = (source_width, source_height);
    if sw < 2 || sh < 2 {
        return out;
    }
    let half = ((width as f64 / 2.0).powi(2) + (height as f64 / 2.0).powi(2)).sqrt();
    let registered = is_registered(channels);
    let ratios = ratio_table(knots, crop);
    let per_channel: Vec<Vec<f64>> = match registered {
        true => Vec::new(),
        false => channels.iter().map(|c| channel_ratio_table(knots, c, crop)).collect(),
    };
    let (scale_x, scale_y) = (sw as f64 / width as f64, sh as f64 / height as f64);
    let (centre_x, centre_y) = (sw as f64 / 2.0, sh as f64 / 2.0);
    let (step_x, step_y) = (half * scale_x, half * scale_y);
    let (edge_x, edge_y) = ((sw - 1) as f64, (sh - 1) as f64);

    out.par_chunks_mut(width * 3).enumerate().for_each(|(y, row)| {
        let dy = (y as f64 - height as f64 / 2.0) / half;
        let dy2 = dy * dy;
        for x in 0..width {
            let dx = (x as f64 - width as f64 / 2.0) / half;
            let t = (dx * dx + dy2) * RATIO_TABLE_LAST as f64;
            let slot = if t < RATIO_TABLE_LAST as f64 { t as usize } else { RATIO_TABLE_LAST - 1 };
            let lift = match falloff {
                None => 1.0,
                Some((a, b)) => {
                    let at = (((dx * dx + dy2).sqrt()) * 255.0).min(255.0) as u8;
                    crate::fit::Gain::at(a, b, at)
                }
            };
            if registered {
                let low = ratios[slot];
                let ratio = low + (ratios[slot + 1] - low) * (t - slot as f64);
                let px = centre_x + dx * ratio * step_x;
                let py = centre_y + dy * ratio * step_y;
                if px < 0.0 || py < 0.0 || px > edge_x || py > edge_y {
                    continue;
                }
                for c in 0..3 {
                    row[x * 3 + c] = from_f64(tap(src, sw, sh, px, py, c, sampling, &to_f64) * lift);
                }
                continue;
            }
            for c in 0..3 {
                let table = &per_channel[c];
                let low = table[slot];
                let ratio = low + (table[slot + 1] - low) * (t - slot as f64);
                let px = centre_x + dx * ratio * step_x;
                let py = centre_y + dy * ratio * step_y;
                if px < 0.0 || py < 0.0 || px > edge_x || py > edge_y {
                    continue;
                }
                row[x * 3 + c] = from_f64(tap(src, sw, sh, px, py, c, sampling, &to_f64) * lift);
            }
        }
    });
    out
}

/// Box-average downscale of 16-bit interleaved RGB, in whatever light the samples
/// are already in.
///
/// On a scene-linear decode that means averaging light, which is the only correct way
/// to shrink one: averaging after a transfer curve has been applied averages code
/// values instead, and darkens. Every source pixel contributes exactly once, so there
/// is no ringing either.
///
/// Only downscales; asking for a larger size returns None, since this exists to avoid
/// work rather than to invent detail.
pub fn box_resize_u16(
    src: &[u16],
    sw: usize,
    sh: usize,
    width: usize,
    height: usize,
) -> Option<Vec<u16>> {
    if width >= sw || height >= sh {
        return None;
    }
    let mut out = vec![0u16; width * height * 3];
    let xs = sw as f64 / width as f64;
    let ys = sh as f64 / height as f64;
    // A row at a time across cores: this reads every sample of the decode, which on a
    // 61MP frame is 183M of them for one 3840px rendition.
    out.par_chunks_mut(width * 3).enumerate().for_each(|(dy, out_row)| {
        let y0 = (dy as f64 * ys).floor() as usize;
        let y1 = (((dy + 1) as f64 * ys).floor() as usize).max(y0 + 1);
        for dx in 0..width {
            let x0 = (dx as f64 * xs).floor() as usize;
            let x1 = (((dx + 1) as f64 * xs).floor() as usize).max(x0 + 1);
            let mut acc = [0.0f64; 3];
            for y in y0..y1 {
                let row = y * sw;
                for x in x0..x1 {
                    let i = (row + x) * 3;
                    for c in 0..3 {
                        acc[c] += f64::from(src[i + c]);
                    }
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f64;
            for c in 0..3 {
                out_row[dx * 3 + c] = (acc[c] / n).round() as u16;
            }
        }
    });
    Some(out)
}

/// An 8-bit or 16-bit sample, so one denoise and one sharpen serve the SDR renditions
/// and the HDR ones alike (§10.9).
pub trait Sample: Copy + Default + Send + Sync {
    const FULL: f32;
    fn to_f32(self) -> f32;
    fn from_f32(value: f32) -> Self;
}

impl Sample for u8 {
    const FULL: f32 = 255.0;
    fn to_f32(self) -> f32 {
        f32::from(self)
    }
    fn from_f32(value: f32) -> u8 {
        value.clamp(0.0, 255.0).round() as u8
    }
}

impl Sample for u16 {
    const FULL: f32 = 65535.0;
    fn to_f32(self) -> f32 {
        f32::from(self)
    }
    fn from_f32(value: f32) -> u16 {
        value.clamp(0.0, 65535.0).round() as u16
    }
}

/// Samples that are already the 0..1 the filters work in.
///
/// For a caller that has to convert into a perceptual domain anyway (`edit::filter_once`):
/// going through `u16` there would quantise on the way in, again between the stages, and
/// again on the way out, for a frame whose whole point is that it is filtered once.
impl Sample for f32 {
    const FULL: f32 = 1.0;
    fn to_f32(self) -> f32 {
        self
    }
    fn from_f32(value: f32) -> f32 {
        value
    }
}

/// The blur the sharpen deconvolves, as a Gaussian sigma in output pixels.
///
/// This is **capture sharpening's** question, not creative sharpening's: what spread did
/// the resample, the demosaic and the lens put on a point, and can it be taken back off.
/// A Lanczos3 downscale to the rendition's size is most of it here. RawTherapee's
/// equivalent defaults near this and uses a 5x5 kernel below radius 0.84, which is what
/// the tap count works out to.
const DECONVOLVE_SIGMA: f32 = 0.7;

/// Richardson-Lucy iterations.
///
/// The count *is* the regularisation: RL converges towards inverting the blur exactly,
/// which on a noisy frame means converging on the noise too, so it is stopped early. Ten
/// recovers most of the edge and leaves flat areas alone; past about twenty, grain starts
/// to sharpen into speckle.
const DECONVOLVE_ITERATIONS: usize = 10;

/// Half-width of the point spread, in pixels. See `gaussian`.
const DECONVOLVE_RADIUS: usize = 2;

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
/// (`fit::lab_from_linear`, `hdr_fit::SRGB_TO_XYZ`).
pub const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];

/// BT.709 luma of a triple, in whatever domain and scale the caller's values are.
///
/// `f64` because every caller outside this module works there, and distinct from
/// `luma_of` below, which takes an interleaved pixel and normalises it.
pub fn luma709(r: f64, g: f64, b: f64) -> f64 {
    f64::from(LUMA[0]) * r + f64::from(LUMA[1]) * g + f64::from(LUMA[2]) * b
}

/// Normalised Gaussian taps for `sigma`, from the centre outwards, out to `radius`.
///
/// The radius is given rather than derived from the sigma because the point spread this
/// deconvolves is truncated on purpose: a 3-sigma tail contributes a thousandth of the
/// kernel and costs a third of every convolution, and this one runs forty times. Two is
/// the 5x5 RawTherapee uses below radius 0.84.
fn gaussian(sigma: f32, radius: usize) -> Vec<f32> {
    let taps: Vec<f32> =
        (0..=radius).map(|d| (-((d * d) as f32) / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f32 = taps[0] + 2.0 * taps[1..].iter().sum::<f32>();
    taps.into_iter().map(|t| t / sum).collect()
}

/// Separable Gaussian convolution of one plane, edges clamped.
fn convolve(plane: &[f32], width: usize, height: usize, taps: &[f32]) -> Vec<f32> {
    let mut horizontal: Vec<f32> = vec![0.0; width * height];
    horizontal.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        let source = &plane[y * width..(y + 1) * width];
        for (x, out) in row.iter_mut().enumerate() {
            let mut acc = taps[0] * source[x];
            for (d, tap) in taps.iter().enumerate().skip(1) {
                acc += tap * (source[x.saturating_sub(d)] + source[(x + d).min(width - 1)]);
            }
            *out = acc;
        }
    });

    let mut out: Vec<f32> = vec![0.0; width * height];
    out.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        for (x, sample) in row.iter_mut().enumerate() {
            let mut acc = taps[0] * horizontal[y * width + x];
            for (d, tap) in taps.iter().enumerate().skip(1) {
                let up = y.saturating_sub(d) * width + x;
                let down = (y + d).min(height - 1) * width + x;
                acc += tap * (horizontal[up] + horizontal[down]);
            }
            *sample = acc;
        }
    });
    out
}

/// Richardson-Lucy deconvolution of `observed` against a Gaussian point spread.
///
/// **This is what makes the sharpen more than an unsharp mask.** A mask adds a scaled
/// copy of the high frequencies back, which raises contrast either side of an edge and
/// leaves the overshoot behind as a halo. Deconvolution asks the other question - what
/// image, blurred by this kernel, would have produced the one in hand - and iterates
/// towards the answer, so an edge comes back *steeper* rather than merely higher
/// contrast, and it does not overshoot to get there.
///
/// The update is RL's own: divide the observation by the current estimate re-blurred,
/// blur that ratio, and scale the estimate by it. A Gaussian is symmetric, so the
/// adjoint convolution is the same one.
fn deconvolve(observed: &[f32], width: usize, height: usize, taps: &[f32], iterations: usize) -> Vec<f32> {
    // Away from zero, since the update divides by the estimate's own blur. A frame in
    // 0..1 with true blacks would otherwise produce infinities on the first pass.
    const FLOOR: f32 = 1e-4;
    let mut estimate: Vec<f32> = observed.par_iter().map(|v| v.max(FLOOR)).collect();
    for _ in 0..iterations {
        let blurred = convolve(&estimate, width, height, taps);
        let ratio: Vec<f32> = blurred
            .par_iter()
            .zip(observed.par_iter())
            .map(|(b, o)| o.max(FLOOR) / b.max(FLOOR))
            .collect();
        let correction = convolve(&ratio, width, height, taps);
        estimate.par_iter_mut().zip(correction.par_iter()).for_each(|(e, c)| *e *= c);
    }

    // **Anti-ringing, and it is not optional.** RL converges on the maximum-likelihood
    // inverse, and for a band-limited kernel against a hard edge that solution rings:
    // measured on a step from 60 to 180, ten iterations undershot to 54. Clamping each
    // output to the range its own neighbourhood already spanned removes the overshoot
    // while leaving every recovery *within* that range untouched - which is all of the
    // sharpening and none of the halo.
    let (low, high) = local_extrema(observed, width, height, taps.len() - 1);
    estimate
        .par_iter_mut()
        .zip(low.par_iter().zip(high.par_iter()))
        .for_each(|(e, (l, h))| *e = e.clamp(*l, *h));
    estimate
}

/// The smallest and largest sample within `radius` of each pixel, separably.
///
/// Separable because min and max are, like a mean: the extremum of a square window is the
/// extremum over columns of the extrema over rows.
fn local_extrema(plane: &[f32], width: usize, height: usize, radius: usize) -> (Vec<f32>, Vec<f32>) {
    let sweep = |plane: &[f32], keep_low: bool| {
        let pick = |a: f32, b: f32| if keep_low { a.min(b) } else { a.max(b) };
        let mut horizontal: Vec<f32> = vec![0.0; width * height];
        horizontal.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
            let source = &plane[y * width..(y + 1) * width];
            for (x, out) in row.iter_mut().enumerate() {
                let low = x.saturating_sub(radius);
                let high = (x + radius).min(width - 1);
                *out = source[low..=high].iter().copied().fold(source[x], pick);
            }
        });
        let mut out: Vec<f32> = vec![0.0; width * height];
        out.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
            let low = y.saturating_sub(radius);
            let high = (y + radius).min(height - 1);
            for (x, sample) in row.iter_mut().enumerate() {
                let mut value = horizontal[y * width + x];
                for j in low..=high {
                    value = pick(value, horizontal[j * width + x]);
                }
                *sample = value;
            }
        });
        out
    };
    (sweep(plane, true), sweep(plane, false))
}

/// Mean over a (2r+1) square, in constant time per pixel whatever the radius.
///
/// A sliding sum rather than a convolution: each step adds the column entering the
/// window and subtracts the one leaving it, so the cost does not grow with the radius at
/// all. That is what makes the guided filter below affordable at a radius where a
/// Gaussian would not be - and it is why the filter is written against box means rather
/// than the nicer-looking Gaussian.
///
/// The window shrinks at the border rather than clamping the samples, so an edge pixel
/// is the mean of what is actually there instead of one sample counted several times.
fn box_mean(plane: &[f32], width: usize, height: usize, radius: usize) -> Vec<f32> {
    let mut horizontal: Vec<f32> = vec![0.0; width * height];
    horizontal.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        let source = &plane[y * width..(y + 1) * width];
        let mut sum: f32 = source[..=radius.min(width - 1)].iter().sum();
        for x in 0..width {
            let low = x.saturating_sub(radius);
            let high = (x + radius).min(width - 1);
            row[x] = sum / (high - low + 1) as f32;
            if x + radius + 1 < width {
                sum += source[x + radius + 1];
            }
            if x >= radius {
                sum -= source[x - radius];
            }
        }
    });

    // Vertically in bands rather than a column at a time. A column sweep strides the
    // whole row width per step and misses the cache on every one; a band walks rows in
    // order, carrying one accumulator row, and each band is independent so they still
    // run across cores. The cost is re-seeding the accumulator per band, which is
    // `radius` extra row additions.
    let band = height.div_ceil(crate::parallel::thread_count().max(1)).max(1);
    let mut out: Vec<f32> = vec![0.0; width * height];
    out.par_chunks_mut(band * width).enumerate().for_each(|(index, rows)| {
        let first = index * band;
        let last = (first + rows.len() / width).min(height);
        let mut acc: Vec<f32> = vec![0.0; width];
        // The window for the band's first row, which reaches above the band.
        for y in first.saturating_sub(radius)..=(first + radius).min(height - 1) {
            for x in 0..width {
                acc[x] += horizontal[y * width + x];
            }
        }
        for y in first..last {
            let low = y.saturating_sub(radius);
            let high = (y + radius).min(height - 1);
            let count = (high - low + 1) as f32;
            let row = &mut rows[(y - first) * width..(y - first + 1) * width];
            for x in 0..width {
                row[x] = acc[x] / count;
            }
            if y + radius + 1 < height {
                for x in 0..width {
                    acc[x] += horizontal[(y + radius + 1) * width + x];
                }
            }
            if y >= radius {
                for x in 0..width {
                    acc[x] -= horizontal[(y - radius) * width + x];
                }
            }
        }
    });
    out
}

/// He, Sun and Tang's guided filter: `input` smoothed wherever `guide` is flat, left
/// alone wherever `guide` has an edge.
///
/// Every window gets the linear fit `q = a*guide + b` that best explains `input` there,
/// with `a` damped by `eps`. Where the guide varies a lot - an edge - `a` goes to 1 and
/// the output follows the guide; where it barely varies, `a` goes to 0 and the output is
/// the local mean. So the smoothing is *steered by structure* rather than by distance,
/// which is what a Gaussian cannot do and a bilateral filter pays dearly for.
///
/// Two uses here, and they are the two this module needs:
///
/// - **Guide the chroma with luma.** Colour then follows the edges the eye is actually
///   reading, so the radius can go far past where a plain blur would wash red across a
///   white window frame. It is the filter's canonical application.
/// - **Guide luma with itself** and subtract, which is an unsharp mask whose base layer
///   respects edges - so it has no halo to speak of, and `eps` doubles as the noise
///   floor: detail below that amplitude stays in the base and is never boosted.
///
/// Planes are in 0..1, so `eps` is a variance in those units and means the same thing
/// at either depth. Six box means, all O(1) in the radius.
/// The part of a guided filter that depends only on the guide.
///
/// Split out because both chroma channels are guided by the same luma, and computing
/// this twice is two box means and a whole-frame product for an answer already in hand.
struct Guide {
    mean: Vec<f32>,
    variance: Vec<f32>,
}

fn guide_stats(guide: &[f32], width: usize, height: usize, radius: usize) -> Guide {
    let pixels = width * height;
    let mean = box_mean(guide, width, height, radius);
    // Scoped so the squares and their mean are freed here rather than at the end of the
    // function. Every plane is a whole frame - 39MB at a 3840px rendition, 96MB at 24MP
    // native - and Rust holds a temporary to the end of its scope rather than to its last
    // use, so on this path scoping is most of the memory (§10.9).
    let variance = {
        let squares: Vec<f32> = (0..pixels).into_par_iter().map(|i| guide[i] * guide[i]).collect();
        let mean_squares = box_mean(&squares, width, height, radius);
        drop(squares);
        (0..pixels).into_par_iter().map(|i| mean_squares[i] - mean[i] * mean[i]).collect()
    };
    Guide { mean, variance }
}

/// Applies the local linear fit and averages it back out. The tail of `guided`, taking
/// the guide's own statistics as already computed.
fn guided_with(
    stats: &Guide,
    guide: &[f32],
    mean_input: &[f32],
    covariance: &[f32],
    width: usize,
    height: usize,
    radius: usize,
    eps: f32,
) -> Vec<f32> {
    let pixels = width * height;
    // `a` is the covariance over the variance, which is the slope of the fit, and `eps`
    // is what stops a window of pure noise producing a confident one.
    let a: Vec<f32> = (0..pixels)
        .into_par_iter()
        .map(|i| {
            // A window with no variance and no regularisation is 0/0. It happens
            // whenever a flat region meets a noise estimate of zero, which a synthetic
            // input produces immediately and a photograph never does - so it is a NaN
            // that reaches production long after it stops being findable. No variance
            // means no structure to follow, which is a slope of zero.
            let denominator = stats.variance[i] + eps;
            match denominator > f32::EPSILON {
                true => covariance[i] / denominator,
                false => 0.0,
            }
        })
        .collect();
    // Averaged again because a pixel sits in many windows and each has its own fit.
    // Scoped so the fits are freed before the output plane is built.
    let (mean_a, mean_b) = {
        let b: Vec<f32> =
            (0..pixels).into_par_iter().map(|i| mean_input[i] - a[i] * stats.mean[i]).collect();
        let mean_a = box_mean(&a, width, height, radius);
        drop(a);
        (mean_a, box_mean(&b, width, height, radius))
    };
    (0..pixels).into_par_iter().map(|i| mean_a[i] * guide[i] + mean_b[i]).collect()
}

/// One channel of `input`, smoothed under `guide`'s edges.
fn guided(
    stats: &Guide,
    guide: &[f32],
    input: &[f32],
    width: usize,
    height: usize,
    radius: usize,
    eps: f32,
) -> Vec<f32> {
    let pixels = width * height;
    let mean_input = box_mean(input, width, height, radius);
    // Scoped for the same reason as `guide_stats`: the cross product and its mean are
    // dead the moment the covariance exists, and both are whole frames.
    let covariance: Vec<f32> = {
        let cross: Vec<f32> = (0..pixels).into_par_iter().map(|i| guide[i] * input[i]).collect();
        let mean_cross = box_mean(&cross, width, height, radius);
        drop(cross);
        (0..pixels)
            .into_par_iter()
            .map(|i| mean_cross[i] - stats.mean[i] * mean_input[i])
            .collect()
    };
    guided_with(stats, guide, &mean_input, &covariance, width, height, radius, eps)
}

/// `guide` smoothed under its own edges, which is the filter's denoising form.
///
/// Half the work of the general case rather than a convenience: guided by itself, the
/// input's mean *is* the guide's mean and the covariance *is* the variance, so four of
/// the six box means collapse into two already computed.
fn self_guided(
    stats: &Guide,
    guide: &[f32],
    width: usize,
    height: usize,
    radius: usize,
    eps: f32,
) -> Vec<f32> {
    guided_with(stats, guide, &stats.mean, &stats.variance, width, height, radius, eps)
}

/// How closely the chroma is made to follow the luma's edges.
///
/// Small, because the guide is trusted: chroma genuinely has no structure of its own
/// that luma does not also have, so anywhere luma is flat the colour should be smoothed
/// as hard as the radius allows.
const DENOISE_EPS: f32 = 1e-4;

/// Radii the chroma denoise fits its local model over at `raw_denoise_chroma` 1, in pixels.
///
/// **Two scales, because chroma noise has two.** The fine one is per-pixel speckle. The
/// coarse one is low-frequency mottle - patches of green and magenta the size of a
/// window, which a demosaic spreads and an amplified read leaves behind - and a radius
/// that clears the speckle cannot touch it, because a 9-pixel window cannot average away
/// a 40-pixel blotch. The first pass took the speckle out and left exactly that.
///
/// Cascading is affordable only because the filter is O(1) in the radius: the 32 costs
/// what the 4 does. A Gaussian at that radius would be 97 taps a pixel and out of the
/// question, which is most of why the filter underneath is the one it is.
const DENOISE_CHROMA_RADII: [usize; 2] = [4, 32];

/// The most the coarse chroma pass may move a colour, as a fraction of full scale.
///
/// **The luma guide is not enough on its own at this radius**, and finding out why is
/// worth writing down: it can only protect an edge it can *see*. A red wall meeting a
/// grey roof is a large step in colour and a small one in luma, so a 65-pixel window
/// spanning both fits one linear model across the pair and pours red onto the roof.
///
/// Amplitude separates the two cases where the guide cannot. Low-frequency chroma noise
/// is a couple of percent; a wall against a roof is tens of percent. So the coarse pass
/// is allowed to remove a blotch and not to restructure a picture - the same shape of
/// guard as the deconvolution's anti-ringing clamp, and for the same reason.
const DENOISE_CHROMA_COARSE_LIMIT: f32 = 0.02;

/// Radius the luma denoise fits its local model over, in pixels.
///
/// **Set by how well the window can estimate a variance, not by how much of the picture
/// it should see.** The filter's blend is `var / (var + eps)`, so it is deciding "flat or
/// detail" from a variance measured over the window - and a variance from n samples is
/// itself uncertain by about `sqrt(2/n)`. A radius of 2 is 25 samples and 29% uncertain,
/// which lands as *patchy smoothing*: neighbouring parts of one roof come out blurred or
/// grainy depending on which way the estimate happened to fall, and that reads worse than
/// the grain it was removing. 6 is 169 samples and 11%, which is uniform.
///
/// The window being wider does not blur more. What it may not do is *resolve* detail
/// narrower than itself as detail, which is why this is not wider still.
const LUMA_DENOISE_RADIUS: usize = 6;

/// How many standard deviations of the estimated noise count as "still noise".
///
/// The luma denoise is a self-guided filter, so its `eps` is a variance and this is what
/// that variance is expressed in. A window of pure noise blends at `1 / (1 + k^2)`, so
/// this is directly how much of the grain survives: 2 leaves a fifth of it, 1.4 leaves a
/// third.
///
/// **1.4, deliberately short of what the metric would pick.** At 2 the numbers are better
/// and a dark roof at 100% has visibly lost its shingle texture along with its grain -
/// and between the two, grain is the one that reads as a photograph and smearing is the
/// one that reads as a fault. Luma is the plane where being wrong is expensive, so it is
/// tuned to be wrong in the recoverable direction.
const LUMA_DENOISE_SIGMAS: f32 = 1.4;

/// Bins in the noise estimate's histogram, over a high-pass magnitude of 0..`NOISE_MAX`.
const NOISE_BINS: usize = 1024;
const NOISE_MAX: f32 = 0.08;

/// The frame's own noise level, as a standard deviation in 0..1 luma units.
///
/// **Estimated rather than derived from the ISO**, which is the better of the two even
/// though the ISO is right there: a frame's noise depends on the exposure it was pushed
/// from and how much the grade lifted it, and by this point in the pipeline it has also
/// been through a resample that averaged some of it away. The number wanted is the noise
/// *in the frame in hand*, and the frame can be asked.
///
/// The estimator is the standard one from wavelet shrinkage: take a high-pass residual,
/// and read its **median** absolute value rather than its mean. A median is what makes it
/// work on a photograph - edges and texture are a minority of pixels and arbitrarily
/// large, so they drag a mean anywhere, while the median sits among the ordinary pixels
/// where the only signal is noise. The 1.4826 recovers a Gaussian sigma from that median.
///
/// **The median is taken over the pixels that vary at all**, not over the whole frame,
/// and that is a correctness fix rather than a refinement. A pixel whose residual is
/// *exactly* zero is not a quiet noise sample; it is a pixel with no high-frequency
/// content whatsoever - clipped sky, a black letterbox, a blown highlight - and it says
/// nothing about the noise. Counting them, a frame that is half blown sky puts the median
/// in that flat half and reports **zero noise**, which sets `eps` to zero and turns the
/// entire luma denoise into an identity. It is a cliff rather than a taper: 40% sky
/// denoises fully, 45% not at all.
///
/// Ceilinged for the opposite case. A frame that is *mostly* fine detail - a wall of
/// close stripes - has a large median residual that is signal rather than noise, and
/// without a ceiling the filter smooths luma to its local mean and takes the detail with
/// it. Sensor noise surviving a demosaic and a resample does not reach 2% of full scale,
/// so past that this is reading texture and should stop believing itself.
const NOISE_CEILING: f32 = 0.02;

#[cfg(all(test, feature = "fixtures"))]
pub fn _for_testing_noise_ceiling() -> f32 {
    NOISE_CEILING
}

#[cfg(all(test, feature = "fixtures"))]
pub fn _for_testing_measure_noise<T: Sample>(frame: &[T], width: usize, height: usize) -> f32 {
    // The strip height production would use, so this measures what production measures.
    let halo = Radii::for_strength(1.0).halo(true, true, true, true);
    measure_noise(frame, width, height, strip_interior(width, halo))
}

/// The estimate, off a histogram of high-pass magnitudes.
///
/// Split from the pass that fills it so the whole frame's histogram can be accumulated
/// strip by strip: the estimate has to be global or each strip would denoise by a
/// different amount and seam, but nothing about it needs the frame resident at once.
fn sigma_from(bins: &[u32]) -> f32 {
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
    // The residual of a 3x3 mean keeps most of a pixel's own noise but not all of it,
    // and the median of a half-normal is 0.6745 sigma. Both are folded in here.
    (median * 1.4826 / 0.83).min(NOISE_CEILING)
}

/// The luma of one interleaved RGB pixel, in 0..1.
fn luma_of<T: Sample>(p: &[T]) -> f32 {
    (LUMA[0] * p[0].to_f32() + LUMA[1] * p[1].to_f32() + LUMA[2] * p[2].to_f32()) / T::FULL
}

/// The radii every stage works over, which between them decide how far a strip has to
/// reach past its own rows (§10.9).
struct Radii {
    luma: usize,
    fine: usize,
    coarse: usize,
}

impl Radii {
    fn for_strength(chroma: f64) -> Radii {
        let [fine, coarse] = DENOISE_CHROMA_RADII;
        let scaled = |base: usize| (base as f64 * chroma).round().max(1.0) as usize;
        Radii { luma: LUMA_DENOISE_RADIUS, fine: scaled(fine), coarse: scaled(coarse) }
    }

    /// Rows a strip must carry beyond its own, above and below, for its output to be
    /// what a whole-frame run would have produced.
    ///
    /// **A guided filter of radius r reaches 2r, not r**: it box-means the input and then
    /// box-means the fit, so the support is the two composed. The chroma path composes
    /// three of them - it is guided by a luma that was itself filtered, then filtered
    /// again at the coarse radius - so the reaches add. Richardson-Lucy adds the point
    /// spread once per convolution, twice per iteration, and the anti-ringing clamp adds
    /// its own window on top.
    fn halo(&self, luma: bool, chroma: bool, sharpen: bool, defringe: bool) -> usize {
        // The defringe reads a five-point Laplacian and nothing else, so it reaches one
        // pixel. It was 10 - a box mean of the colour plus a dilated edge mask - and both
        // went with the estimator that replaced them.
        let fringe = match defringe {
            true => 1,
            false => 0,
        };
        let cleaned = match luma {
            true => 2 * self.luma,
            false => 0,
        };
        let colour = match chroma {
            true => cleaned + 2 * (self.fine + self.coarse),
            false => 0,
        };
        let deconvolve = match sharpen {
            true => 2 * DECONVOLVE_RADIUS * DECONVOLVE_ITERATIONS + DECONVOLVE_RADIUS + cleaned,
            false => 0,
        };
        // The defringe runs first, so whatever it reaches is added to whatever runs after
        // it rather than taken as an alternative.
        fringe + colour.max(cleaned).max(deconvolve)
    }
}

/// Rows of a strip that are kept, chosen to bound the scratch the stages allocate.
///
/// The stages hold on the order of a dozen `f32` planes of whatever they are handed, so
/// the only thing that bounds them is how many rows they are handed. This trades a little
/// duplicated work at the seams - each strip also computes its halo, and throws it away -
/// for a peak that does not grow with the frame.
fn strip_interior(width: usize, halo: usize) -> usize {
    // **Measured, not guessed, and it was 64MB.** Every strip recomputes its halo and
    // throws it away, so a budget that leaves a thin interior pays for the same rows over
    // and over. With all four stages on, the halo is 85 rows - the chroma coarse radius
    // composed through the guided filter - and at 64MB a 3840-wide frame kept an interior
    // of 194, processing 1.99 rows for every row it wanted.
    //
    // `finish` over 3840x2560, all four stages, against the rows it actually processes:
    //
    //     32MB   interior   85   3.09x   2255ms    90MB
    //     64MB   interior  194   1.99x   1420ms   106MB
    //    128MB   interior  558   1.42x   1048ms   177MB
    //    256MB   interior 1286   1.14x    853ms   286MB
    //    512MB   interior 2742   1.14x   1433ms   458MB
    //
    // 512 buys no fewer rows than 256 and is slower, so this is close to the floor rather
    // than a point on a curve. And the memory is free where it matters: whole-job peak RSS
    // on a 24MP render is 426MB at either budget, because the decode and the AVIF encoder
    // already peak above the scratch.
    //
    // The native-resolution case is where the old value was worst, and it is the case this
    // function exists for. At 9504 wide, 64MB could not even buy an interior as thick as
    // the halo, so it clamped to the floor below and spent 116MB anyway - over budget *and*
    // processing 3.02 rows per row.
    //
    // **Measured end to end on a 61MP body**, which is the export that pays for this
    // function existing. A native `max` rendition of DSC06181:
    //
    //     scratch    wall      cpu   peak RSS
    //      64MB    22.4s    71.1s     1255MB
    //     256MB    14.0s    42.3s     1253MB
    //
    // Peak is *identical* - the 61MP decode and the AVIF encoder already sit at 1.25GB, so
    // the wider strips fit inside a high-water mark they do not set. 38% off the wall clock
    // for nothing. The same body at 3840 goes 3.52s to 3.22s wall for +18MB, the resize
    // landing ahead of the finish.
    //
    // Worth knowing before lowering this again: the pathology is not the budget being
    // large, it is a budget too small to buy an interior worth having, which spends nearly
    // the same memory and does the work twice.
    const SCRATCH_BUDGET: usize = 256 * 1024 * 1024;
    const PLANES: usize = 12;
    let rows = SCRATCH_BUDGET / (width.max(1) * PLANES * std::mem::size_of::<f32>());
    // **Solved for the whole strip, not its interior.** A strip allocates
    // `interior + 2 * halo` rows, and the halo term is fixed in rows, so budgeting only
    // the interior lets the peak grow linearly in the frame's *width* - measured at 2.7x
    // the budget on a 9504-wide frame, which is exactly the native-resolution case this
    // exists for.
    let interior = rows.saturating_sub(2 * halo);
    // Never thinner than the halo: below that a strip's context reaches back into rows an
    // earlier strip has already overwritten, which `finish_in_strips` cannot detect.
    // It also floors the planes at `3 * halo` rows, which is the one case the budget
    // cannot honour - a very wide frame at a very high strength - and the alternative
    // would be to fail rather than to spend the memory.
    interior.max(halo).max(32)
}

/// Denoise and sharpen a rendered frame in place, at the size it will be encoded at.
///
/// Four stages over one deinterleave, in an order that is not interchangeable (§10.9):
///
/// 1. **Defringe**, before either denoise, because its regressor is the curvature of luma
///    and its coefficient was fitted against the *raw* luma over the whole frame.
/// 2. **Luma denoise**, a self-guided filter whose `eps` is the frame's own measured
///    noise. Here the guided filter is used the way round it was designed for: a window
///    that varies by less than the noise is smoothed to its mean, one holding an edge
///    keeps it. Luma was left untouched at first on the theory that grain reads as
///    texture. On a working-ISO frame it reads as dirt, and it is what remains
///    objectionable once the colour mottle is gone.
/// 3. **Chroma denoise**, guided by the luma just cleaned. Colour noise is blotchy where
///    luma noise is per-pixel, so it takes a far wider radius - and guiding it by luma is
///    what lets the radius grow without washing the red of a wall onto the white window
///    frames beside it. It is the guided filter's canonical application.
/// 4. **Sharpen**, by deconvolution, on the cleaned luma. Denoising first is not a
///    preference: Richardson-Lucy has no noise model and will happily invert grain as if
///    it were blur, so anything left in luma at this point is sharpened into speckle.
///
/// `defringe` caps the first, `luma` scales the second, `chroma` the third and `sharpen`
/// blends the fourth. Each is 0 for off, and the whole thing is skipped when none is asked
/// for.
///
/// Whatever transfer the samples are already in, and that is a constraint on the caller
/// rather than a detail: differences taken in linear light are proportional to absolute
/// luminance, so they treat a highlight and a shadow completely differently. Both callers
/// hand over display-referred samples - sRGB for a rendition, PQ for the HDR pair - which
/// is where a difference means what the eye reads.
pub fn finish<T: Sample>(frame: &mut [T], width: usize, height: usize, strengths: Strengths) {
    let interior = strip_interior(width, strengths.halo());
    finish_in_strips(frame, width, height, strengths, interior);
}

/// The two whole-frame measurements `finish` makes before it filters anything.
///
/// For a caller that runs the filters elsewhere: the editor's tick is a shader now, and
/// re-measuring per exposure would mean a reduction per tick for numbers that barely move
/// between them. Reusing them across ticks is the lever DESIGN §21.1.1 lists and does not
/// take; here it is taken, and the strengths are already folded in exactly as
/// `finish_in_strips` folds them.
pub fn measurements<T: Sample>(
    frame: &[T],
    width: usize,
    height: usize,
    strengths: Strengths,
) -> (f32, (f32, f32)) {
    if !strengths.does_anything() || width < 3 || height < 3 || frame.len() < width * height * 3 {
        return (0.0, (0.0, 0.0));
    }
    let frame = &frame[..width * height * 3];
    let interior = strip_interior(width, strengths.halo()).max(strengths.halo()).max(1);

    let sigma = match strengths.luma > 0.0 {
        true => measure_noise(frame, width, height, interior) * strengths.luma as f32,
        false => 0.0,
    };
    let defocus = match strengths.defringe > 0.0 {
        true => measure_defocus(frame, width, height)
            .map(|(r, b)| {
                let scale = strengths.defringe.clamp(0.0, 1.0) as f32;
                (r * scale, b * scale)
            })
            .unwrap_or((0.0, 0.0)),
        false => (0.0, 0.0),
    };
    (sigma, defocus)
}

/// `finish`, over strips of a given height.
///
/// The height is a parameter only so a test can drive the same frame through one strip
/// and through several and require the same answer - which is the property the halo
/// exists for, and cannot be checked by shrinking the frame instead, because the noise
/// estimate is global and a shorter frame is a different measurement.
fn finish_in_strips<T: Sample>(
    frame: &mut [T],
    width: usize,
    height: usize,
    strengths: Strengths,
    interior: usize,
) {
    let Strengths { luma, .. } = strengths;
    if !strengths.does_anything() || width < 3 || height < 3 || frame.len() < width * height * 3 {
        return;
    }
    // Bounded to what the dimensions claim, so a caller passing a longer buffer gets the
    // frame processed rather than a chunk indexed past the end of the planes.
    let frame = &mut frame[..width * height * 3];
    let halo = strengths.halo();
    // **Enforced here, not just where the caller picks it.** A strip thinner than the
    // halo needs context from rows an earlier strip has already written over, and `carry`
    // only holds the last `halo` of them - so it would hand the next strip its
    // neighbour's *output* as if it were input, silently, with no panic and no seam loud
    // enough for the tolerance below to catch. Measured at an interior of 10: rows wrong
    // by 257 counts against a whole-frame run.
    let interior = interior.max(halo).max(1);

    // Measured over the whole frame before anything is filtered, because a per-strip
    // estimate would have each strip denoise by a different amount and seam.
    // Scaled by the luma strength, since it is the luma filter's regularisation and
    // nothing else reads it.
    let sigma = match luma > 0.0 {
        true => measure_noise(frame, width, height, interior) * luma as f32,
        false => 0.0,
    };

    // Measured over the whole frame for the same reason, and it has a second: the
    // coefficient *is* the correction, so a per-strip fit would correct each strip by a
    // different amount and leave a seam at every boundary. Scaled by the setting, which is
    // now a ceiling on a measurement rather than the amount itself.
    let defocus = match strengths.defringe > 0.0 {
        true => measure_defocus(frame, width, height)
            .map(|(r, b)| {
                let scale = strengths.defringe.clamp(0.0, 1.0) as f32;
                (r * scale, b * scale)
            })
            .unwrap_or((0.0, 0.0)),
        false => (0.0, 0.0),
    };

    filter_in_strips(frame, width, height, strengths, interior, sigma, defocus);
}

/// `finish`, against measurements the caller already has.
///
/// The editor's client takes both once at open and reuses them (`edit::PreparedHeader`), so
/// the parity fixture has to hold the CPU to the same two numbers - otherwise the harness
/// measures that decision rather than the port it exists to check.
pub fn finish_with<T: Sample>(
    frame: &mut [T],
    width: usize,
    height: usize,
    strengths: Strengths,
    sigma: f32,
    defocus: (f32, f32),
) {
    if !strengths.does_anything() || width < 3 || height < 3 || frame.len() < width * height * 3 {
        return;
    }
    let frame = &mut frame[..width * height * 3];
    let interior = strip_interior(width, strengths.halo()).max(strengths.halo()).max(1);
    filter_in_strips(frame, width, height, strengths, interior, sigma, defocus);
}

/// The strip loop itself, once the two whole-frame measurements are settled.
fn filter_in_strips<T: Sample>(
    frame: &mut [T],
    width: usize,
    height: usize,
    strengths: Strengths,
    interior: usize,
    sigma: f32,
    defocus: (f32, f32),
) {
    let radii = Radii::for_strength(strengths.chroma);
    let halo = strengths.halo();

    // The rows a strip overwrites are the next strip's context, so the originals of the
    // last `halo` of them are kept back before the write. Small - `halo` rows of the
    // frame, against the planes this exists to bound.
    let mut carry: Vec<T> = Vec::new();
    let mut start = 0;
    while start < height {
        let end = (start + interior).min(height);
        let top = start.saturating_sub(halo);
        let bottom = (end + halo).min(height);
        let rows = bottom - top;

        let (mut plane, mut red, mut blue) = deinterleave(frame, &carry, width, top, start, bottom);
        finish_strip(&mut plane, &mut red, &mut blue, width, rows, &radii, sigma, defocus, &strengths);

        // Before the write, since the write is what destroys them.
        carry = keep_back(frame, width, end.saturating_sub(halo), end);
        recombine(frame, &plane, &red, &blue, width, top, start, end);
        start = end;
    }
}

/// The three planes for one strip, in 0..1, with rows above `start` taken from `carry`
/// where a previous strip has already overwritten them.
fn deinterleave<T: Sample>(
    frame: &[T],
    carry: &[T],
    width: usize,
    top: usize,
    start: usize,
    bottom: usize,
) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let rows = bottom - top;
    let mut luma: Vec<f32> = vec![0.0; width * rows];
    let mut red: Vec<f32> = vec![0.0; width * rows];
    let mut blue: Vec<f32> = vec![0.0; width * rows];
    // `carry` holds the rows [start - carried, start) as they were before the previous
    // strip wrote over them.
    let carried = carry.len() / (width * 3);
    luma.par_chunks_mut(width)
        .zip(red.par_chunks_mut(width))
        .zip(blue.par_chunks_mut(width))
        .enumerate()
        .for_each(|(row, ((luma_row, red_row), blue_row))| {
            let y = top + row;
            for x in 0..width {
                let p = match y < start && carried > 0 {
                    true => &carry[((y - (start - carried)) * width + x) * 3..],
                    false => &frame[(y * width + x) * 3..],
                };
                let l = luma_of(p);
                luma_row[x] = l;
                red_row[x] = p[0].to_f32() / T::FULL - l;
                blue_row[x] = p[2].to_f32() / T::FULL - l;
            }
        });
    (luma, red, blue)
}

/// A copy of rows `[from, to)` exactly as they stand, to serve as the next strip's
/// context once this strip has written over them.
fn keep_back<T: Sample>(frame: &[T], width: usize, from: usize, to: usize) -> Vec<T> {
    frame[from * width * 3..to * width * 3].to_vec()
}

/// Writes rows `[start, end)` of a processed strip back into the frame.
fn recombine<T: Sample>(
    frame: &mut [T],
    luma: &[f32],
    red: &[f32],
    blue: &[f32],
    width: usize,
    top: usize,
    start: usize,
    end: usize,
) {
    frame[start * width * 3..end * width * 3]
        .par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(row, out)| {
            let i = (start - top + row) * width;
            for x in 0..width {
                let (l, dr, db) = (luma[i + x], red[i + x], blue[i + x]);
                // Solving the luma equation for green with the other two differences
                // known is what makes the recombination exactly luma-preserving.
                let dg = -(LUMA[0] * dr + LUMA[2] * db) / LUMA[1];
                out[x * 3] = T::from_f32((l + dr) * T::FULL);
                out[x * 3 + 1] = T::from_f32((l + dg) * T::FULL);
                out[x * 3 + 2] = T::from_f32((l + db) * T::FULL);
            }
        });
}

/// The frame's noise, measured strip by strip so the estimate costs one plane rather
/// than one per frame.
///
/// The histogram is the whole state carried between strips, and it is 4kB.
fn measure_noise<T: Sample>(frame: &[T], width: usize, height: usize, interior: usize) -> f32 {
    let mut bins = vec![0u32; NOISE_BINS];
    let mut start = 0;
    while start < height {
        // One row of context either side, which is all a radius-1 box mean reaches.
        let end = (start + interior).min(height);
        let top = start.saturating_sub(1);
        let bottom = (end + 1).min(height);
        let rows = bottom - top;
        let mut luma: Vec<f32> = vec![0.0; width * rows];
        luma.par_chunks_mut(width).enumerate().for_each(|(row, out)| {
            for x in 0..width {
                out[x] = luma_of(&frame[((top + row) * width + x) * 3..]);
            }
        });
        let smooth = box_mean(&luma, width, rows, 1);
        for y in start..end {
            let row = (y - top) * width;
            for x in 0..width {
                let residual = (luma[row + x] - smooth[row + x]).abs();
                let slot = (residual / NOISE_MAX * NOISE_BINS as f32) as usize;
                bins[slot.min(NOISE_BINS - 1)] += 1;
            }
        }
        start = end;
    }
    sigma_from(&bins)
}

/// Samples of real curvature the estimate needs before it will believe itself.
const DEFOCUS_MIN_SAMPLES: usize = 2000;

/// Every nth pixel in each direction the estimate reads.
///
/// The coefficient is one number for the whole frame, so a 24MP frame at 3 still offers a
/// million samples and reading them all buys nothing.
const DEFOCUS_STRIDE: usize = 3;

/// Beyond this it is not a focus difference, it is a frame the model had no business
/// being fitted on. A coefficient is a blur difference in pixels squared; the worst real
/// measurement is a small fraction of one.
const DEFOCUS_MAX: f32 = 0.5;

/// Below this a coefficient is indistinguishable from zero, so it neither corrects
/// anything nor gets a vote on whether the other channel is believable.
///
/// Measured against a channel that is genuinely defocused: IMG_8408's blue reads 0.148
/// where its red reads -0.011, and treating that -0.011 as a real disagreement threw the
/// whole frame away.
const DEFOCUS_NOISE: f32 = 0.02;

/// The five-point Laplacian of a plane, clamped at the border.
///
/// The regressor and the correction both read this, and they must read the same thing:
/// the coefficient is fitted as "colour per unit of curvature", so a correction taken
/// against a differently-scaled curvature is a differently-scaled correction.
fn laplacian(plane: &[f32], width: usize, height: usize) -> Vec<f32> {
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
const DEFOCUS_BINS: usize = 6;

/// Samples a bin needs before its own coefficient is believed.
const DEFOCUS_MIN_PER_BIN: usize = 200;

/// Bins that must resolve before the constant and the `r^2` term can be told apart. Two
/// points fit a line exactly and prove nothing about whether the profile is one.
const DEFOCUS_MIN_BINS: usize = 3;

/// One radial bin's running sums, for `measure_defocus`.
#[derive(Default)]
struct Bins {
    cross_red: [f64; DEFOCUS_BINS],
    cross_blue: [f64; DEFOCUS_BINS],
    square: [f64; DEFOCUS_BINS],
    counted: [usize; DEFOCUS_BINS],
}

impl Bins {
    fn merge(mut self, other: Bins) -> Bins {
        for bin in 0..DEFOCUS_BINS {
            self.cross_red[bin] += other.cross_red[bin];
            self.cross_blue[bin] += other.cross_blue[bin];
            self.square[bin] += other.square[bin];
            self.counted[bin] += other.counted[bin];
        }
        self
    }
}

/// Each channel's noise sigma, in 0..1, by the same median-residual route `measure_noise`
/// takes for luma.
///
/// Per channel because the defocus fit's bias depends on the three separately: green's
/// noise enters the regressor and the response with opposite signs, red's enters only one.
/// A single luma figure cannot express that.
fn channel_sigmas<T: Sample>(frame: &[T], width: usize, height: usize) -> [f64; 3] {
    let mut out = [0.0f64; 3];
    for (channel, sigma) in out.iter_mut().enumerate() {
        let plane: Vec<f32> = (0..width * height)
            .map(|i| frame[i * 3 + channel].to_f32() / T::FULL)
            .collect();
        let smooth = box_mean(&plane, width, height, 1);
        let mut bins = vec![0u32; NOISE_BINS];
        for (value, mean) in plane.iter().zip(&smooth) {
            let residual = (value - mean).abs();
            let slot = (residual / NOISE_MAX * NOISE_BINS as f32) as usize;
            bins[slot.min(NOISE_BINS - 1)] += 1;
        }
        *sigma = f64::from(sigma_from(&bins));
    }
    out
}

/// How much of each channel's colour is the curvature of luma, over the whole frame.
///
/// **This is the measurement the stage used to lack, and the reason it needed a setting to
/// tell it when to stop.** A focus difference between channels is not an arbitrary colour
/// at an edge: with `sigma_R = sigma_G + d` and the heat equation `dg/dsigma = sigma.lap g`,
/// an achromatic edge imaged through the two comes out as
///
/// ```text
///     R - G  =  L * (g_sigmaR - g_sigmaG)  ~  d.sigma . lap(G)
/// ```
///
/// so the fringe is the Laplacian of luma times one coefficient per frame. That predicts
/// what is actually seen - the Laplacian of a sigmoid is odd, which is why a fringe reads
/// magenta on one side of an edge and green on the other, and vanishes on the flats.
///
/// Fitted as a least-squares slope, so a frame with no focus difference returns a
/// coefficient of zero rather than needing a threshold to be told to do nothing. A genuine
/// coloured object contributes a *step*, not a curvature, and objects appear at every edge
/// polarity across a frame, so they add variance to this rather than slope - the same
/// argument `tca::estimate` rests on, and the same failure mode: a frame *dominated* by one
/// coloured object can still bias it, which is what the sign agreement below guards.
///
/// None where the frame offers too little curvature to read, or where what it reads is not
/// a focus difference.
pub(crate) fn measure_defocus<T: Sample>(
    frame: &[T],
    width: usize,
    height: usize,
) -> Option<(f32, f32)> {
    if width < 3 || height < 3 {
        return None;
    }
    let luma_at = |x: usize, y: usize| -> f32 { luma_of(&frame[(y * width + x) * 3..]) };
    let (cx, cy) = (width as f64 / 2.0, height as f64 / 2.0);
    let half_squared = cx * cx + cy * cy;

    // Per row, then summed, so the accumulation order does not depend on the core count.
    // Binned by radius, because that is the only thing that separates this defect from a
    // lateral one (see the split below).
    let totals: Bins = (1..height - 1)
        .into_par_iter()
        .step_by(DEFOCUS_STRIDE)
        .map(|y| {
            let mut bins = Bins::default();
            let dy = y as f64 - cy;
            for x in (1..width - 1).step_by(DEFOCUS_STRIDE) {
                let here = luma_at(x, y);
                let curvature =
                    luma_at(x - 1, y) + luma_at(x + 1, y) + luma_at(x, y - 1) + luma_at(x, y + 1)
                        - 4.0 * here;
                let p = &frame[(y * width + x) * 3..];
                // Against luma rather than against green, because these are the planes the
                // correction is applied to (`deinterleave`). Both are linear in `R - G`, so
                // the model holds either way.
                let red = p[0].to_f32() / T::FULL - here;
                let blue = p[2].to_f32() / T::FULL - here;
                let dx = x as f64 - cx;
                // Uniform in r^2, which is both the natural axis for the split below and one
                // multiply cheaper than a radius.
                let radius_squared = (dx * dx + dy * dy) / half_squared;
                let bin = ((radius_squared * DEFOCUS_BINS as f64) as usize).min(DEFOCUS_BINS - 1);
                bins.cross_red[bin] += f64::from(curvature * red);
                bins.cross_blue[bin] += f64::from(curvature * blue);
                bins.square[bin] += f64::from(curvature * curvature);
                bins.counted[bin] += 1;
            }
            bins
        })
        .reduce_parallel(Bins::default, Bins::merge);

    let counted: usize = totals.counted.iter().sum();
    if counted < DEFOCUS_MIN_SAMPLES {
        return None;
    }

    // **The noise's own contribution to both sums, removed.** The regressor and the
    // response are built from the same pixels: the stencil's `-4c` term and the response's
    // `-luma(c)` share a pixel, so their noise is correlated by construction and the slope
    // picks it up. Green's noise enters the regressor with `+0.7152` and the response with
    // `-0.7152`, which is why the residue is *positive for both channels* - it clears the
    // sign veto, which exists to catch things that flip sign, and it is a ratio of
    // variances so it does not shrink as the noise does.
    //
    // For a five-point Laplacian on luma and a response of `R - luma`, per sample:
    //
    //     E[curv.resp_red] = 4.v_luma - 4.w_R.v_R          E[curv^2] = 20.v_luma
    //
    // Both are computable from the per-channel sigmas, so both come off. What is left is
    // the part of the slope the picture put there. Measured on a flat frame with
    // independent per-channel noise this takes the fit from (0.124, 0.175) to nothing.
    let sigmas = channel_sigmas(frame, width, height);
    let variance: [f64; 3] = [sigmas[0] * sigmas[0], sigmas[1] * sigmas[1], sigmas[2] * sigmas[2]];
    let weight = [f64::from(LUMA[0]), f64::from(LUMA[1]), f64::from(LUMA[2])];
    let luma_variance: f64 = (0..3).map(|c| weight[c] * weight[c] * variance[c]).sum();
    let bias = |channel: usize| 4.0 * luma_variance - 4.0 * weight[channel] * variance[channel];

    // **The split that tells this defect from a lateral one.** A channel displaced by `d`
    // expands as `G + d.grad G + (d^2/2).lap G`, and that second term is the very basis
    // this fit regresses on - so a lateral aberration answers it too, positively for both
    // channels whichever way each is displaced, which is exactly what the sign veto cannot
    // catch. What separates them is the radius: `d` grows with `r` for a magnification
    // difference, so its apparent coefficient grows with `r^2`, where a focus difference is
    // flat across the field.
    //
    // So the coefficient is fitted per radial bin and then split into a constant and an
    // `r^2` term, and only the constant is kept. That is the same move `tca::measure` makes
    // in reverse: fit the part you cannot explain so it has somewhere to go, then discard
    // it. Field curvature means a real focus difference is not perfectly flat either, so
    // this gives up a little of it - the conservative direction.
    let mut samples: Vec<(f64, f64, f64, f64)> = Vec::new();
    for bin in 0..DEFOCUS_BINS {
        let count = totals.counted[bin] as f64;
        if totals.counted[bin] < DEFOCUS_MIN_PER_BIN {
            continue;
        }
        let square = totals.square[bin] - count * 20.0 * luma_variance;
        // A bin whose curvature is all noise leaves nothing behind to divide by.
        if square <= 0.0 {
            continue;
        }
        let red = (totals.cross_red[bin] - count * bias(0)) / square;
        let blue = (totals.cross_blue[bin] - count * bias(2)) / square;
        // The bin's own mean r^2, near enough at this width.
        let at = (bin as f64 + 0.5) / DEFOCUS_BINS as f64;
        samples.push((at, red, blue, square));
    }
    if samples.len() < DEFOCUS_MIN_BINS {
        return None;
    }
    // Weighted by each bin's own curvature energy, which is how much it actually knows.
    let constant_term = |pick: &dyn Fn(&(f64, f64, f64, f64)) -> f64| -> f64 {
        let total: f64 = samples.iter().map(|s| s.3).sum();
        let mean_at = samples.iter().map(|s| s.3 * s.0).sum::<f64>() / total;
        let mean_k = samples.iter().map(|s| s.3 * pick(s)).sum::<f64>() / total;
        let covariance: f64 =
            samples.iter().map(|s| s.3 * (s.0 - mean_at) * (pick(s) - mean_k)).sum();
        let spread: f64 = samples.iter().map(|s| s.3 * (s.0 - mean_at).powi(2)).sum();
        let slope = match spread > 0.0 {
            true => covariance / spread,
            false => 0.0,
        };
        mean_k - slope * mean_at
    };
    let red = constant_term(&|s| s.1) as f32;
    let blue = constant_term(&|s| s.2) as f32;
    if red.abs() > DEFOCUS_MAX || blue.abs() > DEFOCUS_MAX {
        return None;
    }
    // **Opposite signs mean the scene's colour, not the lens - but only when both are
    // real.** Green is the channel autofocus works on, so red and blue are both softer
    // than it and both coefficients land on the same side of zero. A frame dominated by
    // one coloured object drives them apart instead, because a red object raises `R - luma`
    // and lowers `B - luma` at the very same curvature.
    //
    // The band is what makes that test usable. Vetoing on the bare product rejected
    // IMG_8408 - a frame carrying 98.48 of fringe - because blue measured +0.148 and red
    // measured -0.0105, a fourteenth of it and indistinguishable from zero. One channel
    // having nothing to say must not silence the other, which is the same lesson
    // `tca::measure` learned about discarding a good channel.
    if red.abs() > DEFOCUS_NOISE && blue.abs() > DEFOCUS_NOISE && red * blue < 0.0 {
        return None;
    }
    // A channel measured *sharper* than green is not something this can fix: subtracting a
    // negative coefficient would sharpen its chroma, inventing an edge rather than removing
    // one. Taken as nothing to do, per channel.
    let (red, blue) = (red.max(0.0), blue.max(0.0));
    // Below the noise band there is nothing worth resampling for, and it is also where the
    // residue of a lateral aberration lands once the r^2 term has been taken out: 0.008 on
    // the fixture that fitted 0.054 before the split, against 0.09 for a real focus
    // difference. A floor here turns "almost nothing" into nothing.
    match red > DEFOCUS_NOISE || blue > DEFOCUS_NOISE {
        true => Some((red, blue)),
        false => None,
    }
}

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
///
/// **What this replaces, and why.** It used to pull colour towards a box mean wherever the
/// luma gradient was steep, which has no model of the defect at all - it asks "is there a
/// hard edge, and is this pixel's colour unlike its neighbours'?", and a thin saturated
/// object answers yes to both. Measured over 214 frames, that cost visible desaturation on
/// costume and studio shoots at full strength while the setting was doing all the work of
/// deciding how far to go, globally, for every frame.
fn defringe(luma: &[f32], red: &mut [f32], blue: &mut [f32], width: usize, height: usize, defocus: (f32, f32)) {
    if width < 3 || height < 3 {
        return;
    }
    let (k_red, k_blue) = defocus;
    let curvature = laplacian(luma, width, height);
    red.par_chunks_mut(width).zip(blue.par_chunks_mut(width)).enumerate().for_each(
        |(y, (red_row, blue_row))| {
            for x in 0..width {
                let at = curvature[y * width + x];
                red_row[x] -= k_red * at;
                blue_row[x] -= k_blue * at;
            }
        },
    );
}

/// How hard each stage works, 0 for a stage that does not run.
///
/// Separate because the two denoises answer to different complaints: grain in luma reads
/// as a photograph and is worth keeping some of, where colour mottle has no such defence
/// and wants all the smoothing it can be given.
///
/// Named rather than four positional `f64`s: the pipeline calls this three times with a
/// different one of them non-zero each time, and `0.0, 0.0, sharpen, 0.0` at a call site
/// says nothing about which stage that is.
#[derive(Clone, Copy, Default, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct Strengths {
    pub luma: f64,
    pub chroma: f64,
    pub sharpen: f64,
    pub defringe: f64,
}

impl Strengths {
    /// What runs on the frame before the camera match is fitted against it.
    ///
    /// Everything but the sharpen, which is a deconvolution of the *resample's* blur and
    /// so has to wait until after the warp that does the resampling (`job::render_base`).
    /// A fit calibrated against a sharpened render is calibrated against a frame that
    /// will not exist by the time the transform is applied.
    pub fn before_the_fit(self) -> Strengths {
        Strengths {
            sharpen: 0.0,
            ..self
        }
    }

    pub fn does_anything(&self) -> bool {
        self.luma > 0.0 || self.chroma > 0.0 || self.sharpen > 0.0 || self.defringe > 0.0
    }

    /// How far past a strip the stages this asks for actually read.
    fn halo(&self) -> usize {
        Radii::for_strength(self.chroma).halo(
            self.luma > 0.0,
            self.chroma > 0.0,
            self.sharpen > 0.0,
            self.defringe > 0.0,
        )
    }
}

/// The chain itself, over one strip's planes. `sigma` is the whole frame's, so every
/// strip denoises by the same amount.
#[allow(clippy::too_many_arguments)]
fn finish_strip(
    luma: &mut Vec<f32>,
    red: &mut Vec<f32>,
    blue: &mut Vec<f32>,
    width: usize,
    height: usize,
    radii: &Radii,
    sigma: f32,
    defocus: (f32, f32),
    strengths: &Strengths,
) {
    // Before the denoises, because its regressor is the curvature of luma and
    // `measure_defocus` fitted the coefficient against the *raw* luma over the whole
    // frame. Correcting against a cleaned one here would apply a coefficient measured in
    // one currency to a curvature denominated in another. The chroma denoise runs after
    // this, which is also where any noise a second difference amplifies gets taken back
    // out.
    if defocus != (0.0, 0.0) {
        defringe(luma, red, blue, width, height, defocus);
    }

    if strengths.luma > 0.0 {
        let eps = (LUMA_DENOISE_SIGMAS * sigma).powi(2);
        let stats = guide_stats(luma, width, height, radii.luma);
        *luma = self_guided(&stats, luma, width, height, radii.luma, eps);
    }

    if strengths.chroma > 0.0 {
        // Guided by the luma - just cleaned, where the luma stage ran at all. With that
        // stage off the guide is the raw luma, which is the guided filter's ordinary
        // case and only costs a noisier edge to follow.
        //
        // Each set of guide statistics in its own scope, because **shadowing does not
        // drop**: two `let stats` in a row keeps both of them - four planes - live to the
        // end of the block, which is the same leak the filter functions above are scoped
        // to avoid. Measured at 15 planes live against 11 scoped.
        {
            let stats = guide_stats(luma, width, height, radii.fine);
            *red = guided(&stats, luma, red, width, height, radii.fine, DENOISE_EPS);
            *blue = guided(&stats, luma, blue, width, height, radii.fine, DENOISE_EPS);
        }

        {
            let stats = guide_stats(luma, width, height, radii.coarse);
            let limit = DENOISE_CHROMA_COARSE_LIMIT * strengths.chroma as f32;
            for channel in [red, blue] {
                let smoothed =
                    guided(&stats, luma, channel, width, height, radii.coarse, DENOISE_EPS);
                channel
                    .par_iter_mut()
                    .zip(smoothed.par_iter())
                    .for_each(|(fine, coarse)| *fine += (coarse - *fine).clamp(-limit, limit));
            }
        }
    }

    if strengths.sharpen > 0.0 {
        let taps = gaussian(DECONVOLVE_SIGMA, DECONVOLVE_RADIUS);
        let sharpened = deconvolve(luma, width, height, &taps, DECONVOLVE_ITERATIONS);
        let amount = (strengths.sharpen as f32).min(1.0);
        luma.par_iter_mut()
            .zip(sharpened.par_iter())
            .for_each(|(l, s)| *l += amount * (s - *l));
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
mod tests {
    use super::*;

    /// Every stage on at once, which is what the strip tests need: the halo is the sum of
    /// what all four reach, so a frame that agrees strip by strip with one stage off says
    /// nothing about the others.
    const EVERY_STAGE: Strengths =
        Strengths { luma: 1.0, chroma: 1.0, sharpen: 0.6, defringe: 0.5 };

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

    /// A reduce has to actually filter, not point-sample: `warp`'s two taps read four of
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
        let source = Rgb { width, height, data };

        let reduced = resize(source.as_ref(), 80, height);
        let midpoint = 120i32;
        let worst = reduced.data.iter().map(|v| (i32::from(*v) - midpoint).abs()).max().unwrap();
        assert!(worst <= 8, "a reduce should average the columns it drops, worst was {worst} off");

        let sampled = warp(source.as_ref(), 80, height, &[], 1.0);
        let aliased = sampled.data.iter().map(|v| (i32::from(*v) - midpoint).abs()).max().unwrap();
        assert!(aliased > 60, "a bilinear gather should alias here, so this pins why it is not used");
    }

    fn ramp(width: usize, height: usize) -> Rgb {
        let mut data = vec![0u8; width * height * 3];
        for (i, byte) in data.iter_mut().enumerate() {
            *byte = (i % 251) as u8;
        }
        Rgb { width, height, data }
    }

    #[test]
    fn an_identity_warp_returns_the_picture() {
        let source = ramp(24, 18);
        let out = warp(source.as_ref(), 24, 18, &[], 1.0);
        // Every pixel, the outermost ring included: it is a sample site like any other.
        for y in 0..18 {
            for x in 0..24 {
                let i = (y * 24 + x) * 3;
                assert_eq!(out.data[i], source.data[i], "pixel {x},{y}");
            }
        }
    }

    #[test]
    fn a_crop_below_one_magnifies() {
        // Sampling inside the frame means the output shows less of the scene, which
        // is what the camera's distortion crop does.
        let source = ramp(64, 64);
        let out = warp(source.as_ref(), 64, 64, &[], 0.5);
        let centre = (32 * 64 + 32) * 3;
        assert_eq!(out.data[centre], source.data[centre], "the centre is a fixed point");
        let edge = (32 * 64 + 60) * 3;
        assert_ne!(out.data[edge], source.data[edge], "but the edges must have moved");
    }

    #[test]
    fn the_box_resize_averages_rather_than_samples() {
        // Two-by-two blocks of a known value: an averaging shrink returns the value,
        // a nearest-neighbour one returns whichever corner it happened to land on.
        let (w, h) = (4usize, 4usize);
        let mut src = vec![0u16; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let block = (y / 2) * 2 + (x / 2);
                let i = (y * w + x) * 3;
                for c in 0..3 {
                    src[i + c] = (1000 * (block + 1)) as u16;
                }
            }
        }
        let out = box_resize_u16(&src, w, h, 2, 2).expect("a downscale");
        assert_eq!(out.len(), 2 * 2 * 3);
        for block in 0..4 {
            assert_eq!(out[block * 3], (1000 * (block + 1)) as u16, "block {block}");
        }
    }

    #[test]
    fn the_box_resize_refuses_to_enlarge() {
        // It exists to avoid work, not to invent detail; the caller keeps the original.
        let src = vec![7u16; 8 * 8 * 3];
        assert!(box_resize_u16(&src, 8, 8, 16, 16).is_none());
        assert!(box_resize_u16(&src, 8, 8, 8, 8).is_none(), "the same size is not a downscale");
        assert!(box_resize_u16(&src, 8, 8, 4, 4).is_some());
    }

    #[test]
    fn the_planar_warp_matches_the_8_bit_one() {
        // Two warps is two places for a sign to be wrong in, so the generic form has
        // to agree with the one the SDR fit uses.
        let source = ramp(32, 24);
        let knots = polynomial_knots(-0.03, 0.0, 16);
        let eight = warp(source.as_ref(), 32, 24, &knots, 0.98);
        let planar: Vec<u8> = warp_planar(
            &source.data,
            32,
            24,
            32,
            24,
            &knots,
            0.98,
            None,
            &registered(),
            Sampling::Bilinear,
            |v| f64::from(v),
            |v: f64| v as u8,
        );
        assert_eq!(eight.data, planar);
    }

    #[test]
    fn a_lateral_scale_moves_one_channel_and_leaves_green_alone() {
        // The correction's whole mechanism: red and blue read at their own radius while
        // green reads at the warp's. Green moving would mean the scales had been applied
        // to the shared ratio rather than per channel.
        let source = ramp(64, 48);
        let flat = |scale: f64| vec![(scale - 1.0) * SPLINE_UNIT; 2];
        let plain: Vec<u8> = warp_planar(
            &source.data, 64, 48, 64, 48, &[], 1.0, None, &registered(),
            Sampling::Bicubic, |v| f64::from(v), |v: f64| v.clamp(0.0, 255.0) as u8,
        );
        let scaled: Vec<u8> = warp_planar(
            &source.data, 64, 48, 64, 48, &[], 1.0, None, &[flat(1.01), Vec::new(), flat(0.99)],
            Sampling::Bicubic, |v| f64::from(v), |v: f64| v.clamp(0.0, 255.0) as u8,
        );
        let channel = |data: &[u8], c: usize| data.iter().skip(c).step_by(3).copied().collect::<Vec<u8>>();
        assert_eq!(channel(&plain, 1), channel(&scaled, 1), "green must not move");
        assert_ne!(channel(&plain, 0), channel(&scaled, 0), "red must move");
        assert_ne!(channel(&plain, 2), channel(&scaled, 2), "blue must move");
    }

    #[test]
    fn a_lateral_scale_moves_each_channel_the_way_it_was_told_to() {
        // **The direction, which "it moved" does not pin.** Inverting the one line that
        // turns a fitted curve into a read radius - `1.0 + spline_at` to `1.0 - spline_at`
        // in `channel_ratio_table` - left the whole suite green, and it would double every
        // fringe the correction exists to remove.
        //
        // A horizontal ramp, so a channel's value says exactly where it was read from: a
        // scale above 1 reads further out, and further out along a rising ramp is brighter.
        let (w, h) = (64usize, 48usize);
        let mut data = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                for c in 0..3 {
                    data[(y * w + x) * 3 + c] = (40 + x * 3) as u8;
                }
            }
        }
        let source = Rgb { width: w, height: h, data };
        let flat = |scale: f64| vec![(scale - 1.0) * SPLINE_UNIT; 2];
        let out: Vec<u8> = warp_planar(
            &source.data, w, h, w, h, &[], 1.0, None,
            &[flat(1.05), Vec::new(), flat(0.95)],
            Sampling::Bilinear, |v| f64::from(v), |v: f64| v.clamp(0.0, 255.0) as u8,
        );
        // Left of centre the ramp rises towards the middle, so reading further out - which
        // is towards the frame edge, away from centre - reads a *darker* sample.
        // Well off centre, so the scale buys more than a rounding step of the ramp.
        let (x, y) = (w / 8, h / 2);
        let at = |c: usize| i32::from(out[(y * w + x) * 3 + c]);
        let green = at(1);
        assert!(at(0) < green, "red scaled >1 must read further out: {} against {green}", at(0));
        assert!(at(2) > green, "blue scaled <1 must read further in: {} against {green}", at(2));
    }

    /// A step edge down the middle, in grey so every channel carries it.
    fn edge<T: Sample>(width: usize, height: usize, low: f32, high: f32) -> Vec<T> {
        let mut frame = vec![T::default(); width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let value = if x < width / 2 { low } else { high };
                for c in 0..3 {
                    frame[(y * width + x) * 3 + c] = T::from_f32(value);
                }
            }
        }
        frame
    }

    /// A step edge blurred by the same point spread the sharpen deconvolves, which is
    /// what a real edge looks like after a resample.
    fn blurred_edge(width: usize, height: usize, low: f32, high: f32) -> Vec<u8> {
        let plane: Vec<f32> = (0..width * height)
            .map(|i| if i % width < width / 2 { low } else { high })
            .collect();
        let blurred = convolve(&plane, width, height, &gaussian(DECONVOLVE_SIGMA, DECONVOLVE_RADIUS));
        let mut frame = vec![0u8; width * height * 3];
        for (i, value) in blurred.iter().enumerate() {
            for c in 0..3 {
                frame[i * 3 + c] = u8::from_f32(*value);
            }
        }
        frame
    }

    #[test]
    fn the_sharpen_steepens_a_blurred_edge_towards_the_step_it_came_from() {
        // The property an unsharp mask cannot claim: this is measured against the *step*
        // the blur was applied to, so "sharper" means closer to the original rather than
        // merely higher contrast across the transition.
        let (w, h) = (64usize, 8usize);
        let (low, high) = (60.0f32, 180.0f32);
        let mut frame = blurred_edge(w, h, low, high);
        let before = frame.clone();
        finish(&mut frame, w, h, Strengths { sharpen: 1.0, ..Default::default() });

        let at = |data: &[u8], x: usize| f32::from(data[(4 * w + x) * 3]);
        let ideal = |x: usize| if x < w / 2 { low } else { high };
        // Every sample across the transition moves towards where the step actually was.
        for x in 30..34 {
            let was = (at(&before, x) - ideal(x)).abs();
            let now = (at(&frame, x) - ideal(x)).abs();
            assert!(now <= was, "column {x}: {was} away, now {now}");
        }
        assert!(at(&frame, 31) < at(&before, 31), "the dark side of the edge");
        assert!(at(&frame, 32) > at(&before, 32), "the light side of the edge");
    }

    #[test]
    fn the_sharpen_does_not_overshoot_the_edge_it_recovers() {
        // What separates deconvolution from a mask. A mask pushes the dark side below
        // where the picture ever went and the light side above it, and that overshoot is
        // the halo. Nothing here may leave the range the original step occupied.
        let (w, h) = (64usize, 8usize);
        let (low, high) = (60.0f32, 180.0f32);
        let mut frame = blurred_edge(w, h, low, high);
        finish(&mut frame, w, h, Strengths { sharpen: 1.0, ..Default::default() });
        for x in 24..40 {
            let value = f32::from(frame[(4 * w + x) * 3]);
            assert!(value >= low - 1.0 && value <= high + 1.0, "column {x} reached {value}");
        }
    }

    #[test]
    fn the_chroma_denoise_is_actually_guided_by_the_luma() {
        // **The claim nothing else here tests.** The two chroma tests above are built so
        // the guide cannot matter - one is constant-luma by construction, the other
        // iso-luminant on purpose to isolate the coarse cap - so both pass with the guide
        // replaced by a constant plane, which degrades the filter to a plain box blur.
        // What the guide is *for* is a colour edge that luma can see, which is the
        // ordinary case: a red wall against a bright roof.
        let (w, h) = (192usize, 32usize);
        let mut frame = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                let (r, g, b) = if x < w / 2 { (170u8, 45, 45) } else { (205, 205, 210) };
                // A little grain, so there is something for the denoise to be doing.
                let n = ((x * 29 + y * 13) % 7) as i32 - 3;
                frame[i] = (i32::from(r) + n).clamp(0, 255) as u8;
                frame[i + 1] = (i32::from(g) + n).clamp(0, 255) as u8;
                frame[i + 2] = (i32::from(b) + n).clamp(0, 255) as u8;
            }
        }
        let before = frame.clone();
        finish(&mut frame, w, h, Strengths { luma: 1.0, chroma: 1.0, ..Default::default() });

        // Red against blue, which is what the wall has and the roof does not. Sampled a
        // few pixels either side of the edge: unguided, the coarse pass pours one into
        // the other and this collapses.
        let spread = |data: &[u8], x: usize| {
            let i = (16 * w + x) * 3;
            i32::from(data[i]) - i32::from(data[i + 2])
        };
        for x in [w / 2 - 6, w / 2 - 2, w / 2 + 2, w / 2 + 6] {
            let (was, now) = (spread(&before, x), spread(&frame, x));
            assert!(
                (now - was).abs() <= 8,
                "column {x}: red-minus-blue went {was} to {now}, so the colour crossed the edge",
            );
        }
    }

    #[test]
    fn the_sharpen_is_the_same_shape_at_both_depths() {
        // One implementation serves the 8-bit renditions and the 16-bit HDR pair, so
        // the same edge has to come out the same picture at either depth. Compared as
        // fractions of full scale, since that is all the two have in common.
        let (w, h) = (32usize, 8usize);
        let mut eight: Vec<u8> = edge(w, h, 60.0, 180.0);
        let mut sixteen: Vec<u16> = edge(w, h, 60.0 * 257.0, 180.0 * 257.0);
        finish(&mut eight, w, h, Strengths { sharpen: 1.0, ..Default::default() });
        finish(&mut sixteen, w, h, Strengths { sharpen: 1.0, ..Default::default() });

        for x in 12..20 {
            let a = f32::from(eight[(4 * w + x) * 3]) / 255.0;
            let b = f32::from(sixteen[(4 * w + x) * 3]) / 65535.0;
            assert!((a - b).abs() < 0.006, "column {x}: {a} against {b}");
        }
    }

    /// Coloured speckle at **constant luma**, which is what sensor chroma noise is once
    /// the demosaic has spread it.
    ///
    /// Built from the colour differences rather than by nudging red and blue directly,
    /// and that distinction is the whole test: nudging them leaves a luma checkerboard
    /// behind, and a denoise guided by luma will correctly refuse to smooth colour that
    /// sits on real luma structure. The first version of this fixture did exactly that
    /// and made a working filter look broken.
    fn speckled(width: usize, height: usize) -> Vec<u8> {
        let mut frame = vec![0u8; width * height * 3];
        for i in 0..width * height {
            // Alternating, not random: randomness has no place in a test, and a
            // checkerboard is the highest frequency there is to remove.
            let swing = if (i + i / width) % 2 == 0 { 18.0f32 } else { -18.0 };
            let luma = 128.0f32;
            let (dr, db) = (swing, -swing);
            let dg = -(LUMA[0] * dr + LUMA[2] * db) / LUMA[1];
            frame[i * 3] = (luma + dr) as u8;
            frame[i * 3 + 1] = (luma + dg) as u8;
            frame[i * 3 + 2] = (luma + db) as u8;
        }
        frame
    }

    #[test]
    fn the_chroma_denoise_takes_the_colour_off_and_leaves_the_brightness() {
        let (w, h) = (32usize, 32usize);
        let mut frame = speckled(w, h);
        let luma_of = |f: &[u8], i: usize| {
            LUMA[0] * f32::from(f[i * 3]) + LUMA[1] * f32::from(f[i * 3 + 1]) + LUMA[2] * f32::from(f[i * 3 + 2])
        };
        let before: Vec<f32> = (0..w * h).map(|i| luma_of(&frame, i)).collect();
        finish(&mut frame, w, h, Strengths { luma: 1.0, chroma: 1.0, ..Default::default() });

        for i in (h / 4 * w)..(h * 3 / 4 * w) {
            // The colour swing is gone - the speckle averages to grey.
            let swing = i32::from(frame[i * 3]) - i32::from(frame[i * 3 + 2]);
            assert!(swing.abs() <= 2, "pixel {i} still swings {swing}");
            // And luma is untouched, which is the property that makes a heavy chroma
            // blur safe at all: detail lives in luma and none of it may move.
            let after = luma_of(&frame, i);
            assert!((after - before[i]).abs() < 1.0, "pixel {i}: {} to {after}", before[i]);
        }
    }

    #[test]
    fn the_chroma_denoise_keeps_a_colour_edge_where_it_is() {
        // A blur crossing a colour edge is the failure mode - measured on a real frame,
        // a red wall pouring onto the grey roof beside it. Well inside either side of the
        // edge the colour has to be the colour it was.
        //
        // **The two colours are chosen to have the same luma**, and that is the whole
        // test. The guide can only hold an edge it can see, so a pair that differs in
        // brightness is held by the guide and proves nothing about the cap; this pair
        // differs by about one part in 255 of luma and by half the chroma range, which is
        // the wall-against-roof case exactly. Remove `DENOISE_CHROMA_COARSE_LIMIT` and
        // this fails; that is what makes it a test of the cap rather than of the guide.
        //
        // Comfortably wider than the coarsest chroma radius, which is the point of the
        // size: a frame narrower than the window is one the filter fits over in its
        // entirety, and a test on that measures nothing about locality.
        let (w, h) = (256usize, 16usize);
        let mut frame = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                let (r, g, b) = if x < w / 2 { (150u8, 60, 60) } else { (60, 71, 200) };
                frame[i] = r;
                frame[i + 1] = g;
                frame[i + 2] = b;
            }
        }
        // The premise, asserted rather than trusted: if a later edit to these two
        // colours reintroduces a luma step, the guide starts doing the work and the
        // assertions below stop meaning anything.
        let luma_at = |x: usize| {
            let i = (8 * w + x) * 3;
            LUMA[0] * f32::from(frame[i]) + LUMA[1] * f32::from(frame[i + 1]) + LUMA[2] * f32::from(frame[i + 2])
        };
        assert!((luma_at(8) - luma_at(248)).abs() < 2.0, "the two colours must be iso-luminant");
        let before = frame.clone();
        finish(&mut frame, w, h, Strengths { luma: 1.0, chroma: 1.0, ..Default::default() });
        let moved = |x: usize| {
            let i = (8 * w + x) * 3;
            (0..3).map(|c| (i32::from(frame[i + c]) - i32::from(before[i + c])).abs()).max().unwrap()
        };

        // Well away from the edge nothing may move at all.
        for x in [8usize, 32, 224, 248] {
            assert!(moved(x) <= 3, "column {x} moved {} far from the edge", moved(x));
        }
        // **Beside it, bounded rather than zero, and that is the actual contract.** The
        // coarse pass fits one linear model across a 65-pixel window, so at an edge it
        // spans both colours and does want to average them - what stops that being a
        // wash of red across the roof is `DENOISE_CHROMA_COARSE_LIMIT`, which caps the
        // move at 2% of full scale however wrong the fit is. Sampling three windows
        // clear, as this once did, tests none of that: it passes over a filter with no
        // cap at all. 8 pixels out is where the cap is doing the work.
        //
        // The boundary pixels themselves are left out on purpose. A window centred on a
        // hard transition spans both colours whatever the filter does with it, so some
        // mixing there is arithmetic rather than a defect - and it is one pixel, where
        // the artefact this guards against was a wash across a whole roof.
        let cap = (DENOISE_CHROMA_COARSE_LIMIT * 255.0).ceil() as i32 + 1;
        for x in [116usize, 120, 136, 140] {
            assert!(moved(x) <= cap, "column {x} moved {} beside the edge", moved(x));
        }
    }

    /// A grainy field with `flat_rows` rows of blown white above it.
    fn grain_under_sky(width: usize, height: usize, flat_rows: usize) -> Vec<u8> {
        let mut frame = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let value = match y < flat_rows {
                    true => 255,
                    // Deterministic, and wide enough to sit well above the histogram's
                    // first bin: this is what the estimator has to find.
                    false => (100 + ((x * 31 + y * 17) % 9) as i32 - 4) as u8,
                };
                for c in 0..3 {
                    frame[(y * width + x) * 3 + c] = value;
                }
            }
        }
        frame
    }

    #[test]
    fn a_flat_majority_does_not_read_as_a_noiseless_frame() {
        // The estimator reads a median residual, and a pixel in a blown sky has a
        // residual of exactly zero. Counted, those pixels put the median at zero the
        // moment they are half the frame - reporting no noise, setting `eps` to zero and
        // turning the luma denoise into an identity. A cliff, not a taper: this is the
        // same grain either side of it, and it has to be denoised the same amount.
        let (w, h) = (128usize, 128usize);
        let denoised_by = |flat_rows: usize| {
            let before = grain_under_sky(w, h, flat_rows);
            let mut after = before.clone();
            finish(&mut after, w, h, Strengths { luma: 1.0, chroma: 1.0, ..Default::default() });
            let grain = (flat_rows * w * 3)..(w * h * 3);
            let moved: u32 = grain
                .clone()
                .map(|i| u32::from(before[i].abs_diff(after[i])))
                .sum();
            moved as f32 / grain.len() as f32
        };

        let little_sky = denoised_by(w * 30 / 100);
        let much_sky = denoised_by(w * 60 / 100);
        assert!(little_sky > 0.5, "the grain was not denoised at all: {little_sky}");
        assert!(
            (much_sky - little_sky).abs() < 0.35 * little_sky,
            "same grain, {little_sky} denoised under a small sky and {much_sky} under a large one",
        );
    }

    #[test]
    fn a_frame_that_is_mostly_detail_does_not_have_it_read_as_noise() {
        // The opposite end. Close stripes over a whole frame give a large median
        // residual that is signal, and without a ceiling on the estimate the filter
        // believes it and smooths luma to its local mean - taking the stripes with it.
        let (w, h) = (128usize, 128usize);
        let mut frame = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let value = if (x / 3) % 2 == 0 { 90u8 } else { 170 };
                for c in 0..3 {
                    frame[(y * w + x) * 3 + c] = value;
                }
            }
        }
        let before = frame.clone();
        finish(&mut frame, w, h, Strengths { luma: 1.0, chroma: 1.0, ..Default::default() });

        let span = |data: &[u8]| {
            let row = (h / 2) * w;
            let (mut low, mut high) = (255u8, 0u8);
            for x in 0..w {
                low = low.min(data[(row + x) * 3]);
                high = high.max(data[(row + x) * 3]);
            }
            u32::from(high - low)
        };
        let (was, now) = (span(&before), span(&frame));
        assert!(now * 2 > was, "stripe contrast fell from {was} to {now}");
    }

    /// A frame with something at every scale the chain looks at: fine grain, mid-scale
    /// texture, a hard edge, and - the part that matters most - **large, low-frequency
    /// colour blotches**.
    ///
    /// The blotches are what make this frame able to detect a short halo at all. The
    /// halo is dominated by the coarse chroma pass, radius 32, and a frame whose colour
    /// varies by a few counts gives that pass nothing to move: the seam test passed with
    /// the halo cut by 89% until this fixture carried chroma at the scale and amplitude
    /// the pass is built for.
    fn busy(width: usize, height: usize) -> Vec<u8> {
        let mut frame = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                let block = if (x / 24 + y / 24) % 2 == 0 { 40i32 } else { 0 };
                let edge = if x > width / 2 { 60 } else { 0 };
                let grain = ((x * 31 + y * 17) % 11) as i32 - 5;
                let base = 90 + block + edge + grain;
                // Colour that varies slowly and widely, which is what the coarse pass is
                // for and what a short halo therefore gets wrong.
                let blotch = |period: usize, phase: usize| {
                    (((x + phase) / period + (y + phase) / period) % 3) as i32 * 30 - 30
                };
                frame[i] = (base + blotch(70, 0)).clamp(0, 255) as u8;
                frame[i + 1] = (base + ((x * 13 + y * 7) % 7) as i32 - 3).clamp(0, 255) as u8;
                frame[i + 2] = (base + blotch(90, 35)).clamp(0, 255) as u8;
            }
        }
        frame
    }

    /// Whether moving one pixel `distance` rows down changes the frame's top row.
    ///
    /// A direct measurement of the dependency `Radii::halo` is a prediction of, which is
    /// the only way to check that prediction without restating the formula.
    fn reaches_top(luma: f64, chroma: f64, sharpen: f64, distance: usize) -> bool {
        let (width, height) = (120usize, 400usize);
        let source = busy(width, height);
        let mut baseline = source.clone();
        finish(&mut baseline, width, height, Strengths { luma, chroma, sharpen, ..Default::default() });

        let mut probed = source;
        // Large and coloured, so what is measured is whether the dependency exists at
        // all rather than whether it survives a clamp.
        let i = (distance * width + width / 2) * 3;
        probed[i] = 255;
        probed[i + 1] = 0;
        probed[i + 2] = 255;
        finish(&mut probed, width, height, Strengths { luma, chroma, sharpen, ..Default::default() });
        baseline[..width * 3] != probed[..width * 3]
    }

    #[test]
    fn the_halo_covers_how_far_the_filters_actually_reach() {
        // The strip driver is correct exactly when `Radii::halo` is at least the chain's
        // true reach, and *nothing else here checks that number*. The seam test below
        // compares outputs, and the coarse chroma pass's 2% cap keeps those differences
        // small enough that it tolerated the halo being cut by three quarters. This
        // measures the dependency instead, so a halo short by any amount fails.
        // Includes each denoise without the other, those being the combinations the
        // shared `denoise` bool could not have distinguished.
        let cases =
            [(1.0, 1.0, 0.6), (1.0, 1.0, 0.0), (0.0, 0.0, 0.6), (3.0, 3.0, 1.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 1.0, 0.6)];
        for (luma, chroma, sharpen) in cases {
            let halo = Radii::for_strength(chroma).halo(luma > 0.0, chroma > 0.0, sharpen > 0.0, false);
            assert!(
                !reaches_top(luma, chroma, sharpen, halo + 1),
                "luma {luma} chroma {chroma} sharpen {sharpen}: a change {} rows down reached the top, past a halo of {halo}",
                halo + 1,
            );
            // And the probe can see anything at all, so the assertion above is not
            // passing because a moved pixel never changes the output. Close in, because
            // influence *attenuates* long before it stops: a pixel 10 rows away is
            // already inside the deconvolution's formal reach and still cannot shift the
            // top row by a whole count. The halo has to cover where the dependency ends,
            // not where it stops being visible.
            assert!(
                reaches_top(luma, chroma, sharpen, 2),
                "luma {luma} chroma {chroma} sharpen {sharpen}: the probe detects nothing two rows down",
            );
        }
    }

    #[test]
    fn a_strip_thinner_than_its_halo_is_widened_rather_than_believed() {
        // `carry` only holds the last `halo` rows, so a strip thinner than that needs
        // context from rows an *earlier* strip already wrote over - and would silently be
        // handed its neighbour's output as input. Measured before the clamp went in:
        // rows wrong by 257 counts against a whole-frame run, with no panic and no seam
        // large enough for the tolerance below to notice.
        //
        // The clamp lives in `finish_in_strips` rather than only in `strip_interior`
        // because the two are separated by a call, and an invariant that holds only
        // because of what some other function chose is one edit from not holding.
        let (width, height) = (120usize, 400usize);
        let source = busy(width, height);
        let run = |interior: usize| {
            let mut frame = source.clone();
            finish_in_strips(&mut frame, width, height, EVERY_STAGE, interior);
            frame
        };
        // Compared against the halo they are widened *to*, which makes this exact: every
        // one of them lays the strips out identically, so any difference at all is the
        // clamp having failed rather than the band-order rounding the seam test allows.
        let halo = Radii::for_strength(1.0).halo(true, true, true, true);
        let widened = run(halo);
        for interior in [1usize, 7, 40, halo - 1] {
            assert_eq!(run(interior), widened, "an interior of {interior} was believed");
        }
    }

    #[test]
    fn strips_produce_what_a_whole_frame_would_have() {
        // The whole point of the halo. Every stage is local with a bounded reach, so a
        // strip that carries enough context has to land on exactly what a single pass
        // over the frame would have written - and if the reach is underestimated by even
        // a row, the error shows up as a horizontal seam at every strip boundary, which
        // is both obvious on a photograph and invisible to every other test here.
        //
        // The *same* frame both ways, which is why the strip height is a parameter: a
        // shorter frame would measure its own noise differently and the two runs would
        // diverge for a reason that has nothing to do with the halo.
        let (width, height, interior) = (200usize, 500usize, 100usize);
        let source = busy(width, height);

        let run = |rows: usize| {
            let mut frame = source.clone();
            finish_in_strips(&mut frame, width, height, EVERY_STAGE, rows);
            frame
        };
        let whole = run(height);
        let striped = run(interior);

        let halo = Radii::for_strength(1.0).halo(true, true, true, true);
        assert!(halo > 0 && halo < interior, "the strips must be taller than the halo: {halo}");

        // **Within a count, not bit-for-bit.** The box mean is a running sum, so a plane
        // of a different height splits into different bands and accumulates in a
        // different order; in f32 that moves the last bit, and a sample on a rounding
        // boundary lands one count either way.
        //
        // This is a seam check and **not** the halo's guard - measured, it still passes
        // with the halo cut to a sixth, because the coarse chroma pass is capped at 2% of
        // full scale and so cannot produce a large error however wrong its context is.
        // `the_halo_covers_how_far_the_filters_actually_reach` is what pins the halo, by
        // measuring the dependency rather than the difference it makes.
        let mut worst = 0u8;
        let mut worst_row = 0usize;
        for row in 0..height {
            let mut row_error = 0u32;
            for i in (row * width * 3)..((row + 1) * width * 3) {
                let difference = whole[i].abs_diff(striped[i]);
                worst = worst.max(difference);
                row_error += u32::from(difference);
            }
            // No row may be systematically wrong, which is what a seam is: a boundary row
            // under a short halo differs on most of its samples, not on a stray few.
            assert!(
                row_error < (width * 3) as u32 / 4,
                "row {row} differs by {row_error} across {} samples - a seam, not rounding",
                width * 3,
            );
            if row_error > 0 {
                worst_row = worst_row.max(row);
            }
        }
        assert!(worst <= 1, "a sample differs by {worst} counts, at row {worst_row}");
    }

    #[test]
    fn a_frame_with_no_noise_at_all_survives_being_denoised() {
        // The luma denoise takes its regularisation from the frame's own measured noise,
        // and **a uniform frame measures exactly zero** - which meets a flat window's zero
        // variance as 0/0 and, without the guard in `guided_with`, turns the whole picture
        // into NaN, landing as an all-black frame once clamped back to eight bits.
        //
        // Uniform on purpose. This was a step edge first, on the reasoning that it was
        // synthetic enough - and it is not: the step's own columns dominate the histogram,
        // so it measures sigma at the *ceiling* rather than at zero and never reaches the
        // branch it was written for. The guard could be deleted and it passed.
        let (w, h) = (24usize, 24usize);
        let mut frame = vec![130u8; w * h * 3];
        let before = frame.clone();
        finish(&mut frame, w, h, Strengths { luma: 1.0, chroma: 1.0, sharpen: 1.0, ..Default::default() });
        assert_eq!(frame, before, "a uniform frame came back changed");
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
    fn defocus_channels(frame: &[u8], width: usize, height: usize, channels: &[usize], softness: f32) -> Vec<u8> {
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

    /// The worst departure of red or blue from green anywhere in the frame - the fringe.
    fn worst_fringe(frame: &[u8], width: usize, height: usize) -> f32 {
        let mut worst = 0.0f32;
        for i in 0..width * height {
            let green = f32::from(frame[i * 3 + 1]);
            worst = worst
                .max((f32::from(frame[i * 3]) - green).abs())
                .max((f32::from(frame[i * 3 + 2]) - green).abs());
        }
        worst
    }

    #[test]
    fn the_defringe_removes_a_focus_difference_it_measured() {
        let (w, h) = (400usize, 300usize);
        let mut frame = defocus_channels(&bars(w, h), w, h, &[0, 2], 0.2);
        let before = worst_fringe(&frame, w, h);
        finish(&mut frame, w, h, Strengths { defringe: 1.0, ..Default::default() });
        let after = worst_fringe(&frame, w, h);
        assert!(before > 25.0, "the fixture must carry a fringe, got {before}");
        assert!(after < before * 0.4, "the fringe went {before} to {after}");
    }

    #[test]
    fn a_frame_with_no_focus_difference_is_left_alone() {
        // The coefficient is a measurement, so on a *noiseless* frame with the channels in
        // focus it measures nothing and nothing moves, with no threshold to tell it so.
        // On a noisy one it does not - see the reproduction below.
        let (w, h) = (400usize, 300usize);
        let mut frame = bars(w, h);
        let before = frame.clone();
        finish(&mut frame, w, h, Strengths { defringe: 1.0, ..Default::default() });
        assert_eq!(frame, before, "a registered frame was corrected anyway");
    }

    /// **Noise alone must measure nothing, and it used to measure a great deal.**
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
    #[test]
    fn independent_channel_noise_alone_is_not_a_focus_difference() {
        let (w, h) = (400usize, 300usize);
        let noise = |seed: u64, base: &[u8]| {
            let mut out = base.to_vec();
            let mut state = seed;
            for slot in out.iter_mut() {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let grain = ((state >> 33) % 5) as i32 - 2;
                *slot = (i32::from(*slot) + grain).clamp(0, 255) as u8;
            }
            out
        };

        let flat = noise(0x9E37_79B9_7F4A_7C15, &vec![128u8; w * h * 3]);
        assert_eq!(measure_defocus(&flat, w, h), None, "noise alone is not a focus difference");

        // And the correction it does measure has to be the same with the noise as without,
        // or the subtraction has merely moved the bias rather than removed it.
        let clean = defocus_channels(&bars(w, h), w, h, &[0, 2], 0.12);
        let grainy = noise(0x2545_F491_4F6C_DD1D, &clean);
        let (clean_red, clean_blue) = measure_defocus(&clean, w, h).expect("a coefficient");
        let (noisy_red, noisy_blue) = measure_defocus(&grainy, w, h).expect("a coefficient");
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
        let (w, h) = (400usize, 300usize);
        let lateral = scale_channel(&scale_channel(&bars(w, h), 0, 1.0015), 2, 0.9985);
        assert_eq!(
            measure_defocus(&lateral, w, h),
            None,
            "a magnification difference is not a focus difference",
        );
    }

    #[test]
    fn a_focus_difference_survives_a_lateral_one_on_top_of_it() {
        // The split must not simply reject everything radial: a real focus difference sits
        // in the constant term and has to come through a frame carrying both.
        let (w, h) = (400usize, 300usize);
        let defocus = defocus_channels(&bars(w, h), w, h, &[0, 2], 0.12);
        let (clean_red, _) = measure_defocus(&defocus, w, h).expect("a coefficient");
        let both = scale_channel(&scale_channel(&defocus, 0, 1.0015), 2, 0.9985);
        let (mixed_red, mixed_blue) = measure_defocus(&both, w, h).expect("a coefficient");
        assert!(
            mixed_red > clean_red * 0.7 && mixed_red < clean_red * 1.3,
            "the focus difference should survive the lateral one: {mixed_red} against {clean_red}",
        );
        assert!(mixed_blue > DEFOCUS_NOISE, "blue too: {mixed_blue}");
    }

    #[test]
    fn a_saturated_object_is_not_desaturated() {
        // The failure that kept this stage off by default: a thin saturated object at a
        // hard edge answered the old mask's two questions exactly as a fringe does. It
        // carries no curvature-shaped colour, so the regression finds nothing in it.
        let (w, h) = (400usize, 300usize);
        let mut frame = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                let (r, g, b) = if (x / 4) % 2 == 0 { (220u8, 60, 60) } else { (30, 30, 120) };
                frame[i] = r;
                frame[i + 1] = g;
                frame[i + 2] = b;
            }
        }
        let before = frame.clone();
        finish(&mut frame, w, h, Strengths { defringe: 1.0, ..Default::default() });
        for i in 0..w * h {
            let was = i32::from(before[i * 3]) - i32::from(before[i * 3 + 2]);
            let now = i32::from(frame[i * 3]) - i32::from(frame[i * 3 + 2]);
            assert!(
                (now - was).abs() <= 6,
                "pixel {i}: red-minus-blue went {was} to {now} on a real coloured edge",
            );
        }
    }

    #[test]
    fn the_estimate_recovers_the_softness_that_was_injected() {
        // Straight at the estimator, because the round trip above would also pass on a
        // coefficient that is merely the right sign.
        let (w, h) = (400usize, 300usize);
        for injected in [0.06f32, 0.12] {
            let frame = defocus_channels(&bars(w, h), w, h, &[0, 2], injected);
            let (red, blue) = measure_defocus(&frame, w, h).expect("a coefficient");
            for (name, found) in [("red", red), ("blue", blue)] {
                assert!(
                    (found - injected).abs() < injected * 0.35,
                    "{name}: injected {injected}, measured {found}",
                );
            }
        }
    }

    /// Where the time in `finish` actually goes, at the size a full rendition is encoded
    /// at. Ignored by default - it is a measurement, not an assertion.
    ///
    /// Here rather than in a whole-job bench because a whole job on this machine cannot
    /// resolve it: the run-to-run spread of one 24MP render is ~0.9s of CPU, which is wider
    /// than every difference on this branch put together, and the arms came out ordered
    /// impossibly (the defringe *on* nominally cheaper than off).
    #[test]
    #[ignore]
    fn scratch_stage_costs() {
        let (w, h) = (3840usize, 2560usize);
        let frame = busy(w, h);
        let time = |label: &str, runs: usize, mut f: Box<dyn FnMut()>| {
            let start = std::time::Instant::now();
            for _ in 0..runs {
                f();
            }
            println!("{label:<22} {:>8.1}ms", start.elapsed().as_secs_f64() * 1000.0 / runs as f64);
        };

        time("measure_defocus", 5, {
            let frame = frame.clone();
            Box::new(move || {
                std::hint::black_box(measure_defocus(&frame, w, h));
            })
        });

        let (luma, red, blue) = deinterleave(&frame, &[], w, 0, 0, h);
        time("laplacian", 5, {
            let luma = luma.clone();
            Box::new(move || {
                std::hint::black_box(laplacian(&luma, w, h));
            })
        });
        time("defringe (whole)", 5, {
            let (luma, mut red, mut blue) = (luma.clone(), red.clone(), blue.clone());
            Box::new(move || {
                defringe(&luma, &mut red, &mut blue, w, h, (0.1, 0.1));
            })
        });

        for (label, strengths) in [
            ("finish: defringe", Strengths { defringe: 1.0, ..Default::default() }),
            ("finish: luma", Strengths { luma: 1.0, ..Default::default() }),
            ("finish: chroma", Strengths { chroma: 1.0, ..Default::default() }),
            ("finish: sharpen", Strengths { sharpen: 0.6, ..Default::default() }),
            (
                "finish: all four",
                Strengths { luma: 1.0, chroma: 1.0, sharpen: 0.6, defringe: 1.0 },
            ),
        ] {
            time(label, 3, {
                let frame = frame.clone();
                Box::new(move || {
                    let mut copy = frame.clone();
                    finish(&mut copy, w, h, strengths);
                })
            });
        }
    }

    /// What a wider strip buys and what it costs, at one size and one scratch budget per
    /// process. Ignored by default.
    ///
    /// One configuration per process on purpose: `VmHWM` is a high-water mark, so two
    /// budgets measured in one process would both report the larger. `finish_in_strips`
    /// already takes the interior as a parameter - it exists so a test can drive it - so
    /// nothing in the shipped path has to move to measure this.
    ///
    /// `BB_WIDTH`, `BB_HEIGHT`, `BB_BUDGET_MB`.
    #[test]
    #[ignore]
    fn scratch_strip_budget() {
        let read = |name: &str, fallback: usize| {
            std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(fallback)
        };
        let (w, h) = (read("BB_WIDTH", 3840), read("BB_HEIGHT", 2560));
        let budget = read("BB_BUDGET_MB", 64) * 1024 * 1024;
        let strengths = Strengths { luma: 1.0, chroma: 1.0, sharpen: 0.6, defringe: 1.0 };

        // What `strip_interior` would decide, with the budget as a variable.
        let halo = strengths.halo();
        let rows = budget / (w.max(1) * 12 * std::mem::size_of::<f32>());
        let interior = rows.saturating_sub(2 * halo).max(halo).max(32);

        let mut frame = busy(w, h);
        let start = std::time::Instant::now();
        finish_in_strips(&mut frame, w, h, strengths, interior);
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;

        let peak = std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|s| {
                s.lines().find(|l| l.starts_with("VmHWM:")).map(|l| {
                    l.split_whitespace().nth(1).unwrap_or("0").parse::<f64>().unwrap_or(0.0)
                })
            })
            .unwrap_or(0.0);
        let strips = h.div_ceil(interior.max(1));
        let processed = strips * (interior + 2 * halo);
        println!(
            "{w}x{h} budget={}MB halo={halo} interior={interior} strips={strips} \
             rows={processed}/{h} ({:.2}x) {elapsed:.0}ms peakRss={:.0}MB",
            budget / (1024 * 1024),
            processed as f64 / h as f64,
            peak / 1024.0,
        );
    }

    #[test]
    fn one_channel_measuring_nothing_does_not_veto_the_other() {
        // **The case that shipped broken.** IMG_8408 - the frame this project cites as its
        // worst, at 98.48 of fringe - measures blue at +0.148 and red at -0.011, and a bare
        // product veto read that -0.011 as a disagreement and threw the whole frame away.
        // A channel with nothing to say must not silence one that has.
        let (w, h) = (400usize, 300usize);
        let frame = defocus_channels(&bars(w, h), w, h, &[2], 0.15);
        let (red, blue) = measure_defocus(&frame, w, h).expect("blue alone is still a fringe");
        assert!(blue > 0.1, "blue measured {blue}");
        assert_eq!(red, 0.0, "red had nothing to correct and must be left at zero");
    }

    #[test]
    fn a_channel_measured_sharper_than_green_is_not_sharpened() {
        // Subtracting a negative coefficient would add curvature to that channel's chroma,
        // inventing an edge rather than removing one.
        let (w, h) = (400usize, 300usize);
        let frame = defocus_channels(&bars(w, h), w, h, &[0], -0.15);
        match measure_defocus(&frame, w, h) {
            None => {}
            Some((red, blue)) => {
                assert_eq!((red, blue), (0.0, 0.0), "a sharper channel asked for a correction");
            }
        }
    }

    #[test]
    fn a_channel_softer_and_a_channel_sharper_is_declined() {
        // Autofocus works on luma, so green is the focused channel and red and blue are
        // both softer than it. Coefficients on opposite sides of zero are the scene's
        // colour being read as a lens fault, which is the way this regression fails.
        let (w, h) = (400usize, 300usize);
        let softened = defocus_channels(&bars(w, h), w, h, &[0], 0.12);
        let frame = defocus_channels(&softened, w, h, &[2], -0.12);
        assert!(measure_defocus(&frame, w, h).is_none());
    }

    #[test]
    fn the_defringe_leaves_a_flat_colour_alone() {
        // The failure mode worth guarding: a red wall is a colour, not an aberration, and
        // a defringe that keys on colour rather than on edges greys it out.
        // **Grained, and that is what makes this a test.** On a *noiseless* flat colour the
        // surrounding mean equals the pixel, so the correction is identically zero however
        // the edge mask behaves - it passed with the mask deleted entirely, which is the
        // one fault it is named for. Grain gives the mask something to fire on, and
        // `DEFRINGE_EDGE` reads an absolute gradient off luma that nothing has denoised
        // yet, so this is also the frame the documented "acts as a chroma suppressor on a
        // noisy frame" fault would show up on.
        let (w, h) = (64usize, 64usize);
        let mut frame = vec![0u8; w * h * 3];
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        for i in 0..w * h {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let grain = ((state >> 33) % 9) as i32 - 4;
            frame[i * 3] = (200 + grain).clamp(0, 255) as u8;
            frame[i * 3 + 1] = (60 + grain).clamp(0, 255) as u8;
            frame[i * 3 + 2] = (60 + grain).clamp(0, 255) as u8;
        }
        let before = frame.clone();
        finish(&mut frame, w, h, Strengths { defringe: 1.0, ..Default::default() });
        // The colour has to survive: red against green is ~140 everywhere and must stay
        // there, whatever the grain does to the mask.
        for i in 0..w * h {
            let was = i32::from(before[i * 3]) - i32::from(before[i * 3 + 1]);
            let now = i32::from(frame[i * 3]) - i32::from(frame[i * 3 + 1]);
            assert!(
                (now - was).abs() <= 12,
                "pixel {i}: red-minus-green went {was} to {now} on a flat colour",
            );
        }
    }

    #[test]
    fn the_defringe_reaches_a_fringe_in_sixteen_bit_samples() {
        // The HDR path hands `finish` PQ-coded `u16`, and the estimate's thresholds are
        // written against a normalised scale rather than against 8-bit codes - so a stage
        // that is right at 8 bits and dead at 16 would ship unnoticed. This is the only
        // test that runs it in the width that path uses.
        let (w, h) = (400usize, 300usize);
        let eight = defocus_channels(&bars(w, h), w, h, &[0, 2], 0.2);
        let mut frame: Vec<u16> = eight.iter().map(|&b| u16::from(b) * 257).collect();
        let worst = |data: &[u16]| {
            let mut worst = 0.0f32;
            for i in 0..w * h {
                let green = f32::from(data[i * 3 + 1]);
                worst = worst
                    .max((f32::from(data[i * 3]) - green).abs())
                    .max((f32::from(data[i * 3 + 2]) - green).abs());
            }
            worst
        };
        let before = worst(&frame);
        finish(&mut frame, w, h, Strengths { defringe: 1.0, ..Default::default() });
        let after = worst(&frame);
        assert!(before > 25.0 * 257.0, "the fixture must carry a fringe, got {before}");
        assert!(after < before * 0.4, "the fringe went {before} to {after}");
    }

    #[test]
    fn every_setting_off_is_not_an_almost_identity() {
        // Off is a common setting, and it has to mean the frame is not walked at all
        // rather than walked, deinterleaved, recombined and rounded back.
        let (w, h) = (16usize, 16usize);
        let mut frame: Vec<u16> = edge(w, h, 1000.0, 40000.0);
        let before = frame.clone();
        finish(&mut frame, w, h, Strengths::default());
        assert_eq!(frame, before);
    }

    #[test]
    fn the_cubic_keeps_detail_at_the_edge_that_the_bilinear_loses() {
        // The complaint this answers: a corrected render soft at the edges against a
        // camera JPEG sharp there. The warp holds the centre fixed, so displacement -
        // and with it bilinear's two-tap blur - grows with radius. Measured as the
        // contrast surviving in a fine pattern, in the outer eighth of the frame.
        let (width, height) = (256usize, 192usize);
        let mut data = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let value = if (x + y) % 2 == 0 { 220 } else { 40 };
                for c in 0..3 {
                    data[(y * width + x) * 3 + c] = value;
                }
            }
        }
        let source = Rgb { width, height, data };
        let knots = polynomial_knots(0.03, 0.0, 16);
        let crop = fill_crop(&knots, width, height);

        let contrast = |sampling: Sampling| {
            let out: Vec<u8> = warp_planar(
                &source.data,
                width,
                height,
                width,
                height,
                &knots,
                crop,
                None,
                &registered(),
                sampling,
                |v| f64::from(v),
                |v: f64| v.clamp(0.0, 255.0) as u8,
            );
            let mut total = 0u64;
            for y in 1..height - 1 {
                for x in 1..width - 1 {
                    if x > width / 8 && x < width * 7 / 8 && y > height / 8 && y < height * 7 / 8 {
                        continue;
                    }
                    let i = (y * width + x) * 3;
                    total += out[i].abs_diff(out[i + 3]) as u64;
                }
            }
            total
        };

        let (bilinear, bicubic) = (contrast(Sampling::Bilinear), contrast(Sampling::Bicubic));
        assert!(bicubic > bilinear * 5 / 4, "bicubic {bicubic} against bilinear {bilinear}");
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
        assert_eq!(fill_crop(&polynomial_knots(-0.03, 0.0, 16), 6000, 4000), 1.0);
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
        assert!(crop < 0.93, "the far radii alone would have left this at 1.0, got {crop}");
        // Exact, not approximate: the peak is at a knot, and the grid lands on knots.
        let reach = crop * sample_radius(&knots, 7.0 / 15.0, 1.0);
        assert!(reach <= short_edge + 1e-9, "the bulge reaches {reach}, past {short_edge}");
    }

    #[test]
    fn a_pincushion_correction_at_its_fill_crop_leaves_no_black() {
        // The bug this guards: a lensfun profile with a +1.7% corner was applied at a
        // crop that did not fill, and the corners showed the black the warp sampled from
        // outside the frame.
        let (width, height) = (120usize, 80usize);
        let mut source = ramp(width, height);
        // A ramp passes through zero, and a black source pixel is not a black margin.
        for byte in &mut source.data {
            *byte = (*byte).max(1);
        }
        let knots = polynomial_knots(0.0173, 0.0, 16);
        let crop = fill_crop(&knots, width, height);
        let out = warp(source.as_ref(), width, height, &knots, crop);
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                assert_ne!((out.data[i], out.data[i + 1], out.data[i + 2]), (0, 0, 0), "pixel {x},{y}");
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
