//! A lens as the warp undoes it: the radial curve, the rescale, the falloff and the lateral
//! correction, and the ratio tables a gather reads them through.

pub const SPLINE_UNIT: f64 = 16384.0;

/// Entries in the lookup the warp indexes by r^2. Radii are normalised to the
/// half-diagonal, so r^2 runs exactly 0..1 over the frame and the table needs no
/// range beyond that. 4096 puts a 16-knot spline's kinks several buckets apart,
/// well below the bilinear sampling that follows.
pub const RATIO_TABLE_LAST: usize = 4096;

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
pub fn ratio_table(knots: &[f64], crop: f64) -> Vec<f64> {
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
pub fn ratio_tables(knots: &[f64], crop: f64, channels: &Channels) -> [Vec<f64>; 3] {
    std::array::from_fn(|c| channel_ratio_table(knots, &channels[c], crop))
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

/// What the lens did to the frame, as this fit resolved it: the halves that depend on
/// where a pixel sits rather than what colour it is.
///
/// One struct because §10.8.1 lifts all of it into the HDR grade together and nothing
/// may lift a subset. Passed as three loose arguments first, and `fit_all` promptly
/// forgot the falloff on one of the two routes with every test still green.
#[derive(Clone, PartialEq)]
pub struct Lens {
    /// Radial knots in `SPLINE_UNIT`s, or None where no correction is needed.
    pub distortion: Option<Vec<f64>>,
    /// Overall rescale accompanying the distortion.
    pub crop: f64,
    /// The falloff's two coefficients, in the currency [`falloff`] reads.
    pub falloff: Option<(f64, f64)>,
    /// Red and blue's radial correction against green, where the lens imaged them at
    /// different magnifications (`tca.rs`). Knots rather than a scalar because a
    /// database curve is radius-dependent and a measured scale is the flat case of one.
    pub tca: Option<[Vec<f64>; 2]>,
    /// The optical axis the distortion and crop are radial about, as an offset from the frame's
    /// centre in half-diagonals of the upright frame. Zero for every fitted lens; a DNG's
    /// WarpRectilinear states its own.
    pub axis: [f64; 2],
}

impl Lens {
    /// A lens that did nothing, for a caller with no fit to hand.
    pub fn none() -> Self {
        Lens {
            distortion: None,
            crop: 1.0,
            falloff: None,
            tca: None,
            axis: [0.0; 2],
        }
    }

    /// Where a point of the corrected picture is read from, both as offsets from the frame's
    /// centre in half-diagonals, given this lens's ratio at a squared radius about its axis in
    /// [`reach`]es.
    pub fn read_from(&self, at: (f64, f64), ratio: impl Fn(f64) -> f64) -> (f64, f64) {
        let (dx, dy) = (at.0 - self.axis[0], at.1 - self.axis[1]);
        let ratio = ratio((dx * dx + dy * dy) / self.reach().powi(2));
        (self.axis[0] + dx * ratio, self.axis[1] + dy * ratio)
    }

    pub fn reach(&self) -> f64 {
        reach(self.axis)
    }

    /// The radius each channel is read at, relative to green's.
    ///
    /// The warp folds these into its own ratio, so the lateral aberration is undone by
    /// the resample that undoes the distortion rather than by a pass of its own.
    pub fn channels(&self) -> Channels {
        match &self.tca {
            Some([red, blue]) => [red.clone(), Vec::new(), blue.clone()],
            None => registered(),
        }
    }

    /// Whether applying this would change any pixel.
    ///
    /// The crop counts. It is a geometry on its own - a rescale - so a lens with no
    /// curve beside it is not an identity, and reading only `distortion` drops the
    /// scale a fit measured for a frame whose curve it declined.
    pub fn is_identity(&self) -> bool {
        !moves_pixels(self.distortion.as_deref(), self.crop)
            && self.falloff.is_none()
            && !self.corrects_channels()
    }

    /// Whether any channel is read at its own radius.
    pub fn corrects_channels(&self) -> bool {
        !is_registered(&self.channels())
    }
}

/// The radius a lens's knots end at about `axis`, in half-diagonals: no corner of the frame is
/// further from it, so the tables never read past their last entry.
pub fn reach(axis: [f64; 2]) -> f64 {
    1.0 + axis[0].hypot(axis[1])
}

/// A radial brightness gain at a quantised radius, in linear light: `1 + a r^2 + b r^4`, the shape
/// falloff actually has.
///
/// Bounded because these are two free parameters fitted to one frame, and a degenerate solve
/// should distort the corners rather than black them out or blow them away: no lens falls off by
/// four stops, and none gains.
#[inline]
pub fn falloff(a: f64, b: f64, radius: u8) -> f64 {
    let r2 = (f64::from(radius) / 255.0).powi(2);
    (1.0 + a * r2 + b * r2 * r2).clamp(0.25, 4.0)
}

#[cfg(test)]
mod tests {
    use super::*;

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
