//! What the editor's open costs, and what it would cost split into tiles.
//!
//! ```text
//! open_bench <raw>...
//! ```
//!
//! Three questions, in the order the answers depend on each other:
//!
//! 1. **The wire.** What a prepared frame weighs against the RAW it came from, which is what
//!    deciding where the open runs comes down to.
//! 2. **The open.** `edit::prepare_bytes` end to end, with and without a stored camera match,
//!    plus `BOWERBIRD_DECODE_PROFILE`'s laps if it is set.
//! 3. **The mosaic stages on their own.** What the denoise costs against what a fit alone costs,
//!    and what the demosaic costs whole against the same frame in tiles - in time, and in how far
//!    the two answers differ, which is the question tiling has to answer before its speed matters.
//!
//! The mosaic those last ones run over is synthesised rather than decoded, because none of the
//! stages branch on sample values: `rcd.wgsl`'s only data-dependent test is a two-way select of
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
    println!("{:>30}  {:>10}  {:>12}  {:>11}  {:>9}  {:>6}", "file", "pixels", "raw", "prepared", "header", "ratio");
    for path in &files {
        let Some((dimensions, raw_bytes, prepared_bytes, header_bytes)) = weigh(path) else {
            continue;
        };
        if dimensions.0 * dimensions.1 > biggest.0 * biggest.1 {
            biggest = dimensions;
        }
        println!(
            "{:>30}  {:>10}  {:>12}  {:>11}  {:>9}  {:>5.1}x",
            name(path),
            format!("{}x{}", dimensions.0, dimensions.1),
            megabytes(raw_bytes),
            megabytes(prepared_bytes),
            format!("{}KB", header_bytes / 1024),
            prepared_bytes as f64 / raw_bytes as f64,
        );
    }

    for path in &files {
        time_the_open(path);
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

/// The three sizes a decision about where to run the open is made from.
fn weigh(path: &str) -> Option<((usize, usize), usize, usize, usize)> {
    let bytes = std::fs::read(path).ok()?;
    let prepared = match rawshim::edit::prepare_bytes(&bytes, &request(None)) {
        Ok(prepared) => prepared,
        Err(error) => {
            eprintln!("{}: {error}", name(path));
            return None;
        }
    };
    let framed = rawshim::edit::encode(&prepared).ok()?;
    let header = framed.len() - prepared.header.samples_len;
    Some((
        (prepared.header.width, prepared.header.height),
        bytes.len(),
        framed.len(),
        header,
    ))
}

/// The open twice: once fitting the camera match, once handed the one it fitted.
///
/// The pair is the point. A photograph is opened many times and fitted once, so the second number
/// is what a reader waits for and the first is what the library pays on the first open of a file
/// nothing has rendered yet.
fn time_the_open(path: &str) {
    let Ok(bytes) = std::fs::read(path) else { return };

    let began = std::time::Instant::now();
    let Ok(cold) = rawshim::edit::prepare_bytes(&bytes, &request(None)) else { return };
    let cold_ms = began.elapsed().as_millis();
    let matched = cold.header.camera_match.clone();
    drop(cold);

    let began = std::time::Instant::now();
    let warm = rawshim::edit::prepare_bytes(&bytes, &request(matched.clone()));
    let warm_ms = began.elapsed().as_millis();
    let fitted = match &warm {
        Ok(prepared) => prepared.header.matched,
        Err(_) => false,
    };
    drop(warm);

    println!(
        "\n{}: open {cold_ms}ms fitting the match, {warm_ms}ms handed it ({} bytes, matched {fitted})",
        name(path),
        matched.map_or(0, |m| m.len()),
    );
}

fn request(camera_match: Option<Vec<u8>>) -> rawshim::edit::EditRequest {
    rawshim::edit::EditRequest {
        raw_file_path: String::new(),
        long_edge: 0,
        grade: rawshim::hdr::Grade {
            peak_nits: 1000.0,
            reference_white_nits: 203.0,
            white_quantile: 0.995,
        },
        strengths: rawshim::image::Strengths { sharpen: 1.0, defringe: 1.0 },
        camera_match,
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
    let cfa = [0u32, 1, 1, 2];

    if let Some(kernels) = rawshim::galosh::device(gpu) {
        let amounts = Amounts::from_sliders(50.0, 50.0);
        let fit = rawshim::galosh::fit(gpu, kernels, &mosaic, width, height);
        repeat("galosh fit only (the open's)", || {
            rawshim::galosh::fit(gpu, kernels, &mosaic, width, height);
        });
        let mut whole = mosaic.clone();
        repeat("galosh denoise, 50/50, given a fit", || {
            whole.copy_from_slice(&mosaic);
            rawshim::galosh::denoise_with(
                gpu, kernels, &mut whole, width, height, amounts, fit,
            );
        });

        // The halo is the denoise's own rather than the demosaic's: the chroma pyramid goes to a
        // quarter of what it is handed and the joint upsample reads a neighbourhood coming back.
        let halo = rawshim::EDITOR_TILE_HALO;

        // One region at a time, over a range of sizes. Tiling costs far more than the halo can
        // account for, so what this separates is the part of a call that scales with the region
        // from the part that is paid whatever its size - the second is what decides whether a
        // slider re-runs tiles or one rectangle.
        for side in [64usize, 128, 256, 512, 1024, 2048, 4096] {
            let region = centred(width, height, side, side, halo);
            let mut window = cut(&mosaic, width, region);
            repeat(&format!("galosh over one {}x{} region", region.w, region.h), || {
                rawshim::galosh::denoise_with(
                    gpu, kernels, &mut window, region.w, region.h, amounts, fit,
                );
            });
            // The fit skips the inverse-GAT table and the whole tail behind it, so the gap
            // between the two at one region size is what a call pays for the part of itself that
            // does not depend on how large the region is.
            repeat(&format!("  fit alone over {}x{}", region.w, region.h), || {
                rawshim::galosh::fit(gpu, kernels, &window, region.w, region.h);
            });
        }

        // What re-running only what the reader can see would cost, which is the shape a Detail
        // slider would actually take: one region the size of a stage, at the middle of the frame.
        let (vw, vh) = (2560.min(width), 1707.min(height));
        let region = centred(width, height, vw, vh, halo);
        let mut window = cut(&mosaic, width, region);
        repeat(&format!("galosh over one {vw}x{vh} stage"), || {
            rawshim::galosh::denoise_with(
                gpu, kernels, &mut window, region.w, region.h, amounts, fit,
            );
        });

        // **Is being handed a fit the same as measuring one?** The loupe assumes it: a tile is
        // given the frame's fit so that it predicts the export, which measures its own. If the two
        // are not the same denoise then every tile disagrees with the render it exists to
        // preview, everywhere and not only at a seam.
        let mut measured = mosaic.clone();
        rawshim::galosh::denoise(gpu, kernels, &mut measured, width, height, amounts);
        let mut given = mosaic.clone();
        rawshim::galosh::denoise_with(gpu, kernels, &mut given, width, height, amounts, fit);
        let worst = measured
            .iter()
            .zip(&given)
            .map(|(a, b)| (a - b).abs())
            .fold(0f32, f32::max);
        println!("  {:<34} worst {worst:e}", "a measured fit vs a given one");
        drop((measured, given));

        kernel_by_kernel(gpu, kernels, &mosaic, width, height, amounts, fit);

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
                        let mut window = cut(&mosaic, width, region);
                        rawshim::galosh::denoise_with(
                            gpu, kernels, &mut window, region.w, region.h, amounts, fit,
                        );
                    });
                });
                println!(
                    "  {side:>5} {halo:>5}  {tiles:>7} {done:>9.1} {:>6.2}x  {taken:>7}ms",
                    done / frame_mp,
                );
            }
        }

        // Once, at the size and halo that ship, so the sweep above is known to be measuring runs
        // that agree with the frame rather than runs that merely finish.
        let mut worst = 0f32;
        // The exact one, since what this asserts is that a tiled denoise can be bit-identical to
        // the frame denoised whole - which is the reason a rendition takes 64.
        for_each_tile(width, height, 1024, rawshim::RENDITION_TILE_HALO, |region| {
            let mut window = cut(&mosaic, width, region);
            rawshim::galosh::denoise_with(
                gpu, kernels, &mut window, region.w, region.h, amounts, fit,
            );
            for row in region.y0..region.y1 {
                for col in region.x0..region.x1 {
                    let mine = window[(row - region.top) * region.w + (col - region.left)];
                    worst = worst.max((mine - whole[row * width + col]).abs());
                }
            }
        });
        println!("  {:<34} worst {worst:e}", "  1024 tiles vs the whole frame");
        drop(whole);
    }

    let Some(rcd) = rawshim::demosaic::device(gpu) else { return };
    let mut whole: Vec<f32> = Vec::new();
    repeat("rcd whole frame", || {
        whole = rawshim::demosaic::demosaic_with(gpu, rcd, &mosaic, width, height, cfa, floats)
            .expect("the whole frame demosaics");
    });

    for side in [512usize, 1024, 2048] {
        tiled(gpu, rcd, &mosaic, width, height, cfa, side, &whole);
    }
}

/// What each dispatch in the chain costs, by running the chain truncated at every length.
///
/// The reason to want it: the two Detail sliders enter the chain at one dispatch each - the luma
/// amount at `pass12` and the colour amount at `smoothstep_blend_3p` - so what a slider could skip
/// if the run before it were kept is exactly the cost of everything ahead of its own dispatch.
/// Nothing outside can see that, because the whole chain is one compute pass.
fn kernel_by_kernel(
    gpu: &'static rawshim::gpu::Gpu,
    kernels: &'static rawshim::galosh::Galosh,
    mosaic: &[f32],
    width: usize,
    height: usize,
    amounts: Amounts,
    fit: rawshim::galosh::NoiseFit,
) {
    println!("  each dispatch, over the whole frame:");
    let mut window = mosaic.to_vec();
    let mut previous = 0u128;
    for count in 0..=24 {
        rawshim::galosh::stop_after(count);
        let began = std::time::Instant::now();
        rawshim::galosh::denoise_with(gpu, kernels, &mut window, width, height, amounts, fit);
        let taken = began.elapsed().as_millis();
        if count > 0 {
            println!("    dispatch {count:>2}   +{:>5}ms   (running {taken}ms)", taken.saturating_sub(previous));
        }
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
    mosaic: &[f32],
    width: usize,
    height: usize,
    cfa: [u32; 4],
    side: usize,
    whole: &[f32],
) {
    let across = width.div_ceil(side);
    let down = height.div_ceil(side);

    repeat(&format!("rcd in {across}x{down} tiles of {side}"), || {
        for_each_tile(width, height, side, rawshim::demosaic::MARGIN as usize, |region| {
            let window = cut(mosaic, width, region);
            rawshim::demosaic::demosaic_with(gpu, rcd, &window, region.w, region.h, cfa, |_| ())
                .expect("the tile demosaics");
        });
    });

    // Once, and outside the timed loop, so what is reported as the tiles' cost is the tiles.
    let mut worst = 0f32;
    let mut compared = 0usize;
    for_each_tile(width, height, side, rawshim::demosaic::MARGIN as usize, |region| {
        let window = cut(mosaic, width, region);
        let out =
            rawshim::demosaic::demosaic_with(gpu, rcd, &window, region.w, region.h, cfa, floats)
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

fn cut(mosaic: &[f32], width: usize, region: Region) -> Vec<f32> {
    let mut window = vec![0f32; region.w * region.h];
    for row in 0..region.h {
        let from = (region.top + row) * width + region.left;
        window[row * region.w..(row + 1) * region.w]
            .copy_from_slice(&mosaic[from..from + region.w]);
    }
    window
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
