//! What `dust::detect` finds on one photograph.
//!
//! ```text
//! dust_probe <raw>...
//! ```
//!
//! **A measurement, not a check.** The suites pin the arithmetic against frames this crate builds
//! and the placing against the fixtures; neither can say whether a real body's particles are found,
//! because the committed fixtures were shot wide open and a shadow at f/2.8 is the pupil's image of
//! something too small to survive it. The aperture is printed for that reason: a frame under about
//! f/8 reporting nothing is physics rather than a regression.
//!
//! Prints one line per particle - where, how confident, how deep - so a body can be checked against
//! what is actually on its glass.

/// This process's high-water mark, in megabytes, as the kernel has been keeping it.
///
/// Read rather than sampled: a watcher polling `/proc` can only catch a peak it happens to look
/// during, and the largest thing the search asks the allocator for - the mask, crossing back off the
/// device - is allocated and given back inside one call.
///
/// **Host memory only, which is now most of the story rather than all of it.** The working planes
/// live on the device, and nothing here can see them; what this measures is what a browser worker's
/// 32-bit address space has to hold.
fn peak_mb() -> f64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    status
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .and_then(|rest| rest.trim().split_whitespace().next()?.parse::<f64>().ok())
        .map_or(0.0, |kb| kb / 1024.0)
}

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("usage: dust_probe <raw>...");
        return;
    }
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("no Vulkan adapter answered");
        return;
    };

    for path in files {
        let Ok(bytes) = std::fs::read(&path) else {
            eprintln!("{path}: could not be read");
            continue;
        };
        let header = rawshim::header::read_path(&path);
        let aperture = header.as_ref().map_or(0.0, |header| header.aperture);

        let started = std::time::Instant::now();
        let Some(held) = pollster::block_on(rawshim::decode_rawler::hold_bytes(&bytes)) else {
            eprintln!("{path}: no decoder read these bytes");
            continue;
        };
        let sensor = held.glass();
        // Overridable, so the cost of *this body* can be asked at an aperture it would look at even
        // where the frame to hand was shot wide open - which is most of them.
        let aperture = std::env::var("DUSTPROBE_APERTURE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(aperture);
        let sensor = rawshim::dust::Sensor { aperture, ..sensor };
        let read = started.elapsed().as_millis();
        let held_mb = peak_mb();

        // Split, because they are paid at different times: the read is the open's either way, the
        // search is what switching this on costs once, and the correction is what every band, every
        // loupe tile and every rendition pays again.
        let at = std::time::Instant::now();
        let spots =
            pollster::block_on(rawshim::dust::detect(gpu, held.device_mosaic(), &sensor))
                .unwrap_or_default();
        let found = at.elapsed().as_millis();
        let detected_mb = peak_mb();

        // **Against a readback either side, differenced.** A submit returns before the GPU has done
        // anything, so the only way to time a dispatch is to wait for something after it - and a
        // whole-frame readback is far the larger of the two, so it has to be subtracted rather than
        // included. The first read also warms the pipeline this would otherwise be timing the build
        // of.
        const RUNS: u32 = 32;
        let copy = held.device_mosaic().duplicate(gpu);
        let at = std::time::Instant::now();
        pollster::block_on(copy.read(gpu));
        let idle = at.elapsed();
        let at = std::time::Instant::now();
        // Many, then divided: one dispatch is a fraction of the readback that has to be waited on
        // to see it at all, so timing a single one measures the noise on the readback instead.
        for _ in 0..RUNS {
            rawshim::dust::correct(
                gpu,
                rawshim::dust::device(gpu),
                &copy,
                &spots,
                rawshim::dust::Removal { sensitivity: 0.5, intensity: 1.0 },
                (0, 0),
            );
        }
        pollster::block_on(copy.read(gpu));
        let corrected = at.elapsed().saturating_sub(idle).as_micros() / u128::from(RUNS);

        println!(
            "== {path}\n   {}x{}  f/{aperture}  read 1/{} of the sites  {} particles\n   \
             read+condition {read}ms  search {found}ms  correct {corrected}us\n   \
             peak {detected_mb:.0}MB host, of which the decode {held_mb:.0}MB - \
             the search adds {:.0}MB",
            sensor.width,
            sensor.height,
            2 * sensor.shrink() * (2 * sensor.shrink()),
            spots.len(),
            detected_mb - held_mb,
        );
        for spot in spots.iter().take(40) {
            println!(
                "   ({:6.0},{:6.0})  snr {:5.1}  depth {:.4}  radius {:4.1}  axes {:.2}:{:.2}",
                spot.x * 2.0,
                spot.y * 2.0,
                spot.snr,
                spot.profile[0],
                spot.scale,
                spot.axes.0,
                spot.axes.1,
            );
        }
        if spots.len() > 40 {
            println!("   ... and {} more", spots.len() - 40);
        }
    }
}
