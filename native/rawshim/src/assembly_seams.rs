//! Seams for the reader's picks: where the frames actually picked meet.
//!
//! A tile is the least of what its pick takes, drawn by the reader around what they wanted; the
//! question is where *these* frames agree around it. So the tiles become the data term of a
//! labelling over the picked frames only (`assembly_labelling`), the seams go wherever that
//! labelling puts them, and each piece is balanced to the light across them (`assembly_balance`).

use crate::assembly::{Assembly, Takes};
use crate::assembly_analysis::{MOST_TILES, MOST_VERTICES, corridor_share};
use crate::assembly_balance::balanced;
use crate::assembly_labelling::{Labelled, RING, Reader, labelling, stamped};
use crate::assembly_seam::SHRINK;
use crate::assembly_tiles::{Cell, W_MAX, enclosing, lobes, subdivide};
use crate::assembly_volume::Volume;
use crate::px::{Composite, Extent, Share, Shrunk, Span};
use serde::{Deserialize, Serialize};

/// A labelling of the canvas into pieces, each taking one frame.
///
/// Stated for the picks it was solved for, so a render can refuse seams that no longer describe
/// the recipe beside them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Seams {
    pub pick: Vec<usize>,
    /// What each tile asked for when these were solved. Empty where every tile asked for its
    /// subject, which is what a recipe written before removal existed meant.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub takes: Vec<Takes>,
    pub base: usize,
    /// Canvas pixels, as `Assembly::vertices` are.
    pub vertices: Vec<[f32; 2]>,
    pub tiles: Vec<Vec<u32>>,
    /// The frame each piece takes.
    pub source: Vec<usize>,
    /// The tile each piece grew from, which a click on it opens.
    pub zone: Vec<usize>,
    /// As `Drawing::corridor`: a share of the long edge.
    pub corridor: Vec<f32>,
    /// As `Drawing::warp`: where a piece's frame is read so that what it shows lands where the base
    /// showed it.
    pub warp: Vec<[f32; 6]>,
    /// What a piece's frame's light is multiplied by to meet what lies across its seams.
    pub exposure: Vec<f32>,
}

/// The seams `recipe`'s picks call for, over the analysis's `volume`.
pub fn solve(recipe: &Assembly, volume: &Volume) -> Result<Seams, String> {
    Ok(balance(recipe, volume, &layout(recipe, volume)?))
}

/// Where each picked frame is taken: everything [`solve`] answers but [`Seams::exposure`], which
/// hangs on the recipe's feather and nothing else here, so a caller holding one answers a new
/// feather through [`balance`] without cutting again.
pub struct Layout {
    /// The frame each cell takes.
    label: Vec<u8>,
    /// Per tile, in cells, where its pick shows what the base shows under it.
    shift: Vec<[f64; 2]>,
    /// Per piece of `seams`, the frame and the drawn tile it is read through.
    keys: Vec<(usize, u32)>,
    seams: Seams,
}

pub fn layout(recipe: &Assembly, volume: &Volume) -> Result<Layout, String> {
    let labelled = labelling(recipe, volume)?;
    let (seams, keys) = pieces(recipe, volume, &labelled)?;
    Ok(Layout {
        label: labelled.label.iter().map(|&s| s as u8).collect(),
        shift: labelled.shift,
        keys,
        seams,
    })
}

/// `layout`'s seams, each piece balanced over a band as wide as `recipe`'s feather.
pub fn balance(recipe: &Assembly, volume: &Volume, layout: &Layout) -> Seams {
    let long = Span::<Shrunk>::exact(volume.shrunk.0.max(volume.shrunk.1));
    let stamp = stamped(recipe, volume, RING.over(long).raw(), Some(&layout.shift));
    let label: Vec<usize> = layout.label.iter().map(|&s| usize::from(s)).collect();
    let reader = Reader {
        volume,
        shift: &stamp.shift,
        shifted_by: &stamp.shifted_by,
    };
    let band = recipe.feather().over(long).raw();
    let gain = balanced(&reader, &label, recipe.base, band);
    Seams {
        exposure: layout
            .keys
            .iter()
            .map(|key| gain.get(key).map_or(1.0, |g| g.raw() as f32))
            .collect(),
        ..layout.seams.clone()
    }
}

/// The labelling as polygons on the canvas: a frame's cells split by the tile each was read
/// through, since each is drawn under that tile's shift.
///
/// With each piece's frame and the tile it is read through, which [`balanced`] answers by.
fn pieces(
    recipe: &Assembly,
    volume: &Volume,
    labelled: &Labelled,
) -> Result<(Seams, Vec<(usize, u32)>), String> {
    let Labelled {
        label,
        shift,
        shifted_by,
    } = labelled;
    let size = volume.shrunk;
    let sources = volume.field.sources;
    let long = Span::<Shrunk>::exact(size.0.max(size.1));
    let open_ground = Extent::<Shrunk>::exactly(2.0 * W_MAX.across(long).raw());
    // Never `NO_TILE` for a frame other than the base: a cell is only offered one within the ring
    // of a tile picking it, which is where the reading was stamped.
    let read_by = |p: usize| shifted_by[p * sources + label[p]];
    let mut taken: Vec<(usize, u32)> = (0..label.len())
        .filter(|&p| label[p] != recipe.base)
        .map(|p| (label[p], read_by(p)))
        .collect();
    taken.sort_unstable();
    taken.dedup();
    let whole: Vec<Cell> = taken
        .iter()
        .map(|&(s, by)| Cell {
            label: 1 << s,
            inside: (0..label.len())
                .map(|p| label[p] == s && read_by(p) == by)
                .collect(),
            corridor: open_ground,
        })
        .collect();
    let mut cells = lobes(&whole, size);
    // Largest first, so a piece enclosed by another is drawn over it rather than under it.
    cells.sort_by_key(|c| std::cmp::Reverse(c.inside.iter().filter(|held| **held).count()));

    let mut keys = Vec::new();
    for cell in &cells {
        let first = cell
            .inside
            .iter()
            .position(|&held| held)
            .expect("a lobe holds a cell");
        keys.push((cell.label.trailing_zeros() as usize, read_by(first)));
    }

    let mut sub = subdivide(&cells, size, SHRINK as f32);
    let kept = enclosing(&sub);
    let onto = |at: f32, from: usize, to: usize| -> f32 {
        Share::measured(f64::from(at), from as f64)
            .across(Span::<Composite>::exact(to))
            .raw() as f32
    };
    let canvas = recipe.spec.canvas;
    let vertices: Vec<[f32; 2]> = std::mem::take(&mut sub.vertices)
        .into_iter()
        .map(|v| {
            [
                onto(v[0], volume.plane.0, canvas[0]),
                onto(v[1], volume.plane.1, canvas[1]),
            ]
        })
        .collect();
    let seams = Seams {
        pick: recipe.pick.clone(),
        takes: recipe.takes.clone(),
        base: recipe.base,
        tiles: kept.iter().map(|&t| sub.tiles[t].clone()).collect(),
        source: kept.iter().map(|&t| keys[t].0).collect(),
        zone: kept.iter().map(|&t| keys[t].1 as usize).collect(),
        corridor: kept
            .iter()
            .map(|&t| {
                // Bounded by its own depth alone: the render caps it at the recipe's feather, which
                // the reader moves without solving again.
                let room = Extent::exactly(long.raw() as f64);
                corridor_share(&cells[t].inside, size, room).raw() as f32
            })
            .collect(),
        warp: kept
            .iter()
            .map(|&piece| {
                let [dx, dy] = shift[keys[piece].1 as usize];
                let cells = |d: f64| d as f32 * SHRINK as f32;
                [
                    1.0,
                    0.0,
                    0.0,
                    1.0,
                    onto(cells(dx), volume.plane.0, canvas[0]),
                    onto(cells(dy), volume.plane.1, canvas[1]),
                ]
            })
            .collect(),
        exposure: Vec::new(),
        vertices,
    };
    if seams.tiles.len() > MOST_TILES {
        return Err(format!("the seams made {} pieces", seams.tiles.len()));
    }
    if seams.vertices.len() > MOST_VERTICES {
        return Err(format!("the seams made {} vertices", seams.vertices.len()));
    }
    Ok((seams, kept.iter().map(|&piece| keys[piece]).collect()))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::assembly_seam::SeamField;
    use crate::composition::{Composition, LensSpec};

    /// Large enough that [`RING`] is seventy-two cells.
    pub(crate) const SIZE: (usize, usize) = (240, 200);
    pub(crate) const TILE: [usize; 4] = [18, 0, 60, 200];
    pub(crate) const MOVED: [usize; 4] = [16, 5, 26, 35];

    /// Two frames that agree everywhere but `moved`, `[left, top, right, bottom)` in cells, where
    /// the second is two stops brighter.
    pub(crate) fn burst(moved: [usize; 4]) -> Volume {
        let (w, h) = SIZE;
        let inside = |[l, t, r, b]: [usize; 4], p: usize| {
            let (x, y) = (p % w, p / w);
            x >= l && x < r && y >= t && y < b
        };
        let mut level = Vec::new();
        for p in 0..w * h {
            level.extend([0.0, 0.0, if inside(moved, p) { 2.0 } else { 0.0 }]);
        }
        Volume {
            plane: (w * SHRINK, h * SHRINK),
            shrunk: SIZE,
            field: SeamField {
                level,
                tint: vec![0.0; w * h * 4],
                sources: 2,
            },
        }
    }

    /// Two frames on the base, and no tile yet.
    pub(crate) fn untiled() -> Assembly {
        let mut spec = Composition::of_one([SIZE.0 * SHRINK, SIZE.1 * SHRINK], LensSpec::none());
        spec.sources.push(spec.sources[0].clone());
        Assembly {
            feather: 0.03,
            ..Assembly::untiled(spec)
        }
    }

    /// `recipe` with a tile drawn over `cells` (`[left, top, right, bottom)`), picking `pick`.
    pub(crate) fn drawn(mut recipe: Assembly, [l, t, r, b]: [usize; 4], pick: usize) -> Assembly {
        let first = recipe.vertices.len() as u32;
        let at = |c: usize| (c * SHRINK) as f32;
        recipe.vertices.extend([
            [at(l), at(t)],
            [at(r), at(t)],
            [at(r), at(b)],
            [at(l), at(b)],
        ]);
        recipe.tiles.push((first..first + 4).collect());
        recipe.pick.push(pick);
        recipe
    }

    #[test]
    fn a_tile_nobody_moved_off_the_base_has_no_pieces() {
        let volume = burst(MOVED);
        let seams = solve(&drawn(untiled(), TILE, 0), &volume).expect("seams");

        assert!(seams.tiles.is_empty(), "{seams:?}");
        assert_eq!((seams.pick.clone(), seams.base), (vec![0], 0));
    }

    #[test]
    fn a_picked_tile_is_one_piece_that_opens_it() {
        let volume = burst(MOVED);
        let seams = solve(&drawn(untiled(), TILE, 1), &volume).expect("seams");

        assert_eq!(seams.source, vec![1]);
        assert_eq!(seams.zone, vec![0]);
        assert!(seams.tiles[0].len() >= 3);
        let canvas = [SIZE.0 * SHRINK, SIZE.1 * SHRINK];
        for [x, y] in &seams.vertices {
            assert!(
                *x >= -1.0
                    && *x <= canvas[0] as f32 + 1.0
                    && *y >= -1.0
                    && *y <= canvas[1] as f32 + 1.0
            );
        }
    }

    #[test]
    fn a_seed_on_something_that_moved_takes_it_from_where_it_went() {
        // A face at `from` in the base and at `to` in the other frame, over ground the two share:
        // read in place, the other frame shows ground where the base shows the face.
        let (w, h) = SIZE;
        let (from, to) = ([60isize, 60isize], [75isize, 52isize]);
        let texture = |x: isize, y: isize| {
            let hashed = ((x as usize).wrapping_mul(73_856_093)
                ^ (y as usize).wrapping_mul(19_349_663))
            .wrapping_mul(2_654_435_761);
            (hashed >> 16) as u8 as f32 / 255.0 * 0.3
        };
        let mut level = Vec::new();
        let mut tint = Vec::new();
        for p in 0..w * h {
            let (x, y) = ((p % w) as isize, (p / w) as isize);
            level.push(0.0);
            for at in [from, to] {
                let (dx, dy) = (x - at[0], y - at[1]);
                let inside = dx * dx + dy * dy < 64;
                level.push(match inside {
                    true => 2.0 + texture(dx + 1000, dy + 1000),
                    false => texture(x, y),
                });
                tint.extend([if inside { 0.5 } else { 0.0 }, 0.0]);
            }
        }
        let mut volume = burst([0, 0, 0, 0]);
        volume.field.level = level;
        volume.field.tint = tint;
        let seed = [59, 59, 62, 62];

        let seams = solve(&drawn(untiled(), seed, 1), &volume).expect("seams");

        let taken = seams
            .zone
            .iter()
            .position(|&z| z == 0)
            .expect("the seed's piece");
        let [a, b, c, d, tx, ty] = seams.warp[taken];
        assert_eq!([a, b, c, d], [1.0, 0.0, 0.0, 1.0]);
        let moved = [(to[0] - from[0]) as f32, (to[1] - from[1]) as f32].map(|m| m * SHRINK as f32);
        assert!(
            (tx - moved[0]).abs() <= 2.0 && (ty - moved[1]).abs() <= 2.0,
            "read at {tx}, {ty} rather than {moved:?}"
        );
    }

    /// A field with a disc at `from` in the base and at `to` in the other frame, over textured
    /// ground the two otherwise share, and a seed drawn over the base's disc.
    fn a_disc_that_moved(from: [isize; 2], to: [isize; 2]) -> (Volume, [usize; 4]) {
        let (w, h) = SIZE;
        let texture = |x: isize, y: isize| {
            let hashed = ((x as usize).wrapping_mul(73_856_093)
                ^ (y as usize).wrapping_mul(19_349_663))
            .wrapping_mul(2_654_435_761);
            (hashed >> 16) as u8 as f32 / 255.0 * 0.3
        };
        let mut level = Vec::new();
        let mut tint = Vec::new();
        for p in 0..w * h {
            let (x, y) = ((p % w) as isize, (p / w) as isize);
            level.push(0.0);
            for at in [from, to] {
                let (dx, dy) = (x - at[0], y - at[1]);
                let inside = dx * dx + dy * dy < 64;
                level.push(match inside {
                    true => 2.0 + texture(dx + 1000, dy + 1000),
                    false => texture(x, y),
                });
                tint.extend([if inside { 0.5 } else { 0.0 }, 0.0]);
            }
        }
        let mut volume = burst([0, 0, 0, 0]);
        volume.field.level = level;
        volume.field.tint = tint;
        let seed = [
            from[0] as usize - 1,
            from[1] as usize - 1,
            from[0] as usize + 2,
            from[1] as usize + 2,
        ];
        (volume, seed)
    }

    /// A seed that asks for the ground takes what stands there instead, rather than following the
    /// subject to wherever it went.
    ///
    /// **The same field as the test above, and the opposite answer.** Tracking is what makes a
    /// merge replace a face with that face; a removal is the one case where finding the subject
    /// again is precisely the wrong answer, because the reader is trying to be rid of it.
    #[test]
    fn a_seed_asking_for_the_ground_does_not_follow_the_subject() {
        let (volume, seed) = a_disc_that_moved([60, 60], [75, 52]);
        let mut recipe = drawn(untiled(), seed, 1);
        recipe.takes = vec![Takes::Ground];

        let seams = solve(&recipe, &volume).expect("seams");

        let taken = seams
            .zone
            .iter()
            .position(|&z| z == 0)
            .expect("the seed's piece");
        assert_eq!(seams.source[taken], 1);
        assert_eq!(
            seams.warp[taken],
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            "the ground is read where it stands",
        );
    }

    /// A frame that still shows the thing is refused rather than answered with a seam around
    /// nothing, which is what the reader would otherwise be offered and unable to tell apart from a
    /// solve that did not work.
    #[test]
    fn a_frame_that_still_shows_the_thing_is_no_ground_to_take() {
        let (volume, seed) = a_disc_that_moved([60, 60], [60, 60]);
        let mut recipe = drawn(untiled(), seed, 1);
        recipe.takes = vec![Takes::Ground];

        let refused = solve(&recipe, &volume).expect_err("a refusal");
        assert!(refused.contains("still shows"), "{refused}");

        // And the same seed against a frame it did leave is answered.
        let (left, seed) = a_disc_that_moved([60, 60], [75, 52]);
        let mut recipe = drawn(untiled(), seed, 1);
        recipe.takes = vec![Takes::Ground];
        assert!(solve(&recipe, &left).is_ok());
    }

    /// And the recipes written before a tile could ask for anything still ask for the subject.
    #[test]
    fn a_tile_that_says_nothing_asks_for_its_subject() {
        let (volume, seed) = a_disc_that_moved([60, 60], [75, 52]);
        let recipe = drawn(untiled(), seed, 1);
        assert!(recipe.takes.is_empty());
        assert_eq!(recipe.takes(0), Takes::Subject);

        let seams = solve(&recipe, &volume).expect("seams");
        let taken = seams
            .zone
            .iter()
            .position(|&z| z == 0)
            .expect("the seed's piece");
        let [.., tx, ty] = seams.warp[taken];
        assert!(tx != 0.0 || ty != 0.0, "the subject was followed");
    }

    #[test]
    fn a_seeds_frame_is_brought_to_the_light_across_its_seams() {
        // The other frame metered brighter everywhere, and shows a figure brighter still.
        let mut volume = burst(MOVED);
        for p in 0..SIZE.0 * SIZE.1 {
            volume.field.level[p * 3 + 2] += 0.4;
        }
        let seams = solve(&drawn(untiled(), [19, 18, 22, 21], 1), &volume).expect("seams");

        let taken = seams
            .source
            .iter()
            .position(|&s| s == 1)
            .expect("the seed's piece");
        let stops = f64::from(seams.exposure[taken]).log2();
        assert!((stops + 0.4).abs() < 0.02, "balanced by {stops} stops");

        let mut recipe = drawn(untiled(), [19, 18, 22, 21], 1);
        recipe.seams = Some(seams.clone());
        let drawing = recipe.rendered().expect("a render");
        assert_eq!(drawing.gain[taken].raw() as f32, seams.exposure[taken]);
    }

    #[test]
    fn a_volume_is_refused_for_a_recipe_of_other_frames() {
        let mut recipe = drawn(untiled(), TILE, 1);
        recipe.spec.sources.push(recipe.spec.sources[0].clone());
        assert!(solve(&recipe, &burst(MOVED)).is_err());
    }

    #[test]
    fn a_render_takes_each_piece_under_its_own_warp_and_balance_and_refuses_stale_seams() {
        let mut recipe = drawn(untiled(), TILE, 1);
        let mut seams = solve(&recipe, &burst(MOVED)).expect("seams");
        let shifted = [1.0, 0.0, 0.0, 1.0, 3.0, 0.0];
        (seams.warp[0], seams.exposure[0]) = (shifted, 1.5);
        recipe.seams = Some(seams);

        let drawing = recipe.rendered().expect("a render");
        assert_eq!(drawing.pick, vec![1]);
        assert_eq!(drawing.warp_of(0), shifted.map(f64::from));
        assert_eq!(drawing.gain[0].raw(), 1.5);

        recipe.pick = vec![0];
        assert!(recipe.rendered().is_err());
    }

    /// A tile flipped between its subject and the ground names the same frame, so the picks alone
    /// cannot tell the seams beside it are for another shape.
    #[test]
    fn seams_solved_for_a_subject_are_refused_for_a_tile_asking_for_the_ground() {
        let mut recipe = drawn(untiled(), TILE, 1);
        recipe.seams = Some(solve(&recipe, &burst(MOVED)).expect("seams"));
        assert!(recipe.rendered().is_ok());

        recipe.takes = vec![Takes::Ground];
        assert!(recipe.rendered().is_err());

        // While naming every subject is the same recipe as naming nothing.
        recipe.takes = vec![Takes::Subject];
        assert!(recipe.rendered().is_ok());
    }
}
