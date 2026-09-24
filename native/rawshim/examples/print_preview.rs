use rawshim::gpu::{Canvas, Grade, Intent};
use rawshim::light::Light;
use rawshim::print::{Paper, Presentation, Scene};
use rawshim::px::Size;
use rawshim::snapshot::Snapshot;

fn main() -> Result<(), String> {
    let framed = std::env::args().any(|arg| arg == "--framed");
    // What a browser that reports no HDR display is drawn: everything above diffuse white rolled into it.
    let sdr = std::env::args().any(|arg| arg == "--sdr");
    let surface = std::env::args().any(|arg| arg == "--surface");
    let flat = std::env::args().any(|arg| arg == "--flat");
    let profile = std::env::args().find_map(|arg| arg.strip_prefix("--profile=").map(str::to_owned));
    let intent = match std::env::args().find_map(|arg| arg.strip_prefix("--intent=").map(str::to_owned)).as_deref() {
        None | Some("perceptual") => Intent::Perceptual,
        Some("relative") => Intent::RelativeColorimetric,
        Some(other) => return Err(format!("unknown intent {other}")),
    };
    let zoom = std::env::args()
        .find_map(|arg| arg.strip_prefix("--zoom=").map(str::to_owned))
        .map_or(Ok(1.0), |value| value.parse::<f64>().map_err(|_| "invalid zoom"))?;
    let pitches: Vec<f64> = std::env::args()
        .find_map(|arg| arg.strip_prefix("--pitches=").map(str::to_owned))
        .map_or(Ok(Vec::new()), |list| list.split(',').map(|value| value.parse::<f64>().map_err(|_| "invalid pitch")).collect())?;
    let number = |name: &str, default: f64| -> Result<f64, String> {
        std::env::args()
            .find_map(|arg| arg.strip_prefix(&format!("--{name}=")).map(str::to_owned))
            .map_or(Ok(default), |value| value.parse::<f64>().map_err(|_| format!("invalid {name}")))
    };
    let key_lux = Light::exactly(number("key-lux", Scene::default().key_lux.raw())?);
    let fill_lux = Light::exactly(number("fill-lux", Scene::default().fill_lux.raw())?);
    let lamp_degrees = number("lamp-degrees", Scene::default().light_angular_degrees)?;
    let view: Option<Vec<f64>> = std::env::args()
        .find_map(|arg| arg.strip_prefix("--view=").map(str::to_owned))
        .map(|list| list.split(',').map(|value| value.parse::<f64>().map_err(|_| "invalid view")).collect())
        .transpose()?;
    if view.as_ref().is_some_and(|view| view.len() != 5) {
        return Err("--view is yaw,pitch,lamp azimuth,lamp elevation,lamp distance".to_owned());
    }
    let (pan_x, pan_y) = (number("pan-x", 0.0)?, number("pan-y", 0.0)?);
    let args: Vec<String> = std::env::args()
        .filter(|arg| arg != "--framed" && arg != "--surface" && arg != "--sdr" && arg != "--flat"
            && !arg.starts_with("--profile=") && !arg.starts_with("--intent=") && !arg.starts_with("--adaptation=")
            && !arg.starts_with("--zoom=") && !arg.starts_with("--pitches=")
            && !arg.starts_with("--key-lux=") && !arg.starts_with("--fill-lux=") && !arg.starts_with("--lamp-degrees=")
            && !arg.starts_with("--view=") && !arg.starts_with("--pan-x=") && !arg.starts_with("--pan-y="))
        .collect();
    if !(3..=4).contains(&args.len()) {
        return Err("usage: print_preview <photograph> <output-directory> [before-directory] [--framed] [--surface] [--flat] [--sdr] [--profile=printer.icc] [--adaptation=0.7] [--intent=perceptual|relative] [--zoom=1] [--pitches=8,0,-8] [--key-lux=1000] [--fill-lux=500] [--lamp-degrees=1] [--view=yaw,pitch,azimuth,elevation,distance] [--pan-x=0] [--pan-y=0]".to_owned());
    }
    let output = std::path::Path::new(&args[2]);
    std::fs::create_dir_all(output).map_err(|error| error.to_string())?;
    let bytes = std::fs::read(&args[1]).map_err(|error| error.to_string())?;
    let prepared = rawshim::edit::prepare_bytes(&bytes, &rawshim::edit::EditRequest {
        long_edge: 1600,
        grade: rawshim::hdr::Grade {
            peak_nits: Light::exactly(1000.0),
            reference_white_nits: Light::exactly(203.0),
            white_quantile: 0.995,
        },
        defringe: 1.0,
        photo_analysis: None,
        denoise_luminance: None,
        denoise_colour: None,
        denoiser: rawshim::galosh::Denoiser::Galosh,
        dust: Default::default(),
        repairs: Vec::new(),
        stated_white: false,
    }, 40.0)?;
    let gpu = rawshim::gpu::device().ok_or("print requires Vulkan")?;
    let base = rawshim::base::device(gpu).ok_or("the source pyramid")?;
    let header = &prepared.header;
    let display = Scene { framed: framed && surface, ..Scene::default() }.display_size((header.width, header.height));
    let canvas = if surface {
        let scale = 1280.0 / display.0.max(display.1);
        ((display.0 * scale).round() as usize, (display.1 * scale).round() as usize)
    } else { (1280, 960) };
    let analysis = header.photo_analysis.as_deref().and_then(rawshim::photo_analysis::decode);
    let pyramid = rawshim::base::pyramid(gpu, base, &prepared.samples, (header.width, header.height))
        .ok_or("the source pyramid")?;
    let grade = Grade {
        colour: analysis.as_ref().and_then(|analysis| analysis.from_raw.matched.as_ref()).and_then(|matched| matched.colour.as_ref()),
        as_shot: header.as_shot,
        canvas: Some(Canvas {
            region: (0.0, 0.0, display.0, display.1),
            size: Size::measured(canvas.0, canvas.1),
            max_lod: pyramid.levels,
        }),
        intent,
        ..Grade::new(
            header.width,
            header.height,
            rawshim::tone::Levels { white: header.white, peak: header.peak, floor: header.floor },
            header.grade.reference_white_nits,
            if sdr { Light::at_diffuse_white(header.grade.reference_white_nits) } else { header.grade.peak_nits },
        )
    };
    let peak = gpu.scene_peak();
    let uploaded = gpu.upload(&prepared.samples, &grade, &peak);
    uploaded.collect_candidates(&grade);
    if let Some(path) = profile {
        let icc = std::fs::read(&path).map_err(|error| format!("{path}: {error}"))?;
        let started = std::time::Instant::now();
        let adaptation = number("adaptation", rawshim::printer_gamut::PAPER_ADAPTATION)?;
        let printer = rawshim::printer_gamut::PrinterGamut::adapted(&icc, adaptation)?;
        println!("{path}: gamut read in {:.1} ms", started.elapsed().as_secs_f64() * 1000.0);
        uploaded.set_printer(Some(std::sync::Arc::new(printer)));
    }
    if !pitches.is_empty() {
        let white = header.grade.reference_white_nits.raw();
        for pitch in pitches {
            let scene = Scene {
                rendering_intent: intent, framed, zoom, key_lux, fill_lux, light_angular_degrees: lamp_degrees, pitch_degrees: pitch,
                ..Scene::default()
            };
            let samples = uploaded.print_pq(&grade, &pyramid, &scene);
            let snapshot = Snapshot::pq(&samples, Size::<rawshim::px::Canvas>::measured(canvas.0, canvas.1));
            std::fs::write(output.join(format!("pitch{pitch}.preview.png")), rawshim::snapshot::side_by_side_png(None, &snapshot))
                .map_err(|error| error.to_string())?;
            let (tops, lumas, bands) = sheet_levels(&samples, canvas);
            let at = |sorted: &[f64], share: f64| sorted[((sorted.len() - 1) as f64 * share) as usize];
            let bands: Vec<String> = bands.iter().map(|band| format!("{:>6.2}", at(band, 0.1))).collect();
            println!(
                "pitch {pitch:>5}: max channel p99.5 {:>7.1} nits ({:+.2} stops), max {:>7.1}; luma p1 {:>6.2} nits ({:+.2} stops); luma p10 top to bottom {}",
                at(&tops, 0.995), (at(&tops, 0.995) / white).log2(), at(&tops, 1.0),
                at(&lumas, 0.01), (at(&lumas, 0.01) / white).log2(), bands.join(" "),
            );
        }
        return Ok(());
    }
    for (name, paper) in [("gloss", Paper::Gloss), ("satin", Paper::Satin), ("matte", Paper::Matte)] {
        let scene = Scene {
            framed,
            presentation: if flat { Presentation::Flat } else if surface { Presentation::Surface } else { Presentation::Scene },
            rendering_intent: intent,
            zoom,
            ..Scene::default()
        }.on(paper);
        let views = match &view {
            Some(view) => vec![("view", Scene {
                yaw_degrees: view[0],
                pitch_degrees: view[1],
                light_angular_degrees: lamp_degrees,
                pan_x,
                pan_y,
                ..scene
            }.lit_from(view[2], view[3], view[4]))],
            None => standard_views(scene),
        };
        for (view, scene) in views {
            let samples = uploaded.print_pq(&grade, &pyramid, &scene);
            let snapshot = Snapshot::pq(&samples, Size::<rawshim::px::Canvas>::measured(canvas.0, canvas.1));
            std::fs::write(output.join(format!("{name}-{view}.png")), snapshot.encode())
                .map_err(|error| error.to_string())?;
            std::fs::write(output.join(format!("{name}-{view}.preview.png")), rawshim::snapshot::side_by_side_png(None, &snapshot))
                .map_err(|error| error.to_string())?;
            if let Some(before) = args.get(3) {
                let bytes = std::fs::read(std::path::Path::new(before).join(format!("{name}-{view}.png")))
                    .map_err(|error| error.to_string())?;
                let before = Snapshot::decode(&bytes)?;
                std::fs::write(output.join(format!("{name}-{view}.diff.png")), rawshim::snapshot::side_by_side_png(Some(&before), &snapshot))
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

fn standard_views(scene: Scene) -> Vec<(&'static str, Scene)> {
    vec![("default", scene), ("glare", Scene {
        yaw_degrees: -15.0,
        pitch_degrees: -12.0,
        ..scene
    }.lit_from(-32.0, 25.0, 4.0)), ("ceiling", Scene {
        yaw_degrees: -8.0,
        pitch_degrees: -40.0,
        ..scene
    }), ("dark-room", Scene {
        yaw_degrees: -12.0,
        pitch_degrees: -37.0,
        fill_lux: Light::ZERO,
        ..scene
    })]
}

const BANDS: usize = 5;

/// The drawn sheet's brightest channel and its luma, per pixel, in display nits, sorted, and the
/// luma again split into horizontal bands of the canvas rows the sheet covers, top first.
fn sheet_levels(samples: &[u16], canvas: (usize, usize)) -> (Vec<f64>, Vec<f64>, Vec<Vec<f64>>) {
    let nits = |code: u16| rawshim::tone::pq_inv::<rawshim::light::DisplayNits>(Light::measured(f64::from(code) / 65535.0)).raw();
    let background = {
        let corner = &samples[..3];
        (nits(corner[0]), nits(corner[1]), nits(corner[2]))
    };
    let mut tops = Vec::new();
    let mut lumas = Vec::new();
    let mut rows = Vec::new();
    for (at, pixel) in samples.chunks_exact(samples.len() / (canvas.0 * canvas.1)).enumerate() {
        let (r, g, b) = (nits(pixel[0]), nits(pixel[1]), nits(pixel[2]));
        if (r - background.0).abs() + (g - background.1).abs() + (b - background.2).abs() < 1e-3 { continue; }
        tops.push(r.max(g).max(b));
        let luma = 0.2627 * r + 0.678 * g + 0.0593 * b;
        lumas.push(luma);
        rows.push((at / canvas.0, luma));
    }
    let first = rows.iter().map(|(row, _)| *row).min().unwrap_or(0);
    let last = rows.iter().map(|(row, _)| *row).max().unwrap_or(0);
    let mut bands = vec![Vec::new(); BANDS];
    for (row, luma) in rows {
        bands[((row - first) * BANDS / (last - first + 1)).min(BANDS - 1)].push(luma);
    }
    for band in &mut bands {
        band.sort_by(f64::total_cmp);
    }
    tops.sort_by(f64::total_cmp);
    lumas.sort_by(f64::total_cmp);
    (tops, lumas, bands)
}
