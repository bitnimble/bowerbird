//! What an SDR rendition costs against an HDR one, and where the difference sits.
//!
//! DESIGN §10.1's table is encode-only and compares 4:4:4 against 4:2:0; §10.4's is stage B
//! (a tile off the embedded JPEG) against stage C (a full render). Neither answers "the same
//! rendition, SDR or HDR", which is the question the edits work has to price - an edit forces
//! a render, and if it also forces the HDR path that is a different number again.
//!
//! Three runs per fixture, medians reported: a whole SDR job, a whole HDR job, and the two
//! decodes alone, since the SDR path decodes 8-bit non-linear where the HDR path needs 16-bit
//! scene-linear and that is the one lever big enough to see from here.
//!
//! Peak RSS is measured separately, one job per process, because `VmHWM` is a high-water mark
//! and two jobs in one process would report the larger of them twice. It is also the number
//! that matters: `processing_concurrency` multiplies it.
//!
//! Run:
//!   cargo run --release --example sdr_vs_hdr --features renditions -- [raw] [size]
//!
//! and, for the peak-RSS figures, once per mode - each needs its own process:
//!   cargo run --release --example sdr_vs_hdr --features renditions -- <raw> 3840 rss:sdr
//!   cargo run --release --example sdr_vs_hdr --features renditions -- <raw> 3840 rss:hdr

use rawshim::{hdr, job};
use std::time::{Duration, Instant};

const RUNS: usize = 3;

fn target(hdr_target: bool, size: u32, out: &str) -> job::Target {
    job::Target {
        rendition: job::Rendition::Full,
        hdr: hdr_target,
        output_path: out.to_string(),
        size,
        source: job::Source::Render,
        // The shipped defaults, so this prices what the app actually writes:
        // `full_rendition_quantizer` 13, `hdr_crf` 10, and `hdr_preset` 8 - which
        // `processing_service.target` hands to *both* paths, so the encoder's speed knob is
        // not what separates them.
        sdr_quantizer: 13,
        hdr_quantizer: 10,
        preset: 8,
        still_full_chroma: false,
        sdr_full_chroma: false,
    }
}

fn build(path: &str, hdr_target: bool, size: u32, out: &str) -> job::Job {
    job::Job {
        raw_file_path: path.to_string(),
        match_embedded_jpeg: true,
        denoise_luma: 1.0,
        denoise_chroma: 1.0,
        sharpen: 1.0,
        defringe: 1.0,
        grade: hdr::Grade {
            peak_nits: 1000.0,
            reference_white_nits: 203.0,
            white_quantile: 0.90,
        },
        targets: vec![target(hdr_target, size, out)],
    }
}

fn median(mut runs: Vec<Duration>) -> Duration {
    runs.sort();
    runs[runs.len() / 2]
}

fn time<T>(mut work: impl FnMut() -> T) -> Duration {
    median(
        (0..RUNS)
            .map(|_| {
                let at = Instant::now();
                let _held = work();
                at.elapsed()
            })
            .collect(),
    )
}

/// Peak resident set for this process, which is what `processing_concurrency` multiplies.
///
/// A high-water mark, so it only means anything in a process that has run one job and nothing
/// else - hence the `rss:` modes below, each of which is its own invocation.
fn peak_rss_mb() -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmHWM:"))?
                .split_whitespace()
                .nth(1)?
                .parse::<f64>()
                .ok()
        })
        .map(|kb| kb / 1024.0)
        .unwrap_or(0.0)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().unwrap_or_else(|| {
        format!("{}/../../test/fixtures/DSC02981.ARW", env!("CARGO_MANIFEST_DIR"))
    });
    let size: u32 = args.next().and_then(|a| a.parse().ok()).unwrap_or(3840);

    // One job, one process, so the high-water mark belongs to that job alone. This is the
    // number that decides whether "16-bit everywhere" is affordable at concurrency 4, and it
    // is the one `job.rs` cites for keeping the SDR decode 8-bit.
    if let Some(mode) = args.next() {
        let want_hdr = mode == "rss:hdr";
        let out = std::env::temp_dir().join("rss.avif").to_string_lossy().into_owned();
        job::run(&build(&path, want_hdr, size, &out)).expect("job");
        println!("  peak RSS {:>7.0}MB   {}", peak_rss_mb(), if want_hdr { "HDR" } else { "SDR" });
        return;
    }

    let dir = std::env::temp_dir().join("sdr_vs_hdr");
    std::fs::create_dir_all(&dir).expect("temp dir");
    let sdr_out = dir.join("sdr.avif").to_string_lossy().into_owned();
    let hdr_out = dir.join("hdr.avif").to_string_lossy().into_owned();

    println!("{}  full rendition at {size}px, medians of {RUNS}\n", path.rsplit('/').next().unwrap_or(&path));

    let sdr = time(|| job::run(&build(&path, false, size, &sdr_out)).expect("sdr job"));
    let hdr_job = time(|| job::run(&build(&path, true, size, &hdr_out)).expect("hdr job"));

    // The decode each path asks for, alone. The SDR one is 8-bit and non-linear because its
    // encode is 8-bit whatever goes in (§10.1); the HDR one has to be 16-bit scene-linear for
    // the grade to have anything to work with.
    let sdr_decode = time(|| rawshim::decode_frame(&path, 8, false, size));
    let hdr_decode = time(|| rawshim::decode_frame(&path, 16, true, size));

    // Where the HDR path's time actually sits. Timed against the same decode both jobs would
    // have made, so these are the stages themselves rather than a second decode each.
    let frame = rawshim::decode_frame(&path, 16, true, size).expect("hdr decode");
    let samples = frame.samples16().expect("16-bit");
    let source = hdr::Source { samples, width: frame.width, height: frame.height };
    let strengths = rawshim::image::Strengths { luma: 1.0, chroma: 1.0, sharpen: 1.0, defringe: 1.0 };
    let grade = hdr::Grade { peak_nits: 1000.0, reference_white_nits: 203.0, white_quantile: 0.90 };

    let fit = time(|| {
        hdr::fit_all(&path, &source, 0.90, rawshim::fit::Geometry::Uncorrected, strengths)
    });
    let matched = hdr::fit_all(&path, &source, 0.90, rawshim::fit::Geometry::Uncorrected, strengths);
    let colour = matched.as_ref().map(|(_, m)| &m.colour);
    let prepared = hdr::prepare(&source, None, &grade);
    let (w, h) = (prepared.width, prepared.height);

    let graded = time(|| {
        let mut f = prepared.samples.clone();
        hdr::grade_prepared(&mut f, &grade, colour, prepared.levels, 1.0);
        f
    });
    let mut once = prepared.samples.clone();
    hdr::grade_prepared(&mut once, &grade, colour, prepared.levels, 1.0);
    let pq = time(|| {
        let mut f = once.clone();
        rawshim::tone::encode_pq(&mut f, grade.peak_nits);
        f
    });
    rawshim::tone::encode_pq(&mut once, grade.peak_nits);
    let finish16 = time(|| {
        let mut f = once.clone();
        rawshim::image::finish(&mut f, w, h, strengths);
        f
    });
    // The same filter the SDR path runs, on 8-bit samples, so the two are comparable.
    let eight: Vec<u8> = once.iter().map(|s| (s >> 8) as u8).collect();
    let finish8 = time(|| {
        let mut f = eight.clone();
        rawshim::image::finish(&mut f, w, h, strengths);
        f
    });

    println!("\n  HDR stages at {w}x{h}");
    for (name, d) in [
        ("camera fit", fit),
        ("grade (curves+matrix+chroma+rolloff)", graded),
        ("encode_pq", pq),
        ("image::finish on u16", finish16),
        ("image::finish on u8 (what SDR pays)", finish8),
    ] {
        println!("    {name:<38} {:>7.0}ms", d.as_secs_f64() * 1000.0);
    }

    let bytes = |p: &str| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) as f64 / 1024.0;

    println!("  whole job   SDR {:>7.0}ms   HDR {:>7.0}ms   HDR/SDR {:.2}x",
        sdr.as_secs_f64() * 1000.0,
        hdr_job.as_secs_f64() * 1000.0,
        hdr_job.as_secs_f64() / sdr.as_secs_f64());
    println!("  decode only SDR {:>7.0}ms   HDR {:>7.0}ms   HDR/SDR {:.2}x   (8-bit sRGB vs 16-bit linear)",
        sdr_decode.as_secs_f64() * 1000.0,
        hdr_decode.as_secs_f64() * 1000.0,
        hdr_decode.as_secs_f64() / sdr_decode.as_secs_f64());
    println!("  everything else (job minus decode)          SDR {:>7.0}ms   HDR {:>7.0}ms",
        (sdr.as_secs_f64() - sdr_decode.as_secs_f64()) * 1000.0,
        (hdr_job.as_secs_f64() - hdr_decode.as_secs_f64()) * 1000.0);
    println!("  output      SDR {:>7.1}kB  HDR {:>7.1}kB", bytes(&sdr_out), bytes(&hdr_out));
}
