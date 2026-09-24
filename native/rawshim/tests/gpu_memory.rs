//! Every stage gives its device memory back.
//!
//! **The one claim no other suite can make.** Native wgpu frees on the last reference whether or
//! not `destroy` was called, so a browser leak passes every other fixture here unmarked.
//! `gpu::live_bytes` is what makes it visible on this host.
//!
//! **One test, not three.** The count is one process-wide atomic, and libtest runs `#[test]`s on
//! parallel threads: a second test allocating inside this one's before-and-after window reads as a
//! leak, or hides one. Measured at three failures in ten before these were folded together.

use rawshim::galosh::Amounts;

const WIDTH: usize = 256;
const HEIGHT: usize = 192;

/// RGGB, which is what every Bayer path here assumes.
const CFA: [u32; 4] = [0, 1, 1, 2];

/// A mosaic with texture in it, so the denoise has something to do and no phase is skipped over a
/// flat field.
fn textured() -> Vec<f32> {
    let mut samples = Vec::with_capacity(WIDTH * HEIGHT);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let hash = (x.wrapping_mul(1103) ^ y.wrapping_mul(2749)) % 997;
            let grain = hash as f32 / 997.0 - 0.5;
            let ramp = (x + y) as f32 / (WIDTH + HEIGHT) as f32;
            samples.push((0.2 + ramp * 0.5 + grain * 0.05).clamp(0.0, 1.0));
        }
    }
    samples
}

/// Runs `once` three times and asserts the count came back to where it started.
///
/// A warm-up first, and then the measured runs: anything a stage builds on its first call and keeps
/// for the life of the process is a hold rather than a leak, and would otherwise be indexed as one.
fn gives_it_back(what: &str, mut once: impl FnMut()) {
    once();
    let before = rawshim::gpu::live_bytes();
    for _ in 0..3 {
        once();
    }
    let after = rawshim::gpu::live_bytes();
    assert_eq!(
        after, before,
        "three runs of the {what} left {} bytes behind, which in a browser is memory nothing frees",
        after.saturating_sub(before),
    );
}

#[test]
fn every_stage_hands_its_working_planes_back() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so nothing here was run.");
        return;
    };
    let samples = textured();

    // GALOSH takes about five frames of working planes - the two full-resolution scratch planes and
    // the half- and quarter-resolution trios - and none of it may outlive the call.
    match rawshim::galosh::device(gpu) {
        None => eprintln!("SKIPPED: this adapter has no room for pass12's tile."),
        Some(kernels) => gives_it_back("denoise", || {
            let mosaic = rawshim::condition::Mosaic::upload(gpu, &samples, WIDTH, HEIGHT);
            pollster::block_on(rawshim::galosh::denoise(
                gpu,
                kernels,
                &mosaic,
                &rawshim::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB is a pattern"),
                Amounts::from_sliders(50.0, 50.0),
            ));
        }),
    }

    // RCD's nine planes, which the tiled walk takes per tile rather than once.
    match rawshim::demosaic::device(gpu) {
        None => eprintln!("SKIPPED: this adapter would not build RCD."),
        Some(rcd) => gives_it_back("demosaic", || {
            let mosaic = rawshim::condition::Mosaic::upload(gpu, &samples, WIDTH, HEIGHT);
            pollster::block_on(rawshim::demosaic::demosaic_plane(
                gpu,
                rcd,
                &mosaic,
                &rawshim::cfa::Cfa::bayer(CFA).unwrap(),
                |plane| plane.len(),
            ));
        }),
    }

    // The defringe's luma plane and the sharpen's four, which the tiled render path pays per tile
    // rather than once.
    let frame: Vec<u16> = (0..WIDTH * HEIGHT * 3).map(|at| (at % 4096) as u16).collect();
    match rawshim::base::device(gpu) {
        None => eprintln!("SKIPPED: this adapter would not build the base pipelines."),
        Some(base) => {
            gives_it_back("defringe", || {
                let resident = rawshim::resident::Resident::upload(gpu, &frame, WIDTH, HEIGHT);
                pollster::block_on(rawshim::base::correct(
                    gpu,
                    base,
                    &resident,
                    rawshim::image::Strengths { sharpen: 0.0, defringe: 0.5 },
                    // Given rather than measured, so the readback that measuring would do is not
                    // what this is timing the memory of.
                    Some((0.4, 0.3)),
                    None,
                    None,
                ));
                resident.reclaim();
            });
            gives_it_back("sharpen", || {
                let mut samples = frame.clone();
                pollster::block_on(rawshim::base::sharpen_base(
                    gpu, base, &mut samples, WIDTH, HEIGHT, 0.5, 1.0,
                ));
            });
        }
    }

    // What the editor pays per band sweep: `refresh_detail` replaces the whole `Uploaded`, and what
    // it holds is the blur, the chroma smoothing, the lattice, the curves and - once anything
    // encodes - a frame each of counts and readback.
    let level = rawshim::light::Light::measured;
    let levels =
        rawshim::tone::Levels { white: level(4095.0), peak: level(4095.0), floor: None }.anchored();
    let grade = rawshim::gpu::Grade::new(
        WIDTH,
        HEIGHT,
        *levels,
        rawshim::light::Light::exactly(203.0),
        rawshim::light::Light::exactly(1000.0),
    );
    let peak = gpu.scene_peak();
    gives_it_back("upload", || {
        let uploaded = gpu.upload(&frame, &grade, &peak);
        // Encoded as well as uploaded: the counts and the readback are built on the first `encode`,
        // and they are per-`Uploaded` rather than per-device, so they have to go with this one.
        let _ = uploaded.encode(&grade);
    });
}
