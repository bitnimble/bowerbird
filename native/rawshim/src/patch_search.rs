//! Where the content around a point is found again: the offset that brings one frame's picture of
//! what the reader pointed at onto another's, so a person who moved between frames is taken as they
//! stand there rather than as whatever stands where they were.
//!
//! [`Patch`] is the comparison itself and holds no policy - what a good offset is belongs to the
//! caller. [`tracked`] is the merge's: the same content, found once, that tracks back to where it
//! started.
//!
//! Host arithmetic over the shrunk field, and deliberately: it is one patch a click, a few
//! milliseconds a frame, over a field the solve that follows already holds.

use crate::assembly_labelling::RING;
use crate::assembly_seam::{SeamField, differ};
use crate::light::Stops;
use crate::px::{Share, Shrunk, Span};

/// The radius of the patch compared around a seed, as a share of the long edge: a face and a little
/// of what frames it.
pub const PATCH: Share = Share::of(3, 200);

/// The furthest a frame's content is looked for, as a share of the long edge: a person in a group
/// shot who stepped a head or two aside.
pub const SEARCH: Share = Share::of(1, 16);

/// How much the colour of a patch counts against its light, per stop.
const TINT_WEIGHT: f32 = 1.0;

/// What share of a patch's weight has to be reached by both frames for an offset to be judged.
const ENOUGH: f32 = 0.75;

/// How much better than staying put an offset has to match to be taken: on ground that did not move,
/// an offset matching as well by chance is noise, and staying put is what nothing moving looks like.
const MOVED_BY: f32 = 0.5;

/// A patch whose light matches where it stands to within this, root mean square, has not moved,
/// however much better some offset does: a flat patch matches everywhere to within rounding.
const STILL: Stops = Stops::exactly(0.05);

/// How far, in cells, tracking back from where a patch was found may land from where it started.
const RETURNS_WITHIN: f64 = 2.0;

/// Where the content around `centre` in frame `base` lies in frame `frame`, in cells: the offset
/// `d` for which `frame` at `p + d` looks like `base` at `p`. Zero where nothing better is found.
///
/// **Only an offset that tracks back to where it started.** A crowd is full of lookalikes - the
/// face beside, the next penguin - and a patch can match one better than its own moved self. A
/// lookalike that stood still tracks back to itself, not to the seed.
pub fn tracked(
    field: &SeamField,
    size: (usize, usize),
    base: usize,
    frame: usize,
    centre: [usize; 2],
) -> [f64; 2] {
    let there = matched(field, size, base, frame, centre);
    if there == [0.0, 0.0] {
        return there;
    }
    let landed = [0, 1].map(|axis| (centre[axis] as f64 + there[axis]).round());
    if landed[0] < 0.0
        || landed[1] < 0.0
        || landed[0] >= size.0 as f64
        || landed[1] >= size.1 as f64
    {
        return [0.0, 0.0];
    }
    let back = matched(field, size, frame, base, landed.map(|at| at as usize));
    match (there[0] + back[0]).hypot(there[1] + back[1]) <= RETURNS_WITHIN {
        true => there,
        false => [0.0, 0.0],
    }
}

/// How well `frame` shows something other than what `base` shows over `seed`, from 0 to 1, where
/// `seed` is `[left, top, right, bottom)` in cells.
///
/// A frame differs over the seed because the thing there is gone - which is what a reader removing
/// it wants - or because the whole frame changed. The second is told from the first by how far the
/// difference reaches: a thing that left is bounded, and a frame that moved differs everywhere.
///
/// **What this cannot tell apart.** Something else standing where the thing stood, and no larger
/// than it, reads exactly as ground would: a field of light and colour has no notion of what is
/// background. That is the reader's to see in the swatch, and nothing here pretends otherwise.
///
/// Zero where the frame reaches none of the seed, which refuses rather than guesses.
pub fn clears(
    field: &SeamField,
    size: (usize, usize),
    base: usize,
    frame: usize,
    seed: [usize; 4],
) -> f32 {
    let (w, h) = size;
    let apart = |p: usize| -> Option<f32> {
        let (here, there) = (field.frame(p, base)?, field.frame(p, frame)?);
        Some(differ(
            (here.raw() - there.raw()) as f32,
            field.tint(p, base),
            field.tint(p, frame),
        ))
    };

    let (mut over, mut over_of) = (0.0f32, 0usize);
    let mut changed = vec![false; w * h];
    let mut walk = Vec::new();
    for y in seed[1]..seed[3].min(h) {
        for x in seed[0]..seed[2].min(w) {
            let p = y * w + x;
            let Some(held) = apart(p) else { continue };
            (over, over_of) = (over + held, over_of + 1);
            if held > 0.0 && !changed[p] {
                changed[p] = true;
                walk.push(p);
            }
        }
    }
    if over_of == 0 {
        return 0.0;
    }

    // **How far the difference reaches, not a ring at some fixed distance.** The reader draws a seed
    // on a thing rather than around it, so a margin of any size can still be inside it. Walked out
    // from the seed instead, the difference stops where the two frames agree again - and grown past
    // the room a tile has, it is not a thing at all: the frame moved, or the light did, and there
    // is no ground in it to take.
    let most = (RING.over(Span::<Shrunk>::exact(w.max(h))).raw()).pow(2);
    let mut at = 0;
    while at < walk.len() {
        if walk.len() > most {
            return 0.0;
        }
        let p = walk[at];
        at += 1;
        for q in beside(p, size) {
            if !changed[q] && apart(q).is_some_and(|held| held > 0.0) {
                changed[q] = true;
                walk.push(q);
            }
        }
    }
    over / over_of as f32
}

/// A cell's four neighbours.
fn beside(p: usize, (w, h): (usize, usize)) -> impl Iterator<Item = usize> {
    let (x, y) = (p % w, p / w);
    [
        (x > 0).then(|| p - 1),
        (x + 1 < w).then_some(p + 1),
        (y > 0).then(|| p - w),
        (y + 1 < h).then_some(p + w),
    ]
    .into_iter()
    .flatten()
}

/// What the content around one point in one frame looks like, ready to be compared against
/// anywhere else in the field.
///
/// Weighted by a Gaussian of half the radius, so what the reader pointed *at* counts for more than
/// what happens to frame it.
pub struct Patch<'a> {
    field: &'a SeamField,
    size: (usize, usize),
    centre: (isize, isize),
    /// The offset within the patch, its weight, and the light and colour there.
    samples: Vec<(isize, isize, f32, [f32; 3])>,
    /// What every sample weighs together, which [`ENOUGH`] is a share of.
    whole: f32,
}

/// One offset the search answers with, and how well the patch matched there - lower is closer,
/// zero being identical.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Found {
    pub shift: [f64; 2],
    pub score: f32,
}

impl<'a> Patch<'a> {
    /// The patch `frame` shows around `centre`, or `None` where it reaches none of it.
    pub fn around(
        field: &'a SeamField,
        size: (usize, usize),
        frame: usize,
        centre: [usize; 2],
    ) -> Option<Patch<'a>> {
        let radius = Patch::radius(size);
        let sigma = radius as f32 / 2.0;
        let mut offsets = Vec::new();
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                let r2 = (dx * dx + dy * dy) as f32;
                if r2 <= (radius * radius) as f32 {
                    offsets.push(([dx, dy], (-r2 / (2.0 * sigma * sigma)).exp()));
                }
            }
        }
        Patch::over(field, size, frame, centre, offsets)
    }

    /// What `frame` shows at `offsets` from `centre`, each at its own weight, or `None` where it
    /// reaches none of them.
    ///
    /// For a patch that is not a disc: the ground around a hole, compared without the thing in it.
    pub fn over(
        field: &'a SeamField,
        size: (usize, usize),
        frame: usize,
        centre: [usize; 2],
        offsets: impl IntoIterator<Item = ([isize; 2], f32)>,
    ) -> Option<Patch<'a>> {
        let (cx, cy) = (centre[0] as isize, centre[1] as isize);
        let samples: Vec<(isize, isize, f32, [f32; 3])> = offsets
            .into_iter()
            .filter_map(|([dx, dy], weight)| {
                sample(field, size, frame, cx + dx, cy + dy).map(|held| (dx, dy, weight, held))
            })
            .collect();
        let whole: f32 = samples.iter().map(|&(_, _, weight, _)| weight).sum();
        (whole > 0.0).then_some(Patch {
            field,
            size,
            centre: (cx, cy),
            samples,
            whole,
        })
    }

    /// The patch's radius in cells on a field of `size`.
    pub fn radius(size: (usize, usize)) -> isize {
        let long = Span::<Shrunk>::exact(size.0.max(size.1));
        PATCH.over(long).raw().max(1) as isize
    }

    /// How far this patch is from what `frame` shows `[ox, oy]` cells away, or `None` where too
    /// little of `frame` reaches to judge.
    ///
    /// The light difference's weighted mean is taken out, which is what makes two exposures of one
    /// face match: `sum w (e - mean)^2 = sum w e^2 - (sum w e)^2 / sum w`.
    pub fn against(&self, frame: usize, offset: [isize; 2]) -> Option<f32> {
        self.compared(frame, offset).map(|(score, _)| score)
    }

    /// How much brighter `frame` is `offset` away than this patch, on average: what a fill read from
    /// there has to be taken down by to meet the light around it.
    pub fn gap(&self, frame: usize, offset: [isize; 2]) -> Option<Stops> {
        self.compared(frame, offset)
            .map(|(_, gap)| Stops::measured(f64::from(gap)))
    }

    /// [`Patch::against`] and [`Patch::gap`] together, which are one pass over the samples.
    fn compared(&self, frame: usize, [ox, oy]: [isize; 2]) -> Option<(f32, f32)> {
        let (cx, cy) = self.centre;
        let (mut weight, mut gap, mut squares) = (0.0f32, 0.0f32, 0.0f32);
        for &(dx, dy, w, held) in &self.samples {
            if let Some(there) = sample(self.field, self.size, frame, cx + dx + ox, cy + dy + oy) {
                let light = there[0] - held[0];
                let colour = (there[1] - held[1]).powi(2) + (there[2] - held[2]).powi(2);
                weight += w;
                gap += w * light;
                squares += w * (light * light + TINT_WEIGHT * colour);
            }
        }
        if weight < ENOUGH * self.whole {
            return None;
        }
        Some(((squares - gap * gap / weight) / weight, gap / weight))
    }

    /// Where in `frame` this patch is matched best, closest first, at most `most` of them and no
    /// two within a patch radius of each other.
    ///
    /// **Separated, because the offsets either side of a match are that match.** A caller offering
    /// a reader somewhere else to take their picture from is offering places, and a list of one
    /// place named five times is a list of one.
    pub fn ranked(&self, frame: usize, most: usize) -> Vec<Found> {
        let long = Span::<Shrunk>::exact(self.size.0.max(self.size.1));
        let reach = SEARCH.over(long).raw() as isize;
        self.ranked_within(frame, most, reach, Patch::radius(self.size), |_| true)
    }

    /// [`Patch::ranked`] out to `reach` cells either way, no two places within `apart` of each
    /// other, and only the offsets `allowed` admits.
    ///
    /// `allowed` is asked in order of how well each offset matched and only until `most` are kept,
    /// so a test that walks a whole region is paid for a handful of offsets rather than every one.
    pub fn ranked_within(
        &self,
        frame: usize,
        most: usize,
        reach: isize,
        apart: isize,
        allowed: impl Fn([isize; 2]) -> bool,
    ) -> Vec<Found> {
        let mut scored: Vec<((isize, isize), f32)> = Vec::new();
        for oy in -reach..=reach {
            for ox in -reach..=reach {
                if let Some(score) = self.against(frame, [ox, oy]) {
                    scored.push(((ox, oy), score));
                }
            }
        }
        scored.sort_by(|a, b| a.1.total_cmp(&b.1));

        let mut found: Vec<Found> = Vec::new();
        for ((ox, oy), score) in scored {
            if found.len() == most {
                break;
            }
            let near = found.iter().any(|held| {
                (held.shift[0] - ox as f64).abs() < apart as f64
                    && (held.shift[1] - oy as f64).abs() < apart as f64
            });
            if !near && allowed([ox, oy]) {
                found.push(Found {
                    shift: self.refined(frame, (ox, oy), score),
                    score,
                });
            }
        }
        found
    }

    /// `at` to within a cell, by the parabola through the scores either side of it on each axis.
    fn refined(&self, frame: usize, (ox, oy): (isize, isize), best: f32) -> [f64; 2] {
        let refine = |before: Option<f32>, after: Option<f32>| -> f64 {
            let (Some(before), Some(after)) = (before, after) else {
                return 0.0;
            };
            let curve = before - 2.0 * best + after;
            match curve > 0.0 {
                true => f64::from(0.5 * (before - after) / curve).clamp(-0.5, 0.5),
                false => 0.0,
            }
        };
        [
            ox as f64
                + refine(
                    self.against(frame, [ox - 1, oy]),
                    self.against(frame, [ox + 1, oy]),
                ),
            oy as f64
                + refine(
                    self.against(frame, [ox, oy - 1]),
                    self.against(frame, [ox, oy + 1]),
                ),
        ]
    }
}

/// The light and colour `frame` shows at a cell, or `None` off the field or where it did not reach.
fn sample(
    field: &SeamField,
    (w, h): (usize, usize),
    frame: usize,
    x: isize,
    y: isize,
) -> Option<[f32; 3]> {
    if x < 0 || y < 0 || x >= w as isize || y >= h as isize {
        return None;
    }
    let p = y as usize * w + x as usize;
    let level = field.frame(p, frame)?.raw() as f32;
    let [u, v] = field.tint(p, frame).map(|t| t.raw() as f32);
    Some([level, u, v])
}

/// [`tracked`] one way, without the check: the merge's policy over [`Patch::ranked`].
fn matched(
    field: &SeamField,
    size: (usize, usize),
    base: usize,
    frame: usize,
    centre: [usize; 2],
) -> [f64; 2] {
    let Some(patch) = Patch::around(field, size, base, centre) else {
        return [0.0, 0.0];
    };
    let Some(still) = patch.against(frame, [0, 0]) else {
        return [0.0, 0.0];
    };
    if still <= (STILL.raw() * STILL.raw()) as f32 {
        return [0.0, 0.0];
    }
    let Some(best) = patch.ranked(frame, 1).first().copied() else {
        return [0.0, 0.0];
    };
    if best.score >= still || best.score > MOVED_BY * still {
        return [0.0, 0.0];
    }
    best.shift
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly_seam::NOT_REACHED;

    const SIZE: (usize, usize) = (240, 200);

    /// Two frames of textured ground, a bright disc on it at `from` in the first and at `to` in the
    /// second, where the second shows the ground at `from`.
    fn texture(x: isize, y: isize) -> f32 {
        let hashed = ((x as usize).wrapping_mul(73_856_093)
            ^ (y as usize).wrapping_mul(19_349_663))
        .wrapping_mul(2_654_435_761);
        (hashed >> 16) as u8 as f32 / 255.0 * 0.3
    }

    fn moved(from: [usize; 2], to: [usize; 2]) -> SeamField {
        let (w, h) = SIZE;
        let mut level = Vec::new();
        let mut tint = Vec::new();
        for p in 0..w * h {
            let (x, y) = ((p % w) as isize, (p / w) as isize);
            level.push(0.0);
            for at in [from, to] {
                let (dx, dy) = (x - at[0] as isize, y - at[1] as isize);
                let inside = dx * dx + dy * dy < 36;
                level.push(match inside {
                    true => 2.0 + texture(dx + 1000, dy + 1000),
                    false => texture(x, y),
                });
                tint.extend([if inside { 0.5 } else { 0.0 }, 0.0]);
            }
        }
        SeamField {
            level,
            tint,
            sources: 2,
        }
    }

    #[test]
    fn a_disc_that_moved_is_found_where_it_went() {
        let field = moved([100, 100], [112, 95]);
        let [dx, dy] = tracked(&field, SIZE, 0, 1, [100, 100]);
        assert!(
            (dx - 12.0).abs() < 0.5 && (dy + 5.0).abs() < 0.5,
            "found {dx}, {dy}"
        );
    }

    #[test]
    fn a_lookalike_that_stood_still_is_not_where_the_disc_went() {
        // The disc in the base is gone from the second frame, and a copy of it stands still
        // elsewhere in both: the copy matches, and tracks back to itself.
        let mut field = moved([100, 100], [140, 110]);
        let (w, _) = SIZE;
        for p in 0..w * SIZE.1 {
            let (x, y) = ((p % w) as isize, (p / w) as isize);
            let (dx, dy) = (x - 140, y - 110);
            if dx * dx + dy * dy < 36 {
                field.level[p * 3 + 1] = field.level[p * 3 + 2];
                field.tint[p * 4] = field.tint[p * 4 + 2];
            }
        }
        assert_eq!(tracked(&field, SIZE, 0, 1, [100, 100]), [0.0, 0.0]);
    }

    /// A reader is offered places, not the offsets either side of one place: two discs in the other
    /// frame come back as two, nearest match first.
    #[test]
    fn every_place_the_patch_matches_is_offered_once() {
        let mut field = moved([100, 100], [112, 95]);
        let (w, h) = SIZE;
        for p in 0..w * h {
            let (x, y) = ((p % w) as isize, (p / w) as isize);
            let (dx, dy) = (x - 92, y - 108);
            if dx * dx + dy * dy < 36 {
                field.level[p * 3 + 2] = 2.0 + texture(dx + 1000, dy + 1000);
                field.tint[p * 4 + 2] = 0.5;
            }
        }
        let patch = Patch::around(&field, SIZE, 0, [100, 100]).expect("a patch");
        let found = patch.ranked(1, 4);

        let places: Vec<[i64; 2]> = found
            .iter()
            .map(|f| f.shift.map(|d| d.round() as i64))
            .collect();
        assert!(places.contains(&[12, -5]), "{places:?}");
        assert!(places.contains(&[-8, 8]), "{places:?}");
        assert!(
            found[0].score <= found[1].score && found[1].score <= found[2].score,
            "{found:?}",
        );
        let apart = Patch::radius(SIZE) as f64;
        for (i, held) in found.iter().enumerate() {
            for other in &found[i + 1..] {
                let gap = (held.shift[0] - other.shift[0])
                    .abs()
                    .max((held.shift[1] - other.shift[1]).abs());
                assert!(gap >= apart, "{held:?} and {other:?} are one place");
            }
        }
    }

    /// What a reader removing something is offered: a frame that no longer shows it there, and not
    /// one that still does.
    #[test]
    fn a_frame_clears_a_seed_only_when_the_thing_has_left_it() {
        let seed = [94, 94, 107, 107];
        let gone = moved([100, 100], [140, 130]);
        let stayed = moved([100, 100], [100, 100]);

        let left = clears(&gone, SIZE, 0, 1, seed);
        let held = clears(&stayed, SIZE, 0, 1, seed);
        assert!(left > 0.5, "a frame the disc left clears only {left}");
        assert!(held < 0.05, "a frame still showing it clears {held}");
    }

    /// Nor a frame that changed everywhere: it differs over the seed just as well, and how far the
    /// difference reaches is what tells the two apart.
    #[test]
    fn a_frame_that_changed_everywhere_does_not_clear() {
        let seed = [94, 94, 107, 107];
        let mut relit = moved([100, 100], [140, 130]);
        for p in 0..SIZE.0 * SIZE.1 {
            relit.level[p * 3 + 2] += 2.0;
        }
        let score = clears(&relit, SIZE, 0, 1, seed);
        assert_eq!(
            score, 0.0,
            "a frame two stops brighter everywhere clears {score}"
        );
    }

    #[test]
    fn content_that_stayed_stays() {
        let field = moved([100, 100], [100, 100]);
        assert_eq!(tracked(&field, SIZE, 0, 1, [100, 100]), [0.0, 0.0]);
    }

    #[test]
    fn a_frame_that_reaches_none_of_the_search_stays() {
        let mut field = moved([100, 100], [112, 95]);
        for p in 0..SIZE.0 * SIZE.1 {
            field.level[p * 3 + 2] = NOT_REACHED;
        }
        assert_eq!(tracked(&field, SIZE, 0, 1, [100, 100]), [0.0, 0.0]);
    }
}
