//! PMRID for a model trainer in another process: RAWs decoded and dust-removed as the editor does,
//! then denoised by PMRID at the editor's AUTO amounts, and mosaics the trainer made denoised
//! against a fit it hands over.
//!
//! One JSON request a line on stdin, one JSON reply a line on stdout. Samples travel as files of
//! little-endian `f32`, row-major, since a 61MP frame is a quarter of a gigabyte.
//!
//! ```text
//! {"open": "<raw>", "out": "<file>", "noisy": bool?}
//!   writes the picture area, conditioned, dust-removed and, unless `noisy`, denoised, cropped to
//!   even sides
//!   -> {"width": w, "height": h, "cfa": [4 colours from its top-left], "gains": [r, g, b], "fit": NoiseFit|null}
//! {"decode": "<raw>", "out": "<file>", "floor": long edge}
//!   decodes the RAW as the library does an unedited photo for a rendition `floor` on its long edge:
//!   dust removed, denoised, highlights reconstructed, demosaiced, cropped and stood upright; writes
//!   it as interleaved Rec.2020 RGB over full scale
//!   -> {"width": w, "height": h, "ceilings": [r, g, b], "matrix": camera to Rec.2020}
//! {"develop": "<file>", "out": "<file>", "width": w, "height": h, "ceilings": [..], "matrix": [..]}
//!   demosaics an RGGB mosaic of camera light over full scale, clipped at `ceilings`, as a decode
//!   halving it does, highlights reconstructed; writes w/2 x h/2 interleaved Rec.2020 RGB
//!   -> {}
//! {"header": "<raw>"}
//!   reads only the RAW's metadata
//!   -> {"iso": n, "shutter": seconds, "aperture": f-number}, each 0 where the camera recorded none
//! {"denoise": "<file>", "out": "<file>", "width": w, "height": h, "cfa": [..], "gains": [..], "fit": NoiseFit}
//!   denoises each of the file's stacked w x h mosaics on its own
//!   -> {}
//! {"measure": "<raw>"}
//!   opens the RAW whole for what the chain below needs of it: matrix, levels, blur, noise, defringe
//!   -> Measured
//! {"sharpen": "<raw>", "mosaics": "<file>", "out": "<file>", "width": w, "height": h, "gains": [..],
//!  "measured": Measured?, "amount": sharpen?}
//!   takes each of the file's stacked w x h RGGB mosaics through the rest of the editor's chain for
//!   the photo unedited, as `support::cut` does a whole frame, measuring the RAW unless `measured`
//!   is given; writes each twice, plain (demosaiced and coded) then defringed and capture-sharpened
//!   at `amount`, the editor's default unless given, as Rec.2020 light over reference white,
//!   interleaved RGB
//!   -> {"matrix": camera to Rec.2020, "sigma": the sharpen's}
//! {"grade": "<raw>", "floor": long edge, "out": "<file>", "output": "pq"|"srgb", "edge": long edge?,
//!  "taken": "<file>"?, "gains": [g, ...]?, "alone": bool?}
//!   opens the RAW as the library renders it unedited (`support::Open::shipped` at `floor`) and grades
//!   it as a rendition with nobody's edit on it, `edge` on its long side (the frame's own size unless
//!   given); with `taken`, interleaved RGB light at the frame's size in `decode`'s units, once per
//!   gain, each time taking that much of it out of the decode, never below black, before the open
//!   measures and grades what is left; or with `alone`, grading that much of it in place of the
//!   photo, under the photo's own grade. Writes each image's interleaved RGB as little-endian `u16`,
//!   16-bit PQ Rec.2020 or sRGB codes in the low byte
//!   -> {"width": w, "height": h, "count": n}
//! ```
//!
//! `NoiseFit` is `galosh::NoiseFit` as serde writes it: `alpha`, `sigmaSq`, `unifiedSigma`,
//! `darkRef`. A request that fails replies `{"error": "...", "unreadable": bool}` and the server
//! carries on; `unreadable` is the file's own fault, which no retry mends.
//!
//! Launch it with `CARGO_MANIFEST_DIR` set, as cargo would: `gpu::leave` otherwise lets NVIDIA's
//! driver fault at exit.

mod support;

use std::io::{BufRead, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Mutex;

use denoise::galosh::{Denoiser, Detail, NoiseFit};
use units::light::Light;

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum Request {
    Open {
        open: String,
        out: String,
        #[serde(default)]
        noisy: bool,
    },
    Denoise(Denoise),
    Sharpen(Sharpen),
    Measure {
        measure: String,
    },
    Decode {
        decode: String,
        out: String,
        floor: u32,
    },
    Develop(Develop),
    Grade(Grade),
    Header {
        header: String,
    },
}

#[derive(serde::Deserialize)]
struct Develop {
    develop: String,
    out: String,
    width: usize,
    height: usize,
    ceilings: [f32; 3],
    matrix: [[f32; 3]; 3],
}

#[derive(serde::Deserialize)]
struct Grade {
    grade: String,
    floor: u32,
    out: String,
    output: Coding,
    edge: Option<usize>,
    taken: Option<String>,
    gains: Option<Vec<f32>>,
    #[serde(default)]
    alone: bool,
}

#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Coding {
    Pq,
    Srgb,
}

#[derive(serde::Deserialize)]
struct Sharpen {
    sharpen: String,
    mosaics: String,
    out: String,
    width: usize,
    height: usize,
    gains: [f32; 3],
    measured: Option<Measured>,
    amount: Option<f64>,
    /// The mosaics' pixels per photosite of the photo, 2 for a 2x upscale; 1 unless given.
    scale: Option<usize>,
    /// The mosaics are a 2x upscale to demosaic and take back to the photo's size before the
    /// coding, as the upscaler denoiser does; the sharpen then meets the photo's own pixels.
    #[serde(default)]
    supersampled: bool,
    /// Renders only this one; both, plain first, unless given.
    #[serde(default)]
    only: Option<Shown>,
}

#[derive(serde::Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Shown {
    Plain,
    Sharpened,
}

/// What the rest of the chain needs of a photo that only opening it whole can measure.
#[derive(serde::Deserialize, serde::Serialize)]
struct Measured {
    matrix: [[f32; 3]; 3],
    levels: colour::tone::Levels,
    /// Gaussian sigma in the sensor's pixels.
    capture_blur: Option<f32>,
    sensor_long: usize,
    noise: Option<NoiseFit>,
    wb_gains: [f32; 3],
    reduced: usize,
    defringe: Option<(f32, f32)>,
}

#[derive(serde::Deserialize)]
struct Denoise {
    denoise: String,
    out: String,
    width: usize,
    height: usize,
    cfa: [u32; 4],
    gains: [f32; 3],
    fit: NoiseFit,
}

enum Failed {
    Unreadable(String),
    Error(String),
}

const DETAIL: Detail = Detail::AUTO.using(Denoiser::Pmrid);

/// What the last panic said, set by the hook and taken by the request it ended.
static PANICKED: Mutex<Option<String>> = Mutex::new(None);

fn main() {
    let gpu = gpu::device().expect("an adapter");
    let kernels = denoise::galosh::device(gpu).expect("the GALOSH kernels built");
    let network = denoise::pmrid::device(gpu).expect("the network built");
    let report = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|text| text.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        *PANICKED.lock().unwrap_or_else(|e| e.into_inner()) = Some(message);
        report(info);
    }));
    let mut stdout = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        let reply = match serde_json::from_str::<Request>(&line) {
            Ok(Request::Open { open, out, noisy }) => catch_unwind(AssertUnwindSafe(|| {
                opened(gpu, kernels, network, &open, &out, noisy)
            }))
            .unwrap_or_else(|_| Err(Failed::Error(panicked(&format!("opening {open}"))))),
            Ok(Request::Denoise(request)) => {
                catch_unwind(AssertUnwindSafe(|| denoised(gpu, network, &request))).unwrap_or_else(
                    |_| {
                        Err(Failed::Error(panicked(&format!(
                            "denoising {}",
                            request.denoise
                        ))))
                    },
                )
            }
            Ok(Request::Sharpen(request)) => {
                catch_unwind(AssertUnwindSafe(|| sharpened(gpu, &request))).unwrap_or_else(|_| {
                    Err(Failed::Error(panicked(&format!(
                        "sharpening for {}",
                        request.sharpen
                    ))))
                })
            }
            Ok(Request::Measure { measure }) => catch_unwind(AssertUnwindSafe(|| {
                measured(&measure).map(|found| serde_json::json!(found))
            }))
            .unwrap_or_else(|_| Err(Failed::Error(panicked(&format!("measuring {measure}"))))),
            Ok(Request::Decode { decode, out, floor }) => {
                catch_unwind(AssertUnwindSafe(|| decoded(&decode, &out, floor))).unwrap_or_else(
                    |_| Err(Failed::Unreadable(panicked(&format!("decoding {decode}")))),
                )
            }
            Ok(Request::Develop(request)) => {
                catch_unwind(AssertUnwindSafe(|| developed(gpu, &request))).unwrap_or_else(|_| {
                    Err(Failed::Error(panicked(&format!(
                        "developing {}",
                        request.develop
                    ))))
                })
            }
            Ok(Request::Grade(request)) => catch_unwind(AssertUnwindSafe(|| graded(&request)))
                .unwrap_or_else(|_| {
                    Err(Failed::Error(panicked(&format!(
                        "grading {}",
                        request.grade
                    ))))
                }),
            Ok(Request::Header { header }) => catch_unwind(AssertUnwindSafe(|| {
                formats::header::read_path(&header)
                    .map(|read| {
                        serde_json::json!({
                            "iso": read.iso,
                            "shutter": read.shutter,
                            "aperture": read.aperture,
                        })
                    })
                    .ok_or_else(|| Failed::Unreadable(format!("{header} has no readable header")))
            }))
            .unwrap_or_else(|_| Err(Failed::Unreadable(panicked(&format!("reading {header}"))))),
            Err(why) => Err(Failed::Error(format!("not a request: {why}"))),
        };
        let reply = reply.unwrap_or_else(|failed| match failed {
            Failed::Unreadable(why) => serde_json::json!({ "error": why, "unreadable": true }),
            Failed::Error(why) => serde_json::json!({ "error": why, "unreadable": false }),
        });
        writeln!(stdout, "{reply}").expect("stdout");
        stdout.flush().expect("stdout");
    }
}

fn panicked(doing: &str) -> String {
    let message = PANICKED.lock().unwrap_or_else(|e| e.into_inner()).take();
    format!("{doing} panicked: {}", message.unwrap_or_default())
}

fn opened(
    gpu: &'static gpu::Gpu,
    kernels: &denoise::galosh::Galosh,
    network: &denoise::pmrid::Pmrid,
    path: &str,
    out: &str,
    noisy: bool,
) -> Result<serde_json::Value, Failed> {
    let bytes = std::fs::read(path)
        .map_err(|why| Failed::Error(format!("could not read {path}: {why}")))?;
    // rawler panics on corrupt files under overflow checks: the file's fault, unlike a panic later.
    let decoded = catch_unwind(AssertUnwindSafe(|| {
        pollster::block_on(rawshim::decode_rawler::open_bytes(&bytes))
    }))
    .map_err(|_| Failed::Unreadable(panicked(&format!("decoding {path}"))))?;
    let held = match decoded {
        Ok(rawshim::decode::Held::Mosaic(held)) => held,
        Ok(rawshim::decode::Held::Rendered(_)) => {
            return Err(Failed::Unreadable(format!("{path} has no mosaic")));
        }
        Err(why) => return Err(Failed::Unreadable(format!("{path}: {why}"))),
    };
    drop(bytes);
    let cfa = held.cfa();
    if !cfa.is_bayer() {
        return Err(Failed::Unreadable(format!("{path} is not Bayer")));
    }
    let mut mosaic = held.device_mosaic().duplicate(gpu);
    let (left, top, width, height) = held.crop();
    if width == 0 || height == 0 || left + width > mosaic.width || top + height > mosaic.height {
        return Err(Failed::Unreadable(format!(
            "{path}'s picture area falls outside its mosaic"
        )));
    }
    let dust = denoise::dust::Settings::default().wanted(None);
    pollster::block_on(denoise::dust::run(gpu, &mosaic, &held.glass(), &dust));
    let fit = pollster::block_on(denoise::galosh::fit(
        gpu,
        kernels,
        &mosaic,
        &cfa,
        held.ceilings(),
    ));
    let usable = fit.usable();
    if usable && !noisy {
        filter(gpu, network, &mut mosaic, &cfa, held.ceilings(), fit);
    }
    let picture = pollster::block_on(mosaic.window(gpu, left, top, width, height).read(gpu))
        .ok_or_else(|| Failed::Error("the picture did not read back".into()))?;
    write(out, &picture)?;
    let at_origin = [(0, 0), (0, 1), (1, 0), (1, 1)].map(|(r, c)| cfa.colour_at(top + r, left + c));
    Ok(serde_json::json!({
        "width": width,
        "height": height,
        "cfa": at_origin,
        "gains": held.ceilings(),
        "fit": usable.then_some(fit),
    }))
}

fn decoded(path: &str, out: &str, floor: u32) -> Result<serde_json::Value, Failed> {
    let frame = rawshim::decode::frame_from_path(
        path,
        Detail::AUTO,
        floor,
        false,
        denoise::galosh::wanted(None, Detail::AUTO),
        denoise::dust::Settings::default().wanted(None),
    )
    .ok_or_else(|| Failed::Unreadable(format!("{path} did not decode")))?;
    let matrix = frame
        .matrix
        .ok_or_else(|| Failed::Unreadable(format!("{path} has no mosaic")))?;
    let (width, height, ceilings) = (frame.width, frame.height, frame.wb_gains);
    let frame = pollster::block_on(frame.to_host())
        .ok_or_else(|| Failed::Error("the frame did not read back".into()))?;
    let samples = frame
        .samples16()
        .ok_or_else(|| Failed::Error("the frame is not half floats".into()))?;
    write(out, &full_scale(samples))?;
    Ok(serde_json::json!({
        "width": width,
        "height": height,
        "ceilings": ceilings,
        "matrix": matrix,
    }))
}

fn developed(
    gpu: &'static gpu::Gpu,
    request: &Develop,
) -> Result<serde_json::Value, Failed> {
    let (width, height) = (request.width, request.height);
    let samples = read(&request.develop)?;
    if width % 2 != 0 || height % 2 != 0 || samples.len() != width * height {
        return Err(Failed::Error(format!(
            "{} is not one {width}x{height} mosaic of whole sites",
            request.develop
        )));
    }
    let mosaic = mosaic::condition::Mosaic::upload(gpu, &samples, width, height);
    let cfa = mosaic::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB");
    let colour = mosaic::demosaic::Colour {
        matrix: request.matrix,
        ceiling: request.ceilings,
    };
    let built = pollster::block_on(rawshim::decode_rawler::demosaic_as_decoded(
        &mosaic, &cfa, colour, 2,
    ))
    .ok_or_else(|| Failed::Error("the demosaic did not run".into()))?;
    let host = pollster::block_on(built.into_host())
        .ok_or_else(|| Failed::Error("the demosaic did not read back".into()))?;
    write(&request.out, &full_scale(&host))?;
    Ok(serde_json::json!({}))
}

fn graded(request: &Grade) -> Result<serde_json::Value, Failed> {
    let taken = request.taken.as_deref().map(read).transpose()?;
    let gains = match (&taken, &request.gains) {
        (None, _) => vec![0.0],
        (Some(_), Some(gains)) => gains.clone(),
        (Some(_), None) => vec![1.0],
    };
    let options = rawshim::hdr_args::EncodeOptions {
        still_chroma: formats::still::Chroma::Yuv444,
        output_path: String::new(),
        grade: support::GRADE,
        crf: 26,
        preset: 6,
        strengths: support::STRENGTHS,
        sharpen_sigma: None,
        max_edge: request.edge.map_or(100_000.0, |edge| edge as f64),
        content_light: None,
    };
    let output = match request.output {
        Coding::Pq => rawshim::grade::Output::Pq,
        Coding::Srgb => rawshim::grade::Output::Srgb,
    };
    let unopened = || Failed::Unreadable(format!("{} did not open", request.grade));
    let matched = match taken {
        Some(_) => {
            support::Open::shipped(&request.grade, request.floor)
                .run()
                .ok_or_else(unopened)?
                .measured
                .matched
        }
        None => None,
    };
    let mut bytes = Vec::new();
    let (mut width, mut height) = (0, 0);
    for &gain in &gains {
        let mismatch = std::cell::Cell::new(None);
        let take = |samples: &mut [u16]| match &taken {
            Some(taken) if taken.len() != samples.len() => mismatch.set(Some(samples.len())),
            Some(taken) if !request.alone => {
                for (sample, light) in samples.iter_mut().zip(taken) {
                    let level = half::f16::from_bits(*sample).to_f32();
                    *sample = half::f16::from_f32((level - gain * light).max(0.0)).to_bits();
                }
            }
            _ => {}
        };
        // Taken out ahead of the open, as a stage would be, so the grade measures what is left.
        let mut opened = support::Open {
            edit: Some(&take),
            matched: matched.clone(),
            ..support::Open::shipped(&request.grade, request.floor)
        }
        .run()
        .ok_or_else(unopened)?;
        if let Some(frame) = mismatch.get() {
            return Err(Failed::Error(format!(
                "{} holds {} samples, the frame {frame}",
                request.taken.as_deref().unwrap_or_default(),
                taken.as_ref().map_or(0, Vec::len)
            )));
        }
        if let (Some(taken), true) = (&taken, request.alone) {
            // In place of the opened photo, under the grade the photo measured.
            opened.frame.pixels = rawshim::frame::Pixels::Sixteen(
                taken
                    .iter()
                    .map(|light| half::f16::from_f32((gain * light).max(0.0)).to_bits())
                    .collect(),
            );
        }
        let (coded, w, h) = support::graded(&opened, &options, output);
        (width, height) = (w, h);
        bytes.extend(coded.iter().flat_map(|code| code.to_le_bytes()));
    }
    std::fs::write(&request.out, bytes)
        .map_err(|why| Failed::Error(format!("could not write {}: {why}", request.out)))?;
    Ok(serde_json::json!({ "width": width, "height": height, "count": gains.len() }))
}

fn full_scale(bits: &[u16]) -> Vec<f32> {
    bits.iter()
        .map(|&b| half::f16::from_bits(b).to_f32())
        .collect()
}

fn denoised(
    gpu: &'static gpu::Gpu,
    network: &denoise::pmrid::Pmrid,
    request: &Denoise,
) -> Result<serde_json::Value, Failed> {
    let cfa = mosaic::cfa::Cfa::bayer(request.cfa)
        .filter(mosaic::cfa::Cfa::is_bayer)
        .ok_or_else(|| Failed::Error("not a Bayer pattern".into()))?;
    if !request
        .gains
        .iter()
        .all(|gain| gain.is_finite() && *gain > 0.0)
    {
        return Err(Failed::Error(format!("gains of {:?}", request.gains)));
    }
    if !request.fit.usable() {
        return Err(Failed::Error("the fit is not usable".into()));
    }
    let samples = read(&request.denoise)?;
    let size = request.width * request.height;
    if size == 0 || samples.len() % size != 0 {
        return Err(Failed::Error(format!(
            "{} is not a stack of {}x{} mosaics",
            request.denoise, request.width, request.height
        )));
    }
    let _arenas = Arenas::held();
    let mut filtered = Vec::with_capacity(samples.len());
    for one in samples.chunks_exact(size) {
        let mut mosaic =
            mosaic::condition::Mosaic::upload(gpu, one, request.width, request.height);
        filter(gpu, network, &mut mosaic, &cfa, request.gains, request.fit);
        let read = pollster::block_on(mosaic.read(gpu))
            .ok_or_else(|| Failed::Error("a mosaic did not read back".into()))?;
        filtered.extend(read);
    }
    write(&request.out, &filtered)?;
    Ok(serde_json::json!({}))
}

fn sharpened(
    gpu: &'static gpu::Gpu,
    request: &Sharpen,
) -> Result<serde_json::Value, Failed> {
    let (width, height) = (request.width, request.height);
    let samples = read(&request.mosaics)?;
    let size = width * height;
    if width < 3 || height < 3 || samples.len() % size != 0 {
        return Err(Failed::Error(format!(
            "{} is not a stack of {width}x{height} mosaics",
            request.mosaics
        )));
    }
    let measured = match &request.measured {
        Some(given) => given,
        None => &measured(&request.sharpen)?,
    };
    let base = rawshim::base::device(gpu).ok_or_else(|| Failed::Error("no base kernels".into()))?;
    let rcd = mosaic::demosaic::device(gpu)
        .ok_or_else(|| Failed::Error("no demosaic kernels".into()))?;
    let matrix = measured.matrix;
    let levels = measured.levels.anchored();
    let white = support::GRADE.reference_white_nits;
    // An upscale is a sensor of `scale` times the photosites, the same blur spanning `scale` times
    // as many of them.
    let scale = request.scale.unwrap_or(1);
    let sensor_long = measured.sensor_long * scale;
    let capture_blur = measured.capture_blur.map(|blur| blur * scale as f32);
    let sigma = rawshim::image::deconvolve_split(capture_blur, sensor_long, sensor_long);
    let noise = rawshim::base::sharpen_noise(
        levels,
        white,
        measured.noise,
        1.0,
        Some(matrix),
        measured.wb_gains,
        measured.reduced,
    )
    .at(
        units::px::Span::<units::px::Sensor>::exact(sensor_long),
        units::px::Span::<units::px::Drawn>::exact(sensor_long),
    );
    let defringe = measured.defringe.map_or(
        rawshim::base::Defringe::Measure,
        rawshim::base::Defringe::Take,
    );
    let plain = (rawshim::base::Defringe::Take((0.0, 0.0)), 0.0);
    let shipped = (
        defringe,
        request.amount.unwrap_or(support::STRENGTHS.sharpen),
    );
    let variants: Vec<_> = [(Shown::Plain, plain), (Shown::Sharpened, shipped)]
        .into_iter()
        .filter(|(shown, _)| request.only.is_none_or(|only| only == *shown))
        .map(|(_, variant)| variant)
        .collect();

    let cfa = mosaic::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB");
    let halving = request
        .supersampled
        .then(|| denoise::upscale::Halving::new(gpu));
    let (out_width, out_height) = match halving {
        Some(_) => (width / 2, height / 2),
        None => (width, height),
    };
    let colour = mosaic::demosaic::Colour {
        matrix,
        ceiling: request.gains,
    };
    let mut light = Vec::with_capacity(samples.len() * 6);
    for mosaic in samples.chunks_exact(size) {
        let demosaiced = match &halving {
            Some(halving) => halved(gpu, rcd, halving, mosaic, &cfa, width, height, colour)?,
            None => demosaic(gpu, rcd, mosaic, &cfa, width, height, colour)?,
        };
        let (width, height) = (out_width, out_height);
        for &(defringe, amount) in &variants {
            let resident = colour::resident::Resident::upload(gpu, &demosaiced, width, height);
            let (prepared, _) = pollster::block_on(rawshim::base::prepare(
                gpu,
                base,
                resident,
                rawshim::base::Gather::frame(units::px::Size::exact(width, height)),
                levels,
                white,
                support::STRENGTHS.before_the_fit(),
                rawshim::image::SharpenSigma::fixed(rawshim::image::DECONVOLVE_SIGMA),
                rawshim::image::SharpenNoise::NONE,
                &rawshim::fit::Lens::none(),
                defringe,
                measured.noise,
                Some(matrix),
            ))
            .ok_or_else(|| Failed::Error("the coding did not run".into()))?;
            let size = formats::still::Size {
                width: width as u32,
                height: height as u32,
            };
            let coded = rawshim::hdr::Cut::from_base(prepared, None, size, amount, sigma, noise)
                .into_samples();
            light.extend(coded[..width * height * 3].iter().map(|&code| {
                let nits = colour::tone::pq_inv::<units::light::SceneNits>(Light::measured(
                    f64::from(code) / f64::from(u16::MAX),
                ));
                (nits.raw() / white.raw()) as f32
            }));
        }
    }
    write(&request.out, &light)?;
    Ok(serde_json::json!({ "matrix": matrix, "sigma": sigma.composed }))
}

fn measured(path: &str) -> Result<Measured, Failed> {
    let opened = support::Open::shipped(path, 0)
        .run()
        .ok_or_else(|| Failed::Error(format!("{path} did not open")))?;
    let frame = &opened.frame;
    let reduced = frame.reduced.max(1);
    Ok(Measured {
        matrix: frame
            .matrix
            .ok_or_else(|| Failed::Error(format!("{path} has no camera matrix")))?,
        levels: opened.measured.levels,
        capture_blur: opened.measured.blur.map(|blur| blur * reduced as f32),
        sensor_long: frame.width.max(frame.height) * reduced,
        noise: frame.noise,
        wb_gains: frame.wb_gains,
        reduced: frame.reduced,
        defringe: match opened.measured.defringe {
            // `Done` means the open's own frame; mosaics sharpened later are demosaiced afresh.
            rawshim::base::Defringe::Done(pair) | rawshim::base::Defringe::Take(pair) => Some(pair),
            rawshim::base::Defringe::Measure => None,
        },
    })
}

/// An upscale demosaiced in the product's order: RCD at its size, halved before the colour pass.
#[allow(clippy::too_many_arguments)]
fn halved(
    gpu: &'static gpu::Gpu,
    rcd: &'static mosaic::demosaic::Rcd,
    halving: &denoise::upscale::Halving,
    mosaic: &[f32],
    cfa: &mosaic::cfa::Cfa,
    width: usize,
    height: usize,
    colour: mosaic::demosaic::Colour,
) -> Result<Vec<u16>, Failed> {
    let upscaled = mosaic::condition::Mosaic::upload(gpu, mosaic, width, height);
    let (out_width, out_height) = (width / 2, height / 2);
    // No photo-sized mosaic crosses, so no photosite reads as clipped for the colour pass's fills.
    let native = mosaic::condition::Mosaic::plane(gpu, out_width, out_height);
    let at = whole(out_width, out_height);
    let into = mosaic::demosaic::frame_buffer(gpu, out_width * out_height);
    let (_held, upscaled_shape) = mosaic::demosaic::shape_group(gpu, rcd, cfa, &upscaled, 0);
    let (_held, native_shape) = mosaic::demosaic::shape_group(gpu, rcd, cfa, &native, 0);
    let field = highlight_field(gpu, &native, cfa, colour)?;
    pollster::block_on(mosaic::demosaic::demosaic_halved_into(
        gpu,
        rcd,
        &upscaled,
        &upscaled_shape,
        cfa,
        &at,
        colour,
        field.seen(),
        &into,
        &native_shape,
        |recording, plane| halving.halve(gpu, recording, plane, (width, height)),
    ))
    .ok_or_else(|| Failed::Error("the demosaic did not run".into()))?;
    pollster::block_on(mosaic::demosaic::read_frame(
        gpu,
        &into,
        out_width * out_height,
    ))
    .ok_or_else(|| Failed::Error("the demosaic did not read back".into()))
}

fn whole(width: usize, height: usize) -> mosaic::demosaic::Placement {
    mosaic::demosaic::Placement {
        stride: units::px::Span::exact(width),
        crop: units::px::Rect::exact(0, 0, width, height),
        dest: units::px::At::ORIGIN,
        frame: units::px::Size::exact(width, height),
        orientation: 0,
        reduce: 1,
    }
}

fn demosaic(
    gpu: &'static gpu::Gpu,
    rcd: &'static mosaic::demosaic::Rcd,
    mosaic: &[f32],
    cfa: &mosaic::cfa::Cfa,
    width: usize,
    height: usize,
    colour: mosaic::demosaic::Colour,
) -> Result<Vec<u16>, Failed> {
    let uploaded = mosaic::condition::Mosaic::upload(gpu, mosaic, width, height);
    let at = whole(width, height);
    let into = mosaic::demosaic::frame_buffer(gpu, width * height);
    let (_held, shape) = mosaic::demosaic::shape_group(gpu, rcd, cfa, &uploaded, 0);
    let field = highlight_field(gpu, &uploaded, cfa, colour)?;
    pollster::block_on(mosaic::demosaic::demosaic_into(
        gpu,
        rcd,
        &uploaded,
        cfa,
        &at,
        colour,
        field.seen(),
        &into,
        &shape,
    ))
    .ok_or_else(|| Failed::Error("the demosaic did not run".into()))?;
    pollster::block_on(mosaic::demosaic::read_frame(gpu, &into, width * height))
        .ok_or_else(|| Failed::Error("the demosaic did not read back".into()))
}

fn highlight_field(
    gpu: &'static gpu::Gpu,
    mosaic: &mosaic::condition::Mosaic,
    cfa: &mosaic::cfa::Cfa,
    colour: mosaic::demosaic::Colour,
) -> Result<mosaic::highlight::Field, Failed> {
    mosaic::highlight::measure(gpu, mosaic, cfa, colour.ceiling)
        .ok_or_else(|| Failed::Error("the highlight field was not measured".into()))
}

/// PMRID's arenas kept from one mosaic of a stack to the next, released however the stack ends.
struct Arenas;

impl Arenas {
    fn held() -> Self {
        denoise::pmrid::hold_arenas();
        Arenas
    }
}

impl Drop for Arenas {
    fn drop(&mut self) {
        denoise::pmrid::release_arenas();
    }
}

fn filter(
    gpu: &'static gpu::Gpu,
    network: &denoise::pmrid::Pmrid,
    mosaic: &mut mosaic::condition::Mosaic,
    cfa: &mosaic::cfa::Cfa,
    gains: [f32; 3],
    fit: NoiseFit,
) {
    if DETAIL.amounts(Some(fit)).does_anything() {
        denoise::pmrid::denoise(gpu, network, mosaic, cfa, gains, DETAIL, fit);
    }
}

fn read(path: &str) -> Result<Vec<f32>, Failed> {
    let bytes = std::fs::read(path)
        .map_err(|why| Failed::Error(format!("could not read {path}: {why}")))?;
    if bytes.len() % 4 != 0 {
        return Err(Failed::Error(format!(
            "{path} ends partway through a sample"
        )));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|word| f32::from_le_bytes([word[0], word[1], word[2], word[3]]))
        .collect())
}

fn write(path: &str, samples: &[f32]) -> Result<(), Failed> {
    let bytes: Vec<u8> = samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect();
    std::fs::write(path, bytes)
        .map_err(|why| Failed::Error(format!("could not write {path}: {why}")))
}
