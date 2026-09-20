//! What the HDR grade does with the brightest thing in a photograph.
//!
//! ```text
//! headroom <raw> [out.avif]
//! ```
//!
//! **A number where `examples/renders` writes a picture.** This grades to PQ at 1000 nits and
//! reports what the brightest pixels of the scene became - their nits, their saturation, and how
//! much of the frame sits each stop over white - which is where a highlight losing its colour
//! shows up as a figure rather than as a frame nobody looked at.
//!
//! With an output path it writes the frame as a PQ AVIF, for looking at the picture as well.

use rawshim::gpu::Output;
use rawshim::hdr::{Grade, Source};
use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::image::Strengths;

const REFERENCE_NITS: rawshim::light::Light<rawshim::light::SceneNits> =
    rawshim::light::Light::exactly(203.0);
const QUANTILE: f64 = 0.9;

fn saturation(rgb: [f64; 3]) -> f64 {
    let top = rgb[0].max(rgb[1]).max(rgb[2]);
    let low = rgb[0].min(rgb[1]).min(rgb[2]);
    match top > 0.0 {
        true => (top - low) / top,
        false => 0.0,
    }
}

/// The PQ frame as something an SDR screen shows without lying about the hue.
///
/// **The reason this exists is that reading the AVIF back as an ordinary PNG does lie.** The file
/// holds PQ code values, and PQ spends most of its range on the bottom of the scale: a 44-nit green
/// beside a 929-nit blue codes 0.428 against 0.744, so a deep violet displayed as though the codes
/// were sRGB comes out a pale cyan. Every stage below undoes that - the transfer, the tone map and
/// the primaries - and none of them may touch the ratios between the channels, which is the thing
/// being looked at.
///
/// Extended Reinhard **on the brightest channel, with all three scaled by what it gave up**, for
/// `prelude.slang`'s reason: a curve run per channel pulls the largest down furthest and tints the
/// highlight by whichever channel reached the top first, which is the one place a picture must not
/// be tinted. Not the shipping roll-off - that one is a shader and stays the only implementation of
/// itself; this is a viewer, and it says so by being a different curve.
fn write_view(graded: &[u16], width: usize, height: usize, path: &str) {
    // The graded frame's own nits, in plain `f64` from here down: this is a viewer's tone map
    // rather than a stage, so what it wants is the numbers.
    let nits = |code: u16| {
        let signal = rawshim::light::Light::measured(f64::from(code) / f64::from(u16::MAX));
        rawshim::tone::pq_inv::<rawshim::light::DisplayNits>(signal).raw()
    };
    let reference = REFERENCE_NITS.raw();
    let peak = graded.iter().map(|c| nits(*c)).fold(0.0f64, f64::max).max(reference);
    let to_srgb = rawshim::hdr_fit::rec2020_to_srgb();
    let transfer = |v: f64| match v <= 0.0031308 {
        true => v * 12.92,
        false => 1.055 * v.powf(1.0 / 2.4) - 0.055,
    };

    let mut out = format!("P6\n{width} {height}\n255\n").into_bytes();
    out.reserve(width * height * 3);
    for pixel in 0..width * height {
        let rgb: [f64; 3] = std::array::from_fn(|c| nits(graded[pixel * 3 + c]));
        let top = rgb[0].max(rgb[1]).max(rgb[2]);
        // Peak maps to display white and black to black, so the whole range is on screen.
        let mapped = match top > 0.0 {
            true => top * (1.0 + top / (peak * peak)) / (1.0 + top / reference),
            false => 0.0,
        };
        let held = match top > 0.0 {
            true => rgb.map(|v| v * mapped / top / reference),
            false => [0.0; 3],
        };
        for row in to_srgb {
            let v = row[0] * held[0] + row[1] * held[1] + row[2] * held[2];
            out.push((transfer(v.clamp(0.0, 1.0)) * 255.0 + 0.5) as u8);
        }
    }
    std::fs::write(path, out).expect("wrote the view");
    println!("wrote {path}");
}

fn main() {
    let path = std::env::args().nth(1).expect("a raw path");
    let frame = rawshim::decode_frame(&path, 0).expect("a decode");
    let samples = frame.samples16().expect("16-bit").to_vec();
    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    let levels = rawshim::hdr::levels_of(gpu, &samples, frame.width, frame.height, QUANTILE)
        .expect("levels")
        .anchored();
    let white = levels.white.raw();
    println!(
        "white {:.0}  peak {:.0}  ratio {:.2}",
        white,
        levels.peak.raw(),
        (levels.peak / levels.white).raw(),
    );

    let resident = frame.on_device(gpu).expect("the frame on the device");
    let matched = rawshim::fit_hdr_for(&resident, &path, QUANTILE);
    match &matched {
        Some(m) => println!(
            "match deltaE {:.2}  ceiling {:.3}  anchor {:.3}  saturation {:.3}  lattice {}",
            m.colour.delta_e,
            m.colour.ceiling,
            m.colour.anchor,
            m.colour.saturation,
            m.colour.chroma.is_some(),
        ),
        None => println!("no match: the neutral arm renders this"),
    }

    let pixels = samples.len() / 3;
    let mut over = [0usize; 5];
    let mut clipped = 0usize;
    let ceiling = samples.iter().copied().max().unwrap_or(0);
    for p in 0..pixels {
        let v = [samples[p * 3], samples[p * 3 + 1], samples[p * 3 + 2]];
        let top = f64::from(v[0].max(v[1]).max(v[2])) / white;
        for (i, at) in [1.0, 2.0, 4.0, 8.0, 16.0].iter().enumerate() {
            if top >= *at {
                over[i] += 1;
            }
        }
        if v[0] >= ceiling && v[1] >= ceiling && v[2] >= ceiling {
            clipped += 1;
        }
    }
    println!(
        "top sample {ceiling} ({:.2}x white); {clipped} pixels flat at it; over white 1x {} 2x {} 4x {} 8x {} 16x {}",
        f64::from(ceiling) / white,
        over[0],
        over[1],
        over[2],
        over[3],
        over[4],
    );

    let out = std::env::args().nth(2);
    let options = EncodeOptions {
        still_chroma: Chroma::Yuv444,
        output_path: out.clone().unwrap_or_default(),
        grade: Grade {
            peak_nits: rawshim::light::Light::exactly(1000.0),
            reference_white_nits: REFERENCE_NITS,
            white_quantile: QUANTILE,
        },
        // The library's own `hdr_crf` default, not `examples/renders`' 26: that one writes a file
        // to look at, where a written file here is meant to be the rendition.
        crf: 3,
        preset: 6,
        strengths: Strengths { sharpen: 1.0, defringe: 1.0 },
        sharpen_sigma: None,
        max_edge: 100_000.0,
    };
    let source = Source { samples: &samples, width: frame.width, height: frame.height };
    let (graded, width, height) =
        rawshim::hdr::graded_as(&source, &options, matched.as_ref(), Output::Pq);
    println!("graded {width}x{height}");
    if let Some(path) = &out {
        rawshim::hdr::encode_pq_frame(graded.clone(), width, height, &options).expect("an encode");
        write_view(&graded, width, height, &format!("{path}.ppm"));
    }

    let mut order: Vec<usize> = (0..pixels).collect();
    order.sort_unstable_by(|a, b| {
        let key = |p: &usize| samples[p * 3].max(samples[p * 3 + 1]).max(samples[p * 3 + 2]);
        key(b).cmp(&key(a))
    });

    println!(
        "{:>9} {:>26} {:>6}   {:>26} {:>8} {:>6}",
        "at", "scene rgb / white", "sat", "graded nits", "peak", "sat"
    );
    let mut shown = 0usize;
    let mut seen: Vec<(usize, usize)> = Vec::new();
    for p in order {
        let (x, y) = (p % width, p / width);
        // One report per light rather than a hundred from the same one.
        if seen.iter().any(|(sx, sy)| x.abs_diff(*sx) < 64 && y.abs_diff(*sy) < 64) {
            continue;
        }
        seen.push((x, y));
        let scene = [0, 1, 2].map(|c| f64::from(samples[p * 3 + c]) / white);
        let nits = [0, 1, 2].map(|c| {
            let signal =
                rawshim::light::Light::measured(f64::from(graded[p * 3 + c]) / f64::from(u16::MAX));
            rawshim::tone::pq_inv::<rawshim::light::DisplayNits>(signal).raw()
        });
        println!(
            "{x:>4},{y:<4} {:>8.3} {:>8.3} {:>8.3} {:>6.3}   {:>8.1} {:>8.1} {:>8.1} {:>8.1} {:>6.3}",
            scene[0],
            scene[1],
            scene[2],
            saturation(scene),
            nits[0],
            nits[1],
            nits[2],
            nits[0].max(nits[1]).max(nits[2]),
            saturation(nits),
        );
        shown += 1;
        if shown >= 20 {
            break;
        }
    }

    if let Some(m) = &matched {
        println!("\nthe tone stage on a saturated highlight, by how far over white it sits:");
        let overs = [0.5, 0.9, 1.0, 2.0, 4.0, 8.0, 16.0];
        let scenes: Vec<[f64; 3]> = overs.iter().map(|over| [*over, over * 0.35, over * 0.6]).collect();
        let samples: Vec<[f32; 4]> =
            scenes.iter().map(|s| [s[0] as f32, s[1] as f32, s[2] as f32, 0.0]).collect();
        let outs = pollster::block_on(rawshim::hdr_fit::evaluated(
            gpu,
            &m.colour,
            &samples,
            rawshim::hdr_fit::Stage::Tone,
        ))
        .expect("the device evaluates the model");
        for ((over, scene), out) in overs.iter().zip(&scenes).zip(outs) {
            let out = [f64::from(out[0]), f64::from(out[1]), f64::from(out[2])];
            println!(
                "  {over:>5.1}x  in {:>6.3} sat {:>5.3}  ->  out {:>7.3} {:>7.3} {:>7.3} sat {:>5.3}",
                over,
                saturation(*scene),
                out[0],
                out[1],
                out[2],
                saturation(out),
            );
        }
    }
}
