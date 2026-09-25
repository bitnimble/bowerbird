//! Which offsets a body's pixel shift burst was taken at, read off the frames themselves.
//!
//! ```text
//! pixel_shift_probe <frame> <frame> <frame> <frame>
//! ```
//!
//! Every assignment of a one-photosite step to each frame after the first, scored by how far each
//! merged site's two greens disagree over a central window: where the offsets are right the two read
//! one scene point and differ by noise alone. Frames are placed by the shot the header names, so the
//! winner is what `pixel_shift::SHIFTS` has to say for the body.

const WINDOW: usize = 1024;

fn main() {
    let mut paths: Vec<String> = std::env::args().skip(1).collect();
    let at: Option<(usize, usize)> = (paths.len() == 5).then(|| {
        let spec = paths.pop().expect("a window");
        let (x, y) = spec.split_once(',').expect("x,y");
        (x.parse().expect("a column"), y.parse().expect("a row"))
    });
    assert_eq!(paths.len(), 4, "pixel_shift_probe wants the burst's four frames, then optionally x,y");
    let mut frames: Vec<(u32, rawler::RawImage)> = paths
        .iter()
        .map(|path| {
            let shot = rawshim::header::read_path(path).map_or(0, |header| header.sequence_index);
            (shot, rawler::decode_file(path).expect("decodes"))
        })
        .collect();
    frames.sort_by_key(|(shot, _)| *shot);
    println!("shots {:?}", frames.iter().map(|(shot, _)| *shot).collect::<Vec<_>>());

    let first = &frames[0].1;
    let (width, height) = (first.width, first.height);
    let (centre_x, centre_y) = at.unwrap_or((width / 2, height / 2));
    let top = centre_y.clamp(WINDOW / 2 + 2, height - WINDOW / 2 - 2) - WINDOW / 2 & !1;
    let left = centre_x.clamp(WINDOW / 2 + 2, width - WINDOW / 2 - 2) - WINDOW / 2 & !1;
    let samples: Vec<&[u16]> = frames
        .iter()
        .map(|(_, image)| match &image.data {
            rawler::RawImageData::Integer(samples) => samples.as_slice(),
            rawler::RawImageData::Float(_) => panic!("an integer mosaic"),
        })
        .collect();
    let cfa = &first.camera.cfa;

    let mut scored: Vec<((f64, f64), [(i32, i32); 4])> = candidates()
        .into_iter()
        .map(|shifts| (disagreement(&samples, cfa, width, top, left, &shifts), shifts))
        .collect();
    scored.sort_by(|a, b| a.0.1.total_cmp(&b.0.1));
    for ((p90, mean_square), shifts) in scored.iter().take(8) {
        println!("mean square {mean_square:.5}  p90 {p90:.4}  {shifts:?}");
    }
    let worst = scored.last().expect("a candidate");
    println!("worst: mean square {:.5}  p90 {:.4}", worst.0.1, worst.0.0);

    let reference = block_luma(samples[0], width, top, left);
    for (frame, frame_samples) in samples.iter().enumerate().skip(1) {
        let (dy, dx) = displacement(&reference, &block_luma(frame_samples, width, top, left));
        println!("frame {} sits ({dy:+.2}, {dx:+.2}) photosites from the first", frame + 1);
    }
    println!("current SHIFTS {:?}", rawshim::pixel_shift::SHIFTS);
}

/// Each 2x2 period of the window summed, which reads every filter once and so is a luma a shift
/// of any number of photosites can be compared through.
fn block_luma(samples: &[u16], width: usize, top: usize, left: usize) -> Vec<f64> {
    let side = WINDOW / 2;
    let mut out = Vec::with_capacity(side * side);
    for by in 0..side {
        for bx in 0..side {
            let (y, x) = (top + by * 2, left + bx * 2);
            let at = |r: usize, c: usize| f64::from(samples[r * width + c]);
            out.push(at(y, x) + at(y, x + 1) + at(y + 1, x) + at(y + 1, x + 1));
        }
    }
    out
}

/// Where `frame`'s content sits against `reference`'s, in photosites: the bilinear shift that leaves
/// the least squared difference, found in whole blocks over ten either way and then in eighths of a
/// block around the best of those.
fn displacement(reference: &[f64], frame: &[f64]) -> (f64, f64) {
    let side = WINDOW / 2;
    let margin = 12;
    let cost = |dy: f64, dx: f64| {
        let sample = |y: f64, x: f64| {
            let (y0, x0) = (y.floor() as usize, x.floor() as usize);
            let (fy, fx) = (y - y0 as f64, x - x0 as f64);
            let at = |r: usize, c: usize| frame[r * side + c];
            (at(y0, x0) * (1.0 - fx) + at(y0, x0 + 1) * fx) * (1.0 - fy)
                + (at(y0 + 1, x0) * (1.0 - fx) + at(y0 + 1, x0 + 1) * fx) * fy
        };
        let mut sum = 0.0;
        for y in margin..side - margin {
            for x in margin..side - margin {
                let d = reference[y * side + x] - sample(y as f64 + dy, x as f64 + dx);
                sum += d * d;
            }
        }
        sum
    };
    let mut coarse = (f64::INFINITY, 0.0, 0.0);
    for dy in -10..=10 {
        for dx in -10..=10 {
            let sum = cost(f64::from(dy), f64::from(dx));
            if sum < coarse.0 {
                coarse = (sum, f64::from(dy), f64::from(dx));
            }
        }
    }
    let mut fine = coarse;
    for qy in -8..=8 {
        for qx in -8..=8 {
            let (dy, dx) = (coarse.1 + f64::from(qy) / 8.0, coarse.2 + f64::from(qx) / 8.0);
            let sum = cost(dy, dx);
            if sum < fine.0 {
                fine = (sum, dy, dx);
            }
        }
    }
    (fine.1 * 2.0, fine.2 * 2.0)
}

/// The first frame where it is; the other three a photosite away, one at each of the three other
/// positions of the 2x2 period, each either way along each axis it moves on.
fn candidates() -> Vec<[(i32, i32); 4]> {
    let steps = |parity: (i32, i32)| -> Vec<(i32, i32)> {
        let along = |moves: i32| if moves == 1 { vec![-1, 1] } else { vec![0] };
        along(parity.0).into_iter().flat_map(|dy| along(parity.1).into_iter().map(move |dx| (dy, dx))).collect()
    };
    let parities = [(0, 1), (1, 0), (1, 1)];
    let orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let mut out = Vec::new();
    for order in orders {
        for a in steps(parities[order[0]]) {
            for b in steps(parities[order[1]]) {
                for c in steps(parities[order[2]]) {
                    out.push([(0, 0), a, b, c]);
                }
            }
        }
    }
    out
}

/// The 90th percentile and the mean square of `|G1 - G2| / (G1 + G2)` over the window's sites,
/// merged as `pixel_shift.slang` merges them. Noise adds the same to every candidate's mean square,
/// so that one still ranks a burst too noisy for the percentile to.
fn disagreement(
    samples: &[&[u16]],
    cfa: &rawler::CFA,
    width: usize,
    top: usize,
    left: usize,
    shifts: &[(i32, i32); 4],
) -> (f64, f64) {
    let mut ratios = Vec::with_capacity(WINDOW * WINDOW);
    for y in top..top + WINDOW {
        for x in left..left + WINDOW {
            let greens: Vec<f64> = shifts
                .iter()
                .enumerate()
                .filter_map(|(frame, (dy, dx))| {
                    let r = (y as i32 - dy) as usize;
                    let c = (x as i32 - dx) as usize;
                    (cfa.color_at(r, c) == 1).then(|| f64::from(samples[frame][r * width + c]))
                })
                .collect();
            if let [a, b] = greens[..] {
                ratios.push((a - b).abs() / (a + b).max(1.0));
            }
        }
    }
    if ratios.is_empty() {
        return (f64::INFINITY, f64::INFINITY);
    }
    let mean_square = ratios.iter().map(|r| r * r).sum::<f64>() / ratios.len() as f64;
    ratios.sort_by(f64::total_cmp);
    (ratios[ratios.len() * 9 / 10], mean_square)
}
