//! Scratch: what the mosaic denoise costs on a tile rather than a frame.
//!
//! The loupe wants a rendition-quality crop per pointer move. Denoising the whole frame for one
//! is seconds; the question this answers is whether denoising just the tile is milliseconds.

fn main() {
    let gpu = rawshim::gpu::device().expect("an adapter");
    let galosh = rawshim::galosh::device(gpu).expect("the denoise");
    let amounts = rawshim::galosh::Amounts::from_sliders(40.0, 40.0);
    let cfa = rawshim::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB is a pattern");

    println!("{:>7}  {:>9}  {:>9}  {:>9}", "side", "pixels", "first", "steady");
    for side in [256usize, 512, 768, 1024, 1536, 2048, 3072] {
        // A mosaic of plausible level with a little noise on it, which is all the timing needs.
        let mut state = 12345u64;
        let mosaic: Vec<f32> = (0..side * side)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                0.25 + ((state >> 40) as f32 / 16777216.0 - 0.5) * 0.02
            })
            .collect();
        let mosaic = rawshim::condition::Mosaic::upload(gpu, &mosaic, side, side);

        let started = std::time::Instant::now();
        pollster::block_on(rawshim::galosh::denoise(gpu, galosh, &mosaic, &cfa, amounts));
        let first = started.elapsed();

        // Again, with the pipelines and the allocator warm - which is the state a loupe would
        // actually be asking in.
        let mut best = std::time::Duration::from_secs(9999);
        for _ in 0..3 {
            let round = std::time::Instant::now();
            pollster::block_on(rawshim::galosh::denoise(gpu, galosh, &mosaic, &cfa, amounts));
            best = best.min(round.elapsed());
        }

        println!(
            "{side:>7}  {:>8.2}MP  {:>7}ms  {:>7}ms",
            (side * side) as f64 / 1e6,
            first.as_millis(),
            best.as_millis(),
        );
    }
}
