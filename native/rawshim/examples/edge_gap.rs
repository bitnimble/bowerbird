//! The chroma gap between a stitched pair's panels against distance from the shadow's
//! edge, averaged along the edge.
//!
//! ```text
//! edge_gap <stitched.ppm> [x0 x1]
//! ```
//!
//! Each column finds its terminator as the camera panel's steepest luma drop; the red
//! and blue chroma-per-luma gaps are then binned by offset from it, five pixels a bin,
//! for the left, middle and right thirds of the columns and for all of them.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (path, x0, x1) = match &args[..] {
        [path] => (path, 0usize, usize::MAX),
        [path, x0, x1] => (path, x0.parse().unwrap(), x1.parse().unwrap()),
        _ => panic!("edge_gap <stitched.ppm> [x0 x1]"),
    };
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
    let (width, height, data) = (dims[0], dims[1], &bytes[at..]);
    let panel = (width - 8) / 2;
    let x1 = x1.min(panel);
    let px = |x: usize, y: usize, ours: bool| -> [f64; 3] {
        let i = (y * width + x + if ours { panel + 8 } else { 0 }) * 3;
        [f64::from(data[i]), f64::from(data[i + 1]), f64::from(data[i + 2])]
    };
    let luma = |v: &[f64; 3]| 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];

    const REACH: isize = 50;
    const BIN: isize = 5;
    let bins = (2 * REACH / BIN + 1) as usize;
    // [segment][bin] -> (cam rgb, ours rgb, n)
    let mut acc = vec![vec![([0.0f64; 3], [0.0f64; 3], 0.0f64); bins]; 4];
    let mut columns = 0usize;
    // Each panel is binned against its own edge, so a panel sitting a few pixels off
    // the other compares colour for colour rather than edge against not-yet-edge;
    // the offset between the two edges is reported per segment.
    let mut shifts = vec![(0.0f64, 0.0f64); 4];
    let edge = |x: usize, ours: bool| -> Option<isize> {
        let column: Vec<f64> = (0..height).map(|y| luma(&px(x, y, ours))).collect();
        let smooth = |y: isize| -> f64 {
            let y = y.clamp(3, height as isize - 4) as usize;
            column[y - 3..=y + 3].iter().sum::<f64>() / 7.0
        };
        let mut best = (0.0f64, 0isize);
        for y in 40..height as isize - 40 {
            let drop = smooth(y - 8) - smooth(y + 8);
            if drop > best.0 {
                best = (drop, y);
            }
        }
        (best.0 >= 30.0).then_some(best.1)
    };
    for x in (x0..x1).step_by(2) {
        let (Some(cam_edge), Some(our_edge)) = (edge(x, false), edge(x, true)) else {
            continue;
        };
        if (cam_edge - our_edge).abs() > 12 {
            continue;
        }
        columns += 1;
        let segment = (x - x0) * 3 / (x1 - x0).max(1);
        for s in [segment, 3] {
            shifts[s].0 += (our_edge - cam_edge) as f64;
            shifts[s].1 += 1.0;
        }
        for dy in -REACH..=REACH {
            let (yc, yo) = (cam_edge + dy, our_edge + dy);
            if yc < 0 || yo < 0 || yc >= height as isize || yo >= height as isize {
                continue;
            }
            let bin = ((dy + REACH) / BIN) as usize;
            let (cam, ours) = (px(x, yc as usize, false), px(x, yo as usize, true));
            for s in [segment, 3] {
                let slot = &mut acc[s][bin];
                for c in 0..3 {
                    slot.0[c] += cam[c];
                    slot.1[c] += ours[c];
                }
                slot.2 += 1.0;
            }
        }
    }
    eprintln!("{columns} columns with an edge in both panels");
    for (s, name) in ["left", "middle", "right", "all"].iter().enumerate() {
        let (sum, n) = shifts[s];
        eprintln!("{name}: our edge sits {:+.1}px from the camera's", sum / n.max(1.0));
    }
    for (s, name) in ["left", "middle", "right", "all"].iter().enumerate() {
        println!("== {name}");
        for (b, (cam, ours, n)) in acc[s].iter().enumerate() {
            if *n == 0.0 {
                continue;
            }
            let cam = cam.map(|v| v / n);
            let ours = ours.map(|v| v / n);
            let (lc, lo) = (luma(&cam).max(1.0), luma(&ours).max(1.0));
            println!(
                "off {:+4} dr {:+.3} db {:+.3}  cam {:3.0},{:3.0},{:3.0} ours {:3.0},{:3.0},{:3.0}",
                b as isize * BIN - REACH,
                ours[0] / lo - cam[0] / lc,
                ours[2] / lo - cam[2] / lc,
                cam[0], cam[1], cam[2], ours[0], ours[1], ours[2],
            );
        }
    }
}
