//! How far reconstructed highlights land from the light that clipped, in numbers.
//!
//! ```text
//! highlight_bench [--stops 1,2,3] [--margin 16] [--recovery 0-100] [--crops <dir>] <raw>...
//! ```
//!
//! `--crops` writes each file's and stop's [`CROP`] square at a highlight's edge as snapshot PNGs,
//! `<dir>/truth/` and `<dir>/test/`, for `snapshot_diff --before <dir>/truth --after <dir>/test`.
//!
//! Lowers each RAW's ceilings by `stops`, clips its conditioned mosaic there, reconstructs it through
//! the shipped demosaic and scores every pixel the reconstruction can touch against the same mosaic
//! demosaiced under ceilings nothing reaches. Pixels within `margin` photosites of one the file
//! itself clipped are left out: their truth is a reconstruction too.
//!
//! Errors are ZCAM's (`colour::lattice::opponent_of`), with the clipped frame's neutral ceiling at
//! diffuse white: `dC` is the distance in the chroma plane alone, the wrong colour; `dE` adds
//! lightness; `dJ` is signed, positive brighter than the truth. Rows split pixels by how many
//! colours their 3x3 holds a clipped photosite of; `near` is none, but a colour's mean at least
//! [`NEAR_CLIP`] of its ceiling. Means hide a tail, so p95 sits beside each. `all` averages the
//! files' rows, so a 61MP frame counts once.

use colour::lattice::opponent_of;
use units::light::{Light, Rendered};

const CLIPPED_AT: f32 = 0.995;
const NEAR_CLIP: f32 = 0.75;
const CLASSES: [&str; 4] = ["near", "1", "2", "3"];
const UNTOUCHED: u8 = 255;
const UNSCORED: u8 = 254;
const CROP: usize = 192;
const UNREACHED_CEILING: f32 = 16.0;
const CROP_PEAK_OVER_WHITE: f64 = 64.0;

#[derive(Default)]
struct Scores {
    dc: Vec<f32>,
    de: Vec<f32>,
    dj: Vec<f32>,
}

/// What a row prints: pixels, then `dC`, its p95, `dE`, its p95 and `dJ`.
#[derive(Clone, Copy, Default)]
struct Summary {
    pixels: usize,
    errors: [f64; 5],
}

impl Summary {
    fn of(scores: &Scores) -> Summary {
        if scores.dc.is_empty() {
            return Summary::default();
        }
        Summary {
            pixels: scores.dc.len(),
            errors: [
                mean(&scores.dc),
                p95(&scores.dc),
                mean(&scores.de),
                p95(&scores.de),
                mean(&scores.dj),
            ],
        }
    }

    /// Each file counted once, whatever its pixel count.
    fn across(files: &[Summary]) -> Summary {
        let seen: Vec<&Summary> = files.iter().filter(|s| s.pixels > 0).collect();
        if seen.is_empty() {
            return Summary::default();
        }
        Summary {
            pixels: seen.iter().map(|s| s.pixels).sum(),
            errors: std::array::from_fn(|k| {
                seen.iter().map(|s| s.errors[k]).sum::<f64>() / seen.len() as f64
            }),
        }
    }
}

fn main() {
    let mut stops: Vec<f64> = vec![1.0, 2.0, 3.0];
    let mut margin = 16usize;
    let mut detail = denoise::galosh::Detail::AUTO;
    let mut crops: Option<std::path::PathBuf> = None;
    let mut files: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--stops" => {
                stops = args
                    .next()
                    .expect("stops")
                    .split(',')
                    .map(|s| s.trim().parse().expect("a number of stops"))
                    .collect();
            }
            "--margin" => margin = args.next().expect("photosites").parse().expect("a number"),
            "--recovery" => {
                detail.highlight_recovery =
                    Some(args.next().expect("0 to 100").parse().expect("a number"));
            }
            "--crops" => crops = Some(std::path::PathBuf::from(args.next().expect("a directory"))),
            _ => files.push(arg),
        }
    }
    if files.is_empty() {
        eprintln!(
            "highlight_bench [--stops 1,2,3] [--margin 16] [--recovery 0-100] [--crops <dir>] <raw>..."
        );
        std::process::exit(2);
    }
    let gpu = gpu::device().expect("a GPU adapter");

    println!(
        "{:>16} {:>5} {:>5} {:>10} {:>8} {:>8} {:>8} {:>8} {:>8}",
        "file", "stops", "clip", "pixels", "dC", "dC p95", "dE", "dE p95", "dJ"
    );
    let mut summaries: Vec<[Vec<Summary>; 4]> = stops.iter().map(|_| Default::default()).collect();
    for path in &files {
        let Some(scored) = bench(gpu, path, &stops, margin, detail, crops.as_deref()) else {
            eprintln!("{path}: did not open");
            continue;
        };
        let name = std::path::Path::new(path)
            .file_stem()
            .map_or_else(|| path.clone(), |s| s.to_string_lossy().into_owned());
        for ((stop, classes), into) in stops.iter().zip(&scored).zip(&mut summaries) {
            for (class, (scores, into)) in classes.iter().zip(into.iter_mut()).enumerate() {
                let summary = Summary::of(scores);
                print_row(&name, *stop, class, summary);
                into.push(summary);
            }
        }
    }
    if files.len() > 1 {
        for (stop, classes) in stops.iter().zip(&summaries) {
            for (class, files) in classes.iter().enumerate() {
                print_row("all", *stop, class, Summary::across(files));
            }
        }
    }
}

fn print_row(name: &str, stop: f64, class: usize, summary: Summary) {
    if summary.pixels == 0 {
        println!("{name:>16} {stop:>5} {:>5} {:>10}", CLASSES[class], 0);
        return;
    }
    let [dc, dc_p95, de, de_p95, dj] = summary.errors;
    println!(
        "{name:>16} {stop:>5} {:>5} {:>10} {dc:>8.2} {dc_p95:>8.2} {de:>8.2} {de_p95:>8.2} {dj:>+8.2}",
        CLASSES[class], summary.pixels,
    );
}

/// Each stop's scores by class.
fn bench(
    gpu: &'static gpu::Gpu,
    path: &str,
    stops: &[f64],
    margin: usize,
    detail: denoise::galosh::Detail,
    crops: Option<&std::path::Path>,
) -> Option<Vec<[Scores; 4]>> {
    let stem = std::path::Path::new(path).file_stem()?.to_string_lossy();
    let bytes = std::fs::read(path).ok()?;
    let held = pollster::block_on(decode::raw::hold_bytes(&bytes))?;
    let matrix = decode::raw::camera_to_rec2020_at(path)?;
    let cfa = held.cfa();
    let ceiling = held.ceilings();
    let crop = held.crop();
    let whole = held.device_mosaic();
    let (width, height) = (whole.width, whole.height);
    let values = pollster::block_on(whole.read(gpu))?;
    let colour_at = |at: usize| usize::from(cfa.colour_at(at / width, at % width));

    let unreached = mosaic::demosaic::Colour {
        matrix,
        ceiling: ceiling.map(|c| c * UNREACHED_CEILING),
    };
    let truth = reconstruct(gpu, &values, (width, height), &cfa, unreached, detail)?;

    let clipped_by_file: Vec<bool> = (0..values.len())
        .map(|at| values[at] >= CLIPPED_AT * ceiling[colour_at(at)])
        .collect();
    let excluded = dilated(&clipped_by_file, width, height, margin);
    let scored = |x: usize, y: usize| {
        x >= crop.0 + margin
            && y >= crop.1 + margin
            && x + margin < crop.0 + crop.2
            && y + margin < crop.1 + crop.3
            && !excluded[y * width + x]
    };

    let mut out = Vec::with_capacity(stops.len());
    for &stop in stops {
        let lowered = ceiling.map(|c| (f64::from(c) / stop.exp2()) as f32);
        let clipped: Vec<f32> = (0..values.len())
            .map(|at| values[at].min(lowered[colour_at(at)]))
            .collect();
        let colour = mosaic::demosaic::Colour {
            matrix,
            ceiling: lowered,
        };
        let test = reconstruct(gpu, &clipped, (width, height), &cfa, colour, detail)?;
        let neutral_ceiling = f64::from(lowered.iter().copied().fold(f32::INFINITY, f32::min));
        let to_rendered = 1.0 / neutral_ceiling;
        let mut classes: [Scores; 4] = Default::default();
        let mut map = vec![UNSCORED; width * height];
        for y in 1..height - 1 {
            for x in 1..width - 1 {
                if !scored(x, y) {
                    continue;
                }
                let Some(class) = class_of(&clipped, width, x, y, &lowered, colour_at) else {
                    map[y * width + x] = UNTOUCHED;
                    continue;
                };
                map[y * width + x] = class as u8;
                let at = (y * width + x) * 3;
                let want = opponent(&truth[at..at + 3], to_rendered);
                let got = opponent(&test[at..at + 3], to_rendered);
                let (dj, da, db) = (got[0] - want[0], got[1] - want[1], got[2] - want[2]);
                let scores = &mut classes[class];
                scores.dc.push(da.hypot(db) as f32);
                scores.de.push((dj * dj + da * da + db * db).sqrt() as f32);
                scores.dj.push(dj as f32);
            }
        }
        if let Some(dir) = crops
            && let Some(at) = window_of(&map, width, height)
        {
            let white = neutral_ceiling * f64::from(u16::MAX);
            let name = format!("{stem}-{stop}.png");
            eprintln!("{name}: crop at {},{}", at.0, at.1);
            for (into, frame) in [("truth", &truth), ("test", &test)] {
                let into = dir.join(into);
                std::fs::create_dir_all(&into).expect("the crops directory");
                let snapshot = crop_of(gpu, frame, width, at, white);
                std::fs::write(into.join(&name), snapshot.encode()).expect("the crop writes");
            }
        }
        out.push(classes);
    }
    Some(out)
}

/// The [`CROP`] window whose clipped and untouched pixels are most evenly matched, the edge of a
/// highlight where its colour comes from; None where no window holds both.
fn window_of(map: &[u8], width: usize, height: usize) -> Option<(usize, usize)> {
    let half = CROP / 2;
    let (across, down) = (width / half, height / half);
    let mut clipped = vec![0u32; across * down];
    let mut clear = vec![0u32; across * down];
    for y in 0..down * half {
        for x in 0..across * half {
            let block = (y / half) * across + x / half;
            match map[y * width + x] {
                2 | 3 => clipped[block] += 1,
                UNTOUCHED => clear[block] += 1,
                _ => {}
            }
        }
    }
    let mut best: Option<(u32, (usize, usize))> = None;
    for by in 0..down.saturating_sub(1) {
        for bx in 0..across.saturating_sub(1) {
            let quad = |v: &[u32]| {
                v[by * across + bx]
                    + v[by * across + bx + 1]
                    + v[(by + 1) * across + bx]
                    + v[(by + 1) * across + bx + 1]
            };
            let score = quad(&clipped).min(quad(&clear));
            if best.is_none_or(|(most, _)| score > most) {
                best = Some((score, (bx * half, by * half)));
            }
        }
    }
    best.filter(|(score, _)| *score > 0).map(|(_, at)| at)
}

/// The [`CROP`] square at `at` of a demosaiced frame, coded with `white` (a level) at diffuse white.
fn crop_of(
    gpu: &'static gpu::Gpu,
    frame: &[u16],
    width: usize,
    (x, y): (usize, usize),
    white: f64,
) -> rawshim::snapshot::Snapshot {
    let mut cut = Vec::with_capacity(CROP * CROP * 3);
    for row in y..y + CROP {
        cut.extend_from_slice(&frame[(row * width + x) * 3..(row * width + x + CROP) * 3]);
    }
    let resident = colour::resident::Resident::upload(gpu, &cut, CROP, CROP);
    let levels = colour::tone::Levels {
        white: Light::measured(white),
        peak: Light::measured(white * CROP_PEAK_OVER_WHITE),
        floor: Some(Light::ZERO),
    };
    rawshim::snapshot::Snapshot::crops(
        rawshim::snapshot::Frame::Scene(
            &resident,
            rawshim::snapshot::Anchoring {
                levels: levels.anchored(),
                reference_white_nits: Light::exactly(203.0),
            },
        ),
        &[units::px::Rect::<units::px::Pinned>::exact(
            0, 0, CROP, CROP,
        )],
    )
}

/// The class of the pixel at `(x, y)`: how many colours its 3x3 holds a clipped photosite of, or
/// `near` (0); None where the reconstruction leaves it as read.
fn class_of(
    clipped: &[f32],
    width: usize,
    x: usize,
    y: usize,
    ceiling: &[f32; 3],
    colour_at: impl Fn(usize) -> usize,
) -> Option<usize> {
    let mut sums = [0f32; 3];
    let mut counts = [0f32; 3];
    let mut full = [false; 3];
    for sy in y - 1..=y + 1 {
        for sx in x - 1..=x + 1 {
            let at = sy * width + sx;
            let colour = colour_at(at);
            sums[colour] += clipped[at];
            counts[colour] += 1.0;
            full[colour] |= clipped[at] >= CLIPPED_AT * ceiling[colour];
        }
    }
    let many = full.iter().filter(|&&f| f).count();
    if many > 0 {
        return Some(many);
    }
    let near = (0..3).any(|c| counts[c] > 0.0 && sums[c] / counts[c] >= NEAR_CLIP * ceiling[c]);
    near.then_some(0)
}

/// A frame's Rec.2020 fractions of full scale as ZCAM's lightness and opponent chroma, `scale`
/// putting it in `Rendered`.
fn opponent(bits: &[u16], scale: f64) -> [f64; 3] {
    opponent_of(std::array::from_fn(|c| {
        Light::<Rendered>::measured(f64::from(half::f16::from_bits(bits[c]).to_f32()) * scale)
    }))
}

/// The shipped demosaic of `values` under `colour` at `detail`'s colouring, as half-float
/// Rec.2020.
fn reconstruct(
    gpu: &'static gpu::Gpu,
    values: &[f32],
    (width, height): (usize, usize),
    cfa: &mosaic::cfa::Cfa,
    colour: mosaic::demosaic::Colour,
    detail: denoise::galosh::Detail,
) -> Option<Vec<u16>> {
    let uploaded = mosaic::condition::Mosaic::upload(gpu, values, width, height);
    let built = pollster::block_on(decode::raw::demosaic_as_decoded(
        &uploaded, cfa, colour, detail, 1,
    ))?;
    pollster::block_on(built.into_host())
}

/// Every place within `radius` (a square) of a set one.
fn dilated(set: &[bool], width: usize, height: usize, radius: usize) -> Vec<bool> {
    let rows = spread(set, width, height, radius, (1, width));
    spread(&rows, height, width, radius, (width, 1))
}

/// `set` spread `radius` along lines of `length` places, `(step, next)` apart within and between.
fn spread(
    set: &[bool],
    length: usize,
    lines: usize,
    radius: usize,
    (step, next): (usize, usize),
) -> Vec<bool> {
    let mut out = vec![false; set.len()];
    let mut prefix = vec![0u32; length + 1];
    for line in 0..lines {
        for i in 0..length {
            prefix[i + 1] = prefix[i] + u32::from(set[line * next + i * step]);
        }
        for i in 0..length {
            let (from, to) = (i.saturating_sub(radius), (i + radius + 1).min(length));
            out[line * next + i * step] = prefix[to] > prefix[from];
        }
    }
    out
}

fn mean(values: &[f32]) -> f64 {
    values.iter().map(|&v| f64::from(v)).sum::<f64>() / values.len() as f64
}

fn p95(values: &[f32]) -> f64 {
    let mut sorted = values.to_vec();
    let at = (sorted.len() * 95 / 100).min(sorted.len() - 1);
    let (_, value, _) = sorted.select_nth_unstable_by(at, f32::total_cmp);
    f64::from(*value)
}
