//! What tiling GALOSH for progress costs, and what it buys.
//!
//! ```text
//! galosh_progress <raw>
//! ```
//!
//! One row per tile size: the whole frame's wall clock, the gap a caller would wait between two
//! updates, and how far the result is from the same frame denoised whole. The trade is
//! one-directional - a smaller tile is always slower overall, because every tile is grown by the
//! halo - so the row to ship is the smallest one whose total is still close to the largest's.
//!
//! The last column is the reason `denoise_in_tiles` rounds its origins to `pass12`'s workgroup: it
//! reads 0 at every size, and without that rounding it reads ~1.6e-3 over 94% of the frame, at
//! every size and at every halo up to 512. `describe` is what says which of the two a run is - a
//! halo too short bands the difference along the seams, a misplaced origin spreads it everywhere.
//!
//! The mosaic is synthesised at the file's own dimensions rather than decoded from it, for the
//! reason `open_bench` gives: no phase of GALOSH branches on a sample value, so the dispatch shape
//! is fixed by the frame's size alone and the timings transfer exactly.

use rawshim::galosh::Amounts;

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("galosh_progress <raw>");
        std::process::exit(2);
    };
    let bytes = std::fs::read(&path).expect("the raw");
    let prepared = rawshim::edit::prepare_bytes(&bytes, &request(), 1.0).expect("prepare");
    let (width, height) = (prepared.header.width & !1, prepared.header.height & !1);
    drop(prepared);

    let gpu = rawshim::gpu::device().expect("an adapter");
    let kernels = rawshim::galosh::device(gpu).expect("the denoise");
    let amounts = Amounts::from_sliders(50.0, 50.0);

    let mut state = 0x2545_f491_4f6c_dd1du64;
    let mosaic: Vec<f32> = (0..width * height)
        .map(|at| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let level = [0.20, 0.34, 0.34, 0.12][(at / width & 1) | ((at % width & 1) << 1)];
            (level + ((state >> 40) as f32 / 16777216.0 - 0.5) * 0.05).clamp(0.0, 1.0)
        })
        .collect();
    let upload = |values: &[f32]| rawshim::condition::Mosaic::upload(gpu, values, width, height);
    let read = |frame: &rawshim::condition::Mosaic| {
        pollster::block_on(frame.read(gpu)).expect("the mosaic reads back")
    };
    let cfa = rawshim::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB is a pattern");
    let fit = pollster::block_on(rawshim::galosh::fit(gpu, kernels, &upload(&mosaic), &cfa));
    println!(
        "{}x{} ({:.1}MP), halo {}\n",
        width,
        height,
        (width * height) as f64 / 1e6,
        rawshim::RENDITION_TILE_HALO,
    );

    let mut one = std::time::Duration::MAX;
    for _ in 0..3 {
        let scratch = upload(&mosaic);
        let began = std::time::Instant::now();
        pollster::block_on(rawshim::galosh::denoise_with(gpu, kernels, &scratch, &cfa, amounts, fit));
        one = one.min(began.elapsed());
    }
    let whole = upload(&mosaic);
    pollster::block_on(rawshim::galosh::denoise_with(gpu, kernels, &whole, &cfa, amounts, fit));
    let whole = read(&whole);
    // The median gap and not the largest: a run picks up occasional stalls that say more about
    // what else holds the GPU than about what a caller would see between two updates.
    let tiled = |tile: usize, halo: usize| {
        let mut out = upload(&mosaic);
        let mut gaps: Vec<std::time::Duration> = Vec::new();
        let mut last = std::time::Instant::now();
        let began = std::time::Instant::now();
        pollster::block_on(rawshim::galosh::denoise_in_tiles(
            gpu,
            kernels,
            &mut out,
            &cfa,
            amounts,
            fit,
            halo,
            tile,
            |_| {
                gaps.push(last.elapsed());
                last = std::time::Instant::now();
            },
        ));
        let taken = began.elapsed();
        gaps.sort();
        (read(&out), taken, gaps.len(), gaps[gaps.len() / 2])
    };
    let apart = |a: &[f32], b: &[f32]| {
        a.iter().zip(b).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max)
    };
    // Where the difference sits, which is what says whether tiling costs reach or phase: banded
    // along the seams is a halo too short, spread over the whole frame is not.
    let describe = |a: &[f32], b: &[f32], tile: usize| {
        let (mut differing, mut worst, mut at) = (0usize, 0f32, 0usize);
        for (i, (a, b)) in a.iter().zip(b).enumerate() {
            let d = (a - b).abs();
            if d > 0.0 {
                differing += 1;
            }
            if d > worst {
                (worst, at) = (d, i);
            }
        }
        let (x, y) = (at % width, at / width);
        let seam = |v: usize, total: usize| {
            let count = total.div_ceil(tile).max(1);
            let step = total.div_ceil(count);
            (v % step).min(step - v % step)
        };
        println!(
            "    {:.3}% of samples differ; worst at ({x},{y}), {} from the nearest seam",
            100.0 * differing as f64 / a.len() as f64,
            seam(x, width).min(seam(y, height)),
        );
    };

    println!(
        "  {:>5}  {:>6}  {:>8}  {:>8}  {:>7}  {:>11}",
        "tile", "tiles", "total", "update", "vs 1x", "vs whole",
    );
    println!(
        "  {:>5}  {:>6}  {:>6}ms  {:>8}  {:>6.2}x  {:>11}",
        "-",
        1,
        one.as_millis(),
        "-",
        1.0,
        "-",
    );
    for tile in [4096usize, 2048, 1024, 512] {
        let (out, mut taken, ticks, gap) = tiled(tile, rawshim::RENDITION_TILE_HALO);
        // Best of three, since a run this long picks up whatever else wanted the GPU.
        for _ in 0..2 {
            taken = taken.min(tiled(tile, rawshim::RENDITION_TILE_HALO).1);
        }
        println!(
            "  {tile:>5}  {ticks:>6}  {:>6}ms  {:>6}ms  {:>6.2}x  {:>11e}",
            taken.as_millis(),
            gap.as_millis(),
            taken.as_secs_f64() / one.as_secs_f64(),
            apart(&out, &whole),
        );
        describe(&out, &whole, tile);
    }
}

fn request() -> rawshim::edit::EditRequest {
    rawshim::edit::EditRequest {
        long_edge: 0,
        grade: rawshim::hdr::Grade {
            peak_nits: rawshim::light::Light::exactly(1000.0),
            reference_white_nits: rawshim::light::Light::exactly(203.0),
            white_quantile: 0.995,
        },
        defringe: 1.0,
        photo_analysis: None,
        dust: Default::default(),
        repairs: Vec::new(),
        stated_white: false,
        // Nothing: this example denoises the mosaic itself, so an open that had already done it
        // would be measuring a filtered frame filtered again.
        denoise_luminance: Some(0.0),
        denoise_colour: Some(0.0),
        denoiser: rawshim::galosh::Denoiser::Galosh,
    }
}
