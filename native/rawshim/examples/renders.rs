//! What the editor shows, which is what a rendition ships, from the same RAW, without a browser.
//!
//! ```text
//! renders <raw> <out-dir> [--detail N|auto] [--denoiser galosh|pmrid] [--crop x,y,side]... [--sharpen N] [--no-lens] [--encode q,420|444|--sdr|--linear]
//!         [--as-export] [--defocus r,b] [--phases 2|4|8|16] [--pool 0|1]
//!         [--chroma-detail 0|1] [--reach N] [--ratio-floor N]
//!         [--ev N] [--edge N]
//!         [--camera-crop <dir>]
//! ```
//!
//! A render is a specification and nothing else - a decode, a set of edits, a size - so it belongs
//! here rather than in Playwright. The editor's tick is the one that looks like it needs a browser
//! and does not: `gpu.rs` runs the same grade shaders the client does.
//!
//! One render, because the editor and a rendition are one pipeline: the denoise is on the mosaic
//! in `galosh.rs` and everything downstream is shared code on one host.
//!
//! With no `--crop` it writes each render whole, reduced to 1600 on the long edge, which is where
//! to start when looking for somewhere worth cutting. Crops are in the frame's own pixels and are
//! written at 1:1, because noise and texture are invisible in a downscale.

use rawshim::hdr::{self, Grade};
use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::image::Strengths;
use rawshim::light::{Light, Stops};

/// Which stages of the chain below the decode this render is to run.
///
/// The two that a synthetic frame cannot bring with it and that a photograph always does: a lens to
/// correct, and the deconvolution that follows the correcting. Both on is what an export is; either
/// off is how to find out which of them a reader is looking at.
#[derive(Clone, Copy)]
struct Stages<'a> {
    sharpen: f64,
    /// The blur the deconvolution is told to invert, where the measurement is not to be trusted.
    ///
    /// `deconvolve_split` composes this off the frame's own measured edge spread, which is an
    /// estimate over whatever edges the photograph happens to hold. Overriding it is how to ask
    /// whether an under-sharpened render is under-sharpened because the amount is low or because
    /// the sigma is.
    sharpen_sigma: Option<f32>,
    /// How hard to take the colour off a fringing edge. Held still like the rest, because it is
    /// the one stage besides the colour denoise whose job is *removing* chroma, and a palette
    /// that came out narrow has to be asked of it before anything downstream is blamed.
    defringe: f64,
    lens: bool,
    /// Whether the camera match colours the render, or the neutral arm does. Off renders what the
    /// grade does with no body to imitate, which is the picture the match has to beat.
    matched: bool,
    /// The match without its chroma lattice, which is the one piece of it indexed by a pixel's
    /// surroundings rather than by the pixel - so the one piece that can carry a neighbourhood's
    /// colour into a pixel that is not that colour.
    lattice: bool,
    /// The match without its 3x3, which is the one piece that can flatten a whole direction of
    /// colour space at once and so send two colours to the same place.
    matrix: bool,
    /// The match without its saturation, the other way two colours run together: a scalar under
    /// one pulls everything toward grey, and what is already near grey has furthest to fall.
    saturation: bool,
    /// The match with one tone curve shared by all three channels instead of its own for each.
    /// Three curves that part company at the bottom are what tints a near-neutral, so this says
    /// whether they did.
    curves: bool,
    /// The match with no tone curve at all, only its matrix and saturation. What a fitted curve
    /// flattens it cannot un-flatten, so this is the one that says whether the shape is the fault.
    tone: bool,
    /// A factor on the fitted saturation, for asking how much of the measured chroma deficit a
    /// scalar about grey can close and what it costs elsewhere.
    chroma: f64,
    /// The reader's own sliders, for asking what is left once a grade has done all it can.
    ///
    /// The low pair are here because where they *land* depends on the photo,
    /// so what they do can only be asked of a real frame. None is the camera match's own.
    contrast: f64,
    saturation_adjust: f64,
    blacks: f64,
    shadows: f64,
    texture: f64,
    clarity: f64,
    /// The fitted curves' slope, expanded about their own middle. A regression whose predictor
    /// carries noise reports a slope biased toward flat, and the curves have no de-attenuation
    /// where the lattice has one, so this asks whether that is what the tone deficit is.
    curve_gain: f64,
    /// The focus difference to correct, where the caller would rather say than have it measured.
    defocus: Option<(f32, f32)>,
    /// The reader's exposure, in stops, or None for the camera match's own.
    ev: Option<Stops>,
    /// Which domain the crop is written in.
    ///
    /// `Pq` is what `rendition_hdr` actually serves and what a picture bug is reproduced against,
    /// written as the high byte of each code so nothing is tone mapped. `Srgb` is a reader's SDR
    /// copy, which is what someone opts into. `Linear` is the rolled frame before
    /// any transfer, scaled so diffuse white is 255 - the one view where a modulation is as large
    /// as the light it is a modulation of, both codings having been built to compress exactly
    /// that.
    domain: Domain,
    /// A PQ render goes through the rendition's AVIF encoder and back before it is cut, at this
    /// quantizer and chroma. `max` ships at `(1, Yuv420)`; `(0, Yuv444)` is the pipeline's own
    /// codes in a file `avif_crop` can measure, and the gap between the two is the encoder's.
    encode: Option<(i32, Chroma)>,
    /// Where that encoded still is kept, beside the crops.
    out: &'a str,
}

#[derive(Clone, Copy, PartialEq)]
enum Domain {
    Srgb,
    Pq,
    Linear,
}

/// How the crop is written, which is a stage of the pipeline like any other.
#[derive(Clone, Copy)]
struct File {
    quantizer: i32,
    full_chroma: bool,
}

/// The grade both paths are rendered through. The library's own defaults, so neither render is
/// answering a question about settings.
fn grade() -> Grade {
    Grade {
        peak_nits: Light::exactly(1000.0),
        reference_white_nits: Light::exactly(203.0),
        white_quantile: 0.9,
    }
}

fn strengths() -> Strengths {
    Strengths { sharpen: 0.5, defringe: 1.0 }
}

/// `edge` of 0 is no reduction, which is the default: a crop at 1:1 is the point, and the editor is
/// not reducing either. Anything else renders as a rendition of that size *does* - through
/// `Cut::from_base`, and so through the downscale a rendition actually uses - which is the only way
/// to look at what that stage did to an edge.
fn options(edge: usize, stages: Stages<'_>) -> EncodeOptions {
    EncodeOptions {
        still_chroma: Chroma::Yuv444,
        output_path: String::new(),
        grade: grade(),
        crf: 26,
        preset: 6,
        strengths: Strengths { sharpen: stages.sharpen, defringe: stages.defringe },
        sharpen_sigma: None,
        max_edge: match edge {
            0 => 100_000.0,
            edge => edge as f64,
        },
    }
}

/// The rendition path: denoised inside the decode, on the mosaic, then fitted and graded.
///
/// `job::Base::build` in miniature, at the sensor's own size.
fn rendition(
    path: &str,
    detail: rawshim::galosh::Detail,
    edge: usize,
    stages: Stages<'_>,
) -> (Vec<u8>, usize, usize) {
    // **`Fit::Only` measures and filters nothing**, which is what `--detail 0` wants and no other
    // level does: the defringe's noise ceiling comes off a fit, so without this the sliders at zero
    // would compare renders whose defringe never saw the frame's noise.
    let fit = match detail.could_do_anything() {
        true => rawshim::galosh::Fit::Measure,
        false => rawshim::galosh::Fit::Only,
    };
    let frame = rawshim::decode_frame_denoised(path, 0, detail, fit).expect("decode");
    // Against the fit the decode came back holding, which is what an unset slider was resolved from.
    eprintln!(
        "  fit {:?} amounts {:?}",
        frame.noise.map(|n| n.model()),
        detail.amounts(frame.noise),
    );
    let samples = frame.samples16().expect("16-bit").to_vec();
    graded(path, &frame, &samples, edge, stages)
}

/// The rendition's tail: fit the camera match off the frame, then cut and grade it to sRGB.
///
/// **`job::Base::build`'s own chain**, rather than `hdr::graded_as`, which runs neither the
/// defringe nor a measured sigma: its `cut_for` codes by hand and sharpens at the fixed
/// default, where an export defringes on the linear frame and deconvolves the capture's own
/// blur. A harness one stage short of the export is the wrong picture to be looking at an
/// edge in.
///
/// `base::prepare` rather than `hdr::code_base` for the same reason one step earlier. It is the
/// defringe as well as the coding, and the defringe is a shader on the linear frame - so coding by
/// hand leaves a harness that cannot see a fringe, which is half of what it is opened to look for.
/// `before_the_fit` is what keeps the sharpen out of it; `Cut::from_base` runs it after the warp.
fn graded(
    path: &str,
    frame: &rawshim::frame::Frame,
    samples: &[u16],
    edge: usize,
    stages: Stages<'_>,
) -> (Vec<u8>, usize, usize) {
    let options = options(edge, stages);
    // **One quantile, because the fit and the anchor have to be the same white.** `open::measure`
    // hands the fit `grade.white_quantile` and anchors the grade on it too; fitted against a frame
    // normalised by one white and applied to a frame anchored on another, the camera match's tone
    // curves land at the ratio between them - which is most of a picture's brightness.
    let gpu = rawshim::gpu::device().expect("a Vulkan adapter, since the grade is a shader");
    let resident = frame.on_device(gpu).expect("the frame reaches the device");
    let matched = rawshim::fit_hdr_for(&resident, path, options.grade.white_quantile);
    let levels =
        rawshim::hdr::levels_of(gpu, samples, frame.width, frame.height, options.grade.white_quantile)
            .expect("levels")
            .anchored();
    // The anchor and what the match made of it, because a render that came out the wrong colour
    // is answered by the matrix row that did it and not by looking harder at the picture.
    // The floor in stops as well as levels says whether the frame reached the
    // zone where a render's Blacks control can act.
    let floor = levels.floor.map_or(f64::NEG_INFINITY, |f| f.raw());
    eprintln!(
        "  white {:.0} peak {:.0} floor {floor:.0} ({:.2} stops under white)",
        levels.white.raw(),
        levels.peak.raw(),
        (floor.max(1.0 / 65536.0) / levels.white.raw()).log2(),
    );
    if let Some(colour) = matched.as_ref().and_then(|m| m.colour.as_ref()) {
        let rows: Vec<String> = colour
            .matrix
            .iter()
            .map(|row| format!("[{}]", row.map(|v| format!("{v:+.3}")).join(" ")))
            .collect();
        eprintln!(
            "  match deltaE {:.2} ceiling {:.2} saturation {:.3} lattice {} matrix {}",
            colour.delta_e,
            colour.ceiling,
            colour.saturation,
            colour.chroma.is_some(),
            rows.join(" "),
        );
        let bins: Vec<[f32; 4]> = (0..16)
            .map(|bin| {
                let x = (colour.ceiling * f64::from(bin) / 255.0) as f32;
                [x, x, x, 0.0]
            })
            .collect();
        let toned = pollster::block_on(rawshim::hdr_fit::evaluated(
            gpu,
            colour,
            &bins,
            rawshim::hdr_fit::Stage::Tone,
        ))
        .expect("the device evaluates the model");
        let shape: Vec<String> =
            toned.iter().enumerate().map(|(bin, v)| format!("{bin}:{:.4}", v[1])).collect();
        eprintln!("  curve toe {}", shape.join(" "));
        // The whole domain, not just its first sixteenth: the toe above is sampled over the bottom
        // 6% and says nothing about where a highlight lands, which is half of what a curve decides.
        let whole: Vec<[f32; 4]> = (0..=16)
            .map(|step| {
                let x = (colour.ceiling * f64::from(step) / 16.0) as f32;
                [x, x, x, 0.0]
            })
            .collect();
        let over = pollster::block_on(rawshim::hdr_fit::evaluated(
            gpu,
            colour,
            &whole,
            rawshim::hdr_fit::Stage::Tone,
        ))
        .expect("the device evaluates the model");
        let full: Vec<String> = over
            .iter()
            .enumerate()
            .map(|(step, v)| {
                format!("{:.2}:{:.4}", colour.ceiling * step as f64 / 16.0, v[1])
            })
            .collect();
        eprintln!("  curve whole {}", full.join(" "));
    }

    let base = rawshim::base::device(gpu).expect("the device the pipelines were built on");
    let size =
        rawshim::hdr_args::target_size(frame.width as u32, frame.height as u32, &options);
    // As `job::run` composes it: the frame's measured capture sigma where the decode has one,
    // carried to the target's scale.
    let sensor_long = frame.width.max(frame.height) * frame.reduced.max(1);
    // As `open::measure` reads it, off the linear frame and scaled into the sensor's pixels.
    let capture_sigma = pollster::block_on(rawshim::base::measure_edge_spread(
        gpu,
        base,
        resident.buffer(),
        frame.width,
        frame.height,
    ))
    .map(|blur| blur * frame.reduced.max(1) as f32);
    let sigma = match stages.sharpen_sigma {
        Some(fixed) => rawshim::image::SharpenSigma::fixed(fixed),
        None => rawshim::image::deconvolve_split(
            capture_sigma,
            sensor_long,
            size.width.max(size.height) as usize,
        ),
    };
    let sharpen_noise = rawshim::base::sharpen_noise(
        levels,
        options.grade.reference_white_nits,
        frame.noise,
        frame.matrix,
        frame.wb_gains,
        frame.reduced,
    )
    .at(
        rawshim::px::Span::<rawshim::px::Sensor>::exact(sensor_long),
        rawshim::px::Span::<rawshim::px::Drawn>::exact(
            size.width.max(size.height) as usize,
        ),
    );
    // What the deconvolution was actually given, since `deconvolve_split` clamps and a run that
    // sat on the ceiling is sharpening less than the frame asked for.
    eprintln!(
        "  capture sigma {:?}, composed {:.4}{}",
        capture_sigma,
        sigma.composed,
        match sigma.composed >= 0.8399 {
            true => " (AT THE CEILING)",
            false => "",
        },
    );
    let cut = {
        let resident =
            rawshim::resident::Resident::upload(gpu, samples, frame.width, frame.height);
        // No lens here: a rendition's warp is per target and happens in `Cut::from_base` below, so
        // this is the defringe and the coding alone, exactly as `Base::build` takes them.
        let (prepared, _) = pollster::block_on(rawshim::base::prepare(
            gpu,
            base,
            resident,
            rawshim::base::Gather::frame(rawshim::px::Size::exact(frame.width, frame.height)),
            levels,
            options.grade.reference_white_nits,
            Strengths { sharpen: stages.sharpen, defringe: stages.defringe }.before_the_fit(),
            rawshim::image::SharpenSigma::fixed(rawshim::image::DECONVOLVE_SIGMA),
            rawshim::image::SharpenNoise::NONE,
            &rawshim::fit::Lens::none(),
            stages.defocus.map_or(rawshim::base::Defringe::Measure, rawshim::base::Defringe::Take),
            frame.noise,
            frame.matrix,
        ))
        .expect("the coding and the defringe");
        let lens = matched.as_ref().map(|m| &m.lens).filter(|_| stages.lens);
        hdr::Cut::from_base(prepared, lens, size, stages.sharpen, sigma, sharpen_noise)
    };

    let colour = matched.as_ref().filter(|_| stages.matched).and_then(|m| m.colour.as_ref()).map(|colour| {
        let mut colour = colour.clone();
        if !stages.lattice {
            colour.chroma = None;
        }
        if !stages.matrix {
            colour.matrix = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        }
        if !stages.saturation {
            colour.saturation = 1.0;
        }
        colour.saturation *= stages.chroma;
        if stages.curve_gain != 1.0 {
            for curve in &mut colour.curves {
                // Mid-grey, not the domain's middle: the domain runs to a shade under diffuse
                // white, so its midpoint is a highlight and expanding about it buries the picture.
                let anchor = curve[curve.len() / 5].max(1e-6);
                for v in curve.iter_mut() {
                    *v = anchor * (v.max(1e-6) / anchor).powf(stages.curve_gain);
                }
            }
        }
        if !stages.curves {
            colour.curves =
                [colour.curves[1].clone(), colour.curves[1].clone(), colour.curves[1].clone()];
        }
        if !stages.tone {
            let bins = colour.curves[0].len();
            let ramp: Vec<f64> =
                (0..bins).map(|i| colour.ceiling * i as f64 / (bins - 1) as f64).collect();
            colour.curves = [ramp.clone(), ramp.clone(), ramp];
        }
        colour
    });
    let scene = rawshim::tone::SceneGrade::new(
        colour.as_ref(),
        levels,
        options.grade.reference_white_nits,
        stages.ev,
        rawshim::gpu::Adjust {
            contrast: stages.contrast,
            saturation: stages.saturation_adjust,
            blacks: stages.blacks,
            shadows: stages.shadows,
            texture: stages.texture,
            clarity: stages.clarity,
            ..rawshim::gpu::Adjust::none()
        },
        // The frame's own, as `job::run` carries it: without it the neutral arm white-balances
        // against nothing and a render's colour is not the render's.
        frame.as_shot,
    );
    // `job::peak_nits`, and the crossing is spelled here as it is there: PQ carries the display's
    // own peak, where sRGB's 1.0 is diffuse white.
    let (peak, output) = match stages.domain {
        Domain::Srgb => (
            Light::at_diffuse_white(options.grade.reference_white_nits),
            rawshim::gpu::Output::Srgb,
        ),
        Domain::Pq => (options.grade.peak_nits, rawshim::gpu::Output::Pq),
        Domain::Linear => (options.grade.peak_nits, rawshim::gpu::Output::Rolled),
    };
    let mut coded =
        hdr::encode_cut(gpu, &cut, &scene.gpu_grade(cut.width, cut.height, peak, output));
    if stages.domain == Domain::Pq {
        // What `job::run` reads to pick this still's chroma, so a render here says which way a
        // rendition of it would have gone.
        let leak =
            pollster::block_on(rawshim::base::chroma_leak_of(gpu, base, &coded, cut.width, cut.height))
                .expect("the leak measures");
        eprintln!("  chroma leak {leak:.4} (worst 64px tile's fraction of blocks past the threshold)");
    }
    // Through the rendition's own encoder and back, so a pattern at the pixel's scale can be
    // laid at the encoder's door or taken away from it. `max`'s settings: `lossless_quantizer`
    // and `avif_speed`, 4:2:0 as `hdr_still_full_chroma` defaults.
    if let (Domain::Pq, Some((quantizer, chroma))) = (stages.domain, stages.encode) {
        let (primaries, transfer, matrix) = rawshim::hdr_args::cicp();
        let still = rawshim::avif::StillOptions {
            cicp: rawshim::avif::Cicp { primaries, transfer, matrix },
            format: chroma.avif_format(),
            quantizer,
            speed: 8,
        };
        let started = std::time::Instant::now();
        let file = rawshim::avif::encode_still(
            std::borrow::Cow::Borrowed(&coded),
            cut.width,
            cut.height,
            &still,
        )
        .expect("the rendition encodes");
        let (decoded, w, h) = rawshim::avif::decode_at(&file, 16).expect("the rendition decodes");
        assert_eq!((w, h), (cut.width, cut.height));
        eprintln!("  encoded and decoded in {}ms, {} bytes", started.elapsed().as_millis(), file.len());
        // Kept, so `avif_crop` can cut it beside a rendition the server wrote.
        std::fs::write(format!("{}/encoded.avif", stages.out), &file)
            .expect("the encoded still writes");
        coded = decoded;
    }
    // The rolled frame's 1.0 is the mastering peak, so a straight byte would put diffuse white at
    // a twentieth of the range and nothing would be visible at all.
    let to_white = f32::from(u16::MAX) * (options.grade.reference_white_nits.raw()
        / options.grade.peak_nits.raw()) as f32;
    let byte = |v: &u16| match stages.domain {
        Domain::Srgb => *v as u8,
        Domain::Pq => (v >> 8) as u8,
        Domain::Linear => (f32::from(*v) / to_white * 255.0).min(255.0) as u8,
    };
    (coded.iter().map(byte).collect(), cut.width, cut.height)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("a raw path");
    let out = args.next().expect("an output directory");
    // What the library ships with nothing said, so a render with no flags is the picture a
    // rendition is.
    let mut detail = rawshim::galosh::Detail::AUTO;
    let mut sweep: Vec<f64> = Vec::new();
    let mut sweep_colour: Option<f64> = None;
    let mut sweep_luma: Option<f64> = None;
    let mut columns = 4usize;
    let mut crops: Vec<(usize, usize, usize)> = Vec::new();
    let mut edge = 0usize;
    let mut camera: Option<String> = None;
    let mut stages = Stages {
        sharpen: strengths().sharpen,
        sharpen_sigma: None,
        defringe: strengths().defringe,
        lens: true,
        matched: true,
        lattice: true,
        matrix: true,
        saturation: true,
        curves: true,
        tone: true,
        chroma: 1.0,
        contrast: 0.0,
        saturation_adjust: 0.0,
        blacks: 0.0,
        shadows: 0.0,
        texture: 0.0,
        clarity: 0.0,
        curve_gain: 1.0,
        defocus: None,
        ev: None,
        domain: Domain::Pq,
        encode: None,
        out: &out,
    };
    let mut file = File { quantizer: CROP_QUANTIZER, full_chroma: true };
    while let Some(flag) = args.next() {
        match flag.as_str() {
            // Each names a stage to hold still while the other moves. A pattern that survives
            // `--sharpen 0` is not the deconvolution's, and one that survives `--no-lens` is not
            // the gather's.
            "--sharpen" => {
                stages.sharpen = args.next().expect("a number").parse().expect("a number");
            }
            "--sharpen-sigma" => {
                stages.sharpen_sigma =
                    Some(args.next().expect("a number").parse().expect("a number"));
            }
            "--defringe" => {
                stages.defringe = args.next().expect("a number").parse().expect("a number");
            }
            "--sdr" => stages.domain = Domain::Srgb,
            "--linear" => stages.domain = Domain::Linear,
            "--encode" => {
                let spec = args.next().expect("quantizer,420|444");
                let (quantizer, chroma) = spec.split_once(',').expect("quantizer,420|444");
                stages.encode = Some((
                    quantizer.parse().expect("a quantizer"),
                    match chroma {
                        "420" => Chroma::Yuv420,
                        "444" => Chroma::Yuv444,
                        other => panic!("chroma is 420 or 444, not {other}"),
                    },
                ));
            }
            "--no-lens" => stages.lens = false,
            "--no-match" => stages.matched = false,
            "--no-lattice" => stages.lattice = false,
            "--no-matrix" => stages.matrix = false,
            "--no-saturation" => stages.saturation = false,
            "--chroma" => {
                stages.chroma = args.next().expect("a number").parse().expect("a number");
            }
            "--contrast" => {
                stages.contrast = args.next().expect("a number").parse().expect("a number");
            }
            "--blacks" => {
                stages.blacks = args.next().expect("a number").parse().expect("a number");
            }
            "--texture" => {
                stages.texture = args.next().expect("a number").parse().expect("a number");
            }
            "--clarity" => {
                stages.clarity = args.next().expect("a number").parse().expect("a number");
            }
            "--shadows" => {
                stages.shadows = args.next().expect("a number").parse().expect("a number");
            }
            "--curve-gain" => {
                stages.curve_gain = args.next().expect("a number").parse().expect("a number");
            }
            "--saturation" => {
                stages.saturation_adjust =
                    args.next().expect("a number").parse().expect("a number");
            }
            "--one-curve" => stages.curves = false,
            "--no-tone" => stages.tone = false,
            "--ev" => {
                let stops: f64 = args.next().expect("a number").parse().expect("a number");
                stages.ev = Some(Stops::measured(stops));
            }
            // How much of the shrinkage's cycle spin to run. What fewer phases cost is a picture
            // question, and a mean deviation over a frame cannot say whether an eye finds it.
            "--phases" => {
                let phases: i32 = args.next().expect("4, 8 or 16").parse().expect("a number");
                rawshim::galosh::force_phases(phases);
            }
            // The luma phases' pooling before the inverse, a low-pass that runs at every amount:
            // off is the exact inverse of the stride-1 transform, for seeing what the pooling
            // alone does.
            "--pool" => rawshim::galosh::force_phase_pool(args.next().expect("0 or 1") != "0"),
            // The colour pyramid with or without `chroma_detail`'s bracket, which is what says how
            // much fine luma the colour denoise would otherwise take with it.
            "--chroma-detail" => {
                rawshim::galosh::force_chroma_detail(args.next().expect("0 or 1") != "0")
            }
            "--ratio-floor" => {
                rawshim::galosh::force_ratio_floor(
                    args.next().expect("a number").parse().expect("a number"),
                );
            }
            "--reach" => {
                rawshim::galosh::force_level_reach(
                    args.next().expect("a number").parse().expect("a number"),
                );
            }
            // **The aberration to take off, rather than the one this frame measures.** What the
            // defringe does to a picture is decided entirely by this pair, so holding everything
            // else still and moving only it is how to see what a change to the *estimate* is worth
            // - two renders that differ in one number rather than in a rebuild.
            "--defocus" => {
                let text = args.next().expect("red,blue");
                let (red, blue) = text.split_once(',').expect("red,blue");
                stages.defocus = Some((
                    red.trim().parse().expect("a number"),
                    blue.trim().parse().expect("a number"),
                ));
            }
            // The encoder the export runs, rather than the near-lossless one a crop is written
            // with: `lossless_sdr_quantizer` is 8 and `sdr_full_chroma` is off, so what a reader
            // pixel-peeps is 4:2:0 at a quantizer, and the JPEG below is decoded back out of the
            // file so that shows.
            "--as-export" => file = File { quantizer: 8, full_chroma: false },
            // The two sliders move independently in the panel, and a reader who takes Colour to
            // zero and leaves Luminance up is an ordinary position rather than a corner. `auto` is
            // neither set, which is what a document that has never been edited holds and so the
            // only spelling that renders what a library actually ships.
            "--detail" => {
                let asked = args.next().expect("a number or `auto`");
                detail = match asked.as_str() {
                    "auto" => rawshim::galosh::Detail::AUTO,
                    number => {
                        let both: f64 = number.parse().expect("a number or `auto`");
                        rawshim::galosh::Detail::at(both, both)
                    }
                };
            }
            "--luminance" => {
                detail.luminance =
                    Some(args.next().expect("a number").parse().expect("a number"));
            }
            "--colour" => {
                detail.colour = Some(args.next().expect("a number").parse().expect("a number"));
            }
            // Which filter those positions drive, which is a document's choice and so is here
            // rather than a build of its own.
            "--denoiser" => {
                let asked = args.next().expect("galosh or pmrid");
                detail = detail.using(match asked.as_str() {
                    "galosh" => rawshim::galosh::Denoiser::Galosh,
                    "pmrid" => rawshim::galosh::Denoiser::Pmrid,
                    other => panic!("{other} is not a denoiser"),
                });
            }
            "--crop" => {
                let spec = args.next().expect("x,y,side");
                let n: Vec<usize> =
                    spec.split(',').map(|v| v.parse().expect("a number")).collect();
                crops.push((n[0], n[1], n[2]));
            }
            // **What a rendition of that size actually is**, rather than the sensor's own frame.
            // The crops are still 1:1 of whatever comes out, so this is the way to look at what the
            // downscale did to an edge - which nothing else here can show, the default being no
            // reduction at all.
            "--edge" => {
                edge = args.next().expect("a number").parse().expect("a number");
            }
            // The body's own rendering of the same frame, cut to the same crops, as the thing to
            // beat - and beside it the preview the *fit* read, which is a smaller rendering of its
            // own (`Preview::for_the_match`) and the only thing a match can be as right as. Written
            // on its own so `BOWERBIRD_CROP_BESIDE` can chain them in front of as many renders as a
            // comparison wants.
            "--camera-crop" => {
                camera = Some(args.next().expect("an output directory"));
            }
            // One panel per slider position, both halves of Detail moving together, laid out as a
            // grid beside the body's own JPEG of the same frame.
            "--grid" => {
                sweep = args
                    .next()
                    .expect("a,b,c")
                    .split(',')
                    .map(|v| v.parse().expect("a number"))
                    .collect();
            }
            // Colour held still while Luminance walks, since the two do not share a track: the
            // panel runs colour ahead of luminance and `galosh::suggested_amounts` suggests it
            // that way, so a grid moving both together cannot say what either one is worth.
            "--grid-colour" => {
                sweep_colour = Some(args.next().expect("a number").parse().expect("a number"));
            }
            // The other way round: Luminance held and Colour walking, which is what says whether a
            // position on one track buys what the same position on the other does.
            "--grid-luminance" => {
                sweep_luma = Some(args.next().expect("a number").parse().expect("a number"));
            }
            "--columns" => {
                columns = args.next().expect("a number").parse().expect("a number");
            }
            other => panic!("unknown flag {other}"),
        }
    }
    std::fs::create_dir_all(&out).expect("the output directory");

    if !sweep.is_empty() {
        sweep_grid(&path, &out, &sweep, sweep_colour, sweep_luma, columns, &crops, edge, stages);
        return;
    }

    if stages.domain == Domain::Pq {
        // The `.jpg` beside each crop is the PQ codes' top eight bits in an sRGB container, which
        // is a real render drawn without its transfer: milky shadows, flat contrast, colour pulled
        // towards the frame's average. A reader comparing one against a camera's own JPEG measures
        // that and nothing else. The `.avif` is the render; this is a thumbnail of it.
        eprintln!("the .jpg crops are PQ codes, not a picture - pass --sdr to compare by eye");
    }
    for name in ["render"] {
        let said = |at: Option<f64>| at.map_or("auto".to_string(), |v| format!("{v}"));
        eprintln!(
            "{name} at luminance {} colour {}:",
            said(detail.luminance),
            said(detail.colour),
        );
        let started = std::time::Instant::now();
        let (data, width, height) = rendition(&path, detail, edge, stages);
        eprintln!("  {width}x{height} in {}ms", started.elapsed().as_millis());
        let whole = rawshim::rgb::RgbRef { width, height, data: &data };

        if let Some(dir) = &camera {
            std::fs::create_dir_all(dir).expect("the camera directory");
            let preview =
                rawshim::decode_embedded_rgb(&path, 100_000).expect("an embedded preview");
            eprintln!(
                "  camera {}x{} against the render's {width}x{height}",
                preview.width, preview.height
            );
            // The preview the *fit* reads, beside the one a reader compares against: they are two
            // renderings of one frame, and a match can only be as right as the picture it was
            // taught on.
            let fitted = rawshim::hdr::match_preview(&path).expect("the match's preview");
            eprintln!("  match preview {}x{}", fitted.width, fitted.height);
            let fitted = rawshim::image::resize(fitted.as_ref(), width, height);
            for (x, y, side) in &crops {
                let want = cut(whole, *x, *y, *side);
                for (name, from) in [("camera", preview.as_ref()), ("fitted", fitted.as_ref())] {
                    let (dx, dy, cut) = aligned(from, want.as_ref(), *x, *y, *side);
                    let cut = greyscale(magnify(cut, crop_zoom()));
                    let path = format!("{dir}/{name}-{x}-{y}.jpg");
                    let bytes =
                        rawshim::jpeg::encode(cut.as_ref(), 95).expect("the camera crop encodes");
                    std::fs::write(&path, bytes).expect("the camera crop writes");
                    let [r, g, b] = channel_means(cut.as_ref());
                    let [cr, cb] = chroma_roughness(cut.as_ref());
                    let (flat, edge, bias) = edge_bias(cut.as_ref());
                    let grain = grain_correlation(cut.as_ref());
                    eprintln!(
                        "    wrote {path} at {dx:+},{dy:+} luma {} bias {bias:.2} \
                         (flat {flat:.2} edge {edge:.2}) grain {:.2}/{:.2}/{:.2} \
                         edge {} chroma {cr:.2}/{cb:.2} rgb {r:.1}/{g:.1}/{b:.1}",
                        bands(cut.as_ref(), Plane::Luma),
                        grain[0],
                        grain[1],
                        grain[2],
                        edge_spread(cut.as_ref())
                            .map_or("-".to_string(), |(n, w)| format!("{w:.2}px/{n}")),
                    );
                    for (name, plane) in
                        [("luma", Plane::Luma), ("cr  ", Plane::Cr), ("cb  ", Plane::Cb)]
                    {
                        match noise_blobs(cut.as_ref(), plane) {
                            Some((sizes, gaps, count)) => eprintln!(
                                "      {name} specks {count:>5}  size p25/50/75/90 \
                                 {:.1}/{:.1}/{:.1}/{:.1}px2  gap {:.2}/{:.2}/{:.2}/{:.2}px",
                                sizes[0], sizes[1], sizes[2], sizes[3],
                                gaps[0], gaps[1], gaps[2], gaps[3],
                            ),
                            None => eprintln!("      {name} specks: too few to rank"),
                        }
                    }
                    if std::env::var("BOWERBIRD_CROP_PROFILE").is_ok() {
                        let (across, _) = correlation_profile(cut.as_ref());
                        eprintln!(
                            "      across {}",
                            across
                                .iter()
                                .map(|c| format!("{c:+.2}"))
                                .collect::<Vec<_>>()
                                .join(" "),
                        );
                    }
                }
            }
        }

        if crops.is_empty() {
            let small = rawshim::image::resize_to_fit(whole, 1600);
            write(&format!("{out}/{name}.avif"), small.as_ref(), file);
            continue;
        }
        for (x, y, side) in &crops {
            let cut = cut(whole, *x, *y, *side);
            // The means beside the roughness, because the two renders are only comparable while
            // they are graded alike - and a grade that has drifted reads as a denoiser that has.
            // A pair whose means differ is a harness bug, not a finding.
            let [r, g, b] = channel_means(cut.as_ref());
            let [cr, cb] = chroma_roughness(cut.as_ref());
            let (flat, edge, bias) = edge_bias(cut.as_ref());
            let grain = grain_correlation(cut.as_ref());
            eprintln!(
                "    {x},{y} luma {} bias {bias:.2} (flat {flat:.2} edge {edge:.2}) \
                 grain {:.2}/{:.2}/{:.2} edge {} chroma {cr:.2}/{cb:.2} rgb {r:.1}/{g:.1}/{b:.1}",
                bands(cut.as_ref(), Plane::Luma),
                grain[0],
                grain[1],
                grain[2],
                edge_spread(cut.as_ref())
                    .map_or("-".to_string(), |(n, w)| format!("{w:.2}px/{n}")),
            );
            eprintln!(
                "      cr by scale {}  cb by scale {}",
                bands(cut.as_ref(), Plane::Cr),
                bands(cut.as_ref(), Plane::Cb),
            );
            let (phases, worst) = phase_noise(cut.as_ref());
            eprintln!(
                "      phase {:.2}/{:.2}/{:.2}/{:.2} worst ratio {worst:.2}",
                phases[0], phases[1], phases[2], phases[3],
            );
            for (name, plane) in [("luma", Plane::Luma), ("cr  ", Plane::Cr), ("cb  ", Plane::Cb)] {
                match noise_blobs(cut.as_ref(), plane) {
                    Some((sizes, gaps, count)) => eprintln!(
                        "      {name} specks {count:>5}  size p25/50/75/90 \
                         {:.1}/{:.1}/{:.1}/{:.1}px2  gap {:.2}/{:.2}/{:.2}/{:.2}px",
                        sizes[0], sizes[1], sizes[2], sizes[3],
                        gaps[0], gaps[1], gaps[2], gaps[3],
                    ),
                    None => eprintln!("      {name} specks: too few to rank"),
                }
            }
            if std::env::var("BOWERBIRD_CROP_PROFILE").is_ok() {
                let (across, down) = correlation_profile(cut.as_ref());
                let show = |v: &[f64]| {
                    v.iter().map(|c| format!("{c:+.2}")).collect::<Vec<_>>().join(" ")
                };
                eprintln!("      across {}", show(&across));
                eprintln!("      down   {}", show(&down));
                // Per channel, because the demosaic interpolates three quarters of red and blue
                // and only half of green: a correlation the *interpolation* introduced shows up
                // unevenly across the three, where one the denoise introduced does not.
                for (name, channel) in [("r", 0usize), ("g", 1), ("b", 2)] {
                    let one = rawshim::rgb::Rgb {
                        width: cut.width,
                        height: cut.height,
                        data: (0..cut.width * cut.height)
                            .flat_map(|i| {
                                let v = cut.as_ref().data[i * 3 + channel];
                                [v, v, v]
                            })
                            .collect(),
                    };
                    let (a, _) = correlation_profile(one.as_ref());
                    eprintln!("      {name}      {}", show(&a[..4]));
                }
            }
            let shown = greyscale(magnify(cut, crop_zoom()));
            write(&format!("{out}/{name}-{x}-{y}.avif"), shown.as_ref(), file);
        }
    }
}

fn cut(image: rawshim::rgb::RgbRef<'_>, x: usize, y: usize, side: usize) -> rawshim::rgb::Rgb {
    let x = x.min(image.width.saturating_sub(side));
    let y = y.min(image.height.saturating_sub(side));
    let mut data = vec![0u8; side * side * 3];
    for row in 0..side {
        let from = ((y + row) * image.width + x) * 3;
        data[row * side * 3..(row + 1) * side * 3]
            .copy_from_slice(&image.data[from..from + side * 3]);
    }
    rawshim::rgb::Rgb { width: side, height: side, data }
}

/// How many octaves of scale the noise is reported across.
///
/// Out to the sixth because the chroma defect this is asked about is not grain: the colour arm's
/// coarsest level reaches tens of pixels, so the band that says whether it reached far enough is
/// the one whose hole is 32.
const BANDS: usize = 6;

/// Luma noise by scale, as the sigma an à trous wavelet leaves in each octave.
///
/// **One number cannot say which of two renders is noisier, and the obvious one says the wrong
/// thing.** A median absolute three-tap Laplacian is a majority statistic over a stencil three
/// samples wide, so it answers "what does the quiet part of this crop do at the pixel's own scale".
/// Both halves of that are where a denoised render flatters itself: a shrinkage leaves a mottle
/// several pixels across, under a surface the median then reads as smooth, and speckle over that
/// surface is a minority a median steps over. Measured this way a render scored 2.17 against the
/// body's own JPEG at 3.03 while being visibly the noisier of the two - the body's grain being
/// uniform and fine, which is precisely what this rewards.
///
/// So each octave separately: the frame is smoothed by a widening binomial kernel and what each
/// step removed is that band's noise. Band 0 is the grain a sensor makes, band 3 the mottle a
/// block shrinkage leaves behind, and a render is quieter than another only where it is quieter in
/// the band a reader is looking at.
///
/// À trous rather than a decimating pyramid: the levels stay the frame's own size, so no band's
/// answer is a resampler's. Comparable between two renderings of one subject at one scale, and
/// meaningless across subjects.
fn noise_by_scale(image: rawshim::rgb::RgbRef<'_>, which: Plane) -> [(f64, f64); BANDS] {
    let (w, h) = (image.width, image.height);
    let mut plane: Vec<f64> = (0..w * h)
        .map(|i| {
            let at = |c: usize| f64::from(image.data[i * 3 + c]);
            let y = 0.2126 * at(0) + 0.7152 * at(1) + 0.0722 * at(2);
            match which {
                Plane::Luma => y,
                Plane::Cr => at(0) - y,
                Plane::Cb => at(2) - y,
            }
        })
        .collect();

    // The 1-4-6-4-1 the à trous scheme is written with, spread by the level's own hole.
    const TAPS: [f64; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];

    std::array::from_fn(|band| {
        let hole = 1usize << band;
        let at = |x: usize, y: usize| plane[y * w + x];
        let mut rows = vec![0.0f64; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut sum = 0.0;
                for (t, k) in TAPS.iter().enumerate() {
                    let dx = (t as isize - 2) * hole as isize;
                    let sx = (x as isize + dx).clamp(0, w as isize - 1) as usize;
                    sum += k * at(sx, y);
                }
                rows[y * w + x] = sum;
            }
        }
        let mut smoothed = vec![0.0f64; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut sum = 0.0;
                for (t, k) in TAPS.iter().enumerate() {
                    let dy = (t as isize - 2) * hole as isize;
                    let sy = (y as isize + dy).clamp(0, h as isize - 1) as usize;
                    sum += k * rows[sy * w + x];
                }
                smoothed[y * w + x] = sum;
            }
        }
        // What the smoothing took out is this octave, and its own median absolute deviation is the
        // sigma of it: 1.4826 is the Gaussian's, the same constant the MAD is always scaled by.
        let mut detail: Vec<f64> =
            plane.iter().zip(&smoothed).map(|(v, s)| (v - s).abs()).collect();
        let mid = detail.len() / 2;
        detail.select_nth_unstable_by(mid, f64::total_cmp);
        let sigma = detail[mid] * 1.4826;
        // The same band's ninetieth against its median, which is what says whether the residual is
        // spread evenly over the crop or pooled in part of it. `select_nth_unstable_by` reorders
        // what it is given, and both ranks are exact on any ordering, so the second call is honest
        // against the first's leftovers.
        let high = detail.len() * 9 / 10;
        detail.select_nth_unstable_by(high, f64::total_cmp);
        let patchiness = detail[high] / detail[mid].max(1e-9);
        plane = smoothed;
        (sigma, patchiness)
    })
}

/// The bands as one line, widest last, which is the order a defect grows along.
fn bands(image: rawshim::rgb::RgbRef<'_>, which: Plane) -> String {
    noise_by_scale(image, which).map(|(v, _)| format!("{v:.2}")).join("/")
}

/// The 10-90 width of the crop's sharpest edges, which is what "how sharp is this" means.
///
/// **The camera's own crop needs this as much as ours does, and until now only ours reported it.**
/// A denoise that softened every boundary would show here and nowhere else in this file: a band
/// sigma counts noise and structure together, and `edge_bias` asks where the noise sits rather than
/// how wide a step is. The number to beat is the body's own rendering of the same edges.
///
/// The sharpest decile rather than the median, since a real scene edge may be softer than the
/// optics but never harder - and `None` where too few transitions qualify to rank.
fn edge_spread(image: rawshim::rgb::RgbRef<'_>) -> Option<(usize, f32)> {
    let luma: Vec<f32> = (0..image.width * image.height)
        .map(|i| {
            let p = i * 3;
            0.2126 * f32::from(image.data[p])
                + 0.7152 * f32::from(image.data[p + 1])
                + 0.0722 * f32::from(image.data[p + 2])
        })
        .collect();
    let mut widths: Vec<f32> = Vec::new();
    for y in 0..image.height {
        let row = &luma[y * image.width..(y + 1) * image.width];
        for x in 4..image.width - 12 {
            let Some(end) = (1..9).find(|&n| row[x + n + 1] <= row[x + n]) else { continue };
            if end < 2 {
                continue;
            }
            let (low, high) = (row[x], row[x + end]);
            let step = high - low;
            if step < 24.0 || row[x - 1] > low || row[x - 2] > row[x - 1] {
                continue;
            }
            let cross = |frac: f32| -> Option<f32> {
                let want = low + step * frac;
                (0..end).find_map(|n| {
                    let (a, b) = (row[x + n], row[x + n + 1]);
                    (a <= want && want <= b).then(|| x as f32 + n as f32 + (want - a) / (b - a))
                })
            };
            if let (Some(lo), Some(hi)) = (cross(0.1), cross(0.9)) {
                widths.push(hi - lo);
            }
        }
    }
    if widths.len() < 20 {
        return None;
    }
    widths.sort_by(f32::total_cmp);
    Some((widths.len(), widths[(widths.len() - 1) / 10]))
}

/// How far the residual correlates with itself, which is what grain *size* means.
///
/// **Two residuals of equal level look nothing alike if one is a pixel wide and the other is four.**
/// A per-octave sigma cannot separate them: noise that is blobby at four pixels still puts most of
/// its energy in the finest band, because an a trous difference of a blob has edges everywhere. The
/// eye reads the blob, not the octave. What tells them apart is whether a sample predicts its
/// neighbour - white grain does not, and a shrinkage's leftovers do, having been built by averaging
/// the same neighbours together.
///
/// Reported at lags 1, 2 and 4, as the residual's normalised autocorrelation averaged over both
/// axes. Zero at every lag is film grain; a number that stays high out to 4 is a picture with
/// four-pixel lumps in it whatever its sigma says.
fn grain_correlation(image: rawshim::rgb::RgbRef<'_>) -> [f64; 3] {
    let (w, h) = (image.width, image.height);
    let luma: Vec<f64> = (0..w * h)
        .map(|i| {
            0.2126 * f64::from(image.data[i * 3])
                + 0.7152 * f64::from(image.data[i * 3 + 1])
                + 0.0722 * f64::from(image.data[i * 3 + 2])
        })
        .collect();

    // The picture under the grain, taken far enough out that nothing the grain does reaches it.
    const TAPS: [f64; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];
    let mut rows = vec![0.0f64; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0.0;
            for (t, k) in TAPS.iter().enumerate() {
                let dx = (t as isize - 2) * 4;
                let sx = (x as isize + dx).clamp(0, w as isize - 1) as usize;
                sum += k * luma[y * w + sx];
            }
            rows[y * w + x] = sum;
        }
    }
    let mut smooth = vec![0.0f64; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0.0;
            for (t, k) in TAPS.iter().enumerate() {
                let dy = (t as isize - 2) * 4;
                let sy = (y as isize + dy).clamp(0, h as isize - 1) as usize;
                sum += k * rows[sy * w + x];
            }
            smooth[y * w + x] = sum;
        }
    }
    let residual: Vec<f64> = luma.iter().zip(&smooth).map(|(v, s)| v - s).collect();
    let power: f64 = residual.iter().map(|r| r * r).sum::<f64>().max(1e-9);

    [1usize, 2, 4].map(|lag| {
        let mut across = 0.0;
        let mut down = 0.0;
        for y in 0..h {
            for x in 0..w - lag {
                across += residual[y * w + x] * residual[y * w + x + lag];
            }
        }
        for y in 0..h - lag {
            for x in 0..w {
                down += residual[y * w + x] * residual[(y + lag) * w + x];
            }
        }
        (across + down) / (2.0 * power)
    })
}

/// The residual's autocorrelation along each axis on its own, out to eight photosites.
///
/// **A single averaged number says a residual is correlated; only the profile says what it is.**
/// Noise that is merely pooled decays smoothly with distance, where a residue of the sensor's own
/// lattice or of the transform's block grid has a *period* - it dips and returns. The two ask for
/// completely different fixes, and the averaged figure cannot tell them apart because a 2-pixel
/// structure and a 4-pixel blob both raise the lag-two number.
fn correlation_profile(image: rawshim::rgb::RgbRef<'_>) -> (Vec<f64>, Vec<f64>) {
    let (w, h) = (image.width, image.height);
    let luma: Vec<f64> = (0..w * h)
        .map(|i| {
            0.2126 * f64::from(image.data[i * 3])
                + 0.7152 * f64::from(image.data[i * 3 + 1])
                + 0.0722 * f64::from(image.data[i * 3 + 2])
        })
        .collect();
    const TAPS: [f64; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];
    let mut rows = vec![0.0f64; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0.0;
            for (t, k) in TAPS.iter().enumerate() {
                let dx = (t as isize - 2) * 4;
                let sx = (x as isize + dx).clamp(0, w as isize - 1) as usize;
                sum += k * luma[y * w + sx];
            }
            rows[y * w + x] = sum;
        }
    }
    let mut smooth = vec![0.0f64; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0.0;
            for (t, k) in TAPS.iter().enumerate() {
                let dy = (t as isize - 2) * 4;
                let sy = (y as isize + dy).clamp(0, h as isize - 1) as usize;
                sum += k * rows[sy * w + x];
            }
            smooth[y * w + x] = sum;
        }
    }
    let r: Vec<f64> = luma.iter().zip(&smooth).map(|(v, s)| v - s).collect();
    let power: f64 = r.iter().map(|v| v * v).sum::<f64>().max(1e-9);
    let across = (1..=8)
        .map(|lag| {
            let mut sum = 0.0;
            for y in 0..h {
                for x in 0..w - lag {
                    sum += r[y * w + x] * r[y * w + x + lag];
                }
            }
            sum / power
        })
        .collect();
    let down = (1..=8)
        .map(|lag| {
            let mut sum = 0.0;
            for y in 0..h - lag {
                for x in 0..w {
                    sum += r[y * w + x] * r[(y + lag) * w + x];
                }
            }
            sum / power
        })
        .collect();
    (across, down)
}

/// The finest band's noise at each of the four positions of the sensor's 2x2, and the worst ratio.
///
/// **A residual that is not the same size at all four is a weave whatever its average is.** Every
/// stage that resamples a half-resolution plane onto the frame's own grid treats the position that
/// lands on a source sample differently from the three that do not - the first keeps its noise and
/// the others are averaged - so the leftovers come back with a two-pixel periodic amplitude, which
/// is read as a woven texture rather than as grain. No figure that pools the four can see it.
fn phase_noise(image: rawshim::rgb::RgbRef<'_>) -> ([f64; 4], f64) {
    let (w, h) = (image.width, image.height);
    let luma: Vec<f64> = (0..w * h)
        .map(|i| {
            0.2126 * f64::from(image.data[i * 3])
                + 0.7152 * f64::from(image.data[i * 3 + 1])
                + 0.0722 * f64::from(image.data[i * 3 + 2])
        })
        .collect();
    // The picture under the grain, taken far enough out that the grain itself does not reach it.
    const TAPS: [f64; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];
    let mut rows = vec![0.0f64; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0.0;
            for (t, k) in TAPS.iter().enumerate() {
                let sx = (x as isize + (t as isize - 2) * 4).clamp(0, w as isize - 1) as usize;
                sum += k * luma[y * w + sx];
            }
            rows[y * w + x] = sum;
        }
    }
    let mut smooth = vec![0.0f64; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0.0;
            for (t, k) in TAPS.iter().enumerate() {
                let sy = (y as isize + (t as isize - 2) * 4).clamp(0, h as isize - 1) as usize;
                sum += k * rows[sy * w + x];
            }
            smooth[y * w + x] = sum;
        }
    }

    let mut per: [Vec<f64>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    for y in 0..h {
        for x in 0..w {
            let slot = (y & 1) * 2 + (x & 1);
            per[slot].push((luma[y * w + x] - smooth[y * w + x]).abs());
        }
    }
    let sigma = per.map(|mut v| {
        if v.is_empty() {
            return 0.0;
        }
        let mid = v.len() / 2;
        v.select_nth_unstable_by(mid, f64::total_cmp);
        v[mid] * 1.4826
    });
    let lo = sigma.iter().copied().fold(f64::MAX, f64::min).max(1e-9);
    let hi = sigma.iter().copied().fold(f64::MIN, f64::max);
    (sigma, hi / lo)
}

/// What a grain actually is, as a shape: how big each one is and how far it sits from the next.
///
/// **A spectrum cannot answer "how large is the grain", and three of the figures above tried.** A
/// band sigma says how much energy an octave holds, an autocorrelation says how far a residual
/// predicts itself on average, and a ratio between bands says which octave dominates - and a
/// residual can match a reference on all three and still read as mottled, because what an eye
/// picks out is the *individual speck*: its width, and the gap to its neighbour. Fine grain is many
/// small specks packed close; mottle is fewer, fatter ones further apart, and that is the
/// difference this reports directly.
///
/// The scene is taken out first by subtracting a plane smoothed past the grain, which leaves the
/// noise about a zero mean. Only the *dark* excursions are then labelled: one sign rather than two,
/// because a speck and the ring around it are one feature to an eye but two to a threshold, and
/// counting both merges neighbouring specks into ribbons through their shared bright edges.
///
/// Eight-connected, since a speck that steps diagonally is one speck. Sizes are in photosites of
/// area; distances are centre to nearest other centre, which is the spacing a reader reads as
/// density.
/// Which plane the specks are counted in.
///
/// **Chroma needs its own count, and the luma one actively misleads about it.** A coloured speck
/// carries almost no luminance - that is what makes it coloured - so a luma plane reports a crop
/// covered in colour mottle as clean, and ours measured *finer* than the body's JPEG on luma while
/// looking worse to a reader. The colour differences are where the defect this pipeline has left
/// actually lives.
#[derive(Clone, Copy)]
enum Plane {
    Luma,
    Cr,
    Cb,
}

fn noise_blobs(
    image: rawshim::rgb::RgbRef<'_>,
    plane: Plane,
) -> Option<([f64; 4], [f64; 4], usize)> {
    let (w, h) = (image.width, image.height);
    let luma: Vec<f64> = (0..w * h)
        .map(|i| {
            let at = |c: usize| f64::from(image.data[i * 3 + c]);
            let y = 0.2126 * at(0) + 0.7152 * at(1) + 0.0722 * at(2);
            match plane {
                Plane::Luma => y,
                Plane::Cr => at(0) - y,
                Plane::Cb => at(2) - y,
            }
        })
        .collect();

    // The picture under the grain, far enough out that the grain does not reach it.
    const TAPS: [f64; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];
    let mut rows = vec![0.0f64; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0.0;
            for (t, k) in TAPS.iter().enumerate() {
                let sx = (x as isize + (t as isize - 2) * 4).clamp(0, w as isize - 1) as usize;
                sum += k * luma[y * w + sx];
            }
            rows[y * w + x] = sum;
        }
    }
    let mut smooth = vec![0.0f64; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0.0;
            for (t, k) in TAPS.iter().enumerate() {
                let sy = (y as isize + (t as isize - 2) * 4).clamp(0, h as isize - 1) as usize;
                sum += k * rows[sy * w + x];
            }
            smooth[y * w + x] = sum;
        }
    }
    let residual: Vec<f64> = luma.iter().zip(&smooth).map(|(v, s)| v - s).collect();

    // The threshold is the residual's own spread, so two crops at different noise levels are asked
    // the same question about shape rather than about amount.
    let mut spread: Vec<f64> = residual.iter().map(|r| r.abs()).collect();
    let mid = spread.len() / 2;
    spread.select_nth_unstable_by(mid, f64::total_cmp);
    let sigma = spread[mid] * 1.4826;
    if sigma <= 1e-6 {
        return None;
    }
    let floor = -DARK_EXCURSION * sigma;

    // Eight-connected labelling, grown from an explicit stack; recursion would be a frame per
    // photosite on a crop that is mostly one blob.
    let mut seen = vec![false; w * h];
    let mut sizes: Vec<f64> = Vec::new();
    let mut centres: Vec<(f64, f64)> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for start in 0..w * h {
        if seen[start] || residual[start] > floor {
            continue;
        }
        stack.push(start);
        seen[start] = true;
        let (mut count, mut sx, mut sy) = (0usize, 0.0f64, 0.0f64);
        while let Some(at) = stack.pop() {
            let (x, y) = (at % w, at / w);
            count += 1;
            sx += x as f64;
            sy += y as f64;
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let nx = x as i64 + dx;
                    let ny = y as i64 + dy;
                    if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                        continue;
                    }
                    let next = ny as usize * w + nx as usize;
                    if !seen[next] && residual[next] <= floor {
                        seen[next] = true;
                        stack.push(next);
                    }
                }
            }
        }
        sizes.push(count as f64);
        centres.push((sx / count as f64, sy / count as f64));
    }
    if centres.len() < 8 {
        return None;
    }

    // Centre to nearest other centre. Quadratic, and a 320px crop holds a few thousand of these.
    let mut gaps: Vec<f64> = centres
        .iter()
        .map(|(x, y)| {
            let mut best = f64::MAX;
            for (ox, oy) in &centres {
                let d = (x - ox).powi(2) + (y - oy).powi(2);
                if d > 0.0 && d < best {
                    best = d;
                }
            }
            best.sqrt()
        })
        .collect();

    let quantiles = |v: &mut Vec<f64>| -> [f64; 4] {
        [0.25f64, 0.5, 0.75, 0.9].map(|q| {
            let at = ((v.len() - 1) as f64 * q) as usize;
            v.select_nth_unstable_by(at, f64::total_cmp);
            v[at]
        })
    };
    let count = sizes.len();
    Some((quantiles(&mut sizes), quantiles(&mut gaps), count))
}

/// How far below the residual's own spread a photosite has to sit to count as part of a speck.
const DARK_EXCURSION: f64 = 1.0;

/// The finest band's noise beside structure against the same in the flat, and the ratio.
///
/// **This is the shape of the complaint that neither a level nor a spread can carry.** A shrinkage
/// whose gain is the pilot over the pilot plus the noise takes that gain to 1 wherever the signal
/// is strong, so the grain within a few pixels of an edge is passed through untouched while the
/// flat beside it is cut to `WIENER_FLOOR`. The picture is then clean in the open and noisy along
/// every boundary, which reads as a compression artefact rather than as grain - and a crop-wide
/// figure averages the two together and reports neither.
///
/// Pixels are split by how much *structure* surrounds them, measured on a plane smoothed past the
/// scale the noise lives at so the classification is not itself made of noise. One is what a
/// uniform residual reads; the body's own JPEG sits near it and a shrinkage does not.
fn edge_bias(image: rawshim::rgb::RgbRef<'_>) -> (f64, f64, f64) {
    let (w, h) = (image.width, image.height);
    let luma: Vec<f64> = (0..w * h)
        .map(|i| {
            0.2126 * f64::from(image.data[i * 3])
                + 0.7152 * f64::from(image.data[i * 3 + 1])
                + 0.0722 * f64::from(image.data[i * 3 + 2])
        })
        .collect();

    const TAPS: [f64; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];
    let blur = |src: &[f64], hole: usize| -> Vec<f64> {
        let mut rows = vec![0.0f64; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut sum = 0.0;
                for (t, k) in TAPS.iter().enumerate() {
                    let dx = (t as isize - 2) * hole as isize;
                    let sx = (x as isize + dx).clamp(0, w as isize - 1) as usize;
                    sum += k * src[y * w + sx];
                }
                rows[y * w + x] = sum;
            }
        }
        let mut out = vec![0.0f64; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut sum = 0.0;
                for (t, k) in TAPS.iter().enumerate() {
                    let dy = (t as isize - 2) * hole as isize;
                    let sy = (y as isize + dy).clamp(0, h as isize - 1) as usize;
                    sum += k * rows[sy * w + x];
                }
                out[y * w + x] = sum;
            }
        }
        out
    };

    // The finest octave is the grain; the plane two smoothings up is the picture under it, whose
    // own gradient is what says a pixel is near an edge without consulting the noise.
    let first = blur(&luma, 1);
    let grain: Vec<f64> = luma.iter().zip(&first).map(|(v, s)| (v - s).abs()).collect();
    let structure_plane = blur(&blur(&first, 2), 4);
    let structure: Vec<f64> = (0..w * h)
        .map(|i| {
            let (x, y) = (i % w, i / w);
            let at = |dx: isize, dy: isize| {
                let sx = (x as isize + dx).clamp(0, w as isize - 1) as usize;
                let sy = (y as isize + dy).clamp(0, h as isize - 1) as usize;
                structure_plane[sy * w + sx]
            };
            ((at(1, 0) - at(-1, 0)).powi(2) + (at(0, 1) - at(0, -1)).powi(2)).sqrt()
        })
        .collect();

    let mut ranked: Vec<f64> = structure.clone();
    let third = ranked.len() / 3;
    ranked.select_nth_unstable_by(third, f64::total_cmp);
    let calm = ranked[third];
    let mut ranked: Vec<f64> = structure.clone();
    let two_thirds = ranked.len() * 2 / 3;
    ranked.select_nth_unstable_by(two_thirds, f64::total_cmp);
    let busy = ranked[two_thirds];

    let median = |mut v: Vec<f64>| -> f64 {
        if v.is_empty() {
            return 0.0;
        }
        let mid = v.len() / 2;
        v.select_nth_unstable_by(mid, f64::total_cmp);
        v[mid] * 1.4826
    };
    let pick = |keep: &dyn Fn(f64) -> bool| -> Vec<f64> {
        grain
            .iter()
            .zip(&structure)
            .filter(|(_, s)| keep(**s))
            .map(|(g, _)| *g)
            .collect()
    };
    let flat = median(pick(&|s| s <= calm));
    let edge = median(pick(&|s| s >= busy));
    (flat, edge, edge / flat.max(1e-9))
}

/// A median absolute three-tap Laplacian over the two colour differences, which is what luma
/// cannot see.
///
/// **A grade that speckles a saturated surface moves chroma and leaves luma alone**, so a luma
/// figure reports it as smooth or, worse, reports the smoother render as rougher: the neutral arm
/// renders the Mazda's wing mirror visibly clean at 2.81 where the matched arm renders it visibly
/// grainy at 1.73, because the neutral one is brighter and carries more luma noise. Every stage
/// whose job is colour needs the other number.
///
/// Reported per axis rather than summed. A cast that pulls one colour difference is a different
/// defect from noise across both, and one number cannot tell them apart.
fn chroma_roughness(image: rawshim::rgb::RgbRef<'_>) -> [f64; 2] {
    let axis = |i: usize, axis: usize| {
        let at = |c: usize| f64::from(image.data[i * 3 + c]);
        let luma = 0.2126 * at(0) + 0.7152 * at(1) + 0.0722 * at(2);
        at(axis * 2) - luma
    };
    std::array::from_fn(|which| {
        let mut laps: Vec<f64> = Vec::new();
        for row in 0..image.height {
            for col in 0..image.width - 2 {
                let at = row * image.width + col;
                laps.push(
                    (axis(at, which) - 2.0 * axis(at + 1, which) + axis(at + 2, which)).abs(),
                );
            }
        }
        let mid = laps.len() / 2;
        laps.select_nth_unstable_by(mid, f64::total_cmp);
        laps[mid] / 1.6521
    })
}

/// The camera's own crop of the same subject, found rather than computed.
///
/// The body distortion-crops its preview, so the same frame coordinates land on a different piece
/// of the picture even where the two are the same pixel size - and comparing a sharpener against a
/// panel that is half a lattice bar out says nothing. Searched over translation only: a whole crop
/// that lines up is the evidence that translation was enough.
fn aligned(
    preview: rawshim::rgb::RgbRef<'_>,
    want: rawshim::rgb::RgbRef<'_>,
    x: usize,
    y: usize,
    side: usize,
) -> (i64, i64, rawshim::rgb::Rgb) {
    const RANGE: i64 = 128;
    // Every fourth pixel, on a search whose answer is a whole-pixel offset: what is being matched
    // is where the lattice bars are, and they are hundreds of samples across.
    const STRIDE: usize = 4;
    let luma = |image: &rawshim::rgb::RgbRef<'_>, at: usize| {
        i64::from(image.data[at * 3]) * 2126
            + i64::from(image.data[at * 3 + 1]) * 7152
            + i64::from(image.data[at * 3 + 2]) * 722
    };
    let cost = |dx: i64, dy: i64| -> i64 {
        let (left, top) = (x as i64 + dx, y as i64 + dy);
        if left < 0
            || top < 0
            || left as usize + side > preview.width
            || top as usize + side > preview.height
        {
            return i64::MAX;
        }
        let mut sum = 0i64;
        for row in (0..side).step_by(STRIDE) {
            for col in (0..side).step_by(STRIDE) {
                let here = luma(&want, row * want.width + col);
                let there =
                    luma(&preview, (top as usize + row) * preview.width + left as usize + col);
                sum += (here - there).abs();
            }
        }
        sum
    };

    let mut best = (0i64, 0i64, i64::MAX);
    for step in [8i64, 1] {
        let (from_x, from_y) = (best.0, best.1);
        let span = match step {
            8 => RANGE,
            _ => 8,
        };
        for dy in (-span..=span).step_by(step as usize) {
            for dx in (-span..=span).step_by(step as usize) {
                let (dx, dy) = (from_x + dx, from_y + dy);
                let at = cost(dx, dy);
                if at < best.2 {
                    best = (dx, dy, at);
                }
            }
        }
    }
    let (dx, dy, _) = best;
    (dx, dy, cut(preview, (x as i64 + dx) as usize, (y as i64 + dy) as usize, side))
}

/// Every crop written as its own luma, camera panel included.
///
/// **The one way to answer "is it the luma or the colour".** A reader looking at a crop cannot
/// separate them, and coloured mottle at a few codes reads as much coarser noise than achromatic
/// grain of the same amplitude - so a judgement about grain *size* made on a colour crop is a
/// judgement about whichever of the two happens to dominate. Here both panels lose their chroma and
/// what is left is the only thing under discussion.
fn greyscale(image: rawshim::rgb::Rgb) -> rawshim::rgb::Rgb {
    if std::env::var("BOWERBIRD_CROP_GREY").is_err() {
        return image;
    }
    let mut data = image.data;
    for i in 0..image.width * image.height {
        let luma = 0.2126 * f32::from(data[i * 3])
            + 0.7152 * f32::from(data[i * 3 + 1])
            + 0.0722 * f32::from(data[i * 3 + 2]);
        let grey = luma.round().clamp(0.0, 255.0) as u8;
        data[i * 3] = grey;
        data[i * 3 + 1] = grey;
        data[i * 3 + 2] = grey;
    }
    rawshim::rgb::Rgb { width: image.width, height: image.height, data }
}

fn crop_zoom() -> usize {
    std::env::var("BOWERBIRD_CROP_ZOOM").ok().and_then(|z| z.parse().ok()).unwrap_or(1)
}

/// **Nearest neighbour.** A pattern at the pixel's own scale is what a sharpener goes wrong at, and
/// a crop written at 1:1 is exactly the size at which it cannot be told from grain. Replicating
/// rather than interpolating, so what is magnified is the samples and not a resampler's opinion of
/// them.
fn magnify(image: rawshim::rgb::Rgb, by: usize) -> rawshim::rgb::Rgb {
    if by <= 1 {
        return image;
    }
    let (w, h) = (image.width, image.height);
    let mut out = vec![0u8; w * by * h * by * 3];
    for y in 0..h * by {
        for x in 0..w * by {
            let from = ((y / by) * w + x / by) * 3;
            out[(y * w * by + x) * 3..][..3].copy_from_slice(&image.data[from..from + 3]);
        }
    }
    rawshim::rgb::Rgb { width: w * by, height: h * by, data: out }
}

/// One grid per crop: the body's own JPEG of the frame, then the slider walked across its track.
///
/// The camera panel is cut against the *first* render rather than against each, since `aligned`
/// searches for the offset that lines the two up and a denoise strong enough to change that offset
/// would be answering a different question than the one a reader is asking of the grid.
fn sweep_grid(
    path: &str,
    out: &str,
    sweep: &[f64],
    colour: Option<f64>,
    luma: Option<f64>,
    columns: usize,
    crops: &[(usize, usize, usize)],
    edge: usize,
    stages: Stages<'_>,
) {
    assert!(
        luma.is_none() || colour.is_none(),
        "--grid-luminance and --grid-colour hold both axes, leaving nothing for --grid to walk",
    );
    // `graded` writes the encoded still to one fixed name, so a sweep would leave the last
    // position's file wearing every position's label. Refused rather than silently kept, the whole
    // point of that file being that `avif_crop` can trust which render it came from.
    assert!(
        stages.encode.is_none(),
        "--encode writes one still per run and --grid renders many; ask for one of them",
    );
    let preview = rawshim::decode_embedded_rgb(path, 100_000).expect("an embedded preview");
    let mut panels: Vec<Vec<rawshim::rgb::Rgb>> = vec![Vec::new(); crops.len()];

    // `Fit::Only` measures this frame and filters nothing, which is what the suggestion is read off
    // - the same number the panel would be handed on open.
    let opened = rawshim::decode_frame_denoised(
        path,
        0,
        rawshim::galosh::Detail::at(0.0, 0.0),
        rawshim::galosh::Fit::Only,
    )
    .expect("decode");
    let measured_gains = opened.wb_gains;
    let measured = opened.noise.expect("a mosaic has a noise fit");
    let model = measured.model();
    let (want_luma, want_colour) = model.suggested_amounts();
    eprintln!(
        "  measured alpha {:.6} sigma_sq {:.8} read {:.5} at_white {:.4} gains {:.3}/{:.3}/{:.3}",
        model.alpha,
        model.sigma_sq,
        model.read_noise(),
        model.at_white(),
        measured_gains[0],
        measured_gains[1],
        measured_gains[2],
    );
    eprintln!("  suggests luminance {want_luma:.1} colour {want_colour:.1}");

    let mut walk: Vec<f64> = sweep.to_vec();
    walk.push(f64::NAN);

    for &amount in &walk {
        let started = std::time::Instant::now();
        // The last panel is what the measurement asks for rather than a position on the walk, so
        // the suggestion is read in the same grid as the track it has to be judged against.
        //
        // **A held axis stays held here too.** The suggestion moves both, so substituting it whole
        // into a grid that is holding one of them puts a panel in the sheet that differs from its
        // neighbours on two axes at once - which is the one thing a reader of a single-axis sweep
        // will not think to check.
        let pair = match amount.is_nan() {
            true => (luma.unwrap_or(want_luma), colour.unwrap_or(want_colour)),
            false => match luma {
                Some(held) => (held, amount),
                None => (amount, colour.unwrap_or(amount)),
            },
        };
        let (data, width, height) =
            rendition(path, rawshim::galosh::Detail::at(pair.0, pair.1), edge, stages);
        let whole = rawshim::rgb::RgbRef { width, height, data: &data };
        eprintln!(
            "  luminance {} colour {} in {}ms",
            pair.0,
            pair.1,
            started.elapsed().as_millis()
        );
        for (i, (x, y, side)) in crops.iter().enumerate() {
            let want = cut(whole, *x, *y, *side);
            if panels[i].is_empty() {
                let (_, _, from) = aligned(preview.as_ref(), want.as_ref(), *x, *y, *side);
                panels[i].push(magnify(from, crop_zoom()));
            }
            let [cr, cb] = chroma_roughness(want.as_ref());
            let [r, g, b] = channel_means(want.as_ref());
            eprintln!(
                "    {x},{y} luma {} chroma {cr:.2}/{cb:.2} rgb {r:.1}/{g:.1}/{b:.1}\n      \
                 cr by scale {}  cb by scale {}",
                bands(want.as_ref(), Plane::Luma),
                bands(want.as_ref(), Plane::Cr),
                bands(want.as_ref(), Plane::Cb),
            );
            panels[i].push(magnify(want, crop_zoom()));
        }
    }

    for (i, (x, y, _)) in crops.iter().enumerate() {
        let sheet = grid(&panels[i], columns);
        let at = format!("{out}/grid-{x}-{y}.jpg");
        let bytes = rawshim::jpeg::encode(sheet.as_ref(), 95).expect("the grid encodes");
        std::fs::write(&at, bytes).expect("the grid writes");
        eprintln!("  wrote {at} ({}x{})", sheet.width, sheet.height);
    }
}

/// Panels in reading order, so a slider position's place in the list is its place in the picture.
///
/// Nothing here writes a caption - there is no font in this crate, and a grid captioned by its
/// caller in prose beats one captioned by hand-plotted pixels.
fn grid(panels: &[rawshim::rgb::Rgb], columns: usize) -> rawshim::rgb::Rgb {
    assert!(columns > 0, "a grid needs at least one column");
    assert!(!panels.is_empty(), "a grid needs a panel");
    let (pw, ph) = (panels[0].width, panels[0].height);
    // Every row is copied at the first panel's stride, so a panel of another size would be read at
    // the wrong offsets and laid into the sheet as plausible-looking garbage rather than failing.
    assert!(
        panels.iter().all(|p| p.width == pw && p.height == ph),
        "a grid's panels are all one size",
    );
    let rows = panels.len().div_ceil(columns);
    let width = columns * pw + (columns - 1) * GRID_GAP;
    let height = rows * ph + (rows - 1) * GRID_GAP;
    // Mid grey, so the separator reads against both a blown highlight and a black shadow.
    let mut data = vec![128u8; width * height * 3];
    for (i, panel) in panels.iter().enumerate() {
        let ox = (i % columns) * (pw + GRID_GAP);
        let oy = (i / columns) * (ph + GRID_GAP);
        for y in 0..ph {
            let from = y * pw * 3;
            let to = ((oy + y) * width + ox) * 3;
            data[to..to + pw * 3].copy_from_slice(&panel.data[from..from + pw * 3]);
        }
    }
    rawshim::rgb::Rgb { width, height, data }
}

const GRID_GAP: usize = 8;

/// Near-lossless, because the whole point of a crop here is to look at grain: an encoder that
/// smoothed it would be answering the question the harness was opened to ask.
const CROP_QUANTIZER: i32 = 4;

/// Fastest. These are written to be looked at once and deleted.
const CROP_SPEED: i32 = 10;

/// Mean per channel, which says whether two renders were graded alike.
///
/// Per channel rather than on luma, because a luma mean cannot tell a lifted patch from a tinted
/// one - and the tint is the half a reader notices. The three together are a colour, and two
/// renders of one subject can be held to it.
fn channel_means(image: rawshim::rgb::RgbRef<'_>) -> [f64; 3] {
    let mut sum = [0.0f64; 3];
    for i in 0..image.width * image.height {
        for c in 0..3 {
            sum[c] += f64::from(image.data[i * 3 + c]);
        }
    }
    sum.map(|total| total / (image.width * image.height) as f64)
}

fn write(path: &str, image: rawshim::rgb::RgbRef<'_>, file: File) {
    rawshim::avif::encode_rendition(
        std::borrow::Cow::Borrowed(image.data),
        image.width,
        image.height,
        file.quantizer,
        CROP_SPEED,
        file.full_chroma,
        path,
    )
    .expect("the crop encodes");
    eprintln!("    wrote {path}");

    // **And a JPEG beside it**, because the AVIF is the thing under test and not a thing to look
    // at: it is HDR, tagged PQ, and most viewers either refuse it or tone-map it themselves - so
    // the one format that answers "does this edge look right" is the one anything opens. Quality
    // high enough that what it adds is under what the AVIF beside it already did.
    //
    // **Decoded back out of the file above rather than encoded from the frame**, so that what the
    // reader sees is what the rendition holds. A JPEG taken from the samples directly cannot show
    // the encoder at all, which leaves the one stage a reader is actually looking at - 4:2:0 at a
    // quantizer, on the export's path - invisible to the harness that exists to find it.
    //
    // **Unless the encoder is the thing in question**, which it is whenever a pattern at the
    // pixel's own scale is being chased: AV1's own artefacts are blocky and directional, so a
    // harness that can only show its output cannot tell them from the pipeline's. Set to compare
    // the two and find out which is which.
    // One row of the crop as numbers, which is the only way to tell a staircase from a ripple: a
    // run of equal samples between jumps is the picture being quantised, an alternation either
    // side of a trend is the deconvolution ringing, and at a glance they look alike.
    //
    // Down a column as well as across a row, because the two answer different questions about a
    // banded gradient: a contour of a smooth ramp runs perpendicular to it, so lines that are
    // horizontal in one and vertical in the other are the ramp being quantised, while lines
    // horizontal in both are structure that came off the sensor's rows.
    for (name, down) in [("row", false), ("col", true)] {
        let Some(spec) = std::env::var(format!("BOWERBIRD_CROP_{}", name.to_uppercase())).ok()
        else {
            continue;
        };
        let (index, from) = spec.split_once(',').unwrap_or((spec.as_str(), "0"));
        let at = index.parse::<usize>().expect("a number");
        let from = from.parse::<usize>().expect("a number");
        let (along, at) = match down {
            true => (image.height, at.min(image.width - 1)),
            false => (image.width, at.min(image.height - 1)),
        };
        let sample = |step: usize| match down {
            true => (from + step) * image.width + at,
            false => at * image.width + from + step,
        };
        let span = along.saturating_sub(from).min(64);
        let luma: Vec<i32> = (0..span)
            .map(|step| {
                let p = sample(step) * 3;
                (i32::from(image.data[p]) * 2126
                    + i32::from(image.data[p + 1]) * 7152
                    + i32::from(image.data[p + 2]) * 722)
                    / 10000
            })
            .collect();
        eprintln!("    {name} {at} from {from}: {luma:?}");
        // Per channel over the same run, because the deconvolution moves luma alone and hands the
        // chroma differences across untouched - so on a surface with one channel near the top,
        // a lifted luma clips that channel while its neighbours still have room, and what the
        // reader sees is not the luma the pass computed.
        for (channel, offset) in [("r", 0usize), ("g", 1), ("b", 2)] {
            let run: Vec<u8> =
                (0..span.min(40)).map(|step| image.data[sample(step) * 3 + offset]).collect();
            eprintln!("      {channel}: {run:?}");
        }
    }

    // Whether what a crop's rows and columns carry is the same thing, which is what says a banded
    // shadow came off the sensor rather than out of the pipeline. Each row's mean against a smooth
    // ramp through its neighbours, and the same down the columns: a sensor whose rows sit at
    // slightly different offsets makes the row figure much the larger, while an artefact of the
    // picture's own gradient moves both.
    if std::env::var("BOWERBIRD_CROP_BANDS").is_ok() {
        let luma = |at: usize| {
            f64::from(image.data[at * 3]) * 0.2126
                + f64::from(image.data[at * 3 + 1]) * 0.7152
                + f64::from(image.data[at * 3 + 2]) * 0.0722
        };
        // A second difference, so a straight ramp of any slope reads zero and only a line that
        // departs from its own neighbours counts.
        let wiggle = |means: &[f64]| -> f64 {
            let total: f64 = means
                .windows(3)
                .map(|w| (w[1] - (w[0] + w[2]) / 2.0).abs())
                .sum();
            total / (means.len().saturating_sub(2)).max(1) as f64
        };
        let rows: Vec<f64> = (0..image.height)
            .map(|y| (0..image.width).map(|x| luma(y * image.width + x)).sum::<f64>()
                / image.width as f64)
            .collect();
        let cols: Vec<f64> = (0..image.width)
            .map(|x| (0..image.height).map(|y| luma(y * image.width + x)).sum::<f64>()
                / image.height as f64)
            .collect();
        eprintln!(
            "    bands: rows {:.4} columns {:.4}, ratio {:.2}",
            wiggle(&rows),
            wiggle(&cols),
            wiggle(&rows) / wiggle(&cols).max(1e-9)
        );
    }

    // The same measurement `edge_spread.slang` makes, on the host and over the written crop: a
    // second implementation kept deliberately, because the pipeline's own number is the thing being
    // questioned whenever a render comes back soft, and a probe that shares its code cannot answer.
    //
    // Every near-vertical transition that rises monotonically over at most eight pixels, by its
    // 10-90 distance; the sharpest of them bound the point spread from below, since a real scene
    // edge can be softer than the optics but never harder.
    if std::env::var("BOWERBIRD_CROP_ESF").is_ok() {
        let luma: Vec<f32> = (0..image.width * image.height)
            .map(|i| {
                let p = i * 3;
                0.2126 * f32::from(image.data[p])
                    + 0.7152 * f32::from(image.data[p + 1])
                    + 0.0722 * f32::from(image.data[p + 2])
            })
            .collect();
        let mut widths: Vec<f32> = Vec::new();
        for y in 0..image.height {
            let row = &luma[y * image.width..(y + 1) * image.width];
            for x in 4..image.width - 12 {
                // A run that climbs without pause, with a settled level either side of it.
                let Some(end) = (1..9).find(|&n| row[x + n + 1] <= row[x + n]) else { continue };
                if end < 2 {
                    continue;
                }
                let (low, high) = (row[x], row[x + end]);
                let step = high - low;
                if step < 24.0 || row[x - 1] > low || row[x - 2] > row[x - 1] {
                    continue;
                }
                let cross = |frac: f32| -> Option<f32> {
                    let want = low + step * frac;
                    (0..end).find_map(|n| {
                        let (a, b) = (row[x + n], row[x + n + 1]);
                        (a <= want && want <= b).then(|| x as f32 + n as f32 + (want - a) / (b - a))
                    })
                };
                if let (Some(lo), Some(hi)) = (cross(0.1), cross(0.9)) {
                    widths.push(hi - lo);
                }
            }
        }
        widths.sort_by(f32::total_cmp);
        if widths.len() >= 20 {
            // 10-90 of a Gaussian's own edge is 2.563 sigma, which is what turns a width into the
            // blur the five taps are being asked to invert.
            let at = |q: f64| widths[((widths.len() - 1) as f64 * q) as usize];
            eprintln!(
                "    edge spread over {} edges: sharpest 10% {:.2}px (sigma {:.2}), median {:.2}px (sigma {:.2})",
                widths.len(),
                at(0.1),
                at(0.1) / 2.563,
                at(0.5),
                at(0.5) / 2.563,
            );
        }
    }

    let beside = path.trim_end_matches(".avif").to_string() + ".jpg";
    let stored = match std::env::var("BOWERBIRD_CROP_RAW").is_ok() {
        true => rawshim::rgb::Rgb {
            width: image.width,
            height: image.height,
            data: image.data.to_vec(),
        },
        false => std::fs::read(path)
            .ok()
            .and_then(|bytes| rawshim::image::decode(&bytes, 0).ok())
            .expect("the crop reads back"),
    };
    // **Beside, in one file.** Crops in separate files are compared by remembering the first one,
    // which is exactly the comparison a sharpening change needs not to rely on. The named images
    // go on the left in the order given, at whatever size they already are; this render goes last.
    let left: Vec<rawshim::rgb::Rgb> = std::env::var("BOWERBIRD_CROP_BESIDE")
        .unwrap_or_default()
        .split(',')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let bytes = std::fs::read(p).unwrap_or_else(|why| panic!("{p} reads: {why}"));
            rawshim::image::decode(&bytes, 0).unwrap_or_else(|why| panic!("{p} decodes: {why}"))
        })
        .collect();
    let stored = match left.is_empty() {
        true => stored,
        false => {
            const GAP: usize = 8;
            let panels: Vec<&rawshim::rgb::Rgb> = left.iter().chain([&stored]).collect();
            let height = panels.iter().map(|p| p.height).max().unwrap_or(0);
            let width = panels.iter().map(|p| p.width + GAP).sum::<usize>() - GAP;
            let mut out = vec![32u8; width * height * 3];
            let mut at = 0;
            for piece in panels {
                for y in 0..piece.height {
                    let from = y * piece.width * 3;
                    let into = (y * width + at) * 3;
                    out[into..into + piece.width * 3]
                        .copy_from_slice(&piece.data[from..from + piece.width * 3]);
                }
                at += piece.width + GAP;
            }
            rawshim::rgb::Rgb { width, height, data: out }
        }
    };
    match rawshim::jpeg::encode(stored.as_ref(), 95) {
        Ok(bytes) => {
            std::fs::write(&beside, bytes).expect("the crop writes");
            eprintln!("    wrote {beside}");
        }
        Err(why) => eprintln!("    no JPEG beside it: {why}"),
    }
}
