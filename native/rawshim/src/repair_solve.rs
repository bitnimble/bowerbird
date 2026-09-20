//! The places a repair's fill could come from, and where each one's seam runs: what a reader is
//! offered for one loop.
//!
//! The merge's two halves, over one photograph instead of several. [`Patch`] compares the ground
//! around the hole - never the thing in it, which is what is being removed - against everywhere
//! near it; [`MinCut`] then grows the fill out from the hole to wherever the picture and the fill
//! agree best, which is the merge's seam cut between the photograph and a copy of itself.
//!
//! Host arithmetic over a field the device averaged (`repair.slang`'s `repair_cells`), for
//! `patch_search`'s reason: a few tens of thousands of cells, searched once a loop.
//!
//! **Every distance here is in cells**, and a cell is [`crate::repair::cell`] of the loop the reader
//! drew: a [`crate::repair::CELLS_ACROSS`]th of it. So a dust spot and a person are searched at the
//! same grain relative to themselves, and nothing here names a pixel of any frame.

use crate::assembly_seam::{MinCut, NEIGHBOURS, SeamField, TIE, along_an_edge, differ};
use crate::assembly_tiles::{simplify, trace};
use crate::gpu::{self, Gpu};
use crate::light::{Gain, Stops};
use crate::patch_search::Patch;
use crate::px::{At, Coordinate, Drawn, Extent, Point, Rect, Size, Stored};
use crate::repair::{
    FEATHER_CELLS, MOST_GAIN, MOST_VERTICES, Params, Repair, bounds, cell, entry, offered_feather,
};
use crate::resident::Resident;

/// How far past the drawn loop the seam may reach: half the loop again.
pub const GROW: usize = 12;

/// How far a fill is looked for, either way: three loops.
pub const REACH: usize = 72;

/// Cells around the drawn loop that are filled whatever the cut says: the loop can pass half a
/// cell beyond the centre of the last cell it holds, and the feather reaches [`FEATHER_CELLS`]
/// inside the seam.
const GUARD: usize = FEATHER_CELLS + 1;

/// How many places a reader is offered.
pub const OPTIONS: usize = 4;

/// What the cut is charged for a cell it may not have, which no seam can cost.
const FORCED: f32 = 1e4;

/// The cells the field is averaged over, on the frame.
#[derive(Clone, Copy)]
struct Grid {
    frame: Size<Drawn>,
    /// Where the first cell starts, in the frame's pixels.
    origin: [usize; 2],
    /// A cell's side, in the frame's pixels.
    side: usize,
    cells: (usize, usize),
}

impl Grid {
    /// Enough of `held` around `drawn` for the seam to grow and the search to reach, on a frame of
    /// `frame`'s size that `held` is the part of on the device - and around where `drawn` is read
    /// from `donor` pixels away, where the fill's place is given rather than searched for.
    fn over(
        frame: Size<Drawn>,
        held: Rect<Drawn>,
        drawn: &[Point<Drawn>],
        donor: Option<[f64; 2]>,
    ) -> Grid {
        let side = cell(drawn).raw().ceil() as usize;
        let margin = ((GUARD + GROW + REACH + 1) * side) as f64;
        let [mut low, mut high] = bounds(drawn);
        if let Some([dx, dy]) = donor {
            (low, high) = (
                [low[0].min(low[0] + dx), low[1].min(low[1] + dy)],
                [high[0].max(high[0] + dx), high[1].max(high[1] + dy)],
            );
        }
        let (from_x, from_y, wide, deep) = held.raw();
        let edge =
            |at: f64, least: usize, most: usize| at.clamp(least as f64, most as f64) as usize;
        let (left, top) = (
            edge((low[0] - margin).floor(), from_x, from_x + wide),
            edge((low[1] - margin).floor(), from_y, from_y + deep),
        );
        let (right, bottom) = (
            edge((high[0] + margin).ceil(), from_x, from_x + wide),
            edge((high[1] + margin).ceil(), from_y, from_y + deep),
        );
        Grid {
            frame,
            origin: [left, top],
            side,
            cells: (
                (right - left).div_ceil(side).max(1),
                (bottom - top).div_ceil(side).max(1),
            ),
        }
    }

    /// A position on the grid, in the frame's pixels: a cell's centre is a whole number, which is
    /// what `assembly_tiles::trace` writes a loop in.
    fn pixel_of(&self, [x, y]: [f64; 2]) -> Point<Drawn> {
        let side = self.side as f64;
        Point {
            x: Coordinate::exactly(self.origin[0] as f64 + (x + 0.5) * side),
            y: Coordinate::exactly(self.origin[1] as f64 + (y + 0.5) * side),
        }
    }

    /// The cells whose centres `loop_` holds, and the cells its vertices fall in: a loop narrower
    /// than a cell still holds one.
    fn filled(&self, loop_: &[Point<Drawn>]) -> Vec<bool> {
        let (w, h) = self.cells;
        let corners: Vec<[f64; 2]> = loop_.iter().map(|p| [p.x.raw(), p.y.raw()]).collect();
        let mut out = vec![false; w * h];
        for y in 0..h {
            for x in 0..w {
                let at = self.pixel_of([x as f64, y as f64]);
                out[y * w + x] = holds(&corners, [at.x.raw(), at.y.raw()]);
            }
        }
        let side = self.side as f64;
        for [x, y] in &corners {
            let cx = ((x - self.origin[0] as f64) / side).floor();
            let cy = ((y - self.origin[1] as f64) / side).floor();
            if cx >= 0.0 && cy >= 0.0 && (cx as usize) < w && (cy as usize) < h {
                out[cy as usize * w + cx as usize] = true;
            }
        }
        out
    }
}

/// Whether `loop_` holds `p`, by the even-odd rule `repair.slang`'s `depth` draws with.
fn holds(loop_: &[[f64; 2]], p: [f64; 2]) -> bool {
    let mut inside = false;
    let mut before = loop_.len() - 1;
    for (at, b) in loop_.iter().enumerate() {
        let a = loop_[before];
        if (b[1] > p[1]) != (a[1] > p[1]) {
            let crossing = a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
            if p[0] < crossing {
                inside = !inside;
            }
        }
        before = at;
    }
    inside
}

/// The part of a frame of `frame`'s size the search around `drawn` reads: what a window has to hold
/// for [`measure`] to look as far over it as over the whole frame.
pub fn searched(
    frame: Size<Drawn>,
    drawn: &[Point<Stored>],
    donor: Option<[Extent<Stored>; 2]>,
) -> Rect<Drawn> {
    let on: Vec<Point<Drawn>> = drawn
        .iter()
        .map(|p| p.onto(frame.stored(), frame))
        .collect();
    let (width, height) = frame.raw();
    let grid = Grid::over(
        frame,
        Rect::exact(0, 0, width, height),
        &on,
        donor.map(|donor| in_pixels(donor, frame)),
    );
    let [left, top] = grid.origin;
    Rect::exact(
        left,
        top,
        (grid.cells.0 * grid.side).min(width - left),
        (grid.cells.1 * grid.side).min(height - top),
    )
}

/// A donor on the grid, in a frame of `frame`'s pixels.
fn in_pixels(donor: [Extent<Stored>; 2], frame: Size<Drawn>) -> [f64; 2] {
    let stored = frame.stored();
    [
        donor[0].onto(stored.width, frame.width).raw(),
        donor[1].onto(stored.height, frame.height).raw(),
    ]
}

/// A field on its way back from the device, for the loop it was averaged around.
pub struct Measuring {
    gpu: &'static Gpu,
    readback: gpu::Buffer,
    grid: Grid,
    drawn: Vec<Point<Stored>>,
    donor: Option<[Extent<Stored>; 2]>,
}

/// Averages the frame around `drawn` into the field the search reads, and starts it back - or,
/// where the reader has put the fill's place at `donor`, the field around there too.
///
/// `frame` is a window at `origin` of a picture of `whole`'s size, which is the whole of it where
/// `origin` is zero; the search looks no further than the window holds.
///
/// Split from [`Measuring::solved`] at the readback, which a browser has to await: a caller holding
/// the frame behind a borrow can let it go before the wait.
pub fn measure(
    frame: &Resident,
    whole: Size<Drawn>,
    origin: At<Drawn>,
    drawn: Vec<Point<Stored>>,
    donor: Option<[Extent<Stored>; 2]>,
) -> Result<Measuring, String> {
    let on: Vec<Point<Drawn>> = drawn
        .iter()
        .map(|p| p.onto(whole.stored(), whole))
        .collect();
    let (left, top) = origin.raw();
    let held = Rect::exact(left, top, frame.width, frame.height);
    let grid = Grid::over(whole, held, &on, donor.map(|donor| in_pixels(donor, whole)));
    let gpu = frame.gpu();
    let base = crate::base::device(gpu)
        .ok_or_else(|| crate::base::without_a_device("the repair's search"))?;
    let kernel = crate::repair::averaging(gpu);
    let bytes = (grid.cells.0 * grid.cells.1 * 3 * 4) as u64;

    let mut recording = gpu.record();
    recording.holding(frame.buffer());
    let cells = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("repair cells"),
        size: bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("repair cells readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let block = Params {
        size: [frame.width as u32, frame.height as u32],
        cell: grid.side as u32,
        cells: [grid.cells.0 as u32, grid.cells.1 as u32],
        origin: [
            (grid.origin[0] - left) as u32,
            (grid.origin[1] - top) as u32,
        ],
        ..Default::default()
    };
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("repair cells params"),
        contents: bytemuck::bytes_of(&block),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("repair cells"),
        layout: &kernel.layout,
        entries: &[
            entry(0, &uniform),
            entry(1, frame.buffer()),
            entry(3, base.light_of_code()),
            entry(5, &cells),
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(
            (grid.cells.0 as u32).div_ceil(8),
            (grid.cells.1 as u32).div_ceil(8),
            1,
        );
    }
    recording
        .encoder()
        .copy_buffer_to_buffer(&cells, 0, &readback, 0, bytes);
    recording.submit();
    Ok(Measuring {
        gpu,
        readback,
        grid,
        drawn,
        donor,
    })
}

impl Measuring {
    /// Up to [`OPTIONS`] repairs of the loop, cheapest seam first, none reading its fill from
    /// under the seam of any of `others`.
    ///
    /// **Not from under another repair**, because every repair reads the picture as it was before
    /// any of them (`repair.slang`), and under another's seam that is the thing it removed.
    ///
    /// `grow` lets the seam grow past the loop to wherever it is cheapest; without it the seam is
    /// the loop as drawn, and places are offered best match first.
    pub async fn solved(self, others: &[Repair], grow: bool) -> Result<Vec<Repair>, String> {
        let grid = self.grid;
        let values: Vec<f32> = gpu::read_back(self.gpu, &self.readback, |bytes| {
            bytes
                .chunks_exact(4)
                .map(|word| f32::from_le_bytes([word[0], word[1], word[2], word[3]]))
                .collect()
        })
        .await
        .ok_or("the field around the loop could not be read back")?;
        let field = SeamField {
            level: values
                .chunks_exact(3)
                .flat_map(|cell| [cell[0], cell[0]])
                .collect(),
            tint: values
                .chunks_exact(3)
                .flat_map(|cell| [cell[1], cell[2]])
                .collect(),
            sources: 1,
        };
        let stored = grid.frame.stored();
        let on = |loop_: &[Point<Stored>]| -> Vec<Point<Drawn>> {
            loop_.iter().map(|p| p.onto(stored, grid.frame)).collect()
        };
        let drawn = grid.filled(&on(&self.drawn));
        let mut forbidden = vec![false; drawn.len()];
        for other in others {
            for (at, under) in grid.filled(&on(&other.seam)).into_iter().enumerate() {
                forbidden[at] |= under;
            }
        }
        let hole = grown(&drawn, grid.cells, GUARD);
        let found = match self.donor {
            None => choices(&field, grid.cells, &hole, &forbidden, OPTIONS, grow),
            Some(donor) => {
                let side = grid.side as f64;
                let shift = in_pixels(donor, grid.frame).map(|px| px / side);
                placed(&field, grid.cells, &hole, &forbidden, shift, grow)
                    .into_iter()
                    .collect()
            }
        };
        Ok(found
            .iter()
            .filter_map(|choice| grid.repair(choice, &hole, &self.drawn))
            .collect())
    }
}

impl Grid {
    /// One choice as the document would hold it.
    fn repair(&self, choice: &Choice, hole: &[bool], drawn: &[Point<Stored>]) -> Option<Repair> {
        let stored = self.frame.stored();
        let seam = match &choice.fill {
            None => drawn.to_vec(),
            Some(fill) => self.seam_of(fill, hole)?,
        };
        let side = self.side as f64;
        let shift = choice
            .shift
            .map(|cells| Extent::<Drawn>::exactly(cells * side));
        let on_frame: Vec<Point<Drawn>> =
            drawn.iter().map(|p| p.onto(stored, self.frame)).collect();
        let gain = Gain::of(Stops::measured(-choice.gap.raw()))
            .raw()
            .clamp(1.0 / MOST_GAIN, MOST_GAIN);
        Repair {
            drawn: drawn.to_vec(),
            seam,
            donor: [
                shift[0].onto(self.frame.width, stored.width),
                shift[1].onto(self.frame.height, stored.height),
            ],
            gain: Gain::of_ratio(gain),
            feather: Some(
                offered_feather(&on_frame, self.frame).onto(self.frame.width, stored.width),
            ),
        }
        .on_grid()
        .ok()
    }

    /// A traced point, in cells, taken onto the frame's edge where it is in a cell at that edge.
    ///
    /// A trace passes through the middle of a cell's side, so a fill reaching the frame's edge is
    /// traced half a cell inside it at its corners, and simplifying that slants the whole edge in.
    fn onto_the_border(&self, [x, y]: [f32; 2]) -> [f32; 2] {
        let side = self.side as f32;
        let (w, h) = self.cells;
        let (width, height) = self.frame.raw();
        let edge = |at: f32, origin: usize, cells: usize, extent: usize| {
            let far = (extent - origin) as f32 / side - 0.5;
            match () {
                _ if origin == 0 && at <= 0.0 => -0.5,
                _ if origin + cells * self.side >= extent && at >= cells as f32 - 1.0 => far,
                _ => at,
            }
        };
        [
            edge(x, self.origin[0], w, width),
            edge(y, self.origin[1], h, height),
        ]
    }

    /// The loop around the cells of `fill` joined to `hole`, on the grid, simplified to what the
    /// document holds.
    fn seam_of(&self, fill: &[bool], hole: &[bool]) -> Option<Vec<Point<Stored>>> {
        let traced: Vec<[f32; 2]> = trace(&reached_from(fill, hole, self.cells), self.cells)
            .into_iter()
            .map(|point| self.onto_the_border(point))
            .collect();
        let mut tolerance = 0.5f32;
        let mut loop_ = simplify(&traced, tolerance);
        while loop_.len() > MOST_VERTICES {
            tolerance *= 1.5;
            loop_ = simplify(&traced, tolerance);
        }
        if loop_.len() < 3 {
            return None;
        }
        let stored = self.frame.stored();
        Some(
            loop_
                .iter()
                .map(|&[x, y]| {
                    self.pixel_of([f64::from(x), f64::from(y)])
                        .onto(self.frame, stored)
                })
                .collect(),
        )
    }
}

/// One place a fill could come from.
struct Choice {
    /// Where, in cells, to a fraction of one.
    shift: [f64; 2],
    /// How much brighter the ground there is than the ground around the hole.
    gap: Stops,
    /// The cells the cut fills from there, or none where the seam is the loop as drawn.
    fill: Option<Vec<bool>>,
    /// What the seam around them costs, or how well the place matched where nothing was cut.
    cost: f32,
}

/// Up to `most` places to fill `hole` from, cheapest seam first - or, where `grow` is off and
/// nothing is cut, best match first.
///
/// A place is admitted only where everything the hole would read from it is on the field, and
/// neither in the hole itself nor `forbidden`: the rest of what the seam grows over is the cut's to
/// decide, and it keeps any cell whose fill would come from somewhere it may not.
fn choices(
    field: &SeamField,
    size: (usize, usize),
    hole: &[bool],
    forbidden: &[bool],
    most: usize,
    grow: bool,
) -> Vec<Choice> {
    let Some((patch, room)) = around(field, size, hole) else {
        return Vec::new();
    };
    let holed: Vec<usize> = (0..size.0 * size.1).filter(|&p| hole[p]).collect();
    let usable = |q: Option<usize>| {
        q.is_some_and(|q| !hole[q] && !forbidden[q] && field.frame(q, 0).is_some())
    };
    let allowed = |offset: [isize; 2]| holed.iter().all(|&p| usable(shifted(p, offset, size)));
    let apart = (GROW / 2).max(1) as isize;

    let mut out: Vec<Choice> = patch
        .ranked_within(0, most, REACH as isize, apart, allowed)
        .into_iter()
        .filter_map(|found| {
            let offset = found.shift.map(|cells| cells.round() as isize);
            let gap = patch.gap(0, offset)?;
            let (fill, cost) = match grow {
                true => {
                    let (fill, cost) = cut(field, size, hole, &room, forbidden, offset, gap);
                    (Some(fill), cost)
                }
                false => (None, found.score),
            };
            Some(Choice {
                shift: found.shift,
                gap,
                fill,
                cost,
            })
        })
        .collect();
    out.sort_by(|a, b| a.cost.total_cmp(&b.cost));
    out
}

/// The ground around `hole`, which a place is matched against and brought to the light of, and the
/// room the seam may grow into.
fn around<'a>(
    field: &'a SeamField,
    size: (usize, usize),
    hole: &[bool],
) -> Option<(Patch<'a>, Vec<bool>)> {
    let (w, h) = size;
    let holed: Vec<usize> = (0..w * h).filter(|&p| hole[p]).collect();
    if holed.is_empty() {
        return None;
    }
    let room = grown(hole, size, GROW);
    let centre = {
        let [sx, sy] = holed
            .iter()
            .fold([0usize; 2], |[sx, sy], &p| [sx + p % w, sy + p / w]);
        [sx / holed.len(), sy / holed.len()]
    };
    let (cx, cy) = (centre[0] as isize, centre[1] as isize);
    let ring = (0..w * h)
        .filter(|&p| room[p] && !hole[p])
        .map(|p| ([(p % w) as isize - cx, (p / w) as isize - cy], 1.0));
    Some((Patch::over(field, size, 0, centre, ring)?, room))
}

/// The fill read `shift` cells away, where the reader put it: brought to the light around the hole
/// and, where `grow`, cut as a found place is. Taken whatever it reads, since the reader chose it -
/// a cell whose fill would come from somewhere it may not is still kept, as the cut keeps it.
fn placed(
    field: &SeamField,
    size: (usize, usize),
    hole: &[bool],
    forbidden: &[bool],
    shift: [f64; 2],
    grow: bool,
) -> Option<Choice> {
    let (patch, room) = around(field, size, hole)?;
    let offset = shift.map(|cells| cells.round() as isize);
    // Off the field there is no ground there to match the light of, so the light is left alone.
    let gap = patch.gap(0, offset).unwrap_or(Stops::measured(0.0));
    let (fill, cost) = match grow {
        true => {
            let (fill, cost) = cut(field, size, hole, &room, forbidden, offset, gap);
            (Some(fill), cost)
        }
        false => (None, 0.0),
    };
    Some(Choice {
        shift,
        gap,
        fill,
        cost,
    })
}

/// Where the fill for `p` is read from, `offset` away, if that is on the field.
fn shifted(p: usize, [ox, oy]: [isize; 2], (w, h): (usize, usize)) -> Option<usize> {
    let (x, y) = ((p % w) as isize + ox, (p / w) as isize + oy);
    (x >= 0 && y >= 0 && x < w as isize && y < h as isize).then(|| y as usize * w + x as usize)
}

/// The cells of `room` the fill from `offset` should take, and what the seam around them costs.
///
/// Two labels, so one cut: a cell keeps the photograph or takes the fill. `hole` must take it,
/// and a cell whose fill would come from off the field, from the hole or from `forbidden` must
/// not. Everything else is the seam's cost - `assembly_labelling`'s, over the photograph against
/// the fill brought to its light - so the fill grows out to wherever the two agree and stops there.
fn cut(
    field: &SeamField,
    size: (usize, usize),
    hole: &[bool],
    room: &[bool],
    forbidden: &[bool],
    offset: [isize; 2],
    gap: Stops,
) -> (Vec<bool>, f32) {
    let (w, h) = size;
    let from = |p: usize| shifted(p, offset, size);
    let apart: Vec<f32> = (0..w * h)
        .map(|p| {
            let there = from(p).and_then(|q| Some((q, field.frame(q, 0)?)));
            match (field.frame(p, 0), there) {
                (Some(here), Some((q, there))) => differ(
                    (here.raw() - (there.raw() - gap.raw())) as f32,
                    field.tint(p, 0),
                    field.tint(q, 0),
                ),
                _ => 1.0,
            }
        })
        .collect();
    let nodes: Vec<usize> = (0..w * h).filter(|&p| room[p]).collect();
    let mut node = vec![usize::MAX; w * h];
    for (i, &p) in nodes.iter().enumerate() {
        node[p] = i;
    }

    let mut fill_cost = vec![0.0f32; nodes.len()];
    let mut keep_cost = vec![0.0f32; nodes.len()];
    let mut graph = MinCut::with_capacity(nodes.len(), nodes.len() * NEIGHBOURS.len() * 2);
    for (i, &p) in nodes.iter().enumerate() {
        if hole[p] {
            keep_cost[i] = FORCED;
        }
        let clean =
            from(p).is_some_and(|q| !hole[q] && !forbidden[q] && field.frame(q, 0).is_some());
        if !clean {
            fill_cost[i] += FORCED;
        }
        let (x, y) = ((p % w) as isize, (p / w) as isize);
        for &(dx, dy, k) in &NEIGHBOURS {
            for sign in [1isize, -1] {
                let (nx, ny) = (x + sign * dx, y + sign * dy);
                if nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize {
                    continue;
                }
                let q = ny as usize * w + nx as usize;
                let seam = k * (0.5 * (apart[p] + apart[q]) * along_an_edge(field, p, q) + TIE);
                match node[q] {
                    // Outside the room the photograph stays, so filling here puts a seam between.
                    usize::MAX => fill_cost[i] += seam,
                    j if sign == 1 => {
                        graph.add(i, j, seam);
                        graph.add(j, i, seam);
                    }
                    _ => {}
                }
            }
        }
    }
    for i in 0..nodes.len() {
        let least = fill_cost[i].min(keep_cost[i]);
        graph.terminals(i, fill_cost[i] - least, keep_cost[i] - least);
    }
    let cost = graph.max_flow();
    let kept = graph.source_side();
    let mut fill = vec![false; w * h];
    for (i, &p) in nodes.iter().enumerate() {
        fill[p] = !kept[i];
    }
    (fill, cost)
}

/// `mask` grown by `by` cells every way.
fn grown(mask: &[bool], (w, h): (usize, usize), by: usize) -> Vec<bool> {
    let mut rows = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            if mask[y * w + x] {
                for nx in x.saturating_sub(by)..(x + by + 1).min(w) {
                    rows[y * w + nx] = true;
                }
            }
        }
    }
    let mut out = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            if rows[y * w + x] {
                for ny in y.saturating_sub(by)..(y + by + 1).min(h) {
                    out[ny * w + x] = true;
                }
            }
        }
    }
    out
}

/// The cells of `fill` joined to `hole`: one region, which is what a seam is one loop around.
fn reached_from(fill: &[bool], hole: &[bool], size: (usize, usize)) -> Vec<bool> {
    let mut out = vec![false; fill.len()];
    let mut pending: Vec<usize> = (0..fill.len()).filter(|&p| hole[p] && fill[p]).collect();
    for &p in &pending {
        out[p] = true;
    }
    while let Some(p) = pending.pop() {
        for q in crate::assembly_labelling::four(p, size) {
            if fill[q] && !out[q] {
                out[q] = true;
                pending.push(q);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: (usize, usize) = (240, 200);
    const PERIOD: f64 = 10.0;
    const CENTRE: [usize; 2] = [120, 100];

    /// Stripes a `PERIOD` apart, and a bright, coloured disc on them at `CENTRE`.
    fn striped() -> SeamField {
        let (w, h) = SIZE;
        let mut level = Vec::new();
        let mut tint = Vec::new();
        for p in 0..w * h {
            let (x, y) = ((p % w) as f64, (p / w) as f64);
            let (dx, dy) = (x - CENTRE[0] as f64, y - CENTRE[1] as f64);
            let (light, colour) = match dx * dx + dy * dy < 64.0 {
                true => (3.0, 0.5),
                false => (0.8 * (x * std::f64::consts::TAU / PERIOD).sin(), 0.0),
            };
            level.extend([light as f32; 2]);
            tint.extend([colour as f32, 0.0]);
        }
        SeamField {
            level,
            tint,
            sources: 1,
        }
    }

    fn hole() -> Vec<bool> {
        let (w, h) = SIZE;
        (0..w * h)
            .map(|p| {
                let (dx, dy) = (
                    (p % w) as f64 - CENTRE[0] as f64,
                    (p / w) as f64 - CENTRE[1] as f64,
                );
                dx * dx + dy * dy < 144.0
            })
            .collect()
    }

    /// Filled from somewhere the stripes line up, never from the thing being removed, and the seam
    /// no further out than it has to be where the fill matches everywhere.
    #[test]
    fn a_hole_is_filled_from_ground_that_matches_the_ground_around_it() {
        let field = striped();
        let hole = hole();
        let forbidden = vec![false; hole.len()];
        let found = choices(&field, SIZE, &hole, &forbidden, OPTIONS, true);
        assert_eq!(found.len(), OPTIONS, "offered {}", found.len());

        let (w, _) = SIZE;
        for choice in &found {
            let across = choice.shift[0].rem_euclid(PERIOD);
            assert!(
                across.min(PERIOD - across) < 0.5,
                "a fill {:?} away puts the stripes out of step",
                choice.shift
            );
            assert!(choice.gap.raw().abs() < 0.05, "a gap of {:?}", choice.gap);
            let offset = choice.shift.map(|cells| cells.round() as isize);
            let fill = choice.fill.as_ref().expect("a cut");
            for p in (0..hole.len()).filter(|&p| hole[p]) {
                assert!(fill[p], "the cut left part of the hole");
            }
            for p in (0..hole.len()).filter(|&p| fill[p]) {
                let q = shifted(p, offset, SIZE).expect("on the field");
                let (dx, dy) = (
                    (q % w) as f64 - CENTRE[0] as f64,
                    (q / w) as f64 - CENTRE[1] as f64,
                );
                assert!(dx * dx + dy * dy >= 64.0, "the fill reads the disc back in");
            }
            let filled = fill.iter().filter(|&&f| f).count();
            let holed = hole.iter().filter(|&&f| f).count();
            assert!(
                filled <= holed * 3 / 2,
                "{filled} filled for a hole of {holed}"
            );
        }
        assert!(
            found.windows(2).all(|pair| pair[0].cost <= pair[1].cost),
            "not cheapest first"
        );
    }

    /// Not grown, nothing is cut: the same places, matched as well, best match first.
    #[test]
    fn a_hole_not_grown_is_offered_places_without_a_cut() {
        let field = striped();
        let hole = hole();
        let forbidden = vec![false; hole.len()];
        let found = choices(&field, SIZE, &hole, &forbidden, OPTIONS, false);
        assert_eq!(found.len(), OPTIONS, "offered {}", found.len());
        for choice in &found {
            assert!(choice.fill.is_none(), "{:?} was cut", choice.shift);
            let across = choice.shift[0].rem_euclid(PERIOD);
            assert!(
                across.min(PERIOD - across) < 0.5,
                "a fill {:?} away puts the stripes out of step",
                choice.shift
            );
        }
        assert!(
            found.windows(2).all(|pair| pair[0].cost <= pair[1].cost),
            "not best match first"
        );
    }

    /// Nothing is read from under another repair's seam, which the pass would read as it was
    /// before that repair: the thing it removed.
    #[test]
    fn a_fill_is_never_read_from_under_another_repair() {
        let field = striped();
        let hole = hole();
        let (w, _) = SIZE;
        let forbidden: Vec<bool> = (0..hole.len())
            .map(|p| (p % w) as isize > CENTRE[0] as isize + 20)
            .collect();
        let found = choices(&field, SIZE, &hole, &forbidden, OPTIONS, true);
        assert!(!found.is_empty());
        for choice in &found {
            let offset = choice.shift.map(|cells| cells.round() as isize);
            let fill = choice.fill.as_ref().expect("a cut");
            for p in (0..hole.len()).filter(|&p| fill[p]) {
                let q = shifted(p, offset, SIZE).expect("on the field");
                assert!(
                    !forbidden[q],
                    "{:?} reads from under another seam",
                    choice.shift
                );
            }
        }
    }

    /// A fill brought from ground a stop brighter is taken down a stop to meet the ground around
    /// the hole.
    #[test]
    fn a_fill_is_brought_to_the_light_around_the_hole() {
        let mut field = striped();
        let (w, _) = SIZE;
        for p in 0..SIZE.0 * SIZE.1 {
            let (dx, dy) = (
                (p % w) as f64 - CENTRE[0] as f64,
                (p / w) as f64 - CENTRE[1] as f64,
            );
            // Everything but the hole's own neighbourhood a stop brighter.
            if dx.abs().max(dy.abs()) > 30.0 {
                field.level[p * 2] += 1.0;
                field.level[p * 2 + 1] += 1.0;
            }
        }
        let hole = hole();
        let forbidden = vec![false; hole.len()];
        let found = choices(&field, SIZE, &hole, &forbidden, OPTIONS, true);
        let far = found
            .iter()
            .find(|choice| choice.shift[0].abs().max(choice.shift[1].abs()) > 60.0)
            .expect("a fill from the brighter ground");
        assert!((far.gap.raw() - 1.0).abs() < 0.05, "a gap of {:?}", far.gap);
    }
}
