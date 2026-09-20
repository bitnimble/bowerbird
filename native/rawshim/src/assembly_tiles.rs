//! The pieces a seam solve's labelling becomes: split into lobes, traced, and stitched into one
//! subdivision whose neighbours share the vertices along every boundary they meet on (§3.7).
//!
//! Host code for `dust.rs`'s reason and no other - a contour walk over a mask a solve produced, at
//! the shrunk scale, where a piece's boundary is a few hundred points. There is no arithmetic over
//! a picture here.

use crate::px::{Extent, Share, Shrunk, Span};
use std::collections::{HashMap, HashSet};

/// The smallest a 4-connected lobe of a solved region may be, as a share of the canvas's area.
///
/// A shattered region on open ground leaves specks of a few plane pixels, some with no pixel centre
/// inside at all; dropped, their ground stays base. 1e-5 of a 3000x2010 analysis canvas is 3.8
/// shrunk cells, bounded at 18 pixels of a 24MP frame.
pub const MIN_LOBE_AREA: f32 = 1e-5;

/// §5.2's ceiling on the feather's half-width, as a share of the long edge.
pub const W_MAX: Share = Share::of(1, 100);

/// One region of a solve's labelling, and the room its seam has.
#[derive(Clone, Debug)]
pub struct Cell {
    /// Bitmask of the frames the region takes; `assembly_seams` sets one bit.
    pub label: u32,
    /// The region, at the shrunk scale of §3.4.
    pub inside: Vec<bool>,
    /// The room the seam has, in shrunk pixels.
    pub corridor: Extent<Shrunk>,
}

/// A planar subdivision: one vertex list, and a loop of indices into it a tile.
#[derive(Clone, Debug)]
pub struct Subdivision {
    /// Canvas pixels, centre to centre: the block a shrunk cell covers is `scale` wide, so a shrunk
    /// coordinate `s` lands at `s * scale + (scale - 1) / 2`.
    pub vertices: Vec<[f32; 2]>,
    /// One closed loop of vertex indices a cell, in the order the cells were given. Not closed by
    /// repetition: the last vertex joins the first.
    pub tiles: Vec<Vec<u32>>,
}

/// §3.7: a quarter of the corridor, and never so much that the feather beyond it reaches past it -
/// `tolerance + w_low <= corridor`.
///
/// The corridor is a clearance from the contour, so §5.2's `w_low` of half of it leaves the quarter
/// this asks for untouched; the second bound is for a caller that feathers wider than that.
///
/// The floor of a quarter pixel is what a corridor narrower than its own feather gets. There the
/// constraint asks for less than the traced staircase's own step, and something has to bound the
/// vertex count.
pub fn tolerance_for(corridor: Extent<Shrunk>, w_low: Extent<Shrunk>) -> Extent<Shrunk> {
    let (corridor, w_low) = (corridor.raw(), w_low.raw());
    Extent::exactly((corridor / 4.0).min((corridor - w_low).max(0.25)))
}

/// The contour of `inside` as one closed loop, in shrunk pixels: marching squares over the mask.
///
/// A point is the midpoint of a crossed edge, so **two adjacent regions trace the same points along
/// the boundary they share** - a crossing is a property of the pixel pair, not of which side of it
/// is being traced. That is what lets [`subdivide`] simplify a shared boundary once instead of
/// twice.
// ponytail: one loop, the one through the lowest crossing, so a mask that holds a hole traces the
// lobe it began in. `lobes` splits a cell into its 4-connected components, so a pinched region arrives
// here as two cells, and `Assembly::tiles` is one loop a tile and could not carry a hole in any
// case. Foreground at a diagonal is separated rather than joined: under the other rule two cells
// pinching against each other both claim the middle of a saddle window, which is a pixel in two
// tiles rather than a half-pixel of ground in neither.
pub fn trace(inside: &[bool], size: (usize, usize)) -> Vec<[f32; 2]> {
    let mut links: HashMap<[i32; 2], Vec<[i32; 2]>> = HashMap::new();
    for (a, b) in segments(inside, size) {
        links.entry(a).or_default().push(b);
        links.entry(b).or_default().push(a);
    }
    let Some(&start) = links.keys().min() else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let (mut before, mut here) = (None, start);
    loop {
        out.push(point_of(here));
        let Some(&next) = links[&here].iter().find(|&&n| Some(n) != before) else {
            break;
        };
        if next == start {
            break;
        }
        before = Some(here);
        here = next;
    }
    out
}

/// Every contour segment, as a pair of crossing midpoints in **doubled** integer coordinates, so
/// that two traces of the same crossing name it with the same key and no epsilon is needed to say
/// so. A vertical crossing keys as `[odd, even]` and a horizontal one as `[even, odd]`, which is
/// what [`sides_of`] reads back to find the two pixels it separates.
fn segments(inside: &[bool], size: (usize, usize)) -> Vec<([i32; 2], [i32; 2])> {
    let (w, h) = size;
    let at = |x: isize, y: isize| {
        x >= 0 && y >= 0 && x < w as isize && y < h as isize && inside[y as usize * w + x as usize]
    };
    let mut out = Vec::new();
    for y in -1..h as isize {
        for x in -1..w as isize {
            let case = at(x, y) as usize
                | (at(x + 1, y) as usize) << 1
                | (at(x + 1, y + 1) as usize) << 2
                | (at(x, y + 1) as usize) << 3;
            let (kx, ky) = (2 * x as i32, 2 * y as i32);
            let (top, right) = ([kx + 1, ky], [kx + 2, ky + 1]);
            let (bottom, left) = ([kx + 1, ky + 2], [kx, ky + 1]);
            match case {
                1 | 14 => out.push((top, left)),
                2 | 13 => out.push((top, right)),
                3 | 12 => out.push((left, right)),
                4 | 11 => out.push((right, bottom)),
                6 | 9 => out.push((top, bottom)),
                7 | 8 => out.push((left, bottom)),
                5 => out.extend([(top, left), (right, bottom)]),
                10 => out.extend([(top, right), (left, bottom)]),
                _ => {}
            }
        }
    }
    out
}

fn point_of(key: [i32; 2]) -> [f32; 2] {
    [key[0] as f32 / 2.0, key[1] as f32 / 2.0]
}

fn key_of(point: [f32; 2]) -> [i32; 2] {
    [
        (point[0] * 2.0).round() as i32,
        (point[1] * 2.0).round() as i32,
    ]
}

/// Douglas-Peucker over a closed loop, `tolerance` in the loop's own pixels.
///
/// Cut at its farthest pair of points first: a closed loop has no endpoint to hold, and anchored at
/// wherever the trace began instead, the start and the point before it both survive as vertices in
/// the middle of whatever straight run they landed in.
pub fn simplify(loop_: &[[f32; 2]], tolerance: f32) -> Vec<[f32; 2]> {
    if loop_.len() < 4 {
        return loop_.to_vec();
    }
    let (mut from, mut to, mut widest) = (0, 0, -1.0f32);
    for i in 0..loop_.len() {
        for j in i + 1..loop_.len() {
            let spread = squared(loop_[i], loop_[j]);
            if spread > widest {
                (widest, from, to) = (spread, i, j);
            }
        }
    }
    let there: Vec<[f32; 2]> = loop_[from..=to].to_vec();
    let back: Vec<[f32; 2]> = loop_[to..].iter().chain(&loop_[..=from]).copied().collect();
    let mut out = chain(&there, tolerance);
    out.pop();
    let mut rest = chain(&back, tolerance);
    rest.pop();
    out.extend(rest);
    out
}

/// Douglas-Peucker over an open chain, both endpoints held.
fn chain(points: &[[f32; 2]], tolerance: f32) -> Vec<[f32; 2]> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut pending = vec![(0usize, points.len() - 1)];
    while let Some((a, b)) = pending.pop() {
        let (mut at, mut widest) = (a, -1.0f32);
        for i in a + 1..b {
            let off = off_segment(points[i], points[a], points[b]);
            if off > widest {
                (widest, at) = (off, i);
            }
        }
        if widest > tolerance {
            keep[at] = true;
            pending.extend([(a, at), (at, b)]);
        }
    }
    points
        .iter()
        .zip(keep)
        .filter(|(_, k)| *k)
        .map(|(p, _)| *p)
        .collect()
}

fn squared(a: [f32; 2], b: [f32; 2]) -> f32 {
    (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1])
}

fn off_segment(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> f32 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let length = dx * dx + dy * dy;
    if length <= 0.0 {
        return squared(p, a).sqrt();
    }
    let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length).clamp(0.0, 1.0);
    squared(p, [a[0] + t * dx, a[1] + t * dy]).sqrt()
}

/// Whether two segments cross at a point interior to both. Two that meet at a point they share -
/// which every pair of neighbours does, and which a pinched contour does too - do not.
pub fn crosses(a: [f32; 2], b: [f32; 2], c: [f32; 2], d: [f32; 2]) -> bool {
    let side = |p: [f32; 2], q: [f32; 2], r: [f32; 2]| {
        (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    };
    side(a, b, c) * side(a, b, d) < 0.0 && side(c, d, a) * side(c, d, b) < 0.0
}

/// §3.6: each cell's 4-connected components, as cells of their own in raster order of the pixel
/// each was first reached at, less those under [`MIN_LOBE_AREA`].
///
/// The solve is 16-connected and a diagonal arc costs about half an axis one (§3.5), so a region
/// that pinches at a diagonal is a shape it returns - and [`trace`] walks one loop, so the lobe it
/// did not walk would become base with nothing said.
pub fn lobes(cells: &[Cell], size: (usize, usize)) -> Vec<Cell> {
    let floor = ((size.0 * size.1) as f32 * MIN_LOBE_AREA).ceil() as usize;
    let mut out = split(cells, size);
    out.retain(|c| c.inside.iter().filter(|held| **held).count() >= floor);
    out
}

fn split(cells: &[Cell], size: (usize, usize)) -> Vec<Cell> {
    let (w, h) = size;
    let owner = owners(cells, size);
    let mut seen = vec![false; w * h];
    let mut out = Vec::new();
    for p in 0..w * h {
        if owner[p] == usize::MAX || seen[p] {
            continue;
        }
        let mut inside = vec![false; w * h];
        let mut pending = vec![p];
        seen[p] = true;
        while let Some(q) = pending.pop() {
            inside[q] = true;
            let (x, y) = (q % w, q / w);
            let near = [
                (x > 0).then(|| q - 1),
                (x + 1 < w).then(|| q + 1),
                (y > 0).then(|| q - w),
                (y + 1 < h).then(|| q + w),
            ];
            for r in near.into_iter().flatten() {
                if owner[r] == owner[p] && !seen[r] {
                    seen[r] = true;
                    pending.push(r);
                }
            }
        }
        let from = &cells[owner[p]];
        out.push(Cell {
            label: from.label,
            inside,
            corridor: from.corridor,
        });
    }
    out
}

/// Which cell each pixel belongs to, `usize::MAX` being the ground outside every cell. A later cell
/// wins an overlap, so what [`subdivide`] traces is a partition whatever it was handed.
fn owners(cells: &[Cell], size: (usize, usize)) -> Vec<usize> {
    let mut owner = vec![usize::MAX; size.0 * size.1];
    for (i, cell) in cells.iter().enumerate() {
        for (p, &held) in cell.inside.iter().enumerate() {
            if held {
                owner[p] = i;
            }
        }
    }
    owner
}

/// A crossing's two regions, sorted, `usize::MAX` for the ground. The key's parity says which axis
/// it crosses, which is what makes a doubled integer the whole of the geometry here.
fn sides_of(key: [i32; 2], owner: &[usize], size: (usize, usize)) -> (usize, usize) {
    let (w, h) = size;
    let held = |x: i32, y: i32| {
        if x < 0 || y < 0 || x >= w as i32 || y >= h as i32 {
            usize::MAX
        } else {
            owner[y as usize * w + x as usize]
        }
    };
    let (a, b) = if key[0] & 1 != 0 {
        (
            held((key[0] - 1) / 2, key[1] / 2),
            held((key[0] + 1) / 2, key[1] / 2),
        )
    } else {
        (
            held(key[0] / 2, (key[1] - 1) / 2),
            held(key[0] / 2, (key[1] + 1) / 2),
        )
    };
    (a.min(b), a.max(b))
}

/// A run of crossings separating one pair of regions, named by that pair and its two ends.
type ArcKey = ((usize, usize), [i32; 2], [i32; 2]);

struct Run {
    key: ArcKey,
    /// The cell walks this arc against the direction it was stored in.
    flipped: bool,
}

/// The cells as one planar subdivision, in canvas pixels at `scale` times the shrunk scale they
/// were cut at.
///
/// **A boundary two cells share is simplified once, and both then hold the same vertices.** Two
/// loops simplified apart both gap and overlap by up to twice the tolerance: the gap fills with the
/// base - what the reader rejected on both sides - and an overlapped pixel goes to whichever tile
/// rasterised last, so a pick flips along the seam. So the loops are cut into arcs at the points
/// where the pair of regions either side changes, each arc is simplified once at the tighter of the
/// two tolerances that claim it, and the loops are rebuilt from the same arcs.
///
/// The arc's ends are held by Douglas-Peucker, so a junction where three regions meet survives
/// exactly. What that leaves is two simplified arcs crossing - the two sides of a one-pixel finger
/// straighten through each other - so every arc in a crossing is simplified again at half its
/// tolerance until none cross. An even-odd rasteriser reads a tangled loop as its own complement in
/// the crossed lobe, and two overlapping tiles flip a pick along their seam.
pub fn subdivide(cells: &[Cell], size: (usize, usize), scale: f32) -> Subdivision {
    let owner = owners(cells, size);
    let long = Span::<Shrunk>::exact(size.0.max(size.1));
    // §5.2's `W(x)`: half the corridor, capped. Both it and the corridor are shrunk pixels, and so
    // is the tolerance, which is why `scale` reaches nothing until the vertices are written - and
    // why `W_MAX` has to be resolved against *this* long edge rather than the render's.
    let ceiling = W_MAX.across(long);
    let tolerance: Vec<f32> = cells
        .iter()
        .map(|c| {
            let half = Extent::exactly((c.corridor.raw() / 2.0).min(ceiling.raw()));
            tolerance_for(c.corridor, half).raw() as f32
        })
        .collect();

    let mut runs: Vec<Vec<Run>> = Vec::new();
    let mut tightest: HashMap<ArcKey, f32> = HashMap::new();
    let mut walked: HashMap<ArcKey, (bool, Vec<[i32; 2]>)> = HashMap::new();
    for i in 0..cells.len() {
        let mask: Vec<bool> = owner.iter().map(|&o| o == i).collect();
        let traced: Vec<[i32; 2]> = trace(&mask, size).into_iter().map(key_of).collect();
        let mut mine = Vec::new();
        for (closed, arc) in arcs_of(&traced, &owner, size) {
            let ends = (arc[0], arc[arc.len() - 1]);
            let flipped = ends.0 > ends.1;
            let key = if flipped {
                (sides_of(arc[0], &owner, size), ends.1, ends.0)
            } else {
                (sides_of(arc[0], &owner, size), ends.0, ends.1)
            };
            walked.entry(key).or_insert_with(|| {
                let stored = if flipped {
                    arc.iter().rev().copied().collect()
                } else {
                    arc.clone()
                };
                (closed, stored)
            });
            let tight = tightest.entry(key).or_insert(f32::INFINITY);
            *tight = tight.min(tolerance[i]);
            mine.push(Run { key, flipped });
        }
        runs.push(mine);
    }

    let mut simplified: HashMap<ArcKey, Vec<[i32; 2]>> = walked
        .iter()
        .map(|(&key, arc)| (key, simplified_arc(arc, tightest[&key])))
        .collect();
    // Terminates: an arc at zero is its own trace, and no two traced edges of a partition cross.
    let mut moved: Option<HashSet<ArcKey>> = None;
    loop {
        let loose: HashSet<ArcKey> = crossing(&simplified, &walked, &runs, moved.as_ref())
            .into_iter()
            .filter(|key| tightest[key] > 0.0)
            .collect();
        if loose.is_empty() {
            break;
        }
        for &key in &loose {
            let tolerance = tightest.get_mut(&key).expect("every arc has a tolerance");
            *tolerance = if *tolerance > 0.25 {
                *tolerance / 2.0
            } else {
                0.0
            };
            simplified.insert(key, simplified_arc(&walked[&key], *tolerance));
        }
        moved = Some(loose);
    }

    // A shrunk cell is a `scale`-sided block of canvas, so its centre is half a block in from the
    // block's corner. Without the offset every seam sits half a block up and left of the corridor it
    // was measured in, and the mask's last block loses that much of itself to the base.
    let centre = (scale - 1.0) / 2.0;
    let mut index: HashMap<[i32; 2], u32> = HashMap::new();
    let mut vertices: Vec<[f32; 2]> = Vec::new();
    let mut tiles = Vec::new();
    for mine in &runs {
        let mut tile: Vec<u32> = Vec::new();
        for run in mine {
            let mut walk = simplified[&run.key].clone();
            if run.flipped {
                walk.reverse();
            }
            for key in walk {
                let next = *index.entry(key).or_insert_with(|| {
                    vertices.push([
                        key[0] as f32 / 2.0 * scale + centre,
                        key[1] as f32 / 2.0 * scale + centre,
                    ]);
                    vertices.len() as u32 - 1
                });
                if tile.last() != Some(&next) {
                    tile.push(next);
                }
            }
        }
        if tile.len() > 1 && tile.first() == tile.last() {
            tile.pop();
        }
        tiles.push(tile);
    }
    Subdivision { vertices, tiles }
}

fn simplified_arc((closed, points): &(bool, Vec<[i32; 2]>), tolerance: f32) -> Vec<[i32; 2]> {
    let floats: Vec<[f32; 2]> = points.iter().map(|&p| point_of(p)).collect();
    let done = if *closed {
        simplify(&floats, tolerance)
    } else {
        chain(&floats, tolerance)
    };
    done.into_iter().map(key_of).collect()
}

/// A polyline some arcs answer for if it crosses anything.
struct Strand {
    arcs: Vec<ArcKey>,
    points: Vec<[f32; 2]>,
    low: [f32; 2],
    high: [f32; 2],
}

impl Strand {
    fn new(arcs: Vec<ArcKey>, points: Vec<[f32; 2]>) -> Strand {
        let (mut low, mut high) = ([f32::INFINITY; 2], [f32::NEG_INFINITY; 2]);
        for p in &points {
            low = [low[0].min(p[0]), low[1].min(p[1])];
            high = [high[0].max(p[0]), high[1].max(p[1])];
        }
        Strand {
            arcs,
            points,
            low,
            high,
        }
    }

    fn crosses(&self, other: &Strand, itself: bool) -> bool {
        if self.low[1] > other.high[1] || other.low[1] > self.high[1] {
            return false;
        }
        self.points.windows(2).enumerate().any(|(i, ab)| {
            other
                .points
                .windows(2)
                .enumerate()
                .any(|(j, cd)| !(itself && i == j) && crosses(ab[0], ab[1], cd[0], cd[1]))
        })
    }
}

/// The arcs whose simplified edges properly cross any edge of the subdivision, their own included.
///
/// Across every loop rather than within one: an arc crossing an arc of another tile overlaps the two
/// tiles, which flips a pick along the seam as surely as a tangle does. The step from one arc's end
/// to the next arc's start is an edge too, and a crossing of it is charged to both arcs it joins.
///
/// Only pairs holding an arc in `moved` are tested, where there is one: a crossing between two
/// strands that did not move would have moved one of them last round, the other being at zero. A
/// step never moves, Douglas-Peucker holding the arc ends it joins.
fn crossing(
    simplified: &HashMap<ArcKey, Vec<[i32; 2]>>,
    walked: &HashMap<ArcKey, (bool, Vec<[i32; 2]>)>,
    runs: &[Vec<Run>],
    moved: Option<&HashSet<ArcKey>>,
) -> Vec<ArcKey> {
    let mut strands: Vec<Strand> = simplified
        .iter()
        .map(|(key, arc)| {
            let mut points: Vec<[f32; 2]> = arc.iter().map(|&p| point_of(p)).collect();
            if walked[key].0 {
                points.push(points[0]);
            }
            Strand::new(vec![*key], points)
        })
        .collect();
    for mine in runs.iter().filter(|mine| mine.len() > 1) {
        for (i, run) in mine.iter().enumerate() {
            let next = &mine[(i + 1) % mine.len()];
            let (here, there) = (&simplified[&run.key], &simplified[&next.key]);
            let end = if run.flipped {
                here[0]
            } else {
                here[here.len() - 1]
            };
            let start = if next.flipped {
                there[there.len() - 1]
            } else {
                there[0]
            };
            strands.push(Strand::new(
                vec![run.key, next.key],
                vec![point_of(end), point_of(start)],
            ));
        }
    }

    // Sorted by left edge, so each strand's candidates end at the first one starting past its right.
    strands.sort_by(|a, b| a.low[0].total_cmp(&b.low[0]));
    let fresh: Vec<bool> = strands
        .iter()
        .map(|strand| {
            moved.is_none_or(|moved| strand.arcs.len() == 1 && moved.contains(&strand.arcs[0]))
        })
        .collect();
    let mut out = Vec::new();
    for s in 0..strands.len() {
        for t in s..strands.len() {
            if strands[t].low[0] > strands[s].high[0] {
                break;
            }
            if (fresh[s] || fresh[t]) && strands[s].crosses(&strands[t], s == t) {
                out.extend(strands[s].arcs.iter().chain(&strands[t].arcs).copied());
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// Which of a subdivision's tiles enclose anything, in the order they were carved.
///
/// **§3.6's floor is on the mask's area, and clearing it is not enough.** A thin cell of a few
/// dozen shrunk pixels straightens under its own tolerance into a loop of two vertices, which
/// encloses nothing, and `assembly_weight.slang` skips it, needing three to test a point against.
pub fn enclosing(sub: &Subdivision) -> Vec<usize> {
    (0..sub.tiles.len())
        .filter(|&t| sub.tiles[t].len() >= 3)
        .collect()
}

/// The loop cut into maximal runs of one region pair, each flagged with whether it is the whole
/// loop - a cell that meets only one other region has no junction to hold and is simplified as the
/// closed curve it is.
fn arcs_of(
    traced: &[[i32; 2]],
    owner: &[usize],
    size: (usize, usize),
) -> Vec<(bool, Vec<[i32; 2]>)> {
    let n = traced.len();
    if n == 0 {
        return Vec::new();
    }
    let sides: Vec<(usize, usize)> = traced.iter().map(|&k| sides_of(k, owner, size)).collect();
    let Some(first) = (0..n).find(|&i| sides[i] != sides[(i + n - 1) % n]) else {
        let lowest = (0..n).min_by_key(|&i| traced[i]).unwrap_or(0);
        return vec![(true, (0..n).map(|i| traced[(lowest + i) % n]).collect())];
    };

    let mut out = Vec::new();
    let mut run: Vec<[i32; 2]> = vec![traced[first]];
    for i in 1..n {
        let (before, here) = ((first + i - 1) % n, (first + i) % n);
        if sides[here] != sides[before] {
            out.push((false, std::mem::take(&mut run)));
        }
        run.push(traced[here]);
    }
    out.push((false, run));
    out
}
