//! Where each frame of a composite points, and how long the lens was, solved from what the pairs
//! found.
//!
//! One rotation per source and one focal for all of them: a panorama shot from a tripod has no
//! translation to recover, and a body that shot the whole set had one lens on it. That is the whole
//! model, and it is why ten frames cost sixteen parameters rather than a hundred.

use crate::composite_pairs::{Match, Pair};
use crate::composition::{conjugate, cross, from_axis_angle, multiply, normalise, rotate, Projection};
use crate::px::{Share, TUNED_ON};

/// Where every source points, in one frame.
pub struct Solved {
    /// Camera to world, one per source, index-aligned with `sizes`.
    pub rotations: Vec<[f64; 4]>,
    /// Pinhole focal in the pixels the matches are stated in.
    pub focal: f64,
    /// Per source, what `focal` has to be multiplied by for that frame alone: the scale the shared
    /// focal could not carry. All ones unless [`scale_each`] has run.
    ///
    /// **One focal is right for a pan and wrong for a burst.** A pan sees a lens's focal barely at
    /// all - a rotation and a translation are separated by the perspective across a frame, and a
    /// long lens has almost none - which is what `Leash` exists for. A burst is the other case: the
    /// frames sit on top of each other, so a difference in scale between two of them is as
    /// observable as anything in the set, and it is real - a lens breathes as it refocuses, and a
    /// hand that moved along the axis rescales the subject outright.
    pub scales: Vec<f64>,
    /// What the kept matches reproject to, in those same pixels.
    pub rms_px: f64,
    /// Sources the solve could not place, which the caller leaves out of the recipe.
    pub dropped: Vec<usize>,
    /// Which pairs the answer actually rests on, and what each one's matches reproject to: the
    /// probe prints it, and it is the only thing that says *why* a set came out as it did.
    pub kept: Vec<(usize, usize, f64)>,
    /// How much further out a match in the **outer fifth** of either frame reprojects than the
    /// median match anywhere, in those same pixels: the median of the outer population less the
    /// median of all the surviving ones.
    ///
    /// **What `rms_px` cannot say.** A focal error is radial and a match sits where there is
    /// texture, mostly not at the extreme corner - so a held focal that is wrong leaves the middle
    /// of the frame fitted and the corners several pixels out, and an rms over every match divides
    /// that away. §3.1 refuses a burst by this rather than by the rms.
    ///
    /// **A difference, because the outer median alone carries the frame's own floor.** What every
    /// inlier has under it is the texture the solve was fitted on - 1.04px of it on the burst §3.10
    /// is written from, where the whole field reads 0.97px - and a bound derived from a systematic
    /// term cannot be spent on that. The difference is what the word radial means: the pattern the
    /// corners have and the middle does not.
    pub radial_px: f64,
}

/// How far out a match has to sit to be the field's corner rather than its middle: §3.1's outer
/// fifth, radially, from the frame's centre to its own corner.
const OUTER: f64 = 0.8;

fn in_the_outer_fifth(size: &[usize; 2], at: [f64; 2]) -> bool {
    let (cx, cy) = (size[0] as f64 / 2.0, size[1] as f64 / 2.0);
    (at[0] - cx).hypot(at[1] - cy) > OUTER * cx.hypot(cy)
}

/// Past this, a match is not a correspondence but a coincidence.
const OUTLIER: Share = Share::of(6, TUNED_ON);
/// Where the loss stops being quadratic, so a mismatch pulls linearly rather than dominating.
const HUBER: Share = Share::of(2, TUNED_ON);

/// One of those shares in the pixels of the plane actually being solved on.
///
/// **Shares rather than pixels, which is what `px` says a distance in a space like this has to
/// be.** The search plane's pixels are not one fixed size - a RAW's preview is 1616, a grid tile
/// is whatever the library builds them at, a body that embeds neither is something else again -
/// so it is not [`crate::px::Absolute`] and a constant number of its pixels means a different
/// share of the picture in each. `px.rs` opens on this exact failure in another stage: a colour
/// smoothing written down as a count of pixels smoothed a rendition over two and a half times as
/// much of itself as it smoothed the same photograph at 1:1.
///
/// Measured here: at 1616 the solve refuses two frames that do not overlap the rest, and at 800 it
/// places them, six pixels of slack having quietly become twelve.
fn across(share: Share, sizes: &[[usize; 2]]) -> f64 {
    let long = sizes.iter().map(|size| size[0].max(size[1])).max().unwrap_or(0);
    share.raw() * (long.max(1) as f64)
}
/// A source that keeps less than this share of its matches was never really seen.
const KEPT_SHARE: f64 = 0.3;
const ITERATIONS: usize = 80;

/// How far the solve may move a focal the file told us, either way.
///
/// **Not free, because a pan cannot see it.** What separates a rotation from a translation is the
/// perspective across a frame, and a long lens has almost none - measured on a 165mm five-frame
/// pan, a free focal settled twenty percent short of what the body says, which bends every
/// rotation with it. A tenth covers a focal length EXIF rounded and a lens breathing at its
/// closest focus; past that the file is right and the pictures are not saying otherwise.
///
/// **The leash binds, and letting it out does not help.** The twenty-six frame set settles hard
/// against this - 0.980 of what the body says - so the fit does want to go further, and
/// `PANO_FOCAL_HELD` says what happens when it may: at 0.05, 0.10 and 0.20 it walks to each new
/// limit and the rms rises, 1.08px to 1.11, 1.13, 1.12. So the residual left at the seams is not a
/// focal the solve is being denied, and this is the value that fits best rather than merely the
/// most cautious one.
const FOCAL_HELD: f64 = 0.02;

/// The same, for a focal nobody told us: neither a rounded EXIF figure nor a breathing lens is what
/// separates `assumed_focal`'s 55-degree guess from the truth, and a 24mm lens is half of it.
const FOCAL_ASSUMED: f64 = 0.15;

/// How far the solve may move `focal0`, which is what the caller knows about where it came from.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Leash {
    /// The body said so.
    Told,
    /// Nothing said so and a field of view was guessed.
    Assumed,
    /// Solve for it: the frames see enough perspective to say.
    Free,
}

/// The rotations and focal that best explain `pairs`, or None where nothing connects.
///
/// `focal0` is in the matches' own pixels, and `leash` is how far from it the answer may go.
pub fn solve(sizes: &[[usize; 2]], pairs: &[Pair], focal0: f64, leash: Leash) -> Option<Solved> {
    let placed = reachable(sizes.len(), pairs, FITTABLE);
    let offered: Vec<Pair> =
        pairs.iter().filter(|p| enough(p) && placed[p.a] && placed[p.b]).cloned().collect();

    let held = match leash {
        // `PANO_FOCAL_HELD` moves the leash, for measuring whether it is the thing binding.
        Leash::Told => Some(
            std::env::var("PANO_FOCAL_HELD").ok().and_then(|v| v.parse().ok()).unwrap_or(FOCAL_HELD),
        ),
        Leash::Assumed => Some(FOCAL_ASSUMED),
        Leash::Free => None,
    };
    // **Grown one verified pair at a time, never solved from all of them at once.** A search over a
    // scene that repeats - a horizon, a wall, a row of windows - answers confidently for two frames
    // that never overlapped, and every one of its matches agrees with every other, so nothing about
    // that pair alone gives it away. What does is that it cannot be reconciled with the pairs that
    // are right: a frame two steps along a pan cannot sit where the frame one step along does.
    //
    // So the set is built from the strongest pair outwards, and each pair is asked to agree with
    // what is already standing before it is allowed to move anything. Brown and Lowe's own order,
    // and the reason every stitcher has one.
    //
    // **Grown on a sample of each pair's correspondences, and fitted here on all of them.** What
    // the growth asks of a pair is where a frame goes and whether the rest agrees within a few
    // pixels, and a hundred points spread over a frame answer that as well as four thousand do -
    // while every step of it is a fit, so the whole search pays for the difference. Measured on a
    // twenty-six frame pan: 104k correspondences over 83 pairs, and the growth was two minutes of
    // the two minutes the align took.
    let mut lap = crate::clock::laps("  solve ");
    let sampled: Vec<Pair> = offered.iter().map(thinned).collect();
    // The growth's own answer stands until the loop below refits: it was fitted on the sample, which
    // places every frame to well inside the several pixels an outlier is, and the round that follows
    // fits on everything anyway. Fitting here first is that same fit, done twice.
    let (grew, mut answer) = grown(sizes, &sampled, &offered, focal0, held)?;
    lap("grow");
    let mut kept: Vec<Pair> = grew.iter().map(|&at| offered[at].clone()).collect();

    // `PANO_ATTEST` moves the bar, for sweeping how wide the band is that still answers correctly.
    let attesting: usize =
        std::env::var("PANO_ATTEST").ok().and_then(|v| v.parse().ok()).unwrap_or(ATTESTING);
    let outlier = across(OUTLIER, sizes);
    for _ in 0..3 {
        let before: usize = kept.iter().map(|p| p.matches.len()).sum();
        for pair in &mut kept {
            let (a, b) = (pair.a, pair.b);
            pair.matches.retain(|m| {
                reprojection(sizes, &answer.rotations, answer.focal, a, b, m)
                    .is_some_and(|r| r <= outlier)
            });
        }
        // Thinned below what a rotation may be fitted from is not thinned below what says the two
        // frames met: a pair that keeps a handful stays, weakly constraining the fit and still
        // holding its frames into the set.
        kept.retain(|pair| pair.matches.len() >= attesting);
        let after: usize = kept.iter().map(|p| p.matches.len()).sum();
        // **On the sample again, for the same reason the growth is.** What each round of this needs
        // is an answer good enough to say which correspondences are outliers, and the rounds only
        // ever hand that to the next round - so all but the last of these fits is thrown away, and
        // fitting them on everything is the whole set solved twice to keep one of the answers.
        //
        // The told focal again, not the last answer: `grown` says why re-basing it ratchets.
        let anchor = if held.is_some() { focal0 } else { answer.focal };
        let sample: Vec<Pair> = kept.iter().map(thinned).collect();
        answer = fit(sizes, &sample, anchor, held, Some(&answer))?;
        lap("outlier round");
        if after * 100 >= before * 99 {
            break;
        }
    }
    // Once, on every correspondence that survived: this is the answer, and the only one measured
    // against all of them - `rms_px` included, which is what the recipe reports.
    let anchor = if held.is_some() { focal0 } else { answer.focal };
    answer = fit(sizes, &kept, anchor, held, Some(&answer))?;
    lap("fit");

    // A source nothing still corresponds with is not placed, however good its own picture was -
    // and reachability is asked again of what *survived*, since a pair whose matches all turned
    // out to be coincidences leaves the sources behind it holding a rotation nothing supports.
    let standing = reachable(sizes.len(), &kept, attesting);
    // The share is measured against the pairs that were *believed*, not against everything the
    // search proposed: a source whose false pairs were rejected above has lost most of its
    // matches by arithmetic, and charging it for that would drop the frame the rejection just
    // saved. What is left to ask is whether the pairs it still has kept their own matches.
    let believed: Vec<&Pair> = pairs
        .iter()
        .filter(|p| kept.iter().any(|k| k.a == p.a && k.b == p.b))
        .collect();
    let dropped: Vec<usize> = (0..sizes.len())
        .filter(|&i| {
            let touching = |set: &[&Pair]| -> usize {
                set.iter().filter(|p| p.a == i || p.b == i).map(|p| p.matches.len()).sum()
            };
            let asked = touching(&believed);
            let held: usize =
                kept.iter().filter(|p| p.a == i || p.b == i).map(|p| p.matches.len()).sum();
            !placed[i] || !standing[i] || asked == 0 || (held as f64) < KEPT_SHARE * asked as f64
        })
        .collect();

    answer.kept = kept
        .iter()
        .map(|pair| {
            (pair.a, pair.b, middle(pair_errors(sizes, &answer.rotations, answer.focal, pair)))
        })
        .collect();
    let (mut outer, mut every): (Vec<f64>, Vec<f64>) = (Vec::new(), Vec::new());
    for pair in &kept {
        for m in &pair.matches {
            let Some(off) = reprojection(sizes, &answer.rotations, answer.focal, pair.a, pair.b, m)
            else {
                continue;
            };
            every.push(off);
            if in_the_outer_fifth(&sizes[pair.a], m.a) || in_the_outer_fifth(&sizes[pair.b], m.b) {
                outer.push(off);
            }
        }
    }
    answer.radial_px = middle(outer) - middle(every);
    answer.dropped = dropped;
    straighten(&mut answer.rotations);
    Some(answer)
}

/// The surface the sources are projected onto, and the canvas that holds all of them.
pub struct Framing {
    pub projection: Projection,
    pub canvas: [usize; 2],
    pub centre: [f64; 2],
    pub radians_per_pixel: f64,
    /// The largest rectangle of that canvas every pixel of which some source covers, as `left,
    /// top, right, bottom` fractions of it - `EditDoc`'s own crop, in the same units.
    ///
    /// **A suggestion rather than the canvas itself.** The frames of a hand-held pan tilt against
    /// each other, so the union of them is a staircase with wedges of nothing at every corner, and
    /// a reader wants the picture inside that. But the wedges are *data*: an export of the whole
    /// canvas is what a reader takes to another tool to crop differently, so what is trimmed is
    /// trimmed by a setting on top of the recipe and never by the recipe.
    pub crop: [f64; 4],
}

/// Past this a rectilinear canvas stretches its corners without bound, and past it in both axes a
/// cylinder cannot hold the height either. Hugin's thresholds, and its rule below.
const WIDE_DEGREES: f64 = 100.0;

/// A canvas no larger than a TIFF's own limit, which is also more pixels than anyone asked for.
const CANVAS_LIMIT: usize = 65535;

/// What surface holds the solved sources, how many pixels of it there are, and where the axis
/// falls on them.
///
/// `full_scale` is full-resolution source pixels per pixel of the plane the solve ran on, so the
/// canvas comes out at the sources' own resolution rather than the previews'.
pub fn framed(solved: &Solved, sizes: &[[usize; 2]], full_scale: f64) -> Framing {
    let kept: Vec<usize> = (0..sizes.len()).filter(|i| !solved.dropped.contains(i)).collect();
    let rays: Vec<[f64; 3]> = kept
        .iter()
        .flat_map(|&i| border(&sizes[i]).map(move |at| (i, at)))
        .map(|(i, [x, y])| {
            let (cx, cy) = (sizes[i][0] as f64 / 2.0, sizes[i][1] as f64 / 2.0);
            // **That source's own focal, not the set's.** `composite_align` builds
            // `SourceSpec::focal` as `focal * scales[i] * full_scale`, and that is what places its
            // pixels on the canvas - so a canvas sized against the shared focal alone would state a
            // field of view the render does not have, by as much as `SCALE_LEASH`. Identical for a
            // pan, where every scale is one.
            let focal = solved.focal * solved.scales[i];
            rotate(solved.rotations[i], [(x - cx) / focal, (y - cy) / focal, 1.0])
        })
        .collect();

    let mut widest: f64 = 0.0;
    let mut tallest: f64 = 0.0;
    for ray in &rays {
        let flat = (ray[0] * ray[0] + ray[2] * ray[2]).sqrt();
        widest = widest.max(ray[0].atan2(ray[2]).abs());
        tallest = tallest.max(ray[1].atan2(flat).abs());
    }
    let (hfov, vfov) = (2.0 * widest.to_degrees(), 2.0 * tallest.to_degrees());
    let projection = match (hfov > WIDE_DEGREES, vfov > WIDE_DEGREES) {
        (false, false) => Projection::Rectilinear,
        (_, false) => Projection::Cylindrical,
        _ => Projection::Equirectangular,
    };

    let radians_per_pixel = 1.0 / (solved.focal * full_scale);
    let mut low = [f64::MAX; 2];
    let mut high = [f64::MIN; 2];
    for ray in &rays {
        let Some(at) = surface(projection, *ray) else { continue };
        for axis in 0..2 {
            low[axis] = low[axis].min(at[axis]);
            high[axis] = high[axis].max(at[axis]);
        }
    }

    let span = |axis: usize| ((high[axis] - low[axis]) / radians_per_pixel).ceil().max(1.0);
    let (width, height) = (span(0), span(1));
    // Shrunk as a whole rather than clipped: a canvas over the limit is a panorama at more
    // resolution than it can be held at, not a panorama of the wrong shape.
    let over = (width.max(height) / CANVAS_LIMIT as f64).max(1.0);
    let radians_per_pixel = radians_per_pixel * over;
    let mut framing = Framing {
        projection,
        canvas: [(width / over) as usize, (height / over) as usize],
        centre: [-low[0] / radians_per_pixel, -low[1] / radians_per_pixel],
        radians_per_pixel,
        crop: [0.0, 0.0, 1.0, 1.0],
    };
    // No angle to be a fraction of: `solve` levelled the rotations themselves, so the canvas is
    // framed around a panorama that is already upright rather than around a tilted one that a
    // straighten would then turn - which would grow it to a rotated bounding box and crop the
    // growth straight back off.
    framing.crop = inner_crop(&framing, solved, sizes, &kept);
    framing
}

/// How finely the coverage is walked to find the rectangle inside it. A cell of a four-hundred-wide
/// grid is a quarter of a percent of the canvas, which is finer than the ragged edge it is
/// measuring - that edge is a frame's own boundary, and the frames are a tenth of the canvas each.
const COVER_GRID: usize = 400;

/// The largest rectangle of the canvas every pixel of which some source covers, as fractions.
///
/// **A panorama's outer bounds are ragged and nobody wants to look at them.** Frames of a
/// hand-held pan tilt against each other by a degree or two, so the union of them is a staircase
/// with wedges of nothing at every corner. What a reader wants on screen is the picture inside
/// that - and what an export hands another tool is the whole canvas, wedges included, which is why
/// this is a crop to apply rather than a canvas to cut.
fn inner_crop(outer: &Framing, solved: &Solved, sizes: &[[usize; 2]], kept: &[usize]) -> [f64; 4] {
    let (across, down) = (COVER_GRID, COVER_GRID.max(1));
    let mut covered = vec![false; across * down];
    for cell in 0..across * down {
        let (x, y) = (cell % across, cell / across);
        let canvas = [
            (x as f64 + 0.5) / across as f64 * outer.canvas[0] as f64,
            (y as f64 + 0.5) / down as f64 * outer.canvas[1] as f64,
        ];
        let ray = ray_at(outer, canvas);
        covered[cell] = kept.iter().any(|&i| {
            let (cx, cy) = (sizes[i][0] as f64 / 2.0, sizes[i][1] as f64 / 2.0);
            let d = rotate(conjugate(solved.rotations[i]), ray);
            if d[2] <= 1e-9 {
                return false;
            }
            // That source's own focal, as `framed` uses: a crop is a promise that every source
            // reaches the rectangle, and it has to be measured through the geometry the render
            // will use rather than the one the solve shared.
            let focal = solved.focal * solved.scales[i];
            let (at_x, at_y) = (cx + focal * d[0] / d[2], cy + focal * d[1] / d[2]);
            at_x >= 0.0 && at_y >= 0.0 && at_x <= 2.0 * cx && at_y <= 2.0 * cy
        });
    }

    let Some([left, top, wide, tall]) = largest_inside(&covered, across, down) else {
        return [0.0, 0.0, 1.0, 1.0];
    };
    // Centre to centre, as `assembly_analysis::intersection_crop` is: a cell counts as covered on
    // the strength of its centre and its outer half may not be, so the crop's edges are the
    // outermost centres that were actually sampled.
    [
        (left as f64 + 0.5) / across as f64,
        (top as f64 + 0.5) / down as f64,
        ((left + wide - 1) as f64 + 0.5) / across as f64,
        ((top + tall - 1) as f64 + 0.5) / down as f64,
    ]
}

/// The ray a canvas pixel of a framing looks along - `composition::canvas_to_ray` before there is a
/// recipe to ask.
fn ray_at(framing: &Framing, canvas: [f64; 2]) -> [f64; 3] {
    let u = (canvas[0] - framing.centre[0]) * framing.radians_per_pixel;
    let v = (canvas[1] - framing.centre[1]) * framing.radians_per_pixel;
    match framing.projection {
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

/// The largest all-true rectangle of a grid, as `[left, top, width, height]`.
///
/// Row by row, each column carrying how far up it has been true: that turns every row into a
/// histogram whose largest rectangle is the classic stack walk, and the whole grid into one pass.
pub(crate) fn largest_inside(
    covered: &[bool],
    across: usize,
    down: usize,
) -> Option<[usize; 4]> {
    let mut heights = vec![0usize; across];
    let mut best: Option<(usize, [usize; 4])> = None;
    for row in 0..down {
        for (column, height) in heights.iter_mut().enumerate() {
            *height = match covered[row * across + column] {
                true => *height + 1,
                false => 0,
            };
        }
        // A sentinel zero past the end, so every bar still on the stack is settled by the walk
        // rather than by a second loop after it.
        let mut stack: Vec<(usize, usize)> = Vec::new();
        for column in 0..=across {
            let height = if column == across { 0 } else { heights[column] };
            let mut start = column;
            while stack.last().is_some_and(|(_, tall)| *tall >= height) {
                let (from, tall) = stack.pop().expect("a bar to settle");
                let area = tall * (column - from);
                if area > best.as_ref().map_or(0, |(seen, _)| *seen) {
                    best = Some((area, [from, row + 1 - tall, column - from, tall]));
                }
                start = from;
            }
            if height > 0 {
                stack.push((start, height));
            }
        }
    }
    best.map(|(_, rectangle)| rectangle)
}

/// Where a ray falls on a surface, in the units `radians_per_pixel` divides: `ray_to_canvas`
/// without a canvas to put it on.
fn surface(projection: Projection, ray: [f64; 3]) -> Option<[f64; 2]> {
    let [x, y, z] = ray;
    match projection {
        Projection::Rectilinear => (z > 1e-9).then(|| [x / z, y / z]),
        Projection::Cylindrical => {
            let flat = (x * x + z * z).sqrt();
            (flat > 1e-9).then(|| [x.atan2(z), y / flat])
        }
        Projection::Equirectangular => {
            Some([x.atan2(z), y.atan2((x * x + z * z).sqrt())])
        }
    }
}

/// The corners and edge midpoints of a frame, which is what its extent is measured from: the
/// widest point of a rotated rectangle is always one of these.
fn border(size: &[usize; 2]) -> impl Iterator<Item = [f64; 2]> {
    let (w, h) = (size[0] as f64, size[1] as f64);
    (0..=2).flat_map(move |i| {
        (0..=2).map(move |j| [w * f64::from(i) / 2.0, h * f64::from(j) / 2.0])
    })
}

/// A stop either way of what the headers said, and no further.
///
/// The measurement is a median over an overlap, which a moving cloud or a lens flare can move by a
/// little and a mis-registered pair by a lot; the headers are exact where they exist. So the
/// measurement corrects the headers rather than replacing them.
const RESIDUAL_CLAMP: f64 = std::f64::consts::SQRT_2;

/// What to multiply each source's scene-linear samples by so two frames metered differently meet
/// at the same brightness.
///
/// `measured` is one entry a pair: `(a, b, ratio)` where `ratio` is the median of a's samples over
/// b's across the overlap, so b times it matches a.
///
/// **The one production caller passes an empty slice.** `composite_align` never measures a pairwise
/// ratio, so `walked` never grows past the reference and every gain answers `stops(i)` - the header
/// arithmetic alone. `measured`, the graph walk and [`RESIDUAL_CLAMP`] are exercised only from this
/// module's own tests until a caller starts measuring real overlaps.
pub fn gains(
    exposures: &[Option<f64>],
    measured: &[(usize, usize, f64)],
    reference: usize,
) -> Vec<f64> {
    let n = exposures.len();
    // The reference's over this one's: a frame that let in half the light is twice the gain.
    let stops = |i: usize| match (exposures[i], exposures[reference]) {
        (Some(mine), Some(theirs)) if mine > 0.0 => theirs / mine,
        _ => 1.0,
    };

    let mut walked = vec![f64::NAN; n];
    walked[reference] = 1.0;
    let mut grew = true;
    while grew {
        grew = false;
        for (a, b, ratio) in measured.iter().copied() {
            if walked[a].is_nan() == walked[b].is_nan() || ratio <= 0.0 {
                continue;
            }
            match walked[a].is_nan() {
                true => walked[a] = walked[b] / ratio,
                false => walked[b] = walked[a] * ratio,
            }
            grew = true;
        }
    }

    (0..n)
        .map(|i| {
            let expected = stops(i);
            match walked[i].is_nan() {
                true => expected,
                false => {
                    let residual =
                        (walked[i] / expected).clamp(1.0 / RESIDUAL_CLAMP, RESIDUAL_CLAMP);
                    expected * residual
                }
            }
        })
        .collect()
}

/// How much light one frame's exposure let through, relative to any other's: the reciprocal of
/// what a meter did, so a frame stopped down by one reads half.
///
/// None where a header does not say, which is every rendered source and some RAWs.
pub fn exposure_of(shutter: Option<f32>, aperture: Option<f32>, iso: Option<f32>) -> Option<f64> {
    let shutter = f64::from(shutter.filter(|v| *v > 0.0)?);
    let aperture = f64::from(aperture.filter(|v| *v > 0.0)?);
    let iso = f64::from(iso.filter(|v| *v > 0.0)?);
    Some(shutter * iso / (aperture * aperture))
}

/// How far a pair's own matches may sit from what the rest of the set says, before the pair is
/// taken to be about two frames that never overlapped.
///
/// A share of the frame rather than a count of the plane's pixels (`across`): about a tenth of a
/// percent of it, and a pair that is really an overlap lands inside a pixel or two of what its
/// neighbours say where a coincidence lands hundreds away. There is nothing in between to tune
/// against, which is what makes the share safe to carry between plane sizes.
const PAIR_APART: Share = Share::of(6, TUNED_ON);

/// How far a pair the corners vouched for may sit from the standing answer and still be believed.
///
/// **Sized to separate drift from a wrong instance, which are the only two things it can be.** A
/// growth that reached two frames down different chains puts them tens of pixels apart, where a
/// coincidence of a repeating scene is a whole frame step out - about 690px of an 800px plane on
/// the sets measured here, since neighbours overlap by about a third. This sits an order of
/// magnitude above the first and an order below the second, so it is not a bar anything is balanced
/// on. `PAIR_APART` still judges every pair the corners had no opinion about.
const DRIFTED: Share = Share::of(200, TUNED_ON);

/// How far below the best bridge on offer a candidate may be and still be judged against it.
///
/// **Narrow, because the contradictions are a tie-break and not evidence of their own.** The rank
/// below orders on seconds and then on fewest disputes, which says nothing about how much either
/// candidate saw - so everything this admits is competing on contradictions alone, and a window
/// wide enough to hold a pair a tenth the strength lets that pair win by having no enemies. It is
/// the true bridge that collects enemies: a frame the set has placed well is claimed by a false
/// pair from every other instance of whatever repeats.
///
/// Measured over both panoramas from both the RAW previews and the library's own grid tiles, all
/// four are correct from 1.1 to 2.0 and this sits at the middle of that. Below 1.1 the twenty-six
/// frame set loses a true bridge on the previews; at 2.5 it takes a false one on the tiles - a
/// 74-correspondence pair claiming a frame five along its own row, against a true 115 beside it.
const COMPARABLE_WITHIN: f64 = 1.5;

/// How well attested one pair is against another: how many correspondences survived its refine,
/// and where those are equal, how well the two frames correlated.
///
/// **Both, because either alone decides a coincidence at random.** A repeating scene produces a
/// false pair with as many correspondences as a true one - every frame of a pan matches its
/// neighbour's horizon about equally well - and the count alone then picks between them on nothing
/// but the order they were offered in. What separates them there is the correlation the coarse
/// search measured.
fn attested(a: &Pair, b: &Pair) -> std::cmp::Ordering {
    a.found.cmp(&b.found).then(a.score.total_cmp(&b.score))
}

/// Which of `offered` can be reconciled with each other, by their place in it, and the answer they
/// make.
///
/// Starts from the best attested pair, since that is the one least likely to be a coincidence, and
/// then in each round:
///
/// - measures every pair *between* sources already placed against what is now standing, and keeps
///   only those that agree. This is where a false pair dies: it says two frames sit where the rest
///   of the set says they cannot.
/// - then reaches one source not yet placed. **A pair reaching a new source is always satisfiable** -
///   three free angles against one displacement - so its own residual says nothing, and what decides
///   between the candidates is how the rest of what that frame sees answers to each.
///
/// `whole` is the same pairs carrying every correspondence they have, and is only what they are
/// ranked by: `offered` may be a thinned sample, which caps each pair at the same count and would
/// leave `attested` falling through to the correlation - the one thing here that does not separate a
/// true overlap from a coincidence.
fn grown(
    sizes: &[[usize; 2]],
    offered: &[Pair],
    whole: &[Pair],
    focal0: f64,
    held: Option<f64>,
) -> Option<(Vec<usize>, Solved)> {
    // **Every refit is anchored to the same focal, never to the last answer.** Re-basing the hold
    // on what came back last is a ratchet: ten percent of ten percent of ten percent, and after
    // four rounds the "held" focal is half as long again as the body said.
    let anchor = |answer: &Solved| match held {
        Some(_) => focal0,
        None => answer.focal,
    };
    let first = (0..offered.len()).max_by(|&a, &b| attested(&whole[a], &whole[b]))?;
    let strongest = &offered[first];
    let mut placed = vec![false; sizes.len()];
    placed[strongest.a] = true;
    placed[strongest.b] = true;
    let mut rests_on = vec![first];
    let mut kept = vec![strongest.clone()];
    let mut taken: Vec<(usize, usize)> = vec![(strongest.a, strongest.b)];
    let mut answer = fit(sizes, &kept, focal0, held, None)?;

    loop {
        // Everything between two placed sources, judged against the set as it stands.
        //
        // **Asked again every round, and only a pair that agrees is done with.** A pair is first
        // reachable the moment its second frame is placed, which is when the answer knows least
        // about that frame - so judging it once, there, throws away the correspondences that would
        // have corrected it. Measured on a two-row pan: the top row is sky and its frames chain to
        // each other weakly, so each was placed off its neighbour and its strong pair *down* to the
        // detailed row was then a few pixels out and rejected forever, leaving the row hanging off
        // the only pairs that could not hold it. Those pairs agree once the row below has settled.
        let bar = across(PAIR_APART, sizes);
        let drifted = across(DRIFTED, sizes);
        let mut confirmed = false;
        for (at, pair) in offered.iter().enumerate() {
            if taken.contains(&(pair.a, pair.b)) || !placed[pair.a] || !placed[pair.b] {
                continue;
            }
            let apart = middle(pair_errors(sizes, &answer.rotations, answer.focal, pair));
            // **A pair the corners vouched for is judged on whether it drifted, not on whether it
            // agrees.** The two frames either side of it were placed down different chains, and a
            // chain accumulates: measured on the twenty-six frame set from the library's own tiles,
            // the pair joining the seventh frame to the sixth reprojects 31.65px against a 2.97px
            // bar, and refusing it leaves the only constraint that could pull the two together out
            // of the fit - which is the seam. What the residual cannot say is whether that is drift
            // or a coincidence, and the corners already answered that question independently.
            let bar = match pair.vouched {
                true => drifted,
                false => bar,
            };
            if apart > bar {
                if std::env::var_os("PANO_TRACE").is_some() {
                    eprintln!(
                        "  confirm refuses {}-{} at {apart:.2}px, bar {bar:.2}px",
                        pair.a, pair.b,
                    );
                }
                continue;
            }
            taken.push((pair.a, pair.b));
            rests_on.push(at);
            kept.push(pair.clone());
            confirmed = true;
        }
        if confirmed {
            answer = fit(sizes, &kept, anchor(&answer), held, Some(&answer))?;
        }

        let mut reaching: Vec<usize> = (0..offered.len())
            .filter(|&at| {
                let pair = &offered[at];
                !taken.contains(&(pair.a, pair.b)) && (placed[pair.a] != placed[pair.b])
            })
            .collect();
        reaching.sort_by(|&a, &b| attested(&whole[b], &whole[a]));

        // **A bridge cannot be judged the way the pairs above are.** Those join two frames already
        // standing, so the answer they must agree with was fitted without them. A bridge is the
        // only thing touching its new frame, so it *decides* where that frame goes and then
        // reprojects perfectly through the rotation it chose - which makes a coincidence and a true
        // overlap indistinguishable by the pair's own residual.
        //
        // What tells them apart is the rest of what the new frame sees. Placed by a coincidence it
        // lands on top of some other frame of a repeating scene, and every real neighbour it has
        // then says otherwise; placed truly, they agree. So each candidate is stood up on its own -
        // Horn's rotation from its matches, no refit - and the one the most of the frame's other
        // correspondences second is the one that gets to place it.
        //
        // Not a veto, which is the trap: on a scene that repeats, a frame's *only* other pair to
        // the standing set is often the two-apart coincidence claiming to be one step, so asking
        // for no contradiction rejects the true bridge. A count survives that, since the true
        // placement is seconded by more than the false one and a frame with nothing to say for it
        // either way is still placed on its correlation.
        let apart = across(PAIR_APART, sizes);
        // **Disputes decide between candidates of comparable strength, and only those.** Which of two
        // plausible bridges to believe is what the contradictions are evidence about; whether to
        // take a bridge at all is what the correspondence count is evidence about, and a pair
        // materially weaker than the best on offer does not get to win by having no enemies.
        // Measured on two panoramas, ignoring that is the whole failure: a 177-correspondence
        // coincidence took a frame from a 1710-correspondence overlap on one, and a 39 from a 721 on
        // the other, each because nothing happened to argue with it.
        let strongest = reaching.first().map_or(0, |&at| whole[at].found) as f64;
        let comparable = std::env::var("PANO_COMPARABLE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(COMPARABLE_WITHIN);
        let mut best: Option<((usize, std::cmp::Reverse<usize>), usize, usize, usize)> = None;
        for &at in &reaching {
            if (whole[at].found as f64) * comparable < strongest {
                continue;
            }
            let pair = &offered[at];
            let fresh = match placed[pair.a] {
                true => pair.b,
                false => pair.a,
            };
            // At the focal the answer stands on, not the nominal one `seeded` starts from: this
            // rotation is about to be held to a reprojection tolerance.
            let relative = between(pair, sizes, Some(answer.focal));
            let mut standing = answer.rotations.clone();
            standing[fresh] = match placed[pair.a] {
                true => multiply(answer.rotations[pair.a], conjugate(relative)),
                false => multiply(answer.rotations[pair.b], relative),
            };
            let (mut seconded, mut disputing) = (0usize, 0usize);
            for other in offered.iter().filter(|other| {
                (other.a, other.b) != (pair.a, pair.b)
                    && (other.a == fresh || other.b == fresh)
                    && placed[other.a + other.b - fresh]
            }) {
                match middle(pair_errors(sizes, &standing, answer.focal, other)) <= apart {
                    true => seconded += 1,
                    false => disputing += 1,
                }
            }
            // **Fewest disputes, where nothing seconds anything.** The first bridge into a row
            // nothing has placed yet has no second opinion available - every frame over there is
            // reached exactly once - so every candidate scores nothing and the coincidence, which
            // correlates hardest, would take it.
            //
            // What is visible even then is that two candidates reaching the *same* frame contradict
            // each other, while the frame next to it is claimed by one pair and no other. So the
            // unambiguous frame is placed first, and by the time the contested one is reached it
            // has a neighbour standing to be judged against.
            let rank = (seconded, std::cmp::Reverse(disputing));
            // Strictly better, so a tie keeps the better attested: `reaching` is in that order.
            if best.is_none_or(|(most, _, _, _)| rank > most) {
                best = Some((rank, at, seconded, disputing));
            }
        }

        let Some((_, at, seconded, disputing)) = best else { break };
        if std::env::var_os("PANO_TRACE").is_some() {
            let pair = &offered[at];
            let over: Vec<String> = reaching
                .iter()
                .take(3)
                .map(|&other| {
                    let p = &offered[other];
                    format!("{}-{} ({})", p.a, p.b, whole[other].found)
                })
                .collect();
            eprintln!(
                "  bridge {}-{} ({}) seconded {} disputed {} of {} candidates; ranked {}",
                pair.a,
                pair.b,
                whole[at].found,
                seconded,
                disputing,
                reaching.len(),
                over.join(", ")
            );
        }
        let pair = &offered[at];
        taken.push((pair.a, pair.b));
        placed[pair.a] = true;
        placed[pair.b] = true;
        rests_on.push(at);
        kept.push(pair.clone());
        // Cold, alone among the fits here: this one has just brought in a frame the standing answer
        // holds no rotation for, so a warm start would begin it at the identity where `seeded` puts
        // it where the new pair says. The confirmation above adds no frame and so keeps its start.
        answer = fit(sizes, &kept, anchor(&answer), held, None)?;
    }
    Some((rests_on, answer))
}

/// What one pair's matches reproject to, one per match, in the plane's own pixels.
fn pair_errors(
    sizes: &[[usize; 2]],
    rotations: &[[f64; 4]],
    focal: f64,
    pair: &Pair,
) -> Vec<f64> {
    pair.matches
        .iter()
        .filter_map(|m| reprojection(sizes, rotations, focal, pair.a, pair.b, m))
        .collect()
}

/// The middle of a set of measurements, and zero for none: a median, since what it is asked about
/// is a population half of which may be nonsense.
fn middle(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

/// The same pair with its correspondences strided down to `GROWING_MATCHES`.
///
/// Strided rather than taken from the front: the refine walks the frame in raster order, so a prefix
/// is the top of the picture and every rotation it states would be about that band alone.
fn thinned(pair: &Pair) -> Pair {
    let step = pair.matches.len().div_ceil(GROWING_MATCHES).max(1);
    Pair {
        a: pair.a,
        b: pair.b,
        score: pair.score,
        matches: pair.matches.iter().step_by(step).copied().collect(),
        found: pair.found,
        vouched: pair.vouched,
    }
}

/// How many of a pair's correspondences the growth is decided on.
///
/// Enough that a median over them is steady and a rotation from them is good to well under the
/// pixel the growth judges at, and far below what a pair actually has: the final fit reads every
/// one, so this buys the search's speed and costs the answer nothing.
const GROWING_MATCHES: usize = 120;

/// Below this a pair states a direction rather than a rotation, and cannot be leant on.
const FITTABLE: usize = 8;

fn enough(pair: &Pair) -> bool {
    pair.matches.len() >= FITTABLE
}

/// Below this a pair no longer says the two frames overlap at all.
///
/// **Far under [`FITTABLE`], because the two questions are different.** What a rotation may be
/// derived from is one bar; whether a frame is joined to the set is another, and answering the
/// second with the first throws away frames the growth placed and verified. The outlier rounds thin
/// a pair against a tolerance that is a share of the plane, so the same true overlap keeps a
/// quarter as many correspondences on a grid tile as on a preview twice the size: measured on the
/// twelve frame set from the library's own tiles, the pair holding its last two frames came out of
/// those rounds with seven, one short, and both frames left the recipe as unreachable. Three is
/// what fixes a mapping rather than a direction, and a pair below it has nothing left to say.
const ATTESTING: usize = 3;

/// Which sources the first one can be reached from, pair by pair. A set that took two panoramas
/// arrives as two islands, and only the one holding the first source can be solved together.
fn reachable(n: usize, pairs: &[Pair], least: usize) -> Vec<bool> {
    let mut placed = vec![false; n];
    placed[0] = true;
    let mut grew = true;
    while grew {
        grew = false;
        for pair in pairs.iter().filter(|p| p.matches.len() >= least) {
            if placed[pair.a] != placed[pair.b] {
                placed[pair.a] = true;
                placed[pair.b] = true;
                grew = true;
            }
        }
    }
    placed
}

/// One solve over the matches as they stand: a start, then Levenberg-Marquardt over every rotation
/// but the root's, and the focal.
///
/// `from` is where to start, for a caller that already has an answer to the almost-identical problem
/// - the same set with one more pair on it, or with its outliers gone. A spanning tree at a nominal
/// focal, which is the alternative, is a dozen iterations away from what such a caller is holding,
/// and the growth alone solves this thirty times over.
fn fit(
    sizes: &[[usize; 2]],
    pairs: &[Pair],
    focal0: f64,
    held: Option<f64>,
    from: Option<&Solved>,
) -> Option<Solved> {
    let n = sizes.len();
    let mut rotations = match from {
        Some(standing) => standing.rotations.clone(),
        None => seeded(sizes, pairs)?,
    };
    // On the log, so the bound is the same fraction either way.
    let reach = held.map_or(f64::INFINITY, |fraction| (1.0 + fraction).ln());
    let mut log_focal =
        from.map_or(0.0f64, |standing| (standing.focal / focal0).ln().clamp(-reach, reach));
    let focal_of = move |t: f64| focal0 * t.clamp(-reach, reach).exp();

    let free = 3 * (n - 1) + 1;
    let mut lambda = 1e-3;
    let mut residual = residuals(sizes, &rotations, focal_of(log_focal), pairs);
    if residual.is_empty() {
        return None;
    }
    let knee = across(HUBER, sizes);
    let mut cost = weighted_cost(&residual, knee);
    // What the focal does when the log moves, which at the hold's own edge is nothing: a step
    // outward is clamped straight back, so the answer there does not depend on it.
    let slope = |t: f64| match t.abs() < reach {
        true => focal_of(t),
        false => 0.0,
    };

    for _ in 0..ITERATIONS {
        let weights: Vec<f64> = residual.iter().map(|r| huber_weight(*r, knee).sqrt()).collect();
        let jacobian =
            derivatives(sizes, &rotations, focal_of(log_focal), slope(log_focal), pairs, free, &weights);

        let mut normal = vec![0.0; free * free];
        let mut rhs = vec![0.0; free];
        for (row, slope) in jacobian.iter().enumerate() {
            let weighted = weights[row] * residual[row];
            for i in 0..slope.used {
                let (column, by) = (slope.at[i], slope.by[i]);
                rhs[column] -= by * weighted;
                for j in i..slope.used {
                    // Into the upper triangle whichever way round the two columns came: a row holds
                    // the second frame's angles before the first's where the pair runs backwards.
                    let (down, across) = match column <= slope.at[j] {
                        true => (column, slope.at[j]),
                        false => (slope.at[j], column),
                    };
                    normal[down * free + across] += by * slope.by[j];
                }
            }
        }
        for i in 0..free {
            for j in 0..i {
                normal[i * free + j] = normal[j * free + i];
            }
        }

        let mut taken = false;
        for _ in 0..6 {
            let mut damped = normal.clone();
            for i in 0..free {
                damped[i * free + i] *= 1.0 + lambda;
                damped[i * free + i] += lambda * 1e-9;
            }
            let Some(step) = crate::fit::gaussian(&damped, &rhs, free) else {
                lambda *= 10.0;
                continue;
            };
            let (moved, focal) = applied(&rotations, log_focal, &step, focal_of);
            let there = residuals(sizes, &moved, focal, pairs);
            let there_cost = weighted_cost(&there, knee);
            if there_cost < cost {
                rotations = moved;
                // Clamped as it is accumulated, not only where it is read, or the step keeps
                // growing a number the focal no longer follows and the loop stops converging.
                log_focal = (log_focal + step[free - 1]).clamp(-reach, reach);
                residual = there;
                cost = there_cost;
                lambda = (lambda / 3.0).max(1e-9);
                taken = true;
                break;
            }
            lambda *= 10.0;
        }
        if !taken || lambda > 1e9 {
            break;
        }
    }

    let squares: f64 = residual.iter().map(|r| r * r).sum();
    let rms_px = (squares / (residual.len() as f64 / 2.0)).sqrt();
    Some(Solved {
        scales: vec![1.0; rotations.len()],
        rotations,
        focal: focal_of(log_focal),
        rms_px,
        dropped: Vec::new(),
        kept: Vec::new(),
        radial_px: 0.0,
    })
}

/// How far a single frame's scale may move from the set's shared focal, either way.
///
/// A lens breathing over a burst's focus travel is a percent or two, and a hand that moved along
/// the axis by a hand's width at three metres is another. Five percent covers both with room; past
/// it the frames are not a burst and §3.1's own refusal is the thing that should be speaking.
///
/// A *ratio between two focals* and so no plane's pixels at all - not a `Share`, which is a
/// fraction of a picture's long edge, and not an `Extent`, which is a distance on one.
const SCALE_LEASH: f64 = 0.05;

/// The scale steps tried per source, which is a bisection over [`SCALE_LEASH`].
const SCALE_ROUNDS: usize = 12;

/// Fit one scale per source on top of a solved set, holding the rotations and the shared focal.
///
/// **For a burst, not for a pan**, and the caller is what knows which it has: a pan's frames
/// overlap in a strip and a per-frame scale there is a parameter the matches cannot see, which is
/// the whole argument behind one shared focal. A burst's frames sit on top of one another, and the
/// scale between two of them is as well observed as their rotation.
///
/// Golden section per source over the matches that source appears in, rotations held: for frames
/// this close to each other a scale and a rotation are nearly orthogonal, so one pass each is worth
/// the same as alternating and costs a twelfth as much.
pub fn scale_each(sizes: &[[usize; 2]], pairs: &[Pair], solved: &mut Solved) {
    let knee = across(HUBER, sizes);
    for source in 0..solved.rotations.len() {
        if solved.dropped.contains(&source) {
            continue;
        }
        let involved: Vec<&Pair> =
            pairs.iter().filter(|p| p.a == source || p.b == source).collect();
        if involved.is_empty() {
            continue;
        }
        let cost = |scale: f64| -> f64 {
            let mut scales = solved.scales.clone();
            scales[source] = scale;
            let residuals: Vec<f64> = involved
                .iter()
                .flat_map(|pair| {
                    pair.matches.iter().filter_map(|m| {
                        scaled_reprojection(
                            sizes,
                            &solved.rotations,
                            solved.focal,
                            &scales,
                            pair.a,
                            pair.b,
                            m,
                        )
                    })
                })
                .collect();
            match residuals.is_empty() {
                true => f64::MAX,
                false => weighted_cost(&residuals, knee) / residuals.len() as f64,
            }
        };
        // Golden section over the leash, which is a bracket this cannot leave: a scale the matches
        // do not constrain sits wherever it started, which is one.
        let phi = 0.5 * (5.0f64.sqrt() - 1.0);
        let (mut low, mut high) = (1.0 - SCALE_LEASH, 1.0 + SCALE_LEASH);
        let (mut c, mut d) = (high - phi * (high - low), low + phi * (high - low));
        let (mut fc, mut fd) = (cost(c), cost(d));
        for _ in 0..SCALE_ROUNDS {
            if fc < fd {
                high = d;
                d = c;
                fd = fc;
                c = high - phi * (high - low);
                fc = cost(c);
            } else {
                low = c;
                c = d;
                fc = fd;
                d = low + phi * (high - low);
                fd = cost(d);
            }
        }
        let best = 0.5 * (low + high);
        // Only where it actually helps: a frame whose matches say nothing about its scale would
        // otherwise take whatever the bracket's middle happened to be.
        if cost(best) < cost(1.0) {
            solved.scales[source] = best;
        }
    }
    solved.radial_px = radial_of(sizes, pairs, solved);
}

/// §3.1's corner reading, re-measured through the scales this stage just fitted.
///
/// **`solve` writes `radial_px` before any of them exist**, from reprojections against the one
/// shared focal, and a scale difference is radial by nature - it displaces a corner and leaves the
/// middle alone, which is exactly what that statistic is built to see. Left as the solve wrote it,
/// the number §3.1 refuses a burst by would describe geometry the composition does not have: a set
/// whose only fault was a breathing lens would read as not-near-identity after the very step that
/// corrected it, and one corrected *into* trouble would not read as anything at all.
///
/// The same two medians `solve` takes, over the same matches, differing only in the projection.
fn radial_of(sizes: &[[usize; 2]], pairs: &[Pair], solved: &Solved) -> f64 {
    let (mut outer, mut every): (Vec<f64>, Vec<f64>) = (Vec::new(), Vec::new());
    for pair in pairs {
        if solved.dropped.contains(&pair.a) || solved.dropped.contains(&pair.b) {
            continue;
        }
        for m in &pair.matches {
            let Some(off) = scaled_reprojection(
                sizes,
                &solved.rotations,
                solved.focal,
                &solved.scales,
                pair.a,
                pair.b,
                m,
            ) else {
                continue;
            };
            every.push(off);
            if in_the_outer_fifth(&sizes[pair.a], m.a) || in_the_outer_fifth(&sizes[pair.b], m.b) {
                outer.push(off);
            }
        }
    }
    middle(outer) - middle(every)
}

/// [`reprojection`] with a focal per source rather than one for the set.
fn scaled_reprojection(
    sizes: &[[usize; 2]],
    rotations: &[[f64; 4]],
    focal: f64,
    scales: &[f64],
    a: usize,
    b: usize,
    m: &Match,
) -> Option<f64> {
    let there = scaled_projected(sizes, rotations, focal, scales, a, b, m.a)?;
    let back = scaled_projected(sizes, rotations, focal, scales, b, a, m.b)?;
    let one = (there[0] - m.b[0]).hypot(there[1] - m.b[1]);
    let other = (back[0] - m.a[0]).hypot(back[1] - m.a[1]);
    Some(one.max(other))
}

fn scaled_projected(
    sizes: &[[usize; 2]],
    rotations: &[[f64; 4]],
    focal: f64,
    scales: &[f64],
    from: usize,
    to: usize,
    at: [f64; 2],
) -> Option<[f64; 2]> {
    let (fx, fy) = (sizes[from][0] as f64 / 2.0, sizes[from][1] as f64 / 2.0);
    let out = focal * scales[from];
    let world = rotate(rotations[from], [(at[0] - fx) / out, (at[1] - fy) / out, 1.0]);
    let d = rotate(conjugate(rotations[to]), world);
    if d[2] <= 1e-9 {
        return None;
    }
    let (tx, ty) = (sizes[to][0] as f64 / 2.0, sizes[to][1] as f64 / 2.0);
    let back = focal * scales[to];
    Some([tx + back * d[0] / d[2], ty + back * d[1] / d[2]])
}

/// Rotations from a spanning tree, best-scoring pair first, so the solve starts inside its own
/// basin rather than at the identity for every frame.
///
/// **Rooted wherever the pairs reach, not at source zero.** The set is grown from the best attested
/// pair, which need not touch the first photograph at all - and a seed that
/// insisted on it would refuse every set whose strongest pair is in the middle of the pan. A
/// source no pair here mentions keeps the identity and is unconstrained, which is what the
/// damping on the normal matrix is for.
fn seeded(sizes: &[[usize; 2]], pairs: &[Pair]) -> Option<Vec<[f64; 4]>> {
    let n = sizes.len();
    let mut order: Vec<&Pair> = pairs.iter().filter(|p| enough(p)).collect();
    order.sort_by(|a, b| b.score.total_cmp(&a.score));

    let mut rotations = vec![[1.0, 0.0, 0.0, 0.0]; n];
    let mut placed = vec![false; n];
    placed[order.first()?.a] = true;
    let mut grew = true;
    while grew {
        grew = false;
        for pair in &order {
            let relative = between(pair, sizes, None);
            match (placed[pair.a], placed[pair.b]) {
                // `relative` takes a ray of a's camera into b's, so b's own rotation undoes it.
                (true, false) => {
                    rotations[pair.b] = multiply(rotations[pair.a], conjugate(relative));
                    placed[pair.b] = true;
                    grew = true;
                }
                (false, true) => {
                    rotations[pair.a] = multiply(rotations[pair.b], relative);
                    placed[pair.a] = true;
                    grew = true;
                }
                _ => {}
            }
        }
    }
    Some(rotations)
}

/// The rotation carrying a ray of `pair.a`'s camera into `pair.b`'s, by Horn's absolute
/// orientation over the pair's own matches.
///
/// **From each frame's own centre**, which is what makes these rays rather than corner offsets: a
/// pixel is a direction only once the principal point is taken off it, and a set measured from the
/// corner points into one octant, where the rotation between two such sets is a number about the
/// framing rather than about the camera.
///
/// `focal` is what the rays are built at, or each frame's long edge where nothing has solved one
/// yet: a wrong focal tilts the two sets by the same amount, which a rotation *between* them barely
/// feels, and the solve refines it. What that nominal will not carry is a rotation being held to a
/// reprojection tolerance - fifteen percent of focal is several pixels at the frame's edge, which is
/// past what a pair is asked to agree within - so a caller measuring against one passes it.
fn between(pair: &Pair, sizes: &[[usize; 2]], focal: Option<f64>) -> [f64; 4] {
    let from = |i: usize, at: [f64; 2]| {
        let (cx, cy) = (sizes[i][0] as f64 / 2.0, sizes[i][1] as f64 / 2.0);
        let nominal = || sizes[i][0].max(sizes[i][1]) as f64;
        normalised([at[0] - cx, at[1] - cy, focal.unwrap_or_else(nominal)])
    };
    let centre = |m: &Match| (from(pair.a, m.a), from(pair.b, m.b));
    let mut m = [[0.0f64; 3]; 3];
    for (u, v) in pair.matches.iter().map(centre) {
        for (r, row) in m.iter_mut().enumerate() {
            for (c, cell) in row.iter_mut().enumerate() {
                *cell += v[r] * u[c];
            }
        }
    }
    largest_quaternion(&m)
}

/// One parameter moved by hand, which is how the derivatives above are checked.
#[cfg(test)]
fn nudged(
    rotations: &[[f64; 4]],
    log_focal: f64,
    k: usize,
    step: f64,
    focal_of: impl Fn(f64) -> f64,
) -> (Vec<[f64; 4]>, f64) {
    let mut delta = vec![0.0; 3 * (rotations.len() - 1) + 1];
    delta[k] = step;
    applied(rotations, log_focal, &delta, focal_of)
}

fn applied(
    rotations: &[[f64; 4]],
    log_focal: f64,
    delta: &[f64],
    focal_of: impl Fn(f64) -> f64,
) -> (Vec<[f64; 4]>, f64) {
    let mut moved = rotations.to_vec();
    for (i, slot) in moved.iter_mut().enumerate().skip(1) {
        let at = (i - 1) * 3;
        let turn = from_axis_angle([delta[at], delta[at + 1], delta[at + 2]]);
        *slot = normalise(multiply(turn, *slot));
    }
    (moved, focal_of(log_focal + delta[delta.len() - 1]))
}

/// The weighted Jacobian, one row per residual component, in `residuals`' own order.
///
/// Source zero holds still - the world frame is somebody's - so its three columns are not there
/// and an observation touching it contributes to the other end alone.
fn derivatives(
    sizes: &[[usize; 2]],
    rotations: &[[f64; 4]],
    focal: f64,
    slope: f64,
    pairs: &[Pair],
    free: usize,
    weights: &[f64],
) -> Vec<Slope> {
    let mut out = vec![Slope::NONE; weights.len()];
    let mut row = 0;
    for pair in pairs {
        for m in &pair.matches {
            for (from, to, at) in [(pair.a, pair.b, m.a), (pair.b, pair.a, m.b)] {
                let moves = moved_by(sizes, rotations, focal, slope, from, to, at);
                if let Some(moves) = moves {
                    for component in 0..2 {
                        let weight = weights[row + component];
                        let into = &mut out[row + component];
                        for (frame, by) in [(from, moves.from), (to, moves.to)] {
                            if frame > 0 {
                                for axis in 0..3 {
                                    into.put((frame - 1) * 3 + axis, weight * by[component][axis]);
                                }
                            }
                        }
                        into.put(free - 1, weight * moves.focal[component]);
                    }
                }
                // Behind the other camera, `residuals` pushes a constant, which moves with nothing.
                row += 2;
            }
        }
    }
    out
}

/// One residual's derivatives, by the parameters it actually has.
///
/// **A correspondence moves the two frames it joins and the focal, and nothing else.** That is seven
/// numbers of the seventy-nine a twenty-six frame set carries, and of the several hundred a large
/// one would - so a dense row is almost all zeros, and holding one per residual is both the memory a
/// fit spends and most of the arithmetic, since every zero still gets multiplied by its neighbours
/// on the way into the normal matrix. Measured on a twenty-six frame pan: 416k residuals at 79
/// columns is 263MB built, cleared and read again on every iteration of every fit.
#[derive(Clone, Copy)]
struct Slope {
    at: [usize; 7],
    by: [f64; 7],
    used: usize,
}

impl Slope {
    const NONE: Slope = Slope { at: [0; 7], by: [0.0; 7], used: 0 };

    fn put(&mut self, at: usize, by: f64) {
        self.at[self.used] = at;
        self.by[self.used] = by;
        self.used += 1;
    }

    /// This row's derivative by parameter `k`, which for one it does not touch is zero - the answer
    /// the dense row gave, for a reader that wants a column rather than a row.
    #[cfg(test)]
    fn by_parameter(&self, k: usize) -> f64 {
        (0..self.used).find(|&i| self.at[i] == k).map_or(0.0, |i| self.by[i])
    }
}

/// The rotation a quaternion stands for, as the matrix `rotate` applies: column `c` is where the
/// `c`th basis vector lands.
fn matrix(q: [f64; 4]) -> [[f64; 3]; 3] {
    let x = rotate(q, [1.0, 0.0, 0.0]);
    let y = rotate(q, [0.0, 1.0, 0.0]);
    let z = rotate(q, [0.0, 0.0, 1.0]);
    [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]]
}

/// `mᵀ v`, which for a rotation is the rotation run backwards.
fn back(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
        m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
        m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
    ]
}

/// One directed observation's two residual components and how they move, written out rather than
/// measured.
///
/// **The whole reason this exists.** A finite-differenced Jacobian nudges each parameter in turn
/// and reprojects every match to see what happened, so an iteration costs `3(n-1)+2` passes over
/// the correspondences - twenty of them at seven frames, and more as a panorama grows. Every one
/// of those derivatives has a closed form, and they all fall out of the same projection the
/// residual does, so this is one pass.
///
/// The parameterisation is `applied`'s: a source turns by `exp([w]x)` on the *left*, in world
/// coordinates, so `d(R v)/dw = -[R v]x`. The focal is the log, and it enters twice - once
/// unprojecting out of `from` and once projecting into `to` - which is what the last term is.
struct Moves {
    /// How the two components move with the turn of the source the point came from.
    from: [[f64; 3]; 2],
    /// And of the one it lands in, which is this negated: the same world vector, undone.
    to: [[f64; 3]; 2],
    /// And with the log focal.
    focal: [f64; 2],
}

fn moved_by(
    sizes: &[[usize; 2]],
    rotations: &[[f64; 4]],
    focal: f64,
    focal_slope: f64,
    from: usize,
    to: usize,
    at: [f64; 2],
) -> Option<Moves> {
    let (fx, fy) = (sizes[from][0] as f64 / 2.0, sizes[from][1] as f64 / 2.0);
    let u = [(at[0] - fx) / focal, (at[1] - fy) / focal, 1.0];
    let m_to = matrix(rotations[to]);
    let world = rotate(rotations[from], u);
    let d = back(&m_to, world);
    if d[2] <= 1e-9 {
        return None;
    }
    // The perspective divide's own derivative, which every term below goes through.
    let over = focal / d[2];
    let by_d = |v: [f64; 3]| [over * (v[0] - d[0] / d[2] * v[2]), over * (v[1] - d[1] / d[2] * v[2])];

    // A turn of either source moves the world vector by `w x world`, seen from `to`.
    let turned = |axis: usize| {
        let mut e = [0.0; 3];
        e[axis] = 1.0;
        back(&m_to, cross(world, e))
    };
    let (mut from_rows, mut to_rows) = ([[0.0; 3]; 2], [[0.0; 3]; 2]);
    for axis in 0..3 {
        let moved = by_d(turned(axis));
        for row in 0..2 {
            // `from` turns the vector one way and `to` undoes it the other, which is the same
            // number with the sign flipped rather than a second derivative to get wrong.
            from_rows[row][axis] = -moved[row];
            to_rows[row][axis] = moved[row];
        }
    }

    // Out of `from` the focal divides and into `to` it multiplies, so it moves the answer twice.
    // Unprojecting, `u` goes as `1/f`, which is where the `slope / focal` comes from; projecting,
    // the focal stands in front of the divide and contributes its own slope.
    let du = [-u[0], -u[1], 0.0];
    let through = by_d(back(&m_to, rotate(rotations[from], du)));
    let ratio = focal_slope / focal;
    let focal_moves = [
        ratio * through[0] + focal_slope * d[0] / d[2],
        ratio * through[1] + focal_slope * d[1] / d[2],
    ];

    Some(Moves { from: from_rows, to: to_rows, focal: focal_moves })
}

/// Every match reprojected both ways, as pixel components.
fn residuals(
    sizes: &[[usize; 2]],
    rotations: &[[f64; 4]],
    focal: f64,
    pairs: &[Pair],
) -> Vec<f64> {
    let mut out = Vec::new();
    for pair in pairs {
        for m in &pair.matches {
            for (from, to, at, expected) in [
                (pair.a, pair.b, m.a, m.b),
                (pair.b, pair.a, m.b, m.a),
            ] {
                match projected(sizes, rotations, focal, from, to, at) {
                    Some(p) => {
                        out.push(p[0] - expected[0]);
                        out.push(p[1] - expected[1]);
                    }
                    // Behind the other camera: a residual the solve can feel, not an infinity.
                    None => {
                        let far = across(OUTLIER, sizes) * 10.0;
                        out.push(far);
                        out.push(far);
                    }
                }
            }
        }
    }
    out
}

/// Where a point of `from` lands in `to`.
fn projected(
    sizes: &[[usize; 2]],
    rotations: &[[f64; 4]],
    focal: f64,
    from: usize,
    to: usize,
    at: [f64; 2],
) -> Option<[f64; 2]> {
    let (fx, fy) = (sizes[from][0] as f64 / 2.0, sizes[from][1] as f64 / 2.0);
    let world = rotate(rotations[from], [(at[0] - fx) / focal, (at[1] - fy) / focal, 1.0]);
    let d = rotate(conjugate(rotations[to]), world);
    if d[2] <= 1e-9 {
        return None;
    }
    let (tx, ty) = (sizes[to][0] as f64 / 2.0, sizes[to][1] as f64 / 2.0);
    Some([tx + focal * d[0] / d[2], ty + focal * d[1] / d[2]])
}

/// How far a match misses, in pixels, the worse of its two directions.
fn reprojection(
    sizes: &[[usize; 2]],
    rotations: &[[f64; 4]],
    focal: f64,
    a: usize,
    b: usize,
    m: &Match,
) -> Option<f64> {
    let there = projected(sizes, rotations, focal, a, b, m.a)?;
    let back = projected(sizes, rotations, focal, b, a, m.b)?;
    let one = (there[0] - m.b[0]).hypot(there[1] - m.b[1]);
    let other = (back[0] - m.a[0]).hypot(back[1] - m.a[1]);
    Some(one.max(other))
}

fn huber_weight(residual: f64, knee: f64) -> f64 {
    let size = residual.abs();
    if size <= knee { 1.0 } else { knee / size }
}

fn weighted_cost(residuals: &[f64], knee: f64) -> f64 {
    residuals
        .iter()
        .map(|r| {
            let size = r.abs();
            if size <= knee { r * r } else { knee * (2.0 * size - knee) }
        })
        .sum()
}

/// Level the panorama and point the reference down the canvas's own axis.
///
/// The vertical is the direction a family of the cameras' own axes least agrees with - the
/// smallest eigenvector of their scatter - and *which* family is the whole question:
///
/// - **Where the frames look.** A pan is a turn, and what it turned about is the direction its
///   centre rays never point along. A camera's roll does not move where it is pointing, so this
///   reading is blind to the one error a hand-held pan actually has - and roll is precisely what
///   tilts a horizon.
/// - **The cameras' horizontals**, which is Brown and Lowe's: a person holds a camera level, so
///   the vertical is what their X axes least agree with. It is the reading that survives a
///   photographer who drifts up or down across a pan - and it is corrupted by their roll, which
///   they have, so on a five-frame pan it left a degree and a half of visible tilt.
///
/// So the rays are asked first, and the horizontals answer only where the frames did not turn
/// enough to say anything: a pan of a few degrees has an axis its own noise could move, and there
/// is little tilt to fix in one either way.
///
/// **And where neither family spreads, the reference's own vertical is taken.** A burst turns a few
/// tenths of a milliradian, so both scatters are rank one and the smallest eigenvector of one of
/// those is whichever perpendicular the eigensolve happened to land on - measured on a two-frame
/// hand-held burst, that levelled both frames 58 degrees off their own horizon and framed a canvas
/// 16195x5134 for two frames that overlap almost entirely.
fn straighten(rotations: &mut [[f64; 4]]) {
    let scattered = |axis: [f64; 3]| {
        let mut m = [[0.0f64; 3]; 3];
        for q in rotations.iter() {
            let v = rotate(*q, axis);
            for (r, row) in m.iter_mut().enumerate() {
                for (c, cell) in row.iter_mut().enumerate() {
                    *cell += v[r] * v[c];
                }
            }
        }
        m
    };
    let looking = scattered([0.0, 0.0, 1.0]);
    let sideways = scattered([1.0, 0.0, 0.0]);
    let down = rotate(rotations[0], [0.0, 1.0, 0.0]);
    let mut up = if turned_enough(&looking) {
        smallest_eigenvector(&looking)
    } else if turned_enough(&sideways) {
        smallest_eigenvector(&sideways)
    } else {
        down
    };
    if dot(up, down) < 0.0 {
        up = [-up[0], -up[1], -up[2]];
    }

    let level = between_vectors(up, [0.0, 1.0, 0.0]);
    let forward = rotate(multiply(level, rotations[0]), [0.0, 0.0, 1.0]);
    let yaw = from_axis_angle([0.0, -forward[0].atan2(forward[2]), 0.0]);
    let global = multiply(yaw, level);
    for q in rotations.iter_mut() {
        *q = normalise(multiply(global, *q));
    }
}

/// The rotation taking `from` onto `to`, both unit.
fn between_vectors(from: [f64; 3], to: [f64; 3]) -> [f64; 4] {
    let axis = cross(from, to);
    let length = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    if length < 1e-12 {
        return [1.0, 0.0, 0.0, 0.0];
    }
    let angle = length.atan2(dot(from, to));
    from_axis_angle([
        axis[0] / length * angle,
        axis[1] / length * angle,
        axis[2] / length * angle,
    ])
}

/// Whether a scatter of directions spreads enough for the direction it *least* agrees with to mean
/// anything.
///
/// A pan of `A` either side of its middle leaves about `A^2/3` of its rays' weight across the
/// turn, so the threshold is a ten-degree pan - below that the axis is as much the wander as the
/// turn. Measured as the second eigenvalue against the first, which for a symmetric matrix is the
/// trace and the sum of the 2x2 principal minors away from the characteristic polynomial - so no
/// second eigensolve is needed to ask.
fn turned_enough(m: &[[f64; 3]; 3]) -> bool {
    /// `A^2/3` for a pan reaching ten degrees either side of its middle.
    const SPREAD: f64 = 0.01;

    let trace = m[0][0] + m[1][1] + m[2][2];
    if trace < 1e-12 {
        return false;
    }
    // The scatter of unit vectors has trace `n`, and its smallest eigenvalue is the axis's own -
    // near zero for any set that turned at all. What is left between them is the spread across the
    // turn, which is what this is about, so the middle eigenvalue is read as the trace less the
    // largest and the smallest.
    let largest = largest_eigenvalue(m);
    let smallest = {
        let axis = smallest_eigenvector(m);
        dot(axis, [dot(m[0], axis), dot(m[1], axis), dot(m[2], axis)])
    };
    let middle = trace - largest - smallest;
    middle > SPREAD * largest
}

/// The largest eigenvalue of a symmetric 3x3, by power iteration - the same tool
/// `smallest_eigenvector` uses, without the shift that turns it around.
fn largest_eigenvalue(m: &[[f64; 3]; 3]) -> f64 {
    let mut v = [0.577_350_269_189_625_7, 0.577_350_269_189_625_7, 0.577_350_269_189_625_7];
    for _ in 0..200 {
        let next = [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
        let length = (next[0] * next[0] + next[1] * next[1] + next[2] * next[2]).sqrt();
        if length < 1e-12 {
            return 0.0;
        }
        v = [next[0] / length, next[1] / length, next[2] / length];
    }
    dot(v, [dot(m[0], v), dot(m[1], v), dot(m[2], v)])
}

/// **Inverse iteration, not the matrix turned inside out.** Iterating on `trace*I - m` looks like
/// the same thing and is not: it separates the two eigenvalues that matter by `l2 - l3`, which
/// against a trace they are both tiny beside is nothing at all. On the scatter of a pan's rays -
/// one direction they nearly all share, one they spread along, one they never take - that is a
/// ratio of 0.985 a step, so two hundred steps still leave a twentieth of the wrong direction in
/// the answer, and levelling by it half-worked in a way that read as the levelling being wrong
/// rather than the solver.
///
/// `m^-1` has the same eigenvectors with the order reversed, so the same iteration converges at
/// `l3 / l2` instead - seven parts in a thousand a step on that same pan. A ridge keeps a scatter
/// that is genuinely flat invertible, and the shifted form is what answers if it is singular even
/// so.
fn smallest_eigenvector(m: &[[f64; 3]; 3]) -> [f64; 3] {
    let trace = m[0][0] + m[1][1] + m[2][2];
    let ridge = 1e-12 * trace.max(1e-12);
    let ridged = [
        [m[0][0] + ridge, m[0][1], m[0][2]],
        [m[1][0], m[1][1] + ridge, m[1][2]],
        [m[2][0], m[2][1], m[2][2] + ridge],
    ];
    let Some(inverse) = inverted(&ridged) else { return furthest_from(m, trace) };
    let mut v = [0.577_350_269_189_625_7, 0.577_350_269_189_625_7, 0.577_350_269_189_625_7];
    for _ in 0..64 {
        let next = [dot(inverse[0], v), dot(inverse[1], v), dot(inverse[2], v)];
        let length = (next[0] * next[0] + next[1] * next[1] + next[2] * next[2]).sqrt();
        if length < 1e-12 {
            return [0.0, 1.0, 0.0];
        }
        v = [next[0] / length, next[1] / length, next[2] / length];
    }
    v
}

/// The inverse of a symmetric 3x3 by its adjugate, or none where it is singular.
fn inverted(m: &[[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let cofactor = |r: usize, c: usize| {
        let (r0, r1) = ((r + 1) % 3, (r + 2) % 3);
        let (c0, c1) = ((c + 1) % 3, (c + 2) % 3);
        m[r0][c0] * m[r1][c1] - m[r0][c1] * m[r1][c0]
    };
    let determinant = m[0][0] * cofactor(0, 0) + m[0][1] * cofactor(0, 1) + m[0][2] * cofactor(0, 2);
    // Against the matrix's own scale: a scatter of unit vectors has a trace of however many there
    // are, and its determinant is the product of three eigenvalues of that size.
    let scale = (m[0][0] + m[1][1] + m[2][2]) / 3.0;
    if determinant.abs() < 1e-18 * (scale * scale * scale).abs().max(1e-18) {
        return None;
    }
    // Symmetric, so the adjugate is its own transpose and the cofactors go straight in.
    let mut inverse = [[0.0f64; 3]; 3];
    for (r, row) in inverse.iter_mut().enumerate() {
        for (c, cell) in row.iter_mut().enumerate() {
            *cell = cofactor(c, r) / determinant;
        }
    }
    Some(inverse)
}

/// The fallback for a scatter with no inverse: the shifted iteration, which is exact where the
/// matrix is singular because there the direction wanted is a null one.
fn furthest_from(m: &[[f64; 3]; 3], trace: f64) -> [f64; 3] {
    let mut flipped = [[0.0f64; 3]; 3];
    for r in 0..3 {
        for c in 0..3 {
            flipped[r][c] = if r == c { trace - m[r][c] } else { -m[r][c] };
        }
    }
    let mut v = [0.577_350_269_189_625_7, 0.577_350_269_189_625_7, 0.577_350_269_189_625_7];
    for _ in 0..200 {
        let next = [dot(flipped[0], v), dot(flipped[1], v), dot(flipped[2], v)];
        let length = (next[0] * next[0] + next[1] * next[1] + next[2] * next[2]).sqrt();
        if length < 1e-12 {
            return [0.0, 1.0, 0.0];
        }
        v = [next[0] / length, next[1] / length, next[2] / length];
    }
    v
}

/// The rotation whose matrix best matches the correlation `m`, as a quaternion: Horn's method,
/// with the eigenvector taken by power iteration on a shifted 4x4.
fn largest_quaternion(m: &[[f64; 3]; 3]) -> [f64; 4] {
    let n = [
        [
            m[0][0] + m[1][1] + m[2][2],
            m[2][1] - m[1][2],
            m[0][2] - m[2][0],
            m[1][0] - m[0][1],
        ],
        [
            m[2][1] - m[1][2],
            m[0][0] - m[1][1] - m[2][2],
            m[0][1] + m[1][0],
            m[0][2] + m[2][0],
        ],
        [
            m[0][2] - m[2][0],
            m[0][1] + m[1][0],
            m[1][1] - m[0][0] - m[2][2],
            m[1][2] + m[2][1],
        ],
        [
            m[1][0] - m[0][1],
            m[0][2] + m[2][0],
            m[1][2] + m[2][1],
            m[2][2] - m[0][0] - m[1][1],
        ],
    ];
    // Shifted positive so the eigenvector power iteration converges to is the largest one's.
    let shift: f64 = (0..4).map(|i| (0..4).map(|j| n[i][j].abs()).sum::<f64>()).fold(0.0, f64::max);
    let mut v = [1.0, 0.0, 0.0, 0.0];
    for _ in 0..300 {
        let mut next = [0.0f64; 4];
        for (i, slot) in next.iter_mut().enumerate() {
            *slot = (0..4).map(|j| n[i][j] * v[j]).sum::<f64>() + shift * v[i];
        }
        let length = (next.iter().map(|x| x * x).sum::<f64>()).sqrt();
        if length < 1e-12 {
            return [1.0, 0.0, 0.0, 0.0];
        }
        v = next.map(|x| x / length);
    }
    normalise(v)
}

fn normalised(v: [f64; 3]) -> [f64; 3] {
    let length = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if length < 1e-12 { [0.0, 0.0, 1.0] } else { [v[0] / length, v[1] / length, v[2] / length] }
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::composition::{Composition, VERSION};

    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
        }

        fn between(&mut self, low: f64, high: f64) -> f64 {
            low + (high - low) * self.next()
        }
    }

    const SIZE: [usize; 2] = [1616, 1080];
    const FOCAL: f64 = 1400.0;
    /// §3.1's own worked geometry: a frame whose corners sit at `x/f = 0.5`, at the focal §3.1
    /// works its 1.75px at. `WIDE`'s half-diagonal is 2604px, so the corners are at 0.52.
    const CORNERS_AT_HALF: f64 = 5000.0;
    const WIDE: [usize; 2] = [4330, 2890];

    fn rig() -> Vec<[f64; 4]> {
        [
            (-25.0, -12.0, 1.5),
            (0.0, -12.0, -0.8),
            (25.0, -12.0, 2.0),
            (-25.0, 12.0, -1.2),
            (0.0, 12.0, 0.4),
            (25.0, 12.0, -2.0),
        ]
        .iter()
        .map(|(pan, tilt, roll)| {
            let d = std::f64::consts::PI / 180.0;
            let y = from_axis_angle([0.0, pan * d, 0.0]);
            let x = from_axis_angle([tilt * d, 0.0, 0.0]);
            let z = from_axis_angle([0.0, 0.0, roll * d]);
            normalise(multiply(y, multiply(x, z)))
        })
        .collect()
    }

    fn matches(truth: &[[f64; 4]], a: usize, b: usize, rng: &mut Rng) -> Vec<Match> {
        let sizes = vec![SIZE; truth.len()];
        let mut out = Vec::new();
        let mut tries = 0;
        while out.len() < 300 && tries < 20_000 {
            tries += 1;
            let at = [rng.between(0.0, SIZE[0] as f64), rng.between(0.0, SIZE[1] as f64)];
            let Some(there) = projected(&sizes, truth, FOCAL, a, b, at) else { continue };
            if there[0] < 0.0
                || there[1] < 0.0
                || there[0] >= SIZE[0] as f64
                || there[1] >= SIZE[1] as f64
            {
                continue;
            }
            let wrong = rng.next() < 0.05;
            let spread = if wrong { 20.0 } else { 0.3 };
            out.push(Match {
                a: at,
                b: [
                    there[0] + rng.between(-spread, spread),
                    there[1] + rng.between(-spread, spread),
                ],
                peak: 0.9,
            });
        }
        out
    }

    fn degrees_between(a: [f64; 4], b: [f64; 4]) -> f64 {
        let d = multiply(conjugate(a), b);
        2.0 * d[0].abs().min(1.0).acos() * 180.0 / std::f64::consts::PI
    }

    /// Six frames on a two-row grid, told nothing but where their content corresponds, come back
    /// pointing where they were shot from and agreeing on the lens.
    #[test]
    fn the_solver_recovers_the_rig() {
        let truth = rig();
        let sizes = vec![SIZE; truth.len()];
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let adjacent = [(0, 1), (1, 2), (3, 4), (4, 5), (0, 3), (1, 4), (2, 5)];
        let pairs: Vec<Pair> = adjacent
            .iter()
            .map(|&(a, b)| {
                let matches = matches(&truth, a, b, &mut rng);
                Pair {
                    a,
                    b,
                    score: 0.8,
                    found: matches.len(),
                    matches,
                    vouched: false,
                }
            })
            .collect();

        // Told nothing about the lens, so the focal below is one the pictures alone recovered.
        let solved =
            solve(&sizes, &pairs, SIZE[0] as f64, Leash::Free).expect("a connected set solves");
        assert!(solved.dropped.is_empty(), "dropped {:?}", solved.dropped);
        assert!(
            (solved.focal - FOCAL).abs() < 0.005 * FOCAL,
            "focal {} against {FOCAL}",
            solved.focal
        );
        assert!(solved.rms_px < 0.6, "rms {}", solved.rms_px);
        for i in 0..truth.len() {
            let want = multiply(conjugate(truth[0]), truth[i]);
            let got = multiply(conjugate(solved.rotations[0]), solved.rotations[i]);
            let off = degrees_between(want, got);
            assert!(off < 0.03, "source {i} is {off} degrees out");
        }
    }

    const SEED: u64 = 0x243F_6A88_85A3_08D3;
    const TRUTH: f64 = 5000.0;

    /// A burst: two frames `radians` about y apart, at `focal`. Small enough, that is nearly a pure
    /// shift, and a shift is what any `(focal, angle)` of constant product explains - so all that is
    /// left saying how long the lens was is the curvature across the frame, which shrinks with the
    /// angle.
    ///
    /// A third of a pixel on each match and **no blunders**, unlike `matches()`: what the solves
    /// below are asked about is the geometry, and an outlier round cannot be what answers them.
    fn burst_pairs(focal: f64, radians: f64, seed: u64) -> Vec<Pair> {
        burst_pairs_on(SIZE, focal, radians, seed)
    }

    fn burst_pairs_on(size: [usize; 2], focal: f64, radians: f64, seed: u64) -> Vec<Pair> {
        let truth = [[1.0, 0.0, 0.0, 0.0], from_axis_angle([0.0, radians, 0.0])];
        let sizes = vec![size; 2];
        let mut rng = Rng(seed);
        let mut out = Vec::new();
        let mut tries = 0;
        while out.len() < 300 && tries < 20_000 {
            tries += 1;
            let at = [rng.between(0.0, size[0] as f64), rng.between(0.0, size[1] as f64)];
            let Some(there) = projected(&sizes, &truth, focal, 0, 1, at) else { continue };
            if there[0] < 0.0
                || there[1] < 0.0
                || there[0] >= size[0] as f64
                || there[1] >= size[1] as f64
            {
                continue;
            }
            let mut off = || rng.between(-0.3, 0.3);
            out.push(Match { a: at, b: [there[0] + off(), there[1] + off()], peak: 0.9 });
        }
        vec![Pair { a: 0, b: 1, score: 0.8, found: out.len(), matches: out, vouched: false }]
    }

    /// The same two frames at five draws of the noise, which is how far a free focal moves for
    /// reasons that are not the pictures.
    fn free_focals(radians: f64) -> Vec<f64> {
        let sizes = vec![SIZE; 2];
        (1u64..=5)
            .map(|draw| {
                let pairs = burst_pairs(TRUTH, radians, SEED.wrapping_mul(draw));
                solve(&sizes, &pairs, TRUTH, Leash::Free).expect("one pair solves").focal
            })
            .collect()
    }

    /// §3.1's degeneracy, measured. A fifth of a milliradian apart the frames are a pure shift, and
    /// any `(focal, angle)` of constant product explains a shift: the curvature that separates them
    /// is a twentieth of the noise on a match. So what a free solve returns is a draw from that
    /// noise - five of them here land nearly a factor of two apart, on correspondences with no
    /// blunder in them at all - and no improvement to the fit can mend a question the pictures were
    /// never asked. That is what the leash is for.
    ///
    /// How close the frames are is the whole of it, and §3.1's own 3.5 mrad is already far enough
    /// apart to answer: the same five draws sit inside a tenth there. What a burst has no floor on
    /// is the angle.
    #[test]
    fn a_burst_cannot_see_its_own_focal() {
        let spread = |focals: &[f64]| {
            let low = focals.iter().copied().fold(f64::INFINITY, f64::min);
            focals.iter().copied().fold(f64::NEG_INFINITY, f64::max) - low
        };
        let still = free_focals(0.2e-3);
        assert!(spread(&still) / TRUTH > 0.25, "five free solves of one burst: {still:?}");
        let apart = free_focals(3.5e-3);
        assert!(spread(&apart) / TRUTH < 0.1, "five free solves of wider frames: {apart:?}");
    }

    /// A guess is worth less than what the file said, so it may go further from where it started -
    /// and on frames this degenerate the fit does want to go further.
    #[test]
    fn an_assumed_focal_has_a_wider_leash_than_a_told_one() {
        let sizes = vec![SIZE; 2];
        let pairs = burst_pairs(TRUTH, 0.2e-3, SEED);
        let assumed = solve(&sizes, &pairs, 4000.0, Leash::Assumed).unwrap();
        assert!(
            (assumed.focal - 4000.0).abs() / 4000.0 > FOCAL_HELD,
            "assumed {} is no further out than a told focal may go",
            assumed.focal
        );
    }

    /// §3.1: a told focal has to be checked, the check has to **fire**, and `rms_px` cannot be what
    /// fires.
    ///
    /// One burst on §3.1's own worked geometry - corners at `x/f = 0.5`, 10 mrad apart, which is
    /// where a real hand-held pair sits (§3.10's is 14) - solved at its own focal and at one off by
    /// half. A focal error is **radial**, so it lands where the frame is widest.
    ///
    /// **What the rms cannot do is carry a bound**, whatever it moves by: its floor is the frame's
    /// own texture, 0.24px on this noise-only fixture against 0.97px on the real burst, so no
    /// absolute number means the same thing on two sets. The difference of two medians has a floor
    /// of zero by construction, which is what a bound can be spent on.
    #[test]
    fn a_wrong_held_focal_shows_at_the_corners_and_the_rms_cannot_carry_a_bound() {
        let sizes = vec![WIDE; 2];
        let pairs = burst_pairs_on(WIDE, CORNERS_AT_HALF, 10.0e-3, SEED);
        let right = solve(&sizes, &pairs, CORNERS_AT_HALF, Leash::Told).expect("one pair solves");
        let wrong =
            solve(&sizes, &pairs, 2.0 * CORNERS_AT_HALF, Leash::Told).expect("one pair solves");
        println!(
            "right: rms {:.3}px, radial {:.3}px; wrong: rms {:.3}px, radial {:.3}px",
            right.rms_px, right.radial_px, wrong.rms_px, wrong.radial_px,
        );
        assert!(
            right.radial_px < 0.2 * right.rms_px,
            "a burst at its own focal reads {:.3}px of radial pattern over an rms of {:.3}px",
            right.radial_px,
            right.rms_px,
        );
        assert!(
            unaligned_on(WIDE, wrong.radial_px),
            "a focal off by half reads {:.3}px, which §3.1 would let through",
            wrong.radial_px,
        );
    }

    /// And the bound is not the leash restated, because an **assumed** focal at the leash's own
    /// limit is not refused - it is *recovered*.
    ///
    /// Either the frames are far enough apart to see their focal, and 15% of slack is enough for
    /// the fit to walk back to it, or they are not, and then the wrong focal leaves no residual to
    /// refuse: at a fifth of a milliradian the same 15% reads under a hundredth of a pixel. What
    /// the corner check catches is a focal the *file* stated and `Leash::Told` therefore holds
    /// within 2% of, and frames that are not near-identity for reasons that are not the lens.
    #[test]
    fn an_assumed_focal_at_the_leashs_limit_is_recovered_rather_than_refused() {
        let sizes = vec![WIDE; 2];
        for radians in [0.2e-3, 10.0e-3] {
            let pairs = burst_pairs_on(WIDE, CORNERS_AT_HALF, radians, SEED);
            let leashed =
                solve(&sizes, &pairs, (1.0 + FOCAL_ASSUMED) * CORNERS_AT_HALF, Leash::Assumed)
                    .expect("one pair solves");
            println!(
                "{:.1} mrad, focal 15% out: radial {:.3}px, settled at {:.0} against {CORNERS_AT_HALF:.0}",
                radians * 1e3,
                leashed.radial_px,
                leashed.focal,
            );
            assert!(
                !unaligned_on(WIDE, leashed.radial_px),
                "an assumed focal at the leash's limit reads {:.3}px at {:.1} mrad",
                leashed.radial_px,
                radians * 1e3,
            );
        }
    }

    /// And a blunder is not a focal error, which is what the two halves of the statistic are for.
    ///
    /// One match in the middle of the frame is moved three pixels - a blunder inside the outlier
    /// round's own tolerance, which therefore survives into the answer. It is the worst match on
    /// the picture, and reading it as a radial pattern would refuse a burst that is perfectly near
    /// identity. The median over each population is what stops it: one match in three hundred moves
    /// neither.
    #[test]
    fn a_blunder_in_the_middle_of_the_frame_is_not_a_focal_error() {
        let sizes = vec![SIZE; 2];
        let mut pairs = burst_pairs(FOCAL, 3.5e-3, SEED);
        let clean = solve(&sizes, &pairs, FOCAL, Leash::Told).expect("one pair solves");
        let middle = pairs[0]
            .matches
            .iter()
            .position(|m| !in_the_outer_fifth(&SIZE, m.a) && !in_the_outer_fifth(&SIZE, m.b))
            .expect("a match in the middle of the frame");
        pairs[0].matches[middle].b[0] += 3.0;

        let solved = solve(&sizes, &pairs, FOCAL, Leash::Told).expect("one pair solves");
        let anywhere = kept_worst(&sizes, &pairs, &solved);
        println!(
            "worst anywhere {anywhere:.3}px, radial {:.3}px against {:.3}px clean",
            solved.radial_px, clean.radial_px,
        );
        assert!(anywhere > 2.5, "the blunder was thrown out before it could be measured: {anywhere:.3}px");
        assert!(
            (solved.radial_px - clean.radial_px).abs() < 0.1,
            "the middle's blunder moved the corner check: {:.3}px against {:.3}px clean",
            solved.radial_px,
            clean.radial_px,
        );
        assert!(
            !unaligned_on(SIZE, solved.radial_px),
            "the middle's blunder reached the corner check: {:.3}px",
            solved.radial_px,
        );
    }

    /// Whether the analysis would flag this reading, on the plane these fixtures are stated on.
    fn unaligned_on(size: [usize; 2], radial_px: f64) -> bool {
        let long = size[0].max(size[1]) as f64;
        crate::assembly_analysis::unaligned_at(crate::px::Share::measured(radial_px, long))
    }

    /// Two frames on top of each other, the second `scale` times longer in the lens, with matches
    /// that say so exactly.
    fn a_burst_apart_by(scale: f64) -> (Vec<[usize; 2]>, Vec<Pair>, Solved) {
        let sizes = vec![SIZE; 2];
        let rotations = vec![[1.0, 0.0, 0.0, 0.0]; 2];
        let (cx, cy) = (SIZE[0] as f64 / 2.0, SIZE[1] as f64 / 2.0);
        // A grid of points across the frame; the second frame sees each one further out by `scale`,
        // which is what a longer focal does and what nothing but a per-frame scale can absorb.
        let matches: Vec<Match> = (1..8)
            .flat_map(|i| (1..8).map(move |j| (i, j)))
            .map(|(i, j)| {
                let a = [cx + (i as f64 - 4.0) * 90.0, cy + (j as f64 - 4.0) * 60.0];
                Match { a, b: [cx + (a[0] - cx) * scale, cy + (a[1] - cy) * scale], peak: 1.0 }
            })
            .collect();
        let found = matches.len();
        let pairs = vec![Pair { a: 0, b: 1, score: 1.0, matches, found, vouched: true }];
        let solved = Solved {
            scales: vec![1.0; 2],
            rotations,
            focal: FOCAL,
            rms_px: 0.0,
            dropped: Vec::new(),
            kept: Vec::new(),
            radial_px: 0.0,
        };
        (sizes, pairs, solved)
    }

    /// **§3.1's gate reads the geometry that ships, not the one the solve started from.**
    ///
    /// A scale difference is radial by nature - it displaces a corner and leaves the middle alone -
    /// so it is exactly what `radial_px` sees. Measured before `scale_each`, a burst whose only
    /// fault was a breathing lens reads as not-near-identity *after* the step that corrected it,
    /// and `assembly_analysis` refuses a set it had just fixed.
    #[test]
    fn the_corner_reading_is_taken_after_the_scales_are_fitted() {
        let (sizes, pairs, mut solved) = a_burst_apart_by(1.03);
        // What the solve would have written: the corner statistic against one shared focal, with
        // the scale difference still in the residual.
        solved.radial_px = radial_of(&sizes, &pairs, &solved);
        let before = solved.radial_px;
        scale_each(&sizes, &pairs, &mut solved);

        assert!(
            before.abs() > 0.5,
            "a three percent scale difference has to show at the corners for this to be a test: {before}",
        );
        assert!(
            solved.radial_px.abs() < before.abs() / 2.0,
            "the corner reading still describes the uncorrected geometry: {before} -> {}",
            solved.radial_px,
        );
    }

    /// A burst's frames sit on top of each other, so a difference in scale between two of them is
    /// as observable as anything in the set - and one shared focal has nowhere to put it.
    #[test]
    fn a_per_frame_scale_is_recovered_from_a_burst() {
        for planted in [1.02, 0.97] {
            let (sizes, pairs, mut solved) = a_burst_apart_by(planted);
            scale_each(&sizes, &pairs, &mut solved);
            // The pair only says how the two differ, so what is pinned is their ratio.
            let found = solved.scales[1] / solved.scales[0];
            assert!(
                (found - planted).abs() < 0.002,
                "planted {planted} and recovered {found} ({:?})",
                solved.scales,
            );
        }
    }

    /// And where there is nothing to find it finds nothing: a fit that drifted off one would move
    /// every pixel of a set that was already registered.
    #[test]
    fn frames_that_already_agree_keep_the_shared_focal() {
        let (sizes, pairs, mut solved) = a_burst_apart_by(1.0);
        scale_each(&sizes, &pairs, &mut solved);
        for scale in &solved.scales {
            assert!((scale - 1.0).abs() < 0.002, "invented a scale of {scale}");
        }
    }

    /// The leash, which is what stops a set the matches cannot constrain from wandering: a pair
    /// with nothing to say leaves the scale where it started rather than at a bracket's middle.
    #[test]
    fn a_source_no_pair_reaches_is_left_at_one() {
        let (sizes, mut pairs, mut solved) = a_burst_apart_by(1.03);
        solved.rotations.push([1.0, 0.0, 0.0, 0.0]);
        solved.scales.push(1.0);
        let mut sizes = sizes;
        sizes.push(SIZE);
        pairs.retain(|p| p.a != 2 && p.b != 2);
        scale_each(&sizes, &pairs, &mut solved);
        assert_eq!(solved.scales[2], 1.0, "a frame no pair reaches was given a scale anyway");
    }

    fn kept_worst(sizes: &[[usize; 2]], pairs: &[Pair], answer: &Solved) -> f64 {
        let outlier = across(OUTLIER, sizes);
        pairs
            .iter()
            .flat_map(|pair| {
                pair.matches.iter().filter_map(move |m| {
                    reprojection(sizes, &answer.rotations, answer.focal, pair.a, pair.b, m)
                })
            })
            .filter(|r| *r <= outlier)
            .fold(0.0, f64::max)
    }

    /// A set of frames covering `hfov` by `vfov` degrees, four of them on a grid.
    fn covering(hfov: f64, vfov: f64) -> (Solved, Vec<[usize; 2]>) {
        let sizes = vec![SIZE; 4];
        let own_h = 2.0 * (SIZE[0] as f64 / 2.0 / FOCAL).atan().to_degrees();
        let own_v = 2.0 * (SIZE[1] as f64 / 2.0 / FOCAL).atan().to_degrees();
        let pan = ((hfov - own_h) / 2.0).max(0.0).to_radians();
        let tilt = ((vfov - own_v) / 2.0).max(0.0).to_radians();
        let rotations = [(-pan, -tilt), (pan, -tilt), (-pan, tilt), (pan, tilt)]
            .iter()
            .map(|(pan, tilt)| {
                normalise(multiply(
                    from_axis_angle([0.0, *pan, 0.0]),
                    from_axis_angle([*tilt, 0.0, 0.0]),
                ))
            })
            .collect();
        (
            Solved {
                scales: vec![1.0; 4],
                rotations,
                focal: FOCAL,
                rms_px: 0.2,
                dropped: Vec::new(),
                kept: Vec::new(),
                radial_px: 0.0,
            },
            sizes,
        )
    }

    /// A pan of five frames, `roll` degrees off level, with each frame `wander` degrees away from
    /// where the pan alone would point it.
    fn hand_held(roll: f64, wander: [f64; 5]) -> Vec<[f64; 4]> {
        let about = from_axis_angle([0.0, 0.0, roll.to_radians()]);
        (0..5)
            .map(|i| {
                let pan = (i as f64 - 2.0) * 12.0_f64.to_radians();
                // The roll on the outside of the pan: turning about an axis the roll has tilted is
                // exactly a camera panned by a hand that is not level. The wander is on the inside,
                // where it tilts the frame without rolling it, as a photographer's drift does.
                normalise(multiply(
                    about,
                    multiply(
                        from_axis_angle([0.0, pan, 0.0]),
                        from_axis_angle([wander[i].to_radians(), 0.0, 0.0]),
                    ),
                ))
            })
            .collect()
    }

    /// The world direction a set of levelled rotations came to call vertical.
    ///
    /// `straighten` turns every rotation by one global rotation, so what it decided is recoverable
    /// from any single frame: where that turn sends the axis the pan was really about.
    fn levelled_axis(before: &[[f64; 4]], after: &[[f64; 4]], axis: [f64; 3]) -> [f64; 3] {
        rotate(multiply(after[0], conjugate(before[0])), axis)
    }

    /// Every derivative the fit steps on, against a finite difference of the same residuals.
    ///
    /// **The one test a hand-derived Jacobian needs.** Nothing downstream reads it directly - a
    /// sign error does not fail, it converges somewhere else or crawls, and both look like a
    /// solver that could be better tuned. Held against the differences, each entry has to be that
    /// number.
    #[test]
    fn the_derivatives_agree_with_measuring_them() {
        let truth = rig();
        let sizes = vec![SIZE; truth.len()];
        let mut rng = Rng(5);
        let pairs: Vec<Pair> = [(0, 1), (1, 2), (0, 3), (3, 4), (4, 5)]
            .iter()
            .map(|&(a, b)| {
                let found = matches(&truth, a, b, &mut rng);
                Pair {
                    a,
                    b,
                    score: 0.9,
                    found: found.len(),
                    matches: found,
                    vouched: false,
                }
            })
            .collect();

        // Away from the truth, where the derivatives are not all near zero, and away from the
        // focal's own clamp, where they are deliberately zero.
        let rotations: Vec<[f64; 4]> = truth
            .iter()
            .enumerate()
            .map(|(i, q)| {
                let off = (i as f64 + 1.0) * 0.004;
                normalise(multiply(from_axis_angle([off, -off, off / 2.0]), *q))
            })
            .collect();
        let focal = FOCAL * 1.01;
        let free = 3 * (sizes.len() - 1) + 1;

        let residual = residuals(&sizes, &rotations, focal, &pairs);
        let ones = vec![1.0; residual.len()];
        let analytic = derivatives(&sizes, &rotations, focal, focal, &pairs, free, &ones);

        let focal_of = |t: f64| focal * t.exp();
        for k in 0..free {
            let step = 1e-7;
            let (moved, at) = nudged(&rotations, 0.0, k, step, focal_of);
            let there = residuals(&sizes, &moved, at, &pairs);
            for row in 0..residual.len() {
                let measured = (there[row] - residual[row]) / step;
                let written = analytic[row].by_parameter(k);
                // Against the size of the number rather than absolutely: a residual of a thousand
                // pixels has a derivative to match, and the difference quotient carries the
                // step's own error into it.
                let scale = measured.abs().max(written.abs()).max(1.0);
                assert!(
                    (measured - written).abs() < 1e-3 * scale,
                    "parameter {k}, row {row}: wrote {written}, measured {measured}"
                );
            }
        }
    }

    /// The direction a scatter least agrees with, on the shape a panorama actually makes: one
    /// direction nearly every ray shares, one they spread along, one they never take.
    ///
    /// **The case a shifted power iteration cannot answer.** Separating the two smallest
    /// eigenvalues by their difference alone leaves them a fraction of a percent apart against a
    /// trace they are both tiny beside, and the iteration walks toward the answer far too slowly
    /// to arrive - so the levelling that reads this got a tilted axis and half-corrected a pan,
    /// which looks like a levelling that does not work.
    #[test]
    fn the_axis_of_a_lopsided_scatter_is_found_exactly() {
        // A pan of rays 12 degrees apart about an axis tilted 5 degrees off vertical, which is a
        // hand-held panorama and nothing unusual.
        let tilt = from_axis_angle([0.0, 0.0, 5.0_f64.to_radians()]);
        let truth = rotate(tilt, [0.0, 1.0, 0.0]);
        let mut m = [[0.0f64; 3]; 3];
        for i in 0..5 {
            let pan = (i as f64 - 2.0) * 12.0_f64.to_radians();
            let ray = rotate(multiply(tilt, from_axis_angle([0.0, pan, 0.0])), [0.0, 0.0, 1.0]);
            for (r, row) in m.iter_mut().enumerate() {
                for (c, cell) in row.iter_mut().enumerate() {
                    *cell += ray[r] * ray[c];
                }
            }
        }

        let found = smallest_eigenvector(&m);
        let agreement = dot(found, truth).abs();
        assert!(agreement > 0.999_999, "the axis came back at {found:?} rather than {truth:?}");
    }

    /// A pan about an axis that is not vertical is turned until it is - which is what levels the
    /// horizon, since a hand that leans rolls every frame it takes by the same angle.
    #[test]
    fn a_pan_about_a_tilted_axis_is_levelled() {
        for roll in [0.0_f64, 3.0, -1.5] {
            let before = hand_held(roll, [0.0; 5]);
            let mut after = before.clone();
            straighten(&mut after);

            // The pan's true axis is the world's vertical turned by the roll, and levelling is
            // exactly the claim that it ends up on the vertical again.
            let truth = rotate(from_axis_angle([0.0, 0.0, roll.to_radians()]), [0.0, 1.0, 0.0]);
            let landed = levelled_axis(&before, &after, truth);
            assert!(
                landed[1].abs() > 0.9995,
                "a pan rolled {roll} degrees left its axis at {landed:?} rather than upright"
            );
        }
    }

    /// A photographer who drifts up and down across a pan has not tilted its axis, and the
    /// levelling is not moved by them.
    ///
    /// The reading this pins is why it is the frames' *rays* that are fitted rather than their
    /// horizontals: a drift moves where a frame points without rolling it, and the axis a set of
    /// rays least agrees with is untouched by that. Read off the cameras' own horizontals instead,
    /// the same set answers a degree and a half out.
    #[test]
    fn a_pan_that_wanders_in_tilt_is_still_upright() {
        let wander = [0.0, 2.5, -1.5, 3.0, -2.0];
        let before = hand_held(0.0, wander);
        let mut after = before.clone();
        straighten(&mut after);

        let landed = levelled_axis(&before, &after, [0.0, 1.0, 0.0]);
        assert!(
            landed[1].abs() > 0.999,
            "a level pan wandering {wander:?} degrees left its axis at {landed:?}"
        );
    }

    /// A burst turns too little for either scatter to name a vertical, and the answer there is the
    /// reference's own: measured, the arbitrary perpendicular an eigensolve lands on instead
    /// levelled two frames 58 degrees off their horizon and framed 16195x5134 for a pair that
    /// overlap almost entirely.
    #[test]
    fn a_burst_that_barely_turns_keeps_the_references_own_vertical() {
        let held = from_axis_angle([0.1, 0.2, 0.05]);
        let mut rotations =
            vec![held, normalise(multiply(held, from_axis_angle([0.0003, 0.0005, -0.0002])))];
        straighten(&mut rotations);

        assert!(
            rotations[0][0].abs() > 0.999_999,
            "the reference came back at {:?} rather than upright and facing down the canvas",
            rotations[0]
        );
        let solved = Solved {
            scales: vec![1.0; rotations.len()],
            rotations,
            focal: FOCAL,
            rms_px: 0.2,
            dropped: Vec::new(),
            kept: Vec::new(),
            radial_px: 0.0,
        };
        let canvas = framed(&solved, &[SIZE; 2], 1.0).canvas;
        assert!(canvas[0] < SIZE[0] * 2, "two frames on top of each other framed a {canvas:?} canvas");
    }

    /// The crop is a real rectangle of what the sources cover rather than the whole canvas, whose
    /// corners a hand-held pan always leaves empty.
    #[test]
    fn the_crop_keeps_the_rectangle_the_frames_cover() {
        let sizes = vec![SIZE; 5];
        let mut rotations = hand_held(2.0, [0.0, 1.0, -1.0, 0.5, -0.5]);
        straighten(&mut rotations);
        let solved = Solved {
            scales: vec![1.0; rotations.len()],
            rotations,
            focal: FOCAL,
            rms_px: 0.2,
            dropped: Vec::new(),
            kept: Vec::new(),
            radial_px: 0.0,
        };

        let framing = framed(&solved, &sizes, 1.0);
        let [left, top, right, bottom] = framing.crop;
        assert!(right - left > 0.5 && bottom - top > 0.2, "crop {:?} keeps nothing", framing.crop);
        assert!(left >= 0.0 && top >= 0.0 && right <= 1.0 && bottom <= 1.0);
        // And it is a trim rather than the whole canvas, which is what says the wedges were found.
        assert!(top > 0.0 || bottom < 1.0, "crop {:?} trimmed nothing off a tilted pan", framing.crop);
    }

    /// Ground symmetric about the canvas centre must answer a crop symmetric about it too, so the
    /// crop cannot be favouring one edge of the cells it was measured on.
    #[test]
    fn the_crop_does_not_favour_one_edge_of_the_cells_it_sampled() {
        let (solved, sizes) = covering(100.0, 60.0);
        let framing = framed(&solved, &sizes, 1.0);
        let [left, top, right, bottom] = framing.crop;
        let half_cell = 0.5 / COVER_GRID as f64;
        assert!(
            (left - (1.0 - right)).abs() < half_cell,
            "left {left} and the mirror of right {} differ by more than half a cell: crop {:?}",
            1.0 - right,
            framing.crop,
        );
        assert!(
            (top - (1.0 - bottom)).abs() < half_cell,
            "top {top} and the mirror of bottom {} differ by more than half a cell: crop {:?}",
            1.0 - bottom,
            framing.crop,
        );
    }

    /// Hugin's rule, and the reason a stitcher has one: a rectilinear canvas is unusable past
    /// about a hundred degrees, and a cylinder cannot hold a tall field at all.
    #[test]
    fn the_projection_follows_hugins_rule() {
        for (hfov, vfov, want) in [
            (80.0, 50.0, Projection::Rectilinear),
            (140.0, 50.0, Projection::Cylindrical),
            (140.0, 110.0, Projection::Equirectangular),
        ] {
            let (solved, sizes) = covering(hfov, vfov);
            let framing = framed(&solved, &sizes, 1.0);
            assert_eq!(framing.projection, want, "{hfov} by {vfov} degrees");
        }
    }

    /// The canvas holds every source and nothing much more, at the sources' own resolution, with
    /// the axis where the sources actually put it.
    #[test]
    fn the_canvas_holds_what_the_sources_cover() {
        let (solved, sizes) = covering(140.0, 50.0);
        let framing = framed(&solved, &sizes, 4.0);

        assert!(framing.canvas[0] > 4 * SIZE[0], "canvas {:?} is narrower than a pan", framing.canvas);
        assert!((framing.radians_per_pixel - 1.0 / (FOCAL * 4.0)).abs() < 1e-12);
        // Symmetric coverage, so the axis lands in the middle of what was framed.
        let middle = |axis: usize| (framing.centre[axis] - framing.canvas[axis] as f64 / 2.0).abs();
        assert!(middle(0) < 2.0 && middle(1) < 2.0, "centre {:?} off", framing.centre);

        // Every corner of every source is on the canvas, which is what "framed around them" means.
        let p = Composition {
            version: VERSION,
            sources: Vec::new(),
            projection: framing.projection,
            canvas: framing.canvas,
            centre: framing.centre,
            radians_per_pixel: framing.radians_per_pixel,
            crop: framing.crop,
            reference: 0,
            seam_rms_px: None,
        };
        for (i, size) in sizes.iter().enumerate() {
            for at in border(size) {
                let (cx, cy) = (size[0] as f64 / 2.0, size[1] as f64 / 2.0);
                let ray = rotate(
                    solved.rotations[i],
                    [(at[0] - cx) / FOCAL, (at[1] - cy) / FOCAL, 1.0],
                );
                let on = crate::composition::ray_to_canvas(&p, ray).expect("in front");
                assert!(
                    on[0] >= -1.0
                        && on[1] >= -1.0
                        && on[0] <= framing.canvas[0] as f64 + 1.0
                        && on[1] <= framing.canvas[1] as f64 + 1.0,
                    "source {i} corner {at:?} lands at {on:?} off a {:?} canvas",
                    framing.canvas
                );
            }
        }
    }

    /// A frame given half the light of its neighbour is twice the gain, and a measurement that
    /// agrees with the headers changes nothing.
    #[test]
    fn a_stop_of_exposure_is_a_gain_of_two() {
        let exposures = vec![exposure_of(Some(1.0 / 100.0), Some(8.0), Some(100.0)),
                             exposure_of(Some(1.0 / 200.0), Some(8.0), Some(100.0))];
        let matched = gains(&exposures, &[(0, 1, 2.0)], 0);
        assert!((matched[0] - 1.0).abs() < 1e-9, "{matched:?}");
        assert!((matched[1] - 2.0).abs() < 1e-9, "{matched:?}");
    }

    /// A measurement the headers cannot explain is a mis-registered overlap or a cloud, and it
    /// moves the gain by at most a stop.
    #[test]
    fn a_wild_measurement_is_held_to_a_stop() {
        let exposures = vec![Some(1.0), Some(1.0)];
        let held = gains(&exposures, &[(0, 1, 8.0)], 0);
        assert!((held[1] - RESIDUAL_CLAMP).abs() < 1e-9, "{held:?}");

        // With no headers at all the measurement is all there is, and is still held.
        let blind = gains(&[None, None], &[(0, 1, 8.0)], 0);
        assert!((blind[1] - RESIDUAL_CLAMP).abs() < 1e-9, "{blind:?}");
    }

    /// A scene that repeats answers the search confidently for frames that never overlapped, and
    /// the panorama has to survive it.
    ///
    /// **Measured on real photographs, not imagined.** Five frames of a horizon at 165mm: the
    /// search reported the *same* displacement for every pair of them - adjacent, two apart, four
    /// apart - each with a correlation above 0.84, because a shift along a horizon still lines sky
    /// up over sea. A solve handed all ten of those at once cannot satisfy them and drops every
    /// frame but one, which is what this pins against.
    ///
    /// Here the false pairs claim the one-step relationship whatever their true separation, which
    /// is exactly what those photographs did.
    #[test]
    fn a_repeating_scene_does_not_place_frames_that_never_overlapped() {
        let truth = rig();
        let sizes = vec![SIZE; truth.len()];
        let mut rng = Rng(11);
        let mut pairs: Vec<Pair> = Vec::new();
        for a in 0..3 {
            for b in a + 1..3 {
                // Every pair is handed the *adjacent* pair's correspondences, so a pair two apart
                // says two frames sit where one step says they do.
                let matches = matches(&truth, a, a + 1, &mut rng);
                let strength = 1.0 - 0.05 * (b - a) as f64;
                pairs.push(Pair {
                    a,
                    b,
                    score: strength,
                    found: matches.len(),
                    matches,
                    vouched: false,
                });
            }
        }

        let solved =
            solve(&sizes, &pairs, SIZE[0] as f64, Leash::Free).expect("a set this size solves");

        // The pair that is a coincidence is not among the ones the answer rests on.
        assert!(
            !solved.kept.iter().any(|(a, b, _)| *a == 0 && *b == 2),
            "kept a pair that cannot be true: {:?}",
            solved.kept
        );
        // And what is kept is close, rather than a compromise between truth and coincidence.
        let apart = across(PAIR_APART, &sizes);
        for (a, b, error) in &solved.kept {
            assert!(*error < apart, "{a}-{b} was kept at {error}px, past {apart}");
        }
    }

    /// `columns` by `rows` frames, panning across and tilting between rows.
    fn grid(columns: usize, rows: usize) -> Vec<[f64; 4]> {
        let d = std::f64::consts::PI / 180.0;
        let middle = |at: usize, of: usize| at as f64 - (of as f64 - 1.0) / 2.0;
        (0..rows)
            .flat_map(|row| (0..columns).map(move |column| (row, column)))
            .map(|(row, column)| {
                let y = from_axis_angle([0.0, middle(column, columns) * 15.0 * d, 0.0]);
                let x = from_axis_angle([middle(row, rows) * 14.0 * d, 0.0, 0.0]);
                normalise(multiply(y, x))
            })
            .collect()
    }

    /// A false pair that *reaches a frame nothing has placed yet* does not get to place it.
    ///
    /// The difference from the test above is which of `grown`'s two paths judges the pair. There
    /// the coincidence joins two frames already standing, so the set it has to agree with is the
    /// answer itself. Here it is the only thing touching frame 7, so admitting it decides where
    /// that frame goes - and everything fitted afterwards is anchored to a frame in the wrong
    /// place.
    ///
    /// Two rows of six, which is the shape this bites at: a wide pan offers dozens of pairs that
    /// never overlapped, and one of them only has to out-correlate the ordinary true pair it
    /// competes with once.
    #[test]
    fn a_false_pair_does_not_get_to_place_a_frame_on_its_own() {
        let truth = grid(6, 2);
        let sizes = vec![SIZE; truth.len()];
        let mut rng = Rng(23);
        let neighbours: Vec<(usize, usize)> = (0..2)
            .flat_map(|row| (0..5).map(move |column| (row * 6 + column, row * 6 + column + 1)))
            .chain((0..6).map(|column| (column, column + 6)))
            .collect();
        let mut pairs: Vec<Pair> = neighbours
            .iter()
            .map(|&(a, b)| {
                let mut matches = matches(&truth, a, b, &mut rng);
                // The pan's first pair correlates best, so it is what the growth starts from and
                // the coincidence below is a bridge rather than the seed.
                matches.truncate(if (a, b) == (0, 1) { 320 } else { 200 });
                Pair {
                    a,
                    b,
                    score: 0.9,
                    found: matches.len(),
                    matches,
                    vouched: false,
                }
            })
            .collect();
        // Frame 7 is one row down and one across from frame 1, and a repeating scene says it is
        // frame 1. More correspondences than the true pairs, which is what a periodic structure
        // gives a false peak, so `attested` prefers it to the pair that would place 7 correctly.
        let mut coincidence = matches(&truth, 0, 1, &mut rng);
        coincidence.truncate(300);
        pairs.push(Pair {
            a: 0,
            b: 7,
            score: 0.88,
            found: coincidence.len(),
            matches: coincidence,
            vouched: false,
        });

        let solved =
            solve(&sizes, &pairs, SIZE[0] as f64, Leash::Free).expect("a set this size solves");

        assert!(
            !solved.kept.iter().any(|(a, b, _)| *a == 0 && *b == 7),
            "rested on a pair that cannot be true: {:?}",
            solved.kept
        );
        assert!(solved.dropped.is_empty(), "every frame is reachable, yet {:?} went", solved.dropped);
        for at in 0..truth.len() {
            let want = multiply(conjugate(truth[0]), truth[at]);
            let got = multiply(conjugate(solved.rotations[0]), solved.rotations[at]);
            let apart = degrees_between(want, got);
            assert!(apart < 1.0, "frame {at} came back {apart:.2} degrees from where it was shot");
        }
    }

    /// A frame nothing corresponds with cannot be placed, and saying so is the answer: the others
    /// still make a panorama.
    #[test]
    fn a_source_nothing_matches_is_dropped() {
        let truth = rig();
        let sizes = vec![SIZE; truth.len()];
        let mut rng = Rng(7);
        let pairs: Vec<Pair> = [(0, 1), (1, 2), (2, 5), (3, 4)]
            .iter()
            .map(|&(a, b)| {
                let matches = matches(&truth, a, b, &mut rng);
                Pair {
                    a,
                    b,
                    score: 0.8,
                    found: matches.len(),
                    matches,
                    vouched: false,
                }
            })
            .collect();
        // 3 and 4 are a pair with no way back to the root, which is a set the tree cannot span.
        let solved =
            solve(&sizes, &pairs, SIZE[0] as f64, Leash::Free).expect("the rest still solves");
        assert_eq!(solved.dropped, vec![3, 4], "the island away from the root is what goes");
    }
}
