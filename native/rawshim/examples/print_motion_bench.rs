use rawshim::gpu::{Adjust, Canvas, Grade, Output};
use rawshim::light::{Light, Stops};
use rawshim::print::{Paper, Presentation, Scene};
use rawshim::px::{Size, Span};
use std::time::{Duration, Instant};

fn main() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .ok_or("usage: print_motion_bench <photograph> [long-edge] [frames]")?;
    let long: usize = args.next().map_or(Ok(1920), |value| {
        value.parse().map_err(|_| "invalid long edge")
    })?;
    let frames: usize = args.next().map_or(Ok(24), |value| {
        value.parse().map_err(|_| "invalid frame count")
    })?;
    if long < 64 || frames < 2 {
        return Err("long edge must be at least 64 and frame count at least 2".into());
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let prepared = rawshim::edit::prepare_bytes(
        &bytes,
        &rawshim::edit::EditRequest {
            long_edge: 1920,
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
        },
        40.0,
    )?;
    let gpu = rawshim::gpu::device().ok_or("print requires Vulkan")?;
    let base = rawshim::base::device(gpu).ok_or("source pyramid")?;
    let header = &prepared.header;
    let analysis = header
        .photo_analysis
        .as_deref()
        .and_then(rawshim::photo_analysis::decode);
    let pyramid =
        rawshim::base::pyramid(gpu, base, &prepared.samples, (header.width, header.height))
            .ok_or("source pyramid")?;
    let scale = long as f64 / header.width.max(header.height) as f64;
    let size = Size::measured(
        (header.width as f64 * scale).round() as usize,
        (header.height as f64 * scale).round() as usize,
    );
    let (width, height) = size.raw();
    let grade = Grade {
        width: header.width,
        height: header.height,
        photograph_long: Span::measured(header.width.max(header.height)),
        colour: analysis
            .as_ref()
            .and_then(|analysis| analysis.from_raw.matched.as_ref())
            .map(|matched| &matched.colour),
        white: header.white,
        source_level: header.peak,
        floor: header.floor,
        reference_nits: header.grade.reference_white_nits,
        peak_nits: Light::exactly(1000.0),
        exposure: Stops::ZERO,
        adjust: Adjust::none(),
        as_shot: header.as_shot,
        output: Output::Pq,
        geometry: rawshim::image::Geometry::none(),
        window: None,
        surround_window: None,
        canvas: Some(Canvas {
            region: (0.0, 0.0, header.width as f64, header.height as f64),
            size,
            max_lod: pyramid.levels,
        }),
    };
    let peak = gpu.scene_peak();
    let uploaded = gpu.upload(&prepared.samples, &grade, &peak);
    uploaded.collect_candidates(&grade);
    let target = gpu.own_texture(&wgpu::TextureDescriptor {
        label: Some("print motion timing"),
        size: wgpu::Extent3d {
            width: width as u32,
            height: height as u32,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = target.view();
    println!("adapter,mode,width,height,frames,median_ms,p95_ms,cpu_submit_ms,fps");
    for (name, paper, roughness, key) in [
        ("ambient", Paper::Satin, 0.28, 0.0),
        ("gloss", Paper::Gloss, 0.08, 1000.0),
        ("satin", Paper::Satin, 0.28, 1000.0),
        ("matte", Paper::Matte, 0.65, 1000.0),
    ] {
        let mut scene = Scene {
            presentation: Presentation::Surface,
            paper,
            roughness,
            key_lux: Light::exactly(key),
            ..Scene::default()
        };
        let draw = |index: usize, scene: &mut Scene| {
            scene.yaw_degrees = 14.0 * (index as f64 * 0.09).sin();
            scene.pitch_degrees = -35.0 + 6.0 * (index as f64 * 0.11).cos();
            let start = Instant::now();
            if grade.colour.is_some() {
                uploaded.peak_from_candidates(&grade);
            }
            let mut recording = gpu.record();
            uploaded.draw_into(&mut recording, &grade, &pyramid, &view, Some(scene), false);
            recording.submit();
            let cpu = start.elapsed().as_secs_f64() * 1000.0;
            gpu.block_until_done();
            (start.elapsed().as_secs_f64() * 1000.0, cpu)
        };
        let warmup = Instant::now();
        let mut index = 0;
        while index < 8 || warmup.elapsed() < Duration::from_millis(350) {
            draw(index, &mut scene);
            index += 1;
        }
        let mut elapsed = Vec::with_capacity(frames);
        let mut submitted = Vec::with_capacity(frames);
        for frame in 0..frames {
            let (duration, cpu) = draw(8 + frame, &mut scene);
            elapsed.push(duration);
            submitted.push(cpu);
        }
        elapsed.sort_by(f64::total_cmp);
        submitted.sort_by(f64::total_cmp);
        let median = elapsed[frames / 2];
        let p95 = elapsed[((frames as f64 * 0.95).ceil() as usize - 1).min(frames - 1)];
        println!(
            "\"{}\",{name},{width},{height},{frames},{median:.3},{p95:.3},{:.3},{:.2}",
            gpu.adapter,
            submitted[frames / 2],
            1000.0 / median
        );
    }
    Ok(())
}
