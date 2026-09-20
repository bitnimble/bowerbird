//! What two frames of a composite have in common: how far apart they sit, and where their content
//! actually corresponds.
//!
//! Two stages, because the searches that answer them are different shapes. `coarse` tries every
//! whole-frame translation of one small plane against another, which is the only way to find an
//! overlap nobody has told us about; `corresponded_about` then reads a nine-pixel window about an
//! offset already believed, which is the only affordable way to answer the same question densely
//! at a preview's own size.

use crate::hdr_fit::{
    DevicePlane, Kernel, READ, Reach, Source, UNIFORM, WRITE, corresponded_about, kernel,
};

/// The long edge both planes are reduced to for the coarse search, as `composite_coarse.slang` says.
pub const COARSE_LONG: usize = 202;

/// The overlap, as a fraction of a whole plane, at which a candidate is believed in full.
///
/// Two frames of a hand-held panorama overlap by a quarter to a half; below that the correlation
/// is being taken over a sliver, and a sliver of sky correlates with anything.
const OVERLAP_FULL: f64 = 0.35;

/// Where one plane sits against another, in that plane's own pixels.
#[derive(Clone, Copy, Debug)]
pub struct Coarse {
    /// b's pixel (x, y) shows what a shows at (x + dx, y + dy).
    pub dx: i32,
    pub dy: i32,
    /// The correlation, weighted down where the overlap is too small to trust it.
    pub score: f64,
    /// How much of a frame the two share at this translation.
    pub overlap: f64,
}

fn coarse_device(gpu: &'static crate::gpu::Gpu) -> &'static Kernel {
    static BUILT: std::sync::OnceLock<Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        kernel(
            gpu,
            "composite_coarse",
            include_str!(concat!(env!("OUT_DIR"), "/wgsl/composite_coarse.wgsl")),
            &[(0, READ), (1, READ), (2, WRITE), (20, UNIFORM)],
            &[],
        )
    })
}

/// `composite_coarse.slang`'s `numthreads`.
const COARSE_GROUP: u32 = 64;

/// The best whole-frame translation of `b` against `a`, or None where the device declines.
///
/// `min_overlap` bounds the search rather than filtering it: a translation that leaves less than
/// that fraction of an axis overlapping is not a panorama's neighbour, it is two frames of
/// different things, and searching for it costs candidates that can only produce false peaks.
pub async fn coarse(
    gpu: &'static crate::gpu::Gpu,
    a: &DevicePlane,
    b: &DevicePlane,
    min_overlap: f64,
) -> Option<Coarse> {
    let (aw, ah) = (a.width as i32, a.height as i32);
    let (bw, bh) = (b.width as i32, b.height as i32);
    // Asymmetric where the two planes are not the same shape: a translation slides b's extent
    // across a's, so how far it may go one way is bounded by a and the other way by b.
    let least = |a: i32, b: i32| ((min_overlap * f64::from(a.min(b))).round() as i32).max(1);
    let (max_dx, min_dx) = (aw - least(aw, bw), -(bw - least(aw, bw)));
    let (max_dy, min_dy) = (ah - least(ah, bh), -(bh - least(ah, bh)));
    let across = max_dx - min_dx + 1;
    let down = max_dy - min_dy + 1;
    let candidates = (across * down) as usize;

    let mut recording = gpu.record();
    let scored = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("pano coarse scored"),
        size: (candidates * 3 * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let staging = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("pano coarse out"),
        size: (candidates * 3 * 4) as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut block = [
        aw.to_ne_bytes(),
        ah.to_ne_bytes(),
        bw.to_ne_bytes(),
        bh.to_ne_bytes(),
        min_dx.to_ne_bytes(),
        max_dx.to_ne_bytes(),
        min_dy.to_ne_bytes(),
        max_dy.to_ne_bytes(),
        (OVERLAP_FULL as f32).to_ne_bytes(),
    ]
    .concat();
    block.resize(48, 0);
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pano coarse push"),
        contents: &block,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let kernels = coarse_device(gpu);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("pano coarse"),
        layout: &kernels.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: a.buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: b.buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: scored.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 20,
                resource: push.as_entire_binding(),
            },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernels.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((candidates as u32).div_ceil(COARSE_GROUP), 1, 1);
    }
    recording
        .encoder()
        .copy_buffer_to_buffer(&scored, 0, &staging, 0, (candidates * 3 * 4) as u64);
    recording.submit();

    // The maximum over candidates, on the host. A reduction over a hundred thousand scores is not
    // a walk over a picture: the pixels were reduced on the device, and what comes back is one
    // number per translation.
    let best = crate::gpu::read_back(gpu, &staging, |mapped| {
        mapped
            .chunks_exact(12)
            .map(|word| {
                let take = |at: usize| {
                    f32::from_ne_bytes([word[at], word[at + 1], word[at + 2], word[at + 3]])
                };
                (f64::from(take(0)), take(4) as i32, take(8) as i32)
            })
            .max_by(|left, right| left.0.total_cmp(&right.0))
    })
    .await??;

    let (score, dx, dy) = best;
    let span =
        |extent_a: i32, extent_b: i32, d: i32| (extent_b.min(extent_a - d) - 0.max(-d)).max(0);
    let shared = f64::from(span(aw, bw, dx) * span(ah, bh, dy)) / f64::from((aw * ah).min(bw * bh));
    Some(Coarse {
        dx,
        dy,
        score,
        overlap: shared,
    })
}

/// One frame's luma at several sizes, each half the one above it.
///
/// The coarse search runs on the smallest, where trying every translation is affordable, and the
/// answer is carried up: each level's offsets are the level below's doubled, refined by a
/// nine-pixel search. The smallest is always about `COARSE_LONG`, whatever the plane on top is.
pub struct Pyramid {
    levels: Vec<DevicePlane>,
}

/// How many halvings it takes to bring a plane whose long edge is `long` down to `COARSE_LONG`.
///
/// **Counted, not fixed, because the plane on top is not one size.** A RAW's preview is 1616
/// and three halvings reach the 202 the coarse search is built for; a grid tile is 800, where the
/// same three reach 100 and the whole-frame translation is searched on a plane a quarter the area
/// it was designed for. Measured on the twenty-six frame set from the library's own tiles, that is
/// what put two frames of the row a step out and split the panorama into four drifting strips.
fn levels_over(long: usize) -> usize {
    let halvings = (long as f64 / COARSE_LONG as f64).log2().round().max(0.0) as usize;
    halvings + 1
}

impl Pyramid {
    /// The levels of `source`, with the top one tabulated so a dense search into it is affordable.
    pub fn of(gpu: &'static crate::gpu::Gpu, source: &Source) -> Pyramid {
        let mut levels: Vec<DevicePlane> = (0..levels_over(source.width.max(source.height)))
            .rev()
            .map(|above| {
                let shrink = 1 << above;
                DevicePlane::reduced_luma(
                    gpu,
                    source,
                    (source.width / shrink).max(1),
                    (source.height / shrink).max(1),
                )
            })
            .collect();
        // Only the top: every level below it is searched at a stride, where the windows of two
        // neighbouring points barely overlap and tabulating a plane costs more than it saves.
        let top = levels.pop().expect("a pyramid has levels");
        // Tabulated for the window the search will actually read, which is a share of this plane
        // rather than a count of pixels: a set aligned on grid tiles arrives at half the size a set
        // aligned on RAW previews does.
        let reach = Reach::across(top.width.max(top.height));
        levels.push(top.tabulated(gpu, reach));
        Pyramid { levels }
    }

    /// The smallest level, which is what `coarse` searches.
    pub fn coarse(&self) -> &DevicePlane {
        &self.levels[0]
    }

    /// What a coarse offset is multiplied by to reach the top level's pixels.
    pub fn coarse_scale(&self) -> usize {
        (self.top().width / self.coarse().width.max(1)).max(1)
    }

    /// The preview's own size, which is the plane a recipe's coordinates are in.
    pub fn top(&self) -> &DevicePlane {
        self.levels.last().expect("a pyramid has levels")
    }
}

/// Where one point of `a` is in `b`, in the top level's pixels.
#[derive(Clone, Copy, Debug)]
pub struct Match {
    pub a: [f64; 2],
    pub b: [f64; 2],
    pub peak: f64,
}

/// Two frames that overlap, and where their content actually corresponds.
#[derive(Clone)]
pub struct Pair {
    pub a: usize,
    pub b: usize,
    pub score: f64,
    pub matches: Vec<Match>,
    /// Correspondences the refine found, before `agreeing` kept only those that fit one mapping.
    ///
    /// **What a pair is ranked by, where `matches` is what it is fitted from.** The consensus takes
    /// most of a pair whose overlap is thin and repetitive and rather less of a coincidence that
    /// found one solid cluster, so counting what survives it can order two pairs the wrong way round
    /// - measured, a true neighbour of 325 correspondences kept 41 where a coincidence of 177 kept
    /// 50. How much was found says which pair to believe; what agrees says where the frames go.
    pub found: usize,
    /// Whether the frames' corners said this overlap is singular, independently of the search.
    ///
    /// Carried into the solve because it answers a question the reprojection cannot: a pair that
    /// disagrees with the standing answer is either a coincidence or a true overlap the growth has
    /// drifted away from, and the residual alone reads the same either way.
    pub vouched: bool,
}

/// How far apart the points a level is searched at are. Not a resolution: a denser grid buys
/// nothing a rotation solve can use, and every point costs 81 correlations.
const STRIDE: usize = 8;
/// The top level's, which is the one whose points become the pair's matches.
const TOP_STRIDE: usize = 6;

/// How wide a tile the belief handed to the next level is a median over.
///
/// A median rather than each point's own answer: the level below is half the size, so one of its
/// points stands for four of this one's, and a single bad correspondence down there would send a
/// whole neighbourhood up here to the wrong place. Wide enough to hold several points and narrow
/// enough that a real parallax gradient across the frame survives it.
const TILE: usize = 32;

/// The dense correspondences of one pair, in the top level's pixels.
///
/// `coarse` is in the coarse level's, as `coarse()` returns it: b's pixel (x, y) shows what a
/// shows at (x + dx, y + dy), so a point of a is found in b at minus that.
pub async fn refined(
    gpu: &'static crate::gpu::Gpu,
    a: &Pyramid,
    b: &Pyramid,
    from: Coarse,
) -> Refined {
    let mut belief = Field::uniform([-f64::from(from.dx), -f64::from(from.dy)]);
    let mut matches = Vec::new();
    let mut settled = Vec::new();
    let mut sampled = 0;
    for level in 1..a.levels.len() {
        let ours = &a.levels[level];
        let theirs = &b.levels[level];
        let top = level + 1 == a.levels.len();
        let stride = if top { TOP_STRIDE } else { STRIDE };
        // **A share of the level, not a count of pixels.** Each level is half the one above, so an
        // absolute window covers twice the picture a step down - which is fine for finding a rough
        // place to look and wrong for stating what a comparison is. The same fraction everywhere
        // makes the pyramid self-similar, and makes a set aligned on 800px grid tiles search the
        // same content as one aligned on 1616px previews.
        let reach = Reach::across(ours.width.max(ours.height));
        // Doubled, this level being twice the size of the one the belief was measured on.
        belief = belief.doubled();

        let margin = reach.margin() as usize;
        let points: Vec<[i32; 2]> = (margin..ours.height.saturating_sub(margin))
            .step_by(stride)
            .flat_map(|y| {
                (margin..ours.width.saturating_sub(margin))
                    .step_by(stride)
                    .map(move |x| [x as i32, y as i32])
            })
            .collect();
        if points.is_empty() {
            return Refined::none();
        }
        let given: Vec<[i32; 2]> = points
            .iter()
            .map(|p| {
                let [dx, dy] = belief.at(p[0] as usize, p[1] as usize);
                [dx.round() as i32, dy.round() as i32]
            })
            .collect();
        let Some(found) =
            corresponded_about(gpu, ours, theirs, &points, Some(&given), -1, reach).await
        else {
            return Refined::none();
        };

        let offsets: Vec<Option<[f64; 2]>> = found
            .iter()
            .map(|f| f.as_ref().filter(|f| !f.featureless).map(|f| [f.dx, f.dy]))
            .collect();
        let measured = Field::of(ours.width, ours.height, &points, &offsets);
        if !top {
            belief = measured;
            continue;
        }

        // The top level's answers are the pair's, less the ones that disagree with their
        // neighbours: a correspondence that is three pixels from what everything around it found
        // is a repeated window frame or a moving leaf, and the solve has no way to tell.
        sampled = points.len();
        matches = points
            .iter()
            .zip(&found)
            .filter_map(|(point, found)| {
                let found = found.as_ref()?;
                if found.featureless {
                    return None;
                }
                let [mx, my] = measured.at(point[0] as usize, point[1] as usize);
                let (dx, dy) = (found.dx, found.dy);
                if (dx - mx).abs() > AGREEMENT_PX || (dy - my).abs() > AGREEMENT_PX {
                    return None;
                }
                let (x, y) = (f64::from(point[0]), f64::from(point[1]));
                Some(Match {
                    a: [x, y],
                    b: [x + dx, y + dy],
                    peak: found.peak,
                })
            })
            .collect();

        settled = agreeing(&matches);
    }
    Refined {
        found: matches,
        settled,
        sampled,
    }
}

/// What a pair's refine came to.
///
/// **Two answers, because the two questions are different.** Whether these frames overlap at all,
/// and which of a set's pairs to believe first, are asked of what the search *found* - that is the
/// evidence, and the bars it is judged by are set against it. Where the frames go is asked of what
/// agrees, which is fewer points and better ones. Ranking on the second inverts pairs: measured, a
/// true neighbour of 325 correspondences settled to 41 where a coincidence of 177 settled to 50.
pub struct Refined {
    /// What the search found, unjudged beyond its own tiles.
    pub found: Vec<Match>,
    /// Those, looked at again about the mapping they agree on, and kept where they still agree.
    pub settled: Vec<Match>,
    /// Grid points walked across the frame, of which `found` are the ones that corresponded.
    pub sampled: usize,
}

impl Refined {
    fn none() -> Refined {
        Refined {
            found: Vec::new(),
            settled: Vec::new(),
            sampled: 0,
        }
    }
}

/// How far a correspondence may sit from what its tile agreed on before it is dropped.
const AGREEMENT_PX: f64 = 3.0;

/// Only the correspondences that agree on one mapping of the whole overlap.
///
/// **The test above it is local, and a city is locally consistent about being wrong.** A patch of
/// glass facade correlates with a *different* row of the same windows at very nearly 1.0, and its
/// neighbours make the same mistake by the same amount, so a whole tile of them agrees and survives
/// a test against its own median. Measured on a pair of frames over Wellington: 378 correspondences
/// of which a third agreed on an offset, and the ones that had locked on hardest - past 0.9 - were
/// the *worst*, 8% of them agreeing, because a window matches a window better than a roofline
/// matches a roofline. No threshold on the correlation or the texture reaches that, and both were
/// tried.
///
/// What reaches it is that two frames a rotation apart are one smooth mapping apart, over the whole
/// overlap at once. A facade's misplaced patch agrees with its neighbours and not with the roofline
/// forty pixels away, so a consensus taken across the frame keeps the true field and drops it. An
/// affine rather than the homography the rotation really gives: over one overlap the difference is
/// under a pixel, and this is choosing which points to keep rather than where the frames go.
pub fn agreeing(matches: &[Match]) -> Vec<Match> {
    let Some(settled) = consensus(matches) else {
        return matches.to_vec();
    };
    matches
        .iter()
        .filter(|m| apart(&settled, m) <= MODEL_APART_PX)
        .copied()
        .collect()
}

/// The mapping the most of `matches` agree on, found by consensus over samples of three.
///
/// **An affine, so a frame rolled against its pair is not read as a disagreement.** Two frames of a
/// hand-held pan are a degree or two apart about the view direction, which slides the offset steadily
/// along the seam - a pair of frames measured against one translation therefore looks worse the more
/// of the seam it covers, which is backwards. Six parameters absorb that, along with the scale the
/// perspective across an overlap gives.
pub fn consensus(matches: &[Match]) -> Option<[f64; 6]> {
    if matches.len() < LEAST_FOR_CONSENSUS {
        return None;
    }
    // Deterministic, so a recipe does not depend on which way the wind blew: the same pair of
    // frames has to align the same way on every machine that renders it.
    let mut seed = 0x9E37_79B9_7F4A_7C15u64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    // Every `step`th rather than the first `JUDGED_ON`: the refine walks its grid in raster order,
    // so a prefix of `matches` is the top band of the overlap and nothing below it is ever counted
    // against a hypothesis. A mapping that explains one band and no more would score as well as the
    // one that explains the frame, which is the failure this whole function exists to catch.
    let step = (matches.len() / JUDGED_ON).max(1);
    let mut best = (0usize, [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
    for _ in 0..TRIES {
        let three = [
            &matches[next() as usize % matches.len()],
            &matches[next() as usize % matches.len()],
            &matches[next() as usize % matches.len()],
        ];
        let Some(mapping) = through(three) else {
            continue;
        };
        let held = matches
            .iter()
            .step_by(step)
            .filter(|m| apart(&mapping, m) <= MODEL_APART_PX)
            .count();
        if held > best.0 {
            best = (held, mapping);
        }
    }

    // Refitted on everything the best sample agreed with, so the mapping kept is the one all of
    // them state rather than the one three of them happened to.
    let held: Vec<&Match> = matches
        .iter()
        .filter(|m| apart(&best.1, m) <= MODEL_APART_PX)
        .collect();
    Some(fitted(&held).unwrap_or(best.1))
}

/// Below this a pair has too few correspondences for a consensus to mean anything, and the mapping
/// would be fitted to whatever three of them were drawn.
const LEAST_FOR_CONSENSUS: usize = 24;

/// How many samples are drawn. Three points of an overlap that is a third junk agree by chance about
/// once in thirty, so this is deep enough to be sure of finding one many times over.
const TRIES: usize = 240;

/// How many correspondences each sample is scored against. The field is smooth, so a few hundred
/// spread over it says the same as all of them and the search costs a fraction as much.
const JUDGED_ON: usize = 600;

/// How far a correspondence may sit from the mapping the rest agree on.
const MODEL_APART_PX: f64 = 3.0;

/// How far a correspondence lands from where the mapping puts it, in the plane's own pixels.
pub fn apart(mapping: &[f64; 6], m: &Match) -> f64 {
    let (x, y) = (m.a[0], m.a[1]);
    let (dx, dy) = (
        mapping[0] * x + mapping[1] * y + mapping[2] - m.b[0],
        mapping[3] * x + mapping[4] * y + mapping[5] - m.b[1],
    );
    (dx * dx + dy * dy).sqrt()
}

/// The affine through three correspondences exactly, or None where they are too near a line to
/// state one.
fn through(three: [&Match; 3]) -> Option<[f64; 6]> {
    let rows = [
        [three[0].a[0], three[0].a[1], 1.0],
        [three[1].a[0], three[1].a[1], 1.0],
        [three[2].a[0], three[2].a[1], 1.0],
    ];
    let across = solved(rows, [three[0].b[0], three[1].b[0], three[2].b[0]])?;
    let down = solved(rows, [three[0].b[1], three[1].b[1], three[2].b[1]])?;
    Some([across[0], across[1], across[2], down[0], down[1], down[2]])
}

/// The affine every one of these states together, by least squares.
fn fitted(held: &[&Match]) -> Option<[f64; 6]> {
    let mut normal = [[0.0f64; 3]; 3];
    let (mut across, mut down) = ([0.0f64; 3], [0.0f64; 3]);
    for m in held {
        let row = [m.a[0], m.a[1], 1.0];
        for i in 0..3 {
            for j in 0..3 {
                normal[i][j] += row[i] * row[j];
            }
            across[i] += row[i] * m.b[0];
            down[i] += row[i] * m.b[1];
        }
    }
    let across = solved(normal, across)?;
    let down = solved(normal, down)?;
    Some([across[0], across[1], across[2], down[0], down[1], down[2]])
}

/// A three by three by Cramer's rule.
fn solved(m: [[f64; 3]; 3], rhs: [f64; 3]) -> Option<[f64; 3]> {
    let of = |m: [[f64; 3]; 3]| {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    };
    let whole = of(m);
    // Against the size of the matrix's own terms, since these are pixel coordinates squared and a
    // determinant of a thousand is small among them.
    if whole.abs()
        < 1e-9
            * m.iter()
                .flatten()
                .map(|v| v.abs())
                .sum::<f64>()
                .powi(3)
                .max(1.0)
    {
        return None;
    }
    let mut out = [0.0; 3];
    for column in 0..3 {
        let mut swapped = m;
        for row in 0..3 {
            swapped[row][column] = rhs[row];
        }
        out[column] = of(swapped) / whole;
    }
    Some(out)
}

/// What each tile of a frame believes the offset to be, and the whole frame's answer where a tile
/// had nothing to say.
struct Field {
    tiles: Vec<Option<[f64; 2]>>,
    across: usize,
    /// How many pixels of the level being asked one tile covers. `TILE` where the field was
    /// measured, twice that once it has been carried up a level.
    tile_px: usize,
    whole: [f64; 2],
}

impl Field {
    fn uniform(offset: [f64; 2]) -> Field {
        Field {
            tiles: Vec::new(),
            across: 0,
            tile_px: TILE,
            whole: offset,
        }
    }

    fn of(width: usize, height: usize, points: &[[i32; 2]], offsets: &[Option<[f64; 2]>]) -> Field {
        let across = width.div_ceil(TILE);
        let down = height.div_ceil(TILE);
        let mut per_tile: Vec<Vec<[f64; 2]>> = vec![Vec::new(); across * down];
        let mut all: Vec<[f64; 2]> = Vec::new();
        for (point, offset) in points.iter().zip(offsets) {
            let Some(offset) = offset else { continue };
            let tile = (point[1] as usize / TILE) * across + point[0] as usize / TILE;
            per_tile[tile].push(*offset);
            all.push(*offset);
        }
        Field {
            tiles: per_tile.iter().map(|found| median(found)).collect(),
            across,
            tile_px: TILE,
            whole: median(&all).unwrap_or([0.0, 0.0]),
        }
    }

    /// The belief at a pixel: its own tile's, or the frame's where that tile found nothing.
    fn at(&self, x: usize, y: usize) -> [f64; 2] {
        if self.across == 0 {
            return self.whole;
        }
        let tile = (y / self.tile_px) * self.across + x / self.tile_px;
        self.tiles
            .get(tile)
            .copied()
            .flatten()
            .unwrap_or(self.whole)
    }

    /// The same field, read on a level twice the size: the offsets double with the pixels, and
    /// each tile covers twice the ground rather than the grid being rebuilt.
    fn doubled(&self) -> Field {
        Field {
            tiles: self
                .tiles
                .iter()
                .map(|t| t.map(|[x, y]| [x * 2.0, y * 2.0]))
                .collect(),
            across: self.across,
            tile_px: self.tile_px * 2,
            whole: [self.whole[0] * 2.0, self.whole[1] * 2.0],
        }
    }
}

/// The middle of what a tile found, or None where it found nothing.
///
/// Per axis, which is not the geometric median and does not need to be: the two axes of a
/// translation are measured independently and an outlier in one is an outlier on its own.
fn median(offsets: &[[f64; 2]]) -> Option<[f64; 2]> {
    if offsets.is_empty() {
        return None;
    }
    let middle = |axis: usize| {
        let mut values: Vec<f64> = offsets.iter().map(|o| o[axis]).collect();
        values.sort_by(f64::total_cmp);
        values[values.len() / 2]
    };
    Some([middle(0), middle(1)])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn searching() -> &'static crate::gpu::Gpu {
        crate::gpu::device().expect("an adapter for the panorama search")
    }

    /// A lattice of values, deterministic and with nothing periodic about it.
    fn hashed(ix: i64, iy: i64) -> f64 {
        let mut h = (ix.wrapping_mul(374_761_393) ^ iy.wrapping_mul(668_265_263)) as u64;
        h ^= h >> 13;
        h = h.wrapping_mul(1_274_126_177);
        h ^= h >> 16;
        (h & 0xffff) as f64 / 65535.0
    }

    /// Value noise at one scale, smooth across the lattice so a correlation peak has a curve to
    /// read rather than a kink.
    fn noise(x: f64, y: f64, cell: f64) -> f64 {
        let (u, v) = (x / cell, y / cell);
        let (ix, iy) = (u.floor(), v.floor());
        let ease = |t: f64| t * t * (3.0 - 2.0 * t);
        let (fx, fy) = (ease(u - ix), ease(v - iy));
        let (ix, iy) = (ix as i64, iy as i64);
        let across = |dy: i64| hashed(ix, iy + dy) * (1.0 - fx) + hashed(ix + 1, iy + dy) * fx;
        across(0) * (1.0 - fy) + across(1) * fy
    }

    /// A scene with structure at every scale and no period to it, so a translation matches at one
    /// place only. **Sines will not do here**: three of them beat against each other into a
    /// pattern that repeats, and the coarse search then has a hundred peaks as good as the true
    /// one - which is a fixture failing, not a search.
    ///
    /// `seed` moves it somewhere else entirely, for content a shifted copy has none of.
    fn scene(x: f64, y: f64, seed: f64) -> f32 {
        let (x, y) = (x + seed * 997.0, y + seed * 613.0);
        (0.15 + 0.45 * noise(x, y, 29.0) + 0.25 * noise(x, y, 11.0) + 0.12 * noise(x, y, 5.0))
            as f32
    }

    fn plane(width: usize, height: usize, dx: i32, dy: i32) -> Vec<f32> {
        (0..width * height)
            .map(|p| {
                let (x, y) = ((p % width) as i32, (p / width) as i32);
                let (sx, sy) = (x + dx, y + dy);
                // Outside what the other plane covers, a frame holds scene the other never saw.
                let fresh = sx < 0 || sy < 0 || sx >= width as i32 || sy >= height as i32;
                scene(f64::from(sx), f64::from(sy), if fresh { 3.7 } else { 0.0 })
            })
            .collect()
    }

    /// The coarse search finds an overlap the correspondence search could never reach: a third of
    /// a frame across, where that one looks four pixels.
    #[test]
    fn the_coarse_search_finds_a_third_of_a_frame_shift() {
        let gpu = searching();
        let (w, h) = (COARSE_LONG, 134usize);
        let (dx, dy) = (71, -12);
        let a = DevicePlane::from_luma(gpu, &plane(w, h, 0, 0), w, h);
        let b = DevicePlane::from_luma(gpu, &plane(w, h, dx, dy), w, h);

        let found = pollster::block_on(coarse(gpu, &a, &b, 0.2)).expect("the device searches");

        assert_eq!((found.dx, found.dy), (dx, dy), "found {found:?}");
        assert!(found.score > 0.6, "weak peak: {found:?}");
        // (202 - 71) x (134 - 12) of 202 x 134.
        assert!(
            (found.overlap - 0.590).abs() < 0.005,
            "overlap of {found:?}"
        );
    }

    /// Two planes of different shape, which is what a set mixing portrait frames with landscape
    /// ones reduces to: `previews` brings every plane to one *long* edge, so the two are the same
    /// number of pixels turned ninety degrees. Each has to be read with its own stride, and the
    /// translations searched are no longer symmetric about zero.
    #[test]
    fn the_coarse_search_reads_two_shapes() {
        let gpu = searching();
        let (aw, ah) = (COARSE_LONG, 134usize);
        let (bw, bh) = (134usize, COARSE_LONG);
        let (dx, dy) = (40, 20);
        let landscape: Vec<f32> = (0..aw * ah)
            .map(|p| scene((p % aw) as f64, (p / aw) as f64, 0.0))
            .collect();
        let portrait: Vec<f32> = (0..bw * bh)
            .map(|p| {
                let (x, y) = ((p % bw) as i32 + dx, (p / bw) as i32 + dy);
                let fresh = x < 0 || y < 0 || x >= aw as i32 || y >= ah as i32;
                scene(f64::from(x), f64::from(y), if fresh { 3.7 } else { 0.0 })
            })
            .collect();
        let a = DevicePlane::from_luma(gpu, &landscape, aw, ah);
        let b = DevicePlane::from_luma(gpu, &portrait, bw, bh);

        let found = pollster::block_on(coarse(gpu, &a, &b, 0.2)).expect("the device searches");

        assert_eq!((found.dx, found.dy), (dx, dy), "found {found:?}");
        assert!(found.score > 0.6, "weak peak: {found:?}");
    }

    /// An RGB source on the device, as the previews arrive: the same value in all three channels,
    /// which is what the pyramid's luma reduces back to.
    fn source(gpu: &'static crate::gpu::Gpu, grey: &[f32], width: usize, height: usize) -> Source {
        let bytes: Vec<u8> = grey
            .iter()
            .flat_map(|v| [*v; 3])
            .flat_map(f32::to_ne_bytes)
            .collect();
        Source {
            buffer: gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("pano test source"),
                contents: &bytes,
                usage: wgpu::BufferUsages::STORAGE,
            }),
            width,
            height,
        }
    }

    /// The scene as a camera turned by `(dx, dy)` and rolled by `roll` would have recorded it,
    /// resampled on the host - fixture construction, not a stage.
    fn turned(width: usize, height: usize, dx: f64, dy: f64, roll: f64) -> Vec<f32> {
        let (cx, cy) = (width as f64 / 2.0, height as f64 / 2.0);
        let (sin, cos) = roll.sin_cos();
        (0..width * height)
            .map(|p| {
                let (x, y) = ((p % width) as f64 - cx, (p / width) as f64 - cy);
                let sx = cx + (x * cos - y * sin) + dx;
                let sy = cy + (x * sin + y * cos) + dy;
                // Bilinear over a function that is defined everywhere, so nothing has an edge to
                // fall off: what lies outside one frame is scene the other simply did not see.
                scene(sx, sy, 0.0)
            })
            .collect()
    }

    /// The coarse answer is carried up the pyramid into correspondences at the preview's own
    /// size, which is where a recipe's rotations are solved from.
    ///
    /// A roll of a degree and a half, because a hand-held panorama is never level and a
    /// translation is the only thing the coarse search can say: the pyramid has to hold on to the
    /// content while the two frames stop being a translation apart.
    #[test]
    fn the_refine_reaches_the_full_preview() {
        let gpu = searching();
        let (w, h) = (808usize, 536usize);
        let (dx, dy, roll) = (0.3 * w as f64, -14.0, 1.5f64.to_radians());
        let a = Pyramid::of(gpu, &source(gpu, &turned(w, h, 0.0, 0.0, 0.0), w, h));
        let b = Pyramid::of(gpu, &source(gpu, &turned(w, h, dx, dy, roll), w, h));

        let from = pollster::block_on(coarse(gpu, a.coarse(), b.coarse(), 0.2))
            .expect("the device searches");
        let refine = pollster::block_on(refined(gpu, &a, &b, from));
        let (matches, sampled) = (refine.found, refine.sampled);

        assert!(matches.len() >= 2000, "{} matches", matches.len());
        // A true overlap corresponds nearly all the way across, which is the gap the align's
        // verification lives in: a coincidence of a repeating scene lands an order of magnitude
        // below this.
        let corresponding = matches.len() as f64 / (sampled as f64 * from.overlap);
        assert!(
            corresponding > 0.5,
            "only {corresponding:.3} of the overlap corresponds"
        );
        // Against the mapping the fixture was built from: b's pixel is a's turned by the same
        // rotation, so a correspondence that is right lands on it.
        let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
        let (sin, cos) = (-roll).sin_cos();
        let mut errors: Vec<f64> = matches
            .iter()
            .map(|m| {
                let (x, y) = (m.a[0] - cx - dx, m.a[1] - cy - dy);
                let want = [cx + x * cos - y * sin, cy + x * sin + y * cos];
                ((m.b[0] - want[0]).powi(2) + (m.b[1] - want[1]).powi(2)).sqrt()
            })
            .collect();
        errors.sort_by(f64::total_cmp);
        let at = |q: f64| errors[((errors.len() - 1) as f64 * q) as usize];
        // The middle of the field is what a solve is fitted to, and a tail of a pixel or two is
        // what the Huber loss there is for - so this asks about the body of it rather than about
        // the worst correspondence in six thousand.
        assert!(
            at(0.5) < 0.3 && at(0.95) < 1.0,
            "median {:.3}px, p95 {:.3}px over {} matches; coarse {from:?}",
            at(0.5),
            at(0.95),
            matches.len()
        );
    }

    /// The size the host reduces to and the size the shader is written for are one number.
    #[test]
    fn the_shader_says_the_coarse_size() {
        const SOURCE: &str = include_str!("../../../slang/composite_coarse.slang");
        let line = format!("static const int COARSE_LONG = {COARSE_LONG};");
        assert!(
            SOURCE.contains(&line),
            "composite_coarse.slang does not say `{line}`"
        );
    }
}
