//! The planes the analysis reads: the panorama's own prepared sources, gathered onto one canvas.

use crate::composite_tile::{CompositeRequest, From, Layer, SourceFile};
use crate::composition::Composition;
use crate::resident::Resident;

/// The long edge every plane is measured at.
pub const ANALYSIS_LONG: usize = 3000;

/// What [`analysis_planes`] fails with when the reader asked it to stop.
///
/// A string, because `composite_tile::layers_of` carries one and nothing richer; `analyse` matches
/// on it to answer `Refused::Cancelled` rather than reporting a gather that went wrong, and the job
/// answers it verbatim, which is how the server tells a cancel from a failure (`rawshim_job.ts`).
pub const CANCELLED: &str = "cancelled";

/// Canvas samples one *independent* sample of a plane costs, at a canvas-to-plane area `ratio`.
///
/// **What the resize averages is not independent, so a box of `n` of them is worth `n / this`.**
/// The mosaic holds one red in four, so however wide the box, RCD's red plane can only average the
/// reds that were measured: `4 w_r^2 + 2 w_g^2 + 4 w_b^2` over `sum w^2` is 2.27, and the measured
/// luma asymptote is 2.34. `assembly_levels.slang`'s `level_at` then adds a chroma term, whose two
/// differences are of channels reconstructed from those same photosites, and that part *grows* with
/// the ratio - a third of the variance at 64 - because what it is left reading is the demosaic's own
/// colour error rather than the noise the box reduced.
///
/// **A fit over what was measured rather than a derivation**, at ratios 2.25 to 64 by
/// `a_plane_averages_the_measured_number_of_independent_samples`, which is the span a 12MP body and
/// a 100MP one put between their canvas and [`ANALYSIS_LONG`]. What it does not include is the lens
/// gather's own resample, which sits between the two stages and can only correlate further, so this
/// is the generous end.
pub fn correlated_samples(ratio: f64) -> f64 {
    (0.94 + 0.67 * ratio.max(1.0).ln()).max(1.0)
}

/// One source of the recipe, on the canvas, with the noise its own decode fitted.
pub struct Plane {
    /// The source's index in the recipe, which is not its position in the returned vector.
    pub source: usize,
    pub rgb: Resident,
    /// **In the mosaic's normalisation**, as every noise fit in this pipeline is, and not in the
    /// light [`rgb`] is coded in: the two differ by [`full_scale_light`] and by
    /// [`samples_averaged`], and a reader of this has to carry it across both.
    ///
    /// [`rgb`]: Plane::rgb
    /// [`full_scale_light`]: Plane::full_scale_light
    /// [`samples_averaged`]: Plane::samples_averaged
    pub noise: crate::galosh::NoiseModel,
    /// The light a full-scale mosaic sample of this source codes to, its own gain included: each
    /// source is coded against the reference's white divided by that gain, so this is where an
    /// exposure match lands and there is none left to apply downstream.
    pub full_scale_light: f32,
    /// The balance this source was demosaiced under, which is what carries the fit's shot and read
    /// terms into a luma at different factors (`base::noise_through_balance`).
    pub wb_gains: [f32; 3],
    /// Independent full-resolution samples' worth averaged into each pixel of [`rgb`]: the
    /// canvas-to-plane ratio over [`correlated_samples`] of it, never under one.
    ///
    /// The ratio is the *reference's*, the canvas being 1:1 with the reference source's centre. A
    /// source gathered at another scale - a longer focal length in a panorama, or a corner the lens
    /// magnifies - contributes a different number of its own samples to a canvas pixel and gets the
    /// reference's number, which reads its noise low where it was magnified.
    ///
    /// [`rgb`]: Plane::rgb
    pub independent_samples: f32,
}

/// Every source at [`ANALYSIS_LONG`], in the recipe's geometry, with no grade, no denoise and no
/// sharpen.
///
/// **The reference comes first, then the rest ascending, and a source the canvas does not reach is
/// absent** - so index by [`Plane::source`] rather than by position, which lines up with
/// `spec.sources` only for a recipe whose reference is its first source and all of which reaches
/// the canvas.
pub async fn analysis_planes(
    spec: &Composition,
    sources: &[SourceFile<'_>],
) -> Result<Vec<Plane>, String> {
    let refused = || crate::base::without_a_device("the analysis planes");
    let gpu = crate::gpu::device().ok_or_else(refused)?;
    let base = crate::base::device(gpu).ok_or_else(refused)?;
    let [w, h] = spec.canvas;
    let request = CompositeRequest {
        window: crate::px::Rect::exact(0, 0, w, h),
        parts: &[],
        // Scale 1: the decode is asked for the whole frame, so it demosaics rather than collapsing
        // quads, and the resize below is the only downsample.
        scale: 1.0,
        white_quantile: 0.995,
        levels: None,
        reference_white_nits: crate::light::Light::exactly(203.0),
        strengths: crate::image::Strengths {
            sharpen: 0.0,
            defringe: 0.0,
        },
        detail: crate::galosh::Detail::at(0.0, 0.0),
        sources,
        // Never the library's setting: `Plane::noise` below is GALOSH's fit off the mosaic, and a
        // camera's JPEG has none - so a carve of the cameras' pictures would score every tile
        // against a default noise model. The render is what follows the library.
        from: From::Original,
        mask: None,
    };
    let long = ANALYSIS_LONG.min(w.max(h));
    let out = match w >= h {
        true => (long, h * long / w),
        false => (w * long / h, long),
    };
    let mut planes = Vec::new();
    crate::composite_tile::layers_of(spec, &request, |source, layer, arrived| {
        let Layer { rgb, weight } = layer;
        drop(weight);
        let rgb = match crate::base::resize(gpu, base, &rgb, out) {
            Some(small) => {
                rgb.reclaim();
                small
            }
            // The canvas was already no larger than the analysis wants it.
            None => rgb,
        };
        // Off the plane rather than off `out`, the resize declining to run being the one case
        // where the two differ.
        let ratio = (w * h) as f64 / (rgb.width * rgb.height).max(1) as f64;
        planes.push(Plane {
            source,
            noise: arrived.noise.map(|f| f.model()).unwrap_or_default(),
            full_scale_light: crate::base::full_scale_light(
                arrived.coded,
                request.reference_white_nits,
            ),
            wb_gains: arrived.wb_gains,
            independent_samples: (ratio / correlated_samples(ratio)).max(1.0) as f32,
            rgb,
        });
        // A source each, and the slowest thing a carve does: this is a full decode and demosaic per
        // frame where the align worked off 800px previews.
        crate::progress::advance();
        // **And the one place a long carve can be stopped.** Every other boundary §3 looks at is
        // past this, so a reader who pressed Cancel while the frames were being decoded waited for
        // all of them - on a four-frame burst most of the wall clock - and the carve then ran to the
        // end and reported done before anything noticed.
        match crate::progress::cancelled() {
            true => Err(CANCELLED.to_string()),
            false => Ok(()),
        }
    })
    .await?;
    Ok(planes)
}

#[cfg(test)]
mod tests {
    /// What [`correlated_samples`] was measured with, and what pins it.
    ///
    /// A flat mosaic whose only content is noise of a known variance, through the real demosaic and
    /// the real resize, against the variance independent averaging would have left. The ratio is
    /// what the box could not reduce, and it is the whole of the difference between a tint noise floor
    /// that is right and one that is off by its square root.
    ///
    /// Three things are in the number and all three belong to it: RCD reconstructs a channel from a
    /// neighbourhood, so the box's taps share photosites; the box's own weights are not a flat
    /// mean; and `assembly_levels.slang`'s `level_at` adds a chroma term whose channels carry the
    /// same photosites again. What is *not* in it is the lens gather, which resamples between the
    /// two and can only correlate further.
    ///
    /// Measured before the coding rather than after it: `base::resize` boxes the light it decodes
    /// from a PQ frame, which is the same box over the same light this takes with `resize_scene`,
    /// less a quantisation three orders under the noise being measured.
    ///
    /// [`correlated_samples`]: super::correlated_samples
    #[test]
    fn a_plane_averages_the_measured_number_of_independent_samples() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(rcd) = crate::demosaic::device(gpu) else {
            return;
        };
        let Some(base) = crate::base::device(gpu) else {
            return;
        };

        const SIDE: usize = 384;
        const SIGNAL: f64 = 0.25;
        const SIGMA: f64 = 0.02;
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).expect("a bayer pattern");
        // Uniform, scaled to one sigma exactly: what is asserted is a scale rather than a tail.
        let mosaic: Vec<f32> = (0..SIDE * SIDE)
            .map(|at| {
                // splitmix64's finaliser. A multiply alone leaves a Weyl sequence, whose own
                // low-frequency structure is exactly what this measures and would be read as the
                // demosaic's.
                let mut seed = (at as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
                seed = (seed ^ (seed >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
                seed = (seed ^ (seed >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
                let u = ((seed ^ (seed >> 31)) >> 11) as f64 / (1u64 << 53) as f64 - 0.5;
                (SIGNAL + SIGMA * 12f64.sqrt() * u) as f32
            })
            .collect();
        let uploaded = crate::condition::Mosaic::upload(gpu, &mosaic, SIDE, SIDE);
        let at = crate::demosaic::Placement {
            stride: crate::px::Span::exact(SIDE),
            crop: crate::px::Rect::exact(0, 0, SIDE, SIDE),
            dest: crate::px::At::ORIGIN,
            frame: crate::px::Size::exact(SIDE, SIDE),
            orientation: 0,
            reduce: 1,
        };
        let frame = crate::demosaic::frame_buffer(gpu, SIDE * SIDE);
        // The identity, so what comes out is the mosaic's own channels and the number below is the
        // reconstruction rather than a camera's mixing of it.
        let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let colour = crate::demosaic::Colour {
            matrix: identity,
            ceiling: [1.0; 3],
        };
        let (_shape, shapes) = crate::demosaic::shape_group(gpu, rcd, &cfa, &uploaded, 0);
        pollster::block_on(crate::demosaic::demosaic_into(
            gpu, rcd, &uploaded, &cfa, &at, colour, &frame, &shapes,
        ))
        .expect("the demosaic runs");
        let demosaiced = pollster::block_on(crate::demosaic::read_frame(gpu, &frame, SIDE * SIDE))
            .expect("the frame reads back");
        let resident = crate::resident::Resident::upload(gpu, &demosaiced, SIDE, SIDE);

        let weights = crate::hdr_fit::LUMA;
        let squares: f64 = weights.iter().map(|w| w * w).sum();
        let mut measured = Vec::new();
        for out in [
            SIDE * 10 / 15,
            SIDE * 10 / 24,
            SIDE * 10 / 40,
            SIDE * 10 / 80,
        ] {
            let small = crate::base::resize_scene(gpu, base, &resident, (out, out))
                .expect("the resize runs");
            let codes = pollster::block_on(small.host()).expect("the plane reads back");
            // Past RCD's own margin, which is border-filled rather than reconstructed.
            let skip = (crate::demosaic::MARGIN as usize * out).div_ceil(SIDE) + 2;
            let mut levels = Vec::new();
            let mut plain = Vec::new();
            for y in skip..out - skip {
                for x in skip..out - skip {
                    let sample = |c: usize| f64::from(codes[(y * out + x) * 3 + c]) / 65535.0;
                    let (r, g, b) = (sample(0), sample(1), sample(2));
                    let luma = weights[0] * r + weights[1] * g + weights[2] * b;
                    // `level()`'s own reading, chroma term and all.
                    let chroma = 0.5 * ((r - luma).abs() + (b - luma).abs());
                    levels.push((luma + chroma).max(1e-6).log2());
                    plain.push(luma.max(1e-6).log2());
                }
            }
            let spread = |of: &[f64]| -> f64 {
                let mean = of.iter().sum::<f64>() / of.len() as f64;
                of.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (of.len() - 1) as f64
            };
            let variance = spread(&levels);
            let luma_only = spread(&plain);
            // One photosite's worth, in log2 of the light a pixel of this plane holds.
            let one = squares * SIGMA * SIGMA / (SIGNAL * std::f64::consts::LN_2).powi(2);
            let ratio = (SIDE * SIDE) as f64 / (out * out) as f64;
            let independent = one / variance;
            measured.push((
                ratio,
                independent,
                ratio / independent,
                ratio * luma_only / one,
            ));
        }
        for (ratio, independent, correlated, luma_only) in &measured {
            println!(
                "{ratio:.2} canvas samples a pixel: {independent:.2} independent, \
                 {correlated:.2} apiece ({luma_only:.2} without the chroma term)",
            );
        }
        for (ratio, _, correlated, _) in &measured {
            let shipped = super::correlated_samples(*ratio);
            assert!(
                (correlated - shipped).abs() < 0.25,
                "at {ratio:.2} canvas samples a pixel the demosaic and the resize leave \
                 {correlated:.2} of them per independent one, against the {shipped:.2} this ships",
            );
        }
    }
}
