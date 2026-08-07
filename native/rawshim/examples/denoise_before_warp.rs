//! Does denoising before the geometric warp leave noise more uniform than after it?
//!
//! The argument: noise is generated at the sensor, so it is spatially uniform in sensor space.
//! The lens warp resamples non-uniformly by radius - magnifying some regions and compressing
//! others - so a frame warped first has noise whose amplitude varies across it. `image::finish`
//! then measures **one global median** (`measure_noise`, DESIGN §10.9 "the noise is measured,
//! not predicted") and applies one sigma everywhere, which is the estimator for a uniform field.
//! Denoise after the warp and that assumption is broken by construction.
//!
//! Both current paths denoise after the warp: the job fuses the warp into `grade_owned` and runs
//! `finish` after `encode_pq`, and the editor materialises the warp in `edit::prepare` and then
//! runs `filter_once`.
//!
//! Three variants. A and B differ *only* in warp order - the denoise runs in the same normalised
//! PQ in both - so the comparison isolates the one variable. C is what ships, for reference.
//!
//!   A  warp then denoise   (the editor's order, and morally the job's)
//!   B  denoise then warp   (the proposal)
//!   C  shipped HDR         (warp fused into the grade, denoise after encode_pq)
//!
//! Reported as residual noise per radial band. Distortion is a function of radius, so if the
//! warp is what breaks uniformity it shows as a centre-to-corner spread that B does not have.
//!
//! Run:
//!   cargo run --release --example denoise_before_warp --features renditions -- [raw] [edge]

use rawshim::{fit, hdr, hdr_fit, image, tone};

const QUANTILE: f64 = 0.90;
const BANDS: usize = 3;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().unwrap_or_else(|| {
        format!("{}/../../test/fixtures/DSC02981.ARW", env!("CARGO_MANIFEST_DIR"))
    });
    let long_edge: u32 = args.next().and_then(|a| a.parse().ok()).unwrap_or(1600);

    // Denoise only. The sharpen is a deconvolution of the resample's blur and so has its own
    // reason to sit after the warp; mixing it in would confound the thing being measured.
    let strengths = image::Strengths { luma: 1.0, chroma: 1.0, sharpen: 0.0, defringe: 0.0 };
    let grade = hdr::Grade { peak_nits: 1000.0, reference_white_nits: 203.0, white_quantile: QUANTILE };

    let frame = rawshim::decode_frame(&path, 16, true, long_edge)
        .unwrap_or_else(|| panic!("could not decode {path}"));
    let samples = frame.samples16().expect("16-bit decode");
    let source = hdr::Source { samples, width: frame.width, height: frame.height };

    // `Unstated` makes the fit derive the geometry itself rather than declining it, which is
    // what gives this test a real warp to argue about.
    let matched = hdr::fit_all(&path, &source, QUANTILE, fit::Geometry::Unstated, strengths);
    let Some((_, m)) = matched.as_ref() else {
        println!("no camera match on {path}; nothing to warp");
        return;
    };
    let prepared = hdr::prepare(&source, None, &grade);
    let (w, h) = (prepared.width, prepared.height);
    let warp = image::PlanarWarp::for_lens(w, h, w, h, &m.lens, image::Sampling::Bicubic);
    println!(
        "{}  {w}x{h}  warp={}",
        path.rsplit('/').next().unwrap_or(&path),
        if warp.is_some() { "real" } else { "IDENTITY - this test says nothing" },
    );

    // The decisive version. On a real frame the radial profile is mostly *scene* - a subject in
    // the middle reads as "noise" to any high-pass - so it can neither confirm nor refute the
    // hypothesis. A flat field carrying known uniform noise has no content to confound it, so
    // any radial structure left in the residual is the warp's doing and nothing else.
    {
        let flat = flat_field_with_noise(w, h, prepared.levels.white);
        let synthetic = hdr::Prepared {
            samples: flat,
            width: w,
            height: h,
            levels: prepared.levels,
        };
        let before = radial_noise(&synthetic.samples, w, h);
        println!(
            "\n  synthetic flat field, uniform noise in, before any warp or filter"
        );
        println!("    {:<26} {:>8.1} {:>8.1} {:>8.1}   {:>9.2}x", "input", before[0], before[1], before[2],
            before[BANDS - 1] / before[0].max(1e-9));

        let warped_only = {
            let mut f = synthetic.samples.clone();
            if let Some(w2) = hdr_fit::apply_lens(&f, w, h, m) { f = w2; }
            f
        };
        let wo = radial_noise(&warped_only, w, h);
        println!("    {:<26} {:>8.1} {:>8.1} {:>8.1}   {:>9.2}x", "after the warp alone", wo[0], wo[1], wo[2],
            wo[BANDS - 1] / wo[0].max(1e-9));

        for (name, out) in [
            ("A  warp then denoise", warp_then_denoise(&synthetic, &grade, m, strengths)),
            ("B  denoise then warp", denoise_then_warp(&synthetic, &grade, m, strengths)),
        ] {
            let bands = radial_noise(&out, w, h);
            println!("    {name:<26} {:>8.1} {:>8.1} {:>8.1}   {:>9.2}x", bands[0], bands[1], bands[2],
                bands[BANDS - 1] / bands[0].max(1e-9));
        }
    }

    let a = warp_then_denoise(&prepared, &grade, m, strengths);
    let b = denoise_then_warp(&prepared, &grade, m, strengths);
    let c = shipped(&prepared, &grade, m, strengths);

    println!("\n  residual noise by radial band (median |high-pass| on luma, PQ counts)");
    println!("    {:<26} {:>8} {:>8} {:>8}   {:>10}", "", "centre", "mid", "corner", "spread");
    for (name, frame) in [
        ("A  warp then denoise", &a),
        ("B  denoise then warp", &b),
        ("C  shipped HDR", &c),
    ] {
        let bands = radial_noise(frame, w, h);
        let spread = bands[BANDS - 1] / bands[0].max(1e-9);
        println!(
            "    {name:<26} {:>8.1} {:>8.1} {:>8.1}   {:>9.2}x",
            bands[0], bands[1], bands[2], spread
        );
    }

    println!("\n  ΔE ITP, A against B (how much the order moves the picture at all)");
    let mut deltas: Vec<f64> = (0..w * h)
        .map(|p| delta_itp(ictcp(&a, p * 3), ictcp(&b, p * 3)))
        .collect();
    deltas.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let at = |q: f64| deltas[((deltas.len() - 1) as f64 * q) as usize];
    println!(
        "    mean {:.3}   p50 {:.3}   p95 {:.3}   p99 {:.3}   max {:.3}",
        deltas.iter().sum::<f64>() / deltas.len() as f64,
        at(0.50), at(0.95), at(0.99), deltas[deltas.len() - 1],
    );
}

/// Denoise in exposure-normalised PQ, in place, leaving the frame scene-linear again.
fn denoise(frame: &mut [u16], w: usize, h: usize, grade: &hdr::Grade, white: f64, s: image::Strengths) {
    let scale = grade.reference_white_nits / white.max(1.0);
    let mut perceptual: Vec<f32> = frame.iter().map(|v| tone::pq(f64::from(*v) * scale) as f32).collect();
    let (sigma, defocus) = image::measurements(&perceptual, w, h, s);
    image::finish_with(&mut perceptual, w, h, s, sigma, defocus);
    for (sample, filtered) in frame.iter_mut().zip(perceptual.iter()) {
        *sample = (tone::pq_inv(f64::from(*filtered)) / scale).clamp(0.0, 65535.0).round() as u16;
    }
}

fn warp_then_denoise(
    p: &hdr::Prepared, grade: &hdr::Grade, m: &hdr_fit::HdrMatch, s: image::Strengths,
) -> Vec<u16> {
    let mut f = p.samples.clone();
    if let Some(warped) = hdr_fit::apply_lens(&f, p.width, p.height, m) {
        f = warped;
    }
    denoise(&mut f, p.width, p.height, grade, p.levels.white, s);
    hdr::grade_prepared(&mut f, grade, Some(&m.colour), p.levels, 1.0);
    tone::encode_pq(&mut f, grade.peak_nits);
    f
}

fn denoise_then_warp(
    p: &hdr::Prepared, grade: &hdr::Grade, m: &hdr_fit::HdrMatch, s: image::Strengths,
) -> Vec<u16> {
    let mut f = p.samples.clone();
    denoise(&mut f, p.width, p.height, grade, p.levels.white, s);
    if let Some(warped) = hdr_fit::apply_lens(&f, p.width, p.height, m) {
        f = warped;
    }
    hdr::grade_prepared(&mut f, grade, Some(&m.colour), p.levels, 1.0);
    tone::encode_pq(&mut f, grade.peak_nits);
    f
}

/// `hdr::encode_still`: warp fused into the grade, filter after the transfer.
fn shipped(
    p: &hdr::Prepared, grade: &hdr::Grade, m: &hdr_fit::HdrMatch, s: image::Strengths,
) -> Vec<u16> {
    let mut f = p.samples.clone();
    let lens = image::PlanarWarp::for_lens(p.width, p.height, p.width, p.height, &m.lens, image::Sampling::Bicubic);
    hdr::grade_prepared_owned(&mut f, grade, Some(&m.colour), lens.as_ref(), p.levels, 1.0);
    tone::encode_pq(&mut f, grade.peak_nits);
    image::finish(&mut f, p.width, p.height, s);
    f
}

/// A featureless frame at diffuse white carrying spatially uniform noise.
///
/// Deterministic, so two runs compare. The amplitude is a few percent of the level, which is
/// the order real sensor noise sits at once the frame has been demosaiced and resampled - what
/// matters here is that it is the *same* everywhere, since uniformity is the thing under test.
fn flat_field_with_noise(w: usize, h: usize, white: f64) -> Vec<u16> {
    let level = white.clamp(1.0, 60000.0);
    let amplitude = level * 0.03;
    let mut state = 0x2545_F491_4F6C_DD1Du64;
    let mut out = vec![0u16; w * h * 3];
    for sample in out.iter_mut() {
        // xorshift64*, so this needs no dependency and repeats identically.
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let unit = (state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64;
        *sample = (level + (unit - 0.5) * 2.0 * amplitude).clamp(0.0, 65535.0) as u16;
    }
    out
}

/// Median absolute high-pass residual on luma, per radial band.
///
/// The median rather than a mean for the reason `image::noise_level` uses one: edges are a
/// minority of pixels and arbitrarily large, so a mean follows the composition instead of the
/// grain. Bands are equal steps of normalised radius, which is the axis distortion varies on.
fn radial_noise(frame: &[u16], w: usize, h: usize) -> [f64; BANDS] {
    let luma = |i: usize| {
        0.2627 * f64::from(frame[i]) + 0.6780 * f64::from(frame[i + 1]) + 0.0593 * f64::from(frame[i + 2])
    };
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
    let longest = cx.hypot(cy);
    let mut bands: [Vec<f64>; BANDS] = Default::default();

    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let mut mean = 0.0;
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let ny = (y as i64 + dy) as usize;
                    let nx = (x as i64 + dx) as usize;
                    mean += luma((ny * w + nx) * 3);
                }
            }
            let residual = (luma((y * w + x) * 3) - mean / 9.0).abs();
            let r = (x as f64 - cx).hypot(y as f64 - cy) / longest;
            let band = ((r * BANDS as f64) as usize).min(BANDS - 1);
            bands[band].push(residual);
        }
    }

    let mut out = [0.0; BANDS];
    for (i, band) in bands.iter_mut().enumerate() {
        band.sort_by(|a, b| a.partial_cmp(b).unwrap());
        out[i] = band.get(band.len() / 2).copied().unwrap_or(0.0);
    }
    out
}

fn ictcp(frame: &[u16], i: usize) -> [f64; 3] {
    let nits = |v: u16| tone::pq_inv(f64::from(v) / 65535.0);
    let (r, g, b) = (nits(frame[i]), nits(frame[i + 1]), nits(frame[i + 2]));
    let l = (1688.0 * r + 2146.0 * g + 262.0 * b) / 4096.0;
    let m = (683.0 * r + 2951.0 * g + 462.0 * b) / 4096.0;
    let s = (99.0 * r + 309.0 * g + 3688.0 * b) / 4096.0;
    let (lp, mp, sp) = (tone::pq(l), tone::pq(m), tone::pq(s));
    [
        0.5 * lp + 0.5 * mp,
        (6610.0 * lp - 13613.0 * mp + 7003.0 * sp) / 4096.0,
        (17933.0 * lp - 17390.0 * mp - 543.0 * sp) / 4096.0,
    ]
}

fn delta_itp(a: [f64; 3], b: [f64; 3]) -> f64 {
    let (di, dt, dp) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    720.0 * (di * di + 0.25 * dt * dt + dp * dp).sqrt()
}
