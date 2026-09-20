//! What the analysis stages make of a burst, asked over the synthetic frames in `support`.

mod support;

use rawshim::assembly_analysis::{Refused, analysis_of, corridor_share, intersection_crop};
use rawshim::assembly_levels::seam_field;
use rawshim::assembly_planes::Plane;
use rawshim::assembly_seam::{NEIGHBOURS, SHRINK, SeamField, along_an_edge};
use rawshim::assembly_tiles::{
    Cell, MIN_LOBE_AREA, Subdivision, crosses, enclosing, lobes, simplify, subdivide,
    tolerance_for, trace,
};
use rawshim::composition::{self, Composition, LensSpec};
use rawshim::resident::Resident;
use support::{
    Patch, Rig, at, centre, code_of_light, codes_of, floats_of, ground, noise, rig, sigma_at,
    synthetic, synthetic_gained, u32s_of, upload_f32, upload_u32,
};

const SIZE: (usize, usize) = (64, 64);

/// A distance on the shrunk mask, for the tests below that state one as a plain number.
fn deep(at: f64) -> rawshim::px::Extent<rawshim::px::Shrunk> {
    rawshim::px::Extent::exactly(at)
}

/// The ground a frame is built on is the ground `support::ground` describes, once it has crossed
/// to the device and back.
#[test]
fn the_fixtures_are_the_ground_they_claim() {
    let Some(rig) = rig() else { return };
    let planes = synthetic(&rig, &[Patch::None, Patch::Bright], SIZE);
    let plain = codes_of(&rig, &planes[0]);
    let bright = codes_of(&rig, &planes[1]);

    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            let light = ground(x, y);
            let spread = sigma_at(light);
            let (low, high) = (code_of_light(light - spread), code_of_light(light + spread));
            let read = plain[at(SIZE, x, y) * 3];
            assert!(
                (low..=high).contains(&read),
                "({x}, {y}) coded {read}, which is not {low}..={high} of a ground of {light}",
            );
        }
    }

    let centre = centre(SIZE) * 3;
    assert!(
        bright[centre] > plain[centre] + 10_000,
        "the patch is bright: {} against {}",
        bright[centre],
        plain[centre],
    );

    assert_eq!(
        floats_of(&rig, &upload_f32(&rig, &[1.5, 2.5]), 2),
        vec![1.5, 2.5]
    );
    assert_eq!(u32s_of(&rig, &upload_u32(&rig, &[7, 9]), 2), vec![7, 9]);
}

/// Planes whose light *is* the signal `support::noise` describes, and one frame per pixel: the two
/// normalisations coincide, so these fixtures say nothing about the anchoring.
fn planes_of(frames: Vec<Resident>) -> Vec<Plane> {
    let order: Vec<usize> = (0..frames.len()).collect();
    planes_at(frames, &order)
}

/// The same with each plane's place in the recipe named, which `analysis_planes` fills with the
/// reference first and so is not the position the frame arrives at.
fn planes_at(frames: Vec<Resident>, sources: &[usize]) -> Vec<Plane> {
    frames
        .into_iter()
        .zip(sources)
        .map(|(rgb, &source)| Plane {
            source,
            rgb,
            noise: noise(),
            full_scale_light: 1.0,
            wb_gains: [1.0; 3],
            independent_samples: 1.0,
        })
        .collect()
}

fn seams_over(rig: &Rig, planes: &[Plane], size: (usize, usize)) -> SeamField {
    let never = || Ok::<(), ()>(());
    pollster::block_on(seam_field(rig.gpu, rig.base, planes, size, never)).expect("a field")
}

fn field(rig: &Rig, frames: Vec<Resident>, size: (usize, usize)) -> SeamField {
    seams_over(rig, &planes_of(frames), size)
}

#[test]
fn a_noiseless_set_does_not_divide_by_zero() {
    let Some(rig) = rig() else { return };
    let size = (64, 64);
    let mut planes = planes_of(synthetic(&rig, &[Patch::None; 3], size));
    for plane in &mut planes {
        plane.noise = rawshim::galosh::NoiseModel {
            alpha: 0.0,
            sigma_sq: 0.0,
        };
    }
    let seams = seams_over(&rig, &planes, size);
    assert!(seams.tint.iter().chain(&seams.level).all(|v| v.is_finite()));
}

#[test]
fn a_cell_clipped_in_any_frame_has_no_consensus() {
    let Some(rig) = rig() else { return };
    let size = (64, 64);
    let frames = synthetic_gained(
        &rig,
        &[Patch::Bright, Patch::None, Patch::None],
        &[4.0, 1.0, 1.0],
        size,
    );
    let seams = field(&rig, frames, size);
    let shrunk = (size.0 / SHRINK, size.1 / SHRINK);
    assert!(seams.consensus(centre(shrunk)).is_none());
    assert!(seams.consensus(0).is_some());
}

/// A patch as bright as the grey around it and another colour: the seam field's tint is what reads it.
#[test]
fn the_tint_tells_a_colour_from_a_grey_of_the_same_light() {
    let Some(rig) = rig() else { return };
    let size = (64, 64);
    let grey = [0.25f32; 3];
    let warm = [0.5, (0.25 - 0.2627 * 0.5 - 0.0593 * 0.1) / 0.678, 0.1];
    let frame = |patch: [f32; 3]| {
        let mut samples = vec![0u16; size.0 * size.1 * 3];
        for y in 0..size.1 {
            for x in 0..size.0 {
                let inside = (24..40).contains(&x) && (24..40).contains(&y);
                let rgb = if inside { patch } else { grey };
                for (c, light) in rgb.into_iter().enumerate() {
                    samples[at(size, x, y) * 3 + c] = code_of_light(light);
                }
            }
        }
        Resident::upload(rig.gpu, &samples, size.0, size.1)
    };
    let seams = field(&rig, vec![frame(grey), frame(warm)], size);
    let cell = (32 / SHRINK) * (size.0 / SHRINK) + 32 / SHRINK;
    let [[gu, gv], [wu, wv]] = [0, 1].map(|frame| seams.tint(cell, frame).map(|s| s.raw() as f32));

    assert!(gu.abs() < 0.05 && gv.abs() < 0.05, "grey reads {gu}, {gv}");
    let (u, v) = ((warm[0] / warm[1]).log2(), (warm[2] / warm[1]).log2());
    assert!((wu - u).abs() < 0.1, "red over green reads {wu}, not {u}");
    assert!((wv - v).abs() < 0.1, "blue over green reads {wv}, not {v}");
}

/// Where the picture steps, a seam along the step is hidden by it, and costs less than the same
/// seam over flat ground.
#[test]
fn a_seam_along_an_edge_in_the_picture_is_cheaper_than_one_across_flat_ground() {
    let field = SeamField {
        level: vec![0.0, 0.0, 2.0],
        tint: Vec::new(),
        sources: 0,
    };
    let flat_step = along_an_edge(&field, 0, 1);
    let edge_step = along_an_edge(&field, 1, 2);
    assert_eq!(flat_step, 1.0);
    assert!(edge_step < 0.2, "a two-stop edge still charges {edge_step}");
}

/// The sixteen arcs' weights are `delta_phi_k / (2 |e_k|)`, derived here from the directions
/// themselves rather than copied from the table they hold.
///
/// **This is the weighting whose cut cost is Euclidean length** (Cauchy-Crofton). Multiply by the
/// length instead of dividing and the metric is anisotropic: a straight cut costs 3.32 per unit
/// length along an axis against 3.13 at 45 degrees, so the diagonal is 6% the cheaper. At four
/// neighbours the same mistake is 0.232 against 0.328, which is the staircase the neighbourhood
/// was widened to remove.
#[test]
fn the_weights_are_the_angular_gap_over_the_edge_length() {
    let angle_of = |dx: isize, dy: isize| (dy as f64).atan2(dx as f64);
    let mut every: Vec<f64> = NEIGHBOURS
        .iter()
        .flat_map(|&(dx, dy, _)| [angle_of(dx, dy), angle_of(-dx, -dy)])
        .collect();
    every.sort_by(f64::total_cmp);
    let wrapped = |a: f64| a.rem_euclid(std::f64::consts::TAU);

    for &(dx, dy, weight) in &NEIGHBOURS {
        let angle = angle_of(dx, dy);
        let at = every
            .iter()
            .position(|a| (a - angle).abs() < 1e-9)
            .expect("its own direction");
        let gap = 0.5
            * (wrapped(every[(at + 1) % every.len()] - angle)
                + wrapped(angle - every[(at + every.len() - 1) % every.len()]));
        let length = ((dx * dx + dy * dy) as f64).sqrt();
        let want = gap / (2.0 * length);
        assert!(
            (f64::from(weight) - want).abs() < 5e-4,
            "({dx}, {dy}) weighs {weight}, where delta_phi / 2|e| is {want}",
        );
    }
}

/// The bright frame is brighter than the others in the patch and level with them on the ground, and
/// the consensus follows the two that agree.
#[test]
fn the_level_is_each_frame_s_light_and_the_consensus_the_majority_s() {
    let Some(rig) = rig() else { return };
    let size = (128, 128);
    let frames = synthetic(&rig, &[Patch::None, Patch::Bright, Patch::None], size);
    let seams = field(&rig, frames, size);

    let shrunk = (size.0 / SHRINK, size.1 / SHRINK);
    assert_eq!(seams.level.len(), shrunk.0 * shrunk.1 * 4);
    let (patch, ground) = (centre(shrunk), 3);
    let at = |cell: usize, frame: usize| seams.frame(cell, frame).expect("reached").raw();
    assert!(at(patch, 1) > at(patch, 0) + 0.5);
    assert!((at(ground, 1) - at(ground, 0)).abs() < 0.05);
    let consensus = seams.consensus(patch).expect("covered").raw();
    assert!((consensus - at(patch, 0)).abs() < 0.05);
}

/// One photograph's field is that photograph: a consensus nothing had to agree on, and a level and
/// a tint that are the frame's own.
///
/// **What a repair inside a single image is solved over.** Nothing in the field is a comparison
/// between frames - the median of one reading is that reading - so a seam cut in one photograph
/// needs no arithmetic that is not already here, and the stack that builds it needs no second
/// frame to be well defined.
#[test]
fn a_field_of_one_photograph_is_that_photograph() {
    let Some(rig) = rig() else { return };
    let size = (128, 128);
    let seams = field(&rig, synthetic(&rig, &[Patch::Bright], size), size);

    let shrunk = (size.0 / SHRINK, size.1 / SHRINK);
    assert_eq!(seams.sources, 1);
    assert_eq!(seams.level.len(), shrunk.0 * shrunk.1 * 2);
    assert!(seams.tint.iter().chain(&seams.level).all(|v| v.is_finite()));
    for cell in [centre(shrunk), 3] {
        let (consensus, own) = (seams.consensus(cell), seams.frame(cell, 0));
        assert_eq!(
            consensus.map(|c| c.raw()),
            own.map(|o| o.raw()),
            "at {cell}"
        );
    }
    // And the patch is still a patch, so the field is a picture rather than a flat answer.
    let level = |cell: usize| seams.frame(cell, 0).expect("reached").raw();
    assert!(level(centre(shrunk)) > level(3) + 0.5);
}

fn disc(size: (usize, usize), radius: f32) -> Vec<bool> {
    (0..size.0 * size.1)
        .map(|p| {
            let (x, y) = (
                (p % size.0) as f32 - size.0 as f32 / 2.0,
                (p / size.0) as f32 - size.1 as f32 / 2.0,
            );
            (x * x + y * y).sqrt() < radius
        })
        .collect()
}

/// `l`, `t`, `r`, `b` inclusive, so two rectangles one apart are 4-adjacent.
fn rect(size: (usize, usize), l: usize, t: usize, r: usize, b: usize) -> Vec<bool> {
    let mut mask = vec![false; size.0 * size.1];
    for y in t..=b {
        for x in l..=r {
            mask[y * size.0 + x] = true;
        }
    }
    mask
}

fn quiet_cell(label: u32, inside: Vec<bool>, corridor: f64) -> Cell {
    Cell {
        label,
        inside,
        corridor: deep(corridor),
    }
}

fn tile_loop(s: &Subdivision, tile: usize) -> Vec<[f32; 2]> {
    s.tiles[tile]
        .iter()
        .map(|&v| s.vertices[v as usize])
        .collect()
}

/// Even-odd ray cast. Every vertex sits on a half-integer, so a pixel centre is never on an edge.
fn inside_polygon(poly: &[[f32; 2]], p: [f32; 2]) -> bool {
    let mut within = false;
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
        if (a[1] > p[1]) != (b[1] > p[1])
            && p[0] < a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0])
        {
            within = !within;
        }
    }
    within
}

#[test]
fn a_traced_loop_simplifies_without_crossing_itself() {
    let traced = trace(&disc((64, 64), 24.0), (64, 64));
    assert!(
        traced.len() > 100,
        "a disc of radius 24 has a long contour: {}",
        traced.len()
    );
    let loop_ = simplify(&traced, 1.0);
    assert!(is_simple(&loop_));
    assert!(
        loop_.len() >= 8 && loop_.len() < traced.len() / 4,
        "{}",
        loop_.len()
    );
}

/// A closed loop has no endpoint to hold, so its two anchors are its farthest pair.
///
/// Held at wherever the trace happened to start instead, the start and the point before it both
/// survive as vertices in the middle of a straight run - a pair of them a tile, against
/// `MOST_VERTICES`, for nothing.
#[test]
fn a_closed_loop_simplifies_to_its_corners_wherever_the_trace_began() {
    let side = 16;
    let mut square: Vec<[f32; 2]> = Vec::new();
    square.extend((0..side).map(|i| [i as f32, 0.0]));
    square.extend((0..side).map(|i| [side as f32, i as f32]));
    square.extend((0..side).map(|i| [(side - i) as f32, side as f32]));
    square.extend((0..side).map(|i| [0.0, (side - i) as f32]));
    square.rotate_left(8); // halfway along an edge, where a trace is as likely to begin as anywhere

    let corners = simplify(&square, 0.5);
    assert_eq!(corners.len(), 4, "a square is four vertices: {corners:?}");
}

fn is_simple(loop_: &[[f32; 2]]) -> bool {
    let edges: Vec<([f32; 2], [f32; 2])> = (0..loop_.len())
        .map(|i| (loop_[i], loop_[(i + 1) % loop_.len()]))
        .collect();
    !any_cross(&edges)
}

fn any_cross(edges: &[([f32; 2], [f32; 2])]) -> bool {
    edges
        .iter()
        .enumerate()
        .any(|(i, &(a, b))| edges[i + 1..].iter().any(|&(c, d)| crosses(a, b, c, d)))
}

/// The two sides of a one-pixel finger are two arcs, simplified apart, and at a corridor's
/// tolerance they straighten through each other. Found by search, as the smallest partition that
/// tangled; nothing about it is special beyond its fingers.
#[test]
fn no_two_edges_of_a_subdivision_cross_even_where_a_finger_is_thinner_than_the_tolerance() {
    let art = [
        "44444444", //
        "44114444", //
        "4111....", //
        "111....1", //
        ".444..11", //
        ".444..11", //
        ".4444144", //
        ".4444444", //
    ];
    let size = (8, 8);
    let owner: Vec<u8> = art.iter().flat_map(|row| row.bytes()).collect();
    let cells: Vec<Cell> = [b'1', b'4']
        .into_iter()
        .map(|k| {
            quiet_cell(
                u32::from(k - b'0'),
                owner.iter().map(|&o| o == k).collect(),
                16.0,
            )
        })
        .collect();
    let cells = lobes(&cells, size);
    let s = subdivide(&cells, size, 4.0);

    assert!(!any_cross(&subdivision_edges(&s)), "{:?}", s);
    let traced: usize = cells.iter().map(|c| trace(&c.inside, size).len()).sum();
    assert!(
        s.vertices.len() < traced,
        "and it is still simplified: {} of {traced}",
        s.vertices.len()
    );
}

/// Hundreds of small, ragged cells, whose crossings take several rounds to straighten out - the
/// rounds after the first test only what moved, and this is what says that was enough.
#[test]
fn a_ragged_partition_subdivides_with_no_two_edges_crossing() {
    let size = (200, 130);
    let mut seed: u64 = 7;
    let mut owner: Vec<u32> = (0..size.0 * size.1)
        .map(|_| {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) as u32 % 4
        })
        .collect();
    for _ in 0..3 {
        let before = owner.clone();
        for y in 1..size.1 - 1 {
            for x in 1..size.0 - 1 {
                let mut count = [0u32; 4];
                for (dx, dy) in (0..9).map(|n| (n % 3, n / 3)) {
                    count[before[(y + dy - 1) * size.0 + x + dx - 1] as usize] += 1;
                }
                owner[y * size.0 + x] = (0..4).max_by_key(|&k| count[k]).unwrap() as u32;
            }
        }
    }
    let cells: Vec<Cell> = (1..4)
        .map(|k| quiet_cell(k, owner.iter().map(|&o| o == k).collect(), 30.0))
        .collect();
    let cells = lobes(&cells, size);
    assert!(cells.len() > 500, "a busy partition: {}", cells.len());

    let s = subdivide(&cells, size, 4.0);
    assert!(!any_cross(&subdivision_edges(&s)));
}

fn subdivision_edges(s: &Subdivision) -> Vec<([f32; 2], [f32; 2])> {
    (0..s.tiles.len())
        .flat_map(|t| {
            let loop_ = tile_loop(s, t);
            (0..loop_.len())
                .map(|i| (loop_[i], loop_[(i + 1) % loop_.len()]))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// And `is_simple` is an answer rather than a formality: a bowtie is not simple.
#[test]
fn a_crossing_loop_is_not_simple() {
    let bowtie = [[0.0, 0.0], [10.0, 10.0], [10.0, 0.0], [0.0, 10.0]];
    assert!(!is_simple(&bowtie));
    let square = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
    assert!(is_simple(&square));
}

/// The tolerance is a quarter of the corridor, *and* `tolerance + W_low <= corridor`, which is a
/// second bound rather than a restatement: a feather wider than three quarters of the corridor is
/// the case where a quarter is already too much, and there the feather is what decides.
#[test]
fn a_narrow_corridor_gets_a_tighter_tolerance_and_leaves_room_for_the_feather() {
    let at = |corridor: f64, w_low: f64| tolerance_for(deep(corridor), deep(w_low)).raw();
    assert!(at(4.0, 1.0) < at(40.0, 1.0));
    assert!(at(4.0, 1.0) + 1.0 <= 4.0 + 1e-6);
    assert!(at(40.0, 8.0) + 8.0 <= 40.0 + 1e-6);
    // §5.2's own `W_low` is half the corridor, which leaves the quarter §3.7 asks for untouched.
    assert_eq!(at(8.0, 4.0), 2.0);
    // A quarter of this corridor is 1.0, and 1.0 + 3.5 reaches past the end of it.
    let binding = at(4.0, 3.5);
    assert!(
        binding + 3.5 <= 4.0 + 1e-6,
        "the feather reaches ground the cut avoided: {binding}"
    );
    assert!(
        binding > 0.25,
        "and it is the constraint that bound it, not the floor"
    );
    // Under which nothing is simplified at all, so the floor is what a corridor narrower than its
    // own feather gets rather than a tolerance that keeps every traced point.
    assert_eq!(at(1.0, 0.9), 0.25);
}

/// And at the width a real mask has, the tolerance is a real one rather than the floor: a shrunk
/// mask 750 across caps `W_low` at 7.5, which a corridor of 8 does not reach, so it is half the
/// corridor and the quarter §3.7 asks for survives it.
///
/// Measured here rather than on `tolerance_for` because the collision is between `subdivide`'s own
/// `W_low` and the tolerance it hands the same cell: at the floor of 0.25 a marching-squares
/// staircase of half-pixel steps keeps every one of its vertices, which is what `MOST_VERTICES`
/// exists to stop and what no re-merge can recover.
#[test]
fn a_mask_the_size_of_a_real_one_simplifies_to_its_shape_not_its_staircase() {
    let size = (750, 500);
    let tooth = |y: usize| [0usize, 1, 2, 1][y % 4];
    let toothed: Vec<bool> = (0..size.0 * size.1)
        .map(|p| (100..=300 + tooth(p / size.0)).contains(&(p % size.0)))
        .collect();
    let traced = trace(&toothed, size);
    assert!(
        traced.len() > 1000,
        "a 500-row contour is long: {}",
        traced.len()
    );

    let s = subdivide(&[quiet_cell(1, toothed, 8.0)], size, 4.0);
    assert!(
        s.tiles[0].len() <= 40,
        "a rectangle, not a tooth a row: {} vertices of {}",
        s.tiles[0].len(),
        traced.len(),
    );
}

/// The solve is 16-connected and pays about half as much for a diagonal arc as an axis one (§3.5),
/// so a region that pinches at a diagonal is a shape it returns. `trace` walks one loop, so the lobe
/// it did not walk would become base with nothing said.
#[test]
fn a_cell_pinched_at_a_diagonal_is_two_tiles() {
    let size = (64, 64);
    let mut pinched = rect(size, 8, 8, 27, 27);
    for (p, held) in rect(size, 28, 28, 47, 47).into_iter().enumerate() {
        pinched[p] |= held;
    }
    let out = lobes(&[quiet_cell(1, pinched, 8.0)], size);

    assert_eq!(out.len(), 2, "the two lobes are two tiles");
    assert!(
        out.iter().all(|c| c.label == 1),
        "both keep the region's frame"
    );
    let above = out
        .iter()
        .position(|c| c.inside[10 * size.0 + 10])
        .expect("the first lobe");
    let below = out
        .iter()
        .position(|c| c.inside[40 * size.0 + 40])
        .expect("the second lobe");
    assert_ne!(above, below, "one cell still holds both");
    let s = subdivide(&out, size, 1.0);
    assert!(
        s.tiles.iter().all(|t| t.len() >= 4),
        "each lobe has a loop of its own: {:?}",
        s.tiles
    );
}

/// A shrunk cell is a `scale`-sided block of canvas, so a tile's vertices are its cells' centres and
/// not their corners: half a block out, a tile flush with the mask stops half a block short of the
/// canvas the mask covers, and every seam sits that far up and left of the corridor it was measured
/// in.
#[test]
fn a_tile_flush_with_the_mask_covers_the_canvas_the_mask_does() {
    let size = (16, 16);
    let s = subdivide(&[quiet_cell(1, rect(size, 0, 0, 15, 15), 8.0)], size, 4.0);
    let axis = |i: usize| {
        let of = |f: fn(f32, f32) -> f32, start| s.vertices.iter().map(|v| v[i]).fold(start, f);
        (of(f32::min, f32::INFINITY), of(f32::max, f32::NEG_INFINITY))
    };
    // A canvas pixel centre is an integer, so the outer edge of the first is -0.5 and of the last
    // `16 * 4 - 0.5`.
    assert_eq!(axis(0), (-0.5, 63.5), "x: {:?}", s.vertices);
    assert_eq!(axis(1), (-0.5, 63.5), "y: {:?}", s.vertices);
}

/// Two tiles that meet share the vertices along the boundary they meet on, which is the one
/// arrangement that can neither gap nor overlap (§3.7).
#[test]
fn a_shared_boundary_is_one_run_of_vertices() {
    let size = (64, 64);
    let a = quiet_cell(1, rect(size, 10, 10, 32, 40), 8.0);
    let b = quiet_cell(2, rect(size, 32, 10, 54, 40), 8.0);
    let s = subdivide(&[a, b], size, 4.0);
    let shared: Vec<u32> = s.tiles[0]
        .iter()
        .filter(|v| s.tiles[1].contains(v))
        .copied()
        .collect();
    assert!(
        shared.len() >= 2,
        "the two tiles share the vertices along x = 32: {shared:?}"
    );
    for tile in 0..s.tiles.len() {
        assert!(
            is_simple(&tile_loop(&s, tile)),
            "tile {tile} crosses itself"
        );
    }
}

/// And what sharing buys, measured where independent simplification could not give it: every pixel
/// the two cells covered is inside exactly one of the two polygons.
///
/// The boundary between them is a triangular wave of amplitude 1.5 shrunk pixels, and the two cells
/// declare corridors an octave apart - 2.0 smooths the wave flat, 0.36 keeps every tooth of it. Two
/// loops simplified independently therefore disagree along the boundary they share, and the ground
/// between a chord and a tooth goes to both tiles or to neither.
///
/// The two masks are also given **overlapping** on the boundary column, because the subdivision is
/// what decides where a tile ends: traced from the masks as handed over rather than from the
/// partition they resolve to, the two contours sit a pixel apart and every pixel between them is in
/// both tiles.
#[test]
fn neighbouring_tiles_neither_gap_nor_overlap() {
    let size = (64, 64);
    let tooth = |y: usize| [0usize, 1, 2, 3, 2, 1][y % 6];
    let (mut left, mut right) = (vec![false; size.0 * size.1], vec![false; size.0 * size.1]);
    for y in 8..=40 {
        for x in 6..=56 {
            let at = y * size.0 + x;
            if x <= 20 + tooth(y) {
                left[at] = true
            }
            if x >= 20 + tooth(y) {
                right[at] = true
            }
        }
    }
    let s = subdivide(
        &[quiet_cell(1, left, 8.0), quiet_cell(2, right, 2.0)],
        size,
        1.0,
    );
    let (a, b) = (tile_loop(&s, 0), tile_loop(&s, 1));

    // Inset by two from the union's outer edge, which is the only boundary either polygon is free
    // to move: what is under test is the boundary they share.
    let mut both = 0;
    let mut neither = 0;
    for y in 10..=38 {
        for x in 8..=54 {
            let p = [x as f32, y as f32];
            match (inside_polygon(&a, p), inside_polygon(&b, p)) {
                (true, true) => both += 1,
                (false, false) => neither += 1,
                _ => {}
            }
        }
    }
    assert_eq!(
        (both, neither),
        (0, 0),
        "{both} pixels in both tiles, {neither} in neither"
    );
}

/// §3.8's crop is the ground **every** frame reached, which is not the union
/// `Composition::crop` already holds: a burst's second frame points a little elsewhere, and the
/// wedge only one of them covers has no second frame for a tile to be picked from.
#[test]
fn the_crop_is_the_ground_every_frame_reached() {
    const SIDE: [usize; 2] = [1000, 800];
    // `of_one` states its focal and its radians per pixel as each other's inverse, so an angle of
    // `n / focal` is a shift of n canvas pixels.
    let (right, down) = (40.0, 30.0);
    let mut spec = Composition::of_one(SIDE, LensSpec::none());
    let mut turned = spec.sources[0].clone();
    turned.rotation = composition::from_axis_angle([
        down / composition::FOCAL_OF_ONE,
        right / composition::FOCAL_OF_ONE,
        0.0,
    ]);
    spec.sources.push(turned);

    let crop = intersection_crop(&spec);
    let (wide, tall) = (
        (crop[2] - crop[0]) * SIDE[0] as f64,
        (crop[3] - crop[1]) * SIDE[1] as f64,
    );
    assert!(
        (wide - (SIDE[0] as f64 - right)).abs() < 12.0,
        "a {right}px turn leaves {wide:.0} of {} across, crop {crop:?}",
        SIDE[0],
    );
    assert!(
        (tall - (SIDE[1] as f64 - down)).abs() < 12.0,
        "a {down}px turn leaves {tall:.0} of {} down, crop {crop:?}",
        SIDE[1],
    );
    // And it is the *intersection*: every corner of it is inside both frames, which the union's own
    // crop of the whole canvas is not.
    for x in [crop[0], crop[2]] {
        for y in [crop[1], crop[3]] {
            let ray = composition::canvas_to_ray(&spec, x * SIDE[0] as f64, y * SIDE[1] as f64);
            for (at, source) in spec.sources.iter().enumerate() {
                let [sx, sy] = composition::ray_to_source(source, ray).expect("in front");
                assert!(
                    sx >= -1.0
                        && sy >= -1.0
                        && sx <= SIDE[0] as f64 + 1.0
                        && sy <= SIDE[1] as f64 + 1.0,
                    "({x}, {y}) lands at ({sx:.0}, {sy:.0}) of source {at}",
                );
            }
        }
    }
}

/// Every source of the recipe on the canvas, so the whole run of tests above is an answer about
/// the frames it was handed.
fn spec_of(sources: usize, size: (usize, usize)) -> Composition {
    let mut spec = Composition::of_one([size.0, size.1], LensSpec::none());
    let one = spec.sources[0].clone();
    spec.sources.extend(std::iter::repeat_n(one, sources - 1));
    spec
}

const ANALYSED: (usize, usize) = (128, 128);

/// §3.3 onward in one call, over three frames one of which has a bright patch: no tiles, the base
/// the recipe's reference, and a seam field in which the patch is the odd frame's light alone.
#[test]
fn an_analysis_hands_back_no_tiles_and_the_field_they_are_seeded_on() {
    let Some(rig) = rig() else { return };
    let planes = planes_of(synthetic(
        &rig,
        &[Patch::None, Patch::Bright, Patch::None],
        ANALYSED,
    ));
    let a = pollster::block_on(analysis_of(
        rig.gpu,
        rig.base,
        spec_of(3, ANALYSED),
        &planes,
    ))
    .expect("an assembly");

    assert!(a.assembly.tiles.is_empty(), "{:?}", a.assembly.tiles);
    assert!(a.assembly.pick.is_empty());
    assert_eq!(a.assembly.base, 0, "the recipe's reference");
    assert!(a.warnings.is_empty(), "{:?}", a.warnings);

    let v = &a.volume;
    let shrunk = (ANALYSED.0 / SHRINK, ANALYSED.1 / SHRINK);
    assert_eq!((v.plane, v.shrunk), (ANALYSED, shrunk));
    let light = |frame: usize| v.field.frame(centre(shrunk), frame).expect("reached").raw();
    assert!(light(1) > light(0) + 0.5 && light(1) > light(2) + 0.5);
}

/// A plane's position is the recipe's *rendering* order, reference first, but the seam field names
/// frames by their own index. The two orders differ for every burst whose reference is not its
/// first source, which is most of them.
#[test]
fn the_field_names_frames_by_their_own_index_and_not_by_the_planes_order() {
    let Some(rig) = rig() else { return };
    let frames = synthetic(&rig, &[Patch::None, Patch::Bright, Patch::None], ANALYSED);
    // As `analysis_planes` returns them for a recipe whose reference is source 2.
    let planes = planes_at(frames, &[2, 0, 1]);
    let mut spec = spec_of(3, ANALYSED);
    spec.reference = 2;
    let a = pollster::block_on(analysis_of(rig.gpu, rig.base, spec, &planes)).expect("an assembly");

    assert_eq!(a.assembly.base, 2);
    // The patch arrived second, which is source 0.
    let shrunk = (ANALYSED.0 / SHRINK, ANALYSED.1 / SHRINK);
    let light = |frame: usize| {
        a.volume
            .field
            .frame(centre(shrunk), frame)
            .expect("reached")
            .raw()
    };
    assert!(
        light(0) > light(1) + 0.5 && light(0) > light(2) + 0.5,
        "the field was left in the planes' order"
    );
}

/// More frames than §3.3's median stacks, and a source the canvas never reached, are refusals
/// rather than a panic inside the shader's own bound.
#[test]
fn a_set_too_large_to_stack_is_refused_by_name() {
    let Some(rig) = rig() else { return };
    let size = (64, 64);
    let many = planes_of(synthetic(&rig, &[Patch::None; 13], size));
    let refused = pollster::block_on(analysis_of(rig.gpu, rig.base, spec_of(13, size), &many));
    assert_eq!(refused.err(), Some(Refused::TooManyFrames(13)));

    let three = planes_of(synthetic(&rig, &[Patch::None; 3], size));
    let refused = pollster::block_on(analysis_of(rig.gpu, rig.base, spec_of(4, size), &three));
    assert_eq!(refused.err(), Some(Refused::Unreached(vec![3])));
}

/// §3.6's floor. A speck of a shattered region, on open ground, is dropped and its ground stays base.
#[test]
fn a_lobe_under_the_floor_is_dropped_rather_than_kept() {
    let size = (400, 400);
    let floor = (size.0 * size.1) as f32 * MIN_LOBE_AREA;
    assert!(
        floor > 1.0 && floor < 40.0,
        "the fixture's canvas puts the floor at {floor} cells"
    );

    let mut inside = vec![false; size.0 * size.1];
    // A proper cell, 8x8, and a speck of one cell far away from it - the shape a shattered region
    // returns.
    for y in 100..108 {
        for x in 100..108 {
            inside[y * size.0 + x] = true;
        }
    }
    inside[300 * size.0 + 300] = true;
    let cells = vec![Cell {
        label: 0b101,
        inside,
        corridor: deep(4.0),
    }];

    let out = lobes(&cells, size);
    assert_eq!(out.len(), 1, "the speck went and the cell stayed");
    assert!(
        !out[0].inside[300 * size.0 + 300],
        "and the speck's ground is base"
    );
    assert_eq!(
        out[0].inside.iter().filter(|h| **h).count(),
        64,
        "the cell is untouched"
    );
}

/// The area floor is not the whole of it: a cell well over it straightens into a loop that encloses
/// nothing.
///
/// A one-cell-wide bar with a corridor far wider than the bar is long: the tolerance is then a
/// quarter of that corridor, and Douglas-Peucker takes both sides of the bar down to the same two
/// ends.
#[test]
fn a_cell_whose_loop_straightens_to_a_line_is_not_a_tile() {
    let size = (64, 64);
    let mut inside = vec![false; size.0 * size.1];
    for x in 10..50 {
        inside[32 * size.0 + x] = true;
    }
    let cells = vec![Cell {
        label: 0b101,
        inside,
        corridor: deep(60.0),
    }];
    let sub = subdivide(&cells, size, 1.0);
    assert!(
        sub.tiles[0].len() < 3,
        "the bar simplified to {:?}",
        sub.tiles[0]
    );
    assert!(
        enclosing(&sub).is_empty(),
        "a loop of two vertices is not a tile"
    );
}

/// And what encloses something is kept, in the order it was given.
#[test]
fn a_cell_that_still_encloses_something_is_kept() {
    let size = (64, 64);
    let mut inside = vec![false; size.0 * size.1];
    for y in 20..44 {
        for x in 20..44 {
            inside[y * size.0 + x] = true;
        }
    }
    let cells = vec![Cell {
        label: 0b101,
        inside,
        corridor: deep(4.0),
    }];
    let sub = subdivide(&cells, size, 1.0);
    assert_eq!(enclosing(&sub), vec![0]);
}

/// The floor runs after the split, which is what makes a lobe of a shattered region reachable by it
/// at all.
#[test]
fn the_floor_runs_on_lobes_rather_than_on_the_region_that_shattered() {
    let size = (400, 400);
    let mut inside = vec![false; size.0 * size.1];
    for y in 100..108 {
        for x in 100..108 {
            inside[y * size.0 + x] = true;
        }
    }
    // One lobe of the same region, one cell, diagonal-adjacent to the block: 4-connectivity splits
    // it off, so it is a lobe under the floor - where the whole region is 65 cells and over it.
    inside[108 * size.0 + 108] = true;
    let out = lobes(
        &[Cell {
            label: 0b101,
            inside,
            corridor: deep(4.0),
        }],
        size,
    );
    assert_eq!(
        out.len(),
        1,
        "the diagonal lobe is under the floor and goes"
    );
    assert!(!out[0].inside[108 * size.0 + 108]);
}

/// §5.2's cap, stated as the length it is. A 20-cell square is 10 cells deep, so the widest feather
/// it can carry and still reach full weight in the middle is 10 - which is a corridor of 20,
/// whatever the cut measured.
#[test]
fn the_corridor_is_capped_at_twice_the_tile_s_own_inradius() {
    let size = (64, 64);
    let mut inside = vec![false; size.0 * size.1];
    for y in 22..42 {
        for x in 22..42 {
            inside[y * size.0 + x] = true;
        }
    }
    let capped = corridor_share(&inside, size, deep(100.0)).raw();
    assert!(
        (capped - 20.0 / 64.0).abs() < 1e-4,
        "a cut with all the room there is still only gets twice the inradius: {capped}",
    );
    let bound = corridor_share(&inside, size, deep(4.0)).raw();
    assert!(
        (bound - 4.0 / 64.0).abs() < 1e-4,
        "and under the cap the corridor itself: {bound}"
    );
}
