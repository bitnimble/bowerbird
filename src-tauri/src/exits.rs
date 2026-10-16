//! Why the previous run ended, logged at the start of this one: a crash takes the logs with it.

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use tauri::Manager;
use tauri::plugin::PluginHandle;

use crate::Runtime;

static REPORTING: OnceLock<()> = OnceLock::new();
const SAMPLE_EVERY: Duration = Duration::from_secs(1);
const SAMPLES_PER_WRITE: usize = 10;
const SAMPLES_KEPT: usize = 120;
const KINDS_SHOWN: usize = 6;
const RSS_LOGGED_EVERY_KB: u64 = 150 * 1024;

struct Exits(PluginHandle<Runtime>);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LastExit {
    exits: Vec<String>,
    crash: Option<String>,
    crash_file: String,
}

pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<Runtime> {
    tauri::plugin::Builder::new("exits")
        .setup(|app, api| {
            let package = app.config().identifier.replace('-', "_");
            let handle = api.register_android_plugin(&package, "ExitsPlugin")?;
            app.manage(Exits(handle));
            Ok(())
        })
        .build()
}

/// Logs the previous run's end, then has this run's first panic kept for the next to read.
pub(crate) fn report(app: &tauri::AppHandle<Runtime>) {
    if REPORTING.set(()).is_err() {
        return;
    }
    let app = app.clone();
    // Off the setup thread: the plugin answers on Android's main thread, which setup holds.
    std::thread::spawn(move || {
        let last = match app
            .state::<Exits>()
            .0
            .run_mobile_plugin::<LastExit>("lastExit", ())
        {
            Ok(last) => last,
            Err(err) => {
                crate::app_log::warn(format!("could not ask how the last run ended: {err}"));
                return;
            }
        };
        for exit in last.exits {
            crate::app_log::info(format!("an earlier run ended: {exit}"));
        }
        if let Some(crash) = last.crash {
            crate::app_log::error(format!(
                "the last run recorded a panic or exception: {crash}"
            ));
        }
        let resources = Path::new(&last.crash_file).with_file_name("shell-resources.log");
        record_panics(last.crash_file);
        sample_resources(&resources);
    });
}

struct Sample {
    line: String,
    maps: usize,
    fds: usize,
    rss_kb: u64,
}

/// Every second, this process's threads, memory mappings and descriptors by name, the last of
/// them kept in `file` for the next run to log. A sudden jump, and every `RSS_LOGGED_EVERY_KB` of
/// growth, is logged as it happens.
fn sample_resources(file: &Path) -> ! {
    let previous = std::fs::read_to_string(file).unwrap_or_default();
    for line in previous.lines() {
        crate::app_log::info(format!("the previous run: {line}"));
    }
    let partial = file.with_extension("partial");
    let mut samples = VecDeque::with_capacity(SAMPLES_KEPT);
    let mut unwritten = 0;
    let mut last: Option<(usize, usize)> = None;
    let mut logged_rss_kb = 0u64;
    loop {
        let mut climbed = false;
        let line = match resources() {
            Ok(sample) => {
                let jumped = last.is_some_and(|(maps, fds)| {
                    sample.maps > maps + maps / 4 || sample.fds > fds + fds / 4
                });
                if jumped || sample.rss_kb > logged_rss_kb + RSS_LOGGED_EVERY_KB {
                    crate::app_log::warn(format!("this process is climbing: {}", sample.line));
                    logged_rss_kb = sample.rss_kb;
                    climbed = true;
                }
                last = Some((sample.maps, sample.fds));
                format!("{} {}", crate::app_log::now(), sample.line)
            }
            Err(err) => format!(
                "{} could not read this process: {err}",
                crate::app_log::now()
            ),
        };
        if samples.len() == SAMPLES_KEPT {
            samples.pop_front();
        }
        samples.push_back(line);
        unwritten += 1;
        if climbed || unwritten == SAMPLES_PER_WRITE {
            // Renamed into place, so a kill mid-write leaves the last whole file.
            let _ = std::fs::write(&partial, samples.make_contiguous().join("\n"))
                .and_then(|()| std::fs::rename(&partial, file));
            unwritten = 0;
        }
        std::thread::sleep(SAMPLE_EVERY);
    }
}

fn resources() -> std::io::Result<Sample> {
    let status = std::fs::read_to_string("/proc/self/status")?;
    let rss = status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))
        .map_or("?", str::trim);
    let threads: Vec<String> = std::fs::read_dir("/proc/self/task")?
        .filter_map(Result::ok)
        .map(|task| {
            std::fs::read_to_string(task.path().join("comm"))
                .map_or_else(|_| "?".into(), |name| name.trim().to_string())
        })
        .collect();
    let maps = std::fs::read_to_string("/proc/self/maps")?;
    let mapped: Vec<String> = maps
        .lines()
        .map(|line| {
            let name = line
                .split_whitespace()
                .skip(5)
                .collect::<Vec<_>>()
                .join(" ");
            if name.is_empty() {
                "[anon]".into()
            } else {
                name
            }
        })
        .collect();
    let mut dmabuf_bytes = 0u64;
    let mut dmabufs = std::collections::HashSet::new();
    let fds: Vec<String> = std::fs::read_dir("/proc/self/fd")?
        .filter_map(Result::ok)
        .map(|fd| {
            let to = std::fs::read_link(fd.path())
                .map_or_else(|_| "?".into(), |to| to.to_string_lossy().into_owned());
            if to.starts_with("/dmabuf") {
                let info =
                    std::fs::read_to_string(Path::new("/proc/self/fdinfo").join(fd.file_name()))
                        .unwrap_or_default();
                let field = |name: &str| {
                    info.lines()
                        .find_map(|line| line.strip_prefix(name))
                        .and_then(|value| value.trim().parse::<u64>().ok())
                };
                // Several descriptors can hold one buffer.
                if dmabufs.insert(field("ino:")) {
                    dmabuf_bytes += field("size:").unwrap_or(0);
                }
            }
            to
        })
        .collect();
    let rollup = std::fs::read_to_string("/proc/self/smaps_rollup").unwrap_or_default();
    let memory = ["Pss_Anon:", "Pss_File:", "Pss_Shmem:", "Swap:"]
        .iter()
        .filter_map(|name| {
            rollup
                .lines()
                .find_map(|line| line.strip_prefix(name))
                .map(|value| format!("{} {}", name.trim_end_matches(':'), value.trim()))
        })
        .collect::<Vec<_>>()
        .join(", ");
    Ok(Sample {
        line: format!(
            "rss {rss} ({memory}, dmabuf {} kB); {} threads ({}); {} maps ({}); {} fds ({})",
            dmabuf_bytes / 1024,
            threads.len(),
            commonest(&threads),
            mapped.len(),
            commonest(&mapped),
            fds.len(),
            commonest(&fds)
        ),
        rss_kb: rss
            .split_whitespace()
            .next()
            .and_then(|kb| kb.parse().ok())
            .unwrap_or(0),
        maps: mapped.len(),
        fds: fds.len(),
    })
}

/// The most frequent names, counted with their digits masked so numbered siblings group.
fn commonest(names: &[String]) -> String {
    let mut counts = HashMap::<String, usize>::new();
    for name in names {
        let masked: String = name
            .chars()
            .map(|c| if c.is_ascii_digit() { '#' } else { c })
            .collect();
        *counts.entry(masked).or_default() += 1;
    }
    let mut counts: Vec<_> = counts.into_iter().collect();
    counts.sort_by(|a, b| b.1.cmp(&a.1));
    counts
        .iter()
        .take(KINDS_SHOWN)
        .map(|(name, count)| format!("{count} {name}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn record_panics(crash_file: String) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let message = format!(
            "{}: {info}\n{}",
            thread.name().unwrap_or("unnamed thread"),
            std::backtrace::Backtrace::force_capture()
        );
        crate::app_log::error(&message);
        // The first panic is usually the cause, the rest its fallout.
        if let Ok(mut file) = std::fs::File::create_new(&crash_file) {
            let _ = file.write_all(message.as_bytes());
        }
        previous(info);
    }));
}
