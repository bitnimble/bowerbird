//! A denoise scored against the picture it should have recovered.
//!
//! ```text
//! denoise_truth <clean raw> <noisy raw> <x,y,side> <out-dir> [denoiser...]
//! ```
//!
//! A window of a clean frame is darkened to the noisy frame's median level and given the noise
//! the noisy frame's own fit describes, scaled on each colour by the clean frame's conditioning
//! gain over green's, so the truth behind the noise is known. Each denoiser (`galosh`, or `noisy`
//! for none) then filters it at the amounts the fit suggests, and the error against the truth is
//! reported in units of the noise's own deviation there: 1 is the noise untouched, 0 the truth.
//!
//! Split by how much detail the truth has around each site, because one number cannot tell noise
//! left behind from detail taken away: on flat ground every bit of error is noise, on texture it is
//! mostly blur. The flat ground's error correlation at a few site lags says whether what is left is
//! grain or strokes, and its mean per colour whether a colour's level moved. Each result is also
//! written demosaiced as `<denoiser>.png`, beside `truth.png`.

use rawshim::galosh::{Amounts, Detail};

/// Site detail, in deviations of the noise, under which ground counts as flat and over which it
/// counts as textured.
const FLAT: f64 = 0.25;
const TEXTURED: f64 = 1.5;

/// The class of a site too near the window's edge to classify, which no column reports alone.
const BORDER: u8 = 3;

fn main() {
    let mut args = std::env::args().skip(1);
    let clean_path = args.next().expect("a clean raw");
    let noisy_path = args.next().expect("a noisy raw");
    let place: Vec<usize> = args
        .next()
        .expect("x,y,side")
        .split(',')
        .map(|v| v.parse().expect("a number"))
        .collect();
    assert_eq!(place.len(), 3, "the window is x,y,side");
    let (x0, y0, side) = (place[0] & !1, place[1] & !1, place[2] & !1);
    let out = args.next().expect("an output directory");
    let denoisers: Vec<String> = args.collect();
    std::fs::create_dir_all(&out).expect("the output directory");

    let gpu = gpu::device().expect("an adapter");
    let kernels = rawshim::galosh::device(gpu).expect("the kernels built");
    let held = |path: &str| {
        let bytes = std::fs::read(path).expect("read the raw");
        pollster::block_on(rawshim::decode_rawler::hold_bytes(&bytes)).expect("held")
    };

    let clean = held(&clean_path);
    let cfa = clean.cfa();
    let gains = clean.ceilings();
    let whole = pollster::block_on(clean.device_mosaic().read(gpu)).expect("reads back");
    let stride = clean.device_mosaic().width;
    assert!(
        x0 + side <= stride && y0 + side <= clean.device_mosaic().height,
        "the window lies outside the clean frame"
    );
    let mut truth = Vec::with_capacity(side * side);
    for row in 0..side {
        let at = (y0 + row) * stride + x0;
        truth.extend_from_slice(&whole[at..at + side]);
    }

    let noisy_frame = held(&noisy_path);
    let night = pollster::block_on(rawshim::galosh::fit(
        gpu,
        kernels,
        noisy_frame.device_mosaic(),
        &noisy_frame.cfa(),
        noisy_frame.ceilings(),
    ))
    .model();
    let night_samples =
        pollster::block_on(noisy_frame.device_mosaic().read(gpu)).expect("reads back");
    let dim = median(&night_samples) / median(&truth);
    for value in &mut truth {
        *value *= dim;
    }
    // The fit states green's noise; a colour conditioned at more gain carries that much more.
    let over_green = |at: usize| {
        let colour = usize::from(cfa.colour_at(at / side, at % side)).min(2);
        gains[colour] / gains[1]
    };
    let deviation = |at: usize, level: f32| {
        let gain = over_green(at);
        gain * (night.alpha * (level / gain).max(0.0) + night.sigma_sq).sqrt()
    };
    let mut state = 0x2545_f491_4f6c_dd1du64;
    let noisy: Vec<f32> = truth
        .iter()
        .enumerate()
        .map(|(at, &level)| level + deviation(at, level) * gaussian(&mut state) as f32)
        .collect();
    eprintln!(
        "night alpha {:.3e} sigma_sq {:.3e}; truth dimmed {dim:.4}x to median {:.4}",
        night.alpha,
        night.sigma_sq,
        median(&truth)
    );

    let green_deviation = |level: f32| (night.alpha * level.max(0.0) + night.sigma_sq).sqrt();
    let classes = classify(&truth, side, &green_deviation);
    let counts = [0, 1, 2].map(|class| classes.iter().filter(|&&c| c == class).count());
    eprintln!(
        "sites: {} flat, {} between, {} textured",
        counts[0], counts[1], counts[2]
    );

    let window = rawshim::condition::Mosaic::upload(gpu, &noisy, side, side);
    let fit = pollster::block_on(rawshim::galosh::fit(gpu, kernels, &window, &cfa, gains));
    assert!(
        fit.usable(),
        "the window is too small or too flat to fit: {fit:?}"
    );
    let lift = 0.18 / median(&truth);
    write_png(gpu, &cfa, &truth, side, lift, &format!("{out}/truth.png"));

    println!(
        "{:>9}  {:>7} {:>7} {:>7} {:>7}   {:>6} {:>6}   {:>6} {:>6}   {:>6} {:>6} {:>6}   flat-error correlation at site lags 1 2 4 8",
        "denoiser",
        "all",
        "flat",
        "between",
        "texture",
        "fine",
        "coarse",
        "c fine",
        "c crse",
        "bias r",
        "g",
        "b"
    );
    for name in &denoisers {
        let filtered = match name.as_str() {
            "noisy" => noisy.clone(),
            other => {
                assert_eq!(other, "galosh", "{other} is not a denoiser");
                let amounts: Amounts = Detail::AUTO.amounts(Some(fit));
                let mosaic = rawshim::condition::Mosaic::upload(gpu, &noisy, side, side);
                pollster::block_on(rawshim::galosh::denoise_with(
                    gpu, kernels, &mosaic, &cfa, gains, amounts, fit,
                ));
                pollster::block_on(mosaic.read(gpu)).expect("reads back")
            }
        };
        let error: Vec<f64> = filtered
            .iter()
            .zip(&truth)
            .enumerate()
            .map(|(at, (&got, &want))| f64::from(got - want) / f64::from(deviation(at, want)))
            .collect();
        let mut bias = [(0f64, 0usize); 3];
        for (at, e) in error.iter().enumerate() {
            let (x, y) = (at % side, at / side);
            if classes[(y / 2) * (side / 2) + x / 2] == 0 {
                let colour = usize::from(cfa.colour_at(y, x)).min(2);
                bias[colour].0 += e;
                bias[colour].1 += 1;
            }
        }
        let bias = bias.map(|(sum, n)| sum / n.max(1) as f64);
        let rms = |class: Option<u8>| {
            let (mut sum, mut n) = (0f64, 0usize);
            for (at, e) in error.iter().enumerate() {
                let (x, y) = (at % side, at / side);
                let site = (y / 2) * (side / 2) + x / 2;
                if class.is_none_or(|c| classes[site] == c) {
                    sum += e * e;
                    n += 1;
                }
            }
            (sum / n.max(1) as f64).sqrt()
        };
        let lags = [1usize, 2, 4, 8].map(|lag| flat_correlation(&error, &classes, side, lag));
        let (fine, coarse) = flat_bands(&error, &classes, side, &|four| {
            0.5 * four.iter().sum::<f64>()
        });
        let (colour_fine, colour_coarse) = [
            [1.0, -1.0, 1.0, -1.0],
            [1.0, 1.0, -1.0, -1.0],
            [1.0, -1.0, -1.0, 1.0],
        ]
        .iter()
        .map(|signs| {
            flat_bands(&error, &classes, side, &|four| {
                0.5 * four.iter().zip(signs).map(|(e, s)| e * s).sum::<f64>()
            })
        })
        .fold((0.0, 0.0), |(f, c), (df, dc)| {
            (f + df * df / 3.0, c + dc * dc / 3.0)
        });
        println!(
            "{name:>9}  {:>7.3} {:>7.3} {:>7.3} {:>7.3}   {fine:>6.3} {coarse:>6.3}   {:>6.3} {:>6.3}   {:>+6.3} {:>+6.3} {:>+6.3}   {:+.3} {:+.3} {:+.3} {:+.3}",
            rms(None),
            rms(Some(0)),
            rms(Some(1)),
            rms(Some(2)),
            colour_fine.sqrt(),
            colour_coarse.sqrt(),
            bias[0],
            bias[1],
            bias[2],
            lags[0],
            lags[1],
            lags[2],
            lags[3],
        );
        write_png(
            gpu,
            &cfa,
            &filtered,
            side,
            lift,
            &format!("{out}/{name}.png"),
        );
    }
}

/// Each 2x2 site's class: 0 flat, 1 between, 2 textured, by the truth's site-sum deviation over
/// the 5x5 sites around it, in units of the noise that sum carries. `BORDER` for the two rings
/// that have no 5x5 around them.
fn classify(truth: &[f32], side: usize, deviation: &dyn Fn(f32) -> f32) -> Vec<u8> {
    let sites = side / 2;
    let sum = |sx: usize, sy: usize| {
        let at = |dx: usize, dy: usize| f64::from(truth[(sy * 2 + dy) * side + sx * 2 + dx]);
        at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)
    };
    let mut out = vec![BORDER; sites * sites];
    for sy in 2..sites - 2 {
        for sx in 2..sites - 2 {
            let mut values = [0f64; 25];
            for (k, value) in values.iter_mut().enumerate() {
                *value = sum(sx + k % 5 - 2, sy + k / 5 - 2);
            }
            let mean = values.iter().sum::<f64>() / 25.0;
            let spread = (values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / 25.0).sqrt();
            let noise = 2.0 * f64::from(deviation((mean / 4.0) as f32));
            let detail = spread / noise;
            out[sy * sites + sx] = match detail {
                d if d < FLAT => 0,
                d if d > TEXTURED => 2,
                _ => 1,
            };
        }
    }
    out
}

/// The normalised correlation of the site-summed error over flat sites `lag` sites apart, both
/// axes pooled.
fn flat_correlation(error: &[f64], classes: &[u8], side: usize, lag: usize) -> f64 {
    let sites = side / 2;
    let site = |sx: usize, sy: usize| {
        let at = |dx: usize, dy: usize| error[(sy * 2 + dy) * side + sx * 2 + dx];
        at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)
    };
    let flat = |sx: usize, sy: usize| classes[sy * sites + sx] == 0;
    let (mut product, mut power, mut n, mut counted) = (0f64, 0f64, 0usize, 0usize);
    for sy in 0..sites - lag {
        for sx in 0..sites - lag {
            if !flat(sx, sy) {
                continue;
            }
            let here = site(sx, sy);
            power += here * here;
            counted += 1;
            for (ox, oy) in [(lag, 0), (0, lag)] {
                if flat(sx + ox, sy + oy) {
                    product += here * site(sx + ox, sy + oy);
                    n += 1;
                }
            }
        }
    }
    match power > 0.0 && n > 0 {
        true => (product / n as f64) / (power / counted as f64),
        false => 0.0,
    }
}

/// The flat sites' error split at the 5x5-site scale: what varies from site to site, which is where
/// a stroke or a grain lives, and the local mean it varies about, which is where a blotch does.
/// `term` takes a site's four photosite errors to one term of its Walsh-Hadamard transform, half a
/// signed sum, so white noise reads one in total.
fn flat_bands(
    error: &[f64],
    classes: &[u8],
    side: usize,
    term: &dyn Fn([f64; 4]) -> f64,
) -> (f64, f64) {
    let sites = side / 2;
    let site = |sx: usize, sy: usize| {
        let at = |dx: usize, dy: usize| error[(sy * 2 + dy) * side + sx * 2 + dx];
        term([at(0, 0), at(1, 0), at(0, 1), at(1, 1)])
    };
    let (mut fine, mut coarse, mut n) = (0f64, 0f64, 0usize);
    for sy in 2..sites - 2 {
        for sx in 2..sites - 2 {
            if classes[sy * sites + sx] != 0 {
                continue;
            }
            let mut mean = 0f64;
            for k in 0..25 {
                mean += site(sx + k % 5 - 2, sy + k / 5 - 2);
            }
            mean /= 25.0;
            fine += (site(sx, sy) - mean).powi(2);
            coarse += mean * mean;
            n += 1;
        }
    }
    let n = n.max(1) as f64;
    ((fine / n).sqrt(), (coarse / n).sqrt())
}

fn median(values: &[f32]) -> f32 {
    let mut sorted: Vec<f32> = values.iter().copied().filter(|v| v.is_finite()).collect();
    sorted.sort_unstable_by(f32::total_cmp);
    sorted[sorted.len() / 2]
}

fn write_png(
    gpu: &'static gpu::Gpu,
    cfa: &rawshim::cfa::Cfa,
    samples: &[f32],
    side: usize,
    lift: f32,
    to: &str,
) {
    let rcd = rawshim::demosaic::device(gpu).expect("the demosaic built");
    let uploaded = rawshim::condition::Mosaic::upload(gpu, samples, side, side);
    let rgb = pollster::block_on(rawshim::demosaic::demosaic_plane(
        gpu,
        rcd,
        &uploaded,
        cfa,
        |bytes| {
            bytes
                .chunks_exact(4)
                .map(|word| f32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
                .collect::<Vec<f32>>()
        },
    ))
    .expect("demosaics");
    let rgb8: Vec<u8> = rgb
        .iter()
        .map(|channel| ((channel * lift).clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0).round() as u8)
        .collect();
    let png = rawshim::png_write::encode_sdr(&rgb8, side, side, None).expect("a png");
    std::fs::write(to, png).expect("wrote");
}

/// One standard normal, from a fixed-seed generator so a run is the same run every time.
fn gaussian(state: &mut u64) -> f64 {
    let mut next = || {
        *state ^= *state << 13;
        *state ^= *state >> 7;
        *state ^= *state << 17;
        (*state >> 11) as f64 / (1u64 << 53) as f64
    };
    let (first, second) = (next().max(f64::MIN_POSITIVE), next());
    (-2.0 * first.ln()).sqrt() * (2.0 * std::f64::consts::PI * second).cos()
}
