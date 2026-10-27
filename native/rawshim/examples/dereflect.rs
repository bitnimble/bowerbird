//! The reflection remover on the device, for `models/dereflect`'s `device_check` to hold against
//! torch.
//!
//! ```text
//! dereflect net <bundle-dir> <in.f32> <width> <height> <out.f32>
//! dereflect frame <bundle-dir> <frame.f32> <width> <height> <strokes.json> <out.f32>
//! ```
//!
//! `net` reads planar light coded as the network takes it then the brush's planes, sides multiples
//! of 16, and writes the coded reflection it predicts. `frame` reads a planar linear frame and the
//! document's strokes, and writes the reflection the stage takes out of it, linear, at full size.
//! `DEREFLECT_CELLS=half` holds the network in `half` cells (`shader-f16`).

use gpu::{Buffer, Gpu};
use rawshim::dereflect::{Cells, HINTS, MULTIPLE, Remover, Stroke};

const TIMED_RUNS: usize = 5;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("net") => net(&args[1..]),
        Some("frame") => frame(&args[1..]),
        _ => panic!("dereflect net|frame ..."),
    }
}

fn net(args: &[String]) {
    let [bundle, given, width, height, out] = args else {
        panic!("dereflect net <bundle-dir> <in.f32> <width> <height> <out.f32>");
    };
    let (w, h) = size(width, height);
    assert!(
        w % MULTIPLE == 0 && h % MULTIPLE == 0,
        "sides must be multiples of {MULTIPLE}"
    );
    let bytes = std::fs::read(given).expect("the input");
    assert_eq!(
        bytes.len(),
        (3 + HINTS) * w * h * 4,
        "planar f32 of {w}x{h}, the picture then the brush"
    );
    let (gpu, remover) = opened(bundle);
    let given = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("dereflect input"),
        contents: &bytes,
        usage: wgpu::BufferUsages::STORAGE,
    });
    let mut times = Vec::new();
    let mut predicted = Vec::new();
    for _ in 0..TIMED_RUNS + 1 {
        let started = std::time::Instant::now();
        let coded = remover.predict(gpu, &given, w, h);
        predicted = read(gpu, &coded, 3 * w * h * 4);
        times.push(started.elapsed());
    }
    let first = times.remove(0);
    times.sort();
    eprintln!(
        "{w}x{h}: first {first:?}, median of {TIMED_RUNS} after {:?}",
        times[TIMED_RUNS / 2]
    );
    std::fs::write(out, predicted).expect("wrote the reflection");
}

fn frame(args: &[String]) {
    let [bundle, frame, width, height, strokes, out] = args else {
        panic!(
            "dereflect frame <bundle-dir> <frame.f32> <width> <height> <strokes.json> <out.f32>"
        );
    };
    let (w, h) = size(width, height);
    let planar: Vec<f32> = std::fs::read(frame)
        .expect("the frame")
        .chunks_exact(4)
        .map(|word| f32::from_le_bytes(word.try_into().expect("four")))
        .collect();
    assert_eq!(planar.len(), 3 * w * h, "planar f32 of {w}x{h}");
    let strokes: Vec<Stroke> =
        serde_json::from_slice(&std::fs::read(strokes).expect("the strokes")).expect("strokes");
    let full_scale = colour::resident::FULL_SCALE;
    let samples = colour::resident::samples_of_levels(
        (0..w * h)
            .flat_map(|p| (0..3).map(move |c| (c, p)))
            .map(|(c, p)| planar[c * w * h + p] * full_scale),
    );
    let (gpu, remover) = opened(bundle);
    let resident = colour::resident::Resident::upload(gpu, &samples, w, h);
    let full = units::px::Size::exact(w, h);
    let looked = rawshim::dereflect::looked(gpu, &resident).expect("the shrink");
    let layer = remover.layer(gpu, &looked, full, &strokes, &rawshim::fit::Lens::none());
    let before = resident.duplicate();
    layer.take_out(gpu, &resident, units::px::At::ORIGIN, full, 1.0);
    let levels = |frame: &colour::resident::Resident| {
        colour::resident::levels_of(&pollster::block_on(frame.host()).expect("reads back"))
    };
    let (before, after) = (levels(&before), levels(&resident));
    let mut taken = vec![0f32; 3 * w * h];
    for p in 0..w * h {
        for c in 0..3 {
            taken[c * w * h + p] = (before[p * 3 + c] - after[p * 3 + c]) / full_scale;
        }
    }
    std::fs::write(out, bytemuck::cast_slice(&taken)).expect("wrote the reflection");
}

fn size(width: &str, height: &str) -> (usize, usize) {
    (
        width.parse().expect("a width"),
        height.parse().expect("a height"),
    )
}

fn opened(bundle: &str) -> (&'static Gpu, Remover) {
    let read = |name: &str| {
        let path = format!("{bundle}/{name}");
        std::fs::read(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
    };
    let manifest = String::from_utf8(read("weights.json")).expect("weights.json is text");
    let gpu = gpu::device().expect("an adapter");
    let cells = match std::env::var("DEREFLECT_CELLS").as_deref() {
        Ok("half") => Cells::Half,
        Ok("float") | Err(_) => Cells::Float,
        Ok(other) => panic!("DEREFLECT_CELLS is half or float, not {other}"),
    };
    let remover =
        Remover::new(gpu, &manifest, &read("weights.bin"), cells).expect("the bundle loads");
    (gpu, remover)
}

fn read(gpu: &'static Gpu, buffer: &Buffer, size: usize) -> Vec<u8> {
    let staging = gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some("dereflect read"),
        size: size as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut recording = gpu.record();
    recording.copy_buffer_to_buffer(buffer, 0, &staging, 0, size as u64);
    recording.submit();
    pollster::block_on(gpu::read_back(gpu, &staging, <[u8]>::to_vec)).expect("reads back")
}
