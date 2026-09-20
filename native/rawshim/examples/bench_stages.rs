//! What a rendition request costs, stage by stage, in a form a ratchet can read.
//!
//! ```text
//! bench_stages <raw>...
//! ```
//!
//! One line per measurement, `fixture<TAB>stage<TAB>fastest_ms`, and nothing else on stdout.
//! `scripts/bench.ts` holds those against `test/fixtures/bench.budget.json`.
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
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("bench_stages <raw>...");
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
        measure(path, &output);
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

fn measure(path: &str, output: &str) {
    let command = command(path, output);
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
                round.iter().filter(|(at, _)| at == key).map(|(_, ms)| ms).sum::<f64>()
            })
            .collect();
        println!("{}\t{key}\t{:.1}", name(path), fastest(across));
    }
    println!("{}\ttotal\t{:.1}", name(path), fastest(totals));
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
fn command(raw: &str, output: &str) -> rawshim::job::Job {
    let json = serde_json::json!({
        "rawFilePath": raw,
        "matchEmbeddedJpeg": true,
        "denoiseLuminance": 20.0,
        "denoiseColour": 30.0,
        // On, which is what `dustSettings(undefined)` asks for. Whether the search then runs is
        // the aperture's to say, so `dust` reads zero on a frame shot wide open.
        "dust": { "enabled": true, "sensitivity": 0.25, "intensity": 1.0 },
        "sharpen": 0.6,
        "defringe": 1.0,
        "grade": { "peakNits": 1000.0, "referenceWhiteNits": 203.0, "whiteQuantile": 0.9 },
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
    });
    serde_json::from_value(json).expect("the job this file just wrote")
}
