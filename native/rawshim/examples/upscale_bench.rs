//! The 2x upscaler on this device, every arm it offers.
//!
//! ```text
//! upscale_bench <weights dir> check <mosaic.f32> <width> <height> <r,g,b> <alpha,sigma_sq> <out dir> [tile]
//! upscale_bench <weights dir> time [repeats] [tile]
//! ```
//!
//! `check` writes each arm's answer as `<out dir>/<arm>.f32` for `models/upscaler` to hold against
//! torch, the photo's conditioning gains and noise fit given. `time` upscales a 24MP and a 61MP
//! frame and prints each arm's milliseconds, the answer's allocation and the upload left out.

use rawshim::galosh::NoiseModel;
use rawshim::upscale::{Arm, Upscaler, answer_bytes};

/// What `time` stabilises under: a middling photo's, which costs what any other does.
const TIMED_GAINS: [f32; 3] = [0.5, 1.0, 0.7];
const TIMED_NOISE: NoiseModel = NoiseModel {
    alpha: 1e-4,
    sigma_sq: 1e-6,
};

const ARMS: [Arm; 10] = [
    Arm::Winograd,
    Arm::MatrixWide { rows: 1 },
    Arm::MatrixWide { rows: 2 },
    Arm::MatrixNarrow { rows: 1 },
    Arm::MatrixNarrow { rows: 2 },
    Arm::MatrixNarrow { rows: 4 },
    Arm::Half { pixels: 4 },
    Arm::Half { pixels: 8 },
    Arm::Float { pixels: 4 },
    Arm::Float { pixels: 8 },
];

fn named(arm: Arm) -> String {
    match arm {
        Arm::MatrixWide { rows } => format!("matrix-wide-{rows}"),
        Arm::MatrixNarrow { rows } => format!("matrix-narrow-{rows}"),
        Arm::Winograd => "winograd".into(),
        Arm::Half { pixels } => format!("half-{pixels}"),
        Arm::Float { pixels } => format!("float-{pixels}"),
    }
}
const FRAMES: [(&str, usize, usize); 2] = [("24MP", 6000, 4000), ("61MP", 9504, 6336)];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let usage = "upscale_bench <weights dir> check <mosaic.f32> <width> <height> <r,g,b> <alpha,sigma_sq> <out dir> [tile]\n\
                 upscale_bench <weights dir> time [repeats] [tile]";
    let (Some(weights), Some(mode)) = (args.get(1), args.get(2)) else {
        eprintln!("{usage}");
        std::process::exit(2);
    };
    let gpu = rawshim::gpu::device().expect("a GPU adapter");
    let folder = std::path::Path::new(weights);
    let manifest = std::fs::read_to_string(folder.join("weights.json")).expect("weights.json");
    let bytes = std::fs::read(folder.join("weights.bin")).expect("weights.bin");
    // One at a time: each holds its tile's tensors, and every arm's at once exceeds a 10GB card.
    let arms = || {
        ARMS.iter().filter_map(|&arm| {
            let built = Upscaler::new(gpu, &manifest, &bytes, arm).expect("the network");
            if built.is_none() {
                println!("{}: not on this device", named(arm));
            }
            built
        })
    };
    let number = |at: usize| args.get(at).map(|n| n.parse::<usize>().expect("a count"));

    match mode.as_str() {
        "check" => {
            let (Some(input), Some(width), Some(height), Some(gains), Some(noise), Some(out)) = (
                args.get(3),
                number(4),
                number(5),
                args.get(6).map(|text| floats::<3>(text)),
                args.get(7).map(|text| floats::<2>(text)),
                args.get(8),
            ) else {
                eprintln!("{usage}");
                std::process::exit(2);
            };
            let noise = NoiseModel {
                alpha: noise[0],
                sigma_sq: noise[1],
            };
            let samples = std::fs::read(input).expect("the mosaic");
            let mosaic = upload(gpu, &samples);
            for upscaler in arms() {
                let into = answer(gpu, width, height);
                let stabiliser = upscaler
                    .stabiliser(gains, Some(noise))
                    .expect("a stabiliser");
                upscaler
                    .upscale(gpu, &mosaic, width, height, &into, number(9), &stabiliser)
                    .expect("an upscale");
                let read = read(gpu, &into);
                let path = std::path::Path::new(out).join(format!("{}.f32", named(upscaler.arm())));
                std::fs::write(&path, read).expect("the answer");
                println!("wrote {}", path.display());
            }
        }
        "time" => {
            let repeats = number(3).unwrap_or(5);
            for (name, width, height) in FRAMES {
                let samples: Vec<f32> = (0..width * height)
                    .map(|i| ((i as u32).wrapping_mul(2654435761) >> 8) as f32 / (1 << 24) as f32)
                    .collect();
                let mosaic = upload(gpu, bytemuck::cast_slice(&samples));
                let into = answer(gpu, width, height);
                for upscaler in arms() {
                    let stabiliser = upscaler
                        .stabiliser(TIMED_GAINS, Some(TIMED_NOISE))
                        .expect("a stabiliser");
                    let run = || {
                        upscaler
                            .upscale(gpu, &mosaic, width, height, &into, number(4), &stabiliser)
                            .expect("an upscale");
                        gpu.block_until_done();
                    };
                    run();
                    run();
                    let mut times: Vec<f64> = (0..repeats)
                        .map(|_| {
                            let start = std::time::Instant::now();
                            run();
                            start.elapsed().as_secs_f64() * 1000.0
                        })
                        .collect();
                    times.sort_by(f64::total_cmp);
                    println!(
                        "{name} {}: median {:.1}ms, best {:.1}ms",
                        named(upscaler.arm()),
                        times[times.len() / 2],
                        times[0]
                    );
                }
            }
        }
        _ => {
            eprintln!("{usage}");
            std::process::exit(2);
        }
    }
}

fn floats<const N: usize>(text: &str) -> [f32; N] {
    let parsed: Vec<f32> = text
        .split(',')
        .map(|n| n.parse().expect("a number"))
        .collect();
    parsed
        .try_into()
        .unwrap_or_else(|_| panic!("{N} comma-separated numbers"))
}

fn upload(gpu: &rawshim::gpu::Gpu, bytes: &[u8]) -> rawshim::gpu::Buffer {
    let mut recording = gpu.record();
    let buffer = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("mosaic"),
        contents: bytes,
        usage: wgpu::BufferUsages::STORAGE,
    });
    recording.submit();
    buffer
}

fn answer(gpu: &rawshim::gpu::Gpu, width: usize, height: usize) -> rawshim::gpu::Buffer {
    let mut recording = gpu.record();
    recording.buffer(&wgpu::BufferDescriptor {
        label: Some("upscaled"),
        size: answer_bytes(width, height),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    })
}

fn read(gpu: &rawshim::gpu::Gpu, buffer: &rawshim::gpu::Buffer) -> Vec<u8> {
    let mut recording = gpu.record();
    let staging = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("read"),
        size: buffer.size(),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    recording
        .encoder()
        .copy_buffer_to_buffer(buffer, 0, &staging, 0, buffer.size());
    recording.submit();
    pollster::block_on(rawshim::gpu::read_back(gpu, &staging, <[u8]>::to_vec)).expect("a read")
}
