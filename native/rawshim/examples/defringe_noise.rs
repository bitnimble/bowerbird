//! What the defringe's focus-difference estimate reads off a frame that carries nothing but grain.
//!
//! `measure_defocus` subtracts the noise's own contribution to both of its sums analytically, from
//! per-channel variances alone. That derivation assumes the three channels' noise is independent,
//! and `image.rs`'s fixture asserts it against exactly that - grain drawn per channel. A demosaic
//! builds red and blue out of green, so the frame the estimate actually runs on has correlated
//! channels, and a cross-covariance the subtraction has no term for.
//!
//! ```text
//! defringe_noise --raw <file> [--crop N] [--achromatic] [--inject R,B] [sigma...]
//! ```
//!
//! Two arms. A flat field says what RCD does to grain with no picture to hide it - the whole
//! covariance of the reconstruction's noise, which is what the correction has to propagate. A
//! photograph's own mosaic, given the same grain at rising strengths, says what that costs: the
//! frame's focus difference is whatever it is, so the answer at zero grain is the baseline and
//! every drift away from it is the estimate reading noise it did not remove.
//!
//! **The second arm needs a real photograph and a synthetic will not stand in for one.** The fit
//! divides by curvature energy after subtracting the measured noise's share, so a field smooth
//! enough to synthesise is one where that subtraction takes all of it and the estimate declines
//! with nothing to say.

fn main() {
    let mut args = std::env::args().skip(1);
    let mut level = 0.25f32;

    let mut raw: Option<String> = None;
    let mut crop: Option<usize> = None;
    let mut inject: Option<(f32, f32)> = None;
    let mut achromatic = false;
    let mut sigmas = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--level" => level = args.next().and_then(|v| v.parse().ok()).unwrap_or(level),
            "--raw" => raw = args.next(),
            "--crop" => crop = args.next().and_then(|v| v.parse().ok()),
            "--inject" => inject = args.next().and_then(|v| pair(&v)),
            "--achromatic" => achromatic = true,
            // Refused rather than ignored: the numbers this prints become constants in `image.rs`,
            // and a mistyped flag swallowed as a sigma prints a plausible table of the wrong thing.
            other => match other.parse::<f32>() {
                Ok(sigma) => sigmas.push(sigma),
                Err(_) => panic!("unknown argument {other}"),
            },
        }
    }
    if sigmas.is_empty() {
        sigmas = vec![0.002, 0.005, 0.01, 0.02, 0.04];
    }

    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("no adapter");
        std::process::exit(2);
    };
    let Some(rcd) = rawshim::demosaic::device(gpu) else {
        eprintln!("no demosaic pipelines");
        std::process::exit(2);
    };
    let Some(base) = rawshim::base::device(gpu) else {
        eprintln!("no base pipelines");
        std::process::exit(2);
    };

    let path = raw.expect("--raw <file>; a synthetic will not stand in for one, see above");
    // Cropped unless told otherwise, because the whole of a 61MP frame is not survivable here:
    // four `f32` planes of it is 3GB and the process is killed with no output at all.
    let picture = centre(read_mosaic(&path).expect("the RAW reads"), crop.unwrap_or(2400));
    let (w, h) = (picture.width, picture.height);
    let (native, matrix) = (picture.native, picture.matrix);
    let cfa = &picture.cfa;
    let structure = match achromatic {
        true => greyed(gpu, rcd, &picture.plane, cfa, w, h).expect("the demosaic runs"),
        false => picture.plane.clone(),
    };
    // The content with no grain on it, past the matrix, so a noisy reconstruction of the same
    // content can be differenced against it.
    let quiet = reconstruct_coded(gpu, rcd, &structure, cfa, w, h, matrix);
    // No copy of `image.rs`'s constants here: they are private, so one printed would go stale with
    // nothing to notice.
    println!(
        "{w}x{h}, cfa {cfa:?}, content {}, native sigma {}",
        path,
        native.map_or("-".to_string(), |fit| {
            format!("{:.5} (gat {:.3})", fit.model().at_white(), fit.unified_sigma)
        }),
    );
    println!(
        "{:>7}  {:>17}  {:>15}  {:>17}  {:>17}  {:>16}  {:>16}",
        "sigma",
        "post corr, measured",
        "3x3 keeps vs .83",
        "noise alone",
        "added by grain",
        "as it stands",
        "plus injection"
    );

    for sigma in std::iter::once(0.0).chain(sigmas) {
        // Clamped, as a sensor's own range clamps it. Left unclamped the grain drives sites
        // negative, RCD's ratio corrections divide through them, and the reconstruction comes back
        // with a spread several times full scale - which is the probe's arithmetic rather than
        // anything a decode would ever hand the stage.
        let grain = |value: f32, rng: &mut Lcg| (value + sigma * rng.normal()).clamp(0.0, 1.0);
        let mosaic: Vec<f32> = {
            let mut rng = Lcg::new(0x5eed_0000 ^ (sigma.to_bits() as u64));
            (0..w * h).map(|_| grain(level, &mut rng)).collect()
        };
        let structured_mosaic: Vec<f32> = {
            let mut rng = Lcg::new(0x57ac_0000 ^ (sigma.to_bits() as u64));
            structure.iter().map(|&v| grain(v, &mut rng)).collect()
        };
        let structured = &structured_mosaic;
        let Some(structured) = reconstruct(gpu, rcd, structured, cfa, w, h) else {
            eprintln!("{sigma}: the demosaic declined");
            continue;
        };

        // Both sides of `assemble`, over the same grain: what RCD produced, and what the estimate
        // is handed once the camera matrix has remixed it.
        let coded = reconstruct_coded(gpu, rcd, &mosaic, cfa, w, h, matrix);
        let coded_stats = coded.as_ref().map(|plane| Stats::of(plane, w, h));
        // Over the flat arm, which is nothing but reconstructed grain, so this is the stencil's
        // response to noise alone with no picture underneath it to confuse the ratio.
        let stencil = coded.as_ref().and_then(|plane| stencil_terms(plane, w, h));
        // Over the flat arm, which is pure reconstructed grain: what a 3x3-mean residual keeps of
        // it, which is the divisor `image::sigma_from` needs.
        let kept = coded.as_ref().and_then(|plane| residual_fraction(plane, w, h));
        // What the grain actually adds to the fit's sums over this content, coupling included,
        // against what the noise measured on its own predicts it should.
        let added = quiet.as_ref().and_then(|clean| {
            let noisy = reconstruct_coded(gpu, rcd, &structured_mosaic, cfa, w, h, matrix)?;
            added_terms(clean, &noisy, w, h)
        });
        let pearson =
            |stats: &Stats| {
                format!(
                    "{:+.2} {:+.2} {:+.2}",
                    stats.correlation[0], stats.correlation[1], stats.correlation[2]
                )
            };
        // The same reconstruction with a known softness on it, so the row below carries an answer
        // the fit can be graded against rather than only compared with its neighbours.
        let mut softened = structured.clone();
        if let Some(amounts) = inject {
            soften(&mut softened, w, h, amounts);
        }
        let told = as_fitted(sigma, native);
        println!(
            "{sigma:>7.4}  {:>17}  {:>15}  {:>17}  {:>17}  {:>16}  {:>16}",
            coded_stats.as_ref().map_or("-".to_string(), pearson),
            kept.map_or("-".to_string(), |fraction| format!("{fraction:.3}")),
            stencil.map_or("-".to_string(), |terms| {
                format!("{:.2} {:+.2} {:+.2}", terms[0], terms[1], terms[2])
            }),
            added.map_or("-".to_string(), |terms| {
                format!("{:.2} {:+.2} {:+.2}", terms[0], terms[1], terms[2])
            }),
            show(fit(gpu, base, &structured, w, h, told, matrix)),
            show(fit(gpu, base, &softened, w, h, told, matrix)),
        );
    }
}

fn pair(text: &str) -> Option<(f32, f32)> {
    let (red, blue) = text.split_once(',')?;
    Some((red.trim().parse().ok()?, blue.trim().parse().ok()?))
}

/// Softens `channels` of a reconstruction by a known amount, so the fit has an answer to be right
/// about.
///
/// **Flatness across noise is not accuracy.** Sweeping grain says only that the estimate does not
/// move; it cannot say the number was ever correct, and the zero-grain row is no baseline either
/// because the photograph carries noise of its own. One step of the heat equation, `v + s.lap(v)`,
/// blurs a channel and leaves it carrying `s.lap(luma)` where the frame is achromatic - which is
/// the model `measure_defocus` fits, so `s` is what it should report over whatever the lens
/// already put there.
fn soften(plane: &mut [f32], width: usize, height: usize, softness: (f32, f32)) {
    let before = plane.to_vec();
    let at = |x: usize, y: usize, c: usize| before[(y * width + x) * 3 + c];
    for y in 0..height {
        for x in 0..width {
            for (c, amount) in [(0usize, softness.0), (2, softness.1)] {
                let curvature = at(x.saturating_sub(1), y, c)
                    + at((x + 1).min(width - 1), y, c)
                    + at(x, y.saturating_sub(1), c)
                    + at(x, (y + 1).min(height - 1), c)
                    - 4.0 * at(x, y, c);
                plane[(y * width + x) * 3 + c] = at(x, y, c) + amount * curvature;
            }
        }
    }
}

/// What a five-point Laplacian of luma actually returns over a field of pure reconstructed noise,
/// as a multiple of luma's own variance.
///
/// **The number `measure_defocus` assumes here is 20, and 20 is the independent-noise answer.** The
/// stencil is `n(x-1) + n(x+1) + n(y-1) + n(y+1) - 4.n(x)`, whose variance is `(1+1+1+1+16).v` only
/// when no two of those five share anything. A demosaic interpolates, so neighbouring pixels are
/// built partly from the same photosites and the difference between them is smaller than their
/// spread implies - the same smoothing that correlates the channels, one axis over.
fn stencil_terms(plane: &[f32], width: usize, height: usize) -> Option<[f64; 3]> {
    const MARGIN: usize = 12;
    let at = |x: usize, y: usize, c: usize| f64::from(plane[(y * width + x) * 3 + c]);
    let luma = |x: usize, y: usize| -> f64 {
        (0..3).map(|c| f64::from(rawshim::image::LUMA[c]) * at(x, y, c)).sum()
    };
    let (mut sum, mut square, mut curved, mut counted) = (0f64, 0f64, 0f64, 0f64);
    let mut against = [0f64; 2];
    for y in MARGIN..height.saturating_sub(MARGIN) {
        for x in MARGIN..width.saturating_sub(MARGIN) {
            let here = luma(x, y);
            let curvature =
                luma(x - 1, y) + luma(x + 1, y) + luma(x, y - 1) + luma(x, y + 1) - 4.0 * here;
            for (slot, channel) in [0usize, 2].into_iter().enumerate() {
                against[slot] += curvature * (at(x, y, channel) - here);
            }
            sum += here;
            square += here * here;
            curved += curvature * curvature;
            counted += 1.0;
        }
    }
    let variance = square / counted - (sum / counted).powi(2);
    // A field with no grain in it has no variance to take a ratio over, and the quotient is then
    // whatever the rounding left behind.
    (variance > 1e-12)
        .then(|| [curved / counted, against[0] / counted, against[1] / counted].map(|v| v / variance))
}

/// What fraction of a plane's noise survives the residual of a 3x3 mean, against the 0.83
/// `image::sigma_from` divides by.
///
/// **That constant is the independent-noise answer too.** A pixel's own grain is 8/9 of what a 3x3
/// mean of it returns, so subtracting the mean leaves most of it - but only where the eight
/// neighbours carry nothing of this pixel. A demosaic builds them partly out of the same
/// photosites, so the mean predicts the centre far better than that and the residual keeps much
/// less. Whatever this returns is the divisor `sigma_from` should be using; 0.83 over it is the
/// factor by which the fit's noise estimate is wrong.
fn residual_fraction(plane: &[f32], width: usize, height: usize) -> Option<f64> {
    const MARGIN: usize = 12;
    let weight = rawshim::image::LUMA;
    let luma = |x: usize, y: usize| -> f64 {
        (0..3).map(|c| f64::from(weight[c]) * f64::from(plane[(y * width + x) * 3 + c])).sum()
    };
    let (mut sum, mut square, mut counted) = (0f64, 0f64, 0f64);
    let mut residuals: Vec<f64> = Vec::new();
    for y in MARGIN..height.saturating_sub(MARGIN) {
        for x in MARGIN..width.saturating_sub(MARGIN) {
            let here = luma(x, y);
            let mean: f64 = (0..9)
                .map(|k| luma(x + k % 3 - 1, y + k / 3 - 1))
                .sum::<f64>()
                / 9.0;
            residuals.push((here - mean).abs());
            sum += here;
            square += here * here;
            counted += 1.0;
        }
    }
    let variance = square / counted - (sum / counted).powi(2);
    if variance <= 1e-12 || residuals.is_empty() {
        return None;
    }
    residuals.sort_by(f64::total_cmp);
    // The same estimator `sigma_from` is: a median absolute residual, scaled to a Gaussian sigma.
    let sigma = residuals[residuals.len() / 2] * 1.4826;
    Some(sigma / variance.sqrt())
}

/// What adding grain actually changes about the fit's two sums, over the same content.
///
/// **The difference of the sums, not the sums of the difference.** `stencil_terms` measures the
/// reconstruction's noise by itself, which is the right quantity only if the noise and the picture
/// are independent - and RCD chooses its interpolation direction *from the noisy data*, so its
/// error is correlated with the content by construction. Whatever that coupling contributes lands
/// in the fit's sums and in nothing the noise-alone measurement can see.
///
/// So: the same patch reconstructed clean and noisy, each sum taken over the whole reconstruction,
/// and the difference reported per unit of luma noise variance. That is what the correction has to
/// remove, coupling and all.
fn added_terms(clean: &[f32], noisy: &[f32], width: usize, height: usize) -> Option<[f64; 3]> {
    const MARGIN: usize = 12;
    // Both loops below step from `MARGIN` to `size - MARGIN`, which is a wrapping subtraction on
    // anything smaller than the margins - a `--crop` under 24 indexes far off the end of the plane.
    if width <= 2 * MARGIN || height <= 2 * MARGIN {
        return None;
    }
    if clean.len() < width * height * 3 || noisy.len() < width * height * 3 {
        return None;
    }
    let weight = rawshim::image::LUMA;
    let sums = |plane: &[f32]| -> [f64; 3] {
        let at = |x: usize, y: usize, c: usize| f64::from(plane[(y * width + x) * 3 + c]);
        let luma = |x: usize, y: usize| (0..3).map(|c| f64::from(weight[c]) * at(x, y, c)).sum::<f64>();
        let (mut curved, mut red, mut blue) = (0f64, 0f64, 0f64);
        for y in MARGIN..height - MARGIN {
            for x in MARGIN..width - MARGIN {
                let here = luma(x, y);
                let curvature =
                    luma(x - 1, y) + luma(x + 1, y) + luma(x, y - 1) + luma(x, y + 1) - 4.0 * here;
                curved += curvature * curvature;
                red += curvature * (at(x, y, 0) - here);
                blue += curvature * (at(x, y, 2) - here);
            }
        }
        [curved, red, blue]
    };
    let (before, after) = (sums(clean), sums(noisy));
    // The luma variance of the grain itself, which is what the fit scales its subtraction by.
    let variance = {
        let at = |x: usize, y: usize, c: usize| {
            f64::from(noisy[(y * width + x) * 3 + c]) - f64::from(clean[(y * width + x) * 3 + c])
        };
        let luma = |x: usize, y: usize| (0..3).map(|c| f64::from(weight[c]) * at(x, y, c)).sum::<f64>();
        let (mut sum, mut square, mut counted) = (0f64, 0f64, 0f64);
        for y in MARGIN..height - MARGIN {
            for x in MARGIN..width - MARGIN {
                let here = luma(x, y);
                sum += here;
                square += here * here;
                counted += 1.0;
            }
        }
        (square / counted - (sum / counted).powi(2), counted)
    };
    if variance.0 <= 1e-12 {
        return None;
    }
    Some([0, 1, 2].map(|k| (after[k] - before[k]) / variance.1 / variance.0))
}

/// The photograph's own structure with every channel made equal, so the frame carries no focus
/// difference at all and the fit's correct answer is exactly zero.
///
/// **The one baseline that is known rather than assumed.** Every other arm compares a coefficient
/// against the same frame at less grain, which asks only whether the estimate is *stable* - and a
/// stable wrong answer passes that. Here the truth is zero at every noise level, so any reading is
/// error and its size is the error's size.
///
/// Built by reconstructing the frame, taking its luma, and writing that back to every photosite:
/// the edges, the textures and the radial falloff are the photograph's, and only the colour is
/// gone. A synthetic pattern cannot stand in, for the reason the second arm needs a real one.
fn greyed(
    gpu: &'static rawshim::gpu::Gpu,
    rcd: &'static rawshim::demosaic::Rcd,
    mosaic: &[f32],
    cfa: &rawshim::cfa::Cfa,
    width: usize,
    height: usize,
) -> Option<Vec<f32>> {
    let plane = reconstruct(gpu, rcd, mosaic, cfa, width, height)?;
    let weight = rawshim::image::LUMA;
    Some(
        (0..width * height)
            .map(|at| (0..3).map(|c| weight[c] * plane[at * 3 + c]).sum::<f32>().clamp(0.0, 1.0))
            .collect(),
    )
}

/// A RAW's mosaic in the unit interval RCD reads, with the CFA that indexes it.
struct Read {
    plane: Vec<f32>,
    width: usize,
    height: usize,
    cfa: rawshim::cfa::Cfa,
    /// The photograph's own noise, as the decode fits it. What says whether the sigmas this probe
    /// sweeps are anywhere near what a real frame hands the stage.
    native: Option<rawshim::galosh::NoiseFit>,
    /// The camera-to-rec2020 matrix `assemble` applies, so the noise can be measured on both sides
    /// of it. Production's own rather than a second spelling of it.
    matrix: [[f32; 3]; 3],
}

/// The middle of a mosaic, cut on even boundaries so the CFA still indexes it.
fn centre(read: Read, want: usize) -> Read {
    let (width, height) =
        (want.min(read.width) & !1, (want.saturating_mul(3) / 4).min(read.height) & !1);
    let (left, top) = (((read.width - width) / 2) & !1, ((read.height - height) / 2) & !1);
    let plane = (0..height)
        .flat_map(|r| {
            let row = (top + r) * read.width + left;
            read.plane[row..row + width].iter().copied()
        })
        .collect();
    Read { plane, width, height, cfa: read.cfa, matrix: read.matrix, native: read.native }
}

fn read_mosaic(path: &str) -> Option<Read> {
    let source = rawler::rawsource::RawSource::new(std::path::Path::new(path)).ok()?;
    let decoder = rawler::get_decoder(&source).ok()?;
    let params = rawler::decoders::RawDecodeParams::default();
    let image = decoder.raw_image(&source, &params, false).ok()?;
    let rawler::rawimage::RawImageData::Integer(values) = &image.data else {
        return None;
    };
    let white = image.whitelevel.0.first().copied().unwrap_or(u32::from(u16::MAX)) as f32;
    let black =
        image.blacklevel.levels.first().map_or(0.0, |level| level.n as f32 / level.d as f32);
    let range = (white - black).max(1.0);
    let cfa = rawshim::cfa::Cfa::from_rawler(&image.camera.cfa)?;
    Some(Read {
        plane: values.iter().map(|&v| ((f32::from(v) - black) / range).clamp(0.0, 1.0)).collect(),
        width: image.width,
        height: image.height,
        cfa,
        matrix: rawshim::decode_rawler::camera_to_rec2020(&image)?,
        native: std::fs::read(path).ok().and_then(|bytes| {
            rawshim::decode_frame_bytes(&bytes, 0, rawshim::galosh::Fit::Only)
                .and_then(|frame| frame.noise)
        }),
    })
}

fn reconstruct(
    gpu: &'static rawshim::gpu::Gpu,
    rcd: &'static rawshim::demosaic::Rcd,
    mosaic: &[f32],
    cfa: &rawshim::cfa::Cfa,
    width: usize,
    height: usize,
) -> Option<Vec<f32>> {
    let uploaded = rawshim::condition::Mosaic::upload(gpu, mosaic, width, height);
    pollster::block_on(rawshim::demosaic::demosaic_plane(gpu, rcd, &uploaded, cfa, |bytes| {
        bytes
            .chunks_exact(4)
            .map(|word| f32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
            .collect::<Vec<f32>>()
    }))
}

/// The same reconstruction with the camera matrix on it: the frame the defringe is handed.
///
/// `demosaic_plane` stops one stage short of `assemble` on purpose, so everything measured through
/// it is the noise RCD produced rather than the noise the estimate sees. The matrix is a linear map
/// applied per pixel, so it both rescales each channel's variance and remixes the pairs.
fn reconstruct_coded(
    gpu: &'static rawshim::gpu::Gpu,
    rcd: &'static rawshim::demosaic::Rcd,
    mosaic: &[f32],
    cfa: &rawshim::cfa::Cfa,
    width: usize,
    height: usize,
    matrix: [[f32; 3]; 3],
) -> Option<Vec<f32>> {
    let uploaded = rawshim::condition::Mosaic::upload(gpu, mosaic, width, height);
    let at = rawshim::demosaic::Placement {
        stride: rawshim::px::Span::exact(width),
        crop: rawshim::px::Rect::exact(0, 0, width, height),
        dest: rawshim::px::At::ORIGIN,
        frame: rawshim::px::Size::exact(width, height),
        orientation: 0,
        reduce: 1,
    };
    let into = rawshim::demosaic::frame_buffer(gpu, width * height);
    let (_held, shape) = rawshim::demosaic::shape_group(gpu, rcd, cfa, &uploaded, 0);
    pollster::block_on(rawshim::demosaic::demosaic_into(
        gpu,
        rcd,
        &uploaded,
        cfa,
        &at,
        rawshim::demosaic::Colour { matrix, ceiling: [1.0; 3] },
        &into,
        &shape,
    ))?;
    let samples = pollster::block_on(rawshim::demosaic::read_frame(gpu, &into, width * height))?;
    Some(samples.iter().map(|&v| f32::from(v) / 65535.0).collect())
}

fn show(fitted: Option<(f32, f32)>) -> String {
    match fitted {
        None => "declined".to_string(),
        Some((red, blue)) => format!("{red:+.4} {blue:+.4}"),
    }
}

/// What the frame carries once this arm's grain is on it, in the shape `galosh` fits.
///
/// **The photograph's own noise counts too.** Two independent grains add in quadrature, so a
/// fixture that reports only what the probe drew hands the estimate a sigma smaller than the frame
/// measurably has - and the bound derived from it is then too tight by exactly the amount the
/// sensor contributed. `alpha = 0` because the drawn part is fixed at every level; the native part
/// is folded in at its own fitted RMS.
fn as_fitted(
    drawn: f32,
    native: Option<rawshim::galosh::NoiseFit>,
) -> Option<rawshim::galosh::NoiseFit> {
    // The frame's own sigma comes off `alpha.s + sigma_sq` at full scale rather than off
    // `unified_sigma`, which is a GAT-domain figure and reads near one however dark the frame is.
    let carried = native.map_or(0.0, |fit| fit.model().at_white());
    let combined = (drawn * drawn + carried * carried).sqrt();
    (combined > 0.0).then_some(rawshim::galosh::NoiseFit {
        alpha: 0.0,
        sigma_sq: combined * combined,
        unified_sigma: combined,
        dark_ref: [0.0; 4],
    })
}

fn fit(
    gpu: &'static rawshim::gpu::Gpu,
    base: &'static rawshim::base::Base,
    plane: &[f32],
    width: usize,
    height: usize,
    noise: Option<rawshim::galosh::NoiseFit>,
    matrix: [[f32; 3]; 3],
) -> Option<(f32, f32)> {
    let samples: Vec<u16> =
        plane.iter().map(|&v| (v.clamp(0.0, 1.0) * 65535.0).round() as u16).collect();
    pollster::block_on(rawshim::base::measure_defocus(
        gpu,
        base,
        &samples,
        width,
        height,
        noise,
        Some(matrix),
    ))
}

/// How far the reconstruction's grain tracks itself between channels.
///
/// All three pairs, because what reads them propagates the lot through the camera matrix and
/// `M.sigma.M'` mixes every one: a red-against-blue term thrown away here comes back into red's own
/// variance as soon as the matrix is applied.
struct Stats {
    /// Pearson: red against green, blue against green, red against blue.
    correlation: [f32; 3],
}

impl Stats {
    fn of(plane: &[f32], width: usize, height: usize) -> Stats {
        // Past RCD's margin, where the reconstruction is the algorithm rather than the seed.
        const MARGIN: usize = 12;
        const PAIRS: [(usize, usize); 3] = [(0, 1), (2, 1), (0, 2)];
        let mut sum = [0f64; 3];
        let mut square = [0f64; 3];
        let mut cross = [0f64; 3];
        let mut counted = 0f64;
        for y in MARGIN..height.saturating_sub(MARGIN) {
            for x in MARGIN..width.saturating_sub(MARGIN) {
                let at = |c: usize| f64::from(plane[(y * width + x) * 3 + c]);
                let channel = [at(0), at(1), at(2)];
                for (slot, value) in channel.iter().enumerate() {
                    sum[slot] += value;
                    square[slot] += value * value;
                }
                for (slot, (a, b)) in PAIRS.iter().enumerate() {
                    cross[slot] += channel[*a] * channel[*b];
                }
                counted += 1.0;
            }
        }
        if counted == 0.0 {
            return Stats { correlation: [0.0; 3] };
        }
        let mean = sum.map(|total| total / counted);
        let variance: Vec<f64> =
            (0..3).map(|c| (square[c] / counted - mean[c] * mean[c]).max(0.0)).collect();
        let pearson = |slot: usize| {
            let (a, b) = PAIRS[slot];
            let spread = (variance[a] * variance[b]).sqrt();
            match spread > 0.0 {
                true => (cross[slot] / counted - mean[a] * mean[b]) / spread,
                false => 0.0,
            }
        };
        Stats { correlation: [pearson(0) as f32, pearson(1) as f32, pearson(2) as f32] }
    }
}

struct Lcg {
    state: u64,
    spare: Option<f32>,
}

impl Lcg {
    fn new(seed: u64) -> Lcg {
        Lcg { state: seed | 1, spare: None }
    }

    fn uniform(&mut self) -> f32 {
        self.state = self.state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        // The top bits, which are the ones an LCG mixes; the low bits of one cycle with a
        // period as short as two.
        ((self.state >> 40) as f32 + 0.5) / (1u32 << 24) as f32
    }

    fn normal(&mut self) -> f32 {
        if let Some(spare) = self.spare.take() {
            return spare;
        }
        let (u, v) = (self.uniform(), self.uniform());
        let radius = (-2.0 * u.ln()).sqrt();
        let angle = std::f32::consts::TAU * v;
        self.spare = Some(radius * angle.sin());
        radius * angle.cos()
    }
}
