//! Where the eight seconds go when the chain runs before a CPU stage.
//!
//! ```text
//! chain_probe <raw>
//! ```
//!
//! Wiring `base::prepare` into `edit::open` made the coding, the defringe and the warp 1097ms
//! against the CPU's 1706ms - and `noise::measure` after it went from 983ms to 7910ms, on the CPU
//! as well as on the GPU, with 23GB free. Reverted pending this.
//!
//! The open is too coarse to say why: it times the whole of `payload`, and the chain and the
//! measure differ in two things at once - what ran before, and what the frame now holds. This runs
//! the two paths over one decode and separates them: the same measure after each, the frames
//! compared sample for sample, and the measure repeated so a first-call cost is visible as one.

fn main() {
    let path = std::env::args().nth(1).expect("chain_probe <raw>");
    let bytes = std::fs::read(&path).expect("the RAW reads");

    let frame =
        rawshim::decode_frame_bytes(&bytes, 16, true, 0, rawshim::galosh::Fit::Only).expect("decode");
    let source = rawshim::hdr::Source {
        samples: frame.samples16().expect("16-bit"),
        width: frame.width,
        height: frame.height,
    };
    let grade = rawshim::hdr::Grade {
        peak_nits: 1000.0,
        reference_white_nits: 203.0,
        white_quantile: 0.995,
    };
    let prepared = rawshim::hdr::prepare(&source, None, &grade);
    let (width, height) = (prepared.width, prepared.height);
    let levels = prepared.levels.anchored();
    let strengths = rawshim::image::Strengths { sharpen: 1.0, defringe: 1.0 };
    println!("frame {width}x{height}, {} samples", prepared.samples.len());

    let gpu = rawshim::gpu::device().expect("a GPU");
    let base = rawshim::base::device(gpu).expect("the base pipelines");

    // The CPU's own, which is what the open did before any of this.
    let mut theirs = prepared.samples.clone();
    let began = std::time::Instant::now();
    rawshim::tone::encode_base(&mut theirs, levels, grade.reference_white_nits);
    rawshim::hdr::filter_base(&mut theirs, width, height, strengths.before_the_fit());
    println!("cpu  code+defringe   {:>6}ms", began.elapsed().as_millis());
    // The sharpen sits between the chain and the measure in a real open, and is the only thing
    // the isolated probe was missing.
    let began = std::time::Instant::now();
    rawshim::hdr::filter_base(&mut theirs, width, height, sharpen_only(strengths));
    println!("cpu  sharpen        {:>6}ms", began.elapsed().as_millis());
    time_measure("cpu  measure", &theirs, width, height);
    time_measure("cpu  measure again", &theirs, width, height);

    // The chain, over the same input.
    let cpu_defocus =
        rawshim::image::measurements(&{
            let mut coded = prepared.samples.clone();
            rawshim::tone::encode_base(&mut coded, levels, grade.reference_white_nits);
            coded
        }, width, height, strengths.before_the_fit());
    let gpu_defocus = {
        let mut coded = prepared.samples.clone();
        rawshim::tone::encode_base(&mut coded, levels, grade.reference_white_nits);
        rawshim::base::measure_defocus(gpu, base, &coded, width, height)
    };
    // Both printed, though neither is handed to `prepare` any more: it measures its own off the
    // frame it has just coded. What they are for is the agreement itself, which is what said the
    // reduction was right before it went into the chain.
    println!("defocus cpu {cpu_defocus:?} gpu {gpu_defocus:?}");

    let began = std::time::Instant::now();
    let mine = rawshim::base::prepare(
        gpu,
        base,
        &prepared.samples,
        (width, height),
        (width, height),
        levels,
        grade.reference_white_nits,
        strengths.before_the_fit(),
        &lens(width, height),
    )
    .expect("the chain runs");
    println!("gpu  chain          {:>6}ms", began.elapsed().as_millis());
    let mut mine = mine;
    let began = std::time::Instant::now();
    rawshim::hdr::filter_base(&mut mine, width, height, sharpen_only(strengths));
    println!("gpu  sharpen        {:>6}ms", began.elapsed().as_millis());
    time_measure("gpu  measure", &mine, width, height);
    time_measure("gpu  measure again", &mine, width, height);

    // What the two frames actually hold, since "it ran before" and "it produced this" are two
    // different explanations and only one of them is about the samples.
    let worst = theirs.iter().zip(&mine).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
    let zeros = |f: &[u16]| f.iter().filter(|v| **v == 0).count();
    println!(
        "frames: worst {worst}, zeros cpu {} gpu {}",
        zeros(&theirs),
        zeros(&mine),
    );
}

/// A lens with every correction on it, since the warp is the one stage that needs a second
/// whole-frame buffer and so the only one whose absence changes what the chain holds.
fn lens(width: usize, height: usize) -> rawshim::fit::Lens {
    let knots = vec![0.0, 40.0, 160.0, 380.0];
    rawshim::fit::Lens {
        crop: rawshim::image::fill_crop(&knots, width, height),
        distortion: Some(knots),
        falloff: Some((0.25, 0.1)),
        ..rawshim::fit::Lens::none()
    }
}

/// Everything but the sharpen zeroed, which is what the open runs after the warp.
fn sharpen_only(strengths: rawshim::image::Strengths) -> rawshim::image::Strengths {
    rawshim::image::Strengths { sharpen: strengths.sharpen, ..Default::default() }
}

fn time_measure(label: &str, samples: &[u16], width: usize, height: usize) {
    let began = std::time::Instant::now();
    let noise = rawshim::noise::measure(samples, width, height);
    println!(
        "{label:<20}{:>6}ms  stabilised {:.6} alpha {:.3e}",
        began.elapsed().as_millis(),
        noise.stabilised,
        noise.alpha,
    );
}
