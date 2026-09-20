//! A set of photographs into a recipe: what overlaps what, where each one points, and how big the
//! canvas has to be.
//!
//! **Everything here runs on previews.** A `hdr_fit::sample_long_edge` plane a side is what the
//! pairs are searched on and what the rotations are solved from, so aligning ten 61MP frames costs
//! ten preview decodes and no full-resolution pixel at all. The recipe that comes out is stated at
//! the sources' own resolution, which is a scale factor applied at the end and not a second solve.
//!
//! **The camera match never enters the alignment.** A preview *is* the camera's corrected picture,
//! which is the geometry the recipe is stated in, so the lens is carried for the RAW gather to undo
//! later and is not applied to anything here.

use crate::composite_pairs::{Pair, Pyramid};
use crate::composite_solve::{Leash, exposure_of, framed, gains, solve};
use crate::composition::{Composition, LensSpec, SourceSpec, VERSION};
use crate::px::Share;

/// One photograph offered to a composite.
pub struct AlignSource<'a> {
    /// The catalogue's id, which is what the recipe names a source by.
    pub photo_id: &'a str,
    pub path: &'a str,
    /// A picture to build the search plane from instead of this file's own preview.
    ///
    /// **Only ever the same picture at another size.** The recipe is stated in the geometry of the
    /// plane it was solved on, and everything downstream - the composite of the cameras' JPEGs,
    /// the RAW gather going through the lens table to reach them - depends on that being the
    /// camera's corrected geometry. The caller passes a grid tile here only when the tile was
    /// itself built from this camera's JPEG, so what changes is the number of pixels and nothing
    /// else. Lifting the preview out of a RAW is ~75ms a frame; reading a tile is a file read.
    pub preview_path: Option<&'a str>,
    /// The stored camera match, where there is one. A RAW without one is aligned all the same and
    /// gathers through whatever its group's other members fitted.
    pub analysis: Option<&'a [u8]>,
    /// The upright photograph's own size, which is also the size of its corrected picture: the lens
    /// gather writes the grid it read, with the crop folded into the ratio table.
    pub size: [usize; 2],
    pub camera_model: Option<&'a str>,
    pub lens_model: Option<&'a str>,
    pub focal_length: Option<f32>,
    /// The pinhole focal in this source's own full-resolution pixels, where the body's sensor size
    /// is known and the file recorded a focal length.
    ///
    /// **Worth far more than the solve's own answer on a long lens.** What separates a rotation
    /// from a translation is the perspective across a frame, and a 165mm frame subtends eight
    /// degrees - so a pan of such frames leaves the focal nearly free, and a solve let loose on it
    /// wanders twenty percent and bends every rotation to match. Absent for a body lensfun has
    /// never heard of, where the search does what it can.
    pub focal_px: Option<f64>,
    pub shutter: Option<f32>,
    pub aperture: Option<f32>,
    pub iso: Option<f32>,
}

/// A recipe, and what the solve wants said about it.
pub struct Aligned {
    pub composition: Composition,
    /// What the kept correspondences reproject to, in preview pixels.
    pub rms_px: f64,
    /// Sources the recipe left out, by their place in what was offered.
    pub dropped: Vec<usize>,
    /// Which pairs the solve rested on, and what each one's matches reproject to.
    pub kept: Vec<(usize, usize, f64)>,
    /// [`crate::composite_solve::Solved::radial_px`], which is what §3.1 refuses a burst by, as a
    /// share of the long edge the search actually ran on: [`Kind::plane_long`] asks for one, and a
    /// body whose embedded JPEG is shorter brings every plane down to its own size.
    pub radial: Share,
    /// One source per lens nothing has ever fitted, by its place in what was offered.
    ///
    /// **The recipe is stated in the camera's corrected geometry, so a RAW is reached through the
    /// lens's own ratio table** - and where no frame on that lens has a stored camera match there
    /// is no table to reach through, so the composite of the *photographs* stitches them
    /// uncorrected while the composite of the cameras' pictures is perfect. That is a doubled
    /// edge at every seam, on a picture whose whole point is that the seams do not show.
    ///
    /// A library serving the cameras' JPEGs is where it happens: nothing there ever renders a
    /// frame, and the match is fitted inside a render. One index per lens rather than one per
    /// frame, because the group shares whichever fit it gets (`shared_lenses`).
    pub lensless: Vec<usize>,
    pub warnings: Vec<String>,
}

/// Below this a pair's correlation is a coincidence rather than an overlap.
const MIN_SCORE: f64 = 0.45;

/// Below this a pair shares a sliver, and a sliver of sky correlates with anything.
const MIN_OVERLAP: f64 = 0.12;

/// How much of the region a pair claims to share has to actually correspond.
///
/// **The correlation alone does not separate a neighbour from a coincidence, and on some scenes it
/// is not even close.** A twenty-six frame pan of a landscape offered 325 pairs, of which about
/// forty-five were real - and 219 of them cleared a 0.45 correlation and a twelfth of a frame of
/// overlap, several past 0.9. Frames two, three and four apart all reported the same translation to
/// within a few pixels, which is what a repeating scene is: every one of those peaks is a genuine
/// match of a real feature against the wrong instance of it.
///
/// What is measured instead is how much of the claimed overlap actually corresponds: the refine
/// walks a fixed grid over the frame and keeps the points whose neighbours agree, so `matches`
/// against the grid points falling in the overlap is the share that did.
///
/// **A floor, not the separation** - `neighbourly` is what does that. A frame of sky corresponds
/// poorly with its own true neighbour, so a threshold set where it would divide this pan's true
/// pairs from its false ones drops the whole top row of it. What this is for is the pair whose
/// hundred points agree by luck, which is cheap to be sure of and worth not carrying into the solve.
const MIN_CORRESPONDING: f64 = 0.01;

/// How much better one corner's best match has to be than its second before that corner counts as
/// having matched clearly.
///
/// Lowe's ratio again, at the strict end of it. `composite_features` has already dropped everything over
/// `DISTINCT_ENOUGH` when it paired them, so this asks a second and tighter question of what
/// survived: not whether a corner found a match, but whether it found one place and no other. What
/// is done with the answer is [`CLEARLY_MATCHED`], which counts them. `PANO_DISTINCT` moves this.
const DISTINCTLY_MATCHED: f64 = 0.6;

/// What share of a frame's corners have to match that clearly for the corners to vouch for a pair.
///
/// **A count, because the median of the ratios is censored and has almost nothing left in it.**
/// `paired` keeps only what is already under `DISTINCT_ENOUGH`, so the middle of what survives piles
/// up just under that bound: measured over all 325 pairs of the twenty-six frame set from the
/// library's own grid tiles, moving a median bar from 0.69 to 0.72 takes the false pairs vouched
/// from 12 to 112. Counting is not censored, and separates - at this bar 42 of 60 true pairs are
/// vouched against 15 of 265 false, where the median managed 37 and 12. The pair that decided this
/// set, holding the second row together, is vouched here at 0.094 and was refused by the median at
/// 0.708; the coincidence that had been taking a frame seven along its own row sits at 0.047.
///
/// Still not the decision. A pair this vouches for skips the gates below - which exist to refuse a
/// coincidence and have nothing to say about a match already known to be singular - and everything
/// after them applies: `neighbourly`, the consensus over the correspondences, and the growth's own
/// verification. The gates it skips are the ones that could not be made to agree across sets: the
/// correspondence floor wanted 0.006 for one and 0.004 for the other, and `MOSTLY_STRONG` turns out
/// to read backwards on a two-row pan, refusing 19 true pairs of which 17 are the cross-row ones
/// holding the rows together, while admitting 22 false ones that are all within-row repeats.
const CLEARLY_MATCHED: f64 = 0.07;

/// What a correspondence correlating properly looks like, at the preview's own size.
const STRONG_PEAK: f64 = 0.9;

/// How many of a pair's correspondences have to be that: most of them.
///
/// **How well they correlate, not how many there are.** Every other measure here counts
/// correspondences against an area - the frame, the claimed overlap - and a frame of water or sky
/// has few of them however well it is aligned, so all of those read a true pair over thin content as
/// a failure. This one is normalised by the pair's own matches, so it asks whether what did
/// correspond corresponds *well*, which a bare scene answers as clearly as a detailed one.
///
/// That is where a coincidence shows, because a coincidence is a minority report: a false peak is
/// one feature meeting the wrong instance of itself, so a fraction of the points lock on hard and
/// the rest sit at whatever the surrounding texture happens to give. Measured over a twenty-six
/// frame two-row pan of a city, where 219 pairs cleared the correlation and overlap above and about
/// forty-five were real: every false pair sat between 0.07 and 0.35 and the true ones from 0.32 up,
/// most of them past 0.45. The coincidence that had been placing a frame two columns from where it
/// belonged sat at 0.29, against 0.32 for the true neighbour it beat.
///
/// **The two populations meet at that bar rather than part there**, so this sits where they cross
/// rather than under the lowest true pair - and those figures are a sample of the pairs somebody
/// looked at, not the whole set. Nothing measured here separates the two populations outright; see
/// `DISTINCTLY_MATCHED`, which ranks better than any of them and still overlaps.
///
/// What that costs is a pair whose overlap is half water, which has a stronger route into the set
/// anyway. The two measures either side of this one were both tried and are worse: the whole-overlap
/// correlation has true pairs down at 0.56 where a pan turns back on itself, and the share of the
/// overlap that corresponds cannot tell thin content from a bad match by construction.
const MOSTLY_STRONG: f64 = 0.4;

/// How far a source's own lens fit may sit from its group's before the align says so, as a
/// displacement at the corner in preview pixels.
const LENS_OUTLIER_PX: f64 = 2.0;

/// What a lens is worth being told about, absent a match: 55 degrees across, which is a normal
/// lens and the wrong answer by less than a stop for most of what anyone panoramas with.
const ASSUMED_HFOV: f64 = 55.0;

const QUANTILE: f64 = 0.99;

/// What kind of set is being aligned, which only the caller knows and which two things here turn
/// on.
///
/// **A pan and a burst see opposite halves of the same geometry.** A pan's frames overlap in a
/// strip: every pixel of the search is a pixel of evidence, so it wants the larger plane - but a
/// per-frame scale is a parameter those matches cannot constrain, and a free one wanders. A burst's
/// frames sit on top of one another: the scale between two of them is as well observed as their
/// rotation, and it is a real difference (a lens breathes as it refocuses, a hand moves along the
/// axis) - while the plane can be half the size, because the align is only the first of two stages
/// and §3.7a's per-piece warp carries the last few pixels at the analysis scale.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Pan,
    Burst,
}

impl Kind {
    /// The long edge of the plane the search runs on.
    ///
    /// The tolerances travel with it: `composite_solve::across` states them as shares of the long
    /// edge rather than counts of pixels, which is the failure `px.rs` opens on.
    fn plane_long(self) -> usize {
        match self {
            Kind::Pan => crate::hdr_fit::sample_long_edge(),
            Kind::Burst => crate::hdr_fit::sample_long_edge() / 2,
        }
    }
}

/// Every source's preview, aligned, solved and framed into one recipe.
///
/// `untold` is how far the solve may move a focal no file stated, which only the caller knows:
/// a pan sees enough perspective to solve for one, near-identical frames do not.
pub async fn align(
    gpu: &'static crate::gpu::Gpu,
    sources: &[AlignSource<'_>],
    untold: Leash,
    kind: Kind,
) -> Result<Aligned, String> {
    if sources.len() < 2 {
        return Err("a merge is made of at least two photographs".into());
    }
    let mut warnings = Vec::new();
    let mut lensless = Vec::new();
    let lenses = shared_lenses(sources, &mut warnings, &mut lensless);

    // A preview each, then a pass over every pair of them, then the solve.
    let n = sources.len();
    crate::progress::begin(n + n * (n - 1) / 2 + 1);
    let planes = previews_at(gpu, sources, kind.plane_long()).await?;
    let sizes: Vec<[usize; 2]> = planes.iter().map(|p| [p.width, p.height]).collect();
    let pyramids: Vec<Pyramid> = planes.iter().map(|plane| Pyramid::of(gpu, plane)).collect();

    // **What each frame's corners look like, once.** The pairs below ask the one question a
    // correlation search cannot: whether a match is the *only* good answer. A frame's corners are
    // described here rather than per pair, since the description does not depend on who is asking.
    let mut lap = crate::clock::laps("  align ");
    let distinctly: f64 = std::env::var("PANO_DISTINCT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DISTINCTLY_MATCHED);
    let clearly_bar: f64 = std::env::var("PANO_CLEARLY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(CLEARLY_MATCHED);
    let floor: f64 = std::env::var("PANO_CORRESP")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(MIN_CORRESPONDING);
    // `PANO_STRONG` moves the bar, for sweeping how wide the band is that still answers
    // correctly. A margin is a thing to measure, not to assume.
    let strong_bar: f64 = std::env::var("PANO_STRONG")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(MOSTLY_STRONG);
    let mut described = Vec::with_capacity(pyramids.len());
    for level in &pyramids {
        let corners = match distinctly > 0.0 {
            true => crate::composite_features::described(gpu, level.top()).await,
            false => None,
        };
        described.push(corners);
    }
    lap("describe");
    let mut coarse_ms = 0.0;
    let mut refine_ms = 0.0;
    let mut pairs = Vec::new();
    for a in 0..pyramids.len() {
        for b in a + 1..pyramids.len() {
            let at = crate::clock::Mark::now();
            let found = crate::composite_pairs::coarse(
                gpu,
                pyramids[a].coarse(),
                pyramids[b].coarse(),
                MIN_OVERLAP,
            )
            .await;
            coarse_ms += at.elapsed().as_secs_f64() * 1000.0;
            crate::progress::advance();
            let Some(found) = found else {
                continue;
            };
            if found.score < MIN_SCORE || found.overlap < MIN_OVERLAP {
                continue;
            }
            // **How many of this frame's corners have exactly one good answer in the other.** A
            // coincidence of a repeating scene is a match whose second-best place is nearly as good,
            // which is the only thing that tells it from a true overlap once the correlation, the
            // count and the share of the overlap have all said the same of both.
            // Every description against every description is a second a set of this size, so it is
            // asked only where the answer can refuse something.
            //
            // **How many cleared a strict ratio, not the middle of the ratios.** The median cannot
            // carry this: `paired` has already dropped everything over `DISTINCT_ENOUGH`, so the
            // middle of what is left sits just under that bound for almost every pair, true or not,
            // and a bar moved three hundredths takes the false pairs vouched from 12 to 112. The
            // count that fails for the same reason is the share matching *at all* - that one is
            // about how much content a frame has rather than whether the match is right, and a true
            // pair over dark hills matched 0.229 of its corners where a coincidence against the
            // wrong row of a city frame matched 0.246. Asking how many matched one place and no
            // other is neither: a repeating scene answers a corner twice however much of it there
            // is, so this counts the corners a repeat cannot produce.
            let clearly = match (distinctly > 0.0, &described[a], &described[b]) {
                (true, Some(ours), Some(theirs)) => {
                    let pairs = crate::composite_features::paired(ours, theirs);
                    let clear = pairs.iter().filter(|p| p.over <= distinctly).count();
                    clear as f64 / ours.at.len().max(1) as f64
                }
                // A frame with no corners to describe has no opinion, which is not the same as a
                // bad one - so it vouches for nothing and the measures below decide alone.
                _ => 0.0,
            };
            // `PANO_CLEARLY` moves the bar, for sweeping how wide the band is that still answers
            // correctly. A margin is a thing to measure, not to assume.
            let vouched = clearly >= clearly_bar;
            let at = crate::clock::Mark::now();
            let refine =
                crate::composite_pairs::refined(gpu, &pyramids[a], &pyramids[b], found).await;
            let (matches, sampled) = (refine.found, refine.sampled);
            refine_ms += at.elapsed().as_secs_f64() * 1000.0;
            // **Two kinds of evidence, and either is enough.** The floor asks how much of the
            // claimed overlap corresponds, which a frame of open water fails however well it is
            // aligned - measured, the pair holding the two darkest frames of a pan onto the rest
            // corresponds over a two-hundredth of what it shares, and losing it drops both frames
            // and the panorama's crop with them. The corners ask something the floor cannot: whether
            // the match is the only good answer. A coincidence fails both; a true pair over thin
            // content fails the first and passes the second.
            let corresponds = matches.len() >= (floor * sampled as f64 * found.overlap) as usize;
            if !corresponds && !vouched {
                continue;
            }
            if !vouched {
                let strong = matches.iter().filter(|m| m.peak > STRONG_PEAK).count();
                if (strong as f64) < strong_bar * matches.len() as f64 {
                    continue;
                }
            }
            pairs.push(Pair {
                a,
                b,
                score: found.score,
                found: matches.len(),
                matches: refine.settled,
                vouched,
            });
        }
    }
    let searched = pairs.len();
    pairs = neighbourly(pairs, n);
    if std::env::var_os("BOWERBIRD_DECODE_PROFILE").is_some() {
        let found: usize = pairs.iter().map(|p| p.matches.len()).sum();
        eprintln!(
            "  align searched {} pairs: {coarse_ms:.0}ms coarse, {refine_ms:.0}ms refine, {searched} correspond, {} kept with {found} matches",
            n * (n - 1) / 2,
            pairs.len()
        );
    }
    lap("pairs");
    if pairs.is_empty() {
        return Err("no two of these photographs overlap".into());
    }

    // The body's answer where it has one, carried into the plane the solve works in.
    let told = sources.iter().zip(&sizes).find_map(|(source, plane)| {
        let full = source.size[0].max(source.size[1]) as f64;
        source
            .focal_px
            .map(|focal| focal * plane[0].max(plane[1]) as f64 / full)
    });
    let (focal0, leash) = match told {
        Some(focal) => (focal, Leash::Told),
        None => (assumed_focal(&sizes[0]), untold),
    };
    let mut solved = solve(&sizes, &pairs, focal0, leash)
        .ok_or_else(|| "these photographs do not make one picture".to_string())?;
    if kind == Kind::Burst {
        crate::composite_solve::scale_each(&sizes, &pairs, &mut solved);
    }
    let solved = solved;
    lap("solve");
    crate::progress::advance();
    for &i in &solved.dropped {
        warnings.push(format!(
            "{} does not overlap the rest and was left out",
            sources[i].photo_id
        ));
    }

    let kept: Vec<usize> = (0..sources.len())
        .filter(|i| !solved.dropped.contains(i))
        .collect();
    if kept.len() < 2 {
        return Err("only one of these photographs could be placed".into());
    }
    // The most connected of them: the panorama is graded as this one's rendering, and it is the
    // frame the exposures are matched to, so it wants to be in the middle rather than at an end.
    let reference = *kept
        .iter()
        .max_by_key(|&&i| {
            pairs
                .iter()
                .filter(|p| p.a == i || p.b == i)
                .map(|p| p.matches.len())
                .sum::<usize>()
        })
        .expect("a kept source");

    let exposures: Vec<Option<f64>> = sources
        .iter()
        .map(|s| exposure_of(s.shutter, s.aperture, s.iso))
        .collect();
    // `measured` is always empty here: nothing computes a pairwise exposure ratio from the align's
    // own matches, so every source's gain is the header arithmetic alone. Left unfinished rather
    // than built out - the take-best-parts design spec's section 8 says why a burst does not want
    // it fixed here either.
    let matched = gains(&exposures, &[], reference);

    let full_scale = |i: usize| {
        let long = sources[i].size[0].max(sources[i].size[1]) as f64;
        long / sizes[i][0].max(sizes[i][1]) as f64
    };
    let framing = framed(&solved, &sizes, full_scale(reference));

    let panorama = Composition {
        version: VERSION,
        sources: kept
            .iter()
            .map(|&i| SourceSpec {
                photo_id: sources[i].photo_id.to_string(),
                size: sources[i].size,
                rotation: solved.rotations[i],
                focal: solved.focal * solved.scales[i] * full_scale(i),
                lens: lenses[i].clone(),
                gain: matched[i],
                // §3.7a is measured after the align and applied per tile; what the solve answers is
                // where a whole frame points.
                warp: crate::composition::no_warp(),
            })
            .collect(),
        projection: framing.projection,
        canvas: framing.canvas,
        centre: framing.centre,
        radians_per_pixel: framing.radians_per_pixel,
        crop: framing.crop,
        reference: kept.iter().position(|&i| i == reference).unwrap_or(0),
        seam_rms_px: None,
    };
    Ok(Aligned {
        composition: panorama,
        rms_px: solved.rms_px,
        dropped: solved.dropped.clone(),
        kept: solved.kept.clone(),
        radial: Share::measured(
            solved.radial_px,
            sizes
                .iter()
                .map(|size| size[0].max(size[1]))
                .max()
                .unwrap_or(1) as f64,
        ),
        lensless,
        warnings,
    })
}

/// Only each frame's best few overlaps, which is what a photograph can actually have.
///
/// **A frame in a pan neighbours a handful of others and correlates with dozens.** Measured on a
/// twenty-six frame two-row pan of a landscape: 325 pairs searched, 219 of them past a 0.45
/// correlation and a twelfth of a frame of overlap, and about forty-five true. Several false ones
/// scored past 0.9 - and the giveaway is that frames two, three, four, five, six and seven along all
/// reported frame zero at the *same* translation, which is what a repeating scene does. No threshold
/// on the correlation separates those, because each is a real match of a real feature against the
/// wrong instance of it.
///
/// What does separate them is that a true overlap corresponds across most of itself while a
/// coincidence agrees at a few hundred points, so the true neighbours are at the top of every
/// frame's own list. Keeping that top few per frame is Brown and Lowe's `m`, and the union over both
/// endpoints is what lets a frame with weak texture stay reachable: a sky-heavy frame corresponds
/// poorly with everything, so it is nobody's best neighbour, but its own list still names the frames
/// it really touches.
fn neighbourly(pairs: Vec<Pair>, n: usize) -> Vec<Pair> {
    let mut best: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (at, pair) in pairs.iter().enumerate() {
        best[pair.a].push(at);
        best[pair.b].push(at);
    }
    let mut keep = vec![false; pairs.len()];
    for own in &mut best {
        own.sort_by_key(|&at| std::cmp::Reverse(pairs[at].matches.len()));
        for &at in own.iter().take(MOST_NEIGHBOURS) {
            keep[at] = true;
        }
    }
    pairs
        .into_iter()
        .zip(keep)
        .filter(|(_, keep)| *keep)
        .map(|(pair, _)| pair)
        .collect()
}

/// How many overlaps one photograph is allowed to have.
///
/// Brown and Lowe's `m`, and their number. A frame in a single row has two neighbours, one in a grid
/// has four, and the corners of the diagonal ones make eight where the rows are offset - so this is
/// slack rather than a limit, and what it excludes is the dozens a repeating scene invents.
const MOST_NEIGHBOURS: usize = 6;

/// Every source's preview, in the order they were offered.
///
/// Public for the probe that prints what the pairs measure: an align that refuses says one
/// sentence, which is right for a toast and no use for finding out why.
pub async fn previews(
    gpu: &'static crate::gpu::Gpu,
    sources: &[AlignSource<'_>],
) -> Result<Vec<crate::hdr_fit::Source>, String> {
    previews_at(gpu, sources, crate::hdr_fit::sample_long_edge()).await
}

/// The same, on a plane of a stated long edge.
///
/// An assembly asks for half what a pan does, and can: a pan has to place frames that overlap in a
/// strip, where every pixel of the search is a pixel of evidence, while a burst's frames sit on top
/// of one another and the align is only the first of two stages - §3.7a's per-piece warp is what
/// carries the last few pixels, and it works at the analysis scale rather than this one.
///
/// **The tolerances travel with it**, `across` being a share of the long edge rather than a count
/// of pixels, which is the failure `px.rs` opens on and the reason that function exists.
pub async fn previews_at(
    gpu: &'static crate::gpu::Gpu,
    sources: &[AlignSource<'_>],
    long: usize,
) -> Result<Vec<crate::hdr_fit::Source>, String> {
    let wide = plane_edge(long);
    let mut planes = Vec::with_capacity(sources.len());
    for source in sources {
        planes.push(preview_of(gpu, source, wide).await?);
        crate::progress::advance();
    }

    // **One scale, or the focal is two numbers at once.** The search compares two planes on one
    // grid and the solve carries a single focal in their pixels, so a set whose planes are not all
    // the same size is not a harder problem, it is a different one per pair: measured on a
    // seven-frame pan where two frames fell back to a 1616px preview and five were read from 800px
    // tiles, the focal settled at 2.02x the truth, which is the ratio of the two sizes exactly.
    //
    // Nothing about that is exotic - a pan shot on two bodies embeds two sizes of preview - so the
    // shortest is what they are all brought to, and only the ones that were longer pay for it.
    let shortest = planes
        .iter()
        .map(|plane| plane.width.max(plane.height))
        .min()
        .unwrap_or(wide);
    if shortest < wide {
        for (at, source) in sources.iter().enumerate() {
            if planes[at].width.max(planes[at].height) > shortest {
                planes[at] = preview_of(gpu, source, shortest).await?;
            }
        }
    }
    Ok(planes)
}

/// How far down a named plane is decoded, which is the preview's own bound unless
/// `BOWERBIRD_PLANE_EDGE` says otherwise.
///
/// A knob for measuring rather than for using: what a tile costs in alignment accuracy is the
/// resolution alone, and holding two sources of the same picture at one size is the only way to
/// see that separately from the geometry (`composite_probe`).
fn plane_edge(bound: usize) -> usize {
    std::env::var("BOWERBIRD_PLANE_EDGE")
        .ok()
        .and_then(|edge| edge.parse::<usize>().ok())
        .filter(|edge| *edge > 0)
        .map_or(bound, |edge| edge.min(bound))
}

/// One source's preview, as the plane every search here reads.
///
/// A RAW's is the JPEG the camera embedded; a finished picture's is the picture itself, reduced to
/// the same grid. Either way what comes back is the camera's own rendering, which is what makes the
/// two comparable to each other at all - and why `preview_path`, where the caller has one, is
/// allowed to stand in for the RAW: it names a copy of that same JPEG.
async fn preview_of(
    gpu: &'static crate::gpu::Gpu,
    source: &AlignSource<'_>,
    wide: usize,
) -> Result<crate::hdr_fit::Source, String> {
    // **A copy of this camera's own JPEG, prepared exactly as the JPEG is.** Not through the
    // rendered branch below: that one decodes to scene-linear and reduces on the device, which is
    // a different preparation of the same picture and answers a different alignment - measured on
    // a five-frame pan, the same planes through the two paths moved the canvas by a percent and
    // the straighten by half a degree. What differs here is the number of pixels and nothing else.
    //
    // Server-side, because a stored rendition is: the plane is one of ours and decodes through
    // libavif, which the browser does not link. Nothing else sets `preview_path` - `composite_job`,
    // itself behind this feature, is the only caller that can - so in a client build this branch
    // is not merely unused but unreachable.
    #[cfg(feature = "renditions")]
    if let Some(plane) = source.preview_path {
        let bytes =
            std::fs::read(plane).map_err(|why| format!("{plane} could not be read: {why}"))?;
        let picture = crate::image::decode(&bytes, wide)?;
        return Ok(crate::hdr_fit::Source {
            buffer: crate::hdr_fit::levelled_source(gpu, picture.as_ref()),
            width: picture.width,
            height: picture.height,
        });
    }

    let path = source.path;
    if !crate::decode_rendered::is_rendered(path) {
        let preview = crate::decode_rawler::upright_preview_rgb(
            path,
            wide,
            crate::decode_rawler::Preview::for_the_match(),
        )
        .ok_or_else(|| format!("{} embeds no preview to align on", source.photo_id))?;
        return Ok(crate::hdr_fit::Source {
            buffer: crate::hdr_fit::levelled_source(gpu, preview.as_ref()),
            width: preview.width,
            height: preview.height,
        });
    }

    let frame = crate::decode::frame_from_path(
        path,
        crate::galosh::Detail::at(0.0, 0.0),
        wide as u32,
        // The floor above is the whole of what this wants: a preview is a reduction, and halving
        // a mosaic underneath it would be one the alignment never asked for.
        false,
        crate::galosh::Fit::Measure,
        crate::dust::Wanted::Off,
    )
    .ok_or_else(|| format!("{} could not be decoded", source.photo_id))?;
    let resident = frame
        .on_device(gpu)
        .ok_or_else(|| format!("{} could not be read onto the device", source.photo_id))?;
    let prepared = crate::fit_source::prepared(gpu, &resident, wide, QUANTILE)
        .await
        .ok_or_else(|| format!("{} could not be reduced to a preview", source.photo_id))?;
    // The rendering rather than the scene-linear plane beside it: a RAW's preview arrives coded,
    // and a correlation between a coded plane and a linear one is a correlation across a gamma.
    let rendered = prepared.rendered;
    Ok(crate::hdr_fit::Source {
        buffer: rendered.buffer,
        width: rendered.width,
        height: rendered.height,
    })
}

/// One lens per (body, lens, focal length), the per-knot median of what its members fitted.
///
/// **The per-frame noise of a camera match is what a seam shows.** Only the *difference* between two
/// sources' lens errors reaches the seam between them, so giving every frame shot on one lens the
/// same answer makes that difference zero by construction - which matters more than any one of the
/// fits being right.
fn shared_lenses(
    sources: &[AlignSource<'_>],
    warnings: &mut Vec<String>,
    lensless: &mut Vec<usize>,
) -> Vec<LensSpec> {
    let group_of = |s: &AlignSource<'_>| {
        (
            s.camera_model.unwrap_or_default().to_string(),
            s.lens_model.unwrap_or_default().to_string(),
            s.focal_length
                .map(|f| (f * 10.0).round() as i64)
                .unwrap_or_default(),
        )
    };
    let own: Vec<Option<crate::fit::Lens>> = sources
        .iter()
        .map(|s| {
            let bytes = s.analysis?;
            crate::photo_analysis::decode(bytes)?
                .from_raw
                .matched
                .map(|m| m.lens)
        })
        .collect();

    let mut out = vec![LensSpec::none(); sources.len()];
    let mut seen: Vec<(String, String, i64)> = Vec::new();
    for source in sources {
        let key = group_of(source);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key.clone());
        let members: Vec<usize> = (0..sources.len())
            .filter(|&i| group_of(&sources[i]) == key)
            .collect();
        let fits: Vec<&crate::fit::Lens> =
            members.iter().filter_map(|&i| own[i].as_ref()).collect();
        let Some(median) = middle_lens(&fits) else {
            // Nothing on this lens has ever been rendered, so nothing has fitted it. Said rather
            // than shrugged at: the RAW gather has no table to reach the sensor through, and the
            // caller can fit one and ask again.
            warnings.push(format!(
                "nothing has measured the lens {} was shot on, so the photographs cannot be stitched through it",
                source.photo_id
            ));
            lensless.push(members[0]);
            continue;
        };
        for &i in &members {
            if let Some(mine) = &own[i]
                && corner_apart(mine, &median) > LENS_OUTLIER_PX
            {
                warnings.push(format!(
                    "{}'s lens fit sits apart from the rest and was replaced by theirs",
                    sources[i].photo_id
                ));
            }
            out[i] = LensSpec::from(&median);
        }
    }
    out
}

/// The knot-by-knot median of several fits of one lens, and the median of their crops.
fn middle_lens(fits: &[&crate::fit::Lens]) -> Option<crate::fit::Lens> {
    if fits.is_empty() {
        return None;
    }
    let middle = |mut values: Vec<f64>| {
        values.sort_by(f64::total_cmp);
        values[values.len() / 2]
    };
    // A fit whose lens has no distortion term is still a fit, and its crop and falloff are still
    // answers: `None` here means nobody measured the lens, which is what the caller refuses on.
    let knots = fits
        .iter()
        .filter_map(|l| l.distortion.as_deref())
        .map(<[f64]>::len)
        .max()
        .unwrap_or(0);
    let distortion: Vec<f64> = (0..knots)
        .map(|k| {
            middle(
                fits.iter()
                    .filter_map(|l| l.distortion.as_deref())
                    .filter_map(|d| d.get(k).copied())
                    .collect(),
            )
        })
        .collect();
    let falloff = fits.iter().filter_map(|l| l.falloff).collect::<Vec<_>>();
    Some(crate::fit::Lens {
        distortion: (!distortion.is_empty()).then_some(distortion),
        crop: middle(fits.iter().map(|l| l.crop).collect()),
        falloff: (!falloff.is_empty()).then(|| {
            (
                middle(falloff.iter().map(|f| f.0).collect()),
                middle(falloff.iter().map(|f| f.1).collect()),
            )
        }),
        // Whichever the first member fitted: a lateral aberration is a property of the lens and
        // this is the same lens, and a median of two curves that disagree is a third curve.
        tca: fits.iter().find_map(|l| l.tca.clone()),
    })
}

/// How far two lenses disagree at the corner, in the pixels of a preview.
fn corner_apart(one: &crate::fit::Lens, other: &crate::fit::Lens) -> f64 {
    let half = crate::hdr_fit::sample_long_edge() as f64 / 2.0;
    let at = |lens: &crate::fit::Lens| {
        crate::image::sample_radius(
            lens.distortion.as_deref().unwrap_or_default(),
            1.0,
            lens.crop,
        )
    };
    (at(one) - at(other)).abs() * half
}

/// What to start the solve's focal at when the file will not say, in the preview's own pixels.
fn assumed_focal(size: &[usize; 2]) -> f64 {
    let across = size[0].max(size[1]) as f64;
    across / 2.0 / (ASSUMED_HFOV / 2.0).to_radians().tan()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::composition::{Projection, from_axis_angle, multiply, ray_to_source};

    pub(crate) use crate::composite_scene::{FOCAL, TALL, WIDE, rig};

    /// The views of a rig, written where a decode can open them.
    pub(crate) fn fixtures(name: &str, rig: &[[f64; 4]]) -> Vec<String> {
        let directory = std::env::temp_dir().join(format!("bowerbird-pano-{name}"));
        crate::composite_scene::views(&directory, rig)
    }

    fn offered<'a>(paths: &'a [String]) -> Vec<AlignSource<'a>> {
        paths
            .iter()
            .map(|path| AlignSource {
                photo_id: path,
                path,
                preview_path: None,
                analysis: None,
                size: [WIDE, TALL],
                camera_model: None,
                lens_model: None,
                focal_length: None,
                // A written fixture has no body to ask, so the solve finds its own focal - which
                // is the case a wide rig can answer for itself.
                focal_px: None,
                shutter: None,
                aperture: None,
                iso: None,
            })
            .collect()
    }

    /// **A lens nobody has fitted is said, not shrugged at.** The recipe is stated in the camera's
    /// corrected geometry, so a composite of the photographs reaches each RAW through that lens's
    /// ratio table - and with no table it stitches them uncorrected, which is a doubled edge at
    /// every seam of a picture whose whole point is that the seams do not show. One index per
    /// lens, because the group shares whichever fit it is given.
    #[test]
    fn a_lens_nothing_has_fitted_is_reported_once_for_the_lens() {
        let mut warnings = Vec::new();
        let mut lensless = Vec::new();
        let paths: Vec<String> = ["a", "b", "c"].iter().map(|s| (*s).to_string()).collect();
        let mut sources = offered(&paths);
        for source in &mut sources {
            source.camera_model = Some("Body");
            source.lens_model = Some("35mm");
            source.focal_length = Some(35.0);
        }
        sources[2].lens_model = Some("85mm");

        let lenses = shared_lenses(&sources, &mut warnings, &mut lensless);

        // Nothing has an analysis here, so neither lens has a fit and each says so once.
        assert_eq!(lensless, vec![0, 2]);
        assert_eq!(warnings.len(), 2);
        assert!(lenses.iter().all(|lens| lens.distortion.is_none()));
    }

    /// **A lens that is the identity has still been measured**, and a fit of one is not the same
    /// thing as no fit at all - which is what `Refused::Lensless` stops an assembly on. A synthetic
    /// camera is the case that is all identity, and a rectilinear body whose fit found nothing to
    /// correct is the case that is not synthetic.
    #[test]
    fn a_fitted_lens_with_no_distortion_is_not_a_lens_nobody_fitted() {
        let mut analysis = crate::photo_analysis::PhotoAnalysis::default();
        analysis.from_raw.matched = Some(crate::hdr_fit::HdrMatch {
            lens: crate::fit::Lens::none(),
            colour: crate::hdr_fit::HdrColour::identity(),
        });
        let stored = crate::photo_analysis::encode(&analysis);

        let mut warnings = Vec::new();
        let mut lensless = Vec::new();
        let paths: Vec<String> = ["a", "b"].iter().map(|s| (*s).to_string()).collect();
        let mut sources = offered(&paths);
        sources[0].analysis = Some(&stored);

        let lenses = shared_lenses(&sources, &mut warnings, &mut lensless);

        assert!(
            lensless.is_empty(),
            "an identity lens is a lens: {lensless:?}"
        );
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(lenses.iter().all(|lens| lens.distortion.is_none()));
    }

    /// A window straddling the seam of a two-frame panorama comes back as a tile: the composite is
    /// a `tile::Prepared` like any other window, which is what lets the grade, the encode and the
    /// loupe take it without knowing a panorama exists.
    #[test]
    fn a_window_of_the_composite_is_a_prepared_tile() {
        let (p, paths) = merged("tile");
        let (across, down) = (512usize, 256usize);
        let (frame, prepared) = composited(
            &p,
            &paths,
            across,
            down,
            crate::composite_tile::From::Original,
        );
        assert_eq!((prepared.width, prepared.height), (across, down));
        assert_eq!(prepared.keep, [0, 0, across, down]);
        assert_eq!(prepared.photograph, (p.canvas[0], p.canvas[1]));

        let samples = pollster::block_on(frame.into_host()).expect("the window reads back");
        assert_eq!(samples.len(), across * down * 3);
        // Every pixel of a window in the middle of both frames is covered by both of them, so
        // nothing in it may come back as the black an uncovered pixel is.
        assert!(
            samples.iter().all(|code| *code > 0),
            "the composite has holes in it"
        );
    }

    /// The same window from the cameras' own JPEGs, which is what a merged panorama is drawn from
    /// while its render is still owed.
    ///
    /// **The recipe needs no second alignment to reach them.** It is stated in the camera's
    /// corrected geometry - the previews it was solved from *are* these pictures - so the same
    /// rotations and the same canvas land on the same content, and what differs is how many
    /// pixels there are. Held to the RAW composite's own luma rather than to a fixture, since
    /// nothing pins the camera's rendering to ours; what is being asserted is that the two are
    /// the same picture.
    #[test]
    fn the_camera_composite_lands_where_the_rendered_one_does() {
        let (p, paths) = merged("embedded");
        let (across, down) = (512usize, 256usize);
        let luma = |from| {
            let (frame, _) = composited(&p, &paths, across, down, from);
            pollster::block_on(frame.into_host()).expect("the window reads back")
        };
        let rendered = luma(crate::composite_tile::From::Original);
        let camera = luma(crate::composite_tile::From::Camera);

        assert_eq!(camera.len(), rendered.len());
        assert!(
            camera.iter().all(|code| *code > 0),
            "the camera composite has holes in it"
        );
        // Their *shape*: a correlation over the window, which is what says the two composites put
        // the same content in the same place. Their codes are two different renderings of it and
        // are not expected to agree.
        let mean = |of: &[u16]| of.iter().map(|c| f64::from(*c)).sum::<f64>() / of.len() as f64;
        let (ours, theirs) = (mean(&rendered), mean(&camera));
        let mut covariance = 0.0;
        let (mut ours2, mut theirs2) = (0.0, 0.0);
        for (a, b) in rendered.iter().zip(&camera) {
            let (a, b) = (f64::from(*a) - ours, f64::from(*b) - theirs);
            covariance += a * b;
            ours2 += a * a;
            theirs2 += b * b;
        }
        let correlation = covariance / (ours2 * theirs2).sqrt();
        assert!(
            correlation > 0.98,
            "the two composites disagree: {correlation}"
        );
    }

    /// Two views 20 degrees apart, aligned into a recipe.
    fn merged(name: &str) -> (Composition, Vec<String>) {
        let gpu = crate::gpu::device().expect("an adapter for the composite");
        let pan = |degrees: f64| from_axis_angle([0.0, degrees.to_radians(), 0.0]);
        let paths = fixtures(name, &[pan(-10.0), pan(10.0)]);
        let aligned = pollster::block_on(align(gpu, &offered(&paths), Leash::Free, Kind::Pan))
            .expect("two views align");
        (aligned.composition, paths)
    }

    /// A window on the canvas's centre, which is where the two frames meet.
    fn composited(
        p: &Composition,
        paths: &[String],
        across: usize,
        down: usize,
        from: crate::composite_tile::From,
    ) -> (crate::resident::Resident, crate::tile::Prepared) {
        let files: Vec<crate::composite_tile::SourceFile<'_>> = paths
            .iter()
            .map(|path| crate::composite_tile::SourceFile {
                path,
                analysis: None,
            })
            .collect();
        let request = crate::composite_tile::CompositeRequest {
            // The whole window, which is what an empty list means.
            parts: &[],
            window: crate::px::Rect::exact(
                p.canvas[0] / 2 - across / 2,
                p.canvas[1] / 2 - down / 2,
                across,
                down,
            ),
            scale: 1.0,
            white_quantile: 0.99,
            // One window, measured off itself: what the banding rule is about is a *set* of
            // windows disagreeing, and there is one here.
            levels: None,
            reference_white_nits: crate::light::Light::exactly(203.0),
            strengths: crate::image::Strengths {
                sharpen: 0.0,
                defringe: 0.0,
            },
            detail: crate::galosh::Detail::at(0.0, 0.0),
            sources: &files,
            from,
            mask: None,
        };
        pollster::block_on(crate::composite_tile::prepared(p, &request))
            .expect("a window composites")
    }

    /// Four photographs of one world, told nothing about each other, come back as a recipe whose
    /// canvas holds all of them and whose sources point where they were shot from.
    ///
    /// Finished pictures rather than RAWs, which is a source this supports in its own right and is
    /// also the only kind a test can write: everything downstream of the preview is identical, the
    /// alignment never seeing a mosaic or a camera match.
    #[test]
    fn six_views_of_one_world_align() {
        let gpu = crate::gpu::device().expect("an adapter for the alignment");
        let truth = rig();
        let paths = fixtures("align", &truth);
        let sources = offered(&paths);

        let aligned = pollster::block_on(align(gpu, &sources, Leash::Free, Kind::Pan))
            .expect("six views align");
        let p = &aligned.composition;
        assert_eq!(
            p.sources.len(),
            truth.len(),
            "dropped {:?}",
            aligned.dropped
        );
        // Per correspondence, which is what a 7x7 patch of smooth noise is worth. What the recipe
        // is actually held to is the rotations below, which are a mean over hundreds of them.
        assert!(aligned.rms_px < 1.0, "rms {}", aligned.rms_px);
        assert_eq!(p.projection, Projection::Cylindrical);
        assert!(
            p.canvas[0] > WIDE,
            "canvas {:?} is no wider than one source",
            p.canvas
        );
        assert!(
            (p.sources[0].focal - FOCAL).abs() < 0.01 * FOCAL,
            "focal {}",
            p.sources[0].focal
        );

        // Every source's own centre lands where its rotation says, which is the recipe agreeing
        // with the world the views were taken from.
        let apart: Vec<f64> = p
            .sources
            .iter()
            .map(|source| {
                let want = multiply(
                    crate::composition::conjugate(truth[0]),
                    truth[paths
                        .iter()
                        .position(|p| *p == source.photo_id)
                        .expect("a source")],
                );
                let got = multiply(
                    crate::composition::conjugate(p.sources[0].rotation),
                    source.rotation,
                );
                let off = multiply(crate::composition::conjugate(want), got);
                2.0 * off[0].abs().min(1.0).acos().to_degrees()
            })
            .collect();
        // A quarter of a degree, which is what the refine is worth over a perspective difference:
        // the correspondence search reads a nine-pixel window about a belief that is a median over
        // a tile, so a displacement whose *gradient* across the frame is what a focal is read from
        // comes back slightly flattened - measured, about half a percent of focal, which is this
        // much of a degree at the far end of a two-column pan. It is a systematic and not noise,
        // and what closes it is the seam measured on the gathered layers at the first render.
        assert!(
            apart.iter().all(|off| *off < 0.25),
            "off by {apart:?} degrees at a focal of {}",
            p.sources[0].focal
        );

        // The recipe reaches the pixels it names: the reference's own centre is on the canvas.
        let centre = ray_to_source(p.reference(), [0.0, 0.0, 1.0]);
        assert!(
            centre.is_some(),
            "the reference does not look at its own axis"
        );
    }
}
