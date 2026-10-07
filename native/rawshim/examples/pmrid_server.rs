//! PMRID for a model trainer in another process: RAWs decoded and dust-removed as the editor does,
//! then denoised by PMRID at the editor's AUTO amounts, and mosaics the trainer made denoised
//! against a fit it hands over.
//!
//! One JSON request a line on stdin, one JSON reply a line on stdout. Samples travel as files of
//! little-endian `f32`, row-major, since a 61MP frame is a quarter of a gigabyte.
//!
//! ```text
//! {"open": "<raw>", "out": "<file>"}
//!   writes the picture area, conditioned, dust-removed and denoised, cropped to even sides
//!   -> {"width": w, "height": h, "cfa": [4 colours from its top-left], "gains": [r, g, b], "fit": NoiseFit|null}
//! {"denoise": "<file>", "out": "<file>", "width": w, "height": h, "cfa": [..], "gains": [..], "fit": NoiseFit}
//!   denoises each of the file's stacked w x h mosaics on its own
//!   -> {}
//! ```
//!
//! `NoiseFit` is `galosh::NoiseFit` as serde writes it: `alpha`, `sigmaSq`, `unifiedSigma`,
//! `darkRef`. A request that fails replies `{"error": "...", "unreadable": bool}` and the server
//! carries on; `unreadable` is the file's own fault, which no retry mends.
//!
//! Launch it with `CARGO_MANIFEST_DIR` set, as cargo would: `gpu::leave` otherwise lets NVIDIA's
//! driver fault at exit.

use std::io::{BufRead, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Mutex;

use rawshim::galosh::{Denoiser, Detail, NoiseFit};

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum Request {
    Open { open: String, out: String },
    Denoise(Denoise),
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
            Ok(Request::Open { open, out }) => catch_unwind(AssertUnwindSafe(|| {
                opened(gpu, kernels, network, &open, &out)
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
    if usable {
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
