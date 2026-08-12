//! How much noise the prepared frame has.
//!
//! The editor's denoise (`web/src/features/raw_edit/gpu/denoise_chain.ts`) needs to know what its
//! input's noise is before it can shrink anything, and it used to measure that itself: the
//! quietest tenth of the frame's blocks, in four dispatches, on every slider move. The frame is
//! built on this side, so the measurement belongs here - the estimator reduces every block in the
//! frame before the first pixel can be denoised, and prepare is holding that frame anyway.
//!
//! **The estimate is binned by level even though what ships is one number**, and that is the part
//! worth explaining. The prepared frame is PQ-coded, and in PQ a frame's noise against level
//! falls hard: on an ISO 25600 frame the stabilised sigma runs from 1.9 in the low midtones to
//! under 0.01 near white, because PQ compresses the highlights faster than shot noise grows into
//! them. A quantile over the *whole* frame is therefore not a quantile of anything - it lands
//! wherever that frame's histogram happens to sit. Taking the quiet tail per bin and then
//! collapsing by how many blocks each bin holds gives a number that means "the noise of a typical
//! block", with texture excluded inside each bin and the frame's own exposure accounted for.
//!
//! **Why not ship the curve, given it was measured.** Because there is nowhere to put it. The
//! plane is scaled to unit noise before `pass12`, and dividing it by a factor that varies from
//! pixel to pixel writes the *image's own gradient* into the plane whose local deviation the
//! shrinkage then measures - `mad_sigma_y_sq` inflates, `sigma_x_sq` with it, and lambda
//! collapses. Measured on the ISO 25600 frame at full strength: one sigma leaves a roughness of
//! 1.43 where the per-level curve of the same magnitude leaves 3.89, having barely denoised at
//! all. A per-level threshold is still the better answer, but it has to arrive as a *threshold
//! per block* inside `pass12` rather than as a scaling of its input, and that kernel is shared
//! with the mosaic path and pinned against the reference.
//!
//! This is the editor's estimator alone. The mosaic path fits `alpha` and `sigma_sq` on the CFA
//! in linear light, where the Poisson-Gaussian form is the right one and a fit is the better
//! answer (`galosh.rs`, DESIGN 10.9.1).

use serde::Serialize;

/// Levels the estimate is binned over, spanning 0 to 1 in equal steps.
///
/// Matches the mosaic path's bin count, which is where the binning came from; nothing forces
/// the two to agree.
pub const BINS: usize = 32;

/// The 8x8 neighbourhood a block statistic is taken over.
const BLOCK: usize = 8;

/// A bin with fewer blocks than this has no envelope worth taking, and is filled from its
/// neighbours instead.
const MIN_BLOCKS: usize = 20;

/// What a demosaiced frame's noise is worth against what a Laplacian reads off it.
///
/// **The estimator here and the threshold in `pass12` do not measure the same thing, and this is
/// the ratio between them.** A three-tap Laplacian's MAD becomes a sigma through `0.6745 * √6`,
/// which is derived for *independent* samples. Adjacent pixels of a demosaiced frame are not
/// independent: two thirds of every pixel was interpolated from its neighbours, so they share
/// noise and the Laplacian cancels much of it. The shrinkage has no such luck - it thresholds
/// against the MAD of a block's Walsh-Hadamard coefficients, where the correlated part is
/// present in full - so a sigma read this way is far below the noise the shrinkage is actually
/// looking at, and a slider position that should have meant "remove all of it" removed a third.
///
/// Calibrated against the mosaic path rather than derived, because what it has to reproduce is
/// that path's *answer*: at Detail 40, on 480px crops, the luma roughness the editor is left
/// with against the rendition of the same crop.
///
/// | ISO | before | after | rendition |
/// |---|---|---|---|
/// | 25600 | 1.87 | 1.25 | 1.26 |
/// | 2000 | 3.41 | 1.17 | 0.78 |
/// | 100 | 0.82 | 0.65 | 0.35 |
///
/// It lands on the pushed frame and stays short on the clean ones, which is the direction to be
/// wrong in twice over: the absolute noise there is nothing anybody is looking at, and a preview
/// that under-denoises shows grain the export will not have where one that over-denoised would
/// promise detail the export cannot keep.
///
/// **The gap that is left is not this constant's to close.** A mosaic is denoised before the
/// demosaic correlates anything, so the rendition starts from a quieter frame than the editor
/// can ever be handed - 3.11 against 4.79 on the ISO 2000 crop with the denoise off entirely.
/// Raising this further only smears; the editor asymptotes around 1.0 there whatever it is set
/// to.
const DEMOSAIC_CORRELATION: f32 = 3.0;

/// What a tick is told about its input's noise.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Noise {
    /// Sigma of the *stabilised* luma, for a typical block of this frame.
    ///
    /// Stabilised rather than coded because that is the plane the shrinkage runs on, and the
    /// number the client divides it by so the thresholds land in units of one sigma.
    pub stabilised: f32,
    /// The transform that sigma was measured through, which the client applies verbatim.
    pub alpha: f32,
    pub sigma_sq: f32,
}

/// The generalised Anscombe forward transform, as `yuv_gat_fwd.wgsl` computes it.
fn stabilise(level: f32, alpha: f32, sigma_sq: f32) -> f32 {
    let c = 0.375 * alpha * alpha + sigma_sq;
    (2.0 / alpha.max(1e-12)) * (alpha * level + c).max(0.0).sqrt()
}

/// Rec.2020 luma of the prepared frame, normalised - the plane `yuv_split` builds.
fn luma(samples: &[u16], npix: usize) -> Vec<f32> {
    (0..npix)
        .map(|i| {
            let at = i * 3;
            (0.2627 * f32::from(samples[at])
                + 0.6780 * f32::from(samples[at + 1])
                + 0.0593 * f32::from(samples[at + 2]))
                / 65535.0
        })
        .collect()
}

/// One 8x8 block: where it sits, and how much it deviates.
struct Block {
    level: f32,
    sigma: f32,
}

/// Per block, its mean level on one plane and its noise on another.
///
/// Two planes because the curve is the stabilised plane's noise at the *unstabilised* plane's
/// level, which is the pairing a tick can actually look up. Pass the same slice twice to measure
/// a plane against itself.
fn blocks(level_plane: &[f32], noise_plane: &[f32], width: usize, height: usize) -> Vec<Block> {
    let mut out = Vec::with_capacity((width / BLOCK) * (height / BLOCK));
    let mut laps: Vec<f32> = Vec::with_capacity(2 * BLOCK * (BLOCK - 2));
    for by in 0..height / BLOCK {
        for bx in 0..width / BLOCK {
            let (x0, y0) = (bx * BLOCK, by * BLOCK);
            let mut sum = 0.0;
            laps.clear();
            for y in 0..BLOCK {
                let row = (y0 + y) * width + x0;
                for x in 0..BLOCK {
                    sum += level_plane[row + x];
                }
                for x in 0..BLOCK - 2 {
                    let (a, b, c) = (noise_plane[row + x], noise_plane[row + x + 1], noise_plane[row + x + 2]);
                    laps.push((a - 2.0 * b + c).abs());
                }
            }
            for y in 0..BLOCK - 2 {
                for x in 0..BLOCK {
                    let at = |dy: usize| noise_plane[(y0 + y + dy) * width + x0 + x];
                    laps.push((at(0) - 2.0 * at(1) + at(2)).abs());
                }
            }
            let mid = laps.len() / 2;
            laps.select_nth_unstable_by(mid, f32::total_cmp);
            // The median absolute Laplacian of iid noise is 0.6745 * sqrt(6) sigma.
            out.push(Block {
                level: sum / (BLOCK * BLOCK) as f32,
                sigma: laps[mid] / 1.6521,
            });
        }
    }
    out
}

/// The quiet tail of a set of blocks: the 5th to 20th percentile, averaged.
///
/// Everything above that is carrying a picture as well as noise. A plain median would count
/// texture as noise, which on a detailed frame reads several times high.
fn envelope(sigmas: &mut [f32]) -> Option<f32> {
    if sigmas.len() < MIN_BLOCKS {
        return None;
    }
    sigmas.sort_by(f32::total_cmp);
    let low = sigmas.len() / 20;
    let high = (sigmas.len() / 5).max(low + 1).min(sigmas.len());
    Some(sigmas[low..high].iter().sum::<f32>() / (high - low) as f32)
}

/// Measures the frame a tick is about to be handed.
///
/// `samples` is interleaved RGB at `width` by `height`, PQ-coded, exactly as it crosses the
/// wire - so what this reports is the noise of the buffer the client denoises rather than of
/// some earlier state of it. That matters: the warp resamples and the sharpen amplifies, and
/// both run before this.
pub fn measure(samples: &[u16], width: usize, height: usize) -> Noise {
    let (binned, alpha, sigma_sq) = sample(samples, width, height);
    // Only `stabilised` is corrected. It is the one the shrinkage divides by, and so the one
    // that has to be in the units `pass12` thresholds in; `alpha` and `sigma_sq` parameterise
    // the transform the plane is measured *through*, and scaling those would move the domain
    // rather than the threshold.
    let stabilised = typical(&binned).map_or(1e-6, |sigma| (sigma * DEMOSAIC_CORRELATION).max(1e-6));
    Noise { stabilised, alpha, sigma_sq }
}

/// One level bin: the noise of its quiet blocks, and how many blocks fell in it.
pub struct Bin {
    pub sigma: Option<f32>,
    pub blocks: usize,
}

/// The measurement before it is collapsed, bin by bin, for a diagnostic that wants the shape.
///
/// A bin the frame has no pixels in reports `None` rather than a filled-in neighbour: whether a
/// frame's histogram was wide enough for any of this to mean something is exactly what a caller
/// looking at the shape is asking.
pub fn sample(samples: &[u16], width: usize, height: usize) -> (Vec<Bin>, f32, f32) {
    let empty = || (0..BINS).map(|_| Bin { sigma: None, blocks: 0 }).collect();
    let npix = width * height;
    // A frame too small to bin is one the denoise declines anyway.
    if npix == 0 || samples.len() < npix * 3 || width < BLOCK || height < BLOCK {
        return (empty(), 1e-5, 1e-8);
    }

    let plane = luma(samples, npix);
    let coarse = blocks(&plane, &plane, width, height);

    // One sigma to parameterise the transform with. The split into alpha and sigma_sq is the
    // reference's fixed ratio and stays a guess - what makes that survivable is that the sigma
    // below is measured *through* whatever transform this produces, and so absorbs its error
    // rather than inheriting it.
    let mut all: Vec<f32> = coarse.iter().map(|b| b.sigma).collect();
    let sigma = envelope(&mut all).unwrap_or(1e-5).max(1e-5);
    let alpha = (sigma * 0.1).max(1e-5);
    let sigma_sq = (sigma * sigma).max(1e-8);

    let stabilised_plane: Vec<f32> = plane.iter().map(|v| stabilise(*v, alpha, sigma_sq)).collect();
    let measured = blocks(&plane, &stabilised_plane, width, height);

    let mut bins: Vec<Vec<f32>> = vec![Vec::new(); BINS];
    for block in &measured {
        let bin = (block.level * BINS as f32) as usize;
        bins[bin.min(BINS - 1)].push(block.sigma);
    }
    let binned = bins
        .iter_mut()
        .map(|sigmas| Bin { blocks: sigmas.len(), sigma: envelope(sigmas) })
        .collect();
    (binned, alpha, sigma_sq)
}

/// The bins collapsed to the sigma of a typical block: the median, weighted by how many blocks
/// each bin holds.
///
/// Weighted, because the bins are levels rather than pixels. In PQ the sigma falls by orders of
/// magnitude from the low midtones to white, so an unweighted middle is a statement about the
/// *scale* rather than about the photograph - a frame with a bright sky and a frame shot at
/// night would get similar answers from it. Weighting puts the number where the content is.
/// `None` where no bin held enough blocks to measure, which is a frame the denoise declines
/// rather than one whose noise is very small - the difference matters, because a floor that had
/// been through [`DEMOSAIC_CORRELATION`] would no longer read as "nothing".
fn typical(binned: &[Bin]) -> Option<f32> {
    let measured: Vec<&Bin> = binned.iter().filter(|bin| bin.sigma.is_some()).collect();
    let total: usize = measured.iter().map(|bin| bin.blocks).sum();
    if total == 0 {
        return None;
    }
    let mut seen = 0usize;
    for bin in &measured {
        seen += bin.blocks;
        if seen * 2 >= total {
            return bin.sigma;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{BINS, measure, sample};

    /// A frame of one level plus gaussian noise, as `u16` PQ codes.
    fn flat(width: usize, height: usize, level: f32, sigma: f32) -> Vec<u16> {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut normal = || {
            // Sum of twelve uniforms, minus six: mean 0, variance 1, and no dependency.
            (0..12)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    (state >> 40) as f32 / 16777216.0
                })
                .sum::<f32>()
                - 6.0
        };
        (0..width * height)
            .flat_map(|_| {
                let v = ((level + sigma * normal()) * 65535.0).clamp(0.0, 65535.0) as u16;
                [v, v, v]
            })
            .collect()
    }

    /// **Ten times the noise reads as about three times the sigma, and that is the transform
    /// working rather than the measurement failing.** `alpha` is derived from the frame's own
    /// sigma, so a noisier frame is stabilised harder: the transform's slope goes as
    /// `1/sqrt(alpha * level)`, which with `alpha` proportional to sigma leaves what comes out
    /// growing as sigma's square root. What the tick needs from this is the plane it will
    /// actually shrink, and that plane really is only root-ten noisier.
    #[test]
    fn a_noisier_frame_reads_noisier() {
        let quiet = measure(&flat(256, 256, 0.4, 0.002), 256, 256).stabilised;
        let loud = measure(&flat(256, 256, 0.4, 0.02), 256, 256).stabilised;
        let ratio = loud / quiet;
        assert!((2.0..4.5).contains(&ratio), "ten times the noise read as {loud} against {quiet}");
    }

    /// **The number lands where the content is, not in the middle of the scale.** Two thirds of
    /// this frame is a quiet highlight and a third is a noisy shadow, and a weighted collapse
    /// has to answer for the majority - an unweighted middle of the bins would answer for
    /// whichever levels happen to be represented at all.
    #[test]
    fn the_typical_block_decides_rather_than_the_level_range() {
        let (width, tall) = (256usize, 512usize);
        let (most, rest) = (tall * 2 / 3, tall - tall * 2 / 3);
        let mut mostly_clean = flat(width, most, 0.75, 0.001);
        mostly_clean.extend(flat(width, rest, 0.15, 0.02));
        let mut mostly_noisy = flat(width, rest, 0.75, 0.001);
        mostly_noisy.extend(flat(width, most, 0.15, 0.02));

        let clean = measure(&mostly_clean, width, tall).stabilised;
        let noisy = measure(&mostly_noisy, width, tall).stabilised;
        assert!(noisy > clean * 2.0, "mostly noisy {noisy} against mostly clean {clean}");
    }

    /// The shape is still measured, and is still level-dependent - what changed is that one
    /// number crosses rather than the curve. If this ever stops holding, a per-block threshold
    /// inside `pass12` is worth what it costs (see this module's own notes).
    #[test]
    fn the_bins_disagree_with_each_other_across_levels() {
        let (width, tall) = (256usize, 512usize);
        let mut samples = flat(width, tall / 2, 0.15, 0.02);
        samples.extend(flat(width, tall / 2, 0.75, 0.001));
        let (binned, _, _) = sample(&samples, width, tall);
        let at = |level: f32| binned[((level * BINS as f32) as usize).min(BINS - 1)].sigma;
        let (shadow, highlight) = (at(0.15).expect("a shadow bin"), at(0.75).expect("a bright bin"));
        assert!(shadow > highlight * 4.0, "shadow {shadow} against highlight {highlight}");
    }

    #[test]
    fn a_frame_too_small_to_bin_is_declined_rather_than_guessed() {
        let noise = measure(&flat(4, 4, 0.4, 0.01), 4, 4);
        assert!(noise.stabilised <= 1e-6, "{}", noise.stabilised);
        let (binned, _, _) = sample(&flat(4, 4, 0.4, 0.01), 4, 4);
        assert_eq!(binned.len(), BINS);
        assert!(binned.iter().all(|bin| bin.sigma.is_none()));
    }
}
