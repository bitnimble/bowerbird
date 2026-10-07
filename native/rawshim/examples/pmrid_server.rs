//! PMRID for a model trainer in another process: RAWs decoded, dust-removed and denoised as the
//! editor does at AUTO, and mosaics the trainer made denoised against a fit it hands over.
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
use std::sync::atomic::{AtomicBool, Ordering};

use rawshim::galosh::{Denoiser, Detail, NoiseFit};

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum Request {
    Open {
        open: String,
        out: String,
    },
    Denoise {
        denoise: String,
        out: String,
        width: usize,
        height: usize,
        cfa: [u32; 4],
        gains: [f32; 3],
        fit: NoiseFit,
    },
}

enum Failed {
    Unreadable(String),
    Error(String),
}

const DETAIL: Detail = Detail::AUTO.using(Denoiser::Pmrid);

static PANICKED_IN_DECODER: AtomicBool = AtomicBool::new(false);

fn main() {
    let gpu = rawshim::gpu::device().expect("an adapter");
    let kernels = rawshim::galosh::device(gpu).expect("the GALOSH kernels built");
    let network = rawshim::pmrid::device(gpu).expect("the network built");
    // A panic in rawler is the file's fault (it panics on corrupt files under overflow checks);
    // one anywhere else, such as the GPU running out of memory, is worth retrying.
    let report = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if info
            .location()
            .is_some_and(|at| at.file().contains("rawler"))
        {
            PANICKED_IN_DECODER.store(true, Ordering::Relaxed);
        }
        report(info);
    }));
    let mut stdout = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        PANICKED_IN_DECODER.store(false, Ordering::Relaxed);
        let reply = match serde_json::from_str::<Request>(&line) {
            Ok(Request::Open { open, out }) => catch_unwind(AssertUnwindSafe(|| {
                opened(gpu, kernels, network, &open, &out)
            }))
            .unwrap_or_else(|_| match PANICKED_IN_DECODER.load(Ordering::Relaxed) {
                true => Err(Failed::Unreadable(format!("decoding {open} panicked"))),
                false => Err(Failed::Error(format!("opening {open} panicked"))),
            }),
            Ok(Request::Denoise {
                denoise,
                out,
                width,
                height,
                cfa,
                gains,
                fit,
            }) => catch_unwind(AssertUnwindSafe(|| {
                denoised(
                    gpu,
                    network,
                    &denoise,
                    &out,
                    (width, height),
                    cfa,
                    gains,
                    fit,
                )
            }))
            .unwrap_or_else(|_| Err(Failed::Error(format!("denoising {denoise} panicked")))),
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

fn opened(
    gpu: &'static rawshim::gpu::Gpu,
    kernels: &rawshim::galosh::Galosh,
    network: &rawshim::pmrid::Pmrid,
    path: &str,
    out: &str,
) -> Result<serde_json::Value, Failed> {
    let bytes = std::fs::read(path)
        .map_err(|why| Failed::Error(format!("could not read {path}: {why}")))?;
    let held = match pollster::block_on(rawshim::decode_rawler::open_bytes(&bytes)) {
        Ok(rawshim::decode::Held::Mosaic(held)) => held,
        Ok(rawshim::decode::Held::Rendered(_)) => {
            return Err(Failed::Unreadable(format!("{path} has no mosaic")));
        }
        Err(why) => return Err(Failed::Unreadable(format!("{path}: {why}"))),
    };
    let cfa = held.cfa();
    if cfa.period() != (2, 2) {
        return Err(Failed::Unreadable(format!("{path} is not Bayer")));
    }
    let mut mosaic = held.device_mosaic().duplicate(gpu);
    let dust = rawshim::dust::Settings::default().wanted(None);
    pollster::block_on(rawshim::dust::run(gpu, &mosaic, &held.glass(), &dust));
    let fit = pollster::block_on(rawshim::galosh::fit(gpu, kernels, &mosaic, &cfa));
    // The editor's decision: a fit that came back wrong leaves the photograph undenoised.
    let usable = fit.usable();
    if usable {
        filter(gpu, network, &mut mosaic, &cfa, held.ceilings(), fit);
    }
    let samples = pollster::block_on(mosaic.read(gpu))
        .ok_or_else(|| Failed::Error("the mosaic did not read back".into()))?;

    let (left, top, width, height) = held.crop();
    let (width, height) = (width / 2 * 2, height / 2 * 2);
    let stride = mosaic.width;
    let picture: Vec<f32> = (top..top + height)
        .flat_map(|row| {
            samples[row * stride + left..row * stride + left + width]
                .iter()
                .copied()
        })
        .collect();
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

#[allow(clippy::too_many_arguments)]
fn denoised(
    gpu: &'static rawshim::gpu::Gpu,
    network: &rawshim::pmrid::Pmrid,
    path: &str,
    out: &str,
    (width, height): (usize, usize),
    cfa: [u32; 4],
    gains: [f32; 3],
    fit: NoiseFit,
) -> Result<serde_json::Value, Failed> {
    let cfa =
        rawshim::cfa::Cfa::bayer(cfa).ok_or_else(|| Failed::Error("not a Bayer pattern".into()))?;
    if !fit.usable() {
        return Err(Failed::Error("the fit is not usable".into()));
    }
    let samples = read(path)?;
    let size = width * height;
    if size == 0 || samples.len() % size != 0 {
        return Err(Failed::Error(format!(
            "{path} is not a stack of {width}x{height} mosaics"
        )));
    }
    let mut filtered = Vec::with_capacity(samples.len());
    for one in samples.chunks_exact(size) {
        let mut mosaic = rawshim::condition::Mosaic::upload(gpu, one, width, height);
        filter(gpu, network, &mut mosaic, &cfa, gains, fit);
        let read = pollster::block_on(mosaic.read(gpu))
            .ok_or_else(|| Failed::Error("a mosaic did not read back".into()))?;
        filtered.extend(read);
    }
    write(out, &filtered)?;
    Ok(serde_json::json!({}))
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
