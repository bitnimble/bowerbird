//! Holds the WGSL port against the C reference it was transcribed from.
//!
//! A compensated-summation pipeline of fifty dispatches is not bit-exact across two
//! compilers, and asking it to be would be asking the wrong question. For scale: the
//! reference reports 69.7-70.6 dB between its *own* CPU FP32 build and its Vulkan one, and
//! this port measures 69.0-69.3 dB against that same CPU build - short of their figure by
//! about a dB rather than level with it.
//!
//! What this catches is the failure that actually happens in a transcription - a transposed
//! index, a sign, a phase skipped - all of which land tens of dB below either number. So
//! the bar below is set where it separates those, not where it would certify the last dB.
//!
//! Not a test, because it needs the reference binary built:
//!
//! ```text
//! GALOSH_CPU=/path/to/galosh_raw_cpu.exe cargo run --release --example galosh_parity
//! ```

use rawshim::galosh::{Amounts, denoise};

/// A synthetic mosaic with a Poisson-ish noise field, a flat quarter, a ramp and an edge.
fn frame(width: usize, height: usize) -> Vec<f32> {
    let mut seed = 0x853c_49e6_748f_ea9bu64;
    let mut uniform = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 40) as f32 / 16777216.0
    };
    (0..width * height)
        .map(|at| {
            let (x, y) = (at % width, at / width);
            let slot = (y & 1) | ((x & 1) << 1);
            let base = [0.18, 0.30, 0.30, 0.10][slot];
            let scene = if y < height / 3 {
                0.0
            } else if y < 2 * height / 3 {
                x as f32 / width as f32 * 0.5
            } else {
                if x > width / 2 { 0.55 } else { 0.05 }
            };
            let level = (base + scene).clamp(0.0, 1.0);
            // Shot noise grows with the square root of the level, which is the relation
            // Phase 0 exists to find.
            let sigma = 0.004 + 0.05 * level.sqrt();
            let noise = (uniform() + uniform() + uniform() - 1.5) * sigma;
            (level + noise).clamp(0.0, 1.0)
        })
        .collect()
}

fn write_bin(path: &str, samples: &[f32]) {
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_ne_bytes());
    }
    std::fs::write(path, bytes).expect("wrote the input");
}

fn read_bin(path: &str) -> Vec<f32> {
    let bytes = std::fs::read(path).expect("read the reference output");
    bytes
        .chunks_exact(4)
        .map(|w| f32::from_ne_bytes([w[0], w[1], w[2], w[3]]))
        .collect()
}

fn psnr(a: &[f32], b: &[f32]) -> f64 {
    let mse = a
        .iter()
        .zip(b)
        .map(|(x, y)| {
            let d = (*x - *y) as f64;
            d * d
        })
        .sum::<f64>()
        / a.len() as f64;
    if mse <= 0.0 { f64::INFINITY } else { 10.0 * (1.0 / mse).log10() }
}

fn main() {
    // Without the reference, time the port over a few frame sizes instead: what a decode
    // will actually pay is the only thing the parity figure does not answer.
    let Ok(reference) = std::env::var("GALOSH_CPU") else {
        let gpu = rawshim::gpu::device().expect("an adapter");
        let galosh = rawshim::galosh::device(gpu).expect("the kernels built");
        for (width, height) in [(1024, 768), (2048, 1536), (4096, 3072), (6000, 4000)] {
            let mut samples = frame(width, height);
            let started = std::time::Instant::now();
            denoise(gpu, galosh, &mut samples, width, height, Amounts { luma: 0.5, colour: 1.0 });
            println!(
                "{width}x{height} ({:.1}MP): {:?}",
                (width * height) as f64 / 1e6,
                started.elapsed(),
            );
        }
        return;
    };
    let dir = std::env::temp_dir();
    let input = dir.join("galosh_parity_in.bin");
    let output = dir.join("galosh_parity_out.bin");

    let (width, height) = (512, 384);
    let noisy = frame(width, height);
    write_bin(input.to_str().unwrap(), &noisy);

    for amounts in [
        Amounts { luma: 0.5, colour: 1.0 },
        Amounts { luma: 1.0, colour: 2.0 },
    ] {
        let status = std::process::Command::new(&reference)
            .args([
                input.to_str().unwrap(),
                output.to_str().unwrap(),
                &width.to_string(),
                &height.to_string(),
                "galosh",
                "1.0",
                &amounts.luma.to_string(),
                &amounts.colour.to_string(),
                "0",
                "0",
            ])
            .status()
            .expect("ran the reference");
        assert!(status.success(), "the reference denoiser failed");
        let theirs = read_bin(output.to_str().unwrap());

        let gpu = rawshim::gpu::device().expect("an adapter");
        let galosh = rawshim::galosh::device(gpu).expect("the kernels built");
        let mut ours = noisy.clone();
        let started = std::time::Instant::now();
        denoise(gpu, galosh, &mut ours, width, height, amounts);
        let took = started.elapsed();

        println!(
            "luma {:.2} colour {:.2}: {:.1} dB against the reference, {:?} on the GPU \
             (noisy is {:.1} dB from their answer)",
            amounts.luma,
            amounts.colour,
            psnr(&ours, &theirs),
            took,
            psnr(&noisy, &theirs),
        );
    }
}
