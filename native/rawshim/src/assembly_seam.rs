//! The field a seam is solved over (§3.5), and the min cut each expansion step solves.
//!
//! A seam finder minimises the cost of the boundary itself, so this is a min cut - Interactive
//! Digital Photomontage's (Agarwala et al., 2004), over the Boykov-Kolmogorov neighbourhood.
//!
//! The cut is host code for `dust.rs`'s reason and no other: `assembly_seams` walks a bounded graph
//! over a field the device produced (`assembly_levels`), at the shrunk scale, where a figure's ring
//! is tens of thousands of nodes. There is no second arithmetic over the picture here.

use crate::light::Stops;

/// The side of the block one cell of the field covers.
///
/// A share of nothing: a cell is one analysis pixel per side of accuracy four times over, which is
/// what makes a seam solve milliseconds rather than minutes.
pub const SHRINK: usize = 4;

/// The shape of the field a canvas of `size` shrinks to.
///
/// `div_ceil`, so the last row and column of cells cover what is left rather than dropping it.
pub fn shrunk_size(size: (usize, usize)) -> (usize, usize) {
    (size.0.div_ceil(SHRINK), size.1.div_ceil(SHRINK))
}

/// The sixteen directions, as the eight that are not another's negation, with the
/// Boykov-Kolmogorov weight `kappa_k = delta_phi_k / (2 |e_k|)`.
///
/// **Divided by the edge's length and multiplied by its angular gap, not the other way.** This is
/// the weighting whose cut cost is the contour's Euclidean length (Cauchy-Crofton); multiplying
/// instead makes the metric anisotropic - about 6% toward the diagonal at sixteen neighbours, and
/// at four the 41% that draws the staircase the neighbourhood was widened to remove.
/// `the_weights_are_the_angular_gap_over_the_edge_length` derives every weight here from the
/// sixteen directions themselves.
pub const NEIGHBOURS: [(isize, isize, f32); 8] = [
    (1, 0, 0.232),
    (0, 1, 0.232),
    (1, 1, 0.114),
    (1, -1, 0.114),
    (2, 1, 0.088),
    (2, -1, 0.088),
    (1, 2, 0.088),
    (1, -2, 0.088),
];

/// What every arc carries beyond its cost, so that equally cheap contours are not equally good.
///
/// The ground a burst mostly is costs nothing to cut across, so without this a tile wanders out to
/// wherever its ring ends. With it the shortest of the cheapest contours wins, which is the tile
/// that claims the least.
pub(crate) const TIE: f32 = 1e-4;

/// What a seam solve reads about each shrunk cell of [`shrunk_size`].
pub struct SeamField {
    /// `cells * (sources + 1)`: the cell's mean log2 light, the consensus's and then each frame's,
    /// [`NOT_REACHED`] where there was none.
    pub level: Vec<f32>,
    /// `cells * sources * 2`: each frame's colour over the cell, as log2 of red over green and of
    /// blue over green.
    pub tint: Vec<f32>,
    pub sources: usize,
}

/// `assembly_levels.slang`'s sentinel for a level nothing was averaged into.
pub const NOT_REACHED: f32 = -1e30;

impl SeamField {
    /// The consensus's log2 light at `cell`, or `None` where no frame covered it.
    pub fn consensus(&self, cell: usize) -> Option<Stops> {
        self.at(cell, 0)
    }

    /// Frame `frame`'s log2 light at `cell`, or `None` where it did not reach.
    pub fn frame(&self, cell: usize, frame: usize) -> Option<Stops> {
        self.at(cell, frame + 1)
    }

    /// Frame `frame`'s colour at `cell`, meaningless where [`SeamField::frame`] is `None`.
    pub fn tint(&self, cell: usize, frame: usize) -> [Stops; 2] {
        let at = (cell * self.sources + frame) * 2;
        [at, at + 1].map(|i| Stops::measured(f64::from(self.tint[i])))
    }

    fn at(&self, cell: usize, slot: usize) -> Option<Stops> {
        let held = self.level[cell * (self.sources + 1) + slot];
        (held != NOT_REACHED).then(|| Stops::measured(f64::from(held)))
    }
}

/// The difference in light between two readings at which a cell counts as fully disagreeing.
pub const SIGNIFICANT: Stops = Stops::exactly(1.5);

/// The difference in light two readings of the same ground still show - noise, texture a fraction
/// of a cell out of register - which counts as no disagreement at all.
///
/// Without it, plain rock in a real burst reads as disagreeing as a moved penguin, every seam costs
/// the same, and the shortest one - across the penguin's neck - wins.
pub const NOISE: Stops = Stops::exactly(0.5);

/// [`SIGNIFICANT`] for the distance between two [`SeamField::tint`]s.
pub const TINT_SIGNIFICANT: Stops = Stops::exactly(0.6);

/// [`NOISE`] for colour, far under the light's: misregistration moves light across an edge far more
/// than it moves colour.
pub const TINT_NOISE: Stops = Stops::exactly(0.15);

/// `gap` in stops as a disagreement from 0 to 1, NaN reading as 1.
pub fn disagreement(gap: f32) -> f32 {
    beyond(gap, NOISE, SIGNIFICANT)
}

pub fn beyond(gap: f32, noise: Stops, significant: Stops) -> f32 {
    let noise = noise.raw() as f32;
    let share = (gap.abs() - noise) / (significant.raw() as f32 - noise);
    if share < 1.0 { share.max(0.0) } else { 1.0 }
}

/// How far apart two readings are in light or in colour, from 0 to 1.
pub fn differ(light: f32, [au, av]: [Stops; 2], [bu, bv]: [Stops; 2]) -> f32 {
    let colour = (au.raw() - bu.raw()).hypot(av.raw() - bv.raw()) as f32;
    disagreement(light).max(beyond(colour, TINT_NOISE, TINT_SIGNIFICANT))
}

/// The step in the consensus at which a seam between two cells costs half what it would on flat
/// ground.
pub const EDGE: Stops = Stops::exactly(0.25);

/// What a seam separating `p` from `q` is charged, as a share of its cost: one on flat ground, and
/// less where the consensus steps between them.
///
/// **A seam laid along an edge is hidden by it, and one laid across a face is not.** The cost says
/// where the frames disagree, which in a crowd is nearly everywhere a person is; what tells a
/// silhouette from a cheek is the picture's own step there, and a boundary that follows it reads as
/// the outline it already was.
pub fn along_an_edge(field: &SeamField, p: usize, q: usize) -> f32 {
    match (field.consensus(p), field.consensus(q)) {
        (Some(a), Some(b)) => (1.0 / (1.0 + (a.raw() - b.raw()).abs() / EDGE.raw())) as f32,
        _ => 1.0,
    }
}

/// Boykov and Kolmogorov's max flow (2004): two search trees, one from each terminal, kept between
/// augmentations rather than rebuilt for each. On a grid, where Dinic's rebuilds are nearly all the
/// work, it is the difference between one cut a click and one cut a frame.
pub(crate) struct MinCut {
    /// Arcs by node, `adj[start[u]..start[u + 1]]`, each node's in the order they were added.
    /// Filled from `from` when the flow starts.
    start: Vec<u32>,
    adj: Vec<u32>,
    from: Vec<u32>,
    to: Vec<u32>,
    cap: Vec<f32>,
    /// Per node, what it may still take from the source, or give to the sink where negative.
    tr: Vec<f32>,
    /// The arc to the node's parent in its tree, or one of the markers below.
    parent: Vec<u32>,
    sink: Vec<bool>,
    /// When `dist`, the node's distance from its terminal, was last known true.
    ts: Vec<u32>,
    dist: Vec<u32>,
    queued: Vec<bool>,
    active: std::collections::VecDeque<u32>,
    orphans: std::collections::VecDeque<u32>,
    time: u32,
}

/// Under which a residual arc is exhausted. Capacities are floats, so an augmenting path can leave
/// a remainder no number of further augmentations would clear.
const DRY: f32 = 1e-7;

const FREE: u32 = u32::MAX;
const TERMINAL: u32 = u32::MAX - 1;
const ORPHAN: u32 = u32::MAX - 2;
const FAR: u32 = u32::MAX;

impl MinCut {
    /// `n` nodes, with room for `arcs` calls to [`MinCut::add`] without growing.
    pub(crate) fn with_capacity(n: usize, arcs: usize) -> MinCut {
        MinCut {
            start: vec![0; n + 1],
            adj: Vec::new(),
            from: Vec::with_capacity(arcs * 2),
            to: Vec::with_capacity(arcs * 2),
            cap: Vec::with_capacity(arcs * 2),
            tr: vec![0.0; n],
            parent: vec![FREE; n],
            sink: vec![false; n],
            ts: vec![0; n],
            dist: vec![0; n],
            queued: vec![false; n],
            active: Default::default(),
            orphans: Default::default(),
            time: 0,
        }
    }

    /// An arc and its reverse, adjacent, so that `e ^ 1` is the other one.
    pub(crate) fn add(&mut self, u: usize, v: usize, c: f32) {
        self.from.extend([u as u32, v as u32]);
        self.to.extend([v as u32, u as u32]);
        self.cap.extend([c, 0.0]);
    }

    /// `u`'s arcs from the source and to the sink, at most one of them other than zero.
    pub(crate) fn terminals(&mut self, u: usize, source: f32, sink: f32) {
        self.tr[u] = source - sink;
    }

    /// A stable counting sort of the arcs by the node they leave.
    fn index(&mut self) {
        self.start.iter_mut().for_each(|s| *s = 0);
        for &u in &self.from {
            self.start[u as usize + 1] += 1;
        }
        for u in 1..self.start.len() {
            self.start[u] += self.start[u - 1];
        }
        let mut next = self.start.clone();
        self.adj = vec![0; self.from.len()];
        for (e, &u) in self.from.iter().enumerate() {
            self.adj[next[u as usize] as usize] = e as u32;
            next[u as usize] += 1;
        }
    }

    fn arcs(&self, u: usize) -> std::ops::Range<usize> {
        self.start[u] as usize..self.start[u + 1] as usize
    }

    fn activate(&mut self, u: usize) {
        if !self.queued[u] {
            self.queued[u] = true;
            self.active.push_back(u as u32);
        }
    }

    fn next_active(&mut self) -> Option<usize> {
        while let Some(u) = self.active.pop_front() {
            let u = u as usize;
            self.queued[u] = false;
            if self.parent[u] != FREE {
                return Some(u);
            }
        }
        None
    }

    pub(crate) fn max_flow(&mut self) -> f32 {
        self.index();
        for u in 0..self.tr.len() {
            let sink = match self.tr[u] {
                tr if tr > DRY => false,
                tr if tr < -DRY => true,
                _ => continue,
            };
            self.sink[u] = sink;
            self.parent[u] = TERMINAL;
            self.dist[u] = 1;
            self.activate(u);
        }
        let mut flow = 0.0;
        let mut current = None;
        loop {
            let u = match current.filter(|&u: &usize| self.parent[u] != FREE) {
                Some(u) => u,
                None => match self.next_active() {
                    Some(u) => u,
                    None => break,
                },
            };
            current = None;
            let middle = self.grow(u);
            self.time += 1;
            if let Some(middle) = middle {
                current = Some(u);
                flow += self.augment(middle);
                while let Some(orphan) = self.orphans.pop_front() {
                    self.adopt(orphan as usize);
                }
            }
        }
        flow
    }

    /// Grows `u`'s tree by its free neighbours, or answers the arc from the source's tree to the
    /// sink's that joins them.
    fn grow(&mut self, u: usize) -> Option<usize> {
        let sink = self.sink[u];
        for k in self.arcs(u) {
            let a = self.adj[k] as usize;
            let flowing = if sink { a ^ 1 } else { a };
            if self.cap[flowing] <= DRY {
                continue;
            }
            let v = self.to[a] as usize;
            if self.parent[v] == FREE {
                self.sink[v] = sink;
                self.parent[v] = (a ^ 1) as u32;
                self.ts[v] = self.ts[u];
                self.dist[v] = self.dist[u] + 1;
                self.activate(v);
            } else if self.sink[v] != sink {
                return Some(flowing);
            } else if self.ts[v] <= self.ts[u] && self.dist[v] > self.dist[u] {
                self.parent[v] = (a ^ 1) as u32;
                self.ts[v] = self.ts[u];
                self.dist[v] = self.dist[u] + 1;
            }
        }
        None
    }

    fn augment(&mut self, middle: usize) -> f32 {
        let mut b = self.cap[middle];
        let mut u = self.to[middle ^ 1] as usize;
        while self.parent[u] != TERMINAL {
            let a = self.parent[u] as usize;
            b = b.min(self.cap[a ^ 1]);
            u = self.to[a] as usize;
        }
        b = b.min(self.tr[u]);
        let mut u = self.to[middle] as usize;
        while self.parent[u] != TERMINAL {
            let a = self.parent[u] as usize;
            b = b.min(self.cap[a]);
            u = self.to[a] as usize;
        }
        b = b.min(-self.tr[u]);

        self.cap[middle ^ 1] += b;
        self.cap[middle] -= b;
        let mut u = self.to[middle ^ 1] as usize;
        while self.parent[u] != TERMINAL {
            let a = self.parent[u] as usize;
            self.cap[a] += b;
            self.cap[a ^ 1] -= b;
            if self.cap[a ^ 1] <= DRY {
                self.orphan(u, true);
            }
            u = self.to[a] as usize;
        }
        self.tr[u] -= b;
        if self.tr[u] <= DRY {
            self.orphan(u, true);
        }
        let mut u = self.to[middle] as usize;
        while self.parent[u] != TERMINAL {
            let a = self.parent[u] as usize;
            self.cap[a ^ 1] += b;
            self.cap[a] -= b;
            if self.cap[a] <= DRY {
                self.orphan(u, true);
            }
            u = self.to[a] as usize;
        }
        self.tr[u] += b;
        if self.tr[u] >= -DRY {
            self.orphan(u, true);
        }
        b
    }

    fn orphan(&mut self, u: usize, front: bool) {
        self.parent[u] = ORPHAN;
        match front {
            true => self.orphans.push_front(u as u32),
            false => self.orphans.push_back(u as u32),
        }
    }

    /// A new parent for `u` in its own tree, the one nearest its terminal, or none: then `u` is
    /// free, and whatever hung from it is orphaned in turn.
    fn adopt(&mut self, u: usize) {
        let sink = self.sink[u];
        let time = self.time;
        let (mut best, mut nearest) = (FREE, FAR);
        for k in self.arcs(u) {
            let a = self.adj[k] as usize;
            let flowing = if sink { a } else { a ^ 1 };
            let mut v = self.to[a] as usize;
            if self.cap[flowing] <= DRY || self.sink[v] != sink || self.parent[v] == FREE {
                continue;
            }
            let mut d = 0;
            loop {
                if self.ts[v] == time {
                    d += self.dist[v];
                    break;
                }
                let up = self.parent[v];
                d += 1;
                if up == TERMINAL {
                    self.ts[v] = time;
                    self.dist[v] = 1;
                    break;
                }
                if up == ORPHAN {
                    d = FAR;
                    break;
                }
                v = self.to[up as usize] as usize;
            }
            if d == FAR {
                continue;
            }
            if d < nearest {
                best = a as u32;
                nearest = d;
            }
            let mut v = self.to[a] as usize;
            while self.ts[v] != time {
                self.ts[v] = time;
                self.dist[v] = d;
                d -= 1;
                v = self.to[self.parent[v] as usize] as usize;
            }
        }
        self.parent[u] = best;
        if best != FREE {
            self.ts[u] = time;
            self.dist[u] = nearest + 1;
            return;
        }
        for k in self.arcs(u) {
            let a = self.adj[k] as usize;
            let v = self.to[a] as usize;
            let up = self.parent[v];
            if self.sink[v] != sink || up == FREE {
                continue;
            }
            let flowing = if sink { a } else { a ^ 1 };
            if self.cap[flowing] > DRY {
                self.activate(v);
            }
            if up != TERMINAL && up != ORPHAN && self.to[up as usize] as usize == u {
                self.orphan(v, false);
            }
        }
    }

    /// Every node the source still reaches, which is the one cut every maximum flow agrees on.
    pub(crate) fn source_side(&self) -> Vec<bool> {
        let mut seen: Vec<bool> = self.tr.iter().map(|&tr| tr > DRY).collect();
        let mut stack: Vec<usize> = (0..seen.len()).filter(|&u| seen[u]).collect();
        while let Some(u) = stack.pop() {
            for k in self.arcs(u) {
                let e = self.adj[k] as usize;
                let v = self.to[e] as usize;
                if self.cap[e] > DRY && !seen[v] {
                    seen[v] = true;
                    stack.push(v);
                }
            }
        }
        seen
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On small random graphs, against every cut there is: the flow is the cheapest cut's cost,
    /// and the side the source still reaches is a cut that costs that.
    #[test]
    fn the_flow_is_the_cheapest_cut_and_the_source_side_is_one() {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut draw = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f32 / (1u64 << 53) as f32
        };
        for _ in 0..300 {
            let n = 2 + (draw() * 8.0) as usize;
            let mut graph = MinCut::with_capacity(n, 0);
            let mut arcs = Vec::new();
            let mut tr = Vec::new();
            for u in 0..n {
                let t = draw() * 2.0 - 1.0;
                let (source, sink) = (t.max(0.0), (-t).max(0.0));
                graph.terminals(u, source, sink);
                tr.push((source, sink));
                for v in 0..n {
                    if u != v && draw() < 0.4 {
                        let c = draw();
                        graph.add(u, v, c);
                        arcs.push((u, v, c));
                    }
                }
            }
            let cost = |kept: &dyn Fn(usize) -> bool| -> f32 {
                let terminals: f32 = (0..n)
                    .map(|u| if kept(u) { tr[u].1 } else { tr[u].0 })
                    .sum();
                let between: f32 = arcs
                    .iter()
                    .filter(|&&(u, v, _)| kept(u) && !kept(v))
                    .map(|&(_, _, c)| c)
                    .sum();
                terminals + between
            };
            let cheapest = (0..1u32 << n)
                .map(|set| cost(&|u| set & (1 << u) != 0))
                .fold(f32::INFINITY, f32::min);

            let flow = graph.max_flow();
            let side = graph.source_side();

            assert!(
                (flow - cheapest).abs() < 1e-4,
                "flow {flow}, cheapest {cheapest}"
            );
            let found = cost(&|u| side[u]);
            assert!(
                (found - cheapest).abs() < 1e-4,
                "cut {found}, cheapest {cheapest}"
            );
        }
    }
}
