//! One picture of a recipe, coded and handed over, for a client that will grade it itself.
//!
//! **This is a rendition stopped one stage early.** A render decodes or composites, cuts, sharpens
//! and then grades and encodes; what a client wants is everything up to the grade, because the
//! grade is the thing it is going to do sixty times a second. So this calls the same
//! [`crate::job::Base`] assembly a rendition calls, the same [`crate::hdr::Cut::from_base`], and
//! stops - which is what makes what a reader drags their sliders over the same picture the export
//! ships.

use crate::job::Job;

/// The picture's own size at scale 1, whatever it is composed from.
///
/// A composite's canvas rather than any one source's, because the canvas is the photograph as far
/// as everything above the recipe is concerned.
fn whole(job: &Job) -> Result<(usize, usize), String> {
    if let Some(pano) = &job.composite {
        let crate::composite_job::Want::Render { recipe } = &pano.want else {
            return Err("only a render of a composite has a picture to prepare".into());
        };
        let canvas = recipe.composition().canvas;
        return Ok((canvas[0], canvas[1]));
    }
    let header = crate::header::read_path(&job.raw_file_path)
        .ok_or_else(|| format!("{} could not be read", job.raw_file_path))?;
    Ok((header.width as usize, header.height as usize))
}

/// The picture at `level`, coded, with everything the grade needs beside it.
///
/// `level` is a halving of the recipe's own long edge, and `window` a rectangle of that level in
/// its own pixels - None for the whole of it. [`crate::composition::coarsest_level`] is the level to
/// ask for the whole picture at: below it the picture is larger than an adapter will hold a texture
/// of, which is the whole reason a canvas has levels, and a window is how a reader reaches past it.
pub fn prepared(
    job: &Job,
    level: u32,
    window: Option<crate::px::Rect<crate::px::Composite>>,
    // The parts of `window` the caller is actually short of, or empty for the whole of it. An L of
    // tiles is decoded per source for the box bounding *its own* parts rather than for the box
    // bounding all of them, which holds a corner nobody asked about
    // (`composite_tile::CompositeRequest::parts`).
    parts: &[crate::px::Rect<crate::px::Composite>],
) -> Result<crate::edit::Prepared, String> {
    let picture = whole(job)?;
    let long = picture.0.max(picture.1);
    let want = long >> level;
    // **A level that halves the picture away is refused rather than answered.** `Scale` reads a
    // floor of zero as "every photosite", so a level past the point of meaning would come back at
    // the sensor's own resolution - into whatever buffer the caller sized for a few pixels.
    let size = u32::try_from(want)
        .ok()
        .filter(|size| *size > 0)
        .ok_or_else(|| format!("level {level} of a {long}px picture is no picture"))?;
    let shape = crate::composite_job::level_shape(&[picture.0, picture.1], level);
    if let Some(window) = window {
        let (x, y, width, height) = window.raw();
        if width == 0 || height == 0 || x >= shape.0 || y >= shape.1
            || width > shape.0 - x || height > shape.1 - y
        {
            return Err(format!("a {width}x{height} window at {x},{y} is outside a {}x{} picture", shape.0, shape.1));
        }
    }
    let decode_size = if job.composite.is_none()
        && (shape.0 > picture.0 / 2 || shape.1 > picture.1 / 2)
    {
        long as u32
    } else {
        size
    };
    // No targets: a prepare is of the photographs rather than of the cameras' own pictures, and it
    // takes no crop - the client applies the reader's geometry to what it is handed.
    let base = crate::job::assembled(job, decode_size, &[], window, parts)?;

    let crate::job::Base {
        frame,
        width: frame_width,
        height: frame_height,
        levels,
        photograph,
        window: mut placed,
        matched,
        mut analysis,
        stored,
        as_shot,
        capture_sigma,
        sensor_long,
        sharpen_noise,
        // A prepare is always of the photographs (`assembled` takes no targets), so this is
        // always true here and there is no peak for it to gate: the peak is measured after a
        // grade, and a prepare hands the frame over before one.
        describes_the_photograph: _,
    } = base;

    // A window has been through the photograph's own gather already, and a composite through the
    // recipe's, so neither has a lens left to apply - which is the same test `run` makes.
    let lens = match placed {
        Some(_) => None,
        None => matched.as_ref().map(|m| &m.lens),
    };
    let mut cut = match frame {
        crate::job::Cutting::AlreadyCut(cut) => cut,
        crate::job::Cutting::OnDevice(frame) => {
            let (width, height) = if placed.is_some() { (frame_width, frame_height) } else { shape };
            let size = crate::hdr_args::Size { width: width as u32, height: height as u32 };
            // **The whole picture's long edge at this scale, not the cut's.** The sigma is in the
            // sensor's pixels and this composes it for the resolution the frame is at, which a
            // window shares with the canvas it came out of - so a 1000px window of a 4000px level
            // is deconvolved as a quarter-size render and not as a 1000px one.
            let scaled_long = match placed {
                Some(_) => photograph.0.max(photograph.1),
                None => (size.width as usize).max(size.height as usize),
            };
            let sigma = crate::image::deconvolve_split(capture_sigma, sensor_long, scaled_long);
            let noise = sharpen_noise.at(
                crate::px::Span::<crate::px::Sensor>::exact(sensor_long),
                crate::px::Span::<crate::px::Drawn>::exact(scaled_long),
            );
            // No repairs: the client draws them over whatever level and tiles it holds
            // (`wasm::HeldRaw::set_repairs`), as it draws the geometry.
            crate::hdr::Cut::from_base(frame, lens, size, job.sharpen, sigma, noise)
        }
    };
    if let Some(window) = window.filter(|_| placed.is_none()) {
        let (x, y, width, height) = window.raw();
        let source = cut.resident().ok_or("the prepared picture is not on the GPU")?;
        let gpu = source.gpu();
        let cropped = crate::resident::Resident::empty(gpu, width, height);
        let mut recording = gpu.record();
        // Crop after filtering so window boundaries keep the whole picture's neighbours.
        crate::retouched_frame::copy(
            &mut recording,
            (source, crate::px::At::exact(x, y)),
            (&cropped, crate::px::At::exact(0, 0)),
            crate::px::Size::exact(width, height),
        );
        recording.submit();
        placed = Some(crate::gpu::Window {
            photograph: crate::px::Size::exact(cut.width, cut.height),
            origin: crate::px::At::exact(x, y),
        });
        cut.release();
        cut = crate::hdr::Cut::device(cropped, width, height);
    }
    if let Some(gpu) = crate::gpu::device() {
        gpu.settle();
    }

    // **The one transfer this path pays, and it is the point of it.** A render grades the buffer
    // where it lies; a client is going to grade it on its own device, so the samples cross once
    // here and never again for the life of the open.
    let (width, height) = (cut.width, cut.height);
    let samples = cut.into_samples();

    // Cleared because it is measured after the grade, on whatever frame went up, and this hands
    // the frame over before any of that. Everything else goes back whole
    // (`PreparedHeader::photo_analysis` says why this caller differs from the tab's own open).
    analysis.from_render.scene_peak = None;
    let filled = analysis.filled_from(&stored);
    let noise_fit = filled.from_raw.noise;
    let defocus = filled
        .from_render
        .defocus
        .map_or((0.0, 0.0), |pair| (pair.red, pair.blue));
    let keep = crate::photo_analysis::encode(&filled);

    Ok(crate::edit::Prepared {
        header: crate::edit::PreparedHeader {
            width,
            height,
            white: levels.white,
            peak: levels.peak,
            floor: levels.floor,
            grade: job.grade,
            strengths: job.strengths(),
            camera_match: job.camera_match,
            matched: matched.is_some(),
            // The mosaic stayed on this side whatever the picture was made of, so a new Detail
            // amount is a new prepare rather than a filter the client drags.
            mosaic: false,
            as_shot,
            detail: job.detail().resolved(noise_fit),
            noise_fit,
            defocus,
            photo_analysis: Some(keep),
            window: placed.map(|placed| crate::edit::PreparedWindow {
                canvas: placed.photograph.raw(),
                origin: placed.origin.raw(),
            }),
            picture: Some(picture),
            level,
            finest: level == 0,
        },
        samples,
    })
}
