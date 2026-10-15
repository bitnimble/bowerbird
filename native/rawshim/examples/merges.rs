//! A stack merged on the mosaic, beside its reference frame rendered alone.
//!
//! ```text
//! merges <burst|exposureBracket|focusBracket|pixelShift> <out-dir> [--scale 2] <frame>...
//! ```
//!
//! Writes `merged.avif` and `reference.avif`, each the whole picture at its own size through the
//! `full` rendition's settings, PQ: the merge as the app renders that stack, and the frame it was
//! merged onto as the app renders it alone, denoised as any photo is. `avif_crop` cuts them at
//! 1:1. `--scale 2` merges onto a canvas twice as fine, as Increase resolution does.

use serde_json::{Value, json};

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let scale = match args.iter().position(|arg| arg == "--scale") {
        Some(at) => {
            let value = args.remove(at + 1);
            args.remove(at);
            value.parse::<usize>().expect("a scale")
        }
        None => 1,
    };
    if args.len() < 4 {
        eprintln!(
            "merges <burst|exposureBracket|focusBracket|pixelShift> <out-dir> [--scale 2] <frame>..."
        );
        std::process::exit(2);
    }
    let kind = args.remove(0);
    let out = args.remove(0);
    let frames = args;
    std::fs::create_dir_all(&out).expect("the output directory");
    let mut sources: Vec<Value> = frames
        .iter()
        .enumerate()
        .map(|(at, path)| json!({ "photoId": format!("frame{at}"), "rawFilePath": path }))
        .collect();
    let unused = format!("{out}/unused.avif");
    let align = |sources: &[Value]| -> Value {
        let mut align = rendition(&frames[0], &unused);
        align["composite"] = json!({ "sources": sources, "want": "align", "shape": kind });
        let answer = rawshim::job::run(&job(align))
            .expect("the align")
            .composite
            .expect("a recipe");
        serde_json::from_str::<Value>(&answer).expect("the align's answer")
    };

    // As `composites_service.aligned` does: a lens nothing has fitted is fitted, then aligned again.
    let mut answer = align(&sources);
    let lensless: Vec<usize> = answer["lensless"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|id| sources.iter().position(|source| source["photoId"] == *id))
        .collect();
    for &at in &lensless {
        let fitted = rawshim::job::run(&job(rendition(&frames[at], &unused))).expect("a lens fit");
        sources[at]["photoAnalysis"] = json!(fitted.photo_analysis.expect("an analysis"));
    }
    if !lensless.is_empty() {
        answer = align(&sources);
    }
    let mut recipe = answer["recipe"].clone();
    let reference = recipe["reference"].as_u64().expect("a reference") as usize;
    for axis in 0..2 {
        recipe["canvas"][axis] =
            json!(recipe["canvas"][axis].as_u64().expect("a canvas") as usize * scale);
        recipe["centre"][axis] =
            json!(recipe["centre"][axis].as_f64().expect("a centre") * scale as f64);
    }
    recipe["radiansPerPixel"] =
        json!(recipe["radiansPerPixel"].as_f64().expect("a step") / scale as f64);
    recipe["kind"] = json!(kind);
    eprintln!("reference: frame {reference}, {}", frames[reference]);

    let mut merged = rendition(&frames[reference], &format!("{out}/merged.avif"));
    merged["composite"] = json!({ "sources": sources, "want": "render", "recipe": recipe });
    rawshim::job::run(&job(merged)).expect("the merge");
    rawshim::job::run(&job(rendition(
        &frames[reference],
        &format!("{out}/reference.avif"),
    )))
    .expect("the reference");
    eprintln!("wrote {out}/merged.avif and {out}/reference.avif");
}

/// `bench_stages`'s `full` rendition at native size.
fn rendition(raw: &str, output: &str) -> Value {
    json!({
        "rawFilePath": raw,
        "cameraMatch": "lensAndColour",
        "denoiseLuminance": 20.0,
        "denoiseColour": 30.0,
        "denoiser": "galosh",
        "dust": { "enabled": true, "sensitivity": 0.25, "intensity": 1.0 },
        "sharpen": 0.5,
        "defringe": 1.0,
        "grade": { "referenceWhiteNits": 203.0, "whiteQuantile": 0.9 },
        "targets": [{
            "rendition": "full",
            "output": "pq",
            "outputPath": output,
            "size": 0,
            "source": "render",
            "sdrQuantizer": 13,
            "hdrQuantizer": 10,
            "preset": 8,
            "stillFullChroma": true,
            "sdrFullChroma": true,
        }],
    })
}

fn job(json: Value) -> rawshim::job::Job {
    serde_json::from_value(json).expect("the job this file just wrote")
}
