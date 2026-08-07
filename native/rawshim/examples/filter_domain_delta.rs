//! Which domain should `image::finish` run in, and is the difference recoverable?
//!
//! Phase 0 of the photo-edits spec has to put the denoise and the sharpen in one place for
//! both hosts. There are three candidate domains and the tree currently uses two of them:
//!
//!   L  linear      - where the resample's blur physically happened (`hdr::prepare`'s
//!                    `box_resize_u16` runs before the grade), and so where a Richardson-Lucy
//!                    deconvolution of that blur has a physical argument to be.
//!   N  normalised  - `pq(sample * reference_white / levels.white)`: a plain exposure
//!      PQ            normalisation into PQ with no grade in it. What `edit::filter_once`
//!                    uses, so what the editor shows.
//!   G  graded PQ   - the full grade then `tone::encode_pq`, filtered after. What
//!                    `hdr::encode_still` does, so what every HDR rendition contains.
//!
//! DESIGN §10.9 argues for a display-referred domain on the merits: every stage reads a
//! difference against a blur, and in linear light a fixed difference means something
//! different at a highlight than at a shadow. It also concedes (§10.9, "Two caveats") that
//! the constants were tuned on an sRGB rendition and that two of them are absolute fractions
//! of full scale, which sRGB and PQ do not share.
//!
//! So this measures rather than argues. All three variants share one decode, one match and
//! one geometry - the lens warp is left out entirely, so the only thing that differs is the
//! domain `finish` ran in.
//!
//! The second question is whether a difference is *recoverable*. Reported as: how much of the
//! ΔE survives after subtracting the best per-level correction. Two strengths of correction,
//! because they cost very different things to build:
//!
//!   * a 1D curve in I alone - the cheap fix, one LUT applied after
//!   * per-level offsets in I, Ct and Cp - the expensive fix, and the ceiling for anything
//!     that only looks at level
//!
//! If the luma-only residual is small, a curve recovers it. If it is not, the constants have
//! to be retuned for whichever domain wins instead.
//!
//! Run:
//!   cargo run --release --example filter_domain_delta --features renditions -- [raw] [edge]

use rawshim::{fit, hdr, hdr_fit, image, tone};

const QUANTILE: f64 = 0.90;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().unwrap_or_else(|| {
        format!(
            "{}/../../test/fixtures/DSC02981.ARW",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    let long_edge: u32 = args
        .next()
        .and_then(|a| a.parse().ok())
        .unwrap_or(1600);

    let strengths = image::Strengths {
        luma: 1.0,
        chroma: 1.0,
        sharpen: 1.0,
        defringe: 1.0,
    };
    let grade = hdr::Grade {
        peak_nits: 1000.0,
        reference_white_nits: 203.0,
        white_quantile: QUANTILE,
    };

    let frame = rawshim::decode_frame(&path, 16, true, long_edge)
        .unwrap_or_else(|| panic!("could not decode {path}"));
    let samples = frame.samples16().expect("the decode was not 16-bit");
    let source = hdr::Source {
        samples,
        width: frame.width,
        height: frame.height,
    };

    // The colour half of the match only. Geometry is deliberately `Uncorrected` and the lens
    // is never applied: a warp would move every pixel in all three variants identically and
    // add nothing but noise to the comparison.
    let matched = hdr::fit_all(
        &path,
        &source,
        QUANTILE,
        fit::Geometry::Uncorrected,
        strengths,
    );
    let colour = matched.as_ref().map(|(_, m)| &m.colour);
    let prepared = hdr::prepare(&source, None, &grade);
    let (w, h) = (prepared.width, prepared.height);
    println!(
        "{}  {w}x{h}  matched={}  white={:.1} peak={:.1}",
        path.rsplit('/').next().unwrap_or(&path),
        colour.is_some(),
        prepared.levels.white,
        prepared.levels.peak,
    );

    let linear = finish_in_linear(&prepared, &grade, colour, strengths);
    let normalised = finish_in_normalised_pq(&prepared, &grade, colour, strengths);
    let graded = finish_in_graded_pq(&prepared, &grade, colour, strengths);

    for (name, a, b) in [
        ("N normalised-PQ  vs  G graded-PQ (the live divergence)", &normalised, &graded),
        ("L linear         vs  G graded-PQ", &linear, &graded),
        ("L linear         vs  N normalised-PQ", &linear, &normalised),
    ] {
        report(name, a, b);
    }
}

/// `hdr::encode_still`'s order: grade, transfer, then filter the display-referred frame.
fn finish_in_graded_pq(
    prepared: &hdr::Prepared,
    grade: &hdr::Grade,
    colour: Option<&hdr_fit::HdrColour>,
    strengths: image::Strengths,
) -> Vec<u16> {
    let mut frame = prepared.samples.clone();
    hdr::grade_prepared(&mut frame, grade, colour, prepared.levels, 1.0);
    tone::encode_pq(&mut frame, grade.peak_nits);
    image::finish(&mut frame, prepared.width, prepared.height, strengths);
    frame
}

/// `edit::filter_once`'s order: filter an exposure-normalised PQ with no grade in it, invert
/// back to scene-linear, and let the grade happen afterwards (on the GPU, per tick).
fn finish_in_normalised_pq(
    prepared: &hdr::Prepared,
    grade: &hdr::Grade,
    colour: Option<&hdr_fit::HdrColour>,
    strengths: image::Strengths,
) -> Vec<u16> {
    let mut frame = prepared.samples.clone();
    let scale = grade.reference_white_nits / prepared.levels.white.max(1.0);

    let mut perceptual: Vec<f32> = frame
        .iter()
        .map(|s| tone::pq(f64::from(*s) * scale) as f32)
        .collect();
    let (sigma, defocus) =
        image::measurements(&perceptual, prepared.width, prepared.height, strengths);
    image::finish_with(
        &mut perceptual,
        prepared.width,
        prepared.height,
        strengths,
        sigma,
        defocus,
    );
    for (sample, filtered) in frame.iter_mut().zip(perceptual.iter()) {
        let nits = tone::pq_inv(f64::from(*filtered));
        *sample = (nits / scale).clamp(0.0, 65535.0).round() as u16;
    }

    hdr::grade_prepared(&mut frame, grade, colour, prepared.levels, 1.0);
    tone::encode_pq(&mut frame, grade.peak_nits);
    frame
}

/// The third option nothing currently does: filter the scene-linear frame, where the blur the
/// deconvolution models was actually applied.
fn finish_in_linear(
    prepared: &hdr::Prepared,
    grade: &hdr::Grade,
    colour: Option<&hdr_fit::HdrColour>,
    strengths: image::Strengths,
) -> Vec<u16> {
    let mut frame = prepared.samples.clone();
    image::finish(&mut frame, prepared.width, prepared.height, strengths);
    hdr::grade_prepared(&mut frame, grade, colour, prepared.levels, 1.0);
    tone::encode_pq(&mut frame, grade.peak_nits);
    frame
}

/// ICtCp, from a PQ-coded Rec.2020 triple (BT.2100 non-constant luminance).
fn ictcp(r: u16, g: u16, b: u16) -> [f64; 3] {
    let nits = |v: u16| tone::pq_inv(f64::from(v) / 65535.0);
    let (r, g, b) = (nits(r), nits(g), nits(b));

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

/// ΔE ITP. The 720 is BT.2124's scaling, where 1.0 is nominally the threshold of visibility.
fn delta_itp(a: [f64; 3], b: [f64; 3]) -> f64 {
    let (di, dt, dp) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    720.0 * (di * di + 0.25 * dt * dt + dp * dp).sqrt()
}

const BUCKETS: usize = 32;

fn report(name: &str, a: &[u16], b: &[u16]) {
    let pixels = a.len() / 3;
    let mut deltas = Vec::with_capacity(pixels);
    // Per-level sums, so the best correction a level-indexed table could apply is known
    // exactly rather than fitted: its optimum per bucket *is* the bucket mean.
    let mut sums = [[0.0f64; 3]; BUCKETS];
    let mut counts = [0usize; BUCKETS];
    let mut pairs = Vec::with_capacity(pixels);

    for p in 0..pixels {
        let (i, j) = (p * 3, p * 3);
        let x = ictcp(a[i], a[i + 1], a[i + 2]);
        let y = ictcp(b[j], b[j + 1], b[j + 2]);
        let bucket = ((y[0].clamp(0.0, 1.0) * (BUCKETS - 1) as f64).round() as usize).min(BUCKETS - 1);
        for c in 0..3 {
            sums[bucket][c] += x[c] - y[c];
        }
        counts[bucket] += 1;
        deltas.push(delta_itp(x, y));
        pairs.push((bucket, x, y));
    }

    // What is left once an ideal level-indexed correction has been subtracted. Two of them:
    // one that may only move I, and one that may move all three. Neither is a filter that
    // could be built and shipped - they are upper bounds on what any post-hoc table can do.
    let mean = |bucket: usize, c: usize| {
        if counts[bucket] == 0 { 0.0 } else { sums[bucket][c] / counts[bucket] as f64 }
    };
    let mut luma_only = Vec::with_capacity(pixels);
    let mut all_three = Vec::with_capacity(pixels);
    for (bucket, x, y) in &pairs {
        let corrected_i = [y[0] + mean(*bucket, 0), y[1], y[2]];
        luma_only.push(delta_itp(*x, corrected_i));
        let corrected = [
            y[0] + mean(*bucket, 0),
            y[1] + mean(*bucket, 1),
            y[2] + mean(*bucket, 2),
        ];
        all_three.push(delta_itp(*x, corrected));
    }

    println!("\n=== {name}");
    print_stats("raw", &mut deltas);
    print_stats("after an ideal 1D curve in I", &mut luma_only);
    print_stats("after ideal per-level I+Ct+Cp", &mut all_three);
}

fn print_stats(label: &str, deltas: &mut [f64]) {
    deltas.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let at = |q: f64| deltas[((deltas.len() - 1) as f64 * q) as usize];
    let mean = deltas.iter().sum::<f64>() / deltas.len() as f64;
    let over1 = deltas.iter().filter(|d| **d > 1.0).count() as f64 / deltas.len() as f64;
    println!(
        "  {label:<30} mean {mean:6.3}  p50 {:6.3}  p95 {:6.3}  p99 {:6.3}  max {:7.3}  >1.0 {:5.2}%",
        at(0.50),
        at(0.95),
        at(0.99),
        deltas[deltas.len() - 1],
        over1 * 100.0,
    );
}
