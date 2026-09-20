//! What the camera match costs, and what it is worth, in one run.
//!
//! ```text
//! fit_bench <raw>...
//! ```
//!
//! **The two things an optimisation here has to move in opposite directions.** The match is the
//! largest CPU stage of a rendition - larger than the denoise on a discrete card - so it is worth
//! attacking; and it decides the colour of every photograph, so a faster one that fits differently
//! is not the same feature. Timing alone would hide that, and `deltaE` alone would hide the point.
//!
//! `deltaE` is the fit's own: the mean over pairs it was not fitted from, against the baseline of
//! applying nothing, which is what it has to beat to be applied at all. `matched` says whether it
//! was. The colour figures below are the fitted transform itself, printed so that two runs can be
//! held against each other exactly rather than through a rendered picture.
//!
//! The decode is done once and the match repeated, because it is the match being measured.

use rawshim::hdr;

const REPEATS: usize = 5;

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("fit_bench <raw>...");
        std::process::exit(2);
    }
    for path in &files {
        measure(path);
    }
}

fn measure(path: &str) {
    let quantile = 0.9;
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("fit_bench: no adapter");
        std::process::exit(2);
    };
    let Some(frame) = rawshim::decode_frame(path, 0) else {
        eprintln!("{path}: no decode");
        return;
    };
    let Some(resident) = frame.on_device(gpu) else {
        eprintln!("{path}: not 16-bit");
        return;
    };

    // Timed apart because it is not the same work on every body: a Sony embeds a 1616px preview
    // and a Canon only its full-size one, and each is decoded whole.
    let mut preview_ms = Vec::with_capacity(REPEATS);
    let mut preview_size = (0, 0);
    for _ in 0..REPEATS {
        let began = std::time::Instant::now();
        let preview = hdr::match_preview(path);
        preview_ms.push(began.elapsed().as_secs_f64() * 1000.0);
        let Some(preview) = preview else {
            eprintln!("{path}: no preview");
            return;
        };
        preview_size = (preview.width, preview.height);
    }
    preview_ms.sort_by(|a, b| a.partial_cmp(b).expect("no NaN in a wall time"));

    let mut taken = Vec::with_capacity(REPEATS);
    let mut last = None;
    for _ in 0..REPEATS {
        // Re-fetched per round rather than cloned: `Geometry` is not `Clone`, and reading it is a
        // lensfun lookup rather than anything this is trying to time.
        let Some(geometry) = rawshim::ffi::geometry_for(path) else {
            eprintln!("{path}: no geometry");
            return;
        };
        let began = std::time::Instant::now();
        let fitted =
            pollster::block_on(hdr::fit_all(gpu, path, &resident, quantile, geometry));
        taken.push(began.elapsed().as_secs_f64() * 1000.0);
        last = fitted;
    }
    taken.sort_by(|a, b| a.partial_cmp(b).expect("no NaN in a wall time"));

    let name = path.rsplit('/').next().unwrap_or(path);
    println!(
        "{name}  {:.1}ms  ({:.1} - {:.1})   preview {}x{} decode {:.1}ms",
        taken[REPEATS / 2],
        taken[0],
        taken[REPEATS - 1],
        preview_size.0,
        preview_size.1,
        preview_ms[REPEATS / 2],
    );
    match last {
        None => println!("    matched no"),
        Some((profile, matched, _)) => {
            println!(
                "    geometry source {} crop {:.6} gain {} knots {}",
                profile.source,
                profile.crop,
                profile.gain.is_some(),
                profile.knots.as_deref().map_or_else(String::new, |knots| {
                    knots.iter().map(|k| format!("{k:.4}")).collect::<Vec<_>>().join(" ")
                }),
            );
            let c = &matched.colour;
            println!(
                "    matched yes  deltaE {:.6}  saturation {:.6}  chroma {}",
                c.delta_e,
                c.saturation,
                match c.chroma {
                    Some(_) => "yes",
                    None => "no",
                },
            );
            // The whole match as the sidecar would store it, hashed: the lattice is too large to
            // print, and this is the form every later render reads.
            let encoded = rawshim::photo_analysis::encode(&rawshim::photo_analysis::PhotoAnalysis {
                from_raw: rawshim::photo_analysis::FromRaw {
                    matched: Some(matched.clone()),
                    ..Default::default()
                },
                ..Default::default()
            });
            let mut hasher = std::hash::DefaultHasher::new();
            std::hash::Hash::hash(&encoded, &mut hasher);
            println!("    encoded {:016x}", std::hash::Hasher::finish(&hasher));
            // The transform itself, so two runs are compared on what they fitted rather than on
            // how long they took to fit it.
            for (row, values) in c.matrix.iter().enumerate() {
                println!(
                    "    matrix[{row}]  {:.9}  {:.9}  {:.9}",
                    values[0], values[1], values[2]
                );
            }
            // One sample of each curve rather than all of them: enough that a curve which moved
            // shows, short enough to read.
            for (channel, curve) in c.curves.iter().enumerate() {
                let at = |f: f64| curve[((curve.len() - 1) as f64 * f) as usize];
                println!(
                    "    curve[{channel}]   {:.9}  {:.9}  {:.9}",
                    at(0.25),
                    at(0.5),
                    at(0.75)
                );
            }
        }
    }
}
