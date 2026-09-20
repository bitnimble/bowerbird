//! What the sensor recorded where a frame is brightest, and how much of it saturated.
//!
//! ```text
//! photosites <raw> [x,y,w,h]
//! ```
//!
//! For the question a render cannot answer: whether a highlight that came out white had its
//! colour thrown away or never had one. A photosite at the white level says only "at least this
//! bright", so a site whose four are all there is a pixel `assemble.slang` renders neutral, and
//! one with a channel still reading is a colour the decode has to keep.
//!
//! Coordinates are the sensor's own. With no rect it reports the brightest block, which on a frame
//! with one blown subject is that subject.

use rawler::RawImageData;
use rawler::decoders::RawDecodeParams;
use rawler::rawsource::RawSource;

const BLOCK: usize = 32;

fn main() {
    let path = std::env::args().nth(1).expect("a raw path");
    let asked: Option<Vec<usize>> = std::env::args()
        .nth(2)
        .map(|v| v.split(',').map(|n| n.parse().expect("a number")).collect());

    let source = RawSource::new(std::path::Path::new(&path)).expect("the file");
    let decoder = rawler::get_decoder(&source).expect("a decoder");
    let params = RawDecodeParams::default();
    let image = decoder.raw_image(&source, &params, false).expect("a raw image");
    let (width, height) = (image.width, image.height);
    let RawImageData::Integer(samples) = &image.data else {
        panic!("a float raw");
    };

    let white = rawshim::decode_rawler::saturation_of(&image);
    let stated = image.whitelevel.0.iter().copied().max().unwrap_or(0);
    let black: Vec<f32> = image.blacklevel.levels.iter().map(|v| v.as_f32()).collect();
    let ceiling = rawshim::decode_rawler::channel_ceilings(&image);
    println!("{width}x{height}  make {}", image.clean_make);
    println!("white level stated {stated}, used {white}");
    println!("black {black:?}");
    println!("wb {:?}", &image.wb_coeffs[..3]);
    println!(
        "ceilings R {:.4}  G {:.4}  B {:.4}; a neutral clips at {:.4}",
        ceiling[0],
        ceiling[1],
        ceiling[2],
        ceiling.iter().copied().fold(f32::INFINITY, f32::min),
    );

    let crop = image
        .crop_area
        .map(|a| (a.p.x, a.p.y, a.d.w, a.d.h))
        .unwrap_or((0, 0, width, height));

    // Whole frame, by colour and then by site: a channel at the white level has lost its level but
    // not the pixel's colour, where a site whose every photosite is there has lost the colour too.
    let mut sites = [0u64; 4];
    let mut blown = [0u64; 4];
    let mut whole_sites = 0u64;
    let mut whole_blown = 0u64;
    for sy in crop.1..crop.1 + crop.3 {
        for sx in crop.0..crop.0 + crop.2 {
            let colour = image.camera.cfa.color_at(sy, sx).min(3);
            let at = f32::from(samples[sy * width + sx]) >= white;
            sites[colour] += 1;
            if at {
                blown[colour] += 1;
            }
            if sy % 2 == 0 && sx % 2 == 0 && sy + 1 < height && sx + 1 < width {
                whole_sites += 1;
                let full = |dy: usize, dx: usize| {
                    f32::from(samples[(sy + dy) * width + sx + dx]) >= white
                };
                if full(0, 0) && full(0, 1) && full(1, 0) && full(1, 1) {
                    whole_blown += 1;
                }
            }
        }
    }
    println!("\nwhole frame");
    for colour in 0..4 {
        if sites[colour] == 0 {
            continue;
        }
        let name = ["R", "G", "B", "G2"][colour];
        println!(
            "{name:>7} {:>9.3}% saturated",
            100.0 * blown[colour] as f64 / sites[colour] as f64
        );
    }
    println!(
        "{:>7} {:>9.3}% of 2x2 sites saturated in every photosite, which is a colour nothing recovers",
        "all",
        100.0 * whole_blown as f64 / whole_sites.max(1) as f64,
    );

    let (x, y, w, h) = match asked {
        Some(r) => (r[0], r[1], r[2], r[3]),
        None => {
            let mut best = (0usize, 0usize, 0u64);
            let mut at = crop.1;
            while at + BLOCK <= crop.1 + crop.3 {
                let mut across = crop.0;
                while across + BLOCK <= crop.0 + crop.2 {
                    let mut sum = 0u64;
                    for row in 0..BLOCK {
                        let from = (at + row) * width + across;
                        sum += samples[from..from + BLOCK].iter().map(|v| u64::from(*v)).sum::<u64>();
                    }
                    if sum > best.2 {
                        best = (across, at, sum);
                    }
                    across += BLOCK;
                }
                at += BLOCK;
            }
            println!("\nbrightest {BLOCK}x{BLOCK} block at {},{}", best.0, best.1);
            (best.0, best.1, BLOCK, BLOCK)
        }
    };

    let mut counts = [0usize; 4];
    let mut saturated = [0usize; 4];
    let mut top = [0u16; 4];
    let mut sum = [0f64; 4];
    let mut below_black = [0usize; 4];
    for row in 0..h {
        for column in 0..w {
            let (sx, sy) = (x + column, y + row);
            let colour = image.camera.cfa.color_at(sy, sx).min(3);
            let value = samples[sy * width + sx];
            counts[colour] += 1;
            sum[colour] += f64::from(value);
            top[colour] = top[colour].max(value);
            if f32::from(value) >= white {
                saturated[colour] += 1;
            }
            if f32::from(value) <= black.get(colour).copied().unwrap_or(0.0) {
                below_black[colour] += 1;
            }
        }
    }

    println!("region {x},{y} {w}x{h}");
    println!(
        "{:>7} {:>7} {:>7} {:>9} {:>11} {:>11}",
        "colour", "sites", "max", "mean", "saturated", "below black",
    );
    for colour in 0..4 {
        if counts[colour] == 0 {
            continue;
        }
        let name = ["R", "G", "B", "G2"][colour];
        println!(
            "{name:>7} {:>7} {:>7} {:>9.0} {:>10.1}% {:>10.1}%",
            counts[colour],
            top[colour],
            sum[colour] / counts[colour] as f64,
            100.0 * saturated[colour] as f64 / counts[colour] as f64,
            100.0 * below_black[colour] as f64 / counts[colour] as f64,
        );
    }

    // The region as one colour, conditioned: the mean photosite of each, black subtracted, clipped
    // at saturation and gained, which is what the demosaic hands the reconstruction.
    let conditioned = |colour: usize| {
        let floor = black.get(colour).copied().unwrap_or(0.0);
        let filled =
            ((sum[colour] as f32 / counts[colour].max(1) as f32 - floor) / (white - floor)).min(1.0);
        filled * ceiling[colour.min(2)]
    };
    let mean = [conditioned(0), conditioned(1), conditioned(2)];
    println!(
        "mean conditioned {:>6.3} {:>6.3} {:>6.3}   against ceilings {:>6.3} {:>6.3} {:>6.3}",
        mean[0], mean[1], mean[2], ceiling[0], ceiling[1], ceiling[2],
    );
}
