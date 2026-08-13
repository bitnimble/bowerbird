//! Is lensfun worth linking? Measured, per frame, against the camera's own JPEG.
//!
//! The question this answers: for a body that records no distortion spline - every Canon,
//! since `lens::read_distortion` reads Sony's tag - the geometry falls to one of two
//! tiers. `Geometry::Profiled` takes lensfun's database curve and scans a gain over it;
//! `Geometry::Unstated` fits a one-parameter polynomial family from scratch. The second is
//! 2-3x slower at the open. The first costs a C library with no prebuilt Android build.
//!
//! Both are scored the same way the fit already scores every candidate: `residual_of`, the
//! BT.709 luma delta against the embedded JPEG, over corresponding points, with a tone
//! curve fitted on a training split and the score taken on a held-out one. Lower is
//! closer to what the camera itself produced.
//!
//! Usage: `cargo run --release --example lensfun_vs_fitted -- <dir-or-file>...`

use rawshim::{fit, hdr, hdr_fit};

fn main() {
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for argument in std::env::args().skip(1) {
        let path = std::path::PathBuf::from(&argument);
        match path.is_dir() {
            true => {
                let Ok(entries) = std::fs::read_dir(&path) else { continue };
                for entry in entries.flatten() {
                    let file = entry.path();
                    if file.extension().is_some_and(is_raw) {
                        files.push(file);
                    }
                }
            }
            false => files.push(path),
        }
    }
    files.sort();
    if files.is_empty() {
        eprintln!("no RAWs found; pass a directory or some files");
        std::process::exit(1);
    }

    println!(
        "{:<18} {:>9} {:>9} {:>9}   {:>8} {:>8}  {}",
        "file", "none", "lensfun", "fitted", "lf gain", "fit gain", "lens"
    );

    let mut rows = Vec::new();
    for path in &files {
        match measure(path) {
            Ok(Some(row)) => {
                println!(
                    "{:<18} {:>9.4} {:>9} {:>9.4}   {:>7.1}% {:>7.1}%  {}",
                    row.name,
                    row.none,
                    row.lensfun.map_or("-".into(), |v| format!("{v:.4}")),
                    row.fitted,
                    row.lensfun.map_or(f64::NAN, |v| gain(row.none, v)),
                    gain(row.none, row.fitted),
                    row.lens,
                );
                rows.push(row);
            }
            Ok(None) => eprintln!("{}: no embedded preview to fit against", name(path)),
            Err(e) => eprintln!("{}: {e}", name(path)),
        }
    }

    summarise(&rows);
}

struct Row {
    name: String,
    lens: String,
    /// The uncorrected frame, which is what both tiers have to beat.
    none: f64,
    lensfun: Option<f64>,
    fitted: f64,
}

/// How much of the uncorrected residual a tier removed. Negative means it made it worse.
fn gain(none: f64, corrected: f64) -> f64 {
    (none - corrected) / none * 100.0
}

fn is_raw(extension: &std::ffi::OsStr) -> bool {
    let extension = extension.to_string_lossy().to_uppercase();
    matches!(extension.as_str(), "CR2" | "CR3" | "ARW" | "NEF" | "RAF" | "DNG" | "ORF")
}

fn name(path: &std::path::Path) -> String {
    path.file_name().unwrap_or_default().to_string_lossy().to_string()
}

fn measure(path: &std::path::Path) -> Result<Option<Row>, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;

    // The same pipeline `hdr::fit_all_from_preview` fits through, so the numbers mean what
    // they mean there: a bounded decode, the levels it measures, and the sRGB render the
    // preview is paired against.
    let frame = rawshim::decode_frame_bytes(&bytes, 16, true, 0, rawshim::galosh::Fit::Measure)
        .ok_or("the decode declined it")?;
    let samples = frame.samples16().ok_or("the decode was not 16-bit")?;
    let source = hdr::Source { samples, width: frame.width, height: frame.height };

    let jpeg = rawshim::decode_rawler::upright_preview_jpeg_bytes(&bytes).ok_or("no embedded JPEG")?;
    let preview = rawshim::jpeg::decode(&jpeg, hdr_fit::sample_long_edge())?;

    let levels = rawshim::tone::levels(source.samples, 0.995);
    let plane = hdr_fit::fit_plane(source.samples, source.width, source.height, preview.width);
    let render = hdr_fit::render_srgb8(&plane, levels.white);

    let scored = |knots: &[f64], crop: f64| {
        fit::residual_of(render.as_ref(), preview.as_ref(), knots, crop)
    };
    let Some(none) = scored(&[], 1.0)? else { return Ok(None) };

    // Each tier run as the cascade runs it, then scored on what it settled on - so a tier
    // that was offered a curve and rejected it scores as the uncorrected frame, which is
    // what shipping it would actually look like.
    let header = rawshim::header::read_path(&path.to_string_lossy());
    let lens = header.as_ref().map_or(String::new(), |h| rawshim::header::name(&h.lens_model).to_string());
    let profiled = header.as_ref().and_then(|h| {
        rawshim::lensfun::knots(
            rawshim::header::name(&h.camera_make),
            rawshim::header::name(&h.camera_model),
            rawshim::header::name(&h.lens_model),
            h.focal,
            h.aperture,
            h.width as usize,
            h.height as usize,
        )
    });

    let settled = |geometry: fit::Geometry| -> Result<Option<f64>, String> {
        let Some(profile) = fit::fit_from_preview(render.as_ref(), preview.as_ref(), geometry)?
        else {
            return Ok(None);
        };
        scored(profile.knots.as_deref().unwrap_or_default(), profile.crop)
    };

    let lensfun = match profiled {
        Some(knots) => settled(fit::Geometry::Profiled(knots))?,
        None => None,
    };
    let Some(fitted) = settled(fit::Geometry::Unstated)? else { return Ok(None) };

    Ok(Some(Row { name: name(path), lens, none, lensfun, fitted }))
}

fn summarise(rows: &[Row]) {
    if rows.is_empty() {
        return;
    }
    let mean = |values: &[f64]| values.iter().sum::<f64>() / values.len() as f64;

    let all: Vec<f64> = rows.iter().map(|r| r.none).collect();
    let fitted: Vec<f64> = rows.iter().map(|r| r.fitted).collect();
    println!("\n{} frames", rows.len());
    println!("  uncorrected  mean {:.4}", mean(&all));
    println!("  fitted       mean {:.4}  ({:+.1}%)", mean(&fitted), gain(mean(&all), mean(&fitted)));

    // Only where lensfun had something to say, and the fitted number restricted to the
    // same frames - otherwise the two means are over different pictures.
    let paired: Vec<(f64, f64, f64)> = rows
        .iter()
        .filter_map(|r| r.lensfun.map(|lf| (r.none, lf, r.fitted)))
        .collect();
    if paired.is_empty() {
        println!("  lensfun      matched no lens in this set");
        return;
    }
    let none_p: Vec<f64> = paired.iter().map(|p| p.0).collect();
    let lensfun_p: Vec<f64> = paired.iter().map(|p| p.1).collect();
    let fitted_p: Vec<f64> = paired.iter().map(|p| p.2).collect();
    println!("\n  where lensfun matched ({} frames):", paired.len());
    println!("    uncorrected mean {:.4}", mean(&none_p));
    println!("    lensfun     mean {:.4}  ({:+.1}%)", mean(&lensfun_p), gain(mean(&none_p), mean(&lensfun_p)));
    println!("    fitted      mean {:.4}  ({:+.1}%)", mean(&fitted_p), gain(mean(&none_p), mean(&fitted_p)));

    let better = paired.iter().filter(|p| p.2 < p.1).count();
    println!("\n    fitted beats lensfun on {better} of {} frames", paired.len());
}
