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

use rawshim::galosh::{Denoiser, Detail, NoiseFit};
use rawshim::light::Light;

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
    /// coding, as Sharpen's Quality does; the sharpen then meets the photo's own pixels.
    #[serde(default)]
    supersampled: bool,
}

/// What the rest of the chain needs of a photo that only opening it whole can measure.
#[derive(serde::Deserialize, serde::Serialize)]
struct Measured {
    matrix: [[f32; 3]; 3],
    levels: rawshim::tone::Levels,
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
    let gpu = rawshim::gpu::device().expect("an adapter");
    let kernels = rawshim::galosh::device(gpu).expect("the GALOSH kernels built");
    let network = rawshim::pmrid::device(gpu).expect("the network built");
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
    gpu: &'static rawshim::gpu::Gpu,
    kernels: &rawshim::galosh::Galosh,
    network: &rawshim::pmrid::Pmrid,
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
    let dust = rawshim::dust::Settings::default().wanted(None);
    pollster::block_on(rawshim::dust::run(gpu, &mosaic, &held.glass(), &dust));
    let fit = pollster::block_on(rawshim::galosh::fit(gpu, kernels, &mosaic, &cfa));
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

fn denoised(
    gpu: &'static rawshim::gpu::Gpu,
    network: &rawshim::pmrid::Pmrid,
    request: &Denoise,
) -> Result<serde_json::Value, Failed> {
    let cfa = rawshim::cfa::Cfa::bayer(request.cfa)
        .filter(rawshim::cfa::Cfa::is_bayer)
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
            rawshim::condition::Mosaic::upload(gpu, one, request.width, request.height);
        filter(gpu, network, &mut mosaic, &cfa, request.gains, request.fit);
        let read = pollster::block_on(mosaic.read(gpu))
            .ok_or_else(|| Failed::Error("a mosaic did not read back".into()))?;
        filtered.extend(read);
    }
    write(&request.out, &filtered)?;
    Ok(serde_json::json!({}))
}

fn sharpened(
    gpu: &'static rawshim::gpu::Gpu,
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
    let rcd = rawshim::demosaic::device(gpu)
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
        Some(matrix),
        measured.wb_gains,
        measured.reduced,
    )
    .at(
        rawshim::px::Span::<rawshim::px::Sensor>::exact(sensor_long),
        rawshim::px::Span::<rawshim::px::Drawn>::exact(sensor_long),
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

    let cfa = rawshim::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB");
    let supersample = request
        .supersampled
        .then(|| rawshim::upscale::Supersample::new(gpu));
    let (out_width, out_height) = match supersample {
        Some(_) => (width / 2, height / 2),
        None => (width, height),
    };
    let mut light = Vec::with_capacity(samples.len() * 6);
    for mosaic in samples.chunks_exact(size) {
        let demosaiced = demosaic(gpu, rcd, mosaic, &cfa, width, height, matrix, request.gains)?;
        for (defringe, amount) in [plain, shipped] {
            let uploaded = rawshim::resident::Resident::upload(gpu, &demosaiced, width, height);
            let resident = match &supersample {
                Some(supersample) => supersample.halved(gpu, &uploaded),
                None => uploaded,
            };
            let (width, height) = (out_width, out_height);
            let (prepared, _) = pollster::block_on(rawshim::base::prepare(
                gpu,
                base,
                resident,
                rawshim::base::Gather::frame(rawshim::px::Size::exact(width, height)),
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
            let size = rawshim::hdr_args::Size {
                width: width as u32,
                height: height as u32,
            };
            let coded = rawshim::hdr::Cut::from_base(prepared, None, size, amount, sigma, noise)
                .into_samples();
            light.extend(coded[..width * height * 3].iter().map(|&code| {
                let nits = rawshim::tone::pq_inv::<rawshim::light::SceneNits>(Light::measured(
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

#[allow(clippy::too_many_arguments)]
fn demosaic(
    gpu: &'static rawshim::gpu::Gpu,
    rcd: &'static rawshim::demosaic::Rcd,
    mosaic: &[f32],
    cfa: &rawshim::cfa::Cfa,
    width: usize,
    height: usize,
    matrix: [[f32; 3]; 3],
    ceiling: [f32; 3],
) -> Result<Vec<u16>, Failed> {
    let uploaded = rawshim::condition::Mosaic::upload(gpu, mosaic, width, height);
    let at = rawshim::demosaic::Placement {
        stride: rawshim::px::Span::exact(width),
        crop: rawshim::px::Rect::exact(0, 0, width, height),
        dest: rawshim::px::At::ORIGIN,
        frame: rawshim::px::Size::exact(width, height),
        orientation: 0,
        reduce: 1,
    };
    let into = rawshim::demosaic::frame_buffer(gpu, width * height);
    let (_held, shape) = rawshim::demosaic::shape_group(gpu, rcd, cfa, &uploaded, 0);
    pollster::block_on(rawshim::demosaic::demosaic_into(
        gpu,
        rcd,
        &uploaded,
        cfa,
        &at,
        rawshim::demosaic::Colour { matrix, ceiling },
        &into,
        &shape,
    ))
    .ok_or_else(|| Failed::Error("the demosaic did not run".into()))?;
    pollster::block_on(rawshim::demosaic::read_frame(gpu, &into, width * height))
        .ok_or_else(|| Failed::Error("the demosaic did not read back".into()))
}

/// PMRID's arenas kept from one mosaic of a stack to the next, released however the stack ends.
struct Arenas;

impl Arenas {
    fn held() -> Self {
        rawshim::pmrid::hold_arenas();
        Arenas
    }
}

impl Drop for Arenas {
    fn drop(&mut self) {
        rawshim::pmrid::release_arenas();
    }
}

fn filter(
    gpu: &'static rawshim::gpu::Gpu,
    network: &rawshim::pmrid::Pmrid,
    mosaic: &mut rawshim::condition::Mosaic,
    cfa: &rawshim::cfa::Cfa,
    gains: [f32; 3],
    fit: NoiseFit,
) {
    if DETAIL.amounts(Some(fit)).does_anything() {
        rawshim::pmrid::denoise(gpu, network, mosaic, cfa, gains, DETAIL, fit);
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
