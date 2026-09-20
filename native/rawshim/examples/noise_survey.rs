//! What the noise fit reports across a real library, against the ISO the camera recorded.
//!
//! The question this answers: is the fitted model a good enough description of "how noisy is
//! this photograph" to *choose* a denoise amount from, rather than shipping one default and
//! hoping. If it tracks ISO across a library it is measuring the right thing; where it
//! departs from ISO is where it is more right than ISO, since a pushed exposure and a clean
//! one at the same sensitivity are not the same photograph.

use rawshim::galosh::Detail;

fn main() {
    let dir = std::env::args().nth(1).expect("a directory of RAWs");
    let mut paths: Vec<String> = std::fs::read_dir(&dir)
        .expect("read the directory")
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path.to_str()?.to_string();
            let lower = name.to_lowercase();
            [".cr3", ".arw", ".dng", ".nef", ".raf", ".orf"]
                .iter()
                .any(|extension| lower.ends_with(extension))
                .then_some(name)
        })
        .collect();
    paths.sort();

    // Three candidate rules for an automatic amount, evaluated side by side. They differ in
    // what they hold constant, which is the whole of the decision:
    //
    // - `fixed`  the threshold stays a fixed fraction of the frame's *own* noise, which is
    //           what the shrinkage's normalisation already makes it. Physically the right
    //           question - "is this coefficient bigger than the noise" is inherently
    //           relative - plus a gate so a clean frame is not put through thirteen passes.
    // - `clean`  the *residual* is held constant: more noise, more removed, so every frame
    //           comes out equally quiet. What most editors do, and it pays in texture
    //           exactly where there is least of it to spare.
    // - `intact` the *amount removed* is held constant: more noise, less removed, so no
    //           frame loses more than a fixed slice of real detail. A noisy frame stays
    //           visibly noisy, which is arguably the honest answer, since texture under the
    //           noise floor is not recoverable by any setting.
    //
    // All three are pinned to agree at sigma 0.015, roughly an ISO 2000 frame, so what the
    // columns show is only how they diverge away from it.
    let gate = 0.004f32;
    let pivot = 0.015f32;
    let fixed = |s: f32| if s < gate { 0.0 } else { (40.0 * (s - 0.002) / 0.004).min(40.0) };
    let clean = |s: f32| (40.0 * s / pivot).min(100.0);
    let intact = |s: f32| if s < gate { 40.0 } else { (40.0 * pivot / s).min(100.0) };

    println!(
        "{:>8}  {:>10}  {:>11}  {:>9}  {:>6} {:>6} {:>7}  {}",
        "iso", "alpha", "sigma_sq", "std@grey", "fixed", "clean", "intact", "file",
    );
    let mut rows: Vec<(f32, f32, f32, f32, String)> = Vec::new();
    for path in &paths {
        let Some(header) = rawshim::header::read_path(path) else {
            continue;
        };
        // The fit rides along with a real decode, which is the only place the mosaic exists.
        // The amount barely matters - Phase 0 runs before anything is filtered - so this is
        // the document's default.
        let Some(model) = rawshim::decode_frame_denoised(
            path,
            0,
            Detail::at(33.0, 33.0),
            Default::default(),
        )
        .and_then(|frame| frame.noise)
        else {
            continue;
        };
        rows.push((
            header.iso,
            model.alpha,
            model.sigma_sq,
            model.model().at_mid_grey(),
            path.rsplit('/').next().unwrap_or(path).to_string(),
        ));
    }
    rows.sort_by(|a, b| a.0.total_cmp(&b.0));
    for (iso, alpha, sigma_sq, std, name) in &rows {
        println!(
            "{iso:>8.0}  {alpha:>10.6}  {sigma_sq:>11.8}  {std:>9.5}  {:>6.0} {:>6.0} {:>7.0}  {name}",
            fixed(*std),
            clean(*std),
            intact(*std),
        );
    }

    // How far apart the three actually are, which is the thing worth knowing before
    // choosing between them: if they agree over most of a library then the choice only
    // decides the handful of frames at the ends.
    let spread: Vec<f32> = rows
        .iter()
        .map(|(_, _, _, std, _)| {
            let three = [fixed(*std), clean(*std), intact(*std)];
            three.iter().copied().fold(f32::MIN, f32::max)
                - three.iter().copied().fold(f32::MAX, f32::min)
        })
        .collect();
    let within = |points: f32| spread.iter().filter(|s| **s <= points).count();
    println!(
        "\n{} of {} frames have the three rules within 15 points of each other, {} within 25",
        within(15.0),
        rows.len(),
        within(25.0),
    );
    println!("the reference skips the whole pipeline under std@grey 0.002");

    // `does_anything` is false at 0/0, so the "skipped" decode is the picture a gate would ship;
    // spin 2 runs four of the sixteen phases.
    let at = |path: &str, detail: Detail, phases: i32| {
        rawshim::galosh::force_phases(phases);
        rawshim::decode_frame_denoised(path, 0, detail, Default::default())
    };
    let deviation = |a: &[u16], b: &[u16]| {
        let (mut total, mut worst) = (0u64, 0u32);
        for (x, y) in a.iter().zip(b) {
            let off = u32::from(x.abs_diff(*y));
            total += u64::from(off);
            worst = worst.max(off);
        }
        (total as f64 / a.len() as f64, worst)
    };

    println!(
        "\n{:>10}  {:>18}  {:>18}  {:>18}  {}",
        "std@grey", "skipped mean/worst", "8 phases mean/worst", "4 phases mean/worst", "file",
    );
    let full = Detail::at(20.0, 30.0);
    for path in &paths {
        let Some(sixteen) = at(path, full, 16) else { continue };
        let Some(eight) = at(path, full, 8) else { continue };
        let Some(four) = at(path, full, 4) else { continue };
        let Some(none) = at(path, Detail::at(0.0, 0.0), 16) else { continue };
        let (Some(a), Some(h), Some(q), Some(c)) =
            (sixteen.samples16(), eight.samples16(), four.samples16(), none.samples16())
        else {
            continue;
        };
        let std = sixteen.noise.map_or(0.0, |fit| fit.model().at_mid_grey());
        let (skip_mean, skip_worst) = deviation(a, c);
        let (half_mean, half_worst) = deviation(a, h);
        let (quarter_mean, quarter_worst) = deviation(a, q);
        println!(
            "{std:>10.5}  {skip_mean:>9.2} {skip_worst:>8}  {half_mean:>9.2} {half_worst:>8}  \
             {quarter_mean:>9.2} {quarter_worst:>8}  {}",
            path.rsplit('/').next().unwrap_or(path),
        );
    }
    rawshim::galosh::force_phases(0);
}
