//! What one round trip to the device costs, which is what decides whether a sequential search can
//! live on it.
//!
//! ```text
//! gpu_latency
//! ```
//!
//! The camera match is the pipeline's largest CPU stage, and the obvious answer to that is a
//! shader. Most of the match is embarrassingly parallel - a distance over a hundred and fifty
//! thousand pairs, a template match over eighty-one offsets - so the arithmetic would go far
//! faster on a device that is idle 46% of the time anyway.
//!
//! But two of its loops are sequential by construction. `fit_family`'s refine takes about
//! twenty-four full-grid residuals, each comparing against a value the last one may have moved, and
//! `fitted_saturation`'s golden section takes eleven probes the same way. On the device those stop
//! being arithmetic and become a submit, a wait and a readback each - and *that* number is what
//! this measures, because no shader speed can pay for it.
//!
//! Three rows, because they bound the answer from different sides: an empty submit is the floor, a
//! submit that waits is what a dependent step actually pays, and a readback is what a step needs
//! before the host can branch on it.

fn main() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("gpu_latency: no adapter");
        std::process::exit(2);
    };
    // One recording for the whole run: what is being timed is the submit and the map, and a pool
    // per round would time the allocator instead.
    let mut held = gpu.record();
    let scratch = held.buffer(&wgpu::BufferDescriptor {
        label: Some("latency scratch"),
        size: 256,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let staging = held.buffer(&wgpu::BufferDescriptor {
        label: Some("latency staging"),
        size: 256,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    const ROUNDS: usize = 200;
    let median = |mut taken: Vec<f64>| {
        taken.sort_by(|a, b| a.partial_cmp(b).expect("no NaN in a wall time"));
        (taken[ROUNDS / 2], taken[0], taken[ROUNDS - 1])
    };

    let submit_only = median(
        (0..ROUNDS)
            .map(|_| {
                let began = std::time::Instant::now();
                let mut round = gpu.record();
                round.encoder();
                round.submit();
                began.elapsed().as_secs_f64() * 1000.0
            })
            .collect(),
    );

    let submit_wait = median(
        (0..ROUNDS)
            .map(|_| {
                let began = std::time::Instant::now();
                let mut round = gpu.record();
                round.encoder();
                round.submit();
                pollster::block_on(rawshim::gpu::finished(gpu));
                began.elapsed().as_secs_f64() * 1000.0
            })
            .collect(),
    );

    let round_trip = median(
        (0..ROUNDS)
            .map(|_| {
                let began = std::time::Instant::now();
                let mut round = gpu.record();
                round.encoder().copy_buffer_to_buffer(&scratch, 0, &staging, 0, 256);
                round.submit();
                pollster::block_on(rawshim::gpu::read_back(gpu, &staging, |bytes| bytes.len()));
                began.elapsed().as_secs_f64() * 1000.0
            })
            .collect(),
    );

    println!("{}", gpu.adapter);
    println!("  median of {ROUNDS}, milliseconds");
    for (what, (mid, low, high)) in [
        ("submit, no wait", submit_only),
        ("submit and wait", submit_wait),
        ("submit, wait, read back", round_trip),
    ] {
        println!("    {what:<24} {mid:>7.3}   ({low:.3} - {high:.3})");
    }

    let step = round_trip.0;
    println!();
    println!("  a sequential search of N steps therefore pays N x {step:.3}ms before any shader runs:");
    for steps in [11, 24, 35] {
        println!("    {steps:>3} steps   {:>7.2}ms", steps as f64 * step);
    }
}
