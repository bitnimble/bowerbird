//! What the alignment sees in a set of photographs, pair by pair.
//!
//! ```text
//! composite_probe <photo> <photo> [more...]
//! ```
//!
//! The align reports one sentence when it cannot place a set, which is the right answer for a
//! toast and no use at all for finding out why. This prints the measurements behind it: each
//! pair's coarse translation, its correlation, how much of a frame it says the two share, and how
//! many correspondences survived the refine - then the solve's own answer.

use rawshim::composite_pairs::{Pyramid, coarse, refined};

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.len() < 2 {
        eprintln!("composite_probe <photo> <photo> [more...]");
        std::process::exit(2);
    }
    // What every worker pays before it can do anything: the adapter, the device and the shader
    // modules. A merge spawns one for the align and one per rendition, so this is charged three
    // times over where the probe charges it once.
    let starting = std::time::Instant::now();
    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    println!(
        "gpu: ready in {:.0}ms",
        starting.elapsed().as_secs_f64() * 1000.0
    );

    // `PANO_PROBE_PLANES=<dir>` searches `<dir>/<file stem>.avif` instead of the RAW's own
    // preview, which is what the server does with a grid tile built from that same JPEG. Held
    // here rather than made per source, so the borrows below outlive the map.
    let planes_from: Vec<Option<String>> = paths.iter().map(|path| plane_for(path)).collect();

    let sources: Vec<rawshim::composite_align::AlignSource<'_>> = paths
        .iter()
        .zip(&planes_from)
        .map(|(path, plane)| rawshim::composite_align::AlignSource {
            photo_id: path,
            path,
            preview_path: plane.as_deref(),
            analysis: None,
            size: size_of(path),
            camera_model: None,
            lens_model: None,
            focal_length: None,
            focal_px: focal_px(path),
            shutter: None,
            aperture: None,
            iso: None,
        })
        .collect();

    let started = std::time::Instant::now();
    let planes = pollster::block_on(rawshim::composite_align::previews(gpu, &sources))
        .expect("every source has a preview");
    println!(
        "previews: {} in {:.0}ms, {:.0}ms each",
        planes.len(),
        started.elapsed().as_secs_f64() * 1000.0,
        started.elapsed().as_secs_f64() * 1000.0 / planes.len() as f64
    );
    for (at, (path, plane)) in paths.iter().zip(&planes).enumerate() {
        // Every stage's idea of which way up this photograph is, in one line: the catalogue's,
        // the search plane's, and what the region decode would produce. A panorama solved on one
        // and composited through another is a wrong focal and nothing saying so.
        let header = rawshim::header::read_path(path);
        let (turn, wide, tall) = header
            .as_ref()
            .map_or((0, 0, 0), |h| (h.orientation, h.width, h.height));
        if let Some(header) = header.as_ref() {
            println!(
                "  {} {}, {:.0}mm f/{:.1} {:.4}s ISO {:.0}",
                rawshim::header::name(&header.camera_make),
                rawshim::header::name(&header.camera_model),
                header.focal,
                header.aperture,
                header.shutter,
                header.iso,
            );
        }
        println!(
            "  focal from the body: {}",
            match sources[at].focal_px {
                Some(focal) => format!("{focal:.0}px"),
                None => "unknown, so the solve is free to find one".to_string(),
            }
        );
        println!(
            "{path}: header {wide}x{tall} orientation {turn}, preview {}x{} ({}), sizes {:?}",
            plane.width,
            plane.height,
            match plane.width < plane.height {
                true => "portrait",
                false => "landscape",
            },
            sources[at].size,
        );
        if let Ok(dump) = std::env::var("PANO_PROBE_DUMP") {
            // Named by stem, so a dump directory is directly a `PANO_PROBE_PLANES` one.
            let stem = std::path::Path::new(path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("preview");
            write_preview(&format!("{dump}/{stem}.jpg"), path);
        }
    }

    // `PANO_PROBE_FEATURES=17-18,17-20` asks the one question the correlation search cannot: how
    // many of each frame's corners match one corner of the other clearly better than any second
    // place. Printed beside what the search says, so the two can be told apart on the same pairs.
    if let Ok(which) = std::env::var("PANO_PROBE_FEATURES") {
        let described: Vec<rawshim::composite_features::Described> = planes
            .iter()
            .map(|plane| {
                let level = rawshim::composite_pairs::Pyramid::of(gpu, plane);
                pollster::block_on(rawshim::composite_features::described(gpu, level.top()))
                    .expect("the device describes")
            })
            .collect();
        println!(
            "  corners a frame: {:?}",
            described.iter().map(|d| d.at.len()).collect::<Vec<_>>()
        );
        // `all` is every pair, for reading the gap between what is true and what is not across a
        // whole set rather than on the handful somebody already suspected.
        let asked: Vec<(usize, usize)> = match which.as_str() {
            "all" => (0..planes.len())
                .flat_map(|a| (a + 1..planes.len()).map(move |b| (a, b)))
                .collect(),
            named => named
                .split(',')
                .map(|name| {
                    let (a, b) = name
                        .split_once('-')
                        .expect("PANO_PROBE_FEATURES=<a>-<b>,...");
                    (a.parse().expect("a source"), b.parse().expect("a source"))
                })
                .collect(),
        };
        println!("\n  pair   corners matched   of ours   median ratio   clearly");
        for (a, b) in asked {
            let pairs = rawshim::composite_features::paired(&described[a], &described[b]);
            let mut ratios: Vec<f64> = pairs.iter().map(|p| p.over).collect();
            ratios.sort_by(f64::total_cmp);
            let middle = ratios.get(ratios.len() / 2).copied().unwrap_or(f64::NAN);
            // The median is censored - `paired` already drops anything over `DISTINCT_ENOUGH`, so
            // the middle of what survives piles up just under it and says little. What is not
            // censored is how many corners matched one place *clearly*, against the frame's own
            // count of them.
            let clearly = ratios.iter().filter(|over| **over <= 0.6).count();
            println!(
                "  {a}-{b}        {:>5}          {:.3}         {middle:.3}      {:.3}",
                pairs.len(),
                pairs.len() as f64 / described[a].at.len().max(1) as f64,
                clearly as f64 / described[a].at.len().max(1) as f64,
            );
        }
        return;
    }

    if let Ok(which) = std::env::var("PANO_PROBE_DRAW") {
        let (a, b) = which.split_once('-').expect("PANO_PROBE_DRAW=<a>-<b>");
        let (a, b) = (a.parse().expect("a source"), b.parse().expect("a source"));
        draw(&paths, &planes, a, b, &format!("/tmp/matches-{a}-{b}.jpg"));
        return;
    }

    // The table searches every pair, and so does the align below it - the same work twice, which
    // on a set of twenty-six is two minutes rather than one. `PANO_PROBE_SOLVE` is for a run that
    // only wants the answer.
    let pyramids: Vec<Pyramid> = match std::env::var_os("PANO_PROBE_SOLVE") {
        Some(_) => Vec::new(),
        None => planes.iter().map(|plane| Pyramid::of(gpu, plane)).collect(),
    };
    println!(
        "\n  pair          dx     dy   score  overlap  matches  agreeing  share    peak  strong  spread   along   scale   rigid   tight  tight90"
    );
    for a in 0..pyramids.len() {
        for b in a + 1..pyramids.len() {
            let found = pollster::block_on(coarse(
                gpu,
                pyramids[a].coarse(),
                pyramids[b].coarse(),
                0.05,
            ));
            let Some(found) = found else {
                println!("  {a}-{b}: the device declined the search");
                continue;
            };
            let refine = pollster::block_on(refined(gpu, &pyramids[a], &pyramids[b], found));
            let (matches, sampled) = (refine.found, refine.sampled);
            // What the solve is fitted from, against what the search offered it.
            let agreeing = refine.settled.len() as f64 / matches.len().max(1) as f64;
            // The share is what the align gates on: a correlation says two frames look alike, this
            // says how much of what they claim to share actually corresponds.
            let share = matches.len() as f64 / (sampled as f64 * found.overlap).max(1.0);
            // What each correspondence actually correlated to, at the preview's own size rather
            // than the 202px plane the coarse score is measured on.
            let mut peaks: Vec<f64> = matches.iter().map(|m| m.peak).collect();
            peaks.sort_by(f64::total_cmp);
            let peak = peaks.get(peaks.len() / 2).copied().unwrap_or(0.0);
            let strong =
                peaks.iter().filter(|p| **p > 0.9).count() as f64 / peaks.len().max(1) as f64;
            let (spread, along) = covered(
                &matches,
                &planes[a],
                &planes[b],
                found,
                pyramids[a].coarse_scale(),
            );
            let (from, mapping) = deviations(&matches);
            // Two frames a rotation apart map to each other by very nearly a similarity, so the
            // linear part should scale by one and hold its angles. A model fitted to a coincidence
            // answers to a handful of points and need not.
            let scale = (mapping[0] * mapping[4] - mapping[1] * mapping[3])
                .abs()
                .sqrt();
            let rigid = (mapping[0] - mapping[4]).abs() + (mapping[1] + mapping[3]).abs();
            let tight =
                from.iter().filter(|d| **d <= 8.0).count() as f64 / from.len().max(1) as f64;
            // The same, over only the correspondences that locked on hard: if the junk is what the
            // peak already knows about, keeping the strong ones alone is the whole fix.
            let locked: Vec<rawshim::composite_pairs::Match> =
                matches.iter().filter(|m| m.peak > 0.9).copied().collect();
            let (apart, _) = deviations(&locked);
            let tight90 =
                apart.iter().filter(|d| **d <= 8.0).count() as f64 / apart.len().max(1) as f64;
            println!(
                "  {a}-{b}      {:5}  {:5}   {:.3}    {:.3}   {:>6}  {agreeing:.3}  {share:.3}   {peak:.3}  {strong:.3}  {spread:.3}  {along:.3}  {scale:.4}  {rigid:.4}  {tight:.3}  {tight90:.3}",
                found.dx,
                found.dy,
                found.score,
                found.overlap,
                matches.len(),
            );
        }
    }

    println!();
    let whole = std::time::Instant::now();
    let answer = pollster::block_on(rawshim::composite_align::align(
        gpu,
        &sources,
        rawshim::composite_solve::Leash::Free,
        rawshim::composite_align::Kind::Pan,
    ));
    println!(
        "align: {:.0}ms for {} sources",
        whole.elapsed().as_secs_f64() * 1000.0,
        sources.len()
    );
    match answer {
        Ok(aligned) => {
            let p = &aligned.composition;
            println!(
                "aligned: {} sources, {:?} canvas {}x{}, focal {:.0}, rms {:.2}px",
                p.sources.len(),
                p.projection,
                p.canvas[0],
                p.canvas[1],
                p.sources[0].focal,
                aligned.rms_px
            );
            println!(
                "  framing: crop [{:.3}, {:.3}, {:.3}, {:.3}], frames climb {:.2}deg across the canvas",
                p.crop[0],
                p.crop[1],
                p.crop[2],
                p.crop[3],
                climb(p)
            );
            // Where each frame's centre lands on the canvas, as fractions of it: which frame is in
            // the part of a finished panorama that looks wrong is otherwise a guess.
            for (at, source) in p.sources.iter().enumerate() {
                let ray = rawshim::composition::rotate(source.rotation, [0.0, 0.0, 1.0]);
                let on = rawshim::composition::ray_to_canvas(p, ray);
                let (across, down) = match on {
                    Some(on) => (on[0] / p.canvas[0] as f64, on[1] / p.canvas[1] as f64),
                    None => (f64::NAN, f64::NAN),
                };
                println!(
                    "    {at} ({}): centred {across:.3} across, {down:.3} down",
                    source
                        .photo_id
                        .rsplit('/')
                        .next()
                        .unwrap_or(&source.photo_id),
                );
            }
            println!(
                "  focal in preview pixels: {:.0}",
                p.sources[0].focal / full_scale(&p)
            );
            println!("  pairs it rests on (median reprojection):");
            for (a, b, error) in &aligned.kept {
                println!("    {a}-{b}  {error:.2}px");
            }
            for warning in &aligned.warnings {
                println!("  warning: {warning}");
            }
            // What the solve decided each frame's exposure was against the reference's. A pan shot
            // on manual has none of this to find, so anything but ones here is the chain of
            // measured ratios inventing it - and it compounds, since each is walked off its
            // neighbour. `PANO_PROBE_NO_GAIN` renders with every one of them set back to one.
            println!(
                "  gains: {}",
                p.sources
                    .iter()
                    .map(|s| format!("{:.3}", s.gain))
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            if let Ok(to) = std::env::var("PANO_PROBE_RENDER") {
                let mut recipe = aligned.composition.clone();
                if std::env::var_os("PANO_PROBE_NO_GAIN").is_some() {
                    for source in &mut recipe.sources {
                        source.gain = 1.0;
                    }
                }
                // The composite is graded through the reference's own camera match, so which frame
                // that is decides the colour of the whole canvas. `PANO_PROBE_REFERENCE` moves it,
                // for asking whether a frame's colour in the panorama is its own or its
                // neighbour's.
                if let Some(at) = std::env::var("PANO_PROBE_REFERENCE")
                    .ok()
                    .and_then(|v| v.parse::<usize>().ok())
                    .filter(|at| *at < recipe.sources.len())
                {
                    recipe.reference = at;
                }
                render(&recipe, &to);
            }
        }
        Err(why) => println!("refused: {why}"),
    }
}

/// The panorama itself, rendered through the job every rendition goes through and handed over as
/// a JPEG somebody can look at.
/// A composition as `CompositeJob::recipe` reads one: the server's own `kind` beside its fields.
fn tagged(recipe: &rawshim::composition::Composition) -> serde_json::Value {
    let mut value = serde_json::to_value(recipe).expect("a recipe");
    value["kind"] = serde_json::Value::String("panorama".into());
    value
}

fn render(recipe: &rawshim::composition::Composition, to: &str) {
    // The recipe's own sources, in its order: an align that left a photograph out answers a recipe
    // shorter than the set it was handed, and the render is indexed against the recipe.
    //
    // **With an analysis each, or the picture this writes is not one a library would serve.** The
    // catalogue keeps a camera match per photograph and the composite is graded through it; handing
    // the job nothing means there is none to apply, and a panorama graded on the neutral arm comes
    // back pale and flat beside every single-photograph render. Measured on one frame's cloud: with
    // its match the chromaticity is r 0.405 / b 0.263, the same frame rendered `--no-match` is
    // 0.365 / 0.300, and a panorama with no analyses is 0.355 / 0.309 - so the probe was showing a
    // fault it had introduced itself. `PANO_PROBE_NO_MATCH` leaves them out, for seeing that.
    let matching = std::env::var_os("PANO_PROBE_NO_MATCH").is_none();
    let sources: Vec<serde_json::Value> = recipe
        .sources
        .iter()
        .map(|source| {
            let analysis = match matching {
                true => analysis_for(&source.photo_id),
                false => None,
            };
            match analysis {
                Some(bytes) => serde_json::json!({
                    "photoId": source.photo_id,
                    "rawFilePath": source.photo_id,
                    "photoAnalysis": bytes,
                }),
                None => serde_json::json!({
                    "photoId": source.photo_id,
                    "rawFilePath": source.photo_id,
                }),
            }
        })
        .collect();
    let avif = format!("{to}.avif");
    // What a rendition does with the recipe's framing, and an export does not: level the pan and
    // trim the wedges of nothing it leaves at the corners. `PANO_PROBE_WHOLE` asks for the canvas
    // as it stands, which is what the DNG will take.
    let whole = std::env::var("PANO_PROBE_WHOLE").is_ok();
    // `PANO_PROBE_CROP=left,top,right,bottom` in fractions of the canvas, for reading a seam at
    // something like the resolution it is actually rendered at: the whole of a 36000px canvas in a
    // picture somebody can open is 30 canvas pixels a pixel, which is where a seam goes to hide.
    let asked: Option<[f64; 4]> = std::env::var("PANO_PROBE_CROP").ok().and_then(|text| {
        let parts: Vec<f64> = text
            .split(',')
            .filter_map(|v| v.trim().parse().ok())
            .collect();
        <[f64; 4]>::try_from(parts).ok()
    });
    let crop = match (asked, whole) {
        (Some(asked), _) => asked,
        (None, true) => [0.0, 0.0, 1.0, 1.0],
        (None, false) => recipe.crop,
    };
    let job: rawshim::job::Job = serde_json::from_value(serde_json::json!({
        "rawFilePath": recipe.sources[0].photo_id,
        "cameraMatch": "none",
        "denoiseLuminance": 0.0,
        "denoiseColour": 0.0,
        "sharpen": 0.0,
        "defringe": 0.0,
        // **The library's own quantile, 0.9.** Anchoring diffuse white at the 99th percentile puts
        // it on content that is nearly the scene's peak, and everything below is lifted to meet it:
        // measured on one frame's own band against a normal render of the same photograph, 0.99 is
        // 1.5x the light and puts the highlights at 0.94 where 0.9 leaves them at 0.69 - a cloud
        // with its modelling flattened out of it. `settings.ts` calls this `hdr_white_quantile` and
        // `renders` takes the same number, so a picture out of this probe is one a rendition would
        // have written rather than one only the probe ever sees.
        "grade": { "peakNits": 1000.0, "referenceWhiteNits": 203.0, "whiteQuantile": 0.9 },
        "geometry": { "crop": crop, "angleDegrees": 0.0, "rotate": 0, "keystone": null },
        "targets": [{
            "rendition": "full",
            "output": "srgb",
            "outputPath": avif,
            "size": std::env::var("PANO_PROBE_SIZE").ok().and_then(|s| s.parse::<u32>().ok()).unwrap_or(2400),
            "source": std::env::var("PANO_PROBE_FROM").unwrap_or_else(|_| "render".into()),
            "sdrQuantizer": 26,
            "hdrQuantizer": 26,
            "preset": 6,
            // A grid tile is 4:2:0, which is a different path through the encoder and the one a
            // merge takes first.
            "stillFullChroma": std::env::var("PANO_PROBE_420").is_err(),
            "sdrFullChroma": std::env::var("PANO_PROBE_420").is_err(),
        }],
        "composite": {
            "sources": sources,
            "want": "render",
            "recipe": tagged(recipe),
        },
    }))
    .expect("a job");

    match rawshim::job::run(&job) {
        Ok(_) => {
            let bytes = std::fs::read(&avif).expect("the render was written");
            let decoded = rawshim::image::decode(&bytes, 0).expect("the render decodes");
            let jpeg = rawshim::jpeg::encode(decoded.as_ref(), 88).expect("a jpeg");
            std::fs::write(to, jpeg).expect("a writable path");
            println!("  wrote {to}");
            outlined(
                recipe,
                decoded.as_ref(),
                crop,
                &format!("{to}-outlined.jpg"),
            );
        }
        Err(why) => println!("  the render refused: {why}"),
    }
}

/// The same picture with every source's own frame drawn on it, numbered by its place in the recipe.
///
/// Which frame is where is the question a seam actually asks, and reading it off a list of centres
/// is guesswork: this puts the answer on the picture.
fn outlined(
    recipe: &rawshim::composition::Composition,
    picture: rawshim::rgb::RgbRef<'_>,
    crop: [f64; 4],
    to: &str,
) {
    let mut out = picture.data.to_vec();
    let (wide, tall) = (picture.width, picture.height);
    // The render is the cropped window of the canvas, scaled to whatever size was asked for.
    let (canvas_w, canvas_h) = (recipe.canvas[0] as f64, recipe.canvas[1] as f64);
    let (left, top) = (crop[0] * canvas_w, crop[1] * canvas_h);
    let scale = wide as f64 / ((crop[2] - crop[0]) * canvas_w);

    let mut canvas = Sheet {
        data: &mut out,
        wide,
        tall,
    };
    for (at, source) in recipe.sources.iter().enumerate() {
        let (sw, sh) = (source.size[0] as f64, source.size[1] as f64);
        // A source pixel to a ray in its own camera, then through its rotation onto the canvas.
        let onto = |x: f64, y: f64| -> Option<[f64; 2]> {
            let ray = [x - sw / 2.0, y - sh / 2.0, source.focal];
            let world = rawshim::composition::rotate(source.rotation, ray);
            let on = rawshim::composition::ray_to_canvas(recipe, world)?;
            Some([(on[0] - left) * scale, (on[1] - top) * scale])
        };
        let pen = PEN[at % PEN.len()];
        // Walked rather than joined corner to corner: every projection here bends a straight edge.
        for (from, to) in [
            ((0.0, 0.0), (sw, 0.0)),
            ((sw, 0.0), (sw, sh)),
            ((sw, sh), (0.0, sh)),
            ((0.0, sh), (0.0, 0.0)),
        ] {
            let mut last: Option<[f64; 2]> = None;
            for i in 0..=64 {
                let t = f64::from(i) / 64.0;
                let point = onto(from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t);
                if let (Some(a), Some(b)) = (last, point) {
                    canvas.line(a, b, pen);
                }
                last = point;
            }
        }
        if let Some(centre) = onto(sw / 2.0, sh / 2.0) {
            canvas.digits(centre, at, pen);
        }
    }

    let drawn = rawshim::rgb::RgbRef {
        data: &out,
        width: wide,
        height: tall,
    };
    let jpeg = rawshim::jpeg::encode(drawn, 92).expect("a jpeg");
    std::fs::write(to, jpeg).expect("a writable path");
    println!("  wrote {to}");
}

/// Enough colours that two frames meeting are never drawn the same.
const PEN: [[u8; 3]; 6] = [
    [255, 60, 60],
    [60, 255, 60],
    [80, 160, 255],
    [255, 230, 60],
    [255, 120, 255],
    [80, 255, 230],
];

/// A 3x5 cell per digit, as five rows of three bits.
const GLYPHS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];

/// The picture being drawn on.
struct Sheet<'a> {
    data: &'a mut [u8],
    wide: usize,
    tall: usize,
}

impl Sheet<'_> {
    fn put(&mut self, x: i64, y: i64, rgb: [u8; 3]) {
        if x < 0 || y < 0 || x >= self.wide as i64 || y >= self.tall as i64 {
            return;
        }
        let at = (y as usize * self.wide + x as usize) * 3;
        self.data[at..at + 3].copy_from_slice(&rgb);
    }

    fn line(&mut self, a: [f64; 2], b: [f64; 2], rgb: [u8; 3]) {
        let steps = ((b[0] - a[0]).abs().max((b[1] - a[1]).abs()).ceil() as i64).max(1);
        for i in 0..=steps {
            let t = i as f64 / steps as f64;
            let (x, y) = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
            for thick in -1..=1 {
                self.put(x as i64 + thick, y as i64, rgb);
                self.put(x as i64, y as i64 + thick, rgb);
            }
        }
    }

    fn dot(&mut self, at: (f64, f64), colour: [u8; 3]) {
        for dy in -2i64..=2 {
            for dx in -2i64..=2 {
                self.put(at.0 as i64 + dx, at.1 as i64 + dy, colour);
            }
        }
    }

    /// One pixel wide where `line` is three, so a field of correspondences does not draw as a block.
    fn thin_line(&mut self, from: (f64, f64), to: (f64, f64), colour: [u8; 3]) {
        let (dx, dy) = (to.0 - from.0, to.1 - from.1);
        let steps = dx.abs().max(dy.abs()).max(1.0) as i64;
        for step in 0..=steps {
            let t = step as f64 / steps as f64;
            self.put((from.0 + dx * t) as i64, (from.1 + dy * t) as i64, colour);
        }
    }

    fn digits(&mut self, at: [f64; 2], value: usize, rgb: [u8; 3]) {
        const CELL: i64 = 5;
        let text = value.to_string();
        let width = text.len() as i64 * 4 * CELL;
        let (ox, oy) = (at[0] as i64 - width / 2, at[1] as i64 - 5 * CELL / 2);
        for (place, digit) in text.bytes().enumerate() {
            let glyph = GLYPHS[usize::from(digit - b'0')];
            for (row, bits) in glyph.iter().enumerate() {
                for column in 0..3 {
                    if bits & (1 << (2 - column)) == 0 {
                        continue;
                    }
                    for dy in 0..CELL {
                        for dx in 0..CELL {
                            let x = ox + place as i64 * 4 * CELL + column * CELL + dx;
                            let y = oy + row as i64 * CELL + dy;
                            // Outlined in black so a number stays readable over sky or over a roof.
                            for edge in [-1, 1] {
                                self.put(x + edge, y, [0, 0, 0]);
                                self.put(x, y + edge, [0, 0, 0]);
                            }
                            self.put(x, y, rgb);
                        }
                    }
                }
            }
        }
    }
}

/// Two frames side by side with the correspondences between them drawn on, coloured by how hard
/// each one locked: green past 0.9, amber past 0.8, red below.
///
/// `PANO_PROBE_DRAW=17-20` names the pair. What it is for is the question no number here answers -
/// whether the points a pair rests on are the same piece of the world, or the same *kind* of piece
/// in two places, which is what a scene that repeats offers and what every measure in the table has
/// to be argued about.
fn draw(paths: &[String], planes: &[rawshim::hdr_fit::Source], a: usize, b: usize, to: &str) {
    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    let long = |at: usize| planes[at].width.max(planes[at].height);
    let Some(left) = rawshim::decode_rawler::upright_preview_rgb(
        &paths[a],
        long(a),
        rawshim::decode_rawler::Preview::for_the_match(),
    ) else {
        println!("  {} embeds no preview", paths[a]);
        return;
    };
    let Some(right) = rawshim::decode_rawler::upright_preview_rgb(
        &paths[b],
        long(b),
        rawshim::decode_rawler::Preview::for_the_match(),
    ) else {
        println!("  {} embeds no preview", paths[b]);
        return;
    };

    let ours = Pyramid::of(gpu, &planes[a]);
    let theirs = Pyramid::of(gpu, &planes[b]);
    let Some(found) = pollster::block_on(coarse(gpu, ours.coarse(), theirs.coarse(), 0.05)) else {
        println!("  the device declined the search");
        return;
    };
    let matches = pollster::block_on(refined(gpu, &ours, &theirs, found)).settled;
    println!(
        "  {a}-{b}: {} correspondences at {:?}",
        matches.len(),
        (found.dx, found.dy)
    );

    // **Laid out where the frames actually sit, which is not the order they were shot in.** The
    // search states `a`'s coordinate minus `b`'s, so the sign of it says which frame is further
    // along - and a serpentine pan walks its second row backwards, so half of its pairs are numbered
    // against the direction they lie in. Drawn by index those come out with every correspondence
    // crossing the whole picture, which reads as a wild answer when it is only a mirrored one.
    const GAP: usize = 24;
    let sideways = found.dx.abs() >= found.dy.abs();
    let (first, second) = match sideways {
        true => (found.dx < 0, "left"),
        false => (found.dy < 0, "above"),
    };
    // `first` is whether b comes first; the offsets then follow from which picture is drawn first.
    let (ours, theirs) = match first {
        true => (&right, &left),
        false => (&left, &right),
    };
    println!(
        "  {} is {second}, {} is the other",
        match first {
            true => b,
            false => a,
        },
        match first {
            true => a,
            false => b,
        }
    );
    let (width, height) = match sideways {
        true => (
            ours.width + GAP + theirs.width,
            ours.height.max(theirs.height),
        ),
        false => (
            ours.width.max(theirs.width),
            ours.height + GAP + theirs.height,
        ),
    };
    let mut out = vec![0u8; width * height * 3];
    let mut blit = |picture: &rawshim::rgb::Rgb, at: (usize, usize)| {
        for y in 0..picture.height {
            for x in 0..picture.width {
                let from = (y * picture.width + x) * 3;
                let into = ((at.1 + y) * width + at.0 + x) * 3;
                out[into..into + 3].copy_from_slice(&picture.data[from..from + 3]);
            }
        }
    };
    let step_on = match sideways {
        true => (ours.width + GAP, 0),
        false => (0, ours.height + GAP),
    };
    blit(ours, (0, 0));
    blit(theirs, step_on);

    // Enough to read the shape of the correspondence field without the lines becoming a solid block.
    let step = (matches.len() / 160).max(1);
    let away = (step_on.0 as f64, step_on.1 as f64);
    let (from, agreed) = deviations(&matches);
    let mut sorted = from.clone();
    sorted.sort_by(f64::total_cmp);
    println!(
        "  agreed mapping: {:.0},{:.0} px and {:.2} degrees of roll; from it, median {:.1}px and {:.0}% within 8px",
        agreed[2],
        agreed[5],
        agreed[3].atan2(agreed[0]).to_degrees(),
        sorted.get(sorted.len() / 2).copied().unwrap_or(0.0),
        100.0 * from.iter().filter(|d| **d <= 8.0).count() as f64 / from.len().max(1) as f64,
    );
    let mut sheet = Sheet {
        data: &mut out,
        wide: width,
        tall: height,
    };
    for (m, off) in matches.iter().zip(&from).step_by(step) {
        let colour = match off {
            d if *d <= 4.0 => [40u8, 230, 60],
            d if *d <= 16.0 => [250, 200, 40],
            _ => [240, 50, 50],
        };
        // Whichever of the two is drawn second is the one the offset is added to.
        let (here, there) = match first {
            true => ((m.b[0], m.b[1]), (m.a[0] + away.0, m.a[1] + away.1)),
            false => ((m.a[0], m.a[1]), (m.b[0] + away.0, m.b[1] + away.1)),
        };
        sheet.thin_line(here, there, colour);
        sheet.dot(here, colour);
        sheet.dot(there, colour);
    }

    let picture = rawshim::rgb::RgbRef {
        width,
        height,
        data: &out,
    };
    let jpeg = rawshim::jpeg::encode(picture, 90).expect("a jpeg");
    std::fs::write(to, jpeg).expect("a writable path");
    println!("  wrote {to}");
}

/// How far each correspondence sits from the offset the pair agrees on, and the middle of that.
///
/// **Two frames a rotation apart are very nearly one translation apart.** So the offsets a true pair
/// reports are all the same offset, give or take the roll and the perspective across the overlap,
/// and a correspondence that disagrees with the rest by tens of pixels is one feature matched to a
/// different instance of itself. The refine already drops a point that disagrees with its own tile,
/// which is a local test - this is the whole field against itself, which a coincidence spread over
/// two unrelated frames cannot pass.
fn deviations(matches: &[rawshim::composite_pairs::Match]) -> (Vec<f64>, [f64; 6]) {
    // The same mapping the search itself keeps points by, so what is drawn is what was judged - and
    // an affine rather than a median offset, or a frame rolled a degree against its pair reads as a
    // steadily worsening disagreement along the seam, which is the roll and not a bad match.
    let Some(mapping) = rawshim::composite_pairs::consensus(matches) else {
        return (vec![0.0; matches.len()], [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
    };
    let from = matches
        .iter()
        .map(|m| rawshim::composite_pairs::apart(&mapping, m))
        .collect();
    (from, mapping)
}

/// How much of the region a pair claims to share its correspondences are actually spread over.
///
/// Not their density, which is what `share` is: a hundred matches down a whole edge and a hundred
/// piled in one corner are the same number and a very different claim, and the second is what a
/// scene that repeats produces - one feature meeting the wrong instance of itself.
fn covered(
    matches: &[rawshim::composite_pairs::Match],
    a: &rawshim::hdr_fit::Source,
    b: &rawshim::hdr_fit::Source,
    found: rawshim::composite_pairs::Coarse,
    // The coarse translation is stated on the smallest level of the pyramid; the matches are on the
    // largest, which is the preview itself.
    up: usize,
) -> (f64, f64) {
    let (dx, dy) = (found.dx * up as i32, found.dy * up as i32);
    let (aw, ah) = (a.width as i32, a.height as i32);
    let (bw, bh) = (b.width as i32, b.height as i32);
    // What of `a` the claim says `b` also saw.
    let (left, right) = (dx.max(0), (bw + dx).min(aw));
    let (top, bottom) = (dy.max(0), (bh + dy).min(ah));
    if right <= left || bottom <= top {
        return (0.0, 0.0);
    }

    const CELLS: i32 = 12;
    let (wide, tall) = (right - left, bottom - top);
    let mut hit = vec![false; (CELLS * CELLS) as usize];
    // And along the seam alone: two frames side by side share a tall strip, and what says the strip
    // is really shared is correspondences down the whole length of it rather than a blob at one end.
    let mut band = vec![false; CELLS as usize];
    for m in matches {
        let (x, y) = (m.a[0] as i32 - left, m.a[1] as i32 - top);
        if x < 0 || y < 0 || x >= wide || y >= tall {
            continue;
        }
        hit[((y * CELLS / tall) * CELLS + (x * CELLS / wide)) as usize] = true;
        band[match tall >= wide {
            true => (y * CELLS / tall) as usize,
            false => (x * CELLS / wide) as usize,
        }] = true;
    }
    let spread = hit.iter().filter(|h| **h).count() as f64 / hit.len() as f64;
    let along = band.iter().filter(|h| **h).count() as f64 / band.len() as f64;
    (spread, along)
}

/// The plane to search this photograph on, where `PANO_PROBE_PLANES` names a directory holding
/// one per file stem: the server's equivalent is the grid tile, when that tile is the camera's
/// own JPEG.
fn plane_for(path: &str) -> Option<String> {
    let dir = std::env::var("PANO_PROBE_PLANES").ok()?;
    let stem = std::path::Path::new(path).file_stem()?.to_str()?;
    // A tile is AVIF; a JPEG is what `PANO_PROBE_DUMP` writes, which is how the two sources are
    // held against each other on the same picture.
    ["avif", "jpg"]
        .iter()
        .map(|extension| format!("{dir}/{stem}.{extension}"))
        .find(|plane| std::fs::exists(plane).unwrap_or(false))
}

/// What the body says its focal is, in this photograph's own pixels.
fn focal_px(path: &str) -> Option<f64> {
    let header = rawshim::header::read_path(path)?;
    let crop = rawshim::lensfun::crop_factor(
        rawshim::header::name(&header.camera_make),
        rawshim::header::name(&header.camera_model),
    )?;
    (header.focal > 0.0)
        .then(|| f64::from(header.focal) * crop * header.width.max(header.height) as f64 / 36.0)
}

/// How far the frames' own centres climb across the canvas, in degrees.
///
/// The visible symptom of a panorama that was not levelled: the frames make a staircase that runs
/// uphill, and the horizon in them runs with it. Near zero is what `composite_solve::straighten` is for,
/// and a residual here is the levelling's error rather than the solve's.
fn climb(p: &rawshim::composition::Composition) -> f64 {
    let centres: Vec<[f64; 2]> = p
        .sources
        .iter()
        .filter_map(|source| {
            rawshim::composition::ray_to_canvas(
                p,
                rawshim::composition::rotate(source.rotation, [0.0, 0.0, 1.0]),
            )
        })
        .collect();
    if centres.len() < 2 {
        return 0.0;
    }
    let n = centres.len() as f64;
    let mean = |axis: usize| centres.iter().map(|c| c[axis]).sum::<f64>() / n;
    let (mx, my) = (mean(0), mean(1));
    let across: f64 = centres.iter().map(|c| (c[0] - mx) * (c[0] - mx)).sum();
    let along: f64 = centres.iter().map(|c| (c[0] - mx) * (c[1] - my)).sum();
    match across < 1e-9 {
        true => 0.0,
        false => (along / across).atan().to_degrees(),
    }
}

/// Full-resolution source pixels per preview pixel, which is what the recipe's focal is scaled by.
fn full_scale(p: &rawshim::composition::Composition) -> f64 {
    let source = &p.sources[0];
    source.size[0].max(source.size[1]) as f64 / rawshim::px::TUNED_ON as f64
}

/// The JPEG the search's plane is built from, for a reader who wants to see what it was given.
fn write_preview(to: &str, from: &str) {
    let want = rawshim::decode_rawler::Preview::for_the_match();
    let Some(jpeg) = rawshim::decode_rawler::upright_preview_jpeg(from, want) else {
        println!("  {from} embeds no preview");
        return;
    };
    std::fs::write(to, jpeg).expect("a writable path");
    println!("  wrote {to}");
}

/// What the catalogue would have kept about one photograph: its camera match and the levels that
/// match was fitted against.
///
/// Fitted off a bounded decode rather than the whole frame, which is what makes it affordable to do
/// for every source of a set - the match is a colour, and a colour does not want every pixel.
fn analysis_for(path: &str) -> Option<Vec<u8>> {
    const FITTED_ON: u32 = 1600;
    let gpu = rawshim::gpu::device()?;
    let frame = rawshim::decode::frame_from_path(
        path,
        rawshim::galosh::Detail::at(0.0, 0.0),
        FITTED_ON,
        false,
        rawshim::galosh::Fit::Measure,
        rawshim::dust::Wanted::Off,
    )?;
    let resident = frame.on_device(gpu)?;
    let (matched, levels) = rawshim::fit_hdr_measured(&resident, path, WHITE_QUANTILE, rawshim::hdr_fit::CameraMatch::LensAndColour)?;
    let mut analysis = rawshim::photo_analysis::PhotoAnalysis::default();
    analysis.from_raw.matched = Some(matched);
    analysis.from_render.levels = Some(rawshim::photo_analysis::MeasuredLevels {
        levels,
        white_quantile: WHITE_QUANTILE,
    });
    Some(rawshim::photo_analysis::encode(&analysis))
}

/// The library's own, as `settings.ts` sets it: the number a rendition would be graded at.
const WHITE_QUANTILE: f64 = 0.9;

/// The photograph's own size, as the catalogue would have it.
fn size_of(path: &str) -> [usize; 2] {
    let header = match rawshim::decode_rendered::is_rendered(path) {
        true => rawshim::header::read_rendered(path),
        false => rawshim::header::read_path(path),
    };
    header.map_or([0, 0], |h| [h.width as usize, h.height as usize])
}
