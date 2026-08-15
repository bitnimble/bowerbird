//! What has to hold for this crate to *run* in a browser, asked from the host.
//!
//! Compiling for `wasm32-unknown-unknown` is the build's job and `scripts/cargo.ts build --target
//! wasm32-unknown-unknown` is where it is checked. What a build cannot say is whether the thing it
//! linked would survive its first decode, and the two ways it would not are both host-testable:
//! a clock the target has no implementation of, and a decode with nothing to fall back to when
//! there is no device. Neither needs a browser to pin - one is a type, the other is a kernel.
//!
//! What genuinely does need one, and so is *not* asserted here, is named in the report and in
//! `docs/client-side-editing-plan.md`: that a real `GPUDevice` handed in from JS drives these
//! shaders, and that a wasm decode of a real RAW completes inside a tab's memory.

use rawshim::clock::Mark;

/// The clock reads and returns on both targets, which on wasm32 is the whole point.
///
/// `std::time::Instant::now` panics there, so every timed path in the crate goes through this
/// type instead. Off wasm it *is* `Instant`, so this also asserts the shim did not become a
/// stopped clock everywhere by accident.
#[test]
fn the_clock_reads_rather_than_panicking() {
    let mark = Mark::now();
    let mut total = 0u64;
    for value in 0..200_000u64 {
        total = total.wrapping_add(value * value);
    }
    std::hint::black_box(total);
    let elapsed = mark.elapsed();

    #[cfg(not(target_arch = "wasm32"))]
    assert!(elapsed > std::time::Duration::ZERO, "a native Mark is an Instant and must advance");
    #[cfg(target_arch = "wasm32")]
    assert_eq!(elapsed, std::time::Duration::ZERO, "a browser has no clock to report");
}

/// The laps run with the switch off and with it on, since the switch is read once at the start.
#[test]
fn the_laps_run_either_way() {
    let mut lap = rawshim::clock::laps("  test ");
    lap("first");
    lap("second");
}

/// Every module the wasm build compiles reaches the clock through `clock::Mark`.
///
/// A source scan rather than a compile, because the failure it guards against is a *new*
/// `Instant::now()` on the decode path, and that compiles perfectly well on both targets and then
/// panics in a browser on the first frame. The exceptions are listed by name and by reason, so
/// closing one fails this test rather than being forgotten.
#[test]
fn the_wasm_modules_read_the_clock_through_the_shim() {
    // `image.rs`, `lib.rs`: `#[ignore]`d benchmarks in test modules, which no browser builds.
    let known = ["image.rs", "lib.rs"];

    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut found: Vec<String> = Vec::new();
    for name in wasm_modules() {
        if name == "clock.rs" {
            continue;
        }
        let text = std::fs::read_to_string(src.join(&name))
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        if text.contains("Instant::now") {
            found.push(name);
        }
    }
    found.sort();

    assert_eq!(
        found, known,
        "a module the wasm build compiles reads `std::time::Instant` directly. `Instant::now` \
         panics on wasm32-unknown-unknown; route it through `clock::Mark` or `clock::laps`. If \
         one of the known sites was just fixed, drop it from the list here."
    );
}

/// The modules a plain `--no-default-features` build compiles, read off `lib.rs` rather than
/// listed here, so a module added tomorrow is scanned without anyone remembering to add it.
///
/// The wasm build is that build, and every `#[cfg]` in the declarations excludes a module from it
/// bar one: `renditions` is lensfun and libavif and the rest are test-only, while
/// `target_arch = "wasm32"` is the browser's own entry points and is in this build alone.
fn wasm_modules() -> Vec<String> {
    let lib = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
    let text = std::fs::read_to_string(&lib).expect("lib.rs reads");
    let mut out = vec!["lib.rs".to_string()];
    let mut gated = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("#[cfg(") {
            gated = line != r#"#[cfg(target_arch = "wasm32")]"#;
            continue;
        }
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if let Some(rest) = line.strip_prefix("pub mod ").or_else(|| line.strip_prefix("mod ")) {
            if let Some(name) = rest.strip_suffix(';') {
                if !gated {
                    out.push(format!("{name}.rs"));
                }
            }
        }
        gated = false;
    }
    assert!(out.contains(&"decode_rawler.rs".to_string()), "the module scan found nothing");
    assert!(out.contains(&"wasm.rs".to_string()), "the browser's own entry points went unscanned");
    for excluded in ["lensfun.rs", "job.rs", "pin.rs", "fixture_tests.rs"] {
        assert!(!out.contains(&excluded.to_string()), "{excluded} is not in a wasm build");
    }
    out
}

/// The names the page imports, which are `wasm.rs`'s to declare and nothing native's to notice.
///
/// The bindings are generated at build time, so a renamed export is a page that calls a function
/// the module does not have - and a native suite that stays green through it. Pinned by equality
/// so that adding one is as deliberate as renaming one, with the web side in the same commit.
#[test]
fn the_page_imports_the_entry_points_this_declares() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/wasm.rs");
    let text = std::fs::read_to_string(&src).expect("wasm.rs reads");
    let exported: Vec<&str> = text
        .lines()
        .filter_map(|line| line.trim().strip_prefix("#[wasm_bindgen(js_name = "))
        .filter_map(|rest| rest.strip_suffix(")]"))
        .collect();
    assert_eq!(exported, ["openGpuDevice", "decodeRaw", "prepareRaw"]);
}

/// The CPU demosaic reconstructs the picture, which is what makes it a fall-through rather than
/// a way to get a frame-shaped buffer of the wrong colours.
///
/// **On the field both algorithms are exact on.** RCD and PPG are not the same reconstruction -
/// `examples/demosaic_psnr.rs` measures the gap, and it is the reason taking this path logs - so
/// a general photograph cannot pin them against each other. A ramp with a constant offset per
/// channel can: constant colour difference is the assumption *both* interpolate under, so both
/// owe the truth to within rounding, and what is left to catch is the failure that actually
/// happens here - a transposed CFA, a shifted pattern, the wrong stride - each of which puts a
/// neighbour's colour in the pixel and shows up immediately.
#[test]
fn the_cpu_demosaic_reconstructs_what_rcd_does() {
    let (w, h) = (96usize, 96usize);
    let cfa = [0u32, 1, 1, 2];
    let truth = |r: usize, c: usize, channel: usize| -> f32 {
        let (x, y) = (c as f32 / w as f32, r as f32 / h as f32);
        let base = 0.3 + 0.3 * x + 0.2 * y;
        base + match channel {
            0 => 0.10,
            1 => 0.0,
            _ => -0.05,
        }
    };
    let mosaic: Vec<f32> = (0..h)
        .flat_map(|r| (0..w).map(move |c| truth(r, c, cfa[(r & 1) * 2 + (c & 1)] as usize)))
        .collect();

    let cpu = rawshim::demosaic::cpu(&mosaic, w, h, cfa).expect("the CPU demosaic runs");
    assert_eq!(cpu.len(), w * h * 3, "interleaved RGB over the whole mosaic");

    // A pattern RCD turns away must not come back through the CPU instead, or which sensors the
    // product reads would depend on whether the host had a GPU.
    assert!(
        rawshim::demosaic::cpu(&mosaic, w, h, [0, 1, 2, 1]).is_none(),
        "the CPU demosaic accepted a pattern that is not two greens on a diagonal",
    );

    // Away from the border, which PPG fills by a cheaper rule exactly as RCD's margin does.
    let margin = rawshim::demosaic::MARGIN as usize;
    let interior = || (margin..h - margin).flat_map(move |r| (margin..w - margin).map(move |c| (r, c)));

    let mut worst = 0f32;
    for (r, c) in interior() {
        for channel in 0..3 {
            worst = worst.max((cpu[(r * w + c) * 3 + channel] - truth(r, c, channel)).abs());
        }
    }
    // Well under the 0.05 between blue and green in this field, which is the smallest thing a
    // shifted or transposed pattern could put in the wrong pixel.
    assert!(worst < 1e-3, "the CPU demosaic is off the truth by {worst}");

    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("no adapter: the CPU demosaic was not held against RCD, only against the truth");
        return;
    };
    let Some(rcd) = rawshim::demosaic::device(gpu) else {
        eprintln!("no RCD pipelines: the CPU demosaic was not held against RCD");
        return;
    };
    let uploaded = rawshim::condition::Mosaic::upload(gpu, &mosaic, w, h);
    let gpu_rgb = pollster::block_on(rawshim::demosaic::demosaic_with(
        gpu,
        rcd,
        &uploaded,
        cfa,
        |bytes| {
            bytes
                .chunks_exact(4)
                .map(|word| f32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
                .collect::<Vec<f32>>()
        },
    ))
    .expect("the demosaic runs");

    let mut apart = 0f32;
    for (r, c) in interior() {
        for channel in 0..3 {
            let at = (r * w + c) * 3 + channel;
            apart = apart.max((cpu[at] - gpu_rgb[at]).abs());
        }
    }
    assert!(apart < 1e-3, "the two demosaics disagree by {apart} on a field both reconstruct");
}
