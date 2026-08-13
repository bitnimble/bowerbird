//! LibRaw against rawler + RCD, pixel by pixel, on the graded output.
//!
//! ```text
//! compare_decoders <out-dir> <raw>...
//! ```
//!
//! Reports the difference distribution - mean, 99.9th percentile, max, all in 8-bit counts - and
//! writes three pictures per photograph so the number can be checked against what it describes: the
//! same 1:1 crop from each path, and the difference between them amplified until it is visible.
//!
//! Two things make the comparison mean what it says.
//!
//! **Each path is graded through its own camera match, as the product grades it.** Sharing one
//! match sounds like the way to isolate the demosaic and is not: the two decoders disagree on the
//! frame's absolute scale by about a third, the match is what absorbs that, and lending LibRaw's to
//! rawler's frame shifts its exposure and buries the demosaic under a uniform offset several times
//! larger. Measured that way the mean difference is 6.4 counts, and almost none of it is the
//! demosaic.
//!
//! **The frames are aligned before they are subtracted.** rawler follows the manufacturer's
//! recommended crop and LibRaw does not, so the two disagree on the frame's origin by up to a dozen
//! pixels. Subtracting without searching for that offset measures the misalignment, which is a much
//! larger number than anything the demosaic does, and looks exactly like a catastrophic result.

use rawshim::hdr::{self, Grade, Source};
use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::image::Strengths;

/// Side of the 1:1 crop the difference is measured and shown over.
const CROP: usize = 512;

/// How far the search will look for the offset between the two frames' origins, each way.
const SEARCH: isize = 24;

/// The difference is a handful of counts where it is anything at all, so it is scaled until the
/// structure of it is legible. A delta picture is read for its shape - comb, halo, or uniform -
/// and at 1:1 none of those are visible.
const AMPLIFY: f64 = 16.0;

fn grade() -> Grade {
    Grade { peak_nits: 1000.0, reference_white_nits: 203.0, white_quantile: 0.995 }
}

fn options() -> EncodeOptions {
    EncodeOptions {
        still_chroma: Chroma::Yuv444,
        output_path: String::new(),
        grade: grade(),
        crf: 26,
        preset: 6,
        strengths: Strengths { sharpen: 1.0, defringe: 1.0 },
        // No reduction: the crop is taken at 1:1 and a resize would hide exactly the differences
        // this harness exists to measure.
        max_edge: 100_000.0,
    }
}

struct Rendered {
    data: Vec<u8>,
    width: usize,
    height: usize,
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(out) = args.next() else {
        eprintln!("compare_decoders <out-dir> <raw>...");
        return;
    };
    if rawshim::decode_rawler::wanted() {
        eprintln!("unset BOWERBIRD_DECODER: this renders both paths itself, and the switch would make them the same one");
        return;
    }
    std::fs::create_dir_all(&out).expect("the output directory");

    println!(
        "{:>16}  {:>13}  {:>13}  {:>7}  {:>7}  {:>7}  {:>6}  {:>7}  {:>14}  {:>14}",
        "file", "libraw", "rawler", "offset", "mean", "bias", "p99.9", "max", "quiet tiles", "busy tiles"
    );

    for path in args {
        let name = std::path::Path::new(&path)
            .file_stem()
            .map_or_else(|| path.clone(), |s| s.to_string_lossy().into_owned());

        let Some(reference) = rawshim::decode_frame_denoised(&path, 16, true, 0, Default::default()) else {
            println!("{name:>16}  libraw declined");
            continue;
        };
        let Some(ours) = rawshim::decode_rawler::decode(&path, Default::default()) else {
            println!("{name:>16}  rawler declined");
            continue;
        };

        let fit = |frame: &rawshim::frame::Frame| {
            rawshim::fit_hdr_for(frame, &path, grade().white_quantile, None, Strengths { sharpen: 1.0, defringe: 1.0 })
        };
        let (theirs, mine) = (fit(&reference), fit(&ours));

        let (Some(left), Some(right)) = (render(&reference, theirs.as_ref()), render(&ours, mine.as_ref())) else {
            println!("{name:>16}  not a 16-bit decode");
            continue;
        };

        let Some((dx, dy)) = align(&left, &right) else {
            println!("{name:>16}  no overlap to compare");
            continue;
        };

        let (lx, ly) = worst_region(&left, &right, dx, dy);
        let l = crop(&left, lx, ly);
        let r = crop(&right, lx + dx, ly + dy);

        let stats = difference(&l, &r);
        write(&format!("{out}/{name}-libraw.avif"), &l);
        write(&format!("{out}/{name}-rawler.avif"), &r);
        write(&format!("{out}/{name}-delta.avif"), &delta_picture(&l, &r));

        let (quiet_l, busy_l) = roughness_split(&l);
        let (quiet_r, busy_r) = roughness_split(&r);
        println!(
            "{name:>16}  {:>5}x{:<7}  {:>5}x{:<7}  {:>3},{:<3}  {:>7.3}  {:>7.2}  {:>6.0}  {:>7.0}  {:>6.2}{:>+7.1}%  {:>6.2}{:>+7.1}%",
            left.width,
            left.height,
            right.width,
            right.height,
            dx,
            dy,
            stats.mean,
            stats.bias,
            stats.p999,
            stats.max,
            quiet_l,
            (quiet_r - quiet_l) / quiet_l * 100.0,
            busy_l,
            (busy_r - busy_l) / busy_l * 100.0,
        );
    }
}

fn render(frame: &rawshim::frame::Frame, matched: Option<&rawshim::hdr_fit::HdrMatch>) -> Option<Rendered> {
    let source = Source { samples: frame.samples16()?, width: frame.width, height: frame.height };
    let (rgb, width, height) = hdr::graded_as(&source, &options(), matched, rawshim::gpu::Output::Srgb);
    Some(Rendered { data: rgb.iter().map(|v| *v as u8).collect(), width, height })
}

/// The offset that best lines the two frames up, searched over a small window.
///
/// Coarse then fine: a full search of the window at every pixel of a 512-square patch is a couple
/// of billion operations, and stepping by four first cuts that to a fortieth without being able to
/// miss the basin, which is many pixels wide for any real photograph.
fn align(left: &Rendered, right: &Rendered) -> Option<(isize, isize)> {
    let (lx, ly) = (left.width.checked_sub(CROP)? / 2, left.height.checked_sub(CROP)? / 2);
    let patch = crop(left, lx as isize, ly as isize);

    let score = |dx: isize, dy: isize| -> f64 {
        let against = crop(right, lx as isize + dx, ly as isize + dy);
        difference(&patch, &against).mean
    };

    let mut best = (0isize, 0isize, f64::MAX);
    let mut coarse = -SEARCH;
    while coarse <= SEARCH {
        let mut dy = -SEARCH;
        while dy <= SEARCH {
            let mean = score(coarse, dy);
            if mean < best.2 {
                best = (coarse, dy, mean);
            }
            dy += 4;
        }
        coarse += 4;
    }

    for dx in (best.0 - 3)..=(best.0 + 3) {
        for dy in (best.1 - 3)..=(best.1 + 3) {
            let mean = score(dx, dy);
            if mean < best.2 {
                best = (dx, dy, mean);
            }
        }
    }
    Some((best.0, best.1))
}

/// Where in the frame the two disagree most, as the top-left of a `CROP` square.
///
/// The whole frame is searched rather than the centre taken, because the centre is wherever the
/// photographer pointed and has no reason to be where a demosaic struggles. Overlapping windows so
/// a region straddling a boundary is not missed by both of its neighbours.
fn worst_region(left: &Rendered, right: &Rendered, dx: isize, dy: isize) -> (isize, isize) {
    let step = CROP / 2;
    let mut best = (0isize, 0isize, -1.0);
    let mut y = 0;
    while y + CROP <= left.height {
        let mut x = 0;
        while x + CROP <= left.width {
            let mean = difference(&crop(left, x as isize, y as isize), &crop(right, x as isize + dx, y as isize + dy)).mean;
            if mean > best.2 {
                best = (x as isize, y as isize, mean);
            }
            x += step;
        }
        y += step;
    }
    (best.0, best.1)
}

fn crop(image: &Rendered, x: isize, y: isize) -> Rendered {
    let mut data = vec![0u8; CROP * CROP * 3];
    for row in 0..CROP {
        let from_y = y + row as isize;
        if from_y < 0 || from_y as usize >= image.height {
            continue;
        }
        for col in 0..CROP {
            let from_x = x + col as isize;
            if from_x < 0 || from_x as usize >= image.width {
                continue;
            }
            let from = ((from_y as usize) * image.width + from_x as usize) * 3;
            let to = (row * CROP + col) * 3;
            data[to..to + 3].copy_from_slice(&image.data[from..from + 3]);
        }
    }
    Rendered { data, width: CROP, height: CROP }
}

struct Stats {
    mean: f64,
    p999: f64,
    max: f64,
    /// Mean *signed* difference. Separates the two ways a mean can be large: a uniform shift, where
    /// this equals it, and structure that cancels, where this sits near zero however big the mean.
    bias: f64,
}

/// Per-channel absolute difference in 8-bit counts, which is the unit the agreed thresholds are in.
fn difference(left: &Rendered, right: &Rendered) -> Stats {
    let mut histogram = [0u64; 256];
    let mut total = 0f64;
    let mut signed = 0f64;
    for (a, b) in left.data.iter().zip(&right.data) {
        let d = a.abs_diff(*b);
        histogram[d as usize] += 1;
        total += f64::from(d);
        signed += f64::from(*b) - f64::from(*a);
    }
    let count: u64 = histogram.iter().sum();
    if count == 0 {
        return Stats { mean: 0.0, p999: 0.0, max: 0.0, bias: 0.0 };
    }

    let cutoff = (count as f64 * 0.999) as u64;
    let mut seen = 0u64;
    let mut p999 = 0f64;
    let mut max = 0f64;
    for (value, hits) in histogram.iter().enumerate() {
        if *hits == 0 {
            continue;
        }
        seen += hits;
        if p999 == 0.0 && seen >= cutoff {
            p999 = value as f64;
        }
        max = value as f64;
    }
    Stats { mean: total / count as f64, p999, max, bias: signed / count as f64 }
}

/// Luma roughness split by what the neighbourhood is doing, which is the whole argument about
/// whether one demosaic is softer than another or merely quieter.
///
/// A single roughness figure cannot tell those apart: noise removed and detail removed both lower
/// it. Splitting the tiles into the quietest tenth and the busiest tenth can. Detail lost shows as
/// the busy tiles falling; noise removed shows as the quiet tiles falling and the busy ones holding.
fn roughness_split(image: &Rendered) -> (f64, f64) {
    const TILE: usize = 16;
    let luma = |x: usize, y: usize| -> f64 {
        let at = (y * image.width + x) * 3;
        0.2126 * f64::from(image.data[at]) + 0.7152 * f64::from(image.data[at + 1]) + 0.0722 * f64::from(image.data[at + 2])
    };

    let mut tiles = Vec::new();
    for ty in 0..(image.height / TILE) {
        for tx in 0..(image.width / TILE) {
            let (mut total, mut count) = (0.0, 0u32);
            for y in (ty * TILE + 1)..((ty + 1) * TILE - 1) {
                for x in (tx * TILE + 1)..((tx + 1) * TILE - 1) {
                    let ring = luma(x - 1, y) + luma(x + 1, y) + luma(x, y - 1) + luma(x, y + 1);
                    total += (4.0 * luma(x, y) - ring).abs();
                    count += 1;
                }
            }
            tiles.push(total / f64::from(count.max(1)));
        }
    }
    tiles.sort_by(|a, b| a.partial_cmp(b).expect("no NaN in a roughness"));

    let tenth = (tiles.len() / 10).max(1);
    let mean = |slice: &[f64]| slice.iter().sum::<f64>() / slice.len() as f64;
    (mean(&tiles[..tenth]), mean(&tiles[tiles.len() - tenth..]))
}

fn delta_picture(left: &Rendered, right: &Rendered) -> Rendered {
    let data = left
        .data
        .iter()
        .zip(&right.data)
        .map(|(a, b)| ((f64::from(a.abs_diff(*b)) * AMPLIFY).min(255.0)) as u8)
        .collect();
    Rendered { data, width: left.width, height: left.height }
}

fn write(path: &str, image: &Rendered) {
    rawshim::avif::encode_rendition(std::borrow::Cow::Borrowed(&image.data), image.width, image.height, 4, 10, true, path)
        .expect("the record encodes");
}
