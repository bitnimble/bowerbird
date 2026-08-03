//! Times the editor's open path with the thread pool and without it.
//!
//! The tick path is what a GPU would take over (`docs/raw-edit-gpu.md` §6), which raises
//! whether the wasm thread pool, and with it `SharedArrayBuffer` and cross-origin
//! isolation, still earns its complexity. Everything the editor does after open would be on
//! the GPU; what stays on the CPU is this. So the question is what one thread costs here.
//!
//! Native rather than wasm, so the ratio is indicative and the absolute numbers are not:
//! the browser has fewer cores available and a slower memcpy. The stages mirror
//! `wasm::Editor::new` plus `fit_camera_match`.
//!
//! cargo run --release --example open_threads -- <raw> [long-edge]

use rawshim::{fit, hdr, hdr_fit, image, jpeg, lens, tone};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: open_threads <raw> [long-edge]");
    let long_edge: u32 = args.next().map_or(3840, |v| v.parse().expect("long edge"));
    let bytes = std::fs::read(&path).expect("the RAW should read");

    let grade = hdr::Grade { peak_nits: 1000.0, reference_white_nits: 203.0, white_quantile: 0.995 };
    let strengths = image::Strengths { luma: 1.0, chroma: 1.0, sharpen: 1.0, defringe: 1.0 };

    for threads in [0, 1] {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .expect("the pool should build");
        let label = match threads {
            1 => "1 thread".to_string(),
            _ => format!("{} threads", pool.current_num_threads()),
        };
        pool.install(|| open(&bytes, long_edge, &grade, strengths, &label));
    }
}

fn open(bytes: &[u8], long_edge: u32, grade: &hdr::Grade, strengths: image::Strengths, label: &str) {
    let started = std::time::Instant::now();
    let frame = rawshim::decode_frame_bytes(bytes, 16, true, long_edge).expect("LibRaw decode");
    let decoded = started.elapsed();

    let at = std::time::Instant::now();
    let source = hdr::Source {
        samples: frame.samples16().expect("16-bit decode"),
        width: frame.width,
        height: frame.height,
    };
    let mut prepared = hdr::prepare(&source, None, grade);
    let prepare = at.elapsed();

    let at = std::time::Instant::now();
    let preview_jpeg = rawshim::embedded_jpeg_bytes(bytes).expect("an embedded preview");
    let preview = jpeg::decode(&preview_jpeg, hdr_fit::sample_long_edge()).expect("preview decode");
    let jpeg_decode = at.elapsed();

    let at = std::time::Instant::now();
    let recorded = lens::read_distortion(bytes);
    let geometry = match (recorded.applied, recorded.spline) {
        (Some(false), _) => fit::Geometry::Uncorrected,
        (_, Some(knots)) => fit::Geometry::Recorded(knots),
        (_, None) => fit::Geometry::Unstated,
    };
    let matched = hdr::fit_all_from_preview(
        &source,
        grade.white_quantile,
        geometry,
        strengths.before_the_fit(),
        &preview,
        recorded.lateral,
    )
    .map(|(_, matched)| matched);
    let fitted = at.elapsed();

    // Materialised into the prepared buffer, as `Editor::prepared_from` does, so the shrink
    // and the tick below run on the frame a slider tick actually grades.
    let at = std::time::Instant::now();
    let warped = matched.as_ref().and_then(|m| {
        hdr_fit::apply_lens(&prepared.samples, prepared.width, prepared.height, m)
    });
    let did_warp = warped.is_some();
    if let Some(samples) = warped {
        prepared.samples = samples;
    }
    let warp = at.elapsed();

    let at = std::time::Instant::now();
    let shrunk = prepared.shrunk_to(960);
    let shrink = at.elapsed();

    // One tick at the interactive size, for scale against the stages above.
    let at = std::time::Instant::now();
    let mut working = shrunk.samples.clone();
    hdr::grade_prepared(&mut working, grade, matched.as_ref().map(|m| &m.colour), shrunk.levels, 1.0);
    tone::encode_pq(&mut working, grade.peak_nits);
    image::finish(&mut working, shrunk.width, shrunk.height, strengths);
    let tick = at.elapsed();

    let total = decoded + prepare + jpeg_decode + fitted + warp + shrink;
    println!(
        "{label:>10}: decode {:>6.0}ms  prepare {:>5.0}ms  jpeg {:>4.0}ms  fit {:>6.0}ms  \
         warp {:>5.0}ms  shrink {:>4.0}ms  = open {:>6.0}ms   |  960 tick {:>5.0}ms  \
         (matched {}, warped {})",
        decoded.as_secs_f64() * 1e3,
        prepare.as_secs_f64() * 1e3,
        jpeg_decode.as_secs_f64() * 1e3,
        fitted.as_secs_f64() * 1e3,
        warp.as_secs_f64() * 1e3,
        shrink.as_secs_f64() * 1e3,
        total.as_secs_f64() * 1e3,
        tick.as_secs_f64() * 1e3,
        matched.is_some(),
        did_warp,
    );
}
