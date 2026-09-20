//! What a job asks of a composite: align a set of photographs into a recipe, or render one.
//!
//! **A render leaves `job::run` alone.** What a panorama produces is a coded frame with levels and
//! a colour match beside it, which is what a decode produces - so the grade, the resize and the
//! encode below are the ones every rendition already goes through, and a panorama differs only in
//! where its base came from.

use crate::job::{Base, Cutting, Job};
use serde::Deserialize;

/// What a job carrying a composite wants done with its sources, and what that needs.
#[derive(Deserialize)]
#[serde(
    tag = "want",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Want {
    /// Search the sources for a recipe and report it. Renders nothing.
    Align,
    /// Search the sources for an assembly's recipe (§3), writing the seam volume its tiles are
    /// solved over to `volume_path`. Renders nothing.
    Analyse { volume_path: String },
    /// Composite the recipe into this job's targets.
    Render { recipe: CompositeRecipe },
    /// Solve `recipe`'s seams for each of `picks` in place of its own, over the volume at
    /// `volume_path`. Renders nothing.
    Seams {
        recipe: Box<crate::assembly::Assembly>,
        volume_path: String,
        picks: Vec<Vec<usize>>,
    },
}

/// The recipe a render is handed, which is a panorama's geometry or an assembly's tiles over one.
///
/// Tagged by the same `kind` field the TypeScript union already carries, rather than tried in turn:
/// an assembly is a superset of a composition, so an untagged enum would read a plain panorama as
/// an assembly the day any of the tile fields gained a `#[serde(default)]`.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CompositeRecipe {
    Panorama(crate::composition::Composition),
    Assembly(Box<crate::assembly::Assembly>),
}

impl CompositeRecipe {
    /// The geometry both kinds share - the levels-and-colour half of [`base`] reads only this,
    /// whichever arm it was handed.
    pub fn composition(&self) -> &crate::composition::Composition {
        match self {
            CompositeRecipe::Panorama(spec) => spec,
            CompositeRecipe::Assembly(assembly) => &assembly.spec,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompositionSource {
    pub photo_id: String,
    pub raw_file_path: String,
    /// A copy of this camera's own preview to search instead of opening the RAW for one
    /// (`composite_align::AlignSource::preview_path`). Never read by a render, which needs the pixels.
    #[serde(default)]
    pub preview_path: Option<String>,
    #[serde(default)]
    pub photo_analysis: Option<Vec<u8>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompositeJob {
    /// Every photograph the composite is made of, in the recipe's own order.
    pub sources: Vec<CompositionSource>,
    #[serde(flatten)]
    pub want: Want,
}

/// The largest a panorama is rendered at, on its long edge.
///
/// The encoder wants a whole frame in memory, and a 400MP composite is 2.4GB of one. The loupe and
/// the DNG export read the canvas at its own resolution through the window path instead, neither
/// of which ever holds it whole.
pub const MAX_LONG_EDGE: u32 = 16384;

/// What one strip of the canvas may hold on the device.
///
/// The strip is what bounds the memory: one strip's blend, the one layer being added to it and one
/// source's region are all that is resident, whatever the canvas is.
const STRIP_BUDGET_BYTES: f64 = 512.0 * 1024.0 * 1024.0;

/// Bytes a strip holds per output pixel: the layer being gathered - three 16-bit samples and the
/// weight beside them - and the blend's accumulator, its alpha and the strip it resolves into.
///
/// **Not per source.** `composite_tile::Blending` adds each layer and gives it back, so what a tile
/// costs is its own pixels however many photographs reach it. Multiplied by the source count, as
/// it was while a blend was handed every layer at once, a twenty-six frame pan took 180 rows a
/// strip where 910 fit - and every one of those strips decodes every source that reaches it.
const STRIP_BYTES_PER_PIXEL: f64 = 10.0 + 16.0 + 4.0 + 6.0;

/// How many points of a source's border are projected to find the shape it covers.
const SHAPE_STEPS: usize = 8;

/// Where a tile's pixels land in the canvas: `(from, to, bytes)` runs of the two buffers.
///
/// One run where the tile spans the whole width, its rows being consecutive in the canvas as well
/// as in itself; a run per row otherwise. **Every offset and length is a whole number of words by
/// construction** - six bytes a pixel, and both the canvas's width and the tile's are even - which
/// is what `copy_buffer_to_buffer` requires and does not check.
fn tile_runs(
    width: usize,
    left: usize,
    top: usize,
    wide: usize,
    deep: usize,
) -> Vec<(u64, u64, u64)> {
    crate::resident::runs(width, left, top, wide, deep)
}

/// The shape one source covers on the canvas, as its width over its height.
///
/// The reference's, walked round its border rather than cornered: the sources of a pan are one
/// body's frames at one focal length, so any of them stands for the set, and a projection bows the
/// edges between the corners.
fn source_shape(spec: &crate::composition::Composition) -> Option<f64> {
    let source = spec.sources.get(spec.reference)?;
    let (across, down) = (source.size[0] as f64, source.size[1] as f64);
    let mut low = [f64::MAX; 2];
    let mut high = [f64::MIN; 2];
    for step in 0..=SHAPE_STEPS {
        let along = step as f64 / SHAPE_STEPS as f64;
        for (x, y) in [
            (along * across, 0.0),
            (along * across, down),
            (0.0, along * down),
            (across, along * down),
        ] {
            let ray = crate::composition::source_to_ray(source, x, y);
            let Some(on) = crate::composition::ray_to_canvas(spec, ray) else {
                continue;
            };
            for (axis, value) in on.iter().enumerate() {
                low[axis] = low[axis].min(*value);
                high[axis] = high[axis].max(*value);
            }
        }
    }
    let (wide, tall) = (high[0] - low[0], high[1] - low[1]);
    (wide > 0.0 && tall > 0.0).then_some(wide / tall)
}

/// The tile a canvas is composited in, in the render's own pixels.
///
/// **A budget, not a count.** Every source that reaches a tile is decoded for it, and a region
/// decode costs what the whole photograph costs - measured at 60ms against the 2ms its pixels then
/// take to gather - so the tiles are the multiplier on the expensive part. Its area is therefore
/// whatever the device will hold, and its *shape* is the only thing left to choose.
///
/// **And the shape to choose is one source's, not the canvas's.** How many tiles a source is
/// decoded for is `(w/W + 1)(h/H + 1)` over its own footprint, so the whole set costs
/// `N + A_w/W + A_h/H` plus a term in `W·H` that the budget already fixes - and minimising that
/// under `W·H = B` gives `W/H = A_w/A_h`, which for one body's frames is the shape of any one of
/// them. The picture being composed does not enter it except as a bound: a tile taller than the
/// canvas has spent its budget on rows that do not exist, so what a clamp takes off one axis is
/// handed to the other.
///
/// A pan is shot in portrait, so this lands on tall narrow tiles - full-height columns once the
/// canvas is shorter than the shape asks for, which is every single-row pan. A pan of several rows
/// is squarer and gets squarer tiles, which is the case a fixed axis would have got wrong.
fn tile_of(spec: &crate::composition::Composition, width: usize, height: usize) -> (usize, usize) {
    let budget = (STRIP_BUDGET_BYTES / STRIP_BYTES_PER_PIXEL).max(1.0);
    let shape = source_shape(spec)
        .filter(|shape| shape.is_finite() && *shape > 0.0)
        .unwrap_or(1.0);
    // W/H = shape and W*H = budget, then each axis clamped and the slack given back to the other.
    let mut across = (budget * shape).sqrt().min(width as f64);
    let down = (budget / across.max(1.0)).min(height as f64);
    across = (budget / down.max(1.0)).min(width as f64);
    // Even, because a tile that is not the full width is copied out a row at a time and a frame is
    // two samples to a word: six bytes a pixel stands on a word boundary only for an even count.
    let wide = (across as usize).max(2);
    (wide - wide % 2, (down as usize).max(1))
}

/// Every source's header, and the camera and lens it names.
///
/// Read here rather than carried through the job, since reading one is a tag walk and the job would
/// otherwise restate it. Answered separately from [`sources_of`] because an `AlignSource` borrows
/// these, so they have to outlive it in the caller's own frame.
pub(crate) type Models = Vec<(Option<String>, Option<String>)>;

pub(crate) fn headers_of(pano: &CompositeJob) -> (Vec<Option<crate::header::BbHeader>>, Models) {
    let headers: Vec<Option<crate::header::BbHeader>> = pano
        .sources
        .iter()
        .map(
            |source| match crate::decode_rendered::is_rendered(&source.raw_file_path) {
                true => crate::header::read_rendered(&source.raw_file_path),
                false => crate::header::read_path(&source.raw_file_path),
            },
        )
        .collect();
    let named = |field: &[u8]| {
        let text = crate::header::name(field);
        (!text.is_empty()).then(|| text.to_string())
    };
    let models = headers
        .iter()
        .map(|header| match header {
            Some(header) => (named(&header.camera_model), named(&header.lens_model)),
            None => (None, None),
        })
        .collect();
    (headers, models)
}

/// The sources of a search, as `composite_align` and `assembly_analysis` both want them.
pub(crate) fn sources_of<'a>(
    pano: &'a CompositeJob,
    headers: &'a [Option<crate::header::BbHeader>],
    models: &'a Models,
) -> Result<Vec<crate::composite_align::AlignSource<'a>>, String> {
    let sources: Vec<crate::composite_align::AlignSource<'a>> = pano
        .sources
        .iter()
        .zip(headers)
        .zip(models)
        .map(|((source, header), (camera, lens))| {
            let positive = |value: f32| (value > 0.0).then_some(value);
            crate::composite_align::AlignSource {
                photo_id: &source.photo_id,
                path: &source.raw_file_path,
                preview_path: source.preview_path.as_deref(),
                analysis: source.photo_analysis.as_deref(),
                size: header
                    .as_ref()
                    .map_or([0, 0], |h| [h.width as usize, h.height as usize]),
                camera_model: camera.as_deref(),
                lens_model: lens.as_deref(),
                focal_length: header.as_ref().and_then(|h| positive(h.focal)),
                focal_px: header.as_ref().and_then(|h| {
                    focal_in_pixels(
                        crate::header::name(&h.camera_make),
                        camera.as_deref().unwrap_or_default(),
                        positive(h.focal)?,
                        h.width.max(h.height) as f64,
                    )
                }),
                shutter: header.as_ref().and_then(|h| positive(h.shutter)),
                aperture: header.as_ref().and_then(|h| positive(h.aperture)),
                iso: header.as_ref().and_then(|h| positive(h.iso)),
            }
        })
        .collect();
    if sources.iter().any(|source| source.size == [0, 0]) {
        return Err("a source of this composite could not be read at all".into());
    }
    Ok(sources)
}

/// A set of photographs searched for the recipe that composites them (`Want::Align`).
pub fn align(gpu: &'static crate::gpu::Gpu, pano: &CompositeJob) -> Result<String, String> {
    let (headers, models) = headers_of(pano);
    let sources = sources_of(pano, &headers, &models)?;

    let aligned = pollster::block_on(crate::composite_align::align(
        gpu,
        &sources,
        crate::composite_solve::Leash::Free,
        crate::composite_align::Kind::Pan,
    ))?;
    let named = |indices: &[usize]| -> Vec<String> {
        indices
            .iter()
            .filter_map(|&i| sources.get(i))
            .map(|s| s.photo_id.to_string())
            .collect()
    };
    // The recipe and what the align has to say about it. By photograph rather than by position:
    // the caller named these sources by id and has no list to index back into.
    serde_json::to_string(&serde_json::json!({
        "recipe": aligned.composition,
        "rmsPx": aligned.rms_px,
        "dropped": named(&aligned.dropped),
        "lensless": named(&aligned.lensless),
        "warnings": aligned.warnings,
    }))
    .map_err(|error| error.to_string())
}

/// The white and peak the whole panorama is coded against.
///
/// **One white for the set, and it has to be the set's own.** Coding every source against a single
/// white is what makes them one picture rather than a strip of separately-graded ones, but taking
/// that white from the reference frame alone exposes the whole canvas as though it were that frame.
/// Measured on a twenty-six frame pan whose reference is its dark, tree-heavy left end, against a
/// normal render of the same band of the same photograph: 1.5x the light, highlights at 0.94 where
/// the render leaves them at 0.69, and chromaticity matching to within 0.005 - so nothing was
/// tinted, the sky simply had its modelling squeezed out at the top.
///
/// **A composite of the cameras' own pictures is not measured at all**, which is the whole of
/// [`camera_levels`]: those frames arrive with a white already in them.
///
/// A composite of the photographs themselves is measured, off what the catalogue kept about each or
/// off a bounded decode - a thousand pixels on the long edge, which is a quantile over a million
/// samples and answers in a fraction of what one strip costs. Once for the job rather than once per
/// strip.
fn whole_levels(
    gpu: &'static crate::gpu::Gpu,
    job: &Job,
    spec: &crate::composition::Composition,
    files: &[crate::composite_tile::SourceFile<'_>],
    from: crate::composite_tile::From,
    stacked: Option<&crate::resident::Resident>,
) -> Result<Option<crate::tone::Anchored>, String> {
    if files.len() != spec.sources.len() {
        return Err("the recipe and the files it is being rendered from disagree".into());
    }
    if from == crate::composite_tile::From::Camera {
        return camera_levels(files).map(Some);
    }
    // **The canvas's own quantile, over the canvas's own samples.** Every alternative here is a
    // statistic of statistics: combining the sources' own whites cannot know how much of the
    // picture each of them is, and no combination of per-frame quantiles is the quantile of what
    // they add up to. Measured on the twenty-six frame pan, the frames' own whites run from 367 to
    // 8114 - the top row is sky and the bottom is city and trees - so which of them a combination
    // lands on decides the exposure of the whole canvas, and the peak taken as the largest of
    // theirs came off a dark frame that caught a specular and set a roll-off no frame needed.
    if let Some(levels) = stacked.and_then(|stacked| union_levels(gpu, job, stacked)) {
        return Ok(Some(levels));
    }
    let mut measured = Vec::with_capacity(files.len());
    for (source, file) in spec.sources.iter().zip(files) {
        // **A source's own measurement is of its own light**, and `SourceSpec::gain` is what carries
        // that light onto the reference's scale - so its estimate of the shared white is its white
        // times its gain. Where the gains are right those estimates agree; what they disagree about
        // is content, and the mean over the set is the average the whole canvas has.
        let scaled = |levels: crate::tone::Levels| crate::tone::Levels {
            white: crate::light::Light::measured(levels.white.raw() * source.gain),
            peak: crate::light::Light::measured(levels.peak.raw() * source.gain),
            floor: levels
                .floor
                .map(|f| crate::light::Light::measured(f.raw() * source.gain)),
        };
        if let Some(levels) = file
            .analysis
            .and_then(|a| a.from_render.levels)
            .and_then(|m| m.levels_at(job.grade.white_quantile))
        {
            measured.push(scaled(levels));
            continue;
        }

        const MEASURED_LONG_EDGE: u32 = 1024;
        let frame = crate::decode::frame_from_path(
            file.path,
            job.detail(),
            MEASURED_LONG_EDGE,
            false,
            crate::galosh::Fit::Measure,
            crate::dust::Wanted::Off,
        )
        .ok_or("a source could not be decoded to measure its levels")?;
        let resident = frame
            .on_device(gpu)
            .ok_or("a source could not be read onto the device")?;
        let levels = pollster::block_on(crate::fit_source::levels(
            gpu,
            &resident,
            job.grade.white_quantile,
        ))
        .ok_or("a source's levels could not be measured")?;
        measured.push(scaled(levels));
    }
    let anchor = crate::composite_tile::combined(&measured);
    if std::env::var_os("PANO_TRACE").is_some() {
        let whites: Vec<String> = measured
            .iter()
            .map(|l| format!("{:.0}", l.white.raw()))
            .collect();
        let peaks: Vec<String> = measured
            .iter()
            .map(|l| format!("{:.0}", l.peak.raw()))
            .collect();
        println!("  source whites: {}", whites.join(" "));
        println!("  source peaks:  {}", peaks.join(" "));
        if let Some(anchor) = anchor {
            println!(
                "  anchor: white {:.0} peak {:.0}",
                anchor.white.raw(),
                anchor.peak.raw()
            );
        }
    }
    Ok(anchor)
}

/// The levels a composite of the cameras' own pictures is coded against: theirs, unmeasured.
///
/// **The camera already graded these frames, and a second grade over the first is what a measured
/// white would be.** Coded against the white their transfer puts white at, a source renders as the
/// picture the body wrote - pinned to the code value by
/// `a_composite_of_a_camera_s_picture_is_that_picture`. Coded against a quantile of the set
/// instead, the whole canvas is lifted to meet a white its sources never had: measured on the
/// twenty-six frame pan, the set's own 0.9 quantile is 0.65 of full scale, so the tile came back
/// with its 98th percentile at 0.96 where the picture the viewer opens leaves it at 0.83 - a sky
/// with its modelling flattened out of the top.
///
/// The peak is full scale, which is where a finished picture's highlights stop. So nothing rolls
/// off for an SDR target and a gain-mapped source rolls off from its own headroom, both of which
/// are what the container says rather than anything measured.
///
/// The lowest white where the sources disagree - a set of one body and one format has one white,
/// and if two of them do not then the canvas has no scale on which both are the picture they were;
/// the lowest is the one on which neither clips.
fn camera_levels(
    files: &[crate::composite_tile::SourceFile<'_>],
) -> Result<crate::tone::Anchored, String> {
    let mut white = crate::light::Light::measured(f64::MAX);
    for file in files {
        white = white.min(crate::composite_tile::camera_white(file.path)?);
    }
    Ok(crate::tone::Levels {
        white,
        peak: crate::light::Light::measured(crate::transfer::FULL_SCALE),
        // Unmeasured, like the two above: nothing walked a histogram for this canvas, so the low
        // tone pair sit where a picture with black in it puts them.
        floor: None,
    }
    .anchored())
}

#[cfg(test)]
thread_local! {
    /// How many times `stacked_sources` has run on this thread, so a test can say the stack was
    /// *skipped* rather than that two passes agreed - which they would either way, this being
    /// deterministic.
    ///
    /// Per thread rather than per process because the harness runs four at once
    /// (`.cargo/config.toml`) and several of the tests in this file stack a set: a process-wide
    /// counter would be moved under the one test reading it by whichever of its neighbours
    /// happened to be running.
    static STACKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Every source, decoded and reduced, stacked into one frame to be measured over.
///
/// **Every source, and the reduction is what makes that affordable.** `frame_from_path` serves the
/// smallest size it *can* rather than the size asked for, and for a 24MP body that is half -
/// 2000x3000, 36MB of samples, and 940MB for a set of twenty-six. Reduced first, a frame is 4MB
/// whatever the sensor was, so the stack is about a hundred for any set and any body: the cost stops
/// depending on the camera, which is what lets this read the whole set rather than a sample of it.
///
/// `base::resize_scene` is the reduction, and the *scene* half of that name is the whole of why it
/// rather than the other one: these frames are the decode's own samples, which are already light,
/// where `base::resize` is for a frame the coding has been through.
///
/// **The samples each source decoded to, ahead of its own gain.** A gain is applied where the
/// canvas is gathered, so what is measured here is a quantile of the set as the bodies exposed it
/// rather than of the set as it is blended - an approximation, and a close one for the gains an
/// alignment produces, which sit within a stop of each other because the frames are of one scene.
/// Carrying them would mean a gain per row of the stack, in `fit_source::levels`, which is where
/// this would go if a set ever arrived metered far enough apart to see it.
///
/// Stacked rather than laid out where each source falls on the canvas, because neither a quantile
/// nor a colour fit cares where a sample sat - only which samples there were. The overlaps counting
/// twice moves nothing that a tenth of the picture sits above.
fn stacked_sources(
    gpu: &'static crate::gpu::Gpu,
    base: &'static crate::base::Base,
    job: &Job,
    files: &[crate::composite_tile::SourceFile<'_>],
) -> Option<crate::resident::Resident> {
    /// The long edge each source is reduced to before it joins the stack.
    const REDUCED_TO: usize = 1024;
    const DECODED_AT: u32 = 1024;

    #[cfg(test)]
    STACKS.with(|stacks| stacks.set(stacks.get() + 1));

    let mut parts: Vec<crate::resident::Resident> = Vec::with_capacity(files.len());
    for file in files {
        let frame = crate::decode::frame_from_path(
            file.path,
            job.detail(),
            DECODED_AT,
            false,
            crate::galosh::Fit::Measure,
            crate::dust::Wanted::Off,
        )?;
        let resident = frame.on_device(gpu)?;
        let (wide, tall) = resident.size();
        let long = wide.max(tall);
        // Already at or under the size wanted, which a small embedded picture can be: taken as it
        // is rather than enlarged, since `resize` declines that and inventing detail would be
        // wrong anyway.
        let reduced = match long > REDUCED_TO {
            false => resident.duplicate(),
            true => {
                let scale = REDUCED_TO as f64 / long as f64;
                let out = (
                    (wide as f64 * scale) as usize,
                    (tall as f64 * scale) as usize,
                );
                // Even, because a frame is two samples to a word and a stacked part has to start
                // on one.
                let out = (out.0 & !1, out.1 & !1);
                crate::base::resize_scene(gpu, base, &resident, out)?
            }
        };
        parts.push(reduced);
    }

    let (wide, _) = parts.first()?.size();
    if wide == 0 || parts.iter().any(|part| part.size().0 != wide) {
        return None;
    }
    let tall: usize = parts.iter().map(|part| part.size().1).sum();
    let stacked = crate::resident::Resident::empty(gpu, wide, tall);
    let mut recording = gpu.record();
    let mut at = 0u64;
    for part in &parts {
        recording.encoder().copy_buffer_to_buffer(
            part.buffer(),
            0,
            stacked.buffer(),
            at,
            (part.words() * 4) as u64,
        );
        at += (part.words() * 4) as u64;
    }
    recording.submit();
    for part in parts {
        part.reclaim();
    }
    Some(stacked)
}

/// The levels of every source's samples taken together, measured once.
///
/// **A stand-in for the canvas rather than the canvas itself, and it has to be.** The composite is
/// what should be measured, but the strips are *coded* against these levels before it exists -
/// `Base::levels` is one pair for both jobs, the frame's own and the one its samples were coded
/// against - so a measurement of the finished canvas would arrive a pass too late. What is
/// available beforehand is every source, and a bounded decode of each is a thousand pixels on the
/// long edge: stacked, that is the canvas's content at a coarse scale, which is all a quantile
/// needs. Twenty-six of those decodes cost about what one strip does, once for the job.
///
/// Stacked rather than laid out where each source actually falls, because a quantile does not care
/// where a sample was: what it needs is every sample once, and the overlaps counting twice moves
/// nothing that a tenth of the picture sits above.
///
/// None where the sources do not share a width - a set shot on two bodies - and the caller then
/// combines their own levels instead.
fn union_levels(
    gpu: &'static crate::gpu::Gpu,
    job: &Job,
    stacked: &crate::resident::Resident,
) -> Option<crate::tone::Anchored> {
    let levels = pollster::block_on(crate::fit_source::levels(
        gpu,
        stacked,
        job.grade.white_quantile,
    ))?;
    Some(levels.anchored())
}

/// The colour the bodies would have rendered, fitted over every source's samples at once.
///
/// **A panorama is one photograph, so its colour rendering is one fit.** Everything after the
/// demosaic that is about the *picture* rather than about a sensor already runs on the composite -
/// the grade, the roll-off, the sharpen - and this belongs with them. The reference frame's own
/// match carried forward to stand for all of them grades a row of sky through the curves fitted to
/// a frame of trees, and pairs a match with levels it was not fitted against. Measured on the
/// twenty-six frame pan, that pairing leaves the composite correctly coloured and a stop under.
///
/// Fitted over the sources stacked rather than over the finished canvas, for the reason
/// [`union_levels`] is: the strips are coded before the canvas exists. A colour fit does not care
/// where a sample sat, only which samples there were, so the two are the same fit - and it is the
/// same stack, against the same levels, so the match and the anchor finally describe one picture.
///
/// The geometry half of a match is not fitted here at all. Every source's lens was gathered by the
/// recipe on the way onto the canvas, so the composite has none left to correct and carries
/// [`crate::fit::Lens::none`], which is what the reference's match was already reduced to.
fn union_match(
    gpu: &'static crate::gpu::Gpu,
    job: &Job,
    files: &[crate::composite_tile::SourceFile<'_>],
    stacked: &crate::resident::Resident,
) -> Option<crate::hdr_fit::HdrMatch> {
    const FITTED_ON: usize = 1024;

    // The camera's own pictures, stacked the same way: the fit reads the pair as one scene, and
    // what it compares is the content rather than the arrangement of it.
    let mut theirs: Vec<crate::rgb::Rgb> = Vec::with_capacity(files.len());
    for file in files {
        theirs.push(crate::decode_rawler::upright_preview_rgb(
            file.path,
            FITTED_ON,
            crate::decode_rawler::Preview::for_the_match(),
        )?);
    }
    // Each stack has to be square, so a set whose cameras embed previews of different widths
    // declines rather than stacking a ragged one. The two stacks need not match *each other* -
    // `fit_source::prepared` resizes ours to whatever the preview's own fitted width is.
    let across = theirs.first()?.width;
    if across == 0 || theirs.iter().any(|camera| camera.width != across) {
        return None;
    }
    if std::env::var_os("PANO_TRACE").is_some() {
        println!(
            "  union match over {} sources: ours {}x{}, theirs {across}x{}",
            files.len(),
            stacked.size().0,
            stacked.size().1,
            theirs.iter().map(|camera| camera.height).sum::<usize>(),
        );
    }

    let deep: usize = theirs.iter().map(|camera| camera.height).sum();
    let mut bytes = Vec::with_capacity(across * deep * 3);
    for camera in &theirs {
        bytes.extend_from_slice(&camera.data);
    }
    let preview = crate::rgb::Rgb {
        data: bytes.into(),
        width: across,
        height: deep,
    };

    let (tw, _) = crate::hdr_fit::fitted_preview_size(preview.width, preview.height);
    let prepared = pollster::block_on(crate::fit_source::prepared(
        gpu,
        stacked,
        tw,
        job.grade.white_quantile,
    ))?;
    let (wide_jpeg, _) = pollster::block_on(crate::hdr_fit::preview_planes(gpu, &preview))?;
    let matched = pollster::block_on(crate::hdr_fit::fit_linearised(
        gpu,
        &prepared.plane,
        prepared.levels.white,
        wide_jpeg,
        crate::fit::Lens::none(),
    ))?;
    Some(crate::hdr_fit::HdrMatch {
        lens: crate::fit::Lens::none(),
        colour: matched.colour,
    })
}

/// A focal length in millimetres as the pinhole focal in a photograph's own pixels.
///
/// The sensor's width is the crop factor's: lensfun knows what body wrote the file, and 35mm is
/// 36mm across. None where it has never heard of the body, and the alignment then does what it can
/// with an assumed field of view.
///
/// The long edge, since that is the axis 36mm measures - a portrait frame is the same sensor
/// turned, and its long edge is still the sensor's long one.
fn focal_in_pixels(make: &str, model: &str, millimetres: f32, long_edge: f64) -> Option<f64> {
    const FULL_FRAME_MM: f64 = 36.0;
    let crop = crate::lensfun::crop_factor(make, model)?;
    Some(f64::from(millimetres) * crop * long_edge / FULL_FRAME_MM)
}

/// The rectangle two of them share, or None where they share none.
fn overlap(
    a: crate::px::Rect<crate::px::Composite>,
    b: crate::px::Rect<crate::px::Composite>,
) -> Option<crate::px::Rect<crate::px::Composite>> {
    let (al, at, aw, ah) = a.raw();
    let (bl, bt, bw, bh) = b.raw();
    let left = al.max(bl);
    let top = at.max(bt);
    let right = (al + aw).min(bl + bw);
    let bottom = (at + ah).min(bt + bh);
    (right > left && bottom > top)
        .then(|| crate::px::Rect::exact(left, top, right - left, bottom - top))
}

/// The composite this job's targets are cut from, at the largest of the sizes they asked for.
///
/// Strip by strip, and each strip source by source: nothing here is ever as large as the canvas
/// except the buffer being written, which is the target's own size rather than the canvas's.
pub(crate) fn base(
    job: &Job,
    sources: &[CompositionSource],
    wanted: &CompositeRecipe,
    size: u32,
    from: crate::composite_tile::From,
    window: Option<crate::px::Rect<crate::px::Composite>>,
    // The parts of `window` the caller asked for, or empty for the whole of it.
    // `composite_tile::CompositeRequest::parts` says what they buy.
    parts: &[crate::px::Rect<crate::px::Composite>],
) -> Result<Base, String> {
    let mut lap = crate::clock::laps("  panorama ");
    let spec = wanted.composition();
    if spec.sources.len() != sources.len() {
        return Err("the recipe and the files it names disagree".into());
    }
    let refused = || crate::base::without_a_device("the composite's stages");
    let gpu = crate::gpu::device().ok_or_else(refused)?;

    let (canvas_w, canvas_h, scale) = sized(spec, size);
    // **The buffer is the window's, the picture is the canvas's, and the two are different
    // numbers from here on.** A rendition asks for the whole thing and so the two agree; a
    // reader zoomed into a ladder asks for the rectangle their stage can hold, and everything
    // the grade is anchored to - the geometry, the sharpen's scale, the presence sliders' reach -
    // is still the canvas's.
    let asked = window.unwrap_or_else(|| crate::px::Rect::exact(0, 0, canvas_w, canvas_h));
    let (window_left, window_top, width, height) = asked.raw();
    if width == 0 || height == 0 || window_left + width > canvas_w || window_top + height > canvas_h
    {
        return Err(format!(
            "a {width}x{height} window at {window_left},{window_top} is not inside a \
             {canvas_w}x{canvas_h} picture",
        ));
    }
    // **Even across, and it is the buffer that needs it rather than the picture.** A tile narrower
    // than the window is copied into it a row at a time (`tile_runs`) and a frame is two samples to
    // a word, so six bytes a pixel stands on a word boundary only for an even count - an odd stride
    // starts every second row half a word along and shears the picture's colour.
    if width % 2 != 0 || window_left % 2 != 0 {
        return Err(format!(
            "a window is asked for in even columns, and this one is {width} wide at {window_left}",
        ));
    }
    let analyses: Vec<Option<crate::photo_analysis::PhotoAnalysis>> = sources
        .iter()
        .map(|source| {
            source
                .photo_analysis
                .as_deref()
                .and_then(crate::photo_analysis::decode)
        })
        .collect();
    let files: Vec<crate::composite_tile::SourceFile<'_>> = sources
        .iter()
        .zip(&analyses)
        .map(|(source, analysis)| crate::composite_tile::SourceFile {
            path: &source.raw_file_path,
            analysis: analysis.as_ref(),
        })
        .collect();

    // A camera's JPEG is read whole whatever tile wants it, so the sources of this canvas are
    // decoded once between them rather than once per tile they reach - and go with this value
    // rather than being left in a worker that has finished (`composite_tile::CameraPictures`).
    let _pictures = crate::composite_tile::CameraPictures::fresh();
    // Zeroed by the device, which is what a tile no photograph reaches is left as.
    let whole = crate::resident::Resident::empty(gpu, width, height);
    let (across, down) = tile_of(spec, width, height);
    // The levels below, then a tile at a time. Every tile costs about the same - the same pixels of
    // the same canvas, gathered from whichever sources reach them - so a count of them is the
    // honest measure of how far through this is.
    crate::progress::begin(1 + width.div_ceil(across) * height.div_ceil(down));
    // **Once, before the first strip, and the same for every one of them.** A strip measuring its
    // own diffuse white is coded against the sky where it holds sky and against a headland where
    // it holds one, and the joins between them are bands across the finished picture - which is
    // exactly what a loupe tile is forbidden from doing for the same reason.
    let known = job.stored();
    let stamp = spec.set_stamp();
    let filed = match from {
        // **Only what this set measured.** These are a quantile and a colour fit over every source
        // at once, so a recipe whose sources or gains changed under the same photograph measured
        // something else - and the quantile alone cannot tell the two apart.
        crate::composite_tile::From::Original if known.from_render.set == Some(stamp) => {
            // The quantile is the one setting either measure is sensitive to, and the match
            // carries no stamp of its own - so what licenses reusing it beside these levels is
            // that the pass which filed them is the pass that fitted it.
            known
                .from_render
                .levels
                .and_then(|m| m.levels_at(job.grade.white_quantile))
        }
        crate::composite_tile::From::Original => None,
        // Never the camera arm's, whose white is the transfer's rather than a quantile of this
        // picture (`camera_levels`) - and which files nothing, for that reason.
        crate::composite_tile::From::Camera => None,
    };
    // **The set's samples, once, for both measures that read them**, and not at all for an answer
    // already on file: this is a reduced decode of every source, so it is the expensive half of a
    // composite and the half a pan pays on every render and every open of it.
    let stacked = match (from, filed) {
        (crate::composite_tile::From::Original, None) => {
            crate::base::device(gpu).and_then(|base| stacked_sources(gpu, base, job, &files))
        }
        _ => None,
    };
    let measured = match filed {
        Some(levels) => {
            crate::progress::advance();
            Ok((Some(levels.anchored()), known.from_raw.matched.clone()))
        }
        // The stack goes back below even where this failed, which is a source that would not
        // decode - and is exactly when the buffer would otherwise be dropped without the nudge
        // `reclaim` gives the device (`resident::Resident::reclaim`).
        None => whole_levels(gpu, job, spec, &files, from, stacked.as_ref()).map(|levels| {
            crate::progress::advance();
            // **One picture, one colour rendering.** Fitted over every source at once rather than
            // taken from the reference frame, which is what the rest of the pipeline after the
            // demosaic already does with the grade and the roll-off: `union_match` says why.
            (
                levels,
                stacked
                    .as_ref()
                    .and_then(|stacked| union_match(gpu, job, &files, stacked)),
            )
        }),
    };
    if let Some(stacked) = stacked {
        stacked.reclaim();
    }
    let (levels, matched) = measured?;
    if std::env::var_os("PANO_TRACE").is_some() {
        println!(
            "  levels {:?}, colour {}",
            levels.map(|l| (l.white.raw(), l.peak.raw())),
            match matched.is_some() {
                true => "fitted over the set",
                false => "the reference's, or none",
            }
        );
    }
    let mut fallback_match = None;
    let mut as_shot = None;
    let mut wb_gains = None;
    // An assembly's two bands are taken against a lowpass over the whole crop, so it is built once
    // for the render and sliced by every strip: per strip it would truncate at each strip's own
    // edge and draw a seam with no image seam under it (`assembly_render::lowpass`). Deferred to
    // the first strip that asks, which is where a request to build it from exists.
    let mut hold: Option<crate::assembly_render::Lowpass> = None;
    let drawn = match wanted {
        CompositeRecipe::Assembly(assembly) => Some(assembly.rendered()?),
        CompositeRecipe::Panorama(_) => None,
    };
    let mut top = 0;
    while top < height {
        let deep = down.min(height - top);
        let mut left = 0;
        while left < width {
            let wide = across.min(width - left);
            // The canvas's own coordinate, where `tile_runs` below stays in the buffer's: a
            // window's tile is somewhere else in the picture than it is in the buffer, and the
            // gather has to be told the first.
            let strip = crate::px::Rect::exact(window_left + left, window_top + top, wide, deep);
            // **The caller's parts clipped to this strip**, so a source is decoded for the parts
            // of it that are actually here. This assembly walks the window in strips of its own
            // sizing, which for a tile fetch is one strip and for a rendition is many - and a
            // strip holding none of the parts is one nothing asked for.
            let here: Vec<crate::px::Rect<crate::px::Composite>> = parts
                .iter()
                .filter_map(|part| overlap(*part, strip))
                .collect();
            if !parts.is_empty() && here.is_empty() {
                left += wide;
                crate::progress::advance();
                continue;
            }
            let request = crate::composite_tile::CompositeRequest {
                window: strip,
                parts: &here,
                scale,
                white_quantile: job.grade.white_quantile,
                levels,
                reference_white_nits: job.grade.reference_white_nits,
                strengths: job.strengths(),
                detail: job.detail(),
                sources: &files,
                from,
                mask: None,
            };
            // **A tile of a canvas can hold no photograph at all.** The canvas is framed to what
            // the sources cover between them, and a hand-held pan leaves wedges of nothing at its
            // corners - which a full-width strip always crossed a source somewhere in, and a tile
            // does not. Left as the zeros it was allocated with, and the rendition's own crop is
            // what trims them off (§19.4).
            if !crate::composite_tile::covered(spec, &request) {
                left += wide;
                crate::progress::advance();
                continue;
            }
            let (tile, prepared) = match &drawn {
                None => pollster::block_on(crate::composite_tile::prepared(spec, &request))?,
                Some(assembly) => {
                    let held = match &hold {
                        Some(held) => held,
                        None => hold.insert(pollster::block_on(crate::assembly_render::lowpass(
                            assembly, &request,
                        ))?),
                    };
                    pollster::block_on(crate::assembly_render::prepared(assembly, held, &request))?
                }
            };
            let mut recording = gpu.record();
            {
                let encoder = recording.encoder();
                for (from, to, bytes) in tile_runs(width, left, top, wide, deep) {
                    encoder.copy_buffer_to_buffer(tile.buffer(), from, whole.buffer(), to, bytes);
                }
            }
            recording.submit();
            tile.reclaim();
            as_shot = as_shot.or(prepared.as_shot);
            wb_gains = wb_gains.or(prepared.wb_gains);
            // Only where the composite's own fit declined: `union_match` is the colour this picture
            // is graded through, and the reference's is the fallback.
            fallback_match = fallback_match.or_else(|| {
                prepared.matched.map(|m| crate::hdr_fit::HdrMatch {
                    lens: crate::fit::Lens::none(),
                    colour: m.colour,
                })
            });
            left += wide;
            crate::progress::advance();
            lap("tile");
        }
        top += deep;
    }

    // **The reference photograph's, and only where the composite is of the photographs.** What a
    // stored analysis describes is a render of a RAW - the blur that decode carries, the peak that
    // render rolled off against - and none of it is true of the cameras' own pictures, which come
    // out of a body that already answered all of it. Same reasoning as the match beside it.
    let reference = match from {
        crate::composite_tile::From::Original => analyses
            .get(spec.reference)
            .and_then(|a| a.clone())
            .unwrap_or_default(),
        crate::composite_tile::From::Camera => crate::photo_analysis::PhotoAnalysis::default(),
    };
    let anchored = levels.ok_or("this composite has no levels to grade against")?;
    // **The reference frame's balance, from whichever tile reached it, or from what the last pass
    // filed.** A window of a coarse level decodes only the sources that reach it, so a rectangle
    // away from the reference never sees the frame these come off - and both are the *reference's*
    // for the whole canvas, not the window's. Filed below, which is what makes the second reach
    // free (`photo_analysis::FromRaw::balance`).
    // Each half on its own, rather than the pair together: a source with no usable multipliers
    // has gains and no illuminant, so a window that reached such a frame would otherwise let its
    // absent illuminant stand in for one the file does name.
    let as_shot = as_shot.or_else(|| known.from_raw.balance.and_then(|kept| kept.as_shot));
    let wb_gains = wb_gains.or_else(|| known.from_raw.balance.map(|kept| kept.wb_gains));
    let balance = wb_gains.map(|wb_gains| crate::photo_analysis::Balance { wb_gains, as_shot });
    // **The composite's own, which is what makes it a photograph the rest of the pipeline can ask
    // about.** Everything measured over the whole set goes here - the union levels the canvas was
    // coded against and the union colour it is graded through - and the per-camera half comes from
    // the reference, which is the frame `Composition::reference` already says a composite is rendered
    // as.
    //
    // Nothing at all on the camera arm, and that is what keeps the arms apart: its levels are what
    // the bodies printed white at rather than a quantile of this picture, so filing them under
    // this row would be read back by the next composite *of the photographs* as its own.
    let analysis = match from {
        crate::composite_tile::From::Camera => crate::photo_analysis::PhotoAnalysis::default(),
        crate::composite_tile::From::Original => crate::photo_analysis::PhotoAnalysis {
            from_raw: crate::photo_analysis::FromRaw {
                matched: matched.clone().or_else(|| fallback_match.clone()),
                // The reference's: no single fit describes a blend.
                noise: reference.from_raw.noise,
                // A composite looks for no particles. Each source's own render corrected its own,
                // and the canvas is past the mosaic a search would have to read.
                dust: None,
                capture_sigma: reference.from_raw.capture_sigma,
                balance,
            },
            from_render: crate::photo_analysis::FromRender {
                levels: Some(crate::photo_analysis::MeasuredLevels {
                    // The pre-anchor pair, which is what the store holds: `anchored` only floors a
                    // white below one count, and this picture's is orders above it.
                    levels: *anchored,
                    white_quantile: job.grade.white_quantile,
                }),
                // Filled in by `run` once a frame has been up, as a decode's is.
                scene_peak: None,
                defocus: reference.from_render.defocus,
                set: Some(stamp),
            },
        },
    };
    Ok(Base {
        frame: Cutting::OnDevice(whole),
        width,
        height,
        // The same white every strip was coded against, which is what the grade now anchors to.
        levels: anchored,
        // **The canvas at this scale, not the buffer.** Every consumer of this pair reads it as
        // "the picture the reader's geometry is stated against and the presence sliders reach
        // across", and for a window of a ladder that is still the whole canvas.
        photograph: (canvas_w, canvas_h),
        window: window.map(|_| crate::gpu::Window {
            photograph: crate::px::Size::exact(canvas_w, canvas_h),
            origin: crate::px::At::exact(window_left, window_top),
        }),
        matched: matched.or(fallback_match),
        capture_sigma: analysis.from_raw.capture_sigma,
        analysis,
        // This row's, so the difference `run` reports is against what the composite was handed
        // rather than against one of its frames.
        stored: job.stored(),
        as_shot,
        // The canvas at scale 1, not the reference frame's sensor. `capture_sigma` is in that
        // frame's pixels and the canvas is 1:1 with them, so the canvas is the resolution the blur
        // belongs to - and the only one in the same space as the size a target asks for. One
        // frame's long edge is a fraction of a pan's, which pins `deconvolve_split`'s `k` at 1 and
        // deconvolves a reduced render as though it were native.
        sensor_long: spec.canvas[0].max(spec.canvas[1]),
        // The camera arm measures the bodies' own pictures rather than this canvas, so nothing it
        // found is true of the photograph - the peak `run` is about to read included.
        describes_the_photograph: from == crate::composite_tile::From::Original,
    })
}

/// The size a panorama renders at for a target asking for `size` on its long edge, and how many
/// canvas pixels one of those is.
///
/// Even, because a strip of a frame two samples to a word has to start on a word.
fn sized(spec: &crate::composition::Composition, size: u32) -> (usize, usize, f64) {
    let long = spec.canvas[0].max(spec.canvas[1]) as f64;
    let want = match size {
        0 => long.min(f64::from(MAX_LONG_EDGE)),
        size => f64::from(size).min(long).min(f64::from(MAX_LONG_EDGE)),
    };
    let scale = long / want.max(1.0);
    let even = |value: usize| {
        let scaled = ((value as f64 / scale).round() as usize).max(2);
        scaled - scaled % 2
    };
    (even(spec.canvas[0]), even(spec.canvas[1]), scale)
}

/// What shape a canvas is at `level`, which is the space a window of it is stated in.
///
/// **The server's twin, and what `prepare-levels.txt` holds the two together by.** A client asks
/// for a rectangle of a level and is refused where it is not inside one, so a server rounding the
/// level's own axes differently from this asks for a window two pixels off the end of the picture -
/// and there is nothing in the request that would say which of the two was wrong.
///
/// Not a halving past [`MAX_LONG_EDGE`]: a composite is never assembled larger than that, so the
/// shallow levels of a very wide canvas are all the same shape.
pub fn level_shape(canvas: &[usize; 2], level: u32) -> (usize, usize) {
    let long = canvas[0].max(canvas[1]);
    let spec =
        crate::composition::Composition::of_one(*canvas, crate::composition::LensSpec::none());
    let (width, height, _) = sized(&spec, (long >> level) as u32);
    (width, height)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resident::BYTES_PER_PIXEL;

    fn recipe(canvas: [usize; 2]) -> crate::composition::Composition {
        crate::composition::Composition {
            version: crate::composition::VERSION,
            sources: Vec::new(),
            projection: crate::composition::Projection::Cylindrical,
            canvas,
            centre: [canvas[0] as f64 / 2.0, canvas[1] as f64 / 2.0],
            radians_per_pixel: 1.0 / 5200.0,
            crop: [0.0, 0.0, 1.0, 1.0],
            reference: 0,
            seam_rms_px: None,
        }
    }

    /// A composite of one camera's own picture, pointed straight ahead on a canvas its own size, is
    /// that picture.
    ///
    /// Three claims, and each of them was a whole tile darker than the JPEGs it was made of. The
    /// white is the one the picture arrived with rather than a quantile of it, which is what stops
    /// a source being graded away from its own rendering by however far its content sits from the
    /// set's. No camera match is reported, since a match belongs to a render of a RAW and these
    /// frames are what the body printed - measured on a twenty-six frame pan whose reference was
    /// the one photograph of its library with an analysis, carrying it halved the tile's light. And
    /// the light survives the gather and the blend, which is what the mean holds: the coding round
    /// trip divides its own white back out, so that part is the composite's arithmetic rather than
    /// the anchor's.
    #[test]
    fn a_composite_of_a_camera_s_picture_is_that_picture() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let (wide, tall) = (
            crate::composite_align::tests::WIDE,
            crate::composite_align::tests::TALL,
        );
        let focal = crate::composite_align::tests::FOCAL;
        let paths =
            crate::composite_align::tests::fixtures("camera-identity", &[[1.0, 0.0, 0.0, 0.0]]);
        // A canvas the source's own size, at its own scale, looking along its own axis: the recipe
        // is then the identity, so anything the composite does to the picture is the pipeline's.
        let spec = crate::composition::Composition {
            version: crate::composition::VERSION,
            sources: vec![crate::composition::SourceSpec {
                photo_id: paths[0].clone(),
                size: [wide, tall],
                rotation: [1.0, 0.0, 0.0, 0.0],
                focal,
                lens: crate::composition::LensSpec::none(),
                gain: 1.0,
                warp: crate::composition::no_warp(),
            }],
            projection: crate::composition::Projection::Rectilinear,
            canvas: [wide, tall],
            centre: [wide as f64 / 2.0, tall as f64 / 2.0],
            radians_per_pixel: 1.0 / focal,
            crop: [0.0, 0.0, 1.0, 1.0],
            reference: 0,
            seam_rms_px: None,
        };
        // With a match kept about it, which is the case the composite has to ignore: the whole set
        // is these pictures, and a match belongs to a render of the RAW behind one of them.
        let analysis = crate::photo_analysis::PhotoAnalysis {
            from_raw: crate::photo_analysis::FromRaw {
                matched: Some(crate::photo_analysis::tests::a_match()),
                ..Default::default()
            },
            ..Default::default()
        };
        let files = vec![crate::composite_tile::SourceFile {
            path: &paths[0],
            analysis: Some(&analysis),
        }];

        let levels = camera_levels(&files).expect("a finished picture states its white");
        assert_eq!(levels.white.raw(), crate::transfer::FULL_SCALE);
        assert_eq!(levels.peak.raw(), crate::transfer::FULL_SCALE);

        const ACROSS: usize = 64;
        let request = crate::composite_tile::CompositeRequest {
            window: crate::px::Rect::exact(
                wide / 2 - ACROSS / 2,
                tall / 2 - ACROSS / 2,
                ACROSS,
                ACROSS,
            ),
            // The whole window, which is what an empty list means.
            parts: &[],
            scale: 1.0,
            white_quantile: 0.9,
            levels: Some(levels),
            reference_white_nits: crate::light::Light::exactly(203.0),
            strengths: crate::image::Strengths {
                sharpen: 0.0,
                defringe: 0.0,
            },
            detail: crate::galosh::Detail::at(0.0, 0.0),
            sources: &files,
            from: crate::composite_tile::From::Camera,
            mask: None,
        };
        let (composite, prepared) =
            pollster::block_on(crate::composite_tile::prepared(&spec, &request))
                .expect("a window composites");
        assert!(
            prepared.matched.is_none(),
            "a camera's own picture is not matched to itself"
        );
        // The same window off the photographs themselves does carry it, which is what makes the
        // line above a decision rather than an absence.
        let (rendered, matched) = pollster::block_on(crate::composite_tile::prepared(
            &spec,
            &crate::composite_tile::CompositeRequest {
                from: crate::composite_tile::From::Original,
                ..request
            },
        ))
        .expect("a window composites off the sources");
        rendered.reclaim();
        assert!(
            matched.matched.is_some(),
            "a render of a source is matched to its own body"
        );
        let coded = pollster::block_on(composite.into_host()).expect("the window reads back");

        // The picture itself, over the same rectangle, as the decode hands it over.
        let frame = crate::decode::frame_from_path(
            &paths[0],
            crate::galosh::Detail::at(0.0, 0.0),
            wide as u32,
            false,
            crate::galosh::Fit::Measure,
            crate::dust::Wanted::Off,
        )
        .expect("the fixture decodes");
        let resident = frame
            .on_device(gpu)
            .expect("the fixture reaches the device");
        let source = pollster::block_on(resident.host()).expect("the fixture reads back");

        // The composite is coded, so it comes back through the coding: a level is the nits its code
        // stands for, on the scale `encode_base` put them.
        let reference = 203.0;
        let level_of = |code: u16| {
            crate::tone::pq_inv::<crate::light::SceneNits>(crate::light::Light::measured(
                f64::from(code) / crate::transfer::FULL_SCALE,
            ))
            .raw()
                * levels.white.raw()
                / reference
        };
        let mean = |of: f64, count: usize| of / count as f64;
        let mut ours = 0.0;
        for code in &coded {
            ours += level_of(*code);
        }
        let mut theirs = 0.0;
        let (left, top, _, _) = request.window.raw();
        for y in 0..ACROSS {
            for c in 0..ACROSS * 3 {
                theirs += f64::from(source[((top + y) * wide + left) * 3 + c]);
            }
        }
        let (ours, theirs) = (mean(ours, coded.len()), mean(theirs, coded.len()));
        assert!(
            !coded.iter().any(|code| *code == 0),
            "the composite has holes where the source covers it",
        );
        assert!(
            (ours - theirs).abs() < 0.01 * theirs,
            "the composite reads {ours:.0} where the picture is {theirs:.0}",
        );
    }

    /// A strip is copied into the frame at a word boundary, which is only true if every render's
    /// width is even - and a frame assembled a sample out is a picture with a magenta shear in it.
    #[test]
    fn every_size_a_panorama_renders_at_is_even() {
        for canvas in [[9001, 4001], [12345, 6789], [40000, 9000], [3, 2]] {
            for size in [0, 512, 4096, 100_000] {
                let (width, height, scale) = sized(&recipe(canvas), size);
                assert_eq!(width % 2, 0, "{canvas:?} at {size} is {width} wide");
                assert_eq!(height % 2, 0, "{canvas:?} at {size} is {height} tall");
                assert!(
                    scale >= 1.0,
                    "{canvas:?} at {size} would enlarge the canvas"
                );
            }
        }
    }

    /// A panorama of `frame`-shaped sources, for the tiling to read a shape off.
    fn shaped(canvas: [usize; 2], frame: [usize; 2]) -> crate::composition::Composition {
        let focal = 5200.0;
        crate::composition::Composition {
            sources: vec![crate::composition::SourceSpec {
                photo_id: "one".into(),
                size: frame,
                rotation: [1.0, 0.0, 0.0, 0.0],
                focal,
                lens: crate::composition::LensSpec::none(),
                gain: 1.0,
                warp: crate::composition::no_warp(),
            }],
            ..recipe(canvas)
        }
    }

    /// What one tile may hold, which is what every claim below is against.
    fn budget() -> usize {
        (STRIP_BUDGET_BYTES / STRIP_BYTES_PER_PIXEL) as usize
    }

    /// A canvas the device can hold is composited in one pass, and one it cannot is cut to what it
    /// can - which is the whole of what the tile is for.
    ///
    /// Every source that reaches a tile is decoded for it, at what a whole photograph costs, so the
    /// tiles are the multiplier on the expensive part: a canvas cut in four is four decodes of
    /// every frame rather than one.
    #[test]
    fn a_canvas_is_tiled_by_what_the_device_holds_rather_than_by_a_count() {
        // A `full` rendition of any shape, which is well inside the budget: one tile.
        let (across, down) = tile_of(&shaped([3840, 2160], [4000, 6000]), 3840, 2160);
        assert_eq!(
            (across, down),
            (3840, 2160),
            "a full rendition is composited in one pass"
        );

        // The largest canvas there is, where a tile has to stay a tile - and stay inside the
        // budget, which is the only thing bounding what the device holds.
        let (wide, tall) = (MAX_LONG_EDGE as usize, 4544);
        let (across, down) = tile_of(&shaped([33804, 9376], [4000, 6000]), wide, tall);
        assert!(
            across * down <= budget(),
            "a tile of {across}x{down} is past the budget"
        );
        assert!(across < wide, "the widest canvas is cut across");
        assert_eq!(
            across % 2,
            0,
            "a tile that is not the full width is copied out a row at a time"
        );
    }

    /// **The tile takes one source's shape, not the canvas's.** How many tiles a source is decoded
    /// for falls as `A_w/W + A_h/H`, which under a fixed `W·H` is least at `W/H = A_w/A_h` - the
    /// shape of a frame. A pan shot in portrait covers a tall narrow strip of its canvas, so its
    /// tiles are tall and narrow whatever the canvas is: full-height columns once the canvas is
    /// shorter than the shape asks for, which is every single-row pan there is.
    #[test]
    fn a_tile_is_the_shape_of_a_source_rather_than_of_the_picture() {
        let (wide, tall) = (MAX_LONG_EDGE as usize, 4544);
        let portrait = tile_of(&shaped([33804, 9376], [4000, 6000]), wide, tall);
        assert_eq!(
            portrait.1, tall,
            "a portrait frame fills the height and slices the width"
        );

        // The same canvas out of landscape frames wants wider, shorter tiles: fewer columns for the
        // same memory, since a landscape frame straddles fewer of them.
        let landscape = tile_of(&shaped([33804, 9376], [6000, 4000]), wide, tall);
        assert!(
            landscape.0 >= portrait.0,
            "landscape frames tile {landscape:?} where portrait ones tile {portrait:?}",
        );
    }

    /// **Every pixel of the canvas is written exactly once, and every copy stands on a word.**
    ///
    /// A tile that is not the full width goes out a row at a time into a buffer it is a slice of,
    /// and `copy_buffer_to_buffer` rejects an offset or a length that is not a multiple of four
    /// rather than rounding one - so the evenness the tiling promises is the whole of what makes
    /// the strided copy legal. Covering it once is the other half: a run short by a row leaves a
    /// black band, and one long overwrites the tile beside it.
    #[test]
    fn the_tiles_of_a_canvas_copy_out_to_cover_it_once() {
        // A width the tiles do not divide, so the last column of each row is a short one.
        let (width, height) = (64usize, 20usize);
        for (across, down) in [(64, 7), (10, 7), (10, 20), (2, 1)] {
            let mut written = vec![0u8; width * height * BYTES_PER_PIXEL];
            for top in (0..height).step_by(down) {
                for left in (0..width).step_by(across) {
                    let (wide, deep) = (across.min(width - left), down.min(height - top));
                    for (from, to, bytes) in tile_runs(width, left, top, wide, deep) {
                        assert_eq!(from % 4, 0, "{across}x{down}: a source offset off a word");
                        assert_eq!(to % 4, 0, "{across}x{down}: a canvas offset off a word");
                        assert_eq!(bytes % 4, 0, "{across}x{down}: a length off a word");
                        assert!(
                            from + bytes <= (wide * deep * BYTES_PER_PIXEL) as u64,
                            "{across}x{down}: a run reads past the tile",
                        );
                        for byte in to..to + bytes {
                            written[byte as usize] += 1;
                        }
                    }
                }
            }
            let missed = written.iter().filter(|n| **n != 1).count();
            assert_eq!(
                missed, 0,
                "{across}x{down} left {missed} bytes not written exactly once"
            );
        }
    }

    /// Nothing ever asks for a tile of nothing, whatever the canvas or the budget.
    #[test]
    fn a_tile_is_never_empty() {
        let huge = usize::from(u16::MAX) * 4;
        let (across, down) = tile_of(&shaped([huge, huge], [6000, 4000]), huge, huge);
        assert!(across >= 2 && down >= 1);
    }

    /// The recipe out of an align's answer, which carries what the align has to say beside it.
    fn recipe_of(job: &Job) -> serde_json::Value {
        let answered = crate::job::run(job)
            .expect("the align runs")
            .composite
            .expect("an answer");
        let answer: serde_json::Value = serde_json::from_str(&answered).expect("an answer parses");
        answer["recipe"].clone()
    }

    /// A job carrying two views and asking to align answers a recipe that names both of them,
    /// with what the align could not state beside it - a lens nothing has fitted here, since
    /// neither view carries an analysis.
    #[test]
    fn an_align_job_answers_a_recipe() {
        let paths = views("align-job");
        let job = job(&paths, serde_json::json!({}), "align");
        let answered = crate::job::run(&job)
            .expect("the align runs")
            .composite
            .expect("an answer");
        let answer: serde_json::Value = serde_json::from_str(&answered).expect("an answer parses");
        let recipe: crate::composition::Composition =
            serde_json::from_value(answer["recipe"].clone()).expect("a recipe parses");
        assert_eq!(recipe.sources.len(), 2);
        assert!(
            recipe.canvas[0] > crate::composite_align::tests::WIDE,
            "{:?}",
            recipe.canvas
        );
        // By photograph, which is how the caller named them: it has no list to index back into.
        assert_eq!(answer["lensless"].as_array().expect("a list").len(), 1);
        assert!(
            paths.contains(
                &answer["lensless"][0]
                    .as_str()
                    .expect("a photograph")
                    .to_string()
            )
        );
    }

    /// What a client is handed is the canvas at the level it asked for, described by its own
    /// header, and every level of it is coded against one white.
    ///
    /// **The levels are the claim.** A reader zooming moves between levels, and a picture coded
    /// against a white measured at each of them separately is one whose exposure changes as they
    /// zoom - which is exactly the fault `whole_levels` exists to prevent between *tiles*, one
    /// axis over. What makes them agree here is that the union is measured over the sources at a
    /// fixed size rather than over the canvas, so it does not depend on the level at all. That the
    /// answer is also *kept* is `a_composite_reads_what_it_was_measured_as`'s claim, not this one's.
    #[test]
    fn every_level_of_a_prepared_picture_is_one_photograph() {
        if crate::gpu::device().is_none() {
            return;
        }
        let paths = views("prepare-levels");
        let recipe = recipe_of(&job(&paths, serde_json::json!({}), "align"));
        let canvas: [usize; 2] =
            serde_json::from_value(recipe["canvas"].clone()).expect("a canvas");
        let long = canvas[0].max(canvas[1]);

        let prepared = |level: u32, analysis: Option<Vec<u8>>| {
            let mut asking = job(&paths, recipe.clone(), "render");
            asking.photo_analysis = analysis;
            crate::picture::prepared(&asking, level, None, &[]).expect("a picture")
        };

        // Within a pixel of the level's own size, on both axes: `sized` floors each to an even
        // number, a strip of a frame two samples to a word having to start on one.
        let about = |got: usize, want: usize, what: &str| {
            assert!(got == want || got + 1 == want, "{what}: {got} for {want}");
        };

        let whole = prepared(0, None);
        let header = &whole.header;
        about(
            header.width.max(header.height),
            long,
            "level 0 is the canvas",
        );
        // The header describes the samples beside it, which is what a client sizes its upload by:
        // a count that disagrees is a picture read at the wrong stride, which is noise on screen.
        assert_eq!(whole.samples.len(), header.width * header.height * 3);
        // A composite of these views covers most of its canvas and none of it is black: the
        // corners a rig leaves uncovered are the zeros, and they are a minority.
        let lit = whole.samples.iter().filter(|sample| **sample > 0).count();
        assert!(
            lit * 4 > whole.samples.len() * 3,
            "only {lit} of {} samples are lit",
            whole.samples.len()
        );
        // And it hands back everything it is described by, unconditionally: the camera match is
        // in there, and a client has no other channel to it.
        let kept = header
            .photo_analysis
            .clone()
            .expect("a prepare describes its picture");
        assert!(!kept.is_empty());

        // The next level, handed what the first measured - which is what the route does, the
        // worker having filed it.
        let half = prepared(1, Some(kept));
        let halved = &half.header;
        about(
            halved.width.max(halved.height),
            long / 2,
            "level 1 halves the canvas",
        );
        assert_eq!(half.samples.len(), halved.width * halved.height * 3);
        // One photograph: the same diffuse white and the same top end, so the grade anchors both
        // levels to one exposure.
        assert_eq!(
            halved.white, header.white,
            "the levels disagree about diffuse white"
        );
        assert_eq!(
            halved.peak, header.peak,
            "the levels disagree about the scene's top end"
        );

        // And a level that halves the picture away is refused rather than answered at the
        // sensor's own resolution, which is what a floor of zero reads as.
        assert!(
            crate::picture::prepared(&job(&paths, recipe.clone(), "render"), 30, None, &[])
                .is_err()
        );
    }

    /// A composite handed what it was measured as does not measure it again.
    ///
    /// **The whole of the stateless design, and the expensive half of a composite.** Both the
    /// levels and the colour are read over every source stacked, so a pan that re-measured on
    /// every open would pay a reduced decode of every frame for an answer already on disk.
    ///
    /// Counted rather than timed, and rather than compared: `union_levels` is deterministic, so
    /// two passes agreeing is what happens whether the second one stacked or not - and a clock on
    /// a two-source fixture is measuring the difference between two reduced decodes and none,
    /// against a first call that also pays for every pipeline it is the first to reach.
    #[test]
    fn a_composite_reads_what_it_was_measured_as() {
        if crate::gpu::device().is_none() {
            return;
        }
        let paths = views("prepare-reuse");
        let recipe = recipe_of(&job(&paths, serde_json::json!({}), "align"));

        let first = crate::picture::prepared(&job(&paths, recipe.clone(), "render"), 1, None, &[])
            .expect("a picture");
        let kept = first
            .header
            .photo_analysis
            .clone()
            .expect("a prepare describes its picture");

        let mut asking = job(&paths, recipe.clone(), "render");
        asking.photo_analysis = Some(kept);
        let stacked = STACKS.with(std::cell::Cell::get);
        let second = crate::picture::prepared(&asking, 1, None, &[]).expect("a picture");

        assert_eq!(
            STACKS.with(std::cell::Cell::get),
            stacked,
            "the set was stacked again for measurements it was handed",
        );
        assert_eq!(
            second.header.white, first.header.white,
            "the same picture, differently exposed"
        );
        assert_eq!(second.header.peak, first.header.peak);
        assert!(
            second.header.matched == first.header.matched,
            "and the same colour rendering"
        );

        // **And a set it was not measured over is measured again.** One gain doubled is twice the
        // light that frame contributes, so the canvas the filed levels and the filed match describe
        // is not the canvas this renders - while the quantile they are keyed on is identical,
        // which is the whole reason the row carries a stamp of the set as well.
        let mut regained = recipe.clone();
        let gain = &mut regained["sources"][0]["gain"];
        *gain = serde_json::json!(gain.as_f64().expect("a gain") * 2.0);
        let mut asking = job(&paths, regained, "render");
        asking.photo_analysis = first.header.photo_analysis.clone();
        let stacked = STACKS.with(std::cell::Cell::get);
        crate::picture::prepared(&asking, 1, None, &[]).expect("a picture");
        assert!(
            STACKS.with(std::cell::Cell::get) > stacked,
            "a changed set read the previous set's measurements",
        );
    }

    /// A window of a level is the rectangle of that level it names.
    ///
    /// **The whole of what a ladder rests on.** A reader zoomed in is handed a rectangle and pans
    /// across it; if a window were not the picture the whole level holds there, every pan would
    /// shift the picture under the crop and every re-fetch would re-expose it. Three separate
    /// things have to hold for that, and each fails differently: the gather has to be told the
    /// canvas's coordinate rather than the buffer's, or the window shows the wrong part of the
    /// scene; the coding has to use the filed levels rather than the window's own, or the same
    /// cloud is a different brightness at every zoom; and the illuminant the temperature panel opens
    /// at has to come off the file where the window never reaches the reference frame.
    ///
    /// Two claims, because only one of them is exact and the difference is worth naming.
    ///
    /// **The whole level asked for as a window is the whole level, sample for sample.** Nothing
    /// about a window is approximate - not the coordinate, not the stride, not the exposure - and
    /// this is what says so, with no room for a tolerance to hide a shift in.
    ///
    /// **A smaller window is the same picture in the same place, and not the same samples.** It
    /// decodes a smaller region of each source, and a region decode answers at the scale it can
    /// rather than the one it was asked for (`composite_tile::prepared`) - so a window reads its
    /// sources *finer* than the coarse level does and resamples them less. Measured on these
    /// views: 593 counts of 65535 mean, against 3000 to 10000 for the same rectangle compared at
    /// any other offset. So what is pinned is the offset, by the margin between them, and a window
    /// that came back sharper than its overview is the ladder working rather than a seam - two
    /// windows of one level decode the same way as each other.
    #[test]
    fn a_window_of_a_level_is_that_rectangle_of_it() {
        if crate::gpu::device().is_none() {
            return;
        }
        let paths = views("prepare-window");
        let recipe = recipe_of(&job(&paths, serde_json::json!({}), "align"));
        let asking = || job(&paths, recipe.clone(), "render");

        let whole = crate::picture::prepared(&asking(), 1, None, &[]).expect("a level");
        let (across, down) = (whole.header.width, whole.header.height);
        let kept = whole
            .header
            .photo_analysis
            .clone()
            .expect("a prepare describes its picture");

        // With an illuminant written into it, which these views - rendered pictures, not RAWs -
        // carry no multipliers for: what the window has to do is read the *file's* balance where
        // the frames it decodes state none, and a fixture stating one either way could not tell a
        // read from a coincidence.
        const WARM: f64 = 5240.0;
        let mut filed = crate::photo_analysis::decode(&kept).expect("the blob reads back");
        let gains = filed
            .from_raw
            .balance
            .expect("the level filed its gains")
            .wb_gains;
        filed.from_raw.balance = Some(crate::photo_analysis::Balance {
            wb_gains: gains,
            as_shot: Some(crate::white_balance::AsShot {
                temperature: WARM,
                tint: 1.5,
            }),
        });
        let kept = crate::photo_analysis::encode(&filed);

        // A rectangle inside it, on even columns, and not at the origin: an origin of zero would
        // pass even with the buffer's coordinate handed to the gather.
        let (left, top) = ((across / 4) & !1, down / 4);
        let (wide, deep) = ((across / 2) & !1, down / 2);
        let mut with_analysis = asking();
        let part_analysis = Some(kept);
        with_analysis.photo_analysis = part_analysis.clone();
        let part = crate::picture::prepared(
            &with_analysis,
            1,
            Some(crate::px::Rect::exact(left, top, wide, deep)),
            &[],
        )
        .expect("a window of that level");

        assert_eq!((part.header.width, part.header.height), (wide, deep));
        let placed = part.header.window.expect("a window says where it is");
        assert_eq!(placed.origin, (left, top));
        assert_eq!(
            placed.canvas,
            (across, down),
            "the canvas is the picture, not the buffer"
        );
        // One picture, so one exposure: a window that measured its own would grade differently
        // from the level it is a rectangle of.
        assert_eq!(part.header.white, whole.header.white);
        assert_eq!(part.header.peak, whole.header.peak);
        // And the illuminant, which the reference frame carries and a window has to read off what
        // the last pass filed.
        let read = part.header.as_shot.expect("a window lost the illuminant");
        assert!(
            (read.temperature - WARM).abs() < 0.1,
            "the illuminant is {}",
            read.temperature
        );

        // **The whole of it, asked for as a window, is it.** Every part of the windowing that is
        // not a re-decode meets here: the canvas coordinate the gather is handed, the buffer's
        // stride, the tiles copied into it, the levels the strips are coded against.
        let mut all = asking();
        all.photo_analysis = part_analysis.clone();
        let full = crate::picture::prepared(
            &all,
            1,
            Some(crate::px::Rect::exact(0, 0, across, down)),
            &[],
        )
        .expect("the whole level as a window");
        assert_eq!(full.samples.len(), whole.samples.len());
        assert!(
            full.samples == whole.samples,
            "the whole level asked for as a window is not the whole level",
        );

        // And the smaller one lands where it says. Compared against the level at its own offset
        // and at three wrong ones, because what would go wrong is an offset rather than a value -
        // the buffer's coordinate reaching the gather reads as the origin winning.
        let mean_at = |ox: usize, oy: usize| {
            let mut sum = 0u64;
            let mut count = 0u64;
            let mut lit = 0u64;
            for y in (0..deep).step_by(7) {
                for x in (0..wide).step_by(7) {
                    let mine = part.samples[(y * wide + x) * 3 + 1];
                    let theirs = whole.samples[((oy + y) * across + ox + x) * 3 + 1];
                    sum += u64::from(mine.abs_diff(theirs));
                    lit += u64::from(theirs > 0);
                    count += 1;
                }
            }
            (sum as f64 / count as f64, lit * 2 > count)
        };
        let (mine, lit) = mean_at(left, top);
        // Something was actually compared: a window over the uncovered corner of a hand-held pan
        // is black in both, and two black rectangles agree about nothing.
        assert!(lit, "the level is mostly black where this window is");
        for (ox, oy) in [(0, 0), (left, 0), (0, top)] {
            let (elsewhere, _) = mean_at(ox, oy);
            assert!(
                elsewhere > mine * 2.0,
                "the window matches {ox},{oy} as well as its own {left},{top}: \
                 {elsewhere} against {mine}",
            );
        }
    }

    /// What the composite gather's four taps cost at a reduction, against the filter that covers
    /// the whole footprint.
    ///
    /// **The gather is the only reduction a coarse level gets, and four taps do not cover eight
    /// source pixels.** Each source is decoded whole or halved and nothing between
    /// (`view::Scale`), so every level below half arrives at the same resolution and
    /// `composite_gather.slang`'s Catmull-Rom is what takes it the rest of the way - reading four source
    /// pixels per axis where the output pixel's footprint is as many as the scale. `base::resize`
    /// is the filter that does cover it, weighted ends and all (`reduce.slang`), so the difference
    /// between them is what the undersampling is worth.
    ///
    /// One source through `of_one`, because that isolates the gather: no blend, no projection, no
    /// lens, and the identity rotation - so what is left between the two answers is the filter.
    #[test]
    fn the_gather_undersamples_a_reduction_by_this_much() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let base = crate::base::device(gpu).expect("the base pipelines");
        let paths = views("gather-reduction");
        let spec = crate::composition::Composition::of_one(
            [crate::composite_scene::WIDE, crate::composite_scene::TALL],
            crate::composition::LensSpec::none(),
        );
        let files = vec![crate::composite_tile::SourceFile {
            path: &paths[0],
            analysis: None,
        }];

        // One white for both, so nothing below is the coding disagreeing.
        let levels = crate::tone::Levels {
            white: crate::light::Light::measured(0.25 * crate::transfer::FULL_SCALE),
            peak: crate::light::Light::measured(crate::transfer::FULL_SCALE),
            floor: None,
        }
        .anchored();
        let gathered = |scale: f64, width: usize, height: usize| {
            let request = crate::composite_tile::CompositeRequest {
                window: crate::px::Rect::exact(0, 0, width, height),
                // The whole window, which is what an empty list means.
                parts: &[],
                scale,
                white_quantile: 0.9,
                levels: Some(levels),
                reference_white_nits: crate::light::Light::exactly(203.0),
                // Off, both of them: a sharpen or a defringe is a second difference between the
                // two answers and neither is the filter under test.
                strengths: crate::image::Strengths {
                    sharpen: 0.0,
                    defringe: 0.0,
                },
                detail: crate::galosh::Detail::at(0.0, 0.0),
                sources: &files,
                from: crate::composite_tile::From::Original,
                mask: None,
            };
            let (frame, _) = pollster::block_on(crate::composite_tile::prepared(&spec, &request))
                .expect("one source gathers");
            frame
        };

        // **Both sides off one decode, which is what makes this the filter and nothing else.**
        // `view::Scale` is `Full` or `Half` and nothing between, so a source asked for at any
        // scale below half arrives at exactly half - and asking at scale 2 gets that same halved
        // frame gathered one-to-one. Reduce *that* with the area filter and gather it again at
        // scale 8, and the two answers differ by their filters alone. Against a full-resolution
        // reference instead, the decode fork dominates and says nothing about either.
        let held = crate::composite_scene::WIDE / 2;
        let one_to_one = gathered(2.0, held, crate::composite_scene::TALL / 2);
        let small = (held / 4, crate::composite_scene::TALL / 8);
        let reference =
            crate::base::resize(gpu, base, &one_to_one, small).expect("the area filter");
        let ours = gathered(8.0, small.0, small.1);

        let read = |frame: &crate::resident::Resident| {
            pollster::block_on(frame.host()).expect("the frame reads back")
        };
        let (mine, theirs) = (read(&ours), read(&reference));
        assert_eq!(mine.len(), theirs.len(), "two shapes of the same reduction");

        // The outermost ring is left out: the gather writes black where a source does not reach a
        // pixel at all, and the area filter has content there - a difference in coverage rather
        // than in filtering, and it is what swamped this before the ring came off.
        const RING: usize = 2;
        let mut worst = 0u16;
        let mut total = 0u64;
        let mut count = 0u64;
        for y in RING..small.1 - RING {
            for x in RING..small.0 - RING {
                for c in 0..3 {
                    let at = (y * small.0 + x) * 3 + c;
                    worst = worst.max(mine[at].abs_diff(theirs[at]));
                    total += u64::from(mine[at].abs_diff(theirs[at]));
                    count += 1;
                }
            }
        }
        let mean = total as f64 / count as f64;
        eprintln!(
            "four taps against a 4x footprint: mean {mean:.0} of 65535 ({:.2}%), worst {worst} \
             ({:.1}%)",
            100.0 * mean / 65535.0,
            100.0 * f64::from(worst) / 65535.0,
        );
        one_to_one.reclaim();
        reference.reclaim();
        ours.reclaim();

        // **Measured at 236 counts, a third of a percent, with 1681 at the worst pixel** - and on
        // a noise field with content at every scale, which is about the hardest case a reduction
        // meets. So the undersampling is real and it is small, which is worth knowing in exactly
        // this form: the arithmetic says four taps cannot cover a four-pixel footprint, and what
        // that is worth on a picture is this rather than whatever the arithmetic sounds like.
        //
        // Bounded rather than judged. What it is *for* is the gather merge: a gather that
        // prefiltered its own footprint would bring this to nothing, so this is what says the
        // merge did something - and loose enough that a driver's rounding does not move it.
        assert!(
            mean < 600.0,
            "mean {mean} counts against the 236 this measures"
        );
    }

    /// The same job with the recipe in hand renders its targets, which is the whole of what a
    /// panorama has to do to be a photograph the library can serve.
    #[test]
    fn a_render_job_writes_its_targets() {
        let paths = views("render-job");
        let recipe = recipe_of(&job(&paths, serde_json::json!({}), "align"));
        let canvas = recipe["canvas"].clone();

        let out = std::env::temp_dir().join("bowerbird-pano-render.avif");
        let _ = std::fs::remove_file(&out);
        let mut rendering = job(&paths, recipe, "render");
        rendering.targets = serde_json::from_value(serde_json::json!([{
            "rendition": "full",
            "output": "pq",
            "outputPath": out.to_string_lossy(),
            "size": 1024,
            "source": "render",
            "sdrQuantizer": 30,
            "hdrQuantizer": 30,
            "preset": 6,
            "stillFullChroma": true,
            "sdrFullChroma": true,
        }]))
        .expect("a target");

        crate::job::run(&rendering).expect("the render runs");
        let written = std::fs::metadata(&out).expect("a rendition was written");
        assert!(
            written.len() > 1024,
            "the rendition is {} bytes",
            written.len()
        );
        // What was asked for is a panorama, not one of its frames.
        let long = canvas[0].as_u64().unwrap().max(canvas[1].as_u64().unwrap());
        assert!(
            long > crate::composite_align::tests::WIDE as u64,
            "canvas {canvas:?}"
        );
    }

    /// Nothing a render of a RAW measured reaches a composite of the cameras' own pictures.
    ///
    /// **The arm decides three things at once, and each of them would be a whole tile out.** The
    /// levels the strips are coded against, the colour the canvas is graded through, and the
    /// analysis the sharpen and the roll-off read - all of them are the reference photograph's for
    /// a composite of the photographs, and none of them describes what a body printed. Held here
    /// rather than at `composite_tile::prepared`, because this is where the choice is made and a render
    /// job is what crosses it.
    #[test]
    fn a_camera_composite_carries_nothing_the_reference_photograph_measured() {
        let paths = views("camera-arm");
        let recipe = recipe_of(&job(&paths, serde_json::json!({}), "align"));

        // Every source with an analysis of the kind a library keeps: the match a render of the RAW
        // was fitted, and the blur that decode carried.
        let analysis = crate::photo_analysis::PhotoAnalysis {
            from_raw: crate::photo_analysis::FromRaw {
                matched: Some(crate::photo_analysis::tests::a_match()),
                capture_sigma: Some(1.25),
                ..Default::default()
            },
            ..Default::default()
        };
        let kept = crate::photo_analysis::encode(&analysis);
        let mut rendering = job(&paths, recipe, "render");
        let pano = rendering.composite.as_mut().expect("a panorama");
        for source in &mut pano.sources {
            source.photo_analysis = Some(kept.clone());
        }
        let pano = rendering.composite.as_ref().expect("a panorama");
        let Want::Render { recipe } = &pano.want else {
            panic!("a render")
        };

        let camera = base(
            &rendering,
            &pano.sources,
            recipe,
            256,
            crate::composite_tile::From::Camera,
            None,
            &[],
        )
        .expect("a camera composite");
        assert!(
            camera.matched.is_none(),
            "a finished picture is not matched to itself"
        );
        assert!(
            camera.capture_sigma.is_none(),
            "a body's own sharpening is not ours to undo"
        );
        assert!(
            camera.stored.from_raw.matched.is_none(),
            "a foreign analysis rode along"
        );
        // The white the pictures arrived with rather than a quantile of them.
        assert_eq!(camera.levels.white.raw(), crate::transfer::FULL_SCALE);
        assert_eq!(camera.levels.peak.raw(), crate::transfer::FULL_SCALE);

        // The same job off the photographs takes all three, which is what makes the three
        // assertions above a decision rather than an absence.
        let ours = base(
            &rendering,
            &pano.sources,
            recipe,
            256,
            crate::composite_tile::From::Original,
            None,
            &[],
        )
        .expect("a composite of the sources");
        assert!(
            ours.matched.is_some(),
            "a render of a RAW is graded through a body's colour"
        );
        assert_eq!(ours.capture_sigma, Some(1.25));
        assert!(
            ours.levels.white.raw() < crate::transfer::FULL_SCALE,
            "the sources' own white is measured, and came back {}",
            ours.levels.white.raw(),
        );
    }

    fn views(name: &str) -> Vec<String> {
        let pan =
            |degrees: f64| crate::composition::from_axis_angle([0.0, degrees.to_radians(), 0.0]);
        crate::composite_align::tests::fixtures(name, &[pan(-10.0), pan(10.0)])
    }

    /// A job of the shape the worker sends, with a panorama on it.
    fn job(paths: &[String], recipe: serde_json::Value, want: &str) -> crate::job::Job {
        let sources: Vec<serde_json::Value> = paths
            .iter()
            .map(|path| serde_json::json!({ "photoId": path, "rawFilePath": path }))
            .collect();
        let mut panorama = serde_json::json!({ "sources": sources, "want": want });
        if recipe.is_object() && !recipe.as_object().expect("an object").is_empty() {
            let mut recipe = recipe;
            // The tag the server writes, which the align's own answer does not carry.
            recipe["kind"] = serde_json::Value::String("panorama".into());
            panorama["recipe"] = recipe;
        }
        serde_json::from_value(serde_json::json!({
            "rawFilePath": "",
            "matchEmbeddedJpeg": false,
            "denoiseLuminance": 0.0,
            "denoiseColour": 0.0,
            "sharpen": 0.0,
            "defringe": 0.0,
            "grade": { "peakNits": 1000.0, "referenceWhiteNits": 203.0, "whiteQuantile": 0.99 },
            "targets": [],
            "composite": panorama,
        }))
        .expect("a job")
    }

    /// Whatever is asked for, a rendition stops at what an encoder can hold.
    #[test]
    fn a_panorama_is_capped_at_what_can_be_encoded() {
        let (width, height, _) = sized(&recipe([40000, 9000]), 0);
        assert!(width <= MAX_LONG_EDGE as usize && height <= MAX_LONG_EDGE as usize);
        assert!(
            width > MAX_LONG_EDGE as usize - 4,
            "the cap should be reached, not undershot"
        );
    }
}
