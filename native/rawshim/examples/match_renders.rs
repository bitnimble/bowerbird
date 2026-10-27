//! Every RAW in a directory, opened and graded as the library ships it, as a whole-frame snapshot.
//!
//! ```text
//! match_renders <raw dir> <out dir>
//! ```
//!
//! Writes `<out dir>/<file name>.png` in the snapshot format, so two runs from two builds compare
//! with `snapshot_diff --before <one> --after <other>` without either becoming a committed
//! snapshot. Exits 1 if any photo was skipped.

mod support;

use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::snapshot::{Frame, Snapshot};

/// The long edge the snapshot is downscaled to, as the grade fixtures take theirs.
const SNAPSHOT_LONG: usize = 960;

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(dir), Some(out)) = (args.next(), args.next()) else {
        eprintln!("match_renders <raw dir> <out dir>");
        std::process::exit(2);
    };
    std::fs::create_dir_all(&out).expect("the output directory");
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .expect("the directory reads")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                matches!(
                    e.to_ascii_uppercase().as_str(),
                    "CR3" | "CR2" | "ARW" | "NEF" | "RAF" | "DNG"
                )
            })
        })
        .collect();
    paths.sort();

    let gpu = gpu::device().expect("a Vulkan adapter, since the grade is a shader");
    let options = EncodeOptions {
        still_chroma: Chroma::Yuv444,
        output_path: String::new(),
        grade: support::GRADE,
        crf: 26,
        preset: 6,
        strengths: support::STRENGTHS,
        sharpen_sigma: None,
        max_edge: f64::from(support::FULL_RENDITION_SIZE),
        content_light: None,
    };
    let mut skipped = false;
    for path in paths {
        let (Some(raw), Some(name)) = (path.to_str(), path.file_name().and_then(|s| s.to_str()))
        else {
            eprintln!("{}: not a UTF-8 path", path.display());
            skipped = true;
            continue;
        };
        let Some(opened) = support::Open::shipped(raw, support::FULL_RENDITION_SIZE).run() else {
            eprintln!("{name}: did not open");
            skipped = true;
            continue;
        };
        let (pq, width, height) = support::graded(&opened, &options, rawshim::grade::Output::Pq);
        let resident = rawshim::resident::Resident::upload(gpu, &pq, width, height);
        let snapshot = Snapshot::whole(
            Frame::Coded(&resident),
            units::px::Span::exact(SNAPSHOT_LONG),
        );
        let written = std::path::Path::new(&out).join(format!("{name}.png"));
        std::fs::write(&written, snapshot.encode()).expect("the snapshot writes");
        println!("{}", written.display());
    }
    if skipped {
        std::process::exit(1);
    }
}
