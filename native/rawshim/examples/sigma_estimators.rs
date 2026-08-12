//! Two ways of asking a frame how noisy it is, on the plane the editor denoises.
//!
//! The editor measures sigma as a **global median** of the three-tap Laplacian, over the
//! whole frame (a global median). The mosaic path does not: Phase 0 bins blocks by level and
//! keeps the 5th-to-20th percentile of each bin's variance - the *envelope* - which is the
//! part of the frame that is only noise.
//!
//! The difference matters because of what the shrinkage does with the answer. Its threshold
//! is stated in units of this sigma, and when a block's own MAD falls to or below it the
//! block's whole AC is zeroed rather than shrunk. An estimator that counts texture as noise
//! therefore does not merely over-smooth by a little: it flattens every block that is
//! quieter than the texture it was fooled by.
//!
//! Reports both over the same luma plane, so the ratio is the inflation.

fn luma_plane(path: &str) -> Option<(Vec<f32>, usize, usize)> {
    let frame = rawshim::decode_frame(path, 16, true, 0)?;
    let samples = frame.samples16()?;
    let (width, height) = (frame.width, frame.height);
    // The domain the editor's denoise runs in: normalised PQ, then Rec.2020 luma.
    let mut coded = samples.to_vec();
    let levels = rawshim::tone::levels(&coded, 0.995);
    rawshim::tone::encode_base(&mut coded, levels.anchored(), 203.0);
    let plane = (0..width * height)
        .map(|i| {
            let at = i * 3;
            (0.2627 * f32::from(coded[at])
                + 0.6780 * f32::from(coded[at + 1])
                + 0.0593 * f32::from(coded[at + 2]))
                / 65535.0
        })
        .collect();
    Some((plane, width, height))
}

/// What a global median computes: the median |Laplacian| over the whole frame.
fn global_median(plane: &[f32], width: usize, height: usize) -> f32 {
    let mut samples: Vec<f32> = Vec::new();
    for y in 0..height {
        let row = y * width;
        for x in (0..width.saturating_sub(4)).step_by(3) {
            samples.push((plane[row + x] - 2.0 * plane[row + x + 2] + plane[row + x + 4]).abs());
        }
    }
    if samples.is_empty() {
        return 0.0;
    }
    let mid = samples.len() / 2;
    samples.select_nth_unstable_by(mid, f32::total_cmp);
    samples[mid] / 1.6521
}

/// What Phase 0 computes: the low envelope of per-block variance, which excludes the blocks
/// that have texture in them.
fn envelope(plane: &[f32], width: usize, height: usize) -> f32 {
    const BLOCK: usize = 8;
    let mut per_block: Vec<f32> = Vec::new();
    for by in 0..height / BLOCK {
        for bx in 0..width / BLOCK {
            let mut laps: Vec<f32> = Vec::with_capacity(48);
            for y in 0..BLOCK {
                let row = (by * BLOCK + y) * width + bx * BLOCK;
                for x in 0..BLOCK - 2 {
                    laps.push((plane[row + x] - 2.0 * plane[row + x + 1] + plane[row + x + 2]).abs());
                }
            }
            let mid = laps.len() / 2;
            laps.select_nth_unstable_by(mid, f32::total_cmp);
            per_block.push(laps[mid] / 1.6521);
        }
    }
    if per_block.is_empty() {
        return 0.0;
    }
    // The 5th to 20th percentile, averaged: the quietest blocks are the ones carrying only
    // noise, and everything above them is carrying a picture as well.
    per_block.sort_by(f32::total_cmp);
    let low = per_block.len() / 20;
    let high = (per_block.len() / 5).max(low + 1).min(per_block.len());
    per_block[low..high].iter().sum::<f32>() / (high - low) as f32
}

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    println!("{:>8}  {:>10}  {:>10}  {:>7}  {}", "iso", "median", "envelope", "inflated", "file");
    for path in &paths {
        let Some(header) = rawshim::header::read_path(path) else {
            continue;
        };
        let Some((plane, width, height)) = luma_plane(path) else {
            continue;
        };
        let median = global_median(&plane, width, height);
        let floor = envelope(&plane, width, height);
        println!(
            "{:>8.0}  {median:>10.6}  {floor:>10.6}  {:>6.1}x  {}",
            header.iso,
            if floor > 0.0 { median / floor } else { 0.0 },
            path.rsplit('/').next().unwrap_or(path),
        );
    }
}
