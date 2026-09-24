//! What the editor's open costs, and what it would cost split into tiles.
//!
//! ```text
//! open_bench <raw>...
//! ```
//!
//! Two questions:
//!
//! 1. **The open.** `edit::prepare_bytes` end to end, with and without a stored camera match,
//!    plus `BOWERBIRD_DECODE_PROFILE`'s laps if it is set.
//! 2. **The mosaic stages on their own.** What the denoise costs against what a fit alone costs,
//!    and what the demosaic costs whole against the same frame in tiles - in time, and in how far
//!    the two answers differ, which is the question tiling has to answer before its speed matters.
//!
//! The mosaic those last ones run over is synthesised rather than decoded, because none of the
//! stages branch on sample values: `rcd.slang`'s only data-dependent test is a two-way select of
//! one scalar, and GALOSH's dispatch shape is fixed by the frame's dimensions. So the timings
//! transfer and the comparison is exact, without holding a decode beside them.

use rawshim::galosh::Amounts;

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("open_bench <raw>...");
        std::process::exit(2);
    }

    let mut biggest = (0usize, 0usize);
    for path in &files {
        let Some(dimensions) = time_the_open(path) else { continue };
        if dimensions.0 * dimensions.1 > biggest.0 * biggest.1 {
            biggest = dimensions;
        }
    }

    if biggest.0 > 0 {
        mosaic_stages(biggest.0, biggest.1);
    }
}

fn name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn megabytes(bytes: usize) -> String {
    format!("{:.1}MB", bytes as f64 / 1e6)
}

/// The open twice: once fitting the camera match, once handed the one it fitted.
///
/// The pair is the point. A photograph is opened many times and fitted once, so the second number
/// is what a reader waits for and the first is what the library pays on the first open of a file
/// nothing has rendered yet.
///
/// Answers the frame's dimensions, which is what the mosaic sweep below sizes itself from.
fn time_the_open(path: &str) -> Option<(usize, usize)> {
    let bytes = std::fs::read(path).ok()?;

    let began = std::time::Instant::now();
    let cold = match rawshim::edit::prepare_bytes(&bytes, &request(None), 1.0) {
        Ok(cold) => cold,
        Err(error) => {
            eprintln!("{}: {error}", name(path));
            return None;
        }
    };
    let cold_ms = began.elapsed().as_millis();
    let analysis = cold.header.photo_analysis.clone();
    let dimensions = (cold.header.width, cold.header.height);
    drop(cold);

    let began = std::time::Instant::now();
    let warm = rawshim::edit::prepare_bytes(&bytes, &request(analysis.clone()), 1.0);
    let warm_ms = began.elapsed().as_millis();
    let fitted = match &warm {
        Ok(prepared) => prepared.header.matched,
        Err(_) => false,
    };
    drop(warm);

    println!(
        "\n{}: {}x{}, open {cold_ms}ms measuring the photograph, {warm_ms}ms handed the analysis ({} bytes, matched {fitted})",
        name(path),
        dimensions.0,
        dimensions.1,
        analysis.clone().map_or(0, |m| m.len()),
    );

    // **What a Detail slider costs, which is the number the editor is designed around.** The open
    // above re-reads the file and conditions the mosaic; this holds that mosaic and re-runs only
    // what an amount can move - the denoise, the demosaic, the coding and the warp. If the two are
    // close then holding the mosaic bought nothing.
    let began = std::time::Instant::now();
    let held = pollster::block_on(rawshim::decode_rawler::hold_bytes(&bytes))?;
    let fit = pollster::block_on(held.fit());
    let held_ms = began.elapsed().as_millis();

    let mut request = request(analysis);
    for (luminance, colour) in [(40.0, 40.0), (20.0, 30.0)] {
        request.denoise_luminance = Some(luminance);
        request.denoise_colour = Some(colour);
        let began = std::time::Instant::now();
        let frame = pollster::block_on(held.frame(
            request.detail(),
            request.long_edge,
            fit.map_or(rawshim::galosh::Fit::Measure, rawshim::galosh::Fit::Given),
            rawshim::dust::Wanted::Off,
        ));
        let frame = frame?;
        let prepared =
            pollster::block_on(rawshim::edit::from_frame(frame, &bytes, true, &request, 1.0));
        let ms = began.elapsed().as_millis();
        println!(
            "  {:<34} {ms}ms  (the mosaic took {held_ms}ms to reach and is held)",
            format!("re-prepare at Detail {luminance}/{colour}"),
        );
        drop(prepared);
    }
    Some(dimensions)
}

fn request(photo_analysis: Option<Vec<u8>>) -> rawshim::edit::EditRequest {
    rawshim::edit::EditRequest {
        long_edge: 0,
        grade: rawshim::hdr::Grade {
            peak_nits: rawshim::light::Light::exactly(1000.0),
            reference_white_nits: rawshim::light::Light::exactly(203.0),
            white_quantile: 0.995,
        },
        defringe: 1.0,
        photo_analysis,
        dust: Default::default(),
        repairs: Vec::new(),
        stated_white: false,
        // The document's defaults, so the open being timed is the one a reader waits for -
        // the denoise is inside it now.
        denoise_luminance: Some(20.0),
        denoise_colour: Some(30.0),
        denoiser: rawshim::galosh::Denoiser::Galosh,
    }
}

const REPEATS: usize = 3;

/// One run, in milliseconds, for a sweep too long to repeat.
fn time(mut run: impl FnMut()) -> u128 {
    let began = std::time::Instant::now();
    run();
    began.elapsed().as_millis()
}

/// The median of a few runs, and the spread, because this machine's numbers move.
fn repeat(label: &str, mut run: impl FnMut()) -> u128 {
    let mut taken: Vec<u128> = (0..REPEATS)
        .map(|_| {
            let began = std::time::Instant::now();
            run();
            began.elapsed().as_millis()
        })
        .collect();
    taken.sort_unstable();
    println!("  {label:<34} {:>6}ms   ({} - {})", taken[REPEATS / 2], taken[0], taken[REPEATS - 1]);
    taken[REPEATS / 2]
}

/// The stages that run on the mosaic, timed apart from the decode that feeds them.
fn mosaic_stages(width: usize, height: usize) {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("no GPU: skipping the mosaic stages");
        return;
    };
    let pixels = width * height;
    println!(
        "\nmosaic stages at {width}x{height} ({:.1}MP), plane {}",
        pixels as f64 / 1e6,
        megabytes(pixels * 4),
    );

    let mosaic = synthesise(width, height);
    let cfa = rawshim::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB is a pattern");

    // Uploaded once and reused, which is what the chain does now: the stages hand each other a
    // device buffer, so a timing that included the upload would be timing something no decode does.
    let uploaded = upload(gpu, &mosaic, width, height);

    if let Some(kernels) = rawshim::galosh::device(gpu) {
        let amounts = Amounts::from_sliders(50.0, 50.0);
        let fit = block(rawshim::galosh::fit(gpu, kernels, &uploaded, &cfa));
        repeat("galosh fit only (the open's)", || {
            block(rawshim::galosh::fit(gpu, kernels, &uploaded, &cfa));
        });
        let whole = upload(gpu, &mosaic, width, height);
        repeat("galosh denoise, 50/50, given a fit", || {
            block(rawshim::galosh::denoise_with(gpu, kernels, &whole, &cfa, amounts, fit));
        });
        let whole = read(gpu, &whole);

        // The halo is the denoise's own rather than the demosaic's: the chroma pyramid goes to a
        // quarter of what it is handed and the joint upsample reads a neighbourhood coming back.
        let halo = rawshim::EDITOR_TILE_HALO;

        // One region at a time, over a range of sizes. Tiling costs far more than the halo can
        // account for, so what this separates is the part of a call that scales with the region
        // from the part that is paid whatever its size - the second is what decides whether a
        // slider re-runs tiles or one rectangle.
        for side in [64usize, 128, 256, 512, 1024, 2048, 4096] {
            let region = centred(width, height, side, side, halo);
            let window = uploaded.window(gpu, region.left, region.top, region.w, region.h);
            repeat(&format!("galosh over one {}x{} region", region.w, region.h), || {
                block(rawshim::galosh::denoise_with(gpu, kernels, &window, &cfa, amounts, fit));
            });
            // The fit skips the inverse-GAT table and the whole tail behind it, so the gap
            // between the two at one region size is what a call pays for the part of itself that
            // does not depend on how large the region is.
            repeat(&format!("  fit alone over {}x{}", region.w, region.h), || {
                block(rawshim::galosh::fit(gpu, kernels, &window, &cfa));
            });
        }

        // What re-running only what the reader can see would cost, which is the shape a Detail
        // slider would actually take: one region the size of a stage, at the middle of the frame.
        let (vw, vh) = (2560.min(width), 1707.min(height));
        let region = centred(width, height, vw, vh, halo);
        let window = uploaded.window(gpu, region.left, region.top, region.w, region.h);
        repeat(&format!("galosh over one {vw}x{vh} stage"), || {
            block(rawshim::galosh::denoise_with(gpu, kernels, &window, &cfa, amounts, fit));
        });

        // **Is being handed a fit the same as measuring one?** The loupe assumes it: a tile is
        // given the frame's fit so that it predicts the export, which measures its own. If the two
        // are not the same denoise then every tile disagrees with the render it exists to
        // preview, everywhere and not only at a seam.
        let measured = upload(gpu, &mosaic, width, height);
        let _ = block(rawshim::galosh::denoise(gpu, kernels, &measured, &cfa, amounts));
        let given = upload(gpu, &mosaic, width, height);
        block(rawshim::galosh::denoise_with(gpu, kernels, &given, &cfa, amounts, fit));
        let worst = read(gpu, &measured)
            .iter()
            .zip(&read(gpu, &given))
            .map(|(a, b)| (a - b).abs())
            .fold(0f32, f32::max);
        println!("  {:<34} worst {worst:e}", "a measured fit vs a given one");

        kernel_by_kernel(gpu, kernels, &uploaded, &cfa, amounts, Some(fit), 24);
        kernel_by_kernel(gpu, kernels, &uploaded, &cfa, amounts, None, 44);

        // What tiling costs, against the halo and against the tile size, which are two separate
        // taxes and not one: the halo grows every region, and a tile size that does not divide the
        // frame leaves the last row and column of tiles mostly outside it. Both are reported as
        // the area actually put through the denoise, so the wall clock can be checked against it.
        let frame_mp = (width * height) as f64 / 1e6;
        println!(
            "\n  {:>5} {:>5}  {:>7} {:>9} {:>7}  {:>9}",
            "tile", "halo", "tiles", "MP done", "vs 1x", "ms",
        );
        for side in [512usize, 1024, 2048] {
            for halo in [16usize, 32, 64] {
                let (mut tiles, mut area) = (0usize, 0usize);
                for_each_tile(width, height, side, halo, |region| {
                    tiles += 1;
                    area += region.w * region.h;
                });
                let done = area as f64 / 1e6;
                let taken = time(|| {
                    for_each_tile(width, height, side, halo, |region| {
                        let window =
                            uploaded.window(gpu, region.left, region.top, region.w, region.h);
                        block(rawshim::galosh::denoise_with(gpu, kernels, &window, &cfa, amounts, fit));
                    });
                });
                println!(
                    "  {side:>5} {halo:>5}  {tiles:>7} {done:>9.1} {:>6.2}x  {taken:>7}ms",
                    done / frame_mp,
                );
            }
        }

        // Through `denoise_in_tiles` rather than `for_each_tile` above, which aligns a region to a
        // CFA site where `pass12` needs `SHRINK_LATTICE`: driven from this loop's geometry the same
        // comparison reads 4.5e-1, which is that rounding and not the tiling.
        //
        // What is left - 8.1e-2, and the same at 1024 as at 2048, so reach rather than seams - is
        // the chroma pyramid reading past `RENDITION_TILE_HALO`. Under a 16-bit count, since
        // `a_denoised_region_is_the_frame_it_was_cut_from` pins the output exactly.
        let mut tiled = upload(gpu, &mosaic, width, height);
        block(rawshim::galosh::denoise_in_tiles(
            gpu,
            kernels,
            &mut tiled,
            &cfa,
            amounts,
            fit,
            rawshim::RENDITION_TILE_HALO,
            rawshim::decode_rawler::RENDER_TILE,
            |_| {},
        ));
        let worst = read(gpu, &tiled)
            .iter()
            .zip(&whole)
            .map(|(a, b)| (a - b).abs())
            .fold(0f32, f32::max);
        println!("  {:<34} worst {worst:e}", "  tiled vs the whole frame");
        drop(whole);
    }

    let Some(rcd) = rawshim::demosaic::device(gpu) else { return };
    let mut whole: Vec<f32> = Vec::new();
    repeat("rcd whole frame", || {
        whole = block(rawshim::demosaic::demosaic_plane(gpu, rcd, &uploaded, &cfa, floats))
            .expect("the whole frame demosaics");
    });

    for side in [512usize, 1024, 2048] {
        tiled(gpu, rcd, &uploaded, width, height, &cfa, side, &whole);
    }
}

fn block<T>(work: impl std::future::Future<Output = T>) -> T {
    pollster::block_on(work)
}

fn upload(
    gpu: &'static rawshim::gpu::Gpu,
    values: &[f32],
    width: usize,
    height: usize,
) -> rawshim::condition::Mosaic {
    rawshim::condition::Mosaic::upload(gpu, values, width, height)
}

fn read(gpu: &rawshim::gpu::Gpu, mosaic: &rawshim::condition::Mosaic) -> Vec<f32> {
    block(mosaic.read(gpu)).expect("the mosaic reads back")
}

/// What each dispatch in the chain costs, by running the chain truncated at every length.
///
/// The reason to want it: the two Detail sliders enter the chain at one dispatch each - the luma
/// amount at `pass12` and the colour amount at `smoothstep_blend_3p` - so what a slider could skip
/// if the run before it were kept is exactly the cost of everything ahead of its own dispatch.
/// Nothing outside can see that, because the whole chain is one compute pass.
///
/// **Read the spread before believing a delta.** Each figure is a difference of two whole runs, so
/// it carries both runs' variance, and every run re-allocates the frame's buffers before it
/// dispatches anything. The sweep deliberately continues past the last dispatch there is: those
/// tail rows change nothing and whatever they report is this machine's noise floor, which is the
/// bar a delta has to clear to mean something.
///
/// Handed no fit, the sweep covers the twenty-one reductions a measuring run opens with, which are
/// a third of what the stage costs and which no caller can otherwise separate from the filtering.
fn kernel_by_kernel(
    gpu: &'static rawshim::gpu::Gpu,
    kernels: &'static rawshim::galosh::Galosh,
    mosaic: &rawshim::condition::Mosaic,
    cfa: &rawshim::cfa::Cfa,
    amounts: Amounts,
    fit: Option<rawshim::galosh::NoiseFit>,
    last: usize,
) {
    let handed = match fit {
        Some(_) => "given a fit",
        None => "measuring its own fit",
    };
    println!("  each dispatch {handed}, over the whole frame (median of {REPEATS}):");
    // Named off a full run first, because the sequence is a property of this call's shape rather
    // than a list that could be written here: a supplied fit skips Phase 2's iterations, and a
    // cached inverse table skips two more.
    let names = {
        rawshim::galosh::stop_after(usize::MAX);
        match fit {
            Some(fit) => {
                block(rawshim::galosh::denoise_with(gpu, kernels, mosaic, cfa, amounts, fit));
            }
            None => {
                block(rawshim::galosh::denoise(gpu, kernels, mosaic, cfa, amounts));
            }
        }
        rawshim::galosh::dispatched()
    };
    let truncated = |count: usize| {
        rawshim::galosh::stop_after(count);
        let mut taken: Vec<u128> = (0..REPEATS)
            .map(|_| {
                time(|| match fit {
                    Some(fit) => {
                        block(rawshim::galosh::denoise_with(gpu, kernels, mosaic, cfa, amounts, fit));
                    }
                    None => {
                        block(rawshim::galosh::denoise(gpu, kernels, mosaic, cfa, amounts));
                    }
                })
            })
            .collect();
        taken.sort_unstable();
        (taken[REPEATS / 2], taken[REPEATS - 1] - taken[0])
    };
    let mut previous = truncated(0).0;
    for count in 1..=last {
        let (taken, spread) = truncated(count);
        let (name, groups) = names.get(count - 1).copied().unwrap_or(("?", 0));
        println!(
            "    {count:>2} {name:<24} +{:>5}ms   {groups:>7} groups   (running {taken}ms, spread {spread}ms)",
            taken.saturating_sub(previous),
        );
        previous = taken;
    }
    rawshim::galosh::stop_after(usize::MAX);
}

fn floats(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|word| f32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
        .collect()
}

/// The same demosaic over tiles, against the whole frame's answer for the same pixels.
///
/// The halo is the specification's own reach (§10), grown on every side and then thrown away, and
/// the origins are aligned to whole CFA sites - an odd one relabels every colour in the tile. What
/// the comparison asks is whether the two agree exactly, since RCD is a pure local map and so it
/// should: anything above zero is a reach that does not compose the way §10 says it does.
fn tiled(
    gpu: &'static rawshim::gpu::Gpu,
    rcd: &'static rawshim::demosaic::Rcd,
    mosaic: &rawshim::condition::Mosaic,
    width: usize,
    height: usize,
    cfa: &rawshim::cfa::Cfa,
    side: usize,
    whole: &[f32],
) {
    let across = width.div_ceil(side);
    let down = height.div_ceil(side);
    let cut = |region: Region| mosaic.window(gpu, region.left, region.top, region.w, region.h);

    repeat(&format!("rcd in {across}x{down} tiles of {side}"), || {
        for_each_tile(width, height, side, rawshim::demosaic::MARGIN as usize, |region| {
            let window = cut(region);
            block(rawshim::demosaic::demosaic_plane(gpu, rcd, &window, cfa, |_| ()))
                .expect("the tile demosaics");
        });
    });

    // Once, and outside the timed loop, so what is reported as the tiles' cost is the tiles.
    let mut worst = 0f32;
    let mut compared = 0usize;
    for_each_tile(width, height, side, rawshim::demosaic::MARGIN as usize, |region| {
        let window = cut(region);
        let out = block(rawshim::demosaic::demosaic_plane(gpu, rcd, &window, cfa, floats))
            .expect("the tile demosaics");
        for row in region.y0..region.y1 {
            for col in region.x0..region.x1 {
                for channel in 0..3 {
                    let mine =
                        out[((row - region.top) * region.w + (col - region.left)) * 3 + channel];
                    let theirs = whole[(row * width + col) * 3 + channel];
                    worst = worst.max((mine - theirs).abs());
                    compared += 1;
                }
            }
        }
    });
    println!("  {:<34} worst {worst:e} over {compared} samples", "  vs the whole frame");
}

/// A tile and the haloed region that has to be demosaiced to produce it.
#[derive(Clone, Copy)]
struct Region {
    left: usize,
    top: usize,
    w: usize,
    h: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
}

/// Every tile of the frame, with the specification's reach grown on and aligned to CFA sites.
///
/// Aligned down to even and trimmed to even, because an odd origin relabels every colour in the
/// region and the denoise pairs samples into 2x2 sites. Clamped at the frame's own edge, where
/// there is nothing to grow into and the whole frame has nothing either.
fn for_each_tile(
    width: usize,
    height: usize,
    side: usize,
    halo: usize,
    mut visit: impl FnMut(Region),
) {
    for ty in 0..height.div_ceil(side) {
        for tx in 0..width.div_ceil(side) {
            let (x0, y0) = (tx * side, ty * side);
            let (x1, y1) = ((x0 + side).min(width), (y0 + side).min(height));
            let left = x0.saturating_sub(halo) & !1;
            let top = y0.saturating_sub(halo) & !1;
            let right = (x1 + halo).min(width);
            let bottom = (y1 + halo).min(height);
            let (right, bottom) = (right - ((right - left) & 1), bottom - ((bottom - top) & 1));
            if right <= left || bottom <= top {
                continue;
            }
            visit(Region {
                left,
                top,
                w: right - left,
                h: bottom - top,
                x0,
                y0,
                x1: x1.min(right),
                y1: y1.min(bottom),
            });
        }
    }
}

/// A `want`-sized rectangle in the middle of the frame, grown by the halo and clamped to it.
fn centred(width: usize, height: usize, want_w: usize, want_h: usize, halo: usize) -> Region {
    let w = (want_w + 2 * halo).min(width) & !1;
    let h = (want_h + 2 * halo).min(height) & !1;
    let left = ((width - w) / 2) & !1;
    let top = ((height - h) / 2) & !1;
    Region { left, top, w, h, x0: left, y0: top, x1: left + w, y1: top + h }
}

/// A mosaic with the statistics of a photograph and none of its content.
///
/// A smooth field with a per-site offset and a deterministic grain on top, at the level a
/// mid-exposure frame sits at. Nothing here branches on the values, so what this is only has to be
/// representative in range.
fn synthesise(width: usize, height: usize) -> Vec<f32> {
    let mut out = vec![0f32; width * height];
    for row in 0..height {
        let y = row as f32 / height as f32;
        for col in 0..width {
            let x = col as f32 / width as f32;
            let grain = (((row * 7919 + col * 104729) % 1024) as f32 / 1024.0 - 0.5) * 0.02;
            let site = match (row & 1) * 2 + (col & 1) {
                0 => 0.06,
                3 => -0.04,
                _ => 0.0,
            };
            out[row * width + col] = (0.25 + 0.35 * x + 0.2 * y + site + grain).clamp(0.0, 1.0);
        }
    }
    out
}
