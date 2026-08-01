// Lateral chromatic aberration: the lens imaging red and blue at slightly different
// magnifications, so a point of light lands at a different radius in each channel.
//
// Zero at the centre by construction and growing with radius, which is what separates
// it from every other colour error in the pipeline. On a 16mm f/2.8 frame it measures
// ~5px at the corner, where it reads as magenta on the outward side of a highlight and
// green on the inward side. Canon removes it in the JPEG; LibRaw's render carries it.
//
// The model is one scale per channel against green, which is all a rectilinear lens's
// lateral aberration is. It composes with the distortion warp rather than needing a
// pass of its own: both are radial maps about the frame centre, so the warp multiplies
// its ratio by this channel's scale and resamples once (`image::warp_planar`).
//
// **Three sources, in this order** (`fit.rs`), because they are not equally trustworthy:
//
// 1. `supplied_curve` - the curve the body recorded for this shot, where the file carries
//    one. Sony writes it in the SubIFD `lens.rs` walks. Scored on the fringe left around
//    point sources over 43 frames of two lenses, the tag leaves 10.23 against 18.25
//    uncorrected. lensfun's TCA was tried for the same job and dropped: it covers three of
//    five frames sampled and never won.
// 2. `measure` - the fringe nulled directly around this frame's own point sources.
// 3. `estimate` - a least-squares slope off the green gradient, for frames with neither.
//
// **`estimate` is last because it is the one that has been wrong.** Measured against star
// halos over 36 astro frames it fires on the wrong frames and in both directions: of the 9
// frames it fired on, 6 carry no fringe at all - a red split between -1.13 and +0.62
// counts - and were given 0.76 to 1.21px of correction anyway, while every frame with a
// large genuine fringe, +5.39 up to +21.98, was declined outright. Where it does fire it
// overshoots by 2-3x: DSC09270 needed about 0.61px, got 1.87, and its +8.86 split came out
// at -18.22.
//
// The reduction below is why. Lateral CA is legible on point sources, and 4x4 averaging is
// where point sources go to die - so a pure starfield fails MIN_SAMPLES and declines, while
// the frames that pass do so on terrestrial and aurora content whose edges carry no
// reliable radial signal, and the fit manufactures a scale from them. `REDUCE` was
// calibrated on a single frame carrying an unusually large 5.05px, where the inflation
// happened to land nearer the truth; on an ordinary frame it carries past it.
//
// Every one of the three passes through `accept`, which drops a curve that does not
// measurably reduce the fringe it claims to correct. That is what makes trusting a source
// safe rather than a leap.

use crate::vips::RgbRef;
use rayon::prelude::*;

/// A gradient worth regressing against. Below this the projection is mostly noise and
/// the sample earns nothing but variance.
const MIN_EDGE: f64 = 40.0;

/// How far the frame is averaged down before anything is measured.
///
/// Not for speed, though it is that too. The regressor is built from the green
/// gradient, so noise in it does not merely add variance - it biases the slope towards
/// zero, and at ISO 6400 the noise edges outnumber the real ones. On a frame whose
/// aberration is known to be 5.05px, reading it at full size answered 0.08px, 2x2
/// answered 0.70 and 4x4 answers 2.97. A radial scale is dimensionless, so nothing has
/// to be undone afterwards.
///
/// Not more than 4, for two reasons. The estimate keeps climbing and never plateaus -
/// averaging suppresses the noise without removing it - so there is no converged value
/// to calibrate against and a larger factor is not self-evidently closer to the truth.
/// And the averaging eventually destroys what it is reading: at 6 a frame of stars has
/// no edges left and reports nothing at all.
///
/// **4 is already most of the way to that**, and the module header records what it costs:
/// a starfield declines for want of samples while a frame with terrestrial content passes
/// on edges that are not point sources, so the tier is selecting frames by what else is
/// in them rather than by what aberration they carry. Re-measured on a second frame the
/// climb is 0.86px, 1.24, 1.83 at 4, 8 and 12 - still no plateau, and the 4 here rests on
/// one frame's calibration rather than on a converged quantity.
const REDUCE: usize = 4;

/// Every second pixel in each direction, of the reduced frame.
const STRIDE: usize = 2;

/// Enough edges for the regression to mean anything. A frame of sky and flat wall can
/// fail this, and correcting it from a handful of samples would be worse than not.
///
/// Counted on the reduced frame, so a 24MP photo offers a couple of million and only a
/// genuinely featureless one falls short. One slope from two thousand edges is a tight
/// estimate; the risk this guards is the frame with almost none, not the frame with
/// merely fewer than a full-size pass would have found.
const MIN_SAMPLES: u64 = 2000;

/// Below this the correction moves nothing a viewer could see: a quarter of a pixel at
/// the corner of a 6000px frame, against a resample that is itself sampling between
/// pixels. Reported as None so the warp keeps its shared-ratio fast path.
const MIN_SHIFT: f64 = 0.25;

/// Beyond this it is not a lens, it is a misparse or a frame the regression had no
/// business being run on. The worst real measurement here is 0.0015.
const MAX_SCALE: f64 = 0.01;

/// Where the verification reads the fringe, in pixels either side of a point source.
///
/// The near one is measured rather than picked: swept over 1.5 to 10px on frames of known
/// aberration, the signal peaks at 1.5-2 and is gone by 5-6, while the standard error
/// stays flat, so the ratio is best there. It sat at 3 first, which read about half the
/// fringe that was actually present.
///
/// **The far one exists to see damage the near one cannot.** A correction far too large
/// pushes the channel clean out of the near window, and the split there collapses to
/// nothing - which reads as a perfect result. Measured: a 6x overshoot displaces red about
/// 6.7px and was waved through. At 5px a real fringe has already died away, so a correct
/// correction is not penalised for it, and a gross one has nowhere to hide.
const HALO_OFFSETS: [f64; 2] = [2.0, 5.0];

/// Samples taken either side of each reading, perpendicular to the radius.
///
/// Free precision: a radial displacement moves nothing along the perpendicular, so
/// averaging across it adds samples without blurring what is being measured. Cuts the
/// standard error of the split by about a third.
const HALO_ACROSS: i32 = 2;

/// Point sources needed before the verification will believe its own answer.
const MIN_POINTS: usize = 30;

/// The fraction of the fringe a correction has to actually remove to be kept.
///
/// Not zero, because the split carries noise and a correction that changes nothing
/// measurable is not worth the resample. Not high either - this is a floor against harm,
/// not a quality bar.
const MIN_IMPROVEMENT: f64 = 0.05;

/// The frame box-averaged by `REDUCE`, which is what the regression reads.
///
/// Every source pixel contributes exactly once and the centre is preserved, so the
/// radius each sample sits at is the same fraction of the frame it was.
fn reduced(image: RgbRef<'_>, reduce: usize) -> (Vec<u8>, usize, usize) {
    let (w, h) = (image.width / reduce, image.height / reduce);
    if w < 8 || h < 8 {
        return (image.data.to_vec(), image.width, image.height);
    }
    let mut out = vec![0u8; w * h * 3];
    out.par_chunks_mut(w * 3).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let mut totals = [0u32; 3];
            for source_y in y * reduce..(y + 1) * reduce {
                for source_x in x * reduce..(x + 1) * reduce {
                    let i = (source_y * image.width + source_x) * 3;
                    for (c, total) in totals.iter_mut().enumerate() {
                        *total += u32::from(image.data[i + c]);
                    }
                }
            }
            let n = (reduce * reduce) as u32;
            for c in 0..3 {
                row[x * 3 + c] = (totals[c] / n) as u8;
            }
        }
    });
    (out, w, h)
}

/// Red and blue's corrections as knot arrays, which is the currency `Lens::tca` carries
/// and the one a database curve arrives in.
///
/// A scale is a flat array rather than a special case: unlike a distortion spline, a
/// lateral correction is not anchored at zero in the centre - a channel imaged larger
/// is larger everywhere - so a constant is a legitimate curve rather than a degenerate
/// one.
pub fn flat(red: f64, blue: f64) -> [Vec<f64>; 2] {
    [
        vec![(red - 1.0) * crate::image::SPLINE_UNIT; 2],
        vec![(blue - 1.0) * crate::image::SPLINE_UNIT; 2],
    ]
}

/// The radial scale of red and of blue against green, or None where there is nothing
/// worth correcting.
///
/// A channel displaced by `d` against green leaves `R - G = -d.grad G` behind, and for
/// a radial scale `d` is `(scale - 1)` times the offset from the centre. So the scale
/// falls out of a least-squares fit of that difference against the gradient projected
/// onto the radius - one pass, no search, and the scene's own colour contributes only
/// variance because it does not align with the radial projection.
pub fn estimate(image: RgbRef<'_>) -> Option<[Vec<f64>; 2]> {
    let (red, blue) = slopes(image)?;
    accept(image, flat(1.0 + red, 1.0 + blue))
}

/// A curve the file records, applied as it stands.
///
/// **Taken at face value, and the measurement is why.** Scored against the fringe left on
/// point sources over 34 frames of two lenses, the body's own curve applied as recorded
/// leaves 9.12 against 16.82 uncorrected - 46% of it gone. Strength-fitting the same
/// curve leaves 15.07, barely better than doing nothing, because the fit is the same
/// regression that fires on frames with no aberration and overshoots on those it reads
/// (see the module header). A per-shot curve from the body that took the picture is
/// better evidence than a slope measured off one frame, so it is not second-guessed.
///
/// **A strength fit against a *third-party* curve was tried too, and dropped with the code
/// that did it.** lensfun's TCA was read for five frames, covering three: on the one frame
/// with independent ground truth its curve puts red at -0.07px where the star halos say
/// +5.05px, so face value left the halo split at +41.18 against a raw +51.37, and
/// strength-fitting it reached only +21.74 where measuring the frame directly reaches
/// +18.67. Scaling nothing is still nothing. Selecting between the two by which left the
/// smaller residual was tried as well and picks the worse one - lensfun's steeper curve
/// fits blue better and wins on total residual while leaving red uncorrected, and red is
/// most of what the eye sees here.
///
/// It is still verified. `accept` drops it if it does not measurably reduce the fringe,
/// which is what makes trusting a source safe rather than a leap.
pub fn supplied_curve(image: RgbRef<'_>, curve: [Vec<f64>; 2]) -> Option<[Vec<f64>; 2]> {
    accept(image, curve)
}

/// The largest radius any channel is read at, floored at 1: how far past green the
/// widest of them reaches, which is the room the crop has to leave.
pub fn widest(tca: Option<&[Vec<f64>; 2]>) -> f64 {
    let Some(curve) = tca else { return 1.0 };
    curve
        .iter()
        .flat_map(|knots| knots.iter())
        .fold(1.0f64, |peak, knot| peak.max(1.0 + knot / crate::image::SPLINE_UNIT))
}

/// Compact, isolated bright maxima in the outer frame - where a lateral aberration is
/// legible and almost nowhere else.
///
/// Three conditions, and the third is not optional. **Isolation alone is not enough**: a
/// thin bright wire against a dark sky falls away in every compass direction at any
/// radius wider than the wire, so an isolation test counts every pixel along a bridge
/// cable as a point source - which is exactly what it did, 487 of them on one frame, and
/// the frame was then scored on the colour of a bridge. Compactness is what tells a star
/// from a line: a star lights a handful of pixels, a line lights a row of them.
///
/// Clipped highlights are excluded because a channel at full scale has no headroom left
/// to carry a displacement, so the fringe that is visible around a blown star is the one
/// thing that cannot be read off it.
fn point_sources(image: RgbRef<'_>) -> Vec<(usize, usize)> {
    point_sources_past(image, 0.7)
}

fn point_sources_past(image: RgbRef<'_>, radius_from: f64) -> Vec<(usize, usize)> {
    const REACH: isize = 7;
    const MARGIN: usize = 24;
    const DROP: f64 = 35.0;
    const LIT_AT_MOST: usize = 12;
    const MAX_EXTENT: isize = 3;

    let (w, h) = (image.width, image.height);
    if w < MARGIN * 3 || h < MARGIN * 3 {
        return Vec::new();
    }
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
    let half = (cx * cx + cy * cy).sqrt().max(1.0);
    // Summed rather than averaged, in integers: this runs on every pixel of a 32MP frame
    // and the brightness test rejects almost all of them, so the cheap form of it is most
    // of what this function costs. Thresholds are three times the per-channel ones.
    let sum = |x: usize, y: usize| -> u32 {
        let i = (y * w + x) * 3;
        u32::from(image.data[i]) + u32::from(image.data[i + 1]) + u32::from(image.data[i + 2])
    };
    let luma = |x: usize, y: usize| f64::from(sum(x, y)) / 3.0;
    let inner = (radius_from * half).powi(2);

    // Rows in parallel. Each finds its own candidates and they are concatenated after, so
    // the result is the same order a serial scan would produce.
    // Every second row. A point source is a single-pixel peak, so this finds about half of
    // them - and the measurement wants tens per radius bin, not thousands. On a 32MP frame
    // the scan is most of what this costs and the half it skips buys nothing.
    let rows: Vec<Vec<(usize, usize)>> = (MARGIN..h - MARGIN)
        .into_par_iter()
        .step_by(2)
        .map(|y| {
            let mut row = Vec::new();
            for x in MARGIN..w - MARGIN {
                let (dx, dy) = (x as f64 - cx, y as f64 - cy);
                if dx * dx + dy * dy < inner {
                    continue;
                }
                let total = sum(x, y);
                if !(330..=735).contains(&total) {
                    continue;
                }
                let here = f64::from(total) / 3.0;
            let peak = (-2i64..=2).all(|oy| {
                (-2i64..=2).all(|ox| {
                    (ox, oy) == (0, 0)
                        || luma((x as i64 + ox) as usize, (y as i64 + oy) as usize) <= here
                })
            });
            if !peak {
                continue;
            }
            let isolated = [(-1isize, 0isize), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)]
                .iter()
                .all(|&(ox, oy)| {
                    luma((x as isize + ox * REACH) as usize, (y as isize + oy * REACH) as usize)
                        < here - DROP
                });
            if !isolated {
                continue;
            }
            // Compact *and centred*. Counting lit pixels alone is not enough: the end of
            // a wire has few of them inside the window and passes, which left five of a
            // bridge's cables still reading as stars. What separates them is extent - a
            // star's lit pixels all sit within a pixel or two of its peak, where a wire's
            // run away along it.
                let (mut count, mut extent) = (0usize, 0isize);
                for oy in -REACH..=REACH {
                    for ox in -REACH..=REACH {
                        if luma((x as isize + ox) as usize, (y as isize + oy) as usize) > here - DROP
                        {
                            count += 1;
                            extent = extent.max(ox.abs().max(oy.abs()));
                        }
                    }
                }
                if count <= LIT_AT_MOST && extent <= MAX_EXTENT {
                    row.push((x, y));
                }
            }
            row
        })
        .collect();
    rows.concat()
}

/// Outward minus inward colour against green around those point sources, with each
/// channel read through `scales`.
///
/// **This is what makes the check free of a warp.** A corrected frame's red at `q` is the
/// raw frame's red at `q * scale`, and its green at `q` is the raw green at `q` - so
/// applying a candidate and measuring what it leaves is the same arithmetic as measuring
/// what is there, with the sampling positions moved. Scales of 1 read the frame as it
/// stands. No pixels are resampled and nothing is allocated per candidate.
fn halo_split(
    image: RgbRef<'_>,
    points: &[(usize, usize)],
    curve: Option<&[Vec<f64>; 2]>,
    offset: f64,
) -> Option<[f64; 2]> {
    let (w, h) = (image.width, image.height);
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
    let half = (cx * cx + cy * cy).sqrt().max(1.0);
    let sample = |x: f64, y: f64, c: usize| -> f64 {
        let x = x.clamp(0.0, (w - 1) as f64);
        let y = y.clamp(0.0, (h - 1) as f64);
        f64::from(image.data[(y.round() as usize * w + x.round() as usize) * 3 + c])
    };

    let mut totals = [0.0f64; 2];
    let mut counted = 0usize;
    for &(px, py) in points {
        let (dx, dy) = (px as f64 - cx, py as f64 - cy);
        let radius = (dx * dx + dy * dy).sqrt();
        if radius < 1.0 {
            continue;
        }
        let (ux, uy) = (dx / radius, dy / radius);
        // Perpendicular to the radius, the direction a radial scale moves nothing.
        let (ax, ay) = (-uy, ux);
        let mut split = [0.0f64; 2];
        for (slot, channel) in [(0usize, 0usize), (1, 2)] {
            let side = |sign: f64| -> f64 {
                let mut total = 0.0;
                for k in -HALO_ACROSS..=HALO_ACROSS {
                    let qx = px as f64 + sign * ux * offset + ax * f64::from(k);
                    let qy = py as f64 + sign * uy * offset + ay * f64::from(k);
                    // **At this sample's own radius**, which is what the warp does. Taking
                    // one scale off the corner and applying it everywhere over-corrects
                    // every point inside the corner, and a curve that grows with radius
                    // then scores as harmful when it is the yardstick that is wrong -
                    // measured, it rejected 34 of 43 corrections that were helping.
                    let scale = match curve {
                        None => 1.0,
                        Some(curve) => {
                            let qr = ((qx - cx).powi(2) + (qy - cy).powi(2)).sqrt() / half;
                            1.0 + crate::image::spline_at(&curve[slot], qr)
                        }
                    };
                    let moved = sample(cx + (qx - cx) * scale, cy + (qy - cy) * scale, channel);
                    total += moved - sample(qx, qy, 1);
                }
                total / f64::from(HALO_ACROSS * 2 + 1)
            };
            split[slot] = side(1.0) - side(-1.0);
        }
        totals[0] += split[0];
        totals[1] += split[1];
        counted += 1;
    }
    match counted >= MIN_POINTS {
        true => Some([totals[0] / counted as f64, totals[1] / counted as f64]),
        false => None,
    }
}

/// Radii the measurement bins point sources into, centre outward.
///
/// Four bins over the outer four fifths: enough to fit a slope through and few enough
/// that each holds the tens of point sources a stable nulling needs.
const MEASURE_BINS: [f64; 5] = [0.15, 0.35, 0.55, 0.75, 0.95];

/// Point sources a bin needs before its nulling is believed.
const MIN_PER_BIN: usize = 40;

/// Bins that must resolve before a slope is fitted through them. Two points define a line
/// through the origin exactly and prove nothing about whether the profile is a line.
const MIN_BINS: usize = 3;

/// The largest displacement at the corner the search will consider.
///
/// It was 2.5, which is narrower than the frame the header cites throughout: 5.05px at the
/// corner is 4.29px at the outermost bin, so that bin hit the wall and returned nothing -
/// declining exactly the frames with a large genuine fringe, which is the failure the
/// regression above was replaced for.
const REACH: f64 = 6.0;

/// How far either side of the coarse answer a bin is refined, in pixels.
///
/// **Bounded well under the split's own period, and that is the whole reason the coarse
/// pass is global.** The split repeats in the shift - a starfield's neighbouring sources
/// come back into the sampling window - so a wide per-bin sweep has several minima and
/// picks whichever alias happens to score lowest. Measured on a 1600x1200 field, the
/// period is 7px and a 3px injection was answered as 5.71px at the outer bin. Nothing
/// under half a period can reach one.
const REFINE_REACH: f64 = 1.5;

/// A displacement in pixels for a point source, given its radius in pixels.
#[derive(Clone, Copy)]
enum Shift {
    /// One displacement for every point in a bin, which is how a bin is refined once the
    /// scale is known.
    Fixed(f64),
    /// Proportional to radius - what a magnification difference actually is, and the only
    /// form the coarse pass considers.
    Scale(f64),
}

impl Shift {
    fn at(self, radius: f64) -> f64 {
        match self {
            Shift::Fixed(shift) => shift,
            Shift::Scale(scale) => scale * radius,
        }
    }
}

/// The lowest-scoring shift over a sweep, with its score.
fn sweep(
    image: RgbRef<'_>,
    points: &[(usize, usize)],
    slot: usize,
    from: f64,
    to: f64,
    steps: i32,
    shift: impl Fn(f64) -> Shift,
) -> Option<f64> {
    let mut best: Option<(f64, f64)> = None;
    for step in 0..=steps {
        let at = from + (to - from) * f64::from(step) / f64::from(steps);
        // Summed over both reaches. A shift large enough to push the channel out of the
        // near window still has to answer for the far one, so nulling by evacuation scores
        // no better than nulling by registering.
        let mut total = 0.0;
        let mut any = false;
        for offset in HALO_OFFSETS {
            if let Some(split) = shifted_split(image, points, slot, shift(at), offset) {
                total += split.abs();
                any = true;
            }
        }
        if any && best.is_none_or(|(_, b)| total < b) {
            best = Some((at, total));
        }
    }
    best.map(|(at, _)| at)
}

/// The magnification difference, as a fraction of radius, that nulls the fringe across the
/// whole frame at once.
///
/// **One search over every point source rather than one per bin, and that is what makes a
/// large aberration readable.** Each bin's split aliases: shift a bin's points by the
/// period at which neighbouring sources re-enter the sampling window and it scores as well
/// as the truth. Searched per bin, the alias is a free choice and the outer bin took one.
/// Searched as a scale it is not: an alias at radius `r` needs a displacement of
/// `true + period`, so it sits at a *different* scale for every radius and reinforces
/// nowhere, while the true scale lines up in every bin at once.
fn nulling_scale(image: RgbRef<'_>, points: &[(usize, usize)], slot: usize) -> Option<f64> {
    let (cx, cy) = (image.width as f64 / 2.0, image.height as f64 / 2.0);
    let half = (cx * cx + cy * cy).sqrt().max(1.0);
    const STEPS: i32 = 60;
    let bound = REACH / half;
    let scale = sweep(image, points, slot, -bound, bound, STEPS, Shift::Scale)?;
    // A minimum against the wall is a search that failed, not a measurement.
    match scale.abs() < bound * 0.98 {
        true => Some(scale),
        false => None,
    }
}

/// The shift, in pixels at this bin's radius, that nulls the fringe around these points.
///
/// Refines the frame-wide scale into this bin's own displacement, so a lens whose
/// aberration is not exactly proportional to radius still gets one measurement per bin -
/// bounded to `REFINE_REACH` so the refinement cannot wander into an alias the coarse pass
/// exists to exclude.
fn nulling_shift(
    image: RgbRef<'_>,
    points: &[(usize, usize)],
    slot: usize,
    guess: f64,
) -> Option<f64> {
    const STEPS: i32 = 30;
    sweep(
        image,
        points,
        slot,
        guess - REFINE_REACH,
        guess + REFINE_REACH,
        STEPS,
        Shift::Fixed,
    )
}

/// Outward minus inward colour for one channel, with that channel read `shift` pixels
/// further out.
fn shifted_split(
    image: RgbRef<'_>,
    points: &[(usize, usize)],
    slot: usize,
    shift: Shift,
    offset: f64,
) -> Option<f64> {
    let channel = match slot {
        0 => 0,
        _ => 2,
    };
    let (w, h) = (image.width, image.height);
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
    let sample = |x: f64, y: f64, c: usize| -> f64 {
        let x = x.clamp(0.0, (w - 1) as f64);
        let y = y.clamp(0.0, (h - 1) as f64);
        f64::from(image.data[(y.round() as usize * w + x.round() as usize) * 3 + c])
    };
    let (mut total, mut counted) = (0.0f64, 0usize);
    for &(px, py) in points {
        let (dx, dy) = (px as f64 - cx, py as f64 - cy);
        let radius = (dx * dx + dy * dy).sqrt();
        if radius < 1.0 {
            continue;
        }
        let (ux, uy) = (dx / radius, dy / radius);
        let (ax, ay) = (-uy, ux);
        let at = shift.at(radius);
        let side = |sign: f64| -> f64 {
            let mut sum = 0.0;
            for k in -HALO_ACROSS..=HALO_ACROSS {
                let qx = px as f64 + sign * ux * offset + ax * f64::from(k);
                let qy = py as f64 + sign * uy * offset + ay * f64::from(k);
                sum += sample(qx + ux * at, qy + uy * at, channel) - sample(qx, qy, 1);
            }
            sum / f64::from(HALO_ACROSS * 2 + 1)
        };
        total += side(1.0) - side(-1.0);
        counted += 1;
    }
    match counted >= MIN_PER_BIN {
        true => Some(total / counted as f64),
        false => None,
    }
}

/// Per-bin measurements turned into a knot curve, with the flat term removed.
///
/// The knots this produces are a *scale*, so a measured displacement `d` at radius `r`
/// becomes `d / (r * half)`. Bins are sparse and unevenly placed, so the value at each
/// knot radius is interpolated from the two measurements bracketing it, and held flat
/// past the outermost one rather than extrapolated - a curve invented beyond the
/// evidence is how the earlier estimators got their worst answers.
fn radial_knots(samples: &[(f64, f64)], intercept: f64, slope: f64, half: f64) -> Vec<f64> {
    const KNOTS: usize = 8;
    let scale_at = |radius: f64| -> f64 {
        // Bracketing measurements, or the fitted line where there are none. **Holding the
        // last measurement flat instead is wrong and was measurably so**: the displacement
        // stops growing while the radius it is divided by does not, so the scale collapses
        // towards the corner and an injected aberration came back at 60% of itself.
        let mut below: Option<(f64, f64)> = None;
        let mut above: Option<(f64, f64)> = None;
        for &(at, shift) in samples {
            if at <= radius && below.is_none_or(|(b, _)| at >= b) {
                below = Some((at, shift));
            }
            if at >= radius && above.is_none_or(|(a, _)| at <= a) {
                above = Some((at, shift));
            }
        }
        let displacement = match (below, above) {
            (Some((lo, a)), Some((hi, b))) if hi > lo => a + (b - a) * (radius - lo) / (hi - lo),
            _ => intercept + slope * radius * half,
        };
        // The flat term is not a magnification and is not corrected.
        (displacement - intercept) / (radius * half).max(1.0)
    };
    (0..KNOTS)
        .map(|i| {
            let radius = i as f64 / (KNOTS - 1) as f64;
            // At the centre a magnification difference contributes nothing, and dividing
            // a displacement by a vanishing radius there would invent everything.
            match radius <= 0.0 {
                true => 0.0,
                false => scale_at(radius) * crate::image::SPLINE_UNIT,
            }
        })
        .collect()
}

/// Lateral aberration measured directly, by nulling the fringe around point sources.
///
/// **Why this rather than the regression below.** The regression reads a slope off the
/// whole frame at a quarter resolution, which is where point sources go to die - so it
/// ends up fitting scene edges that carry no radial signal, fires on frames with no
/// aberration and declines frames with plenty. This measures the thing itself: find the
/// features a lateral aberration is legible on, displace one channel until the fringe
/// around them cancels, and read off how far that was.
///
/// The nulling is unbiased where the regression is not. Over synthetic registered stars it
/// reports 0.000px at every brightness and noise level tried, so a frame with nothing wrong
/// measures nothing rather than being handed a scale of noise. Injected aberrations come
/// back at 85-98% of themselves from 0.6px to 5px at the corner, the shortfall being the
/// discarded flat term below rather than attenuation.
///
/// **The correction passes through the origin, and that is doing real work.** A lateral
/// aberration is a magnification difference, so its displacement must vanish on axis and
/// grow with radius; a term that is flat across the field is by construction not one. Astro
/// frames carry exactly such a flat term - +0.36px pooled over 33 frames of a lens whose own
/// profile says it has almost no lateral CA - so the line through the bins is fitted *with*
/// an intercept and the intercept is then thrown away, which declines that term instead of
/// inventing a curve that fits it.
pub fn measure(image: RgbRef<'_>) -> Option<[Vec<f64>; 2]> {
    let (w, h) = (image.width, image.height);
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
    let half = (cx * cx + cy * cy).sqrt().max(1.0);
    let found = point_sources_past(image, MEASURE_BINS[0]);
    if found.len() < MIN_PER_BIN * MIN_BINS {
        return None;
    }

    let mut knots = [Vec::new(), Vec::new()];
    for slot in 0..2 {
        // Frame-wide first. Every bin's refinement starts from this, which is what keeps
        // each of them out of its own aliases.
        let Some(scale) = nulling_scale(image, &found, slot) else { continue };
        // Displacement against radius, one point per bin that resolves.
        let mut samples: Vec<(f64, f64)> = Vec::new();
        for pair in MEASURE_BINS.windows(2) {
            let (low, high) = (pair[0], pair[1]);
            let bin: Vec<(usize, usize)> = found
                .iter()
                .copied()
                .filter(|&(px, py)| {
                    let (dx, dy) = (px as f64 - cx, py as f64 - cy);
                    let radius = (dx * dx + dy * dy).sqrt() / half;
                    radius >= low && radius < high
                })
                .collect();
            if bin.len() < MIN_PER_BIN {
                continue;
            }
            let at = (low + high) / 2.0;
            if let Some(shift) = nulling_shift(image, &bin, slot, scale * at * half) {
                samples.push((at, shift));
            }
        }
        // **This channel only.** `return None` here threw the other one away: red
        // resolving four bins and blue two left the frame uncorrected entirely, which is
        // the wrong way round when red is most of what the eye sees. An empty knot slice
        // reads as no correction for that channel (`spline_at`) and leaves the other
        // standing.
        if samples.len() < MIN_BINS {
            continue;
        }
        // **The intercept is fitted so it can be thrown away.** Fitting through the origin
        // instead does not reject a flat term, it launders one: 0.6px at every radius
        // comes out as a 0.93px correction at the corner, because a line forced through
        // zero has nowhere else to put it. Fitting the intercept gives the flat part
        // somewhere to go, and what is left is the part that grows with radius - the only
        // part a magnification difference can explain.
        let count = samples.len() as f64;
        let mean_radius = samples.iter().map(|(radius, _)| radius * half).sum::<f64>() / count;
        let mean_shift = samples.iter().map(|(_, shift)| shift).sum::<f64>() / count;
        let covariance: f64 = samples
            .iter()
            .map(|(radius, shift)| (radius * half - mean_radius) * (shift - mean_shift))
            .sum();
        let variance: f64 =
            samples.iter().map(|(radius, _)| (radius * half - mean_radius).powi(2)).sum();
        let slope = match variance > 0.0 {
            true => covariance / variance,
            false => 0.0,
        };
        let intercept = mean_shift - slope * mean_radius;

        // **A curve rather than one scale.** A single slope is only right if the
        // aberration is exactly proportional to radius, and a real lens is not: measured
        // on three Canon lenses carrying 67 to 84 of fringe, one scale left most of it
        // behind. So each bin keeps its own measurement, with the flat term subtracted
        // off, and the knots interpolate between them - which is what the recorded Sony
        // curves do and why they do better.
        knots[slot] = radial_knots(&samples, intercept, slope, half);
    }
    let [red, blue] = knots;
    // Both channels short of the bins they need is a frame this cannot read at all, which
    // is different from one channel carrying nothing worth correcting.
    if red.is_empty() && blue.is_empty() {
        return None;
    }
    accept(image, [red, blue])
}

/// Whether applying `curve` would actually reduce the fringe it claims to correct.
///
/// **The estimate is not self-checking and has been wrong in both directions.** Measured
/// against point sources over 36 astro frames, the regression fired on 6 frames carrying
/// no fringe at all and declined every frame carrying a large one, and where it did fire
/// it overshot by 2-3x - leaving the library's frames measurably worse on average than
/// leaving them alone. Every one of those cases is visible to this check, which costs no
/// resample and reuses the same point sources the aberration is legible on.
///
/// Judged at the radius each point source actually sits at rather than at the corner, so
/// a curve that is right in the middle of the frame and wrong at the edge is judged where
/// the evidence is.
///
/// `None` where the frame offers nothing to check against - a portrait, a flat wall - and
/// there the curve is allowed through unverified rather than dropped: absence of evidence
/// is not evidence, and refusing every frame without stars would disable the correction
/// almost everywhere it is wanted.
fn improves(image: RgbRef<'_>, curve: &[Vec<f64>; 2]) -> Option<bool> {
    let points = point_sources(image);
    if points.len() < MIN_POINTS {
        return None;
    }
    // Summed over both reaches, so a correction that merely pushes the fringe out of the
    // near window cannot pass as one that removed it.
    let (mut was, mut now) = (0.0f64, 0.0f64);
    for offset in HALO_OFFSETS {
        let before = halo_split(image, &points, None, offset)?;
        let after = halo_split(image, &points, Some(curve), offset)?;
        was += before[0].abs() + before[1].abs();
        now += after[0].abs() + after[1].abs();
    }
    // A frame with no fringe to begin with has nothing to improve, and dividing by it
    // would turn noise into a verdict.
    if was < 1.0 {
        return Some(now <= was + 1.0);
    }
    Some(now < was * (1.0 - MIN_IMPROVEMENT))
}

/// What can be judged from the curve alone, without reading a pixel.
fn plausible(image: RgbRef<'_>, curve: [Vec<f64>; 2]) -> Option<[Vec<f64>; 2]> {
    let half = ((image.width as f64 / 2.0).powi(2) + (image.height as f64 / 2.0).powi(2)).sqrt();
    let reach = |knots: &Vec<f64>| {
        knots.iter().fold(0.0f64, |peak, knot| peak.max((knot / crate::image::SPLINE_UNIT).abs()))
    };
    let (red, blue) = (reach(&curve[0]), reach(&curve[1]));
    if red > MAX_SCALE || blue > MAX_SCALE {
        return None;
    }
    // Judged by what it does to the corner rather than by the scale, which is the same
    // number a reader can compare against the fringe they can see.
    if red * half < MIN_SHIFT && blue * half < MIN_SHIFT {
        return None;
    }
    Some(curve)
}

/// Whether a curve is worth applying, and the one place that decides it.
fn accept(image: RgbRef<'_>, curve: [Vec<f64>; 2]) -> Option<[Vec<f64>; 2]> {
    let curve = plausible(image, curve)?;
    // Last, because it is the only test here that reads the picture rather than the
    // curve, and the cheap arithmetic above rejects most candidates before it runs.
    if improves(image, &curve) == Some(false) {
        return None;
    }
    Some(curve)
}


/// The least-squares slope of red and of blue against the projected green gradient.
fn slopes(image: RgbRef<'_>) -> Option<(f64, f64)> {
    let (reduce, min_edge) = (REDUCE, MIN_EDGE);
    let (source, w, h) = reduced(image, reduce);
    if w < 8 || h < 8 {
        return None;
    }
    let data = &source[..];
    // Not `w / 2`. A reduced pixel stands for the block `[x*f, (x+1)*f)`, whose centre
    // of mass sits half a block in, so the frame's centre lands `(f - 1) / 2` input
    // pixels off where naming it `w / 2` would put it. That is a constant offset in the
    // regressor, and with no intercept in the model it lands squarely in the slope: the
    // estimate drifted with the reduction factor rather than converging, by about the
    // size of the offset each time.
    let inset = (reduce as f64 - 1.0) / 2.0;
    let cx = (image.width as f64 / 2.0 - inset) / reduce as f64;
    let cy = (image.height as f64 / 2.0 - inset) / reduce as f64;

    // Gain-matched against green first, or the difference the regression reads carries
    // the channels' overall imbalance on top of the misregistration.
    let mut sums = [0.0f64; 3];
    for pixel in (0..w * h).step_by(97) {
        for (c, sum) in sums.iter_mut().enumerate() {
            *sum += f64::from(data[pixel * 3 + c]);
        }
    }
    let gains = [
        if sums[0] > 0.0 { sums[1] / sums[0] } else { 1.0 },
        1.0,
        if sums[2] > 0.0 { sums[1] / sums[2] } else { 1.0 },
    ];

    // Numerator and denominator of the least-squares slope, per channel.
    let (mut cross, mut square) = ([0.0f64; 2], [0.0f64; 2]);
    let mut counted = 0u64;
    let mut y = 1;
    while y < h - 1 {
        let mut x = 1;
        while x < w - 1 {
            let i = (y * w + x) * 3;
            let green = |o: isize| f64::from(data[(i as isize + o) as usize + 1]);
            let row = w as isize * 3;
            let (gx, gy) = ((green(3) - green(-3)) / 2.0, (green(row) - green(-row)) / 2.0);
            if gx.abs() + gy.abs() < min_edge {
                x += STRIDE;
                continue;
            }
            let (dx, dy) = (x as f64 - cx, y as f64 - cy);
            // The gradient projected onto the offset from the centre, which is the only
            // direction a radial scale can move anything along.
            let regressor = -(dx * gx + dy * gy);
            for (slot, c) in [(0usize, 0usize), (1, 2)] {
                let difference = gains[c] * f64::from(data[i + c]) - green(0);
                cross[slot] += difference * regressor;
                square[slot] += regressor * regressor;
            }
            counted += 1;
            x += STRIDE;
        }
        y += 1;
    }
    if counted < MIN_SAMPLES {
        return None;
    }
    // A frame with no gradient anywhere has no slope to answer rather than a failure that
    // would take the other channel down with it.
    let strength = |slot: usize| match square[slot] > 0.0 {
        true => cross[slot] / square[slot],
        false => 0.0,
    };
    Some((strength(0), strength(1)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vips::Rgb;

    /// A frame of edges at every orientation, so the regression sees radial gradients
    /// wherever it looks rather than only along one axis.
    ///
    /// Blocks sized to survive `REDUCE`: the estimate is taken on an averaged-down copy,
    /// and a pattern finer than that is a test of the box filter rather than of the
    /// regression.
    fn checks(width: usize, height: usize) -> Rgb {
        let mut data = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let value = match ((x / (11 * REDUCE)) + (y / (13 * REDUCE))) % 2 == 0 {
                    true => 210u8,
                    false => 40,
                };
                let i = (y * width + x) * 3;
                for c in 0..3 {
                    data[i + c] = value;
                }
            }
        }
        Rgb { width, height, data }
    }

    /// Rescales one channel radially by *reading* at `scale`, which is the same
    /// direction `estimate` reports and `warp_planar` applies: reading further out
    /// shrinks the channel. So injecting `s` leaves an aberration the estimate answers
    /// with `1/s`, and feeding that answer back in cancels it.
    fn inject(source: &Rgb, channel: usize, scale: f64) -> Rgb {
        let (w, h) = (source.width, source.height);
        let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
        let mut data = source.data.clone();
        for y in 0..h {
            for x in 0..w {
                let (sx, sy) = (cx + (x as f64 - cx) * scale, cy + (y as f64 - cy) * scale);
                if sx < 0.0 || sy < 0.0 || sx >= (w - 1) as f64 || sy >= (h - 1) as f64 {
                    continue;
                }
                let (x0, y0) = (sx as usize, sy as usize);
                let (fx, fy) = (sx - x0 as f64, sy - y0 as f64);
                let i = (y0 * w + x0) * 3 + channel;
                let value = f64::from(source.data[i]) * (1.0 - fx) * (1.0 - fy)
                    + f64::from(source.data[i + 3]) * fx * (1.0 - fy)
                    + f64::from(source.data[i + w * 3]) * (1.0 - fx) * fy
                    + f64::from(source.data[i + w * 3 + 3]) * fx * fy;
                data[(y * w + x) * 3 + channel] = value.round().clamp(0.0, 255.0) as u8;
            }
        }
        Rgb { width: w, height: h, data }
    }

    /// A curve's scale at the corner, which for the flat ones `estimate` produces is
    /// its scale everywhere.
    fn corner(curve: &[Vec<f64>; 2], channel: usize) -> f64 {
        1.0 + crate::image::spline_at(&curve[channel], 1.0)
    }

    #[test]
    fn recovers_a_scale_that_was_injected_on_purpose() {
        // The check the module is worth having: a known misregistration has to come back
        // as itself. Three search-based estimators answered ~0 on a frame carrying a
        // real one, which is exactly what this would have caught.
        let source = checks(900, 600);
        for injected in [1.0008f64, 1.0015, 0.9988] {
            let found = estimate(inject(&source, 0, injected).as_ref()).expect("a scale");
            let red = corner(&found, 0);
            assert!(
                (red - 1.0 / injected).abs() < 0.0004,
                "injected {injected}, wanted {}, recovered {red}",
                1.0 / injected,
            );
        }
    }

    /// Asserted as a round trip rather than as a number, because the direction is the
    /// easy thing to get backwards here and a sign error reads as a plausible scale.
    #[test]
    fn applying_the_estimate_cancels_the_aberration() {
        let aberrated = inject(&checks(900, 600), 0, 1.0015);
        let found = estimate(aberrated.as_ref()).expect("a scale");
        let corrected = inject(&aberrated, 0, corner(&found, 0));
        assert!((corner(&found, 1) - 1.0).abs() < 0.0004, "blue should not have moved");
        assert!(
            estimate(corrected.as_ref()).is_none(),
            "correcting by the estimate has to leave nothing worth correcting",
        );
    }

    #[test]
    fn tells_red_from_blue() {
        // One channel moved must not be reported against the other, or a correction
        // lands on the channel that was already registered.
        let moved = inject(&checks(900, 600), 2, 1.0015);
        let found = estimate(moved.as_ref()).expect("a scale");
        let (red, blue) = (corner(&found, 0), corner(&found, 1));
        assert!((blue - 1.0 / 1.0015).abs() < 0.0004, "blue {blue}");
        assert!((red - 1.0).abs() < 0.0004, "red moved to {red} when only blue was");
    }

    /// A curve the file records reaches the warp as recorded, shape and all - the one
    /// thing `supplied_curve` promises and the reason the strength fit was removed.
    #[test]
    fn a_supplied_curve_is_applied_as_recorded() {
        const KNOTS: usize = 8;
        let aberrated = inject(&starfield(1200, 900), 0, 1.0015);
        // A ramp rather than a flat scale, so a path that quietly refitted this would have
        // to reproduce the shape as well as the size to pass.
        let ramp: Vec<f64> = (0..KNOTS)
            .map(|i| -0.0015 * crate::image::SPLINE_UNIT * i as f64 / (KNOTS - 1) as f64)
            .collect();
        let supplied = [ramp.clone(), vec![0.0; KNOTS]];
        let applied = supplied_curve(aberrated.as_ref(), supplied).expect("a curve");
        assert_eq!(applied, [ramp, vec![0.0; KNOTS]]);
    }

    /// Point sources on a dark sky, which is the frame this over-fires on in the field
    /// and which `checks` cannot stand in for: a checkerboard carries edges of both
    /// polarities that cancel, where a starfield is bright-on-dark everywhere.
    fn starfield(width: usize, height: usize) -> Rgb {
        let mut data = vec![18u8; width * height * 3];
        // **Peaked, not a flat block.** A real point source falls away from its centre,
        // and `point_sources` keys on exactly that - a flat 4x4 patch lights sixteen
        // pixels and is rejected as an extended object, which is correct of it and was
        // wrong of this fixture. Bright enough at the centre to survive the 4x4 average
        // the regression reads, so one fixture serves both.
        let mut put = |x: usize, y: usize, value: u8| {
            let i = (y * width + x) * 3;
            for c in 0..3 {
                data[i + c] = value;
            }
        };
        for y in (8..height - 8).step_by(5 * REDUCE) {
            for x in (8..width - 8).step_by(5 * REDUCE) {
                for oy in -1isize..=1 {
                    for ox in -1isize..=1 {
                        let value = if (ox, oy) == (0, 0) { 235 } else { 150 };
                        put((x as isize + ox) as usize, (y as isize + oy) as usize, value);
                    }
                }
            }
        }
        Rgb { width, height, data }
    }

    /// A radial colour cast - colour vignetting, or a sky that reddens towards the edge -
    /// applied with **no misregistration at all**.
    fn colour_cast(source: &Rgb, channel: usize, strength: f64) -> Rgb {
        let (w, h) = (source.width, source.height);
        let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
        let half = (cx * cx + cy * cy).sqrt();
        let mut data = source.data.clone();
        for y in 0..h {
            for x in 0..w {
                let r = ((x as f64 - cx).powi(2) + (y as f64 - cy).powi(2)).sqrt() / half;
                let i = (y * w + x) * 3 + channel;
                let value = f64::from(source.data[i]) * (1.0 + strength * r * r);
                data[i] = value.round().clamp(0.0, 255.0) as u8;
            }
        }
        Rgb { width: w, height: h, data }
    }

    #[test]
    fn a_radial_colour_cast_is_not_a_misregistration() {
        // **Why this exists.** Measured on real astro frames, the estimate fires on
        // frames whose stars are visibly clean and invents 1.9-2.4px of correction,
        // which the module header's "always towards zero, so it under-corrects and never
        // over-corrects" says cannot happen. A radial colour cast is the obvious
        // candidate: it is a smooth radial R-minus-G trend, which is what the regressor
        // keys on, and nothing corrects it before this runs - the falloff is applied in
        // `fit::apply`, after the fit that calls this.
        //
        // Nothing here is displaced by even a fraction of a pixel, so any scale reported
        // is entirely manufactured.
        // **`checks`, not `starfield`, and the positive control below is why.** On a
        // starfield the reduced green gradient clears `MIN_EDGE` almost nowhere, so
        // `slopes` counts zero samples and `estimate` declines before it has read anything
        // about colour at all. This test passed for a while with `estimate` returning None
        // unconditionally, which is worth exactly nothing.
        let clean = checks(900, 600);
        assert!(
            estimate(inject(&clean, 0, 1.0015).as_ref()).is_some(),
            "the fixture must be one this estimator can actually read, or the assertions \
             below pass on a decline that has nothing to do with a colour cast",
        );
        assert!(estimate(clean.as_ref()).is_none(), "the fixture itself must carry nothing");

        for strength in [0.05f64, 0.15, 0.3] {
            let cast = colour_cast(&clean, 0, strength);
            let found = estimate(cast.as_ref());
            assert!(
                found.is_none(),
                "a {strength} radial cast on a registered frame was read as a scale of {:?}",
                found.map(|c| corner(&c, 0)),
            );
        }
    }

    /// Shot noise, deterministically. Per channel and independent, which is what a
    /// demosaiced high-ISO frame carries once the colour filter array has been
    /// interpolated.
    fn noisy(source: &Rgb, amplitude: f64) -> Rgb {
        let mut data = source.data.clone();
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        for value in data.iter_mut() {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let unit = ((state >> 33) as f64 / f64::from(u32::MAX >> 1)) - 1.0;
            *value = (f64::from(*value) + unit * amplitude).round().clamp(0.0, 255.0) as u8;
        }
        Rgb { width: source.width, height: source.height, data }
    }

    #[test]
    fn noise_alone_is_not_a_misregistration() {
        // **The over-correction this is chasing.** `REDUCE` was set to 4 because the
        // estimate climbs with it - 0.08px, 0.70, 2.97 on a frame carrying 5.05 - and
        // the header records that it "keeps climbing and never plateaus". A quantity
        // that grows with how hard the frame is averaged, without converging, is as
        // easily an artifact of the averaging as a recovery of the truth. If it is an
        // artifact, a registered frame of pure noise manufactures a scale of its own,
        // and the frames seen over-firing in the field report 1.87 and 2.42px against
        // that 2.97.
        //
        // Nothing here is displaced at all, so any scale reported is invented.
        // `checks` rather than `starfield`, for the reason recorded on the colour-cast
        // test above: a starfield gives `slopes` nothing that clears `MIN_EDGE`, so the
        // decline says nothing about noise.
        let clean = checks(900, 600);
        assert!(
            estimate(inject(&clean, 0, 1.0015).as_ref()).is_some(),
            "the fixture must be one this estimator can actually read",
        );
        for amplitude in [4.0f64, 10.0, 20.0] {
            let frame = noisy(&clean, amplitude);
            let found = estimate(frame.as_ref());
            assert!(
                found.is_none(),
                "noise of {amplitude} counts on a registered frame was read as {:?}",
                found.map(|c| corner(&c, 0)),
            );
        }
    }

    #[test]
    fn the_check_finds_stars_and_not_a_wire() {
        // The failure that made this a hard requirement: a bridge's cables scored as 487
        // point sources, and the frame was then judged on the colour of a bridge. A thin
        // bright line falls away in every direction at any radius wider than the line, so
        // isolation alone passes it and only compactness rejects it.
        let (w, h) = (600usize, 400usize);
        let mut frame = vec![18u8; w * h * 3];
        // A diagonal wire across the outer frame, one pixel wide.
        for step in 0..260usize {
            let (x, y) = (300 + step, 40 + step / 2);
            if x < w && y < h {
                for c in 0..3 {
                    frame[(y * w + x) * 3 + c] = 200;
                }
            }
        }
        let wire = Rgb { width: w, height: h, data: frame };
        assert!(
            point_sources(wire.as_ref()).is_empty(),
            "a one-pixel wire was read as {} point sources",
            point_sources(wire.as_ref()).len(),
        );

        // And the same detector does find actual point sources, so the assertion above
        // is not passing because it finds nothing anywhere.
        let stars = starfield(1200, 900);
        assert!(point_sources(stars.as_ref()).len() > MIN_POINTS, "no stars found in a starfield");
    }

    #[test]
    fn a_correction_that_makes_the_fringe_worse_is_refused() {
        // **The check this whole gate exists for.** Measured on real frames the estimate
        // fires on frames with no aberration and overshoots by 2-3x on those it reads,
        // leaving them worse than untouched. Nothing downstream noticed, because nothing
        // downstream looked.
        let aberrated = inject(&starfield(1200, 900), 0, 1.0015);

        // Backwards: the right magnitude pushed the wrong way, which doubles the fringe.
        let backwards = flat(1.0015, 1.0);
        assert_eq!(
            improves(aberrated.as_ref(), &backwards),
            Some(false),
            "a correction applied backwards has to be refused",
        );

        // Wildly overshooting in the right direction is still worse than nothing.
        let overshoot = flat(1.0 / 1.009, 1.0);
        assert_eq!(
            improves(aberrated.as_ref(), &overshoot),
            Some(false),
            "a correction six times too large has to be refused",
        );

        // And the correct one is kept, or the gate would simply refuse everything.
        let right = flat(1.0 / 1.0015, 1.0);
        assert_eq!(
            improves(aberrated.as_ref(), &right),
            Some(true),
            "the correction that cancels the aberration has to be kept",
        );
    }

    #[test]
    fn a_frame_with_nothing_to_check_against_is_not_judged() {
        // A portrait or a flat wall offers no point sources. Refusing those would disable
        // the correction almost everywhere it is wanted, so they pass unverified - absence
        // of evidence is not evidence of harm.
        let flat_frame = Rgb { width: 400, height: 300, data: vec![128u8; 400 * 300 * 3] };
        assert_eq!(improves(flat_frame.as_ref(), &flat(1.001, 1.0)), None);
    }

    #[test]
    fn the_gate_refuses_a_backwards_curve_through_the_public_path() {
        // Wired into `accept`, so every path that produces a curve is covered rather than
        // only the one this test calls. A supplied curve pointing the wrong way is the
        // case that shipped: the Sony tag was read backwards for a while and nothing
        // rejected it.
        let aberrated = inject(&starfield(1200, 900), 0, 1.0015);
        assert!(
            accept(aberrated.as_ref(), flat(1.0015, 1.0)).is_none(),
            "a backwards curve reached the warp",
        );
    }

    /// Point sources spread over every radius, for the measurement rather than the gate.
    fn wide_starfield(width: usize, height: usize) -> Rgb {
        let mut data = vec![16u8; width * height * 3];
        let mut put = |x: usize, y: usize, value: u8| {
            let i = (y * width + x) * 3;
            for c in 0..3 {
                data[i + c] = value;
            }
        };
        for y in (12..height - 12).step_by(17) {
            for x in (12..width - 12).step_by(17) {
                for oy in -1isize..=1 {
                    for ox in -1isize..=1 {
                        let value = if (ox, oy) == (0, 0) { 230u8 } else { 145 };
                        put((x as isize + ox) as usize, (y as isize + oy) as usize, value);
                    }
                }
            }
        }
        Rgb { width, height, data }
    }

    #[test]
    fn the_measurement_recovers_an_injected_scale() {
        // The check the regression never passed and this exists to replace it: a known
        // misregistration has to come back as itself, on a frame built to look like what
        // the measurement actually runs on.
        let source = wide_starfield(1600, 1200);
        // Tolerance scales with the injection: what is left over is the part the fitted
        // intercept charges to the flat term, which is proportional to the signal rather
        // than fixed.
        for injected in [1.0006f64, 1.0012, 0.9992] {
            let found = measure(inject(&source, 0, injected).as_ref()).expect("a scale");
            let red = corner(&found, 0);
            let wanted = 1.0 / injected;
            let tolerance = (wanted - 1.0).abs() * 0.25 + 0.0002;
            assert!(
                (red - wanted).abs() < tolerance,
                "injected {injected}, wanted {wanted}, measured {red}",
            );
            // And the channel that was not moved is not corrected.
            assert!((corner(&found, 1) - 1.0).abs() < 0.0004, "blue moved to {}", corner(&found, 1));
        }
    }

    /// **The size the module exists for, which a per-bin search could not reach.**
    ///
    /// 3px and 5px at the corner is the range the header cites: 5.05px on a 16mm f/2.8
    /// frame. Searched per bin these were not measured but *aliased* - the outer bin
    /// answered a 3px injection as 5.71px, because the split repeats every 7px on this
    /// field and the alias scored lower than the truth. Nothing about the search width
    /// fixed that; making the coarse pass a frame-wide scale did, because an alias sits at
    /// a different scale for every radius.
    #[test]
    fn a_large_aberration_is_measured_rather_than_aliased() {
        let source = wide_starfield(1600, 1200);
        for injected in [1.003f64, 1.005] {
            let found = measure(inject(&source, 0, injected).as_ref()).expect("a scale");
            let wanted = 1.0 / injected;
            let want_px = (wanted - 1.0).abs() * 1000.0;
            let off_px = (corner(&found, 0) - wanted).abs() * 1000.0;
            // Short of exact, and the fitted intercept is why: the innermost bin reads a
            // little high, which the line charges to the flat term and then discards. That
            // is the trade `measure` makes on purpose - it is what declines the flat
            // displacement two tests below - and it costs about a tenth here.
            assert!(
                off_px < want_px * 0.15,
                "injected {injected}: wanted {want_px:.2}px, measured {off_px:.2}px out",
            );
        }
    }

    #[test]
    fn one_channel_falling_short_does_not_discard_the_other() {
        // Red resolving its bins and blue not used to return None for the whole frame, so
        // a readable red correction was thrown away with the unreadable blue one - the
        // wrong way round, red being most of what the eye sees here. Blue is starved by
        // giving it nothing to measure: only red is displaced.
        let source = wide_starfield(1600, 1200);
        let found = measure(inject(&source, 0, 1.0012).as_ref()).expect("a scale");
        assert!(
            (corner(&found, 0) - 1.0 / 1.0012).abs() < 0.0004,
            "red came back {}",
            corner(&found, 0),
        );
    }

    #[test]
    fn the_measurement_declines_a_registered_frame() {
        // Where the regression manufactured a scale from scene edges, this has to report
        // nothing at all - which is most of the point of replacing it.
        assert!(measure(wide_starfield(1600, 1200).as_ref()).is_none());
        assert!(measure(noisy(&wide_starfield(1600, 1200), 12.0).as_ref()).is_none());
    }

    #[test]
    fn a_flat_displacement_is_not_read_as_an_aberration() {
        // Astro frames carry a term that is flat across the field - +0.36px pooled over 33
        // frames of a lens whose own recorded profile says it has almost none. A lateral
        // aberration is a magnification difference and cannot be flat, so fitting through
        // the origin has to decline this rather than fit a curve to it.
        let source = wide_starfield(1600, 1200);
        let (w, h) = (source.width, source.height);
        let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
        let mut data = source.data.clone();
        // Red displaced outward by the same distance everywhere, which no lens does.
        const FLAT: f64 = 0.6;
        for y in 0..h {
            for x in 0..w {
                let (dx, dy) = (x as f64 - cx, y as f64 - cy);
                let radius = (dx * dx + dy * dy).sqrt();
                if radius < 1.0 {
                    continue;
                }
                let (sx, sy) = (x as f64 + dx / radius * FLAT, y as f64 + dy / radius * FLAT);
                if sx < 0.0 || sy < 0.0 || sx >= (w - 1) as f64 || sy >= (h - 1) as f64 {
                    continue;
                }
                let (x0, y0) = (sx as usize, sy as usize);
                let (fx, fy) = (sx - x0 as f64, sy - y0 as f64);
                let p = |xx: usize, yy: usize| f64::from(source.data[(yy * w + xx) * 3]);
                let value = p(x0, y0) * (1.0 - fx) * (1.0 - fy)
                    + p(x0 + 1, y0) * fx * (1.0 - fy)
                    + p(x0, y0 + 1) * (1.0 - fx) * fy
                    + p(x0 + 1, y0 + 1) * fx * fy;
                data[(y * w + x) * 3] = value.round().clamp(0.0, 255.0) as u8;
            }
        }
        let flat = Rgb { width: w, height: h, data };

        // **The positive control, and it is what makes the assertion below mean anything.**
        // Without it this passes just as well on a frame the measurement cannot read at
        // all - the same hole two tests in this file shipped with. A radial displacement
        // of the same size has to come back, so the shift itself is legible here and only
        // its *shape* is what gets declined.
        let radial = inject(&source, 0, 1.0006);
        let read = measure(radial.as_ref()).expect("a radial 0.6px must be measurable");
        assert!((corner(&read, 0) - 1.0 / 1.0006).abs() < 0.0002, "{}", corner(&read, 0));

        // Whatever it reports must be far smaller than a curve fitted to the flat term
        // would be. Fitted freely, 0.6px everywhere reads as roughly 0.6px at the corner.
        let corner_px = match measure(flat.as_ref()) {
            None => 0.0,
            Some(found) => (corner(&found, 0) - 1.0).abs() * 1000.0,
        };
        assert!(corner_px < 0.35, "a flat displacement was fitted as {corner_px} at the corner");
    }

    #[test]
    fn declines_a_frame_that_carries_nothing() {
        // A registered frame must report None rather than a scale of noise, so the warp
        // keeps its shared-ratio path and no pixel is resampled for nothing.
        assert!(estimate(checks(900, 600).as_ref()).is_none());
    }

    #[test]
    fn declines_a_frame_with_no_edges_to_read() {
        let flat = Rgb { width: 200, height: 200, data: vec![128u8; 200 * 200 * 3] };
        assert!(estimate(flat.as_ref()).is_none());
    }
}
