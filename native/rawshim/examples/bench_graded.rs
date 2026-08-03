//! Wall time of `hdr::graded` alone (resize + lens + tone).
//! usage: bench_graded <raw> [rounds]

use rawshim::hdr::{self, Grade, Source};
use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::image::Strengths;
use std::env;
use std::time::Instant;

fn main() {
    let path = env::args().nth(1).expect("raw path");
    let rounds: usize = env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(9);

    let frame = rawshim::decode_frame(&path, 16, true, 0).expect("decode");
    let samples = frame.samples16().expect("16-bit");
    let source = Source { samples, width: frame.width, height: frame.height };

    let render = rawshim::decode_frame(&path, 8, false, 0).expect("sdr decode");
    let profile = rawshim::fit_profile_for(&render, &path).expect("sdr fit");
    let matched = rawshim::fit_hdr_for(&frame, &path, 0.99, Some(&profile), Strengths::default())
        .expect("hdr fit");

    let options = EncodeOptions {
        still_chroma: Chroma::Yuv444,
        output_path: String::new(),
        grade: Grade {
            peak_nits: 1000.0,
            reference_white_nits: 203.0,
            white_quantile: 0.99,
        },
        crf: 26,
        preset: 6,
        strengths: Strengths::default(),
        max_edge: 3840.0,
    };

    let _ = hdr::graded(&source, &options, Some(&matched));

    let mut walls = Vec::with_capacity(rounds);
    for _ in 0..rounds {
        let start = Instant::now();
        let (out, w, h) = hdr::graded(&source, &options, Some(&matched));
        walls.push(start.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(out.len(), w * h * 3);
    }

    walls.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let med = walls[walls.len() / 2];
    println!("{med:.1}");
    eprintln!(
        "graded 3840 matched  rounds={rounds}  wall med {med:.1} ms  min {:.1} ms",
        walls[0],
    );
}
