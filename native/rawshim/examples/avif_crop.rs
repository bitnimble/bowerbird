//! A rendition file, cut at 1:1 and written in a domain a reader can look at.
//!
//! ```text
//! avif_crop <rendition.avif> <out-dir> --crop x,y,side... [--zoom N]
//! ```
//!
//! `renders` shows what the pipeline *would* write; this shows what it *did*, straight out of the
//! AVIF the server serves, so a picture bug a reader saw in the viewer is answered from the same
//! bytes. A PQ file is written three times per crop: `pq-*` is the high byte of each code,
//! `linear-*` is the light behind it with diffuse white at 255, which is where a modulation shows
//! at its true size, and `sdr-*` is that light through sRGB's transfer, which is the one of the
//! three that looks like the photograph. Roughness is measured on the 16-bit codes, per channel,
//! before any byte is taken.
//!
//! `sdr-*` clips above diffuse white rather than rolling: the roll is `colour.slang`'s and a second
//! answer to it here would be a second tone map to keep in agreement with the first.

use rawshim::light::{DisplayNits, Light, Pq};

const DIFFUSE_WHITE_NITS: f64 = 203.0;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("an avif path");
    let out = args.next().expect("an output directory");
    let mut crops: Vec<(usize, usize, usize)> = Vec::new();
    let mut zoom = 1usize;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--crop" => {
                let spec = args.next().expect("x,y,side");
                let n: Vec<usize> = spec
                    .split(',')
                    .map(|v| v.parse().expect("a number"))
                    .collect();
                assert!(
                    n.len() == 3 && n[2] >= 3,
                    "--crop wants x,y,side with side at least 3: {spec}"
                );
                crops.push((n[0], n[1], n[2]));
            }
            "--zoom" => zoom = args.next().expect("a number").parse().expect("a number"),
            other => panic!("unknown flag {other}"),
        }
    }
    std::fs::create_dir_all(&out).expect("the output directory");

    let bytes = std::fs::read(&path).expect("the avif");
    let (codes, width, height) = rawshim::avif::decode_at(&bytes, 16).expect("decodes");
    eprintln!("{width}x{height}");

    for (x, y, side) in crops {
        let x = x.min(width.saturating_sub(side));
        let y = y.min(height.saturating_sub(side));
        let mut cut = Vec::with_capacity(side * side * 3);
        for row in 0..side {
            let from = ((y + row) * width + x) * 3;
            cut.extend_from_slice(&codes[from..from + side * 3]);
        }
        let rough = channel_roughness(&cut, side);
        eprintln!("  {x},{y} (16-bit codes; roughness = median |laplacian| / 1.6521)");
        for (c, name) in ["r", "g", "b"].iter().enumerate() {
            let s = &rough[c];
            eprintln!(
                "    {name} mean {:7.0}  roughness {:6.1}  p99 {:6.0}  max {:6.0}  outliers>6x {:.2}%  zeros {:.1}%",
                s.mean,
                s.roughness,
                s.p99,
                s.max,
                s.outliers * 100.0,
                s.zeros * 100.0
            );
        }

        let pq: Vec<u8> = cut.iter().map(|v| (v >> 8) as u8).collect();
        let share = |v: &u16| {
            let signal = Light::<Pq>::measured(f64::from(*v) / f64::from(u16::MAX));
            (rawshim::tone::pq_inv::<DisplayNits>(signal).raw() / DIFFUSE_WHITE_NITS).min(1.0)
        };
        let linear: Vec<u8> = cut.iter().map(|v| (share(v) * 255.0) as u8).collect();
        let sdr: Vec<u8> = cut
            .iter()
            .map(|v| (rawshim::hdr_fit::srgb_oetf(share(v)) * 255.0) as u8)
            .collect();
        for (name, data) in [("pq", pq), ("linear", linear), ("sdr", sdr)] {
            let image = magnify(
                rawshim::rgb::Rgb {
                    width: side,
                    height: side,
                    data,
                },
                zoom,
            );
            let file = format!("{out}/{name}-{x}-{y}.jpg");
            let encoded = rawshim::jpeg::encode(image.as_ref(), 95).expect("encodes");
            std::fs::write(&file, encoded).expect("writes");
            eprintln!("    wrote {file}");
        }
    }
}

struct Stats {
    mean: f64,
    /// Median absolute three-tap Laplacian over 1.6521: grain, as the pipeline measures it.
    roughness: f64,
    /// The tail of the same distribution, which is where a hard speckle lives and a median
    /// cannot see: a few pixels a long way out read as artefact where the same energy spread
    /// over every pixel reads as grain.
    p99: f64,
    max: f64,
    /// Fraction of Laplacians past six times the median.
    outliers: f64,
    /// Fraction of samples at code zero, which is a channel the grade has clipped.
    zeros: f64,
}

fn channel_roughness(cut: &[u16], side: usize) -> [Stats; 3] {
    std::array::from_fn(|c| {
        let mut laps: Vec<f64> = Vec::with_capacity(side * (side - 2));
        for row in 0..side {
            for col in 0..side - 2 {
                let at = |i: usize| f64::from(cut[((row * side) + col + i) * 3 + c]);
                laps.push((at(0) - 2.0 * at(1) + at(2)).abs());
            }
        }
        laps.sort_unstable_by(f64::total_cmp);
        let median = laps[laps.len() / 2];
        let samples = cut.iter().skip(c).step_by(3);
        let count = (side * side) as f64;
        Stats {
            mean: samples.clone().map(|v| f64::from(*v)).sum::<f64>() / count,
            roughness: median / 1.6521,
            p99: laps[laps.len() * 99 / 100],
            max: laps[laps.len() - 1],
            outliers: laps.iter().filter(|l| **l > 6.0 * median).count() as f64 / laps.len() as f64,
            zeros: samples.filter(|v| **v == 0).count() as f64 / count,
        }
    })
}

fn magnify(image: rawshim::rgb::Rgb, by: usize) -> rawshim::rgb::Rgb {
    if by <= 1 {
        return image;
    }
    let (w, h) = (image.width, image.height);
    let mut out = vec![0u8; w * by * h * by * 3];
    for y in 0..h * by {
        for x in 0..w * by {
            let from = ((y / by) * w + x / by) * 3;
            out[(y * w * by + x) * 3..][..3].copy_from_slice(&image.data[from..from + 3]);
        }
    }
    rawshim::rgb::Rgb {
        width: w * by,
        height: h * by,
        data: out,
    }
}
