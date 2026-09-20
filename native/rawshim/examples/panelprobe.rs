//! Cell means of one window of a stitched pair, camera beside render, as numbers.
//!
//! ```text
//! panelprobe <stitched.ppm> <x0> <y0> <x1> <y1>
//! ```
//!
//! Coordinates are the panel's own; a 4x4 grid of cells over the window prints the
//! camera's mean RGB, ours, and the red and blue chroma-per-luma gap between them.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [path, x0, y0, x1, y1] = &args[..] else {
        panic!("panelprobe <stitched.ppm> <x0> <y0> <x1> <y1>")
    };
    let (x0, y0, x1, y1): (usize, usize, usize, usize) =
        (x0.parse().unwrap(), y0.parse().unwrap(), x1.parse().unwrap(), y1.parse().unwrap());
    let bytes = std::fs::read(path).unwrap();
    let mut cuts = 0usize;
    let mut at = 0usize;
    while cuts < 3 {
        if bytes[at] == b'\n' {
            cuts += 1;
        }
        at += 1;
    }
    let header = std::str::from_utf8(&bytes[..at]).unwrap();
    let dims: Vec<usize> =
        header.split_whitespace().skip(1).take(2).map(|v| v.parse().unwrap()).collect();
    let (width, data) = (dims[0], &bytes[at..]);
    let panel = (width - 8) / 2;

    for cy in 0..4 {
        for cx in 0..4 {
            let (wx0, wx1) = (x0 + (x1 - x0) * cx / 4, x0 + (x1 - x0) * (cx + 1) / 4);
            let (wy0, wy1) = (y0 + (y1 - y0) * cy / 4, y0 + (y1 - y0) * (cy + 1) / 4);
            let mut cam = [0.0f64; 3];
            let mut ours = [0.0f64; 3];
            let mut n = 0.0;
            for y in wy0..wy1 {
                for x in wx0..wx1 {
                    for c in 0..3 {
                        cam[c] += f64::from(data[(y * width + x) * 3 + c]);
                        ours[c] += f64::from(data[(y * width + panel + 8 + x) * 3 + c]);
                    }
                    n += 1.0;
                }
            }
            for c in 0..3 {
                cam[c] /= n;
                ours[c] /= n;
            }
            let l = |v: &[f64; 3]| 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
            let (lc, lo) = (l(&cam).max(1.0), l(&ours).max(1.0));
            println!(
                "cell {cx},{cy}: cam {:3.0},{:3.0},{:3.0}  ours {:3.0},{:3.0},{:3.0}  dr {:+.3} db {:+.3}",
                cam[0], cam[1], cam[2], ours[0], ours[1], ours[2],
                ours[0] / lo - cam[0] / lc,
                ours[2] / lo - cam[2] / lc,
            );
        }
    }
}
