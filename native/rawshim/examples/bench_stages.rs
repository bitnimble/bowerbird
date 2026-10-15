//! What a rendition request costs, stage by stage, in a form a ratchet can read.
//!
//! ```text
//! bench_stages [--denoiser galosh|pmrid|upscaler] <raw>... [--burst <frame>...]
//! ```
//!
//! One line per measurement, `fixture<TAB>stage<TAB>fastest_ms`, and nothing else on stdout.
//! `--burst` times the hand-held merge as the fixture `burst`: the align a merge starts with, and
//! the same `full` rendition of the merged frames, less its encode.
//! `scripts/bench.ts` holds those against `test/fixtures/bench.budget.json`, at the default GALOSH.
//!
//! **The whole request, not the pipeline's middle.** `job::run` over the command `bb_run_job` is
//! handed, at the library's shipped settings, so the total is what `rendition built on demand`
//! logs less the worker spawn - the file read and the AVIF encode included. The stages come out of
//! `clock::laps`, which is the same switch `BOWERBIRD_DECODE_PROFILE` prints, so a stage named here
//! is a stage the profile names and the two cannot drift.
//!
//! **Cold, so that every stage is live.** A render handed a stored analysis skips the camera match,
//! the noise fit and the levels entirely, and a budget taken over it would be watching three stages
//! that always read zero. This is what an import pays for each photograph, and it is the arm that
//! has something to regress.

use std::time::Instant;

const REPEATS: usize = 5;

/// The stages of a render, as `(lap prefix, lap name, budget key)`.
///
/// **Leaves only.** `Base::build` and `job::run` each also record a roll-up of everything below
/// them - `base decode, denoise, demosaic` and `job decode, open` - and taking those as well would
/// count the decode twice over and leave the keys summing to something no request ever cost.
const STAGES: &[(&str, &str, &str)] = &[
    ("  decode ", "file", "file"),
    ("  decode ", "open", "metadata"),
    ("  decode ", "read", "unpack"),
    ("  decode ", "condition", "condition"),
    ("  decode ", "dust", "dust"),
    ("  decode ", "denoise", "denoise"),
    ("  decode ", "demosaic, colour, crop, orient", "demosaic"),
    ("  base ", "defringe, camera match, levels", "measure"),
    ("  base ", "code, defringe", "code"),
    ("  job ", "resize, lens, sharpen", "resize"),
    ("  job ", "grade", "grade"),
    ("  job ", "encode, write", "encode"),
    ("  job ", "scene peak", "peak"),
];

fn main() {
    let mut files: Vec<String> = std::env::args().skip(1).collect();
    let denoiser = match files.iter().position(|arg| arg == "--denoiser") {
        Some(at) if at + 1 < files.len() => {
            let named = files.remove(at + 1);
            files.remove(at);
            named
        }
        _ => "galosh".to_string(),
    };
    let burst = match files.iter().position(|arg| arg == "--burst") {
        Some(at) => {
            let frames = files.split_off(at + 1);
            files.pop();
            frames
        }
        None => Vec::new(),
    };
    if files.is_empty() && burst.is_empty() {
        eprintln!("bench_stages [--denoiser galosh|pmrid|upscaler] <raw>... [--burst <frame>...]");
        std::process::exit(2);
    }
    rawshim::clock::record();
    let out_dir = std::env::temp_dir().join("bowerbird-bench-stages");
    if let Err(why) = std::fs::create_dir_all(&out_dir) {
        eprintln!("nowhere to write the renditions: {why}");
        std::process::exit(1);
    }
    let Some(output) = out_dir.join("full.avif").to_str().map(str::to_string) else {
        eprintln!("the temporary directory is not utf-8");
        std::process::exit(1);
    };
    for path in &files {
        measure(path, &output, &denoiser);
    }
    if !burst.is_empty() {
        measure_burst(&burst, &output, &denoiser);
    }
}

fn name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// The fastest round, which is the one least of something else.
///
/// **Contention only ever adds.** Nothing another process, a thermal ceiling or a shared memory
/// bus does to a round makes it quicker, so the spread above the floor measures the machine and
/// the floor measures the code - and it is the code a ratchet is asking about. Taken as a median
/// instead, `demosaic` on DSC00853 reads anywhere from 37 to 59ms across runs on an idle machine,
/// which is noise wider than the tolerance and a gate that fails on whichever run recorded it.
fn fastest(taken: Vec<f64>) -> f64 {
    taken.into_iter().fold(f64::INFINITY, f64::min)
}

fn measure(path: &str, output: &str, denoiser: &str) {
    let command = job(rendition(path, output, denoiser));
    let mut rounds: Vec<Vec<(String, f64)>> = Vec::with_capacity(REPEATS);
    let mut totals: Vec<f64> = Vec::with_capacity(REPEATS);

    // Round zero is discarded: the first render builds every pipeline and allocates the working
    // textures, which is a one-off a server pays once per process and a ratchet must not read.
    for round in 0..=REPEATS {
        let began = Instant::now();
        let outcome = rawshim::job::run(&command);
        let total = began.elapsed().as_secs_f64() * 1000.0;
        // Taken whether or not the round is kept, so a discarded round's laps cannot land in the
        // next one's.
        let laps = rawshim::clock::taken();
        if let Err(why) = outcome {
            eprintln!("{}: {why}", name(path));
            return;
        }
        if round > 0 {
            rounds.push(staged(&laps));
            totals.push(total);
        }
    }

    for (_, _, key) in STAGES {
        let across: Vec<f64> = rounds
            .iter()
            .map(|round| {
                round
                    .iter()
                    .filter(|(at, _)| at == key)
                    .map(|(_, ms)| ms)
                    .sum::<f64>()
            })
            .collect();
        println!("{}\t{key}\t{:.1}", name(path), fastest(across));
    }
    println!("{}\ttotal\t{:.1}", name(path), fastest(totals));
}

/// The align a merge of `frames` starts with, then the `full` rendition of what it merges, each
/// timed whole, discarding round zero for [`measure`]'s reason.
fn measure_burst(frames: &[String], output: &str, denoiser: &str) {
    let sources: Vec<serde_json::Value> = frames
        .iter()
        .enumerate()
        .map(|(at, path)| serde_json::json!({ "photoId": format!("frame{at}"), "rawFilePath": path }))
        .collect();
    let mut align = rendition(&frames[0], output, denoiser);
    align["composite"] =
        serde_json::json!({ "sources": sources, "want": "align", "shape": "burst" });
    let Some((aligned, align_ms)) = timed(&job(align)) else {
        return;
    };
    let Some(mut recipe) = aligned
        .composite
        .and_then(|answer| serde_json::from_str::<serde_json::Value>(&answer).ok())
        .map(|answer| answer["recipe"].clone())
    else {
        eprintln!("burst: the align answered no recipe");
        return;
    };
    recipe["kind"] = serde_json::json!("burst");
    let mut render = rendition(&frames[0], output, denoiser);
    render["composite"] =
        serde_json::json!({ "sources": sources, "want": "render", "recipe": recipe });
    let Some((_, merge_ms)) = timed(&job(render)) else {
        return;
    };
    println!("burst\talign\t{align_ms:.1}");
    println!("burst\tmerge\t{merge_ms:.1}");
}

/// The last round's outcome and the fastest round less its encode, or None where a round failed.
fn timed(command: &rawshim::job::Job) -> Option<(rawshim::job::Outcome, f64)> {
    let mut taken = Vec::with_capacity(REPEATS);
    let mut last = None;
    for round in 0..=REPEATS {
        let began = Instant::now();
        let outcome = rawshim::job::run(command);
        let encoded: f64 = rawshim::clock::taken()
            .iter()
            .filter(|(prefix, name, _)| *prefix == "  job " && name.as_str() == "encode, write")
            .map(|(_, _, ms)| ms)
            .sum();
        let ms = began.elapsed().as_secs_f64() * 1000.0 - encoded;
        match outcome {
            Err(why) => {
                eprintln!("burst: {why}");
                return None;
            }
            Ok(outcome) => last = Some(outcome),
        }
        if round > 0 {
            taken.push(ms);
        }
    }
    Some((last?, fastest(taken)))
}

/// This round's laps as the stages the budget names, dropping the roll-ups and anything a stage
/// this build does not know about.
///
/// A key can appear twice - `decode` runs its laps once per decode, and a job that both lifts an
/// embedded preview and renders makes two passes - so the caller sums rather than takes the first.
fn staged(laps: &[(&'static str, String, f64)]) -> Vec<(String, f64)> {
    laps.iter()
        .filter_map(|(prefix, name, ms)| {
            STAGES
                .iter()
                .find(|(at, called, _)| at == prefix && called == name)
                .map(|(_, _, key)| ((*key).to_string(), *ms))
        })
        .collect()
}

/// The command `processing_service` composes for a `full` rendition, at `DEFAULT_SETTINGS` and
/// `AS_METERED`.
///
/// **The Detail pair is named here where a rendition leaves it unset**, and that is the one place
/// this parts company with what ships. A document that has said nothing is answered by the frame's
/// own fit, so the amount would move with the ramp and with whichever photographs are in the
/// fixture set, and a ratchet on what a stage costs wants its inputs held still.
///
/// **What that costs is the top of the Colour track, and the gap is real.** 30 is 0.9 in the units
/// the kernels read, below the 1.0 and 2.0 that gate the quarter- and eighth-resolution chroma
/// levels (`galosh::run`), so `denoise` here is the half-resolution regression and nothing above
/// it. A cost regression in either coarse level is invisible to this budget. Closing it means
/// naming a colour past 66.7 and re-recording every adapter's table, which is a deliberate act and
/// not one to fold into an unrelated change.
///
/// Everything else is spelled out rather than defaulted for the opposite reason: what this measures
/// is the shipped configuration and serde's absent-field defaults are not it.
///
/// No `photoAnalysis`, which is what makes the round cold (see the header).
fn rendition(raw: &str, output: &str, denoiser: &str) -> serde_json::Value {
    serde_json::json!({
        "rawFilePath": raw,
        "cameraMatch": "lensAndColour",
        "denoiseLuminance": 20.0,
        "denoiseColour": 30.0,
        "denoiser": denoiser,
        // On, which is what `dustSettings(undefined)` asks for. Whether the search then runs is
        // the aperture's to say, so `dust` reads zero on a frame shot wide open.
        "dust": { "enabled": true, "sensitivity": 0.25, "intensity": 1.0 },
        "sharpen": 0.5,
        "defringe": 1.0,
        "grade": { "referenceWhiteNits": 203.0, "whiteQuantile": 0.9 },
        "targets": [{
            "rendition": "full",
            "output": "pq",
            "outputPath": output,
            "size": 3840,
            "source": "render",
            "sdrQuantizer": 13,
            "hdrQuantizer": 10,
            "preset": 8,
            "stillFullChroma": false,
            "sdrFullChroma": false,
        }],
    })
}

fn job(json: serde_json::Value) -> rawshim::job::Job {
    serde_json::from_value(json).expect("the job this file just wrote")
}
