//! N RAWs of a burst through `assembly_analysis::analyse`, and the seams a drawn seed grows.
//!
//! ```text
//! assemble <a.ARW> <b.ARW> [more...] [--pick N] [--out <dir>] [--planes <dir>]
//!          [--draw x0,y0,x1,y1] [--focal px] [--layers <dir>] [--long N]
//!          [--sharpen F] [--detail N|auto]
//! ```
//!
//! Runs the whole of §3, align to seam field, and times it. Each `--draw` rectangle then seeds a
//! tile taking `--pick`, the seams are solved, and the pieces are drawn over the composite.
//! `--layers <dir>` instead renders one layer a source through §5, as the merge page is given them.
//!
//! A rectangle is in the *analysis plane's* pixels, which the run prints before it needs them.
//! `--planes <dir>` searches `<dir>/<stem>.jpg` for the alignment's plane, as the server's grid tile
//! stands in for a camera's JPEG - which is what a synthetic DNG needs, having no preview embedded.

use rawshim::assembly_planes::Plane;
use rawshim::composite_tile::{Blending, Layer, SourceFile};

fn main() {
    let args = Args::parse();
    std::fs::create_dir_all(&args.out).expect("the output directory");
    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    let base = rawshim::base::device(gpu).expect("the base pipelines");

    let planes_from: Vec<Option<String>> = args
        .raws
        .iter()
        .map(|path| plane_for(&args, path))
        .collect();
    // One fit for the lens the burst was shot on, handed to the first frame: `shared_lenses` gives
    // every member of the group that one answer, and a group with none is `Refused::Lensless`.
    let fitted = fitted_lens(&args.raws[0]);
    let sources: Vec<rawshim::composite_align::AlignSource<'_>> = args
        .raws
        .iter()
        .zip(&planes_from)
        .enumerate()
        .map(|(at, (path, plane))| {
            // The metering, because the recipe's per-source gain is *only* ever what the headers
            // say - `align` hands `gains` no measured ratios at all - so a caller that leaves these
            // out is asking about a step with the correction switched off.
            let header = rawshim::header::read_path(path);
            let said = |of: fn(&rawshim::header::BbHeader) -> f32| {
                header.as_ref().map(of).filter(|v| *v > 0.0)
            };
            rawshim::composite_align::AlignSource {
                photo_id: path,
                path,
                preview_path: plane.as_deref(),
                analysis: (at == 0).then(|| fitted.as_deref()).flatten(),
                size: size_of(path),
                camera_model: None,
                lens_model: None,
                focal_length: None,
                focal_px: args.focal.or_else(|| focal_px(path)),
                shutter: said(|h| h.shutter),
                aperture: said(|h| h.aperture),
                iso: said(|h| h.iso),
            }
        })
        .collect();
    for (path, source) in args.raws.iter().zip(&sources) {
        println!(
            "{path}: {:?}, {:?}s f/{:?} ISO {:?}, focal {:?}px",
            source.size, source.shutter, source.aperture, source.iso, source.focal_px,
        );
    }
    match args.layers.clone() {
        Some(dir) => layers(&sources, &args, &dir),
        None => auto(gpu, base, &sources, &args),
    }
}

/// **The whole of §3, end to end**: [`rawshim::assembly_analysis::analyse`] is the align, the
/// intersection crop, the plane gather and the seam field stitched together. Each `--draw`
/// rectangle then seeds a tile taking `--pick`.
fn auto(
    gpu: &'static rawshim::gpu::Gpu,
    base: &'static rawshim::base::Base,
    sources: &[rawshim::composite_align::AlignSource<'_>],
    args: &Args,
) {
    let started = std::time::Instant::now();
    let analysed = match pollster::block_on(rawshim::assembly_analysis::analyse(sources)) {
        Ok(found) => found,
        Err(refused) => {
            println!("\nrefused: {refused:?}");
            std::process::exit(1);
        }
    };
    let whole = started.elapsed().as_secs_f64();
    let assembly = &analysed.assembly;
    let spec = &assembly.spec;
    println!("\nanalyse: {whole:.1}s");
    println!(
        "  {:?} canvas {}x{}, focal {:.0}px, reference {}, crop {:?}",
        spec.projection,
        spec.canvas[0],
        spec.canvas[1],
        spec.sources[0].focal,
        spec.reference,
        spec.crop.map(|v| (v * 1e4).round() / 1e4),
    );
    for (at, source) in spec.sources.iter().enumerate() {
        println!(
            "  {at} {}: gain {:.4}, rotation {:?}",
            name_of(&source.photo_id),
            source.gain,
            source.rotation.map(|v| (v * 1e4).round() / 1e4),
        );
    }
    for warning in &analysed.warnings {
        println!("  warning: {warning}");
    }
    println!(
        "  §3.1's corner check: {:.3} analysis px of radial pattern, against a bound of {:?}{}",
        analysed.radial.map_or(f64::NAN, |radial| {
            let plane = rawshim::assembly_planes::ANALYSIS_LONG;
            radial.across(rawshim::px::Span::<rawshim::px::Analysis>::exact(plane)).raw()
        }),
        rawshim::assembly_analysis::NEAR_IDENTITY,
        if analysed.unaligned { " - unaligned" } else { "" },
    );

    let stored: Vec<Option<rawshim::photo_analysis::PhotoAnalysis>> = spec
        .sources
        .iter()
        .map(|held| {
            sources
                .iter()
                .find(|offered| offered.photo_id == held.photo_id)
                .and_then(|offered| offered.analysis)
                .and_then(rawshim::photo_analysis::decode)
        })
        .collect();
    let files: Vec<SourceFile<'_>> = spec
        .sources
        .iter()
        .zip(&stored)
        .map(|(source, held)| SourceFile {
            path: &source.photo_id,
            analysis: held.as_ref(),
        })
        .collect();
    let started = std::time::Instant::now();
    let planes = pollster::block_on(rawshim::assembly_planes::analysis_planes(spec, &files))
        .expect("the analysis planes");
    let gathered = started.elapsed().as_secs_f64();
    let started = std::time::Instant::now();
    let again = pollster::block_on(rawshim::assembly_analysis::analysis_of(
        gpu,
        base,
        spec.clone(),
        &planes,
    ))
    .expect("the analysis");
    let field = started.elapsed().as_secs_f64();
    let (width, height) = planes[0].rgb.size();
    // The two halves are timed by running them a second time rather than by instrumenting the
    // library, so they are the same work under the same conditions and not the same *run* - which
    // is why they are not subtracted from the whole.
    println!("\nwhat each stage cost, in seconds (§3.9)");
    println!("  analyse, whole   {whole:>7.1}   align, crop, gather, and the seam field");
    println!(
        "  plane gather     {gathered:>7.1}   {} decodes, GALOSH, RCD, the lens, the resize",
        planes.len()
    );
    println!("  seam field       {field:>7.1}   each frame's level and tint a cell");
    println!(
        "  the planes are {width}x{height}, where the canvas is {}x{}",
        spec.canvas[0], spec.canvas[1]
    );
    if !args.drawn.is_empty() {
        solved(gpu, base, &again, &planes, (width, height), args);
    }
}

/// Each `--draw` rectangle seeded as a tile taking `--pick`, the seams solved for those picks, and
/// the planes composited through the pieces with the pieces outlined and the seeds in a second
/// colour.
fn solved(
    gpu: &'static rawshim::gpu::Gpu,
    base: &'static rawshim::base::Base,
    analysed: &rawshim::assembly_analysis::Analysed,
    planes: &[Plane],
    (width, height): (usize, usize),
    args: &Args,
) {
    let mut recipe = analysed.assembly.clone();
    let pick = args.pick;
    let scale = recipe.spec.canvas[0] as f32 / width as f32;
    let sources = recipe.spec.sources.len();
    // As the merge page appends a seed.
    for &[x0, y0, x1, y1] in &args.drawn {
        let first = recipe.vertices.len() as u32;
        let (x0, y0, x1, y1) = (x0 * scale, y0 * scale, x1 * scale, y1 * scale);
        recipe
            .vertices
            .extend([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
        recipe.tiles.push((first..first + 4).collect());
        recipe.pick.push(pick);
    }
    let moved = recipe.pick.iter().filter(|&&s| s != recipe.base).count();
    let started = std::time::Instant::now();
    let seams = match rawshim::assembly_seams::solve(&recipe, &analysed.volume) {
        Ok(seams) => seams,
        Err(why) => {
            println!("\nsolve refused: {why}");
            return;
        }
    };
    println!(
        "\nsolve: {:.0}ms, {moved} of {} tiles off the base, {} pieces, {} vertices",
        started.elapsed().as_secs_f64() * 1e3,
        recipe.tiles.len(),
        seams.tiles.len(),
        seams.vertices.len(),
    );
    let loops = |vertices: &[[f32; 2]], tiles: &[Vec<u32>]| -> Vec<Vec<[f32; 2]>> {
        tiles
            .iter()
            .map(|tile| {
                tile.iter()
                    .map(|&v| {
                        let [x, y] = vertices[v as usize];
                        [x / scale, y / scale]
                    })
                    .collect()
            })
            .collect()
    };
    let pieces = loops(&seams.vertices, &seams.tiles);
    let mut owner = vec![recipe.base; width * height];
    for (piece, outline) in pieces.iter().enumerate() {
        let mut mask = vec![0f32; width * height];
        rasterise(outline, &mut mask, (width, height));
        for (p, held) in mask.iter().enumerate() {
            if *held > 0.5 {
                owner[p] = seams.source[piece];
            }
        }
    }
    let window = rawshim::px::Rect::<rawshim::px::Composite>::exact(0, 0, width, height);
    let mut blending = Blending::over(gpu, base, window);
    for source in 0..sources {
        let weights: Vec<f32> = owner
            .iter()
            .map(|&s| if s == source { 1.0 } else { 0.0 })
            .collect();
        if weights.iter().all(|w| *w == 0.0) {
            continue;
        }
        let plane = planes
            .iter()
            .find(|p| p.source == source)
            .expect("a plane a source");
        blending.add(Layer {
            rgb: plane.rgb.duplicate(),
            weight: weights_of(gpu, &weights),
        });
    }
    let (out, alpha) = blending.resolve();
    drop(alpha);
    let mut composite = pollster::block_on(out.into_host()).expect("the composite reads back");
    write_avif(
        &format!("{}/solved.avif", args.out),
        &composite,
        width,
        height,
    );
    for outline in &pieces {
        draw_outline(&mut composite, (width, height), outline, PIECE);
    }
    for &[x0, y0, x1, y1] in &args.drawn {
        let outline = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        draw_outline(&mut composite, (width, height), &outline, DRAWN);
    }
    write_avif(
        &format!("{}/solved-outlined.avif", args.out),
        &composite,
        width,
        height,
    );
}

/// The layers the **merge page** draws, one a source, exactly as `buildAssemblyLayer` asks for them.
///
/// The whole crop rendered through §5.2 once per source, with every tile picking that source and
/// the base set to it, and the browser then masking between them - so it is the render whose
/// sharpness answers "is the merge page soft".
fn layers(sources: &[rawshim::composite_align::AlignSource<'_>], args: &Args, dir: &str) {
    let analysed = match pollster::block_on(rawshim::assembly_analysis::analyse(sources)) {
        Ok(found) => found,
        Err(refused) => {
            println!("\nrefused: {refused:?}");
            std::process::exit(1);
        }
    };
    std::fs::create_dir_all(dir).expect("the output directory");
    let recipe = analysed.assembly;
    println!(
        "\n{} sources: a layer each, as the merge page is given them",
        recipe.spec.sources.len(),
    );
    for at in 0..recipe.spec.sources.len() {
        let mut one = recipe.clone();
        one.base = at;
        through_the_render(
            &one.rendered().expect("an untiled recipe draws"),
            &format!("{dir}/layer-{at}.avif"),
            args.long,
            args.sharpen,
            args.detail,
        );
    }
}

/// One recipe, over its own crop, in strips - `assembly_render::lowpass` then `prepared`.
///
/// `long` is the crop's own long edge in output pixels, which is what a rendition size names
/// (`canvasLongEdgeFor`). At the canvas's own scale this is the whole picture at 1:1; below it, the
/// render is the downscale the server asks for, and a measurement taken at 1:1 instead is a
/// measurement of a picture nobody is shown.
fn through_the_render(
    recipe: &rawshim::assembly::Drawing,
    path: &str,
    long: usize,
    sharpen: f64,
    detail: rawshim::galosh::Detail,
) {
    let files: Vec<SourceFile<'_>> = recipe
        .spec
        .sources
        .iter()
        .map(|source| SourceFile {
            path: &source.photo_id,
            analysis: None,
        })
        .collect();
    let [cw, ch] = recipe.spec.canvas;
    let at = |share: f64, of: usize| (share * of as f64).round() as usize;
    let (left, top) = (at(recipe.spec.crop[0], cw), at(recipe.spec.crop[1], ch));
    let (crop_w, crop_h) = (
        at(recipe.spec.crop[2], cw) - left,
        at(recipe.spec.crop[3], ch) - top,
    );
    let scale = (crop_w.max(crop_h) as f64 / long.max(1) as f64).max(1.0);
    let render = |value: usize| ((value as f64 / scale).round() as usize).max(1);
    let (left, top) = (render(left), render(top));
    let (width, height) = (render(crop_w), render(crop_h));
    println!("  crop {crop_w}x{crop_h} of the canvas, rendered {width}x{height}");

    let asking = |window: rawshim::px::Rect<rawshim::px::Composite>, levels| {
        rawshim::composite_tile::CompositeRequest {
            window,
            parts: &[],
            scale,
            white_quantile: 0.99,
            levels,
            reference_white_nits: rawshim::light::Light::exactly(203.0),
            strengths: rawshim::image::Strengths {
                sharpen,
                defringe: 0.0,
            },
            detail,
            sources: &files,
            from: rawshim::composite_tile::From::Original,
            mask: None,
        }
    };
    let whole = rawshim::px::Rect::exact(left, top, width, height);
    let started = std::time::Instant::now();
    let held = pollster::block_on(rawshim::assembly_render::lowpass(
        recipe,
        &asking(whole, None),
    ))
    .expect("the crop's lowpass");
    println!(
        "  lowpass: {:.1}s, {}x{} cells a source",
        started.elapsed().as_secs_f64(),
        held.size.0,
        held.size.1,
    );

    let mut canvas = vec![0u16; width * height * 3];
    let started = std::time::Instant::now();
    let mut row = top;
    while row < top + height {
        let tall = STRIP_ROWS.min(top + height - row);
        let window = rawshim::px::Rect::exact(left, row, width, tall);
        let (out, _) = pollster::block_on(rawshim::assembly_render::prepared(
            recipe,
            &held,
            &asking(window, Some(held.levels)),
        ))
        .expect("a strip of the assembly");
        let codes = pollster::block_on(out.into_host()).expect("a readable strip");
        let to = (row - top) * width * 3;
        canvas[to..to + codes.len()].copy_from_slice(&codes);
        row += tall;
    }
    println!(
        "  render: {:.1}s over {} rows a strip",
        started.elapsed().as_secs_f64(),
        STRIP_ROWS
    );
    write_avif(path, &canvas, width, height);
}

/// How tall a window of the render is. A strip rather than the whole crop because that is what a
/// rendition does, and because the weight field is four bytes a pixel a slot.
const STRIP_ROWS: usize = 512;

fn weights_of(gpu: &'static rawshim::gpu::Gpu, values: &[f32]) -> rawshim::gpu::Buffer {
    let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("assemble mask"),
        contents: &bytes,
        usage: wgpu::BufferUsages::STORAGE,
    })
}

fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Even-odd on pixel centres, against the traced polygon rather than the mask it came from.
fn inside(outline: &[[f32; 2]], x: f32, y: f32) -> bool {
    let n = outline.len();
    let mut odd = false;
    for i in 0..n {
        let (a, b) = (outline[i], outline[(i + n - 1) % n]);
        if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] {
            odd = !odd;
        }
    }
    odd
}

fn rasterise(outline: &[[f32; 2]], weights: &mut [f32], size: (usize, usize)) {
    let (w, h) = size;
    let left = outline.iter().fold(f32::MAX, |m, v| m.min(v[0])).max(0.0) as usize;
    let top = outline.iter().fold(f32::MAX, |m, v| m.min(v[1])).max(0.0) as usize;
    let right = (outline.iter().fold(0f32, |m, v| m.max(v[0])).ceil() as usize).min(w);
    let bottom = (outline.iter().fold(0f32, |m, v| m.max(v[1])).ceil() as usize).min(h);
    for row in top..bottom {
        for column in left..right {
            if inside(outline, column as f32 + 0.5, row as f32 + 0.5) {
                weights[row * w + column] = 1.0;
            }
        }
    }
}

/// Drawn after the blend rather than into it: a tile a hundred pixels off its subject reads as a
/// correct one once its own pick is mixed in.
const PIECE: [u16; 3] = [u16::MAX, 0, u16::MAX / 2];
const DRAWN: [u16; 3] = [0, u16::MAX, u16::MAX];

fn draw_outline(samples: &mut [u16], size: (usize, usize), outline: &[[f32; 2]], colour: [u16; 3]) {
    let (w, h) = size;
    let n = outline.len();
    for i in 0..n {
        let (a, b) = (outline[i], outline[(i + 1) % n]);
        let steps = (b[0] - a[0]).abs().max((b[1] - a[1]).abs()).ceil().max(1.0) as usize;
        for step in 0..=steps {
            let t = step as f32 / steps as f32;
            let (x, y) = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
            if x < 0.0 || y < 0.0 || x as usize >= w || y as usize >= h {
                continue;
            }
            let at = (y as usize * w + x as usize) * 3;
            samples[at..at + 3].copy_from_slice(&colour);
        }
    }
}

/// What a library would have kept about one photograph, which is what gives the align a lens.
///
/// `composite_probe::analysis_for`'s fit, for its reason, and one frame is enough: `shared_lenses`
/// hands the group's one answer to every member, as `CompositesService.aligned` does before a
/// panorama. Without it every burst here is `Refused::Lensless`.
///
/// **A file with no embedded JPEG has nothing to match against, and takes the identity** - which is
/// a synthetic camera's own lens rather than a stand-in for one.
fn fitted_lens(path: &str) -> Option<Vec<u8>> {
    const FITTED_ON: u32 = 1600;
    const WHITE_QUANTILE: f64 = 0.9;
    let gpu = rawshim::gpu::device()?;
    let frame = rawshim::decode::frame_from_path(
        path,
        rawshim::galosh::Detail::at(0.0, 0.0),
        FITTED_ON,
        false,
        rawshim::galosh::Fit::Measure,
        rawshim::dust::Wanted::Off,
    );
    let resident = frame.as_ref().and_then(|frame| frame.on_device(gpu));
    let measured = resident
        .as_ref()
        .and_then(|resident| rawshim::fit_hdr_measured(resident, path, WHITE_QUANTILE, rawshim::hdr_fit::CameraMatch::LensAndColour));
    let mut analysis = rawshim::photo_analysis::PhotoAnalysis::default();
    match measured {
        Some((matched, levels)) => {
            println!("lens: fitted off {}", name_of(path));
            analysis.from_raw.matched = Some(matched);
            analysis.from_render.levels = Some(rawshim::photo_analysis::MeasuredLevels {
                levels,
                white_quantile: WHITE_QUANTILE,
            });
        }
        None => {
            println!("lens: {} matches nothing, so the identity", name_of(path));
            analysis.from_raw.matched = Some(rawshim::hdr_fit::HdrMatch {
                lens: rawshim::fit::Lens::none(),
                colour: None,
            });
        }
    }
    Some(rawshim::photo_analysis::encode(&analysis))
}

fn write_avif(path: &str, samples: &[u16], width: usize, height: usize) {
    let options = rawshim::hdr_args::EncodeOptions {
        still_chroma: rawshim::hdr_args::Chroma::Yuv444,
        output_path: path.to_string(),
        grade: rawshim::hdr::Grade {
            peak_nits: rawshim::light::Light::exactly(1000.0),
            reference_white_nits: rawshim::light::Light::exactly(203.0),
            white_quantile: 0.9,
        },
        // Near-lossless and 4:4:4: this is a picture to pixel-peep, not one to ship.
        crf: 2,
        preset: 6,
        strengths: rawshim::image::Strengths {
            sharpen: 0.0,
            defringe: 0.0,
        },
        sharpen_sigma: None,
        max_edge: f64::INFINITY,
    };
    rawshim::hdr::encode_pq_frame(samples.to_vec(), width, height, &options).expect("the still");
    println!("  wrote {path} at {width}x{height}");
}

struct Args {
    raws: Vec<String>,
    pick: usize,
    out: String,
    planes: Option<String>,
    /// Seed rectangles, each taking `--pick`, in analysis-plane pixels.
    drawn: Vec<[f32; 4]>,
    layers: Option<String>,
    /// The crop's long edge in output pixels, which is what a rendition size names.
    long: usize,
    /// The deconvolution's strength and GALOSH's detail, as a library sets them.
    ///
    /// **Zero is not the default a render takes**, and a comparison that leaves them there is
    /// comparing two pictures neither of which anybody is shown: `EditDoc` starts at a tenth of the
    /// sharpen's track and at `auto` for the denoise, so those are what a layer is built with.
    sharpen: f64,
    detail: rawshim::galosh::Detail,
    /// The focal a body would have written, for a file with no header to read it from.
    ///
    /// A burst of a scene at infinity is degenerate in the focal (§3.1), so a solve that is told
    /// nothing lands wherever `FOCAL_ASSUMED`'s leash lets it - and `NEAR_IDENTITY` then flags
    /// the set unaligned at the corners. Every real camera writes one; a synthetic DNG does not.
    focal: Option<f64>,
}

impl Args {
    fn parse() -> Args {
        let mut parsed = Args {
            raws: Vec::new(),
            pick: 1,
            out: "/tmp/assemble".to_string(),
            planes: None,
            drawn: Vec::new(),
            layers: None,
            // `full_rendition_size`, which is what a merge page's layers are asked for at.
            long: 3840,
            sharpen: 0.5,
            detail: rawshim::galosh::Detail::AUTO,
            focal: None,
        };
        let mut args = std::env::args().skip(1);
        while let Some(argument) = args.next() {
            match argument.as_str() {
                "--pick" => parsed.pick = args.next().expect("a number").parse().expect("a number"),
                "--out" => parsed.out = args.next().expect("a directory"),
                "--planes" => parsed.planes = Some(args.next().expect("a directory")),
                "--draw" => {
                    let n: Vec<f32> = args
                        .next()
                        .expect("x0,y0,x1,y1")
                        .split(',')
                        .map(|v| v.parse().expect("a number"))
                        .collect();
                    parsed.drawn.push([n[0], n[1], n[2], n[3]]);
                }
                "--layers" => parsed.layers = Some(args.next().expect("a directory")),
                "--long" => {
                    parsed.long = args.next().expect("a number").parse().expect("a number");
                }
                "--sharpen" => {
                    parsed.sharpen = args.next().expect("a number").parse().expect("a number");
                }
                "--detail" => {
                    let asked = args.next().expect("a number or `auto`");
                    parsed.detail = match asked.as_str() {
                        "auto" => rawshim::galosh::Detail::AUTO,
                        number => {
                            let both: f64 = number.parse().expect("a number or `auto`");
                            rawshim::galosh::Detail::at(both, both)
                        }
                    };
                }
                "--focal" => {
                    parsed.focal = Some(args.next().expect("a number").parse().expect("a number"));
                }
                flag if flag.starts_with("--") => panic!("unknown flag {flag}"),
                path => parsed.raws.push(path.to_string()),
            }
        }
        if parsed.raws.len() < 2 {
            eprintln!("assemble <a.ARW> <b.ARW> [more...] [--draw x0,y0,x1,y1] [--pick N]");
            std::process::exit(2);
        }
        parsed
    }
}

/// `composite_probe`'s, for its reason: a file with no embedded preview has no other way into the
/// alignment, which is every DNG `synth_raw` writes.
fn plane_for(args: &Args, path: &str) -> Option<String> {
    let dir = args.planes.as_ref()?;
    let stem = std::path::Path::new(path).file_stem()?.to_str()?;
    ["jpg", "avif"]
        .iter()
        .map(|extension| format!("{dir}/{stem}.{extension}"))
        .find(|plane| std::fs::exists(plane).unwrap_or(false))
}

/// What the body says its focal is, in this photograph's own pixels.
fn focal_px(path: &str) -> Option<f64> {
    let header = rawshim::header::read_path(path)?;
    let crop = lensdb::crop_factor(
        rawshim::header::name(&header.camera_make),
        rawshim::header::name(&header.camera_model),
    )?;
    (header.focal > 0.0)
        .then(|| f64::from(header.focal) * crop * header.width.max(header.height) as f64 / 36.0)
}

fn size_of(path: &str) -> [usize; 2] {
    let header = match rawshim::decode_rendered::is_rendered(path) {
        true => rawshim::header::read_rendered(path),
        false => rawshim::header::read_path(path),
    };
    header.map_or([0, 0], |h| [h.width as usize, h.height as usize])
}
