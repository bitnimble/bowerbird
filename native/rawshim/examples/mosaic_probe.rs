//! The denoise watched at the real mosaic: what the filter changed, before any demosaic.
//!
//! ```text
//! mosaic_probe <raw> <out-dir> <x,y,w,h> [luminance] [colour]
//! ```
//!
//! Writes the window of the conditioned mosaic before and after the denoise, and their
//! difference amplified, as PGMs. Coordinates are the sensor's own.

use rawshim::galosh::Amounts;

fn pgm(path: &str, values: &[f32], width: usize, height: usize) {
    let mut bytes = format!("P5\n{width} {height}\n255\n").into_bytes();
    bytes.extend(values.iter().map(|v| (v.clamp(0.0, 1.0) * 255.0) as u8));
    std::fs::write(path, bytes).expect("wrote");
    eprintln!("wrote {path}");
}

fn window(whole: &[f32], stride: usize, x: usize, y: usize, w: usize, h: usize) -> Vec<f32> {
    let mut cut = Vec::with_capacity(w * h);
    for row in 0..h {
        let from = (y + row) * stride + x;
        cut.extend_from_slice(&whole[from..from + w]);
    }
    cut
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("a raw path");
    let out = args.next().expect("an output directory");
    let rect: Vec<usize> = args
        .next()
        .expect("x,y,w,h")
        .split(',')
        .map(|v| v.parse().expect("a number"))
        .collect();
    let (x, y, w, h) = (rect[0], rect[1], rect[2], rect[3]);
    let luminance: f64 = args.next().map_or(40.0, |v| v.parse().expect("a number"));
    let colour: f64 = args.next().map_or(40.0, |v| v.parse().expect("a number"));
    std::fs::create_dir_all(&out).expect("the output directory");

    let bytes = std::fs::read(&path).expect("read the raw");
    let held = pollster::block_on(rawshim::decode_rawler::hold_bytes(&bytes)).expect("held");
    let gpu = rawshim::gpu::device().expect("an adapter");
    let kernels = rawshim::galosh::device(gpu).expect("the kernels built");
    let mosaic = held.device_mosaic();
    let stride = mosaic.width;
    // The window is in the sensor's coordinates and a render's crop is inside the readable area,
    // so a comparison against one has to be offset by this or it is of two different places.
    let (crop_left, crop_top, crop_w, crop_h) = held.crop();
    eprintln!(
        "mosaic {stride}x{} crop {crop_left},{crop_top} {crop_w}x{crop_h}",
        mosaic.height
    );

    let cfa = held.cfa();
    let fit = pollster::block_on(rawshim::galosh::fit(gpu, kernels, mosaic, &cfa));
    eprintln!("fit: {fit:?}");

    let noisy = pollster::block_on(mosaic.read(gpu)).expect("reads back");
    let filtered = mosaic.duplicate(gpu);
    pollster::block_on(rawshim::galosh::denoise_with(
        gpu,
        kernels,
        &filtered,
        &cfa,
        Amounts::from_sliders(luminance, colour),
        fit,
    ));
    let denoised = pollster::block_on(filtered.read(gpu)).expect("reads back");

    let before = window(&noisy, stride, x, y, w, h);
    let after = window(&denoised, stride, x, y, w, h);

    // The scene is dark; a fixed gain makes the window readable without inventing a grade.
    let lifted = |values: &[f32]| values.iter().map(|v| v * 8.0).collect::<Vec<f32>>();
    pgm(&format!("{out}/before.pgm"), &lifted(&before), w, h);
    pgm(&format!("{out}/after.pgm"), &lifted(&after), w, h);

    // The green photosites alone, two to a site averaged, at half resolution: the sensor's own
    // picture of the window with nothing interpolated, coded the way the demosaic path below is.
    let mut green = Vec::with_capacity(w / 2 * h / 2);
    for sy in 0..h / 2 {
        for sx in 0..w / 2 {
            let at = |dx: usize, dy: usize| before[(sy * 2 + dy) * w + sx * 2 + dx];
            // Green is on the main diagonal where the top-left site is green, else the other.
            let (a, b) = match held.cfa().colour_at(0, 0) == 1 {
                true => (at(0, 0), at(1, 1)),
                false => (at(1, 0), at(0, 1)),
            };
            green.push(((a + b) * 0.5 * 8.0).clamp(0.0, 1.0).powf(1.0 / 2.2));
        }
    }
    pgm(&format!("{out}/green.pgm"), &green, w / 2, h / 2);

    for (gain, name) in [(20.0f32, "x20"), (100.0, "x100")] {
        let diff: Vec<f32> =
            before.iter().zip(&after).map(|(b, a)| 0.5 + (a - b) * gain).collect();
        pgm(&format!("{out}/action-{name}.pgm"), &diff, w, h);
    }

    // The same windows through the demosaic, lifted, so what a render would show of them is
    // watchable side by side. The window's origin is even, so its CFA is the frame's.
    let rcd = rawshim::demosaic::device(gpu).expect("the demosaic built");
    let rgb = |samples: &[f32]| {
        let uploaded = rawshim::condition::Mosaic::upload(gpu, samples, w, h);
        pollster::block_on(rawshim::demosaic::demosaic_plane(gpu, rcd, &uploaded, &cfa, |bytes| {
            bytes
                .chunks_exact(4)
                .map(|word| {
                    let linear = f32::from_ne_bytes([word[0], word[1], word[2], word[3]]);
                    ((linear * 8.0).clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0).round() as u8
                })
                .collect::<Vec<u8>>()
        }))
        .expect("demosaics")
    };
    let (rgb_before, rgb_after) = (rgb(&before), rgb(&after));

    // Per-row, per-slot mean change over the window's middle half, and the worst rows by it -
    // the numbers behind whatever the pictures show.
    let mut rows: Vec<(usize, [f32; 4])> = Vec::new();
    for row in 0..h {
        let mut sum = [0.0f64; 4];
        let mut count = [0usize; 4];
        for col in w / 4..3 * w / 4 {
            let at = row * w + col;
            let slot = (row & 1) | ((col & 1) << 1);
            sum[slot] += f64::from(after[at] - before[at]);
            count[slot] += 1;
        }
        let mut means = [0.0f32; 4];
        for slot in 0..4 {
            means[slot] = (sum[slot] / count[slot].max(1) as f64) as f32;
        }
        rows.push((row, means));
    }
    let peak = |m: &[f32; 4]| m.iter().fold(0.0f32, |acc, v| acc.max(v.abs()));
    let mut worst: Vec<_> = rows.clone();
    worst.sort_by(|a, b| peak(&b.1).total_cmp(&peak(&a.1)));
    eprintln!("worst rows by mean |change| (row: slot0 slot1 slot2 slot3):");
    for (row, means) in worst.iter().take(12) {
        eprintln!(
            "  {row:4}: {:+.5} {:+.5} {:+.5} {:+.5}",
            means[0], means[1], means[2], means[3]
        );
    }
    let ppm = |path: &str, data: &[u8]| {
        let mut bytes = format!("P6\n{w} {h}\n255\n").into_bytes();
        bytes.extend_from_slice(data);
        std::fs::write(path, bytes).expect("wrote");
        eprintln!("wrote {path}");
    };
    ppm(&format!("{out}/rgb-before.ppm"), &rgb_before);
    ppm(&format!("{out}/rgb-after.ppm"), &rgb_after);
}
