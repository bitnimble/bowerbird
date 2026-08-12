//! What the noise fit reports across a real library, against the ISO the camera recorded.
//!
//! The question this answers: is the fitted model a good enough description of "how noisy is
//! this photograph" to *choose* a denoise amount from, rather than shipping one default and
//! hoping. If it tracks ISO across a library it is measuring the right thing; where it
//! departs from ISO is where it is more right than ISO, since a pushed exposure and a clean
//! one at the same sensitivity are not the same photograph.

use rawshim::galosh::Amounts;

fn main() {
    let dir = std::env::args().nth(1).expect("a directory of RAWs");
    let mut paths: Vec<String> = std::fs::read_dir(&dir)
        .expect("read the directory")
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path.to_str()?.to_string();
            name.to_lowercase().ends_with(".cr3").then_some(name)
        })
        .collect();
    paths.sort();

    println!("{:>8}  {:>10}  {:>11}  {:>10}  {}", "iso", "alpha", "sigma_sq", "std@grey", "file");
    let mut rows: Vec<(f32, f32, f32, f32, String)> = Vec::new();
    for path in &paths {
        let Some(header) = rawshim::header::read_path(path) else {
            continue;
        };
        // The fit rides along with a real decode, which is the only place the mosaic exists.
        // The amount barely matters - Phase 0 runs before anything is filtered - so this is
        // the document's default.
        let Some(model) =
            rawshim::decode_frame_denoised(path, 16, true, 0, Amounts::from_sliders(33.0, 33.0))
                .and_then(|frame| frame.noise)
        else {
            continue;
        };
        rows.push((
            header.iso,
            model.alpha,
            model.sigma_sq,
            model.at_mid_grey(),
            path.rsplit('/').next().unwrap_or(path).to_string(),
        ));
    }
    rows.sort_by(|a, b| a.0.total_cmp(&b.0));
    for (iso, alpha, sigma_sq, std, name) in &rows {
        println!("{iso:>8.0}  {alpha:>10.6}  {sigma_sq:>11.8}  {std:>10.5}  {name}");
    }

    // The reference's own gate, for scale: below this it declines to denoise at all.
    println!("\nthe reference skips the whole pipeline under std@grey 0.002");
    let _ = Amounts::default();
}
