//! The whole of §3: a set of photographs in, an [`Assembly`] with no tiles and the seam field a
//! reader's tiles are later solved over.
//!
//! The align, the planes and the seam field run here in order, and the refusals are where a set
//! that cannot be assembled is named rather than silently half-answered. Tiles are the reader's:
//! each is seeded where they click and grown by `assembly_seams`.

use crate::assembly::Assembly;
use crate::assembly_levels::{MOST_SOURCES, seam_field};
use crate::assembly_planes::Plane;
use crate::assembly_seam::shrunk_size;
use crate::base::Base;
use crate::composite_align::AlignSource;
use crate::composition::Composition;
use crate::gpu::Gpu;
use crate::px::{Analysis, Extent, Share, Shrunk, Span};

/// The most pieces a seam solve may answer, and the most vertices across them.
pub const MOST_TILES: usize = 256;
pub const MOST_VERTICES: usize = 8192;

/// §3.1's bound on how much worse than the field's own middle a burst's corners may register -
/// `composite_align::Aligned::radial` carried onto the analysis plane, being a difference and so
/// carrying no texture floor of its own.
///
/// A registration budget of 2.25 analysis pixels, less the median 1.10 a real hand-held burst's
/// whole field already spends (§3.10): 1.15 is what the corners may add. Past it the frames are not
/// near-identity, and the page says so.
///
/// So many pixels of a plane whose size the pipeline fixes, where the reading is a [`Share`] of a
/// plane `composite_align::Kind` chooses: the two meet only once the share is resolved on this one.
pub const NEAR_IDENTITY: Extent<Analysis> = Extent::exactly(1.15);

/// How finely the frames' intersection is walked, as `composite_solve::COVER_GRID` walks their
/// union.
const COVER_GRID: usize = 400;

/// What an assembly could not be made of, by name.
#[derive(Clone, Debug, PartialEq)]
pub enum Refused {
    /// Sources on a lens nothing has ever fitted: the gather has no ratio table to reach them
    /// through, so every seam would be a doubled edge.
    Lensless(Vec<usize>),
    /// More frames than the seam field's median can stack.
    TooManyFrames(usize),
    /// Sources the analysis canvas never reached, so no tile could pick them.
    Unreached(Vec<usize>),
    /// Planes that are not one per source: a duplicate `source`, or one past the spec's own count.
    NotOnePlanePerSource { planes: usize, sources: usize },
    /// The align itself could not place these.
    NotAligned(String),
    /// The reader asked for it to stop, and it did at the next boundary it crossed.
    Cancelled,
}

/// A recipe with no tiles yet, and what a seam solve reads for the tiles a reader seeds.
pub struct Analysed {
    pub assembly: Assembly,
    /// §3.1's radial check, as `composite_align::Aligned::radial` measured it, or `None` where the
    /// caller brought its own planes and nothing aligned anything.
    pub radial: Option<Share>,
    /// `radial` past [`NEAR_IDENTITY`]: what moved with the camera - parallax - is left to each
    /// seed's own tracking, and a seam near the corners may cross an edge the frames disagree on.
    pub unaligned: bool,
    pub warnings: Vec<String>,
    pub volume: crate::assembly_volume::Volume,
}

/// Steps `analysis_of` reports: the frames' levels and the cells', one per `stepped()` boundary.
const FIELD_STEPS: usize = 2;

/// Whether the reader has asked for this run to stop.
///
/// A blocking call cannot be interrupted from outside itself, so this is the agreement: the stage
/// looks between the steps §3.9 timed - the align, the gather, and each pass of the field - and a
/// cancel is seen within one of them rather than at the end.
fn stopping() -> Result<(), Refused> {
    if crate::progress::cancelled() {
        Err(Refused::Cancelled)
    } else {
        Ok(())
    }
}

/// The same look, one of [`FIELD_STEPS`] behind it: §3's stages are the only places an analysis can
/// be interrupted, so they are also the only honest places for it to say how far it has got.
fn stepped() -> Result<(), Refused> {
    crate::progress::advance();
    stopping()
}

/// A set of photographs, aligned and analysed into a seam field (§3).
pub async fn analyse(sources: &[AlignSource<'_>]) -> Result<Analysed, Refused> {
    let refused = || Refused::NotAligned(crate::base::without_a_device("the analysis"));
    // The whole analysis's budget, claimed before the align so that the align's own steps count
    // into this rather than into a pass of their own: a preview and a pair each, the solve, a
    // full-size plane each, and the field.
    let n = sources.len();
    crate::progress::begin(n + n * n.saturating_sub(1) / 2 + 1 + n + FIELD_STEPS);
    stopping()?;
    let gpu = crate::gpu::device().ok_or_else(refused)?;
    let base = crate::base::device(gpu).ok_or_else(refused)?;

    // A burst points every frame at the same place, so a focal no file stated is nearly
    // unobservable and a free solve wanders tens of percent (§3.1).
    let aligned = crate::composite_align::align(
        gpu,
        sources,
        crate::composite_solve::Leash::Assumed,
        crate::composite_align::Kind::Burst,
    )
    .await
    .map_err(Refused::NotAligned)?;
    if !aligned.lensless.is_empty() {
        return Err(Refused::Lensless(aligned.lensless));
    }
    let unaligned = unaligned_at(aligned.radial);

    let mut spec = aligned.composition;
    spec.crop = intersection_crop(&spec);
    let placed: Vec<&AlignSource<'_>> = spec
        .sources
        .iter()
        .map(|held| {
            sources
                .iter()
                .find(|offered| held.photo_id == offered.photo_id)
                .expect("the align only places what it was offered")
        })
        .collect();
    // Only for the stored noise fit, which saves GALOSH measuring the same mosaic twice. §3.0's
    // colour fit never runs on this path and the lens comes off the recipe.
    let stored: Vec<Option<crate::photo_analysis::PhotoAnalysis>> = placed
        .iter()
        .map(|from| from.analysis.and_then(crate::photo_analysis::decode))
        .collect();
    let files: Vec<crate::composite_tile::SourceFile<'_>> = placed
        .iter()
        .zip(&stored)
        .map(|(from, held)| crate::composite_tile::SourceFile {
            path: from.path,
            analysis: held.as_ref(),
        })
        .collect();
    stopping()?;
    let planes = crate::assembly_planes::analysis_planes(&spec, &files)
        .await
        .map_err(|why| match why == crate::assembly_planes::CANCELLED {
            true => Refused::Cancelled,
            false => Refused::NotAligned(why),
        })?;

    let mut answer = analysis_of(gpu, base, spec, &planes).await?;
    answer.radial = Some(aligned.radial);
    answer.unaligned = unaligned;
    answer.warnings.splice(0..0, aligned.warnings);
    Ok(answer)
}

/// Whether a radial reading is past [`NEAR_IDENTITY`], once it is on the analysis plane.
pub(crate) fn unaligned_at(radial: Share) -> bool {
    radial.across(Span::<Analysis>::exact(
        crate::assembly_planes::ANALYSIS_LONG,
    )) > NEAR_IDENTITY
}

/// Everything §3.3 onward, over planes already gathered: the half of [`analyse`] that needs no
/// files and so can be asked of synthetic frames.
pub async fn analysis_of(
    gpu: &'static Gpu,
    base: &'static Base,
    spec: Composition,
    planes: &[Plane],
) -> Result<Analysed, Refused> {
    if planes.len() > MOST_SOURCES {
        return Err(Refused::TooManyFrames(planes.len()));
    }
    if planes.len() < 2 {
        return Err(Refused::NotAligned(
            "an assembly is made of at least two photographs".into(),
        ));
    }
    let unreached: Vec<usize> = (0..spec.sources.len())
        .filter(|i| !planes.iter().any(|p| p.source == *i))
        .collect();
    if !unreached.is_empty() {
        return Err(Refused::Unreached(unreached));
    }
    // With every source reached, this is what makes the planes a permutation of them, and a
    // permutation is what `by_source` indexes by `plane.source` without a bounds check.
    if planes.len() != spec.sources.len() {
        return Err(Refused::NotOnePlanePerSource {
            planes: planes.len(),
            sources: spec.sources.len(),
        });
    }

    stepped()?;
    let size = planes[0].rgb.size();
    let field = seam_field(gpu, base, planes, size, stepped).await?;
    let shrunk = shrunk_size(size);
    let plane_sources: Vec<usize> = planes.iter().map(|p| p.source).collect();
    let volume = crate::assembly_volume::Volume {
        plane: size,
        shrunk,
        field: crate::assembly_volume::by_source(field, &plane_sources),
    };
    Ok(Analysed {
        volume,
        radial: None,
        unaligned: false,
        warnings: Vec::new(),
        assembly: Assembly::untiled(spec),
    })
}

/// The exact squared Euclidean distance transform, one axis at a time (Felzenszwalb & Huttenlocher
/// 2012): the lower envelope of a set of parabolas, which is `O(n)` a row.
///
/// Exact rather than a chamfer, and the reason is a number a test can state: half of this becomes
/// §5.2's feather, so a 3-4 chamfer's eight percent on the diagonals would be eight percent of the
/// seam's room.
fn envelope(f: &[f64]) -> Vec<f64> {
    let n = f.len();
    let (mut v, mut z) = (vec![0usize; n], vec![0.0f64; n + 1]);
    let mut k = 0usize;
    z[0] = f64::NEG_INFINITY;
    z[1] = f64::INFINITY;
    for q in 1..n {
        loop {
            let p = v[k];
            let s = ((f[q] + (q * q) as f64) - (f[p] + (p * p) as f64)) / (2 * q - 2 * p) as f64;
            if s <= z[k] && k > 0 {
                k -= 1;
                continue;
            }
            k += 1;
            v[k] = q;
            z[k] = s;
            z[k + 1] = f64::INFINITY;
            break;
        }
    }
    let mut out = vec![0.0f64; n];
    let mut k = 0usize;
    for (q, slot) in out.iter_mut().enumerate() {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let p = v[k];
        *slot = ((q as f64 - p as f64) * (q as f64 - p as f64)) + f[p];
    }
    out
}

/// The distance from every cell to the nearest seeded one, capped at `reach`.
///
/// The field itself stays bare `f32` - it is one number a cell over a whole mask, and `Extent` is
/// an `f64` - but every scalar either side of it is in a space: what a caller can get wrong is the
/// cap and the comparison, not the array.
pub fn distance_from(seed: &[bool], size: (usize, usize), reach: Extent<Shrunk>) -> Vec<f32> {
    let (w, h) = size;
    let far = (w * w + h * h) as f64;
    let mut field: Vec<f64> = seed.iter().map(|&s| if s { 0.0 } else { far }).collect();
    let mut column = vec![0.0f64; h];
    let mut row = vec![0.0f64; w];
    for y in 0..h {
        row.copy_from_slice(&field[y * w..(y + 1) * w]);
        field[y * w..(y + 1) * w].copy_from_slice(&envelope(&row));
    }
    for x in 0..w {
        for y in 0..h {
            column[y] = field[y * w + x];
        }
        let done = envelope(&column);
        for y in 0..h {
            field[y * w + x] = done[y];
        }
    }
    let cap = reach.raw() as f32;
    field
        .into_iter()
        .map(|d| (d.max(0.0).sqrt() as f32).min(cap))
        .collect()
}

/// §5.2's `W(x)` for one cell: its corridor capped at twice its own inradius, as a share of the
/// long edge.
///
/// **A cap and not a floor.** At the piece's deepest point the signed distance is the inradius, and
/// `smoothstep(-W, W, inradius)` is 1 only where `W <= inradius` - so a feather wider than the piece
/// is deep applies the reader's pick at part weight in the middle of their own piece. Half the
/// corridor is what the render feathers over, hence the two.
///
/// **A [`Share`] out where shrunk pixels went in**, which is the point of it: the render works at
/// its own scale and has no shrunk mask to resolve one against, so what crosses into the recipe is
/// the fraction rather than the count.
pub fn corridor_share(inside: &[bool], size: (usize, usize), corridor: Extent<Shrunk>) -> Share {
    let long = Span::<Shrunk>::exact(size.0.max(size.1));
    let outside: Vec<bool> = inside.iter().map(|held| !held).collect();
    // Uncapped: what bounds this one is the mask itself, every cell being inside it or not.
    let depth = distance_from(&outside, size, Extent::exactly(long.raw() as f64));
    let inradius = inside
        .iter()
        .enumerate()
        .filter(|(_, held)| **held)
        .fold(0.0f32, |m, (p, _)| m.max(depth[p]));
    Share::measured(
        corridor.raw().min(2.0 * f64::from(inradius)),
        long.raw() as f64,
    )
}

/// §3.8's crop: the largest rectangle of the canvas **every** source reached.
///
/// `Composition::crop` is the union's inner rectangle, which is what a panorama shows. An assembly
/// needs the intersection: a tile may take any frame, and ground only one of them covered has
/// nothing to choose between.
pub fn intersection_crop(spec: &Composition) -> [f64; 4] {
    let (across, down) = (COVER_GRID, COVER_GRID);
    let covered: Vec<bool> = (0..across * down)
        .map(|cell| {
            let (x, y) = (cell % across, cell / across);
            let ray = crate::composition::canvas_to_ray(
                spec,
                (x as f64 + 0.5) / across as f64 * spec.canvas[0] as f64,
                (y as f64 + 0.5) / down as f64 * spec.canvas[1] as f64,
            );
            spec.sources.iter().all(|source| {
                crate::composition::ray_to_source(source, ray).is_some_and(|[sx, sy]| {
                    sx >= 0.0
                        && sy >= 0.0
                        && sx <= source.size[0] as f64
                        && sy <= source.size[1] as f64
                })
            })
        })
        .collect();

    let Some([left, top, wide, tall]) =
        crate::composite_solve::largest_inside(&covered, across, down)
    else {
        return [0.0, 0.0, 1.0, 1.0];
    };
    // Centre to centre, because a cell counts as covered on the strength of its centre and its
    // outer half may not be: the crop's edges are the outermost centres that were actually sampled.
    [
        (left as f64 + 0.5) / across as f64,
        (top as f64 + 0.5) / down as f64,
        ((left + wide - 1) as f64 + 0.5) / across as f64,
        ((top + tall - 1) as f64 + 0.5) / down as f64,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reading_is_unaligned_past_the_bound_on_the_plane_it_was_taken_on() {
        // 1.15 analysis pixels is 0.31 of an 808px plane's and 0.62 of a 1616px one's.
        let on = |px: f64, long: f64| unaligned_at(Share::measured(px, long));
        assert!(!on(0.30, 808.0));
        assert!(on(0.32, 808.0));
        assert!(!on(0.60, 1616.0));
        assert!(on(0.75, 808.0));
    }
}
