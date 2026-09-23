use rawshim::gpu::{Adjust, Canvas, Grade, Output, Tonemap};
use rawshim::light::{Gain, Light, Stops};
use rawshim::print::{Paper, Presentation, Scene};
use rawshim::px::{Size, Span};
use rawshim::snapshot::Snapshot;

fn main() -> Result<(), String> {
    let framed = std::env::args().any(|arg| arg == "--framed");
    let surface = std::env::args().any(|arg| arg == "--surface");
    let named = std::env::args().find_map(|arg| arg.strip_prefix("--tone=").map(str::to_owned));
    let tonemap = match named.as_deref().unwrap_or("neutral") {
        "neutral" => Tonemap::Neutral,
        "filmic" => Tonemap::Filmic,
        "channel" => Tonemap::Channel,
        "local" => Tonemap::Local,
        other => return Err(format!("unknown tone operator {other}")),
    };
    let zoom = std::env::args()
        .find_map(|arg| arg.strip_prefix("--zoom=").map(str::to_owned))
        .map_or(Ok(1.0), |value| value.parse::<f64>().map_err(|_| "invalid zoom"))?;
    let args: Vec<String> = std::env::args()
        .filter(|arg| arg != "--framed" && arg != "--surface"
            && !arg.starts_with("--tone=") && !arg.starts_with("--zoom="))
        .collect();
    if !(3..=4).contains(&args.len()) {
        return Err("usage: print_preview <photograph> <output-directory> [before-directory] [--framed] [--surface] [--tone=neutral|filmic|channel|local] [--zoom=1]".to_owned());
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
        dust: Default::default(),
        repairs: Vec::new(),
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
        width: header.width,
        height: header.height,
        photograph_long: Span::measured(header.width.max(header.height)),
        colour: analysis.as_ref().and_then(|analysis| analysis.from_raw.matched.as_ref()).map(|matched| &matched.colour),
        white: header.white,
        source_level: header.peak,
        floor: header.floor,
        reference_nits: header.grade.reference_white_nits,
        peak_nits: Light::at_diffuse_white(header.grade.reference_white_nits),
        exposure: Stops::ZERO,
        adjust: Adjust::none(),
        as_shot: header.as_shot,
        output: Output::Pq,
        geometry: rawshim::image::Geometry::none(),
        window: None,
        surround_window: None,
        canvas: Some(Canvas {
            region: (0.0, 0.0, display.0, display.1),
            size: Size::measured(canvas.0, canvas.1),
            max_lod: pyramid.levels,
        }),
        print_tone: tonemap,
    };
    let peak = gpu.scene_peak();
    let uploaded = gpu.upload(&prepared.samples, &grade, &peak);
    uploaded.collect_candidates(&grade);
    for (name, paper, roughness, white, black, surface_texture) in [
        ("gloss", Paper::Gloss, 0.08, 0.92, 0.004, 0.15),
        ("satin", Paper::Satin, 0.18, 0.9, 0.008, 0.5),
        ("matte", Paper::Matte, 0.65, 0.88, 0.025, 0.85),
    ] {
        let scene = Scene {
            paper,
            tonemap,
            framed,
            presentation: if surface { Presentation::Surface } else { Presentation::Scene },
            roughness,
            white_reflectance: Gain::of_ratio(white),
            black_reflectance: Gain::of_ratio(black),
            surface_texture,
            zoom,
            ..Scene::default()
        };
        for (view, scene) in [("default", scene), ("glare", Scene {
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
        })] {
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
