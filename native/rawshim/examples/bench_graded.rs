//! Wall time of the shipped grade alone (coding, resize, lens, sharpen, tone).
//! usage: bench_graded <raw> [rounds]

mod support;

use rawshim::hdr_args::{Chroma, EncodeOptions};
use std::env;
use std::time::Instant;

fn main() {
    let path = env::args().nth(1).expect("raw path");
    let rounds: usize = env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(9);

    let opened = support::Open::shipped(&path, support::FULL_RENDITION_SIZE)
        .run()
        .expect("decode");
    opened.measured.matched.as_ref().expect("hdr fit");

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

    let rolled = rawshim::gpu::Output::Rolled;
    let _ = support::graded(&opened, &options, rolled);

    let mut walls = Vec::with_capacity(rounds);
    for _ in 0..rounds {
        let start = Instant::now();
        let (out, w, h) = support::graded(&opened, &options, rolled);
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
