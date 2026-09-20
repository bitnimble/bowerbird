//! Which frame each cell takes under the reader's picks: the tiles as the data term of a labelling
//! over the picked frames only, solved by alpha-expansion.
//!
//! Host code for `assembly_seam`'s reason: a bounded graph over a field the device produced, at the
//! shrunk scale of §3.4.

use crate::assembly::{Assembly, Takes};
use crate::assembly_seam::{MinCut, NEIGHBOURS, SHRINK, TIE, along_an_edge, differ, disagreement};
use crate::assembly_volume::Volume;
use crate::patch_search::{clears, tracked};
use crate::px::{Analysis, Share, Shrunk, Span};

/// No tile, where a cell or a frame's reading of it has none.
pub(crate) const NO_TILE: u32 = u32::MAX;

/// How far past a tile its pick may grow, as a share of the long edge: a tile is only the least of
/// what it takes, and this is far enough to reach a standing figure's feet from one drawn on its
/// head.
pub const RING: Share = Share::of(3, 10);

/// What taking a cell a seed's frame changes earns, per unit of the change, against a seam's cost
/// across it: enough that a seed takes the whole of what moved around it rather than its own square,
/// which is otherwise the shortest seam there is.
const TAKE: f32 = 0.25;

/// What taking a cell of the base's ground costs where the frame taking it changes nothing there,
/// so the seam's own cost decides where a tile ends. Far under a seam across a figure even summed
/// over [`RING`]. Not zero: a seam on quiet ground costs the same at any distance, or nothing at
/// the canvas edge, and a free ring was taken whole.
const GROW: f32 = 0.001;

/// A frame that does not reach a cell cannot take it.
const UNREACHABLE: f32 = 1e6;

/// Alpha-expansion's passes over the labels. The second catches what a label's move enabled for
/// one tried before it; past that nothing measured moved.
const CYCLES: usize = 2;

/// The frame each cell of `volume` takes under `recipe`'s picks, and each tile's
/// [`Stamp::shift`].
pub(crate) fn labelling(recipe: &Assembly, volume: &Volume) -> Result<Labelled, String> {
    let (w, h) = volume.shrunk;
    let sources = recipe.spec.sources.len();
    if volume.field.sources != sources {
        return Err("that seam volume was not measured for this recipe".into());
    }
    let long = Span::<Shrunk>::exact(w.max(h));
    let stamp = stamped(recipe, volume, RING.over(long).raw(), None);
    refused_where_nothing_left(recipe, volume, &stamp.bounds)?;
    let (shift, shifted_by) = (stamp.shift.clone(), stamp.shifted_by.clone());
    let energy = Energy::new(recipe, volume, stamp);
    let mut label = energy.own.clone();

    // Where each frame may be taken: within the ring of the tiles picking it. The base may be taken
    // anywhere any ring reaches.
    let region: Vec<bool> = energy.grows.iter().map(|&grows| grows != 0).collect();
    for group in groups(&region, (w, h)) {
        let mut labels: Vec<usize> = group
            .iter()
            .map(|&p| energy.own[p])
            .chain([recipe.base])
            .collect();
        labels.sort_unstable();
        labels.dedup();
        if labels.len() < 2 {
            continue;
        }
        let near = energy.nears(&labels, reached(&group, (w, h)));
        // An expansion is a function of the labelling it starts from, so one starting where the
        // last of the same label did ends where that one did.
        let mut expanded: Vec<Option<(Vec<usize>, Vec<usize>)>> = vec![None; sources];
        for _ in 0..CYCLES {
            for &alpha in &labels {
                if let Some((from, to)) = &expanded[alpha]
                    && *from == label
                {
                    label.copy_from_slice(to);
                    continue;
                }
                let from = label.clone();
                let members: Vec<usize> = match alpha == recipe.base {
                    true => group.clone(),
                    false => group
                        .iter()
                        .copied()
                        .filter(|&p| energy.grows[p] & (1 << alpha) != 0)
                        .collect(),
                };
                expand(&energy, &near, &members, &mut label, alpha);
                expanded[alpha] = Some((from, label.clone()));
            }
        }
    }
    anchored(&mut label, &energy.own, recipe.base, (w, h));
    Ok(Labelled {
        label,
        shift,
        shifted_by,
    })
}

/// How much of a seed has to read as changed for a frame to be worth removing something with.
///
/// Measured on a synthetic pair: a disc that left the seed clears 0.5 and better, one that never
/// moved clears under 0.05, and a frame changed everywhere clears nothing. This sits low enough to
/// take every frame the thing actually left and refuse the ones it did not.
const CLEARED: f32 = 0.1;

/// Refuses a tile asking for ground its frame does not actually show, by name.
///
/// **Before the labelling rather than after it.** A frame that still shows the thing has nothing to
/// put in its place, so the expansion would answer a piece that swaps the object for itself - a
/// seam around nothing, which a reader cannot tell from a solve that simply did not work.
fn refused_where_nothing_left(
    recipe: &Assembly,
    volume: &Volume,
    bounds: &[[usize; 4]],
) -> Result<(), String> {
    for t in 0..recipe.tiles.len() {
        let source = recipe.pick[t];
        if recipe.takes(t) != Takes::Ground || source == recipe.base {
            continue;
        }
        let cleared = clears(&volume.field, volume.shrunk, recipe.base, source, bounds[t]);
        if cleared < CLEARED {
            return Err(format!("frame {source} still shows what is there"));
        }
    }
    Ok(())
}

pub(crate) struct Labelled {
    /// The frame each cell takes.
    pub(crate) label: Vec<usize>,
    /// As [`Stamp::shift`] and [`Stamp::shifted_by`].
    pub(crate) shift: Vec<[f64; 2]>,
    pub(crate) shifted_by: Vec<u32>,
}

/// Cells as `[left, top, right, bottom)`.
type Bounds = [usize; 4];

/// The box `group`'s arcs reach: its own, grown by the longest step in [`NEIGHBOURS`].
fn reached(group: &[usize], (w, h): (usize, usize)) -> Bounds {
    let reach = NEIGHBOURS
        .iter()
        .map(|&(dx, dy, _)| dx.unsigned_abs().max(dy.unsigned_abs()))
        .max()
        .unwrap_or(0);
    let mut bounds = [usize::MAX, usize::MAX, 0, 0];
    for &p in group {
        let (x, y) = (p % w, p / w);
        bounds = [
            bounds[0].min(x),
            bounds[1].min(y),
            bounds[2].max(x),
            bounds[3].max(y),
        ];
    }
    [
        bounds[0].saturating_sub(reach),
        bounds[1].saturating_sub(reach),
        (bounds[2] + reach + 1).min(w),
        (bounds[3] + reach + 1).min(h),
    ]
}

/// Every region taking a frame other than the base, back on the base unless it reaches a cell of
/// a tile that picks that frame.
///
/// A tile grows from where it was put: a region the solve found cheaper elsewhere in the ring - a
/// strip the base does not reach, another figure that moved - is a piece nobody asked for.
fn anchored(label: &mut [usize], own: &[usize], base: usize, (w, h): (usize, usize)) {
    let mut seen = vec![false; w * h];
    for start in 0..w * h {
        let s = label[start];
        if s == base || seen[start] {
            continue;
        }
        let mut region = vec![start];
        let mut reached = false;
        seen[start] = true;
        let mut at = 0;
        while at < region.len() {
            let p = region[at];
            at += 1;
            reached |= own[p] == s;
            for q in four(p, (w, h)) {
                if !seen[q] && label[q] == s {
                    seen[q] = true;
                    region.push(q);
                }
            }
        }
        if !reached {
            for p in region {
                label[p] = base;
            }
        }
    }
}

/// The recipe's tiles, laid over the shrunk grid.
pub(crate) struct Stamp {
    /// The tile a cell lies in, each written over the last in order, or [`NO_TILE`].
    zone: Vec<u32>,
    /// Cells a tile holds to its pick.
    held: Vec<bool>,
    /// Per cell, a bit per frame a tile picking it may take there.
    grows: Vec<u32>,
    /// Per tile, the cells its bounds cover, `[left, top, right, bottom)`.
    pub(crate) bounds: Vec<[usize; 4]>,
    /// Per tile, in cells, where its pick shows what the base shows under it
    /// ([`crate::patch_search`]); zero for one on the base.
    pub(crate) shift: Vec<[f64; 2]>,
    /// `cells * sources`: the tile whose [`Stamp::shift`] a frame is read through at a cell - the
    /// nearest picking that frame, within its ring - or [`NO_TILE`].
    pub(crate) shifted_by: Vec<u32>,
}

/// A tile is the least its pick takes, not the whole of it: every cell its bounds touch is held to
/// that pick, and within `ring` ([`RING`]) of them the pick may be taken - over other picks too, a
/// later tile being the reader's later word - so the seam's own cost decides how far the tile
/// grows.
///
/// `known`, where a caller already holds each tile's shift, is taken rather than tracked again.
pub(crate) fn stamped(
    recipe: &Assembly,
    volume: &Volume,
    ring: usize,
    known: Option<&[[f64; 2]]>,
) -> Stamp {
    let (w, h) = volume.shrunk;
    let mut zone = vec![NO_TILE; w * h];
    let mut held = vec![false; w * h];
    let mut grows = vec![0u32; w * h];
    let sources = volume.field.sources;
    let mut shift = vec![[0.0; 2]; recipe.tiles.len()];
    let mut bounds = vec![[0usize; 4]; recipe.tiles.len()];
    let mut shifted_by = vec![NO_TILE; w * h * sources];
    let cell = |at: f32, canvas: usize, plane: usize| -> f64 {
        Share::measured(f64::from(at), canvas as f64)
            .across(Span::<Analysis>::exact(plane))
            .raw()
            / SHRINK as f64
    };
    let [canvas_w, canvas_h] = recipe.spec.canvas;
    // Per frame, a breadth-first walk out of every tile picking it at once, so a cell two tiles
    // reach is read through the nearer one's shift.
    let mut fronts: Vec<Vec<usize>> = vec![Vec::new(); sources];
    for t in 0..recipe.tiles.len() {
        let (mut left, mut top) = (f64::INFINITY, f64::INFINITY);
        let (mut right, mut bottom) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
        for &v in &recipe.tiles[t] {
            let [x, y] = recipe.vertices[v as usize];
            let (x, y) = (
                cell(x, canvas_w, volume.plane.0),
                cell(y, canvas_h, volume.plane.1),
            );
            (left, top) = (left.min(x), top.min(y));
            (right, bottom) = (right.max(x), bottom.max(y));
        }
        // Saturating casts: a tile with no vertices spans nothing.
        let columns = (left.floor().max(0.0) as usize)..(right.ceil() as usize).min(w);
        let rows = (top.floor().max(0.0) as usize)..(bottom.ceil() as usize).min(h);
        bounds[t] = [columns.start, rows.start, columns.end, rows.end];
        let source = recipe.pick[t];
        for y in rows {
            for x in columns.clone() {
                let p = y * w + x;
                zone[p] = t as u32;
                held[p] = true;
                grows[p] |= 1 << source;
                shifted_by[p * sources + source] = t as u32;
                fronts[source].push(p);
            }
        }
        // A tile asking for the ground is read where it stands, which is the whole of how it
        // removes rather than replaces: tracking would find the very thing the reader is trying to
        // be rid of and bring it back from wherever it stood in that frame.
        let follows = recipe.takes(t) == Takes::Subject;
        if follows && source != recipe.base && right > left && bottom > top {
            let centre = [
                (((left + right) / 2.0) as usize).min(w - 1),
                (((top + bottom) / 2.0) as usize).min(h - 1),
            ];
            shift[t] = match known.and_then(|held| held.get(t)) {
                Some(&held) => held,
                None => tracked(&volume.field, (w, h), recipe.base, source, centre),
            };
        }
    }
    for (source, mut front) in fronts.into_iter().enumerate() {
        let by = &mut shifted_by[..];
        let owner = |p: usize, by: &[u32]| by[p * sources + source];
        for _ in 0..ring {
            let mut next = Vec::new();
            for p in front {
                let t = owner(p, by);
                for q in four(p, (w, h)) {
                    if owner(q, by) == NO_TILE {
                        by[q * sources + source] = t;
                        grows[q] |= 1 << source;
                        next.push(q);
                    }
                }
            }
            front = next;
        }
    }
    Stamp {
        zone,
        held,
        grows,
        bounds,
        shift,
        shifted_by,
    }
}

/// Each frame as its piece would be drawn, over a [`Stamp`].
pub(crate) struct Reader<'a> {
    pub(crate) volume: &'a Volume,
    pub(crate) shift: &'a [[f64; 2]],
    pub(crate) shifted_by: &'a [u32],
}

impl Reader<'_> {
    /// Frame `s`'s log2 light at `p`, through the shift of the tile that would take it, and the
    /// cell it was read from; none where `s` does not reach.
    pub(crate) fn read(&self, p: usize, s: usize) -> Option<(f32, usize)> {
        let (w, h) = self.volume.shrunk;
        let sources = self.volume.field.sources;
        let [dx, dy] = match self.shifted_by[p * sources + s] {
            NO_TILE => [0.0, 0.0],
            t => self.shift[t as usize],
        };
        let x = (p % w) as isize + dx.round() as isize;
        let y = (p / w) as isize + dy.round() as isize;
        if x < 0 || y < 0 || x >= w as isize || y >= h as isize {
            return None;
        }
        let q = y as usize * w + x as usize;
        Some((self.volume.field.frame(q, s)?.raw() as f32, q))
    }
}

/// What a labelling costs, term by term.
struct Energy<'a> {
    volume: &'a Volume,
    sources: usize,
    base: usize,
    /// The frame each cell takes under its tile.
    own: Vec<usize>,
    held: Vec<bool>,
    grows: Vec<u32>,
    /// `cells * sources`: each frame's log2 light as its piece would be drawn - through the shift of
    /// the tile that would take it - and NaN where the frame does not reach.
    lit: Vec<f32>,
    /// `cells * sources`: the cell of that frame [`Energy::lit`] was read from.
    read: Vec<u32>,
    /// `cells * sources`: what taking the cell for that frame earns, per [`TAKE`] - the change
    /// the frame makes there, over what changed joined to the seed that picks it, and nothing
    /// elsewhere.
    reward: Vec<f32>,
    /// Per pair of frames, lowest first, and the box it was filled over: [`Energy::apart`] at its
    /// worst over each cell's 3x3.
    near: std::cell::RefCell<std::collections::HashMap<(usize, usize, Bounds), Near>>,
}

type Near = std::rc::Rc<Vec<f32>>;

impl<'a> Energy<'a> {
    fn new(recipe: &Assembly, volume: &'a Volume, stamp: Stamp) -> Energy<'a> {
        let sources = volume.field.sources;
        let Stamp {
            zone,
            held,
            grows,
            shift,
            shifted_by,
            ..
        } = stamp;
        let own = zone
            .iter()
            .map(|&z| match z {
                NO_TILE => recipe.base,
                t => recipe.pick[t as usize],
            })
            .collect();
        let mut lit = vec![f32::NAN; zone.len() * sources];
        let mut read = vec![u32::MAX; zone.len() * sources];
        let reader = Reader {
            volume,
            shift: &shift,
            shifted_by: &shifted_by,
        };
        for p in 0..zone.len() {
            for s in 0..sources {
                if let Some((level, q)) = reader.read(p, s) {
                    lit[p * sources + s] = level;
                    read[p * sources + s] = q as u32;
                }
            }
        }
        let mut energy = Energy {
            volume,
            sources,
            base: recipe.base,
            own,
            held,
            grows,
            lit,
            read,
            reward: Vec::new(),
            near: Default::default(),
        };
        energy.reward = energy.rewards(recipe, &zone, &shift, &shifted_by);
        energy
    }

    /// [`Energy::reward`]. What a seed's frame changes is judged in place, where the base's
    /// subject stands; for a seed whose frame is read shifted it is also weighed by how well the
    /// shifted frame matches there, or the change at the subject's new place - background, read
    /// shifted - would earn too.
    fn rewards(
        &self,
        recipe: &Assembly,
        zone: &[u32],
        shift: &[[f64; 2]],
        shifted_by: &[u32],
    ) -> Vec<f32> {
        let (w, h) = self.volume.shrunk;
        let sources = self.sources;
        let field = &self.volume.field;
        let mut reward = vec![0.0f32; w * h * sources];
        for t in 0..recipe.tiles.len() {
            let s = recipe.pick[t];
            if s == self.base {
                continue;
            }
            let moved = shift[t] != [0.0, 0.0];
            let earns = |p: usize| -> f32 {
                let (Some(here), Some(there)) = (field.frame(p, s), field.frame(p, self.base))
                else {
                    return 0.0;
                };
                let change = differ(
                    (here.raw() - there.raw()) as f32,
                    field.tint(p, s),
                    field.tint(p, self.base),
                );
                match moved {
                    true => change * (1.0 - self.apart(p, s, self.base)),
                    false => change,
                }
            };
            let mut seen = vec![false; w * h];
            let mut pending: Vec<usize> = (0..w * h)
                .filter(|&p| self.held[p] && zone[p] == t as u32)
                .collect();
            for &p in &pending {
                seen[p] = true;
            }
            while let Some(p) = pending.pop() {
                reward[p * sources + s] = earns(p);
                for q in four(p, (w, h)) {
                    if !seen[q] && shifted_by[q * sources + s] == t as u32 && earns(q) > 0.0 {
                        seen[q] = true;
                        pending.push(q);
                    }
                }
            }
        }
        reward
    }

    fn light(&self, p: usize, s: usize) -> f32 {
        self.lit[p * self.sources + s]
    }

    /// How far apart two frames are at `p` in light or in colour, from 0 to 1. NaN compares false,
    /// so a frame that does not reach is fully apart.
    fn apart(&self, p: usize, a: usize, b: usize) -> f32 {
        let (from_a, from_b) = (
            self.read[p * self.sources + a],
            self.read[p * self.sources + b],
        );
        if from_a == u32::MAX || from_b == u32::MAX {
            return 1.0;
        }
        let field = &self.volume.field;
        differ(
            self.light(p, a) - self.light(p, b),
            field.tint(from_a as usize, a),
            field.tint(from_b as usize, b),
        )
    }

    /// The worst of [`Energy::apart`] over the 3x3 around each cell of `bounds`, zero outside it: a
    /// seam a cell off a disagreement is still inside §5.2's feather.
    fn near(&self, a: usize, b: usize, bounds: Bounds) -> Near {
        let key = (a.min(b), a.max(b), bounds);
        if let Some(held) = self.near.borrow().get(&key) {
            return held.clone();
        }
        let (w, h) = self.volume.shrunk;
        let [left, top, right, bottom] = bounds;
        let mut out = vec![0f32; w * h];
        for y in top..bottom {
            for x in left..right {
                let mut worst = 0f32;
                for ny in y.saturating_sub(1)..(y + 2).min(h) {
                    for nx in x.saturating_sub(1)..(x + 2).min(w) {
                        worst = worst.max(self.apart(ny * w + nx, a.min(b), a.max(b)));
                    }
                }
                out[y * w + x] = worst;
            }
        }
        let held = std::rc::Rc::new(out);
        self.near.borrow_mut().insert(key, held.clone());
        held
    }

    /// What giving `p` to frame `s` costs.
    ///
    /// A cell no tile holds is the base's, so taking it for another frame is all that can cost
    /// anything; the expansion only offers a frame the cells its tiles' rings reach.
    fn data(&self, p: usize, s: usize) -> f32 {
        if self.light(p, s).is_nan() || (self.held[p] && s != self.own[p]) {
            return UNREACHABLE;
        }
        if s == self.own[p] {
            return 0.0;
        }
        match self.reward[p * self.sources + s] {
            earned if earned > 0.0 => -TAKE * earned,
            _ => GROW,
        }
    }

    /// What a seam between `p` taking `a` and `q` taking `b` costs, `k` being the arc's
    /// Boykov-Kolmogorov weight and `edge` its [`along_an_edge`].
    ///
    /// **The two frames' disagreement on value and on step**: a pair can agree on a cell and still
    /// disagree on the edge running through it. Nearly a metric in the labels, which is what
    /// alpha-expansion asks of it: the [`NOISE`] floor breaks the triangle inequality by up to the
    /// floor, which `expand` clamps.
    #[allow(clippy::too_many_arguments)]
    fn pair(&self, near: &Nears, p: usize, q: usize, k: f32, edge: f32, a: usize, b: usize) -> f32 {
        if a == b {
            return 0.0;
        }
        let turn = (self.light(q, a) - self.light(p, a)) - (self.light(q, b) - self.light(p, b));
        let step = disagreement(turn);
        let held;
        let pair = match &near.by_pair[a * self.sources + b] {
            Some(pair) => pair,
            None => {
                held = self.near(a, b, near.bounds);
                &held
            }
        };
        let value = 0.5 * (pair[p] + pair[q]);
        k * ((value + step) * edge + TIE)
    }

    /// [`Energy::near`] over `bounds` for every pair of `labels`.
    fn nears(&self, labels: &[usize], bounds: Bounds) -> Nears {
        let mut by_pair = vec![None; self.sources * self.sources];
        for &a in labels {
            for &b in labels {
                if a != b {
                    by_pair[a * self.sources + b] = Some(self.near(a, b, bounds));
                }
            }
        }
        Nears { bounds, by_pair }
    }
}

/// [`Energy::near`] over the box a group's arcs reach, by `a * sources + b`, and any pair missing
/// from it filled over the same box when asked for.
struct Nears {
    bounds: Bounds,
    by_pair: Vec<Option<Near>>,
}

/// One alpha-expansion move over `group`: every cell keeps its label or takes `alpha`, whichever
/// the minimum cut says. Cells outside `group` hold theirs.
///
/// Kolmogorov and Zabih's construction, with the source side keeping its label.
fn expand(energy: &Energy, near: &Nears, group: &[usize], label: &mut [usize], alpha: usize) {
    let (w, h) = energy.volume.shrunk;
    let mut node = vec![usize::MAX; w * h];
    for (i, &p) in group.iter().enumerate() {
        node[p] = i;
    }
    let mut keep: Vec<f32> = group.iter().map(|&p| energy.data(p, label[p])).collect();
    let mut take: Vec<f32> = group.iter().map(|&p| energy.data(p, alpha)).collect();
    let mut graph = MinCut::with_capacity(group.len(), group.len() * NEIGHBOURS.len());
    for (i, &p) in group.iter().enumerate() {
        let (x, y) = ((p % w) as isize, (p / w) as isize);
        for &(dx, dy, k) in &NEIGHBOURS {
            for forward in [true, false] {
                let (nx, ny) = match forward {
                    true => (x + dx, y + dy),
                    false => (x - dx, y - dy),
                };
                if nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize {
                    continue;
                }
                let q = ny as usize * w + nx as usize;
                let (lp, lq) = (label[p], label[q]);
                let j = node[q];
                if j != usize::MAX && !forward {
                    continue;
                }
                let edge = along_an_edge(&energy.volume.field, p, q);
                let pair = |a, b| energy.pair(near, p, q, k, edge, a, b);
                if j == usize::MAX {
                    keep[i] += pair(lp, lq);
                    take[i] += pair(alpha, lq);
                    continue;
                }
                let both = pair(lp, lq);
                let only_q = pair(lp, alpha);
                let only_p = pair(alpha, lq);
                match only_p > both {
                    true => take[i] += only_p - both,
                    false => keep[i] += both - only_p,
                }
                keep[j] += only_p;
                graph.add(i, j, (only_q + only_p - both).max(0.0));
            }
        }
    }
    for i in 0..group.len() {
        let least = keep[i].min(take[i]);
        graph.terminals(i, take[i] - least, keep[i] - least);
    }
    graph.max_flow();
    let kept = graph.source_side();
    for (i, &p) in group.iter().enumerate() {
        if !kept[i] {
            label[p] = alpha;
        }
    }
}

/// The 4-connected components of `mask`, each in raster order of its cells.
fn groups(mask: &[bool], size: (usize, usize)) -> Vec<Vec<usize>> {
    let mut seen = vec![false; mask.len()];
    let mut out = Vec::new();
    for start in 0..mask.len() {
        if !mask[start] || seen[start] {
            continue;
        }
        seen[start] = true;
        let mut group = vec![start];
        let mut pending = vec![start];
        while let Some(p) = pending.pop() {
            for q in four(p, size) {
                if mask[q] && !seen[q] {
                    seen[q] = true;
                    group.push(q);
                    pending.push(q);
                }
            }
        }
        group.sort_unstable();
        out.push(group);
    }
    out
}

pub(crate) fn four(p: usize, (w, h): (usize, usize)) -> impl Iterator<Item = usize> {
    let (x, y) = (p % w, p / w);
    [
        (x > 0).then(|| p - 1),
        (x + 1 < w).then(|| p + 1),
        (y > 0).then(|| p - w),
        (y + 1 < h).then(|| p + w),
    ]
    .into_iter()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly_seam::NOT_REACHED;
    use crate::assembly_seams::tests::{MOVED, SIZE, TILE, burst, drawn, untiled};

    #[test]
    fn a_tile_through_a_moving_figure_grows_onto_the_ground_beside_it() {
        // Its edge is two cells into the figure.
        let volume = burst(MOVED);
        let Labelled { label, .. } =
            labelling(&drawn(untiled(), TILE, 1), &volume).expect("a labelling");

        let (w, _) = SIZE;
        for y in MOVED[1]..MOVED[3] {
            for x in MOVED[0]..MOVED[2] {
                assert_eq!(label[y * w + x], 1, "the figure is cut at {x},{y}");
            }
        }
        assert_eq!(label[20 * w + 2], 0, "the far ground left the base");
    }

    #[test]
    fn a_tile_grows_as_far_as_its_ring_to_take_a_whole_figure_and_no_further() {
        // Twenty-five cells of the figure outside the rectangle, inside its ring.
        let figure = [20, 5, 50, 35];
        let volume = burst(figure);
        let rectangle = [45, 0, 90, 200];
        let Labelled { label, .. } =
            labelling(&drawn(untiled(), rectangle, 1), &volume).expect("a labelling");

        let (w, h) = SIZE;
        for y in figure[1]..figure[3] {
            for x in figure[0]..figure[2] {
                assert_eq!(label[y * w + x], 1, "the figure is cut at {x},{y}");
            }
        }
        // Clear of the figure and its feather the seam stays on the rectangle: one further out is no
        // shorter.
        for y in (figure[3] + 4)..h {
            let (left, right) = (rectangle[0] - 1, rectangle[2]);
            assert_eq!(label[y * w + left], 0, "the tile spread at {left},{y}");
            assert_eq!(label[y * w + right], 0, "the tile spread at {right},{y}");
        }
    }

    #[test]
    fn a_tile_keeps_every_cell_it_was_drawn_over() {
        // Frame 0 inside the figure the first tile takes from frame 1, and reaching nowhere else in
        // it, so the patch cannot grow: a seam around a patch that small costs far more than giving
        // it to frame 1, and only the hold keeps it.
        let mut volume = burst(MOVED);
        let patch = [20, 10, 24, 20];
        let (w, _) = SIZE;
        let within =
            |[l, t, r, b]: [usize; 4], x: usize, y: usize| x >= l && x < r && y >= t && y < b;
        for y in MOVED[1]..MOVED[3] {
            for x in MOVED[0]..MOVED[2] {
                if !within(patch, x, y) {
                    volume.field.level[(y * w + x) * 3 + 1] = NOT_REACHED;
                }
            }
        }
        let recipe = drawn(drawn(untiled(), TILE, 1), patch, 0);
        let Labelled { label, .. } = labelling(&recipe, &volume).expect("a labelling");
        let zone = stamped(&recipe, &volume, 0, None).zone;

        for y in patch[1]..patch[3] {
            for x in patch[0]..patch[2] {
                assert_eq!(label[y * w + x], 0, "the later tile lost {x},{y}");
                assert_eq!(zone[y * w + x], 1);
            }
        }
    }

    #[test]
    fn a_seed_where_the_frames_barely_differ_still_grows_over_the_figure_around_it() {
        // A penguin's head against the rock the other frame shows there: the seed is on a patch
        // the two frames barely tell apart, so a seam around the seed alone is cheap, and the body
        // they plainly disagree on is what has to pay for itself. The figure's far corner and a
        // feather past it are inside the seed's ring, which is 4-connected steps.
        let figure = [35, 35, 75, 90];
        let head = [44, 44, 56, 56];
        let mut volume = burst(figure);
        let (w, _) = SIZE;
        for y in head[1]..head[3] {
            for x in head[0]..head[2] {
                volume.field.level[(y * w + x) * 3 + 2] = 0.6;
            }
        }
        let seed = [49, 49, 52, 52];
        let Labelled { label, .. } =
            labelling(&drawn(untiled(), seed, 1), &volume).expect("a labelling");

        for y in figure[1]..figure[3] {
            for x in figure[0]..figure[2] {
                assert_eq!(label[y * w + x], 1, "the figure is cut at {x},{y}");
            }
        }
        assert_eq!(label[150 * w + 150], 0, "the seed spread over quiet ground");
    }

    #[test]
    fn a_seed_grows_over_what_differs_only_in_colour() {
        // A penguin's white legs and orange feet where the other frame shows snow: as bright, and
        // another colour.
        let body = [35, 35, 75, 70];
        let legs = [45, 70, 65, 95];
        let mut volume = burst(body);
        let (w, _) = SIZE;
        for y in legs[1]..legs[3] {
            for x in legs[0]..legs[2] {
                volume.field.tint[(y * w + x) * 4 + 2] = 1.0;
            }
        }
        let seed = [49, 49, 52, 52];
        let Labelled { label, .. } =
            labelling(&drawn(untiled(), seed, 1), &volume).expect("a labelling");

        for y in legs[1]..legs[3] {
            for x in legs[0]..legs[2] {
                assert_eq!(label[y * w + x], 1, "the legs are cut at {x},{y}");
            }
        }
    }

    #[test]
    fn a_cell_two_seeds_reach_is_read_through_the_nearer() {
        let volume = burst([0, 0, 0, 0]);
        let recipe = drawn(
            drawn(untiled(), [48, 100, 52, 104], 1),
            [148, 100, 152, 104],
            1,
        );
        let ring = RING.over(Span::<Shrunk>::exact(SIZE.0)).raw();
        let stamp = stamped(&recipe, &volume, ring, None);

        let (w, sources) = (SIZE.0, 2);
        let by = |x: usize| stamp.shifted_by[(102 * w + x) * sources + 1];
        assert_eq!((by(90), by(110)), (0, 1));
        assert_eq!(stamp.shifted_by[(102 * w + 90) * sources], NO_TILE);
    }

    #[test]
    fn a_seed_where_everything_moved_takes_more_than_its_own_square() {
        // A crowd that shifted: no seam within reach is quiet, so the shortest one - around the
        // seed alone - would win were taking what changed merely free.
        let (w, h) = SIZE;
        let volume = burst([0, 0, w, h]);
        let seed = [100, 90, 103, 93];
        let Labelled { label, .. } =
            labelling(&drawn(untiled(), seed, 1), &volume).expect("a labelling");

        for (x, y) in [(120, 91), (80, 91), (101, 110), (101, 70)] {
            assert_eq!(label[y * w + x], 1, "the seed stopped short of {x},{y}");
        }
    }

    #[test]
    fn a_seed_takes_nothing_it_is_not_joined_to() {
        // The base does not reach a strip well inside the seed's ring, so only the seed's frame
        // could take it - and nothing but quiet ground lies between the two.
        let mut volume = burst([0, 0, 0, 0]);
        let (w, h) = SIZE;
        for y in 0..h {
            for x in 140..150 {
                volume.field.level[(y * w + x) * 3 + 1] = NOT_REACHED;
            }
        }
        let seed = [100, 90, 110, 100];
        let Labelled { label, .. } =
            labelling(&drawn(untiled(), seed, 1), &volume).expect("a labelling");

        assert_eq!(label[95 * w + 105], 1, "the seed lost its pick");
        for y in 0..h {
            assert_eq!(
                label[y * w + 145],
                0,
                "the strip took the seed's frame at 145,{y}"
            );
        }
    }
}
